import { PALETTES, normalizeHex, parseColor, toHex } from '../core/color.js';
import {
  type Anchor,
  type TagDirection,
  addFrame,
  addLayer,
  celKey,
  compositeFrame,
  getCel,
  mergeLayerDown,
  moveFrame,
  moveLayer,
  removeFrame,
  removeLayer,
  removeTag,
  resizeCanvas,
  setTag,
} from '../core/sprite.js';
import { colorHistogram } from '../core/draw.js';
import type { SheetLayout, SheetOptions } from '../core/sheet.js';
import { api } from './api.js';
import { CanvasView } from './canvas.js';
import { type ChangeKind, type Editor, type ToolName } from './editor.js';
import { clear, confirmDialog, h, icon, iconButton, modal, promptText, toast } from './dom.js';

const TOOLS: { id: ToolName; label: string; key: string }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'fill', label: 'Fill', key: 'G' },
  { id: 'picker', label: 'Color picker', key: 'I' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'move', label: 'Move pixels', key: 'M' },
];

export interface EditorViewOptions {
  onBack: () => void;
  liveStatus: () => boolean;
}

/** Builds the full editor screen around an Editor instance. Returns a cleanup function. */
export function mountEditor(root: HTMLElement, ed: Editor, opts: EditorViewOptions): { destroy: () => void; setLive: (on: boolean) => void; flashRemote: (by?: string) => void } {
  clear(root);
  const view = new CanvasView(ed);
  const disposers: (() => void)[] = [];

  // ---------------------------------------------------------------- top bar
  const nameBtn = h('button', { class: 'sprite-name', title: 'Rename sprite', onclick: renameSprite });
  const sizeBtn = h('button', { class: 'ghost small', title: 'Canvas size & tile grid', onclick: resizeDialog });
  const undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => ed.undo());
  const redoBtn = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => ed.redo());
  const zoomLabel = h('span', { class: 'zoom-label' });
  const gridBtn = iconButton('grid', 'Toggle grid', () => { ed.grid = !ed.grid; ed.emit('view'); });
  const onionBtn = iconButton('onion', 'Onion skin', () => { ed.onion = !ed.onion; ed.emit('view'); });
  const mirrorBtn = iconButton('mirror', 'Horizontal symmetry (Shift+M)', () => { ed.mirrorX = !ed.mirrorX; ed.emit('view'); });
  const liveDot = h('span', { class: 'live-dot', title: 'Live sync' });
  const saveLabel = h('span', { class: 'save-label' });

  const topbar = h('header', { class: 'topbar' },
    iconButton('back', 'All sprites', async () => { await ed.flush(); opts.onBack(); }),
    h('span', { class: 'logo small' }),
    nameBtn,
    sizeBtn,
    h('div', { class: 'sep' }),
    undoBtn, redoBtn,
    h('div', { class: 'sep' }),
    iconButton('minus', 'Zoom out (-)', () => view.zoomBy(-1)),
    zoomLabel,
    iconButton('plus', 'Zoom in (+)', () => view.zoomBy(1)),
    iconButton('fit', 'Fit (0)', () => view.fit()),
    h('div', { class: 'sep' }),
    gridBtn, onionBtn, mirrorBtn,
    h('div', { class: 'spacer' }),
    h('span', { class: 'status-pill' }, liveDot, saveLabel),
    iconButton('help', 'Shortcuts & help', helpDialog),
    h('button', { class: 'primary', onclick: exportDialog }, icon('export', 16), 'Export'),
  );

  // ---------------------------------------------------------------- tools
  const toolButtons = new Map<ToolName, HTMLButtonElement>();
  const toolbar = h('nav', { class: 'toolbar' },
    ...TOOLS.map((t) => {
      const b = h('button', { class: 'tool-btn', title: `${t.label} (${t.key})`, 'aria-label': t.label, onclick: () => setTool(t.id) }, icon(t.id === 'fill' ? 'fill' : t.id, 20));
      toolButtons.set(t.id, b);
      return b;
    }),
  );
  const brushSel = h('select', { title: 'Brush size', onchange: () => { ed.brush = Number(brushSel.value); ed.emit('tool'); } },
    ...[1, 2, 3, 4, 5, 6, 8].map((n) => h('option', { value: String(n) }, `${n}px`)));
  const filledChk = h('input', { type: 'checkbox', onchange: () => { ed.filled = filledChk.checked; ed.emit('tool'); } });
  const contigChk = h('input', { type: 'checkbox', checked: true, onchange: () => { ed.contiguous = contigChk.checked; ed.emit('tool'); } });
  const toolOptions = h('div', { class: 'tool-options' });

  function setTool(t: ToolName) {
    ed.tool = t;
    ed.emit('tool');
  }

  function renderToolState() {
    for (const [id, b] of toolButtons) b.classList.toggle('active', ed.tool === id);
    clear(toolOptions);
    const t = ed.tool;
    toolOptions.append(h('span', { class: 'tool-name' }, TOOLS.find((x) => x.id === t)?.label ?? ''));
    if (t === 'pencil' || t === 'eraser' || t === 'line') toolOptions.append(h('label', { class: 'inline' }, 'Size', brushSel));
    if (t === 'rect' || t === 'ellipse') toolOptions.append(h('label', { class: 'inline' }, filledChk, 'Filled'));
    if (t === 'fill') toolOptions.append(h('label', { class: 'inline' }, contigChk, 'Contiguous'));
    if (t === 'move') toolOptions.append(h('span', { class: 'muted small' }, 'Drag to shift the layer · Shift wraps'));
    if (t === 'line' || t === 'rect' || t === 'ellipse') toolOptions.append(h('span', { class: 'muted small' }, 'Shift: constrain'));
    brushSel.value = String(ed.brush);
    filledChk.checked = ed.filled;
    view.requestRender();
  }

  // ---------------------------------------------------------------- color + palette
  const primarySw = h('button', { class: 'swatch-big primary-sw', title: 'Primary color (left click)' });
  const secondarySw = h('button', { class: 'swatch-big secondary-sw', title: 'Secondary color (right click)' });
  const colorInput = h('input', { type: 'color', class: 'hidden-color' });
  let editingSecondary = false;
  primarySw.onclick = () => { editingSecondary = false; colorInput.value = solidHex(ed.primary); colorInput.click(); };
  secondarySw.onclick = () => { editingSecondary = true; colorInput.value = solidHex(ed.secondary); colorInput.click(); };
  colorInput.oninput = () => {
    const alpha = parseColor(editingSecondary ? ed.secondary : ed.primary)[3] || 255;
    const hex = toHex([...parseColor(colorInput.value).slice(0, 3), alpha] as [number, number, number, number]);
    if (editingSecondary) ed.secondary = hex;
    else ed.primary = hex;
    ed.emit('color');
  };
  const hexIn = h('input', { type: 'text', class: 'hex-in', spellcheck: false, title: 'Primary color (#rrggbb or #rrggbbaa)' });
  hexIn.onchange = () => {
    try {
      ed.primary = normalizeHex(hexIn.value);
      ed.emit('color');
    } catch {
      toast('Invalid color', 'error');
      hexIn.value = ed.primary;
    }
  };
  const alphaIn = h('input', { type: 'range', min: '0', max: '255', title: 'Primary alpha' });
  alphaIn.oninput = () => {
    const c = parseColor(ed.primary === 'transparent' ? '#000000' : ed.primary);
    ed.primary = toHex([c[0], c[1], c[2], Number(alphaIn.value)]);
    ed.emit('color');
  };
  const swapBtn = iconButton('swap', 'Swap colors (X)', swapColors);
  const palGrid = h('div', { class: 'palette-grid' });
  const presetSel = h('select', { title: 'Load a palette preset', onchange: () => {
    const p = PALETTES[presetSel.value];
    presetSel.value = '';
    if (p) ed.edit((s) => { s.palette = [...p]; }, 'structure');
  } }, h('option', { value: '' }, 'Load preset…'), ...Object.keys(PALETTES).map((p) => h('option', { value: p }, p)));

  function swapColors() {
    [ed.primary, ed.secondary] = [ed.secondary, ed.primary];
    ed.emit('color');
  }

  function renderColors() {
    setSwatch(primarySw, ed.primary);
    setSwatch(secondarySw, ed.secondary);
    if (document.activeElement !== hexIn) hexIn.value = ed.primary;
    alphaIn.value = String(parseColor(ed.primary)[3]);
    for (const el of palGrid.querySelectorAll<HTMLElement>('.swatch')) {
      el.classList.toggle('sel', el.dataset.c === ed.primary);
      el.classList.toggle('sel2', el.dataset.c === ed.secondary);
    }
  }

  function renderPalette() {
    clear(palGrid);
    ed.sprite.palette.forEach((c, i) => {
      const sw = h('button', {
        class: 'swatch',
        title: `p${i} ${c} — click: primary, right-click: secondary, Alt+click: remove`,
        style: `background:${c}`,
        onclick: (e: MouseEvent) => {
          if (e.altKey) {
            ed.edit((s) => s.palette.splice(i, 1), 'structure');
            return;
          }
          ed.primary = c;
          ed.emit('color');
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          ed.secondary = c;
          ed.emit('color');
        },
      });
      sw.dataset.c = c;
      palGrid.append(sw);
    });
    palGrid.append(
      h('button', { class: 'swatch add', title: 'Add primary color to palette', onclick: () => {
        if (ed.primary === 'transparent' || ed.sprite.palette.includes(ed.primary)) return;
        ed.edit((s) => s.palette.push(ed.primary), 'structure');
      } }, '+'),
    );
    renderColors();
  }

  function collectColors() {
    const used = new Set<string>();
    ed.sprite.frames.forEach((_, i) => colorHistogram(compositeFrame(ed.sprite, i)).forEach((c) => used.add(c.color)));
    const extra = [...used].filter((c) => !ed.sprite.palette.includes(c));
    if (!extra.length) return toast('Palette already contains every used color');
    ed.edit((s) => s.palette.push(...extra), 'structure');
    toast(`Added ${extra.length} color(s)`);
  }

  // ---------------------------------------------------------------- layers
  const layerList = h('div', { class: 'layer-list' });
  const opacityIn = h('input', { type: 'range', min: '0', max: '100', title: 'Layer opacity' });
  opacityIn.onchange = () => ed.edit(() => { ed.layer.opacity = Number(opacityIn.value) / 100; }, 'structure');
  opacityIn.oninput = () => { ed.layer.opacity = Number(opacityIn.value) / 100; ed.emit('pixels'); };

  function renderLayers() {
    clear(layerList);
    [...ed.sprite.layers].reverse().forEach((l) => {
      const row = h('div', { class: `layer-row${l.id === ed.layerId ? ' active' : ''}`, onclick: () => { ed.layerId = l.id; ed.emit('structure'); } },
        h('button', { class: 'icon-btn tiny', title: l.visible ? 'Hide' : 'Show', onclick: (e: Event) => {
          e.stopPropagation();
          ed.edit(() => { l.visible = !l.visible; }, 'structure');
        } }, icon(l.visible ? 'eye' : 'eyeoff', 16)),
        h('span', { class: 'layer-name', title: 'Double-click to rename', ondblclick: async () => {
          const n = await promptText('Rename layer', 'Name', l.name);
          if (n) ed.edit(() => { l.name = n; }, 'structure');
        } }, l.name),
        l.opacity < 1 ? h('span', { class: 'muted small' }, `${Math.round(l.opacity * 100)}%`) : null,
      );
      layerList.append(row);
    });
    opacityIn.value = String(Math.round(ed.layer.opacity * 100));
  }

  const layerActions = h('div', { class: 'panel-actions' },
    iconButton('plus', 'New layer', () => ed.edit((s) => { ed.layerId = addLayer(s, undefined, ed.layerIndex + 1).id; })),
    iconButton('copy', 'Duplicate layer', () => ed.edit((s) => {
      const src = ed.layer;
      const l = addLayer(s, `${src.name} copy`, ed.layerIndex + 1);
      l.opacity = src.opacity;
      for (const f of s.frames) {
        const c = getCel(s, src.id, f.id);
        if (c) s.cels.set(celKey(l.id, f.id), new Uint8ClampedArray(c));
      }
      ed.layerId = l.id;
    })),
    iconButton('up', 'Move layer up', () => ed.edit((s) => moveLayer(s, ed.layerId, ed.layerIndex + 1))),
    iconButton('down', 'Move layer down', () => ed.edit((s) => moveLayer(s, ed.layerId, ed.layerIndex - 1))),
    iconButton('merge', 'Merge down', () => guard(() => ed.edit((s) => mergeLayerDown(s, ed.layerId)))),
    iconButton('trash', 'Delete layer', () => guard(() => ed.edit((s) => removeLayer(s, ed.layerId)))),
  );

  // ---------------------------------------------------------------- animation preview
  const previewCanvas = h('canvas', { class: 'anim-preview' });
  const previewCtx = previewCanvas.getContext('2d')!;
  const previewFrameCanvas = document.createElement('canvas');
  let previewIdx = 0;
  let previewTimer = 0;
  const tickPreview = () => {
    const seq = ed.playSequence();
    if (!seq.length) return;
    previewIdx = (previewIdx + 1) % seq.length;
    const f = seq[previewIdx];
    drawPreview(f);
    previewTimer = window.setTimeout(tickPreview, ed.sprite.frames[f]?.duration ?? 100);
  };
  function drawPreview(f: number) {
    const s = ed.sprite;
    const box = 168;
    const scale = Math.max(1, Math.floor(box / Math.max(s.width, s.height)));
    const w = Math.min(box, s.width * scale);
    const hgt = Math.min(box, s.height * scale);
    if (previewCanvas.width !== w || previewCanvas.height !== hgt) {
      previewCanvas.width = w;
      previewCanvas.height = hgt;
    }
    previewFrameCanvas.width = s.width;
    previewFrameCanvas.height = s.height;
    previewFrameCanvas.getContext('2d')!.putImageData(ed.composite(Math.min(f, s.frames.length - 1)), 0, 0);
    previewCtx.imageSmoothingEnabled = false;
    previewCtx.clearRect(0, 0, w, hgt);
    previewCtx.drawImage(previewFrameCanvas, 0, 0, w, hgt);
  }
  tickPreview();
  disposers.push(() => clearTimeout(previewTimer));

  // ---------------------------------------------------------------- right panel
  const sidebar = h('aside', { class: 'sidebar' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-title' }, 'Color'),
      h('div', { class: 'color-row' },
        h('div', { class: 'swatch-stack' }, secondarySw, primarySw),
        swapBtn,
        h('div', { class: 'color-fields' }, hexIn, h('label', { class: 'inline small' }, 'α', alphaIn)),
        colorInput,
      ),
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-title' }, 'Palette', h('div', { class: 'spacer' }), presetSel, iconButton('plus', 'Add colors used in the sprite', collectColors, { class: 'icon-btn tiny' })),
      palGrid,
    ),
    h('section', { class: 'panel grow' },
      h('div', { class: 'panel-title' }, 'Layers', h('div', { class: 'spacer' }), h('label', { class: 'inline small', title: 'Opacity' }, 'Opacity', opacityIn)),
      layerList,
      layerActions,
    ),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-title' }, 'Preview'),
      h('div', { class: 'anim-box checker' }, previewCanvas),
    ),
  );

  // ---------------------------------------------------------------- timeline
  const CELL = 60;
  const frameStrip = h('div', { class: 'frame-strip' });
  const tagLane = h('div', { class: 'tag-lane' });
  const timelineScroll = h('div', { class: 'timeline-scroll' }, tagLane, frameStrip);
  const frameLabel = h('span', { class: 'frame-label' });
  const durationIn = h('input', { type: 'number', min: '1', class: 'duration-in', title: 'Frame duration (ms) — applies to the selected range' });
  durationIn.onchange = () => {
    const d = Math.max(1, Number(durationIn.value) || 100);
    const [a, b] = ed.range ?? [ed.frame, ed.frame];
    ed.edit((s) => { for (let i = a; i <= b; i++) s.frames[i].duration = d; });
  };
  // Animation events of the current frame ("hit", "step"): scripts get onAnimationEvent, events the "Animation event" trigger.
  const eventsIn = h('input', { type: 'text', class: 'events-in', placeholder: 'events', spellcheck: false, title: 'Animation events of this frame, comma separated (e.g. hit, step): the game fires them when the frame shows' });
  eventsIn.onchange = () => {
    const list = [...new Set(eventsIn.value.split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z_][\w-]{0,31}$/.test(x)))];
    const [a, b] = ed.range ?? [ed.frame, ed.frame];
    ed.edit((s) => {
      for (let i = a; i <= b; i++) {
        if (list.length) s.frames[i].events = list;
        else delete s.frames[i].events;
      }
    });
  };
  const playBtn = iconButton('play', 'Play / pause (Enter)', togglePlay);
  const playTagSel = h('select', { title: 'Animation to play', onchange: () => { ed.playTag = playTagSel.value || null; ed.emit('view'); } });
  const thumbs: HTMLCanvasElement[] = [];

  function renderTimeline() {
    const s = ed.sprite;
    clear(frameStrip);
    clear(tagLane);
    thumbs.length = 0;
    // Fit thumbnails in 44px, using whole-number upscales for small sprites.
    const fit = Math.min(44 / s.width, 44 / s.height);
    const ratio = fit >= 1 ? Math.floor(fit) : fit;
    s.frames.forEach((f, i) => {
      const inRange = ed.range && i >= ed.range[0] && i <= ed.range[1];
      const c = h('canvas', { class: 'thumb-canvas' });
      thumbs.push(c);
      c.width = Math.max(1, Math.round(s.width * ratio));
      c.height = Math.max(1, Math.round(s.height * ratio));
      frameStrip.append(
        h('div', {
          class: `frame-cell${i === ed.frame ? ' current' : ''}${inRange ? ' ranged' : ''}`,
          style: `width:${CELL}px`,
          title: `Frame ${i} · ${f.duration}ms — Shift+click to select a range`,
          onclick: (e: MouseEvent) => selectFrame(i, e.shiftKey),
        },
          h('div', { class: 'thumb-box checker' }, c),
          h('span', { class: 'frame-idx' }, String(i)),
          h('span', { class: 'frame-dur' }, `${f.duration}`),
          f.events?.length ? h('span', { class: 'frame-ev', title: `Events: ${f.events.join(', ')}` }, '⚑') : null,
        ),
      );
    });
    for (const t of s.tags) {
      const bar = h('div', {
        class: `tag-bar${ed.playTag === t.name ? ' playing' : ''}`,
        style: `left:${t.from * CELL + 2}px;width:${(t.to - t.from + 1) * CELL - 4}px;--tag:${t.color}`,
        title: `${t.name} (${t.from}-${t.to}, ${t.direction}) — click to select, double-click to edit`,
        onclick: () => {
          ed.range = [t.from, t.to];
          ed.frame = t.from;
          ed.playTag = t.name;
          ed.emit('view');
        },
        ondblclick: () => tagDialog(t.name),
      }, t.name);
      tagLane.append(bar);
    }
    tagLane.style.width = frameStrip.style.width = `${s.frames.length * CELL}px`;
    clear(playTagSel);
    playTagSel.append(h('option', { value: '' }, 'All frames'), ...s.tags.map((t) => h('option', { value: t.name, selected: ed.playTag === t.name }, t.name)));
    renderThumbs();
    renderFrameInfo();
  }

  function renderThumbs() {
    const s = ed.sprite;
    thumbs.forEach((c, i) => {
      if (!s.frames[i]) return;
      const tmp = document.createElement('canvas');
      tmp.width = s.width;
      tmp.height = s.height;
      tmp.getContext('2d')!.putImageData(ed.composite(i), 0, 0);
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(tmp, 0, 0, c.width, c.height);
    });
  }

  function renderFrameInfo() {
    frameLabel.textContent = `${ed.frame + 1} / ${ed.sprite.frames.length}`;
    if (document.activeElement !== durationIn) durationIn.value = String(ed.sprite.frames[ed.frame]?.duration ?? 100);
    if (document.activeElement !== eventsIn) eventsIn.value = (ed.sprite.frames[ed.frame]?.events ?? []).join(', ');
    for (const [i, cell] of [...frameStrip.children].entries()) {
      cell.classList.toggle('current', i === ed.frame);
      cell.classList.toggle('ranged', !!ed.range && i >= ed.range[0] && i <= ed.range[1]);
    }
    for (const bar of tagLane.children) bar.classList.toggle('playing', (bar.textContent ?? '') === ed.playTag);
    playBtn.replaceChildren(icon(ed.playing ? 'pause' : 'play'));
    const cur = frameStrip.children[ed.frame] as HTMLElement | undefined;
    if (cur && ed.playing) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function selectFrame(i: number, extend = false) {
    const anchor = ed.range ? (ed.frame === ed.range[0] ? ed.range[1] : ed.range[0]) : ed.frame;
    if (extend) ed.range = [Math.min(anchor, i), Math.max(anchor, i)];
    else ed.range = null;
    ed.frame = i;
    ed.emit('view');
  }

  const frameActions = h('div', { class: 'timeline-actions' },
    iconButton('prev', 'Previous frame (←)', () => stepFrame(-1)),
    playBtn,
    iconButton('next', 'Next frame (→)', () => stepFrame(1)),
    frameLabel,
    h('label', { class: 'inline small' }, 'ms', durationIn),
    h('label', { class: 'inline small' }, '⚑', eventsIn),
    h('div', { class: 'sep' }),
    iconButton('plus', 'New empty frame (N)', () => ed.edit((s) => { addFrame(s, ed.frame + 1); ed.frame++; ed.range = null; })),
    iconButton('copy', 'Duplicate frame (D)', duplicateFrame),
    iconButton('left', 'Move frame left', () => ed.frame > 0 && ed.edit((s) => { moveFrame(s, ed.frame, ed.frame - 1); ed.frame--; ed.range = null; })),
    iconButton('right', 'Move frame right', () => ed.frame < ed.sprite.frames.length - 1 && ed.edit((s) => { moveFrame(s, ed.frame, ed.frame + 1); ed.frame++; ed.range = null; })),
    iconButton('trash', 'Delete frame(s) (Shift+Del)', deleteFrames),
    h('div', { class: 'sep' }),
    h('button', { class: 'ghost small', title: 'Create an animation tag from the selected frames', onclick: newTag }, icon('tag', 15), 'Tag'),
    h('label', { class: 'inline small' }, 'Play', playTagSel),
  );

  function duplicateFrame() {
    ed.edit((s) => { addFrame(s, ed.frame + 1, { copyFrom: ed.frame }); ed.frame++; ed.range = null; });
  }

  function deleteFrames() {
    const [a, b] = ed.range ?? [ed.frame, ed.frame];
    guard(() => ed.edit((s) => {
      if (b - a + 1 >= s.frames.length) throw new Error('A sprite needs at least one frame');
      for (let i = b; i >= a; i--) removeFrame(s, i);
      ed.frame = a;
      ed.range = null;
    }));
  }

  function stepFrame(d: number) {
    const n = ed.sprite.frames.length;
    ed.frame = (ed.frame + d + n) % n;
    ed.range = null;
    ed.emit('view');
  }

  let playTimer = 0;
  function togglePlay() {
    ed.playing = !ed.playing;
    ed.emit('view');
  }
  function runPlayback() {
    clearTimeout(playTimer);
    if (!ed.playing) return;
    const seq = ed.playSequence();
    const pos = seq.indexOf(ed.frame);
    const next = seq[(pos + 1) % seq.length];
    playTimer = window.setTimeout(() => {
      if (!ed.playing) return;
      ed.frame = next;
      ed.emit('view');
      runPlayback();
    }, ed.sprite.frames[ed.frame]?.duration ?? 100);
  }
  disposers.push(() => clearTimeout(playTimer));

  async function newTag() {
    const [a, b] = ed.range ?? [ed.frame, ed.frame];
    const name = await promptText('New animation tag', `Name for frames ${a}–${b}`, ed.sprite.tags.length ? '' : 'idle');
    if (!name) return;
    guard(() => ed.edit((s) => { setTag(s, { name, from: a, to: b }); ed.playTag = name; }));
  }

  async function tagDialog(name: string) {
    const t = ed.sprite.tags.find((x) => x.name === name);
    if (!t) return;
    await modal(`Tag “${t.name}”`, (close) => {
      const nameIn = h('input', { type: 'text', value: t.name });
      const fromIn = h('input', { type: 'number', min: '0', value: String(t.from) });
      const toIn = h('input', { type: 'number', min: '0', value: String(t.to) });
      const dirSel = h('select', {}, ...(['forward', 'reverse', 'pingpong'] as TagDirection[]).map((d) => h('option', { value: d, selected: d === t.direction }, d)));
      const colorIn = h('input', { type: 'color', value: solidHex(t.color) });
      return h('form', {
        class: 'form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          guard(() => ed.edit((s) => {
            if (nameIn.value !== t.name) removeTag(s, t.name);
            setTag(s, { name: nameIn.value.trim(), from: Number(fromIn.value), to: Number(toIn.value), direction: dirSel.value as TagDirection, color: colorIn.value });
            if (ed.playTag === t.name) ed.playTag = nameIn.value.trim();
          }));
          close();
        },
      },
        h('label', {}, 'Name', nameIn),
        h('div', { class: 'row2' }, h('label', {}, 'From frame', fromIn), h('label', {}, 'To frame', toIn)),
        h('div', { class: 'row2' }, h('label', {}, 'Direction', dirSel), h('label', {}, 'Color', colorIn)),
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'danger', onclick: () => { ed.edit((s) => removeTag(s, t.name)); close(); } }, 'Delete tag'),
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
        ),
      );
    });
  }

  const timeline = h('footer', { class: 'timeline' }, frameActions, timelineScroll);

  // ---------------------------------------------------------------- status bar
  const posLabel = h('span', {});
  const colorLabel = h('span', { class: 'hover-color' });
  const statusbar = h('div', { class: 'statusbar' }, posLabel, colorLabel, h('div', { class: 'spacer' }), toolOptions);
  view.onHover = (p, c) => {
    posLabel.textContent = p ? `${p[0]}, ${p[1]}` : '';
    colorLabel.textContent = p ? (c ?? 'transparent') : '';
    colorLabel.style.setProperty('--c', c ?? 'transparent');
  };
  view.onZoom = (z) => (zoomLabel.textContent = `${z * 100}%`);

  root.append(
    h('div', { class: 'editor' },
      topbar,
      h('div', { class: 'workspace' }, toolbar, h('main', { class: 'center' }, view.el, statusbar), sidebar),
      timeline,
    ),
  );

  // ---------------------------------------------------------------- dialogs

  async function renameSprite() {
    const to = await promptText('Rename sprite', 'Name', ed.sprite.name);
    if (!to || to === ed.sprite.name) return;
    try {
      await ed.flush();
      await api.rename(ed.sprite.name, to);
      location.hash = `#/edit/${encodeURIComponent(to)}`;
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function resizeDialog() {
    const s = ed.sprite;
    await modal('Canvas & grid', (close) => {
      const wIn = h('input', { type: 'number', min: '1', max: '2048', value: String(s.width) });
      const hIn = h('input', { type: 'number', min: '1', max: '2048', value: String(s.height) });
      const anchors: Anchor[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
      const anchorSel = h('select', {}, ...anchors.map((a) => h('option', { value: a, selected: a === 'center' }, a)));
      const gwIn = h('input', { type: 'number', min: '0', value: String(s.grid?.width ?? 0) });
      const ghIn = h('input', { type: 'number', min: '0', value: String(s.grid?.height ?? 0) });
      return h('form', {
        class: 'form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          guard(() => ed.edit((sp) => {
            const w = Number(wIn.value);
            const hh = Number(hIn.value);
            if (w !== sp.width || hh !== sp.height) resizeCanvas(sp, w, hh, anchorSel.value as Anchor);
            const gw = Number(gwIn.value);
            const gh = Number(ghIn.value) || gw;
            sp.grid = gw > 0 ? { width: gw, height: gh } : null;
          }));
          view.fit();
          close();
        },
      },
        h('div', { class: 'row2' }, h('label', {}, 'Width', wIn), h('label', {}, 'Height', hIn)),
        h('label', {}, 'Anchor', anchorSel),
        h('div', { class: 'row2' }, h('label', {}, 'Tile width (0 = none)', gwIn), h('label', {}, 'Tile height', ghIn)),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Apply')),
      );
    });
  }

  async function exportDialog() {
    await ed.flush();
    const s = ed.sprite;
    await modal('Export spritesheet', (close) => {
      const layoutSel = h('select', {},
        h('option', { value: 'horizontal' }, 'Horizontal strip'),
        h('option', { value: 'vertical' }, 'Vertical strip'),
        h('option', { value: 'grid' }, 'Grid'),
        h('option', { value: 'tags', selected: s.tags.length > 1 }, 'One row per tag'),
      );
      const colsIn = h('input', { type: 'number', min: '1', value: String(Math.ceil(Math.sqrt(s.frames.length))) });
      const padIn = h('input', { type: 'number', min: '0', value: '0' });
      const marginIn = h('input', { type: 'number', min: '0', value: '0' });
      const scaleIn = h('input', { type: 'number', min: '1', max: '16', value: '1' });
      const tagSel = h('select', {}, h('option', { value: '' }, 'All frames'), ...s.tags.map((t) => h('option', { value: t.name }, t.name)));
      const byTagChk = h('input', { type: 'checkbox' });
      const img = h('img', { class: 'export-img', alt: 'Spritesheet preview' });
      const info = h('p', { class: 'muted small' });
      const pngLink = h('a', { class: 'btn', download: '' }, 'Download PNG');
      const jsonLink = h('a', { class: 'btn', download: '' }, 'Download JSON');
      const result = h('div', { class: 'export-result' });
      const opts = (): SheetOptions => ({
        layout: layoutSel.value as SheetLayout,
        columns: Number(colsIn.value) || undefined,
        padding: Number(padIn.value) || 0,
        margin: Number(marginIn.value) || 0,
        scale: Number(scaleIn.value) || 1,
        tag: tagSel.value || undefined,
      });
      const update = () => {
        const o = opts();
        colsIn.parentElement!.style.display = o.layout === 'grid' ? '' : 'none';
        img.src = api.sheetUrl(s.name, o, 'png') + `&t=${Date.now()}`;
        pngLink.href = api.sheetUrl(s.name, o, 'png', true);
        jsonLink.href = api.sheetUrl(s.name, o, 'json', true);
        img.onload = () => {
          // Show the sheet zoomed in (whole-number factor) so pixels stay crisp.
          const box = img.parentElement!.clientWidth - 24;
          const k = Math.max(1, Math.floor(Math.min(box / img.naturalWidth, 360 / img.naturalHeight)));
          img.style.width = `${img.naturalWidth * k}px`;
          info.textContent = `${img.naturalWidth}×${img.naturalHeight}px · JSON is Aseprite-compatible (Phaser, Godot, Unity, LibGDX)`;
        };
      };
      for (const el of [layoutSel, colsIn, padIn, marginIn, scaleIn, tagSel]) el.addEventListener('input', update);
      setTimeout(update);
      return h('div', { class: 'export' },
        h('div', { class: 'form export-form' },
          h('label', {}, 'Layout', layoutSel),
          h('label', {}, 'Columns', colsIn),
          h('label', {}, 'Animation', tagSel),
          h('div', { class: 'row2' }, h('label', {}, 'Padding', padIn), h('label', {}, 'Margin', marginIn)),
          h('label', {}, 'Scale', scaleIn),
          h('label', { class: 'inline' }, byTagChk, 'Also one sheet per tag (save only)'),
          h('div', { class: 'actions col' },
            pngLink,
            jsonLink,
            h('button', { class: 'primary', onclick: async () => {
              try {
                const r = await api.export(s.name, { ...opts(), byTag: byTagChk.checked });
                clear(result);
                result.append(h('p', { class: 'small' }, 'Saved:'), ...r.files.map((f) => h('code', { class: 'path' }, f.png)));
                toast(`Exported ${r.files.length} sheet(s)`);
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            } }, 'Save to export folder'),
            h('button', { onclick: close }, 'Close'),
          ),
          result,
        ),
        h('div', { class: 'export-preview' }, h('div', { class: 'checker export-img-box' }, img), info),
      );
    }, { wide: true });
  }

  async function helpDialog() {
    const rows: [string, string][] = [
      ['B / E / G / I', 'Pencil / Eraser / Fill / Picker'],
      ['L / R / O / M', 'Line / Rectangle / Ellipse / Move'],
      ['Left / right click', 'Draw with primary / secondary color'],
      ['Alt + click', 'Pick color'],
      ['X', 'Swap colors'],
      ['[ / ]', 'Brush size'],
      ['Shift + M', 'Horizontal symmetry'],
      ['Space + drag, middle drag', 'Pan'],
      ['Wheel, + / -, 0', 'Zoom, fit'],
      ['← / →', 'Previous / next frame'],
      ['↑ / ↓', 'Layer above / below'],
      ['N / D', 'New frame / duplicate frame'],
      ['Shift + Delete', 'Delete frame(s)'],
      ['Enter', 'Play / pause'],
      ['Ctrl/⌘ + Z, Ctrl/⌘ + Shift + Z', 'Undo / redo'],
    ];
    await modal('Shortcuts', () =>
      h('div', { class: 'help-body' },
        h('table', { class: 'keys' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
        h('p', { class: 'muted small' }, 'Changes save automatically. When Claude edits this sprite through MCP, the editor updates live and the change can be undone with Ctrl+Z.'),
      ),
    );
  }

  // ---------------------------------------------------------------- keyboard
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, .modal')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) ed.redo();
      else ed.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      ed.redo();
      return;
    }
    if (mod && k === 's') {
      e.preventDefault();
      void ed.flush();
      return;
    }
    if (mod || e.altKey) return;
    const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
    if (tool && !e.shiftKey) return setTool(tool.id);
    switch (e.key) {
      case 'v': setTool('move'); break;
      case 'x': swapColors(); break;
      case '[': ed.brush = Math.max(1, ed.brush - 1); ed.emit('tool'); break;
      case ']': ed.brush = Math.min(8, ed.brush + 1); ed.emit('tool'); break;
      case 'M': ed.mirrorX = !ed.mirrorX; ed.emit('view'); break;
      case '+': case '=': view.zoomBy(1); break;
      case '-': view.zoomBy(-1); break;
      case '0': view.fit(); break;
      case 'ArrowLeft': e.preventDefault(); stepFrame(-1); break;
      case 'ArrowRight': e.preventDefault(); stepFrame(1); break;
      case 'ArrowUp': e.preventDefault(); ed.layerId = ed.sprite.layers[Math.min(ed.sprite.layers.length - 1, ed.layerIndex + 1)].id; ed.emit('structure'); break;
      case 'ArrowDown': e.preventDefault(); ed.layerId = ed.sprite.layers[Math.max(0, ed.layerIndex - 1)].id; ed.emit('structure'); break;
      case 'n': ed.edit((s) => { addFrame(s, ed.frame + 1); ed.frame++; ed.range = null; }); break;
      case 'd': duplicateFrame(); break;
      case 'Delete': case 'Backspace': if (e.shiftKey) deleteFrames(); break;
      case 'Enter': togglePlay(); break;
    }
  };
  window.addEventListener('keydown', onKey);
  disposers.push(() => window.removeEventListener('keydown', onKey));
  const beforeUnload = (e: BeforeUnloadEvent) => {
    if (ed.saveState === 'dirty' || ed.saveState === 'saving') {
      void ed.flush();
      e.preventDefault();
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  disposers.push(() => window.removeEventListener('beforeunload', beforeUnload));

  // ---------------------------------------------------------------- reactive updates
  let thumbTimer = 0;
  let live = opts.liveStatus();
  const renderStatus = () => {
    undoBtn.disabled = !ed.canUndo;
    redoBtn.disabled = !ed.canRedo;
    const labels = { saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved', error: 'Save failed' };
    saveLabel.textContent = labels[ed.saveState];
    saveLabel.dataset.state = ed.saveState;
    liveDot.classList.toggle('on', live);
    liveDot.title = live ? 'Live sync connected' : 'Live sync disconnected';
  };
  const renderHeader = () => {
    nameBtn.textContent = ed.sprite.name;
    sizeBtn.textContent = `${ed.sprite.width}×${ed.sprite.height}${ed.sprite.grid ? ` · ${ed.sprite.grid.width}px tiles` : ''}`;
    document.title = `${ed.sprite.name} — Spritifer`;
  };
  const renderToggles = () => {
    gridBtn.classList.toggle('active', ed.grid);
    onionBtn.classList.toggle('active', ed.onion);
    mirrorBtn.classList.toggle('active', ed.mirrorX);
  };

  disposers.push(
    ed.on((kind: ChangeKind) => {
      switch (kind) {
        case 'pixels':
          clearTimeout(thumbTimer);
          thumbTimer = window.setTimeout(renderThumbs, 120);
          break;
        case 'structure':
          renderHeader();
          renderPalette();
          renderLayers();
          renderTimeline();
          break;
        case 'view':
          renderToggles();
          renderFrameInfo();
          runPlayback();
          break;
        case 'tool':
          renderToolState();
          break;
        case 'color':
          renderColors();
          break;
      }
      renderStatus();
    }),
  );

  renderHeader();
  renderPalette();
  renderLayers();
  renderTimeline();
  renderToolState();
  renderToggles();
  renderStatus();

  function guard(fn: () => void) {
    try {
      fn();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return {
    destroy: () => disposers.forEach((d) => d()),
    setLive: (on) => {
      live = on;
      renderStatus();
    },
    flashRemote: (by) => {
      toast(by === 'claude' ? '✦ Claude updated this sprite' : 'Sprite updated externally', 'claude');
      root.querySelector('.canvas-wrap')?.classList.remove('flash');
      void (root.querySelector('.canvas-wrap') as HTMLElement | null)?.offsetWidth;
      root.querySelector('.canvas-wrap')?.classList.add('flash');
    },
  };
}

function solidHex(c: string): string {
  if (c === 'transparent') return '#000000';
  const [r, g, b] = parseColor(c);
  return toHex([r, g, b, 255]);
}

function setSwatch(el: HTMLElement, c: string) {
  el.style.setProperty('--c', c === 'transparent' ? 'transparent' : c);
  el.classList.toggle('is-transparent', c === 'transparent');
  el.title = el.title.replace(/ —.*$/, '') + ` — ${c}`;
}
