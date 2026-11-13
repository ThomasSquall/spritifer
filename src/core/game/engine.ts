/**
 * The Spritifer game engine: a deterministic, renderer-agnostic simulation of a GameBundle.
 * The browser player (src/runtime) feeds it input and draws it on a canvas; the server runs it
 * headless for playtests and renders it to bitmaps for previews.
 */

import { ACTION_MAP, BEHAVIOR_MAP, CONDITION_MAP, TRIGGER_MAP, withDefaults } from './catalog.js';
import { type ExprContext, MATH_FUNCTIONS, compile, fmt, parseTarget, toNum, truthy } from './expr.js';
import { BUILTIN_FONT, type PixelFont, gameFont, measureText } from './font.js';
import { type FineSolid, decodeFineSolid, fineSolidAt, fineSolidRects } from './fineSolid.js';
import { type Behavior, type ComponentOverrides, type DataRow, type DataTable, type EventStep, type GameBundle, type GameEvent, type GameProject, type Hitbox, type Instance, type LightDef, type ObjectType, type Scene, type SpriteAsset, type Value, cellValue, hitboxOf } from './types.js';
import { type Behaviour, type ScriptEvaluator, ScriptHost, componentState, fieldsOf, scaledRenderer, wrapText } from './script.js';
import { type DialogueBook, buildDialogueBook, runDialogue } from './dialogue.js';
import { resolveObjectTypes } from './variants.js';
import { ParticleSystem } from './particles.js';
import { type VfxAnchor, type VfxPoint, VfxSystem } from './vfx.js';
import { TileResolver, tilesetFrame } from './tilerules.js';
import { type CastShape, MoteField, type ScreenLight, collectLights, drawClouds, drawShadows, postProcess } from './atmosphere.js';
import { type HdFrame, type HdJut, resolveHd } from './hd.js';
import { type HdShape, type WallCell, findWalls } from './hd3d.js';
import { RainField, drawShafts } from './weather.js';
import { type ReflectionBand, type WaterMap, type WaterPiece, type WaterSheet, addWaterActors, drawReflections, findWater, reflectionZ, waterDecals, waterPieces } from './reflections.js';
import { type Walker, pushTarget, stepPush, swayBands, swayBase } from './wind.js';
import type { ResolvedRelief } from './relief.js';

