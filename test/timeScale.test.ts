import { describe, expect, it } from 'vitest';
import { type Renderer, World, renderWorld, runPlaytest } from '../src/core/game/engine.js';
import { viewRenderer } from '../src/core/game/script.js';
import { type GameBundle, type SpriteAsset, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { nodeEvaluator } from '../src/server/scripts.js';

const box = (name: string, w = 16, h = 16): SpriteAsset => ({ name, width: w, height: h, frames: [{ x: 0, y: 0, w, h, duration: 100 }], tags: [], grid: null });

function bundle(scripts: Record<string, string>): GameBundle {
  const a = createScene({ name: 'a', cols: 20, rows: 12, tileSize: 16 });
  a.instances.push({ id: 'p', object: 'player', x: 10, y: 10 });
  const b = createScene({ name: 'b', cols: 20, rows: 12, tileSize: 16 });
  const game = createGame({ startScene: 'a', objects: [normalizeObject({ name: 'player', sprite: 'hero', behaviors: [{ type: 'topdown', speed: 80 }] })] });
  return { game, scenes: { a, b }, sprites: { hero: box('hero') }, scripts };
}

const play = (scripts: Record<string, string>, seconds: number) => runPlaytest(bundle(scripts), { seconds, evaluator: nodeEvaluator });

describe('setTimeScale', () => {
  it('runs the clock twice as fast at 2x and half as fast at 0.5x', async () => {
    const normal = await play({}, 1);
    expect(normal.world.clock).toBeCloseTo(1, 5);
    const fast = await play({ 'speed.js': 'onStart(() => setTimeScale(2))' }, 1);
    expect(fast.world.timeScale).toBe(2);
    expect(fast.world.clock).toBeCloseTo(2, 1);
    const slow = await play({ 'speed.js': 'onStart(() => setTimeScale(0.5))' }, 1);
    expect(slow.world.clock).toBeCloseTo(0.5, 1);
  });

  it('makes waits end sooner in real time and is readable as game.timeScale', async () => {
    const src = "onStart(async () => { setTimeScale(1.5); log('scale ' + game.timeScale); await wait(1.5); log('waited') })";
    const early = await play({ 'w.js': src }, 0.9);
    expect(early.logs.some((l) => l.includes('scale 1.5'))).toBe(true);
    expect(early.logs.some((l) => l.includes('waited'))).toBe(false);
    const late = await play({ 'w.js': src }, 1.1);
    expect(late.logs.some((l) => l.includes('waited'))).toBe(true);
  });

  it('clamps to 0.1..4 and goes back to 1 when the scene changes', async () => {
    const r = await play({ 's.js': "onStart(async () => { setTimeScale(10); log('max ' + game.timeScale); setTimeScale(0); log('bad ' + game.timeScale); setTimeScale(2); await wait(0.2); goto('b') })" }, 0.5);
    expect(r.logs.some((l) => l.includes('max 4'))).toBe(true);
    expect(r.logs.some((l) => l.includes('bad 1'))).toBe(true);
    expect(r.world.scene.name).toBe('b');
    expect(r.world.timeScale).toBe(1);
  });

  it('keeps a key press that falls on a frame without a step', async () => {
    const src = "onStart(() => setTimeScale(0.5)); onUpdate(() => { if (pressed('action')) log('pressed') })";
    const r = await runPlaytest(bundle({ 'k.js': src }), { seconds: 1, evaluator: nodeEvaluator, inputs: [{ at: 0.5, key: 'action', duration: 1 / 60 }, { at: 0.6 + 1 / 60, key: 'action', duration: 1 / 60 }] });
    expect(r.logs.filter((l) => l.includes('pressed')).length).toBe(2);
  });
});

describe('ui.view', () => {
  const rectsOf = (scripts: Record<string, string>) => {
    const b = bundle(scripts);
    b.game.width = 960;
    b.game.height = 540;
    b.game.uiScale = 3;
    return (async () => {
      const w = new World(b, { evaluator: nodeEvaluator });
      w.step();
      await w.settle();
      const rects: number[][] = [];
      const renderer = new Proxy({}, { get: (_, key) => (key === 'rect' ? (...args: number[]) => rects.push(args.slice(0, 4)) : () => undefined) });
      renderWorld(w, renderer as never);
      return rects;
    })();
  };

  it('magnifies interface drawing around a fixed point until view() or the end of onDraw', async () => {
    const rects = await rectsOf({
      'a.js': "onDraw((ui) => { ui.view({ zoom: 2, x: 160, y: 90 }); ui.rect(150, 80, 20, 10, '#fff'); ui.rect(160, 90, 1, 1, '#f00'); ui.view(); ui.rect(10, 20, 30, 5, '#fff'); ui.view({ zoom: 2, x: 0, y: 0 }) })",
      'b.js': "onDraw((ui) => { ui.rect(1, 2, 3, 4, '#0f0') })",
    });
    // (150, 80) is 10 units left of and above the center: twice as far at zoom 2, then x3 for the interface scale.
    expect(rects).toContainEqual([420, 210, 120, 60]);
    // The center itself stays put.
    expect(rects).toContainEqual([480, 270, 6, 6]);
    // After view(), and in the next onDraw, nothing is magnified.
    expect(rects).toContainEqual([30, 60, 90, 15]);
    expect(rects).toContainEqual([3, 6, 9, 12]);
  });

  it('magnifies device-pixel drawing (the effects) around the same point', () => {
    const calls: unknown[][] = [];
    const base: Renderer = {
      clear() {},
      image: (...args) => calls.push(['image', args[5], args[6], args[7].scale]),
      rect: (...args) => calls.push(['rect', ...args.slice(0, 4)]),
      text: (...args) => calls.push(['text', args[1], args[2], args[4]]),
    };
    // crystal-vale: 2 world pixels per interface unit, the center of the screen is (160, 90) in interface units.
    const view = { zoom: 2, x: 160, y: 90 };
    const r = viewRenderer(base, 2, () => view);
    r.image('fx', 0, 0, 8, 8, 300, 170, { flipX: false, opacity: 1, angle: 0 });
    r.rect(320, 180, 4, 4, '#fff');
    r.text('hi', 330, 190, '#fff', 1);
    expect(calls).toEqual([
      ['image', 280, 160, 2],
      ['rect', 320, 180, 8, 8],
      ['text', 340, 200, 2],
    ]);
  });
});
