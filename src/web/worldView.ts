/** World page: the scenes as a map, how they connect, and what the map checks found. */

import type { Problem } from '../core/game/catalog.js';
import type { WorldLink, WorldMap, WorldScene } from '../core/game/worldMap.js';
import { clear, h, toast } from './dom.js';
import { gameApi } from './gameApi.js';
import { appNav } from './nav.js';

const NODE_W = 188;
const NODE_H = 150;
const GAP_X = 92;
const GAP_Y = 22;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Columns by distance from the start scene; the scenes only code reaches and the unreachable ones come last. */
function layout(world: WorldMap): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const walk = (root: string, d: number) => {
    depth.set(root, d);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const l of world.links) {
        if (l.from === cur && !depth.has(l.to)) {
          depth.set(l.to, depth.get(cur)! + 1);
          queue.push(l.to);
        }
      }
    }
  };
  if (world.start) walk(world.start, 0);
  // A title screen often leaves through a script: the connected maps are laid out from the one with the most exits.
  const exits = (name: string) => world.links.filter((l) => l.from === name).length;
  for (;;) {
    const root = world.scenes.filter((s) => s.reachable && !depth.has(s.name) && exits(s.name)).sort((a, b) => exits(b.name) - exits(a.name))[0];
    if (!root) break;
    walk(root.name, 1);
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns = new Map<number, WorldScene[]>();
  for (const s of world.scenes) {
    const d = depth.get(s.name) ?? maxDepth + (s.reachable ? 1 : 2);
    columns.set(d, [...(columns.get(d) ?? []), s]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  [...columns.keys()].sort((a, b) => a - b).forEach((d, col) => {
    columns.get(d)!.forEach((s, row) => pos.set(s.name, { x: col * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) }));
  });
  return pos;
}

function miniMap(s: WorldScene, solid: string, doors: WorldLink[], tileSize: number): HTMLCanvasElement {
  const scale = Math.max(1, Math.floor(Math.min(NODE_W / s.cols, 92 / s.rows)));
  const c = h('canvas', { class: 'world-mini', width: s.cols * scale, height: s.rows * scale });
  const g = c.getContext('2d')!;
  g.fillStyle = '#3a4152';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#1b1e26';
  for (let y = 0; y < s.rows; y++) for (let x = 0; x < s.cols; x++) if (solid[y * s.cols + x] === '1') g.fillRect(x * scale, y * scale, scale, scale);
  g.fillStyle = '#feae34';
  for (const d of doors) {
    if (d.x === undefined || d.y === undefined) continue;
    const size = Math.max(2, scale);
    g.fillRect(Math.floor(d.x / tileSize) * scale, Math.floor(d.y / tileSize) * scale, size, size);
  }
  return c;
}

/** The page that shows the place a problem is about. */
function problemHref(p: Problem): string | null {
  const m = /^scene (\S+)(?:.*#(\S+))?/.exec(p.where);
  return m ? `#/scene/${encodeURIComponent(m[1])}${m[2] ? `~${encodeURIComponent(m[2])}` : ''}` : null;
}

export function renderWorld(root: HTMLElement): () => void {
  clear(root);
  const body = h('main', { class: 'world-page' }, h('p', { class: 'muted' }, 'Reading the maps…'));
  root.append(h('div', { class: 'page' }, appNav('world'), body));

  const render = (r: { world: WorldMap; problems: Problem[]; minimaps: Record<string, string> }, tileSizes: Map<string, number>) => {
    clear(body);
    const { world, problems, minimaps } = r;
    if (!world.scenes.length) {
      body.append(h('div', { class: 'empty big' }, h('h2', {}, 'No scenes yet'), h('p', {}, 'The map of the game appears here when it has scenes.')));
      return;
    }
    const pos = layout(world);
    const width = Math.max(...[...pos.values()].map((p) => p.x)) + NODE_W;
    const height = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H;
    const lines = svg('svg', { class: 'world-links', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
    const defs = svg('defs', {});
    const marker = svg('marker', { id: 'world-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' });
    marker.append(svg('path', { d: 'M0 0 L8 4 L0 8 z', fill: 'currentColor' }));
    defs.append(marker);
    lines.append(defs);
    const pairs = new Set<string>();
    for (const l of world.links) {
      if (l.from === null || l.from === l.to || pairs.has(`${l.from}>${l.to}`)) continue;
      pairs.add(`${l.from}>${l.to}`);
      const a = pos.get(l.from)!;
      const b = pos.get(l.to)!;
      // Forward links leave from the right and backward ones from the left, a little apart so a pair stays readable.
      const forward = b.x >= a.x;
      const offset = forward ? -10 : 10;
      const x0 = forward ? a.x + NODE_W : a.x;
      const x1 = forward ? b.x : b.x + NODE_W;
      const y0 = a.y + NODE_H / 2 + offset;
      const y1 = b.y + NODE_H / 2 + offset;
      const bend = Math.max(36, Math.abs(x1 - x0) / 2) * (forward ? 1 : -1);
      lines.append(svg('path', { d: `M${x0} ${y0} C${x0 + bend} ${y0} ${x1 - bend} ${y1} ${x1} ${y1}`, class: 'world-link', 'marker-end': 'url(#world-arrow)' }));
    }
    const nodes = world.scenes.map((s) => {
      const p = pos.get(s.name)!;
      const doors = world.links.filter((l) => l.from === s.name && l.via === 'door');
      const badge = s.name === world.start ? 'start' : !s.reachable ? 'unreachable' : s.scripted ? 'from code' : '';
      return h('a', { class: `world-node${s.reachable ? '' : ' bad'}`, href: `#/scene/${encodeURIComponent(s.name)}`, style: `left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px`, title: `${s.cols}×${s.rows} tiles · ${s.instances} instances` },
        miniMap(s, minimaps[s.name] ?? '', doors, tileSizes.get(s.name) ?? 16),
        h('span', { class: 'world-name' }, s.name),
        h('span', { class: 'muted small' }, `${new Set(doors.map((d) => d.to)).size} exits${badge ? ' · ' : ''}`, badge ? h('span', { class: `world-badge ${badge.replace(' ', '-')}` }, badge) : null));
    });
    body.append(
      h('div', { class: 'world-canvas-wrap' }, h('div', { class: 'world-canvas', style: `width:${width}px;height:${height}px` }, lines, ...nodes)),
      h('section', { class: 'world-problems' },
        h('div', { class: 'side-title' }, `Map checks (${problems.length})`),
        problems.length ? null : h('p', { class: 'muted' }, 'Nothing to report.'),
        ...problems.slice(0, 300).map((p) => {
          const href = problemHref(p);
          const text = [h('span', { class: 'world-where' }, p.where), h('span', { class: 'muted' }, ` ${p.message}`)];
          return href ? h('a', { class: 'world-problem', href }, ...text) : h('div', { class: 'world-problem' }, ...text);
        }),
        problems.length > 300 ? h('p', { class: 'muted small' }, `… ${problems.length - 300} more`) : null),
    );
  };

  const refresh = async () => {
    try {
      const [report, scenes] = await Promise.all([gameApi.world(), Promise.all((await gameApi.listScenes()).map(async (s) => [s.name, s.tileSize] as const))]);
      render(report, new Map(scenes));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  void refresh();
  return () => void refresh();
}
