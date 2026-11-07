/**
 * The Spritifer game engine: a deterministic, renderer-agnostic simulation of a GameBundle.
 * The browser player (src/runtime) feeds it input and draws it on a canvas; the server runs it
 * headless for playtests and renders it to bitmaps for previews.
 */

import { ACTION_MAP, BEHAVIOR_MAP, CONDITION_MAP, TRIGGER_MAP, withDefaults } from './catalog.js';
import { type ExprContext, MATH_FUNCTIONS, compile, fmt, parseTarget, toNum, truthy } from './expr.js';
import { measureText } from './font.js';
import type { Behavior, ComponentOverrides, EventStep, GameBundle, GameEvent, GameProject, Hitbox, ObjectType, Scene, SpriteAsset, Value } from './types.js';
import { type Behaviour, type ScriptEvaluator, ScriptHost, componentState, fieldsOf, wrapText } from './script.js';
import { type DialogueBook, buildDialogueBook, runDialogue } from './dialogue.js';

export const STEP = 1 / 60;

export interface InputFrame {
  /** Logical keys held this frame (left, right, up, down, space, action, a..z, ...). */
  down: Set<string>;
  pressed: Set<string>;
  released: Set<string>;
  /** Clicks/taps this frame, in screen (viewport) pixels. */
  clicks: [number, number][];
  /** Pointer position in screen pixels (or null). */
  pointer: [number, number] | null;
}

export function emptyInput(): InputFrame {
  return { down: new Set(), pressed: new Set(), released: new Set(), clicks: [], pointer: null };
}

export interface EngineOptions {
  seed?: number;
  /** Persisted variables (save action). */
  storage?: { get(key: string): string | null; set(key: string, value: string): void };
  sound?: (name: string, volume: number) => void;
  log?: (message: string) => void;
  /** Start in this scene instead of game.startScene. */
  scene?: string;
  /** How scripts are evaluated (the server uses node:vm). */
  evaluator?: ScriptEvaluator;
  /** Headless runs: confirm dialogs automatically after `delay` seconds, picking menu entries from `choices` (default 0). */
  autoDialog?: { choices: number[]; delay: number };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

export class Actor {
  readonly id: number;
  readonly type: ObjectType;
  /** Built-in behaviors and script components ({ type: "script", name }), in order. */
  behaviors: Behavior[];
  /** Script component instances (Behaviour subclasses). */
  components: Behaviour[] = [];
  /** Which component instance a { type: "script" } behavior entry created. */
  componentFor = new Map<Behavior, Behaviour>();
  /** Per-instance component settings from the scene. */
  componentConfig: ComponentOverrides | undefined;
  /** Component fields remembered by a persistent scene. */
  componentRestore: Record<string, Record<string, Value>> | undefined;
  componentsReady = false;
  /** onCreated ran (components awoken, "created" events fired). */
  created = false;
  readonly asset: SpriteAsset | undefined;
  x: number;
  y: number;
  vx = 0;
  vy = 0;
  startX: number;
  startY: number;
  vars: Record<string, Value>;
  anim = '';
  seqIdx = 0;
  frameTime = 0;
  /** Behaviors don't change the animation until this time (Infinity = until it ends). */
  animLock = 0;
  flipX = false;
  visible = true;
  opacity = 1;
  angle = 0;
  z: number;
  onGround = false;
  destroyed = false;
  textOverride: string | null = null;
  flashUntil = 0;
  createdAt: number;
  facing: 'down' | 'up' | 'left' | 'right' = 'down';
  /** Name given to the placed instance (hierarchy / dialogue speaker). */
  instName: string | null = null;
  /** Instances touched last frame (for "collision" = start of touch). */
  touching = new Set<Actor>();
  /** One-frame trigger flags. */
  flags = { landed: false, hitWall: false, leftScene: false, animEnd: '' as string | null };
  /** Whether the instance was outside the scene last frame (null = not checked yet). */
  outside: boolean | null = null;
  timers = new Map<number, number>();
  // Platformer state.
  coyote = 0;
  jumpBuffer = 0;
  airJumps = 0;
  patrolDir = 1;
  sineOffset = 0;
  sceneId?: string;

  constructor(id: number, type: ObjectType, asset: SpriteAsset | undefined, x: number, y: number, now: number) {
    this.id = id;
    this.type = type;
    this.asset = asset;
    this.behaviors = type.behaviors.map((b) => withDefaults(b, BEHAVIOR_MAP.get(b.type)));
    this.x = this.startX = x;
    this.y = this.startY = y;
    this.vars = { ...type.properties };
    this.z = type.z ?? 0;
    this.createdAt = now;
    this.anim = type.animation ?? '';
  }

  behavior(type: string): Behavior | undefined {
    return this.behaviors.find((b) => b.type === type);
  }

  get frameW(): number {
    return this.asset?.width ?? 8;
  }
  get frameH(): number {
    return this.asset?.height ?? 8;
  }

  /** Collision box in world pixels. */
  box(x = this.x, y = this.y): Rect {
    const hb = this.hitbox();
    return { x: x + hb.x, y: y + hb.y, w: hb.w, h: hb.h };
  }

  hitbox(): Hitbox {
    if (this.type.hitbox) {
      const hb = this.type.hitbox;
      // Mirror the hitbox with the sprite.
      return this.flipX && this.asset ? { x: this.asset.width - hb.x - hb.w, y: hb.y, w: hb.w, h: hb.h } : hb;
    }
    if (!this.asset && this.type.text !== undefined) {
      const m = measureText(this.textOverride ?? '');
      const s = this.type.textSize ?? 1;
      return { x: 0, y: 0, w: Math.max(1, m.width * s), h: Math.max(1, m.height * s) };
    }
    return { x: 0, y: 0, w: this.frameW, h: this.frameH };
  }

  /** Frame indices of the current animation. */
  sequence(): number[] {
    const a = this.asset;
    if (!a || !a.frames.length) return [0];
    const tag = this.anim ? a.tags.find((t) => t.name === this.anim) : undefined;
    if (!tag) return a.frames.map((_, i) => i);
    const fwd: number[] = [];
    for (let i = tag.from; i <= Math.min(tag.to, a.frames.length - 1); i++) fwd.push(i);
    if (tag.direction === 'reverse') return fwd.reverse();
    if (tag.direction === 'pingpong' && fwd.length > 2) return [...fwd, ...fwd.slice(1, -1).reverse()];
    return fwd.length ? fwd : [0];
  }

  frameIndex(): number {
    const seq = this.sequence();
    return seq[this.seqIdx % seq.length] ?? 0;
  }

  hasTag(name: string): boolean {
    return !!this.asset?.tags.some((t) => t.name === name);
  }
}

interface ExecCtx {
  self?: Actor;
  other?: Actor;
}

/** Runs one game. Call step() 60 times per second with the current input. */
export class World {
  readonly bundle: GameBundle;
  readonly game: GameProject;
  scene!: Scene;
  actors: Actor[] = [];
  globals: Record<string, Value>;
  sceneVars: Record<string, Value> = {};
  time = 0;
  /** Seconds since the game started (does not reset with scenes). */
  clock = 0;
  frame = 0;
  camera = { x: 0, y: 0 };
  /** Screen shake, timed with `clock` (keeps running while dialogs pause the scene, so it always ends). */
  shake = { until: 0, intensity: 0, duration: 0 };
  message: { text: string; until: number } | null = null;
  logs: string[] = [];
  input: InputFrame = emptyInput();
  private nextId = 1;
  private pendingScene: string | null = null;
  private messages: { name: string; data: unknown }[] = [];
  /** Screen fade for scene transitions: out (to color) → load the scene → in. */
  fade: { phase: 'none' | 'out' | 'in'; t: number; dur: number; color: string; scene: string | null; restart: boolean } = { phase: 'none', t: 0, dur: 0, color: '#000000', scene: null, restart: false };
  private sceneTimers = new Map<number, number>();
  private rngState: number;
  private depth = 0;
  private objectMap = new Map<string, ObjectType>();
  private errors = new Set<string>();
  private solidLayers: number[][] = [];
  private started = false;
  private gameStarted = false;
  /** Per persistent scene: what happened to each placed instance. */
  private memory = new Map<string, Map<string, { destroyed?: boolean; x?: number; y?: number; vars?: Record<string, Value>; flipX?: boolean; facing?: Actor['facing']; anim?: string; comps?: Record<string, Record<string, Value>> }>>();
  /** Components of the current scene (managers, level logic). */
  sceneComponents: Behaviour[] = [];
  /** Global components: created when the game starts, kept across scenes. */
  gameComponents: Behaviour[] = [];
  private resetPending = false;
  readonly opts: EngineOptions;
  readonly scripts: ScriptHost;
  readonly dialogues: DialogueBook;
  /** Instances in a conversation right now (pressing action again doesn't restart it). */
  private talking = new Set<Actor>();
  /** Player controls ignore input (cutscenes, battles). */
  controlsLocked = false;

