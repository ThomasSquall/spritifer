/**
 * Architectural checks on any map, compiled from a blueprint or not: walls that can't stand, blocks of masonry in the middle
 * of nowhere, big sprites thrown across the only way through. Pure and browser-safe.
 */

import { fineBlockedTiles } from './fineSolid.js';
import type { Problem } from './catalog.js';
import { planBlueprint } from './blueprint.js';
import { lintOpenAir, planPainted, surfaceOf } from './blueprintOpenAir.js';
import { type WallCell, findWalls } from './hd3d.js';
import type { SizeOf } from './sceneOps.js';
import type { TileResolver } from './tilerules.js';
import { type ObjectType, type Scene, hitboxOf } from './types.js';

export interface LintContext {
  types: Map<string, ObjectType>;
  sizeOf: SizeOf;
  resolver: (tileset: string) => TileResolver;
}

export interface MapIssue extends Problem {
  cell?: [number, number];
  code: string;
}

const WALL_ROWS = 3;

/** Problems of one scene. Those of a scene with a blueprint come from it, and are errors. */
export function lintScene(s: Scene, ctx: LintContext): MapIssue[] {
  const out: MapIssue[] = [];
  const add = (code: string, message: string, cell?: [number, number]) => out.push({ where: `scene ${s.name}${cell ? ` (${cell[0]}, ${cell[1]})` : ''}`, code, message, ...(cell ? { cell } : {}) });
  if (s.blueprint?.terrain === 'painted') {
    const surface = surfaceOf(s, ctx.resolver(s.tileset ?? ''));
    for (const p of planPainted(s.blueprint, surface).problems) add(p.code, p.message, p.cell);
    lintOpenAir(s, surface, ctx, add);
    return out;
  }
  if (s.blueprint) {
    for (const p of planBlueprint(s.blueprint, WALL_ROWS).problems) add(p.code, p.message, p.cell);
    return out;
  }
  const solidLayers = s.layers.filter((l) => l.solid);
  // Fine collision counts where a tile is more than half covered (see fineSolid.ts), also on a map with no solid layer.
  const fineTiles = fineBlockedTiles(s);
  if (!solidLayers.length && !fineTiles) return out;
  if (fineTiles) solidLayers.push({ name: '(fine)', solid: true, visible: false, tiles: Array.from(fineTiles, (v) => (v ? 0 : -1)) });
  const cells: (WallCell | null)[] = findWalls(s.layers, s.cols, s.rows, ctx.resolver(s.tileset ?? ''), WALL_ROWS, s.hdCells, undefined, undefined, s.tileSize);
  const isWall = (x: number, y: number) => x >= 0 && y >= 0 && x < s.cols && y < s.rows && !!cells[y * s.cols + x];
  if (!cells.some(Boolean)) {
    lintDecor(s, ctx, add, (x, y) => x < 0 || y < 0 || x >= s.cols || y >= s.rows || solidLayers.some((l) => l.tiles[y * s.cols + x]! >= 0), false);
    return out;
  }
  const solid = (x: number, y: number) => x < 0 || y < 0 || x >= s.cols || y >= s.rows || solidLayers.some((l) => l.tiles[y * s.cols + x]! >= 0);

  // A front needs its height: anything less is a wall drawn on nothing.
  const thin = new Map<number, [number, number, number]>();
  for (let x = 0; x < s.cols; x++) {
    for (let y = 1; y < s.rows - 1; y++) {
      if (!isWall(x, y) || solid(x, y + 1)) continue;
      let n = 0;
      while (isWall(x, y - n)) n++;
      if (n < WALL_ROWS && y - n >= 0) thin.set(y, thin.get(y) ? [Math.min(thin.get(y)![0], x), y, n] : [x, y, n]);
    }
  }
  for (const [, [x, y, n]] of thin) add('thin-wall', `wall only ${n} tile(s) deep between two floors: its front needs ${WALL_ROWS}`, [x, y]);

  // A wall mass that touches neither the edge of the map nor anything else stands in the middle of the floor like a building.
  const seen = new Uint8Array(s.cols * s.rows);
  for (let y = 0; y < s.rows; y++) {
    for (let x = 0; x < s.cols; x++) {
      if (!isWall(x, y) || seen[y * s.cols + x]) continue;
      const todo: [number, number][] = [[x, y]];
      seen[y * s.cols + x] = 1;
      let edge = false;
      let x0 = x, y0 = y, x1 = x, y1 = y;
      while (todo.length) {
        const [a, b] = todo.pop()!;
        if (a === 0 || b === 0 || a === s.cols - 1 || b === s.rows - 1) edge = true;
        x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, a); y1 = Math.max(y1, b);
        for (const [nx, ny] of [[a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]] as const) {
          if (isWall(nx, ny) && !seen[ny * s.cols + nx]) {
            seen[ny * s.cols + nx] = 1;
            todo.push([nx, ny]);
          }
        }
      }
      if (!edge) add('free-block', `block of wall ${x1 - x0 + 1}x${y1 - y0 + 1} standing alone in the floor: is it a building, or just what was left between rooms?`, [x0, y0]);
    }
  }

  // Wall strips one or two tiles wide become black towers once they are raised.
  for (let y = 0; y < s.rows; y++) {
    let x = 0;
    while (x < s.cols) {
      if (!isWall(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (isWall(x, y)) x++;
      if (x - start <= 2 && start > 0 && x < s.cols && !solid(start - 1, y) && !solid(x, y) && !out.some((p) => p.code === 'slab' && p.cell?.[0] === start)) add('slab', `wall only ${x - start} tile(s) wide with floor on both sides`, [start, y]);
    }
  }
  lintDecor(s, ctx, add, solid, true);
  return out;
}

function lintDecor(s: Scene, ctx: LintContext, add: (code: string, message: string, cell?: [number, number]) => void, solid: (x: number, y: number) => boolean, built: boolean): void {
  const T = s.tileSize;
  const shown = s.instances.flatMap((i) => {
    const o = ctx.types.get(i.object);
    if (!o || o.hud || o.sway || !(i.sprite ?? o.sprite)) return [];
    const size = ctx.sizeOf(i);
    return size.w >= 48 && size.h >= 48 ? [{ i, x: i.x, y: i.y, w: size.w, h: size.h }] : [];
  });
  // Out of doors, canopies overlapping is what a wood looks like.
  for (let a = 0; built && a < shown.length; a++) {
    for (let b = a + 1; b < shown.length; b++) {
      const A = shown[a]!;
      const B = shown[b]!;
      if (A.i.activeIf && B.i.activeIf && A.i.activeIf !== B.i.activeIf) continue;
      if (A.i.sprite !== B.i.sprite) continue;
      const w = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const h = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (w > 0 && h > 0 && w * h > 0.3 * Math.min(A.w * A.h, B.w * B.h)) add('overlap', `${A.i.name ?? A.i.object} and ${B.i.name ?? B.i.object} are drawn on top of each other`, [Math.floor(A.x / T), Math.floor(A.y / T)]);
    }
  }
  // A big picture over the only way through: the player walks across it as if it weren't there.
  for (const { i, x, y, w, h } of shown) {
    const o = ctx.types.get(i.object)!;
    if (o.behaviors.some((b) => b.type === 'solid') || hitboxOf(i, o)) continue;
    const footY = Math.floor((y + h - 1) / T);
    for (let cx = Math.floor((x + 8) / T); cx <= Math.floor((x + w - 9) / T); cx++) {
      if (footY < 0 || footY >= s.rows || cx < 0 || cx >= s.cols || solid(cx, footY)) continue;
      if (solid(cx - 1, footY) && solid(cx + 1, footY)) {
        add('covers-path', `${i.name ?? i.object} (${w}x${h}) is drawn across a passage one tile wide`, [cx, footY]);
        break;
      }
    }
  }
}
