/**
 * Plays visual effect graphs (see vfxGraph.ts). Everything is drawn from pixels through the engine Renderer,
 * so the game, the editor preview and the MCP filmstrip show exactly the same thing. It has no idea of the
 * World: the game talks to it through VfxHost, the editor plays effects without a game running.
 */

import type { Renderer } from './engine.js';
import { ParticleSystem } from './particles.js';
import type { SpriteAsset } from './types.js';
import { type VfxGraph, type VfxNode, VFX_NODE_MAP, vfxEdgePort, vfxParam } from './vfxGraph.js';

export interface VfxPoint {
  x: number;
  y: number;
}

/** A fixed point, or a live one (an instance that moves). */
export type VfxAnchor = VfxPoint | (() => VfxPoint);

export interface VfxHost {
  asset?(name: string): SpriteAsset | undefined;
  sound?(name: string, volume: number): void;
  shake?(intensity: number, seconds: number): void;
  hitstop?(seconds: number): void;
  message?(message: string, data: { effect: string; x: number; y: number }): void;
  log?(message: string): void;
}

export interface VfxPlayOptions {
  source: VfxAnchor;
  /** Omitted: `reach` pixels ahead of the source. */
  target?: VfxAnchor;
  /** Attack direction in degrees; default from source to target. */
  angle?: number;
  /** Pixels ahead of the source when there is no target. */
  reach?: number;
  tint?: string;
  scale?: number;
  speed?: number;
  blink?(who: 'source' | 'target', seconds: number): void;
  onMessage?(message: string): void;
}

export interface VfxLight extends VfxPoint {
  radius: number;
  color: string;
  intensity: number;
}

interface View {
  r: Renderer;
  camX: number;
  camY: number;
  zoom: number;
}

