import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { BitmapRenderer } from '../src/server/game.js';
import { type Bitmap, createSprite, celBitmap, deserializeSprite, serializeSprite } from '../src/core/sprite.js';
import { setPixel } from '../src/core/draw.js';
import { buildNormalSheet, flipNormalSheet, frameMask, normalSheetFor, reliefKind, resolveRelief, shadeRelief } from '../src/core/game/relief.js';
import { normalizeAtmosphere, type SpriteAsset } from '../src/core/game/types.js';
import { drawShadows } from '../src/core/game/atmosphere.js';

const BODY: [number, number, number, number] = [150, 120, 100, 255];

/** A solid w×h block in the middle of a canvas with a 2px transparent margin. */
function block(w: number, h: number, c = BODY): Bitmap {
  const W = w + 4;
  const H = h + 4;
  const b: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 2; y < h + 2; y++) for (let x = 2; x < w + 2; x++) setPixel(b, x, y, c);
  return b;
}
const whole = (b: Bitmap) => [{ x: 0, y: 0, w: b.width, h: b.height }];
const nx = (n: Uint8ClampedArray, W: number, x: number, y: number) => n[(y * W + x) * 4] / 127.5 - 1;
const ny = (n: Uint8ClampedArray, W: number, x: number, y: number) => n[(y * W + x) * 4 + 1] / 127.5 - 1;

describe('normal sheets', () => {
  it('points the edges of a shape outward and leaves transparent pixels empty', () => {
    const b = block(16, 16);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b));
    expect(nx(n, b.width, 2, 10)).toBeLessThan(-0.2);
    expect(nx(n, b.width, 17, 10)).toBeGreaterThan(0.2);
    expect(ny(n, b.width, 10, 2)).toBeLessThan(-0.2);
    expect(ny(n, b.width, 10, 17)).toBeGreaterThan(0.2);
    expect(n[3]).toBe(0);
    expect(n[(10 * b.width + 10) * 4 + 3]).toBe(255);
  });

  it('depth makes volumes stronger, and glow marks the listed colors', () => {
    const b = block(16, 16);
    const soft = buildNormalSheet(b.data, b.width, b.height, whole(b), { depth: 0.3 });
    const deep = buildNormalSheet(b.data, b.width, b.height, whole(b), { depth: 2.5 });
    expect(Math.abs(nx(deep, b.width, 2, 10))).toBeGreaterThan(Math.abs(nx(soft, b.width, 2, 10)));
    const lit = buildNormalSheet(b.data, b.width, b.height, whole(b), { glow: ['#967864'] });
    expect(lit[(10 * b.width + 10) * 4 + 2]).toBe(255);
  });

  it('computes each frame on its own, so frames touching in the sheet do not merge', () => {
    const b: Bitmap = { width: 16, height: 8, data: new Uint8ClampedArray(16 * 8 * 4) };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) setPixel(b, x, y, BODY);
    const n = buildNormalSheet(b.data, 16, 8, [{ x: 0, y: 0, w: 8, h: 8 }, { x: 8, y: 0, w: 8, h: 8 }]);
    expect(nx(n, 16, 7, 4)).toBeGreaterThan(0.1);
    expect(nx(n, 16, 8, 4)).toBeLessThan(-0.1);
  });

  it('flips the x of the normals', () => {
    const b = block(8, 8);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b));
    const f = flipNormalSheet(n);
    const i = (5 * b.width + 2) * 4;
    expect(f[i]).toBe(255 - n[i]);
    expect(f[i + 1]).toBe(n[i + 1]);
  });

  it('tells objects, tiles and flat sprites apart', () => {
    const view = { width: 320, height: 180 };
    expect(reliefKind({ width: 32, height: 32, grid: null }, view)).toBe('shape');
    expect(reliefKind({ width: 320, height: 320, grid: { width: 16, height: 16 } }, view)).toBe('surface');
    expect(reliefKind({ width: 320, height: 180, grid: null }, view)).toBeNull();
    expect(reliefKind({ width: 32, height: 32, grid: null, relief: { off: true } }, view)).toBeNull();
  });

  it('a tile takes its bumps from its paint and joins its neighbors without a bevel', () => {
    // Two tiles side by side in the sheet: uniform, except a bright stripe in the second.
    const b: Bitmap = { width: 16, height: 8, data: new Uint8ClampedArray(16 * 8 * 4) };
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) setPixel(b, x, y, x >= 11 && x <= 12 ? [230, 230, 230, 255] : BODY);
    const asset: SpriteAsset = { name: 't', width: 16, height: 8, grid: { width: 8, height: 8 }, tags: [], frames: [{ x: 0, y: 0, w: 16, h: 8, duration: 100 }] };
    const n = normalSheetFor(b.data, 16, 8, asset, { width: 320, height: 180 })!;
    // No silhouette: the edges of a uniform tile stay flat, and nothing leaks from the tile next to it.
    expect(Math.abs(nx(n, 16, 0, 4))).toBeLessThan(0.02);
    expect(Math.abs(nx(n, 16, 7, 4))).toBeLessThan(0.02);

    // The paint makes a bump: its left side faces left.
    expect(nx(n, 16, 10, 4)).toBeLessThan(-0.1);
    expect(nx(n, 16, 13, 4)).toBeGreaterThan(0.1);
  });

  it('reads a frame as a solid mask', () => {
    const b = block(2, 2);
    expect([...frameMask(b.data, b.width, 1, 2, 3, 1)]).toEqual([0, 1, 1]);
  });
});

