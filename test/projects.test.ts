import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { createMcpServer } from '../src/server/mcp.js';
import { startEditorServer } from '../src/server/http.js';

let tmp: string;
let registry: ProjectRegistry;
let ws: Workspace;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-projects-'));
  ws = new Workspace(path.join(tmp, 'default'));
  registry = new ProjectRegistry({ root: path.join(tmp, 'root'), defaultDir: ws.dir });
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

describe('project registry', () => {
  it('creates projects from templates, opens folders and keeps ids stable', () => {
    const p = registry.create('My Platformer', 'platformer');
    expect(p.id).toBe('my-platformer');
    expect(p.name).toBe('My Platformer');
    expect(p.scenes).toBe(3);
    expect(fs.existsSync(path.join(p.dir, 'export'))).toBe(false);

    const rpg = registry.create('Village', 'rpg');
    expect(rpg.scripts).toBeGreaterThan(0);

    const ext = path.join(tmp, 'elsewhere', 'old-game');
    fs.mkdirSync(ext, { recursive: true });
    const added = registry.add(ext);
    expect(added.id).toMatch(/^old-game-[0-9a-f]{6}$/);

    // A second registry (e.g. the MCP process) sees the same projects with the same ids.
    const other = new ProjectRegistry({ root: path.join(tmp, 'root'), defaultDir: ws.dir });
    expect(other.list().map((x) => x.id).sort()).toEqual(registry.list().map((x) => x.id).sort());
    expect(other.resolve('my platformer').id).toBe('my-platformer');

    registry.forget(added.id);
    expect(registry.list().some((x) => x.id === added.id)).toBe(false);
  });

  it('serves each project under /api/p/<id>', async () => {
    const p = registry.create('Second Game', 'empty');
    const srv = await startEditorServer(ws, 0, '127.0.0.1', { registry });
    const addr = srv.server.address();
    const base = `http://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
    try {
      const list = (await (await fetch(base + '/api/projects')).json()) as { projects: { id: string }[]; defaultId: string };
      expect(list.projects.map((x) => x.id)).toContain('second-game');
      expect(list.defaultId).toBe(registry.defaultId);
      const g = (await (await fetch(`${base}/api/p/${p.id}/game`)).json()) as { title: string };
      expect(g.title).toBe('Second Game');
      await fetch(`${base}/api/p/${p.id}/scripts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'main', code: 'func("hi", () => 1)' }) });
      const info = (await (await fetch(`${base}/api/p/${p.id}/scripts/_info`)).json()) as { functions: string[] };
      expect(info.functions).toEqual(['hi']);
      // The default project is untouched.
      expect(ws.listScripts()).toEqual([]);
      expect((await fetch(`${base}/api/p/nope/game`)).status).toBe(404);
    } finally {
      await srv.close();
    }
  });
});

describe('MCP projects and scripts', () => {
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as ToolResult;
    const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(t);
    return t;
  };

  beforeEach(async () => {
    const server = createMcpServer(ws, { registry });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => client.close());

  it('creates and switches projects; tools follow the current project', async () => {
    expect(await call('create_project', { name: 'Dungeon', template: 'empty' })).toContain('Current project: dungeon');
    await call('create_sprite', { name: 'wall', width: 16, height: 16 });
    expect(fs.existsSync(path.join(registry.root, 'dungeon', 'wall.sprite.json'))).toBe(true);
    expect(ws.exists('wall')).toBe(false);
    await call('open_project', { project: registry.defaultId });
    expect(await call('list_sprites')).toContain('No sprites yet');
    expect(await call('list_projects')).toMatch(/\* .*default/);
  });

  it('writes, checks, edits and runs scripts', async () => {
    await expect(call('write_script', { name: 'bad', code: 'func("x", () => {' })).rejects.toThrow(/Syntax error/);
    const out = await call('write_script', { name: 'npcs', code: "behavior('npc', { interact: async (self) => { await say('Hi') } })\nfunc('gift', () => { vars.gold = 3 })" });
    expect(out).toContain('Registered behaviors: npc');
    expect(out).toContain('Registered functions: gift');
    expect(await call('edit_script', { name: 'npcs', find: 'vars.gold = 3', replace: 'vars.gold = 7' })).toContain('Saved');
    expect(await call('read_script', { name: 'npcs' })).toContain('vars.gold = 7');
    await call('set_game', { variables: { gold: 0 } });
    await call('create_scene', { name: 'room', cols: 10, rows: 8 });
    await call('set_events', { scene: 'room', events: [{ trigger: { type: 'start' }, actions: [{ type: 'call', function: 'gift' }, { type: 'talk', text: '"Welcome"' }] }] });
    const run = await call('playtest', { seconds: 1 });
    expect(run).toContain('dialog: Welcome');
    expect(run).toContain('"gold":7');
    expect(await call('script_reference')).toContain('behavior(name');
  });
});
