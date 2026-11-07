/**
 * Game project data model: the game (settings, object types, global variables) and its scenes.
 * Everything here is plain JSON so the editor, the MCP server and the exported runtime share it.
 */

export type Value = number | string | boolean;

/** One parameter value of a trigger, condition, action or behavior. Expressions are strings. */
export type Params = Record<string, Value>;

export interface EventTrigger {
  type: string;
  [param: string]: Value;
}

export interface EventStep {
  type: string;
  [param: string]: Value;
}

/** "When <trigger>, if all <conditions>, do <actions>." */
export interface GameEvent {
  /** Free text shown in the editor. */
  comment?: string;
  /** Disabled events are kept but never run. */
  disabled?: boolean;
  trigger: EventTrigger;
  conditions: EventStep[];
  actions: EventStep[];
}

/**
 * A behavior on an object type: a built-in one (platformer, solid...) or a script component
 * `{ type: "script", name: "Patrol", speed: 60 }` (the other keys are the component's params).
 */
export interface Behavior {
  type: string;
  [param: string]: Value;
}

/** Per-instance component settings: param overrides (and `enabled`), or components only this instance has. */
export type ComponentOverrides = Record<string, Record<string, Value>>;

export interface Hitbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A reusable kind of thing in the game: player, enemy, coin, door, score label... */
export interface ObjectType {
  name: string;
  /** Variant of another object type: inherits everything and stores only what it changes. */
  extends?: string;
  /** Sprite drawn for instances (a sprite in the workspace). Text objects can omit it. */
  sprite?: string;
  /** Default animation (sprite tag). Empty = all frames. */
  animation?: string;
  /** Collision box relative to the sprite's top-left corner. Default: the whole frame. */
  hitbox?: Hitbox;
  /** Draw order: higher is drawn in front. */
  z?: number;
  /** Text objects show the value of this expression (e.g. `"Score: " + score`). */
  text?: string;
  textColor?: string;
  /** Pixel scale of the text (1 = 4x6 font). */
  textSize?: number;
  /** Drawn in screen space, ignoring the camera (HUD). */
  hud?: boolean;
  /** Group tags ("enemy", "pickup") for scripts: self.hasTag(), findWithTag(), raycast/overlap filters. */
  tags?: string[];
  /** Instance variables with their default values (self.hp, self.speed...). */
  properties: Record<string, Value>;
  behaviors: Behavior[];
  events: GameEvent[];
}

export interface TileLayer {
  name: string;
  /** Row-major tile indices into the scene tileset, -1 = empty. Length = cols * rows. */
  tiles: number[];
  /** Tiles on this layer block movement. */
  solid: boolean;
  visible: boolean;
  /** Camera parallax factor (1 = moves with the world). */
  parallax?: number;
  /** Draw order relative to objects (objects default to z 0; layers default to -10 + index). */
  z?: number;
}

export interface Instance {
  id: string;
  object: string;
  /** Name shown in the hierarchy and used as the speaker in dialogues ("Mira", "Old Tom"). */
  name?: string;
  /** Draw this sprite instead of the object type's one (same NPC type, different characters). */
  sprite?: string;
  /** Start with this animation instead of the object type's one. */
  animation?: string;
  x: number;
  y: number;
  /** Overrides of the object's properties for this instance. */
  props?: Record<string, Value>;
  flipX?: boolean;
  /** Component param overrides by component name; a name the object type doesn't have adds that component. */
  components?: ComponentOverrides;
  /** Extra tags for this instance (added to the object type's). */
  tags?: string[];
}

export interface SceneBackground {
  sprite: string;
  parallax: number;
  repeatX: boolean;
  y: number;
}

