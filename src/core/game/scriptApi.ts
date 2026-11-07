/**
 * The scripting API as data: one source for the editor's autocompletion, the generated TypeScript
 * declarations (IDE autocompletion in VS Code / JetBrains) and the reference shown to people and Claude.
 */

export type ApiKind = 'function' | 'value' | 'namespace' | 'class' | 'method' | 'property' | 'hook' | 'keyword';

export interface ApiEntry {
  name: string;
  kind: ApiKind;
  /** TypeScript signature, e.g. `say(text: string, opts?: SayOptions): Promise<void>` or `x: number`. */
  ts: string;
  doc: string;
  /** Text inserted by autocompletion (default: name, plus "()" for functions). `$0` marks the caret. */
  snippet?: string;
}

const fn = (name: string, ts: string, doc: string, snippet?: string): ApiEntry => ({ name, kind: 'function', ts, doc, snippet });
const val = (name: string, ts: string, doc: string): ApiEntry => ({ name, kind: 'value', ts, doc });
const ns = (name: string, ts: string, doc: string): ApiEntry => ({ name, kind: 'namespace', ts, doc });
const method = (name: string, ts: string, doc: string, snippet?: string): ApiEntry => ({ name, kind: 'method', ts, doc, snippet });
const prop = (name: string, ts: string, doc: string): ApiEntry => ({ name, kind: 'property', ts, doc });
const hook = (name: string, ts: string, doc: string): ApiEntry => {
  const args = (/\(([^)]*)\)/.exec(ts)?.[1] ?? '').split(',').map((x) => x.split(':')[0].trim()).filter(Boolean);
  return { name, kind: 'hook', ts, doc, snippet: `${name}(${args.join(', ')}) {\n  $0\n}` };
};

/** Lifecycle methods of a Behaviour, in the order they run. */
export const LIFECYCLE: ApiEntry[] = [
  hook('awake', 'awake(): void', 'Once, when the component is created (all components of the scene already exist). Get references here: this.health = this.getComponent("Health").'),
  hook('onEnable', 'onEnable(): void', 'When the component becomes enabled (after awake, and every time `enabled` goes from false to true).'),
  hook('start', 'start(): void | Promise<void>', 'Once, before the first update. Can be async (await say/wait/moveTo...).'),
  hook('update', 'update(dt: number): void', 'Every frame (dt = seconds since the last frame, 1/60). Not called while a dialog is open.'),
  hook('lateUpdate', 'lateUpdate(dt: number): void', 'Every frame after all updates, movement, collisions and events (follow cameras, final corrections).'),
  hook('onCollisionEnter', 'onCollisionEnter(other: Instance): void', 'This instance starts touching `other`.'),
  hook('onCollisionStay', 'onCollisionStay(other: Instance): void', 'Every frame while touching `other`.'),
  hook('onCollisionExit', 'onCollisionExit(other: Instance): void', 'This instance stops touching `other` (or it was destroyed).'),
  hook('onInteract', 'onInteract(player: Instance): void | Promise<void>', 'The player pressed action (Space/Z) next to or facing this instance: talk, open, read, use.'),
  hook('onClick', 'onClick(): void', 'The player clicked/tapped this instance.'),
  hook('onMessage', 'onMessage(message: string): void', 'An event or script emitted a message (emit("win")).'),
  hook('onSceneStart', 'onSceneStart(scene: string): void | Promise<void>', 'Global (game) components: a scene started. Scene and object components use start() instead.'),
  hook('onSceneEnd', 'onSceneEnd(scene: string): void', 'Global (game) components: the scene is about to change.'),
  hook('onDraw', 'onDraw(ui: Ui): void', 'Every frame, screen-space drawing on top of the game: HUDs, health bars (ui.toScreen(this.self.x, this.self.y)), menus.'),
  hook('onDisable', 'onDisable(): void', 'When the component gets disabled (enabled = false) or before it is destroyed.'),
  hook('onDestroy', 'onDestroy(): void', 'When the instance (or this component) is destroyed.'),
];

