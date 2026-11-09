import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Bitmap, type PoseGuide, type Sprite, compositeFrame, compositeInto, createSprite, getCel, tagSequence } from '../core/sprite.js';
import { parseColor } from '../core/color.js';
import { base64ToBytes } from '../core/base64.js';
import { scaleBitmap } from '../core/draw.js';
import { type SheetOptions, buildSpritesheet, sliceImage } from '../core/sheet.js';
import { decodePng, encodePng } from './png.js';
import { renameSpriteRefs } from '../core/game/refactor.js';
import type { Workspace } from './store.js';

export interface ImportOptions {
  frameWidth?: number;
  frameHeight?: number;
  /** Frame duration in ms for every imported frame. */
  duration?: number;
}

/** Creates a sprite from a PNG; a spritesheet is sliced into frames when a frame size is given. */
/** Reads a picture as a bitmap: PNG directly, other formats (WebP, JPEG) through the system converter on macOS. */
export function readPicture(file: string): Bitmap {
  const full = path.resolve(file);
  const data = fs.readFileSync(full);
  if (data.subarray(1, 4).toString('latin1') === 'PNG') return decodePng(data);
  if (process.platform !== 'darwin') throw new Error(`${path.basename(full)} is not a PNG: convert it first`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-art-'));
  try {
    const out = path.join(dir, 'picture.png');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', full, '--out', out], { stdio: 'ignore' });
    return decodePng(fs.readFileSync(out));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function spriteFromPng(name: string, png: Buffer, opts: ImportOptions = {}): Sprite {
  const img = decodePng(png);
  const fw = opts.frameWidth ?? img.width;
  const fh = opts.frameHeight ?? img.height;
  const cells = sliceImage(img, fw, fh);
  if (!cells.length) throw new Error(`Frame size ${fw}x${fh} does not fit in a ${img.width}x${img.height} image`);
  const sprite = createSprite({ name, width: fw, height: fh, frameDuration: opts.duration });
  const layer = sprite.layers[0];
  cells.forEach((cell, i) => {
    if (i > 0) sprite.frames.push({ id: Math.random().toString(36).slice(2, 10), duration: sprite.frames[0].duration });
    getCel(sprite, layer.id, sprite.frames[i].id, true).set(cell.data);
  });
  return sprite;
}

export interface ExportResult {
  png: string;
  json: string;
  width: number;
  height: number;
  frames: number;
}

/** Writes `<base>.png` and `<base>.json` (Aseprite array format). */
export function exportSpritesheet(ws: Workspace, sprite: Sprite, opts: SheetOptions & { outDir?: string; baseName?: string } = {}): ExportResult {
  const outDir = path.resolve(opts.outDir ?? ws.exportDir);
  fs.mkdirSync(outDir, { recursive: true });
  const base = opts.baseName ?? (opts.tag ? `${sprite.name}_${opts.tag}` : sprite.name);
  const { image, meta } = buildSpritesheet(sprite, { ...opts, imageName: `${base}.png` });
  const pngPath = path.join(outDir, `${base}.png`);
  const jsonPath = path.join(outDir, `${base}.json`);
  fs.writeFileSync(pngPath, encodePng(image));
  fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
  return { png: pngPath, json: jsonPath, width: image.width, height: image.height, frames: meta.frames.length };
}

export interface PreviewOptions {
  /** Frame indices to show side by side. */
  frames?: number[];
  /** Show every frame of this tag in playback order. */
  tag?: string;
  /** One row per tag, frames in playback order. */
  tags?: string[];
  /** Integer zoom; defaults to a size that makes pixels easy to see. */
  scale?: number;
  /** "checker" (default), "transparent" or a color. */
  background?: string;
  /** Draw thin lines between pixels (only when zoomed in enough). */
  pixelGrid?: boolean;
  /** Coordinate labels on the top and left edge of every cell, with a darker grid line at each label. */
  rulers?: boolean;
  /** Only show this canvas region (zoomed in); rulers keep canvas coordinates. */
  region?: { x: number; y: number; width: number; height: number };
  /** Show the previous frame of the row tinted red under each frame. */
  onion?: boolean;
  /** Highlight in magenta the pixels that changed since the previous frame of the row. */
  diff?: boolean;
  /** Add the reference image as the first cell of every row. */
  compare?: boolean;
  /** Draw the reference under the art at this opacity (0..1). */
  underlay?: number;
  /** Draw the sprite's pose guide (skeleton) over every cell. */
  guide?: boolean;
  /** Restrict to a single layer id. */
  layerId?: string;
}

function crop(b: Bitmap, r: { x: number; y: number; width: number; height: number }): Bitmap {
  const out: Bitmap = { width: r.width, height: r.height, data: new Uint8ClampedArray(r.width * r.height * 4) };
  for (let y = 0; y < r.height; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= b.height) continue;
    for (let x = 0; x < r.width; x++) {
      const sx = r.x + x;
      if (sx < 0 || sx >= b.width) continue;
      out.data.set(b.data.subarray((sy * b.width + sx) * 4, (sy * b.width + sx) * 4 + 4), (y * r.width + x) * 4);
    }
  }
  return out;
}

/** The sprite's reference image placed on a canvas-sized bitmap (empty when there is none). */
export function referenceBitmap(sprite: Sprite): Bitmap {
  const out: Bitmap = { width: sprite.width, height: sprite.height, data: new Uint8ClampedArray(sprite.width * sprite.height * 4) };
  const ref = sprite.reference;
  if (!ref) return out;
  const bytes = base64ToBytes(ref.pixels);
  const src: Bitmap = { width: ref.width, height: ref.height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length) };
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const tx = ref.x + x;
      const ty = ref.y + y;
      if (tx < 0 || ty < 0 || tx >= out.width || ty >= out.height) continue;
      out.data.set(src.data.subarray((y * src.width + x) * 4, (y * src.width + x) * 4 + 4), (ty * out.width + tx) * 4);
    }
  return out;
}

