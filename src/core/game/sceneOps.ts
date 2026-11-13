/** Work on whole parts of a map: copy and paste regions, scatter instances, named groups that can be redone. */

import { fineBlockedTiles } from './fineSolid.js';
import { type Instance, type Scene, newGameId } from './types.js';

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ScatterItem {
  object: string;
  sprite?: string;
  animation?: string;
  /** How often this one comes up compared with the others (default 1). */
  weight?: number;
}

export interface ScatterRecipe {
  items: ScatterItem[];
  /** In tiles; default the whole scene. */
  region?: TileRect;
  /** How many to place; or use density. */
  count?: number;
  /** How many per 100 tiles of the region. */
  density?: number;
  /** Least distance between the bases of two instances, in pixels. */
  minDistance?: number;
  seed: number;
  /** Don't place on solid tiles (default true). */
  avoidSolid?: boolean;
  /** Only on these tiles of this layer. */
  onTiles?: { layer: string; tiles: number[] };
  /** Mirror about half of them. */
  flip?: boolean;
}

export interface SceneGroup {
  /** The scatters that made this group, redone by regenerateGroup. */
  scatters?: ScatterRecipe[];
}

export type SizeOf = (item: { object: string; sprite?: string }) => { w: number; h: number };

/** Part of a map, with instance positions relative to its top-left corner. */
export interface SceneStamp {
  w: number;
  h: number;
  tileSize: number;
  layers: { name: string; tiles: number[] }[];
  instances: Instance[];
}

/** Copies a region. With `ids`, exactly those instances instead of the ones inside the region. */
export function extractRegion(scene: Scene, rect: TileRect, opts: { tiles?: boolean; instances?: boolean; ids?: Set<string>; layers?: string[] } = {}): SceneStamp {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const w = Math.max(0, Math.min(scene.cols, rect.x + rect.w) - x0);
  const h = Math.max(0, Math.min(scene.rows, rect.y + rect.h) - y0);
  const layers = opts.tiles === false ? [] : scene.layers.filter((l) => !opts.layers || opts.layers.includes(l.name)).map((l) => {
    const tiles: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) tiles.push(l.tiles[(y0 + y) * scene.cols + x0 + x]);
    return { name: l.name, tiles };
  });
  const px = { x: x0 * scene.tileSize, y: y0 * scene.tileSize, w: w * scene.tileSize, h: h * scene.tileSize };
  const inside = (i: Instance) => i.x >= px.x && i.y >= px.y && i.x < px.x + px.w && i.y < px.y + px.h;
  const instances = opts.instances === false ? [] : scene.instances
    .filter((i) => (opts.ids ? opts.ids.has(i.id) : inside(i)))
    .map((i) => ({ ...(JSON.parse(JSON.stringify(i)) as Instance), x: i.x - px.x, y: i.y - px.y }));
  return { w, h, tileSize: scene.tileSize, layers, instances };
}

/** Pastes with its top-left at tile (tx, ty). Empty cells leave the map as it is, unless overwrite. */
export function pasteRegion(scene: Scene, stamp: SceneStamp, tx: number, ty: number, opts: { group?: string; overwrite?: boolean } = {}): { instances: Instance[]; tiles: number } {
  if (stamp.layers.length && stamp.tileSize !== scene.tileSize) throw new Error(`The copied part has ${stamp.tileSize} px tiles, this scene ${scene.tileSize} px`);
  let tiles = 0;
  for (const part of stamp.layers) {
    let layer = scene.layers.find((l) => l.name === part.name);
    if (!layer) {
      if (part.tiles.every((t) => t < 0)) continue;
      layer = { name: part.name, tiles: new Array(scene.cols * scene.rows).fill(-1), solid: false, visible: true };
      scene.layers.push(layer);
    }
    for (let y = 0; y < stamp.h; y++) {
      for (let x = 0; x < stamp.w; x++) {
        const t = part.tiles[y * stamp.w + x];
        const X = tx + x;
        const Y = ty + y;
        if ((t < 0 && !opts.overwrite) || X < 0 || Y < 0 || X >= scene.cols || Y >= scene.rows) continue;
        layer.tiles[Y * scene.cols + X] = t;
        tiles++;
      }
    }
  }
  const made = stamp.instances.map((i): Instance => {
    const copy = JSON.parse(JSON.stringify(i)) as Instance;
    copy.id = newGameId();
    copy.x = i.x + tx * scene.tileSize;
    copy.y = i.y + ty * scene.tileSize;
    if (opts.group) copy.group = opts.group;
    return copy;
  });
  scene.instances.push(...made);
  return { instances: made, tiles };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wholeScene = (s: Scene): TileRect => ({ x: 0, y: 0, w: s.cols, h: s.rows });

function clampRect(s: Scene, r: TileRect): TileRect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.max(0, Math.min(s.cols, r.x + r.w) - x), h: Math.max(0, Math.min(s.rows, r.y + r.h) - y) };
}

