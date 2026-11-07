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
import {
  findJaggies,
  generateRamp,
  lintBitmap,
  luminance,
  removeBackground,
  silhouetteDiff,
  maskCount,
  maskHas,
  paintArc,
  selout,
  shadeMask,
  shapeMask,
} from '../src/core/shapes.js';
import { interpolateKeyframes } from '../src/core/animate.js';

const blank = (w: number, h: number): Bitmap => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

describe('shapes', () => {
  it('rasterizes a tapered capsule', () => {
    const m = shapeMask({ type: 'capsule', from: [5, 2], to: [5, 12], r1: 3, r2: 1 }, 16, 16);
    expect(maskHas(m, 5, 2)).toBe(true);
    expect(maskHas(m, 8, 2)).toBe(true); // radius 3 at the top
    expect(maskHas(m, 7, 12)).toBe(false); // radius 1 at the bottom
    expect(maskHas(m, 6, 12)).toBe(true);
  });

  it('draws pixel-perfect 1px curves without L-corners', () => {
    const m = shapeMask({ type: 'spline', points: [[1, 14], [6, 4], [14, 1]] }, 16, 16);
    const b = blank(16, 16);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (maskHas(m, x, y)) setPixel(b, x, y, [0, 0, 0, 255]);
    expect(maskCount(m)).toBeGreaterThan(10);
    expect(findJaggies(b, [0, 0, 0, 255])).toEqual([]);
  });

  it('paints a crescent smear thickest in the middle with an outer-to-inner gradient', () => {
    const b = blank(32, 32);
    const arc = { type: 'arc' as const, center: [16, 16] as [number, number], radius: 12, from: 180, to: 360, width: 4 };
    paintArc(b, arc, [[255, 255, 255, 255], [100, 180, 255, 255]]);
    // Top of the circle (270°) is the middle of the arc: outer edge white, inner edge blue.
    expect(getPixel(b, 16, 4)).toEqual([255, 255, 255, 255]);
    expect(getPixel(b, 16, 7)).toEqual([100, 180, 255, 255]);
    // Ends taper away; the lower half is empty.
    expect(getPixel(b, 16, 28)[3]).toBe(0);
  });

  it('generates hue-shifted ramps darkest first', () => {
    const ramp = generateRamp(parseColor('#40a040'), { steps: 5 });
    expect(ramp).toHaveLength(5);
    const lum = ramp.map((c) => luminance(parseColor(c)));
    expect([...lum].sort((a, b) => a - b)).toEqual(lum);
    // Green shadows drift toward blue, highlights toward yellow.
    const [, g0, b0] = parseColor(ramp[0]);
    const [r2, g2, b2] = parseColor(ramp[2]);
    const [r4, g4] = parseColor(ramp[4]);
    expect(b0 / g0).toBeGreaterThan(b2 / g2);
    expect(r4 / g4).toBeGreaterThan(r2 / g2);
  });

  it('shades forms away from the light without pillow shading', () => {
    const b = blank(12, 12);
    const m = shapeMask({ type: 'ellipse', center: [6, 6], rx: 5, ry: 5 }, 12, 12);
    const ramp = ['#202040', '#404080', '#6060c0', '#9090f0', '#d0d0ff'].map((c) => parseColor(c));
    shadeMask(b, m, { ramp });
    expect(luminance(getPixel(b, 3, 3))).toBeGreaterThan(luminance(getPixel(b, 9, 9)));
    // The center keeps the base color.
    expect(getPixel(b, 6, 6)).toEqual(ramp[2]);
  });

  it('selout recolors interior outlines with the enclosed material', () => {
    const o: [number, number, number, number] = [10, 10, 10, 255];
    const skin = ['#603020', '#a05030', '#e08050'].map((c) => parseColor(c));
    const b = blank(5, 3);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 3; y++) setPixel(b, x, y, x === 2 ? o : skin[2]);
    selout(b, o, [skin], [-1, -1]);
    expect(getPixel(b, 2, 1)).toEqual(skin[0]);
  });

  it('lints orphans and silhouette pixels without outline', () => {
    const b = blank(8, 8);
    setPixel(b, 1, 1, [0, 0, 0, 255]);
    for (let x = 4; x < 7; x++) for (let y = 4; y < 7; y++) setPixel(b, x, y, [250, 200, 100, 255]);
    const r = lintBitmap(b);
    // A lone dark pixel on transparency is a high-contrast accent, not noise.
    expect(r.accents).toContainEqual([1, 1]);
    expect(r.orphans).toEqual([]);
    expect(r.unoutlined.length).toBe(8);
  });
});

