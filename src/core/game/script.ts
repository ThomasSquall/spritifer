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

/** Turns source code + API into registrations. The server swaps in a node:vm based evaluator. */
export type ScriptEvaluator = (code: string, api: Record<string, unknown>, filename: string) => void;

export const defaultEvaluator: ScriptEvaluator = (code, api, filename) => {
  const names = Object.keys(api);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, `"use strict";\n${code}\n//# sourceURL=${filename}`) as (...a: unknown[]) => void;
  fn(...names.map((n) => api[n]));
};

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

  constructor(readonly world: World) {}

  /** Names of the components (for validation and dropdowns). */
  get behaviors(): Map<string, ComponentDef> {
    return this.components;
  }

  // ------------------------------------------------------------------ loading

  /** Evaluates every script as a module (imports first), then registers the component classes. */
  load(scripts: Record<string, string>, evaluate: ScriptEvaluator = defaultEvaluator): void {
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
        const msg = `script ${name}: ${err instanceof Error ? err.message : String(err)}`;
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
        warnings.push(`fields could not be read (a field initializer threw: ${err instanceof Error ? err.message : String(err)}); move that code to awake()`);
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
      if (s) s.destroyed = true;
    }
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
    const msg = `script ${where}: ${err instanceof Error ? err.message : String(err)}`;
    if (this.reported.has(msg)) return;
    this.reported.add(msg);
    this.world.log(`ERROR ${msg}`);
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
  }

  // ------------------------------------------------------------------ drawing

  draw(r: Renderer, camX: number, camY: number): void {
    const drawers = this.all().filter((c) => this.has(c, 'onDraw'));
    if (!this.drawHooks.length && !drawers.length) return;
    const w = this.world;
    const ui: UiApi = {
      width: w.game.width,
      height: w.game.height,
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
      toScreen: (x, y) => ({ x: Math.round(x - camX), y: Math.round(y - camY) }),
    };
    // Instances first (health bars), then scene and game components (HUD on top), then plain onDraw hooks.
    const order = (c: Behaviour) => { const st = stateOf(c)!; return st.actor ? 0 : st.scope === 'scene' ? 1 : 2; };
    for (const c of drawers.sort((p, q) => order(p) - order(q))) this.invoke(c, 'onDraw', ui);
    for (const fn of this.drawHooks) this.run('onDraw', fn, ui);
  }

  // ------------------------------------------------------------------ API

  private api(): Record<string, unknown> {
    const w = this.world;
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
    const all = (name?: string) => w.actors.filter((a) => !a.destroyed && (!name || a.type.name === name));
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
        vars: varsProxy(() => w.sceneVars),
      },
      game: {
        get title() { return w.game.title; },
        get width() { return w.game.width; },
        get height() { return w.game.height; },
        get time() { return w.time; },
        get clock() { return w.clock; },
      },
      camera: {
        get x() { return w.camera.x; },
        set x(v: number) { w.camera.x = v; },
        get y() { return w.camera.y; },
        set y(v: number) { w.camera.y = v; },
      },
      // instances
      find: (name?: string) => all(name).map((a) => this.handle(a)),
      findOne: (name: string) => this.handle(all(name)[0]),
      player: () => this.handle(w.actors.find((a) => !a.destroyed && a.behaviors.some((b) => (b.type === 'platformer' || b.type === 'topdown') && b.controls !== false))),
      spawn: (name: string, x: number, y: number, props: Record<string, Value> = {}) => {
        const a = w.spawn(name, x, y);
        if (a) Object.assign(a.vars, props);
        return this.handle(a);
      },
      // world
      goto: (scene: string) => w.gotoScene(String(scene)),
      restart: () => w.restartScene(),
      sound: (name: string, volume = 0.5) => w.opts.sound?.(String(name), volume),
      shake: (intensity = 3, seconds = 0.3) => w.startShake(intensity, seconds),
      emit: (msg: string) => w.emit(String(msg)),
      lockControls: (on = true) => (w.controlsLocked = !!on),
      log: (...args: unknown[]) => w.log(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
      key: (name: string) => w.input.down.has(String(name)),
      pressed: (name: string) => w.input.pressed.has(String(name)),
      random: (a = 0, b = 1) => a + w.random() * (b - a),
      randint: (a: number, b: number) => Math.floor(a + w.random() * (Math.floor(b) - Math.ceil(a) + 1)),
      pick: <T>(list: T[]) => list[Math.floor(w.random() * list.length)],
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
