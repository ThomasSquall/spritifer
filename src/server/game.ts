/** Server-side game operations: bundling assets, exporting a standalone web build, rendering previews. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Bitmap, type Sprite } from '../core/sprite.js';
import { buildSpritesheet } from '../core/sheet.js';
import { parseColor } from '../core/color.js';
import { scaleBitmap } from '../core/draw.js';
import { BUILTIN_FONT, type PixelFont, fontPixelSize, rasterText } from '../core/game/font.js';
import { type Renderer, World, renderWorld } from '../core/game/engine.js';
import type { ScreenLight } from '../core/game/atmosphere.js';
import { type HdFrame, applyHdBuffer, resolveHd } from '../core/game/hd.js';
import { SoftHdRenderer } from './hdSoftware.js';
import { type ResolvedRelief, buildNormalSheet, frameTilt, normalSheetFor, reliefKind, resolveRelief, shadeRelief } from '../core/game/relief.js';
import { type Problem, validateGame } from '../core/game/catalog.js';
import { type GameBundle, type GameProject, type Scene, type SpriteAsset, type Value, gameSlug, interfaceSize } from '../core/game/types.js';
import { encodePng } from './png.js';
import { inspectScripts } from './scripts.js';
import type { ScriptInfo } from '../core/game/script.js';
import { type DialogueError, buildDialogueBook } from '../core/game/dialogue.js';
import type { Workspace } from './store.js';
import { type VfxTimeline, VfxSystem, simulateVfx } from '../core/game/vfx.js';
import type { VfxGraph } from '../core/game/vfxGraph.js';

/** Sprite names a game actually uses (objects, tilesets, backgrounds). */
export function usedSprites(game: GameProject, scenes: Scene[]): Set<string> {
  const out = new Set<string>();
  for (const o of game.objects) if (o.sprite) out.add(o.sprite);
  for (const s of scenes) {
    if (s.tileset) out.add(s.tileset);
    for (const i of s.instances) if (i.sprite) out.add(i.sprite);
    for (const b of s.backgrounds) if (b.sprite) out.add(b.sprite);
  }
  return out;
}

interface BuiltAsset {
  asset: SpriteAsset;
  sheet: Bitmap;
}

const assetCache = new Map<string, BuiltAsset>();
/** Well above what one game uses: a game that needs more sprites than this would empty the cache on every load. */
const MAX_CACHED_ASSETS = 2000;

/** Builds the runtime asset (grid spritesheet + metadata) for a sprite. Cached by revision. */
export function buildAsset(sprite: Sprite, withImage: boolean): BuiltAsset {
  const key = `${sprite.name}@${sprite.rev}`;
  let built = assetCache.get(key);
  if (!built) {
    const { image, meta } = buildSpritesheet(sprite, { layout: 'grid' });
    built = {
      sheet: image,
      asset: {
        name: sprite.name,
        width: sprite.width,
        height: sprite.height,
        frames: meta.frames.map((f, i) => {
          const ev = sprite.frames[Number(/ (\d+)$/.exec(f.filename)?.[1] ?? i)]?.events;
          return { x: f.frame.x, y: f.frame.y, w: f.frame.w, h: f.frame.h, duration: f.duration, ...(ev?.length ? { events: [...ev] } : {}) };
        }),
        tags: sprite.tags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction })),
        grid: sprite.grid,
        ...(sprite.relief ? { relief: sprite.relief } : {}),
      },
    };
    if (assetCache.size >= MAX_CACHED_ASSETS) assetCache.clear();
    assetCache.set(key, built);
  }
  if (withImage && !built.asset.image) built.asset.image = 'data:image/png;base64,' + encodePng(built.sheet).toString('base64');
  return built;
}

export interface LoadedGame {
  bundle: GameBundle;
  sheets: Map<string, Bitmap>;
  problems: Problem[];
  scriptInfo: ScriptInfo;
  dialogueInfo: { nodes: string[]; errors: DialogueError[] };
}

