/** RGBA color with 0-255 channels. */
export type RGBA = [number, number, number, number];

export const TRANSPARENT: RGBA = [0, 0, 0, 0];

const HEX_RE = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Parses "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" or "transparent".
 * When a palette is given, "p3" / "3" style references resolve to palette entries.
 */
export function parseColor(input: string | number, palette?: readonly string[]): RGBA {
  if (typeof input === 'number' || /^p?\d+$/i.test(String(input).trim())) {
    const idx = typeof input === 'number' ? input : parseInt(String(input).trim().replace(/^p/i, ''), 10);
    if (!palette || idx < 0 || idx >= palette.length) {
      throw new Error(`Palette index ${idx} out of range (palette has ${palette?.length ?? 0} colors)`);
    }
    return parseColor(palette[idx]);
  }
  const s = input.trim().toLowerCase();
  if (s === 'transparent' || s === 'none' || s === 'clear') return [0, 0, 0, 0];
  const m = HEX_RE.exec(s);
  if (!m) throw new Error(`Invalid color "${input}". Use #rrggbb, #rrggbbaa, "transparent" or a palette index.`);
  let h = m[1];
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return a === 0 ? [0, 0, 0, 0] : [r, g, b, a];
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

/** Formats a color as "#rrggbb" (opaque), "#rrggbbaa" (translucent) or "transparent". */
export function toHex(c: RGBA): string {
  if (c[3] === 0) return 'transparent';
  const base = `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
  return c[3] === 255 ? base : base + hex2(c[3]);
}

export function normalizeHex(input: string): string {
  return toHex(parseColor(input));
}

export function colorsEqual(a: RGBA, b: RGBA): boolean {
  if (a[3] === 0 && b[3] === 0) return true;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** Source-over alpha compositing of `src` (with extra opacity 0..1) onto `dst`. */
export function blendOver(dst: RGBA, src: RGBA, opacity = 1): RGBA {
  const sa = (src[3] / 255) * opacity;
  if (sa <= 0) return dst;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  const ch = (i: number) => Math.round((src[i] * sa + dst[i] * da * (1 - sa)) / oa);
  return [ch(0), ch(1), ch(2), Math.round(oa * 255)];
}

export const PALETTES: Record<string, string[]> = {
  pico8: [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
  ],
  sweetie16: [
    '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
    '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57',
  ],
  db16: [
    '#140c1c', '#442434', '#30346d', '#4e4a4e', '#854c30', '#346524', '#d04648', '#757161',
    '#597dce', '#d27d2c', '#8595a1', '#6daa2c', '#d2aa99', '#6dc2ca', '#dad45e', '#deeed6',
  ],
  endesga32: [
    '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
    '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
    '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
    '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569',
  ],
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
};

export const DEFAULT_PALETTE = 'endesga32';
