/**
 * Reference pictures, pose guides and color ramps: sprite metadata shared by the MCP tools and the web editor.
 * Pure and browser-safe.
 */
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { normalizeHex, parseColor } from './color.js';
import { colorHistogram, extractRegion, pasteBitmap } from './draw.js';
import { kmeansPalette, pixelize, pixelizeAuto } from './pixelize.js';
import { downscale, luminance, removeBackground } from './shapes.js';
import { type Bitmap, type PoseGuide, type Reference, type Sprite, addLayer, celBitmap } from './sprite.js';

// ---------------------------------------------------------------------------
// Reference pictures

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crops a decoded picture and optionally makes its background transparent (flood fill from the border). */
export function preparePicture(full: Bitmap, crop?: CropRect, removeBg?: boolean, tolerance?: number): Bitmap {
  let src = crop ? extractRegion(full, crop) : full;
  if (removeBg) src = removeBackground(src, tolerance);
  return src;
}

/** Stores a picture as the sprite's reference, scaled to `height` canvas pixels (default: fit) and placed at x/y (default: centered, bottom). */
export function attachReference(s: Sprite, src: Bitmap, height?: number, px?: number, py?: number): { w: number; h: number; x: number; y: number } {
  const h = height ?? Math.min(s.height, Math.floor((src.height * s.width) / src.width));
  const w = Math.max(1, Math.round((src.width * h) / src.height));
  const scaled = downscale(src, w, h);
  // Keep the picture at up to 4x the canvas size so silhouette_check can see thin details.
  const hi = src.height > h * 4 ? downscale(src, w * 4, h * 4) : src;
  const x = px ?? Math.floor((s.width - w) / 2);
  const y = py ?? s.height - h;
  s.reference = { width: w, height: h, pixels: bytesToBase64(scaled.data), x, y, source: { width: hi.width, height: hi.height, pixels: bytesToBase64(hi.data) } };
  return { w, h, x, y };
}

export interface PixelizeToLayerOptions {
  /** Height of the result on the canvas (default: fit the canvas). */
  height?: number;
  x?: number;
  y?: number;
  /** Colors extracted from the picture (default 24). */
  colors?: number;
  /** Quantize to the sprite's own palette instead of extracting one. */
  usePalette?: boolean;
  /** Target layer (default "pixelized"; created if missing, replaced otherwise). */
  layer?: string;
  /** Automatic when omitted: the value that keeps the picture's light/dark balance. */
  lineBias?: number;
  lineLightness?: number;
  despeckle?: boolean;
  keepReference?: boolean;
}

/** Converts a picture into clean pixel art on a layer of frame 0 and, unless told otherwise, makes it the sprite's reference. */
export function pixelizeToLayer(s: Sprite, src: Bitmap, o: PixelizeToLayerOptions = {}): { width: number; height: number; x: number; y: number; layer: string; lineBias: number; autoBias: boolean; colors: string[] } {
  const h = o.height ?? Math.min(s.height, Math.floor((src.height * s.width) / src.width));
  const w = Math.max(1, Math.round((src.width * h) / src.height));
  const palette = o.usePalette ? s.palette.map((c) => parseColor(c)) : kmeansPalette(src, o.colors ?? 24);
  if (!palette.length) throw new Error('No palette: give colors or set a palette first');
  const base = { width: w, height: h, palette, lineLightness: o.lineLightness, despeckle: o.despeckle };
  const auto = o.lineBias === undefined ? pixelizeAuto(src, base, downscale(src, w, h)) : null;
  const px = auto ? auto.image : pixelize(src, { ...base, lineBias: o.lineBias });
  const x = o.x ?? Math.floor((s.width - w) / 2);
  const y = o.y ?? s.height - h;
  const layer = s.layers.find((l) => l.name === (o.layer ?? 'pixelized')) ?? addLayer(s, o.layer ?? 'pixelized');
  const bmp = celBitmap(s, layer.id, s.frames[0].id);
  bmp.data.fill(0);
  pasteBitmap(bmp, px, x, y, 'over');
  const used = [...new Set(colorHistogram(px).map((c) => c.color))];
  if (o.usePalette) {
    for (const c of used) if (!s.palette.includes(c)) s.palette.push(c);
  } else {
    // Replace the palette with what the sprite actually uses plus the ramps, so leftovers such as the default palette do not linger.
    const inUse = new Set<string>(Object.values(s.ramps).flat());
    for (const l of s.layers) for (const f of s.frames) for (const c of colorHistogram(celBitmap(s, l.id, f.id))) inUse.add(c.color);
    s.palette = [...inUse].sort((p, q) => luminance(parseColor(p)) - luminance(parseColor(q)));
  }
  if (!o.keepReference) attachReference(s, src, h, x, y);
  return { width: w, height: h, x, y, layer: layer.name, lineBias: auto ? auto.lineBias : o.lineBias!, autoBias: !!auto, colors: used };
}

/** The reference picture at canvas resolution (its own size, not placed). */
export function referencePixels(ref: Reference): Bitmap {
  const bytes = base64ToBytes(ref.pixels);
  return { width: ref.width, height: ref.height, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length) };
}

// ---------------------------------------------------------------------------
// Pose guides

