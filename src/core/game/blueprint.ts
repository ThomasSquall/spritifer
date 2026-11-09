/**
 * Blueprints: a map written as what it is (rooms, passages, water, things placed on walls and floors) instead of tiles and
 * pixels. Tiles, collision and the walls of the 2D-HD view are all compiled from it, so they can't disagree, and a map that
 * makes no architectural sense is refused before anyone has to look at it. Pure and browser-safe; pixels are in blueprintBake.ts.
 *
 * The rules of the place: what is not a declared space is empty darkness, not rock. Every room gets its own walls: a front
 * `wallRows` tiles high on its north side with a top behind it, one tile of wall on the east and west sides, a low kerb on the
 * south side so that the camera sees in.
 */

import type { HdCells } from './hd.js';
import type { Instance, Value } from './types.js';

export type BpRect = [x: number, y: number, w: number, h: number];
export type BpMount = 'floor' | 'wall' | 'flat' | 'pit' | 'marker';
/** A cell: absolute [x, y], the middle of a space ("sala"), or a cell counted from a space's origin (["sala", 2, 3]). */
export type BpPoint = [number, number] | string | [string, number, number];

export interface BpSpace {
  id: string;
  kind: 'hall' | 'room' | 'corridor' | 'alcove' | 'landing' | 'gallery' | 'clearing' | 'road' | 'plaza' | 'shore' | 'marsh' | 'maze' | 'cave' | 'quarter';
  /** What happens or happened here: a space nobody can explain doesn't belong on the map. */
  purpose: string;
  rects: BpRect[];
}

export interface BpLink {
  a: string;
  b: string;
  via: 'open' | 'arch' | 'door' | 'gate' | 'stair' | 'bridge';
  note?: string;
}

export interface BpFlow {
  /** Expression: the moving water shows while it is true. */
  when: string;
  look?: string;
  name?: string;
  /** Other water areas that fill together with this one: no bank is drawn between them. */
  joined?: string[];
}

export interface BpWater {
  id: string;
  /** canal: water, can't be walked. dry: empty channel, can't be walked. basin: can be walked until something blocks it. */
  kind: 'canal' | 'dry' | 'basin';
  rects: BpRect[];
  flows?: BpFlow[];
}

/** An instance of the scene, placed by where it stands rather than by pixels. */
export interface BpElement extends Omit<Instance, 'x' | 'y'> {
  /** The space it belongs to: it moves with it. */
  in: string;
  /** Tiles from the space's origin: where the feet are; for a marker (no sprite), the top-left corner. */
  at: [number, number];
  mount: BpMount;
}

export interface BpCheck {
  name: string;
  vars?: Record<string, Value>;
  from: BpPoint;
  reach?: BpPoint[];
  block?: BpPoint[];
}

export interface Blueprint {
  /** One or two sentences: what this place is and why it is built this way. */
  concept: string;
  /** "painted": the terrain stays as it was painted (woods, towns, caves) and spaces are named zones of it. Absent: built from a kit. */
  terrain?: 'painted';
  /** Architecture kit; not used by painted terrain. */
  kit: string;
  size: [cols: number, rows: number];
  spaces: BpSpace[];
  links: BpLink[];
  water: BpWater[];
  elements: BpElement[];
  checks: BpCheck[];
  /** Cells painted by hand over the compiled map: "x,y" to the ground tile and/or the solid tile. */
  paint?: Record<string, { g?: number; w?: number }>;
  /** Corrections to the height of walls made by hand. */
  hdCells?: HdCells;
}

export interface BpProblem {
  level: 'error' | 'warning';
  code: string;
  message: string;
  cell?: [number, number];
}

export const CELL = { VOID: 0, FLOOR: 1, FRONT: 2, TOP: 3, SIDE: 4, KERB: 5, WATER: 6, DRY: 7, BASIN: 8, THICKET: 9 } as const;
export type CellKind = (typeof CELL)[keyof typeof CELL];

export interface WallRun {
  x: number;
  /** Row of the foot of the front. */
  foot: number;
  length: number;
}

export interface BpPlan {
  cols: number;
  rows: number;
  wallRows: number;
  kinds: Uint8Array;
  /** Index of the space of each interior cell, -1 elsewhere. */
  spaces: Int16Array;
  runs: WallRun[];
  problems: BpProblem[];
}

