import type { PixelLabCharacter } from '../core/pixellab.js';
import type { CreateSpriteOptions, SpriteCategory, SpriteFile } from '../core/sprite.js';
import type { SheetOptions } from '../core/sheet.js';

export interface SpriteSummary {
  name: string;
  width: number;
  height: number;
  frames: number;
  layers: number;
  tags: string[];
  category: SpriteCategory | null;
  grid: { width: number; height: number } | null;
  updatedAt: number;
  rev: string;
}

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

/** The project shown in this tab (?project=<id> in the URL); null = the server's default project. */
export function projectId(): string | null {
  return new URLSearchParams(location.search).get('project');
}

/** API prefix of the current project. */
export function apiBase(): string {
  const id = projectId();
  return id ? `/api/p/${encodeURIComponent(id)}` : '/api';
}

/** Project id the server opened by default (from the live socket's hello). */
export let defaultProjectId: string | null = null;

/** Id of the project shown in this tab. */
export function currentProjectId(): string | null {
  return projectId() ?? defaultProjectId;
}

export const api = {
  pixelLab: {
    config: (base: string) => req<{ configured: boolean }>('GET', `${base}/pixellab/config`),
    create: (base: string, body: { name: string; description: string; size: number; view: string; reference?: { mode: string; png: string } }) =>
      req<{ character_id: string; background_job_id: string }>('POST', `${base}/pixellab/create`, body),
    character: (base: string, id: string) => req<PixelLabCharacter>('GET', `${base}/pixellab/character/${enc(id)}`),
    job: (base: string, id: string) => req<{ status: string }>('GET', `${base}/pixellab/job/${enc(id)}`),
    animate: (base: string, body: { id: string; action: string; description?: string }) =>
      req<{ background_job_ids: string[]; animation_group_id?: string | null }>('POST', `${base}/pixellab/animate`, body),
    preview: (base: string, body: { id: string; name: string; animations: { action: string; groupId: string }[] }) =>
      req<SpriteFile>('POST', `${base}/pixellab/preview`, body),
    import: (base: string, file: SpriteFile) => req<{ name: string; rev: string }>('POST', `${base}/pixellab/import`, file),
    image: (base: string, body: Record<string, unknown>) => req<{ name: string; rev: string }>('POST', `${base}/pixellab/image`, body),
    tileset: (base: string, body: Record<string, unknown>) =>
      req<{ tileset_id: string; background_job_id: string; name: string }>('POST', `${base}/pixellab/tileset`, body),
    importTileset: (base: string, body: { id: string; name: string }) =>
      req<{ name: string; rev: string }>('POST', `${base}/pixellab/tileset-import`, body),
  },
  workspace: () => req<{ dir: string; exportDir: string }>('GET', `${apiBase()}/workspace`),
  list: () => req<SpriteSummary[]>('GET', `${apiBase()}/sprites`),
  get: (name: string) => req<SpriteFile>('GET', `${apiBase()}/sprites/${enc(name)}`),
  save: (file: SpriteFile) => req<{ rev: string }>('PUT', `${apiBase()}/sprites/${enc(file.name)}`, file),
  create: (body: CreateSpriteOptions) =>
    req<{ name: string; rev: string }>('POST', `${apiBase()}/sprites`, body),
  setCategory: (name: string, category: SpriteCategory | null) =>
    req<{ ok: true }>('PUT', `${apiBase()}/sprites/${enc(name)}/category`, { category }),
  remove: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/sprites/${enc(name)}`),
  rename: (name: string, to: string) => req<{ name: string; rev: string }>('POST', `${apiBase()}/sprites/${enc(name)}/rename`, { to }),
  duplicate: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/sprites/${enc(name)}/duplicate`, { to }),
  importArt: (body: { sprites: { name: string; width: number; height: number; frames: string[]; tags: (string | null)[] }[]; overwrite?: boolean }) => req<{ names: string[] }>('POST', `${apiBase()}/art`, body),
  importPng: (body: { name: string; png: string; frameWidth?: number; frameHeight?: number; category?: SpriteCategory }) => req<{ name: string }>('POST', `${apiBase()}/import`, body),
  export: (name: string, opts: SheetOptions & { byTag?: boolean }) =>
    req<{ files: { png: string; json: string; width: number; height: number; frames: number }[] }>('POST', `${apiBase()}/sprites/${enc(name)}/export`, opts),
  sheetUrl: (name: string, opts: SheetOptions, kind: 'png' | 'json', download = false) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '' && !Array.isArray(v)) q.set(k, String(v));
    if (download) q.set('download', '1');
    return `${apiBase()}/sprites/${enc(name)}/sheet.${kind}?${q}`;
  },
  previewUrl: (name: string, rev: string, scale = 4) => `${apiBase()}/sprites/${enc(name)}/preview.png?scale=${scale}&r=${enc(rev)}`,
};

export interface ChangeEvent {
  type: 'sprite-changed' | 'scene-changed' | 'game-changed' | 'script-changed' | 'dialogue-changed' | 'data-changed' | 'vfx-changed';
  /** Project the change belongs to. */
  project?: string;
  name: string;
  rev: string | null;
  updatedBy?: string;
}

/** Live notifications of sprite file changes (e.g. Claude drawing through MCP). Reconnects automatically. */
export function connectLive(onChange: (e: ChangeEvent) => void, onStatus: (connected: boolean) => void): void {
  let retry = 500;
  const open = () => {
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    sock.onopen = () => {
      retry = 500;
      onStatus(true);
    };
    sock.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.type === 'hello' && typeof msg.project === 'string') defaultProjectId = msg.project;
      if (typeof msg.type === 'string' && msg.type.endsWith('-changed')) onChange(msg);
    };
    sock.onclose = () => {
      onStatus(false);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 8000);
    };
  };
  open();
}
