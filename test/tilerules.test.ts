import { describe, expect, it } from 'vitest';
import { BLOB_FULL, BLOB_MASKS, TileResolver, cellHash, normalizeTilesetRules } from '../src/core/game/tilerules.js';
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

  describe('corners', () => {
    const rules = { rules: [{ tile: 0, kind: 'corners' as const, first: 100, group: [9] }] };
    const at = (rows: string[], x: number, y: number, r = new TileResolver(rules)) => r.resolve(layer(rows), rows[0].length, rows.length, x, y, [])[0];

    it('picks one of the variant blocks by position, and leaves the plain terrain alone', () => {
      const r = new TileResolver({ rules: [{ tile: 0, kind: 'corners', first: 100, group: [9], variants: 4 }] });
      const cols = 40;
      const tiles = new Array(cols * 3).fill(0).map((_, k) => (k >= cols * 2 ? 9 : 0));
      const row = Array.from({ length: cols }, (_, x) => r.resolve({ tiles } as never, cols, 3, x, 1, [])[0]!);
      expect(new Set(row).size).toBe(4);
      for (const t of row) expect((t - 100) % 16).toBe(3);
      expect(r.resolve({ tiles } as never, cols, 3, 5, 0, [])[0]).toBe(100);
    });

    it('picks the transition tile from the corners touching the other terrain', () => {
      const map = ['000', '090', '000'];
      expect(at(map, 0, 0)).toBe(100 + 1); // diagonal: only SE
      expect(at(map, 2, 0)).toBe(100 + 2); // only SW
      expect(at(map, 0, 2)).toBe(100 + 4); // only NE
      expect(at(map, 2, 2)).toBe(100 + 8); // only NW
      expect(at(map, 1, 0)).toBe(100 + 2 + 1); // above it: both south corners
      expect(at(map, 0, 1)).toBe(100 + 4 + 1); // left of it: both east corners
      expect(at(map, 2, 1)).toBe(100 + 8 + 2);
      expect(at(map, 1, 2)).toBe(100 + 8 + 4);
    });

    it('reaches the two diagonal tiles and the fully enclosed one', () => {
      expect(at(['900', '000', '009'], 1, 1)).toBe(100 + 8 + 1);
      expect(at(['009', '000', '900'], 1, 1)).toBe(100 + 4 + 2);
      expect(at(['090', '909', '090'], 1, 1)).toBe(100 + 15);
    });

    it('leaves the other terrain whole and ignores the outside of the map', () => {
      expect(at(['000', '090', '000'], 1, 1)).toBe(9);
      expect(at(['000', '000', '000'], 0, 0)).toBe(100);
      expect(at(['000', '000', '000'], 2, 2)).toBe(100);
    });

    it('alternates variants only on the plain terrain', () => {
      const r = new TileResolver({ rules: [{ ...rules.rules[0], alt: 200, count: 6 }] });
      const map = ['00000', '00000', '00000', '00900'];
      expect(at(map, 0, 0, r)).toBe(200 + Math.floor(cellHash(0, 0, 0) * 6));
      expect(at(map, 2, 2, r)).toBe(100 + 3);
      const plain = new Set<number>();
      const wide = Array.from({ length: 12 }, () => '0'.repeat(12));
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) plain.add(at(wide, x, y, r));
      expect([...plain].sort((a, b) => a - b)).toEqual([200, 201, 202, 203, 204, 205]);
    });

    it('draws the border inside the terrain when inverted', () => {
      const r = new TileResolver({ rules: [{ tile: 9, kind: 'corners', first: 100, group: [0], invert: true }] });
      expect(at(['000', '090', '000'], 1, 1, r)).toBe(100); // alone: every corner is on the lower terrain
      expect(at(['999', '999', '999'], 1, 1, r)).toBe(115); // surrounded by itself
      expect(at(['999', '999', '000'], 1, 1, r)).toBe(100 + 8 + 4); // lower terrain south: only the north corners stay
      expect(at(['900', '999', '999'], 1, 1, r)).toBe(100 + 2 + 1);
      expect(at(['000', '090', '000'], 0, 0, r)).toBe(0); // the walkable cell is left alone
      expect(normalizeTilesetRules({ rules: [{ tile: 9, kind: 'corners', first: 0, group: [0], invert: true }] })?.rules?.[0].invert).toBe(true);
    });

    it('needs the other terrain to be a rule', () => {
      expect(normalizeTilesetRules({ rules: [{ tile: 0, kind: 'corners', first: 0 }] })).toBeUndefined();
      expect(normalizeTilesetRules({ rules: [{ tile: 0, kind: 'corners', first: 0, group: [15], alt: 16, count: 6 }] }))
        .toEqual({ rules: [{ tile: 0, kind: 'corners', first: 0, group: [15], alt: 16, count: 6 }] });
    });
  });
});
