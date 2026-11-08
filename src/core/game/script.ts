/**
 * Game scripts: JavaScript files in the project's scripts/ folder (subfolders allowed). Each file is a module.
 *
 * Components (Unity-style behaviours) are one class per file, named like the file:
 *
 *   // scripts/enemies/Patrol.js
 *   export default class Patrol extends Behaviour {
 *     speed = 40                    // public fields = parameters editable in the inspector
 *     update(dt) { this.self.x += this.speed * dt }
 *     onCollisionEnter(other) { other.getComponent('Health')?.damage(1) }
 *   }
 *
 * Plain scripts export helpers/data and may register global hooks (onDraw, func...). See SCRIPT_REFERENCE.
 */

import type { Actor, Renderer, World } from './engine.js';
import { CELL_H, CELL_W, measureText } from './font.js';
import { resolveImport, scriptBaseName, transformModule } from './modules.js';
import { BEHAVIOUR_RESERVED, type ComponentParamType, LIFECYCLE_NAMES, PARAM_TYPES } from './scriptApi.js';
import type { Value } from './types.js';

type Fn = (...args: never[]) => unknown;

/** Hooks of the legacy behavior(name, { ... }) registration (kept working; new code uses component classes). */
export interface BehaviorHooks {
  create?: (self: Handle, params: Record<string, Value>) => unknown;
  update?: (self: Handle, dt: number, params: Record<string, Value>) => unknown;
  collide?: (self: Handle, other: Handle) => unknown;
  interact?: (self: Handle, player: Handle) => unknown;
  destroy?: (self: Handle) => unknown;
}

/** Script view of an instance: fields (x, y, vx...) plus its properties (self.hp) and methods. */
export type Handle = Record<string, unknown> & { readonly __actor: Actor };

/**
 * Turns source code + API into registrations. The server swaps in a node:vm based evaluator.
 * `lineOffset`: lines the evaluator's wrapper adds before the code (to report file:line in errors).
 */
export type ScriptEvaluator = ((code: string, api: Record<string, unknown>, filename: string) => void) & { lineOffset?: number };

