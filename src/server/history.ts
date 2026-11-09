/**
 * One history of the game for the editor and the MCP server: every change to the game settings, scenes, tables,
 * effects, scripts and dialogues, who made it, and how to undo it without losing what came after.
 * Kept as files in .spritifer/history because the editor and the MCP server can be different processes.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { jsonEqual, mergeUndo } from '../core/game/mergeUndo.js';
import { type GameProject, type Scene, normalizeGame, normalizeScene, normalizeTable } from '../core/game/types.js';
import { normalizeVfx } from '../core/game/vfxGraph.js';
import type { Workspace } from './store.js';

export type HistoryKind = 'game' | 'scene' | 'data' | 'vfx' | 'script' | 'dialogue';

export interface HistoryEntry {
  id: string;
  time: number;
  author: string;
  kind: HistoryKind;
  name: string;
  summary: string;
  /** This entry undid that one. */
  undoOf?: string;
  /** The entry that undid this one. */
  undoneBy?: string;
}

const MAX_ENTRIES = 400;
/** Autosaves of one editing session count as one change. */
const COALESCE_MS = 5000;
const TEXT_KINDS: HistoryKind[] = ['script', 'dialogue'];

function countChanged(before: unknown[], after: unknown[], key: string): { added: number; removed: number; changed: number } {
  const get = (x: unknown) => (x as Record<string, unknown>)[key];
  const old = new Map(before.map((x) => [get(x), x]));
  const now = new Map(after.map((x) => [get(x), x]));
  let added = 0;
  let changed = 0;
  for (const [id, x] of now) {
    if (!old.has(id)) added++;
    else if (!jsonEqual(old.get(id), x)) changed++;
  }
  return { added, changed, removed: [...old.keys()].filter((id) => !now.has(id)).length };
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

function describeScene(b: Scene, a: Scene): string {
  const parts: string[] = [];
  const i = countChanged(b.instances, a.instances, 'id');
  if (i.added) parts.push(`+${plural(i.added, 'instance')}`);
  if (i.removed) parts.push(`-${plural(i.removed, 'instance')}`);
  if (i.changed) parts.push(`${plural(i.changed, 'instance')} changed`);
  let tiles = 0;
  for (const l of a.layers) {
    const old = b.layers.find((x) => x.name === l.name);
    if (old?.tiles.length === l.tiles.length) tiles += l.tiles.filter((t, k) => t !== old.tiles[k]).length;
  }
  if (tiles) parts.push(plural(tiles, 'tile'));
  const others = (['events', 'variables', 'components', 'atmosphere', 'backgrounds', 'music', 'ambience', 'groups'] as const).filter((k) => !jsonEqual(b[k], a[k]));
  if (others.length) parts.push(others.join(', '));
  if (a.cols !== b.cols || a.rows !== b.rows) parts.push(`resized to ${a.cols}x${a.rows}`);
  return parts.join(', ') || 'settings';
}

function describeGame(b: GameProject, a: GameProject): string {
  const parts: string[] = [];
  const o = countChanged(b.objects, a.objects, 'name');
  const names = (list: typeof a.objects) => list.slice(0, 3).map((x) => x.name).join(', ');
  const added = a.objects.filter((x) => !b.objects.some((y) => y.name === x.name));
  const changed = a.objects.filter((x) => { const y = b.objects.find((z) => z.name === x.name); return y && !jsonEqual(x, y); });
  if (o.added) parts.push(`new object ${names(added)}`);
  if (o.removed) parts.push(`-${plural(o.removed, 'object')}`);
  if (o.changed) parts.push(`object ${names(changed)}${o.changed > 3 ? ` +${o.changed - 3}` : ''}`);
  if (!jsonEqual(b.variables, a.variables)) parts.push('variables');
  if (!jsonEqual(b.tilesets, a.tilesets)) parts.push('tile rules');
  if (!jsonEqual(b.components, a.components)) parts.push('global components');
  return parts.join(', ') || 'settings';
}

function describe(kind: HistoryKind, before: string | null, after: string | null): string {
  if (before === null) return 'created';
  if (after === null) return 'deleted';
  try {
    if (kind === 'scene') return describeScene(normalizeScene(JSON.parse(before)), normalizeScene(JSON.parse(after)));
    if (kind === 'game') return describeGame(normalizeGame(JSON.parse(before)), normalizeGame(JSON.parse(after)));
    if (kind === 'data') {
      const r = countChanged((JSON.parse(before) as { rows: unknown[] }).rows, (JSON.parse(after) as { rows: unknown[] }).rows, 'id');
      return [r.added && `+${plural(r.added, 'row')}`, r.removed && `-${plural(r.removed, 'row')}`, r.changed && `${plural(r.changed, 'row')} changed`].filter(Boolean).join(', ') || 'columns';
    }
    if (TEXT_KINDS.includes(kind)) {
      const old = new Set(before.split('\n'));
      const now = after.split('\n');
      const added = now.filter((l) => !old.has(l)).length;
      const kept = new Set(now);
      const removed = [...old].filter((l) => !kept.has(l)).length;
      return `+${added} -${removed} lines`;
    }
  } catch {
    // A file edited by hand into something unreadable still has a place in the history.
  }
  return 'edited';
}

export class ProjectHistory {
  private last: { id: string; key: string; author: string; time: number } | null = null;
  private seq = 0;
  /** Set while an undo is applied: the entry it undoes. */
  undoing: string | null = null;

  constructor(private readonly dir: string) {}

  private metaFile(id: string): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid history id "${id}"`);
    return path.join(this.dir, `${id}.json`);
  }

  private dataFile(id: string): string {
    return path.join(this.dir, `${id}.gz`);
  }

  private writeEntry(entry: HistoryEntry, before: string | null, after: string | null): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.dataFile(entry.id), zlib.gzipSync(JSON.stringify({ before, after })));
    fs.writeFileSync(this.metaFile(entry.id), JSON.stringify(entry));
  }

  record(kind: HistoryKind, name: string, author: string, before: string | null, after: string | null): void {
    if (before === after) return;
    if (!TEXT_KINDS.includes(kind) && before !== null && after !== null) {
      try {
        if (jsonEqual(JSON.parse(before), JSON.parse(after))) return;
      } catch {
        // Not JSON: compared as text above.
      }
    }
    const key = `${kind}:${name}`;
    const now = Date.now();
    if (!this.undoing && this.last && this.last.key === key && this.last.author === author && author === 'editor' && now - this.last.time < COALESCE_MS && fs.existsSync(this.metaFile(this.last.id))) {
      const previous = this.read(this.last.id);
      if (!previous.entry.undoneBy) {
        this.writeEntry({ ...previous.entry, time: now, summary: describe(kind, previous.before, after) }, previous.before, after);
        this.last.time = now;
        return;
      }
    }
    const id = `${now.toString(36)}-${(this.seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
    const entry: HistoryEntry = { id, time: now, author, kind, name, summary: describe(kind, before, after), ...(this.undoing ? { undoOf: this.undoing } : {}) };
    this.writeEntry(entry, before, after);
    this.last = this.undoing ? null : { id, key, author, time: now };
    this.trim();
  }

  private trim(): void {
    const metas = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of metas.slice(0, Math.max(0, metas.length - MAX_ENTRIES))) {
      const id = f.slice(0, -5);
      fs.rmSync(this.metaFile(id), { force: true });
      fs.rmSync(this.dataFile(id), { force: true });
    }
  }

  /** Newest first. */
  list(filter: { author?: string; kind?: HistoryKind; name?: string; limit?: number } = {}): HistoryEntry[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: HistoryEntry[] = [];
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as HistoryEntry;
        if ((filter.author && e.author !== filter.author) || (filter.kind && e.kind !== filter.kind) || (filter.name && e.name !== filter.name)) continue;
        out.push(e);
        if (filter.limit && out.length >= filter.limit) break;
      } catch {
        // Another process is writing it.
      }
    }
    return out;
  }

  read(id: string): { entry: HistoryEntry; before: string | null; after: string | null } {
    const file = this.metaFile(id);
    if (!fs.existsSync(file)) throw new Error(`No change "${id}" in the history (only the last ${MAX_ENTRIES} are kept)`);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryEntry;
    const { before, after } = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.dataFile(id))).toString('utf8')) as { before: string | null; after: string | null };
    return { entry, before, after };
  }

  markUndone(id: string, by: string): void {
    const file = this.metaFile(id);
    const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryEntry;
    fs.writeFileSync(file, JSON.stringify({ ...entry, undoneBy: by }));
  }
}

