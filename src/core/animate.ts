/**
 * Animation generator for characters built with the rig.
 *
 * Motion is authored as key-pose curves (contact, down, passing, up), not sine waves. Feet are placed on the ground with
 * two-bone IK when the legs are split into segments, so they stay planted while the hips move above them.
 *
 * Templates rely on conventional part names and simply skip parts the rig doesn't have:
 *   body (root, pivot at the hips), head (child of body, pivot at the neck),
 *   arm_l / arm_r (children of body, pivot at the shoulder), forearm_l / forearm_r (children of the arms, pivot at the elbow),
 *   leg_l / leg_r (roots, pivot at the hip joint), shin_l / shin_r (children of the legs, pivot at the knee), foot_l / foot_r
 *   (children of the shins, pivot at the ankle), weapon (child of the arm holding it, pivot at the grip), shadow (root, never moves),
 *   secondary parts that trail behind motion: names starting with cape, cloak, hair, scarf, tail, ear, ponytail.
 * "_l" / "_r" are the character's own left / right. Facing down, the character's right arm is on the screen left.
 *
 * The body plan is detected from the part names: leg_fl/leg_fr/leg_bl/leg_br make a quadruped, a rig with no legs and no
 * arms is a blob (slime, ghost) animated by squash and stretch, everything else is a biped.
 */
import { solveTwoBone } from './ik.js';
import { type Facing, type PartPose, type Pose, type Sprite } from './sprite.js';
import { bottomRow, findPart, layoutPose, limbChain, type LimbChain, resolveView, restPose } from './rig.js';

export type AnimName = 'idle' | 'walk' | 'run' | 'attack' | 'hurt' | 'jump' | 'fall' | 'land';
export const ANIMS: AnimName[] = ['idle', 'walk', 'run', 'attack', 'hurt', 'jump', 'fall', 'land'];

export type AnimStyle = 'normal' | 'heavy' | 'light';
export const ANIM_STYLES: AnimStyle[] = ['normal', 'heavy', 'light'];

export type BodyPlan = 'biped' | 'quadruped' | 'blob';

export interface AnimOptions {
  /** Frame count (looping animations only). */
  frames?: number;
  /** Amplitude multiplier (1 = default). */
  strength?: number;
  /** Override every frame duration (ms). */
  duration?: number;
  /** How the character carries its weight. */
  style?: AnimStyle;
}

export interface GeneratedAnim {
  poses: Pose[];
  durations: number[];
  loop: boolean;
}

const SECONDARY = /^(cape|cloak|hair|scarf|tail|ear|ponytail)/;
const DIR: Record<Facing, [number, number]> = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] };
const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;

export const ANIM_DEFAULTS: Record<AnimName, { frames: number; duration: number; loop: boolean }> = {
  idle: { frames: 4, duration: 220, loop: true },
  walk: { frames: 8, duration: 100, loop: true },
  run: { frames: 6, duration: 80, loop: true },
  attack: { frames: 6, duration: 0, loop: false },
  hurt: { frames: 3, duration: 0, loop: false },
  jump: { frames: 3, duration: 0, loop: false },
  fall: { frames: 2, duration: 120, loop: true },
  land: { frames: 3, duration: 0, loop: false },
};

const STYLES: Record<AnimStyle, { stride: number; bob: number; lean: number; arms: number; tempo: number; crouch: number }> = {
  normal: { stride: 1, bob: 1, lean: 0, arms: 1, tempo: 1, crouch: 1 },
  heavy: { stride: 0.8, bob: 1.6, lean: 2, arms: 0.6, tempo: 1.25, crouch: 1.35 },
  light: { stride: 1.15, bob: 0.7, lean: 4, arms: 1.2, tempo: 0.85, crouch: 0.7 },
};

type Curve = readonly (readonly [number, number])[];

/** Value of a cyclic curve of [phase, value] points at phase t. */
function sample(c: Curve, t: number): number {
  const p = ((t % 1) + 1) % 1;
  for (let i = 1; i < c.length; i++) {
    if (p <= c[i][0]) {
      const [a, va] = c[i - 1];
      const [b, vb] = c[i];
      return va + (vb - va) * (b > a ? (p - a) / (b - a) : 0);
    }
  }
  return c[c.length - 1][1];
}