export const isInterior = (k: number) => k === CELL.FLOOR || k === CELL.WATER || k === CELL.DRY || k === CELL.BASIN;
export const isWallKind = (k: number) => k === CELL.FRONT || k === CELL.TOP || k === CELL.SIDE || k === CELL.KERB;
export const isSolidKind = (k: number) => isWallKind(k) || k === CELL.WATER || k === CELL.DRY || k === CELL.THICKET;

/** Reads a blueprint from anywhere, filling what can be filled; what is wrong with it is reported by planBlueprint. */
export function normalizeBlueprint(v: unknown): Blueprint | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Partial<Blueprint>;
  return {
    concept: typeof o.concept === 'string' ? o.concept : '',
    // No kit means there is nothing to build the terrain with: it was painted.
    ...(o.terrain === 'painted' || (Array.isArray(o.spaces) && !o.kit) ? { terrain: 'painted' as const } : {}),
    kit: typeof o.kit === 'string' ? o.kit : '',
    size: Array.isArray(o.size) && o.size.length === 2 ? [Math.max(1, Math.round(Number(o.size[0]))), Math.max(1, Math.round(Number(o.size[1])))] : [20, 12],
    spaces: Array.isArray(o.spaces) ? o.spaces : [],
    links: Array.isArray(o.links) ? o.links : [],
    water: Array.isArray(o.water) ? o.water : [],
    elements: Array.isArray(o.elements) ? o.elements : [],
    checks: Array.isArray(o.checks) ? o.checks : [],
    ...(o.paint && typeof o.paint === 'object' ? { paint: o.paint } : {}),
    ...(o.hdCells && typeof o.hdCells === 'object' ? { hdCells: o.hdCells } : {}),
  };
}

const eachCell = (r: BpRect, f: (x: number, y: number) => void) => {
  for (let y = r[1]; y < r[1] + r[3]; y++) for (let x = r[0]; x < r[0] + r[2]; x++) f(x, y);
};

const touches = (a: BpRect, b: BpRect) => a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3] && !((a[0] === b[0] + b[2] || b[0] === a[0] + a[2]) && (a[1] === b[1] + b[3] || b[1] === a[1] + a[3]));

