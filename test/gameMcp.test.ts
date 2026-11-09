import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { buildGameHtml, loadGameBundle } from '../src/server/game.js';
import { type EditorServer, startEditorServer } from '../src/server/http.js';

let dir: string;
let ws: Workspace;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (r.isError) throw new Error(`${name}: ${r.content.map((c) => c.text).join('\n')}`);
  return r;
}
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-game-'));
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

/** Builds a small platformer through the MCP tools only. */
async function buildPlatformer() {
  await call('create_sprite', { name: 'tiles', width: 32, height: 16, tile_width: 16, tile_height: 16, palette: 'pico8' });
  await call('draw_rect', { sprite: 'tiles', x: 0, y: 0, width: 16, height: 16, color: '#00e436', filled: true });
  await call('draw_rect', { sprite: 'tiles', x: 16, y: 0, width: 16, height: 16, color: '#ab5236', filled: true });
  await call('create_sprite', { name: 'hero', width: 12, height: 16 });
  await call('draw_rect', { sprite: 'hero', x: 0, y: 0, width: 12, height: 16, color: '#29adff', filled: true });
  await call('create_sprite', { name: 'coin', width: 8, height: 8 });
  await call('draw_ellipse', { sprite: 'coin', x: 0, y: 0, width: 8, height: 8, color: '#ffec27', filled: true });

  await call('set_game', { title: 'Coin Run', width: 160, height: 96, variables: { score: 0 } });
  await call('set_object', {
    name: 'player',
    sprite: 'hero',
    behaviors: [{ type: 'platformer', speed: 90, jump: 280 }, { type: 'camera' }],
    events: [
      { trigger: { type: 'collision', with: 'coin' }, actions: [{ type: 'add', target: 'score', value: '1' }, { type: 'destroy', target: 'other' }, { type: 'sound', sound: 'coin' }] },
      { trigger: { type: 'leftScene' }, actions: [{ type: 'restartScene' }] },
    ],
  });
  await call('set_object', { name: 'coin', sprite: 'coin', behaviors: [{ type: 'sine', amplitude: 2 }] });
  await call('set_object', { name: 'hud', text: '"COINS " + score', hud: true, text_color: '#ffffff' });
  await call('create_scene', { name: 'level1', cols: 30, rows: 6, tileset: 'tiles' });
  await call('paint_tiles', { scene: 'level1', layer: 'ground', x: 0, y: 5, rows: ['gggggggggggggggggggggggggggggg'], legend: { g: 0 } });
  await call('place_instances', { scene: 'level1', tiles: true, instances: [{ object: 'player', x: 1, y: 4 }, { object: 'coin', x: 5, y: 4 }, { object: 'coin', x: 8, y: 4 }, { object: 'coin', x: 11, y: 4 }] });
  await call('place_instances', { scene: 'level1', instances: [{ object: 'hud', x: 4, y: 4 }] });
  await call('set_events', { scene: 'level1', events: [{ trigger: { type: 'update' }, conditions: [{ type: 'expr', expr: 'count("coin") == 0' }], actions: [{ type: 'say', text: '"YOU WIN"', seconds: 0 }] }] });
}

