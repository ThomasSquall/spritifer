import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Workspace } from '../src/server/store.js';
import { createMcpServer } from '../src/server/mcp.js';
import { encodePng } from '../src/server/png.js';
import { type Bitmap, celBitmap, resolveLayer } from '../src/core/sprite.js';
import { getPixel, setPixel } from '../src/core/draw.js';
import { parseColor } from '../src/core/color.js';
import { kmeansPalette, pixelize } from '../src/core/pixelize.js';
import { antialiasEdge, castShadow, formShade, luminance, shapeCoverage, shapeMask, valueAdvice, valueStats, maskFromCoverage } from '../src/core/shapes.js';

const blank = (w: number, h: number): Bitmap => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
const fill = (b: Bitmap, x0: number, y0: number, x1: number, y1: number, c: [number, number, number, number]) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPixel(b, x, y, c);
};

describe('pixelize', () => {
  it('keeps crisp colors (no blended in-betweens) and outlines', () => {
    // 40x40 picture: orange square with a 2px dark outline, on transparent.
    const src = blank(40, 40);
    fill(src, 8, 8, 32, 32, [20, 16, 30, 255]);
    fill(src, 10, 10, 30, 30, [230, 120, 40, 255]);
    fill(src, 10, 10, 30, 14, [250, 200, 120, 255]); // a lit band
    const palette = kmeansPalette(src, 3);
    expect(palette).toHaveLength(3);
    const out = pixelize(src, { width: 10, height: 10, palette });
    const colors = new Set<string>();
    for (let i = 0; i < 100; i++) if (out.data[i * 4 + 3]) colors.add(Array.from(out.data.slice(i * 4, i * 4 + 3)).join(','));
    // Only palette colors, never averages.
    for (const c of colors) expect(palette.map((p) => p.slice(0, 3).join(','))).toContain(c);
    // The 2px outline (half a target pixel) survives thanks to the line bias.
    expect(getPixel(out, 2, 5)).toEqual([20, 16, 30, 255]);
    expect(getPixel(out, 5, 5)).toEqual([230, 120, 40, 255]);
    expect(getPixel(out, 0, 0)[3]).toBe(0);
  });
});

describe('volume, shadows and anti-aliasing', () => {
  const ramp = ['#202040', '#404080', '#6060c0', '#9090f0', '#d0d0ff'].map((c) => parseColor(c));

  it('form shading wraps light around a sphere', () => {
    const b = blank(20, 20);
    const m = shapeMask({ type: 'ellipse', center: [10, 10], rx: 8, ry: 8 }, 20, 20);
    formShade(b, m, { ramp, mode: 'form' });
    expect(luminance(getPixel(b, 6, 6))).toBeGreaterThan(luminance(getPixel(b, 10, 10)) - 0.01);
    expect(luminance(getPixel(b, 14, 14))).toBeLessThan(luminance(getPixel(b, 10, 10)));
    // The far edge is darker than the near edge.
    expect(luminance(getPixel(b, 16, 13))).toBeLessThan(luminance(getPixel(b, 4, 7)));
  });

  it('casts a shadow on what lies under a shape, away from the light', () => {
    const skin = ['#603020', '#a05030', '#e08050'].map((c) => parseColor(c));
    const b = blank(12, 12);
    fill(b, 0, 0, 12, 12, skin[2]);
    const m = shapeMask({ type: 'polygon', points: [[2, 2], [6, 2], [6, 6], [2, 6]] }, 12, 12);
    castShadow(b, m, [skin], [-1, -1], 2);
    expect(getPixel(b, 6, 6)).toEqual(skin[1]); // just below-right of the shape
    expect(getPixel(b, 9, 9)).toEqual(skin[2]); // beyond the shadow length
    expect(getPixel(b, 1, 1)).toEqual(skin[2]); // lit side untouched
  });

  it('anti-aliases a shape edge with palette colors only', () => {
    const palette = ['#000000', '#ffffff', '#808080'].map((c) => parseColor(c));
    const b = blank(16, 16);
    fill(b, 0, 0, 16, 16, palette[0]);
    const before: Bitmap = { width: 16, height: 16, data: new Uint8ClampedArray(b.data) };
    const sh = { type: 'ellipse' as const, center: [8, 8] as [number, number], rx: 5, ry: 5 };
    const cov = shapeCoverage(sh, 16, 16);
    const m = maskFromCoverage(cov, 16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (m.data[y * 16 + x]) setPixel(b, x, y, palette[1]);
    const n = antialiasEdge(b, before, m, cov, palette);
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < 256; i++) expect(['0,0,0', '255,255,255', '128,128,128']).toContain(Array.from(b.data.slice(i * 4, i * 4 + 3)).join(','));
  });

  it('compares values and gives advice', () => {
    const ref = blank(10, 10);
    const art = blank(10, 10);
    fill(ref, 0, 0, 10, 5, [20, 20, 30, 255]);
    fill(ref, 0, 5, 10, 10, [240, 230, 220, 255]);
    fill(art, 0, 0, 10, 10, [140, 130, 120, 255]);
    const advice = valueAdvice(valueStats(ref)!, valueStats(art)!);
    expect(advice.join(' ')).toContain('low value contrast');
    expect(advice.join(' ')).toContain('darkest tones too light');
  });
});

