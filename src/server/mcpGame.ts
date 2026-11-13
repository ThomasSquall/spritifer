/** MCP tools for building games: project settings, object types, scenes, tiles, instances, events, playtests, export. */

import fs from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BEHAVIOR_MAP, SOUNDS, catalogReference, describeEvent, describeStep } from '../core/game/catalog.js';
import { checkExpr } from '../core/game/expr.js';
import { BUILTIN_FONT, FONTS } from '../core/game/font.js';
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
  normalizeSway,
  normalizeAmbientSound,
  normalizeAmbience,
  MOTE_PRESETS,
  normalizeObject,
  normalizeScene,
  normalizeTable,
  resizeScene,
} from '../core/game/types.js';
import { exportAndroid } from './android.js';
import { HD_CELL_MAX_ROWS, HD_FIELDS, normalizeHd } from '../core/game/hd.js';
import { HD_SHAPES } from '../core/game/hd3d.js';
import { BitmapRenderer, buildAsset, exportGame, loadGameBundle, renderSceneHd, renderScenePreview, renderVfxStrip, renderViewport } from './game.js';
import { renderPlan } from './planView.js';
import { buildBlueprint, currentBlueprint, draftFromScene } from './blueprints.js';
import type { Blueprint, BpProblem } from '../core/game/blueprint.js';
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
import { USAGE_KINDS, findUsages, formatUsages } from '../core/game/usages.js';
import { type GameTest, normalizeTest } from '../core/game/gameTests.js';
import { type ScatterRecipe, deleteGroup, extractRegion, listGroups, pasteRegion, regenerateGroup, renameGroup, scatterIntoGroup } from '../core/game/sceneOps.js';
import { formatEditorContext, formatNotes, listNotes, setNote } from './context.js';
import { formatHistory, undoChange } from './history.js';
import { architectureReport, formatTestRun, instanceSizes, loadSources, mapReport, runTests } from './projectTools.js';
import { enableGit, gitCommit, gitCommitFiles, gitDiff, gitLog, gitPull, gitPush, gitRestore, gitSetRemote, gitStatus } from './projectGit.js';

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
- Working with the person in the editor: when they say "this", "here", "questo", "qui" or report something they just saw, call get_editor_context first (open page, selection, their notes on the map, errors of their last Play). Answer a note with set_note.
- Before changing or removing something, find_usages shows every place that depends on it. history lists every change, yours and theirs; undo_game_change undoes one without losing what came after.
- After changing maps, scripts or the story, run_tests runs the saved playtests. get_world_map and validate_game show how scenes connect and what is unreachable.
- Large maps: scatter_instances (trees, rocks) with a group, scene_group to redo or remove it, copy_scene_region for whole areas. Prefer these to writing code that edits scene files.
- Projects: list_projects / open_project / create_project switch between games; each project folder has its own sprites, scenes, scripts and game.json.
- Version control: each game folder is its own git repository, separate from the editor's code (new projects start with one; git_enable adds it to an older project). git_commit after a meaningful step, git_log / git_show / git_diff to look back, git_restore to go back (whole game or one file: uncommitted work is saved first and history is never rewritten), git_push / git_pull with the remote set by git_remote. Commit or push only when the user asks.

Workflow that works:
1. Draw the art first with the sprite tools: a tileset sprite with tile_width/tile_height (index = position in the grid, row-major), characters with tags idle/run/jump/fall (platformer) or idle_<dir>/walk_<dir> (topdown, as rig_animate makes them), items, enemies. tileset_preview shows each tile's index.
2. set_game (resolution, e.g. 320x180; gravity) and set_object for each kind of thing. The player gets platformer or topdown + camera.
3. create_scene, paint_tiles (rows + legend like draw_pixels, chars → tile indices; set solid on collision layers with set_tile_layer), place_instances.
4. Events: collisions (collect coins: add score, destroy other, sound coin), hazards (restartScene), goals (gotoScene), HUD text objects.
5. ALWAYS verify: validate_game, preview_scene, then playtest with scripted inputs (vars: {...} starts at a later stage, player_at: [x, y] puts the player next to what you test) (e.g. hold right 2s, tap up) and read the final state, logs and screenshot. Fix and re-test until it plays as intended.
6. export_game and tell the user where index.html is (it runs offline and can be uploaded to itch.io as an HTML game), or export_android for an installable APK.
`;


const BLUEPRINT_REFERENCE = `A blueprint says what a map IS; tiles, collision, the walls of the 2D-HD view and instances are compiled from it.

Work in this order and stop at each step: (1) concept and spaces, look at preview_scene view "plan"; (2) links, water, checks; dry_run until there are no errors; (3) elements; (4) look at view "2d" and view "hd".

{ concept, kit, size: [cols, rows], spaces: [], links: [], water: [], elements: [], checks: [] }

concept: what this place is and why it is built this way. Required.
spaces: { id, kind: hall|room|corridor|alcove|landing|gallery, purpose: "what happens or happened here" (required), rects: [[x,y,w,h], ...] }. The first rect's corner is the space's origin.
  What is not a space is empty darkness, not rock. Every space gets its own walls: a front 3 tiles high on its north side and one tile of top behind it, one tile of wall east and west, a low kerb south (the camera sees in over it).
  So between a floor and the next floor to the north leave at least 4 rows (3 are tolerated, with a warning; fewer is an error). East to west 1 is enough.
