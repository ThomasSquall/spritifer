import { describe, expect, it } from 'vitest';
import { resolveRelief, shadeRelief } from '../src/core/game/relief.js';

const frame = () => ({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(100) });

describe('shadeRelief between frames', () => {
  it('leaves nothing behind from the previous frame (its work buffers are reused)', () => {
    const normals = new Uint8ClampedArray(8 * 8 * 4);
    const relief = resolveRelief({});
    const clean = frame();
    shadeRelief(clean, normals, relief, '#808080', [], 0);
    shadeRelief(frame(), normals, relief, '#808080', [{ x: 4, y: 4, radius: 20, color: '#ffffff', intensity: 1 }], 1);
    const after = frame();
    shadeRelief(after, normals, relief, '#808080', [], 0);
    expect([...after.data]).toEqual([...clean.data]);
  });
});
