/** Renames that keep every reference in the project consistent. */

import { ACTION_MAP, CONDITION_MAP, type ParamType, type StepSpec, TRIGGER_MAP } from './catalog.js';
import { assertIdentifier, type EventStep, type GameEvent, type GameProject, type Scene } from './types.js';

function renameInSteps(steps: EventStep[], specs: Map<string, StepSpec>, types: ParamType[], from: string, to: string): boolean {
  let changed = false;
  for (const s of steps) {
    for (const p of specs.get(s.type)?.params ?? []) {
      if (types.includes(p.type) && s[p.name] === from) {
        s[p.name] = to;
        changed = true;
      }
    }
  }
  return changed;
}

function renameInEvents(events: GameEvent[], types: ParamType[], from: string, to: string): boolean {
  let changed = false;
  for (const e of events) {
    changed = renameInSteps([e.trigger], TRIGGER_MAP, types, from, to) || changed;
    changed = renameInSteps(e.conditions, CONDITION_MAP, types, from, to) || changed;
    changed = renameInSteps(e.actions, ACTION_MAP, types, from, to) || changed;
    // Expressions like count("enemy") mention object names as strings.
    if (types.includes('object')) {
      const re = new RegExp(`(["'])${from}\\1`, 'g');
      for (const s of [...e.conditions, ...e.actions]) {
        for (const [k, v] of Object.entries(s)) {
          if (typeof v === 'string' && re.test(v)) {
            s[k] = v.replace(re, `$1${to}$1`);
            changed = true;
          }
          re.lastIndex = 0;
        }
      }
    }
  }
  return changed;
}

/** Renames an object type; returns the scenes that changed (the game always changes). */
export function renameObjectRefs(game: GameProject, scenes: Scene[], from: string, to: string): Scene[] {
  assertIdentifier('object', to);
  const obj = game.objects.find((o) => o.name === from);
  if (!obj) throw new Error(`No object type "${from}"`);
  if (from !== to && game.objects.some((o) => o.name === to)) throw new Error(`Object type "${to}" already exists`);
  obj.name = to;
  const types: ParamType[] = ['object', 'objectOrAny'];
  for (const o of game.objects) {
    if (o.extends === from) o.extends = to;
    renameInEvents(o.events, types, from, to);
    for (const b of o.behaviors) if (b.type === 'chase' && b.target === from) b.target = to;
  }
  const changed: Scene[] = [];
  for (const s of scenes) {
    let c = renameInEvents(s.events, types, from, to);
    for (const i of s.instances) {
      if (i.object === from) {
        i.object = to;
        c = true;
      }
    }
    if (c) changed.push(s);
  }
  return changed;
}

/** Renames scene references (gotoScene, startScene). Returns the scenes that changed. */
export function renameSceneRefs(game: GameProject, scenes: Scene[], from: string, to: string): Scene[] {
  assertIdentifier('scene', to);
  if (game.startScene === from) game.startScene = to;
  for (const o of game.objects) renameInEvents(o.events, ['scene'], from, to);
  return scenes.filter((s) => renameInEvents(s.events, ['scene'], from, to));
}

/** Renames a script component everywhere it is used: object types, instances, scene and game components, events. */
export function renameComponentRefs(game: GameProject, scenes: Scene[], from: string, to: string): { game: boolean; scenes: Scene[] } {
  let g = false;
  const fix = (list: { type: string; name?: unknown }[] | undefined) => {
    let c = false;
    for (const b of list ?? []) {
      if (b.type === 'script' && b.name === from) {
        b.name = to;
        c = true;
      }
    }
    return c;
  };
  for (const o of game.objects) {
    g = fix(o.behaviors) || g;
    g = renameInEvents(o.events, ['scriptBehavior'], from, to) || g;
  }
  g = fix(game.components) || g;
  const changed: Scene[] = [];
  for (const s of scenes) {
    let c = fix(s.components);
    c = renameInEvents(s.events, ['scriptBehavior'], from, to) || c;
    for (const i of s.instances) {
      if (i.components && from in i.components) {
        i.components[to] = i.components[from];
        delete i.components[from];
        c = true;
      }
    }
    if (c) changed.push(s);
  }
  return { game: g, scenes: changed };
}
