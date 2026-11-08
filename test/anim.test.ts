import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { type Bitmap, type Sprite, createSprite, setTag, addFrame, celBitmap } from '../src/core/sprite.js';
import { getPixel, setPixel } from '../src/core/draw.js';
import { solveTwoBone } from '../src/core/ik.js';
import { bakeRig, bitmapToView, ensureRig, layoutPose, limbChain, renderPose, restPose } from '../src/core/rig.js';
import { animateRig, keyframeRig, poseFrames, setRigFinish, splitLimb } from '../src/core/rigEdit.js';
import { bodyPlan, generateAnimation, interpolateIK } from '../src/core/animate.js';
import { checkAnimation, formatAnimReport, renderMotionMap } from '../src/core/animCheck.js';

const OUT: [number, number, number, number] = [10, 10, 20, 255];
const SKIN: [number, number, number, number] = [240, 190, 150, 255];
const CLOTH: [number, number, number, number] = [50, 90, 200, 255];

/** A w×h drawing with a 1px outline. */
function boxed(w: number, h: number, fill = CLOTH): Bitmap {
  const b: Bitmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) setPixel(b, x, y, x === 0 || y === 0 || x === w - 1 || y === h - 1 ? OUT : fill);
  return b;
}

/** A side-view biped: legs hang from the hips, arms from the shoulders, weapon held at the end of the right arm. */
function biped(): Sprite {
  const s = createSprite({ name: 'hero', width: 48, height: 48 });
  const rig = ensureRig(s);
  for (const facing of ['right', 'down'] as const) {
    const add = (name: string, parent: string | null, b: Bitmap, pivot: [number, number], at: [number, number], z: number) => {
      let part = rig.parts.find((p) => p.name === name);
      if (!part) rig.parts.push((part = { name, parent, views: {} }));
      part.views[facing] = bitmapToView(b, pivot, at, z);
    };
    add('body', null, boxed(8, 10), [3, 9], [23, 30], 2);
    add('head', 'body', boxed(10, 9, SKIN), [4, 8], [0, -9], 4);
    add('leg_l', null, boxed(4, 12), [1, 0], [22, 30], 1);
    add('leg_r', null, boxed(4, 12), [1, 0], [25, 30], 1.5);
    add('arm_r', 'body', boxed(3, 10, SKIN), [1, 0], [0, -8], 3);
    add('arm_l', 'body', boxed(3, 10, SKIN), [1, 0], [2, -8], 1);
    add('weapon', 'arm_r', boxed(3, 12, [220, 220, 240, 255]), [1, 0], [0, 8], 2.9);
  }
  s.frames[0].pose = restPose('right');
  bakeRig(s);
  return s;
}

const same = (a: Bitmap, b: Bitmap) => Buffer.from(a.data).equals(Buffer.from(b.data));
const splitAll = (s: Sprite) => ['arm_r', 'arm_l', 'leg_r', 'leg_l'].forEach((n) => splitLimb(s, n));
const worstIssues = (s: Sprite, tag: string) => checkAnimation(s, tag).issues.filter((i) => i.severity === 'error');

describe('two-bone IK', () => {
  const tipOf = (u: [number, number], v: [number, number], upper: number, lower: number) => {
    const a = (upper * Math.PI) / 180;
    const b = ((upper + lower) * Math.PI) / 180;
    return [u[0] * Math.cos(a) - u[1] * Math.sin(a) + v[0] * Math.cos(b) - v[1] * Math.sin(b), u[0] * Math.sin(a) + u[1] * Math.cos(a) + v[0] * Math.sin(b) + v[1] * Math.cos(b)];
  };

  it('reaches a target and bends to the requested side', () => {
    const u: [number, number] = [0, 6];
    const v: [number, number] = [0, 6];
    for (const bend of [1, -1] as const) {
      const sol = solveTwoBone(u, v, [3, 9], bend);
      expect(sol.reached).toBe(true);
      const [x, y] = tipOf(u, v, sol.upper, sol.lower);
      expect(x).toBeCloseTo(3, 5);
      expect(y).toBeCloseTo(9, 5);
    }
    // A knee facing +x: the middle joint of a limb pointing down moves right.
    const knee = solveTwoBone(u, v, [0, 10], -1);
    expect(-6 * Math.sin((knee.upper * Math.PI) / 180)).toBeGreaterThan(0);
  });

  it('stretches toward targets out of reach', () => {
    const sol = solveTwoBone([0, 5], [0, 5], [0, 30], 1);
    expect(sol.reached).toBe(false);
    expect(Math.abs(sol.upper)).toBeLessThan(1);
    expect(Math.abs(sol.lower)).toBeLessThan(1);
  });
});

