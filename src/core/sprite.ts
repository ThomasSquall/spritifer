import { DEFAULT_PALETTE, PALETTES, normalizeHex } from './color.js';
import { base64ToBytes, bytesToBase64 } from './base64.js';

/** A raw RGBA image buffer. */
export interface Bitmap {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
}

export interface Frame {
  id: string;
  /** Display time in milliseconds. */
  duration: number;
  /** Rig pose rendered into the rig layer of this frame (see core/rig.ts). */
  pose?: Pose;
  /** Animation events fired when the game shows this frame ("hit", "step"): onAnimationEvent / event trigger. */
  events?: string[];
}

// ---------------------------------------------------------------------------
// Rig (cut-out character animation). Logic lives in core/rig.ts.

export type Facing = 'down' | 'left' | 'right' | 'up';
export const FACINGS: Facing[] = ['down', 'left', 'right', 'up'];

/** How one part looks from one facing (optionally a named variant, e.g. "blink"). */
export interface PartView {
  width: number;
  height: number;
  /** Base64 RGBA. */
  pixels: string;
  /** Joint pixel in part-local coordinates: the rotation center and attachment point. */
  pivot: [number, number];
  /** Where the pivot sits: canvas coordinates for root parts, offset from the parent's pivot for child parts. Variants inherit it. */
  at?: [number, number];
  /** Draw order for this facing (higher = in front). Variants inherit it. */
  z?: number;
}

export interface RigPart {
  name: string;
  parent: string | null;
  /** Keyed by facing ("down") or facing + variant ("down:blink"). Missing left/right views are mirrored from the other side. */
  views: Record<string, PartView>;
}

export interface Rig {
  /** Layer the poses are baked into. */
  layer: string;
  parts: RigPart[];
}

/** Per-part offset from the rest pose. dx/dy are screen pixels, rot is degrees clockwise around the pivot. */
export interface PartPose {
  dx?: number;
  dy?: number;
  rot?: number;
  variant?: string;
  hide?: boolean;
  /** Overrides the view's draw order for this frame. */
  z?: number;
  /** Motion smear: degrees of rotation to trail behind (sign = direction the part came from). Draws the part's children (or the part itself if it has none) as a solid arc. */
  smear?: number;
  /** Smear color (default near-white). */
  smearColor?: string;
  /** Scale of this part's drawing around its pivot (squash & stretch). Default 1. */
  sx?: number;
  sy?: number;
}

/** Gesture skeleton used as a drawing guide (shown by previews, never exported). */
export interface PoseGuide {
  /** Named joints in canvas pixels, e.g. head, neck, pelvis, shoulder_f, hand_b, foot_f. */
  joints: Record<string, [number, number]>;
  /** Pairs of joint names to connect. */
  bones: [string, string][];
}

/** A reference image shown next to / under the art in previews. Never exported. */
export interface Reference {
  width: number;
  height: number;
  /** Base64 RGBA, already cropped/scaled to canvas pixels. */
  pixels: string;
  /** Placement on the canvas. */
  x: number;
  y: number;
  /** The cropped picture at (up to 4x) higher resolution, used to measure how much of each canvas pixel it covers. */
  source?: { width: number; height: number; pixels: string };
}

export interface Pose {
  facing: Facing;
  parts: Record<string, PartPose>;
}

export type TagDirection = 'forward' | 'reverse' | 'pingpong';

/** A named animation: an inclusive range of frame indices. */
export interface Tag {
  name: string;
  from: number;
  to: number;
  direction: TagDirection;
  color: string;
}

export interface TileGrid {
  width: number;
  height: number;
}

