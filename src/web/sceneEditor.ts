/** Scene editor: paint tile layers, place and move instances, edit scene settings and events. */

import { decodeFineSolid } from '../core/game/fineSolid.js';
import { TileResolver, type TilesetRules, tilesetFrame } from '../core/game/tilerules.js';
import { swayBands, swayBase } from '../core/game/wind.js';
import { RainField, drawShafts } from '../core/game/weather.js';
import { type WaterMap, addWaterActors, drawReflections, findWater, reflectionZ } from '../core/game/reflections.js';
import { type AtmosphereActor, type AtmosphereWorld, MoteField, drawClouds, drawShadows, postProcess } from '../core/game/atmosphere.js';
import { type Instance, type Scene, type SceneMotes, type TileLayer, type Value, footLineProblem, hitboxOf, interfaceSize, newGameId, normalizeScene, normalizeTags, resizeScene, setTileSize } from '../core/game/types.js';
import { CanvasRenderer } from '../runtime/canvasRenderer.js';
import { atmosphereEditor, lightEditor } from './atmosphereUi.js';
import { HdPreview } from './hdPreview.js';
import { openBlueprint } from './blueprintPanel.js';
import { HD_CELL_MAX_ROWS, HD_FIELDS, resolveHd } from '../core/game/hd.js';
import { type WallCell, findWalls } from '../core/game/hd3d.js';
import { openTileRules } from './tileRulesUi.js';
import { renderEventSheet } from './eventSheet.js';
import { checkExpr } from '../core/game/expr.js';
import { componentListCard, instanceComponents } from './componentsUi.js';
import { type LoadedAsset, gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { TEMPLATES, createFromTemplate, sheetContext } from './objectsView.js';
import { isPlaying, onPlayChange, openPlay, registerFlusher } from './play.js';
import { clear, h, icon, iconButton, modal, promptText, toast } from './dom.js';
import { api } from './api.js';
import { drawPixelText, previewText, textSize } from './textPreview.js';
import { VALUE_HINT, formatValue, parseValue } from './values.js';
import { colorInput } from './colorInput.js';
import { type SceneStamp, type ScatterRecipe, type TileRect, deleteGroup, extractRegion, listGroups, pasteRegion, regenerateGroup, renameGroup, scatter, scatterIntoGroup } from '../core/game/sceneOps.js';
import { updateContext } from './editorContext.js';
import { type MapNote } from './gameApi.js';
import { openUsages } from './usagesView.js';

type Tool = 'paint' | 'rect' | 'fill' | 'erase' | 'place' | 'select' | 'scatter' | 'note' | 'walls';

/** The copied part of a map; it stays while moving to another scene. */
let clipboard: SceneStamp | null = null;

const TOOLS: { id: Tool; label: string; icon: string; key: string }[] = [
  { id: 'paint', label: 'Paint tiles', icon: 'pencil', key: 'B' },
  { id: 'rect', label: 'Fill rectangle', icon: 'rect', key: 'R' },
  { id: 'fill', label: 'Bucket fill', icon: 'fill', key: 'G' },
  { id: 'erase', label: 'Erase tiles', icon: 'eraser', key: 'E' },
  { id: 'place', label: 'Place objects', icon: 'plus', key: 'P' },
  { id: 'select', label: 'Select / move objects (Shift+click adds one, Shift+drag or drag on empty space selects an area)', icon: 'move', key: 'V' },
  { id: 'scatter', label: 'Scatter objects (settings in the Groups tab)', icon: 'onion', key: 'S' },
  { id: 'note', label: 'Note on the map (Claude reads these)', icon: 'tag', key: 'N' },
  { id: 'walls', label: 'Correct the walls of the 2D-HD view', icon: 'wall', key: 'W' },
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
  notesChanged(): void;
}

export async function mountSceneEditor(root: HTMLElement, name: string, onBack: () => void, focusId?: string): Promise<SceneEditorHandle> {
  await state.ensure();
  let scene = await gameApi.getScene(name);
  clear(root);
  document.title = `${name} · Spritifer`;

  // ---------------------------------------------------------------- state
  let tool: Tool = 'paint';
  let activeLayer = Math.max(0, scene.layers.findIndex((l) => l.solid));
  let brush: Brush = { w: 1, h: 1, tiles: [0] };
  let placeObject: string | null = state.game!.objects[0]?.name ?? null;
  /** The one selected instance, shown in the inspector; null when none or several are selected. */
  let selectedId: string | null = null;
  const selected = new Set<string>();
  /** Selected rectangle of tiles (drag on empty space with the select tool). */
  let region: TileRect | null = null;
  let notes: MapNote[] = [];
  /** Groups hidden in the editor only. */
  const hiddenGroups = new Set<string>();
  const scatterForm = { group: 'decor', objects: [] as string[], density: 8, minDistance: 0, flip: true, avoidSolid: true, mode: 'brush' as 'brush' | 'area', radius: 2 };
  let zoom = 2;
  let panX = 20;
  let panY = 20;
  let showGrid = true;
  let dimOthers = false;
  let lastStateVars = '';
  let hover: { x: number; y: number } | null = null;
  let tileset: LoadedAsset | undefined;
  /** Loaded sprites by sprite name (object sprites and per-instance overrides). */
  const assets = new Map<string, LoadedAsset>();
  const spriteOf = (i: Instance) => i.sprite ?? state.effective(i.object)?.sprite;
  const undoStack: string[] = [];
  const redoStack: string[] = [];
  let saveTimer = 0;
  let dirty = false;
  let lastRev = scene.rev;

  const ts = () => scene.tileSize;
  const layer = (): TileLayer | undefined => scene.layers[activeLayer];
  const selectedInstances = () => scene.instances.filter((i) => selected.has(i.id));
  const reportContext = () => {
    updateContext({
      tool,
      tile: hover ?? undefined,
      region: region ?? undefined,
      selection: selected.size ? selectedInstances().slice(0, 200).map((i) => ({ id: i.id, object: i.object, name: i.name, x: i.x, y: i.y, group: i.group })) : undefined,
    });
  };
  const setSelection = (ids: string[]) => {
    selected.clear();
    for (const id of ids) selected.add(id);
    selectedId = ids.length === 1 ? ids[0] : null;
    reportContext();
  };
  const sizeOf = (item: { object: string; sprite?: string }) => {
    const sp = state.sprite(item.sprite ?? state.effective(item.object)?.sprite);
    return sp ? { w: sp.width, h: sp.height } : { w: ts(), h: ts() };
  };
  const isHidden = (i: Instance) => !!i.group && hiddenGroups.has(i.group);

  // ---------------------------------------------------------------- persistence
  const saveLabel = h('span', { class: 'save-label' }, 'Saved');
  const snapshot = () => {
    undoStack.push(JSON.stringify(scene));
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  };
  const hdPreview = new HdPreview({
    wrap: () => wrap,
    scene: () => scene,
    sprites: () => new Map(tileset ? [...assets, [tileset.name, tileset]] : assets),
    center: () => { const v = visibleRect(); return { x: v.x + v.w / 2, y: v.y + v.h / 2 }; },
    onVisible: (on) => { hdBtn.classList.toggle('active', on); if (!on) draw(); },
  });
  const changed = () => {
    dirty = true;
    wallCache = null;
    hdPreview.invalidate();
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
  // Each call replaces the one before it, and leaving the editor ends the last one.
  let assetsRun = 0;
  const fetchedAssets = new Set<string>();
  const loadAssets = async () => {
    const run = ++assetsRun;
    tileset = scene.tileset ? await state.asset(scene.tileset) : undefined;
    if (run !== assetsRun) return;
    assets.clear();
    const bring = (names: Iterable<string>) => Promise.all([...names].map(async (n) => {
      const a = await state.asset(n);
      if (a && run === assetsRun) assets.set(n, a);
      fetchedAssets.add(n);
    }));
    // The scene opens as soon as what it shows is here.
    const shown = new Set<string>(fetchedAssets);
    for (const i of scene.instances) { const s = spriteOf(i); if (s) shown.add(s); }
    for (const b of scene.backgrounds) shown.add(b.sprite);
    if (scene.atmosphere?.clouds) shown.add(scene.atmosphere.clouds.sprite);
    // The other objects can be placed at any moment, so their sprites follow right after.
    const others = new Set<string>();
    for (const o of state.game!.objects) if (o.sprite && !shown.has(o.sprite)) others.add(o.sprite);
    await bring(shown);
    if (run !== assetsRun) return;
    atmRenderer = null;
    reliefRenderer = null;
    reliefCache.clear();
    hdPreview.reload();
    draw();
    renderPalette();
    renderRight();
    if (!others.size) return;
    await bring(others);
    if (run !== assetsRun) return;
    atmRenderer = null;
    reliefRenderer = null;
    hdPreview.reload();
    draw();
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
  const lookBtn = iconButton('sun', 'Game look (L): preview lights, shadows, clouds, particles, color grade and animated tiles as in Play', () => setGameLook(!showGameLook));
  const hdBtn = h('button', { class: 'small', title: 'See the scene through the game\'s 2D-HD camera: perspective, raised walls, depth of field. Its settings are in the Scene tab, under Atmosphere', onclick: () => hdPreview.toggle() }, '2D-HD');
  const blueprintBtn = h('button', { class: 'small', title: 'What this map is made from: rooms, passages, water and what stands where. Tiles, walls and instances are compiled from it', onclick: async () => {
    await flush();
    await state.flush();
    await openBlueprint(scene.name);
  } }, 'Blueprint');
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

  async function previewState(): Promise<void> {
    const typed = await promptText('Preview state', 'Global variables, comma separated (e.g. inn_lv=2, town_rank=10). Empty = the initial ones', lastStateVars);
    if (typed === null) return;
    lastStateVars = typed;
    const vars: Record<string, Value> = {};
    for (const part of typed.split(',')) {
      const [k, v] = part.split('=');
      if (k?.trim() && v !== undefined) vars[k.trim()] = parseValue(v);
    }
    try {
      await flush();
      const r = await gameApi.sceneState(scene.name, vars);
      await modal(`Preview state · ${scene.name}`, () => h('div', { class: 'form' },
        h('img', { src: `data:image/png;base64,${r.png}`, alt: 'The scene with these variables', style: 'max-width:100%;image-rendering:pixelated' }),
        h('p', { class: 'muted small' }, r.hidden.length ? `Hidden (Active if is false): ${r.hidden.join(', ')}` : 'No instance is hidden with these variables.'),
      ), { wide: true });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

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
      lookBtn,
      hdBtn,
      blueprintBtn,
      h('span', { class: 'sep' }),
      h('button', { class: 'small', onclick: () => void openEvents() }, icon('tag', 14), 'Scene events'),
      h('button', { class: 'small', title: 'Find what uses this scene', onclick: () => void openUsages('scene', scene.name) }, icon('target', 14), 'Usages'),
      h('button', { class: 'small', 'data-k': 'scene-state', title: 'See the scene with some global variables: what the conditional instances (Active if) do at a later stage of the game', onclick: () => void previewState() }, icon('eye', 14), 'Preview state'),
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

  const tileSrc = (t: number, frame = 0): [number, number, number, number] | null => {
    if (!tileset || !tileset.frames.length) return null;
    const g = tileset.grid ?? { width: ts(), height: ts() };
    const cols = Math.max(1, Math.floor(tileset.width / g.width));
    const f0 = tileset.frames[frame] ?? tileset.frames[0];
    return [f0.x + (t % cols) * g.width, f0.y + Math.floor(t / cols) * g.height, g.width, g.height];
  };

  const instanceFrame = (i: Instance) => {
    const spr = spriteOf(i);
    const a = spr ? assets.get(spr) : undefined;
    if (!a || !a.frames.length) return null;
    const obj = state.effective(i.object);
    const tag = a.tags.find((t) => t.name === (i.animation ?? obj?.animation));
    return { a, f: a.frames[tag?.from ?? 0] ?? a.frames[0] };
  };

  const instanceBox = (i: Instance) => {
    const fr = instanceFrame(i);
    if (fr) return { x: i.x, y: i.y, w: fr.a.width, h: fr.a.height };
    const obj = state.effective(i.object);
    if (obj?.text !== undefined) {
      const sz = textSize(previewText(obj.text, obj, scene.variables).text || ' ', obj.textSize ?? 1);
      return { x: i.x, y: i.y, w: sz.w, h: sz.h };
    }
    return { x: i.x, y: i.y, w: ts(), h: ts() };
  };

  // ---------------------------------------------------------------- game-look preview
  // The editor draws the scene the way the game does: animated tiles, parallax backgrounds and the
  // scene atmosphere (contact shadows, cloud shadows, particles, lights, color grade, vignette) through
  // the same functions and canvas renderer as Play. The visible part of the map acts as the screen.
  const PREVIEW_KEY = 'spritifer.sceneGameLook';
  let showGameLook = (() => { try { return localStorage.getItem(PREVIEW_KEY) !== '0'; } catch { return true; } })();
  const motes = new MoteField();
  const motes2 = new MoteField();
  const rain = new RainField();
  let rainKey = '';
  let waterPreview: { at: number; map: WaterMap } | null = null;
  let motes2Cfg: SceneMotes | undefined;
  let motes2Key = '';
  let motesCfg: SceneMotes | undefined;
  let motesKey = '';
  let lastTick = performance.now();
  const clock0 = performance.now();
  let raf = 0;
  let atmRenderer: { r: CanvasRenderer; key: string } | null = null;
  // Relief lighting works on game pixels: an offscreen copy of the visible area, whatever the editor's zoom.
  let reliefRenderer: { r: CanvasRenderer; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; key: string } | null = null;
  const reliefCache = new Map<string, unknown>();
  let resolverCache: { cfg: TilesetRules | undefined; r: TileResolver } | null = null;
  const resolverFor = () => {
    const cfg = tileset ? state.game!.tilesets?.[tileset.name] : undefined;
    if (!resolverCache || resolverCache.cfg !== cfg) resolverCache = { cfg, r: new TileResolver(cfg) };
    return resolverCache.r;
  };
  /** Visible part of the scene in scene pixels (the "screen" of the preview). */
  const visibleRect = () => {
    const r = wrap.getBoundingClientRect();
    const W = scene.cols * ts();
    const H = scene.rows * ts();
    const x0 = Math.max(0, Math.min(W, Math.floor(-panX / zoom)));
    const y0 = Math.max(0, Math.min(H, Math.floor(-panY / zoom)));
    const x1 = Math.max(x0, Math.min(W, Math.ceil((r.width - panX) / zoom)));
    const y1 = Math.max(y0, Math.min(H, Math.ceil((r.height - panY) / zoom)));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  /** Placed instances as the atmosphere passes see them (same light/shadow rules as the engine). */
  const previewActors = (): AtmosphereActor[] => scene.instances.map((inst, k) => {
    const obj = state.effective(inst.object);
    const fr = instanceFrame(inst);
    const asset = fr ? { width: fr.a.width, height: fr.a.height, name: fr.a.name, frames: [fr.f] } : undefined;
    const hb = hitboxOf(inst, obj);
    const b = hb
      ? { x: inst.x + (inst.flipX && asset ? asset.width - hb.x - hb.w : hb.x), y: inst.y + hb.y, w: hb.w, h: hb.h }
      : instanceBox(inst);
    return {
      id: k + 1, x: inst.x, y: inst.y, z: obj?.z ?? 0, opacity: 1, visible: true, destroyed: false, flipX: !!inst.flipX,
      light: inst.light ? (inst.light.radius > 0 ? inst.light : undefined) : obj?.light,
      asset, type: obj ?? {}, box: () => b,
    };
  });
  // Not behind the Play overlay: the game runs on the same thread, and this redraws every light at full size.
  const animating = () => showGameLook && !isPlaying() && !hdPreview.visible && !!(scene.atmosphere || (tileset && tileset.frames.length > 1) || state.game?.objects.some((o) => o.sway));
  const stopWatchingPlay = onPlayChange(() => {
    if (animating() && !raf && canvas.isConnected) raf = requestAnimationFrame(loop);
  });
  const loop = () => {
    raf = 0;
    if (!canvas.isConnected || !animating()) return;
    draw();
  };
  const setGameLook = (on: boolean) => {
    showGameLook = on;
    try { localStorage.setItem(PREVIEW_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    lookBtn.classList.toggle('active', on);
    draw();
  };

  lookBtn.classList.toggle('active', showGameLook);

  function reliefFor(w: number, hh: number): NonNullable<typeof reliefRenderer> {
    const key = `${w}x${hh}`;
    if (!reliefRenderer || reliefRenderer.key !== key) {
      const c2 = document.createElement('canvas');
      c2.width = w;
      c2.height = hh;
      const g = c2.getContext('2d', { willReadFrequently: true })!;
      const images = new Map<string, CanvasImageSource>();
      for (const [n, a] of assets) images.set(n, a.img);
      reliefRenderer = { r: new CanvasRenderer(g, images, w, hh).useRelief(Object.fromEntries(assets), interfaceSize(state.game!), reliefCache), canvas: c2, g, key };
    }
    return reliefRenderer;
  }

  let fineCache: { rle: string; fine: ReturnType<typeof decodeFineSolid>['fine'] } | null = null;
  function draw(): void {
    const dpr = window.devicePixelRatio || 1;
    const W = scene.cols * ts();
    const H = scene.rows * ts();
    const now = performance.now();
    const clock = (now - clock0) / 1000;
    const look = showGameLook;
    const atm = look ? scene.atmosphere : undefined;
    const view = visibleRect();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#101217';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = scene.background || state.game!.background;
    ctx.fillRect(0, 0, W, H);

    // Parallax backgrounds, placed as the game places them with the camera at the visible area.
    if (scene.backgrounds.length && view.w > 0 && view.h > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(view.x, view.y, view.w, view.h);
      ctx.clip();
      for (const bg of scene.backgrounds) {
        const a = assets.get(bg.sprite);
        if (!a || !a.frames.length) continue;
        const f = a.frames[0];
        const ox = view.x + Math.round(-view.x * bg.parallax);
        const oy = view.y + Math.round(bg.y - view.y * bg.parallax);
        if (bg.repeatX) {
          let start = (ox - view.x) % f.w;
          if (start > 0) start -= f.w;
          for (let x = view.x + start; x < view.x + view.w; x += f.w) ctx.drawImage(a.img, f.x, f.y, f.w, f.h, Math.round(x), oy, f.w, f.h);
        } else ctx.drawImage(a.img, f.x, f.y, f.w, f.h, ox, oy, f.w, f.h);
      }
      ctx.restore();
    }

    const relief = atm?.relief && view.w > 0 && view.h > 0 ? reliefFor(view.w, view.h) : null;
    relief?.r.beginRelief(true, atm?.relief?.tiles !== false);

    // Tile layers and instances in z order (layers default below objects).
    type Item = { z: number; o: number; d: () => void };
    const items: Item[] = [];
    const tileFrame = look && tileset ? tilesetFrame(tileset, clock) : 0;
    const tx0 = Math.max(0, Math.floor(view.x / ts()));
    const ty0 = Math.max(0, Math.floor(view.y / ts()));
    const tx1 = Math.min(scene.cols - 1, Math.floor((view.x + view.w) / ts()));
    const ty1 = Math.min(scene.rows - 1, Math.floor((view.y + view.h) / ts()));
    scene.layers.forEach((l, li) => {
      if (!l.visible) return;
      items.push({ z: l.z ?? li - 10, o: li, d: () => {
        if (!tileset) return;
        ctx.globalAlpha = dimOthers && li !== activeLayer ? 0.3 : 1;
        // Same tile rules as the game (autotiling, textures, edge overlays, animated tiles).
        const resolver = resolverFor();
        const list: number[] = [];
        for (let ty = ty0; ty <= ty1; ty++) {
          for (let tx = tx0; tx <= tx1; tx++) {
            if (l.tiles[ty * scene.cols + tx] < 0) continue;
            for (const t of resolver.resolve(l, scene.cols, scene.rows, tx, ty, list, look ? clock : 0)) {
              const s = tileSrc(t, tileFrame);
              if (s) ctx.drawImage(tileset.img, s[0], s[1], s[2], s[3], tx * ts(), ty * ts(), ts(), ts());
              if (s && relief) relief.r.captureNormals(tileset.name, s[0], s[1], s[2], s[3], tx * ts() - view.x, ty * ts() - view.y, { flipX: false, opacity: 1, scale: ts() / s[2], flat: !l.solid });
            }
          }
        }
        ctx.globalAlpha = 1;
      } });
    });
    // The scene's fine collision (read only here): blue cells over the map, where the walls layer is shown.
    const fineData = scene.collisionFine;
    // shown with the walls layer, or always when the map has no solid layer to show or hide
    const wallsShown = !scene.layers.some((l) => l.solid) || scene.layers.some((l) => l.solid && l.visible);
    if (fineData && wallsShown) {
      items.push({ z: 1000, o: 0, d: () => {
        const key = `${fineData.cell}:${fineData.cols}x${fineData.rows}:${scene.cols * ts()}x${scene.rows * ts()}:${fineData.rle}`;
        if (fineCache?.rle !== key) fineCache = { rle: key, fine: decodeFineSolid(fineData, scene.cols * ts(), scene.rows * ts()).fine };
        const fine = fineCache.fine;
        if (!fine) return;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = '#29adff';
        const c = fine.cell;
        for (let cy = Math.max(0, Math.floor(ty0 * ts() / c)); cy <= Math.min(fine.rows - 1, Math.ceil(((ty1 + 1) * ts()) / c)); cy++) {
          for (let cx = Math.max(0, Math.floor(tx0 * ts() / c)); cx <= Math.min(fine.cols - 1, Math.ceil(((tx1 + 1) * ts()) / c)); cx++) {
            if (fine.bits[cy * fine.cols + cx]) ctx.fillRect(cx * c, cy * c, c, c);
          }
        }
        ctx.globalAlpha = 1;
      } });
    }
    // With an atmosphere: shadows between the ground and the instances, HUD instances above the lighting.
    const actors = atm ? previewActors() : [];
    const sprites = Object.fromEntries(assets) as Record<string, LoadedAsset>;
    const rendererFor = (w: number, hh: number) => {
      const key = `${w}x${hh}`;
      if (!atmRenderer || atmRenderer.key !== key) {
        const images = new Map<string, CanvasImageSource>();
        for (const [n, a] of assets) images.set(n, a.img);
        atmRenderer = { r: new CanvasRenderer(ctx, images, Math.max(1, w), Math.max(1, hh)).useRelief(Object.fromEntries(assets), interfaceSize(state.game!), reliefCache), key };
      }
      return atmRenderer.r;
    };
    if (atm?.reflections && tileset) {
      const cfg = atm.reflections;
      const sheet = tileset;
      // Painting tiles changes the water, so it is looked for again now and then rather than once.
      if (!waterPreview || now - waterPreview.at > 1000) {
        const map = findWater(scene.layers, scene.cols, scene.rows, resolverFor());
        addWaterActors(map, actors, cfg.sprites ?? [], ts());
        waterPreview = { at: now, map };
      }
      const preview = waterPreview;
      items.push({ z: reflectionZ(preview.map), o: 0, d: () => {
        const grid = sheet.grid ?? { width: ts(), height: ts() };
        const tcols = Math.max(1, Math.floor(sheet.width / grid.width));
        const f0 = sheet.frames[0]!;
        const tileRect = (t: number): [number, number] => [f0.x + (t % tcols) * grid.width, f0.y + Math.floor(t / tcols) * grid.height];
        ctx.save();
        ctx.translate(view.x, view.y);
        drawReflections(rendererFor(view.w, view.h), cfg, preview.map, actors, { name: sheet.name, tile: tileRect, w: grid.width, h: grid.height }, ts(), clock, view.x, view.y, 1, view.w, view.h);
        ctx.restore();
        ctx.globalAlpha = 1;
      } });
    }
    if (atm && atm.shadows !== false) {
      items.push({ z: -1.5, o: 0, d: () => {
        drawShadows({ clock, game: { width: W, height: H }, actors, motes, bundle: { sprites } }, rendererFor(view.w, view.h), atm, 0, 0, 1);
        ctx.globalAlpha = 1;
      } });
    }
    const hudItems: Item[] = [];
    scene.instances.forEach((inst, k) => {
      if (isHidden(inst)) return;
      const obj = state.effective(inst.object);
      const sortKey = scene.ySort ? 1000 + (() => { const b = instanceBox(inst); return b.y + b.h; })() + k / 10000 : 1000 + k;
      (atm && obj?.hud ? hudItems : items).push({ z: obj?.z ?? 0, o: sortKey, d: () => {
        const fr = instanceFrame(inst);
        ctx.globalAlpha = dimOthers ? 0.5 : 1;
        if (fr) {
          const drawX = inst.x + (obj?.spriteOffset?.x ?? 0);
          const drawY = inst.y + (obj?.spriteOffset?.y ?? 0);
          // In the game look the wind moves plants as in Play; a whole sprite is one band that stays still.
          const bands = look && obj?.sway ? swayBands(obj.sway, fr.f.h, swayBase({ hitbox: hitboxOf(inst, obj), spriteOffset: obj.spriteOffset }, fr.f.h), inst.x, inst.y, clock) : [{ row: 0, rows: fr.f.h, offset: 0 }];
          for (const b of bands) {
            const bandX = drawX + b.offset;
            relief?.r.captureNormals(fr.a.name, fr.f.x, fr.f.y + b.row, fr.f.w, b.rows, bandX - view.x, drawY + b.row - view.y, { flipX: !!inst.flipX, opacity: 1 });
            if (inst.flipX) {
              ctx.save();
              ctx.translate(bandX + fr.f.w, drawY);
              ctx.scale(-1, 1);
              ctx.drawImage(fr.a.img, fr.f.x, fr.f.y + b.row, fr.f.w, b.rows, 0, b.row, fr.f.w, b.rows);
              ctx.restore();
            } else ctx.drawImage(fr.a.img, fr.f.x, fr.f.y + b.row, fr.f.w, b.rows, bandX, drawY + b.row, fr.f.w, b.rows);
          }
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
    relief?.r.endRelief();

    if (atm && view.w > 0 && view.h > 0) {
      // Viewport passes: the visible area is the screen (camera at its top-left, zoom 1).
      const r = rendererFor(view.w, view.h);
      const world: AtmosphereWorld = { clock, game: { width: view.w, height: view.h }, actors, motes, bundle: { sprites } };
      const key = JSON.stringify(atm.motes ?? null);
      if (key !== motesKey) {
        motesKey = key;
        motesCfg = atm.motes ? { ...atm.motes } : undefined;
        motes.reset(motesCfg);
      }
      if (motesCfg && atm.motes) {
        // "On screen" count, scaled to how much of the map is visible.
        const screens = (view.w * view.h) / Math.max(1, state.game!.width * state.game!.height);
        motesCfg.count = Math.min(400, Math.round((atm.motes.count ?? 24) * screens));
      }
      motes.tick(Math.min(0.1, (now - lastTick) / 1000), view);
      const key2 = JSON.stringify(atm.motes2 ?? null);
      if (key2 !== motes2Key) {
        motes2Key = key2;
        motes2Cfg = atm.motes2 ? { ...atm.motes2 } : undefined;
        motes2.reset(motes2Cfg);
      }
      if (motes2Cfg && atm.motes2) motes2Cfg.count = Math.min(400, Math.round((atm.motes2.count ?? 24) * (view.w * view.h) / Math.max(1, state.game!.width * state.game!.height)));
      motes2.tick(Math.min(0.1, (now - lastTick) / 1000), view);
      const rainConfig = JSON.stringify(atm.rain ?? null);
      if (rainConfig !== rainKey) {
        rainKey = rainConfig;
        rain.reset(atm.rain ? { ...atm.rain } : undefined);
      }
      rain.tick(Math.min(0.1, (now - lastTick) / 1000), view);
      ctx.save();
      ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, (panX + view.x * zoom) * dpr, (panY + view.y * zoom) * dpr);
      ctx.beginPath();
      ctx.rect(0, 0, view.w, view.h);
      ctx.clip();
      drawClouds(world, r, atm, view.x, view.y, 1);
      motes.draw(r, view.x, view.y, 1);
      motes2.draw(r, view.x, view.y, 1);
      rain.draw(r, view.x, view.y, 1);
      if (relief) {
        // The picture so far, at game resolution; lit there and painted back at the editor's zoom.
        relief.g.imageSmoothingEnabled = false;
        relief.g.globalCompositeOperation = 'copy';
        relief.g.drawImage(canvas, (panX + view.x * zoom) * dpr, (panY + view.y * zoom) * dpr, view.w * zoom * dpr, view.h * zoom * dpr, 0, 0, view.w, view.h);
        relief.g.globalCompositeOperation = 'source-over';
        postProcess(world, relief.r, atm, view.x, view.y, 1);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(relief.canvas, 0, 0, view.w, view.h);
      } else postProcess(world, r, atm, view.x, view.y, 1);
      if (atm.shafts) drawShafts(r, atm.shafts, clock, view.x, view.y, 1, view.w, view.h, [motes, motes2]);
      rain.drawFlash(r, view.w, view.h);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    lastTick = now;
    hudItems.sort((a, b) => a.z - b.z || a.o - b.o);
    for (const it of hudItems) it.d();
    if (animating() && !raf) raf = requestAnimationFrame(loop);

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

    // Selected tiles.
    if (region) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#feae34';
      ctx.strokeRect(sx(region.x * ts()), sy(region.y * ts()), region.w * ts() * zoom, region.h * ts() * zoom);
      ctx.setLineDash([]);
    }
    if (marquee) {
      ctx.fillStyle = '#feae3422';
      ctx.strokeStyle = '#feae34';
      const mx = Math.min(marquee.x0, marquee.x1);
      const my = Math.min(marquee.y0, marquee.y1);
      const mw = Math.abs(marquee.x1 - marquee.x0);
      const mh = Math.abs(marquee.y1 - marquee.y0);
      ctx.fillRect(sx(mx), sy(my), mw * zoom, mh * zoom);
      ctx.strokeRect(sx(mx), sy(my), mw * zoom, mh * zoom);
    }
    // Several selected: an outline each.
    if (selected.size > 1) {
      ctx.strokeStyle = '#feae34';
      ctx.lineWidth = 2;
      for (const i of selectedInstances()) {
        const b = instanceBox(i);
        ctx.strokeRect(sx(b.x) - 1, sy(b.y) - 1, b.w * zoom + 1, b.h * zoom + 1);
      }
      ctx.lineWidth = 1;
    }
    // Selection.
    const sel = scene.instances.find((i) => i.id === selectedId);
    if (sel) {
      const b = instanceBox(sel);
      ctx.strokeStyle = '#feae34';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx(b.x) - 1, sy(b.y) - 1, b.w * zoom + 1, b.h * zoom + 1);
      ctx.lineWidth = 1;
      // Reach of its light (dashed), centered like the engine: sprite center + offset.
      const so = state.effective(sel.object);
      const light = sel.light ? (sel.light.radius > 0 ? sel.light : undefined) : so?.light;
      if (light) {
        const fr = instanceFrame(sel);
        const cx = sel.x + (fr ? fr.a.width / 2 : 0) + (light.x ?? 0);
        const cy = sel.y + (fr ? fr.a.height / 2 : 0) + (light.y ?? 0);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = light.color ?? '#ffd9a0';
        ctx.beginPath();
        ctx.arc(panX + cx * zoom, panY + cy * zoom, light.radius * zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // Notes on the map.
    ctx.font = 'bold 11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    openNotes().forEach((n, i) => {
      const nx = panX + n.x * zoom;
      const ny = panY + n.y * zoom;
      ctx.fillStyle = n.author === 'claude' ? '#d97757' : '#feae34';
      ctx.beginPath();
      ctx.arc(nx, ny, NOTE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#181425';
      ctx.fillText(String(i + 1), nx, ny + 0.5);
    });
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    if (tool === 'walls') {
      const cells = wallCells();
      const px = ts() * zoom;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.max(9, Math.min(14, px * 0.4))}px system-ui`;
      for (let y = 0; y < scene.rows; y++) {
        for (let x = 0; x < scene.cols; x++) {
          const c = cells[y * scene.cols + x];
          const set = scene.hdCells?.[`${x},${y}`];
          if (!c && set === undefined) continue;
          ctx.fillStyle = !c ? '#e43b4455' : 'face' in c ? '#feae3466' : '#4fa4ff55';
          ctx.fillRect(sx(x * ts()), sy(y * ts()), px, px);
          if (set === undefined) continue;
          // Corrected by hand: outlined, with what was asked.
          ctx.strokeStyle = '#ffffff';
          ctx.strokeRect(sx(x * ts()) + 1, sy(y * ts()) + 1, px - 2, px - 2);
          if (px >= 12) {
            ctx.fillStyle = '#ffffff';
            ctx.fillText(set === 0 ? '×' : String(set), sx((x + 0.5) * ts()), sy((y + 0.5) * ts()));
          }
        }
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      // Stretches standing forward, and the one being dragged out.
      const frontRows = (x: number, foot: number) => {
        let n = 0;
        for (let y = foot; y >= 0; y--) {
          const c = cells[y * scene.cols + x];
          if (!c || !('face' in c) || c.face !== foot - y) break;
          n++;
        }
        return Math.max(1, n);
      };
      const jutRect = (x: number, w: number, foot: number, color: string) => {
        const n = frontRows(Math.min(scene.cols - 1, Math.floor((x + w / 2) / ts())), foot);
        ctx.fillStyle = color;
        ctx.fillRect(sx(x), sy((foot + 1 - n) * ts()), w * zoom, n * px);
        ctx.strokeStyle = '#7dff9a';
        ctx.strokeRect(sx(x), sy((foot + 1 - n) * ts()), w * zoom, n * px);
      };
      for (const j of scene.hdJuts ?? []) jutRect(j.x, j.w, j.foot, '#5fd35f55');
      if (jutDrag) jutRect(Math.min(jutDrag.x0, jutDrag.x1), Math.abs(jutDrag.x1 - jutDrag.x0), jutDrag.foot, '#7dff9a88');
      if (hover) {
        ctx.strokeStyle = wallBrush === null ? '#e43b44' : '#feae34';
        ctx.strokeRect(sx(hover.x * ts()), sy(hover.y * ts()), px, px);
      }
    }
    // Hover / brush ghost.
    if (hover) {
      if (tool === 'scatter' && scatterForm.mode === 'brush') {
        ctx.strokeStyle = '#feae34';
        const d = (scatterForm.radius * 2 + 1) * ts() * zoom;
        ctx.strokeRect(sx((hover.x - scatterForm.radius) * ts()), sy((hover.y - scatterForm.radius) * ts()), d, d);
      }
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
    const leftWalls = tool === 'walls' && t !== 'walls';
    const enteredWalls = tool !== 'walls' && t === 'walls';
    tool = t;
    if (leftWalls && hdPreview.isDocked) hdPreview.hide();
    if (enteredWalls) hdPreview.show(true);
    if (leftWalls || enteredWalls) renderPalette();
    for (const [id, b] of toolBtns) b.classList.toggle('active', id === t);
    canvas.style.cursor = t === 'select' ? 'default' : t === 'place' ? 'copy' : 'crosshair';
    reportContext();
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
      if (isHidden(inst)) continue;
      const b = instanceBox(inst);
      if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h) return inst;
    }
    return undefined;
  };
  const placeAt = (wx: number, wy: number, free: boolean) => {
    if (!placeObject) return toast('Pick an object type on the right first', 'error');
    const po = state.effective(placeObject);
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
    setSelection([inst.id]);
    changed();
    renderInspector();
  };

  // ---------------------------------------------------------------- whole parts of the map
  const scatterRecipe = (area: TileRect, count?: number): ScatterRecipe | null => {
    const objects = scatterForm.objects.length ? scatterForm.objects : placeObject ? [placeObject] : [];
    if (!objects.length) {
      toast('Pick the objects to scatter in the Groups tab', 'error');
      return null;
    }
    return {
      items: objects.map((object) => ({ object })), region: area, seed: Math.floor(Math.random() * 1e9), flip: scatterForm.flip,
      ...(count !== undefined ? { count } : { density: scatterForm.density }),
      ...(scatterForm.minDistance > 0 ? { minDistance: scatterForm.minDistance } : {}),
      ...(scatterForm.avoidSolid ? {} : { avoidSolid: false }),
    };
  };
  /** One dab of the scatter brush. */
  const dabAt = (t: { x: number; y: number }): boolean => {
    const r = scatterForm.radius;
    const recipe = scatterRecipe({ x: t.x - r, y: t.y - r, w: r * 2 + 1, h: r * 2 + 1 }, Math.max(1, Math.round(((r * 2 + 1) ** 2 * scatterForm.density) / 100)));
    return !!recipe && scatter(scene, recipe, sizeOf, scatterForm.group).length > 0;
  };
  const copySelection = () => {
    const ids = selected.size ? new Set(selected) : undefined;
    let area = region;
    if (!area && ids) {
      const list = selectedInstances();
      const x = Math.floor(Math.min(...list.map((i) => i.x)) / ts());
      const y = Math.floor(Math.min(...list.map((i) => i.y)) / ts());
      area = { x, y, w: 1, h: 1 };
    }
    if (!area) return toast('Select something first: drag on empty space with the select tool (V)', 'error');
    clipboard = extractRegion(scene, area, { ids: ids ?? new Set(), tiles: !!region });
    toast(`Copied ${clipboard.layers.length ? `${clipboard.w}×${clipboard.h} tiles and ` : ''}${clipboard.instances.length} instance${clipboard.instances.length === 1 ? '' : 's'}`);
  };
  const pasteClipboard = () => {
    if (!clipboard) return;
    const at = hover ?? (region ? { x: region.x + 1, y: region.y + 1 } : { x: 0, y: 0 });
    try {
      snapshot();
      const { instances } = pasteRegion(scene, clipboard, at.x, at.y);
      region = null;
      setSelection(instances.map((i) => i.id));
      setTool('select');
      changed();
      renderSide();
      void loadAssets();
    } catch (err) {
      undoStack.pop();
      toast((err as Error).message, 'error');
    }
  };
  const duplicateSelection = () => {
    const list = selectedInstances();
    if (!list.length) return;
    snapshot();
    const copies = list.map((i): Instance => ({ ...JSON.parse(JSON.stringify(i)) as Instance, id: newGameId(), x: i.x + ts() }));
    scene.instances.push(...copies);
    setSelection(copies.map((i) => i.id));
    changed();
    renderRight();
    renderInspector();
  };
  const deleteSelection = () => {
    if (!selected.size) return;
    snapshot();
    scene.instances = scene.instances.filter((i) => !selected.has(i.id));
    setSelection([]);
    changed();
    renderRight();
    renderInspector();
  };

  // ---------------------------------------------------------------- notes
  const NOTE_RADIUS = 9;
  const openNotes = () => notes.filter((n) => n.scene === scene.name && !n.resolved);
  const loadNotes = async () => {
    try {
      notes = await gameApi.notes();
    } catch {
      notes = [];
    }
    if (rightTab === 'notes') renderRight();
    draw();
  };
  const noteAt = (cx: number, cy: number) => openNotes().find((n) => Math.hypot(panX + n.x * zoom - cx, panY + n.y * zoom - cy) <= NOTE_RADIUS + 2);
  const openNote = (n: MapNote) => {
    void modal('Note on the map', (close) => {
      const text = h('textarea', { rows: 3, value: n.text });
      const act = (fn: () => Promise<unknown>) => async () => {
        try {
          await fn();
          close();
          await loadNotes();
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      };
      return h('div', { class: 'form' },
        h('p', { class: 'muted small' }, `By ${n.author === 'claude' ? 'Claude' : 'you'} at ${n.x}, ${n.y}`),
        text,
        n.reply ? h('p', { class: 'note-reply' }, `Reply: ${n.reply}`) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'small danger', onclick: act(() => gameApi.deleteNote(n.id)) }, 'Delete'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'small', onclick: act(() => gameApi.updateNote(n.id, { text: text.value })) }, 'Save'),
          h('button', { class: 'small primary', onclick: act(() => gameApi.updateNote(n.id, { resolved: true })) }, 'Resolve')));
    });
  };
  const addNote = async (x: number, y: number) => {
    const text = await promptText('Note on the map', 'What should change here? Claude sees this note and where it is.', '');
    if (!text?.trim()) return;
    try {
      await gameApi.createNote({ scene: scene.name, x: Math.round(x), y: Math.round(y), text });
      await loadNotes();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
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
  let dragInst: { items: { inst: Instance; ox: number; oy: number }[]; sx: number; sy: number; moved: boolean } | null = null;
  let marquee: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let marqueeHit: Instance | null = null;
  let dabbing: { x: number; y: number } | null = null;
  let rectDrag: { x0: number; y0: number; x1: number; y1: number; erase: boolean } | null = null;
  let spaceDown = false;

  // The walls of the 2D-HD view: what the map gives by itself, and corrections painted over it.
  /** What the brush paints: null = back to automatic, 0 = flat, n = wall with a front n tiles high. */
  let wallBrush: number | null = 3;
  let wallPainting = false;
  /** What the wall tool is doing: cells, or stretches of a front that stand forward. */
  let wallMode: 'cells' | 'jut' = 'cells';
  let jutDepth = 10;
  let jutDrag: { foot: number; x0: number; x1: number; cell: number } | null = null;
  let wallLast: { x: number; y: number } | null = null;
  let wallCache: { scene: Scene; rows: number; cells: (WallCell | null)[] } | null = null;
  function wallCells(): (WallCell | null)[] {
    const atm = scene.atmosphere;
    const rows = Math.round(resolveHd(state.game!.hd, atm?.hd && !atm.hd.off ? atm.hd : undefined, atm?.ambient)?.wallRows ?? 3);
    if (wallCache?.scene !== scene || wallCache.rows !== rows) {
      const water = atm?.reflections?.sprites?.length ? { cols: scene.cols, rows: scene.rows, grid: new Uint8Array(scene.cols * scene.rows), cells: [] } : null;
      if (water) addWaterActors(water, previewActors(), atm!.reflections!.sprites!, ts());
      wallCache = { scene, rows, cells: findWalls(scene.layers, scene.cols, scene.rows, resolverFor(), rows, scene.hdCells, water?.grid, scene.hdJuts, ts()) };
    }
    return wallCache.cells;
  }
  const paintWallCell = (x: number, y: number, value: number | null): boolean => {
    if (x < 0 || y < 0 || x >= scene.cols || y >= scene.rows) return false;
    const key = `${x},${y}`;
    if ((scene.hdCells?.[key] ?? null) === value) return false;
    if (value === null) {
      delete scene.hdCells![key];
      if (!Object.keys(scene.hdCells!).length) delete scene.hdCells;
    } else (scene.hdCells ??= {})[key] = value;
    return true;
  };
  /** Paints from the last cell to this one, so a fast drag leaves no gaps. */
  const wallStroke = (t: { x: number; y: number }, erase: boolean): boolean => {
    const from = wallLast ?? t;
    const steps = Math.max(Math.abs(t.x - from.x), Math.abs(t.y - from.y), 1);
    let any = false;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(from.x + ((t.x - from.x) * i) / steps);
      const y = Math.round(from.y + ((t.y - from.y) * i) / steps);
      if (paintWallCell(x, y, erase ? null : wallBrush)) any = true;
    }
    wallLast = t;
    return any;
  };

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = world(e);
    const t = tileAt(p.x, p.y);
    if (e.button === 1 || spaceDown || (e.button === 2 && (tool === 'select' || tool === 'place' || tool === 'note' || tool === 'scatter'))) {
      panning = { x: e.clientX, y: e.clientY, px: panX, py: panY };
      return;
    }
    if (tool === 'select' || tool === 'note') {
      const r = canvas.getBoundingClientRect();
      const pin = noteAt(e.clientX - r.left, e.clientY - r.top);
      if (pin) return openNote(pin);
    }
    if (tool === 'note') {
      void addNote(p.x, p.y);
      return;
    }
    if (tool === 'scatter') {
      if (scatterForm.mode === 'area') {
        rectDrag = { x0: t.x, y0: t.y, x1: t.x, y1: t.y, erase: false };
        draw();
        return;
      }
      snapshot();
      dabbing = t;
      if (dabAt(t)) changed();
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
    if (tool === 'walls' && wallMode === 'jut') {
      const inMap = t.x >= 0 && t.y >= 0 && t.x < scene.cols && t.y < scene.rows;
      const c = inMap ? wallCells()[t.y * scene.cols + t.x] : null;
      if (!c || !('face' in c)) return;
      const foot = t.y + c.face;
      hdPreview.look((t.x + 0.5) * ts(), (foot + 0.5) * ts());
      if (e.button === 2) {
        const kept = (scene.hdJuts ?? []).filter((j) => !(j.foot === foot && p.x >= j.x && p.x < j.x + j.w));
        if (kept.length !== (scene.hdJuts ?? []).length) {
          snapshot();
          if (kept.length) scene.hdJuts = kept;
          else delete scene.hdJuts;
          changed();
          renderPalette();
        }
        return;
      }
      jutDrag = { foot, x0: p.x, x1: p.x, cell: t.x };
      draw();
      return;
    }
    if (tool === 'walls') {
      snapshot();
      wallPainting = true;
      wallLast = null;
      hdPreview.look((t.x + 0.5) * ts(), (t.y + 0.5) * ts());
      if (wallStroke(t, e.button === 2)) changed();
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
      region = null;
      if (e.shiftKey) {
        // Shift: a click adds or takes away one instance, a drag selects an area even on a crowded map.
        marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        marqueeHit = hit ?? null;
      } else if (hit) {
        if (!selected.has(hit.id)) setSelection([hit.id]);
        dragInst = { items: selectedInstances().map((inst) => ({ inst, ox: inst.x, oy: inst.y })), sx: p.x, sy: p.y, moved: false };
      } else {
        setSelection([]);
        marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        marqueeHit = null;
      }
      renderInspector();
      draw();
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = world(e);
    const t = tileAt(p.x, p.y);
    if (!hover || hover.x !== t.x || hover.y !== t.y) {
      hover = t;
      reportContext();
    }
    status.textContent = `tile ${t.x}, ${t.y} · px ${Math.floor(p.x)}, ${Math.floor(p.y)}${layer() ? ` · layer ${layer()!.name}${layer()!.solid ? ' (solid)' : ''}` : ''}`;
    if (panning) {
      panX = panning.px + e.clientX - panning.x;
      panY = panning.py + e.clientY - panning.y;
      draw();
      return;
    }
    if (marquee) {
      marquee.x1 = p.x;
      marquee.y1 = p.y;
      draw();
      return;
    }
    if (dabbing) {
      if (Math.hypot(t.x - dabbing.x, t.y - dabbing.y) >= Math.max(1, scatterForm.radius)) {
        dabbing = t;
        if (dabAt(t)) changed();
      }
      draw();
      return;
    }
    if (jutDrag) {
      jutDrag.x1 = p.x;
      draw();
      return;
    }
    if (wallPainting) {
      if (wallStroke(t, (e.buttons & 2) !== 0)) changed();
      else draw();
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
      const first = dragInst.items[0];
      if (first && (Math.round(first.ox + dx) !== first.inst.x || Math.round(first.oy + dy) !== first.inst.y)) {
        if (!dragInst.moved) snapshot();
        dragInst.moved = true;
        for (const item of dragInst.items) {
          item.inst.x = Math.round(item.ox + dx);
          item.inst.y = Math.round(item.oy + dy);
        }
        changed();
        if (dragInst.items.length === 1) renderInspector();
        reportContext();
      }
      return;
    }
    draw();
  });
  const endPointer = (e?: PointerEvent) => {
    if (marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1);
      const x1 = Math.max(marquee.x0, marquee.x1);
      const y1 = Math.max(marquee.y0, marquee.y1);
      marquee = null;
      if (x1 - x0 >= 2 || y1 - y0 >= 2) {
        const inside = scene.instances.filter((i) => {
          if (isHidden(i)) return false;
          const b = instanceBox(i);
          return b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0;
        }).map((i) => i.id);
        region = { x: Math.floor(x0 / ts()), y: Math.floor(y0 / ts()), w: Math.ceil(x1 / ts()) - Math.floor(x0 / ts()), h: Math.ceil(y1 / ts()) - Math.floor(y0 / ts()) };
        setSelection(e?.shiftKey ? [...new Set([...selected, ...inside])] : inside);
        renderInspector();
      } else if (marqueeHit) {
        const id = marqueeHit.id;
        setSelection(selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id]);
        renderInspector();
      }
      marqueeHit = null;
      draw();
    }
    if (dabbing) {
      dabbing = null;
      renderRight();
    }
    if (rectDrag) {
      const x0 = Math.min(rectDrag.x0, rectDrag.x1);
      const y0 = Math.min(rectDrag.y0, rectDrag.y1);
      const x1 = Math.max(rectDrag.x0, rectDrag.x1);
      const y1 = Math.max(rectDrag.y0, rectDrag.y1);
      if (tool === 'scatter') {
        rectDrag = null;
        const recipe = scatterRecipe({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
        if (recipe) {
          snapshot();
          const made = scatterIntoGroup(scene, scatterForm.group, recipe, sizeOf);
          toast(`Placed ${made.length} in group ${scatterForm.group}`);
          changed();
          renderRight();
        }
        draw();
        return;
      }
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setTile(x, y, rectDrag.erase ? -1 : brush.tiles[((y - y0) % brush.h) * brush.w + ((x - x0) % brush.w)]);
      rectDrag = null;
      changed();
    }
    painting = false;
    wallPainting = false;
    if (jutDrag) {
      const d = jutDrag;
      jutDrag = null;
      // A click takes the whole cell; a drag, what was dragged over.
      const dragged = Math.abs(d.x1 - d.x0) >= 2;
      const x = Math.max(0, Math.round(dragged ? Math.min(d.x0, d.x1) : d.cell * ts()));
      const w = Math.round(dragged ? Math.abs(d.x1 - d.x0) : ts());
      snapshot();
      (scene.hdJuts ??= []).push({ x, w, foot: d.foot, depth: jutDepth });
      changed();
      renderPalette();
    }
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
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copySelection();
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      pasteClipboard();
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setTool('select');
      setSelection(scene.instances.filter((i) => !isHidden(i)).map((i) => i.id));
      renderInspector();
      draw();
      return;
    }
    if (selected.size && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (selected.size && mod && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (selected.size && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? ts() : 1;
      snapshot();
      for (const sel of selectedInstances()) {
        if (e.key === 'ArrowLeft') sel.x -= step;
        if (e.key === 'ArrowRight') sel.x += step;
        if (e.key === 'ArrowUp') sel.y -= step;
        if (e.key === 'ArrowDown') sel.y += step;
      }
      changed();
      renderInspector();
      reportContext();
      return;
    }
    if (mod) return;
    const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
    if (t) setTool(t.id);
    if (e.key === '#') {
      showGrid = !showGrid;
      draw();
    }
    if (e.key.toLowerCase() === 'l') setGameLook(!showGameLook);
    if (e.key === 'Escape') {
      region = null;
      setSelection([]);
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
        ...(!l.solid ? [h('button', { class: `chip solid-chip${l.painted ? ' on' : ''}`, title: 'Painted ground: one picture, every cell its own piece. 2D-HD raises no walls from it (the objects stand up instead; hdCells still apply)', onclick: (e: Event) => { e.stopPropagation(); snapshot(); if (l.painted) delete l.painted; else l.painted = true; changed(); renderLayers(); } }, 'painted')] : []),
      ));
    });
    layersBox.append(list,
      h('div', { class: 'panel-actions' },
        iconButton('up', 'Move layer up (drawn later)', () => { if (activeLayer < scene.layers.length - 1) { snapshot(); const [l] = scene.layers.splice(activeLayer, 1); scene.layers.splice(++activeLayer, 0, l); changed(); renderLayers(); } }, { class: 'icon-btn tiny' }),
        iconButton('down', 'Move layer down', () => { if (activeLayer > 0) { snapshot(); const [l] = scene.layers.splice(activeLayer, 1); scene.layers.splice(--activeLayer, 0, l); changed(); renderLayers(); } }, { class: 'icon-btn tiny' }),
        h('label', { class: 'inline small', title: 'Draw order: layers with z above 0 are drawn in front of objects' }, 'z',
          h('input', { type: 'number', class: 'num tiny-num', value: String(layer()?.z ?? activeLayer - 10), onchange: (e: Event) => { const l = layer(); if (!l) return; snapshot(); l.z = Number((e.target as HTMLInputElement).value); changed(); } })),
        h('label', { class: 'inline small', title: 'Parallax: 1 = moves with the world (default), below 1 = far layer that scrolls slower, above 1 = foreground. Shown in Play; the editor draws layers in place' }, 'parallax',
          h('input', { type: 'number', class: 'num tiny-num', step: '0.05', placeholder: '1', value: layer()?.parallax === undefined ? '' : String(layer()!.parallax), onchange: (e: Event) => { const l = layer(); if (!l) return; const v = (e.target as HTMLInputElement).value.trim(); snapshot(); if (v === '' || Number(v) === 1 || !Number.isFinite(Number(v))) delete l.parallax; else l.parallax = Number(v); changed(); } })),
        h('span', { class: 'spacer' }),
        iconButton('trash', 'Delete layer', () => { if (scene.layers.length <= 1) return toast('A scene needs at least one layer', 'error'); snapshot(); scene.layers.splice(activeLayer, 1); activeLayer = Math.max(0, activeLayer - 1); changed(); renderLayers(); }, { class: 'icon-btn tiny' }),
      ),
    );
  }

  function renderWallBrush(): void {
    const choose = (v: number | null) => { wallBrush = v; renderPalette(); };
    const chip = (label: string, v: number | null, title: string) => h('button', { type: 'button', class: `chip${wallBrush === v ? ' on' : ''}`, title, onclick: () => choose(v) }, label);
    const count = Object.keys(scene.hdCells ?? {}).length;
    const dflt = HD_FIELDS.find((f) => f.key === 'wallRows')!.dflt;
    const mode = (m: typeof wallMode, label: string, title: string) => h('button', { type: 'button', class: `chip${wallMode === m ? ' on' : ''}`, title, onclick: () => { wallMode = m; renderPalette(); } }, label);
    paletteBox.append(h('div', { class: 'panel-title' }, '2D-HD walls'), h('div', { class: 'chips' }, mode('cells', 'Height', 'Which cells are walls, and how tall'), mode('jut', 'Protrusion', 'Parts of a wall front that stand forward of it: piers and buttresses')));
    if (wallMode === 'jut') {
      const juts = scene.hdJuts?.length ?? 0;
      paletteBox.append(
        h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Drag across a wall front (orange cells in Height) to make that stretch stand forward; a click takes a whole cell. Right-click removes one.'),
        h('div', { class: 'panel-title', style: 'margin-top:10px' }, 'Stands forward by (px)'),
        h('div', { class: 'chips' }, ...[4, 6, 10, 14, 20, 28].map((d) => h('button', { type: 'button', class: `chip${jutDepth === d ? ' on' : ''}`, onclick: () => { jutDepth = d; renderPalette(); } }, String(d)))),
        h('button', { class: 'small', style: 'margin-top:10px', disabled: !juts, title: 'Removes every protrusion of this scene', onclick: () => { snapshot(); delete scene.hdJuts; changed(); renderPalette(); } }, juts ? `Clear ${juts} protrusion${juts === 1 ? '' : 's'}` : 'No protrusions yet'),
      );
      return;
    }
    paletteBox.append(
      h('p', { class: 'muted small', style: 'margin-top:8px' }, 'Paint on the map and watch the corner view. Right-click puts a cell back to automatic.'),
      h('div', { class: 'chips' },
        chip('Automatic', null, 'Removes the correction: the map decides'),
        chip('Flat', 0, 'This cell stays on the ground, even if it looks like a wall to the automatic detection'),
      ),
      h('div', { class: 'panel-title', style: 'margin-top:10px' }, 'Wall, front height'),
      h('div', { class: 'chips' }, ...Array.from({ length: HD_CELL_MAX_ROWS }, (_, i) => chip(String(i + 1), i + 1, `A wall whose front is ${i + 1} tile${i ? 's' : ''} high. The whole column of wall cells takes this height; the cells above the front become its top`))),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, h('span', { style: 'color:#feae34' }, '■'), ' front  ', h('span', { style: 'color:#4fa4ff' }, '■'), ' top  ', h('span', { style: 'color:#e43b44' }, '■'), ` kept flat. White outline: corrected by hand. Automatic height: ${dflt} rows, or the scene's Wall rows.`),
      h('button', { class: 'small', disabled: !count, title: 'Removes every correction of this scene', onclick: () => { snapshot(); delete scene.hdCells; changed(); renderPalette(); } }, count ? `Clear ${count} correction${count === 1 ? '' : 's'}` : 'No corrections yet'),
    );
  }

  function renderPalette(): void {
    clear(paletteBox);
    if (tool === 'walls') return renderWallBrush();
    const tilesets = state.sprites.filter((s) => s.grid);
    const tsSel = h('select', { onchange: async () => {
      snapshot();
      if (tsSel.value) {
        scene.tileset = tsSel.value;
        setTileSize(scene, state.sprite(tsSel.value)?.grid?.width ?? scene.tileSize);
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
    // Tilesets with rules show only the paintable tiles (the rest are generated pieces).
    const paintable = state.game!.tilesets?.[tileset.name]?.paintable;
    const rows = Math.max(1, Math.min(Math.floor(tileset.height / g.height), paintable ? Math.ceil(paintable / cols) : Infinity));
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
      h('div', { class: 'palette-links' },
        h('button', { class: 'small', title: 'Autotiling, big textures, random variants, animated tiles and edge overlays for this tileset (game.json tilesets, MCP set_tileset_rules)', onclick: () => void openTileRules(tileset!) },
          icon('grid', 13), `Tile rules${state.game!.tilesets?.[tileset.name] ? ` (${(state.game!.tilesets[tileset.name].rules?.length ?? 0) + (state.game!.tilesets[tileset.name].edges?.length ?? 0)})` : ''}…`),
        h('a', { class: 'small', href: `#/edit/${encodeURIComponent(tileset.name)}` }, 'Edit tileset sprite →')));
    redraw();
  }

  // ---------------------------------------------------------------- right side: hierarchy / objects / scene tabs + inspector
  type RightTab = 'hierarchy' | 'objects' | 'scene' | 'groups' | 'notes';
  let rightTab: RightTab = 'hierarchy';
  let filter = '';
  const tabsBar = h('div', { class: 'right-tabs' });
  const hierarchyBox = h('div', { class: 'panel hierarchy' });
  const objectsBox = h('div', { class: 'panel' });
  const inspectorBox = h('div', { class: 'panel' });
  const settingsBox = h('div', { class: 'panel' });
  const groupsBox = h('div', { class: 'panel' });
  const notesBox = h('div', { class: 'panel' });
  const tabBody = h('div', { class: 'right-tab-body' });
  rightSide.append(tabsBar, tabBody, inspectorBox);

  function renderRight(): void {
    clear(tabsBar);
    const noteCount = openNotes().length;
    const tabs: [RightTab, string][] = [['hierarchy', `Hierarchy (${scene.instances.length})`], ['objects', 'Add'], ['groups', 'Groups'], ['notes', noteCount ? `Notes (${noteCount})` : 'Notes'], ['scene', 'Scene']];
    for (const [id, label] of tabs) tabsBar.append(h('button', { class: `right-tab${rightTab === id ? ' active' : ''}`, onclick: () => { rightTab = id; renderRight(); } }, label));
    clear(tabBody);
    if (rightTab === 'hierarchy') {
      renderHierarchy();
      tabBody.append(hierarchyBox);
    } else if (rightTab === 'objects') {
      renderObjectList();
      tabBody.append(objectsBox);
    } else if (rightTab === 'groups') {
      renderGroups();
      tabBody.append(groupsBox);
    } else if (rightTab === 'notes') {
      renderNotes();
      tabBody.append(notesBox);
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
    setSelection(id ? [id] : []);
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
        const obj = state.effective(inst.object);
        const talk = inst.props?.dialogue;
        rows.append(h('div', {
          class: `hier-row${selected.has(inst.id) ? ' active' : ''}`,
          title: `${inst.object} at ${inst.x}, ${inst.y}${inst.group ? ` · group ${inst.group}` : ''}`,
          onclick: (e: MouseEvent) => {
            if (!e.shiftKey) return select(inst.id, true);
            setSelection(selected.has(inst.id) ? [...selected].filter((id) => id !== inst.id) : [...selected, inst.id]);
            renderHierarchy();
            renderInspector();
            draw();
          },
        },
          h('span', { class: 'hier-thumb' }, spr ? h('img', { src: api.previewUrl(spr.name, spr.rev, 1), alt: '' }) : h('span', { class: 'txt-badge' }, obj?.text !== undefined ? 'Aa' : '?')),
          h('span', { class: 'hier-name' }, inst.name ?? inst.object),
          inst.activeIf ? h('span', { class: 'hier-cond', title: `Only while: ${inst.activeIf}` }, '?') : null,
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
    if (selected.size > 1) {
      renderBulkInspector();
      return;
    }
    if (!inst) {
      inspectorBox.append(h('p', { class: 'muted small' }, 'Click an instance in the Hierarchy or on the map (move tool, V) to see its properties. Delete removes it, Ctrl+D duplicates, arrows nudge. Shift+click adds one, Shift+drag selects an area; Ctrl+C and Ctrl+V copy them, tiles included, even to another scene.'));
      return;
    }
    const obj = state.effective(inst.object);
    const edit = (fn: () => void) => { snapshot(); fn(); changed(); };
    const num = (label: string, get: () => number, set: (v: number) => void) => {
      const inp = h('input', { type: 'number', class: 'num', value: String(get()), onchange: () => edit(() => set(Number(inp.value) || 0)) });
      return h('label', {}, label, inp);
    };
    // Its own hitbox (collision, y-sort, 2D-HD foot), over the object type's: all empty = the type's.
    const instanceHitboxRow = () => {
      const keys4 = ['x', 'y', 'w', 'h'] as const;
      const inputs = keys4.map((k) => h('input', { type: 'number', class: 'num tiny-num', value: inst.hitbox ? String(inst.hitbox[k]) : '', placeholder: obj?.hitbox ? String(obj.hitbox[k]) : '', onchange: () => edit(() => {
        const vals = inputs.map((i) => i.value.trim());
        if (vals.every((v) => v === '')) delete inst.hitbox;
        else {
          const base = inst.hitbox ?? obj?.hitbox ?? { x: 0, y: 0, w: 8, h: 8 };
          const n = (i: number) => (vals[i] === '' ? base[keys4[i]!] : Number(vals[i]));
          inst.hitbox = { x: n(0), y: n(1), w: Math.max(1, n(2)), h: Math.max(1, n(3)) };
        }
      }) }) as HTMLInputElement);
      return h('label', { title: 'Collision box of this instance, relative to it (also the y-sort and the 2D-HD foot). Empty = the object type\'s' }, 'Hitbox', h('div', { class: 'row4' }, ...inputs));
    };
    const parse = parseValue;
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

    // Active if: the instance exists in the game only while this expression is true (towns that grow, upgrades).
    function activeIfRow(): HTMLElement {
      const err = h('div', { class: 'small problem' });
      const showErr = (src: string) => (err.textContent = src.trim() ? (checkExpr(src.trim()) ?? '') : '');
      const input = h('input', { type: 'text', value: inst!.activeIf ?? '', placeholder: 'always (e.g. inn_lv >= 1, quest_bram == 2)', spellcheck: false,
        oninput: () => showErr(input.value),
        onchange: () => edit(() => {
          const v = input.value.trim();
          if (v && !checkExpr(v)) inst!.activeIf = v;
          else if (!v) delete inst!.activeIf;
          renderRight();
        }),
      });
      showErr(input.value);
      return h('label', { class: 'inspector-activeif', title: 'Expression: the instance exists in the game only while it is true. Checked when the scene starts and continuously while it runs. Variables, db("table", id, "column"), fn("name").' }, 'Active if', input, err);
    }

    const props = h('div', { class: 'props' });
    const keys = new Set([...Object.keys(obj?.properties ?? {}), ...Object.keys(inst.props ?? {})]);
    keys.delete('dialogue');
    for (const k of keys) {
      const def = obj?.properties[k];
      const cur = inst.props?.[k];
      const inp = h('input', { type: 'text', title: VALUE_HINT, value: cur !== undefined ? formatValue(cur) : '', placeholder: def !== undefined ? formatValue(def) : '', oninput: () => { setProp(k, inp.value === '' ? undefined : parse(inp.value)); changed(); } });
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
        activeIfRow(),
        h('label', { title: 'Named group inside this scene, for working on many instances at once (Groups tab). The game ignores it.' }, 'Group', h('input', { type: 'text', value: inst.group ?? '', placeholder: 'none', spellcheck: false, onchange: (e: Event) => edit(() => { const v = (e.target as HTMLInputElement).value.trim(); if (v) inst.group = v; else delete inst.group; }) })),
        h('div', { class: 'row2' }, num('x', () => inst.x, (v) => (inst.x = v)), num('y', () => inst.y, (v) => (inst.y = v))),
        instanceHitboxRow(),
        h('label', { title: '2D-HD: lies on the ground, stands up facing the camera, or stands as an upright surface like a wall front (its top comes towards the camera: for low wall fronts). Automatic = the object type\'s' }, 'HD pose', h('select', { onchange: (e: Event) => edit(() => {
          const v = (e.target as HTMLSelectElement).value;
          if (v === 'flat' || v === 'stand' || v === 'wall') inst.hdPose = v; else delete inst.hdPose;
        }) },
          h('option', { value: '', selected: !inst.hdPose }, 'Automatic'),
          h('option', { value: 'stand', selected: inst.hdPose === 'stand' }, 'Stands up'),
          h('option', { value: 'flat', selected: inst.hdPose === 'flat' }, 'Lies flat'),
          h('option', { value: 'wall', selected: inst.hdPose === 'wall' }, 'Wall front'))),
        h('label', { title: 'Where the picture meets the ground, points x,y relative to the instance, left to right (a painted object at an angle): each column stands on the ground under it. Empty = none' }, 'Foot line', h('input', { type: 'text', value: (inst.footLine ?? []).map((p) => p.join(',')).join(' '), placeholder: 'x,y x,y', spellcheck: false, onchange: (e: Event) => {
          const input = e.target as HTMLInputElement;
          const pts = input.value.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite)) as [number, number][];
          const problem = pts.length >= 2 ? footLineProblem(pts) : null;
          input.setCustomValidity(problem ?? '');
          if (problem) { input.reportValidity(); return; }
          edit(() => { if (pts.length >= 2) inst.footLine = pts; else delete inst.footLine; });
        } })),
        h('label', { title: '2D-HD: a flat instance lies this many px above the ground (the top of a wall). Empty or 0 = on the ground' }, 'HD lift', h('input', { type: 'number', class: 'num', min: '0', value: inst.hdLift ? String(inst.hdLift) : '', placeholder: obj?.hdLift ? String(obj.hdLift) : '0', onchange: (e: Event) => edit(() => { const v = Number((e.target as HTMLInputElement).value); if (v > 0) inst.hdLift = v; else delete inst.hdLift; }) })),
        h('div', {}, h('div', { class: 'muted small' }, keys.size ? 'Properties (empty = default of the type)' : 'Properties'), props,
          h('button', { class: 'small ghost', onclick: async () => {
            const k = await promptText('Instance property', 'Name (only this instance, e.g. hp, line, reward)', '');
            if (!k) return;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return toast('Invalid name', 'error');
            edit(() => setProp(k, 0));
            renderInspector();
          } }, icon('plus', 12), 'Property')),
        h('div', {}, h('div', { class: 'muted small' }, 'Components (empty = value of the object type)'), instanceComponents(inst, obj, edit, () => renderInspector())),
        lightEditor({ before: snapshot, changed, get: () => inst.light, set: (v) => { if (v) inst.light = v; else delete inst.light; },
          inherited: { light: obj?.light, from: `from ${inst.object}` }, allowOff: true }),
        h('div', { class: 'actions' },
          obj ? h('a', { class: 'small', href: `#/objects/${encodeURIComponent(inst.object)}` }, `edit ${inst.object} →`) : h('span', { class: 'danger-text small' }, 'unknown type'),
          iconButton('target', `Find what uses ${inst.object}`, () => void openUsages('object', inst.object), { class: 'icon-btn tiny' }),
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

  function renderBulkInspector(): void {
    const list = selectedInstances();
    const kinds = new Map<string, number>();
    for (const i of list) kinds.set(i.object, (kinds.get(i.object) ?? 0) + 1);
    const groups = new Set(list.map((i) => i.group ?? ''));
    const conds = new Set(list.map((i) => i.activeIf ?? ''));
    const apply = (fn: (i: Instance) => void) => {
      snapshot();
      for (const i of selectedInstances()) fn(i);
      changed();
      renderRight();
    };
    inspectorBox.append(h('div', { class: 'form' },
      h('p', { class: 'small' }, `${list.length} instances selected`, h('span', { class: 'muted' }, ` · ${[...kinds].slice(0, 4).map(([k, n]) => `${n} ${k}`).join(', ')}${kinds.size > 4 ? '…' : ''}`)),
      h('label', {}, 'Group', h('input', { type: 'text', value: groups.size === 1 ? [...groups][0] : '', placeholder: groups.size > 1 ? 'several' : 'none', spellcheck: false, onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim(); apply((i) => { if (v) i.group = v; else delete i.group; }); } })),
      h('label', { title: 'Expression: these instances exist only while it is true' }, 'Active if', h('input', { type: 'text', value: conds.size === 1 ? [...conds][0] : '', placeholder: conds.size > 1 ? 'several' : 'always', spellcheck: false, onchange: (e: Event) => {
        const v = (e.target as HTMLInputElement).value.trim();
        const err = v ? checkExpr(v) : null;
        if (err) return toast(err, 'error');
        apply((i) => { if (v) i.activeIf = v; else delete i.activeIf; });
      } })),
      h('div', { class: 'actions' },
        h('button', { class: 'small', title: 'Copy (Ctrl+C)', onclick: () => copySelection() }, icon('copy', 13), 'Copy'),
        h('button', { class: 'small', title: 'Duplicate (Ctrl+D)', onclick: () => duplicateSelection() }, 'Duplicate'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'small danger', onclick: () => deleteSelection() }, icon('trash', 13), 'Remove')),
    ));
  }

  function renderGroups(): void {
    clear(groupsBox);
    groupsBox.append(h('div', { class: 'panel-title' }, 'Groups'));
    const groups = listGroups(scene);
    if (!groups.length) groupsBox.append(h('p', { class: 'muted small' }, 'A group is a named set of instances: all the trees of a map, the decor of a room. Scatter some below, or set Group in the inspector.'));
    for (const g of groups) {
      groupsBox.append(h('div', { class: 'group-row' },
        iconButton(hiddenGroups.has(g.name) ? 'eyeoff' : 'eye', hiddenGroups.has(g.name) ? 'Show in the editor' : 'Hide in the editor (the game still has them)', () => { if (hiddenGroups.has(g.name)) hiddenGroups.delete(g.name); else hiddenGroups.add(g.name); renderGroups(); draw(); }, { class: 'icon-btn tiny' }),
        h('button', { class: 'ghost small group-name', title: 'Select the whole group', onclick: () => { setTool('select'); setSelection(scene.instances.filter((i) => i.group === g.name).map((i) => i.id)); renderInspector(); draw(); } }, `${g.name} (${g.count})`),
        g.scatters ? iconButton('swap', 'Redo: a new random layout in the same areas', () => {
          snapshot();
          regenerateGroup(scene, g.name, sizeOf, Math.floor(Math.random() * 1e9));
          setSelection([]);
          changed();
          renderRight();
          renderInspector();
        }, { class: 'icon-btn tiny' }) : null,
        iconButton('pencil', 'Rename', async () => {
          const to = await promptText('Rename group', 'Name', g.name);
          if (!to || to === g.name) return;
          try {
            snapshot();
            renameGroup(scene, g.name, to);
            changed();
            renderRight();
          } catch (err) {
            undoStack.pop();
            toast((err as Error).message, 'error');
          }
        }, { class: 'icon-btn tiny' }),
        iconButton('trash', 'Delete the group and its instances', () => {
          snapshot();
          deleteGroup(scene, g.name);
          setSelection([]);
          changed();
          renderRight();
          renderInspector();
        }, { class: 'icon-btn tiny' }),
      ));
    }
    const objectsSel = h('select', { multiple: true, size: 5, 'aria-label': 'Objects to scatter', onchange: () => { scatterForm.objects = [...objectsSel.selectedOptions].map((o) => o.value); } },
      ...state.game!.objects.filter((o) => !o.hud).map((o) => h('option', { value: o.name, selected: scatterForm.objects.includes(o.name) }, o.name)));
    const numberField = (label: string, title: string, get: () => number, set: (v: number) => void, attrs: Record<string, string> = {}) => {
      const inp = h('input', { type: 'number', class: 'num', min: '0', value: String(get()), ...attrs, onchange: () => set(Math.max(0, Number(inp.value) || 0)) });
      return h('label', { title }, label, inp);
    };
    const modeSel = h('select', { onchange: () => { scatterForm.mode = modeSel.value as 'brush' | 'area'; draw(); } },
      h('option', { value: 'brush', selected: scatterForm.mode === 'brush' }, 'Brush: paint where you drag'),
      h('option', { value: 'area', selected: scatterForm.mode === 'area' }, 'Area: can be redone later'));
    const flipIn = h('input', { type: 'checkbox', checked: scatterForm.flip, onchange: () => { scatterForm.flip = flipIn.checked; } });
    const avoidIn = h('input', { type: 'checkbox', checked: scatterForm.avoidSolid, onchange: () => { scatterForm.avoidSolid = avoidIn.checked; } });
    const groupIn = h('input', { type: 'text', value: scatterForm.group, spellcheck: false, onchange: () => { scatterForm.group = groupIn.value.trim() || 'decor'; } });
    groupsBox.append(h('div', { class: 'panel-title', style: 'margin-top:12px' }, 'Scatter', h('span', { class: 'spacer' }), h('button', { class: 'small', onclick: () => setTool('scatter') }, 'Use (S)')),
      h('div', { class: 'form' },
        h('label', { title: 'Hold Ctrl or Cmd for several' }, 'Objects', objectsSel),
        h('label', {}, 'Into group', groupIn),
        h('label', {}, 'How', modeSel),
        h('div', { class: 'row3 atm-row3' },
          numberField('Density', 'How many per 100 tiles', () => scatterForm.density, (v) => { scatterForm.density = v; }),
          numberField('Min. gap', 'Pixels between bases (0 = one tile)', () => scatterForm.minDistance, (v) => { scatterForm.minDistance = v; }),
          numberField('Radius', 'Size of the brush, in tiles', () => scatterForm.radius, (v) => { scatterForm.radius = Math.round(v); draw(); })),
        h('label', { class: 'inline' }, flipIn, 'Mirror about half'),
        h('label', { class: 'inline' }, avoidIn, 'Not on solid tiles')));
  }

  function renderNotes(): void {
    clear(notesBox);
    notesBox.append(h('div', { class: 'panel-title' }, 'Notes', h('span', { class: 'spacer' }), h('button', { class: 'small', onclick: () => setTool('note') }, 'Add (N)')));
    const list = openNotes();
    if (!list.length) notesBox.append(h('p', { class: 'muted small' }, 'Click on the map with the note tool to say what should change there. Claude reads your notes and where they are.'));
    list.forEach((n, i) => notesBox.append(h('div', { class: 'note-row', role: 'button', tabindex: 0, onclick: () => {
      panX = Math.round(wrap.clientWidth / 2 - n.x * zoom);
      panY = Math.round(wrap.clientHeight / 2 - n.y * zoom);
      draw();
      openNote(n);
    } },
      h('strong', {}, `${i + 1}. `), n.text,
      n.reply ? h('div', { class: 'note-reply small' }, n.reply) : null)));
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
    const bg = colorInput(scene.background, (v) => { scene.background = v; changed(); }, { fallback: state.game!.background || '#181425', placeholder: `${state.game!.background} (game)`, allowEmpty: true });
    const vars = h('div', { class: 'props' });
    const parse = parseValue;
    for (const [k, v] of Object.entries(scene.variables)) {
      const inp = h('input', { type: 'text', title: VALUE_HINT, value: formatValue(v), oninput: () => { scene.variables[k] = parse(inp.value); changed(); } });
      vars.append(h('div', { class: 'prop-row' }, h('code', {}, `scene.${k}`), inp, iconButton('close', 'Remove', () => { snapshot(); delete scene.variables[k]; changed(); renderSettings(); }, { class: 'icon-btn tiny' })));
    }
    settingsBox.append(
      h('div', { class: 'panel-title' }, 'Scene'),
      h('div', { class: 'form' },
        h('div', { class: 'row2' }, h('label', {}, 'Width (tiles)', colsIn), h('label', {}, 'Height (tiles)', rowsIn)),
        h('p', { class: 'muted small' }, `${scene.cols * ts()}×${scene.rows * ts()} px · tiles ${ts()} px · screen ${state.game!.width}×${state.game!.height}`),
        h('label', { title: 'Empty = the game background color' }, 'Background', bg),
        backgroundsCard(),
        h('label', { title: 'Music when this scene starts (crossfades from the previous one; the same track keeps playing). Import audio in the Game tab.' }, 'Music', h('select', { onchange: (e: Event) => { snapshot(); const v = (e.target as HTMLSelectElement).value; if (v) scene.music = v; else delete scene.music; changed(); } },
          h('option', { value: '', selected: !scene.music }, '— keep what is playing —'),
          h('option', { value: '-', selected: scene.music === '-' }, '— silence —'),
          ...state.audio.map((a) => h('option', { value: a, selected: scene.music === a }, a)),
          ...(scene.music && scene.music !== '-' && !state.audio.includes(scene.music) ? [h('option', { value: scene.music, selected: true }, `${scene.music} (missing)`)] : []))),
        ambienceCard(),
        h('label', { class: 'inline', title: 'Instances lower on screen are drawn in front: depth for top-down games and RPGs' },
          h('input', { type: 'checkbox', checked: !!scene.ySort, onchange: (e: Event) => { snapshot(); if ((e.target as HTMLInputElement).checked) scene.ySort = true; else delete scene.ySort; changed(); } }),
          'Sort by Y (top-down depth)'),
        h('label', { class: 'inline', title: 'Coming back to this scene (e.g. after a battle) keeps positions, opened chests, defeated enemies and instance properties. Restart Scene forgets.' },
          h('input', { type: 'checkbox', checked: !!scene.persistent, onchange: (e: Event) => { snapshot(); if ((e.target as HTMLInputElement).checked) scene.persistent = true; else delete scene.persistent; changed(); } }),
          'Remember instances when leaving'),
        atmosphereEditor({ audio: () => state.audio, before: snapshot, changed, get: () => scene.atmosphere, set: (v) => { if (v) scene.atmosphere = v; else delete scene.atmosphere; }, gameHd: () => state.game?.hd, showHd: () => hdPreview.show(),
          sprites: () => state.sprites.filter((sp) => !sp.grid).map((sp) => sp.name), rerender: () => void loadAssets() }),
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

  /** Parallax background images, back to front (same fields as update_scene backgrounds). */
  /** The sounds that loop while the scene lasts: wind, crickets, dripping. */
  function ambienceCard(): HTMLElement {
    const list = scene.ambience ?? [];
    const box = h('div', { class: 'bg-list' }, h('div', { class: 'small', title: 'Sounds that loop while this scene lasts, fading across scene changes. Heard in Play' }, 'Ambient sounds'));
    const save = () => {
      if (list.length) scene.ambience = list;
      else delete scene.ambience;
      changed();
      renderSettings();
    };
    list.forEach((l, i) => {
      const sel = h('select', { onchange: () => { snapshot(); l.sound = sel.value; save(); } },
        ...state.audio.map((a) => h('option', { value: a, selected: a === l.sound }, a)),
        ...(!state.audio.includes(l.sound) ? [h('option', { value: l.sound, selected: true }, `${l.sound} (missing)`)] : []));
      const vol = h('input', { type: 'number', class: 'num', min: '0', max: '1', step: '0.05', title: 'Volume, 0..1', value: String(l.volume ?? 0.4), onchange: () => { snapshot(); l.volume = Math.max(0, Math.min(1, Number(vol.value) || 0)); save(); } });
      box.append(h('div', { class: 'prop-row' }, sel, vol, iconButton('close', 'Remove', () => { snapshot(); list.splice(i, 1); save(); }, { class: 'icon-btn tiny' })));
    });
    if (state.audio.length) box.append(h('button', { class: 'small', onclick: () => { snapshot(); list.push({ sound: state.audio[0]!, volume: 0.4 }); save(); } }, 'Add ambient sound'));
    return box;
  }

  function backgroundsCard(): HTMLElement {
    const box = h('div', { class: 'bg-list' });
    const list = scene.backgrounds;
    list.forEach((b, i) => {
      const spriteSel = h('select', { onchange: () => { snapshot(); b.sprite = spriteSel.value; changed(); void loadAssets(); } },
        ...state.sprites.map((sp) => h('option', { value: sp.name, selected: sp.name === b.sprite }, sp.name)));
      if (!state.sprite(b.sprite)) spriteSel.prepend(h('option', { value: b.sprite, selected: true }, `${b.sprite} (missing)`));
      const numIn = (label: string, title: string, get: () => number, set: (v: number) => void, step: string) => {
        const inp = h('input', { type: 'number', class: 'num', step, value: String(get()), onchange: () => { snapshot(); set(Number(inp.value) || 0); changed(); } });
        return h('label', { title }, label, inp);
      };
      box.append(h('div', { class: 'bg-item' },
        h('div', { class: 'bg-item-head' }, spriteSel,
          iconButton('up', 'Move back (drawn earlier)', () => { if (i > 0) { snapshot(); list.splice(i - 1, 0, ...list.splice(i, 1)); changed(); renderSettings(); } }, { class: 'icon-btn tiny' }),
          iconButton('close', 'Remove', () => { snapshot(); list.splice(i, 1); changed(); renderSettings(); }, { class: 'icon-btn tiny' })),
        h('div', { class: 'row3 atm-row3' },
          numIn('Parallax', '0 = fixed sky, 1 = moves with the world, 0.2-0.6 = far hills', () => b.parallax, (v) => (b.parallax = v), '0.05'),
          numIn('y', 'Vertical offset in px', () => b.y, (v) => (b.y = v), '1'),
          h('label', { class: 'inline', title: 'Repeat horizontally' }, h('input', { type: 'checkbox', checked: b.repeatX, onchange: (e: Event) => { snapshot(); b.repeatX = (e.target as HTMLInputElement).checked; changed(); } }), 'Repeat x'),
        ),
      ));
    });
    const add = h('select', { onchange: () => {
      if (!add.value) return;
      snapshot();
      list.push({ sprite: add.value, parallax: 0.5, repeatX: true, y: 0 });
      changed();
      void loadAssets();
      renderSettings();
    } }, h('option', { value: '' }, '+ Background image…'), ...state.sprites.filter((sp) => !sp.grid).map((sp) => h('option', { value: sp.name }, sp.name)));
    return h('div', { class: 'bg-section' },
      h('div', { class: 'muted small', title: 'Images drawn behind everything, back to front, scrolling slower than the world' }, 'Parallax backgrounds'),
      box, add);
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
  await loadNotes();
  if (focusId && scene.instances.some((i) => i.id === focusId)) {
    setTool('select');
    rightTab = 'hierarchy';
    requestAnimationFrame(() => select(focusId, true));
  }
  const unsub = state.subscribe(() => {
    renderRight();
    void loadAssets();
  });

  return {
    destroy() {
      assetsRun++;
      void flush();
      unregister();
      unsub();
      stopWatchingPlay();
      hdPreview.hide();
      ro.disconnect();
      cancelAnimationFrame(raf);
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
      setSelection([...selected].filter((id) => scene.instances.some((i) => i.id === id)));
      activeLayer = Math.min(activeLayer, scene.layers.length - 1);
      toast(`Scene updated${next.updatedBy === 'claude' ? ' by Claude' : ''}`, next.updatedBy === 'claude' ? 'claude' : 'info');
      renderSide();
      await loadAssets();
    },
    refreshAssets() {
      void loadAssets();
    },
    notesChanged() {
      void loadNotes();
    },
  };
}
