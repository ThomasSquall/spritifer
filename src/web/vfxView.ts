/**
 * VFX page: effects as node graphs. Nodes and wires on a pannable canvas, an inspector generated from the
 * same catalog the MCP reference is, and a live preview that draws with the game's own effect player.
 */

import { CanvasRenderer } from '../runtime/canvasRenderer.js';
import { SOUNDS } from '../core/game/catalog.js';
import type { SpriteAsset } from '../core/game/types.js';
import { type VfxTimeline, VfxSystem, simulateVfx } from '../core/game/vfx.js';
import {
  type VfxEdge,
  type VfxGraph,
  type VfxNode,
  type VfxParam,
  type VfxValue,
  VFX_NAME_RE,
  VFX_NODES,
  VFX_NODE_MAP,
  VFX_NODE_W,
  VFX_TEMPLATES,
  checkVfx,
  normalizeVfx,
  vfxEdgePort,
  vfxParam,
  vfxWouldCycle,
} from '../core/game/vfxGraph.js';
import { colorInput } from './colorInput.js';
import { clear, confirmDialog, h, icon, iconButton, modal, promptText, toast } from './dom.js';
import { previewSound } from './eventSheet.js';
import { type LoadedAsset, gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { isPlaying, registerFlusher } from './play.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PORT_Y = 21;
const PORT_GAP = 20;
const PREVIEW_W = 280;
const PREVIEW_H = 150;
const GROUPS = ['Flow', 'Shapes', 'Particles', 'Feedback'] as const;
const STEP = 1 / 60;

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; edge: VfxEdge } | null;

const seconds = (v: number) => `${v.toFixed(2).replace(/0$/, '')} s`;

/** The one line on a node that says what it will do. */
function nodeSummary(n: VfxNode): string {
  const get = <T extends VfxValue>(k: string) => vfxParam<T>(n, k);
  const where = () => `on ${get<string>('at')}`;
  switch (n.type) {
    case 'start': return 'when played';
    case 'delay': return seconds(get('seconds'));
    case 'repeat': return `${get('count')}× every ${seconds(get('interval'))}`;
    case 'message': return `"${get('message')}"`;
    case 'slash': return `${where()} · ${get('arc')}° · ${seconds(get('duration'))}`;
    case 'ring': return `${where()} · ${get<[number, number]>('radius').join('→')} px · ${seconds(get('duration'))}`;
    case 'beam': return `${get<number>('wobble') ? 'lightning' : 'laser'} · ${seconds(get('duration'))}`;
    case 'projectile': return `${get('speed')} px/s${get<string>('sprite') ? ` · ${get('sprite')}` : ''}`;
    case 'sprite': return get<string>('sprite') || 'no sprite yet';
    case 'particles': return `${where()} · ${get('count')}${get<number>('duration') ? ` over ${seconds(get('duration'))}` : ' burst'}`;
    case 'flash': return `${Math.round(get<number>('alpha') * 100)}% · ${seconds(get('duration'))}`;
    case 'light': return `${where()} · r ${get('radius')}`;
    case 'shake': return `${get('intensity')} px · ${seconds(get('seconds'))}`;
    case 'hitstop': return seconds(get('seconds'));
    case 'blink': return `${get('who')} · ${seconds(get('seconds'))}`;
    case 'sound': return String(get('sound'));
    default: return '';
  }
}

function nodeSwatches(n: VfxNode): string[] {
  const spec = VFX_NODE_MAP.get(n.type);
  if (spec?.params.some((p) => p.name === 'colors')) return vfxParam<string[]>(n, 'colors');
  if (spec?.params.some((p) => p.name === 'color')) return [vfxParam<string>(n, 'color')];
  return [];
}

