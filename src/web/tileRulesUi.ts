/**
 * Tile rules editor (game.json → tilesets[name]): autotiling (blob, corners), big seamless textures (grid), random
 * variants, animated tiles and edge overlays. Same data as the MCP tool set_tileset_rules, with a live
 * preview drawn by the same TileResolver the game uses.
 */

import { CORNER_TILES, type EdgeRule, type TileRule, type TilesetRules, TileResolver, normalizeTilesetRules } from '../core/game/tilerules.js';
import type { TileLayer } from '../core/game/types.js';
import type { LoadedAsset } from './gameApi.js';
import { state } from './gameState.js';
import { clear, h, icon, iconButton, modal } from './dom.js';

const KIND_HELP: Record<TileRule['kind'], string> = {
  grid: 'A big seamless texture cut into size×size tiles: each cell shows the piece for its position, so the ground never repeats every tile.',
  random: 'One of "count" alternatives (tiles first, first+1, …) picked by position: flowers, stones, cracks.',
  blob: 'Autotile: the 47 edge / corner shapes chosen from the 8 neighbours (forest canopies, cliffs, water). With size > 1 each shape is a size×size block.',
  corners: 'Autotile for two terrains from a 16-tile corner set. Put the rule on the lower terrain: cells of the other terrain stay whole, and the transition is drawn on this terrain next to them.',
};

/** Tiles per block of a rule (one shape / texture / alternative set). */
const blockSize = (r: { kind?: TileRule['kind']; size?: number; count?: number }) =>
  r.kind === 'corners' ? CORNER_TILES : r.kind === 'random' ? (r.count ?? 1) : r.kind === 'blob' || r.kind === undefined ? 47 * (r.size ?? 1) ** 2 : (r.size ?? 1) ** 2;

interface TilesetDraw {
  cols: number;
  gw: number;
  gh: number;
  count: number;
  /** Draws tile `t` (frame 0) at dx, dy with size s. */
  draw(c: CanvasRenderingContext2D, t: number, dx: number, dy: number, s: number): void;
}

function tilesetDraw(a: LoadedAsset): TilesetDraw {
  const g = a.grid ?? { width: 16, height: 16 };
  const cols = Math.max(1, Math.floor(a.width / g.width));
  const rows = Math.max(1, Math.floor(a.height / g.height));
  const f0 = a.frames[0];
  return {
    cols, gw: g.width, gh: g.height, count: cols * rows,
    draw(c, t, dx, dy, s) {
      if (t < 0 || t >= cols * rows) return;
      c.drawImage(a.img, f0.x + (t % cols) * g.width, f0.y + Math.floor(t / cols) * g.height, g.width, g.height, dx, dy, s, s);
    },
  };
}

/** A tile index input with a thumbnail; clicking the thumbnail opens a picker over the tileset. */
function tileInput(td: TilesetDraw, value: number, onSet: (t: number) => void, opts: { max?: number; title?: string } = {}): HTMLElement {
  const thumb = h('canvas', { class: 'tr-thumb', width: 24, height: 24, title: 'Pick from the tileset' });
  const paint = (t: number) => {
    const c = thumb.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, 24, 24);
    td.draw(c, t, 0, 0, 24);
  };
  const inp = h('input', { type: 'number', class: 'num', min: '0', max: String(td.count - 1), value: String(value), title: opts.title,
    onchange: () => { const t = Math.max(0, Math.min(td.count - 1, Math.round(Number(inp.value) || 0))); inp.value = String(t); paint(t); onSet(t); } });
  const picker = h('div', { class: 'tr-picker', hidden: true });
  thumb.addEventListener('click', () => {
    if (!picker.hidden) { picker.hidden = true; return; }
    clear(picker);
    const max = Math.min(td.count, opts.max ?? td.count);
    const rows = Math.ceil(max / td.cols);
    const s = 20;
    const cv = h('canvas', { width: td.cols * s, height: rows * s });
    const c = cv.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    for (let t = 0; t < max; t++) td.draw(c, t, (t % td.cols) * s, Math.floor(t / td.cols) * s, s);
    const cur = Number(inp.value);
    c.strokeStyle = '#feae34';
    c.lineWidth = 2;
    c.strokeRect((cur % td.cols) * s + 1, Math.floor(cur / td.cols) * s + 1, s - 2, s - 2);
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const t = Math.floor(((e.clientY - r.top) / r.height) * rows) * td.cols + Math.floor(((e.clientX - r.left) / r.width) * td.cols);
      if (t < 0 || t >= max) return;
      inp.value = String(t);
      paint(t);
      onSet(t);
      picker.hidden = true;
    });
    picker.append(cv);
    picker.hidden = false;
  });
  paint(value);
  return h('span', { class: 'tr-tile' }, thumb, inp, picker);
}

