/** Evaluates a text object's expression in the editor (with starting values) to show what the game will display. */

import { MATH_FUNCTIONS, compile, fmt, toNum } from '../core/game/expr.js';
import { gameFont, measureText, rasterText } from '../core/game/font.js';
import type { ObjectType, Value } from '../core/game/types.js';
import { state } from './gameState.js';

export function previewText(expr: string, obj?: ObjectType, sceneVars: Record<string, Value> = {}): { text: string; error: string | null } {
  const g = state.game;
  try {
    const v = compile(expr)({
      get: (path) => {
        const [head, field] = path;
        if (path.length === 1) return g?.variables[head] ?? sceneVars[head];
        if (head === 'self') return obj?.properties[field] ?? (field === 'x' || field === 'y' ? 0 : undefined);
        if (head === 'scene') return sceneVars[field];
        if (head === 'game') return field === 'width' ? g?.width : field === 'height' ? g?.height : 0;
        return undefined;
      },
      call: (name, args) => {
        const m = MATH_FUNCTIONS[name];
        if (m) return m(args.map(toNum), Math.random);
        if (name === 'count' || name === 'nearest') return 0;
        if (name === 'exists' || name === 'keyDown' || name === 'keyPressed') return false;
        if (name === 'str') return fmt(args[0]);
        if (name === 'num') return toNum(args[0]);
        if (name === 'pad') return fmt(args[0]).padStart(toNum(args[1]) || 0, String(args[2] ?? '0'));
        throw new Error(`unknown function ${name}()`);
      },
    });
    return { text: fmt(v), error: null };
  } catch (err) {
    return { text: '', error: (err as Error).message };
  }
}

/** True when the input is meant as fixed words but isn't a valid expression (e.g. GAME OVER without quotes). */
export function looksLikePlainText(expr: string): boolean {
  return previewText(expr).error !== null && !/["']/.test(expr) && expr.trim() !== '';
}

/** Draws text with the game's pixel font at world coordinates on a 2D context (scene editor). */
export function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale: number): void {
  const font = gameFont(state.game);
  const p = scale / font.density;
  ctx.fillStyle = '#000000';
  rasterText(text, (px, py) => ctx.fillRect(x + (px + 1) * p, y + (py + 1) * p, p, p), font);
  ctx.fillStyle = color;
  rasterText(text, (px, py) => ctx.fillRect(x + px * p, y + py * p, p, p), font);
}

export function textSize(text: string, scale: number): { w: number; h: number } {
  const m = measureText(text, gameFont(state.game));
  return { w: Math.max(4, (m.width + 1) * scale), h: Math.max(4, (m.height + 1) * scale) };
}