export const LIFECYCLE_NAMES = new Set(LIFECYCLE.map((h) => h.name));

/** Members every Behaviour has (this.*). These names can't be used as params. */
export const BEHAVIOUR_MEMBERS: ApiEntry[] = [
  prop('self', 'self: Instance', 'The instance this component is attached to (null for scene and game components).'),
  prop('enabled', 'enabled: boolean', 'Disabled components get no update/lateUpdate/collision/draw/message calls. Setting it calls onEnable/onDisable.'),
  prop('componentName', 'readonly componentName: string', 'Name of this component (its file name).'),
  method('getComponent', 'getComponent<T = any>(type: ComponentName | (new () => T)): T | null', 'Another component on the same instance (like Unity GetComponent): this.getComponent("Health").damage(1).', "getComponent('$0')"),
  method('getComponents', 'getComponents(type?: ComponentName): Behaviour[]', 'All components on the same instance (optionally of one type).', "getComponents('$0')"),
  method('addComponent', 'addComponent<T = any>(type: ComponentName, params?: Record<string, any>): T | null', 'Adds a component to the same instance at runtime.', "addComponent('$0')"),
  method('removeComponent', 'removeComponent(type: ComponentName | Behaviour): void', 'Removes a component (calls onDisable and onDestroy).', "removeComponent('$0')"),
  method('findComponent', 'findComponent<T = any>(type: ComponentName): T | null', 'First component of a type anywhere (game, scene or any instance), like FindObjectOfType.', "findComponent('$0')"),
  method('findComponents', 'findComponents<T = any>(type: ComponentName): T[]', 'Every component of a type anywhere.', "findComponents('$0')"),
  method('sendMessage', 'sendMessage(method: string, ...args: any[]): void', 'Calls `method` on every component of this instance that has it.', "sendMessage('$0')"),
  method('wait', 'wait(seconds: number): Promise<void>', 'Coroutine wait tied to this component: await this.wait(1). Stops (never resolves) if the component is destroyed.'),
  method('waitUntil', 'waitUntil(test: () => boolean): Promise<void>', 'Waits until test() is true, tied to this component.'),
  method('every', 'every(seconds: number, fn: () => void): () => void', 'Calls fn every N seconds while the component is alive and enabled. Returns a function that stops it.'),
  method('destroy', 'destroy(): void', 'Destroys the instance (for scene/game components: removes this component).'),
  method('log', 'log(...args: any[]): void', 'Writes to the game log, prefixed with the component name.'),
];

export const BEHAVIOUR_RESERVED = new Set([...BEHAVIOUR_MEMBERS.map((m) => m.name), 'constructor']);

