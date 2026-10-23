import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { decodePng } from '../src/server/png.js';
import { celBitmap } from '../src/core/sprite.js';
import { getPixel } from '../src/core/draw.js';

let dir: string;
let ws: Workspace;
let client: Client;

type ToolResult = { isError?: boolean; content: { type: string; text?: string; data?: string }[] };

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-'));
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

describe('MCP server', () => {
  it('lists the drawing tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['create_sprite', 'draw_pixels', 'preview', 'add_frames', 'set_tag', 'export_spritesheet', 'copy_region', 'undo']) {
      expect(names).toContain(n);
    }
  });

  it('creates, draws, reads back and previews a sprite', async () => {
    expect((await call('create_sprite', { name: 'slime', width: 8, height: 8, palette: 'pico8' })).isError).toBeFalsy();
    const draw = await call('draw_pixels', {
      sprite: 'slime',
      x: 2,
      y: 3,
      rows: ['.kk.', 'kggk', 'kggk', '.kk.'],
      legend: { k: 'p0', g: '#00e436' },
    });
    expect(textOf(draw)).toContain('Drew 12 pixel(s)');

    const s = ws.load('slime');
    const bmp = celBitmap(s, s.layers[0].id, s.frames[0].id);
    expect(getPixel(bmp, 3, 4)).toEqual([0, 228, 54, 255]);
    expect(getPixel(bmp, 2, 3)[3]).toBe(0);

    const read = textOf(await call('read_pixels', { sprite: 'slime', x: 2, y: 3, width: 4, height: 4 }));
    expect(read).toContain('.AA.');
    expect(read).toContain('content bounds'.slice(1)); // "ontent bounds"

    const prev = await call('preview', { sprite: 'slime', pixel_grid: true, scale: 4 });
    const img = prev.content.find((c) => c.type === 'image')!;
    const png = decodePng(Buffer.from(img.data!, 'base64'));
    expect(png.width).toBe(32);
  });

  it('animates: copies frames, shifts, tags, and exports a sheet', async () => {
    await call('create_sprite', { name: 'bob', width: 4, height: 4 });
    await call('draw_pixels', { sprite: 'bob', rows: ['rr'], legend: { r: '#ff0000' } });
    await call('add_frames', { sprite: 'bob', count: 2, copy_from: 0, duration: 80 });
    await call('transform', { sprite: 'bob', frame: 1, op: 'shift', dy: 1 });
    await call('set_tag', { sprite: 'bob', name: 'bounce', from: 0, to: 2, direction: 'pingpong' });

    const s = ws.load('bob');
    expect(s.frames).toHaveLength(3);
    expect(getPixel(celBitmap(s, s.layers[0].id, s.frames[1].id), 0, 1)).toEqual([255, 0, 0, 255]);
    expect(getPixel(celBitmap(s, s.layers[0].id, s.frames[2].id), 0, 0)).toEqual([255, 0, 0, 255]);

    const out = textOf(await call('export_spritesheet', { sprite: 'bob', layout: 'grid', columns: 2, by_tag: true }));
    expect(out).toContain('bob.png');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'export', 'bob.json'), 'utf8'));
    expect(meta.frames).toHaveLength(3);
    expect(meta.frames[2].frame).toEqual({ x: 0, y: 4, w: 4, h: 4 });
    expect(meta.meta.frameTags[0]).toMatchObject({ name: 'bounce', direction: 'pingpong' });
    expect(fs.existsSync(path.join(dir, 'export', 'bob_bounce.png'))).toBe(true);
  });

  it('stamps tiles from a tileset into a scene', async () => {
    await call('create_sprite', { name: 'tiles', width: 4, height: 2, tile_width: 2, tile_height: 2 });
    await call('draw_pixels', { sprite: 'tiles', tile: { col: 1, row: 0 }, rows: ['gg', 'dd'], legend: { g: '#00ff00', d: '#884400' } });
    await call('create_sprite', { name: 'level', width: 6, height: 2 });
    const r = await call('copy_region', {
      sprite: 'level',
      source_sprite: 'tiles',
      source_tile: { col: 1, row: 0 },
      targets: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
    });
    expect(r.isError).toBeFalsy();
    const rows = textOf(await call('read_pixels', { sprite: 'level' }));
    expect(rows).toMatch(/\n(\w)\1{5}\n(\w)\2{5}$/);
  });

  it('undoes changes and reports helpful errors', async () => {
    await call('create_sprite', { name: 'u', width: 2, height: 2 });
    await call('draw_rect', { sprite: 'u', x: 0, y: 0, width: 2, height: 2, color: '#ffffff', filled: true });
    await call('undo', { sprite: 'u' });
    const s = ws.load('u');
    expect(s.cels.size === 0 || getPixel(celBitmap(s, s.layers[0].id, s.frames[0].id), 0, 0)[3] === 0).toBe(true);

    const bad = await call('draw_pixels', { sprite: 'missing', rows: ['a'], legend: { a: '#fff' } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('not found');

    const badColor = await call('fill', { sprite: 'u', x: 0, y: 0, color: 'bluish' });
    expect(textOf(badColor)).toContain('Invalid color');
  });
});
