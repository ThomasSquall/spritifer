import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { contentBounds } from '../src/core/draw.js';
import { celKey, compositeFrame, createSprite, deserializeSprite, serializeSprite } from '../src/core/sprite.js';
import { startEditorServer } from '../src/server/http.js';
import { createMcpServer } from '../src/server/mcp.js';
import { PixelLabProvider } from '../src/server/pixellab.js';
import { encodePng } from '../src/server/png.js';
import { ProjectRegistry } from '../src/server/projects.js';
import { Workspace } from '../src/server/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const api = 'https://api.pixellab.ai/v2';
const storage = 'https://supabase.pixellab.ai/storage/v1/object/public/pixellab-characters/account/character';
const directions = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const importInput = { name: 'aren', id: 'character', animations: [{ action: 'walk', groupId: 'walk-group' }] };

function png(size: number, x: number, y: number, alpha: 'clear' | 'opaque' | 'valid' = 'valid'): Buffer {
  const data = new Uint8ClampedArray(size * size * 4);
  if (alpha === 'opaque') data.fill(255);
  if (alpha === 'valid') data.set([100, 60, 20, 255], (x + y * size) * 4);
  return encodePng({ width: size, height: size, data });
}

function fixture() {
  const info = {
    id: 'character', name: 'aren', status: 'completed', directions: 8,
    rotation_urls: Object.fromEntries(directions.map((direction) => [direction, `${storage}/rotations/${direction}.png`])),
    animations: [{
      animation_type: 'custom', display_name: 'walk', animation_group_id: 'walk-group',
      directions: directions.map((direction) => ({
        direction, frame_count: 2, frames: [`${storage}/animation/0.png`, `${storage}/animation/1.png`],
      })),
    }],
  };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith(api)) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      expect(init?.redirect).toBe('error');
      if (url === `${api}/characters/character`) return Response.json(info);
      if (url === `${api}/create-character-v3` || url === `${api}/create-character-pro`) {
        return Response.json({ character_id: 'character', background_job_id: 'create-job' });
      }
      if (url === `${api}/animate-character`) {
        return Response.json({ background_job_ids: directions.map((_, i) => `job-${i}`), animation_group_id: 'walk-group' });
      }
      if (url === `${api}/background-jobs/create-job`) return Response.json({ status: 'completed' });
    }
    if (url.startsWith(storage)) {
      expect(init?.headers).toBeUndefined();
      const image = url.endsWith('/0.png') ? png(10, 4, 6) :
        url.endsWith('/1.png') ? png(10, 5, 6) :
        url.endsWith('/empty.png') ? png(8, 0, 0, 'clear') :
        url.endsWith('/opaque.png') ? png(8, 0, 0, 'opaque') :
        url.endsWith('/wrong-size.png') ? png(12, 2, 2) :
        url.endsWith('/south.png') ? png(8, 2, 5) : png(8, 4, 5);
      return new Response(new Uint8Array(image));
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  return { provider: new PixelLabProvider('test-token', request), info, request };
}

afterEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllEnvs());