interface Gait {
  /** Foot position along the walking direction, -1 (behind) to 1 (ahead). Phase 0 = this foot's contact. */
  x: Curve;
  /** Foot height, 0 = on the ground. */
  lift: Curve;
  /** Foot angle in degrees: negative = toes up (heel strike), positive = toes down (push off). */
  pitch: Curve;
  /** Hips over a full cycle: positive = down. */
  bob: Curve;
  stride: number;
  liftHeight: number;
  lean: number;
  arm: number;
  elbow: number;
  elbowSwing: number;
  drag: number;
  flap: number;
}

const WALK: Gait = {
  x: [[0, 1], [0.5, -1], [0.625, -0.6], [0.75, 0], [0.875, 0.7], [1, 1]],
  lift: [[0, 0], [0.5, 0], [0.625, 0.6], [0.75, 1], [0.875, 0.5], [1, 0]],
  pitch: [[0, -16], [0.12, 0], [0.42, 0], [0.5, 20], [0.625, 26], [0.75, 4], [0.9, -8], [1, -16]],
  bob: [[0, 0], [0.125, 1], [0.25, 0], [0.375, -1], [0.5, 0], [0.625, 1], [0.75, 0], [0.875, -1], [1, 0]],
  stride: 0.3,
  liftHeight: 0.28,
  lean: 0,
  arm: 24,
  elbow: 12,
  elbowSwing: 14,
  drag: 6,
  flap: 5,
};

const RUN: Gait = {
  x: [[0, 1], [0.3, -1], [0.45, -1.15], [0.65, -0.1], [0.85, 1.05], [1, 1]],
  lift: [[0, 0], [0.3, 0], [0.45, 0.8], [0.65, 1.2], [0.85, 0.5], [1, 0]],
  pitch: [[0, -10], [0.1, 0], [0.3, 18], [0.45, 35], [0.65, 20], [0.85, -6], [1, -10]],
  bob: [[0, 0.6], [0.1, 1.4], [0.3, -0.4], [0.42, -1.2], [0.5, 0.6], [0.6, 1.4], [0.8, -0.4], [0.92, -1.2], [1, 0.6]],
  stride: 0.5,
  liftHeight: 0.5,
  lean: 9,
  arm: 42,
  elbow: 70,
  elbowSwing: 20,
  drag: 16,
  flap: 8,
};

/** One-shot and airborne poses, as fractions of the leg length; one entry per frame. */
const AIR: Record<'jump' | 'fall' | 'land', { hip: number[]; x: number[][]; lift: number[][]; pitch: number[]; arm: number[]; forearm: number[]; lean: number[]; drag: number[]; durations: number[] }> = {
  jump: {
    hip: [0.35, -0.15, -0.1],
    x: [[0.12, -0.12], [0.1, -0.25], [0.35, -0.3]],
    lift: [[0, 0], [0.05, 0.2], [0.2, 0.45]],
    pitch: [0, 18, 10],
    arm: [35, -75, -120],
    forearm: [20, 12, 30],
    lean: [10, -4, 0],
    drag: [4, -18, -12],
    durations: [90, 60, 120],
  },
  fall: {
    hip: [-0.05, 0],
    x: [[0.3, -0.25], [0.25, -0.3]],
    lift: [[0.35, 0.15], [0.3, 0.2]],
    pitch: [12, 8],
    arm: [-150, -140],
    forearm: [15, 25],
    lean: [0, 0],
    drag: [-30, -24],
    durations: [120, 120],
  },
  land: {
    hip: [0.45, 0.2, 0.05],
    x: [[0.14, -0.14], [0.1, -0.1], [0.04, -0.04]],
    lift: [[0, 0], [0, 0], [0, 0]],
    pitch: [0, 0, 0],
    arm: [25, 12, 4],
    forearm: [30, 15, 4],
    lean: [14, 6, 1],
    drag: [14, 6, 0],
    durations: [70, 90, 100],
  },
};

