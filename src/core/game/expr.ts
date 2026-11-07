/**
 * A tiny, safe expression language for game events (no eval).
 *
 *   score + 10            self.hp <= 0 && !self.invincible
 *   "Score: " + score     random(1, 6)      dist(self.x, self.y, other.x, other.y) < 32
 *   self.vx > 0 ? 1 : -1  count("enemy") == 0
 *
 * Names: `score` (global variable), `self.x` / `other.hp` (instance fields and properties),
 * `scene.lives` (scene variables), `game.time`.
 */

import type { Value } from './types.js';

export interface ExprContext {
  /** Resolves a dotted name like ["self", "x"] or ["score"]. */
  get(path: string[]): Value | undefined;
  call(name: string, args: Value[]): Value;
}

export type Compiled = (ctx: ExprContext) => Value;

type Tok =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }
  | { k: 'end' };

const OPS = ['&&', '||', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '!', '(', ')', ',', '.', '?', ':', '='];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      out.push({ k: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === 'n' ? '\n' : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new Error(`Unterminated string in "${src}"`);
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ k: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`Unexpected "${c}" in "${src}"`);
    out.push({ k: 'op', v: op === '=' ? '==' : op });
    i += op.length;
  }
  out.push({ k: 'end' });
  return out;
}

const BINARY: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

export const truthy = (v: Value | undefined): boolean => (typeof v === 'string' ? v !== '' && v !== '0' && v !== 'false' : !!v);
const toNum = (v: Value | undefined): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v) || 0);

function binary(op: string, a: Compiled, b: Compiled): Compiled {
  switch (op) {
    case '||': return (c) => { const x = a(c); return truthy(x) ? x : b(c); };
    case '&&': return (c) => { const x = a(c); return truthy(x) ? b(c) : x; };
    case '==': return (c) => loose(a(c), b(c));
    case '!=': return (c) => !loose(a(c), b(c));
    case '<': return (c) => toNum(a(c)) < toNum(b(c));
    case '<=': return (c) => toNum(a(c)) <= toNum(b(c));
    case '>': return (c) => toNum(a(c)) > toNum(b(c));
    case '>=': return (c) => toNum(a(c)) >= toNum(b(c));
    case '+': return (c) => { const x = a(c), y = b(c); return typeof x === 'string' || typeof y === 'string' ? fmt(x) + fmt(y) : toNum(x) + toNum(y); };
    case '-': return (c) => toNum(a(c)) - toNum(b(c));
    case '*': return (c) => toNum(a(c)) * toNum(b(c));
    case '/': return (c) => { const y = toNum(b(c)); return y === 0 ? 0 : toNum(a(c)) / y; };
    case '%': return (c) => { const y = toNum(b(c)); return y === 0 ? 0 : ((toNum(a(c)) % y) + y) % y; };
  }
  throw new Error(`Unknown operator ${op}`);
}

function loose(x: Value, y: Value): boolean {
  if (typeof x === typeof y) return x === y;
  if (typeof x === 'string' || typeof y === 'string') return String(x) === String(y);
  return toNum(x) === toNum(y);
}

