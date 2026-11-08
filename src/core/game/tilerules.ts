/**
 * Tileset rules: what turns a grid of painted tiles into terrain that doesn't look like a grid.
 *
 * - "grid": a big seamless texture cut into k×k tiles; the cell shows the piece for its position (no repetition).
 * - "random": one of `count` alternatives picked by position.
 * - "blob": 47-shape autotile (edges, outer and inner corners) chosen from the 8 neighbours, optionally
 *   with k×k position pieces per shape (forest canopies, cliffs, water bodies).
 * - edges: overlays drawn on cells next to other terrain (grass creeping onto paths, foam on shores).
 *
 * The scene stores only the painted tile; collisions use it too. Rules live in game.json → tilesets.
 */

import type { TileLayer } from './types.js';

export interface TileRule {
  /** The painted tile index. */
  tile: number;
  kind: 'grid' | 'random' | 'blob';
  /** First tile of the rule's block in the tileset. */
  first: number;
  /** grid / blob: pieces per side (block of size×size per shape). Default 1. */
  size?: number;
  /** random: number of alternatives. */
  count?: number;
  /** blob: painted tiles counted as the same terrain (default just `tile`). */
  group?: number[];
  /** blob: outside the map counts as the same terrain (default true). */
  border?: boolean;
  /** Animated: this many copies of the block follow each other (water, lava). */
  frames?: number;
  /** Animation speed (frames per second, default 4). */
  fps?: number;
}

export interface EdgeRule {
  /** Cells painted with these tiles get the overlay... */
  on: number[];
  /** ...on the sides where a neighbour is one of these. */
  from: number[];
  /** First tile of the 47-shape overlay block. */
  first: number;
  /** Empty cells of the layer count as `from` too (water painted on its own layer: empty = land). */
  empty?: boolean;
  size?: number;
  frames?: number;
  fps?: number;
}

export interface TilesetRules {
  rules?: TileRule[];
  edges?: EdgeRule[];
  /** How many tiles (from 0) the editor palette shows: the rest are generated pieces. */
  paintable?: number;
}

// Neighbour bits.
const N = 1, NE = 2, E = 4, SE = 8, S = 16, SW = 32, W = 64, NW = 128;

/** A corner only counts when both edges next to it do (the standard 47-tile blob reduction). */
export function reduceBlob(m: number): number {
  let r = m & (N | E | S | W);
  if (m & NE && m & N && m & E) r |= NE;
  if (m & SE && m & S && m & E) r |= SE;
  if (m & SW && m & S && m & W) r |= SW;
  if (m & NW && m & N && m & W) r |= NW;
  return r;
}

/** The 47 reduced masks in ascending order; a shape's index is its position here. */
export const BLOB_MASKS: number[] = [...new Set(Array.from({ length: 256 }, (_, m) => reduceBlob(m)))].sort((a, b) => a - b);
const BLOB_INDEX = new Map(BLOB_MASKS.map((m, i) => [m, i]));
export const BLOB_FULL = BLOB_INDEX.get(255)!;

/** Stable per-cell hash in [0, 1). */
export function cellHash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Pre-indexed rules for fast lookups. */
export class TileResolver {
  private byTile = new Map<number, TileRule & { groupSet: Set<number> }>();
  private edges: (EdgeRule & { onSet: Set<number>; fromSet: Set<number> })[] = [];

  constructor(rules: TilesetRules | undefined) {
    for (const r of rules?.rules ?? []) this.byTile.set(r.tile, { ...r, groupSet: new Set(r.group?.length ? r.group : [r.tile]) });
    for (const e of rules?.edges ?? []) this.edges.push({ ...e, onSet: new Set(e.on), fromSet: new Set(e.from) });
  }

  get empty(): boolean {
    return !this.byTile.size && !this.edges.length;
  }

