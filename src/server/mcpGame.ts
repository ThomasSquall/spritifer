/** MCP tools for building games: project settings, object types, scenes, tiles, instances, events, playtests, export. */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BEHAVIOR_MAP, catalogReference, describeEvent, describeStep } from '../core/game/catalog.js';
import { type PlaytestInput, runPlaytest } from '../core/game/engine.js';
import { renameComponentRefs, renameObjectRefs, renameSceneRefs } from '../core/game/refactor.js';
import {
  type GameEvent,
  type GameProject,
  type ObjectType,
  type Scene,
  type Value,
  assertIdentifier,
  createScene,
  newGameId,
  normalizeEvents,
  normalizeComponents,
  normalizeGame,
  normalizeObject,
  normalizeScene,
  resizeScene,
} from '../core/game/types.js';
import { BitmapRenderer, buildAsset, exportGame, loadGameBundle, renderScenePreview, renderViewport } from './game.js';
import { encodePng } from './png.js';
import { scaleBitmap } from '../core/draw.js';
import type { Workspace } from './store.js';
import { addLibraryComponents, checkScriptSyntax, inspectScripts, nodeEvaluator, refreshScriptTypes } from './scripts.js';
import { LIBRARY } from '../core/game/library.js';
import { scriptBaseName } from '../core/game/modules.js';
import { SCRIPT_REFERENCE } from '../core/game/script.js';
import { DIALOGUE_REFERENCE, buildDialogueBook, parseDialogues } from '../core/game/dialogue.js';

type Content = CallToolResult['content'];

export interface ToolHelpers {
  tool: <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Content | Promise<Content>,
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
  ) => void;
  text: (t: string) => Content;
  image: (png: Buffer) => Content[number];
}

export const GAME_INSTRUCTIONS = `
MAKING GAMES — Spritifer is also a complete 2D game maker. The workspace holds game.json (settings, object types, global variables) and <scene>.scene.json files; the web editor shows them live (Objects, Scenes, Game tabs, Play button) and export_game writes a single playable index.html.

Model:
- Object types (set_object) are reusable things: player, enemy, coin, door, bullet, score label. Each has a sprite (+ default animation tag), an optional hitbox, behaviors (platformer, topdown, solid, bullet, patrol, chase, sine, camera, bounded, lifetime, wrap), properties (instance variables with defaults) and an event sheet. Text objects (text = expression, hud = true) show scores and labels.
- Scenes (create_scene) are tile maps (cols x rows, tileSize from the tileset sprite's grid) with tile layers (solid layers collide) and placed instances. Scenes have their own event sheet and variables.
- Events: WHEN trigger IF conditions DO actions. Call game_reference for the full vocabulary (triggers, conditions, actions, behaviors, keys, sounds, expression syntax).
- Dialogues (write_dialogue, dialogue_reference) are plain-text conversations: speakers, choices, conditions, variables, commands, jumps. NPCs: ONE object type with the behavior "dialogue" (+ solid), placed many times, each instance with its own name, optional sprite override and props { dialogue: "<name>" }. Never create one object type or script per NPC.
- Scripts (write_script, script_reference) are JavaScript files in scripts/ (use folders: scripts/enemies/Patrol.js, scripts/ui/Hud.js, scripts/managers/GameManager.js) for logic events can't express well. Write COMPONENTS, Unity-style: ONE class per file named like the file (export default class Patrol extends Behaviour), public fields = inspector params, lifecycle awake/start/update/lateUpdate/onCollisionEnter/Stay/Exit/onInteract/onDraw/onDestroy, this.getComponent('Health') / findComponent('GameManager') to talk to other scripts, import for shared helpers. Attach them to object types ({ type: "script", name: "Patrol", speed: 60 } in behaviors), override params per placed instance (instances components: { Patrol: { speed: 80 } }), or attach managers to scenes (update_scene components) and to the whole game (set_game components). Never put several behaviours in one file. For common mechanics first check component_library (Health, Damage, Shooter, Collectible, Door, Checkpoint, Respawn, Spawner, Countdown) and add them with add_library_component.
- RPGs: top-down player (topdown + camera, sprite tags walk_<dir>/idle_<dir>), scene y_sort and persistent (towns remember chests/positions after battles), solid tile layers for walls, NPCs and chests via dialogues (~ self.opened = true), an intro via a scene event (start → dialogue), battles in a scene driven by a scene component (class Battle extends Behaviour { async start() {...} } attached to the battle scene).
- Projects: list_projects / open_project / create_project switch between games; each project folder has its own sprites, scenes, scripts and game.json.

Workflow that works:
1. Draw the art first with the sprite tools: a tileset sprite with tile_width/tile_height (index = position in the grid, row-major), characters with tags idle/run/jump/fall (platformer) or idle_<dir>/walk_<dir> (topdown, as rig_animate makes them), items, enemies. tileset_preview shows each tile's index.
2. set_game (resolution, e.g. 320x180; gravity) and set_object for each kind of thing. The player gets platformer or topdown + camera.
3. create_scene, paint_tiles (rows + legend like draw_pixels, chars → tile indices; set solid on collision layers with set_tile_layer), place_instances.
4. Events: collisions (collect coins: add score, destroy other, sound coin), hazards (restartScene), goals (gotoScene), HUD text objects.
5. ALWAYS verify: validate_game, preview_scene, then playtest with scripted inputs (e.g. hold right 2s, tap up) and read the final state, logs and screenshot. Fix and re-test until it plays as intended.
6. export_game and tell the user where index.html is (it runs offline and can be uploaded to itch.io as an HTML game).
`;

