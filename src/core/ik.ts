/**
 * Two-bone inverse kinematics for rig limbs (hip → knee → ankle, shoulder → elbow → hand).
 * Angles follow the rig convention: degrees, clockwise on screen (x right, y down).
 */

export type Vec2 = [number, number];

const DEG = 180 / Math.PI;

/** Wraps an angle to (-180, 180]. */
export function wrapDeg(a: number): number {
  const w = ((a + 180) % 360 + 360) % 360 - 180;
  return w === -180 ? 180 : w;
}

export interface TwoBoneSolution {
  /** Rotation of the upper bone in degrees. */
  upper: number;
  /** Rotation of the lower bone relative to the upper one, in degrees. */
  lower: number;
  /** False when the target was out of reach and the limb is fully stretched or folded toward it. */
  reached: boolean;
}

/**
 * Solves a two-bone chain.
 * `u` is the rest vector from the root joint to the middle joint, `v` the rest vector from the middle joint to the tip,
 * `target` the wanted tip position relative to the root joint. `bend` picks the side the middle joint goes to:
 * -1 bends toward smaller screen angles (a knee facing +x when the limb points down), 1 the opposite.
 */
export function solveTwoBone(u: Vec2, v: Vec2, target: Vec2, bend: 1 | -1): TwoBoneSolution {
  const l1 = Math.hypot(u[0], u[1]);
  const l2 = Math.hypot(v[0], v[1]);
  const uRest = Math.atan2(u[1], u[0]);
  const vRest = Math.atan2(v[1], v[0]);
  let d = Math.hypot(target[0], target[1]);
  const phi = d > 1e-6 ? Math.atan2(target[1], target[0]) : uRest;
  const min = Math.abs(l1 - l2);
  const max = l1 + l2;
  const reached = d >= min - 1e-6 && d <= max + 1e-6;
  d = Math.max(min + 1e-6, Math.min(max - 1e-6, d));
  const cosA = l1 > 0 && d > 0 ? (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d) : 1;
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const upperDir = phi + bend * a;
  const elbow: Vec2 = [l1 * Math.cos(upperDir), l1 * Math.sin(upperDir)];
  const tip: Vec2 = [d * Math.cos(phi), d * Math.sin(phi)];
  const lowerDir = Math.atan2(tip[1] - elbow[1], tip[0] - elbow[0]);
  const upper = (upperDir - uRest) * DEG;
  const lower = (lowerDir - vRest) * DEG - upper;
  return { upper: wrapDeg(upper), lower: wrapDeg(lower), reached };
}