/** Lays the blueprint out on the grid and reports every way it can't stand up. */
export function planBlueprint(bp: Blueprint, wallRows = 3): BpPlan {
  const [cols, rows] = bp.size;
  const total = cols * rows;
  const kinds = new Uint8Array(total);
  const spaces = new Int16Array(total).fill(-1);
  const problems: BpProblem[] = [];
  const err = (code: string, message: string, cell?: [number, number]) => problems.push({ level: 'error', code, message, ...(cell ? { cell } : {}) });
  const warn = (code: string, message: string, cell?: [number, number]) => problems.push({ level: 'warning', code, message, ...(cell ? { cell } : {}) });
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  const at = (x: number, y: number) => y * cols + x;
  const interior = (x: number, y: number) => inMap(x, y) && isInterior(kinds[at(x, y)]!);

  if (!bp.concept.trim()) err('no-concept', 'The blueprint has no concept: say what this place is and why it is built this way.');
  const ids = new Set<string>();
  bp.spaces.forEach((s, n) => {
    if (ids.has(s.id)) err('duplicate-space', `Two spaces are called "${s.id}".`);
    ids.add(s.id);
    if (!s.purpose?.trim()) err('no-purpose', `Space "${s.id}" has no purpose: what happens or happened here?`);
    if (!s.rects?.length) err('empty-space', `Space "${s.id}" has no rects.`);
    for (const r of s.rects ?? []) {
      if (r[2] < 1 || r[3] < 1 || r[0] < 0 || r[1] < 0 || r[0] + r[2] > cols || r[1] + r[3] > rows) {
        err('out-of-map', `Space "${s.id}" has a rect outside the ${cols}x${rows} map: [${r.join(', ')}].`, [r[0], r[1]]);
        continue;
      }
      eachCell(r, (x, y) => {
        kinds[at(x, y)] = CELL.FLOOR;
        spaces[at(x, y)] = n;
      });
    }
  });

  for (const w of bp.water) {
    const k = w.kind === 'canal' ? CELL.WATER : w.kind === 'dry' ? CELL.DRY : CELL.BASIN;
    for (const r of w.rects ?? []) {
      eachCell(r, (x, y) => {
        if (!interior(x, y)) err('water-outside', `Water "${w.id}" reaches (${x}, ${y}), which is outside every space: water needs a room to be in.`, [x, y]);
        else kinds[at(x, y)] = k;
      });
    }
  }

  // Passages are declared: two spaces that touch without a link are an accident.
  const linked = (a: string, b: string) => bp.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  for (const l of bp.links) {
    for (const end of [l.a, l.b]) if (!ids.has(end)) err('unknown-space', `A link names "${end}", which is not a space.`);
  }
  for (let i = 0; i < bp.spaces.length; i++) {
    for (let j = i + 1; j < bp.spaces.length; j++) {
      const a = bp.spaces[i]!;
      const b = bp.spaces[j]!;
      const meet = (a.rects ?? []).some((p) => (b.rects ?? []).some((q) => touches(p, q)));
      if (meet && !linked(a.id, b.id)) err('undeclared-opening', `Spaces "${a.id}" and "${b.id}" touch but no link joins them: declare how one leads to the other.`, [(a.rects[0] ?? [0, 0])[0], (a.rects[0] ?? [0, 0])[1]]);
      if (!meet && linked(a.id, b.id)) err('link-across-gap', `Spaces "${a.id}" and "${b.id}" are linked but don't touch: add the passage between them as a space.`);
    }
  }
  // Nothing floats off on its own.
  if (bp.spaces.length > 1) {
    const seen = new Set<string>([bp.spaces[0]!.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const l of bp.links) {
        if (seen.has(l.a) !== seen.has(l.b)) {
          seen.add(l.a);
          seen.add(l.b);
          grew = true;
        }
      }
    }
    for (const s of bp.spaces) if (!seen.has(s.id)) err('cut-off', `Space "${s.id}" isn't linked to the rest of the map.`);
  }

  // Walls: each room's own, worked out from the rooms.
  const fronts: { x: number; y: number; row: number }[] = [];
  const reported = new Set<string>();
  for (let y = 1; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!interior(x, y) || interior(x, y - 1)) continue;
      for (let row = 0; row < wallRows; row++) {
        const wy = y - 1 - row;
        if (wy < 0) {
          err('no-room-for-wall', `The room at (${x}, ${y}) is too close to the top of the map: its wall needs ${wallRows} rows above it.`, [x, y]);
          break;
        }
        if (interior(x, wy)) {
          const key = `${wy}`;
          if (!reported.has(key)) {
            reported.add(key);
            err('thin-wall', `Only ${row} row(s) of wall between the floor at row ${wy} and the floor at row ${y} (first at column ${x}): a wall front needs ${wallRows}, plus one for its top.`, [x, wy]);
          }
          break;
        }
        fronts.push({ x, y: wy, row });
      }
    }
  }
  for (const f of fronts) kinds[at(f.x, f.y)] = CELL.FRONT;

  const body = (x: number, y: number) => inMap(x, y) && (isInterior(kinds[at(x, y)]!) || kinds[at(x, y)] === CELL.FRONT);
  const ring: [number, number][] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (body(x, y)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && body(x + dx, y + dy)) near = true;
      if (near) ring.push([x, y]);
    }
  }
  const isFront = (x: number, y: number) => inMap(x, y) && kinds[at(x, y)] === CELL.FRONT;
  for (const [x, y] of ring) {
    let kind: CellKind = CELL.SIDE;
    if (isFront(x, y + 1)) kind = CELL.TOP;
    else if (interior(x, y - 1)) kind = CELL.KERB;
    // The outer south corners of a room stay low with the kerb they end.
    else if ((interior(x - 1, y - 1) && !body(x - 1, y)) || (interior(x + 1, y - 1) && !body(x + 1, y))) kind = CELL.KERB;
    kinds[at(x, y)] = kind;
  }

  // A front with floor right behind it has no top to stand on, however it is lit.
  for (const f of fronts) {
    if (f.row !== wallRows - 1) continue;
    if (interior(f.x, f.y - 1) && !reported.has(`top${f.y}`)) {
      reported.add(`top${f.y}`);
      warn('wall-no-top', `The wall at row ${f.y} has floor right behind it (first at column ${f.x}): one more row would give it a top.`, [f.x, f.y]);
    }
  }

  const runs: WallRun[] = [];
  for (let y = 0; y < rows - 1; y++) {
    let x = 0;
    while (x < cols) {
      const foot = (cx: number) => isFront(cx, y) && interior(cx, y + 1);
      if (!foot(x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < cols && foot(x)) x++;
      runs.push({ x: start, foot: y, length: x - start });
    }
  }
  return { cols, rows, wallRows, kinds, spaces, runs, problems };
}

