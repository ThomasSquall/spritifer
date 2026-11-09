/**
 * Geometry of the 2D-HD perspective: a camera, and which cells of a map are walls. Pure and browser-safe.
 *
 * Coordinates are view pixels with the origin at the centre of the screen. The world is scaled so that a camera infinitely
 * far away would reproduce the flat picture exactly: the depth axis by 1/sin(elevation), the height axis by 1/cos(elevation).
 * Perspective is therefore something added to the game's picture, and at zero it is the game's picture.
 */

import type { HdCells } from './hd.js';
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

/**
 * A wall cell: part of the vertical front, or part of the top. `stretch` makes a front taller than the rows it has.
 * `sides` are the map cells whose art covers the side of a top cell, from the foot up: nobody paints the side of a wall
 * in a map seen from the south, so it borrows a stretch of the fronts.
 */
export type WallCell = { face: number; stretch?: number } | { cap: number; left: boolean; right: boolean; sides?: number[] };

/**
 * Which cells stand up, read from the map as it is. A solid cell is a wall when the ground art under it is used only under
 * solid cells (so it is painted masonry, not grass under a tree trunk) and doesn't animate (water blocks the way too).
 * A map where such cells are a minority has no walls. In a column of wall cells the lowest `wallRows` are the front; the ones above are the top.
 */
export function findWalls(layers: readonly TileLayer[], cols: number, rows: number, resolver: TileResolver, wallRows: number, corrections?: HdCells): (WallCell | null)[] {
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
    if (!blocked(i) || water[i]) continue;
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
  exposeSides(out, cols, rows);
  dressSides(out, cols, rows);
  return out;
}

/**
 * Which sides of a wall top show. A top stands as many rows south of where it is painted as the wall is high, so what
 * counts is what is next to it down there: next to where it is painted there may be another wall, and the side still shows.
 */
function exposeSides(cells: (WallCell | null)[], cols: number, rows: number): void {
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
  cells.forEach((c, i) => {
    if (!c || !('cap' in c)) return;
    const x = i % cols;
    const ground = Math.floor(i / cols) + c.cap;
    c.left = !standsAt(x - 1, ground);
    c.right = !standsAt(x + 1, ground);
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
        const score = dx + Math.abs(y - s.foot) + (s.rows === c.cap ? 0 : 1000);
        if (score < bestScore) {
          bestScore = score;
          best = s;
        }
      }
      const length = best.x1 - best.x0 + 1;
      const column = best.x0 + (((y - best.foot) % length) + length) % length;
      c.sides = Array.from({ length: Math.min(best.rows, c.cap) }, (_, r) => (best.foot - r) * cols + column);
    }
  }
}
