/**
 * Visual effects as small flow graphs (vfx/<name>.json): a Start node fires, each node does its thing
 * (a slash, a shockwave, a projectile, a screen shake...) and when it ends fires the nodes wired after it.
 * Two wires out of one node run in parallel; a Delay in between staggers them.
 *
 * VFX_NODES is the single description of what exists: the web inspector and the MCP reference are generated
 * from it, so a param added here shows up in both.
 */

export type VfxParamType = 'number' | 'range' | 'color' | 'colors' | 'choice' | 'bool' | 'sprite' | 'sound' | 'text';
export type VfxValue = number | boolean | string | string[] | [number, number];

export interface VfxParam {
  name: string;
  type: VfxParamType;
  default: VfxValue;
  label?: string;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export type VfxGroup = 'Flow' | 'Shapes' | 'Particles' | 'Feedback';

export interface VfxNodeSpec {
  type: string;
  label: string;
  group: VfxGroup;
  help: string;
  params: VfxParam[];
  /** Output ports; the first is the default one. */
  outputs: string[];
}

export interface VfxNode {
  id: string;
  type: string;
  /** Position in the graph view. */
  x: number;
  y: number;
  params: Record<string, VfxValue>;
}

export interface VfxEdge {
  from: string;
  /** Output port of `from`; the node's first output when omitted. */
  port?: string;
  to: string;
}

export interface VfxGraph {
  name: string;
  description?: string;
  nodes: VfxNode[];
  edges: VfxEdge[];
  rev?: string;
  updatedBy?: string;
}

const num = (name: string, def: number, min?: number, max?: number, step?: number, help?: string, label?: string): VfxParam => ({ name, type: 'number', default: def, min, max, step, help, label });
const range = (name: string, def: [number, number], min?: number, max?: number, step?: number, help?: string, label?: string): VfxParam => ({ name, type: 'range', default: def, min, max, step, help, label });
const flag = (name: string, def: boolean, help?: string, label?: string): VfxParam => ({ name, type: 'bool', default: def, help, label });
const colors = (def: string[], help: string, name = 'colors', label?: string): VfxParam => ({ name, type: 'colors', default: def, help, label });

/** Where a node appears: on the attacker, on the victim or between them, pushed along the attack direction. */
const anchor = (at: 'source' | 'target' | 'middle'): VfxParam[] => [
  { name: 'at', type: 'choice', options: ['source', 'target', 'middle'], default: at, help: 'Who it appears on: the attacker (source), the victim (target) or halfway.' },
  num('forward', 0, -200, 200, 1, 'Pixels along the attack direction (negative = backwards).'),
  num('dy', 0, -200, 200, 1, 'Pixels down (negative = up).', 'offset y'),
  flag('follow', false, 'Stays on the instance while it moves; off = stays where it started.'),
];
const layer: VfxParam = { name: 'layer', type: 'choice', options: ['front', 'behind'], default: 'front', help: 'Over the instances, or behind them (above the tiles).' };
const blend: VfxParam = { name: 'blend', type: 'choice', options: ['normal', 'add'], default: 'add', help: 'add = glowing light, normal = solid paint.' };
const seconds = (def: number, name = 'duration'): VfxParam => num(name, def, 0.01, 10, 0.01, 'Seconds.');
const squash = num('squash', 1, 0.1, 1, 0.05, 'Vertical squash: 1 = round, 0.5 = flat on the ground (top-down).');

export const VFX_NODES: VfxNodeSpec[] = [
  { type: 'start', label: 'Start', group: 'Flow', help: 'Where the effect begins. Exactly one per effect, always present.', outputs: ['out'], params: [] },
  { type: 'delay', label: 'Delay', group: 'Flow', help: 'Waits, then fires what comes next.', outputs: ['out'], params: [seconds(0.1, 'seconds')] },
  { type: 'repeat', label: 'Repeat', group: 'Flow', help: 'Fires "each" several times (multi-hit, volleys), then "done".', outputs: ['each', 'done'], params: [num('count', 3, 1, 64, 1), num('interval', 0.1, 0.01, 5, 0.01, 'Seconds between repeats.')] },
  { type: 'message', label: 'Message', group: 'Flow', help: 'Tells the game something happened, exactly when the effect reaches this point: the moment to apply damage. Same as emit("name", { effect, x, y }): events (Message received), onMessage, this.on().', outputs: ['out'], params: [{ name: 'message', type: 'text', default: 'hit' }, ...anchor('target').slice(0, 3)] },

  { type: 'slash', label: 'Slash', group: 'Shapes', help: 'A blade arc sweeping across the attack direction.', outputs: ['out'], params: [
    ...anchor('source'), num('radius', 20, 2, 200, 1), num('thickness', 7, 1, 64, 1), num('arc', 170, 10, 360, 5, 'Degrees swept.'),
    { name: 'sweep', type: 'choice', options: ['clockwise', 'counter'], default: 'clockwise' }, num('rotate', 0, -180, 180, 5, 'Degrees added to the attack direction.'), seconds(0.2), squash,
    colors(['#ffffff', '#bfe9ff', '#5aa9e6'], 'Outer edge to inner edge.'), blend, layer,
  ] },
  { type: 'ring', label: 'Ring', group: 'Shapes', help: 'A circle expanding out: shockwaves, impacts, magic circles.', outputs: ['out'], params: [
    ...anchor('target'), range('radius', [2, 26], 0, 300, 1, 'Start and end radius.'), range('thickness', [5, 1], 1, 64, 1, 'Start and end thickness.'), seconds(0.3), squash,
    colors(['#ffffff', '#ffcd75', '#f77622'], 'Over its life, first to last.'), blend, layer,
  ] },
  { type: 'beam', label: 'Beam', group: 'Shapes', help: 'A line from attacker to victim: lasers, lightning (wobble > 0).', outputs: ['out'], params: [
    num('forward', 0, -200, 200, 1, 'Starts this many pixels ahead of the attacker.'), num('width', 3, 1, 32, 1), seconds(0.25), num('wobble', 0, 0, 40, 1, 'Jagged sideways jitter in pixels: 0 = straight laser.'), num('segments', 8, 2, 40, 1, 'How many zig-zags when it wobbles.'),
    colors(['#41a6f6', '#73eff7', '#ffffff'], 'Outer band to core.'), blend, layer,
  ] },
  { type: 'projectile', label: 'Projectile', group: 'Shapes', help: 'Travels from attacker to victim and homes in; what comes next fires on arrival. Draws a glowing head, or a sprite if set.', outputs: ['out'], params: [
    num('speed', 220, 10, 2000, 10, 'Pixels per second.'), num('arc', 0, -200, 200, 1, 'Height of the curve in pixels (arrows, thrown things).'), num('size', 3, 1, 32, 1, 'Head radius.'), num('forward', 8, -200, 200, 1, 'Starts this many pixels ahead of the attacker.'),
    colors(['#ffffff', '#ffcd75', '#f77622'], 'Head, center to edge.'),
    { name: 'sprite', type: 'sprite', default: '', help: 'Optional sprite instead of the glowing head; it points where it flies.' },
    num('trail', 60, 0, 400, 5, 'Trail particles per second.'), colors(['#ffcd75', '#f77622', '#5d275d'], 'Trail, over its life.', 'trailColors', 'trail colors'), num('trailLife', 0.3, 0.02, 3, 0.02, 'Seconds.', 'trail life'), blend, layer,
  ] },
  { type: 'sprite', label: 'Sprite', group: 'Shapes', help: 'Plays a hand-drawn animation from your sprites once (or more), then continues.', outputs: ['out'], params: [
    ...anchor('target'), { name: 'sprite', type: 'sprite', default: '' }, { name: 'animation', type: 'text', default: '', help: 'Tag to play; empty = all frames.' }, num('loops', 1, 1, 32, 1), num('scale', 1, 0.25, 8, 0.25),
    { name: 'align', type: 'choice', options: ['flip', 'rotate', 'none'], default: 'flip', help: 'flip = mirrored when attacking left, rotate = points at the victim.' }, num('opacity', 1, 0, 1, 0.05), layer,
  ] },

  { type: 'particles', label: 'Particles', group: 'Particles', help: 'A burst of pixel particles, or a stream if duration > 0.', outputs: ['out'], params: [
    ...anchor('target'), num('count', 16, 0, 500, 1, 'Particles in total.'), num('duration', 0, 0, 10, 0.05, '0 = all at once; otherwise emitted over this many seconds. What comes next fires when emission ends.'),
    colors(['#ffffff', '#ffcd75', '#f77622'], 'Colors.'), flag('overLife', false, 'On: each particle goes through the colors as it ages. Off: each picks one.', 'colors over life'),
    range('speed', [40, 120], 0, 2000, 5, 'Pixels per second.'), num('angle', 0, -360, 360, 5, 'Direction in degrees: 0 = right (or towards the victim with "aim"), -90 = up.'), flag('aim', false, 'The angle is relative to the attack direction.'), num('spread', 360, 0, 360, 5, 'Degrees around the direction.'),
    range('life', [0.2, 0.5], 0.02, 10, 0.02, 'Seconds.'), range('size', [1, 2], 1, 32, 1, 'Pixels.'), num('gravity', 0, -2000, 2000, 10, 'Pixels per second squared; negative rises.'), num('drag', 2, 0, 20, 0.5, 'Slowing down.'),
    flag('fade', true), flag('shrink', false), num('areaW', 0, 0, 400, 1, 'Spawn area width.', 'area w'), num('areaH', 0, 0, 400, 1, 'Spawn area height.', 'area h'), blend, layer,
  ] },

  { type: 'flash', label: 'Screen flash', group: 'Feedback', help: 'The whole screen flashes a color and fades.', outputs: ['out'], params: [{ name: 'color', type: 'color', default: '#ffffff' }, num('alpha', 0.5, 0, 1, 0.05, 'Strength at the start.'), seconds(0.12)] },
  { type: 'light', label: 'Light', group: 'Feedback', help: 'A flash of colored light on the scene, fading out. Visible in scenes with atmosphere lighting.', outputs: ['out'], params: [...anchor('target'), num('radius', 60, 4, 600, 2), { name: 'color', type: 'color', default: '#ffcd75' }, num('intensity', 1, 0, 3, 0.05), seconds(0.3)] },
  { type: 'shake', label: 'Screen shake', group: 'Feedback', help: 'Shakes the camera.', outputs: ['out'], params: [num('intensity', 2, 0, 32, 0.5, 'Pixels.'), seconds(0.15, 'seconds')] },
  { type: 'hitstop', label: 'Hit stop', group: 'Feedback', help: 'Freezes the game for an instant while effects keep playing: makes heavy hits feel heavy.', outputs: ['out'], params: [num('seconds', 0.06, 0.01, 0.5, 0.01)] },
  { type: 'blink', label: 'Blink', group: 'Feedback', help: 'An instance blinks (hit feedback).', outputs: ['out'], params: [{ name: 'who', type: 'choice', options: ['target', 'source'], default: 'target' }, num('seconds', 0.3, 0.02, 5, 0.02)] },
  { type: 'sound', label: 'Sound', group: 'Feedback', help: 'Plays a built-in sound or an audio file.', outputs: ['out'], params: [{ name: 'sound', type: 'sound', default: 'hit' }, num('volume', 0.5, 0, 1, 0.05)] },
];

export const VFX_NODE_MAP = new Map(VFX_NODES.map((n) => [n.type, n]));
export const VFX_NODE_TYPES = VFX_NODES.map((n) => n.type);

/** The value of a param, or its default. */
export function vfxParam<T extends VfxValue>(node: VfxNode, name: string): T {
  const v = node.params[name];
  if (v !== undefined) return v as T;
  return VFX_NODE_MAP.get(node.type)?.params.find((p) => p.name === name)?.default as T;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const clamp = (v: number, p: VfxParam) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));