/** Which cells of a compiled map stay flat in the 2D-HD view: the kerbs. Anything else that is a wall stands up on its own. */
export function planHdCells(plan: BpPlan): HdCells {
  const out: HdCells = {};
  for (let y = 0; y < plan.rows; y++) for (let x = 0; x < plan.cols; x++) if (plan.kinds[y * plan.cols + x] === CELL.KERB) out[`${x},${y}`] = 0;
  return out;
}

/** Stable short id for what is generated. */
export function bpHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 8);
}

export interface BpContext {
  tile: number;
  /** Size of what the element shows; null if it shows nothing. */
  sizeOf: (e: Pick<Instance, 'sprite' | 'object'>) => { w: number; h: number } | null;
  waterSprite?: string;
  /** The solid box of an instance, in pixels; null if it can be walked through. */
  bodyOf?: (i: Instance) => { x: number; y: number; w: number; h: number } | null;
}

export const originOf = (bp: Blueprint, space: string): [number, number] | null => {
  const r = bp.spaces.find((s) => s.id === space)?.rects?.[0];
  return r ? [r[0], r[1]] : null;
};

/** Pixels of an instance from where the element stands. */
export function elementPosition(bp: Blueprint, e: BpElement, ctx: BpContext): { x: number; y: number } | null {
  const o = originOf(bp, e.in);
  if (!o) return null;
  const x = (o[0] + e.at[0]) * ctx.tile;
  const y = (o[1] + e.at[1]) * ctx.tile;
  if (e.mount === 'marker') return { x: Math.round(x), y: Math.round(y) };
  const size = ctx.sizeOf(e) ?? { w: ctx.tile, h: ctx.tile };
  return { x: Math.round(x - size.w / 2), y: Math.round(y - size.h) };
}

/** The other way round: where an instance, wherever it has been dragged to, stands in a space. */
export function elementAt(bp: Blueprint, space: string, mount: BpMount, e: Pick<Instance, 'x' | 'y' | 'sprite' | 'object'>, ctx: BpContext): [number, number] {
  const o = originOf(bp, space) ?? [0, 0];
  const size = mount === 'marker' ? { w: 0, h: 0 } : (ctx.sizeOf(e) ?? { w: ctx.tile, h: ctx.tile });
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return [round((e.x + size.w / 2) / ctx.tile - o[0]), round((e.y + size.h) / ctx.tile - o[1])];
}

const POSES: Partial<Record<BpMount, Pick<Instance, 'hdPose' | 'order'>>> = { flat: { hdPose: 'flat', order: -5 }, pit: { order: -4 }, floor: { hdPose: 'stand' } };

/** Cells of a set of water areas, and the instances of its moving water. */
function flowInstances(bp: Blueprint, ctx: BpContext): Instance[] {
  const out: Instance[] = [];
  if (!ctx.waterSprite) return out;
  const cellsOf = (w: BpWater) => {
    const set = new Set<string>();
    for (const r of w.rects) eachCell(r, (x, y) => set.add(`${x},${y}`));
    return set;
  };
  for (const w of bp.water) {
    for (const f of w.flows ?? []) {
      const own = cellsOf(w);
      const region = new Set(own);
      for (const id of f.joined ?? []) {
        const other = bp.water.find((o) => o.id === id);
        if (other) for (const c of cellsOf(other)) region.add(c);
      }
      for (const c of own) {
        const [x, y] = c.split(',').map(Number) as [number, number];
        const open = (dx: number, dy: number) => !region.has(`${x + dx},${y + dy}`);
        const mask = (open(0, -1) ? 1 : 0) + (open(1, 0) ? 2 : 0) + (open(0, 1) ? 4 : 0) + (open(-1, 0) ? 8 : 0);
        out.push({ id: bpHash(`${w.id}|${f.when}|${c}`), object: 'deco', name: f.name ?? 'acqua', sprite: ctx.waterSprite, animation: `${f.look ?? 'm'}${mask}`, x: x * ctx.tile, y: y * ctx.tile, activeIf: f.when, hdPose: 'flat', order: -6 });
      }
    }
  }
  return out;
}

