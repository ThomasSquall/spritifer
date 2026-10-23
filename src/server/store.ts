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

const SUFFIX = '.sprite.json';

export interface SpriteSummary {
  name: string;
  width: number;
  height: number;
  frames: number;
  layers: number;
  tags: string[];
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

  /** Calls `onChange(name)` whenever a sprite file is written or removed (debounced per file). */
  watch(onChange: (name: string) => void): () => void {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(this.dir, (_event, filename) => {
      if (!filename || !filename.endsWith(SUFFIX)) return;
      const name = filename.slice(0, -SUFFIX.length);
      clearTimeout(timers.get(name));
      timers.set(
        name,
        setTimeout(() => {
          timers.delete(name);
          onChange(name);
        }, 40),
      );
    });
    return () => watcher.close();
  }
}