/** Symmetric rounding: mirrored facings get exactly mirrored numbers. */
const rs = (v: number) => Math.sign(v) * Math.round(Math.abs(v)) || 0;
const tenth = (v: number) => (Math.sign(v) * Math.round(Math.abs(v) * 10)) / 10 || 0;

export function bodyPlan(s: Sprite): BodyPlan {
  const names = s.rig?.parts.map((p) => p.name) ?? [];
  if (names.includes('leg_fl') || names.includes('leg_bl')) return 'quadruped';
  if (!names.some((n) => /^(leg|arm)_/.test(n))) return 'blob';
  return 'biped';
}

interface Leg {
  name: string;
  id: string;
  phase: number;
  root: boolean;
  hip: [number, number];
  ankle: [number, number];
  length: number;
  chain: LimbChain | null;
}

const LEG_PHASE: Record<string, { walk: number; run: number }> = {
  l: { walk: 0, run: 0 },
  r: { walk: 0.5, run: 0.5 },
  bl: { walk: 0, run: 0.5 },
  fl: { walk: 0.25, run: 0 },
  br: { walk: 0.5, run: 0.62 },
  fr: { walk: 0.75, run: 0.12 },
};

function findLegs(s: Sprite, facing: Facing): Leg[] {
  const rig = s.rig!;
  const rest = new Map(layoutPose(s, restPose(facing)).map((p) => [p.part.name, p]));
  const legs: Leg[] = [];
  const all = rig.parts.filter((p) => p.name.startsWith('leg_'));
  all.forEach((part, idx) => {
    const placed = rest.get(part.name);
    if (!placed?.view) return;
    const id = part.name.slice(4);
    const chain = limbChain(s, facing, part.name);
    let ankle: [number, number];
    if (chain?.tip) ankle = [rest.get(chain.tip)!.x, rest.get(chain.tip)!.y];
    else if (chain) {
      const low = rest.get(chain.lower)!;
      ankle = [low.x + chain.v[0], low.y + chain.v[1]];
    } else ankle = [placed.x, placed.y + bottomRow(placed.view.bmp) - placed.view.pivot[1]];
    const known = LEG_PHASE[id];
    const phase = known ? known.walk : idx / all.length;
    legs.push({ name: part.name, id, phase, root: !part.parent, hip: [placed.x, placed.y], ankle, length: Math.max(1, ankle[1] - placed.y), chain });
  });
  return legs;
}

