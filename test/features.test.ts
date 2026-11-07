import { describe, expect, it } from 'vitest';
import { World, emptyInput, runPlaytest } from '../src/core/game/engine.js';
import { defaultEvaluator, scriptLocation } from '../src/core/game/script.js';
import { type GameBundle, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { nodeEvaluator } from '../src/server/scripts.js';

function bundle(scripts: Record<string, string>, behaviors: object[] = []): GameBundle {
  const a = createScene({ name: 'a', cols: 20, rows: 12, tileSize: 16 });
  a.instances.push({ id: 'p', object: 'player', x: 10, y: 10 }, { id: 'e', object: 'thing', x: 100, y: 10 });
  const b = createScene({ name: 'b', cols: 20, rows: 12, tileSize: 16 });
  const game = createGame({
    startScene: 'a',
    variables: { score: 0 },
    objects: [
      normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 80 }] }),
      normalizeObject({ name: 'thing', sprite: 'box', behaviors }),
    ],
  });
  return { game, scenes: { a, b }, sprites: { box: { name: 'box', width: 16, height: 16, frames: [{ x: 0, y: 0, w: 16, h: 16, duration: 100 }], tags: [], grid: null } }, scripts };
}

const steps = async (w: World, n: number) => {
  for (let i = 0; i < n; i++) {
    w.step(emptyInput());
    await w.settle();
  }
};
const tail = (logs: string[], s: string) => logs.some((l) => l.endsWith(s));

describe('messages with data', () => {
  it('delivers emit(name, data) to this.on, onMessage and plain on(); listeners die with their component', async () => {
    const b = bundle({
      Listener: `export default class Listener extends Behaviour {
        start() { this.on('hit', (d) => { vars.score += d.damage; log('heard ' + d.damage) }) }
        onMessage(name, data) { if (name === 'hit') log('onMessage ' + data.damage) }
      }`,
      Sender: `export default class Sender extends Behaviour {
        async start() { this.emit('hit', { damage: 2 }); await this.wait(0.1); this.self.destroy(); await this.wait(0); }
      }`,
      Later: `on('hit', (d, name) => log('plain ' + name + ' ' + d.damage))
        export default class Later extends Behaviour { async start() { await this.wait(0.3); emit('hit', { damage: 5 }) } }`,
    }, [{ type: 'script', name: 'Listener' }, { type: 'script', name: 'Sender' }]);
    b.scenes.a.components = [{ type: 'script', name: 'Later' }];
    const r = await runPlaytest(b, { seconds: 0.6, evaluator: nodeEvaluator });
    expect(tail(r.logs, 'heard 2')).toBe(true);
    expect(tail(r.logs, 'onMessage 2')).toBe(true);
    expect(tail(r.logs, 'plain hit 2')).toBe(true);
    expect(tail(r.logs, 'plain hit 5')).toBe(true);
    // The listener's instance was destroyed before the second message.
    expect(tail(r.logs, 'heard 5')).toBe(false);
    expect(r.final.globals.score).toBe(2);
  });
});

describe('tweens', () => {
  it('animates numeric fields with easing, chains, and stops with the component', async () => {
    const b = bundle({
      Mover: `export default class Mover extends Behaviour {
        async start() {
          await this.tween(this.self, { x: 200 }, 0.5, 'linear')
          log('at ' + Math.round(this.self.x))
          await this.tween(this.self, { y: 50, opacity: 0 }, { ease: 'outBounce', delay: 0.1 }, )
          log('never: no duration given means instant, so this runs')
        }
      }`,
      Cam: `export default class Cam extends Behaviour { start() { tween(camera, { x: 40 }, 0.2, 'inOutSine') } }`,
    }, [{ type: 'script', name: 'Mover' }]);
    b.scenes.a.components = [{ type: 'script', name: 'Cam' }];
    b.scenes.a.cols = 60;
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 16);
    const thing = w.actors.find((a) => a.type.name === 'thing')!;
    expect(thing.x).toBeGreaterThan(110);
    expect(thing.x).toBeLessThan(160);
    await steps(w, 30);
    expect(tail(w.logs, 'at 200')).toBe(true);
    expect(w.camera.x).toBeGreaterThan(0);
  });

  it('rejects unknown easings and drops tweens of destroyed components', async () => {
    const b = bundle({
      Bad: `export default class Bad extends Behaviour { async start() { await this.tween(this.self, { x: 1 }, 1, 'wobbly') } }`,
      Gone: `export default class Gone extends Behaviour {
        async start() { this.tween(this.self, { x: 300 }, 1).then(() => log('resolved')); await this.wait(0.2); this.self.removeComponent(this) }
      }`,
    }, [{ type: 'script', name: 'Bad' }, { type: 'script', name: 'Gone' }]);
    const r = await runPlaytest(b, { seconds: 1.5, evaluator: nodeEvaluator });
    expect(r.logs.some((l) => l.includes('unknown easing "wobbly"'))).toBe(true);
    expect(tail(r.logs, 'resolved')).toBe(false);
    const x = r.final.actors.find((a) => a.object === 'thing')!.x;
    expect(x).toBeGreaterThan(100);
    expect(x).toBeLessThan(300);
  });
});

