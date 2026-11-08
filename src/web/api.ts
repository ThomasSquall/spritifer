import type { SpriteFile } from '../core/sprite.js';
import type { SheetOptions } from '../core/sheet.js';

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
  workspace: () => req<{ dir: string; exportDir: string }>('GET', `${apiBase()}/workspace`),
  list: () => req<SpriteSummary[]>('GET', `${apiBase()}/sprites`),
  get: (name: string) => req<SpriteFile>('GET', `${apiBase()}/sprites/${enc(name)}`),
  save: (file: SpriteFile) => req<{ rev: string }>('PUT', `${apiBase()}/sprites/${enc(file.name)}`, file),
  create: (body: { name: string; width: number; height: number; palette?: string; grid?: { width: number; height: number } | null }) =>
    req<{ name: string; rev: string }>('POST', `${apiBase()}/sprites`, body),
  remove: (name: string) => req<{ ok: true }>('DELETE', `${apiBase()}/sprites/${enc(name)}`),
  rename: (name: string, to: string) => req<{ name: string; rev: string }>('POST', `${apiBase()}/sprites/${enc(name)}/rename`, { to }),
  duplicate: (name: string, to: string) => req<{ name: string }>('POST', `${apiBase()}/sprites/${enc(name)}/duplicate`, { to }),
  importPng: (body: { name: string; png: string; frameWidth?: number; frameHeight?: number }) => req<{ name: string }>('POST', `${apiBase()}/import`, body),
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
  type: 'sprite-changed' | 'scene-changed' | 'game-changed' | 'script-changed' | 'dialogue-changed' | 'data-changed';
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