const listText = (v: number[] | undefined) => (v ?? []).join(', ');
const parseList = (s: string) => [...new Set(s.split(/[\s,]+/).map((x) => Math.round(Number(x))).filter((n) => Number.isFinite(n) && n >= 0))];

/** Sample map for a rule's preview: an island of `tile` (with a bay) on `around`. */
function sampleLayer(tile: number, around: number, cols = 10, rows = 7): TileLayer {
  const tiles = new Array(cols * rows).fill(around);
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) tiles[y * cols + x] = tile;
  tiles[3 * cols + 4] = around;
  tiles[3 * cols + 5] = around;
  tiles[1 * cols + 7] = around;
  tiles[(rows - 2) * cols + 1] = around;
  return { name: 'preview', tiles, solid: false, visible: true };
}

/** Opens the rules editor of a tileset. Changes save with the game (state.change). */
export async function openTileRules(asset: LoadedAsset): Promise<void> {
  const g = state.game!;
  const td = tilesetDraw(asset);
  // Work on a copy; every change writes a fresh normalized object (so renderers rebuild their resolvers).
  const work: TilesetRules = JSON.parse(JSON.stringify(g.tilesets?.[asset.name] ?? {}));
  work.rules ??= [];
  work.edges ??= [];
  const commit = () => {
    const n = normalizeTilesetRules(work);
    const all = { ...(g.tilesets ?? {}) };
    if (n) all[asset.name] = n;
    else delete all[asset.name];
    if (Object.keys(all).length) g.tilesets = all;
    else delete g.tilesets;
    state.change();
    schedulePreviews();
  };

  const previews: (() => void)[] = [];
  let raf = 0;
  const schedulePreviews = () => { for (const p of previews) p(); };
  const t0 = performance.now();
  const animate = () => {
    if (!document.body.contains(body)) return;
    for (const p of previews) p();
    raf = requestAnimationFrame(animate);
  };

  /** A live preview canvas: the sample drawn through the current rules. */
  const preview = (layerFor: () => TileLayer, cols = 10, rows = 7): HTMLCanvasElement => {
    const s = 16;
    const cv = h('canvas', { class: 'tr-preview checker', width: cols * s, height: rows * s });
    const c = cv.getContext('2d')!;
    const draw = () => {
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, cv.width, cv.height);
      const r = new TileResolver(normalizeTilesetRules(work));
      const l = layerFor();
      const out: number[] = [];
      const clock = (performance.now() - t0) / 1000;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (l.tiles[y * cols + x] < 0) continue;
        for (const t of r.resolve(l, cols, rows, x, y, out, clock)) td.draw(c, t, x * s, y * s, s);
      }
    };
    previews.push(draw);
    draw();
    return cv;
  };

  const body = h('div', { class: 'tile-rules' });
  const render = () => {
    clear(body);
    previews.length = 0;
    const paintIn = h('input', { type: 'number', class: 'num', min: '1', max: String(td.count), placeholder: 'all', value: work.paintable === undefined ? '' : String(work.paintable),
      onchange: () => { const v = Math.round(Number(paintIn.value)); if (paintIn.value.trim() === '' || !v) delete work.paintable; else work.paintable = Math.max(1, Math.min(td.count, v)); commit(); } });
    body.append(h('p', { class: 'muted small' }, 'Scenes store only the tile you paint (collisions use it too); these rules decide what the game and the scene editor draw for it. Pieces are other tiles of ', h('b', {}, asset.name), ' (indices count row by row).'),
      h('label', { class: 'inline tr-paintable', title: 'The scene palette shows only tiles 0…paintable-1: the rest are generated pieces' }, 'Paintable tiles', paintIn));

    // ---------------------------------------------------------------- rules
    const rulesBox = h('div', { class: 'tr-list' });
    work.rules!.forEach((r, i) => {
      const set = (fn: () => void, rerender = false) => { fn(); commit(); if (rerender) render(); };
      const kindSel = h('select', { onchange: () => set(() => {
        r.kind = kindSel.value as TileRule['kind'];
        if (r.kind === 'random') r.count ??= 4; else delete r.count;
        if (r.kind === 'random' || r.kind === 'corners') delete r.size;
        if (r.kind !== 'blob') delete r.border;
        if (r.kind === 'corners') r.group = [Math.min(td.count - 1, r.first + CORNER_TILES - 1)];
        else { delete r.alt; delete r.invert; if (r.kind !== 'blob') delete r.group; }
      }, true) }, ...(['grid', 'random', 'blob', 'corners'] as const).map((k) => h('option', { value: k, selected: r.kind === k }, k)));
      const numField = (label: string, get: () => number | undefined, put: (v: number | undefined) => void, attrs: Record<string, unknown> = {}) => {
        const inp = h('input', { type: 'number', class: 'num', value: get() === undefined ? '' : String(get()), ...attrs, onchange: () => set(() => put(inp.value.trim() === '' ? undefined : Number(inp.value)), true) });
        return h('label', {}, label, inp);
      };
      const around = (work.rules!.find((x) => x !== r && x.tile !== r.tile)?.tile) ?? -1;
      const block = blockSize(r);
      rulesBox.append(h('div', { class: 'tr-item' },
        h('div', { class: 'tr-head' },
          h('label', { title: 'The tile you paint in scenes' }, 'Painted tile', tileInput(td, r.tile, (t) => set(() => (r.tile = t)), { max: work.paintable })),
          h('label', { title: KIND_HELP[r.kind] }, 'Kind', kindSel),
          h('label', { title: `First tile of the block (${block} tiles${r.frames && r.frames > 1 ? ` × ${r.frames} frames` : ''})` }, 'First piece', tileInput(td, r.first, (t) => set(() => (r.first = t)))),
          h('span', { class: 'spacer' }),
          iconButton('up', 'Move up', () => { if (i > 0) set(() => work.rules!.splice(i - 1, 0, ...work.rules!.splice(i, 1)), true); }, { class: 'icon-btn tiny' }),
          iconButton('copy', 'Duplicate', () => set(() => work.rules!.splice(i + 1, 0, JSON.parse(JSON.stringify(r))), true), { class: 'icon-btn tiny' }),
          iconButton('trash', 'Remove rule', () => set(() => work.rules!.splice(i, 1), true), { class: 'icon-btn tiny' }),
        ),
        h('p', { class: 'muted small' }, KIND_HELP[r.kind], ` Block: tiles ${r.first}–${r.first + block * (r.frames ?? 1) - 1}${block * (r.frames ?? 1) + r.first > td.count ? ' (past the end of the tileset!)' : ''}.`),
        h('div', { class: 'tr-body' },
          h('div', { class: 'tr-fields' },
            r.kind === 'corners'
              ? numField('Plain terrain alternatives', () => r.count, (v) => {
                if (!v) { delete r.count; delete r.alt; } else { r.count = Math.max(1, Math.round(v)); r.alt ??= Math.min(td.count - 1, r.first + CORNER_TILES); }
              }, { min: '0', placeholder: '0' })
              : r.kind === 'random'
              ? numField('Alternatives', () => r.count, (v) => { r.count = Math.max(1, Math.round(v ?? 1)); }, { min: '1' })
              : numField('Pieces per side', () => r.size ?? 1, (v) => { if (!v || v <= 1) delete r.size; else r.size = Math.min(16, Math.round(v)); }, { min: '1', max: '16' }),
            numField('Animation frames', () => r.frames, (v) => { if (!v || v <= 1) delete r.frames; else r.frames = Math.min(64, Math.round(v)); }, { min: '1', max: '64', placeholder: '1' }),
            numField('Frames / s', () => r.fps, (v) => { if (!v || v <= 0) delete r.fps; else r.fps = Math.min(60, v); }, { min: '0.1', step: '0.5', placeholder: '4' }),
            r.kind === 'corners' && r.count ? h('label', { title: 'First of the alternative tiles drawn where no corner touches the other terrain' }, 'First alternative', tileInput(td, r.alt ?? 0, (t) => set(() => (r.alt = t)))) : null,
            r.kind === 'corners' ? h('label', { title: 'The painted tiles of the other terrain' }, 'Other terrain',
              h('input', { type: 'text', spellcheck: false, value: listText(r.group), onchange: (e: Event) => set(() => { const l = parseList((e.target as HTMLInputElement).value); if (l.length) r.group = l; }, true) })) : null,
            r.kind === 'corners' ? h('label', { class: 'inline', title: 'For solid terrain (water, walls): put the rule on it and list the walkable terrain above, so the border stays inside its cells' },
              h('input', { type: 'checkbox', checked: !!r.invert, onchange: (e: Event) => set(() => { if ((e.target as HTMLInputElement).checked) r.invert = true; else delete r.invert; }, true) }), 'Border inside this terrain') : null,
            r.kind === 'blob' ? h('label', { title: 'Painted tiles counted as the same terrain (default: just the painted tile)' }, 'Same terrain as',
              h('input', { type: 'text', spellcheck: false, placeholder: String(r.tile), value: listText(r.group), onchange: (e: Event) => set(() => { const l = parseList((e.target as HTMLInputElement).value); if (l.length) r.group = l; else delete r.group; }, true) })) : null,
            r.kind === 'blob' ? h('label', { class: 'inline', title: 'Outside the map counts as the same terrain' },
              h('input', { type: 'checkbox', checked: r.border !== false, onchange: (e: Event) => set(() => { if ((e.target as HTMLInputElement).checked) delete r.border; else r.border = false; }) }), 'Map edge counts as same terrain') : null,
          ),
          h('div', { class: 'tr-preview-box', title: 'Preview: an island of the painted tile on another terrain, drawn through all the rules' }, preview(() => r.kind === 'corners' ? (r.invert ? sampleLayer(r.tile, r.group?.[0] ?? r.tile) : sampleLayer(r.group?.[0] ?? r.tile, r.tile)) : sampleLayer(r.tile, around))),
        ),
      ));
    });
    const addRule = h('button', { class: 'small', onclick: () => {
      const used = new Set(work.rules!.map((r) => r.tile));
      let tile = 0;
      while (used.has(tile) && tile < td.count - 1) tile++;
      work.rules!.push({ tile, kind: 'blob', first: Math.min(td.count - 1, work.paintable ?? 0) });
      commit();
      render();
    } }, icon('plus', 13), 'Rule');

    // ---------------------------------------------------------------- edges
    const edgesBox = h('div', { class: 'tr-list' });
    work.edges!.forEach((e, i) => {
      const set = (fn: () => void, rerender = false) => { fn(); commit(); if (rerender) render(); };
      const listField = (label: string, title: string, get: () => number[], put: (v: number[]) => void) =>
        h('label', { title }, label, h('input', { type: 'text', spellcheck: false, value: listText(get()), onchange: (ev: Event) => set(() => { const l = parseList((ev.target as HTMLInputElement).value); if (l.length) put(l); }, true) }));
      const numField = (label: string, get: () => number | undefined, put: (v: number | undefined) => void, attrs: Record<string, unknown> = {}) => {
        const inp = h('input', { type: 'number', class: 'num', value: get() === undefined ? '' : String(get()), ...attrs, onchange: () => set(() => put(inp.value.trim() === '' ? undefined : Number(inp.value)), true) });
        return h('label', {}, label, inp);
      };
      edgesBox.append(h('div', { class: 'tr-item' },
        h('div', { class: 'tr-head' },
          listField('On tiles', 'Cells painted with these tiles get the overlay…', () => e.on, (v) => (e.on = v)),
          listField('Next to', '…on the sides where a neighbour is one of these', () => e.from, (v) => (e.from = v)),
          h('label', { title: 'First tile of the 47-shape overlay block' }, 'First piece', tileInput(td, e.first, (t) => set(() => (e.first = t)))),
          h('span', { class: 'spacer' }),
          iconButton('trash', 'Remove overlay', () => set(() => work.edges!.splice(i, 1), true), { class: 'icon-btn tiny' }),
        ),
        h('div', { class: 'tr-body' },
          h('div', { class: 'tr-fields' },
            numField('Pieces per side', () => e.size ?? 1, (v) => { if (!v || v <= 1) delete e.size; else e.size = Math.min(16, Math.round(v)); }, { min: '1', max: '16' }),
            numField('Animation frames', () => e.frames, (v) => { if (!v || v <= 1) delete e.frames; else e.frames = Math.min(64, Math.round(v)); }, { min: '1', placeholder: '1' }),
            numField('Frames / s', () => e.fps, (v) => { if (!v || v <= 0) delete e.fps; else e.fps = Math.min(60, v); }, { min: '0.1', step: '0.5', placeholder: '4' }),
            h('label', { class: 'inline', title: 'Empty cells of the layer count as "next to" too (water painted on its own layer: empty = land)' },
              h('input', { type: 'checkbox', checked: !!e.empty, onchange: (ev: Event) => set(() => { if ((ev.target as HTMLInputElement).checked) e.empty = true; else delete e.empty; }) }), 'Empty cells count'),
          ),
          h('div', { class: 'tr-preview-box', title: 'Preview: the first "on" tile surrounded by the first "next to" tile' }, preview(() => sampleLayer(e.on[0], e.empty ? -1 : e.from[0]))),
        ),
      ));
    });
    const addEdge = h('button', { class: 'small', onclick: () => {
      work.edges!.push({ on: [work.rules![0]?.tile ?? 0], from: [1], first: Math.min(td.count - 1, work.paintable ?? 0) } as EdgeRule);
      commit();
      render();
    } }, icon('plus', 13), 'Edge overlay');

    body.append(
      h('h3', {}, `Rules (${work.rules!.length})`), rulesBox.childElementCount ? rulesBox : h('p', { class: 'muted small' }, 'No rules: every painted tile is drawn as itself.'), addRule,
      h('h3', {}, `Edge overlays (${work.edges!.length})`), h('p', { class: 'muted small' }, 'Drawn on top of a cell where it touches another terrain: grass creeping onto paths, foam on shores, snow on rocks.'),
      edgesBox, addEdge,
    );
  };
  render();
  raf = requestAnimationFrame(animate);
  await modal(`Tile rules · ${asset.name}`, () => body, { wide: true });
  cancelAnimationFrame(raf);
}
