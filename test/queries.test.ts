import { describe, expect, it } from 'vitest';
import { World, emptyInput, runPlaytest } from '../src/core/game/engine.js';
import { type GameBundle, createGame, createScene, normalizeObject, normalizeScene } from '../src/core/game/types.js';
import { nodeEvaluator } from '../src/server/scripts.js';

const box = (name: string, w = 16, h = 16) => ({ name, width: w, height: h, frames: [{ x: 0, y: 0, w, h, duration: 100 }], tags: [], grid: null });

/** 20x10 tiles of 16px; a solid wall column at tile x = 10. */
function bundle(scripts: Record<string, string> = {}): GameBundle {
  const a = createScene({ name: 'a', cols: 20, rows: 10, tileSize: 16 });
  for (let y = 0; y < 10; y++) a.layers[0].tiles[y * 20 + 10] = 0;
  a.instances.push(
    { id: 'p', object: 'player', x: 16, y: 32 },
    { id: 'e1', object: 'slime', x: 64, y: 32 },
    { id: 'e2', object: 'slime', x: 200, y: 32, tags: ['boss'] },
    { id: 'c', object: 'crate', x: 96, y: 96 },
    { id: 'k', object: 'coin', x: 40, y: 100 },
  );
  const b = createScene({ name: 'b', cols: 20, rows: 10, tileSize: 16 });
  b.instances.push({ id: 'p', object: 'player', x: 16, y: 32 });
  const game = createGame({
    startScene: 'a',
    variables: { score: 0, coins: 0 },
    objects: [
      normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 60 }], tags: ['hero'] }),
      normalizeObject({ name: 'slime', sprite: 'box', tags: 'enemy, monster' }),
      normalizeObject({ name: 'crate', sprite: 'box', behaviors: [{ type: 'solid' }] }),
      normalizeObject({ name: 'coin', sprite: 'box', tags: ['pickup'] }),
    ],
  });
  return { game, scenes: { a, b }, sprites: { box: box('box') }, scripts };
}
const steps = async (w: World, n: number, input = emptyInput()) => {
  for (let i = 0; i < n; i++) {
    w.step(input);
    await w.settle();
  }
};

describe('tags', () => {
  it('normalizes tags from arrays and comma lists, and adds instance tags', () => {
    expect(normalizeObject({ name: 'x', tags: ' enemy, monster ,enemy, bad tag' }).tags).toEqual(['enemy', 'monster']);
    expect(normalizeScene({ instances: [{ id: 'i', object: 'x', x: 0, y: 0, tags: ['boss'] }] }).instances[0].tags).toEqual(['boss']);
    const w = new World(bundle());
    w.step();
    const e2 = w.actors.find((a) => a.sceneId === 'e2')!;
    expect([...e2.tags].sort()).toEqual(['boss', 'enemy', 'monster']);
  });

  it('works from scripts and expressions', async () => {
    const b = bundle({
      Probe: `export default class Probe extends Behaviour {
        start() {
          const s = findOne('slime')
          log('tags ' + s.tags.join('+') + ' ' + s.hasTag('enemy') + ' ' + s.hasTag('pickup'))
          log('enemies ' + findWithTag('enemy').length + ' bosses ' + findWithTag('boss').length)
          s.addTag('marked'); log('marked ' + findWithTag('marked').length)
          s.removeTag('marked'); log('unmarked ' + findWithTag('marked').length)
        }
      }`,
    });
    b.scenes.a.components = [{ type: 'script', name: 'Probe' }];
    b.scenes.a.events.push({ trigger: { type: 'start' }, conditions: [{ type: 'expr', expr: 'countTag("enemy") == 2' }], actions: [{ type: 'set', target: 'score', value: '7' }] });
    const r = await runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator });
    const tail = (s: string) => r.logs.some((l) => l.endsWith(s));
    expect(tail('tags enemy+monster true false')).toBe(true);
    expect(tail('enemies 2 bosses 1')).toBe(true);
    expect(tail('marked 1')).toBe(true);
    expect(tail('unmarked 0')).toBe(true);
    expect(r.final.globals.score).toBe(7);
  });
});

