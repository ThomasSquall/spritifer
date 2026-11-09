import { describe, expect, it } from 'vitest';
import { normalizeObject, normalizeSway } from '../src/core/game/types.js';
import { type AtmosphereActor, drawShadows } from '../src/core/game/atmosphere.js';
import type { Renderer } from '../src/core/game/engine.js';
import { pushTarget, stepPush, swayBands, swayBase } from '../src/core/game/wind.js';

describe('wind sway', () => {
  const clocks = Array.from({ length: 400 }, (_, i) => i * 0.13);

  it('covers every row of the frame exactly once', () => {
    for (const clock of clocks) {
      const bands = swayBands({ amount: 4 }, 112, 112, 300, 80, clock);
      expect(bands[0]!.row).toBe(0);
      let row = 0;
      for (const b of bands) {
        expect(b.row).toBe(row);
        expect(Number.isInteger(b.offset)).toBe(true);
        row += b.rows;
      }
      expect(row).toBe(112);
    }
  });

  it('keeps the foot still, lets the top travel, and stays cheap', () => {
    const tops = new Set<number>();
    for (const clock of clocks) {
      const bands = swayBands({ amount: 4 }, 112, 100, 300, 80, clock);
      expect(Math.abs(bands.at(-1)!.offset)).toBe(0);
      expect(bands.at(-1)!.row + bands.at(-1)!.rows).toBe(112);
      expect(bands.length).toBeLessThan(24);
      tops.add(bands[0]!.offset);
    }
    expect(tops.size).toBeGreaterThan(3);
  });

  it('moves distant trees differently', () => {
    const at = (x: number) => clocks.map((c) => swayBands({ amount: 4 }, 112, 112, x, 0, c)[0]!.offset).join();
    expect(at(0)).not.toBe(at(300));
  });

  it('anchors on the hitbox bottom, within the frame', () => {
    expect(swayBase({ hitbox: { y: 104, h: 8 } }, 112)).toBe(112);
    expect(swayBase({ hitbox: { y: 90, h: 8 }, spriteOffset: { y: 4 } }, 112)).toBe(94);
    expect(swayBase({}, 64)).toBe(64);
  });

  describe('cast shadow', () => {
    const atm = { relief: { sun: { angle: -90, elevation: 45 } } };
    const shadowsAt = (clock: number, sway?: { amount: number }) => {
      const stamps: { x: number; slice?: { row: number; rows: number } }[] = [];
      const r = {
        ...({ clear() {}, image() {}, rect() {}, text() {} } as Renderer),
        spriteMask: (_s: string, _x: number, _y: number, w: number, h: number) => new Uint8Array(w * h).fill(1),
        stamp: (_shape: unknown, x: number, _y: number, _z: number, _c: string, _a: number, slice?: { row: number; rows: number }) => { stamps.push({ x, slice }); },
      } as Renderer;
      const actor: AtmosphereActor = {
        id: 1, x: 40, y: 10, z: 0, opacity: 1, visible: true, destroyed: false, light: undefined,
        asset: { width: 20, height: 100, name: 'tree', frames: [{ x: 0, y: 0, w: 20, h: 100 }] },
        type: sway ? { sway } : {}, box: () => ({ x: 40, y: 10, w: 20, h: 100 }),
      };
      drawShadows({ clock, game: { width: 400, height: 400 }, actors: [actor], motes: { list: [] }, bundle: { sprites: {} } } as never, r, atm, 0, 0, 1);
      return stamps;
    };

    it('stays one piece without wind', () => {
      expect(shadowsAt(3)).toEqual([expect.objectContaining({ slice: undefined })]);
    });

    it('covers each row of ground once, and only the far end moves', () => {
      const lefts = new Set<number>();
      for (const clock of clocks) {
        const stamps = shadowsAt(clock, { amount: 4 });
        let row = stamps[0]!.slice!.row;
        for (const s of stamps) {
          expect(s.slice!.row).toBe(row);
          row += s.slice!.rows;
        }
        // The first row of ground is at the foot of the plant.
        const still = stamps[0]!.x;
        expect(stamps.every((s) => Number.isInteger(s.x))).toBe(true);
        lefts.add(stamps.at(-1)!.x - still);
      }
      expect(lefts.size).toBeGreaterThan(3);
    });

    it('matches the plant: the far end of the shadow is shifted like the top of the sprite', () => {
      for (const clock of clocks) {
        const stamps = shadowsAt(clock, { amount: 4 });
        const top = swayBands({ amount: 4 }, 100, 100, 40, 10, clock)[0]!.offset;
        expect(Math.abs(stamps.at(-1)!.x - stamps[0]!.x - top)).toBeLessThanOrEqual(1);
      }
    });
  });

  it('is kept by normalize, and off at zero', () => {
    expect(normalizeObject({ name: 't', sway: { amount: 3, speed: 1.5 } }).sway).toEqual({ amount: 3, speed: 1.5 });
    expect(normalizeObject({ name: 't', sway: { amount: 3, speed: 1 } }).sway).toEqual({ amount: 3 });
    expect(normalizeSway({ amount: 0 })).toBeUndefined();
    expect(normalizeSway({ amount: 999 })).toEqual({ amount: 24 });
  });
});

describe('plants pushed by walkers', () => {
  it('lean away from whoever is near and ignore the far ones', () => {
    expect(pushTarget(100, 100, 16, 3, [{ x: 92, y: 100, vx: 2 }])).toBeGreaterThan(0);
    expect(pushTarget(100, 100, 16, 3, [{ x: 108, y: 100, vx: -2 }])).toBeLessThan(0);
    expect(pushTarget(100, 100, 16, 3, [{ x: 200, y: 100, vx: 0 }])).toBe(0);
  });

  it('go the way the walker is heading when stepped on', () => {
    expect(pushTarget(100, 100, 16, 3, [{ x: 100, y: 100, vx: -1 }])).toBeLessThan(0);
  });

  it('spring past the rest position and settle at exactly zero', () => {
    const p = { swayPush: 3, swayPushV: 0 };
    let lowest = 3;
    for (let i = 0; i < 300; i++) {
      stepPush(p, 0, 1 / 60);
      lowest = Math.min(lowest, p.swayPush);
    }
    expect(lowest).toBeLessThan(0);
    expect(p.swayPush).toBe(0);
  });

  it('moves the top of the sprite and not its foot', () => {
    const still = swayBands({ amount: 1 }, 20, 20, 0, 0, 0);
    const pushed = swayBands({ amount: 1 }, 20, 20, 0, 0, 0, 5);
    expect(pushed[0]!.offset - still[0]!.offset).toBeGreaterThanOrEqual(4);
    expect(pushed[pushed.length - 1]!.offset).toBe(still[still.length - 1]!.offset);
  });

  it('keeps react through normalize', () => {
    expect(normalizeSway({ amount: 1, react: 3 })).toEqual({ amount: 1, react: 3 });
  });
});
