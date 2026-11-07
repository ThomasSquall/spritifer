/**
 * Live inspection of a running World (the editor's Play inspector): a serializable view of the scene
 * (variables, instances, component fields) and edits applied back to the running game.
 */

import type { Actor, World } from './engine.js';
import { type Behaviour, componentState, fieldsOf } from './script.js';
import type { Value } from './types.js';

export interface ComponentView {
  index: number;
  name: string;
  enabled: boolean;
  fields: Record<string, Value>;
}

export interface ActorView {
  id: number;
  object: string;
  name: string;
  sceneId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  visible: boolean;
  opacity: number;
  angle: number;
  z: number;
  facing: string;
  animation: string;
  tags: string[];
  vars: Record<string, Value>;
  components: ComponentView[];
}

export interface WorldView {
  scene: string;
  time: number;
  clock: number;
  frame: number;
  camera: { x: number; y: number };
  controlsLocked: boolean;
  dialog: string | null;
  globals: Record<string, Value>;
  sceneVars: Record<string, Value>;
  gameComponents: ComponentView[];
  sceneComponents: ComponentView[];
  actors: ActorView[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const compViews = (list: Behaviour[]): ComponentView[] =>
  list.map((c, index) => {
    const st = componentState(c);
    const fields: Record<string, Value> = {};
    for (const [k, v] of Object.entries(fieldsOf(c))) fields[k] = typeof v === 'number' ? r2(v) : v;
    return { index, name: st?.name ?? '?', enabled: st?.enabled ?? false, fields };
  });

const visibleVars = (vars: Record<string, Value>) => Object.fromEntries(Object.entries(vars).filter(([k]) => !k.startsWith('__')));

export function inspectWorld(w: World): WorldView {
  return {
    scene: w.scene.name,
    time: r2(w.time),
    clock: r2(w.clock),
    frame: w.frame,
    camera: { x: r2(w.camera.x), y: r2(w.camera.y) },
    controlsLocked: w.controlsLocked,
    dialog: w.scripts.dialog ? `${w.scripts.dialog.speaker ? w.scripts.dialog.speaker + ': ' : ''}${w.scripts.dialog.text}` : null,
    globals: visibleVars(w.globals),
    sceneVars: { ...w.sceneVars },
    gameComponents: compViews(w.gameComponents),
    sceneComponents: compViews(w.sceneComponents),
    actors: w.actors.filter((a) => !a.destroyed).map((a) => ({
      id: a.id,
      object: a.type.name,
      name: w.displayName(a),
      sceneId: a.sceneId ?? '',
      x: r2(a.x),
      y: r2(a.y),
      vx: r2(a.vx),
      vy: r2(a.vy),
      visible: a.visible,
      opacity: a.opacity,
      angle: a.angle,
      z: a.z,
      facing: a.facing,
      animation: a.anim,
      tags: [...a.tags],
      vars: visibleVars(a.vars),
      components: compViews(a.components),
    })),
  };
}

/** One change made in the inspector. */
export type WorldEdit =
  | { kind: 'global' | 'sceneVar'; key: string; value: Value }
  | { kind: 'camera'; key: 'x' | 'y'; value: number }
  | { kind: 'actor'; id: number; key: string; value: Value }
  | { kind: 'actorVar'; id: number; key: string; value: Value }
  | { kind: 'component'; scope: 'game' | 'scene' | 'object'; id?: number; index: number; key: string; value: Value };

const ACTOR_FIELDS: Record<string, 'number' | 'bool' | 'string'> = { x: 'number', y: 'number', vx: 'number', vy: 'number', opacity: 'number', angle: 'number', z: 'number', visible: 'bool', facing: 'string', animation: 'string' };

/** Applies an inspector edit. Returns false when the target no longer exists. */
export function editWorld(w: World, e: WorldEdit): boolean {
  const actor = (id: number): Actor | undefined => w.actors.find((a) => a.id === id && !a.destroyed);
  switch (e.kind) {
    case 'global':
      w.globals[e.key] = e.value;
      return true;
    case 'sceneVar':
      w.sceneVars[e.key] = e.value;
      return true;
    case 'camera':
      w.camera[e.key] = Number(e.value) || 0;
      return true;
    case 'actor': {
      const a = actor(e.id);
      const type = ACTOR_FIELDS[e.key];
      if (!a || !type) return false;
      if (e.key === 'animation') w.setAnim(a, String(e.value));
      else if (e.key === 'facing') a.facing = String(e.value) as Actor['facing'];
      else (a as unknown as Record<string, Value>)[e.key] = type === 'number' ? Number(e.value) || 0 : type === 'bool' ? e.value === true || e.value === 'true' : String(e.value);
      return true;
    }
    case 'actorVar': {
      const a = actor(e.id);
      if (!a) return false;
      a.vars[e.key] = e.value;
      return true;
    }
    case 'component': {
      const list = e.scope === 'game' ? w.gameComponents : e.scope === 'scene' ? w.sceneComponents : actor(e.id ?? -1)?.components;
      const c = list?.[e.index];
      if (!c) return false;
      if (e.key === 'enabled') c.enabled = e.value === true;
      else (c as unknown as Record<string, Value>)[e.key] = e.value;
      return true;
    }
  }
}
