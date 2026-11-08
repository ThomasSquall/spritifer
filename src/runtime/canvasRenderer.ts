/**
 * Canvas 2D implementation of the engine Renderer, with the atmosphere passes (lighting, grade, vignette).
 * Shared by the game player and the scene editor's atmosphere preview, so both draw the same light.
 */

import type { Renderer } from '../core/game/engine.js';
import type { CastShape, ScreenLight } from '../core/game/atmosphere.js';
import { rasterText } from '../core/game/font.js';
import { type ResolvedRelief, frameMask, normalSheetFor, reliefKind, shadeRelief } from '../core/game/relief.js';
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

  clear(color: string): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number; flat?: boolean }): void {
    const img = this.images.get(sprite);
    if (!img) return;
    this.captureNormals(sprite, sx, sy, sw, sh, dx, dy, o);
    const c = this.ctx;
    const k = o.scale ?? 1;
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
  private alphaMask(sprite: string): { mask: Uint8Array; width: number } | null {
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
    return sheet ? frameMask(sheet.data, sheet.width, x, y, w, h) : null;
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
  stamp(shape: CastShape, x: number, y: number, zoom: number, color: string, alpha: number): void {
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
    c.drawImage(entry.canvas, x, y, shape.width * zoom, shape.height * zoom);
    c.globalAlpha = 1;
  }

  text(text: string, x: number, y: number, color: string, scale: number): void {
    const key = color + '\u0000' + text;
    let cv = this.textCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      const lines = text.split('\n');
      cv.width = Math.max(1, Math.max(...lines.map((l) => [...l].length)) * 4);
      cv.height = Math.max(1, lines.length * 6);
      const g = cv.getContext('2d')!;
      g.fillStyle = color;
      rasterText(text, (px, py) => g.fillRect(px, py, 1, 1));
      if (this.textCache.size > 400) this.textCache.clear();
      this.textCache.set(key, cv);
    }
    this.ctx.drawImage(cv, Math.round(x), Math.round(y), cv.width * scale, cv.height * scale);
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
