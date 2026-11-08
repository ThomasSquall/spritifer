import { describe, expect, it } from 'vitest';
import { World, emptyInput, renderWorld, runPlaytest } from '../src/core/game/engine.js';
import { validateGame } from '../src/core/game/catalog.js';
import { LIBRARY } from '../src/core/game/library.js';
import { renameObjectRefs } from '../src/core/game/refactor.js';
import { type GameBundle, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { resolveObjectTypes } from '../src/core/game/variants.js';
import { nodeEvaluator } from '../src/server/scripts.js';

const box = (name: string, w = 16, h = 16) => ({ name, width: w, height: h, frames: [{ x: 0, y: 0, w, h, duration: 100 }], tags: [], grid: null });
const steps = async (w: World, n: number, input = emptyInput()) => {
  for (let i = 0; i < n; i++) {
    w.step(input);
    await w.settle();
  }
};

/** 40x20 tiles of 16px, 320x180 screen. Optional wall: a column at tile x=10 from y=0 to y=14 (gap below). */
function bundle(opts: { wall?: boolean; scripts?: Record<string, string>; objects?: object[] } = {}): GameBundle {
  const a = createScene({ name: 'a', cols: 40, rows: 20, tileSize: 16 });
  if (opts.wall) for (let y = 0; y < 15; y++) a.layers[0].tiles[y * 40 + 10] = 0;
  a.instances.push({ id: 'p', object: 'player', x: 32, y: 32 });
  const game = createGame({
    startScene: 'a',
    width: 320,
    height: 180,
    objects: [normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 120 }, { type: 'camera', smoothing: 0 }] }), ...(opts.objects ?? []).map(normalizeObject)],
  });
  return { game, scenes: { a }, sprites: { box: box('box'), red: box('red', 8, 8) }, scripts: opts.scripts ?? {} };
}

describe('topdown', () => {
  it('moves diagonally at diagonalSpeed per axis, also when running', async () => {
    const b = bundle();
    b.game.objects[0].behaviors[0] = { type: 'topdown', speed: 120, runSpeed: 240, diagonalSpeed: 90 };
    const w = new World(b);
    await steps(w, 1);
    const p = w.actors[0];
    const down = (...keys: string[]) => ({ ...emptyInput(), down: new Set(keys) });
    let x = p.x;
    let y = p.y;
    await steps(w, 2, down('right', 'down'));
    expect(p.x - x).toBeCloseTo(3); // 1.5 px per step on each axis
    expect(p.y - y).toBeCloseTo(3);
    x = p.x;
    y = p.y;
    await steps(w, 2, down('right', 'down', 'shift'));
    expect(p.x - x).toBeCloseTo(6);
    expect(p.y - y).toBeCloseTo(6);
    x = p.x;
    await steps(w, 2, down('right'));
    expect(p.x - x).toBeCloseTo(4); // straight lines keep the normal speed
  });
});

describe('camera', () => {
  it('keeps what it follows on the same screen pixel, also moving at fractions of a pixel', async () => {
    const b = bundle();
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 120, diagonalSpeed: 90 }, { type: 'camera', smoothing: 0.15 }];
    b.scenes.a.instances[0].x = 200;
    b.scenes.a.instances[0].y = 100;
    const w = new World(b);
    await steps(w, 1);
    const input = { ...emptyInput(), down: new Set(['right', 'down']) };
    await steps(w, 40, input);
    const seen = new Set<string>();
    const r = { clear() {}, rect() {}, text() {}, image(_s: string, _sx: number, _sy: number, _sw: number, _sh: number, dx: number, dy: number) { seen.add(`${dx},${dy}`); } };
    for (let i = 0; i < 12; i++) {
      await steps(w, 1, input);
      renderWorld(w, r);
    }
    expect(seen.size).toBe(1);
  });

  it('follows with a dead zone and look-ahead, clamps to bounds, zooms', async () => {
    const b = bundle();
    b.game.objects[0].behaviors[1] = { type: 'camera', smoothing: 0, deadZoneX: 40, lookAhead: 0 };
    b.scenes.a.instances[0].x = 300;
    b.scenes.a.instances[0].y = 150;
    const w = new World(b);
    await steps(w, 1);
    const p = w.actors[0];
    expect(w.camera.x).toBe(300 + 8 - 160); // centered at start
    const cx0 = w.camera.x;
    p.x += 30; // inside the dead zone
    await steps(w, 1);
    expect(w.camera.x).toBe(cx0);
    p.x += 30; // past it: the camera keeps it at the dead zone edge
    await steps(w, 1);
    expect(w.camera.x).toBeCloseTo(p.x + 8 - 40 - 160, 5);

    // Zoom halves the visible area; bounds keep the view in a room.
    w.camera.zoom = 2;
    w.cameraBounds = { x: 0, y: 0, w: 200, h: 120 };
    await steps(w, 1);
    expect(w.viewWidth).toBe(160);
    expect(w.camera.x).toBe(200 - 160);
    expect(w.camera.y).toBe(120 - 90);
    // Clicks map back through the zoom.
    expect(w.read(['game', 'mouseX'], {})).toBe(0);
  });

  it('zooms from the Camera behavior, follows other targets and renders zoomed', async () => {
    const b = bundle({ objects: [{ name: 'boss', sprite: 'box' }] });
    b.game.objects[0].behaviors[1] = { type: 'camera', smoothing: 0, zoom: 2 };
    b.scenes.a.instances.push({ id: 'b', object: 'boss', x: 500, y: 200 });
    b.scripts = { Cam: "export default class Cam extends Behaviour { async start() { await this.wait(0.1); camera.follow(findOne('boss')); log('zoom ' + camera.zoom + ' ' + camera.width) } }" };
    b.scenes.a.components = [{ type: 'script', name: 'Cam' }];
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 12);
    expect(w.logs.some((l) => l.endsWith('zoom 2 160'))).toBe(true);
    expect(w.camera.x).toBe(500 + 8 - 80);
    // Rendering: the boss sprite is drawn at twice its size.
    const draws: { name: string; dx: number; scale?: number }[] = [];
    renderWorld(w, { clear() {}, rect() {}, text() {}, image: (name, _sx, _sy, _sw, _sh, dx, _dy, o) => void draws.push({ name, dx, scale: o.scale }) });
    expect(draws.find((d) => d.name === 'box' && d.dx === 160 - 16)).toMatchObject({ scale: 2 });
  });
});

