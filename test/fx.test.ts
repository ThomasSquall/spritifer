import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type MusicCommand, NULL_RENDERER, World, emptyInput, renderWorld, runPlaytest } from '../src/core/game/engine.js';
import { validateGame } from '../src/core/game/catalog.js';
import { ParticleSystem } from '../src/core/game/particles.js';
import { type GameBundle, type SpriteAsset, createGame, createScene, normalizeGame, normalizeObject } from '../src/core/game/types.js';
import { loadGameBundle } from '../src/server/game.js';
import { nodeEvaluator } from '../src/server/scripts.js';
import { Workspace } from '../src/server/store.js';

const box = (name: string, w = 16, h = 16, frames = 1): SpriteAsset => ({ name, width: w, height: h, frames: Array.from({ length: frames }, (_, i) => ({ x: i * w, y: 0, w, h, duration: 100 })), tags: [], grid: null });

function bundle(opts: { scripts?: Record<string, string>; objects?: object[]; sprites?: Record<string, SpriteAsset> } = {}): GameBundle {
  const a = createScene({ name: 'a', cols: 20, rows: 12, tileSize: 16 });
  a.instances.push({ id: 'p', object: 'player', x: 40, y: 40 });
  const b = createScene({ name: 'b', cols: 20, rows: 12, tileSize: 16 });
  const game = createGame({ startScene: 'a', variables: { score: 0 }, objects: [normalizeObject({ name: 'player', sprite: 'box', behaviors: [{ type: 'topdown', speed: 60 }] }), ...(opts.objects ?? []).map(normalizeObject)] });
  return { game, scenes: { a, b }, sprites: { box: box('box'), ...(opts.sprites ?? {}) }, scripts: opts.scripts ?? {} };
}
const steps = async (w: World, n: number, input = emptyInput()) => {
  for (let i = 0; i < n; i++) {
    w.step(input);
    await w.settle();
    w.scripts.draw(NULL_RENDERER, w.camera.x, w.camera.y, w.zoom);
  }
};
const tail = (logs: string[], s: string) => logs.some((l) => l.endsWith(s));
const press = (...keys: string[]) => ({ ...emptyInput(), down: new Set(keys), pressed: new Set(keys) });

describe('animation frame events', () => {
  it('fires onAnimationEvent and the Animation event trigger when the frame shows', async () => {
    const swing = box('swing', 16, 16, 4);
    swing.frames[2].events = ['hit'];
    swing.frames[0].events = ['step'];
    swing.tags = [{ name: 'attack', from: 0, to: 3, direction: 'forward' }];
    const b = bundle({
      sprites: { swing },
      objects: [{ name: 'knight', sprite: 'swing', animation: 'attack', behaviors: [{ type: 'script', name: 'Knight' }], events: [{ trigger: { type: 'animationEvent', event: 'hit' }, conditions: [], actions: [{ type: 'add', target: 'score', value: '1' }] }] }],
      scripts: { Knight: "export default class Knight extends Behaviour { onAnimationEvent(e, anim) { log('ev ' + e + ' ' + anim + ' ' + Math.round(game.time * 10)) } }" },
    });
    b.scenes.a.instances.push({ id: 'k', object: 'knight', x: 100, y: 40 });
    const r = await runPlaytest(b, { seconds: 0.75, evaluator: nodeEvaluator });
    const evs = r.logs.filter((l) => l.includes('ev ')).map((l) => l.split('] ')[1]);
    // 100 ms frames: step at 0, hit at 0.2, step again at 0.4 (loop), hit at 0.6.
    expect(evs.map((e) => e.split(' ').slice(0, 3).join(' '))).toEqual(['ev step attack', 'ev hit attack', 'ev step attack', 'ev hit attack']);
    expect(r.final.globals.score).toBe(2);
  });

  it('keeps frame events in exported assets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-ev-'));
    try {
      const ws = new Workspace(dir);
      const raw = { format: 'spritifer', version: 1, name: 'hero', width: 4, height: 4, palette: [], layers: [{ id: 'l', name: 'L', visible: true, opacity: 1 }], frames: [{ id: 'f0', duration: 100 }, { id: 'f1', duration: 100, events: ['step'] }], tags: [], cels: {}, rev: 'x' };
      fs.writeFileSync(path.join(dir, 'hero.sprite.json'), JSON.stringify(raw));
      fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify(normalizeGame({ objects: [{ name: 'p', sprite: 'hero' }] })));
      const { bundle } = loadGameBundle(ws);
      expect(bundle.sprites.hero.frames.map((f) => f.events ?? [])).toEqual([[], ['step']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('particles', () => {
  it('bursts presets, moves, fades and expires deterministically', () => {
    let seed = 1;
    const ps = new ParticleSystem(() => ((seed = (seed * 16807) % 2147483647) / 2147483647));
    ps.burst(100, 100, 'explosion');
    expect(ps.count).toBe(30);
    ps.burst(0, 0, 'sparks', { count: 5, life: 0.1 });
    expect(ps.count).toBe(35);
    const rects: number[] = [];
    ps.draw({ ...NULL_RENDERER, rect: (_x, _y, _w, _h, _c, a) => void rects.push(a ?? 1) }, 0, 0, 1, false);
    expect(rects.length).toBe(35);
    for (let i = 0; i < 12; i++) ps.tick(1 / 60);
    expect(ps.count).toBe(30); // the short-lived sparks are gone
    for (let i = 0; i < 60; i++) ps.tick(1 / 60);
    expect(ps.count).toBe(0);
    expect(() => ps.burst(0, 0, 'nope')).toThrow(/unknown particle preset/);
  });

  it('works from scripts and the Particles event action, and renders', async () => {
    const b = bundle({ scripts: { Fx: "export default class Fx extends Behaviour { start() { particles(this.self.centerX, this.self.centerY, 'magic', { count: 7 }) } }" } });
    b.game.objects[0].behaviors.push({ type: 'script', name: 'Fx' });
    b.scenes.a.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'particles', preset: 'dust', target: 'self', count: 4 }] });
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 1);
    expect(w.particles.count).toBe(11);
    let drawn = 0;
    renderWorld(w, { ...NULL_RENDERER, rect: () => void drawn++ });
    expect(drawn).toBeGreaterThanOrEqual(11);
    w.gotoScene('b');
    await steps(w, 1);
    expect(w.particles.count).toBe(0);
  });
});

