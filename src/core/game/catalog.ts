/**
 * The vocabulary of the event system and behaviors, with parameter specs. The editor builds its forms
 * from this, the MCP server documents it, and validateGame() checks projects against it.
 */

import { checkExpr } from './expr.js';
import type { Behavior, DataTable, EventStep, GameEvent, GameProject, Scene, Value } from './types.js';
import { resolveObjectTypes } from './variants.js';
import { type VfxGraph, checkVfx } from './vfxGraph.js';

export type ParamType =
  | 'expr' // expression, evaluated at run time
  | 'text' // literal string
  | 'number'
  | 'bool'
  | 'key' // keyboard key name
  | 'object' // object type name
  | 'objectOrAny' // object type name or "any"
  | 'scene'
  | 'sound'
  | 'target' // assignable variable: score, self.hp, other.vx, scene.lives
  | 'instance' // self | other
  | 'function' // script function name
  | 'dialogue' // dialogue name
  | 'scriptBehavior' // script component name
  | 'sprite' // sprite name
  | 'color' // #rrggbb
  | 'music' // audio file name
  | 'vfx' // visual effect name
  | 'choice';

export interface ParamSpec {
  name: string;
  type: ParamType;
  label?: string;
  default?: Value;
  options?: string[];
  help?: string;
  optional?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface StepSpec {
  type: string;
  label: string;
  help: string;
  params: ParamSpec[];
  /** Only meaningful on object event sheets (needs `self`). */
  objectOnly?: boolean;
}

export const KEYS = [
  'left', 'right', 'up', 'down', 'space', 'enter', 'escape', 'shift', 'action', 'action2',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
  'any',
];

export const SOUNDS = ['jump', 'coin', 'hit', 'explosion', 'powerup', 'laser', 'blip', 'select', 'hurt', 'step'];

export const TRIGGERS: StepSpec[] = [
  { type: 'start', label: 'Scene starts', help: 'Once when the scene starts (after all instances are created).', params: [] },
  { type: 'created', label: 'Created', help: 'When this instance appears (scene start or spawn).', params: [], objectOnly: true },
  { type: 'update', label: 'Every frame', help: 'Every frame (60 times per second). Combine with conditions.', params: [] },
  { type: 'keyPressed', label: 'Key pressed', help: 'The frame a key goes down. "action" = space/Z/J, "action2" = X/K, "any" = any key.', params: [{ name: 'key', type: 'key', default: 'space' }] },
  { type: 'keyDown', label: 'Key held', help: 'Every frame while a key is held.', params: [{ name: 'key', type: 'key', default: 'right' }] },
  { type: 'keyReleased', label: 'Key released', help: 'The frame a key goes up.', params: [{ name: 'key', type: 'key', default: 'space' }] },
  { type: 'collision', label: 'Collides with', help: 'When this instance starts touching an instance of an object type ("other" is that instance).', params: [{ name: 'with', type: 'objectOrAny', default: 'any' }], objectOnly: true },
  { type: 'overlapping', label: 'While overlapping', help: 'Every frame while touching an instance of an object type.', params: [{ name: 'with', type: 'objectOrAny', default: 'any' }], objectOnly: true },
  { type: 'click', label: 'Clicked / tapped', help: 'When the player clicks or taps this instance (on a scene sheet: anywhere).', params: [] },
  { type: 'timer', label: 'Timer', help: 'After N seconds; with repeat, every N seconds.', params: [{ name: 'seconds', type: 'number', default: 1 }, { name: 'repeat', type: 'bool', default: true }] },
  { type: 'landed', label: 'Lands on ground', help: 'When a platformer/patrol instance touches the ground.', params: [], objectOnly: true },
  { type: 'hitWall', label: 'Hits a wall', help: 'When movement is blocked sideways (or a bullet hits something solid).', params: [], objectOnly: true },
  { type: 'animationEnd', label: 'Animation ends', help: 'When a non-looping pass of the current animation finishes.', params: [{ name: 'animation', type: 'text', default: '', optional: true }], objectOnly: true },
  { type: 'animationEvent', label: 'Animation event', help: 'A frame with this event shows (set events on frames in the sprite editor, e.g. "hit" on the swing frame of attack, "step" on footsteps). Empty = any event.', params: [{ name: 'event', type: 'text', default: 'hit' }], objectOnly: true },
  { type: 'leftScene', label: 'Leaves the scene', help: 'When the instance moves completely outside the scene bounds.', params: [], objectOnly: true },
  { type: 'interact', label: 'Player interacts', help: 'The player presses action (Space/Z) while next to or facing this instance: talk to NPCs, open chests, read signs. "other" is the player.', params: [], objectOnly: true },
  { type: 'destroyed', label: 'Destroyed', help: 'Just before this instance is removed.', params: [], objectOnly: true },
  { type: 'message', label: 'Message received', help: 'When an "emit" action sends this message.', params: [{ name: 'message', type: 'text', default: 'win' }] },
];

export const CONDITIONS: StepSpec[] = [
  { type: 'expr', label: 'Expression is true', help: 'Any expression, e.g. `score >= 10`, `self.hp <= 0`, `count("enemy") == 0`.', params: [{ name: 'expr', type: 'expr', default: 'true' }] },
  { type: 'keyDown', label: 'Key is held', help: 'True while the key is held.', params: [{ name: 'key', type: 'key', default: 'right' }] },
  { type: 'onGround', label: 'Is on ground', help: 'Platformer/patrol instance stands on something solid.', params: [{ name: 'not', type: 'bool', default: false, label: 'invert' }], objectOnly: true },
  { type: 'overlaps', label: 'Is overlapping', help: 'This instance touches an instance of an object type (sets "other").', params: [{ name: 'with', type: 'objectOrAny', default: 'any' }, { name: 'not', type: 'bool', default: false, label: 'invert' }], objectOnly: true },
  { type: 'chance', label: 'Random chance', help: 'True with the given probability (percent).', params: [{ name: 'percent', type: 'number', default: 50 }] },
  { type: 'animation', label: 'Animation is', help: 'The current animation of self.', params: [{ name: 'animation', type: 'text', default: 'idle' }], objectOnly: true },
];

export const ACTIONS: StepSpec[] = [
  { type: 'set', label: 'Set variable', help: 'Set a variable: `score`, `self.hp`, `other.vx`, `scene.lives`, or fields x, y, vx, vy, visible, flipX, opacity, angle, text.', params: [{ name: 'target', type: 'target', default: 'score' }, { name: 'value', type: 'expr', default: '0' }] },
  { type: 'add', label: 'Add to variable', help: 'Add a (possibly negative) amount to a variable.', params: [{ name: 'target', type: 'target', default: 'score' }, { name: 'value', type: 'expr', default: '1' }] },
  { type: 'move', label: 'Move by', help: 'Move by dx, dy pixels, stopped by solids.', params: [{ name: 'dx', type: 'expr', default: '0' }, { name: 'dy', type: 'expr', default: '0' }, { name: 'target', type: 'instance', default: 'self' }] },
  { type: 'setPosition', label: 'Set position', help: 'Teleport to x, y (top-left of the sprite).', params: [{ name: 'x', type: 'expr', default: 'self.x' }, { name: 'y', type: 'expr', default: 'self.y' }, { name: 'target', type: 'instance', default: 'self' }] },
  { type: 'setVelocity', label: 'Set velocity', help: 'Set speed in pixels per second (vy positive = down).', params: [{ name: 'vx', type: 'expr', default: 'self.vx' }, { name: 'vy', type: 'expr', default: 'self.vy' }, { name: 'target', type: 'instance', default: 'self' }] },
  { type: 'jump', label: 'Jump / bounce', help: 'Launch upward (platformer). Strength in px/s; 0 = the behavior jump strength.', params: [{ name: 'strength', type: 'expr', default: '0' }, { name: 'target', type: 'instance', default: 'self' }] },
  { type: 'spawn', label: 'Create instance', help: 'Create an instance of an object at x, y. Relative: x/y are offsets from self. Velocity optional.', params: [{ name: 'object', type: 'object', default: '' }, { name: 'x', type: 'expr', default: '0' }, { name: 'y', type: 'expr', default: '0' }, { name: 'relative', type: 'bool', default: true }, { name: 'vx', type: 'expr', default: '0' }, { name: 'vy', type: 'expr', default: '0' }] },
  { type: 'destroy', label: 'Destroy', help: 'Remove an instance.', params: [{ name: 'target', type: 'instance', default: 'self' }] },
  { type: 'playAnimation', label: 'Play animation', help: 'Switch to a sprite tag. Behaviors stop picking animations for `lock` seconds (0 = until it ends).', params: [{ name: 'animation', type: 'text', default: 'idle' }, { name: 'target', type: 'instance', default: 'self' }, { name: 'lock', type: 'number', default: 0 }] },
  { type: 'flash', label: 'Blink', help: 'Blink an instance for N seconds (hurt feedback).', params: [{ name: 'seconds', type: 'number', default: 0.6 }, { name: 'target', type: 'instance', default: 'self' }] },
  { type: 'gotoScene', label: 'Go to scene', help: 'Switch to another scene (global variables are kept). With fade > 0 the screen fades to black and back (seconds).', params: [{ name: 'scene', type: 'scene', default: '' }, { name: 'fade', type: 'number', default: 0, label: 'fade (s)', optional: true, min: 0 }] },
  { type: 'restartScene', label: 'Restart scene', help: 'Restart the current scene (optionally with a fade, in seconds).', params: [{ name: 'fade', type: 'number', default: 0, label: 'fade (s)', optional: true, min: 0 }] },
  { type: 'sound', label: 'Play sound', help: 'Play a built-in retro sound effect.', params: [{ name: 'sound', type: 'sound', default: 'coin' }, { name: 'volume', type: 'number', default: 0.5 }] },
  { type: 'shake', label: 'Shake camera', help: 'Shake the screen.', params: [{ name: 'intensity', type: 'number', default: 3 }, { name: 'seconds', type: 'number', default: 0.3 }] },
  { type: 'say', label: 'Show message', help: 'Show a centered message box for N seconds (0 = until the next message). Text is an expression.', params: [{ name: 'text', type: 'expr', default: '"Hello!"' }, { name: 'seconds', type: 'number', default: 2 }] },
  { type: 'emit', label: 'Send message', help: 'Trigger "message received" events everywhere.', params: [{ name: 'message', type: 'text', default: 'win' }] },
  { type: 'call', label: 'Run script function', help: 'Call a function registered in a script with func(name, fn). It receives (self, other, arg).', params: [{ name: 'function', type: 'function', default: '' }, { name: 'arg', type: 'expr', default: '', optional: true }] },
  { type: 'callMethod', label: 'Call component method', help: 'Call a method of a script component: on self/other (empty component = every component with that method), or on scene/game components from a scene sheet. It receives (arg, other).', params: [{ name: 'target', type: 'instance', default: 'self' }, { name: 'component', type: 'scriptBehavior', default: '', optional: true }, { name: 'method', type: 'text', default: '' }, { name: 'arg', type: 'expr', default: '', optional: true }] },
  { type: 'dialogue', label: 'Start dialogue', help: 'Play a dialogue written in the Dialogues tab (lines, choices, conditions). "self" in the dialogue is this instance.', params: [{ name: 'dialogue', type: 'dialogue', default: '' }] },
  { type: 'talk', label: 'Show one line', help: 'Open an RPG dialog box (typewriter text, waits for the player). The game pauses while it is open. For conversations with choices use a script.', params: [{ name: 'text', type: 'expr', default: '"Hello!"' }, { name: 'speaker', type: 'text', default: '', optional: true }] },
  { type: 'particles', label: 'Particles', help: 'A burst of pixel particles at an instance (or the screen center on scene sheets): dust, sparks, hit, explosion, smoke, magic, leaves, splash, confetti, heal.', params: [{ name: 'preset', type: 'choice', options: ['sparks', 'dust', 'hit', 'explosion', 'smoke', 'magic', 'leaves', 'splash', 'confetti', 'heal'], default: 'sparks' }, { name: 'target', type: 'instance', default: 'self' }, { name: 'count', type: 'number', default: 0, label: 'count (0 = preset)', optional: true }, { name: 'dx', type: 'expr', default: '0', optional: true }, { name: 'dy', type: 'expr', default: '0', optional: true }] },
  { type: 'vfx', label: 'Play effect', help: 'Play a visual effect from the VFX tab. "from" is the attacker, "to" the victim; with no victim it fires where "from" is facing.', params: [{ name: 'effect', type: 'vfx', default: '' }, { name: 'from', type: 'instance', default: 'self' }, { name: 'to', type: 'choice', options: ['none', 'self', 'other'], default: 'none' }] },
  { type: 'playMusic', label: 'Play music', help: 'Play a music track from the audio/ folder (Game tab), crossfading from the current one. The same track keeps playing.', params: [{ name: 'music', type: 'music', default: '' }, { name: 'fade', type: 'number', default: 1, label: 'fade (s)' }, { name: 'volume', type: 'number', default: 0.6 }] },
  { type: 'stopMusic', label: 'Stop music', help: 'Fade the music out.', params: [{ name: 'fade', type: 'number', default: 1, label: 'fade (s)' }] },
  { type: 'pauseGame', label: 'Pause game', help: 'Freeze the game (or resume it) for pause menus: nothing moves, onDraw and pausedUpdate keep running. Changing scene resumes.', params: [{ name: 'paused', type: 'bool', default: true }] },
  { type: 'saveGame', label: 'Save game (slot)', help: 'Save everything in a slot: variables, the current scene with its instances, remembered scenes. Use hasSave("slot") in conditions.', params: [{ name: 'slot', type: 'text', default: 'auto' }] },
  { type: 'loadGame', label: 'Load game (slot)', help: 'Load a slot saved with "Save game" (at the end of the frame). Nothing happens if the slot is empty.', params: [{ name: 'slot', type: 'text', default: 'auto' }] },
  { type: 'lockControls', label: 'Lock player controls', help: 'Stop (or give back) player control, for cutscenes.', params: [{ name: 'locked', type: 'bool', default: true }] },
  { type: 'save', label: 'Save variable', help: 'Store a global variable in the browser (high scores). It is loaded back when the game starts.', params: [{ name: 'var', type: 'text', default: 'best' }] },
  { type: 'log', label: 'Log', help: 'Write a value to the console (and to playtest reports).', params: [{ name: 'value', type: 'expr', default: '"here"' }] },
];

export const BEHAVIORS: StepSpec[] = [
  { type: 'platformer', label: 'Platformer', help: 'Run with left/right (A/D), jump with up/W/space/Z. Gravity from the game settings. Picks idle/run/jump/fall animations when the sprite has those tags.', params: [{ name: 'speed', type: 'number', default: 100 }, { name: 'jump', type: 'number', default: 300 }, { name: 'acceleration', type: 'number', default: 1200 }, { name: 'controls', type: 'bool', default: true, label: 'player controls' }, { name: 'doubleJump', type: 'bool', default: false }] },
  { type: 'topdown', label: 'Top-down', help: '8-direction movement with arrows/WASD; hold Shift to run when "run speed" is above 0. Picks walk_<dir>/run_<dir>/idle_<dir> (or walk/run/idle) animations, matching Spritifer character rigs; without run animations it keeps the walk ones.', params: [{ name: 'speed', type: 'number', default: 80 }, { name: 'runSpeed', type: 'number', default: 0, label: 'run speed (Shift, 0 = off)' }, { name: 'controls', type: 'bool', default: true, label: 'player controls' }, { name: 'diagonals', type: 'bool', default: true }] },
  { type: 'solid', label: 'Solid', help: 'Blocks platformer, top-down, patrol and bullet movement (walls, platforms, crates).', params: [{ name: 'oneWay', type: 'bool', default: false, label: 'jump-through' }] },
  { type: 'bullet', label: 'Bullet', help: 'Moves in a straight line at an angle (0 = right, 90 = down) or with its current velocity.', params: [{ name: 'speed', type: 'number', default: 200 }, { name: 'angle', type: 'number', default: 0 }, { name: 'useVelocity', type: 'bool', default: false, label: 'keep spawn velocity' }, { name: 'destroyOnSolid', type: 'bool', default: true }] },
  { type: 'patrol', label: 'Patrol', help: 'Walks left and right, turning at walls (and ledges). Falls with gravity.', params: [{ name: 'speed', type: 'number', default: 40 }, { name: 'turnAtLedges', type: 'bool', default: true }, { name: 'gravity', type: 'bool', default: true }] },
  { type: 'chase', label: 'Chase', help: 'Moves toward the nearest instance of an object within range.', params: [{ name: 'target', type: 'object', default: 'player' }, { name: 'speed', type: 'number', default: 50 }, { name: 'range', type: 'number', default: 160 }] },
  { type: 'sine', label: 'Float (sine)', help: 'Bobs back and forth around its start position.', params: [{ name: 'axis', type: 'choice', options: ['y', 'x'], default: 'y' }, { name: 'amplitude', type: 'number', default: 4 }, { name: 'period', type: 'number', default: 1.5 }] },
  { type: 'camera', label: 'Camera follows', help: 'The camera follows this instance, clamped to the scene (or to camera.setBounds from scripts). Dead zone: the instance moves freely in a box around the center. Look ahead: the view shifts toward where it is going. Zoom 2 = twice as big.', params: [{ name: 'smoothing', type: 'number', default: 0.15 }, { name: 'offsetY', type: 'number', default: 0 }, { name: 'deadZoneX', type: 'number', default: 0, label: 'dead zone x', min: 0 }, { name: 'deadZoneY', type: 'number', default: 0, label: 'dead zone y', min: 0 }, { name: 'lookAhead', type: 'number', default: 0, label: 'look ahead', min: 0 }, { name: 'zoom', type: 'number', default: 1, min: 0.25, max: 8 }] },
  { type: 'bounded', label: 'Stay in scene', help: 'Cannot leave the scene rectangle.', params: [] },
  { type: 'lifetime', label: 'Lifetime', help: 'Destroyed after N seconds.', params: [{ name: 'seconds', type: 'number', default: 2 }] },
  { type: 'dialogue', label: 'Talks (dialogue)', help: 'The player talks to it by pressing action next to it. Plays the dialogue set on each placed instance (property "dialogue" in the scene inspector), or this default. One NPC type, many characters.', params: [{ name: 'dialogue', type: 'dialogue', default: '' }] },
  { type: 'script', label: 'Script component', help: 'A component written in scripts/<folder>/<Name>.js (export default class Name extends Behaviour). Its public fields are the params; set them here or per instance in the scene inspector.', params: [{ name: 'name', type: 'scriptBehavior', default: '' }] },
  { type: 'wrap', label: 'Wrap around', help: 'Leaving one side of the scene re-enters from the other (Asteroids).', params: [] },
];

const byType = (list: StepSpec[]) => new Map(list.map((s) => [s.type, s]));
export const TRIGGER_MAP = byType(TRIGGERS);
export const CONDITION_MAP = byType(CONDITIONS);
export const ACTION_MAP = byType(ACTIONS);
export const BEHAVIOR_MAP = byType(BEHAVIORS);

/** A step of the given type with default parameter values. */
export function defaultStep(spec: StepSpec): EventStep {
  const out: EventStep = { type: spec.type };
  for (const p of spec.params) if (p.default !== undefined) out[p.name] = p.default;
  return out;
}

/** Fills missing params with defaults. */
export function withDefaults<T extends EventStep | Behavior>(step: T, spec: StepSpec | undefined): T {
  if (!spec) return step;
  const out = { ...step } as Record<string, Value>;
  for (const p of spec.params) if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out as T;
}

/** Human-readable one-liner of a step, used by the editor and MCP summaries. */
export function describeStep(step: EventStep, spec: StepSpec | undefined): string {
  if (!spec) return `${step.type}?`;
  if (step.type === 'script') {
    // Component params are not in the catalog: show them all.
    const params = Object.entries(step).filter(([k]) => k !== 'type' && k !== 'name').map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return `component ${step.name}${params.length ? ' ' + params.join(' ') : ''}`;
  }
  const all = spec.params.filter((p) => step[p.name] !== undefined && step[p.name] !== '').map((p) => `${p.name}=${JSON.stringify(step[p.name])}`);
  return `${step.type}${all.length ? ' ' + all.join(' ') : ''}`;
}

export function describeEvent(e: GameEvent): string {
  const t = describeStep(e.trigger, TRIGGER_MAP.get(e.trigger.type));
  const c = e.conditions.map((s) => describeStep(s, CONDITION_MAP.get(s.type)));
  const a = e.actions.map((s) => describeStep(s, ACTION_MAP.get(s.type)));
  return `${e.disabled ? '(disabled) ' : ''}WHEN ${t}${c.length ? ' IF ' + c.join(' AND ') : ''} DO ${a.join('; ') || 'nothing'}${e.comment ? `  // ${e.comment}` : ''}`;
}

/** Markdown-ish reference of the whole vocabulary, for MCP clients. */
export function catalogReference(): string {
  const fmtList = (title: string, list: StepSpec[]) =>
    `${title}:\n` +
    list
      .map((s) => `- ${s.type}${s.params.length ? ` (${s.params.map((p) => `${p.name}: ${p.type}${p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}`).join(', ')})` : ''}: ${s.help}${s.objectOnly ? ' [object sheets only]' : ''}`)
      .join('\n');
  return [
    fmtList('TRIGGERS', TRIGGERS),
    fmtList('CONDITIONS (all must be true)', CONDITIONS),
    fmtList('ACTIONS (run in order)', ACTIONS),
    fmtList('BEHAVIORS (on object types)', BEHAVIORS),
    `KEYS: ${KEYS.join(', ')}`,
    `SOUNDS: ${SOUNDS.join(', ')}`,
    'EXPRESSIONS: numbers, "strings", true/false, + - * / %, == != < <= > >=, && || !, a ? b : c. ' +
      'Names: globals (score), self.<field|property>, other.<...> (the instance from a collision/overlap), scene.<scene variable>, game.time (seconds since scene start), game.dt. ' +
      'Instance fields: x, y, vx, vy, width, height, flipX, visible, opacity, angle, onGround, animation, object, text. ' +
      'Functions: random(a,b), randint(a,b), floor, ceil, round, abs, sign, min, max, clamp(v,lo,hi), sqrt, sin(deg), cos(deg), atan2(y,x), dist(x1,y1,x2,y2), lerp(a,b,t), ' +
      'count("object"), countTag("enemy"), hasSave("slot"), keyDown("key"), nearest("object", "x"|"y"), str(v), num(v), ' +
      'db("table", "id", "column") (a data table cell; db("table", "id") = the row exists, db("table") = row count), fn("name", args...) (calls a synchronous func() of a plain script and uses its result).',
    'CONDITIONAL INSTANCES: a placed instance can have activeIf (place_instances/update_instances active_if): it exists only while the expression is true, checked when the scene starts and continuously — towns that grow, upgraded shops, opened gates.',
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Validation

export interface Problem {
  where: string;
  message: string;
}

/** What validation needs to know about script components. */
export interface ComponentShape {
  name: string;
  legacy?: boolean;
  params: { name: string; type: string; options?: string[] }[];
}

export interface ScriptShape {
  behaviors: string[];
  functions: string[];
  errors: string[];
  components?: ComponentShape[];
}

/** Checks one component use: it exists, its params exist and reference real objects, scenes, sprites... */
function checkComponent(where: string, name: string, config: Record<string, Value>, scripts: ScriptShape, refs: { objects: Set<string>; scenes: Set<string>; sprites: Set<string>; dialogues?: string[]; audio?: string[]; actions?: string[]; vfx?: string[] }, out: Problem[]): void {
  const comp = scripts.components?.find((c) => c.name === name);
  if (!comp) {
    if (!scripts.behaviors.includes(name)) out.push({ where, message: name ? `no component "${name}" (create scripts/${name}.js: export default class ${name} extends Behaviour)` : 'component without a name' });
    return;
  }
  if (comp.legacy) return;
  for (const [k, v] of Object.entries(config)) {
    if (k === 'enabled') continue;
    const p = comp.params.find((x) => x.name === k);
    if (!p) {
      out.push({ where, message: `${name} has no param "${k}" (params: ${comp.params.map((x) => x.name).join(', ') || 'none'})` });
      continue;
    }
    const sv = String(v);
    if (v === '' && p.type !== 'number') continue;
    if (p.type === 'object' && !refs.objects.has(sv)) out.push({ where: `${where}.${k}`, message: `no object type "${sv}"` });
    else if (p.type === 'scene' && !refs.scenes.has(sv)) out.push({ where: `${where}.${k}`, message: `no scene "${sv}"` });
    else if (p.type === 'sprite' && !refs.sprites.has(sv)) out.push({ where: `${where}.${k}`, message: `sprite "${sv}" not found` });
    else if (p.type === 'sound' && !SOUNDS.includes(sv) && !refs.audio?.includes(sv)) out.push({ where: `${where}.${k}`, message: `unknown sound "${sv}"` });
    else if (p.type === 'key' && !KEYS.includes(sv) && !refs.actions?.includes(sv)) out.push({ where: `${where}.${k}`, message: `unknown key "${sv}"` });
    else if (p.type === 'dialogue' && refs.dialogues && !refs.dialogues.includes(sv)) out.push({ where: `${where}.${k}`, message: `no dialogue "${sv}"` });
    else if (p.type === 'choice' && p.options && !p.options.includes(sv)) out.push({ where: `${where}.${k}`, message: `"${sv}" is not one of ${p.options.join(', ')}` });
    else if (p.type === 'number' && typeof v !== 'number') out.push({ where: `${where}.${k}`, message: 'must be a number' });
    else if (p.type === 'bool' && typeof v !== 'boolean') out.push({ where: `${where}.${k}`, message: 'must be true or false' });
  }
}

function checkSteps(where: string, steps: EventStep[], specs: Map<string, StepSpec>, ctx: { objects: Set<string>; scenes: Set<string>; object: boolean; functions?: string[]; dialogues?: string[]; components?: string[]; audio?: string[]; actions?: string[]; vfx?: string[] }, out: Problem[]): void {
  steps.forEach((s, i) => {
    const spec = specs.get(s.type);
    const at = `${where}[${i}] ${s.type}`;
    if (!spec) {
      out.push({ where: at, message: `unknown type "${s.type}"` });
      return;
    }
    if (spec.objectOnly && !ctx.object) out.push({ where: at, message: 'only works on object event sheets' });
    for (const p of spec.params) {
      const v = s[p.name];
      if (v === undefined) continue;
      if (p.type === 'expr') {
        const err = checkExpr(v);
        if (err) out.push({ where: `${at}.${p.name}`, message: err });
      } else if (p.type === 'object' && (typeof v !== 'string' || !ctx.objects.has(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no object type "${v}"` });
      } else if (p.type === 'objectOrAny' && v !== 'any' && (typeof v !== 'string' || !ctx.objects.has(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no object type "${v}"` });
      } else if (p.type === 'scene' && (typeof v !== 'string' || !ctx.scenes.has(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no scene "${v}"` });
      } else if (p.type === 'key' && !KEYS.includes(String(v)) && !ctx.actions?.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `unknown key "${v}"` });
      } else if (p.type === 'music' && v !== '' && ctx.audio && !ctx.audio.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no audio "${v}" in audio/` });
      } else if (p.type === 'sound' && !SOUNDS.includes(String(v)) && !ctx.audio?.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `unknown sound "${v}"` });
      } else if (p.type === 'dialogue' && ctx.dialogues && !ctx.dialogues.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no dialogue "${v}"` });
      } else if (p.type === 'vfx' && ctx.vfx && !ctx.vfx.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no effect "${v}" in vfx/` });
      } else if (p.type === 'function' && ctx.functions && !ctx.functions.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no script function "${v}" (define it with func("${v}", ...))` });
      } else if (p.type === 'scriptBehavior' && v !== '' && ctx.components && !ctx.components.includes(String(v))) {
        out.push({ where: `${at}.${p.name}`, message: `no component "${v}"` });
      } else if (p.type === 'number' && typeof v !== 'number') {
        out.push({ where: `${at}.${p.name}`, message: 'must be a number' });
      }
    }
  });
}

function checkEvents(where: string, events: GameEvent[], ctx: { objects: Set<string>; scenes: Set<string>; object: boolean; functions?: string[]; dialogues?: string[]; components?: string[]; audio?: string[]; actions?: string[]; vfx?: string[] }, out: Problem[]): void {
  events.forEach((e, i) => {
    const w = `${where} event ${i}`;
    checkSteps(`${w} trigger`, [e.trigger], TRIGGER_MAP, ctx, out);
    checkSteps(`${w} conditions`, e.conditions, CONDITION_MAP, ctx, out);
    checkSteps(`${w} actions`, e.actions, ACTION_MAP, ctx, out);
  });
}

/** Static checks: unknown types, bad expressions, missing objects/scenes/sprites. */
export function validateGame(game: GameProject, scenes: Scene[], sprites: Set<string>, scripts?: ScriptShape, dialogues?: { nodes: string[]; errors: { file: string; line: number; message: string }[] }, audio?: string[], tables?: Record<string, DataTable>, vfx?: { graphs: Record<string, VfxGraph>; sprites: Map<string, string[]> }): Problem[] {
  const out: Problem[] = [];
  for (const g of Object.values(vfx?.graphs ?? {})) for (const message of checkVfx(g, { sprites: vfx?.sprites, sounds: [...SOUNDS, ...(audio ?? [])] })) out.push({ where: `effect ${g.name}`, message });
  // db("table", ...) in an expression must name a table.
  const checkDb = (where: string, src: string) => {
    if (!tables) return;
    for (const m of src.matchAll(/\bdb\(\s*["']([^"']+)["']/g)) if (!tables[m[1]]) out.push({ where, message: `no data table "${m[1]}"` });
  };
  for (const t of Object.values(tables ?? {})) {
    for (const c of t.columns) {
      if (c.type !== 'ref' || !c.table) continue;
      const target = tables?.[c.table];
      if (!target) {
        out.push({ where: `data ${t.name}.${c.name}`, message: `refers to a missing table "${c.table}"` });
        continue;
      }
      for (const r of t.rows) {
        const v = r[c.name];
        if (typeof v === 'string' && v && !target.rows.some((x) => x.id === v)) out.push({ where: `data ${t.name} row ${r.id}.${c.name}`, message: `no row "${v}" in table ${c.table}` });
      }
    }
  }
  for (const s of scenes) {
    for (const i of s.instances) {
      if (!i.activeIf) continue;
      const where = `scene ${s.name} instance ${i.name ?? i.object} activeIf`;
      const err = checkExpr(i.activeIf);
      if (err) out.push({ where, message: err });
      else checkDb(where, i.activeIf);
    }
  }
  for (const e of dialogues?.errors ?? []) out.push({ where: `dialogues/${e.file}.dialogue line ${e.line}`, message: e.message });
  const resolved = resolveObjectTypes(game.objects);
  for (const e of resolved.errors) out.push({ where: `object ${e.object}`, message: e.message });
  const eff = (name: string) => resolved.types.get(name);
  const talkers = new Set([...resolved.types.values()].filter((o) => o.behaviors.some((b) => b.type === 'dialogue')).map((o) => o.name));
  if (dialogues) {
    for (const s of scenes) {
      for (const i of s.instances) {
        const d = i.props?.dialogue;
        if (typeof d === 'string' && d && !dialogues.nodes.includes(d)) out.push({ where: `scene ${s.name} instance ${i.name ?? i.object}`, message: `no dialogue "${d}"` });
        if (i.sprite && !sprites.has(i.sprite)) out.push({ where: `scene ${s.name} instance ${i.name ?? i.object}`, message: `sprite "${i.sprite}" not found` });
        if (talkers.has(i.object) && !d && !eff(i.object)?.behaviors.find((b) => b.type === 'dialogue')?.dialogue) {
          out.push({ where: `scene ${s.name} instance ${i.name ?? i.object}`, message: 'talks but has no dialogue (set its "dialogue" property)' });
        }
      }
    }
  }
  for (const e of scripts?.errors ?? []) out.push({ where: 'scripts', message: e });
  for (const c of scripts?.components ?? []) for (const wmsg of (c as { warnings?: string[] }).warnings ?? []) out.push({ where: `component ${c.name}`, message: wmsg });
  const objects = new Set(game.objects.map((o) => o.name));
  const sceneNames = new Set(scenes.map((s) => s.name));
  const refs = { objects, scenes: sceneNames, sprites, dialogues: dialogues?.nodes, audio, actions: Object.keys(game.actions ?? {}) };
  const compNames = scripts?.behaviors;
  const params = (b: Record<string, Value>) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'type' && k !== 'name'));
  if (scripts) {
    (game.components ?? []).forEach((b, i) => checkComponent(`game component ${i} ${b.name}`, String(b.name ?? ''), params(b), scripts, refs, out));
    for (const s of scenes) {
      (s.components ?? []).forEach((b, i) => checkComponent(`scene ${s.name} component ${i} ${b.name}`, String(b.name ?? ''), params(b), scripts, refs, out));
      for (const inst of s.instances) {
        for (const [n, cfg] of Object.entries(inst.components ?? {})) checkComponent(`scene ${s.name} instance ${inst.name ?? inst.object} component ${n}`, n, cfg, scripts, refs, out);
      }
    }
  }
  if (!scenes.length) out.push({ where: 'game', message: 'no scenes yet' });
  else if (!sceneNames.has(game.startScene)) out.push({ where: 'game.startScene', message: `no scene "${game.startScene}" (the first scene will be used)` });
  for (const o of game.objects) {
    const full = eff(o.name) ?? o;
    if (o.sprite && !sprites.has(o.sprite)) out.push({ where: `object ${o.name}`, message: `sprite "${o.sprite}" not found` });
    // No sprite but a hitbox = an invisible trigger (map exits, cutscene zones): intended.
    if (!full.sprite && full.text === undefined && !full.hitbox) out.push({ where: `object ${o.name}`, message: 'has neither a sprite nor text nor a hitbox (it will be invisible and empty)' });
    o.behaviors.forEach((b, i) => {
      const spec = BEHAVIOR_MAP.get(b.type);
      if (!spec) out.push({ where: `object ${o.name} behavior ${i}`, message: `unknown behavior "${b.type}"` });
      else if (b.type === 'chase' && !objects.has(String(b.target ?? 'player'))) out.push({ where: `object ${o.name} behavior chase`, message: `no object type "${b.target}"` });
      else if (b.type === 'script' && scripts) checkComponent(`object ${o.name} component ${b.name}`, String(b.name ?? ''), params(b), scripts, refs, out);
    });
    if (o.text !== undefined) {
      const err = checkExpr(o.text);
      if (err) out.push({ where: `object ${o.name}.text`, message: err });
    }
    for (const b of o.behaviors) if (b.type === 'dialogue' && b.dialogue && dialogues && !dialogues.nodes.includes(String(b.dialogue))) out.push({ where: `object ${o.name} behavior Talks`, message: `no dialogue "${b.dialogue}"` });
    checkEvents(`object ${o.name}`, o.events, { objects, scenes: sceneNames, object: true, functions: scripts?.functions, dialogues: dialogues?.nodes, components: compNames, audio, actions: Object.keys(game.actions ?? {}), ...(vfx ? { vfx: Object.keys(vfx.graphs) } : {}) }, out);
  }
  for (const s of scenes) {
    if (s.tileset && !sprites.has(s.tileset)) out.push({ where: `scene ${s.name}`, message: `tileset sprite "${s.tileset}" not found` });
    if (s.music && s.music !== '-' && audio && !audio.includes(s.music)) out.push({ where: `scene ${s.name}`, message: `music "${s.music}" not found in audio/` });
    for (const b of s.backgrounds) if (!sprites.has(b.sprite)) out.push({ where: `scene ${s.name} background`, message: `sprite "${b.sprite}" not found` });
    const missing = new Set(s.instances.filter((i) => !objects.has(i.object)).map((i) => i.object));
    for (const m of missing) out.push({ where: `scene ${s.name}`, message: `instances of unknown object "${m}"` });
    checkEvents(`scene ${s.name}`, s.events, { objects, scenes: sceneNames, object: false, functions: scripts?.functions, dialogues: dialogues?.nodes, components: compNames, audio, actions: Object.keys(game.actions ?? {}), ...(vfx ? { vfx: Object.keys(vfx.graphs) } : {}) }, out);
  }
  return out;
}
