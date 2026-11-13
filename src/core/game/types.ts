/**
 * Game project data model: the game (settings, object types, global variables) and its scenes.
 * Everything here is plain JSON so the editor, the MCP server and the exported runtime share it.
 */

import { type FineSolidData, decodeFineSolid, encodeFineSolid } from './fineSolid.js';
import { type TilesetRules, normalizeTilesetRules } from './tilerules.js';
import type { SpriteRelief } from '../sprite.js';
import type { VfxGraph } from './vfxGraph.js';
import { BUILTIN_FONT, FONTS } from './font.js';
import { type Blueprint, normalizeBlueprint } from './blueprint.js';
import type { MapKit } from './blueprintBake.js';
import { HD_SHAPES, type HdShape } from './hd3d.js';
import { type GameHd, type HdCells, type HdJut, type SceneHd, normalizeHd, normalizeHdCells, normalizeHdJuts } from './hd.js';
import type { ScatterRecipe, SceneGroup } from './sceneOps.js';

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
  /** Draws the sprite shifted from the instance position, so a larger canvas keeps the same position, hitbox and scene layout. */
  spriteOffset?: { x: number; y: number };
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
  /** Light the instance gives off (lamps, fires, crystals, magic). Seen when the scene has an ambient darker than white, and as glow. */
  light?: LightDef;
  /** Soft contact shadow under the instance: width in px (0 = none). Absent = automatic (hitbox width) when the scene has shadows. */
  shadow?: number;
  /**
   * In the 2D-HD perspective: lies on the ground ('flat'), stands up facing the camera ('stand'), or stands as an upright
   * surface like a wall's front ('wall': its top comes towards the camera, so it meets a wall top lifted by hdLift).
   * Absent = flat when its z is below 0, else stand.
   */
  hdPose?: 'flat' | 'stand' | 'wall';
  /** In the 2D-HD perspective, pixels a sprite hung on a wall stands out from it (a relief, a statue in a niche). */
  hdRelief?: number;
  /** In the 2D-HD perspective, a flat sprite lies this many pixels above the ground (the top of a wall): it lies where the ground is that many pixels further down the picture. */
  hdLift?: number;
  /** In the 2D-HD perspective, the solid a standing sprite is wrapped on: a column is round, a pillar has corners. */
  hdShape?: HdShape;
  /** Moved by the wind when drawn (trees, tall plants): the hitbox and the art don't change. */
  sway?: ObjectSway;
  /** Sound looping around the instance (fires, fountains): louder the closer the camera is. */
  ambientSound?: ObjectAmbientSound;
  /** Instance variables with their default values (self.hp, self.speed...). */
  properties: Record<string, Value>;
  behaviors: Behavior[];
  events: GameEvent[];
}

/** How the wind moves an object. */
export interface ObjectSway {
  /** Pixels the top of the sprite travels (trunk and foot stay still). */
  amount: number;
  /** 1 = normal, 2 = twice as fast (default 1). */
  speed?: number;
  /** Pixels a character walking through pushes the top aside, springing back after (grass, ferns). Default 0. */
  react?: number;
}

/** A sound that loops around an object. */
export interface ObjectAmbientSound {
  /** Audio file name. */
  sound: string;
  /** Volume next to it, 0..1 (default 0.4). */
  volume?: number;
  /** Heard up to this many pixels from the middle of the screen (default 160). */
  radius?: number;
}

/** A sound that loops for as long as the scene lasts. */
export interface SceneAmbience {
  /** Audio file name. */
  sound: string;
  /** 0..1 (default 0.4). */
  volume?: number;
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
  /**
   * A ground painted as one picture (every cell its own piece of the painting): its tiles say nothing about which solid
   * cells are masonry, so 2D-HD does not raise walls from it. What stands up there are the objects; hdCells still apply.
   */
  painted?: boolean;
}

/** A point light. Offsets are from the center of the sprite. */
export interface LightDef {
  /** Reach in pixels. */
  radius: number;
  color?: string;
  /** 0..2 (default 1). */
  intensity?: number;
  /** 0..1: how much it flickers (fire ~0.15, crystals 0). */
  flicker?: number;
  /** Slow breathing pulse 0..1 (magic, crystals). */
  pulse?: number;
  x?: number;
  y?: number;
}

