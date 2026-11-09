/**
 * Geometry → pixels. Lets an LLM describe forms (limbs as tapered capsules, hair as splines, smears as crescents)
 * with coordinates instead of typing every pixel, then shade them consistently with color ramps.
 *
 * Coordinates are pixel indices: the point (x, y) is the center of pixel (x, y). Fractions are allowed.
 * Angles are degrees clockwise from +x (screen space, y down), matching rig rotations.
 */
import { type RGBA, toHex } from './color.js';
import type { Bitmap } from './sprite.js';
import { getPixel, setPixel } from './draw.js';

export type Vec = [number, number];

export type Shape =
  | { type: 'polygon'; points: Vec[] }
  | { type: 'spline'; points: Vec[]; closed?: boolean; width?: number }
  | { type: 'line'; points: Vec[]; width?: number }
  | { type: 'capsule'; from: Vec; to: Vec; r1: number; r2?: number }
  | { type: 'ellipse'; center: Vec; rx: number; ry: number; angle?: number }
  | { type: 'arc'; center: Vec; radius: number; from: number; to: number; width: number; taper?: boolean };

/** One byte per canvas pixel: 1 = inside. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export function emptyMask(w: number, h: number): Mask {
  return { width: w, height: h, data: new Uint8Array(w * h) };
}

export function maskHas(m: Mask, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[y * m.width + x] === 1;
}

export function maskCount(m: Mask): number {
  let n = 0;
  for (const v of m.data) n += v;
  return n;
}

/** Mask of the opaque pixels of a bitmap, optionally only those matching `colors`. */
export function maskFromBitmap(b: Bitmap, colors?: RGBA[]): Mask {
  const m = emptyMask(b.width, b.height);
  for (let i = 0; i < b.width * b.height; i++) {
    const a = b.data[i * 4 + 3];
    if (!a) continue;
    if (colors && !colors.some((c) => c[0] === b.data[i * 4] && c[1] === b.data[i * 4 + 1] && c[2] === b.data[i * 4 + 2] && c[3] === a)) continue;
    m.data[i] = 1;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Rasterization

/** Catmull-Rom spline through the points. */
export function catmullRom(points: Vec[], closed = false, perSegment = 12): Vec[] {
  if (points.length < 3) return points;
  const n = points.length;
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  const out: Vec[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

function pointInPolygon(x: number, y: number, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(px: number, py: number, a: Vec, b: Vec): { d: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2)) : 0;
  return { d: Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), t };
}

/** 1px lines: Bresenham through rounded points, then remove L-corners ("pixel perfect"). */
function thinPolyline(m: Mask, pts: Vec[]): void {
  const path: Vec[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    let [x0, y0] = [Math.round(pts[i][0]), Math.round(pts[i][1])];
    const [x1, y1] = [Math.round(pts[i + 1][0]), Math.round(pts[i + 1][1])];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const last = path[path.length - 1];
      if (!last || last[0] !== x0 || last[1] !== y0) path.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  const keep = path.filter((p, i) => {
    if (i === 0 || i === path.length - 1) return true;
    const a = path[i - 1];
    const c = path[i + 1];
    // An L-corner: prev and next are diagonal to each other, so p is redundant.
    return !(Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1);
  });
  for (const [x, y] of keep) if (x >= 0 && y >= 0 && x < m.width && y < m.height) m.data[y * m.width + x] = 1;
}

function normDeg(a: number): number {
  return ((a % 360) + 360) % 360;
}

export interface ArcSample {
  /** 0 at the outer edge, 1 at the inner edge of the crescent. */
  depth: number;
  /** 0 at `from`, 1 at `to`. */
  t: number;
}

function arcSample(s: Extract<Shape, { type: 'arc' }>, x: number, y: number): ArcSample | null {
  const dx = x - s.center[0];
  const dy = y - s.center[1];
  const rho = Math.hypot(dx, dy);
  const span = s.to - s.from;
  const ang = normDeg((Math.atan2(dy, dx) * 180) / Math.PI);
  const rel = span >= 0 ? normDeg(ang - s.from) : normDeg(s.from - ang);
  const t = rel / Math.abs(span);
  if (t > 1) return null;
  const w = s.taper === false ? s.width : s.width * Math.pow(Math.sin(Math.PI * t), 0.7);
  if (w <= 0.35) return null;
  const outer = s.radius + 0.5;
  if (rho > outer || rho < outer - w) return null;
  return { depth: (outer - rho) / w, t };
}

/** Rasterizes a shape into a canvas-sized mask. */
export function shapeMask(shape: Shape, width: number, height: number): Mask {
  const m = emptyMask(width, height);
  const set = (test: (x: number, y: number) => boolean, x0 = 0, y0 = 0, x1 = width - 1, y1 = height - 1) => {
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(height - 1, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(width - 1, Math.ceil(x1)); x++) if (test(x, y)) m.data[y * width + x] = 1;
  };
  const bbox = (pts: Vec[], pad: number) => [
    Math.min(...pts.map((p) => p[0])) - pad,
    Math.min(...pts.map((p) => p[1])) - pad,
    Math.max(...pts.map((p) => p[0])) + pad,
    Math.max(...pts.map((p) => p[1])) + pad,
  ] as const;
  const stroke = (pts: Vec[], w: number) => {
    if (w <= 1) return thinPolyline(m, pts);
    const r = w / 2;
    set((x, y) => pts.some((p, i) => i < pts.length - 1 && distToSegment(x, y, p, pts[i + 1]).d <= r), ...bbox(pts, r + 1));
  };
  switch (shape.type) {
    case 'polygon':
      set((x, y) => pointInPolygon(x, y, shape.points), ...bbox(shape.points, 1));
      break;
    case 'spline': {
      const pts = catmullRom(shape.points, !!shape.closed);
      if (shape.closed) set((x, y) => pointInPolygon(x, y, pts), ...bbox(pts, 1));
      else stroke(pts, shape.width ?? 1);
      break;
    }
    case 'line':
      stroke(shape.points, shape.width ?? 1);
      break;
    case 'capsule': {
      const r2 = shape.r2 ?? shape.r1;
      set((x, y) => {
        const { d, t } = distToSegment(x, y, shape.from, shape.to);
        return d <= shape.r1 + (r2 - shape.r1) * t;
      }, ...bbox([shape.from, shape.to], Math.max(shape.r1, r2) + 1));
      break;
    }
    case 'ellipse': {
      const a = ((shape.angle ?? 0) * Math.PI) / 180;
      const [cx, cy] = shape.center;
      const rx = shape.rx + 0.5;
      const ry = shape.ry + 0.5;
      const r = Math.max(rx, ry);
      set((x, y) => {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * Math.cos(a) + dy * Math.sin(a);
        const v = -dx * Math.sin(a) + dy * Math.cos(a);
        return (u * u) / (rx * rx) + (v * v) / (ry * ry) <= 1;
      }, cx - r, cy - r, cx + r, cy + r);
      break;
    }
    case 'arc': {
      const r = shape.radius + 1;
      set((x, y) => arcSample(shape, x, y) !== null, shape.center[0] - r, shape.center[1] - r, shape.center[0] + r, shape.center[1] + r);
      break;
    }
  }
  return m;
}

/** Pixels of the mask that touch a pixel outside it (4-neighborhood): a 1px inner outline. */
export function maskBorder(m: Mask): Mask {
  const out = emptyMask(m.width, m.height);
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (maskHas(m, x, y) && (!maskHas(m, x - 1, y) || !maskHas(m, x + 1, y) || !maskHas(m, x, y - 1) || !maskHas(m, x, y + 1))) out.data[y * m.width + x] = 1;
  return out;
}

export function paintMask(b: Bitmap, m: Mask, c: RGBA): number {
  let n = 0;
  for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x] && setPixel(b, x, y, c)) n++;
  return n;
}

/** Crescent smear: colors run from the outer edge (first) to the inner edge (last). */
export function paintArc(b: Bitmap, shape: Extract<Shape, { type: 'arc' }>, colors: RGBA[]): number {
  let n = 0;
  const r = shape.radius + 1;
  for (let y = Math.max(0, Math.floor(shape.center[1] - r)); y <= Math.min(b.height - 1, Math.ceil(shape.center[1] + r)); y++) {
    for (let x = Math.max(0, Math.floor(shape.center[0] - r)); x <= Math.min(b.width - 1, Math.ceil(shape.center[0] + r)); x++) {
      const s = arcSample(shape, x, y);
      if (!s) continue;
      setPixel(b, x, y, colors[Math.min(colors.length - 1, Math.floor(s.depth * colors.length))]);
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Ramps & shading

// OKLab / OKLCH (perceptual): equal lightness steps look equal, and hue shifts stay clean.
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch([r8, g8, b8]: RGBA): [number, number, number] {
  const [r, g, b] = [toLin(r8 / 255), toLin(g8 / 255), toLin(b8 / 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH → sRGB, reducing chroma until the color fits the gamut. */
function oklchToRgb(L: number, C: number, h: number): RGBA {
  for (let c = C; ; c *= 0.94) {
    const A = c * Math.cos((h * Math.PI) / 180);
    const B = c * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
    if (rgb.every((v) => v >= -0.001 && v <= 1.001) || c < 0.002) {
      const [r, g, b] = rgb.map((v) => Math.round(Math.max(0, Math.min(1, toSrgb(Math.max(0, v)))) * 255));
      return [r, g, b, 255];
    }
  }
}

function towardHue(h: number, target: number, amount: number): number {
  let d = target - h;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  const step = Math.sign(d) * Math.min(Math.abs(d), amount);
  return (h + step + 360) % 360;
}

export interface RampOptions {
  /** Number of shades (default 5). */
  steps?: number;
  /** Max hue rotation at the ends in degrees: shadows toward blue-violet, lights toward warm yellow (default 18). */
  hueShift?: number;
  /** Perceptual lightness (OKLab L) step between neighboring shades (default 0.1). */
  contrast?: number;
}

/** Hue-shifted ramp around `base` (base sits in the middle), darkest first. Built in OKLCH. */
export function generateRamp(base: RGBA, opts: RampOptions = {}): string[] {
  const steps = Math.max(2, opts.steps ?? 5);
  const mid = Math.floor((steps - 1) / 2);
  const [L, C, h] = rgbToOklch(base);
  const step = opts.contrast ?? 0.1;
  const shift = opts.hueShift ?? 18;
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const o = i - mid;
    const frac = Math.abs(o) / Math.max(1, mid, steps - 1 - mid);
    const hue = o < 0 ? towardHue(h, 285, shift * frac) : o > 0 ? towardHue(h, 95, shift * frac) : h;
    const light = Math.max(0.16, Math.min(0.97, L + o * step));
    // Shadows keep their color; highlights lose some chroma so they read as light, not as a new hue.
    const chroma = C * (o < 0 ? 1 - 0.06 * -o : 1 - 0.22 * o);
    out.push(toHex(oklchToRgb(light, Math.max(0, chroma), hue)));
  }
  return out;
}

export interface ShadeOptions {
  /** Ramp colors, darkest first. */
  ramp: RGBA[];
  /** Index of the base (lit-from-nowhere) color in the ramp; default middle. */
  base?: number;
  /** Direction pointing toward the light (default [-1, -1]: light from the top-left). */
  light?: Vec;
  /** Fraction of the form (along the light axis) in shadow (default 0.35). */
  shadow?: number;
  /** Fraction in core/deep shadow, on the far edge (default 0.12). */
  deep?: number;
  /** Fraction lit by the highlight (default 0.18). */
  highlight?: number;
  /** Absolute widths in pixels, overriding the fractions. */
  shadowPx?: number;
  highlightPx?: number;
  /** "cel" (default): bands along the light axis. "form": the shape is treated as a rounded volume lit in 3D. */
  mode?: 'cel' | 'form';
  /** form mode: brighten the silhouette edge on the shadow side one step (reflected light). */
  rim?: boolean;
}

/**
 * Cel-shades the masked pixels. For each pixel it measures how far the form extends toward and away from the light
 * (marching along the light direction), so shadows hug the far side and highlights the near side, following the
 * silhouette. This avoids pillow shading (bands parallel to the outline on every side).
 */
export function shadeMask(b: Bitmap, m: Mask, o: ShadeOptions): number {
  if (o.mode === 'form') return formShade(b, m, o);
  const ramp = o.ramp;
  const base = o.base ?? Math.floor((ramp.length - 1) / 2);
  const [lx0, ly0] = o.light ?? [-1, -1];
  const len = Math.hypot(lx0, ly0) || 1;
  const lx = lx0 / len;
  const ly = ly0 / len;
  const march = (x: number, y: number, dir: number) => {
    for (let k = 1; k < 128; k++) if (!maskHas(m, Math.round(x + dir * lx * k), Math.round(y + dir * ly * k))) return k;
    return 128;
  };
  const pick = (i: number) => ramp[Math.max(0, Math.min(ramp.length - 1, i))];
  let n = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!maskHas(m, x, y)) continue;
      const toLight = march(x, y, 1);
      const away = march(x, y, -1);
      const total = toLight + away - 1;
      let idx = base;
      const inShadow = o.shadowPx !== undefined ? away <= o.shadowPx : away / total <= (o.shadow ?? 0.35);
      const inDeep = base >= 2 && (o.shadowPx !== undefined ? away <= Math.max(1, Math.floor(o.shadowPx / 3)) : away / total <= (o.deep ?? 0.12));
      const inLight = o.highlightPx !== undefined ? toLight <= o.highlightPx : toLight / total <= (o.highlight ?? 0.18);
      if (inDeep) idx = base - 2;
      else if (inShadow) idx = base - 1;
      else if (inLight) idx = base + 1;
      setPixel(b, x, y, pick(idx));
      n++;
    }
  }
  return n;
}

const same = (a: RGBA, b: RGBA) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

/** Finds the shade `delta` steps away from `c` within the ramp that contains it. */
export function rampNeighbor(c: RGBA, ramps: RGBA[][], delta: number): RGBA | null {
  for (const r of ramps) {
    const i = r.findIndex((x) => same(x, c));
    if (i >= 0) return r[Math.max(0, Math.min(r.length - 1, i + delta))];
  }
  return null;
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t), 255];
}

const N4: Vec[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8: Vec[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Selective outline ("sel-out"): outline pixels between two materials become a dark shade of the material they
 * enclose, and silhouette pixels facing the light are softened the same way. Shadow-side silhouette stays dark.
 */
export function selout(b: Bitmap, outline: RGBA, ramps: RGBA[][], light: Vec = [-1, -1]): number {
  const src: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (!same(getPixel(src, x, y), outline)) continue;
      const interior: RGBA[] = [];
      let transparentToLight = false;
      let transparentAway = false;
      for (const [dx, dy] of N4) {
        const c = getPixel(src, x + dx, y + dy);
        if (c[3] === 0) {
          const facing = dx * light[0] + dy * light[1];
          if (facing > 0) transparentToLight = true;
          else transparentAway = true;
        } else if (!same(c, outline)) interior.push(c);
      }
      if (!interior.length || transparentAway) continue;
      // Majority interior color.
      const counts = new Map<string, { c: RGBA; n: number }>();
      for (const c of interior) {
        const k = c.join(',');
        counts.set(k, { c, n: (counts.get(k)?.n ?? 0) + 1 });
      }
      const major = [...counts.values()].sort((a, b2) => b2.n - a.n)[0].c;
      // Lit silhouette: the material's darkest shade (still reads as an edge). Inner lines: two shades darker.
      const darker = rampNeighbor(major, ramps, transparentToLight ? -99 : -2) ?? mix(major, outline, 0.6);
      if (same(darker, major)) continue;
      setPixel(b, x, y, darker);
      n++;
    }
  }
  return n;
}

/** L-corners in 1px lines of `color`: pixels whose two same-colored neighbors are perpendicular and diagonal-adjacent. */
export function findJaggies(b: Bitmap, color: RGBA): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (!same(getPixel(b, x, y), color)) continue;
      const nb = N8.filter(([dx, dy]) => same(getPixel(b, x + dx, y + dy), color));
      if (nb.length !== 2) continue;
      const [a, c] = nb;
      const ortho = (v: Vec) => v[0] === 0 || v[1] === 0;
      if (ortho(a) && ortho(c) && a[0] !== c[0] && a[1] !== c[1]) out.push([x, y]);
    }
  }
  return out;
}