/** Loads the game, all scenes and the sprites they use from the workspace. */
export function loadGameBundle(ws: Workspace, opts: { images?: boolean } = {}): LoadedGame {
  const game = ws.loadGame();
  const scenes = ws.listScenes().map((s) => ws.loadScene(s.name));
  if (!game.startScene && scenes.length) game.startScene = scenes[0].name;
  const available = new Set(ws.list().map((s) => s.name));
  const sprites: Record<string, SpriteAsset> = {};
  const sheets = new Map<string, Bitmap>();
  const scriptSources = ws.loadScripts();
  const dialogueSources = ws.loadDialogues();
  const used = usedSprites(game, scenes);
  // Sprites only named in scripts or dialogues (e.g. ui.sprite('boss', ...)) are part of the game too.
  for (const src of [...Object.values(scriptSources), ...Object.values(dialogueSources)]) {
    for (const m of src.matchAll(/["'`]([A-Za-z0-9][A-Za-z0-9_-]{0,63})["'`]/g)) if (available.has(m[1])) used.add(m[1]);
  }
  // Dialogue faces are found by name at run time ("Aren [deciso]" -> portrait_aren_deciso), so no text names them.
  for (const name of available) if (name.startsWith('portrait_')) used.add(name);
  // ...and sprites named in data tables (monsters.sprite, residents.sprite...).
  const data = ws.loadTables();
  for (const t of Object.values(data)) {
    for (const r of t.rows) for (const v of Object.values(r)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && available.has(x)) used.add(x);
  }
  // ...and sprites drawn by visual effects.
  const vfx = ws.loadAllVfx();
  for (const g of Object.values(vfx)) for (const n of g.nodes) if ((n.type === 'sprite' || n.type === 'projectile') && typeof n.params.sprite === 'string' && available.has(n.params.sprite)) used.add(n.params.sprite);
  for (const name of used) {
    if (!available.has(name)) continue;
    const built = buildAsset(ws.load(name), !!opts.images);
    // Copy so cached assets don't leak the image into headless bundles.
    sprites[name] = opts.images ? built.asset : { ...built.asset, image: undefined };
    sheets.set(name, built.sheet);
  }
  const scripts = scriptSources;
  const scriptInfo = inspectScripts(scripts);
  const dialogues = dialogueSources;
  const book = buildDialogueBook(dialogues);
  const dialogueInfo = { nodes: [...book.nodes.keys()].sort(), errors: book.errors };
  const problems = validateGame(game, scenes, available, scriptInfo, dialogueInfo, ws.listAudio().map((a) => a.name), data, { graphs: vfx, sprites: new Map(ws.list().map((s) => [s.name, s.tags ?? []])) });
  const audioList = ws.listAudio();
  // Played/exported games carry the files as data URLs; headless runs only need the names.
  const audio = Object.fromEntries(audioList.map((a) => [a.name, opts.images ? `data:${a.mime};base64,${ws.readAudio(a.name).data.toString('base64')}` : '']));
  return { bundle: { game, scenes: Object.fromEntries(scenes.map((s) => [s.name, s])), sprites, scripts, dialogues, ...(audioList.length ? { audio } : {}), ...(Object.keys(data).length ? { data } : {}), ...(Object.keys(vfx).length ? { vfx } : {}) }, sheets, problems, scriptInfo, dialogueInfo };
}

// ---------------------------------------------------------------------------
// Web export

const RUNTIME_CANDIDATES = [
  fileURLToPath(new URL('../runtime/player.js', import.meta.url)), // dist/server → dist/runtime
  fileURLToPath(new URL('../../dist/runtime/player.js', import.meta.url)), // src/server (tests, tsx)
];

export function loadRuntime(): string {
  for (const f of RUNTIME_CANDIDATES) if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  throw new Error('Game runtime not built. Run `npm run build` in the Spritifer folder.');
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A single self-contained HTML file that plays the game (works offline, on itch.io, any static host). */
export function buildGameHtml(bundle: GameBundle, runtime: string): string {
  // JSON inside <script>: escape "<" so "</script>" in strings can't close the tag.
  const data = JSON.stringify(bundle).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="generator" content="Spritifer">
<title>${escapeHtml(bundle.game.title)}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#game{position:fixed;inset:0}</style>
</head>
<body>
<div id="game"></div>
<script>window.SPRITIFER_GAME=${data};</script>
<script>${runtime.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
}

export interface ExportResult {
  file: string;
  bytes: number;
  sprites: number;
  scenes: number;
  problems: Problem[];
}

/** Writes export/web/<slug>/index.html into the workspace. */
export function exportGame(ws: Workspace, opts: { outDir?: string } = {}): ExportResult {
  const { bundle, problems } = loadGameBundle(ws, { images: true });
  if (!Object.keys(bundle.scenes).length) throw new Error('The game has no scenes yet: create one first.');
  const html = buildGameHtml(bundle, loadRuntime());
  const dir = opts.outDir ? path.resolve(opts.outDir) : path.join(ws.exportDir, 'web', gameSlug(bundle.game.title));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html), sprites: Object.keys(bundle.sprites).length, scenes: Object.keys(bundle.scenes).length, problems };
}

// ---------------------------------------------------------------------------
// Bitmap rendering (previews, playtest snapshots)

const normalSheets = new WeakMap<Bitmap, Uint8ClampedArray>();

export class BitmapRenderer implements Renderer {
  readonly out: Bitmap;
  endWorld?: (frame: HdFrame | null) => void;
  private relief: { assets: Record<string, SpriteAsset | undefined>; view: { width: number; height: number }; normals: Uint8ClampedArray; on: boolean; tiles: boolean } | null = null;
  constructor(width: number, height: number, private sheets: Map<string, Bitmap>) {
    this.out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  }

  /** Enables per-pixel lighting. `view` is the game's screen: sprites as big as it are backdrops and stay flat. */
  useRelief(assets: Record<string, SpriteAsset | undefined>, view: { width: number; height: number }): this {
    this.relief = { assets, view, normals: new Uint8ClampedArray(this.out.data.length), on: false, tiles: true };
    return this;
  }

  beginRelief(on: boolean, tiles = true): void {
    if (!this.relief) return;
    this.relief.on = on;
    this.relief.tiles = tiles;
    if (on) this.relief.normals.fill(0);
  }

  endRelief(): void {
    if (this.relief) this.relief.on = false;
  }

  reliefLighting(relief: ResolvedRelief, ambient: string, lights: ScreenLight[], glow: number): void {
    if (this.relief) shadeRelief(this.out, this.relief.normals, relief, ambient, lights, glow);
    else this.lighting(ambient, lights, glow);
  }

  spriteMask(sprite: string, x: number, y: number, w: number, h: number): Uint8Array | null {
    const src = this.sheets.get(sprite);
    const asset = this.relief?.assets[sprite];
    if (!this.relief || !src || !asset || reliefKind(asset, this.relief.view) !== 'shape') return null;
    const normals = this.normalsOf(sprite, src);
    return normals ? frameTilt(normals, src.width, x, y, w, h) : null;
  }

  private normalsOf(sprite: string, src: Bitmap): Uint8ClampedArray | null {
    const rel = this.relief!;
    const asset = rel.assets[sprite];
    if (!asset) return null;
    const kind = reliefKind(asset, rel.view);
    if (!kind || (kind === 'surface' && !rel.tiles)) return null;
    let sheet = normalSheets.get(src);
    if (!sheet) {
      sheet = normalSheetFor(src.data, src.width, src.height, asset, rel.view) ?? undefined;
      if (sheet) normalSheets.set(src, sheet);
    }
    return sheet ?? null;
  }

  /** Records the normals of a drawn sprite; a sprite without them erases what it covers (a roof over a character). */
  private captureNormals(sprite: string, src: Bitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle?: number; scale?: number; flat?: boolean }): void {
    const rel = this.relief;
    if (!rel?.on || o.opacity < 1 || o.angle) return;
    const sheet = o.flat ? null : this.normalsOf(sprite, src);
    const k = Math.max(1, o.scale ?? 1);
    const { width: W, height: H } = this.out;
    const n = rel.normals;
    for (let y = 0; y < sh * k; y++) {
      for (let x = 0; x < sw * k; x++) {
        const px = sx + Math.floor((o.flipX ? sw * k - 1 - x : x) / k);
        const py = sy + Math.floor(y / k);
        if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
        const si = (py * src.width + px) * 4;
        if (src.data[si + 3] < 128) continue;
        const tx = dx + x;
        const ty = dy + y;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = (ty * W + tx) * 4;
        if (sheet) {
          n[t] = o.flipX ? 255 - sheet[si] : sheet[si];
          n[t + 1] = sheet[si + 1];
          n[t + 2] = sheet[si + 2];
          n[t + 3] = 255;
        } else n[t + 3] = 0;
      }
    }
  }

  private blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const img = this.out;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
    const i = (y * img.width + x) * 4;
    const d = img.data;
    const sa = a / 255;
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    d[i] = (r * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (g * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (b * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }

  clear(color: string): void {
    let c: [number, number, number, number] = [0, 0, 0, 255];
    try {
      c = parseColor(color);
    } catch {
      // Keep black.
    }
    const d = this.out.data;
    for (let i = 0; i < d.length; i += 4) d.set(c, i);
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle?: number; scale?: number; flat?: boolean }): void {
    const src = this.sheets.get(sprite);
    if (!src) return;
    this.captureNormals(sprite, src, sx, sy, sw, sh, dx, dy, o);
    if (o.angle) return this.rotated(src, sx, sy, sw, sh, dx, dy, { ...o, angle: o.angle });
    const k = Math.max(1, o.scale ?? 1);
    if (k > 1) {
      for (let y = 0; y < sh * k; y++) {
        for (let x = 0; x < sw * k; x++) {
          const px = sx + Math.floor((o.flipX ? sw * k - 1 - x : x) / k);
          const py = sy + Math.floor(y / k);
          if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
          const i = (py * src.width + px) * 4;
          const a = src.data[i + 3] * o.opacity;
          if (a) this.blend(dx + x, dy + y, src.data[i], src.data[i + 1], src.data[i + 2], a);
        }
      }
      return;
    }
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const px = sx + x;
        const py = sy + y;
        if (px < 0 || py < 0 || px >= src.width || py >= src.height) continue;
        const i = (py * src.width + px) * 4;
        const a = src.data[i + 3] * o.opacity;
        if (!a) continue;
        this.blend(dx + (o.flipX ? sw - 1 - x : x), dy + y, src.data[i], src.data[i + 1], src.data[i + 2], a);
      }
    }
  }

  /** Nearest-neighbour rotation around the sprite's center, like the canvas renderer. */
  private rotated(src: Bitmap, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number }): void {
    const k = Math.max(0.01, o.scale ?? 1);
    const cx = dx + (sw * k) / 2;
    const cy = dy + (sh * k) / 2;
    const reach = Math.ceil(Math.hypot(sw, sh) * k * 0.5) + 1;
    const a = (-o.angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let y = Math.floor(cy) - reach; y <= Math.ceil(cy) + reach; y++) {
      for (let x = Math.floor(cx) - reach; x <= Math.ceil(cx) + reach; x++) {
        const rx = x + 0.5 - cx;
        const ry = y + 0.5 - cy;
        let u = (rx * cos - ry * sin) / k + sw / 2;
        const v = (rx * sin + ry * cos) / k + sh / 2;
        if (o.flipX) u = sw - u;
        if (u < 0 || v < 0 || u >= sw || v >= sh) continue;
        const i = ((sy + Math.floor(v)) * src.width + sx + Math.floor(u)) * 4;
        const al = src.data[i + 3] * o.opacity;
        if (al) this.blend(x, y, src.data[i], src.data[i + 1], src.data[i + 2], al);
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1, blend?: 'add'): void {
    let c: [number, number, number, number];
    try {
      c = parseColor(color);
    } catch {
      return;
    }
    if (blend === 'add') {
      const d = this.out.data;
      const k = (c[3] / 255) * alpha;
      for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.out.height, y + h); yy++) {
        for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.out.width, x + w); xx++) {
          const i = (yy * this.out.width + xx) * 4;
          d[i] = Math.min(255, d[i] + c[0] * k);
          d[i + 1] = Math.min(255, d[i + 1] + c[1] * k);
          d[i + 2] = Math.min(255, d[i + 2] + c[2] * k);
          d[i + 3] = Math.max(d[i + 3], k * 255);
        }
      }
      return;
    }
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.out.height, y + h); yy++) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.out.width, x + w); xx++) this.blend(xx, yy, c[0], c[1], c[2], c[3] * alpha);
    }
  }

  lighting(ambient: string, lights: ScreenLight[], glow: number): void {
    let amb: [number, number, number, number];
    try {
      amb = parseColor(ambient);
    } catch {
      return;
    }
    const { width: W, height: H, data: d } = this.out;
    const n = W * H;
    // Light map (0..1 per channel): ambient + lights, clamped like a canvas "lighter" pass.
    const lm = new Float32Array(n * 3);
    const gl = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      lm[i * 3] = amb[0] / 255;
      lm[i * 3 + 1] = amb[1] / 255;
      lm[i * 3 + 2] = amb[2] / 255;
    }
    for (const l of lights) {
      let c: [number, number, number, number];
      try {
        c = parseColor(l.color);
      } catch {
        continue;
      }
      const k = Math.min(1, l.intensity);
      const kg = Math.min(1, l.intensity * glow * 0.35);
      const gr = l.radius * 0.7;
      for (let y = Math.max(0, Math.floor(l.y - l.radius)); y < Math.min(H, Math.ceil(l.y + l.radius)); y++) {
        for (let x = Math.max(0, Math.floor(l.x - l.radius)); x < Math.min(W, Math.ceil(l.x + l.radius)); x++) {
          const dist = Math.hypot(x + 0.5 - l.x, y + 0.5 - l.y);
          if (dist >= l.radius) continue;
          const f = (1 - dist / l.radius) ** 2 * k;
          const i = (y * W + x) * 3;
          lm[i] += (c[0] / 255) * f;
          lm[i + 1] += (c[1] / 255) * f;
          lm[i + 2] += (c[2] / 255) * f;
          if (kg > 0 && dist < gr) {
            const fg = (1 - dist / gr) ** 2 * kg;
            gl[i] += c[0] * fg;
            gl[i + 1] += c[1] * fg;
            gl[i + 2] += c[2] * fg;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.min(255, d[i * 4 + ch] * Math.min(1, lm[i * 3 + ch]) + gl[i * 3 + ch]);
    }
  }

  grade(tint: string, amount: number): void {
    let t: [number, number, number, number];
    try {
      t = parseColor(tint);
    } catch {
      return;
    }
    const d = this.out.data;
    // W3C soft-light, mixed by amount.
    const soft = (cb: number, cs: number) => {
      const D = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cs <= 0.5 ? cb - (1 - 2 * cs) * cb * (1 - cb) : cb + (2 * cs - 1) * (D - cb);
    };
    for (let i = 0; i < d.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const cb = d[i + ch] / 255;
        d[i + ch] = Math.round((cb + (soft(cb, t[ch] / 255) - cb) * amount) * 255);
      }
    }
  }

  vignette(strength: number, color: string): void {
    let c: [number, number, number, number];
    try {
      c = parseColor(color);
    } catch {
      return;
    }
    const { width: W, height: H } = this.out;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.hypot(cx, cy);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / R - 0.45) / 0.55;
        if (t > 0) this.blend(x, y, c[0], c[1], c[2], 255 * strength * Math.min(1, t));
      }
    }
  }

  text(text: string, x: number, y: number, color: string, scale: number, font: PixelFont = BUILTIN_FONT): void {
    let c: [number, number, number, number];
    try {
      c = parseColor(color);
    } catch {
      return;
    }
    const p = fontPixelSize(font, scale);
    rasterText(text, (px, py) => {
      for (let sy = 0; sy < p; sy++) for (let sx = 0; sx < p; sx++) this.blend(Math.round(x) + px * p + sx, Math.round(y) + py * p + sy, c[0], c[1], c[2], c[3]);
    }, font);
  }
}

