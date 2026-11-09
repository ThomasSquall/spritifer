/** Blueprints on disk: from a blueprint in a scene to its tiles, walls and instances, and back from what was edited by hand. */

import type { Bitmap, Sprite } from '../core/sprite.js';
import { compositeFrame, createSprite } from '../core/sprite.js';
import { type BakedMap, type KitArt, type MapKit, TileSheet, bakePlan } from '../core/game/blueprintBake.js';
import { type Blueprint, type BpContext, type BpPlan, type BpProblem, type BpSpace, blueprintInstances, checkElements, elementAt, normalizeBlueprint, planBlueprint, planHdCells, runChecks } from '../core/game/blueprint.js';
import { draftBlueprint } from '../core/game/blueprintDraft.js';
import { type BpSurface, draftPainted, isScatter, planPainted, surfaceOf } from '../core/game/blueprintOpenAir.js';
import { TileResolver } from '../core/game/tilerules.js';
import { compile } from '../core/game/expr.js';
import type { GameProject, Instance, ObjectType, Scene, Value } from '../core/game/types.js';
import { resolveObjectTypes } from '../core/game/variants.js';
import type { Workspace } from './store.js';

const WALL_ROWS = 3;

/** The kit name that means: this map's terrain stays as it was painted. */
export const PAINTED = 'painted';

export function blueprintContext(ws: Workspace, tile: number, flowSprite?: string): { ctx: BpContext; types: Map<string, ObjectType> } {
  const sizes = new Map(ws.list().map((s) => [s.name, { w: s.width, h: s.height }]));
  const { types } = resolveObjectTypes(ws.loadGame().objects);
  const ctx: BpContext = {
    tile,
    ...(flowSprite ? { waterSprite: flowSprite } : {}),
    sizeOf: (e) => sizes.get(e.sprite ?? types.get(e.object)?.sprite ?? '') ?? null,
    bodyOf: (i) => {
      const o = types.get(i.object);
      return o?.hitbox && o.behaviors.some((b) => b.type === 'solid') ? { x: i.x + o.hitbox.x, y: i.y + o.hitbox.y, w: o.hitbox.w, h: o.hitbox.h } : null;
    },
  };
  return { ctx, types };
}

export function kitNamed(game: GameProject, name: string): MapKit {
  const kit = game.mapKits?.[name];
  if (!kit) throw new Error(`No map kit "${name}". Kits: ${Object.keys(game.mapKits ?? {}).join(', ') || 'none yet (set_map_kit)'}.`);
  return kit;
}

function loadArt(ws: Workspace, kit: MapKit): KitArt {
  const bmp = (name: string): Bitmap => compositeFrame(ws.load(name), 0);
  return {
    wall: bmp(kit.wall.sprite),
    floor: bmp(kit.floor.sprite),
    roof: bmp(kit.roof.sprite),
    ...(kit.pier ? { pier: bmp(kit.pier.sprite) } : {}),
    ...(kit.moss ? { moss: bmp(kit.moss.sprite) } : {}),
    ...(kit.water ? { water: bmp(kit.water.sprite) } : {}),
    ...(kit.dry ? { dry: bmp(kit.dry.sprite) } : {}),
  };
}

const evaluator = (expr: string, vars: Record<string, Value>) => !!compile(expr)({ get: (path) => vars[path.join('.')] ?? 0, call: () => 0 });

export interface BlueprintBuild {
  problems: BpProblem[];
  plan: BpPlan;
  wrote: boolean;
  blueprint: Blueprint;
  /** What was edited by hand since the last build and went back into the blueprint. */
  absorbed: string[];
}

function bakeWith(bp: Blueprint, plan: BpPlan, kit: MapKit, art: KitArt, sheet: TileSheet, name: string): BakedMap {
  const baked = bakePlan(plan, name, kit, art, sheet);
  return baked;
}

function loadSheet(ws: Workspace, kit: MapKit, tile: number): { sheet: TileSheet; sprite: Sprite | null } {
  const exists = ws.list().some((s) => s.name === kit.tileset);
  if (!exists) return { sheet: new TileSheet(null, tile), sprite: null };
  const sprite = ws.load(kit.tileset);
  return { sheet: new TileSheet(compositeFrame(sprite, 0), sprite.grid?.width ?? tile), sprite };
}

function saveSheet(ws: Workspace, kit: MapKit, sheet: TileSheet, sprite: Sprite | null): void {
  const bmp = sheet.bitmap();
  const out = sprite ?? createSprite({ name: kit.tileset, width: bmp.width, height: bmp.height });
  out.width = bmp.width;
  out.height = bmp.height;
  out.grid = { width: sheet.size, height: sheet.size };
  out.cels = new Map([[`${out.layers[0]!.id}/${out.frames[0]!.id}`, bmp.data]]);
  ws.save(out, 'blueprint');
}

