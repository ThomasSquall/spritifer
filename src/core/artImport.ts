/**
 * Imports pixel art made by an image generator (ChatGPT and the like). Those pictures only look like pixel art: every
 * "pixel" is a blurry block of 3-5 real pixels on a slightly uneven grid, colors drift inside flat areas, and the
 * alpha channel, when there is one, is a soft blob. This finds the block size, rebuilds the picture at its true
 * resolution with one shared palette, and removes the background afterwards, on the clean result, so no halo is left.
 */
import { type RGBA, toHex } from './color.js';
import type { Bitmap, Sprite } from './sprite.js';
import { addFrame, createSprite, getCel, setTag } from './sprite.js';
import { despeckle, kmeansPalette, pixelize, rgbToOklab } from './pixelize.js';

export interface ArtRect { x: number; y: number; width: number; height: number }

export interface ArtItem {
  /** Sprite to create. Items with the same sprite become its frames, in order. */
  sprite: string;
  crop: ArtRect;
  /** Pixels cut from every side of the crop first: panel borders and frames. */
  inset?: number;
  /** Animation name for this frame; consecutive frames with the same tag form one animation. */
  tag?: string;
  /** Overrides the shared option for this item. */
  background?: ArtBackground;
  pixelSize?: number;
}

export type ArtBackground = 'remove' | 'keep';

export interface ArtOptions {
  /** Real pixels per art pixel. Default: measured on each item. */
  pixelSize?: number;
  /** Size of the palette shared by all the items (default 32). */
  colors?: number;
  background?: ArtBackground;
  /** How far from the border color a pixel may be and still count as background, in OKLab (default: measured). */
  tolerance?: number;
  /** Also removes the soft shadow the figure stands on (default true). */
  removeShadow?: boolean;
  /** Cuts empty rows and columns around each sprite (default true). */
  trim?: boolean;
  /** Empty pixels kept around a trimmed sprite (default 0). */
  margin?: number;
  /** How much of a pixel dark lines must cover to win (default 0.5). Raise it when small sprites come out too dark. */
  lineBias?: number;
  /** Darkens the edge of the figure, for small sprites that must stand out from the ground (default false). */
  outline?: boolean;
  /**
   * Keeps the picture as it is: each art pixel is the color found in the middle of its block, with no palette reduction,
   * no outline rules and no noise removal. The background goes only if it is real transparency or one flat color.
   */
  exact?: boolean;
  /** Fixed canvas, to replace an existing sprite without touching hitboxes and scenes. Default: as tight as the art. */
  canvas?: { width: number; height: number; /** Row the feet stand on: the last filled row (default the last row). */ baseline?: number };
  /** What stays still from frame to frame: "center" = the whole figure (default), "head" = the head, so a swinging cape does not shake it. */
  align?: 'center' | 'head';
}

export interface PixelGrid {
  /** Real pixels per art pixel. */
  size: number;
  /** Where the first whole art pixel starts. */
  x: number;
  y: number;
  /** How regular the grid is: above about 1.5 it is reliable, below it pass the size by hand. */
  confidence: number;
}

export interface ArtResult {
  sprite: string;
  width: number;
  height: number;
  /** One per frame. */
  frames: Bitmap[];
  tags: (string | undefined)[];
  grids: PixelGrid[];
}

const lightness = (d: Uint8ClampedArray, i: number) => 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];

export function cropBitmap(src: Bitmap, r: ArtRect): Bitmap {
  const out: Bitmap = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const sx = x + r.x;
      const sy = y + r.y;
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      const a = (sy * src.width + sx) * 4;
      const b = (y * r.width + x) * 4;
      out.data[b] = src.data[a];
      out.data[b + 1] = src.data[a + 1];
      out.data[b + 2] = src.data[a + 2];
      out.data[b + 3] = src.data[a + 3];
    }
  }
  return out;
}

