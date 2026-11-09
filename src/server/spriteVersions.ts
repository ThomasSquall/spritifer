/** Scored snapshots of a sprite on disk (.versions/) and the comparison with its reference that scores them. */

import fs from 'node:fs';
import path from 'node:path';
import { type Sprite, type SpriteFile, compositeFrame, newId } from '../core/sprite.js';
import { type SilhouetteDiff, silhouetteDiff, valueAdvice, valueStats } from '../core/shapes.js';
import { referenceBitmap, referenceCoverage, renderBitmapRows } from './ops.js';
import { encodePng } from './png.js';
import type { Workspace } from './store.js';

export interface VersionInfo {
  id: string;
  file: string;
  time: string;
  /** Overlap with the reference in %, -1 for a manual save. */
  iou: number;
  advice: number;
  rev: string;
}

export const versionDir = (ws: Workspace, name: string) => path.join(ws.dir, '.versions', name);

/** Versions newest first. File names: <timestamp>_<overlap%|manual>_<value warnings>_<rev>.sprite.json */
export function listVersions(ws: Workspace, name: string): VersionInfo[] {
  const dir = versionDir(ws, name);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sprite.json'))
    .map((f) => {
      const [ts, iou, advice, rev] = f.replace('.sprite.json', '').split('_');
      return { id: ts, file: path.join(dir, f), time: new Date(Number(ts)).toLocaleTimeString(), iou: iou === 'manual' ? -1 : Number(iou), advice: Number(advice) || 0, rev };
    })
    .sort((x, y) => Number(y.id) - Number(x.id));
}

export function saveVersion(ws: Workspace, name: string, raw: SpriteFile, iou: number | null, advice = 0): VersionInfo {
  const dir = versionDir(ws, name);
  fs.mkdirSync(dir, { recursive: true });
  const id = String(Date.now());
  const file = path.join(dir, `${id}_${iou === null ? 'manual' : iou}_${advice}_${raw.rev}.sprite.json`);
  fs.writeFileSync(file, JSON.stringify(raw));
  // Keep the 40 newest plus the best-scoring one.
  const all = listVersions(ws, name);
  const keep = new Set(all.slice(0, 40).map((v) => v.file));
  const top = all.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou)[0];
  if (top) keep.add(top.file);
  for (const v of all) if (!keep.has(v.file)) fs.rmSync(v.file);
  return listVersions(ws, name).find((v) => v.file === file)!;
}

/** Puts a saved version back; the current state is saved as a version first, so nothing is lost. */
export function restoreVersion(ws: Workspace, name: string, id: string, updatedBy: string): VersionInfo {
  const v = listVersions(ws, name).find((x) => x.id === id);
  if (!v) throw new Error(`No version ${id} for "${name}". Use versions to list them.`);
  saveVersion(ws, name, ws.readRaw(name), null);
  const file = JSON.parse(fs.readFileSync(v.file, 'utf8')) as SpriteFile;
  file.rev = newId();
  file.updatedBy = updatedBy;
  ws.writeRaw(file);
  return v;
}

export interface SilhouetteOptions {
  frame?: number;
  layerIds?: string[];
  coverage?: number;
  band?: number;
  colors?: boolean;
  colorBlock?: number;
  guide?: boolean;
  scale?: number;
}