describe('UI widgets and pause', () => {
  it('drives menus with keys and buttons with clicks; pause freezes the game', async () => {
    const b = bundle({
      scripts: {
        Menu: `export default class Menu extends Behaviour {
          onDraw(ui) {
            if (!game.paused && ui.pressed('escape', true)) pause(true)
            if (game.paused) {
              const c = ui.menu('pause', ['Resume', { label: 'Shop', disabled: true }, 'Score'], 100, 40, { title: 'PAUSED', cancel: true })
              if (c !== null) log('menu ' + c + ' at ' + ui.menuIndex('pause'))
              if (c === 0 || c === -1) pause(false)
              if (c === 2) vars.score += 10
            }
            if (ui.button('+1', 10, 10, { w: 20, h: 10 })) vars.score += 1
          }
        }`,
      },
    });
    b.game.components = [{ type: 'script', name: 'Menu' }];
    const w = new World(b, { evaluator: nodeEvaluator });
    await steps(w, 2);
    const player = w.actors[0];
    await steps(w, 1, { ...emptyInput(), clicks: [[15, 12]], pointer: [15, 12] });
    expect(w.globals.score).toBe(1);
    await steps(w, 1, press('escape'));
    expect(w.paused).toBe(true);
    const x0 = player.x;
    const clock0 = w.clock;
    await steps(w, 10, { ...emptyInput(), down: new Set(['right']) });
    expect(player.x).toBe(x0);
    expect(w.clock).toBe(clock0);
    // Down skips the disabled "Shop" row: "Score".
    await steps(w, 1, press('down'));
    await steps(w, 1, press('action'));
    expect(w.globals.score).toBe(11);
    expect(tail(w.logs, 'menu 2 at 2')).toBe(true);
    // Cancel (X / Escape) closes the menu: one key, one action.
    await steps(w, 1, press('escape'));
    expect(tail(w.logs, 'menu -1 at 2')).toBe(true);
    expect(w.paused).toBe(false);
    await steps(w, 10, { ...emptyInput(), down: new Set(['right']) });
    expect(player.x).toBeGreaterThan(x0);
  });

  it('works in headless playtests (menus answered by inputs)', async () => {
    const b = bundle({ scripts: { Title: "export default class Title extends Behaviour { onDraw(ui) { const c = ui.menu('t', ['New game', 'Quit'], 10, 10); if (c === 0) goto('b') } }" } });
    b.scenes.a.components = [{ type: 'script', name: 'Title' }];
    const r = await runPlaytest(b, { seconds: 0.5, inputs: [{ at: 0.1, key: 'action' }], evaluator: nodeEvaluator });
    expect(r.final.scene).toBe('b');
  });
});

