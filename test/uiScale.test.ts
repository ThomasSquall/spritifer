import { describe, expect, it } from 'vitest';
import { spriteScale } from '../src/core/game/script.js';

describe('interface sprite scale', () => {
  it('keeps a fraction only when it lands on whole device pixels', () => {
    expect(spriteScale(0.5, 2)).toBe(0.5);
    expect(spriteScale(0.5, 1)).toBe(1);
    expect(spriteScale(0.25, 2)).toBe(1);
    expect(spriteScale(2, 3)).toBe(2);
    expect(spriteScale(1.5, 1)).toBe(2);
    expect(spriteScale(0, 2)).toBe(1);
  });
});
