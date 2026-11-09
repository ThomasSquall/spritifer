/**
 * Rain with lightning, and shafts of light: drawn in world space over the finished scene. Like the ambient particles,
 * they have their own random numbers so the weather never changes what happens in the game.
 */

import type { Renderer } from './engine.js';
import type { SceneRain, SceneShafts } from './types.js';

interface Drop {
  x: number;
  y: number;
  /** Where it reaches the ground. */
  land: number;
  speed: number;
  length: number;
}

interface Splash {
  x: number;
  y: number;
  age: number;
}

const SPLASH_LIFE = 0.16;

export class RainField {
  private drops: Drop[] = [];
  private splashes: Splash[] = [];
  private config: SceneRain | undefined;
  private seed = 7654321;
  /** Strength of the lightning on screen, 0..1, and the second, weaker flash that follows. */
  private flash = 0;
  private flashAgain = 0;
  private nextBolt = 0;
  private thunders: { at: number; volume: number }[] = [];
  private time = 0;

  private rnd(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  reset(config: SceneRain | undefined): void {
    this.config = config;
    this.drops = [];
    this.splashes = [];
    this.flash = this.flashAgain = 0;
    this.thunders = [];
    this.nextBolt = this.time + this.boltGap();
  }

  private boltGap(): number {
    const perMinute = this.config?.lightning ?? 0;
    return perMinute > 0 ? (60 / perMinute) * (0.5 + this.rnd()) : Infinity;
  }

  private drop(view: { x: number; y: number; w: number; h: number }, fill: boolean): Drop {
    const land = view.y + this.rnd() * view.h;
    return {
      x: view.x - 40 + this.rnd() * (view.w + 80),
      y: fill ? view.y + this.rnd() * view.h : view.y - 12 - this.rnd() * view.h * 0.5,
      land,
      speed: (this.config?.speed ?? 420) * (0.8 + this.rnd() * 0.4),
      length: 5 + Math.floor(this.rnd() * 5),
    };
  }

  /** Moves the rain. `thunder` plays the sound some time after each flash, as thunder comes after lightning. */
  tick(dt: number, view: { x: number; y: number; w: number; h: number }, thunder?: (name: string, volume: number) => void): void {
    this.time += dt;
    const c = this.config;
    if (!c) return;
    const want = c.count ?? 140;
    const fill = this.drops.length === 0;
    while (this.drops.length < want) this.drops.push(this.drop(view, fill));
    this.drops.length = Math.min(this.drops.length, want);
    const slope = Math.tan(((c.angle ?? 12) * Math.PI) / 180);
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i]!;
      d.y += d.speed * dt;
      d.x -= d.speed * slope * dt;
      if (d.y < d.land && d.x > view.x - 60 && d.x < view.x + view.w + 60) continue;
      if (c.splashes !== false && d.y >= d.land) this.splashes.push({ x: d.x, y: d.land, age: 0 });
      this.drops[i] = this.drop(view, false);
    }
    for (const s of this.splashes) s.age += dt;
    this.splashes = this.splashes.filter((s) => s.age < SPLASH_LIFE);
    this.flash = Math.max(0, this.flash - dt * 6);
    if (this.flashAgain > 0) {
      this.flashAgain -= dt;
      if (this.flashAgain <= 0) this.flash = Math.max(this.flash, 0.55);
    }
    if (this.time >= this.nextBolt) {
      this.nextBolt = this.time + this.boltGap();
      this.flash = 1;
      this.flashAgain = 0.09 + this.rnd() * 0.08;
      if (c.thunder) this.thunders.push({ at: this.time + 0.5 + this.rnd() * 1.4, volume: 0.45 + this.rnd() * 0.3 });
    }
    if (this.thunders.length && this.time >= this.thunders[0]!.at) {
      const t = this.thunders.shift()!;
      if (c.thunder) thunder?.(c.thunder, t.volume);
    }
  }

  draw(r: Renderer, camX: number, camY: number, zoom: number): void {
    const c = this.config;
    if (!c) return;
    const color = c.color ?? '#b8c8e8';
    const alpha = c.opacity ?? 0.42;
    const slope = Math.tan(((c.angle ?? 12) * Math.PI) / 180);
    const z = Math.max(1, Math.round(zoom));
    for (const d of this.drops) {
      for (let i = 0; i < d.length; i += 2) {
        r.rect(Math.round((d.x + i * slope - camX) * zoom), Math.round((d.y - i - camY) * zoom), z, 2 * z, color, alpha * (1 - i / (d.length + 2)));
      }
    }
    for (const s of this.splashes) {
      const x = Math.round((s.x - camX) * zoom);
      const y = Math.round((s.y - camY) * zoom);
      if (s.age < SPLASH_LIFE / 2) r.rect(x - z, y, 3 * z, z, color, alpha * 1.3);
      else {
        r.rect(x - 2 * z, y, z, z, color, alpha);
        r.rect(x + 2 * z, y, z, z, color, alpha);
      }
    }
  }

  /** The flash of lightning, over everything (after the lighting: it lights the whole sky). */
  drawFlash(r: Renderer, vw: number, vh: number): void {
    if (this.flash > 0.01) r.rect(0, 0, vw, vh, this.config?.flashColor ?? '#cfdcff', this.flash * 0.4, 'add');
  }
}