/**
 * How much of each canvas pixel the reference figure covers (0..1), measured on the high-resolution source with
 * 4x4 samples per pixel. Thin details (hair spikes, straps) keep a partial coverage instead of vanishing.
 */
export function referenceCoverage(sprite: Sprite): Float32Array {
  const W = sprite.width;
  const H = sprite.height;
  const cov = new Float32Array(W * H);
  const ref = sprite.reference;
  if (!ref) return cov;
  if (!ref.source) {
    const bmp = referenceBitmap(sprite);
    for (let i = 0; i < W * H; i++) cov[i] = bmp.data[i * 4 + 3] / 255;
    return cov;
  }
  const bytes = base64ToBytes(ref.source.pixels);
  const src = ref.source;
  const fx = src.width / ref.width;
  const fy = src.height / ref.height;
  const S = 4;
  for (let ly = 0; ly < ref.height; ly++) {
    for (let lx = 0; lx < ref.width; lx++) {
      const cx = ref.x + lx;
      const cy = ref.y + ly;
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
      let hit = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const px = Math.min(src.width - 1, Math.floor((lx + (sx + 0.5) / S) * fx));
          const py = Math.min(src.height - 1, Math.floor((ly + (sy + 0.5) / S) * fy));
          if (bytes[(py * src.width + px) * 4 + 3] >= 128) hit++;
        }
      cov[cy * W + cx] = hit / (S * S);
    }
  }
  return cov;
}

function tinted(b: Bitmap, c: [number, number, number], alpha: number): Bitmap {
  const out: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data.length) };
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3]) out.data.set([c[0], c[1], c[2], alpha], i);
  return out;
}

function withOpacity(b: Bitmap, opacity: number): Bitmap {
  const out: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i] * opacity;
  return out;
}

