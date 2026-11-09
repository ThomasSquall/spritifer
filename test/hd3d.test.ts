import { describe, expect, it } from 'vitest';
import { cameraMatrix, findWalls, makeCamera, overscanOf, projectWorld, worldPoint } from '../src/core/game/hd3d.js';
import type { TileResolver } from '../src/core/game/tilerules.js';
import type { TileLayer } from '../src/core/game/types.js';

/** Tiles as they are; tile 9 animates, like water. */
const resolver = {
  resolve(layer: TileLayer, cols: number, _rows: number, x: number, y: number, out: number[], clock: number) {
    const t = layer.tiles[y * cols + x]!;
    out.length = 0;
    out.push(t === 9 ? 9 + Math.floor(clock * 10) : t);
    return out;
  },
} as unknown as TileResolver;

const layer = (name: string, solid: boolean, rows: string[], tile: (c: string) => number): TileLayer => ({ name, solid, visible: !solid, tiles: rows.join('').split('').map(tile) });
/** `#` blocks, on art used nowhere else unless `shared`. `~` is water. */
function map(rows: string[], shared = false) {
  return [layer('ground', false, rows, (c) => (c === '~' ? 9 : c === '#' && !shared ? 2 : 1)), layer('walls', true, rows, (c) => (c === '#' || c === '~' ? 5 : -1))];
}

describe('2D-HD camera', () => {
  it('reproduces the flat picture as the perspective goes to nothing', () => {
    const cam = makeCamera(640, 360, 0, 50);
    for (const [x, y, h] of [[100, 50, 0], [-200, 120, 96], [0, -150, 40]] as const) {
      const p = projectWorld(cam, worldPoint(cam, x, y, h));
      expect(Math.abs(p.x - x)).toBeLessThan(6);
      expect(Math.abs(p.y - (y - h))).toBeLessThan(6);
    }
  });

  it('leaves the centre of the screen where it is and shrinks what is far away', () => {
    const cam = makeCamera(640, 360, 0.5, 50);
    const centre = projectWorld(cam, worldPoint(cam, 0, 0));
    expect(centre.x).toBe(0);
    expect(centre.y).toBeCloseTo(0);
    expect(projectWorld(cam, worldPoint(cam, 0, -100)).scale).toBeLessThan(1);
    expect(projectWorld(cam, worldPoint(cam, 0, 100)).scale).toBeGreaterThan(1);
  });

  it('builds the same projection in its matrix', () => {
    const cam = makeCamera(640, 360, 0.5, 50);
    const [x, y, z] = worldPoint(cam, 80, 60, 30);
    const m = cameraMatrix(cam);
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    const p = projectWorld(cam, [x, y, z]);
    expect(((m[0]! * x) / w) * 320).toBeCloseTo(p.x, 3);
    expect(((m[5]! * y + m[9]! * z) / w) * -180).toBeCloseTo(p.y, 3);
  });

  it('asks for more of the world above the screen than below', () => {
    const o = overscanOf(makeCamera(640, 360, 0.5, 50));
    expect(o.top).toBeGreaterThan(0);
    expect(o.bottom).toBe(0);
    expect(o.left).toBeGreaterThan(0);
  });
});

describe('2D-HD walls', () => {
  const rows = ['###', '###', '###', '###', '...', '...'];

  it('makes the lowest rows the front and the rest the top', () => {
    const cells = findWalls(map(rows), 3, 6, resolver, 3);
    expect(cells[3 * 3 + 1]).toEqual({ face: 0 });
    expect(cells[1 * 3 + 1]).toEqual({ face: 2 });
    expect(cells[0 * 3 + 1]).toEqual({ cap: 3, left: false, right: false });
    expect(cells[0]).toEqual({ cap: 3, left: true, right: false });
    expect(cells[4 * 3]).toBeNull();
  });

  it('shows only the top of a wall that runs off the bottom of the map', () => {
    const cells = findWalls(map(['...', '###']), 3, 2, resolver, 3);
    expect(cells[3]).toEqual({ cap: 1, left: true, right: false });
  });

  it('keeps blocked ground flat when the same art is walkable elsewhere', () => {
    expect(findWalls(map(rows, true), 3, 6, resolver, 3).every((c) => c === null)).toBe(true);
  });

  it('keeps water flat', () => {
    const cells = findWalls(map(['###', '~~~', '...']), 3, 3, resolver, 1);
    expect(cells[3]).toBeNull();
    expect(cells[0]).toEqual({ face: 0 });
  });

  it('does nothing with no rows asked for', () => {
    expect(findWalls(map(rows), 3, 6, resolver, 0).every((c) => c === null)).toBe(true);
  });
});