/** Opaque pixels with no same-colored neighbor (8-neighborhood). */
export function findOrphans(b: Bitmap): Vec[] {
  const out: Vec[] = [];
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const c = getPixel(b, x, y);
      if (!c[3]) continue;
      if (!N8.some(([dx, dy]) => same(getPixel(b, x + dx, y + dy), c))) out.push([x, y]);
    }
  }
  return out;
}

/** Most common color among the 8 neighbors (transparent included). */
function majorityNeighbor(b: Bitmap, x: number, y: number, exclude: RGBA): RGBA {
  const counts = new Map<string, { c: RGBA; n: number }>();
  for (const [dx, dy] of N8) {
    const c = getPixel(b, x + dx, y + dy);
    if (same(c, exclude)) continue;
    const k = c.join(',');
    counts.set(k, { c, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, c) => c.n - a.n)[0]?.c ?? [0, 0, 0, 0];
}

export function fixPixels(b: Bitmap, pts: Vec[]): number {
  const src: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
  for (const [x, y] of pts) setPixel(b, x, y, majorityNeighbor(src, x, y, getPixel(src, x, y)));
  return pts.length;
}

export function luminance(c: RGBA): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

/** Darkest opaque color in the bitmap (usually the outline). */
export function darkestColor(b: Bitmap): RGBA | null {
  let best: RGBA | null = null;
  for (let i = 0; i < b.width * b.height; i++) {
    if (b.data[i * 4 + 3] < 255) continue;
    const c: RGBA = [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2], 255];
    if (!best || luminance(c) < luminance(best)) best = c;
  }
  return best;
}