const hash = (k: number, salt: number): number => {
  const v = Math.sin(k * 127.1 + salt * 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Shafts of light slanting through the air, anchored to the map so you walk past them. They are drawn as stepped rows,
 * so they stay on the pixel grid, and the particles that cross one catch the light.
 */
export function drawShafts(r: Renderer, s: SceneShafts, clock: number, camX: number, camY: number, zoom: number, vw: number, vh: number, motes: readonly { readonly list: readonly { x: number; y: number; size: number; alpha: number }[] }[]): void {
  const color = s.color ?? '#ffe6b0';
  const opacity = s.opacity ?? 0.14;
  const tan = Math.tan(((s.angle ?? 22) * Math.PI) / 180);
  const baseWidth = s.width ?? 30;
  const worldW = vw / zoom;
  const spacing = Math.max(24, worldW / Math.max(1, s.count ?? 5));
  const step = Math.max(1, Math.round(3 * zoom));
  const reach = (vh / zoom) * Math.abs(tan) + baseWidth * 2;
  const first = Math.floor((camX - reach) / spacing);
  const last = Math.ceil((camX + worldW + reach) / spacing);
  for (let k = first; k <= last; k++) {
    // Not every slot has a shaft: the gaps are what makes them look like light through leaves.
    if (hash(k, 1) > 0.72) continue;
    const cx = (k + hash(k, 2) * 0.6) * spacing;
    const width = baseWidth * (0.55 + hash(k, 3) * 0.9);
    const breathe = 0.55 + 0.45 * Math.sin(clock * (0.18 + hash(k, 4) * 0.3) + hash(k, 5) * 6.28);
    const strength = opacity * breathe;
    const phase = hash(k, 6) * 6.28;
    for (let sy = 0; sy < vh; sy += step) {
      const wy = camY + sy / zoom;
      const pool = 0.35 + 0.65 * Math.sin(wy * 0.011 + phase) ** 2;
      const x = (cx + wy * tan - camX) * zoom;
      const a = strength * pool * 0.5;
      r.rect(Math.round(x - (width * zoom) / 2), sy, Math.round(width * zoom), step, color, a, 'add');
      r.rect(Math.round(x - (width * zoom) / 4), sy, Math.round((width * zoom) / 2), step, color, a, 'add');
    }
    for (const field of motes) {
      for (const m of field.list) {
        if (m.alpha <= 0.02 || Math.abs(m.x - (cx + m.y * tan)) > width / 2) continue;
        const z = Math.max(1, Math.round(m.size * zoom));
        r.rect(Math.round((m.x - camX) * zoom), Math.round((m.y - camY) * zoom), z, z, '#ffffff', Math.min(1, m.alpha * breathe * 0.9), 'add');
      }
    }
  }
}
