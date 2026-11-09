/**
 * Geometry of the 2D-HD perspective: a camera, and which cells of a map are walls. Pure and browser-safe.
 *
 * Coordinates are view pixels with the origin at the centre of the screen. The world is scaled so that a camera infinitely
 * far away would reproduce the flat picture exactly: the depth axis by 1/sin(elevation), the height axis by 1/cos(elevation).
 * Perspective is therefore something added to the game's picture, and at zero it is the game's picture.
 */

import type { HdCells, HdJut } from './hd.js';
import { findWater } from './reflections.js';
import type { TileResolver } from './tilerules.js';
import type { TileLayer } from './types.js';

export interface Camera3d {
  vw: number;
  vh: number;
  /** Distance from the eye to the centre of the ground in view. */
  distance: number;
  sin: number;
  cos: number;
  /** World units per view pixel on the depth and height axes. */
  depthScale: number;
  heightScale: number;
  /** Near and far planes. */
  near: number;
  far: number;
}

/** `perspective` 0..1 is the field of view as a fraction of 60°, `elevation` the camera's angle above the ground in degrees. */
export function makeCamera(vw: number, vh: number, perspective: number, elevation: number): Camera3d {
  const e = (Math.min(80, Math.max(15, elevation)) * Math.PI) / 180;
  const fov = (Math.max(0.02, perspective) * Math.PI) / 3;
  const distance = vh / 2 / Math.tan(fov / 2);
  return { vw, vh, distance, sin: Math.sin(e), cos: Math.cos(e), depthScale: 1 / Math.sin(e), heightScale: 1 / Math.cos(e), near: Math.max(1, distance * 0.04), far: distance * 8 };
}

/** World position of a point on the ground, `h` view pixels straight up from it. x and y are relative to the screen centre. */
export function worldPoint(cam: Camera3d, x: number, y: number, h = 0): [number, number, number] {
  return [x, h * cam.heightScale, y * cam.depthScale];
}

/** Where a world point lands on the screen, in view pixels from the centre, and how much things are scaled there. */
export function projectWorld(cam: Camera3d, p: readonly [number, number, number]): { x: number; y: number; scale: number } {
  const scale = cam.distance / Math.max(cam.near, cam.distance - p[2] * cam.cos - p[1] * cam.sin);
  return { x: p[0] * scale, y: (p[2] * cam.sin - p[1] * cam.cos) * scale, scale };
}

/** Column-major clip matrix for worldPoint coordinates. */
export function cameraMatrix(cam: Camera3d): Float32Array {
  const { distance: d, sin: s, cos: c, near: n, far: f, vw, vh } = cam;
  const a = (f + n) / (f - n);
  const b = (-2 * f * n) / (f - n);
  const kx = d / (vw / 2);
  const ky = d / (vh / 2);
  // clip.x = x·kx    clip.y = (y·c − z·s)·ky    clip.w = d − z·c − y·s    clip.z = clip.w·a + b
  return new Float32Array([kx, 0, 0, 0, 0, c * ky, -s * a, -s, 0, -s * ky, -c * a, -c, 0, 0, d * a + b, d]);
}

/** Clip matrix drawing x and z as flat view pixels: backdrops and full-screen flashes. */
export function flatMatrix(vw: number, vh: number): Float32Array {
  return new Float32Array([2 / vw, 0, 0, 0, 0, 0, 0, 0, 0, -2 / vh, 0, 0, 0, 0, 0, 1]);
}

/**
 * How many view pixels beyond each edge of the screen are in view: the ground recedes under the top of the screen, so
 * much more of it shows there. Capped, in case the camera is low enough to see the horizon.
 */
export function overscanOf(cam: Camera3d): { left: number; top: number; right: number; bottom: number } {
  const { vw, vh, distance: d, sin: s, cos: c } = cam;
  const limit = vh * 3;
  const below = d * s - (vh / 2) * c;
  const far = below > 0 ? Math.min(limit, ((vh / 2) * d) / below) : limit;
  const top = Math.max(0, far * s - vh / 2);
  const wide = (vw / 2) * ((d + far * c) / d);
  const side = Math.max(0, wide - vw / 2);
  return { left: side, right: side, top, bottom: 0 };
}