/** Members of instance handles (this.self, other, player(), findOne(...)). */
export const HANDLE_MEMBERS: ApiEntry[] = [
  prop('x', 'x: number', 'Position (sprite top-left), pixels.'),
  prop('y', 'y: number', 'Position (sprite top-left), pixels.'),
  prop('vx', 'vx: number', 'Horizontal velocity, px/s.'),
  prop('vy', 'vy: number', 'Vertical velocity, px/s.'),
  prop('flipX', 'flipX: boolean', 'Mirror the sprite.'),
  prop('visible', 'visible: boolean', 'Hide/show.'),
  prop('opacity', 'opacity: number', '0..1.'),
  prop('angle', 'angle: number', 'Rotation in degrees.'),
  prop('z', 'z: number', 'Draw order.'),
  prop('facing', "facing: 'up' | 'down' | 'left' | 'right'", 'Direction (top-down).'),
  prop('onGround', 'readonly onGround: boolean', 'Standing on something solid (platformer/patrol).'),
  prop('name', 'readonly name: string', 'Instance name (or the object type name).'),
  prop('object', 'readonly object: string', 'Object type name.'),
  prop('id', 'readonly id: number', 'Runtime id.'),
  prop('sceneId', 'readonly sceneId: string', 'Id of the placed instance in the scene ("" when spawned).'),
  prop('alive', 'readonly alive: boolean', 'False once destroyed.'),
  prop('width', 'readonly width: number', 'Hitbox width.'),
  prop('height', 'readonly height: number', 'Hitbox height.'),
  prop('centerX', 'readonly centerX: number', 'Hitbox center.'),
  prop('centerY', 'readonly centerY: number', 'Hitbox center.'),
  prop('animation', 'animation: string', 'Current animation (sprite tag).'),
  prop('text', 'text: string', 'Text of a text object.'),
  prop('vars', 'readonly vars: Record<string, any>', 'The instance properties (also readable directly: self.hp).'),
  method('getComponent', 'getComponent<T = any>(type: ComponentName | (new () => T)): T | null', 'A component on this instance: other.getComponent("Health").', "getComponent('$0')"),
  method('getComponents', 'getComponents(type?: ComponentName): Behaviour[]', 'Components on this instance.'),
  method('addComponent', 'addComponent<T = any>(type: ComponentName, params?: Record<string, any>): T | null', 'Adds a component at runtime.', "addComponent('$0')"),
  method('removeComponent', 'removeComponent(type: ComponentName | Behaviour): void', 'Removes a component.', "removeComponent('$0')"),
  method('sendMessage', 'sendMessage(method: string, ...args: any[]): void', 'Calls `method` on every component of this instance that has it.', "sendMessage('$0')"),
  method('play', 'play(animation: string, lockSeconds?: number): void', 'Plays an animation; behaviors don\'t override it until it ends (or for lockSeconds).', "play('$0')"),
  method('destroy', 'destroy(): void', 'Removes the instance.'),
  method('flash', 'flash(seconds?: number): void', 'Blinks (hit feedback).'),
  method('moveTo', 'moveTo(x: number, y: number, speed?: number): Promise<void>', 'Walks there (walk_<dir> animations, stops at walls). await it in cutscenes.'),
  method('moveBy', 'moveBy(dx: number, dy: number, speed?: number): Promise<void>', 'Walks by an offset.'),
  method('say', 'say(text: string, opts?: { choices?: string[]; portrait?: string }): Promise<number>', 'Dialog box with this instance as the speaker.'),
  method('face', "face(dir: 'up' | 'down' | 'left' | 'right'): void", 'Turns (idle_<dir> animation).', "face('$0')"),
  method('distanceTo', 'distanceTo(other: Instance): number', 'Distance in pixels.'),
  method('overlaps', 'overlaps(other: Instance): boolean', 'Hitboxes touch.'),
  method('has', 'has(animation: string): boolean', 'The sprite has this animation tag.'),
];

export const UI_MEMBERS: ApiEntry[] = [
  prop('width', 'readonly width: number', 'Screen width in game pixels.'),
  prop('height', 'readonly height: number', 'Screen height in game pixels.'),
  method('text', "text(text: string, x: number, y: number, opts?: { color?: string; size?: number; align?: 'left' | 'center' | 'right'; shadow?: boolean }): void", 'Pixel font text (4x6 per char × size).'),
  method('rect', 'rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void', 'Filled rectangle.'),
  method('panel', 'panel(x: number, y: number, w: number, h: number, opts?: { color?: string; border?: string; alpha?: number }): void', 'Box with a border (menus, HUD backgrounds).'),
  method('bar', 'bar(x: number, y: number, w: number, h: number, value: number, max: number, color?: string, back?: string): void', 'Progress / health bar.'),
  method('sprite', 'sprite(name: string, x: number, y: number, opts?: { frame?: number; animation?: string; flipX?: boolean; opacity?: number; scale?: number }): void', 'Draws a sprite (icons, portraits).', "sprite('$0')"),
  method('measure', 'measure(text: string, size?: number): { width: number; height: number }', 'Size of a text in pixels.'),
  method('toScreen', 'toScreen(x: number, y: number): { x: number; y: number }', 'World position → screen position (draw over an instance).'),
];

