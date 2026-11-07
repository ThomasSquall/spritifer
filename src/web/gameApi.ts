/** Client for the game project, scenes and sprite assets used by the game editors. */

import type { GameProject, Scene, SpriteAsset } from '../core/game/types.js';
import type { Problem } from '../core/game/catalog.js';
import { apiBase } from './api.js';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const enc = encodeURIComponent;

export interface ProjectInfo {
  id: string;
  name: string;
  dir: string;
  sprites: number;
  scenes: number;
  scripts: number;
  updatedAt: number;
  isDefault: boolean;
  firstScene: string | null;
  firstSprite: { name: string; rev: string } | null;
}

export interface ProjectsResponse {
  root: string;
  defaultId: string;
  projects: ProjectInfo[];
  templates: { id: string; label: string; description: string }[];
}

export interface SceneSummary {
  name: string;
  cols: number;
  rows: number;
  tileSize: number;
  instances: number;
  updatedAt: number;
  rev: string;
}

export const gameApi = {
  getGame: () => req<GameProject & { saved: boolean }>('GET', `${apiBase()}/game`),
  saveGame: (g: GameProject) => req<{ rev: string }>('PUT', `${apiBase()}/game`, g),
  problems: () => req<Problem[]>('GET', `${apiBase()}/game/problems`),
  exportGame: () => req<{ file: string; bytes: number; sprites: number; scenes: number; problems: Problem[] }>('POST', `${apiBase()}/game/export`),
  renameObject: (from: string, to: string) => req<{ ok: true }>('POST', `${apiBase()}/game/objects/${enc(from)}/rename`, { to }),
  listScenes: () => req<SceneSummary[]>('GET', `${apiBase()}/scenes`),
  getScene: (name: string) => req<Scene>('GET', `${apiBase()}/scenes/${enc(name)}`),
  saveScene: (s: Scene) => req<{ rev: string }>('PUT', `${apiBase()}/scenes/${enc(s.name)}`, s),
  createScene: (body: { name: string; cols: number; rows: number; tileset?: string; tileSize?: number }) => req<{ name: string }>('POST', `${apiBase()}/scenes`, body),
  deleteScene: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/scenes/${enc(name)}`),
  renameScene: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/scenes/${enc(name)}/rename`, { to }),
  duplicateScene: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/scenes/${enc(name)}/duplicate`, { to }),
  scenePreviewUrl: (name: string, rev: string, scale = 1) => `${apiBase()}/scenes/${enc(name)}/preview.png?scale=${scale}&r=${enc(rev)}`,
  listScripts: () => req<{ name: string; size: number; updatedAt: number }[]>('GET', `${apiBase()}/scripts`),
  getScript: (name: string) => req<{ name: string; code: string }>('GET', `${apiBase()}/scripts/${enc(name)}`),
  saveScript: (name: string, code: string) => req<{ ok: true; syntaxError: string | null }>('PUT', `${apiBase()}/scripts/${enc(name)}`, { code }),
  createScript: (name: string) => req<{ name: string }>('POST', `${apiBase()}/scripts`, { name }),
  deleteScript: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/scripts/${enc(name)}`),
  renameScript: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/scripts/${enc(name)}/rename`, { to }),
  scriptInfo: () => req<{ behaviors: string[]; functions: string[]; errors: string[] }>('GET', `${apiBase()}/scripts/_info`),
  scriptReference: () => req<{ reference: string }>('GET', `${apiBase()}/scripts/_reference`),
  projects: () => req<ProjectsResponse>('GET', '/api/projects'),
  createProject: (name: string, template: string) => req<ProjectInfo>('POST', '/api/projects', { name, template }),
  openProject: (dir: string) => req<ProjectInfo>('POST', '/api/projects/open', { dir }),
  forgetProject: (id: string) => req<{ ok: true }>('DELETE', `/api/projects/${enc(id)}`),
  playUrl: (scene?: string, debug = false) => `${apiBase()}/game/play.html?${scene ? `scene=${enc(scene)}&` : ''}${debug ? 'debug=1&' : ''}t=${Date.now()}`,
  downloadUrl: () => `${apiBase()}/game/export.html?download=1`,
};

export interface LoadedAsset extends SpriteAsset {
  img: HTMLImageElement;
  rev: string;
}

interface SheetJson {
  frames: { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
  meta: { frameTags: { name: string; from: number; to: number; direction: string }[] };
}

const cache = new Map<string, Promise<LoadedAsset>>();

/** Loads a sprite's grid spritesheet + metadata (same layout the exported game uses). */
export function loadAsset(name: string, rev: string, info: { width: number; height: number; grid?: { width: number; height: number } | null }): Promise<LoadedAsset> {
  const key = `${name}@${rev}`;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const q = `layout=grid&r=${enc(rev)}`;
      const [meta, img] = await Promise.all([
        fetch(`${apiBase()}/sprites/${enc(name)}/sheet.json?${q}`).then((r) => r.json() as Promise<SheetJson>),
        new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = `${apiBase()}/sprites/${enc(name)}/sheet.png?${q}`;
        }),
      ]);
      return {
        name,
        rev,
        img,
        width: info.width,
        height: info.height,
        grid: info.grid ?? null,
        frames: meta.frames.map((f) => ({ ...f.frame, duration: f.duration })),
        tags: meta.meta.frameTags.map((t) => ({ name: t.name, from: t.from, to: t.to, direction: t.direction as 'forward' })),
      };
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
