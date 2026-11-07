/**
 * Cut-out ("paper doll") character rig.
 *
 * A character is a set of small part bitmaps (body, head, arms, legs, cape, weapon...) arranged in a hierarchy.
 * Each part has one drawing per facing (down / left / right / up) and optional named variants ("down:blink").
 * A frame stores a pose — per-part offsets and rotations — which is baked into the rig layer.
 * Fixing a part once re-renders every posed frame, and animations become pose data instead of redrawn pixels.
 */
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { getPixel, setPixel } from './draw.js';
import { type RGBA, parseColor } from './color.js';
import {
  type Bitmap,
  type Facing,
  type PartPose,
  type PartView,
  type Pose,
  type Rig,
  type RigPart,
  type Sprite,
  FACINGS,
  addLayer,
  celBitmap,
  resolveFrame,
} from './sprite.js';

export const RIG_LAYER_NAME = 'rig';

export function isFacing(v: string): v is Facing {
  return (FACINGS as string[]).includes(v);
}

export function viewKey(facing: Facing, variant?: string): string {
  return variant ? `${facing}:${variant}` : facing;
}

export function viewBitmap(v: PartView): Bitmap {
  const bytes = base64ToBytes(v.pixels);
  return { width: v.width, height: v.height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length) };
}

export function bitmapToView(b: Bitmap, pivot: [number, number], at?: [number, number], z?: number): PartView {
  return { width: b.width, height: b.height, pixels: bytesToBase64(b.data), pivot, ...(at ? { at } : {}), ...(z !== undefined ? { z } : {}) };
}

/** Ensures the sprite has a rig and a layer to bake it into. */
export function ensureRig(s: Sprite): Rig {
  if (!s.rig) {
    const existing = s.layers.find((l) => l.name === RIG_LAYER_NAME);
    s.rig = { layer: (existing ?? addLayer(s, RIG_LAYER_NAME)).id, parts: [] };
  }
  if (!s.layers.some((l) => l.id === s.rig!.layer)) s.rig.layer = addLayer(s, RIG_LAYER_NAME).id;
  return s.rig;
}

export function findPart(rig: Rig, name: string): RigPart {
  const p = rig.parts.find((x) => x.name === name);
  if (!p) throw new Error(`No rig part named "${name}". Parts: ${rig.parts.map((x) => x.name).join(', ') || 'none'}`);
  return p;
}

export function partDepth(rig: Rig, part: RigPart): number {
  let d = 0;
  for (let p = part; p.parent; p = findPart(rig, p.parent)) {
    if (++d > rig.parts.length) throw new Error(`Rig parent cycle at "${part.name}"`);
  }
  return d;
}

/** Parts ordered parents-first. */
export function topoParts(rig: Rig): RigPart[] {
  return [...rig.parts].sort((a, b) => partDepth(rig, a) - partDepth(rig, b));
}

// ---------------------------------------------------------------------------
// View resolution (variants + left/right mirroring)

export interface ResolvedView {
  bmp: Bitmap;
  pivot: [number, number];
  at: [number, number];
  z: number;
  mirrored: boolean;
}

function flipBitmap(b: Bitmap): Bitmap {
  const out: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data.length) };
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) setPixel(out, b.width - 1 - x, y, getPixel(b, x, y));
  return out;
}

const OPPOSITE: Partial<Record<Facing, Facing>> = { left: 'right', right: 'left' };

/**
 * Finds the drawing of a part for a facing. Lookup order: own variant, mirrored variant, own base, mirrored base.
 * Variants inherit `at` and `z` from the base view.
 */
