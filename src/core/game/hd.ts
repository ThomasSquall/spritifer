/**
 * Auto 2D-HD: a look applied to the finished picture of the world (bloom, depth of field, haze, soft halos around
 * lights, a filmic grade). Maps and sprites are not touched, so it can be switched on and off at any moment.
 *
 * Every parameter lives in HD_FIELDS, the one table the normalizer, the editor sliders and the MCP tools read.
 * The browser draws the look with shaders (runtime/hdCompositor.ts); applyHdBuffer is the same look on plain pixels,
 * for the headless screenshots. Keep the two in step. Pure and browser-safe.
 */

import type { ScreenLight } from './atmosphere.js';

export interface HdSettings {
  bloom?: number;
  bloomThreshold?: number;
  blurFar?: number;
  blurNear?: number;
  focusBand?: number;
  /** Height of the sharp band, 0 = top of the screen, 1 = bottom. Absent: it follows what the camera follows. */
  focusY?: number;
  haze?: number;
  /** Absent: derived from the scene's ambient light. */
  hazeColor?: string;
  halo?: number;
  exposure?: number;
  contrast?: number;
  saturation?: number;
  vignette?: number;
  /** Strength of the perspective, 0 = the flat picture with the effects only. */
  perspective?: number;
  /** Camera angle above the ground, in degrees. */
  elevation?: number;
  /** How many tiles of a wall's column are its vertical front; 0 = walls stay flat. */
  wallRows?: number;
  /** Multiplies how tall walls are. */
  wallHeight?: number;
}

/** Game-wide settings. `enabled` is how the game starts for a player who never chose. */
export interface GameHd extends HdSettings {
  enabled?: boolean;
}

/** A scene's own settings, over the game's. `off` keeps the scene flat even with 2D-HD on (title screens). */
export interface SceneHd extends HdSettings {
  off?: boolean;
}

type NumberKey = Exclude<keyof HdSettings, 'hazeColor'>;

export interface HdField {
  key: NumberKey;
  /** Name in the MCP tools. */
  mcp: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** focusY has none: absent means "follow the camera target". */
  dflt: number;
  hint: string;
}

export const HD_FIELDS: readonly HdField[] = [
  { key: 'perspective', mcp: 'perspective', label: 'Perspective', min: 0, max: 1, step: 0.01, dflt: 0.5, hint: 'How much the ground recedes into the distance. 0 = no 3D, only the effects below' },
  { key: 'elevation', mcp: 'elevation', label: 'Camera angle°', min: 20, max: 75, step: 1, dflt: 50, hint: 'Higher = the camera looks more from above, and walls lean out more' },
  { key: 'wallRows', mcp: 'wall_rows', label: 'Wall rows', min: 0, max: 6, step: 1, dflt: 3, hint: 'How many tiles of a wall, counting up from its foot, are its vertical front. 0 = walls stay flat' },
  { key: 'wallHeight', mcp: 'wall_height', label: 'Wall height', min: 0.2, max: 3, step: 0.05, dflt: 1, hint: 'Makes every wall taller or shorter than it is painted' },
  { key: 'bloom', mcp: 'bloom', label: 'Bloom', min: 0, max: 2, step: 0.05, dflt: 0.55, hint: 'Glow bleeding out of the brightest parts of the picture' },
  { key: 'bloomThreshold', mcp: 'bloom_threshold', label: 'Bloom from', min: 0.2, max: 1, step: 0.01, dflt: 0.72, hint: 'How bright a pixel must be to glow: lower = more of the picture blooms' },
  { key: 'blurFar', mcp: 'blur_far', label: 'Blur far', min: 0, max: 2, step: 0.05, dflt: 1.1, hint: 'Depth of field above the sharp band (what is far away)' },
  { key: 'blurNear', mcp: 'blur_near', label: 'Blur near', min: 0, max: 2, step: 0.05, dflt: 1.3, hint: 'Depth of field below the sharp band (what is close to the camera)' },
  { key: 'focusBand', mcp: 'focus_band', label: 'Sharp band', min: 0, max: 1, step: 0.01, dflt: 0.36, hint: 'How much of the screen height stays sharp' },
  { key: 'focusY', mcp: 'focus_y', label: 'Focus height', min: -0.05, max: 1, step: 0.05, dflt: -0.05, hint: 'Where the sharp band sits: 0 = top, 1 = bottom. All the way left = it follows the character' },
  { key: 'haze', mcp: 'haze', label: 'Haze', min: 0, max: 1, step: 0.01, dflt: 0.14, hint: 'Air between the camera and what is far away (upper part of the screen)' },
  { key: 'halo', mcp: 'halo', label: 'Light halos', min: 0, max: 2, step: 0.05, dflt: 0.45, hint: 'Smooth halos around lamps and fires, at screen resolution. Only in scenes darker than daylight' },
  { key: 'exposure', mcp: 'exposure', label: 'Exposure', min: 0.5, max: 1.5, step: 0.01, dflt: 1.03, hint: 'Overall brightness' },
  { key: 'contrast', mcp: 'contrast', label: 'Contrast', min: 0.7, max: 1.4, step: 0.01, dflt: 1.08, hint: '1 = unchanged' },
  { key: 'saturation', mcp: 'saturation', label: 'Saturation', min: 0, max: 1.6, step: 0.01, dflt: 1.1, hint: '1 = unchanged' },
  { key: 'vignette', mcp: 'vignette', label: 'Lens vignette', min: 0, max: 1, step: 0.01, dflt: 0.18, hint: 'Added to the scene vignette: a soft darkening towards the corners' },
];