/** Renders frames side by side (one row per tag when `tags` is given), zoomed, for Claude (or a human) to look at. */
export function renderPreview(sprite: Sprite, opts: PreviewOptions = {}): { image: Bitmap; scale: number; frames: number[] } {
  const rows: number[][] = [];
  if (opts.tags?.length) {
    for (const name of opts.tags) {
      const tag = sprite.tags.find((t) => t.name === name);
      if (!tag) throw new Error(`No tag named "${name}". Tags: ${sprite.tags.map((t) => t.name).join(', ') || 'none'}`);
      rows.push(tagSequence(tag));
    }
  } else if (opts.frames?.length) rows.push(opts.frames);
  else if (opts.tag) {
    const tag = sprite.tags.find((t) => t.name === opts.tag);
    if (!tag) throw new Error(`No tag named "${opts.tag}"`);
    rows.push(tagSequence(tag));
  } else rows.push([0]);
  if ((opts.compare || opts.underlay) && !sprite.reference) throw new Error('This sprite has no reference image (use set_reference)');
  const region = opts.region ?? { x: 0, y: 0, width: sprite.width, height: sprite.height };
  const layerOpts = opts.layerId ? { layerIds: [opts.layerId], includeHidden: true } : {};
  const ref = sprite.reference ? crop(referenceBitmap(sprite), region) : null;
  const cells = rows.map((r) => {
    const frames = r.map((f) => crop(compositeFrame(sprite, f, layerOpts), region));
    const out = frames.map((cur, i) => {
      const prev = frames.length > 1 ? frames[(i - 1 + frames.length) % frames.length] : null;
      const cell: Bitmap = { width: cur.width, height: cur.height, data: new Uint8ClampedArray(cur.data.length) };
      if (opts.underlay && ref) compositeInto(cell.data, withOpacity(ref, opts.underlay).data);
      if (opts.onion && prev) compositeInto(cell.data, tinted(prev, [255, 40, 90], 80).data);
      compositeInto(cell.data, cur.data);
      if (opts.diff && prev) {
        const mark: Bitmap = { width: cur.width, height: cur.height, data: new Uint8ClampedArray(cur.data.length) };
        for (let p = 0; p < cur.data.length; p += 4) {
          const changed = cur.data[p] !== prev.data[p] || cur.data[p + 1] !== prev.data[p + 1] || cur.data[p + 2] !== prev.data[p + 2] || cur.data[p + 3] !== prev.data[p + 3];
          if (changed) mark.data.set([255, 0, 255, 150], p);
        }
        compositeInto(cell.data, mark.data);
      }
      return cell;
    });
    return opts.compare && ref ? [ref, ...out] : out;
  });
  if (opts.guide && !sprite.guide) throw new Error('This sprite has no pose guide (use pose_guide)');
  const { image, scale } = renderBitmapRows(sprite, cells, { ...opts, origin: [region.x, region.y], guide: opts.guide ? sprite.guide! : undefined });
  return { image, scale, frames: rows.flat() };
}

// 3x5 digits for ruler labels.
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'], '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'], '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'], '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'], '-': ['000', '000', '111', '000', '000'],
};

function drawLabel(img: Bitmap, x: number, y: number, text: string, color: [number, number, number]): void {
  [...text].forEach((ch, ci) => {
    const g = DIGITS[ch];
    if (!g) return;
    for (let gy = 0; gy < 5; gy++)
      for (let gx = 0; gx < 3; gx++) {
        if (g[gy][gx] !== '1') continue;
        for (let k = 0; k < 4; k++) {
          const px = x + ci * 8 + gx * 2 + (k & 1);
          const py = y + gy * 2 + (k >> 1);
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          img.data.set([color[0], color[1], color[2], 255], (py * img.width + px) * 4);
        }
      }
  });
}