describe('PixelLab provider', () => {
  it('uses the documented creation, animation and job endpoints', async () => {
    const { provider, request } = fixture();
    const reference = png(32, 15, 25).toString('base64');
    await expect(provider.create({ name: 'aren', description: 'From the supplied reference', reference: { mode: 'sprite', png: reference } }))
      .resolves.toEqual({ character_id: 'character', background_job_id: 'create-job' });
    expect(request.mock.calls[0][0]).toBe(`${api}/create-character-v3`);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
      n_directions: 8, view: 'low top-down', reference_image: { base64: `data:image/png;base64,${reference}` },
    });
    await provider.create({ name: 'aren', description: 'From the concept', reference: { mode: 'concept', png: reference } });
    expect(request.mock.calls[1][0]).toBe(`${api}/create-character-pro`);
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({
      method: 'create_from_concept', concept_image: { base64: `data:image/png;base64,${reference}` },
    });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).not.toHaveProperty('name');
    await expect(provider.job('create-job')).resolves.toEqual({ status: 'completed' });
    await expect(provider.animate({ id: 'character', action: 'interact' })).resolves.toMatchObject({ animation_group_id: 'walk-group' });
    expect(request.mock.calls[4][0]).toBe(`${api}/animate-character`);
    expect(JSON.parse(String(request.mock.calls[4][1]?.body))).toMatchObject({
      character_id: 'character', animation_name: 'interact', directions, mode: 'v3', frame_count: 4, keep_first_frame: false,
    });
  });

  it('sends a pixel style with a concept and refuses it without one', async () => {
    const { provider, request } = fixture();
    const art = png(32, 15, 25).toString('base64');
    await provider.create({ name: 'aren', description: 'Hero', reference: { mode: 'concept', png: art }, style_png: art });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).reference_image).toEqual({ base64: `data:image/png;base64,${art}` });
    request.mockClear();
    await expect(provider.create({ name: 'aren', description: 'Hero', style_png: art })).rejects.toThrow('concept reference');
    expect(request).not.toHaveBeenCalled();
  });

  it('animates custom actions on chosen directions with the requested settings', async () => {
    const { provider, request } = fixture();
    await provider.animate({ id: 'character', action: 'kneel', description: 'Kneel down', directions: ['south', 'east'], frames: 8, mode: 'pixminimax' });
    expect(JSON.parse(String(request.mock.calls[1][1]?.body))).toMatchObject({
      animation_name: 'kneel', directions: ['south', 'east'], frame_count: 8, mode: 'pixminimax',
    });
    request.mockClear();
    await expect(provider.animate({ id: 'character', action: 'kneel' })).rejects.toThrow('need a description');
    await expect(provider.animate({ id: 'character', action: 'walk', frames: 5 })).rejects.toThrow('even frame count');
    await expect(provider.animate({ id: 'character', action: 'walk', mode: 'pixminimax', frames: 6 })).rejects.toThrow('multiple of 4');
    expect(request).not.toHaveBeenCalled();
  });

  it('imports custom clips for only the chosen directions', async () => {
    const { provider, info } = fixture();
    info.animations[0].directions.splice(1);
    info.animations[0].directions[0].direction = 'east';
    await expect(provider.describe('character')).resolves.toMatchObject({ animations: [{ complete: false, directions: ['east'] }] });
    const sprite = await provider.sprite({ id: 'character', name: 'aren', animations: [{ action: 'kneel', groupId: 'walk-group', directions: ['east'], duration: 200 }] });
    expect(sprite.tags.map((tag) => tag.name)).toContain('kneel_right');
    expect(sprite.tags.map((tag) => tag.name)).not.toContain('kneel_down');
    expect(sprite.frames).toHaveLength(10);
    expect(sprite.frames[sprite.tags.find((tag) => tag.name === 'kneel_right')!.from].duration).toBe(200);
  });

  it('keeps the identity, foot pivot, motion, editable pixels and native tags', async () => {
    const { provider } = fixture();
    const sprite = deserializeSprite(serializeSprite(await provider.sprite(importInput)));
    expect(sprite.pixelLabCharacterId).toBe('character');
    expect(sprite.frames).toHaveLength(24);
    expect(sprite.layers[0].name).toBe('PixelLab');
    expect(sprite.tags.map((tag) => tag.name)).toContain('walk_up_right');
    expect(sprite.tags.find((tag) => tag.name === 'walk_down')).toMatchObject({ from: 1, to: 2 });
    expect(sprite.frames[1].duration).toBe(120);
    const down = contentBounds(compositeFrame(sprite, 0));
    expect(down).toEqual(contentBounds(compositeFrame(sprite, 3)));
    expect(down?.x).toBe(Math.floor(sprite.width / 2));
    const a = contentBounds(compositeFrame(sprite, 1))!;
    const b = contentBounds(compositeFrame(sprite, 2))!;
    expect(b.x - a.x).toBe(1);
    expect(b.y).toBe(a.y);
  });

  it('rejects incomplete groups before downloading frames', async () => {
    const { provider, info, request } = fixture();
    info.animations[0].directions.pop();
    await expect(provider.describe('character')).resolves.toMatchObject({ animations: [{ complete: false }] });
    await expect(provider.sprite(importInput)).rejects.toThrow('missing directions or frames');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty.png', 'empty frame'],
    ['opaque.png', 'no transparent pixels'],
    ['wrong-size.png', 'inconsistent frame dimensions'],
  ])('rejects invalid generated frame %s', async (file, error) => {
    const { provider, info } = fixture();
    info.animations[0].directions[0].frames[1] = `${storage}/${file}`;
    await expect(provider.sprite(importInput)).rejects.toThrow(error);
  });

  it('downloads frames from the Backblaze character store too', async () => {
    const { provider, info, request } = fixture();
    const backblaze = 'https://backblaze.pixellab.ai/file/pixellab-characters/account/character/rotations/south.png?Authorization=token';
    info.rotation_urls.south = backblaze;
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (input, init) => String(input) === backblaze ? new Response(new Uint8Array(png(8, 2, 5))) : original(input, init));
    await expect(provider.sprite(importInput)).resolves.toMatchObject({ name: 'aren' });
    expect(request.mock.calls.some(([url]) => String(url) === backblaze)).toBe(true);
  });

  it('retries a frame after a temporary storage error', async () => {
    const { info, request } = fixture();
    const original = request.getMockImplementation()!;
    let failures = 2;
    request.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/south.png') && failures-- > 0) return new Response(null, { status: 522 });
      return original(input, init);
    });
    await expect(new PixelLabProvider('test-token', request, 0).sprite(importInput)).resolves.toMatchObject({ name: 'aren' });
    expect(info.animations).toHaveLength(1);
    expect(failures).toBeLessThan(0);
  });

  it('rejects asset URLs outside the PixelLab character store', async () => {
    const { provider, info, request } = fixture();
    info.rotation_urls.south = 'http://127.0.0.1/private';
    await expect(provider.sprite(importInput)).rejects.toThrow('Unexpected PixelLab image URL');
    expect(request.mock.calls.some(([url]) => String(url).includes('/private'))).toBe(false);
  });
});

