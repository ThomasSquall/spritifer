/**
 * Blueprints of places whose ground was painted: woods, towns, caves. The terrain stays as it is; the blueprint says what its
 * parts are, what matters on them and which routes must exist. Scatter (trees, grass, pebbles) stays plain instances of the
 * scene. Pure and browser-safe.
 */

import { type Blueprint, type BpContext, type BpElement, type BpMount, type BpPlan, type BpProblem, type BpSpace, CELL, type CellKind, elementAt } from './blueprint.js';
import { findWater } from './reflections.js';
import type { SizeOf } from './sceneOps.js';
import { fineBlockedTiles } from './fineSolid.js';
import type { TileResolver } from './tilerules.js';
import { type Instance, type ObjectType, type Scene, hitboxOf } from './types.js';

export interface BpSurface {
  solid: Uint8Array;
  water: Uint8Array;
}

export function surfaceOf(s: Pick<Scene, 'layers' | 'cols' | 'rows'> & Partial<Pick<Scene, 'collisionFine' | 'tileSize'>>, resolver: TileResolver): BpSurface {
  const total = s.cols * s.rows;
  const solid = new Uint8Array(total);
  for (const l of s.layers) if (l.solid) l.tiles.forEach((t, i) => { if (t >= 0) solid[i] = 1; });
  if (s.collisionFine && s.tileSize) fineBlockedTiles({ collisionFine: s.collisionFine, cols: s.cols, rows: s.rows, tileSize: s.tileSize })?.forEach((v, i) => { if (v) solid[i] = 1; });
  return { solid, water: findWater(s.layers, s.cols, s.rows, resolver).grid };
}