/** Lays out bitmaps (all the same size) in rows, zoomed, on a background, optionally with coordinate rulers. */
export function renderBitmapRows(
  sprite: Sprite,
  rows: Bitmap[][],
  opts: Pick<PreviewOptions, 'scale' | 'background' | 'pixelGrid' | 'rulers'> & { origin?: [number, number]; guide?: PoseGuide } = {},
): { image: Bitmap; scale: number } {
  const cols = Math.max(...rows.map((r) => r.length));
  const cw = rows[0][0].width;
  const ch = rows[0][0].height;
  const [ox0, oy0] = opts.origin ?? [0, 0];
  const maxDim = Math.max(cw, ch);
  // Keep big multi-frame previews readable without producing huge images.
  const fit = Math.max(1, Math.floor(1800 / (cols * cw)));
  const auto = Math.min(Math.max(1, Math.floor(384 / maxDim)), fit);
  const scale = Math.max(1, Math.min(32, Math.floor(opts.scale ?? auto)));
  const rulers = !!opts.rulers;
  const step = scale >= 16 ? 4 : scale >= 4 ? 8 : 16;
  const digits = String(Math.max(ox0 + cw, oy0 + ch)).length + (ox0 < 0 || oy0 < 0 ? 1 : 0);
  const ml = rulers ? digits * 8 + 6 : 0;
  const mt = rulers ? 14 : 0;
  const gap = cols > 1 || rows.length > 1 ? Math.max(4, scale * 2) : 0;
  const fw = cw * scale;
  const fh = ch * scale;
  const width = cols * (fw + ml) + (cols - 1) * gap;
  const height = rows.length * (fh + mt) + (rows.length - 1) * gap;
  const image: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const bg = opts.background ?? 'checker';
  const ink: [number, number, number] = [70, 70, 90];
  rows.forEach((row, ri) => {
    row.forEach((bmp, i) => {
      const cx = i * (fw + ml + gap);
      const cy = ri * (fh + mt + gap);
      const ox = cx + ml;
      const oy = cy + mt;
      if (rulers) {
        for (let y = cy; y < cy + mt + fh; y++) for (let x = cx; x < cx + ml + fw; x++) image.data.set([250, 250, 252, 255], (y * width + x) * 4);
        for (let v = Math.ceil(ox0 / step) * step; v < ox0 + cw; v += step) drawLabel(image, ox + (v - ox0) * scale, cy + 2, String(v), ink);
        for (let v = Math.ceil(oy0 / step) * step; v < oy0 + ch; v += step) {
          const t = String(v);
          drawLabel(image, cx + ml - 3 - t.length * 8, oy + (v - oy0) * scale + Math.max(0, Math.floor((scale - 10) / 2)), t, ink);
        }
      }
      if (bg !== 'transparent') fillBackground(image, ox, oy, fw, fh, bg, scale);
      blendOnto(image, scaleBitmap(bmp, scale), ox, oy);
      if ((opts.pixelGrid || rulers) && scale >= 6) drawPixelGrid(image, ox, oy, fw, fh, scale, sprite, [ox0, oy0], rulers ? step : 0, !!opts.pixelGrid);
      if (opts.guide) drawGuide(image, opts.guide, ox, oy, fw, fh, scale, [ox0, oy0]);
    });
  });
  return { image, scale };
}

function guideColor(a: string, b: string): [number, number, number] {
  const side = (n: string) => (/_f$|_front$/.test(n) ? 'f' : /_b$|_back$/.test(n) ? 'b' : '');
  const s = side(a) || side(b);
  return s === 'f' ? [34, 224, 255] : s === 'b' ? [255, 160, 48] : [255, 255, 255];
}

/** Skeleton overlay in screen pixels (stays thin at any zoom), clipped to the cell. */
function drawGuide(img: Bitmap, g: PoseGuide, ox: number, oy: number, fw: number, fh: number, scale: number, origin: [number, number]): void {
  const at = (j: [number, number]): [number, number] => [ox + (j[0] - origin[0] + 0.5) * scale, oy + (j[1] - origin[1] + 0.5) * scale];
  const dot = (cx: number, cy: number, r: number, c: [number, number, number]) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (x < ox || y < oy || x >= ox + fw || y >= oy + fh) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        img.data.set([c[0], c[1], c[2], 255], (y * img.width + x) * 4);
      }
  };
  const w = Math.max(1, scale / 6);
  for (const pass of [0, 1]) {
    for (const [a, b] of g.bones) {
      const ja = g.joints[a];
      const jb = g.joints[b];
      if (!ja || !jb) continue;
      const [x0, y0] = at(ja);
      const [x1, y1] = at(jb);
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
      const c = pass ? guideColor(a, b) : ([20, 16, 32] as [number, number, number]);
      for (let i = 0; i <= n; i++) dot(x0 + ((x1 - x0) * i) / Math.max(1, n), y0 + ((y1 - y0) * i) / Math.max(1, n), pass ? w : w + 1.5, c);
    }
    for (const [name, j] of Object.entries(g.joints)) {
      const [x, y] = at(j);
      dot(x, y, pass ? w * 1.8 : w * 1.8 + 1.5, pass ? guideColor(name, name) : [20, 16, 32]);
    }
  }
}