describe('shadeRelief', () => {
  const gray = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(160) });
  const flatNormals = (w: number, h: number) => new Uint8ClampedArray(w * h * 4);
  const lamp = (x: number, y: number) => [{ x, y, radius: 40, color: '#ffffff', intensity: 1 }];

  it('lights flat pixels exactly like the plain lighting pass', () => {
    const plain = new BitmapRenderer(32, 32, new Map());
    plain.clear('#a0a0a0');
    plain.lighting('#404060', lamp(16, 16), 0.5);
    const frame = { width: 32, height: 32, data: new Uint8ClampedArray(plain.out.data.length) };
    const other = new BitmapRenderer(32, 32, new Map());
    other.clear('#a0a0a0');
    frame.data.set(other.out.data);
    shadeRelief(frame, flatNormals(32, 32), resolveRelief({}), '#404060', lamp(16, 16), 0.5);
    for (let i = 0; i < frame.data.length; i++) expect(Math.abs(frame.data[i] - plain.out.data[i])).toBeLessThanOrEqual(1);
  });

  it('brightens the side of a shape turned to the light and darkens the other', () => {
    const b = block(24, 24);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b));
    const frame = gray(b.width, b.height);
    shadeRelief(frame, n, resolveRelief({ bands: 0 }), '#505050', lamp(-10, 14), 0);
    const at = (x: number) => frame.data[(14 * b.width + x) * 4];
    expect(at(3)).toBeGreaterThan(at(24));
  });

  it('with a sun, lights one side and tints the other with the shade color', () => {
    const b = block(24, 24);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b));
    const frame = gray(b.width, b.height);
    shadeRelief(frame, n, resolveRelief({ sun: { angle: 180, elevation: 40, color: '#ffffff', shade: '#000080' } }), '#ffffff', [], 0);
    const px = (x: number) => [...frame.data.subarray((14 * b.width + x) * 4, (14 * b.width + x) * 4 + 3)];
    const lit = px(3);
    const shaded = px(24);
    expect(lit[0]).toBeGreaterThan(shaded[0]);
    expect(shaded[2]).toBeGreaterThan(shaded[0]);
    // Empty pixels around the shape are untouched by the sun.
    expect(frame.data[0]).toBe(160);
  });

  it('never darkens glowing pixels', () => {
    const b = block(12, 12);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b), { glow: ['#967864'] });
    const frame = gray(b.width, b.height);
    shadeRelief(frame, n, resolveRelief({}), '#101020', [], 0);
    expect(frame.data[(8 * b.width + 8) * 4]).toBeGreaterThanOrEqual(160);
  });

  it('with few bands, the light on a sprite falls in discrete steps', () => {
    const b = block(30, 30);
    const n = buildNormalSheet(b.data, b.width, b.height, whole(b));
    const levels = (bands: number) => {
      const frame = gray(b.width, b.height);
      shadeRelief(frame, n, resolveRelief({ bands, sun: { angle: 180 } }), '#ffffff', [], 0);
      const seen = new Set<number>();
      for (let x = 2; x < 32; x++) seen.add(frame.data[(15 * b.width + x) * 4]);
      return seen.size;
    };
    expect(levels(3)).toBeLessThan(levels(0));
  });
});

