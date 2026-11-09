import { describe, expect, it } from 'vitest';
import { cameraMatrix, findWalls, makeCamera, overscanOf, projectWorld, shapeSurface, spriteProfile, worldPoint } from '../src/core/game/hd3d.js';
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

describe('2D-HD solids', () => {
  it('bulges towards the camera in the middle and turns away at the edges', () => {
    expect(shapeSurface('round', 0)).toEqual({ forward: 1, side: 0 });
    expect(shapeSurface('round', 1).forward).toBeCloseTo(0);
    expect(shapeSurface('round', -0.6).side).toBeCloseTo(-0.6);
  });

  it('has flat faces with sharp edges when it has corners', () => {
    expect(shapeSurface('octagon', 0.2).forward).toBeCloseTo(1);
    expect(shapeSurface('octagon', 0.2).side).toBeCloseTo(0);
    expect(shapeSurface('octagon', 0.8).side).toBeGreaterThan(0.6);
    expect(shapeSurface('square', 0.5).forward).toBeCloseTo(0.5);
    expect(shapeSurface('square', 0.5).side).toBeCloseTo(shapeSurface('square', 0.9).side);
    expect(shapeSurface('square', -0.5).side).toBeLessThan(0);
  });

  it('reads the radius of every row from the silhouette, around one axis', () => {
    // A 6-wide capital over a 2-wide shaft, in a frame placed at 1,0 of a sheet 8 wide.
    const rows = ['.######.', '...##...', '...##...', '........'];
    const alpha = Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0)));
    const p = spriteProfile(alpha, 8, { x: 1, y: 0, w: 6, h: 4 });
    expect(p.axis).toBe(3);
    expect(Array.from(p.radius)).toEqual([3, 1, 1, 0]);
    expect(p.largest).toBe(3);
  });
});

