/**
 * Concept → pixel art. Turns a high-resolution picture (concept art, a painting, an upscaled sprite) into clean
 * pixel art at a target size: colors are quantized first, then each output pixel takes the *majority* color of its
 * footprint instead of an average, so edges stay crisp and no muddy in-between colors appear. Thin dark lines
 * (outlines) are kept by a line bias, and isolated noise pixels are removed while deliberate glints survive.
 */
import { type RGBA, toHex } from './color.js';
import type { Bitmap } from './sprite.js';
import { getPixel, setPixel } from './draw.js';

// OKLab: perceptual distance for quantization.
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function rgbToOklab([r8, g8, b8]: RGBA | number[]): [number, number, number] {
  const [r, g, b] = [toLin(r8 / 255), toLin(g8 / 255), toLin(b8 / 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const dist2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Nearest palette entry in OKLab (with a cache keyed by RGB). */
export class Quantizer {
  readonly lab: [number, number, number][];
  private cache = new Map<number, number>();
  constructor(readonly palette: RGBA[]) {
    this.lab = palette.map((c) => rgbToOklab(c));
  }
  index(c: RGBA | number[]): number {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    let i = this.cache.get(key);
    if (i === undefined) {
      const lab = rgbToOklab(c);
      let best = 0;
      let bd = Infinity;
      this.lab.forEach((p, k) => {
        const d = dist2(lab, p);
        if (d < bd) { bd = d; best = k; }
      });
      i = best;
      this.cache.set(key, i);
    }
    return i;
  }
}

/** k-means palette in OKLab (deterministic: seeded along lightness, then farthest-point). */
export function kmeansPalette(src: Bitmap, k: number): RGBA[] {
  const px: number[][] = [];
  const step = Math.max(1, Math.floor((src.width * src.height) / 40000));
  for (let i = 0; i < src.width * src.height; i += step) if (src.data[i * 4 + 3] >= 128) px.push([src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]]);
  if (!px.length) return [];
  const labs = px.map((p) => rgbToOklab(p));
  const order = labs.map((_, i) => i).sort((a, b) => labs[a][0] - labs[b][0]);
  let centers: number[][] = [labs[order[0]], labs[order[order.length - 1]]];
  while (centers.length < Math.min(k, labs.length)) {
    let far = 0;
    let fd = -1;
    labs.forEach((l, i) => {
      const d = Math.min(...centers.map((c) => dist2(l, c)));
      if (d > fd) { fd = d; far = i; }
    });
    centers.push(labs[far]);
  }
  const assign = new Int32Array(labs.length);
  for (let iter = 0; iter < 15; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0, 0, 0, 0]);
    labs.forEach((l, i) => {
      let best = 0;
      let bd = Infinity;
      centers.forEach((c, j) => {
        const d = dist2(l, c);
        if (d < bd) { bd = d; best = j; }
      });
      assign[i] = best;
      const s = sums[best];
      s[0] += l[0]; s[1] += l[1]; s[2] += l[2]; s[3]++;
      s[4] += px[i][0]; s[5] += px[i][1]; s[6] += px[i][2];
    });
    centers = centers.map((c, j) => (sums[j][3] ? [sums[j][0] / sums[j][3], sums[j][1] / sums[j][3], sums[j][2] / sums[j][3]] : c));
  }
  // Report each cluster by the real source color closest to its center (no invented colors).
  const out: RGBA[] = [];
  centers.forEach((c, j) => {
    let best = -1;
    let bd = Infinity;
    labs.forEach((l, i) => {
      if (assign[i] !== j) return;
      const d = dist2(l, c);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0) out.push([px[best][0], px[best][1], px[best][2], 255]);
  });
  const uniq = [...new Map(out.map((c) => [toHex(c), c])).values()];
  // Merge clusters that ended up nearly identical (e.g. two near-blacks): they only add noise.
  const merged: RGBA[] = [];
  for (const c of uniq.sort((a, b) => rgbToOklab(a)[0] - rgbToOklab(b)[0])) {
    const lab = rgbToOklab(c);
    // Same closeness rule as lint's near-duplicate check (weighted RGB), plus a perceptual one.
    const close = (m: RGBA) => Math.sqrt(dist2(rgbToOklab(m), lab)) < 0.035 || Math.hypot((m[0] - c[0]) * 0.3, (m[1] - c[1]) * 0.59, (m[2] - c[2]) * 0.11) < 6;
    if (!merged.some(close)) merged.push(c);
  }
  return merged;
}

export interface PixelizeOptions {
  width: number;
  height: number;
  palette: RGBA[];
  /** Fraction of the footprint that must be opaque (default 0.5). */
  alphaThreshold?: number;
  /** If dark "line" colors fill this fraction of a footprint, the pixel becomes that line color (default 0.28). */
  lineBias?: number;
  /** OKLab lightness under which a palette color counts as a line color (default 0.3). */
  lineLightness?: number;
  /** Remove isolated pixels that are close in color to their surroundings (default true). */
  despeckle?: boolean;
}

/** Edge-preserving downscale: majority vote of quantized colors per footprint, with a bias that keeps outlines. */
export function pixelize(src: Bitmap, o: PixelizeOptions): Bitmap {
  const q = new Quantizer(o.palette);
  const W = o.width;
  const H = o.height;
  const fx = src.width / W;
  const fy = src.height / H;
  const out: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const isLine = q.lab.map((l) => l[0] < (o.lineLightness ?? 0.3));
  const votes = new Float64Array(o.palette.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      votes.fill(0);
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * fx));
      const y0 = Math.floor(y * fy);
      const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * fy));
      const cx = (x + 0.5) * fx;
      const cy = (y + 0.5) * fy;
      const rad = Math.max(fx, fy) * 0.75;
      let opaque = 0;
      let total = 0;
      let lineW = 0;
      let allW = 0;
      for (let sy = y0; sy < Math.min(y1, src.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, src.width); sx++) {
          total++;
          const c = getPixel(src, sx, sy);
          if (c[3] < 128) continue;
          opaque++;
          // Pixels near the footprint center weigh more: keeps small features where they are.
          const w = 1.5 - Math.min(1, Math.hypot(sx + 0.5 - cx, sy + 0.5 - cy) / rad);
          const i = q.index(c);
          votes[i] += w;
          allW += w;
          if (isLine[i]) lineW += w;
        }
      }
      if (!total || opaque / total < (o.alphaThreshold ?? 0.5)) continue;
      let best = -1;
      let bw = -1;
      const preferLine = allW > 0 && lineW / allW >= (o.lineBias ?? 0.28);
      for (let i = 0; i < votes.length; i++) {
        if (preferLine && !isLine[i]) continue;
        if (votes[i] > bw) { bw = votes[i]; best = i; }
      }
      if (best >= 0) setPixel(out, x, y, o.palette[best]);
    }
  }
  if (o.despeckle ?? true) despeckle(out);
  return out;
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Replaces pixels that have no same-colored neighbor and sit close (in color) to the majority of their neighbors:
 * quantization noise. High-contrast singles (eye glints, sparkles) are kept.
 */
