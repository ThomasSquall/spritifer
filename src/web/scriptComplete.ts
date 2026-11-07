/**
 * Autocompletion for game scripts. Pure functions over the source text: no parser, just a code mask
 * (strings/comments blanked) and a few patterns that know the Spritifer API — `this.` in a component,
 * instance handles, getComponent('Name').member, string arguments (scenes, objects, sounds, components),
 * import paths and lifecycle method snippets.
 */

import {
  ARRAY_MEMBERS,
  type ApiEntry,
  BEHAVIOUR_MEMBERS,
  CAMERA_MEMBERS,
  GAME_MEMBERS,
  GLOBALS,
  HANDLE_MEMBERS,
  KEYWORDS,
  LIFECYCLE,
  MATH_MEMBERS,
  PARAM_TYPES,
  SCENE_MEMBERS,
  STRING_MEMBERS,
  UI_MEMBERS,
} from '../core/game/scriptApi.js';
import type { ComponentInfo } from '../core/game/script.js';
import type { Value } from '../core/game/types.js';

export type ItemKind = ApiEntry['kind'] | 'variable' | 'field' | 'component' | 'file' | 'snippet' | 'value';

export interface CompletionItem {
  label: string;
  kind: ItemKind;
  /** Signature or type shown next to the label. */
  detail?: string;
  doc?: string;
  /** Inserted text; `$0` marks where the caret goes. */
  insert: string;
}

export interface Completion {
  from: number;
  to: number;
  items: CompletionItem[];
}

export interface CompleteContext {
  /** This script's path ("enemies/Patrol"). */
  path: string;
  scripts: string[];
  components: ComponentInfo[];
  objects: string[];
  scenes: string[];
  sprites: string[];
  dialogues: string[];
  sounds: string[];
  keys: string[];
  variables: Record<string, Value>;
  /** Property names of object types (instance handle fields). */
  properties: string[];
}

// ---------------------------------------------------------------------------
// Code mask: same length, strings/comments/template text replaced by spaces (newlines kept).

export function maskCode(src: string): string {
  const out = src.split('');
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  const tpl: number[] = [];
  let depth = 0;
  const template = () => {
    const start = i;
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
        continue;
      }
      if (src[i] === '`') {
        blank(start, i);
        i++;
        return;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        blank(start, i);
        i += 2;
        tpl.push(depth);
        depth++;
        return;
      }
      i++;
    }
    blank(start, i);
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      blank(i, e < 0 ? n : e);
      i = e < 0 ? n : e;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      blank(i, e < 0 ? n : e + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === '"' || c === "'") {
      const s = i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      blank(s + 1, i);
      i++;
    } else if (c === '`') {
      i++;
      template();
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
        tpl.pop();
        depth--;
        i++;
        template();
      } else {
        depth = Math.max(0, depth - 1);
        i++;
      }
    } else i++;
  }
  return out.join('');
}

/** The innermost `{` still open at `pos` (in masked code), or -1. */
function openBrace(masked: string, pos: number): number {
  const stack: number[] = [];
  for (let i = 0; i < pos; i++) {
    const c = masked[i];
    if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
  }
  return stack.length ? stack[stack.length - 1] : -1;
}

const CLASS_HEAD = /class\s+([\w$]*)\s*(?:extends\s+([\w$.]+)\s*)?$/;

interface ClassScope {
  name: string;
  extendsBehaviour: boolean;
  /** Body range in the source. */
  start: number;
  end: number;
  /** The caret is directly in the class body (where methods are declared). */
  atMemberLevel: boolean;
}

function closeOf(masked: string, open: number): number {
  let d = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') d++;
    else if (masked[i] === '}' && --d === 0) return i;
  }
  return masked.length;
}