describe('object type variants', () => {
  const objects = [
    { name: 'slime', sprite: 'box', hitbox: { x: 2, y: 2, w: 12, h: 12 }, properties: { hp: 3, gold: 1 }, tags: ['enemy'], behaviors: [{ type: 'patrol', speed: 40 }, { type: 'script', name: 'Health', max: 3 }], events: [{ trigger: { type: 'created' }, conditions: [], actions: [{ type: 'log', value: '"slime created"' }] }] },
    { name: 'red_slime', extends: 'slime', sprite: 'red', properties: { hp: 6 }, tags: ['fire'], behaviors: [{ type: 'patrol', speed: 80 }, { type: 'script', name: 'Health', max: 6 }, { type: 'sine' }], events: [{ trigger: { type: 'created' }, conditions: [], actions: [{ type: 'log', value: '"red created"' }] }] },
    { name: 'king_slime', extends: 'red_slime', properties: { gold: 50 } },
  ];

  it('merges a variant over its parent, recursively', () => {
    const r = resolveObjectTypes(objects.map(normalizeObject));
    expect(r.errors).toEqual([]);
    const king = r.types.get('king_slime')!;
    expect(king.sprite).toBe('red');
    expect(king.hitbox).toEqual({ x: 2, y: 2, w: 12, h: 12 });
    expect(king.properties).toEqual({ hp: 6, gold: 50 });
    expect(king.tags).toEqual(['enemy', 'fire']);
    expect(king.behaviors).toEqual([{ type: 'patrol', speed: 80 }, { type: 'script', name: 'Health', max: 6 }, { type: 'sine' }]);
    expect(king.events).toHaveLength(2);
    expect(r.lineage.get('king_slime')).toEqual(['king_slime', 'red_slime', 'slime']);
  });

  it('reports loops and missing parents', () => {
    const r = resolveObjectTypes([normalizeObject({ name: 'a', extends: 'b' }), normalizeObject({ name: 'b', extends: 'a' }), normalizeObject({ name: 'c', extends: 'ghost' })]);
    expect(r.errors.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringContaining('variant loop'), 'based on "ghost", which doesn\'t exist']));
    const g = createGame({ objects: [normalizeObject({ name: 'c', extends: 'ghost' })] });
    expect(validateGame(g, [createScene({ name: 's' })], new Set()).some((p) => p.message.includes('ghost'))).toBe(true);
  });

  it('runs variants with inherited behavior; parent queries include variants', async () => {
    const b = bundle({ objects, scripts: { 'combat/Health': LIBRARY.find((c) => c.name === 'Health')!.code } });
    b.scenes.a.instances.push({ id: 's', object: 'slime', x: 100, y: 100 }, { id: 'r', object: 'red_slime', x: 200, y: 100 }, { id: 'k', object: 'king_slime', x: 300, y: 100 });
    b.scenes.a.events.push({ trigger: { type: 'start' }, conditions: [{ type: 'expr', expr: 'count("slime") == 3 && count("red_slime") == 2' }], actions: [{ type: 'log', value: '"counted"' }] });
    b.scripts!.Q = "export default class Q extends Behaviour { start() { const k = findOne('king_slime'); log('find ' + find('slime').length + ' ' + k.isA('slime') + ' ' + k.isA('player') + ' hp ' + k.getComponent('Health').max + ' gold ' + k.gold) } }";
    b.scenes.a.components = [{ type: 'script', name: 'Q' }];
    const r = await runPlaytest(b, { seconds: 0.5, evaluator: nodeEvaluator });
    const tail = (s: string) => r.logs.some((l) => l.endsWith(s));
    expect(tail('counted')).toBe(true);
    expect(tail('find 3 true false hp 6 gold 50')).toBe(true);
    expect(r.logs.filter((l) => l.endsWith('slime created'))).toHaveLength(3); // parent events run for variants too
    expect(r.logs.filter((l) => l.endsWith('red created'))).toHaveLength(2);
    const xs = Object.fromEntries(r.final.actors.filter((a) => a.object !== 'player').map((a) => [a.object, Math.abs(a.vx)]));
    expect(xs).toEqual({ slime: 40, red_slime: 80, king_slime: 80 });
  });

  it('keeps variants pointing at a renamed parent', () => {
    const g = createGame({ objects: objects.map(normalizeObject) });
    renameObjectRefs(g, [], 'slime', 'blob');
    expect(g.objects.find((o) => o.name === 'red_slime')!.extends).toBe('blob');
  });
});

