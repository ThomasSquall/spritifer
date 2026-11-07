/**
 * Animation templates for top-down 4-direction characters built with the rig.
 *
 * Templates rely on conventional part names and simply skip parts the rig doesn't have:
 *   body (root, pivot at the hips), head (child of body, pivot at the neck),
 *   arm_l / arm_r (children of body, pivot at the shoulder), leg_l / leg_r (roots, pivot at the hip joint),
 *   weapon (child of the arm holding it, pivot at the grip), shadow (root, never moves),
 *   secondary parts that trail behind motion: names starting with cape, cloak, hair, scarf, tail, ear, ponytail.
 * "_l" / "_r" are the character's own left / right. Facing down, the character's right arm is on the screen left.
 */
import { type Facing, type PartPose, type Pose, type Sprite } from './sprite.js';
import { findPart, resolveView } from './rig.js';

export type AnimName = 'idle' | 'walk' | 'run' | 'attack' | 'hurt';
export const ANIMS: AnimName[] = ['idle', 'walk', 'run', 'attack', 'hurt'];

export interface AnimOptions {
  /** Frame count (looping animations only). */
  frames?: number;
  /** Amplitude multiplier (1 = default). */
  strength?: number;
  /** Override every frame duration (ms). */
  duration?: number;
}

export interface GeneratedAnim {
  poses: Pose[];
  durations: number[];
  loop: boolean;
}

const SECONDARY = /^(cape|cloak|hair|scarf|tail|ear|ponytail)/;
const DIR: Record<Facing, [number, number]> = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
const TAU = Math.PI * 2;

export const ANIM_DEFAULTS: Record<AnimName, { frames: number; duration: number; loop: boolean }> = {
  idle: { frames: 4, duration: 220, loop: true },
  walk: { frames: 8, duration: 100, loop: true },
  run: { frames: 6, duration: 80, loop: true },
  attack: { frames: 6, duration: 0, loop: false },
  hurt: { frames: 3, duration: 0, loop: false },
};

