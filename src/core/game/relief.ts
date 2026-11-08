/**
 * Per-pixel lighting for pixel art. Every sprite gets a normal map computed from its own pixels, so lights and the sun
 * shape its volumes instead of only tinting it. One function shades a frame for every renderer (browser, editor,
 * headless previews), so what the tools show is what the game draws. Pure and browser-safe.
 *
 * Normal sheets have the size of the spritesheet. R and G hold the x and y of the normal (z is derived),
 * B is how much the pixel glows by itself (0 = not at all), A is 255 on the sprite and 0 elsewhere.
 */

import type { ScreenLight } from './atmosphere.js';
import type { SceneRelief, SpriteAsset, SpriteReliefSettings } from './types.js';

type RGB = [number, number, number];
export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length < 6) return null;
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SQRT2 = Math.SQRT2;
/** Steepness of the volumes at depth 1. */
const SHAPE_DEPTH = 1.5;

/** Distance of every pixel from the nearest pixel not in `inside` (the frame border counts as outside). */
function distanceField(inside: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  const far = w + h;
  for (let i = 0; i < d.length; i++) d[i] = inside[i] ? far : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + SQRT2, at(x + 1, y - 1) + SQRT2);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + SQRT2, at(x - 1, y + 1) + SQRT2);
    }
  }
  return d;
}

/** Quarter-circle profile: rises quickly from the edge and flattens at `cap`. */
const dome = (d: number, cap: number) => {
  if (cap <= 0) return 0;
  const t = 1 - Math.min(d, cap) / cap;
  return Math.sqrt(Math.max(0, 1 - t * t)) * cap;
};

function normalFrame(src: Uint8ClampedArray, W: number, out: Uint8ClampedArray, f: FrameRect, depth: number, glow: Set<number>): void {
  const { x: fx, y: fy, w, h } = f;
  if (w <= 0 || h <= 0) return;
  const n = w * h;
  const lum = new Float32Array(n);
  const solid = new Uint8Array(n);
  let darkest = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((fy + y) * W + fx + x) * 4;
      if (src[si + 3] < 128) continue;
      const i = y * w + x;
      solid[i] = 1;
      lum[i] = (0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2]) / 255;
      darkest = Math.min(darkest, lum[i]);
    }
  }
  // Outlines separate the shapes drawn inside the figure: each enclosed area (a sleeve, the face) bulges on its own.
  const lineLimit = Math.min(0.24, darkest + 0.1);
  const open = new Uint8Array(n);
  for (let i = 0; i < n; i++) open[i] = solid[i] && lum[i] > lineLimit ? 1 : 0;
  const body = distanceField(solid, w, h);
  const parts = distanceField(open, w, h);
  let maxBody = 0;
  let maxParts = 0;
  for (let i = 0; i < n; i++) {
    maxBody = Math.max(maxBody, body[i]);
    maxParts = Math.max(maxParts, parts[i]);
  }
  // Capped, so a wide house gets beveled edges and a flat front instead of becoming a balloon.
  const capBody = Math.min(maxBody, 10);
  const capParts = Math.min(maxParts, 4);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) if (solid[i]) raw[i] = dome(body[i], capBody) * 0.65 + dome(parts[i], capParts) * 0.55 + lum[i] * 1.2;
  // A light blur keeps single pixels of texture from turning into noise.
  const height = new Float32Array(n);
  const at = (a: Float32Array, x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : a[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      height[i] = raw[i] * 0.5 + (at(raw, x - 1, y) + at(raw, x + 1, y) + at(raw, x, y - 1) + at(raw, x, y + 1)) * 0.125;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      const gx = (at(height, x + 1, y - 1) + 2 * at(height, x + 1, y) + at(height, x + 1, y + 1) - at(height, x - 1, y - 1) - 2 * at(height, x - 1, y) - at(height, x - 1, y + 1)) / 8;
      const gy = (at(height, x - 1, y + 1) + 2 * at(height, x, y + 1) + at(height, x + 1, y + 1) - at(height, x - 1, y - 1) - 2 * at(height, x, y - 1) - at(height, x + 1, y - 1)) / 8;
      const nx = -gx * depth;
      const ny = -gy * depth;
      const len = Math.hypot(nx, ny, 1);
      const si = ((fy + y) * W + fx + x) * 4;
      out[si] = (nx / len + 1) * 127.5;
      out[si + 1] = (ny / len + 1) * 127.5;
      out[si + 2] = glow.has((src[si] << 16) | (src[si + 1] << 8) | src[si + 2]) ? 255 : 0;
      out[si + 3] = 255;
    }
  }
}