/** Lays zones over painted ground and reports what doesn't add up. */
export function planPainted(bp: Blueprint, surface: BpSurface): BpPlan {
  const [cols, rows] = bp.size;
  const total = cols * rows;
  const kinds = new Uint8Array(total);
  const spaces = new Int16Array(total).fill(-1);
  const problems: BpProblem[] = [];
  const err = (code: string, message: string, cell?: [number, number]) => problems.push({ level: 'error', code, message, ...(cell ? { cell } : {}) });
  const warn = (code: string, message: string, cell?: [number, number]) => problems.push({ level: 'warning', code, message, ...(cell ? { cell } : {}) });
  if (surface.solid.length !== total) err('wrong-size', `The blueprint says ${cols}x${rows}, but the painted map has a different size.`);
  for (let i = 0; i < total; i++) kinds[i] = (surface.solid[i] ? (surface.water[i] ? CELL.WATER : CELL.THICKET) : CELL.FLOOR) as CellKind;
  if (!bp.concept.trim()) err('no-concept', 'The blueprint has no concept: say what this place is.');
  const ids = new Set<string>();
  bp.spaces.forEach((z, n) => {
    if (ids.has(z.id)) err('duplicate-space', `Two zones are called "${z.id}".`);
    ids.add(z.id);
    if (!z.purpose?.trim()) err('no-purpose', `Zone "${z.id}" has no purpose: what happens here?`);
    if (!z.rects?.length) err('empty-space', `Zone "${z.id}" has no rects.`);
    let own = 0;
    for (const r of z.rects ?? []) {
      if (r[2] < 1 || r[3] < 1 || r[0] < 0 || r[1] < 0 || r[0] + r[2] > cols || r[1] + r[3] > rows) {
        err('out-of-map', `Zone "${z.id}" has a rect outside the map: [${r.join(', ')}].`, [Math.max(0, r[0]), Math.max(0, r[1])]);
        continue;
      }
      for (let y = r[1]; y < r[1] + r[3]; y++) {
        for (let x = r[0]; x < r[0] + r[2]; x++) {
          const i = y * cols + x;
          if (spaces[i] < 0 && kinds[i] === CELL.FLOOR) {
            spaces[i] = n;
            own++;
          }
        }
      }
    }
    if (z.rects?.length && !own) err('empty-zone', `Zone "${z.id}" has no ground of its own to walk on.`, [z.rects[0]![0], z.rects[0]![1]]);
  });

  // Which zones the ground really joins.
  const touching = new Set<string>();
  const pair = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const a = spaces[y * cols + x]!;
      if (a < 0) continue;
      const right = x + 1 < cols ? spaces[y * cols + x + 1]! : -1;
      const down = y + 1 < rows ? spaces[(y + 1) * cols + x]! : -1;
      if (right >= 0 && right !== a) touching.add(pair(a, right));
      if (down >= 0 && down !== a) touching.add(pair(a, down));
    }
  }
  const index = new Map(bp.spaces.map((z, n) => [z.id, n]));
  const declared = new Set<string>();
  for (const l of bp.links) {
    const a = index.get(l.a);
    const b = index.get(l.b);
    if (a === undefined || b === undefined) {
      err('unknown-space', `A link names "${a === undefined ? l.a : l.b}", which is not a zone.`);
      continue;
    }
    declared.add(pair(a, b));
    if (!touching.has(pair(a, b))) err('link-across-gap', `Zones "${l.a}" and "${l.b}" are linked, but no ground joins them.`);
  }
  for (const key of touching) {
    if (declared.has(key)) continue;
    const [a, b] = key.split('|').map(Number) as [number, number];
    err('undeclared-opening', `The ground joins zones "${bp.spaces[a]!.id}" and "${bp.spaces[b]!.id}", but no link says how one leads to the other.`, [bp.spaces[a]!.rects[0]?.[0] ?? 0, bp.spaces[a]!.rects[0]?.[1] ?? 0]);
  }

  // Ground that belongs to nothing: nobody has said what it is.
  const seen = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (seen[i] || kinds[i] !== CELL.FLOOR || spaces[i]! >= 0) continue;
    const todo = [i];
    seen[i] = 1;
    let n = 0;
    while (todo.length) {
      const c = todo.pop()!;
      n++;
      const x = c % cols;
      for (const d of [x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1, c - cols, c + cols]) {
        if (d < 0 || d >= total || seen[d] || kinds[d] !== CELL.FLOOR || spaces[d]! >= 0) continue;
        seen[d] = 1;
        todo.push(d);
      }
    }
    warn('unassigned-ground', `${n} walkable cell(s) belong to no zone.`, [i % cols, Math.floor(i / cols)]);
  }
  return { cols, rows, wallRows: 0, kinds, spaces, runs: [], problems };
}

/** Trees, grass, pebbles and the like: many, interchangeable, and not worth a line each in a blueprint. */
export function isScatter(i: Pick<Instance, 'name' | 'object' | 'activeIf' | 'props' | 'components'>, types: ReadonlyMap<string, ObjectType>): boolean {
  if (i.activeIf || i.components) return false;
  const o = types.get(i.object);
  if (o?.behaviors.some((b) => b.type !== 'solid')) return false;
  // A tint or a size in props doesn't make a tree any less one of many.
  if (!i.name || i.name.startsWith('~')) return true;
  return !i.props && !!o?.sway;
}

