/** In-game pixel fonts: the built-in 3x5 (4x6 cell, lowercase renders as uppercase) and fonts a game can pick instead. */

import { PIXEL_OPERATOR_GLYPHS } from './fontPixelOperator.js';

/** Five rows of three pixels per glyph. */
const ROWS: Record<string, string> = {
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.', E: '### #.. ##. #.. ###',
  F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#', I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.',
  K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###', M: '#.# ### #.# #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.',
  P: '##. #.# ##. #.. #..', Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.',
  U: '#.# #.# #.# #.# ###', V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#', Y: '#.# #.# .#. .#. .#.',
  Z: '### ..# .#. #.. ###', '0': '### #.# #.# #.# ###', '1': '.#. ##. .#. .#. ###', '2': '##. ..# .#. #.. ###', '3': '##. ..# .#. ..# ##.',
  '4': '#.# #.# ### ..# ..#', '5': '### #.. ##. ..# ##.', '6': '.## #.. ### #.# ###', '7': '### ..# .#. .#. .#.', '8': '### #.# ### #.# ###',
  '9': '### #.# ### ..# ##.', '.': '... ... ... ... .#.', ',': '... ... ... .#. #..', '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.',
  ':': '... .#. ... .#. ...', ';': '... .#. ... .#. #..', '-': '... ... ### ... ...', '+': '... .#. ### .#. ...', '=': '... ### ... ### ...',
  '/': '..# ..# .#. #.. #..', "'": '.#. .#. ... ... ...', '"': '#.# #.# ... ... ...', '(': '.#. #.. #.. #.. .#.', ')': '.#. ..# ..# ..# .#.',
  '%': '#.# ..# .#. #.. #.#', '<': '..# .#. #.. .#. ..#', '>': '#.. .#. ..# .#. #..', _: '... ... ... ... ###', '*': '... #.# .#. #.# ...',
  '#': '#.# ### #.# ### #.#', '[': '##. #.. #.. #.. ##.', ']': '.## ..# ..# ..# .##', $: '.## ##. .#. .## ##.', '♥': '#.# ### ### .#. ...',
  ' ': '... ... ... ... ...',
  // Accented capitals (Italian, French, Spanish...): the accent takes the top row, the letter the other four.
  À: '#.. .#. #.# ### #.#', Á: '..# .#. #.# ### #.#', È: '#.. ### ##. #.. ###', É: '..# ### ##. #.. ###',
  Ì: '#.. .#. .#. .#. .#.', Í: '..# .#. .#. .#. .#.', Ò: '#.. .#. #.# #.# .#.', Ó: '..# .#. #.# #.# .#.',
  Ù: '#.. #.# #.# #.# ###', Ú: '..# #.# #.# #.# ###', Ç: '.## #.. .## .#. #..', Ñ: '### ... ##. #.# #.#',
  '«': '... .#. #.. .#. ...', '»': '... .#. ..# .#. ...', '’': '.#. .#. ... ... ...', '…': '... ... ... ... #.#',
};

const GLYPHS: Record<string, string> = {};
for (const [k, v] of Object.entries(ROWS)) GLYPHS[k] = v.replace(/ /g, '');

export const FONT_W = 3;
export const FONT_H = 5;
export const CELL_W = 4;
export const CELL_H = 6;

export interface FontGlyph {
  advance: number;
  /** Flat list of x, y pairs, y measured from the top of the text. */
  pixels: readonly number[];
}

/** Sizes are in font pixels. Text keeps its old anchor whatever the font: y is the top of a capital letter's cell. */
export interface PixelFont {
  id: string;
  label: string;
  /** Font pixels per interface pixel: 2 draws the font at the full resolution of a uiScale 2 game. */
  density: number;
  /** Distance between the tops of two lines. */
  lineHeight: number;
  /** Height one line counts for when measuring. */
  capHeight: number;
  /** Rows above y that tall glyphs reach (accented capitals). */
  top: number;
  /** Rows below y the first line can reach (descenders). */
  bottom: number;
  glyph(ch: string): FontGlyph;
}

const builtinCache = new Map<string, FontGlyph>();