export interface LintReport {
  colors: number;
  nearDuplicates: [string, string][];
  /** Isolated pixels close in color to their surroundings: noise worth cleaning. */
  orphans: Vec[];
  /** Isolated high-contrast pixels (eye glints, sparkles): usually deliberate. */
  accents: Vec[];
  jaggies: Vec[];
  unoutlined: Vec[];
  silhouette: number;
  doubles: Vec[];
  lowContrast: [string, string, number][];
}

/** Objective pixel-art checks with coordinates, so problems can be fixed precisely. */
export function lintBitmap(b: Bitmap, outline?: RGBA | null): LintReport {
  const hist = new Map<string, RGBA>();
  for (let i = 0; i < b.width * b.height; i++) {
    if (!b.data[i * 4 + 3]) continue;
    const c: RGBA = [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2], b.data[i * 4 + 3]];
    hist.set(c.join(','), c);
  }
  const cols = [...hist.values()];
  const nearDuplicates: [string, string][] = [];
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++) {
      const [a, c] = [cols[i], cols[j]];
      const d = Math.hypot((a[0] - c[0]) * 0.3, (a[1] - c[1]) * 0.59, (a[2] - c[2]) * 0.11);
      if (d < 6 && a[3] === c[3]) nearDuplicates.push([toHex(a), toHex(c)]);
    }
  const line = outline ?? darkestColor(b);
  const unoutlined: Vec[] = [];
  const doubles: Vec[] = [];
  let silhouette = 0;
  const pairs = new Map<string, [string, string, number]>();
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const c = getPixel(b, x, y);
      if (!c[3]) continue;
      const edge = N4.some(([dx, dy]) => getPixel(b, x + dx, y + dy)[3] === 0);
      if (edge && c[3] === 255) {
        silhouette++;
        if (line && luminance(c) - luminance(line) > 0.25) unoutlined.push([x, y]);
      }
      if (line && same(c, line) && same(getPixel(b, x + 1, y), line) && same(getPixel(b, x, y + 1), line) && same(getPixel(b, x + 1, y + 1), line)) {
        // Only a doubled *outline*: the block sits on the silhouette edge. Dark interior masses (shadows, dark
        // clothing in painterly or pixelized art) are fills, not outline mistakes.
        const block: Vec[] = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
        const onEdge = block.filter(([bx, by]) => N4.some(([dx, dy]) => getPixel(b, bx + dx, by + dy)[3] === 0)).length;
        if (onEdge >= 2) doubles.push([x, y]);
      }
      for (const [dx, dy] of [[1, 0], [0, 1]] as Vec[]) {
        const o = getPixel(b, x + dx, y + dy);
        if (!o[3] || same(o, c)) continue;
        const diff = Math.abs(luminance(o) - luminance(c));
        if (diff < 0.035) {
          const k = [toHex(c), toHex(o)].sort().join('|');
          const prev = pairs.get(k);
          pairs.set(k, [toHex(c), toHex(o), (prev?.[2] ?? 0) + 1]);
        }
      }
    }
  }
  return {
    colors: cols.length,
    nearDuplicates,
    ...splitOrphans(b),
    jaggies: line ? findJaggies(b, line) : [],
    unoutlined,
    silhouette,
    doubles,
    lowContrast: [...pairs.values()].sort((a, c) => c[2] - a[2]),
  };
}

