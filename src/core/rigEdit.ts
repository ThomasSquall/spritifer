/**
 * Rig editing operations shared by the MCP tools (rig_part, rig_remove_part, rig_pose, rig_animate, rig_keyframes)
 * and the web editor's rig panel. Pure and browser-safe.
 */
import { type AnimName, type AnimOptions, type Keyframe, generateAnimation, interpolateKeyframes } from './animate.js';
import { bakeRig, bitmapToView, ensureRig, findPart, layoutPose, restPose, rigFacings, topoParts, viewKey } from './rig.js';
import { type Bitmap, type Facing, type PartPose, type Pose, type Sprite, FACINGS, addFrame, removeFrame, resolveFrame, setTag } from './sprite.js';

export interface RigPartInput {
  name: string;
  facing: Facing;
  variant?: string;
  /** Parent part name, null for a root part, undefined to keep. */
  parent?: string | null;
  /** New drawing for this facing/variant; omit to only change pivot/at/z/parent. */
  bitmap?: Bitmap;
  pivot?: [number, number];
  at?: [number, number];
  z?: number;
}

/** Creates or updates one drawing of a rig part, then re-renders every posed frame. Returns the number of baked frames. */
export function setRigPart(s: Sprite, a: RigPartInput): number {
  const rig = ensureRig(s);
  let part = rig.parts.find((p) => p.name === a.name);
  if (!part) {
    if (!a.name.trim()) throw new Error('Part name is required');
    part = { name: a.name, parent: null, views: {} };
    rig.parts.push(part);
  }
  if (a.parent !== undefined) {
    if (a.parent !== null) findPart(rig, a.parent);
    if (a.parent === a.name) throw new Error('A part cannot be its own parent');
    part.parent = a.parent;
    topoParts(rig); // throws on cycles
  }
  const key = viewKey(a.facing, a.variant);
  const prev = part.views[key];
  if (a.bitmap) {
    const pivot = a.pivot ?? prev?.pivot;
    if (!pivot) throw new Error('A new drawing needs a pivot [x, y] (the joint pixel inside the part grid)');
    part.views[key] = bitmapToView(a.bitmap, pivot, a.at ?? prev?.at, a.z ?? prev?.z);
  } else {
    if (!prev) throw new Error(`Part "${a.name}" has no "${key}" drawing yet: pass rows+legend or from`);
    if (a.pivot) prev.pivot = a.pivot;
    if (a.at) prev.at = a.at;
    if (a.z !== undefined) prev.z = a.z;
  }
  if (!a.variant && !part.views[key].at) part.views[key].at = [0, 0];
  if (!s.frames.some((f) => f.pose)) s.frames[0].pose = restPose(a.facing);
  return bakeRig(s);
}

/** Deletes a rig part (its children move up to its parent), or only one of its drawings. */
export function removeRigPart(s: Sprite, name: string, facing?: Facing, variant?: string): void {
  const rig = ensureRig(s);
  const part = findPart(rig, name);
  if (facing) {
    const key = viewKey(facing, variant);
    if (!part.views[key]) throw new Error(`Part "${name}" has no "${key}" drawing`);
    delete part.views[key];
  } else {
    const children = rig.parts.filter((p) => p.parent === name);
    for (const c of children) c.parent = part.parent;
    rig.parts = rig.parts.filter((p) => p !== part);
  }
  bakeRig(s);
}

/** Renames a part: children and every frame pose follow. */
export function renameRigPart(s: Sprite, from: string, to: string): void {
  const rig = ensureRig(s);
  const part = findPart(rig, from);
  if (from === to) return;
  if (!to.trim()) throw new Error('Part name is required');
  if (rig.parts.some((p) => p.name === to)) throw new Error(`A part named "${to}" already exists`);
  part.name = to;
  for (const p of rig.parts) if (p.parent === from) p.parent = to;
  for (const f of s.frames) {
    if (!f.pose?.parts[from]) continue;
    f.pose.parts = Object.fromEntries(Object.entries(f.pose.parts).map(([k, v]) => [k === from ? to : k, v]));
  }
}