/** The solids a standing sprite can be wrapped on, seen from above. */
export const HD_SHAPES = ['round', 'octagon', 'hexagon', 'square'] as const;
export type HdShape = (typeof HD_SHAPES)[number];

/** Right half of each cross-section as [across, towards the camera], with a half width of 1; `square` shows a corner. */
const FACETS: Record<Exclude<HdShape, 'round'>, readonly (readonly [number, number])[]> = {
  octagon: [[0, 1], [0.414, 1], [1, 0.414]],
  hexagon: [[0, 0.866], [0.5, 0.866], [1, 0]],
  square: [[0, 1], [1, 0]],
};

/** How far forward a solid's surface is at `t` across it (-1..1), and the sideways part of the direction it faces there. */
export function shapeSurface(shape: HdShape, t: number): { forward: number; side: number } {
  const a = Math.min(1, Math.abs(t));
  const sign = t < 0 ? -1 : 1;
  if (shape === 'round') return { forward: Math.sqrt(Math.max(0, 1 - a * a)), side: sign * a };
  const points = FACETS[shape];
  let i = 0;
  while (i < points.length - 2 && a > points[i + 1]![0]) i++;
  const [x0, z0] = points[i]!;
  const [x1, z1] = points[i + 1]!;
  const dx = x1 - x0;
  const dz = z1 - z0;
  const length = Math.hypot(dx, dz) || 1;
  return { forward: z0 + (dz * (a - x0)) / (dx || 1), side: (sign * -dz) / length };
}

/** The silhouette of a frame row by row: the axis it turns around, and how far from it each row reaches. */
export interface SpriteProfile {
  axis: number;
  radius: Float32Array;
  largest: number;
}

export function spriteProfile(alpha: Uint8Array, sheetWidth: number, frame: { x: number; y: number; w: number; h: number }): SpriteProfile {
  const lefts = new Int32Array(frame.h).fill(-1);
  const rights = new Int32Array(frame.h).fill(-1);
  const middles: number[] = [];
  for (let y = 0; y < frame.h; y++) {
    for (let x = 0; x < frame.w; x++) {
      if (!alpha[(frame.y + y) * sheetWidth + frame.x + x]) continue;
      if (lefts[y]! < 0) lefts[y] = x;
      rights[y] = x + 1;
    }
    if (lefts[y]! >= 0) middles.push((lefts[y]! + rights[y]!) / 2);
  }
  middles.sort((p, q) => p - q);
  const axis = middles.length ? middles[middles.length >> 1]! : frame.w / 2;
  const radius = new Float32Array(frame.h);
  let largest = 0;
  for (let y = 0; y < frame.h; y++) {
    if (lefts[y]! < 0) continue;
    radius[y] = Math.max(axis - lefts[y]!, rights[y]! - axis);
    largest = Math.max(largest, radius[y]!);
  }
  return { axis, radius, largest };
}

/**
 * A wall cell: part of the vertical front, or part of the top. `stretch` makes a front taller than the rows it has.
 * `juts` are the parts of a front cell standing forward of the wall; `top` tells a front cell is the highest of its column.
 * `sides` are the map cells whose art covers the side of a top cell, from the foot up: nobody paints the side of a wall
 * in a map seen from the south, so it borrows a stretch of the fronts.
 */
export type WallCell = { face: number; stretch?: number; juts?: JutSpan[]; top?: boolean } | { cap: number; left: boolean; right: boolean; sides?: number[]; sideJuts?: JutSpan[] };