/**
 * Tiles have no silhouette of their own: they must join their neighbors seamlessly, so the bumps come only from the
 * painted light and dark inside the tile.
 */
function surfaceCell(src: Uint8ClampedArray, W: number, out: Uint8ClampedArray, f: FrameRect, depth: number, glow: Set<number>): void {
  const { x: fx, y: fy, w, h } = f;
  const n = w * h;
  const lum = new Float32Array(n);
  const solid = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((fy + y) * W + fx + x) * 4;
      if (src[si + 3] < 128) continue;
      solid[y * w + x] = 1;
      lum[y * w + x] = (0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2]) / 255;
    }
  }
  // Blurred, so the light reads the big painted forms (a treetop, a block of stone) and not every pixel of texture.
  let soft = lum;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!solid[i]) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= w || sy >= h || !solid[sy * w + sx]) continue;
            sum += soft[sy * w + sx];
            count++;
          }
        }
        next[i] = sum / count;
      }
    }
    soft = next;
  }
  /** Height at a neighbor; past the edge of the tile or on a hole, the pixel's own. */
  const at = (x: number, y: number, own: number) => (x < 0 || y < 0 || x >= w || y >= h || !solid[y * w + x] ? own : soft[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      const v = soft[i];
      const gx = (at(x + 1, y - 1, v) + 2 * at(x + 1, y, v) + at(x + 1, y + 1, v) - at(x - 1, y - 1, v) - 2 * at(x - 1, y, v) - at(x - 1, y + 1, v)) / 8;
      const gy = (at(x - 1, y + 1, v) + 2 * at(x, y + 1, v) + at(x + 1, y + 1, v) - at(x - 1, y - 1, v) - 2 * at(x, y - 1, v) - at(x + 1, y - 1, v)) / 8;
      const nx = -gx * SURFACE_RELIEF * depth;
      const ny = -gy * SURFACE_RELIEF * depth;
      const len = Math.hypot(nx, ny, 1);
      const si = ((fy + y) * W + fx + x) * 4;
      out[si] = (nx / len + 1) * 127.5;
      out[si + 1] = (ny / len + 1) * 127.5;
      out[si + 2] = glow.has((src[si] << 16) | (src[si + 1] << 8) | src[si + 2]) ? 255 : 0;
      out[si + 3] = 255;
    }
  }
}

/** How steep the bumps of a tile are for a given difference in brightness. */
const SURFACE_RELIEF = 6;

/** Computes the normal sheet of a spritesheet, frame by frame. */
export function buildNormalSheet(src: Uint8ClampedArray, width: number, height: number, frames: readonly FrameRect[], settings: SpriteReliefSettings = {}, kind: 'shape' | 'surface' = 'shape'): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const glow = new Set<number>();
  for (const c of settings.glow ?? []) {
    const rgb = hexToRgb(c);
    if (rgb) glow.add((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
  }
  const depth = settings.depth ?? 1;
  for (const f of frames) (kind === 'surface' ? surfaceCell : normalFrame)(src, width, out, f, depth * (kind === 'shape' ? SHAPE_DEPTH : 1), glow);
  return out;
}

/** The rectangles a tileset is shaded by: every tile of every frame, each one on its own. */
function tileCells(asset: Pick<SpriteAsset, 'frames' | 'grid'>): FrameRect[] {
  const grid = asset.grid!;
  const cells: FrameRect[] = [];
  for (const f of asset.frames) {
    for (let y = 0; y + grid.height <= f.h; y += grid.height) {
      for (let x = 0; x + grid.width <= f.w; x += grid.width) cells.push({ x: f.x + x, y: f.y + y, w: grid.width, h: grid.height });
    }
  }
  return cells;
}

/** The normal sheet of a sprite as the game uses it, or null if it stays flat. */
export function normalSheetFor(src: Uint8ClampedArray, width: number, height: number, asset: SpriteAsset, view: { width: number; height: number }): Uint8ClampedArray | null {
  const kind = reliefKind(asset, view);
  if (!kind) return null;
  return buildNormalSheet(src, width, height, kind === 'surface' ? tileCells(asset) : asset.frames, asset.relief, kind);
}

/** Which pixels of a frame are solid (one byte per pixel, row by row). */
export function frameMask(sheet: Uint8ClampedArray, sheetWidth: number, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let fy = 0; fy < h; fy++) for (let fx = 0; fx < w; fx++) if (sheet[((y + fy) * sheetWidth + x + fx) * 4 + 3] >= 128) out[fy * w + fx] = 1;
  return out;
}

