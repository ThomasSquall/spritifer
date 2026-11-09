import { describe, expect, it } from 'vitest';
import { HD_FIELDS, type HdFrame, applyHdBuffer, hdBlurAt, normalizeHd, resolveHd } from '../src/core/game/hd.js';
import { normalizeAtmosphere, normalizeGame } from '../src/core/game/types.js';

const flat = { bloom: 0, haze: 0, halo: 0, exposure: 1, contrast: 1, saturation: 1, vignette: 0, blurFar: 0, blurNear: 0 };
const frame = (over: object): HdFrame => ({ hd: resolveHd({ ...flat, ...over }, undefined)!, subjectY: 0.5, lights: [] });
const picture = (w: number, h: number, paint: (x: number, y: number) => number) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = paint(x, y);
    d.set([v, v, v, 255], (y * w + x) * 4);
  }
  return d;
};

describe('auto 2D-HD settings', () => {
  it('clamps to the table, drops unknown fields and treats a negative focus as "follow"', () => {
    expect(normalizeHd({ bloom: 9, nope: 1, focusY: -0.05, hazeColor: 'red', enabled: true })).toEqual({ bloom: 2, enabled: true });
    expect(normalizeHd(null)).toBeUndefined();
  });

  it('survives loading with the game and with the scene', () => {
    expect(normalizeGame({ hd: { enabled: true, blurFar: 0.5 } }).hd).toEqual({ enabled: true, blurFar: 0.5 });
    expect(normalizeGame({}).hd).toBeUndefined();
    expect(normalizeAtmosphere({ hd: { off: true } })?.hd).toEqual({ off: true });
  });

  it('takes the scene over the game over the defaults', () => {
    const dflt = HD_FIELDS.find((f) => f.key === 'haze')!.dflt;
    const hd = resolveHd({ bloom: 1, contrast: 1.2 }, { bloom: 0.2 })!;
    expect(hd.bloom).toBe(0.2);
    expect(hd.contrast).toBe(1.2);
    expect(hd.haze).toBe(dflt);
    expect(hd.focusY).toBeUndefined();
  });

  it('leaves a scene flat when it says off', () => {
    expect(resolveHd({ enabled: true }, { off: true })).toBeNull();
  });

  it('lets lamps shine only in the dark', () => {
    expect(resolveHd(undefined, undefined, '#ffffff')!.darkness).toBe(0);
    expect(resolveHd(undefined, undefined, '#202030')!.darkness).toBe(1);
  });
});

describe('auto 2D-HD picture', () => {
  it('keeps the band around the focus sharp and blurs away from it', () => {
    const hd = { focusBand: 0.2, blurFar: 1, blurNear: 2 };
    expect(hdBlurAt(0.5, 0.5, hd)).toBe(0);
    expect(hdBlurAt(0.58, 0.5, hd)).toBe(0);
    expect(hdBlurAt(0, 0.5, hd)).toBeCloseTo(1);
    expect(hdBlurAt(1, 0.5, hd)).toBeCloseTo(2);
  });

  it('changes nothing with every effect at zero', () => {
    const d = picture(40, 24, (x, y) => (x * 7 + y * 13) % 256);
    const before = d.slice();
    applyHdBuffer(d, 40, 24, frame({ hazeColor: '#808080' }));
    expect(Array.from(d)).toEqual(Array.from(before));
  });

  it('blurs far from the focus but not inside the band', () => {
    const stripes = (x: number) => (x % 2 ? 255 : 0);
    const d = picture(64, 64, stripes);
    applyHdBuffer(d, 64, 64, frame({ blurFar: 2, focusBand: 0.3, focusY: 0.5 }));
    expect(d[32 * 64 * 4]).toBe(0);
    expect(d[32 * 64 * 4 + 4]).toBe(255);
    expect(Math.abs(d[0] - d[4])).toBeLessThan(30);
  });

  it('makes the dark next to a bright spot glow', () => {
    const lit = (x: number, y: number) => (x > 28 && x < 36 && y > 28 && y < 36 ? 255 : 0);
    const d = picture(64, 64, lit);
    applyHdBuffer(d, 64, 64, frame({ bloom: 1 }));
    expect(d[(32 * 64 + 40) * 4]).toBeGreaterThan(5);
  });
});
