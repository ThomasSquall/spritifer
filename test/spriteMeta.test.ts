import { describe, expect, it } from 'vitest';
import { type Bitmap, createSprite } from '../src/core/sprite.js';
import { getPixel } from '../src/core/draw.js';
import { bakeRig, ensureRig, layoutPose, restPose } from '../src/core/rig.js';
import { attachReference, editGuide, preparePicture, referencePixels, removeBone, renameJoint, renameRamp, setRamp } from '../src/core/reference.js';
import { animateRig, keyframeRig, movePivot, poseFrames, removeRigPart, renameRigPart, reparentPart, setPartPose, setRigPart, writeTagFrames } from '../src/core/rigEdit.js';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

function solid(w: number, h: number, c: number[]): Bitmap {
  const b: Bitmap = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) b.data.set(c, i * 4);
  return b;
}

function character() {
  const s = createSprite({ name: 'c', width: 16, height: 16 });
  setRigPart(s, { name: 'body', facing: 'down', bitmap: solid(2, 4, RED), pivot: [0, 3], at: [7, 10], z: 2 });
  setRigPart(s, { name: 'arm_r', facing: 'down', parent: 'body', bitmap: solid(1, 3, BLUE), pivot: [0, 0], at: [2, -3], z: 3 });
  return s;
}

describe('reference helpers', () => {
  it('crops, removes the background and places the picture at the bottom center', () => {
    const pic = solid(20, 20, WHITE);
    for (let y = 5; y < 15; y++) for (let x = 8; x < 12; x++) pic.data.set(RED, (y * 20 + x) * 4);
    const src = preparePicture(pic, { x: 6, y: 4, width: 8, height: 12 }, true);
    expect(src.width).toBe(8);
    expect(getPixel(src, 0, 0)[3]).toBe(0);
    expect(getPixel(src, 3, 5)).toEqual(RED);
    const s = createSprite({ name: 'r', width: 16, height: 16 });
    const placed = attachReference(s, src, 12);
    expect(placed).toEqual({ w: 8, h: 12, x: 4, y: 4 });
    const ref = referencePixels(s.reference!);
    expect(ref.width).toBe(8);
    expect(getPixel(ref, 3, 5)).toEqual(RED);
    expect(s.reference!.source).toBeTruthy();
  });
});

describe('pose guide helpers', () => {
  it('connects standard bones automatically and keeps custom ones', () => {
    const s = createSprite({ name: 'g', width: 16, height: 16 });
    editGuide(s, { joints: { head: [8, 2], neck: [8, 4], tail: [3, 12] } });
    expect(s.guide!.bones).toEqual([['head', 'neck']]);
    editGuide(s, { joints: { pelvis: [8, 9] }, bones: [['pelvis', 'tail'], ['pelvis', 'tail']] });
    expect(s.guide!.bones).toEqual([['head', 'neck'], ['neck', 'pelvis'], ['pelvis', 'tail']]);
    renameJoint(s, 'tail', 'tail_tip');
    expect(s.guide!.joints.tail_tip).toEqual([3, 12]);
    expect(s.guide!.bones).toContainEqual(['pelvis', 'tail_tip']);
    expect(() => removeBone(s, 'head', 'neck')).toThrow(/standard/);
    removeBone(s, 'pelvis', 'tail_tip');
    expect(s.guide!.bones).toHaveLength(2);
    editGuide(s, { remove: ['neck'] });
    expect(s.guide!.bones).toEqual([]);
    expect(editGuide(s, { clear: true })).toBeNull();
    expect(s.guide).toBeNull();
  });
});

describe('ramp helpers', () => {
  it('stores ramps, adds colors to the palette and renames in place', () => {
    const s = createSprite({ name: 'p', width: 4, height: 4, palette: ['#000000'] });
    setRamp(s, 'skin', ['#331100', '#AA6644', '#ffccaa']);
    setRamp(s, 'cloth', ['#112233']);
    expect(s.ramps.skin).toEqual(['#331100', '#aa6644', '#ffccaa']);
    expect(s.palette).toContain('#aa6644');
    renameRamp(s, 'skin', 'face');
    expect(Object.keys(s.ramps)).toEqual(['face', 'cloth']);
    expect(() => setRamp(s, '1bad', ['#000000'])).toThrow();
    expect(() => renameRamp(s, 'face', 'cloth')).toThrow(/exists/);
  });
});