/** Renders what the player currently sees. */
/**
 * A filmstrip of an effect: evenly spaced moments of it playing between a blue attacker and a red victim, as
 * the game draws them.
 */
export function renderVfxStrip(loaded: Pick<LoadedGame, 'bundle' | 'sheets'>, graph: VfxGraph, opts: { frames?: number; scale?: number; distance?: number; dark?: boolean; tint?: string; speed?: number; size?: number; angle?: number } = {}): { png: Buffer; timeline: VfxTimeline; times: number[] } {
  const host = { asset: (name: string) => loaded.bundle.sprites[name] };
  const play = { ...(opts.tint ? { tint: opts.tint } : {}), ...(opts.speed ? { speed: opts.speed } : {}), ...(opts.size ? { scale: opts.size } : {}) };
  const distance = opts.distance ?? 96;
  const W = Math.max(120, distance + 80);
  const H = 110;
  const src = { x: Math.round((W - distance) / 2), y: 58 };
  const dst = { x: src.x + distance, y: 58 };
  const timeline = simulateVfx(graph, { ...play, source: src, target: dst, host });
  const frames = Math.max(1, Math.min(24, opts.frames ?? 8));
  const times = Array.from({ length: frames }, (_, i) => (timeline.duration * (i + 0.5)) / frames);
  const cols = Math.min(4, frames);
  const rows = Math.ceil(frames / cols);
  const gap = 2;
  const sheet = new BitmapRenderer(cols * (W + gap) - gap, rows * (H + gap) - gap, loaded.sheets);
  sheet.clear('#000000');
  const sys = new VfxSystem(host);
  sys.play(graph, { ...play, source: src, target: dst });
  const STEP = 1 / 60;
  let clock = 0;
  times.forEach((t, i) => {
    while (clock < t) {
      sys.tick(STEP);
      clock += STEP;
    }
    const cell = new BitmapRenderer(W, H, loaded.sheets);
    cell.clear(opts.dark ? '#14151f' : '#39424f');
    if (!opts.dark) cell.rect(0, 70, W, H - 70, '#2d3540');
    cell.rect(src.x - 6, src.y - 8, 12, 16, '#41a6f6');
    cell.rect(dst.x - 6, dst.y - 8, 12, 16, '#e43b44');
    sys.draw(cell, 0, 0, 1, true);
    if (opts.dark) {
      const lights = sys.lights().map((l) => ({ ...l, intensity: Math.min(1, l.intensity) }));
      cell.lighting('#55586e', lights, 0.6);
    }
    // In this order in the game too: effects glow over the scene lighting.
    sys.draw(cell, 0, 0, 1, false);
    sys.drawScreen(cell, W, H);
    cell.text(`${t.toFixed(2)}s`, 3, 3, '#ffffff', 1);
    const ox = (i % cols) * (W + gap);
    const oy = Math.floor(i / cols) * (H + gap);
    for (let y = 0; y < H; y++) sheet.out.data.set(cell.out.data.subarray(y * W * 4, (y + 1) * W * 4), (oy + y) * sheet.out.width * 4 + ox * 4);
  });
  const scale = Math.max(1, Math.min(4, opts.scale ?? 2));
  return { png: encodePng(scale > 1 ? scaleBitmap(sheet.out, scale) : sheet.out), timeline, times };
}