  constructor(bundle: GameBundle, opts: EngineOptions = {}) {
    this.bundle = bundle;
    this.game = bundle.game;
    this.opts = opts;
    this.rngState = (opts.seed ?? 12345) >>> 0;
    for (const o of this.game.objects) this.objectMap.set(o.name, o);
    this.globals = { ...this.game.variables };
    // Saved variables override the initial values.
    if (opts.storage) {
      for (const k of Object.keys(this.globals)) {
        const v = opts.storage.get(k);
        if (v !== null) {
          try {
            this.globals[k] = JSON.parse(v) as Value;
          } catch {
            // Ignore corrupt values.
          }
        }
      }
    }
    this.dialogues = buildDialogueBook(bundle.dialogues ?? {});
    for (const e of this.dialogues.errors) this.log(`ERROR dialogues/${e.file}.dialogue line ${e.line}: ${e.message}`);
    this.scripts = new ScriptHost(this);
    this.scripts.load(bundle.scripts ?? {}, opts.evaluator);
    const names = Object.keys(bundle.scenes);
    const first = opts.scene && bundle.scenes[opts.scene] ? opts.scene : bundle.scenes[this.game.startScene] ? this.game.startScene : names[0];
    if (!first) throw new Error('The game has no scenes');
    this.loadScene(first);
  }

  // ------------------------------------------------------------------ utils