/** Standard bones: connected automatically whenever both joints exist. */
export const DEFAULT_BONES: [string, string][] = [
  ['head', 'neck'], ['neck', 'pelvis'],
  ['neck', 'shoulder_f'], ['shoulder_f', 'elbow_f'], ['elbow_f', 'hand_f'],
  ['neck', 'shoulder_b'], ['shoulder_b', 'elbow_b'], ['elbow_b', 'hand_b'],
  ['pelvis', 'hip_f'], ['hip_f', 'knee_f'], ['knee_f', 'foot_f'],
  ['pelvis', 'hip_b'], ['hip_b', 'knee_b'], ['knee_b', 'foot_b'],
  ['hand_f', 'weapon_tip'], ['hand_b', 'shield'],
];

/** Standard joint names, in the order the editor offers them. */
export const STANDARD_JOINTS = [...new Set(DEFAULT_BONES.flat())];

export function isDefaultBone(a: string, b: string): boolean {
  return DEFAULT_BONES.some((d) => d[0] === a && d[1] === b);
}

export interface GuideEdit {
  /** Joints to add or move (merged with the existing ones). */
  joints?: Record<string, [number, number]>;
  /** Joint names to delete. */
  remove?: string[];
  /** Extra bones to connect (standard bones are added automatically). */
  bones?: [string, string][];
  clear?: boolean;
}

/** Applies a pose_guide edit. Bones whose joints are missing are dropped. Returns the new guide (null when cleared). */
export function editGuide(s: Sprite, e: GuideEdit): PoseGuide | null {
  if (e.clear) {
    s.guide = null;
    return null;
  }
  const g: PoseGuide = s.guide ?? { joints: {}, bones: [] };
  Object.assign(g.joints, e.joints ?? {});
  for (const n of e.remove ?? []) delete g.joints[n];
  const extra = [...g.bones.filter((b) => !isDefaultBone(b[0], b[1])), ...(e.bones ?? [])];
  const has = ([x, y]: [string, string]) => !!g.joints[x] && !!g.joints[y];
  const custom = extra.filter(has).filter((b, i, all) => all.findIndex((o) => o[0] === b[0] && o[1] === b[1]) === i);
  g.bones = [...DEFAULT_BONES.filter(has), ...custom];
  s.guide = g;
  return g;
}

/** Renames a joint, keeping its custom bones. */
export function renameJoint(s: Sprite, from: string, to: string): void {
  const g = s.guide;
  if (!g?.joints[from]) throw new Error(`No joint named "${from}"`);
  if (!to.trim()) throw new Error('Joint name is required');
  if (from === to) return;
  if (g.joints[to]) throw new Error(`A joint named "${to}" already exists`);
  const pos = g.joints[from];
  const bones = g.bones.filter((b) => !isDefaultBone(b[0], b[1])).map((b) => b.map((n) => (n === from ? to : n)) as [string, string]);
  delete g.joints[from];
  g.joints[to] = pos;
  g.bones = [];
  editGuide(s, { bones });
}

/** Removes a custom bone (standard bones always connect their joints). */
export function removeBone(s: Sprite, a: string, b: string): void {
  if (!s.guide) return;
  if (isDefaultBone(a, b)) throw new Error(`"${a}–${b}" is a standard bone: it connects automatically while both joints exist`);
  s.guide.bones = s.guide.bones.filter((x) => !(x[0] === a && x[1] === b));
}

export function describeGuide(g: PoseGuide): string {
  const lines = g.bones
    .filter(([a, b]) => g.joints[a] && g.joints[b])
    .map(([a, b]) => {
      const [x0, y0] = g.joints[a];
      const [x1, y1] = g.joints[b];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      return `${a}→${b}: ${len.toFixed(1)}px at ${Math.round(ang)}°`;
    });
  return `Joints: ${Object.entries(g.joints).map(([n, [x, y]]) => `${n}(${x},${y})`).join(' ')}\nBones: ${lines.join('; ')}`;
}

// ---------------------------------------------------------------------------
// Color ramps

export const RAMP_NAME_RE = /^[A-Za-z_][\w-]*$/;

/** Defines (or replaces) a named ramp, darkest first. New colors are added to the palette. */
export function setRamp(s: Sprite, name: string, colors: string[]): string[] {
  if (!RAMP_NAME_RE.test(name)) throw new Error(`Invalid ramp name "${name}" (letters, digits, "_" and "-", not starting with a digit)`);
  if (!colors.length) throw new Error('A ramp needs at least one color');
  const ramp = colors.map((c) => normalizeHex(c));
  s.ramps[name] = ramp;
  for (const c of ramp) if (!s.palette.includes(c)) s.palette.push(c);
  return ramp;
}

/** Renames a ramp, keeping its position in the ramp list. */
export function renameRamp(s: Sprite, from: string, to: string): void {
  if (!s.ramps[from]) throw new Error(`No ramp named "${from}"`);
  if (from === to) return;
  if (!RAMP_NAME_RE.test(to)) throw new Error(`Invalid ramp name "${to}" (letters, digits, "_" and "-", not starting with a digit)`);
  if (s.ramps[to]) throw new Error(`A ramp named "${to}" already exists`);
  s.ramps = Object.fromEntries(Object.entries(s.ramps).map(([k, v]) => [k === from ? to : k, v]));
}
