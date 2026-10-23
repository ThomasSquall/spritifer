import type { Bitmap } from './sprite.js';
import { type RGBA, colorsEqual, toHex, parseColor } from './color.js';

export type Point = [number, number];

export function inBounds(b: Bitmap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < b.width && y < b.height;
}

export function getPixel(b: Bitmap, x: number, y: number): RGBA {
  if (!inBounds(b, x, y)) return [0, 0, 0, 0];
  const i = (y * b.width + x) * 4;
  return [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]];
}

/** Writes a pixel verbatim (pixel art semantics: no blending). Out-of-bounds writes are ignored. */
export function setPixel(b: Bitmap, x: number, y: number, c: RGBA): boolean {
  if (!inBounds(b, x, y)) return false;
  const i = (y * b.width + x) * 4;
  if (c[3] === 0) {
    b.data[i] = b.data[i + 1] = b.data[i + 2] = b.data[i + 3] = 0;
  } else {
    b.data[i] = c[0];
    b.data[i + 1] = c[1];
    b.data[i + 2] = c[2];
    b.data[i + 3] = c[3];
  }
  return true;
}

/** Bresenham line, inclusive of both ends. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  const pts: Point[] = [];
  let dx = Math.abs(x1 - x0);
  let dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

export function rectPoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Point[] {
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const pts: Point[] = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (filled || y === ay || y === by || x === ax || x === bx) pts.push([x, y]);
    }
  }
  return pts;
}

/** Ellipse inscribed in the inclusive box (x0,y0)-(x1,y1). Produces clean pixel-art outlines. */
export function ellipsePoints(x0: number, y0: number, x1: number, y1: number, filled: boolean): Point[] {
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  const w = bx - ax + 1;
  const h = by - ay + 1;
  const cx = ax + (w - 1) / 2;
  const cy = ay + (h - 1) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const inside = (x: number, y: number) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1.0 + 1e-9;
  };
  // Sample the pixel centre, slightly shrunk so tiny ellipses still look round.
  const set = new Set<number>();
  const pts: Point[] = [];
  const add = (x: number, y: number) => {
    const k = y * 65536 + x;
    if (!set.has(k)) {
      set.add(k);
      pts.push([x, y]);
    }
  };
  for (let y = ay; y <= by; y++) {
    // Horizontal span of the ellipse at this row.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let x = ax; x <= bx; x++) {
      if (inside(x, y)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (minX === Infinity) {
      // Degenerate thin ellipse: keep the centre column so it stays connected.
      const x = Math.round(cx);
      minX = maxX = x;
    }
    if (filled) {
      for (let x = minX; x <= maxX; x++) add(x, y);
    } else {
      add(minX, y);
      add(maxX, y);
    }
  }
  if (!filled) {
    // Close gaps on the flat top/bottom by tracing per column too.
    for (let x = ax; x <= bx; x++) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (let y = ay; y <= by; y++) {
        if (inside(x, y)) {
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      if (minY === Infinity) continue;
      add(x, minY);
      add(x, maxY);
    }
  }
  return pts;
}

export function plot(b: Bitmap, pts: Iterable<Point>, c: RGBA, brush = 1): number {
  let n = 0;
  const off = Math.floor((brush - 1) / 2);
  for (const [x, y] of pts) {
    if (brush <= 1) {
      if (setPixel(b, x, y, c)) n++;
      continue;
    }
    for (let dy = 0; dy < brush; dy++) for (let dx = 0; dx < brush; dx++) if (setPixel(b, x + dx - off, y + dy - off, c)) n++;
  }
  return n;
}

/** Flood fill. With `contiguous` false every pixel matching the start color is replaced. */
export function floodFill(b: Bitmap, x: number, y: number, c: RGBA, contiguous = true): number {
  if (!inBounds(b, x, y)) return 0;
  const target = getPixel(b, x, y);
  if (colorsEqual(target, c)) return 0;
  const matches = (i: number) => {
    const a = b.data[i + 3];
    if (target[3] === 0) return a === 0;
    return b.data[i] === target[0] && b.data[i + 1] === target[1] && b.data[i + 2] === target[2] && a === target[3];
  };
  let n = 0;
  if (!contiguous) {
    for (let py = 0; py < b.height; py++)
      for (let px = 0; px < b.width; px++)
        if (matches((py * b.width + px) * 4)) {
          setPixel(b, px, py, c);
          n++;
        }
    return n;
  }
  const seen = new Uint8Array(b.width * b.height);
  const stack: number[] = [y * b.width + x];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen[p]) continue;
    seen[p] = 1;
    if (!matches(p * 4)) continue;
    const px = p % b.width;
    const py = (p - px) / b.width;
    setPixel(b, px, py, c);
    n++;
    if (px > 0) stack.push(p - 1);
    if (px < b.width - 1) stack.push(p + 1);
    if (py > 0) stack.push(p - b.width);
    if (py < b.height - 1) stack.push(p + b.width);
  }
  return n;
}