export const BUILTIN_FONT: PixelFont = {
  id: 'builtin',
  label: 'Pixel 3×5 (capitals only)',
  density: 1,
  lineHeight: CELL_H,
  capHeight: FONT_H,
  top: 0,
  bottom: CELL_H,
  glyph(ch) {
    const rows = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
    let g = builtinCache.get(rows);
    if (!g) {
      const pixels: number[] = [];
      for (let i = 0; i < 15; i++) if (rows[i] === '#') pixels.push(i % 3, Math.floor(i / 3));
      builtinCache.set(rows, (g = { advance: CELL_W, pixels }));
    }
    return g;
  },
};

/** A font baked by a build script into "advance;left;top;rows" strings. */
function bakedFont(meta: Omit<PixelFont, 'glyph'>, data: Record<string, string>, baseline: number): PixelFont {
  const cache = new Map<string, FontGlyph>();
  const decode = (ch: string): FontGlyph | undefined => {
    let g = cache.get(ch);
    if (g || data[ch] === undefined) return g;
    const [advance, left, top, rows] = data[ch].split(';');
    const pixels: number[] = [];
    rows.split(',').forEach((row, ry) => {
      const mask = row ? parseInt(row, 16) : 0;
      for (let b = 0; mask >> b; b++) if ((mask >> b) & 1) pixels.push(Number(left) + b, baseline + Number(top) + ry);
    });
    cache.set(ch, (g = { advance: Number(advance), pixels }));
    return g;
  };
  return { ...meta, glyph: (ch) => decode(ch) ?? decode('?')! };
}

/** Baseline 10 rows down, so capitals sit where the 3x5 font's did at density 2. */
export const PIXEL_OPERATOR: PixelFont = bakedFont(
  { id: 'pixel-operator', label: 'Pixel Operator', density: 2, lineHeight: 14, capHeight: 10, top: 3, bottom: 13 },
  PIXEL_OPERATOR_GLYPHS,
  10,
);

export const FONTS: readonly PixelFont[] = [BUILTIN_FONT, PIXEL_OPERATOR];

/** True when the game's interface scale draws this font on whole canvas pixels. */
export function fontFits(font: PixelFont, uiScale: number | undefined): boolean {
  return (uiScale ?? 1) % font.density === 0;
}

/** The font a game draws with. Falls back to the built-in one when the chosen font would need half pixels. */
export function gameFont(game: { font?: string; uiScale?: number } | null | undefined): PixelFont {
  const font = FONTS.find((f) => f.id === game?.font);
  return font && fontFits(font, game?.uiScale) ? font : BUILTIN_FONT;
}

/** Canvas pixels per font pixel for a text drawn at this renderer scale. Always whole. */
export function fontPixelSize(font: PixelFont, scale: number): number {
  return Math.max(1, Math.round(scale / font.density));
}

function lineAdvance(line: string, font: PixelFont): number {
  let n = 0;
  for (const ch of line) n += font.glyph(ch).advance;
  return n;
}

/** Size in interface pixels of a (possibly multi-line) text at scale 1. */
export function measureText(text: string, font: PixelFont = BUILTIN_FONT): { width: number; height: number } {
  const lines = text.split('\n');
  const advance = Math.max(0, ...lines.map((l) => lineAdvance(l, font)));
  return { width: Math.ceil(Math.max(0, advance - 1) / font.density), height: Math.ceil((font.capHeight + (lines.length - 1) * font.lineHeight) / font.density) };
}

/** Bitmap needed to hold a text, in font pixels; rasterText's y starts at -top. */
export function textBitmapSize(text: string, font: PixelFont): { width: number; height: number; top: number } {
  const lines = text.split('\n');
  return { width: Math.max(1, ...lines.map((l) => lineAdvance(l, font))), height: font.top + (lines.length - 1) * font.lineHeight + font.bottom, top: font.top };
}

/** Calls plot(x, y) in font pixels for every lit pixel of the text. */
export function rasterText(text: string, plot: (x: number, y: number) => void, font: PixelFont = BUILTIN_FONT): void {
  text.split('\n').forEach((line, row) => {
    let pen = 0;
    for (const ch of line) {
      const g = font.glyph(ch);
      for (let i = 0; i < g.pixels.length; i += 2) plot(pen + g.pixels[i], row * font.lineHeight + g.pixels[i + 1]);
      pen += g.advance;
    }
  });
}