/**
 * One frame of a sprite as per-pixel light sees it: its art, its normal map, then lit from the left, the right, above
 * and below, on a dark background. `dark` lights it with a point light; otherwise with the sun.
 */
export function renderReliefPreview(built: { sheet: Bitmap; asset: SpriteAsset }, opts: { frame?: number; scale?: number; settings?: SpriteAsset['relief'] } = {}): Buffer {
  const { sheet, asset } = built;
  const f = asset.frames[Math.max(0, Math.min(asset.frames.length - 1, opts.frame ?? 0))];
  if (!f) throw new Error(`Sprite "${asset.name}" has no frames`);
  const normals = buildNormalSheet(sheet.data, sheet.width, sheet.height, asset.frames, opts.settings ?? asset.relief);
  const pad = 8;
  const cw = f.w + pad * 2;
  const ch = f.h + pad * 2;
  const crop = (src: Uint8ClampedArray, into: Uint8ClampedArray) => {
    for (let y = 0; y < f.h; y++) into.set(src.subarray(((f.y + y) * sheet.width + f.x) * 4, ((f.y + y) * sheet.width + f.x + f.w) * 4), ((y + pad) * cw + pad) * 4);
  };
  const scale = Math.max(1, Math.min(12, opts.scale ?? 4));
  const positions: ({ x: number; y: number } | null)[] = [null, null, { x: -0.3, y: 0.45 }, { x: 1.3, y: 0.45 }, { x: 0.5, y: -0.3 }, { x: 0.5, y: 1.3 }];
  const out: Bitmap = { width: cw * positions.length, height: ch, data: new Uint8ClampedArray(cw * positions.length * ch * 4) };
  positions.forEach((pos, i) => {
    const color = new Uint8ClampedArray(cw * ch * 4);
    crop(sheet.data, color);
    const norm = new Uint8ClampedArray(cw * ch * 4);
    crop(normals, norm);
    const cell = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
    for (let p = 0; p < cell.data.length; p += 4) {
      const a = color[p + 3] / 255;
      const bg = 30;
      const showNormals = i === 1;
      cell.data[p] = showNormals && norm[p + 3] ? norm[p] : color[p] * a + bg * (1 - a);
      cell.data[p + 1] = showNormals && norm[p + 3] ? norm[p + 1] : color[p + 1] * a + bg * (1 - a);
      cell.data[p + 2] = showNormals && norm[p + 3] ? 255 : color[p + 2] * a + bg * (1 - a);
      cell.data[p + 3] = 255;
    }
    if (pos) {
      const reach = Math.hypot(f.w, f.h) * 1.6;
      shadeRelief(cell, norm, resolveRelief({}), '#54566e', [{ x: pad + f.w * pos.x, y: pad + f.h * pos.y, radius: reach, color: '#ffe0b0', intensity: 1 }], 0);
    }
    for (let y = 0; y < ch; y++) out.data.set(cell.data.subarray(y * cw * 4, (y + 1) * cw * 4), (y * out.width + i * cw) * 4);
  });
  return encodePng(scale > 1 ? scaleBitmap(out, scale) : out);
}