describe('game MCP tools', () => {
  it('builds, validates, previews and playtests a platformer', async () => {
    await buildPlatformer();
    expect(textOf(await call('validate_game'))).toBe('No problems found.');

    const game = textOf(await call('get_game'));
    expect(game).toContain('Game "Coin Run": 160x96px');
    expect(game).toContain('WHEN collision with="coin"');

    const scene = textOf(await call('get_scene', { scene: 'level1', layer: 'ground' }));
    expect(scene).toContain('  5 000000000000000000000000000000');
    expect(scene).toContain('coin×3');

    const prev = await call('preview_scene', { scene: 'level1', grid: true });
    expect(prev.content.some((c) => c.type === 'image')).toBe(true);

    const tp = await call('tileset_preview', { sprite: 'tiles' });
    expect(textOf(tp)).toContain('2x1 = 2 tiles');

    const run = await call('playtest', { seconds: 4, inputs: [{ at: 0.2, key: 'right', duration: 3.5 }], sample_at: [1] });
    const out = textOf(run);
    expect(out).toContain('globals={"score":3}');
    expect(out).toContain('say: YOU WIN');
    expect(run.content.filter((c) => c.type === 'image')).toHaveLength(1);
  });

  it('reports bad events, renames objects with their references, and undoes', async () => {
    await buildPlatformer();
    await call('set_events', { object: 'player', events: [{ trigger: { type: 'keyPressed', key: 'q' }, actions: [{ type: 'gotoScene', scene: 'nowhere' }] }] });
    expect(textOf(await call('validate_game'))).toContain('no scene "nowhere"');
    await call('undo_game_change');
    expect(textOf(await call('validate_game'))).toBe('No problems found.');

    await call('set_object', { name: 'coin', new_name: 'gem' });
    const s = ws.loadScene('level1');
    expect(s.instances.filter((i) => i.object === 'gem')).toHaveLength(3);
    expect(JSON.stringify(ws.loadGame().objects[0].events)).toContain('"with":"gem"');
    expect(JSON.stringify(s.events)).toContain('count(\\"gem\\")');
  });

  it('sets, describes and clears tileset rules', async () => {
    await call('create_sprite', { name: 'tiles', width: 64, height: 16, tile_width: 16, tile_height: 16 });
    const r = textOf(await call('set_tileset_rules', { tileset: 'tiles', rules: [{ tile: 0, kind: 'grid', first: 2, size: 1 }, { tile: 1, kind: 'blob', first: 3 }], edges: [{ on: [1], from: [0], first: 3 }], paintable: 2 }));
    expect(r).toContain('2 rules (1 grid, 1 blob), 1 edge overlay, paintable 2');
    expect(ws.loadGame().tilesets?.tiles?.rules).toHaveLength(2);
    // Only the given fields change.
    await call('set_tileset_rules', { tileset: 'tiles', edges: null });
    expect(ws.loadGame().tilesets?.tiles?.edges).toBeUndefined();
    expect(ws.loadGame().tilesets?.tiles?.rules).toHaveLength(2);
    expect(textOf(await call('get_game'))).toContain('Tileset rules: tiles (2 rules');
    await call('set_tileset_rules', { tileset: 'tiles', clear: true });
    expect(ws.loadGame().tilesets).toBeUndefined();
    await expect(call('set_tileset_rules', { tileset: 'nope', clear: true })).rejects.toThrow('No sprite');
  });

  it('builds a standalone HTML page with the bundle embedded', async () => {
    await buildPlatformer();
    const { bundle } = loadGameBundle(ws, { images: true });
    expect(Object.keys(bundle.sprites).sort()).toEqual(['coin', 'hero', 'tiles']);
    expect(bundle.sprites.hero.image).toMatch(/^data:image\/png;base64,/);
    const html = buildGameHtml(bundle, 'console.log("runtime")</script>');
    expect(html).toContain('<title>Coin Run</title>');
    expect(html).toContain('window.SPRITIFER_GAME=');
    expect(html).not.toContain('runtime")</script>');
  });

  it('serves game and scene endpoints and the play page', async () => {
    await buildPlatformer();
    const srv: EditorServer = await startEditorServer(ws, 0);
    const addr = srv.server.address();
    const base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
    try {
      const g = (await (await fetch(base + '/api/game')).json()) as { title: string; saved: boolean };
      expect(g).toMatchObject({ title: 'Coin Run', saved: true });
      const scenes = (await (await fetch(base + '/api/scenes')).json()) as { name: string }[];
      expect(scenes.map((s) => s.name)).toEqual(['level1']);
      const sc = (await (await fetch(base + '/api/scenes/level1')).json()) as { instances: unknown[] };
      expect(sc.instances).toHaveLength(5);
      const png = await fetch(base + '/api/scenes/level1/preview.png');
      expect(png.headers.get('content-type')).toBe('image/png');
      const created = await fetch(base + '/api/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'level2', tileset: 'tiles', cols: 10, rows: 8 }) });
      expect(created.status).toBe(201);
      expect(ws.loadScene('level2').tileSize).toBe(16);
      const ren = await fetch(base + '/api/scenes/level2/rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'boss' }) });
      expect(ren.status).toBe(200);
      expect(ws.sceneExists('boss')).toBe(true);
      const play = await fetch(base + '/api/game/play.html');
      if (play.status === 200) expect(await play.text()).toContain('SPRITIFER_GAME');
      else expect((await play.json()).error).toMatch(/runtime not built/);
    } finally {
      await srv.close();
    }
  });
});

describe('bundling', () => {
  it('includes sprites that are only named in scripts', async () => {
    await buildPlatformer();
    await call('create_sprite', { name: 'boss_art', width: 8, height: 8 });
    expect(Object.keys(loadGameBundle(ws).bundle.sprites)).not.toContain('boss_art');
    await call('write_script', { name: 'ui', code: "onDraw((ui) => ui.sprite('boss_art', 0, 0, { scale: 2 }))" });
    expect(Object.keys(loadGameBundle(ws).bundle.sprites)).toContain('boss_art');
  });
});

describe('auto 2D-HD through MCP', () => {
  it('stores the game and scene settings and shows them in a playtest screenshot', async () => {
    await buildPlatformer();
    await call('set_game', { hd: { enabled: true, bloom: 1.5, blur_far: 0.4, focus_y: 0.5, haze_color: '#112233' } });
    expect(ws.loadGame().hd).toEqual({ enabled: true, bloom: 1.5, blurFar: 0.4, focusY: 0.5, hazeColor: '#112233' });
    const scene = ws.listScenes()[0].name;
    await call('update_scene', { scene, atmosphere: { ambient: '#ffffff', hd: { off: true } } });
    expect(ws.loadScene(scene).atmosphere?.hd).toEqual({ off: true });
    await call('update_scene', { scene, atmosphere: { ambient: '#ffffff', hd: { haze: 0.5 } } });
    const flat = await call('playtest', { seconds: 0.2 });
    const hd = await call('playtest', { seconds: 0.2, hd: true });
    const shot = (r: ToolResult) => r.content.filter((c) => c.type === 'image').at(-1)!.data;
    expect(shot(hd)).not.toEqual(shot(flat));
    await call('update_scene', { scene, hd_walls: [{ x: 1, y: 1, w: 2, mode: 'wall', rows: 2 }, { x: 0, y: 0, mode: 'flat' }] });
    expect(ws.loadScene(scene).hdCells).toEqual({ '1,1': 2, '2,1': 2, '0,0': 0 });
    expect(textOf(await call('get_scene', { scene }))).toContain('2D-HD wall corrections');
    await call('update_scene', { scene, hd_walls: [{ x: 0, y: 0, w: 3, h: 2, mode: 'auto' }] });
    expect(ws.loadScene(scene).hdCells).toBeUndefined();
    await call('set_game', { hd: null });
    expect(ws.loadGame().hd).toBeUndefined();
  });
});
