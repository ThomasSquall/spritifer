/**
 * Paints a planned blueprint: every cell composed from a kit of art and de-duplicated into a tile sheet. Same blueprint, same
 * tiles: the sheet only ever grows, so tile numbers already in use keep meaning the same picture. Pure and browser-safe.
 */

import type { Bitmap } from '../sprite.js';
import { type BpPlan, CELL, isInterior } from './blueprint.js';
import type { HdJut } from './hd.js';

export interface MapKit {
  /** Sheet the map's tiles are baked into. */
  tileset: string;
  /** Tile number marking a wall in the collision layer. */
  solidTile: number;
  /** Tile number marking water in the collision layer. */
  waterTile: number;
  wall: { sprite: string; segments?: number[][] };
  pier?: { sprite: string; depth: number; shaft: [number, number] };
  floor: { sprite: string };
  roof: { sprite: string; kerb: [string, string]; dark: string; joint: string };
  moss?: { sprite: string };
  water?: { sprite: string; frames: number; fps: number; ramp: [string, string] };
  dry?: { sprite: string };
  /** Sprite of moving water laid over a channel as instances. */
  flowSprite?: string;
}

export interface KitArt {
  wall: Bitmap;
  pier?: Bitmap;
  floor: Bitmap;
  roof: Bitmap;
  moss?: Bitmap;
  /** Frames side by side. */
  water?: Bitmap;
  dry?: Bitmap;
}

export interface TileRule {
  tile: number;
  kind: 'grid';
  first: number;
  frames: number;
  fps: number;
}

const hex = (c: string): [number, number, number] => {
  const n = parseInt(c.replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const hashOf = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function random(seed: string): () => number {
  let a = hashOf(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const keyOf = (t: Uint8ClampedArray) => String.fromCharCode(...new Uint16Array(t.buffer, t.byteOffset, t.byteLength >> 1));

/** The sheet tiles are baked into. Existing tiles are never moved. */
export class TileSheet {
  private readonly ids = new Map<string, number>();
  private readonly tiles: Uint8ClampedArray[] = [];
  private readonly blocks = new Map<string, number>();
  readonly first: number;

  constructor(existing: Bitmap | null, readonly size: number, readonly across = 16) {
    if (existing) {
      const across_ = Math.floor(existing.width / size);
      const count = across_ * Math.floor(existing.height / size);
      for (let i = 0; i < count; i++) {
        const t = new Uint8ClampedArray(size * size * 4);
        const ox = (i % across_) * size;
        const oy = Math.floor(i / across_) * size;
        for (let y = 0; y < size; y++) t.set(existing.data.subarray(((oy + y) * existing.width + ox) * 4, ((oy + y) * existing.width + ox + size) * 4), y * size * 4);
        this.tiles.push(t);
        const k = keyOf(t);
        if (!this.ids.has(k)) this.ids.set(k, i);
      }
      this.across = across_;
    }
    this.first = this.tiles.length;
  }

  get count(): number {
    return this.tiles.length;
  }

  get changed(): boolean {
    return this.tiles.length !== this.first;
  }

  add(t: Uint8ClampedArray): number {
    const k = keyOf(t);
    let id = this.ids.get(k);
    if (id === undefined) {
      id = this.tiles.length;
      this.ids.set(k, id);
      this.tiles.push(t.slice());
    }
    return id;
  }

  /** Consecutive tiles for an animation; returns the first. */
  addBlock(frames: Uint8ClampedArray[]): number {
    const k = frames.map(keyOf).join('');
    let id = this.blocks.get(k);
    if (id === undefined) {
      id = this.tiles.length;
      this.blocks.set(k, id);
      for (const f of frames) this.tiles.push(f.slice());
    }
    return id;
  }

  bitmap(): Bitmap {
    const s = this.size;
    const rows = Math.ceil(this.tiles.length / this.across);
    const out: Bitmap = { width: this.across * s, height: rows * s, data: new Uint8ClampedArray(this.across * s * rows * s * 4) };
    this.tiles.forEach((t, i) => {
      const ox = (i % this.across) * s;
      const oy = Math.floor(i / this.across) * s;
      for (let y = 0; y < s; y++) out.data.set(t.subarray(y * s * 4, (y + 1) * s * 4), ((oy + y) * out.width + ox) * 4);
    });
    return out;
  }
}

type Tile = Uint8ClampedArray;

const blank = (T: number): Tile => new Uint8ClampedArray(T * T * 4);

/** A tile cut out of a texture, which wraps. */
function cut(art: Bitmap, sx: number, sy: number, T: number): Tile {
  const out = blank(T);
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const px = (((sx + x) % art.width) + art.width) % art.width;
      const py = (((sy + y) % art.height) + art.height) % art.height;
      const s = (py * art.width + px) * 4;
      out.set(art.data.subarray(s, s + 4), (y * T + x) * 4);
    }
  }
  return out;
}

const fill = (t: Tile, T: number, x0: number, y0: number, x1: number, y1: number, c: readonly [number, number, number]) => {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * T + x) * 4;
      t[i] = c[0];
      t[i + 1] = c[1];
      t[i + 2] = c[2];
      t[i + 3] = 255;
    }
  }
};

