import fs from 'node:fs';
import path from 'node:path';
import {
  type Sprite,
  type SpriteFile,
  assertValidName,
  deserializeSprite,
  newId,
  serializeSprite,
} from '../core/sprite.js';
import { type GameProject, type Scene, assertIdentifier, createGame, newGameId, normalizeGame, normalizeScene } from '../core/game/types.js';

const SUFFIX = '.sprite.json';
const SCENE_SUFFIX = '.scene.json';
export const GAME_FILE = 'game.json';

export type ChangeKind = 'sprite' | 'scene' | 'game';

export interface SpriteSummary {
  name: string;
  width: number;
  height: number;
  frames: number;
  layers: number;
  tags: string[];
  grid: { width: number; height: number } | null;
  updatedAt: number;
  rev: string;
}

/** A folder of `*.sprite.json` files shared by the editor and the MCP server. */
export class Workspace {
  readonly dir: string;
  readonly exportDir: string;

  constructor(dir: string) {
    this.dir = path.resolve(dir);
    this.exportDir = path.join(this.dir, 'export');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  file(name: string): string {
    assertValidName(name);
    return path.join(this.dir, name + SUFFIX);
  }

  exists(name: string): boolean {
    return fs.existsSync(this.file(name));
  }

  list(): SpriteSummary[] {
    const out: SpriteSummary[] = [];
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.endsWith(SUFFIX)) continue;
      const full = path.join(this.dir, entry);
      try {
        const json = JSON.parse(fs.readFileSync(full, 'utf8')) as SpriteFile;
        out.push({
          name: json.name,
          width: json.width,
          height: json.height,
          frames: json.frames.length,
          layers: json.layers.length,
          tags: (json.tags ?? []).map((t) => t.name),
          grid: json.grid ?? null,
          updatedAt: fs.statSync(full).mtimeMs,
          rev: json.rev,
        });
      } catch {
        // Ignore partially written or foreign files.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  readRaw(name: string): SpriteFile {
    const file = this.file(name);
    if (!fs.existsSync(file)) {
      const names = this.list().map((s) => s.name);
      throw new Error(`Sprite "${name}" not found.${names.length ? ' Available: ' + names.join(', ') : ' The workspace is empty.'}`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SpriteFile;
  }

  load(name: string): Sprite {
    return deserializeSprite(this.readRaw(name));
  }

  /** Writes atomically and assigns a fresh revision. */
  save(sprite: Sprite, updatedBy = 'unknown'): string {
    sprite.rev = newId();
    this.writeRaw(serializeSprite(sprite, updatedBy));
    return sprite.rev;
  }

  writeRaw(file: SpriteFile): void {
    const target = this.file(file.name);
    const tmp = path.join(this.dir, `.${file.name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(file));
    fs.renameSync(tmp, target);
  }

  remove(name: string): void {
    fs.rmSync(this.file(name));
  }

  rename(from: string, to: string): Sprite {
    if (this.exists(to)) throw new Error(`Sprite "${to}" already exists`);
    const sprite = this.load(from);
    sprite.name = to;
    this.save(sprite, 'rename');
    this.remove(from);
    return sprite;
  }

  // ------------------------------------------------------------------ game project

  gameFile(): string {
    return path.join(this.dir, GAME_FILE);
  }

  hasGame(): boolean {
    return fs.existsSync(this.gameFile());
  }

  /** The game project; a default one (not yet saved) when the workspace has none. */
  loadGame(): GameProject {
    if (!this.hasGame()) return createGame({ title: 'My Game', startScene: this.listScenes()[0]?.name ?? '' });
    return normalizeGame(JSON.parse(fs.readFileSync(this.gameFile(), 'utf8')));
  }

  saveGame(game: GameProject, updatedBy = 'unknown'): string {
    game.rev = newGameId();
    game.updatedBy = updatedBy;
    this.atomicWrite(this.gameFile(), JSON.stringify(game, null, 1));
    return game.rev;
  }

  sceneFile(name: string): string {
    assertIdentifier('scene', name);
    return path.join(this.dir, name + SCENE_SUFFIX);
  }

  sceneExists(name: string): boolean {
    return fs.existsSync(this.sceneFile(name));
  }

  listScenes(): { name: string; cols: number; rows: number; tileSize: number; instances: number; updatedAt: number; rev: string }[] {
    const out = [];
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.endsWith(SCENE_SUFFIX)) continue;
      const full = path.join(this.dir, entry);
      try {
        const sc = normalizeScene(JSON.parse(fs.readFileSync(full, 'utf8')));
        out.push({ name: sc.name, cols: sc.cols, rows: sc.rows, tileSize: sc.tileSize, instances: sc.instances.length, updatedAt: fs.statSync(full).mtimeMs, rev: sc.rev });
      } catch {
        // Ignore partially written files.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  loadScene(name: string): Scene {
    const file = this.sceneFile(name);
    if (!fs.existsSync(file)) {
      const names = this.listScenes().map((s) => s.name);
      throw new Error(`Scene "${name}" not found.${names.length ? ' Available: ' + names.join(', ') : ' There are no scenes yet.'}`);
    }
    const scene = normalizeScene(JSON.parse(fs.readFileSync(file, 'utf8')));
    scene.name = name;
    return scene;
  }

  saveScene(scene: Scene, updatedBy = 'unknown'): string {
    scene.rev = newGameId();
    scene.updatedBy = updatedBy;
    // Tile arrays are long: keep them on one line each so the file stays diff-friendly.
    this.atomicWrite(this.sceneFile(scene.name), JSON.stringify(scene));
    return scene.rev;
  }

  removeScene(name: string): void {
    fs.rmSync(this.sceneFile(name));
  }

  private atomicWrite(target: string, data: string): void {
    const tmp = path.join(this.dir, `.${path.basename(target)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  }

  /** Calls `onChange(name, kind)` whenever a sprite, scene or the game file is written or removed (debounced per file). */
  watch(onChange: (name: string, kind: ChangeKind) => void): () => void {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(this.dir, (_event, filename) => {
      if (!filename) return;
      let kind: ChangeKind;
      let name: string;
      if (filename.endsWith(SUFFIX)) {
        kind = 'sprite';
        name = filename.slice(0, -SUFFIX.length);
      } else if (filename.endsWith(SCENE_SUFFIX)) {
        kind = 'scene';
        name = filename.slice(0, -SCENE_SUFFIX.length);
      } else if (filename === GAME_FILE) {
        kind = 'game';
        name = 'game';
      } else return;
      const key = kind + ':' + name;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          onChange(name, kind);
        }, 40),
      );
    });
    return () => watcher.close();
  }
}
