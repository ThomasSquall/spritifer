/** The scenes of a game and how they connect, plus the checks that need the map: unreachable scenes, one-way doors, things placed where nobody can get. */

import { fineBlockedTiles } from './fineSolid.js';
import type { Problem } from './catalog.js';
import { type Instance, type ObjectType, type Scene, hitboxOf } from './types.js';
import { resolveObjectTypes } from './variants.js';
import { type ProjectSources, findUsages } from './usages.js';

export interface WorldLink {
  /** The scene the link starts in; null when it comes from code or data that is not tied to one scene. */
  from: string | null;
  to: string;
  via: 'door' | 'event' | 'component' | 'script' | 'dialogue' | 'data';
  where: string;
  instanceId?: string;
  x?: number;
  y?: number;
  line?: number;
}

export interface WorldScene {
  name: string;
  cols: number;
  rows: number;
  instances: number;
  rev: string;
  reachable: boolean;
  /** True when only code or data leads here. */
  scripted: boolean;
}

export interface WorldMap {
  start: string;
  scenes: WorldScene[];
  links: WorldLink[];
  unreachable: string[];
  oneWay: WorldLink[];
}

export function buildWorldMap(p: ProjectSources): WorldMap {
  const links: WorldLink[] = [];
  const names = new Set(p.scenes.map((s) => s.name));
  // Object type sheets run in every scene that has that object.
  const scenesWith = new Map<string, string[]>();
  for (const s of p.scenes) {
    for (const object of new Set(s.instances.map((i) => i.object))) scenesWith.set(object, [...(scenesWith.get(object) ?? []), s.name]);
  }
  const seen = new Set<string>();
  const add = (l: WorldLink) => {
    const key = `${l.from}|${l.to}|${l.instanceId ?? l.where}`;
    if (seen.has(key) || !names.has(l.to)) return;
    seen.add(key);
    links.push(l);
  };

  for (const s of p.scenes) {
    for (const u of findUsages(p, 'scene', s.name)) {
      const base = { to: s.name, where: u.where };
      if (u.area === 'instance') add({ ...base, from: u.scene!, via: 'door', instanceId: u.instanceId, x: u.x, y: u.y });
      else if (u.area === 'scene') add({ ...base, from: u.scene!, via: 'event' });
      else if (u.area === 'object') {
        for (const from of scenesWith.get(u.owner) ?? []) add({ ...base, where: `${u.owner}: ${u.where}`, from, via: 'component' });
      } else if (u.area === 'script') add({ ...base, where: `scripts/${u.owner}.js ${u.where}`, from: null, via: 'script', line: u.line });
      else if (u.area === 'dialogue') add({ ...base, where: `dialogues/${u.owner} ${u.where}`, from: null, via: 'dialogue', line: u.line });
      else if (u.area === 'data') add({ ...base, where: `data ${u.owner} ${u.where}`, from: null, via: 'data' });
    }
  }

  const start = p.scenes.some((s) => s.name === p.game.startScene) ? p.game.startScene : (p.scenes[0]?.name ?? '');
  // Code and data can run from anywhere, so what they name counts as reachable.
  const reachable = new Set<string>(start ? [start] : []);
  for (const l of links) if (l.from === null) reachable.add(l.to);
  const queue = [...reachable];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const l of links) {
      if (l.from === cur && !reachable.has(l.to)) {
        reachable.add(l.to);
        queue.push(l.to);
      }
    }
  }

  const fromCode = new Set(links.filter((l) => l.from === null).map((l) => l.to));
  const fromMap = new Set(links.filter((l) => l.from !== null).map((l) => l.to));
  const scenes: WorldScene[] = p.scenes.map((s) => ({
    name: s.name, cols: s.cols, rows: s.rows, instances: s.instances.length, rev: s.rev,
    reachable: reachable.has(s.name),
    scripted: fromCode.has(s.name) && !fromMap.has(s.name),
  }));
  // Scripts usually bring the player back from wherever they sent them, so only doors count as one-way.
  const oneWay = links.filter((l) => l.via === 'door' && l.from !== l.to && !links.some((b) => b.to === l.from && (b.from === l.to || b.from === null)));
  return { start, scenes, links, unreachable: scenes.filter((s) => !s.reachable).map((s) => s.name), oneWay };
}