export function renderViewport(world: World, sheets: Map<string, Bitmap>, scale = 1, hd = false): Buffer {
  const r = new BitmapRenderer(world.game.width, world.game.height, sheets).useRelief(world.bundle.sprites, interfaceSize(world.game));
  const resolved = hd ? resolveHd(world.game.hd, world.scene.atmosphere?.hd, world.scene.atmosphere?.ambient) : null;
  renderWorld(world, resolved ? new SoftHdRenderer(r, sheets, resolved) : r);
  return encodePng(scale > 1 ? scaleBitmap(r.out, scale) : r.out);
}

export const encodeBitmap = (b: Bitmap): Buffer => encodePng(b);

/** Changes whenever the code that draws previews is rebuilt, so previews drawn by older code are not reused. */
const RENDERER_STAMP = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hash = crypto.createHash('sha1');
  for (const dir of [here, path.join(here, '..', 'core')]) {
    for (const f of fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) hash.update(`${f}\0${fs.statSync(path.join(dir, f)).mtimeMs}\n`);
  }
  return hash.digest('hex');
})();

let sharedBundle: { dir: string; stamp: string; loaded: LoadedGame } | null = null;

/**
 * The headless bundle, reused until a file of the game changes. Loading it reads hundreds of sprites,
 * which is far too slow to repeat for each of a list of previews. Callers must only read it.
 */