/** Settings ready to draw: nothing is optional any more. */
export interface ResolvedHd extends Required<Omit<HdSettings, 'focusY'>> {
  focusY: number | undefined;
  /** 0 in daylight, 1 in the dark: lamps only shine when there is darkness for them to shine in. */
  darkness: number;
}

/** What the renderer needs to finish a frame. */
export interface HdFrame {
  hd: ResolvedHd;
  /** Where the camera target stands on the screen, 0..1. */
  subjectY: number;
  lights: ScreenLight[];
}

/** Corrections to the automatic walls, by "x,y" of the cell: 0 = stays flat, n = wall with a front n tiles high. */
export type HdCells = Record<string, number>;
export const HD_CELL_MAX_ROWS = 8;

export function normalizeHdCells(v: unknown): HdCells | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: HdCells = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (/^\d+,\d+$/.test(k) && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= HD_CELL_MAX_ROWS) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const HEX = /^#[0-9a-f]{6}$/i;

function rgbOf(hex: string): [number, number, number] {
  let s = hex.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hexOf = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Keeps known fields, within their range. A focusY below zero means "follow the camera target", so it is dropped. */
export function normalizeHd(v: unknown): (GameHd & SceneHd) | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: GameHd & SceneHd = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (o.off === true) out.off = true;
  for (const f of HD_FIELDS) {
    const n = o[f.key];
    if (typeof n !== 'number' || !Number.isFinite(n)) continue;
    if (f.key === 'focusY' && n < 0) continue;
    out[f.key] = clamp(n, f.min, f.max);
  }
  if (typeof o.hazeColor === 'string' && HEX.test(o.hazeColor)) out.hazeColor = o.hazeColor.toLowerCase();
  return out;
}

/** The settings of a scene: its own over the game's over the defaults. null when the scene stays flat. */
export function resolveHd(game: GameHd | undefined, scene: SceneHd | undefined, ambient = '#ffffff'): ResolvedHd | null {
  if (scene?.off) return null;
  const pick = (f: HdField) => scene?.[f.key] ?? game?.[f.key] ?? f.dflt;
  const values = Object.fromEntries(HD_FIELDS.map((f) => [f.key, pick(f)])) as Record<NumberKey, number>;
  const [r, g, b] = rgbOf(ambient);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // Hazy air takes the color of the light it floats in.
  const sky = rgbOf('#cfe0ff');
  const hazeColor = scene?.hazeColor ?? game?.hazeColor ?? hexOf([(r + sky[0]) / 2, (g + sky[1]) / 2, (b + sky[2]) / 2]);
  return { ...values, focusY: values.focusY < 0 ? undefined : values.focusY, hazeColor, darkness: clamp((1 - luminance) * 1.8, 0, 1) };
}

/** How out of focus a screen height is, 0 = sharp. `y` and `focus` are 0..1 from the top. */
export function hdBlurAt(y: number, focus: number, hd: Pick<ResolvedHd, 'focusBand' | 'blurFar' | 'blurNear'>): number {
  const d = y - focus;
  const t = clamp((Math.abs(d) - hd.focusBand / 2) / 0.4, 0, 1);
  return t * t * (3 - 2 * t) * (d < 0 ? hd.blurFar : hd.blurNear);
}

/** Height of the sharp band for this frame. It only partly follows the character: at the edge of a room, the room stays readable. */
export const hdFocus = (f: HdFrame): number => f.hd.focusY ?? clamp(f.subjectY, 0.38, 0.62);