  random(): number {
    // mulberry32
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  log(msg: string): void {
    this.logs.push(`[${this.clock.toFixed(2)}s] ${msg}`);
    if (this.logs.length > 500) this.logs.shift();
    this.opts.log?.(msg);
  }

  private error(where: string, err: unknown): void {
    const msg = `${where}: ${err instanceof Error ? err.message : String(err)}`;
    if (this.errors.has(msg)) return;
    this.errors.add(msg);
    this.log(`ERROR ${msg}`);
  }

  get tileSize(): number {
    return this.scene.tileSize;
  }
  get widthPx(): number {
    return this.scene.cols * this.scene.tileSize;
  }
  get heightPx(): number {
    return this.scene.rows * this.scene.tileSize;
  }

  // ------------------------------------------------------------------ scenes

  loadScene(name: string): void {
    const scene = this.bundle.scenes[name];
    if (!scene) {
      this.error('gotoScene', new Error(`no scene "${name}"`));
      return;
    }
    // Leaving a persistent scene: remember where everything is.
    const prev = this.scene;
    if (prev && this.started) this.scripts.invokeAll(this.gameComponents, 'onSceneEnd', prev.name);
    if (prev?.persistent && prev.name !== name) {
      const mem = this.memory.get(prev.name) ?? new Map();
      for (const a of this.actors) {
        if (!a.sceneId || a.destroyed) continue;
        const comps: Record<string, Record<string, Value>> = {};
        for (const c of a.components) {
          const st = componentState(c);
          if (st) comps[st.name] = fieldsOf(c);
        }
        mem.set(a.sceneId, { x: a.x, y: a.y, vars: { ...a.vars }, flipX: a.flipX, facing: a.facing, anim: a.anim, ...(a.components.length ? { comps } : {}) });
      }
      this.memory.set(prev.name, mem);
    }
    // The old scene's components are gone (their pending waits stop).
    if (this.scripts) {
      this.scripts.drop(this.sceneComponents);
      for (const a of this.actors) this.scripts.drop(a.components);
    }
    this.sceneComponents = [];
    if (this.resetPending || prev?.name === name) this.memory.delete(name);
    this.resetPending = false;
    const remembered = scene.persistent ? this.memory.get(name) : undefined;
    this.scene = scene;
    this.actors = [];
    this.sceneVars = { ...scene.variables };
    this.time = 0;
    this.sceneTimers.clear();
    this.message = null;
    this.shake = { until: 0, intensity: 0, duration: 0 };
    this.camera = { x: 0, y: 0 };
    this.solidLayers = scene.layers.filter((l) => l.solid).map((l) => l.tiles);
    this.scripts?.resetScene();
    for (const inst of scene.instances) {
      const type = this.objectMap.get(inst.object);
      if (!type) continue;
      const mem = remembered?.get(inst.id);
      if (mem?.destroyed) continue;
      const a = this.makeActor(type, inst.x, inst.y, inst.sprite);
      a.sceneId = inst.id;
      a.instName = inst.name ?? null;
      if (inst.animation) a.anim = inst.animation;
      if (inst.props) Object.assign(a.vars, inst.props);
      if (inst.flipX) a.flipX = true;
      a.componentConfig = inst.components;
      if (mem) {
        a.componentRestore = mem.comps;
        a.x = a.startX = mem.x ?? a.x;
        a.y = a.startY = mem.y ?? a.y;
        if (mem.vars) a.vars = { ...mem.vars };
        if (mem.flipX !== undefined) a.flipX = mem.flipX;
        if (mem.facing) a.facing = mem.facing;
        if (mem.anim !== undefined) {
          a.anim = mem.anim;
          if (a.hasTag(mem.anim)) a.animLock = Infinity;
        }
      }
      this.actors.push(a);
    }
    this.started = false;
    this.log(`scene "${name}" started`);
  }

  private makeActor(type: ObjectType, x: number, y: number, spriteOverride?: string): Actor {
    const spriteName = spriteOverride && this.bundle.sprites[spriteOverride] ? spriteOverride : type.sprite;
    const asset = spriteName ? this.bundle.sprites[spriteName] : undefined;
    const a = new Actor(this.nextId++, type, asset, x, y, this.time);
    type.events.forEach((e, i) => {
      if (e.trigger.type === 'timer') a.timers.set(i, this.time + Math.max(0.01, toNum(e.trigger.seconds ?? 1)));
    });
    return a;
  }

  /** True once the current scene has started (components created at runtime are awoken right away). */
  get isRunning(): boolean {
    return this.started;
  }

  private begin(): void {
    this.started = true;
    this.scene.events.forEach((e, i) => {
      if (e.trigger.type === 'timer') this.sceneTimers.set(i, this.time + Math.max(0.01, toNum(e.trigger.seconds ?? 1)));
    });
    const firstScene = !this.gameStarted;
    // Create every component first (so awake() can find the others), then awake them: game, scene, instances.
    if (firstScene) this.gameComponents = this.makeComponents(this.game.components, 'game');
    this.sceneComponents = this.makeComponents(this.scene.components, 'scene');
    for (const a of this.actors) this.ensureComponents(a);
    if (firstScene) for (const c of [...this.gameComponents]) this.scripts.awaken(c);
    for (const c of [...this.sceneComponents]) this.scripts.awaken(c);
    for (const a of [...this.actors]) this.onCreated(a);
    this.scripts.runStarts();
    for (const a of [...this.actors]) this.fireObject(a, 'start');
    this.fireScene('start');
    if (firstScene) {
      this.gameStarted = true;
      for (const fn of this.scripts.startHooks) this.scripts.run('onStart', fn);
    }
    for (const h of this.scripts.sceneHooks) if (h.scene === null || h.scene === this.scene.name) this.scripts.run(`onSceneStart(${this.scene.name})`, h.fn, this.scene.name);
    this.scripts.invokeAll(this.gameComponents, 'onSceneStart', this.scene.name);
    this.updateCamera(true);
  }

  private makeComponents(list: Behavior[] | undefined, scope: 'scene' | 'game'): Behaviour[] {
    const out: Behaviour[] = [];
    for (const b of list ?? []) {
      const { type: _t, name, ...params } = b;
      const c = this.scripts.instantiate(String(name ?? ''), scope, null, params);
      if (c) out.push(c);
    }
    return out;
  }

  /** Creates the script components of an instance: the object type's ones (with instance overrides) + instance-only ones. */
  private ensureComponents(a: Actor): void {
    if (a.componentsReady) return;
    a.componentsReady = true;
    const over = a.componentConfig ?? {};
    const names = new Set(a.behaviors.filter((b) => b.type === 'script').map((b) => String(b.name ?? '')));
    for (const n of Object.keys(over)) if (!names.has(n)) a.behaviors.push({ type: 'script', name: n });
    for (const b of [...a.behaviors]) {
      if (b.type !== 'script') continue;
      const name = String(b.name ?? '');
      const { type: _t, name: _n, ...params } = b;
      const c = this.scripts.instantiate(name, 'object', a, { ...params, ...(over[name] ?? {}) }, a.componentRestore?.[name]);
      if (!c) continue;
      a.componentFor.set(b, c);
      a.components.push(c);
    }
  }

  /** Changes scene at the end of the frame; with `fade` (seconds) the screen fades out to `color`, then in. */
  gotoScene(name: string, opts: { fade?: number; color?: string } = {}): void {
    if (!this.bundle.scenes[name]) throw new Error(`no scene "${name}"`);
    if (this.startFade(name, false, opts)) return;
    this.pendingScene = name;
  }

  /** Restarts the current scene from scratch (a persistent scene forgets what happened). */
  restartScene(opts: { fade?: number; color?: string } = {}): void {
    if (this.startFade(this.scene.name, true, opts)) return;
    this.resetPending = true;
    this.pendingScene = this.scene.name;
  }

  private startFade(scene: string, restart: boolean, opts: { fade?: number; color?: string }): boolean {
    const dur = Math.min(5, Math.max(0, Number(opts.fade) || 0));
    if (!dur) return false;
    if (this.fade.phase === 'out') return true; // already leaving
    this.fade = { phase: 'out', t: 0, dur, color: typeof opts.color === 'string' && opts.color ? opts.color : '#000000', scene, restart };
    return true;
  }

  /** Opacity of the fade overlay (0 = none). */
  get fadeAlpha(): number {
    const f = this.fade;
    if (f.phase === 'none' || !f.dur) return 0;
    const k = Math.min(1, f.t / f.dur);
    return f.phase === 'out' ? k : 1 - k;
  }

  /** Plays a dialogue (dialogues/*.dialogue). `self` is the instance that speaks, `other` usually the player. */
  startDialogue(name: string, self?: Actor, other?: Actor): Promise<void> {
    if (self) {
      if (this.talking.has(self)) return Promise.resolve();
      this.talking.add(self);
    }
    const ctx: ExecCtx = { self, other };
    const p = runDialogue(this.dialogues, name, {
      show: (text, speaker, choices) => this.scripts.openDialog(text, { speaker, choices: choices ?? undefined }),
      evaluate: (expr) => this.eval(expr, ctx),
      read: (target) => this.read(parseTarget(target), ctx),
      assign: (target, value) => this.assign(parseTarget(target), value, ctx),
      selfName: self ? this.displayName(self) : '',
      log: (m) => this.log(m),
      command: (cmd, args) => this.dialogueCommand(cmd, args, ctx),
    });
    return p
      .catch((err) => this.error(`dialogue ${name}`, err))
      .finally(() => {
        if (self) this.talking.delete(self);
      });
  }

  private async dialogueCommand(cmd: string, args: string[], ctx: ExecCtx): Promise<'stop' | void> {
    const self = ctx.self;
    switch (cmd) {
      case 'sound':
        this.opts.sound?.(args[0] ?? 'blip', args[1] ? toNum(args[1]) : 0.5);
        return;
      case 'goto':
        this.gotoScene(String(args[0]));
        return 'stop';
      case 'restart':
        this.restartScene();
        return 'stop';
      case 'call': {
        const fn = this.scripts.functions.get(String(args[0]));
        if (!fn) throw new Error(`no script function "${args[0]}"`);
        const arg = args.length > 1 ? this.eval(args.slice(1).join(' '), ctx) : undefined;
        await this.scripts.run(`func ${args[0]}`, fn, this.scripts.handle(self), this.scripts.handle(ctx.other), arg);
        return;
      }
      case 'emit':
        this.emit(args.join(' '));
        return;
      case 'wait':
        await new Promise<void>((resolve) => this.scripts.waitFor(toNum(args[0] ?? 1), resolve));
        return;
      case 'shake':
        this.startShake(args[0] ? toNum(args[0]) : 3, args[1] ? toNum(args[1]) : 0.3);
        return;
      case 'anim':
        if (self) {
          this.setAnim(self, '');
          this.setAnim(self, String(args[0] ?? ''));
          self.animLock = self.hasTag(String(args[0])) ? Infinity : 0;
        }
        return;
      case 'face': {
        if (!self) return;
        let dir = args[0] as Actor['facing'] | 'player';
        if (dir === 'player' && ctx.other) {
          const dx = ctx.other.x - self.x;
          const dy = ctx.other.y - self.y;
          dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : dy < 0 ? 'up' : 'down';
        }
        if (dir === 'player') return;
        self.facing = dir;
        if (self.hasTag(`idle_${dir}`)) this.setAnim(self, `idle_${dir}`);
        else if (dir === 'left' || dir === 'right') self.flipX = dir === 'left';
        return;
      }
      case 'destroy':
        if (self) this.destroy(self);
        return;
      case 'spawn': {
        const [obj, x = '0', y = '0'] = args;
        this.spawn(String(obj), toNum(this.eval(x, ctx)) + (self?.x ?? 0), toNum(this.eval(y, ctx)) + (self?.y ?? 0));
        return;
      }
      default:
        throw new Error(`unknown command "${cmd}"`);
    }
  }

  /** Display name of an instance: its own name, else the object type's. */
  displayName(a: Actor): string {
    return a.instName ?? a.type.name;
  }

  startShake(intensity: number, seconds: number): void {
    const dur = Math.max(0, Math.min(10, seconds));
    this.shake = { until: this.clock + dur, intensity: Math.max(0, Math.min(32, intensity)), duration: dur };
  }

  /** Queues a message (with optional data) for events, onMessage hooks and on() listeners, delivered this frame. */
  emit(message: string, data?: unknown): void {
    this.messages.push({ name: message, data });
  }

  /** Lets pending script continuations run (call after step() when scripts use await). */
  async settle(): Promise<void> {
    for (let i = 0; i < 40; i++) await null;
  }

  private onCreated(a: Actor): void {
    if (a.created) return;
    a.created = true;
    const bullet = a.behavior('bullet');
    if (bullet && a.vx === 0 && a.vy === 0) {
      const ang = (toNum(bullet.angle) * Math.PI) / 180;
      a.vx = Math.cos(ang) * toNum(bullet.speed);
      a.vy = Math.sin(ang) * toNum(bullet.speed);
    }
    this.ensureComponents(a);
    for (const c of [...a.components]) this.scripts.awaken(c);
    this.fireObject(a, 'created');
  }

  // ------------------------------------------------------------------ main loop

  step(input: InputFrame = emptyInput(), dt = STEP): void {
    this.input = input;
    if (!this.started) this.begin();

    // Dialogs pause the game; the frame that closes one doesn't run gameplay either (the key press is used up).
    const confirm = input.pressed.has('action') || input.pressed.has('enter') || input.clicks.length > 0;
    // Fading out to another scene: the game holds still until the screen is covered.
    if (this.fade.phase === 'out') {
      this.fade.t += dt;
      this.scripts.tick(dt);
      for (const a of this.actors) if (!a.destroyed) this.updateAnimation(a, dt);
      this.clock += dt;
      this.frame++;
      if (this.fade.t >= this.fade.dur) {
        const { scene, restart } = this.fade;
        this.fade = { ...this.fade, phase: 'in', t: 0 };
        if (restart) this.resetPending = true;
        if (scene) this.loadScene(scene);
      }
      return;
    }
    if (this.fade.phase === 'in') {
      this.fade.t += dt;
      if (this.fade.t >= this.fade.dur) this.fade = { ...this.fade, phase: 'none', t: 0, scene: null };
    }
    const inDialog = this.scripts.updateDialog(dt, confirm, input.pressed.has('up'), input.pressed.has('down'), this.opts.autoDialog ?? null);
    this.scripts.tick(dt);
    if (inDialog) {
      for (const a of this.actors) if (!a.destroyed) this.updateAnimation(a, dt);
      this.updateTexts();
      this.clock += dt;
      this.frame++;
      this.applyPendingScene();
      return;
    }
    for (const fn of this.scripts.updateHooks) this.scripts.run('onUpdate', fn, dt);
    this.scripts.runStarts();
    this.scripts.invokeAll(this.gameComponents, 'update', dt);
    this.scripts.invokeAll(this.sceneComponents, 'update', dt);

    for (const a of this.actors) {
      a.flags.landed = a.flags.hitWall = a.flags.leftScene = false;
      a.flags.animEnd = null;
    }

    for (const a of this.actors) if (!a.destroyed) this.updateBehaviors(a, dt);
    for (const a of this.actors) if (!a.destroyed) this.updateAnimation(a, dt);

    // Leaving the scene.
    const W = this.widthPx;
    const H = this.heightPx;
    for (const a of this.actors) {
      if (a.destroyed || a.type.hud) continue;
      const b = a.box();
      const out = b.x + b.w < 0 || b.x > W || b.y + b.h < 0 || b.y > H;
      // Only a real exit counts: instances created outside (e.g. falling in from above) don't fire it.
      if (out && a.outside === false) a.flags.leftScene = true;
      a.outside = out;
    }

    // Overlaps.
    const live = this.actors.filter((a) => !a.destroyed && !a.type.hud);
    const now = new Map<Actor, Set<Actor>>();
    for (const a of live) now.set(a, new Set());
    for (let i = 0; i < live.length; i++) {
      const bi = live[i].box();
      for (let j = i + 1; j < live.length; j++) {
        if (overlap(bi, live[j].box())) {
          now.get(live[i])!.add(live[j]);
          now.get(live[j])!.add(live[i]);
        }
      }
    }

    // Component collision hooks: enter (start of touch), stay, exit.
    const sh = this.scripts;
    for (const a of live) {
      if (!a.components.length || a.destroyed) continue;
      const enter = a.components.some((c) => sh.has(c, 'onCollisionEnter'));
      const stay = a.components.some((c) => sh.has(c, 'onCollisionStay'));
      const exit = a.components.some((c) => sh.has(c, 'onCollisionExit'));
      if (!enter && !stay && !exit) continue;
      const cur = now.get(a) ?? new Set<Actor>();
      for (const o of cur) {
        if (a.destroyed) break;
        if (o.destroyed) continue;
        const was = a.touching.has(o);
        if (!was && enter) sh.invokeAll(a.components, 'onCollisionEnter', sh.handle(o));
        else if (was && stay) sh.invokeAll(a.components, 'onCollisionStay', sh.handle(o));
      }
      if (exit) for (const o of a.touching) if (!cur.has(o) && !a.destroyed) sh.invokeAll(a.components, 'onCollisionExit', sh.handle(o));
    }

    // Events.
    for (const a of [...this.actors]) {
      if (a.destroyed) continue;
      const touching = now.get(a) ?? new Set<Actor>();
      this.runObjectEvents(a, touching);
      a.touching = touching;
    }
    if (this.pressedKey('action')) this.interact();
    if (input.clicks.length) {
      for (const a of [...this.actors]) if (!a.destroyed && a.components.some((c) => sh.has(c, 'onClick')) && this.clickHits(a)) sh.invokeAll(a.components, 'onClick');
    }
    this.runSceneEvents();
    for (let round = 0; round < 10 && this.messages.length; round++) {
      const msgs = this.messages.splice(0);
      for (const { name: m, data } of msgs) {
        sh.dispatch(m, data);
        for (const a of [...this.actors]) if (!a.destroyed) this.fireObject(a, 'message', (t) => t.message === m);
        this.fireScene('message', (t) => t.message === m);
      }
    }

    // Late update: after movement, collisions and events.
    sh.invokeAll(this.gameComponents, 'lateUpdate', dt);
    sh.invokeAll(this.sceneComponents, 'lateUpdate', dt);
    for (const a of [...this.actors]) if (!a.destroyed && a.components.length) sh.invokeAll(a.components, 'lateUpdate', dt);

    this.updateTexts();

    this.actors = this.actors.filter((a) => !a.destroyed);
    this.updateCamera(false);
    this.time += dt;
    this.clock += dt;
    this.frame++;
    this.applyPendingScene();
  }

  private applyPendingScene(): void {
    if (this.pendingScene) {
      const s = this.pendingScene;
      this.pendingScene = null;
      this.loadScene(s);
    }
  }

  /** The player pressed action: talk to / use the instance next to it (or in front of it). */
  private interact(): void {
    const players = this.actors.filter((a) => !a.destroyed && a.behaviors.some((b) => (b.type === 'topdown' || b.type === 'platformer') && b.controls !== false));
    for (const p of players) {
      const b = p.box();
      const reach = 8;
      const dir = p.behavior('topdown') ? p.facing : p.flipX ? 'left' : 'right';
      const probe = {
        x: b.x - (dir === 'left' ? reach : 1),
        y: b.y - (dir === 'up' ? reach : 1),
        w: b.w + 2 + (dir === 'left' || dir === 'right' ? reach : 0),
        h: b.h + 2 + (dir === 'up' || dir === 'down' ? reach : 0),
      };
      let best: Actor | undefined;
      let bd = Infinity;
      for (const o of this.actors) {
        if (o === p || o.destroyed || o.type.hud) continue;
        const hasHook = o.type.events.some((e) => !e.disabled && e.trigger.type === 'interact') || !!o.behavior('dialogue') || o.components.some((c) => this.scripts.has(c, 'onInteract'));
        if (!hasHook || !overlap(probe, o.box())) continue;
        const ob = o.box();
        const d = Math.hypot(ob.x + ob.w / 2 - (b.x + b.w / 2), ob.y + ob.h / 2 - (b.y + b.h / 2));
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (!best) continue;
      this.fireObject(best, 'interact', undefined, p);
      const talk = best.behavior('dialogue');
      if (talk) {
        const node = String(best.vars.dialogue ?? '') || String(talk.dialogue ?? '');
        if (node) void this.startDialogue(node, best, p);
        else this.error(`object ${best.type.name}`, new Error('Talks behavior without a dialogue (set the dialogue property of the instance)'));
      }
      this.scripts.invokeAll(best.components, 'onInteract', this.scripts.handle(p));
      return;
    }
  }

  /** Re-evaluates the text expression of text objects. */
  updateTexts(): void {
    for (const a of this.actors) {
      if (a.type.text !== undefined && !a.destroyed && a.vars.__autoText !== false) {
        try {
          a.textOverride = fmt(compile(a.type.text)(this.ctx({ self: a })));
        } catch (err) {
          this.error(`object ${a.type.name} text`, err);
        }
      }
    }
  }

  // ------------------------------------------------------------------ collisions

  private solidAtTile(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= this.scene.cols || ty >= this.scene.rows) return false;
    const k = ty * this.scene.cols + tx;
    for (const l of this.solidLayers) if (l[k] >= 0) return true;
    return false;
  }

  /** Solid rectangles overlapping `box` that block `self` (tiles, solid instances, optional scene walls). */
  private solids(box: Rect, self: Actor, movingDown: boolean, prevBottom: number): Rect[] {
    const out: Rect[] = [];
    const ts = this.tileSize;
    const x0 = Math.floor(box.x / ts);
    const x1 = Math.floor((box.x + box.w - 1e-6) / ts);
    const y0 = Math.floor(box.y / ts);
    const y1 = Math.floor((box.y + box.h - 1e-6) / ts);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (this.solidAtTile(tx, ty)) out.push({ x: tx * ts, y: ty * ts, w: ts, h: ts });
    for (const o of this.actors) {
      if (o === self || o.destroyed) continue;
      const s = o.behavior('solid');
      if (!s) continue;
      const ob = o.box();
      if (!overlap(box, ob)) continue;
      if (s.oneWay === true && !(movingDown && prevBottom <= ob.y + 0.01)) continue;
      out.push(ob);
    }
    const walls = self.behavior('platformer') || self.behavior('topdown') || self.behavior('bounded') || self.behavior('patrol');
    if (walls) {
      const W = this.widthPx;
      const H = this.heightPx;
      const big = 1e5;
      const walled = [{ x: -big, y: -big, w: big, h: 3 * big }, { x: W, y: -big, w: big, h: 3 * big }];
      if (self.behavior('topdown') || self.behavior('bounded')) walled.push({ x: -big, y: -big, w: 3 * big, h: big }, { x: -big, y: H, w: 3 * big, h: big });
      for (const r of walled) if (overlap(box, r)) out.push(r);
    }
    return out;
  }

  /** Moves along one axis, stopping at solids. Returns true when blocked. */
  moveAxis(a: Actor, d: number, axis: 'x' | 'y'): boolean {
    if (d === 0) return false;
    const maxStep = Math.max(1, this.tileSize / 2 - 1);
    const steps = Math.ceil(Math.abs(d) / maxStep);
    const sub = d / steps;
    for (let i = 0; i < steps; i++) {
      const prev = a.box();
      if (axis === 'x') a.x += sub;
      else a.y += sub;
      const box = a.box();
      const hits = this.solids(box, a, axis === 'y' && sub > 0, prev.y + prev.h);
      if (!hits.length) continue;
      const hb = a.hitbox();
      if (axis === 'x') {
        a.x = sub > 0 ? Math.min(...hits.map((r) => r.x)) - hb.x - hb.w : Math.max(...hits.map((r) => r.x + r.w)) - hb.x;
      } else {
        a.y = sub > 0 ? Math.min(...hits.map((r) => r.y)) - hb.y - hb.h : Math.max(...hits.map((r) => r.y + r.h)) - hb.y;
      }
      return true;
    }
    return false;
  }

  private groundBelow(a: Actor): boolean {
    const b = a.box();
    return this.solids({ x: b.x, y: b.y + b.h, w: b.w, h: 1 }, a, true, b.y + b.h).length > 0;
  }

  /** Is there ground just past the leading bottom corner (for ledge turning)? */
  private groundAhead(a: Actor, dir: number): boolean {
    const b = a.box();
    const probe = { x: dir > 0 ? b.x + b.w : b.x - 1, y: b.y + b.h, w: 1, h: 2 };
    return this.solids(probe, a, true, b.y + b.h).length > 0;
  }

  // ------------------------------------------------------------------ behaviors

  private key(k: string): boolean {
    return !this.controlsLocked && this.input.down.has(k);
  }

  private pressedKey(k: string): boolean {
    return !this.controlsLocked && this.input.pressed.has(k);
  }

  private pickAnim(a: Actor, candidates: string[]): void {
    if (a.animLock > this.time) return;
    // A script is walking this instance (cutscene): its walk animation wins.
    if (this.scripts.movers.some((m) => m.actor === a)) return;
    const name = candidates.find((c) => a.hasTag(c));
    if (name !== undefined) this.setAnim(a, name);
  }

  setAnim(a: Actor, name: string): void {
    if (a.anim === name) return;
    a.anim = name;
    a.seqIdx = 0;
    a.frameTime = 0;
  }

  private updateBehaviors(a: Actor, dt: number): void {
    const g = this.game.gravity;
    for (const b of a.components.length ? [...a.behaviors] : a.behaviors) {
      switch (b.type) {
        case 'platformer': {
          const speed = toNum(b.speed);
          const ctl = b.controls !== false;
          const dir = ctl ? (this.key('right') ? 1 : 0) - (this.key('left') ? 1 : 0) : 0;
          const acc = toNum(b.acceleration) || 1200;
          if (ctl) {
            const target = dir * speed;
            const rate = (dir === 0 ? acc * 1.5 : acc) * (a.onGround ? 1 : 0.65) * dt;
            a.vx = a.vx < target ? Math.min(target, a.vx + rate) : Math.max(target, a.vx - rate);
            if (dir) a.flipX = dir < 0;
          }
          const wasGround = a.onGround;
          a.coyote = a.onGround ? 0.1 : a.coyote - dt;
          if (a.onGround) a.airJumps = b.doubleJump === true ? 1 : 0;
          if (ctl && (this.pressedKey('up') || this.pressedKey('action'))) a.jumpBuffer = 0.12;
          else a.jumpBuffer -= dt;
          if (a.jumpBuffer > 0 && a.coyote > 0) {
            a.vy = -toNum(b.jump);
            a.coyote = 0;
            a.jumpBuffer = 0;
            a.onGround = false;
          } else if (a.jumpBuffer > 0 && a.airJumps > 0 && !a.onGround) {
            a.vy = -toNum(b.jump) * 0.9;
            a.airJumps--;
            a.jumpBuffer = 0;
          }
          const holding = !ctl || this.key('up') || this.key('action');
          a.vy += g * dt * (a.vy < 0 && !holding ? 2.5 : 1);
          a.vy = Math.min(a.vy, Math.max(200, g * 0.7));
          if (this.moveAxis(a, a.vx * dt, 'x')) {
            a.vx = 0;
            a.flags.hitWall = true;
          }
          const blocked = this.moveAxis(a, a.vy * dt, 'y');
          if (blocked && a.vy < 0) a.vy = 0;
          a.onGround = a.vy >= 0 && (blocked || this.groundBelow(a));
          if (a.onGround) a.vy = 0;
          if (a.onGround && !wasGround) a.flags.landed = true;
          if (a.onGround) this.pickAnim(a, Math.abs(a.vx) > 5 ? ['run', 'walk', 'idle'] : ['idle']);
          else this.pickAnim(a, a.vy < 0 ? ['jump', 'fall', 'idle'] : ['fall', 'jump', 'idle']);
          break;
        }
        case 'topdown': {
          const speed = toNum(b.speed);
          if (b.controls !== false) {
            let dx = (this.key('right') ? 1 : 0) - (this.key('left') ? 1 : 0);
            let dy = (this.key('down') ? 1 : 0) - (this.key('up') ? 1 : 0);
            if (b.diagonals === false && dx && dy) dy = 0;
            const len = Math.hypot(dx, dy) || 1;
            dx /= len;
            dy /= len;
            a.vx = dx * speed;
            a.vy = dy * speed;
          }
          if (this.moveAxis(a, a.vx * dt, 'x')) a.flags.hitWall = true;
          if (this.moveAxis(a, a.vy * dt, 'y')) a.flags.hitWall = true;
          const moving = Math.abs(a.vx) + Math.abs(a.vy) > 1;
          if (moving) a.facing = Math.abs(a.vx) > Math.abs(a.vy) ? (a.vx < 0 ? 'left' : 'right') : a.vy < 0 ? 'up' : 'down';
          const f = a.facing;
          const hasDirTags = a.hasTag(`walk_${f}`) || a.hasTag(`idle_${f}`);
          if (!hasDirTags && (f === 'left' || f === 'right')) a.flipX = f === 'left';
          this.pickAnim(a, moving ? [`walk_${f}`, `run_${f}`, 'walk', 'run', `idle_${f}`, 'idle'] : [`idle_${f}`, 'idle']);
          break;
        }
        case 'bullet': {
          const before = a.flags.hitWall;
          if (b.destroyOnSolid !== false) {
            const bx = this.moveAxis(a, a.vx * dt, 'x');
            const by = this.moveAxis(a, a.vy * dt, 'y');
            if (bx || by) {
              a.flags.hitWall = true;
              this.destroy(a);
            }
          } else {
            a.x += a.vx * dt;
            a.y += a.vy * dt;
          }
          if (!before && a.vx) a.flipX = a.vx < 0;
          // Bullets that fly far outside the scene are gone for good.
          const bb = a.box();
          if (bb.x + bb.w < -64 || bb.y + bb.h < -64 || bb.x > this.widthPx + 64 || bb.y > this.heightPx + 64) this.destroy(a);
          break;
        }
        case 'patrol': {
          const speed = toNum(b.speed);
          if (b.gravity !== false) {
            a.vy = Math.min(a.vy + g * dt, Math.max(200, g * 0.7));
          }
          a.vx = a.patrolDir * speed;
          if (this.moveAxis(a, a.vx * dt, 'x')) {
            a.patrolDir *= -1;
            a.flags.hitWall = true;
          } else if (b.turnAtLedges !== false && a.onGround && !this.groundAhead(a, a.patrolDir)) {
            a.patrolDir *= -1;
          }
          if (b.gravity !== false) {
            const wasGround = a.onGround;
            const blocked = this.moveAxis(a, a.vy * dt, 'y');
            a.onGround = a.vy >= 0 && (blocked || this.groundBelow(a));
            if (a.onGround) a.vy = 0;
            if (blocked && a.vy < 0) a.vy = 0;
            if (a.onGround && !wasGround) a.flags.landed = true;
          } else this.moveAxis(a, a.vy * dt, 'y');
          a.flipX = a.patrolDir < 0;
          this.pickAnim(a, ['walk', 'run', 'idle']);
          break;
        }
        case 'chase': {
          const target = this.nearest(a, String(b.target ?? 'player'));
          const range = toNum(b.range) || 160;
          if (target) {
            const ab = a.box();
            const tb = target.box();
            const dx = tb.x + tb.w / 2 - (ab.x + ab.w / 2);
            const dy = tb.y + tb.h / 2 - (ab.y + ab.h / 2);
            const d = Math.hypot(dx, dy);
            if (d < range && d > 1) {
              const sp = toNum(b.speed);
              a.vx = (dx / d) * sp;
              a.vy = (dy / d) * sp;
              this.moveAxis(a, a.vx * dt, 'x');
              this.moveAxis(a, a.vy * dt, 'y');
              if (Math.abs(dx) > 1) a.flipX = dx < 0;
              this.pickAnim(a, ['walk', 'run', 'idle']);
              break;
            }
          }
          a.vx = a.vy = 0;
          this.pickAnim(a, ['idle']);
          break;
        }
        case 'sine': {
          const t = this.time - a.createdAt;
          const off = toNum(b.amplitude) * Math.sin((2 * Math.PI * t) / Math.max(0.05, toNum(b.period)));
          // Apply the change of offset, so floating combines with velocity and other movement.
          if (b.axis === 'x') a.x += off - a.sineOffset;
          else a.y += off - a.sineOffset;
          a.sineOffset = off;
          break;
        }
        case 'bounded': {
          if (!a.behavior('platformer') && !a.behavior('topdown')) {
            const hb = a.hitbox();
            a.x = Math.max(-hb.x, Math.min(this.widthPx - hb.x - hb.w, a.x));
            a.y = Math.max(-hb.y, Math.min(this.heightPx - hb.y - hb.h, a.y));
          }
          break;
        }
        case 'wrap': {
          const bx = a.box();
          if (bx.x > this.widthPx) a.x -= this.widthPx + bx.w;
          else if (bx.x + bx.w < 0) a.x += this.widthPx + bx.w;
          if (bx.y > this.heightPx) a.y -= this.heightPx + bx.h;
          else if (bx.y + bx.h < 0) a.y += this.heightPx + bx.h;
          break;
        }
        case 'script': {
          const c = a.componentFor.get(b);
          if (c) this.scripts.invoke(c, 'update', dt);
          break;
        }
        case 'lifetime': {
          if (this.time - a.createdAt >= toNum(b.seconds)) this.destroy(a);
          break;
        }
        default:
          break;
      }
      if (a.destroyed) return;
    }
    // Objects without a movement behavior still move with their velocity.
    if (!a.behaviors.some((b) => ['platformer', 'topdown', 'bullet', 'patrol', 'chase'].includes(b.type))) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
    }
  }

