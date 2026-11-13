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
    // Its own sprite, and it waits for the message of its own write: file events of earlier tests can arrive late
    // (they were what made this test fail now and then, and fail always when run alone).
    expect((await api('/api/sprites', json({ name: 'watched', width: 2, height: 2 }))).status).toBe(201);
    const sock = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
    await new Promise((r) => sock.on('open', r));
    const s = ws.load('watched');
    const got = new Promise<{ name: string; updatedBy?: string; rev?: string }>((resolve) => {
      sock.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.type === 'sprite-changed' && msg.name === 'watched' && msg.updatedBy === 'claude') resolve(msg);
      });
    });
    ws.save(s, 'claude');
    const msg = await got;
    expect(msg.rev).toBe(ws.readRaw('watched').rev);
    sock.close();
  });

  it('rejects path traversal and unknown routes', async () => {
    expect((await api('/api/sprites/..%2F..%2Fetc')).status).toBeGreaterThanOrEqual(400);
    expect((await api('/api/nope')).status).toBe(404);
  });
});

describe('mark here (F8)', () => {
  const png = () => encodePng({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }).toString('base64');

  it('stores numbered reports with their photo in the project, and lists them', async () => {
    const r1 = await api('/api/game/marks', json({ report: { scene: 'town', player: { x: 10, y: 20, feet: { x: 1, y: 2, w: 3, h: 4 }, facing: 'up' }, trail: [[1, 2], [3, 4]], note: ' here ', vars: { story: 3 } }, png: png() }));
    expect(r1.status).toBe(201);
    const a = (await r1.json()) as { n: number; file: string; photo: string };
    expect(a).toEqual({ n: 1, file: 'marks/mark_0001.json', photo: 'marks/mark_0001.png' });
    expect(decodePng(fs.readFileSync(path.join(dir, a.photo))).width).toBe(2);
    const b = (await (await api('/api/game/marks', json({ report: { scene: 'town' } }))).json()) as { n: number; photo: string | null };
    expect(b.n).toBe(2);
    expect(b.photo).toBeNull();
    const all = (await (await api('/api/game/marks')).json()) as { n: number; note?: string; trail?: number[][]; vars?: Record<string, unknown> }[];
    expect(all.map((m) => m.n)).toEqual([1, 2]);
    expect(all[0]).toMatchObject({ note: 'here', trail: [[1, 2], [3, 4]], vars: { story: 3 } });
    expect(((await (await api('/api/game/marks?after=1')).json()) as unknown[]).length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'marks', 'index.json'), 'utf8'))).toHaveLength(2);
  });

  it('names the files itself: paths or numbers in the request never leave the project marks folder', async () => {
    const res = await api('/api/game/marks', json({ report: { scene: 'x', file: '../../evil.json', photo: '../evil.png', n: 999 }, png: png(), file: '../evil' }));
    const m = (await res.json()) as { n: number; file: string; photo: string };
    expect(m.n).toBe(3);
    expect(m.file).toBe('marks/mark_0003.json');
    expect(m.photo).toBe('marks/mark_0003.png');
    for (const f of ['evil.json', 'evil.png', 'evil', '../evil.json', '../evil.png', '../evil']) expect(fs.existsSync(path.join(dir, f))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'marks')).sort()).toEqual(['index.json', 'mark_0001.json', 'mark_0001.png', 'mark_0002.json', 'mark_0003.json', 'mark_0003.png']);
    // a photo that is not a PNG is refused
    expect((await api('/api/game/marks', json({ report: {}, png: Buffer.from('<svg/>').toString('base64') }))).status).toBe(400);
    expect((await api('/api/game/marks', json({ nothing: true }))).status).toBe(400);
  });
});

describe('mark here in an exported game', () => {
  it("has an endpoint only where the editor's server flagged the page, and only back to that server", async () => {
    const { markEndpoint } = await import('../src/runtime/markEndpoint.js');
    const flag = { marks: 'marks' };
    expect(markEndpoint(flag, 'http://127.0.0.1:7420/api/game/play.html?hd=1')).toBe('http://127.0.0.1:7420/api/game/marks');
    expect(markEndpoint(flag, 'http://127.0.0.1:7420/api/p/crystal-vale/game/play.html')).toBe('http://127.0.0.1:7420/api/p/crystal-vale/game/marks');
    // an exported game hosted at the same kind of address has no flag: nothing
    expect(markEndpoint(undefined, 'https://someone.example/game/play.html')).toBeNull();
    expect(markEndpoint(undefined, 'http://127.0.0.1:7420/api/game/play.html')).toBeNull();
    expect(markEndpoint({ marks: 'https://elsewhere.example/steal' }, 'http://127.0.0.1:7420/api/game/play.html')).toBeNull();
    expect(markEndpoint(flag, 'file:///Users/x/Valdora.html')).toBeNull();
  });

  it('flags play.html served by the editor, not export.html, and leaves the F8 code out of the exported runtime', async () => {
    // both runtimes built from the sources now (not whatever dist/ holds), into a folder of their own
    const { build } = await import('vite');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-runtime-'));
    const saved = process.env.RUNTIME_KIND;
    try {
      for (const kind of ['export', 'dev']) {
        process.env.RUNTIME_KIND = kind;
        await build({ configFile: path.resolve('vite.runtime.config.ts'), logLevel: 'silent', build: { outDir: out, emptyOutDir: false } });
      }
    } finally {
      if (saved === undefined) delete process.env.RUNTIME_KIND;
      else process.env.RUNTIME_KIND = saved;
    }
    const exported = fs.readFileSync(path.join(out, 'player.js'), 'utf8');
    const dev = fs.readFileSync(path.join(out, 'player-dev.js'), 'utf8');
    expect(exported).not.toContain('Marked #');
    expect(exported).not.toContain('SPRITIFER_DEV');
    expect(exported).not.toContain('toDataURL');
    expect(dev).toContain('Marked #');
    fs.rmSync(out, { recursive: true, force: true });
    ws.saveScene({ ...(await import('../src/core/game/types.js')).createScene({ name: 'start', cols: 4, rows: 4, tileSize: 16 }) }, 'test');
    const play = await (await api('/api/game/play.html')).text();
    const exp = await (await api('/api/game/export.html')).text();
    expect(play).toContain('window.SPRITIFER_DEV={"marks":"marks"}');
    expect(exp).not.toContain('SPRITIFER_DEV');
  });
});

