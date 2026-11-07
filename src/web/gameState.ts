/** Shared client-side state of the game project (game.json + sprite and scene lists), with autosave. */

import type { GameProject, ObjectType } from '../core/game/types.js';
import { api, type SpriteSummary } from './api.js';
import { type LoadedAsset, type SceneSummary, gameApi, loadAsset } from './gameApi.js';
import { toast } from './dom.js';

type Listener = () => void;

class GameState {
  game: GameProject | null = null;
  saved = false;
  sprites: SpriteSummary[] = [];
  scenes: SceneSummary[] = [];
  /** What the project scripts register (for dropdowns) and their loading errors. */
  scriptInfo: { behaviors: string[]; functions: string[]; errors: string[] } = { behaviors: [], functions: [], errors: [] };
  private listeners = new Set<Listener>();
  private saveTimer = 0;
  private lastRev = '';
  private dirty = false;

  async load(): Promise<void> {
    const [game, sprites, scenes, scriptInfo] = await Promise.all([gameApi.getGame(), api.list(), gameApi.listScenes(), gameApi.scriptInfo().catch(() => this.scriptInfo)]);
    this.scriptInfo = scriptInfo;
    this.saved = game.saved;
    this.game = game;
    this.lastRev = game.rev;
    this.sprites = sprites;
    this.scenes = scenes;
    this.emit();
  }

  async ensure(): Promise<GameProject> {
    if (!this.game) await this.load();
    return this.game!;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const l of [...this.listeners]) l();
  }

  object(name: string): ObjectType | undefined {
    return this.game?.objects.find((o) => o.name === name);
  }

  sprite(name: string | undefined): SpriteSummary | undefined {
    return name ? this.sprites.find((s) => s.name === name) : undefined;
  }

  asset(name: string | undefined): Promise<LoadedAsset | undefined> {
    const s = this.sprite(name);
    if (!s) return Promise.resolve(undefined);
    return loadAsset(s.name, s.rev, s);
  }

  /** Marks the game as changed and saves it shortly after. */
  change(): void {
    this.dirty = true;
    this.emit();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 350);
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (!this.dirty || !this.game) return;
    this.dirty = false;
    try {
      const { rev } = await gameApi.saveGame(this.game);
      this.lastRev = rev;
      this.game.rev = rev;
      this.saved = true;
    } catch (err) {
      this.dirty = true;
      toast(`Could not save the game: ${(err as Error).message}`, 'error');
    }
  }

  /** Handles live notifications from the server (Claude editing through MCP, other tabs). */
  async remote(kind: 'sprite' | 'scene' | 'game' | 'script', rev: string | null): Promise<boolean> {
    if (kind === 'script') {
      this.scriptInfo = await gameApi.scriptInfo();
      this.emit();
      return true;
    }
    if (kind === 'game') {
      if (rev === this.lastRev || this.dirty) return false;
      const g = await gameApi.getGame();
      if (g.rev === this.lastRev) return false;
      this.game = g;
      this.saved = g.saved;
      this.lastRev = g.rev;
      this.emit();
      return true;
    }
    if (kind === 'sprite') this.sprites = await api.list();
    else this.scenes = await gameApi.listScenes();
    this.emit();
    return true;
  }
}

export const state = new GameState();
