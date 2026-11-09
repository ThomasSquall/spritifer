/** What the editor can do must be doable through MCP and vice versa: the operations added to close those gaps. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { type EditorServer, startEditorServer } from '../src/server/http.js';
import { pixelizeToLayer } from '../src/core/reference.js';
import { compositeFrame, createSprite, getCel } from '../src/core/sprite.js';
import { formatLintReport, lintBitmap } from '../src/core/shapes.js';

let dir: string;
let ws: Workspace;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  const out = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(out);
  return out;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-parity-'));
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

async function smallGame() {
  await call('create_sprite', { name: 'tiles', width: 32, height: 16, tile_width: 16, tile_height: 16 });
  await call('create_sprite', { name: 'hero', width: 16, height: 16 });
  await call('create_sprite', { name: 'villain', width: 16, height: 16 });
  await call('set_object', { name: 'player', sprite: 'hero', properties: { hp: 3 } });
  await call('set_object', { name: 'foe', sprite: 'villain' });
  await call('create_scene', { name: 'town', cols: 4, rows: 4, tileset: 'tiles' });
  await call('place_instances', { scene: 'town', instances: [{ object: 'player', x: 0, y: 0, sprite: 'villain' }] });
}

describe('MCP covers what the editor does', () => {
  it('renames a sprite and every use of it follows', async () => {
    await smallGame();
    await call('set_tileset_rules', { tileset: 'tiles', paintable: 2 });
    await call('update_scene', { scene: 'town', backgrounds: [{ sprite: 'hero' }] });
    await call('write_vfx', { effect: 'boom', nodes: [{ id: 'start', type: 'start' }, { id: 's', type: 'sprite', params: { sprite: 'hero' } }], edges: [{ from: 'start', to: 's' }] });
    await call('write_script', { name: 'Uses', code: 'export const who = "hero";\n' });

    const out = await call('update_sprite', { sprite: 'hero', new_name: 'knight' });
    expect(ws.exists('hero')).toBe(false);
    expect(ws.loadGame().objects.find((o) => o.name === 'player')!.sprite).toBe('knight');
    expect(ws.loadScene('town').backgrounds[0].sprite).toBe('knight');
    expect(ws.loadVfx('boom').nodes.find((n) => n.id === 's')!.params.sprite).toBe('knight');
    expect(out).toContain('Uses');

    await call('update_sprite', { sprite: 'tiles', new_name: 'ground' });
    expect(ws.loadScene('town').tileset).toBe('ground');
    expect(Object.keys(ws.loadGame().tilesets ?? {})).toEqual(['ground']);
  });

  it('sets the category and the tile grid of a sprite', async () => {
    await call('create_sprite', { name: 's', width: 32, height: 32 });
    await call('update_sprite', { sprite: 's', category: 'props', tile_width: 16 });
    expect(ws.load('s').category).toBe('props');
    expect(ws.load('s').grid).toEqual({ width: 16, height: 16 });
    expect(await call('list_sprites')).toContain('category props');
    await call('update_sprite', { sprite: 's', tile_width: 0, category: null });
    expect(ws.load('s').grid).toBeNull();
    expect(ws.load('s').category).toBeNull();
  });

  it('duplicates layers and colors tags', async () => {
    await call('create_sprite', { name: 's', width: 2, height: 2 });
    await call('draw_rect', { sprite: 's', x: 0, y: 0, width: 2, height: 2, color: '#ff0000', filled: true });
    await call('update_layer', { sprite: 's', layer: 0, opacity: 0.5 });
    await call('add_layer', { sprite: 's', copy_from: 0 });
    const sprite = ws.load('s');
    expect(sprite.layers.map((l) => l.name)[1]).toMatch(/ copy$/);
    expect(sprite.layers[1].opacity).toBe(0.5);
    expect(Array.from(getCel(sprite, sprite.layers[1].id, sprite.frames[0].id)!.slice(0, 4))).toEqual([255, 0, 0, 255]);

    await call('set_tag', { sprite: 's', name: 'idle', from: 0, to: 0, color: '#123456' });
    expect(ws.load('s').tags[0].color).toBe('#123456');
  });

  it('duplicates scenes, reorders tile layers and changes the type of instances', async () => {
    await smallGame();
    await call('duplicate_scene', { scene: 'town', new_name: 'town2' });
    expect(ws.loadScene('town2').instances).toHaveLength(1);
    await expect(call('duplicate_scene', { scene: 'town', new_name: 'town2' })).rejects.toThrow(/already exists/);

    await call('set_tile_layer', { scene: 'town', layer: 'top' });
    await call('set_tile_layer', { scene: 'town', layer: 'top', move_to: 0 });
    expect(ws.loadScene('town').layers.map((l) => l.name)).toEqual(['top', 'ground']);

    await call('update_instances', { scene: 'town', object: 'player', new_object: 'foe' });
    expect(ws.loadScene('town').instances[0].object).toBe('foe');
    expect(ws.loadScene('town').instances[0].sprite).toBe('villain');
    await expect(call('update_instances', { scene: 'town', object: 'foe', new_object: 'ghost' })).rejects.toThrow(/No object type/);
  });

  it('copies object types and effects', async () => {
    await smallGame();
    await call('set_object', { name: 'hero2', copy_from: 'player' });
    expect(ws.loadGame().objects.find((o) => o.name === 'hero2')!.properties).toEqual({ hp: 3 });
    await expect(call('set_object', { name: 'hero2', copy_from: 'player' })).rejects.toThrow(/already exists/);

    await call('write_vfx', { effect: 'one', template: 'slash' });
    await call('write_vfx', { effect: 'two', copy_from: 'one' });
    expect(ws.loadVfx('two').nodes.length).toBe(ws.loadVfx('one').nodes.length);
  });

  it('renames dialogue files, data tables and rig parts, and makes script folders', async () => {
    await call('write_dialogue', { file: 'village', code: '=== mira\nMira: Hello.\n' });
    await call('rename_dialogue', { file: 'village', to: 'town' });
    expect(ws.dialogueExists('village')).toBe(false);
    expect(ws.dialogueExists('town')).toBe(true);

    await call('write_data', { table: 'items', rows: [{ id: 'a', price: 1 }] });
    await call('update_data', { table: 'items', rename_to: 'goods', upsert: [{ id: 'b', price: 2 }] });
    expect(ws.tableExists('items')).toBe(false);
    expect(ws.loadTable('goods').rows).toHaveLength(2);

    await call('create_script_folder', { name: 'enemies' });
    expect(ws.listScriptFolders()).toContain('enemies');

    await call('create_character', { name: 'kid', width: 16, height: 16 });
    await call('rig_part', { sprite: 'kid', name: 'body', facing: 'down', rows: ['xx'], legend: { x: '#ffffff' }, pivot: [0, 0], at: [8, 8], preview: false });
    await call('rig_rename_part', { sprite: 'kid', name: 'body', to: 'torso' });
    expect(ws.load('kid').rig!.parts.map((p) => p.name)).toEqual(['torso']);
  });
});

describe('the editor API covers what MCP does', () => {
  let srv: EditorServer;
  const api = (p: string, init?: RequestInit) => fetch(srv.url + p, init);
  const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    srv = await startEditorServer(ws, 0);
    const addr = srv.server.address();
    if (addr && typeof addr === 'object') srv.url = `http://127.0.0.1:${addr.port}`;
  });
  afterEach(() => srv.close());

  it('saves, lists and restores versions, which follow a rename', async () => {
    await call('create_sprite', { name: 's', width: 2, height: 2 });
    const first = (await (await api('/api/sprites/s/versions', post({}))).json()) as { id: string; iou: number; file?: string }[];
    expect(first).toHaveLength(1);
    expect(first[0].iou).toBe(-1);
    expect(first[0].file).toBeUndefined();

    await call('draw_rect', { sprite: 's', x: 0, y: 0, width: 2, height: 2, color: '#ff0000', filled: true });
    expect((await api(`/api/sprites/s/versions/${first[0].id}/restore`, post({}))).status).toBe(200);
    const restored = ws.load('s');
    expect(ws.readRaw('s').updatedBy).toBe('version');
    expect(Array.from(compositeFrame(restored, 0).data.slice(0, 4))).toEqual([0, 0, 0, 0]);
    // The state before restoring was saved too.
    expect(((await (await api('/api/sprites/s/versions')).json()) as unknown[]).length).toBe(2);

    await api('/api/sprites/s/rename', post({ to: 't' }));
    expect(((await (await api('/api/sprites/t/versions')).json()) as unknown[]).length).toBe(2);
  });

  it('renaming a sprite from the editor updates the game too', async () => {
    await smallGame();
    const r = (await (await api('/api/sprites/hero/rename', post({ to: 'knight' }))).json()) as { scripts: string[] };
    expect(r.scripts).toEqual([]);
    expect(ws.loadGame().objects.find((o) => o.name === 'player')!.sprite).toBe('knight');
  });

  it('compares a sprite with its reference', async () => {
    await call('create_sprite', { name: 's', width: 4, height: 4 });
    expect((await api('/api/sprites/s/silhouette')).ok).toBe(false);
    const sprite = ws.load('s');
    sprite.reference = { width: 1, height: 1, pixels: Buffer.from([255, 0, 0, 255]).toString('base64'), x: 0, y: 0 };
    ws.save(sprite, 'test');
    const r = (await (await api('/api/sprites/s/silhouette?frame=0')).json()) as { summary: string; png: string };
    expect(r.summary).toContain('Overlap');
    expect(r.png.length).toBeGreaterThan(10);
    expect(await call('versions', { sprite: 's' })).toContain('overlap');
  });

  it('previews a scene at a later stage of the game', async () => {
    await smallGame();
    await call('set_game', { variables: { lv: 0 } });
    await call('update_instances', { scene: 'town', object: 'player', active_if: 'lv >= 1' });
    const early = (await (await api('/api/scenes/town/preview-state', post({ vars: {} }))).json()) as { hidden: string[]; png: string };
    expect(early.hidden).toHaveLength(1);
    expect(early.png.length).toBeGreaterThan(10);
    const late = (await (await api('/api/scenes/town/preview-state', post({ vars: { lv: 2 } }))).json()) as { hidden: string[] };
    expect(late.hidden).toHaveLength(0);
  });
});

describe('shared sprite operations', () => {
  it('pixelizes a picture onto a layer and keeps it as the reference', () => {
    const s = createSprite({ name: 's', width: 8, height: 8 });
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) data.set(i % 16 < 8 ? [200, 30, 30, 255] : [30, 30, 200, 255], i * 4);
    const r = pixelizeToLayer(s, { width: 16, height: 16, data }, { colors: 4 });
    expect(r.layer).toBe('pixelized');
    expect([r.width, r.height]).toEqual([8, 8]);
    expect(r.colors.length).toBeGreaterThan(1);
    expect(s.reference).toBeTruthy();
    expect(s.palette).toEqual(expect.arrayContaining(r.colors));
  });

  it('writes the lint report as text', () => {
    const s = createSprite({ name: 's', width: 4, height: 4 });
    expect(formatLintReport(lintBitmap(compositeFrame(s, 0)))).toContain('Colors:');
  });
});