export interface Sprite {
  name: string;
  width: number;
  height: number;
  palette: string[];
  /** Bottom-most layer first. */
  layers: Layer[];
  frames: Frame[];
  tags: Tag[];
  /** Optional tile grid, used for tilesets / environments. */
  grid: TileGrid | null;
  /** Cut-out rig for characters (parts + per-frame poses). */
  rig: Rig | null;
  /** Named color ramps, darkest first (e.g. skin: 4 shades). Referenced as "skin.2". */
  ramps: Record<string, string[]>;
  reference: Reference | null;
  guide: PoseGuide | null;
  /** Pixel data keyed by `${layerId}/${frameId}`. Missing cels are fully transparent. */
  cels: Map<string, Uint8ClampedArray>;
  /** Changes on every save; lets clients detect remote edits. */
  rev: string;
}

/** On-disk JSON representation (`*.sprite.json`). */
export interface SpriteFile {
  format: 'spritifer';
  version: 1;
  name: string;
  width: number;
  height: number;
  palette: string[];
  layers: Layer[];
  frames: Frame[];
  tags: Tag[];
  grid: TileGrid | null;
  rig?: Rig | null;
  ramps?: Record<string, string[]>;
  reference?: Reference | null;
  guide?: PoseGuide | null;
  /** Base64 encoded RGBA rows, keyed by `${layerId}/${frameId}`. */
  cels: Record<string, string>;
  rev: string;
  updatedBy?: string;
}

export const MAX_SIZE = 2048;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$/;

const TAG_COLORS = ['#e43b44', '#feae34', '#63c74d', '#0099db', '#b55088', '#f77622', '#2ce8f5', '#c28569'];

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function celKey(layerId: string, frameId: string): string {
  return `${layerId}/${frameId}`;
}