describe('reference silhouettes', () => {
  it('removes a gridded background but keeps dark pixels inside the figure', () => {
    const img = blank(20, 20);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) setPixel(img, x, y, x % 5 === 0 ? [26, 26, 30, 255] : [42, 42, 46, 255]);
    for (let y = 5; y < 15; y++) for (let x = 6; x < 14; x++) setPixel(img, x, y, x === 6 || x === 13 || y === 5 || y === 14 ? [20, 14, 30, 255] : [200, 90, 40, 255]);
    setPixel(img, 9, 9, [30, 30, 34, 255]); // a dark pixel inside the figure
    const out = removeBackground(img);
    expect(getPixel(out, 1, 1)[3]).toBe(0);
    expect(getPixel(out, 10, 10)[3]).toBe(255);
    expect(getPixel(out, 9, 9)[3]).toBe(255);
  });

  it('reports overlap and edge differences band by band', () => {
    const ref = blank(16, 16);
    const art = blank(16, 16);
    for (let y = 2; y < 14; y++) for (let x = 4; x < 12; x++) setPixel(ref, x, y, [255, 0, 0, 255]);
    for (let y = 2; y < 14; y++) for (let x = 6; x < 12; x++) setPixel(art, x, y, [0, 0, 255, 255]);
    const d = silhouetteDiff(ref, art, 4);
    expect(d.missing).toBe(24);
    expect(d.extra).toBe(0);
    expect(d.iou).toBeCloseTo(72 / 96);
    expect(d.bands[0]).toMatchObject({ ref: [4, 11], art: [6, 11] });
    expect(getPixel(d.image, 4, 5)).toEqual([40, 210, 110, 255]);
  });
});

describe('grid backgrounds and lint noise', () => {
  it('removes a neutral grid background but keeps a tinted dark outline crossed by grid lines', () => {
    const img = blank(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const line = x % 10 < 2 || y % 10 < 2;
      setPixel(img, x, y, line ? [14, 14, 14, 255] : [42, 42, 42, 255]);
    }
    // Figure: warm near-black outline around an orange body, crossed by the grid line at y 20-21.
    for (let y = 12; y < 30; y++) for (let x = 13; x < 27; x++) {
      const edge = x === 13 || x === 26 || y === 12 || y === 29;
      setPixel(img, x, y, edge ? [26, 8, 5, 255] : [210, 110, 50, 255]);
    }
    const out = removeBackground(img);
    expect(getPixel(out, 5, 5)[3]).toBe(0); // background fill
    expect(getPixel(out, 1, 30)[3]).toBe(0); // grid line
    expect(getPixel(out, 13, 20)[3]).toBe(255); // outline where a grid line crosses it
    expect(getPixel(out, 20, 20)).toEqual([210, 110, 50, 255]);
    let leftovers = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x < 12 || x > 27 || y < 11 || y > 30) && getPixel(out, x, y)[3]) leftovers++;
    expect(leftovers).toBe(0);
  });

  it('tells noise pixels from deliberate accents', () => {
    const b = blank(9, 9);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) setPixel(b, x, y, [120, 80, 60, 255]);
    setPixel(b, 2, 2, [126, 84, 64, 255]); // almost the same color: noise
    setPixel(b, 6, 6, [255, 255, 255, 255]); // a glint: accent
    const r = lintBitmap(b);
    expect(r.orphans).toEqual([[2, 2]]);
    expect(r.accents).toEqual([[6, 6]]);
  });
});

describe('fine details and colors', () => {
  it('keeps thin, partly covered reference details and reports them as regions to add', () => {
    const ref = blank(12, 12);
    const art = blank(12, 12);
    for (let y = 4; y < 12; y++) for (let x = 3; x < 9; x++) { setPixel(ref, x, y, [200, 100, 50, 255]); setPixel(art, x, y, [200, 100, 50, 255]); }
    // A 1-pixel spike on top that a high-res source covers only ~40%.
    const coverage = Float32Array.from({ length: 144 }, (_, i) => (ref.data[i * 4 + 3] ? 1 : 0));
    for (let y = 0; y < 4; y++) coverage[y * 12 + 5] = 0.4;
    const strict = silhouetteDiff(ref, art, { coverage, threshold: 0.5, colorBlock: 0 });
    expect(strict.missing).toBe(0);
    const d = silhouetteDiff(ref, art, { coverage, colorBlock: 0 });
    expect(d.missing).toBe(4);
    expect(d.thinMissing).toBe(4);
    expect(d.missingRegions[0]).toMatchObject({ x0: 5, x1: 5, y0: 0, y1: 3, thin: true });
  });

  it('describes color differences zone by zone', () => {
    const ref = blank(12, 12);
    const art = blank(12, 12);
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) { setPixel(ref, x, y, [130, 60, 50, 255]); setPixel(art, x, y, [230, 130, 50, 255]); }
    const d = silhouetteDiff(ref, art, { colorBlock: 6 });
    expect(d.colors).toHaveLength(4);
    expect(d.colors[0].notes).toContain('lighter');
    expect(d.colors[0].ref).toBe('#823c32');
  });
});