export interface PoseInput {
  /** Frames to pose (omit with `new`). */
  frames?: number[];
  /** Append a new frame with this pose. */
  new?: boolean;
  /** Required for new frames; otherwise keeps the current facing. */
  facing?: Facing;
  parts?: Record<string, PartPose>;
  /** Replace the whole pose instead of merging. */
  replace?: boolean;
  duration?: number;
}

/** Sets (merges) the rig pose of frames, or appends a posed frame, and re-bakes them. Returns the posed frame indices. */
export function poseFrames(s: Sprite, a: PoseInput): number[] {
  const rig = ensureRig(s);
  for (const name of Object.keys(a.parts ?? {})) findPart(rig, name);
  let idx = a.frames ?? [];
  if (a.new) {
    if (!a.facing) throw new Error('A new frame needs a facing');
    addFrame(s, undefined, { duration: a.duration });
    idx = [s.frames.length - 1];
  }
  if (!idx.length) throw new Error('Pass frames or new: true');
  for (const i of idx) {
    const f = resolveFrame(s, i);
    const facing = a.facing ?? f.pose?.facing;
    if (!facing) throw new Error(`Frame ${i} has no pose yet: pass a facing`);
    const base = a.replace || !f.pose ? {} : f.pose.parts;
    const parts: Record<string, PartPose> = { ...base };
    for (const [name, v] of Object.entries(a.parts ?? {})) parts[name] = a.replace ? { ...v } : { ...base[name], ...v };
    f.pose = { facing, parts };
    if (a.duration) f.duration = a.duration;
  }
  bakeRig(s, idx);
  return idx;
}

/** Drops default-valued fields (0 offsets, scale 1, empty strings) so stored poses stay readable. */
export function cleanPartPose(p: PartPose): PartPose {
  const out: PartPose = {};
  if (p.dx) out.dx = p.dx;
  if (p.dy) out.dy = p.dy;
  if (p.rot) out.rot = p.rot;
  if (p.sx !== undefined && p.sx !== 1) out.sx = p.sx;
  if (p.sy !== undefined && p.sy !== 1) out.sy = p.sy;
  if (p.variant) out.variant = p.variant;
  if (p.hide) out.hide = true;
  if (p.z !== undefined && p.z !== null && !Number.isNaN(p.z)) out.z = p.z;
  if (p.smear) {
    out.smear = p.smear;
    if (p.smearColor) out.smearColor = p.smearColor;
  }
  return out;
}

/** Replaces one part's pose on one frame (default fields removed) and re-bakes it. */
export function setPartPose(s: Sprite, frame: number, name: string, pp: PartPose): void {
  const f = resolveFrame(s, frame);
  if (!f.pose) throw new Error(`Frame ${frame} has no pose yet: pick a facing`);
  findPart(ensureRig(s), name);
  const clean = cleanPartPose(pp);
  const parts = { ...f.pose.parts };
  if (Object.keys(clean).length) parts[name] = clean;
  else delete parts[name];
  f.pose = { ...f.pose, parts };
  bakeRig(s, [frame]);
}

/** Replaces (or creates) the frames of a tag with posed frames. A fresh character's lone rest frame is reused. */
export function writeTagFrames(s: Sprite, tagName: string, poses: Pose[], durations: number[], direction: 'forward' | 'pingpong' = 'forward'): void {
  const reuseRest = s.tags.length === 0 && s.frames.length === 1;
  const existing = s.tags.find((t) => t.name === tagName);
  const at = existing ? existing.from : s.frames.length;
  poses.forEach((pose, i) => {
    const f = addFrame(s, at + i, { duration: durations[i] });
    f.pose = pose;
  });
  if (existing) {
    // addFrame already shifted the old tag past the inserted frames; drop its frames.
    const { from: oldFrom, to: oldTo } = existing;
    for (let i = oldTo; i >= oldFrom; i--) removeFrame(s, i);
  }
  if (reuseRest) removeFrame(s, 0);
  const from = s.frames.findIndex((f) => f.pose === poses[0]);
  setTag(s, { name: tagName, from, to: from + poses.length - 1, direction });
}