describe('music and audio files', () => {
  it('plays scene music, crossfades, keeps the same track and validates names', async () => {
    const cmds: MusicCommand[] = [];
    const b = bundle({ scripts: { Dj: "export default class Dj extends Behaviour { async start() { await this.wait(0.1); music('boss', { fade: 2 }); music('boss'); setVolume('music', 0.5); await this.wait(0.1); stopMusic(0.5); log('now ' + game.music) } }" } });
    b.audio = { town: '', boss: '' };
    b.scenes.a.music = 'town';
    b.scenes.a.components = [{ type: 'script', name: 'Dj' }];
    b.scenes.b.music = 'town';
    const w = new World(b, { evaluator: nodeEvaluator, music: (c) => void cmds.push(c) });
    await steps(w, 20);
    expect(cmds).toEqual([
      { type: 'play', name: 'town', volume: 0.6, loop: true, fade: 1 },
      { type: 'play', name: 'boss', volume: 0.6, loop: true, fade: 2 },
      { type: 'volume', channel: 'music', value: 0.5 },
      { type: 'stop', fade: 0.5 },
    ]);
    expect(tail(w.logs, 'now ')).toBe(true);
    w.playMusic('town');
    w.gotoScene('b'); // same track: nothing new
    await steps(w, 2);
    expect(cmds.length).toBe(5);
    expect(() => w.playMusic('nope')).toThrow(/no audio "nope"/);

    b.scenes.a.music = 'ghost';
    b.scenes.a.events.push({ trigger: { type: 'start' }, conditions: [], actions: [{ type: 'sound', sound: 'town' }, { type: 'sound', sound: 'missing' }, { type: 'playMusic', music: 'boss' }] });
    const problems = validateGame(b.game, Object.values(b.scenes), new Set(['box']), undefined, undefined, ['town', 'boss']).map((p) => p.message);
    expect(problems).toContain('music "ghost" not found in audio/');
    expect(problems).toContain('unknown sound "missing"');
    expect(problems.some((m) => m.includes('"town"'))).toBe(false);
  });

  it('stores audio files and bundles them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spf-audio-'));
    try {
      const ws = new Workspace(dir);
      ws.writeAudio('theme', 'mp3', Buffer.from('ID3fake'));
      ws.writeAudio('theme', 'ogg', Buffer.from('OggS')); // same name replaces the file
      ws.writeAudio('jump2', '.wav', Buffer.from('RIFF'));
      expect(ws.listAudio().map((a) => [a.name, a.file, a.mime])).toEqual([['jump2', 'jump2.wav', 'audio/wav'], ['theme', 'theme.ogg', 'audio/ogg']]);
      expect(() => ws.writeAudio('x', 'exe', Buffer.from(''))).toThrow(/Unsupported/);
      fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify(normalizeGame({})));
      expect(loadGameBundle(ws).bundle.audio).toEqual({ jump2: '', theme: '' });
      expect(loadGameBundle(ws, { images: true }).bundle.audio!.theme).toBe(`data:audio/ogg;base64,${Buffer.from('OggS').toString('base64')}`);
      ws.removeAudio('jump2');
      expect(ws.listAudio().map((a) => a.name)).toEqual(['theme']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('input actions', () => {
  it('maps keys and pad buttons to named actions and remaps built-in keys', async () => {
    const b = bundle();
    b.game.actions = { attack: ['x', 'pad:b'], up: ['w', 'pad:up'] };
    b.game.objects[0].events.push({ trigger: { type: 'keyPressed', key: 'attack' }, conditions: [], actions: [{ type: 'add', target: 'score', value: '1' }] });
    const w = new World(b);
    await steps(w, 1);
    await steps(w, 3, { ...emptyInput(), down: new Set(['pad:b']), pressed: new Set(['pad:b']) });
    expect(w.globals.score).toBe(1); // pressed once while held
    expect(w.input.down.has('attack')).toBe(true);
    await steps(w, 1);
    await steps(w, 1, press('x'));
    expect(w.globals.score).toBe(2);
    // "up" is remapped: the plain up key no longer moves the player, W does.
    const p = w.actors[0];
    const y0 = p.y;
    await steps(w, 10, { ...emptyInput(), down: new Set(['up']) });
    expect(p.y).toBe(y0);
    await steps(w, 10, { ...emptyInput(), down: new Set(['w']) });
    expect(p.y).toBeLessThan(y0);
    expect(normalizeGame({ actions: { jump: 'Space, pad:A, ', 'bad name': ['x'] } }).actions).toEqual({ jump: ['space', 'pad:a'] });
    const g = createGame({ actions: { jump: ['space'] }, objects: [normalizeObject({ name: 'o', sprite: 'box', events: [{ trigger: { type: 'keyPressed', key: 'jump' }, conditions: [], actions: [] }, { trigger: { type: 'keyPressed', key: 'dash' }, conditions: [], actions: [] }] })] });
    const problems = validateGame(g, [createScene({ name: 's' })], new Set(['box'])).map((x) => x.message).filter((m) => m.includes('key'));
    expect(problems).toEqual(['unknown key "dash"']);
  });
});