/** Compares the art with the sprite's reference, saves a scored version, and returns the report and its picture. */
export function silhouetteReport(ws: Workspace, s: Sprite, a: SilhouetteOptions): { summary: string; png: Buffer } {
  if (!s.reference) throw new Error('This sprite has no reference (use set_reference with remove_background: true)');
    const ref = referenceBitmap(s);
    const art = compositeFrame(s, a.frame ?? 0, a.layerIds ? { layerIds: a.layerIds, includeHidden: true } : {});
    const d = silhouetteDiff(ref, art, {
      band: a.band,
      coverage: referenceCoverage(s),
      threshold: a.coverage,
      colorBlock: a.colors === false ? 0 : a.colorBlock,
    });
    const box = (b: SilhouetteDiff['ref']) => (b ? `x ${b.left}..${b.right}, y ${b.top}..${b.bottom}, center (${b.cx},${b.cy})` : 'empty');
    const reg = (r: { x0: number; y0: number; x1: number; y1: number; pixels: number; thin: boolean }) =>
      `x ${r.x0}..${r.x1} y ${r.y0}..${r.y1} (${r.pixels}px${r.thin ? ', thin detail' : ''})`;
    const rows = d.bands
      .map((b) => {
        const r = b.ref ? `${b.ref[0]}..${b.ref[1]}` : '—';
        const t = b.art ? `${b.art[0]}..${b.art[1]}` : '—';
        const notes: string[] = [];
        if (b.ref && b.art) {
          const dl = b.art[0] - b.ref[0];
          const dr = b.art[1] - b.ref[1];
          if (Math.abs(dl) >= 2) notes.push(dl > 0 ? `left edge ${dl}px inside` : `left edge ${-dl}px outside`);
          if (Math.abs(dr) >= 2) notes.push(dr < 0 ? `right edge ${-dr}px inside` : `right edge ${dr}px outside`);
        } else notes.push(b.ref ? 'missing in art' : 'not in reference');
        return notes.length ? `y ${b.y0}-${b.y1}: ref x ${r} | art x ${t} → ${notes.join(', ')}` : null;
      })
      .filter(Boolean);
    const big = (list: typeof d.missingRegions) => list.filter((r) => r.pixels >= 3).slice(0, 10);
    const add = big(d.missingRegions);
    const trim = big(d.extraRegions);
    const rvStats = valueStats(ref);
    const avStats = valueStats(art);
    const adviceCount = rvStats && avStats ? valueAdvice(rvStats, avStats).length : 0;
    const iouPct = Math.round(d.iou * 100);
    // Score history: every check saves a version, so a pass that made things worse can be undone at any time.
    const history = listVersions(ws, s.name);
    const best = history.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou || x.advice - y.advice)[0];
    const raw = ws.readRaw(s.name);
    const saved = history[0]?.rev === raw.rev ? history[0] : saveVersion(ws, s.name, raw, iouPct, adviceCount);
    let trend = '';
    if (best && (iouPct < best.iou - 2 || (iouPct <= best.iou && adviceCount > best.advice))) {
      trend = `⚠ WORSE than your best version: overlap ${iouPct}% vs ${best.iou}%${adviceCount > best.advice ? `, ${adviceCount} value warnings vs ${best.advice}` : ''} (version ${best.id}, ${best.time}). Unless this pass added something you need, restore it: restore_version sprite="${s.name}" id="${best.id}".`;
    } else if (best && iouPct > best.iou) trend = `✓ New best (previous best ${best.iou}%). Saved as version ${saved.id}.`;
    else trend = `Saved as version ${saved.id}.`;
    const summary = [
      `Overlap (IoU): ${iouPct}% — ${d.overlap} px shared, ${d.missing} missing (${d.thinMissing} of them thin details), ${d.extra} extra`,
      trend,
      `Reference: ${box(d.ref)}`,
      `Art:       ${box(d.art)}`,
      add.length ? `ADD (in the reference, missing in the art):\n${add.map((r) => '  ' + reg(r)).join('\n')}` : 'Nothing significant to add.',
      trim.length ? `TRIM (in the art, not in the reference):\n${trim.map((r) => '  ' + reg(r)).join('\n')}` : 'Nothing significant to trim.',
      rows.length ? `Edges that differ by 2px or more:\n${rows.join('\n')}` : 'All bands match within 1px.',
      (() => {
        const rv = rvStats;
        const av = avStats;
        if (!rv || !av) return '';
        const fmt = (v: typeof rv) => `dark ${Math.round(v.dark * 100)}% / mid ${Math.round(v.mid * 100)}% / light ${Math.round(v.light * 100)}%, L p10 ${v.p10} p50 ${v.p50} p90 ${v.p90}, chroma ${v.chroma}`;
        const advice = valueAdvice(rv, av);
        return `Values — ref: ${fmt(rv)}\n         art: ${fmt(av)}\n${advice.length ? advice.map((x) => '  → ' + x).join('\n') : '  → values match the reference'}`;
      })(),
      d.colors.length
        ? `Colors that differ (ΔE OKLab ≥ 0.06), worst first — where the reference has a different material in that zone (e.g. hair over a cheek) fix the shape, not the color:\n${d.colors.slice(0, 10).map((c) => `  x ${c.x0}..${c.x1} y ${c.y0}..${c.y1}: art ${c.art} vs ref ${c.ref} (Δ${c.delta}) → art is ${c.notes.join(', ') || 'off'}`).join('\n')}`
        : a.colors === false ? '' : 'Colors match the reference zone by zone.',
    ].filter(Boolean).join('\n');
  const pic = renderBitmapRows(s, [[ref, art, d.image]], { scale: a.scale, rulers: true, guide: a.guide && s.guide ? s.guide : undefined });
  return { summary, png: encodePng(pic.image) };
}