function coerce(p: VfxParam, v: unknown): VfxValue | undefined {
  switch (p.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? clamp(n, p) : undefined;
    }
    case 'range': {
      const pair = typeof v === 'number' ? [v, v] : v;
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((x) => Number.isFinite(x))) return undefined;
      return [clamp(Number(pair[0]), p), clamp(Number(pair[1]), p)];
    }
    case 'color':
      return typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined;
    case 'colors': {
      const list = (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).filter((c): c is string => typeof c === 'string' && HEX.test(c)).map((c) => c.toLowerCase());
      return list.length ? list.slice(0, 8) : undefined;
    }
    case 'choice':
      return typeof v === 'string' && p.options?.includes(v) ? v : undefined;
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    default:
      return typeof v === 'string' ? v : undefined;
  }
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** Mistakes in hand-written nodes that normalizing would silently drop (for the MCP tools, which report them). */
export function vfxInputErrors(nodes: { id?: unknown; type?: unknown; params?: Record<string, unknown> }[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const spec = VFX_NODE_MAP.get(String(n.type));
    if (!spec) {
      out.push(`node "${n.id}": unknown type "${n.type}" (types: ${VFX_NODE_TYPES.join(', ')})`);
      continue;
    }
    for (const [k, v] of Object.entries(n.params ?? {})) {
      const p = spec.params.find((x) => x.name === k);
      if (!p) out.push(`node "${n.id}" (${n.type}): no param "${k}" (params: ${spec.params.map((x) => x.name).join(', ') || 'none'})`);
      else if (coerce(p, v) === undefined) out.push(`node "${n.id}" (${n.type}): bad value for ${k}: ${JSON.stringify(v)} (expected ${p.type}${p.options ? `: ${p.options.join(', ')}` : ''})`);
    }
  }
  return out;
}

