import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { type Bitmap, cloneSprite, createSprite, deserializeSprite, serializeSprite, celBitmap, resizeCanvas } from '../src/core/sprite.js';
import { getPixel } from '../src/core/draw.js';
import { bakeRig, bitmapToView, drawRotated, ensureRig, renderPose, scale2x } from '../src/core/rig.js';
import { generateAnimation } from '../src/core/animate.js';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

function solid(w: number, h: number, c: number[]): Bitmap {
  const b: Bitmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) b.data.set(c, i * 4);
  return b;
}

/** 16x16 sprite: a 2x4 red body at the canvas center and a 1x3 blue arm hanging from its right edge. */
function rigged() {
  const s = createSprite({ name: 'r', width: 16, height: 16 });
  const rig = ensureRig(s);
  rig.parts.push({ name: 'body', parent: null, views: { right: bitmapToView(solid(2, 4, RED), [0, 0], [4, 4], 1) } });
  rig.parts.push({ name: 'arm', parent: 'body', views: { right: bitmapToView(solid(1, 3, BLUE), [0, 0], [1, 0], 2) } });
  return s;
}

describe('rig core', () => {
  it('scale2x doubles and keeps flat areas', () => {
    const b = scale2x(solid(2, 2, RED));
    expect(b.width).toBe(4);
    expect(getPixel(b, 3, 3)).toEqual(RED);
  });

  it('rotates by 90° exactly around the pivot', () => {
    const dst: Bitmap = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
    drawRotated(dst, solid(1, 3, BLUE), [0, 0], 4, 4, 90);
    // A vertical bar hanging down, rotated clockwise 90°, points left.
    expect(getPixel(dst, 4, 4)).toEqual(BLUE);
    expect(getPixel(dst, 2, 4)).toEqual(BLUE);
    expect(getPixel(dst, 4, 6)[3]).toBe(0);
  });

  it('renders children relative to the parent and mirrors left from right', () => {
    const s = rigged();
    const right = renderPose(s, { facing: 'right', parts: {} });
    expect(getPixel(right, 4, 4)).toEqual(RED);
    expect(getPixel(right, 5, 4)).toEqual(BLUE); // arm drawn above the body (z 2)
    const left = renderPose(s, { facing: 'left', parts: {} });
    // Mirrored around the canvas: x' = 15 - x.
    expect(getPixel(left, 11, 4)).toEqual(RED);
    expect(getPixel(left, 10, 4)).toEqual(BLUE);
    expect(renderPose(s, { facing: 'up', parts: {} }).data.some((v) => v > 0)).toBe(false);
  });

  it('moves children with the parent offset and rotation', () => {
    const s = rigged();
    const moved = renderPose(s, { facing: 'right', parts: { body: { dy: 2 } } });
    expect(getPixel(moved, 5, 6)).toEqual(BLUE);
    const rotated = renderPose(s, { facing: 'right', parts: { arm: { rot: -90 } } });
    // Counter-clockwise 90°: the arm points right from (5,4).
    expect(getPixel(rotated, 7, 4)).toEqual(BLUE);
  });

  it('keeps rig and poses through serialization, cloning and resizing', () => {
    const s = rigged();
    s.frames[0].pose = { facing: 'right', parts: { body: { dx: 1 } } };
    bakeRig(s);
    const back = deserializeSprite(JSON.parse(JSON.stringify(serializeSprite(s))));
    expect(back.rig?.parts.map((p) => p.name)).toEqual(['body', 'arm']);
    expect(back.frames[0].pose?.parts.body.dx).toBe(1);
    expect(cloneSprite(back).rig).toEqual(back.rig);
    resizeCanvas(back, 20, 20, 'top-left');
    expect(back.rig!.parts[0].views.right.at).toEqual([4, 4]);
    resizeCanvas(back, 24, 24, 'bottom-right');
    expect(back.rig!.parts[0].views.right.at).toEqual([8, 8]);
    bakeRig(back);
    expect(getPixel(celBitmap(back, back.rig!.layer, back.frames[0].id), 9, 8)).toEqual(RED);
  });

  it('generates looping walk poses for every facing', () => {
    const s = rigged();
    s.rig!.parts.push({ name: 'leg_l', parent: null, views: { right: bitmapToView(solid(1, 4, BLUE), [0, 0], [4, 8], 0) } });
    const walk = generateAnimation(s, 'walk', 'right');
    expect(walk.poses).toHaveLength(8);
    expect(walk.loop).toBe(true);
    const rots = walk.poses.map((p) => p.parts.leg_l?.rot ?? 0);
    expect(Math.max(...rots)).toBeGreaterThan(0);
    expect(Math.min(...rots)).toBeLessThan(0);
    const left = generateAnimation(s, 'walk', 'left');
    expect(left.poses[0].parts.leg_l.rot).toBe(-walk.poses[0].parts.leg_l.rot!);
  });
});