/** The same sheet for mirrored drawing: the x of every normal points the other way. */
export function flipNormalSheet(sheet: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sheet);
  for (let i = 0; i < out.length; i += 4) if (out[i + 3]) out[i] = 255 - out[i];
  return out;
}

/** How a sprite takes per-pixel light: "shape" = a standing object with its own volume, "surface" = a tile, null = flat (backdrops, sprites switched off). */
export function reliefKind(asset: Pick<SpriteAsset, 'width' | 'height' | 'grid' | 'relief'>, view: { width: number; height: number }): 'shape' | 'surface' | null {
  if (asset.relief?.off) return null;
  if (asset.grid) return 'surface';
  return asset.width < view.width * 0.9 && asset.height < view.height * 0.9 ? 'shape' : null;
}

export interface ResolvedRelief {
  strength: number;
  bands: number;
  rim: number;
  lightHeight: number;
  /** Unit vector toward the sun, in screen space (z toward the viewer). */
  sun: { x: number; y: number; z: number; color: RGB; intensity: number; shade: RGB } | null;
}

export function resolveRelief(r: SceneRelief): ResolvedRelief {
  let sun: ResolvedRelief['sun'] = null;
  if (r.sun) {
    const a = ((r.sun.angle ?? -135) * Math.PI) / 180;
    const e = ((r.sun.elevation ?? 50) * Math.PI) / 180;
    const color = hexToRgb(r.sun.color ?? '#fff0d0') ?? [255, 240, 208];
    const shade = hexToRgb(r.sun.shade ?? '#6a70b0') ?? [106, 112, 176];
    sun = {
      x: Math.cos(a) * Math.cos(e),
      y: Math.sin(a) * Math.cos(e),
      z: Math.sin(e),
      color: [color[0] / 255, color[1] / 255, color[2] / 255],
      intensity: r.sun.intensity ?? 1,
      shade: [shade[0] / 255, shade[1] / 255, shade[2] / 255],
    };
  }
  return { strength: r.strength ?? 1, bands: r.bands ?? 4, rim: r.rim ?? 0.9, lightHeight: r.lightHeight ?? 0.3, sun };
}

/** A color under light. Past a bright level it rolls off instead of clipping, so pale stone keeps its detail in the sun. */
const roll = (c: number, light: number) => {
  const v = c * light;
  return light > 1 && v > 200 ? 200 + (v - 200) * 0.38 : v;
};

/** Rounds a shading value to discrete steps: light falls on sprites in clean bands, as a pixel artist would paint it. */
const band = (v: number, bands: number) => (bands > 0 ? Math.round(v * bands) / bands : v);

/**
 * Lights a finished frame in place. Pixels with no normal (the ground, tiles) receive the same light as the plain
 * lighting pass; pixels with a normal are shaped by it. `normals` has the size of the frame, in the sheet encoding.
 */