export function resolveView(s: Sprite, part: RigPart, facing: Facing, variant?: string): ResolvedView | null {
  const mirrorFacing = OPPOSITE[facing];
  const candidates: [string, boolean][] = [];
  if (variant) {
    candidates.push([viewKey(facing, variant), false]);
    if (mirrorFacing) candidates.push([viewKey(mirrorFacing, variant), true]);
  }
  candidates.push([facing, false]);
  if (mirrorFacing) candidates.push([mirrorFacing, true]);
  const hit = candidates.find(([k]) => part.views[k]);
  if (!hit) return null;
  const [key, mirrored] = hit;
  const view = part.views[key];
  const baseFacing = mirrored ? mirrorFacing! : facing;
  const base = part.views[baseFacing] ?? view;
  const at = view.at ?? base.at ?? [0, 0];
  const z = view.z ?? base.z ?? 0;
  let bmp = viewBitmap(view);
  let pivot: [number, number] = [...view.pivot];
  let pos: [number, number] = [...at];
  if (mirrored) {
    bmp = flipBitmap(bmp);
    pivot = [view.width - 1 - pivot[0], pivot[1]];
    pos = part.parent ? [-at[0], at[1]] : [s.width - 1 - at[0], at[1]];
  }
  return { bmp, pivot, at: pos, z, mirrored };
}

/** Facings for which at least one part has a drawing (directly or mirrored). */
export function rigFacings(s: Sprite): Facing[] {
  if (!s.rig) return [];
  return FACINGS.filter((f) => s.rig!.parts.some((p) => resolveView(s, p, f)));
}

// ---------------------------------------------------------------------------
// RotSprite: rotate pixel art without destroying it (Scale2x ×3, nearest-neighbor rotate, sample back).

function same(d: Uint8ClampedArray, i: number, j: number): boolean {
  return d[i] === d[j] && d[i + 1] === d[j + 1] && d[i + 2] === d[j + 2] && d[i + 3] === d[j + 3];
}

export function scale2x(b: Bitmap): Bitmap {
  const W = b.width;
  const H = b.height;
  const out: Bitmap = { width: W * 2, height: H * 2, data: new Uint8ClampedArray(W * H * 16) };
  const d = b.data;
  const o = out.data;
  const idx = (x: number, y: number) => (Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 4;
  const put = (x: number, y: number, src: number) => {
    const t = (y * W * 2 + x) * 4;
    o[t] = d[src];
    o[t + 1] = d[src + 1];
    o[t + 2] = d[src + 2];
    o[t + 3] = d[src + 3];
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const P = idx(x, y);
      const A = idx(x, y - 1);
      const B = idx(x + 1, y);
      const C = idx(x - 1, y);
      const D = idx(x, y + 1);
      put(2 * x, 2 * y, same(d, C, A) && !same(d, C, D) && !same(d, A, B) ? A : P);
      put(2 * x + 1, 2 * y, same(d, A, B) && !same(d, A, C) && !same(d, B, D) ? B : P);
      put(2 * x, 2 * y + 1, same(d, D, C) && !same(d, D, B) && !same(d, C, A) ? C : P);
      put(2 * x + 1, 2 * y + 1, same(d, B, D) && !same(d, B, A) && !same(d, D, C) ? D : P);
    }
  }
  return out;
}

const UPSCALE = 8;
const upscaleCache = new WeakMap<Uint8ClampedArray, Bitmap>();

function upscaled(b: Bitmap): Bitmap {
  let u = upscaleCache.get(b.data);
  if (!u) {
    u = scale2x(scale2x(scale2x(b)));
    upscaleCache.set(b.data, u);
  }
  return u;
}

/**
 * Draws `src` onto `dst` so that its pivot pixel lands on (wx, wy), rotated `deg` degrees clockwise.
 * Multiples of 90° are exact; other angles use RotSprite.
 */
