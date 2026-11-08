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
import { type DataTable, type GameProject, type Scene, assertIdentifier, createGame, newGameId, normalizeGame, normalizeScene, normalizeTable } from '../core/game/types.js';

const SUFFIX = '.sprite.json';
const SCENE_SUFFIX = '.scene.json';
export const GAME_FILE = 'game.json';

export type ChangeKind = 'sprite' | 'scene' | 'game' | 'script' | 'dialogue' | 'data';
const SCRIPT_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const AUDIO_MIME: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4' };
/** Script names are paths in scripts/ without .js: "enemies/Patrol". */
const SCRIPT_PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}\/){0,8}[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

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

  // ------------------------------------------------------------------ scripts

  get scriptsDir(): string {
    return path.join(this.dir, 'scripts');
  }

  scriptFile(name: string): string {
    if (!SCRIPT_PATH_RE.test(name)) throw new Error(`Invalid script name "${name}". Use folders and names with letters, digits, "_" and "-", e.g. "enemies/Patrol".`);
    return path.join(this.scriptsDir, ...name.split('/')) + '.js';
  }

  private scriptFolderPath(folder: string): string {
    if (!SCRIPT_PATH_RE.test(folder)) throw new Error(`Invalid folder name "${folder}". Use letters, digits, "_" and "-" (nested: "enemies/bosses").`);
    return path.join(this.scriptsDir, ...folder.split('/'));
  }

  scriptExists(name: string): boolean {
    return fs.existsSync(this.scriptFile(name));
  }

  /** Every script in scripts/ and its subfolders (names are paths without .js). */
  listScripts(): { name: string; size: number; updatedAt: number }[] {
    const out: { name: string; size: number; updatedAt: number }[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 9 || !fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SCRIPT_RE.test(e.name)) walk(full, prefix + e.name + '/', depth + 1);
        } else if (e.name.endsWith('.js') && !e.name.endsWith('.d.js') && SCRIPT_RE.test(e.name.slice(0, -3))) {
          const st = fs.statSync(full);
          out.push({ name: prefix + e.name.slice(0, -3), size: st.size, updatedAt: st.mtimeMs });
        }
      }
    };
    walk(this.scriptsDir, '', 0);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Every folder in scripts/ (also empty ones), as paths: ["enemies", "enemies/bosses", "ui"]. */
  listScriptFolders(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 8 || !fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith('.') || !SCRIPT_RE.test(e.name)) continue;
        out.push(prefix + e.name);
        walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1);
      }
    };
    walk(this.scriptsDir, '', 0);
    return out.sort();
  }

  createScriptFolder(folder: string): void {
    fs.mkdirSync(this.scriptFolderPath(folder), { recursive: true });
  }

  /** Deletes a folder and the scripts in it. */
  removeScriptFolder(folder: string): void {
    const dir = this.scriptFolderPath(folder);
    if (!fs.existsSync(dir)) throw new Error(`Folder "${folder}" not found`);
    fs.rmSync(dir, { recursive: true });
  }

  /** Moves/renames a script or a whole folder ("enemies" → "monsters", "Patrol" → "enemies/Patrol"). */
  moveScript(from: string, to: string): void {
    const isFolder = !this.scriptExists(from) && fs.existsSync(this.scriptFolderPath(from));
    const src = isFolder ? this.scriptFolderPath(from) : this.scriptFile(from);
    const dst = isFolder ? this.scriptFolderPath(to) : this.scriptFile(to);
    if (!fs.existsSync(src)) throw new Error(`Script "${from}" not found`);
    if (fs.existsSync(dst)) throw new Error(`"${to}" already exists`);
    if (isFolder && (dst + path.sep).startsWith(src + path.sep)) throw new Error('Cannot move a folder into itself');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  }

  readScript(name: string): string {
    const f = this.scriptFile(name);
    if (!fs.existsSync(f)) {
      const names = this.listScripts().map((s) => s.name);
      throw new Error(`Script "${name}" not found.${names.length ? ' Available: ' + names.join(', ') : ' There are no scripts yet.'}`);
    }
    return fs.readFileSync(f, 'utf8');
  }

  /** All scripts as name → source. */
  loadScripts(): Record<string, string> {
    return Object.fromEntries(this.listScripts().map((s) => [s.name, this.readScript(s.name)]));
  }

  writeScript(name: string, code: string): void {
    const f = this.scriptFile(name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, f);
  }

  removeScript(name: string): void {
    fs.rmSync(this.scriptFile(name));
  }

  /** Writes a file next to the scripts (IDE support: jsconfig.json, spritifer.d.ts) if its content changed. */
  writeScriptSupportFile(file: string, content: string): boolean {
    const f = path.join(this.scriptsDir, file);
    if (fs.existsSync(f) && fs.readFileSync(f, 'utf8') === content) return false;
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    fs.writeFileSync(f, content);
    return true;
  }

  // ------------------------------------------------------------------ audio

  get audioDir(): string {
    return path.join(this.dir, 'audio');
  }

  /** Audio files in audio/ (music and sound effects): name = file name without the extension. */
  listAudio(): { name: string; file: string; size: number; mime: string }[] {
    if (!fs.existsSync(this.audioDir)) return [];
    return fs
      .readdirSync(this.audioDir)
      .map((f) => ({ f, m: /^([A-Za-z_][A-Za-z0-9_-]{0,63})\.(mp3|ogg|wav|m4a)$/i.exec(f) }))
      .filter((x) => x.m)
      .map(({ f, m }) => ({ name: m![1], file: f, size: fs.statSync(path.join(this.audioDir, f)).size, mime: AUDIO_MIME[m![2].toLowerCase()] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readAudio(name: string): { data: Buffer; mime: string } {
    const a = this.listAudio().find((x) => x.name === name);
    if (!a) throw new Error(`Audio "${name}" not found.`);
    return { data: fs.readFileSync(path.join(this.audioDir, a.file)), mime: a.mime };
  }

  /** Saves an audio file (replacing one with the same name, whatever its extension). */
  writeAudio(name: string, ext: string, data: Buffer): void {
    if (!SCRIPT_RE.test(name)) throw new Error(`Invalid audio name "${name}". Use letters, digits, "_" and "-".`);
    const e = ext.toLowerCase().replace(/^\./, '');
    if (!AUDIO_MIME[e]) throw new Error(`Unsupported audio format ".${e}" (use mp3, ogg, wav or m4a)`);
    if (data.length > 20 * 1024 * 1024) throw new Error('Audio files are limited to 20 MB');
    fs.mkdirSync(this.audioDir, { recursive: true });
    for (const a of this.listAudio()) if (a.name === name) fs.rmSync(path.join(this.audioDir, a.file));
    fs.writeFileSync(path.join(this.audioDir, `${name}.${e}`), data);
  }

  removeAudio(name: string): void {
    const a = this.listAudio().find((x) => x.name === name);
    if (!a) throw new Error(`Audio "${name}" not found.`);
    fs.rmSync(path.join(this.audioDir, a.file));
  }

  // ------------------------------------------------------------------ dialogues

  get dialoguesDir(): string {
    return path.join(this.dir, 'dialogues');
  }

  dialogueFile(name: string): string {
    if (!SCRIPT_RE.test(name)) throw new Error(`Invalid dialogue file name "${name}". Use letters, digits, "_" and "-".`);
    return path.join(this.dialoguesDir, `${name}.dialogue`);
  }

  dialogueExists(name: string): boolean {
    return fs.existsSync(this.dialogueFile(name));
  }

  listDialogues(): { name: string; size: number; updatedAt: number }[] {
    if (!fs.existsSync(this.dialoguesDir)) return [];
    return fs
      .readdirSync(this.dialoguesDir)
      .filter((f) => f.endsWith('.dialogue') && SCRIPT_RE.test(f.slice(0, -9)))
      .map((f) => {
        const st = fs.statSync(path.join(this.dialoguesDir, f));
        return { name: f.slice(0, -9), size: st.size, updatedAt: st.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  readDialogue(name: string): string {
    const f = this.dialogueFile(name);
    if (!fs.existsSync(f)) {
      const names = this.listDialogues().map((s) => s.name);
      throw new Error(`Dialogue file "${name}" not found.${names.length ? ' Available: ' + names.join(', ') : ' There are no dialogue files yet.'}`);
    }
    return fs.readFileSync(f, 'utf8');
  }

  loadDialogues(): Record<string, string> {
    return Object.fromEntries(this.listDialogues().map((s) => [s.name, this.readDialogue(s.name)]));
  }

  writeDialogue(name: string, code: string): void {
    const f = this.dialogueFile(name);
    fs.mkdirSync(this.dialoguesDir, { recursive: true });
    const tmp = path.join(this.dialoguesDir, `.${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, code);
    fs.renameSync(tmp, f);
  }

  removeDialogue(name: string): void {
    fs.rmSync(this.dialogueFile(name));
  }

  // ------------------------------------------------------------------ data tables

  get dataDir(): string {
    return path.join(this.dir, 'data');
  }

  tableFile(name: string): string {
    assertIdentifier('data table', name);
    return path.join(this.dataDir, `${name}.json`);
  }

  tableExists(name: string): boolean {
    return fs.existsSync(this.tableFile(name));
  }

  listTables(): { name: string; rows: number; columns: string[]; description?: string; updatedAt: number; rev: string }[] {
    if (!fs.existsSync(this.dataDir)) return [];
    const out = [];
    for (const f of fs.readdirSync(this.dataDir)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const name = f.slice(0, -5);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) continue;
      try {
        const t = this.loadTable(name);
        out.push({ name, rows: t.rows.length, columns: t.columns.map((c) => c.name), ...(t.description ? { description: t.description } : {}), updatedAt: fs.statSync(path.join(this.dataDir, f)).mtimeMs, rev: t.rev });
      } catch {
        // Unreadable file: skipped (validate_game reports it).
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  loadTable(name: string): DataTable {
    const f = this.tableFile(name);
    if (!fs.existsSync(f)) {
      const names = this.listTables().map((t) => t.name);
      throw new Error(`Data table "${name}" not found.${names.length ? ' Tables: ' + names.join(', ') : ' There are no data tables yet.'}`);
    }
    return normalizeTable(JSON.parse(fs.readFileSync(f, 'utf8')), name);
  }

  loadTables(): Record<string, DataTable> {
    return Object.fromEntries(this.listTables().map((t) => [t.name, this.loadTable(t.name)]));
  }

  saveTable(table: DataTable, updatedBy?: string): DataTable {
    const t = normalizeTable({ ...table, rev: newGameId(), ...(updatedBy ? { updatedBy } : {}) }, table.name);
    t.name = table.name;
    const f = this.tableFile(t.name);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, `.${t.name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(t, null, 1));
    fs.renameSync(tmp, f);
    return t;
  }

  removeTable(name: string): void {
    fs.rmSync(this.tableFile(name));
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
    // Scripts live in a folder tree.
    fs.mkdirSync(this.scriptsDir, { recursive: true });
    const scriptWatcher = fs.watch(this.scriptsDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.split(path.sep).join('/');
      if (rel.split('/').some((p) => p.startsWith('.'))) return;
      // A folder changed (created, renamed, deleted): tell clients with an empty name.
      if (!rel.endsWith('.js')) {
        if (rel.endsWith('.d.ts') || rel.endsWith('.json')) return;
        const key = 'script:';
        clearTimeout(timers.get(key));
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          onChange('', 'script');
        }, 40));
        return;
      }
      const name = rel.slice(0, -3);
      const key = 'script:' + name;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        onChange(name, 'script');
      }, 40));
    });
    fs.mkdirSync(this.dialoguesDir, { recursive: true });
    const dialogueWatcher = fs.watch(this.dialoguesDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.dialogue') || filename.startsWith('.')) return;
      const name = filename.slice(0, -9);
      const key = 'dialogue:' + name;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        onChange(name, 'dialogue');
      }, 40));
    });
    fs.mkdirSync(this.dataDir, { recursive: true });
    const dataWatcher = fs.watch(this.dataDir, (_event, filename) => {
      if (!filename || !filename.endsWith('.json') || filename.startsWith('.')) return;
      const name = filename.slice(0, -5);
      const key = 'data:' + name;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        onChange(name, 'data');
      }, 40));
    });
    return () => {
      watcher.close();
      scriptWatcher.close();
      dialogueWatcher.close();
      dataWatcher.close();
    };
  }
}
