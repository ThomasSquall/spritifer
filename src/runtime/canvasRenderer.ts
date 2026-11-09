/**
 * Canvas 2D implementation of the engine Renderer, with the atmosphere passes (lighting, grade, vignette).
 * Shared by the game player and the scene editor's atmosphere preview, so both draw the same light.
 */

import type { Renderer } from '../core/game/engine.js';
import type { CastShape, ScreenLight } from '../core/game/atmosphere.js';
import type { HdFrame } from '../core/game/hd.js';
import { BUILTIN_FONT, type PixelFont, fontPixelSize, rasterText, textBitmapSize } from '../core/game/font.js';
import { type ResolvedRelief, frameTilt, normalSheetFor, reliefKind, shadeRelief } from '../core/game/relief.js';
import type { ReflectionBand, WaterPiece } from '../core/game/reflections.js';
import type { SpriteAsset } from '../core/game/types.js';

interface NormalSheet {
  data: Uint8ClampedArray;
  /** The same bytes as one number per pixel, for copying. */
  pixels: Uint32Array;
  width: number;
}

export class CanvasRenderer implements Renderer {
  private textCache = new Map<string, HTMLCanvasElement>();
  constructor(private ctx: CanvasRenderingContext2D, private images: Map<string, CanvasImageSource>, private w: number, private h: number) {}

  /** Set by the player only while 2D-HD is on. */
  endWorld?: (frame: HdFrame | null) => void;