/** Ambient particles that float in view (fireflies, dust motes, snow, embers, falling leaves). */
export interface SceneMotes {
  preset: 'fireflies' | 'dust' | 'snow' | 'embers' | 'leaves' | 'spores' | 'bubbles';
  /** Particles on screen at once (default 24). */
  count?: number;
  /** Override the preset colors. */
  color?: string | string[];
}

/** Rain over the scene, with lightning if asked. */
export interface SceneRain {
  /** Drops at once (default 140). */
  count?: number;
  /** Slant in degrees (default 12). */
  angle?: number;
  /** Pixels per second (default 420). */
  speed?: number;
  color?: string;
  /** 0..1 (default 0.42). */
  opacity?: number;
  /** Little splashes where drops land (default true). */
  splashes?: boolean;
  /** Flashes of lightning per minute (default 0). */
  lightning?: number;
  flashColor?: string;
  /** Audio file played a moment after each flash. */
  thunder?: string;
}

/** Shafts of light through the air. */
export interface SceneShafts {
  /** How many fit in a screen's width, before gaps (default 5). */
  count?: number;
  color?: string;
  /** 0..1 (default 0.14). */
  opacity?: number;
  /** Slant in degrees (default 22). */
  angle?: number;
  /** Pixels (default 30). */
  width?: number;
}

/** Water that mirrors what stands by it. Tiles that animate count as water by themselves. */
export interface SceneReflections {
  /** 0..1 (default 0.32). */
  opacity?: number;
  /** Pixels the image trembles sideways (default 1). */
  wobble?: number;
  /** Sprites of instances that are water too (a canal laid over a dry bed). */
  sprites?: string[];
}

/** Lighting and atmosphere of a scene: what makes it feel like a place and not a grid. */
export interface SceneAtmosphere {
  /** Multiplied over the world: "#ffffff" = plain daylight, "#ffe8d0" warm afternoon, "#6a6aa8" dusk, "#2a2c50" night/caves. Lights cut through it. */
  ambient?: string;
  /** How much lights add a glow on top (bloom), 0..2 (default 0.6). */
  glow?: number;
  /** Soft contact shadows under instances (default true). */
  shadows?: boolean;
  /** Shadow color (default a cool dark purple) and opacity 0..1 (default 0.38). */
  shadowColor?: string;
  shadowOpacity?: number;
  /** Darken the screen edges 0..1. */
  vignette?: number;
  vignetteColor?: string;
  /** Drifting cloud shadows: a tileable sprite (dark blobs on transparent) moved by the wind. */
  clouds?: { sprite: string; opacity?: number; speedX?: number; speedY?: number };
  /** Color grade: blend a tint over the frame (sunset orange, cold blue), 0..1. */
  tint?: string;
  tintAmount?: number;
  motes?: SceneMotes;
  /** A second kind of particles over the first (dust and falling leaves together). */
  motes2?: SceneMotes;
  rain?: SceneRain;
  shafts?: SceneShafts;
  reflections?: SceneReflections;
  /** Per-pixel lighting: lights and the sun shape the volumes of the sprites. */
  relief?: SceneRelief;
  /** This scene's own 2D-HD settings, over the game's. */
  hd?: SceneHd;
}

/** Per-pixel lighting of a scene. */
export interface SceneRelief {
  /** How strongly the light shapes the sprites, 0..2 (default 1). */
  strength?: number;
  /** Light steps on the sprites, 0 = smooth (default 4). */
  bands?: number;
  /** Light caught on the edges facing it, 0..2 (default 0.9). */
  rim?: number;
  /** Height of point lights as a fraction of their radius, 0.05..2 (default 0.3). Lower = more dramatic. */
  lightHeight?: number;
  /** Tiles on solid layers (walls, treetops) take the light too; the ground stays clean (default true). */
  tiles?: boolean;
  sun?: SceneSun;
}