export const SCENE_MEMBERS: ApiEntry[] = [
  prop('name', 'readonly name: string', 'Current scene name.'),
  prop('width', 'readonly width: number', 'Scene width in pixels.'),
  prop('height', 'readonly height: number', 'Scene height in pixels.'),
  prop('vars', 'readonly vars: Record<string, any>', 'Scene variables (reset when the scene starts).'),
];

export const GAME_MEMBERS: ApiEntry[] = [
  prop('title', 'readonly title: string', 'Game title.'),
  prop('width', 'readonly width: number', 'Screen width.'),
  prop('height', 'readonly height: number', 'Screen height.'),
  prop('time', 'readonly time: number', 'Seconds since the scene started.'),
  prop('clock', 'readonly clock: number', 'Seconds since the game started.'),
];

export const CAMERA_MEMBERS: ApiEntry[] = [prop('x', 'x: number', 'Camera left.'), prop('y', 'y: number', 'Camera top.')];

export const GLOBALS: ApiEntry[] = [
  { name: 'Behaviour', kind: 'class', ts: 'class Behaviour', doc: 'Base class of components: export default class Patrol extends Behaviour { speed = 40; update(dt) {...} }' },
  fn('say', 'say(text: string, opts?: { speaker?: string; portrait?: string }): Promise<void>', 'Dialog box with typewriter text; the game pauses until the player confirms. await it.'),
  fn('choose', 'choose(choices: string[], opts?: { text?: string; speaker?: string; portrait?: string }): Promise<number>', 'Menu; resolves with the chosen index.'),
  fn('dialogue', 'dialogue(name: string, self?: Instance, other?: Instance): Promise<void>', 'Plays a dialogue from dialogues/*.dialogue.', "dialogue('$0')"),
  fn('wait', 'wait(seconds: number): Promise<void>', 'Waits (game clock). In components prefer this.wait (stops when destroyed).'),
  fn('waitUntil', 'waitUntil(test: () => boolean): Promise<void>', 'Waits until test() is true.'),
  fn('lockControls', 'lockControls(locked?: boolean): void', 'Freezes player controls (cutscenes, battles).'),
  val('vars', 'vars: GameVars', 'Global variables (declared in the Game tab), kept across scenes: vars.score += 1'),
  ns('scene', 'scene: SceneInfo', 'Current scene: scene.name, scene.width, scene.height, scene.vars'),
  ns('game', 'game: GameInfo', 'game.title, game.width, game.height, game.time, game.clock'),
  ns('camera', 'camera: { x: number; y: number }', 'Camera position (set it to move the view).'),
  fn('find', 'find(object?: ObjectName): Instance[]', 'All instances (of an object type).', "find('$0')"),
  fn('findOne', 'findOne(object: ObjectName): Instance | undefined', 'First instance of an object type.', "findOne('$0')"),
  fn('player', 'player(): Instance | undefined', 'The player (instance with platformer/topdown controls).'),
  fn('spawn', 'spawn(object: ObjectName, x: number, y: number, props?: Record<string, any>): Instance | undefined', 'Creates an instance.', "spawn('$0')"),
  fn('findComponent', 'findComponent<T = any>(type: ComponentName): T | null', 'First component of a type anywhere (game, scene or instances).', "findComponent('$0')"),
  fn('findComponents', 'findComponents<T = any>(type: ComponentName): T[]', 'Every component of a type.', "findComponents('$0')"),
  fn('goto', 'goto(scene: SceneName): void', 'Changes scene (at the end of the frame).', "goto('$0')"),
  fn('restart', 'restart(): void', 'Restarts the current scene.'),
  fn('sound', 'sound(name: SoundName, volume?: number): void', 'Plays a built-in sound.', "sound('$0')"),
  fn('shake', 'shake(intensity?: number, seconds?: number): void', 'Screen shake.'),
  fn('emit', 'emit(message: string): void', 'Sends a message to events (Message received) and onMessage hooks.', "emit('$0')"),
  fn('log', 'log(...args: any[]): void', 'Writes to the game log (playtest reports, console).'),
  fn('key', 'key(name: KeyName): boolean', 'Key held: left, right, up, down, action, action2, a..z, 0..9.', "key('$0')"),
  fn('pressed', 'pressed(name: KeyName): boolean', 'Key pressed this frame.', "pressed('$0')"),
  fn('random', 'random(min?: number, max?: number): number', 'Random number (deterministic per seed).'),
  fn('randint', 'randint(min: number, max: number): number', 'Random integer, both ends included.'),
  fn('pick', 'pick<T>(list: T[]): T', 'Random element.'),
  fn('save', 'save(key: string, value: any): void', 'Stores a value (browser storage).', "save('$0')"),
  fn('load', 'load<T = any>(key: string, fallback?: T): T', 'Reads a stored value.', "load('$0')"),
  // Registration helpers for plain (non-component) scripts.
  fn('onStart', 'onStart(fn: () => void | Promise<void>): void', 'Plain scripts: once when the game starts. (Prefer a game component.)'),
  fn('onSceneStart', 'onSceneStart(scene: SceneName | ((scene: string) => any), fn?: (scene: string) => any): void', 'Plain scripts: when a scene (or every scene) starts. (Prefer a scene component.)'),
  fn('onUpdate', 'onUpdate(fn: (dt: number) => void): void', 'Plain scripts: every frame.'),
  fn('onDraw', 'onDraw(fn: (ui: Ui) => void): void', 'Plain scripts: draw UI every frame.'),
  fn('onMessage', 'onMessage(message: string, fn: (message: string) => void): void', 'Plain scripts: when a message is emitted.'),
  fn('func', 'func(name: string, fn: (self?: Instance, other?: Instance, arg?: any) => any): void', 'Plain scripts: a function events can call (action "Run script function").', "func('$0', async (self, other, arg) => {\n  \n})"),
  ns('Math', 'Math: Math', 'JavaScript Math.'),
  ns('JSON', 'JSON: JSON', 'JavaScript JSON.'),
];

