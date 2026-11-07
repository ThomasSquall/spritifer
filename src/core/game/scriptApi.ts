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
  hook('onAnimationEvent', 'onAnimationEvent(event: string, animation: string): void', 'A frame with this event shows (events are set on frames in the sprite editor): do the damage on the "hit" frame of attack, play "step" sounds.'),
  hook('onMessage', 'onMessage(message: string, data: any): void', 'Any message emitted by an event or a script: emit("win") or emit("hit", { damage: 2 }). For one message prefer this.on("hit", data => ...).'),
  hook('onSceneStart', 'onSceneStart(scene: string): void | Promise<void>', 'Global (game) components: a scene started. Scene and object components use start() instead.'),
  hook('onSceneEnd', 'onSceneEnd(scene: string): void', 'Global (game) components: the scene is about to change.'),
  hook('onDraw', 'onDraw(ui: Ui): void', 'Every frame, screen-space drawing on top of the game: HUDs, health bars (ui.toScreen(this.self.x, this.self.y)), menus.'),
  hook('pausedUpdate', 'pausedUpdate(dt: number): void', 'Every frame while the game is paused with pause(true) (pause menus): update() is not called then.'),
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
  method('on', 'on(message: string, fn: (data: any, message: string) => void): () => void', 'Listens to emit(message, data) while this component lives (removed automatically when destroyed). "*" listens to everything. Returns a function that stops listening.', "on('$0', (data) => {\n  \n})"),
  method('emit', 'emit(message: string, data?: any): void', 'Sends a message with optional data to events (Message received), onMessage and on() listeners, at the end of this frame.', "emit('$0')"),
  method('tween', "tween(target: object, props: Record<string, number>, seconds: number, ease?: EaseName | { ease?: EaseName; delay?: number }): Promise<void>", 'Animates numeric fields smoothly: await this.tween(this.self, { y: this.self.y - 8, opacity: 0 }, 0.4, "outQuad"). Works on instances, components, camera, any object. Stops if this component is destroyed. Ignores walls.', 'tween($0, {  }, 0.3)'),
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
  method('pathTo', 'pathTo(x: number, y: number, speed?: number, opts?: { diagonal?: boolean; maxSteps?: number }): Promise<boolean>', 'Walks there AROUND walls and solid instances (A* on the tiles); its hitbox center ends at x, y. true = arrived. A new pathTo or stopMoving() cancels the previous one. maxSteps: only the first waypoints (chasing: call again every half second).'),
  method('stopMoving', 'stopMoving(): void', 'Cancels moveTo / moveBy / pathTo.'),
  method('isA', 'isA(object: ObjectName): boolean', 'Is it this object type or a variant of it?', "isA('$0')"),
  method('say', 'say(text: string, opts?: { choices?: string[]; portrait?: string }): Promise<number>', 'Dialog box with this instance as the speaker.'),
  method('face', "face(dir: 'up' | 'down' | 'left' | 'right'): void", 'Turns (idle_<dir> animation).', "face('$0')"),
  method('distanceTo', 'distanceTo(other: Instance): number', 'Distance in pixels.'),
  method('overlaps', 'overlaps(other: Instance): boolean', 'Hitboxes touch.'),
  method('has', 'has(animation: string): boolean', 'The sprite has this animation tag.'),
  prop('tags', 'readonly tags: string[]', 'Group tags (object type tags + the instance\'s own).'),
  method('hasTag', 'hasTag(tag: TagName): boolean', 'Has this group tag ("enemy", "pickup"), like Unity CompareTag.', "hasTag('$0')"),
  method('addTag', 'addTag(tag: TagName): void', 'Adds a group tag at runtime.', "addTag('$0')"),
  method('removeTag', 'removeTag(tag: TagName): void', 'Removes a group tag.', "removeTag('$0')"),
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
  method('window', 'window(x: number, y: number, w: number, h: number, title?: string, opts?: { color?: string; border?: string; alpha?: number }): void', 'A panel with a title bar.'),
  method('menu', "menu(id: string, items: (string | { label: string; right?: string; disabled?: boolean })[], x: number, y: number, opts?: { w?: number; rowHeight?: number; title?: string; cancel?: boolean; panel?: boolean; keys?: boolean; color?: string; selectedColor?: string }): number | null", 'A list with a cursor: Up/Down + action/Enter, or mouse hover + click. Returns the chosen index the frame it is chosen (-1 = cancelled with Escape/X when cancel: true), else null. The highlighted row is remembered per id.', "menu('$0', [], 8, 8)"),
  method('menuIndex', 'menuIndex(id: string, set?: number): number', 'Highlighted row of a menu (and set it).'),
  method('button', 'button(label: string, x: number, y: number, opts?: { w?: number; h?: number; color?: string; textColor?: string; key?: string; disabled?: boolean }): boolean', 'A clickable button: true the frame it is clicked (or its key pressed).', "button('$0', 8, 8)"),
  method('pressed', 'pressed(key: KeyName, consume?: boolean): boolean', 'Key pressed since the last draw (use in onDraw instead of the global pressed()). consume: true hides it from the widgets drawn after (one key, one action).'),
  prop('mouse', 'readonly mouse: { x: number; y: number; clicked: boolean; inside(x: number, y: number, w: number, h: number): boolean }', 'Pointer in screen pixels.'),
];