/** The lint report as text, shared by the MCP tool and the editor. */
export function formatLintReport(r: LintReport): string {
  const pts = (v: Vec[], max = 24) => (v.length ? v.slice(0, max).map(([x, y]) => `(${x},${y})`).join(' ') + (v.length > max ? ` …+${v.length - max}` : '') : 'none');
  const pct = r.silhouette ? Math.round((r.unoutlined.length / r.silhouette) * 100) : 0;
  return [
      `Colors: ${r.colors}${r.nearDuplicates.length ? `; near-duplicates (merge them): ${r.nearDuplicates.map((p) => p.join('≈')).join(', ')}` : ''}`,
      `Noise pixels — isolated and close in color to their surroundings (${r.orphans.length}): ${pts(r.orphans)}`,
      `Accent pixels — isolated, high contrast (eye glints, sparkles; usually deliberate, leave them): ${r.accents.length}`,
      `Outline jaggies / L-corners (${r.jaggies.length}): ${pts(r.jaggies)}`,
      `Outline 2x2 doubles (${r.doubles.length}): ${pts(r.doubles)}`,
      `Style note — silhouette pixels lighter than the outline color: ${r.unoutlined.length}/${r.silhouette} (${pct}%)${pct > 0 ? `: ${pts(r.unoutlined, 12)}. Normal for colored/selective outlines and pixelized or painterly art; only change them if this sprite should have a closed dark outline.` : ''}`,
      `Low-contrast neighbors (colors too close to read): ${r.lowContrast.length ? r.lowContrast.slice(0, 8).map(([c1, c2, n]) => `${c1}/${c2}×${n}`).join(', ') : 'none'}`,
  ].join('\n');
}

/** Area-average downscale (for references). */
export function downscale(src: Bitmap, w: number, h: number): Bitmap {
  const out: Bitmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  const fx = src.width / w;
  const fy = src.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * fy); sy < Math.max(Math.floor(y * fy) + 1, Math.floor((y + 1) * fy)); sy++)
        for (let sx = Math.floor(x * fx); sx < Math.max(Math.floor(x * fx) + 1, Math.floor((x + 1) * fx)); sx++) {
          const c = getPixel(src, sx, sy);
          r += c[0] * c[3]; g += c[1] * c[3]; bl += c[2] * c[3]; a += c[3]; n++;
        }
      if (a) setPixel(out, x, y, [Math.round(r / a), Math.round(g / a), Math.round(bl / a), Math.round(a / n)]);
    }
  }
  return out;
}

/** k-means palette of the opaque pixels (deterministic init along luminance). */
export function extractPalette(b: Bitmap, k: number): string[] {
  const px: RGBA[] = [];
  for (let i = 0; i < b.width * b.height; i++) if (b.data[i * 4 + 3] > 128) px.push([b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2], 255]);
  if (!px.length) return [];
  const sorted = [...px].sort((a, c) => luminance(a) - luminance(c));
  let centers: number[][] = Array.from({ length: Math.min(k, px.length) }, (_, i) => [...sorted[Math.floor(((i + 0.5) / k) * sorted.length)]]);
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2]; sums[best][3]++;
    }
    centers = centers.map((c, i) => (sums[i][3] ? [sums[i][0] / sums[i][3], sums[i][1] / sums[i][3], sums[i][2] / sums[i][3]] : c));
  }
  return [...new Set(centers.map((c) => toHex([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255])))].sort(
    (a, c) => luminance(hexRgb(a)) - luminance(hexRgb(c)),
  );
}