/** Brings into the blueprint what was changed on the map itself: moved or removed instances, new ones, tiles painted over it. */
function absorbEdits(ws: Workspace, scene: Scene, bp: Blueprint, kit: MapKit, art: KitArt, ctx: BpContext): string[] {
  const notes: string[] = [];
  const expected = new Map(blueprintInstances(bp, ctx).map((i) => [i.id, i]));
  const elements = new Map(bp.elements.map((e) => [e.id, e]));
  const present = new Set(scene.instances.map((i) => i.id));
  for (const e of [...bp.elements]) {
    if (!present.has(e.id)) {
      bp.elements = bp.elements.filter((x) => x !== e);
      notes.push(`removed ${e.name ?? e.object}`);
    }
  }
  const fields: (keyof Instance)[] = ['name', 'sprite', 'animation', 'activeIf', 'props', 'components', 'tags', 'light', 'group', 'flipX'];
  for (const i of scene.instances) {
    const was = expected.get(i.id);
    if (!was) {
      const size = ctx.sizeOf(i);
      const fx = i.x + (size?.w ?? 0) / 2;
      const fy = i.y + (size?.h ?? 0);
      const home = bp.spaces.find((s) => s.rects.some((r) => fx >= r[0] * ctx.tile && fy >= r[1] * ctx.tile && fx < (r[0] + r[2]) * ctx.tile && fy <= (r[1] + r[3]) * ctx.tile)) ?? bp.spaces[0];
      if (!home) continue;
      const mount = size ? 'floor' : 'marker';
      const { x: _x, y: _y, ...rest } = i;
      bp.elements.push({ ...rest, in: home.id, mount, at: elementAt(bp, home.id, mount, i, ctx) });
      notes.push(`added ${i.name ?? i.object}`);
      continue;
    }
    const e = elements.get(i.id);
    if (!e) continue; // moving water: made from its area
    if (was.x !== i.x || was.y !== i.y) {
      e.at = elementAt(bp, e.in, e.mount, i, ctx);
      notes.push(`moved ${i.name ?? i.object}`);
    }
    for (const f of fields) {
      if (JSON.stringify(i[f]) !== JSON.stringify(was[f])) {
        if (i[f] === undefined) delete (e as unknown as Record<string, unknown>)[f];
        else (e as unknown as Record<string, unknown>)[f] = i[f];
        notes.push(`changed ${f} of ${i.name ?? i.object}`);
      }
    }
  }
  // Tiles: only trusted if the map still is what this blueprint compiles to.
  const plan = planBlueprint(bp, WALL_ROWS);
  const ground = scene.layers.find((l) => !l.solid);
  const solid = scene.layers.find((l) => l.solid);
  if (ground && solid && scene.cols === plan.cols && scene.rows === plan.rows && scene.tileset === kit.tileset) {
    const { sheet } = loadSheet(ws, kit, ctx.tile);
    const baked = bakeWith(bp, plan, kit, art, sheet, scene.name);
    const paint: NonNullable<Blueprint['paint']> = {};
    let differing = 0;
    for (let i = 0; i < baked.ground.length; i++) {
      const g = ground.tiles[i]!;
      const w = solid.tiles[i]!;
      if (g === baked.ground[i] && w === baked.walls[i]) continue;
      differing++;
      paint[`${i % plan.cols},${Math.floor(i / plan.cols)}`] = { ...(g !== baked.ground[i] ? { g } : {}), ...(w !== baked.walls[i] ? { w } : {}) };
    }
    if (differing <= baked.ground.length * 0.15) {
      if (differing && JSON.stringify(paint) !== JSON.stringify(bp.paint ?? {})) notes.push(`${differing} tile(s) painted by hand`);
      if (differing) bp.paint = paint;
      else delete bp.paint;
    }
    const auto = planHdCells(plan);
    const own = Object.fromEntries(Object.entries(scene.hdCells ?? {}).filter(([k, v]) => auto[k] !== v));
    if (Object.keys(own).length) bp.hdCells = own;
    else delete bp.hdCells;
  }
  return notes;
}

function ensureBlocks(game: GameProject, bp: Blueprint, tile: number): boolean {
  let changed = false;
  const template = game.objects.find((o) => /^blk_/.test(o.name));
  for (const e of bp.elements) {
    const m = /^blk_(\d+)x(\d+)$/.exec(e.object);
    if (!m || game.objects.some((o) => o.name === e.object)) continue;
    game.objects.push({ ...(template ?? { properties: {}, behaviors: [{ type: 'solid' }], events: [] }), name: e.object, hitbox: { x: 0, y: 0, w: Number(m[1]) * tile, h: Number(m[2]) * tile } } as ObjectType);
    changed = true;
  }
  return changed;
}