export function sharedGameBundle(ws: Workspace): LoadedGame {
  const stamp = ws.contentStamp();
  if (sharedBundle?.dir !== ws.dir || sharedBundle.stamp !== stamp) sharedBundle = { dir: ws.dir, stamp, loaded: loadGameBundle(ws) };
  return sharedBundle.loaded;
}

/** The sprite sheets of a game, noting which ones a render asks for. */
class WatchedSheets extends Map<string, Bitmap> {
  readonly asked = new Set<string>();
  override get(name: string): Bitmap | undefined {
    this.asked.add(name);
    return super.get(name);
  }
}

interface KeptPreview {
  /** Stamps of the renderer, the game and the scene. */
  base: string;
  /** Stamp of each sprite the image asked for: editing any other sprite leaves it valid. */
  sprites: Record<string, string>;
  png: string;
}

/** The image of a scene, kept in .spritifer/previews until the scene or something it draws changes. */
export function cachedScenePreview(ws: Workspace, sceneName: string, opts: { scale?: number; grid?: boolean } = {}): Buffer {
  const base = [RENDERER_STAMP, ws.fileStamp(ws.gameFile()), ws.fileStamp(ws.sceneFile(sceneName))].join('|');
  const spriteStamp = (name: string) => {
    try {
      return ws.fileStamp(ws.file(name));
    } catch {
      return 'none'; // An instance can name something that could never be a sprite file.
    }
  };
  const file = path.join(ws.metaDir, 'previews', `${sceneName}.${opts.scale ?? 'auto'}${opts.grid ? '.grid' : ''}.json`);
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as KeptPreview;
    if (kept.base === base && Object.entries(kept.sprites).every(([n, st]) => spriteStamp(n) === st)) return Buffer.from(kept.png, 'base64');
  } catch {
    // Not drawn yet, or a copy that cannot be read: draw it again.
  }
  const before = ws.contentStamp();
  const loaded = sharedGameBundle(ws);
  const sheets = new WatchedSheets(loaded.sheets);
  const { png } = renderScenePreview({ ...loaded, sheets }, sceneName, opts);
  // A file that changed during the render could be drawn old but stamped new: such an image is shown but not kept.
  if (ws.contentStamp() === before) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const kept: KeptPreview = { base, sprites: Object.fromEntries([...sheets.asked].map((n) => [n, spriteStamp(n)])), png: png.toString('base64') };
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(kept));
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      // The copy is only a saving: the image is still good without it.
    }
  }
  return png;
}

