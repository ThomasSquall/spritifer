/** MCP tools for building games: project settings, object types, scenes, tiles, instances, events, playtests, export. */

import fs from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BEHAVIOR_MAP, SOUNDS, catalogReference, describeEvent, describeStep } from '../core/game/catalog.js';
import { checkExpr } from '../core/game/expr.js';
import { type PlaytestInput, runPlaytest } from '../core/game/engine.js';
import { renameComponentRefs, renameObjectRefs, renameSceneRefs } from '../core/game/refactor.js';
import {
  type DataRow,
  type DataTable,
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
  normalizeTags,
  normalizeActions,
  normalizeAtmosphere,
  normalizeLight,
  MOTE_PRESETS,
  normalizeObject,
  normalizeScene,
  normalizeTable,
  resizeScene,
} from '../core/game/types.js';
import { BitmapRenderer, buildAsset, exportGame, loadGameBundle, renderScenePreview, renderVfxStrip, renderViewport } from './game.js';
import { type VfxEdge, type VfxGraph, VFX_NAME_RE, VFX_REFERENCE, VFX_TEMPLATES, VFX_TEMPLATE_IDS, VFX_NODE_TYPES, checkVfx, normalizeVfx, vfxEdgePort, vfxHasCycle, vfxInputErrors } from '../core/game/vfxGraph.js';
import { encodePng } from './png.js';
import { scaleBitmap } from '../core/draw.js';
import type { Workspace } from './store.js';
import { addLibraryComponents, checkScriptSyntax, inspectScripts, nodeEvaluator, refreshScriptTypes } from './scripts.js';
import { LIBRARY } from '../core/game/library.js';
import { scriptBaseName } from '../core/game/modules.js';
import { describeTilesetRules, normalizeTilesetRules } from '../core/game/tilerules.js';
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
- Scripts (write_script, script_reference) are JavaScript files in scripts/ (use folders: scripts/enemies/Patrol.js, scripts/ui/Hud.js, scripts/managers/GameManager.js) for logic events can't express well. Write COMPONENTS, Unity-style: ONE class per file named like the file (export default class Patrol extends Behaviour), public fields = inspector params, lifecycle awake/start/update/lateUpdate/onCollisionEnter/Stay/Exit/onInteract/onDraw/onDestroy, this.getComponent('Health') / findComponent('GameManager') to talk to other scripts, import for shared helpers. Attach them to object types ({ type: "script", name: "Patrol", speed: 60 } in behaviors), override params per placed instance (instances components: { Patrol: { speed: 80 } }), or attach managers to scenes (update_scene components) and to the whole game (set_game components). Never put several behaviours in one file. For common mechanics first check component_library (Health, Damage, Shooter, Collectible, Door, Checkpoint, Respawn, Roam, ChasePath, Spawner, Countdown) and add them with add_library_component.
- RPGs: top-down player (topdown + camera, sprite tags walk_<dir>/idle_<dir>), scene y_sort and persistent (towns remember chests/positions after battles), solid tile layers for walls, NPCs and chests via dialogues (~ self.opened = true), an intro via a scene event (start → dialogue), battles in a scene driven by a scene component (class Battle extends Behaviour { async start() {...} } attached to the battle scene).
- Juice and polish: particles(x, y, "dust"|"sparks"|"explosion"...) or the event action Particles (and the ParticleEmitter component), animation events on frames (set_frame_events: "hit" on the swing frame → onAnimationEvent / trigger "Animation event"), music per scene (import_audio, update_scene music, music("name")), camera zoom/dead zone/look ahead, tweens, fades.
- Menus and HUD: inside onDraw use ui.menu / ui.button / ui.window (keyboard, gamepad and mouse ready) and pause(true) for pause menus and inventories. Input actions (set_game actions: { attack: ["x", "pad:b"] }) give controls names usable everywhere like keys.
- Visual effects (vfx_reference, write_vfx, update_vfx, preview_vfx): attacks, spells and hits as small flow graphs of slashes, shockwaves, beams, projectiles, particles, flashes, shake and hit stop. Played with await vfx("fireball", self, enemy), the event action "Play effect", or a frame event "vfx:slash". Put a Message node where the attack connects and apply damage there. Check them with preview_vfx.
- Data tables (write_data / update_data / read_data / list_data): the game's database in data/<table>.json — items, weapons with tiers and prices, classes, skills, enemy stats, shop stock, quest rewards. Scripts read db.weapons, db.get('weapons', 'bronze'), db.where('weapons', { tier: 2 }); events, dialogues and activeIf read db("weapons", "bronze", "price"). Prefer tables over constants in scripts for anything a designer would tweak.
- Things that appear as the game progresses (a town that grows: new buildings, residents, upgraded shops, opened bridges): place them once with active_if (an expression such as "inn_lv >= 1" or "quest_bram == 2"); the engine shows them only while it is true, checking continuously. fn("name", args) in expressions calls a func() from a plain script (synchronous), for conditions too complex for an expression.
- Projects: list_projects / open_project / create_project switch between games; each project folder has its own sprites, scenes, scripts and game.json.