export interface SceneSun {
  /** Direction of the sun on screen in degrees: 0 = right, 90 = down, -90 = up (default -135, top left). */
  angle?: number;
  /** Height over the horizon in degrees, 5..90 (default 50). */
  elevation?: number;
  color?: string;
  /** 0..3 (default 1). */
  intensity?: number;
  /** Color of the side away from the sun (default a soft blue-violet). */
  shade?: string;
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
  /**
   * Expression: the instance exists only while it is true (e.g. `armoryLevel >= 2`, `quest_ring == 2`).
   * Checked when the scene starts and continuously while it runs: the instance appears or disappears
   * (a disappearing one is not "destroyed": it comes back when the condition holds again). Towns that grow.
   */
  activeIf?: string;
  /** Light of this instance (overrides the object type's; null-like radius 0 = no light). */
  light?: LightDef;
  /** Named group inside the scene, for working on many instances at once (trees, decor); the game ignores it. */
  group?: string;
  /** In the 2D-HD perspective: 'flat', 'stand' or 'wall' (see ObjectType.hdPose), over what its object type says. */
  hdPose?: 'flat' | 'stand' | 'wall';
  /** Draw order, over what its object type says. */
  order?: number;
  /**
   * Collision box of this instance, over its object type's (relative to the instance, like the type's). It is also the
   * box the y-sort and the 2D-HD foot read: a picture cut out of a painted map stands where its base is.
   */
  hitbox?: Hitbox;
  /** In the 2D-HD perspective, a flat instance lies this many pixels above the ground (a wall top), over its object type's. */
  hdLift?: number;
  /**
   * The line where this picture meets the ground, left to right, as points [x, y] relative to the instance: a painted
   * object that runs at an angle (a long wall, an aqueduct seen askew). In 2D it is drawn in vertical strips, each sorted by
   * the ground under it. In 2D-HD each column stands on the ground under it, facing the camera like any standing sprite,
   * as one continuous ribbon; with hdPose 'wall' it is instead an upright surface along the line, whose top meets a wall
   * top lifted by hdLift exactly. A tall 'wall' grows towards the camera, so it is meant for low wall fronts.
   */
  footLine?: [number, number][];
}

/** Why a foot line is not usable as given: points go left to right, x strictly increasing (a vertical jump is not supported). */
export function footLineProblem(line: [number, number][]): string | null {
  for (let k = 1; k < line.length; k++) {
    if (line[k]![0] < line[k - 1]![0]) return `foot line: x goes back at point ${k} (${line[k - 1]![0]} then ${line[k]![0]}); points go left to right`;
    if (line[k]![0] === line[k - 1]![0]) return `foot line: points ${k - 1} and ${k} have the same x (${line[k]![0]}); a vertical jump is not supported, give the slope a width`;
  }
  return null;
}

/** Keeps a fine collision that fits the scene; one that doesn't is dropped and the reason kept for the validator. */
function normalizeFine(v: unknown, cols: number, rows: number, tileSize: number): { collisionFine?: FineSolidData; collisionFineError?: string } {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const d: FineSolidData = { cell: Number(o.cell), cols: Number(o.cols), rows: Number(o.rows), rle: typeof o.rle === 'string' ? o.rle : '' };
  const r = decodeFineSolid(d, cols * tileSize, rows * tileSize);
  return r.fine ? { collisionFine: d } : { collisionFineError: r.error };
}

/** The hitbox that counts for a placed instance or an actor: its own, else its object type's. The one place to read it. */
export function hitboxOf(inst: { hitbox?: Hitbox | (() => Hitbox); instHitbox?: Hitbox } | undefined, type: { hitbox?: Hitbox } | undefined): Hitbox | undefined {
  // An actor carries it as instHitbox (its hitbox() is the resolved, mirrored box); a placed instance as hitbox.
  const own = inst?.instHitbox ?? (typeof inst?.hitbox === 'object' ? inst.hitbox : undefined);
  return own ?? type?.hitbox;
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
  /** Corrections to the automatic walls of the 2D-HD perspective. */
  hdCells?: HdCells;
  /** Stretches of wall fronts that stand forward in the 2D-HD perspective (piers). */
  hdJuts?: HdJut[];
  /** Fine collision: small solid cells (see fineSolid.ts), for obstacles painted rather than tiled. Always solid; story blocks stay instances. */
  collisionFine?: FineSolidData;
  /** Why a stored collisionFine was left out (sizes that don't match the scene): the validator reports it. */
  collisionFineError?: string;
  /** Music when the scene starts: an audio file name, "-" for silence; absent = keep what plays. */
  music?: string;
  /** Sounds that loop while the scene lasts (wind, crickets, dripping): they fade across scene changes. */
  ambience?: SceneAmbience[];
  /** Scene variables (reset when the scene starts). Read as `scene.name`. */
  variables: Record<string, Value>;
  /** Scene components (managers, level logic, HUD): `{ type: "script", name, ...params }`. */
  components?: Behavior[];
  /** Lighting, shadows, clouds, color grade and ambient particles. */
  atmosphere?: SceneAtmosphere;
  /** How groups of instances were made, so they can be redone. */
  groups?: Record<string, SceneGroup>;
  /** What this map is made from: tiles, walls and instances are compiled from it. */
  blueprint?: Blueprint;
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
  /** Interface pixels are this many canvas pixels: scripts and dialogs work in width/uiScale × height/uiScale. Scenes without a Camera zoom the same. Default 1. */
  uiScale?: number;
  /** Id of the font all text draws with (see FONTS). Absent = the built-in 3x5. */
  font?: string;
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
  /** Tileset rules by tileset sprite name: autotiling, big seamless textures, random variants, edge overlays. */
  tilesets?: Record<string, TilesetRules>;
  /** Architecture kits blueprints are built with, by name. */
  mapKits?: Record<string, MapKit>;
  /** Android export settings. */
  android?: AndroidSettings;
  /** Auto 2D-HD: how the whole game looks with it on, and whether it starts on. */
  hd?: GameHd;
  rev: string;
  updatedBy?: string;
}