/** Longest path from Start, used to lay nodes out in columns. Nodes off the graph get column 0. */
function columns(g: { nodes: { id: string }[]; edges: VfxEdge[] }): Map<string, number> {
  const depth = new Map<string, number>(g.nodes.map((n) => [n.id, 0]));
  // Relax at most once per node: enough for any graph without cycles, and it terminates with them.
  for (let i = 0; i < g.nodes.length; i++) {
    let moved = false;
    for (const e of g.edges) {
      const d = (depth.get(e.from) ?? 0) + 1;
      if (d > (depth.get(e.to) ?? 0)) {
        depth.set(e.to, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depth;
}

export const VFX_NODE_W = 170;
const COL_W = VFX_NODE_W + 60;
const ROW_H = 96;

/** Cleans up a graph from disk, the editor or MCP: valid params, one Start, sound wires, positions for new nodes. */
export function normalizeVfx(v: unknown, name?: string): VfxGraph {
  const raw = (v ?? {}) as Partial<VfxGraph> & { nodes?: unknown; edges?: unknown };
  const seen = new Set<string>();
  const nodes: (Omit<VfxNode, 'x' | 'y'> & { x?: number; y?: number })[] = [];
  let hasStart = false;
  for (const item of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const n = (item ?? {}) as Partial<VfxNode>;
    const spec = VFX_NODE_MAP.get(String(n.type));
    if (!spec || typeof n.id !== 'string' || !ID_RE.test(n.id) || seen.has(n.id)) continue;
    if (spec.type === 'start') {
      if (hasStart) continue;
      hasStart = true;
    }
    seen.add(n.id);
    const params: Record<string, VfxValue> = {};
    for (const p of spec.params) {
      const val = n.params?.[p.name];
      if (val === undefined) continue;
      const c = coerce(p, val);
      if (c !== undefined) params[p.name] = c;
    }
    nodes.push({ id: n.id, type: spec.type, params, ...(Number.isFinite(n.x) && Number.isFinite(n.y) ? { x: Number(n.x), y: Number(n.y) } : {}) });
  }
  if (!hasStart) {
    let id = 'start';
    while (seen.has(id)) id += '_';
    seen.add(id);
    nodes.unshift({ id, type: 'start', params: {} });
  }
  const types = new Map(nodes.map((n) => [n.id, n.type]));
  const wires = new Set<string>();
  const edges: VfxEdge[] = [];
  for (const item of Array.isArray(raw.edges) ? raw.edges : []) {
    const e = (item ?? {}) as Partial<VfxEdge>;
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) continue;
    const from = types.get(e.from);
    const to = types.get(e.to);
    if (!from || !to || to === 'start') continue;
    const outs = VFX_NODE_MAP.get(from)!.outputs;
    const port = e.port && outs.includes(e.port) ? e.port : outs[0];
    const key = `${e.from}.${port}>${e.to}`;
    if (wires.has(key)) continue;
    wires.add(key);
    edges.push({ from: e.from, ...(port !== outs[0] ? { port } : {}), to: e.to });
  }
  // Nodes without a position (written through MCP) go into columns by depth, under whatever is already there.
  const col = columns({ nodes, edges });
  const rows = new Map<number, number>();
  for (const n of nodes) {
    if (n.x === undefined) continue;
    const c = Math.round(n.x / COL_W);
    rows.set(c, Math.max(rows.get(c) ?? 0, Math.floor((n.y ?? 0) / ROW_H) + 1));
  }
  const placed: VfxNode[] = nodes.map((n) => {
    if (n.x !== undefined && n.y !== undefined) return n as VfxNode;
    const c = col.get(n.id) ?? 0;
    const r = rows.get(c) ?? 0;
    rows.set(c, r + 1);
    return { ...n, x: c * COL_W, y: r * ROW_H };
  });
  return {
    name: name ?? String(raw.name ?? 'effect'),
    ...(raw.description ? { description: String(raw.description).slice(0, 300) } : {}),
    nodes: placed,
    edges,
    ...(raw.rev ? { rev: raw.rev } : {}),
    ...(raw.updatedBy ? { updatedBy: raw.updatedBy } : {}),
  };
}

/** The port a wire leaves from. */
export function vfxEdgePort(g: VfxGraph, e: VfxEdge): string {
  if (e.port) return e.port;
  const type = g.nodes.find((n) => n.id === e.from)?.type;
  return (type && VFX_NODE_MAP.get(type)?.outputs[0]) || 'out';
}

/** Would this wire close a loop? (Loops are never valid: an effect has to end. Use Repeat instead.) */
export function vfxWouldCycle(g: Pick<VfxGraph, 'edges'>, from: string, to: string): boolean {
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of g.edges) if (e.from === id) stack.push(e.to);
  }
  return false;
}

export function vfxHasCycle(g: Pick<VfxGraph, 'edges'>): boolean {
  return g.edges.some((e, i) => vfxWouldCycle({ edges: g.edges.filter((_, j) => j !== i) }, e.from, e.to));
}

export interface VfxCheckRefs {
  /** Sprite names with their animation tags. Omit to skip the check. */
  sprites?: Map<string, string[]>;
  sounds?: string[];
}

/** Human-readable problems of a graph ("" sprite refs, loops, nodes nothing reaches). */
export function checkVfx(g: VfxGraph, refs: VfxCheckRefs = {}): string[] {
  const out: string[] = [];
  if (vfxHasCycle(g)) out.push('the wires form a loop; an effect has to end (use a Repeat node)');
  const start = g.nodes.find((n) => n.type === 'start');
  const reached = new Set<string>();
  const stack = start ? [start.id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const e of g.edges) if (e.from === id) stack.push(e.to);
  }
  for (const n of g.nodes) {
    if (!reached.has(n.id)) out.push(`node "${n.id}" (${n.type}) is not connected to Start, it never plays`);
    if (n.type === 'sprite' || n.type === 'projectile') {
      const sprite = vfxParam<string>(n, 'sprite');
      if (!sprite) {
        if (n.type === 'sprite') out.push(`node "${n.id}": no sprite chosen`);
      } else if (refs.sprites && !refs.sprites.has(sprite)) out.push(`node "${n.id}": sprite "${sprite}" not found`);
      else if (n.type === 'sprite') {
        const tag = vfxParam<string>(n, 'animation');
        if (tag && refs.sprites && !refs.sprites.get(sprite)?.includes(tag)) out.push(`node "${n.id}": sprite "${sprite}" has no animation "${tag}"`);
      }
    }
    if (n.type === 'sound' && refs.sounds && !refs.sounds.includes(vfxParam<string>(n, 'sound'))) out.push(`node "${n.id}": unknown sound "${vfxParam<string>(n, 'sound')}"`);
  }
  return out;
}