describe('rig MCP tools', () => {
  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-rig-'));
    ws = new Workspace(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('builds a character and animates it in four facings', async () => {
    expect((await call('create_character', { name: 'kid', width: 24, height: 24 })).isError).toBeFalsy();
    const legend = { o: '#1a1c2c', s: '#f4b484', b: '#3b5dc9' };
    for (const facing of ['down', 'right', 'up']) {
      const r = await call('rig_part', { sprite: 'kid', name: 'body', facing, rows: ['oooo', 'obbo', 'obbo', 'oooo'], legend, pivot: [1, 3], at: [11, 14], z: 2, preview: false });
      expect(r.isError, textOf(r)).toBeFalsy();
    }
    await call('rig_part', { sprite: 'kid', name: 'head', parent: 'body', facing: 'down', rows: ['oooo', 'osso', 'oooo'], legend, pivot: [1, 2], at: [0, -4], z: 3 });
    for (const [name, x] of [['leg_l', 12], ['leg_r', 10]] as const) {
      await call('rig_part', { sprite: 'kid', name, facing: 'down', rows: ['o', 'o', 'o'], legend, pivot: [0, 0], at: [x, 15], z: 1, preview: false });
      await call('rig_part', { sprite: 'kid', name, facing: 'right', rows: ['o', 'o', 'o'], legend, pivot: [0, 0], at: [11, 15], z: 1, preview: false });
    }
    const walk = await call('rig_animate', { sprite: 'kid', animation: 'walk' });
    expect(walk.isError, textOf(walk)).toBeFalsy();
    expect(walk.content.some((c) => c.type === 'image')).toBe(true);
    let s = ws.load('kid');
    expect(s.tags.map((t) => t.name)).toEqual(['walk_down', 'walk_left', 'walk_right', 'walk_up']);
    expect(s.frames).toHaveLength(32);

    // Regenerating replaces the frames of the tag instead of appending.
    expect((await call('rig_animate', { sprite: 'kid', animation: 'walk', facings: ['down'], frames: 4 })).isError).toBeFalsy();
    await call('rig_animate', { sprite: 'kid', animation: 'attack', facings: ['right'] });
    s = ws.load('kid');
    expect(s.frames).toHaveLength(28 + 6);
    const down = s.tags.find((t) => t.name === 'walk_down')!;
    expect(down.to - down.from).toBe(3);

    // Every frame is baked into the rig layer.
    for (const f of s.frames) expect(celBitmap(s, s.rig!.layer, f.id).data.some((v) => v > 0)).toBe(true);

    // Fixing a part re-renders all posed frames.
    await call('rig_part', { sprite: 'kid', name: 'body', facing: 'down', rows: ['bbbb', 'bbbb', 'bbbb', 'bbbb'], legend, preview: false });
    s = ws.load('kid');
    const f = s.frames[s.tags.find((t) => t.name === 'walk_down')!.from];
    expect(textOf(await call('get_sprite', { sprite: 'kid' }))).toContain('Rig: 4 part(s)');
    expect(celBitmap(s, s.rig!.layer, f.id).data.some((v, i) => i % 4 === 2 && v === 0xc9)).toBe(true);

    const pose = await call('rig_pose', { sprite: 'kid', frames: [0], parts: { head: { dy: 1 } } });
    expect(pose.isError, textOf(pose)).toBeFalsy();
    expect(ws.load('kid').frames[0].pose?.parts.head.dy).toBe(1);

    const prev = await call('preview', { sprite: 'kid', tags: ['walk_down', 'attack_right'] });
    expect(prev.isError).toBeFalsy();
  });
});
