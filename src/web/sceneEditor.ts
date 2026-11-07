/** Scene editor: paint tile layers, place and move instances, edit scene settings and events. */

import { type Instance, type Scene, type TileLayer, type Value, newGameId, normalizeScene, normalizeTags, resizeScene } from '../core/game/types.js';
import { renderEventSheet } from './eventSheet.js';
import { componentListCard, instanceComponents } from './componentsUi.js';
import { type LoadedAsset, gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { TEMPLATES, createFromTemplate, sheetContext } from './objectsView.js';
import { openPlay, registerFlusher } from './play.js';
import { clear, h, icon, iconButton, modal, promptText, toast } from './dom.js';
import { api } from './api.js';
import { drawPixelText, previewText, textSize } from './textPreview.js';

type Tool = 'paint' | 'rect' | 'fill' | 'erase' | 'place' | 'select';

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'paint', label: 'Paint tiles', icon: 'pencil', key: 'B' },
  { id: 'rect', label: 'Fill rectangle', icon: 'rect', key: 'R' },
  { id: 'fill', label: 'Bucket fill', icon: 'fill', key: 'G' },
  { id: 'erase', label: 'Erase tiles', icon: 'eraser', key: 'E' },
  { id: 'place', label: 'Place objects', icon: 'plus', key: 'P' },
  { id: 'select', label: 'Select / move objects', icon: 'move', key: 'V' },
];

interface Brush {
  w: number;
  h: number;
  tiles: number[];
}

export interface SceneEditorHandle {
  destroy(): void;
  remote(rev: string | null): Promise<void>;
  refreshAssets(): void;
}

