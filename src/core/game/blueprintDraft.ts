/** A first blueprint for a map that was made without one: what is there, ready to be given a meaning. Pure and browser-safe. */

import { type Blueprint, type BpContext, type BpElement, type BpFlow, type BpMount, type BpRect, type BpSpace, type BpWater, CELL, elementAt, isWallKind, planBlueprint } from './blueprint.js';
import type { MapKit } from './blueprintBake.js';
import type { Instance, ObjectType, Scene } from './types.js';

/** Covers a set of cells with few rectangles, largest first. */
export function coverWithRects(cols: number, rows: number, has: (x: number, y: number) => boolean): BpRect[] {
  const left = new Uint8Array(cols * rows);
  let count = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (has(x, y)) { left[y * cols + x] = 1; count++; }
  const out: BpRect[] = [];
  while (count > 0) {
    let best: BpRect = [0, 0, 0, 0];
    let bestArea = 0;
    const heights = new Int32Array(cols);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) heights[x] = left[y * cols + x] ? heights[x]! + 1 : 0;
      for (let x = 0; x < cols; x++) {
        let h = heights[x]!;
        for (let x2 = x; x2 < cols && h > 0; x2++) {
          h = Math.min(h, heights[x2]!);
          const area = (x2 - x + 1) * h;
          if (area > bestArea) {
            bestArea = area;
            best = [x, y - h + 1, x2 - x + 1, h];
          }
        }
      }
    }
    if (!bestArea) break;
    out.push(best);
    for (let y = best[1]; y < best[1] + best[3]; y++) {
      for (let x = best[0]; x < best[0] + best[2]; x++) {
        left[y * cols + x] = 0;
        count--;
      }
    }
  }
  return out;
}

const NO_SPRITE_MOUNT: BpMount = 'marker';