  private updateAnimation(a: Actor, dt: number): void {
    const asset = a.asset;
    if (!asset || asset.frames.length < 1) return;
    const seq = a.sequence();
    a.frameTime += dt * 1000;
    let guard = 0;
    while (guard++ < 64) {
      const dur = Math.max(10, asset.frames[seq[a.seqIdx % seq.length]]?.duration ?? 100);
      if (a.frameTime < dur) break;
      a.frameTime -= dur;
      a.seqIdx++;
      if (a.seqIdx >= seq.length) {
        a.seqIdx = 0;
        a.flags.animEnd = a.anim;
        if (a.animLock === Infinity) a.animLock = 0;
      }
    }
  }

  private updateCamera(snap: boolean): void {
    const vw = this.game.width;
    const vh = this.game.height;
    const followed = this.actors.find((a) => !a.destroyed && a.behavior('camera'));
    let tx = this.camera.x;
    let ty = this.camera.y;
    if (followed) {
      const cb = followed.behavior('camera')!;
      const b = followed.box();
      tx = b.x + b.w / 2 - vw / 2;
      ty = b.y + b.h / 2 - vh / 2 + toNum(cb.offsetY);
      const s = snap ? 1 : Math.min(1, Math.max(0.01, 1 - toNum(cb.smoothing)));
      tx = this.camera.x + (tx - this.camera.x) * s;
      ty = this.camera.y + (ty - this.camera.y) * s;
    }
    const W = this.widthPx;
    const H = this.heightPx;
    this.camera.x = W <= vw ? (W - vw) / 2 : Math.max(0, Math.min(W - vw, tx));
    this.camera.y = H <= vh ? (H - vh) / 2 : Math.max(0, Math.min(H - vh, ty));
  }

