import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { type SpriteFile, createSprite, deserializeSprite, newId } from '../core/sprite.js';
import { type SheetLayout, type SheetOptions, buildSpritesheet } from '../core/sheet.js';
import { encodePng } from './png.js';
import { exportSpritesheet, previewPng, spriteFromPng } from './ops.js';
import type { Workspace } from './store.js';
import { ProjectRegistry, TEMPLATES, defaultProjectsRoot } from './projects.js';
import { createScene, normalizeGame, normalizeScene } from '../core/game/types.js';
import { buildGameHtml, exportGame, loadGameBundle, loadRuntime, renderScenePreview } from './game.js';
import { renameObjectRefs, renameSceneRefs } from '../core/game/refactor.js';
import { SCRIPT_TEMPLATE, checkScriptSyntax, inspectScripts } from './scripts.js';
import { SCRIPT_REFERENCE } from '../core/game/script.js';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface EditorServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

/** Serves the editor UI, a REST API over the projects and a live-change WebSocket. */
export function startEditorServer(ws: Workspace, port: number, host = '127.0.0.1', opts: { registry?: ProjectRegistry } = {}): Promise<EditorServer> {
  const registry = opts.registry ?? new ProjectRegistry({ root: defaultProjectsRoot(), defaultDir: ws.dir });
  registry.seed(ws);
  const server = http.createServer((req, res) => {
    handleRequest(registry, req, res, watchProject).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 400;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();
  wss.on('connection', (sock) => {
    clients.add(sock);
    sock.on('close', () => clients.delete(sock));
    sock.send(JSON.stringify({ type: 'hello', workspace: ws.dir, project: registry.defaultId }));
  });

  // One file watcher per project that a client has used; change messages say which project changed.
  const watchers = new Map<string, () => void>();
  function watchProject(id: string, pws: Workspace): void {
    if (watchers.has(id)) return;
    watchers.set(id, pws.watch((name, kind) => {
      let rev: string | null = null;
      let updatedBy: string | undefined;
      try {
        if (kind === 'sprite') {
          const raw = pws.readRaw(name);
          rev = raw.rev;
          updatedBy = raw.updatedBy;
        } else if (kind === 'script') {
          rev = pws.scriptExists(name) ? String(Date.now()) : null;
        } else if (kind === 'scene') {
          const sc = pws.loadScene(name);
          rev = sc.rev;
          updatedBy = sc.updatedBy;
        } else {
          const g = pws.loadGame();
          rev = pws.hasGame() ? g.rev : null;
          updatedBy = g.updatedBy;
        }
      } catch {
        // Deleted.
      }
      const msg = JSON.stringify({ type: `${kind}-changed`, project: id, name, rev, updatedBy });
      for (const c of clients) c.send(msg);
    }));
  }
  watchProject(registry.defaultId, ws);
  const stopWatching = () => {
    for (const stop of watchers.values()) stop();
    watchers.clear();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({
        server,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
        close: () =>
          new Promise((done) => {
            stopWatching();
            for (const c of clients) c.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

async function handleRequest(registry: ProjectRegistry, req: http.IncomingMessage, res: http.ServerResponse, watch: (id: string, ws: Workspace) => void): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? 'GET';
  if (parts[0] !== 'api') return serveStatic(url.pathname, res);

  if (parts[1] === 'projects') return handleProjects(registry, req, res, parts.slice(2));
  // /api/p/<project>/... works on that project; plain /api/... on the default one.
  let id = registry.defaultId;
  if (parts[1] === 'p' && parts[2]) {
    id = parts[2];
    parts = ['api', ...parts.slice(3)];
  }
  let ws: Workspace;
  try {
    ws = registry.get(id);
  } catch (err) {
    throw new HttpError(404, (err as Error).message);
  }
  watch(id, ws);
  return handle(ws, req, res, parts, url, method);
}

async function handleProjects(registry: ProjectRegistry, req: http.IncomingMessage, res: http.ServerResponse, parts: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  if (!parts[0]) {
    if (method === 'GET') return sendJson(res, 200, { root: registry.root, defaultId: registry.defaultId, projects: registry.list(), templates: TEMPLATES });
    if (method === 'POST') {
      const body = (await readJson(req)) as { name: string; template?: string };
      return sendJson(res, 201, registry.create(body.name, body.template));
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (parts[0] === 'open' && method === 'POST') {
    const body = (await readJson(req)) as { dir: string };
    return sendJson(res, 200, registry.add(body.dir));
  }
  if (method === 'DELETE') {
    registry.forget(parts[0]);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET') return sendJson(res, 200, registry.info(registry.get(parts[0]).dir));
  throw new HttpError(404, 'Not found');
}

async function handle(ws: Workspace, req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL, method: string): Promise<void> {

  // /api/workspace
  if (parts[1] === 'workspace' && method === 'GET') {
    return sendJson(res, 200, { dir: ws.dir, exportDir: ws.exportDir });
  }

  // /api/import  { name, png (base64), frameWidth?, frameHeight?, overwrite? }
  if (parts[1] === 'import' && method === 'POST') {
    const body = (await readJson(req)) as { name: string; png: string; frameWidth?: number; frameHeight?: number; overwrite?: boolean };
    if (ws.exists(body.name) && !body.overwrite) throw new HttpError(409, `Sprite "${body.name}" already exists`);
    const sprite = spriteFromPng(body.name, Buffer.from(body.png, 'base64'), body);
    ws.save(sprite, 'editor');
    return sendJson(res, 201, { name: sprite.name, rev: sprite.rev });
  }

  if (parts[1] === 'game') return handleGame(ws, req, res, parts.slice(2), url);
  if (parts[1] === 'scenes') return handleScenes(ws, req, res, parts.slice(2), url);
  if (parts[1] === 'scripts') return handleScripts(ws, req, res, parts.slice(2));

  if (parts[1] !== 'sprites') throw new HttpError(404, 'Not found');
  const name = parts[2];

  if (!name) {
    if (method === 'GET') return sendJson(res, 200, ws.list());
    if (method === 'POST') {
      const body = (await readJson(req)) as { name: string; width: number; height: number; palette?: string; grid?: { width: number; height: number } | null };
      if (ws.exists(body.name)) throw new HttpError(409, `Sprite "${body.name}" already exists`);
      const sprite = createSprite(body);
      ws.save(sprite, 'editor');
      return sendJson(res, 201, { name: sprite.name, rev: sprite.rev });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  const sub = parts[3];
  if (!sub) {
    if (method === 'GET') return sendJson(res, 200, ws.readRaw(name));
    if (method === 'PUT') {
      const file = (await readJson(req)) as SpriteFile;
      if (file.name !== name) throw new HttpError(400, 'Name mismatch');
      deserializeSprite(file); // validate
      // An editor tab running an older build doesn't know newer fields (rig, ramps, reference...).
      // Keep whatever the client didn't send instead of silently dropping it.
      if (ws.exists(name)) {
        const prev = ws.readRaw(name) as unknown as Record<string, unknown>;
        const incoming = file as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(prev)) if (!(k in incoming) && k !== 'updatedBy') incoming[k] = v;
      }
      file.rev = newId();
      file.updatedBy = 'editor';
      ws.writeRaw(file);
      return sendJson(res, 200, { rev: file.rev });
    }
    if (method === 'DELETE') {
      ws.remove(name);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }

  if (sub === 'rename' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    const sprite = ws.rename(name, body.to);
    return sendJson(res, 200, { name: sprite.name, rev: sprite.rev });
  }

  if (sub === 'duplicate' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    if (ws.exists(body.to)) throw new HttpError(409, `Sprite "${body.to}" already exists`);
    const sprite = ws.load(name);
    sprite.name = body.to;
    ws.save(sprite, 'editor');
    return sendJson(res, 201, { name: sprite.name, rev: sprite.rev });
  }

  const sheetOpts = (): SheetOptions => ({
    layout: (url.searchParams.get('layout') as SheetLayout) || 'horizontal',
    columns: num(url.searchParams.get('columns')),
    padding: num(url.searchParams.get('padding')),
    margin: num(url.searchParams.get('margin')),
    scale: num(url.searchParams.get('scale')),
    tag: url.searchParams.get('tag') || undefined,
  });

  if (sub === 'sheet.png' && method === 'GET') {
    const { image } = buildSpritesheet(ws.load(name), sheetOpts());
    return sendBuffer(res, encodePng(image), 'image/png', url.searchParams.has('download') ? `${name}.png` : undefined);
  }
  if (sub === 'sheet.json' && method === 'GET') {
    const opts = sheetOpts();
    const { meta } = buildSpritesheet(ws.load(name), opts);
    const body = Buffer.from(JSON.stringify(meta, null, 2));
    return sendBuffer(res, body, 'application/json', url.searchParams.has('download') ? `${name}.json` : undefined);
  }
  if (sub === 'preview.png' && method === 'GET') {
    const frame = num(url.searchParams.get('frame'));
    const png = previewPng(ws.load(name), {
      frames: frame !== undefined ? [frame] : undefined,
      tag: url.searchParams.get('tag') || undefined,
      scale: num(url.searchParams.get('scale')),
      background: url.searchParams.get('background') || 'transparent',
    });
    return sendBuffer(res, png, 'image/png');
  }
  if (sub === 'export' && method === 'POST') {
    const body = (await readJson(req)) as SheetOptions & { byTag?: boolean };
    const sprite = ws.load(name);
    const results = [exportSpritesheet(ws, sprite, body)];
    if (body.byTag) for (const t of sprite.tags) results.push(exportSpritesheet(ws, sprite, { ...body, layout: body.layout === 'tags' ? 'horizontal' : body.layout, tag: t.name }));
    return sendJson(res, 200, { files: results });
  }

  throw new HttpError(404, 'Not found');
}

async function handleGame(ws: Workspace, req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const sub = parts[0];
  if (!sub) {
    if (method === 'GET') return sendJson(res, 200, { ...ws.loadGame(), saved: ws.hasGame() });
    if (method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown>;
      delete body.saved;
      const game = normalizeGame(body);
      const rev = ws.saveGame(game, 'editor');
      return sendJson(res, 200, { rev });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (sub === 'problems' && method === 'GET') return sendJson(res, 200, loadGameBundle(ws).problems);
  if ((sub === 'play.html' || sub === 'export.html') && method === 'GET') {
    const { bundle } = loadGameBundle(ws, { images: true });
    if (!Object.keys(bundle.scenes).length) throw new HttpError(409, 'The game has no scenes yet');
    const html = buildGameHtml(bundle, loadRuntime());
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (url.searchParams.has('download')) headers['content-disposition'] = `attachment; filename="${(bundle.game.title.replace(/[^A-Za-z0-9_-]+/g, '_') || 'game')}.html"`;
    res.writeHead(200, headers);
    res.end(html);
    return;
  }
  if (sub === 'export' && method === 'POST') return sendJson(res, 200, exportGame(ws));
  if (sub === 'objects' && parts[2] === 'rename' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    const game = ws.loadGame();
    const scenes = ws.listScenes().map((s) => ws.loadScene(s.name));
    const changed = renameObjectRefs(game, scenes, parts[1], body.to);
    ws.saveGame(game, 'editor');
    for (const s of changed) ws.saveScene(s, 'editor');
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}

async function handleScripts(ws: Workspace, req: http.IncomingMessage, res: http.ServerResponse, parts: string[]): Promise<void> {
  const method = req.method ?? 'GET';
  const name = parts[0];
  if (!name) {
    if (method === 'GET') return sendJson(res, 200, ws.listScripts());
    if (method === 'POST') {
      const body = (await readJson(req)) as { name: string; code?: string };
      if (ws.scriptExists(body.name)) throw new HttpError(409, `Script "${body.name}" already exists`);
      ws.writeScript(body.name, body.code ?? SCRIPT_TEMPLATE);
      return sendJson(res, 201, { name: body.name });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (name === '_info' && method === 'GET') return sendJson(res, 200, inspectScripts(ws.loadScripts()));
  if (name === '_reference' && method === 'GET') return sendJson(res, 200, { reference: SCRIPT_REFERENCE });
  const sub = parts[1];
  if (!sub) {
    if (method === 'GET') return sendJson(res, 200, { name, code: ws.readScript(name) });
    if (method === 'PUT') {
      const body = (await readJson(req)) as { code: string };
      if (typeof body.code !== 'string') throw new HttpError(400, 'Missing code');
      ws.writeScript(name, body.code);
      return sendJson(res, 200, { ok: true, syntaxError: checkScriptSyntax(body.code, `scripts/${name}.js`) });
    }
    if (method === 'DELETE') {
      ws.removeScript(name);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (sub === 'rename' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    if (ws.scriptExists(body.to)) throw new HttpError(409, `Script "${body.to}" already exists`);
    ws.writeScript(body.to, ws.readScript(name));
    ws.removeScript(name);
    return sendJson(res, 200, { name: body.to });
  }
  throw new HttpError(404, 'Not found');
}

async function handleScenes(ws: Workspace, req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const name = parts[0];
  if (!name) {
    if (method === 'GET') return sendJson(res, 200, ws.listScenes());
    if (method === 'POST') {
      const body = (await readJson(req)) as { name: string; cols?: number; rows?: number; tileSize?: number; tileset?: string };
      if (ws.sceneExists(body.name)) throw new HttpError(409, `Scene "${body.name}" already exists`);
      let tileSize = body.tileSize;
      if (body.tileset && ws.exists(body.tileset)) tileSize = ws.load(body.tileset).grid?.width ?? tileSize;
      const scene = createScene({ name: body.name, cols: body.cols, rows: body.rows, tileSize, tileset: body.tileset });
      ws.saveScene(scene, 'editor');
      const game = ws.loadGame();
      if (!game.startScene || !ws.sceneExists(game.startScene)) {
        game.startScene = scene.name;
        ws.saveGame(game, 'editor');
      }
      return sendJson(res, 201, { name: scene.name, rev: scene.rev });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  const sub = parts[1];
  if (!sub) {
    if (method === 'GET') return sendJson(res, 200, ws.loadScene(name));
    if (method === 'PUT') {
      const scene = normalizeScene(await readJson(req));
      if (scene.name !== name) throw new HttpError(400, 'Name mismatch');
      const rev = ws.saveScene(scene, 'editor');
      return sendJson(res, 200, { rev });
    }
    if (method === 'DELETE') {
      ws.removeScene(name);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (sub === 'rename' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    if (ws.sceneExists(body.to)) throw new HttpError(409, `Scene "${body.to}" already exists`);
    const scene = ws.loadScene(name);
    const game = ws.loadGame();
    const others = ws.listScenes().filter((s) => s.name !== name).map((s) => ws.loadScene(s.name));
    scene.name = body.to;
    const changed = renameSceneRefs(game, [scene, ...others], name, body.to);
    ws.saveScene(scene, 'editor');
    ws.removeScene(name);
    for (const s of changed) if (s !== scene) ws.saveScene(s, 'editor');
    if (ws.hasGame() || game.startScene === body.to) ws.saveGame(game, 'editor');
    return sendJson(res, 200, { name: body.to });
  }
  if (sub === 'duplicate' && method === 'POST') {
    const body = (await readJson(req)) as { to: string };
    if (ws.sceneExists(body.to)) throw new HttpError(409, `Scene "${body.to}" already exists`);
    const scene = ws.loadScene(name);
    scene.name = body.to;
    ws.saveScene(scene, 'editor');
    return sendJson(res, 201, { name: body.to });
  }
  if (sub === 'preview.png' && method === 'GET') {
    const { png } = renderScenePreview(loadGameBundle(ws), name, { scale: num(url.searchParams.get('scale')), grid: url.searchParams.has('grid') });
    return sendBuffer(res, png, 'image/png');
  }
  throw new HttpError(404, 'Not found');
}

function num(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(WEB_DIR, path.normalize(rel));
  if (!file.startsWith(WEB_DIR)) throw new HttpError(403, 'Forbidden');
  let target = file;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) target = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(target)) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Editor UI not built. Run `npm run build` in the Spritifer folder.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(target).pipe(res);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendBuffer(res: http.ServerResponse, buf: Buffer, type: string, downloadName?: string): void {
  const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-store' };
  if (downloadName) headers['content-disposition'] = `attachment; filename="${downloadName}"`;
  res.writeHead(200, headers);
  res.end(buf);
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