export const defaultEvaluator: ScriptEvaluator = Object.assign(
  (code: string, api: Record<string, unknown>, filename: string) => {
    const names = Object.keys(api);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=${filename}`) as (...a: unknown[]) => void;
    fn(...names.map((n) => api[n]));
  },
  // V8 puts "function anonymous(...\n) {\n" before the body, and the body starts with "use strict".
  { lineOffset: 3 },
);

/** Errors thrown inside node:vm come from another realm: `instanceof Error` is false for them. */
const isErrorLike = (err: unknown): err is { message: string; stack?: string } => !!err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string';

export function errorMessage(err: unknown): string {
  return isErrorLike(err) ? err.message : String(err);
}

/** "scripts/enemies/Patrol.js:12" from an error's stack (first frame inside a game script). */
export function scriptLocation(err: unknown, lineOffset = 0): { file: string; line: number } | null {
  const stack = isErrorLike(err) ? String(err.stack ?? '') : '';
  const m = /scripts\/([\w/-]+)\.js:(\d+)/.exec(stack);
  if (!m) return null;
  return { file: m[1], line: Math.max(1, Number(m[2]) - lineOffset) };
}

const EASINGS: Record<string, (t: number) => number> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outElastic: (t) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};
export const EASING_NAMES = Object.keys(EASINGS);

interface Tween {
  target: Record<string, unknown>;
  to: Record<string, number>;
  from: Record<string, number> | null;
  start: number;
  dur: number;
  ease: (t: number) => number;
  resolve: () => void;
  owner: ComponentState | null;
  persistent: boolean;
}

interface Listener {
  name: string;
  fn: (data: unknown, name: string) => unknown;
  /** Component that registered it (removed with it), or null (plain script / module level). */
  owner: ComponentState | null;
}

// ---------------------------------------------------------------------------
// Components

export type ComponentScope = 'object' | 'scene' | 'game';

/** A parameter of a component, shown in the inspector. */
export interface ComponentParam {
  name: string;
  type: ComponentParamType;
  default: Value;
  label?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
}

/** What the editor knows about a component class. */
export interface ComponentInfo {
  name: string;
  /** Script path without .js ("enemies/Patrol"); "" for legacy behavior() registrations. */
  path: string;
  params: ComponentParam[];
  /** Lifecycle methods it implements. */
  hooks: string[];
  /** Other methods (callable with getComponent(...).method() or the "Call component method" action). */
  methods: string[];
  /** Fields that are not parameters (private state, objects). */
  fields: string[];
  doc?: string;
  legacy?: boolean;
  /** Legacy behavior() registrations: the script that defines it. */
  definedIn?: string;
  warnings: string[];
}

export interface ComponentDef extends ComponentInfo {
  cls: typeof Behaviour;
}

const STATE = Symbol('spritifer.component');

interface ComponentState {
  host: ScriptHost;
  def: ComponentDef;
  actor: Actor | null;
  scope: ComponentScope;
  enabled: boolean;
  awoken: boolean;
  started: boolean;
  destroyed: boolean;
  /** Legacy components get their raw params. */
  config: Record<string, Value>;
}

let pending: { state: ComponentState | null; params: Record<string, Value> } | null = null;

const define = (o: object, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
const isValue = (v: unknown): v is Value => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
const stateOf = (c: Behaviour): ComponentState | null => (c as unknown as { [STATE]: ComponentState | null })[STATE] ?? null;

/** Base class of components. Scripts extend it: `export default class Patrol extends Behaviour {}`. */
export class Behaviour {
  /** Optional inspector metadata for the params (types, ranges, choices, help). */
  static params?: Record<string, unknown>;

  constructor() {
    const p = pending;
    pending = null;
    Object.defineProperty(this, STATE, { value: p?.state ?? null, enumerable: false, writable: true });
    // Params first, so field initializers can use them (hp = this.maxHp).
    if (p) for (const [k, v] of Object.entries(p.params)) define(this, k, v);
  }

  get self(): Handle | null {
    const s = stateOf(this);
    return s?.actor ? s.host.handle(s.actor) : null;
  }

  get enabled(): boolean {
    return stateOf(this)?.enabled ?? false;
  }

  set enabled(on: boolean) {
    stateOf(this)?.host.setEnabled(this, !!on);
  }

  get componentName(): string {
    return stateOf(this)?.def.name ?? '';
  }

  getComponent(type: unknown): Behaviour | null {
    return stateOf(this)?.host.siblings(this, type)[0] ?? null;
  }

  getComponents(type?: unknown): Behaviour[] {
    return stateOf(this)?.host.siblings(this, type) ?? [];
  }

  addComponent(type: unknown, params: Record<string, Value> = {}): Behaviour | null {
    const s = stateOf(this);
    return s ? s.host.add(s.scope, s.actor, type, params) : null;
  }

  removeComponent(type: unknown): void {
    const s = stateOf(this);
    if (!s) return;
    const target = type instanceof Behaviour ? type : s.host.siblings(this, type)[0];
    if (target) s.host.remove(target);
  }

  findComponent(type: unknown): Behaviour | null {
    return stateOf(this)?.host.findAll(type)[0] ?? null;
  }

  findComponents(type: unknown): Behaviour[] {
    return stateOf(this)?.host.findAll(type) ?? [];
  }

  sendMessage(name: string, ...args: unknown[]): void {
    const s = stateOf(this);
    if (s) s.host.sendMessage(s.actor, s.scope, String(name), args);
  }

  wait(seconds: number): Promise<void> {
    const s = stateOf(this);
    return new Promise<void>((resolve) => {
      if (!s) return resolve();
      s.host.waitFor(Number(seconds) || 0, () => {
        if (!s.destroyed) resolve();
      }, s.scope === 'game');
    });
  }

  waitUntil(test: () => boolean): Promise<void> {
    const s = stateOf(this);
    return new Promise<void>((resolve) => {
      if (!s) return resolve();
      s.host.waitCondition(() => s.destroyed || test(), () => {
        if (!s.destroyed) resolve();
      }, s.scope === 'game');
    });
  }

  every(seconds: number, fn: () => void): () => void {
    const s = stateOf(this);
    let stopped = false;
    const loop = async () => {
      while (!stopped && s && !s.destroyed) {
        await this.wait(seconds);
        if (!stopped && s.enabled && !s.destroyed) s.host.run(`${s.def.name}.every`, fn);
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }

  destroy(): void {
    const s = stateOf(this);
    if (!s) return;
    if (s.actor) s.host.world.destroy(s.actor);
    else s.host.remove(this);
  }

  /** Listens to emit(name, data) while this component lives. Returns a function that stops listening. */
  on(name: string, fn: (data: unknown, name: string) => unknown): () => void {
    const s = stateOf(this);
    return s ? s.host.listen(String(name), fn.bind(this), s) : () => {};
  }

  emit(name: string, data?: unknown): void {
    stateOf(this)?.host.world.emit(String(name), data);
  }

  /** Animates numeric fields of `target` (an instance, a component, camera...) over `seconds`. */
  tween(target: object, props: Record<string, number>, seconds: number, ease: string | ((t: number) => number) | { ease?: string | ((t: number) => number); delay?: number } = 'outQuad'): Promise<void> {
    const s = stateOf(this);
    return s ? s.host.tween(target, props, seconds, ease, s) : Promise.resolve();
  }

  log(...args: unknown[]): void {
    const s = stateOf(this);
    s?.host.world.log(`${s.def.name}: ${args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`);
  }

  toJSON(): unknown {
    return { component: this.componentName, ...fieldsOf(this) };
  }
}

/** Own enumerable plain-value fields (params and simple state), e.g. for persistent scenes. */
export function fieldsOf(c: Behaviour): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(c)) if (isValue(v)) out[k] = v;
  return out;
}

export function componentState(c: Behaviour): { name: string; scope: ComponentScope; enabled: boolean; actor: Actor | null } | null {
  const s = stateOf(c);
  return s ? { name: s.def.name, scope: s.scope, enabled: s.enabled, actor: s.actor } : null;
}

const TYPE_ALIASES: Record<string, ComponentParamType> = { string: 'text', boolean: 'bool', int: 'number', float: 'number', enum: 'choice', select: 'choice', object: 'object', instance: 'object' };

function normalizeType(t: string): ComponentParamType | null {
  const x = TYPE_ALIASES[t] ?? t;
  return (PARAM_TYPES as readonly string[]).includes(x) ? (x as ComponentParamType) : null;
}

function inferType(v: Value | undefined): ComponentParamType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) return 'color';
  return 'text';
}

/** Coerces a configured value to a param's type (falls back to the default). */
export function coerceParam(p: ComponentParam, v: unknown): Value {
  switch (p.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      return Number.isFinite(n) ? n : p.default;
    }
    case 'bool':
      return v === true || v === 'true' ? true : v === false || v === 'false' ? false : p.default;
    default:
      return isValue(v) ? String(v) : p.default;
  }
}

function paramFrom(name: string, fieldDefault: Value | undefined, spec: unknown, warnings: string[]): ComponentParam {
  let type: ComponentParamType | null = null;
  let def: Value | undefined = fieldDefault;
  const p: Partial<ComponentParam> = {};
  if (typeof spec === 'string') {
    type = normalizeType(spec);
    if (!type) warnings.push(`param ${name}: unknown type "${spec}" (use ${PARAM_TYPES.join(', ')})`);
  } else if (Array.isArray(spec)) {
    type = 'choice';
    p.options = spec.map(String);
  } else if (spec && typeof spec === 'object') {
    const o = spec as Record<string, unknown>;
    if (typeof o.type === 'string') {
      type = normalizeType(o.type);
      if (!type) warnings.push(`param ${name}: unknown type "${o.type}"`);
    }
    if (isValue(o.default)) def = o.default;
    if (typeof o.label === 'string') p.label = o.label;
    if (typeof o.help === 'string') p.help = o.help;
    for (const k of ['min', 'max', 'step'] as const) if (typeof o[k] === 'number') p[k] = o[k] as number;
    if (Array.isArray(o.options)) {
      p.options = o.options.map(String);
      type ??= 'choice';
    }
  } else if (isValue(spec)) def = spec;
  type ??= inferType(def);
  if (def === undefined) def = type === 'number' ? 0 : type === 'bool' ? false : type === 'choice' ? (p.options?.[0] ?? '') : type === 'color' ? '#ffffff' : '';
  const out: ComponentParam = { name, type, default: def, ...p };
  out.default = coerceParam(out, def);
  return out;
}

function jsdocBefore(src: string): string | undefined {
  const m = /\/\*\*([\s\S]*?)\*\/\s*export\s+default\s+class\b/.exec(src);
  if (!m) return undefined;
  const text = m[1].split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n').trim();
  return text || undefined;
}

export interface DialogState {
  speaker: string;
  text: string;
  shown: number;
  choices: string[] | null;
  selected: number;
  portrait: string | null;
  openedAt: number;
  resolve: (choice: number) => void;
}

interface Timer {
  at: number;
  resolve: () => void;
  /** Survives scene changes (global components). */
  persistent?: boolean;
}

interface Mover {
  actor: Actor;
  x: number;
  y: number;
  speed: number;
  stuck: number;
  resolve: () => void;
}

export interface UiApi {
  width: number;
  height: number;
  text(text: string, x: number, y: number, opts?: { color?: string; size?: number; align?: 'left' | 'center' | 'right'; shadow?: boolean }): void;
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
  panel(x: number, y: number, w: number, h: number, opts?: { color?: string; border?: string; alpha?: number }): void;
  bar(x: number, y: number, w: number, h: number, value: number, max: number, color?: string, back?: string): void;
  sprite(name: string, x: number, y: number, opts?: { frame?: number; animation?: string; flipX?: boolean; opacity?: number; scale?: number }): void;
  measure(text: string, size?: number): { width: number; height: number };
  /** Converts world coordinates (instance x/y) to screen coordinates. */
  toScreen(x: number, y: number): { x: number; y: number };
  /** Screen shake right now, in screen pixels: add it to what you draw so hand-drawn scenes shake with the camera. */
  shake: { x: number; y: number };
  /**
   * Draws the visual effects playing now at this point of your drawing, for screens drawn entirely here (battle
   * screens, minigames) that would otherwise cover them. Call it once per layer: 'behind' after your background,
   * 'front' (default) after your characters, 'screen' (flashes) last. The game then stops drawing them on its own.
   */
  effects(layer?: 'behind' | 'front' | 'screen'): void;
  // Widgets (input since the last draw: no double presses).
  /** Key pressed since the last draw; consume = true hides it from the widgets drawn after. */
  pressed(key: string, consume?: boolean): boolean;
  mouse: { x: number; y: number; clicked: boolean; inside(x: number, y: number, w: number, h: number): boolean };
  button(label: string, x: number, y: number, opts?: ButtonOptions): boolean;
  menu(id: string, items: (string | MenuItem)[], x: number, y: number, opts?: MenuOptions): number | null;
  menuIndex(id: string, set?: number): number;
  window(x: number, y: number, w: number, h: number, title?: string, opts?: { color?: string; border?: string; alpha?: number }): void;
}

export interface ButtonOptions {
  w?: number;
  h?: number;
  color?: string;
  textColor?: string;
  /** A key that also presses it ("enter", "x"). */
  key?: string;
  disabled?: boolean;
}

export interface MenuItem {
  label: string;
  /** Text aligned to the right (prices, quantities). */
  right?: string;
  disabled?: boolean;
}

export interface MenuOptions {
  w?: number;
  /** Row height in px (default 9). */
  rowHeight?: number;
  title?: string;
  /** Escape / action2 return -1. */
  cancel?: boolean;
  /** Draw a panel behind (default true). */
  panel?: boolean;
  /** Keyboard input on (default true): turn off for menus that only react to the mouse. */
  keys?: boolean;
  color?: string;
  selectedColor?: string;
}

/** Wraps lines to `maxCols` characters (the pixel font is monospaced). */
export function wrapText(text: string, maxCols: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxCols) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > maxCols) {
        out.push(line.slice(0, maxCols));
        line = line.slice(maxCols);
      }
    }
    out.push(line);
  }
  return out;
}

export class ScriptHost {
  /** Component classes by name (file name), including legacy behavior() registrations. */
  readonly components = new Map<string, ComponentDef>();
  /** Module exports by script path. */
  readonly modules = new Map<string, Record<string, unknown>>();
  readonly functions = new Map<string, Fn>();
  readonly startHooks: Fn[] = [];
  readonly sceneHooks: { scene: string | null; fn: Fn }[] = [];
  readonly updateHooks: Fn[] = [];
  readonly drawHooks: Fn[] = [];
  /** ui.effects() was called in the last draw: the UI code places the effects, the renderer leaves them alone. */
  effectsInUi = false;
  readonly messageHooks = new Map<string, Fn[]>();
  readonly errors: string[] = [];
  dialog: DialogState | null = null;
  private dialogQueue: Omit<DialogState, 'openedAt'>[] = [];
  private timers: Timer[] = [];
  private conditions: { test: () => boolean; resolve: () => void; persistent: boolean }[] = [];
  movers: Mover[] = [];
  private handles = new WeakMap<Actor, Handle>();
  private current = '';
  private reported = new Set<string>();
  /** Awoken components waiting for their start() (Unity calls Start before the first Update). */
  private unstarted: Behaviour[] = [];
  private listeners: Listener[] = [];
  private tweens: Tween[] = [];
  private evaluator: ScriptEvaluator = defaultEvaluator;

  constructor(readonly world: World) {}

  /** Names of the components (for validation and dropdowns). */
  get behaviors(): Map<string, ComponentDef> {
    return this.components;
  }

  // ------------------------------------------------------------------ loading

  /** Evaluates every script as a module (imports first), then registers the component classes. */
  load(scripts: Record<string, string>, evaluate: ScriptEvaluator = defaultEvaluator): void {
    this.evaluator = evaluate;
    const api = this.api();
    const failed = new Set<string>();
    const req = (name: string, from: string): Record<string, unknown> => {
      if (!(name in scripts)) throw new Error(`Cannot find script "${name}"${from ? ` (imported from ${from})` : ''}`);
      if (failed.has(name)) throw new Error(`import "${name}" failed`);
      const known = this.modules.get(name);
      if (known) return known; // cycles get the partial exports, like CommonJS
      const exports: Record<string, unknown> = {};
      this.modules.set(name, exports);
      const prev = this.current;
      this.current = name;
      try {
        const t = transformModule(scripts[name]);
        evaluate(t.code, {
          ...api,
          __exports: exports,
          __import: (spec: string) => req(resolveImport(name, String(spec)), name),
          __exportAll: (m: Record<string, unknown>) => {
            for (const k of Object.keys(m)) if (k !== 'default') Object.defineProperty(exports, k, { enumerable: true, configurable: true, get: () => m[k] });
          },
        }, `scripts/${name}.js`);
      } catch (err) {
        failed.add(name);
        const loc = scriptLocation(err, evaluate.lineOffset ?? 0);
        const msg = `script ${name}: ${errorMessage(err)}${loc ? ` (at scripts/${loc.file}.js:${loc.line})` : ''}`;
        this.errors.push(msg);
        this.world.log(`ERROR ${msg}`);
        if (from) throw new Error(`import "${name}" failed`);
      } finally {
        this.current = prev;
      }
      return exports;
    };
    for (const name of Object.keys(scripts).sort()) {
      try {
        req(name, '');
      } catch {
        // Reported where it happened.
      }
    }
    // Component classes: the default export of a file, extending Behaviour, named after the file.
    for (const name of Object.keys(scripts).sort()) {
      const cls = this.modules.get(name)?.default;
      if (typeof cls !== 'function') continue;
      if (!(cls.prototype instanceof Behaviour)) {
        if (/^\s*class\b/.test(Function.prototype.toString.call(cls))) {
          const msg = `script ${name}: the default export is a class that doesn't extend Behaviour (export default class ${scriptBaseName(name)} extends Behaviour)`;
          this.errors.push(msg);
          this.world.log(`WARN ${msg}`);
        }
        continue;
      }
      const base = scriptBaseName(name);
      const dup = this.components.get(base);
      if (dup) {
        const msg = `script ${name}: component name "${base}" is already used by ${dup.path ? `scripts/${dup.path}.js` : 'a behavior() registration'}; rename one of the files`;
        this.errors.push(msg);
        this.world.log(`ERROR ${msg}`);
        continue;
      }
      this.components.set(base, this.describe(base, name, cls as typeof Behaviour, jsdocBefore(scripts[name])));
    }
    this.current = '';
  }

  /** Reads a component class: params from public fields (+ static params), lifecycle hooks, methods. */
  private describe(name: string, path: string, cls: typeof Behaviour, doc?: string, legacy = false): ComponentDef {
    const warnings: string[] = [];
    let probe: Record<string, unknown> = {};
    const def: ComponentDef = { name, path, cls, params: [], hooks: [], methods: [], fields: [], warnings, ...(doc ? { doc } : {}), ...(legacy ? { legacy } : {}) };
    if (!legacy) {
      try {
        pending = { state: { host: this, def, actor: null, scope: 'object', enabled: false, awoken: false, started: false, destroyed: true, config: {} }, params: {} };
        probe = new cls() as unknown as Record<string, unknown>;
      } catch (err) {
        warnings.push(`fields could not be read (a field initializer threw: ${errorMessage(err)}); move that code to awake()`);
      } finally {
        pending = null;
      }
    }
    const statics = (cls.params && typeof cls.params === 'object' ? cls.params : {}) as Record<string, unknown>;
    const seen = new Set<string>();
    for (const [k, v] of Object.entries(probe)) {
      if (k.startsWith('_') || !isValue(v)) {
        def.fields.push(k);
        continue;
      }
      if (BEHAVIOUR_RESERVED.has(k)) {
        warnings.push(`"${k}" is a Behaviour member and can't be a param; rename the field`);
        continue;
      }
      seen.add(k);
      def.params.push(paramFrom(k, v, statics[k], warnings));
    }
    for (const [k, spec] of Object.entries(statics)) {
      if (seen.has(k)) continue;
      if (BEHAVIOUR_RESERVED.has(k)) {
        warnings.push(`"${k}" is a Behaviour member and can't be a param`);
        continue;
      }
      def.params.push(paramFrom(k, undefined, spec, warnings));
    }
    for (let proto = cls.prototype; proto && proto !== Behaviour.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k === 'constructor' || def.hooks.includes(k) || def.methods.includes(k)) continue;
        const d = Object.getOwnPropertyDescriptor(proto, k);
        if (typeof d?.value !== 'function') continue;
        (LIFECYCLE_NAMES.has(k) ? def.hooks : def.methods).push(k);
      }
    }
    return def;
  }

  /** The info the editor needs about every component. */
  componentInfo(): ComponentInfo[] {
    return [...this.components.values()].map(({ cls: _c, ...info }) => info).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------------ component lifecycle

  private resolveName(type: unknown): string | null {
    if (typeof type === 'string') return type;
    if (typeof type === 'function') {
      for (const d of this.components.values()) if (d.cls === type) return d.name;
      return (type as { name?: string }).name ?? null;
    }
    return null;
  }

  private matches(c: Behaviour, type: unknown): boolean {
    if (type === undefined || type === null || type === '') return true;
    if (typeof type === 'function') return c instanceof (type as typeof Behaviour);
    return stateOf(c)?.def.name === type;
  }

  /** The list a component lives in. */
  private container(s: ComponentState): Behaviour[] {
    if (s.actor) return s.actor.components;
    return s.scope === 'game' ? this.world.gameComponents : this.world.sceneComponents;
  }

  /** Every live component: game, scene, then instances. */
  all(): Behaviour[] {
    const out = [...this.world.gameComponents, ...this.world.sceneComponents];
    for (const a of this.world.actors) if (!a.destroyed) out.push(...a.components);
    return out;
  }

  siblings(c: Behaviour, type?: unknown): Behaviour[] {
    const s = stateOf(c);
    if (!s) return [];
    return this.container(s).filter((x) => !stateOf(x)?.destroyed && this.matches(x, type));
  }

  componentsOf(a: Actor, type?: unknown): Behaviour[] {
    return a.components.filter((x) => !stateOf(x)?.destroyed && this.matches(x, type));
  }

  findAll(type: unknown): Behaviour[] {
    return this.all().filter((c) => !stateOf(c)?.destroyed && this.matches(c, type));
  }

  /** Creates a component (constructor + params). Call awaken() afterwards. */
  instantiate(type: unknown, scope: ComponentScope, actor: Actor | null, config: Record<string, Value>, restore?: Record<string, Value>): Behaviour | null {
    const name = this.resolveName(type);
    const def = name ? this.components.get(name) : undefined;
    if (!def) {
      this.report(actor ? `object ${actor.type.name}` : `${scope} components`, new Error(`no component "${name ?? String(type)}" (create scripts/${name ?? 'Name'}.js with export default class ${name ?? 'Name'} extends Behaviour)`));
      return null;
    }
    const state: ComponentState = { host: this, def, actor, scope, enabled: config.enabled !== false, awoken: false, started: false, destroyed: false, config };
    const params: Record<string, Value> = {};
    for (const p of def.params) if (p.name in config) params[p.name] = coerceParam(p, config[p.name]);
    // Params declared only in static params have no field initializer: give them their default.
    const configured = { ...params };
    pending = { state, params: Object.fromEntries(def.params.map((p) => [p.name, p.name in params ? params[p.name] : p.default])) };
    let c: Behaviour;
    try {
      c = new def.cls();
    } catch (err) {
      this.report(`${def.name} constructor`, err);
      return null;
    } finally {
      pending = null;
    }
    if (!stateOf(c)) Object.defineProperty(c, STATE, { value: state, enumerable: false, writable: true });
    // Field initializers ran after the base constructor: put the configured values back.
    for (const [k, v] of Object.entries(configured)) define(c, k, v);
    for (const p of def.params) if (!(p.name in c)) define(c, p.name, p.default);
    if (restore) for (const [k, v] of Object.entries(restore)) define(c, k, v);
    if (def.legacy) define(c, '__params', config);
    return c;
  }

  /** awake() + onEnable(); start() runs before the next update. */
  awaken(c: Behaviour): void {
    const s = stateOf(c);
    if (!s || s.awoken || s.destroyed) return;
    s.awoken = true;
    this.call(c, 'awake');
    if (s.enabled && !s.destroyed) this.call(c, 'onEnable');
    this.unstarted.push(c);
  }

  /** Runs start() of components awoken since the last call (enabled ones; disabled ones wait). */
  runStarts(): void {
    if (!this.unstarted.length) return;
    const list = this.unstarted;
    this.unstarted = [];
    for (const c of list) {
      const s = stateOf(c)!;
      if (s.destroyed) continue;
      if (!s.enabled) {
        this.unstarted.push(c);
        continue;
      }
      s.started = true;
      this.call(c, 'start');
    }
  }

  /** Calls a lifecycle method if the component is alive, enabled and implements it. */
  invoke(c: Behaviour, method: string, ...args: unknown[]): unknown {
    const s = stateOf(c);
    if (!s || s.destroyed || !s.enabled || !s.started) return undefined;
    return this.call(c, method, ...args);
  }

  /** Same, for every component of a list. */
  invokeAll(list: readonly Behaviour[], method: string, ...args: unknown[]): void {
    for (const c of [...list]) if (typeof (c as unknown as Record<string, unknown>)[method] === 'function') this.invoke(c, method, ...args);
  }

  has(c: Behaviour, method: string): boolean {
    const s = stateOf(c);
    return !!s && !s.destroyed && s.enabled && typeof (c as unknown as Record<string, unknown>)[method] === 'function';
  }

  private call(c: Behaviour, method: string, ...args: unknown[]): unknown {
    const f = (c as unknown as Record<string, unknown>)[method];
    if (typeof f !== 'function') return undefined;
    return this.run(`${stateOf(c)?.def.name ?? '?'}.${method}`, (f as Fn).bind(c), ...args);
  }

  setEnabled(c: Behaviour, on: boolean): void {
    const s = stateOf(c);
    if (!s || s.destroyed || s.enabled === on) return;
    s.enabled = on;
    if (!s.awoken) return;
    this.call(c, on ? 'onEnable' : 'onDisable');
    if (on && !s.started && !this.unstarted.includes(c)) this.unstarted.push(c);
  }

  /** onDisable + onDestroy, then removes it from its list. `silent` skips the calls (scene unload). */
  remove(c: Behaviour, silent = false): void {
    const s = stateOf(c);
    if (!s || s.destroyed) return;
    if (!silent && s.awoken) {
      if (s.enabled) this.call(c, 'onDisable');
      this.call(c, 'onDestroy');
    }
    s.destroyed = true;
    this.forget(s);
    const list = this.container(s);
    const i = list.indexOf(c);
    if (i >= 0) list.splice(i, 1);
    if (s.actor) {
      for (const [b, x] of s.actor.componentFor) if (x === c) s.actor.componentFor.delete(b);
    }
  }

  /** Marks components gone without calling them (their pending waits stop). */
  drop(list: readonly Behaviour[]): void {
    for (const c of list) {
      const s = stateOf(c);
      if (s) {
        s.destroyed = true;
        this.forget(s);
      }
    }
  }

  /** Removes a destroyed component's listeners and tweens. */
  private forget(s: ComponentState): void {
    if (this.listeners.some((l) => l.owner === s)) this.listeners = this.listeners.filter((l) => l.owner !== s);
    if (this.tweens.some((t) => t.owner === s)) this.tweens = this.tweens.filter((t) => t.owner !== s);
  }

  // ------------------------------------------------------------------ messages

  listen(name: string, fn: (data: unknown, name: string) => unknown, owner: ComponentState | null): () => void {
    const l: Listener = { name, fn, owner };
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  /** Delivers an emitted message: plain onMessage hooks, component onMessage(name, data), on() listeners. */
  dispatch(name: string, data: unknown): void {
    for (const fn of this.messageHooks.get(name) ?? []) this.run(`onMessage(${name})`, fn, name, data);
    this.invokeAll(this.all(), 'onMessage', name, data);
    for (const l of [...this.listeners]) {
      if (l.name !== name && l.name !== '*') continue;
      if (l.owner && (l.owner.destroyed || !l.owner.enabled)) continue;
      this.run(`on(${name})`, l.fn, data, name);
    }
  }

  // ------------------------------------------------------------------ tweens

  tween(target: object, props: Record<string, number>, seconds: number, ease: string | ((t: number) => number) | { ease?: string | ((t: number) => number); delay?: number } = 'outQuad', owner: ComponentState | null = null): Promise<void> {
    const opts = typeof ease === 'object' && ease !== null ? ease : { ease };
    const e = opts.ease ?? 'outQuad';
    const fn = typeof e === 'function' ? e : EASINGS[e];
    if (!fn) return Promise.reject(new Error(`unknown easing "${String(e)}" (use ${EASING_NAMES.join(', ')})`));
    if (!target || typeof target !== 'object') return Promise.reject(new Error('tween needs an object to animate'));
    const to: Record<string, number> = {};
    for (const [k, v] of Object.entries(props ?? {})) if (typeof v === 'number' && Number.isFinite(v)) to[k] = v;
    return new Promise<void>((resolve) => {
      this.tweens.push({
        target: target as Record<string, unknown>,
        to,
        from: null,
        start: this.world.clock + Math.max(0, Number(opts.delay) || 0),
        dur: Math.max(0, Number(seconds) || 0),
        ease: fn,
        resolve,
        owner,
        persistent: owner?.scope === 'game',
      });
    });
  }

  /** Stops the tweens animating `target` (their promises resolve). */
  stopTweens(target: object): void {
    const stop = this.tweens.filter((t) => t.target === target);
    this.tweens = this.tweens.filter((t) => t.target !== target);
    for (const t of stop) t.resolve();
  }

  private tickTweens(): void {
    if (!this.tweens.length) return;
    const now = this.world.clock;
    const keep: Tween[] = [];
    const done: Tween[] = [];
    for (const t of this.tweens) {
      if (now < t.start) {
        keep.push(t);
        continue;
      }
      // Start from wherever the target is when the tween begins (chained tweens follow each other).
      t.from ??= Object.fromEntries(Object.keys(t.to).map((k) => [k, Number(t.target[k]) || 0]));
      const k = t.dur > 0 ? Math.min(1, (now - t.start) / t.dur) : 1;
      const e = t.ease(k);
      try {
        for (const [p, v] of Object.entries(t.to)) t.target[p] = t.from[p] + (v - t.from[p]) * e;
      } catch (err) {
        this.report('tween', err);
        done.push(t);
        continue;
      }
      if (k >= 1) done.push(t);
      else keep.push(t);
    }
    this.tweens = keep;
    for (const t of done) t.resolve();
  }

  // ------------------------------------------------------------------ hot reload

  /**
   * Re-evaluates the scripts while the game runs: components keep their state (fields) and get the new
   * methods; plain-script hooks are replaced (onStart doesn't run again). Returns the loading errors.
   */
  hotReload(scripts: Record<string, string>): string[] {
    const live = [...new Set([...this.all(), ...this.unstarted])];
    const oldDefs = new Map(this.components);
    this.modules.clear();
    this.components.clear();
    this.functions.clear();
    this.startHooks.length = 0;
    this.sceneHooks.length = 0;
    this.updateHooks.length = 0;
    this.drawHooks.length = 0;
    this.messageHooks.clear();
    this.errors.length = 0;
    this.reported.clear();
    this.listeners = this.listeners.filter((l) => l.owner);
    this.load(scripts, this.evaluator);
    // Static state (GameManager.instance) carries over to the new class.
    for (const [name, def] of this.components) {
      const prev = oldDefs.get(name)?.cls as unknown as Record<string, unknown> | undefined;
      if (!prev) continue;
      const next = def.cls as unknown as Record<string, unknown>;
      for (const k of Object.getOwnPropertyNames(prev)) {
        if (['prototype', 'length', 'name', 'params'].includes(k) || typeof prev[k] === 'function' || Object.prototype.hasOwnProperty.call(next, k)) continue;
        next[k] = prev[k];
      }
    }
    let swapped = 0;
    for (const c of live) {
      const st = stateOf(c);
      if (!st || st.destroyed) continue;
      const def = this.components.get(st.def.name);
      if (!def) {
        this.world.log(`WARN hot reload: component "${st.def.name}" no longer exists; the old code keeps running until the scene restarts`);
        continue;
      }
      Object.setPrototypeOf(c, def.cls.prototype);
      st.def = def;
      for (const p of def.params) if (!(p.name in c)) define(c, p.name, p.default);
      swapped++;
    }
    this.world.log(`scripts reloaded (${swapped} live component${swapped === 1 ? '' : 's'} updated${this.errors.length ? `, ${this.errors.length} error${this.errors.length === 1 ? '' : 's'}` : ''})`);
    return [...this.errors];
  }

  /** Adds a component at runtime (addComponent). */
  add(scope: ComponentScope, actor: Actor | null, type: unknown, params: Record<string, Value> = {}): Behaviour | null {
    const c = this.instantiate(type, scope, actor, params);
    if (!c) return null;
    const s = stateOf(c)!;
    if (actor) {
      const b = { type: 'script', name: s.def.name } as { type: string; [k: string]: Value };
      actor.behaviors.push(b);
      actor.componentFor.set(b, c);
    }
    this.container(s).push(c);
    if (this.world.isRunning) this.awaken(c);
    return c;
  }

  sendMessage(actor: Actor | null, scope: ComponentScope, method: string, args: unknown[]): void {
    const list = actor ? actor.components : scope === 'game' ? this.world.gameComponents : this.world.sceneComponents;
    for (const c of [...list]) if (typeof (c as unknown as Record<string, unknown>)[method] === 'function') this.invoke(c, method, ...args);
  }

  /** Registers a legacy behavior(name, hooks) as a component class. */
  private legacy(name: string, hooks: BehaviorHooks): void {
    const L = class extends Behaviour {};
    const proto = L.prototype as unknown as Record<string, unknown>;
    const params = (c: Behaviour) => (c as unknown as { __params: Record<string, Value> }).__params ?? {};
    if (hooks.create) proto.awake = function (this: Behaviour) { return hooks.create!(this.self!, params(this)); };
    if (hooks.update) proto.update = function (this: Behaviour, dt: number) { return hooks.update!(this.self!, dt, params(this)); };
    if (hooks.collide) proto.onCollisionEnter = function (this: Behaviour, o: Handle) { return hooks.collide!(this.self!, o); };
    if (hooks.interact) proto.onInteract = function (this: Behaviour, p: Handle) { return hooks.interact!(this.self!, p); };
    if (hooks.destroy) proto.onDestroy = function (this: Behaviour) { return hooks.destroy!(this.self!); };
    this.components.set(name, { ...this.describe(name, '', L, undefined, true), definedIn: this.current });
  }

  /** Calls a script callback, logging (once) any error, including from async functions. */
  run(where: string, fn: Fn | undefined, ...args: unknown[]): unknown {
    if (!fn) return undefined;
    try {
      const r = (fn as (...a: unknown[]) => unknown)(...args);
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((err) => this.report(where, err));
      return r;
    } catch (err) {
      this.report(where, err);
      return undefined;
    }
  }

  private report(where: string, err: unknown): void {
    const loc = scriptLocation(err, this.evaluator.lineOffset ?? 0);
    const msg = `script ${where}: ${errorMessage(err)}${loc ? ` (at scripts/${loc.file}.js:${loc.line})` : ''}`;
    if (this.reported.has(msg)) return;
    this.reported.add(msg);
    this.world.log(`ERROR ${msg}`);
  }

  /** { tag, object, ignore } from a script (ignore: a handle or a list of handles). */
  private filter(f: unknown): import('./engine.js').QueryFilter {
    if (!f || typeof f !== 'object') return {};
    const o = f as { tag?: unknown; object?: unknown; ignore?: unknown; maxDistance?: unknown };
    const ign = o.ignore === undefined ? [] : Array.isArray(o.ignore) ? o.ignore : [o.ignore];
    return {
      ...(typeof o.tag === 'string' && o.tag ? { tag: o.tag } : {}),
      ...(typeof o.object === 'string' && o.object ? { object: o.object } : {}),
      ...(ign.length ? { ignore: ign.map((h) => (h as Handle)?.__actor).filter(Boolean) as Actor[] } : {}),
      ...(typeof o.maxDistance === 'number' ? { maxDistance: o.maxDistance } : {}),
    } as import('./engine.js').QueryFilter;
  }

  // ------------------------------------------------------------------ paths

  private pathTokens = new WeakMap<Actor, number>();

  /** Cancels moveTo/pathTo movements of an instance (their promises resolve). */
  stopMoving(a: Actor): void {
    this.pathTokens.set(a, (this.pathTokens.get(a) ?? 0) + 1);
    const mine = this.movers.filter((m) => m.actor === a);
    if (!mine.length) return;
    this.movers = this.movers.filter((m) => m.actor !== a);
    for (const m of mine) m.resolve();
  }

  /**
   * Walks an instance along a path around walls to a point (its hitbox center goes there).
   * Resolves true on arrival, false if there is no way, it got stuck, or another pathTo/stopMoving took over.
   */
  async pathTo(a: Actor, x: number, y: number, speed: number, opts: { diagonal?: boolean; maxSteps?: number }): Promise<boolean> {
    this.stopMoving(a);
    const token = this.pathTokens.get(a) ?? 0;
    const b = a.box();
    const path = this.world.findPath(b.x + b.w / 2, b.y + b.h / 2, x, y, { diagonal: opts.diagonal, partial: true, ignore: [a] });
    if (!path || !path.length) return false;
    const steps = opts.maxSteps && opts.maxSteps > 0 ? path.slice(0, opts.maxSteps) : path;
    for (const p of steps) {
      if (a.destroyed || this.pathTokens.get(a) !== token) return false;
      const hb = a.hitbox();
      const tx = p.x - (hb.x + hb.w / 2);
      const ty = p.y - (hb.y + hb.h / 2);
      await new Promise<void>((resolve) => this.movers.push({ actor: a, x: tx, y: ty, speed, stuck: 0, resolve }));
      if (a.destroyed || this.pathTokens.get(a) !== token) return false;
      if (Math.hypot(a.x - tx, a.y - ty) > 2) return false; // blocked on the way
    }
    const end = a.box();
    return steps.length === path.length && Math.hypot(end.x + end.w / 2 - x, end.y + end.h / 2 - y) < this.world.tileSize;
  }

  // ------------------------------------------------------------------ handles

  handle(a: Actor): Handle;
  handle(a: Actor | undefined): Handle | undefined;
  handle(a: Actor | undefined): Handle | undefined {
    if (!a) return undefined;
    let h = this.handles.get(a);
    if (h) return h;
    const w = this.world;
    const methods: Record<string, unknown> = {
      play: (anim: string, lock = 0) => {
        w.setAnim(a, '');
        w.setAnim(a, anim);
        a.animLock = lock > 0 ? w.time + lock : a.hasTag(anim) ? Infinity : 0;
      },
      destroy: () => w.destroy(a),
      flash: (seconds = 0.6) => (a.flashUntil = w.clock + seconds),
      moveTo: (x: number, y: number, speed = 60) => new Promise<void>((resolve) => this.movers.push({ actor: a, x, y, speed, stuck: 0, resolve })),
      moveBy: (dx: number, dy: number, speed = 60) => new Promise<void>((resolve) => this.movers.push({ actor: a, x: a.x + dx, y: a.y + dy, speed, stuck: 0, resolve })),
      say: (text: string, opts: { choices?: string[]; portrait?: string } = {}) => this.openDialog(String(text), { speaker: w.displayName(a), ...opts }),
      distanceTo: (other: Handle) => Math.hypot(other.__actor.x - a.x, other.__actor.y - a.y),
      overlaps: (other: Handle) => {
        const p = a.box();
        const q = other.__actor.box();
        return p.x < q.x + q.w && p.x + p.w > q.x && p.y < q.y + q.h && p.y + p.h > q.y;
      },
      face: (dir: 'up' | 'down' | 'left' | 'right') => {
        a.facing = dir;
        if (dir === 'left' || dir === 'right') a.flipX = dir === 'left' && !a.hasTag('idle_left');
        const idle = `idle_${dir}`;
        if (a.hasTag(idle)) w.setAnim(a, idle);
      },
      has: (tag: string) => a.hasTag(tag),
      isA: (object: string) => w.isA(a, String(object)),
      pathTo: (x: number, y: number, speed = 60, opts: { diagonal?: boolean; maxSteps?: number } = {}) => this.pathTo(a, Number(x), Number(y), Number(speed) || 60, opts ?? {}),
      stopMoving: () => this.stopMoving(a),
      hasTag: (tag: string) => a.tags.has(String(tag)),
      addTag: (tag: string) => void a.tags.add(String(tag)),
      removeTag: (tag: string) => void a.tags.delete(String(tag)),
      getComponent: (type: unknown) => this.componentsOf(a, type)[0] ?? null,
      getComponents: (type?: unknown) => this.componentsOf(a, type),
      addComponent: (type: unknown, params: Record<string, Value> = {}) => this.add('object', a, type, params),
      removeComponent: (type: unknown) => {
        const c = type instanceof Behaviour ? type : this.componentsOf(a, type)[0];
        if (c) this.remove(c);
      },
      sendMessage: (method: string, ...args: unknown[]) => this.sendMessage(a, 'object', String(method), args),
    };
    const fields = new Set(['x', 'y', 'vx', 'vy', 'flipX', 'visible', 'opacity', 'angle', 'z', 'onGround', 'facing']);
    h = new Proxy({} as Handle, {
      get: (_t, p) => {
        if (typeof p !== 'string') return undefined;
        if (p === '__actor') return a;
        if (p in methods) return methods[p];
        if (fields.has(p)) return (a as unknown as Record<string, unknown>)[p];
        switch (p) {
          case 'name': return w.displayName(a);
          case 'object': return a.type.name;
          case 'id': return a.id;
          case 'sceneId': return a.sceneId ?? '';
          case 'animation': return a.anim;
          case 'alive': return !a.destroyed;
          case 'width': return a.box().w;
          case 'height': return a.box().h;
          case 'centerX': { const b = a.box(); return b.x + b.w / 2; }
          case 'centerY': { const b = a.box(); return b.y + b.h / 2; }
          case 'tags': return [...a.tags];
          case 'vars': return a.vars;
          case 'text': return a.textOverride ?? '';
          case 'toJSON': return () => ({ object: a.type.name, id: a.id, x: a.x, y: a.y });
          default: return a.vars[p];
        }
      },
      set: (_t, p, v) => {
        if (typeof p !== 'string') return false;
        if (fields.has(p)) (a as unknown as Record<string, unknown>)[p] = v;
        else if (p === 'animation') w.setAnim(a, String(v));
        else if (p === 'text') {
          a.textOverride = String(v);
          a.vars.__autoText = false;
        } else a.vars[p] = v as Value;
        return true;
      },
      has: (_t, p) => typeof p === 'string' && (p in methods || fields.has(p) || p in a.vars),
    });
    this.handles.set(a, h);
    return h;
  }

  // ------------------------------------------------------------------ dialogs

  openDialog(text: string, opts: { speaker?: string; choices?: string[]; portrait?: string } = {}): Promise<number> {
    return new Promise<number>((resolve) => {
      const d = { speaker: opts.speaker ?? '', text, shown: 0, choices: opts.choices?.length ? opts.choices.map(String) : null, selected: 0, portrait: opts.portrait ?? null, resolve };
      if (this.dialog) this.dialogQueue.push(d);
      else this.dialog = { ...d, openedAt: this.world.clock };
      this.world.log(`dialog: ${d.speaker ? d.speaker + ': ' : ''}${text}${d.choices ? ` [${d.choices.join(' / ')}]` : ''}`);
    });
  }

  /** Advances the dialog with the player's input. Returns true while a dialog is open. */
  updateDialog(dt: number, confirm: boolean, up: boolean, down: boolean, auto: { choices: number[]; delay: number } | null): boolean {
    const d = this.dialog;
    if (!d) return false;
    d.shown = Math.min(d.text.length, d.shown + dt * 45);
    if (d.choices) {
      if (up) d.selected = (d.selected + d.choices.length - 1) % d.choices.length;
      if (down) d.selected = (d.selected + 1) % d.choices.length;
    }
    let go = confirm;
    if (auto && this.world.clock - d.openedAt >= auto.delay) {
      d.shown = d.text.length;
      if (d.choices) d.selected = Math.max(0, Math.min(d.choices.length - 1, auto.choices.shift() ?? 0));
      go = true;
    }
    if (go) {
      if (d.shown < d.text.length) d.shown = d.text.length;
      else {
        if (d.choices) this.world.log(`choice: ${d.choices[d.selected]}`);
        const next = this.dialogQueue.shift();
        this.dialog = next ? { ...next, openedAt: this.world.clock } : null;
        d.resolve(d.selected);
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ time

  /** Resolves after `seconds` of game clock. */
  waitFor(seconds: number, resolve: () => void, persistent = false): void {
    this.timers.push({ at: this.world.clock + Math.max(0, seconds), resolve, persistent });
  }

  /** Resolves when test() is true (checked every frame). */
  waitCondition(test: () => boolean, resolve: () => void, persistent = false): void {
    this.conditions.push({ test, resolve, persistent });
  }

  /** Resolves waits, waitUntil conditions and moveTo movements. Called every frame. */
  tick(dt: number): void {
    this.tickTweens();
    const now = this.world.clock;
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= now);
      this.timers = this.timers.filter((t) => t.at > now);
      for (const t of due) t.resolve();
    }
    if (this.conditions.length) {
      const keep: typeof this.conditions = [];
      for (const c of this.conditions) {
        let ok = false;
        try {
          ok = c.test();
        } catch (err) {
          this.report('waitUntil', err);
          ok = true;
        }
        if (ok) c.resolve();
        else keep.push(c);
      }
      this.conditions = keep;
    }
    if (this.movers.length) {
      const keep: Mover[] = [];
      for (const m of this.movers) {
        const a = m.actor;
        const dx = m.x - a.x;
        const dy = m.y - a.y;
        const d = Math.hypot(dx, dy);
        const step = m.speed * dt;
        if (a.destroyed || d <= Math.max(0.5, step)) {
          if (!a.destroyed) {
            a.x = m.x;
            a.y = m.y;
          }
          const idle = `idle_${a.facing}`;
          if (a.hasTag(idle)) this.world.setAnim(a, idle);
          else if (a.hasTag('idle')) this.world.setAnim(a, 'idle');
          m.resolve();
          continue;
        }
        this.world.moveAxis(a, (dx / d) * step, 'x');
        this.world.moveAxis(a, (dy / d) * step, 'y');
        // Blocked (a wall or a solid in the way): it barely got any closer this frame.
        const blocked = d - Math.hypot(m.x - a.x, m.y - a.y) < step * 0.25;
        a.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
        const walk = `walk_${a.facing}`;
        if (a.hasTag(walk)) this.world.setAnim(a, walk);
        else {
          if (Math.abs(dx) > 0.5) a.flipX = dx < 0;
          if (a.hasTag('walk')) this.world.setAnim(a, 'walk');
        }
        m.stuck = blocked ? m.stuck + dt : 0;
        if (m.stuck > 0.5) {
          const idle = `idle_${a.facing}`;
          if (a.hasTag(idle)) this.world.setAnim(a, idle);
          else if (a.hasTag('idle')) this.world.setAnim(a, 'idle');
          m.resolve();
          continue;
        }
        keep.push(m);
      }
      this.movers = keep;
    }
  }

  /** Drops pending waits and movements (scene change). Their promises never resolve, so the scripts stop there. */
  resetScene(): void {
    // Global components keep their coroutines across scenes.
    this.timers = this.timers.filter((t) => t.persistent);
    this.conditions = this.conditions.filter((c) => c.persistent);
    this.movers = [];
    this.tweens = this.tweens.filter((t) => t.persistent);
  }

  // ------------------------------------------------------------------ drawing

  /** Input gathered since the last draw, for widgets (several steps may run per draw, or none). */
  private uiInput = { pressed: new Set<string>(), clicks: [] as [number, number][], pointer: null as [number, number] | null };
  private menus = new Map<string, number>();

  latchInput(input: { pressed: Set<string>; clicks: [number, number][]; pointer: [number, number] | null }): void {
    for (const k of input.pressed) this.uiInput.pressed.add(k);
    this.uiInput.clicks.push(...input.clicks);
    if (input.pointer) this.uiInput.pointer = input.pointer;
  }

  draw(r: Renderer, camX: number, camY: number, zoom = 1): void {
    const drawers = this.all().filter((c) => this.has(c, 'onDraw'));
    const latch = this.uiInput;
    this.uiInput = { pressed: new Set(), clicks: [], pointer: latch.pointer };
    this.effectsInUi = false;
    if (!this.drawHooks.length && !drawers.length) return;
    const w = this.world;
    const inside = (px: number, py: number, x: number, y: number, ww: number, hh: number) => px >= x && px < x + ww && py >= y && py < y + hh;
    const clickIn = (x: number, y: number, ww: number, hh: number) => latch.clicks.some(([cx, cy]) => inside(cx, cy, x, y, ww, hh));
    const hover = (x: number, y: number, ww: number, hh: number) => !!latch.pointer && inside(latch.pointer[0], latch.pointer[1], x, y, ww, hh);
    const ui: UiApi = {
      width: w.game.width,
      height: w.game.height,
      shake: { x: Math.round((w.camera.x - camX) * zoom), y: Math.round((w.camera.y - camY) * zoom) },
      effects: (layer = 'front') => {
        this.effectsInUi = true;
        if (layer === 'screen') w.vfx.drawScreen(r, w.game.width, w.game.height);
        else w.vfx.draw(r, camX, camY, zoom, layer === 'behind');
      },
      text: (text, x, y, o = {}) => {
        const s = Math.max(1, Math.round(o.size ?? 1));
        const t = String(text);
        const m = measureText(t);
        const ox = o.align === 'center' ? -Math.round((m.width * s) / 2) : o.align === 'right' ? -m.width * s : 0;
        if (o.shadow !== false) r.text(t, x + ox + s, y + s, '#000000', s);
        r.text(t, x + ox, y, o.color ?? '#ffffff', s);
      },
      rect: (x, y, ww, hh, color, alpha = 1) => r.rect(Math.round(x), Math.round(y), Math.round(ww), Math.round(hh), color, alpha),
      panel: (x, y, ww, hh, o = {}) => {
        r.rect(x, y, ww, hh, o.color ?? '#1a1c2c', o.alpha ?? 0.9);
        const b = o.border ?? '#f4f4f4';
        r.rect(x, y, ww, 1, b);
        r.rect(x, y + hh - 1, ww, 1, b);
        r.rect(x, y, 1, hh, b);
        r.rect(x + ww - 1, y, 1, hh, b);
      },
      bar: (x, y, ww, hh, value, max, color = '#38b764', back = '#333c57') => {
        r.rect(x, y, ww, hh, '#000000');
        r.rect(x + 1, y + 1, ww - 2, hh - 2, back);
        const f = Math.max(0, Math.min(1, max > 0 ? value / max : 0));
        if (f > 0) r.rect(x + 1, y + 1, Math.max(1, Math.round((ww - 2) * f)), hh - 2, color);
      },
      sprite: (name, x, y, o = {}) => {
        const asset = w.bundle.sprites[name];
        if (!asset || !asset.frames.length) return;
        let fi = o.frame ?? 0;
        if (o.animation) {
          const tag = asset.tags.find((t) => t.name === o.animation);
          if (tag) {
            const len = tag.to - tag.from + 1;
            const dur = asset.frames[tag.from]?.duration ?? 100;
            fi = tag.from + (Math.floor((w.clock * 1000) / dur) % len);
          }
        }
        const f = asset.frames[fi] ?? asset.frames[0];
        r.image(name, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), { flipX: !!o.flipX, opacity: o.opacity ?? 1, angle: 0, scale: Math.max(1, Math.round(o.scale ?? 1)) });
      },
      measure: (text, size = 1) => {
        const m = measureText(String(text));
        return { width: m.width * size, height: m.height * size };
      },
      toScreen: (x, y) => ({ x: Math.round((x - camX) * zoom), y: Math.round((y - camY) * zoom) }),
      pressed: (key, consume = false) => {
        const k = String(key);
        const hit = latch.pressed.has(k);
        if (hit && consume) latch.pressed.delete(k);
        return hit;
      },
      mouse: {
        x: latch.pointer?.[0] ?? -1,
        y: latch.pointer?.[1] ?? -1,
        clicked: latch.clicks.length > 0,
        inside: (x, y, ww, hh) => hover(x, y, ww, hh),
      },
      window: (x, y, ww, hh, title, o = {}) => {
        ui.panel(x, y, ww, hh, o);
        if (title) {
          r.rect(x + 1, y + 1, ww - 2, 9, o.border ?? '#f4f4f4', 0.15);
          ui.text(String(title), x + 4, y + 3, { color: '#ffcd75' });
        }
      },
      button: (label, x, y, o = {}) => {
        const t = String(label);
        const m = measureText(t);
        const ww = o.w ?? m.width + 10;
        const hh = o.h ?? 11;
        const hot = !o.disabled && hover(x, y, ww, hh);
        r.rect(x, y, ww, hh, o.disabled ? '#333c57' : hot ? '#3b5dc9' : (o.color ?? '#29366f'), 0.95);
        r.rect(x, y + hh - 1, ww, 1, '#000000', 0.5);
        ui.text(t, x + Math.round(ww / 2), y + Math.round((hh - 6) / 2), { align: 'center', color: o.disabled ? '#5a6988' : (o.textColor ?? '#f4f4f4') });
        if (o.disabled) return false;
        return clickIn(x, y, ww, hh) || (!!o.key && latch.pressed.has(o.key));
      },
      menuIndex: (id, set) => {
        if (typeof set === 'number') this.menus.set(String(id), set);
        return this.menus.get(String(id)) ?? 0;
      },
      menu: (id, items, x, y, o = {}) => {
        const list: MenuItem[] = items.map((it) => (typeof it === 'string' ? { label: it } : { ...it, label: String(it.label) }));
        if (!list.length) return null;
        const rh = o.rowHeight ?? 9;
        const top = o.title ? 12 : 4;
        const ww = o.w ?? Math.max(...list.map((it) => measureText(it.label).width + (it.right ? measureText(it.right).width + 8 : 0))) + 22;
        const hh = top + list.length * rh + 3;
        let sel = Math.max(0, Math.min(list.length - 1, this.menus.get(String(id)) ?? 0));
        const enabled = (i: number) => !list[i].disabled;
        const step = (d: number) => {
          for (let k = 1; k <= list.length; k++) {
            const i = (sel + d * k + list.length * k) % list.length;
            if (enabled(i)) return i;
          }
          return sel;
        };
        let result: number | null = null;
        if (o.keys !== false) {
          if (latch.pressed.has('down')) sel = step(1);
          if (latch.pressed.has('up')) sel = step(-1);
          if ((latch.pressed.has('action') || latch.pressed.has('enter')) && enabled(sel)) result = sel;
          if (o.cancel && (latch.pressed.has('action2') || latch.pressed.has('escape'))) result = -1;
        }
        list.forEach((_, i) => {
          const ry = y + top + i * rh - 1;
          if (enabled(i) && hover(x, ry, ww, rh)) sel = i;
          if (enabled(i) && clickIn(x, ry, ww, rh)) result = i;
        });
        this.menus.set(String(id), sel);
        if (o.panel !== false) ui.window(x, y, ww, hh, o.title);
        list.forEach((it, i) => {
          const ry = y + top + i * rh;
          const isSel = i === sel;
          const color = it.disabled ? '#5a6988' : isSel ? (o.selectedColor ?? '#ffcd75') : (o.color ?? '#f4f4f4');
          if (isSel) {
            r.rect(x + 2, ry - 1, ww - 4, rh - 1, '#ffffff', 0.08);
            ui.text('>', x + 4, ry, { color });
          }
          ui.text(it.label, x + 11, ry, { color });
          if (it.right) ui.text(it.right, x + ww - 5, ry, { align: 'right', color });
        });
        return result;
      },
    };
    // Instances first (health bars), then scene and game components (HUD on top), then plain onDraw hooks.
    const order = (c: Behaviour) => { const st = stateOf(c)!; return st.actor ? 0 : st.scope === 'scene' ? 1 : 2; };
    for (const c of drawers.sort((p, q) => order(p) - order(q))) this.invoke(c, 'onDraw', ui);
    for (const fn of this.drawHooks) this.run('onDraw', fn, ui);
  }

  // ------------------------------------------------------------------ API

  /**
   * db: the data tables. db.weapons / db('weapons') = rows, db('weapons', 'bronze') or db.get('weapons', 'bronze') = one row,
   * db.where('weapons', { tier: 2 }) or a predicate, db.tables = names. Rows are read-only.
   */
  private dbApi(): unknown {
    const w = this.world;
    const rows = (t: string) => w.table(String(t)).rows;
    const fn = (t: string, id?: string) => (id === undefined ? rows(t) : (w.row(String(t), String(id)) ?? null));
    const helpers: Record<string, unknown> = {
      get: (t: string, id: string) => w.row(String(t), String(id)) ?? null,
      where: (t: string, test: Record<string, unknown> | ((row: Record<string, unknown>) => boolean)) =>
        rows(t).filter((r) => (typeof test === 'function' ? test(r) : Object.entries(test ?? {}).every(([k, v]) => r[k] === v || (Array.isArray(r[k]) && (r[k] as unknown[]).includes(v))))),
      columns: (t: string) => w.table(String(t)).columns.map((c) => ({ ...c })),
      get tables() {
        return Object.keys(w.data);
      },
    };
    return new Proxy(fn, {
      get: (target, prop, recv) => {
        if (typeof prop === 'string') {
          if (prop in helpers) return helpers[prop];
          if (prop in w.data) return rows(prop);
        }
        return Reflect.get(target, prop, recv);
      },
      has: (target, prop) => (typeof prop === 'string' && (prop in w.data || prop in helpers)) || Reflect.has(target, prop),
    });
  }

  private api(): Record<string, unknown> {
    const w = this.world;
    const host = this;
    const register = <T>(list: T[], item: T) => {
      list.push(item);
    };
    const varsProxy = (target: () => Record<string, Value>) =>
      new Proxy({} as Record<string, Value>, {
        get: (_t, p) => (typeof p === 'string' ? target()[p] : undefined),
        set: (_t, p, v) => {
          if (typeof p === 'string') target()[p] = v as Value;
          return true;
        },
        has: (_t, p) => typeof p === 'string' && p in target(),
        ownKeys: () => Reflect.ownKeys(target()),
        getOwnPropertyDescriptor: (_t, p) => (typeof p === 'string' && p in target() ? { enumerable: true, configurable: true, value: target()[p], writable: true } : undefined),
      });
    const all = (name?: string) => w.actors.filter((a) => !a.destroyed && (!name || w.isA(a, String(name))));
    return {
      // registration
      // components
      Behaviour,
      Behavior: Behaviour,
      findComponent: (type: unknown) => this.findAll(type)[0] ?? null,
      findComponents: (type: unknown) => this.findAll(type),
      // legacy: behavior(name, { create, update, collide, interact, destroy })
      behavior: (name: string, hooks: BehaviorHooks) => {
        if (this.components.has(name)) this.world.log(`WARN script ${this.current}: behavior "${name}" defined twice`);
        this.legacy(String(name), hooks ?? {});
      },
      func: (name: string, fn: Fn) => {
        this.functions.set(String(name), fn);
      },
      onStart: (fn: Fn) => register(this.startHooks, fn),
      onSceneStart: (scene: string | Fn, fn?: Fn) => (typeof scene === 'function' ? this.sceneHooks.push({ scene: null, fn: scene }) : this.sceneHooks.push({ scene, fn: fn! })),
      onUpdate: (fn: Fn) => register(this.updateHooks, fn),
      onDraw: (fn: Fn) => register(this.drawHooks, fn),
      on: (name: string, fn: (data: unknown, name: string) => unknown) => this.listen(String(name), fn, null),
      tween: (target: object, props: Record<string, number>, seconds: number, ease?: string | ((t: number) => number) | { ease?: string; delay?: number }) => this.tween(target, props, seconds, ease),
      stopTweens: (target: object) => this.stopTweens(target),
      onMessage: (msg: string, fn: Fn) => {
        const l = this.messageHooks.get(msg) ?? [];
        l.push(fn);
        this.messageHooks.set(msg, l);
      },
      // dialogs & flow
      say: (text: unknown, opts: { speaker?: string; portrait?: string } = {}) => this.openDialog(String(text), opts).then(() => undefined),
      choose: (choices: unknown[], opts: { text?: string; speaker?: string; portrait?: string } = {}) => this.openDialog(String(opts.text ?? ''), { ...opts, choices: choices.map(String) }),
      dialogue: (name: string, self?: Handle, other?: Handle) => w.startDialogue(String(name), self?.__actor, other?.__actor),
      wait: (seconds: number) => new Promise<void>((resolve) => this.timers.push({ at: w.clock + Math.max(0, Number(seconds) || 0), resolve })),
      waitUntil: (test: () => boolean) => new Promise<void>((resolve) => this.conditions.push({ test, resolve, persistent: false })),
      // state
      vars: varsProxy(() => w.globals),
      scene: {
        get name() { return w.scene.name; },
        get width() { return w.widthPx; },
        get height() { return w.heightPx; },
        get tileSize() { return w.tileSize; },
        vars: varsProxy(() => w.sceneVars),
      },
      game: {
        get title() { return w.game.title; },
        get width() { return w.game.width; },
        get height() { return w.game.height; },
        get time() { return w.time; },
        get clock() { return w.clock; },
        get dialogOpen() { return !!host.dialog; },
        get paused() { return w.paused; },
        get music() { return w.music; },
      },
      camera: {
        get x() { return w.camera.x; },
        set x(v: number) { w.camera.x = Number(v) || 0; },
        get y() { return w.camera.y; },
        set y(v: number) { w.camera.y = Number(v) || 0; },
        get zoom() { return w.zoom; },
        set zoom(v: number) { w.camera.zoom = Number(v) || 1; },
        get width() { return w.viewWidth; },
        get height() { return w.viewHeight; },
        /** Follow another instance (null: stop following; undefined: back to the Camera behavior). */
        follow: (h: Handle | null | undefined) => {
          w.cameraTarget = h === undefined ? undefined : h ? h.__actor : null;
        },
        setBounds: (x: number, y: number, ww: number, hh: number) => {
          w.cameraBounds = { x: Number(x) || 0, y: Number(y) || 0, w: Math.max(1, Number(ww) || 0), h: Math.max(1, Number(hh) || 0) };
        },
        clearBounds: () => {
          w.cameraBounds = null;
        },
        /** Screen pixel → world position (mouse, taps). */
        toWorld: (sx: number, sy: number) => ({ x: Number(sx) / w.zoom + w.camera.x, y: Number(sy) / w.zoom + w.camera.y }),
      },
      // data tables (read-only)
      db: this.dbApi(),
      refreshInstances: () => w.refreshConditional(),
      // instances
      find: (name?: string) => all(name).map((a) => this.handle(a)),
      findOne: (name: string) => this.handle(all(name)[0]),
      // tags and physics queries
      findWithTag: (tag: string) => w.actors.filter((a) => !a.destroyed && a.tags.has(String(tag))).map((a) => this.handle(a)),
      isSolidAt: (x: number, y: number) => w.isSolidAt(Number(x), Number(y)),
      overlapBox: (x: number, y: number, ww: number, hh: number, f?: unknown) => w.overlapRect({ x: Number(x), y: Number(y), w: Number(ww), h: Number(hh) }, this.filter(f)).map((a) => this.handle(a)),
      overlapCircle: (x: number, y: number, r: number, f?: unknown) => w.overlapCircle(Number(x), Number(y), Number(r), this.filter(f)).map((a) => this.handle(a)),
      findNearest: (x: number | Handle, y?: number | Record<string, unknown>, f?: unknown) => {
        // findNearest(self, { tag }) or findNearest(x, y, { tag })
        if (x && typeof x === 'object') {
          const from = (x as Handle).__actor;
          const b = from.box();
          const flt = this.filter(y);
          return this.handle(w.findNearest(b.x + b.w / 2, b.y + b.h / 2, { ...flt, ignore: [...(flt.ignore ?? []), from] })) ?? null;
        }
        return this.handle(w.findNearest(Number(x), Number(y), this.filter(f))) ?? null;
      },
      raycast: (x1: number, y1: number, x2: number, y2: number, f?: unknown) => {
        const o = (f && typeof f === 'object' ? f : {}) as { solids?: boolean; instances?: boolean };
        const hit = w.raycast(Number(x1), Number(y1), Number(x2), Number(y2), { ...this.filter(f), solids: o.solids, instances: o.instances });
        return hit ? { x: hit.x, y: hit.y, distance: hit.distance, normalX: hit.normalX, normalY: hit.normalY, tile: hit.tile, instance: this.handle(hit.actor ?? undefined) ?? null } : null;
      },
      particles: (x: number, y: number, preset: unknown = 'sparks', overrides: Record<string, unknown> = {}) => w.particles.burst(Number(x), Number(y), preset as string, (overrides ?? {}) as object),
      vfx: (name: string, from: unknown, to?: unknown, opts: Record<string, unknown> = {}) => {
        // Instances are followed while they move; { x, y } points stay put.
        const where = (v: unknown) => {
          const h = v as Handle | { x?: unknown; y?: unknown } | null | undefined;
          if (!h || typeof h !== 'object') return undefined;
          if ('__actor' in h) return (h as Handle).__actor;
          const p = h as { x?: unknown; y?: unknown };
          return { x: Number(p.x) || 0, y: Number(p.y) || 0 };
        };
        const source = where(from);
        if (!source) {
          w.log(`vfx("${name}"): the second argument must be an instance or { x, y }`);
          return Promise.resolve();
        }
        const o = (opts && typeof opts === 'object' ? opts : {}) as { tint?: unknown; scale?: unknown; speed?: unknown; angle?: unknown; onMessage?: unknown };
        const on = o.onMessage;
        return w.playVfx(String(name), source, where(to), {
          ...(typeof o.tint === 'string' ? { tint: o.tint } : {}),
          ...(typeof o.scale === 'number' ? { scale: o.scale } : {}),
          ...(typeof o.speed === 'number' ? { speed: o.speed } : {}),
          ...(typeof o.angle === 'number' ? { angle: o.angle } : {}),
          ...(typeof on === 'function' ? { onMessage: (m: string) => this.run('vfx onMessage', on as (m: string) => void, m) } : {}),
        });
      },
      findPath: (x1: number, y1: number, x2: number, y2: number, opts: { diagonal?: boolean; partial?: boolean } = {}) => w.findPath(Number(x1), Number(y1), Number(x2), Number(y2), opts ?? {}),
      player: () => this.handle(w.actors.find((a) => !a.destroyed && a.behaviors.some((b) => (b.type === 'platformer' || b.type === 'topdown') && b.controls !== false))),
      spawn: (name: string, x: number, y: number, props: Record<string, Value> = {}, opts: { sprite?: string; name?: string; animation?: string } = {}) =>
        this.handle(w.spawn(String(name), Number(x), Number(y), 0, 0, { props: props ?? {}, sprite: opts?.sprite ? String(opts.sprite) : undefined, name: opts?.name ? String(opts.name) : undefined, animation: opts?.animation ? String(opts.animation) : undefined })),
      // world
      goto: (scene: string, opts: { fade?: number; color?: string } = {}) => w.gotoScene(String(scene), opts ?? {}),
      restart: (opts: { fade?: number; color?: string } = {}) => w.restartScene(opts ?? {}),
      sound: (name: string, volume = 0.5) => w.opts.sound?.(String(name), volume),
      shake: (intensity = 3, seconds = 0.3) => w.startShake(intensity, seconds),
      emit: (msg: string, data?: unknown) => w.emit(String(msg), data),
      lockControls: (on = true) => (w.controlsLocked = !!on),
      pause: (on = true) => (w.paused = !!on),
      music: (name: string, opts: { volume?: number; loop?: boolean; fade?: number } = {}) => w.playMusic(String(name), opts ?? {}),
      stopMusic: (fade = 1) => w.stopMusic(Number(fade)),
      setVolume: (channel: 'music' | 'sfx', value: number) => w.setVolume(channel, value),
      log: (...args: unknown[]) => w.log(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
      key: (name: string) => w.input.down.has(String(name)),
      pressed: (name: string) => w.input.pressed.has(String(name)),
      random: (a = 0, b = 1) => a + w.random() * (b - a),
      randint: (a: number, b: number) => Math.floor(a + w.random() * (Math.floor(b) - Math.ceil(a) + 1)),
      pick: <T>(list: T[]) => list[Math.floor(w.random() * list.length)],
      saveGame: (slot = 'auto') => w.saveGame(String(slot)),
      loadGame: (slot = 'auto') => w.loadGame(String(slot)),
      hasSave: (slot = 'auto') => w.hasSave(String(slot)),
      deleteSave: (slot: string) => w.deleteSave(String(slot)),
      listSaves: () => w.listSaves(),
      save: (key: string, value: unknown) => w.opts.storage?.set(`script:${key}`, JSON.stringify(value)),
      load: (key: string, fallback: unknown = null) => {
        const raw = w.opts.storage?.get(`script:${key}`);
        if (raw === null || raw === undefined) return fallback;
        try {
          return JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      Math,
      JSON,
      CELL_W,
      CELL_H,
    };
  }
}

/** Collects what scripts register without running a game (for validation and editor dropdowns). */
export interface ScriptInfo {
  /** Component names (also legacy behavior() names). */
  behaviors: string[];
  functions: string[];
  errors: string[];
  components: ComponentInfo[];
}

export { SCRIPT_REFERENCE } from './scriptApi.js';