describe('pixelize MCP tool', () => {
  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-px-'));
    ws = new Workspace(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('converts a picture onto a layer, sets the reference and supports form shading with cast shadows', async () => {
    const img = blank(80, 120);
    fill(img, 0, 0, 80, 120, [44, 44, 48, 255]);
    fill(img, 20, 10, 60, 110, [20, 16, 30, 255]);
    fill(img, 24, 14, 56, 60, [230, 160, 120, 255]);
    fill(img, 24, 60, 56, 106, [50, 90, 190, 255]);
    const file = path.join(dir, 'concept.png');
    fs.writeFileSync(file, encodePng(img));
    await call('create_sprite', { name: 'hero', width: 32, height: 48 });
    const r = await call('pixelize', { sprite: 'hero', path: file, height: 40, colors: 6 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const s = ws.load('hero');
    expect(s.layers.map((l) => l.name)).toContain('pixelized');
    expect(s.reference?.height).toBe(40);
    const bmp = celBitmap(s, resolveLayer(s, 'pixelized').id, s.frames[0].id);
    expect(getPixel(bmp, 16, 46)[3]).toBe(0);
    expect(getPixel(bmp, 16, 30)).toEqual([50, 90, 190, 255]);
    // The palette now holds only the colors in use (the default palette is gone).
    expect(s.palette.length).toBeLessThanOrEqual(6);
    expect(s.palette).toContain('#325abe');

    await call('set_ramp', { sprite: 'hero', name: 'skin', base: '#e6a078' });
    const shapes = await call('draw_shapes', {
      sprite: 'hero',
      layer: 'pixelized',
      shapes: [{ type: 'ellipse', center: [16, 18], rx: 5, ry: 5, shade: { ramp: 'skin', mode: 'form', rim: true }, cast_shadow: 2, aa: true }],
    });
    expect(shapes.isError, textOf(shapes)).toBeFalsy();
    const check = await call('silhouette_check', { sprite: 'hero' });
    expect(textOf(check)).toContain('Values — ref:');
  });

  it('saves scored versions, warns when a pass makes things worse and restores the best one', async () => {
    const img = blank(40, 60);
    fill(img, 0, 0, 40, 60, [44, 44, 48, 255]);
    fill(img, 10, 10, 30, 55, [20, 16, 30, 255]);
    fill(img, 12, 12, 28, 53, [200, 120, 80, 255]);
    const file = path.join(dir, 'c.png');
    fs.writeFileSync(file, encodePng(img));
    await call('create_sprite', { name: 'v', width: 32, height: 48 });
    await call('pixelize', { sprite: 'v', path: file, height: 40, colors: 4 });
    const first = textOf(await call('silhouette_check', { sprite: 'v' }));
    expect(first).toMatch(/Saved as version \d+/);
    // A bad pass: wipe half the figure.
    await call('clear', { sprite: 'v', layer: 'pixelized', x: 0, y: 0, width: 16, height: 48 });
    const worse = textOf(await call('silhouette_check', { sprite: 'v' }));
    expect(worse).toContain('WORSE than your best version');
    const id = /restore_version sprite="v" id="(\d+)"/.exec(worse)![1];
    expect(textOf(await call('versions', { sprite: 'v' }))).toContain('← best');
    expect((await call('restore_version', { sprite: 'v', id })).isError).toBeFalsy();
    expect(textOf(await call('silhouette_check', { sprite: 'v' }))).not.toContain('WORSE');
  });

  it('lint ignores dark interior masses when counting doubled outlines', async () => {
    await call('create_sprite', { name: 'dark', width: 12, height: 12 });
    await call('draw_shapes', { sprite: 'dark', shapes: [{ type: 'polygon', points: [[1, 1], [11, 1], [11, 11], [1, 11]], fill: '#101018' }] });
    await call('draw_shapes', { sprite: 'dark', shapes: [{ type: 'polygon', points: [[2, 2], [5, 2], [5, 5], [2, 5]], fill: '#c08060' }] });
    const lint = textOf(await call('lint', { sprite: 'dark', outline: '#101018' }));
    const doubles = /Outline 2x2 doubles \((\d+)\)/.exec(lint)![1];
    // Only blocks touching the silhouette count, not the dark interior.
    expect(Number(doubles)).toBeLessThan(40);
  });
});