describe('physics queries', () => {
  it('raycasts against tiles, solid instances and filtered instances', () => {
    const w = new World(bundle());
    w.step();
    // Along y = 40 to the right: the slime at x 64 is not solid, the wall tile starts at x 160.
    let hit = w.raycast(0, 40, 300, 40)!;
    expect(hit.tile).toBe(true);
    expect(hit.x).toBeCloseTo(160);
    expect(hit.normalX).toBe(-1);
    // With a tag filter the slime is hit first.
    hit = w.raycast(0, 40, 300, 40, { tag: 'enemy' })!;
    expect(hit.actor?.sceneId).toBe('e1');
    expect(hit.x).toBeCloseTo(64);
    // Going down at x = 100: the solid crate (y 96).
    hit = w.raycast(100, 0, 100, 150)!;
    expect(hit.actor?.type.name).toBe('crate');
    expect(hit.y).toBeCloseTo(96);
    expect(hit.normalY).toBe(-1);
    // Too short: nothing.
    expect(w.raycast(0, 40, 50, 40)).toBeNull();
    // Ignoring solids.
    expect(w.raycast(0, 40, 300, 40, { solids: false })).toBeNull();
    // Diagonal into the wall.
    hit = w.raycast(150, 0, 170, 20)!;
    expect(hit.tile).toBe(true);
    expect(hit.x).toBeCloseTo(160);
  });

  it('answers overlap, nearest and solid point queries', () => {
    const w = new World(bundle());
    w.step();
    expect(w.isSolidAt(165, 5)).toBe(true);
    expect(w.isSolidAt(100, 100)).toBe(true); // crate
    expect(w.isSolidAt(40, 40)).toBe(false);
    expect(w.overlapRect({ x: 60, y: 30, w: 10, h: 10 }).map((a) => a.sceneId)).toEqual(['e1']);
    expect(w.overlapRect({ x: 0, y: 0, w: 320, h: 160 }, { tag: 'enemy' }).length).toBe(2);
    expect(w.overlapCircle(40, 40, 30, { object: 'slime' }).map((a) => a.sceneId)).toEqual(['e1']);
    expect(w.findNearest(190, 40, { tag: 'enemy' })?.sceneId).toBe('e2');
    expect(w.findNearest(0, 0, { tag: 'enemy', maxDistance: 10 })).toBeUndefined();
  });

  it('is usable from components: line of sight and area attacks', async () => {
    const b = bundle({
      Sight: `export default class Sight extends Behaviour {
        start() {
          const me = this.self
          const p = player()
          const seen = raycast(me.centerX, me.centerY, p.centerX, p.centerY, { object: 'player', ignore: me })
          log('e1 sees player ' + (seen && seen.instance === p))
          const far = findOne('crate')
          const blocked = raycast(me.centerX, me.centerY, 300, me.centerY, { ignore: me })
          log('wall at ' + Math.round(blocked.x) + ' tile ' + blocked.tile)
          log('near ' + findNearest(me, { tag: 'hero' }).object + ' ' + findNearest(me, { tag: 'enemy' }))
          log('area ' + overlapCircle(me.centerX, me.centerY, 40).map((h) => h.object).sort().join(','))
          log('solid ' + isSolidAt(far.centerX, far.centerY) + ' ' + Boolean(far))
        }
      }`,
    });
    b.game.objects[1].behaviors = [{ type: 'script', name: 'Sight' }];
    b.scenes.a.instances = b.scenes.a.instances.filter((i) => i.id !== 'e2');
    const r = await runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator });
    const tail = (s: string) => r.logs.some((l) => l.endsWith(s));
    expect(tail('e1 sees player true')).toBe(true);
    expect(tail('wall at 160 tile true')).toBe(true);
    expect(tail('near player null')).toBe(true); // itself is ignored
    expect(tail('area player,slime')).toBe(true); // the circle includes the slime itself
    expect(tail('solid true true')).toBe(true);
  });
});

