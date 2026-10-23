import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { PALETTES, type RGBA, normalizeHex, parseColor } from '../core/color.js';
import {
  type Anchor,
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
  replaceColor,
  shift,
  transform,
} from '../core/draw.js';
import { exportSpritesheet, previewPng, spriteFromPng } from './ops.js';
import type { Workspace } from './store.js';

const VERSION = '0.1.0';
const AUTHOR = 'claude';
const HISTORY_LIMIT = 40;

export const INSTRUCTIONS = `Spritifer is a pixel-art and animation editor. Sprites live as *.sprite.json files in a workspace folder and are shown live in the Spritifer web editor (see editor_url), so the user watches you draw.

Model: a sprite has a fixed canvas (width x height), a palette, layers (index 0 = bottom) and frames (index 0 = first). Each (layer, frame) pair is a "cel" of RGBA pixels. Tags name frame ranges as animations ("idle", "walk", ...). Coordinates are pixels, origin top-left, x to the right, y down.

Colors: "#rrggbb", "#rrggbbaa", "transparent", or a palette index like "p3" / "3".

Recommended workflow for characters:
1. create_sprite with a small canvas (16x16, 24x24, 32x32, 48x48 are typical) and a limited palette (or set_palette).
2. Draw the base frame with draw_pixels: rows of characters + a legend. Keep a 1px dark outline, 2-4 shades per material, light from the top-left.
3. preview (with pixel_grid) to look at the result and fix mistakes with set_pixels / draw_pixels.
4. Animate: add_frames with copy_from to duplicate a frame, then edit only what moves (transform shift for bobbing, redraw legs/arms). set_tag to name each animation, set_frame_duration for timing.
5. preview with tag to check the sequence, then export_spritesheet (PNG + Aseprite-compatible JSON for Phaser/Godot/Unity).

Environments / tilesets: create_sprite with tile_width/tile_height (e.g. a 128x128 tileset of 16x16 tiles), draw each tile with draw_pixels using the "tile" param, then build scenes on a bigger canvas by stamping tiles with copy_region (source_sprite = the tileset). Use separate layers for background, terrain, props.

Every change is saved immediately; undo reverts your own recent changes.`;

type Content = CallToolResult['content'];

/** Builds an MCP server exposing drawing tools over a workspace. */
export function createMcpServer(ws: Workspace, opts: { editorUrl?: () => string | undefined } = {}): McpServer {
  const server = new McpServer({ name: 'spritifer', version: VERSION }, { instructions: INSTRUCTIONS });
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

  const color = (s: Sprite | undefined, c: string): RGBA => parseColor(c, s?.palette);

  const text = (t: string): Content => [{ type: 'text', text: t }];

  const image = (png: Buffer): Content[number] => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });

  const withPreview = (content: Content, sprite: Sprite, frame: number | undefined, want?: boolean): Content =>
    want ? [...content, image(previewPng(sprite, { frames: [frame ?? 0], pixelGrid: true }))] : content;

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
      mutate(a.sprite, (s) => resizeCanvas(s, a.width, a.height, (a.anchor ?? 'center') as Anchor));
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
      all_frames: z.boolean().optional(),
      layer: z.union([z.number().int().min(0), z.string()]).optional().describe('Show only this layer'),
      scale: z.number().int().min(1).max(32).optional(),
      background: z.string().optional().describe('"checker" (default), "transparent" or a color'),
      pixel_grid: z.boolean().optional().describe('Draw a pixel grid (helps counting pixels)'),
    },
    (a) => {
      const s = ws.load(a.sprite);
      const frames = a.all_frames ? s.frames.map((_, i) => i) : a.frames;
      const png = previewPng(s, {
        frames,
        tag: a.tag,
        scale: a.scale,
        background: a.background,
        pixelGrid: a.pixel_grid,
        layerId: a.layer !== undefined ? resolveLayer(s, a.layer).id : undefined,
      });
      const shown = frames?.length ? frames.join(', ') : a.tag ? `tag ${a.tag}` : '0';
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

  tool('editor_url', 'Get the URL of the Spritifer web editor where the user can see and edit the sprites live.', {}, () => {
    const url = opts.editorUrl?.();
    return text(url ? `Editor: ${url}\nWorkspace: ${ws.dir}` : `The editor is not running in this process. Start it with \`npx spritifer serve\`. Workspace: ${ws.dir}`);
  }, { readOnlyHint: true });

  return server;
}