export interface AndroidSettings {
  /** Application id ("com.yourname.game"). Absent = derived from the title. */
  package?: string;
  /** Version shown to players. Absent = "1.0". */
  version?: string;
  /** Sprite used as app icon. Absent = a sprite named "icon", else the first object's. */
  icon?: string;
}

export const ANDROID_PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** The title as a file name: lowercase letters, digits and dashes. */
export function gameSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
}

/** The Android application id of a game. */
export function androidPackage(game: Pick<GameProject, 'title' | 'android'>): string {
  const name = gameSlug(game.title).replace(/-/g, '');
  return game.android?.package ?? `com.spritifer.${/^[a-z]/.test(name) ? name : `g${name}`}`;
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
  const so = o.spriteOffset as Record<string, unknown> | undefined;
  if (so && typeof so === 'object') obj.spriteOffset = { x: num(so.x, 0), y: num(so.y, 0) };
  if (typeof o.z === 'number') obj.z = o.z;
  if (typeof o.text === 'string') obj.text = o.text;
  if (typeof o.textColor === 'string') obj.textColor = o.textColor;
  if (typeof o.textSize === 'number') obj.textSize = Math.max(1, Math.round(o.textSize));
  if (o.hud === true) obj.hud = true;
  const tags = normalizeTags(o.tags);
  if (tags) obj.tags = tags;
  if (typeof o.extends === 'string' && o.extends && o.extends !== obj.name) obj.extends = o.extends;
  const light = normalizeLight(o.light);
  if (light) obj.light = light;
  if (typeof o.shadow === 'number' && Number.isFinite(o.shadow)) obj.shadow = Math.max(0, Math.round(o.shadow));
  if (o.hdPose === 'flat' || o.hdPose === 'stand' || o.hdPose === 'wall') obj.hdPose = o.hdPose;
  if (typeof o.hdLift === 'number' && o.hdLift > 0) obj.hdLift = o.hdLift;
  if (typeof o.hdRelief === 'number' && o.hdRelief > 0) obj.hdRelief = Math.min(40, Math.round(o.hdRelief));
  if ((HD_SHAPES as readonly unknown[]).includes(o.hdShape)) obj.hdShape = o.hdShape as HdShape;
  const sway = normalizeSway(o.sway);
  if (sway) obj.sway = sway;
  const ambientSound = normalizeAmbientSound(o.ambientSound);
  if (ambientSound) obj.ambientSound = ambientSound;
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
    ...(num(o.uiScale, 1) > 1 ? { uiScale: Math.min(8, Math.round(num(o.uiScale, 1))) } : {}),
    ...(typeof o.font === 'string' && o.font !== BUILTIN_FONT.id && FONTS.some((f) => f.id === o.font) ? { font: o.font } : {}),
    background: str(o.background, '#181425'),
    startScene: str(o.startScene, ''),
    gravity: num(o.gravity, 900),
    touchControls: bool(o.touchControls, true),
    ...(normalizeHd(o.hd) ? { hd: normalizeHd(o.hd) } : {}),
    variables: vars(o.variables),
    objects: Array.isArray(o.objects) ? o.objects.map(normalizeObject) : [],
    ...(normalizeComponents(o.components) ? { components: normalizeComponents(o.components) } : {}),
    ...(normalizeActions(o.actions) ? { actions: normalizeActions(o.actions) } : {}),
    ...(normalizeTilesets(o.tilesets) ? { tilesets: normalizeTilesets(o.tilesets) } : {}),
    ...(o.mapKits && typeof o.mapKits === 'object' ? { mapKits: o.mapKits as Record<string, MapKit> } : {}),
    ...(normalizeAndroid(o.android) ? { android: normalizeAndroid(o.android) } : {}),
    rev: str(o.rev, newGameId()),
    ...(typeof o.updatedBy === 'string' ? { updatedBy: o.updatedBy } : {}),
  };
}