function hexRgb(h: string): RGBA {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
}

// ---------------------------------------------------------------------------
// References: background removal and silhouette comparison

/**
 * Makes the background of a picture transparent: flood-fills from the image border through pixels whose color is
 * close to one of the border colors. Stops at the figure's outline, so interior dark pixels are kept.
 */
export function removeBackground(src: Bitmap, tolerance = 8, minSpeck = 6): Bitmap {
  const out: Bitmap = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  const W = src.width;
  const H = src.height;
  const border: RGBA[] = [];
  const seen = new Set<string>();
  const addBorder = (x: number, y: number) => {
    const c = getPixel(src, x, y);
    const k = c.slice(0, 3).map((v) => v >> 3).join(',');
    if (!seen.has(k) && border.length < 96) {
      seen.add(k);
      border.push(c);
    }
  };
  for (let x = 0; x < W; x++) { addBorder(x, 0); addBorder(x, H - 1); }
  for (let y = 0; y < H; y++) { addBorder(0, y); addBorder(W - 1, y); }
  // Grid / checkerboard backgrounds are usually neutral grays (fill + lines of other grays). When the border is all
  // neutral, any neutral gray inside the border's lightness range counts as background, while a figure's dark
  // outline (almost always tinted: brown, purple, navy) does not.
  const spread = (c: RGBA | number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const lum = (c: RGBA | number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const neutralBorder = border.length > 0 && border.every((c) => c[3] < 16 || spread(c) <= 6);
  const opaqueBorder = border.filter((c) => c[3] >= 16);
  const minL = Math.min(...opaqueBorder.map(lum));
  const maxL = Math.max(...opaqueBorder.map(lum));
  const isBg = (x: number, y: number) => {
    const c = getPixel(src, x, y);
    if (c[3] < 16) return true;
    if (border.some((b) => Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]) <= tolerance)) return true;
    return neutralBorder && spread(c) <= 4 && lum(c) >= minL - 6 && lum(c) <= maxL + 6;
  };
  const visited = new Uint8Array(W * H);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = y * W + x;
    if (visited[i]) return;
    visited[i] = 1;
    if (isBg(x, y)) stack.push(i);
  };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    out.data[i * 4 + 3] = 0;
    const x = i % W;
    const y = (i - x) / W;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  // Outline repair: a dark pixel that was removed but touches the figure is part of its outline (a grid line
  // crossing the edge would otherwise punch holes in it).
  const mainL = opaqueBorder.length ? lum(opaqueBorder[0]) : 0;
  const removed: number[] = [];
  for (let i = 0; i < W * H; i++) if (!out.data[i * 4 + 3] && src.data[i * 4 + 3] >= 16 && lum(src.data.subarray(i * 4, i * 4 + 3) as unknown as number[]) < mainL - 8) removed.push(i);
  for (const i of removed) {
    const x = i % W;
    const y = (i - x) / W;
    const touchesFigure = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
      const j = ny * W + nx;
      return out.data[j * 4 + 3] > 0 && lum(out.data.subarray(j * 4, j * 4 + 3) as unknown as number[]) >= mainL + 10;
    });
    if (touchesFigure) out.data[i * 4 + 3] = src.data[i * 4 + 3];
  }
  // Drop leftover specks (bits of grid lines / noise) that are not attached to the figure.
  const label = new Int32Array(W * H).fill(-1);
  for (let start = 0; start < W * H; start++) {
    if (label[start] >= 0 || !out.data[start * 4 + 3]) continue;
    const comp: number[] = [start];
    label[start] = start;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      const x = i % W;
      const y = (i - x) / W;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (label[j] >= 0 || !out.data[j * 4 + 3]) continue;
          label[j] = start;
          comp.push(j);
        }
    }
    if (comp.length < minSpeck) for (const i of comp) out.data[i * 4 + 3] = 0;
  }
  return out;
}

export interface Band {
  y0: number;
  y1: number;
  ref: [number, number] | null;
  art: [number, number] | null;
}

/** A connected group of pixels that differ (missing from the art, or extra in it). */
export interface DiffRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
  /** Mostly partially covered reference pixels: a thin feature (hair spike, strap, blade tip). */
  thin: boolean;
}

/** A block where the art's color differs from the reference's. */
export interface ColorDiff {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  ref: string;
  art: string;
  /** OKLab distance. */
  delta: number;
  /** Plain words: "lighter", "more saturated", "redder"... */
  notes: string[];
}

export interface SilhouetteDiff {
  iou: number;
  overlap: number;
  missing: number;
  extra: number;
  /** Missing pixels that are only partly covered in the reference (thin details). */
  thinMissing: number;
  ref: { top: number; bottom: number; left: number; right: number; cx: number; cy: number } | null;
  art: { top: number; bottom: number; left: number; right: number; cx: number; cy: number } | null;
  bands: Band[];
  missingRegions: DiffRegion[];
  extraRegions: DiffRegion[];
  colors: ColorDiff[];
  /** Canvas-sized visualization: gray = both, green = missing, light green = missing thin detail, magenta = extra. */
  image: Bitmap;
}

export interface SilhouetteOptions {
  /** Rows per band in the edge table (default 4). */
  band?: number;
  /** Per-pixel reference coverage 0..1 (from the high-resolution source). Default: reference alpha. */
  coverage?: Float32Array;
  /** A reference pixel belongs to the silhouette from this coverage up (default 0.25, keeps thin spikes). */
  threshold?: number;
  /** Block size for the color comparison (default 6, 0 = off). */
  colorBlock?: number;
}

function regions(flags: Uint8Array, W: number, H: number, cov: Float32Array | null): DiffRegion[] {
  const seen = new Uint8Array(W * H);
  const out: DiffRegion[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!flags[start] || seen[start]) continue;
    const comp = [start];
    seen[start] = 1;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, thinCount = 0;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      const x = i % W;
      const y = (i - x) / W;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      if (cov && cov[i] < 0.5) thinCount++;
      for (const [dx, dy] of N8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (flags[j] && !seen[j]) { seen[j] = 1; comp.push(j); }
      }
    }
    if (comp.length >= 2) out.push({ x0, y0, x1, y1, pixels: comp.length, thin: !!cov && thinCount / comp.length >= 0.5 });
  }
  return out.sort((a, b) => b.pixels - a.pixels);
}