/** Averages the picture into a grid of `w`×`h` RGB cells. */
function shrink(data: Uint8ClampedArray, W: number, H: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const count = new Float32Array(w * h);
  for (let y = 0; y < H; y++) {
    const cy = Math.min(h - 1, Math.floor((y * h) / H));
    for (let x = 0; x < W; x++) {
      const c = cy * w + Math.min(w - 1, Math.floor((x * w) / W));
      const p = (y * W + x) * 4;
      out[c * 3] += data[p];
      out[c * 3 + 1] += data[p + 1];
      out[c * 3 + 2] += data[p + 2];
      count[c]++;
    }
  }
  for (let c = 0; c < count.length; c++) {
    const k = count[c] ? 1 / count[c] : 0;
    out[c * 3] *= k;
    out[c * 3 + 1] *= k;
    out[c * 3 + 2] *= k;
  }
  return out;
}

/** Box blur of radius `r`, twice (close to a gaussian). */
function soften(src: Float32Array, w: number, h: number, r: number): Float32Array {
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    for (const horizontal of [true, false]) {
      const b = new Float32Array(a.length);
      const lines = horizontal ? h : w;
      const len = horizontal ? w : h;
      const at = (line: number, i: number) => (horizontal ? line * w + i : i * w + line) * 3;
      for (let line = 0; line < lines; line++) {
        for (let i = 0; i < len; i++) {
          for (let ch = 0; ch < 3; ch++) {
            let sum = 0;
            for (let k = -r; k <= r; k++) sum += a[at(line, clamp(i + k, 0, len - 1)) + ch];
            b[at(line, i) + ch] = sum / (r * 2 + 1);
          }
        }
      }
      a = b;
    }
  }
  return a;
}

/** The 2D-HD look on plain RGBA pixels, in place. Coarser than the shaders, same parameters and same shape. */
export function applyHdBuffer(data: Uint8ClampedArray, W: number, H: number, frame: HdFrame): void {
  const { hd, lights } = frame;
  const focus = hdFocus(frame);
  const h = clamp(Math.round(H / 4), 1, 180);
  const w = Math.max(1, Math.round((W * h) / H));
  const low = shrink(data, W, H, w, h);
  const blurred = soften(low, w, h, 2);
  const bright = new Float32Array(low.length);
  const t = hd.bloomThreshold * 255;
  for (let c = 0; c < w * h; c++) {
    const i = c * 3;
    const peak = Math.max(low[i], low[i + 1], low[i + 2]);
    const s = clamp((peak - (t - 30)) / 60, 0, 1);
    const k = s * s * (3 - 2 * s);
    bright[i] = low[i] * k;
    bright[i + 1] = low[i + 1] * k;
    bright[i + 2] = low[i + 2] * k;
  }
  const glow = soften(bright, w, h, 4);
  const sample = (g: Float32Array, u: number, v: number, ch: number) => {
    const x = clamp(u * w - 0.5, 0, w - 1);
    const y = clamp(v * h - 0.5, 0, h - 1);
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = g[(y0 * w + x0) * 3 + ch] * (1 - fx) + g[(y0 * w + x1) * 3 + ch] * fx;
    const bottom = g[(y1 * w + x0) * 3 + ch] * (1 - fx) + g[(y1 * w + x1) * 3 + ch] * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const haze = rgbOf(hd.hazeColor);
  const beams = lights.map((l) => ({ x: l.x, y: l.y, r: l.radius, i: l.intensity * hd.halo * hd.darkness, c: rgbOf(l.color) })).filter((l) => l.i > 0 && l.r > 0);
  const out = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    const coc = Math.min(1, hdBlurAt(v, focus, hd) * 0.8);
    const air = hd.haze * (focus > 0 ? 1 - clamp(v / focus, 0, 1) : 0);
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const u = (x + 0.5) / W;
      for (let ch = 0; ch < 3; ch++) {
        let c = data[p + ch];
        if (coc > 0) c += (sample(blurred, u, v, ch) - c) * coc;
        c += (haze[ch] - c) * air;
        out[ch] = c + sample(glow, u, v, ch) * hd.bloom * 1.6;
      }
      for (const l of beams) {
        const d = Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y) / l.r;
        if (d >= 1) continue;
        const a = (1 - d) ** 3 * l.i;
        out[0] += l.c[0] * a;
        out[1] += l.c[1] * a;
        out[2] += l.c[2] * a;
      }
      const luma = (out[0] * 0.299 + out[1] * 0.587 + out[2] * 0.114) * hd.exposure;
      const corner = Math.hypot(u - 0.5, v - 0.5) * 1.2;
      const s = clamp((corner - 0.35) / 0.5, 0, 1);
      const shade = 1 - hd.vignette * s * s * (3 - 2 * s);
      for (let ch = 0; ch < 3; ch++) {
        const c = luma + (out[ch] * hd.exposure - luma) * hd.saturation;
        data[p + ch] = ((c - 127.5) * hd.contrast + 127.5) * shade;
      }
    }
  }
}
