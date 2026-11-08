import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Workspace } from '../src/server/store.js';
import { type EditorServer, startEditorServer } from '../src/server/http.js';
import { decodePng, encodePng } from '../src/server/png.js';
import type { SpriteFile } from '../src/core/sprite.js';

let dir: string;
let ws: Workspace;
let srv: EditorServer;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-http-'));
  ws = new Workspace(dir);
  srv = await startEditorServer(ws, 0);
  const addr = srv.server.address();
  if (addr && typeof addr === 'object') srv.url = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const api = (p: string, init?: RequestInit) => fetch(srv.url + p, init);
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('editor HTTP API', () => {
  it('creates, saves and lists sprites', async () => {
    expect((await api('/api/sprites', json({ name: 'box', width: 2, height: 2 }))).status).toBe(201);
    expect((await api('/api/sprites', json({ name: 'box', width: 2, height: 2 }))).status).toBe(409);

    const file = (await (await api('/api/sprites/box')).json()) as SpriteFile;
    file.cels[`${file.layers[0].id}/${file.frames[0].id}`] = Buffer.from([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    const saved = await api('/api/sprites/box', json(file, 'PUT'));
    expect(saved.status).toBe(200);
    expect(ws.readRaw('box').updatedBy).toBe('editor');

    const list = (await (await api('/api/sprites')).json()) as { name: string }[];
    expect(list.map((s) => s.name)).toEqual(['box']);

    const png = decodePng(Buffer.from(await (await api('/api/sprites/box/sheet.png?scale=2')).arrayBuffer()));
    expect([png.width, png.height]).toEqual([4, 4]);
    expect(Array.from(png.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
  });

  it('keeps fields an older editor build does not send (rig, ramps, reference)', async () => {
    await api('/api/sprites', json({ name: 'kid', width: 2, height: 2 }));
    const raw = ws.readRaw('kid');
    ws.writeRaw({ ...raw, rig: { layer: raw.layers[0].id, parts: [] }, ramps: { skin: ['#000000', '#ffffff'] } });
    const file = (await (await api('/api/sprites/kid')).json()) as Record<string, unknown>;
    delete file.rig;
    delete file.ramps;
    expect((await api('/api/sprites/kid', json(file, 'PUT'))).status).toBe(200);
    const after = ws.readRaw('kid');
    expect(after.rig?.layer).toBe(raw.layers[0].id);
    expect(after.ramps?.skin).toHaveLength(2);
  });

  it('imports a spritesheet PNG sliced into frames', async () => {
    const img = { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(200) };
    const res = await api('/api/import', json({ name: 'strip', png: encodePng(img).toString('base64'), frameWidth: 4, frameHeight: 4, category: 'effects' }));
    expect(res.status).toBe(201);
    expect(ws.load('strip').frames).toHaveLength(2);
    expect(ws.load('strip').category).toBe('effects');
  });

  it('keeps the gallery category independent of animation tags and stale drawing saves', async () => {
    const route = '/api/sprites/categorized';
    expect((await api('/api/sprites', json({ name: 'categorized', width: 16, height: 16, category: 'characters' }))).status).toBe(201);
    const stale = ws.readRaw('categorized');
    stale.tags.push({ name: 'idle', from: 0, to: 0, direction: 'forward', color: '#ffffff' });

    expect((await api(route + '/category', json({ category: 'unknown' }, 'PUT'))).status).toBe(400);
    expect((await api(route + '/category', json({ category: 'props' }, 'PUT'))).status).toBe(200);
    expect((await api(route, json(stale, 'PUT'))).status).toBe(200);
    expect(await (await api('/api/sprites')).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'categorized', category: 'props', tags: ['idle'] }),
    ]));
    expect((await api(route + '/duplicate', json({ to: 'categorized_copy' }))).status).toBe(201);
    expect(ws.load('categorized_copy').category).toBe('props');

    expect((await api(route + '/category', json({ category: null }, 'PUT'))).status).toBe(200);
    expect(ws.readRaw('categorized').category).toBeNull();
  });

  it('notifies websocket clients when a sprite file changes on disk', async () => {
    const sock = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
    const got = new Promise<{ name: string; updatedBy?: string }>((resolve) => {
      sock.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.type === 'sprite-changed' && msg.name === 'box') resolve(msg);
      });
    });
    await new Promise((r) => sock.on('open', r));
    const s = ws.load('box');
    ws.save(s, 'claude');
    const msg = await got;
    expect(msg.updatedBy).toBe('claude');
    sock.close();
  });

  it('rejects path traversal and unknown routes', async () => {
    expect((await api('/api/sprites/..%2F..%2Fetc')).status).toBeGreaterThanOrEqual(400);
    expect((await api('/api/nope')).status).toBe(404);
  });
});