describe('rig editing helpers', () => {
  it('setRigPart creates parts, poses the first frame and bakes it', () => {
    const s = character();
    expect(s.rig!.parts.map((p) => p.name)).toEqual(['body', 'arm_r']);
    expect(s.frames[0].pose).toEqual(restPose('down'));
    const layer = s.rig!.layer;
    const cel = s.cels.get(`${layer}/${s.frames[0].id}`)!;
    const px = (x: number, y: number) => [...cel.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(px(7, 7)).toEqual(RED); // body top-left = at - pivot
    expect(px(9, 7)).toEqual(BLUE); // arm at body pivot + (2, -3)
    expect(() => setRigPart(s, { name: 'leg', facing: 'down', bitmap: solid(1, 1, RED) })).toThrow(/pivot/);
    expect(() => setRigPart(s, { name: 'body', facing: 'down', parent: 'arm_r' })).toThrow(/cycle/);
  });

  it('poses frames, edits a single part pose and appends posed frames', () => {
    const s = character();
    expect(poseFrames(s, { frames: [0], parts: { arm_r: { rot: 90 } } })).toEqual([0]);
    expect(poseFrames(s, { frames: [0], parts: { arm_r: { dy: 1 } } })).toEqual([0]);
    expect(s.frames[0].pose!.parts.arm_r).toEqual({ rot: 90, dy: 1 });
    setPartPose(s, 0, 'arm_r', { dx: 0, dy: 2, sx: 1, variant: '', z: undefined });
    expect(s.frames[0].pose!.parts.arm_r).toEqual({ dy: 2 });
    setPartPose(s, 0, 'arm_r', {});
    expect(s.frames[0].pose!.parts.arm_r).toBeUndefined();
    poseFrames(s, { new: true, facing: 'right' });
    expect(s.frames).toHaveLength(2);
    expect(s.frames[1].pose!.facing).toBe('right');
    expect(() => poseFrames(s, { frames: [0], parts: { nope: {} } })).toThrow(/No rig part/);
  });

  it('moves a pivot without moving the art and keeps children attached', () => {
    const s = character();
    const before = new Uint8ClampedArray(s.cels.get(`${s.rig!.layer}/${s.frames[0].id}`)!);
    movePivot(s, 'body', 'down', [1, 0]);
    const body = s.rig!.parts[0].views.down;
    expect(body.pivot).toEqual([1, 0]);
    expect(body.at).toEqual([8, 7]);
    expect(s.rig!.parts[1].views.down.at).toEqual([1, 0]);
    expect(s.cels.get(`${s.rig!.layer}/${s.frames[0].id}`)).toEqual(before);
  });

  it('reparents in place, renames parts with their poses and removes parts', () => {
    const s = character();
    poseFrames(s, { frames: [0], parts: { arm_r: { dy: 1 } } });
    const world = () => {
      const q = layoutPose(s, restPose('down')).find((p) => p.part.name.startsWith('arm'))!;
      return [q.x, q.y];
    };
    const w0 = world();
    reparentPart(s, 'arm_r', null);
    expect(s.rig!.parts[1].parent).toBeNull();
    expect(world()).toEqual(w0);
    reparentPart(s, 'arm_r', 'body');
    expect(s.rig!.parts[1].views.down.at).toEqual([2, -3]);
    renameRigPart(s, 'arm_r', 'arm_l');
    expect(s.frames[0].pose!.parts).toEqual({ arm_l: { dy: 1 } });
    removeRigPart(s, 'body');
    expect(s.rig!.parts.map((p) => [p.name, p.parent])).toEqual([['arm_l', null]]);
  });

  it('generates and keyframes animations into tags', () => {
    const s = character();
    setRigPart(s, { name: 'leg_l', facing: 'down', bitmap: solid(1, 3, RED), pivot: [0, 0], at: [7, 11], z: 1 });
    expect(animateRig(s, 'walk', ['down'], { frames: 4 })).toEqual(['walk_down']);
    expect(s.tags.find((t) => t.name === 'walk_down')).toMatchObject({ from: 0, to: 3 });
    keyframeRig(s, { name: 'wave', facing: 'down', frames: 5, keys: [{ frame: 0, parts: { arm_r: { rot: 0 } } }, { frame: 4, parts: { arm_r: { rot: 80 } }, ease: 'linear' }] });
    const t = s.tags.find((x) => x.name === 'wave')!;
    expect(t.to - t.from).toBe(4);
    expect(s.frames[t.from + 2].pose!.parts.arm_r.rot).toBe(40);
    // Regenerating replaces the tag's frames.
    const n = s.frames.length;
    writeTagFrames(s, 'wave', [restPose('down')], [100]);
    expect(s.frames.length).toBe(n - 4);
    expect(bakeRig(s)).toBe(s.frames.length);
    ensureRig(s);
  });
});
