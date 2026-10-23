import { describe, expect, it } from 'vitest';
import { parseColor, toHex } from '../src/core/color.js';
import { base64ToBytes, bytesToBase64 } from '../src/core/base64.js';
import {
  addFrame,
  celBitmap,
  compositeFrame,
  createSprite,
  deserializeSprite,
  removeFrame,
  resizeCanvas,
  serializeSprite,
  setTag,
  tagSequence,
  addLayer,
} from '../src/core/sprite.js';
import { drawGrid, ellipsePoints, floodFill, getPixel, linePoints, mirror, outline, readGrid, shift, transform } from '../src/core/draw.js';
import { buildSpritesheet, sliceImage } from '../src/core/sheet.js';

describe('color', () => {
  it('parses hex forms, transparent and palette refs', () => {
    expect(parseColor('#f00')).toEqual([255, 0, 0, 255]);
    expect(parseColor('#00ff0080')).toEqual([0, 255, 0, 128]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseColor('p1', ['#000000', '#123456'])).toEqual([0x12, 0x34, 0x56, 255]);
    expect(() => parseColor('banana')).toThrow();
    expect(toHex([255, 0, 0, 255])).toBe('#ff0000');
    expect(toHex([255, 0, 0, 128])).toBe('#ff000080');
  });
});

describe('base64', () => {
  it('round-trips arbitrary lengths', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1027]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) & 255);
      expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('sprite model', () => {
  it('serializes and restores pixels, layers, frames and tags', () => {
    const s = createSprite({ name: 'hero', width: 4, height: 3 });
    const l2 = addLayer(s, 'top');
    addFrame(s, undefined, { duration: 150 });
    setTag(s, { name: 'walk', from: 0, to: 1 });
    drawGrid(celBitmap(s, l2.id, s.frames[1].id), 0, 0, ['ab'], { a: [1, 2, 3, 255], b: [4, 5, 6, 255] });
    const back = deserializeSprite(JSON.parse(JSON.stringify(serializeSprite(s))));
    expect(back.layers.map((l) => l.name)).toEqual(['Layer 1', 'top']);
    expect(back.frames[1].duration).toBe(150);
    expect(back.tags[0]).toMatchObject({ name: 'walk', from: 0, to: 1 });
    expect(getPixel(celBitmap(back, l2.id, back.frames[1].id), 1, 0)).toEqual([4, 5, 6, 255]);
  });

  it('keeps tags consistent when frames are inserted and removed', () => {
    const s = createSprite({ name: 't', width: 2, height: 2 });
    addFrame(s);
    addFrame(s);
    setTag(s, { name: 'run', from: 1, to: 2 });
    addFrame(s, 0);
    expect(s.tags[0]).toMatchObject({ from: 2, to: 3 });
    removeFrame(s, 0);
    expect(s.tags[0]).toMatchObject({ from: 1, to: 2 });
  });

  it('composites layers top over bottom with opacity', () => {
    const s = createSprite({ name: 'c', width: 1, height: 1 });
    const top = addLayer(s);
    celBitmap(s, s.layers[0].id, s.frames[0].id).data.set([0, 0, 255, 255]);
    celBitmap(s, top.id, s.frames[0].id).data.set([255, 0, 0, 255]);
    top.opacity = 0.5;
    const px = Array.from(compositeFrame(s, 0).data);
    expect(px[0]).toBeGreaterThan(120);
    expect(px[2]).toBeGreaterThan(120);
    expect(px[3]).toBe(255);
  });

  it('resizes the canvas around an anchor', () => {
    const s = createSprite({ name: 'r', width: 2, height: 2 });
    celBitmap(s, s.layers[0].id, s.frames[0].id).data.set([9, 9, 9, 255], 0);
    resizeCanvas(s, 4, 4, 'bottom-right');
    expect(getPixel(celBitmap(s, s.layers[0].id, s.frames[0].id), 2, 2)).toEqual([9, 9, 9, 255]);
  });

  it('expands pingpong tags', () => {
    expect(tagSequence({ name: 'x', from: 0, to: 3, direction: 'pingpong', color: '' })).toEqual([0, 1, 2, 3, 2, 1]);
  });
});

