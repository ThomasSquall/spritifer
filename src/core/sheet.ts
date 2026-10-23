import { type Bitmap, type Sprite, compositeFrame, resolveLayer } from './sprite.js';
import { pasteBitmap, scaleBitmap } from './draw.js';

export type SheetLayout = 'horizontal' | 'vertical' | 'grid' | 'tags';

export interface SheetOptions {
  layout?: SheetLayout;
  /** Columns for the "grid" layout (default: ceil(sqrt(frames))). */
  columns?: number;
  /** Pixels between frames. */
  padding?: number;
  /** Pixels around the whole sheet. */
  margin?: number;
  /** Integer upscale factor. */
  scale?: number;
  /** Only export the frames of this tag. */
  tag?: string;
  /** Only export these frame indices. */
  frames?: number[];
  /** Only export these layers (names or indices); defaults to visible layers. */
  layers?: (string | number)[];
  /** File name written into the metadata "image" field. */
  imageName?: string;
}

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Aseprite-compatible JSON (array format): understood by Phaser, Godot, Unity and LibGDX importers. */
export interface SheetMeta {
  frames: {
    filename: string;
    frame: FrameRect;
    rotated: false;
    trimmed: false;
    spriteSourceSize: FrameRect;
    sourceSize: { w: number; h: number };
    duration: number;
  }[];
  meta: {
    app: string;
    version: string;
    image: string;
    format: 'RGBA8888';
    size: { w: number; h: number };
    scale: string;
    frameTags: { name: string; from: number; to: number; direction: string; color: string }[];
    layers: { name: string; opacity: number; blendMode: 'normal' }[];
    slices: never[];
  };
}

export interface SheetResult {
  image: Bitmap;
  meta: SheetMeta;
}

interface Entry {
  frame: number;
  row: number;
  col: number;
}

export function buildSpritesheet(s: Sprite, opts: SheetOptions = {}): SheetResult {
  const layout = opts.layout ?? 'horizontal';
  const padding = Math.max(0, opts.padding ?? 0);
  const margin = Math.max(0, opts.margin ?? 0);
  const scale = Math.max(1, Math.floor(opts.scale ?? 1));
  const layerIds = opts.layers?.map((l) => resolveLayer(s, l).id);

  let frameList: number[];
  if (opts.frames?.length) frameList = opts.frames;
  else if (opts.tag) {
    const tag = s.tags.find((t) => t.name === opts.tag);
    if (!tag) throw new Error(`No tag named "${opts.tag}"`);
    frameList = range(tag.from, tag.to);
  } else frameList = range(0, s.frames.length - 1);
  for (const f of frameList) if (!s.frames[f]) throw new Error(`Frame ${f} out of range`);

  const entries: Entry[] = [];
  const frameTags: SheetMeta['meta']['frameTags'] = [];

  if (layout === 'tags' && !opts.tag && !opts.frames?.length) {
    // One row per animation tag; untagged frames go in a final row.
    let row = 0;
    const tagged = new Set<number>();
    for (const t of s.tags) {
      const start = entries.length;
      range(t.from, t.to).forEach((f, col) => {
        entries.push({ frame: f, row, col });
        tagged.add(f);
      });
      frameTags.push({ name: t.name, from: start, to: entries.length - 1, direction: t.direction, color: t.color });
      row++;
    }
    const rest = frameList.filter((f) => !tagged.has(f));
    rest.forEach((f, col) => entries.push({ frame: f, row, col }));
  } else {
    const n = frameList.length;
    const cols =
      layout === 'vertical' ? 1 : layout === 'grid' ? Math.max(1, opts.columns ?? Math.ceil(Math.sqrt(n))) : n;
    frameList.forEach((f, i) => entries.push({ frame: f, row: Math.floor(i / cols), col: i % cols }));
    // Re-map tags onto the exported frame order when they are fully contained.
    for (const t of s.tags) {
      const from = frameList.indexOf(t.from);
      const to = frameList.indexOf(t.to);
      if (from >= 0 && to >= 0 && to - from === t.to - t.from) {
        frameTags.push({ name: t.name, from, to, direction: t.direction, color: t.color });
      }
    }
  }

  const fw = s.width * scale;
  const fh = s.height * scale;
  const cols = Math.max(1, ...entries.map((e) => e.col + 1));
  const rows = Math.max(1, ...entries.map((e) => e.row + 1));
  const width = margin * 2 + cols * fw + (cols - 1) * padding;
  const height = margin * 2 + rows * fh + (rows - 1) * padding;
  const image: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };

  const imageName = opts.imageName ?? `${s.name}.png`;
  const metaFrames: SheetMeta['frames'] = [];
  const cache = new Map<number, Bitmap>();
  for (const e of entries) {
    let bmp = cache.get(e.frame);
    if (!bmp) {
      bmp = scaleBitmap(compositeFrame(s, e.frame, { layerIds, includeHidden: !!layerIds }), scale);
      cache.set(e.frame, bmp);
    }
    const x = margin + e.col * (fw + padding);
    const y = margin + e.row * (fh + padding);
    pasteBitmap(image, bmp, x, y, 'replace');
    metaFrames.push({
      filename: `${s.name} ${e.frame}`,
      frame: { x, y, w: fw, h: fh },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
      sourceSize: { w: fw, h: fh },
      duration: s.frames[e.frame].duration,
    });
  }

  return {
    image,
    meta: {
      frames: metaFrames,
      meta: {
        app: 'https://github.com/spritifer',
        version: '0.1.0',
        image: imageName,
        format: 'RGBA8888',
        size: { w: width, h: height },
        scale: String(scale),
        frameTags,
        layers: s.layers
          .filter((l) => (layerIds ? layerIds.includes(l.id) : l.visible))
          .map((l) => ({ name: l.name, opacity: Math.round(l.opacity * 255), blendMode: 'normal' as const })),
        slices: [],
      },
    },
  };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Splits an image into frames of `fw`x`fh` (row-major), skipping fully transparent trailing cells. */
export function sliceImage(img: Bitmap, fw: number, fh: number, opts: { margin?: number; padding?: number } = {}): Bitmap[] {
  const margin = opts.margin ?? 0;
  const padding = opts.padding ?? 0;
  const out: Bitmap[] = [];
  for (let y = margin; y + fh <= img.height - margin + 1e-9; y += fh + padding) {
    for (let x = margin; x + fw <= img.width - margin + 1e-9; x += fw + padding) {
      const cell: Bitmap = { width: fw, height: fh, data: new Uint8ClampedArray(fw * fh * 4) };
      for (let cy = 0; cy < fh; cy++) {
        const si = ((y + cy) * img.width + x) * 4;
        cell.data.set(img.data.subarray(si, si + fw * 4), cy * fw * 4);
      }
      out.push(cell);
    }
  }
  while (out.length > 1 && isBlank(out[out.length - 1])) out.pop();
  return out;
}

function isBlank(b: Bitmap): boolean {
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i]) return false;
  return true;
}
