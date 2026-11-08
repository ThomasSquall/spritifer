import { z } from 'zod';
import {
  PIXELLAB_ACTIONS, PIXELLAB_DETAILS, PIXELLAB_DIRECTIONS, PIXELLAB_IMAGE_MODELS, PIXELLAB_OUTLINES, PIXELLAB_SHADINGS,
  PIXELLAB_TILESET_MODES, PIXELLAB_TILESET_VIEWS, PIXELLAB_VIEWS,
  pixelLabCornerIndex, pixelLabImageProblem, pixelLabTilesetProblem, type PixelLabAction, type PixelLabCharacter, type PixelLabCorners,
} from '../core/pixellab.js';
import { colorHistogram, contentBounds, pasteBitmap } from '../core/draw.js';
import { downscale } from '../core/shapes.js';
import { addFrame, celKey, compositeFrame, createSprite, NAME_RE, setTag, type Bitmap, type Sprite } from '../core/sprite.js';
import { spriteFromPng } from './ops.js';
import { decodePng, encodePng } from './png.js';
import type { Workspace } from './store.js';

const API = 'https://api.pixellab.ai/v2';
const STORAGE: Record<string, string> = {
  'https://supabase.pixellab.ai': '/storage/v1/object/public/pixellab-characters/',
  'https://backblaze.pixellab.ai': '/file/pixellab-characters/',
};
const DIRECTIONS = {
  south: 'down', 'south-east': 'down_right', east: 'right', 'north-east': 'up_right',
  north: 'up', 'north-west': 'up_left', west: 'left', 'south-west': 'down_left',
} as const;
const direction = z.enum(Object.keys(DIRECTIONS) as [keyof typeof DIRECTIONS, ...(keyof typeof DIRECTIONS)[]]);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const action = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).describe('A preset (idle, walk, run, attack, hurt, death, interact) or your own name in snake_case; it becomes the tag prefix');
const pngBase64 = z.string().min(1).max(16 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const pixelLabCreate = z.object({
  name: z.string().regex(NAME_RE),
  description: z.string().trim().min(1).max(2000),
  size: z.number().int().min(32).max(168).default(64),
  view: z.enum(['low top-down', 'high top-down']).default('low top-down'),
  reference: z.object({ mode: z.enum(['sprite', 'concept']), png: pngBase64 }).optional(),
  style_png: pngBase64.optional().describe('Base64 PNG up to 168×168 that sets the pixel style. Only together with a concept reference'),
});
const facingList = z.array(direction).min(1).max(8);
export const pixelLabAnimate = z.object({
  id,
  action,
  description: z.string().trim().min(1).max(500).optional().describe('The motion. Required unless action is a preset'),
  directions: facingList.optional().describe('Facings to animate (default all); each one is billed separately'),
  frames: z.number().int().min(4).max(40).optional().describe('v3: even, 4 to 16. pixminimax: multiple of 4. Default 4'),
  mode: z.enum(['v3', 'pixminimax']).default('v3').describe('pixminimax is much cheaper per direction (beta)'),
  groupId: id.optional().describe('Add directions to this existing animation group'),
});
export const pixelLabImport = z.object({
  id,
  name: z.string().regex(NAME_RE),
  animations: z.array(z.object({
    action,
    groupId: id,
    directions: facingList.optional().describe('Facings to import (default all)'),
    duration: z.number().int().min(20).max(2000).optional().describe('Milliseconds per frame'),
  })).max(64).default([]),
}).refine(({ animations }) => new Set(animations.map((clip) => clip.action)).size === animations.length, 'Choose only one group per action');

export const pixelLabImage = z.object({
  name: z.string().regex(NAME_RE).describe('New sprite name; existing sprites are never replaced'),
  description: z.string().trim().min(1).max(2000).describe('What to draw'),
  width: z.number().int().min(16).max(768),
  height: z.number().int().min(16).max(768),
  model: z.enum(PIXELLAB_IMAGE_MODELS).default('pixflux').describe('pixflux: general, sides up to 400. bitforge: small art up to 200, supports style_sprite. pixen: sides divisible by 4, up to 512×512 of area'),
  transparent: z.boolean().default(true).describe('Remove the background (default true). Set false for scenes and backdrops'),
  view: z.enum(PIXELLAB_VIEWS).optional(),
  direction: z.enum(PIXELLAB_DIRECTIONS).optional().describe('Direction the subject faces'),
  outline: z.enum(PIXELLAB_OUTLINES).optional(),
  shading: z.enum(PIXELLAB_SHADINGS).optional().describe('Not available on pixen'),
  detail: z.enum(PIXELLAB_DETAILS).optional(),
  seed: z.number().int().min(0).optional().describe('Repeat a result'),
  style_sprite: z.string().regex(NAME_RE).optional().describe('bitforge only: match the look of this project sprite (its first frame)'),
  style_strength: z.number().int().min(0).max(100).optional().describe('How strongly to apply style_sprite (default 50)'),
  palette_sprite: z.string().regex(NAME_RE).optional().describe('pixflux and bitforge: restrict colors to those of this project sprite (its first frame)'),
});
const terrain = z.string().trim().min(1).max(2000);
const tileReference = z.object({
  sprite: z.string().regex(NAME_RE).describe('Project sprite with a tile grid'),
  tile: z.number().int().min(0).describe('Tile index, row by row'),
});
export const pixelLabTileset = z.object({
  name: z.string().regex(NAME_RE).describe('Name of the sprite to import it as later; must not exist yet'),
  lower_description: terrain.describe('The base terrain, e.g. grass'),
  upper_description: terrain.describe('The terrain laid over it, e.g. a cobblestone street'),
  transition_description: terrain.optional().describe('Optional look of the border between the two'),
  tile_size: z.union([z.literal(16), z.literal(32), z.literal(64)]).default(32).describe('Tile side in pixels (64 needs pro)'),
  mode: z.enum(PIXELLAB_TILESET_MODES).default('pro').describe('pro: richest look, honours view and palettes. standard: cheaper, 16 or 32 px, always high top-down'),
  view: z.enum(PIXELLAB_TILESET_VIEWS).optional().describe('pro only'),
  transition_size: z.union([z.literal(0), z.literal(0.25), z.literal(0.5)]).default(0).describe('Height of the upper terrain: 0 flat ground, 0.25 low bank, 0.5 low walls (standard mode only)'),
  raggedness: z.number().min(0).max(1).optional().describe('pro only: how rough the border is (0 smooth, 1 rough)'),
  boundary_amplitude: z.number().min(0).max(0.3).optional().describe('How far the border wanders from the tile grid'),
  boundary_seed: z.number().int().min(0).optional().describe('Another number gives a different border shape'),
  shading: z.enum(PIXELLAB_SHADINGS).optional(),
  detail: z.enum(PIXELLAB_DETAILS).optional(),
  seed: z.number().int().min(0).optional().describe('Repeat a result'),
  colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(256).optional().describe('pro only: every pixel will be one of these colors'),
  palette_sprite: z.string().regex(NAME_RE).optional().describe('pro only: use the colors of this project sprite (its first frame)'),
  max_colors: z.number().int().min(2).max(64).optional().describe('pro only: cap on the number of colors'),
  lower_reference: tileReference.optional().describe('Reuse this exact terrain as the lower one, so tilesets sharing it join without seams'),
  upper_reference: tileReference.optional().describe('Reuse this exact terrain as the upper one'),
});
export const pixelLabTilesetImport = z.object({
  id: id.describe('tileset_id from pixellab_create_tileset'),
  name: z.string().regex(NAME_RE).describe('New sprite name; existing sprites are never replaced'),
});
const usage = z.object({ type: z.string().optional(), usd: z.number().nullish(), generations: z.number().nullish() });
const generatedTileset = z.object({
  tileset: z.object({
    tiles: z.array(z.object({
      image: z.object({ base64: z.string() }),
      corners: z.record(z.string(), z.string()),
    })),
  }),
});

const animation = z.object({
  animation_type: z.string(),
  display_name: z.string().nullish(),
  animation_group_id: id.nullish(),
  directions: z.array(z.object({
    direction,
    frame_count: z.number().int(),
    frames: z.array(z.string()),
  })),
});
const character = z.object({
  id,
  name: z.string(),
  status: z.string().default('completed'),
  directions: z.union([z.literal(4), z.literal(8)]),
  rotation_urls: z.record(z.string(), z.string().nullable()).nullish(),
  animations: z.array(animation).default([]),
});
type Character = z.infer<typeof character>;
type Direction = keyof typeof DIRECTIONS;

function facings(count: number): Direction[] {
  return direction.options.filter((key) => count === 8 || !key.includes('-'));
}

function presetOf(name: string) {
  return Object.hasOwn(PIXELLAB_ACTIONS, name) ? PIXELLAB_ACTIONS[name as PixelLabAction] : undefined;
}

function complete(group: z.infer<typeof animation>, directions: Direction[]): boolean {
  return directions.every((key) => {
    const matches = group.directions.filter((clip) => clip.direction === key);
    if (matches.length !== 1) return false;
    const { frame_count, frames } = matches[0];
    return frame_count >= 2 && frame_count <= 40 && frames.length === frame_count;
  });
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('PixelLab returned an empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.length;
      if (size > limit) throw new Error('PixelLab response exceeded the size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** PixelLab's own explanation of a refused request, which names the offending field. */
async function rejection(response: Response): Promise<string> {
  try {
    const { detail } = JSON.parse((await boundedBytes(response, 64 * 1024)).toString('utf8')) as { detail?: unknown };
    return (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600);
  } catch {
    return 'invalid parameters';
  }
}

function checkedPng(bytes: Buffer, maxSide: number): Bitmap {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Expected a PNG image');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || Math.max(width, height) > maxSide) throw new Error(`PNG dimensions must fit within ${maxSide} × ${maxSide}`);
  return decodePng(bytes);
}

function frameBounds(bitmap: Bitmap, label: string) {
  const bounds = contentBounds(bitmap);
  if (!bounds) throw new Error(`${label}: empty frame`);
  let hasTransparentPixel = false;
  for (let i = 3; i < bitmap.data.length; i += 4) {
    if (bitmap.data[i] === 0) {
      hasTransparentPixel = true;
      break;
    }
  }
  if (!hasTransparentPixel) throw new Error(`${label}: no transparent pixels`);
  return bounds;
}

/** One tile of a sprite's first frame, checked against the size of the tiles being generated. */
function tileBitmap(sprite: Sprite, tile: number, side: number): Bitmap {
  if (!sprite.grid || sprite.grid.width !== side || sprite.grid.height !== side) throw new Error(`Sprite "${sprite.name}" needs a ${side}×${side} tile grid to be a terrain reference`);
  const columns = Math.floor(sprite.width / side);
  const x = (tile % columns) * side;
  const y = Math.floor(tile / columns) * side;
  if (y + side > sprite.height) throw new Error(`Sprite "${sprite.name}" has no tile ${tile}`);
  const frame = compositeFrame(sprite, 0);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row++) data.set(frame.data.subarray(((y + row) * frame.width + x) * 4, ((y + row) * frame.width + x + side) * 4), row * side * 4);
  return { width: side, height: side, data };
}

type SourceFrame = { bitmap: Bitmap; bounds: ReturnType<typeof frameBounds>; x: number; y: number };
type SourceClip = { name: string; duration: number; frames: SourceFrame[] };

export class PixelLabProvider {
  constructor(private readonly token = process.env.PIXELLAB_API_KEY?.trim(), private readonly request = fetch, private readonly retryDelay = 1000) {}

  get configured(): boolean { return Boolean(this.token); }

  private async json<T>(path: string, schema: z.ZodType<T>, body?: unknown, timeout = 60_000): Promise<T> {
    if (!this.token) throw new Error('Set PIXELLAB_API_KEY in the Spritifer server environment');
    const response = await this.request(API + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      if (response.status === 422) throw new Error(`PixelLab HTTP 422: ${await rejection(response)}`);
      await response.body?.cancel();
      const hint = { 401: 'invalid API key', 402: 'insufficient credits', 404: 'character, tileset or job not found', 423: 'still being generated, try again shortly', 429: 'too many active jobs', 529: 'rate limited, retry shortly' }[response.status];
      throw new Error(`PixelLab HTTP ${response.status}${hint ? `: ${hint}` : ''}`);
    }
    const result = schema.safeParse(JSON.parse((await boundedBytes(response, 8 * 1024 * 1024)).toString('utf8')));
    if (!result.success) throw new Error('Unexpected response from PixelLab');
    return result.data;
  }

  private async png(address: string): Promise<Bitmap> {
    const url = new URL(address);
    if (!Object.hasOwn(STORAGE, url.origin) || url.username || url.password || !url.pathname.startsWith(STORAGE[url.origin])) {
      throw new Error('Unexpected PixelLab image URL');
    }
    let response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    // The storage CDN returns occasional 5xx; one of hundreds of frames must not fail the whole import.
    for (let attempt = 1; response.status >= 500 && attempt < 4; attempt++) {
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, this.retryDelay * attempt));
      response = await this.request(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Could not download PixelLab frame (HTTP ${response.status})`);
    }
    return checkedPng(await boundedBytes(response, 2 * 1024 * 1024), 512);
  }

  async create(input: unknown) {
    const { name, description, reference, size, view, style_png } = pixelLabCreate.parse(input);
    if (style_png && reference?.mode !== 'concept') throw new Error('style_png needs a concept reference');
    if (style_png) frameBounds(checkedPng(Buffer.from(style_png, 'base64'), 168), 'Style reference');
    const common = { description, view, image_size: { width: size, height: size }, no_background: true };
    const response = z.object({ character_id: id, background_job_id: id });
    if (reference?.mode === 'concept') {
      const original = checkedPng(Buffer.from(reference.png, 'base64'), 4096);
      const scale = Math.min(1, 1024 / Math.max(original.width, original.height));
      const image = scale === 1 ? original : downscale(original,
        Math.max(1, Math.round(original.width * scale)), Math.max(1, Math.round(original.height * scale)));
      return this.json('/create-character-pro', response, {
        ...common, method: 'create_from_concept', concept_image: { base64: `data:image/png;base64,${encodePng(image).toString('base64')}` },
        reference_image: style_png ? { base64: `data:image/png;base64,${style_png}` } : undefined,
      });
    }
    let reference_image: { base64: string } | undefined;
    if (reference) {
      frameBounds(checkedPng(Buffer.from(reference.png, 'base64'), 256), 'Reference sprite');
      reference_image = { base64: `data:image/png;base64,${reference.png}` };
    }
    return this.json('/create-character-v3', response, { ...common, name, n_directions: 8, reference_image });
  }

  private get(characterId: string): Promise<Character> {
    return this.json(`/characters/${id.parse(characterId)}`, character);
  }

  async describe(characterId: string): Promise<PixelLabCharacter> {
    const info = await this.get(characterId);
    return {
      id: info.id, name: info.name, status: info.status, directions: info.directions,
      animations: info.animations.flatMap((group) => group.animation_group_id ? [{
        id: group.animation_group_id,
        name: group.display_name || group.animation_type,
        complete: complete(group, facings(info.directions)),
        directions: facings(info.directions).filter((key) => complete(group, [key])),
      }] : []),
    };
  }

  job(jobId: string) {
    return this.json(`/background-jobs/${id.parse(jobId)}`, z.object({ status: z.string(), usage: usage.nullish() }));
  }

  async animate(input: unknown) {
    const { id: characterId, action, description, directions, frames = 4, mode, groupId } = pixelLabAnimate.parse(input);
    const preset = presetOf(action);
    if (!description && !preset) throw new Error(`${action}: custom actions need a description`);
    if (mode === 'v3' && (frames > 16 || frames % 2)) throw new Error('v3 needs an even frame count from 4 to 16');
    if (mode === 'pixminimax' && frames % 4) throw new Error('pixminimax needs a frame count that is a multiple of 4');
    const info = await this.get(characterId);
    if (info.status !== 'completed' || !info.rotation_urls) throw new Error('Wait until the character rotations are ready');
    const available = facings(info.directions);
    const missing = directions?.find((key) => !available.includes(key));
    if (missing) throw new Error(`This character has no ${missing} direction`);
    return this.json('/animate-character', z.object({
      background_job_ids: z.array(id).min(1).max(8),
      animation_group_id: id.nullish(),
    }), {
      character_id: characterId,
      animation_name: action,
      action_description: `${description ?? preset!.prompt}. Keep the same character and camera. Animate in place.`,
      directions: directions ?? available,
      mode, frame_count: frames, keep_first_frame: false,
      animation_group_id: groupId,
    });
  }

  balance() {
    return this.json('/balance', z.object({
      credits: z.object({ usd: z.number() }),
      subscription: z.object({ status: z.string(), plan: z.string().nullish(), generations: z.number(), total: z.number() }),
    }));
  }

  /** Spends credits and returns a new, unsaved sprite. Everything that can be refused is checked before the request. */
  async generateImage(workspace: Workspace, input: unknown): Promise<{ sprite: Sprite; usage?: z.infer<typeof usage> }> {
    const { name, model, width, height, transparent, style_sprite, style_strength, palette_sprite, ...look } = pixelLabImage.parse(input);
    const problem = pixelLabImageProblem({ model, width, height, transparent, shading: look.shading, style_sprite, palette_sprite });
    if (problem) throw new Error(problem);
    if (workspace.exists(name)) throw new Error(`Sprite "${name}" already exists`);
    const reference = (source?: string) => source ? {
      type: 'base64', format: 'png', base64: encodePng(compositeFrame(workspace.load(source), 0)).toString('base64'),
    } : undefined;
    const result = await this.json(`/create-image-${model}`, z.object({ image: z.object({ base64: z.string() }), usage: usage.nullish() }), {
      ...look,
      image_size: { width, height },
      no_background: transparent,
      style_image: reference(style_sprite),
      // PixelLab's default strength of 0 would ignore the style image.
      style_strength: style_sprite ? style_strength ?? 50 : undefined,
      color_image: reference(palette_sprite),
    }, 180_000);
    const png = Buffer.from(result.image.base64.replace(/^data:image\/png;base64,/, ''), 'base64');
    checkedPng(png, 768);
    const sprite = spriteFromPng(name, png);
    sprite.layers[0].name = 'PixelLab';
    sprite.palette = colorHistogram(compositeFrame(sprite, 0)).slice(0, 64).map((entry) => entry.color);
    return { sprite, usage: result.usage ?? undefined };
  }

  /** Starts a 16-tile corner tileset in the background. Spends credits; import the result with tilesetSprite. */
  async createTileset(workspace: Workspace, input: unknown) {
    const { name, tile_size, colors, palette_sprite, max_colors, transition_description, lower_reference, upper_reference, ...look } = pixelLabTileset.parse(input);
    const problem = pixelLabTilesetProblem({ ...look, tile_size, colors, palette_sprite, max_colors, lower_reference, upper_reference });
    if (problem) throw new Error(problem);
    if (workspace.exists(name)) throw new Error(`Sprite "${name}" already exists`);
    const palette = palette_sprite
      ? [...new Set(colorHistogram(compositeFrame(workspace.load(palette_sprite), 0)).map(({ color }) => color.slice(0, 7)))].slice(0, 256)
      : colors;
    if (palette && palette.length < 2) throw new Error(`Sprite "${palette_sprite}" needs at least two colors to be a palette`);
    const referenceImage = (reference?: z.infer<typeof tileReference>) => reference ? {
      type: 'base64', format: 'png', base64: encodePng(tileBitmap(workspace.load(reference.sprite), reference.tile, tile_size)).toString('base64'),
    } : undefined;
    const response = await this.json('/create-tileset', z.object({ tileset_id: id, background_job_id: id }), {
      ...look,
      transition_description: transition_description ?? '',
      tile_size: { width: tile_size, height: tile_size },
      target_palette: palette || max_colors ? { colors: palette, max_colors } : undefined,
      lower_reference_image: referenceImage(lower_reference),
      upper_reference_image: referenceImage(upper_reference),
    });
    return { ...response, name };
  }

  /** Builds an unsaved 4×4 sprite from a finished tileset, each tile at its pixelLabCornerIndex. */
  async tilesetSprite(workspace: Workspace, input: unknown): Promise<Sprite> {
    const { id: tilesetId, name } = pixelLabTilesetImport.parse(input);
    if (workspace.exists(name)) throw new Error(`Sprite "${name}" already exists`);
    const { tileset } = await this.json(`/tilesets/${tilesetId}`, generatedTileset);
    if (tileset.tiles.length !== 16) throw new Error(`Only 16-tile sets can be imported; this one has ${tileset.tiles.length}`);
    const placed = new Map<number, Bitmap>();
    for (const { image, corners } of tileset.tiles) {
      if (!['NW', 'NE', 'SW', 'SE'].every((key) => corners[key] === 'lower' || corners[key] === 'upper')) throw new Error('Unexpected tile corners from PixelLab');
      placed.set(pixelLabCornerIndex(corners as PixelLabCorners), checkedPng(Buffer.from(image.base64.replace(/^data:image\/png;base64,/, ''), 'base64'), 64));
    }
    if (placed.size !== 16) throw new Error('PixelLab returned duplicate tile corners');
    const side = placed.get(0)!.width;
    if ([...placed.values()].some((tile) => tile.width !== side || tile.height !== side)) throw new Error('PixelLab returned tiles of different sizes');
    const sprite = createSprite({ name, width: side * 4, height: side * 4, grid: { width: side, height: side } });
    sprite.layers[0].name = 'PixelLab';
    const sheet = { width: sprite.width, height: sprite.height, data: new Uint8ClampedArray(sprite.width * sprite.height * 4) };
    for (const [index, tile] of placed) pasteBitmap(sheet, tile, (index % 4) * side, Math.floor(index / 4) * side);
    sprite.cels.set(celKey(sprite.layers[0].id, sprite.frames[0].id), sheet.data);
    sprite.palette = colorHistogram(sheet).slice(0, 64).map((entry) => entry.color);
    return sprite;
  }

  async sprite(input: unknown): Promise<Sprite> {
    const { id: characterId, name, animations } = pixelLabImport.parse(input);
    const info = await this.get(characterId);
    if (info.status !== 'completed' || !info.rotation_urls) throw new Error('Wait until the character rotations are ready');
    const directions = facings(info.directions);
    const rotations = info.rotation_urls;
    const selected = animations.map(({ action, groupId, directions: chosen = directions, duration }) => {
      const group = info.animations.find((entry) => entry.animation_group_id === groupId);
      if (!group || !complete(group, chosen)) throw new Error(`${action}: missing directions or frames`);
      return { action, group, chosen, duration: duration ?? presetOf(action)?.duration ?? 120 };
    });
    const frameCount = directions.length + selected.reduce((sum, { group, chosen }) =>
      sum + group.directions.reduce((count, clip) => count + (chosen.includes(clip.direction) ? clip.frames.length : 0), 0), 0);
    if (frameCount > 500) throw new Error('Select fewer clips; the import limit is 500 frames');

    let decodedPixels = 0;
    const readFrame = async (url: string, label: string) => {
      const bitmap = await this.png(url);
      decodedPixels += bitmap.width * bitmap.height;
      if (decodedPixels > 10_000_000) throw new Error('Select fewer clips; generated frames exceed the pixel budget');
      return { bitmap, bounds: frameBounds(bitmap, label) };
    };
    const directionalClips = await Promise.all(directions.map(async (key) => {
      const clips: SourceClip[] = [];
      const facing = DIRECTIONS[key];
      const rotationUrl = rotations[key];
      if (!rotationUrl) throw new Error(`Missing rotation: ${key}`);
      const rest = await readFrame(rotationUrl, key);
      const pivotX = rest.bounds.x + Math.floor(rest.bounds.width / 2);
      const pivotY = rest.bounds.y + rest.bounds.height - 1;
      const restName = selected.some(({ action }) => action === 'idle') ? 'rest' : 'idle';
      clips.push({ name: `${restName}_${facing}`, duration: 160, frames: [{ ...rest, x: -pivotX, y: -pivotY }] });
      for (const { action, group, chosen, duration } of selected) {
        if (!chosen.includes(key)) continue;
        const clip = group.directions.find((entry) => entry.direction === key)!;
        const label = `${action}_${facing}`;
        const frames: SourceFrame[] = [];
        for (const [index, url] of clip.frames.entries()) {
          const frame = await readFrame(url, `${label} frame ${index + 1}`);
          const first = frames[0]?.bitmap;
          if (first && (frame.bitmap.width !== first.width || frame.bitmap.height !== first.height)) {
            throw new Error(`${label}: inconsistent frame dimensions`);
          }
          // Align canvas centres with the rest rotation, preserving movement within the clip.
          frames.push({
            ...frame,
            x: Math.floor(rest.bitmap.width / 2) - Math.floor(frame.bitmap.width / 2) - pivotX,
            y: Math.floor(rest.bitmap.height / 2) - Math.floor(frame.bitmap.height / 2) - pivotY,
          });
        }
        clips.push({ name: label, duration, frames });
      }
      return clips;
    }));
    return nativeSprite(name, info.id, directionalClips.flat());
  }
}

function nativeSprite(name: string, characterId: string, clips: SourceClip[]): Sprite {
  const frames = clips.flatMap((clip) => clip.frames);
  const left = Math.min(0, ...frames.map(({ x, bounds }) => x + bounds.x));
  const right = Math.max(0, ...frames.map(({ x, bounds }) => x + bounds.x + bounds.width - 1));
  const top = Math.min(0, ...frames.map(({ y, bounds }) => y + bounds.y));
  const bottom = Math.max(0, ...frames.map(({ y, bounds }) => y + bounds.y + bounds.height - 1));
  const width = 2 * Math.max(-left, right) + 3;
  const height = bottom - top + 3;
  if (width * height * frames.length > 10_000_000) throw new Error('Select fewer clips; the aligned sprite exceeds the pixel budget');
  const sprite = createSprite({ name, width, height });
  sprite.pixelLabCharacterId = characterId;
  sprite.layers[0].name = 'PixelLab';
  sprite.frames = [];
  for (const clip of clips) {
    const from = sprite.frames.length;
    for (const frame of clip.frames) {
      const native = addFrame(sprite, undefined, { duration: clip.duration });
      const bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
      pasteBitmap(bitmap, frame.bitmap, Math.floor(width / 2) + frame.x, 1 - top + frame.y);
      sprite.cels.set(celKey(sprite.layers[0].id, native.id), bitmap.data);
    }
    setTag(sprite, { name: clip.name, from, to: sprite.frames.length - 1 });
  }
  return sprite;
}
