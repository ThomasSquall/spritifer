import { describe, expect, it } from 'vitest';
import { type Blueprint, type BpContext, CELL, blueprintInstances, checkElements, elementAt, elementPosition, normalizeBlueprint, planBlueprint, planHdCells, runChecks } from '../src/core/game/blueprint.js';
import { isScatter, lintOpenAir, planPainted } from '../src/core/game/blueprintOpenAir.js';
import { type MapKit, TileSheet, bakePlan } from '../src/core/game/blueprintBake.js';
import { coverWithRects } from '../src/core/game/blueprintDraft.js';
import { lintScene } from '../src/core/game/mapLint.js';
import { TileResolver } from '../src/core/game/tilerules.js';
import { type Instance, type ObjectType, createScene } from '../src/core/game/types.js';

const room = (id: string, rect: [number, number, number, number]) => ({ id, kind: 'hall' as const, purpose: 'test', rects: [rect] });
const base = (over: Partial<Blueprint> = {}): Blueprint => ({ concept: 'c', kit: 'k', size: [20, 20], spaces: [room('a', [2, 5, 6, 4])], links: [], water: [], elements: [], checks: [], ...over });
const ctx: BpContext = { tile: 32, waterSprite: 'w', sizeOf: (e) => (e.sprite ? { w: 32, h: 48 } : null) };
const codes = (bp: Blueprint) => planBlueprint(bp).problems.map((p) => p.code);

describe('planning a blueprint', () => {
  it('gives a room a front, a top, sides and a kerb', () => {
    const p = planBlueprint(base());
    const at = (x: number, y: number) => p.kinds[y * 20 + x];
    expect(at(3, 6)).toBe(CELL.FLOOR);
    expect([at(3, 4), at(3, 3), at(3, 2)]).toEqual([CELL.FRONT, CELL.FRONT, CELL.FRONT]);
    expect(at(3, 1)).toBe(CELL.TOP);
    expect(at(1, 6)).toBe(CELL.SIDE);
    expect(at(3, 9)).toBe(CELL.KERB);
    expect(at(15, 15)).toBe(CELL.VOID);
    expect(p.problems).toEqual([]);
    expect(p.runs).toEqual([{ x: 2, foot: 4, length: 6 }]);
  });

  it('keeps kerbs flat in the 2D-HD view', () => {
    const cells = planHdCells(planBlueprint(base()));
    expect(cells['3,9']).toBe(0);
    expect(cells['3,4']).toBeUndefined();
  });

  it('refuses a wall too thin to stand', () => {
    const bp = base({ spaces: [room('a', [2, 5, 6, 3]), room('b', [2, 9, 6, 3])], links: [] });
    expect(codes(bp)).toContain('thin-wall');
  });

  it('warns about a wall with floor right behind it', () => {
    const bp = base({ spaces: [room('a', [2, 4, 6, 3]), room('b', [2, 10, 6, 3])], links: [{ a: 'a', b: 'b', via: 'open' }] });
    expect(codes(bp)).toContain('link-across-gap');
    expect(planBlueprint(bp).problems.some((p) => p.code === 'wall-no-top' && p.level === 'warning')).toBe(true);
  });

  it('wants a concept, purposes and declared passages', () => {
    expect(codes(base({ concept: ' ' }))).toContain('no-concept');
    expect(codes(base({ spaces: [{ ...room('a', [2, 5, 6, 4]), purpose: '' }] }))).toContain('no-purpose');
    const touching = base({ spaces: [room('a', [2, 5, 6, 4]), room('b', [8, 5, 3, 2])] });
    expect(codes(touching)).toContain('undeclared-opening');
    expect(codes(touching)).toContain('cut-off');
    expect(codes({ ...touching, links: [{ a: 'a', b: 'b', via: 'arch' }] })).toEqual([]);
  });

  it('wants water inside a room', () => {
    expect(codes(base({ water: [{ id: 'w', kind: 'canal', rects: [[10, 10, 2, 2]] }] }))).toContain('water-outside');
  });
});