  // ------------------------------------------------------------------ events

  private fireObject(a: Actor, trigger: string, match?: (t: GameEvent['trigger']) => boolean, other?: Actor): void {
    a.type.events.forEach((e) => {
      if (e.disabled || e.trigger.type !== trigger || (match && !match(e.trigger))) return;
      this.runEvent(e, { self: a, other }, `object ${a.type.name}`);
    });
  }

  private fireScene(trigger: string, match?: (t: GameEvent['trigger']) => boolean): void {
    this.scene.events.forEach((e) => {
      if (e.disabled || e.trigger.type !== trigger || (match && !match(e.trigger))) return;
      this.runEvent(e, {}, `scene ${this.scene.name}`);
    });
  }

  private matchesWith(o: Actor, w: Value | undefined): boolean {
    return w === undefined || w === 'any' || o.type.name === w;
  }

  private keyTrigger(set: Set<string>, key: Value | undefined): boolean {
    const k = String(key ?? 'space');
    return k === 'any' ? set.size > 0 : set.has(k);
  }

  private clickHits(a: Actor): boolean {
    for (const [cx, cy] of this.input.clicks) {
      const wx = a.type.hud ? cx : cx + this.camera.x;
      const wy = a.type.hud ? cy : cy + this.camera.y;
      const b = a.box();
      if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h) return true;
    }
    return false;
  }