/** True when the alpha channel is a soft mask rather than real cut-out edges: the colors underneath are what counts. */
export function hasSoftAlpha(src: Bitmap): boolean {
  let soft = 0;
  const n = src.width * src.height;
  for (let i = 0; i < n; i++) {
    const a = src.data[i * 4 + 3];
    if (a > 16 && a < 240) soft++;
  }
  return soft / n > 0.05;
}

export function makeOpaque(src: Bitmap): Bitmap {
  const out: Bitmap = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

/** Sum of the color jumps across each column (axis 0) or row (axis 1) boundary, with the slow trend removed. */
function edgeProfile(b: Bitmap, axis: 0 | 1): Float64Array {
  const n = axis === 0 ? b.width : b.height;
  const raw = new Float64Array(Math.max(0, n - 1));
  const dx = axis === 0 ? 4 : b.width * 4;
  for (let y = 0; y < b.height - axis; y++) {
    for (let x = 0; x < b.width - (1 - axis); x++) {
      const i = (y * b.width + x) * 4;
      raw[axis === 0 ? x : y] += Math.abs(lightness(b.data, i) - lightness(b.data, i + dx));
    }
  }
  const out = new Float64Array(raw.length);
  const R = 12;
  for (let i = 0; i < raw.length; i++) {
    let sum = 0;
    let c = 0;
    for (let k = Math.max(0, i - R); k <= Math.min(raw.length - 1, i + R); k++) { sum += raw[k]; c++; }
    out[i] = raw[i] - sum / c;
  }
  return out;
}

/** Best alignment of a comb of the given period on a profile: how much edge energy its teeth catch. */
function combScore(profile: Float64Array, period: number): { score: number; phase: number } {
  let std = 0;
  for (const v of profile) std += v * v;
  std = Math.sqrt(std / Math.max(1, profile.length)) || 1;
  let best = { score: -Infinity, phase: 0 };
  for (let phase = 0; phase < period; phase += 0.25) {
    let sum = 0;
    let c = 0;
    for (let p = phase; p < profile.length - 1; p += period) {
      const i = Math.floor(p);
      const f = p - i;
      sum += profile[i] * (1 - f) + profile[i + 1] * f;
      c++;
    }
    const score = c ? sum / c / std : 0;
    if (score > best.score) best = { score, phase };
  }
  return best;
}

/** Normalized self-similarity of an edge profile at each lag. */
function autocorrelate(profile: Float64Array, maxLag: number): Float64Array {
  const out = new Float64Array(maxLag + 2);
  let zero = 0;
  for (const v of profile) zero += v * v;
  if (!zero) return out;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < profile.length; i++) sum += profile[i] * profile[i + lag];
    out[lag] = (sum / zero) * (profile.length / Math.max(1, profile.length - lag));
  }
  return out;
}

/**
 * Measures the size of the fake pixels. The edges of a grid repeat at its period, so the edge profile correlates with
 * itself at that lag: blur inflates the first lags, which is why only a real peak counts, and the smallest strong peak
 * wins over its multiples.
 */
export function detectPixelGrid(src: Bitmap, min = 2, max = 12): PixelGrid {
  const px = edgeProfile(src, 0);
  const py = edgeProfile(src, 1);
  const acx = autocorrelate(px, max * 3);
  const acy = autocorrelate(py, max * 3);
  const ac = (k: number) => (acx[k] + acy[k]) / 2;
  const peaks: { k: number; v: number }[] = [];
  for (let k = min; k <= max; k++) if (ac(k) > ac(k - 1) && ac(k) >= ac(k + 1)) peaks.push({ k, v: ac(k) });
  const top = Math.max(0, ...peaks.map((p) => p.v));
  const first = peaks.find((p) => p.v >= top * 0.7);
  let size = first?.k ?? min;
  // The third repeat of the period shows a fractional size (3.4 instead of 3) that the first one cannot.
  let bestLag = size * 3;
  for (let k = size * 3 - 2; k <= size * 3 + 2; k++) if (k > 0 && k <= max * 3 && ac(k) > ac(bestLag)) bestLag = k;
  if (ac(bestLag) > (first?.v ?? 0) * 0.5) size = Math.round((bestLag / 3) * 20) / 20;
  return { ...alignGrid(src, size), confidence: Math.round((first?.v ?? 0) * 100) / 100 };
}