function normalizeAndroid(v: unknown): AndroidSettings | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: AndroidSettings = {};
  for (const k of ['package', 'version', 'icon'] as const) {
    const s = o[k];
    if (typeof s === 'string' && s.trim()) out[k] = s.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeTilesets(v: unknown): Record<string, TilesetRules> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, TilesetRules> = {};
  for (const [k, r] of Object.entries(v)) {
    const n = normalizeTilesetRules(r);
    if (n) out[k] = n;
  }
  return Object.keys(out).length ? out : undefined;
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

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const clampN = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
const colorOr = (v: unknown): string | undefined => (typeof v === 'string' && COLOR_RE.test(v) ? v : undefined);
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A wind setting, or undefined when it wouldn't move anything. */
export function normalizeSway(v: unknown): ObjectSway | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const S = v as Record<string, unknown>;
  const amount = clampN(S.amount, 0, 24);
  if (!amount) return undefined;
  const speed = clampN(S.speed, 0.1, 5);
  const react = clampN(S.react, 0, 24);
  return { amount, ...(speed !== undefined && speed !== 1 ? { speed } : {}), ...(react ? { react } : {}) };
}

/** A looping sound of an object, or undefined. */
export function normalizeAmbientSound(v: unknown): ObjectAmbientSound | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const A = v as Record<string, unknown>;
  if (typeof A.sound !== 'string' || !A.sound) return undefined;
  return compact({ sound: A.sound, volume: clampN(A.volume, 0, 1), radius: clampN(A.radius, 8, 4096) });
}

/** The looping sounds of a scene, or undefined when there are none. */
export function normalizeAmbience(v: unknown): SceneAmbience[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.flatMap((x): SceneAmbience[] => {
    const L = x as Record<string, unknown> | null;
    return L && typeof L === 'object' && typeof L.sound === 'string' && L.sound ? [compact({ sound: L.sound, volume: clampN(L.volume, 0, 1) })] : [];
  });
  return list.length ? list : undefined;
}

/** A light definition, or undefined. With allowOff a radius 0 light is kept (an instance switching its type's light off). */
export function normalizeLight(v: unknown, allowOff = false): LightDef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const L = v as Record<string, unknown>;
  const radius = clampN(L.radius, 0, 1024);
  if (radius === undefined || (!radius && !allowOff)) return undefined;
  return compact({ radius, color: colorOr(L.color), intensity: clampN(L.intensity, 0, 4), flicker: clampN(L.flicker, 0, 1), pulse: clampN(L.pulse, 0, 1), x: clampN(L.x, -4096, 4096), y: clampN(L.y, -4096, 4096) });
}

export const MOTE_PRESETS = ['fireflies', 'dust', 'snow', 'embers', 'leaves', 'spores', 'bubbles'] as const;