  private runObjectEvents(a: Actor, touching: Set<Actor>): void {
    a.type.events.forEach((e, i) => {
      if (e.disabled || a.destroyed) return;
      const t = e.trigger;
      const run = (other?: Actor) => this.runEvent(e, { self: a, other }, `object ${a.type.name}`);
      switch (t.type) {
        case 'update': return run();
        case 'keyPressed': return this.keyTrigger(this.input.pressed, t.key) ? run() : undefined;
        case 'keyDown': return this.keyTrigger(this.input.down, t.key) ? run() : undefined;
        case 'keyReleased': return this.keyTrigger(this.input.released, t.key) ? run() : undefined;
        case 'collision':
          for (const o of touching) if (!a.touching.has(o) && !o.destroyed && this.matchesWith(o, t.with)) { run(o); if (a.destroyed) return; }
          return;
        case 'overlapping':
          for (const o of touching) if (!o.destroyed && this.matchesWith(o, t.with)) { run(o); if (a.destroyed) return; }
          return;
        case 'click': return this.clickHits(a) ? run() : undefined;
        case 'timer': {
          const at = a.timers.get(i);
          if (at === undefined || this.time < at) return;
          if (t.repeat === false) a.timers.delete(i);
          else a.timers.set(i, at + Math.max(0.01, toNum(t.seconds ?? 1)));
          return run();
        }
        case 'landed': return a.flags.landed ? run() : undefined;
        case 'hitWall': return a.flags.hitWall ? run() : undefined;
        case 'leftScene': return a.flags.leftScene ? run() : undefined;
        case 'animationEnd': return a.flags.animEnd !== null && (!t.animation || t.animation === a.flags.animEnd) ? run() : undefined;
        default: return;
      }
    });
  }

  private runSceneEvents(): void {
    this.scene.events.forEach((e, i) => {
      if (e.disabled) return;
      const t = e.trigger;
      const run = () => this.runEvent(e, {}, `scene ${this.scene.name}`);
      switch (t.type) {
        case 'update': return run();
        case 'keyPressed': return this.keyTrigger(this.input.pressed, t.key) ? run() : undefined;
        case 'keyDown': return this.keyTrigger(this.input.down, t.key) ? run() : undefined;
        case 'keyReleased': return this.keyTrigger(this.input.released, t.key) ? run() : undefined;
        case 'click': return this.input.clicks.length ? run() : undefined;
        case 'timer': {
          const at = this.sceneTimers.get(i);
          if (at === undefined || this.time < at) return;
          if (t.repeat === false) this.sceneTimers.delete(i);
          else this.sceneTimers.set(i, at + Math.max(0.01, toNum(t.seconds ?? 1)));
          return run();
        }
        default: return;
      }
    });
  }

  private runEvent(e: GameEvent, ctx: ExecCtx, where: string): void {
    if (this.depth > 8) return;
    this.depth++;
    try {
      for (const c of e.conditions) {
        if (!this.condition(withDefaults(c, CONDITION_MAP.get(c.type)), ctx)) return;
      }
      for (const act of e.actions) {
        try {
          this.action(withDefaults(act, ACTION_MAP.get(act.type)), ctx);
        } catch (err) {
          this.error(`${where} ${e.trigger.type} → ${act.type}`, err);
        }
        if (this.pendingScene) return;
      }
    } catch (err) {
      this.error(`${where} ${e.trigger.type}`, err);
    } finally {
      this.depth--;
    }
  }

  private eval(src: Value | undefined, ctx: ExecCtx): Value {
    if (src === undefined) return 0;
    return compile(src)(this.ctx(ctx));
  }

  private condition(c: EventStep, ctx: ExecCtx): boolean {
    const neg = c.not === true;
    switch (c.type) {
      case 'expr': return truthy(this.eval(c.expr, ctx));
      case 'keyDown': return this.keyTrigger(this.input.down, c.key);
      case 'onGround': return !!ctx.self && ctx.self.onGround !== neg;
      case 'overlaps': {
        if (!ctx.self) return false;
        const sb = ctx.self.box();
        const hit = this.actors.find((o) => o !== ctx.self && !o.destroyed && !o.type.hud && this.matchesWith(o, c.with) && overlap(sb, o.box()));
        if (hit && !neg) ctx.other = hit;
        return !!hit !== neg;
      }
      case 'chance': return this.random() * 100 < toNum(c.percent);
      case 'animation': return !!ctx.self && ctx.self.anim === c.animation;
      default: throw new Error(`unknown condition "${c.type}"`);
    }
  }

  private target(ctx: ExecCtx, which: Value | undefined): Actor | undefined {
    return which === 'other' ? ctx.other : ctx.self;
  }

  destroy(a: Actor): void {
    if (a.destroyed) return;
    a.destroyed = true;
    if (this.scene.persistent && a.sceneId) {
      const mem = this.memory.get(this.scene.name) ?? new Map();
      mem.set(a.sceneId, { destroyed: true });
      this.memory.set(this.scene.name, mem);
    }
    this.fireObject(a, 'destroyed');
    for (const c of [...a.components]) this.scripts.remove(c);
  }

  spawn(objectName: string, x: number, y: number, vx = 0, vy = 0): Actor | undefined {
    const type = this.objectMap.get(objectName);
    if (!type) throw new Error(`no object type "${objectName}"`);
    const a = this.makeActor(type, x, y);
    a.vx = vx;
    a.vy = vy;
    this.actors.push(a);
    if (this.started) this.onCreated(a);
    return a;
  }

  private action(s: EventStep, ctx: ExecCtx): void {
    switch (s.type) {
      case 'set':
      case 'add': {
        const path = parseTarget(String(s.target));
        const v = this.eval(s.value, ctx);
        if (s.type === 'set') this.assign(path, v, ctx);
        else {
          const cur = this.read(path, ctx);
          this.assign(path, typeof cur === 'string' ? cur + fmt(v) : toNum(cur) + toNum(v), ctx);
        }
        return;
      }
      case 'move': {
        const a = this.target(ctx, s.target);
        if (!a) return;
        const dx = toNum(this.eval(s.dx, ctx));
        const dy = toNum(this.eval(s.dy, ctx));
        if (this.moveAxis(a, dx, 'x')) a.flags.hitWall = true;
        if (this.moveAxis(a, dy, 'y')) a.flags.hitWall = true;
        return;
      }
      case 'setPosition': {
        const a = this.target(ctx, s.target);
        if (!a) return;
        a.x = toNum(this.eval(s.x, ctx));
        a.y = toNum(this.eval(s.y, ctx));
        return;
      }
      case 'setVelocity': {
        const a = this.target(ctx, s.target);
        if (!a) return;
        a.vx = toNum(this.eval(s.vx, ctx));
        a.vy = toNum(this.eval(s.vy, ctx));
        return;
      }
      case 'jump': {
        const a = this.target(ctx, s.target);
        if (!a) return;
        const strength = toNum(this.eval(s.strength, ctx)) || toNum(a.behavior('platformer')?.jump ?? 300);
        a.vy = -strength;
        a.onGround = false;
        a.coyote = 0;
        return;
      }
      case 'spawn': {
        const rel = s.relative !== false;
        const base = rel && ctx.self ? ctx.self : undefined;
        let x = toNum(this.eval(s.x, ctx));
        let y = toNum(this.eval(s.y, ctx));
        if (base) {
          x += base.x;
          y += base.y;
        }
        this.spawn(String(s.object), x, y, toNum(this.eval(s.vx, ctx)), toNum(this.eval(s.vy, ctx)));
        return;
      }
      case 'destroy': {
        const a = this.target(ctx, s.target);
        if (a) this.destroy(a);
        return;
      }
      case 'playAnimation': {
        const a = this.target(ctx, s.target);
        if (!a) return;
        const name = String(s.animation ?? '');
        a.anim = '';
        this.setAnim(a, name);
        const lock = toNum(s.lock);
        a.animLock = lock > 0 ? this.time + lock : a.asset?.tags.some((t) => t.name === name) ? Infinity : 0;
        return;
      }
      case 'flash': {
        const a = this.target(ctx, s.target);
        if (a) a.flashUntil = this.clock + toNum(s.seconds);
        return;
      }
      case 'gotoScene':
        this.gotoScene(String(s.scene), { fade: toNum(s.fade ?? 0) });
        return;
      case 'restartScene':
        this.restartScene({ fade: toNum(s.fade ?? 0) });
        return;
      case 'sound':
        this.opts.sound?.(String(s.sound), toNum(s.volume ?? 0.5));
        return;
      case 'shake':
        this.startShake(toNum(s.intensity), toNum(s.seconds));
        return;
      case 'say': {
        const text = fmt(this.eval(s.text, ctx));
        const secs = toNum(s.seconds);
        this.message = text ? { text, until: secs > 0 ? this.clock + secs : Infinity } : null;
        this.log(`say: ${text}`);
        return;
      }
      case 'emit':
        this.messages.push({ name: String(s.message), data: undefined });
        return;
      case 'call': {
        const name = String(s.function ?? '');
        const fn = this.scripts.functions.get(name);
        if (!fn) throw new Error(`no script function "${name}"`);
        const arg = s.arg === undefined || s.arg === '' ? undefined : this.eval(s.arg, ctx);
        this.scripts.run(`func ${name}`, fn, this.scripts.handle(ctx.self), this.scripts.handle(ctx.other), arg);
        return;
      }
      case 'callMethod': {
        const method = String(s.method ?? '');
        if (!method) throw new Error('no method name');
        const comp = String(s.component ?? '') || undefined;
        const a = this.target(ctx, s.target);
        const list = (a ? this.scripts.componentsOf(a, comp) : this.scripts.findAll(comp).filter((c) => !componentState(c)?.actor)).filter((c) => typeof (c as unknown as Record<string, unknown>)[method] === 'function');
        if (!list.length) throw new Error(`no component${comp ? ` "${comp}"` : ''} with a method "${method}"${a ? ` on ${a.type.name}` : ' in the scene or game'}`);
        const arg = s.arg === undefined || s.arg === '' ? undefined : this.eval(s.arg, ctx);
        for (const c of list) this.scripts.invoke(c, method, arg, this.scripts.handle(ctx.other));
        return;
      }
      case 'dialogue':
        void this.startDialogue(String(s.dialogue ?? ''), ctx.self, ctx.other ?? this.actors.find((a) => !a.destroyed && a.behaviors.some((b) => (b.type === 'topdown' || b.type === 'platformer') && b.controls !== false)));
        return;
      case 'talk':
        void this.scripts.openDialog(fmt(this.eval(s.text, ctx)), { speaker: String(s.speaker ?? '') });
        return;
      case 'lockControls':
        this.controlsLocked = s.locked !== false;
        return;
      case 'save': {
        const k = String(s.var);
        this.opts.storage?.set(k, JSON.stringify(this.globals[k] ?? 0));
        return;
      }
      case 'log':
        this.log(fmt(this.eval(s.value, ctx)));
        return;
      default:
        throw new Error(`unknown action "${s.type}"`);
    }
  }

