export const PIXELLAB_ACTIONS = {
  idle: { prompt: 'Stand in place with a subtle breathing loop', duration: 160 },
  walk: { prompt: 'Walk in place in a steady looping cycle', duration: 120 },
  run: { prompt: 'Run in place in a fast looping cycle', duration: 80 },
  attack: { prompt: 'Perform one quick melee attack, then recover', duration: 100 },
  hurt: { prompt: 'Recoil briefly from a hit, then regain balance', duration: 110 },
  death: { prompt: 'Collapse to the ground and stay down', duration: 140 },
  interact: { prompt: 'Reach forward to interact with something, then return to rest', duration: 120 },
} as const;

export type PixelLabAction = keyof typeof PIXELLAB_ACTIONS;

export const PIXELLAB_IMAGE_MODELS = ['pixflux', 'bitforge', 'pixen'] as const;
export const PIXELLAB_VIEWS = ['side', 'low top-down', 'high top-down'] as const;
export const PIXELLAB_DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'] as const;
export const PIXELLAB_OUTLINES = ['single color black outline', 'single color outline', 'selective outline', 'lineless'] as const;
export const PIXELLAB_SHADINGS = ['flat shading', 'basic shading', 'medium shading', 'detailed shading', 'highly detailed shading'] as const;
export const PIXELLAB_DETAILS = ['low detail', 'medium detail', 'highly detailed'] as const;

/** The combinations PixelLab accepts; checked first so a bad request never reaches the paid API. */
export function pixelLabImageProblem(image: {
  model: typeof PIXELLAB_IMAGE_MODELS[number];
  width: number;
  height: number;
  transparent: boolean;
  shading?: string;
  style_sprite?: string;
  palette_sprite?: string;
}): string | undefined {
  const { model, width, height, transparent } = image;
  const area = width * height;
  if (model === 'pixflux') {
    if (Math.max(width, height) > 400 || area < 32 * 32) return 'pixflux needs sides up to 400 px and at least 32×32 of area';
    // Above this area PixelLab bills the same but returns a flat colour instead of transparency.
    if (transparent && area > 40_000) return 'pixflux is transparent only up to 40,000 px of area; reduce the size or set transparent to false';
  }
  if (model === 'bitforge' && Math.max(width, height) > 200) return 'bitforge needs sides up to 200 px';
  if (model === 'pixen') {
    if (area > 512 * 512 || width % 4 || height % 4) return 'pixen needs sides divisible by 4 and at most 512×512 of area';
    if (Math.min(width, height) < 32 && width !== height) return 'pixen images must be square when a side is under 32 px';
    if (transparent && area > 65_536) return 'pixen is transparent only up to 65,536 px of area; reduce the size or set transparent to false';
    if (image.shading) return 'pixen does not support shading';
    if (image.palette_sprite) return 'pixen does not support palette_sprite';
  }
  if (image.style_sprite && model !== 'bitforge') return 'style_sprite requires the bitforge model';
  return undefined;
}

export const PIXELLAB_TILESET_MODES = ['pro', 'standard'] as const;
export const PIXELLAB_TILESET_VIEWS = ['low top-down', 'high top-down'] as const;
export const PIXELLAB_TILE_SIZES = [16, 32, 64] as const;
/** Flat ground, a low raised bank and low walls: the heights that give the 16-tile corner set. */
export const PIXELLAB_TILESET_HEIGHTS = [0, 0.25, 0.5] as const;

/** The combinations PixelLab's tileset endpoint accepts; checked first so a bad request costs nothing. */
export function pixelLabTilesetProblem(tileset: {
  mode: typeof PIXELLAB_TILESET_MODES[number];
  tile_size: number;
  transition_size?: number;
  view?: string;
  raggedness?: number;
  colors?: readonly string[];
  palette_sprite?: string;
  max_colors?: number;
  lower_reference?: unknown;
  upper_reference?: unknown;
}): string | undefined {
  if (tileset.colors && tileset.palette_sprite) return 'Pass colors or palette_sprite, not both';
  // Pro draws tall walls above 0.4: a 25-tile set that the 4×4 sheet cannot hold.
  if (tileset.mode === 'pro') return (tileset.transition_size ?? 0) > 0.4 ? 'In pro mode transition_size must be 0 or 0.25' : undefined;
  if (tileset.lower_reference || tileset.upper_reference) return 'Terrain references require pro mode';
  if (tileset.tile_size === 64) return '64 px tiles require pro mode';
  if (tileset.view) return 'standard mode always draws high top-down; remove view or use pro mode';
  if (tileset.raggedness !== undefined) return 'raggedness requires pro mode';
  if (tileset.colors || tileset.palette_sprite || tileset.max_colors !== undefined) return 'Palettes require pro mode';
  return undefined;
}

export type PixelLabCorners = Record<'NW' | 'NE' | 'SW' | 'SE', 'lower' | 'upper'>;

/** Position of a tile in the 4×4 sheet: the corners on upper terrain, weighted NW 8, NE 4, SW 2, SE 1. */
export function pixelLabCornerIndex(corners: PixelLabCorners): number {
  return (corners.NW === 'upper' ? 8 : 0) + (corners.NE === 'upper' ? 4 : 0) + (corners.SW === 'upper' ? 2 : 0) + (corners.SE === 'upper' ? 1 : 0);
}

export interface PixelLabCharacter {
  id: string;
  name: string;
  status: string;
  directions: number;
  animations: { id: string; name: string; complete: boolean; directions: string[] }[];
}
