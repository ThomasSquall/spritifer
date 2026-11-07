/**
 * Pixel particles: bursts of little squares with speed, gravity, drag, fading and shrinking. Cheap,
 * deterministic (they use the world's random), drawn in world space above or behind the instances.
 */

import type { Renderer } from './engine.js';

type Range = number | [number, number];

export interface ParticleOptions {
  count?: number;
  /** One color or a list to pick from. */
  color?: string | string[];
  /** Pixels per second. */
  speed?: Range;
  /** Direction in degrees (0 = right, -90 = up) and the spread around it. */
  angle?: number;
  spread?: number;
  /** Seconds. */
  life?: Range;
  /** Square size in pixels. */
  size?: Range;
  /** Pixels per second squared (negative rises). */
  gravity?: number;
  /** Slows down (per second). */
  drag?: number;
  fade?: boolean;
  shrink?: boolean;
  /** Spawn area around the point (width/height in px). */
  areaW?: number;
  areaH?: number;
  /** Draw behind the instances (above tiles). */
  behind?: boolean;
}

export const PARTICLE_PRESETS: Record<string, ParticleOptions> = {
  dust: { count: 6, color: ['#c2b280', '#9a8a6a', '#e0d4b0'], speed: [10, 30], angle: -90, spread: 140, life: [0.3, 0.6], size: [1, 2], gravity: 20, drag: 2, fade: true },
  sparks: { count: 12, color: ['#ffcd75', '#feae34', '#ffffff'], speed: [60, 140], spread: 360, life: [0.2, 0.5], size: 1, gravity: 200, fade: true },
  hit: { count: 6, color: ['#ffffff', '#ffcd75'], speed: [40, 90], spread: 360, life: [0.1, 0.25], size: 1, drag: 4 },
  explosion: { count: 30, color: ['#feae34', '#f77622', '#e43b44', '#ffffff', '#5d275d'], speed: [30, 120], spread: 360, life: [0.3, 0.8], size: [1, 3], drag: 3, fade: true, shrink: true },
  smoke: { count: 8, color: ['#8b9bb4', '#5a6988', '#c0cbdc'], speed: [5, 20], angle: -90, spread: 60, life: [0.6, 1.2], size: [2, 4], gravity: -15, drag: 1, fade: true },
  magic: { count: 14, color: ['#73eff7', '#41a6f6', '#ffffff', '#b58cff'], speed: [10, 40], spread: 360, life: [0.4, 0.9], size: [1, 2], gravity: -30, fade: true },
  leaves: { count: 5, color: ['#38b764', '#a7f070', '#257179'], speed: [10, 30], angle: 90, spread: 180, life: [1, 2], size: 2, gravity: 25, drag: 1.5, fade: true },
  splash: { count: 10, color: ['#41a6f6', '#73eff7', '#ffffff'], speed: [40, 90], angle: -90, spread: 100, life: [0.3, 0.6], size: [1, 2], gravity: 300, fade: true },
  confetti: { count: 24, color: ['#e43b44', '#feae34', '#38b764', '#41a6f6', '#b58cff', '#ffcd75'], speed: [40, 110], angle: -90, spread: 120, life: [0.8, 1.5], size: 2, gravity: 120, drag: 1 },
  heal: { count: 10, color: ['#38b764', '#a7f070', '#ffffff'], speed: [5, 20], angle: -90, spread: 40, life: [0.5, 1], size: 1, gravity: -40, fade: true, areaW: 12, areaH: 8 },
};

export const PARTICLE_PRESET_NAMES = Object.keys(PARTICLE_PRESETS);

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  gravity: number;
  drag: number;
  fade: boolean;
  shrink: boolean;
  behind: boolean;
}

const MAX = 3000;

export class ParticleSystem {
  private list: Particle[] = [];

  constructor(private random: () => number) {}

  get count(): number {
    return this.list.length;
  }

  private pick(r: Range | undefined, d: number): number {
    if (r === undefined) return d;
    if (Array.isArray(r)) return r[0] + this.random() * (r[1] - r[0]);
    return r;
  }

  /** Spawns a burst at (x, y): a preset name, options, or a preset with overrides. */
  burst(x: number, y: number, preset: string | ParticleOptions = 'sparks', overrides: ParticleOptions = {}): void {
    const base = typeof preset === 'string' ? PARTICLE_PRESETS[preset] : preset;
    if (!base) throw new Error(`unknown particle preset "${String(preset)}" (use ${PARTICLE_PRESET_NAMES.join(', ')} or options)`);
    const o: ParticleOptions = { ...base, ...overrides };
    const n = Math.max(0, Math.min(500, Math.round(o.count ?? 10)));
    const colors = Array.isArray(o.color) ? o.color : [o.color ?? '#ffffff'];
    const spread = ((o.spread ?? 360) * Math.PI) / 180;
    const center = ((o.angle ?? 0) * Math.PI) / 180;
    for (let i = 0; i < n && this.list.length < MAX; i++) {
      const a = center + (this.random() - 0.5) * spread;
      const sp = this.pick(o.speed, 40);
      this.list.push({
        x: x + (this.random() - 0.5) * (o.areaW ?? 0),
        y: y + (this.random() - 0.5) * (o.areaH ?? 0),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        age: 0,
        life: Math.max(0.02, this.pick(o.life, 0.5)),
        size: Math.max(1, this.pick(o.size, 1)),
        color: colors[Math.floor(this.random() * colors.length)] ?? '#ffffff',
        gravity: o.gravity ?? 0,
        drag: o.drag ?? 0,
        fade: o.fade ?? false,
        shrink: o.shrink ?? false,
        behind: o.behind ?? false,
      });
    }
  }

  tick(dt: number): void {
    if (!this.list.length) return;
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += p.gravity * dt;
      if (p.drag) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      keep.push(p);
    }
    this.list = keep;
  }

  clear(): void {
    this.list = [];
  }

  /** Draws the particles of one layer (behind = under the instances). */
  draw(r: Renderer, camX: number, camY: number, zoom: number, behind: boolean): void {
    for (const p of this.list) {
      if (p.behind !== behind) continue;
      const t = p.age / p.life;
      const size = Math.max(1, Math.round((p.shrink ? p.size * (1 - t) : p.size) * zoom));
      r.rect(Math.round((p.x - camX) * zoom - size / 2), Math.round((p.y - camY) * zoom - size / 2), size, size, p.color, p.fade ? Math.max(0, 1 - t) : 1);
    }
  }
}