  // ------------------------------------------------------------------ variables

  private actorField(a: Actor, name: string): Value | undefined {
    switch (name) {
      case 'x': return a.x;
      case 'y': return a.y;
      case 'vx': return a.vx;
      case 'vy': return a.vy;
      case 'width': return a.box().w;
      case 'height': return a.box().h;
      case 'centerX': { const b = a.box(); return b.x + b.w / 2; }
      case 'centerY': { const b = a.box(); return b.y + b.h / 2; }
      case 'flipX': return a.flipX;
      case 'visible': return a.visible;
      case 'opacity': return a.opacity;
      case 'angle': return a.angle;
      case 'onGround': return a.onGround;
      case 'animation': return a.anim;
      case 'object': return a.type.name;
      case 'name': return this.displayName(a);
      case 'text': return a.textOverride ?? '';
      case 'id': return a.id;
      case 'age': return this.time - a.createdAt;
      case 'facing': return a.facing;
      default: return a.vars[name];
    }
  }

  private setActorField(a: Actor, name: string, v: Value): void {
    switch (name) {
      case 'x': a.x = toNum(v); return;
      case 'y': a.y = toNum(v); return;
      case 'vx': a.vx = toNum(v); return;
      case 'vy': a.vy = toNum(v); return;
      case 'flipX': a.flipX = truthy(v); return;
      case 'visible': a.visible = truthy(v); return;
      case 'opacity': a.opacity = Math.max(0, Math.min(1, toNum(v))); return;
      case 'angle': a.angle = toNum(v); return;
      case 'z': a.z = toNum(v); return;
      case 'text': a.textOverride = fmt(v); a.vars.__autoText = false; return;
      default: a.vars[name] = v;
    }
  }

  read(path: string[], ctx: ExecCtx): Value | undefined {
    const [head, field] = path;
    if ((head === 'self' || head === 'other') && path.length === 2) {
      const a = head === 'self' ? ctx.self : ctx.other;
      return a ? this.actorField(a, field) : undefined;
    }
    if (head === 'scene' && path.length === 2) {
      if (field in this.sceneVars) return this.sceneVars[field];
      if (field === 'name') return this.scene.name;
      if (field === 'width') return this.widthPx;
      if (field === 'height') return this.heightPx;
      return undefined;
    }
    if (head === 'game' && path.length === 2) {
      switch (field) {
        case 'time': return this.time;
        case 'dt': return STEP;
        case 'frame': return this.frame;
        case 'width': return this.game.width;
        case 'height': return this.game.height;
        case 'mouseX': return this.input.pointer ? this.input.pointer[0] + this.camera.x : 0;
        case 'mouseY': return this.input.pointer ? this.input.pointer[1] + this.camera.y : 0;
        default: return undefined;
      }
    }
    if (head === 'camera' && path.length === 2) return field === 'x' ? this.camera.x : field === 'y' ? this.camera.y : undefined;
    if (path.length === 1) return head in this.globals ? this.globals[head] : this.sceneVars[head];
    return undefined;
  }

  private assign(path: string[], v: Value, ctx: ExecCtx): void {
    const [head, field] = path;
    if ((head === 'self' || head === 'other') && path.length === 2) {
      const a = head === 'self' ? ctx.self : ctx.other;
      if (!a) throw new Error(`no "${head}" here`);
      this.setActorField(a, field, v);
      return;
    }
    if (head === 'scene' && path.length === 2) {
      this.sceneVars[field] = v;
      return;
    }
    if (head === 'camera' && path.length === 2) {
      if (field === 'x') this.camera.x = toNum(v);
      if (field === 'y') this.camera.y = toNum(v);
      return;
    }
    if (path.length === 1) {
      if (!(head in this.globals) && head in this.sceneVars) this.sceneVars[head] = v;
      else this.globals[head] = v;
      return;
    }
    throw new Error(`cannot assign "${path.join('.')}"`);
  }