describe('capturing normals while drawing', () => {
  const asset = (name: string, b: Bitmap, grid: SpriteAsset['grid'] = null): SpriteAsset => ({ name, width: b.width, height: b.height, grid, tags: [], frames: [{ x: 0, y: 0, w: b.width, h: b.height, duration: 100 }] });
  const OPTS = { flipX: false, opacity: 1, angle: 0 };

  function setup() {
    const hero = block(16, 16);
    const roof = block(16, 16, [90, 40, 40, 255]);
    const sheets = new Map([['hero', hero], ['roof', roof]]);
    const assets = { hero: asset('hero', hero), roof: asset('roof', roof, { width: 16, height: 16 }) };
    const r = new BitmapRenderer(40, 40, sheets).useRelief(assets, { width: 320, height: 180 });
    return { r, hero };
  }
  const lit = (r: BitmapRenderer) => {
    r.clear('#a0a0a0');
  };

  it('mirrors normals with the sprite', () => {
    const { r } = setup();
    const sideOf = (flipX: boolean) => {
      const { r: rr } = setup();
      rr.clear('#808080');
      rr.beginRelief(true);
      rr.image('hero', 0, 0, 20, 20, 10, 10, { ...OPTS, flipX });
      rr.reliefLighting(resolveRelief({ bands: 0 }), '#505050', [{ x: 2, y: 20, radius: 60, color: '#ffffff', intensity: 1 }], 0);
      return rr.out.data[(20 * 40 + 13) * 4] - rr.out.data[(20 * 40 + 26) * 4];
    };
    lit(r);
    // Same art both ways: the side toward the light is the brighter one, flipped or not.
    expect(sideOf(false)).toBeGreaterThan(0);
    expect(sideOf(true)).toBeGreaterThan(0);
  });

  it('a flat sprite drawn on top erases the normals under it', () => {
    const { r } = setup();
    const shade = (withRoof: boolean) => {
      const { r: rr } = setup();
      rr.clear('#808080');
      rr.beginRelief(true);
      rr.image('hero', 0, 0, 20, 20, 10, 10, OPTS);
      if (withRoof) rr.image('roof', 0, 0, 20, 20, 10, 10, OPTS);
      rr.reliefLighting(resolveRelief({ bands: 0 }), '#606060', [{ x: 2, y: 20, radius: 60, color: '#ffffff', intensity: 1 }], 0);
      return [rr.out.data[(20 * 40 + 13) * 4], rr.out.data[(20 * 40 + 26) * 4]];
    };
    lit(r);
    const [roofLeft, roofRight] = shade(true);
    // A flat roof falls off smoothly with distance, with no volume: only slightly brighter toward the lamp.
    expect(roofLeft / roofRight).toBeLessThan(2.2);
    const [left, right] = shade(false);
    expect(left / right).toBeGreaterThan(roofLeft / roofRight);
  });

  it('a flat draw call leaves the ground without relief', () => {
    const shade = (flat: boolean) => {
      const { r: rr } = setup();
      rr.clear('#808080');
      rr.beginRelief(true);
      rr.image('hero', 0, 0, 20, 20, 10, 10, { ...OPTS, flat });
      rr.reliefLighting(resolveRelief({ bands: 0, sun: { angle: 180 } }), '#ffffff', [], 0);
      return rr.out.data[(20 * 40 + 13) * 4] - rr.out.data[(20 * 40 + 26) * 4];
    };
    expect(shade(true)).toBe(0);
    expect(shade(false)).toBeGreaterThan(0);
  });

  it('can leave tiles out of the relief', () => {
    const tile = block(16, 16);
    const a = asset('tile', tile, { width: 20, height: 20 });
    const shade = (tiles: boolean) => {
      const rr = new BitmapRenderer(40, 40, new Map([['tile', tile]])).useRelief({ tile: a }, { width: 320, height: 180 });
      rr.clear('#808080');
      rr.beginRelief(true, tiles);
      rr.image('tile', 0, 0, 20, 20, 10, 10, OPTS);
      rr.reliefLighting(resolveRelief({ bands: 0, sun: { angle: 180 } }), '#ffffff', [], 0);
      return [...rr.out.data];
    };
    const flatRender = shade(false);
    // Off: only the art, as drawn.
    expect(flatRender[(20 * 40 + 13) * 4]).toBe(150);
  });

  it('casts the silhouette away from the sun, once per pixel', () => {
    const { r } = setup();
    r.clear('#808080');
    const actor = { id: 1, x: 10, y: 10, z: 0, opacity: 1, visible: true, destroyed: false, light: undefined, asset: { width: 20, height: 20, name: 'hero', frames: [{ x: 0, y: 0, w: 20, h: 20 }] }, type: {}, box: () => ({ x: 10, y: 10, w: 20, h: 20 }) };
    const world = { clock: 0, game: { width: 40, height: 40 }, actors: [actor], motes: { list: [] } as never, bundle: { sprites: {} } };
    drawShadows(world, r, { shadowOpacity: 0.5, relief: { sun: { angle: 180, elevation: 45 } } }, 0, 0, 1);
    // Sun on the left: the shadow lies to the right of the sprite, and never doubles up.
    let darker = 0;
    const values = new Set<number>();
    for (let x = 30; x < 40; x++) for (let y = 20; y < 32; y++) {
      const v = r.out.data[(y * 40 + x) * 4];
      if (v < 128) { darker++; values.add(v); }
    }
    expect(darker).toBeGreaterThan(0);
    expect(values.size).toBe(1);
  });
});