export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid sprite name "${name}". Use letters, digits, "-" and "_" (max 64 chars).`);
  }
}

function assertSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIZE || height > MAX_SIZE) {
    throw new Error(`Invalid size ${width}x${height}. Width and height must be integers between 1 and ${MAX_SIZE}.`);
  }
}

export interface CreateSpriteOptions {
  name: string;
  width: number;
  height: number;
  /** Explicit colors, or the name of a built-in palette. */
  palette?: string[] | string;
  grid?: TileGrid | null;
  frameDuration?: number;
}

export function createSprite(opts: CreateSpriteOptions): Sprite {
  assertValidName(opts.name);
  assertSize(opts.width, opts.height);
  let palette: string[];
  if (Array.isArray(opts.palette)) palette = opts.palette.map(normalizeHex);
  else {
    const preset = PALETTES[opts.palette ?? DEFAULT_PALETTE];
    if (!preset) throw new Error(`Unknown palette "${opts.palette}". Built-in: ${Object.keys(PALETTES).join(', ')}`);
    palette = [...preset];
  }
  return {
    name: opts.name,
    width: opts.width,
    height: opts.height,
    palette,
    layers: [{ id: newId(), name: 'Layer 1', visible: true, opacity: 1 }],
    frames: [{ id: newId(), duration: opts.frameDuration ?? 100 }],
    tags: [],
    grid: opts.grid ?? null,
    rig: null,
    ramps: {},
    reference: null,
    guide: null,
    cels: new Map(),
    rev: newId(),
  };
}

export function cloneSprite(s: Sprite): Sprite {
  const cels = new Map<string, Uint8ClampedArray>();
  for (const [k, v] of s.cels) cels.set(k, new Uint8ClampedArray(v));
  return {
    ...s,
    palette: [...s.palette],
    layers: s.layers.map((l) => ({ ...l })),
    frames: s.frames.map((f) => ({ ...f, ...(f.pose ? { pose: structuredClone(f.pose) } : {}) })),
    tags: s.tags.map((t) => ({ ...t })),
    grid: s.grid ? { ...s.grid } : null,
    rig: s.rig ? structuredClone(s.rig) : null,
    ramps: structuredClone(s.ramps),
    reference: s.reference,
    guide: s.guide ? structuredClone(s.guide) : null,
    cels,
  };
}

function isEmpty(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

export function serializeSprite(s: Sprite, updatedBy?: string): SpriteFile {
  const cels: Record<string, string> = {};
  const layerIds = new Set(s.layers.map((l) => l.id));
  const frameIds = new Set(s.frames.map((f) => f.id));
  for (const [k, v] of s.cels) {
    const [l, f] = k.split('/');
    if (!layerIds.has(l) || !frameIds.has(f) || isEmpty(v)) continue;
    cels[k] = bytesToBase64(v);
  }
  return {
    format: 'spritifer',
    version: 1,
    name: s.name,
    width: s.width,
    height: s.height,
    palette: s.palette,
    layers: s.layers,
    frames: s.frames,
    tags: s.tags,
    grid: s.grid,
    ...(s.rig ? { rig: s.rig } : {}),
    ...(Object.keys(s.ramps).length ? { ramps: s.ramps } : {}),
    ...(s.reference ? { reference: s.reference } : {}),
    ...(s.guide ? { guide: s.guide } : {}),
    cels,
    rev: s.rev,
    ...(updatedBy ? { updatedBy } : {}),
  };
}

export function deserializeSprite(file: SpriteFile): Sprite {
  if (!file || file.format !== 'spritifer') throw new Error('Not a Spritifer sprite file');
  assertSize(file.width, file.height);
  const size = file.width * file.height * 4;
  const cels = new Map<string, Uint8ClampedArray>();
  for (const [k, b64] of Object.entries(file.cels ?? {})) {
    const bytes = base64ToBytes(b64);
    if (bytes.length !== size) throw new Error(`Cel ${k} has ${bytes.length} bytes, expected ${size}`);
    cels.set(k, new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length));
  }
  return {
    name: file.name,
    width: file.width,
    height: file.height,
    palette: file.palette ?? [],
    layers: file.layers.map((l) => ({ ...l, visible: l.visible ?? true, opacity: l.opacity ?? 1 })),
    frames: file.frames.map((f) => ({ ...f, duration: f.duration || 100 })),
    tags: file.tags ?? [],
    grid: file.grid ?? null,
    rig: file.rig ?? null,
    ramps: file.ramps ?? {},
    reference: file.reference ?? null,
    guide: file.guide ?? null,
    cels,
    rev: file.rev ?? newId(),
  };
}

// ---------------------------------------------------------------------------
// Lookup helpers

/** Resolves a layer by index (0 = bottom) or by name. */
export function resolveLayer(s: Sprite, ref: number | string | undefined): Layer {
  if (ref === undefined) return s.layers[s.layers.length - 1];
  if (typeof ref === 'number' || /^\d+$/.test(ref)) {
    const i = Number(ref);
    const layer = s.layers[i];
    if (!layer) throw new Error(`Layer index ${i} out of range (0..${s.layers.length - 1})`);
    return layer;
  }
  const layer = s.layers.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (!layer) throw new Error(`No layer named "${ref}". Layers: ${s.layers.map((l) => l.name).join(', ')}`);
  return layer;
}

export function resolveFrame(s: Sprite, index: number | undefined): Frame {
  const i = index ?? 0;
  const frame = s.frames[i];
  if (!frame) throw new Error(`Frame index ${i} out of range (0..${s.frames.length - 1})`);
  return frame;
}

/** Returns the cel buffer, creating an empty one when `create` is set. */
export function getCel(s: Sprite, layerId: string, frameId: string, create: true): Uint8ClampedArray;
export function getCel(s: Sprite, layerId: string, frameId: string, create?: boolean): Uint8ClampedArray | undefined;
export function getCel(s: Sprite, layerId: string, frameId: string, create = false): Uint8ClampedArray | undefined {
  const key = celKey(layerId, frameId);
  let cel = s.cels.get(key);
  if (!cel && create) {
    cel = new Uint8ClampedArray(s.width * s.height * 4);
    s.cels.set(key, cel);
  }
  return cel;
}

export function celBitmap(s: Sprite, layerId: string, frameId: string): Bitmap {
  return { width: s.width, height: s.height, data: getCel(s, layerId, frameId, true) };
}

// ---------------------------------------------------------------------------
// Structure editing

export function addLayer(s: Sprite, name?: string, index?: number): Layer {
  const layer: Layer = { id: newId(), name: name || `Layer ${s.layers.length + 1}`, visible: true, opacity: 1 };
  const at = index === undefined ? s.layers.length : Math.max(0, Math.min(index, s.layers.length));
  s.layers.splice(at, 0, layer);
  return layer;
}

export function removeLayer(s: Sprite, layerId: string): void {
  if (s.layers.length <= 1) throw new Error('A sprite needs at least one layer');
  s.layers = s.layers.filter((l) => l.id !== layerId);
  for (const k of [...s.cels.keys()]) if (k.startsWith(layerId + '/')) s.cels.delete(k);
}

export function moveLayer(s: Sprite, layerId: string, toIndex: number): void {
  const from = s.layers.findIndex((l) => l.id === layerId);
  if (from < 0) return;
  const [layer] = s.layers.splice(from, 1);
  s.layers.splice(Math.max(0, Math.min(toIndex, s.layers.length)), 0, layer);
}

/** Merges a layer into the one below it. */
export function mergeLayerDown(s: Sprite, layerId: string): void {
  const i = s.layers.findIndex((l) => l.id === layerId);
  if (i <= 0) throw new Error('Cannot merge the bottom layer down');
  const top = s.layers[i];
  const below = s.layers[i - 1];
  for (const f of s.frames) {
    const src = getCel(s, top.id, f.id);
    if (!src) continue;
    const dst = getCel(s, below.id, f.id, true);
    compositeInto(dst, src, top.visible ? top.opacity : 0);
  }
  removeLayer(s, top.id);
}

/** Inserts a frame. `copyFrom` duplicates the pixels of an existing frame index. */
export function addFrame(s: Sprite, index?: number, opts: { duration?: number; copyFrom?: number } = {}): Frame {
  const source = opts.copyFrom !== undefined ? resolveFrame(s, opts.copyFrom) : undefined;
  const frame: Frame = { id: newId(), duration: opts.duration ?? source?.duration ?? s.frames[s.frames.length - 1]?.duration ?? 100 };
  if (source?.pose) frame.pose = structuredClone(source.pose);
  const at = index === undefined ? s.frames.length : Math.max(0, Math.min(index, s.frames.length));
  s.frames.splice(at, 0, frame);
  for (const t of s.tags) {
    if (t.from >= at) t.from++;
    if (t.to >= at) t.to++;
  }
  if (source) {
    for (const l of s.layers) {
      const cel = getCel(s, l.id, source.id);
      if (cel) s.cels.set(celKey(l.id, frame.id), new Uint8ClampedArray(cel));
    }
  }
  return frame;
}

export function removeFrame(s: Sprite, index: number): void {
  if (s.frames.length <= 1) throw new Error('A sprite needs at least one frame');
  const frame = resolveFrame(s, index);
  s.frames.splice(index, 1);
  for (const k of [...s.cels.keys()]) if (k.endsWith('/' + frame.id)) s.cels.delete(k);
  s.tags = s.tags
    .map((t) => ({ ...t, from: t.from > index ? t.from - 1 : t.from, to: t.to >= index ? t.to - 1 : t.to }))
    .filter((t) => t.to >= t.from && t.to >= 0);
}

export function moveFrame(s: Sprite, from: number, to: number): void {
  resolveFrame(s, from);
  const [frame] = s.frames.splice(from, 1);
  s.frames.splice(Math.max(0, Math.min(to, s.frames.length)), 0, frame);
}

export function setTag(s: Sprite, tag: Omit<Tag, 'color' | 'direction'> & Partial<Pick<Tag, 'color' | 'direction'>>): Tag {
  if (!tag.name.trim()) throw new Error('Tag name is required');
  if (tag.from < 0 || tag.to >= s.frames.length || tag.from > tag.to) {
    throw new Error(`Invalid tag range ${tag.from}..${tag.to} (sprite has ${s.frames.length} frames)`);
  }
  const existing = s.tags.find((t) => t.name === tag.name);
  if (existing) {
    Object.assign(existing, { from: tag.from, to: tag.to }, tag.direction && { direction: tag.direction }, tag.color && { color: tag.color });
    return existing;
  }
  const created: Tag = {
    name: tag.name,
    from: tag.from,
    to: tag.to,
    direction: tag.direction ?? 'forward',
    color: tag.color ?? TAG_COLORS[s.tags.length % TAG_COLORS.length],
  };
  s.tags.push(created);
  return created;
}

export function removeTag(s: Sprite, name: string): void {
  const before = s.tags.length;
  s.tags = s.tags.filter((t) => t.name !== name);
  if (s.tags.length === before) throw new Error(`No tag named "${name}"`);
}

export type Anchor = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

/** Changes the canvas size, keeping pixels positioned according to `anchor`. */
export function resizeCanvas(s: Sprite, width: number, height: number, anchor: Anchor = 'center'): void {
  assertSize(width, height);
  const ax = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
  const ay = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5;
  const ox = Math.round((width - s.width) * ax);
  const oy = Math.round((height - s.height) * ay);
  for (const [k, src] of s.cels) {
    const dst = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < s.height; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= height) continue;
      for (let x = 0; x < s.width; x++) {
        const tx = x + ox;
        if (tx < 0 || tx >= width) continue;
        const si = (y * s.width + x) * 4;
        const di = (ty * width + tx) * 4;
        dst[di] = src[si];
        dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2];
        dst[di + 3] = src[si + 3];
      }
    }
    s.cels.set(k, dst);
  }
  s.width = width;
  s.height = height;
  // Root rig parts are positioned in canvas coordinates: move them with the pixels.
  for (const part of s.rig?.parts ?? []) {
    if (part.parent) continue;
    for (const v of Object.values(part.views)) if (v.at) v.at = [v.at[0] + ox, v.at[1] + oy];
  }
}

// ---------------------------------------------------------------------------
// Compositing

/** Alpha-composites `src` over `dst` in place (same dimensions). */
export function compositeInto(dst: Uint8ClampedArray, src: Uint8ClampedArray, opacity = 1): void {
  if (opacity <= 0) return;
  for (let i = 0; i < src.length; i += 4) {
    const sa = (src[i + 3] / 255) * opacity;
    if (sa === 0) continue;
    if (sa >= 1) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      dst[i + 3] = 255;
      continue;
    }
    const da = dst[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    dst[i] = (src[i] * sa + dst[i] * da * (1 - sa)) / oa;
    dst[i + 1] = (src[i + 1] * sa + dst[i + 1] * da * (1 - sa)) / oa;
    dst[i + 2] = (src[i + 2] * sa + dst[i + 2] * da * (1 - sa)) / oa;
    dst[i + 3] = oa * 255;
  }
}

export interface CompositeOptions {
  /** Restrict to these layer ids; defaults to all visible layers. */
  layerIds?: string[];
  includeHidden?: boolean;
}

/** Flattens the visible layers of one frame into a new bitmap. */
export function compositeFrame(s: Sprite, frameIndex: number, opts: CompositeOptions = {}): Bitmap {
  const frame = resolveFrame(s, frameIndex);
  const data = new Uint8ClampedArray(s.width * s.height * 4);
  for (const layer of s.layers) {
    if (opts.layerIds && !opts.layerIds.includes(layer.id)) continue;
    if (!layer.visible && !opts.includeHidden) continue;
    const cel = getCel(s, layer.id, frame.id);
    if (cel) compositeInto(data, cel, layer.opacity);
  }
  return { width: s.width, height: s.height, data };
}

/** Frame indices played by a tag, honoring its direction (pingpong excludes repeated ends). */
export function tagSequence(tag: Tag): number[] {
  const fwd: number[] = [];
  for (let i = tag.from; i <= tag.to; i++) fwd.push(i);
  if (tag.direction === 'reverse') return fwd.reverse();
  if (tag.direction === 'pingpong') return fwd.concat(fwd.slice(1, -1).reverse());
  return fwd;
}