function oklab(c: RGBA): [number, number, number] {
  const [L, C, h] = rgbToOklch(c);
  return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
}

/** Compares average colors of the reference and the art block by block, where both have pixels. */
export function colorDiffs(ref: Bitmap, art: Bitmap, refMask: Mask, artMask: Mask, block = 6, minDelta = 0.06): ColorDiff[] {
  const out: ColorDiff[] = [];
  for (let by = 0; by < ref.height; by += block)
    for (let bx = 0; bx < ref.width; bx += block) {
      const sum = { r: [0, 0, 0], a: [0, 0, 0], n: 0 };
      for (let y = by; y < Math.min(ref.height, by + block); y++)
        for (let x = bx; x < Math.min(ref.width, bx + block); x++) {
          const i = y * ref.width + x;
          if (!refMask.data[i] || !artMask.data[i] || ref.data[i * 4 + 3] < 128) continue;
          // Skip the art's outline: it has no counterpart in a downscaled reference.
          const a = getPixel(art, x, y);
          if (luminance(a) < 0.08) continue;
          const r = getPixel(ref, x, y);
          for (let k = 0; k < 3; k++) { sum.r[k] += r[k]; sum.a[k] += a[k]; }
          sum.n++;
        }
      if (sum.n < Math.max(4, (block * block) / 4)) continue;
      const rc: RGBA = [Math.round(sum.r[0] / sum.n), Math.round(sum.r[1] / sum.n), Math.round(sum.r[2] / sum.n), 255];
      const ac: RGBA = [Math.round(sum.a[0] / sum.n), Math.round(sum.a[1] / sum.n), Math.round(sum.a[2] / sum.n), 255];
      const [L1, A1, B1] = oklab(rc);
      const [L2, A2, B2] = oklab(ac);
      const delta = Math.hypot(L1 - L2, A1 - A2, B1 - B2);
      if (delta < minDelta) continue;
      const notes: string[] = [];
      if (L2 - L1 > 0.04) notes.push('lighter');
      if (L1 - L2 > 0.04) notes.push('darker');
      const C1 = Math.hypot(A1, B1);
      const C2 = Math.hypot(A2, B2);
      if (C2 - C1 > 0.03) notes.push('more saturated');
      if (C1 - C2 > 0.03) notes.push('less saturated');
      if (C1 > 0.03 && C2 > 0.03) {
        let dh = (Math.atan2(B2, A2) - Math.atan2(B1, A1)) * (180 / Math.PI);
        if (dh > 180) dh -= 360;
        if (dh < -180) dh += 360;
        if (Math.abs(dh) > 12) notes.push(`hue ${dh > 0 ? '+' : ''}${Math.round(dh)}° (${dh > 0 ? 'toward yellow/green' : 'toward red/magenta'})`);
      }
      out.push({ x0: bx, y0: by, x1: Math.min(ref.width, bx + block) - 1, y1: Math.min(ref.height, by + block) - 1, ref: toHex(rc), art: toHex(ac), delta: Math.round(delta * 100) / 100, notes });
    }
  return out.sort((a, b) => b.delta - a.delta);
}

function stats(m: Mask) {
  let top = Infinity, bottom = -1, left = Infinity, right = -1, sx = 0, sy = 0, n = 0;
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++)
      if (m.data[y * m.width + x]) {
        top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
        sx += x; sy += y; n++;
      }
  return n ? { top, bottom, left, right, cx: Math.round((sx / n) * 10) / 10, cy: Math.round((sy / n) * 10) / 10 } : null;
}

export function alphaMask(b: Bitmap, threshold = 128): Mask {
  const m = emptyMask(b.width, b.height);
  for (let i = 0; i < b.width * b.height; i++) if (b.data[i * 4 + 3] >= threshold) m.data[i] = 1;
  return m;
}

/** Compares the reference silhouette with the art silhouette: overlap, regions to add or trim, edges band by band, colors. */
export function silhouetteDiff(ref: Bitmap, art: Bitmap, opts: SilhouetteOptions | number = {}): SilhouetteDiff {
  const o: SilhouetteOptions = typeof opts === 'number' ? { band: opts } : opts;
  const band = o.band ?? 4;
  const threshold = o.threshold ?? 0.25;
  const W = ref.width;
  const H = ref.height;
  const cov = o.coverage ?? Float32Array.from({ length: W * H }, (_, i) => ref.data[i * 4 + 3] / 255);
  const rm = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) if (cov[i] >= threshold) rm.data[i] = 1;
  const am = alphaMask(art);
  const image: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const miss = new Uint8Array(W * H);
  const ext = new Uint8Array(W * H);
  let overlap = 0, missing = 0, extra = 0, thinMissing = 0;
  for (let i = 0; i < W * H; i++) {
    const r = rm.data[i];
    const a = am.data[i];
    if (r && a) { overlap++; image.data.set([150, 156, 172, 255], i * 4); }
    else if (r) {
      missing++;
      miss[i] = 1;
      const thin = cov[i] < 0.5;
      if (thin) thinMissing++;
      image.data.set(thin ? [150, 240, 190, 255] : [40, 210, 110, 255], i * 4);
    } else if (a) { extra++; ext[i] = 1; image.data.set([255, 64, 192, 255], i * 4); }
  }
  const bands: Band[] = [];
  for (let y0 = 0; y0 < H; y0 += band) {
    const y1 = Math.min(H - 1, y0 + band - 1);
    const span = (m: Mask): [number, number] | null => {
      let l = Infinity, r = -1;
      for (let y = y0; y <= y1; y++) for (let x = 0; x < W; x++) if (m.data[y * W + x]) { l = Math.min(l, x); r = Math.max(r, x); }
      return r < 0 ? null : [l, r];
    };
    const b = { y0, y1, ref: span(rm), art: span(am) };
    if (b.ref || b.art) bands.push(b);
  }
  const union = overlap + missing + extra;
  return {
    iou: union ? overlap / union : 1,
    overlap,
    missing,
    extra,
    thinMissing,
    ref: stats(rm),
    art: stats(am),
    bands,
    missingRegions: regions(miss, W, H, cov),
    extraRegions: regions(ext, W, H, null),
    colors: o.colorBlock === 0 ? [] : colorDiffs(ref, art, rm, am, o.colorBlock ?? 6),
    image,
  };
}