  nearest(from: Actor, objectName: string): Actor | undefined {
    let best: Actor | undefined;
    let bd = Infinity;
    for (const o of this.actors) {
      if (o === from || o.destroyed || o.type.name !== objectName) continue;
      const d = Math.hypot(o.x - from.x, o.y - from.y);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private ctx(c: ExecCtx): ExprContext {
    return {
      get: (path) => this.read(path, c),
      call: (name, args) => {
        const m = MATH_FUNCTIONS[name];
        if (m) return m(args.map(toNum), () => this.random());
        switch (name) {
          case 'count': return this.actors.filter((a) => !a.destroyed && a.type.name === String(args[0])).length;
          case 'exists': return this.actors.some((a) => !a.destroyed && a.type.name === String(args[0]));
          case 'keyDown': return this.input.down.has(String(args[0]));
          case 'keyPressed': return this.input.pressed.has(String(args[0]));
          case 'nearest': {
            if (!c.self) return 0;
            const n = this.nearest(c.self, String(args[0]));
            return n ? (this.actorField(n, String(args[1] ?? 'x')) ?? 0) : 0;
          }
          case 'str': return fmt(args[0]);
          case 'num': return toNum(args[0]);
          case 'pad': return fmt(args[0]).padStart(toNum(args[1]) || 0, String(args[2] ?? '0'));
          default: throw new Error(`unknown function ${name}()`);
        }
      },
    };
  }

  // ------------------------------------------------------------------ inspection

  /** Compact description of the running state, for playtest reports. */
  snapshot(): { scene: string; time: number; globals: Record<string, Value>; sceneVars: Record<string, Value>; actors: { id: number; object: string; name?: string; x: number; y: number; vx: number; vy: number; onGround: boolean; animation: string; vars: Record<string, Value> }[] } {
    return {
      scene: this.scene.name,
      time: Math.round(this.time * 100) / 100,
      globals: { ...this.globals },
      sceneVars: { ...this.sceneVars },
      actors: this.actors.map((a) => ({
        id: a.id,
        object: a.type.name,
        ...(a.instName ? { name: a.instName } : {}),
        x: Math.round(a.x * 10) / 10,
        y: Math.round(a.y * 10) / 10,
        vx: Math.round(a.vx),
        vy: Math.round(a.vy),
        onGround: a.onGround,
        animation: a.anim,
        vars: Object.fromEntries(Object.entries(a.vars).filter(([k]) => !k.startsWith('__'))),
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering (renderer-agnostic)

export interface Renderer {
  clear(color: string): void;
  /** Draws part of a sprite's spritesheet. */
  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, opts: { flipX: boolean; opacity: number; angle: number; scale?: number }): void;
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
  text(text: string, x: number, y: number, color: string, scale: number): void;
}

/** Draws the current world state with the camera applied. Coordinates are viewport pixels. */
export function renderWorld(w: World, r: Renderer): void {
  const scene = w.scene;
  const vw = w.game.width;
  const vh = w.game.height;
  r.clear(scene.background || w.game.background);
  let camX = w.camera.x;
  let camY = w.camera.y;
  if (w.clock < w.shake.until) {
    // Fades out over its duration.
    const k = w.shake.intensity * Math.min(1, (w.shake.until - w.clock) / Math.max(0.01, w.shake.duration));
    camX += (Math.random() * 2 - 1) * k;
    camY += (Math.random() * 2 - 1) * k;
  }
  camX = Math.round(camX);
  camY = Math.round(camY);

  for (const bg of scene.backgrounds) {
    const asset = w.bundle.sprites[bg.sprite];
    if (!asset || !asset.frames.length) continue;
    const f = asset.frames[0];
    const ox = Math.round(-camX * bg.parallax);
    const oy = Math.round(bg.y - camY * bg.parallax);
    if (bg.repeatX) {
      let start = ox % f.w;
      if (start > 0) start -= f.w;
      for (let x = start; x < vw; x += f.w) r.image(bg.sprite, f.x, f.y, f.w, f.h, x, oy, { flipX: false, opacity: 1, angle: 0 });
    } else r.image(bg.sprite, f.x, f.y, f.w, f.h, ox, oy, { flipX: false, opacity: 1, angle: 0 });
  }

  type Item = { z: number; order: number; draw: () => void };
  const items: Item[] = [];
  const ts = scene.tileSize;
  const tileset = scene.tileset ? w.bundle.sprites[scene.tileset] : undefined;
  scene.layers.forEach((layer, li) => {
    if (!layer.visible || !tileset || !tileset.frames.length) return;
    const grid = tileset.grid ?? { width: ts, height: ts };
    const tcols = Math.max(1, Math.floor(tileset.width / grid.width));
    const f0 = tileset.frames[0];
    const par = layer.parallax ?? 1;
    items.push({
      z: layer.z ?? li - 10,
      order: li,
      draw: () => {
        const lx = Math.round(camX * par);
        const ly = Math.round(camY * par);
        const x0 = Math.max(0, Math.floor(lx / ts));
        const y0 = Math.max(0, Math.floor(ly / ts));
        const x1 = Math.min(scene.cols - 1, Math.floor((lx + vw) / ts));
        const y1 = Math.min(scene.rows - 1, Math.floor((ly + vh) / ts));
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const t = layer.tiles[ty * scene.cols + tx];
            if (t < 0) continue;
            const sx = f0.x + (t % tcols) * grid.width;
            const sy = f0.y + Math.floor(t / tcols) * grid.height;
            r.image(tileset.name, sx, sy, grid.width, grid.height, tx * ts - lx, ty * ts - ly, { flipX: false, opacity: 1, angle: 0 });
          }
        }
      },
    });
  });

  const hud: Actor[] = [];
  w.actors.forEach((a, i) => {
    if (a.type.hud) {
      hud.push(a);
      return;
    }
    // y-sort: within the same z, instances lower on screen are drawn in front (top-down / RPG depth).
    const order = scene.ySort ? 1000 + a.box().y + a.box().h + i / 10000 : 1000 + i;
    items.push({ z: a.z, order, draw: () => drawActor(w, r, a, camX, camY) });
  });
  items.sort((p, q) => p.z - q.z || p.order - q.order);
  for (const it of items) it.draw();
  hud.sort((p, q) => p.z - q.z);
  for (const a of hud) drawActor(w, r, a, 0, 0);
  w.scripts.draw(r, camX, camY);

  if (w.message && w.clock < w.message.until) {
    const m = measureText(w.message.text);
    const s = m.width * 2 + 16 <= vw ? 2 : 1;
    const bw = m.width * s + 12;
    const bh = m.height * s + 12;
    const bx = Math.round((vw - bw) / 2);
    const by = Math.round(vh - bh - 8);
    r.rect(bx, by, bw, bh, '#000000', 0.75);
    r.rect(bx, by, bw, 1, '#ffffff', 0.5);
    r.rect(bx, by + bh - 1, bw, 1, '#ffffff', 0.5);
    r.text(w.message.text, bx + 6, by + 6, '#ffffff', s);
  }
  const fa = w.fadeAlpha;
  if (fa > 0) r.rect(0, 0, vw, vh, w.fade.color, fa);
  drawDialog(w, r);
}

/** RPG-style dialog box with typewriter text, speaker name, portrait and choices. */
function drawDialog(w: World, r: Renderer): void {
  const d = w.scripts.dialog;
  if (!d) return;
  const vw = w.game.width;
  const vh = w.game.height;
  const portrait = d.portrait ? w.bundle.sprites[d.portrait] : undefined;
  const pad = 6;
  const pw = portrait ? Math.min(portrait.width, 48) + pad : 0;
  const cols = Math.max(8, Math.floor((vw - 16 - pad * 2 - pw) / 4));
  const lines = wrapText(d.text, cols);
  const textH = Math.max(3, lines.length) * 6;
  const bh = Math.max(textH, portrait ? Math.min(portrait.height, 48) : 0) + pad * 2;
  const bx = 6;
  const bw = vw - 12;
  const by = vh - bh - 6;
  const frame = (x: number, y: number, ww: number, hh: number) => {
    r.rect(x, y, ww, hh, '#1a1c2c', 0.92);
    r.rect(x, y, ww, 1, '#f4f4f4');
    r.rect(x, y + hh - 1, ww, 1, '#f4f4f4');
    r.rect(x, y, 1, hh, '#f4f4f4');
    r.rect(x + ww - 1, y, 1, hh, '#f4f4f4');
  };
  frame(bx, by, bw, bh);
  if (portrait && portrait.frames.length) {
    const f = portrait.frames[0];
    r.image(portrait.name, f.x, f.y, Math.min(f.w, 48), Math.min(f.h, 48), bx + pad, by + pad, { flipX: false, opacity: 1, angle: 0 });
  }
  if (d.speaker) {
    const sw = d.speaker.length * 4 + 7;
    frame(bx + 4, by - 9, sw, 11);
    r.text(d.speaker, bx + 8, by - 6, '#ffcd75', 1);
  }
  let left = Math.floor(d.shown);
  lines.forEach((line, i) => {
    if (left <= 0) return;
    const part = line.slice(0, left);
    left -= line.length + 1;
    r.text(part, bx + pad + pw, by + pad + i * 6, '#f4f4f4', 1);
  });
  const done = d.shown >= d.text.length;
  if (done && d.choices) {
    const cw = Math.max(...d.choices.map((c) => c.length)) * 4 + 18;
    const ch = d.choices.length * 8 + 8;
    const cx = vw - cw - 8;
    const cy = by - ch - (d.speaker ? 11 : 3);
    frame(cx, cy, cw, ch);
    d.choices.forEach((c, i) => {
      if (i === d.selected) r.text('>', cx + 4, cy + 5 + i * 8, '#ffcd75', 1);
      r.text(c, cx + 11, cy + 5 + i * 8, i === d.selected ? '#ffcd75' : '#f4f4f4', 1);
    });
  } else if (done && Math.floor(w.clock * 3) % 2 === 0) {
    r.rect(bx + bw - 9, by + bh - 7, 3, 2, '#f4f4f4');
    r.rect(bx + bw - 8, by + bh - 5, 1, 1, '#f4f4f4');
  }
}

function drawActor(w: World, r: Renderer, a: Actor, camX: number, camY: number): void {
  if (!a.visible || a.destroyed) return;
  if (a.flashUntil > w.clock && Math.floor(w.clock * 12) % 2 === 0) return;
  const x = Math.round(a.x - camX);
  const y = Math.round(a.y - camY);
  if (a.asset && a.asset.frames.length) {
    const f = a.asset.frames[a.frameIndex()] ?? a.asset.frames[0];
    if (x + f.w < -8 || y + f.h < -8 || x > w.game.width + 8 || y > w.game.height + 8) return;
    r.image(a.asset.name, f.x, f.y, f.w, f.h, x, y, { flipX: a.flipX, opacity: a.opacity, angle: a.angle });
  }
  if (a.type.text !== undefined && a.textOverride) {
    const s = a.type.textSize ?? 1;
    const color = a.type.textColor ?? '#ffffff';
    // 1px drop shadow keeps HUD text readable on any background.
    r.text(a.textOverride, x + s, y + s, '#000000', s);
    r.text(a.textOverride, x, y, color, s);
  }
}

// ---------------------------------------------------------------------------
// Headless playtest

export interface PlaytestInput {
  /** Seconds from start. */
  at: number;
  /** Logical key to hold. */
  key?: string;
  /** How long to hold it (default 0.1 = a tap). */
  duration?: number;
  /** Click at viewport pixel [x, y]. */
  click?: [number, number];
}

export interface PlaytestResult {
  seconds: number;
  logs: string[];
  final: ReturnType<World['snapshot']>;
  /** Snapshots taken at the requested times. */
  samples: ReturnType<World['snapshot']>[];
  world: World;
}

export interface PlaytestOptions {
  seconds: number;
  inputs?: PlaytestInput[];
  scene?: string;
  seed?: number;
  sampleAt?: number[];
  onSample?: (w: World) => void;
  /** Answers for dialog menus, in order (default: first entry). */
  choices?: number[];
  /** Confirm dialogs automatically (default true). Set false to drive them with "action" inputs. */
  autoDialog?: boolean;
  evaluator?: EngineOptions['evaluator'];
}

/** Runs the game headless. Async so script continuations (await say/wait...) run between frames. */
export async function runPlaytest(bundle: GameBundle, opts: PlaytestOptions): Promise<PlaytestResult> {
  const world = new World(bundle, {
    seed: opts.seed,
    scene: opts.scene,
    evaluator: opts.evaluator,
    autoDialog: opts.autoDialog === false ? undefined : { choices: [...(opts.choices ?? [])], delay: 0.4 },
  });
  const inputs = opts.inputs ?? [];
  const frames = Math.round(Math.min(600, Math.max(0, opts.seconds)) / STEP);
  const samples: PlaytestResult['samples'] = [];
  const sampleFrames = new Set((opts.sampleAt ?? []).map((s) => Math.round(s / STEP)));
  let prev = new Set<string>();
  for (let f = 0; f < frames; f++) {
    const t = f * STEP;
    const down = new Set<string>();
    const clicks: [number, number][] = [];
    for (const i of inputs) {
      if (i.key && t >= i.at && t < i.at + (i.duration ?? 0.1)) down.add(i.key);
      if (i.click && Math.round(i.at / STEP) === f) clicks.push(i.click);
    }
    const pressed = new Set([...down].filter((k) => !prev.has(k)));
    const released = new Set([...prev].filter((k) => !down.has(k)));
    world.step({ down, pressed, released, clicks, pointer: clicks[0] ?? null });
    await world.settle();
    prev = down;
    if (sampleFrames.has(f + 1)) {
      samples.push(world.snapshot());
      opts.onSample?.(world);
    }
  }
  return { seconds: frames * STEP, logs: world.logs, final: world.snapshot(), samples, world };
}