/** The wanted facings, else every facing with art, else down. */
export function facingsOf(s: Sprite, wanted?: Facing[]): Facing[] {
  const available = rigFacings(s);
  return wanted?.length ? wanted : available.length ? available : ['down'];
}

/** rig_animate: generates an animation per facing as tag "<animation>_<facing>". Returns the tag names. */
export function animateRig(s: Sprite, animation: AnimName, facings?: Facing[], opts: AnimOptions = {}): string[] {
  if (!s.rig?.parts.length) throw new Error('The rig has no parts yet. Draw them with rig_part.');
  const tags: string[] = [];
  for (const facing of facingsOf(s, facings)) {
    const gen = generateAnimation(s, animation, facing, opts);
    const tagName = `${animation}_${facing}`;
    writeTagFrames(s, tagName, gen.poses, gen.durations);
    tags.push(tagName);
  }
  bakeRig(s);
  return tags;
}

export interface KeyframeAnimInput {
  name: string;
  facing: Facing;
  frames: number;
  keys: Keyframe[];
  loop?: boolean;
  duration?: number;
  durations?: number[];
}

/** rig_keyframes: interpolates key poses into tag `name` (created or replaced). */
export function keyframeRig(s: Sprite, a: KeyframeAnimInput): void {
  const rig = ensureRig(s);
  if (!a.name.trim()) throw new Error('Tag name is required');
  for (const k of a.keys) for (const name of Object.keys(k.parts)) findPart(rig, name);
  const poses = interpolateKeyframes(a.keys, a.frames, !!a.loop).map((parts) => ({ facing: a.facing, parts }));
  if (a.durations && a.durations.length !== a.frames) throw new Error(`durations needs ${a.frames} values`);
  writeTagFrames(s, a.name, poses, a.durations ?? Array(a.frames).fill(a.duration ?? 100));
  bakeRig(s);
}

/**
 * Moves the pivot of one drawing (view key "down" or "down:blink"). With `keepInPlace`, a base drawing's `at` moves
 * by the same amount and its children's `at` the opposite way, so nothing shifts in the rest pose.
 * Variants inherit `at` from the base drawing, so only their pivot changes.
 */
export function movePivot(s: Sprite, name: string, key: string, pivot: [number, number], keepInPlace = true): void {
  const rig = ensureRig(s);
  const part = findPart(rig, name);
  const v = part.views[key];
  if (!v) throw new Error(`Part "${name}" has no "${key}" drawing`);
  const d: [number, number] = [pivot[0] - v.pivot[0], pivot[1] - v.pivot[1]];
  v.pivot = [pivot[0], pivot[1]];
  if (keepInPlace && !key.includes(':') && (d[0] || d[1])) {
    const at = v.at ?? [0, 0];
    v.at = [at[0] + d[0], at[1] + d[1]];
    for (const c of rig.parts) {
      const cv = c.parent === name ? c.views[key] : undefined;
      if (!cv) continue;
      const ca = cv.at ?? [0, 0];
      cv.at = [ca[0] - d[0], ca[1] - d[1]];
    }
  }
  bakeRig(s);
}

/** Changes a part's parent. With `keepInPlace`, each drawn facing's `at` is recomputed so the part stays where it is in the rest pose. */
export function reparentPart(s: Sprite, name: string, parent: string | null, keepInPlace = true): void {
  const rig = ensureRig(s);
  const part = findPart(rig, name);
  if (parent !== null) findPart(rig, parent);
  if (parent === name) throw new Error('A part cannot be its own parent');
  const before = keepInPlace ? FACINGS.map((f) => [f, layoutPose(s, restPose(f)).find((q) => q.part === part)] as const) : [];
  const old = part.parent;
  part.parent = parent;
  try {
    topoParts(rig); // throws on cycles
  } catch (err) {
    part.parent = old;
    throw err;
  }
  for (const [f, q] of before) {
    const v = part.views[f];
    if (!v || !q?.view) continue;
    const par = parent ? layoutPose(s, restPose(f)).find((x) => x.part.name === parent) : undefined;
    const wx = Math.round(q.x);
    const wy = Math.round(q.y);
    v.at = par ? [wx - Math.round(par.x), wy - Math.round(par.y)] : [wx, wy];
  }
  bakeRig(s);
}