// ---------------------------------------------------------------------------
// Values: the light/dark structure that makes a sprite read (and that flat, mid-value art lacks).

export interface ValueStats {
  /** OKLab lightness percentiles of the opaque pixels. */
  p10: number;
  p50: number;
  p90: number;
  /** Share of pixels that are dark (L < 0.35), mid, light (L > 0.7). */
  dark: number;
  mid: number;
  light: number;
  /** Mean OKLab chroma (saturation). */
  chroma: number;
}

export function valueStats(b: Bitmap, mask?: Mask): ValueStats | null {
  const Ls: number[] = [];
  let chroma = 0;
  for (let i = 0; i < b.width * b.height; i++) {
    if (b.data[i * 4 + 3] < 128 || (mask && !mask.data[i])) continue;
    const [L, C] = rgbToOklch([b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2], 255]);
    Ls.push(L);
    chroma += C;
  }
  if (!Ls.length) return null;
  Ls.sort((a, c) => a - c);
  const pct = (p: number) => Math.round(Ls[Math.min(Ls.length - 1, Math.floor(p * Ls.length))] * 100) / 100;
  const share = (f: (L: number) => boolean) => Math.round((Ls.filter(f).length / Ls.length) * 100) / 100;
  return {
    p10: pct(0.1),
    p50: pct(0.5),
    p90: pct(0.9),
    dark: share((L) => L < 0.35),
    mid: share((L) => L >= 0.35 && L <= 0.7),
    light: share((L) => L > 0.7),
    chroma: Math.round((chroma / Ls.length) * 1000) / 1000,
  };
}

/** Plain-language advice comparing the art's values with the reference's. */
export function valueAdvice(ref: ValueStats, art: ValueStats): string[] {
  const out: string[] = [];
  if (art.p10 - ref.p10 > 0.06) out.push(`darkest tones too light (${art.p10} vs ${ref.p10}): deepen core shadows and use darker shadow shades`);
  if (ref.p10 - art.p10 > 0.06) out.push(`darkest tones darker than the reference (${art.p10} vs ${ref.p10})`);
  if (art.p50 - ref.p50 > 0.06) out.push(`overall too light (median ${art.p50} vs ${ref.p50}): shift base colors one shade darker`);
  if (ref.p50 - art.p50 > 0.06) out.push(`overall too dark (median ${art.p50} vs ${ref.p50})`);
  if (ref.p90 - art.p90 > 0.06) out.push(`highlights too dim (${art.p90} vs ${ref.p90}): add brighter highlight pixels on lit edges`);
  if (art.p90 - ref.p90 > 0.06) out.push(`highlights brighter than the reference (${art.p90} vs ${ref.p90})`);
  const cr = ref.p90 - ref.p10;
  const ca = art.p90 - art.p10;
  if (cr - ca > 0.08) out.push(`low value contrast (range ${ca.toFixed(2)} vs ${cr.toFixed(2)}): spread shadows and lights further apart`);
  if (art.dark + 0.1 < ref.dark) out.push(`too few dark pixels (${Math.round(art.dark * 100)}% vs ${Math.round(ref.dark * 100)}%): bigger shadow shapes`);
  if (art.mid - 0.15 > ref.mid) out.push(`too much mid-value area (${Math.round(art.mid * 100)}% vs ${Math.round(ref.mid * 100)}%): the art reads flat`);
  if (art.chroma > ref.chroma * 1.3) out.push(`more saturated than the reference (chroma ${art.chroma} vs ${ref.chroma}): desaturate base colors`);
  if (art.chroma < ref.chroma * 0.7) out.push(`less saturated than the reference (chroma ${art.chroma} vs ${ref.chroma})`);
  return out;
}

// ---------------------------------------------------------------------------
// Volume shading, cast shadows, anti-aliasing

/** Distance (in px) from each mask pixel to the nearest pixel outside the mask (two-pass chamfer). */
export function distanceInside(m: Mask): Float32Array {
  const W = m.width;
  const H = m.height;
  const d = new Float32Array(W * H);
  const INF = 1e6;
  for (let i = 0; i < W * H; i++) d[i] = m.data[i] ? INF : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.414, at(x + 1, y - 1) + 1.414);
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.414, at(x - 1, y + 1) + 1.414);
    }
  return d;
}

/**
 * Shades a mask as a rounded volume: a height field is built from the distance to the silhouette (a dome across
 * the shape, so capsules become cylinders and ellipses become spheres), normals come from its slope, and a 3D light
 * from the given screen direction (raised toward the viewer) picks the ramp shade. Shadows wrap around the form
 * instead of following straight bands.
 */
export function formShade(b: Bitmap, m: Mask, o: ShadeOptions): number {
  const W = m.width;
  const H = m.height;
  const ramp = o.ramp;
  const base = o.base ?? Math.floor((ramp.length - 1) / 2);
  const d = distanceInside(m);
  let R = 0;
  for (const v of d) R = Math.max(R, v);
  if (!R) return 0;
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) if (d[i]) { const t = Math.min(1, d[i] / R); h[i] = Math.sqrt(1 - (1 - t) * (1 - t)); }
  const hat = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : h[y * W + x]);
  const [lx0, ly0] = o.light ?? [-1, -1];
  const l2 = Math.hypot(lx0, ly0) || 1;
  const L = [(lx0 / l2) * 0.75, (ly0 / l2) * 0.75, 0.66];
  const Ln = Math.hypot(L[0], L[1], L[2]);
  const [Lx, Ly, Lz] = [L[0] / Ln, L[1] / Ln, L[2] / Ln];
  const step = 0.2;
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m.data[y * W + x]) continue;
      const gx = (hat(x + 1, y) - hat(x - 1, y)) / 2;
      const gy = (hat(x, y + 1) - hat(x, y - 1)) / 2;
      const S = R * 0.9;
      const nx = -gx * S;
      const ny = -gy * S;
      const nl = Math.hypot(nx, ny, 1);
      const I = (nx * Lx + ny * Ly + Lz) / nl;
      let idx = base + Math.round((I - Lz) / step);
      if (o.rim && d[y * W + x] <= 1.5 && (nx * Lx + ny * Ly) / nl < -0.25) idx = Math.max(idx, base - 1);
      setPixel(b, x, y, ramp[Math.max(0, Math.min(ramp.length - 1, idx))]);
      n++;
    }
  }
  return n;
}