/** What a node leaves running until it ends. */
interface Active {
  node: VfxNode;
  t: number;
  dur: number;
  behind?: boolean;
  tick?(dt: number): void;
  draw?(v: View): void;
  screen?(r: Renderer, w: number, h: number): void;
  light?(): VfxLight | null;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t * t;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const at = (a: VfxAnchor): VfxPoint => (typeof a === 'function' ? a() : a);
/** Fades only over the end of a life, so effects stay crisp. */
const tailFade = (u: number, from = 0.6) => (u < from ? 1 : Math.max(0, 1 - (u - from) / (1 - from)));

function hexRgb(c: string): [number, number, number] {
  let h = c.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** Recolors towards a tint keeping the brightness: dark edges take the tint, bright cores go white. */
function tinted(c: string, tint: [number, number, number]): string {
  const [r, g, b] = hexRgb(c);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const k = Math.min(1, lum * 1.6);
  const w = Math.max(0, lum * 2 - 1) * 0.8;
  return toHex(lerp(tint[0] * k, 255, w), lerp(tint[1] * k, 255, w), lerp(tint[2] * k, 255, w));
}

/** Collects the pixels of a shape once each (overlapping strokes would otherwise stack their alpha). */
class Plot {
  private px = new Map<number, string>();

  add(x: number, y: number, color: string): void {
    this.px.set((Math.round(y) + 32768) * 65536 + Math.round(x) + 32768, color);
  }

  flush(v: View, alpha: number, additive: boolean): void {
    const z = Math.max(1, Math.ceil(v.zoom));
    for (const [key, color] of this.px) {
      const x = (key % 65536) - 32768;
      const y = Math.floor(key / 65536) - 32768;
      v.r.rect(Math.round((x - v.camX) * v.zoom), Math.round((y - v.camY) * v.zoom), z, z, color, alpha, additive ? 'add' : undefined);
    }
  }
}

const MAX_FIRES = 512;

export class VfxRun {
  time = 0;
  finished = false;
  readonly done: Promise<void>;
  private resolve!: () => void;
  private fires = 0;
  private byId = new Map<string, VfxNode>();
  private out = new Map<string, VfxNode[]>();
  active: Active[] = [];
  private colorCache = new Map<string, string>();
  private tint: [number, number, number] | null;
  private scale: number;
  private pace: number;
  /** Observes each node starting and ending (timelines). */
  onNode?: (node: VfxNode, phase: 'begin' | 'end', time: number) => void;

  constructor(private sys: VfxSystem, private graph: VfxGraph, private o: VfxPlayOptions) {
    this.done = new Promise((r) => (this.resolve = r));
    this.tint = o.tint ? hexRgb(o.tint) : null;
    this.scale = Math.max(0.1, o.scale ?? 1);
    this.pace = Math.max(0.05, o.speed ?? 1);
    for (const n of graph.nodes) this.byId.set(n.id, n);
    for (const e of graph.edges) {
      const to = this.byId.get(e.to);
      if (!to) continue;
      const key = `${e.from}.${vfxEdgePort(graph, e)}`;
      const list = this.out.get(key);
      if (list) list.push(to);
      else this.out.set(key, [to]);
    }
  }

  get name(): string {
    return this.graph.name;
  }

  start(): void {
    const start = this.graph.nodes.find((n) => n.type === 'start');
    if (start) this.fire(start);
    this.checkDone();
  }

  private target(): VfxPoint {
    if (this.o.target) return at(this.o.target);
    const s = at(this.o.source);
    const a = rad(this.o.angle ?? 0);
    const reach = this.o.reach ?? 32;
    return { x: s.x + Math.cos(a) * reach, y: s.y + Math.sin(a) * reach };
  }

  /** Attack direction in degrees. */
  private aim(): number {
    if (this.o.angle !== undefined) return this.o.angle;
    const s = at(this.o.source);
    const t = this.target();
    return t.x === s.x && t.y === s.y ? 0 : (Math.atan2(t.y - s.y, t.x - s.x) * 180) / Math.PI;
  }

  private place(n: VfxNode): VfxPoint {
    const where = vfxParam<string>(n, 'at');
    const s = at(this.o.source);
    const t = this.target();
    const base = where === 'source' ? s : where === 'middle' ? { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 } : t;
    const a = rad(this.aim());
    const fwd = vfxParam<number>(n, 'forward') * this.scale;
    return { x: base.x + Math.cos(a) * fwd, y: base.y + Math.sin(a) * fwd + vfxParam<number>(n, 'dy') * this.scale };
  }

  private color(c: string): string {
    if (!this.tint) return c;
    let out = this.colorCache.get(c);
    if (!out) this.colorCache.set(c, (out = tinted(c, this.tint)));
    return out;
  }

  private colors(n: VfxNode, name = 'colors'): string[] {
    return vfxParam<string[]>(n, name).map((c) => this.color(c));
  }

  /** The position of a node: live when it follows, otherwise fixed where it appeared. */
  private position(n: VfxNode): () => VfxPoint {
    if (vfxParam<boolean>(n, 'follow')) return () => this.place(n);
    const p = this.place(n);
    return () => p;
  }

  private output(n: VfxNode, port: string): void {
    for (const next of this.out.get(`${n.id}.${port}`) ?? []) this.fire(next);
  }

  private finish(n: VfxNode): void {
    this.onNode?.(n, 'end', this.time);
    this.output(n, VFX_NODE_MAP.get(n.type)?.outputs.at(-1) ?? 'out');
  }

  private fire(n: VfxNode): void {
    // Graphs have no loops once checked; this only guards a hand-edited file.
    if (++this.fires > MAX_FIRES) return;
    this.onNode?.(n, 'begin', this.time);
    const a = this.begin(n);
    if (!a || a.dur <= 0) {
      this.finish(n);
      return;
    }
    this.active.push(a);
  }

  private begin(n: VfxNode): Active | null {
    const host = this.sys.host;
    switch (n.type) {
      case 'delay':
        return { node: n, t: 0, dur: vfxParam<number>(n, 'seconds') };
      case 'repeat':
        return this.beginRepeat(n);
      case 'message': {
        const name = vfxParam<string>(n, 'message');
        const p = this.place({ ...n, params: { ...n.params, follow: false } });
        host.message?.(name, { effect: this.graph.name, x: p.x, y: p.y });
        this.o.onMessage?.(name);
        return null;
      }
      case 'slash':
        return this.beginSlash(n);
      case 'ring':
        return this.beginRing(n);
      case 'beam':
        return this.beginBeam(n);
      case 'projectile':
        return this.beginProjectile(n);
      case 'sprite':
        return this.beginSprite(n);
      case 'particles':
        return this.beginParticles(n);
      case 'flash': {
        const color = this.color(vfxParam<string>(n, 'color'));
        const alpha = vfxParam<number>(n, 'alpha');
        const a: Active = { node: n, t: 0, dur: vfxParam<number>(n, 'duration'), screen: (r, w, h) => r.rect(0, 0, w, h, color, alpha * (1 - a.t / a.dur)) };
        return a;
      }
      case 'light': {
        const pos = this.position(n);
        const a: Active = {
          node: n, t: 0, dur: vfxParam<number>(n, 'duration'),
          light: () => ({ ...pos(), radius: vfxParam<number>(n, 'radius') * this.scale, color: this.color(vfxParam<string>(n, 'color')), intensity: vfxParam<number>(n, 'intensity') * (1 - a.t / a.dur) }),
        };
        return a;
      }
      case 'shake':
        host.shake?.(vfxParam<number>(n, 'intensity') * this.scale, vfxParam<number>(n, 'seconds'));
        return null;
      case 'hitstop':
        host.hitstop?.(vfxParam<number>(n, 'seconds'));
        return null;
      case 'blink':
        this.o.blink?.(vfxParam<'source' | 'target'>(n, 'who'), vfxParam<number>(n, 'seconds'));
        return null;
      case 'sound':
        host.sound?.(vfxParam<string>(n, 'sound'), vfxParam<number>(n, 'volume'));
        return null;
      default:
        return null;
    }
  }

  private beginRepeat(n: VfxNode): Active {
    const count = Math.max(1, Math.round(vfxParam<number>(n, 'count')));
    const interval = vfxParam<number>(n, 'interval');
    let fired = 1;
    this.output(n, 'each');
    const a: Active = {
      node: n, t: 0, dur: (count - 1) * interval,
      tick: () => {
        while (fired < count && a.t >= fired * interval) {
          fired++;
          this.output(n, 'each');
        }
      },
    };
    return a;
  }

  private beginSlash(n: VfxNode): Active {
    const pos = this.position(n);
    const radius = vfxParam<number>(n, 'radius') * this.scale;
    const thickness = vfxParam<number>(n, 'thickness') * this.scale;
    const arc = rad(vfxParam<number>(n, 'arc'));
    const sign = vfxParam<string>(n, 'sweep') === 'clockwise' ? 1 : -1;
    const center = rad(this.aim() + vfxParam<number>(n, 'rotate'));
    const squash = vfxParam<number>(n, 'squash');
    const bands = this.colors(n);
    const additive = vfxParam<string>(n, 'blend') === 'add';
    const a: Active = {
      node: n, t: 0, dur: vfxParam<number>(n, 'duration'), behind: vfxParam<string>(n, 'layer') === 'behind',
      draw: (v) => {
        const u = a.t / a.dur;
        // The tip races ahead, the tail catches up: the blade appears and vanishes along its own path.
        const head = easeOut(Math.min(1, u / 0.7));
        const tail = easeIn(Math.max(0, (u - 0.2) / 0.8));
        if (head <= tail) return;
        const { x, y } = pos();
        const plot = new Plot();
        const steps = Math.max(8, Math.ceil(arc * (head - tail) * radius * 1.5));
        const start = center - (sign * arc) / 2;
        for (let i = 0; i <= steps; i++) {
          const k = i / steps;
          const ang = start + sign * arc * lerp(tail, head, k);
          // Fat near the tip, a sharp point at both ends.
          const w = thickness * Math.sin(Math.PI * k ** 1.6) ** 0.7;
          for (let rr = 0; rr < Math.max(1, w); rr += 0.6) {
            const r = radius - rr;
            const px = Math.cos(ang) * r;
            const py = Math.sin(ang) * r;
            // Squash in the attack's own frame would tilt it; flat on screen reads as "on the ground".
            plot.add(x + px, y + py * squash, bands[Math.min(bands.length - 1, Math.floor((rr / Math.max(1, w)) * bands.length))]);
          }
        }
        plot.flush(v, 1, additive);
      },
    };
    return a;
  }

  private beginRing(n: VfxNode): Active {
    const pos = this.position(n);
    const [r0, r1] = vfxParam<[number, number]>(n, 'radius');
    const [t0, t1] = vfxParam<[number, number]>(n, 'thickness');
    const squash = vfxParam<number>(n, 'squash');
    const palette = this.colors(n);
    const additive = vfxParam<string>(n, 'blend') === 'add';
    const a: Active = {
      node: n, t: 0, dur: vfxParam<number>(n, 'duration'), behind: vfxParam<string>(n, 'layer') === 'behind',
      draw: (v) => {
        const u = a.t / a.dur;
        const radius = lerp(r0, r1, easeOut(u)) * this.scale;
        const thick = Math.max(1, lerp(t0, t1, u) * this.scale);
        const { x, y } = pos();
        const plot = new Plot();
        const color = palette[Math.min(palette.length - 1, Math.floor(u * palette.length))];
        const steps = Math.max(12, Math.ceil(Math.PI * 2 * radius * 1.5));
        for (let i = 0; i < steps; i++) {
          const ang = (i / steps) * Math.PI * 2;
          for (let rr = 0; rr < thick; rr += 0.6) plot.add(x + Math.cos(ang) * (radius - rr), y + Math.sin(ang) * (radius - rr) * squash, color);
        }
        plot.flush(v, tailFade(u), additive);
      },
    };
    return a;
  }

  private beginBeam(n: VfxNode): Active {
    const width = vfxParam<number>(n, 'width') * this.scale;
    const wobble = vfxParam<number>(n, 'wobble') * this.scale;
    const segments = Math.max(2, Math.round(vfxParam<number>(n, 'segments')));
    const fwd = vfxParam<number>(n, 'forward') * this.scale;
    const bands = this.colors(n);
    const additive = vfxParam<string>(n, 'blend') === 'add';
    let jitter: number[] = [];
    let jitterAt = -1;
    const a: Active = {
      node: n, t: 0, dur: vfxParam<number>(n, 'duration'), behind: vfxParam<string>(n, 'layer') === 'behind',
      draw: (v) => {
        const u = a.t / a.dur;
        const s = at(this.o.source);
        const t = this.target();
        const ang = Math.atan2(t.y - s.y, t.x - s.x);
        const sx = s.x + Math.cos(ang) * fwd;
        const sy = s.y + Math.sin(ang) * fwd;
        // Lightning re-strikes a few times a second.
        const slot = Math.floor(a.t * 24);
        if (slot !== jitterAt) {
          jitterAt = slot;
          jitter = Array.from({ length: segments + 1 }, (_, i) => (i === 0 || i === segments ? 0 : (this.sys.random() * 2 - 1) * wobble));
        }
        const grow = Math.min(1, u / 0.2);
        const thin = u < 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) / 0.5);
        const nx = -Math.sin(ang);
        const ny = Math.cos(ang);
        const pt = (i: number) => ({ x: lerp(sx, t.x, (i / segments) * grow) + nx * jitter[i], y: lerp(sy, t.y, (i / segments) * grow) + ny * jitter[i] });
        const plot = new Plot();
        bands.forEach((color, b) => {
          const half = Math.max(0, (width * thin * (1 - b / bands.length)) / 2);
          for (let i = 0; i < segments; i++) {
            const p0 = pt(i);
            const p1 = pt(i + 1);
            const len = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y) * 1.5));
            for (let j = 0; j <= len; j++) {
              const px = lerp(p0.x, p1.x, j / len);
              const py = lerp(p0.y, p1.y, j / len);
              for (let dy = -half; dy <= half + 0.001; dy += 0.75) for (let dx = -half; dx <= half + 0.001; dx += 0.75) plot.add(px + dx, py + dy, color);
            }
          }
        });
        plot.flush(v, 1, additive);
      },
    };
    return a;
  }

  private beginProjectile(n: VfxNode): Active {
    const s0 = at(this.o.source);
    const t0 = this.target();
    const dir = Math.atan2(t0.y - s0.y, t0.x - s0.x);
    const fwd = vfxParam<number>(n, 'forward') * this.scale;
    const from = { x: s0.x + Math.cos(dir) * fwd, y: s0.y + Math.sin(dir) * fwd };
    const speed = vfxParam<number>(n, 'speed');
    const arc = vfxParam<number>(n, 'arc') * this.scale;
    const size = vfxParam<number>(n, 'size') * this.scale;
    const head = this.colors(n);
    const sprite = vfxParam<string>(n, 'sprite');
    const asset = sprite ? this.sys.host.asset?.(sprite) : undefined;
    if (sprite && !asset) this.sys.host.log?.(`vfx "${this.graph.name}": sprite "${sprite}" not found`);
    const behind = vfxParam<string>(n, 'layer') === 'behind';
    const additive = vfxParam<string>(n, 'blend') === 'add';
    const rate = vfxParam<number>(n, 'trail');
    const trail = this.colors(n, 'trailColors');
    const trailLife = vfxParam<number>(n, 'trailLife');
    let owed = 0;
    const where = (u: number) => {
      const t = this.target();
      return { x: lerp(from.x, t.x, u), y: lerp(from.y, t.y, u) - Math.sin(Math.PI * u) * arc };
    };
    const a: Active = {
      node: n, t: 0, dur: Math.max(0.02, Math.hypot(t0.x - from.x, t0.y - from.y) / speed), behind,
      tick: (dt) => {
        owed += rate * dt;
        const c = Math.floor(owed);
        if (!c) return;
        owed -= c;
        const p = where(Math.min(1, a.t / a.dur));
        this.sys.particles.burst(p.x, p.y, { count: c, color: trail, colorOverLife: true, speed: [2, 14], spread: 360, life: [trailLife * 0.6, trailLife], size: [Math.max(1, size * 0.4), Math.max(1, size * 0.8)], shrink: true, fade: true, additive, behind });
      },
      draw: (v) => {
        const u = Math.min(1, a.t / a.dur);
        const p = where(u);
        if (asset?.frames.length) {
          const q = where(Math.min(1, u + 0.02));
          const f = asset.frames[Math.floor(a.t * 12) % asset.frames.length];
          const k = v.zoom * this.scale;
          v.r.image(asset.name, f.x, f.y, f.w, f.h, Math.round((p.x - v.camX) * v.zoom - (f.w * k) / 2), Math.round((p.y - v.camY) * v.zoom - (f.h * k) / 2), { flipX: false, opacity: 1, angle: (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI, ...(k !== 1 ? { scale: k } : {}) });
          return;
        }
        const plot = new Plot();
        const r = Math.ceil(size);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const d = Math.hypot(dx, dy) / Math.max(0.5, size);
            if (d <= 1) plot.add(p.x + dx, p.y + dy, head[Math.min(head.length - 1, Math.floor(d * head.length))]);
          }
        }
        plot.flush(v, 1, additive);
      },
    };
    return a;
  }

  private beginSprite(n: VfxNode): Active | null {
    const name = vfxParam<string>(n, 'sprite');
    const asset = name ? this.sys.host.asset?.(name) : undefined;
    if (!asset?.frames.length) {
      this.sys.host.log?.(`vfx "${this.graph.name}": sprite "${name}" not found`);
      return null;
    }
    const tag = asset.tags.find((t) => t.name === vfxParam<string>(n, 'animation'));
    const frames = tag ? asset.frames.slice(tag.from, tag.to + 1) : asset.frames;
    if (!frames.length) return null;
    const once = frames.reduce((s, f) => s + (f.duration || 100) / 1000, 0);
    const loops = Math.max(1, Math.round(vfxParam<number>(n, 'loops')));
    const pos = this.position(n);
    const scale = vfxParam<number>(n, 'scale') * this.scale;
    const opacity = vfxParam<number>(n, 'opacity');
    const align = vfxParam<string>(n, 'align');
    const aim = this.aim();
    const a: Active = {
      node: n, t: 0, dur: once * loops, behind: vfxParam<string>(n, 'layer') === 'behind',
      draw: (v) => {
        let left = a.t % once;
        let f = frames[frames.length - 1];
        for (const fr of frames) {
          left -= (fr.duration || 100) / 1000;
          if (left < 0) {
            f = fr;
            break;
          }
        }
        const p = pos();
        const k = v.zoom * scale;
        v.r.image(asset.name, f.x, f.y, f.w, f.h, Math.round((p.x - v.camX) * v.zoom - (f.w * k) / 2), Math.round((p.y - v.camY) * v.zoom - (f.h * k) / 2), {
          flipX: align === 'flip' && Math.cos(rad(aim)) < -1e-6,
          opacity,
          angle: align === 'rotate' ? aim : 0,
          ...(k !== 1 ? { scale: k } : {}),
        });
      },
    };
    return a;
  }

  private beginParticles(n: VfxNode): Active | null {
    const pos = this.position(n);
    const scale = this.scale;
    const total = Math.round(vfxParam<number>(n, 'count'));
    const dur = vfxParam<number>(n, 'duration');
    const [s0, s1] = vfxParam<[number, number]>(n, 'speed');
    const [l0, l1] = vfxParam<[number, number]>(n, 'life');
    const [z0, z1] = vfxParam<[number, number]>(n, 'size');
    const aimed = vfxParam<boolean>(n, 'aim');
    const opts = {
      color: this.colors(n),
      colorOverLife: vfxParam<boolean>(n, 'overLife'),
      speed: [s0 * scale * this.pace, s1 * scale * this.pace] as [number, number],
      spread: vfxParam<number>(n, 'spread'),
      life: [l0 / this.pace, l1 / this.pace] as [number, number],
      size: [z0 * scale, z1 * scale] as [number, number],
      gravity: vfxParam<number>(n, 'gravity') * scale * this.pace * this.pace,
      drag: vfxParam<number>(n, 'drag') * this.pace,
      fade: vfxParam<boolean>(n, 'fade'),
      shrink: vfxParam<boolean>(n, 'shrink'),
      areaW: vfxParam<number>(n, 'areaW') * scale,
      areaH: vfxParam<number>(n, 'areaH') * scale,
      additive: vfxParam<string>(n, 'blend') === 'add',
      behind: vfxParam<string>(n, 'layer') === 'behind',
    };
    const emit = (count: number) => {
      const p = pos();
      this.sys.particles.burst(p.x, p.y, { ...opts, count, angle: vfxParam<number>(n, 'angle') + (aimed ? this.aim() : 0) });
    };
    if (dur <= 0) {
      emit(total);
      return null;
    }
    let sent = 0;
    const a: Active = {
      node: n, t: 0, dur,
      tick: () => {
        const want = Math.min(total, Math.floor((a.t / a.dur) * total));
        if (want > sent) emit(want - sent);
        sent = Math.max(sent, want);
      },
    };
    return a;
  }

  tick(dt: number): void {
    const step = dt * this.pace;
    this.time += step;
    for (const a of [...this.active]) {
      a.t += step;
      a.tick?.(dt);
      if (a.t < a.dur) continue;
      this.active.splice(this.active.indexOf(a), 1);
      this.finish(a.node);
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.active.length || this.finished) return;
    this.finished = true;
    this.resolve();
  }

  /** Ends at once, without firing what's left. */
  stop(): void {
    this.active = [];
    this.checkDone();
  }
}