/**
 * Compiles a blueprint into its scene. With errors nothing is written, unless `force`; `dryRun` only reports.
 * Start from currentBlueprint when changing a scene that has one: what was edited on the map since the last build is in it.
 */
export function buildBlueprint(ws: Workspace, sceneName: string, input: unknown, opts: { dryRun?: boolean; force?: boolean; by?: string; absorbed?: string[] } = {}): BlueprintBuild {
  const incoming = normalizeBlueprint(input);
  if (!incoming) throw new Error('No blueprint given.');
  if (incoming.terrain === 'painted') return buildPainted(ws, sceneName, incoming, opts);
  const game = ws.loadGame();
  const kit = kitNamed(game, incoming.kit);
  const scene = ws.listScenes().some((s) => s.name === sceneName) ? ws.loadScene(sceneName) : null;
  const tile = scene?.tileSize ?? 32;
  const { ctx } = blueprintContext(ws, tile, kit.flowSprite);
  const art = loadArt(ws, kit);
  const absorbed = opts.absorbed ?? [];
  const bp = incoming;
  const plan = planBlueprint(bp, WALL_ROWS);
  const problems = [...plan.problems, ...checkElements(bp, plan, ctx), ...runChecks(bp, plan, ctx, evaluator)];
  const failed = problems.some((p) => p.level === 'error');
  if (opts.dryRun || (failed && !opts.force)) return { problems, plan, wrote: false, blueprint: bp, absorbed };

  const { sheet, sprite } = loadSheet(ws, kit, tile);
  const baked = bakeWith(bp, plan, kit, art, sheet, sceneName);
  for (const [k, v] of Object.entries(bp.paint ?? {})) {
    const [x, y] = k.split(',').map(Number) as [number, number];
    const i = y * plan.cols + x;
    if (x >= plan.cols || i >= baked.ground.length) continue;
    if (v.g !== undefined) baked.ground[i] = v.g;
    if (v.w !== undefined) baked.walls[i] = v.w;
  }
  if (sheet.changed) saveSheet(ws, kit, sheet, sprite);
  let gameChanged = ensureBlocks(game, bp, tile);
  if (baked.rules.length) {
    const rules = ((game.tilesets ??= {})[kit.tileset] ??= {}).rules ??= [];
    for (const r of baked.rules) {
      if (rules.some((x) => x.tile === r.tile)) continue;
      rules.push(r);
      gameChanged = true;
    }
  }
  if (gameChanged) ws.saveGame(game, opts.by ?? 'blueprint');

  const base: Scene = scene ?? { format: 'spritifer-scene', version: 1, name: sceneName, cols: plan.cols, rows: plan.rows, tileSize: tile, background: '#0d0f1a', backgrounds: [], layers: [], instances: [], events: [], ySort: true, variables: {}, rev: '' };
  const hdCells = { ...planHdCells(plan), ...(bp.hdCells ?? {}) };
  const out: Scene = {
    ...base,
    cols: plan.cols,
    rows: plan.rows,
    tileSize: tile,
    tileset: kit.tileset,
    layers: [{ name: 'ground', tiles: baked.ground, solid: false, visible: true }, { name: 'walls', tiles: baked.walls, solid: true, visible: false }],
    instances: blueprintInstances(bp, ctx),
    blueprint: bp,
    ...(Object.keys(hdCells).length ? { hdCells } : {}),
  };
  if (baked.juts.length) out.hdJuts = baked.juts;
  else delete out.hdJuts;
  ws.saveScene(out, opts.by ?? 'blueprint');
  return { problems, plan, wrote: true, blueprint: bp, absorbed };
}

function surfaceFor(ws: Workspace, scene: Scene): BpSurface {
  return surfaceOf(scene, new TileResolver(ws.loadGame().tilesets?.[scene.tileset ?? '']));
}

/** Painted terrain: tiles and scatter stay as they are, only what the blueprint names is placed from it. */
function buildPainted(ws: Workspace, sceneName: string, bp: Blueprint, opts: { dryRun?: boolean; force?: boolean; by?: string; absorbed?: string[] }): BlueprintBuild {
  const scene = ws.loadScene(sceneName);
  const { ctx } = blueprintContext(ws, scene.tileSize);
  const surface = surfaceFor(ws, scene);
  const plan = planPainted(bp, surface);
  const placed = blueprintInstances(bp, ctx);
  const named = new Set([...(scene.blueprint?.elements ?? []).map((e) => e.id), ...bp.elements.map((e) => e.id)]);
  const scatter = scene.instances.filter((i) => !named.has(i.id));
  const problems = [...plan.problems, ...checkElements(bp, plan, ctx), ...runChecks(bp, plan, ctx, evaluator, scatter)];
  const absorbed = opts.absorbed ?? [];
  if (opts.dryRun || (problems.some((p) => p.level === 'error') && !opts.force)) return { problems, plan, wrote: false, blueprint: bp, absorbed };
  ws.saveScene({ ...scene, instances: [...scatter, ...placed], blueprint: bp }, opts.by ?? 'blueprint');
  return { problems, plan, wrote: true, blueprint: bp, absorbed };
}

