import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { NULL_RENDERER, renderWorld, runPlaytest } from '../src/core/game/engine.js';
import { type GameBundle, type SpriteAsset, createGame, createScene, normalizeObject } from '../src/core/game/types.js';
import { VfxSystem, simulateVfx } from '../src/core/game/vfx.js';
import { VFX_NODES, VFX_TEMPLATES, checkVfx, normalizeVfx, vfxHasCycle, vfxInputErrors, vfxWouldCycle } from '../src/core/game/vfxGraph.js';
import { createMcpServer } from '../src/server/mcp.js';
import { BitmapRenderer, loadGameBundle } from '../src/server/game.js';
import { nodeEvaluator } from '../src/server/scripts.js';
import { Workspace } from '../src/server/store.js';

const graph = (nodes: object[], edges: object[]) => normalizeVfx({ name: 'fx', nodes, edges }, 'fx');
const box = (name: string, frames = 1): SpriteAsset => ({ name, width: 16, height: 16, frames: Array.from({ length: frames }, (_, i) => ({ x: i * 16, y: 0, w: 16, h: 16, duration: 100 })), tags: [], grid: null });

describe('vfx graph format', () => {
  it('adds a Start, drops bad wires and clamps params', () => {
    const g = graph(
      [{ id: 'a', type: 'ring', params: { duration: 99, colors: ['#FFF', 'nope'], bogus: 1 } }, { id: 'a', type: 'delay' }, { id: 'b', type: 'nope' }],
      [{ from: 'start', to: 'a' }, { from: 'a', to: 'missing' }, { from: 'a', to: 'a' }, { from: 'start', to: 'a' }],
    );
    expect(g.nodes.map((n) => n.id)).toEqual(['start', 'a']);
    expect(g.edges).toEqual([{ from: 'start', to: 'a' }]);
    expect(g.nodes[1].params).toEqual({ duration: 10, colors: ['#fff'] });
  });

  it('places new nodes in columns by depth and keeps positions it was given', () => {
    const g = graph([{ id: 'a', type: 'delay' }, { id: 'b', type: 'delay', x: 500, y: 40 }, { id: 'c', type: 'delay' }], [{ from: 'start', to: 'a' }, { from: 'a', to: 'c' }]);
    const at = Object.fromEntries(g.nodes.map((n) => [n.id, n.x]));
    expect(at.start).toBeLessThan(at.a);
    expect(at.a).toBeLessThan(at.c);
    expect(at.b).toBe(500);
  });

  it('finds loops, disconnected nodes and bad references', () => {
    const loop = { edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] };
    expect(vfxHasCycle(loop)).toBe(true);
    expect(vfxWouldCycle({ edges: [{ from: 'a', to: 'b' }] }, 'b', 'a')).toBe(true);
    expect(vfxWouldCycle({ edges: [{ from: 'a', to: 'b' }] }, 'a', 'b')).toBe(false);
    const g = graph([{ id: 'lost', type: 'delay' }, { id: 'pic', type: 'sprite', params: { sprite: 'ghost' } }, { id: 's', type: 'sound', params: { sound: 'nope' } }], [{ from: 'start', to: 'pic' }, { from: 'start', to: 's' }]);
    const problems = checkVfx(g, { sprites: new Map(), sounds: ['hit'] }).join('\n');
    expect(problems).toContain('"lost"');
    expect(problems).toContain('sprite "ghost" not found');
    expect(problems).toContain('unknown sound "nope"');
  });

  it('reports what normalizing would quietly drop', () => {
    const errors = vfxInputErrors([{ id: 'a', type: 'ring', params: { radiuss: 1 } }, { id: 'b', type: 'ring', params: { blend: 'neon' } }, { id: 'c', type: 'wat' }]);
    expect(errors).toHaveLength(3);
  });

  it('ships valid templates that all finish', () => {
    for (const t of VFX_TEMPLATES) {
      const g = normalizeVfx({ name: t.id, ...t.graph }, t.id);
      expect(g.nodes.length, t.id).toBe(t.graph.nodes.length);
      expect(g.edges.length, t.id).toBe(t.graph.edges.length);
      expect(checkVfx(g), t.id).toEqual([]);
      const tl = simulateVfx(g);
      expect(tl.duration, t.id).toBeGreaterThan(0);
      expect(tl.duration, t.id).toBeLessThan(5);
    }
  });

  it('describes defaults that are valid for their own param', () => {
    for (const n of VFX_NODES) expect(vfxInputErrors([{ id: 'x', type: n.type, params: Object.fromEntries(n.params.filter((p) => !(p.type === 'sprite')).map((p) => [p.name, p.default])) }]), n.type).toEqual([]);
  });
});

