import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { World, emptyInput } from '../src/core/game/engine.js';
import { LIBRARY } from '../src/core/game/library.js';
import { type GameBundle, type Instance, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { addLibraryComponents, inspectScripts, nodeEvaluator } from '../src/server/scripts.js';
import { Workspace } from '../src/server/store.js';

const scripts = Object.fromEntries(LIBRARY.map((c) => [`${c.folder}/${c.name}`, c.code]));
const box = (name: string, w = 16, h = 16) => ({ name, width: w, height: h, frames: [{ x: 0, y: 0, w, h, duration: 100 }], tags: [], grid: null });

/** Two top-down scenes, 30x15 tiles. */
function world(objects: Parameters<typeof normalizeObject>[0][], a: Instance[], b: Instance[] = [], extra: (g: GameBundle) => void = () => {}): World {
  const sa = createScene({ name: 'a', cols: 30, rows: 15, tileSize: 16 });
  sa.instances = a;
  const sb = createScene({ name: 'b', cols: 30, rows: 15, tileSize: 16 });
  sb.instances = b;
  const game = createGame({ startScene: 'a', variables: { score: 0, lives: 2 }, objects: [normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 60 }] }), ...objects.map(normalizeObject)] });
  const bundle: GameBundle = { game, scenes: { a: sa, b: sb }, sprites: { box: box('box'), small: box('small', 4, 4) }, scripts };
  extra(bundle);
  return new World(bundle, { evaluator: nodeEvaluator });
}
const run = async (w: World, seconds: number, input = emptyInput()) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    w.step(input);
    await w.settle();
  }
};
const comp = <T>(w: World, name: string, object?: string) => w.scripts.findAll(name).find((c) => !object || (c as unknown as { self: { object: string } }).self?.object === object) as unknown as T;
const actor = (w: World, name: string) => w.actors.find((a) => a.type.name === name && !a.destroyed);

