/**
 * Water that mirrors what stands by it. Water is found from the art itself: the tiles that change as they animate, and
 * within them only the pixels that change, so a bank painted on the same tile stays dry.
 */

import type { AtmosphereActor } from './atmosphere.js';
import type { Renderer } from './engine.js';
import type { TileResolver } from './tilerules.js';
import type { SceneReflections, TileLayer } from './types.js';
import { groupRows, swayBase, swayShift } from './wind.js';

/** Three seconds in small steps: every frame of any animated rule, at any usual speed. */
const SAMPLES = Array.from({ length: 24 }, (_, i) => i * 0.125);

export interface WaterMap {
  cols: number;
  rows: number;
  /** One byte per cell: 1 = some water. */
  grid: Uint8Array;
  /** Cells of animated tiles, with every tile each one goes through. */
  cells: { tx: number; ty: number; tiles: number[] }[];
  /** How high in the drawing order the highest water is. */
  z?: number;
}

/** Where reflections are drawn: right on the water, so whatever lies across it (a bridge is a decal) covers them. Never above the shadows. */
export function reflectionZ(map: WaterMap): number {
  return Math.min(-1.8, (map.z ?? -1.8) + 0.001);
}

/** One patch of water on the screen. `sources` are x, y pairs in the sheet: with several, the pixels that differ are water; with one, its solid pixels. */
export interface WaterPiece {
  sprite: string;
  sources: number[];
  sw: number;
  sh: number;
  x: number;
  y: number;
}

/** A strip of a sprite drawn upside down. */
export interface ReflectionBand {
  sprite: string;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  flipX: boolean;
  alpha: number;
}

/** Finds the water of a scene. A cell under another tile layer (a treetop, a wall) doesn't count. */
export function findWater(layers: readonly TileLayer[], cols: number, rows: number, resolver: TileResolver): WaterMap {
  const grid = new Uint8Array(cols * rows);
  const cells: WaterMap['cells'] = [];
  const list: number[] = [];
  let z: number | undefined;
  layers.forEach((layer, li) => {
    if (!layer.visible || layer.solid) return;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const i = ty * cols + tx;
        if (layer.tiles[i]! < 0 || layers.some((o, lj) => lj > li && o.visible && o.tiles[i]! >= 0)) continue;
        const first = resolver.resolve(layer, cols, rows, tx, ty, list, 0).join();
        // Most cells: the same at a few moments, and not looked at any further.
        if (SAMPLES.slice(1, 9).every((c) => resolver.resolve(layer, cols, rows, tx, ty, list, c).join() === first)) continue;
        const tiles = new Set<number>();
        for (const c of SAMPLES) for (const t of resolver.resolve(layer, cols, rows, tx, ty, list, c)) tiles.add(t);
        cells.push({ tx, ty, tiles: [...tiles] });
        grid[i] = 1;
        z = Math.max(z ?? -Infinity, layer.z ?? li - 10);
      }
    }
  });
  return { cols, rows, grid, cells, z };
}

/** Marks the cells covered by water drawn as instances (canals laid over a dry bed). */
export function addWaterActors(map: WaterMap, actors: readonly AtmosphereActor[], sprites: readonly string[], tileSize: number): void {
  if (!sprites.length) return;
  for (const a of actors) {
    if (a.destroyed || !a.asset?.name || !sprites.includes(a.asset.name)) continue;
    map.z = Math.max(map.z ?? -Infinity, a.z);
    const x0 = Math.max(0, Math.floor(a.x / tileSize));
    const y0 = Math.max(0, Math.floor(a.y / tileSize));
    const x1 = Math.min(map.cols - 1, Math.floor((a.x + a.asset.width - 1) / tileSize));
    const y1 = Math.min(map.rows - 1, Math.floor((a.y + a.asset.height - 1) / tileSize));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map.grid[y * map.cols + x] = 1;
  }
}

function anyWater(map: WaterMap, ts: number, x: number, y: number, w: number, h: number): boolean {
  const x0 = Math.max(0, Math.floor(x / ts));
  const y0 = Math.max(0, Math.floor(y / ts));
  const x1 = Math.min(map.cols - 1, Math.floor((x + w) / ts));
  const y1 = Math.min(map.rows - 1, Math.floor((y + h) / ts));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (map.grid[cy * map.cols + cx]) return true;
  return false;
}