export function generateAnimation(s: Sprite, anim: AnimName, facing: Facing, opts: AnimOptions = {}): GeneratedAnim {
  const rig = s.rig;
  if (!rig) throw new Error('This sprite has no rig. Add parts with rig_part first.');
  const plan = bodyPlan(s);
  const has = (n: string) => rig.parts.some((p) => p.name === n);
  const k = opts.strength ?? 1;
  const style = STYLES[opts.style ?? 'normal'];
  const side = facing === 'left' || facing === 'right';
  const sx = facing === 'left' ? -1 : 1;
  const [fx, fy] = DIR[facing];
  const unit = Math.max(1, Math.round(s.height / 40));
  const def = ANIM_DEFAULTS[anim];
  const n = def.loop ? Math.max(2, opts.frames ?? def.frames) : def.frames;
  const poses: Record<string, PartPose>[] = Array.from({ length: n }, () => ({}));
  const add = (i: number, name: string, v: PartPose) => {
    if (!has(name)) return;
    const p = (poses[i][name] ??= {});
    if (v.dx) p.dx = (p.dx ?? 0) + v.dx;
    if (v.dy) p.dy = (p.dy ?? 0) + v.dy;
    if (v.rot) p.rot = (p.rot ?? 0) + v.rot;
    if (v.sx !== undefined) p.sx = v.sx;
    if (v.sy !== undefined) p.sy = v.sy;
    if (v.variant) p.variant = v.variant;
    if (v.z !== undefined) p.z = v.z;
  };
  const variantExists = (name: string, variant: string) =>
    has(name) && Object.keys(findPart(rig, name).views).some((key) => key.endsWith(':' + variant));
  const forearm = (arm: string) => `forearm_${arm.slice(4)}`;
  const arms = ['arm_l', 'arm_r'].filter(has);
  const carriesWeapon = (arm: string) => {
    if (!has('weapon')) return false;
    const parent = findPart(rig, 'weapon').parent;
    return parent === arm || parent === forearm(arm);
  };

  let durations: number[] = Array(n).fill(Math.round(def.duration * style.tempo));
  const lagParts = new Set(rig.parts.filter((p) => SECONDARY.test(p.name)).map((p) => p.name));
  const secondary = [...lagParts];
  const legs = findLegs(s, facing);
  const legH = legs.length ? Math.max(...legs.map((l) => l.length)) : Math.round(s.height / 4);
  const pins: { i: number; foot: string; x: number; y: number }[] = [];

  /** Moves one leg: footX along the facing direction and lift above the ground, in pixels; hipDx/hipDy = where the hips went. */
  const placeLeg = (i: number, leg: Leg, footX: number, lift: number, pitch: number, hipDx: number, hipDy: number) => {
    if (side) {
      const tx = leg.ankle[0] + sx * footX;
      const ty = leg.ankle[1] - lift;
      if (leg.chain) {
        const hx = leg.hip[0] + hipDx;
        const hy = leg.hip[1] + hipDy;
        if (leg.root) add(i, leg.name, { dx: hipDx, dy: hipDy });
        const sol = solveTwoBone(leg.chain.u, leg.chain.v, [tx - hx, ty - hy], sx === 1 ? -1 : 1);
        add(i, leg.name, { rot: tenth(sol.upper) });
        add(i, leg.chain.lower, { rot: tenth(sol.lower) });
        if (leg.chain.tip) {
          add(i, leg.chain.tip, { rot: tenth(-(sol.upper + sol.lower) + sx * pitch) });
          pins.push({ i, foot: leg.chain.tip, x: Math.round(tx), y: Math.round(ty) });
        }
      } else {
        const rot = -Math.atan2(tx - leg.hip[0], ty - leg.hip[1]) * DEG;
        add(i, leg.name, { rot: tenth(rot), ...(leg.root ? { dy: -rs(lift) } : {}) });
      }
      return;
    }
    // Facing the camera or away: a foot stepping toward the camera sits lower on screen, a raised foot folds over the shin.
    const f = facing === 'down' ? 1 : -1;
    const depth = rs(f * footX * 0.5);
    if (leg.root) add(i, leg.name, { dy: depth });
    if (lift >= 0.5) {
      if (leg.chain?.tip) {
        add(i, leg.chain.tip, { dy: -rs(lift) });
        add(i, leg.chain.lower, { dy: -rs(lift * 0.5) });
      } else if (leg.root) add(i, leg.name, { dy: -rs(lift) });
    }
  };

  /** Keeps secondary parts swinging behind the motion. */
  const swingSecondary = (i: number, drag: number, flap: number, t: number) => {
    for (const p of secondary) {
      if (side) add(i, p, { rot: tenth(sx * (drag + flap * Math.sin(TAU * (2 * t - 0.15)))) });
    }
  };

  /** Applies a leg-straightening hip drop without moving the feet. */
  const anyChain = legs.some((l) => l.chain);

  if (plan === 'blob') return blobAnimation(s, anim, facing, n, def.loop, k, style.tempo, opts.duration);

  if (anim === 'idle') {
    const hips = [0, 0, 1, 1];
    for (let i = 0; i < n; i++) {
      const dip = rs(hips[Math.floor((i / n) * 4)] * unit * k);
      add(i, 'body', { dy: dip });
      for (const leg of legs) placeLeg(i, leg, 0, 0, 0, 0, anyChain ? dip : 0);
      swingSecondary(i, 0, 2 * k, i / n);
    }
    // Arms settle a frame after the chest: reads as breathing instead of a rigid bounce.
    lagParts.add('arm_l').add('arm_r');
    if (variantExists('head', 'blink')) add(n - 1, 'head', { variant: 'blink' });
    durations = durations.map((_, i) => Math.round(def.duration * style.tempo * (i % 2 === 0 ? 1.2 : 0.8)));
  }

  if (anim === 'walk' || anim === 'run') {
    const gait = anim === 'run' ? RUN : WALK;
    const stride = Math.max(1, legH * gait.stride * style.stride * k);
    const liftH = Math.max(1, legH * gait.liftHeight * k);
    // Legs at full stride are longer than hips-to-ground: the hips ride a little lower so the feet can reach the floor.
    const crouch = anyChain ? Math.ceil(legH - Math.sqrt(Math.max(0, legH * legH - stride * stride)) - 0.2) : 0;
    const bobAmp = unit * k * style.bob;
    const phaseOf = (leg: Leg) => {
      const known = LEG_PHASE[leg.id];
      return known ? known[anim] : leg.phase;
    };
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const hipDy = rs(sample(gait.bob, t) * bobAmp) + crouch;
      add(i, 'body', { dy: anyChain || !side ? hipDy : rs(sample(gait.bob, t) * bobAmp) });
      const lean = (gait.lean + style.lean) * Math.min(1.5, k);
      if (side && plan === 'biped') add(i, 'body', { rot: tenth(sx * lean) });
      if (!side && plan === 'biped') {
        // The weight moves over the planted foot.
        const sway = rs(sample([[0, 0], [0.25, 1], [0.5, 0], [0.75, -1], [1, 0]], t) * unit);
        add(i, 'body', { dx: sway });
      }
      if (anim === 'run' && side) add(i, 'head', { dx: sx * rs(unit * k) });
      for (const leg of legs) {
        const p = t + phaseOf(leg);
        placeLeg(i, leg, sample(gait.x, p) * stride, sample(gait.lift, p) * liftH, sample(gait.pitch, p), 0, leg.chain ? hipDy : 0);
      }
      for (const arm of arms) {
        const opposite = arm === 'arm_l' ? 0.5 : 0;
        const amp = gait.arm * style.arms * k * (carriesWeapon(arm) ? 0.4 : 1);
        const swing = sample(gait.x, t + opposite - 0.06);
        if (side) {
          add(i, arm, { rot: tenth(-sx * amp * swing) });
          const late = sample(gait.x, t + opposite - 0.14);
          // A held weapon keeps pointing roughly down: only an empty hand tucks in.
          const relax = carriesWeapon(arm) ? 0.25 : 1;
          add(i, forearm(arm), { rot: tenth(-sx * relax * (gait.elbow + gait.elbowSwing * Math.max(0, late))) });
        } else {
          const f = facing === 'down' ? 1 : -1;
          add(i, arm, { dy: rs(f * Math.max(1, stride * 0.6) * swing) });
        }
      }
      swingSecondary(i, gait.drag * k, gait.flap * k, t);
      for (const p of secondary) if (!side) add(i, p, { dx: -fx * rs(unit * k * (anim === 'run' ? 2 : 1)) });
    }
    // Contacts hold a little longer than the passing frames.
    durations = durations.map((d, i) => Math.round(d * (1 + 0.18 * Math.cos((TAU * 2 * i) / n))));
  }

  if (anim === 'attack') {
    const parent = has('weapon') ? findPart(rig, 'weapon').parent : null;
    const weaponArm = parent?.startsWith('forearm_') ? (findPart(rig, parent).parent ?? 'arm_r') : (parent ?? 'arm_r');
    const otherArm = weaponArm === 'arm_l' ? 'arm_r' : 'arm_l';
    // Overhead slash: wind-up behind, fast strike across, follow-through, recover.
    const swing = [100, 140, 230, 290, 320, 345];
    const flex = [30, 55, 15, 0, 0, 10];
    const twist = [-6, -12, 8, 14, 10, 3];
    const lunge = [0, -1, 1, 1, 0, 0];
    const hips = [0, 1, 0, 1, 1, 0];
    const front = [0, -0.2, 0.8, 1, 1, 0.5];
    const back = [0, 0.2, -0.4, -0.5, -0.5, -0.2];
    const stepLift = [0, 0, 1, 0, 0, 0];
    const mirror = facing === 'left' || facing === 'up' ? -1 : 1;
    durations = [70, 140, 50, 70, 100, 110].map((d) => Math.round(d * style.tempo));
    const stride = Math.max(1, legH * 0.3 * k);
    for (let i = 0; i < n; i++) {
      const dx = fx * rs(lunge[i] * unit * k);
      const dip = rs(hips[i] * unit * k * style.crouch);
      add(i, weaponArm, { rot: mirror * swing[i] * Math.min(1.2, k) });
      add(i, forearm(weaponArm), { rot: tenth(mirror * -flex[i]) });
      add(i, otherArm, { rot: mirror * -[10, 20, -15, -25, -15, -5][i] });
      add(i, forearm(otherArm), { rot: tenth(mirror * -[15, 25, 10, 5, 10, 15][i]) });
      add(i, 'body', { dx, dy: fy * rs(lunge[i] * unit * k) + dip });
      if (side) add(i, 'body', { rot: tenth(sx * twist[i] * Math.min(1.2, k)) });
      add(i, 'head', { dx: fx * rs(lunge[i] * unit * k * 0.5), dy: fy * rs(lunge[i] * unit * k * 0.5) });
      legs.forEach((leg, idx) => {
        const leading = idx === 0;
        const foot = (leading ? front[i] : back[i]) * stride;
        placeLeg(i, leg, foot, leading ? stepLift[i] * unit : 0, 0, side && leg.chain ? dx : 0, leg.chain ? dip : 0);
      });
      swingSecondary(i, [0, 4, 10, 14, 10, 4][i] * k, 0, 0);
    }
    // Keep the blade readable: it passes in front of the head where it is closest to the camera.
    const inFront: Record<Facing, number[]> = { down: [2, 3, 4, 5], left: [1, 2, 3, 4], right: [1, 2, 3, 4], up: [0, 1] };
    const restZ = (name: string) => (has(name) ? (resolveView(s, findPart(rig, name), facing)?.z ?? 0) : 0);
    for (const i of inFront[facing]) {
      add(i, weaponArm, { z: 50 });
      const base = restZ(weaponArm);
      // Seen from the front, the blade stays at its usual depth or it would cross the face.
      for (const name of side ? [forearm(weaponArm), 'weapon'] : [forearm(weaponArm)]) add(i, name, { z: 50 + (restZ(name) - base) * 0.01 });
    }
    // Smear arcs on the fast frames, trailing back to the previous angle.
    for (const i of [2, 3]) {
      const p = poses[i][weaponArm];
      if (p) p.smear = mirror * (swing[i] - swing[i - 1]) * Math.min(1.2, k);
    }
  }

  if (anim === 'hurt') {
    const knock = [2, 1, 0];
    durations = [80, 120, 140].map((d) => Math.round(d * style.tempo));
    // The whole character is pushed back (every root but the ground shadow), so limbs never detach.
    const roots = rig.parts.filter((p) => !p.parent && p.name !== 'shadow').map((p) => p.name);
    for (let i = 0; i < n; i++) {
      const d = rs(knock[i] * unit * k);
      for (const root of roots) add(i, root, { dx: -fx * d, dy: -fy * d });
      if (side) add(i, 'body', { rot: tenth(-sx * [12, 6, 0][i] * Math.min(1.5, k)) });
      // Head whiplash only sideways: a vertical offset would open a gap at the neck.
      if (side) add(i, 'head', { dx: -fx * rs(d * 0.5) });
      add(i, 'arm_l', { rot: [25, 12, 0][i] });
      add(i, 'arm_r', { rot: -[25, 12, 0][i] });
      add(i, 'forearm_l', { rot: tenth([20, 10, 0][i]) });
      add(i, 'forearm_r', { rot: tenth(-[20, 10, 0][i]) });
      for (const p of ['head', 'body']) if (i < 2 && variantExists(p, 'hurt')) add(i, p, { variant: 'hurt' });
      swingSecondary(i, [18, 8, 0][i] * k, 0, 0);
    }
  }

  if (anim === 'jump' || anim === 'fall' || anim === 'land') {
    const air = AIR[anim];
    durations = Array.from({ length: n }, (_, i) => Math.round(air.durations[i % air.durations.length] * style.tempo));
    for (let i = 0; i < n; i++) {
      const j = i % air.hip.length;
      const crouching = air.hip[j] > 0 ? style.crouch : 1;
      const hip = rs(air.hip[j] * legH * k * crouching);
      add(i, 'body', { dy: hip });
      if (side && plan === 'biped') add(i, 'body', { rot: tenth(sx * air.lean[j] * Math.min(1.5, k)) });
      legs.forEach((leg, idx) => {
        const which = idx % 2;
        placeLeg(i, leg, air.x[j][which] * legH * k, air.lift[j][which] * legH * k, air.pitch[j], 0, leg.chain ? hip : 0);
      });
      for (const arm of arms) {
        const weighted = carriesWeapon(arm) ? 0.5 : 1;
        if (side) {
          add(i, arm, { rot: tenth(sx * air.arm[j] * weighted * Math.min(1.2, k)) });
          add(i, forearm(arm), { rot: tenth(-sx * air.forearm[j] * (carriesWeapon(arm) ? 0.3 : 1)) });
        } else {
          // Seen from the front the arms open sideways. Facing down, the character's right arm is on the screen left.
          const outward = (arm === 'arm_r' ? 1 : -1) * (facing === 'down' ? 1 : -1);
          add(i, arm, { rot: tenth(outward * Math.abs(air.arm[j]) * 0.5 * weighted) });
        }
      }
      swingSecondary(i, air.drag[j] * k, 0, 0);
    }
  }

  // The head stays level while the torso leans or twists: small rotations would distort the face, and a level gaze reads better.
  if (anim !== 'hurt' && has('head')) {
    for (let i = 0; i < n; i++) {
      const lean = poses[i].body?.rot;
      if (lean) add(i, 'head', { rot: -lean });
    }
  }

  applyLag(s, poses, lagParts, def.loop);

  // Pin planted feet to the exact ground pixel: rounding along the chain must not make them wobble.
  for (const pin of pins) {
    const placed = layoutPose(s, { facing, parts: poses[pin.i] }).find((p) => p.part.name === pin.foot);
    if (!placed) continue;
    const dx = pin.x - placed.px;
    const dy = pin.y - placed.py;
    if (dx || dy) add(pin.i, pin.foot, { dx, dy });
  }

  if (opts.duration) durations = durations.map(() => opts.duration!);
  return { poses: tidy(poses).map((parts) => ({ facing, parts })), durations, loop: def.loop };
}