export function drawRotated(dst: Bitmap, src: Bitmap, pivot: [number, number], wx: number, wy: number, deg: number, sx = 1, sy = 1): void {
  const a = ((((deg % 360) + 360) % 360) * Math.PI) / 180;
  const scaled = sx !== 1 || sy !== 1;
  const right = Math.abs(Math.round(deg / 90) * 90 - deg) < 0.5 && !scaled;
  const cos = right ? Math.round(Math.cos(a)) : Math.cos(a);
  const sin = right ? Math.round(Math.sin(a)) : Math.sin(a);
  const up = right ? null : upscaled(src);
  // Bounding box of the rotated part in destination space.
  const corners = [
    [-pivot[0] - 0.5, -pivot[1] - 0.5],
    [src.width - pivot[0] - 0.5, -pivot[1] - 0.5],
    [-pivot[0] - 0.5, src.height - pivot[1] - 0.5],
    [src.width - pivot[0] - 0.5, src.height - pivot[1] - 0.5],
  ].map(([x, y]) => [x * sx * cos - y * sy * sin, x * sx * sin + y * sy * cos]);
  const minX = Math.floor(Math.min(...corners.map((c) => c[0]))) - 1;
  const maxX = Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1;
  const minY = Math.floor(Math.min(...corners.map((c) => c[1]))) - 1;
  const maxY = Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1;
  for (let oy = minY; oy <= maxY; oy++) {
    for (let ox = minX; ox <= maxX; ox++) {
      const tx = wx + ox;
      const ty = wy + oy;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      // Inverse rotation of the destination pixel center into part space.
      const lx = (ox * cos + oy * sin) / sx + pivot[0] + 0.5;
      const ly = (-ox * sin + oy * cos) / sy + pivot[1] + 0.5;
      let c;
      if (up) c = getPixel(up, Math.floor(lx * UPSCALE), Math.floor(ly * UPSCALE));
      else c = getPixel(src, Math.floor(lx), Math.floor(ly));
      if (c[3] === 0) continue;
      setPixel(dst, tx, ty, c);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering

export interface PlacedPart {
  part: RigPart;
  view: ResolvedView | null;
  /** World position of the pivot (float, screen pixels). */
  x: number;
  y: number;
  rot: number;
  sx: number;
  sy: number;
  z: number;
  hidden: boolean;
}

/** Computes world transforms for every part: children follow their parent's position and rotation. */
export function layoutPose(s: Sprite, pose: Pose): PlacedPart[] {
  const rig = s.rig;
  if (!rig) return [];
  const placed = new Map<string, PlacedPart>();
  for (const part of topoParts(rig)) {
    const pp: PartPose = pose.parts[part.name] ?? {};
    const view = resolveView(s, part, pose.facing, pp.variant);
    const at = view?.at ?? [0, 0];
    let x: number;
    let y: number;
    let rot = pp.rot ?? 0;
    if (part.parent) {
      const parent = placed.get(part.parent)!;
      const a = (parent.rot * Math.PI) / 180;
      x = parent.x + at[0] * Math.cos(a) - at[1] * Math.sin(a);
      y = parent.y + at[0] * Math.sin(a) + at[1] * Math.cos(a);
      rot += parent.rot;
    } else {
      x = at[0];
      y = at[1];
    }
    x += pp.dx ?? 0;
    y += pp.dy ?? 0;
    placed.set(part.name, { part, view, x, y, rot, sx: pp.sx ?? 1, sy: pp.sy ?? 1, z: pp.z ?? view?.z ?? 0, hidden: !!pp.hide });
  }
  return rig.parts.map((p) => placed.get(p.name)!);
}

function silhouette(b: Bitmap, c: RGBA): Bitmap {
  const out: Bitmap = { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data.length) };
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3]) out.data.set(c, i);
  return out;
}

function descendants(rig: Rig, name: string): string[] {
  const out: string[] = [];
  for (const p of rig.parts) if (p.parent === name) out.push(p.name, ...descendants(rig, p.name));
  return out;
}