export function normalizeAtmosphere(v: unknown): SceneAtmosphere | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const A = v as Record<string, unknown>;
  const C = A.clouds as Record<string, unknown> | undefined;
  const moteLayer = (M: Record<string, unknown> | undefined): SceneMotes | undefined =>
    M && typeof M === 'object' && (MOTE_PRESETS as readonly string[]).includes(String(M.preset))
      ? compact({ preset: M.preset as SceneMotes['preset'], count: clampN(M.count, 0, 400), color: Array.isArray(M.color) ? M.color.filter((c): c is string => !!colorOr(c)) : colorOr(M.color) })
      : undefined;
  const out: SceneAtmosphere = compact({
    ambient: colorOr(A.ambient),
    glow: clampN(A.glow, 0, 2),
    shadows: typeof A.shadows === 'boolean' ? A.shadows : undefined,
    shadowColor: colorOr(A.shadowColor),
    shadowOpacity: clampN(A.shadowOpacity, 0, 1),
    vignette: clampN(A.vignette, 0, 1),
    vignetteColor: colorOr(A.vignetteColor),
    clouds: C && typeof C === 'object' && typeof C.sprite === 'string' && C.sprite ? compact({ sprite: C.sprite, opacity: clampN(C.opacity, 0, 1), speedX: clampN(C.speedX, -500, 500), speedY: clampN(C.speedY, -500, 500) }) : undefined,
    tint: colorOr(A.tint),
    tintAmount: clampN(A.tintAmount, 0, 1),
    motes: moteLayer(A.motes as Record<string, unknown> | undefined),
    motes2: moteLayer(A.motes2 as Record<string, unknown> | undefined),
    relief: normalizeRelief(A.relief),
    hd: normalizeHd(A.hd),
    rain: normalizeRain(A.rain),
    shafts: normalizeShafts(A.shafts),
    reflections: normalizeReflections(A.reflections),
  });
  return Object.keys(out).length ? out : undefined;
}

function normalizeRain(v: unknown): SceneRain | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const R = v as Record<string, unknown>;
  return compact({
    count: clampN(R.count, 0, 800), angle: clampN(R.angle, -60, 60), speed: clampN(R.speed, 50, 1500), color: colorOr(R.color), opacity: clampN(R.opacity, 0, 1),
    splashes: typeof R.splashes === 'boolean' ? R.splashes : undefined, lightning: clampN(R.lightning, 0, 30), flashColor: colorOr(R.flashColor),
    thunder: typeof R.thunder === 'string' && R.thunder ? R.thunder : undefined,
  });
}

function normalizeShafts(v: unknown): SceneShafts | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const S = v as Record<string, unknown>;
  return compact({ count: clampN(S.count, 1, 24), color: colorOr(S.color), opacity: clampN(S.opacity, 0, 1), angle: clampN(S.angle, -70, 70), width: clampN(S.width, 2, 300) });
}

function normalizeReflections(v: unknown): SceneReflections | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const R = v as Record<string, unknown>;
  const sprites = Array.isArray(R.sprites) ? R.sprites.filter((s): s is string => typeof s === 'string' && !!s) : [];
  return compact({ opacity: clampN(R.opacity, 0, 1), wobble: clampN(R.wobble, 0, 8), sprites: sprites.length ? sprites : undefined });
}

function normalizeRelief(v: unknown): SceneRelief | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const R = v as Record<string, unknown>;
  const S = R.sun as Record<string, unknown> | undefined;
  const sun: SceneSun | undefined =
    S && typeof S === 'object'
      ? compact({ angle: clampN(S.angle, -360, 360), elevation: clampN(S.elevation, 5, 90), color: colorOr(S.color), intensity: clampN(S.intensity, 0, 3), shade: colorOr(S.shade) })
      : undefined;
  // An empty object means "on with the defaults".
  return compact({ strength: clampN(R.strength, 0, 2), bands: clampN(R.bands, 0, 16), rim: clampN(R.rim, 0, 2), lightHeight: clampN(R.lightHeight, 0.05, 2), tiles: typeof R.tiles === 'boolean' ? R.tiles : undefined, sun });
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
    if (L.painted === true) layer.painted = true;
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
    if (typeof I.activeIf === 'string' && I.activeIf.trim()) inst.activeIf = I.activeIf.trim();
    const light = normalizeLight(I.light, true);
    if (light) inst.light = light;
    if (typeof I.group === 'string' && I.group) inst.group = I.group;
    if (I.hdPose === 'flat' || I.hdPose === 'stand' || I.hdPose === 'wall') inst.hdPose = I.hdPose;
    if (typeof I.order === 'number') inst.order = I.order;
    const ih = I.hitbox as Record<string, unknown> | undefined;
    if (typeof I.hdLift === 'number' && I.hdLift > 0) inst.hdLift = I.hdLift;
    if (Array.isArray(I.footLine)) {
      const pts = (I.footLine as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)));
      // left to right, x always growing: a point whose x is not past the previous one is dropped (the first point of each x
      // stays), nothing is reordered behind the author's back (room-3001 #344.8)
      const kept: [number, number][] = [];
      for (const [x, y] of pts) if (!kept.length || x > kept[kept.length - 1]![0]) kept.push([x, y]);
      if (kept.length >= 2) inst.footLine = kept;
    }
    if (ih && typeof ih === 'object') inst.hitbox = { x: num(ih.x, 0), y: num(ih.y, 0), w: Math.max(1, num(ih.w, 8)), h: Math.max(1, num(ih.h, 8)) };
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
    ...(normalizeHdCells(o.hdCells) ? { hdCells: normalizeHdCells(o.hdCells) } : {}),
    ...(normalizeHdJuts(o.hdJuts) ? { hdJuts: normalizeHdJuts(o.hdJuts) } : {}),
    ...normalizeFine(o.collisionFine, cols, rows, Math.max(1, Math.min(256, Math.round(num(o.tileSize, 16))))),
    ...(typeof o.music === 'string' && o.music ? { music: o.music } : {}),
    ...(normalizeAmbience(o.ambience) ? { ambience: normalizeAmbience(o.ambience) } : {}),
    variables: vars(o.variables),
    ...(normalizeComponents(o.components) ? { components: normalizeComponents(o.components) } : {}),
    ...(normalizeAtmosphere(o.atmosphere) ? { atmosphere: normalizeAtmosphere(o.atmosphere) } : {}),
    ...(normalizeGroups(o.groups) ? { groups: normalizeGroups(o.groups) } : {}),
    ...(normalizeBlueprint(o.blueprint) ? { blueprint: normalizeBlueprint(o.blueprint) } : {}),
    rev: str(o.rev, newGameId()),
    ...(typeof o.updatedBy === 'string' ? { updatedBy: o.updatedBy } : {}),
  };
}