const darken = (t: Tile, T: number, x0: number, y0: number, x1: number, y1: number, k: number) => {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * T + x) * 4;
      t[i] = t[i]! * k;
      t[i + 1] = t[i + 1]! * k;
      t[i + 2] = t[i + 2]! * k;
    }
  }
};

function noiseField(rand: () => number, cols: number, rows: number, step = 4): number[][] {
  const cache = new Map<string, number>();
  const corner = (ix: number, iy: number) => {
    const k = `${ix},${iy}`;
    if (!cache.has(k)) cache.set(k, rand());
    return cache.get(k)!;
  };
  const at = (x: number, y: number) => {
    const fx = x / step;
    const fy = y / step;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    let tx = fx - ix;
    let ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    return (corner(ix, iy) * (1 - tx) + corner(ix + 1, iy) * tx) * (1 - ty) + (corner(ix, iy + 1) * (1 - tx) + corner(ix + 1, iy + 1) * tx) * ty;
  };
  return Array.from({ length: rows + 1 }, (_, y) => Array.from({ length: cols + 1 }, (_, x) => at(x, y)));
}

interface StripOut {
  data: Bitmap;
  piers: number[];
}

/** A wall front `length` tiles long and `rows` high. Every jump in the panel sits under a pier. */
function wallStrip(length: number, rows: number, T: number, art: KitArt, kit: MapKit, rand: () => number): StripOut {
  const H = rows * T;
  const across = Math.floor(art.wall.width / T);
  const segments = kit.wall.segments ?? [Array.from({ length: across }, (_, i) => i)];
  const columns: number[] = [];
  const joins: number[] = [];
  while (columns.length < length) {
    const room = length - columns.length;
    const fit = segments.filter((s) => s.length <= room);
    const options = fit.length ? fit : [segments[segments.length - 1]!];
    const part = options[Math.floor(rand() * options.length)]!;
    if (columns.length && columns[columns.length - 1]! + 1 !== part[0]) joins.push(columns.length);
    columns.push(...part);
  }
  columns.length = length;
  const out: Bitmap = { width: length * T, height: H, data: new Uint8ClampedArray(length * T * H * 4) };
  columns.forEach((col, i) => {
    for (let y = 0; y < H; y++) out.data.set(art.wall.data.subarray((y * art.wall.width + col * T) * 4, (y * art.wall.width + (col + 1) * T) * 4), (y * out.width + i * T) * 4);
  });
  const joinPx = joins.map((j) => j * T);
  const piers = !art.pier ? [] : length <= 2 ? [Math.floor((T * length) / 2)] : [...[20, length * T - 20].filter((e) => !joinPx.some((j) => Math.abs(j - e) < 72)), ...joinPx];
  if (art.pier) {
    const p = art.pier;
    for (const centre of piers) {
      const x0 = centre - Math.floor(p.width / 2);
      for (let y = 0; y < Math.min(H, p.height); y++) {
        for (let x = 0; x < p.width; x++) {
          const px = x0 + x;
          if (px < 0 || px >= length * T) continue;
          const s = (y * p.width + x) * 4;
          if (p.data[s + 3]) out.data.set(p.data.subarray(s, s + 4), ((H - p.height + y) * out.width + px) * 4);
        }
      }
    }
  }
  return { data: out, piers };
}

export interface BakedMap {
  ground: number[];
  walls: number[];
  juts: HdJut[];
  rules: TileRule[];
}