export function shadeRelief(frame: { width: number; height: number; data: Uint8ClampedArray }, normals: Uint8ClampedArray, relief: ResolvedRelief, ambient: string, lights: readonly ScreenLight[], glow: number): void {
  const { width: W, height: H, data: d } = frame;
  const n = W * H;
  const amb = hexToRgb(ambient) ?? [255, 255, 255];
  const lr = new Float32Array(n).fill(amb[0] / 255);
  const lg = new Float32Array(n).fill(amb[1] / 255);
  const lb = new Float32Array(n).fill(amb[2] / 255);
  // Ambient light comes from the sky: surfaces turned up catch more of it, surfaces turned down less.
  if (relief.strength > 0) {
    for (let i = 0; i < n; i++) {
      if (!normals[i * 4 + 3]) continue;
      const k = Math.max(0.3, 1 + band(-(normals[i * 4 + 1] / 127.5 - 1) * 0.75 * relief.strength, relief.bands));
      lr[i] *= k;
      lg[i] *= k;
      lb[i] *= k;
    }
  }
  const gr = new Float32Array(n);
  const gg = new Float32Array(n);
  const gb = new Float32Array(n);
  const { strength, bands, rim } = relief;

  for (const l of lights) {
    const c = hexToRgb(l.color);
    if (!c || l.radius <= 0) continue;
    const cr = c[0] / 255;
    const cg = c[1] / 255;
    const cb = c[2] / 255;
    const k = Math.min(1, l.intensity);
    const kg = Math.min(1, l.intensity * glow * 0.35);
    const glowRadius = l.radius * 0.7;
    const lift = l.radius * relief.lightHeight;
    const y1 = Math.min(H, Math.ceil(l.y + l.radius));
    const x1 = Math.min(W, Math.ceil(l.x + l.radius));
    for (let y = Math.max(0, Math.floor(l.y - l.radius)); y < y1; y++) {
      for (let x = Math.max(0, Math.floor(l.x - l.radius)); x < x1; x++) {
        const dx = l.x - (x + 0.5);
        const dy = l.y - (y + 0.5);
        const dist = Math.hypot(dx, dy);
        if (dist >= l.radius) continue;
        const f = (1 - dist / l.radius) ** 2 * k;
        const i = y * W + x;
        let shape = 1;
        let edge = 0;
        if (normals[i * 4 + 3]) {
          const nx = normals[i * 4] / 127.5 - 1;
          const ny = normals[i * 4 + 1] / 127.5 - 1;
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          const len = Math.hypot(dx, dy, lift) || 1;
          const facing = Math.max(0, (nx * dx + ny * dy + nz * lift) / len);
          const flat = lift / len;
          shape = Math.max(0.08, Math.min(2.6, band(1 + strength * 2.4 * (facing - flat), bands)));
          if (rim > 0 && dist > 0.5) edge = rim * (1 - nz) * (1 - nz) * Math.max(0, (nx * dx + ny * dy) / dist);
        }
        const v = f * (shape + edge * 2);
        lr[i] += cr * v;
        lg[i] += cg * v;
        lb[i] += cb * v;
        if (kg > 0 && dist < glowRadius) {
          const fg = (1 - dist / glowRadius) ** 2 * kg;
          gr[i] += c[0] * fg;
          gg[i] += c[1] * fg;
          gb[i] += c[2] * fg;
        }
      }
    }
  }

  const sun = relief.sun;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    let r = lr[i];
    let g = lg[i];
    let b = lb[i];
    if (normals[p + 3]) {
      if (sun) {
        const nx = normals[p] / 127.5 - 1;
        const ny = normals[p + 1] / 127.5 - 1;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        // Only the sideways part counts, so the sprites keep the brightness of the ground around them.
        const planar0 = Math.hypot(sun.x, sun.y) || 1;
        const v = band(((nx * sun.x + ny * sun.y) / planar0) * (1.15 - sun.z * 0.5) * strength, bands);
        if (v > 0) {
          const add = v * sun.intensity * 0.7;
          r += sun.color[0] * add;
          g += sun.color[1] * add;
          b += sun.color[2] * add;
        } else if (v < 0) {
          const t = Math.min(1, -v * sun.intensity * 1.3);
          r *= 1 + (sun.shade[0] - 1) * t;
          g *= 1 + (sun.shade[1] - 1) * t;
          b *= 1 + (sun.shade[2] - 1) * t;
        }
        if (rim > 0) {
          const planar = Math.hypot(sun.x, sun.y) || 1;
          const e = rim * (1 - nz) * (1 - nz) * Math.max(0, (nx * sun.x + ny * sun.y) / planar) * sun.intensity * 0.5;
          r += sun.color[0] * e;
          g += sun.color[1] * e;
          b += sun.color[2] * e;
        }
      }
      // Self-lit pixels (crystals, eyes, lava) never fall below their own color.
      if (normals[p + 2]) {
        r = Math.max(r, 1.1);
        g = Math.max(g, 1.1);
        b = Math.max(b, 1.1);
      }
      r = Math.min(1.45, r);
      g = Math.min(1.45, g);
      b = Math.min(1.45, b);
    } else {
      r = Math.min(1, r);
      g = Math.min(1, g);
      b = Math.min(1, b);
    }
    d[p] = Math.min(255, roll(d[p], r) + gr[i]);
    d[p + 1] = Math.min(255, roll(d[p + 1], g) + gg[i]);
    d[p + 2] = Math.min(255, roll(d[p + 2], b) + gb[i]);
  }
}