  private mask(layer: TileLayer, cols: number, rows: number, tx: number, ty: number, same: (t: number) => boolean, border: boolean): number {
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? border : same(layer.tiles[y * cols + x]));
    let m = 0;
    if (at(tx, ty - 1)) m |= N;
    if (at(tx + 1, ty - 1)) m |= NE;
    if (at(tx + 1, ty)) m |= E;
    if (at(tx + 1, ty + 1)) m |= SE;
    if (at(tx, ty + 1)) m |= S;
    if (at(tx - 1, ty + 1)) m |= SW;
    if (at(tx - 1, ty)) m |= W;
    if (at(tx - 1, ty - 1)) m |= NW;
    return m;
  }

  /** Tiles to draw for a cell, bottom to top (the painted tile, or its generated piece, then overlays). */
  resolve(layer: TileLayer, cols: number, rows: number, tx: number, ty: number, out: number[], clock = 0): number[] {
    const frame = (r: { frames?: number; fps?: number }, block: number) => (r.frames && r.frames > 1 ? (Math.floor(clock * (r.fps ?? 4)) % r.frames) * block : 0);
    out.length = 0;
    const t = layer.tiles[ty * cols + tx];
    if (t < 0) return out;
    const r = this.byTile.get(t);
    if (!r) out.push(t);
    else {
      const k = Math.max(1, r.size ?? 1);
      const piece = mod(ty, k) * k + mod(tx, k);
      if (r.kind === 'grid') out.push(r.first + frame(r, k * k) + piece);
      else if (r.kind === 'random') out.push(r.first + frame(r, Math.max(1, r.count ?? 1)) + Math.floor(cellHash(tx, ty, t) * Math.max(1, r.count ?? 1)));
      else {
        const shape = BLOB_INDEX.get(reduceBlob(this.mask(layer, cols, rows, tx, ty, (x) => r.groupSet.has(x), r.border !== false))) ?? BLOB_FULL;
        out.push(r.first + frame(r, BLOB_MASKS.length * k * k) + shape * k * k + piece);
      }
    }
    for (const e of this.edges) {
      if (!e.onSet.has(t)) continue;
      const shape = BLOB_INDEX.get(reduceBlob(this.mask(layer, cols, rows, tx, ty, (x) => !e.fromSet.has(x) && !(e.empty && x < 0), true))) ?? BLOB_FULL;
      if (shape === BLOB_FULL) continue;
      const k = Math.max(1, e.size ?? 1);
      out.push(e.first + frame(e, BLOB_MASKS.length * k * k) + shape * k * k + mod(ty, k) * k + mod(tx, k));
    }
    return out;
  }
}

const ints = (v: unknown): number[] | undefined => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x >= 0) : undefined);
const int = (v: unknown, d?: number): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : d);

export function normalizeTilesetRules(v: unknown): TilesetRules | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const rules: TileRule[] = [];
  for (const x of Array.isArray(o.rules) ? o.rules : []) {
    const R = (x ?? {}) as Record<string, unknown>;
    const tile = int(R.tile);
    const first = int(R.first);
    const kind = R.kind === 'grid' || R.kind === 'random' || R.kind === 'blob' ? R.kind : undefined;
    if (tile === undefined || first === undefined || !kind) continue;
    const rule: TileRule = { tile, kind, first };
    const size = int(R.size);
    if (size && size > 1) rule.size = Math.min(16, size);
    const count = int(R.count);
    if (count) rule.count = count;
    const group = ints(R.group);
    if (group?.length) rule.group = group;
    if (R.border === false) rule.border = false;
    const frames = int(R.frames);
    if (frames && frames > 1) rule.frames = Math.min(64, frames);
    if (typeof R.fps === 'number' && R.fps > 0) rule.fps = Math.min(60, R.fps);
    rules.push(rule);
  }
  const edges: EdgeRule[] = [];
  for (const x of Array.isArray(o.edges) ? o.edges : []) {
    const E = (x ?? {}) as Record<string, unknown>;
    const on = ints(E.on);
    const from = ints(E.from);
    const first = int(E.first);
    if (!on?.length || !from?.length || first === undefined) continue;
    const edge: EdgeRule = { on, from, first };
    if (E.empty === true) edge.empty = true;
    const size = int(E.size);
    if (size && size > 1) edge.size = Math.min(16, size);
    const frames = int(E.frames);
    if (frames && frames > 1) edge.frames = Math.min(64, frames);
    if (typeof E.fps === 'number' && E.fps > 0) edge.fps = Math.min(60, E.fps);
    edges.push(edge);
  }
  const out: TilesetRules = {};
  if (rules.length) out.rules = rules;
  if (edges.length) out.edges = edges;
  const paintable = int(o.paintable);
  if (paintable) out.paintable = paintable;
  return Object.keys(out).length ? out : undefined;
}
