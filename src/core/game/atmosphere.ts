/**
 * Scene atmosphere: point lights over an ambient color, soft contact shadows, drifting cloud shadows,
 * ambient particles (fireflies, snow, embers...), color grade and vignette. Renderer-agnostic: the
 * passes that need blending modes go through optional Renderer methods, with plain fallbacks.
 */

import type { Renderer } from './engine.js';
import { resolveRelief } from './relief.js';
import type { Hitbox, LightDef, ObjectSway, SceneAtmosphere, SceneMotes, SceneSun, SpriteAsset } from './types.js';
import { type SwayBand, groupRows, swayBase, swayShift } from './wind.js';

/** An instance as the atmosphere passes see it (the engine's Actor, or a placed instance in the scene editor). */
export interface AtmosphereActor {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly opacity: number;
  readonly visible: boolean;
  readonly destroyed: boolean;
  readonly light: LightDef | undefined;
  readonly asset: { width: number; height: number; name?: string; frames?: readonly { x: number; y: number; w: number; h: number }[] } | undefined;
  readonly type: { hud?: boolean; shadow?: number; hitbox?: Hitbox; spriteOffset?: { x: number; y: number }; sway?: ObjectSway };
  /** Mirrored and on which frame: the shadow cast by the sun follows the drawing. */
  readonly flipX?: boolean;
  frameIndex?(): number;
  box(): { x: number; y: number; w: number; h: number };
}

/** What the atmosphere passes read: the running World, or the scene editor's preview of a scene. */
export interface AtmosphereWorld {
  readonly clock: number;
  readonly game: { width: number; height: number };
  readonly actors: readonly AtmosphereActor[];
  readonly motes: MoteField;
  readonly bundle: { sprites: Record<string, SpriteAsset | undefined> };
  /** Lights of the visual effects playing now. */
  readonly vfx?: { lights(): (LightDef & { x: number; y: number })[] };
}

/** A light in viewport pixels, ready to draw. */
export interface ScreenLight {
  x: number;
  y: number;
  radius: number;
  color: string;
  intensity: number;
}

const WHITE = /^#(fff|ffffff|ffffffff)$/i;