/** The class around the caret, if any. */
function classAt(masked: string, pos: number): ClassScope | null {
  let b = openBrace(masked, pos);
  const inner = b;
  while (b >= 0) {
    const m = CLASS_HEAD.exec(masked.slice(Math.max(0, b - 200), b));
    if (m) return { name: m[1] || '', extendsBehaviour: /^(Behaviour|Behavior)$/.test(m[2] ?? '') || !!m[2], start: b, end: closeOf(masked, b), atMemberLevel: inner === b };
    b = openBrace(masked, b);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types (just enough to pick members)

type T =
  | { k: 'handle' }
  | { k: 'component'; name: string }
  | { k: 'this'; cls: ClassScope }
  | { k: 'array'; of: T | null }
  | { k: 'vars' | 'scene' | 'game' | 'camera' | 'ui' | 'math' | 'json' | 'string' };

const HANDLE_NAMES = new Set(['self', 'other', 'player', 'target', 'hero', 'npc', 'enemy', 'foe']);

interface Analysis {
  src: string;
  masked: string;
  pos: number;
  cls: ClassScope | null;
  ctx: CompleteContext;
  /** name → initializer expression (last declaration before the caret). */
  symbols: Map<string, { expr?: string; type?: T | null; elementOf?: string }>;
  /** Default imports: local name → component name. */
  imports: Map<string, string>;
}

function analyze(src: string, pos: number, ctx: CompleteContext): Analysis {
  const masked = maskCode(src);
  const cls = classAt(masked, pos);
  const a: Analysis = { src, masked, pos, cls, ctx, symbols: new Map(), imports: new Map() };
  const upto = src.slice(0, pos);
  for (const m of upto.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*([^;\n]+)/g)) a.symbols.set(m[1], { expr: m[2].trim() });
  for (const m of upto.matchAll(/for\s*\(\s*(?:const|let|var)\s+([\w$]+)\s+of\s+([^)\n]+)\)/g)) a.symbols.set(m[1], { elementOf: m[2].trim() });
  for (const m of upto.matchAll(/([\w$.]+(?:\([^()\n]*\))?)\s*\.\s*(?:forEach|map|filter|find|some|every|findIndex)\(\s*\(?\s*([\w$]+)/g)) a.symbols.set(m[2], { elementOf: m[1] });
  for (const m of src.matchAll(/import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g)) {
    const base = m[2].replace(/\.js$/, '').split('/').pop() ?? '';
    if (ctx.components.some((c) => c.name === base)) a.imports.set(m[1], base);
  }
  // Hook parameters have known types.
  for (const h of LIFECYCLE) {
    const pm = /\(\s*([\w$]+)\s*:\s*(\w+)/.exec(h.ts);
    if (!pm) continue;
    const re = new RegExp(`\\b${h.name}\\s*\\(\\s*([\\w$]+)`, 'g');
    for (const m of upto.matchAll(re)) a.symbols.set(m[1], { type: pm[2] === 'Instance' ? { k: 'handle' } : pm[2] === 'Ui' ? { k: 'ui' } : null });
  }
  return a;
}

/** Cuts an initializer at the first unbalanced closing bracket or top-level comma: "x.y('a') }" → "x.y('a')". */
function cleanExpr(expr: string): string {
  let d = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'" || c === '"' || c === '`') {
      const j = expr.indexOf(c, i + 1);
      if (j < 0) break;
      i = j;
    } else if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) {
      if (d === 0) return expr.slice(0, i).trim();
      d--;
    } else if (c === ',' && d === 0) return expr.slice(0, i).trim();
  }
  return expr.trim();
}

/** Splits `a.b('x').c[0]` into segments. */
function segments(expr: string): { name: string; call?: string; index?: boolean }[] | null {
  const out: { name: string; call?: string; index?: boolean }[] = [];
  let i = 0;
  const s = expr.replace(/\?\./g, '.').trim();
  while (i < s.length) {
    const m = /^\s*([\w$]+|'[^']*'|"[^"]*")/.exec(s.slice(i));
    if (!m) return null;
    const seg: { name: string; call?: string; index?: boolean } = { name: m[1] };
    i += m[0].length;
    for (;;) {
      if (s[i] === '(' || s[i] === '[') {
        const open = s[i];
        const close = open === '(' ? ')' : ']';
        let d = 0;
        let j = i;
        for (; j < s.length; j++) {
          if (s[j] === open) d++;
          else if (s[j] === close && --d === 0) break;
        }
        if (open === '(') seg.call = s.slice(i + 1, j);
        else {
          out.push(seg);
          out.push({ name: '[]', index: true });
          i = j + 1;
          continue;
        }
        i = j + 1;
        continue;
      }
      break;
    }
    if (!out.length || out[out.length - 1] !== seg) out.push(seg);
    while (s[i] === ' ') i++;
    if (s[i] === '.') i++;
    else if (i < s.length) return null;
  }
  return out;
}