/** Places instances at random under the recipe's rules; the same recipe on the same map gives the same result. */
export function scatter(scene: Scene, recipe: ScatterRecipe, sizeOf: SizeOf, group?: string): Instance[] {
  if (!recipe.items.length) throw new Error('Scatter needs at least one object');
  const region = clampRect(scene, recipe.region ?? wholeScene(scene));
  const area = region.w * region.h;
  if (!area) return [];
  const wanted = Math.max(0, Math.round(recipe.count ?? (area * (recipe.density ?? 5)) / 100));
  const random = rng(recipe.seed);
  const tile = scene.tileSize;
  const minD2 = (recipe.minDistance ?? tile) ** 2;
  const solidLayers = recipe.avoidSolid === false ? [] : scene.layers.filter((l) => l.solid);
  const fineTiles = recipe.avoidSolid === false ? null : fineBlockedTiles(scene);
  const only = recipe.onTiles ? scene.layers.find((l) => l.name === recipe.onTiles!.layer) : undefined;
  if (recipe.onTiles && !only) throw new Error(`No layer "${recipe.onTiles.layer}"`);
  const allowed = recipe.onTiles ? new Set(recipe.onTiles.tiles) : null;
  const bases = scene.instances.map((i) => {
    const size = sizeOf(i);
    return { x: i.x + size.w / 2, y: i.y + size.h };
  });
  const totalWeight = recipe.items.reduce((sum, item) => sum + Math.max(0, item.weight ?? 1), 0);
  if (totalWeight <= 0) throw new Error('Scatter weights are all zero');
  const pick = () => {
    let r = random() * totalWeight;
    for (const item of recipe.items) {
      r -= Math.max(0, item.weight ?? 1);
      if (r < 0) return item;
    }
    return recipe.items[recipe.items.length - 1];
  };
  const made: Instance[] = [];
  for (let attempt = 0; attempt < wanted * 40 && made.length < wanted; attempt++) {
    const bx = (region.x + random() * region.w) * tile;
    const by = (region.y + random() * region.h) * tile;
    const k = Math.floor(by / tile) * scene.cols + Math.floor(bx / tile);
    if (solidLayers.some((l) => l.tiles[k] >= 0) || fineTiles?.[k]) continue;
    if (only && !allowed!.has(only.tiles[k])) continue;
    if (bases.some((b) => (b.x - bx) ** 2 + (b.y - by) ** 2 < minD2)) continue;
    const item = pick();
    const size = sizeOf(item);
    const inst: Instance = { id: newGameId(), object: item.object, x: Math.round(bx - size.w / 2), y: Math.round(by - size.h) };
    if (item.sprite) inst.sprite = item.sprite;
    if (item.animation) inst.animation = item.animation;
    if (recipe.flip && random() < 0.5) inst.flipX = true;
    if (group) inst.group = group;
    made.push(inst);
    bases.push({ x: bx, y: by });
  }
  scene.instances.push(...made);
  return made;
}

/** Scatters and remembers how, so the group can be redone. */
export function scatterIntoGroup(scene: Scene, group: string, recipe: ScatterRecipe, sizeOf: SizeOf): Instance[] {
  const made = scatter(scene, recipe, sizeOf, group);
  if (!made.length) return made;
  scene.groups ??= {};
  (scene.groups[group] ??= {}).scatters = [...(scene.groups[group].scatters ?? []), recipe];
  return made;
}

/** Redoes every scatter of a group, inside its area only; what the group has elsewhere stays. */
export function regenerateGroup(scene: Scene, group: string, sizeOf: SizeOf, seed?: number): Instance[] {
  const recipes = scene.groups?.[group]?.scatters;
  if (!recipes?.length) throw new Error(`Group "${group}" was not made by a scatter: there is nothing to redo`);
  const made: Instance[] = [];
  recipes.forEach((recipe, n) => {
    const region = recipe.region ?? wholeScene(scene);
    const px = { x: region.x * scene.tileSize, y: region.y * scene.tileSize, w: region.w * scene.tileSize, h: region.h * scene.tileSize };
    scene.instances = scene.instances.filter((i) => {
      if (i.group !== group) return true;
      const size = sizeOf(i);
      const bx = i.x + size.w / 2;
      const by = i.y + size.h;
      return !(bx >= px.x && by >= px.y && bx <= px.x + px.w && by <= px.y + px.h);
    });
    if (seed !== undefined) recipe.seed = seed + n;
  });
  for (const recipe of recipes) made.push(...scatter(scene, recipe, sizeOf, group));
  return made;
}

/** Group names and how many instances each has, also groups that are currently empty. */
export function listGroups(scene: Scene): { name: string; count: number; scatters: number }[] {
  const counts = new Map<string, number>(Object.keys(scene.groups ?? {}).map((g) => [g, 0]));
  for (const i of scene.instances) if (i.group) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count, scatters: scene.groups?.[name]?.scatters?.length ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteGroup(scene: Scene, group: string, keepInstances = false): number {
  let n = 0;
  scene.instances = scene.instances.filter((i) => {
    if (i.group !== group) return true;
    n++;
    if (keepInstances) delete i.group;
    return keepInstances;
  });
  if (scene.groups?.[group]) {
    delete scene.groups[group];
    if (!Object.keys(scene.groups).length) delete scene.groups;
  }
  return n;
}

export function renameGroup(scene: Scene, from: string, to: string): void {
  if (from === to) return;
  if (listGroups(scene).some((g) => g.name === to)) throw new Error(`Group "${to}" already exists`);
  for (const i of scene.instances) if (i.group === from) i.group = to;
  if (scene.groups?.[from]) {
    scene.groups[to] = scene.groups[from];
    delete scene.groups[from];
  }
}
