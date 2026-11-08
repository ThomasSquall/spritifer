/** Server-side game operations: bundling assets, exporting a standalone web build, rendering previews. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Bitmap, type Sprite } from '../core/sprite.js';
import { buildSpritesheet } from '../core/sheet.js';
import { parseColor } from '../core/color.js';
import { scaleBitmap } from '../core/draw.js';
import { rasterText } from '../core/game/font.js';
import { type Renderer, World, renderWorld } from '../core/game/engine.js';
import type { ScreenLight } from '../core/game/atmosphere.js';
import { type Problem, validateGame } from '../core/game/catalog.js';
import type { GameBundle, GameProject, Scene, SpriteAsset, Value } from '../core/game/types.js';
import { encodePng } from './png.js';
import { inspectScripts } from './scripts.js';
import type { ScriptInfo } from '../core/game/script.js';
import { type DialogueError, buildDialogueBook } from '../core/game/dialogue.js';
import type { Workspace } from './store.js';

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
      },
    };
    if (assetCache.size > 200) assetCache.clear();
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
  // ...and sprites named in data tables (monsters.sprite, residents.sprite...).
  const data = ws.loadTables();
  for (const t of Object.values(data)) {
    for (const r of t.rows) for (const v of Object.values(r)) for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && available.has(x)) used.add(x);
  }
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
  const problems = validateGame(game, scenes, available, scriptInfo, dialogueInfo, ws.listAudio().map((a) => a.name), data);
  const audioList = ws.listAudio();
  // Played/exported games carry the files as data URLs; headless runs only need the names.
  const audio = Object.fromEntries(audioList.map((a) => [a.name, opts.images ? `data:${a.mime};base64,${ws.readAudio(a.name).data.toString('base64')}` : '']));
  return { bundle: { game, scenes: Object.fromEntries(scenes.map((s) => [s.name, s])), sprites, scripts, dialogues, ...(audioList.length ? { audio } : {}), ...(Object.keys(data).length ? { data } : {}) }, sheets, problems, scriptInfo, dialogueInfo };
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
  const slug = bundle.game.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
  const dir = opts.outDir ? path.resolve(opts.outDir) : path.join(ws.exportDir, 'web', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, html);
  return { file, bytes: Buffer.byteLength(html), sprites: Object.keys(bundle.sprites).length, scenes: Object.keys(bundle.scenes).length, problems };
}

// ---------------------------------------------------------------------------
// Bitmap rendering (previews, playtest snapshots)

export class BitmapRenderer implements Renderer {
  readonly out: Bitmap;
  constructor(width: number, height: number, private sheets: Map<string, Bitmap>) {
    this.out = { width, height, data: new Uint8ClampedArray(width * height * 4) };
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

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; scale?: number }): void {
    const src = this.sheets.get(sprite);
    if (!src) return;
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

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    let c: [number, number, number, number];
    try {
      c = parseColor(color);
    } catch {
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

  text(text: string, x: number, y: number, color: string, scale: number): void {
    let c: [number, number, number, number];
    try {
      c = parseColor(color);
    } catch {
      return;
    }
    rasterText(text, (px, py) => {
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) this.blend(Math.round(x) + px * scale + sx, Math.round(y) + py * scale + sy, c[0], c[1], c[2], c[3]);
    });
  }
}

/** Renders what the player currently sees. */
export function renderViewport(world: World, sheets: Map<string, Bitmap>, scale = 1): Buffer {
  const r = new BitmapRenderer(world.game.width, world.game.height, sheets);
  renderWorld(world, r);
  return encodePng(scale > 1 ? scaleBitmap(r.out, scale) : r.out);
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
  const r = new BitmapRenderer(W, H, loaded.sheets);
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
