/**
 * A tiny ES-module layer for game scripts. Each file in scripts/ (folders allowed) is a module:
 *
 *   import Health from './Health'          // default export of scripts/<dir>/Health.js
 *   import { FOES } from 'data/foes'       // bare paths start at scripts/
 *   export const SPEED = 40
 *   export default class Patrol extends Behaviour { ... }
 *
 * transformModule() rewrites import/export statements into plain code that runs inside a function
 * (`__import(spec)` / `__exports`), keeping every line where it was so error line numbers stay right.
 */

export interface TransformedModule {
  code: string;
  /** Import specifiers, as written. */
  imports: string[];
  /** Names exported (besides default). */
  exports: string[];
  hasDefault: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*/;

/** Code ranges that are not inside strings, comments, template literals or regexes, at brace depth 0. */
interface TopLevelHit {
  index: number;
  word: 'import' | 'export';
}

/**
 * Lightweight JavaScript scanner: finds `import` / `export` keywords at the top level of the file
 * (brace depth 0, outside strings, comments, templates and regex literals).
 */
function findTopLevel(src: string): TopLevelHit[] {
  const hits: TopLevelHit[] = [];
  let depth = 0;
  // Stack of brace depths at which an open template literal `${` resumes.
  const tpl: number[] = [];
  let lastSig = ''; // last significant (non-space) char, for regex detection
  let i = 0;
  const n = src.length;
  const readTemplate = (): void => {
    // At a position inside a template literal (after ` or }): read until ` or ${.
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        i++;
        lastSig = '`';
        return;
      }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        tpl.push(depth);
        depth++;
        lastSig = '{';
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      lastSig = c;
      continue;
    }
    if (c === '`') {
      i++;
      readTemplate();
      continue;
    }
    if (c === '/') {
      // Regex literal when a value can't come before it.
      if (!lastSig || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd())) {
        i++;
        let cls = false;
        while (i < n && src[i] !== '\n') {
          const d = src[i];
          if (d === '\\') {
            i += 2;
            continue;
          }
          if (d === '[') cls = true;
          else if (d === ']') cls = false;
          else if (d === '/' && !cls) break;
          i++;
        }
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        lastSig = 'r';
        continue;
      }
    }
    if (c === '{') {
      depth++;
      lastSig = c;
      i++;
      continue;
    }
    if (c === '}') {
      if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
        tpl.pop();
        depth--;
        i++;
        readTemplate();
        continue;
      }
      depth = Math.max(0, depth - 1);
      lastSig = c;
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = IDENT.exec(src.slice(i, i + 64))!;
      const word = m[0];
      const prev = i > 0 ? src[i - 1] : '';
      if (depth === 0 && (word === 'import' || word === 'export') && prev !== '.' && !/[\w$]/.test(prev)) {
        hits.push({ index: i, word });
      }
      i += word.length;
      lastSig = word[word.length - 1];
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return hits;
}

const nl = (s: string) => '\n'.repeat((s.match(/\n/g) ?? []).length);

/** `{ a, b as c, default as d }` → [['a','a'], ['b','c'], ['default','d']] */
function parseSpecifiers(list: string): [string, string][] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(s);
      if (!m) throw new SyntaxError(`Bad import/export list "{ ${list.trim()} }"`);
      return [m[1], m[2] ?? m[1]] as [string, string];
    });
}

