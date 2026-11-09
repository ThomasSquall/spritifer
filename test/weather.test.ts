import { describe, expect, it } from 'vitest';
import { normalizeAtmosphere } from '../src/core/game/types.js';
import { TileResolver } from '../src/core/game/tilerules.js';
import { addWaterActors, findWater, reflectionBands, reflectionZ, waterPieces } from '../src/core/game/reflections.js';
import { RainField, drawShafts } from '../src/core/game/weather.js';
import type { Renderer } from '../src/core/game/engine.js';
import type { TileLayer } from '../src/core/game/types.js';

const VIEW = { x: 0, y: 0, w: 320, h: 180 };
const layer = (tiles: number[], o: Partial<TileLayer> = {}): TileLayer => ({ name: 'ground', tiles, solid: false, visible: true, ...o });
const recorder = () => {
  const rects: { x: number; y: number; w: number; alpha: number | undefined; blend: string | undefined }[] = [];
  const r: Renderer = { clear() {}, image() {}, text() {}, rect: (x, y, w, _h, _c, alpha, blend) => void rects.push({ x, y, w, alpha, blend }) };
  return { r, rects };
};
const animated = new TileResolver({ rules: [{ tile: 5, kind: 'grid', first: 100, frames: 8, fps: 5 }] });

describe('water', () => {
  it('is what animates, and nothing else', () => {
    const map = findWater([layer([0, 5, 5, 0])], 2, 2, animated);
    expect([...map.grid]).toEqual([0, 1, 1, 0]);
    expect(map.cells[0]!.tiles.length).toBe(8);
  });

  it('does not count under another layer', () => {
    const map = findWater([layer([5, 5]), layer([3, -1], { name: 'walls', solid: true })], 2, 1, animated);
    expect([...map.grid]).toEqual([0, 1]);
  });

  const actor = (x: number, y: number, h = 20) => ({
    id: 1, x, y, z: 0, opacity: 1, visible: true, destroyed: false, light: undefined, flipX: false, type: {},
    asset: { width: 16, height: h, name: 'tree', frames: [{ x: 0, y: 0, w: 16, h }] }, box: () => ({ x, y, w: 16, h }),
  });

  it('mirrors a thing below its feet, top of the sprite furthest down', () => {
    const map = { cols: 4, rows: 4, grid: new Uint8Array(16).fill(1), cells: [] };
    const bands = reflectionBands(actor(0, 0), { wobble: 0 }, map, 16, 0, 0, 0, 1);
    expect(bands).toHaveLength(1);
    expect(bands[0]!.dy).toBe(20);
    expect(bands[0]!.sh).toBe(20);
  });

  it('has nothing to mirror away from water', () => {
    const map = { cols: 4, rows: 4, grid: new Uint8Array(16), cells: [] };
    expect(reflectionBands(actor(0, 0), {}, map, 16, 0, 0, 0, 1)).toEqual([]);
  });

  it('counts instances drawn as water', () => {
    const map = { cols: 4, rows: 4, grid: new Uint8Array(16), cells: [] };
    addWaterActors(map, [actor(16, 16, 16)], ['tree'], 16);
    expect(map.grid[5]).toBe(1);
    expect(map.grid.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('draws reflections below a decal lying across the water', () => {
    const tiles = findWater([layer([5, 5])], 2, 1, animated);
    expect(reflectionZ(tiles)).toBeLessThan(-2);
    const canal = { cols: 4, rows: 4, grid: new Uint8Array(16), cells: [] };
    addWaterActors(canal, [{ ...actor(0, 0), z: -3 }], ['tree'], 16);
    expect(reflectionZ(canal)).toBeGreaterThan(-3);
    expect(reflectionZ(canal)).toBeLessThan(-2);
  });

  it('finds only the water on the screen, for the shadows to stay off it', () => {
    const map = { cols: 8, rows: 1, grid: new Uint8Array(8), cells: [{ tx: 1, ty: 0, tiles: [5, 6] }, { tx: 7, ty: 0, tiles: [5, 6] }] };
    const sheet = { name: 'tiles', tile: (t: number): [number, number] => [t * 16, 0], w: 16, h: 16 };
    const pieces = waterPieces({}, map, [], sheet, 16, 0, 0, 1, 48, 16, { left: 0, top: 0, right: 0, bottom: 0 });
    expect(pieces).toEqual([{ sprite: 'tiles', sources: [80, 0, 96, 0], sw: 16, sh: 16, x: 16, y: 0 }]);
  });

  it('never draws reflections above the shadows', () => {
    const high = findWater([layer([5, 5], { z: 10 })], 2, 1, animated);
    expect(reflectionZ(high)).toBe(-1.8);
  });
});

describe('rain', () => {
  it('fills the view and keeps the count', () => {
    const rain = new RainField();
    rain.reset({ count: 50 });
    for (let i = 0; i < 300; i++) rain.tick(1 / 60, VIEW);
    const { r, rects } = recorder();
    rain.draw(r, 0, 0, 1);
    expect(rects.length).toBeGreaterThanOrEqual(50);
  });

  it('thunder follows the flash, and only if there is lightning', () => {
    const heard: string[] = [];
    const rain = new RainField();
    rain.reset({ count: 1, lightning: 30, thunder: 'boom' });
    for (let i = 0; i < 60 * 20; i++) rain.tick(1 / 60, VIEW, (n) => heard.push(n));
    expect(heard.length).toBeGreaterThan(3);
    const quiet = new RainField();
    let any = 0;
    quiet.reset({ count: 1, thunder: 'boom' });
    for (let i = 0; i < 60 * 20; i++) quiet.tick(1 / 60, VIEW, () => any++);
    expect(any).toBe(0);
  });

  it('survives normalize, with limits', () => {
    expect(normalizeAtmosphere({ rain: { count: 5000, lightning: 2, thunder: 't' } })?.rain).toEqual({ count: 800, lightning: 2, thunder: 't' });
  });
});

describe('shafts of light', () => {
  it('are added light, anchored to the map', () => {
    const at = (camX: number) => {
      const { r, rects } = recorder();
      drawShafts(r, { count: 4 }, 0, camX, 0, 1, 320, 180, []);
      return rects;
    };
    const here = at(0);
    expect(here.length).toBeGreaterThan(0);
    expect(here.every((q) => q.blend === 'add')).toBe(true);
    // Walking 40 px to the right moves them 40 px to the left on the screen.
    const moved = at(40);
    const a = here.find((q) => q.x > 100)!;
    expect(moved.some((q) => q.x === a.x - 40 && q.w === a.w)).toBe(true);
  });

  it('light the particles that cross them', () => {
    const { r, rects } = recorder();
    const list = Array.from({ length: 400 }, (_, i) => ({ x: i, y: 90, size: 1, alpha: 1 }));
    drawShafts(r, { count: 4 }, 0, 0, 0, 1, 320, 180, [{ list }]);
    const plain = recorder();
    drawShafts(plain.r, { count: 4 }, 0, 0, 0, 1, 320, 180, []);
    expect(rects.length).toBeGreaterThan(plain.rects.length);
  });
});