/** The strips that make up one actor's reflection; world-space y of the waterline is at the foot of the sprite. */
export function reflectionBands(a: AtmosphereActor, cfg: SceneReflections, map: WaterMap, ts: number, clock: number, camX: number, camY: number, zoom: number): ReflectionBand[] {
  const asset = a.asset;
  if (!asset?.name || !asset.frames?.length) return [];
  const f = asset.frames[a.frameIndex?.() ?? 0] ?? asset.frames[0]!;
  const offset = a.type.spriteOffset;
  const base = swayBase(a.type, f.h);
  if (base <= 0) return [];
  const left = a.x + (offset?.x ?? 0);
  const foot = a.y + (offset?.y ?? 0) + base;
  if (!anyWater(map, ts, left, foot, f.w, base)) return [];
  const wobble = cfg.wobble ?? 1;
  const opacity = (cfg.opacity ?? 0.32) * a.opacity;
  const wind = a.type.sway ? swayShift(a.type.sway, base, a.x, a.y, clock) : null;
  const seed = a.x * 0.03;
  const shift = (row: number) => Math.round((wind ? wind(row) : 0) + wobble * Math.sin((base - row) * 0.42 - clock * 2.4 + seed) * Math.min(1, 0.35 + (base - row) / 14));
  const out: ReflectionBand[] = [];
  for (const b of groupRows(0, base, shift)) {
    // Row r is drawn as far below the foot as it is above it.
    const top = foot + (base - b.row - b.rows);
    if (!anyWater(map, ts, left - 2, top, f.w + 4, b.rows)) continue;
    out.push({
      sprite: asset.name, sx: f.x, sy: f.y + b.row, sw: f.w, sh: b.rows,
      dx: Math.round((left - camX) * zoom) + b.offset * zoom, dy: Math.round((top - camY) * zoom),
      flipX: !!a.flipX, alpha: opacity * (1 - 0.65 * ((base - b.row) / base)),
    });
  }
  return out;
}

/** Everything standing near water, mirrored in it. */
export function drawReflections(r: Renderer, cfg: SceneReflections, map: WaterMap, actors: readonly AtmosphereActor[], tileset: { name: string; tile(t: number): [number, number]; w: number; h: number } | null, ts: number, clock: number, camX: number, camY: number, zoom: number, vw: number, vh: number): void {
  if (!r.reflections) return;
  const over = r.overscan ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const x0 = Math.floor((camX - over.left / zoom) / ts);
  const y0 = Math.floor((camY - over.top / zoom) / ts);
  const x1 = Math.ceil((camX + (vw + over.right) / zoom) / ts);
  const y1 = Math.ceil((camY + (vh + over.bottom) / zoom) / ts);
  const water: WaterPiece[] = [];
  if (tileset) {
    for (const c of map.cells) {
      if (c.tx < x0 || c.tx > x1 || c.ty < y0 || c.ty > y1) continue;
      const sources: number[] = [];
      for (const t of c.tiles) sources.push(...tileset.tile(t));
      water.push({ sprite: tileset.name, sources, sw: tileset.w, sh: tileset.h, x: Math.round((c.tx * ts - camX) * zoom), y: Math.round((c.ty * ts - camY) * zoom) });
    }
  }
  const overlays = cfg.sprites ?? [];
  const bands: ReflectionBand[] = [];
  for (const a of actors) {
    if (a.destroyed || !a.visible || !a.asset || a.type.hud || a.opacity <= 0) continue;
    if (a.asset.name && overlays.includes(a.asset.name)) {
      const f = a.asset.frames?.[a.frameIndex?.() ?? 0] ?? a.asset.frames?.[0];
      if (f && (a.x + f.w) >= camX - over.left / zoom && a.x <= camX + (vw + over.right) / zoom && (a.y + f.h) >= camY - over.top / zoom && a.y <= camY + (vh + over.bottom) / zoom) water.push({ sprite: a.asset.name, sources: [f.x, f.y], sw: f.w, sh: f.h, x: Math.round((a.x - camX) * zoom), y: Math.round((a.y - camY) * zoom) });
      continue;
    }
    // Decals and small flying things leave no image; neither does whatever is far off the screen.
    if (a.type.shadow === 0) continue;
    if (a.x + a.asset.width < camX - 8 - over.left / zoom || a.x > camX + (vw + over.right) / zoom + 8) continue;
    bands.push(...reflectionBands(a, cfg, map, ts, clock, camX, camY, zoom));
  }
  if (water.length && bands.length) r.reflections(water, bands, zoom);
}
