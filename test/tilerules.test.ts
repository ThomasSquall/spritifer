import { describe, expect, it } from 'vitest';
import { BLOB_FULL, BLOB_MASKS, TileResolver, normalizeTilesetRules } from '../src/core/game/tilerules.js';
import type { TileLayer } from '../src/core/game/types.js';

const layer = (rows: string[]): TileLayer => ({ name: 'g', solid: false, visible: true, tiles: rows.join('').split('').map((c) => (c === '.' ? -1 : Number(c))) });

describe('tile rules', () => {
  it('has the 47 blob shapes', () => {
    expect(BLOB_MASKS).toHaveLength(47);
    expect(BLOB_MASKS[BLOB_FULL]).toBe(255);
  });

  it('autotiles a blob by its neighbours and keeps the painted tile elsewhere', () => {
    const r = new TileResolver({ rules: [{ tile: 4, kind: 'blob', first: 100 }] });
    const l = layer(['000', '044', '044']);
    const out: number[] = [];
    // Bottom-right 4: neighbours N, W, NW are 4, outside the map counts as 4 → full shape.
    expect(r.resolve(l, 3, 3, 2, 2, out)).toEqual([100 + BLOB_FULL]);
    expect(r.resolve(l, 3, 3, 0, 0, out)).toEqual([0]);
    expect(r.resolve(l, 3, 3, 1, 1, out)[0]).not.toBe(100 + BLOB_FULL);
  });

  it('cuts grid textures by position and animates frames', () => {
    const r = new TileResolver({ rules: [{ tile: 1, kind: 'grid', first: 10, size: 2, frames: 2, fps: 1 }] });
    const l = layer(['11', '11']);
    const out: number[] = [];
    expect(r.resolve(l, 2, 2, 1, 1, out, 0)).toEqual([13]);
    expect(r.resolve(l, 2, 2, 1, 1, out, 1.2)).toEqual([17]);
  });

  it('adds edge overlays only next to the other terrain', () => {
    const r = new TileResolver({ edges: [{ on: [2], from: [0], first: 200 }] });
    const l = layer(['022', '222', '222']);
    const out: number[] = [];
    expect(r.resolve(l, 3, 3, 1, 1, out)).toHaveLength(2);
    expect(r.resolve(l, 3, 3, 2, 2, out)).toEqual([2]);
  });

  it('normalizes rules', () => {
    expect(normalizeTilesetRules({ rules: [{ tile: 1, kind: 'nope', first: 2 }] })).toBeUndefined();
    expect(normalizeTilesetRules({ paintable: 48, rules: [{ tile: 1, kind: 'grid', first: 2, size: 4 }] })).toEqual({ paintable: 48, rules: [{ tile: 1, kind: 'grid', first: 2, size: 4 }] });
  });
});

describe('edge overlays on their own layer', () => {
  it('treats empty cells as the other terrain when asked', () => {
    const l = layer(['...', '.3.', '...']);
    const out: number[] = [];
    expect(new TileResolver({ edges: [{ on: [3], from: [0], first: 200 }] }).resolve(l, 3, 3, 1, 1, out)).toEqual([3]);
    expect(new TileResolver({ edges: [{ on: [3], from: [0], first: 200, empty: true }] }).resolve(l, 3, 3, 1, 1, out)).toHaveLength(2);
  });
});