/**
 * Darkens existing pixels around a shape on the side away from the light, as if the shape cast a shadow on what is
 * beneath it (hair on the face, a head on the neck, an arm on the torso). Uses the ramps to pick a darker shade.
 */
export function castShadow(b: Bitmap, m: Mask, ramps: RGBA[][], light: Vec = [-1, -1], px = 2): number {
  const len = Math.hypot(light[0], light[1]) || 1;
  const lx = light[0] / len;
  const ly = light[1] / len;
  const src: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (maskHas(m, x, y)) continue;
      const c = getPixel(src, x, y);
      if (c[3] < 255) continue;
      let hit = false;
      for (let k = 1; k <= px && !hit; k++) hit = maskHas(m, Math.round(x + lx * k), Math.round(y + ly * k));
      if (!hit) continue;
      const darker = rampNeighbor(c, ramps, -1) ?? mix(c, [0, 0, 0, 255], 0.3);
      if (same(darker, c)) continue;
      setPixel(b, x, y, darker);
      n++;
    }
  }
  return n;
}

/** The same shape at k-times resolution (pixel centers map to sub-pixel centers). */
function scaleShape(sh: Shape, k: number): Shape {
  const p = (v: Vec): Vec => [v[0] * k + (k - 1) / 2, v[1] * k + (k - 1) / 2];
  switch (sh.type) {
    case 'polygon': return { ...sh, points: sh.points.map(p) };
    case 'spline': return { ...sh, points: sh.points.map(p), width: sh.width !== undefined ? sh.width * k : sh.closed ? undefined : k };
    case 'line': return { ...sh, points: sh.points.map(p), width: (sh.width ?? 1) * k };
    case 'capsule': return { ...sh, from: p(sh.from), to: p(sh.to), r1: sh.r1 * k, r2: sh.r2 !== undefined ? sh.r2 * k : undefined };
    case 'ellipse': return { ...sh, center: p(sh.center), rx: (sh.rx + 0.5) * k - 0.5, ry: (sh.ry + 0.5) * k - 0.5 };
    case 'arc': return { ...sh, center: p(sh.center), radius: (sh.radius + 0.5) * k - 0.5, width: sh.width * k };
  }
}

/** Fraction (0..1) of each canvas pixel covered by the shape, from 4x4 supersampling. */
export function shapeCoverage(sh: Shape, width: number, height: number, ss = 4): Float32Array {
  const hi = shapeMask(scaleShape(sh, ss), width * ss, height * ss);
  const cov = new Float32Array(width * height);
  for (let y = 0; y < height * ss; y++)
    for (let x = 0; x < width * ss; x++) if (hi.data[y * width * ss + x]) cov[Math.floor(y / ss) * width + Math.floor(x / ss)] += 1 / (ss * ss);
  return cov;
}

/**
 * Anti-aliases a freshly painted shape against what lies under it: pixels just outside the shape that it partly
 * covers get an in-between color, snapped to the nearest palette color so no off-palette colors appear.
 */
export function antialiasEdge(b: Bitmap, before: Bitmap, m: Mask, cov: Float32Array, palette: RGBA[], min = 0.2): number {
  if (!palette.length) return 0;
  const labs = palette.map((c) => rgbToOklch(c)).map(([L, C, h]) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)]);
  const nearest = (c: RGBA) => {
    const [L, C, h] = rgbToOklch(c);
    const v = [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
    let best = 0;
    let bd = Infinity;
    labs.forEach((p, i) => {
      const dd = (p[0] - v[0]) ** 2 + (p[1] - v[1]) ** 2 + (p[2] - v[2]) ** 2;
      if (dd < bd) { bd = dd; best = i; }
    });
    return palette[best];
  };
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const i = y * b.width + x;
      if (m.data[i] || cov[i] < min) continue;
      const under = getPixel(before, x, y);
      if (under[3] < 255) continue;
      const inside = N4.map(([dx, dy]) => [x + dx, y + dy]).find(([nx, ny]) => maskHas(m, nx, ny));
      if (!inside) continue;
      const shapeColor = getPixel(b, inside[0], inside[1]);
      const blended = mix(under, shapeColor, Math.min(0.6, cov[i] + 0.1));
      const snapped = nearest(blended);
      if (same(snapped, under)) continue;
      setPixel(b, x, y, snapped);
      n++;
    }
  }
  return n;
}

/** Pixels covered at least `threshold` (default half). */
export function maskFromCoverage(cov: Float32Array, width: number, height: number, threshold = 0.5): Mask {
  const m = emptyMask(width, height);
  for (let i = 0; i < width * height; i++) if (cov[i] >= threshold) m.data[i] = 1;
  return m;
}

/** Splits isolated pixels into noise (close to the surrounding color) and accents (high contrast, deliberate). */
export function splitOrphans(b: Bitmap, maxDelta = 0.12): { orphans: Vec[]; accents: Vec[] } {
  const lab = (c: RGBA) => {
    const [L, C, h] = rgbToOklch(c);
    return [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
  };
  const orphans: Vec[] = [];
  const accents: Vec[] = [];
  for (const [x, y] of findOrphans(b)) {
    const c = getPixel(b, x, y);
    const major = majorityNeighbor(b, x, y, c);
    if (major[3] === 0) { accents.push([x, y]); continue; }
    const [a1, a2, a3] = lab(c);
    const [b1, b2, b3] = lab(major);
    if (Math.hypot(a1 - b1, a2 - b2, a3 - b3) <= maxDelta) orphans.push([x, y]);
    else accents.push([x, y]);
  }
  return { orphans, accents };
}

/** Isolated pixels that are just noise (see splitOrphans). */
export function findNoisePixels(b: Bitmap): Vec[] {
  return splitOrphans(b).orphans;
}