export function generateAnimation(s: Sprite, anim: AnimName, facing: Facing, opts: AnimOptions = {}): GeneratedAnim {
  const rig = s.rig;
  if (!rig) throw new Error('This sprite has no rig. Add parts with rig_part first.');
  const has = (n: string) => rig.parts.some((p) => p.name === n);
  const k = opts.strength ?? 1;
  const side = facing === 'left' || facing === 'right';
  const sx = facing === 'left' ? -1 : 1;
  const [fx, fy] = DIR[facing];
  const unit = Math.max(1, Math.round(s.height / 40));
  const r = (v: number) => Math.round(v) || 0;
  const heightOf = (n: string, fallback: number) => (has(n) ? (resolveView(s, findPart(rig, n), facing)?.bmp.height ?? fallback) : fallback);
  const legH = Math.max(heightOf('leg_l', 0), heightOf('leg_r', 0), Math.round(s.height / 4));
  const def = ANIM_DEFAULTS[anim];
  const n = def.loop ? Math.max(2, opts.frames ?? def.frames) : def.frames;
  const poses: Record<string, PartPose>[] = Array.from({ length: n }, () => ({}));
  const add = (i: number, name: string, v: PartPose) => {
    if (!has(name)) return;
    const p = (poses[i][name] ??= {});
    if (v.dx) p.dx = (p.dx ?? 0) + v.dx;
    if (v.dy) p.dy = (p.dy ?? 0) + v.dy;
    if (v.rot) p.rot = (p.rot ?? 0) + v.rot;
    if (v.variant) p.variant = v.variant;
    if (v.z !== undefined) p.z = v.z;
  };
  const variantExists = (name: string, variant: string) =>
    has(name) && Object.keys(findPart(rig, name).views).some((key) => key.endsWith(':' + variant));
  let durations: number[] = Array(n).fill(def.duration);
  const lagParts = new Set(rig.parts.filter((p) => SECONDARY.test(p.name)).map((p) => p.name));

  if (anim === 'idle') {
    for (let i = 0; i < n; i++) {
      const bob = i < n / 2 ? 0 : r(unit * k);
      add(i, 'body', { dy: bob });
    }
    // Arms settle a frame after the chest: reads as breathing instead of a rigid bounce.
    lagParts.add('arm_l').add('arm_r');
    if (variantExists('head', 'blink')) add(n - 1, 'head', { variant: 'blink' });
  }

  if (anim === 'walk' || anim === 'run') {
    const run = anim === 'run';
    const stride = Math.max(1, r(legH * (run ? 0.28 : 0.18) * k));
    const angle = (run ? 42 : 28) * k;
    const bobAmp = unit * k * (run ? 2 : 1);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const c = Math.cos(TAU * t);
      const sn = Math.sin(TAU * t);
      // Lowest when the legs are furthest apart (contact), highest while passing.
      add(i, 'body', { dy: r(bobAmp * (1 - Math.abs(sn))) });
      if (side) {
        add(i, 'leg_l', { rot: -sx * angle * c, dy: -r(unit * k * Math.max(0, sn)) });
        add(i, 'leg_r', { rot: sx * angle * c, dy: -r(unit * k * Math.max(0, -sn)) });
        add(i, 'arm_l', { rot: sx * angle * 0.8 * c });
        add(i, 'arm_r', { rot: -sx * angle * 0.8 * c });
        if (run) add(i, 'body', { dx: sx * r(unit * k) });
        if (run) add(i, 'head', { dx: sx * r(unit * k) });
      } else {
        // In a 3/4 top-down view a foot stepping toward the camera sits lower on screen.
        const f = facing === 'down' ? 1 : -1;
        add(i, 'leg_l', { dy: r(f * stride * c) });
        add(i, 'leg_r', { dy: r(-f * stride * c) });
        const swing = Math.max(1, r(stride * 0.6));
        add(i, 'arm_l', { dy: r(-f * swing * c) });
        add(i, 'arm_r', { dy: r(f * swing * c) });
      }
    }
    // Capes and hair trail behind the direction of travel.
    for (const p of lagParts) for (let i = 0; i < n; i++) add(i, p, { dx: -fx * r(unit * k * (run ? 2 : 1)) });
  }

  if (anim === 'attack') {
    const weaponArm = has('weapon') ? (findPart(rig, 'weapon').parent ?? 'arm_r') : 'arm_r';
    const otherArm = weaponArm === 'arm_l' ? 'arm_r' : 'arm_l';
    // Overhead slash: wind-up behind, fast strike across, follow-through, recover.
    const swing = [100, 140, 230, 290, 320, 345];
    const lunge = [0, -1, 1, 1, 0, 0];
    const mirror = facing === 'left' || facing === 'up' ? -1 : 1;
    durations = [70, 140, 50, 70, 100, 110];
    for (let i = 0; i < n; i++) {
      add(i, weaponArm, { rot: mirror * swing[i] * Math.min(1.2, k) });
      add(i, otherArm, { rot: mirror * -[10, 20, -15, -25, -15, -5][i] });
      add(i, 'body', { dx: fx * r(lunge[i] * unit * k), dy: fy * r(lunge[i] * unit * k) });
      add(i, 'head', { dx: fx * r(lunge[i] * unit * k * 0.5), dy: fy * r(lunge[i] * unit * k * 0.5) });
    }
    // Keep the blade readable: it passes in front of the head where it is closest to the camera.
    const front: Record<Facing, number[]> = { down: [2, 3, 4, 5], left: [1, 2, 3, 4], right: [1, 2, 3, 4], up: [0, 1] };
    for (const i of front[facing]) add(i, weaponArm, { z: 50 });
    // Smear arcs on the fast frames, trailing back to the previous angle.
    for (const i of [2, 3]) {
      const p = poses[i][weaponArm];
      if (p) p.smear = mirror * (swing[i] - swing[i - 1]) * Math.min(1.2, k);
    }
  }

  if (anim === 'hurt') {
    const knock = [2, 1, 0];
    durations = [80, 120, 140];
    // The whole character is pushed back (every root but the ground shadow), so limbs never detach.
    const roots = rig.parts.filter((p) => !p.parent && p.name !== 'shadow').map((p) => p.name);
    for (let i = 0; i < n; i++) {
      const d = r(knock[i] * unit * k);
      for (const root of roots) add(i, root, { dx: -fx * d, dy: -fy * d });
      // Head whiplash only sideways: a vertical offset would open a gap at the neck.
      if (side) add(i, 'head', { dx: -fx * r(d * 0.5) });
      add(i, 'arm_l', { rot: [25, 12, 0][i] });
      add(i, 'arm_r', { rot: -[25, 12, 0][i] });
      for (const p of ['head', 'body']) if (i < 2 && variantExists(p, 'hurt')) add(i, p, { variant: 'hurt' });
    }
  }

  applyLag(s, poses, lagParts, def.loop);

  if (opts.duration) durations = durations.map(() => opts.duration!);
  // Drop zero-valued fields so stored poses stay readable.
  const clean = poses.map((p) =>
    Object.fromEntries(
      Object.entries(p)
        .map(([name, v]) => [name, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== 0 && x !== undefined))] as const)
        .filter(([, v]) => Object.keys(v).length),
    ),
  );
  return { poses: clean.map((parts) => ({ facing, parts })), durations, loop: def.loop };
}