describe('pathfinding', () => {
  it('finds a way around walls without cutting corners', () => {
    const w = new World(bundle({ wall: true }));
    w.step();
    // From the left of the wall to the right of it, same row: must go down through the gap (rows 15+).
    const path = w.findPath(100, 40, 220, 40)!;
    expect(path).not.toBeNull();
    expect(path[path.length - 1]).toEqual({ x: 220, y: 40 });
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThanOrEqual(15 * 16);
    for (const p of path) expect(w.isSolidAt(p.x, p.y)).toBe(false);
    // Unreachable target (inside the wall): null, or as close as possible with partial.
    expect(w.findPath(100, 40, 168, 40)).toBeNull();
    const part = w.findPath(100, 40, 168, 40, { partial: true })!;
    expect(Math.floor(part[part.length - 1].x / 16)).toBe(9);
  });

  it('walks instances along paths and cancels them', async () => {
    const b = bundle({
      wall: true,
      objects: [{ name: 'npc', sprite: 'box', hitbox: { x: 4, y: 8, w: 8, h: 8 } }],
      scripts: { Walk: "export default class Walk extends Behaviour { async start() { const ok = await this.self.pathTo(260, 60, 200); log('arrived ' + ok + ' at ' + Math.round(this.self.centerX) + ',' + Math.round(this.self.centerY)); const p = this.self.pathTo(20, 20, 50); await this.wait(0.2); this.self.stopMoving(); log('cancelled ' + (await p)) } }" },
    });
    b.game.objects[1].behaviors = [{ type: 'script', name: 'Walk' }];
    b.scenes.a.instances.push({ id: 'n', object: 'npc', x: 120, y: 40 });
    const r = await runPlaytest(b, { seconds: 6, evaluator: nodeEvaluator });
    expect(r.logs.some((l) => l.endsWith('arrived true at 260,60'))).toBe(true);
    expect(r.logs.some((l) => l.endsWith('cancelled false'))).toBe(true);
  });

  it('Roam wanders near home and ChasePath hunts the player around a wall', async () => {
    const lib = Object.fromEntries(LIBRARY.filter((c) => ['Roam', 'ChasePath'].includes(c.name)).map((c) => [`ai/${c.name}`, c.code]));
    const b = bundle({
      wall: true,
      objects: [{ name: 'villager', sprite: 'box', hitbox: { x: 4, y: 8, w: 8, h: 8 }, behaviors: [{ type: 'script', name: 'Roam', radius: 32, pauseMin: 0.1, pauseMax: 0.3, speed: 60 }] }, { name: 'wolf', sprite: 'box', hitbox: { x: 4, y: 8, w: 8, h: 8 }, behaviors: [{ type: 'script', name: 'ChasePath', range: 400, giveUpRange: 900, speed: 80 }] }],
      scripts: lib,
    });
    b.game.objects[0].behaviors = [{ type: 'topdown', speed: 0, controls: false }];
    b.scenes.a.instances = [{ id: 'p', object: 'player', x: 120, y: 40 }, { id: 'v', object: 'villager', x: 400, y: 200 }, { id: 'w', object: 'wolf', x: 220, y: 40 }];
    const r = await runPlaytest(b, { seconds: 6, evaluator: nodeEvaluator });
    expect(r.logs.filter((l) => l.includes('ERROR'))).toEqual([]);
    const at = (o: string) => r.final.actors.find((a) => a.object === o)!;
    const v = at('villager');
    expect(Math.hypot(v.x - 400, v.y - 200)).toBeLessThanOrEqual(32 + 16);
    expect(v.x !== 400 || v.y !== 200).toBe(true);
    const wolf = at('wolf');
    expect(Math.hypot(wolf.x - 120, wolf.y - 40)).toBeLessThan(40); // went around the wall to the player
  });
});