describe('relief settings', () => {
  it('keeps sprite settings through saving', () => {
    const s = createSprite({ name: 'a', width: 8, height: 8 });
    s.relief = { depth: 2, glow: ['#80e0ff'] };
    expect(deserializeSprite(JSON.parse(JSON.stringify(serializeSprite(s)))).relief).toEqual({ depth: 2, glow: ['#80e0ff'] });
  });

  it('normalizes the scene settings', () => {
    const atm = normalizeAtmosphere({ relief: { strength: 9, sun: { elevation: 1, color: 'nope', angle: 30 } } })!;
    expect(atm.relief!.strength).toBe(2);
    expect(atm.relief!.sun).toEqual({ angle: 30, elevation: 5 });
    expect(normalizeAtmosphere({ relief: {} })!.relief).toEqual({});
  });

  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-relief-'));
    ws = new Workspace(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
    const s = createSprite({ name: 'rock', width: 16, height: 16 });
    const cel = celBitmap(s, s.layers[0].id, s.frames[0].id);
    for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) setPixel(cel, x, y, BODY);
    ws.save(s, 'test');
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('set_relief stores the settings, shows the sprite lit and can be undone', async () => {
    const r = await call('set_relief', { sprite: 'rock', depth: 2, glow: ['#ffffff'] });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(r.content.some((c) => c.type === 'image')).toBe(true);
    expect(ws.load('rock').relief).toEqual({ depth: 2, glow: ['#ffffff'] });
    await call('set_relief', { sprite: 'rock', depth: 1, glow: [] });
    expect(ws.load('rock').relief).toBeUndefined();
    await call('undo', { sprite: 'rock' });
    expect(ws.load('rock').relief).toEqual({ depth: 2, glow: ['#ffffff'] });
  });
});
