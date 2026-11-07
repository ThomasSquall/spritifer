/** Client for the game project, scenes and sprite assets used by the game editors. */

import type { GameProject, Scene, SpriteAsset } from '../core/game/types.js';
import type { Problem } from '../core/game/catalog.js';

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
  getGame: () => req<GameProject & { saved: boolean }>('GET', '/api/game'),
  saveGame: (g: GameProject) => req<{ rev: string }>('PUT', '/api/game', g),
  problems: () => req<Problem[]>('GET', '/api/game/problems'),
  exportGame: () => req<{ file: string; bytes: number; sprites: number; scenes: number; problems: Problem[] }>('POST', '/api/game/export'),
  renameObject: (from: string, to: string) => req<{ ok: true }>('POST', `/api/game/objects/${enc(from)}/rename`, { to }),
  listScenes: () => req<SceneSummary[]>('GET', '/api/scenes'),
  getScene: (name: string) => req<Scene>('GET', `/api/scenes/${enc(name)}`),
  saveScene: (s: Scene) => req<{ rev: string }>('PUT', `/api/scenes/${enc(s.name)}`, s),
  createScene: (body: { name: string; cols: number; rows: number; tileset?: string; tileSize?: number }) => req<{ name: string }>('POST', '/api/scenes', body),
  deleteScene: (name: string) => req<{ ok: true }>('DELETE', `/api/scenes/${enc(name)}`),
  renameScene: (name: string, to: string) => req<{ name: string }>('POST', `/api/scenes/${enc(name)}/rename`, { to }),
  duplicateScene: (name: string, to: string) => req<{ name: string }>('POST', `/api/scenes/${enc(name)}/duplicate`, { to }),
  scenePreviewUrl: (name: string, rev: string, scale = 1) => `/api/scenes/${enc(name)}/preview.png?scale=${scale}&r=${enc(rev)}`,
  playUrl: (scene?: string, debug = false) => `/api/game/play.html?${scene ? `scene=${enc(scene)}&` : ''}${debug ? 'debug=1&' : ''}t=${Date.now()}`,
  downloadUrl: () => '/api/game/export.html?download=1',
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
        fetch(`/api/sprites/${enc(name)}/sheet.json?${q}`).then((r) => r.json() as Promise<SheetJson>),
        new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = reject;
          im.src = `/api/sprites/${enc(name)}/sheet.png?${q}`;
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