export const SCENE_MEMBERS: ApiEntry[] = [
  prop('name', 'readonly name: string', 'Current scene name.'),
  prop('width', 'readonly width: number', 'Scene width in pixels.'),
  prop('height', 'readonly height: number', 'Scene height in pixels.'),
  prop('tileSize', 'readonly tileSize: number', 'Tile size in pixels.'),
  prop('vars', 'readonly vars: Record<string, any>', 'Scene variables (reset when the scene starts).'),
];

export const GAME_MEMBERS: ApiEntry[] = [
  prop('title', 'readonly title: string', 'Game title.'),
  prop('width', 'readonly width: number', 'Screen width.'),
  prop('height', 'readonly height: number', 'Screen height.'),
  prop('time', 'readonly time: number', 'Seconds since the scene started.'),
  prop('clock', 'readonly clock: number', 'Seconds since the game started.'),
  prop('paused', 'readonly paused: boolean', 'The game is paused with pause(true).'),
  prop('music', 'readonly music: string', 'The music track playing ("" = none).'),
  prop('dialogOpen', 'readonly dialogOpen: boolean', 'A dialog box is open (the game is paused).'),
];

export const CAMERA_MEMBERS: ApiEntry[] = [
  prop('x', 'x: number', 'Left of the view (world px).'),
  prop('y', 'y: number', 'Top of the view (world px).'),
  prop('zoom', 'zoom: number', '1 = normal, 2 = twice as big (shows half the world). Tween it for smooth zooms.'),
  prop('width', 'readonly width: number', 'Visible world width (screen / zoom).'),
  prop('height', 'readonly height: number', 'Visible world height.'),
  method('follow', 'follow(target: Instance | null | undefined): void', 'Follow another instance (null: stop; undefined: back to the Camera behavior).'),
  method('setBounds', 'setBounds(x: number, y: number, w: number, h: number): void', 'Keep the view inside a rectangle (a room) instead of the whole scene.'),
  method('clearBounds', 'clearBounds(): void', 'Back to the scene bounds.'),
  method('toWorld', 'toWorld(screenX: number, screenY: number): { x: number; y: number }', 'Screen pixel → world position.'),
];