export function replaceColor(b: Bitmap, from: RGBA, to: RGBA): number {
  let n = 0;
  for (let i = 0; i < b.data.length; i += 4) {
    const px: RGBA = [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]];
    if (colorsEqual(px, from)) {
      b.data[i] = to[3] ? to[0] : 0;
      b.data[i + 1] = to[3] ? to[1] : 0;
      b.data[i + 2] = to[3] ? to[2] : 0;
      b.data[i + 3] = to[3];
      n++;
    }
  }
  return n;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function clearRect(b: Bitmap, r?: Rect): void {
  if (!r) {
    b.data.fill(0);
    return;
  }
  for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) setPixel(b, x, y, [0, 0, 0, 0]);
}

export function extractRegion(b: Bitmap, r: Rect): Bitmap {
  const out: Bitmap = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) setPixel(out, x, y, getPixel(b, r.x + x, r.y + y));
  return out;
}

/** Pastes `src` at (x,y). Mode "over" skips transparent source pixels; "replace" copies them too. */
export function pasteBitmap(dst: Bitmap, src: Bitmap, x: number, y: number, mode: 'over' | 'replace' = 'over'): void {
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      const c = getPixel(src, sx, sy);
      if (mode === 'over' && c[3] === 0) continue;
      setPixel(dst, x + sx, y + sy, c);
    }
  }
}

export function shift(b: Bitmap, dx: number, dy: number, wrap = false): void {
  const src = new Uint8ClampedArray(b.data);
  b.data.fill(0);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      let tx = x + dx;
      let ty = y + dy;
      if (wrap) {
        tx = ((tx % b.width) + b.width) % b.width;
        ty = ((ty % b.height) + b.height) % b.height;
      } else if (tx < 0 || ty < 0 || tx >= b.width || ty >= b.height) continue;
      const si = (y * b.width + x) * 4;
      const di = (ty * b.width + tx) * 4;
      b.data[di] = src[si];
      b.data[di + 1] = src[si + 1];
      b.data[di + 2] = src[si + 2];
      b.data[di + 3] = src[si + 3];
    }
  }
}

export type TransformOp = 'flip_h' | 'flip_v' | 'rotate_180' | 'rotate_cw' | 'rotate_ccw';

/**
 * Flips/rotates the whole bitmap, or only `region` when given.
 * 90° rotations require a square area.
 */
export function transform(b: Bitmap, op: TransformOp, region?: Rect): void {
  const r = region ?? { x: 0, y: 0, width: b.width, height: b.height };
  if ((op === 'rotate_cw' || op === 'rotate_ccw') && r.width !== r.height) {
    throw new Error(`90° rotation needs a square area (got ${r.width}x${r.height}); pass a square region.`);
  }
  const src = extractRegion(b, r);
  const n = r.width;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      let sx = x;
      let sy = y;
      switch (op) {
        case 'flip_h': sx = r.width - 1 - x; break;
        case 'flip_v': sy = r.height - 1 - y; break;
        case 'rotate_180': sx = r.width - 1 - x; sy = r.height - 1 - y; break;
        case 'rotate_cw': sx = y; sy = n - 1 - x; break;
        case 'rotate_ccw': sx = n - 1 - y; sy = x; break;
      }
      setPixel(b, r.x + x, r.y + y, getPixel(src, sx, sy));
    }
  }
}

/** Mirrors one half of the bitmap onto the other (for symmetric characters). */
export function mirror(b: Bitmap, direction: 'left_to_right' | 'right_to_left' | 'top_to_bottom' | 'bottom_to_top'): void {
  const W = b.width;
  const H = b.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      switch (direction) {
        case 'left_to_right': if (x >= W / 2) setPixel(b, x, y, getPixel(b, W - 1 - x, y)); break;
        case 'right_to_left': if (x < Math.floor(W / 2)) setPixel(b, x, y, getPixel(b, W - 1 - x, y)); break;
        case 'top_to_bottom': if (y >= H / 2) setPixel(b, x, y, getPixel(b, x, H - 1 - y)); break;
        case 'bottom_to_top': if (y < Math.floor(H / 2)) setPixel(b, x, y, getPixel(b, x, H - 1 - y)); break;
      }
    }
  }
}