/** Where a grid of known size starts. A profile entry is the boundary after its pixel, so a block begins one later. */
export function alignGrid(src: Bitmap, size: number): PixelGrid {
  const x = combScore(edgeProfile(src, 0), size);
  const y = combScore(edgeProfile(src, 1), size);
  return { size, x: (x.phase + 1) % size, y: (y.phase + 1) % size, confidence: 0 };
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Clears what is connected to the border and looks like it. Works on the rebuilt picture, where each pixel is a single
 * palette color. The fill cannot pass through gaps narrower than three pixels, so a hair or a boot colored like the
 * background stays safe behind a broken outline. `hint` is optional knowledge per pixel: 1 = figure, 2 = background.
 */
export function clearBackground(b: Bitmap, opts: { tolerance?: number; removeShadow?: boolean; hint?: Uint8Array } = {}): { removed: number; tolerance: number } {
  const W = b.width;
  const H = b.height;
  const lab = new Array<number[]>(W * H);
  for (let i = 0; i < W * H; i++) lab[i] = rgbToOklab([b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]]);
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const channels = [0, 1, 2].map((c) => border.map((i) => lab[i][c]).sort((p, q) => p - q));
  const bg = channels.map((v) => v[v.length >> 1]);
  const spread = border.map((i) => dist(lab[i], bg)).sort((p, q) => p - q);
  const tolerance = opts.tolerance ?? Math.min(0.1, Math.max(0.04, spread[Math.floor(spread.length * 0.8)] * 1.5));
  const open = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) open[i] = opts.hint?.[i] === 2 || (opts.hint?.[i] !== 1 && (dist(lab[i], bg) < tolerance || (opts.hint?.[i] === 0 && lab[i][0] <= bg[0] + 0.02 && Math.hypot(lab[i][1], lab[i][2]) < 0.04))) ? 1 : 0;
  const isBorder = (x: number, y: number) => x === 0 || y === 0 || x === W - 1 || y === H - 1;
  // Eroded mask: only the core of open areas, so one or two open pixels in a row are a wall.
  const core = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let all = open[y * W + x] === 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1 && all; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !open[ny * W + nx]) all = false;
        }
      }
      if (all || (isBorder(x, y) && open[y * W + x])) core[y * W + x] = 1;
    }
  }
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  const neighbors = (i: number) => {
    const x = i % W;
    return [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1, x > 0 && i >= W ? i - W - 1 : -1, x < W - 1 && i >= W ? i - W + 1 : -1, x > 0 && i < W * (H - 1) ? i + W - 1 : -1, x < W - 1 && i < W * (H - 1) ? i + W + 1 : -1];
  };
  for (const i of border) if (!seen[i] && core[i]) { seen[i] = 1; stack.push(i); }
  if (opts.hint) for (let i = 0; i < W * H; i++) if (opts.hint[i] === 2 && !seen[i]) { seen[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of neighbors(i).slice(0, 4)) if (j >= 0 && !seen[j] && core[j]) { seen[j] = 1; stack.push(j); }
  }
  // Grow back by the pixels the erosion took from the edge of the cleared area.
  for (let round = 0; round < 2; round++) {
    const add: number[] = [];
    for (let i = 0; i < W * H; i++) if (seen[i]) for (const j of neighbors(i)) if (j >= 0 && !seen[j] && open[j]) add.push(j);
    for (const j of add) seen[j] = 1;
  }
  if (opts.removeShadow ?? true) {
    // The contact shadow: gray and no lighter than the background, low in the picture, touching what was cleared.
    const from = W * Math.floor(H * 0.8);
    const shadow = (i: number) => i >= from && opts.hint?.[i] !== 1 && Math.hypot(lab[i][1], lab[i][2]) < 0.03 && lab[i][0] <= bg[0] + 0.02;
    for (let i = from; i < W * H; i++) if (seen[i]) stack.push(i);
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of neighbors(i).slice(0, 4)) if (j >= 0 && !seen[j] && shadow(j)) { seen[j] = 1; stack.push(j); }
    }
  }
  let removed = 0;
  for (let i = 0; i < W * H; i++) if (seen[i]) { b.data[i * 4 + 3] = 0; removed++; }
  return { removed, tolerance };
}