/**
 * Which cells stand up, read from the map as it is. A solid cell is a wall when the ground art under it is used only under
 * solid cells (so it is painted masonry, not grass under a tree trunk) and isn't water, animated or laid over it as
 * instances (`moreWater`).
 * A map where such cells are a minority has no walls. In a column of wall cells the lowest `wallRows` are the front; the ones above are the top.
 */
/** The part of a front tile that stands forward: `from` and `to` across the tile, 0..1, and whether the jut begins or ends in it. */
export interface JutSpan {
  from: number;
  to: number;
  depth: number;
  starts: boolean;
  ends: boolean;
}

export function findWalls(layers: readonly TileLayer[], cols: number, rows: number, resolver: TileResolver, wallRows: number, corrections?: HdCells, moreWater?: Uint8Array, juts?: readonly HdJut[], tileSize = 32): (WallCell | null)[] {
  const total = cols * rows;
  const out: (WallCell | null)[] = new Array(total).fill(null);
  const solid = layers.filter((l) => l.solid);
  const ground = layers.find((l) => !l.solid);
  if (wallRows <= 0) return out;
  const blocked = (i: number) => solid.some((l) => l.tiles[i]! >= 0);
  const open = new Set<number>();
  if (ground) for (let i = 0; i < total; i++) if (!blocked(i)) open.add(ground.tiles[i]!);
  const water = findWater(layers, cols, rows, resolver).grid;
  const isWall = new Uint8Array(total);
  let blockedCells = 0;
  let wallCells = 0;
  for (let i = 0; i < total; i++) {
    if (!blocked(i) || water[i] || moreWater?.[i]) continue;
    blockedCells++;
    const painted = solid.some((l) => l.visible && l.tiles[i]! >= 0);
    if (painted || (ground && !open.has(ground.tiles[i]!))) {
      isWall[i] = 1;
      wallCells++;
    }
  }
  // Masonry makes up most of what blocks a built map. Out of doors a tile or two that happens to be used only at the
  // edge of the map is not a wall: there, trees and houses are what stands up.
  if (wallCells < blockedCells / 2) isWall.fill(0);
  // What was corrected by hand wins over all of the above.
  const fronts = new Map<number, number>();
  for (const [key, n] of Object.entries(corrections ?? {})) {
    const [x, y] = key.split(',').map(Number) as [number, number];
    if (x >= cols || y >= rows) continue;
    const i = y * cols + x;
    isWall[i] = n > 0 ? 1 : 0;
    if (n > 0) fronts.set(i, n);
  }
  const wall = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && !!isWall[y * cols + x];
  for (let x = 0; x < cols; x++) {
    for (let y = rows - 1; y >= 0; y--) {
      if (!wall(x, y)) continue;
      let top = y;
      while (wall(x, top - 1)) top--;
      const length = y - top + 1;
      // A height corrected by hand anywhere in the column sets the whole column; the lowest cell decides.
      let wanted = wallRows;
      let byHand = false;
      for (let cy = y; cy >= top; cy--) {
        const n = fronts.get(cy * cols + x);
        if (n !== undefined) {
          wanted = n;
          byHand = true;
          break;
        }
      }
      // A wall running off the bottom of the map shows no front: only its top is seen.
      const front = y === rows - 1 ? 0 : Math.min(wanted, length);
      const raise = y === rows - 1 ? Math.min(wanted, length) : front;
      // Asked by hand for more height than the column has rows: its art is stretched to get there.
      const stretch = byHand && y !== rows - 1 && length < wanted ? wanted / length : undefined;
      for (let cy = y; cy >= top; cy--) {
        const row = y - cy;
        out[cy * cols + x] = row < front ? { face: row, ...(stretch ? { stretch } : {}) } : { cap: raise, left: !wall(x - 1, cy), right: !wall(x + 1, cy) };
      }
      y = top;
    }
  }
  exposeSides(out, cols, rows, ground?.tiles);
  for (const jut of juts ?? []) standOut(out, cols, rows, tileSize, jut);
  dressSides(out, cols, rows);
  return out;
}