export const GLOBALS: ApiEntry[] = [
  { name: 'Behaviour', kind: 'class', ts: 'class Behaviour', doc: 'Base class of components: export default class Patrol extends Behaviour { speed = 40; update(dt) {...} }' },
  fn('say', 'say(text: string, opts?: { speaker?: string; portrait?: string }): Promise<void>', 'Dialog box with typewriter text; the game pauses until the player confirms. await it.'),
  fn('choose', 'choose(choices: string[], opts?: { text?: string; speaker?: string; portrait?: string }): Promise<number>', 'Menu; resolves with the chosen index.'),
  fn('dialogue', 'dialogue(name: string, self?: Instance, other?: Instance): Promise<void>', 'Plays a dialogue from dialogues/*.dialogue.', "dialogue('$0')"),
  fn('wait', 'wait(seconds: number): Promise<void>', 'Waits (game clock). In components prefer this.wait (stops when destroyed).'),
  fn('waitUntil', 'waitUntil(test: () => boolean): Promise<void>', 'Waits until test() is true.'),
  fn('lockControls', 'lockControls(locked?: boolean): void', 'Freezes player controls (cutscenes, battles).'),
  fn('music', 'music(name: AudioName, opts?: { volume?: number; loop?: boolean; fade?: number }): void', 'Plays a music track from audio/ (crossfades from the current one; the same track keeps playing). Scenes can also set their music in the Scene tab.', "music('$0')"),
  fn('stopMusic', 'stopMusic(fade?: number): void', 'Fades the music out (seconds).'),
  fn('setVolume', "setVolume(channel: 'music' | 'sfx', value: number): void", 'Volume 0..1 for music or sound effects (options menus).', "setVolume('$0', 1)"),
  fn('pause', 'pause(on?: boolean): void', 'Pauses the game (pause menus, inventories): nothing moves, timers stop; onDraw and pausedUpdate keep running. Changing scene resumes.'),
  val('vars', 'vars: GameVars', 'Global variables (declared in the Game tab), kept across scenes: vars.score += 1'),
  ns('scene', 'scene: SceneInfo', 'Current scene: scene.name, scene.width, scene.height, scene.vars'),
  ns('game', 'game: GameInfo', 'game.title, game.width, game.height, game.time, game.clock'),
  ns('camera', 'camera: CameraApi', 'The view: camera.x / y / zoom, follow(), setBounds(), toWorld(). Dead zone and look-ahead are params of the Camera behavior.'),
  fn('find', 'find(object?: ObjectName): Instance[]', 'All instances (of an object type).', "find('$0')"),
  fn('findOne', 'findOne(object: ObjectName): Instance | undefined', 'First instance of an object type.', "findOne('$0')"),
  fn('player', 'player(): Instance | undefined', 'The player (instance with platformer/topdown controls).'),
  fn('spawn', 'spawn(object: ObjectName, x: number, y: number, props?: Record<string, any>): Instance | undefined', 'Creates an instance.', "spawn('$0')"),
  fn('findWithTag', 'findWithTag(tag: TagName): Instance[]', 'Every instance with a group tag.', "findWithTag('$0')"),
  fn('findNearest', 'findNearest(from: Instance | number, y?: number | QueryFilter, filter?: QueryFilter & { maxDistance?: number }): Instance | null', 'Nearest instance to an instance (itself excluded) or to a point: findNearest(this.self, { tag: "enemy", maxDistance: 80 }).'),
  fn('overlapBox', 'overlapBox(x: number, y: number, w: number, h: number, filter?: QueryFilter): Instance[]', 'Instances whose hitbox overlaps a rectangle (world pixels): area attacks, sensors.'),
  fn('overlapCircle', 'overlapCircle(x: number, y: number, radius: number, filter?: QueryFilter): Instance[]', 'Instances whose hitbox touches a circle: explosions, auras.'),
  fn('raycast', 'raycast(x1: number, y1: number, x2: number, y2: number, filter?: QueryFilter & { solids?: boolean; instances?: boolean }): RayHit | null', 'First thing on the segment: solid tiles and solid instances, plus instances matching { tag, object } (or any with instances: true). null = clear. Line of sight: raycast(me.centerX, me.centerY, p.centerX, p.centerY, { object: "player", ignore: me })?.instance === p'),
  fn('particles', "particles(x: number, y: number, preset?: ParticlePreset | ParticleOptions, overrides?: ParticleOptions): void", 'A burst of pixel particles: particles(self.centerX, self.y, "dust"), particles(x, y, "explosion", { count: 60 }), or your own { color: ["#fff", "#ff0"], speed: [20, 60], angle: -90, spread: 90, life: 0.5, size: [1, 2], gravity: 100, drag: 1, fade: true, shrink: true, behind: false }.', "particles($0)"),
  fn('findPath', 'findPath(x1: number, y1: number, x2: number, y2: number, opts?: { diagonal?: boolean; partial?: boolean }): { x: number; y: number }[] | null', 'Waypoints from one point to another around solid tiles and instances (null = no way; partial: as close as possible).'),
  fn('isSolidAt', 'isSolidAt(x: number, y: number): boolean', 'A solid tile or solid instance at a world point (ledge checks, placement).'),
  fn('findComponent', 'findComponent<T = any>(type: ComponentName): T | null', 'First component of a type anywhere (game, scene or instances).', "findComponent('$0')"),
  fn('findComponents', 'findComponents<T = any>(type: ComponentName): T[]', 'Every component of a type.', "findComponents('$0')"),
  fn('goto', 'goto(scene: SceneName, opts?: { fade?: number; color?: string }): void', 'Changes scene (at the end of the frame). goto("dungeon", { fade: 0.4 }) fades to black and back.', "goto('$0')"),
  fn('restart', 'restart(opts?: { fade?: number; color?: string }): void', 'Restarts the current scene (optionally with a fade).'),
  fn('sound', 'sound(name: SoundName | AudioName, volume?: number): void', 'Plays a sound: a built-in retro sound or an audio file from audio/.', "sound('$0')"),
  fn('shake', 'shake(intensity?: number, seconds?: number): void', 'Screen shake.'),
  fn('emit', 'emit(message: string, data?: any): void', 'Sends a message (with optional data) to events (Message received), onMessage hooks and on() listeners, at the end of this frame.', "emit('$0')"),
  fn('on', 'on(message: string, fn: (data: any, message: string) => void): () => void', 'Plain scripts: listens to emit(message, data). In components use this.on (removed automatically).', "on('$0', (data) => {\n  \n})"),
  fn('tween', "tween(target: object, props: Record<string, number>, seconds: number, ease?: EaseName | { ease?: EaseName; delay?: number }): Promise<void>", 'Animates numeric fields of any object (instance, camera, a component): await tween(camera, { x: 200 }, 1, "inOutSine"). In components prefer this.tween (stops with the component).', 'tween($0, {  }, 0.3)'),
  fn('stopTweens', 'stopTweens(target: object): void', 'Stops every tween animating target.'),
  fn('log', 'log(...args: any[]): void', 'Writes to the game log (playtest reports, console).'),
  fn('key', 'key(name: KeyName): boolean', 'Key held: left, right, up, down, action, action2, a..z, 0..9.', "key('$0')"),
  fn('pressed', 'pressed(name: KeyName): boolean', 'Key pressed this frame.', "pressed('$0')"),
  fn('random', 'random(min?: number, max?: number): number', 'Random number (deterministic per seed).'),
  fn('randint', 'randint(min: number, max: number): number', 'Random integer, both ends included.'),
  fn('pick', 'pick<T>(list: T[]): T', 'Random element.'),
  fn('saveGame', 'saveGame(slot?: string): SaveInfo', 'Saves the whole game in a slot (default "auto"): variables, current scene with its instances and component fields, remembered scenes, global components.', "saveGame('$0')"),
  fn('loadGame', 'loadGame(slot?: string): boolean', 'Loads a slot at the end of the frame (false if empty).', "loadGame('$0')"),
  fn('hasSave', 'hasSave(slot?: string): boolean', 'Is there a save in this slot? (Continue buttons.)', "hasSave('$0')"),
  fn('deleteSave', 'deleteSave(slot: string): void', 'Deletes a save slot.', "deleteSave('$0')"),
  fn('listSaves', 'listSaves(): SaveInfo[]', 'Saved slots: { slot, scene, savedAt, title }.'),
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

UI WIDGETS AND PAUSE (inside onDraw(ui))
- const i = ui.menu('shop', ['Potion', { label: 'Sword', right: '50G', disabled: vars.gold < 50 }, 'Leave'], 8, 8, { title: 'SHOP', cancel: true })  → index chosen this frame, -1 cancelled, null
- if (ui.button('OK', 140, 120)) ...   ui.window(x, y, w, h, 'TITLE')   ui.pressed('escape')   ui.mouse.x / y / clicked
- pause(true) / pause(false): freeze the game for menus; pausedUpdate(dt) runs while paused
  Example pause menu (a global component): onDraw(ui) { if (!game.paused) { if (ui.pressed('escape', true)) pause(true); return } const c = ui.menu('pause', ['Resume', 'Restart'], 120, 60, { title: 'PAUSED', cancel: true }); if (c === 0 || c === -1) pause(false); if (c === 1) restart() }

PARTICLES AND ANIMATION EVENTS
- particles(x, y, 'dust' | 'sparks' | 'hit' | 'explosion' | 'smoke' | 'magic' | 'leaves' | 'splash' | 'confetti' | 'heal', { count, color, speed, angle, spread, life, size, gravity, drag, fade, shrink, behind })
- Frames can carry events (sprite editor ⚑ field, MCP set_frame_events): onAnimationEvent(event, animation) in components, trigger "Animation event" in events

PATHS, CAMERA, VARIANTS
- await self.pathTo(x, y, speed, { diagonal, maxSteps }) walks around walls (A* on tiles); self.stopMoving(); findPath(x1, y1, x2, y2) → waypoints | null
- camera.zoom = 2, camera.follow(boss), camera.setBounds(x, y, w, h) / clearBounds(), camera.toWorld(sx, sy); Camera behavior params: deadZoneX/Y, lookAhead, zoom
- Object type variants (set_object extends: "slime"): inherit everything; find("slime"), count, "collides with slime" include variants; self.isA("slime")

TAGS, QUERIES, SAVES
- Object types (and placed instances) have group tags: self.hasTag('enemy'), findWithTag('pickup'), countTag("enemy") in expressions
- raycast(x1, y1, x2, y2, { tag, object, ignore, solids, instances }) → { x, y, distance, normalX, normalY, instance, tile } | null
- overlapBox(x, y, w, h, filter), overlapCircle(x, y, r, filter), findNearest(self, { tag, maxDistance }), isSolidAt(x, y)
- saveGame('slot1'), loadGame('slot1'), hasSave('slot1'), listSaves(), deleteSave('slot1') — also event actions "Save game" / "Load game" and hasSave("slot") in expressions

MESSAGES, TWEENS, TRANSITIONS
- emit('playerHit', { damage: 2 }) → this.on('playerHit', (data) => ...) in any component (auto-removed), onMessage(name, data), events "Message received"
- await this.tween(this.self, { y: this.self.y - 12, opacity: 0 }, 0.4, 'outQuad')   easings: linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, inOutSine, outBack, outElastic, outBounce; { ease, delay }
- goto('dungeon', { fade: 0.4, color: '#000000' }), restart({ fade: 0.3 })

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
  /** Group tags used by the object types. */
  tags?: string[];
  /** Audio files (audio/). */
  audio?: string[];
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
type AudioName = ${union(p.audio ?? [])};
type SceneName = ${union(p.scenes)};
type SoundName = ${union(p.sounds)};
type DialogueName = ${union(p.dialogues)};
type ParticlePreset = 'dust' | 'sparks' | 'hit' | 'explosion' | 'smoke' | 'magic' | 'leaves' | 'splash' | 'confetti' | 'heal';
interface ParticleOptions { count?: number; color?: string | string[]; speed?: number | [number, number]; angle?: number; spread?: number; life?: number | [number, number]; size?: number | [number, number]; gravity?: number; drag?: number; fade?: boolean; shrink?: boolean; areaW?: number; areaH?: number; behind?: boolean }
type EaseName = 'linear' | 'inQuad' | 'outQuad' | 'inOutQuad' | 'inCubic' | 'outCubic' | 'inOutCubic' | 'inOutSine' | 'outBack' | 'outElastic' | 'outBounce';
type TagName = ${union(p.tags ?? [])};
interface QueryFilter { tag?: TagName; object?: ObjectName; ignore?: Instance | Instance[] }
interface RayHit { x: number; y: number; distance: number; normalX: number; normalY: number; instance: Instance | null; tile: boolean }
interface SaveInfo { slot: string; scene: string; savedAt: number; title: string }
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

interface CameraApi {
${members(CAMERA_MEMBERS)}
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