export interface Scene {
  format: 'spritifer-scene';
  version: 1;
  name: string;
  /** Size in tiles. */
  cols: number;
  rows: number;
  /** Tile size in pixels (taken from the tileset grid when there is one). */
  tileSize: number;
  /** Tileset sprite (a sprite with a tile grid). */
  tileset?: string;
  background: string;
  backgrounds: SceneBackground[];
  layers: TileLayer[];
  instances: Instance[];
  events: GameEvent[];
  /** Draw instances lower on screen in front of higher ones (top-down / RPG depth). */
  ySort?: boolean;
  /** Remember placed instances when leaving the scene (positions, properties, destroyed ones): RPG towns. Restarting the scene forgets. */
  persistent?: boolean;
  /** Music when the scene starts: an audio file name, "-" for silence; absent = keep what plays. */
  music?: string;
  /** Scene variables (reset when the scene starts). Read as `scene.name`. */
  variables: Record<string, Value>;
  /** Scene components (managers, level logic, HUD): `{ type: "script", name, ...params }`. */
  components?: Behavior[];
  rev: string;
  updatedBy?: string;
}

export interface GameProject {
  format: 'spritifer-game';
  version: 1;
  title: string;
  /** Viewport size in game pixels. */
  width: number;
  height: number;
  /** "fit" scales by the largest integer that fits the window; a number forces that zoom. */
  zoom: 'fit' | number;
  background: string;
  startScene: string;
  /** Pixels per second squared, used by platformer and patrol behaviors. */
  gravity: number;
  /** Show on-screen d-pad and buttons on touch devices. */
  touchControls: boolean;
  /** Global variables with their initial values. Kept across scenes. */
  variables: Record<string, Value>;
  objects: ObjectType[];
  /** Global components, alive for the whole game across scenes (GameManager, Inventory, HUD). */
  components?: Behavior[];
  /**
   * Input actions: name → keys/buttons ("jump": ["space", "w", "pad:a"]). Scripts and events use the name
   * like a key. A name like "action" or "up" remaps that built-in key.
   */
  actions?: Record<string, string[]>;
  rev: string;
  updatedBy?: string;
}

export const GAME_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function assertIdentifier(kind: string, name: string): void {
  if (!GAME_NAME_RE.test(name)) throw new Error(`Invalid ${kind} name "${name}". Use letters, digits and "_", starting with a letter.`);
}

export function newGameId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createGame(opts: Partial<GameProject> = {}): GameProject {
  return normalizeGame({ ...opts });
}

export function createScene(opts: Partial<Scene> & { name: string }): Scene {
  return normalizeScene({ ...opts });
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

function vars(v: unknown): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') out[k] = x;
    }
  }
  return out;
}

/** Tags: identifiers, unique, from an array or a comma-separated string. */
export function normalizeTags(v: unknown): string[] | undefined {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [...new Set(list.map((t) => String(t).trim()).filter((t) => GAME_NAME_RE.test(t)))];
  return out.length ? out : undefined;
}

function overrides(v: unknown): ComponentOverrides | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: ComponentOverrides = {};
  for (const [k, x] of Object.entries(v)) if (GAME_NAME_RE.test(k) && x && typeof x === 'object') out[k] = vars(x);
  return Object.keys(out).length ? out : undefined;
}

/** Normalizes a list of script components ({ type: "script", name, ...params }). */
export function normalizeComponents(v: unknown): Behavior[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(step).map((b): Behavior => ({ ...b, type: 'script' })).filter((b) => typeof b.name === 'string' && b.name);
  return out.length ? out : undefined;
}

function step(v: unknown): EventStep {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: EventStep = { type: str(o.type, '') };
  for (const [k, x] of Object.entries(o)) {
    if (k === 'type') continue;
    if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') out[k] = x;
  }
  return out;
}

export function normalizeEvents(v: unknown): GameEvent[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const ev: GameEvent = {
      trigger: step(o.trigger),
      conditions: Array.isArray(o.conditions) ? o.conditions.map(step) : [],
      actions: Array.isArray(o.actions) ? o.actions.map(step) : [],
    };
    if (typeof o.comment === 'string' && o.comment) ev.comment = o.comment;
    if (o.disabled === true) ev.disabled = true;
    return ev;
  });
}