export const STEP = 1 / 60;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

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
  /** Plays a sound effect: a built-in synth sound or an audio file name. */
  sound?: (name: string, volume: number) => void;
  /** Music commands for the player (crossfades and volumes are its job). */
  music?: (cmd: MusicCommand) => void;
  /** The player's 2D-HD switch (headless runs have none). */
  hd?: { get(): boolean; set(on: boolean): void };
  log?: (message: string) => void;
  /** Start in this scene instead of game.startScene. */
  scene?: string;
  /** How scripts are evaluated (the server uses node:vm). */
  evaluator?: ScriptEvaluator;
  /** Global variables that override the game's initial values (playtests of later stages). */
  vars?: Record<string, Value>;
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
  /** Stops on the last frame of the animation instead of looping (dialogue poses). */
  holdLast = false;
  flipX = false;
  visible = true;
  opacity = 1;
  angle = 0;
  z: number;
  onGround = false;
  destroyed = false;
  textOverride: string | null = null;
  /** The game's font, for sizing text objects. */
  font: PixelFont = BUILTIN_FONT;
  flashUntil = 0;
  /** How far a walker has pushed this plant aside, and how fast it is moving back. */
  swayPush = 0;
  swayPushV = 0;
  /** Where its feet were last, and when they last moved (plants only react to who is passing). */
  footX = NaN;
  footY = NaN;
  movedAt = -Infinity;
  /** Light it gives off (object type's, or the instance's override). */
  light: LightDef | undefined;
  createdAt: number;
  facing: 'down' | 'up' | 'left' | 'right' = 'down';
  /** Name given to the placed instance (hierarchy / dialogue speaker). */
  instName: string | null = null;
  /** Instances touched last frame (for "collision" = start of touch). */
  touching = new Set<Actor>();
  /** One-frame trigger flags. */
  flags = { landed: false, hitWall: false, leftScene: false, animEnd: '' as string | null, animEvents: [] as string[] };
  /** Animation + position of the last frame whose events fired. */
  lastFrameKey = '';
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
  /** The instance's own say on lying down or standing up in the 2D-HD perspective. */
  hdPose?: 'flat' | 'stand' | 'wall';
  /** Its own collision box, from the placed instance (over the object type's). */
  instHitbox?: Hitbox;
  /** Height above the ground of a flat instance in 2D-HD (a wall top), from the placed instance. */
  hdLift?: number;
  /** Where the picture meets the ground, from the placed instance (see Instance.footLine). */
  footLine?: [number, number][];

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
    this.tags = new Set(type.tags ?? []);
    this.light = type.light;
  }

  /** Group tags of the object type (+ the instance's own). */
  tags: Set<string>;

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
    const declared = hitboxOf(this, this.type);
    if (declared) {
      const hb = declared;
      // Mirror the hitbox with the sprite.
      return this.flipX && this.asset ? { x: this.asset.width - hb.x - hb.w, y: hb.y, w: hb.w, h: hb.h } : hb;
    }
    if (!this.asset && this.type.text !== undefined) {
      const m = measureText(this.textOverride ?? '', this.font);
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

type MemoryEntry = { destroyed?: boolean; x?: number; y?: number; vars?: Record<string, Value>; flipX?: boolean; facing?: Actor['facing']; anim?: string; comps?: Record<string, Record<string, Value>> };

export interface SaveSummary {
  slot: string;
  scene: string;
  savedAt: number;
  title: string;
}

export interface SaveData extends SaveSummary {
  format: 'spritifer-save';
  version: 1;
  globals: Record<string, Value>;
  sceneVars: Record<string, Value>;
  memory: Record<string, Record<string, MemoryEntry>>;
  current: Record<string, MemoryEntry>;
  gameComponents: { name: string; fields: Record<string, Value> }[];
}

export type MusicCommand =
  | { type: 'play'; name: string; volume: number; loop: boolean; fade: number }
  | { type: 'stop'; fade: number }
  | { type: 'ambience'; layers: { name: string; volume: number }[]; fade: number }
  | { type: 'volume'; channel: 'music' | 'sfx'; value: number };

export interface QueryFilter {
  tag?: string;
  object?: string;
  ignore?: Actor[];
}

export interface RayHit {
  /** 0..1 along the segment. */
  t: number;
  x: number;
  y: number;
  distance: number;
  normalX: number;
  normalY: number;
  actor: Actor | null;
  tile: boolean;
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
  /**
   * How fast the game runs: 2 = twice as fast. The player and the playtest run this many steps per frame of real time,
   * so everything that moves with the steps (clock, wait, timers, tweens, vfx, animations, particles) follows it.
   * Back to 1 when the scene changes.
   */
  timeScale = 1;
  /** Top-left of the view in world pixels; zoom > 1 shows less of the world, bigger. */
  camera = { x: 0, y: 0, zoom: 1 };
  /** What the camera followed in the last update: drawing keeps it on a steady screen pixel. */
  cameraHeld: Actor | null = null;
  /** Scripts: limit the camera to a rectangle (a room) instead of the scene. */
  cameraBounds: Rect | null = null;
  /** Scripts: the instance the camera follows (undefined = the one with the Camera behavior, null = none). */
  cameraTarget: Actor | null | undefined = undefined;
  /** Visual particles (world space). */
  readonly particles = new ParticleSystem(() => this.random());
  /** Visual effect graphs playing now (vfx/). Reports to the game through this host. */
  readonly vfx = new VfxSystem({
    asset: (name) => this.bundle.sprites[name],
    sound: (name, volume) => this.opts.sound?.(name, volume),
    shake: (intensity, seconds) => this.startShake(intensity, seconds),
    hitstop: (seconds) => this.hitstop(seconds),
    message: (message, data) => this.emit(message, data),
    log: (message) => this.log(message),
  });
  /** Hit stop: the game holds still until this clock time, effects keep playing. */
  private hitstopUntil = 0;
  private hitstopFrom = 0;
  /** Ambient floating particles of the scene atmosphere (own random: gameplay stays deterministic). */
  readonly motes = new MoteField();
  readonly motes2 = new MoteField();
  private motes2For: unknown = null;
  readonly rain = new RainField();
  private rainFor: unknown = null;
  /** The water of the current scene (found when first needed). */
  private water: { scene: unknown; map: WaterMap } | null = null;
  private walls: { scene: unknown; rows: number; cells: (WallCell | null)[] } | null = null;
  /** The scene's own looping sounds (spatial ones are added to these), and what was last sent to the player. */
  private ambienceBase: { name: string; volume: number }[] = [];
  private ambienceSent = '[]';
  private resolvers = new Map<string, TileResolver>();
  /** Tile rules of a tileset (autotiling, textures, overlays). */
  tileResolver(tileset: string): TileResolver {
    let r = this.resolvers.get(tileset);
    if (!r) this.resolvers.set(tileset, (r = new TileResolver(this.game.tilesets?.[tileset])));
    return r;
  }
  private motesFor: unknown = null;
  /** Smoothed look-ahead offset of the camera (px). */
  private lookX = 0;
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
  private lineage = new Map<string, string[]>();

  /** Is the instance of this object type, or of a variant of it? */
  isA(a: Actor, objectName: string): boolean {
    return a.type.name === objectName || (this.lineage.get(a.type.name)?.includes(objectName) ?? false);
  }
  private errors = new Set<string>();
  /** Placed instances of the current scene whose activeIf is false right now (not destroyed: they can come back). */
  private dormant = new Set<string>();
  /** Data tables (data/<name>.json) by name. */
  readonly data: Record<string, DataTable>;
  private solidLayers: number[][] = [];
  /** The scene's fine collision (cells smaller than a tile), if it has one. */
  fine: FineSolid | null = null;
  private started = false;
  private gameStarted = false;
  /** Per persistent scene: what happened to each placed instance. */
  private memory = new Map<string, Map<string, MemoryEntry>>();
  /** Instance states to use for the next loadScene (a loaded save), whatever the scene's persistence. */
  private forcedMemory: Map<string, MemoryEntry> | null = null;
  /** A save to apply at the end of the frame. */
  private pendingLoad: SaveData | null = null;
  /** Saves when there is no storage (headless playtests). */
  private saveStore = new Map<string, string>();
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
  /** Pause menus: the game stands still (clock, movement, timers); onDraw and pausedUpdate keep running. */
  paused = false;
  /** The music playing ("" = none). */
  music = '';
  volumes = { music: 1, sfx: 1 };
  /** Auto 2D-HD on or off for this player. */
  get hd(): boolean { return !!this.opts.hd?.get(); }
  set hd(on: boolean) { this.opts.hd?.set(!!on); }

  private actionsDown = new Set<string>();

  /** Adds the game's input actions to the frame's keys (an action named like a built-in key replaces it). */
  private mapActions(input: InputFrame): InputFrame {
    const actions = this.game.actions;
    if (!actions) return input;
    const down = new Set(input.down);
    const pressed = new Set(input.pressed);
    const released = new Set(input.released);
    const now = new Set<string>();
    for (const [name, keys] of Object.entries(actions)) {
      down.delete(name);
      pressed.delete(name);
      released.delete(name);
      if (keys.some((k) => input.down.has(k) || input.pressed.has(k))) {
        down.add(name);
        now.add(name);
        if (!this.actionsDown.has(name)) pressed.add(name);
      } else if (this.actionsDown.has(name)) released.add(name);
    }
    this.actionsDown = now;
    return { ...input, down, pressed, released };
  }

  /** Plays a music track (same track: keeps playing). Unknown names are reported. */
  playMusic(name: string, opts: { volume?: number; loop?: boolean; fade?: number } = {}): void {
    const n = String(name);
    if (!n || n === '-') return this.stopMusic(opts.fade);
    if (this.bundle.audio && !(n in this.bundle.audio)) throw new Error(`no audio "${n}" (import it in the Game tab, audio/ folder)`);
    if (n === this.music) return;
    this.music = n;
    this.log(`music: ${n}`);
    this.opts.music?.({ type: 'play', name: n, volume: opts.volume ?? 0.6, loop: opts.loop !== false, fade: opts.fade ?? 1 });
  }

  /** Holds everything still for an instant: the weight of a blow. */
  hitstop(seconds: number): void {
    if (this.clock >= this.hitstopUntil) this.hitstopFrom = this.clock;
    this.hitstopUntil = Math.max(this.hitstopUntil, this.clock + Math.max(0, Number(seconds) || 0));
  }

  /** Sets timeScale (0.1..4; anything else becomes 1). */
  setTimeScale(scale: number): void {
    const s = Number(scale);
    this.timeScale = Number.isFinite(s) && s > 0 ? Math.max(0.1, Math.min(4, s)) : 1;
  }

  /** The clock animations follow: it stands still during a hit stop. */
  get animClock(): number {
    return this.clock < this.hitstopUntil ? this.hitstopFrom : this.clock;
  }

  /** Where the water of this scene is. */
  /** Is something hung on the wall in front of this stretch of it? */
  private hangsOver(jut: HdJut, cells: readonly (WallCell | null)[]): boolean {
    const s = this.scene;
    const ts = s.tileSize;
    return this.actors.some((a) => {
      if (a.destroyed || a.type.hud || !a.asset) return false;
      const b = a.box();
      const tx = Math.floor((b.x + b.w / 2) / ts);
      const ty = Math.floor((b.y + b.h - 1) / ts);
      if (tx < 0 || ty < 0 || tx >= s.cols || ty >= s.rows) return false;
      const cell = cells[ty * s.cols + tx];
      if (!cell || !('face' in cell) || ty + cell.face !== jut.foot) return false;
      const left = a.x + (a.type.spriteOffset?.x ?? 0);
      return left < jut.x + jut.w && left + a.asset.width > jut.x;
    });
  }

  /** Which cells of the map stand up in the 2D-HD perspective. */
  wallMap(rows: number): (WallCell | null)[] {
    if (this.walls?.scene !== this.scene || this.walls.rows !== rows) {
      const s = this.scene;
      const build = (juts?: readonly HdJut[]) => findWalls(s.layers, s.cols, s.rows, this.tileResolver(s.tileset ?? ''), rows, s.hdCells, this.waterMap()?.grid, juts, s.tileSize);
      const plain = build();
      // What hangs on a wall hides the pier behind it: the pier mustn't stand out through it.
      const juts = s.hdJuts?.filter((j) => !this.hangsOver(j, plain));
      this.walls = { scene: s, rows, cells: juts?.length ? build(juts) : plain };
    }
    return this.walls.cells;
  }

  waterMap(): WaterMap | null {
    const cfg = this.scene.atmosphere?.reflections;
    if (!cfg) return null;
    if (this.water?.scene !== this.scene) {
      const map = findWater(this.scene.layers, this.scene.cols, this.scene.rows, this.tileResolver(this.scene.tileset ?? ''));
      addWaterActors(map, this.actors, cfg.sprites ?? [], this.scene.tileSize);
      this.water = { scene: this.scene, map };
    }
    return this.water.map;
  }

  /** The sounds that loop now, replacing the scene's ones: names or { sound, volume }. An empty list is silence. */
  setAmbience(list: readonly (string | { sound: string; volume?: number })[], fade = 1.5): void {
    this.ambienceBase = list.map((l) => (typeof l === 'string' ? { name: l, volume: 0.4 } : { name: l.sound, volume: l.volume ?? 0.4 }));
    for (const l of this.ambienceBase) if (this.bundle.audio && !(l.name in this.bundle.audio)) throw new Error(`no audio "${l.name}" (import it in the Game tab, audio/ folder)`);
    this.sendAmbience(fade);
  }

  /** Sends the loops to the player when something changed: the scene's, plus the nearby objects that sound. */
  private sendAmbience(fade: number): void {
    const levels = new Map(this.ambienceBase.map((l) => [l.name, l.volume]));
    const cx = this.camera.x + this.viewWidth / 2;
    const cy = this.camera.y + this.viewHeight / 2;
    for (const a of this.actors) {
      const s = a.type.ambientSound;
      if (!s || a.destroyed || !a.visible) continue;
      const near = 1 - Math.hypot(a.x - cx, a.y - cy) / (s.radius ?? 160);
      if (near > 0) levels.set(s.sound, Math.max(levels.get(s.sound) ?? 0, (s.volume ?? 0.4) * near ** 1.5));
    }
    const layers = [...levels].filter(([name, volume]) => volume >= 0.01 && (!this.bundle.audio || name in this.bundle.audio)).map(([name, volume]) => ({ name, volume: Math.round(volume * 50) / 50 }));
    const key = JSON.stringify(layers);
    if (key === this.ambienceSent) return;
    this.ambienceSent = key;
    this.opts.music?.({ type: 'ambience', layers, fade });
  }

  /** Plants lean away from whoever is walking through them, then spring back. */
  private stepFoliage(dt: number): void {
    const plants: Actor[] = [];
    const walkers: Walker[] = [];
    const left = this.camera.x - 48;
    const top = this.camera.y - 48;
    const right = this.camera.x + this.viewWidth + 48;
    const bottom = this.camera.y + this.viewHeight + 48;
    for (const a of this.actors) {
      if (a.destroyed || a.type.hud) continue;
      if (a.type.sway?.react) {
        if (a.x > left && a.x < right && a.y > top && a.y < bottom) plants.push(a);
        continue;
      }
      // No contact shadow: rugs, decals and small flying things, which don't touch the plants.
      if (a.type.shadow === 0 || !a.asset || a.type.sway) continue;
      if (Number.isNaN(a.footX)) {
        a.footX = a.x;
        a.footY = a.y;
        continue;
      }
      const vx = a.x - a.footX;
      if (vx !== 0 || a.y !== a.footY) a.movedAt = this.clock;
      a.footX = a.x;
      a.footY = a.y;
      if (this.clock - a.movedAt < 0.6) {
        const b = a.box();
        walkers.push({ x: b.x + b.w / 2, y: b.y + b.h, vx });
      }
    }
    for (const p of plants) {
      const b = p.box();
      const target = p.visible ? pushTarget(b.x + b.w / 2, b.y + b.h, b.w / 2 + 9, p.type.sway!.react!, walkers) : 0;
      if (target || p.swayPush || p.swayPushV) stepPush(p, target, dt);
    }
  }

  stopMusic(fade = 1): void {
    if (!this.music) return;
    this.music = '';
    this.log('music stopped');
    this.opts.music?.({ type: 'stop', fade: Number(fade) || 0 });
  }

  setVolume(channel: 'music' | 'sfx', value: number): void {
    const v = Math.max(0, Math.min(1, Number(value) || 0));
    this.volumes[channel === 'music' ? 'music' : 'sfx'] = v;
    this.opts.music?.({ type: 'volume', channel: channel === 'music' ? 'music' : 'sfx', value: v });
  }

  constructor(bundle: GameBundle, opts: EngineOptions = {}) {
    this.bundle = bundle;
    this.game = bundle.game;
    this.opts = opts;
    this.rngState = (opts.seed ?? 12345) >>> 0;
    // Variants are resolved once: the engine runs the effective types.
    const resolved = resolveObjectTypes(this.game.objects);
    this.objectMap = resolved.types;
    this.lineage = resolved.lineage;
    for (const e of resolved.errors) this.log(`ERROR object ${e.object}: ${e.message}`);
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
    // Scripts get the tables read-only (a script can't corrupt the database for the next run).
    if (opts.vars) Object.assign(this.globals, opts.vars);
    this.data = deepFreeze(structuredClone(bundle.data ?? {}));
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
    if (prev?.persistent && prev.name !== name && !this.forcedMemory) {
      const mem = this.memory.get(prev.name) ?? new Map();
      for (const [id, e] of this.currentState(false)) mem.set(id, e);
      this.memory.set(prev.name, mem);
    }
    // The old scene's components are gone (their pending waits stop).
    if (this.scripts) {
      this.scripts.drop(this.sceneComponents);
      for (const a of this.actors) this.scripts.drop(a.components);
    }
    this.sceneComponents = [];
    if ((this.resetPending || prev?.name === name) && !this.forcedMemory) this.memory.delete(name);
    this.resetPending = false;
    const remembered = this.forcedMemory ?? (scene.persistent ? this.memory.get(name) : undefined);
    this.forcedMemory = null;
    this.scene = scene;
    this.actors = [];
    this.sceneVars = { ...scene.variables };
    this.time = 0;
    this.sceneTimers.clear();
    this.message = null;
    this.shake = { until: 0, intensity: 0, duration: 0 };
    this.camera = { x: 0, y: 0, zoom: this.uiScale };
    this.paused = false;
    this.timeScale = 1;
    this.particles?.clear();
    this.vfx?.clear();
    this.hitstopUntil = 0;
    this.cameraBounds = null;
    this.cameraTarget = undefined;
    this.lookX = 0;
    this.solidLayers = scene.layers.filter((l) => l.solid).map((l) => l.tiles);
    this.fine = scene.collisionFine ? decodeFineSolid(scene.collisionFine, scene.cols * scene.tileSize, scene.rows * scene.tileSize).fine : null;
    this.scripts?.resetScene();
    this.dormant.clear();
    this.sceneMemory = remembered;
    for (const inst of scene.instances) {
      if (!this.objectMap.has(inst.object)) continue;
      const mem = remembered?.get(inst.id);
      if (mem?.destroyed) continue;
      if (inst.activeIf && !this.isActive(inst)) {
        this.dormant.add(inst.id);
        continue;
      }
      this.actors.push(this.placeInstance(inst, mem));
    }
    this.started = false;
    this.log(`scene "${name}" started`);
  }

  /** What the current scene remembered when it loaded (persistent scenes, loaded saves). */
  private sceneMemory: Map<string, MemoryEntry> | undefined;

  /** Creates the actor of a placed instance (with what a persistent scene remembered about it). */
  private placeInstance(inst: Instance, mem: MemoryEntry | undefined): Actor {
    const type = this.objectMap.get(inst.object)!;
    const a = this.makeActor(type, inst.x, inst.y, inst.sprite);
    a.sceneId = inst.id;
    a.instName = inst.name ?? null;
    if (inst.animation) a.anim = inst.animation;
    if (inst.props) Object.assign(a.vars, inst.props);
    if (inst.flipX) a.flipX = true;
    if (inst.light) a.light = inst.light.radius > 0 ? inst.light : undefined;
    if (inst.hdPose) a.hdPose = inst.hdPose;
    if (inst.hitbox) a.instHitbox = inst.hitbox;
    if (inst.hdLift) a.hdLift = inst.hdLift;
    if (inst.footLine) a.footLine = inst.footLine;
    if (inst.order !== undefined) a.z = inst.order;
    for (const t of inst.tags ?? []) a.tags.add(t);
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
    return a;
  }

  /** Is a placed instance's activeIf true? (Errors are reported once and count as active.) */
  private isActive(inst: Instance): boolean {
    if (!inst.activeIf) return true;
    try {
      return truthy(compile(inst.activeIf)(this.ctx({})));
    } catch (err) {
      this.error(`instance ${inst.name ?? inst.object}#${inst.id} activeIf`, err);
      return true;
    }
  }

  /**
   * Conditional instances (activeIf) appear when their condition becomes true and disappear when it turns false.
   * Runs a few times per second and right after variables change through events, dialogues or refreshInstances().
   */
  refreshConditional(): void {
    if (!this.started) return;
    for (const inst of this.scene.instances) {
      if (!inst.activeIf) continue;
      const active = this.isActive(inst);
      if (active && this.dormant.has(inst.id)) {
        this.dormant.delete(inst.id);
        const mem = this.scene.persistent ? this.memory.get(this.scene.name)?.get(inst.id) : this.sceneMemory?.get(inst.id);
        const a = this.placeInstance(inst, mem?.destroyed ? undefined : mem);
        this.actors.push(a);
        this.onCreated(a);
        this.fireObject(a, 'start');
      } else if (!active) {
        const a = this.actors.find((x) => x.sceneId === inst.id && !x.destroyed);
        if (!a) continue;
        // Not destroyed: no "destroyed" event, no memory of it; it comes back when the condition holds.
        a.destroyed = true;
        this.talking.delete(a);
        for (const c of [...a.components]) this.scripts.remove(c);
        this.dormant.add(inst.id);
      }
    }
  }

  /** State of the placed instances of the current scene (destroyed ones too when asked). */
  private currentState(withDestroyed: boolean): Map<string, MemoryEntry> {
    const out = new Map<string, MemoryEntry>();
    for (const a of this.actors) {
      if (!a.sceneId || a.destroyed) continue;
      const comps: Record<string, Record<string, Value>> = {};
      for (const c of a.components) {
        const st = componentState(c);
        if (st) comps[st.name] = fieldsOf(c);
      }
      out.set(a.sceneId, { x: a.x, y: a.y, vars: { ...a.vars }, flipX: a.flipX, facing: a.facing, anim: a.anim, ...(a.components.length ? { comps } : {}) });
    }
    if (withDestroyed) for (const i of this.scene.instances) if (!out.has(i.id) && !this.dormant.has(i.id)) out.set(i.id, { destroyed: true });
    return out;
  }

  // ------------------------------------------------------------------ save slots

  private saveKey(slot: string): string {
    return `save:${slot}`;
  }

  private store(key: string, value: string | null): void {
    if (value === null) this.saveStore.delete(key);
    else this.saveStore.set(key, value);
    this.opts.storage?.set(key, value ?? '');
  }

  private fetch(key: string): string | null {
    const v = this.opts.storage ? this.opts.storage.get(key) : (this.saveStore.get(key) ?? null);
    return v ? v : null;
  }

  private slotIndex(): string[] {
    try {
      const v = JSON.parse(this.fetch('save:index') ?? '[]');
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  /**
   * Saves the whole game in a slot: global and scene variables, the current scene with its placed instances
   * (positions, properties, component fields, destroyed ones), the memory of persistent scenes, global components.
   */
  saveGame(slot = 'auto'): SaveSummary {
    const name = String(slot || 'auto');
    const memory: Record<string, Record<string, MemoryEntry>> = {};
    for (const [scene, m] of this.memory) memory[scene] = Object.fromEntries(m);
    const data: SaveData = {
      format: 'spritifer-save',
      version: 1,
      slot: name,
      title: this.game.title,
      savedAt: Date.now(),
      scene: this.scene.name,
      globals: { ...this.globals },
      sceneVars: { ...this.sceneVars },
      memory,
      current: Object.fromEntries(this.currentState(true)),
      gameComponents: this.gameComponents.map((c) => ({ name: componentState(c)?.name ?? '', fields: fieldsOf(c) })),
    };
    this.store(this.saveKey(name), JSON.stringify(data));
    const index = this.slotIndex().filter((x) => x !== name);
    this.store('save:index', JSON.stringify([...index, name]));
    this.log(`game saved in slot "${name}" (${this.scene.name})`);
    return { slot: name, scene: data.scene, savedAt: data.savedAt, title: data.title };
  }

  readSave(slot: string): SaveData | null {
    const raw = this.fetch(this.saveKey(String(slot || 'auto')));
    if (!raw) return null;
    try {
      const d = JSON.parse(raw) as SaveData;
      return d && d.format === 'spritifer-save' && this.bundle.scenes[d.scene] ? d : null;
    } catch {
      return null;
    }
  }

  hasSave(slot = 'auto'): boolean {
    return !!this.readSave(slot);
  }

  listSaves(): SaveSummary[] {
    return this.slotIndex()
      .map((s) => this.readSave(s))
      .filter((d): d is SaveData => !!d)
      .map((d) => ({ slot: d.slot, scene: d.scene, savedAt: d.savedAt, title: d.title }));
  }

  deleteSave(slot: string): void {
    const name = String(slot || 'auto');
    this.store(this.saveKey(name), null);
    this.store('save:index', JSON.stringify(this.slotIndex().filter((x) => x !== name)));
  }

  /** Loads a slot at the end of this frame. Returns false when the slot is empty. */
  loadGame(slot = 'auto'): boolean {
    const d = this.readSave(slot);
    if (!d) return false;
    this.pendingLoad = d;
    return true;
  }

  private applyLoad(d: SaveData): void {
    this.fade = { phase: 'none', t: 0, dur: 0, color: '#000000', scene: null, restart: false };
    this.globals = { ...this.game.variables, ...d.globals };
    this.memory = new Map(Object.entries(d.memory ?? {}).map(([k, v]) => [k, new Map(Object.entries(v))]));
    d.gameComponents?.forEach((g, i) => {
      const c = this.gameComponents[i];
      if (c && componentState(c)?.name === g.name) Object.assign(c, g.fields);
    });
    this.controlsLocked = false;
    this.forcedMemory = new Map(Object.entries(d.current ?? {}));
    this.loadScene(d.scene);
    this.sceneVars = { ...this.scene.variables, ...d.sceneVars };
    this.log(`game loaded from slot "${d.slot}"`);
  }

  private makeActor(type: ObjectType, x: number, y: number, spriteOverride?: string): Actor {
    const spriteName = spriteOverride && this.bundle.sprites[spriteOverride] ? spriteOverride : type.sprite;
    const asset = spriteName ? this.bundle.sprites[spriteName] : undefined;
    const a = new Actor(this.nextId++, type, asset, x, y, this.time);
    a.font = this.font;
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
    // Scene music: a track (crossfade if different), "-" = silence, nothing = keep playing.
    if (this.scene.music) {
      try {
        this.playMusic(this.scene.music);
      } catch (err) {
        this.error(`scene ${this.scene.name} music`, err);
      }
    }
    // Unlike music, a place with no sounds of its own is quiet: the forest doesn't follow you indoors.
    try {
      this.setAmbience(this.scene.ambience ?? []);
    } catch (err) {
      this.ambienceBase = [];
      this.error(`scene ${this.scene.name} ambience`, err);
    }
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

  /**
   * Plays an effect from the vfx/ folder; resolves when it ends. Source and target are instances (which it
   * tracks while they move) or fixed points. Without a target it fires where the source is facing.
   */
  playVfx(name: string, source: Actor | VfxPoint, target?: Actor | VfxPoint | null, opts: { tint?: string; scale?: number; speed?: number; angle?: number; onMessage?: (message: string) => void } = {}): Promise<void> {
    const graph = this.bundle.vfx?.[name];
    if (!graph) {
      this.log(`no effect "${name}" in vfx/`);
      return Promise.resolve();
    }
    const anchor = (who: Actor | VfxPoint): VfxAnchor => {
      if (!(who instanceof Actor)) return { x: who.x, y: who.y };
      // A destroyed instance leaves the effect where it last was.
      let last: VfxPoint = { x: 0, y: 0 };
      const live = () => {
        if (who.destroyed) return last;
        const b = who.box();
        return (last = { x: b.x + b.w / 2, y: b.y + b.h / 2 });
      };
      live();
      return live;
    };
    const actorOf = (who: Actor | VfxPoint | null | undefined) => (who instanceof Actor ? who : undefined);
    const angle = opts.angle ?? (target ? undefined : actorOf(source)?.flipX ? 180 : 0);
    const run = this.vfx.play(graph, {
      source: anchor(source),
      ...(target ? { target: anchor(target) } : {}),
      ...(angle !== undefined ? { angle } : {}),
      ...(opts.tint ? { tint: opts.tint } : {}),
      ...(opts.scale ? { scale: opts.scale } : {}),
      ...(opts.speed ? { speed: opts.speed } : {}),
      ...(opts.onMessage ? { onMessage: opts.onMessage } : {}),
      blink: (who, seconds) => {
        const a = actorOf(who === 'source' ? source : target);
        if (a) a.flashUntil = this.clock + seconds;
      },
    });
    return run.done;
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

  /** Delivers queued messages to events, onMessage and on() listeners; handlers may queue more. */
  private deliverMessages(): void {
    for (let round = 0; round < 10 && this.messages.length; round++) {
      const msgs = this.messages.splice(0);
      for (const { name: m, data } of msgs) {
        this.scripts.dispatch(m, data);
        for (const a of [...this.actors]) if (!a.destroyed) this.fireObject(a, 'message', (t) => t.message === m);
        this.fireScene('message', (t) => t.message === m);
      }
    }
  }

  step(input: InputFrame = emptyInput(), dt = STEP): void {
    input = this.mapActions(input);
    this.input = input;
    if (!this.started) this.begin();
    this.checkSolidIndex();
    this.scripts.latchInput(input);
    // Paused (pause menus, inventories): nothing moves; components get pausedUpdate, onDraw still runs.
    if (this.paused) {
      this.scripts.invokeAll(this.scripts.all(), 'pausedUpdate', dt);
      this.frame++;
      this.applyPendingScene();
      return;
    }
    if (this.clock >= this.hitstopUntil) {
      this.particles.tick(dt);
      this.vfx.tick(dt);
    }
    const moteCfg = this.scene.atmosphere?.motes;
    if (moteCfg !== this.motesFor) {
      this.motesFor = moteCfg;
      this.motes.reset(moteCfg);
    }
    this.motes.tick(dt, { x: this.camera.x, y: this.camera.y, w: this.viewWidth, h: this.viewHeight });
    const mote2Cfg = this.scene.atmosphere?.motes2;
    if (mote2Cfg !== this.motes2For) {
      this.motes2For = mote2Cfg;
      this.motes2.reset(mote2Cfg);
    }
    this.motes2.tick(dt, { x: this.camera.x, y: this.camera.y, w: this.viewWidth, h: this.viewHeight });
    const rainCfg = this.scene.atmosphere?.rain;
    if (rainCfg !== this.rainFor) {
      this.rainFor = rainCfg;
      this.rain.reset(rainCfg);
    }
    this.rain.tick(dt, { x: this.camera.x, y: this.camera.y, w: this.viewWidth, h: this.viewHeight }, (name, volume) => this.opts.sound?.(name, volume));
    this.stepFoliage(dt);
    if (this.frame % 6 === 0) this.sendAmbience(0.3);

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
    if (this.clock < this.hitstopUntil) {
      // Messages still arrive: the hit stop usually starts on the very frame the damage is applied.
      this.deliverMessages();
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
      a.flags.animEvents = [];
    }

    // Scripts above may have moved a still solid (a gate, a tween): the grid hears of it before anything moves against it.
    if (this.solidIdx) this.checkSolidIndex();
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
    const now = touchingPairs(live);

    // Component collision hooks: enter (start of touch), stay, exit.
    const sh = this.scripts;
    for (const a of live) {
      if (!a.components.length || a.destroyed) continue;
      const enter = a.components.some((c) => sh.has(c, 'onCollisionEnter'));
      const stay = a.components.some((c) => sh.has(c, 'onCollisionStay'));
      const exit = a.components.some((c) => sh.has(c, 'onCollisionExit'));
      if (!enter && !stay && !exit) continue;
      const cur = now.get(a) ?? NO_TOUCH;
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
      const touching = now.get(a) ?? NO_TOUCH;
      this.runObjectEvents(a, touching);
      a.touching = touching;
    }
    if (this.pressedKey('action')) this.interact();
    if (input.clicks.length) {
      for (const a of [...this.actors]) if (!a.destroyed && a.components.some((c) => sh.has(c, 'onClick')) && this.clickHits(a)) sh.invokeAll(a.components, 'onClick');
    }
    this.runSceneEvents();
    this.deliverMessages();

    // Late update: after movement, collisions and events.
    sh.invokeAll(this.gameComponents, 'lateUpdate', dt);
    sh.invokeAll(this.sceneComponents, 'lateUpdate', dt);
    for (const a of [...this.actors]) if (!a.destroyed && a.components.length) sh.invokeAll(a.components, 'lateUpdate', dt);

    // Conditional instances follow their activeIf (6 times per second is enough and cheap).
    if (this.frame % 10 === 0) this.refreshConditional();
    this.updateTexts();

    this.actors = this.actors.filter((a) => !a.destroyed);
    this.updateCamera(false);
    this.time += dt;
    this.clock += dt;
    this.frame++;
    this.applyPendingScene();
  }

  private applyPendingScene(): void {
    if (this.pendingLoad) {
      const d = this.pendingLoad;
      this.pendingLoad = null;
      this.pendingScene = null;
      this.applyLoad(d);
      return;
    }
    if (this.pendingScene) {
      const s = this.pendingScene;
      this.pendingScene = null;
      this.loadScene(s);
    }
  }

  /** The player pressed action: talk to / use the instance next to it (or in front of it). */
  /** What the action key would reach for this player right now: the closest thing in front that reacts to it. */
  private interactTargetOf(p: Actor): Actor | undefined {
    const b = p.box();
    const reach = this.scene.tileSize / 2;
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
      if (o === p || o.destroyed || o.type.hud || !overlap(probe, o.box())) continue;
      const hasHook = o.type.events.some((e) => !e.disabled && e.trigger.type === 'interact') || !!o.behavior('dialogue') || o.components.some((c) => this.scripts.has(c, 'onInteract'));
      if (!hasHook) continue;
      const ob = o.box();
      const d = Math.hypot(ob.x + ob.w / 2 - (b.x + b.w / 2), ob.y + ob.h / 2 - (b.y + b.h / 2));
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** What the action key would reach right now, for the first player that has something in front of it. */
  interactTarget(): Actor | undefined {
    for (const p of this.actors) {
      if (p.destroyed || !p.behaviors.some((b) => (b.type === 'topdown' || b.type === 'platformer') && b.controls !== false)) continue;
      const found = this.interactTargetOf(p);
      if (found) return found;
    }
    return undefined;
  }

  private interact(): void {
    const players = this.actors.filter((a) => !a.destroyed && a.behaviors.some((b) => (b.type === 'topdown' || b.type === 'platformer') && b.controls !== false));
    for (const p of players) {
      const best = this.interactTargetOf(p);
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

  // ------------------------------------------------------------------ queries (scripts)

  /** Does an instance match a query filter? */
  matchesFilter(a: Actor, f: QueryFilter): boolean {
    if (a.destroyed || a.type.hud) return false;
    if (f.ignore && f.ignore.includes(a)) return false;
    if (f.object && !this.isA(a, f.object)) return false;
    if (f.tag && !a.tags.has(f.tag)) return false;
    return true;
  }

  /** Solid at a world point: a solid tile, or a solid instance (not jump-through ones). */
  /** The tile at a world point on a tile layer, -1 for none or outside the map. */
  tileAt(x: number, y: number, layer = 'ground'): number {
    const l = this.scene.layers.find((o) => o.name === layer);
    if (!l) return -1;
    const ts = this.tileSize;
    const tx = Math.floor(x / ts);
    const ty = Math.floor(y / ts);
    if (tx < 0 || ty < 0 || tx >= this.scene.cols || ty >= this.scene.rows) return -1;
    return l.tiles[ty * this.scene.cols + tx] ?? -1;
  }

  isSolidAt(x: number, y: number): boolean {
    const ts = this.tileSize;
    if (this.solidAtTile(Math.floor(x / ts), Math.floor(y / ts))) return true;
    if (this.fine && fineSolidAt(this.fine, x, y)) return true;
    return this.solidsNear({ x, y, w: 1e-6, h: 1e-6 }).some((o) => {
      if (o.destroyed) return false;
      const s = o.behavior('solid');
      if (!s || s.oneWay === true) return false;
      const b = o.box();
      return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
    });
  }

  // ------------------------------------------------------------------ index of solid instances
  // Maps made of many solid instances (a field of rocks, hundreds of painted bases) would scan every instance for every
  // move. From SOLID_INDEX_MIN solid instances on, the ones that cannot move by themselves are kept in a grid of
  // SOLID_CELL px; the others (any behavior besides 'solid', script components, a speed) are "dynamic" and checked every
  // time, and so is one that has moved since the grid was made. The index is checked at the start of each step and
  // rebuilt when instances come, go, gain or lose the solid behavior. Callers get the candidates in the order of the
  // instance list, as a full scan would give them. With fewer solids nothing changes: every instance is a candidate.
  /** Solid instances from which the grid is used (fewer: the plain scan of every instance, as always). */
  solidIndexMin = SOLID_INDEX_MIN;
  private solidIdx: { count: number; grid: Map<number, Actor[]>; boxes: Map<Actor, Rect>; dynamic: Set<Actor>; order: Map<Actor, number> } | null = null;

  private buildSolidIndex(dynamic: Set<Actor> = new Set()): NonNullable<World['solidIdx']> {
    const grid = new Map<number, Actor[]>();
    const boxes = new Map<Actor, Rect>();
    const order = new Map<Actor, number>();
    const keep = new Set<Actor>();
    this.actors.forEach((a, i) => {
      order.set(a, i);
      if (a.destroyed || !a.behavior('solid')) return;
      if (dynamic.has(a) || a.vx || a.vy || a.components.length || a.behaviors.some((b) => b.type !== 'solid')) {
        keep.add(a);
        return;
      }
      const b = a.box();
      boxes.set(a, { x: b.x, y: b.y, w: b.w, h: b.h });
      for (let cy = Math.floor(b.y / SOLID_CELL); cy <= Math.floor((b.y + b.h) / SOLID_CELL); cy++) {
        for (let cx = Math.floor(b.x / SOLID_CELL); cx <= Math.floor((b.x + b.w) / SOLID_CELL); cx++) {
          const k = cy * 65536 + cx;
          const list = grid.get(k);
          if (list) list.push(a);
          else grid.set(k, [a]);
        }
      }
    });
    return { count: this.actors.length, grid, boxes, dynamic: keep, order };
  }

  /** Start of a step: the grid only with many solids; solids that moved become dynamic; a changed set rebuilds it. */
  private checkSolidIndex(): void {
    let solids = 0;
    for (const a of this.actors) if (!a.destroyed && a.behavior('solid')) solids++;
    if (solids < this.solidIndexMin) {
      this.solidIdx = null;
      return;
    }
    const idx = this.solidIdx;
    if (!idx) {
      this.solidIdx = this.buildSolidIndex();
      return;
    }
    // the instance list is a new array every step: membership is checked by position, not by identity
    let rebuild = idx.count !== this.actors.length;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i]!;
      if (!rebuild && idx.order.get(a) !== i) rebuild = true;
      const solid = !a.destroyed && !!a.behavior('solid');
      const known = idx.boxes.get(a);
      if (solid !== (!!known || idx.dynamic.has(a))) rebuild = true;
      if (known) {
        const b = a.box();
        if (b.x !== known.x || b.y !== known.y || b.w !== known.w || b.h !== known.h) {
          idx.dynamic.add(a);
          rebuild = true;
        }
      }
    }
    if (rebuild) this.solidIdx = this.buildSolidIndex(idx.dynamic);
  }

  /** Solid instances that may overlap `r` (a superset), in instance-list order. Without the grid: every instance. */
  private solidsNear(r: Rect): Actor[] {
    let idx = this.solidIdx;
    if (!idx) return this.actors;
    // an instance created during this step is not in the grid yet
    if (idx.count !== this.actors.length) idx = this.solidIdx = this.buildSolidIndex(idx.dynamic);
    const seen = new Set<Actor>(idx.dynamic);
    for (let cy = Math.floor(r.y / SOLID_CELL); cy <= Math.floor((r.y + r.h) / SOLID_CELL); cy++) {
      for (let cx = Math.floor(r.x / SOLID_CELL); cx <= Math.floor((r.x + r.w) / SOLID_CELL); cx++) {
        for (const a of idx.grid.get(cy * 65536 + cx) ?? []) seen.add(a);
      }
    }
    const order = idx.order;
    return [...seen].sort((p, q) => (order.get(p) ?? 1e9) - (order.get(q) ?? 1e9));
  }

  /** Instances whose hitbox overlaps a rectangle. */
  overlapRect(r: Rect, f: QueryFilter = {}): Actor[] {
    return this.actors.filter((a) => this.matchesFilter(a, f) && overlap(r, a.box()));
  }

  /** Instances whose hitbox touches a circle. */
  overlapCircle(cx: number, cy: number, radius: number, f: QueryFilter = {}): Actor[] {
    return this.actors.filter((a) => {
      if (!this.matchesFilter(a, f)) return false;
      const b = a.box();
      const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
      const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
      return (nx - cx) ** 2 + (ny - cy) ** 2 <= radius * radius;
    });
  }

  /**
   * First thing along the segment (x1,y1)→(x2,y2): solid tiles and solid instances (unless solids is false),
   * and instances matching the filter (tag/object, or any with instances: true).
   */
  raycast(x1: number, y1: number, x2: number, y2: number, f: QueryFilter & { solids?: boolean; instances?: boolean } = {}): RayHit | null {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) return null;
    let best: RayHit | null = null;
    const consider = (t: number, nx: number, ny: number, actor: Actor | null) => {
      if (t < 0 || t > 1 || (best && t >= best.t)) return;
      best = { t, x: x1 + dx * t, y: y1 + dy * t, distance: len * t, normalX: nx, normalY: ny, actor, tile: !actor };
    };
    const solids = f.solids !== false;
    if (solids) {
      // Tiles: walk the grid cells the segment crosses (DDA).
      const ts = this.tileSize;
      let tx = Math.floor(x1 / ts);
      let ty = Math.floor(y1 / ts);
      const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      const tDeltaX = stepX ? ts / Math.abs(dx) : Infinity;
      const tDeltaY = stepY ? ts / Math.abs(dy) : Infinity;
      let tMaxX = stepX > 0 ? ((tx + 1) * ts - x1) / dx : stepX < 0 ? (tx * ts - x1) / dx : Infinity;
      let tMaxY = stepY > 0 ? ((ty + 1) * ts - y1) / dy : stepY < 0 ? (ty * ts - y1) / dy : Infinity;
      let t = 0;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < 4096 && t <= 1; i++) {
        if (this.solidAtTile(tx, ty)) {
          consider(t, nx, ny, null);
          break;
        }
        if (tMaxX < tMaxY) {
          t = tMaxX;
          tMaxX += tDeltaX;
          tx += stepX;
          nx = -stepX;
          ny = 0;
        } else {
          t = tMaxY;
          tMaxY += tDeltaY;
          ty += stepY;
          nx = 0;
          ny = -stepY;
        }
      }
    }
    if (solids && this.fine) {
      // Fine cells: the same walk over the smaller grid.
      const fc = this.fine.cell;
      let tx = Math.floor(x1 / fc);
      let ty = Math.floor(y1 / fc);
      const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
      const tDeltaX = stepX ? fc / Math.abs(dx) : Infinity;
      const tDeltaY = stepY ? fc / Math.abs(dy) : Infinity;
      let tMaxX = stepX > 0 ? ((tx + 1) * fc - x1) / dx : stepX < 0 ? (tx * fc - x1) / dx : Infinity;
      let tMaxY = stepY > 0 ? ((ty + 1) * fc - y1) / dy : stepY < 0 ? (ty * fc - y1) / dy : Infinity;
      let t = 0;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < 65536 && t <= 1; i++) {
        if (fineSolidAt(this.fine, (tx + 0.5) * fc, (ty + 0.5) * fc)) {
          consider(t, nx, ny, null);
          break;
        }
        if (tMaxX < tMaxY) {
          t = tMaxX;
          tMaxX += tDeltaX;
          tx += stepX;
          nx = -stepX;
          ny = 0;
        } else {
          t = tMaxY;
          tMaxY += tDeltaY;
          ty += stepY;
          nx = 0;
          ny = -stepY;
        }
      }
    }
    const anyInstance = f.instances === true || !!f.tag || !!f.object;
    for (const a of this.actors) {
      if (a.destroyed || a.type.hud || (f.ignore && f.ignore.includes(a))) continue;
      const solid = solids && !!a.behavior('solid') && a.behavior('solid')!.oneWay !== true;
      if (!solid && !(anyInstance && this.matchesFilter(a, f))) continue;
      // Segment vs box (slabs).
      const b = a.box();
      let t0 = 0;
      let t1 = 1;
      let nx = 0;
      let ny = 0;
      let ok = true;
      for (const [p, d, lo, hi, axis] of [[x1, dx, b.x, b.x + b.w, 0], [y1, dy, b.y, b.y + b.h, 1]] as const) {
        if (d === 0) {
          if (p < lo || p > hi) ok = false;
          continue;
        }
        let ta = (lo - p) / d;
        let tb = (hi - p) / d;
        const sign = ta > tb ? 1 : -1;
        if (ta > tb) [ta, tb] = [tb, ta];
        if (ta > t0) {
          t0 = ta;
          nx = axis === 0 ? sign : 0;
          ny = axis === 1 ? sign : 0;
        }
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
      if (ok) consider(t0, nx, ny, a);
    }
    return best;
  }

  /**
   * A* over the tile grid from one world point to another, around solid tiles and solid instances.
   * Returns waypoints (tile centers, the last one the exact target) or null when unreachable;
   * with `partial` it goes as close as it can instead.
   */
  /**
   * Fine collision as the path finder sees it (room-3001 #286.H, #305): the summed area of the fine cells (is anything
   * solid in this box?), and per walker width the tiles whose center has no room and the free moves between tiles.
   * Computed once per scene and width (a few widths kept), not at every call.
   */
  private finePaths: { fine: FineSolid; sat: Int32Array; byWidth: Map<number, { closed: Uint8Array; pass: Uint8Array }> } | null = null;
  /** Search arrays reused from one call to the next (one set per grid size), valid where `seen` holds this call's stamp. */
  private pathScratch = new Map<number, { stamp: number; seen: Uint32Array; done: Uint32Array; g: Float64Array; from: Int32Array; known: Int8Array; knownAt: Uint32Array }>();

  private scratchFor(n: number) {
    let sc = this.pathScratch.get(n);
    if (!sc) {
      if (this.pathScratch.size >= 2) this.pathScratch.delete(this.pathScratch.keys().next().value!);
      sc = { stamp: 0, seen: new Uint32Array(n), done: new Uint32Array(n), g: new Float64Array(n), from: new Int32Array(n), known: new Int8Array(n), knownAt: new Uint32Array(n) };
      this.pathScratch.set(n, sc);
    }
    sc.stamp++;
    if (sc.stamp >= 0xffffffff) {
      sc.stamp = 1;
      sc.seen.fill(0);
      sc.done.fill(0);
      sc.knownAt.fill(0);
    }
    return sc;
  }

  /** Fine collision in a box; outside the scene counts as solid (a walker is never sent along the edge of the map). */
  private fineBlockedIn(x0: number, y0: number, x1: number, y1: number): boolean {
    const f = this.fine!;
    if (x0 < 0 || y0 < 0 || x1 > f.cols * f.cell || y1 > f.rows * f.cell) return true;
    return this.fineSolidIn(x0, y0, x1, y1);
  }

  private fineSolidIn(x0: number, y0: number, x1: number, y1: number): boolean {
    const f = this.fine!;
    const fp = this.finePathTables();
    const W = f.cols + 1;
    const cx0 = Math.max(0, Math.floor(x0 / f.cell));
    const cy0 = Math.max(0, Math.floor(y0 / f.cell));
    const cx1 = Math.min(f.cols, Math.floor((x1 - 1e-6) / f.cell) + 1);
    const cy1 = Math.min(f.rows, Math.floor((y1 - 1e-6) / f.cell) + 1);
    if (cx1 <= cx0 || cy1 <= cy0) return false;
    const sat = fp.sat;
    return sat[cy1 * W + cx1]! - sat[cy0 * W + cx1]! - sat[cy1 * W + cx0]! + sat[cy0 * W + cx0]! > 0;
  }

  private finePathTables(): NonNullable<World['finePaths']> {
    const f = this.fine!;
    if (this.finePaths && this.finePaths.fine === f) return this.finePaths;
    const W = f.cols + 1;
    const sat = new Int32Array(W * (f.rows + 1));
    for (let y = 0; y < f.rows; y++) {
      let run = 0;
      for (let x = 0; x < f.cols; x++) {
        run += f.bits[y * f.cols + x]!;
        sat[(y + 1) * W + x + 1] = sat[y * W + x + 1]! + run;
      }
    }
    return (this.finePaths = { fine: f, sat, byWidth: new Map() });
  }

  private finePathFor(width: number): { closed: Uint8Array; pass: Uint8Array } {
    const t = this.finePathTables();
    const hit = t.byWidth.get(width);
    if (hit) {
      // least recently used goes first: a width asked again moves to the end
      t.byWidth.delete(width);
      t.byWidth.set(width, hit);
      return hit;
    }
    const ts = this.tileSize;
    const cols = this.scene.cols;
    const rows = this.scene.rows;
    const f = this.fine!;
    const half = width / 2;
    const closed = new Uint8Array(cols * rows);
    const pass = new Uint8Array(cols * rows * 8);
    const dirs = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const k = ty * cols + tx;
        const cx = tx * ts + ts / 2;
        const cy = ty * ts + ts / 2;
        closed[k] = this.fineBlockedIn(cx - half, cy - half, cx + half, cy + half) ? 1 : 0;
        dirs.forEach(([dx, dy], d) => {
          const len = Math.hypot(dx, dy) * ts;
          const n = Math.max(1, Math.ceil(len / Math.max(1, f.cell / 2)));
          let ok = true;
          for (let i = 0; i <= n && ok; i++) {
            const px = cx + (dx * ts * i) / n;
            const py = cy + (dy * ts * i) / n;
            if (this.fineBlockedIn(px - half, py - half, px + half, py + half)) ok = false;
          }
          pass[k * 8 + d] = ok ? 1 : 0;
        });
      }
    }
    if (t.byWidth.size >= 4) t.byWidth.delete(t.byWidth.keys().next().value!);
    const out = { closed, pass };
    t.byWidth.set(width, out);
    return out;
  }

  /**
   * findPath on a scene with fine collision. First over tiles, with the first move taken from where the walker really is
   * and the last one into the real target (a walker against a thin wall, or a target next to one, is not stuck because
   * the CENTER of its tile has no room). If that finds nothing, over the fine cells themselves, so a gap narrower than a
   * tile or away from tile centers is found too. Waypoints are then pulled tight along free lines.
   */
  private findPathFine(x1: number, y1: number, x2: number, y2: number, opts: { diagonal?: boolean; partial?: boolean; ignore?: Actor[]; maxNodes?: number; width?: number }): { x: number; y: number }[] | null {
    const ts = this.tileSize;
    const cols = this.scene.cols;
    const rows = this.scene.rows;
    const f = this.fine!;
    const wIn = Number(opts.width);
    const w0 = Number.isFinite(wIn) && wIn > 0 ? Math.min(wIn, 4 * ts) : Math.min(ts / 2, 8);
    // a walker at least a cell wide is rounded up to whole cells; a smaller one keeps its size (a cell of 32 px does not
    // make an 8 px walker 32 px wide) and the moves between cells are then checked along the way (room-3001 #344.6)
    const width = f.cell <= w0 ? Math.ceil(w0 / f.cell) * f.cell : Math.ceil(w0);
    const half = width / 2;
    const W = cols * ts;
    const H = rows * ts;
    const insidePx = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
    if (!insidePx(x1, y1)) return null;
    const diag = opts.diagonal !== false;
    // other solids: solid tiles and solid instances (not jump-through ones)
    const boxes: Rect[] = [];
    for (const o of this.actors) {
      if (o.destroyed || opts.ignore?.includes(o)) continue;
      const sb = o.behavior('solid');
      if (!sb || sb.oneWay === true) continue;
      boxes.push(o.box());
    }
    const rectFree = (x0: number, y0: number, x1_: number, y1_: number) => {
      if (x0 < 0 || y0 < 0 || x1_ > W || y1_ > H || this.fineSolidIn(x0, y0, x1_, y1_)) return false;
      for (let ty = Math.max(0, Math.floor(y0 / ts)); ty <= Math.min(rows - 1, Math.floor((y1_ - 1e-6) / ts)); ty++) {
        for (let tx = Math.max(0, Math.floor(x0 / ts)); tx <= Math.min(cols - 1, Math.floor((x1_ - 1e-6) / ts)); tx++) if (this.solidAtTile(tx, ty)) return false;
      }
      for (const b of boxes) if (b.x < x1_ && x0 < b.x + b.w && b.y < y1_ && y0 < b.y + b.h) return false;
      return true;
    };
    const boxFree = (cx: number, cy: number) => rectFree(cx - half, cy - half, cx + half, cy + half);
    // A segment is free when the walker's box is free all along it. Each short piece is checked with the box that covers
    // the walker at both of its ends, so nothing can hide between two samples, not even the corner of a thin post (a bit
    // careful near corners, never through a solid: room-3001 #344.6).
    const stepPx = Math.max(0.5, Math.min(width, f.cell) / 2);
    const segmentFree = (ax: number, ay: number, bx: number, by: number) => {
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / stepPx));
      let px = ax, py = ay;
      if (!boxFree(px, py)) return false;
      for (let i = 1; i <= n; i++) {
        const qx = ax + ((bx - ax) * i) / n, qy = ay + ((by - ay) * i) / n;
        if (!rectFree(Math.min(px, qx) - half, Math.min(py, qy) - half, Math.max(px, qx) + half, Math.max(py, qy) + half)) return false;
        px = qx;
        py = qy;
      }
      return true;
    };
    const mIn = Number(opts.maxNodes);
    const tileLimit = Number.isFinite(mIn) && mIn >= 1 ? Math.floor(mIn) : 20000;
    // the fine search looks at up to 8 times as many nodes as the tile search (room-3001 #344.2)
    const fineLimit = 8 * tileLimit;
    let goalFree = insidePx(x2, y2) && boxFree(x2, y2);
    if (!goalFree && !opts.partial) return null;
    if (!goalFree) {
      // no room for the walker at the target: with partial, the free spot nearest to it within a small radius becomes the
      // target; if there is none, only the (cheap) tile search runs, for 'as close as it can get'
      const R = Math.max(2 * width, 2 * ts);
      const st = Math.max(1, f.cell / 2);
      let best: { x: number; y: number; d: number } | null = null;
      for (let dy = -R; dy <= R; dy += st) {
        for (let dx = -R; dx <= R; dx += st) {
          const d = dx * dx + dy * dy;
          if (d > R * R || (best && d >= best.d)) continue;
          const px = x2 + dx, py = y2 + dy;
          if (insidePx(px, py) && boxFree(px, py)) best = { x: px, y: py, d };
        }
      }
      if (best) {
        x2 = best.x;
        y2 = best.y;
        goalFree = true;
      }
    }
    const pull = (pts: { x: number; y: number }[], first: { x: number; y: number }) => {
      // keep the farthest waypoint still in a free line from the current one (looking a bounded way ahead). When no line
      // is free, nothing is pulled: the walker goes through the unpulled path (from the walker, first the center of the
      // node it stands in), never in a straight line through a wall (room-3001 #344.6)
      const out: { x: number; y: number }[] = [];
      let cx = x1, cy = y1, i = 0;
      while (i < pts.length) {
        let j = Math.min(pts.length - 1, i + 64);
        while (j > i && !segmentFree(cx, cy, pts[j]!.x, pts[j]!.y)) j--;
        if (j === i && !segmentFree(cx, cy, pts[i]!.x, pts[i]!.y)) {
          // the first leg may go through the center of the start node; any other leg with no free line is not a way
          if (i === 0 && (first.x !== cx || first.y !== cy) && segmentFree(cx, cy, first.x, first.y) && segmentFree(first.x, first.y, pts[0]!.x, pts[0]!.y)) out.push(first);
          else return null;
        }
        out.push(pts[j]!);
        cx = pts[j]!.x;
        cy = pts[j]!.y;
        i = j + 1;
      }
      return out;
    };
    const pulled = (pts: { x: number; y: number }[], first: { x: number; y: number }) => {
      const r = pull(pts, first);
      return r ?? (opts.partial ? [] : null);
    };
    if (goalFree && segmentFree(x1, y1, x2, y2)) return [{ x: x2, y: y2 }];

    // A* on a grid of n cells whose neighbors are given by `step`
    const search = (n: number, start: number, goal: number, hx: (i: number) => number, step: (cur: number, visit: (ni: number, cost: number) => void) => void, limit: number) => {
      const sc = this.scratchFor(n);
      const stamp = sc.stamp;
      const { seen, done } = sc;
      const g = sc.g;
      const from = sc.from;
      const gAt = (i: number) => (seen[i] === stamp ? g[i]! : Infinity);
      const heap: [number, number][] = [[hx(start), start]];
      seen[start] = stamp;
      g[start] = 0;
      from[start] = -1;
      let best = start;
      let found = false;
      const push = (fv: number, i: number) => {
        heap.push([fv, i]);
        let k = heap.length - 1;
        while (k > 0) {
          const p = (k - 1) >> 1;
          if (heap[p]![0] <= heap[k]![0]) break;
          [heap[p], heap[k]] = [heap[k]!, heap[p]!];
          k = p;
        }
      };
      const pop = () => {
        const top = heap[0]!;
        const last = heap.pop()!;
        if (heap.length) {
          heap[0] = last;
          let k = 0;
          for (;;) {
            const l = 2 * k + 1, r = l + 1;
            let m = k;
            if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
            if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
            if (m === k) break;
            [heap[m], heap[k]] = [heap[k]!, heap[m]!];
            k = m;
          }
        }
        return top;
      };
      for (let c = 0; heap.length && c < limit; c++) {
        const [, cur] = pop();
        if (done[cur] === stamp) continue;
        done[cur] = stamp;
        if (cur === goal) {
          found = true;
          best = cur;
          break;
        }
        if (hx(cur) < hx(best)) best = cur;
        step(cur, (ni, cost) => {
          const gc = g[cur]! + cost;
          if (gc < gAt(ni)) {
            seen[ni] = stamp;
            g[ni] = gc;
            from[ni] = cur;
            push(gc + hx(ni), ni);
          }
        });
      }
      const chain: number[] = [];
      for (let i = best; i !== -1 && i !== start; i = from[i]!) chain.push(i);
      chain.reverse();
      return { found, chain };
    };

    // 1) tiles
    const sx = Math.floor(x1 / ts), sy = Math.floor(y1 / ts);
    const gx = Math.max(0, Math.min(cols - 1, Math.floor(x2 / ts))), gy = Math.max(0, Math.min(rows - 1, Math.floor(y2 / ts)));
    const fp = this.finePathFor(width);
    const blocked = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (this.solidAtTile(x, y) || fp.closed[y * cols + x]) blocked[y * cols + x] = 1;
    for (const b of boxes) {
      for (let ty = Math.max(0, Math.floor(b.y / ts)); ty <= Math.min(rows - 1, Math.floor((b.y + b.h - 0.01) / ts)); ty++) {
        for (let tx = Math.max(0, Math.floor(b.x / ts)); tx <= Math.min(cols - 1, Math.floor((b.x + b.w - 0.01) / ts)); tx++) blocked[ty * cols + tx] = 1;
      }
    }
    const start = sy * cols + sx;
    const goal = gy * cols + gx;
    const center = (i: number) => ({ x: (i % cols) * ts + ts / 2, y: Math.floor(i / cols) * ts + ts / 2 });
    const tileOpen = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && (!blocked[y * cols + x] || (y * cols + x === goal && goalFree));
    const ht = (i: number) => {
      const dx = Math.abs((i % cols) - gx), dy = Math.abs(Math.floor(i / cols) - gy);
      return diag ? Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
    };
    const tiles = search(cols * rows, start, goal, ht, (cur, visit) => {
      const cx = cur % cols, cy = Math.floor(cur / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (!tileOpen(nx, ny)) continue;
          if (dx && dy && (!diag || !tileOpen(cx + dx, cy) || !tileOpen(cx, cy + dy))) continue; // no corner cutting
          const ni = ny * cols + nx;
          // the first move from where the walker is, the last one into the real target; the others from the table
          const a = cur === start ? { x: x1, y: y1 } : center(cur);
          const b = ni === goal && goalFree ? { x: x2, y: y2 } : center(ni);
          const ok = cur === start || ni === goal ? segmentFree(a.x, a.y, b.x, b.y) : !!fp.pass[cur * 8 + (dy + 1) * 3 + (dx + 1) - ((dy + 1) * 3 + (dx + 1) > 4 ? 1 : 0)];
          if (ok) visit(ni, dx && dy ? Math.SQRT2 : 1);
        }
      }
    }, tileLimit);
    // start and target in the same tile with no free line between them: the tile chain is empty, the fine cells decide
    if (tiles.found && goalFree && tiles.chain.length) {
      const pts = tiles.chain.map(center);
      pts[pts.length - 1] = { x: x2, y: y2 };
      return pulled(pts, center(start));
    }

    // the target has no room even nearby: 'as close as it can get' over the tiles, without the fine search
    if (!goalFree) {
      const pts = tiles.chain.map(center);
      return pts.length ? pulled(pts, center(start)) : [];
    }
    // 2) the fine cells: a node is free when the walker fits around the center of its cell
    const fc = f.cols, fr = f.rows, cell = f.cell;
    const ksc = this.scratchFor(fc * fr);
    const kstamp = ksc.stamp;
    const known = ksc.known;
    const kseen = ksc.knownAt;
    const nodeFree = (i: number) => {
      if (kseen[i] !== kstamp) {
        kseen[i] = kstamp;
        known[i] = boxFree((i % fc) * cell + cell / 2, Math.floor(i / fc) * cell + cell / 2) ? 1 : -1;
      }
      return known[i] === 1;
    };
    const s2 = Math.min(fr - 1, Math.floor(y1 / cell)) * fc + Math.min(fc - 1, Math.floor(x1 / cell));
    const gfx = Math.max(0, Math.min(fc - 1, Math.floor(x2 / cell))), gfy = Math.max(0, Math.min(fr - 1, Math.floor(y2 / cell)));
    const g2 = gfy * fc + gfx;
    const hf = (i: number) => {
      const dx = Math.abs((i % fc) - gfx), dy = Math.abs(Math.floor(i / fc) - gfy);
      return diag ? Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
    };
    const open = (x: number, y: number) => x >= 0 && y >= 0 && x < fc && y < fr && (nodeFree(y * fc + x) || (y * fc + x === g2 && goalFree));
    const fineRes = search(fc * fr, s2, g2, hf, (cur, visit) => {
      const cx = cur % fc, cy = Math.floor(cur / fc);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!open(cx + dx, cy + dy)) continue;
          if (dx && dy && (!diag || !open(cx + dx, cy) || !open(cx, cy + dy))) continue;
          // a cell wider than the walker: room at both centers says nothing about a thin post between them (#344.6)
          if (cell > width && !segmentFree(cx * cell + cell / 2, cy * cell + cell / 2, (cx + dx) * cell + cell / 2, (cy + dy) * cell + cell / 2)) continue;
          visit((cy + dy) * fc + cx + dx, dx && dy ? Math.SQRT2 : 1);
        }
      }
    }, fineLimit);
    if (!fineRes.found && !opts.partial) return null;
    const pts = fineRes.chain.map((i) => ({ x: (i % fc) * cell + cell / 2, y: Math.floor(i / fc) * cell + cell / 2 }));
    if (fineRes.found && goalFree) {
      if (pts.length) pts[pts.length - 1] = { x: x2, y: y2 };
      else pts.push({ x: x2, y: y2 });
    }
    return pts.length ? pulled(pts, { x: (s2 % fc) * cell + cell / 2, y: Math.floor(s2 / fc) * cell + cell / 2 }) : [];
  }

  findPath(x1: number, y1: number, x2: number, y2: number, opts: { diagonal?: boolean; partial?: boolean; ignore?: Actor[]; maxNodes?: number; width?: number } = {}): { x: number; y: number }[] | null {
    if (this.fine) return this.findPathFine(x1, y1, x2, y2, opts);
    const ts = this.tileSize;
    const cols = this.scene.cols;
    const rows = this.scene.rows;
    const sx = Math.floor(x1 / ts);
    const sy = Math.floor(y1 / ts);
    let gx = Math.floor(x2 / ts);
    let gy = Math.floor(y2 / ts);
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
    if (!inside(sx, sy)) return null;
    // Blocked cells: solid tiles + cells covered by solid instances (not jump-through ones).
    const blocked = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (this.solidAtTile(x, y)) blocked[y * cols + x] = 1;
    for (const o of this.actors) {
      if (o.destroyed || opts.ignore?.includes(o)) continue;
      const sb = o.behavior('solid');
      if (!sb || sb.oneWay === true) continue;
      const b = o.box();
      for (let ty = Math.max(0, Math.floor(b.y / ts)); ty <= Math.min(rows - 1, Math.floor((b.y + b.h - 0.01) / ts)); ty++) {
        for (let tx = Math.max(0, Math.floor(b.x / ts)); tx <= Math.min(cols - 1, Math.floor((b.x + b.w - 0.01) / ts)); tx++) blocked[ty * cols + tx] = 1;
      }
    }
    const free = (x: number, y: number) => inside(x, y) && !blocked[y * cols + x];
    const reachableGoal = free(gx, gy);
    if (!reachableGoal && !opts.partial) return null;
    if (!inside(gx, gy)) {
      gx = Math.max(0, Math.min(cols - 1, gx));
      gy = Math.max(0, Math.min(rows - 1, gy));
    }
    const start = sy * cols + sx;
    const goal = gy * cols + gx;
    const diag = opts.diagonal !== false;
    const h = (i: number) => {
      const dx = Math.abs((i % cols) - gx);
      const dy = Math.abs(Math.floor(i / cols) - gy);
      return diag ? Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
    };
    const g = new Float64Array(cols * rows).fill(Infinity);
    const from = new Int32Array(cols * rows).fill(-1);
    const closed = new Uint8Array(cols * rows);
    g[start] = 0;
    // Binary heap of [f, index].
    const heap: [number, number][] = [[h(start), start]];
    const push = (f: number, i: number) => {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heap[p][0] <= heap[k][0]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    let best = start;
    let found = false;
    const limit = opts.maxNodes ?? 20000;
    for (let n = 0; heap.length && n < limit; n++) {
      const [, cur] = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        found = true;
        best = cur;
        break;
      }
      if (h(cur) < h(best)) best = cur;
      const cx = cur % cols;
      const cy = Math.floor(cur / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (dx && dy && (!diag || !free(cx + dx, cy) || !free(cx, cy + dy))) continue; // no corner cutting
          const nx = cx + dx;
          const ny = cy + dy;
          if (!free(nx, ny) && !(nx === sx && ny === sy)) continue;
          const ni = ny * cols + nx;
          const cost = g[cur] + (dx && dy ? Math.SQRT2 : 1);
          if (cost < g[ni]) {
            g[ni] = cost;
            from[ni] = cur;
            push(cost + h(ni), ni);
          }
        }
      }
    }
    if (!found && !opts.partial) return null;
    const cells: number[] = [];
    for (let i = best; i !== -1 && i !== start; i = from[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => ({ x: (i % cols) * ts + ts / 2, y: Math.floor(i / cols) * ts + ts / 2 }));
    if (found && reachableGoal) {
      if (pts.length) pts[pts.length - 1] = { x: x2, y: y2 };
      else pts.push({ x: x2, y: y2 });
    }
    // Drop waypoints in the middle of straight runs.
    return pts.filter((p, i) => {
      if (i === 0 || i === pts.length - 1) return true;
      const a = pts[i - 1];
      const b = pts[i + 1];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    });
  }

  /** Nearest instance to a point matching the filter (within maxDistance). */
  findNearest(x: number, y: number, f: QueryFilter & { maxDistance?: number } = {}): Actor | undefined {
    let best: Actor | undefined;
    let bd = f.maxDistance ?? Infinity;
    for (const a of this.actors) {
      if (!this.matchesFilter(a, f)) continue;
      const b = a.box();
      const d = Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y);
      if (d <= bd) {
        bd = d;
        best = a;
      }
    }
    return best;
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
    if (this.fine) out.push(...fineSolidRects(this.fine, box));
    for (const o of this.solidsNear(box)) {
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
    // With fine collision a step never passes a whole cell, or a fast actor would jump over a wall one cell thick.
    const maxStep = Math.max(1, Math.min(this.tileSize / 2 - 1, this.fine ? this.fine.cell : Infinity));
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
          const running = b.controls !== false && toNum(b.runSpeed) > 0 && this.key('shift');
          const speed = running ? toNum(b.runSpeed) : toNum(b.speed);
          if (b.controls !== false) {
            let dx = (this.key('right') ? 1 : 0) - (this.key('left') ? 1 : 0);
            let dy = (this.key('down') ? 1 : 0) - (this.key('up') ? 1 : 0);
            if (b.diagonals === false && dx && dy) dy = 0;
            const len = Math.hypot(dx, dy) || 1;
            dx /= len;
            dy /= len;
            a.vx = dx * speed;
            a.vy = dy * speed;
            // A diagonal at a chosen speed per axis, so it can also be a whole or half number of pixels per step.
            const diagonal = toNum(b.diagonalSpeed);
            if (diagonal > 0 && dx && dy) {
              const axis = diagonal * (running ? speed / (toNum(b.speed) || speed) : 1);
              a.vx = Math.sign(dx) * axis;
              a.vy = Math.sign(dy) * axis;
            }
          }
          if (this.moveAxis(a, a.vx * dt, 'x')) a.flags.hitWall = true;
          if (this.moveAxis(a, a.vy * dt, 'y')) a.flags.hitWall = true;
          const moving = Math.abs(a.vx) + Math.abs(a.vy) > 1;
          if (moving) a.facing = Math.abs(a.vx) > Math.abs(a.vy) ? (a.vx < 0 ? 'left' : 'right') : a.vy < 0 ? 'up' : 'down';
          const f = a.facing;
          const hasDirTags = a.hasTag(`walk_${f}`) || a.hasTag(`idle_${f}`);
          if (!hasDirTags && (f === 'left' || f === 'right')) a.flipX = f === 'left';
          // Sprites without run animations (yet) keep walking at the run speed.
          const gait = running ? [`run_${f}`, `walk_${f}`, 'run', 'walk'] : [`walk_${f}`, `run_${f}`, 'walk', 'run'];
          this.pickAnim(a, moving ? [...gait, `idle_${f}`, 'idle'] : [`idle_${f}`, 'idle']);
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
    this.advanceAnimation(a, dt);
    // Frame events ("hit", "step") when a new frame of the animation shows.
    const key = `${a.anim}:${a.seqIdx}`;
    if (key === a.lastFrameKey || a.destroyed) return;
    a.lastFrameKey = key;
    const events = a.asset?.frames[a.frameIndex()]?.events;
    if (!events?.length) return;
    for (const ev of events) {
      a.flags.animEvents.push(ev);
      // "vfx:<effect>" on a frame plays that effect on the instance, facing where it faces.
      if (ev.startsWith('vfx:')) void this.playVfx(ev.slice(4), a);
      this.scripts.invokeAll(a.components, 'onAnimationEvent', ev, a.anim);
    }
  }

  private advanceAnimation(a: Actor, dt: number): void {
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
      if (a.seqIdx >= seq.length && a.holdLast) {
        a.seqIdx = seq.length - 1;
        break;
      }
      if (a.seqIdx >= seq.length) {
        a.seqIdx = 0;
        a.flags.animEnd = a.anim;
        if (a.animLock === Infinity) a.animLock = 0;
      }
    }
  }

  /** The font every text of this game draws with. */
  get font(): PixelFont {
    return gameFont(this.game);
  }

  /** Canvas pixels per interface pixel. */
  get uiScale(): number {
    return this.game.uiScale ?? 1;
  }
  /** The screen in interface pixels: what scripts and dialogs lay out against. */
  get screenWidth(): number {
    return this.game.width / this.uiScale;
  }
  get screenHeight(): number {
    return this.game.height / this.uiScale;
  }

  /** Visible world size (the screen divided by the zoom). */
  get viewWidth(): number {
    return this.game.width / this.zoom;
  }
  get viewHeight(): number {
    return this.game.height / this.zoom;
  }
  get zoom(): number {
    const z = Number(this.camera.zoom);
    return Number.isFinite(z) && z > 0 ? Math.max(0.25, Math.min(8, z)) : 1;
  }

  private updateCamera(snap: boolean): void {
    const auto = this.actors.find((a) => !a.destroyed && a.behavior('camera'));
    if (snap && auto) {
      const z = toNum(auto.behavior('camera')!.zoom ?? this.uiScale);
      if (z > 0) this.camera.zoom = z;
    }
    const vw = this.viewWidth;
    const vh = this.viewHeight;
    const followed = this.cameraTarget === undefined ? auto : this.cameraTarget && !this.cameraTarget.destroyed ? this.cameraTarget : undefined;
    this.cameraHeld = followed ?? null;
    let tx = this.camera.x;
    let ty = this.camera.y;
    if (followed) {
      const cb = followed.behavior('camera') ?? ({} as Behavior);
      const b = followed.box();
      // Look ahead in the direction of movement (smoothed so turning doesn't jerk the view).
      const ahead = toNum(cb.lookAhead ?? 0);
      const dir = Math.abs(followed.vx) > 5 ? Math.sign(followed.vx) : followed.flipX ? -1 : ahead ? Math.sign(this.lookX) || 1 : 0;
      this.lookX = snap ? dir * ahead : this.lookX + (dir * ahead - this.lookX) * 0.06;
      const fx = b.x + b.w / 2 + this.lookX;
      const fy = b.y + b.h / 2 + toNum(cb.offsetY ?? 0);
      // Dead zone: the target moves freely inside a box around the view center.
      let cx = this.camera.x + vw / 2;
      let cy = this.camera.y + vh / 2;
      const dzx = snap ? 0 : Math.max(0, toNum(cb.deadZoneX ?? 0));
      const dzy = snap ? 0 : Math.max(0, toNum(cb.deadZoneY ?? 0));
      if (fx > cx + dzx) cx = fx - dzx;
      else if (fx < cx - dzx) cx = fx + dzx;
      if (fy > cy + dzy) cy = fy - dzy;
      else if (fy < cy - dzy) cy = fy + dzy;
      tx = cx - vw / 2;
      ty = cy - vh / 2;
      const s = snap ? 1 : Math.min(1, Math.max(0.01, 1 - toNum(cb.smoothing ?? 0)));
      tx = this.camera.x + (tx - this.camera.x) * s;
      ty = this.camera.y + (ty - this.camera.y) * s;
    }
    const r = this.cameraBounds ?? { x: 0, y: 0, w: this.widthPx, h: this.heightPx };
    this.camera.x = r.w <= vw ? r.x + (r.w - vw) / 2 : Math.max(r.x, Math.min(r.x + r.w - vw, tx));
    this.camera.y = r.h <= vh ? r.y + (r.h - vh) / 2 : Math.max(r.y, Math.min(r.y + r.h - vh, ty));
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
    return w === undefined || w === 'any' || this.isA(o, String(w));
  }

  private keyTrigger(set: Set<string>, key: Value | undefined): boolean {
    const k = String(key ?? 'space');
    return k === 'any' ? set.size > 0 : set.has(k);
  }

  private clickHits(a: Actor): boolean {
    for (const [cx, cy] of this.input.clicks) {
      const wx = a.type.hud ? cx / this.uiScale : cx / this.zoom + this.camera.x;
      const wy = a.type.hud ? cy / this.uiScale : cy / this.zoom + this.camera.y;
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
        case 'animationEvent':
          for (const ev of a.flags.animEvents) if (!t.event || t.event === ev) { run(); if (a.destroyed) return; }
          return;
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

  spawn(objectName: string, x: number, y: number, vx = 0, vy = 0, opts: { props?: Record<string, Value>; sprite?: string; name?: string; animation?: string } = {}): Actor | undefined {
    const type = this.objectMap.get(objectName);
    if (!type) throw new Error(`no object type "${objectName}"`);
    if (opts.sprite && !this.bundle.sprites[opts.sprite]) throw new Error(`no sprite "${opts.sprite}" (only sprites used by the game are loaded: name it in a script or scene)`);
    const a = this.makeActor(type, x, y, opts.sprite);
    a.vx = vx;
    a.vy = vy;
    // Before onCreated, so awake() sees them.
    if (opts.props) Object.assign(a.vars, opts.props);
    if (opts.name) a.instName = opts.name;
    if (opts.animation) a.anim = opts.animation;
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
      case 'particles': {
        const a = this.target(ctx, s.target);
        const b = a?.box();
        const x = (b ? b.x + b.w / 2 : this.camera.x + this.viewWidth / 2) + toNum(this.eval(s.dx ?? 0, ctx));
        const y = (b ? b.y + b.h / 2 : this.camera.y + this.viewHeight / 2) + toNum(this.eval(s.dy ?? 0, ctx));
        const count = toNum(s.count ?? 0);
        this.particles.burst(x, y, String(s.preset || 'sparks'), count > 0 ? { count } : {});
        return;
      }
      case 'vfx': {
        const to = s.to === 'self' ? ctx.self : s.to === 'other' ? ctx.other : undefined;
        void this.playVfx(String(s.effect ?? ''), this.target(ctx, s.from) ?? { x: this.camera.x + this.viewWidth / 2, y: this.camera.y + this.viewHeight / 2 }, to);
        return;
      }
      case 'saveGame':
        this.saveGame(String(s.slot || 'auto'));
        return;
      case 'loadGame':
        if (!this.loadGame(String(s.slot || 'auto'))) this.log(`no save in slot "${s.slot || 'auto'}"`);
        return;
      case 'playMusic':
        this.playMusic(String(s.music ?? ''), { fade: toNum(s.fade ?? 1), volume: toNum(s.volume ?? 0.6) });
        return;
      case 'stopMusic':
        this.stopMusic(toNum(s.fade ?? 1));
        return;
      case 'pauseGame':
        this.paused = s.paused !== false;
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
        case 'width': return this.screenWidth;
        case 'height': return this.screenHeight;
        case 'mouseX': return this.input.pointer ? this.input.pointer[0] / this.zoom + this.camera.x : 0;
        case 'mouseY': return this.input.pointer ? this.input.pointer[1] / this.zoom + this.camera.y : 0;
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

  /** A data table by name (throws a helpful error when missing). */
  table(name: string): DataTable {
    const t = this.data[name];
    if (!t) throw new Error(`no data table "${name}"${Object.keys(this.data).length ? ` (tables: ${Object.keys(this.data).join(', ')})` : ' (create one in the Data tab)'}`);
    return t;
  }

  row(table: string, id: string): DataRow | undefined {
    return this.table(table).rows.find((r) => r.id === id);
  }

  /** Expressions: db("table") = row count, db("table", id) = row exists, db("table", id, "column") = value. */
  private dbValue(args: Value[]): Value {
    const t = this.table(String(args[0] ?? ''));
    if (args.length < 2) return t.rows.length;
    const row = t.rows.find((r) => r.id === String(args[1]));
    if (args.length < 3) return !!row;
    if (!row) return 0;
    const v = cellValue(t, row, String(args[2]));
    return Array.isArray(v) ? v.join(', ') : v;
  }

  nearest(from: Actor, objectName: string): Actor | undefined {
    let best: Actor | undefined;
    let bd = Infinity;
    for (const o of this.actors) {
      if (o === from || o.destroyed || !this.isA(o, objectName)) continue;
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
          case 'count': return this.actors.filter((a) => !a.destroyed && this.isA(a, String(args[0]))).length;
          case 'hasSave': return this.hasSave(String(args[0] ?? 'auto'));
          case 'countTag': return this.actors.filter((a) => !a.destroyed && a.tags.has(String(args[0]))).length;
          case 'exists': return this.actors.some((a) => !a.destroyed && this.isA(a, String(args[0])));
          case 'keyDown': return this.input.down.has(String(args[0]));
          case 'keyPressed': return this.input.pressed.has(String(args[0]));
          case 'nearest': {
            if (!c.self) return 0;
            const n = this.nearest(c.self, String(args[0]));
            return n ? (this.actorField(n, String(args[1] ?? 'x')) ?? 0) : 0;
          }
          case 'db': return this.dbValue(args);
          case 'fn': {
            const name = String(args[0] ?? '');
            const f = this.scripts.functions.get(name) as ((...a: unknown[]) => unknown) | undefined;
            if (!f) throw new Error(`no script function "${name}" (define it with func("${name}", ...))`);
            const r = f(c.self ? this.scripts.handle(c.self) : undefined, c.other ? this.scripts.handle(c.other) : undefined, ...args.slice(1));
            if (r && typeof (r as Promise<unknown>).then === 'function') throw new Error(`fn("${name}") returned a promise: functions used in expressions must not be async`);
            return typeof r === 'number' || typeof r === 'string' || typeof r === 'boolean' ? r : r === undefined || r === null ? 0 : fmt(JSON.stringify(r));
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
  /** Is this expression true right now? For the end of a saved test. */
  test(src: string): boolean {
    return truthy(this.eval(src, {}));
  }

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

/**
 * ground: lies on the floor. stand: upright with its feet at x, y (view pixels). air: over everything. wall: stuck on the
 * front of a wall whose foot is at `foot`. top: lying on top of a wall `h` high. `z` is the object's draw order.
 */
export type WorldMark = { kind: 'backdrop' | 'ground' | 'air' | 'screen' } | { kind: 'stand'; x: number; y: number; z: number; solid?: { shape: HdShape; frame: { x: number; y: number; w: number; h: number } }; run?: { x0: number; f0: number; x1: number; f1: number } } | { kind: 'wall'; foot: number; z: number; relief?: number; run?: { x0: number; f0: number; x1: number; f1: number } } | { kind: 'top'; h: number; z: number };

export interface Renderer {
  clear(color: string): void;
  /** Draws part of a sprite's spritesheet. */
  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, opts: { white?: number; flipX: boolean; opacity: number; angle: number; scale?: number; flat?: boolean }): void;
  /** blend "add" adds light instead of painting over (glows). */
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number, blend?: 'add'): void;
  text(text: string, x: number, y: number, color: string, scale: number, font?: PixelFont): void;
  /** Multiplies the frame by the ambient color plus the lights, then adds their glow (scene atmosphere). */
  lighting?(ambient: string, lights: ScreenLight[], glow: number): void;
  /** Starts (or skips) recording sprite normals for this frame's reliefLighting. */
  beginRelief?(on: boolean, tiles?: boolean): void;
  /** Stops recording: what is drawn from now on doesn't change the normals (clouds, particles). */
  endRelief?(): void;
  /** Like lighting, but per pixel: lights and the sun shape the sprites with their normal maps. */
  reliefLighting?(relief: ResolvedRelief, ambient: string, lights: ScreenLight[], glow: number): void;
  /** A sprite frame read from its normals, one byte per pixel, row by row: 0 = empty, 1..255 = how far it turns from the viewer. Null when it stays flat. */
  spriteMask?(sprite: string, x: number, y: number, w: number, h: number): Uint8Array | null;
  /** Only the 2D-HD perspective has these. What the next draw calls are, in the world being drawn. */
  mark?(m: WorldMark): void;
  /** View pixels beyond each screen edge that are in view: the perspective sees more ground than the flat screen. */
  overscan?: { left: number; top: number; right: number; bottom: number };
  /** Rows of a wall's front (0: no walls), and one map tile standing up. */
  wallRows?: number;
  /** `sides`: where on the sheet the art of each row of the wall's side is; null = this tile adds no side. */
  tileWall?(sprite: string, sx: number, sy: number, sw: number, sh: number, x: number, y: number, size: number, cell: WallCell, sides: ([number, number] | null)[] | null): void;
  /** The world is finished, the interface comes next. Present only while 2D-HD is on; null = this scene stays flat. */
  endWorld?(frame: HdFrame | null): void;
  /** Soft-light color grade over the frame. */
  grade?(tint: string, amount: number): void;
  /** Darkens the screen edges. */
  vignette?(strength: number, color: string): void;
  /** Draws a whole cast shadow in one go, or only some of its rows; `shape` is the same object for as long as the shadow doesn't change, so it can be kept ready. */
  /** Mirrored strips, showing only over the water pieces. */
  reflections?(water: WaterPiece[], bands: ReflectionBand[], zoom: number): void;
  /** Whatever `draw` paints doesn't show over the water pieces (water takes no shadows), except where `dry` lies across them. */
  offWater?(water: WaterPiece[], dry: WaterPiece[], zoom: number, draw: () => void): void;
  stamp?(shape: CastShape, x: number, y: number, zoom: number, color: string, alpha: number, slice?: { row: number; rows: number }): void;
}

/** A renderer that draws nothing (headless UI). */
export const NULL_RENDERER: Renderer = { clear() {}, image() {}, rect() {}, text() {} };

/** Options for renderWorld. */
export interface RenderWorldOptions {
  /** false = stop right after the world (after endWorld, so 2D-HD blur and light are kept): no HUD objects, script UI,
   * messages, fade or dialogs. Default true. */
  ui?: boolean;
}

/** Draws the current world state with the camera applied. Coordinates are viewport pixels. */
export function renderWorld(w: World, r: Renderer, opts: RenderWorldOptions = {}): void {
  const scene = w.scene;
  const vw = w.game.width;
  const vh = w.game.height;
  r.clear(scene.background || w.game.background);
  r.beginRelief?.(!!scene.atmosphere?.relief, scene.atmosphere?.relief?.tiles !== false);
  const zoom = w.zoom;
  // Screen position of a world coordinate (round after zooming so zoomed pixels stay aligned).
  const zx = (v: number) => Math.round(v * zoom);
  const img = (k = 1) => ({ flipX: false, opacity: 1, angle: 0, ...(zoom * k !== 1 ? { scale: zoom * k } : {}) });
  let camX = w.camera.x;
  let camY = w.camera.y;
  if (w.clock < w.shake.until) {
    // Fades out over its duration.
    const k = w.shake.intensity * Math.min(1, (w.shake.until - w.clock) / Math.max(0.01, w.shake.duration));
    camX += (Math.random() * 2 - 1) * k;
    camY += (Math.random() * 2 - 1) * k;
  }
  // Snap to the zoomed pixel grid. What the camera follows sets the snap: rounded on its own, the camera would land on
  // a different pixel from the character, and the character would tremble by one pixel on the screen.
  const held = w.cameraHeld && !w.cameraHeld.destroyed ? w.cameraHeld : null;
  if (held) {
    camX = (Math.round(held.x * zoom) - Math.round((held.x - camX) * zoom)) / zoom;
    camY = (Math.round(held.y * zoom) - Math.round((held.y - camY) * zoom)) / zoom;
  } else {
    camX = Math.round(camX * zoom) / zoom;
    camY = Math.round(camY * zoom) / zoom;
  }

  r.mark?.({ kind: 'backdrop' });
  const over = r.overscan ?? { left: 0, top: 0, right: 0, bottom: 0 };
  for (const bg of scene.backgrounds) {
    const asset = w.bundle.sprites[bg.sprite];
    if (!asset || !asset.frames.length) continue;
    const f = asset.frames[0];
    const fw = f.w * zoom;
    const ox = zx(-camX * bg.parallax);
    const oy = zx(bg.y - camY * bg.parallax);
    if (bg.repeatX) {
      let start = ox % fw;
      if (start > 0) start -= fw;
      for (let x = start; x < vw; x += fw) r.image(bg.sprite, f.x, f.y, f.w, f.h, Math.round(x), oy, img());
    } else r.image(bg.sprite, f.x, f.y, f.w, f.h, ox, oy, img());
  }

  type Item = { z: number; order: number; draw: () => void };
  const items: Item[] = [];
  const ts = scene.tileSize;
  const tileset = scene.tileset ? w.bundle.sprites[scene.tileset] : undefined;
  scene.layers.forEach((layer, li) => {
    if (!layer.visible || !tileset || !tileset.frames.length) return;
    const grid = tileset.grid ?? { width: ts, height: ts };
    const tcols = Math.max(1, Math.floor(tileset.width / grid.width));
    // A tileset with several frames animates (water, lava, flowers): every tile shows the current frame.
    const f0 = tileset.frames[tilesetFrame(tileset, w.clock)];
    const par = layer.parallax ?? 1;
    items.push({
      z: layer.z ?? li - 10,
      order: li,
      draw: () => {
        const lx = camX * par;
        const ly = camY * par;
        const x0 = Math.max(0, Math.floor((lx - over.left / zoom) / ts));
        const y0 = Math.max(0, Math.floor((ly - over.top / zoom) / ts));
        const x1 = Math.min(scene.cols - 1, Math.floor((lx + (vw + over.right) / zoom) / ts));
        const y1 = Math.min(scene.rows - 1, Math.floor((ly + (vh + over.bottom) / zoom) / ts));
        r.mark?.({ kind: (layer.z ?? -10) > 0 ? 'air' : 'ground' });
        const walls = r.tileWall && r.wallRows ? w.wallMap(r.wallRows) : null;
        const resolver = w.tileResolver(tileset.name);
        // The ground stays clean: only walls and other solid layers take the light as relief.
        const opts = { ...img((ts / grid.width) || 1), flat: !layer.solid };
        const draw: number[] = [];
        const sideDraw: number[] = [];
        for (let ty = y0; ty <= y1; ty++) {
          for (let tx = x0; tx <= x1; tx++) {
            const t = layer.tiles[ty * scene.cols + tx];
            if (t < 0) continue;
            resolver.resolve(layer, scene.cols, scene.rows, tx, ty, draw, w.clock);
            let sidesDone = false;
            for (const d of draw) {
              const sx = f0.x + (d % tcols) * grid.width;
              const sy = f0.y + Math.floor(d / tcols) * grid.height;
              const wall = walls?.[ty * scene.cols + tx];
              // A wall also stays on the floor: where the view looks past its edge, the floor is what shows.
              if (!wall || !layer.solid) r.image(tileset.name, sx, sy, grid.width, grid.height, zx(tx * ts - lx), zx(ty * ts - ly), opts);
              if (wall) {
                let sides: ([number, number] | null)[] | null = null;
                if (!sidesDone) {
                  sides = wall && 'sides' in wall && wall.sides ? wall.sides.map((cell) => {
                    if (layer.tiles[cell]! < 0) return null;
                    resolver.resolve(layer, scene.cols, scene.rows, cell % scene.cols, Math.floor(cell / scene.cols), sideDraw, w.clock);
                    const t = sideDraw[0];
                    return t === undefined ? null : [f0.x + (t % tcols) * grid.width, f0.y + Math.floor(t / tcols) * grid.height];
                  }) : [];
                  sidesDone = true;
                }
                r.tileWall!(tileset.name, sx, sy, grid.width, grid.height, zx(tx * ts - lx), zx(ty * ts - ly), ts * zoom, wall, sides);
              }
            }
          }
        }
      },
    });
  });

  const atm = scene.atmosphere;
  // Reflections: right on the water, under the shadows and everything standing by it or lying across it.
  const reflect = atm?.reflections;
  const waterSheet = (): WaterSheet | null => {
    const grid = tileset ? (tileset.grid ?? { width: ts, height: ts }) : null;
    const tcols = tileset && grid ? Math.max(1, Math.floor(tileset.width / grid.width)) : 1;
    const f0 = tileset?.frames[0];
    return tileset && grid && f0 ? { name: tileset.name, tile: (t) => [f0.x + (t % tcols) * grid.width, f0.y + Math.floor(t / tcols) * grid.height], w: grid.width, h: grid.height } : null;
  };
  if (reflect && r.reflections) {
    const map = w.waterMap();
    if (map) items.push({ z: reflectionZ(map), order: 0, draw: () => {
      r.mark?.({ kind: 'ground' });
      drawReflections(r, reflect, map, w.actors, waterSheet(), ts, w.clock, camX, camY, zoom, vw, vh);
    } });
  }
  // Contact shadows: above the ground layers, below everything standing on them. Water that mirrors takes no shadows.
  if (atm) items.push({ z: -1.5, order: 0, draw: () => {
    r.mark?.({ kind: 'ground' });
    const shadows = () => drawShadows(w, r, atm, camX, camY, zoom);
    const map = reflect && r.offWater ? w.waterMap() : null;
    const over = r.overscan ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const water = map && reflect ? waterPieces(reflect, map, w.actors, waterSheet(), ts, camX, camY, zoom, vw, vh, over) : [];
    if (map && reflect && water.length) r.offWater!(water, waterDecals(reflect, map, w.actors, ts, camX, camY, zoom, vw, vh, over), zoom, shadows);
    else shadows();
  } });
  // Particles: behind the instances (above tiles), and in front of them.
  items.push({ z: -1, order: 1e9, draw: () => { r.mark?.({ kind: 'ground' }); w.particles.draw(r, camX, camY, zoom, true); if (!w.scripts.effectsInUi) w.vfx.draw(r, camX, camY, zoom, true); } });
  items.push({ z: 50, order: 1e9, draw: () => { r.mark?.({ kind: 'air' }); w.particles.draw(r, camX, camY, zoom, false); } });
  const hud: Actor[] = [];
  w.actors.forEach((a, i) => {
    if (a.type.hud) {
      hud.push(a);
      return;
    }
    // Off the screen: not sorted, not drawn. Most of a big map, every frame.
    if (a.asset?.frames.length && a.type.text === undefined) {
      const ox = a.type.spriteOffset?.x ?? 0;
      const oy = a.type.spriteOffset?.y ?? 0;
      const sx = (a.x + ox - camX) * zoom;
      const sy = (a.y + oy - camY) * zoom;
      if (sx + a.asset.width * zoom < -8 - over.left || sy + a.asset.height * zoom < -8 - over.top || sx > vw + 8 + over.right || sy > vh + 8 + over.bottom) return;
    }
    // A picture standing along a line on the ground: strips, each sorted by the ground under it. At a zoom that is not a
    // whole number (a zoom tween) strips could open seams: the picture is then drawn whole, like a swaying plant.
    if (a.footLine && a.asset?.frames.length && a.type.text === undefined && Number.isInteger(zoom)) {
      for (const strip of footStrips(a)) {
        items.push({ z: a.z, order: scene.ySort ? 1000 + strip.foot + i / 10000 : 1000 + i, draw: () => drawFootStrip(w, r, a, strip, camX, camY, zoom) });
      }
      return;
    }
    // y-sort: within the same z, instances lower on screen are drawn in front (top-down / RPG depth).
    const order = scene.ySort ? 1000 + a.box().y + a.box().h + i / 10000 : 1000 + i;
    items.push({ z: a.z, order, draw: () => {
      if (r.mark) r.mark(actorMark(w, r, a, camX, camY, zoom));
      drawActor(w, r, a, camX, camY, zoom);
    } });
  });
  items.sort((p, q) => p.z - q.z || p.order - q.order);
  for (const it of items) it.draw();
  r.endRelief?.();
  r.mark?.({ kind: 'air' });
  if (atm) {
    drawClouds(w, r, atm, camX, camY, zoom);
    w.motes.draw(r, camX, camY, zoom);
    w.motes2.draw(r, camX, camY, zoom);
    w.rain.draw(r, camX, camY, zoom);
    postProcess(w, r, atm, camX, camY, zoom);
    if (atm.shafts) drawShafts(r, atm.shafts, w.clock, camX, camY, zoom, vw, vh, [w.motes, w.motes2]);
    r.mark?.({ kind: 'screen' });
    w.rain.drawFlash(r, vw, vh);
    r.mark?.({ kind: 'air' });
  }
  // After the lighting: a fireball in a dark cave glows instead of being darkened with the scene.
  if (!w.scripts.effectsInUi) {
    w.vfx.draw(r, camX, camY, zoom, false);
    r.mark?.({ kind: 'screen' });
    w.vfx.drawScreen(r, vw, vh);
  }
  if (r.endWorld) {
    const hd = resolveHd(w.game.hd, atm?.hd, atm?.ambient);
    const box = held?.box();
    r.endWorld(hd && { hd, subjectY: box ? ((box.y + box.h / 2 - camY) * zoom) / vh : 0.55, lights: hd.halo > 0 && hd.darkness > 0 ? collectLights(w, camX, camY, zoom) : [] });
  }
  if (opts.ui === false) return;
  hud.sort((p, q) => p.z - q.z);
  const screen = scaledRenderer(r, w.uiScale);
  const sw = w.screenWidth;
  const sh = w.screenHeight;
  for (const a of hud) drawActor(w, screen, a, 0, 0);
  w.scripts.draw(r, camX, camY, zoom);

  if (w.message && w.clock < w.message.until) {
    const m = measureText(w.message.text, w.font);
    const s = m.width * 2 + 16 <= sw ? 2 : 1;
    const bw = m.width * s + 12;
    const bh = m.height * s + 12;
    const bx = Math.round((sw - bw) / 2);
    const by = Math.round(sh - bh - 8);
    screen.rect(bx, by, bw, bh, '#000000', 0.75);
    screen.rect(bx, by, bw, 1, '#ffffff', 0.5);
    screen.rect(bx, by + bh - 1, bw, 1, '#ffffff', 0.5);
    screen.text(w.message.text, bx + 6, by + 6, '#ffffff', s, w.font);
  }
  const fa = w.fadeAlpha;
  if (fa > 0) r.rect(0, 0, vw, vh, w.fade.color, fa);
  drawDialog(w, screen);
}

/** RPG-style dialog box with typewriter text, speaker name, portrait and choices. */
function drawDialog(w: World, r: Renderer): void {
  const d = w.scripts.dialog;
  if (!d) return;
  const vw = w.screenWidth;
  const vh = w.screenHeight;
  const portrait = d.portrait ? w.bundle.sprites[d.portrait] : undefined;
  const pad = 6;
  const pw = portrait ? Math.min(portrait.width, 48) + pad : 0;
  const font = w.font;
  const lineH = font.lineHeight / font.density;
  const lines = wrapText(d.text, Math.max(8, Math.floor((vw - 16 - pad * 2 - pw) / 4)) * 4 - 1, font);
  const textH = Math.max(3, lines.length) * lineH;
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
    const sw = measureText(d.speaker, font).width + 8;
    frame(bx + 4, by - 9, sw, 11);
    r.text(d.speaker, bx + 8, by - 6, '#ffcd75', 1, font);
  }
  let left = Math.floor(d.shown);
  lines.forEach((line, i) => {
    if (left <= 0) return;
    const part = line.slice(0, left);
    left -= line.length + 1;
    r.text(part, bx + pad + pw, by + pad + i * lineH, '#f4f4f4', 1, font);
  });
  const done = d.shown >= d.text.length;
  if (done && d.choices) {
    const cw = Math.max(...d.choices.map((c) => measureText(c, font).width)) + 19;
    const ch = d.choices.length * 8 + 8;
    const cx = vw - cw - 8;
    const cy = by - ch - (d.speaker ? 11 : 3);
    frame(cx, cy, cw, ch);
    d.choices.forEach((c, i) => {
      if (i === d.selected) r.text('>', cx + 4, cy + 5 + i * 8, '#ffcd75', 1, font);
      r.text(c, cx + 11, cy + 5 + i * 8, i === d.selected ? '#ffcd75' : '#f4f4f4', 1, font);
    });
  } else if (done && Math.floor(w.clock * 3) % 2 === 0) {
    r.rect(bx + bw - 9, by + bh - 7, 3, 2, '#f4f4f4');
    r.rect(bx + bw - 8, by + bh - 5, 1, 1, '#f4f4f4');
  }
}

/** Where an instance goes in the perspective. What is painted on a wall (a window, a relief) stays on it, as it is seen. */
function actorMark(w: World, r: Renderer, a: Actor, camX: number, camY: number, zoom: number): WorldMark {
  const b = a.box();
  const flat = (a.hdPose ?? a.type.hdPose ?? (a.z < 0 ? 'flat' : 'stand')) === 'flat';
  const s = w.scene;
  const ts = s.tileSize;
  const middle = b.x + b.w / 2;
  const tx = Math.floor(middle / ts);
  const ty = Math.floor((flat ? b.y + b.h / 2 : b.y + b.h - 1) / ts);
  const inMap = tx >= 0 && ty >= 0 && tx < s.cols && ty < s.rows;
  const cell = r.wallRows && inMap ? w.wallMap(r.wallRows)[ty * s.cols + tx] : null;
  const x = (middle - camX) * zoom;
  const y = (b.y + b.h - camY) * zoom;
  if (cell && 'face' in cell) return { kind: 'wall', foot: ((ty + cell.face + 1) * ts - camY) * zoom, z: a.z, relief: (a.type.hdRelief ?? 0) * zoom };
  if (cell) {
    const h = cell.cap * ts * zoom;
    return flat ? { kind: 'top', h, z: a.z } : { kind: 'stand', x, y: y + h, z: a.z };
  }
  const frame = a.asset?.frames[a.frameIndex()] ?? a.asset?.frames[0];
  // A flat sprite lifted above the ground (the top of a wall): lies where a wall cell's top lies, H pixels up.
  const lift = a.hdLift ?? a.type.hdLift ?? 0;
  if (flat && lift > 0) return { kind: 'top', h: lift * zoom, z: a.z };
  // An upright surface on its foot, like a wall's front: what is painted on it comes towards the camera as it goes up.
  if ((a.hdPose ?? a.type.hdPose) === 'wall') return { kind: 'wall', foot: y, z: a.z };
  return flat ? { kind: 'ground' } : { kind: 'stand', x, y, z: a.z, ...(a.type.hdShape && frame && !a.angle ? { solid: { shape: a.type.hdShape, frame } } : {}) };
}

/** Width of the strips a picture with a foot line is cut into: each takes the ground under its middle. */
const FOOT_STRIP = 4;
/** Cell of the index of solid instances, px. */
const SOLID_CELL = 64;
/** Boxes wider than this are paired apart in touchingPairs. */
const WIDE = 512;
/** Solid instances from which collisions use the grid index (fewer: the plain scan, as always). */
export const SOLID_INDEX_MIN = 256;

interface FootStrip {
  /** Columns of the frame, and the ground (world y) at each edge and in the middle. */
  c0: number;
  c1: number;
  f0: number;
  f1: number;
  foot: number;
}

/** Ground under each column of a picture with a foot line: linear between its points, flat past the ends. */
function footAt(line: [number, number][], ax: number, ay: number, c: number): number {
  const pts = line;
  if (c <= pts[0]![0]) return ay + pts[0]![1];
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1]!;
    const [x1, y1] = pts[k]!;
    if (c <= x1) return ay + (x1 === x0 ? y1 : y0 + ((c - x0) * (y1 - y0)) / (x1 - x0));
  }
  return ay + pts[pts.length - 1]![1];
}

/** Strips of an instance, kept until its frame width, foot line, place, mirroring or sprite offset change (M). */
const stripCache = new WeakMap<Actor, { key: string; line: [number, number][]; strips: FootStrip[] }>();

/**
 * The strips of a picture with a foot line. c0..c1 are columns of the sprite frame; the foot is read on the line at the
 * column where that part of the picture is shown (the instance's own coordinates): moved by the type's spriteOffset and
 * mirrored when the instance is flipped.
 */
function footStrips(a: Actor): FootStrip[] {
  const f = a.asset!.frames[a.frameIndex()] ?? a.asset!.frames[0]!;
  const line = a.footLine!;
  const ox = a.type.spriteOffset?.x ?? 0;
  const key = `${f.w}:${a.x}:${a.y}:${a.flipX ? 1 : 0}:${ox}`;
  const hit = stripCache.get(a);
  if (hit && hit.key === key && hit.line === line) return hit.strips;
  // shown column of sprite column c (instance coordinates)
  const shown = (c: number) => ox + (a.flipX ? f.w - c : c);
  // Strip edges: every point of the line, and every FOOT_STRIP columns in between.
  const cuts = new Set<number>([0, f.w]);
  for (const [x] of line) {
    const c = Math.round(a.flipX ? f.w - (x - ox) : x - ox);
    if (c > 0 && c < f.w) cuts.add(c);
  }
  for (let c = FOOT_STRIP; c < f.w; c += FOOT_STRIP) cuts.add(c);
  const xs = [...cuts].sort((p, q) => p - q);
  const out: FootStrip[] = [];
  for (let k = 1; k < xs.length; k++) {
    const c0 = xs[k - 1]!;
    const c1 = xs[k]!;
    // f0 at the strip's left edge ON SCREEN, f1 at its right edge
    const left = Math.min(shown(c0), shown(c1));
    const right = Math.max(shown(c0), shown(c1));
    const f0 = footAt(line, a.x, a.y, left);
    const f1 = footAt(line, a.x, a.y, right);
    out.push({ c0, c1, f0, f1, foot: footAt(line, a.x, a.y, (left + right) / 2) });
  }
  stripCache.set(a, { key, line, strips: out });
  return out;
}

function drawFootStrip(w: World, r: Renderer, a: Actor, s: FootStrip, camX: number, camY: number, zoom: number): void {
  if (!a.visible || a.destroyed) return;
  if (a.flashUntil > w.clock && Math.floor(w.clock * 12) % 2 === 0) return;
  const f = a.asset!.frames[a.frameIndex()] ?? a.asset!.frames[0]!;
  const off = a.type.spriteOffset;
  const x = Math.round((a.x + (off?.x ?? 0) - camX) * zoom);
  const y = Math.round((a.y + (off?.y ?? 0) - camY) * zoom);
  // where the strip is on screen: mirrored, sprite column c0..c1 is shown at f.w - c1 .. f.w - c0
  const d0 = a.flipX ? f.w - s.c1 : s.c0;
  const d1 = a.flipX ? f.w - s.c0 : s.c1;
  if (r.mark) {
    // Each column stands on the ground under it, its foot running from one edge of the strip to the other: facing the
    // camera (a ribbon, the strips meet at their edges), or with hdPose 'wall' an upright surface along the line.
    const sx0 = x + d0 * zoom;
    const sx1 = x + d1 * zoom;
    const run = { x0: sx0, f0: (s.f0 - camY) * zoom, x1: sx1, f1: (s.f1 - camY) * zoom };
    if ((a.hdPose ?? a.type.hdPose) === 'wall') r.mark({ kind: 'wall', foot: run.f0, z: a.z, run });
    else r.mark({ kind: 'stand', x: (sx0 + sx1) / 2, y: (s.foot - camY) * zoom, z: a.z, run });
  }
  r.image(a.asset!.name, f.x + s.c0, f.y, s.c1 - s.c0, f.h, x + d0 * zoom, y, { flipX: a.flipX, opacity: a.opacity, angle: 0, ...(zoom !== 1 ? { scale: zoom } : {}) });
}

function drawActor(w: World, r: Renderer, a: Actor, camX: number, camY: number, zoom = 1): void {
  if (!a.visible || a.destroyed) return;
  if (a.flashUntil > w.clock && Math.floor(w.clock * 12) % 2 === 0) return;
  const offset = a.asset ? a.type.spriteOffset : undefined;
  const x = Math.round((a.x + (offset?.x ?? 0) - camX) * zoom);
  const y = Math.round((a.y + (offset?.y ?? 0) - camY) * zoom);
  if (a.asset && a.asset.frames.length) {
    const f = a.asset.frames[a.frameIndex()] ?? a.asset.frames[0];
    const over = r.overscan;
    if (x + f.w * zoom < -8 - (over?.left ?? 0) || y + f.h * zoom < -8 - (over?.top ?? 0) || x > w.game.width + 8 + (over?.right ?? 0) || y > w.game.height + 8 + (over?.bottom ?? 0)) return;
    const opts = { flipX: a.flipX, opacity: a.opacity, angle: a.angle, ...(zoom !== 1 ? { scale: zoom } : {}) };
    // Bands need whole screen rows to meet without a seam; a zoom tween in progress draws the plant still.
    if (a.type.sway && !a.angle && Number.isInteger(zoom)) {
      for (const b of swayBands(a.type.sway, f.h, swayBase({ hitbox: hitboxOf(a, a.type), spriteOffset: a.type.spriteOffset }, f.h), a.x, a.y, w.clock, a.swayPush)) r.image(a.asset.name, f.x, f.y + b.row, f.w, b.rows, x + b.offset * zoom, y + b.row * zoom, opts);
    } else r.image(a.asset.name, f.x, f.y, f.w, f.h, x, y, opts);
  }
  if (a.type.text !== undefined && a.textOverride) {
    const s = Math.max(1, Math.round((a.type.textSize ?? 1) * zoom));
    const color = a.type.textColor ?? '#ffffff';
    // 1px drop shadow keeps HUD text readable on any background.
    const d = s / w.font.density;
    r.text(a.textOverride, x + d, y + d, '#000000', s, w.font);
    r.text(a.textOverride, x, y, color, s, w.font);
  }
}

/** For actors touching nothing, which are most of them. Never written to. */
const NO_TOUCH: Set<Actor> = new Set();

/**
 * Who touches whom. Boxes sorted by left edge only need comparing with the ones that start before they end, so scenes
 * with hundreds of props stay cheap. Pairs are recorded in actor order, so events fire in a stable order.
 */
/** Whether an actor reacts to what it touches: collision hooks in its components, or collision events of its type. */
function listensToTouch(a: Actor): boolean {
  return a.components.length > 0 || a.type.events.some((e) => e.trigger.type === 'collision' || e.trigger.type === 'overlapping');
}

/**
 * Pairs of live actors whose boxes overlap, as sets per actor, in the order a full sweep gives them. Only pairs where at
 * least one actor listens to touches can matter (collision hooks and events read them), so two inert pieces of scenery
 * that overlap (a painted map's bases and pictures) are never paired: same result for everything that reads it.
 */
export function touchingPairs(live: readonly Actor[], stats?: { checks: number }): Map<Actor, Set<Actor>> {
  const n = live.length;
  const boxes = live.map((a) => a.box());
  const listen = live.map(listensToTouch);
  const listeners = listen.reduce((c, l) => c + (l ? 1 : 0), 0);
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => boxes[i]!.x - boxes[j]!.x);
  const pairs: number[] = [];
  let checks = 0;
  if (listeners * 4 > n) {
    // Many listeners: the plain sweep (every pair once), keeping the pairs a listener can read.
    for (let a = 0; a < n; a++) {
      const i = order[a]!;
      const bi = boxes[i]!;
      const right = bi.x + bi.w;
      for (let b = a + 1; b < n; b++) {
        const j = order[b]!;
        const bj = boxes[j]!;
        if (bj.x >= right) break;
        checks++;
        if ((listen[i] || listen[j]) && overlap(bi, bj)) pairs.push(i < j ? i * n + j : j * n + i);
      }
    }
  } else {
    // Few listeners (a painted map: thousands of inert pieces): sweep along x from listeners only. Very wide boxes
    // (wider than WIDE px) are checked against every listener apart, so they don't make every leftward scan run to the start.
    const wide: number[] = [];
    let maxW = 0;
    for (let i = 0; i < n; i++) {
      if (boxes[i]!.w > WIDE) wide.push(i);
      else maxW = Math.max(maxW, boxes[i]!.w);
    }
    const pos = new Int32Array(n);
    order.forEach((i, k) => (pos[i] = k));
    for (let i = 0; i < n; i++) {
      if (!listen[i]) continue;
      const bi = boxes[i]!;
      for (let k = pos[i]! + 1; k < n; k++) {
        const j = order[k]!;
        const bj = boxes[j]!;
        if (bj.x >= bi.x + bi.w) break;
        checks++;
        if (overlap(bi, bj)) pairs.push(i < j ? i * n + j : j * n + i);
      }
      for (let k = pos[i]! - 1; k >= 0; k--) {
        const j = order[k]!;
        const bj = boxes[j]!;
        if (bj.x + maxW <= bi.x) break;
        checks++;
        if (overlap(bi, bj)) pairs.push(i < j ? i * n + j : j * n + i);
      }
      for (const j of wide) {
        if (j === i) continue;
        checks++;
        if (overlap(bi, boxes[j]!)) pairs.push(i < j ? i * n + j : j * n + i);
      }
    }
  }
  if (stats) stats.checks = checks;
  pairs.sort((p, q) => p - q);
  const out = new Map<Actor, Set<Actor>>();
  const add = (a: Actor, b: Actor) => {
    let set = out.get(a);
    if (!set) out.set(a, (set = new Set()));
    set.add(b);
  };
  let last = -1;
  for (const p of pairs) {
    if (p === last) continue;
    last = p;
    const i = Math.floor(p / n);
    const j = p % n;
    add(live[i]!, live[j]!);
    add(live[j]!, live[i]!);
  }
  return out;
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
  /** Global variables to start with (test later stages of a game). */
  vars?: Record<string, Value>;
  /** Put the player here when the first scene starts. */
  playerAt?: [number, number];
}