/** Alpha-blends `src` onto `dst` at (ox, oy) so semi-transparent pixels (shadows, glows) look as they will in a game. */
function blendOnto(dst: Bitmap, src: Bitmap, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= dst.height) continue;
    const row = new Uint8ClampedArray(src.data.buffer, src.data.byteOffset + y * src.width * 4, src.width * 4);
    const start = (ty * dst.width + ox) * 4;
    compositeInto(dst.data.subarray(start, start + src.width * 4), row);
  }
}

function fillBackground(img: Bitmap, ox: number, oy: number, w: number, h: number, bg: string, scale: number): void {
  const checker = bg === 'checker';
  const a = checker ? [236, 236, 240] : parseColor(bg);
  const b = checker ? [200, 200, 208] : a;
  // Checker squares are 4 sprite pixels wide so they never look like sprite pixels.
  const sq = scale * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = (Math.floor(x / sq) + Math.floor(y / sq)) % 2 ? b : a;
      const i = ((oy + y) * img.width + ox + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
}

function drawPixelGrid(img: Bitmap, ox: number, oy: number, fw: number, fh: number, scale: number, s: Sprite, origin: [number, number], every: number, minor: boolean): void {
  const tw = s.grid?.width ?? 0;
  const th = s.grid?.height ?? 0;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const onX = x % scale === 0;
      const onY = y % scale === 0;
      if (!onX && !onY) continue;
      const px = x / scale + origin[0];
      const py = y / scale + origin[1];
      const major =
        (onX && tw > 0 && px % tw === 0) || (onY && th > 0 && py % th === 0) || (every > 0 && ((onX && px % every === 0) || (onY && py % every === 0)));
      if (!major && !minor) continue;
      const i = ((oy + y) * img.width + ox + x) * 4;
      const k = major ? 0.45 : 0.82;
      img.data[i] = img.data[i] * k;
      img.data[i + 1] = img.data[i + 1] * k;
      img.data[i + 2] = img.data[i + 2] * k;
      img.data[i + 3] = Math.max(img.data[i + 3], major ? 200 : 60);
    }
  }
}

export function previewPng(sprite: Sprite, opts: PreviewOptions = {}): Buffer {
  return encodePng(renderPreview(sprite, opts).image);
}

/** Renames a sprite and points the game at the new name (scripts are code, and are reported rather than rewritten). */
export function renameSpriteEverywhere(ws: Workspace, from: string, to: string, updatedBy: string): { sprite: Sprite; scenes: string[]; effects: string[]; scripts: string[] } {
  const sprite = ws.rename(from, to);
  const scenes = ws.listScenes().map((x) => ws.loadScene(x.name));
  let sceneNames: string[] = [];
  if (ws.hasGame()) {
    const game = ws.loadGame();
    const changed = renameSpriteRefs(game, scenes, from, to);
    if (changed.game) ws.saveGame(game, updatedBy);
    for (const sc of changed.scenes) ws.saveScene(sc, updatedBy);
    sceneNames = changed.scenes.map((sc) => sc.name);
  }
  const effects: string[] = [];
  for (const { name } of ws.listVfx()) {
    const g = ws.loadVfx(name);
    let touched = false;
    for (const n of g.nodes) {
      if ((n.params as Record<string, unknown>).sprite === from) {
        (n.params as Record<string, unknown>).sprite = to;
        touched = true;
      }
    }
    if (touched) {
      ws.saveVfx(g, updatedBy);
      effects.push(name);
    }
  }
  const quoted = new RegExp(`(["'\`])${from}\\1`);
  const scripts = Object.entries(ws.loadScripts()).filter(([, code]) => quoted.test(code)).map(([file]) => file);
  return { sprite, scenes: sceneNames, effects, scripts };
}