export const VFX_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

type TemplateNode = [id: string, type: string, params?: Record<string, VfxValue>];

function template(nodes: TemplateNode[], wires: string[]): Pick<VfxGraph, 'nodes' | 'edges'> {
  return {
    nodes: [['start', 'start'] as TemplateNode, ...nodes].map(([id, type, params]) => ({ id, type, params: params ?? {} })) as VfxNode[],
    edges: wires.map((w) => {
      const [left, to] = w.split('>');
      const [from, port] = left.split('.');
      return { from, to, ...(port ? { port } : {}) };
    }),
  };
}

const SPARKS = { speed: [60, 160], life: [0.15, 0.4], size: [1, 2], drag: 3 } as Record<string, VfxValue>;

/** Starting points offered by "New effect" and write_vfx. */
export const VFX_TEMPLATES: { id: string; label: string; description: string; graph: Pick<VfxGraph, 'nodes' | 'edges'> }[] = [
  {
    id: 'slash', label: 'Sword slash', description: 'Melee: a blade arc, then sparks, blink and shake on the victim as it connects.',
    graph: template([
      ['arc', 'slash', { forward: 12 }],
      ['connect', 'delay', { seconds: 0.08 }],
      ['hit', 'message', { message: 'hit' }],
      ['sparks', 'particles', { ...SPARKS, count: 14, colors: ['#ffffff', '#bfe9ff', '#5aa9e6'] }],
      ['blink', 'blink'],
      ['shake', 'shake', { intensity: 1.5, seconds: 0.12 }],
    ], ['start>arc', 'start>connect', 'connect>hit', 'connect>sparks', 'connect>blink', 'connect>shake']),
  },
  {
    id: 'impact', label: 'Heavy impact', description: 'A hit with weight: hit stop, flash, shockwave and debris.',
    graph: template([
      ['stop', 'hitstop', { seconds: 0.07 }],
      ['hit', 'message', { message: 'hit' }],
      ['flash', 'flash', { alpha: 0.4, duration: 0.1 }],
      ['wave', 'ring', { radius: [4, 34], squash: 0.6 }],
      ['debris', 'particles', { ...SPARKS, count: 26, gravity: 240 }],
      ['shake', 'shake', { intensity: 4, seconds: 0.25 }],
    ], ['start>stop', 'start>hit', 'start>flash', 'start>wave', 'start>debris', 'start>shake']),
  },
  {
    id: 'fireball', label: 'Fireball', description: 'Ranged: charges on the caster, flies with a trail, explodes on arrival.',
    graph: template([
      ['charge', 'particles', { at: 'source', forward: 8, count: 18, duration: 0.2, speed: [10, 30], colors: ['#ffcd75', '#f77622'], life: [0.15, 0.3] }],
      ['ball', 'projectile', { speed: 200, arc: 10 }],
      ['hit', 'message', { message: 'hit' }],
      ['boom', 'particles', { count: 34, speed: [30, 130], life: [0.3, 0.7], size: [1, 3], colors: ['#ffffff', '#feae34', '#f77622', '#5d275d'], overLife: true, shrink: true, drag: 3 }],
      ['wave', 'ring', { radius: [3, 30] }],
      ['glow', 'light', { radius: 90, intensity: 1.4, duration: 0.45 }],
      ['shake', 'shake', { intensity: 3, seconds: 0.25 }],
    ], ['start>charge', 'charge>ball', 'ball>hit', 'ball>boom', 'ball>wave', 'ball>glow', 'ball>shake']),
  },
  {
    id: 'lightning', label: 'Lightning', description: 'Three jagged bolts, each with a flash; damage on the last.',
    graph: template([
      ['bolts', 'repeat', { count: 3, interval: 0.11 }],
      ['bolt', 'beam', { wobble: 7, width: 2, duration: 0.09 }],
      ['flash', 'flash', { color: '#bfe9ff', alpha: 0.35, duration: 0.07 }],
      ['sparks', 'particles', { ...SPARKS, count: 8, colors: ['#ffffff', '#73eff7'] }],
      ['hit', 'message', { message: 'hit' }],
      ['shake', 'shake', { intensity: 2.5, seconds: 0.2 }],
    ], ['start>bolts', 'bolts.each>bolt', 'bolts.each>flash', 'bolts.each>sparks', 'bolts.done>hit', 'bolts.done>shake']),
  },
  {
    id: 'heal', label: 'Heal', description: 'Soft rising sparkles and a ground ring on the target.',
    graph: template([
      ['circle', 'ring', { radius: [6, 22], thickness: [2, 1], duration: 0.6, squash: 0.45, colors: ['#ffffff', '#a7f070', '#38b764'], dy: 8 }],
      ['motes', 'particles', { count: 22, duration: 0.5, speed: [5, 20], angle: -90, spread: 40, gravity: -50, drag: 0, life: [0.5, 0.9], size: [1, 1], areaW: 18, areaH: 10, colors: ['#ffffff', '#a7f070', '#38b764'], overLife: true }],
      ['glow', 'light', { radius: 50, color: '#a7f070', intensity: 0.8, duration: 0.7 }],
      ['done', 'message', { message: 'healed' }],
    ], ['start>circle', 'start>motes', 'start>glow', 'motes>done']),
  },
];

