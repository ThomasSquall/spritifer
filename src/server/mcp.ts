import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PALETTES, type RGBA, normalizeHex, parseColor, toHex } from '../core/color.js';
import {
  type Anchor,
  type Facing,
  type PartPose,
  type Pose,
  type PoseGuide,
  type Sprite,
  type SpriteFile,
  addFrame,
  addLayer,
  celBitmap,
  compositeFrame,
  createSprite,
  getCel,
  mergeLayerDown,
  moveFrame,
  moveLayer,
  newId,
  removeFrame,
  removeLayer,
  removeTag,
  resizeCanvas,
  resolveFrame,
  resolveLayer,
  setTag,
} from '../core/sprite.js';
import {
  RIG_LAYER_NAME,
  bakeRig,
  bitmapToView,
  describeRig,
  ensureRig,
  findPart,
  layoutPose,
  renderPose,
  restPose,
  rigFacings,
  topoParts,
  viewKey,
} from '../core/rig.js';
import { type AnimName, type Keyframe, generateAnimation, interpolateKeyframes } from '../core/animate.js';
import { kmeansPalette, pixelize, pixelizeAuto } from '../core/pixelize.js';
import {
  type Mask,
  type ShadeOptions,
  type Shape,
  type Vec,
  darkestColor,
  downscale,
  extractPalette,
  findJaggies,
  findNoisePixels,
  fixPixels,
  generateRamp,
  lintBitmap,
  maskBorder,
  maskCount,
  maskFromBitmap,
  paintArc,
  paintMask,
  selout,
  shadeMask,
  shapeMask,
  type SilhouetteDiff,
  removeBackground,
  silhouetteDiff,
  castShadow,
  shapeCoverage,
  antialiasEdge,
  maskFromCoverage,
  valueAdvice,
  valueStats,
  luminance,
} from '../core/shapes.js';
import { bytesToBase64 } from '../core/base64.js';
import type { Bitmap } from '../core/sprite.js';
import {
  clearRect,
  colorHistogram,
  contentBounds,
  drawGrid,
  ellipsePoints,
  extractRegion,
  floodFill,
  linePoints,
  mirror,
  outline,
  pasteBitmap,
  plot,
  readGrid,
  rectPoints,
  getPixel,
  replaceColor,
  setPixel,
  shift,
  transform,
} from '../core/draw.js';
import { exportSpritesheet, previewPng, referenceBitmap, referenceCoverage, renderBitmapRows, spriteFromPng } from './ops.js';
import { decodePng, encodePng } from './png.js';
import type { Workspace } from './store.js';
import { GAME_INSTRUCTIONS, registerGameTools } from './mcpGame.js';
import { type ProjectInfo, ProjectRegistry, TEMPLATES, defaultProjectsRoot } from './projects.js';

const VERSION = '0.1.0';
const AUTHOR = 'claude';
const HISTORY_LIMIT = 40;

export const INSTRUCTIONS = `Spritifer is a pixel-art and animation editor and a 2D game maker (see MAKING GAMES below). Sprites live as *.sprite.json files in a workspace folder and are shown live in the Spritifer web editor (see editor_url), so the user watches you draw.

Model: a sprite has a fixed canvas (width x height), a palette, layers (index 0 = bottom) and frames (index 0 = first). Each (layer, frame) pair is a "cel" of RGBA pixels. Tags name frame ranges as animations. Coordinates are pixels, origin top-left, x right, y down. Colors: "#rrggbb", "#rrggbbaa", "transparent", palette index "p3", or a ramp shade "skin.2" (set_ramp, 0 = darkest).

READ FIRST — how to reach good quality (typing pixels from imagination gives flat, amateur sprites):

1. Work from an image whenever the user can give one (concept art, a sprite to match, a render). For detailed characters without one, ask for a reference or concept; if there is none, follow the value plan in step 4.
2. Fastest path to quality — CONVERT: pixelize (path, crop to one pose, height in canvas px). It creates a clean pixel-art base on a layer (majority colors, outlines kept, no blur) and sets the sprite reference. Then retouch at pixel level ONLY what conversion cannot resolve: eyes and face (they become blobs below ~80px), hands, broken thin lines, small symbols. Never repaint whole areas, recolor the palette or redraw the figure over a pixelized base: the converted shading, values and clusters are what make it look hand-made, and redrawing them makes the sprite flatter and worse.
3. Drawing your own (original design or redraw):
   a. set_reference with remove_background (crop one pose), then pose_guide: trace the reference joints (preview compare: true, guide: true) before drawing.
   b. Separate layers, back to front: hair_back, back (far arm, capes), legs, body, head, shield/props, front (near arm + weapon). They can later be cut into rig parts.
   c. set_ramp per material (skin, hair, cloth, leather, metal...). Block in with draw_shapes, reading coordinates from preview rulers: capsules for limbs, ellipses for heads, polygons for spikes/plates, closed splines for hair locks and capes.
   d. Shade with ramps: shade mode "form" for round volumes (heads, limbs, shields) and "cel" for flat planes; cast_shadow where one form lies over another (hair over face, head over neck, arm over torso); aa on internal edges between materials. Then selout.
   e. Small features (eyes, mouth, glints, thin bands, straps under 4px) by hand with draw_pixels, no outline.
4. Values decide whether a sprite reads. At 64px aim for roughly half dark pixels, ~40% mids, ~10% lights; desaturated bases, few bright highlights, the darkest shade of each ramp clearly lighter than the outline. silhouette_check reports this ("Values") with advice.
5. Check loop after every pass, never on a single look: preview (compare: true, region to zoom), silhouette_check (follow ADD / TRIM regions, edge table, Values, Colors), lint (fix near-duplicate colors, low contrast, outline doubles, jaggies; cleanup removes jaggies). Aim for overlap ≥ 85% and no value advice when matching a reference.

Refining without making it worse:
- Every silhouette_check saves a scored version. If it says "WORSE than your best version", restore_version that version unless the pass added something you need (versions lists them; save_version before risky edits).
- Make small, local edits (a few pixels to a small region per pass) and re-check after each one. If an edit does not improve the numbers or the zoomed preview, undo it.
- lint is a list of candidates, not a goal: fix real defects (near-duplicate colors, stray pixels, jaggies) locally; do not change the style to silence it. Its outline notes assume a closed dark outline and do not apply to pixelized or painterly art.
- Stop when overlap ≥ 85% (when matching a reference), values match, the face reads at 1x, and lint shows no real defects. More passes after that usually make the sprite worse. Then show the user the result and ask before further changes.

Known pitfalls:
- draw_pixels legend: one letter = one color. Reusing a letter for a different meaning silently paints the wrong color.
- draw_shapes line width: 1 draws a crisp pixel-perfect line; non-integer widths like 1.5 rasterize about 2px wide (blobs). Parts thinner than ~4px drawn with an outline become all outline: draw them by hand.
- silhouette_check colors compare zones, so where the reference has a different material (hair over a cheek) it shows as a color error: read it together with the image.
- The Values in silhouette_check are about the figure as a whole; fix them by changing ramps and shadow shapes, not by darkening everything.

Game characters (top-down, 4 facings) — use the cut-out rig, not frame-by-frame redrawing:
1. create_character (32x32 to 64x64; 48x48 is a good default).
2. rig_part for each body part (body, head, arm_l, arm_r, leg_l, leg_r, plus weapon, cape, hair, shadow): draw "down" first, check with rig_preview, then "right" and "up"; "left" mirrors "right". rig_part can also cut parts out of existing art (from), e.g. a pixelized or hand-drawn character on separate layers. Add variants like head "blink" / "hurt".
3. rig_animate idle, walk, run, attack, hurt: frames, tags (<anim>_<facing>), timing and secondary motion for every facing. rig_keyframes for custom animations (jump, combos) from a few key poses with easing; sx/sy for squash & stretch.
4. preview with tags=[...] and onion/diff to check motion; tweak frames with rig_pose; fix a part once with rig_part and every frame updates.
5. export_spritesheet layout "tags".
The rig layer is re-rendered from the rig: put hand-drawn effects on another layer. Weapon smears come from the rig (smear in rig_pose; rig_animate attack adds them).

Static frame-by-frame animation: add_frames with copy_from, edit only what moves (transform shift, redraw limbs), set_tag, set_frame_duration, preview with tag + onion, export_spritesheet.

Environments / tilesets: create_sprite with tile_width/tile_height, draw each tile (draw_pixels with "tile", or draw_shapes), then build scenes on a bigger canvas with copy_region (source_sprite = the tileset). Separate layers for background, terrain, props.

Every change is saved immediately; undo reverts your own recent changes.`;

type Content = CallToolResult['content'];