export async function mountSceneEditor(root: HTMLElement, name: string, onBack: () => void): Promise<SceneEditorHandle> {
  await state.ensure();
  let scene = await gameApi.getScene(name);
  clear(root);
  document.title = `${name} · Spritifer`;

  // ---------------------------------------------------------------- state
  let tool: Tool = 'paint';
  let activeLayer = Math.max(0, scene.layers.findIndex((l) => l.solid));
  let brush: Brush = { w: 1, h: 1, tiles: [0] };
  let placeObject: string | null = state.game!.objects[0]?.name ?? null;
  let selectedId: string | null = null;
  let zoom = 2;
  let panX = 20;
  let panY = 20;
  let showGrid = true;
  let dimOthers = false;
  let hover: { x: number; y: number } | null = null;
  let tileset: LoadedAsset | undefined;
  /** Loaded sprites by sprite name (object sprites and per-instance overrides). */
  const assets = new Map<string, LoadedAsset>();
  const spriteOf = (i: Instance) => i.sprite ?? state.object(i.object)?.sprite;
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  let saveTimer = 0;
  let dirty = false;
  let lastRev = scene.rev;

  const ts = () => scene.tileSize;
  const layer = (): TileLayer | undefined => scene.layers[activeLayer];

  // ---------------------------------------------------------------- persistence
  const saveLabel = h('span', { class: 'save-label' }, 'Saved');
  const snapshot = () => {
    undoStack.push(JSON.stringify(scene));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  };
  const changed = () => {
    dirty = true;
    saveLabel.textContent = 'Unsaved';
    saveLabel.dataset.state = 'dirty';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void flush(), 400);
    draw();
  };
  const flush = async () => {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    saveLabel.textContent = 'Saving…';
    saveLabel.dataset.state = 'saving';
    try {
      const { rev } = await gameApi.saveScene(scene);
      scene.rev = rev;
      lastRev = rev;
      saveLabel.textContent = 'Saved';
      saveLabel.dataset.state = '';
    } catch (err) {
      dirty = true;
      saveLabel.textContent = 'Save failed';
      saveLabel.dataset.state = 'error';
      toast((err as Error).message, 'error');
    }
  };
  const unregister = registerFlusher(flush);
  const undo = () => {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(JSON.stringify(scene));
    scene = normalizeScene(JSON.parse(s));
    activeLayer = Math.min(activeLayer, scene.layers.length - 1);
    changed();
    renderSide();
  };
  const redo = () => {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(JSON.stringify(scene));
    scene = normalizeScene(JSON.parse(s));
    changed();
    renderSide();
  };

  // ---------------------------------------------------------------- assets
  const loadAssets = async () => {
    tileset = scene.tileset ? await state.asset(scene.tileset) : undefined;
    assets.clear();
    const names = new Set<string>();
    for (const o of state.game!.objects) if (o.sprite) names.add(o.sprite);
    for (const i of scene.instances) if (i.sprite) names.add(i.sprite);
    await Promise.all(
      [...names].map(async (n) => {
        const a = await state.asset(n);
        if (a) assets.set(n, a);
      }),
    );
    draw();
    renderPalette();
    renderRight();
  };

  // ---------------------------------------------------------------- layout
  const canvas = h('canvas', { class: 'scene-canvas' });
  const wrap = h('div', { class: 'scene-canvas-wrap' }, canvas);
  const status = h('div', { class: 'statusbar' });
  const zoomLabel = h('span', { class: 'zoom-label' });
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  const toolbar = h('div', { class: 'toolbar' },
    ...TOOLS.map((t) => {
      const b = h('button', { class: 'tool-btn', title: `${t.label} (${t.key})`, onclick: () => setTool(t.id) }, icon(t.icon));
      toolBtns.set(t.id, b);
      return b;
    }),
  );
  const leftSide = h('aside', { class: 'scene-left' });
  const rightSide = h('aside', { class: 'sidebar scene-right' });
  const gridBtn = iconButton('grid', 'Toggle grid (#)', () => { showGrid = !showGrid; gridBtn.classList.toggle('active', showGrid); draw(); });
  gridBtn.classList.toggle('active', showGrid);
  const dimBtn = iconButton('eye', 'Dim other layers', () => { dimOthers = !dimOthers; dimBtn.classList.toggle('active', dimOthers); draw(); });
  const nameBtn = h('button', { class: 'sprite-name', title: 'Rename scene', onclick: async () => {
    const to = await promptText('Rename scene', 'New name', scene.name);
    if (!to || to === scene.name) return;
    await flush();
    try {
      await state.flush();
      await gameApi.renameScene(scene.name, to);
      await state.load();
      location.hash = `#/scene/${encodeURIComponent(to)}`;
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  } }, scene.name);

  root.append(h('div', { class: 'editor scene-editor' },
    h('header', { class: 'topbar' },
      iconButton('back', 'Back to scenes', async () => { await flush(); onBack(); }),
      h('span', { class: 'logo small' }),
      nameBtn,
      h('span', { class: 'sep' }),
      iconButton('undo', 'Undo (Ctrl+Z)', undo),
      iconButton('redo', 'Redo (Ctrl+Shift+Z)', redo),
      h('span', { class: 'sep' }),
      iconButton('minus', 'Zoom out', () => setZoom(zoom / 1.5)),
      zoomLabel,
      iconButton('plus', 'Zoom in', () => setZoom(zoom * 1.5)),
      iconButton('fit', 'Fit scene', () => fit()),
      gridBtn,
      dimBtn,
      h('span', { class: 'sep' }),
      h('button', { class: 'small', onclick: () => void openEvents() }, icon('tag', 14), 'Scene events'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'status-pill' }, saveLabel),
      h('button', { class: 'small', title: 'Play starting from this scene', onclick: () => void openPlay(scene.name) }, icon('play', 13), 'Play scene'),
      h('button', { class: 'primary small', title: 'Play the game from its start scene', onclick: () => void openPlay() }, icon('play', 13), 'Play game'),
    ),
    h('div', { class: 'workspace scene-workspace' }, toolbar, leftSide, h('div', { class: 'center' }, wrap, status), rightSide),
  ));

  // ---------------------------------------------------------------- drawing
  const ctx = canvas.getContext('2d')!;
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    draw();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  const tileSrc = (t: number): [number, number, number, number] | null => {
    if (!tileset || !tileset.frames.length) return null;
    const g = tileset.grid ?? { width: ts(), height: ts() };
    const cols = Math.max(1, Math.floor(tileset.width / g.width));
    const f0 = tileset.frames[0];
    return [f0.x + (t % cols) * g.width, f0.y + Math.floor(t / cols) * g.height, g.width, g.height];
  };

  const instanceFrame = (i: Instance) => {
    const spr = spriteOf(i);
    const a = spr ? assets.get(spr) : undefined;
    if (!a || !a.frames.length) return null;
    const obj = state.object(i.object);
    const tag = a.tags.find((t) => t.name === (i.animation ?? obj?.animation));
    return { a, f: a.frames[tag?.from ?? 0] ?? a.frames[0] };
  };

  const instanceBox = (i: Instance) => {
    const fr = instanceFrame(i);
    if (fr) return { x: i.x, y: i.y, w: fr.a.width, h: fr.a.height };
    const obj = state.object(i.object);
    if (obj?.text !== undefined) {
      const sz = textSize(previewText(obj.text, obj, scene.variables).text || ' ', obj.textSize ?? 1);
      return { x: i.x, y: i.y, w: sz.w, h: sz.h };
    }
    return { x: i.x, y: i.y, w: ts(), h: ts() };
  };

  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const W = scene.cols * ts();
    const H = scene.rows * ts();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#101217';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = scene.background || state.game!.background;
    ctx.fillRect(0, 0, W, H);

    // Tile layers and instances in z order (layers default below objects).
    type Item = { z: number; o: number; d: () => void };
    const items: Item[] = [];
    scene.layers.forEach((l, li) => {
      if (!l.visible) return;
      items.push({ z: l.z ?? li - 10, o: li, d: () => {
        if (!tileset) return;
        ctx.globalAlpha = dimOthers && li !== activeLayer ? 0.3 : 1;
        for (let ty = 0; ty < scene.rows; ty++) {
          for (let tx = 0; tx < scene.cols; tx++) {
            const t = l.tiles[ty * scene.cols + tx];
            if (t < 0) continue;
            const s = tileSrc(t);
            if (s) ctx.drawImage(tileset.img, s[0], s[1], s[2], s[3], tx * ts(), ty * ts(), ts(), ts());
          }
        }
        ctx.globalAlpha = 1;
      } });
    });
    scene.instances.forEach((inst, k) => {
      const obj = state.object(inst.object);
      const sortKey = scene.ySort ? 1000 + (() => { const b = instanceBox(inst); return b.y + b.h; })() + k / 10000 : 1000 + k;
      items.push({ z: obj?.z ?? 0, o: sortKey, d: () => {
        const fr = instanceFrame(inst);
        ctx.globalAlpha = dimOthers ? 0.5 : 1;
        if (fr) {
          if (inst.flipX) {
            ctx.save();
            ctx.translate(inst.x + fr.f.w, inst.y);
            ctx.scale(-1, 1);
            ctx.drawImage(fr.a.img, fr.f.x, fr.f.y, fr.f.w, fr.f.h, 0, 0, fr.f.w, fr.f.h);
            ctx.restore();
          } else ctx.drawImage(fr.a.img, fr.f.x, fr.f.y, fr.f.w, fr.f.h, inst.x, inst.y, fr.f.w, fr.f.h);
        } else if (obj?.text !== undefined) {
          const r = previewText(obj.text, obj, scene.variables);
          if (r.error) {
            ctx.fillStyle = '#e43b4466';
            ctx.fillRect(inst.x, inst.y, 24, 6);
          } else drawPixelText(ctx, r.text, inst.x, inst.y, obj.textColor ?? '#ffffff', obj.textSize ?? 1);
        } else {
          const b = instanceBox(inst);
          ctx.fillStyle = obj ? (obj.text !== undefined ? '#ffffff22' : '#feae3455') : '#e43b4466';
          ctx.fillRect(b.x, b.y, b.w, b.h);
          ctx.fillStyle = '#fff';
          ctx.font = '6px monospace';
          ctx.fillText(obj?.text !== undefined ? 'Aa' : inst.object.slice(0, 6), b.x + 1, b.y + 6);
        }
        ctx.globalAlpha = 1;
      } });
    });
    items.sort((a, b) => a.z - b.z || a.o - b.o);
    for (const it of items) it.d();

    // Screen-space overlays.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = (x: number) => Math.round(panX + x * zoom) + 0.5;
    const sy = (y: number) => Math.round(panY + y * zoom) + 0.5;
    if (showGrid && ts() * zoom >= 6) {
      ctx.strokeStyle = '#ffffff1c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= scene.cols; x++) { ctx.moveTo(sx(x * ts()), sy(0)); ctx.lineTo(sx(x * ts()), sy(H)); }
      for (let y = 0; y <= scene.rows; y++) { ctx.moveTo(sx(0), sy(y * ts())); ctx.lineTo(sx(W), sy(y * ts())); }
      ctx.stroke();
    }
    // Scene border and the size of one screen.
    ctx.strokeStyle = '#ffffff55';
    ctx.strokeRect(sx(0), sy(0), W * zoom, H * zoom);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#feae3488';
    ctx.strokeRect(sx(0), sy(Math.max(0, H - state.game!.height)), state.game!.width * zoom, state.game!.height * zoom);
    ctx.setLineDash([]);

    // Selection.
    const sel = scene.instances.find((i) => i.id === selectedId);
    if (sel) {
      const b = instanceBox(sel);
      ctx.strokeStyle = '#feae34';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(b.x) - 1, sy(b.y) - 1, b.w * zoom + 1, b.h * zoom + 1);
      ctx.lineWidth = 1;
    }
    // Hover / brush ghost.
    if (hover) {
      if (tool === 'paint' || tool === 'rect' || tool === 'fill' || tool === 'erase') {
        const bw = tool === 'paint' ? brush.w : 1;
        const bh = tool === 'paint' ? brush.h : 1;
        if (tool === 'paint' && tileset) {
          ctx.globalAlpha = 0.6;
          ctx.imageSmoothingEnabled = false;
          for (let y = 0; y < brush.h; y++) for (let x = 0; x < brush.w; x++) {
            const s = tileSrc(brush.tiles[y * brush.w + x]);
            if (s) ctx.drawImage(tileset.img, s[0], s[1], s[2], s[3], panX + (hover.x + x) * ts() * zoom, panY + (hover.y + y) * ts() * zoom, ts() * zoom, ts() * zoom);
          }
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = tool === 'erase' ? '#e43b44' : '#feae34';
        ctx.strokeRect(sx(hover.x * ts()), sy(hover.y * ts()), bw * ts() * zoom, bh * ts() * zoom);
      }
      if (rectDrag) {
        const x0 = Math.min(rectDrag.x0, rectDrag.x1);
        const y0 = Math.min(rectDrag.y0, rectDrag.y1);
        const w = Math.abs(rectDrag.x1 - rectDrag.x0) + 1;
        const hh = Math.abs(rectDrag.y1 - rectDrag.y0) + 1;
        ctx.fillStyle = rectDrag.erase ? '#e43b4433' : '#feae3433';
        ctx.fillRect(sx(x0 * ts()), sy(y0 * ts()), w * ts() * zoom, hh * ts() * zoom);
      }
    }
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  // ---------------------------------------------------------------- view
  const setZoom = (z: number, cx?: number, cy?: number) => {
    const r = wrap.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const nz = Math.max(0.25, Math.min(16, z));
    const wx = (px - panX) / zoom;
    const wy = (py - panY) / zoom;
    zoom = nz;
    panX = px - wx * zoom;
    panY = py - wy * zoom;
    draw();
  };
  /** Initial view: the scene height fills the view (long levels stay readable), left-aligned. */
  const fitHeight = () => {
    const r = wrap.getBoundingClientRect();
    const W = scene.cols * ts();
    const H = scene.rows * ts();
    zoom = Math.max(0.25, Math.min(6, (r.height - 40) / H, W <= r.width ? (r.width - 40) / W : Infinity));
    if (zoom > 1) zoom = Math.floor(zoom);
    panX = W * zoom < r.width ? Math.round((r.width - W * zoom) / 2) : 20;
    panY = Math.round((r.height - H * zoom) / 2);
    draw();
  };
  const fit = () => {
    const r = wrap.getBoundingClientRect();
    const W = scene.cols * ts();
    const H = scene.rows * ts();
    zoom = Math.max(0.25, Math.min(8, Math.min((r.width - 40) / W, (r.height - 40) / H)));
    if (zoom > 1) zoom = Math.floor(zoom);
    panX = Math.round((r.width - W * zoom) / 2);
    panY = Math.round((r.height - H * zoom) / 2);
    draw();
  };

  const setTool = (t: Tool) => {
    tool = t;
    for (const [id, b] of toolBtns) b.classList.toggle('active', id === t);
    canvas.style.cursor = t === 'select' ? 'default' : t === 'place' ? 'copy' : 'crosshair';
    draw();
  };

  // ---------------------------------------------------------------- editing helpers
  const world = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
  };
  const tileAt = (wx: number, wy: number) => ({ x: Math.floor(wx / ts()), y: Math.floor(wy / ts()) });
  const setTile = (tx: number, ty: number, t: number): boolean => {
    const l = layer();
    if (!l || tx < 0 || ty < 0 || tx >= scene.cols || ty >= scene.rows) return false;
    const k = ty * scene.cols + tx;
    if (l.tiles[k] === t) return false;
    l.tiles[k] = t;
    return true;
  };
  const stamp = (tx: number, ty: number) => {
    let any = false;
    for (let y = 0; y < brush.h; y++) for (let x = 0; x < brush.w; x++) any = setTile(tx + x, ty + y, brush.tiles[y * brush.w + x]) || any;
    return any;
  };
  const bucket = (tx: number, ty: number, t: number) => {
    const l = layer();
    if (!l || tx < 0 || ty < 0 || tx >= scene.cols || ty >= scene.rows) return;
    const from = l.tiles[ty * scene.cols + tx];
    if (from === t) return;
    const stack = [[tx, ty]];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
      const [x, y] = stack.pop()!;
      if (x < 0 || y < 0 || x >= scene.cols || y >= scene.rows || l.tiles[y * scene.cols + x] !== from) continue;
      l.tiles[y * scene.cols + x] = t;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  };
  const hitInstance = (wx: number, wy: number): Instance | undefined => {
    for (let i = scene.instances.length - 1; i >= 0; i--) {
      const inst = scene.instances[i];
      const b = instanceBox(inst);
      if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h) return inst;
    }
    return undefined;
  };
  const placeAt = (wx: number, wy: number, free: boolean) => {
    if (!placeObject) return toast('Pick an object type on the right first', 'error');
    const po = state.object(placeObject);
    const a = po?.sprite ? assets.get(po.sprite) : undefined;
    const w = a?.width ?? ts();
    const hh = a?.height ?? ts();
    let x: number;
    let y: number;
    if (free) {
      x = Math.round(wx - w / 2);
      y = Math.round(wy - hh / 2);
    } else {
      // Stand on the bottom of the hovered tile, centered.
      const t = tileAt(wx, wy);
      x = Math.round(t.x * ts() + (ts() - w) / 2);
      y = (t.y + 1) * ts() - hh;
    }
    snapshot();
    const inst: Instance = { id: newGameId(), object: placeObject, x, y };
    scene.instances.push(inst);
    selectedId = inst.id;
    changed();
    renderInspector();
  };

  // ---------------------------------------------------------------- pointer
  let painting = false;
  let lastTile: { x: number; y: number } | null = null;
  /** Paints (or erases) every tile on the line from the previous pointer position, so fast drags leave no gaps. */
  const strokeTo = (t: { x: number; y: number }, erase: boolean): boolean => {
    const from = lastTile ?? t;
    let any = false;
    const n = Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y), 1);
    for (let i = lastTile ? 1 : 0; i <= n; i++) {
      const x = Math.round(from.x + ((t.x - from.x) * i) / n);
      const y = Math.round(from.y + ((t.y - from.y) * i) / n);
      any = (erase ? setTile(x, y, -1) : stamp(x, y)) || any;
    }
    lastTile = t;
    return any;
  };
  let panning: { x: number; y: number; px: number; py: number } | null = null;
  let dragInst: { inst: Instance; ox: number; oy: number; sx: number; sy: number; moved: boolean } | null = null;
  let rectDrag: { x0: number; y0: number; x1: number; y1: number; erase: boolean } | null = null;
  let spaceDown = false;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = world(e);
    const t = tileAt(p.x, p.y);
    if (e.button === 1 || spaceDown || (e.button === 2 && (tool === 'select' || tool === 'place'))) {
      panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      return;
    }
    if (e.altKey && (tool === 'paint' || tool === 'rect' || tool === 'fill')) {
      // Pick the tile under the cursor.
      const l = layer();
      const v = l?.tiles[t.y * scene.cols + t.x];
      if (v !== undefined && v >= 0) {
        brush = { w: 1, h: 1, tiles: [v] };
        renderPalette();
      }
      return;
    }
    const erase = tool === 'erase' || e.button === 2;
    if (tool === 'paint' || tool === 'erase') {
      snapshot();
      painting = true;
      lastTile = null;
      if (strokeTo(t, erase)) changed();
      return;
    }
    if (tool === 'rect') {
      snapshot();
      rectDrag = { x0: t.x, y0: t.y, x1: t.x, y1: t.y, erase };
      draw();
      return;
    }
    if (tool === 'fill') {
      snapshot();
      bucket(t.x, t.y, erase ? -1 : brush.tiles[0]);
      changed();
      return;
    }
    if (tool === 'place') {
      placeAt(p.x, p.y, e.altKey);
      return;
    }
    if (tool === 'select') {
      const hit = hitInstance(p.x, p.y);
      selectedId = hit?.id ?? null;
      if (hit) dragInst = { inst: hit, ox: hit.x, oy: hit.y, sx: p.x, sy: p.y, moved: false };
      renderInspector();
      draw();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = world(e);
    const t = tileAt(p.x, p.y);
    hover = t;
    status.textContent = `tile ${t.x}, ${t.y} · px ${Math.floor(p.x)}, ${Math.floor(p.y)}${layer() ? ` · layer ${layer()!.name}${layer()!.solid ? ' (solid)' : ''}` : ''}`;
    if (panning) {
      panX = panning.px + e.clientX - panning.x;
      panY = panning.py + e.clientY - panning.y;
      draw();
      return;
    }
    if (painting) {
      const erase = tool === 'erase' || (e.buttons & 2) !== 0;
      if (strokeTo(t, erase)) changed();
      else draw();
      return;
    }
    if (rectDrag) {
      rectDrag.x1 = t.x;
      rectDrag.y1 = t.y;
      draw();
      return;
    }
    if (dragInst) {
      let dx = p.x - dragInst.sx;
      let dy = p.y - dragInst.sy;
      if (!e.altKey) {
        dx = Math.round(dx / ts()) * ts();
        dy = Math.round(dy / ts()) * ts();
      }
      const nx = Math.round(dragInst.ox + dx);
      const ny = Math.round(dragInst.oy + dy);
      if (nx !== dragInst.inst.x || ny !== dragInst.inst.y) {
        if (!dragInst.moved) snapshot();
        dragInst.moved = true;
        dragInst.inst.x = nx;
        dragInst.inst.y = ny;
        changed();
        renderInspector();
      }
      return;
    }
    draw();
  });
  const endPointer = () => {
    if (rectDrag) {
      const x0 = Math.min(rectDrag.x0, rectDrag.x1);
      const y0 = Math.min(rectDrag.y0, rectDrag.y1);
      const x1 = Math.max(rectDrag.x0, rectDrag.x1);
      const y1 = Math.max(rectDrag.y0, rectDrag.y1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setTile(x, y, rectDrag.erase ? -1 : brush.tiles[((y - y0) % brush.h) * brush.w + ((x - x0) % brush.w)]);
      rectDrag = null;
      changed();
    }
    painting = false;
    lastTile = null;
    panning = null;
    dragInst = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    // Pinch / Ctrl+wheel zooms; plain wheel pans (Shift = sideways).
    if (e.ctrlKey || e.metaKey) {
      setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    } else {
      panX -= e.shiftKey ? e.deltaY : e.deltaX;
      panY -= e.shiftKey ? 0 : e.deltaY;
      draw();
    }
  }, { passive: false });

  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, .modal')) return;
    if (e.code === 'Space') {
      spaceDown = e.type === 'keydown';
      e.preventDefault();
      return;
    }
    if (e.type !== 'keydown') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    const sel = scene.instances.find((i) => i.id === selectedId);
    if (sel && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      snapshot();
      scene.instances = scene.instances.filter((i) => i !== sel);
      selectedId = null;
      changed();
      renderInspector();
      return;
    }
    if (sel && mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      snapshot();
      const copy: Instance = { ...JSON.parse(JSON.stringify(sel)), id: newGameId(), x: sel.x + ts() };
      scene.instances.push(copy);
      selectedId = copy.id;
      changed();
      renderInspector();
      return;
    }
    if (sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? ts() : 1;
      snapshot();
      if (e.key === 'ArrowLeft') sel.x -= step;
      if (e.key === 'ArrowRight') sel.x += step;
      if (e.key === 'ArrowUp') sel.y -= step;
      if (e.key === 'ArrowDown') sel.y += step;
      changed();
      renderInspector();
      return;
    }
    if (mod) return;
    const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.id);
    if (e.key === '#') {
      showGrid = !showGrid;
      draw();
    }
    if (e.key === 'Escape') {
      selectedId = null;
      renderInspector();
      draw();
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);

  // ---------------------------------------------------------------- left side: layers + tileset palette
  const layersBox = h('div', { class: 'panel' });
  const paletteBox = h('div', { class: 'panel grow palette-panel' });
  leftSide.append(layersBox, paletteBox);

  function renderLayers(): void {
    clear(layersBox);
    layersBox.append(h('div', { class: 'panel-title' }, 'Tile layers', h('span', { class: 'spacer' }),
      iconButton('plus', 'Add layer', async () => {
        const n = await promptText('New tile layer', 'Name (e.g. decor, foreground)', `layer${scene.layers.length + 1}`);
        if (!n) return;
        snapshot();
        scene.layers.push({ name: n, tiles: new Array(scene.cols * scene.rows).fill(-1), solid: false, visible: true });
        activeLayer = scene.layers.length - 1;
        changed();
        renderLayers();
      }, { class: 'icon-btn tiny' })));
    const list = h('div', { class: 'layer-list' });
    // Top layer first, like the sprite editor.
    [...scene.layers].map((l, i) => ({ l, i })).reverse().forEach(({ l, i }) => {
      list.append(h('div', { class: `layer-row${i === activeLayer ? ' active' : ''}`, onclick: () => { activeLayer = i; renderLayers(); draw(); } },
        iconButton(l.visible ? 'eye' : 'eyeoff', l.visible ? 'Hide' : 'Show', (e) => { e.stopPropagation(); l.visible = !l.visible; changed(); renderLayers(); }, { class: 'icon-btn tiny' }),
        h('span', { class: 'layer-name', ondblclick: async () => {
          const n = await promptText('Rename layer', 'Name', l.name);
          if (n) { snapshot(); l.name = n; changed(); renderLayers(); }
        } }, l.name),
        h('button', { class: `chip solid-chip${l.solid ? ' on' : ''}`, title: 'Solid layers block movement (floors, walls)', onclick: (e: Event) => { e.stopPropagation(); snapshot(); l.solid = !l.solid; changed(); renderLayers(); } }, l.solid ? 'solid' : 'decor'),
      ));
    });
    layersBox.append(list,
      h('div', { class: 'panel-actions' },
        iconButton('up', 'Move layer up (drawn later)', () => { if (activeLayer < scene.layers.length - 1) { snapshot(); const [l] = scene.layers.splice(activeLayer, 1); scene.layers.splice(++activeLayer, 0, l); changed(); renderLayers(); } }, { class: 'icon-btn tiny' }),
        iconButton('down', 'Move layer down', () => { if (activeLayer > 0) { snapshot(); const [l] = scene.layers.splice(activeLayer, 1); scene.layers.splice(--activeLayer, 0, l); changed(); renderLayers(); } }, { class: 'icon-btn tiny' }),
        h('label', { class: 'inline small', title: 'Draw order: layers with z above 0 are drawn in front of objects' }, 'z',
          h('input', { type: 'number', class: 'num tiny-num', value: String(layer()?.z ?? activeLayer - 10), onchange: (e: Event) => { const l = layer(); if (!l) return; snapshot(); l.z = Number((e.target as HTMLInputElement).value); changed(); } })),
        h('span', { class: 'spacer' }),
        iconButton('trash', 'Delete layer', () => { if (scene.layers.length <= 1) return toast('A scene needs at least one layer', 'error'); snapshot(); scene.layers.splice(activeLayer, 1); activeLayer = Math.max(0, activeLayer - 1); changed(); renderLayers(); }, { class: 'icon-btn tiny' }),
      ),
    );
  }

  function renderPalette(): void {
    clear(paletteBox);
    const tilesets = state.sprites.filter((s) => s.grid);
    const tsSel = h('select', { onchange: async () => {
      snapshot();
      if (tsSel.value) {
        scene.tileset = tsSel.value;
        scene.tileSize = state.sprite(tsSel.value)?.grid?.width ?? scene.tileSize;
      } else delete scene.tileset;
      changed();
      await loadAssets();
    } }, h('option', { value: '' }, '— no tileset —'), ...tilesets.map((s) => h('option', { value: s.name, selected: s.name === scene.tileset }, s.name)));
    paletteBox.append(h('div', { class: 'panel-title' }, 'Tileset', h('span', { class: 'spacer' }), tsSel));
    if (!tileset) {
      paletteBox.append(h('p', { class: 'muted small' }, tilesets.length ? 'Pick a tileset sprite above.' : 'Create a sprite with a tile grid (Sprites → New sprite → Tile grid 16) and draw your tiles in it.'));
      return;
    }
    const g = tileset.grid ?? { width: ts(), height: ts() };
    const cols = Math.max(1, Math.floor(tileset.width / g.width));
    const rows = Math.max(1, Math.floor(tileset.height / g.height));
    const scale = Math.max(1, Math.min(4, Math.floor(200 / (cols * g.width))));
    const pc = h('canvas', { class: 'palette-canvas', width: cols * g.width * scale, height: rows * g.height * scale });
    const pctx = pc.getContext('2d')!;
    const redraw = () => {
      pctx.imageSmoothingEnabled = false;
      pctx.clearRect(0, 0, pc.width, pc.height);
      const f0 = tileset!.frames[0];
      pctx.drawImage(tileset!.img, f0.x, f0.y, cols * g.width, rows * g.height, 0, 0, pc.width, pc.height);
      pctx.strokeStyle = '#ffffff22';
      for (let x = 0; x <= cols; x++) pctx.strokeRect(x * g.width * scale + 0.5, 0, 0, pc.height);
      for (let y = 0; y <= rows; y++) pctx.strokeRect(0, y * g.height * scale + 0.5, pc.width, 0);
      const t0 = brush.tiles[0];
      const bx = t0 % cols;
      const by = Math.floor(t0 / cols);
      pctx.strokeStyle = '#feae34';
      pctx.lineWidth = 2;
      pctx.strokeRect(bx * g.width * scale + 1, by * g.height * scale + 1, brush.w * g.width * scale - 2, brush.h * g.height * scale - 2);
      pctx.lineWidth = 1;
    };
    let sel: { x0: number; y0: number } | null = null;
    const cellAt = (e: PointerEvent) => {
      const r = pc.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(cols - 1, Math.floor(((e.clientX - r.left) / r.width) * cols))),
        y: Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - r.top) / r.height) * rows))),
      };
    };
    const setBrush = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const x0 = Math.min(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const w = Math.abs(a.x - b.x) + 1;
      const hh = Math.abs(a.y - b.y) + 1;
      const tiles: number[] = [];
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) tiles.push((y0 + y) * cols + x0 + x);
      brush = { w, h: hh, tiles };
      info.textContent = w * hh > 1 ? `${w}×${hh} tiles (stamp)` : `tile #${tiles[0]}`;
      redraw();
    };
    pc.addEventListener('pointerdown', (e) => {
      pc.setPointerCapture(e.pointerId);
      const c = cellAt(e);
      sel = { x0: c.x, y0: c.y };
      setBrush(c, c);
      if (tool !== 'paint' && tool !== 'rect' && tool !== 'fill') setTool('paint');
    });
    pc.addEventListener('pointermove', (e) => {
      if (sel) setBrush({ x: sel.x0, y: sel.y0 }, cellAt(e));
    });
    pc.addEventListener('pointerup', () => (sel = null));
    const info = h('div', { class: 'muted small' }, brush.w * brush.h > 1 ? `${brush.w}×${brush.h} tiles` : `tile #${brush.tiles[0]}`);
    paletteBox.append(h('div', { class: 'palette-scroll checker' }, pc), info,
      h('p', { class: 'muted small' }, 'Drag over several tiles to paint them as a stamp. Alt+click on the map picks a tile; right-drag erases.'),
      h('a', { class: 'small', href: `#/edit/${encodeURIComponent(tileset.name)}` }, 'Edit tileset sprite →'));
    redraw();
  }

  // ---------------------------------------------------------------- right side: hierarchy / objects / scene tabs + inspector
  type RightTab = 'hierarchy' | 'objects' | 'scene';
  let rightTab: RightTab = 'hierarchy';
  let filter = '';
  const tabsBar = h('div', { class: 'right-tabs' });
  const hierarchyBox = h('div', { class: 'panel hierarchy' });
  const objectsBox = h('div', { class: 'panel' });
  const inspectorBox = h('div', { class: 'panel' });
  const settingsBox = h('div', { class: 'panel' });
  const tabBody = h('div', { class: 'right-tab-body' });
  rightSide.append(tabsBar, tabBody, inspectorBox);

  function renderRight(): void {
    clear(tabsBar);
    const tabs: [RightTab, string][] = [['hierarchy', `Hierarchy (${scene.instances.length})`], ['objects', 'Add'], ['scene', 'Scene']];
    for (const [id, label] of tabs) tabsBar.append(h('button', { class: `right-tab${rightTab === id ? ' active' : ''}`, onclick: () => { rightTab = id; renderRight(); } }, label));
    clear(tabBody);
    if (rightTab === 'hierarchy') {
      renderHierarchy();
      tabBody.append(hierarchyBox);
    } else if (rightTab === 'objects') {
      renderObjectList();
      tabBody.append(objectsBox);
    } else {
      renderSettings();
      tabBody.append(settingsBox);
    }
  }

  /** Brings an instance into view (when it is outside the canvas). */
  const reveal = (inst: Instance) => {
    const r = wrap.getBoundingClientRect();
    const b = instanceBox(inst);
    const sx = panX + b.x * zoom;
    const sy = panY + b.y * zoom;
    if (sx < 20 || sy < 20 || sx + b.w * zoom > r.width - 20 || sy + b.h * zoom > r.height - 20) {
      panX = Math.round(r.width / 2 - (b.x + b.w / 2) * zoom);
      panY = Math.round(r.height / 2 - (b.y + b.h / 2) * zoom);
    }
  };

  function select(id: string | null, focus = false): void {
    selectedId = id;
    const inst = scene.instances.find((i) => i.id === id);
    if (inst && focus) reveal(inst);
    if (rightTab === 'hierarchy') renderHierarchy();
    renderInspector();
    draw();
  }

  function renderHierarchy(): void {
    clear(hierarchyBox);
    const search = h('input', { type: 'text', placeholder: 'Filter by name or type…', value: filter, class: 'hier-search', oninput: () => { filter = search.value; renderRows(); } });
    const rows = h('div', { class: 'hier-list' });
    const renderRows = () => {
      clear(rows);
      const f = filter.trim().toLowerCase();
      const list = scene.instances.filter((i) => !f || (i.name ?? '').toLowerCase().includes(f) || i.object.toLowerCase().includes(f) || String(i.props?.dialogue ?? '').toLowerCase().includes(f));
      if (!list.length) rows.append(h('p', { class: 'muted small' }, scene.instances.length ? 'Nothing matches.' : 'No instances yet: place objects from the “Add” tab.'));
      for (const inst of list) {
        const spr = state.sprite(spriteOf(inst));
        const obj = state.object(inst.object);
        const talk = inst.props?.dialogue;
        rows.append(h('div', {
          class: `hier-row${inst.id === selectedId ? ' active' : ''}`,
          title: `${inst.object} at ${inst.x}, ${inst.y}`,
          onclick: () => select(inst.id, true),
        },
          h('span', { class: 'hier-thumb' }, spr ? h('img', { src: api.previewUrl(spr.name, spr.rev, 1), alt: '' }) : h('span', { class: 'txt-badge' }, obj?.text !== undefined ? 'Aa' : '?')),
          h('span', { class: 'hier-name' }, inst.name ?? inst.object),
          inst.name ? h('span', { class: 'hier-type muted' }, inst.object) : null,
          talk ? h('span', { class: 'hier-talk', title: `Dialogue: ${talk}` }, '💬') : null,
          obj ? null : h('span', { class: 'danger-text small' }, '?'),
        ));
      }
    };
    renderRows();
    hierarchyBox.append(search, rows);
    hierarchyBox.querySelector('.hier-row.active')?.scrollIntoView({ block: 'nearest' });
  }

  function renderObjectList(): void {
    clear(objectsBox);
    const g = state.game!;
    objectsBox.append(h('div', { class: 'panel-title' }, 'Objects', h('span', { class: 'spacer' }),
      h('select', { class: 'tpl-select', title: 'New object type from a template', onchange: async (e: Event) => {
        const sel = e.target as HTMLSelectElement;
        const t = TEMPLATES.find((x) => x.id === sel.value);
        sel.value = '';
        if (!t) return;
        const n = await promptText(`New ${t.label.toLowerCase()}`, 'Object name', t.id === 'platformer' || t.id === 'topdown' ? 'player' : t.id === 'pickup' ? 'coin' : t.id);
        if (!n) return;
        if (state.object(n)) return toast(`"${n}" already exists`, 'error');
        const guess = state.sprites.find((s) => s.name.toLowerCase().includes(n.toLowerCase()))?.name;
        createFromTemplate(t, n, guess);
        placeObject = n;
        setTool('place');
        await loadAssets();
      } }, h('option', { value: '' }, '+ New…'), ...TEMPLATES.map((t) => h('option', { value: t.id }, t.label)))));
    if (!g.objects.length) objectsBox.append(h('p', { class: 'muted small' }, 'No object types yet. Create one with “+ New…” (player, coin, enemy…).'));
    const grid = h('div', { class: 'obj-palette' });
    for (const o of g.objects) {
      const s = state.sprite(o.sprite);
      grid.append(h('button', { class: `obj-pick${placeObject === o.name ? ' active' : ''}`, title: `Place ${o.name} (P)`, onclick: () => { placeObject = o.name; setTool('place'); renderObjectList(); } },
        h('span', { class: 'obj-thumb checker' }, s ? h('img', { src: api.previewUrl(s.name, s.rev, 2), alt: '' }) : h('span', { class: 'txt-badge' }, o.text !== undefined ? 'Aa' : '?')),
        h('span', { class: 'obj-pick-name' }, o.name),
      ));
    }
    objectsBox.append(grid);
  }

  function renderInspector(): void {
    // Keep the hierarchy's highlight and count in sync with the selection.
    if (rightTab === 'hierarchy' && !hierarchyBox.contains(document.activeElement)) renderRight();
    clear(inspectorBox);
    const inst = scene.instances.find((i) => i.id === selectedId);
    inspectorBox.append(h('div', { class: 'panel-title' }, 'Inspector'));
    if (!inst) {
      inspectorBox.append(h('p', { class: 'muted small' }, 'Click an instance in the Hierarchy or on the map (move tool, V) to see its properties. Delete removes it, Ctrl+D duplicates, arrows nudge.'));
      return;
    }
    const obj = state.object(inst.object);
    const edit = (fn: () => void) => { snapshot(); fn(); changed(); };
    const num = (label: string, get: () => number, set: (v: number) => void) => {
      const inp = h('input', { type: 'number', class: 'num', value: String(get()), onchange: () => edit(() => set(Number(inp.value) || 0)) });
      return h('label', {}, label, inp);
    };
    const parse = (s: string): Value => (s === 'true' ? true : s === 'false' ? false : s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s);
    const setProp = (k: string, v: Value | undefined) => {
      inst.props ??= {};
      if (v === undefined || v === '') delete inst.props[k];
      else inst.props[k] = v;
      if (!Object.keys(inst.props).length) delete inst.props;
    };

    const nameIn = h('input', { type: 'text', value: inst.name ?? '', placeholder: inst.object, oninput: () => {
      if (nameIn.value.trim()) inst.name = nameIn.value.trim();
      else delete inst.name;
      changed();
      if (rightTab === 'hierarchy') {
        const row = hierarchyBox.querySelector('.hier-row.active .hier-name');
        if (row) row.textContent = inst.name ?? inst.object;
      }
    } });
    const typeSel = h('select', { onchange: () => edit(() => { inst.object = typeSel.value; renderInspector(); renderRight(); void loadAssets(); }) },
      ...state.game!.objects.map((o) => h('option', { value: o.name, selected: o.name === inst.object }, o.name)));
    if (!obj) typeSel.prepend(h('option', { value: inst.object, selected: true }, `${inst.object} (missing)`));
    const spriteSel = h('select', { onchange: () => edit(() => { if (spriteSel.value) inst.sprite = spriteSel.value; else delete inst.sprite; delete inst.animation; void loadAssets(); renderInspector(); }) },
      h('option', { value: '' }, `— ${obj?.sprite ?? 'none'} (from ${inst.object}) —`),
      ...state.sprites.map((sp) => h('option', { value: sp.name, selected: sp.name === inst.sprite }, sp.name)));
    const animSel = h('select', { onchange: () => edit(() => { if (animSel.value) inst.animation = animSel.value; else delete inst.animation; }) }, h('option', { value: '' }, `— ${obj?.animation ?? 'default'} —`));
    const effective = spriteOf(inst);
    if (effective) void state.asset(effective).then((a) => {
      for (const t of a?.tags ?? []) animSel.append(h('option', { value: t.name, selected: t.name === inst.animation }, t.name));
    });
    const flip = h('input', { type: 'checkbox', checked: !!inst.flipX, onchange: () => edit(() => { if (flip.checked) inst.flipX = true; else delete inst.flipX; }) });

    // Dialogue: only for object types that talk.
    const talks = obj?.behaviors.find((b) => b.type === 'dialogue');
    let dialogueRow: HTMLElement | null = null;
    if (talks) {
      const cur = String(inst.props?.dialogue ?? '');
      const dSel = h('select', { onchange: () => edit(() => { setProp('dialogue', dSel.value || undefined); renderRight(); }) },
        h('option', { value: '' }, talks.dialogue ? `— ${talks.dialogue} (default) —` : '— choose a dialogue —'),
        ...state.dialogueInfo.nodes.map((n) => h('option', { value: n, selected: n === cur }, n)));
      if (cur && !state.dialogueInfo.nodes.includes(cur)) dSel.prepend(h('option', { value: cur, selected: true }, `${cur} (missing)`));
      dialogueRow = h('div', { class: 'dialogue-row' },
        h('label', {}, 'Dialogue', dSel),
        h('a', { class: 'small', href: '#/dialogues' }, 'write dialogues →'),
      );
    }

    const props = h('div', { class: 'props' });
    const keys = new Set([...Object.keys(obj?.properties ?? {}), ...Object.keys(inst.props ?? {})]);
    keys.delete('dialogue');
    for (const k of keys) {
      const def = obj?.properties[k];
      const cur = inst.props?.[k];
      const inp = h('input', { type: 'text', value: cur !== undefined ? String(cur) : '', placeholder: def !== undefined ? String(def) : '', oninput: () => { setProp(k, inp.value === '' ? undefined : parse(inp.value)); changed(); } });
      props.append(h('div', { class: 'prop-row' }, h('code', { title: def === undefined ? 'Only on this instance' : 'Empty = the object type default' }, k), inp,
        def === undefined ? iconButton('close', 'Remove', () => edit(() => { setProp(k, undefined); renderInspector(); }), { class: 'icon-btn tiny' }) : h('span', {})));
    }

    inspectorBox.append(
      h('div', { class: 'form' },
        h('label', {}, 'Name', nameIn),
        h('div', { class: 'row2' }, h('label', {}, 'Object type', typeSel), h('label', {}, 'Sprite', spriteSel)),
        h('div', { class: 'row2' }, h('label', {}, 'Animation', animSel), h('label', { class: 'inline flip-in' }, flip, 'Flip')),
        h('label', { title: `Extra group tags for this instance${obj?.tags?.length ? ` (the type has: ${obj.tags.join(', ')})` : ''}` }, 'Tags', h('input', { type: 'text', value: (inst.tags ?? []).join(', '), placeholder: obj?.tags?.length ? `+ ${obj.tags.join(', ')}` : 'boss…', spellcheck: false, onchange: (e: Event) => edit(() => { const t = normalizeTags((e.target as HTMLInputElement).value); if (t) inst.tags = t; else delete inst.tags; }) })),
        dialogueRow,
        h('div', { class: 'row2' }, num('x', () => inst.x, (v) => (inst.x = v)), num('y', () => inst.y, (v) => (inst.y = v))),
        h('div', {}, h('div', { class: 'muted small' }, keys.size ? 'Properties (empty = default of the type)' : 'Properties'), props,
          h('button', { class: 'small ghost', onclick: async () => {
            const k = await promptText('Instance property', 'Name (only this instance, e.g. hp, line, reward)', '');
            if (!k) return;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return toast('Invalid name', 'error');
            edit(() => setProp(k, 0));
            renderInspector();
          } }, icon('plus', 12), 'Property')),
        h('div', {}, h('div', { class: 'muted small' }, 'Components (empty = value of the object type)'), instanceComponents(inst, obj, edit, () => renderInspector())),
        h('div', { class: 'actions' },
          obj ? h('a', { class: 'small', href: `#/objects/${encodeURIComponent(inst.object)}` }, `edit ${inst.object} →`) : h('span', { class: 'danger-text small' }, 'unknown type'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'small', title: 'Duplicate (Ctrl+D)', onclick: () => {
            snapshot();
            const copy: Instance = { ...JSON.parse(JSON.stringify(inst)), id: newGameId(), x: inst.x + ts() };
            scene.instances.push(copy);
            changed();
            select(copy.id);
            renderRight();
          } }, icon('copy', 13)),
          h('button', { class: 'small danger', onclick: () => { snapshot(); scene.instances = scene.instances.filter((i) => i !== inst); changed(); select(null); renderRight(); } }, icon('trash', 13), 'Remove'),
        ),
      ),
    );
  }

  function renderSettings(): void {
    clear(settingsBox);
    const colsIn = h('input', { type: 'number', min: '1', max: '1024', value: String(scene.cols) });
    const rowsIn = h('input', { type: 'number', min: '1', max: '1024', value: String(scene.rows) });
    const apply = () => {
      const c = Number(colsIn.value);
      const r = Number(rowsIn.value);
      if (c === scene.cols && r === scene.rows) return;
      snapshot();
      resizeScene(scene, c, r);
      changed();
    };
    colsIn.addEventListener('change', apply);
    rowsIn.addEventListener('change', apply);
    const bg = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(scene.background) ? scene.background : (/^#[0-9a-f]{6}$/i.test(state.game!.background) ? state.game!.background : '#181425'), oninput: () => { scene.background = bg.value; changed(); } });
    const vars = h('div', { class: 'props' });
    const parse = (s: string): Value => (s === 'true' ? true : s === 'false' ? false : s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s);
    for (const [k, v] of Object.entries(scene.variables)) {
      const inp = h('input', { type: 'text', value: String(v), oninput: () => { scene.variables[k] = parse(inp.value); changed(); } });
      vars.append(h('div', { class: 'prop-row' }, h('code', {}, `scene.${k}`), inp, iconButton('close', 'Remove', () => { snapshot(); delete scene.variables[k]; changed(); renderSettings(); }, { class: 'icon-btn tiny' })));
    }
    settingsBox.append(
      h('div', { class: 'panel-title' }, 'Scene'),
      h('div', { class: 'form' },
        h('div', { class: 'row2' }, h('label', {}, 'Width (tiles)', colsIn), h('label', {}, 'Height (tiles)', rowsIn)),
        h('p', { class: 'muted small' }, `${scene.cols * ts()}×${scene.rows * ts()} px · tiles ${ts()} px · screen ${state.game!.width}×${state.game!.height}`),
        h('label', {}, 'Background', bg),
        h('label', { class: 'inline', title: 'Instances lower on screen are drawn in front: depth for top-down games and RPGs' },
          h('input', { type: 'checkbox', checked: !!scene.ySort, onchange: (e: Event) => { snapshot(); if ((e.target as HTMLInputElement).checked) scene.ySort = true; else delete scene.ySort; changed(); } }),
          'Sort by Y (top-down depth)'),
        h('label', { class: 'inline', title: 'Coming back to this scene (e.g. after a battle) keeps positions, opened chests, defeated enemies and instance properties. Restart Scene forgets.' },
          h('input', { type: 'checkbox', checked: !!scene.persistent, onchange: (e: Event) => { snapshot(); if ((e.target as HTMLInputElement).checked) scene.persistent = true; else delete scene.persistent; changed(); } }),
          'Remember instances when leaving'),
        vars,
        componentListCard('Scene components', 'Managers and level logic: a script component here runs for the whole scene (this.self is null), e.g. a battle, a wave spawner, the level HUD.', () => scene.components, (list) => { snapshot(); if (list?.length) scene.components = list; else delete scene.components; }, () => sheetContext(null, []), () => changed()),
        h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: async () => {
            const n = await promptText('Scene variable', 'Name (e.g. timeLeft)', '');
            if (!n) return;
            snapshot();
            scene.variables[n] = 0;
            changed();
            renderSettings();
          } }, icon('plus', 13), 'Variable'),
          h('button', { class: 'small', onclick: () => void openEvents() }, `Events (${scene.events.length})`),
        ),
      ),
    );
  }

  async function openEvents(): Promise<void> {
    await modal(`Scene events · ${scene.name}`, () => {
      const box = h('div', { class: 'event-sheet' });
      renderEventSheet(box, () => scene.events, () => sheetContext(null, []), () => changed());
      return h('div', {}, h('p', { class: 'muted small' }, 'Scene events run once per frame for the whole scene: timers, win/lose rules, music of the level. Object behavior belongs on the object types.'), box);
    }, { wide: true });
    renderSettings();
  }

  const renderSide = () => {
    renderLayers();
    renderPalette();
    renderRight();
    renderInspector();
  };

  // ---------------------------------------------------------------- start
  setTool(state.game!.objects.length && !scene.tileset ? 'place' : 'paint');
  renderSide();
  resize();
  requestAnimationFrame(() => fitHeight());
  await loadAssets();
  const unsub = state.subscribe(() => {
    renderRight();
    void loadAssets();
  });

  return {
    destroy() {
      void flush();
      unregister();
      unsub();
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    },
    async remote(rev) {
      if (rev === null) {
        toast(`Scene "${name}" was deleted`, 'error');
        onBack();
        return;
      }
      if (rev === lastRev || dirty) return;
      const next = await gameApi.getScene(scene.name);
      if (next.rev === lastRev) return;
      snapshot();
      scene = next;
      lastRev = next.rev;
      activeLayer = Math.min(activeLayer, scene.layers.length - 1);
      toast(`Scene updated${next.updatedBy === 'claude' ? ' by Claude' : ''}`, next.updatedBy === 'claude' ? 'claude' : 'info');
      renderSide();
      await loadAssets();
    },
    refreshAssets() {
      void loadAssets();
    },
  };
}