export function renderVfx(root: HTMLElement, selected: string | null, go: (name: string | null) => void): { refresh: () => void; destroy: () => void } {
  clear(root);
  const list = h('div', { class: 'obj-list' });
  const main = h('section', { class: 'script-main vfx-main' });
  root.append(h('div', { class: 'page script-page' }, appNav('vfx'), h('div', { class: 'obj-layout script-layout' }, h('aside', { class: 'obj-side' }, list), main)));

  let graph: VfxGraph | null = null;
  let selection: Selection = null;
  let dirty = false;
  let saveTimer = 0;
  let destroyed = false;
  const status = h('span', { class: 'save-label muted small' }, '');
  const view = { x: 40, y: 40, k: 1 };
  let undo: string[] = [];
  let redo: string[] = [];
  let lastUndoKey = '';
  let lastUndoAt = 0;

  // ---------------------------------------------------------------- saving

  const save = async () => {
    clearTimeout(saveTimer);
    if (!dirty || !graph) return;
    dirty = false;
    status.textContent = 'Saving…';
    try {
      const r = await gameApi.saveVfx(graph);
      graph.rev = r.rev;
      status.textContent = 'Saved';
      void renderList();
    } catch (err) {
      dirty = true;
      status.textContent = 'Not saved';
      toast(`Could not save the effect: ${(err as Error).message}`, 'error');
    }
  };
  const unregister = registerFlusher(save);

  /** Call before a change. Edits with the same key close together (a slider drag) undo as one. */
  const remember = (key = '') => {
    if (!graph) return;
    const now = performance.now();
    if (key && key === lastUndoKey && now - lastUndoAt < 900) {
      lastUndoAt = now;
      return;
    }
    lastUndoKey = key;
    lastUndoAt = now;
    undo.push(JSON.stringify(graph));
    if (undo.length > 100) undo.shift();
    redo = [];
  };

  const changed = () => {
    dirty = true;
    status.textContent = 'Unsaved';
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void save(), 400);
    preview.graphChanged();
  };

  const swap = (from: string[], to: string[]) => {
    const prev = from.pop();
    if (!prev || !graph) return;
    to.push(JSON.stringify(graph));
    graph = normalizeVfx(JSON.parse(prev), graph.name);
    if (selection?.kind === 'node' && !graph.nodes.some((n) => n.id === (selection as { id: string }).id)) selection = null;
    if (selection?.kind === 'edge') selection = null;
    lastUndoKey = '';
    drawGraph();
    drawInspector();
    changed();
  };

  // ---------------------------------------------------------------- graph

  const world = h('div', { class: 'vfx-world' });
  const wires = document.createElementNS(SVG_NS, 'svg');
  wires.setAttribute('class', 'vfx-wires');
  const canvas = h('div', { class: 'vfx-canvas', tabIndex: 0 }, world);
  const zoomLabel = h('span', { class: 'muted small vfx-zoom' }, '100%');
  const palette = h('div', { class: 'vfx-palette' });
  for (const group of GROUPS) {
    palette.append(h('span', { class: `vfx-pal-group g-${group}` }, group));
    for (const spec of VFX_NODES) {
      if (spec.group !== group || spec.type === 'start') continue;
      palette.append(h('button', { class: `small g-${group}`, title: `${spec.help} Added after the selected node.`, onclick: () => addNode(spec.type) }, spec.label));
    }
  }

  const applyView = () => {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`;
    canvas.style.backgroundSize = `${24 * view.k}px ${24 * view.k}px`;
    zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
  };

  const fit = () => {
    if (!graph?.nodes.length) return;
    const xs = graph.nodes.map((n) => n.x);
    const ys = graph.nodes.map((n) => n.y);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) + VFX_NODE_W - x0;
    const h2 = Math.max(...ys) + 84 - y0;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    view.k = Math.min(1, Math.max(0.3, Math.min((r.width - 48) / w, (r.height - 48) / h2)));
    view.x = (r.width - w * view.k) / 2 - x0 * view.k;
    view.y = (r.height - h2 * view.k) / 2 - y0 * view.k;
    applyView();
  };

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  const outPos = (n: VfxNode, port: string) => {
    const outs = VFX_NODE_MAP.get(n.type)?.outputs ?? [];
    return { x: n.x + VFX_NODE_W, y: n.y + PORT_Y + Math.max(0, outs.indexOf(port)) * PORT_GAP };
  };
  const inPos = (n: VfxNode) => ({ x: n.x, y: n.y + PORT_Y });
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M${a.x} ${a.y} C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
  };
  const sameEdge = (x: VfxEdge, y: VfxEdge) => !!graph && x.from === y.from && x.to === y.to && vfxEdgePort(graph, x) === vfxEdgePort(graph, y);

  const drawWires = () => {
    if (!graph) return;
    const g = graph;
    wires.replaceChildren();
    for (const e of g.edges) {
      const a = g.nodes.find((n) => n.id === e.from);
      const b = g.nodes.find((n) => n.id === e.to);
      if (!a || !b) continue;
      const d = curve(outPos(a, vfxEdgePort(g, e)), inPos(b));
      const on = selection?.kind === 'edge' && sameEdge(selection.edge, e);
      const line = document.createElementNS(SVG_NS, 'path');
      line.setAttribute('d', d);
      line.setAttribute('class', `vfx-wire${on ? ' on' : ''}`);
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('class', 'vfx-wire-hit');
      hit.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        select({ kind: 'edge', edge: e });
      });
      wires.append(line, hit);
    }
    if (dragWire) {
      const line = document.createElementNS(SVG_NS, 'path');
      line.setAttribute('d', curve(dragWire.a, dragWire.b));
      line.setAttribute('class', 'vfx-wire on');
      wires.append(line);
    }
  };

  let dragWire: { from: string; port: string; a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  const nodeEls = new Map<string, HTMLElement>();

  const nodeBody = (n: VfxNode) => {
    const sw = nodeSwatches(n);
    return [
      sw.length ? h('span', { class: 'vfx-swatches' }, ...sw.map((c) => h('i', { style: `background:${c}` }))) : null,
      h('span', { class: 'vfx-summary' }, nodeSummary(n)),
    ];
  };

  const drawNode = (n: VfxNode) => {
    const spec = VFX_NODE_MAP.get(n.type)!;
    const body = h('div', { class: 'vfx-node-body' }, ...nodeBody(n));
    const el = h('div', {
      class: `vfx-node g-${spec.group}${selection?.kind === 'node' && selection.id === n.id ? ' on' : ''}`,
      style: `left:${n.x}px;top:${n.y}px;width:${VFX_NODE_W}px`,
      title: spec.help,
      'data-id': n.id,
    },
      n.type === 'start' ? null : h('div', { class: 'vfx-port in', style: `top:${PORT_Y - 6}px` }),
      h('div', { class: 'vfx-node-head' }, h('b', {}, spec.label), h('span', { class: 'muted' }, n.type === 'start' ? '' : n.id)),
      body,
      ...spec.outputs.map((port, i) => h('div', {
        class: 'vfx-port out',
        style: `top:${PORT_Y - 6 + i * PORT_GAP}px`,
        title: 'Drag onto another node to wire it',
        onpointerdown: (e: PointerEvent) => {
          e.stopPropagation();
          const a = outPos(n, port);
          dragWire = { from: n.id, port, a, b: a };
          canvas.setPointerCapture(e.pointerId);
        },
      }, spec.outputs.length > 1 ? h('span', { class: 'vfx-port-label' }, port) : null)),
    );
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      canvas.focus({ preventScroll: true });
      select({ kind: 'node', id: n.id });
      const start = toWorld(e);
      dragNode = { node: n, dx: start.x - n.x, dy: start.y - n.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    nodeEls.set(n.id, el);
    return el;
  };

  let dragNode: { node: VfxNode; dx: number; dy: number; moved: boolean } | null = null;
  let panning: { x: number; y: number; vx: number; vy: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus({ preventScroll: true });
    select(null);
    panning = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('panning');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragWire) {
      dragWire.b = toWorld(e);
      drawWires();
    } else if (dragNode) {
      const p = toWorld(e);
      const x = Math.round((p.x - dragNode.dx) / 8) * 8;
      const y = Math.round((p.y - dragNode.dy) / 8) * 8;
      if (x === dragNode.node.x && y === dragNode.node.y) return;
      if (!dragNode.moved) {
        remember();
        dragNode.moved = true;
      }
      dragNode.node.x = x;
      dragNode.node.y = y;
      const el = nodeEls.get(dragNode.node.id);
      if (el) {
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
      }
      drawWires();
    } else if (panning) {
      view.x = panning.vx + e.clientX - panning.x;
      view.y = panning.vy + e.clientY - panning.y;
      applyView();
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (dragWire) {
      const wire = dragWire;
      dragWire = null;
      const under = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.vfx-node');
      if (under?.dataset.id) connect(wire.from, wire.port, under.dataset.id);
      drawWires();
    }
    if (dragNode?.moved) {
      // Only the layout changed: the file still needs saving, the preview doesn't care.
      dirty = true;
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void save(), 400);
    }
    dragNode = null;
    panning = null;
    canvas.classList.remove('panning');
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const k = Math.min(2, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0015)));
    view.x = mx - ((mx - view.x) / view.k) * k;
    view.y = my - ((my - view.y) / view.k) * k;
    view.k = k;
    applyView();
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) swap(redo, undo);
      else swap(undo, redo);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeSelected();
    }
  });

  const drawGraph = () => {
    world.replaceChildren(wires);
    nodeEls.clear();
    if (!graph) return;
    for (const n of graph.nodes) world.append(drawNode(n));
    drawWires();
    drawProblems();
  };

  const connect = (from: string, port: string, to: string) => {
    if (!graph || from === to) return;
    if (graph.nodes.find((n) => n.id === to)?.type === 'start') return toast('Nothing can run before Start', 'error');
    if (vfxWouldCycle(graph, from, to)) return toast('That wire would make a loop; use a Repeat node', 'error');
    const edge: VfxEdge = { from, port, to };
    if (graph.edges.some((e) => sameEdge(e, edge))) return;
    remember();
    graph.edges.push(edge);
    graph = normalizeVfx(graph, graph.name);
    drawGraph();
    changed();
  };

  function addNode(type: string): void {
    if (!graph) return;
    remember();
    const taken = new Set(graph.nodes.map((n) => n.id));
    let i = 1;
    while (taken.has(`${type}${i}`)) i++;
    const id = `${type}${i}`;
    const after = selection?.kind === 'node' ? graph.nodes.find((n) => n.id === (selection as { id: string }).id) : undefined;
    let x: number;
    let y: number;
    if (after) {
      x = after.x + VFX_NODE_W + 60;
      y = after.y;
      while (graph.nodes.some((n) => Math.abs(n.x - x) < VFX_NODE_W && Math.abs(n.y - y) < 80)) y += 88;
    } else {
      const r = canvas.getBoundingClientRect();
      const c = toWorld({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      x = Math.round(c.x / 8) * 8;
      y = Math.round(c.y / 8) * 8;
    }
    graph.nodes.push({ id, type, x, y, params: {} });
    if (after) {
      const outs = VFX_NODE_MAP.get(after.type)?.outputs ?? ['out'];
      graph.edges.push({ from: after.id, port: outs[0], to: id });
      graph = normalizeVfx(graph, graph.name);
    }
    selection = { kind: 'node', id };
    drawGraph();
    drawInspector();
    changed();
  }

  function removeSelected(): void {
    if (!graph || !selection) return;
    if (selection.kind === 'edge') {
      const edge = selection.edge;
      remember();
      graph.edges = graph.edges.filter((e) => !sameEdge(e, edge));
    } else {
      const id = selection.id;
      if (graph.nodes.find((n) => n.id === id)?.type === 'start') return toast('Start cannot be removed', 'error');
      remember();
      graph.nodes = graph.nodes.filter((n) => n.id !== id);
      graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
    }
    selection = null;
    drawGraph();
    drawInspector();
    changed();
  }

  function select(s: Selection): void {
    selection = s;
    for (const [id, el] of nodeEls) el.classList.toggle('on', s?.kind === 'node' && s.id === id);
    drawWires();
    drawInspector();
    preview.highlight();
  }

  // ---------------------------------------------------------------- inspector

  const inspector = h('div', { class: 'vfx-inspector' });
  const problemsBox = h('div', { class: 'vfx-problems small' });

  const problems = () => (graph ? checkVfx(graph, { sprites: new Map(state.sprites.map((s) => [s.name, s.tags ?? []])), sounds: [...SOUNDS, ...state.audio] }) : []);

  const drawProblems = () => {
    clear(problemsBox);
    for (const p of problems()) problemsBox.append(h('div', {}, p));
  };

  const paramControl = (n: VfxNode, p: VfxParam, body: HTMLElement): HTMLElement => {
    const value = vfxParam(n, p.name);
    const set = (v: VfxValue) => {
      remember(`${n.id}.${p.name}`);
      n.params[p.name] = v;
      clear(body);
      body.append(...nodeBody(n).filter((x): x is HTMLElement => !!x));
      drawProblems();
      changed();
    };
    let input: HTMLElement;
    const numInput = (val: number, onSet: (v: number) => void) => {
      const el = h('input', { type: 'number', value: String(val), step: String(p.step ?? 1), ...(p.min !== undefined ? { min: String(p.min) } : {}), ...(p.max !== undefined ? { max: String(p.max) } : {}), oninput: () => {
        const v = Number(el.value);
        if (el.value === '' || !Number.isFinite(v)) return;
        onSet(Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v)));
      } });
      return el;
    };
    switch (p.type) {
      case 'number': {
        const box = numInput(value as number, (v) => {
          if (slider) slider.value = String(v);
          set(v);
        });
        const slider = p.min !== undefined && p.max !== undefined
          ? h('input', { type: 'range', min: String(p.min), max: String(p.max), step: String(p.step ?? 1), value: String(value), oninput: () => {
            box.value = slider!.value;
            set(Number(slider!.value));
          } })
          : null;
        input = h('span', { class: 'vfx-num' }, slider, box);
        break;
      }
      case 'range': {
        const pair = [...(value as number[])];
        input = h('span', { class: 'vfx-range' },
          numInput(pair[0], (v) => { pair[0] = v; set([pair[0], pair[1]]); }),
          h('span', { class: 'muted' }, '→'),
          numInput(pair[1], (v) => { pair[1] = v; set([pair[0], pair[1]]); }));
        break;
      }
      case 'color':
        input = colorInput(value as string, (v) => v && set(v));
        break;
      case 'colors': {
        const colors = [...(value as string[])];
        const wrap = h('div', { class: 'vfx-colors' });
        const paint = () => {
          clear(wrap);
          colors.forEach((c, i) => wrap.append(h('div', { class: 'vfx-color-row' },
            colorInput(c, (v) => {
              if (!v) return;
              colors[i] = v;
              set([...colors]);
            }),
            colors.length > 1 ? iconButton('close', 'Remove color', () => {
              colors.splice(i, 1);
              set([...colors]);
              paint();
            }, { class: 'icon-btn tiny' }) : null)));
          if (colors.length < 8) wrap.append(h('button', { class: 'ghost small', onclick: () => {
            colors.push(colors[colors.length - 1]);
            set([...colors]);
            paint();
          } }, icon('plus', 12), 'Color'));
        };
        paint();
        input = wrap;
        break;
      }
      case 'bool': {
        const c = h('input', { type: 'checkbox', checked: value as boolean, onchange: () => set(c.checked) });
        input = c;
        break;
      }
      case 'text': {
        const t = h('input', { type: 'text', value: value as string, spellcheck: false, oninput: () => set(t.value) });
        input = t;
        break;
      }
      default: {
        const options = p.type === 'choice' ? (p.options ?? []) : p.type === 'sound' ? [...SOUNDS, ...state.audio] : state.sprites.map((s) => s.name);
        const items = p.type === 'sprite' ? ['', ...options] : options;
        const cur = String(value);
        if (cur && !items.includes(cur)) items.push(cur);
        const s = h('select', { onchange: () => {
          set(s.value);
          if (p.type === 'sprite') void preview.loadSprites();
        } }, ...items.map((o) => h('option', { value: o, selected: o === cur }, o || '— none —')));
        input = s;
      }
    }
    return h('div', { class: `vfx-param p-${p.type}`, title: p.help ?? '' }, h('span', { class: 'vfx-param-name' }, p.label ?? p.name), input);
  };

  function drawInspector(): void {
    clear(inspector);
    if (!graph) return;
    const sel = selection;
    if (sel?.kind === 'edge') {
      inspector.append(
        h('div', { class: 'panel-title' }, 'Wire'),
        h('p', { class: 'small' }, `${sel.edge.from} → ${sel.edge.to}`),
        h('button', { class: 'small', onclick: removeSelected }, icon('trash', 13), 'Remove wire'),
      );
      return;
    }
    const n = sel?.kind === 'node' ? graph.nodes.find((x) => x.id === sel.id) : undefined;
    if (!n) {
      const g = graph;
      const desc = h('textarea', { rows: 2, value: g.description ?? '', placeholder: 'What this effect is for', oninput: () => {
        remember('description');
        g.description = desc.value;
        changed();
      } });
      const code = `await vfx('${g.name}', self, target)`;
      inspector.append(
        h('div', { class: 'panel-title' }, 'Effect'),
        h('label', { class: 'vfx-desc' }, desc),
        h('p', { class: 'muted small' }, 'Select a node to edit it. Drag from a node\'s right dot onto another to wire them; two wires from one node run together. Delete removes the selection, Ctrl+Z undoes.'),
        h('div', { class: 'panel-title' }, 'Play it'),
        h('code', { class: 'vfx-code' }, code),
        h('p', { class: 'muted small' }, `Or the event action Play effect, or a frame event named "vfx:${g.name}". A Message node tells the game when it connects: this.on('hit', ...).`),
      );
      return;
    }
    const spec = VFX_NODE_MAP.get(n.type)!;
    const body = nodeEls.get(n.id)?.querySelector<HTMLElement>('.vfx-node-body') ?? h('div');
    inspector.append(
      h('div', { class: 'panel-title vfx-insp-title' }, spec.label, n.type === 'start' ? null : iconButton('trash', 'Remove node', removeSelected, { class: 'icon-btn tiny' })),
      h('p', { class: 'muted small' }, spec.help),
      ...spec.params.map((p) => paramControl(n, p, body)),
    );
  }

  // ---------------------------------------------------------------- preview

  const preview = createPreview(() => graph, () => selection?.kind === 'node' ? selection.id : null, (id) => select({ kind: 'node', id }));

  // ---------------------------------------------------------------- list and page

  const renderList = async () => {
    let effects: Awaited<ReturnType<typeof gameApi.listVfx>> = [];
    try {
      effects = await gameApi.listVfx();
      state.vfx = effects.map((e) => e.name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    clear(list);
    list.append(h('div', { class: 'side-title' }, `Effects (${effects.length})`));
    for (const e of effects) {
      list.append(h('a', { class: `obj-item script-item${e.name === selected ? ' active' : ''}`, href: `#/vfx/${encodeURIComponent(e.name)}`, title: e.description ?? '' }, h('span', {}, e.name), h('span', { class: 'muted small' }, ` ${e.nodes}`)));
    }
    list.append(h('button', { class: 'tpl-btn', onclick: () => void newEffect(effects.map((e) => e.name)) }, icon('plus', 13), h('span', {}, 'New effect'), h('span', { class: 'muted small' }, 'Slash, impact, fireball, lightning, heal…')));
  };

  const newEffect = async (existing: string[]) => {
    let picked: { name: string; template?: string } | null = null;
    await modal('New effect', (close) => {
      const name = h('input', { type: 'text', placeholder: 'e.g. fire_slash', spellcheck: false });
      const start = (template?: string) => {
        const v = name.value.trim() || template || '';
        if (!VFX_NAME_RE.test(v)) return toast('Use letters, digits, "_" and "-" for the name', 'error');
        if (existing.includes(v)) return toast(`Effect "${v}" already exists`, 'error');
        picked = { name: v, template };
        close();
      };
      return h('div', { class: 'form' },
        h('label', {}, 'Name (scripts use vfx("name", ...))', name),
        h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: () => start() }, 'Create empty')),
        h('p', { class: 'muted small' }, 'Or start from a template:'),
        h('div', { class: 'tpl-grid' }, ...VFX_TEMPLATES.map((t) => h('button', { class: 'small', title: t.description, onclick: () => start(t.id) }, t.label))),
      );
    });
    const p = picked as { name: string; template?: string } | null;
    if (!p) return;
    try {
      await gameApi.createVfx(p.name, p.template);
      go(p.name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const showEmpty = () => {
    clear(main);
    main.append(h('div', { class: 'empty' },
      h('h2', {}, 'Visual effects'),
      h('p', { class: 'muted' }, 'Attacks, spells and hits as small graphs of slashes, shockwaves, beams, projectiles, particles, flashes and shake. Create one here or ask Claude for it, then play it from a script, an event or an animation frame.'),
      h('button', { class: 'primary', onclick: () => void gameApi.listVfx().then((l) => newEffect(l.map((e) => e.name))) }, icon('plus', 14), 'New effect'),
    ));
  };

  const rename = async () => {
    if (!graph) return;
    await save();
    const to = await promptText('Rename effect', 'New name', graph.name);
    if (!to || to === graph.name) return;
    if (!VFX_NAME_RE.test(to)) return toast('Use letters, digits, "_" and "-" for the name', 'error');
    try {
      await gameApi.renameVfx(graph.name, to);
      go(to);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const duplicate = async () => {
    if (!graph) return;
    await save();
    const to = await promptText('Duplicate effect', 'Name of the copy', `${graph.name}_copy`);
    if (!to) return;
    if (!VFX_NAME_RE.test(to)) return toast('Use letters, digits, "_" and "-" for the name', 'error');
    try {
      await gameApi.createVfx(to);
      await gameApi.saveVfx({ ...graph, name: to });
      go(to);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const remove = async () => {
    if (!graph || !(await confirmDialog('Delete effect', `Delete "${graph.name}"? Scripts and events that play it will stop finding it.`))) return;
    try {
      dirty = false;
      await gameApi.deleteVfx(graph.name);
      go(null);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const showEditor = () => {
    if (!graph) return;
    clear(main);
    main.append(
      h('header', { class: 'vfx-head' },
        h('h2', {}, graph.name),
        status,
        h('span', { class: 'spacer' }),
        iconButton('undo', 'Undo (Ctrl+Z)', () => swap(undo, redo), { class: 'icon-btn tiny' }),
        iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => swap(redo, undo), { class: 'icon-btn tiny' }),
        h('button', { class: 'small', onclick: () => void rename() }, 'Rename'),
        h('button', { class: 'small', onclick: () => void duplicate() }, 'Duplicate'),
        iconButton('trash', 'Delete effect', () => void remove(), { class: 'icon-btn tiny' }),
      ),
      h('div', { class: 'vfx-body' },
        h('div', { class: 'vfx-left' },
          palette,
          h('div', { class: 'vfx-canvas-wrap' }, canvas, h('div', { class: 'vfx-canvas-tools' }, zoomLabel, iconButton('fit', 'Fit the graph', fit, { class: 'icon-btn tiny' }))),
          problemsBox,
        ),
        h('aside', { class: 'vfx-right' }, preview.el, inspector),
      ),
    );
    drawGraph();
    drawInspector();
    requestAnimationFrame(fit);
  };

  const load = async () => {
    if (!selected) {
      graph = null;
      preview.stop();
      showEmpty();
      return;
    }
    try {
      graph = await gameApi.getVfx(selected);
    } catch (err) {
      toast((err as Error).message, 'error');
      go(null);
      return;
    }
    if (destroyed) return;
    undo = [];
    redo = [];
    selection = null;
    showEditor();
    preview.start();
    await preview.loadSprites();
  };

  void renderList();
  void load();

  return {
    /** A change arrived from outside (Claude through MCP, another tab). */
    refresh: () => {
      void renderList();
      if (dirty || !selected || !graph) return;
      void gameApi.getVfx(selected).then((g) => {
        if (destroyed || dirty || !graph || g.rev === graph.rev) return;
        remember();
        graph = g;
        if (selection?.kind === 'node' && !g.nodes.some((n) => n.id === (selection as { id: string }).id)) selection = null;
        if (selection?.kind === 'edge') selection = null;
        drawGraph();
        drawInspector();
        preview.graphChanged();
        void preview.loadSprites();
      }).catch(() => {});
    },
    destroy: () => {
      destroyed = true;
      preview.stop();
      unregister();
      void save();
    },
  };
}

/** The live preview: plays the graph between two draggable markers, with a timeline of its nodes. */
function createPreview(getGraph: () => VfxGraph | null, selectedNode: () => string | null, onPick: (id: string) => void) {
  const cv = h('canvas', { class: 'vfx-preview', width: PREVIEW_W, height: PREVIEW_H, title: 'Drag the blue and red blocks to move the attacker and the victim' });
  const ctx = cv.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const images = new Map<string, CanvasImageSource>();
  const assets = new Map<string, SpriteAsset>();
  const renderer = new CanvasRenderer(ctx, images, PREVIEW_W, PREVIEW_H);
  const src = { x: 64, y: 84 };
  const dst = { x: 216, y: 84 };
  let loop = true;
  let dark = false;
  let sound = false;
  let hasTarget = true;
  let pace = 1;
  let tint = '';
  let scale = 1;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let time = 0;
  let waiting = 0;
  let shakeUntil = 0;
  let shakeAmp = 0;
  let blink = { source: 0, target: 0 };
  let labels: { text: string; x: number; y: number; t: number }[] = [];
  let timeline: VfxTimeline | null = null;
  let restartTimer = 0;
  let sys: VfxSystem;

  const makeSystem = () => new VfxSystem({
    asset: (n) => assets.get(n),
    sound: (n, v) => {
      if (sound && v > 0) previewSound(n, state.audio);
    },
    shake: (i, s) => {
      shakeAmp = i;
      shakeUntil = time + s;
    },
    message: (m, d) => labels.push({ text: m, x: d.x, y: d.y - 12, t: 0 }),
  });
  sys = makeSystem();

  const playOpts = () => ({
    source: src,
    ...(hasTarget ? { target: dst } : { angle: 0 }),
    ...(tint ? { tint } : {}),
    ...(scale !== 1 ? { scale } : {}),
    blink: (who: 'source' | 'target', s: number) => {
      blink[who] = time + s;
    },
  });

  const bars = h('div', { class: 'vfx-timeline' });
  const playhead = h('div', { class: 'vfx-playhead' });
  const lengthLabel = h('span', { class: 'muted small' }, '');

  const replay = () => {
    const g = getGraph();
    sys.clear();
    sys = makeSystem();
    time = 0;
    acc = 0;
    waiting = 0;
    labels = [];
    blink = { source: 0, target: 0 };
    shakeUntil = 0;
    if (g) sys.play(g, playOpts());
  };

  const drawTimeline = () => {
    const g = getGraph();
    clear(bars);
    bars.append(playhead);
    if (!g) return;
    const { source: _s, target: _t, blink: _b, ...rest } = playOpts() as ReturnType<typeof playOpts> & { target?: unknown };
    void _s; void _t; void _b;
    timeline = simulateVfx(g, { ...rest, source: src, ...(hasTarget ? { target: dst } : {}), host: { asset: (n) => assets.get(n) } });
    const total = Math.max(0.05, timeline.duration);
    lengthLabel.textContent = `${timeline.duration.toFixed(2)} s · ${timeline.peakParticles} particles`;
    const rows = new Map<string, VfxTimeline['spans']>();
    for (const s of timeline.spans) {
      if (s.type === 'start') continue;
      if (!rows.has(s.id)) rows.set(s.id, []);
      rows.get(s.id)!.push(s);
    }
    const sel = selectedNode();
    for (const [id, spans] of rows) {
      const group = VFX_NODE_MAP.get(spans[0].type)?.group ?? 'Flow';
      bars.append(h('div', { class: `vfx-tl-row${id === sel ? ' on' : ''}`, 'data-id': id, onclick: () => onPick(id) },
        h('span', { class: 'vfx-tl-name' }, id),
        h('span', { class: 'vfx-tl-track' }, ...spans.map((s) => h('i', { class: `g-${group}`, title: `${s.from.toFixed(2)}–${s.to.toFixed(2)} s`, style: `left:${(s.from / total) * 100}%;width:max(3px, ${((s.to - s.from) / total) * 100}%)` })))));
    }
  };

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (isPlaying()) { // Behind the Play overlay nobody sees it, and it would take time from the game.
      last = now;
      return;
    }
    const dt = Math.min(0.1, (now - last) / 1000) * pace;
    last = now;
    acc += dt;
    while (acc >= STEP) {
      acc -= STEP;
      time += STEP;
      sys.tick(STEP);
      for (const l of labels) l.t += STEP;
      labels = labels.filter((l) => l.t < 0.6);
      if (sys.idle) {
        waiting += STEP;
        if (loop && waiting > 0.7) replay();
      }
    }
    // The playhead follows the effect, not the pause between loops.
    if (timeline) playhead.style.left = `calc(var(--tl-name) + (100% - var(--tl-name)) * ${Math.min(1, time / Math.max(0.05, timeline.duration))})`;
    let cx = 0;
    let cy = 0;
    if (time < shakeUntil) {
      cx = (Math.random() * 2 - 1) * shakeAmp;
      cy = (Math.random() * 2 - 1) * shakeAmp;
    }
    const r = renderer;
    r.clear(dark ? '#14151f' : '#39424f');
    if (!dark) r.rect(0, 96, PREVIEW_W, PREVIEW_H - 96, '#2d3540');
    sys.draw(r, cx, cy, 1, true);
    const blinking = (until: number) => time < until && Math.floor(time * 12) % 2 === 0;
    if (!blinking(blink.source)) r.rect(src.x - 6 - cx, src.y - 8 - cy, 12, 16, '#41a6f6');
    if (hasTarget && !blinking(blink.target)) r.rect(dst.x - 6 - cx, dst.y - 8 - cy, 12, 16, '#e43b44');
    if (dark) r.lighting('#55586e', sys.lights().map((l) => ({ ...l, x: l.x - cx, y: l.y - cy, intensity: Math.min(1, l.intensity) })), 0.6);
    sys.draw(r, cx, cy, 1, false);
    sys.drawScreen(r, PREVIEW_W, PREVIEW_H);
    for (const l of labels) r.text(l.text, Math.round(l.x - l.text.length * 2), Math.round(l.y - l.t * 16), '#ffffff', 1);
  };

  let dragging: VfxPointRef | null = null;
  type VfxPointRef = { x: number; y: number };
  const toCanvas = (e: PointerEvent) => {
    const b = cv.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * PREVIEW_W, y: ((e.clientY - b.top) / b.height) * PREVIEW_H };
  };
  cv.addEventListener('pointerdown', (e) => {
    const p = toCanvas(e);
    const near = (m: VfxPointRef) => Math.abs(p.x - m.x) < 12 && Math.abs(p.y - m.y) < 14;
    dragging = near(src) ? src : hasTarget && near(dst) ? dst : null;
    if (dragging) cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const p = toCanvas(e);
    dragging.x = Math.round(Math.max(0, Math.min(PREVIEW_W, p.x)));
    dragging.y = Math.round(Math.max(0, Math.min(PREVIEW_H, p.y)));
  });
  cv.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = null;
    drawTimeline();
    replay();
  });

  const toggle = (label: string, title: string, on: boolean, set: (v: boolean) => void) => {
    const b: HTMLButtonElement = h('button', { class: `small${on ? ' on' : ''}`, title, onclick: () => {
      on = !on;
      b.classList.toggle('on', on);
      set(on);
    } }, label);
    return b;
  };
  const refresh = () => {
    drawTimeline();
    replay();
  };
  const tintInput = colorInput('', (v) => {
    tint = v;
    refresh();
  }, { allowEmpty: true, placeholder: 'tint', fallback: '#ff4060' });
  const speedSel = h('select', { title: 'Preview speed (slow motion, the effect is not changed)', onchange: () => (pace = Number(speedSel.value)) }, ...[['1', '1×'], ['0.5', '½×'], ['0.25', '¼×'], ['0.1', '⅒×']].map(([v, l]) => h('option', { value: v }, l)));
  const scaleSel = h('select', { title: 'Try vfx(..., { scale })', onchange: () => {
    scale = Number(scaleSel.value);
    refresh();
  } }, ...[['1', 'size 1'], ['0.5', 'size ½'], ['1.5', 'size 1½'], ['2', 'size 2']].map(([v, l]) => h('option', { value: v }, l)));

  const el = h('div', { class: 'vfx-preview-box' },
    cv,
    h('div', { class: 'vfx-preview-tools' },
      iconButton('play', 'Play again', replay, { class: 'icon-btn tiny' }),
      toggle('Loop', 'Replay it when it ends', loop, (v) => (loop = v)),
      toggle('Dark', 'A dark scene, to judge glow and Light nodes', dark, (v) => (dark = v)),
      toggle('Target', 'With a victim, or firing ahead with none', hasTarget, (v) => {
        hasTarget = v;
        refresh();
      }),
      toggle('Sound', 'Play Sound nodes', sound, (v) => (sound = v)),
      speedSel,
      scaleSel,
      tintInput,
    ),
    h('div', { class: 'vfx-tl-head' }, h('span', { class: 'panel-title' }, 'Timeline'), lengthLabel),
    bars,
  );

  return {
    el,
    start: () => {
      cancelAnimationFrame(raf);
      last = performance.now();
      refresh();
      raf = requestAnimationFrame(frame);
    },
    stop: () => cancelAnimationFrame(raf),
    /** Loads what Sprite and Projectile nodes draw, then replays. */
    loadSprites: async () => {
      const g = getGraph();
      if (!g) return;
      const names = [...new Set(g.nodes.filter((n) => n.type === 'sprite' || n.type === 'projectile').map((n) => vfxParam<string>(n, 'sprite')).filter(Boolean))];
      const missing = names.filter((n) => !assets.has(n));
      if (!missing.length) return;
      const loaded = await Promise.all(missing.map((n) => state.asset(n).catch(() => undefined)));
      loaded.forEach((a: LoadedAsset | undefined) => {
        if (!a) return;
        assets.set(a.name, a);
        images.set(a.name, a.img);
      });
      refresh();
    },
    graphChanged: () => {
      clearTimeout(restartTimer);
      restartTimer = window.setTimeout(refresh, 120);
    },
    highlight: () => {
      const sel = selectedNode();
      for (const row of bars.querySelectorAll<HTMLElement>('.vfx-tl-row')) row.classList.toggle('on', row.dataset.id === sel);
    },
  };
}