export const VFX_TEMPLATE_IDS = VFX_TEMPLATES.map((t) => t.id);

function paramLine(p: VfxParam): string {
  const def = Array.isArray(p.default) ? JSON.stringify(p.default) : JSON.stringify(p.default);
  const kind = p.type === 'choice' ? (p.options ?? []).join('|') : p.type === 'range' ? '[from, to]' : p.type === 'colors' ? '[hex, ...]' : p.type;
  const limits = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
  return `    ${p.name}: ${kind}${limits} = ${def}${p.help ? ` — ${p.help}` : ''}`;
}

export const VFX_REFERENCE = `VISUAL EFFECTS (vfx/<name>.json) — small flow graphs for attacks, spells and hits, played by the game and previewed in the VFX tab of the editor.

HOW IT FLOWS
Start fires; every node does its thing and, when it ends, fires the nodes wired after it. Several wires out of a node run in parallel; a Delay staggers them. Loops are not allowed (use Repeat).
"source" is the attacker, "target" the victim. The attack direction goes from source to target; without a target, it is where the source is facing.
Put a Message node where the attack connects and apply damage there: this.on('hit', ...) in a component, trigger "Message received" in events.

PLAYING AN EFFECT
- Scripts: await vfx('fireball', self, enemy)  (resolves when it ends). Also vfx('heal', self), vfx('boom', { x: 100, y: 50 }).
  Options: vfx('slash', self, foe, { tint: '#ff4060', scale: 1.5, speed: 1.2, angle: 90 }).  tint recolors, scale grows, speed changes the pace, angle overrides the direction.
- Events: action "Play effect" (effect, from, to).
- Animation frames: a frame event named "vfx:slash" (set_frame_events) plays it on that instance at that frame, facing where it faces.

NODES
${VFX_NODES.map((n) => `${n.type} (${n.group}) — ${n.help}${n.outputs.length > 1 ? ` Outputs: ${n.outputs.join(', ')}.` : ''}${n.params.length ? `\n${n.params.map(paramLine).join('\n')}` : ''}`).join('\n')}

EXAMPLE (write_vfx)
nodes: [{ id: "arc", type: "slash", params: { forward: 12, colors: ["#fff", "#f77622"] } }, { id: "wait", type: "delay", params: { seconds: 0.08 } }, { id: "hit", type: "message", params: { message: "hit" } }, { id: "boom", type: "ring" }]
edges: [{ from: "start", to: "arc" }, { from: "start", to: "wait" }, { from: "wait", to: "hit" }, { from: "wait", to: "boom" }]
A Start node is added if missing. Repeat has two outputs: { from: "loop", port: "each", to: "bolt" } and { from: "loop", port: "done", to: "end" }.
Start from a template when one is close (${VFX_TEMPLATE_IDS.join(', ')}), then check it with preview_vfx: a filmstrip of the effect and its timeline.`;
