import { describe, expect, it } from 'vitest';
import { clearBackground, cleanArt, detectPixelGrid, hasSoftAlpha, spriteFromArt } from '../src/core/artImport.js';
import type { Bitmap } from '../src/core/sprite.js';

type C = [number, number, number];

/** Paints a little figure in blocks of `size` real pixels, blurred across block edges like a generated picture. */
function fakeArt(size: number, cols: number, rows: number, at: (x: number, y: number) => C, alpha = 255): Bitmap {
  const W = cols * size;
  const H = rows * size;
  const b: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(Math.floor(x / size), Math.floor(y / size));
      const near = at(Math.floor(Math.min(W - 1, x + 1) / size), Math.floor(y / size));
      const m = (x + 1) % size === 0 ? 0.65 : 1;
      b.data.set([c[0] * m + near[0] * (1 - m), c[1] * m + near[1] * (1 - m), c[2] * m + near[2] * (1 - m), alpha], (y * W + x) * 4);
    }
  }
  return b;
}

const BG: C = [60, 50, 48];
const LINE: C = [20, 12, 12];
const FILL: C = [210, 90, 60];
/** A checkered square with an outline, so edges land on every block boundary. */
const figure = (x: number, y: number): C => {
  if (x < 4 || y < 4 || x > 15 || y > 15) return BG;
  if (x === 4 || y === 4 || x === 15 || y === 15) return LINE;
  return (x + y) % 2 ? FILL : [240, 200, 150];
};

describe('detectPixelGrid', () => {
  for (const size of [3, 4, 5]) {
    it(`finds blocks of ${size}px`, () => {
      expect(Math.round(detectPixelGrid(fakeArt(size, 20, 20, figure)).size)).toBe(size);
    });
  }
});

describe('cleanArt', () => {
  it('rebuilds the true resolution and clears the background around the outline', () => {
    const [r] = cleanArt(fakeArt(4, 20, 20, figure), [{ sprite: 'a', crop: { x: 0, y: 0, width: 80, height: 80 } }]);
    expect([r.width, r.height]).toEqual([12, 12]);
    expect(r.frames[0].data[3]).toBe(255);
    expect(r.frames[0].data.slice(0, 3)[0]).toBeLessThan(60);
  });

  it('keeps the background when asked', () => {
    const [r] = cleanArt(fakeArt(4, 20, 20, figure), [{ sprite: 'a', crop: { x: 0, y: 0, width: 80, height: 80 }, background: 'keep' }]);
    expect([r.width, r.height]).toEqual([20, 20]);
  });

  it('makes frames of the same sprite share a canvas, standing on the bottom', () => {
    const small = (x: number, y: number): C => (x >= 8 && x <= 12 && y >= 10 && y <= 15 ? LINE : figure(x, y) === BG ? BG : BG);
    const big = fakeArt(4, 20, 20, figure);
    const both: Bitmap = { width: 160, height: 80, data: new Uint8ClampedArray(160 * 80 * 4) };
    const other = fakeArt(4, 20, 20, small);
    for (let y = 0; y < 80; y++) {
      both.data.set(big.data.subarray(y * 80 * 4, (y + 1) * 80 * 4), y * 160 * 4);
      both.data.set(other.data.subarray(y * 80 * 4, (y + 1) * 80 * 4), (y * 160 + 80) * 4);
    }
    const [r] = cleanArt(both, [
      { sprite: 'a', tag: 'walk', crop: { x: 0, y: 0, width: 80, height: 80 }, pixelSize: 4 },
      { sprite: 'a', tag: 'walk', crop: { x: 80, y: 0, width: 80, height: 80 }, pixelSize: 4 },
    ]);
    expect(r.frames).toHaveLength(2);
    expect(r.frames[1].width).toBe(r.width);
    const s = spriteFromArt(r);
    expect(s.frames).toHaveLength(2);
    expect(s.tags[0]).toMatchObject({ name: 'walk', from: 0, to: 1 });
  });
});

describe('cleanArt with a fixed canvas', () => {
  it('puts the figure on the baseline of the given canvas', () => {
    const [r] = cleanArt(fakeArt(4, 20, 20, figure), [{ sprite: 'a', crop: { x: 0, y: 0, width: 80, height: 80 } }], { canvas: { width: 32, height: 32, baseline: 29 } });
    expect([r.width, r.height]).toEqual([32, 32]);
    const filled = (y: number) => [...Array(32).keys()].some((x) => r.frames[0].data[(y * 32 + x) * 4 + 3]);
    expect(filled(29)).toBe(true);
    expect(filled(30)).toBe(false);
  });
});

describe('cleanArt exact', () => {
  it('reads each block without changing its color', () => {
    const [r] = cleanArt(fakeArt(4, 20, 20, figure), [{ sprite: 'a', crop: { x: 0, y: 0, width: 80, height: 80 }, background: 'keep' }], { exact: true, pixelSize: 4, trim: false });
    expect([r.width, r.height]).toEqual([20, 20]);
    expect([...r.frames[0].data.slice((5 * 20 + 6) * 4, (5 * 20 + 6) * 4 + 3)]).toEqual([...((5 + 6) % 2 ? FILL : [240, 200, 150])]);
  });

  it('copies a sheet that is already at its real size', () => {
    const src = fakeArt(1, 8, 8, () => FILL);
    const [r] = cleanArt(src, [{ sprite: 'a', crop: { x: 0, y: 0, width: 8, height: 8 }, background: 'keep' }], { exact: true, pixelSize: 1, trim: false });
    expect([...r.frames[0].data]).toEqual([...src.data]);
  });

  it('refuses a frame that does not fit instead of cropping it', () => {
    expect(() => cleanArt(fakeArt(4, 20, 20, figure), [{ sprite: 'a', crop: { x: 0, y: 0, width: 80, height: 80 } }], { exact: true, pixelSize: 4, background: 'keep', canvas: { width: 16, height: 16 } })).toThrow(/does not fit/);
  });
});

describe('clearBackground', () => {
  it('does not leak through a narrow gap into a part colored like the background', () => {
    const W = 15;
    const H = 15;
    const b: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const wall = (x >= 3 && x <= 11 && (y === 3 || y === 11)) || (y >= 3 && y <= 11 && (x === 3 || x === 11));
        const gap = x === 7 && y === 3;
        b.data.set([...(wall && !gap ? FILL : BG), 255], (y * W + x) * 4);
      }
    }
    clearBackground(b);
    expect(b.data[3]).toBe(0);
    expect(b.data[(7 * W + 7) * 4 + 3]).toBe(255);
  });
});

describe('hasSoftAlpha', () => {
  it('tells a blurry mask from real transparency', () => {
    expect(hasSoftAlpha(fakeArt(4, 20, 20, figure, 120))).toBe(true);
    expect(hasSoftAlpha(fakeArt(4, 20, 20, figure, 255))).toBe(false);
  });
});