/** Draws an outline in transparent pixels that touch opaque ones. */
export function outline(b: Bitmap, c: RGBA, diagonals = false): number {
  const src = new Uint8ClampedArray(b.data);
  const opaque = (x: number, y: number) => inBounds(b, x, y) && src[(y * b.width + x) * 4 + 3] > 0;
  const dirs: Point[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (diagonals) dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (opaque(x, y)) continue;
      if (dirs.some(([dx, dy]) => opaque(x + dx, y + dy))) {
        setPixel(b, x, y, c);
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Text grids: the main way an LLM draws and reads pixel art.

export interface GridDrawResult {
  changed: number;
  skipped: number;
}

/**
 * Stamps a character grid. Each char maps through `legend` to a color.
 * Chars missing from the legend: "." and " " leave the pixel unchanged; anything else is an error.
 */
export function drawGrid(
  b: Bitmap,
  x0: number,
  y0: number,
  rows: string[],
  legend: Record<string, RGBA>,
): GridDrawResult {
  let changed = 0;
  let skipped = 0;
  rows.forEach((row, ry) => {
    const chars = Array.from(row);
    chars.forEach((ch, rx) => {
      const c = legend[ch];
      if (!c) {
        if (ch === '.' || ch === ' ') return;
        throw new Error(`Character "${ch}" at row ${ry}, col ${rx} is not in the legend`);
      }
      if (setPixel(b, x0 + rx, y0 + ry, c)) changed++;
      else skipped++;
    });
  });
  return { changed, skipped };
}

const GRID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@$%&*+=?!<>~^';

/**
 * Reads a region back as a character grid. "." is transparent; other colors get letters,
 * preferring a stable char per palette index when a palette is provided.
 */
export function readGrid(b: Bitmap, r: Rect, palette: readonly string[] = []): { rows: string[]; legend: Record<string, string> } {
  const legend: Record<string, string> = {};
  const byHex = new Map<string, string>();
  palette.forEach((hex, i) => {
    if (i < GRID_CHARS.length) byHex.set(toHex(parseColor(hex)), GRID_CHARS[i]);
  });
  const used = new Set(byHex.values());
  let next = 0;
  const charFor = (hex: string) => {
    let ch = byHex.get(hex);
    if (!ch) {
      while (next < GRID_CHARS.length && used.has(GRID_CHARS[next])) next++;
      ch = next < GRID_CHARS.length ? GRID_CHARS[next++] : '#';
      byHex.set(hex, ch);
      used.add(ch);
    }
    legend[ch] = hex;
    return ch;
  };
  const rows: string[] = [];
  for (let y = r.y; y < r.y + r.height; y++) {
    let row = '';
    for (let x = r.x; x < r.x + r.width; x++) {
      const c = getPixel(b, x, y);
      row += c[3] === 0 ? '.' : charFor(toHex(c));
    }
    rows.push(row);
  }
  return { rows, legend };
}

/** Distinct colors used in a bitmap, most frequent first. */
export function colorHistogram(b: Bitmap): { color: string; count: number }[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < b.data.length; i += 4) {
    if (b.data[i + 3] === 0) continue;
    const hex = toHex([b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts].map(([color, count]) => ({ color, count })).sort((a, b) => b.count - a.count);
}

/** Bounding box of non-transparent pixels, or null if empty. */
export function contentBounds(b: Bitmap): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (b.data[(y * b.width + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Nearest-neighbour upscale by an integer factor. */
export function scaleBitmap(b: Bitmap, factor: number): Bitmap {
  if (factor === 1) return b;
  const w = b.width * factor;
  const h = b.height * factor;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < w; x++) {
      const si = (sy * b.width + Math.floor(x / factor)) * 4;
      const di = (y * w + x) * 4;
      data[di] = b.data[si];
      data[di + 1] = b.data[si + 1];
      data[di + 2] = b.data[si + 2];
      data[di + 3] = b.data[si + 3];
    }
  }
  return { width: w, height: h, data };
}