function luminance(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** Smooth pseudo-noise in [-1, 1] (no randomness: same result in every renderer and playtest). */
function wobble(t: number, seed: number): number {
  return (Math.sin(t * 11.3 + seed * 1.7) * 0.5 + Math.sin(t * 17.9 + seed * 3.1) * 0.3 + Math.sin(t * 5.1 + seed) * 0.2);
}

/** Lights of the visible instances and glowing motes, in viewport coordinates. */
export function collectLights(w: AtmosphereWorld, camX: number, camY: number, zoom: number): ScreenLight[] {
  const out: ScreenLight[] = [];
  const vw = w.game.width;
  const vh = w.game.height;
  const push = (wx: number, wy: number, l: LightDef, seed: number) => {
    if (!l.radius) return;
    let k = l.intensity ?? 1;
    if (l.flicker) k *= 1 + l.flicker * 0.5 * wobble(w.clock, seed);
    if (l.pulse) k *= 1 - l.pulse * 0.5 * (1 + Math.sin(w.clock * 2.2 + seed));
    const radius = l.radius * zoom * (l.flicker ? 1 + l.flicker * 0.08 * wobble(w.clock * 0.7, seed + 9) : 1);
    const x = (wx - camX) * zoom;
    const y = (wy - camY) * zoom;
    if (x + radius < 0 || y + radius < 0 || x - radius > vw || y - radius > vh || k <= 0) return;
    out.push({ x, y, radius, color: l.color ?? '#ffd9a0', intensity: k });
  };
  for (const l of w.vfx?.lights() ?? []) push(l.x, l.y, l, 0);
  for (const a of w.actors) {
    if (!a.light || a.destroyed || !a.visible || a.type.hud) continue;
    const offset = a.type.spriteOffset;
    push(a.x + (offset?.x ?? 0) + (a.asset?.width ?? 0) / 2 + (a.light.x ?? 0), a.y + (offset?.y ?? 0) + (a.asset?.height ?? 0) / 2 + (a.light.y ?? 0), a.light, a.id);
  }
  for (const m of w.motes.list) if (m.light) push(m.x, m.y, { radius: m.light, color: m.color, intensity: m.glow * m.alpha }, m.seed);
  return out;
}

/** Shadow width of an instance in pixels (0 = none). */
function shadowWidth(a: AtmosphereActor): number {
  if (a.type.shadow !== undefined) return a.type.shadow;
  if (!a.type.hitbox || a.z < 0) return 0;
  return a.type.hitbox.w + 2;
}

/** A silhouette already laid on the ground: rows of [x, y, length] relative to the sprite, ready to draw. */
export interface CastShape {
  readonly reachX: number;
  readonly reachY: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
  /** The rows of `runs` that have something: first, and one past the last. */
  readonly firstRow: number;
  readonly endRow: number;
  readonly runs: readonly number[];
}

/** By sprite asset (a rebuilt sprite is a new object): the shapes for one sun direction, by frame and mirroring. */
const castShapes = new WeakMap<object, { sun: string; shapes: Map<number, CastShape | null> }>();

function buildCastShape(mask: Uint8Array, fw: number, flip: boolean, dx: number, dy: number): CastShape | null {
  let bottom = -1;
  for (let i = mask.length - 1; i >= 0 && bottom < 0; i--) if (mask[i]) bottom = Math.floor(i / fw);
  if (bottom < 0) return null;
  const reachX = Math.ceil(Math.abs(dx) * (bottom + 1)) + 1;
  const reachY = Math.ceil(Math.abs(dy) * (bottom + 1)) + 1;
  const W = fw + reachX * 2;
  const H = reachY * 2 + 2;
  const ground = new Uint8Array(W * H);
  for (let y = bottom; y >= 0; y--) {
    const rise = bottom - y;
    // Half-pixel steps: a long shadow would otherwise show gaps between rows.
    for (let step = 0; step < 2; step++) {
      const h = rise + step * 0.5;
      const ox = Math.round(h * dx);
      const oy = Math.round(h * dy);
      for (let x = 0; x < fw; x++) {
        if (!mask[y * fw + (flip ? fw - 1 - x : x)]) continue;
        const gx = x + ox + reachX;
        const gy = oy + reachY;
        if (gx >= 0 && gy >= 0 && gx < W && gy < H) ground[gy * W + gx] = 1;
      }
    }
  }
  const runs: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!ground[y * W + x]) continue;
      let end = x;
      while (end + 1 < W && ground[y * W + end + 1]) end++;
      runs.push(x, y, end - x + 1);
      x = end;
    }
  }
  return { reachX, reachY, bottom, width: W, height: H, firstRow: runs[1] ?? 0, endRow: (runs[runs.length - 2] ?? -1) + 1, runs };
}

/** The silhouette of an instance laid on the ground, away from the sun. Crisp, drawn once per pixel so it never doubles up. */
function castShadow(r: Renderer, a: AtmosphereActor, sunKey: string, dx: number, dy: number, color: string, opacity: number, camX: number, camY: number, zoom: number, viewW: number, viewH: number, clock: number): void {
  const asset = a.asset;
  if (!asset?.frames?.length || !asset.name || !r.spriteMask) return;
  const frame = a.frameIndex?.() ?? 0;
  const f = asset.frames[frame] ?? asset.frames[0];
  let entry = castShapes.get(asset);
  if (!entry || entry.sun !== sunKey) castShapes.set(asset, (entry = { sun: sunKey, shapes: new Map() }));
  const key = frame * 2 + (a.flipX ? 1 : 0);
  let shape = entry.shapes.get(key);
  if (shape === undefined) {
    const mask = r.spriteMask(asset.name, f.x, f.y, f.w, f.h);
    if (!mask) return; // Not available yet: the sheet may still be loading, so nothing is remembered.
    shape = buildCastShape(mask, f.w, !!a.flipX, dx, dy);
    entry.shapes.set(key, shape);
  }
  if (!shape) return;
  const left = Math.round((a.x + (a.type.spriteOffset?.x ?? 0) - shape.reachX - camX) * zoom);
  const top = Math.round((a.y + (a.type.spriteOffset?.y ?? 0) + shape.bottom - shape.reachY - camY) * zoom);
  if (left + shape.width * zoom < 0 || left > viewW || top + shape.height * zoom < 0 || top > viewH) return;
  // Wind: each row of ground is the shadow of one height of the plant, so it moves as that row of the sprite does.
  // With the sun exactly at the side every height falls on the same rows, and there is nothing to separate.
  let bands: SwayBand[] | undefined;
  if (a.type.sway && Math.abs(dy) >= 0.05 && Number.isInteger(zoom)) {
    const shift = swayShift(a.type.sway, swayBase(a.type, f.h), a.x, a.y, clock);
    const { bottom, reachY } = shape;
    bands = groupRows(shape.firstRow, shape.endRow, (row) => shift(Math.round(bottom - (row - reachY) / dy)));
  }
  if (r.stamp) {
    if (!bands) return r.stamp(shape, left, top, zoom, color, opacity);
    for (const b of bands) r.stamp(shape, left + b.offset * zoom, top, zoom, color, opacity, b);
    return;
  }
  const runs = shape.runs;
  for (const b of bands ?? [{ row: shape.firstRow, rows: shape.endRow - shape.firstRow, offset: 0 }]) {
    for (let i = 0; i < runs.length; i += 3) {
      const y = runs[i + 1]!;
      if (y >= b.row && y < b.row + b.rows) r.rect(left + (runs[i]! + b.offset) * zoom, top + y * zoom, runs[i + 2]! * zoom, zoom, color, opacity);
    }
  }
}