describe('scene transitions', () => {
  it('fades out, changes scene, fades in', async () => {
    const b = bundle({ Go: `export default class Go extends Behaviour { start() { goto('b', { fade: 0.5, color: '#ffffff' }) } }` });
    b.scenes.a.components = [{ type: 'script', name: 'Go' }];
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 15);
    expect(w.scene.name).toBe('a');
    expect(w.fade.phase).toBe('out');
    expect(w.fadeAlpha).toBeGreaterThan(0.3);
    await steps(w, 20);
    expect(w.scene.name).toBe('b');
    expect(w.fade.phase).toBe('in');
    await steps(w, 40);
    expect(w.fade.phase).toBe('none');
    expect(w.fadeAlpha).toBe(0);
  });

  it('fades from the Go to scene event action', async () => {
    const b = bundle({});
    b.scenes.a.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'gotoScene', scene: 'b', fade: 0.2 }] });
    const r = await runPlaytest(b, { seconds: 0.6 });
    expect(r.final.scene).toBe('b');
  });
});

describe('errors with file and line', () => {
  it('reports scripts/<file>.js:<line> for loading and runtime errors in both evaluators', async () => {
    const code = { 'enemies/Bad': 'export default class Bad extends Behaviour {\n  update() {\n    this.nope.x = 1\n  }\n}', broken: 'const a = 1\nnull.b' };
    for (const evaluator of [nodeEvaluator, defaultEvaluator]) {
      const r = await runPlaytest(bundle(code, [{ type: 'script', name: 'Bad' }]), { seconds: 0.1, evaluator });
      expect(r.logs.some((l) => l.includes('(at scripts/enemies/Bad.js:3)'))).toBe(true);
      expect(r.logs.some((l) => l.includes('script broken:') && l.includes('(at scripts/broken.js:2)'))).toBe(true);
    }
    const err = new Error('x');
    err.stack = 'Error: x\n    at eval (scripts/ui/Hud.js:7:3)';
    expect(scriptLocation(err, 3)).toEqual({ file: 'ui/Hud', line: 4 });
  });
});

describe('hot reload', () => {
  it('swaps component code while keeping state, statics and listeners', async () => {
    const v1 = `export default class Counter extends Behaviour {
      count = 0
      awake() { Counter.instance = this }
      update() { this.count += 1 }
    }`;
    const b = bundle({ Counter: v1, plain: "onDraw(() => {})" }, [{ type: 'script', name: 'Counter' }]);
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 10);
    const comp = w.scripts.findAll('Counter')[0] as unknown as { count: number; step?: number };
    const before = comp.count;
    expect(before).toBeGreaterThan(5);
    const errors = w.scripts.hotReload({
      Counter: `export default class Counter extends Behaviour {
        count = 0
        step = 100
        update() { this.count += this.step; if (!this._seen) { this._seen = true; log('same instance ' + (Counter.instance === this)) } }
      }`,
      plain: "onDraw(() => {})",
    });
    expect(errors).toEqual([]);
    await steps(w, 2);
    expect(comp.count).toBe(before + 200);
    expect(comp.step).toBe(100);
    expect(tail(w.logs, 'same instance true')).toBe(true);
    expect(w.scripts.drawHooks).toHaveLength(1);
    expect(w.logs.some((l) => l.includes('scripts reloaded (1 live component updated)'))).toBe(true);
    // A broken edit reports the error and leaves the running code alone.
    expect(w.scripts.hotReload({ Counter: 'export default class Counter extends Behaviour {', plain: '' }).length).toBe(1);
    await steps(w, 1);
    expect(comp.count).toBe(before + 300);
  });
});