/** Composes every cell of the plan. */
export function bakePlan(plan: BpPlan, seed: string, kit: MapKit, art: KitArt, sheet: TileSheet): BakedMap {
  const { cols, rows, kinds, wallRows } = plan;
  const T = sheet.size;
  const rand = random(seed);
  const kindAt = (x: number, y: number) => (x >= 0 && y >= 0 && x < cols && y < rows ? kinds[y * cols + x]! : CELL.VOID);
  const floor = (x: number, y: number) => kindAt(x, y) === CELL.FLOOR;
  const watery = (x: number, y: number) => {
    const k = kindAt(x, y);
    return k === CELL.WATER || k === CELL.DRY || k === CELL.BASIN;
  };
  const closed = (x: number, y: number) => !isInterior(kindAt(x, y));

  const ground = new Array<number>(cols * rows).fill(-1);
  const walls = new Array<number>(cols * rows).fill(-1);
  const juts: HdJut[] = [];
  const rules: TileRule[] = [];
  const [kerbLight, kerbMid] = [hex(kit.roof.kerb[0]), hex(kit.roof.kerb[1])];
  const roofDark = hex(kit.roof.dark);
  const roofJoint = hex(kit.roof.joint);

  // Fronts.
  for (const run of plan.runs) {
    const strip = wallStrip(run.length, wallRows, T, art, kit, rand);
    for (let c = 0; c < run.length; c++) {
      for (let level = 0; level < wallRows; level++) {
        if (kindAt(run.x + c, run.foot - level) !== CELL.FRONT) break;
        const t = blank(T);
        const top = (wallRows - 1 - level) * T;
        for (let y = 0; y < T; y++) t.set(strip.data.data.subarray(((top + y) * strip.data.width + c * T) * 4, ((top + y) * strip.data.width + (c + 1) * T) * 4), y * T * 4);
        ground[(run.foot - level) * cols + run.x + c] = sheet.add(t);
      }
    }
    if (kit.pier) {
      const width = art.pier!.width;
      for (const centre of strip.piers) juts.push({ x: Math.max(0, run.x * T + centre - Math.floor(width / 2) + kit.pier.shaft[0]), w: kit.pier.shaft[1] - kit.pier.shaft[0], foot: run.foot, depth: kit.pier.depth });
    }
  }

  // Moss gathers by walls and water.
  const field = noiseField(rand, cols, rows);
  const nearEdge = (x: number, y: number) => [[-1, -1], [0, -1], [-1, 0], [0, 0]].some(([dx, dy]) => !floor(x + dx!, y + dy!));
  const corner = field.map((row, y) => row.map((v, x) => v + (nearEdge(x, y) ? 0.2 : 0) > 0.84));
  const mossGreen = (d: Uint8ClampedArray, i: number) => d[i + 1]! > d[i]! * 1.02 && d[i + 1]! > d[i + 2]! * 1.05 && d[i + 3]! > 0;

  const floorCell = (x: number, y: number): Tile => {
    const t = cut(art.floor, x * T, y * T, T);
    if (art.moss) {
      const bits = 8 * +corner[y]![x]! + 4 * +corner[y]![x + 1]! + 2 * +corner[y + 1]![x]! + +corner[y + 1]![x + 1]!;
      if (bits) {
        const m = cut(art.moss, (bits % 4) * T, Math.floor(bits / 4) * T, T);
        for (let i = 0; i < m.length; i += 4) if (mossGreen(m, i)) t.set(m.subarray(i, i + 4), i);
      }
    }
    if (closed(x, y - 1)) {
      const steps: [number, number, number][] = [[0, 7, 0.66], [7, 13, 0.78], [13, 20, 0.9]];
      for (const [a, b, k] of steps) darken(t, T, 0, Math.round((a * T) / 32), T, Math.round((b * T) / 32), k);
    }
    if (closed(x - 1, y)) darken(t, T, 0, 0, Math.round((6 * T) / 32), T, 0.78);
    if (closed(x + 1, y)) darken(t, T, T - Math.round((6 * T) / 32), 0, T, T, 0.78);
    return t;
  };

  const roofCell = (x: number, y: number): Tile => {
    const t = cut(art.roof, x * T, y * T, T);
    if (floor(x, y - 1) || watery(x, y - 1)) {
      fill(t, T, 0, 0, T, 4, kerbMid);
      fill(t, T, 0, 0, T, 1, kerbLight);
      fill(t, T, 0, 4, T, 5, roofDark);
      for (let jx = 0; jx < T; jx += 16) {
        const c = (jx + ((x * 7) % 16)) % T;
        fill(t, T, c, 0, c + 1, 4, roofJoint);
      }
    }
    const sides: [boolean, number, number][] = [[floor(x - 1, y) || watery(x - 1, y), 0, 4], [floor(x + 1, y) || watery(x + 1, y), T - 4, T - 5]];
    for (const [side, col, inner] of sides) {
      if (!side) continue;
      fill(t, T, col, 0, col + 4, T, kerbMid);
      const edge = col === 0 ? 0 : T - 1;
      fill(t, T, edge, 0, edge + 1, T, kerbLight);
      fill(t, T, inner, 0, inner + 1, T, roofDark);
      for (let jy = 0; jy < T; jy += 16) {
        const r = (jy + ((y * 5) % 16)) % T;
        fill(t, T, col, r, col + 4, r + 1, roofJoint);
      }
    }
    return t;
  };

  /** Banks and the far wall of a channel, over any picture of what's in it. */
  const channel = (base: Tile, x: number, y: number): Tile => {
    const t = base.slice();
    const [deep, lit] = kit.water ? [hex(kit.water.ramp[0]), hex(kit.water.ramp[1])] : [roofDark, roofJoint];
    if (!watery(x, y - 1)) {
      const band = cut(art.wall, (x * 37) % art.wall.width, 30 + ((x * 11) % 40), T);
      for (let py = 0; py < 12; py++) {
        for (let px = 0; px < T; px++) {
          const i = (py * T + px) * 4;
          t[i] = band[i]! * 0.42;
          t[i + 1] = band[i + 1]! * 0.42;
          t[i + 2] = band[i + 2]! * 0.42;
          t[i + 3] = 255;
        }
      }
      fill(t, T, 0, 12, T, 13, deep);
      fill(t, T, 0, 13, T, 14, lit);
    }
    if (!watery(x, y + 1)) {
      fill(t, T, 0, T - 6, T, T, kerbMid);
      fill(t, T, 0, T - 6, T, T - 5, kerbLight);
      fill(t, T, 0, T - 7, T, T - 6, deep);
      fill(t, T, 0, T - 1, T, T, roofJoint);
    }
    const banks: [boolean, number, number][] = [[!watery(x - 1, y), 0, 5], [!watery(x + 1, y), T - 5, T - 6]];
    for (const [side, col, inner] of banks) {
      if (!side) continue;
      fill(t, T, col, 0, col + 5, T, kerbMid);
      const edge = col === 0 ? 0 : T - 1;
      fill(t, T, edge, 0, edge + 1, T, kerbLight);
      fill(t, T, inner, 0, inner + 1, T, deep);
    }
    return t;
  };

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const k = kinds[i]!;
      if (k === CELL.VOID) continue;
      if (k === CELL.FRONT || k === CELL.TOP || k === CELL.SIDE || k === CELL.KERB) walls[i] = kit.solidTile;
      if (k === CELL.WATER || k === CELL.DRY) walls[i] = kit.waterTile;
      if (ground[i]! >= 0) continue;
      if (k === CELL.FLOOR) ground[i] = sheet.add(floorCell(x, y));
      else if (k === CELL.DRY || k === CELL.BASIN) ground[i] = sheet.add(channel(art.dry ? cut(art.dry, 0, 0, T) : cut(art.floor, x * T, y * T, T), x, y));
      else if (k === CELL.WATER && art.water && kit.water) {
        const frames = Array.from({ length: kit.water.frames }, (_, f) => channel(cut(art.water!, f * T, 0, T), x, y));
        const painted = sheet.add(frames[0]!);
        const rule = rules.find((r) => r.tile === painted);
        if (!rule) rules.push({ tile: painted, kind: 'grid', first: sheet.addBlock(frames), frames: frames.length, fps: kit.water.fps });
        ground[i] = painted;
      } else if (k !== CELL.FRONT) ground[i] = sheet.add(roofCell(x, y));
    }
  }
  return { ground, walls, juts, rules };
}