/** Reads a finished scene into a blueprint. Concept and purposes are left blank on purpose: only a person can say what a room is for. */
export function draftBlueprint(s: Scene, kitName: string, kit: MapKit, ctx: BpContext, types: Map<string, ObjectType>, animatedTile: (t: number) => boolean): Blueprint {
  const solid = s.layers.find((l) => l.solid)?.tiles ?? new Array(s.cols * s.rows).fill(-1);
  const ground = s.layers.find((l) => !l.solid)?.tiles ?? new Array(s.cols * s.rows).fill(-1);
  const at = (x: number, y: number) => y * s.cols + x;
  const interior = (x: number, y: number) => solid[at(x, y)]! < 0 || solid[at(x, y)] === kit.waterTile;
  const flowInst = s.instances.filter((i) => kit.flowSprite && i.sprite === kit.flowSprite);
  const covered = new Set(flowInst.map((i) => `${Math.floor(i.x / s.tileSize)},${Math.floor(i.y / s.tileSize)}`));

  const rects = coverWithRects(s.cols, s.rows, interior);
  const spaces: BpSpace[] = rects.map((r, n) => ({ id: `s${n + 1}`, kind: Math.min(r[2], r[3]) <= 4 ? 'corridor' : 'hall', purpose: '', rects: [r] }));

  const water: BpWater[] = [];
  const area = (id: string, kind: BpWater['kind'], has: (x: number, y: number) => boolean) => {
    const parts = coverWithRects(s.cols, s.rows, has);
    if (parts.length) water.push({ id, kind, rects: parts });
  };
  area('canali', 'canal', (x, y) => solid[at(x, y)] === kit.waterTile && animatedTile(ground[at(x, y)]!));
  area('secco', 'dry', (x, y) => solid[at(x, y)] === kit.waterTile && !animatedTile(ground[at(x, y)]!));
  area('vasche', 'basin', (x, y) => solid[at(x, y)]! < 0 && covered.has(`${x},${y}`));

  const links: Blueprint['links'] = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const edge = a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3] && !((a[0] === b[0] + b[2] || b[0] === a[0] + a[2]) && (a[1] === b[1] + b[3] || b[1] === a[1] + a[3]));
      if (edge) links.push({ a: spaces[i]!.id, b: spaces[j]!.id, via: 'open' });
    }
  }

  const bp: Blueprint = { concept: '', kit: kitName, size: [s.cols, s.rows], spaces, links, water, elements: [], checks: [] };
  const plan = planBlueprint(bp);

  // Moving water by group, when the banks it has are the ones its cells would be given.
  const taken = new Set<string>();
  const groups = new Map<string, Instance[]>();
  for (const i of flowInst) {
    const key = `${i.activeIf ?? ''}|${i.animation?.[0] ?? 'm'}|${i.name ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  let flowN = 0;
  for (const list of groups.values()) {
    const cells = new Set(list.map((i) => `${Math.floor(i.x / s.tileSize)},${Math.floor(i.y / s.tileSize)}`));
    const fits = list.every((i) => {
      const x = Math.floor(i.x / s.tileSize);
      const y = Math.floor(i.y / s.tileSize);
      const open = (dx: number, dy: number) => !cells.has(`${x + dx},${y + dy}`);
      return i.animation === `${i.animation?.[0]}${(open(0, -1) ? 1 : 0) + (open(1, 0) ? 2 : 0) + (open(0, 1) ? 4 : 0) + (open(-1, 0) ? 8 : 0)}`;
    });
    if (!fits || !list[0]!.activeIf) continue;
    const flow: BpFlow = { when: list[0]!.activeIf, look: list[0]!.animation?.[0] ?? 'm', ...(list[0]!.name ? { name: list[0]!.name } : {}) };
    const parts = coverWithRects(s.cols, s.rows, (x, y) => cells.has(`${x},${y}`));
    // Its own area, drawn over whichever kind of channel is under it.
    const kindOf = (r: BpRect) => bp.water.find((w) => w.rects.some((q) => r[0] >= q[0] && r[1] >= q[1] && r[0] + r[2] <= q[0] + q[2] && r[1] + r[3] <= q[1] + q[3]));
    flowN++;
    water.push({ id: `flusso${flowN}`, kind: kindOf(parts[0]!)?.kind ?? 'dry', rects: parts, flows: [flow] });
    for (const i of list) taken.add(i.id);
  }

  const spaceOf = (x: number, y: number): number => {
    const i = plan.spaces[at(Math.max(0, Math.min(s.cols - 1, x)), Math.max(0, Math.min(s.rows - 1, y)))]!;
    if (i >= 0) return i;
    let best = 0;
    let dist = Infinity;
    rects.forEach((r, n) => {
      const dx = Math.max(r[0] - x, 0, x - (r[0] + r[2] - 1));
      const dy = Math.max(r[1] - y, 0, y - (r[1] + r[3] - 1));
      if (dx + dy < dist) {
        dist = dx + dy;
        best = n;
      }
    });
    return best;
  };

  for (const i of s.instances) {
    if (taken.has(i.id)) continue;
    const size = ctx.sizeOf(i);
    const o = types.get(i.object);
    const fx = Math.floor((i.x + (size?.w ?? 0) / 2) / s.tileSize);
    const fy = Math.floor((i.y + (size?.h ?? 0) - 1) / s.tileSize);
    const k = fx >= 0 && fy >= 0 && fx < s.cols && fy < s.rows ? plan.kinds[at(fx, fy)]! : CELL.VOID;
    let mount: BpMount;
    if (!size || /^blk_/.test(i.object)) mount = NO_SPRITE_MOUNT;
    else if (isWallKind(k)) mount = 'wall';
    else if (o?.hdPose === 'flat' || (o?.z ?? 0) < 0 || (kit.flowSprite && i.sprite === kit.flowSprite)) mount = 'flat';
    else if (k === CELL.WATER || k === CELL.DRY) mount = 'pit';
    else mount = 'floor';
    const { x: _x, y: _y, ...rest } = i;
    const space = spaces[spaceOf(fx, fy)]!;
    const element: BpElement = { ...rest, in: space.id, mount, at: elementAt(bp, space.id, mount, i, ctx) };
    bp.elements.push(element);
  }
  return bp;
}