  clear(color: string): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number; flat?: boolean; white?: number }): void {
    const img = this.images.get(sprite);
    if (!img) return;
    this.captureNormals(sprite, sx, sy, sw, sh, dx, dy, o);
    const c = this.ctx;
    const k = o.scale ?? 1;
    if (o.white) {
      const sheet = this.whiteSheet(sprite, img);
      this.image(sprite, sx, sy, sw, sh, dx, dy, { ...o, white: 0 });
      c.save();
      c.globalAlpha = o.opacity * Math.min(1, o.white);
      c.translate(dx + (sw * k) / 2, dy + (sh * k) / 2);
      if (o.flipX) c.scale(-1, 1);
      c.drawImage(sheet, sx, sy, sw, sh, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
      c.restore();
      return;
    }
    if (!o.flipX && !o.angle && o.opacity >= 1) {
      c.drawImage(img, sx, sy, sw, sh, dx, dy, sw * k, sh * k);
      return;
    }
    c.save();
    c.globalAlpha = o.opacity;
    c.translate(dx + (sw * k) / 2, dy + (sh * k) / 2);
    if (o.angle) c.rotate((o.angle * Math.PI) / 180);
    if (o.flipX) c.scale(-1, 1);
    c.drawImage(img, sx, sy, sw, sh, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
    c.restore();
  }

  private whiteSheets = new Map<string, HTMLCanvasElement>();

  /** The sprite's sheet in solid white, made once: a character lit by a blow. */
  private whiteSheet(sprite: string, img: CanvasImageSource): HTMLCanvasElement {
    let sheet = this.whiteSheets.get(sprite);
    if (sheet) return sheet;
    sheet = document.createElement('canvas');
    const source = img as HTMLImageElement | HTMLCanvasElement;
    sheet.width = (source as HTMLImageElement).naturalWidth || source.width;
    sheet.height = (source as HTMLImageElement).naturalHeight || source.height;
    const g = sheet.getContext('2d')!;
    g.drawImage(img, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, sheet.width, sheet.height);
    this.whiteSheets.set(sprite, sheet);
    return sheet;
  }

  private waterLayers: { picture: HTMLCanvasElement; mask: HTMLCanvasElement } | null = null;
  private waterMasks = new Map<string, HTMLCanvasElement>();
  private sheetPixels = new Map<string, { data: Uint8ClampedArray; width: number } | null>();

  /** Which pixels of a patch of the sheet are water. */
  waterMask(piece: WaterPiece): HTMLCanvasElement | null {
    const key = `${piece.sprite}|${piece.sources.join()}`;
    let mask = this.waterMasks.get(key);
    if (mask) return mask;
    let sheet = this.sheetPixels.get(piece.sprite);
    if (sheet === undefined) {
      const img = this.images.get(piece.sprite) as HTMLImageElement | HTMLCanvasElement | undefined;
      sheet = img ? this.readImage(img) : null;
      this.sheetPixels.set(piece.sprite, sheet);
    }
    if (!sheet) return null;
    const { data, width } = sheet;
    mask = document.createElement('canvas');
    mask.width = piece.sw;
    mask.height = piece.sh;
    const g = mask.getContext('2d')!;
    g.fillStyle = '#ffffff';
    const s = piece.sources;
    for (let y = 0; y < piece.sh; y++) {
      for (let x = 0; x < piece.sw; x++) {
        const at = (k: number) => ((s[k + 1]! + y) * width + s[k]! + x) * 4;
        let water = s.length === 2 && data[at(0) + 3]! > 0;
        for (let k = 2; k < s.length && !water; k += 2) {
          const a = at(0);
          const b = at(k);
          water = data[a]! !== data[b]! || data[a + 1]! !== data[b + 1]! || data[a + 2]! !== data[b + 2]!;
        }
        if (water) g.fillRect(x, y, 1, 1);
      }
    }
    this.waterMasks.set(key, mask);
    return mask;
  }

  reflections(water: WaterPiece[], bands: ReflectionBand[], zoom: number): void {
    if (!this.waterLayers) {
      const make = () => {
        const canvas = document.createElement('canvas');
        canvas.width = this.w;
        canvas.height = this.h;
        return canvas;
      };
      this.waterLayers = { picture: make(), mask: make() };
    }
    const { picture, mask } = this.waterLayers;
    const m = mask.getContext('2d')!;
    m.imageSmoothingEnabled = false;
    m.clearRect(0, 0, this.w, this.h);
    for (const p of water) {
      const tile = this.waterMask(p);
      if (tile) m.drawImage(tile, p.x, p.y, p.sw * zoom, p.sh * zoom);
    }
    const g = picture.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.w, this.h);
    for (const b of bands) {
      const img = this.images.get(b.sprite);
      if (!img) continue;
      g.globalAlpha = b.alpha;
      // Upside down, and mirrored as the sprite itself is.
      g.setTransform(b.flipX ? -1 : 1, 0, 0, -1, b.flipX ? b.dx + b.sw * zoom : b.dx, b.dy + b.sh * zoom);
      g.drawImage(img, b.sx, b.sy, b.sw, b.sh, 0, 0, b.sw * zoom, b.sh * zoom);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0);
    g.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
    this.ctx.drawImage(picture, 0, 0);
  }

  private offWaterLayers: { layer: HTMLCanvasElement; mask: HTMLCanvasElement } | null = null;

  offWater(water: WaterPiece[], dry: WaterPiece[], zoom: number, draw: () => void): void {
    if (!this.offWaterLayers) {
      const make = () => {
        const canvas = document.createElement('canvas');
        canvas.width = this.w;
        canvas.height = this.h;
        return canvas;
      };
      this.offWaterLayers = { layer: make(), mask: make() };
    }
    const { layer, mask } = this.offWaterLayers;
    const g = layer.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, this.w, this.h);
    const main = this.ctx;
    this.ctx = g;
    try {
      draw();
    } finally {
      this.ctx = main;
    }
    // The water, less whatever lies across it.
    const m = mask.getContext('2d')!;
    m.imageSmoothingEnabled = false;
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, this.w, this.h);
    const stamp = (list: WaterPiece[]) => {
      for (const p of list) {
        const tile = this.waterMask(p);
        if (tile) m.drawImage(tile, p.x, p.y, p.sw * zoom, p.sh * zoom);
      }
    };
    stamp(water);
    m.globalCompositeOperation = 'destination-out';
    stamp(dry);
    m.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(mask, 0, 0);
    g.globalCompositeOperation = 'source-over';
    main.globalAlpha = 1;
    main.drawImage(layer, 0, 0);
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1, blend?: 'add'): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    if (blend === 'add') this.ctx.globalCompositeOperation = 'lighter';
    this.ctx.fillRect(x, y, w, h);
    if (blend === 'add') this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.globalAlpha = 1;
  }

  private relief: { assets: Record<string, SpriteAsset | undefined>; view: { width: number; height: number }; normals: Uint8ClampedArray; pixels: Uint32Array; on: boolean; tiles: boolean; dirty: boolean } | null = null;
  private normalSheets = new Map<string, NormalSheet | null>();
  private alphaMasks = new Map<string, { mask: Uint8Array; width: number } | null>();

  /** Enables per-pixel lighting. `view` is the game's screen: sprites as big as it are backdrops and stay flat. */
  useRelief(assets: Record<string, SpriteAsset | undefined>, view: { width: number; height: number }, shared?: Map<string, unknown>): this {
    if (shared) this.normalSheets = shared as Map<string, NormalSheet | null>;
    const normals = new Uint8ClampedArray(Math.max(1, this.w) * Math.max(1, this.h) * 4);
    this.relief = { assets, view, normals, pixels: new Uint32Array(normals.buffer), on: false, tiles: true, dirty: false };
    return this;
  }

  beginRelief(on: boolean, tiles = true): void {
    const rel = this.relief;
    if (!rel) return;
    rel.on = on;
    rel.tiles = tiles;
    if (on && rel.dirty) {
      rel.pixels.fill(0);
      rel.dirty = false;
    }
  }

  endRelief(): void {
    if (this.relief) this.relief.on = false;
  }

  private readImage(img: HTMLImageElement | HTMLCanvasElement): { data: Uint8ClampedArray; width: number; height: number } {
    const width = (img as HTMLImageElement).naturalWidth || img.width;
    const height = (img as HTMLImageElement).naturalHeight || img.height;
    const read = document.createElement('canvas');
    read.width = width;
    read.height = height;
    const g = read.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    return { data: g.getImageData(0, 0, width, height).data, width, height };
  }

  /** The normal sheet of a sprite, for the perspective view; null when it has none. */
  normalsOf(sprite: string): Uint8ClampedArray | null {
    return this.relief ? (this.normalSheet(sprite)?.data ?? null) : null;
  }

  /** Is the frame being drawn lit per pixel? */
  get reliefActive(): boolean {
    return !!this.relief?.on;
  }

  private normalSheet(sprite: string): NormalSheet | null {
    const rel = this.relief!;
    const asset = rel.assets[sprite];
    if (asset && !rel.tiles && reliefKind(asset, rel.view) === 'surface') return null;
    let sheet = this.normalSheets.get(sprite);
    if (sheet !== undefined) return sheet;
    sheet = null;
    const img = this.images.get(sprite) as HTMLImageElement | HTMLCanvasElement | undefined;
    if (asset && img && reliefKind(asset, rel.view)) {
      const { data: src, width, height } = this.readImage(img);
      const data = normalSheetFor(src, width, height, asset, rel.view)!;
      sheet = { data, pixels: new Uint32Array(data.buffer, data.byteOffset, data.length >> 2), width };
    }
    this.normalSheets.set(sprite, sheet);
    return sheet;
  }

  /** Which pixels of a sprite without normals are solid: it erases the normals under them. */
  alphaMask(sprite: string): { mask: Uint8Array; width: number } | null {
    let found = this.alphaMasks.get(sprite);
    if (found !== undefined) return found;
    found = null;
    const img = this.images.get(sprite) as HTMLImageElement | HTMLCanvasElement | undefined;
    if (img) {
      const { data, width, height } = this.readImage(img);
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]! > 0 ? 1 : 0;
      found = { mask, width };
    }
    this.alphaMasks.set(sprite, found);
    return found;
  }

  /** Records the normals of a drawn sprite. A sprite without them erases what it covers (a roof over a character). */
  captureNormals(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle?: number; scale?: number; flat?: boolean }): void {
    const rel = this.relief;
    if (!rel?.on || o.opacity < 1 || o.angle) return;
    const sheet = o.flat ? null : this.normalSheet(sprite);
    // Nothing recorded yet, nothing to erase: the whole ground layer ends here.
    if (!sheet && !rel.dirty) return;
    const k = o.scale ?? 1;
    const left = Math.round(dx);
    const top = Math.round(dy);
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(this.w, left + Math.round(sw * k));
    const y1 = Math.min(this.h, top + Math.round(sh * k));
    if (x0 >= x1 || y0 >= y1) return;
    const out = rel.pixels;
    const W = this.w;
    const flip = o.flipX;
    const column = (x: number) => {
      const u = Math.min(sw - 1, Math.floor((x - left) / k));
      return flip ? sx + sw - 1 - u : sx + u;
    };
    if (sheet) {
      const src = sheet.pixels;
      const SW = sheet.width;
      for (let y = y0; y < y1; y++) {
        const row = (sy + Math.min(sh - 1, Math.floor((y - top) / k))) * SW;
        let i = y * W + x0;
        for (let x = x0; x < x1; x++, i++) {
          const v = src[row + column(x)]!;
          // Mirrored, the x of the normal (the low byte) points the other way.
          if (v >>> 24) out[i] = flip ? v ^ 0xff : v;
        }
      }
      rel.dirty = true;
      return;
    }
    const alpha = this.alphaMask(sprite);
    if (!alpha) return;
    for (let y = y0; y < y1; y++) {
      const row = (sy + Math.min(sh - 1, Math.floor((y - top) / k))) * alpha.width;
      let i = y * W + x0;
      for (let x = x0; x < x1; x++, i++) if (alpha.mask[row + column(x)]) out[i] = 0;
    }
  }

  spriteMask(sprite: string, x: number, y: number, w: number, h: number): Uint8Array | null {
    if (!this.relief) return null;
    const asset = this.relief.assets[sprite];
    if (!asset || reliefKind(asset, this.relief.view) !== 'shape') return null;
    const sheet = this.normalSheet(sprite);
    return sheet ? frameTilt(sheet.data, sheet.width, x, y, w, h) : null;
  }

  reliefLighting(relief: ResolvedRelief, ambient: string, lights: ScreenLight[], glow: number): void {
    if (!this.relief) return this.lighting(ambient, lights, glow);
    const frame = this.ctx.getImageData(0, 0, this.w, this.h);
    shadeRelief(frame, this.relief.normals, relief, ambient, lights, glow);
    this.ctx.putImageData(frame, 0, 0);
  }

  private lightCanvas: HTMLCanvasElement | null = null;

  lighting(ambient: string, lights: ScreenLight[], glow: number): void {
    const c = this.ctx;
    if (!this.lightCanvas) {
      this.lightCanvas = document.createElement('canvas');
      this.lightCanvas.width = this.w;
      this.lightCanvas.height = this.h;
    }
    const g = this.lightCanvas.getContext('2d')!;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = ambient;
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
    for (const l of lights) radial(g, l.x, l.y, l.radius, l.color, Math.min(1, l.intensity));
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'multiply';
    c.drawImage(this.lightCanvas, 0, 0);
    if (glow > 0) {
      c.globalCompositeOperation = 'lighter';
      for (const l of lights) radial(c, l.x, l.y, l.radius * 0.7, l.color, Math.min(1, l.intensity * glow * 0.35));
    }
    c.restore();
  }

  grade(tint: string, amount: number): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = amount;
    c.fillStyle = tint;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
  }

  private vignetteCache: { key: string; grad: CanvasGradient } | null = null;

  vignette(strength: number, color: string): void {
    const c = this.ctx;
    const key = `${strength}|${color}`;
    if (this.vignetteCache?.key !== key) {
      const cx = this.w / 2;
      const cy = this.h / 2;
      const r = Math.hypot(cx, cy);
      const grad = c.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
      grad.addColorStop(0, withAlpha(color, 0));
      grad.addColorStop(1, withAlpha(color, strength));
      this.vignetteCache = { key, grad };
    }
    c.save();
    c.globalAlpha = 1;
    c.fillStyle = this.vignetteCache.grad;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
  }

  private stamps = new WeakMap<CastShape, { color: string; canvas: HTMLCanvasElement }>();

  /** A cast shadow is painted once on its own canvas, then drawn with one call instead of one rectangle per row. */
  stamp(shape: CastShape, x: number, y: number, zoom: number, color: string, alpha: number, slice?: { row: number; rows: number }): void {
    let entry = this.stamps.get(shape);
    if (!entry || entry.color !== color) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, shape.width);
      canvas.height = Math.max(1, shape.height);
      const g = canvas.getContext('2d')!;
      g.fillStyle = color;
      for (let i = 0; i < shape.runs.length; i += 3) g.fillRect(shape.runs[i]!, shape.runs[i + 1]!, shape.runs[i + 2]!, 1);
      this.stamps.set(shape, (entry = { color, canvas }));
    }
    const c = this.ctx;
    c.globalAlpha = alpha;
    const row = slice?.row ?? 0;
    const rows = slice?.rows ?? shape.height;
    c.drawImage(entry.canvas, 0, row, shape.width, rows, x, y + row * zoom, shape.width * zoom, rows * zoom);
    c.globalAlpha = 1;
  }

  text(text: string, x: number, y: number, color: string, scale: number, font: PixelFont = BUILTIN_FONT): void {
    const key = font.id + '\u0000' + color + '\u0000' + text;
    const size = textBitmapSize(text, font);
    let cv = this.textCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = size.width;
      cv.height = size.height;
      const g = cv.getContext('2d')!;
      g.fillStyle = color;
      rasterText(text, (px, py) => g.fillRect(px, py + size.top, 1, 1), font);
      if (this.textCache.size > 400) this.textCache.clear();
      this.textCache.set(key, cv);
    }
    const p = fontPixelSize(font, scale);
    this.ctx.drawImage(cv, Math.round(x), Math.round(y) - size.top * p, cv.width * p, cv.height * p);
  }
}

/** "#rgb" / "#rrggbb" with an alpha, as an rgba() string. */
function withAlpha(color: string, a: number): string {
  let h = color.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

/** Additive light blob with a (1 - d/r)^2 falloff, like the bitmap renderer. */
function radial(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, k: number): void {
  if (r <= 0 || k <= 0) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) grad.addColorStop(t, withAlpha(color, k * (1 - t) * (1 - t)));
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}