export function normalizeObject(v: unknown): ObjectType {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const obj: ObjectType = {
    name: str(o.name, 'object'),
    properties: vars(o.properties),
    behaviors: Array.isArray(o.behaviors) ? o.behaviors.map(step) : [],
    events: normalizeEvents(o.events),
  };
  if (typeof o.sprite === 'string' && o.sprite) obj.sprite = o.sprite;
  if (typeof o.animation === 'string' && o.animation) obj.animation = o.animation;
  const hb = o.hitbox as Record<string, unknown> | undefined;
  if (hb && typeof hb === 'object') obj.hitbox = { x: num(hb.x, 0), y: num(hb.y, 0), w: Math.max(1, num(hb.w, 8)), h: Math.max(1, num(hb.h, 8)) };
  if (typeof o.z === 'number') obj.z = o.z;
  if (typeof o.text === 'string') obj.text = o.text;
  if (typeof o.textColor === 'string') obj.textColor = o.textColor;
  if (typeof o.textSize === 'number') obj.textSize = Math.max(1, Math.round(o.textSize));
  if (o.hud === true) obj.hud = true;
  const tags = normalizeTags(o.tags);
  if (tags) obj.tags = tags;
  if (typeof o.extends === 'string' && o.extends && o.extends !== obj.name) obj.extends = o.extends;
  return obj;
}

export function normalizeGame(v: unknown): GameProject {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const zoom = o.zoom === 'fit' || o.zoom === undefined ? 'fit' : Math.max(1, Math.round(num(o.zoom, 1)));
  return {
    format: 'spritifer-game',
    version: 1,
    title: str(o.title, 'My Game'),
    width: Math.max(16, Math.min(1920, Math.round(num(o.width, 320)))),
    height: Math.max(16, Math.min(1080, Math.round(num(o.height, 180)))),
    zoom,
    background: str(o.background, '#181425'),
    startScene: str(o.startScene, ''),
    gravity: num(o.gravity, 900),
    touchControls: bool(o.touchControls, true),
    variables: vars(o.variables),
    objects: Array.isArray(o.objects) ? o.objects.map(normalizeObject) : [],
    ...(normalizeComponents(o.components) ? { components: normalizeComponents(o.components) } : {}),
    ...(normalizeActions(o.actions) ? { actions: normalizeActions(o.actions) } : {}),
    rev: str(o.rev, newGameId()),
    ...(typeof o.updatedBy === 'string' ? { updatedBy: o.updatedBy } : {}),
  };
}