/** Every instance the blueprint places. */
export function blueprintInstances(bp: Blueprint, ctx: BpContext): Instance[] {
  const out: Instance[] = [];
  for (const e of bp.elements) {
    const pos = elementPosition(bp, e, ctx);
    if (!pos) continue;
    const { in: _space, at: _at, mount, ...rest } = e;
    out.push({ ...(POSES[mount] ?? {}), ...rest, ...pos } as Instance);
  }
  out.push(...flowInstances(bp, ctx));
  return out;
}

/** Reports elements that have no business where they are. */
export function checkElements(bp: Blueprint, plan: BpPlan, ctx: BpContext): BpProblem[] {
  const out: BpProblem[] = [];
  const err = (code: string, message: string, cell?: [number, number]) => out.push({ level: 'error', code, message, ...(cell ? { cell } : {}) });
  const kindAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < plan.cols && y < plan.rows ? plan.kinds[y * plan.cols + x]! : CELL.VOID);
  const label = (e: BpElement) => `"${e.name ?? e.object}" (${e.id})`;
  const ids = new Set<string>();
  for (const e of bp.elements) {
    if (ids.has(e.id)) err('duplicate-element', `Two elements have the id ${e.id}.`);
    ids.add(e.id);
    const o = originOf(bp, e.in);
    if (!o) {
      err('unknown-space', `Element ${label(e)} is in "${e.in}", which is not a space.`);
      continue;
    }
    if (e.mount === 'marker') continue;
    const fx = Math.floor(o[0] + e.at[0]);
    // The feet stand on the last pixel row of the art, not on the row below it.
    const fy = Math.floor(o[1] + e.at[1] - 1 / ctx.tile);
    const k = kindAt(fx, fy);
    const cell: [number, number] = [fx, fy];
    if (e.mount === 'wall') {
      if (k !== CELL.FRONT && !(k === CELL.FLOOR && kindAt(fx, fy - 1) === CELL.FRONT)) err('not-on-wall', `Element ${label(e)} is mounted on a wall, but cell (${fx}, ${fy}) is not at a wall front.`, cell);
    } else if (e.mount === 'floor' && k === CELL.THICKET) {
      // Out of doors, what stands in the thick of the wood is fine: houses and ruins are what makes that ground solid.
    } else if (e.mount === 'floor') {
      if (k === CELL.WATER || k === CELL.DRY) err('standing-in-water', `Element ${label(e)} stands in a canal at (${fx}, ${fy}): use mount "pit" if it is meant to, or move it to the floor.`, cell);
      else if (k !== CELL.FLOOR && k !== CELL.BASIN) err('not-on-floor', `Element ${label(e)} stands at (${fx}, ${fy}), which is not floor.`, cell);
    } else if (e.mount === 'flat') {
      if (k === CELL.VOID || isWallKind(k)) err('not-on-floor', `Element ${label(e)} lies at (${fx}, ${fy}), which is not floor.`, cell);
    } else if (e.mount === 'pit') {
      if (k !== CELL.WATER && k !== CELL.DRY && k !== CELL.BASIN) err('pit-without-pit', `Element ${label(e)} is mounted in a pit, but (${fx}, ${fy}) is not a canal or basin.`, cell);
    }
  }
  // Big things on top of each other read as a mistake. Alternatives for different moments of the story don't count.
  const shown = bp.elements.flatMap((e) => {
    // What lies on the ground is meant to be walked and stood on.
    if (e.mount === 'marker' || e.mount === 'flat') return [];
    const s = ctx.sizeOf(e);
    const p = elementPosition(bp, e, ctx);
    return s && p && s.w >= 48 && s.h >= 48 ? [{ e, x: p.x, y: p.y, w: s.w, h: s.h }] : [];
  });
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!;
      const b = shown[j]!;
      if (a.e.activeIf && b.e.activeIf && a.e.activeIf !== b.e.activeIf) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0 && h > 0 && w * h > 0.3 * Math.min(a.w * a.h, b.w * b.h)) out.push({ level: 'warning', code: 'overlap', message: `${label(a.e)} and ${label(b.e)} are drawn on top of each other.`, cell: [Math.floor(a.x / ctx.tile), Math.floor(a.y / ctx.tile)] });
    }
  }
  return out;
}