/** Renders a pose into a new canvas-sized bitmap. */
export function renderPose(s: Sprite, pose: Pose): Bitmap {
  const out: Bitmap = { width: s.width, height: s.height, data: new Uint8ClampedArray(s.width * s.height * 4) };
  const layout = layoutPose(s, pose);
  const draws: { z: number; i: number; draw: () => void }[] = [];
  layout.forEach((p, i) => {
    if (p.view && !p.hidden) draws.push({ z: p.z, i, draw: () => drawRotated(out, p.view!.bmp, p.view!.pivot, Math.round(p.x), Math.round(p.y), p.rot, p.sx, p.sy) });
  });
  // Smears: re-lay the pose at intermediate rotations and draw the trailing parts as solid arcs, just under them.
  for (const [name, pp] of Object.entries(pose.parts)) {
    if (!pp.smear || !s.rig) continue;
    const trail = descendants(s.rig, name);
    const targets = trail.length ? trail : [name];
    const color = parseColor(pp.smearColor ?? '#f2f6ff');
    const steps = Math.max(2, Math.ceil(Math.abs(pp.smear) / 7));
    for (let j = 1; j <= steps; j++) {
      const rot = (pp.rot ?? 0) - (pp.smear * j) / steps;
      const ghost = layoutPose(s, { ...pose, parts: { ...pose.parts, [name]: { ...pp, rot } } });
      for (const g of ghost) {
        if (!targets.includes(g.part.name) || !g.view || g.hidden) continue;
        const real = layout.find((p) => p.part.name === g.part.name)!;
        const sil = silhouette(g.view.bmp, color);
        draws.push({ z: real.z - 0.001, i: -1, draw: () => drawRotated(out, sil, g.view!.pivot, Math.round(g.x), Math.round(g.y), g.rot, g.sx, g.sy) });
      }
    }
  }
  draws.sort((a, b) => a.z - b.z || a.i - b.i);
  for (const d of draws) d.draw();
  return out;
}

/** Re-renders the rig layer of every frame that has a pose (or only `frames`). Returns the number of baked frames. */
export function bakeRig(s: Sprite, frames?: number[]): number {
  if (!s.rig) return 0;
  ensureRig(s);
  let n = 0;
  const idx = frames ?? s.frames.map((_, i) => i);
  for (const i of idx) {
    const f = resolveFrame(s, i);
    if (!f.pose) continue;
    const img = renderPose(s, f.pose);
    celBitmap(s, s.rig.layer, f.id).data.set(img.data);
    n++;
  }
  return n;
}

export function restPose(facing: Facing): Pose {
  return { facing, parts: {} };
}

/** Human-readable summary of the rig for tool output. */
export function describeRig(s: Sprite): string {
  if (!s.rig) return 'Rig: none';
  const facings = rigFacings(s);
  const lines = [`Rig: ${s.rig.parts.length} part(s), facings with art: ${facings.join(', ') || 'none'}, baked into layer "${s.layers.find((l) => l.id === s.rig!.layer)?.name}"`];
  for (const p of topoParts(s.rig)) {
    const keys = Object.keys(p.views);
    const own = FACINGS.filter((f) => p.views[f]);
    const mirrored = FACINGS.filter((f) => !p.views[f] && OPPOSITE[f] && p.views[OPPOSITE[f]!]);
    const missing = FACINGS.filter((f) => !p.views[f] && !mirrored.includes(f));
    const variants = [...new Set(keys.filter((k) => k.includes(':')).map((k) => k.split(':')[1]))];
    const sample = p.views[own[0]];
    lines.push(
      `- ${p.name}${p.parent ? ` (child of ${p.parent})` : ' (root)'}: ` +
        own.map((f) => `${f} ${p.views[f].width}x${p.views[f].height} pivot ${p.views[f].pivot.join(',')} at ${(p.views[f].at ?? [0, 0]).join(',')} z ${p.views[f].z ?? 0}`).join('; ') +
        (mirrored.length ? `; mirrored: ${mirrored.join(', ')}` : '') +
        (missing.length && sample ? `; MISSING: ${missing.join(', ')}` : '') +
        (variants.length ? `; variants: ${variants.join(', ')}` : ''),
    );
  }
  const posed = s.frames.map((f, i) => (f.pose ? `${i}:${f.pose.facing}` : null)).filter(Boolean);
  lines.push(`Posed frames: ${posed.length ? posed.join(' ') : 'none'}`);
  return lines.join('\n');
}