Workflow that works:
1. Draw the art first with the sprite tools: a tileset sprite with tile_width/tile_height (index = position in the grid, row-major), characters with tags idle/run/jump/fall (platformer) or idle_<dir>/walk_<dir> (topdown, as rig_animate makes them), items, enemies. tileset_preview shows each tile's index.
2. set_game (resolution, e.g. 320x180; gravity) and set_object for each kind of thing. The player gets platformer or topdown + camera.
3. create_scene, paint_tiles (rows + legend like draw_pixels, chars → tile indices; set solid on collision layers with set_tile_layer), place_instances.
4. Events: collisions (collect coins: add score, destroy other, sound coin), hazards (restartScene), goals (gotoScene), HUD text objects.
5. ALWAYS verify: validate_game, preview_scene, then playtest with scripted inputs (vars: {...} starts at a later stage, player_at: [x, y] puts the player next to what you test) (e.g. hold right 2s, tap up) and read the final state, logs and screenshot. Fix and re-test until it plays as intended.
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
    if (o.extends) lines.push(`  variant of ${o.extends} (only the differences are listed)`);
    if (o.tags?.length) lines.push(`  tags: ${o.tags.join(', ')}`);
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

  const checkedExpr = (src: string) => {
    const err = checkExpr(src.trim());
    if (err) throw new Error(`active_if: ${err}`);
    return src.trim();
  };

  const lightSchema = z.object({
  radius: z.number().min(0).describe('Reach in px (0 = off). Torch ~40, campfire ~64, lamp ~48, crystal ~56, firefly ~10'),
  color: z.string().optional().describe('e.g. "#ffb070" fire, "#ffe6a0" lamp, "#80e8ff" crystal, "#c080ff" magic'),
  intensity: z.number().min(0).max(4).optional().describe('Default 1'),
  flicker: z.number().min(0).max(1).optional().describe('Fire ~0.2, none for crystals'),
  pulse: z.number().min(0).max(1).optional().describe('Slow breathing (magic, crystals) ~0.3'),
  x: z.number().optional().describe('Offset from the sprite center'),
  y: z.number().optional(),
});
const atmosphereSchema = z.object({
  ambient: z.string().optional().describe('Multiplied over the world. "#ffffff" plain day, "#fff0dc" warm day, "#c8d0ff" overcast, "#8a7ab8" dusk, "#3a3c70" night, "#2a2440" dark cave. Lights cut through it.'),
  glow: z.number().min(0).max(2).optional().describe('Bloom added by lights (default 0.6)'),
  shadows: z.boolean().optional().describe('Soft contact shadows under instances (default true): width = object hitbox width, or the object type "shadow"'),
  shadow_color: z.string().optional(),
  shadow_opacity: z.number().min(0).max(1).optional().describe('Default 0.38'),
  vignette: z.number().min(0).max(1).optional().describe('Darken screen edges, ~0.3'),
  vignette_color: z.string().optional(),
  clouds: z.object({ sprite: z.string(), opacity: z.number().min(0).max(1).optional(), speed_x: z.number().optional(), speed_y: z.number().optional() }).nullable().optional().describe('Drifting cloud shadows: a tileable sprite of dark soft blobs on transparent'),
  tint: z.string().optional().describe('Soft-light color grade, e.g. "#ffb070" golden hour, "#5080ff" cold'),
  tint_amount: z.number().min(0).max(1).optional(),
  motes: z.object({ preset: z.enum(MOTE_PRESETS), count: z.number().int().min(0).max(400).optional(), color: z.union([z.string(), z.array(z.string())]).optional() }).nullable().optional().describe('Ambient floating particles'),
});
const toAtmosphere = (a: z.infer<typeof atmosphereSchema>) =>
  normalizeAtmosphere({ ambient: a.ambient, glow: a.glow, shadows: a.shadows, shadowColor: a.shadow_color, shadowOpacity: a.shadow_opacity, vignette: a.vignette, vignetteColor: a.vignette_color, clouds: a.clouds ? { sprite: a.clouds.sprite, opacity: a.clouds.opacity, speedX: a.clouds.speed_x, speedY: a.clouds.speed_y } : undefined, tint: a.tint, tintAmount: a.tint_amount, motes: a.motes ?? undefined });

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
      `Tileset rules: ${Object.entries(g.tilesets ?? {}).map(([n, r]) => `${n} (${describeTilesetRules(r)})`).join('; ') || 'none'}`,
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
      actions: z.record(z.string(), z.union([z.array(z.string()), z.null()])).optional().describe('Input actions: name → keys/gamepad buttons, merged (null deletes): { jump: ["space", "w", "pad:a"], attack: ["x", "pad:b"] }. Events and scripts use the name like a key; a name like "action" or "up" remaps that built-in key. Keys: a-z, 0-9, space, enter, escape, shift, arrowleft/right/up/down, left/right/up/down, action, action2, pad:a/b/x/y/lb/rb/lt/rt/start/select/up/down/left/right.'),
    },
    (a) => {
      const { game } = mutateGame((g) => {
        if (a.components) {
          const list = normalizeComponents(a.components.map((b) => ({ ...b, type: 'script' })));
          if (list) g.components = list;
          else delete g.components;
        }
        if (a.actions) {
          const merged: Record<string, unknown> = { ...(g.actions ?? {}) };
          for (const [k, v] of Object.entries(a.actions)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          const n = normalizeActions(merged);
          if (n) g.actions = n;
          else delete g.actions;
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

  const tileRuleSchema = z.object({
    tile: z.number().int().min(0).describe('The painted tile index'),
    kind: z.enum(['grid', 'random', 'blob']).describe('grid = big seamless texture cut into size×size pieces by position; random = one of count alternatives by position; blob = 47-shape autotile from the 8 neighbours (size×size pieces per shape)'),
    first: z.number().int().min(0).describe("First tile of the rule's block in the tileset"),
    size: z.number().int().min(1).max(16).optional().describe('grid / blob: pieces per side (default 1)'),
    count: z.number().int().min(1).optional().describe('random: number of alternatives'),
    group: z.array(z.number().int().min(0)).optional().describe('blob: painted tiles counted as the same terrain (default just tile)'),
    border: z.boolean().optional().describe('blob: outside the map counts as the same terrain (default true)'),
    frames: z.number().int().min(1).max(64).optional().describe('Animated: this many copies of the block follow each other (water, lava)'),
    fps: z.number().min(0.1).max(60).optional().describe('Animation speed (default 4)'),
  });
  const edgeRuleSchema = z.object({
    on: z.array(z.number().int().min(0)).min(1).describe('Cells painted with these tiles get the overlay…'),
    from: z.array(z.number().int().min(0)).min(1).describe('…on the sides where a neighbour is one of these'),
    first: z.number().int().min(0).describe('First tile of the 47-shape overlay block'),
    empty: z.boolean().optional().describe('Empty cells of the layer count as "from" too'),
    size: z.number().int().min(1).max(16).optional(),
    frames: z.number().int().min(1).max(64).optional(),
    fps: z.number().min(0.1).max(60).optional(),
  });

  tool(
    'set_tileset_rules',
    'Tile rules of a tileset (game.json tilesets): autotiling (blob), big seamless textures (grid), random variants, animated tiles and edge overlays (grass creeping onto paths, foam on shores). Scenes keep storing only the painted tile; the game and the scene editor draw the generated pieces. rules / edges replace their whole list when given (null clears); paintable = how many tiles (from 0) the editor palette shows. clear removes all rules of the tileset.',
    {
      tileset: z.string().describe('Tileset sprite (has a tile grid)'),
      rules: z.array(tileRuleSchema).nullable().optional(),
      edges: z.array(edgeRuleSchema).nullable().optional(),
      paintable: z.number().int().min(1).nullable().optional(),
      clear: z.boolean().optional(),
    },
    (a) => {
      if (!ws.exists(a.tileset)) throw new Error(`No sprite "${a.tileset}"`);
      const { game } = mutateGame((g) => {
        const cur: Record<string, unknown> = a.clear ? {} : { ...(g.tilesets?.[a.tileset] ?? {}) };
        if (a.rules !== undefined) cur.rules = a.rules ?? undefined;
        if (a.edges !== undefined) cur.edges = a.edges ?? undefined;
        if (a.paintable !== undefined) cur.paintable = a.paintable ?? undefined;
        const n = normalizeTilesetRules(cur);
        const all = { ...(g.tilesets ?? {}) };
        if (n) all[a.tileset] = n;
        else delete all[a.tileset];
        if (Object.keys(all).length) g.tilesets = all;
        else delete g.tilesets;
      });
      const r = game.tilesets?.[a.tileset];
      return text(`Saved. ${a.tileset}: ${r ? describeTilesetRules(r) : 'no rules'}`);
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
      light: lightSchema.nullable().optional().describe('Light it gives off (seen in scenes with an atmosphere: darker ambient + glow). null removes'),
      shadow: z.number().min(0).nullable().optional().describe('Contact shadow width in px (0 = none, null = automatic: hitbox width). Flat things (rugs, doormats, flowerbeds) want 0'),
      extends: z.string().nullable().optional().describe('Make it a VARIANT of another object type (like a Unity prefab variant): it inherits sprite, hitbox, properties, tags, components (params can be overridden by listing the same component with only the changed params) and events, and stores only what differs. null = standalone again. Queries and events on the parent type (find("slime"), "collides with slime", count) include its variants.'),
      tags: z.array(z.string()).optional().describe('Group tags for scripts (self.hasTag, findWithTag, raycast/overlap filters, countTag()), e.g. ["enemy"]. Replaces the list.'),
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
        if (a.tags !== undefined) {
          const t = normalizeTags(a.tags);
          if (t) o.tags = t;
          else delete o.tags;
        }
        if (a.extends !== undefined) {
          if (a.extends === null || a.extends === '') delete o.extends;
          else {
            if (!g.objects.some((x) => x.name === a.extends)) throw new Error(`No object type "${a.extends}" to base the variant on`);
            if (a.extends === o.name) throw new Error('An object type cannot extend itself');
            o.extends = a.extends;
          }
        }
        if (a.hud !== undefined) {
          if (a.hud) o.hud = true;
          else delete o.hud;
        }
        if (a.light !== undefined) {
          const l = a.light === null ? undefined : normalizeLight(a.light);
          if (l) o.light = l;
          else delete o.light;
        }
        if (a.shadow !== undefined) {
          if (a.shadow === null) delete o.shadow;
          else o.shadow = Math.round(a.shadow);
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
    for (const i of s.instances) lines.push(`- ${i.id}: ${i.name ? `"${i.name}" (${i.object})` : i.object}${i.sprite ? ` sprite ${i.sprite}` : ''} at ${i.x},${i.y} (tile ${Math.floor(i.x / s.tileSize)},${Math.floor(i.y / s.tileSize)})${i.flipX ? ' flipped' : ''}${i.props ? ' ' + JSON.stringify(i.props) : ''}${i.components ? ' components ' + JSON.stringify(i.components) : ''}${i.activeIf ? ` active if (${i.activeIf})` : ''}`);
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
    'Change scene properties: size (keeps the top-left content), tileset, background color, parallax background sprites, scene variables, y-sort, name, atmosphere (lighting, contact shadows, cloud shadows, color grade, vignette, ambient particles).',
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
      music: z.string().nullable().optional().describe('Music when the scene starts: an audio file name (list_audio), "-" for silence, null = keep what plays'),
      atmosphere: atmosphereSchema.nullable().optional().describe('Lighting and mood (replaces the whole atmosphere; null removes it). Lights come from object types / instances with "light".'),
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
        if (a.atmosphere !== undefined) {
          const atm = a.atmosphere === null ? undefined : toAtmosphere(a.atmosphere);
          if (atm?.clouds && !ws.exists(atm.clouds.sprite)) throw new Error(`Clouds sprite "${atm.clouds.sprite}" not found`);
          if (atm) s.atmosphere = atm;
          else delete s.atmosphere;
        }
        if (a.music !== undefined) {
          if (a.music === null || a.music === '') delete s.music;
          else {
            if (a.music !== '-' && !ws.listAudio().some((x) => x.name === a.music)) throw new Error(`No audio "${a.music}". Import it with import_audio.`);
            s.music = a.music;
          }
        }
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
        tags: z.array(z.string()).optional().describe('Extra group tags for this instance (e.g. ["boss"])'),
        active_if: z.string().optional().describe('Expression: the instance exists only while true (checked at scene start and continuously), e.g. "armory_lv >= 2" or "res_mage". For things that appear as the game progresses: new buildings, residents, upgrades.'),
        light: lightSchema.optional().describe('Light of this instance (overrides the type\'s; radius 0 = off)'),
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
          s.instances.push({ id, object: i.object, x, y, ...(i.name ? { name: i.name } : {}), ...(i.sprite ? { sprite: i.sprite } : {}), ...(i.animation ? { animation: i.animation } : {}), ...(i.props ? { props: i.props } : {}), ...(i.components ? { components: i.components as Record<string, Record<string, Value>> } : {}), ...(i.flip_x ? { flipX: true } : {}), ...(normalizeTags(i.tags) ? { tags: normalizeTags(i.tags) } : {}), ...(i.active_if?.trim() ? { activeIf: checkedExpr(i.active_if) } : {}), ...(i.light ? { light: normalizeLight(i.light, true) } : {}) });
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
      tags: z.array(z.string()).nullable().optional().describe('Extra tags of the instances (replace; null clears)'),
      name: z.string().nullable().optional().describe('Rename (null clears)'),
      sprite: z.string().nullable().optional().describe('Sprite override (null = the object type\'s)'),
      animation: z.string().nullable().optional(),
      active_if: z.string().nullable().optional().describe('Expression: the instance exists only while true (null or "" = always)'),
      light: lightSchema.nullable().optional().describe('Light override (radius 0 = off, null = the object type\'s)'),
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
          if (a.tags !== undefined) {
            const t = normalizeTags(a.tags);
            if (t) i.tags = t;
            else delete i.tags;
          }
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
          if (a.active_if !== undefined) {
            if (a.active_if === null || !a.active_if.trim()) delete i.activeIf;
            else i.activeIf = checkedExpr(a.active_if);
          }
          if (a.light !== undefined) {
            const l = a.light === null ? undefined : normalizeLight(a.light, true);
            if (l) i.light = l;
            else delete i.light;
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

  tool('preview_scene', 'Render a whole scene as laid out (tiles, instances at their start positions; the orange box is the starting camera view). Conditional instances follow the initial variables, or vars.', {
    scene: z.string(),
    grid: z.boolean().optional().describe('Overlay the tile grid'),
    region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) }).optional().describe('Pixel region to zoom into'),
    scale: z.number().int().min(1).max(8).optional(),
    vars: z.record(z.string(), valueSchema).optional().describe('Global variables for this preview: conditional instances (active_if) show as they would with these values, e.g. { inn_lv: 2, town_rank: 10 } to see the grown town'),
  }, (a) => {
    const loaded = loadGameBundle(ws);
    const { png, width, height, hidden } = renderScenePreview(loaded, a.scene, { grid: a.grid, region: a.region, scale: a.scale, vars: a.vars as Record<string, Value> | undefined });
    return [...text(`Scene "${a.scene}" preview ${width}x${height}px.${hidden.length ? `\nHidden (active_if false${a.vars ? ' with these vars' : ' with the initial variables'}): ${hidden.join(', ')}` : ''}`), image(png)];
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
      vars: z.record(z.string(), valueSchema).optional().describe('Start with these global variables (test a later stage of the game without playing up to it: { gold: 500, armory_lv: 2 })'),
      player_at: z.tuple([z.number(), z.number()]).optional().describe('Put the player at this position (px) when the first scene starts'),
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
        vars: a.vars as Record<string, Value> | undefined,
        playerAt: a.player_at,
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

  tool('list_audio', 'List the audio files of the project (audio/: music and sound effects). Use them with sound("name"), music("name"), update_scene music, and the events Play sound / Play music.', {}, () => {
    const list = ws.listAudio();
    return text(list.length ? list.map((x) => `${x.name} (${x.file}, ${Math.round(x.size / 1024)} KB)`).join('\n') : 'No audio files yet. Import mp3/ogg/wav/m4a files with import_audio (the built-in retro sounds always work: ' + SOUNDS.join(', ') + ').');
  }, { readOnlyHint: true });

  tool('import_audio', 'Copy an audio file (mp3, ogg, wav, m4a) from the computer into the project (audio/<name>.<ext>), e.g. music the user gives you. Then play it with music("name") / sound("name") or set it as scene music.', {
    path: z.string().describe('Absolute path of the file on this computer'),
    name: z.string().optional().describe('Name in the game (default: the file name)'),
  }, (a) => {
    const m = /([^/\\]+)\.(mp3|ogg|wav|m4a)$/i.exec(a.path);
    if (!m) throw new Error('Use an mp3, ogg, wav or m4a file');
    if (!fs.existsSync(a.path)) throw new Error(`File not found: ${a.path}`);
    const name = a.name ?? m[1].replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 64);
    ws.writeAudio(name, m[2], fs.readFileSync(a.path));
    return text(`Imported audio/${name}.${m[2].toLowerCase()}. Use music("${name}") or sound("${name}").`);
  });

  tool('delete_audio', 'Delete an audio file of the project.', { name: z.string() }, (a) => {
    ws.removeAudio(a.name);
    return text(`Deleted audio "${a.name}".`);
  }, { destructiveHint: true });

  tool('component_library', 'Ready-made components you can add to the project instead of writing them: Health, Damage, Shooter, Collectible, Door, Checkpoint, Respawn, Roam, ChasePath, Spawner, Countdown (what each does, how to use it). Prefer them for common mechanics.', {}, () =>
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

  // ------------------------------------------------------------------ data tables

  const columnSchema = z.object({
    name: z.string(),
    type: z.enum(['text', 'number', 'bool', 'list', 'ref']).optional().describe('list = array of texts; ref = id of a row in another table (set table)'),
    table: z.string().optional().describe('ref columns: the table the ids belong to'),
    help: z.string().optional(),
  });
  const cellSchema = z.union([z.number(), z.string(), z.boolean(), z.array(z.string()), z.null()]);

  const tableText = (t: DataTable, limit = 200) => {
    const cols = t.columns.map((c) => `${c.name}:${c.type}${c.table ? `→${c.table}` : ''}`).join(', ');
    const rows = t.rows.slice(0, limit).map((r) => '  ' + JSON.stringify(r));
    return [`Table "${t.name}" (${t.rows.length} rows)${t.description ? ` — ${t.description}` : ''}`, `Columns: ${cols}`, ...rows, t.rows.length > limit ? `  ... ${t.rows.length - limit} more` : ''].filter(Boolean).join('\n');
  };

  tool('list_data', 'List the data tables (data/<name>.json): the game\'s database of items, weapons, classes, skills, enemies, quests, shop stock... Scripts read them with db.<table> / db.get(table, id) / db.where(table, {...}); expressions and dialogues with db("table", id, "column").', {}, () => {
    const list = ws.listTables();
    return text(list.length ? list.map((t) => `- ${t.name}: ${t.rows} rows, columns ${t.columns.join(', ')}${t.description ? ` — ${t.description}` : ''}`).join('\n') : 'No data tables yet. Create one with write_data.');
  }, { readOnlyHint: true });

  tool('read_data', 'Read a data table: columns with types and every row as JSON.', { table: z.string(), limit: z.number().int().min(1).max(2000).optional() }, (a) => text(tableText(ws.loadTable(a.table), a.limit)), { readOnlyHint: true });

  tool(
    'write_data',
    'Create or replace a data table (data/<name>.json). Rows are objects with a unique text "id" (e.g. "bronze_sword") plus the columns. Column types: text, number, bool, list (array of texts, e.g. ["power", "twin"]), ref (id of a row in another table). Columns are inferred from the rows when omitted. Use tables for game data that designers tweak (prices, stats, tiers, unlock levels, rewards) instead of hard-coding it in scripts.',
    {
      table: z.string().describe('Identifier, e.g. "weapons", "classes"'),
      description: z.string().optional(),
      columns: z.array(columnSchema).optional(),
      rows: z.array(z.record(z.string(), cellSchema)),
    },
    (a) => {
      assertIdentifier('data table', a.table);
      const t = ws.saveTable(normalizeTable({ name: a.table, description: a.description, columns: a.columns, rows: a.rows }, a.table), AUTHOR);
      return text(`Saved data/${t.name}.json.\n${tableText(t, 20)}\n\n${problemsText()}`);
    },
  );

  tool(
    'update_data',
    'Change part of a data table: upsert rows by id (only the given columns change; null clears a cell), delete rows, add or remove columns, set the description.',
    {
      table: z.string(),
      upsert: z.array(z.record(z.string(), cellSchema)).optional().describe('Rows with an "id": existing ids are merged, new ids appended'),
      delete_ids: z.array(z.string()).optional(),
      add_columns: z.array(columnSchema).optional(),
      remove_columns: z.array(z.string()).optional(),
      description: z.string().optional(),
    },
    (a) => {
      const t = ws.loadTable(a.table);
      if (a.description !== undefined) t.description = a.description;
      for (const c of a.add_columns ?? []) {
        if (t.columns.some((x) => x.name === c.name)) t.columns = t.columns.map((x) => (x.name === c.name ? { ...x, ...c, type: c.type ?? x.type } : x));
        else t.columns.push({ name: c.name, type: c.type ?? 'text', ...(c.table ? { table: c.table } : {}), ...(c.help ? { help: c.help } : {}) });
      }
      if (a.remove_columns?.length) {
        t.columns = t.columns.filter((c) => c.name === 'id' || !a.remove_columns!.includes(c.name));
        for (const r of t.rows) for (const k of a.remove_columns) if (k !== 'id') delete r[k];
      }
      if (a.delete_ids?.length) t.rows = t.rows.filter((r) => !a.delete_ids!.includes(r.id));
      let added = 0;
      let changed = 0;
      for (const u of a.upsert ?? []) {
        const id = String(u.id ?? '');
        if (!id) throw new Error('Every upserted row needs an "id"');
        let row = t.rows.find((r) => r.id === id);
        if (!row) {
          row = { id } as DataRow;
          t.rows.push(row);
          added++;
        } else changed++;
        for (const [k, v] of Object.entries(u)) {
          if (k === 'id') continue;
          if (v === null) delete row[k];
          else (row as Record<string, unknown>)[k] = v;
        }
      }
      const saved = ws.saveTable(t, AUTHOR);
      return text(`Updated data/${saved.name}.json: ${added} added, ${changed} changed, ${a.delete_ids?.length ?? 0} deleted. ${saved.rows.length} rows, columns ${saved.columns.map((c) => c.name).join(', ')}.`);
    },
  );

  tool('delete_data', 'Delete a data table.', { table: z.string() }, (a) => {
    ws.removeTable(a.table);
    return text(`Deleted data/${a.table}.json.`);
  }, { destructiveHint: true });

  // ------------------------------------------------------------------ visual effects

  const vfxNodeSchema = z.object({
    id: z.string().describe('Unique in the effect, used by the wires, e.g. "boom"'),
    type: z.enum(VFX_NODE_TYPES as [string, ...string[]]),
    params: z.record(z.string(), z.unknown()).optional().describe('See vfx_reference; anything omitted keeps its default'),
  });
  const vfxEdgeSchema = z.object({ from: z.string(), to: z.string(), port: z.string().optional().describe('Only for nodes with several outputs (repeat: each, done)') });

  const vfxText = (g: VfxGraph): string => {
    const params = (p: Record<string, unknown>) => (Object.keys(p).length ? ` ${JSON.stringify(p)}` : '');
    return `Effect "${g.name}"${g.description ? ` — ${g.description}` : ''}\nNodes:\n${g.nodes.map((n) => `- ${n.id}: ${n.type}${params(n.params)}`).join('\n')}\nWires:\n${g.edges.map((e) => `- ${e.from}${e.port ? `.${e.port}` : ''} -> ${e.to}`).join('\n') || '- none'}`;
  };
  const vfxProblems = (g: VfxGraph): string[] => checkVfx(g, { sprites: new Map(ws.list().map((s) => [s.name, s.tags ?? []])), sounds: [...SOUNDS, ...ws.listAudio().map((x) => x.name)] });
  const vfxPreview = (g: VfxGraph, o: Parameters<typeof renderVfxStrip>[2] = {}) => {
    const { png, timeline, times } = renderVfxStrip(loadGameBundle(ws), g, o);
    const spans = timeline.spans.map((s) => `  ${s.from.toFixed(2)}–${s.to.toFixed(2)}s ${s.id} (${s.type})`).join('\n');
    const messages = timeline.messages.length ? `\nMessages: ${timeline.messages.map((m) => `"${m.message}" at ${m.time.toFixed(2)}s`).join(', ')}` : '\nNo Message node: nothing tells the game when it connects.';
    return [...text(`"${g.name}" lasts ${timeline.duration.toFixed(2)}s, peak ${timeline.peakParticles} particles.${messages}\nTimeline:\n${spans}\nFilmstrip at ${times.map((t) => t.toFixed(2)).join(', ')}s (blue = source, red = target).`), image(png)];
  };
  const saveVfxChecked = (raw: unknown, name: string): Content => {
    const g = normalizeVfx(raw, name);
    if (vfxHasCycle(g)) throw new Error('The wires form a loop; an effect has to end. Use a Repeat node.');
    const saved = ws.saveVfx(g, AUTHOR);
    const problems = vfxProblems(saved);
    return text(`Saved vfx/${saved.name}.json. Scripts: await vfx("${saved.name}", self, target).\n${vfxText(saved)}${problems.length ? `\nPROBLEMS:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`);
  };
  const failOnInputErrors = (nodes: { id?: unknown; type?: unknown; params?: Record<string, unknown> }[]) => {
    const errors = vfxInputErrors(nodes);
    if (errors.length) throw new Error(errors.join('\n'));
  };

  tool('vfx_reference', 'Reference of visual effect graphs: every node with its params and defaults, and how to play effects from scripts, events and animation frames. Read it before writing effects.', {}, () => text(VFX_REFERENCE), { readOnlyHint: true });

  tool('list_vfx', 'List the visual effects (vfx/<name>.json).', {}, () => {
    const list = ws.listVfx();
    return text(list.length ? list.map((g) => `- ${g.name}: ${g.nodes} nodes${g.description ? ` — ${g.description}` : ''}`).join('\n') : `No effects yet. Create one with write_vfx (templates: ${VFX_TEMPLATE_IDS.join(', ')}).`);
  }, { readOnlyHint: true });

  tool('read_vfx', 'Read a visual effect: its nodes with their params, and its wires.', { effect: z.string() }, (a) => text(vfxText(ws.loadVfx(a.effect))), { readOnlyHint: true });

  tool(
    'write_vfx',
    'Create or replace a visual effect: a flow graph for an attack, spell or hit (see vfx_reference). Give nodes and edges, or a template to start from (nodes/edges then replace nothing: use update_vfx to tweak it). A Start node with id "start" is added if missing. The web editor (VFX tab) shows it live.',
    {
      effect: z.string().describe('Name, e.g. "fireball"'),
      description: z.string().optional(),
      template: z.enum(VFX_TEMPLATE_IDS as [string, ...string[]]).optional(),
      nodes: z.array(vfxNodeSchema).optional(),
      edges: z.array(vfxEdgeSchema).optional(),
      preview: z.boolean().optional().describe('Also return the filmstrip'),
    },
    (a) => {
      if (!VFX_NAME_RE.test(a.effect)) throw new Error(`Invalid effect name "${a.effect}". Use letters, digits, "_" and "-".`);
      const tpl = VFX_TEMPLATES.find((t) => t.id === a.template);
      if (!tpl && !a.nodes) throw new Error('Give nodes (and edges), or a template.');
      failOnInputErrors(a.nodes ?? []);
      const out = saveVfxChecked(a.nodes ? { description: a.description ?? tpl?.description, nodes: a.nodes, edges: a.edges ?? [] } : { description: a.description ?? tpl?.description, ...tpl!.graph }, a.effect);
      return a.preview ? [...out, ...vfxPreview(ws.loadVfx(a.effect))] : out;
    },
  );

  tool(
    'update_vfx',
    'Tweak a visual effect without rewriting it: change params of nodes (only the ones you give), add or remove nodes, connect or disconnect wires, rename.',
    {
      effect: z.string(),
      description: z.string().optional(),
      set: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('Node id → params to change, e.g. { "arc": { "radius": 28, "colors": ["#fff", "#f00"] } }'),
      add_nodes: z.array(vfxNodeSchema).optional(),
      remove_nodes: z.array(z.string()).optional(),
      connect: z.array(vfxEdgeSchema).optional(),
      disconnect: z.array(vfxEdgeSchema).optional(),
      rename_to: z.string().optional(),
      preview: z.boolean().optional().describe('Also return the filmstrip'),
    },
    (a) => {
      const g = ws.loadVfx(a.effect);
      failOnInputErrors(a.add_nodes ?? []);
      for (const [id, params] of Object.entries(a.set ?? {})) {
        const node = g.nodes.find((n) => n.id === id);
        if (!node) throw new Error(`No node "${id}" in "${a.effect}" (nodes: ${g.nodes.map((n) => n.id).join(', ')})`);
        failOnInputErrors([{ id, type: node.type, params }]);
        Object.assign(node.params, params);
      }
      for (const id of a.remove_nodes ?? []) {
        const node = g.nodes.find((n) => n.id === id);
        if (!node) throw new Error(`No node "${id}" in "${a.effect}"`);
        if (node.type === 'start') throw new Error('The Start node cannot be removed');
        g.nodes = g.nodes.filter((n) => n.id !== id);
        g.edges = g.edges.filter((e) => e.from !== id && e.to !== id);
      }
      for (const n of a.add_nodes ?? []) {
        if (g.nodes.some((x) => x.id === n.id)) throw new Error(`Node "${n.id}" already exists`);
        // No position: normalizing places it in the column its wires call for.
        g.nodes.push({ id: n.id, type: n.type, params: (n.params ?? {}) as VfxGraph['nodes'][number]['params'] } as VfxGraph['nodes'][number]);
      }
      const sameWire = (x: VfxEdge, y: VfxEdge) => x.from === y.from && x.to === y.to && vfxEdgePort(g, x) === vfxEdgePort(g, y);
      for (const d of a.disconnect ?? []) {
        if (!g.edges.some((e) => sameWire(e, d))) throw new Error(`No wire ${d.from} -> ${d.to}`);
        g.edges = g.edges.filter((e) => !sameWire(e, d));
      }
      for (const c of a.connect ?? []) {
        for (const id of [c.from, c.to]) if (!g.nodes.some((n) => n.id === id)) throw new Error(`No node "${id}" in "${a.effect}"`);
        g.edges.push(c);
      }
      if (a.description !== undefined) g.description = a.description;
      const to = a.rename_to ?? a.effect;
      if (a.rename_to && a.rename_to !== a.effect) {
        if (!VFX_NAME_RE.test(a.rename_to)) throw new Error(`Invalid effect name "${a.rename_to}"`);
        if (ws.vfxExists(a.rename_to)) throw new Error(`Effect "${a.rename_to}" already exists`);
      }
      const out = saveVfxChecked(g, to);
      if (to !== a.effect) ws.removeVfx(a.effect);
      return a.preview ? [...out, ...vfxPreview(ws.loadVfx(to))] : out;
    },
  );

  tool('delete_vfx', 'Delete a visual effect.', { effect: z.string() }, (a) => {
    ws.loadVfx(a.effect);
    ws.removeVfx(a.effect);
    return text(`Deleted vfx/${a.effect}.json.\n\n${problemsText()}`);
  }, { destructiveHint: true });

  tool(
    'preview_vfx',
    'See a visual effect: a filmstrip of evenly spaced moments drawn as in the game (blue block = source, red block = target) and its timeline: when each node runs, when messages fire, how long it lasts. Use it after every change.',
    {
      effect: z.string(),
      frames: z.number().int().min(1).max(24).optional().describe('Moments to show (default 8)'),
      scale: z.number().int().min(1).max(4).optional().describe('Zoom (default 2)'),
      distance: z.number().int().min(16).max(400).optional().describe('Pixels between source and target (default 96)'),
      dark: z.boolean().optional().describe('Dark scene, to judge Light nodes and glow'),
      tint: z.string().optional().describe('Preview vfx(..., { tint })'),
      speed: z.number().positive().optional().describe('Preview vfx(..., { speed })'),
      size: z.number().positive().optional().describe('Preview vfx(..., { scale })'),
    },
    (a) => vfxPreview(ws.loadVfx(a.effect), a),
    { readOnlyHint: true },
  );

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