/** Hands a jut to the front cells it crosses, tile by tile, from the foot of the wall up. */
function standOut(cells: (WallCell | null)[], cols: number, rows: number, ts: number, jut: HdJut): void {
  if (jut.foot >= rows) return;
  const end = jut.x + jut.w;
  for (let tx = Math.floor(jut.x / ts); tx < cols && tx * ts < end; tx++) {
    const from = Math.max(0, (jut.x - tx * ts) / ts);
    const to = Math.min(1, (end - tx * ts) / ts);
    if (to <= from) continue;
    const span: JutSpan = { from, to, depth: jut.depth, starts: jut.x >= tx * ts, ends: end <= (tx + 1) * ts };
    for (let row = 0; jut.foot - row >= 0; row++) {
      const c = cells[(jut.foot - row) * cols + tx];
      if (!c || !('face' in c) || c.face !== row) break;
      (c.juts ??= []).push(span);
      const above = jut.foot - row - 1 >= 0 ? cells[(jut.foot - row - 1) * cols + tx] : null;
      c.top = !(above && 'face' in above && above.face === row + 1);
    }
  }
}

/**
 * Which sides of a wall top show. A top stands as many rows south of where it is painted as the wall is high, so what
 * counts is what is next to it down there: next to where it is painted there may be another wall, and the side still shows.
 */
function exposeSides(cells: (WallCell | null)[], cols: number, rows: number, ground?: readonly number[]): void {
  const standing = new Uint8Array(cols * rows);
  cells.forEach((c, i) => {
    if (!c) return;
    const x = i % cols;
    const y = Math.floor(i / cols);
    if ('cap' in c) {
      // Past the bottom of the map, the last row stands for it: two walls running off the edge still touch.
      standing[Math.min(y + c.cap, rows - 1) * cols + x] = 1;
    } else if (c.face === 0) standing[i] = 1;
  });
  const standsAt = (x: number, y: number) => x >= 0 && x < cols && !!standing[Math.min(y, rows - 1) * cols + x];
  // Nothing is painted there: a side would only face the dark.
  const empty = (x: number, y: number) => !!ground && x >= 0 && x < cols && ground[Math.min(y, rows - 1) * cols + x]! < 0;
  cells.forEach((c, i) => {
    if (!c || !('cap' in c)) return;
    const x = i % cols;
    const foot = Math.floor(i / cols) + c.cap;
    c.left = !standsAt(x - 1, foot) && !empty(x - 1, foot);
    c.right = !standsAt(x + 1, foot) && !empty(x + 1, foot);
  });
}

/** A row of neighbouring wall fronts with their foot on the same line, `rows` tiles high. */
interface FrontStrip {
  foot: number;
  x0: number;
  x1: number;
  rows: number;
}

function frontStrips(cells: readonly (WallCell | null)[], cols: number, rows: number): FrontStrip[] {
  const height = (x: number, foot: number) => {
    let n = 0;
    for (let y = foot; y >= 0; y--) {
      const c = cells[y * cols + x];
      if (!c || !('face' in c) || c.face !== foot - y) break;
      n++;
    }
    return n;
  };
  const strips: FrontStrip[] = [];
  for (let foot = 0; foot < rows; foot++) {
    let open: FrontStrip | null = null;
    for (let x = 0; x < cols; x++) {
      const n = height(x, foot);
      if (n && open && open.rows === n) open.x1 = x;
      else if (n) strips.push((open = { foot, x0: x, x1: x, rows: n }));
      else open = null;
    }
  }
  return strips;
}

/**
 * Gives each exposed side of a wall top the nearest front of the same height, one column further along it for each row of
 * depth: the masonry unrolls along the side as it does along the front, joints and piers included.
 */