/** Runs the game headless. Async so script continuations (await say/wait...) run between frames. */
export async function runPlaytest(bundle: GameBundle, opts: PlaytestOptions): Promise<PlaytestResult> {
  const world = new World(bundle, {
    seed: opts.seed,
    scene: opts.scene,
    evaluator: opts.evaluator,
    autoDialog: opts.autoDialog === false ? undefined : { choices: [...(opts.choices ?? [])], delay: 0.4 },
    vars: opts.vars,
  });
  if (opts.playerAt) {
    const p = world.actors.find((a) => a.behaviors.some((b) => b.type === 'platformer' || b.type === 'topdown'));
    if (p) {
      p.x = p.startX = opts.playerAt[0];
      p.y = p.startY = opts.playerAt[1];
    }
  }
  const inputs = opts.inputs ?? [];
  const frames = Math.round(Math.min(600, Math.max(0, opts.seconds)) / STEP);
  const samples: PlaytestResult['samples'] = [];
  const sampleFrames = new Set((opts.sampleAt ?? []).map((s) => Math.round(s / STEP)));
  let prev = new Set<string>();
  // Steps of game time owed to the frames of real time (world.timeScale of them per frame, like the player).
  let owed = 0;
  let late = { pressed: new Set<string>(), released: new Set<string>(), clicks: [] as [number, number][] };
  for (let f = 0; f < frames; f++) {
    const down = new Set<string>();
    const clicks: [number, number][] = [];
    for (const i of inputs) {
      // Counted in whole frames: a recorded key must last exactly the frames it was held.
      const first = Math.round(i.at / STEP);
      if (i.key && f >= first && f < first + Math.max(1, Math.round((i.duration ?? 0.1) / STEP))) down.add(i.key);
      if (i.click && first === f) clicks.push(i.click);
    }
    const pressed = new Set([...down].filter((k) => !prev.has(k)));
    const released = new Set([...prev].filter((k) => !down.has(k)));
    for (const k of pressed) late.pressed.add(k);
    for (const k of released) late.released.add(k);
    late.clicks.push(...clicks);
    owed += world.timeScale;
    // A fraction of a step stays owed: at 0.5x every other frame runs one, at 1.5x they alternate one and two.
    while (owed >= 1 - 1e-9) {
      // Key presses and clicks go to the next step (a frame without one keeps them), held keys to all of them.
      world.step({ down, pressed: late.pressed, released: late.released, clicks: late.clicks, pointer: late.clicks[0] ?? null });
      await world.settle();
      owed -= 1;
      late = { pressed: new Set(), released: new Set(), clicks: [] };
    }
    // Headless: run the UI code too (menus and buttons in onDraw react to input there).
    world.scripts.draw(NULL_RENDERER, world.camera.x, world.camera.y, world.zoom);
    await world.settle();
    prev = down;
    if (sampleFrames.has(f + 1)) {
      samples.push(world.snapshot());
      opts.onSample?.(world);
    }
  }
  return { seconds: frames * STEP, logs: world.logs, final: world.snapshot(), samples, world };
}