/** Is this instance (plus `margin` world pixels around it) off the screen? Cheap enough to ask before anything else. */
function offView(a: AtmosphereActor, camX: number, camY: number, zoom: number, viewW: number, viewH: number, margin: number): boolean {
  const w = a.asset?.width ?? 0;
  const h = a.asset?.height ?? 0;
  const ox = a.type.spriteOffset?.x ?? 0;
  const oy = a.type.spriteOffset?.y ?? 0;
  return (a.x + ox + w + margin - camX) * zoom < 0 || (a.y + oy + h + margin - camY) * zoom < 0 || (a.x + ox - margin - camX) * zoom > viewW || (a.y + oy - margin - camY) * zoom > viewH;
}

/** Soft elliptical contact shadows under the instances (drawn above the ground, below the instances), and the sun's cast shadows. */
export function drawShadows(w: AtmosphereWorld, r: Renderer, atm: SceneAtmosphere, camX: number, camY: number, zoom: number): void {
  if (atm.shadows === false) return;
  const color = atm.shadowColor ?? '#1a1030';
  const op = atm.shadowOpacity ?? 0.38;
  const sun = atm.relief?.sun;
  const viewW = w.game.width;
  const viewH = w.game.height;
  let casting = false;
  if (sun) {
    const angle = ((sun.angle ?? -135) * Math.PI) / 180;
    const elevation = (Math.max(15, sun.elevation ?? 50) * Math.PI) / 180;
    const length = Math.min(1.6, 1 / Math.tan(elevation));
    // Away from the sun; the ground recedes, so distances along y are shorter on screen.
    const dx = -Math.cos(angle) * length;
    const dy = -Math.sin(angle) * length * 0.55;
    const sunKey = `${sun.angle}|${sun.elevation}`;
    const opacity = Math.min(0.8, op * 1.5 * (sun.intensity ?? 1));
    casting = opacity > 0 && !!r.spriteMask;
    for (const a of w.actors) {
      if (a.destroyed || !a.visible || a.type.hud || !a.asset || a.opacity <= 0 || a.type.shadow === 0 || a.z < 0) continue;
      // A shadow reaches at most as far as the sprite is tall, times the length of the shadow.
      if (offView(a, camX, camY, zoom, viewW, viewH, a.asset.height * 1.6 + 2)) continue;
      castShadow(r, a, sunKey, dx, dy, color, opacity, camX, camY, zoom, viewW, viewH, w.clock);
    }
  }
  for (const a of w.actors) {
    if (a.destroyed || !a.visible || a.type.hud || !a.asset || a.opacity <= 0) continue;
    // It already casts its silhouette: an ellipse too would be a second shadow.
    if (casting && a.z >= 0) continue;
    const sw = shadowWidth(a);
    if (sw <= 0 || offView(a, camX, camY, zoom, viewW, viewH, sw)) continue;
    const box = a.box();
    const cx = (box.x + box.w / 2 - camX) * zoom;
    const cy = (box.y + box.h - 1 - camY) * zoom;
    const rx = (sw / 2) * zoom;
    const ry = Math.max(1.5, Math.min(6, sw * 0.16)) * zoom;
    if (cx + rx < 0 || cx - rx > w.game.width || cy + ry < 0 || cy - ry > w.game.height) continue;
    // Two nested ellipses: a soft rim and a darker core.
    ellipse(r, cx, cy, rx, ry, color, op * 0.5 * a.opacity);
    ellipse(r, cx, cy, rx * 0.72, ry * 0.68, color, op * 0.5 * a.opacity);
  }
}