function normalizeGroups(v: unknown): Record<string, SceneGroup> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, SceneGroup> = {};
  for (const [name, g] of Object.entries(v)) {
    if (!name || !g || typeof g !== 'object') continue;
    const list = (g as { scatters?: unknown }).scatters;
    const scatters = Array.isArray(list) ? (list as ScatterRecipe[]).filter((r) => Array.isArray(r?.items) && r.items.length && typeof r.seed === 'number') : [];
    out[name] = scatters.length ? { scatters } : {};
  }
  return Object.keys(out).length ? out : undefined;
}

/** Fits the fine collision (pixels) to a new map size in pixels: kept from the top left, new cells free. */
function fitFine(scene: Scene, widthPx: number, heightPx: number): void {
  if (!scene.collisionFine) return;
  const t = scene.tileSize;
  const old = decodeFineSolid(scene.collisionFine, scene.cols * t, scene.rows * t).fine;
  if (!old) return;
  const nc = Math.ceil(widthPx / old.cell);
  const nr = Math.ceil(heightPx / old.cell);
  const bits = new Uint8Array(nc * nr);
  for (let y = 0; y < Math.min(nr, old.rows); y++) bits.set(old.bits.subarray(y * old.cols, y * old.cols + Math.min(nc, old.cols)), y * nc);
  scene.collisionFine = encodeFineSolid(bits, nc, nr, old.cell);
}

/** Changes the tile size (another tileset): the map is then cols x rows of the new size, and the fine collision follows. */
export function setTileSize(scene: Scene, tileSize: number): void {
  if (tileSize === scene.tileSize) return;
  fitFine(scene, scene.cols * tileSize, scene.rows * tileSize);
  scene.tileSize = tileSize;
}

/** Resizes a scene's tile layers, keeping the top-left content. */
export function resizeScene(scene: Scene, cols: number, rows: number): void {
  cols = Math.max(1, Math.min(1024, Math.round(cols)));
  rows = Math.max(1, Math.min(1024, Math.round(rows)));
  // The fine collision follows the map like the tile layers: kept from the top left, new cells free.
  fitFine(scene, cols * scene.tileSize, rows * scene.tileSize);
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
  /** How the sprite takes per-pixel light. */
  relief?: SpriteReliefSettings;
}

export type SpriteReliefSettings = SpriteRelief;

// ---------------------------------------------------------------------------
// Data tables (data/<name>.json): the game's database — items, weapons, classes, quests, enemies...

export type DataValue = number | string | boolean | string[];
export type DataRow = Record<string, DataValue> & { id: string };
export const DATA_COLUMN_TYPES = ['text', 'number', 'bool', 'list', 'ref'] as const;
export type DataColumnType = (typeof DATA_COLUMN_TYPES)[number];

