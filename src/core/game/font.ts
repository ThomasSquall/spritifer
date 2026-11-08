/** Built-in 3x5 pixel font (4x6 cell) for in-game text. Lowercase letters render as uppercase. */

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

export function glyph(ch: string): string {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['?'];
}

/** Size in pixels of a (possibly multi-line) text at scale 1. */
export function measureText(text: string): { width: number; height: number } {
  const lines = text.split('\n');
  const cols = Math.max(0, ...lines.map((l) => [...l].length));
  return { width: Math.max(0, cols * CELL_W - 1), height: lines.length * CELL_H - 1 };
}

/** Calls plot(x, y) for every lit pixel of the text at scale 1. */
export function rasterText(text: string, plot: (x: number, y: number) => void): void {
  text.split('\n').forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const g = glyph(ch);
      for (let i = 0; i < 15; i++) if (g[i] === '#') plot(col * CELL_W + (i % 3), row * CELL_H + Math.floor(i / 3));
    });
  });
}
