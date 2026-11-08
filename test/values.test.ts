import { describe, expect, it } from 'vitest';
import { formatValue, parseValue } from '../src/web/values.js';

describe('typed value fields', () => {
  it('parses numbers, booleans, quoted text and plain text', () => {
    expect(parseValue('5')).toBe(5);
    expect(parseValue('0.5')).toBe(0.5);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('"5"')).toBe('5');
    expect(parseValue('"true"')).toBe('true');
    expect(parseValue('hello')).toBe('hello');
    expect(parseValue('"say \\"hi\\""')).toBe('say "hi"');
  });

  it('formats values so they parse back to the same value', () => {
    for (const v of [5, 0, true, false, '5', 'true', 'hello', '"quoted"', '']) expect(parseValue(formatValue(v))).toBe(v);
    expect(formatValue('5')).toBe('"5"');
    expect(formatValue('hello')).toBe('hello');
  });
});