describe('vfx playback', () => {
  it('runs nodes in wire order, in parallel, and delays', () => {
    const g = graph(
      [{ id: 'w', type: 'delay', params: { seconds: 0.2 } }, { id: 'ring', type: 'ring', params: { duration: 0.1 } }, { id: 'after', type: 'message', params: { message: 'late' } }, { id: 'now', type: 'message', params: { message: 'early' } }],
      [{ from: 'start', to: 'w' }, { from: 'start', to: 'now' }, { from: 'w', to: 'ring' }, { from: 'ring', to: 'after' }],
    );
    const tl = simulateVfx(g);
    expect(tl.messages.map((m) => m.message)).toEqual(['early', 'late']);
    expect(tl.messages[0].time).toBe(0);
    expect(tl.messages[1].time).toBeCloseTo(0.3, 1);
  });

  it('repeats each, then done', () => {
    const g = graph(
      [{ id: 'r', type: 'repeat', params: { count: 3, interval: 0.1 } }, { id: 'e', type: 'message', params: { message: 'each' } }, { id: 'd', type: 'message', params: { message: 'done' } }],
      [{ from: 'start', to: 'r' }, { from: 'r', port: 'each', to: 'e' }, { from: 'r', port: 'done', to: 'd' }],
    );
    const tl = simulateVfx(g);
    expect(tl.messages.map((m) => m.message)).toEqual(['each', 'each', 'each', 'done']);
  });

  it('flies a projectile for distance / speed and homes in on a moving target', () => {
    const g = graph([{ id: 'p', type: 'projectile', params: { speed: 100, forward: 0, trail: 0 } }, { id: 'm', type: 'message' }], [{ from: 'start', to: 'p' }, { from: 'p', to: 'm' }]);
    expect(simulateVfx(g, { source: { x: 0, y: 0 }, target: { x: 100, y: 0 } }).messages[0].time).toBeCloseTo(1, 1);
    let hit: { x: number; y: number } | null = null;
    const sys = new VfxSystem({ message: (_m, d) => (hit = { x: d.x, y: d.y }) });
    let tx = 50;
    sys.play(g, { source: { x: 0, y: 0 }, target: () => ({ x: tx, y: 0 }) });
    for (let i = 0; i < 80 && !hit; i++) {
      tx += 0.25;
      sys.tick(1 / 60);
    }
    expect(hit!.x).toBeCloseTo(tx, 0);
  });

  it('speed and stop', async () => {
    const g = graph([{ id: 'w', type: 'delay', params: { seconds: 1 } }, { id: 'm', type: 'message' }], [{ from: 'start', to: 'w' }, { from: 'w', to: 'm' }]);
    expect(simulateVfx(g, { speed: 2 }).messages[0].time).toBeCloseTo(1, 1);
    expect(simulateVfx(g, { speed: 2 }).duration).toBeCloseTo(0.5, 1);
    const sys = new VfxSystem();
    const run = sys.play(g, { source: { x: 0, y: 0 } });
    sys.clear();
    await run.done;
    expect(run.finished).toBe(true);
  });

  it('survives a hand-edited loop', () => {
    const g = normalizeVfx({ name: 'x', nodes: [{ id: 'start', type: 'start' }, { id: 'a', type: 'delay', params: { seconds: 0.01 } }, { id: 'b', type: 'delay', params: { seconds: 0.01 } }], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] }, 'x');
    expect(simulateVfx(g).duration).toBeLessThan(10);
  });

  it('draws every node type with a renderer and tints colors', () => {
    const nodes = VFX_NODES.filter((n) => n.type !== 'start').map((n) => ({ id: n.type, type: n.type, params: n.type === 'sprite' || n.type === 'projectile' ? { sprite: 'box' } : {} }));
    const g = graph(nodes, nodes.map((n) => ({ from: 'start', to: n.id })));
    const colors = new Set<string>();
    const sys = new VfxSystem({ asset: (n) => (n === 'box' ? box('box', 2) : undefined) });
    sys.play(g, { source: { x: 40, y: 40 }, target: { x: 120, y: 40 }, tint: '#ff0000' });
    const r = { ...NULL_RENDERER, rect: (_x: number, _y: number, _w: number, _h: number, c: string) => void colors.add(c) };
    for (let i = 0; i < 6; i++) {
      sys.tick(1 / 60);
      sys.draw(r, 0, 0, 1, false);
      sys.draw(r, 0, 0, 1, true);
      sys.drawScreen(r, 200, 100);
    }
    expect(colors.size).toBeGreaterThan(0);
    // The default slash is white and blue: tinted red, no channel may be bluer than it is red.
    for (const c of colors) expect(parseInt(c.slice(5, 7), 16), c).toBeLessThanOrEqual(parseInt(c.slice(1, 3), 16));
  });

  it('adds light in the bitmap renderer', () => {
    const r = new BitmapRenderer(2, 1, new Map());
    r.clear('#102030');
    r.rect(0, 0, 1, 1, '#404040', 1, 'add');
    expect([...r.out.data.slice(0, 3)]).toEqual([0x50, 0x60, 0x70]);
    expect([...r.out.data.slice(4, 7)]).toEqual([0x10, 0x20, 0x30]);
  });
});