describe('2D-HD walls', () => {
  const rows = ['###', '###', '###', '###', '...', '...'];

  it('makes the lowest rows the front and the rest the top', () => {
    const cells = findWalls(map(rows), 3, 6, resolver, 3);
    expect(cells[3 * 3 + 1]).toEqual({ face: 0 });
    expect(cells[1 * 3 + 1]).toEqual({ face: 2 });
    expect(cells[0 * 3 + 1]).toEqual({ cap: 3, left: false, right: false });
    expect(cells[0]).toMatchObject({ cap: 3, left: true, right: false });
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

  it('follows the corrections painted by hand', () => {
    const cells = findWalls(map(rows), 3, 6, resolver, 3, { '1,3': 0, '2,3': 1 });
    // Taking a cell out splits the column: what is left above it has no floor of its own, and is a shorter wall.
    expect(cells[3 * 3 + 1]).toBeNull();
    expect(cells[2 * 3 + 1]).toEqual({ face: 0 });
    // A height set low in a column sets it for the column.
    expect(cells[3 * 3 + 2]).toEqual({ face: 0 });
    expect(cells[2 * 3 + 2]).toMatchObject({ cap: 1, left: true, right: true });
  });

  it('raises what the automatic detection left flat', () => {
    const cells = findWalls(map(['...', '...', '...'], true), 3, 3, resolver, 3, { '1,0': 2, '1,1': 2 });
    expect(cells[1 * 3 + 1]).toEqual({ face: 0 });
    expect(cells[1]).toEqual({ face: 1 });
    expect(cells[0]).toBeNull();
  });

  it('stretches a short wall to the height asked by hand, but never an automatic one', () => {
    expect(findWalls(map(['...', '...', '...'], true), 3, 3, resolver, 3, { '1,1': 3 })[1 * 3 + 1]).toEqual({ face: 0, stretch: 3 });
    expect(findWalls(map(['###', '...']), 3, 2, resolver, 3)[1]).toEqual({ face: 0 });
  });

  it('ignores corrections left outside a map that was made smaller', () => {
    expect(findWalls(map(['...']), 3, 1, resolver, 3, { '9,9': 2 }).every((c) => c === null)).toBe(true);
  });

  it('dresses the side of a wall with the nearest front, unrolled along its depth', () => {
    const wide = ['####', '####', '####', '####', '....'];
    const cells = findWalls(map(wide), 4, 5, resolver, 2);
    // Fronts are rows 2 and 3 (foot on row 3). Column 0's top cells borrow them, one column on per row of depth.
    expect(cells[1 * 4]).toMatchObject({ cap: 2, left: true, sides: [3 * 4 + 2, 2 * 4 + 2] });
    expect(cells[0]).toMatchObject({ cap: 2, left: true, sides: [3 * 4 + 1, 2 * 4 + 1] });
    expect(cells[1]).not.toHaveProperty('sides');
  });

  it('closes the corner where a side wall meets a back wall', () => {
    // A room: back wall on rows 0-2, side wall on column 0, floor from row 3.
    const room = ['####', '####', '####', '#...', '#...', '#...', '#...', '#...'];
    const cells = findWalls(map(room), 4, 8, resolver, 3);
    // The tops painted next to the back wall stand next to the floor, so their side shows.
    for (const y of [0, 1, 2, 3]) expect(cells[y * 4]).toMatchObject({ cap: 3, right: true });
  });

  it('hides the side between two tops standing next to each other', () => {
    const block = ['####', '####', '####', '####', '####', '....'];
    const cells = findWalls(map(block), 4, 6, resolver, 3);
    expect(cells[0 * 4 + 1]).toMatchObject({ left: false, right: false });
    expect(cells[1 * 4 + 3]).toMatchObject({ left: false, right: true });
  });

  it('leaves sides undressed when the map has no front to borrow', () => {
    expect(findWalls(map(['...', '###']), 3, 2, resolver, 3)[3]).not.toHaveProperty('sides');
  });

  it('keeps flat the cells where water is laid over the map as instances', () => {
    const water = new Uint8Array(9);
    water[3] = 1;
    const cells = findWalls(map(['###', '###', '...']), 3, 3, resolver, 1, undefined, water);
    expect(cells[3]).toBeNull();
    expect(cells[4]).toEqual({ face: 0 });
  });

  it('hands a jut to every front cell it crosses, across tiles', () => {
    const cells = findWalls(map(['###', '###', '...']), 3, 3, resolver, 2, undefined, undefined, [{ x: 24, w: 16, foot: 1, depth: 8 }], 32);
    expect(cells[1 * 3 + 0]).toMatchObject({ face: 0, juts: [{ from: 0.75, to: 1, depth: 8, starts: true, ends: false }] });
    expect(cells[1 * 3 + 1]).toMatchObject({ face: 0, juts: [{ from: 0, to: 0.25, depth: 8, starts: false, ends: true }] });
    // The whole height of the front, and the highest cell knows it is.
    expect(cells[0]).toMatchObject({ face: 1, top: true });
    expect(cells[1 * 3 + 2]).toEqual({ face: 0 });
  });

  it('carries a jut of the borrowed front onto the side of a wall', () => {
    const wide = ['####', '####', '####', '####', '....'];
    const cells = findWalls(map(wide), 4, 5, resolver, 2, undefined, undefined, [{ x: 40, w: 16, foot: 3, depth: 8 }], 32);
    // Column 0's top at row 0 borrows column 1, which has the jut.
    expect(cells[0]).toMatchObject({ cap: 2, left: true, sides: [3 * 4 + 1, 2 * 4 + 1], sideJuts: [{ depth: 8 }] });
    // The top at row 1 borrows column 2, which hasn't.
    expect(cells[1 * 4]).not.toHaveProperty('sideJuts');
  });

  it('ignores a jut that is not on a front', () => {
    const cells = findWalls(map(['###', '...', '...']), 3, 3, resolver, 1, undefined, undefined, [{ x: 0, w: 32, foot: 2, depth: 8 }], 32);
    expect(cells.every((c) => !c || !('juts' in c))).toBe(true);
  });

  it('does nothing with no rows asked for', () => {
    expect(findWalls(map(rows), 3, 6, resolver, 0).every((c) => c === null)).toBe(true);
  });
});