/** Rewrites import/export statements. Throws SyntaxError on forms it doesn't support. */
export function transformModule(src: string): TransformedModule {
  const hits = findTopLevel(src);
  const imports: string[] = [];
  const exports: string[] = [];
  const tail: string[] = [];
  let hasDefault = false;
  let out = '';
  let last = 0;
  let defaultName: string | null = null;
  for (const hit of hits) {
    if (hit.index < last) continue;
    const rest = src.slice(hit.index);
    let m: RegExpExecArray | null;
    let replacement: string | null = null;
    let consumed = 0;
    if (hit.word === 'import') {
      if (/^import\s*[(.]/.test(rest)) continue; // dynamic import() / import.meta: leave as is
      if ((m = /^import\s*(['"])([^'"\n]+)\1\s*;?/.exec(rest))) {
        imports.push(m[2]);
        replacement = `__import(${JSON.stringify(m[2])});`;
      } else if ((m = /^import\s+([\s\S]*?)\s+from\s*(['"])([^'"\n]+)\2\s*;?/.exec(rest))) {
        const clause = m[1].trim();
        const spec = m[3];
        imports.push(spec);
        const req = `__import(${JSON.stringify(spec)})`;
        let ns: RegExpExecArray | null;
        if ((ns = /^\*\s+as\s+([\w$]+)$/.exec(clause))) replacement = `const ${ns[1]} = ${req};`;
        else {
          const dm = /^([\w$]+)\s*(?:,\s*(\{[\s\S]*\}|\*\s+as\s+[\w$]+))?$/.exec(clause);
          const lm = /^(\{[\s\S]*\})$/.exec(clause);
          if (dm) {
            const [, def, more] = dm;
            if (!more) replacement = `const ${def} = ${req}.default;`;
            else if (more.startsWith('*')) replacement = `const ${more.replace(/^\*\s+as\s+/, '')} = ${req}, ${def} = ${more.replace(/^\*\s+as\s+/, '')}.default;`;
            else replacement = `const { default: ${def}, ${parseSpecifiers(more.slice(1, -1)).map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${req};`;
          } else if (lm) {
            replacement = `const { ${parseSpecifiers(lm[1].slice(1, -1)).map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${req};`;
          } else throw new SyntaxError(`Unsupported import "${rest.split('\n')[0]}"`);
        }
      } else throw new SyntaxError(`Unsupported import "${rest.split('\n')[0]}"`);
      consumed = m[0].length;
    } else {
      if ((m = /^export\s+default\s+(?:(class|function\*?|async\s+function\*?)\s+([\w$]+))/.exec(rest))) {
        // Named default declaration: keep it as a declaration so the name exists in the module.
        hasDefault = true;
        defaultName = m[2];
        replacement = `${m[1]} ${m[2]}`;
        consumed = m[0].length;
      } else if ((m = /^export\s+default\s+/.exec(rest))) {
        hasDefault = true;
        replacement = '__exports.default = ';
        consumed = m[0].length;
      } else if ((m = /^export\s+((?:const|let|var)\s+|(?:async\s+)?function\*?\s+|class\s+)([\w$]+)/.exec(rest))) {
        exports.push(m[2]);
        tail.push(m[2]);
        replacement = `${m[1]}${m[2]}`;
        consumed = m[0].length;
      } else if ((m = /^export\s*(\{[\s\S]*?\})\s*from\s*(['"])([^'"\n]+)\2\s*;?/.exec(rest))) {
        imports.push(m[3]);
        const tmp = `__reexport${out.length}`;
        const specs = parseSpecifiers(m[1].slice(1, -1));
        replacement = `const ${tmp} = __import(${JSON.stringify(m[3])});`;
        for (const [a, b] of specs) {
          exports.push(b);
          tail.push(`${b}:${tmp}.${a}`);
        }
        consumed = m[0].length;
      } else if ((m = /^export\s*\*\s*from\s*(['"])([^'"\n]+)\1\s*;?/.exec(rest))) {
        imports.push(m[2]);
        replacement = `__exportAll(__import(${JSON.stringify(m[2])}));`;
        consumed = m[0].length;
      } else if ((m = /^export\s*(\{[\s\S]*?\})\s*;?/.exec(rest))) {
        for (const [a, b] of parseSpecifiers(m[1].slice(1, -1))) {
          exports.push(b);
          tail.push(a === b ? a : `${b}:${a}`);
        }
        replacement = '';
        consumed = m[0].length;
      } else throw new SyntaxError(`Unsupported export "${rest.split('\n')[0]}"`);
    }
    const original = src.slice(hit.index, hit.index + consumed);
    out += src.slice(last, hit.index) + replacement + nl(original);
    last = hit.index + consumed;
  }
  out += src.slice(last);
  // Live bindings: getters defined after the module body, on the last line (line numbers above stay exact).
  const getters = tail.map((t) => {
    const [name, expr] = t.includes(':') ? t.split(':') : [t, t];
    return `Object.defineProperty(__exports, ${JSON.stringify(name)}, { enumerable: true, configurable: true, get: () => ${expr} });`;
  });
  if (defaultName) getters.push(`__exports.default = ${defaultName};`);
  if (getters.length) out += `\n;${getters.join(' ')}`;
  return { code: out, imports, exports, hasDefault };
}

/** Script names are paths without the extension: "enemies/Patrol". */
export const SCRIPT_PATH_RE = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}\/){0,8}[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function scriptBaseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function scriptDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * Resolves an import specifier from the module `from`: "./x" and "../x" are relative to its folder,
 * anything else starts at scripts/. A trailing ".js" is optional.
 */
export function resolveImport(from: string, spec: string): string {
  let s = spec.trim().replace(/\.js$/, '');
  if (s.startsWith('/')) s = s.slice(1);
  const parts = s.startsWith('.') ? [...(scriptDir(from) ? scriptDir(from).split('/') : []), ...s.split('/')] : s.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (!out.length) throw new Error(`Import "${spec}" goes outside scripts/`);
      out.pop();
    } else out.push(p);
  }
  return out.join('/');
}