describe('mark here: guards of the endpoint', () => {
  const png = () => encodePng({ width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) }).toString('base64');

  it('refuses pages from elsewhere and bodies that are not JSON', async () => {
    const other = await api('/api/game/marks', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ report: { scene: 'x' } }) });
    expect(other.status).toBe(403);
    const crossSite = await api('/api/game/marks', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: JSON.stringify({ report: { scene: 'x' } }) });
    expect(crossSite.status).toBe(403);
    const text = await api('/api/game/marks', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ report: { scene: 'x' } }) });
    expect(text.status).toBe(415);
    expect((await api('/api/game/marks', { headers: { origin: 'http://evil.example' } })).status).toBe(403);
  });

  it('checks the whole PNG and keeps only simple game variables', async () => {
    const fake = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('not really a png')]).toString('base64');
    expect((await api('/api/game/marks', json({ report: { scene: 'x' }, png: fake }))).status).toBe(400);
    const res = await api('/api/game/marks', json({ report: { scene: 'x', vars: { story: 3, ok_flag: true, 'bad key!': 1, nested: { a: 1 }, long: 'x'.repeat(500) } }, png: png() }));
    expect(res.status).toBe(201);
    const { n } = (await res.json()) as { n: number };
    const stored = ((await (await api('/api/game/marks')).json()) as { n: number; vars: Record<string, unknown> }[]).find((m) => m.n === n)!;
    expect(stored.vars).toEqual({ story: 3, ok_flag: true, long: 'x'.repeat(200) });
  });

  it('stops at the limits of the marks folder', async () => {
    const { saveMark, MarkError } = await import('../src/server/marks.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-marks-'));
    const limits = { maxMarks: 2, maxTotalBytes: 1 << 20, maxPngBytes: 1 << 20, maxPngSide: 64 };
    saveMark(d, { scene: 'a' }, null, limits);
    saveMark(d, { scene: 'b' }, null, limits);
    expect(() => saveMark(d, { scene: 'c' }, null, limits)).toThrow(MarkError);
    const big = encodePng({ width: 100, height: 1, data: new Uint8ClampedArray(400) });
    expect(() => saveMark(fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-marks-')), {}, big, limits)).toThrow(/impossible size/);
    expect(() => saveMark(fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-marks-')), {}, big, { ...limits, maxTotalBytes: 10 })).toThrow(/full/);
    // a small file that declares a huge picture is refused from its header, without decoding it
    const huge = Buffer.from(encodePng({ width: 1, height: 1, data: new Uint8ClampedArray(4) }));
    huge.writeUInt32BE(14000, 16);
    huge.writeUInt32BE(14000, 20);
    const t0 = performance.now();
    expect(() => saveMark(fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-marks-')), {}, huge)).toThrow(/impossible size/);
    expect(performance.now() - t0).toBeLessThan(200);
    // a second IHDR after a small first one (a decoder may honour the second): refused from the chunks, without decoding
    const zlib = await import('node:zlib');
    const one = Buffer.from(encodePng({ width: 1, height: 1, data: new Uint8ClampedArray(4) }));
    const ihdr = Buffer.from(one.subarray(8, 8 + 25));
    ihdr.writeUInt32BE(14000, 8);
    ihdr.writeUInt32BE(14000, 12);
    ihdr.writeUInt32BE(zlib.crc32(ihdr.subarray(4, 21)) >>> 0, 21);
    const two = Buffer.concat([one.subarray(0, 33), ihdr, one.subarray(33)]);
    const t1 = performance.now();
    expect(() => saveMark(fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-marks-')), {}, two)).toThrow(/not a PNG/);
    expect(performance.now() - t1).toBeLessThan(200);
    fs.rmSync(d, { recursive: true, force: true });
  });
});
