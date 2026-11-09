/** Client for the game project, scenes and sprite assets used by the game editors. */

import type { DataTable, GameProject, Scene, SpriteAsset, Value } from '../core/game/types.js';
import type { Problem } from '../core/game/catalog.js';
import type { VfxGraph } from '../core/game/vfxGraph.js';
import type { ScriptInfo } from '../core/game/script.js';
import type { Usage, UsageKind } from '../core/game/usages.js';
import type { WorldMap } from '../core/game/worldMap.js';
import type { GameTest, TestOutcome } from '../core/game/gameTests.js';
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

export interface TableSummary {
  name: string;
  rows: number;
  columns: string[];
  description?: string;
  updatedAt: number;
  rev: string;
}

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

export interface HistoryEntry {
  id: string;
  time: number;
  author: string;
  kind: 'game' | 'scene' | 'data' | 'vfx' | 'script' | 'dialogue';
  name: string;
  summary: string;
  undoOf?: string;
  undoneBy?: string;
}

export interface MapNote {
  id: string;
  scene: string;
  x: number;
  y: number;
  text: string;
  author: string;
  time: number;
  resolved?: boolean;
  reply?: string;
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

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export interface GitChange { path: string; status: GitChangeStatus; oldPath?: string }
export interface GitCommit { sha: string; short: string; author: string; time: number; subject: string }
export interface GitStatus {
  installed: boolean;
  enabled: boolean;
  parentRepo: string | null;
  branch: string | null;
  head: string | null;
  changes: GitChange[];
  remote: string | null;
  pushed: boolean;
  ahead: number;
  behind: number;
}

export const gitApi = {
  status: () => req<GitStatus>('GET', `${apiBase()}/git`),
  enable: () => req<GitStatus>('POST', `${apiBase()}/git/init`),
  commit: (message: string) => req<{ sha: string }>('POST', `${apiBase()}/git/commit`, { message }),
  log: (limit: number) => req<GitCommit[]>('GET', `${apiBase()}/git/log?limit=${limit}`),
  files: (sha: string) => req<GitChange[]>('GET', `${apiBase()}/git/commits/${enc(sha)}`),
  diff: (path: string, sha?: string) => req<{ text: string; truncated: boolean }>('GET', `${apiBase()}/git/diff?path=${enc(path)}${sha ? `&sha=${enc(sha)}` : ''}`),
  restore: (sha: string, path?: string) => req<{ commit: string | null; snapshot: string | null }>('POST', `${apiBase()}/git/restore`, { sha, path }),
  setRemote: (url: string) => req<{ ok: true }>('PUT', `${apiBase()}/git/remote`, { url }),
  push: () => req<{ ok: true }>('POST', `${apiBase()}/git/push`, {}),
  pull: () => req<{ ok: true }>('POST', `${apiBase()}/git/pull`, {}),
  spriteUrl: (ref: string, path: string) => `${apiBase()}/git/sprite.png?ref=${enc(ref)}&path=${enc(path)}&t=${Date.now()}`,
};

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
  sceneState: (name: string, vars: Record<string, Value>, scale = 1) => req<{ png: string; hidden: string[] }>('POST', `${apiBase()}/scenes/${enc(name)}/preview-state`, { vars, scale }),
  scenePreviewUrl: (name: string, rev: string, scale = 1) => `${apiBase()}/scenes/${enc(name)}/preview.png?scale=${scale}&r=${enc(rev)}`,
  listScripts: () => req<{ name: string; size: number; updatedAt: number }[]>('GET', `${apiBase()}/scripts`),
  getScript: (name: string) => req<{ name: string; code: string }>('GET', `${apiBase()}/scripts/${enc(name)}`),
  saveScript: (name: string, code: string) => req<{ ok: true; syntaxError: string | null }>('PUT', `${apiBase()}/scripts/${enc(name)}`, { code }),
  createScript: (name: string, kind: 'component' | 'script' = 'component') => req<{ name: string }>('POST', `${apiBase()}/scripts`, { name, kind }),
  addLibrary: (names: string[]) => req<{ created: string[]; existing: string[] }>('POST', `${apiBase()}/scripts/_library`, { names }),
  scriptSources: () => req<Record<string, string>>('GET', `${apiBase()}/scripts/_sources`),
  scriptTree: () => req<{ files: { name: string; size: number; updatedAt: number }[]; folders: string[] }>('GET', `${apiBase()}/scripts/_tree`),
  createScriptFolder: (name: string) => req<{ name: string }>('POST', `${apiBase()}/scripts/_folders`, { name }),
  deleteScriptFolder: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/scripts/_folders/${enc(name)}`),
  deleteScript: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/scripts/${enc(name)}`),
  renameScript: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/scripts/${enc(name)}/rename`, { to }),
  scriptInfo: () => req<ScriptInfo>('GET', `${apiBase()}/scripts/_info`),
  scriptReference: () => req<{ reference: string }>('GET', `${apiBase()}/scripts/_reference`),
  listAudio: () => req<{ name: string; size: number; mime: string }[]>('GET', `${apiBase()}/audio`),
  uploadAudio: (name: string, ext: string, data: string) => req<{ name: string }>('POST', `${apiBase()}/audio`, { name, ext, data }),
  deleteAudio: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/audio/${enc(name)}`),
  audioUrl: (name: string) => `${apiBase()}/audio/${enc(name)}`,
  listDialogues: () => req<{ name: string; size: number; updatedAt: number }[]>('GET', `${apiBase()}/dialogues`),
  getDialogue: (name: string) => req<{ name: string; code: string }>('GET', `${apiBase()}/dialogues/${enc(name)}`),
  saveDialogue: (name: string, code: string) => req<{ ok: true }>('PUT', `${apiBase()}/dialogues/${enc(name)}`, { code }),
  createDialogue: (name: string) => req<{ name: string }>('POST', `${apiBase()}/dialogues`, { name }),
  deleteDialogue: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/dialogues/${enc(name)}`),
  renameDialogue: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/dialogues/${enc(name)}/rename`, { to }),
  listVfx: () => req<{ name: string; nodes: number; description?: string; updatedAt: number; rev?: string }[]>('GET', `${apiBase()}/vfx`),
  getVfx: (name: string) => req<VfxGraph>('GET', `${apiBase()}/vfx/${enc(name)}`),
  saveVfx: (g: VfxGraph) => req<{ rev: string; graph: VfxGraph }>('PUT', `${apiBase()}/vfx/${enc(g.name)}`, g),
  createVfx: (name: string, template?: string) => req<VfxGraph>('POST', `${apiBase()}/vfx`, { name, ...(template ? { template } : {}) }),
  deleteVfx: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/vfx/${enc(name)}`),
  renameVfx: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/vfx/${enc(name)}/rename`, { to }),
  listTables: () => req<TableSummary[]>('GET', `${apiBase()}/data`),
  getTable: (name: string) => req<DataTable>('GET', `${apiBase()}/data/${enc(name)}`),
  saveTable: (t: DataTable) => req<{ rev: string; table: DataTable }>('PUT', `${apiBase()}/data/${enc(t.name)}`, t),
  createTable: (name: string, columns?: DataTable['columns']) => req<DataTable>('POST', `${apiBase()}/data`, { name, ...(columns ? { columns } : {}) }),
  deleteTable: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/data/${enc(name)}`),
  renameTable: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/data/${enc(name)}/rename`, { to }),
  dialogueInfo: () => req<{ nodes: string[]; errors: { file: string; line: number; message: string }[] }>('GET', `${apiBase()}/dialogues/_info`),
  usages: (kind: UsageKind, name: string) => req<Usage[]>('GET', `${apiBase()}/usages?kind=${kind}&name=${enc(name)}`),
  world: () => req<{ world: WorldMap; problems: Problem[]; minimaps: Record<string, string> }>('GET', `${apiBase()}/world`),
  postContext: (ctx: Record<string, unknown>) => req<{ ok: true }>('POST', `${apiBase()}/context`, ctx),
  postPlayLog: (body: { lines: string[]; reset: boolean }) => req<{ ok: true }>('POST', `${apiBase()}/play-log`, body),
  notes: () => req<MapNote[]>('GET', `${apiBase()}/notes`),
  createNote: (note: { scene: string; x: number; y: number; text: string }) => req<MapNote>('POST', `${apiBase()}/notes`, note),
  updateNote: (id: string, change: Partial<MapNote>) => req<MapNote>('PUT', `${apiBase()}/notes/${enc(id)}`, change),
  deleteNote: (id: string) => req<{ ok: true }>('DELETE', `${apiBase()}/notes/${enc(id)}`),
  listTests: () => req<GameTest[]>('GET', `${apiBase()}/tests`),
  saveTest: (t: GameTest) => req<GameTest>('PUT', `${apiBase()}/tests/${enc(t.name)}`, t),
  deleteTest: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/tests/${enc(name)}`),
  runTests: (names?: string[]) => req<TestOutcome[]>('POST', `${apiBase()}/tests/_run`, names ? { names } : {}),
  history: (author = '') => req<HistoryEntry[]>('GET', `${apiBase()}/history?limit=200${author ? `&author=${enc(author)}` : ''}`),
  undoChange: (id: string) => req<{ entry: HistoryEntry; conflicts: string[] }>('POST', `${apiBase()}/history/${enc(id)}/undo`, {}),
  projects: () => req<ProjectsResponse>('GET', '/api/projects'),
  createProject: (name: string, template: string) => req<ProjectInfo>('POST', '/api/projects', { name, template }),
  openProject: (dir: string) => req<ProjectInfo>('POST', '/api/projects/open', { dir }),
  forgetProject: (id: string) => req<{ ok: true }>('DELETE', `/api/projects/${enc(id)}`),
  playUrl: (scene?: string, debug = false) => `${apiBase()}/game/play.html?${scene ? `scene=${enc(scene)}&` : ''}${debug ? 'debug=1&' : ''}${new URLSearchParams(location.search).has('nomusic') ? 'nomusic=1&' : ''}t=${Date.now()}`,
  downloadUrl: () => `${apiBase()}/game/export.html?download=1`,
};

export interface LoadedAsset extends SpriteAsset {
  img: HTMLImageElement;
  rev: string;
}

interface SheetJson {
  frames: { frame: { x: number; y: number; w: number; h: number }; duration: number }[];
  meta: { frameTags: { name: string; from: number; to: number; direction: string }[] };
  relief?: SpriteAsset['relief'];
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
        ...(meta.relief ? { relief: meta.relief } : {}),
      };
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}