/** Secondary motion: a part keeps its previous world position for one frame (follow-through). */
function applyLag(s: Sprite, poses: Record<string, PartPose>[], parts: Set<string>, loop: boolean): void {
  const rig = s.rig!;
  const translation = (i: number, name: string | null): [number, number] => {
    let x = 0;
    let y = 0;
    for (let p = name; p; p = rig.parts.find((q) => q.name === p)?.parent ?? null) {
      x += poses[i][p]?.dx ?? 0;
      y += poses[i][p]?.dy ?? 0;
    }
    return [x, y];
  };
  const n = poses.length;
  const offsets = [...parts]
    .filter((name) => rig.parts.some((p) => p.name === name))
    .map((name) => {
      const parent = rig.parts.find((p) => p.name === name)!.parent;
      return {
        name,
        d: poses.map((_, i) => {
          const prev = i === 0 ? (loop ? n - 1 : 0) : i - 1;
          const [px, py] = translation(prev, parent);
          const [cx, cy] = translation(i, parent);
          return [px - cx, py - cy] as const;
        }),
      };
    });
  for (const { name, d } of offsets) {
    d.forEach(([dx, dy], i) => {
      if (!dx && !dy) return;
      const p = (poses[i][name] ??= {});
      p.dx = (p.dx ?? 0) + dx;
      p.dy = (p.dy ?? 0) + dy;
    });
  }
}

// ---------------------------------------------------------------------------
// Keyframes: author any animation as a few key poses; inbetweens are interpolated with easing.

export type Ease = 'linear' | 'in' | 'out' | 'inout' | 'step';

export interface Keyframe {
  /** Frame index within the animation. */
  frame: number;
  parts: Record<string, PartPose>;
  /** Easing from this key to the next (default inout). */
  ease?: Ease;
}

const EASE: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => t * t * (3 - 2 * t),
  step: () => 0,
};

const NUMERIC: Record<'dx' | 'dy' | 'rot' | 'sx' | 'sy', number> = { dx: 0, dy: 0, rot: 0, sx: 1, sy: 1 };

/** Interpolates key poses over `frames` frames. Looping animations ease from the last key back into the first. */
export function interpolateKeyframes(keys: Keyframe[], frames: number, loop: boolean): Record<string, PartPose>[] {
  if (!keys.length) throw new Error('Give at least one keyframe');
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  for (const k of sorted) if (k.frame < 0 || k.frame >= frames) throw new Error(`Keyframe at ${k.frame} is outside 0..${frames - 1}`);
  const names = [...new Set(sorted.flatMap((k) => Object.keys(k.parts)))];
  const out: Record<string, PartPose>[] = [];
  for (let i = 0; i < frames; i++) {
    let a = [...sorted].reverse().find((k) => k.frame <= i);
    let b = sorted.find((k) => k.frame > i);
    let aFrame = a?.frame ?? 0;
    let bFrame = b?.frame ?? 0;
    if (!a) {
      // Before the first key: loops come from the last key, one-shots hold the first pose.
      a = loop ? sorted[sorted.length - 1] : sorted[0];
      aFrame = loop ? a.frame - frames : i;
    }
    if (!b) {
      b = loop ? sorted[0] : a;
      bFrame = loop ? sorted[0].frame + frames : aFrame;
    }
    const raw = bFrame === aFrame ? 0 : (i - aFrame) / (bFrame - aFrame);
    const t = EASE[a.ease ?? 'inout'](Math.max(0, Math.min(1, raw)));
    const pose: Record<string, PartPose> = {};
    for (const name of names) {
      const pa = a.parts[name] ?? {};
      const pb = b.parts[name] ?? {};
      const p: PartPose = { ...pa };
      for (const [key, def] of Object.entries(NUMERIC) as [keyof typeof NUMERIC, number][]) {
        const va = pa[key] ?? def;
        const vb = pb[key] ?? def;
        const v = Math.round((va + (vb - va) * t) * 100) / 100;
        if (v !== def) p[key] = v;
        else delete p[key];
      }
      if (Object.keys(p).length) pose[name] = p;
    }
    out.push(pose);
  }
  return out;
}