describe('elements', () => {
  const el = (over: object) => ({ id: 'e', object: 'o', sprite: 's', in: 'a', at: [1, 1] as [number, number], mount: 'floor' as const, ...over });

  it('are placed by their feet and moved with their room', () => {
    const bp = base({ elements: [el({ at: [2, 3] })] });
    expect(elementPosition(bp, bp.elements[0]!, ctx)).toEqual({ x: (2 + 2) * 32 - 16, y: (5 + 3) * 32 - 48 });
    expect(elementAt(bp, 'a', 'floor', { object: 'o', sprite: 's', x: 112, y: 208 }, ctx)).toEqual([2, 3]);
    bp.spaces[0]!.rects[0] = [4, 6, 6, 4];
    expect(blueprintInstances(bp, ctx)[0]).toMatchObject({ x: (4 + 2) * 32 - 16, y: (6 + 3) * 32 - 48 });
  });

  it('must suit where they are', () => {
    const check = (over: object, water: Blueprint['water'] = []) => {
      const bp = base({ water, elements: [el(over)] });
      return checkElements(bp, planBlueprint(bp), ctx).map((p) => p.code);
    };
    const canal: Blueprint['water'] = [{ id: 'w', kind: 'canal', rects: [[2, 5, 6, 2]] }];
    expect(check({})).toEqual([]);
    expect(check({ at: [1, 1] }, canal)).toEqual(['standing-in-water']);
    expect(check({ at: [1, 1], mount: 'pit' }, canal)).toEqual([]);
    expect(check({ mount: 'wall', at: [1, 3] })).toEqual(['not-on-wall']);
    expect(check({ mount: 'wall', at: [1, 0] })).toEqual([]);
    expect(check({ at: [-6, -2] })).toEqual(['not-on-floor']);
  });

  it('warn when big ones are drawn over each other, unless they are alternatives', () => {
    const size = { ...ctx, sizeOf: () => ({ w: 64, h: 64 }) };
    const pair = (a: object, b: object) => {
      const bp = base({ elements: [el({ id: 'a', ...a }), el({ id: 'b', ...b })] });
      return checkElements(bp, planBlueprint(bp), size).map((p) => p.code);
    };
    expect(pair({}, {})).toEqual(['overlap']);
    expect(pair({ activeIf: 'x' }, { activeIf: '!x' })).toEqual([]);
  });

  it('turn lying flat and standing into instances', () => {
    const bp = base({ elements: [el({ mount: 'flat' }), el({ id: 'f', mount: 'floor' })] });
    const list = blueprintInstances(bp, ctx);
    expect(list[0]).toMatchObject({ hdPose: 'flat', order: -5 });
    expect(list[1]).toMatchObject({ hdPose: 'stand' });
  });

  it('make moving water with the banks of its area', () => {
    const bp = base({ water: [{ id: 'w', kind: 'dry', rects: [[3, 6, 2, 1]], flows: [{ when: 'f', look: 'm' }] }] });
    expect(blueprintInstances(bp, ctx).map((i) => i.animation)).toEqual(['m13', 'm7']);
  });
});

describe('route checks', () => {
  const evaluate = (e: string, v: Record<string, unknown>) => !v[e.replace('!', '')] === e.startsWith('!');
  const bp = base({
    spaces: [room('a', [2, 5, 6, 4]), room('b', [8, 6, 4, 2])],
    links: [{ a: 'a', b: 'b', via: 'gate' }],
    elements: [{ id: 'g', object: 'blk_1x2', in: 'b', at: [0, 0], mount: 'marker', activeIf: '!open' }],
  });

  it('see gates closed and open', () => {
    const run = (checks: Blueprint['checks']) => runChecks({ ...bp, checks }, planBlueprint(bp), ctx, evaluate).map((p) => p.code);
    expect(run([{ name: 'shut', from: 'a', block: [[10, 6]] }])).toEqual([]);
    expect(run([{ name: 'shut', from: 'a', reach: [[10, 6]] }])).toEqual(['route-broken']);
    expect(run([{ name: 'open', vars: { open: 1 }, from: 'a', reach: [['b', 2, 0]] }])).toEqual([]);
    expect(run([{ name: 'open', vars: { open: 1 }, from: 'a', block: [[10, 6]] }])).toEqual(['route-open']);
  });
});

describe('baking', () => {
  const solid = (w: number, h: number, c: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : c + (i % 7))) });
  const kit: MapKit = { tileset: 't', solidTile: 5, waterTile: 3, wall: { sprite: 'w' }, floor: { sprite: 'f' }, roof: { sprite: 'r', kerb: ['#888888', '#666666'], dark: '#111111', joint: '#222222' } };
  const art = { wall: solid(64, 96, 90), floor: solid(64, 64, 120), roof: solid(32, 32, 30) };

  it('is the same every time and only ever adds tiles', () => {
    const plan = planBlueprint(base());
    const sheet = new TileSheet(null, 32);
    const a = bakePlan(plan, 'x', kit, art, sheet);
    const count = sheet.count;
    const b = bakePlan(plan, 'x', kit, art, sheet);
    expect(b.ground).toEqual(a.ground);
    expect(sheet.count).toBe(count);
    const reread = new TileSheet(sheet.bitmap(), 32);
    expect(bakePlan(plan, 'x', kit, art, reread).ground).toEqual(a.ground);
    expect(reread.changed).toBe(false);
  });

  it('leaves the dark empty and marks what blocks', () => {
    const plan = planBlueprint(base());
    const { ground, walls } = bakePlan(plan, 'x', kit, art, new TileSheet(null, 32));
    expect(ground[15 * 20 + 15]).toBe(-1);
    expect(walls[15 * 20 + 15]).toBe(-1);
    expect(walls[4 * 20 + 3]).toBe(5);
    expect(walls[6 * 20 + 3]).toBe(-1);
  });
});