/** Removes islands of a few pixels left floating outside the figure. */
export function dropIslands(b: Bitmap, minSize = 6): void {
  const W = b.width;
  const H = b.height;
  const seen = new Uint8Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || !b.data[start * 4 + 3]) continue;
    const part = [start];
    seen[start] = 1;
    for (let n = 0; n < part.length; n++) {
      const i = part[n];
      const x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < W * (H - 1) ? i + W : -1]) {
        if (j >= 0 && !seen[j] && b.data[j * 4 + 3]) { seen[j] = 1; part.push(j); }
      }
    }
    if (part.length < minSize) for (const i of part) b.data[i * 4 + 3] = 0;
  }
}

/** What a soft alpha mask knows, on the grid of the rebuilt art: its plateau is the figure, its low part background, its slopes are blur. */
function alphaHint(src: Bitmap, grid: PixelGrid, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.round(grid.x + (x + 0.5) * grid.size));
      const sy = Math.min(src.height - 1, Math.round(grid.y + (y + 0.5) * grid.size));
      const a = src.data[(sy * src.width + sx) * 4 + 3];
      out[y * width + x] = a >= 248 ? 1 : a <= 200 ? 2 : 0;
    }
  }
  return out;
}

function trimBox(frames: Bitmap[], margin: number): ArtRect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (const f of frames) {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        if (!f.data[(y * f.width + x) * 4 + 3]) continue;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0 - margin, y: y0 - margin, width: x1 - x0 + 1 + margin * 2, height: y1 - y0 + 1 + margin * 2 };
}

/** Repaints the lit pixels on the edge of the figure with its darkest color, so the silhouette is closed. */
export function closeOutline(b: Bitmap): void {
  const W = b.width;
  const H = b.height;
  let dark: number[] | null = null;
  let darkL = Infinity;
  const light = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!b.data[i * 4 + 3]) continue;
    const c = [b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]];
    light[i] = rgbToOklab(c)[0];
    if (light[i] < darkL) { darkL = light[i]; dark = c; }
  }
  if (!dark) return;
  const empty = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || !b.data[(y * W + x) * 4 + 3];
  const edge: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (b.data[i * 4 + 3] && light[i] > darkL + 0.08 && (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1))) edge.push(i);
    }
  }
  for (const i of edge) b.data.set(dark, i * 4);
}

/** Rebuilds a crop by reading the middle of each block: the art changes only in size. */
function sampleExact(src: Bitmap, grid: PixelGrid): Bitmap {
  if (grid.size === 1) return src;
  const ox = Math.round(grid.x);
  const oy = Math.round(grid.y);
  const width = Math.max(1, Math.round((src.width - ox) / grid.size));
  const height = Math.max(1, Math.round((src.height - oy) / grid.size));
  const out: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const reach = Math.max(0, Math.floor(grid.size / 4));
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cx = Math.floor(ox + (x + 0.5) * grid.size);
      const cy = Math.floor(oy + (y + 0.5) * grid.size);
      const channels: number[][] = [[], [], [], []];
      for (let sy = cy - reach; sy <= cy + reach; sy++) {
        for (let sx = cx - reach; sx <= cx + reach; sx++) {
          if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
          const i = (sy * src.width + sx) * 4;
          for (let c = 0; c < 4; c++) channels[c].push(src.data[i + c]);
        }
      }
      if (!channels[0].length) continue;
      const a = median(channels[3]);
      if (a < 128) continue;
      out.data.set([median(channels[0]), median(channels[1]), median(channels[2]), 255], (y * width + x) * 4);
    }
  }
  return out;
}