function dressSides(cells: (WallCell | null)[], cols: number, rows: number): void {
  const strips = frontStrips(cells, cols, rows);
  if (!strips.length) return;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const c = cells[y * cols + x];
      if (!c || !('cap' in c) || (!c.left && !c.right)) continue;
      let best = strips[0]!;
      let bestScore = Infinity;
      for (const s of strips) {
        const dx = x < s.x0 ? s.x0 - x : x > s.x1 ? x - s.x1 : 0;
        // A short stretch of front, unrolled over and over, would stack its piers side by side like the rungs of a ladder.
        const score = dx + Math.abs(y - s.foot) + (s.rows === c.cap ? 0 : 1000) + (s.x1 - s.x0 + 1 < 6 ? 40 : 0);
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      const length = best.x1 - best.x0 + 1;
      const column = best.x0 + (((y - best.foot) % length) + length) % length;
      c.sides = Array.from({ length: Math.min(best.rows, c.cap) }, (_, r) => (best.foot - r) * cols + column);
      // A pier on the stretch of front it borrows comes along, standing out of the side.
      const source = cells[best.foot * cols + column];
      if (source && 'face' in source && source.juts) c.sideJuts = source.juts;
    }
  }
}

/** One flat piece of a wall in the 2D-HD view: where it goes in the world and which part of the tile sheet it shows. */
export interface WallQuad {
  src: readonly [number, number, number, number];
  at: (readonly [number, number, number])[];
  flat: [number, number][];
  depth: number;
  color: readonly [number, number, number, number];
  /** Takes the light through the tile's normals. */
  shaped: boolean;
  /** The side of a wall, facing east (1) or west (-1). */
  sideOf?: 1 | -1;
}

/**
 * The pieces of one map tile standing up, per its place in the wall. `x` and `y` are where it is in the flat picture, in view
 * pixels. The browser and the headless screenshots draw the same list, so what is checked headless is what is played.
 */