/**
 * A scene through the 2D-HD camera, as the player will see it from there: `at` is the tile in the middle of the view, `size` the
 * view in pixels (default: the game's screen). `effects` false leaves out blur, bloom and haze.
 */
export function renderSceneHd(loaded: LoadedGame, sceneName: string, opts: { at?: [number, number]; size?: [number, number]; scale?: number; vars?: Record<string, Value>; effects?: boolean } = {}): { png: Buffer; width: number; height: number } {
  const scene = loaded.bundle.scenes[sceneName];
  if (!scene) throw new Error(`Scene "${sceneName}" not found`);
  const [W, H] = opts.size ?? [loaded.bundle.game.width, loaded.bundle.game.height];
  const game: GameProject = { ...loaded.bundle.game, width: W, height: H };
  const world = new World({ ...loaded.bundle, game, scripts: {} }, { scene: sceneName, vars: opts.vars });
  const start = new World({ ...loaded.bundle, game, scripts: {} }, { scene: sceneName, vars: opts.vars });
  start.step();
  const ts = scene.tileSize;
  const cx = opts.at ? (opts.at[0] + 0.5) * ts - W / 2 : start.camera.x;
  const cy = opts.at ? (opts.at[1] + 0.5) * ts - H / 2 : start.camera.y;
  world.camera = { x: Math.round(cx), y: Math.round(cy), zoom: 1 };
  world.updateTexts();
  const r = new BitmapRenderer(W, H, loaded.sheets);
  const hd = resolveHd(game.hd, scene.atmosphere?.hd, scene.atmosphere?.ambient);
  if (!hd) throw new Error(`Scene "${sceneName}" has 2D-HD switched off`);
  renderWorld(world, new SoftHdRenderer(r, loaded.sheets, hd, opts.effects ?? false));
  const scale = opts.scale ?? 2;
  const final = scale > 1 ? scaleBitmap(r.out, scale) : r.out;
  return { png: encodePng(final), width: final.width, height: final.height };
}