describe('component library', () => {
  it('loads every library component cleanly with params', () => {
    const info = inspectScripts(scripts);
    expect(info.errors).toEqual([]);
    expect(info.components.map((c) => c.name).sort()).toEqual(LIBRARY.map((c) => c.name).sort());
    for (const c of info.components) expect(c.warnings, c.name).toEqual([]);
    expect(info.components.find((c) => c.name === 'Shooter')!.params.find((p) => p.name === 'aim')).toMatchObject({ type: 'choice', options: ['flip', 'facing', 'target'] });
  });

  it('Health + Damage: hits with invincibility, onHurt/onDeath, destroy and the died message', async () => {
    const w = world(
      [{ name: 'spikes', sprite: 'box', behaviors: [{ type: 'script', name: 'Damage', knockback: 0 }] }, { name: 'slime', sprite: 'box', behaviors: [{ type: 'script', name: 'Health', max: 1 }] }],
      [{ id: 'p', object: 'player', x: 40, y: 40, components: { Health: { max: 3, hpVariable: 'hp' } } }, { id: 's', object: 'spikes', x: 40, y: 40 }, { id: 'e', object: 'slime', x: 200, y: 40 }],
    );
    w.bundle.scripts!.Watch = "export default class Watch extends Behaviour { start() { this.on('died', (d) => log('died ' + d.object)) } }";
    w.scripts.hotReload(w.bundle.scripts!);
    await run(w, 1);
    const hp = comp<{ hp: number }>(w, 'Health', 'player');
    expect(hp.hp).toBe(1); // hit at 0s and 0.6s
    expect(w.globals.hp).toBe(1);
    comp<{ damage(n: number): boolean }>(w, 'Health', 'slime').damage(5);
    await run(w, 0.1);
    expect(actor(w, 'slime')).toBeUndefined();
  });

  it('Respawn: back at the checkpoint with full health, losing a life', async () => {
    const w = world(
      [{ name: 'flag', sprite: 'box', behaviors: [{ type: 'script', name: 'Checkpoint' }] }],
      [{ id: 'p', object: 'player', x: 20, y: 40, components: { Health: { max: 2 }, Respawn: { delay: 0.2, livesVariable: 'lives', gameOverScene: 'b' } } }, { id: 'f', object: 'flag', x: 100, y: 40 }],
    );
    await run(w, 1.5, { ...emptyInput(), down: new Set(['right']) });
    expect(String(w.globals.__checkpoint)).toBe('a|f');
    const player = actor(w, 'player')!;
    const health = comp<{ hp: number; damage(n: number): boolean }>(w, 'Health', 'player');
    health.damage(5);
    expect(health.hp).toBe(0);
    await run(w, 0.5);
    expect(health.hp).toBe(2);
    expect(w.globals.lives).toBe(1);
    expect(Math.round(player.x)).toBe(100);
    // Last life (after the post-respawn invincibility): game over scene.
    await run(w, 0.7);
    expect(health.damage(5)).toBe(true);
    await run(w, 1.2);
    expect(w.scene.name).toBe('b');
  });

  it('Collectible adds to the variable, heals and pops away once', async () => {
    const w = world(
      [{ name: 'coin', sprite: 'small', behaviors: [{ type: 'script', name: 'Collectible', amount: 5 }] }],
      [{ id: 'p', object: 'player', x: 40, y: 40 }, { id: 'c', object: 'coin', x: 44, y: 44 }, { id: 'c2', object: 'coin', x: 48, y: 44 }],
    );
    await run(w, 0.6);
    expect(w.globals.score).toBe(10);
    expect(actor(w, 'coin')).toBeUndefined();
  });

  it('Door: to another scene at the named door, and inside the same scene', async () => {
    const w = world(
      [{ name: 'door', sprite: 'box', behaviors: [{ type: 'script', name: 'Door', fade: 0.1 }] }],
      [{ id: 'p', object: 'player', x: 40, y: 40 }, { id: 'd1', object: 'door', name: 'Out', x: 40, y: 80, components: { Door: { scene: 'b', entry: 'In' } } }],
      [{ id: 'p2', object: 'player', x: 300, y: 200 }, { id: 'd2', object: 'door', name: 'In', x: 160, y: 96, components: { Door: { dx: 1, entry: 'Far' } } }, { id: 'd3', object: 'door', name: 'Far', x: 400, y: 96, components: { Door: { dy: -1, entry: 'In' } } }],
    );
    for (let i = 0; i < 120 && w.scene.name === 'a'; i++) await run(w, 1 / 60, { ...emptyInput(), down: new Set(['down']) });
    expect(w.scene.name).toBe('b');
    await run(w, 2 / 60); // the new scene starts on the next frame
    const p = actor(w, 'player')!;
    expect(Math.round(p.x)).toBe(176); // one tile right of door "In" (still holding down, so only x is checked)
    // Walk back onto "In": teleports to "Far", one tile above it.
    for (let i = 0; i < 60 && p.x < 300; i++) await run(w, 1 / 60, { ...emptyInput(), down: new Set(['left']) });
    expect(Math.round(p.x)).toBe(400);
    expect(Math.round(p.y)).toBe(80);
  });

  it('Spawner keeps at most maxAlive instances', async () => {
    const w = world([{ name: 'bat', sprite: 'small' }], [], [], (g) => {
      g.scenes.a.components = [{ type: 'script', name: 'Spawner', object: 'bat', interval: 0.25, maxAlive: 3, offsetX: 100, offsetY: 50 }];
    });
    await run(w, 2);
    expect(w.actors.filter((a) => a.type.name === 'bat')).toHaveLength(3);
    expect(w.actors.find((a) => a.type.name === 'bat')!.x).toBe(100);
  });

  it('Shooter fires bullets at the target; Damage on the bullet hurts and disappears', async () => {
    const w = world(
      [
        { name: 'turret', sprite: 'box', behaviors: [{ type: 'script', name: 'Shooter', bullet: 'shot', auto: true, cooldown: 0.5, speed: 200 }] },
        { name: 'shot', sprite: 'small', behaviors: [{ type: 'bullet', speed: 0 }, { type: 'script', name: 'Damage', destroyOnHit: true, knockback: 0 }] },
      ],
      [{ id: 'p', object: 'player', x: 40, y: 40, components: { Health: { max: 10, invincibleTime: 0 } } }, { id: 't', object: 'turret', x: 140, y: 40 }],
    );
    await run(w, 1.2);
    const hp = comp<{ hp: number }>(w, 'Health', 'player').hp;
    expect(hp).toBeLessThanOrEqual(8);
    expect(hp).toBeGreaterThanOrEqual(7);
  });

  it('Countdown sets the variable and changes scene at 0', async () => {
    const w = world([], [], [], (g) => {
      g.scenes.a.components = [{ type: 'script', name: 'Countdown', seconds: 1, whenDone: 'goto scene', scene: 'b' }];
    });
    await run(w, 0.5);
    expect(w.globals.timeLeft).toBe(1);
    await run(w, 1.2);
    expect(w.scene.name).toBe('b');
  });

  it('copies components (and what they need) into a project once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-lib-'));
    try {
      const ws = new Workspace(dir);
      expect(addLibraryComponents(ws, ['Damage', 'Respawn'])).toEqual({ created: ['combat/Health', 'combat/Damage', 'player/Respawn'], existing: [] });
      expect(addLibraryComponents(ws, ['Health'])).toEqual({ created: [], existing: ['Health'] });
      expect(() => addLibraryComponents(ws, ['Nope'])).toThrow(/Available/);
      expect(fs.existsSync(path.join(dir, 'scripts', 'spritifer.d.ts'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