type SizeOf = (sprite: string | undefined) => { w: number; h: number } | undefined;

/** Center of what collides with the ground: the hitbox, or the bottom of the sprite when there is none. */
function foot(i: Instance, o: ObjectType, sizeOf: SizeOf, tile: number): { x: number; y: number } {
  const hb = hitboxOf(i, o);
  if (hb) return { x: i.x + hb.x + hb.w / 2, y: i.y + hb.y + hb.h / 2 };
  const size = sizeOf(i.sprite ?? o.sprite) ?? { w: tile, h: tile };
  return { x: i.x + size.w / 2, y: i.y + size.h - tile / 2 };
}

/** Things worth reaching: anything with behavior beyond being an obstacle. */
const interactive = (o: ObjectType) => o.behaviors.some((b) => b.type !== 'solid' && b.type !== 'sine' && b.type !== 'lifetime');

/** A sprite this tall on a floor layer (z between TALL_FLAT_Z and 0) is probably meant to stand up. Lower z = painted ground art. */
const TALL_FLAT_PX = 56;
const TALL_FLAT_Z = -5;

export function checkMaps(p: ProjectSources, world: WorldMap, sizeOf: SizeOf): Problem[] {
  const out: Problem[] = [];
  for (const name of world.unreachable) out.push({ where: `scene ${name}`, message: 'nothing leads to this scene (no door, event, script or data names it)' });
  for (const l of world.oneWay) out.push({ where: `scene ${l.from} door ${l.where}`, message: `leads to ${l.to}, but nothing in ${l.to} leads back` });

  const { types } = resolveObjectTypes(p.game.objects);
  const playerTypes = new Set([...types.values()].filter((o) => o.behaviors.some((b) => b.type === 'topdown')).map((o) => o.name));

  for (const s of p.scenes) {
    const solid = new Uint8Array(s.cols * s.rows);
    for (const l of s.layers) if (l.solid) l.tiles.forEach((t, k) => { if (t >= 0) solid[k] = 1; });
    // Fine collision: a tile more than half covered counts as solid, as for paths.
    fineBlockedTiles(s)?.forEach((v, k) => { if (v) solid[k] = 1; });
    if (s.collisionFineError) out.push({ where: `scene ${s.name}`, message: s.collisionFineError });
    const cell = (i: Instance, o: ObjectType) => {
      const f = foot(i, o, sizeOf, s.tileSize);
      return { x: Math.floor(f.x / s.tileSize), y: Math.floor(f.y / s.tileSize) };
    };
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < s.cols && y < s.rows;
    const here = (i: Instance) => `scene ${s.name} instance ${i.name ?? i.object} #${i.id}`;

    // A door whose arrival point is off the map: whoever comes through it can't walk back in.
    for (const i of s.instances) {
      const o = types.get(i.object);
      const base = o?.behaviors.find((b) => b.type === 'script' && (b as { name?: string }).name === 'Warp');
      if (!o || !(base || i.components?.Warp)) continue;
      const { dx, dy } = { ...base, ...i.components?.Warp } as { dx?: unknown; dy?: unknown };
      const offset = (v: unknown) => (typeof v === 'number' ? v * s.tileSize : 0);
      const f = foot(i, o, sizeOf, s.tileSize);
      const x = Math.floor((f.x + offset(dx)) / s.tileSize);
      const y = Math.floor((f.y + offset(dy)) / s.tileSize);
      if (!inside(x, y)) out.push({ where: here(i), message: `arrival is outside the map: tile (${x}, ${y}) of ${s.cols}x${s.rows}. dx and dy must point inward` });
    }

    // Stuck in a wall: anything with a body and a sprite. Invisible triggers are often placed on purpose over walls.
    for (const i of s.instances) {
      const o = types.get(i.object);
      if (!o || o.hud || !(i.sprite ?? o.sprite) || !(hitboxOf(i, o) && interactive(o))) continue;
      const c = cell(i, o);
      if (inside(c.x, c.y) && solid[c.y * s.cols + c.x]) out.push({ where: here(i), message: `stands on a solid tile (${c.x}, ${c.y})` });
    }

    // Props glued together: two bodies in the same place. Alternatives for different moments of the story don't count.
    const bodies = s.instances.flatMap((i) => {
      const o = types.get(i.object);
      const hb = hitboxOf(i, o);
      return hb && (i.sprite ?? o?.sprite) && o?.behaviors.some((b) => b.type === 'solid') ? [{ i, x: i.x + hb.x, y: i.y + hb.y, w: hb.w, h: hb.h }] : [];
    });
    for (let a = 0; a < bodies.length; a++) {
      for (let b = a + 1; b < bodies.length; b++) {
        const A = bodies[a]!;
        const B = bodies[b]!;
        if (A.i.activeIf && B.i.activeIf) continue;
        if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) out.push({ where: here(A.i), message: `is stuck into ${B.i.name ?? B.i.object} #${B.i.id}` });
      }
    }

    // Something tall painted on the floor: it can be walked through, is not hidden by anything and casts no shadow.
    for (const i of s.instances) {
      const o = types.get(i.object);
      if (!o || (o.z ?? 0) >= 0 || (o.z ?? 0) < TALL_FLAT_Z || o.behaviors.some((b) => b.type === 'solid')) continue;
      const size = sizeOf(i.sprite ?? o.sprite);
      const h = size?.h ?? 0;
      if (h < TALL_FLAT_PX) continue;
      // Hanging on a wall (a gate, a gear, a window) is what the floor layer is for.
      let onWall = false;
      for (let y = Math.floor(i.y / s.tileSize); y <= Math.floor((i.y + h - 1) / s.tileSize) && !onWall; y++) {
        for (let x = Math.floor(i.x / s.tileSize); x <= Math.floor((i.x + size!.w - 1) / s.tileSize); x++) if (inside(x, y) && solid[y * s.cols + x]) onWall = true;
      }
      if (!onWall) out.push({ where: here(i), message: `is ${h} px tall but lies flat on the ground: no collider, no shadow` });
    }

    // Pockets, for top-down maps: where can the player walk, from where they start and from every door?
    const isDoor = new Set(world.links.filter((l) => l.via === 'door' && l.from === s.name).map((l) => l.instanceId));
    const seeds = s.instances.filter((i) => playerTypes.has(i.object) || isDoor.has(i.id));
    if (!seeds.length || !s.layers.some((l) => l.solid) || !(s.instances.some((i) => playerTypes.has(i.object)) || isDoor.size)) continue;
    const seen = new Uint8Array(s.cols * s.rows);
    const stack: number[] = [];
    const push = (x: number, y: number) => {
      if (!inside(x, y)) return;
      const k = y * s.cols + x;
      if (seen[k] || solid[k]) return;
      seen[k] = 1;
      stack.push(k);
    };
    for (const i of seeds) {
      const o = types.get(i.object);
      if (!o) continue;
      const c = cell(i, o);
      // A door can sit in the wall gap or on the map edge: start from the cells around it too.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) push(c.x + dx, c.y + dy);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % s.cols;
      const y = (k - x) / s.cols;
      push(x + 1, y);
      push(x - 1, y);
      push(x, y + 1);
      push(x, y - 1);
    }
    if (!stack.length && seen.every((v) => !v)) continue;
    for (const i of s.instances) {
      const o = types.get(i.object);
      if (!o || o.hud || !interactive(o) || playerTypes.has(i.object) || isDoor.has(i.id) || !(i.sprite ?? o.sprite)) continue;
      const c = cell(i, o);
      if (!inside(c.x, c.y) || solid[c.y * s.cols + c.x]) continue;
      // Next to a walkable cell counts: most things are used from the side.
      const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => inside(c.x + dx, c.y + dy) && seen[(c.y + dy) * s.cols + c.x + dx]);
      if (!near) out.push({ where: here(i), message: 'is in a part of the map the player cannot walk to' });
    }
  }
  return out;
}
