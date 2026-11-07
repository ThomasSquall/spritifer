/**
 * Game scripts: plain JavaScript files in the project (scripts/*.js) that register behaviors, functions
 * callable from events, global hooks, and drive dialogs, menus, cutscenes and custom UI.
 *
 *   behavior('npc', {
 *     interact: async (self, player) => {
 *       await say('Hello! Want a potion?', { speaker: 'Old man' })
 *       if (await choose(['Yes', 'No']) === 0) vars.potions += 1
 *     },
 *   })
 *   func('openChest', async (self) => { self.play('open'); await say('You found 10 gold!'); vars.gold += 10 })
 *   onDraw((ui) => ui.bar(4, 4, 60, 6, vars.hp, vars.maxHp, '#e43b44'))
 *
 * See SCRIPT_REFERENCE for the whole API.
 */

import type { Actor, Renderer, World } from './engine.js';
import { CELL_H, CELL_W, measureText } from './font.js';
import type { Value } from './types.js';

type Fn = (...args: never[]) => unknown;

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
  sprite(name: string, x: number, y: number, opts?: { frame?: number; animation?: string; flipX?: boolean; opacity?: number }): void;
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
  readonly behaviors = new Map<string, BehaviorHooks>();
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
  private conditions: { test: () => boolean; resolve: () => void }[] = [];
  movers: Mover[] = [];
  private handles = new WeakMap<Actor, Handle>();
  private current = '';
  private reported = new Set<string>();
  /** True while scripts are being evaluated (registration phase). */
  private loading = false;

  constructor(private world: World) {}

  // ------------------------------------------------------------------ loading

  load(scripts: Record<string, string>, evaluate: ScriptEvaluator = defaultEvaluator): void {
    this.loading = true;
    const api = this.api();
    for (const name of Object.keys(scripts).sort()) {
      this.current = name;
      try {
        evaluate(scripts[name], api, `scripts/${name}.js`);
      } catch (err) {
        const msg = `script ${name}: ${err instanceof Error ? err.message : String(err)}`;
        this.errors.push(msg);
        this.world.log(`ERROR ${msg}`);
      }
    }
    this.current = '';
    this.loading = false;
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
      flash: (seconds = 0.6) => (a.flashUntil = w.time + seconds),
      moveTo: (x: number, y: number, speed = 60) => new Promise<void>((resolve) => this.movers.push({ actor: a, x, y, speed, stuck: 0, resolve })),
      moveBy: (dx: number, dy: number, speed = 60) => new Promise<void>((resolve) => this.movers.push({ actor: a, x: a.x + dx, y: a.y + dy, speed, stuck: 0, resolve })),
      say: (text: string, opts: { choices?: string[]; portrait?: string } = {}) => this.openDialog(String(text), { speaker: a.type.name, ...opts }),
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
    };
    const fields = new Set(['x', 'y', 'vx', 'vy', 'flipX', 'visible', 'opacity', 'angle', 'z', 'onGround', 'facing']);
    h = new Proxy({} as Handle, {
      get: (_t, p) => {
        if (typeof p !== 'string') return undefined;
        if (p === '__actor') return a;
        if (p in methods) return methods[p];
        if (fields.has(p)) return (a as unknown as Record<string, unknown>)[p];
        switch (p) {
          case 'name':
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
        const bx = this.world.moveAxis(a, (dx / d) * step, 'x');
        const by = this.world.moveAxis(a, (dy / d) * step, 'y');
        a.facing = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
        const walk = `walk_${a.facing}`;
        if (a.hasTag(walk)) this.world.setAnim(a, walk);
        else {
          if (Math.abs(dx) > 0.5) a.flipX = dx < 0;
          if (a.hasTag('walk')) this.world.setAnim(a, 'walk');
        }
        m.stuck = bx && by ? m.stuck + dt : 0;
        if (m.stuck > 0.5) {
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
    this.timers = [];
    this.conditions = [];
    this.movers = [];
  }

  // ------------------------------------------------------------------ drawing

  draw(r: Renderer, camX: number, camY: number): void {
    if (!this.drawHooks.length) return;
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
        r.image(name, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), { flipX: !!o.flipX, opacity: o.opacity ?? 1, angle: 0 });
      },
      measure: (text, size = 1) => {
        const m = measureText(String(text));
        return { width: m.width * size, height: m.height * size };
      },
      toScreen: (x, y) => ({ x: Math.round(x - camX), y: Math.round(y - camY) }),
    };
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
      behavior: (name: string, hooks: BehaviorHooks) => {
        if (this.behaviors.has(name)) this.world.log(`WARN script ${this.current}: behavior "${name}" defined twice`);
        this.behaviors.set(String(name), hooks ?? {});
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
      wait: (seconds: number) => new Promise<void>((resolve) => this.timers.push({ at: w.clock + Math.max(0, Number(seconds) || 0), resolve })),
      waitUntil: (test: () => boolean) => new Promise<void>((resolve) => this.conditions.push({ test, resolve })),
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
      restart: () => w.gotoScene(w.scene.name),
      sound: (name: string, volume = 0.5) => w.opts.sound?.(String(name), volume),
      shake: (intensity = 3, seconds = 0.3) => (w.shake = { until: w.time + seconds, intensity }),
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
  behaviors: string[];
  functions: string[];
  errors: string[];
}

export const SCRIPT_REFERENCE = `SCRIPTS — plain JavaScript files in the project (scripts/<name>.js), loaded in name order when the game starts. Top-level code registers things; callbacks run during play. Async functions can await dialogs, menus, waits and movements.

REGISTER
- behavior(name, { create(self, params), update(self, dt, params), collide(self, other), interact(self, player), destroy(self) })
    Attach it to an object type with the behavior { type: "script", name: "<name>", ...params }.
    interact runs when the player presses action (Space/Z) next to or facing the instance (RPG talk / open).
- func(name, async (self, other, arg) => ...)   Call it from events with the action "Run script function" (call).
- onStart(fn)                 once when the game starts
- onSceneStart([scene,] fn)   every time a scene (or the given scene) starts; fn(sceneName)
- onUpdate(fn(dt))            every frame while not in a dialog
- onDraw(fn(ui))              every frame, screen-space UI on top of the game (HUD, HP bars, menus)
- onMessage(msg, fn)          when an event or script emits msg

FLOW (return promises — use await inside async functions)
- await say(text, { speaker, portrait })       dialog box with typewriter text; the player confirms with Space/Z/Enter. The game pauses while a dialog is open.
- const i = await choose(['Attack', 'Run'], { text, speaker })   menu, returns the chosen index (Up/Down + confirm)
- await wait(seconds)    await waitUntil(() => condition)
- await self.moveTo(x, y, speed)   await self.moveBy(dx, dy, speed)   (walks with walk_<dir> animations, stops at walls)
- lockControls(true/false)   freeze player controls during cutscenes

STATE
- vars.score, vars.hp ...      global variables (read/write; declare initial values in the Game tab)
- scene.name, scene.width, scene.height, scene.vars.x
- game.title, game.width, game.height, game.time (seconds in this scene), game.clock (since start)
- camera.x, camera.y

INSTANCES (handles)
- find('enemy') → array, findOne('door'), player(), spawn('coin', x, y, { value: 5 })
- self.x, self.y, self.vx, self.vy, self.flipX, self.visible, self.opacity, self.z, self.facing, self.onGround,
  self.name, self.id, self.alive, self.width, self.height, self.centerX, self.centerY, self.animation, self.text
- self.hp (any other name = the instance's property; set it freely)
- self.play('attack', lockSeconds?), self.destroy(), self.flash(seconds), self.say(text), self.face('left'),
  self.distanceTo(other), self.overlaps(other), self.has('walk_down')

WORLD
- goto('scene'), restart(), sound('coin'|'jump'|'hit'|'hurt'|'explosion'|'powerup'|'laser'|'blip'|'select'|'step', volume),
  shake(intensity, seconds), emit('msg'), log(...), key('left') held, pressed('action') this frame,
  random(a, b), randint(a, b), pick(list), save(key, value) / load(key, fallback) (browser storage)

UI (inside onDraw(ui => ...), screen pixels, 4x6 pixel font)
- ui.text(text, x, y, { color, size, align: 'left'|'center'|'right', shadow })
- ui.rect(x, y, w, h, color, alpha), ui.panel(x, y, w, h, { color, border, alpha }), ui.bar(x, y, w, h, value, max, color, back)
- ui.sprite(name, x, y, { frame, animation, flipX, opacity }), ui.measure(text, size), ui.toScreen(worldX, worldY), ui.width, ui.height

EXAMPLE (turn-based battle scene)
  onSceneStart('battle', async () => {
    const foe = { name: 'Slime', hp: 12 }
    lockControls(true)
    await say('A wild ' + foe.name + ' appears!')
    while (foe.hp > 0 && vars.hp > 0) {
      const c = await choose(['Attack', 'Heal', 'Run'])
      if (c === 2) { await say('You ran away.'); break }
      if (c === 0) { const d = randint(3, 6); foe.hp -= d; sound('hit'); shake(2, 0.2); await say('You hit for ' + d + '!') }
      else { vars.hp = Math.min(vars.maxHp, vars.hp + 8); sound('powerup'); await say('You feel better.') }
      if (foe.hp > 0) { const d = randint(1, 4); vars.hp -= d; await say(foe.name + ' hits you for ' + d + '.') }
    }
    lockControls(false)
    goto('town')
  })
  onDraw((ui) => { if (scene.name === 'battle') ui.bar(8, 8, 80, 7, vars.hp, vars.maxHp, '#e43b44') })`;
