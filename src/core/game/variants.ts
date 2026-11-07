/**
 * Object type variants (like Unity prefab variants): a type with `extends: "slime"` starts from its parent
 * and only stores what it changes. resolveObjectTypes() builds the effective types the engine runs.
 */

import type { Behavior, ObjectType } from './types.js';

/** Key that identifies "the same" behavior in a parent and a variant (built-ins by type, components by name). */
export const behaviorKey = (b: Behavior) => (b.type === 'script' ? `script:${String(b.name ?? '')}` : b.type);

/** A variant on top of its (already resolved) parent. */
export function mergeVariant(parent: ObjectType, child: ObjectType): ObjectType {
  const behaviors = parent.behaviors.map((b) => ({ ...b }));
  for (const b of child.behaviors) {
    const i = behaviors.findIndex((x) => behaviorKey(x) === behaviorKey(b));
    if (i >= 0) behaviors[i] = { ...behaviors[i], ...b };
    else behaviors.push({ ...b });
  }
  const tags = [...new Set([...(parent.tags ?? []), ...(child.tags ?? [])])];
  const out: ObjectType = {
    ...parent,
    ...Object.fromEntries(Object.entries(child).filter(([, v]) => v !== undefined)),
    name: child.name,
    extends: child.extends,
    properties: { ...parent.properties, ...child.properties },
    behaviors,
    events: [...parent.events, ...child.events],
  };
  if (tags.length) out.tags = tags;
  else delete out.tags;
  return out;
}

export interface ResolvedTypes {
  types: Map<string, ObjectType>;
  /** Name → itself and its ancestors ("red_slime" → ["red_slime", "slime"]). */
  lineage: Map<string, string[]>;
  errors: { object: string; message: string }[];
}

export function resolveObjectTypes(objects: ObjectType[]): ResolvedTypes {
  const raw = new Map(objects.map((o) => [o.name, o]));
  const types = new Map<string, ObjectType>();
  const lineage = new Map<string, string[]>();
  const errors: ResolvedTypes['errors'] = [];
  const resolve = (name: string, stack: string[]): ObjectType | undefined => {
    const done = types.get(name);
    if (done) return done;
    const o = raw.get(name);
    if (!o) return undefined;
    let result = o;
    let line = [name];
    if (o.extends) {
      if (stack.includes(o.extends) || o.extends === name) {
        errors.push({ object: name, message: `variant loop: ${[...stack, name, o.extends].join(' → ')}` });
      } else {
        const parent = resolve(o.extends, [...stack, name]);
        if (!parent) errors.push({ object: name, message: `based on "${o.extends}", which doesn't exist` });
        else {
          result = mergeVariant(parent, o);
          line = [name, ...(lineage.get(o.extends) ?? [o.extends])];
        }
      }
    }
    types.set(name, result);
    lineage.set(name, line);
    return result;
  };
  for (const o of objects) resolve(o.name, []);
  return { types, lineage, errors };
}

/** The effective type of one object (with what it inherits). */
export function resolveObject(objects: ObjectType[], name: string): ObjectType | undefined {
  return resolveObjectTypes(objects).types.get(name);
}