function currentText(ws: Workspace, kind: HistoryKind, name: string): string | null {
  const file = kind === 'game' ? ws.gameFile()
    : kind === 'scene' ? ws.sceneFile(name)
    : kind === 'data' ? ws.tableFile(name)
    : kind === 'vfx' ? ws.vfxFile(name)
    : kind === 'script' ? ws.scriptFile(name)
    : ws.dialogueFile(name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function apply(ws: Workspace, kind: HistoryKind, name: string, text: string | null, author: string): void {
  if (text === null) {
    if (kind === 'scene') ws.removeScene(name, author);
    else if (kind === 'data') ws.removeTable(name, author);
    else if (kind === 'vfx') ws.removeVfx(name, author);
    else if (kind === 'script') ws.removeScript(name, author);
    else if (kind === 'dialogue') ws.removeDialogue(name, author);
    else throw new Error('The game settings cannot be removed');
    return;
  }
  if (kind === 'game') ws.saveGame(normalizeGame(JSON.parse(text)), author);
  else if (kind === 'scene') ws.saveScene({ ...normalizeScene(JSON.parse(text)), name }, author);
  else if (kind === 'data') ws.saveTable(normalizeTable(JSON.parse(text), name), author);
  else if (kind === 'vfx') ws.saveVfx(normalizeVfx(JSON.parse(text), name), author);
  else if (kind === 'script') ws.writeScript(name, text, author);
  else ws.writeDialogue(name, text, author);
}

export interface UndoOutcome {
  entry: HistoryEntry;
  /** Parts changed again after that change: they were left as they are. */
  conflicts: string[];
}

/** Undoes one change, keeping later edits. Refuses when nothing of it can be undone safely. */
export function undoChange(ws: Workspace, id: string, author: string): UndoOutcome {
  const { entry, before, after } = ws.history.read(id);
  if (entry.undoneBy) throw new Error('This change has already been undone');
  const { kind, name } = entry;
  const current = currentText(ws, kind, name);
  let next: string | null;
  let conflicts: string[] = [];
  if (TEXT_KINDS.includes(kind)) {
    if (current !== after) throw new Error(`${name} has been edited since this change, so it can't be undone line by line. Use the file's version in Git, or undo the later changes first.`);
    next = before;
  } else if (before === null) {
    if (current === null) throw new Error(`${name} no longer exists`);
    if (!jsonEqual(JSON.parse(current), JSON.parse(after as string))) throw new Error(`${name} has been edited since it was created; delete it by hand if you really want it gone`);
    next = null;
  } else if (after === null) {
    if (current !== null) throw new Error(`${name} exists again: nothing to restore`);
    next = before;
  } else if (current === null) {
    next = before;
  } else {
    const merged = mergeUndo(JSON.parse(before), JSON.parse(after), JSON.parse(current));
    conflicts = merged.conflicts;
    if (jsonEqual(merged.value, JSON.parse(current))) throw new Error(`Everything this change did has been changed again${conflicts.length ? `: ${conflicts.slice(0, 5).join(', ')}` : ''}`);
    next = JSON.stringify(merged.value);
  }
  ws.history.undoing = id;
  try {
    apply(ws, kind, name, next, author);
  } finally {
    ws.history.undoing = null;
  }
  const made = ws.history.list({ kind, name, limit: 1 })[0];
  ws.history.markUndone(id, made?.undoOf === id ? made.id : 'unknown');
  return { entry, conflicts };
}

export function formatHistory(list: HistoryEntry[]): string {
  if (!list.length) return 'The history is empty.';
  return list.map((e) => `${e.id}  ${new Date(e.time).toISOString().slice(5, 19).replace('T', ' ')}  ${e.author.padEnd(7)} ${e.kind} ${e.name}: ${e.summary}${e.undoOf ? ' (undo)' : ''}${e.undoneBy ? ' [undone]' : ''}`).join('\n');
}