/** Formats a value for text: integers stay integers, other numbers get at most 2 decimals. */
export function fmt(v: Value | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

function parse(src: string): Compiled {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return t.k === 'op' && t.v === v; };
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}" in "${src}"`);
    p++;
  };

  const primary = (): Compiled => {
    const t = toks[p++];
    if (t.k === 'num') { const v = t.v; return () => v; }
    if (t.k === 'str') { const v = t.v; return () => v; }
    if (t.k === 'op' && t.v === '(') {
      const e = ternary();
      expect(')');
      return e;
    }
    if (t.k === 'op' && (t.v === '-' || t.v === '!')) {
      const e = unaryOperand();
      return t.v === '-' ? (c) => -toNum(e(c)) : (c) => !truthy(e(c));
    }
    if (t.k === 'id') {
      if (t.v === 'true') return () => true;
      if (t.v === 'false') return () => false;
      if (isOp('(')) {
        p++;
        const args: Compiled[] = [];
        if (!isOp(')')) {
          do args.push(ternary());
          while (isOp(',') && ++p);
        }
        expect(')');
        const name = t.v;
        return (c) => c.call(name, args.map((a) => a(c)));
      }
      const path = [t.v];
      while (isOp('.')) {
        p++;
        const n = toks[p++];
        if (n.k !== 'id') throw new Error(`Expected a name after "." in "${src}"`);
        path.push(n.v);
      }
      return (c) => c.get(path) ?? 0;
    }
    throw new Error(t.k === 'end' ? `Unexpected end of "${src}"` : `Unexpected "${'v' in t ? t.v : ''}" in "${src}"`);
  };
  const unaryOperand = (): Compiled => primary();

  const binaryExpr = (minPrec: number): Compiled => {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t.k !== 'op' || !(t.v in BINARY) || BINARY[t.v] < minPrec) break;
      p++;
      const right = binaryExpr(BINARY[t.v] + 1);
      left = binary(t.v, left, right);
    }
    return left;
  };

  const ternary = (): Compiled => {
    const cond = binaryExpr(1);
    if (!isOp('?')) return cond;
    p++;
    const a = ternary();
    expect(':');
    const b = ternary();
    return (c) => (truthy(cond(c)) ? a(c) : b(c));
  };

  const e = ternary();
  if (peek().k !== 'end') throw new Error(`Unexpected "${(peek() as { v?: string }).v}" in "${src}"`);
  return e;
}

const cache = new Map<string, Compiled>();

/** Compiles (and caches) an expression. Numbers and booleans are returned as constants. */
export function compile(src: Value): Compiled {
  if (typeof src !== 'string') return () => src;
  let c = cache.get(src);
  if (!c) {
    c = src.trim() === '' ? () => 0 : parse(src);
    if (cache.size > 5000) cache.clear();
    cache.set(src, c);
  }
  return c;
}

/** Returns an error message, or null when the expression parses. */
export function checkExpr(src: Value): string | null {
  try {
    compile(src);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Assignable target like "score", "self.hp", "other.vx", "scene.lives". */
export function parseTarget(target: string): string[] {
  const path = target.trim().split('.').map((s) => s.trim());
  if (!path.length || path.some((s) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) throw new Error(`Invalid variable "${target}"`);
  return path;
}

/** Built-in functions available in every expression (the engine adds world functions like count()). */
export const MATH_FUNCTIONS: Record<string, (args: number[], rnd: () => number) => Value> = {
  random: ([a = 0, b = 1], r) => a + r() * (b - a),
  randint: ([a = 0, b = 1], r) => Math.floor(a + r() * (Math.floor(b) - Math.ceil(a) + 1)),
  floor: ([a = 0]) => Math.floor(a),
  ceil: ([a = 0]) => Math.ceil(a),
  round: ([a = 0]) => Math.round(a),
  abs: ([a = 0]) => Math.abs(a),
  sign: ([a = 0]) => Math.sign(a),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  clamp: ([v = 0, lo = 0, hi = 1]) => Math.max(lo, Math.min(hi, v)),
  sqrt: ([a = 0]) => Math.sqrt(Math.max(0, a)),
  sin: ([a = 0]) => Math.sin((a * Math.PI) / 180),
  cos: ([a = 0]) => Math.cos((a * Math.PI) / 180),
  atan2: ([y = 0, x = 0]) => (Math.atan2(y, x) * 180) / Math.PI,
  dist: ([x1 = 0, y1 = 0, x2 = 0, y2 = 0]) => Math.hypot(x2 - x1, y2 - y1),
  lerp: ([a = 0, b = 0, t = 0]) => a + (b - a) * t,
};

export { toNum };