describe('limb segments', () => {
  it('splitting keeps the rest pose exactly and moves the held weapon to the forearm', () => {
    const s = biped();
    const before = (['right', 'down'] as const).map((f) => renderPose(s, restPose(f)));
    splitAll(s);
    (['right', 'down'] as const).forEach((f, i) => expect(same(renderPose(s, restPose(f)), before[i])).toBe(true));
    const parts = s.rig!.parts;
    expect(parts.find((p) => p.name === 'shin_l')?.parent).toBe('leg_l');
    expect(parts.find((p) => p.name === 'foot_l')?.parent).toBe('shin_l');
    expect(parts.find((p) => p.name === 'weapon')?.parent).toBe('forearm_r');
    expect(limbChain(s, 'right', 'leg_l')?.tip).toBe('foot_l');
    expect(limbChain(s, 'left', 'leg_l')).not.toBeNull();
    expect(() => splitLimb(s, 'leg_l')).toThrow(/already split/);
  });

  it('solves a limb to a canvas position and keeps the foot level', () => {
    const s = biped();
    splitAll(s);
    poseFrames(s, { frames: [0], ik: { leg_l: { x: 24, y: 37 } } });
    const pose = s.frames[0].pose!;
    const foot = layoutPose(s, pose).find((p) => p.part.name === 'foot_l')!;
    expect(foot.x).toBeCloseTo(24, 0);
    expect(foot.y).toBeCloseTo(37, 0);
    expect(foot.rot).toBeCloseTo(0, 0);
    expect(() => poseFrames(biped(), { frames: [0], ik: { leg_l: { x: 1, y: 1 } } })).toThrow(/split/);
  });

  it('interpolates IK targets in screen space', () => {
    const path = interpolateIK([{ frame: 0, parts: {}, ease: 'linear', ik: { leg_l: { x: 10, y: 40 } } }, { frame: 4, parts: {}, ik: { leg_l: { x: 20, y: 40 } } }], 5, false);
    expect(path.map((p) => p.leg_l.x)).toEqual([10, 12.5, 15, 17.5, 20]);
    const s = biped();
    splitAll(s);
    keyframeRig(s, { name: 'step', facing: 'right', frames: 3, keys: [{ frame: 0, parts: {}, ik: { leg_l: { x: 21, y: 40 } } }, { frame: 2, parts: {}, ik: { leg_l: { x: 25, y: 40 } } }] });
    expect(s.tags.some((t) => t.name === 'step')).toBe(true);
  });

  it('joints stay at a constant distance from the parent pixel', () => {
    const s = biped();
    // Hips on half pixels would round differently from the head in world space.
    for (const dx of [0.4, 0.6, 1.4, 1.6]) {
      const placed = layoutPose(s, { facing: 'right', parts: { body: { dx } } });
      const body = placed.find((p) => p.part.name === 'body')!;
      const head = placed.find((p) => p.part.name === 'head')!;
      expect(head.px - body.px).toBe(0);
    }
  });
});