/** Draft of a painted blueprint: its elements put in the zones given, or in one zone per stretch of connected ground. */
export function draftPainted(s: Scene, ctx: BpContext, types: ReadonlyMap<string, ObjectType>, surface: BpSurface, zones?: BpSpace[]): Blueprint {
  const cols = s.cols;
  const rows = s.rows;
  let spaces = zones;
  if (!spaces) {
    spaces = [];
    const seen = new Uint8Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      if (seen[i] || surface.solid[i]) continue;
      const todo = [i];
      seen[i] = 1;
      let x0 = cols, y0 = rows, x1 = 0, y1 = 0;
      while (todo.length) {
        const c = todo.pop()!;
        const x = c % cols;
        const y = Math.floor(c / cols);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        for (const d of [x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1, c - cols, c + cols]) {
          if (d < 0 || d >= cols * rows || seen[d] || surface.solid[d]) continue;
          seen[d] = 1;
          todo.push(d);
        }
      }
      spaces.push({ id: `z${spaces.length + 1}`, kind: 'clearing', purpose: '', rects: [[x0, y0, x1 - x0 + 1, y1 - y0 + 1]] });
    }
  }
  const bp: Blueprint = { concept: '', terrain: 'painted', kit: '', size: [cols, rows], spaces, links: [], water: [], elements: [], checks: [] };
  const inside = (z: BpSpace, x: number, y: number) => z.rects.some((r) => x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]);
  const dist = (z: BpSpace, x: number, y: number) => Math.min(...z.rects.map((r) => Math.max(r[0] - x, 0, x - (r[0] + r[2] - 1)) + Math.max(r[1] - y, 0, y - (r[1] + r[3] - 1))));
  for (const i of s.instances) {
    if (isScatter(i, types)) continue;
    const size = ctx.sizeOf(i);
    const o = types.get(i.object);
    const fx = Math.floor((i.x + (size?.w ?? 0) / 2) / s.tileSize);
    const fy = Math.floor((i.y + (size?.h ?? 0) - 1) / s.tileSize);
    const home = spaces.find((z) => inside(z, fx, fy)) ?? [...spaces].sort((a, b) => dist(a, fx, fy) - dist(b, fx, fy))[0];
    if (!home) continue;
    const water = fx >= 0 && fy >= 0 && fx < cols && fy < rows && surface.solid[fy * cols + fx] && surface.water[fy * cols + fx];
    let mount: BpMount;
    if (!size) mount = 'marker';
    else if (o?.hdPose === 'flat' || (o?.z ?? 0) < 0) mount = 'flat';
    else if (water) mount = 'pit';
    else mount = 'floor';
    const { x: _x, y: _y, ...rest } = i;
    const element: BpElement = { ...rest, in: home.id, mount, at: elementAt(bp, home.id, mount, i, ctx) };
    bp.elements.push(element);
  }
  return bp;
}

export interface OpenAirContext {
  types: ReadonlyMap<string, ObjectType>;
  sizeOf: SizeOf;
}

type Add = (code: string, message: string, cell?: [number, number]) => void;

