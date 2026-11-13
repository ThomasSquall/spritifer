/**
 * "Mark here" reports (F8 while playing from the editor's server): where the player saw a problem, with the trail that
 * led there and the frame as it was on screen. Stored in the project, in marks/: mark_0007.json + mark_0007.png per
 * report and marks/index.json with one line per report. File names are made here, never taken from the request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.js';

export const MARKS_DIR = 'marks';

/** Limits of the marks folder: a page or a stuck key cannot fill the disk. */
export const MARK_LIMITS = { maxMarks: 1000, maxTotalBytes: 400 * 1024 * 1024, maxPngBytes: 16 * 1024 * 1024, maxPngSide: 8192 };

/** What the game sends when F8 is pressed. Everything is optional: a report is kept even if a field is missing. */
export interface MarkReport {
  time?: string;
  scene?: string;
  player?: { x: number; y: number; feet: { x: number; y: number; w: number; h: number }; facing?: string } | null;
  camera?: { x: number; y: number; zoom: number };
  hd?: boolean;
  vars?: Record<string, unknown>;
  sceneVars?: Record<string, unknown>;
  note?: string;
  /** Player positions over the last seconds, oldest first, one every 100 ms. */
  trail?: [number, number][];
}

export interface StoredMark extends MarkReport {
  n: number;
  /** Paths relative to the project folder. */
  file: string;
  photo: string | null;
}

const NAME = /^mark_(\d{4,})\.json$/;

function marksDir(projectDir: string): string {
  return path.join(projectDir, MARKS_DIR);
}

const pad = (n: number) => String(n).padStart(4, '0');

/** Game variables as they are shown to us: plain names and simple values (numbers, booleans, short text, null). */
function simple(v: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n >= 500 || !/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (typeof x === 'boolean' || x === null) out[k] = x;
    else if (typeof x === 'string') out[k] = x.slice(0, 200);
    else continue;
    n++;
  }
  return out;
}

export class MarkError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Keeps only the known fields, with the right types (the request is not trusted to name files or add fields). */
function clean(r: MarkReport): MarkReport {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const out: MarkReport = {};
  if (typeof r.time === 'string') out.time = r.time.slice(0, 40);
  if (typeof r.scene === 'string') out.scene = r.scene.slice(0, 200);
  if (r.player && typeof r.player === 'object') {
    const f = r.player.feet ?? { x: 0, y: 0, w: 0, h: 0 };
    out.player = { x: num(r.player.x), y: num(r.player.y), feet: { x: num(f.x), y: num(f.y), w: num(f.w), h: num(f.h) }, ...(typeof r.player.facing === 'string' ? { facing: r.player.facing.slice(0, 20) } : {}) };
  }
  if (r.camera && typeof r.camera === 'object') out.camera = { x: num(r.camera.x), y: num(r.camera.y), zoom: num(r.camera.zoom) };
  if (typeof r.hd === 'boolean') out.hd = r.hd;
  if (r.vars && typeof r.vars === 'object') out.vars = simple(r.vars);
  if (r.sceneVars && typeof r.sceneVars === 'object') out.sceneVars = simple(r.sceneVars);
  if (typeof r.note === 'string' && r.note.trim()) out.note = r.note.trim().slice(0, 500);
  if (Array.isArray(r.trail)) out.trail = r.trail.slice(-200).filter((p) => Array.isArray(p) && p.length === 2).map((p) => [num(p[0]), num(p[1])] as [number, number]);
  return out;
}

/** Saves a report (and its PNG, when given) with the next number. Returns what was stored. */
export function saveMark(projectDir: string, report: MarkReport, png?: Buffer | null, limits = MARK_LIMITS): StoredMark {
  const dir = marksDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir);
  const taken = files.map((f) => NAME.exec(f)?.[1]).filter(Boolean).map(Number);
  if (taken.length >= limits.maxMarks) throw new MarkError(429, `Too many marks (${limits.maxMarks}): move the old ones out of ${MARKS_DIR}/`);
  const used = files.reduce((t, f) => t + (fs.statSync(path.join(dir, f)).size || 0), 0);
  if (used + (png?.length ?? 0) > limits.maxTotalBytes) throw new MarkError(507, `The ${MARKS_DIR}/ folder is full: move the old marks out of it`);
  if (png && png.length) {
    if (png.length > limits.maxPngBytes) throw new MarkError(413, 'The photo is too large');
    // the size is read from the header (IHDR) BEFORE decoding: a small file can declare a huge picture. The chunks are
    // walked first: exactly one IHDR, and it is the first chunk (a decoder may honour a second one, room-3001 #344.5)
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString('ascii') !== 'IHDR') throw new MarkError(400, 'The photo is not a PNG');
    for (let at = 8, k = 0; at < png.length; k++) {
      if (at + 12 > png.length) throw new MarkError(400, 'The photo is not a PNG');
      const len = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString('ascii');
      if (type === 'IHDR' && k > 0) throw new MarkError(400, 'The photo is not a PNG');
      if (type === 'IEND') break;
      at += 12 + len;
    }
    const declaredW = png.readUInt32BE(16);
    const declaredH = png.readUInt32BE(20);
    if (declaredW < 1 || declaredH < 1 || declaredW > limits.maxPngSide || declaredH > limits.maxPngSide) throw new MarkError(400, 'The photo has an impossible size');
    let bmp;
    try {
      bmp = decodePng(png);
    } catch {
      throw new MarkError(400, 'The photo is not a PNG');
    }
    if (bmp.width < 1 || bmp.height < 1 || bmp.width > limits.maxPngSide || bmp.height > limits.maxPngSide) throw new MarkError(400, 'The photo has an impossible size');
  }
  const n = (taken.length ? Math.max(...taken) : 0) + 1;
  const base = `mark_${pad(n)}`;
  if (png && png.length) fs.writeFileSync(path.join(dir, `${base}.png`), png);
  const stored: StoredMark = { n, ...clean(report), file: `${MARKS_DIR}/${base}.json`, photo: png && png.length ? `${MARKS_DIR}/${base}.png` : null };
  fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(stored, null, 1));
  const index = listMarks(projectDir).map((m) => ({ n: m.n, time: m.time, scene: m.scene, x: m.player?.x, y: m.player?.y, note: m.note, photo: m.photo }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
  return stored;
}

/** All reports, or those after number `after`, oldest first. */
export function listMarks(projectDir: string, after = 0): StoredMark[] {
  const dir = marksDir(projectDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => ({ f, n: Number(NAME.exec(f)?.[1] ?? NaN) }))
    .filter((e) => Number.isFinite(e.n) && e.n > after)
    .sort((a, b) => a.n - b.n)
    .map((e) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, e.f), 'utf8')) as StoredMark;
      } catch {
        return null;
      }
    })
    .filter((m): m is StoredMark => !!m);
}