describe('keyframes', () => {
  it('interpolates with easing, holds steps and loops back', () => {
    const lin = interpolateKeyframes([{ frame: 0, parts: { arm: { rot: 0 } }, ease: 'linear' }, { frame: 4, parts: { arm: { rot: 80, variant: 'fist' } } }], 6, false);
    expect(lin.map((p) => p.arm?.rot ?? 0)).toEqual([0, 20, 40, 60, 80, 80]);
    expect(lin[3].arm.variant).toBeUndefined();
    expect(lin[4].arm.variant).toBe('fist');
    const loop = interpolateKeyframes([{ frame: 0, parts: { body: { dy: 0 } }, ease: 'linear' }, { frame: 2, parts: { body: { dy: 2 } }, ease: 'linear' }], 4, true);
    expect(loop.map((p) => p.body?.dy ?? 0)).toEqual([0, 1, 2, 1]);
    const hold = interpolateKeyframes([{ frame: 2, parts: { body: { dy: 3 } } }], 4, false);
    expect(hold.map((p) => p.body?.dy ?? 0)).toEqual([3, 3, 3, 3]);
  });
});

describe('form & material MCP tools', () => {
  let dir: string;
  let ws: Workspace;
  let client: Client;
  type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spritifer-shapes-'));
    ws = new Workspace(dir);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([createMcpServer(ws).connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('draws shaded shapes with ramps, cleans and lints them', async () => {
    await call('create_sprite', { name: 'orb', width: 24, height: 24 });
    const ramp = await call('set_ramp', { sprite: 'orb', name: 'cloth', base: '#3a64c8' });
    expect(textOf(ramp)).toContain('cloth.4=');
    const drawn = await call('draw_shapes', {
      sprite: 'orb',
      shapes: [
        { type: 'ellipse', center: [12, 12], rx: 8, ry: 8, shade: { ramp: 'cloth' }, outline: '#101018' },
        { type: 'capsule', from: [4, 20], to: [10, 14], r1: 1.5, fill: 'cloth.0' },
        { type: 'arc', center: [12, 12], radius: 11, start: 200, end: 340, width: 3, colors: ['#ffffff', '#a0d0ff'] },
      ],
      preview: true,
    });
    expect(drawn.isError, textOf(drawn)).toBeFalsy();
    expect(textOf(drawn)).not.toContain('Warnings');
    const thin = await call('draw_shapes', {
      sprite: 'orb',
      shapes: [
        { type: 'line', points: [[2, 2], [10, 2]], width: 1.5, fill: '#ffffff' },
        { type: 'polygon', points: [[2, 20], [14, 20], [14, 22], [2, 22]], fill: 'cloth.2', outline: '#101018' },
      ],
    });
    expect(textOf(thin)).toContain('width 1.5 rasterizes about 2px');
    expect(textOf(thin)).toMatch(/shape 1 \(polygon\) is \d+% outline/);
    expect(drawn.content.some((c) => c.type === 'image')).toBe(true);
    const s = ws.load('orb');
    const bmp = celBitmap(s, resolveLayer(s).id, s.frames[0].id);
    expect(getPixel(bmp, 12, 4)).toEqual([16, 16, 24, 255]); // outline at the top of the ellipse
    expect(s.ramps.cloth).toHaveLength(5);

    expect((await call('selout', { sprite: 'orb', outline: '#101018' })).isError).toBeFalsy();
    expect((await call('cleanup', { sprite: 'orb' })).isError).toBeFalsy();
    const lint = textOf(await call('lint', { sprite: 'orb' }));
    expect(lint).toContain('Noise pixels');
    expect(lint).toContain('Accent pixels');
    expect(lint).toContain('Colors:');

    const shaded = await call('shade', { sprite: 'orb', colors: ['cloth.0'], ramp: 'cloth' });
    expect(shaded.isError, textOf(shaded)).toBeFalsy();

    const zoom = await call('preview', { sprite: 'orb', region: { x: 4, y: 4, width: 8, height: 8 }, scale: 10 });
    expect(zoom.isError).toBeFalsy();
  });

  it('attaches a reference and compares against it', async () => {
    const img: Bitmap = { width: 40, height: 80, data: new Uint8ClampedArray(40 * 80 * 4) };
    for (let y = 10; y < 70; y++) for (let x = 10; x < 30; x++) setPixel(img, x, y, y < 30 ? [240, 180, 120, 255] : [40, 80, 200, 255]);
    const file = path.join(dir, 'ref.png');
    fs.writeFileSync(file, encodePng(img));
    await call('create_sprite', { name: 'hero', width: 32, height: 32 });
    const r = await call('set_reference', { sprite: 'hero', path: file, crop: { x: 10, y: 10, width: 20, height: 60 }, height: 30, palette: 4, to_layer: 'trace' });
    expect(r.isError, textOf(r)).toBeFalsy();
    const s = ws.load('hero');
    expect(s.reference).toMatchObject({ width: 10, height: 30, x: 11, y: 2 });
    expect(s.palette.length).toBeLessThanOrEqual(4);
    expect(s.layers.map((l) => l.name)).toContain('trace');
    expect((await call('preview', { sprite: 'hero', compare: true, underlay: 0.3 })).isError).toBeFalsy();
    // Saved through the file format.
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'hero.sprite.json'), 'utf8')).reference.width).toBe(10);
  });

  it('places a pose guide and checks the silhouette against the reference', async () => {
    const img: Bitmap = { width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) };
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) setPixel(img, x, y, [40, 40, 44, 255]);
    for (let y = 8; y < 36; y++) for (let x = 14; x < 26; x++) setPixel(img, x, y, [230, 120, 60, 255]);
    const file = path.join(dir, 'fig.png');
    fs.writeFileSync(file, encodePng(img));
    await call('create_sprite', { name: 'fig', width: 40, height: 40 });
    expect((await call('set_reference', { sprite: 'fig', path: file, height: 40, remove_background: true })).isError).toBeFalsy();
    const g = await call('pose_guide', { sprite: 'fig', joints: { head: [20, 9], neck: [20, 15], pelvis: [20, 26], hip_f: [18, 26], knee_f: [18, 31], foot_f: [18, 35] } });
    expect(g.isError, textOf(g)).toBeFalsy();
    expect(textOf(g)).toContain('neck→pelvis: 11.0px at 90°');
    expect(ws.load('fig').guide?.bones).toContainEqual(['hip_f', 'knee_f']);
    await call('draw_shapes', { sprite: 'fig', shapes: [{ type: 'polygon', points: [[16, 8], [25, 8], [25, 35], [16, 35]], fill: '#ff0000' }] });
    const check = await call('silhouette_check', { sprite: 'fig', guide: true });
    expect(check.isError, textOf(check)).toBeFalsy();
    expect(textOf(check)).toMatch(/IoU\): \d+%/);
    expect(textOf(check)).toContain('left edge 2px inside');
    expect(textOf(check)).toContain('ADD (in the reference, missing in the art)');
    expect(ws.load('fig').reference?.source?.width).toBeGreaterThan(0);
    expect((await call('preview', { sprite: 'fig', guide: true, compare: true })).isError).toBeFalsy();
  });

  it('builds a keyframed rig animation', async () => {
    await call('create_character', { name: 'kid', width: 24, height: 24 });
    const legend = { o: '#1a1c2c', b: '#3b5dc9' };
    await call('rig_part', { sprite: 'kid', name: 'body', facing: 'right', rows: ['oooo', 'obbo', 'oooo'], legend, pivot: [1, 2], at: [11, 16], preview: false });
    await call('rig_part', { sprite: 'kid', name: 'arm_r', parent: 'body', facing: 'right', rows: ['o', 'o', 'o'], legend, pivot: [0, 0], at: [0, -1], z: 2, preview: false });
    const r = await call('rig_keyframes', {
      sprite: 'kid',
      name: 'jump_right',
      facing: 'right',
      frames: 6,
      keys: [
        { frame: 0, parts: { body: { dy: 2, sx: 1.2, sy: 0.8 } }, ease: 'out' },
        { frame: 2, parts: { body: { dy: -6, sy: 1.15 }, arm_r: { rot: 160 } } },
        { frame: 5, parts: { body: { dy: 0 } } },
      ],
      durations: [120, 60, 80, 100, 80, 120],
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    const s = ws.load('kid');
    const tag = s.tags.find((t) => t.name === 'jump_right')!;
    expect(tag.to - tag.from).toBe(5);
    expect(s.frames[tag.from + 2].pose?.parts.body.dy).toBe(-6);
    expect(s.frames[tag.from + 1].duration).toBe(60);
  });
});