describe('PixelLab image generation', () => {
  let dir: string;
  let workspace: Workspace;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function imageProvider() {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-pixellab-image-'));
    workspace = new Workspace(dir);
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      if (String(input) === `${api}/balance`) {
        return Response.json({ credits: { usd: 3.5 }, subscription: { status: 'active', plan: 'tier1', generations: 40, total: 100 } });
      }
      return Response.json({ image: { type: 'base64', base64: png(32, 10, 12).toString('base64') }, usage: { type: 'usd', usd: 0.01 } });
    });
    return { provider: new PixelLabProvider('test-token', request), request };
  }
  const base = { name: 'lamp', description: 'a crystal lamp', width: 32, height: 32 };
  const bodyOf = (request: ReturnType<typeof imageProvider>['request']) => JSON.parse(String(request.mock.calls[0][1]?.body));

  it('generates a transparent sprite without saving it', async () => {
    const { provider, request } = imageProvider();
    const { sprite, usage } = await provider.generateImage(workspace, { ...base, outline: 'lineless' });
    expect(request.mock.calls[0][0]).toBe(`${api}/create-image-pixflux`);
    expect(bodyOf(request)).toEqual({
      description: 'a crystal lamp', outline: 'lineless', image_size: { width: 32, height: 32 }, no_background: true,
    });
    expect([sprite.name, sprite.width, sprite.height, sprite.layers[0].name]).toEqual(['lamp', 32, 32, 'PixelLab']);
    expect(sprite.palette).toEqual(['#643c14']);
    expect(usage?.usd).toBe(0.01);
    expect(workspace.exists('lamp')).toBe(false);
  });

  it('sends project sprites as style and palette references', async () => {
    const { provider, request } = imageProvider();
    workspace.save((await provider.generateImage(workspace, { ...base, name: 'style' })).sprite, 'test');
    request.mockClear();
    await provider.generateImage(workspace, { ...base, model: 'bitforge', style_sprite: 'style', palette_sprite: 'style' });
    expect(request.mock.calls[0][0]).toBe(`${api}/create-image-bitforge`);
    const body = bodyOf(request);
    expect(body.style_strength).toBe(50);
    expect(body.style_image).toMatchObject({ type: 'base64', format: 'png' });
    expect(body.color_image.base64).toBe(body.style_image.base64);
  });

  it.each([
    [{ width: 16, height: 16 }, 'at least 32×32'],
    [{ width: 256, height: 256 }, 'transparent only up to 40,000'],
    [{ model: 'bitforge', width: 256, height: 64 }, 'bitforge needs sides'],
    [{ model: 'pixen', width: 34, height: 32 }, 'divisible by 4'],
    [{ model: 'pixen', width: 16, height: 32 }, 'must be square'],
    [{ model: 'pixen', shading: 'flat shading' }, 'does not support shading'],
    [{ style_sprite: 'other' }, 'requires the bitforge model'],
  ])('refuses %o before spending credits', async (options, error) => {
    const { provider, request } = imageProvider();
    await expect(provider.generateImage(workspace, { ...base, ...options })).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });

  it('never replaces an existing sprite or calls the API for one', async () => {
    const { provider, request } = imageProvider();
    workspace.save((await provider.generateImage(workspace, base)).sprite, 'test');
    request.mockClear();
    await expect(provider.generateImage(workspace, base)).rejects.toThrow('already exists');
    expect(request).not.toHaveBeenCalled();
  });

  it('saves through the MCP tool, previews the result and can be undone', async () => {
    const { request } = imageProvider();
    vi.stubGlobal('fetch', request);
    vi.stubEnv('PIXELLAB_API_KEY', 'test-token');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(workspace).connect(a), client.connect(b)]);
    try {
      const result = await client.callTool({ name: 'pixellab_generate_image', arguments: base }) as { isError?: boolean; content: { type: string; text?: string }[] };
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('lamp: 32×32, 1 colors, cost: $0.01');
      expect(result.content[1].type).toBe('image');
      expect(workspace.readRaw('lamp').updatedBy).toBe('pixellab');
      await client.callTool({ name: 'undo', arguments: { sprite: 'lamp' } });
      expect(workspace.exists('lamp')).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('reports the balance', async () => {
    const { provider } = imageProvider();
    await expect(provider.balance()).resolves.toMatchObject({ credits: { usd: 3.5 }, subscription: { generations: 40 } });
  });
});