function hasRealTransparency(b: Bitmap): boolean {
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] === 0) return true;
  return false;
}

/** Middle of the top third of a trimmed figure: the head, which barely moves while cape and arms swing. */
function headCenter(b: Bitmap): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < Math.ceil(b.height / 3); y++) {
    for (let x = 0; x < b.width; x++) if (b.data[(y * b.width + x) * 4 + 3]) { sum += x; n++; }
  }
  return n ? Math.round(sum / n) : b.width >> 1;
}

/** Rebuilds one crop at its true resolution. */
function rebuild(src: Bitmap, grid: PixelGrid, palette: RGBA[], lineBias?: number): Bitmap {
  const ox = Math.round(grid.x);
  const oy = Math.round(grid.y);
  const area = cropBitmap(src, { x: ox, y: oy, width: src.width - ox, height: src.height - oy });
  const width = Math.max(1, Math.round(area.width / grid.size));
  const height = Math.max(1, Math.round(area.height / grid.size));
  const out = pixelize(area, { width, height, palette, alphaThreshold: 0.5, lineBias: lineBias ?? 0.5, despeckle: false });
  despeckle(out, 0.1);
  return out;
}

function prepare(full: Bitmap, it: ArtItem): Bitmap {
  const inset = it.inset ?? 0;
  return cropBitmap(full, { x: it.crop.x + inset, y: it.crop.y + inset, width: it.crop.width - inset * 2, height: it.crop.height - inset * 2 });
}

/** The whole clean-up: returns the finished art of every sprite, without saving anything. */
export function cleanArt(picture: Bitmap, items: ArtItem[], o: ArtOptions = {}): ArtResult[] {
  if (!items.length) throw new Error('Nothing to import: give at least one item');
  const soft = hasSoftAlpha(picture);
  const full = soft ? makeOpaque(picture) : picture;
  const crops = items.map((it) => prepare(full, it));
  const W = Math.max(...crops.map((c) => c.width));
  const H = crops.reduce((sum, c) => sum + c.height, 0);
  const all: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  let at = 0;
  for (const c of crops) {
    for (let y = 0; y < c.height; y++) all.data.set(c.data.subarray(y * c.width * 4, (y + 1) * c.width * 4), (at + y) * W * 4);
    at += c.height;
  }
  const palette = o.exact ? [] : kmeansPalette(all, o.colors ?? 32);
  if (!o.exact && !palette.length) throw new Error('The crops are empty');
  const byName = new Map<string, ArtItem[]>();
  for (const it of items) byName.set(it.sprite, [...(byName.get(it.sprite) ?? []), it]);
  const results: ArtResult[] = [];
  for (const [sprite, group] of byName) {
    const grids: PixelGrid[] = [];
    const size = group.find((g) => g.pixelSize)?.pixelSize ?? o.pixelSize;
    const frames = group.map((it) => {
      const src = prepare(full, it);
      const grid = size === 1 ? { size: 1, x: 0, y: 0, confidence: 0 } : size ? alignGrid(src, size) : detectPixelGrid(src);
      grids.push(grid);
      const remove = (it.background ?? o.background ?? 'remove') === 'remove';
      if (o.exact) {
        const art = sampleExact(src, grid);
        if (remove && !hasRealTransparency(art)) clearBackground(art, { tolerance: o.tolerance ?? 0.03, removeShadow: false });
        return art;
      }
      const art = rebuild(src, grid, palette, o.lineBias);
      if (remove) {
        const hint = soft ? alphaHint(prepare(picture, it), grid, art.width, art.height) : undefined;
        clearBackground(art, { tolerance: o.tolerance, removeShadow: o.removeShadow, hint });
        dropIslands(art);
        if (o.outline) closeOutline(art);
      }
      return art;
    });
    // Frames of one sprite share a canvas, standing on its bottom edge and centered.
    const boxes = (o.trim ?? true) ? frames.map((f) => trimBox([f], o.margin ?? 0) ?? { x: 0, y: 0, width: f.width, height: f.height }) : frames.map((f) => ({ x: 0, y: 0, width: f.width, height: f.height }));
    const anchors = frames.map((f, i) => (o.align === 'head' ? headCenter(cropBitmap(f, boxes[i])) : boxes[i].width >> 1));
    const reach = Math.max(...anchors);
    const width = o.canvas?.width ?? reach + Math.max(...boxes.map((b, i) => b.width - anchors[i]));
    const height = o.canvas?.height ?? Math.max(...boxes.map((b) => b.height));
    const baseline = o.canvas?.baseline ?? height - 1;
    const middle = o.canvas ? width >> 1 : reach;
    for (const b of boxes) {
      if (b.width > width || b.height > baseline + 1) throw new Error(`${sprite}: a ${b.width}x${b.height} frame does not fit the canvas of ${width}x${height} with its feet on row ${baseline}`);
    }
    const placed = frames.map((f, i) => {
      const b = boxes[i];
      const out: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      const cut = cropBitmap(f, b);
      const dx = middle - anchors[i];
      const dy = baseline + 1 - b.height;
      for (let y = 0; y < b.height; y++) {
        for (let x = 0; x < b.width; x++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
          const from = (y * b.width + x) * 4;
          out.data.set(cut.data.subarray(from, from + 4), (ty * width + tx) * 4);
        }
      }
      return out;
    });
    results.push({ sprite, width, height, frames: placed, tags: group.map((g) => g.tag), grids });
  }
  return results;
}