export function registerGameTools(ws: Workspace, h: ToolHelpers): { reset(): void } {
  const { tool, text, image } = h;
  const AUTHOR = 'claude';
  const history: { kind: 'game' | 'scene'; name: string; json: string | null }[] = [];

  const remember = (kind: 'game' | 'scene', name: string) => {
    let json: string | null = null;
    if (kind === 'game' && ws.hasGame()) json = JSON.stringify(ws.loadGame());
    if (kind === 'scene' && ws.sceneExists(name)) json = JSON.stringify(ws.loadScene(name));
    history.push({ kind, name, json });
    if (history.length > 60) history.shift();
  };

  const mutateGame = <T>(fn: (g: GameProject) => T): { game: GameProject; result: T } => {
    const game = ws.loadGame();
    remember('game', 'game');
    const result = fn(game);
    ws.saveGame(game, AUTHOR);
    return { game, result };
  };

  const mutateScene = <T>(name: string, fn: (s: Scene) => T): { scene: Scene; result: T } => {
    const scene = ws.loadScene(name);
    remember('scene', name);
    const result = fn(scene);
    ws.saveScene(scene, AUTHOR);
    return { scene, result };
  };

  const describeObject = (o: ObjectType) => {
    const lines = [
      `Object "${o.name}": ${o.sprite ? `sprite ${o.sprite}${o.animation ? ` (animation ${o.animation})` : ''}` : 'no sprite'}${o.text !== undefined ? `, text ${JSON.stringify(o.text)}${o.hud ? ' (HUD)' : ''}` : ''}${o.hitbox ? `, hitbox ${o.hitbox.x},${o.hitbox.y} ${o.hitbox.w}x${o.hitbox.h}` : ''}${o.z ? `, z ${o.z}` : ''}`,
    ];
    if (o.behaviors.length) lines.push(`  behaviors: ${o.behaviors.map((b) => describeStep(b, BEHAVIOR_MAP.get(b.type))).join('; ')}`);
    if (Object.keys(o.properties).length) lines.push(`  properties: ${Object.entries(o.properties).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    o.events.forEach((e, i) => lines.push(`  [${i}] ${describeEvent(e)}`));
    return lines.join('\n');
  };

  const describeScene = (s: Scene) => {
    const counts = new Map<string, number>();
    for (const i of s.instances) counts.set(i.object, (counts.get(i.object) ?? 0) + 1);
    const lines = [
      `Scene "${s.name}": ${s.cols}x${s.rows} tiles of ${s.tileSize}px (${s.cols * s.tileSize}x${s.rows * s.tileSize}px), tileset ${s.tileset ?? 'none'}${s.background ? `, background ${s.background}` : ''}${s.ySort ? ', y-sorted' : ''}${s.persistent ? ', persistent' : ''}`,
      `Layers: ${s.layers.map((l, i) => `[${i}] ${l.name}${l.solid ? ' (solid)' : ''}${l.visible ? '' : ' (hidden)'}: ${l.tiles.filter((t) => t >= 0).length} tiles`).join(', ')}`,
      `Instances (${s.instances.length}): ${[...counts].map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
    ];
    if (Object.keys(s.variables).length) lines.push(`Variables: ${Object.entries(s.variables).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    if (s.components?.length) lines.push(`Scene components: ${s.components.map((b) => describeStep(b, BEHAVIOR_MAP.get('script'))).join('; ')}`);
    const custom = s.instances.filter((i) => i.components);
    if (custom.length) lines.push(`Instance component overrides: ${custom.map((i) => `${i.name ?? i.object}#${i.id} ${JSON.stringify(i.components)}`).join('; ')}`);
    if (s.backgrounds.length) lines.push(`Backgrounds: ${s.backgrounds.map((b) => `${b.sprite} parallax ${b.parallax}`).join(', ')}`);
    s.events.forEach((e, i) => lines.push(`  [${i}] ${describeEvent(e)}`));
    return lines.join('\n');
  };

  const problemsText = () => {
    const { problems } = loadGameBundle(ws);
    return problems.length ? `Problems (${problems.length}):\n${problems.map((p) => `- ${p.where}: ${p.message}`).join('\n')}` : 'No problems found.';
  };

  const valueSchema = z.union([z.number(), z.string(), z.boolean()]);
  const stepSchema = z.record(z.string(), valueSchema).describe('{ type: "...", ...params }');
  const eventSchema = z.object({
    trigger: stepSchema,
    conditions: z.array(stepSchema).optional(),
    actions: z.array(stepSchema),
    comment: z.string().optional(),
    disabled: z.boolean().optional(),
  });

  // ------------------------------------------------------------------ reference & overview

  tool('game_reference', 'Reference of the event system: triggers, conditions, actions, behaviors (with parameters and defaults), keys, sounds and expression syntax. Read it before writing events.', {}, () => text(catalogReference()), { readOnlyHint: true });

  tool('get_game', 'Overview of the game project: settings, global variables, every object type (behaviors, properties, events), scenes and validation problems.', {}, () => {
    const g = ws.loadGame();
    const scenes = ws.listScenes();
    const lines = [
      `Game "${g.title}"${ws.hasGame() ? '' : ' (not saved yet: defaults)'}: ${g.width}x${g.height}px, zoom ${g.zoom}, background ${g.background}, gravity ${g.gravity}, start scene ${g.startScene || '(first scene)'}${g.touchControls ? ', touch controls' : ''}`,
      `Variables: ${Object.entries(g.variables).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') || 'none'}`,
      `Global components: ${g.components?.map((b) => describeStep(b, BEHAVIOR_MAP.get('script'))).join('; ') || 'none'}`,
      `Scenes: ${scenes.map((s) => `${s.name} (${s.cols}x${s.rows}, ${s.instances} instances)`).join(', ') || 'none'}`,
      '',
      ...g.objects.map(describeObject),
      '',
      problemsText(),
    ];
    return text(lines.join('\n'));
  }, { readOnlyHint: true });

  tool(
    'set_game',
    'Update game settings and global variables. Only the given fields change. Variables merge; set a variable to null to delete it.',
    {
      title: z.string().optional(),
      width: z.number().int().min(16).max(1920).optional().describe('Viewport width in game pixels (e.g. 320)'),
      height: z.number().int().min(16).max(1080).optional().describe('Viewport height (e.g. 180)'),
      zoom: z.union([z.literal('fit'), z.number().int().min(1).max(16)]).optional().describe('"fit" = largest integer zoom that fits the window'),
      background: z.string().optional(),
      start_scene: z.string().optional(),
      gravity: z.number().optional().describe('px/s² for platformer/patrol (default 900)'),
      touch_controls: z.boolean().optional(),
      variables: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      components: z.array(stepSchema).optional().describe('Global components alive for the whole game across scenes (replace the list): [{ type: "script", name: "GameManager" }]'),
    },
    (a) => {
      const { game } = mutateGame((g) => {
        if (a.components) {
          const list = normalizeComponents(a.components.map((b) => ({ ...b, type: 'script' })));
          if (list) g.components = list;
          else delete g.components;
        }
        if (a.title !== undefined) g.title = a.title;
        if (a.width !== undefined) g.width = a.width;
        if (a.height !== undefined) g.height = a.height;
        if (a.zoom !== undefined) g.zoom = a.zoom;
        if (a.background !== undefined) g.background = a.background;
        if (a.start_scene !== undefined) {
          if (!ws.sceneExists(a.start_scene)) throw new Error(`No scene "${a.start_scene}"`);
          g.startScene = a.start_scene;
        }
        if (a.gravity !== undefined) g.gravity = a.gravity;
        if (a.touch_controls !== undefined) g.touchControls = a.touch_controls;
        for (const [k, v] of Object.entries(a.variables ?? {})) {
          assertIdentifier('variable', k);
          if (v === null) delete g.variables[k];
          else g.variables[k] = v;
        }
        Object.assign(g, normalizeGame(g));
      });
      return text(`Saved. Game "${game.title}" ${game.width}x${game.height}, variables: ${JSON.stringify(game.variables)}`);
    },
  );

  // ------------------------------------------------------------------ objects

  tool(
    'set_object',
    'Create or update an object type. Only given fields change; behaviors and events replace the whole list when given (use set_events to append events). Properties merge (null deletes). Use new_name to rename (references in scenes and events are updated).',
    {
      name: z.string(),
      new_name: z.string().optional(),
      sprite: z.string().nullable().optional().describe('Sprite drawn for instances (null = none, e.g. for text objects)'),
      animation: z.string().optional().describe('Default animation tag ("" = all frames)'),
      hitbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional().describe('Collision box relative to the sprite top-left (null = whole frame). Make it a bit smaller than the art for fair collisions.'),
      z: z.number().optional().describe('Draw order (higher = in front; tile layers default to -10..)'),
      text: z.string().nullable().optional().describe('Text objects: expression shown as text, e.g. "\\"Score: \\" + score"'),
      text_color: z.string().optional(),
      text_size: z.number().int().min(1).max(8).optional(),
      hud: z.boolean().optional().describe('Draw in screen space (ignores the camera)'),
      properties: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      behaviors: z.array(stepSchema).optional().describe('e.g. [{type:"platformer", speed:100, jump:300}, {type:"camera"}]'),
      events: z.array(eventSchema).optional(),
    },
    (a) => {
      assertIdentifier('object', a.name);
      const sprites = new Set(ws.list().map((s) => s.name));
      if (a.sprite && !sprites.has(a.sprite)) throw new Error(`Sprite "${a.sprite}" not found. Available: ${[...sprites].join(', ') || 'none'}`);
      let renamedScenes: Scene[] = [];
      const { game, result: created } = mutateGame((g) => {
        let o = g.objects.find((x) => x.name === a.name);
        const created = !o;
        if (!o) {
          o = normalizeObject({ name: a.name });
          g.objects.push(o);
        }
        if (a.sprite !== undefined) {
          if (a.sprite === null) delete o.sprite;
          else o.sprite = a.sprite;
        }
        if (a.animation !== undefined) {
          if (a.animation) o.animation = a.animation;
          else delete o.animation;
        }
        if (a.hitbox !== undefined) {
          if (a.hitbox === null) delete o.hitbox;
          else o.hitbox = a.hitbox;
        }
        if (a.z !== undefined) o.z = a.z;
        if (a.text !== undefined) {
          if (a.text === null) delete o.text;
          else o.text = a.text;
        }
        if (a.text_color !== undefined) o.textColor = a.text_color;
        if (a.text_size !== undefined) o.textSize = a.text_size;
        if (a.hud !== undefined) {
          if (a.hud) o.hud = true;
          else delete o.hud;
        }
        for (const [k, v] of Object.entries(a.properties ?? {})) {
          assertIdentifier('property', k);
          if (v === null) delete o.properties[k];
          else o.properties[k] = v;
        }
        if (a.behaviors) {
          for (const b of a.behaviors) if (!BEHAVIOR_MAP.has(String(b.type))) throw new Error(`Unknown behavior "${b.type}". See game_reference.`);
          o.behaviors = normalizeObject({ behaviors: a.behaviors }).behaviors;
        }
        if (a.events) o.events = normalizeEvents(a.events);
        if (a.new_name && a.new_name !== a.name) {
          const scenes = ws.listScenes().map((s) => ws.loadScene(s.name));
          renamedScenes = renameObjectRefs(g, scenes, a.name, a.new_name);
        }
        return created;
      });
      for (const s of renamedScenes) {
        remember('scene', s.name);
        ws.saveScene(s, AUTHOR);
      }
      const o = game.objects.find((x) => x.name === (a.new_name || a.name))!;
      return text(`${created ? 'Created' : 'Updated'}.\n${describeObject(o)}\n\n${problemsText()}`);
    },
  );

  tool('delete_object', 'Delete an object type and (optionally) its instances in every scene.', { name: z.string(), remove_instances: z.boolean().optional().describe('Default true') }, (a) => {
    mutateGame((g) => {
      const i = g.objects.findIndex((o) => o.name === a.name);
      if (i < 0) throw new Error(`No object type "${a.name}"`);
      g.objects.splice(i, 1);
    });
    let removed = 0;
    if (a.remove_instances !== false) {
      for (const s of ws.listScenes()) {
        const sc = ws.loadScene(s.name);
        const before = sc.instances.length;
        sc.instances = sc.instances.filter((x) => x.object !== a.name);
        if (sc.instances.length !== before) {
          remember('scene', sc.name);
          removed += before - sc.instances.length;
          ws.saveScene(sc, AUTHOR);
        }
      }
    }
    return text(`Deleted object type "${a.name}"${removed ? ` and ${removed} instance(s)` : ''}.`);
  }, { destructiveHint: true });

  tool(
    'set_events',
    'Replace, append to, or remove from the event sheet of an object type or a scene. Each event: { trigger: {type, ...}, conditions: [{type, ...}], actions: [{type, ...}] }. See game_reference.',
    {
      object: z.string().optional().describe('Object type whose sheet to edit'),
      scene: z.string().optional().describe('Or: the scene whose sheet to edit'),
      events: z.array(eventSchema).optional(),
      mode: z.enum(['replace', 'append', 'remove']).optional().describe('Default append. remove deletes events by index (indices).'),
      indices: z.array(z.number().int().min(0)).optional(),
    },
    (a) => {
      if (!!a.object === !!a.scene) throw new Error('Pass either object or scene');
      const mode = a.mode ?? 'append';
      const apply = (list: GameEvent[]): GameEvent[] => {
        if (mode === 'remove') {
          const drop = new Set(a.indices ?? []);
          return list.filter((_, i) => !drop.has(i));
        }
        const add = normalizeEvents(a.events ?? []);
        return mode === 'replace' ? add : [...list, ...add];
      };
      let out: string;
      if (a.object) {
        const { game } = mutateGame((g) => {
          const o = g.objects.find((x) => x.name === a.object);
          if (!o) throw new Error(`No object type "${a.object}"`);
          o.events = apply(o.events);
        });
        out = describeObject(game.objects.find((x) => x.name === a.object)!);
      } else {
        const { scene } = mutateScene(a.scene!, (s) => {
          s.events = apply(s.events);
        });
        out = describeScene(scene);
      }
      return text(`Saved.\n${out}\n\n${problemsText()}`);
    },
  );

  // ------------------------------------------------------------------ scenes

  tool(
    'create_scene',
    'Create a scene (a tile map with layers and instances). The tile size comes from the tileset sprite grid. Starts with one solid layer "ground".',
    {
      name: z.string(),
      cols: z.number().int().min(1).max(1024).describe('Width in tiles'),
      rows: z.number().int().min(1).max(1024).describe('Height in tiles'),
      tileset: z.string().optional().describe('Sprite with a tile grid'),
      tile_size: z.number().int().min(1).max(256).optional().describe('Only without a tileset (default 16)'),
      background: z.string().optional().describe('Background color (default: the game background)'),
      overwrite: z.boolean().optional(),
    },
    (a) => {
      assertIdentifier('scene', a.name);
      if (ws.sceneExists(a.name) && !a.overwrite) throw new Error(`Scene "${a.name}" already exists (overwrite: true to replace)`);
      let tileSize = a.tile_size ?? 16;
      if (a.tileset) {
        const ts = ws.load(a.tileset);
        if (!ts.grid) throw new Error(`Sprite "${a.tileset}" has no tile grid (create it with tile_width/tile_height)`);
        tileSize = ts.grid.width;
      }
      remember('scene', a.name);
      const scene = createScene({ name: a.name, cols: a.cols, rows: a.rows, tileSize, tileset: a.tileset, background: a.background ?? '' });
      ws.saveScene(scene, AUTHOR);
      const g = ws.loadGame();
      if (!g.startScene || !ws.sceneExists(g.startScene) || !ws.hasGame()) {
        remember('game', 'game');
        g.startScene = g.startScene && ws.sceneExists(g.startScene) ? g.startScene : a.name;
        ws.saveGame(g, AUTHOR);
      }
      return text(`Created.\n${describeScene(scene)}`);
    },
  );

  tool('get_scene', 'Describe a scene: size, layers, instances (with ids and positions) and events. With layer, also dumps that layer as a character grid (tile indices in base36, "." empty).', {
    scene: z.string(),
    layer: z.string().optional(),
    region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).optional().describe('Tile region for the dump'),
  }, (a) => {
    const s = ws.loadScene(a.scene);
    const lines = [describeScene(s), '', 'Instances:'];
    for (const i of s.instances) lines.push(`- ${i.id}: ${i.name ? `"${i.name}" (${i.object})` : i.object}${i.sprite ? ` sprite ${i.sprite}` : ''} at ${i.x},${i.y} (tile ${Math.floor(i.x / s.tileSize)},${Math.floor(i.y / s.tileSize)})${i.flipX ? ' flipped' : ''}${i.props ? ' ' + JSON.stringify(i.props) : ''}`);
    if (a.layer) {
      const l = s.layers.find((x) => x.name === a.layer);
      if (!l) throw new Error(`No layer "${a.layer}"`);
      const r = a.region ?? { x: 0, y: 0, w: s.cols, h: s.rows };
      lines.push('', `Layer ${l.name} tiles x ${r.x}..${r.x + r.w - 1}, y ${r.y}..${r.y + r.h - 1}:`);
      for (let y = r.y; y < Math.min(s.rows, r.y + r.h); y++) {
        let row = '';
        for (let x = r.x; x < Math.min(s.cols, r.x + r.w); x++) {
          const t = l.tiles[y * s.cols + x];
          row += t < 0 ? '.' : t < 36 ? t.toString(36) : '#';
        }
        lines.push(`${String(y).padStart(3)} ${row}`);
      }
    }
    return text(lines.join('\n'));
  }, { readOnlyHint: true });

  tool(
    'update_scene',
    'Change scene properties: size (keeps the top-left content), tileset, background color, parallax background sprites, scene variables, y-sort, name.',
    {
      scene: z.string(),
      new_name: z.string().optional(),
      cols: z.number().int().min(1).max(1024).optional(),
      rows: z.number().int().min(1).max(1024).optional(),
      tileset: z.string().nullable().optional(),
      background: z.string().optional(),
      backgrounds: z.array(z.object({ sprite: z.string(), parallax: z.number().optional(), repeat_x: z.boolean().optional(), y: z.number().optional() })).optional().describe('Parallax background images, back to front'),
      variables: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      y_sort: z.boolean().optional().describe('Draw instances lower on screen in front (top-down / RPG depth)'),
      persistent: z.boolean().optional().describe('Remember instances when leaving (positions, properties, destroyed ones), e.g. an RPG town you come back to after a battle'),
      components: z.array(stepSchema).optional().describe('Scene components (replace the list): [{ type: "script", name: "Battle", foeHp: 12 }] — managers, level logic, HUD'),
    },
    (a) => {
      const { scene } = mutateScene(a.scene, (s) => {
        if (a.persistent !== undefined) {
          if (a.persistent) s.persistent = true;
          else delete s.persistent;
        }
        if (a.y_sort !== undefined) {
          if (a.y_sort) s.ySort = true;
          else delete s.ySort;
        }
        if (a.cols !== undefined || a.rows !== undefined) resizeScene(s, a.cols ?? s.cols, a.rows ?? s.rows);
        if (a.tileset !== undefined) {
          if (a.tileset === null) delete s.tileset;
          else {
            const ts = ws.load(a.tileset);
            if (!ts.grid) throw new Error(`Sprite "${a.tileset}" has no tile grid`);
            s.tileset = a.tileset;
            s.tileSize = ts.grid.width;
          }
        }
        if (a.background !== undefined) s.background = a.background;
        if (a.components) {
          const list = normalizeComponents(a.components.map((b) => ({ ...b, type: 'script' })));
          if (list) s.components = list;
          else delete s.components;
        }
        if (a.backgrounds) s.backgrounds = a.backgrounds.map((b) => ({ sprite: b.sprite, parallax: b.parallax ?? 0.5, repeatX: b.repeat_x ?? true, y: b.y ?? 0 }));
        for (const [k, v] of Object.entries(a.variables ?? {})) {
          assertIdentifier('variable', k);
          if (v === null) delete s.variables[k];
          else s.variables[k] = v;
        }
      });
      if (a.new_name && a.new_name !== a.scene) {
        if (ws.sceneExists(a.new_name)) throw new Error(`Scene "${a.new_name}" already exists`);
        const game = ws.loadGame();
        const others = ws.listScenes().filter((s) => s.name !== a.scene).map((s) => ws.loadScene(s.name));
        scene.name = a.new_name;
        remember('game', 'game');
        const changed = renameSceneRefs(game, [scene, ...others], a.scene, a.new_name);
        ws.saveScene(scene, AUTHOR);
        ws.removeScene(a.scene);
        for (const s of changed) if (s !== scene) ws.saveScene(s, AUTHOR);
        ws.saveGame(game, AUTHOR);
      }
      return text(`Saved.\n${describeScene(scene)}`);
    },
  );

  tool('delete_scene', 'Delete a scene file.', { scene: z.string() }, (a) => {
    remember('scene', a.scene);
    ws.removeScene(a.scene);
    return text(`Deleted scene "${a.scene}".`);
  }, { destructiveHint: true });

  tool(
    'set_tile_layer',
    'Create or change a tile layer: solid (collides), visible, parallax, z (draw order; > 0 draws in front of objects), rename, or delete.',
    {
      scene: z.string(),
      layer: z.string(),
      new_name: z.string().optional(),
      solid: z.boolean().optional(),
      visible: z.boolean().optional(),
      parallax: z.number().optional(),
      z: z.number().optional(),
      delete: z.boolean().optional(),
    },
    (a) => {
      const { scene } = mutateScene(a.scene, (s) => {
        let l = s.layers.find((x) => x.name === a.layer);
        if (a.delete) {
          if (!l) throw new Error(`No layer "${a.layer}"`);
          s.layers = s.layers.filter((x) => x !== l);
          return;
        }
        if (!l) {
          l = { name: a.layer, tiles: new Array(s.cols * s.rows).fill(-1), solid: false, visible: true };
          s.layers.push(l);
        }
        if (a.new_name) l.name = a.new_name;
        if (a.solid !== undefined) l.solid = a.solid;
        if (a.visible !== undefined) l.visible = a.visible;
        if (a.parallax !== undefined) l.parallax = a.parallax;
        if (a.z !== undefined) l.z = a.z;
      });
      return text(`Saved.\n${describeScene(scene)}`);
    },
  );

  tool(
    'paint_tiles',
    'Paint tiles on a scene layer. Either rows (strings, one char per tile) + legend (char → tile index, -1 erases; "." and space not in the legend leave tiles unchanged) at tile x, y; or rect + tile to fill a rectangle. Tile indices count row-major over the tileset grid (tileset_preview shows them).',
    {
      scene: z.string(),
      layer: z.string().optional().describe('Layer name (default: first layer)'),
      x: z.number().int().optional().describe('Tile column of the first char (default 0)'),
      y: z.number().int().optional(),
      rows: z.array(z.string()).optional(),
      legend: z.record(z.string(), z.number().int().min(-1)).optional(),
      rect: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
      tile: z.number().int().min(-1).optional(),
      preview: z.boolean().optional().describe('Return a preview of the scene'),
    },
    (a) => {
      let count = 0;
      const { scene } = mutateScene(a.scene, (s) => {
        const l = a.layer ? s.layers.find((x) => x.name === a.layer) : s.layers[0];
        if (!l) throw new Error(`No layer "${a.layer}". Layers: ${s.layers.map((x) => x.name).join(', ')} (create it with set_tile_layer)`);
        const put = (tx: number, ty: number, t: number) => {
          if (tx < 0 || ty < 0 || tx >= s.cols || ty >= s.rows) return;
          l.tiles[ty * s.cols + tx] = t;
          count++;
        };
        if (a.rect) {
          if (a.tile === undefined) throw new Error('rect needs tile');
          for (let ty = a.rect.y; ty < a.rect.y + a.rect.h; ty++) for (let tx = a.rect.x; tx < a.rect.x + a.rect.w; tx++) put(tx, ty, a.tile);
        }
        if (a.rows) {
          const legend = a.legend ?? {};
          a.rows.forEach((row, dy) => {
            [...row].forEach((ch, dx) => {
              if (!(ch in legend)) {
                if (ch === '.' || ch === ' ') return;
                throw new Error(`Character "${ch}" is not in the legend`);
              }
              put((a.x ?? 0) + dx, (a.y ?? 0) + dy, legend[ch]);
            });
          });
        }
      });
      const out: Content = text(`Painted ${count} tile(s) on "${a.scene}".`);
      if (a.preview) out.push(image(renderScenePreview(loadGameBundle(ws), scene.name, { grid: true }).png));
      return out;
    },
  );

  tool(
    'place_instances',
    'Place instances of object types in a scene. x, y are the sprite top-left in pixels; with tiles: true they are tile coordinates and the sprite stands on the bottom of that tile (bottom-aligned, horizontally centered).',
    {
      scene: z.string(),
      instances: z.array(z.object({
        object: z.string(),
        x: z.number(),
        y: z.number(),
        name: z.string().optional().describe('Instance name (hierarchy, dialogue speaker "self"), e.g. "Elder Tom"'),
        sprite: z.string().optional().describe('Use this sprite instead of the object type\'s (one NPC type, many looks)'),
        animation: z.string().optional(),
        props: z.record(z.string(), valueSchema).optional().describe('Instance properties, e.g. { dialogue: "elder" } for a Talks NPC'),
        components: z.record(z.string(), z.record(z.string(), valueSchema)).optional().describe('Component params for this instance, by component name: { Patrol: { speed: 80 } }. A component the object type lacks is added to this instance only; { enabled: false } turns one off.'),
        flip_x: z.boolean().optional(),
      })).min(1),
      tiles: z.boolean().optional(),
    },
    (a) => {
      const game = ws.loadGame();
      const loaded = loadGameBundle(ws);
      const ids: string[] = [];
      const { scene } = mutateScene(a.scene, (s) => {
        for (const i of a.instances) {
          const obj = game.objects.find((o) => o.name === i.object);
          if (!obj) throw new Error(`No object type "${i.object}". Create it with set_object.`);
          let x = i.x;
          let y = i.y;
          if (a.tiles) {
            const spr = i.sprite ?? obj.sprite;
          if (i.sprite && !loaded.bundle.sprites[i.sprite] && !ws.exists(i.sprite)) throw new Error(`Sprite "${i.sprite}" not found`);
          const asset = spr ? loaded.bundle.sprites[spr] ?? (ws.exists(spr) ? buildAsset(ws.load(spr), false).asset : undefined) : undefined;
            const w = asset?.width ?? s.tileSize;
            const hh = asset?.height ?? s.tileSize;
            x = Math.round(i.x * s.tileSize + (s.tileSize - w) / 2);
            y = (i.y + 1) * s.tileSize - hh;
          }
          const id = newGameId();
          ids.push(id);
          s.instances.push({ id, object: i.object, x, y, ...(i.name ? { name: i.name } : {}), ...(i.sprite ? { sprite: i.sprite } : {}), ...(i.animation ? { animation: i.animation } : {}), ...(i.props ? { props: i.props } : {}), ...(i.components ? { components: i.components as Record<string, Record<string, Value>> } : {}), ...(i.flip_x ? { flipX: true } : {}) });
        }
      });
      return text(`Placed ${ids.length} instance(s): ${ids.join(', ')}. Scene now has ${scene.instances.length}.`);
    },
  );

  tool(
    'update_instances',
    'Move, flip, rename, re-skin (sprite override), change props (e.g. dialogue) of, or remove instances in a scene (by id, or every instance of an object type).',
    {
      scene: z.string(),
      ids: z.array(z.string()).optional(),
      object: z.string().optional().describe('Apply to all instances of this object type'),
      remove: z.boolean().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      dx: z.number().optional().describe('Relative move'),
      dy: z.number().optional(),
      flip_x: z.boolean().optional(),
      name: z.string().nullable().optional().describe('Rename (null clears)'),
      sprite: z.string().nullable().optional().describe('Sprite override (null = the object type\'s)'),
      animation: z.string().nullable().optional(),
      props: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      components: z.record(z.string(), z.union([z.record(z.string(), z.union([valueSchema, z.null()])), z.null()])).optional().describe('Component params by component name (merged; null value deletes a param, null component removes the override)'),
    },
    (a) => {
      let n = 0;
      const { scene } = mutateScene(a.scene, (s) => {
        const sel = (i: Scene['instances'][number]) => (a.ids ? a.ids.includes(i.id) : a.object ? i.object === a.object : false);
        if (a.remove) {
          const before = s.instances.length;
          s.instances = s.instances.filter((i) => !sel(i));
          n = before - s.instances.length;
          return;
        }
        for (const i of s.instances) {
          if (!sel(i)) continue;
          n++;
          if (a.x !== undefined) i.x = a.x;
          if (a.y !== undefined) i.y = a.y;
          i.x += a.dx ?? 0;
          i.y += a.dy ?? 0;
          if (a.flip_x !== undefined) {
            if (a.flip_x) i.flipX = true;
            else delete i.flipX;
          }
          for (const key of ['name', 'sprite', 'animation'] as const) {
            const v = a[key];
            if (v === undefined) continue;
            if (v === null || v === '') delete i[key];
            else i[key] = v;
          }
          for (const [k, v] of Object.entries(a.props ?? {})) {
            i.props ??= {};
            if (v === null) delete i.props[k];
            else i.props[k] = v as Value;
          }
          for (const [c, params] of Object.entries(a.components ?? {})) {
            i.components ??= {};
            if (params === null) delete i.components[c];
            else {
              const cur = (i.components[c] ??= {});
              for (const [k, v] of Object.entries(params)) {
                if (v === null) delete cur[k];
                else cur[k] = v as Value;
              }
            }
            if (!Object.keys(i.components).length) delete i.components;
          }
        }
      });
      if (!n) throw new Error('No instance matched (pass ids or object)');
      return text(`${a.remove ? 'Removed' : 'Updated'} ${n} instance(s). Scene has ${scene.instances.length}.`);
    },
  );

  // ------------------------------------------------------------------ seeing & testing

  tool('tileset_preview', 'Show a tileset sprite with the index of every tile, to know which numbers to use in paint_tiles.', { sprite: z.string(), scale: z.number().int().min(1).max(8).optional() }, (a) => {
    const s = ws.load(a.sprite);
    if (!s.grid) throw new Error(`Sprite "${a.sprite}" has no tile grid`);
    const { sheet } = buildAsset(s, false);
    const gw = s.grid.width;
    const gh = s.grid.height;
    const cols = Math.floor(s.width / gw);
    const rows = Math.floor(s.height / gh);
    const scale = a.scale ?? Math.max(2, Math.min(6, Math.floor(96 / gw)));
    const pad = 9;
    const big = scaleBitmap(sheet, scale);
    const rr = new BitmapRenderer(cols * (gw * scale + 2), rows * (gh * scale + pad + 2), new Map([['t', big]]));
    rr.clear('#1c1f26');
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        const ox = tx * (gw * scale + 2) + 1;
        const oy = ty * (gh * scale + pad + 2) + pad;
        rr.image('t', tx * gw * scale, ty * gh * scale, gw * scale, gh * scale, ox, oy, { flipX: false, opacity: 1 });
        rr.text(String(ty * cols + tx), ox, oy - 7, '#feae34', 1);
      }
    }
    return [...text(`Tileset "${a.sprite}": ${cols}x${rows} = ${cols * rows} tiles of ${gw}x${gh}px. Index = row * ${cols} + column.`), image(encodePng(rr.out))];
  }, { readOnlyHint: true });

  tool('preview_scene', 'Render a whole scene as laid out (tiles, instances at their start positions; the orange box is the starting camera view).', {
    scene: z.string(),
    grid: z.boolean().optional().describe('Overlay the tile grid'),
    region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional().describe('Pixel region to zoom into'),
    scale: z.number().int().min(1).max(8).optional(),
  }, (a) => {
    const loaded = loadGameBundle(ws);
    const { png, width, height } = renderScenePreview(loaded, a.scene, { grid: a.grid, region: a.region, scale: a.scale });
    return [...text(`Scene "${a.scene}" preview ${width}x${height}px.`), image(png)];
  }, { readOnlyHint: true });

  tool(
    'playtest',
    'Run the game headless for some seconds with scripted input and report what happened: logs (log/say actions, dialogs and choices, scene changes, runtime and script errors), final variables and instances, snapshots at sample times, and a screenshot of the last frame (plus one per sample time with screenshots: true). Keys: left, right, up, down, action (space/Z), action2 (X), letters...',
    {
      seconds: z.number().min(0.1).max(120),
      scene: z.string().optional().describe('Start in this scene (default: the start scene)'),
      inputs: z.array(z.object({ at: z.number().min(0), key: z.string().optional(), duration: z.number().min(0).optional().describe('Hold time in seconds (default 0.1 = tap)'), click: z.tuple([z.number(), z.number()]).optional() })).optional(),
      sample_at: z.array(z.number()).optional().describe('Times (s) to snapshot the state'),
      screenshots: z.boolean().optional().describe('Also screenshot every sample time'),
      scale: z.number().int().min(1).max(4).optional(),
      seed: z.number().int().optional(),
      choices: z.array(z.number().int().min(0)).optional().describe('Menu answers for choose() dialogs, in order (default: first entry)'),
      auto_dialog: z.boolean().optional().describe('Confirm dialogs automatically (default true); false = drive them with "action" key inputs'),
    },
    async (a) => {
      const loaded = loadGameBundle(ws);
      if (!Object.keys(loaded.bundle.scenes).length) throw new Error('No scenes yet');
      const shots: Buffer[] = [];
      const scale = a.scale ?? 2;
      const r = await runPlaytest(loaded.bundle, {
        evaluator: nodeEvaluator,
        choices: a.choices,
        autoDialog: a.auto_dialog,
        seconds: a.seconds,
        scene: a.scene,
        inputs: a.inputs as PlaytestInput[] | undefined,
        sampleAt: a.sample_at,
        seed: a.seed,
        onSample: a.screenshots ? (w) => shots.push(renderViewport(w, loaded.sheets, scale)) : undefined,
      });
      const fmtState = (s: (typeof r)['final']) =>
        [
          `t=${s.time}s scene=${s.scene} globals=${JSON.stringify(s.globals)}${Object.keys(s.sceneVars).length ? ` scene=${JSON.stringify(s.sceneVars)}` : ''}`,
          ...s.actors.filter((x) => x.object).slice(0, 60).map((x) => `  ${x.name ? `"${x.name}" ` : ''}${x.object}#${x.id} at ${x.x},${x.y} v=${x.vx},${x.vy}${x.onGround ? ' ground' : ''}${x.animation ? ` anim=${x.animation}` : ''}${Object.keys(x.vars).length ? ' ' + JSON.stringify(x.vars) : ''}`),
          s.actors.length > 60 ? `  ... ${s.actors.length - 60} more` : '',
        ].filter(Boolean).join('\n');
      const lines = [
        `Played ${r.seconds.toFixed(2)}s.`,
        loaded.problems.length ? `Validation problems: ${loaded.problems.map((p) => `${p.where}: ${p.message}`).join('; ')}` : '',
        `Logs (${r.logs.length}):`,
        ...r.logs.slice(-80).map((l) => '  ' + l),
        ...r.samples.map((s) => `Sample:\n${fmtState(s)}`),
        `Final:\n${fmtState(r.final)}`,
      ].filter(Boolean);
      return [...text(lines.join('\n')), ...shots.map(image), image(renderViewport(r.world, loaded.sheets, scale))];
    },
    { readOnlyHint: true },
  );

  // ------------------------------------------------------------------ scripts

  const scriptSummary = () => {
    const info = inspectScripts(ws.loadScripts());
    refreshScriptTypes(ws, info);
    const comps = info.components.map((c) => `- ${c.name}${c.path ? ` (scripts/${c.path}.js)` : ' (legacy behavior())'}: params ${c.params.map((p) => `${p.name}:${p.type}=${JSON.stringify(p.default)}${p.options ? `[${p.options.join('|')}]` : ''}`).join(', ') || 'none'}; hooks ${c.hooks.join(', ') || 'none'}${c.methods.length ? `; methods ${c.methods.join(', ')}` : ''}${c.warnings.length ? `\n    WARN ${c.warnings.join('; ')}` : ''}`);
    return `Components:\n${comps.join('\n') || '- none'}\nScript functions (func): ${info.functions.join(', ') || 'none'}${info.errors.length ? `\nERRORS:\n${info.errors.map((e) => '- ' + e).join('\n')}` : ''}`;
  };

  tool('script_reference', 'Reference of the game scripting API (JavaScript): components (one Behaviour class per file, Unity-style lifecycle, inspector params, getComponent), modules/imports, instance handles, async dialogs/menus/waits/movement, UI drawing, with an example. Read it before writing scripts.', {}, () => text(SCRIPT_REFERENCE), { readOnlyHint: true });

  tool('list_scripts', 'List the project scripts (scripts/<folder>/<name>.js), the components they define (params, hooks, methods) and loading errors.', {}, () => {
    const list = ws.listScripts();
    const folders = ws.listScriptFolders();
    return text(`${list.length ? list.map((s) => `${s.name}.js (${s.size} bytes)`).join('\n') : 'No scripts yet. Create one with write_script.'}${folders.length ? `\nFolders: ${folders.join(', ')}` : ''}\n\n${scriptSummary()}`);
  }, { readOnlyHint: true });

  tool('read_script', 'Read a script with line numbers.', { name: z.string().describe('Path without .js, e.g. "enemies/Patrol"') }, (a) => {
    const code = ws.readScript(a.name);
    return text(code.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n'));
  }, { readOnlyHint: true });

  const saveScript = (name: string, code: string) => {
    const err = checkScriptSyntax(code, `scripts/${name}.js`);
    if (err) throw new Error(`Syntax error, not saved: ${err}`);
    ws.writeScript(name, code);
    return text(`Saved scripts/${name}.js (${code.split('\n').length} lines).\n${scriptSummary()}\n\n${problemsText()}`);
  };

  tool(
    'write_script',
    'Create or replace a game script (see script_reference). Components: one class per file named like the file, e.g. name "enemies/Patrol" with `export default class Patrol extends Behaviour { speed = 40; update(dt) {...} }`. Plain scripts export helpers/data. Organize with folders (enemies/, player/, ui/, managers/, utils/). Syntax-checked before saving; the result lists every component with its params and any loading errors. Then attach components (set_object behaviors { type: "script", name }, update_scene / set_game components) and verify with playtest.',
    { name: z.string().describe('Path in scripts/ without .js, e.g. "enemies/Patrol", "ui/Hud", "utils/math"'), code: z.string() },
    (a) => saveScript(a.name, a.code),
  );

  tool(
    'edit_script',
    'Replace one exact snippet in a script (must match exactly once). Prefer this to write_script for small changes.',
    { name: z.string(), find: z.string(), replace: z.string() },
    (a) => {
      const code = ws.readScript(a.name);
      const n = code.split(a.find).length - 1;
      if (n !== 1) throw new Error(n ? `The snippet appears ${n} times; include more context` : 'Snippet not found (read_script shows the current code)');
      return saveScript(a.name, code.replace(a.find, () => a.replace));
    },
  );

  tool('component_library', 'Ready-made components you can add to the project instead of writing them: Health, Damage, Shooter, Collectible, Door, Checkpoint, Respawn, Spawner, Countdown (what each does, how to use it). Prefer them for common mechanics.', {}, () =>
    text(LIBRARY.map((c) => `- ${c.name} (scripts/${c.folder}/${c.name}.js)${c.requires ? ` [needs ${c.requires.join(', ')}]` : ''}: ${c.summary}\n    ${c.usage}`).join('\n')), { readOnlyHint: true });

  tool(
    'add_library_component',
    'Copy ready-made components (see component_library) into scripts/ — plus the ones they need — then attach them like any component (set_object behaviors { type: "script", name: "Health", max: 5 }). The files are normal scripts you can read and edit.',
    { names: z.array(z.string()).min(1).describe('e.g. ["Health", "Damage", "Collectible"]') },
    (a) => {
      const r = addLibraryComponents(ws, a.names);
      return text(`${r.created.length ? `Created ${r.created.map((p) => `scripts/${p}.js`).join(', ')}.` : 'Nothing new to create.'}${r.existing.length ? ` Already in the project: ${r.existing.join(', ')}.` : ''}\n${scriptSummary()}`);
    },
  );

  tool('move_script', 'Move or rename a script or a whole folder (e.g. "Patrol" → "enemies/Patrol", "enemies" → "monsters"). When a component file is renamed, its class name and every reference (objects, instances, scene/game components, events) follow.', { from: z.string(), to: z.string() }, (a) => {
    const isFile = ws.scriptExists(a.from);
    const before = isFile ? [a.from] : ws.listScripts().map((s) => s.name).filter((n) => n.startsWith(a.from + '/'));
    remember('game', 'game');
    for (const sc of ws.listScenes()) remember('scene', sc.name);
    ws.moveScript(a.from, a.to);
    for (const old of before) {
      const now = isFile ? a.to : a.to + old.slice(a.from.length);
      const x = scriptBaseName(old);
      const y = scriptBaseName(now);
      if (x === y) continue;
      const code = ws.readScript(now);
      const renamed = code.replace(new RegExp(`(export\\s+default\\s+class\\s+)${x}\\b`), `$1${y}`);
      if (renamed !== code) ws.writeScript(now, renamed);
      const game = ws.loadGame();
      const scenes = ws.listScenes().map((sc) => ws.loadScene(sc.name));
      const changed = renameComponentRefs(game, scenes, x, y);
      if (changed.game) ws.saveGame(game, AUTHOR);
      for (const sc of changed.scenes) ws.saveScene(sc, AUTHOR);
    }
    return text(`Moved ${a.from} → ${a.to}.\n${scriptSummary()}`);
  }, { destructiveHint: true });

  tool('delete_script', 'Delete a script file (or a folder with everything in it, with folder: true).', { name: z.string(), folder: z.boolean().optional() }, (a) => {
    if (a.folder) ws.removeScriptFolder(a.name);
    else ws.removeScript(a.name);
    return text(`Deleted scripts/${a.name}${a.folder ? '/' : '.js'}.\n${scriptSummary()}`);
  }, { destructiveHint: true });


  // ------------------------------------------------------------------ dialogues

  const dialogueSummary = () => {
    const book = buildDialogueBook(ws.loadDialogues());
    return `Dialogues: ${[...book.nodes.keys()].sort().join(', ') || 'none'}${book.errors.length ? `\nERRORS:\n${book.errors.map((e) => `- ${e.file}.dialogue line ${e.line}: ${e.message}`).join('\n')}` : ''}`;
  };

  tool('dialogue_reference', 'Reference of the dialogue language: plain-text conversations with speakers, choices, conditions, variables, commands and jumps, and how NPCs use them (one NPC object type, many characters). Read it before writing dialogues.', {}, () => text(DIALOGUE_REFERENCE), { readOnlyHint: true });

  tool('list_dialogues', 'List dialogue files (dialogues/<file>.dialogue) and the dialogue names they define.', {}, () => {
    const list = ws.listDialogues();
    return text(`${list.length ? list.map((d) => `${d.name}.dialogue (${d.size} bytes)`).join('\n') : 'No dialogue files yet. Create one with write_dialogue.'}\n\n${dialogueSummary()}`);
  }, { readOnlyHint: true });

  tool('read_dialogue', 'Read a dialogue file with line numbers.', { file: z.string() }, (a) => {
    const code = ws.readDialogue(a.file);
    return text(code.split('\n').map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n'));
  }, { readOnlyHint: true });

  const saveDialogue = (file: string, code: string) => {
    const r = parseDialogues(code, file);
    if (r.errors.length) throw new Error(`Not saved, fix these first:\n${r.errors.map((e) => `- line ${e.line}: ${e.message}`).join('\n')}`);
    ws.writeDialogue(file, code);
    return text(`Saved dialogues/${file}.dialogue (${r.nodes.length} dialogue(s): ${r.nodes.map((n) => n.name).join(', ')}).\n${dialogueSummary()}\n\n${problemsText()}`);
  };

  tool(
    'write_dialogue',
    'Create or replace a dialogue file (see dialogue_reference). It is checked before saving. Then make NPCs talk: an object type with the behavior { type: "dialogue" } and, per placed instance, props { dialogue: "<name>" } plus a name (place_instances / update_instances). Or start one from an event (action "dialogue").',
    { file: z.string().describe('File name without extension, e.g. "village", "quests"'), code: z.string() },
    (a) => saveDialogue(a.file, a.code),
  );

  tool('edit_dialogue', 'Replace one exact snippet in a dialogue file (must match exactly once).', { file: z.string(), find: z.string(), replace: z.string() }, (a) => {
    const code = ws.readDialogue(a.file);
    const n = code.split(a.find).length - 1;
    if (n !== 1) throw new Error(n ? `The snippet appears ${n} times; include more context` : 'Snippet not found (read_dialogue shows the current text)');
    return saveDialogue(a.file, code.replace(a.find, () => a.replace));
  });

  tool('delete_dialogue', 'Delete a dialogue file.', { file: z.string() }, (a) => {
    ws.removeDialogue(a.file);
    return text(`Deleted dialogues/${a.file}.dialogue.\n${dialogueSummary()}`);
  }, { destructiveHint: true });

  tool('validate_game', 'Check the game for problems: unknown triggers/actions/behaviors, bad expressions, missing sprites, objects and scenes.', {}, () => text(problemsText()), { readOnlyHint: true });

  tool('export_game', 'Export the game as a single self-contained index.html (plays offline, on any static host, or uploaded to itch.io as an HTML5 game). Default folder: <workspace>/export/web/<title>/.', { out_dir: z.string().optional() }, (a) => {
    const r = exportGame(ws, { outDir: a.out_dir });
    return text(`Exported ${r.file} (${(r.bytes / 1024).toFixed(1)} KB, ${r.scenes} scene(s), ${r.sprites} sprite(s)).${r.problems.length ? `\nProblems:\n${r.problems.map((p) => `- ${p.where}: ${p.message}`).join('\n')}` : ''}`);
  });

  tool('undo_game_change', 'Undo your most recent game or scene changes made through this MCP server (settings, objects, events, tiles, instances).', { steps: z.number().int().min(1).optional() }, (a) => {
    const steps = Math.min(a.steps ?? 1, history.length);
    if (!steps) throw new Error('Nothing to undo');
    const done: string[] = [];
    for (let i = 0; i < steps; i++) {
      const h = history.pop()!;
      if (h.kind === 'game') {
        if (h.json) ws.saveGame(normalizeGame(JSON.parse(h.json)), AUTHOR);
        done.push('game');
      } else {
        if (h.json) ws.saveScene(normalizeScene(JSON.parse(h.json)), AUTHOR);
        else if (ws.sceneExists(h.name)) ws.removeScene(h.name);
        done.push(`scene ${h.name}`);
      }
    }
    return text(`Undid ${steps} change(s): ${done.join(', ')}. ${history.length} more available.`);
  });

  return {
    /** Forget undo history (after switching projects). */
    reset: () => {
      history.length = 0;
    },
  };
}