links: { a, b, via: open|arch|door|gate|stair|bridge, note? }. Spaces that touch must be linked and linked spaces must touch; a passage through a wall is a corridor space between two rooms.
water: { id, kind: canal (water, not walkable) | dry (empty channel, not walkable) | basin (walkable until blocked), rects, flows?: [{ when: expr, look?, name?, joined?: [ids] }] }. Must lie inside spaces. A walkway across water is simply the cells the water rects leave out.
elements: an instance plus { in: spaceId, at: [x,y] tiles from the space's origin, mount }.
  mount "floor": at = the feet; must be on floor. "wall": hung on a north front; at = the bottom of the sprite, on a front cell or on the first row of floor under one. "flat": lies on the floor. "pit": stands in a canal or basin. "marker": no sprite (exits, zones, light spots, blocks); at = top-left corner.
  Other fields are those of an instance: id, object, name, sprite, animation, activeIf, props, components, tags, light. Keep the ids that saves depend on. blk_WxH objects are solid while their activeIf holds (closed gates, flooded passages).
checks: { name, vars?: {...}, from: place, reach?: [places], block?: [places] }: routes that must or must not exist at a moment of the story. place: [x,y], "spaceId" (its middle), or ["spaceId",dx,dy].

Painted terrain (woods, towns, caves): set terrain: "painted" and no kit. Tiles and scatter (trees, grass, pebbles: unnamed or "~" names) stay as they are; spaces are zones of the ground, kinds clearing|road|plaza|shore|marsh|maze|cave|quarter too. Rects may be generous: a zone is the walkable ground inside them, and earlier zones win. Links say which zones the ground joins: joined without a link, or linked without ground, is an error. elements are what matters: exits, characters, chests, buildings, anything with a name. validate_game also looks for invisible walls, trunks that can be walked through, ground nothing leads to and exits nothing shows.

Compile with write_blueprint or edit_blueprint. Instances moved or tiles painted by hand on a compiled map go back into the blueprint on the next build, so they aren't lost.`;

export function registerGameTools(ws: Workspace, h: ToolHelpers): void {
  const { tool, text, image } = h;
  const AUTHOR = 'claude';

  const mutateGame = <T>(fn: (g: GameProject) => T): { game: GameProject; result: T } => {
    const game = ws.loadGame();
    const result = fn(game);
    ws.saveGame(game, AUTHOR);
    return { game, result };
  };

  const mutateScene = <T>(name: string, fn: (s: Scene) => T): { scene: Scene; result: T } => {
    const scene = ws.loadScene(name);
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
const hdFields = Object.fromEntries(HD_FIELDS.map((f) => [f.mcp, z.number().min(f.min).max(f.max).optional().describe(`${f.hint} (default ${f.dflt})`)]));
const hdValues = (a: Record<string, unknown>) => ({ ...Object.fromEntries(HD_FIELDS.map((f) => [f.key, a[f.mcp]])), hazeColor: a.haze_color });
const HAZE_COLOR = z.string().optional().describe('"#rrggbb". Absent: derived from the ambient light of the scene');
const atmosphereSchema = z.object({
  ambient: z.string().optional().describe('Multiplied over the world. "#ffffff" plain day, "#fff0dc" warm day, "#c8d0ff" overcast, "#8a7ab8" dusk, "#3a3c70" night, "#2a2440" dark cave. Lights cut through it.'),
  glow: z.number().min(0).max(2).optional().describe('Bloom added by lights (default 0.6)'),
  shadows: z.boolean().optional().describe('Soft contact shadows under instances (default true): width = object hitbox width, or the object type "shadow". With a relief sun, instances cast their silhouette instead'),
  shadow_color: z.string().optional(),
  shadow_opacity: z.number().min(0).max(1).optional().describe('Default 0.38'),
  vignette: z.number().min(0).max(1).optional().describe('Darken screen edges, ~0.3'),
  vignette_color: z.string().optional(),
  clouds: z.object({ sprite: z.string(), opacity: z.number().min(0).max(1).optional(), speed_x: z.number().optional(), speed_y: z.number().optional() }).nullable().optional().describe('Drifting cloud shadows: a tileable sprite of dark soft blobs on transparent'),
  tint: z.string().optional().describe('Soft-light color grade, e.g. "#ffb070" golden hour, "#5080ff" cold'),
  tint_amount: z.number().min(0).max(1).optional(),
  motes: z.object({ preset: z.enum(MOTE_PRESETS), count: z.number().int().min(0).max(400).optional(), color: z.union([z.string(), z.array(z.string())]).optional() }).nullable().optional().describe('Ambient floating particles'),
  rain: z.object({ count: z.number().int().min(0).max(800).optional().describe('Drops at once, default 140'), angle: z.number().min(-60).max(60).optional(), speed: z.number().min(50).max(1500).optional(), color: z.string().optional(), opacity: z.number().min(0).max(1).optional(), splashes: z.boolean().optional(), lightning: z.number().min(0).max(30).optional().describe('Flashes per minute'), flash_color: z.string().optional(), thunder: z.string().optional().describe('Audio file played after each flash') }).nullable().optional().describe('Rain, with lightning if asked'),
  shafts: z.object({ count: z.number().min(1).max(24).optional(), color: z.string().optional(), opacity: z.number().min(0).max(1).optional(), angle: z.number().min(-70).max(70).optional(), width: z.number().min(2).max(300).optional() }).nullable().optional().describe('Shafts of light through the air; floating particles catch the light in them'),
  reflections: z.object({ opacity: z.number().min(0).max(1).optional(), wobble: z.number().min(0).max(8).optional(), sprites: z.array(z.string()).optional().describe('Sprites of instances that are water too; animated tiles count by themselves') }).nullable().optional().describe('Water mirrors what stands by it'),
  motes2: z.object({ preset: z.enum(MOTE_PRESETS), count: z.number().int().min(0).max(400).optional(), color: z.union([z.string(), z.array(z.string())]).optional() }).nullable().optional().describe('A second kind of particles over the first (dust and falling leaves together)'),
  relief: z.object({
    strength: z.number().min(0).max(2).optional().describe('How strongly light shapes the sprites (default 1)'),
    bands: z.number().int().min(0).max(16).optional().describe('Light steps on the sprites, 0 = smooth (default 4)'),
    rim: z.number().min(0).max(2).optional().describe('Light caught on edges facing it (default 0.9)'),
    light_height: z.number().min(0.05).max(2).optional().describe('Height of lamps as a fraction of their radius; lower = more dramatic (default 0.3)'),
    tiles: z.boolean().optional().describe('Tiles on solid layers (walls, cliffs, treetops) catch the light too; the ground stays clean (default true)'),
    sun: z.object({
      angle: z.number().min(-360).max(360).optional().describe('Screen direction of the sun: 0 right, 90 down, -90 up (default -135)'),
      elevation: z.number().min(5).max(90).optional().describe('Low = long cast shadows (default 50)'),
      color: z.string().optional().describe('"#ffe2b0" warm sun, "#a8c4ff" moon'),
      intensity: z.number().min(0).max(3).optional(),
      shade: z.string().optional().describe('Color of the side away from the sun (default soft blue-violet)'),
    }).optional().describe('Directional light for the whole scene, with shadows cast on the ground. Omit for none'),
  }).nullable().optional().describe('Per-pixel lighting: lights and the sun shape the volumes of the sprites, from a normal map computed automatically. Pass {} to enable with defaults. See set_relief for a single sprite'),
  hd: z.object({ ...hdFields, haze_color: HAZE_COLOR, off: z.boolean().optional().describe('Keep this scene flat even with 2D-HD on (title screens)') }).nullable().optional().describe('This scene\'s own auto 2D-HD settings, over the game\'s (set_game hd). Omit to follow the game'),
});
const toAtmosphere = (a: z.infer<typeof atmosphereSchema>) =>
  normalizeAtmosphere({ ambient: a.ambient, glow: a.glow, shadows: a.shadows, shadowColor: a.shadow_color, shadowOpacity: a.shadow_opacity, vignette: a.vignette, vignetteColor: a.vignette_color, clouds: a.clouds ? { sprite: a.clouds.sprite, opacity: a.clouds.opacity, speedX: a.clouds.speed_x, speedY: a.clouds.speed_y } : undefined, tint: a.tint, tintAmount: a.tint_amount, motes: a.motes ?? undefined, motes2: a.motes2 ?? undefined, rain: a.rain ? { ...a.rain, flashColor: a.rain.flash_color } : undefined, shafts: a.shafts ?? undefined, reflections: a.reflections ?? undefined, relief: a.relief ? { strength: a.relief.strength, bands: a.relief.bands, rim: a.relief.rim, lightHeight: a.relief.light_height, tiles: a.relief.tiles, sun: a.relief.sun } : undefined, hd: a.hd ? { ...hdValues(a.hd), off: a.hd.off } : undefined });

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
      font: z.enum(FONTS.map((f) => f.id) as [string, ...string[]]).optional().describe('Font of all in-game text. "builtin" is the 3x5 capitals; "pixel-operator" has lowercase and accents, keeps the 4x6-per-character layout and needs a ui_scale of 2, 4, 6 or 8'),
      ui_scale: z.number().int().min(1).max(8).optional().describe('Interface pixels are this many canvas pixels: width 960 with ui_scale 3 keeps scripts and dialogs in 320×180, and a Camera zoom of 2 then shows 480×270 of the world with square pixels'),
      background: z.string().optional(),
      start_scene: z.string().optional(),
      gravity: z.number().optional().describe('px/s² for platformer/patrol (default 900)'),
      touch_controls: z.boolean().optional(),
      hd: z.object({ ...hdFields, haze_color: HAZE_COLOR, enabled: z.boolean().optional().describe('On when the game starts, for a player who never chose. Players switch it with F6 or game.hd') }).nullable().optional().describe('Auto 2D-HD: bloom, depth of field, haze and halos over the picture, maps and sprites untouched (replaces the settings; null removes them). Scenes can override it with atmosphere.hd'),
      variables: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      components: z.array(stepSchema).optional().describe('Global components alive for the whole game across scenes (replace the list): [{ type: "script", name: "GameManager" }]'),
      android_package: z.string().regex(/^$|^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/).optional().describe('Android application id ("com.yourname.game"). Keep it once published: another id is another app. Empty = derived from the title'),
      android_version: z.string().optional().describe('Version shown to Android players (default "1.0"). Empty = default'),
      android_icon: z.string().optional().describe('Sprite used as Android app icon. Empty = a sprite named "icon", else the first object\'s'),
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
        if (a.font !== undefined) { if (a.font === BUILTIN_FONT.id) delete g.font; else g.font = a.font; }
        if (a.ui_scale !== undefined) { if (a.ui_scale > 1) g.uiScale = a.ui_scale; else delete g.uiScale; }
        if (a.background !== undefined) g.background = a.background;
        if (a.start_scene !== undefined) {
          if (!ws.sceneExists(a.start_scene)) throw new Error(`No scene "${a.start_scene}"`);
          g.startScene = a.start_scene;
        }
        if (a.gravity !== undefined) g.gravity = a.gravity;
        if (a.touch_controls !== undefined) g.touchControls = a.touch_controls;
        if (a.hd === null) delete g.hd;
        else if (a.hd) g.hd = normalizeHd({ ...hdValues(a.hd), enabled: a.hd.enabled });
        if (a.android_package !== undefined || a.android_version !== undefined || a.android_icon !== undefined) {
          if (a.android_icon && !ws.exists(a.android_icon)) throw new Error(`No sprite "${a.android_icon}"`);
          const given = { package: a.android_package, version: a.android_version, icon: a.android_icon };
          const next = { ...g.android };
          for (const k of ['package', 'version', 'icon'] as const) {
            const v = given[k];
            if (v) next[k] = v;
            else if (v === '') delete next[k];
          }
          if (Object.keys(next).length) g.android = next;
          else delete g.android;
        }
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
    kind: z.enum(['grid', 'random', 'blob', 'corners']).describe('grid = big seamless texture cut into size×size pieces by position; random = one of count alternatives by position; blob = 47-shape autotile from the 8 neighbours (size×size pieces per shape); corners = 16-tile corner set for two terrains (pixellab_import_tileset): put the rule on the lower terrain with group = the painted tiles of the upper one'),
    first: z.number().int().min(0).describe("First tile of the rule's block in the tileset"),
    size: z.number().int().min(1).max(16).optional().describe('grid / blob: pieces per side (default 1)'),
    count: z.number().int().min(1).optional().describe('random: number of alternatives. corners: alternatives of the plain terrain, from alt'),
    group: z.array(z.number().int().min(0)).optional().describe('blob: painted tiles counted as the same terrain (default just tile). corners: required, the painted tiles of the other terrain'),
    alt: z.number().int().min(0).optional().describe('corners: first of the count alternatives for cells that touch no other terrain'),
    invert: z.boolean().optional().describe('corners: put the rule on the upper terrain with group = the lower one, so the border is drawn inside its cells. Use it for solid terrain (water, walls, dense forest), so walkable cells stay clear'),
    variants: z.number().int().min(2).max(64).optional().describe('corners: this many blocks of 16 tiles follow each other from first, picked by position, so a long border does not repeat'),
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
    'Tile rules of a tileset (game.json tilesets): autotiling (blob, or corners for two-terrain sets), big seamless textures (grid), random variants, animated tiles and edge overlays (grass creeping onto paths, foam on shores). Scenes keep storing only the painted tile; the game and the scene editor draw the generated pieces. rules / edges replace their whole list when given (null clears); paintable = how many tiles (from 0) the editor palette shows. clear removes all rules of the tileset.',
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
      copy_from: z.string().optional().describe('Create it as a full copy of this object type (name must be new). For a type that keeps following the original, use extends'),
      sprite: z.string().nullable().optional().describe('Sprite drawn for instances (null = none, e.g. for text objects)'),
      animation: z.string().optional().describe('Default animation tag ("" = all frames)'),
      hitbox: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable().optional().describe('Collision box relative to the sprite top-left (null = whole frame). Make it a bit smaller than the art for fair collisions.'),
      sprite_offset: z.object({ x: z.number(), y: z.number() }).nullable().optional().describe('Draw the sprite shifted from the instance position (null = none), so a larger canvas keeps the same position and hitbox'),
      z: z.number().optional().describe('Draw order (higher = in front; tile layers default to -10..)'),
      text: z.string().nullable().optional().describe('Text objects: expression shown as text, e.g. "\\"Score: \\" + score"'),
      text_color: z.string().optional(),
      text_size: z.number().int().min(1).max(8).optional(),
      hud: z.boolean().optional().describe('Draw in screen space (ignores the camera)'),
      light: lightSchema.nullable().optional().describe('Light it gives off (seen in scenes with an atmosphere: darker ambient + glow). null removes'),
      shadow: z.number().min(0).nullable().optional().describe('Contact shadow width in px (0 = none, null = automatic: hitbox width). Flat things (rugs, doormats, flowerbeds) want 0'),
      hd_pose: z.enum(['flat', 'stand']).nullable().optional().describe('In the 2D-HD perspective: lies on the ground or stands up. null = automatic (flat when z is below 0)'),
      hd_shape: z.enum(HD_SHAPES).nullable().optional().describe('In the 2D-HD perspective, the solid a standing sprite is wrapped on: round for columns and barrels, octagon, hexagon, square (a corner towards the camera). The width of each row gives its size. null = flat'),
      hd_relief: z.number().int().min(0).max(40).optional().describe('In the 2D-HD perspective, pixels a sprite hung on a wall stands out from it: its outline is extruded (a relief, statues in a niche). 0 = none'),
      sway: z.object({ amount: z.number().min(0).max(24).describe('Pixels the top of the sprite travels; the foot stays still. Trees want 2-4'), speed: z.number().min(0.1).max(5).optional().describe('1 = normal'), react: z.number().min(0).max(24).optional().describe('Pixels a character walking through pushes the top aside, springing back after. Grass and ferns want 2-4') }).nullable().optional().describe('Wind: bends the sprite when drawn, without new art or frames, with gusts travelling across the map. The hitbox does not move. null = off'),
      extends: z.string().nullable().optional().describe('Make it a VARIANT of another object type (like a Unity prefab variant): it inherits sprite, hitbox, properties, tags, components (params can be overridden by listing the same component with only the changed params) and events, and stores only what differs. null = standalone again. Queries and events on the parent type (find("slime"), "collides with slime", count) include its variants.'),
      ambient_sound: z.object({ sound: z.string(), volume: z.number().min(0).max(1).optional().describe('Next to it, default 0.4'), radius: z.number().min(8).max(4096).optional().describe('Heard up to this many px from the middle of the screen, default 160') }).nullable().optional().describe('A sound looping around every instance (fire, fountain): louder the closer the camera is. null = off'),
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
        if (o && a.copy_from) throw new Error(`Object type "${a.name}" already exists`);
        if (!o) {
          const source = a.copy_from ? g.objects.find((x) => x.name === a.copy_from) : undefined;
          if (a.copy_from && !source) throw new Error(`No object type "${a.copy_from}" to copy`);
          o = normalizeObject(source ? { ...JSON.parse(JSON.stringify(source)), name: a.name } : { name: a.name });
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
        if (a.sprite_offset === null) delete o.spriteOffset;
        else if (a.sprite_offset) o.spriteOffset = a.sprite_offset;
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
        if (a.hd_shape !== undefined) {
          if (a.hd_shape === null) delete o.hdShape;
          else o.hdShape = a.hd_shape;
        }
        if (a.hd_relief !== undefined) {
          if (a.hd_relief > 0) o.hdRelief = a.hd_relief;
          else delete o.hdRelief;
        }
        if (a.hd_pose !== undefined) {
          if (a.hd_pose === null) delete o.hdPose;
          else o.hdPose = a.hd_pose;
        }
        if (a.shadow !== undefined) {
          if (a.shadow === null) delete o.shadow;
          else o.shadow = Math.round(a.shadow);
        }
        if (a.sway !== undefined) {
          const s = a.sway === null ? undefined : normalizeSway(a.sway);
          if (s) o.sway = s;
          else delete o.sway;
        }
        if (a.ambient_sound !== undefined) {
          const s = a.ambient_sound === null ? undefined : normalizeAmbientSound(a.ambient_sound);
          if (s && !ws.listAudio().some((x) => x.name === s.sound)) throw new Error(`No audio "${s.sound}". Import it with import_audio.`);
          if (s) o.ambientSound = s;
          else delete o.ambientSound;
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
      const scene = createScene({ name: a.name, cols: a.cols, rows: a.rows, tileSize, tileset: a.tileset, background: a.background ?? '' });
      ws.saveScene(scene, AUTHOR);
      const g = ws.loadGame();
      if (!g.startScene || !ws.sceneExists(g.startScene) || !ws.hasGame()) {
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
    const lines = [describeScene(s), ...(s.hdCells ? [`2D-HD wall corrections (x,y: 0 flat, n front rows): ${JSON.stringify(s.hdCells)}`] : []), ...(s.hdJuts ? [`2D-HD wall juts: ${JSON.stringify(s.hdJuts)}`] : []), '', 'Instances:'];
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
    'Change scene properties: size (keeps the top-left content), tileset, background color, parallax background sprites, scene variables, y-sort, name, atmosphere (lighting, per-pixel relief lighting with sun and cast shadows, contact shadows, cloud shadows, color grade, vignette, ambient particles).',
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
      hd_juts: z.array(z.object({ x: z.number().int().min(0).describe('Left edge in map pixels'), w: z.number().int().min(1).describe('Width in pixels'), foot: z.number().int().min(0).describe('Tile row of the foot of the wall front'), depth: z.number().int().min(1).max(64).describe('Pixels it stands forward') })).nullable().optional().describe('Stretches of wall fronts that stand forward in the 2D-HD view: piers, buttresses (replaces the list; null removes it)'),
      hd_walls: z.array(z.object({ x: z.number().int().min(0), y: z.number().int().min(0), w: z.number().int().min(1).optional(), h: z.number().int().min(1).optional(), mode: z.enum(['auto', 'flat', 'wall']), rows: z.number().int().min(1).max(HD_CELL_MAX_ROWS).optional().describe('With mode wall: height of the front in tiles (default 3). The whole column of wall cells takes it') })).optional().describe('Corrections to the automatic walls of the 2D-HD view, cell by cell or by rectangle, merged with the ones already there. auto removes a correction'),
      persistent: z.boolean().optional().describe('Remember instances when leaving (positions, properties, destroyed ones), e.g. an RPG town you come back to after a battle'),
      components: z.array(stepSchema).optional().describe('Scene components (replace the list): [{ type: "script", name: "Battle", foeHp: 12 }] — managers, level logic, HUD'),
      music: z.string().nullable().optional().describe('Music when the scene starts: an audio file name (list_audio), "-" for silence, null = keep what plays'),
      ambience: z.array(z.object({ sound: z.string(), volume: z.number().min(0).max(1).optional().describe('default 0.4') })).optional().describe('Sounds that loop while the scene lasts (wind, crickets, dripping), replacing the list; [] = none. They fade across scene changes'),
      atmosphere: atmosphereSchema.nullable().optional().describe('Lighting and mood (replaces the whole atmosphere; null removes it). Lights come from object types / instances with "light".'),
    },
    (a) => {
      const { scene } = mutateScene(a.scene, (s) => {
        if (a.persistent !== undefined) {
          if (a.persistent) s.persistent = true;
          else delete s.persistent;
        }
        if (a.hd_juts !== undefined) {
          if (a.hd_juts?.length) s.hdJuts = a.hd_juts;
          else delete s.hdJuts;
        }
        for (const c of a.hd_walls ?? []) {
          const cells = { ...(s.hdCells ?? {}) };
          for (let y = c.y; y < c.y + (c.h ?? 1); y++) {
            for (let x = c.x; x < c.x + (c.w ?? 1); x++) {
              if (x >= s.cols || y >= s.rows) throw new Error(`hd_walls: cell ${x},${y} is outside the scene`);
              if (c.mode === 'auto') delete cells[`${x},${y}`];
              else cells[`${x},${y}`] = c.mode === 'flat' ? 0 : (c.rows ?? 3);
            }
          }
          if (Object.keys(cells).length) s.hdCells = cells;
          else delete s.hdCells;
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
        if (a.ambience) {
          for (const l of a.ambience) if (!ws.listAudio().some((x) => x.name === l.sound)) throw new Error(`No audio "${l.sound}". Import it with import_audio.`);
          const list = normalizeAmbience(a.ambience);
          if (list) s.ambience = list;
          else delete s.ambience;
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
        const changed = renameSceneRefs(game, [scene, ...others], a.scene, a.new_name);
        ws.saveScene(scene, AUTHOR);
        ws.removeScene(a.scene, AUTHOR);
        for (const s of changed) if (s !== scene) ws.saveScene(s, AUTHOR);
        ws.saveGame(game, AUTHOR);
      }
      return text(`Saved.\n${describeScene(scene)}`);
    },
  );

  tool('duplicate_scene', 'Copy a scene under a new name: tiles, instances, events, atmosphere and all.', { scene: z.string(), new_name: z.string() }, (a) => {
    assertIdentifier('scene', a.new_name);
    if (ws.sceneExists(a.new_name)) throw new Error(`Scene "${a.new_name}" already exists`);
    const copy = ws.loadScene(a.scene);
    copy.name = a.new_name;
    ws.saveScene(copy, AUTHOR);
    return text(`Created.\n${describeScene(copy)}`);
  });

  tool('delete_scene', 'Delete a scene file.', { scene: z.string() }, (a) => {
    ws.removeScene(a.scene, AUTHOR);
    return text(`Deleted scene "${a.scene}".`);
  }, { destructiveHint: true });

  tool(
    'set_tile_layer',
    'Create or change a tile layer: solid (collides), visible, parallax, z (draw order; > 0 draws in front of objects), painted (a ground painted as one picture: no walls are raised from it in 2D-HD), position among the layers, rename, or delete.',
    {
      scene: z.string(),
      layer: z.string(),
      new_name: z.string().optional(),
      solid: z.boolean().optional(),
      visible: z.boolean().optional(),
      parallax: z.number().optional(),
      z: z.number().optional(),
      painted: z.boolean().optional().describe('Ground painted as one picture: 2D-HD raises no walls from its tiles (objects stand up instead; hdCells still apply)'),
      move_to: z.number().int().min(0).optional().describe('New position in the layer list (0 = drawn first)'),
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
        if (a.painted !== undefined) {
          if (a.painted) l.painted = true;
          else delete l.painted;
        }
        if (a.move_to !== undefined) {
          s.layers.splice(s.layers.indexOf(l), 1);
          s.layers.splice(Math.min(a.move_to, s.layers.length), 0, l);
        }
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
        group: z.string().optional().describe('Named group inside the scene (scene_group works on all of it at once)'),
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
          s.instances.push({ id, object: i.object, x, y, ...(i.name ? { name: i.name } : {}), ...(i.sprite ? { sprite: i.sprite } : {}), ...(i.animation ? { animation: i.animation } : {}), ...(i.props ? { props: i.props } : {}), ...(i.components ? { components: i.components as Record<string, Record<string, Value>> } : {}), ...(i.flip_x ? { flipX: true } : {}), ...(normalizeTags(i.tags) ? { tags: normalizeTags(i.tags) } : {}), ...(i.active_if?.trim() ? { activeIf: checkedExpr(i.active_if) } : {}), ...(i.light ? { light: normalizeLight(i.light, true) } : {}), ...(i.group ? { group: i.group } : {}) });
        }
      });
      return text(`Placed ${ids.length} instance(s): ${ids.join(', ')}. Scene now has ${scene.instances.length}.`);
    },
  );

  tool(
    'update_instances',
    'Move, flip, rename, re-skin (sprite override), change the object type or props (e.g. dialogue) of, or remove instances in a scene (by id, or every instance of an object type).',
    {
      scene: z.string(),
      ids: z.array(z.string()).optional(),
      object: z.string().optional().describe('Apply to all instances of this object type'),
      new_object: z.string().optional().describe('Turn the instances into this object type (position, name and overrides are kept)'),
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
      group: z.string().nullable().optional().describe('Named group (null clears)'),
      light: lightSchema.nullable().optional().describe('Light override (radius 0 = off, null = the object type\'s)'),
      hitbox: z.object({ x: z.number(), y: z.number(), w: z.number().min(1), h: z.number().min(1) }).nullable().optional().describe('Collision box of these instances, relative to each (over the object type\'s; also used for the y-sort and the 2D-HD foot). null = the object type\'s'),
      props: z.record(z.string(), z.union([valueSchema, z.null()])).optional(),
      components: z.record(z.string(), z.union([z.record(z.string(), z.union([valueSchema, z.null()])), z.null()])).optional().describe('Component params by component name (merged; null value deletes a param, null component removes the override)'),
    },
    (a) => {
      let n = 0;
      if (a.new_object && !ws.loadGame().objects.some((o) => o.name === a.new_object)) throw new Error(`No object type "${a.new_object}"`);
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
          if (a.new_object) i.object = a.new_object;
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
          if (a.group !== undefined) {
            if (a.group) i.group = a.group;
            else delete i.group;
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
          if (a.hitbox !== undefined) {
            if (a.hitbox === null) delete i.hitbox;
            else i.hitbox = { x: a.hitbox.x, y: a.hitbox.y, w: a.hitbox.w, h: a.hitbox.h };
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
    view: z.enum(['2d', 'plan', 'hd']).optional().describe('2d (default): the flat map. plan: a schematic of rooms, walls, water and what stands where, with names and problems in red. hd: through the real 2D-HD perspective camera, headless'),
    at: z.tuple([z.number(), z.number()]).optional().describe('hd: the tile in the middle of the view (default: where the camera starts)'),
    size: z.tuple([z.number().int().min(64).max(2400), z.number().int().min(64).max(1600)]).optional().describe('hd: the view in pixels (default: the game screen). Larger shows more of the map'),
    effects: z.boolean().optional().describe('hd: also bloom, depth of field and haze (default off: to judge the shape of the place)'),
  }, (a) => {
    const loaded = loadGameBundle(ws);
    if (a.view === 'plan') return [...text(`Plan of "${a.scene}".`), image(renderPlan(ws.loadScene(a.scene), loaded.sheets, undefined, undefined, 18, ws.loadGame().tilesets?.[ws.loadScene(a.scene).tileset ?? '']))];
    if (a.view === 'hd') {
      const hd = renderSceneHd(loaded, a.scene, { at: a.at as [number, number] | undefined, size: a.size as [number, number] | undefined, scale: a.scale, vars: a.vars as Record<string, Value> | undefined, effects: a.effects });
      return [...text(`Scene "${a.scene}" in 2D-HD, ${hd.width}x${hd.height}px.`), image(hd.png)];
    }
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
      hd: z.boolean().optional().describe('Screenshots with auto 2D-HD on'),
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
        onSample: a.screenshots ? (w) => shots.push(renderViewport(w, loaded.sheets, scale, a.hd)) : undefined,
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
      return [...text(lines.join('\n')), ...shots.map(image), image(renderViewport(r.world, loaded.sheets, scale, a.hd))];
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
    ws.writeScript(name, code, AUTHOR);
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
      const r = addLibraryComponents(ws, a.names, AUTHOR);
      return text(`${r.created.length ? `Created ${r.created.map((p) => `scripts/${p}.js`).join(', ')}.` : 'Nothing new to create.'}${r.existing.length ? ` Already in the project: ${r.existing.join(', ')}.` : ''}\n${scriptSummary()}`);
    },
  );

  tool('move_script', 'Move or rename a script or a whole folder (e.g. "Patrol" → "enemies/Patrol", "enemies" → "monsters"). When a component file is renamed, its class name and every reference (objects, instances, scene/game components, events) follow.', { from: z.string(), to: z.string() }, (a) => {
    const isFile = ws.scriptExists(a.from);
    const before = isFile ? [a.from] : ws.listScripts().map((s) => s.name).filter((n) => n.startsWith(a.from + '/'));
    ws.moveScript(a.from, a.to);
    for (const old of before) {
      const now = isFile ? a.to : a.to + old.slice(a.from.length);
      const x = scriptBaseName(old);
      const y = scriptBaseName(now);
      if (x === y) continue;
      const code = ws.readScript(now);
      const renamed = code.replace(new RegExp(`(export\\s+default\\s+class\\s+)${x}\\b`), `$1${y}`);
      if (renamed !== code) ws.writeScript(now, renamed, AUTHOR);
      const game = ws.loadGame();
      const scenes = ws.listScenes().map((sc) => ws.loadScene(sc.name));
      const changed = renameComponentRefs(game, scenes, x, y);
      if (changed.game) ws.saveGame(game, AUTHOR);
      for (const sc of changed.scenes) ws.saveScene(sc, AUTHOR);
    }
    return text(`Moved ${a.from} → ${a.to}.\n${scriptSummary()}`);
  }, { destructiveHint: true });

  tool('create_script_folder', 'Create an empty folder in scripts/ (write_script and move_script create folders by themselves).', { name: z.string().describe('e.g. "enemies" or "ui/menus"') }, (a) => {
    ws.createScriptFolder(a.name);
    return text(`Created scripts/${a.name}/.`);
  });

  tool('delete_script', 'Delete a script file (or a folder with everything in it, with folder: true).', { name: z.string(), folder: z.boolean().optional() }, (a) => {
    if (a.folder) ws.removeScriptFolder(a.name);
    else ws.removeScript(a.name, AUTHOR);
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
    ws.writeDialogue(file, code, AUTHOR);
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

  tool('rename_dialogue', 'Rename a dialogue file. The dialogues inside keep their names, so NPCs that use them are not affected.', { file: z.string(), to: z.string() }, (a) => {
    if (ws.dialogueExists(a.to)) throw new Error(`Dialogue file "${a.to}" already exists`);
    ws.writeDialogue(a.to, ws.readDialogue(a.file), AUTHOR);
    ws.removeDialogue(a.file, AUTHOR);
    return text(`Renamed dialogues/${a.file}.dialogue to ${a.to}.dialogue.\n${dialogueSummary()}`);
  });

  tool('delete_dialogue', 'Delete a dialogue file.', { file: z.string() }, (a) => {
    ws.removeDialogue(a.file, AUTHOR);
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
    'Change part of a data table: upsert rows by id (only the given columns change; null clears a cell), delete rows, add or remove columns, set the description, rename the table.',
    {
      table: z.string(),
      upsert: z.array(z.record(z.string(), cellSchema)).optional().describe('Rows with an "id": existing ids are merged, new ids appended'),
      delete_ids: z.array(z.string()).optional(),
      add_columns: z.array(columnSchema).optional(),
      remove_columns: z.array(z.string()).optional(),
      description: z.string().optional(),
      rename_to: z.string().optional().describe('New table name. db("old", ...) in scripts, events and dialogues is not rewritten'),
    },
    (a) => {
      const t = ws.loadTable(a.table);
      if (a.rename_to && a.rename_to !== a.table) {
        assertIdentifier('data table', a.rename_to);
        if (ws.tableExists(a.rename_to)) throw new Error(`Data table "${a.rename_to}" already exists`);
        t.name = a.rename_to;
      }
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
      if (saved.name !== a.table) ws.removeTable(a.table, AUTHOR);
      return text(`Updated data/${saved.name}.json: ${added} added, ${changed} changed, ${a.delete_ids?.length ?? 0} deleted. ${saved.rows.length} rows, columns ${saved.columns.map((c) => c.name).join(', ')}.`);
    },
  );

  tool('delete_data', 'Delete a data table.', { table: z.string() }, (a) => {
    ws.removeTable(a.table, AUTHOR);
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
      copy_from: z.string().optional().describe('Start as a copy of this effect'),
      nodes: z.array(vfxNodeSchema).optional(),
      edges: z.array(vfxEdgeSchema).optional(),
      preview: z.boolean().optional().describe('Also return the filmstrip'),
    },
    (a) => {
      if (!VFX_NAME_RE.test(a.effect)) throw new Error(`Invalid effect name "${a.effect}". Use letters, digits, "_" and "-".`);
      const tpl = VFX_TEMPLATES.find((t) => t.id === a.template);
      const source = a.copy_from ? ws.loadVfx(a.copy_from) : undefined;
      if (!tpl && !a.nodes && !source) throw new Error('Give nodes (and edges), a template, or copy_from.');
      failOnInputErrors(a.nodes ?? []);
      const out = saveVfxChecked(a.nodes ? { description: a.description ?? tpl?.description, nodes: a.nodes, edges: a.edges ?? [] } : source ? { description: a.description ?? source.description, nodes: source.nodes, edges: source.edges } : { description: a.description ?? tpl?.description, ...tpl!.graph }, a.effect);
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
      if (to !== a.effect) ws.removeVfx(a.effect, AUTHOR);
      return a.preview ? [...out, ...vfxPreview(ws.loadVfx(to))] : out;
    },
  );

  tool('delete_vfx', 'Delete a visual effect.', { effect: z.string() }, (a) => {
    ws.loadVfx(a.effect);
    ws.removeVfx(a.effect, AUTHOR);
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


  // ------------------------------------------------------------------ blueprints

  const problemLines = (p: BpProblem[]) => p.map((x) => `${x.level === 'error' ? 'ERROR' : 'warning'} [${x.code}] ${x.message}`).join('\n');
  const blueprintResult = (scene: string, r: ReturnType<typeof buildBlueprint>, preview: boolean) => {
    const loaded = preview ? loadGameBundle(ws) : null;
    const counts = `${r.problems.filter((p) => p.level === 'error').length} error(s), ${r.problems.filter((p) => p.level === 'warning').length} warning(s)`;
    const head = `${r.wrote ? `Compiled into scene "${scene}".` : `Not written (${r.problems.some((p) => p.level === 'error') ? 'errors' : 'dry run'}).`} ${counts}.${r.absorbed.length ? `\nTaken back from the map: ${r.absorbed.slice(0, 20).join('; ')}.` : ''}`;
    const out = text(`${head}${r.problems.length ? `\n${problemLines(r.problems.slice(0, 80))}` : ''}`);
    if (!loaded) return out;
    const shell = ws.listScenes().some((s) => s.name === scene) ? ws.loadScene(scene) : ({ name: scene } as Scene);
    return [...out, image(renderPlan({ ...shell, blueprint: r.blueprint } as Scene, loaded.sheets, r.blueprint, r.problems, 18, ws.loadGame().tilesets?.[shell.tileset ?? '']))];
  };

  tool('blueprint_reference', 'How to write a blueprint: the description of a map (rooms, passages, water, things on walls and floors) that tiles, collision, 2D-HD walls and instances are compiled from. Read it before writing maps.', {}, () => text(BLUEPRINT_REFERENCE), { readOnlyHint: true });

  tool('read_blueprint', 'The blueprint of a scene, as JSON. With summary: true, spaces, links, water, checks and how many elements each space has.', { scene: z.string(), summary: z.boolean().optional() }, (a) => {
    const bp = currentBlueprint(ws, a.scene)?.blueprint;
    if (!bp) return text(`Scene "${a.scene}" has no blueprint. blueprint_from_scene makes a draft.`);
    if (!a.summary) return text(JSON.stringify(bp));
    const count = (id: string) => bp.elements.filter((e) => e.in === id).length;
    return text(JSON.stringify({ ...bp, spaces: bp.spaces.map((s) => ({ ...s, elements: count(s.id) })), elements: undefined, paint: bp.paint ? Object.keys(bp.paint).length : undefined }));
  }, { readOnlyHint: true });

  tool('write_blueprint', 'Replace the blueprint of a scene and compile it. What is wrong with the map is reported and, if there are errors, nothing is written. Always returns the plan drawing.', {
    scene: z.string(),
    blueprint: z.record(z.string(), z.unknown()),
    dry_run: z.boolean().optional().describe('Only report and draw the plan'),
    force: z.boolean().optional().describe('Write even with errors: only to look at a work in progress'),
  }, (a) => blueprintResult(a.scene, buildBlueprint(ws, a.scene, a.blueprint, { dryRun: a.dry_run, force: a.force, by: AUTHOR }), true));

  tool('edit_blueprint', 'Change part of a blueprint and compile it. Lists are merged by id (links by a+b, checks by name); remove lists ids to take out.', {
    scene: z.string(),
    concept: z.string().optional(),
    size: z.tuple([z.number().int(), z.number().int()]).optional(),
    spaces: z.array(z.record(z.string(), z.unknown())).optional(),
    links: z.array(z.record(z.string(), z.unknown())).optional(),
    water: z.array(z.record(z.string(), z.unknown())).optional(),
    elements: z.array(z.record(z.string(), z.unknown())).optional(),
    checks: z.array(z.record(z.string(), z.unknown())).optional(),
    remove: z.array(z.string()).optional().describe('Ids of spaces, water or elements, names of checks, "a+b" of links'),
    dry_run: z.boolean().optional(),
    force: z.boolean().optional(),
  }, (a) => {
    const current = currentBlueprint(ws, a.scene);
    if (!current) throw new Error(`Scene "${a.scene}" has no blueprint.`);
    const bp = current.blueprint;
    const merge = <T>(list: T[], items: unknown[] | undefined, key: (t: T) => string) => {
      for (const raw of items ?? []) {
        const item = raw as T;
        const n = list.findIndex((x) => key(x) === key(item));
        if (n >= 0) list[n] = { ...list[n], ...item };
        else list.push(item);
      }
    };
    const linkKey = (l: Blueprint['links'][number]) => `${l.a}+${l.b}`;
    merge(bp.spaces, a.spaces, (s) => s.id);
    merge(bp.links, a.links, linkKey);
    merge(bp.water, a.water, (w) => w.id);
    merge(bp.elements, a.elements, (e) => e.id);
    merge(bp.checks, a.checks, (c) => c.name);
    if (a.concept !== undefined) bp.concept = a.concept;
    if (a.size) bp.size = a.size as [number, number];
    const gone = new Set(a.remove ?? []);
    bp.spaces = bp.spaces.filter((s) => !gone.has(s.id));
    bp.water = bp.water.filter((w) => !gone.has(w.id));
    bp.elements = bp.elements.filter((e) => !gone.has(e.id));
    bp.checks = bp.checks.filter((c) => !gone.has(c.name));
    bp.links = bp.links.filter((l) => !gone.has(linkKey(l)));
    return blueprintResult(a.scene, buildBlueprint(ws, a.scene, bp, { dryRun: a.dry_run, force: a.force, by: AUTHOR, absorbed: current.absorbed }), true);
  });

  tool('blueprint_from_scene', 'Draft a blueprint from a scene as it is: spaces cut from its floor, its instances placed in them. The concept and the purpose of each space are left for you to write. Writes nothing unless save: true.', {
    scene: z.string(),
    kit: z.string().describe('An architecture kit, or "painted" for woods, towns and caves whose terrain stays as it is'),
    save: z.boolean().optional().describe('Compile it into the scene (force: even with errors)'),
    force: z.boolean().optional(),
  }, (a) => {
    const bp = draftFromScene(ws, a.scene, a.kit);
    const r = buildBlueprint(ws, a.scene, bp, { dryRun: !a.save, force: a.force, by: AUTHOR });
    return [...blueprintResult(a.scene, r, true), ...text(a.save ? '' : JSON.stringify({ ...bp, elements: `${bp.elements.length} elements` }))];
  });

  tool('rebuild_maps', 'Compile the blueprints of every scene, or of one, from what they say now. What was edited by hand on those maps goes into the blueprint first.', {
    scene: z.string().optional(),
  }, (a) => {
    const names = a.scene ? [a.scene] : ws.listScenes().filter((s) => ws.loadScene(s.name).blueprint).map((s) => s.name);
    const lines: string[] = [];
    for (const n of names) {
      const now = currentBlueprint(ws, n);
      if (!now) {
        lines.push(`${n}: no blueprint`);
        continue;
      }
      const r = buildBlueprint(ws, n, now.blueprint, { by: AUTHOR, absorbed: now.absorbed });
      lines.push(`${n}: ${r.wrote ? 'ok' : 'NOT written'}${r.problems.length ? `\n${problemLines(r.problems.slice(0, 12))}` : ''}`);
    }
    return text(lines.join('\n') || 'No blueprints yet.');
  });

  tool('set_map_kit', 'Define or replace an architecture kit: the sprites blueprints are painted with (wall panel, piers, floor texture, roof, moss, water, dry bed), and the sheet they are baked into.', {
    name: z.string(),
    kit: z.record(z.string(), z.unknown()),
  }, (a) => {
    mutateGame((g) => {
      (g.mapKits ??= {})[a.name] = a.kit as unknown as NonNullable<GameProject['mapKits']>[string];
    });
    return text(`Kit "${a.name}" saved.`);
  });

  tool('validate_game', 'Check the game for problems: unknown triggers/actions/behaviors, bad expressions, missing sprites, objects and scenes, and the map checks: scenes nothing leads to, one-way doors, doors that drop the player outside the map, instances stuck on solid tiles or where the player cannot walk, and the architecture of each map: walls too thin to stand, blocks of wall alone in a floor, big sprites across a passage.', {}, () => {
    const maps = mapReport(ws).problems;
    const arch = architectureReport(ws);
    return text(`${problemsText()}${maps.length ? `\n\nMap checks (${maps.length}), worth a look but sometimes intended:\n${maps.slice(0, 60).map((p) => `- ${p.where}: ${p.message}`).join('\n')}${maps.length > 60 ? `\n... ${maps.length - 60} more` : ''}` : ''}${arch.length ? `\n\nArchitecture (${arch.length}):\n${arch.slice(0, 80).map((p) => `- ${p.where} [${p.code}]: ${p.message}`).join('\n')}${arch.length > 80 ? `\n... ${arch.length - 80} more` : ''}` : ''}`);
  }, { readOnlyHint: true });

  // ------------------------------------------------------------------ project-wide tools

  tool('find_usages', 'Where something is used across the whole project: event sheets, instances, active_if, components, scripts, dialogues, data tables, effects. Variables report reads and writes. Prefer this to searching files.', {
    kind: z.enum(USAGE_KINDS),
    name: z.string().describe('Variable (gold, scene.timer), object type, sprite, scene, dialogue, component, sound, table or effect name'),
    per_place: z.number().int().min(1).max(200).optional().describe('Lines shown per file or scene (default 12)'),
  }, (a) => text(formatUsages(a.kind, a.name, findUsages(loadSources(ws), a.kind, a.name), a.per_place)), { readOnlyHint: true });

  tool('get_editor_context', 'What the person is doing in the editor right now: the open page, scene or sprite, selected instances and tiles, their open notes on the map, and the errors of their last Play. Call it first when they say "this", "here", "questo" or "qui" or report something they just saw.', {}, () => text(formatEditorContext(ws)), { readOnlyHint: true });

  tool('set_note', 'Add a note pinned on a scene (scene, x, y in pixels, text), or answer, resolve, move or delete one by id. Notes appear on the map in the editor, and get_editor_context lists the open ones.', {
    id: z.string().optional().describe('Omit to create a note'),
    scene: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    text: z.string().optional(),
    reply: z.string().optional(),
    resolved: z.boolean().optional(),
    delete: z.boolean().optional(),
  }, (a) => {
    const n = setNote(ws, { ...a, remove: a.delete }, AUTHOR);
    return text(n ? `Saved.\n${formatNotes([n])}` : 'Deleted.');
  });

  tool('get_world_map', 'How the scenes connect: every door, event, script or data entry that leads to a scene, which scenes nothing leads to, and one-way doors.', {}, () => {
    const { world } = mapReport(ws);
    const byScene = world.scenes.map((s) => {
      const out = world.links.filter((l) => l.from === s.name);
      return `${s.name}${s.name === world.start ? ' [start]' : ''}${s.reachable ? '' : ' [nothing leads here]'}${s.scripted ? ' [reached from code]' : ''}: ${[...new Set(out.map((l) => `${l.to} (${l.via})`))].join(', ') || 'no exits'}`;
    });
    const code = world.links.filter((l) => l.from === null);
    return text(`${byScene.join('\n')}${code.length ? `\n\nFrom code and data:\n${code.slice(0, 40).map((l) => `- ${l.to}: ${l.where}`).join('\n')}` : ''}${world.oneWay.length ? `\n\nOne-way doors:\n${world.oneWay.map((l) => `- ${l.from} -> ${l.to} (${l.where})`).join('\n')}` : ''}`);
  }, { readOnlyHint: true });

  // ------------------------------------------------------------------ saved playtests

  const describeTest = (t: GameTest) => `${t.name}: ${t.seconds.toFixed(1)}s, ${t.inputs.length} input(s)${t.scene ? `, from ${t.scene}` : ''}${t.description ? ` — ${t.description}` : ''}\n  expects ${[t.expect.scene && `scene ${t.expect.scene}`, ...(t.expect.exprs ?? []), ...(t.expect.logs ?? []).map((l) => `log "${l}"`), t.expect.noErrors !== false && 'no errors'].filter(Boolean).join('; ') || 'nothing'}`;

  tool('list_tests', 'The saved playtests of the game (tests/*.test.json), recorded in the editor or written with write_test.', {}, () => text(ws.listTests().map(describeTest).join('\n') || 'No tests yet.'), { readOnlyHint: true });

  tool('read_test', 'A saved playtest with its inputs.', { name: z.string() }, (a) => text(JSON.stringify(ws.loadTest(a.name), null, 1)), { readOnlyHint: true });

  tool('write_test', 'Save a playtest that can be run again: the game for some seconds with scripted input, and what must be true at the end. With only name and expect it changes what an existing test expects.', {
    name: z.string(),
    description: z.string().optional(),
    seconds: z.number().min(0.1).max(600).optional(),
    scene: z.string().optional(),
    seed: z.number().int().optional(),
    vars: z.record(z.string(), valueSchema).optional(),
    player_at: z.tuple([z.number(), z.number()]).optional(),
    inputs: z.array(z.object({ at: z.number().min(0), key: z.string().optional(), duration: z.number().min(0).optional(), click: z.tuple([z.number(), z.number()]).optional() })).optional(),
    choices: z.array(z.number().int().min(0)).optional(),
    auto_dialog: z.boolean().optional(),
    expect: z.object({
      scene: z.string().optional().describe('The scene it must end in'),
      exprs: z.array(z.string()).optional().describe('Expressions that must be true at the end: "gold >= 10"'),
      logs: z.array(z.string()).optional().describe('Text that must appear in the log'),
      no_errors: z.boolean().optional().describe('Fail on runtime errors (default true)'),
    }).optional(),
  }, (a) => {
    const old = ws.testExists(a.name) ? ws.loadTest(a.name) : undefined;
    if (!old && a.seconds === undefined) throw new Error('A new test needs seconds');
    const expect = a.expect ? { scene: a.expect.scene, exprs: a.expect.exprs, logs: a.expect.logs, noErrors: a.expect.no_errors } : old?.expect;
    const merged = { ...old, ...Object.fromEntries(Object.entries({ description: a.description, seconds: a.seconds, scene: a.scene, seed: a.seed, vars: a.vars, playerAt: a.player_at, inputs: a.inputs, choices: a.choices, autoDialog: a.auto_dialog }).filter(([, v]) => v !== undefined)), expect };
    return text(`Saved.\n${describeTest(ws.saveTest(normalizeTest(merged, a.name), AUTHOR))}`);
  });

  tool('delete_test', 'Delete a saved playtest.', { name: z.string() }, (a) => {
    ws.removeTest(a.name);
    return text(`Deleted test ${a.name}.`);
  }, { destructiveHint: true });

  tool('run_tests', 'Run the saved playtests (all, or the ones named) and report which passed; a failed one comes with its last log lines and a screenshot of how it ended. Run them after changing maps, scripts or the story.', { names: z.array(z.string()).optional() }, async (a) => {
    const run = await runTests(ws, a.names);
    return [...text(formatTestRun(run.outcomes)), ...run.failed.slice(0, 3).map((f) => image(renderViewport(f.world, run.loaded.sheets, 2)))];
  }, { readOnlyHint: true });

  // ------------------------------------------------------------------ whole parts of a map

  const tileRect = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1), h: z.number().int().min(1) });

  tool('scatter_instances', 'Spread instances at random over a scene or a tile rectangle: trees, rocks, flowers. Deterministic for a seed. The group remembers how it was made, so scene_group regenerate can redo it.', {
    scene: z.string(),
    group: z.string().describe('Name of the group they join, e.g. "trees"'),
    items: z.array(z.object({ object: z.string(), sprite: z.string().optional(), animation: z.string().optional(), weight: z.number().min(0).optional() })).min(1),
    region: tileRect.optional().describe('In tiles; default the whole scene'),
    count: z.number().int().min(1).optional(),
    density: z.number().min(0).optional().describe('Per 100 tiles of the region (default 5)'),
    min_distance: z.number().min(0).optional().describe('Pixels between bases (default one tile)'),
    seed: z.number().int().optional(),
    avoid_solid: z.boolean().optional().describe('Default true'),
    on_tiles: z.object({ layer: z.string(), tiles: z.array(z.number().int()) }).optional().describe('Only on these tiles of a layer'),
    flip: z.boolean().optional().describe('Mirror about half of them'),
    replace: z.boolean().optional().describe('First delete the group as it is'),
    preview: z.boolean().optional(),
  }, (a) => {
    const known = new Set(ws.loadGame().objects.map((o) => o.name));
    for (const i of a.items) if (!known.has(i.object)) throw new Error(`No object type "${i.object}"`);
    const recipe: ScatterRecipe = { items: a.items, ...(a.region ? { region: a.region } : {}), ...(a.count !== undefined ? { count: a.count } : {}), ...(a.density !== undefined ? { density: a.density } : {}), ...(a.min_distance !== undefined ? { minDistance: a.min_distance } : {}), seed: a.seed ?? Math.floor(Math.random() * 1e9), ...(a.avoid_solid === false ? { avoidSolid: false } : {}), ...(a.on_tiles ? { onTiles: a.on_tiles } : {}), ...(a.flip ? { flip: true } : {}) };
    const { scene, result } = mutateScene(a.scene, (s) => {
      if (a.replace) deleteGroup(s, a.group);
      return scatterIntoGroup(s, a.group, recipe, instanceSizes(ws, s.tileSize));
    });
    const out: Content = text(`Placed ${result.length} instance(s) in group "${a.group}" (seed ${recipe.seed}).`);
    if (a.preview) out.push(image(renderScenePreview(loadGameBundle(ws), scene.name, {}).png));
    return out;
  });

  tool('scene_group', 'Work on a named group of instances: list the groups of a scene, regenerate one (redo its scatters, inside their areas), move it, rename it, delete it (with keep_instances only the name goes). Add to a group with place_instances or update_instances group.', {
    scene: z.string(),
    action: z.enum(['list', 'regenerate', 'move', 'rename', 'delete']),
    group: z.string().optional(),
    to: z.string().optional().describe('New name (rename)'),
    dx: z.number().optional(),
    dy: z.number().optional(),
    seed: z.number().int().optional().describe('regenerate: a new layout; omit to keep the same one'),
    keep_instances: z.boolean().optional(),
  }, (a) => {
    if (a.action === 'list') {
      const list = listGroups(ws.loadScene(a.scene));
      return text(list.map((g) => `${g.name}: ${g.count} instance(s)${g.scatters ? `, ${g.scatters} scatter(s)` : ''}`).join('\n') || 'No groups in this scene.');
    }
    const group = a.group;
    if (!group) throw new Error('This action needs group');
    let message = '';
    mutateScene(a.scene, (s) => {
      if (!listGroups(s).some((g) => g.name === group)) throw new Error(`No group "${group}" in ${a.scene}`);
      if (a.action === 'regenerate') message = `Regenerated: ${regenerateGroup(s, group, instanceSizes(ws, s.tileSize), a.seed).length} instance(s).`;
      if (a.action === 'delete') message = `Removed group "${group}" (${deleteGroup(s, group, a.keep_instances)} instance(s)${a.keep_instances ? ' kept' : ''}).`;
      if (a.action === 'rename') {
        if (!a.to) throw new Error('rename needs to');
        renameGroup(s, group, a.to);
        message = `Renamed to "${a.to}".`;
      }
      if (a.action === 'move') {
        let n = 0;
        for (const i of s.instances) if (i.group === group) {
          i.x += a.dx ?? 0;
          i.y += a.dy ?? 0;
          n++;
        }
        message = `Moved ${n} instance(s).`;
      }
    });
    return text(message);
  });

  tool('copy_scene_region', 'Copy a rectangle of a map (tiles of every layer and the instances inside) to another place in the same scene or into another one. Empty cells leave the destination as it is, unless overwrite. Instances get new ids.', {
    scene: z.string(),
    region: tileRect,
    to_scene: z.string().optional().describe('Default: the same scene'),
    x: z.number().int().describe('Destination tile column of the top-left corner'),
    y: z.number().int(),
    tiles: z.boolean().optional().describe('Default true'),
    instances: z.boolean().optional().describe('Default true'),
    layers: z.array(z.string()).optional(),
    group: z.string().optional().describe('Group for the copied instances'),
    overwrite: z.boolean().optional(),
  }, (a) => {
    const stamp = extractRegion(ws.loadScene(a.scene), a.region, { tiles: a.tiles, instances: a.instances, layers: a.layers });
    const { result } = mutateScene(a.to_scene ?? a.scene, (s) => pasteRegion(s, stamp, a.x, a.y, { group: a.group, overwrite: a.overwrite }));
    return text(`Copied ${result.tiles} tile(s) and ${result.instances.length} instance(s).`);
  });

  tool('export_game', 'Export the game as a single self-contained index.html (plays offline, on any static host, or uploaded to itch.io as an HTML5 game). Default folder: <workspace>/export/web/<title>/.', { out_dir: z.string().optional() }, (a) => {
    const r = exportGame(ws, { outDir: a.out_dir });
    return text(`Exported ${r.file} (${(r.bytes / 1024).toFixed(1)} KB, ${r.scenes} scene(s), ${r.sprites} sprite(s)).${r.problems.length ? `\nProblems:\n${r.problems.map((p) => `- ${p.where}: ${p.message}`).join('\n')}` : ''}`);
  });

  tool('export_android', 'Build a signed Android APK of the game: it plays offline and installs on Android 7 or newer. Needs the Android SDK and a JDK on this computer. On-screen controls offer only a stick (arrows), A (action), B (action2) and a run switch (shift) when an object has a run speed, so a game that needs another key must also accept one of those. Set the package, version and icon with set_game. Default folder: <workspace>/export/android/<title>/.', { out_dir: z.string().optional() }, async (a) => {
    const r = await exportAndroid(ws, { outDir: a.out_dir });
    const notes = [...r.warnings.map((w) => `Warning: ${w}`), ...r.problems.map((p) => `- ${p.where}: ${p.message}`)];
    return text(`Exported ${r.file} (${(r.bytes / 1048576).toFixed(1)} MB, package ${r.package}, version ${r.version}, ${r.scenes} scene(s), ${r.sprites} sprite(s)).\nSigning key: ${r.keystore} — back it up: updates to the app need the same key.${notes.length ? `\n${notes.join('\n')}` : ''}`);
  });

  tool('history', 'The shared history of the game: every change to settings, object types, scenes, data tables, effects, scripts and dialogues, made by you or by the person in the editor, newest first. Sprites have their own versions (versions, restore_version).', {
    limit: z.number().int().min(1).max(400).optional().describe('Default 40'),
    author: z.string().optional().describe('"claude" or "editor"'),
    kind: z.enum(['game', 'scene', 'data', 'vfx', 'script', 'dialogue']).optional(),
    name: z.string().optional().describe('Only this scene, table, script...'),
  }, (a) => text(formatHistory(ws.history.list({ ...a, limit: a.limit ?? 40 }))), { readOnlyHint: true });

  tool('undo_game_change', 'Undo changes from the shared history without losing what came after: id undoes that one change (yours or the editor\'s, see history); steps undoes your last changes. Parts edited again since then are kept and reported.', {
    steps: z.number().int().min(1).optional().describe('How many of your own latest changes (default 1)'),
    id: z.string().optional().describe('One change from history'),
  }, (a) => {
    const targets = a.id ? [a.id] : ws.history.list({ author: AUTHOR }).filter((e) => !e.undoneBy && !e.undoOf).slice(0, a.steps ?? 1).map((e) => e.id);
    if (!targets.length) throw new Error('Nothing to undo');
    const lines = targets.map((id) => {
      const { entry, conflicts } = undoChange(ws, id, AUTHOR);
      return `Undid ${entry.kind} ${entry.name}: ${entry.summary}${conflicts.length ? `\n  Kept because they changed again: ${conflicts.slice(0, 8).join(', ')}` : ''}`;
    });
    return text(lines.join('\n'));
  });

  const sign = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' } as const;
  const changeLines = (files: Awaited<ReturnType<typeof gitCommitFiles>>) => files.map((f) => `${sign[f.status]} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path}`).join('\n');

  tool('git_status', 'Version control state of the current game: branch, last version, remote and the files changed since the last version.', {}, async () => {
    const s = await gitStatus(ws.dir);
    if (!s.installed) return text('Git is not installed on this computer.');
    if (!s.enabled) return text(s.parentRepo ? `This folder is versioned by the repository at ${s.parentRepo}.` : 'Version control is not enabled for this game. git_enable turns it on.');
    const remote = s.remote ? `${s.remote} (${s.pushed ? `${s.ahead} to push, ${s.behind} to pull` : 'not pushed yet'})` : 'none';
    return text(`Branch: ${s.branch ?? '(detached)'}\nVersion: ${s.head?.slice(0, 7) ?? '(none)'}\nRemote: ${remote}\n${s.changes.length ? `Changed files (${s.changes.length}):\n${changeLines(s.changes)}` : 'No changes since the last version.'}`);
  }, { readOnlyHint: true });

  tool('git_enable', 'Turn on version control for the current game: creates a git repository in its folder, with a .gitignore for exports and generated files, and a first version.', {}, async () => {
    enableGit(ws.dir);
    const [c] = await gitLog(ws.dir, { limit: 1 });
    return text(`Version control is on for ${ws.dir}. Current version: ${c?.short ?? '(none)'}.`);
  });

  tool('git_commit', 'Save every current change of the game as a new version with a message.', { message: z.string().describe('What changed in this version') }, async (a) => {
    const sha = await gitCommit(ws.dir, a.message);
    return text(`Saved version ${sha.slice(0, 7)}.`);
  });

  tool('git_log', 'List the versions of the game, newest first.', { limit: z.number().int().min(1).max(200).optional(), skip: z.number().int().min(0).optional() }, async (a) => {
    const log = await gitLog(ws.dir, a);
    return text(log.length ? log.map((c) => `${c.short}  ${new Date(c.time).toISOString().slice(0, 16).replace('T', ' ')}  ${c.subject}`).join('\n') : 'No versions yet.');
  }, { readOnlyHint: true });

  tool('git_show', 'List the files a version changed.', { sha: z.string().describe('Version id from git_log') }, async (a) => text(changeLines(await gitCommitFiles(ws.dir, a.sha)) || 'No files changed.'), { readOnlyHint: true });

  tool('git_diff', 'Text diff of one file (scene, script, dialogue, game.json...), in a version or, without sha, since the last version. Sprite pixels are encoded and do not diff usefully.', { path: z.string().describe('Path relative to the game folder'), sha: z.string().optional() }, async (a) => {
    const d = await gitDiff(ws.dir, a.path, a.sha);
    return text(d.text ? d.text + (d.truncated ? '\n[diff truncated]' : '') : 'No differences.');
  }, { readOnlyHint: true });

  tool('git_restore', 'Bring the whole game, or one file with path, back to a version. Uncommitted work is first saved as its own version and the restore is a new version, so nothing is lost.', { sha: z.string().describe('Version id from git_log'), path: z.string().optional().describe('Restore only this file, relative to the game folder') }, async (a) => {
    const r = await gitRestore(ws.dir, a.sha, a.path);
    return text(`${r.commit ? `Restored as version ${r.commit.slice(0, 7)}.` : 'The files already match that version.'}${r.snapshot ? ` Uncommitted work saved in ${r.snapshot.slice(0, 7)}.` : ''}`);
  }, { destructiveHint: true });

  tool('git_remote', 'Set the address (https://, ssh:// or git@host:path) of the remote repository of the game. An empty url disconnects it.', { url: z.string() }, async (a) => {
    await gitSetRemote(ws.dir, a.url);
    return text(a.url.trim() ? `Remote set to ${a.url.trim()}.` : 'Remote disconnected.');
  });

  tool('git_push', 'Upload the versions of the game to its remote repository.', {}, async () => {
    await gitPush(ws.dir);
    return text('Pushed.');
  });

  tool('git_pull', 'Download new versions from the remote repository. Fast-forward only: fails rather than merging if the histories diverged.', {}, async () => {
    await gitPull(ws.dir);
    return text('Up to date with the remote.');
  });
}
