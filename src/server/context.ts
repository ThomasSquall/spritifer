/**
 * What the person at the editor is looking at, their notes on the map and the errors of their last Play.
 * Files, because the editor server and the MCP server can be different processes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { newGameId } from '../core/game/types.js';
import type { Workspace } from './store.js';

export interface EditorSelectionItem {
  id: string;
  object: string;
  name?: string;
  x: number;
  y: number;
  group?: string;
}

export interface EditorContext {
  updatedAt: number;
  page: string;
  scene?: string;
  sprite?: string;
  object?: string;
  script?: string;
  dialogue?: string;
  table?: string;
  effect?: string;
  playing?: boolean;
  tool?: string;
  /** Tile under the pointer. */
  tile?: { x: number; y: number };
  /** Instances selected in the scene editor. */
  selection?: EditorSelectionItem[];
  /** Selected rectangle of tiles. */
  region?: { x: number; y: number; w: number; h: number };
}

export interface MapNote {
  id: string;
  scene: string;
  x: number;
  y: number;
  text: string;
  author: string;
  time: number;
  resolved?: boolean;
  reply?: string;
}

const CONTEXT = 'context.json';
const PLAY_LOG = 'play-log.json';
const NOTES = 'notes.json';
const MAX_LOG = 200;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file);
}

export function saveEditorContext(ws: Workspace, ctx: Omit<EditorContext, 'updatedAt'>): void {
  writeJson(path.join(ws.metaDir, CONTEXT), { ...ctx, updatedAt: Date.now() });
}

export function loadEditorContext(ws: Workspace): EditorContext | null {
  return readJson<EditorContext | null>(path.join(ws.metaDir, CONTEXT), null);
}

export function appendPlayLog(ws: Workspace, lines: string[], reset = false): void {
  const file = path.join(ws.metaDir, PLAY_LOG);
  const prev = reset ? [] : readJson<{ time: number; message: string }[]>(file, []);
  const time = Date.now();
  writeJson(file, [...prev, ...lines.map((message) => ({ time, message }))].slice(-MAX_LOG));
}

export function loadPlayLog(ws: Workspace): { time: number; message: string }[] {
  return readJson(path.join(ws.metaDir, PLAY_LOG), []);
}

export function listNotes(ws: Workspace): MapNote[] {
  return readJson<MapNote[]>(path.join(ws.dir, NOTES), []);
}

function saveNotes(ws: Workspace, notes: MapNote[]): void {
  writeJson(path.join(ws.dir, NOTES), notes);
}

/** Creates a note (no id) or changes one; `remove` deletes it. */
export function setNote(ws: Workspace, change: { id?: string; scene?: string; x?: number; y?: number; text?: string; resolved?: boolean; reply?: string; remove?: boolean }, author: string): MapNote | null {
  const notes = listNotes(ws);
  if (!change.id) {
    if (!change.scene || !ws.sceneExists(change.scene)) throw new Error(`Scene "${change.scene ?? ''}" not found`);
    if (!change.text?.trim()) throw new Error('A note needs some text');
    const note: MapNote = { id: newGameId(), scene: change.scene, x: Math.round(change.x ?? 0), y: Math.round(change.y ?? 0), text: change.text.trim(), author, time: Date.now() };
    saveNotes(ws, [...notes, note]);
    return note;
  }
  const note = notes.find((n) => n.id === change.id);
  if (!note) throw new Error(`No note "${change.id}"`);
  if (change.remove) {
    saveNotes(ws, notes.filter((n) => n !== note));
    return null;
  }
  if (change.text !== undefined) note.text = change.text.trim();
  if (change.x !== undefined) note.x = Math.round(change.x);
  if (change.y !== undefined) note.y = Math.round(change.y);
  if (change.reply !== undefined) note.reply = change.reply.trim();
  if (change.resolved !== undefined) {
    if (change.resolved) note.resolved = true;
    else delete note.resolved;
  }
  saveNotes(ws, notes);
  return note;
}

export function formatNotes(notes: MapNote[]): string {
  return notes.map((n) => `- ${n.id} ${n.scene} at ${n.x},${n.y} (${n.author})${n.resolved ? ' [resolved]' : ''}: ${n.text}${n.reply ? `\n    reply: ${n.reply}` : ''}`).join('\n');
}

/** Plain-text report for MCP. */
export function formatEditorContext(ws: Workspace): string {
  const c = loadEditorContext(ws);
  const lines: string[] = [];
  if (!c) lines.push('The editor has not reported anything for this project yet (it may be closed).');
  else {
    const age = Math.round((Date.now() - c.updatedAt) / 1000);
    lines.push(`Editor, updated ${age < 90 ? `${age}s` : `${Math.round(age / 60)} min`} ago: page ${c.page}${c.playing ? ', Play is open' : ''}${c.tool ? `, tool ${c.tool}` : ''}`);
    const open = ([['scene', c.scene], ['sprite', c.sprite], ['object', c.object], ['script', c.script], ['dialogue', c.dialogue], ['table', c.table], ['effect', c.effect]] as const).filter(([, v]) => v);
    if (open.length) lines.push(`Open: ${open.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (c.tile) lines.push(`Pointer on tile ${c.tile.x},${c.tile.y}`);
    if (c.region) lines.push(`Selected tiles: ${c.region.x},${c.region.y} ${c.region.w}x${c.region.h}`);
    if (c.selection?.length) {
      lines.push(`Selected instances (${c.selection.length}):`);
      for (const s of c.selection.slice(0, 40)) lines.push(`- ${s.id} ${s.name ? `"${s.name}" ` : ''}${s.object} at ${s.x},${s.y}${s.group ? ` group ${s.group}` : ''}`);
      if (c.selection.length > 40) lines.push(`... ${c.selection.length - 40} more`);
    }
  }
  const open = listNotes(ws).filter((n) => !n.resolved);
  lines.push(open.length ? `Open notes on the map:\n${formatNotes(open)}` : 'No open notes on the map.');
  const log = loadPlayLog(ws);
  const errors = log.filter((l) => l.message.startsWith('ERROR'));
  if (log.length) lines.push(`Last Play: ${log.length} log line(s), ${errors.length} error(s)${errors.length ? `:\n${errors.slice(-10).map((l) => `- ${l.message}`).join('\n')}` : ''}`);
  return lines.join('\n');
}
