/**
 * Undoing one change while keeping what came after it. Given a JSON value before and after the change and
 * its current state, restores only what that change did. Parts edited again since then stay as they are and
 * are reported as conflicts.
 */

export type Json = unknown;

const IGNORED = new Set(['rev', 'updatedBy']);
const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);

export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!IGNORED.has(k) && !jsonEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** The field that identifies items of this array, when every item has a distinct one. */
function identity(lists: Json[][]): 'id' | 'name' | null {
  for (const key of ['id', 'name'] as const) {
    const ok = lists.every((list) => {
      const seen = new Set<unknown>();
      return list.every((x) => {
        if (!isObj(x) || typeof x[key] !== 'string' || seen.has(x[key])) return false;
        seen.add(x[key]);
        return true;
      });
    });
    if (ok) return key;
  }
  return null;
}

export interface UndoResult {
  value: Json;
  conflicts: string[];
}

export function mergeUndo(before: Json, after: Json, current: Json): UndoResult {
  const conflicts: string[] = [];

  const merge = (b: Json, a: Json, c: Json, path: string): Json => {
    if (jsonEqual(a, c)) return b;
    if (jsonEqual(b, a) || jsonEqual(b, c)) return c;
    if (isObj(b) && isObj(a) && isObj(c)) {
      const out: Record<string, Json> = {};
      for (const k of new Set([...Object.keys(c), ...Object.keys(b), ...Object.keys(a)])) {
        if (IGNORED.has(k)) {
          if (k in c) out[k] = c[k];
          continue;
        }
        const v = merge(b[k], a[k], c[k], path ? `${path}.${k}` : k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    if (Array.isArray(b) && Array.isArray(a) && Array.isArray(c)) {
      // Tile layers: cell by cell.
      if (b.length === a.length && a.length === c.length && [b, a, c].every((l) => l.every((x) => typeof x === 'number'))) {
        let lost = 0;
        const out = c.map((v, i) => {
          if (a[i] === v) return b[i];
          if (b[i] !== a[i]) lost++;
          return v;
        });
        if (lost) conflicts.push(`${path}: ${lost} cell(s) changed again`);
        return out;
      }
      const key = identity([b, a, c]);
      if (key) {
        const by = (list: Json[]) => new Map(list.map((x) => [(x as Record<string, Json>)[key] as string, x]));
        const B = by(b);
        const A = by(a);
        const out: Json[] = [];
        for (const item of c) {
          const id = (item as Record<string, Json>)[key] as string;
          const v = merge(B.get(id), A.get(id), item, `${path}[${id}]`);
          if (v !== undefined) out.push(v);
        }
        const inOut = new Set(out.map((x) => (x as Record<string, Json>)[key]));
        // What the change removed goes back near where it was.
        b.forEach((item, index) => {
          const id = (item as Record<string, Json>)[key] as string;
          if (inOut.has(id) || A.has(id) || c.some((x) => (x as Record<string, Json>)[key] === id)) return;
          out.splice(Math.min(index, out.length), 0, item);
        });
        return out;
      }
    }
    conflicts.push(path || '(whole value)');
    return c;
  };

  return { value: merge(before, after, current, ''), conflicts };
}
