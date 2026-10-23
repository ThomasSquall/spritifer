import fs from 'node:fs';
import path from 'node:path';
import { type Bitmap, type Sprite, compositeFrame, createSprite, getCel, tagSequence } from '../core/sprite.js';
import { parseColor } from '../core/color.js';
import { pasteBitmap, scaleBitmap } from '../core/draw.js';
import { type SheetOptions, buildSpritesheet, sliceImage } from '../core/sheet.js';
import { decodePng, encodePng } from './png.js';
import type { Workspace } from './store.js';

export interface ImportOptions {
  frameWidth?: number;
  frameHeight?: number;
  /** Frame duration in ms for every imported frame. */
  duration?: number;
}

/** Creates a sprite from a PNG; a spritesheet is sliced into frames when a frame size is given. */
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
  /** Integer zoom; defaults to a size that makes pixels easy to see. */
  scale?: number;
  /** "checker" (default), "transparent" or a color. */
  background?: string;
  /** Draw thin lines between pixels (only when zoomed in enough). */
  pixelGrid?: boolean;
  /** Restrict to a single layer id. */
  layerId?: string;
}

/** Renders frames side by side, zoomed, for Claude (or a human) to look at. */
export function renderPreview(sprite: Sprite, opts: PreviewOptions = {}): { image: Bitmap; scale: number; frames: number[] } {
  let frames = opts.frames;
  if (!frames?.length) {
    if (opts.tag) {
      const tag = sprite.tags.find((t) => t.name === opts.tag);
      if (!tag) throw new Error(`No tag named "${opts.tag}"`);
      frames = tagSequence(tag);
    } else frames = [0];
  }
  const maxDim = Math.max(sprite.width, sprite.height);
  const scale = Math.max(1, Math.min(32, Math.floor(opts.scale ?? Math.max(1, Math.floor(384 / maxDim)))));
  const gap = frames.length > 1 ? Math.max(4, scale * 2) : 0;
  const fw = sprite.width * scale;
  const fh = sprite.height * scale;
  const width = frames.length * fw + (frames.length - 1) * gap;
  const image: Bitmap = { width, height: fh, data: new Uint8ClampedArray(width * fh * 4) };

  const bg = opts.background ?? 'checker';
  frames.forEach((f, i) => {
    const ox = i * (fw + gap);
    if (bg !== 'transparent') fillBackground(image, ox, 0, fw, fh, bg, scale);
    const comp = compositeFrame(sprite, f, opts.layerId ? { layerIds: [opts.layerId], includeHidden: true } : {});
    pasteBitmap(image, scaleBitmap(comp, scale), ox, 0, 'over');
    if (opts.pixelGrid && scale >= 6) drawPixelGrid(image, ox, fw, fh, scale, sprite);
  });
  return { image, scale, frames };
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

function drawPixelGrid(img: Bitmap, ox: number, fw: number, fh: number, scale: number, s: Sprite): void {
  const tw = s.grid?.width ?? 0;
  const th = s.grid?.height ?? 0;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const onX = x % scale === 0;
      const onY = y % scale === 0;
      if (!onX && !onY) continue;
      const px = x / scale;
      const py = y / scale;
      const major = (onX && tw > 0 && px % tw === 0) || (onY && th > 0 && py % th === 0);
      const i = (y * img.width + ox + x) * 4;
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