/** Input actions: identifier → unique key names (lowercase, e.g. "space", "arrowup", "pad:a"). */
export function normalizeActions(v: unknown): Record<string, string[]> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, keys] of Object.entries(v)) {
    if (!GAME_NAME_RE.test(k)) continue;
    const list = (Array.isArray(keys) ? keys : typeof keys === 'string' ? keys.split(',') : []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z0-9:_-]{1,24}$/.test(x));
    out[k] = [...new Set(list)];
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeScene(v: unknown): Scene {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const cols = Math.max(1, Math.min(1024, Math.round(num(o.cols, 40))));
  const rows = Math.max(1, Math.min(1024, Math.round(num(o.rows, 23))));
  const size = cols * rows;
  const layers: TileLayer[] = (Array.isArray(o.layers) ? o.layers : []).map((l: unknown, i: number) => {
    const L = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const src = Array.isArray(L.tiles) ? (L.tiles as unknown[]) : [];
    const tiles = new Array<number>(size);
    for (let k = 0; k < size; k++) {
      const t = src[k];
      tiles[k] = typeof t === 'number' && Number.isInteger(t) && t >= 0 ? t : -1;
    }
    const layer: TileLayer = { name: str(L.name, `layer${i + 1}`), tiles, solid: bool(L.solid, false), visible: bool(L.visible, true) };
    if (typeof L.parallax === 'number') layer.parallax = L.parallax;
    if (typeof L.z === 'number') layer.z = L.z;
    return layer;
  });
  if (!layers.length) layers.push({ name: 'ground', tiles: new Array(size).fill(-1), solid: true, visible: true });
  const instances: Instance[] = (Array.isArray(o.instances) ? o.instances : []).map((x: unknown) => {
    const I = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const inst: Instance = { id: str(I.id, newGameId()), object: str(I.object, ''), x: num(I.x, 0), y: num(I.y, 0) };
    const props = vars(I.props);
    if (Object.keys(props).length) inst.props = props;
    if (I.flipX === true) inst.flipX = true;
    if (typeof I.name === 'string' && I.name) inst.name = I.name;
    if (typeof I.sprite === 'string' && I.sprite) inst.sprite = I.sprite;
    if (typeof I.animation === 'string' && I.animation) inst.animation = I.animation;
    const comps = overrides(I.components);
    if (comps) inst.components = comps;
    const itags = normalizeTags(I.tags);
    if (itags) inst.tags = itags;
    return inst;
  });
  const backgrounds: SceneBackground[] = (Array.isArray(o.backgrounds) ? o.backgrounds : []).map((b: unknown) => {
    const B = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return { sprite: str(B.sprite, ''), parallax: num(B.parallax, 0.5), repeatX: bool(B.repeatX, true), y: num(B.y, 0) };
  });
  return {
    format: 'spritifer-scene',
    version: 1,
    name: str(o.name, 'scene'),
    cols,
    rows,
    tileSize: Math.max(1, Math.min(256, Math.round(num(o.tileSize, 16)))),
    ...(typeof o.tileset === 'string' && o.tileset ? { tileset: o.tileset } : {}),
    background: str(o.background, ''),
    backgrounds,
    layers,
    instances,
    events: normalizeEvents(o.events),
    ...(o.ySort === true ? { ySort: true } : {}),
    ...(o.persistent === true ? { persistent: true } : {}),
    ...(typeof o.music === 'string' && o.music ? { music: o.music } : {}),
    variables: vars(o.variables),
    ...(normalizeComponents(o.components) ? { components: normalizeComponents(o.components) } : {}),
    rev: str(o.rev, newGameId()),
    ...(typeof o.updatedBy === 'string' ? { updatedBy: o.updatedBy } : {}),
  };
}

/** Resizes a scene's tile layers, keeping the top-left content. */
export function resizeScene(scene: Scene, cols: number, rows: number): void {
  cols = Math.max(1, Math.min(1024, Math.round(cols)));
  rows = Math.max(1, Math.min(1024, Math.round(rows)));
  for (const l of scene.layers) {
    const next = new Array<number>(cols * rows).fill(-1);
    for (let y = 0; y < Math.min(rows, scene.rows); y++) {
      for (let x = 0; x < Math.min(cols, scene.cols); x++) next[y * cols + x] = l.tiles[y * scene.cols + x];
    }
    l.tiles = next;
  }
  scene.cols = cols;
  scene.rows = rows;
}

export function findObject(game: GameProject, name: string): ObjectType | undefined {
  return game.objects.find((o) => o.name === name);
}

// ---------------------------------------------------------------------------
// Assets as the runtime sees them: one spritesheet image per sprite + frame metadata.

export interface AssetFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  duration: number;
  /** Animation events of this frame. */
  events?: string[];
}

export interface AssetTag {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'reverse' | 'pingpong';
}

export interface SpriteAsset {
  name: string;
  /** Frame size. */
  width: number;
  height: number;
  frames: AssetFrame[];
  tags: AssetTag[];
  grid: { width: number; height: number } | null;
  /** Spritesheet image (data URL) in exported games; absent in headless runs. */
  image?: string;
}

/** Everything needed to run the game. */
export interface GameBundle {
  game: GameProject;
  scenes: Record<string, Scene>;
  sprites: Record<string, SpriteAsset>;
  /** Script sources by name (scripts/<name>.js). */
  scripts?: Record<string, string>;
  /** Dialogue sources by file name (dialogues/<name>.dialogue). */
  dialogues?: Record<string, string>;
  /** Audio files by name (audio/<name>.mp3...): data URLs in played/exported games, "" in headless runs. */
  audio?: Record<string, string>;
}