/** Builds an MCP server exposing drawing tools over a workspace. */
export function createMcpServer(ws: Workspace, opts: { editorUrl?: () => string | undefined; registry?: ProjectRegistry } = {}): McpServer {
  const server = new McpServer({ name: 'spritifer', version: VERSION }, { instructions: INSTRUCTIONS + '\n' + GAME_INSTRUCTIONS });
  const history = new Map<string, string[]>();

  // ------------------------------------------------------------------ helpers

  const remember = (name: string, file: SpriteFile | null) => {
    const stack = history.get(name) ?? [];
    stack.push(file ? JSON.stringify(file) : 'null');
    if (stack.length > HISTORY_LIMIT) stack.shift();
    history.set(name, stack);
  };

  /** Loads, snapshots for undo, applies `fn`, saves. */
  const mutate = <T>(name: string, fn: (s: Sprite) => T): { sprite: Sprite; result: T } => {
    const raw = ws.readRaw(name);
    const sprite = ws.load(name);
    const result = fn(sprite);
    remember(name, raw);
    ws.save(sprite, AUTHOR);
    return { sprite, result };
  };

  /** Colors: hex, "transparent", palette index ("p3") or ramp shade ("skin.2", 0 = darkest). */
  const color = (s: Sprite | undefined, c: string): RGBA => {
    const m = /^([A-Za-z_][\w-]*)\.(\d+)$/.exec(c.trim());
    if (m && s?.ramps[m[1]]) {
      const ramp = s.ramps[m[1]];
      const i = Number(m[2]);
      if (i >= ramp.length) throw new Error(`Ramp "${m[1]}" has ${ramp.length} shades (0..${ramp.length - 1})`);
      return parseColor(ramp[i]);
    }
    return parseColor(c, s?.palette);
  };

  const text = (t: string): Content => [{ type: 'text', text: t }];

  const image = (png: Buffer): Content[number] => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

  const withPreview = (content: Content, sprite: Sprite, frame: number | undefined, want?: boolean): Content =>
    want ? [...content, image(previewPng(sprite, { frames: [frame ?? 0], pixelGrid: true, rulers: true }))] : content;

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Content | Promise<Content>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return { content: await handler(args) };
      } catch (err) {
        return { isError: true, content: text(`Error: ${err instanceof Error ? err.message : String(err)}`) };
      }
    }) as never);
  };

  // Common params.
  const P = {
    sprite: z.string().describe('Sprite name'),
    frame: z.number().int().min(0).optional().describe('Frame index (default 0)'),
    layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Layer index (0 = bottom) or name (default: top layer)'),
    color: z.string().describe('"#rrggbb", "#rrggbbaa", "transparent" or palette index like "p3"'),
    preview: z.boolean().optional().describe('Also return a zoomed preview image of the frame'),
  };

  const cel = (s: Sprite, frame?: number, layer?: number | string) => {
    const f = resolveFrame(s, frame);
    const l = resolveLayer(s, layer);
    return { bmp: celBitmap(s, l.id, f.id), layer: l, frameIndex: frame ?? 0 };
  };

  /** Summary of a sprite; the palette is only listed when asked (it is long). */
  const describe = (s: Sprite, withPalette = false) => {
    const lines = [
      `Sprite "${s.name}": ${s.width}x${s.height}px, ${s.frames.length} frame(s), ${s.layers.length} layer(s)${s.grid ? `, tile grid ${s.grid.width}x${s.grid.height}` : ''}`,
      withPalette ? `Palette (${s.palette.length}): ${s.palette.map((c, i) => `p${i}=${c}`).join(' ')}` : `Palette: ${s.palette.length} colors (see get_sprite)`,
      `Layers (bottom → top): ${s.layers.map((l, i) => `[${i}] ${l.name}${l.visible ? '' : ' (hidden)'}${l.opacity < 1 ? ` opacity ${l.opacity}` : ''}`).join(', ')}`,
      `Frames: ${s.frames
        .map((f, i) => {
          const filled = s.layers.filter((l) => getCel(s, l.id, f.id)?.some((v, k) => k % 4 === 3 && v > 0)).length;
          return `[${i}] ${f.duration}ms${filled ? '' : ' (empty)'}`;
        })
        .join(', ')}`,
      `Tags: ${s.tags.length ? s.tags.map((t) => `${t.name} ${t.from}-${t.to} ${t.direction}`).join(', ') : 'none'}`,
    ];
    if (s.rig) lines.push(describeRig(s));
    return lines.join('\n');
  };

  // ------------------------------------------------------------------ sprites

  tool('list_sprites', 'List the sprites in the workspace.', {}, () => {
    const list = ws.list();
    if (!list.length) return text(`No sprites yet in ${ws.dir}. Use create_sprite.`);
    return text(list.map((s) => `${s.name}: ${s.width}x${s.height}, ${s.frames} frames, ${s.layers} layers${s.tags.length ? `, tags: ${s.tags.join(', ')}` : ''}`).join('\n'));
  }, { readOnlyHint: true });

  tool(
    'create_sprite',
    `Create a new sprite (character, item, tileset or scene). Built-in palettes: ${Object.keys(PALETTES).join(', ')}.`,
    {
      name: z.string().describe('Unique name: letters, digits, "-" and "_"'),
      width: z.number().int().min(1).max(2048),
      height: z.number().int().min(1).max(2048),
      palette: z.union([z.array(z.string()), z.string()]).optional().describe('Array of colors or a built-in palette name (default endesga32)'),
      tile_width: z.number().int().min(1).optional().describe('Tile grid width, for tilesets and environments'),
      tile_height: z.number().int().min(1).optional(),
      frame_duration: z.number().int().min(1).optional().describe('Default frame duration in ms (default 100)'),
      overwrite: z.boolean().optional().describe('Replace an existing sprite with the same name'),
    },
    (a) => {
      const existed = ws.exists(a.name);
      if (existed && !a.overwrite) throw new Error(`Sprite "${a.name}" already exists (pass overwrite: true to replace it)`);
      const tw = a.tile_width ?? a.tile_height;
      const th = a.tile_height ?? a.tile_width;
      const sprite = createSprite({
        name: a.name,
        width: a.width,
        height: a.height,
        palette: a.palette,
        grid: tw && th ? { width: tw, height: th } : null,
        frameDuration: a.frame_duration,
      });
      remember(a.name, existed ? ws.readRaw(a.name) : null);
      ws.save(sprite, AUTHOR);
      return text(`Created.\n${describe(sprite, true)}`);
    },
  );

  tool('get_sprite', 'Describe a sprite: size, palette, layers, frames, tags, and colors used.', { sprite: P.sprite }, (a) => {
    const s = ws.load(a.sprite);
    const used = colorHistogram(compositeFrame(s, 0)).slice(0, 24);
    return text(`${describe(s, true)}\nColors used in frame 0: ${used.map((u) => `${u.color}×${u.count}`).join(' ') || 'none'}`);
  }, { readOnlyHint: true });

  tool('delete_sprite', 'Delete a sprite file (can be undone with undo in this session).', { sprite: P.sprite }, (a) => {
    remember(a.sprite, ws.readRaw(a.sprite));
    ws.remove(a.sprite);
    return text(`Deleted "${a.sprite}".`);
  }, { destructiveHint: true });

  tool('duplicate_sprite', 'Copy a sprite under a new name (e.g. to make a recolored variant).', { sprite: P.sprite, new_name: z.string() }, (a) => {
    if (ws.exists(a.new_name)) throw new Error(`Sprite "${a.new_name}" already exists`);
    const s = ws.load(a.sprite);
    s.name = a.new_name;
    remember(a.new_name, null);
    ws.save(s, AUTHOR);
    return text(`Duplicated "${a.sprite}" as "${a.new_name}".`);
  });

  tool(
    'set_palette',
    'Replace or extend the sprite palette. Palette entries can then be referenced as "p<index>".',
    { sprite: P.sprite, colors: z.array(z.string()).describe('Colors, or a single built-in palette name'), mode: z.enum(['replace', 'append']).optional() },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => {
        const colors = a.colors.length === 1 && PALETTES[a.colors[0]] ? PALETTES[a.colors[0]] : a.colors.map(normalizeHex);
        s.palette = a.mode === 'append' ? [...s.palette, ...colors.filter((c) => !s.palette.includes(c))] : [...colors];
      });
      return text(`Palette (${sprite.palette.length}): ${sprite.palette.map((c, i) => `p${i}=${c}`).join(' ')}`);
    },
  );

  tool(
    'resize_canvas',
    'Change the canvas size of every frame/layer. Existing pixels are kept, positioned by anchor.',
    {
      sprite: P.sprite,
      width: z.number().int().min(1).max(2048),
      height: z.number().int().min(1).max(2048),
      anchor: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right']).optional().describe('Default center'),
    },
    (a) => {
      mutate(a.sprite, (s) => {
        resizeCanvas(s, a.width, a.height, (a.anchor ?? 'center') as Anchor);
        bakeRig(s);
      });
      return text(`Canvas is now ${a.width}x${a.height}.`);
    },
  );

  // ------------------------------------------------------------------ layers

  tool('add_layer', 'Add a layer (e.g. "outline", "shading", "background", "props").', {
    sprite: P.sprite,
    name: z.string().optional(),
    index: z.number().int().min(0).optional().describe('Insert position (default: on top)'),
  }, (a) => {
    const { result: layer, sprite } = mutate(a.sprite, (s) => addLayer(s, a.name, a.index));
    return text(`Added layer "${layer.name}" at index ${sprite.layers.indexOf(sprite.layers.find((l) => l.id === layer.id)!)}.\n${describe(sprite)}`);
  });

  tool('update_layer', 'Rename, show/hide, change opacity or reorder a layer.', {
    sprite: P.sprite,
    layer: z.union([z.number().int().min(0), z.string()]),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    move_to: z.number().int().min(0).optional().describe('New index (0 = bottom)'),
  }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => {
      const l = resolveLayer(s, a.layer);
      if (a.name !== undefined) l.name = a.name;
      if (a.visible !== undefined) l.visible = a.visible;
      if (a.opacity !== undefined) l.opacity = a.opacity;
      if (a.move_to !== undefined) moveLayer(s, l.id, a.move_to);
    });
    return text(describe(sprite));
  });

  tool('delete_layer', 'Delete a layer and its pixels.', { sprite: P.sprite, layer: z.union([z.number().int().min(0), z.string()]) }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => removeLayer(s, resolveLayer(s, a.layer).id));
    return text(describe(sprite));
  }, { destructiveHint: true });

  tool('merge_layer_down', 'Merge a layer into the layer below it.', { sprite: P.sprite, layer: z.union([z.number().int().min(0), z.string()]) }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => mergeLayerDown(s, resolveLayer(s, a.layer).id));
    return text(describe(sprite));
  });

  // ------------------------------------------------------------------ frames & tags

  tool(
    'add_frames',
    'Add animation frames. Use copy_from to duplicate an existing frame and then modify only what changes.',
    {
      sprite: P.sprite,
      count: z.number().int().min(1).max(256).optional().describe('How many frames to add (default 1)'),
      index: z.number().int().min(0).optional().describe('Insert position (default: at the end)'),
      copy_from: z.number().int().min(0).optional().describe('Frame index whose pixels are copied into the new frames'),
      duration: z.number().int().min(1).optional().describe('Duration in ms'),
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const added: number[] = [];
        let at = a.index ?? s.frames.length;
        let src = a.copy_from;
        for (let i = 0; i < (a.count ?? 1); i++) {
          addFrame(s, at, { duration: a.duration, copyFrom: src });
          added.push(at);
          // Inserting before the source shifts it.
          if (src !== undefined && at <= src) src++;
          at++;
        }
        return added;
      });
      return text(`Added frame(s) ${result.join(', ')}.\n${describe(sprite)}`);
    },
  );

  tool('delete_frames', 'Delete frames by index.', { sprite: P.sprite, frames: z.array(z.number().int().min(0)).min(1) }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => {
      for (const f of [...new Set(a.frames)].sort((x, y) => y - x)) removeFrame(s, f);
    });
    return text(describe(sprite));
  }, { destructiveHint: true });

  tool('move_frame', 'Move a frame to another position.', { sprite: P.sprite, from: z.number().int().min(0), to: z.number().int().min(0) }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => moveFrame(s, a.from, a.to));
    return text(describe(sprite));
  });

  tool('set_frame_duration', 'Set how long frames are displayed (ms).', {
    sprite: P.sprite,
    duration: z.number().int().min(1),
    frames: z.array(z.number().int().min(0)).optional().describe('Frame indices (default: all frames)'),
    tag: z.string().optional().describe('Or: all frames of this tag'),
  }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => {
      let idx = a.frames ?? s.frames.map((_, i) => i);
      if (a.tag) {
        const t = s.tags.find((x) => x.name === a.tag);
        if (!t) throw new Error(`No tag named "${a.tag}"`);
        idx = [];
        for (let i = t.from; i <= t.to; i++) idx.push(i);
      }
      for (const i of idx) resolveFrame(s, i).duration = a.duration;
    });
    return text(describe(sprite));
  });

  tool('set_tag', 'Create or update an animation tag covering frames from..to (inclusive).', {
    sprite: P.sprite,
    name: z.string().describe('e.g. "idle", "walk", "attack"'),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    direction: z.enum(['forward', 'reverse', 'pingpong']).optional(),
  }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => setTag(s, { name: a.name, from: a.from, to: a.to, direction: a.direction }));
    return text(describe(sprite));
  });

  tool('delete_tag', 'Delete an animation tag (frames are kept).', { sprite: P.sprite, name: z.string() }, (a) => {
    const { sprite } = mutate(a.sprite, (s) => removeTag(s, a.name));
    return text(describe(sprite));
  });

  // ------------------------------------------------------------------ character rig

  const facingEnum = z.enum(['down', 'left', 'right', 'up']);
  const partPoseSchema = z.object({
    dx: z.number().optional().describe('Screen pixels right (negative = left)'),
    dy: z.number().optional().describe('Screen pixels down (negative = up)'),
    rot: z.number().optional().describe('Degrees clockwise around the pivot; children rotate along'),
    variant: z.string().optional().describe('Use this drawing variant (e.g. "blink", "hurt", "fist")'),
    hide: z.boolean().optional(),
    z: z.number().optional().describe('Draw order override for this frame'),
    smear: z.number().optional().describe('Motion smear: degrees of rotation to trail back toward (e.g. 90 after a fast clockwise swing). Draws this part\'s children (e.g. the weapon) as a solid arc'),
    smearColor: z.string().optional(),
    sx: z.number().optional().describe('Horizontal scale of this part around its pivot (squash & stretch), default 1'),
    sy: z.number().optional().describe('Vertical scale, default 1'),
  });

  /** Renders rest (or overridden) poses of the given facings side by side, optionally marking pivots. */
  const rigTurnaround = (s: Sprite, facings: Facing[], parts: Record<string, PartPose> = {}, showPivots = false, scale?: number) => {
    const bitmaps = facings.map((facing) => {
      const pose: Pose = { facing, parts };
      const bmp = renderPose(s, pose);
      if (showPivots) {
        for (const p of layoutPose(s, pose)) if (p.view && !p.hidden) setPixel(bmp, Math.round(p.x), Math.round(p.y), [255, 0, 255, 255]);
      }
      return bmp;
    });
    return image(encodePng(renderBitmapRows(s, [bitmaps], { scale, pixelGrid: true, rulers: true }).image));
  };

  /** Replaces (or creates) the frames of a tag with posed frames. A fresh character's lone rest frame is reused. */
  const writeTagFrames = (s: Sprite, tagName: string, poses: Pose[], durations: number[], direction: 'forward' | 'pingpong' = 'forward') => {
    const reuseRest = s.tags.length === 0 && s.frames.length === 1;
    const existing = s.tags.find((t) => t.name === tagName);
    const at = existing ? existing.from : s.frames.length;
    poses.forEach((pose, i) => {
      const f = addFrame(s, at + i, { duration: durations[i] });
      f.pose = pose;
    });
    if (existing) {
      // addFrame already shifted the old tag past the inserted frames; drop its frames.
      const { from: oldFrom, to: oldTo } = existing;
      for (let i = oldTo; i >= oldFrom; i--) removeFrame(s, i);
    }
    if (reuseRest) removeFrame(s, 0);
    const from = s.frames.findIndex((f) => f.pose === poses[0]);
    setTag(s, { name: tagName, from, to: from + poses.length - 1, direction });
  };

  const facingsOf = (s: Sprite, wanted?: Facing[]) => {
    const available = rigFacings(s);
    const list = wanted?.length ? wanted : available.length ? available : (['down'] as Facing[]);
    return list;
  };

  tool(
    'create_character',
    `Start a game character built from a cut-out rig (top-down, 4 facings: down, left, right, up). Creates the sprite, a "rig" layer and a rest-pose frame.
Then: rig_part for each body part (start with the "down" facing, then "right" and "up"; "left" is mirrored from "right" automatically), rig_preview to check the turnaround, rig_animate to generate idle/walk/run/attack/hurt for every facing, preview with tags to check, export_spritesheet layout "tags".
Conventional part names (templates animate these): body (root, pivot at the hips), head (child of body, pivot at the neck), arm_l/arm_r (children of body, pivot at the shoulder), leg_l/leg_r (roots, pivot at the hip joint), weapon (child of an arm, pivot at the grip), shadow (root), and secondary parts that trail behind motion: cape*, cloak*, hair*, scarf*, tail*, ear*. "_l"/"_r" are the character's own sides: facing down, arm_r is on the screen left.
Good sizes: 32x32 (small, chunky), 48x48 (detailed), 64x64 (large). Leave ~4px margin around the character for motion.`,
    {
      name: z.string(),
      width: z.number().int().min(8).max(256).optional().describe('Default 48'),
      height: z.number().int().min(8).max(256).optional().describe('Default 48'),
      palette: z.union([z.array(z.string()), z.string()]).optional().describe('Array of colors or a built-in palette name (default endesga32)'),
      overwrite: z.boolean().optional(),
    },
    (a) => {
      const existed = ws.exists(a.name);
      if (existed && !a.overwrite) throw new Error(`Sprite "${a.name}" already exists (pass overwrite: true to replace it)`);
      const sprite = createSprite({ name: a.name, width: a.width ?? 48, height: a.height ?? 48, palette: a.palette, frameDuration: 200 });
      sprite.layers[0].name = RIG_LAYER_NAME;
      sprite.rig = { layer: sprite.layers[0].id, parts: [] };
      sprite.frames[0].pose = restPose('down');
      remember(a.name, existed ? ws.readRaw(a.name) : null);
      ws.save(sprite, AUTHOR);
      return text(`Created character.\n${describe(sprite, true)}`);
    },
  );

  tool(
    'rig_part',
    `Create or update one drawing of a rig part (for one facing, optionally a named variant). Every posed frame is re-rendered, so fixing a part fixes the whole animation.
Draw the part on its own small grid with "rows" + "legend" (same format as draw_pixels; "." = transparent), or cut it from existing art with "from".
pivot = the joint pixel inside the part grid (rotation center). at = where that pivot goes: canvas coordinates for root parts (no parent), offset from the parent's pivot for child parts. z = draw order for this facing (higher is in front; e.g. facing down: leg 1, body 2, arm 3, head 4; facing up the arms go behind the body and the cape in front).
Omit rows/from to only change pivot/at/z/parent of an existing drawing. Variants (e.g. "blink", "hurt") inherit at and z from the base drawing.
Tips: give limbs a 1px overlap with the body so joints never open when rotating; outline each part in the dark outline color; keep pivots on the joint, not the part's corner.`,
    {
      sprite: P.sprite,
      name: z.string().describe('Part name, e.g. body, head, arm_l, leg_r, weapon, cape'),
      facing: facingEnum,
      variant: z.string().optional(),
      parent: z.string().nullable().optional().describe('Parent part name, or null for a root part (sets the part hierarchy for all facings)'),
      rows: z.array(z.string()).optional(),
      legend: z.record(z.string(), z.string()).optional(),
      from: z
        .object({ frame: z.number().int().min(0).optional(), layer: z.union([z.number().int().min(0), z.string()]).optional(), x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) })
        .optional()
        .describe('Cut the part out of existing pixels (layer default: composite of visible layers)'),
      pivot: z.tuple([z.number().int(), z.number().int()]).optional().describe('[x, y] inside the part grid'),
      at: z.tuple([z.number().int(), z.number().int()]).optional(),
      z: z.number().optional(),
      preview: z.boolean().optional().describe('Return the turnaround with pivots marked in magenta (default true)'),
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const rig = ensureRig(s);
        let part = rig.parts.find((p) => p.name === a.name);
        if (!part) {
          part = { name: a.name, parent: null, views: {} };
          rig.parts.push(part);
        }
        if (a.parent !== undefined) {
          if (a.parent !== null) findPart(rig, a.parent);
          if (a.parent === a.name) throw new Error('A part cannot be its own parent');
          part.parent = a.parent;
          topoParts(rig); // throws on cycles
        }
        const key = viewKey(a.facing, a.variant);
        const prev = part.views[key];
        let bmp: Bitmap | undefined;
        if (a.rows) {
          if (!a.legend) throw new Error('rows need a legend');
          const legend: Record<string, RGBA> = {};
          for (const [k, v] of Object.entries(a.legend)) {
            if (Array.from(k).length !== 1) throw new Error(`Legend keys must be single characters (got "${k}")`);
            legend[k] = color(s, v);
          }
          const w = Math.max(...a.rows.map((r) => Array.from(r).length));
          bmp = { width: w, height: a.rows.length, data: new Uint8ClampedArray(w * a.rows.length * 4) };
          drawGrid(bmp, 0, 0, a.rows, legend);
        } else if (a.from) {
          const f = a.from;
          const src = f.layer !== undefined ? celBitmap(s, resolveLayer(s, f.layer).id, resolveFrame(s, f.frame).id) : compositeFrame(s, f.frame ?? 0);
          bmp = extractRegion(src, f);
        }
        if (bmp) {
          const pivot = a.pivot ?? prev?.pivot;
          if (!pivot) throw new Error('A new drawing needs a pivot [x, y] (the joint pixel inside the part grid)');
          part.views[key] = bitmapToView(bmp, pivot, a.at ?? prev?.at, a.z ?? prev?.z);
        } else {
          if (!prev) throw new Error(`Part "${a.name}" has no "${key}" drawing yet: pass rows+legend or from`);
          if (a.pivot) prev.pivot = a.pivot;
          if (a.at) prev.at = a.at;
          if (a.z !== undefined) prev.z = a.z;
        }
        if (!a.variant && !part.views[key].at) part.views[key].at = [0, 0];
        if (!s.frames.some((f) => f.pose)) s.frames[0].pose = restPose(a.facing);
        return bakeRig(s);
      });
      const out = text(`Part "${a.name}" ${viewKey(a.facing, a.variant)} saved; re-rendered ${result} posed frame(s).\n${describeRig(sprite)}`);
      if (a.preview === false) return out;
      return [...out, rigTurnaround(sprite, facingsOf(sprite), a.variant ? { [a.name]: { variant: a.variant } } : {}, true)];
    },
  );

  tool(
    'rig_remove_part',
    'Delete a rig part, or only one of its drawings (facing + optional variant).',
    { sprite: P.sprite, name: z.string(), facing: facingEnum.optional(), variant: z.string().optional() },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => {
        const rig = ensureRig(s);
        const part = findPart(rig, a.name);
        if (a.facing) {
          const key = viewKey(a.facing, a.variant);
          if (!part.views[key]) throw new Error(`Part "${a.name}" has no "${key}" drawing`);
          delete part.views[key];
        } else {
          const children = rig.parts.filter((p) => p.parent === a.name);
          for (const c of children) c.parent = part.parent;
          rig.parts = rig.parts.filter((p) => p !== part);
        }
        bakeRig(s);
      });
      return text(describeRig(sprite));
    },
    { destructiveHint: true },
  );

  tool(
    'rig_preview',
    'Render the character rig in rest pose (or with test offsets) for several facings side by side, with the pivots marked. Use it to check the turnaround and the joints before animating.',
    {
      sprite: P.sprite,
      facings: z.array(facingEnum).optional().describe('Default: every facing with art'),
      parts: z.record(z.string(), partPoseSchema).optional().describe('Test pose applied to every facing, e.g. {"arm_r":{"rot":90}}'),
      show_pivots: z.boolean().optional().describe('Mark pivots in magenta (default true)'),
      scale: z.number().int().min(1).max(32).optional(),
    },
    (a) => {
      const s = ws.load(a.sprite);
      if (!s.rig) throw new Error('This sprite has no rig. Use create_character / rig_part.');
      const facings = facingsOf(s, a.facings as Facing[] | undefined);
      return [...text(`${describeRig(s)}\nShown: ${facings.join(', ')}`), rigTurnaround(s, facings, a.parts ?? {}, a.show_pivots ?? true, a.scale)];
    },
    { readOnlyHint: true },
  );

  tool(
    'rig_pose',
    `Set the rig pose of frames (merged into the existing pose unless replace is true), or append a new posed frame. The rig layer is re-rendered.
Use it for hand-made keyframes or to tweak what rig_animate generated (e.g. {"head":{"dy":1}} on one frame, or a "blink" variant).`,
    {
      sprite: P.sprite,
      frames: z.array(z.number().int().min(0)).optional().describe('Frames to pose (omit with new: true)'),
      new: z.boolean().optional().describe('Append a new frame with this pose'),
      facing: facingEnum.optional().describe('Required for new frames; otherwise keeps the current facing'),
      parts: z.record(z.string(), partPoseSchema).optional(),
      replace: z.boolean().optional().describe('Replace the whole pose instead of merging'),
      duration: z.number().int().min(1).optional(),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const rig = ensureRig(s);
        for (const name of Object.keys(a.parts ?? {})) findPart(rig, name);
        let idx = a.frames ?? [];
        if (a.new) {
          if (!a.facing) throw new Error('A new frame needs a facing');
          addFrame(s, undefined, { duration: a.duration });
          idx = [s.frames.length - 1];
        }
        if (!idx.length) throw new Error('Pass frames or new: true');
        for (const i of idx) {
          const f = resolveFrame(s, i);
          const facing = (a.facing ?? f.pose?.facing) as Facing | undefined;
          if (!facing) throw new Error(`Frame ${i} has no pose yet: pass a facing`);
          const base = a.replace || !f.pose ? {} : f.pose.parts;
          const parts: Record<string, PartPose> = { ...base };
          for (const [name, v] of Object.entries(a.parts ?? {})) parts[name] = a.replace ? { ...v } : { ...base[name], ...v };
          f.pose = { facing, parts };
          if (a.duration) f.duration = a.duration;
        }
        bakeRig(s, idx);
        return idx;
      });
      return withPreview(text(`Posed frame(s) ${result.join(', ')}.`), sprite, result[0], a.preview);
    },
  );

  tool(
    'rig_animate',
    `Generate an animation for the rig in one or more facings: idle (breathing), walk, run, attack (overhead slash with anticipation and follow-through) or hurt (knockback).
Creates frames + a tag "<animation>_<facing>" per facing (regenerating replaces the old frames of that tag), with tuned timings and secondary motion (cape/hair trail, arms settle a frame late). Optional part variants are used when present: head "blink" in idle, head/body "hurt" in hurt.
Afterwards check with preview tags=[...] and adjust single frames with rig_pose.`,
    {
      sprite: P.sprite,
      animation: z.enum(['idle', 'walk', 'run', 'attack', 'hurt']),
      facings: z.array(facingEnum).optional().describe('Default: every facing with art'),
      frames: z.number().int().min(2).max(24).optional().describe('Frame count for idle/walk/run (defaults 4/8/6)'),
      strength: z.number().min(0.25).max(3).optional().describe('Motion amplitude multiplier (default 1)'),
      duration: z.number().int().min(1).optional().describe('Override every frame duration (ms)'),
      preview: z.boolean().optional().describe('Return the generated animations, one row per facing (default true)'),
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        if (!s.rig?.parts.length) throw new Error('The rig has no parts yet. Draw them with rig_part.');
        const facings = facingsOf(s, a.facings as Facing[] | undefined);
        const tags: string[] = [];
        // A fresh character only has its rest frame: reuse it.
        for (const facing of facings) {
          const gen = generateAnimation(s, a.animation as AnimName, facing, { frames: a.frames, strength: a.strength, duration: a.duration });
          const tagName = `${a.animation}_${facing}`;
          writeTagFrames(s, tagName, gen.poses, gen.durations);
          tags.push(tagName);
        }
        bakeRig(s);
        return tags;
      });
      const out = text(`Generated ${result.join(', ')}.\n${describe(sprite)}`);
      if (a.preview === false) return out;
      return [...out, image(previewPng(sprite, { tags: result, pixelGrid: false }))];
    },
  );

  // ------------------------------------------------------------------ forms, materials & checks

  const vec = z.tuple([z.number(), z.number()]);
  const shadeSchema = z.object({
    ramp: z.union([z.string(), z.array(z.string())]).describe('Ramp name (set_ramp) or colors darkest → lightest'),
    base: z.number().int().min(0).optional().describe('Index of the base shade (default: middle of the ramp)'),
    light: vec.optional().describe('Direction toward the light (default [-1,-1] = top-left)'),
    shadow: z.number().min(0).max(1).optional().describe('Fraction of the form in shadow along the light axis (default 0.35)'),
    deep: z.number().min(0).max(1).optional().describe('Fraction in core shadow on the far edge (default 0.12)'),
    highlight: z.number().min(0).max(1).optional().describe('Fraction lit (default 0.18)'),
    shadow_px: z.number().int().min(0).optional().describe('Shadow width in pixels instead of a fraction'),
    highlight_px: z.number().int().min(0).optional().describe('Highlight width in pixels instead of a fraction'),
    mode: z.enum(['cel', 'form']).optional().describe('"cel" (default): bands along the light axis. "form": rounded 3D volume (spheres, cylinders) — shadows wrap around the form'),
    rim: z.boolean().optional().describe('form: reflected light on the shadow-side edge'),
  });
  type ShadeArg = z.infer<typeof shadeSchema>;

  const rampOf = (s: Sprite, r: string | string[]): RGBA[] => {
    if (Array.isArray(r)) return r.map((c) => color(s, c));
    const ramp = s.ramps[r];
    if (!ramp) throw new Error(`No ramp named "${r}". Ramps: ${Object.keys(s.ramps).join(', ') || 'none (use set_ramp)'}`);
    return ramp.map((c) => parseColor(c));
  };

  const shadeOpts = (s: Sprite, a: ShadeArg): ShadeOptions => ({
    ramp: rampOf(s, a.ramp),
    base: a.base,
    light: a.light as Vec | undefined,
    shadow: a.shadow,
    deep: a.deep,
    highlight: a.highlight,
    shadowPx: a.shadow_px,
    mode: a.mode,
    rim: a.rim,
    highlightPx: a.highlight_px,
  });

  const allRamps = (s: Sprite) => Object.values(s.ramps).map((r) => r.map((c) => parseColor(c)));

  const framesArg = (s: Sprite, frame?: number, all?: boolean) => (all ? s.frames.map((_, i) => i) : [frame ?? 0]);

  const maskBounds = (m: Mask) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (m.data[y * m.width + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return x1 < 0 ? 'empty' : `x=${x0}..${x1} y=${y0}..${y1}`;
  };

  tool(
    'draw_shapes',
    `Draw forms from geometry instead of typing pixels — far more precise for organic shapes. Coordinates are pixel indices (fractions allowed); angles are degrees clockwise from +x (0 = right, 90 = down).
Shape types:
- capsule {from, to, r1, r2?}: tapered limb/finger/blade between two points (r = radius at each end).
- ellipse {center, rx, ry, angle?}: heads, eyes, shields, shadows.
- polygon {points}: hard-edged forms (armor plates, blades, hair spikes).
- spline {points, closed?, width?}: smooth Catmull-Rom curve through the points; closed = filled region (hair locks, capes, muscles), open = stroke of width (default 1px, pixel-perfect: no doubled corners).
- line {points, width?}: straight polyline stroke.
- arc {center, radius, start, end, width, taper?}: crescent from angle start to end (clockwise if end > start), thickest in the middle — slash smears and motion arcs. Use colors [outer → inner] for a gradient.
Painting: fill (flat color), shade (ramp-based cel shading along the light direction — no pillow shading), outline (1px inside the shape's border), erase. Shapes are drawn in order, so stack them back to front.`,
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      shapes: z
        .array(
          z.object({
            type: z.enum(['capsule', 'ellipse', 'polygon', 'spline', 'line', 'arc']),
            points: z.array(vec).optional(),
            closed: z.boolean().optional(),
            width: z.number().optional(),
            from: vec.optional(),
            to: vec.optional(),
            r1: z.number().optional(),
            r2: z.number().optional(),
            center: vec.optional(),
            rx: z.number().optional(),
            ry: z.number().optional(),
            angle: z.number().optional(),
            radius: z.number().optional(),
            start: z.number().optional(),
            end: z.number().optional(),
            taper: z.boolean().optional(),
            fill: z.string().optional(),
            shade: shadeSchema.optional(),
            outline: z.string().optional(),
            colors: z.array(z.string()).optional().describe('arc only: gradient from the outer to the inner edge'),
            erase: z.boolean().optional(),
            cast_shadow: z.number().int().min(1).max(6).optional().describe('Darken what lies under the shape on the side away from the light, this many px (hair on face, head on neck)'),
            aa: z.boolean().optional().describe('Anti-alias the shape edge against what is under it (in-between palette colors); ignored with outline'),
          }),
        )
        .min(1),
      preview: P.preview,
    },
    (a) => {
      const warnings: string[] = [];
      const { sprite, result } = mutate(a.sprite, (s) => {
        const { bmp } = cel(s, a.frame, a.layer);
        return a.shapes.map((sh, i) => {
          if ((sh.type === 'line' || (sh.type === 'spline' && !sh.closed)) && sh.width !== undefined && sh.width > 1 && !Number.isInteger(sh.width)) {
            warnings.push(`shape ${i}: width ${sh.width} rasterizes about ${Math.ceil(sh.width)}px wide; use 1 for a crisp line or an integer width`);
          }
          const need = <T>(v: T | undefined, name: string): T => {
            if (v === undefined) throw new Error(`Shape ${i} (${sh.type}) needs "${name}"`);
            return v;
          };
          let shape: Shape;
          switch (sh.type) {
            case 'capsule': shape = { type: 'capsule', from: need(sh.from, 'from') as Vec, to: need(sh.to, 'to') as Vec, r1: need(sh.r1, 'r1'), r2: sh.r2 }; break;
            case 'ellipse': shape = { type: 'ellipse', center: need(sh.center, 'center') as Vec, rx: need(sh.rx, 'rx'), ry: sh.ry ?? need(sh.rx, 'rx'), angle: sh.angle }; break;
            case 'polygon': shape = { type: 'polygon', points: need(sh.points, 'points') as Vec[] }; break;
            case 'spline': shape = { type: 'spline', points: need(sh.points, 'points') as Vec[], closed: sh.closed, width: sh.width }; break;
            case 'line': shape = { type: 'line', points: need(sh.points, 'points') as Vec[], width: sh.width }; break;
            case 'arc': shape = { type: 'arc', center: need(sh.center, 'center') as Vec, radius: need(sh.radius, 'radius'), from: need(sh.start, 'start'), to: need(sh.end, 'end'), width: need(sh.width, 'width'), taper: sh.taper }; break;
          }
          const cov = sh.aa && !sh.outline ? shapeCoverage(shape, s.width, s.height) : null;
          const m = cov ? maskFromCoverage(cov, s.width, s.height) : shapeMask(shape, s.width, s.height);
          const before: Bitmap | null = cov ? { width: bmp.width, height: bmp.height, data: new Uint8ClampedArray(bmp.data) } : null;
          if (sh.cast_shadow && !sh.erase) castShadow(bmp, m, allRamps(s), (sh.shade?.light as Vec | undefined) ?? [-1, -1], sh.cast_shadow);
          if (sh.erase) paintMask(bmp, m, [0, 0, 0, 0]);
          else if (sh.type === 'arc' && sh.colors?.length) paintArc(bmp, shape as Extract<Shape, { type: 'arc' }>, sh.colors.map((c) => color(s, c)));
          else if (sh.shade) shadeMask(bmp, m, shadeOpts(s, sh.shade));
          else if (sh.fill) paintMask(bmp, m, color(s, sh.fill));
          if (sh.outline && !sh.erase) {
            const border = maskBorder(m);
            const area = maskCount(m);
            paintMask(bmp, border, color(s, sh.outline));
            if (area > 0 && maskCount(border) / area > 0.65) {
              warnings.push(`shape ${i} (${sh.type}) is ${Math.round((maskCount(border) / area) * 100)}% outline: too thin for an outline — make it bigger or draw it with draw_pixels without outline`);
            }
          }
          if (cov && before && !sh.erase) antialiasEdge(bmp, before, m, cov, s.palette.map((c) => parseColor(c)));
          return `${i}:${sh.type} ${maskCount(m)}px ${maskBounds(m)}`;
        });
      });
      const note = `Drew ${result.length} shape(s): ${result.join('; ')}${warnings.length ? `\nWarnings:\n- ${warnings.join('\n- ')}` : ''}`;
      return withPreview(text(note), sprite, a.frame, a.preview);
    },
  );

  tool(
    'set_ramp',
    `Define a named color ramp (darkest first) for a material: skin, hair, cloth, metal... Then use "name.N" anywhere a color is accepted (legends, fills, outlines) and in shade.
Give explicit colors, or a base color to generate a hue-shifted ramp (shadows drift toward blue-violet, lights toward warm yellow — avoids muddy, flat shading). New colors are added to the palette.`,
    {
      sprite: P.sprite,
      name: z.string().regex(/^[A-Za-z_][\w-]*$/),
      colors: z.array(z.string()).optional(),
      base: z.string().optional().describe('Middle color of a generated ramp'),
      steps: z.number().int().min(2).max(9).optional().describe('Generated shades (default 5)'),
      hue_shift: z.number().min(0).max(60).optional().describe('Degrees of hue drift at the ends (default 18)'),
      contrast: z.number().min(0.03).max(0.25).optional().describe('Lightness step between shades (default 0.11)'),
    },
    (a) => {
      const { result } = mutate(a.sprite, (s) => {
        let ramp: string[];
        if (a.colors?.length) ramp = a.colors.map((c) => normalizeHex(toHex(color(s, c))));
        else if (a.base) ramp = generateRamp(color(s, a.base), { steps: a.steps, hueShift: a.hue_shift, contrast: a.contrast });
        else throw new Error('Give colors or a base color');
        s.ramps[a.name] = ramp;
        for (const c of ramp) if (!s.palette.includes(c)) s.palette.push(c);
        return ramp;
      });
      return text(`Ramp "${a.name}": ${result.map((c, i) => `${a.name}.${i}=${c}`).join(' ')}`);
    },
  );

  tool(
    'shade',
    `Cel-shade existing pixels with a ramp: select a material (by its flat colors and/or a rectangle) and it gets shadow on the side away from the light, core shadow on the far edge and highlight on the near edge, following the silhouette.
Typical flow: block in each material with one flat color (draw_shapes fill / draw_pixels), then shade each one with its ramp, then selout, then lint.`,
    {
      sprite: P.sprite,
      frame: P.frame,
      all_frames: z.boolean().optional(),
      layer: P.layer,
      colors: z.array(z.string()).optional().describe('Only pixels of these colors (default: every opaque pixel in the rect / layer)'),
      rect: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional(),
      ...shadeSchema.shape,
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        let n = 0;
        for (const f of framesArg(s, a.frame, a.all_frames)) {
          const { bmp } = cel(s, f, a.layer);
          const m = maskFromBitmap(bmp, a.colors?.map((c) => color(s, c)));
          if (a.rect) for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (x < a.rect.x || y < a.rect.y || x >= a.rect.x + a.rect.width || y >= a.rect.y + a.rect.height) m.data[y * m.width + x] = 0;
          n += shadeMask(bmp, m, shadeOpts(s, a));
        }
        return n;
      });
      return withPreview(text(`Shaded ${result} pixel(s).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'selout',
    'Selective outline: interior outline pixels (between two materials) become a dark shade of the material they enclose, and silhouette pixels on the lit side soften too; the shadow-side silhouette stays dark. Uses the ramps to pick shades. Makes sprites read less "coloring book".',
    {
      sprite: P.sprite,
      frame: P.frame,
      all_frames: z.boolean().optional(),
      layer: P.layer,
      outline: z.string().optional().describe('Outline color (default: darkest color of the cel)'),
      light: vec.optional().describe('Direction toward the light (default [-1,-1])'),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        let n = 0;
        for (const f of framesArg(s, a.frame, a.all_frames)) {
          const { bmp } = cel(s, f, a.layer);
          const line = a.outline ? color(s, a.outline) : darkestColor(bmp);
          if (line) n += selout(bmp, line, allRamps(s), (a.light as Vec | undefined) ?? [-1, -1]);
        }
        return n;
      });
      return withPreview(text(`Recolored ${result} outline pixel(s).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'cleanup',
    'Fix common pixel-art defects automatically: "jaggies" removes L-corners (doubled pixels) from 1px outlines; "orphans" replaces isolated noise pixels (close in color to their surroundings) with their surroundings — high-contrast accents such as eye glints are never touched.',
    {
      sprite: P.sprite,
      frame: P.frame,
      all_frames: z.boolean().optional(),
      layer: P.layer,
      jaggies: z.boolean().optional().describe('Default true'),
      orphans: z.boolean().optional().describe('Default false'),
      outline: z.string().optional().describe('Line color for jaggies (default: darkest color)'),
      keep: z.array(z.string()).optional().describe('Colors never removed as orphans'),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        let j = 0;
        let o = 0;
        const keep = (a.keep ?? []).map((c) => toHex(color(s, c)));
        for (const f of framesArg(s, a.frame, a.all_frames)) {
          const { bmp } = cel(s, f, a.layer);
          if (a.jaggies ?? true) {
            const line = a.outline ? color(s, a.outline) : darkestColor(bmp);
            if (line) j += fixPixels(bmp, findJaggies(bmp, line));
          }
          if (a.orphans) o += fixPixels(bmp, findNoisePixels(bmp).filter(([x, y]) => !keep.includes(toHex(getPixel(bmp, x, y)))));
        }
        return { j, o };
      });
      return withPreview(text(`Removed ${result.j} jaggy pixel(s) and ${result.o} orphan(s).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'lint',
    'Check a frame for pixel-art problems and get exact coordinates: near-duplicate colors, orphan pixels, jaggies (L-corners) and 2x2 doubles on the outline, low-contrast color pairs that blur together, plus a style note on how much of the silhouette is outlined. Fix real problems with small local edits (set_pixels, cleanup); never repaint or redraw areas just to satisfy lint, and re-run silhouette_check afterwards to make sure the sprite did not get worse.',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Default: all visible layers composited'),
      outline: z.string().optional().describe('Outline color (default: darkest color)'),
    },
    (a) => {
      const s = ws.load(a.sprite);
      const bmp = a.layer !== undefined ? celBitmap(s, resolveLayer(s, a.layer).id, resolveFrame(s, a.frame).id) : compositeFrame(s, a.frame ?? 0);
      const r = lintBitmap(bmp, a.outline ? color(s, a.outline) : undefined);
      const pts = (v: Vec[], max = 24) => (v.length ? v.slice(0, max).map(([x, y]) => `(${x},${y})`).join(' ') + (v.length > max ? ` …+${v.length - max}` : '') : 'none');
      const pct = r.silhouette ? Math.round((r.unoutlined.length / r.silhouette) * 100) : 0;
      return text(
        [
          `Colors: ${r.colors}${r.nearDuplicates.length ? `; near-duplicates (merge them): ${r.nearDuplicates.map((p) => p.join('≈')).join(', ')}` : ''}`,
          `Noise pixels — isolated and close in color to their surroundings (${r.orphans.length}): ${pts(r.orphans)}`,
          `Accent pixels — isolated, high contrast (eye glints, sparkles; usually deliberate, leave them): ${r.accents.length}`,
          `Outline jaggies / L-corners (${r.jaggies.length}): ${pts(r.jaggies)}`,
          `Outline 2x2 doubles (${r.doubles.length}): ${pts(r.doubles)}`,
          `Style note — silhouette pixels lighter than the outline color: ${r.unoutlined.length}/${r.silhouette} (${pct}%)${pct > 0 ? `: ${pts(r.unoutlined, 12)}. Normal for colored/selective outlines and pixelized or painterly art; only change them if this sprite should have a closed dark outline.` : ''}`,
          `Low-contrast neighbors (colors too close to read): ${r.lowContrast.length ? r.lowContrast.slice(0, 8).map(([c1, c2, n]) => `${c1}/${c2}×${n}`).join(', ') : 'none'}`,
        ].join('\n'),
      );
    },
    { readOnlyHint: true },
  );

  /** Reads a PNG, optionally cropped and with its background removed. */
  const loadPicture = (file: string, crop?: { x: number; y: number; width: number; height: number }, removeBg?: boolean, tolerance?: number) => {
    const full = decodePng(fs.readFileSync(path.resolve(file)));
    let src = crop ? extractRegion(full, crop) : full;
    if (removeBg) src = removeBackground(src, tolerance);
    return { src, full };
  };

  /** Stores a picture as the sprite's reference, scaled to `height` canvas pixels (default: fit) and placed at x/y (default: centered, bottom). */
  const attachReference = (s: Sprite, src: Bitmap, height?: number, px?: number, py?: number) => {
    const h = height ?? Math.min(s.height, Math.floor((src.height * s.width) / src.width));
    const w = Math.max(1, Math.round((src.width * h) / src.height));
    const scaled = downscale(src, w, h);
    // Keep the picture at up to 4x the canvas size so silhouette_check can see thin details.
    const hi = src.height > h * 4 ? downscale(src, w * 4, h * 4) : src;
    const x = px ?? Math.floor((s.width - w) / 2);
    const y = py ?? s.height - h;
    s.reference = { width: w, height: h, pixels: bytesToBase64(scaled.data), x, y, source: { width: hi.width, height: hi.height, pixels: bytesToBase64(hi.data) } };
    return { w, h, x, y };
  };

  tool(
    'pixelize',
    `Convert a high-resolution picture (concept art, a painting, a 3D render, an upscaled sprite) into clean pixel art on a layer — the fastest way to reach the quality of a hand-made sprite: then refine face, hands and details with the drawing tools, and cut it into rig parts to animate.
How it works: colors are reduced to a palette (k-means in a perceptual color space, or the sprite's own palette), then each output pixel takes the MAJORITY color of the area it covers (no blurry averages), dark line colors win when they cover enough of it (outlines survive), and quantization noise is removed while deliberate glints stay.
The picture also becomes the sprite's reference (unless keep_reference), so preview compare and silhouette_check work against it.`,
    {
      sprite: P.sprite,
      path: z.string().describe('PNG file'),
      crop: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional().describe('Region of the picture, in its own pixels'),
      height: z.number().int().min(4).optional().describe('Height of the result in canvas pixels (default: fit the canvas)'),
      x: z.number().int().optional().describe('Left on the canvas (default centered)'),
      y: z.number().int().optional().describe('Top on the canvas (default bottom-aligned)'),
      remove_background: z.boolean().optional().describe('Make the picture background transparent first (default true)'),
      tolerance: z.number().min(0).max(160).optional().describe('Background tolerance (default 8)'),
      colors: z.number().int().min(2).max(64).optional().describe('Palette size extracted from the picture (default 24)'),
      use_palette: z.boolean().optional().describe("Quantize to the sprite's existing palette (ramps) instead of extracting one"),
      layer: z.string().optional().describe('Target layer (default "pixelized", created if missing; it is replaced)'),
      line_bias: z.number().min(0).max(1).optional().describe('How much of a pixel dark line colors must cover to win (default: chosen automatically to keep the picture\'s light/dark balance; lower keeps more outline, higher gives cleaner, lighter fills)'),
      line_lightness: z.number().min(0).max(1).optional().describe('Colors darker than this (OKLab L) count as line colors (default 0.3)'),
      despeckle: z.boolean().optional().describe('Remove quantization noise (default true)'),
      keep_reference: z.boolean().optional().describe('Do not replace the sprite reference'),
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const { src, full } = loadPicture(a.path, a.crop, a.remove_background ?? true, a.tolerance);
        const h = a.height ?? Math.min(s.height, Math.floor((src.height * s.width) / src.width));
        const w = Math.max(1, Math.round((src.width * h) / src.height));
        const palette = a.use_palette ? s.palette.map((c) => parseColor(c)) : kmeansPalette(src, a.colors ?? 24);
        if (!palette.length) throw new Error('No palette: give colors or set a palette first');
        const base = { width: w, height: h, palette, lineLightness: a.line_lightness, despeckle: a.despeckle };
        // Without an explicit line_bias, pick the one that keeps the source's light/dark balance.
        const auto = a.line_bias === undefined ? pixelizeAuto(src, base, downscale(src, w, h)) : null;
        const px = auto ? auto.image : pixelize(src, { ...base, lineBias: a.line_bias });
        const biasNote = auto ? `line_bias ${auto.lineBias} (auto)` : `line_bias ${a.line_bias}`;
        const x = a.x ?? Math.floor((s.width - w) / 2);
        const y = a.y ?? s.height - h;
        const layer = s.layers.find((l) => l.name === (a.layer ?? 'pixelized')) ?? addLayer(s, a.layer ?? 'pixelized');
        const bmp = celBitmap(s, layer.id, resolveFrame(s, 0).id);
        bmp.data.fill(0);
        pasteBitmap(bmp, px, x, y, 'over');
        const used = [...new Set(colorHistogram(px).map((c) => c.color))];
        if (a.use_palette) {
          for (const c of used) if (!s.palette.includes(c)) s.palette.push(c);
        } else {
          // Replace the palette with what the sprite actually uses (all layers and frames) plus the ramps,
          // so leftovers such as the default palette do not linger.
          const inUse = new Set<string>(Object.values(s.ramps).flat());
          for (const l of s.layers) for (const f of s.frames) for (const h of colorHistogram(celBitmap(s, l.id, f.id))) inUse.add(h.color);
          s.palette = [...inUse].sort((x, y) => luminance(parseColor(x)) - luminance(parseColor(y)));
        }
        if (!a.keep_reference) attachReference(s, src, h, x, y);
        return `Pixelized ${full.width}x${full.height}${a.crop ? ` (crop ${a.crop.width}x${a.crop.height})` : ''} → ${w}x${h} at (${x},${y}) on layer "${layer.name}", ${biasNote}, ${used.length} colors: ${used.join(' ')}`;
      });
      return [...text(result), image(previewPng(sprite, { compare: !!sprite.reference, rulers: true }))];
    },
  );

  tool(
    'set_reference',
    `Attach a reference image (concept art, a sprite you want to match) to a sprite. It is scaled to canvas pixels and shown by preview compare / underlay; it is never exported.
Crop the source to the pose you care about, and give the height in canvas pixels the figure should have. Optionally extract a palette from it, or copy it to a layer as a tracing base.`,
    {
      sprite: P.sprite,
      path: z.string().optional().describe('PNG file (omit with clear: true)'),
      crop: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional().describe('Region of the source image, in source pixels'),
      height: z.number().int().min(1).optional().describe('Height on the canvas (default: fit the canvas)'),
      x: z.number().int().optional().describe('Left on the canvas (default centered)'),
      y: z.number().int().optional().describe('Top on the canvas (default bottom-aligned)'),
      palette: z.number().int().min(2).max(64).optional().describe('Replace the palette with this many colors extracted from the reference'),
      to_layer: z.string().optional().describe('Also paste the scaled reference into this layer (created if missing)'),
      remove_background: z.boolean().optional().describe('Make the picture background transparent (flood fill from the border) — needed by silhouette_check'),
      tolerance: z.number().min(0).max(160).optional().describe('Background color tolerance (default 8; raise it for noisy backgrounds, lower it if dark clothing gets eaten)'),
      clear: z.boolean().optional(),
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        if (a.clear) {
          s.reference = null;
          return 'Reference removed.';
        }
        if (!a.path) throw new Error('Give a path');
        const { src, full } = loadPicture(a.path, a.crop, a.remove_background, a.tolerance);
        const { w, h: fitH, x, y } = attachReference(s, src, a.height, a.x, a.y);
        let note = `Reference ${full.width}x${full.height}${a.crop ? ` cropped to ${a.crop.width}x${a.crop.height}` : ''} → ${w}x${fitH} at (${x},${y}).`;
        if (a.palette) {
          s.palette = extractPalette(src, a.palette);
          note += `\nPalette from reference: ${s.palette.map((c, i) => `p${i}=${c}`).join(' ')}`;
        }
        if (a.to_layer) {
          const layer = s.layers.find((l) => l.name === a.to_layer) ?? addLayer(s, a.to_layer);
          const ref = referenceBitmap(s);
          for (const f of s.frames) celBitmap(s, layer.id, f.id).data.set(ref.data);
          note += `\nCopied into layer "${layer.name}".`;
        }
        return note;
      });
      if (!sprite.reference) return text(result);
      return [...text(result), image(previewPng(sprite, { compare: true, rulers: true }))];
    },
  );

  tool(
    'rig_keyframes',
    `Author a custom rig animation from a few key poses; the frames in between are interpolated (dx, dy, rot, sx, sy) with easing. Variants, hide, z and smear hold until the next key.
Use it for anything the templates don't cover (jump: anticipation crouch → launch stretch → apex → fall → land squash; combo attacks; special moves) and to fine-tune timing: put keys on the extreme poses and choose ease "out" after fast moves, "in" before impacts.
Creates/replaces tag <name> (frames are rendered from the rig). Check with preview tags=[name] onion=true.`,
    {
      sprite: P.sprite,
      name: z.string().describe('Tag name, e.g. "jump_right"'),
      facing: facingEnum,
      frames: z.number().int().min(1).max(64),
      keys: z.array(z.object({ frame: z.number().int().min(0), parts: z.record(z.string(), partPoseSchema), ease: z.enum(['linear', 'in', 'out', 'inout', 'step']).optional() })).min(1),
      loop: z.boolean().optional().describe('Interpolate from the last key back to the first (default false)'),
      duration: z.number().int().min(1).optional().describe('ms per frame (default 100)'),
      durations: z.array(z.number().int().min(1)).optional().describe('ms per frame, one value per frame'),
      preview: z.boolean().optional().describe('Return the animation with onion skin (default true)'),
    },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => {
        const rig = ensureRig(s);
        for (const k of a.keys) for (const name of Object.keys(k.parts)) findPart(rig, name);
        const poses = interpolateKeyframes(a.keys as Keyframe[], a.frames, !!a.loop).map((parts) => ({ facing: a.facing as Facing, parts }));
        if (a.durations && a.durations.length !== a.frames) throw new Error(`durations needs ${a.frames} values`);
        writeTagFrames(s, a.name, poses, a.durations ?? Array(a.frames).fill(a.duration ?? 100));
        bakeRig(s);
      });
      const out = text(`Tag "${a.name}" now has ${a.frames} frame(s).\n${describe(sprite)}`);
      if (a.preview === false) return out;
      return [...out, image(previewPng(sprite, { tags: [a.name], onion: true, rulers: false }))];
    },
  );

  // ------------------------------------------------------------------ versions (scored snapshots on disk)

  type VersionInfo = { id: string; file: string; time: string; iou: number; advice: number; rev: string };
  const versionDir = (name: string) => path.join(ws.dir, '.versions', name);

  /** Versions newest first. File names: <timestamp>_<overlap%|manual>_<value warnings>_<rev>.sprite.json */
  const listVersions = (name: string): VersionInfo[] => {
    const dir = versionDir(name);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sprite.json'))
      .map((f) => {
        const [ts, iou, advice, rev] = f.replace('.sprite.json', '').split('_');
        return { id: ts, file: path.join(dir, f), time: new Date(Number(ts)).toLocaleTimeString(), iou: iou === 'manual' ? -1 : Number(iou), advice: Number(advice) || 0, rev };
      })
      .sort((x, y) => Number(y.id) - Number(x.id));
  };

  const saveVersion = (name: string, raw: SpriteFile, iou: number | null, advice = 0): VersionInfo => {
    const dir = versionDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const id = String(Date.now());
    const file = path.join(dir, `${id}_${iou === null ? 'manual' : iou}_${advice}_${raw.rev}.sprite.json`);
    fs.writeFileSync(file, JSON.stringify(raw));
    // Keep the 40 newest plus the best-scoring one.
    const all = listVersions(name);
    const keep = new Set(all.slice(0, 40).map((v) => v.file));
    const top = all.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou)[0];
    if (top) keep.add(top.file);
    for (const v of all) if (!keep.has(v.file)) fs.rmSync(v.file);
    return listVersions(name).find((v) => v.file === file)!;
  };

  tool(
    'versions',
    'List the saved versions of a sprite: every silhouette_check saves one with its overlap and number of value warnings, and restore_version / save_version add more. Use it to go back when a pass made things worse.',
    { sprite: P.sprite },
    (a) => {
      const list = listVersions(a.sprite);
      if (!list.length) return text(`No versions yet for "${a.sprite}". silhouette_check and save_version create them.`);
      const best = list.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou || x.advice - y.advice)[0];
      return text(list.map((v) => `${v.id}  ${v.time}  ${v.iou >= 0 ? `overlap ${v.iou}%, ${v.advice} value warning(s)` : 'manual save'}${v === best ? '  ← best' : ''}`).join('\n'));
    },
    { readOnlyHint: true },
  );

  tool(
    'save_version',
    'Save the current state of a sprite as a version (e.g. before a risky edit). Versions survive restarts, unlike undo.',
    { sprite: P.sprite },
    (a) => {
      const v = saveVersion(a.sprite, ws.readRaw(a.sprite), null);
      return text(`Saved version ${v.id}.`);
    },
  );

  tool(
    'restore_version',
    'Restore a saved version of a sprite (see versions). The current state is saved as a version first, so nothing is lost.',
    { sprite: P.sprite, id: z.string().describe('Version id from versions / silhouette_check') },
    (a) => {
      const v = listVersions(a.sprite).find((x) => x.id === a.id);
      if (!v) throw new Error(`No version ${a.id} for "${a.sprite}". Use versions to list them.`);
      const current = ws.readRaw(a.sprite);
      saveVersion(a.sprite, current, null);
      remember(a.sprite, current);
      const file = JSON.parse(fs.readFileSync(v.file, 'utf8')) as SpriteFile;
      file.rev = newId();
      file.updatedBy = AUTHOR;
      ws.writeRaw(file);
      return text(`Restored version ${v.id} (${v.iou >= 0 ? `overlap ${v.iou}%` : 'manual save'}). The previous state was saved as a version.`);
    },
  );

  // ------------------------------------------------------------------ pose guides

  const DEFAULT_BONES: [string, string][] = [
    ['head', 'neck'], ['neck', 'pelvis'],
    ['neck', 'shoulder_f'], ['shoulder_f', 'elbow_f'], ['elbow_f', 'hand_f'],
    ['neck', 'shoulder_b'], ['shoulder_b', 'elbow_b'], ['elbow_b', 'hand_b'],
    ['pelvis', 'hip_f'], ['hip_f', 'knee_f'], ['knee_f', 'foot_f'],
    ['pelvis', 'hip_b'], ['hip_b', 'knee_b'], ['knee_b', 'foot_b'],
    ['hand_f', 'weapon_tip'], ['hand_b', 'shield'],
  ];

  const describeGuide = (g: PoseGuide) => {
    const lines = g.bones
      .filter(([a, b]) => g.joints[a] && g.joints[b])
      .map(([a, b]) => {
        const [x0, y0] = g.joints[a];
        const [x1, y1] = g.joints[b];
        const len = Math.hypot(x1 - x0, y1 - y0);
        const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
        return `${a}→${b}: ${len.toFixed(1)}px at ${Math.round(ang)}°`;
      });
    return `Joints: ${Object.entries(g.joints).map(([n, [x, y]]) => `${n}(${x},${y})`).join(' ')}\nBones: ${lines.join('; ')}`;
  };

  tool(
    'pose_guide',
    `Place a gesture skeleton (joints in canvas pixels) to plan a pose BEFORE drawing, then draw the shapes along its bones. It is stored with the sprite, drawn over previews (preview guide: true) and never exported.
Workflow: set_reference → preview compare + guide to trace the reference's joints → adjust until the skeleton sits on the reference → draw limbs as capsules from joint to joint → silhouette_check.
Standard joints (bones are connected automatically): head (top of skull center), neck, pelvis, shoulder_f / elbow_f / hand_f (arm nearer the camera), shoulder_b / elbow_b / hand_b (farther arm), hip_f / knee_f / foot_f, hip_b / knee_b / foot_b, weapon_tip, shield. "_f" bones show cyan, "_b" orange. Add any other joint names with custom bones.`,
    {
      sprite: P.sprite,
      joints: z.record(z.string(), z.tuple([z.number(), z.number()])).optional().describe('Joints to add or move (merged with the existing ones)'),
      remove: z.array(z.string()).optional().describe('Joint names to delete'),
      bones: z.array(z.tuple([z.string(), z.string()])).optional().describe('Extra bones to connect (standard bones are added automatically)'),
      clear: z.boolean().optional(),
      preview: z.boolean().optional().describe('Return the reference and the art with the skeleton (default true)'),
    },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => {
        if (a.clear) {
          s.guide = null;
          return;
        }
        const g: PoseGuide = s.guide ?? { joints: {}, bones: [] };
        Object.assign(g.joints, a.joints ?? {});
        for (const n of a.remove ?? []) delete g.joints[n];
        const extra = [...g.bones.filter((b) => !DEFAULT_BONES.some((d) => d[0] === b[0] && d[1] === b[1])), ...(a.bones ?? [])];
        g.bones = [...DEFAULT_BONES.filter(([x, y]) => g.joints[x] && g.joints[y]), ...extra.filter(([x, y]) => g.joints[x] && g.joints[y])];
        s.guide = g;
      });
      if (!sprite.guide) return text('Pose guide removed.');
      const out = text(describeGuide(sprite.guide));
      if (a.preview === false) return out;
      return [...out, image(previewPng(sprite, { compare: !!sprite.reference, guide: true, rulers: true }))];
    },
  );

  tool(
    'silhouette_check',
    `Compare the art with the reference (set_reference with remove_background) to fix proportions, pose, thin details and colors objectively.
The reference silhouette is measured on the high-resolution picture: a canvas pixel counts when the figure covers at least "coverage" of it (default 25%), so hair spikes, straps and blade tips are not lost.
Returns: overlap (IoU); regions to ADD (missing from the art, "thin" = fine detail) and to TRIM (extra in the art) with their boxes; a band-by-band table of left/right edges; and zones whose colors differ (lighter/darker, more/less saturated, hue shift, with the reference color to use).
Image: reference | art | diff (gray = both, green = missing, light green = missing thin detail, magenta = extra).`,
    {
      sprite: P.sprite,
      frame: P.frame,
      layers: z.array(z.union([z.number().int().min(0), z.string()])).optional().describe('Only these layers (default: all visible)'),
      coverage: z.number().min(0.05).max(0.95).optional().describe('Reference coverage needed for a pixel to count (default 0.25; raise to 0.5 for a stricter, chunkier silhouette)'),
      band: z.number().int().min(1).max(16).optional().describe('Rows per band in the edge table (default 4)'),
      colors: z.boolean().optional().describe('Compare colors zone by zone (default true)'),
      color_block: z.number().int().min(2).max(16).optional().describe('Zone size for the color comparison (default 6)'),
      guide: z.boolean().optional().describe('Draw the pose guide over the images'),
      scale: z.number().int().min(1).max(32).optional(),
    },
    (a) => {
      const s = ws.load(a.sprite);
      if (!s.reference) throw new Error('This sprite has no reference (use set_reference with remove_background: true)');
      const ref = referenceBitmap(s);
      const layerIds = a.layers?.map((l) => resolveLayer(s, l).id);
      const art = compositeFrame(s, a.frame ?? 0, layerIds ? { layerIds, includeHidden: true } : {});
      const d = silhouetteDiff(ref, art, {
        band: a.band,
        coverage: referenceCoverage(s),
        threshold: a.coverage,
        colorBlock: a.colors === false ? 0 : a.color_block,
      });
      const box = (b: SilhouetteDiff['ref']) => (b ? `x ${b.left}..${b.right}, y ${b.top}..${b.bottom}, center (${b.cx},${b.cy})` : 'empty');
      const reg = (r: { x0: number; y0: number; x1: number; y1: number; pixels: number; thin: boolean }) =>
        `x ${r.x0}..${r.x1} y ${r.y0}..${r.y1} (${r.pixels}px${r.thin ? ', thin detail' : ''})`;
      const rows = d.bands
        .map((b) => {
          const r = b.ref ? `${b.ref[0]}..${b.ref[1]}` : '—';
          const t = b.art ? `${b.art[0]}..${b.art[1]}` : '—';
          const notes: string[] = [];
          if (b.ref && b.art) {
            const dl = b.art[0] - b.ref[0];
            const dr = b.art[1] - b.ref[1];
            if (Math.abs(dl) >= 2) notes.push(dl > 0 ? `left edge ${dl}px inside` : `left edge ${-dl}px outside`);
            if (Math.abs(dr) >= 2) notes.push(dr < 0 ? `right edge ${-dr}px inside` : `right edge ${dr}px outside`);
          } else notes.push(b.ref ? 'missing in art' : 'not in reference');
          return notes.length ? `y ${b.y0}-${b.y1}: ref x ${r} | art x ${t} → ${notes.join(', ')}` : null;
        })
        .filter(Boolean);
      const big = (list: typeof d.missingRegions) => list.filter((r) => r.pixels >= 3).slice(0, 10);
      const add = big(d.missingRegions);
      const trim = big(d.extraRegions);
      const rvStats = valueStats(ref);
      const avStats = valueStats(art);
      const adviceCount = rvStats && avStats ? valueAdvice(rvStats, avStats).length : 0;
      const iouPct = Math.round(d.iou * 100);
      // Score history: every check saves a version, so a pass that made things worse can be undone at any time.
      const history = listVersions(a.sprite);
      const best = history.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou || x.advice - y.advice)[0];
      const raw = ws.readRaw(a.sprite);
      const saved = history[0]?.rev === raw.rev ? history[0] : saveVersion(a.sprite, raw, iouPct, adviceCount);
      let trend = '';
      if (best && (iouPct < best.iou - 2 || (iouPct <= best.iou && adviceCount > best.advice))) {
        trend = `⚠ WORSE than your best version: overlap ${iouPct}% vs ${best.iou}%${adviceCount > best.advice ? `, ${adviceCount} value warnings vs ${best.advice}` : ''} (version ${best.id}, ${best.time}). Unless this pass added something you need, restore it: restore_version sprite="${a.sprite}" id="${best.id}".`;
      } else if (best && iouPct > best.iou) trend = `✓ New best (previous best ${best.iou}%). Saved as version ${saved.id}.`;
      else trend = `Saved as version ${saved.id}.`;
      const summary = [
        `Overlap (IoU): ${iouPct}% — ${d.overlap} px shared, ${d.missing} missing (${d.thinMissing} of them thin details), ${d.extra} extra`,
        trend,
        `Reference: ${box(d.ref)}`,
        `Art:       ${box(d.art)}`,
        add.length ? `ADD (in the reference, missing in the art):\n${add.map((r) => '  ' + reg(r)).join('\n')}` : 'Nothing significant to add.',
        trim.length ? `TRIM (in the art, not in the reference):\n${trim.map((r) => '  ' + reg(r)).join('\n')}` : 'Nothing significant to trim.',
        rows.length ? `Edges that differ by 2px or more:\n${rows.join('\n')}` : 'All bands match within 1px.',
        (() => {
          const rv = rvStats;
          const av = avStats;
          if (!rv || !av) return '';
          const fmt = (v: typeof rv) => `dark ${Math.round(v.dark * 100)}% / mid ${Math.round(v.mid * 100)}% / light ${Math.round(v.light * 100)}%, L p10 ${v.p10} p50 ${v.p50} p90 ${v.p90}, chroma ${v.chroma}`;
          const advice = valueAdvice(rv, av);
          return `Values — ref: ${fmt(rv)}\n         art: ${fmt(av)}\n${advice.length ? advice.map((x) => '  → ' + x).join('\n') : '  → values match the reference'}`;
        })(),
        d.colors.length
          ? `Colors that differ (ΔE OKLab ≥ 0.06), worst first — where the reference has a different material in that zone (e.g. hair over a cheek) fix the shape, not the color:\n${d.colors.slice(0, 10).map((c) => `  x ${c.x0}..${c.x1} y ${c.y0}..${c.y1}: art ${c.art} vs ref ${c.ref} (Δ${c.delta}) → art is ${c.notes.join(', ') || 'off'}`).join('\n')}`
          : a.colors === false ? '' : 'Colors match the reference zone by zone.',
      ].filter(Boolean).join('\n');
      const pic = renderBitmapRows(s, [[ref, art, d.image]], { scale: a.scale, rulers: true, guide: a.guide && s.guide ? s.guide : undefined });
      return [...text(summary), image(encodePng(pic.image))];
    },
    {},
  );

  // ------------------------------------------------------------------ drawing

  tool(
    'draw_pixels',
    `Draw pixel art from a text grid — the main drawing tool. Each string in "rows" is one row of pixels starting at (x, y); each character is looked up in "legend" (single char → color).
Characters "." and " " not present in the legend leave pixels unchanged (so you can stamp shapes over existing art); map "." to "transparent" in the legend to erase instead.
Example legend: {"o":"#1a1c2c","s":"#f4b484","S":"#c2785c","h":"#5d275d"}.`,
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      x: z.number().int().optional().describe('Left of the grid (default 0)'),
      y: z.number().int().optional().describe('Top of the grid (default 0)'),
      tile: z.object({ col: z.number().int().min(0), row: z.number().int().min(0) }).optional().describe('Offset by the sprite tile grid: x += col*tile_width, y += row*tile_height'),
      rows: z.array(z.string()).min(1),
      legend: z.record(z.string(), z.string()),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const legend: Record<string, RGBA> = {};
        for (const [k, v] of Object.entries(a.legend)) {
          if (Array.from(k).length !== 1) throw new Error(`Legend keys must be single characters (got "${k}")`);
          legend[k] = color(s, v);
        }
        let x = a.x ?? 0;
        let y = a.y ?? 0;
        if (a.tile) {
          if (!s.grid) throw new Error('This sprite has no tile grid (create it with tile_width/tile_height)');
          x += a.tile.col * s.grid.width;
          y += a.tile.row * s.grid.height;
        }
        const { bmp } = cel(s, a.frame, a.layer);
        const r = drawGrid(bmp, x, y, a.rows, legend);
        const widths = new Set(a.rows.map((row) => Array.from(row).length));
        return { ...r, x, y, ragged: widths.size > 1 };
      });
      const notes = [`Drew ${result.changed} pixel(s) at (${result.x},${result.y}) on frame ${a.frame ?? 0}.`];
      if (result.skipped) notes.push(`${result.skipped} pixel(s) fell outside the ${sprite.width}x${sprite.height} canvas and were ignored.`);
      if (result.ragged) notes.push('Note: rows have different lengths.');
      return withPreview(text(notes.join(' ')), sprite, a.frame, a.preview);
    },
  );

  tool(
    'set_pixels',
    'Set individual pixels. Good for small fixes after looking at a preview.',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      pixels: z.array(z.object({ x: z.number().int(), y: z.number().int(), color: z.string() })).min(1),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const { bmp } = cel(s, a.frame, a.layer);
        let n = 0;
        for (const p of a.pixels) n += plot(bmp, [[p.x, p.y]], color(s, p.color));
        return n;
      });
      return withPreview(text(`Set ${result} pixel(s).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'draw_line',
    'Draw a 1px pixel-perfect line (or polyline through several points).',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      points: z.array(z.tuple([z.number().int(), z.number().int()])).min(2).describe('[[x,y],[x,y],...]'),
      color: P.color,
      brush: z.number().int().min(1).max(16).optional().describe('Brush size (default 1)'),
      preview: P.preview,
    },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const { bmp } = cel(s, a.frame, a.layer);
        const pts = a.points.slice(1).flatMap((p, i) => linePoints(a.points[i][0], a.points[i][1], p[0], p[1]));
        return plot(bmp, pts, color(s, a.color), a.brush);
      });
      return withPreview(text(`Line drawn (${result} pixels).`), sprite, a.frame, a.preview);
    },
  );

  const boxShape = {
    sprite: P.sprite,
    frame: P.frame,
    layer: P.layer,
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    color: P.color,
    filled: z.boolean().optional().describe('Fill the shape (default false: outline only)'),
    preview: P.preview,
  };

  tool('draw_rect', 'Draw a rectangle (outline or filled).', boxShape, (a) => {
    const { sprite } = mutate(a.sprite, (s) => {
      const { bmp } = cel(s, a.frame, a.layer);
      plot(bmp, rectPoints(a.x, a.y, a.x + a.width - 1, a.y + a.height - 1, !!a.filled), color(s, a.color));
    });
    return withPreview(text('Rectangle drawn.'), sprite, a.frame, a.preview);
  });

  tool('draw_ellipse', 'Draw an ellipse/circle inscribed in the given box (outline or filled).', boxShape, (a) => {
    const { sprite } = mutate(a.sprite, (s) => {
      const { bmp } = cel(s, a.frame, a.layer);
      plot(bmp, ellipsePoints(a.x, a.y, a.x + a.width - 1, a.y + a.height - 1, !!a.filled), color(s, a.color));
    });
    return withPreview(text('Ellipse drawn.'), sprite, a.frame, a.preview);
  });

  tool(
    'fill',
    'Bucket fill starting at (x, y) on one cel. With contiguous=false, replaces every pixel of the same color in the cel.',
    { sprite: P.sprite, frame: P.frame, layer: P.layer, x: z.number().int(), y: z.number().int(), color: P.color, contiguous: z.boolean().optional(), preview: P.preview },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => floodFill(cel(s, a.frame, a.layer).bmp, a.x, a.y, color(s, a.color), a.contiguous ?? true));
      return withPreview(text(`Filled ${result} pixel(s).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'replace_color',
    'Replace one color with another across frames/layers (recolors, palette swaps, enemy variants).',
    {
      sprite: P.sprite,
      from: P.color,
      to: P.color,
      frames: z.array(z.number().int().min(0)).optional().describe('Default: all frames'),
      layer: P.layer.describe('Default: all layers'),
    },
    (a) => {
      const { result } = mutate(a.sprite, (s) => {
        const from = color(s, a.from);
        const to = color(s, a.to);
        const frames = a.frames ?? s.frames.map((_, i) => i);
        const layers = a.layer !== undefined ? [resolveLayer(s, a.layer)] : s.layers;
        let n = 0;
        for (const f of frames) for (const l of layers) {
          const fr = resolveFrame(s, f);
          if (getCel(s, l.id, fr.id)) n += replaceColor(celBitmap(s, l.id, fr.id), from, to);
        }
        return n;
      });
      return text(`Replaced ${result} pixel(s).`);
    },
  );

  tool(
    'clear',
    'Erase pixels on one cel: the whole cel, or a rectangle.',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
    },
    (a) => {
      mutate(a.sprite, (s) => {
        const { bmp } = cel(s, a.frame, a.layer);
        const hasRect = a.x !== undefined || a.y !== undefined || a.width !== undefined || a.height !== undefined;
        clearRect(bmp, hasRect ? { x: a.x ?? 0, y: a.y ?? 0, width: a.width ?? s.width, height: a.height ?? s.height } : undefined);
      });
      return text('Cleared.');
    },
    { destructiveHint: true },
  );

  tool(
    'transform',
    'Shift, flip or rotate a cel (or a region of it). Shift is ideal for animation (bobbing, moving a limb by 1px).',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: P.layer,
      all_layers: z.boolean().optional().describe('Apply to every layer of the frame'),
      op: z.enum(['shift', 'flip_h', 'flip_v', 'rotate_180', 'rotate_cw', 'rotate_ccw']),
      dx: z.number().int().optional().describe('shift: pixels to move right (negative = left)'),
      dy: z.number().int().optional().describe('shift: pixels to move down (negative = up)'),
      wrap: z.boolean().optional().describe('shift: wrap around the edges'),
      region: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional(),
      preview: P.preview,
    },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => {
        const f = resolveFrame(s, a.frame);
        const layers = a.all_layers ? s.layers : [resolveLayer(s, a.layer)];
        for (const l of layers) {
          const bmp = celBitmap(s, l.id, f.id);
          if (a.op === 'shift') {
            if (a.region) {
              const part = extractRegion(bmp, a.region);
              clearRect(bmp, a.region);
              pasteBitmap(bmp, part, a.region.x + (a.dx ?? 0), a.region.y + (a.dy ?? 0), 'over');
            } else shift(bmp, a.dx ?? 0, a.dy ?? 0, a.wrap);
          } else transform(bmp, a.op, a.region);
        }
      });
      return withPreview(text(`Applied ${a.op}.`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'mirror',
    'Copy one half of a cel onto the other half, mirrored. Draw the left half of a front-facing character, then mirror left_to_right.',
    { sprite: P.sprite, frame: P.frame, layer: P.layer, direction: z.enum(['left_to_right', 'right_to_left', 'top_to_bottom', 'bottom_to_top']), preview: P.preview },
    (a) => {
      const { sprite } = mutate(a.sprite, (s) => mirror(cel(s, a.frame, a.layer).bmp, a.direction));
      return withPreview(text('Mirrored.'), sprite, a.frame, a.preview);
    },
  );

  tool(
    'outline',
    'Add an outline around everything drawn on a cel (fills transparent pixels touching opaque ones).',
    { sprite: P.sprite, frame: P.frame, layer: P.layer, color: P.color, diagonals: z.boolean().optional().describe('Also outline diagonally (thicker look)'), all_frames: z.boolean().optional(), preview: P.preview },
    (a) => {
      const { sprite, result } = mutate(a.sprite, (s) => {
        const frames = a.all_frames ? s.frames.map((_, i) => i) : [a.frame ?? 0];
        const l = resolveLayer(s, a.layer);
        let n = 0;
        for (const f of frames) n += outline(celBitmap(s, l.id, resolveFrame(s, f).id), color(s, a.color), a.diagonals);
        return n;
      });
      return withPreview(text(`Outlined (${result} pixels).`), sprite, a.frame, a.preview);
    },
  );

  tool(
    'copy_region',
    `Copy a rectangle of pixels from a cel (optionally of another sprite, e.g. a tileset) to one or more destinations.
Use it to stamp tiles into an environment, copy a body part between frames, or assemble scenes. Region defaults to the whole source canvas.`,
    {
      sprite: P.sprite.describe('Destination sprite'),
      source_sprite: z.string().optional().describe('Default: same sprite'),
      source_frame: z.number().int().min(0).optional(),
      source_layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Default: composite of all visible layers'),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
      source_tile: z.object({ col: z.number().int().min(0), row: z.number().int().min(0) }).optional().describe('Select a tile of the source sprite tile grid instead of x/y/width/height'),
      targets: z
        .array(z.object({ frame: z.number().int().min(0).optional(), layer: z.union([z.number().int().min(0), z.string()]).optional(), x: z.number().int(), y: z.number().int(), flip_h: z.boolean().optional() }))
        .min(1)
        .describe('Destination positions (top-left)'),
      mode: z.enum(['over', 'replace']).optional().describe('"over" (default) skips transparent source pixels'),
      preview: P.preview,
    },
    (a) => {
      const src = a.source_sprite && a.source_sprite !== a.sprite ? ws.load(a.source_sprite) : undefined;
      const { sprite } = mutate(a.sprite, (s) => {
        const from = src ?? s;
        let region = { x: a.x ?? 0, y: a.y ?? 0, width: a.width ?? from.width, height: a.height ?? from.height };
        if (a.source_tile) {
          if (!from.grid) throw new Error(`Sprite "${from.name}" has no tile grid`);
          region = { x: a.source_tile.col * from.grid.width, y: a.source_tile.row * from.grid.height, width: from.grid.width, height: from.grid.height };
        }
        const srcBmp: Bitmap =
          a.source_layer !== undefined
            ? celBitmap(from, resolveLayer(from, a.source_layer).id, resolveFrame(from, a.source_frame).id)
            : compositeFrame(from, a.source_frame ?? 0);
        const part = extractRegion(srcBmp, region);
        for (const t of a.targets) {
          let piece = part;
          if (t.flip_h) {
            piece = { ...part, data: new Uint8ClampedArray(part.data) };
            transform(piece, 'flip_h');
          }
          pasteBitmap(cel(s, t.frame, t.layer).bmp, piece, t.x, t.y, a.mode ?? 'over');
        }
      });
      return withPreview(text(`Copied region to ${a.targets.length} target(s).`), sprite, a.targets[0].frame, a.preview);
    },
  );

  // ------------------------------------------------------------------ reading

  tool(
    'read_pixels',
    'Read pixels back as a character grid + legend (same format as draw_pixels). Omit layer to read the composited frame.',
    {
      sprite: P.sprite,
      frame: P.frame,
      layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Default: all visible layers composited'),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
    },
    (a) => {
      const s = ws.load(a.sprite);
      const f = resolveFrame(s, a.frame);
      const bmp = a.layer !== undefined ? celBitmap(s, resolveLayer(s, a.layer).id, f.id) : compositeFrame(s, a.frame ?? 0);
      const x = a.x ?? 0;
      const y = a.y ?? 0;
      const region = { x, y, width: Math.min(a.width ?? s.width - x, 256), height: Math.min(a.height ?? s.height - y, 256) };
      const { rows, legend } = readGrid(bmp, region, s.palette);
      const bounds = contentBounds(bmp);
      return text(
        `Region x=${region.x} y=${region.y} ${region.width}x${region.height} ("." = transparent). Content bounds: ${bounds ? `x=${bounds.x} y=${bounds.y} ${bounds.width}x${bounds.height}` : 'empty'}\n` +
          `legend: ${JSON.stringify(legend)}\nrows:\n${rows.join('\n')}`,
      );
    },
    { readOnlyHint: true },
  );

  tool(
    'preview',
    'Render a zoomed PNG of one or more frames so you can see your work. Transparent areas show as a light checkerboard.',
    {
      sprite: P.sprite,
      frames: z.array(z.number().int().min(0)).optional().describe('Frames shown side by side (default [0])'),
      tag: z.string().optional().describe('Show all frames of an animation tag in order'),
      tags: z.array(z.string()).optional().describe('One row per tag (e.g. ["walk_down","walk_left","walk_right","walk_up"])'),
      all_frames: z.boolean().optional(),
      layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Show only this layer'),
      scale: z.number().int().min(1).max(32).optional(),
      background: z.string().optional().describe('"checker" (default), "transparent" or a color'),
      pixel_grid: z.boolean().optional().describe('Draw a pixel grid (helps counting pixels)'),
      rulers: z.boolean().optional().describe('Coordinate labels + a darker line every 4/8/16 px (default true)'),
      region: z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(1), height: z.number().int().min(1) }).optional().describe('Zoom into this canvas area (rulers keep canvas coordinates)'),
      onion: z.boolean().optional().describe('Previous frame of the row shown tinted red underneath (check motion arcs and spacing)'),
      diff: z.boolean().optional().describe('Highlight pixels that changed since the previous frame in magenta'),
      compare: z.boolean().optional().describe('Put the reference image (set_reference) in the first cell of every row'),
      underlay: z.number().min(0).max(1).optional().describe('Draw the reference under the art at this opacity'),
      guide: z.boolean().optional().describe('Draw the pose guide skeleton (pose_guide) over every cell'),
    },
    (a) => {
      const s = ws.load(a.sprite);
      const frames = a.all_frames ? s.frames.map((_, i) => i) : a.frames;
      const png = previewPng(s, {
        frames,
        tag: a.tag,
        tags: a.tags,
        scale: a.scale,
        background: a.background,
        pixelGrid: a.pixel_grid,
        rulers: a.rulers ?? true,
        region: a.region,
        onion: a.onion,
        diff: a.diff,
        compare: a.compare,
        underlay: a.underlay,
        guide: a.guide,
        layerId: a.layer !== undefined ? resolveLayer(s, a.layer).id : undefined,
      });
      const shown = a.tags?.length ? `rows: ${a.tags.join(', ')}` : frames?.length ? frames.join(', ') : a.tag ? `tag ${a.tag}` : '0';
      return [{ type: 'text', text: `"${s.name}" ${s.width}x${s.height}, frames: ${shown}` }, image(png)];
    },
    { readOnlyHint: true },
  );

  // ------------------------------------------------------------------ import / export

  tool(
    'export_spritesheet',
    'Export a spritesheet PNG plus Aseprite-compatible JSON (frame rects, durations, tags) for game engines.',
    {
      sprite: P.sprite,
      layout: z.enum(['horizontal', 'vertical', 'grid', 'tags']).optional().describe('"tags" = one row per animation tag'),
      columns: z.number().int().min(1).optional().describe('Columns for the grid layout'),
      padding: z.number().int().min(0).optional(),
      margin: z.number().int().min(0).optional(),
      scale: z.number().int().min(1).max(16).optional(),
      tag: z.string().optional().describe('Only this animation'),
      frames: z.array(z.number().int().min(0)).optional().describe('Only these frames (a single index exports a plain PNG of that frame)'),
      by_tag: z.boolean().optional().describe('Also write one sheet per tag'),
      out_dir: z.string().optional().describe('Output folder (default: <workspace>/export)'),
      base_name: z.string().optional().describe('File name without extension'),
    },
    (a) => {
      const s = ws.load(a.sprite);
      const opts = { layout: a.layout, columns: a.columns, padding: a.padding, margin: a.margin, scale: a.scale, tag: a.tag, frames: a.frames, outDir: a.out_dir, baseName: a.base_name };
      const results = [exportSpritesheet(ws, s, opts)];
      if (a.by_tag) for (const t of s.tags) results.push(exportSpritesheet(ws, s, { ...opts, layout: a.layout === 'tags' ? 'horizontal' : a.layout, tag: t.name, baseName: undefined }));
      return text(results.map((r) => `${r.png} (${r.width}x${r.height}, ${r.frames} frames)\n${r.json}`).join('\n'));
    },
  );

  tool(
    'import_png',
    'Create a sprite from a PNG file. Give frame_width/frame_height to slice an existing spritesheet into frames.',
    {
      path: z.string().describe('Path to a .png file'),
      name: z.string().describe('New sprite name'),
      frame_width: z.number().int().min(1).optional(),
      frame_height: z.number().int().min(1).optional(),
      overwrite: z.boolean().optional(),
    },
    (a) => {
      if (ws.exists(a.name) && !a.overwrite) throw new Error(`Sprite "${a.name}" already exists`);
      const s = spriteFromPng(a.name, fs.readFileSync(path.resolve(a.path)), { frameWidth: a.frame_width, frameHeight: a.frame_height });
      remember(a.name, ws.exists(a.name) ? ws.readRaw(a.name) : null);
      // Seed the palette with the colors actually used.
      s.palette = colorHistogram(compositeFrame(s, 0)).slice(0, 64).map((c) => c.color);
      ws.save(s, AUTHOR);
      return text(`Imported.\n${describe(s, true)}`);
    },
  );

  // ------------------------------------------------------------------ misc

  tool('undo', 'Undo your most recent change(s) to a sprite made through this MCP server.', { sprite: P.sprite, steps: z.number().int().min(1).optional() }, (a) => {
    const stack = history.get(a.sprite) ?? [];
    const steps = Math.min(a.steps ?? 1, stack.length);
    if (!steps) throw new Error(`Nothing to undo for "${a.sprite}"`);
    let snapshot = 'null';
    for (let i = 0; i < steps; i++) snapshot = stack.pop()!;
    if (snapshot === 'null') {
      if (ws.exists(a.sprite)) ws.remove(a.sprite);
      return text(`Undid ${steps} step(s): "${a.sprite}" no longer exists.`);
    }
    const file = JSON.parse(snapshot) as SpriteFile;
    file.rev = newId();
    file.updatedBy = AUTHOR;
    ws.writeRaw(file);
    return text(`Undid ${steps} step(s). ${stack.length} more available.`);
  });

  // ------------------------------------------------------------------ projects

  const registry = opts.registry ?? new ProjectRegistry({ root: defaultProjectsRoot(), defaultDir: ws.dir });
  registry.seed(ws);
  let projectId = registry.idFor(ws.dir);
  const projectUrl = () => {
    const url = opts.editorUrl?.();
    return url ? `${url}/?project=${encodeURIComponent(projectId)}#/` : undefined;
  };

  tool('editor_url', 'Get the URL of the Spritifer web editor showing the current project, where the user sees your changes live.', {}, () => {
    const url = projectUrl();
    return text(url ? `Editor: ${url}\nProject: ${projectId} (${ws.dir})` : `The editor is not running in this process. Start it with \`npx spritifer serve\`. Project folder: ${ws.dir}`);
  }, { readOnlyHint: true });

  // Every tool works on the current project: the game tools see it through this proxy.
  const currentWs = new Proxy({} as Workspace, {
    get: (_t, p) => {
      const v = (ws as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(ws) : v;
    },
  });
  const game = registerGameTools(currentWs, { tool, text, image });

  const describeProject = (p: ProjectInfo) => `${p.id === projectId ? '* ' : '  '}${p.id}: "${p.name}" — ${p.sprites} sprites, ${p.scenes} scenes, ${p.scripts} scripts — ${p.dir}`;

  tool('list_projects', 'List the game projects (folders with their own sprites, scenes, scripts and game.json). * marks the current one.', {}, () => {
    return text(`Projects (new ones go in ${registry.root}):\n${registry.list().map(describeProject).join('\n')}`);
  }, { readOnlyHint: true });

  const switchTo = (p: ProjectInfo) => {
    ws = registry.get(p.id);
    projectId = p.id;
    history.clear();
    game.reset();
    const url = projectUrl();
    return text(`Current project: ${p.id} "${p.name}" — ${p.sprites} sprites, ${p.scenes} scenes, ${p.scripts} scripts — ${p.dir}${url ? `\nEditor: ${url}` : ''}\nAll tools now work on this project.`);
  };

  tool('open_project', 'Switch to another project by id, title or folder path (an existing folder that is not listed yet gets added). All tools then work on it.', { project: z.string() }, (a) => switchTo(registry.resolve(a.project)));

  tool(
    'create_project',
    `Create a new game project folder in ${'the projects folder'} and switch to it. Templates: ${TEMPLATES.map((t) => `${t.id} (${t.description})`).join('; ')}.`,
    { name: z.string().describe('Game title, e.g. "Dungeon Quest"'), template: z.enum(['empty', 'platformer', 'rpg']).optional() },
    (a) => switchTo(registry.create(a.name, a.template ?? 'empty')),
  );

  return server;
}