it('previews and saves the same native sprite through the local editor API, without replacing existing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-pixellab-'));
  const workspace = new Workspace(path.join(dir, 'project'));
  const registry = new ProjectRegistry({ root: dir, defaultDir: workspace.dir });
  const { request } = fixture();
  const localFetch = fetch;
  vi.stubGlobal('fetch', request);
  vi.stubEnv('PIXELLAB_API_KEY', 'test-token');
  const server = await startEditorServer(workspace, 0, '127.0.0.1', { registry });
  try {
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TCP port');
    const base = `http://127.0.0.1:${address.port}/api/pixellab`;
    const post = (route: string, body: unknown, origin?: string) => localFetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
    expect(await (await localFetch(base + '/config')).json()).toEqual({ configured: true });
    expect((await post('/create', {}, 'https://another.example')).status).toBe(403);
    expect(request).not.toHaveBeenCalled();
    const preview = await post('/preview', importInput);
    expect(preview.status).toBe(200);
    const file = await preview.json();
    expect(workspace.exists('aren')).toBe(false);
    const results = await Promise.all([post('/import', file), post('/import', file)]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(workspace.readRaw('aren')).toEqual({ ...file, rev: expect.any(String), updatedBy: 'pixellab' });
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('PixelLab tilesets', () => {
  let dir: string;
  let workspace: Workspace;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const cornersOf = (mask: number) => ({
    NW: mask & 8 ? 'upper' : 'lower', NE: mask & 4 ? 'upper' : 'lower',
    SW: mask & 2 ? 'upper' : 'lower', SE: mask & 1 ? 'upper' : 'lower',
  });
  const tile = (mask: number) => ({ corners: cornersOf(mask), image: { type: 'base64', base64: png(8, mask % 8, mask >> 3).toString('base64') } });
  // PixelLab returns the tiles in no useful order.
  const tiles = Array.from({ length: 16 }, (_, i) => tile((i * 5 + 3) % 16));

  function tilesetProvider(status = 200, result: unknown = { tileset: { tiles } }) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-pixellab-tileset-'));
    workspace = new Workspace(path.join(dir, 'project'));
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
      if (String(input) === `${api}/create-tileset`) return Response.json({ usage: null, background_job_id: 'job', tileset_id: 'set', status: 'processing' }, { status: 202 });
      if (String(input) === `${api}/tilesets/set`) return Response.json(result, { status });
      throw new Error(`Unexpected request: ${input}`);
    });
    return { provider: new PixelLabProvider('test-token', request), request };
  }
  const base = { name: 'ground', lower_description: 'grass', upper_description: 'cobble' };
  const bodyOf = (request: ReturnType<typeof tilesetProvider>['request']) => JSON.parse(String(request.mock.calls[0][1]?.body));

  it('starts a 32 px pro set with the requested look', async () => {
    const { provider, request } = tilesetProvider();
    await expect(provider.createTileset(workspace, { ...base, view: 'low top-down', raggedness: 0.5, colors: ['#112233', '#445566'] }))
      .resolves.toEqual({ tileset_id: 'set', background_job_id: 'job', name: 'ground' });
    expect(bodyOf(request)).toEqual({
      lower_description: 'grass', upper_description: 'cobble', transition_description: '', mode: 'pro', view: 'low top-down', raggedness: 0.5,
      transition_size: 0, tile_size: { width: 32, height: 32 }, target_palette: { colors: ['#112233', '#445566'] },
    });
  });

  it('takes the palette from a project sprite', async () => {
    const { provider, request } = tilesetProvider();
    const painted = (name: string, pixels: number[]) => {
      const sprite = createSprite({ name, width: 2, height: 2 });
      sprite.cels.set(celKey(sprite.layers[0].id, sprite.frames[0].id), new Uint8ClampedArray(pixels));
      workspace.save(sprite, 'test');
    };
    painted('source', [17, 34, 51, 255, 17, 34, 51, 255, 68, 85, 102, 255, 0, 0, 0, 0]);
    await provider.createTileset(workspace, { ...base, palette_sprite: 'source' });
    expect(bodyOf(request).target_palette).toEqual({ colors: ['#112233', '#445566'] });
    request.mockClear();
    painted('flat', [17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255]);
    await expect(provider.createTileset(workspace, { ...base, palette_sprite: 'flat' })).rejects.toThrow('at least two colors');
    expect(request).not.toHaveBeenCalled();
  });

  it('sends tiles of a project sheet as terrain references', async () => {
    const { provider, request } = tilesetProvider();
    const sheet = await provider.tilesetSprite(workspace, { id: 'set', name: 'sheet' });
    workspace.save(sheet, 'test');
    await provider.createTileset(workspace, { ...base, tile_size: 16, lower_reference: { sprite: 'sheet', tile: 0 } }).catch((err) => expect(String(err)).toContain('16×16'));
    request.mockClear();
    const sized = createSprite({ name: 'terrain', width: 32, height: 16, grid: { width: 16, height: 16 } });
    sized.cels.set(celKey(sized.layers[0].id, sized.frames[0].id), Object.assign(new Uint8ClampedArray(32 * 16 * 4), { 16: 9, 19: 255 }));
    workspace.save(sized, 'test');
    await provider.createTileset(workspace, { ...base, tile_size: 16, upper_reference: { sprite: 'terrain', tile: 0 } });
    expect(bodyOf(request).upper_reference_image).toMatchObject({ type: 'base64', format: 'png' });
    expect(bodyOf(request)).not.toHaveProperty('lower_reference_image');
    await expect(provider.createTileset(workspace, { ...base, tile_size: 16, lower_reference: { sprite: 'terrain', tile: 2 } })).rejects.toThrow('has no tile 2');
  });

  it.each([
    [{ mode: 'standard', tile_size: 64 }, '64 px tiles require pro'],
    [{ mode: 'standard', view: 'low top-down' }, 'always draws high top-down'],
    [{ mode: 'standard', raggedness: 0.4 }, 'raggedness requires pro'],
    [{ mode: 'standard', colors: ['#000000', '#ffffff'] }, 'Palettes require pro'],
    [{ colors: ['#000000', '#ffffff'], palette_sprite: 'a' }, 'not both'],
    [{ transition_size: 0.5 }, 'must be 0 or 0.25'],
  ])('refuses %o before spending credits', async (options, error) => {
    const { provider, request } = tilesetProvider();
    await expect(provider.createTileset(workspace, { ...base, ...options })).rejects.toThrow(error);
    expect(request).not.toHaveBeenCalled();
  });

  it('places every tile by its corners, on a tile grid, without saving', async () => {
    const { provider } = tilesetProvider();
    const sprite = await provider.tilesetSprite(workspace, { id: 'set', name: 'ground' });
    expect([sprite.width, sprite.height, sprite.grid, sprite.layers[0].name]).toEqual([32, 32, { width: 8, height: 8 }, 'PixelLab']);
    const sheet = compositeFrame(sprite, 0);
    for (let mask = 0; mask < 16; mask++) {
      const x = (mask % 4) * 8 + mask % 8, y = Math.floor(mask / 4) * 8 + (mask >> 3);
      expect(sheet.data[(x + y * 32) * 4 + 3]).toBe(255);
    }
    expect(contentBounds(sheet)).not.toBeNull();
    expect(workspace.exists('ground')).toBe(false);
  });

  it('explains a set that is still running', async () => {
    const { provider } = tilesetProvider(423, {});
    await expect(provider.tilesetSprite(workspace, { id: 'set', name: 'ground' })).rejects.toThrow('still being generated');
  });

  it('refuses sets without the 16 corner tiles', async () => {
    const { provider } = tilesetProvider(200, { tileset: { tiles: [...tiles, tile(0)] } });
    await expect(provider.tilesetSprite(workspace, { id: 'set', name: 'ground' })).rejects.toThrow('Only 16-tile sets');
    const { provider: duplicated } = tilesetProvider(200, { tileset: { tiles: [...tiles.slice(1), tiles[2]] } });
    await expect(duplicated.tilesetSprite(workspace, { id: 'set', name: 'ground' })).rejects.toThrow('duplicate tile corners');
  });

  it('works through the MCP tools', async () => {
    const { request } = tilesetProvider();
    vi.stubGlobal('fetch', request);
    vi.stubEnv('PIXELLAB_API_KEY', 'test-token');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(workspace).connect(a), client.connect(b)]);
    type Result = { isError?: boolean; content: { type: string; text?: string }[] };
    try {
      const created = await client.callTool({ name: 'pixellab_create_tileset', arguments: base }) as Result;
      expect(created.isError).toBeUndefined();
      expect(JSON.parse(created.content[0].text!)).toMatchObject({ tileset_id: 'set', background_job_id: 'job' });
      expect(workspace.exists('ground')).toBe(false);
      const imported = await client.callTool({ name: 'pixellab_import_tileset', arguments: { id: 'set', name: 'ground' } }) as Result;
      expect(imported.isError).toBeUndefined();
      expect(imported.content[0].text).toContain('16 tiles of 8×8');
      expect(imported.content[1].type).toBe('image');
      expect(workspace.readRaw('ground').updatedBy).toBe('pixellab');
      const again = await client.callTool({ name: 'pixellab_import_tileset', arguments: { id: 'set', name: 'ground' } }) as Result;
      expect(again.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('works through the local editor API', async () => {
    const { request } = tilesetProvider();
    const registry = new ProjectRegistry({ root: dir, defaultDir: workspace.dir });
    const localFetch = fetch;
    vi.stubGlobal('fetch', request);
    vi.stubEnv('PIXELLAB_API_KEY', 'test-token');
    const server = await startEditorServer(workspace, 0, '127.0.0.1', { registry });
    try {
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing TCP port');
      const post = (route: string, body: unknown, origin?: string) => localFetch(`http://127.0.0.1:${address.port}/api/pixellab${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
      });
      expect((await post('/tileset', base, 'https://another.example')).status).toBe(403);
      expect(request).not.toHaveBeenCalled();
      expect((await post('/tileset', base)).status).toBe(202);
      expect((await post('/tileset-import', { id: 'set', name: 'ground' })).status).toBe(201);
      expect(workspace.readRaw('ground').updatedBy).toBe('pixellab');
    } finally {
      await server.close();
    }
  });
});