function bundle(opts: { scripts?: Record<string, string>; objects?: object[]; vfx?: GameBundle['vfx']; sprites?: Record<string, SpriteAsset> } = {}): GameBundle {
  const a = createScene({ name: 'a', cols: 20, rows: 12, tileSize: 16 });
  a.instances.push({ id: 'p', object: 'player', x: 40, y: 40 }, { id: 'f', object: 'foe', x: 140, y: 40 });
  const game = createGame({ startScene: 'a', variables: { hits: 0 }, objects: [normalizeObject({ name: 'player', sprite: 'box' }), normalizeObject({ name: 'foe', sprite: 'box' }), ...(opts.objects ?? []).map(normalizeObject)] });
  return { game, scenes: { a }, sprites: { box: box('box'), ...opts.sprites }, scripts: opts.scripts ?? {}, vfx: opts.vfx };
}

const shot = graph(
  [{ id: 'w', type: 'delay', params: { seconds: 0.1 } }, { id: 'hit', type: 'message', params: { message: 'hit' } }, { id: 'stop', type: 'hitstop', params: { seconds: 0.1 } }],
  [{ from: 'start', to: 'w' }, { from: 'w', to: 'hit' }, { from: 'hit', to: 'stop' }],
);

describe('vfx in the game', () => {
  it('awaits vfx() from scripts and delivers its messages', async () => {
    const b = bundle({
      vfx: { shot },
      objects: [{ name: 'gun', behaviors: [{ type: 'script', name: 'Gun' }] }],
      scripts: { Gun: `export default class Gun extends Behaviour { async start() { this.on('hit', (d) => log('on hit ' + d.effect)); await vfx('shot', this.self, find('foe')[0]); log('finished') } }` },
    });
    b.scenes.a.instances.push({ id: 'g', object: 'gun', x: 0, y: 0 });
    const r = await runPlaytest(b, { seconds: 0.4, evaluator: nodeEvaluator });
    const logs = r.logs.map((l) => l.split('] ').at(-1));
    expect(logs).toContain('on hit fx');
    expect(logs.indexOf('finished')).toBeGreaterThan(logs.indexOf('on hit fx'));
  });

  it('plays from the event action and from a frame event', async () => {
    const swing = box('swing', 3);
    swing.frames[1].events = ['vfx:shot'];
    swing.tags = [{ name: 'attack', from: 0, to: 2, direction: 'forward' }];
    const b = bundle({
      vfx: { shot },
      sprites: { swing },
      objects: [
        { name: 'hero', sprite: 'swing', animation: 'attack' },
        { name: 'ctl', events: [{ trigger: { type: 'created' }, conditions: [], actions: [{ type: 'vfx', effect: 'shot', from: 'self', to: 'none' }] }, { trigger: { type: 'message', message: 'hit' }, conditions: [], actions: [{ type: 'add', target: 'hits', value: '1' }] }] },
      ],
    });
    b.scenes.a.instances.push({ id: 'h', object: 'hero', x: 0, y: 0 }, { id: 'c', object: 'ctl', x: 0, y: 0 });
    const r = await runPlaytest(b, { seconds: 0.6, evaluator: nodeEvaluator });
    expect(r.final.globals.hits).toBeGreaterThanOrEqual(2);
  });

  it('hit stop freezes instances while effects play, and ends', async () => {
    const stop = graph([{ id: 's', type: 'hitstop', params: { seconds: 0.25 } }, { id: 'm', type: 'message', params: { message: 'over' } }, { id: 'w', type: 'delay', params: { seconds: 0.1 } }], [{ from: 'start', to: 's' }, { from: 'start', to: 'w' }, { from: 'w', to: 'm' }]);
    const plain = bundle({ vfx: { stop }, objects: [{ name: 'mover', sprite: 'box', behaviors: [{ type: 'script', name: 'Move' }] }], scripts: { Move: `export default class Move extends Behaviour { update(dt) { this.self.x += 60 * dt } }` } });
    plain.scenes.a.instances.push({ id: 'm', object: 'mover', x: 0, y: 0 });
    const frozen = bundle({ vfx: { stop }, objects: [{ name: 'mover', sprite: 'box', behaviors: [{ type: 'script', name: 'Move' }] }], scripts: { Move: `export default class Move extends Behaviour { start() { vfx('stop', this.self) } update(dt) { this.self.x += 60 * dt } }` } });
    frozen.scenes.a.instances.push({ id: 'm', object: 'mover', x: 0, y: 0 });
    const a = await runPlaytest(plain, { seconds: 0.5, evaluator: nodeEvaluator });
    const b = await runPlaytest(frozen, { seconds: 0.5, evaluator: nodeEvaluator });
    const xOf = (r: typeof a) => r.final.actors.find((i) => i.object === 'mover')!.x;
    // 0.25 s at 60 px/s = 15 px lost, give or take the frame it starts on.
    expect(xOf(a) - xOf(b)).toBeGreaterThanOrEqual(14);
    expect(xOf(a) - xOf(b)).toBeLessThanOrEqual(17);
    expect(xOf(b)).toBeGreaterThan(0);
  });

  it('does not touch the gameplay random sequence', async () => {
    const noisy = graph([{ id: 'p', type: 'particles', params: { count: 50 } }], [{ from: 'start', to: 'p' }]);
    const roll = (play: string) => {
      const b = bundle({ vfx: { noisy }, objects: [{ name: 'roller', behaviors: [{ type: 'script', name: 'R' }] }], scripts: { R: `export default class R extends Behaviour { start() { ${play}; log('roll ' + random()) } }` } });
      b.scenes.a.instances.push({ id: 'r', object: 'roller', x: 0, y: 0 });
      return runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator }).then((r) => r.logs.find((l) => l.includes('roll')));
    };
    expect(await roll("vfx('noisy', { x: 1, y: 1 })")).toBe(await roll(''));
  });

  it('draws front effects over the scene lighting, so they glow in the dark', async () => {
    const orb = graph([{ id: 'r', type: 'ring', params: { duration: 1 } }], [{ from: 'start', to: 'r' }]);
    const b = bundle({ vfx: { orb }, objects: [{ name: 'x', behaviors: [{ type: 'script', name: 'X' }] }], scripts: { X: `export default class X extends Behaviour { start() { vfx('orb', { x: 60, y: 60 }) } }` } });
    b.scenes.a.atmosphere = { ambient: '#202030' } as never;
    b.scenes.a.instances.push({ id: 'x', object: 'x', x: 0, y: 0 });
    const r = await runPlaytest(b, { seconds: 0.2, evaluator: nodeEvaluator });
    const calls: string[] = [];
    renderWorld(r.world, { ...NULL_RENDERER, lighting: () => void calls.push('lighting'), rect: (_x, _y, _w, _h, _c, _a, blend) => void (blend === 'add' && calls.push('glow')) });
    expect(calls.indexOf('lighting')).toBeGreaterThanOrEqual(0);
    expect(calls.lastIndexOf('glow')).toBeGreaterThan(calls.indexOf('lighting'));
    expect(calls.indexOf('glow')).toBeGreaterThan(calls.indexOf('lighting'));
  });

  it('logs an unknown effect instead of crashing', async () => {
    const b = bundle({ objects: [{ name: 'x', behaviors: [{ type: 'script', name: 'X' }] }], scripts: { X: `export default class X extends Behaviour { async start() { await vfx('nope', this.self); log('after') } }` } });
    b.scenes.a.instances.push({ id: 'x', object: 'x', x: 0, y: 0 });
    const r = await runPlaytest(b, { seconds: 0.1, evaluator: nodeEvaluator });
    expect(r.logs.some((l) => l.includes('no effect "nope"'))).toBe(true);
    expect(r.logs.some((l) => l.endsWith('after'))).toBe(true);
  });
});