export interface DataColumn {
  name: string;
  type: DataColumnType;
  /** ref columns: the table whose ids the values are. */
  table?: string;
  /** Shown as a tooltip in the editor and in references. */
  help?: string;
}

/** A table: typed columns and rows with a unique text id. Scripts read it as db.<name>, expressions as db("name", id, column). */
export interface DataTable {
  format: 'spritifer-table';
  version: 1;
  name: string;
  /** What the table is for (shown in the editor, list_data and the generated types). */
  description?: string;
  columns: DataColumn[];
  rows: DataRow[];
  rev: string;
  updatedBy?: string;
}

const DATA_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

function dataValue(v: unknown, type: DataColumnType): DataValue | undefined {
  if (v === undefined || v === null) return undefined;
  switch (type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    }
    case 'bool':
      return v === true || v === 'true' || v === 1 || v === '1';
    case 'list':
      return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
    default:
      return Array.isArray(v) ? v.join(',') : String(v);
  }
}

const inferType = (v: unknown): DataColumnType => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : Array.isArray(v) ? 'list' : 'text');

/** Normalizes a table: columns (inferred from the rows when missing, "id" always first), typed values, unique ids. */
export function normalizeTable(v: unknown, name?: string): DataTable {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const rawRows = (Array.isArray(o) ? o : Array.isArray(o.rows) ? o.rows : []) as unknown[];
  const columns: DataColumn[] = [];
  const seen = new Set<string>();
  const addColumn = (c: DataColumn) => {
    if (seen.has(c.name) || !GAME_NAME_RE.test(c.name)) return;
    seen.add(c.name);
    columns.push(c);
  };
  addColumn({ name: 'id', type: 'text' });
  if (Array.isArray(o.columns)) {
    for (const c of o.columns as unknown[]) {
      const C = (c && typeof c === 'object' ? c : { name: c }) as Record<string, unknown>;
      const type = (DATA_COLUMN_TYPES as readonly string[]).includes(String(C.type)) ? (C.type as DataColumnType) : 'text';
      const col: DataColumn = { name: str(C.name, ''), type };
      if (col.name === 'id') continue;
      if (type === 'ref' && typeof C.table === 'string' && C.table) col.table = C.table;
      if (typeof C.help === 'string' && C.help) col.help = C.help;
      addColumn(col);
    }
  }
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;
    for (const [k, x] of Object.entries(r)) if (!seen.has(k)) addColumn({ name: k, type: inferType(x) });
  }
  const ids = new Set<string>();
  const rows: DataRow[] = [];
  rawRows.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const R = r as Record<string, unknown>;
    let id = String(R.id ?? '').trim();
    if (!DATA_ID_RE.test(id)) id = `row${i + 1}`;
    while (ids.has(id)) id += '_';
    ids.add(id);
    const row = { id } as DataRow;
    for (const c of columns) {
      if (c.name === 'id') continue;
      const val = dataValue(R[c.name], c.type);
      if (val !== undefined) row[c.name] = val;
    }
    rows.push(row);
  });
  return {
    format: 'spritifer-table',
    version: 1,
    name: str(o.name, name ?? 'table'),
    ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
    columns,
    rows,
    rev: str(o.rev, newGameId()),
    ...(typeof o.updatedBy === 'string' ? { updatedBy: o.updatedBy } : {}),
  };
}

/** Value of a column for a row, with the column's default when missing (0, "", false, []). */
export function cellValue(t: DataTable, row: DataRow, col: string): DataValue {
  const v = row[col];
  if (v !== undefined) return v;
  const c = t.columns.find((x) => x.name === col);
  return c?.type === 'number' ? 0 : c?.type === 'bool' ? false : c?.type === 'list' ? [] : '';
}

/** Everything needed to run the game. */
/** The screen in interface pixels. */
export function interfaceSize(game: Pick<GameProject, 'width' | 'height' | 'uiScale'>): { width: number; height: number } {
  const k = game.uiScale ?? 1;
  return { width: game.width / k, height: game.height / k };
}

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
  /** Data tables by name (data/<name>.json). */
  data?: Record<string, DataTable>;
  /** Visual effect graphs by name (vfx/<name>.json). */
  vfx?: Record<string, VfxGraph>;
}
