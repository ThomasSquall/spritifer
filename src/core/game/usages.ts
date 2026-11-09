/**
 * "Find usages": where a variable, object type, sprite, scene, dialogue, component, sound, table or effect is
 * used in a project. The editor and the MCP server share this; the world map is built on top of it.
 */

import { ACTION_MAP, BEHAVIOR_MAP, CONDITION_MAP, type ComponentShape, type ParamType, type StepSpec, TRIGGER_MAP } from './catalog.js';
import type { Behavior, DataTable, EventStep, GameEvent, GameProject, Scene, Value } from './types.js';
import type { VfxGraph } from './vfxGraph.js';

export const USAGE_KINDS = ['variable', 'object', 'sprite', 'scene', 'dialogue', 'component', 'sound', 'table', 'vfx'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export interface Usage {
  /** Where the use is. A scene instance has area "instance" and both scene and instanceId. */
  area: 'game' | 'object' | 'scene' | 'instance' | 'script' | 'dialogue' | 'data' | 'vfx';
  /** The file or thing that holds it: an object type, scene, script path, dialogue file, table or effect. */
  owner: string;
  /** Human-readable place inside it. */
  where: string;
  /** read / write for variables; ref for everything else. */
  access: 'read' | 'write' | 'ref';
  /** The source text, when there is one. */
  text?: string;
  line?: number;
  scene?: string;
  instanceId?: string;
  x?: number;
  y?: number;
}

export interface ProjectSources {
  game: GameProject;
  scenes: Scene[];
  scripts: Record<string, string>;
  dialogues: Record<string, string>;
  tables: Record<string, DataTable>;
  vfx: Record<string, VfxGraph>;
  components?: ComponentShape[];
}

const PARAM_TYPES: Partial<Record<UsageKind, ParamType[]>> = {
  object: ['object', 'objectOrAny'],
  sprite: ['sprite'],
  scene: ['scene'],
  dialogue: ['dialogue'],
  component: ['scriptBehavior'],
  sound: ['sound', 'music'],
  vfx: ['vfx'],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Removes string literals, so a variable named like a word in a text is not a match. */
const withoutStrings = (src: string) => src.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
const WRITE_AFTER = /^\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--)/;

function nameIn(expr: string, name: string): boolean {
  return new RegExp(`(?<![\\w.$])${escapeRe(name)}(?![\\w$])`).test(withoutStrings(expr));
}

const quoted = (src: string, name: string) => new RegExp(`(["'\`])${escapeRe(name)}\\1`).test(src);

/** db("table", ...) in an expression, db.table / db.get('table', ...) in a script. */
function tableIn(src: string, name: string): boolean {
  const n = escapeRe(name);
  return new RegExp(`\\bdb\\(\\s*["']${n}["']|\\bdb\\.${n}\\b|\\bdb\\.(?:get|where)\\(\\s*["']${n}["']`).test(src);
}

export function findUsages(p: ProjectSources, kind: UsageKind, name: string): Usage[] {
  const out: Usage[] = [];
  const types = PARAM_TYPES[kind] ?? [];

  /** An expression, read as whatever kind we are looking for. */
  const expr = (base: Omit<Usage, 'access' | 'text'>, src: Value | undefined) => {
    if (typeof src !== 'string' || !src) return;
    if (kind === 'variable' ? nameIn(src, name) : kind === 'table' ? tableIn(src, name) : kind === 'object' && quoted(src, name)) {
      out.push({ ...base, access: kind === 'variable' ? 'read' : 'ref', text: src });
    }
  };

  const walkSteps = (base: Omit<Usage, 'access' | 'text' | 'where'>, where: string, steps: EventStep[], specs: Map<string, StepSpec>) => {
    steps.forEach((s) => {
      const spec = specs.get(s.type);
      if (!spec) return;
      const at = `${where}: ${spec.label}`;
      for (const param of spec.params) {
        const v = s[param.name];
        if (v === undefined || v === '') continue;
        if (types.includes(param.type) && v === name) out.push({ ...base, where: at, access: 'ref', text: String(v) });
        if (param.type === 'expr') expr({ ...base, where: at }, v);
        if (kind === 'variable' && param.type === 'target' && typeof v === 'string' && v === name) out.push({ ...base, where: at, access: 'write', text: v });
      }
      if (kind === 'variable' && s.type === 'save' && s.var === name) out.push({ ...base, where: at, access: 'read', text: name });
    });
  };

  const walkEvents = (base: Omit<Usage, 'access' | 'text' | 'where'>, label: string, events: GameEvent[]) => {
    events.forEach((e, i) => {
      const where = `${label} event ${i + 1}`;
      walkSteps(base, where, [e.trigger], TRIGGER_MAP);
      walkSteps(base, where, e.conditions, CONDITION_MAP);
      walkSteps(base, where, e.actions, ACTION_MAP);
    });
  };

  /** Params of a component: declared types when known, otherwise a string equal to the name. */
  const walkParams = (base: Omit<Usage, 'access' | 'text' | 'where'>, where: string, component: string, params: Record<string, Value>) => {
    if (kind === 'variable' || kind === 'table' || kind === 'component') return;
    const shape = p.components?.find((c) => c.name === component);
    for (const [k, v] of Object.entries(params)) {
      if (k === 'type' || k === 'name' || v !== name) continue;
      const declared = shape?.params.find((x) => x.name === k)?.type;
      if (!declared || declared === 'string' || declared === 'text' || declared === kind) out.push({ ...base, where: `${where} ${component}.${k}`, access: 'ref', text: String(v) });
    }
  };

  const walkComponents = (base: Omit<Usage, 'access' | 'text' | 'where'>, where: string, list: Behavior[] | undefined) => {
    for (const b of list ?? []) {
      const compName = String(b.name ?? '');
      if (kind === 'component' && compName === name) out.push({ ...base, where: `${where} component`, access: 'ref', text: name });
      walkParams(base, where, compName, b);
    }
  };

  // ---------------------------------------------------------------- game settings
  const g = p.game;
  const gameBase = { area: 'game' as const, owner: 'game' };
  if (kind === 'scene' && g.startScene === name) out.push({ ...gameBase, where: 'start scene', access: 'ref', text: name });
  if (kind === 'sprite' && g.tilesets?.[name]) out.push({ ...gameBase, where: 'tile rules', access: 'ref', text: name });
  walkComponents(gameBase, 'global', g.components);

  // ---------------------------------------------------------------- object types
  for (const o of g.objects) {
    const base = { area: 'object' as const, owner: o.name };
    if (kind === 'object' && o.extends === name) out.push({ ...base, where: 'variant of', access: 'ref', text: name });
    if (kind === 'sprite' && o.sprite === name) out.push({ ...base, where: 'sprite', access: 'ref', text: name });
    if (kind === 'sound' && o.ambientSound?.sound === name) out.push({ ...base, where: 'ambient sound', access: 'ref', text: name });
    if (o.text !== undefined) expr({ ...base, where: 'text' }, o.text);
    for (const b of o.behaviors) {
      const spec = BEHAVIOR_MAP.get(b.type);
      if (b.type === 'script') continue;
      for (const param of spec?.params ?? []) {
        if (types.includes(param.type) && b[param.name] === name) out.push({ ...base, where: `${spec!.label}.${param.name}`, access: 'ref', text: name });
      }
    }
    walkComponents(base, 'behaviors', o.behaviors.filter((b) => b.type === 'script'));
    walkEvents(base, 'sheet', o.events);
  }

  // ---------------------------------------------------------------- scenes
  for (const s of p.scenes) {
    const base = { area: 'scene' as const, owner: s.name, scene: s.name };
    if (kind === 'sprite') {
      if (s.tileset === name) out.push({ ...base, where: 'tileset', access: 'ref', text: name });
      for (const b of s.backgrounds) if (b.sprite === name) out.push({ ...base, where: 'background', access: 'ref', text: name });
      if (s.atmosphere?.clouds?.sprite === name) out.push({ ...base, where: 'cloud shadows', access: 'ref', text: name });
      if (s.atmosphere?.reflections?.sprites?.includes(name)) out.push({ ...base, where: 'water reflections', access: 'ref', text: name });
    }
    if (kind === 'sound') {
      if (s.music === name) out.push({ ...base, where: 'music', access: 'ref', text: name });
      for (const a of s.ambience ?? []) if (a.sound === name) out.push({ ...base, where: 'ambience', access: 'ref', text: name });
    }
    if (kind === 'variable' && name.startsWith('scene.') && name.slice(6) in s.variables) out.push({ ...base, where: 'scene variable', access: 'write', text: name });
    walkComponents(base, 'scene', s.components);
    walkEvents(base, 'scene', s.events);

    for (const i of s.instances) {
      const inst = { area: 'instance' as const, owner: s.name, scene: s.name, instanceId: i.id, x: i.x, y: i.y };
      const label = i.name ?? i.object;
      if (kind === 'object' && i.object === name) out.push({ ...inst, where: label, access: 'ref', text: name });
      if (kind === 'sprite' && i.sprite === name) out.push({ ...inst, where: `${label} sprite`, access: 'ref', text: name });
      if (i.activeIf) expr({ ...inst, where: `${label} active if` }, i.activeIf);
      for (const [k, v] of Object.entries(i.props ?? {})) {
        if (kind === 'dialogue' && k === 'dialogue' && v === name) out.push({ ...inst, where: `${label} dialogue`, access: 'ref', text: name });
        else if (kind !== 'variable' && kind !== 'table' && kind !== 'component' && k !== 'dialogue' && v === name) out.push({ ...inst, where: `${label} property ${k}`, access: 'ref', text: name });
      }
      for (const [comp, params] of Object.entries(i.components ?? {})) {
        if (kind === 'component' && comp === name) out.push({ ...inst, where: `${label} component`, access: 'ref', text: name });
        walkParams(inst, label, comp, params);
      }
    }
  }

  // ---------------------------------------------------------------- scripts
  const literalKinds: UsageKind[] = ['object', 'sprite', 'scene', 'dialogue', 'sound', 'vfx'];
  const varRead = new RegExp(`\\bvars(?:\\.${escapeRe(name)}\\b|\\[\\s*["']${escapeRe(name)}["']\\s*\\])`, 'g');
  const compRe = new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`);
  for (const [script, code] of Object.entries(p.scripts)) {
    code.split('\n').forEach((text, idx) => {
      const trimmed = text.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const base = { area: 'script' as const, owner: script, where: `line ${idx + 1}`, line: idx + 1, text: trimmed };
      if (kind === 'variable') {
        for (const m of text.matchAll(varRead)) {
          out.push({ ...base, access: WRITE_AFTER.test(text.slice(m.index + m[0].length)) ? 'write' : 'read' });
        }
      } else if (kind === 'table') {
        if (tableIn(text, name)) out.push({ ...base, access: 'ref' });
      } else if (kind === 'component') {
        if (compRe.test(withoutStrings(text)) || quoted(text, name)) out.push({ ...base, access: 'ref' });
      } else if (literalKinds.includes(kind) && quoted(text, name)) {
        out.push({ ...base, access: 'ref' });
      }
    });
  }

  // ---------------------------------------------------------------- dialogues
  for (const [file, code] of Object.entries(p.dialogues)) {
    code.split('\n').forEach((raw, idx) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const base = { area: 'dialogue' as const, owner: file, where: `line ${idx + 1}`, line: idx + 1, text: line };
      if (kind === 'variable') {
        const assign = /^~\s*([A-Za-z_][\w.]*)\s*(=|\+=|-=)\s*(.*)$/.exec(line);
        if (assign) {
          if (assign[1] === name) out.push({ ...base, access: 'write' });
          if (nameIn(assign[3], name)) out.push({ ...base, access: 'read' });
          return;
        }
        const pieces = [...line.matchAll(/\[if\s+([^\]]+)\]|\{([^}]+)\}/g)].map((m) => m[1] ?? m[2]);
        const cond = /^(?:if|elif)\s+(.+?):?$/.exec(line);
        if (cond) pieces.push(cond[1]);
        if (pieces.some((x) => nameIn(x, name))) out.push({ ...base, access: 'read' });
        return;
      }
      if (kind === 'table') {
        if (tableIn(line, name)) out.push({ ...base, access: 'ref' });
        return;
      }
      if (kind === 'dialogue') {
        if (new RegExp(`^(?:===\\s*|.*->\\s*)${escapeRe(name)}\\s*$`).test(line) && !line.startsWith('===')) out.push({ ...base, access: 'ref' });
        return;
      }
      const command = /^!\s*(\w+)\s+(.*)$/.exec(line);
      if (!command) return;
      const [, cmd, rest] = command;
      const first = rest.trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, '');
      const matches = first === name && ((kind === 'scene' && cmd === 'goto') || (kind === 'sound' && cmd === 'sound') || (kind === 'object' && cmd === 'spawn'));
      if (matches) out.push({ ...base, access: 'ref' });
    });
  }

  // ---------------------------------------------------------------- tables and effects
  for (const t of Object.values(p.tables)) {
    if (kind === 'table') {
      for (const c of t.columns) if (c.type === 'ref' && c.table === name) out.push({ area: 'data', owner: t.name, where: `column ${c.name}`, access: 'ref', text: name });
      continue;
    }
    if (kind === 'variable' || kind === 'component') continue;
    for (const r of t.rows) {
      for (const [col, v] of Object.entries(r)) {
        if (col !== 'id' && v === name) out.push({ area: 'data', owner: t.name, where: `row ${r.id}.${col}`, access: 'ref', text: name });
      }
    }
  }
  if (kind === 'sprite' || kind === 'sound') {
    for (const g2 of Object.values(p.vfx)) {
      for (const n of g2.nodes) {
        for (const [k, v] of Object.entries(n.params ?? {})) {
          if (v === name) out.push({ area: 'vfx', owner: g2.name, where: `node ${n.id}.${k}`, access: 'ref', text: name });
        }
      }
    }
  }
  return out;
}

/** Plain-text report for MCP: counts per place, the first lines of each. */
export function formatUsages(kind: UsageKind, name: string, usages: Usage[], perOwner = 12): string {
  if (!usages.length) return `No usages of ${kind} "${name}".`;
  const groups = new Map<string, Usage[]>();
  for (const u of usages) {
    const key = `${u.area === 'instance' ? 'scene' : u.area} ${u.owner}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const writes = usages.filter((u) => u.access === 'write').length;
  const reads = usages.filter((u) => u.access === 'read').length;
  const lines = [`${usages.length} usage(s) of ${kind} "${name}" in ${groups.size} place(s)${kind === 'variable' ? ` (${reads} read, ${writes} write)` : ''}:`];
  for (const [key, list] of groups) {
    lines.push(`${key} (${list.length})`);
    for (const u of list.slice(0, perOwner)) {
      lines.push(`  ${u.access === 'ref' ? '' : `[${u.access}] `}${u.where}${u.instanceId ? ` #${u.instanceId}` : ''}${u.text && u.text !== name ? `: ${u.text.slice(0, 140)}` : ''}`);
    }
    if (list.length > perOwner) lines.push(`  ... ${list.length - perOwner} more`);
  }
  return lines.join('\n');
}