describe('vfx in screens drawn by scripts', () => {
  const bundle = (draw: string, start = ''): GameBundle => ({
    game: createGame('t'),
    scenes: { main: createScene('main', 20, 12) },
    sprites: {},
    scripts: { hud: `onStart(() => { ${start} vfx('boom', { x: 40, y: 40 }) })\nonDraw((ui) => { ${draw} })` },
    vfx: { boom: graph([{ id: 'f', type: 'flash', params: { duration: 5, color: '#00ff00' } }], [{ from: 'start', to: 'f' }]) },
  });

  it('ui.effects draws them where the script asks, once', async () => {
    const { world } = await runPlaytest(bundle("ui.rect(0, 0, ui.width, ui.height, '#123456'); ui.effects('screen')"), { seconds: 0.2, evaluator: nodeEvaluator });
    renderWorld(world, NULL_RENDERER); // The first draw tells the game that the script places the effects.
    const order: string[] = [];
    renderWorld(world, { ...NULL_RENDERER, rect: (_x, _y, _w, _h, color) => order.push(color) });
    expect(order.filter((c) => c === '#00ff00')).toHaveLength(1);
    expect(order.indexOf('#00ff00')).toBeGreaterThan(order.indexOf('#123456'));
  });

  it('without ui.effects the game draws them itself', async () => {
    const { world } = await runPlaytest(bundle("ui.rect(0, 0, 4, 4, '#123456')"), { seconds: 0.2, evaluator: nodeEvaluator });
    renderWorld(world, NULL_RENDERER);
    const order: string[] = [];
    renderWorld(world, { ...NULL_RENDERER, rect: (_x, _y, _w, _h, color) => order.push(color) });
    expect(order.filter((c) => c === '#00ff00')).toHaveLength(1);
    expect(order.indexOf('#00ff00')).toBeLessThan(order.indexOf('#123456'));
  });

  it('ui.shake reports the camera shake, and nothing without one', async () => {
    const seen = async (start: string) => {
      const { world } = await runPlaytest(bundle('vars.sx = Math.max(Number(vars.sx) || 0, Math.abs(ui.shake.x), Math.abs(ui.shake.y))', start), { seconds: 0.1, evaluator: nodeEvaluator });
      for (let i = 0; i < 20; i++) renderWorld(world, NULL_RENDERER);
      expect(world.scripts.errors).toEqual([]);
      return Number(world.snapshot().globals.sx);
    };
    expect(await seen('')).toBe(0);
    expect(await seen('shake(6, 30);')).toBeGreaterThan(0);
  });
});