/** What has been changed on a painted map goes into its blueprint: anything but scatter. */
function absorbPainted(scene: Scene, bp: Blueprint, ctx: BpContext, types: ReadonlyMap<string, ObjectType>): string[] {
  const notes: string[] = [];
  const expected = new Map(blueprintInstances(bp, ctx).map((i) => [i.id, i]));
  const present = new Set(scene.instances.map((i) => i.id));
  for (const e of [...bp.elements]) {
    if (present.has(e.id)) continue;
    bp.elements = bp.elements.filter((x) => x !== e);
    notes.push(`removed ${e.name ?? e.object}`);
  }
  const elements = new Map(bp.elements.map((e) => [e.id, e]));
  for (const i of scene.instances) {
    const was = expected.get(i.id);
    const e = elements.get(i.id);
    if (!was || !e) {
      if (isScatter(i, types)) continue;
      const size = ctx.sizeOf(i);
      const fx = i.x + (size?.w ?? 0) / 2;
      const fy = i.y + (size?.h ?? 0);
      const home = bp.spaces.find((s) => s.rects.some((r) => fx >= r[0] * ctx.tile && fy >= r[1] * ctx.tile && fx < (r[0] + r[2]) * ctx.tile && fy <= (r[1] + r[3]) * ctx.tile)) ?? bp.spaces[0];
      if (!home) continue;
      const mount = size ? 'floor' : 'marker';
      const { x: _x, y: _y, ...rest } = i;
      bp.elements.push({ ...rest, in: home.id, mount, at: elementAt(bp, home.id, mount, i, ctx) });
      notes.push(`added ${i.name ?? i.object}`);
      continue;
    }
    if (was.x !== i.x || was.y !== i.y) {
      e.at = elementAt(bp, e.in, e.mount, i, ctx);
      notes.push(`moved ${i.name ?? i.object}`);
    }
    for (const f of ['name', 'sprite', 'animation', 'activeIf', 'props', 'components', 'tags', 'light', 'group', 'flipX'] as const) {
      if (JSON.stringify(i[f]) === JSON.stringify(was[f])) continue;
      if (i[f] === undefined) delete (e as unknown as Record<string, unknown>)[f];
      else (e as unknown as Record<string, unknown>)[f] = i[f];
      notes.push(`changed ${f} of ${i.name ?? i.object}`);
    }
  }
  return notes;
}

/** The blueprint of a scene with what has been edited on the map since the last build already in it. */
export function currentBlueprint(ws: Workspace, sceneName: string): { blueprint: Blueprint; absorbed: string[] } | null {
  const scene = ws.loadScene(sceneName);
  if (!scene.blueprint) return null;
  const bp = normalizeBlueprint(JSON.parse(JSON.stringify(scene.blueprint))) as Blueprint;
  if (bp.terrain === 'painted') {
    const { ctx, types } = blueprintContext(ws, scene.tileSize);
    return { blueprint: bp, absorbed: absorbPainted(scene, bp, ctx, types) };
  }
  const kit = kitNamed(ws.loadGame(), bp.kit);
  const { ctx } = blueprintContext(ws, scene.tileSize, kit.flowSprite);
  return { blueprint: bp, absorbed: absorbEdits(ws, scene, bp, kit, loadArt(ws, kit), ctx) };
}

/** Draft of a blueprint from a scene as it is. */
export function draftFromScene(ws: Workspace, sceneName: string, kitName: string, zones?: BpSpace[]): Blueprint {
  if (kitName === PAINTED) {
    const scene = ws.loadScene(sceneName);
    const { ctx, types } = blueprintContext(ws, scene.tileSize);
    return draftPainted(scene, ctx, types, surfaceFor(ws, scene), zones);
  }
  const game = ws.loadGame();
  const kit = kitNamed(game, kitName);
  const scene = ws.loadScene(sceneName);
  const { ctx, types } = blueprintContext(ws, scene.tileSize, kit.flowSprite);
  const animated = new Set((game.tilesets?.[kit.tileset]?.rules ?? []).filter((r) => (r as { frames?: number }).frames).map((r) => r.tile));
  return draftBlueprint(scene, kitName, kit, ctx, types, (t) => animated.has(t));
}