describe('generated motion', () => {
  it('walks with planted feet and a weight shift, passing every check', () => {
    const s = biped();
    splitAll(s);
    animateRig(s, 'walk', ['right']);
    const report = checkAnimation(s, 'walk_right');
    expect(report.issues.filter((i) => i.severity !== 'info'), formatAnimReport(report)).toEqual([]);
    expect(report.metrics.bob).toBeGreaterThan(0.5);
    // Durations are not all the same.
    const tag = s.tags.find((t) => t.name === 'walk_right')!;
    expect(new Set(s.frames.slice(tag.from, tag.to + 1).map((f) => f.duration)).size).toBeGreaterThan(1);
  });

  it('keeps the planted foot on one ground row', () => {
    const s = biped();
    splitAll(s);
    const walk = generateAnimation(s, 'walk', 'right');
    const soles = walk.poses.map((pose) => layoutPose(s, pose).find((p) => p.part.name === 'foot_l')!.py);
    const stance = soles.slice(0, 4);
    expect(new Set(stance).size).toBe(1);
  });

  it('mirrors left from right exactly', () => {
    const s = biped();
    const walk = generateAnimation(s, 'walk', 'right');
    const left = generateAnimation(s, 'walk', 'left');
    expect(left.poses[0].parts.leg_l.rot).toBe(-walk.poses[0].parts.leg_l.rot!);
    splitAll(s);
    const a = generateAnimation(s, 'run', 'right');
    const b = generateAnimation(s, 'run', 'left');
    expect(b.poses[1].parts.shin_l.rot).toBe(-a.poses[1].parts.shin_l.rot!);
  });

  it('generates every animation in every facing without detaching', () => {
    const s = biped();
    splitAll(s);
    for (const a of ['idle', 'walk', 'run', 'attack', 'hurt', 'jump', 'fall', 'land'] as const) {
      const tags = animateRig(s, a, ['right', 'down', 'left']);
      for (const t of tags) expect(worstIssues(s, t), t).toEqual([]);
    }
  });

  it('honors style and custom tag names', () => {
    const s = biped();
    splitAll(s);
    const heavy = generateAnimation(s, 'walk', 'right', { style: 'heavy' });
    const light = generateAnimation(s, 'walk', 'right', { style: 'light' });
    expect(heavy.durations[0]).toBeGreaterThan(light.durations[0]);
    expect(animateRig(s, 'run', ['right'], { tag: 'run' })).toEqual(['run']);
    expect(() => animateRig(s, 'run', ['right', 'down'], { tag: 'x' })).toThrow(/single facing/);
  });

  it('animates a limbless rig by squash and stretch, grounded', () => {
    const s = createSprite({ name: 'slime', width: 32, height: 32 });
    const rig = ensureRig(s);
    rig.parts.push({ name: 'body', parent: null, views: { right: bitmapToView(boxed(14, 10), [7, 5], [16, 20], 1) } });
    s.frames[0].pose = restPose('right');
    expect(bodyPlan(s)).toBe('blob');
    const idle = generateAnimation(s, 'idle', 'right');
    expect(idle.poses.some((p) => p.parts.body.sy !== undefined && p.parts.body.sy !== 1)).toBe(true);
    animateRig(s, 'walk', ['right']);
    expect(worstIssues(s, 'walk_right')).toEqual([]);
  });

  it('gives quadrupeds a four-beat walk', () => {
    const s = createSprite({ name: 'wolf', width: 48, height: 32 });
    const rig = ensureRig(s);
    rig.parts.push({ name: 'body', parent: null, views: { right: bitmapToView(boxed(24, 8), [12, 4], [24, 16], 2) } });
    for (const [name, x] of [['leg_fl', 32], ['leg_fr', 34], ['leg_bl', 14], ['leg_br', 16]] as const) {
      rig.parts.push({ name, parent: null, views: { right: bitmapToView(boxed(3, 8), [1, 0], [x, 18], 1) } });
    }
    expect(bodyPlan(s)).toBe('quadruped');
    const walk = generateAnimation(s, 'walk', 'right');
    const rots = walk.poses[0].parts;
    expect(new Set(['leg_fl', 'leg_bl', 'leg_br', 'leg_fr'].map((n) => rots[n]?.rot ?? 0)).size).toBeGreaterThan(2);
  });
});

describe('finish', () => {
  it('closes outlines on rotated limbs and leaves unoutlined parts alone', () => {
    const s = biped();
    splitAll(s);
    const pose = { facing: 'right' as const, parts: { arm_r: { rot: 33 }, forearm_r: { rot: -40 }, leg_l: { rot: 25 }, shin_l: { rot: 30 } } };
    const edgeNotLine = (b: Bitmap) => {
      let n = 0;
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const c = getPixel(b, x, y);
        if (c[3] && c[0] !== OUT[0] && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !getPixel(b, x + dx, y + dy)[3])) n++;
      }
      return n;
    };
    const raw = renderPose(s, pose);
    setRigFinish(s, { closeOutline: true, seams: true });
    const clean = renderPose(s, pose);
    expect(edgeNotLine(clean)).toBeLessThanOrEqual(edgeNotLine(raw));
    expect(edgeNotLine(clean)).toBe(0);
    setRigFinish(s, {});
    expect(s.rig!.finish).toBeUndefined();
  });

  it('does not change a rest pose whose outlines are already closed', () => {
    const s = biped();
    const before = renderPose(s, restPose('right'));
    setRigFinish(s, { closeOutline: true });
    expect(same(renderPose(s, restPose('right')), before)).toBe(true);
  });
});

