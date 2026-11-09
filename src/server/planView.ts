/** A drawing of a map's plan: rooms, walls, water and what stands where, with names. What the map is, without the art. */

import { type Blueprint, type BpPlan, type BpProblem, CELL, originOf, planBlueprint } from '../core/game/blueprint.js';
import { planPainted, surfaceOf } from '../core/game/blueprintOpenAir.js';
import { TileResolver, type TilesetRules } from '../core/game/tilerules.js';
import type { Scene } from '../core/game/types.js';
import type { Bitmap } from '../core/sprite.js';
import { BitmapRenderer, encodeBitmap } from './game.js';

const COLORS: Record<number, string> = {
  [CELL.VOID]: '#07080d', [CELL.FLOOR]: '#6d7486', [CELL.FRONT]: '#b08a58', [CELL.TOP]: '#5c4a35', [CELL.SIDE]: '#4a4034', [CELL.KERB]: '#39414f', [CELL.WATER]: '#2d6fb0', [CELL.DRY]: '#7a6a4d', [CELL.BASIN]: '#4e8d9c', [CELL.THICKET]: '#27402f',
};
const MOUNT: Record<string, string> = { floor: '#ffd166', wall: '#ff8c42', flat: '#7ae582', pit: '#6ec6ff', marker: '#d0a2f7' };

function planOfScene(s: Scene): BpPlan {
  const kinds = new Uint8Array(s.cols * s.rows);
  const solid = s.layers.find((l) => l.solid)?.tiles;
  for (let i = 0; i < kinds.length; i++) kinds[i] = solid && solid[i]! >= 0 ? (solid[i] === 3 ? CELL.WATER : CELL.TOP) : CELL.FLOOR;
  return { cols: s.cols, rows: s.rows, wallRows: 3, kinds, spaces: new Int16Array(kinds.length).fill(-1), runs: [], problems: [] };
}

export function renderPlan(s: Scene, sheets: Map<string, Bitmap>, blueprint: Blueprint | undefined, problems: BpProblem[] | undefined, px = 18, rules?: TilesetRules): Buffer {
  const bp = blueprint ?? s.blueprint;
  const plan = !bp ? planOfScene(s) : bp.terrain === 'painted' ? planPainted(bp, surfaceOf(s, new TileResolver(rules))) : planBlueprint(bp);
  const head = 14;
  const r = new BitmapRenderer(plan.cols * px, plan.rows * px + head, sheets);
  r.clear('#101218');
  r.text(bp ? `${s.name}: ${bp.concept}`.slice(0, Math.floor((plan.cols * px) / 5)) : `${s.name} (no blueprint)`, 2, 3, '#ffffff', 1);
  for (let y = 0; y < plan.rows; y++) {
    for (let x = 0; x < plan.cols; x++) {
      r.rect(x * px, y * px + head, px, px, COLORS[plan.kinds[y * plan.cols + x]!] ?? '#ff00ff');
      r.rect(x * px, y * px + head, 1, px, '#000000', 0.2);
      r.rect(x * px, y * px + head, px, 1, '#000000', 0.2);
    }
  }
  for (let x = 0; x < plan.cols; x += 5) r.text(String(x), x * px + 1, head + 1, '#ffffff', 1);
  for (let y = 5; y < plan.rows; y += 5) r.text(String(y), 1, y * px + head + 1, '#ffffff', 1);
  if (bp) {
    for (const e of bp.elements) {
      const o = originOf(bp, e.in);
      if (!o) continue;
      const x = (o[0] + e.at[0]) * px;
      const y = (o[1] + e.at[1]) * px + head;
      r.rect(Math.round(x) - 2, Math.round(y) - 2, 4, 4, MOUNT[e.mount] ?? '#ffffff');
    }
    for (const sp of bp.spaces) {
      const q = sp.rects[0];
      if (!q) continue;
      r.text(sp.id, q[0] * px + 3, q[1] * px + head + 3, '#ffffff', 1);
    }
  }
  for (const p of problems ?? plan.problems) {
    if (!p.cell) continue;
    const color = p.level === 'error' ? '#ff3b30' : '#ffd60a';
    const x = p.cell[0] * px;
    const y = p.cell[1] * px + head;
    r.rect(x, y, px, 2, color);
    r.rect(x, y + px - 2, px, 2, color);
    r.rect(x, y, 2, px, color);
    r.rect(x + px - 2, y, 2, px, color);
  }
  return encodeBitmap(r.out);
}
