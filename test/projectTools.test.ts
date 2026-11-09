import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server/mcp.js';
import { Workspace } from '../src/server/store.js';
import { mergeUndo } from '../src/core/game/mergeUndo.js';
import { deleteGroup, extractRegion, listGroups, pasteRegion, regenerateGroup, scatter, scatterIntoGroup } from '../src/core/game/sceneOps.js';
import { createScene } from '../src/core/game/types.js';
import { saveEditorContext } from '../src/server/context.js';
import { undoChange } from '../src/server/history.js';
import { startEditorServer } from '../src/server/http.js';
import { ProjectRegistry } from '../src/server/projects.js';

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
let dir: string;
let ws: Workspace;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  const out = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(out);
  return out;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-tools-'));
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

async function game() {
  await call('create_sprite', { name: 'tiles', width: 32, height: 16, tile_width: 16, tile_height: 16 });
  await call('create_sprite', { name: 'hero', width: 16, height: 16 });
  await call('set_game', { variables: { gold: 3, unused: 0 }, start_scene: 'town' }).catch(() => call('set_game', { variables: { gold: 3, unused: 0 } }));
  await call('set_object', { name: 'player', sprite: 'hero', hitbox: { x: 0, y: 0, w: 16, h: 16 }, behaviors: [{ type: 'topdown', speed: 100 }] });
  await call('set_object', { name: 'tree', sprite: 'hero' });
  await call('set_object', { name: 'npc', sprite: 'hero', hitbox: { x: 0, y: 0, w: 16, h: 16 }, behaviors: [{ type: 'dialogue' }] });
  await call('set_object', { name: 'door', behaviors: [], hitbox: { x: 0, y: 0, w: 16, h: 16 }, events: [{ trigger: { type: 'interact' }, conditions: [], actions: [{ type: 'set', target: 'gold', value: 'gold + 1' }, { type: 'gotoScene', scene: 'cave' }] }] });
  await call('create_scene', { name: 'town', cols: 10, rows: 10, tileset: 'tiles' });
  await call('create_scene', { name: 'cave', cols: 10, rows: 10, tileset: 'tiles' });
  await call('create_scene', { name: 'lost', cols: 4, rows: 4, tileset: 'tiles' });
  await call('place_instances', { scene: 'town', instances: [{ object: 'player', x: 16, y: 16 }, { object: 'door', x: 32, y: 32, active_if: 'gold > 1' }] });
}

describe('find usages', () => {
  it('reports reads and writes of a variable across events, conditions, scripts and dialogues', async () => {
    await game();
    await call('write_script', { name: 'Money', code: 'export function pay() { vars.gold -= 1; return vars.gold }\n' });
    await call('write_dialogue', { file: 'shop', code: '=== shop\nself: You have {gold}.\n~ gold += 2\n' });
    const out = await call('find_usages', { kind: 'variable', name: 'gold' });
    expect(out).toContain('object door');
    expect(out).toContain('scene town');
    expect(out).toContain('script Money');
    expect(out).toContain('dialogue shop');
    expect(out).toMatch(/\[write\].*vars\.gold -= 1/);
    expect(out).toMatch(/\[read\].*You have/);
    expect(await call('find_usages', { kind: 'variable', name: 'nobody' })).toContain('No usages');
  });

  it('finds an object in instances and a scene in events', async () => {
    await game();
    expect(await call('find_usages', { kind: 'object', name: 'player' })).toContain('scene town');
    expect(await call('find_usages', { kind: 'scene', name: 'cave' })).toContain('object door');
  });
});

describe('world map and map checks', () => {
  it('connects scenes, names what nothing leads to and checks the map', async () => {
    await game();
    await call('place_instances', { scene: 'town', instances: [{ object: 'npc', x: 80, y: 80 }, { object: 'npc', x: 16, y: 48, name: 'Stuck' }] });
    // A wall all around tile (5, 5) cuts the first npc off; the second stands on a wall.
    await call('set_tile_layer', { scene: 'town', layer: 'walls', solid: true });
    await call('paint_tiles', { scene: 'town', layer: 'walls', rows: ['....###.', '....#.#.', '....###.', '.#......'].map((r) => r), legend: { '#': 0 }, x: 0, y: 0 });
    await call('paint_tiles', { scene: 'town', layer: 'walls', rect: { x: 4, y: 4, w: 3, h: 3 }, tile: 0 });
    await call('paint_tiles', { scene: 'town', layer: 'walls', rect: { x: 5, y: 5, w: 1, h: 1 }, tile: -1 });
    const map = await call('get_world_map');
    expect(map).toMatch(/town \[start\].*cave \(component\)/);
    expect(map).toMatch(/lost \[nothing leads here\]/);
    const checks = await call('validate_game');
    expect(checks).toContain('scene lost: nothing leads to this scene');
    expect(checks).toMatch(/Stuck.*stands on a solid tile/);
    expect(checks).toMatch(/npc .*cannot walk to/);
  });
});