export function despeckle(b: Bitmap, maxDelta = 0.12): number {
  const src: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const c = getPixel(src, x, y);
      if (!c[3]) continue;
      const counts = new Map<string, { c: RGBA; n: number }>();
      let same = false;
      for (const [dx, dy] of N8) {
        const nb = getPixel(src, x + dx, y + dy);
        if (nb[0] === c[0] && nb[1] === c[1] && nb[2] === c[2] && nb[3] === c[3]) { same = true; break; }
        const k = nb.join(',');
        counts.set(k, { c: nb, n: (counts.get(k)?.n ?? 0) + 1 });
      }
      if (same) continue;
      const major = [...counts.values()].sort((a, d) => d.n - a.n)[0];
      if (!major || major.c[3] === 0 || major.n < 3) continue;
      if (Math.sqrt(dist2(rgbToOklab(c), rgbToOklab(major.c))) > maxDelta) continue;
      setPixel(b, x, y, major.c);
      n++;
    }
  }
  return n;
}

function medianLightness(b: Bitmap): { p10: number; p50: number; p90: number } | null {
  const Ls: number[] = [];
  for (let i = 0; i < b.width * b.height; i++) if (b.data[i * 4 + 3] >= 128) Ls.push(rgbToOklab([b.data[i * 4], b.data[i * 4 + 1], b.data[i * 4 + 2]])[0]);
  if (!Ls.length) return null;
  Ls.sort((a, c) => a - c);
  const at = (p: number) => Ls[Math.min(Ls.length - 1, Math.floor(p * Ls.length))];
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}

/**
 * pixelize with the line bias chosen automatically: tries a few values and keeps the one whose light/dark
 * distribution (10th, 50th, 90th lightness percentiles) is closest to the source picture. Strong outlines in a
 * small result otherwise tend to make the sprite darker than its source.
 */
export function pixelizeAuto(src: Bitmap, o: PixelizeOptions, target: Bitmap): { image: Bitmap; lineBias: number } {
  const want = medianLightness(target);
  let best: { image: Bitmap; lineBias: number; err: number } | null = null;
  for (const lineBias of [0.28, 0.35, 0.42, 0.5, 0.6]) {
    const image = pixelize(src, { ...o, lineBias });
    const got = medianLightness(image);
    const err = want && got ? Math.abs(got.p50 - want.p50) * 2 + Math.abs(got.p10 - want.p10) + Math.abs(got.p90 - want.p90) : 0;
    if (!best || err < best.err - 0.002) best = { image, lineBias, err };
  }
  return { image: best!.image, lineBias: best!.lineBias };
}