export function wallQuads(cam: Camera3d, raise: number, wallTrim: number, sx: number, sy: number, sw: number, sh: number, x: number, y: number, size: number, cell: WallCell, sides: readonly ([number, number] | null)[] | null): WallQuad[] {
  const out: WallQuad[] = [];
  const cx = cam.vw / 2;
  const cy = cam.vh / 2;
  const P = (px: number, py: number, h: number) => worldPoint(cam, px - cx, py - cy, h);
  const flat: [number, number][] = [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
  const white = [1, 1, 1, 1] as const;
  if ('face' in cell) {
    const foot = y + size * (cell.face + 1);
    const tall = size * raise * (cell.stretch ?? 1);
    const h0 = cell.face * tall;
    const h1 = (cell.face + 1) * tall;
    // What is painted at the foot (a plinth) stays out, and the masonry reaches the ground. Piers are painted all the way down.
    const trim = cell.face === 0 ? Math.min(sh - 1, Math.round(wallTrim)) : 0;
    const front = (from: number, to: number, depth: number) => {
      const a = x + from * size;
      const b = x + to * size;
      const z = foot + depth;
      out.push({ color: white, shaped: true, src: [sx + from * sw, sy, sx + to * sw, sy + sh - (depth ? 0 : trim)], flat: [[a, y], [b, y], [b, y + size], [a, y + size]], depth: z - cy, at: [P(a, z, h1), P(b, z, h1), P(b, z, h0), P(a, z, h0)] });
    };
    const juts = [...(cell.juts ?? [])].sort((p, q) => p.from - q.from);
    let along = 0;
    for (const j of juts) {
      if (j.from > along) front(along, j.from, 0);
      front(j.from, j.to, j.depth);
      along = j.to;
      const a = x + j.from * size;
      const b = x + j.to * size;
      const z = foot + j.depth;
      const dark = { shaped: false, flat, depth: z - cy, color: [0.72, 0.72, 0.78, 1] as const };
      const inside = (k: number) => Math.floor(sx + (j.from + (j.to - j.from) * k) * sw);
      const flank = (at: number, u: number) => out.push({ ...dark, src: [u, sy, u + 1, sy + sh], at: [P(at, foot, h1), P(at, z, h1), P(at, z, h0), P(at, foot, h0)] });
      if (j.starts) flank(a, inside(0.3));
      if (j.ends) flank(b, inside(0.7));
      if (cell.top) out.push({ ...dark, color: [0.85, 0.85, 0.9, 1], src: [sx + j.from * sw, sy, sx + j.to * sw, sy + 1], at: [P(a, foot, h1), P(b, foot, h1), P(b, z, h1), P(a, z, h1)] });
    }
    if (along < 1) front(along, 1, 0);
    return out;
  }
  // The top of the wall sits as far south as it is high, which is where the flat picture shows it.
  const height = cell.cap * size;
  const top = height * raise;
  const near = y + height;
  out.push({ color: white, shaped: true, src: [sx, sy, sx + sw, sy + sh], flat, depth: near - cy, at: [P(x, near, top), P(x + size, near, top), P(x + size, near + size, top), P(x, near + size, top)] });
  if (!sides) return out;
  const side = (at: number, u: number, sideOf: 1 | -1) => {
    if (sides.length && sides.every(Boolean)) {
      // The masonry of a front, turned to run along the side, a little in shade.
      const rowHeight = top / sides.length;
      sides.forEach((from, row) => {
        const [fx, fy] = from!;
        const h0 = row * rowHeight;
        const h1 = h0 + rowHeight;
        const strip = (a: number, b: number, sticks: number) => {
          const px = at + sideOf * sticks;
          const z0 = near + a * size;
          const z1 = near + b * size;
          const trim = row === 0 && !sticks ? Math.min(sh - 1, Math.round(wallTrim)) : 0;
          out.push({ shaped: true, flat, depth: near - cy, sideOf, color: [0.8, 0.8, 0.84, 1], src: [fx + a * sw, fy, fx + b * sw, fy + sh - trim], at: [P(px, z0, h1), P(px, z1, h1), P(px, z1, h0), P(px, z0, h0)] });
        };
        let along = 0;
        for (const j of [...(cell.sideJuts ?? [])].sort((p, q) => p.from - q.from)) {
          if (j.from > along) strip(along, j.from, 0);
          // Seen at a glancing angle, a full-depth pier would hide the next one: a side keeps them shallower.
          const sticks = j.depth * 0.6;
          strip(j.from, j.to, sticks);
          along = j.to;
          const px = at + sideOf * sticks;
          const za = near + j.from * size;
          const zb = near + j.to * size;
          const dark = { shaped: false, flat, depth: near - cy, color: [0.72, 0.72, 0.78, 1] as const };
          // From inside the pier: its outermost column is the black outline, which stretched would read as a slit.
          const inside = (k: number) => Math.floor(fx + (j.from + (j.to - j.from) * k) * sw);
          const flank = (z: number, u: number) => out.push({ ...dark, src: [u, fy, u + 1, fy + sh], at: [P(at, z, h1), P(px, z, h1), P(px, z, h0), P(at, z, h0)] });
          if (j.starts) flank(za, inside(0.3));
          if (j.ends) flank(zb, inside(0.7));
          if (row === sides.length - 1) out.push({ ...dark, color: [0.8, 0.8, 0.86, 1], src: [fx + j.from * sw, fy, fx + j.to * sw, fy + 1], at: [P(at, za, h1), P(px, za, h1), P(px, zb, h1), P(at, zb, h1)] });
        }
        if (along < 1) strip(along, 1, 0);
      });
      return;
    }
    // No front anywhere on this map to borrow from: the edge of the top is stretched down, darker.
    out.push({ shaped: false, flat, depth: near - cy, color: [0.62, 0.62, 0.66, 1], src: [u, sy, u + 1, sy + sh], at: [P(at, near, top), P(at, near + size, top), P(at, near + size, 0), P(at, near, 0)] });
  };
  if (cell.left) side(x, sx, -1);
  if (cell.right) side(x + size, sx + sw - 1, 1);
  return out;
}