describe('editor context and notes', () => {
  it('lets the MCP side read what the editor reported', async () => {
    await game();
    saveEditorContext(ws, { page: 'scene', scene: 'town', selection: [{ id: 'abc', object: 'tree', x: 1, y: 2 }], tile: { x: 3, y: 4 } });
    const out = await call('get_editor_context');
    expect(out).toContain('scene town');
    expect(out).toContain('abc');
    expect(out).toContain('tile 3,4');
  });

  it('keeps notes that both sides can answer and resolve', async () => {
    await game();
    const saved = await call('set_note', { scene: 'town', x: 10, y: 20, text: 'Più alberi qui' });
    const id = /- (\S+) town/.exec(saved)![1];
    expect(await call('get_editor_context')).toContain('Più alberi qui');
    await call('set_note', { id, resolved: true, reply: 'fatto' });
    expect(await call('get_editor_context')).toContain('No open notes');
  });
});

describe('saved tests', () => {
  it('passes and fails on what happens at the end', async () => {
    await game();
    await call('write_test', { name: 'move', seconds: 1, scene: 'town', inputs: [{ at: 0, key: 'right', duration: 0.5 }], expect: { scene: 'town', exprs: ['gold == 3'] } });
    expect(await call('run_tests')).toContain('1 of 1 test(s) passed');
    await call('write_test', { name: 'move', expect: { scene: 'cave', exprs: ['gold == 99'] } });
    const failed = await call('run_tests', { names: ['move'] });
    expect(failed).toContain('FAIL move');
    expect(failed).toContain('ended in scene "town"');
    expect(failed).toContain('not true at the end: gold == 99');
    expect(await call('list_tests')).toContain('move: 1.0s, 1 input(s)');
    await call('delete_test', { name: 'move' });
    expect(await call('list_tests')).toContain('No tests');
  });

  it('holds a recorded key for exactly the recorded frames', async () => {
    await game();
    const STEP = 1 / 60;
    await call('write_test', { name: 'frames', seconds: 40 * STEP, scene: 'town', inputs: [{ at: 3 * STEP, key: 'right', duration: 7 * STEP }], expect: { exprs: ['count("player") == 1'] } });
    const { runPlaytest } = await import('../src/core/game/engine.js');
    const { loadGameBundle } = await import('../src/server/game.js');
    const { bundle } = loadGameBundle(ws);
    const short = await runPlaytest(bundle, { seconds: 40 * STEP, scene: 'town', inputs: [{ at: 3 * STEP, key: 'right', duration: 7 * STEP }] });
    const shorter = await runPlaytest(bundle, { seconds: 40 * STEP, scene: 'town', inputs: [{ at: 3 * STEP, key: 'right', duration: 6 * STEP }] });
    const x = (r: typeof short) => r.final.actors.find((a) => a.object === 'player')!.x;
    expect(x(short)).toBeGreaterThan(x(shorter));
  });
});