describe('vfx through MCP', () => {
  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
  const raw = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    if (r.isError) throw new Error(r.content.map((c) => c.text).join('\n'));
    return r;
  };
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-vfx-'));
    ws = new Workspace(dir);
    const server = createMcpServer(ws);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes, tweaks, previews and deletes an effect', async () => {
    await call('write_vfx', { effect: 'boom', template: 'impact' });
    expect(fs.existsSync(path.join(dir, 'vfx', 'boom.json'))).toBe(true);
    expect(textOf(await call('list_vfx'))).toContain('boom');

    await call('update_vfx', { effect: 'boom', set: { wave: { radius: [2, 50] } }, add_nodes: [{ id: 'later', type: 'delay', params: { seconds: 0.2 } }, { id: 'x', type: 'message', params: { message: 'end' } }], connect: [{ from: 'wave', to: 'later' }, { from: 'later', to: 'x' }], remove_nodes: ['stop'] });
    const g = ws.loadVfx('boom');
    expect(g.nodes.find((n) => n.id === 'wave')!.params.radius).toEqual([2, 50]);
    expect(g.nodes.some((n) => n.id === 'stop')).toBe(false);
    expect(g.edges.some((e) => e.from === 'stop' || e.to === 'stop')).toBe(false);

    const p = await call('preview_vfx', { effect: 'boom', frames: 4 });
    expect(p.content.some((c) => c.type === 'image' && (c.data?.length ?? 0) > 100)).toBe(true);
    expect(textOf(p)).toContain('"end" at');

    await call('update_vfx', { effect: 'boom', rename_to: 'bam' });
    expect(ws.vfxExists('boom')).toBe(false);
    await call('delete_vfx', { effect: 'bam' });
    expect(ws.listVfx()).toEqual([]);
  });

  it('refuses mistakes instead of dropping them', async () => {
    const bad = await raw('write_vfx', { effect: 'x', nodes: [{ id: 'r', type: 'ring', params: { raduis: 3 } }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('no param "raduis"');
    const loop = await raw('write_vfx', { effect: 'x', nodes: [{ id: 'a', type: 'delay' }, { id: 'b', type: 'delay' }], edges: [{ from: 'start', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    expect(loop.isError).toBe(true);
    expect(ws.vfxExists('x')).toBe(false);
  });

  it('warns about problems, flags missing effects and bundles what effects use', async () => {
    await call('create_sprite', { name: 'bolt', width: 8, height: 8 });
    const saved = await call('write_vfx', { effect: 'zap', nodes: [{ id: 'p', type: 'projectile', params: { sprite: 'bolt' } }, { id: 'lost', type: 'delay' }], edges: [{ from: 'start', to: 'p' }] });
    expect(textOf(saved)).toContain('"lost"');
    await call('set_object', { name: 'o', events: [{ trigger: { type: 'created' }, actions: [{ type: 'vfx', effect: 'missing' }] }] });
    await call('create_scene', { name: 'a', cols: 4, rows: 4 });
    expect(textOf(await call('validate_game'))).toContain('no effect "missing"');
    const { bundle: b } = loadGameBundle(ws);
    expect(Object.keys(b.vfx ?? {})).toEqual(['zap']);
    expect(Object.keys(b.sprites)).toContain('bolt');
  });
});