const firstArg = (call: string | undefined) => /^\s*['"]([\w$]+)['"]/.exec(call ?? '')?.[1] ?? /^\s*([\w$]+)\s*$/.exec(call ?? '')?.[1];

function typeOf(a: Analysis, expr: string, depth = 0): T | null {
  if (depth > 6) return null;
  const segs = segments(cleanExpr(expr));
  if (!segs || !segs.length) return null;
  let t: T | null = null;
  const [head, ...rest] = segs;
  const compArg = (call?: string) => {
    const x = firstArg(call);
    return x ? (a.imports.get(x) ?? x) : undefined;
  };
  if (/^['"]/.test(head.name)) t = { k: 'string' };
  else if (head.call !== undefined) {
    switch (head.name) {
      case 'findOne':
      case 'player':
      case 'spawn':
        t = { k: 'handle' };
        break;
      case 'find':
        t = { k: 'array', of: { k: 'handle' } };
        break;
      case 'findComponent': {
        const n = compArg(head.call);
        t = n ? { k: 'component', name: n } : null;
        break;
      }
      case 'findComponents': {
        const n = compArg(head.call);
        t = { k: 'array', of: n ? { k: 'component', name: n } : null };
        break;
      }
      default:
        t = null;
    }
  } else {
    switch (head.name) {
      case 'this':
        t = a.cls ? { k: 'this', cls: a.cls } : null;
        break;
      case 'vars': t = { k: 'vars' }; break;
      case 'scene': t = { k: 'scene' }; break;
      case 'game': t = { k: 'game' }; break;
      case 'camera': t = { k: 'camera' }; break;
      case 'ui': t = { k: 'ui' }; break;
      case 'Math': t = { k: 'math' }; break;
      case 'JSON': t = { k: 'json' }; break;
      default: {
        const sym = a.symbols.get(head.name);
        if (sym?.type !== undefined) t = sym.type ?? null;
        else if (sym?.expr) t = typeOf(a, sym.expr, depth + 1);
        else if (sym?.elementOf) {
          const arr = typeOf(a, sym.elementOf, depth + 1);
          t = arr?.k === 'array' ? arr.of : null;
        } else if (HANDLE_NAMES.has(head.name)) t = { k: 'handle' };
      }
    }
  }
  for (const seg of rest) {
    if (!t) return null;
    if (seg.index) {
      t = t.k === 'array' ? t.of : null;
      continue;
    }
    const m = seg.name;
    if (t.k === 'array') {
      t = m === 'find' && seg.call !== undefined ? t.of : m === 'filter' || m === 'slice' ? t : null;
      continue;
    }
    if (t.k === 'this' || t.k === 'component' || t.k === 'handle') {
      if (m === 'self' && t.k !== 'handle') {
        t = { k: 'handle' };
        continue;
      }
      if ((m === 'getComponent' || m === 'findComponent' || m === 'addComponent') && seg.call !== undefined) {
        const n = compArg(seg.call);
        t = n ? { k: 'component', name: n } : null;
        continue;
      }
      if ((m === 'getComponents' || m === 'findComponents') && seg.call !== undefined) {
        const n = compArg(seg.call);
        t = { k: 'array', of: n ? { k: 'component', name: n } : null };
        continue;
      }
      if (t.k === 'this' && seg.call === undefined) {
        // A field of this class: `this.health = this.getComponent('Health')` or `health = ...`.
        const body = a.src.slice(t.cls.start, t.cls.end);
        const assigned = new RegExp(`this\\.${m}\\s*=\\s*([^;\\n]+)`).exec(body)?.[1] ?? new RegExp(`^\\s+${m}\\s*=\\s*([^;\\n]+)`, 'm').exec(body)?.[1];
        t = assigned ? typeOf(a, assigned.trim(), depth + 1) : null;
        continue;
      }
    }
    return null;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Items

const entryItem = (e: ApiEntry, insertName = true): CompletionItem => {
  let insert = e.snippet ?? e.name;
  if (!e.snippet && (e.kind === 'function' || e.kind === 'method')) insert = /\(\s*\)/.test(e.ts) ? `${e.name}()$0` : `${e.name}($0)`;
  return { label: e.name, kind: e.kind, detail: e.ts, doc: e.doc, insert: insertName ? insert : e.name };
};

const plain = (label: string, kind: ItemKind, detail?: string, doc?: string): CompletionItem => ({ label, kind, detail, doc, insert: label });

function componentMembers(info: ComponentInfo | undefined): CompletionItem[] {
  if (!info) return [];
  return [
    ...info.params.map((p) => plain(p.name, 'field', `${p.name}: ${p.type} = ${JSON.stringify(p.default)}`, p.help ?? `Param of ${info.name} (inspector)`)),
    ...info.methods.map((m) => ({ label: m, kind: 'method' as const, detail: `${info.name}.${m}()`, doc: `Method of ${info.name}`, insert: `${m}($0)` })),
    ...info.fields.filter((f) => !f.startsWith('__')).map((f) => plain(f, 'field', `${info.name}.${f}`, 'Field')),
  ];
}

/** Fields and methods declared in a class body (for `this.`). */
function classMembers(a: Analysis, cls: ClassScope): CompletionItem[] {
  const body = a.src.slice(cls.start + 1, cls.end);
  const maskedBody = a.masked.slice(cls.start + 1, cls.end);
  const out = new Map<string, CompletionItem>();
  // Members at depth 0 of the class body.
  let d = 0;
  let lineStart = 0;
  for (let i = 0; i <= maskedBody.length; i++) {
    const c = maskedBody[i];
    if (i === maskedBody.length || c === '\n') {
      if (d === 0 || (d === 1 && /\{\s*$/.test(maskedBody.slice(lineStart, i)))) {
        const line = body.slice(lineStart, i);
        const fm = /^\s*(?:static\s+)?([\w$]+)\s*=\s*(.*)$/.exec(line);
        const mm = /^\s*(?:async\s+)?([\w$]+)\s*\(([^)]*)\)\s*\{/.exec(line);
        if (fm && !/^static\s/.test(line.trim())) out.set(fm[1], plain(fm[1], 'field', `${fm[1]} = ${fm[2].trim().slice(0, 40)}`, fm[1].startsWith('_') ? 'Private field' : 'Param (inspector)'));
        else if (mm && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(mm[1])) out.set(mm[1], { label: mm[1], kind: 'method', detail: `${mm[1]}(${mm[2]})`, doc: 'Method of this class', insert: mm[2].trim() ? `${mm[1]}($0)` : `${mm[1]}()$0` });
      }
      lineStart = i + 1;
      continue;
    }
    if (c === '{') d++;
    else if (c === '}') d--;
  }
  for (const m of body.matchAll(/this\.([\w$]+)\s*=[^=]/g)) if (!out.has(m[1])) out.set(m[1], plain(m[1], 'field', `this.${m[1]}`, 'Field set in this class'));
  return [...out.values()];
}

function membersOf(a: Analysis, t: T): CompletionItem[] {
  const c = a.ctx;
  switch (t.k) {
    case 'handle':
      return [...HANDLE_MEMBERS.map((e) => entryItem(e)), ...c.properties.map((p) => plain(p, 'field', `property ${p}`, 'Instance property (object type)'))];
    case 'this': {
      const info = c.components.find((x) => x.name === t.cls.name);
      const own = classMembers(a, t.cls);
      const names = new Set(own.map((x) => x.label));
      return [...own, ...componentMembers(info).filter((x) => !names.has(x.label)), ...(t.cls.extendsBehaviour ? BEHAVIOUR_MEMBERS.map((e) => entryItem(e)) : [])];
    }
    case 'component':
      return [...componentMembers(c.components.find((x) => x.name === t.name)), ...BEHAVIOUR_MEMBERS.map((e) => entryItem(e))];
    case 'array':
      return ARRAY_MEMBERS.map((m) => plain(m, 'method'));
    case 'string':
      return STRING_MEMBERS.map((m) => plain(m, 'method'));
    case 'vars':
      return Object.entries(c.variables).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => plain(k, 'variable', `${k} = ${JSON.stringify(v)}`, 'Global variable (Game tab)'));
    case 'scene':
      return SCENE_MEMBERS.map((e) => entryItem(e));
    case 'game':
      return GAME_MEMBERS.map((e) => entryItem(e));
    case 'camera':
      return CAMERA_MEMBERS.map((e) => entryItem(e));
    case 'ui':
      return UI_MEMBERS.map((e) => entryItem(e));
    case 'math':
      return MATH_MEMBERS.map((m) => ({ label: m, kind: 'function' as const, insert: m === 'PI' ? m : `${m}($0)` }));
    case 'json':
      return [{ label: 'stringify', kind: 'function', insert: 'stringify($0)' }, { label: 'parse', kind: 'function', insert: 'parse($0)' }];
  }
}

/** Words declared in the file (consts, functions, classes, params, imports). */
function locals(a: Analysis): CompletionItem[] {
  const out = new Map<string, CompletionItem>();
  for (const m of a.src.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)) out.set(m[1], plain(m[1], 'variable', 'declared in this file'));
  for (const m of a.src.matchAll(/import\s+([\s\S]*?)\s+from/g)) for (const n of m[1].replace(/[{}*]|\bas\b|default/g, ' ').split(/[\s,]+/).filter(Boolean)) out.set(n, plain(n, 'variable', 'imported'));
  for (const [n] of a.symbols) if (!out.has(n)) out.set(n, plain(n, 'variable'));
  return [...out.values()];
}

/** Script import paths: bare (from scripts/) and relative to this file's folder. */
function importItems(ctx: CompleteContext, prefix: string): CompletionItem[] {
  const dir = ctx.path.includes('/') ? ctx.path.slice(0, ctx.path.lastIndexOf('/')) : '';
  const rel = (p: string) => {
    const from = dir ? dir.split('/') : [];
    const to = p.split('/');
    let k = 0;
    while (k < from.length && k < to.length - 1 && from[k] === to[k]) k++;
    const up = from.length - k;
    return (up ? '../'.repeat(up) : './') + to.slice(k).join('/');
  };
  return ctx.scripts
    .filter((p) => p !== ctx.path)
    .map((p) => {
      const comp = ctx.components.find((c) => c.path === p);
      const label = prefix.startsWith('.') ? rel(p) : p;
      return { label, kind: 'file' as const, detail: comp ? `component ${comp.name}` : 'module', doc: `scripts/${p}.js`, insert: label };
    });
}

const STRING_ARGS: Record<string, (c: CompleteContext) => CompletionItem[]> = {
  component: (c) => c.components.map((x) => ({ label: x.name, kind: 'component', detail: x.path ? `scripts/${x.path}.js` : 'legacy behavior', doc: x.doc ?? `params: ${x.params.map((p) => p.name).join(', ') || 'none'}`, insert: x.name })),
  object: (c) => c.objects.map((o) => plain(o, 'value', 'object type')),
  scene: (c) => c.scenes.map((o) => plain(o, 'value', 'scene')),
  sound: (c) => c.sounds.map((o) => plain(o, 'value', 'sound')),
  dialogue: (c) => c.dialogues.map((o) => plain(o, 'value', 'dialogue')),
  sprite: (c) => c.sprites.map((o) => plain(o, 'value', 'sprite')),
  key: (c) => c.keys.map((o) => plain(o, 'value', 'key')),
  method: (c) => [...new Set(c.components.flatMap((x) => x.methods))].map((m) => plain(m, 'method', 'component method')),
  type: () => PARAM_TYPES.map((t) => plain(t, 'value', 'param type')),
};

const FN_ARG: Record<string, keyof typeof STRING_ARGS> = {
  getComponent: 'component', getComponents: 'component', addComponent: 'component', removeComponent: 'component', findComponent: 'component', findComponents: 'component',
  find: 'object', findOne: 'object', spawn: 'object', count: 'object',
  goto: 'scene', onSceneStart: 'scene',
  sound: 'sound', dialogue: 'dialogue', sprite: 'sprite', key: 'key', pressed: 'key', sendMessage: 'method',
};

// ---------------------------------------------------------------------------

function rank(items: CompletionItem[], prefix: string): CompletionItem[] {
  const p = prefix.toLowerCase();
  const seen = new Set<string>();
  const scored: [number, number, CompletionItem][] = [];
  for (const it of items) {
    if (seen.has(it.label)) continue;
    const l = it.label.toLowerCase();
    let score: number;
    if (!p) score = 3;
    else if (it.label.startsWith(prefix)) score = 0;
    else if (l.startsWith(p)) score = 1;
    else if (l.includes(p)) score = 2;
    else {
      // Fuzzy: the typed letters appear in order (onColEn → onCollisionEnter), same first letter.
      if (l[0] !== p[0]) continue;
      let k = 0;
      for (const ch of l) if (ch === p[k]) k++;
      if (k < p.length) continue;
      score = 2.5;
    }
    if (it.label === prefix) continue;
    seen.add(it.label);
    scored.push([score, scored.length, it]);
  }
  // Lists come most-relevant first (own members before inherited ones): keep that order within a score.
  return scored.sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]).slice(0, 80);
}

/** Completions at `pos`. `explicit` (Ctrl+Space) also completes an empty word. */
export function complete(src: string, pos: number, ctx: CompleteContext, explicit = false): Completion | null {
  const lineStart = src.lastIndexOf('\n', pos - 1) + 1;
  const line = src.slice(lineStart, pos);
  // Inside a block comment: nothing.
  const bc = src.lastIndexOf('/*', pos - 1);
  if (bc >= 0) {
    const close = src.indexOf('*/', bc + 2);
    if ((close < 0 || close + 2 > pos) && maskCode(src.slice(0, bc + 2))[bc] === '/') return null;
  }
  const quote = (() => {
    // An open string on this line: where it starts.
    let q = -1;
    let ch = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q >= 0) {
        if (c === '\\') i++;
        else if (c === ch) q = -1;
      } else if (c === '/' && line[i + 1] === '/') return -2;
      else if (c === '"' || c === "'" || c === '`') {
        q = i;
        ch = c;
      }
    }
    return q;
  })();
  if (quote === -2) return null;
  const after = /^[\w$./-]*/.exec(src.slice(pos))![0];
  if (quote >= 0) {
    const prefix = line.slice(quote + 1);
    const head = line.slice(0, quote);
    const from = lineStart + quote + 1;
    const to = pos + after.length;
    let items: CompletionItem[] = [];
    if (/\b(?:from|import)\s*$/.test(head)) items = importItems(ctx, prefix);
    else if (/\btype\s*:\s*$/.test(head)) items = STRING_ARGS.type(ctx);
    else {
      const call = /([\w$]+)\s*\(\s*$/.exec(head);
      const kind = call ? FN_ARG[call[1]] : undefined;
      if (kind) items = STRING_ARGS[kind](ctx);
      else if (/^\s*[\w$]+\s*:\s*$/.test(head) && /static\s+params\s*=\s*\{[^}]*$/.test(src.slice(Math.max(0, lineStart - 600), lineStart).replace(/\{[^{}]*\}/g, ''))) items = STRING_ARGS.type(ctx);
    }
    if (!items.length) return null;
    const ranked = rank(items.sort((x, y) => x.label.localeCompare(y.label)), prefix);
    return ranked.length ? { from, to, items: ranked } : null;
  }
  const word = /[\w$]*$/.exec(line)![0];
  const from = pos - word.length;
  const to = pos + /^[\w$]*/.exec(src.slice(pos))![0].length;
  const beforeWord = line.slice(0, line.length - word.length);
  if (/\d$/.test(beforeWord) && /^\d/.test(word)) return null;
  const a = analyze(src, pos, ctx);
  const dot = /(\?)?\.\s*$/.exec(beforeWord);
  if (dot) {
    const end = lineStart + beforeWord.length - dot[0].length;
    const recv = receiverBefore(src, end);
    if (!recv) return null;
    const t = typeOf(a, recv);
    if (!t) return null;
    const ranked = rank(membersOf(a, t), word);
    return ranked.length ? { from, to, items: ranked } : null;
  }
  if (!word && !explicit) return null;
  if (/\b(?:const|let|var|function|class)\s+$/.test(beforeWord)) return null;
  let items: CompletionItem[];
  if (a.cls?.atMemberLevel && /^\s*(?:async\s+)?$/.test(beforeWord)) {
    // Declaring a member of a class: lifecycle hooks and static params.
    const have = new Set(classMembers(a, a.cls).map((x) => x.label));
    items = [
      ...LIFECYCLE.filter((h) => !have.has(h.name)).map((h) => ({ label: h.name, kind: 'hook' as const, detail: h.ts, doc: h.doc, insert: h.snippet! })),
      { label: 'static params', kind: 'snippet', detail: 'static params = { ... }', doc: 'Inspector metadata for the params: types, ranges, choices, help.', insert: "static params = {\n  $0\n}" },
    ];
  } else {
    items = [
      ...locals(a),
      ...(a.cls ? [plain('this', 'keyword')] : []),
      ...GLOBALS.map((e) => entryItem(e)),
      ...KEYWORDS.map((k) => plain(k, 'keyword')),
    ];
    if (/^\s*$/.test(beforeWord) && !a.cls && !/export\s+default\s+class/.test(src)) {
      const base = ctx.path.split('/').pop() ?? 'Component';
      items.push({ label: 'component', kind: 'snippet', detail: `export default class ${base} extends Behaviour`, doc: 'Component class skeleton', insert: `export default class ${base} extends Behaviour {\n  $0\n\n  update(dt) {\n  }\n}` });
    }
  }
  const ranked = rank(items, word);
  return ranked.length ? { from, to, items: ranked } : null;
}

/** The expression right before `end` (a dot): `this.getComponent('X')`, `foo.bar[0]`, `findOne('a')`. */
function receiverBefore(src: string, end: number): string | null {
  let i = end;
  const skipWs = () => {
    while (i > 0 && /[ \t]/.test(src[i - 1])) i--;
  };
  skipWs();
  const stop = i;
  for (;;) {
    skipWs();
    const c = src[i - 1];
    if (c === ')' || c === ']') {
      const close = c;
      const open = c === ')' ? '(' : '[';
      let d = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (src[j] === close) d++;
        else if (src[j] === open && --d === 0) break;
        else if (src[j] === '\n') return null;
      }
      if (j < 0) return null;
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const j = src.lastIndexOf(c, i - 2);
      if (j < 0) return null;
      i = j;
      break;
    }
    const m = /[\w$]+$/.exec(src.slice(Math.max(0, i - 64), i));
    if (!m) break;
    i -= m[0].length;
    skipWs();
    if (src[i - 1] === '.') {
      i--;
      if (src[i - 1] === '?') i--;
      continue;
    }
    break;
  }
  const expr = src.slice(i, stop).trim();
  return expr || null;
}