describe('save slots', () => {
  it('saves and loads the scene, instances, variables and component fields', async () => {
    const b = bundle({
      Counter: `export default class Counter extends Behaviour { n = 0; update() { this.n++ } }`,
      Keeper: `export default class Keeper extends Behaviour { total = 0 }`,
    });
    b.game.objects[1].behaviors = [{ type: 'script', name: 'Counter' }];
    b.game.components = [{ type: 'script', name: 'Keeper' }];
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 10);
    const player = () => w.actors.find((a) => a.type.name === 'player')!;
    player().x = 120;
    w.globals.score = 42;
    w.actors.find((a) => a.type.name === 'coin')!.destroyed = true;
    w.destroy(w.actors.find((a) => a.sceneId === 'e2')!);
    (w.gameComponents[0] as unknown as { total: number }).total = 9;
    const counter = () => w.scripts.findAll('Counter')[0] as unknown as { n: number };
    const nAtSave = counter().n;
    expect(w.saveGame('slot1')).toMatchObject({ slot: 'slot1', scene: 'a' });
    expect(w.hasSave('slot1')).toBe(true);
    expect(w.hasSave('other')).toBe(false);

    // Change everything, go elsewhere, then load.
    w.globals.score = 0;
    (w.gameComponents[0] as unknown as { total: number }).total = 0;
    w.gotoScene('b');
    await steps(w, 5);
    expect(w.scene.name).toBe('b');
    expect(w.loadGame('slot1')).toBe(true);
    await steps(w, 2);
    expect(w.scene.name).toBe('a');
    expect(w.globals.score).toBe(42);
    expect(Math.round(player().x)).toBe(120);
    expect(w.actors.some((a) => a.sceneId === 'e2')).toBe(false);
    expect(w.actors.some((a) => a.type.name === 'coin')).toBe(false); // gone when saved, gone when loaded
    expect(counter().n).toBeGreaterThanOrEqual(nAtSave);
    expect(counter().n).toBeLessThan(nAtSave + 4);
    expect((w.gameComponents[0] as unknown as { total: number }).total).toBe(9);
    expect(w.listSaves().map((s) => s.slot)).toEqual(['slot1']);
    w.deleteSave('slot1');
    expect(w.hasSave('slot1')).toBe(false);
    expect(w.loadGame('slot1')).toBe(false);
  });

  it('uses the game storage and works from events and scripts', async () => {
    const mem = new Map<string, string>();
    const storage = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
    const b = bundle({
      Crystal: `let done = false // module state: survives the scene reload done by loadGame
      export default class Crystal extends Behaviour {
        async start() {
          if (done) return
          done = true
          vars.coins = 3
          saveGame('crystal')
          vars.coins = 0
          await this.wait(0.1)
          log('saves ' + listSaves().map((s) => s.slot + '@' + s.scene).join(',') + ' has ' + hasSave('crystal'))
          loadGame('crystal')
        }
      }`,
    });
    b.scenes.a.components = [{ type: 'script', name: 'Crystal' }];
    const w = new World(b, { evaluator: nodeEvaluator, storage });
    await steps(w, 20);
    expect(mem.has('save:crystal')).toBe(true);
    expect(w.logs.some((l) => l.endsWith('saves crystal@a has true'))).toBe(true);
    expect(w.globals.coins).toBe(3);
    // A new session (same storage) can load it from an event.
    const b2 = bundle();
    b2.scenes.b.events.push({ trigger: { type: 'start' }, conditions: [{ type: 'expr', expr: 'hasSave("crystal")' }], actions: [{ type: 'loadGame', slot: 'crystal' }] });
    b2.game.startScene = 'b';
    const w2 = new World(b2, { storage });
    await steps(w2, 3);
    expect(w2.scene.name).toBe('a');
    expect(w2.globals.coins).toBe(3);
  });
});

import { editWorld, inspectWorld } from '../src/core/game/debug.js';

describe('live inspector', () => {
  it('describes the running world and applies edits', async () => {
    const b = bundle({ Spin: 'export default class Spin extends Behaviour { speed = 2; _t = 0; update() { this._t += 1 } }', Boss: 'export default class Boss extends Behaviour { phase = 1 }' });
    b.game.objects[1].behaviors = [{ type: 'script', name: 'Spin' }];
    b.scenes.a.components = [{ type: 'script', name: 'Boss' }];
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 3);
    const v = inspectWorld(w);
    expect(v.scene).toBe('a');
    expect(v.globals).toMatchObject({ score: 0, coins: 0 });
    expect(v.sceneComponents).toEqual([{ index: 0, name: 'Boss', enabled: true, fields: { phase: 1 } }]);
    const slime = v.actors.find((a) => a.sceneId === 'e1')!;
    expect(slime.tags).toEqual(['enemy', 'monster']);
    expect(slime.components[0]).toMatchObject({ name: 'Spin', enabled: true, fields: { speed: 2, _t: 3 } });
    expect(JSON.parse(JSON.stringify(v))).toEqual(v); // serializable for postMessage

    expect(editWorld(w, { kind: 'global', key: 'score', value: 5 })).toBe(true);
    expect(editWorld(w, { kind: 'actor', id: slime.id, key: 'x', value: 99 })).toBe(true);
    expect(editWorld(w, { kind: 'actor', id: slime.id, key: 'visible', value: false })).toBe(true);
    expect(editWorld(w, { kind: 'actorVar', id: slime.id, key: 'hp', value: 7 })).toBe(true);
    expect(editWorld(w, { kind: 'component', scope: 'object', id: slime.id, index: 0, key: 'speed', value: 9 })).toBe(true);
    expect(editWorld(w, { kind: 'component', scope: 'object', id: slime.id, index: 0, key: 'enabled', value: false })).toBe(true);
    expect(editWorld(w, { kind: 'component', scope: 'scene', index: 0, key: 'phase', value: 2 })).toBe(true);
    expect(editWorld(w, { kind: 'actor', id: 12345, key: 'x', value: 1 })).toBe(false);
    await steps(w, 2);
    const after = inspectWorld(w);
    const s2 = after.actors.find((a) => a.sceneId === 'e1')!;
    expect(after.globals.score).toBe(5);
    expect(s2).toMatchObject({ x: 99, visible: false, vars: { hp: 7 } });
    expect(s2.components[0]).toMatchObject({ enabled: false, fields: { speed: 9, _t: 3 } }); // disabled: no more updates
    expect(after.sceneComponents[0].fields.phase).toBe(2);
  });
});