function ellipse(r: Renderer, cx: number, cy: number, rx: number, ry: number, color: string, alpha: number): void {
  const top = Math.round(cy - ry);
  const bottom = Math.round(cy + ry);
  for (let y = top; y < bottom; y++) {
    const t = (y + 0.5 - cy) / ry;
    const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    if (x1 > x0) r.rect(x0, y, x1 - x0, 1, color, alpha);
  }
}

/** Cloud shadows: the clouds sprite tiled over the world and moved by the wind. */
export function drawClouds(w: AtmosphereWorld, r: Renderer, atm: SceneAtmosphere, camX: number, camY: number, zoom: number): void {
  const c = atm.clouds;
  if (!c) return;
  const asset = w.bundle.sprites[c.sprite];
  if (!asset || !asset.frames.length) return;
  const f = asset.frames[0];
  const ox = w.clock * (c.speedX ?? 6) - camX;
  const oy = w.clock * (c.speedY ?? 2) - camY;
  const tw = f.w * zoom;
  const th = f.h * zoom;
  let sx = ((ox * zoom) % tw);
  if (sx > 0) sx -= tw;
  let sy = ((oy * zoom) % th);
  if (sy > 0) sy -= th;
  const opts = { flipX: false, opacity: c.opacity ?? 0.35, angle: 0, ...(zoom !== 1 ? { scale: zoom } : {}) };
  for (let y = sy; y < w.game.height; y += th) for (let x = sx; x < w.game.width; x += tw) r.image(asset.name, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), opts);
}

/** The full-frame passes: lighting, color grade, vignette. */
export function postProcess(w: AtmosphereWorld, r: Renderer, atm: SceneAtmosphere, camX: number, camY: number, zoom: number): void {
  const ambient = atm.ambient ?? '#ffffff';
  const lights = collectLights(w, camX, camY, zoom);
  const dark = !WHITE.test(ambient);
  // Glow belongs to the dark: in daylight lamps don't bloom.
  const glow = (atm.glow ?? 0.6) * Math.min(1, Math.max(0, (1 - luminance(ambient)) * 1.8));
  if (atm.relief && r.reliefLighting) r.reliefLighting(resolveRelief(atm.relief), dark ? ambient : '#ffffff', lights, glow);
  else if ((dark || (lights.length && glow > 0)) && r.lighting) r.lighting(dark ? ambient : '#ffffff', lights, glow);
  else if (dark) r.rect(0, 0, w.game.width, w.game.height, ambient, 0.35);
  if (atm.tint && (atm.tintAmount ?? 0.3) > 0) {
    if (r.grade) r.grade(atm.tint, atm.tintAmount ?? 0.3);
    else r.rect(0, 0, w.game.width, w.game.height, atm.tint, (atm.tintAmount ?? 0.3) * 0.4);
  }
  if (atm.vignette && r.vignette) r.vignette(atm.vignette, atm.vignetteColor ?? '#0b0614');
}

// ---------------------------------------------------------------------------
// Ambient motes

interface MotePreset {
  colors: string[];
  size: [number, number];
  vx: [number, number];
  vy: [number, number];
  sway: number;
  life: [number, number];
  /** Glow radius (0 = none) and strength. */
  light: number;
  glow: number;
  alpha: number;
  blink?: boolean;
}

