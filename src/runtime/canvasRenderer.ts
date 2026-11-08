/**
 * Canvas 2D implementation of the engine Renderer, with the atmosphere passes (lighting, grade, vignette).
 * Shared by the game player and the scene editor's atmosphere preview, so both draw the same light.
 */

import type { Renderer } from '../core/game/engine.js';
import type { ScreenLight } from '../core/game/atmosphere.js';
import { rasterText } from '../core/game/font.js';

export class CanvasRenderer implements Renderer {
  private textCache = new Map<string, HTMLCanvasElement>();
  constructor(private ctx: CanvasRenderingContext2D, private images: Map<string, CanvasImageSource>, private w: number, private h: number) {}

  clear(color: string): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number }): void {
    const img = this.images.get(sprite);
    if (!img) return;
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

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.globalAlpha = 1;
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

  vignette(strength: number, color: string): void {
    const c = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const r = Math.hypot(cx, cy);
    const grad = c.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    grad.addColorStop(0, withAlpha(color, 0));
    grad.addColorStop(1, withAlpha(color, strength));
    c.save();
    c.globalAlpha = 1;
    c.fillStyle = grad;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
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