/**
 * Renders a whole scene as laid out in the editor (instances at their start positions), with the
 * starting camera viewport outlined and optional tile grid.
 */
export function renderScenePreview(loaded: LoadedGame, sceneName: string, opts: { scale?: number; grid?: boolean; region?: { x: number; y: number; w: number; h: number }; vars?: Record<string, Value> } = {}): { png: Buffer; width: number; height: number; hidden: string[] } {
  const scene = loaded.bundle.scenes[sceneName];
  if (!scene) throw new Error(`Scene "${sceneName}" not found`);
  const W = scene.cols * scene.tileSize;
  const H = scene.rows * scene.tileSize;
  const game: GameProject = { ...loaded.bundle.game, width: W, height: H };
  const world = new World({ ...loaded.bundle, game, scripts: {} }, { scene: sceneName, vars: opts.vars });
  world.camera = { x: 0, y: 0, zoom: 1 };
  // Conditional instances (activeIf) whose condition is false with these variables are not drawn.
  const shown = new Set(world.actors.map((a) => a.sceneId));
  const hidden = scene.instances.filter((i) => i.activeIf && !shown.has(i.id)).map((i) => `${i.name ?? i.object} (${i.activeIf})`);
  world.updateTexts();
  const r = new BitmapRenderer(W, H, loaded.sheets).useRelief(loaded.bundle.sprites, interfaceSize(loaded.bundle.game));
  renderWorld(world, r);
  if (opts.grid) {
    for (let x = 0; x < W; x += scene.tileSize) r.rect(x, 0, 1, H, '#ffffff', 0.12);
    for (let y = 0; y < H; y += scene.tileSize) r.rect(0, y, W, 1, '#ffffff', 0.12);
  }
  // Starting viewport (where the camera begins).
  const start = new World({ ...loaded.bundle, scripts: {} }, { scene: sceneName, vars: opts.vars });
  start.step();
  const vw = Math.round(start.viewWidth);
  const vh = Math.round(start.viewHeight);
  const cx = Math.round(start.camera.x);
  const cy = Math.round(start.camera.y);
  r.rect(cx, cy, vw, 1, '#feae34', 0.9);
  r.rect(cx, cy + vh - 1, vw, 1, '#feae34', 0.9);
  r.rect(cx, cy, 1, vh, '#feae34', 0.9);
  r.rect(cx + vw - 1, cy, 1, vh, '#feae34', 0.9);
  let img = r.out;
  if (opts.region) {
    const { x, y, w, h } = opts.region;
    const out: Bitmap = { width: Math.max(1, w), height: Math.max(1, h), data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4) };
    for (let yy = 0; yy < out.height; yy++) {
      for (let xx = 0; xx < out.width; xx++) {
        const sx = x + xx;
        const sy = y + yy;
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        out.data.set(img.data.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (yy * out.width + xx) * 4);
      }
    }
    img = out;
  }
  const maxSide = Math.max(img.width, img.height);
  const scale = opts.scale ?? Math.max(1, Math.min(4, Math.floor(1024 / maxSide)));
  const final = scale > 1 ? scaleBitmap(img, scale) : img;
  return { png: encodePng(final), width: final.width, height: final.height, hidden };
}