describe('selective undo', () => {
  it('merges: restores only what the change did', () => {
    const before = { rev: 'a', instances: [{ id: '1', x: 0 }, { id: '2', x: 0 }], layers: [{ name: 'g', tiles: [1, 1, 1] }], note: 'x' };
    const after = { rev: 'b', instances: [{ id: '1', x: 5 }, { id: '2', x: 0 }, { id: '3', x: 9 }], layers: [{ name: 'g', tiles: [2, 2, 1] }], note: 'x' };
    const current = { rev: 'c', instances: [{ id: '1', x: 5 }, { id: '2', x: 7 }, { id: '3', x: 9 }], layers: [{ name: 'g', tiles: [2, 3, 4] }], note: 'y' };
    const r = mergeUndo(before, after, current);
    expect(r.value).toEqual({ rev: 'c', instances: [{ id: '1', x: 0 }, { id: '2', x: 7 }], layers: [{ name: 'g', tiles: [1, 3, 4] }], note: 'y' });
    expect(r.conflicts).toEqual(['layers[g].tiles: 1 cell(s) changed again']);
  });

  it('puts back what a change removed', () => {
    const r = mergeUndo({ list: [{ id: 'a' }, { id: 'b' }] }, { list: [{ id: 'a' }] }, { list: [{ id: 'a' }, { id: 'c' }] });
    expect(r.value).toEqual({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  });

  it('undoes one MCP change and keeps a later editor change', async () => {
    await game();
    await call('place_instances', { scene: 'town', instances: [{ object: 'tree', x: 64, y: 64 }] });
    const entry = ws.history.list({ kind: 'scene', name: 'town', limit: 1 })[0];
    const s = ws.loadScene('town');
    s.background = '#112233';
    ws.saveScene(s, 'editor');
    const list = await call('history', { kind: 'scene', name: 'town' });
    expect(list).toMatch(/claude\s+scene town: \+1 instance/);
    expect(list).toMatch(/editor\s+scene town/);
    await call('undo_game_change', { id: entry.id });
    const now = ws.loadScene('town');
    expect(now.instances.some((i) => i.object === 'tree')).toBe(false);
    expect(now.background).toBe('#112233');
    await expect(call('undo_game_change', { id: entry.id })).rejects.toThrow(/already been undone/);
  });

  it('undoes the last change of the author by default, and an undo can be undone', async () => {
    await game();
    await call('update_scene', { scene: 'town', background: '#010203' });
    await call('undo_game_change');
    expect(ws.loadScene('town').background).not.toBe('#010203');
    const undo = ws.history.list({ kind: 'scene', name: 'town', limit: 1 })[0];
    expect(undo.undoOf).toBeTruthy();
    undoChange(ws, undo.id, 'editor');
    expect(ws.loadScene('town').background).toBe('#010203');
  });

  it('refuses a script edited since, and folds editor autosaves', async () => {
    await game();
    await call('write_script', { name: 'A', code: 'export const a = 1\n' });
    const created = ws.history.list({ kind: 'script', limit: 1 })[0];
    ws.writeScript('A', 'export const a = 2\n', 'editor');
    expect(() => undoChange(ws, created.id, 'editor')).toThrow(/edited since/);
    const count = () => ws.history.list({ kind: 'scene', name: 'cave' }).length;
    const n = count();
    for (const bg of ['#000001', '#000002', '#000003']) {
      const s = ws.loadScene('cave');
      s.background = bg;
      ws.saveScene(s, 'editor');
    }
    expect(count()).toBe(n + 1);
  });

  it('keeps its files out of git', async () => {
    await game();
    expect(fs.readFileSync(path.join(dir, '.spritifer', '.gitignore'), 'utf8').trim()).toBe('*');
  });
});

describe('whole parts of a map', () => {
  const size = () => ({ w: 16, h: 16 });
  const scene = () => {
    const s = createScene({ name: 'a', cols: 20, rows: 20, tileSize: 16 });
    s.layers[0].solid = true;
    s.layers[0].tiles.fill(-1);
    return s;
  };

  it('scatters the same way for a seed, away from solid tiles and at a distance', () => {
    const a = scene();
    const b = scene();
    for (let i = 0; i < 200; i++) a.layers[0].tiles[i] = 0;
    for (let i = 0; i < 200; i++) b.layers[0].tiles[i] = 0;
    const recipe = { items: [{ object: 't' }], count: 25, seed: 7, minDistance: 24 };
    const made = scatter(a, recipe, size);
    expect(made.map((i) => [i.x, i.y])).toEqual(scatter(b, recipe, size).map((i) => [i.x, i.y]));
    expect(made.length).toBe(25);
    for (const i of made) expect(Math.floor((i.y + 15) / 16)).toBeGreaterThanOrEqual(9);
    for (const i of made) for (const j of made) if (i !== j) expect(Math.hypot(i.x - j.x, i.y - j.y)).toBeGreaterThanOrEqual(23);
  });

  it('redoes a group inside its area and leaves the rest', () => {
    const s = scene();
    s.instances.push({ id: 'keep', object: 'hero', x: 300, y: 300 }, { id: 'hand', object: 't', x: 280, y: 280, group: 'trees' });
    const first = scatterIntoGroup(s, 'trees', { items: [{ object: 't' }], region: { x: 0, y: 0, w: 8, h: 8 }, count: 6, seed: 1 }, size);
    const redone = regenerateGroup(s, 'trees', size, 99);
    expect(redone.length).toBe(6);
    expect(s.instances.some((i) => i.id === first[0].id)).toBe(false);
    expect(s.instances.some((i) => i.id === 'keep')).toBe(true);
    expect(s.instances.some((i) => i.id === 'hand')).toBe(true);
    expect(listGroups(s)).toEqual([{ name: 'trees', count: 7, scatters: 1 }]);
    expect(deleteGroup(s, 'trees')).toBe(7);
    expect(s.groups).toBeUndefined();
  });

  it('copies tiles and instances, skipping empty cells', () => {
    const s = scene();
    s.layers[0].tiles[0] = 5;
    s.layers[0].tiles[22] = 2;
    s.instances.push({ id: 'x', object: 't', x: 8, y: 8, group: 'g' });
    const stamp = extractRegion(s, { x: 0, y: 0, w: 2, h: 2 });
    const { instances, tiles } = pasteRegion(s, stamp, 1, 1, { group: 'copy' });
    expect(tiles).toBe(1);
    expect(s.layers[0].tiles[21]).toBe(5);
    expect(s.layers[0].tiles[22]).toBe(2);
    expect(instances[0]).toMatchObject({ object: 't', x: 24, y: 24, group: 'copy' });
    expect(instances[0].id).not.toBe('x');
  });

  it('works through MCP and survives a save', async () => {
    await game();
    const out = await call('scatter_instances', { scene: 'cave', group: 'trees', items: [{ object: 'tree' }], count: 5, seed: 3 });
    expect(out).toContain('Placed 5');
    expect(await call('scene_group', { scene: 'cave', action: 'list' })).toContain('trees: 5 instance(s), 1 scatter(s)');
    expect(await call('scene_group', { scene: 'cave', action: 'regenerate', group: 'trees', seed: 4 })).toContain('5 instance');
    expect(await call('copy_scene_region', { scene: 'cave', region: { x: 0, y: 0, w: 10, h: 10 }, to_scene: 'lost', x: 0, y: 0, instances: true })).toMatch(/\d+ instance/);
    expect(ws.loadScene('cave').groups?.trees.scatters?.length).toBe(1);
    await call('scene_group', { scene: 'cave', action: 'rename', group: 'trees', to: 'pines' });
    expect(ws.loadScene('cave').instances.every((i) => i.group === 'pines')).toBe(true);
    await call('update_instances', { scene: 'town', object: 'player', group: 'heroes' });
    expect(ws.loadScene('town').instances.find((i) => i.object === 'player')!.group).toBe('heroes');
  });
});

describe('the editor has the same features', () => {
  it('serves usages, world, context, notes, tests and history', async () => {
    await game();
    const srv = await startEditorServer(ws, 0, '127.0.0.1', { registry: new ProjectRegistry({ root: dir, defaultDir: ws.dir }) });
    const port = (srv.server.address() as { port: number }).port;
    const api = async (method: string, url: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await r.json() as Record<string, unknown>;
      if (!r.ok) throw new Error(String(data.error));
      return data as never;
    };
    try {
      expect(((await api('GET', '/usages?kind=variable&name=gold')) as unknown[]).length).toBeGreaterThan(1);
      const w = await api('GET', '/world') as { world: { unreachable: string[] }; minimaps: Record<string, string> };
      expect(w.world.unreachable).toEqual(['lost']);
      expect(w.minimaps.town.length).toBe(100);
      await api('POST', '/context', { page: 'scene', scene: 'cave' });
      await api('POST', '/play-log', { lines: ['ERROR boom'], reset: true });
      const ctx = await call('get_editor_context');
      expect(ctx).toContain('scene cave');
      expect(ctx).toContain('ERROR boom');
      const n = await api('POST', '/notes', { scene: 'town', x: 1, y: 2, text: 'qui' }) as { id: string; author: string };
      expect(n.author).toBe('user');
      await api('PUT', `/notes/${n.id}`, { resolved: true });
      await api('PUT', '/tests/one', { seconds: 0.5, scene: 'town', inputs: [], expect: { scene: 'town' } });
      const results = await api('POST', '/tests/_run', {}) as { passed: boolean }[];
      expect(results[0].passed).toBe(true);
      const scene = ws.loadScene('cave');
      scene.background = '#123456';
      await api('PUT', '/scenes/cave', scene);
      const list = await api('GET', '/history?author=editor') as { id: string; name: string }[];
      expect(list[0].name).toBe('cave');
      await api('POST', `/history/${list[0].id}/undo`, {});
      expect(ws.loadScene('cave').background).not.toBe('#123456');
    } finally {
      await srv.close();
    }
  });
});