const MAX_RUNS = 128;

export class VfxSystem {
  private runs: VfxRun[] = [];
  private rng = 0x9e3779b9;
  readonly particles = new ParticleSystem(() => this.random());

  constructor(readonly host: VfxHost = {}) {}

  /** Its own random, so effects never change the gameplay's random sequence. */
  random(): number {
    this.rng = (this.rng + 0x6d2b79f5) | 0;
    let t = Math.imul(this.rng ^ (this.rng >>> 15), 1 | this.rng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  play(graph: VfxGraph, opts: VfxPlayOptions, onNode?: VfxRun['onNode']): VfxRun {
    if (this.runs.length >= MAX_RUNS) this.runs.shift()?.stop();
    const run = new VfxRun(this, graph, opts);
    run.onNode = onNode;
    this.runs.push(run);
    run.start();
    return run;
  }

  /** Nothing playing and no particles left. */
  get idle(): boolean {
    return !this.runs.length && !this.particles.count;
  }

  tick(dt: number): void {
    this.particles.tick(dt);
    if (!this.runs.length) return;
    for (const run of [...this.runs]) run.tick(dt);
    this.runs = this.runs.filter((r) => !r.finished);
  }

  clear(): void {
    for (const r of this.runs) r.stop();
    this.runs = [];
    this.particles.clear();
  }

  /** Draws one layer in world space (behind = under the instances). */
  draw(r: Renderer, camX: number, camY: number, zoom: number, behind: boolean): void {
    this.particles.draw(r, camX, camY, zoom, behind);
    const v: View = { r, camX, camY, zoom };
    for (const run of this.runs) for (const a of run.active) if (a.draw && !!a.behind === behind) a.draw(v);
  }

  /** Full-screen passes (flashes), over the game but under the HUD. */
  drawScreen(r: Renderer, w: number, h: number): void {
    for (const run of this.runs) for (const a of run.active) a.screen?.(r, w, h);
  }

  lights(): VfxLight[] {
    const out: VfxLight[] = [];
    for (const run of this.runs) {
      for (const a of run.active) {
        const l = a.light?.();
        if (l) out.push(l);
      }
    }
    return out;
  }
}

export interface VfxTimeline {
  /** Seconds until everything is over, particles included. */
  duration: number;
  spans: { id: string; type: string; from: number; to: number }[];
  /** Node ids that started more than once are listed once per start. */
  messages: { time: number; message: string }[];
  peakParticles: number;
}

const SIM_STEP = 1 / 60;

/** Plays an effect headless to learn what happens when (timeline in the editor, reports in MCP). */
export function simulateVfx(graph: VfxGraph, opts: Omit<VfxPlayOptions, 'source'> & { source?: VfxAnchor; host?: VfxHost } = {}): VfxTimeline {
  const spans: VfxTimeline['spans'] = [];
  const open = new Map<string, number[]>();
  const messages: VfxTimeline['messages'] = [];
  let run: VfxRun | null = null;
  const sys = new VfxSystem({
    ...opts.host,
    message: (message) => messages.push({ time: run?.time ?? 0, message }),
  });
  run = sys.play(graph, { source: { x: 0, y: 0 }, target: { x: 96, y: 0 }, ...opts }, (node, phase, time) => {
    if (phase === 'begin') {
      spans.push({ id: node.id, type: node.type, from: time, to: time });
      const list = open.get(node.id);
      if (list) list.push(spans.length - 1);
      else open.set(node.id, [spans.length - 1]);
    } else {
      const i = open.get(node.id)?.shift();
      if (i !== undefined) spans[i].to = time;
    }
  });
  let elapsed = 0;
  let peak = sys.particles.count;
  while (!sys.idle && elapsed < 30) {
    sys.tick(SIM_STEP);
    elapsed += SIM_STEP;
    peak = Math.max(peak, sys.particles.count);
  }
  return { duration: elapsed, spans, messages, peakParticles: peak };
}