describe('anim_check', () => {
  /** Two-frame-or-more plain sprite with a square that moves as the test wants. */
  function plain(positions: [number, number][], tag = 'walk') {
    const s = createSprite({ name: 'p', width: 20, height: 20 });
    while (s.frames.length < positions.length) addFrame(s);
    positions.forEach(([x, y], i) => {
      const cel = celBitmap(s, s.layers[0].id, s.frames[i].id);
      for (let py = y; py < y + 4; py++) for (let px = x; px < x + 4; px++) setPixel(cel, px, py, CLOTH);
    });
    setTag(s, { name: tag, from: 0, to: positions.length - 1, direction: 'forward' });
    return s;
  }

  it('finds duplicated frames and missing weight on plain sprites', () => {
    const r = checkAnimation(plain([[5, 5], [5, 5], [5, 5], [5, 5]]), 'walk');
    expect(r.issues.map((i) => i.code)).toContain('duplicates');
    expect(r.issues.map((i) => i.code)).toContain('no_weight');
    expect(r.score).toBeLessThan(100);
  });

  it('finds a jump at the loop point', () => {
    const r = checkAnimation(plain([[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 5]]), 'walk', { loop: true });
    expect(r.issues.map((i) => i.code)).toContain('loop_seam');
  });

  it('finds pieces that come apart', () => {
    const s = plain([[1, 1], [2, 1], [3, 1]], 'idle');
    const cel = celBitmap(s, s.layers[0].id, s.frames[1].id);
    for (let i = 0; i < 3; i++) setPixel(cel, 15 + i, 15, CLOTH);
    const r = checkAnimation(s, 'idle');
    expect(r.issues.find((i) => i.code === 'detached')?.frames).toEqual([1]);
  });

  it('flags a strike moved only by the arm', () => {
    const s = biped();
    animateRig(s, 'attack', ['right']);
    const tag = s.tags.find((t) => t.name === 'attack_right')!;
    for (let i = tag.from; i <= tag.to; i++) delete s.frames[i].pose!.parts.body;
    expect(checkAnimation(s, 'attack_right').issues.map((i) => i.code)).toContain('stiff_body');
  });

  it('throws on unknown tags and draws a motion map', () => {
    const s = plain([[1, 1], [3, 2]]);
    expect(() => checkAnimation(s, 'nope')).toThrow(/No tag/);
    const r = checkAnimation(s, 'walk');
    const map = renderMotionMap(s, r, 4);
    expect([map.width, map.height]).toEqual([80, 80]);
    expect(formatAnimReport(r)).toContain('walk: score');
  });
});

describe('animation MCP tools', () => {
  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-anim-'));
    ws = new Workspace(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
    ws.save(biped(), 'test');
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('splits, finishes, generates and checks', async () => {
    const split = await call('rig_split_limbs', { sprite: 'hero', preview: false });
    expect(split.isError, textOf(split)).toBeFalsy();
    expect(textOf(split)).toContain('leg_l → shin_l + foot_l');
    expect((await call('rig_split_limbs', { sprite: 'hero' })).isError).toBeTruthy();

    const fin = await call('rig_finish', { sprite: 'hero', seams: true, close_outline: true });
    expect(fin.isError, textOf(fin)).toBeFalsy();
    expect(ws.load('hero').rig!.finish).toEqual({ seams: true, closeOutline: true });

    const gen = await call('rig_animate', { sprite: 'hero', animation: 'jump', facings: ['right'], style: 'light', tag: 'jump', preview: false });
    expect(gen.isError, textOf(gen)).toBeFalsy();
    await call('rig_animate', { sprite: 'hero', animation: 'walk', facings: ['right'], preview: false });

    const check = await call('anim_check', { sprite: 'hero', tags: ['walk_right', 'jump'] });
    expect(check.isError, textOf(check)).toBeFalsy();
    expect(textOf(check)).toContain('walk_right: score');
    expect(check.content.filter((c) => c.type === 'image')).toHaveLength(2);

    const pose = await call('rig_pose', { sprite: 'hero', frames: [0], ik: { arm_r: { x: 30, y: 25 } }, preview: false });
    expect(pose.isError, textOf(pose)).toBeFalsy();
  });
});