const MOTES: Record<SceneMotes['preset'], MotePreset> = {
  fireflies: { colors: ['#e8ff8a', '#fff5a8', '#c8ff70'], size: [1, 1], vx: [-6, 6], vy: [-6, 4], sway: 8, life: [3, 6], light: 9, glow: 0.7, alpha: 1, blink: true },
  dust: { colors: ['#fff6dc', '#ffe8b0'], size: [1, 1], vx: [2, 7], vy: [-3, 2], sway: 3, life: [4, 8], light: 0, glow: 0, alpha: 0.55 },
  snow: { colors: ['#ffffff', '#e4f0ff', '#cfe2ff'], size: [1, 2], vx: [-4, 6], vy: [10, 22], sway: 6, life: [6, 10], light: 0, glow: 0, alpha: 0.9 },
  embers: { colors: ['#ffcf5a', '#ff8a2a', '#ff5a1f'], size: [1, 1], vx: [-4, 4], vy: [-22, -10], sway: 7, life: [1.5, 3], light: 5, glow: 0.6, alpha: 1 },
  leaves: { colors: ['#86c24a', '#c9a640', '#e07a3a', '#5fa040'], size: [2, 2], vx: [6, 16], vy: [8, 16], sway: 12, life: [5, 8], light: 0, glow: 0, alpha: 0.95 },
  spores: { colors: ['#9ff0ff', '#d0a8ff', '#a8ffd8'], size: [1, 1], vx: [-3, 3], vy: [-8, -3], sway: 5, life: [4, 7], light: 6, glow: 0.5, alpha: 0.9, blink: true },
  bubbles: { colors: ['#c8f6ff', '#9fe6ff'], size: [1, 2], vx: [-2, 2], vy: [-14, -6], sway: 4, life: [2, 4], light: 0, glow: 0, alpha: 0.7 },
};

export interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  seed: number;
  sway: number;
  light: number;
  glow: number;
  /** Current visibility (fade in/out, blinking). */
  alpha: number;
  base: number;
  blink: boolean;
}

/** Floating ambient particles kept around the camera. Has its own random so gameplay stays deterministic. */
export class MoteField {
  list: Mote[] = [];
  private seed = 1234567;
  private config: SceneMotes | undefined;

  private rnd(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }
  private range([a, b]: [number, number]): number {
    return a + (b - a) * this.rnd();
  }

  reset(config: SceneMotes | undefined): void {
    this.config = config;
    this.list = [];
  }

  private spawn(view: { x: number; y: number; w: number; h: number }, p: MotePreset, initial: boolean): Mote {
    const colors = this.config?.color ? (Array.isArray(this.config.color) ? this.config.color : [this.config.color]) : p.colors;
    const life = this.range(p.life);
    // Falling things enter from the top, rising things from the bottom; the first batch fills the view.
    const fromTop = !initial && p.vy[0] > 6;
    const fromBottom = !initial && p.vy[1] < -2;
    return {
      x: view.x + this.rnd() * view.w,
      y: fromTop ? view.y - 4 : fromBottom ? view.y + view.h + 4 : view.y + this.rnd() * view.h,
      vx: this.range(p.vx),
      vy: this.range(p.vy),
      age: initial ? this.rnd() * life : 0,
      life,
      size: Math.round(this.range(p.size)),
      color: colors[Math.floor(this.rnd() * colors.length)] ?? '#ffffff',
      seed: this.rnd() * 100,
      sway: p.sway,
      light: p.light,
      glow: p.glow,
      alpha: 0,
      base: p.alpha,
      blink: !!p.blink,
    };
  }

  tick(dt: number, view: { x: number; y: number; w: number; h: number }): void {
    const c = this.config;
    if (!c) return;
    const p = MOTES[c.preset];
    if (!p) return;
    const want = c.count ?? 24;
    const initial = this.list.length === 0;
    const margin = 24;
    this.list = this.list.filter((m) => m.age < m.life && m.x > view.x - margin && m.x < view.x + view.w + margin && m.y > view.y - margin && m.y < view.y + view.h + margin);
    while (this.list.length < want) this.list.push(this.spawn(view, p, initial));
    for (const m of this.list) {
      m.age += dt;
      m.x += (m.vx + Math.sin(m.age * 1.3 + m.seed) * m.sway) * dt;
      m.y += m.vy * dt;
      const t = m.age / m.life;
      let a = Math.min(1, t * 5, (1 - t) * 5) * m.base;
      if (m.blink) a *= 0.55 + 0.45 * Math.sin(m.age * 3.1 + m.seed);
      m.alpha = Math.max(0, a);
    }
  }

  draw(r: Renderer, camX: number, camY: number, zoom: number): void {
    for (const m of this.list) {
      if (m.alpha <= 0.02) continue;
      const s = Math.max(1, Math.round(m.size * zoom));
      r.rect(Math.round((m.x - camX) * zoom), Math.round((m.y - camY) * zoom), s, s, m.color, m.alpha);
    }
  }
}
