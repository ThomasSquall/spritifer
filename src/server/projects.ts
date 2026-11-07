/**
 * Projects: each game is a folder (sprites, scenes, scripts, game.json). The registry knows the folders
 * inside the projects root plus any other folder that was opened, so one editor (and one MCP session)
 * can switch between games.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeGame } from '../core/game/types.js';
import { Workspace } from './store.js';

const REGISTRY_FILE = '.spritifer-projects.json';
const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url));

export interface ProjectInfo {
  id: string;
  name: string;
  dir: string;
  sprites: number;
  scenes: number;
  scripts: number;
  updatedAt: number;
  isDefault: boolean;
  /** Name of the first scene (for thumbnails). */
  firstScene: string | null;
  firstSprite: { name: string; rev: string } | null;
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
}

export const TEMPLATES: ProjectTemplate[] = [
  { id: 'empty', label: 'Empty', description: 'Start from nothing' },
  { id: 'platformer', label: 'Platformer', description: 'Coin Quest: running, jumping, coins, enemies, title and win screens' },
  { id: 'rpg', label: 'RPG', description: 'Village: top-down hero, NPC dialogs with choices, a chest and a scripted turn-based battle' },
];
const TEMPLATE_DIRS: Record<string, string> = { platformer: 'coin-quest', rpg: 'village' };

/** Default folder for new projects: ~/Documents/Spritifer (or ~/Spritifer). */
export function defaultProjectsRoot(): string {
  const docs = path.join(os.homedir(), 'Documents');
  return path.join(fs.existsSync(docs) ? docs : os.homedir(), 'Spritifer');
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

export class ProjectRegistry {
  readonly root: string;
  readonly defaultDir: string;
  private cache = new Map<string, Workspace>();

  constructor(opts: { root: string; defaultDir: string }) {
    this.root = path.resolve(opts.root);
    this.defaultDir = path.resolve(opts.defaultDir);
  }

  /** Stable id for a folder: the folder name inside the root, otherwise name + short hash of the path. */
  idFor(dir: string): string {
    const abs = path.resolve(dir);
    if (path.dirname(abs) === this.root) return path.basename(abs);
    const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 6);
    return `${slug(path.basename(abs))}-${hash}`;
  }

  get defaultId(): string {
    return this.idFor(this.defaultDir);
  }

  private externals(): string[] {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(this.root, REGISTRY_FILE), 'utf8')) as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private saveExternals(list: string[]): void {
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(path.join(this.root, REGISTRY_FILE), JSON.stringify([...new Set(list)], null, 2) + '\n');
  }

  /** Every known project folder (default first, then root subfolders, then opened folders). */
  dirs(): string[] {
    const out = [this.defaultDir];
    if (fs.existsSync(this.root)) {
      for (const e of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) out.push(path.join(this.root, e.name));
      }
    }
    for (const d of this.externals()) if (fs.existsSync(d)) out.push(d);
    return [...new Set(out.map((d) => path.resolve(d)))];
  }

  info(dir: string): ProjectInfo {
    const abs = path.resolve(dir);
    const ws = this.workspaceFor(abs);
    let name = path.basename(abs);
    if (ws.hasGame()) {
      try {
        name = ws.loadGame().title || name;
      } catch {
        // Keep the folder name.
      }
    }
    const sprites = ws.list();
    const scenes = ws.listScenes();
    let updatedAt = 0;
    for (const x of [...sprites, ...scenes]) updatedAt = Math.max(updatedAt, x.updatedAt);
    if (ws.hasGame()) updatedAt = Math.max(updatedAt, fs.statSync(ws.gameFile()).mtimeMs);
    return {
      id: this.idFor(abs),
      name,
      dir: abs,
      sprites: sprites.length,
      scenes: scenes.length,
      scripts: ws.listScripts().length,
      updatedAt,
      isDefault: abs === this.defaultDir,
      firstScene: scenes[0]?.name ?? null,
      firstSprite: sprites[0] ? { name: sprites[0].name, rev: sprites[0].rev } : null,
    };
  }

  list(): ProjectInfo[] {
    return this.dirs().map((d) => this.info(d));
  }

  private workspaceFor(dir: string): Workspace {
    const id = this.idFor(dir);
    let ws = this.cache.get(id);
    if (!ws) {
      ws = new Workspace(dir);
      this.cache.set(id, ws);
    }
    return ws;
  }

  /** Uses an existing Workspace instance for its folder (so the server and the MCP share it). */
  seed(ws: Workspace): void {
    this.cache.set(this.idFor(ws.dir), ws);
  }

  /** The workspace of a project id (or the default project for undefined). */
  get(id?: string | null): Workspace {
    if (!id || id === this.defaultId) return this.workspaceFor(this.defaultDir);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const dir = this.dirs().find((d) => this.idFor(d) === id);
    if (!dir) throw new Error(`No project "${id}". Known projects: ${this.dirs().map((d) => this.idFor(d)).join(', ')}`);
    return this.workspaceFor(dir);
  }

  /** Finds a project by id, folder path or (case-insensitive) title. */
  resolve(ref: string): ProjectInfo {
    const all = this.list();
    const asPath = path.resolve(ref);
    const hit =
      all.find((p) => p.id === ref) ??
      all.find((p) => p.dir === asPath) ??
      all.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    if (hit) return hit;
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) return this.add(asPath);
    throw new Error(`No project "${ref}". Known: ${all.map((p) => `${p.id} (${p.name})`).join(', ')}`);
  }

  /** Registers an existing folder as a project (it becomes a project even if empty). */
  add(dir: string): ProjectInfo {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Folder not found: ${abs}`);
    if (path.dirname(abs) !== this.root && abs !== this.defaultDir) this.saveExternals([...this.externals(), abs]);
    return this.info(abs);
  }

  /** Removes a project from the list (files are kept). Root subfolders can't be forgotten, only deleted by hand. */
  forget(id: string): void {
    const ext = this.externals();
    const keep = ext.filter((d) => this.idFor(d) !== id);
    if (keep.length === ext.length) throw new Error(path.dirname(this.get(id).dir) === this.root ? 'Projects inside the projects folder can only be removed by deleting their folder.' : `Project "${id}" can't be removed from the list`);
    this.saveExternals(keep);
    this.cache.delete(id);
  }

  /** Creates a new project folder in the root, optionally from a template, with the given title. */
  create(name: string, template = 'empty'): ProjectInfo {
    const title = name.trim();
    if (!title) throw new Error('Give the project a name');
    let dir = path.join(this.root, slug(title));
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(this.root, `${slug(title)}-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const tpl = TEMPLATE_DIRS[template];
    if (tpl) {
      const src = path.join(EXAMPLES_DIR, tpl);
      if (!fs.existsSync(src)) throw new Error(`Template "${template}" not found (${src})`);
      fs.cpSync(src, dir, { recursive: true, filter: (f) => !f.split(path.sep).includes('export') });
    } else if (template !== 'empty') throw new Error(`Unknown template "${template}". Available: ${TEMPLATES.map((t) => t.id).join(', ')}`);
    const ws = this.workspaceFor(dir);
    const game = ws.loadGame();
    game.title = title;
    ws.saveGame(normalizeGame(game), 'editor');
    return this.info(dir);
  }
}