/** Turns a result into a sprite with its frames, animations and the palette it really uses. */
export function spriteFromArt(r: ArtResult, frameDuration = 120): Sprite {
  const counts = new Map<string, number>();
  for (const f of r.frames) {
    for (let i = 0; i < f.data.length; i += 4) {
      if (!f.data[i + 3]) continue;
      const c = toHex([f.data[i], f.data[i + 1], f.data[i + 2], 255]);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  // Exact art can hold hundreds of colors: the swatches list only the main ones, the pixels keep them all.
  const palette = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([c]) => c);
  const s = createSprite({ name: r.sprite, width: r.width, height: r.height, frameDuration, palette });
  r.frames.forEach((_, i) => { if (i > 0) addFrame(s); });
  const layer = s.layers[0];
  r.frames.forEach((f, i) => getCel(s, layer.id, s.frames[i].id, true).set(f.data));
  for (let i = 0; i < r.tags.length;) {
    const tag = r.tags[i];
    let j = i;
    while (j + 1 < r.tags.length && r.tags[j + 1] === tag) j++;
    if (tag) setTag(s, { name: tag, from: i, to: j });
    i = j + 1;
  }
  return s;
}

/** Every frame of the results side by side on a flat color: what the import will produce. */
export function artContactSheet(results: ArtResult[], scale = 4, background: RGBA = [58, 88, 120, 255]): Bitmap {
  const gap = 3;
  const cells = results.flatMap((r) => r.frames);
  const W = (cells.reduce((sum, f) => sum + f.width + gap, gap)) * scale;
  const H = (Math.max(...cells.map((f) => f.height)) + gap * 2) * scale;
  const out: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let i = 0; i < W * H; i++) out.data.set(background, i * 4);
  let left = gap;
  for (const f of cells) {
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const a = (y * f.width + x) * 4;
        if (!f.data[a + 3]) continue;
        for (let yy = 0; yy < scale; yy++) {
          for (let xx = 0; xx < scale; xx++) {
            const o = (((y + gap) * scale + yy) * W + (x + left) * scale + xx) * 4;
            out.data[o] = f.data[a];
            out.data[o + 1] = f.data[a + 1];
            out.data[o + 2] = f.data[a + 2];
            out.data[o + 3] = 255;
          }
        }
      }
    }
    left += f.width + gap;
  }
  return out;
}
