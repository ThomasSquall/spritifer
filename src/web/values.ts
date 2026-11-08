/** Typed values in text fields (variables, properties): 5 → number, true → boolean, "5" (in quotes) → text. */

import type { Value } from '../core/game/types.js';

export function parseValue(s: string): Value {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === 'string') return v;
    } catch { /* not valid JSON: keep the inner text */ }
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && Number.isFinite(Number(t))) return Number(t);
  return s;
}

/** The text that parses back to `v` (text that would read as a number / boolean is shown in quotes). */
export function formatValue(v: Value): string {
  if (typeof v !== 'string') return String(v);
  return parseValue(v) !== v || v.trim().startsWith('"') ? JSON.stringify(v) : v;
}

export const VALUE_HINT = 'Numbers (5, 0.5) and true/false are typed; anything else is text. Put text in quotes to keep it text: "5", "true".';