describe('drafting', () => {
  it('covers a shape with rectangles', () => {
    const rects = coverWithRects(6, 6, (x, y) => (x >= 1 && x <= 4 && y >= 1 && y <= 2) || (x === 2 && y >= 3 && y <= 4));
    expect(rects).toEqual([[1, 1, 4, 2], [2, 3, 1, 2]]);
  });
});

describe('painted terrain', () => {
  const G = 8;
  const surface = (rows: string[]) => ({ solid: Uint8Array.from(rows.join('').split('').map((c) => (c === '.' ? 0 : 1))), water: Uint8Array.from(rows.join('').split('').map((c) => (c === '~' ? 1 : 0))) });
  const ground = surface(['........', '........', '####~~##', '........']);
  const open = (over: Partial<Blueprint> = {}): Blueprint => ({ concept: 'c', terrain: 'painted', kit: '', size: [G, 4], spaces: [{ id: 'a', kind: 'clearing', purpose: 'p', rects: [[0, 0, 8, 2]] }, { id: 'b', kind: 'road', purpose: 'p', rects: [[0, 3, 8, 1]] }], links: [], water: [], elements: [], checks: [], ...over });

  it('tells thicket from water and zones from each other', () => {
    const p = planPainted(open(), ground);
    expect(p.kinds[2 * G]).toBe(CELL.THICKET);
    expect(p.kinds[2 * G + 4]).toBe(CELL.WATER);
    expect(p.spaces[0]).toBe(0);
    expect(p.spaces[3 * G]).toBe(1);
    expect(p.problems).toEqual([]);
  });

  it('wants links where the ground joins, and only there', () => {
    const split = open({ spaces: [{ id: 'a', kind: 'clearing', purpose: 'p', rects: [[0, 0, 4, 2]] }, { id: 'b', kind: 'clearing', purpose: 'p', rects: [[4, 0, 4, 2]] }, { id: 'c', kind: 'road', purpose: 'p', rects: [[0, 3, 8, 1]] }] });
    expect(planPainted(split, ground).problems.map((p) => p.code)).toEqual(['undeclared-opening']);
    expect(planPainted({ ...split, links: [{ a: 'a', b: 'b', via: 'open' }, { a: 'a', b: 'c', via: 'open' }] }, ground).problems.map((p) => p.code)).toEqual(['link-across-gap']);
  });

  it('wants every walkable cell in a zone, and every zone on ground', () => {
    const codes2 = (bp: Blueprint) => planPainted(bp, ground).problems.map((p) => p.code);
    expect(codes2(open({ spaces: [{ id: 'a', kind: 'clearing', purpose: 'p', rects: [[0, 0, 8, 2]] }] }))).toEqual(['unassigned-ground']);
    expect(codes2(open({ spaces: [...open().spaces, { id: 'w', kind: 'marsh', purpose: 'p', rects: [[4, 2, 2, 1]] }] }))).toEqual(['empty-zone']);
  });

  it('reads a blueprint with no kit as painted', () => {
    expect(normalizeBlueprint({ concept: 'c', kit: '', spaces: [] })?.terrain).toBe('painted');
    expect(normalizeBlueprint({ concept: 'c', kit: 'k', spaces: [] })?.terrain).toBeUndefined();
  });

  const types = new Map<string, ObjectType>([
    ['tree', { name: 'tree', sprite: 't', sway: { amount: 1 }, hitbox: { x: 0, y: 0, w: 32, h: 32 }, properties: {}, behaviors: [], events: [] }],
    ['chest', { name: 'chest', sprite: 'c', hitbox: { x: 0, y: 0, w: 32, h: 32 }, properties: {}, behaviors: [{ type: 'solid' }, { type: 'dialogue' }], events: [] }],
    ['exit', { name: 'exit', hitbox: { x: 0, y: 0, w: 32, h: 32 }, properties: {}, behaviors: [{ type: 'script', name: 'Warp' }], events: [] }],
  ]);

  it('leaves trees to the scene and names what matters', () => {
    expect(isScatter({ object: 'tree', name: '~albero', props: { tint: 1 } }, types)).toBe(true);
    expect(isScatter({ object: 'chest', name: 'Cassa' }, types)).toBe(false);
    expect(isScatter({ object: 'tree', name: '~albero', activeIf: 'x' }, types)).toBe(false);
  });

  const lintOf = (rows: string[], instances: Instance[], tiles?: (x: number, y: number) => number) => {
    const out: string[] = [];
    const s = createScene({ name: 's', cols: G, rows: rows.length, tileSize: 32 });
    s.instances = instances;
    s.layers = [{ name: 'ground', tiles: Array.from({ length: G * rows.length }, (_, i) => tiles?.(i % G, Math.floor(i / G)) ?? 1), solid: false, visible: true }];
    lintOpenAir(s, surface(rows), { types, sizeOf: () => ({ w: 32, h: 32 }) }, (code) => out.push(code));
    return out;
  };

  it('finds walls nothing shows, unless something stands on them or the ground changes', () => {
    const rows = ['........', '##......', '........', '........'];
    const start: Instance = { id: 'p', object: 'player', x: 96, y: 32 };
    expect(lintOf(rows, [start])).toEqual(['invisible-wall']);
    expect(lintOf(rows, [start], (x, y) => (y === 1 && x < 2 ? 9 : 1))).toEqual([]);
    expect(lintOf(rows, [start, { id: 'c', object: 'chest', x: 0, y: 32 }, { id: 'd', object: 'chest', x: 32, y: 32 }])).toEqual([]);
  });

  it('finds trunks that can be walked through, ground nothing leads to and exits nothing shows', () => {
    const open4 = ['........', '........', '........', '........', '........', '........'];
    expect(lintOf(open4, [{ id: 'p', object: 'player', x: 0, y: 0 }, { id: 't', object: 'tree', x: 96, y: 64 }])).toEqual(['walk-through']);
    const cut = ['....#...', '....#...', '....#...', '....#...'];
    expect(lintOf(cut, [{ id: 'p', object: 'player', x: 0, y: 0 }], (x) => (x === 4 ? 9 : 1))).toEqual(['sealed-ground']);
    const six = ['........', '........', '........', '........', '........', '........', '........'];
    expect(lintOf(six, [{ id: 'e', object: 'exit', x: 96, y: 96 }])).toEqual(['unmarked-exit']);
  });
});