export const KEYWORDS = ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'while'];

export const MATH_MEMBERS = ['abs', 'ceil', 'floor', 'round', 'min', 'max', 'sqrt', 'pow', 'sin', 'cos', 'atan2', 'hypot', 'sign', 'trunc', 'random', 'PI'];
export const ARRAY_MEMBERS = ['length', 'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every', 'includes', 'indexOf', 'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'join', 'reduce', 'sort', 'reverse', 'concat'];
export const STRING_MEMBERS = ['length', 'toUpperCase', 'toLowerCase', 'includes', 'startsWith', 'endsWith', 'indexOf', 'slice', 'split', 'trim', 'padStart', 'padEnd', 'replace', 'repeat'];

/** Parameter types a component can declare for the inspector. */
export const PARAM_TYPES = ['number', 'text', 'bool', 'choice', 'object', 'scene', 'sound', 'sprite', 'dialogue', 'key', 'color'] as const;
export type ComponentParamType = (typeof PARAM_TYPES)[number];

export const COMPONENT_TEMPLATE = (name: string) => `/**
 * ${name}: describe what this component does (shown in the inspector).
 */
export default class ${name} extends Behaviour {
  // Public fields are parameters you can set in the inspector (object type or instance).
  speed = 40
  // Fields starting with _ are private state.
  _time = 0

  // Optional extra info for the inspector: types (object, scene, sound, sprite, dialogue, key, color),
  // choices, ranges and help.
  static params = {
    speed: { min: 0, max: 400, help: 'Pixels per second' },
  }

  awake() {
    // References to other components: this.health = this.getComponent('Health')
  }

  start() {}

  /** @param {number} dt seconds since the last frame */
  update(dt) {
    this._time += dt
  }

  /** @param {Instance} other the instance we started touching */
  onCollisionEnter(other) {}
}
`;

export const PLAIN_SCRIPT_TEMPLATE = `// A plain script: shared helpers and data other scripts import.
//   import { clamp, FOES } from 'utils/helpers'
// (Game logic attached to things belongs in components: one class per file.)

export function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v))
}

export const FOES = {
  slime: { name: 'Slime', hp: 12 },
}
`;

const list = (entries: ApiEntry[], prefix = '') => entries.map((e) => `- ${prefix}${e.ts.replace(/^(readonly )/, '')}  — ${e.doc}`).join('\n');

export const SCRIPT_REFERENCE = `SCRIPTS — JavaScript files in scripts/ (folders allowed: scripts/enemies/Patrol.js). Two kinds:

1. COMPONENTS (behaviours): ONE class per file, named like the file, Unity-style.
   // scripts/enemies/Patrol.js
   export default class Patrol extends Behaviour {
     speed = 40            // public field = parameter, editable in the inspector
     target = 'player'
     _dir = 1              // _private state (not in the inspector)
     static params = { target: 'object', speed: { min: 0, max: 200, help: 'px/s' } }
     awake() { this.health = this.getComponent('Health') }
     update(dt) { this.self.x += this._dir * this.speed * dt }
     onCollisionEnter(other) { if (other.object === this.target) other.getComponent('Health')?.damage(1) }
   }
   Attach components to:
   - object types (Objects tab → Components, or set_object behaviors: [{ type: "script", name: "Patrol", speed: 60 }]); each placed
     instance can override params or add more components (scene inspector, or instances components: { Patrol: { speed: 80 } }),
   - scenes (scene components: managers, battle logic, level HUD; this.self is null),
   - the game (global components: live across scenes, e.g. GameManager, Inventory, HUD; get onSceneStart/onSceneEnd).
   static params refines the inspector: a type name ('object','scene','sound','sprite','dialogue','key','color','number','text','bool'),
   a list of choices (['walk', 'fly']), or { type, default, min, max, step, label, help, options }.

2. PLAIN SCRIPTS (modules): helpers and data, imported by other scripts. They can also use the hooks below.
   import { FOES } from 'data/foes'     (bare paths start at scripts/; './x' is relative)    export const FOES = {...}
   Components can import each other too: import Health from './Health' → this.getComponent(Health)

LIFECYCLE (component methods, all optional; async ones can await dialogs, waits, movement)
${LIFECYCLE.map((h) => `- ${h.ts}  — ${h.doc}`).join('\n')}

THIS (inside a component)
${list(BEHAVIOUR_MEMBERS, 'this.')}
- this.<param>  — the param values (from the inspector), plus any fields and methods you define

INSTANCES (this.self, other, player(), findOne('door'), spawn(...))
${list(HANDLE_MEMBERS, 'self.')}
- self.hp  — any other name reads/writes the instance's properties

GLOBALS
${list(GLOBALS.filter((g) => g.kind !== 'class'))}

UI (onDraw(ui), screen pixels, 4x6 pixel font)
${list(UI_MEMBERS, 'ui.')}

FROM EVENTS AND DIALOGUES
- Event action "Call component method" (callMethod): target self/other, component, method, arg → comp.method(arg, other)
- Event action "Run script function" (call) runs func(name, fn) from plain scripts.

EXAMPLE — a scene component driving a turn-based battle (attach it to the "battle" scene)
  export default class Battle extends Behaviour {
    foeName = 'Slime'
    foeHp = 12
    async start() {
      lockControls(true)
      await say('A wild ' + this.foeName + ' appears!')
      while (this.foeHp > 0 && vars.hp > 0) {
        const c = await choose(['Attack', 'Run'])
        if (c === 1) break
        this.foeHp -= randint(3, 6); sound('hit'); shake(2, 0.2)
        if (this.foeHp > 0) { vars.hp -= randint(1, 4); await say('Ouch!') }
      }
      lockControls(false)
      goto('town')
    }
    onDraw(ui) { ui.bar(8, 8, 80, 7, this.foeHp, 12, '#e43b44') }
  }`;

// ---------------------------------------------------------------------------
// TypeScript declarations for external editors.

export interface ProjectTypeInfo {
  components: { name: string; path: string }[];
  objects: string[];
  scenes: string[];
  sounds: string[];
  dialogues: string[];
  variables: Record<string, string | number | boolean>;
  /** Property names of all object types (instance handle fields). */
  properties: Record<string, string | number | boolean>;
}

const tsType = (v: unknown) => (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
const union = (names: string[]) => (names.length ? names.map((n) => JSON.stringify(n)).join(' | ') + ' | (string & {})' : 'string');
const members = (entries: ApiEntry[]) => entries.map((e) => `  /** ${e.doc.replace(/\*\//g, '*\\/')} */\n  ${e.ts};`).join('\n');

/** spritifer.d.ts: globals, Behaviour, Instance, Ui and the project's names (components, objects, scenes...). */
export function buildTypeDefinitions(p: ProjectTypeInfo, relativeToScripts = './'): string {
  const comps = p.components.map((c) => `  ${JSON.stringify(c.name)}: import(${JSON.stringify(relativeToScripts + c.path + '.js')}).default;`).join('\n');
  return `// Generated by Spritifer — do not edit. Gives your IDE autocompletion for game scripts.
// Regenerated when scripts change.

type ObjectName = ${union(p.objects)};
type SceneName = ${union(p.scenes)};
type SoundName = ${union(p.sounds)};
type DialogueName = ${union(p.dialogues)};
type KeyName = 'left' | 'right' | 'up' | 'down' | 'action' | 'action2' | 'space' | 'enter' | 'escape' | 'shift' | (string & {});

interface ComponentMap {
${comps}
}
type ComponentName = keyof ComponentMap | (string & {});

interface GameVars {
${Object.entries(p.variables).map(([k, v]) => `  ${k}: ${tsType(v)};`).join('\n')}
  [name: string]: any;
}

interface SceneInfo {
${members(SCENE_MEMBERS)}
}

interface GameInfo {
${members(GAME_MEMBERS)}
}

interface Ui {
${members(UI_MEMBERS)}
}

interface Instance {
${members(HANDLE_MEMBERS).replace(/getComponent<T = any>\(type: ComponentName \| \(new \(\) => T\)\): T \| null/, 'getComponent<K extends keyof ComponentMap>(type: K): ComponentMap[K] | null;\n  getComponent<T = any>(type: ComponentName | (new () => T)): T | null')}
${Object.entries(p.properties).map(([k, v]) => `  ${k}: ${tsType(v)};`).join('\n')}
  [property: string]: any;
}

declare class Behaviour {
${members(BEHAVIOUR_MEMBERS).replace(/getComponent<T = any>\(type: ComponentName \| \(new \(\) => T\)\): T \| null/, 'getComponent<K extends keyof ComponentMap>(type: K): ComponentMap[K] | null;\n  getComponent<T = any>(type: ComponentName | (new () => T)): T | null')}
  /** Inspector metadata for the params. */
  static params?: Record<string, string | string[] | { type?: string; default?: any; min?: number; max?: number; step?: number; label?: string; help?: string; options?: string[] }>;
${LIFECYCLE.map((h) => `  /** ${h.doc} */\n  ${h.ts.replace(/^(\w+)\(/, '$1?(')};`).join('\n')}
}

${GLOBALS.filter((g) => g.kind !== 'class' && g.name !== 'Math' && g.name !== 'JSON').map((g) => `/** ${g.doc} */\ndeclare ${g.kind === 'function' ? 'function ' + g.ts : 'const ' + g.ts};`).join('\n')}
`;
}