/** Signature of the function call around the caret (shown under the editor). */
export function signatureAt(src: string, pos: number, ctx: CompleteContext): { ts: string; doc: string } | null {
  const masked = maskCode(src.slice(0, pos));
  let d = 0;
  for (let i = pos - 1; i >= 0 && pos - i < 400; i--) {
    const c = masked[i];
    if (c === ')' || c === '}' || c === ']') d++;
    else if ((c === '{' || c === '[') && d > 0) d--;
    else if (c === '{' || c === '[') {
      // An object/array literal argument: keep looking for the call; a block means we're not in one.
      if (c === '{' && !/[(,:=[]\s*$/.test(masked.slice(Math.max(0, i - 40), i))) return null;
    } else if (c === '(') {
      if (d === 0) {
        const m = /([\w$]+)\s*$/.exec(masked.slice(Math.max(0, i - 64), i));
        if (!m) return null;
        const name = m[1];
        const isMember = /\.\s*$/.test(masked.slice(Math.max(0, i - m[0].length - 3), i - m[0].length));
        const lists = isMember ? [HANDLE_MEMBERS, BEHAVIOUR_MEMBERS, UI_MEMBERS, GLOBALS] : [GLOBALS, BEHAVIOUR_MEMBERS];
        for (const l of lists) {
          const e = l.find((x) => x.name === name && (x.kind === 'function' || x.kind === 'method'));
          if (e) return { ts: e.ts, doc: e.doc };
        }
        for (const comp of ctx.components) if (comp.methods.includes(name)) return { ts: `${comp.name}.${name}(…)`, doc: `Method of ${comp.name}` };
        return null;
      }
      d--;
    } else if (c === ';') return null;
  }
  return null;
}