/** Drops zero-valued fields so stored poses stay readable. */
function tidy(poses: Record<string, PartPose>[]): Record<string, PartPose>[] {
  return poses.map((p) =>
    Object.fromEntries(
      Object.entries(p)
        .map(([name, v]) => [name, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== 0 && x !== undefined))] as const)
        .filter(([, v]) => Object.keys(v).length),
    ),
  );
}

/** Slimes and other limbless bodies: everything comes from squash and stretch, grounded at the bottom of the drawing. */
function blobAnimation(s: Sprite, anim: AnimName, facing: Facing, n: number, loop: boolean, k: number, tempo: number, duration?: number): GeneratedAnim {
  const rig = s.rig!;
  const root = rig.parts.find((p) => p.name === 'body') ?? rig.parts.find((p) => !p.parent && p.name !== 'shadow');
  if (!root) throw new Error('The rig needs a body part.');
  const view = resolveView(s, root, facing);
  const below = view ? bottomRow(view.bmp) - view.pivot[1] : 0;
  const unit = Math.max(1, Math.round(s.height / 24));
  const [fx, fy] = DIR[facing];
  /** Squash keeping the bottom of the body on the same row. sy < 1 = squashed. */
  const shape = (sy: number, up = 0, ahead = 0): Record<string, PartPose> => {
    const syv = 1 + (sy - 1) * k;
    const sxv = 1 + (1 - sy) * 0.8 * k;
    const p: PartPose = { sx: Math.round(sxv * 100) / 100, sy: Math.round(syv * 100) / 100 };
    const dy = rs(below * (1 - syv)) - rs(up * unit * k) + rs(fy * ahead * unit * k);
    const dx = rs(fx * ahead * unit * k);
    if (dy) p.dy = dy;
    if (dx) p.dx = dx;
    return { [root.name]: p };
  };
  const t = (ms: number[]) => ms.map((d) => Math.round(d * tempo));
  let keys: Record<string, PartPose>[];
  let durations: number[];
  switch (anim) {
    case 'walk':
    case 'run': {
      const hop = [[0.78, 0, 0], [1.2, 2, 0.5], [1.06, 3, 1], [0.95, 2, 1.5], [0.72, 0, 2], [0.9, 0, 1]] as const;
      keys = hop.map(([sy, up, ahead]) => shape(sy, up, ahead * (anim === 'run' ? 1.5 : 1)));
      durations = t(anim === 'run' ? [50, 50, 60, 50, 50, 60] : [90, 70, 90, 70, 90, 110]);
      break;
    }
    case 'attack':
      keys = [shape(0.7), shape(0.62, 0, -1), shape(1.25, 2, 3), shape(1.1, 1, 4), shape(0.8, 0, 2), shape(0.95, 0, 0)];
      durations = t([90, 150, 50, 70, 100, 110]);
      break;
    case 'hurt':
      keys = [shape(1.2, 0, -2), shape(0.82, 0, -1), shape(1, 0, 0)];
      durations = t([80, 120, 140]);
      break;
    case 'jump':
      keys = [shape(0.68), shape(1.3, 2), shape(1.12, 3)];
      durations = t([100, 60, 120]);
      break;
    case 'fall':
      keys = [shape(1.14, 2), shape(1.2, 2)];
      durations = t([120, 120]);
      break;
    case 'land':
      keys = [shape(0.62), shape(1.1), shape(0.96)];
      durations = t([70, 90, 100]);
      break;
    default: {
      const breath = [1, 1.06, 1, 0.94];
      keys = breath.map((sy) => shape(sy));
      durations = t([240, 200, 240, 200]);
    }
  }
  // Looping animations can be asked for a different number of frames: pick evenly from the keys.
  const pick = keys.length === n ? keys : Array.from({ length: n }, (_, i) => keys[Math.floor((i / n) * keys.length)]);
  const times = keys.length === n ? durations : Array.from({ length: n }, (_, i) => durations[Math.floor((i / n) * durations.length)]);
  return { poses: pick.map((parts) => ({ facing, parts })), durations: duration ? times.map(() => duration) : times, loop };
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

/** Where the tip of a limb should be, in canvas pixels. */
export interface IKTarget {
  x: number;
  y: number;
  /** Side the elbow or knee bends to (1 or -1). Default: knees forward, elbows back. */
  bend?: 1 | -1;
}

export interface Keyframe {
  /** Frame index within the animation. */
  frame: number;
  parts: Record<string, PartPose>;
  /** Tip targets by upper limb part ("leg_l", "arm_r"). Interpolated in screen space, so feet and hands travel in straight lines. */
  ik?: Record<string, IKTarget>;
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

/** Interpolates the IK targets of the keys: one map of limb → target per frame. A limb only needs targets on the keys that move it. */
export function interpolateIK(keys: Keyframe[], frames: number, loop: boolean): Record<string, IKTarget>[] {
  const out: Record<string, IKTarget>[] = Array.from({ length: frames }, () => ({}));
  const limbs = [...new Set(keys.flatMap((k) => Object.keys(k.ik ?? {})))];
  for (const limb of limbs) {
    const own = keys.filter((k) => k.ik?.[limb]);
    const asOffsets: Keyframe[] = own.map((k) => ({ frame: k.frame, ease: k.ease, parts: { p: { dx: k.ik![limb].x, dy: k.ik![limb].y } } }));
    const path = interpolateKeyframes(asOffsets, frames, loop);
    const sorted = [...own].sort((a, b) => a.frame - b.frame);
    path.forEach((pose, i) => {
      const held = [...sorted].reverse().find((k) => k.frame <= i) ?? sorted[0];
      const bend = held.ik![limb].bend;
      out[i][limb] = { x: pose.p?.dx ?? 0, y: pose.p?.dy ?? 0, ...(bend ? { bend } : {}) };
    });
  }
  return out;
}