export function pointCell(bp: Blueprint, p: BpPoint): [number, number] | null {
  if (typeof p === 'string') {
    const r = bp.spaces.find((s) => s.id === p)?.rects?.[0];
    return r ? [r[0] + Math.floor(r[2] / 2), r[1] + Math.floor(r[3] / 2)] : null;
  }
  if (typeof p[0] === 'string') {
    const o = originOf(bp, p[0]);
    return o ? [o[0] + (p[1] as number), o[1] + (p[2] as number)] : null;
  }
  return [p[0], p[1] as number];
}

/** Whether the declared routes hold: from each start, what must be reached and what must not, at each moment of the story. */
export function runChecks(bp: Blueprint, plan: BpPlan, ctx: BpContext, evaluate: (expr: string, vars: Record<string, Value>) => boolean, others: readonly Instance[] = []): BpProblem[] {
  const out: BpProblem[] = [];
  const blockSizes = /^blk_(\d+)x(\d+)$/;
  for (const c of bp.checks) {
    const vars = c.vars ?? {};
    const solid = new Uint8Array(plan.cols * plan.rows);
    plan.kinds.forEach((k, i) => {
      if (isSolidKind(k) || k === CELL.VOID) solid[i] = 1;
    });
    for (const i of [...blueprintInstances(bp, ctx), ...others]) {
      if (i.activeIf && !evaluate(i.activeIf, vars)) continue;
      const body = ctx.bodyOf?.(i);
      if (body) {
        // A cell is shut only if the body covers its middle: a player slips past a trunk at the edge of a tile.
        for (let y = Math.floor(body.y / ctx.tile); y * ctx.tile < body.y + body.h; y++) {
          for (let x = Math.floor(body.x / ctx.tile); x * ctx.tile < body.x + body.w; x++) {
            const mx = (x + 0.5) * ctx.tile;
            const my = (y + 0.5) * ctx.tile;
            if (mx >= body.x && mx < body.x + body.w && my >= body.y && my < body.y + body.h && x >= 0 && y >= 0 && x < plan.cols && y < plan.rows) solid[y * plan.cols + x] = 1;
          }
        }
      }
      const m = blockSizes.exec(i.object);
      if (!m) continue;
      const x0 = Math.floor(i.x / ctx.tile);
      const y0 = Math.floor(i.y / ctx.tile);
      for (let y = y0; y < y0 + Number(m[2]); y++) for (let x = x0; x < x0 + Number(m[1]); x++) if (x >= 0 && y >= 0 && x < plan.cols && y < plan.rows) solid[y * plan.cols + x] = 1;
    }
    const start = pointCell(bp, c.from);
    if (!start) {
      out.push({ level: 'error', code: 'bad-check', message: `Check "${c.name}" starts at an unknown place.` });
      continue;
    }
    const seen = new Uint8Array(plan.cols * plan.rows);
    const todo: [number, number][] = [start];
    seen[start[1] * plan.cols + start[0]] = 1;
    while (todo.length) {
      const [x, y] = todo.pop()!;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= plan.cols || ny >= plan.rows) continue;
        const i = ny * plan.cols + nx;
        if (seen[i] || solid[i]) continue;
        seen[i] = 1;
        todo.push([nx, ny]);
      }
    }
    const reached = (p: BpPoint) => {
      const cell = pointCell(bp, p);
      return cell ? !!seen[cell[1] * plan.cols + cell[0]] : false;
    };
    // Something solid standing there is still reached by getting next to it: a chest, a lever.
    const nextTo = (p: BpPoint) => {
      const cell = pointCell(bp, p);
      if (!cell) return false;
      return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const x = cell[0] + dx!;
        const y = cell[1] + dy!;
        return x >= 0 && y >= 0 && x < plan.cols && y < plan.rows && !!seen[y * plan.cols + x];
      });
    };
    for (const p of c.reach ?? []) if (!nextTo(p)) out.push({ level: 'error', code: 'route-broken', message: `Check "${c.name}": ${JSON.stringify(p)} can't be reached.`, ...(pointCell(bp, p) ? { cell: pointCell(bp, p)! } : {}) });
    for (const p of c.block ?? []) if (reached(p)) out.push({ level: 'error', code: 'route-open', message: `Check "${c.name}": ${JSON.stringify(p)} should not be reachable yet.`, ...(pointCell(bp, p) ? { cell: pointCell(bp, p)! } : {}) });
  }
  return out;
}
