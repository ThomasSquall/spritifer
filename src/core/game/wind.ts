/**
 * Wind on sprites, at draw time: the art stays as it is and the sprite is drawn in horizontal bands, each shifted by a
 * whole number of pixels, more towards the top. Rows that share a shift are one band, so a tree costs a handful of
 * draws, and everything stays on the pixel grid.
 */

import type { ObjectSway } from './types.js';

export interface SwayBand {
  /** First row of the band, from the top of the frame. */
  row: number;
  rows: number;
  /** Horizontal shift in sprite pixels. */
  offset: number;
}

/** The leaves shiver by at most this many pixels, on top of the bend of the whole plant. */
const FLUTTER = 1.1;

/**
 * How far each row of a frame is shifted at this moment. Rows from `base` down stay still (the foot of the trunk).
 * `x` and `y` are the position in the world: gusts travel across the map instead of moving every tree together.
 * `push` is how far someone walking through has shoved the top aside, in pixels.
 */
export function swayShift(sway: ObjectSway, base: number, x: number, y: number, clock: number, push = 0): (row: number) => number {
  const t = clock * (sway.speed ?? 1);
  const place = x * 0.011 + y * 0.007;
  // 0..1: calm moments and gusts, on slow periods that never quite repeat.
  const gust = (Math.sin(t * 0.43 - place * 0.5) + 0.5 * Math.sin(t * 0.71 + 1.3) + 1.5) / 3;
  // The plant rocks more in a gust and leans the way the wind blows.
  const bend = Math.sin(t * 1.25 - place) * (0.45 + 0.55 * gust) * 0.7 + 0.35 * gust;
  const shiver = FLUTTER * Math.min(1, sway.amount / 2) * gust;
  return (row) => {
    const h = base > 0 ? Math.max(0, (base - row) / base) : 0;
    return Math.round(sway.amount * bend * h ** 1.5 + shiver * h * h * Math.sin(t * 3.3 - row * 0.22 - place * 3) + push * h);
  };
}

/** Rows `first` up to `end` (excluded), joined into bands wherever the shift is the same. */
export function groupRows(first: number, end: number, shift: (row: number) => number): SwayBand[] {
  const bands: SwayBand[] = [];
  let start = first;
  let offset = shift(first);
  for (let row = first + 1; row < end; row++) {
    const next = shift(row);
    if (next === offset) continue;
    bands.push({ row: start, rows: row - start, offset });
    start = row;
    offset = next;
  }
  if (end > first) bands.push({ row: start, rows: end - start, offset });
  return bands;
}

/** The bands of a frame `height` rows tall at this moment. */
export function swayBands(sway: ObjectSway, height: number, base: number, x: number, y: number, clock: number, push = 0): SwayBand[] {
  return groupRows(0, height, swayShift(sway, base, x, y, clock, push));
}

/** The feet of someone who can push plants aside. */
export interface Walker {
  x: number;
  y: number;
  vx: number;
}

/**
 * Where a plant at (x, y) wants its top: away from the nearest walker within `reach` pixels, 0 when nobody is near.
 * Rows count a little more than columns because the ground is seen at an angle.
 */
export function pushTarget(x: number, y: number, reach: number, react: number, walkers: readonly Walker[]): number {
  let close = 0;
  let side = 0;
  for (const w of walkers) {
    const dx = x - w.x;
    const c = 1 - Math.hypot(dx, (y - w.y) * 1.4) / reach;
    if (c <= close) continue;
    close = c;
    // Right under the feet the plant goes the way the walker is heading.
    side = Math.abs(dx) > 1 ? Math.sign(dx) : Math.sign(w.vx) || 1;
  }
  return side * react * Math.min(1, close * 2.2);
}

/** About 1.5 swings a second, losing most of its strength in two or three: the rebound of a stem. */
const PUSH_SPRING = 90;
const PUSH_DAMPING = 7;

/** One step of a plant returning to `target`. */
export function stepPush(p: { swayPush: number; swayPushV: number }, target: number, dt: number): void {
  p.swayPushV += (PUSH_SPRING * (target - p.swayPush) - PUSH_DAMPING * p.swayPushV) * dt;
  p.swayPush += p.swayPushV * dt;
  if (!target && Math.abs(p.swayPush) < 0.02 && Math.abs(p.swayPushV) < 0.05) p.swayPush = p.swayPushV = 0;
}

/** The row of the frame where a plant meets the ground: the bottom of its hitbox, or of the frame. */
export function swayBase(type: { hitbox?: { y: number; h: number }; spriteOffset?: { y: number } }, frameHeight: number): number {
  if (!type.hitbox) return frameHeight;
  return Math.max(0, Math.min(frameHeight, type.hitbox.y + type.hitbox.h - (type.spriteOffset?.y ?? 0)));
}