describe('drawing', () => {
  const bmp = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const K: [number, number, number, number] = [0, 0, 0, 255];

  it('draws pixel-perfect lines', () => {
    expect(linePoints(0, 0, 3, 1)).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
  });

  it('draws symmetric circles', () => {
    const pts = ellipsePoints(0, 0, 6, 6, false);
    const set = new Set(pts.map(([x, y]) => `${x},${y}`));
    for (const [x, y] of pts) expect(set.has(`${6 - x},${y}`) && set.has(`${x},${6 - y}`)).toBe(true);
    expect(set.has('3,3')).toBe(false);
  });

  it('stamps grids and reads them back', () => {
    const b = bmp(3, 2);
    drawGrid(b, 0, 0, ['k.k', 'kkk'], { k: K });
    const { rows, legend } = readGrid(b, { x: 0, y: 0, width: 3, height: 2 });
    expect(rows).toEqual(['A.A', 'AAA']);
    expect(legend).toEqual({ A: '#000000' });
    expect(() => drawGrid(b, 0, 0, ['z'], {})).toThrow(/not in the legend/);
  });

  it('flood fills only the contiguous region', () => {
    const b = bmp(3, 3);
    drawGrid(b, 0, 0, ['.k.', '.k.', '.k.'], { k: K });
    expect(floodFill(b, 0, 0, [255, 0, 0, 255])).toBe(3);
    expect(getPixel(b, 2, 0)[3]).toBe(0);
  });

  it('shifts, flips, mirrors and outlines', () => {
    const b = bmp(3, 3);
    drawGrid(b, 0, 0, ['k..'], { k: K });
    shift(b, 1, 1);
    expect(getPixel(b, 1, 1)).toEqual(K);
    transform(b, 'flip_h');
    expect(getPixel(b, 1, 1)).toEqual(K);
    const m = bmp(4, 1);
    drawGrid(m, 0, 0, ['kr'], { k: K, r: [255, 0, 0, 255] });
    mirror(m, 'left_to_right');
    expect(readGrid(m, { x: 0, y: 0, width: 4, height: 1 }).rows[0]).toBe('ABBA');
    const o = bmp(3, 3);
    drawGrid(o, 1, 1, ['k'], { k: K });
    expect(outline(o, [255, 255, 255, 255])).toBe(4);
  });
});

describe('spritesheet', () => {
  it('lays frames out in grids and per-tag rows with Aseprite metadata', () => {
    const s = createSprite({ name: 'sheet', width: 8, height: 8 });
    for (let i = 0; i < 4; i++) addFrame(s);
    setTag(s, { name: 'idle', from: 0, to: 1 });
    setTag(s, { name: 'walk', from: 2, to: 4 });

    const grid = buildSpritesheet(s, { layout: 'grid', columns: 3, padding: 1 });
    expect(grid.image.width).toBe(8 * 3 + 2);
    expect(grid.image.height).toBe(8 * 2 + 1);
    expect(grid.meta.frames[3].frame).toEqual({ x: 0, y: 9, w: 8, h: 8 });
    expect(grid.meta.meta.frameTags.map((t) => t.name)).toEqual(['idle', 'walk']);

    const tags = buildSpritesheet(s, { layout: 'tags', scale: 2 });
    expect(tags.image.width).toBe(16 * 3);
    expect(tags.image.height).toBe(16 * 2);
    expect(tags.meta.meta.frameTags[1]).toMatchObject({ name: 'walk', from: 2, to: 4 });

    const one = buildSpritesheet(s, { tag: 'walk' });
    expect(one.meta.frames).toHaveLength(3);
    expect(one.meta.meta.frameTags).toEqual([expect.objectContaining({ name: 'walk', from: 0, to: 2 })]);
  });

  it('slices images into frames', () => {
    const img = { width: 6, height: 2, data: new Uint8ClampedArray(6 * 2 * 4).fill(255) };
    expect(sliceImage(img, 2, 2)).toHaveLength(3);
  });
});