/** What goes wrong on painted ground. */
export function lintOpenAir(s: Scene, surface: BpSurface, ctx: OpenAirContext, add: Add): void {
  const { cols, rows, tileSize: T } = s;
  const total = cols * rows;
  const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && !surface.solid[y * cols + x];
  const ground = s.layers.find((l) => !l.solid)?.tiles;
  if (!ground) return;
  const hasSprite = (i: Instance) => !!(i.sprite ?? ctx.types.get(i.object)?.sprite);

  // A wall nothing shows: the ground looks like every other bit of ground, and the player stops for no reason.
  const openArt = new Set<number>();
  for (let i = 0; i < total; i++) if (!surface.solid[i]) openArt.add(ground[i]!);
  const covered = new Uint8Array(total);
  for (const i of s.instances) {
    const o = ctx.types.get(i.object);
    if (!o || !hasSprite(i) || (o.z ?? 0) < -1) continue;
    const size = ctx.sizeOf(i);
    for (let y = Math.max(0, Math.floor(i.y / T)); y <= Math.min(rows - 1, Math.floor((i.y + size.h - 1) / T)); y++) {
      for (let x = Math.max(0, Math.floor(i.x / T)); x <= Math.min(cols - 1, Math.floor((i.x + size.w - 1) / T)); x++) covered[y * cols + x] = 1;
    }
  }
  const bare = new Uint8Array(total);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!surface.solid[i] || surface.water[i] || covered[i] || !openArt.has(ground[i]!)) continue;
      if (walkable(x - 1, y) || walkable(x + 1, y) || walkable(x, y - 1) || walkable(x, y + 1)) bare[i] = 1;
    }
  }
  const done = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!bare[i] || done[i]) continue;
    const todo = [i];
    done[i] = 1;
    let n = 0;
    while (todo.length) {
      const c = todo.pop()!;
      n++;
      const x = c % cols;
      const y = Math.floor(c / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const d = ny * cols + nx;
          if (bare[d] && !done[d]) {
            done[d] = 1;
            todo.push(d);
          }
        }
      }
    }
    add('invisible-wall', `${n} solid cell(s) with nothing on them that shows why the player stops`, [i % cols, Math.floor(i / cols)]);
  }

  // A trunk the player walks through.
  for (const i of s.instances) {
    const o = ctx.types.get(i.object);
    const hb = hitboxOf(i, o);
    if (!o?.sway || !hb || !hasSprite(i) || o.behaviors.some((b) => b.type === 'solid') || i.activeIf) continue;
    const cx = Math.floor((i.x + hb.x + hb.w / 2) / T);
    const cy = Math.floor((i.y + hb.y + hb.h / 2) / T);
    if (walkable(cx, cy) && walkable(cx, cy - 1) && walkable(cx - 1, cy) && walkable(cx + 1, cy)) add('walk-through', `${i.object} stands in the open with nothing solid under its trunk: it can be walked through`, [cx, cy]);
  }

  // Ground nobody can get to: nothing leads there.
  const reached = new Uint8Array(total);
  const entries = s.instances.filter((i) => i.object === 'player' || ctx.types.get(i.object)?.behaviors.some((b) => b.type === 'script' && (b as { name?: string }).name === 'Warp') || !!i.components?.Warp);
  const todo: number[] = [];
  const seed = (x: number, y: number) => {
    if (!walkable(x, y) || reached[y * cols + x]) return;
    reached[y * cols + x] = 1;
    todo.push(y * cols + x);
  };
  for (const e of entries) {
    const x = Math.floor((e.x + 16) / T);
    const y = Math.floor((e.y + (e.object === 'player' ? 48 : 16)) / T);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) seed(x + dx, y + dy);
  }
  while (todo.length) {
    const c = todo.pop()!;
    const x = c % cols;
    const y = Math.floor(c / cols);
    seed(x + 1, y);
    seed(x - 1, y);
    seed(x, y + 1);
    seed(x, y - 1);
  }
  if (entries.length) {
    const pocket = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (surface.solid[i] || reached[i] || pocket[i]) continue;
      const list = [i];
      pocket[i] = 1;
      let n = 0;
      while (list.length) {
        const c = list.pop()!;
        n++;
        const x = c % cols;
        for (const d of [x > 0 ? c - 1 : -1, x < cols - 1 ? c + 1 : -1, c - cols, c + cols]) {
          if (d < 0 || d >= total || surface.solid[d] || reached[d] || pocket[d]) continue;
          pocket[d] = 1;
          list.push(d);
        }
      }
      if (n >= 4) add('sealed-ground', `${n} walkable cell(s) that nothing leads to`, [i % cols, Math.floor(i / cols)]);
    }
  }

  // A way out with nothing to show it.
  for (const e of entries) {
    if (e.object === 'player') continue;
    const x = Math.floor((e.x + 16) / T);
    const y = Math.floor((e.y + 16) / T);
    if (x <= 1 || y <= 1 || x >= cols - 2 || y >= rows - 2) continue;
    const marked = s.instances.some((i) => i !== e && hasSprite(i) && !ctx.types.get(i.object)?.sway && i.x - T < (x + 1) * T && i.x + ctx.sizeOf(i).w + T > x * T && i.y - T < (y + 1) * T && i.y + ctx.sizeOf(i).h + T > y * T);
    if (!marked) add('unmarked-exit', `${e.name ?? 'exit'} is in the middle of the map with nothing that shows a way out`, [x, y]);
  }
}
