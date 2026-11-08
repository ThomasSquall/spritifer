/** A color swatch plus a hex text field: the text keeps what the swatch can't (alpha "#rrggbbaa", "#rgb"). */

import { h } from './dom.js';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function swatchValue(c: string, fallback: string): string {
  let s = c.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((ch) => ch + ch).join('');
  s = '#' + s.slice(0, 6);
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : fallback;
}

/** `value` '' = empty (placeholder shown, e.g. "inherit"); onChange receives a valid hex or ''. */
export function colorInput(value: string, onChange: (v: string) => void, opts: { fallback?: string; placeholder?: string; allowEmpty?: boolean } = {}): HTMLElement {
  const fallback = opts.fallback ?? '#000000';
  const swatch = h('input', { type: 'color', value: swatchValue(value || fallback, fallback) });
  const text = h('input', { type: 'text', class: 'color-hex', spellcheck: false, value, placeholder: opts.placeholder ?? fallback, maxLength: 9 });
  swatch.addEventListener('input', () => {
    // Keep the alpha the text had.
    const alpha = /^#[0-9a-f]{8}$/i.test(text.value) ? text.value.slice(7) : '';
    text.value = swatch.value + alpha;
    text.classList.remove('invalid');
    onChange(text.value);
  });
  text.addEventListener('change', () => {
    const v = text.value.trim();
    if (v === '' && opts.allowEmpty) {
      text.classList.remove('invalid');
      swatch.value = swatchValue(fallback, fallback);
      onChange('');
      return;
    }
    const hex = v.startsWith('#') ? v : `#${v}`;
    if (!HEX.test(hex)) {
      text.classList.add('invalid');
      return;
    }
    text.value = hex.toLowerCase();
    text.classList.remove('invalid');
    swatch.value = swatchValue(hex, fallback);
    onChange(text.value);
  });
  return h('span', { class: 'color-input' }, swatch, text);
}