describe('architecture of maps without a blueprint', () => {
  const lint = (paint: (solid: number[], ground: number[], cols: number) => void) => {
    const s = createScene({ name: 's', cols: 20, rows: 20, tileSize: 32 });
    s.layers = [{ name: 'ground', tiles: new Array(400).fill(1), solid: false, visible: true }, { name: 'walls', tiles: new Array(400).fill(-1), solid: true, visible: false }];
    const ground = s.layers[0]!.tiles;
    const solid = s.layers[1]!.tiles;
    paint(solid, ground, 20);
    return lintScene(s, { types: new Map(), sizeOf: () => ({ w: 32, h: 32 }), resolver: () => new TileResolver(undefined) }).map((p) => p.code);
  };
  const wall = (solid: number[], ground: number[], x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { solid[y * 20 + x] = 5; ground[y * 20 + x] = 9; }
  };

  it('finds thin walls and blocks standing alone', () => {
    expect(lint((s, g) => wall(s, g, 0, 8, 19, 8))).toContain('thin-wall');
    expect(lint((s, g) => wall(s, g, 5, 5, 10, 10))).toContain('free-block');
  });
});

describe('architecture lint on a map whose walls are only fine cells', () => {
  it('reads the fine cells even without a solid layer: a picture across a one-tile passage is reported', async () => {
    const { encodeFineSolid } = await import('../src/core/game/fineSolid.js');
    const { normalizeObject } = await import('../src/core/game/types.js');
    const s = createScene({ name: 's', cols: 20, rows: 20, tileSize: 32 });
    s.layers = [{ name: 'ground', tiles: new Array(400).fill(1), solid: false, visible: true }];
    // fine walls (8 px cells) filling tile columns 0..9 and 11..19 on tile row 10: a passage one tile wide at column 10
    const cols = 80, rows = 80;
    const bits = new Array(cols * rows).fill(0);
    for (let y = 40; y < 44; y++) for (let x = 0; x < cols; x++) if (x < 40 || x >= 44) bits[y * cols + x] = 1;
    s.collisionFine = encodeFineSolid(bits, cols, rows, 8);
    s.instances = [{ id: 'pic', object: 'pic', x: 300, y: 270 }]; // its foot is on tile row 10
    const types = new Map([['pic', normalizeObject({ name: 'pic', sprite: 'pic' })]]);
    const codes = lintScene(s, { types, sizeOf: () => ({ w: 64, h: 64 }), resolver: () => new TileResolver(undefined) }).map((p) => p.code);
    expect(codes).toContain('covers-path');
  });
});
