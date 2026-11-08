import { normalizeHex, parseColor, toHex } from '../core/color.js';
import { RAMP_NAME_RE, renameRamp, setRamp } from '../core/reference.js';
import { generateRamp } from '../core/shapes.js';
import type { Editor } from './editor.js';
import { clear, confirmDialog, h, iconButton, modal, toast } from './dom.js';
import './spriteTools.css';

/** Named color ramps (set_ramp): listed under the palette, edited in a dialog. */
export function mountRamps(ed: Editor): { el: HTMLElement; render: () => void; renderColors: () => void } {
  const list = h('div', { class: 'ramp-list' });
  const el = h('div', { class: 'ramps' },
    h('div', { class: 'sub-title' }, 'Ramps', h('div', { class: 'spacer' }),
      iconButton('plus', 'New ramp (darkest shade first)', () => void rampDialog(null), { class: 'icon-btn tiny' })),
    list,
  );

  function render() {
    clear(list);
    const entries = Object.entries(ed.sprite.ramps);
    if (!entries.length) list.append(h('p', { class: 'muted small empty-note' }, 'No ramps. Ramps are shade lists per material (skin, cloth…), used as "name.N".'));
    for (const [name, colors] of entries) {
      list.append(
        h('div', { class: 'ramp-row' },
          h('button', { class: 'ramp-name', title: `Edit ramp "${name}"`, onclick: () => void rampDialog(name) }, name),
          h('div', { class: 'ramp-swatches' },
            ...colors.map((c, i) => {
              const sw = h('button', {
                class: 'swatch',
                style: `background:${c}`,
                title: `${name}.${i} ${c} — click: primary, right-click: secondary`,
                onclick: () => { ed.primary = c; ed.emit('color'); },
                oncontextmenu: (e: MouseEvent) => { e.preventDefault(); ed.secondary = c; ed.emit('color'); },
              });
              sw.dataset.c = c;
              return sw;
            }),
          ),
          iconButton('pencil', `Edit ramp "${name}"`, () => void rampDialog(name), { class: 'icon-btn tiny' }),
        ),
      );
    }
    renderColors();
  }

  function renderColors() {
    for (const sw of list.querySelectorAll<HTMLElement>('.swatch')) {
      sw.classList.toggle('sel', sw.dataset.c === ed.primary);
      sw.classList.toggle('sel2', sw.dataset.c === ed.secondary);
    }
  }

  async function rampDialog(existing: string | null) {
    const initial = existing ? [...ed.sprite.ramps[existing]] : [];
    let shades: string[] = initial.length ? initial : defaultShades(ed.primary);
    await modal(existing ? `Ramp “${existing}”` : 'New ramp', (close) => {
      const nameIn = h('input', { type: 'text', value: existing ?? suggestName(Object.keys(ed.sprite.ramps)), spellcheck: false });
      const rows = h('div', { class: 'shade-list' });
      const strip = h('div', { class: 'ramp-strip' });
      const baseIn = h('input', { type: 'color', value: solid(shades[Math.floor((shades.length - 1) / 2)] ?? '#888888') });
      const stepsIn = h('input', { type: 'number', min: '2', max: '9', value: String(Math.max(2, Math.min(9, shades.length || 5))) });
      const hueIn = h('input', { type: 'number', min: '0', max: '60', step: '1', value: '18' });
      const contrastIn = h('input', { type: 'number', min: '0.03', max: '0.25', step: '0.01', value: '0.1' });

      const renderRows = () => {
        clear(rows);
        clear(strip);
        shades.forEach((c, i) => {
          strip.append(h('span', { style: `background:${c}`, title: `${nameIn.value || 'ramp'}.${i} ${c}` }));
          const colorIn = h('input', { type: 'color', value: solid(c), title: 'Pick shade' });
          const hexIn = h('input', { type: 'text', value: c, spellcheck: false, class: 'hex-small' });
          colorIn.oninput = () => {
            const a = parseColor(shades[i])[3] || 255;
            shades[i] = toHex([...parseColor(colorIn.value).slice(0, 3), a] as [number, number, number, number]);
            hexIn.value = shades[i];
            (strip.children[i] as HTMLElement).style.background = shades[i];
          };
          hexIn.onchange = () => {
            try {
              shades[i] = normalizeHex(hexIn.value);
              renderRows();
            } catch {
              toast('Invalid color', 'error');
              hexIn.value = shades[i];
            }
          };
          rows.append(
            h('div', { class: 'shade-row' },
              h('span', { class: 'muted small shade-idx' }, `.${i}`),
              colorIn,
              hexIn,
              iconButton('up', 'Darker position (move up)', () => { if (i > 0) { [shades[i - 1], shades[i]] = [shades[i], shades[i - 1]]; renderRows(); } }, { class: 'icon-btn tiny', disabled: i === 0 }),
              iconButton('down', 'Lighter position (move down)', () => { if (i < shades.length - 1) { [shades[i + 1], shades[i]] = [shades[i], shades[i + 1]]; renderRows(); } }, { class: 'icon-btn tiny', disabled: i === shades.length - 1 }),
              iconButton('pencil', 'Use as primary color', () => { ed.primary = shades[i]; ed.emit('color'); }, { class: 'icon-btn tiny' }),
              iconButton('trash', 'Remove shade', () => { shades.splice(i, 1); renderRows(); }, { class: 'icon-btn tiny' }),
            ),
          );
        });
      };
      renderRows();

      const generate = () => {
        try {
          shades = generateRamp(parseColor(baseIn.value), {
            steps: Number(stepsIn.value) || 5,
            hueShift: Number(hueIn.value),
            contrast: Number(contrastIn.value) || undefined,
          });
          renderRows();
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      };

      return h('form', {
        class: 'form ramp-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const name = nameIn.value.trim();
          if (!RAMP_NAME_RE.test(name)) return toast('Ramp names use letters, digits, "_" and "-" and cannot start with a digit', 'error');
          if (!shades.length) return toast('Add at least one shade', 'error');
          const err = ed.tryEdit((s) => {
            if (existing && existing !== name) renameRamp(s, existing, name);
            else if (!existing && s.ramps[name]) throw new Error(`A ramp named "${name}" already exists`);
            setRamp(s, name, shades);
          });
          if (err) return toast(err.message, 'error');
          close();
        },
      },
        h('label', {}, 'Name (used as name.0 … name.N)', nameIn),
        strip,
        h('div', { class: 'sub-title' }, 'Shades, darkest first'),
        rows,
        h('div', { class: 'actions left' },
          h('button', { type: 'button', class: 'small', onclick: () => { shades.push(ed.primary === 'transparent' ? (shades[shades.length - 1] ?? '#888888') : ed.primary); renderRows(); } }, '+ Add primary color'),
        ),
        h('details', { class: 'ramp-gen' },
          h('summary', {}, 'Generate from a base color (hue-shifted)'),
          h('div', { class: 'row2' }, h('label', {}, 'Base (middle shade)', baseIn), h('label', {}, 'Shades', stepsIn)),
          h('div', { class: 'row2' }, h('label', {}, 'Hue shift (°)', hueIn), h('label', {}, 'Contrast (lightness step)', contrastIn)),
          h('div', { class: 'actions left' }, h('button', { type: 'button', class: 'small', onclick: generate }, 'Generate shades')),
        ),
        h('p', { class: 'muted small' }, 'Saving adds new colors to the palette.'),
        h('div', { class: 'actions' },
          existing
            ? h('button', { type: 'button', class: 'danger', onclick: async () => {
              if (!(await confirmDialog('Delete ramp', `Delete ramp "${existing}"? Its colors stay in the palette.`))) return;
              ed.edit((s) => { delete s.ramps[existing]; });
              close();
            } }, 'Delete ramp')
            : null,
          h('div', { class: 'spacer' }),
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
        ),
      );
    });
  }

  return { el, render, renderColors };
}

function suggestName(existing: string[]): string {
  for (const n of ['skin', 'hair', 'cloth', 'leather', 'metal', 'wood', 'stone']) if (!existing.includes(n)) return n;
  let i = existing.length + 1;
  while (existing.includes(`ramp${i}`)) i++;
  return `ramp${i}`;
}

function defaultShades(primary: string): string[] {
  if (primary === 'transparent') return ['#3b2027', '#6b3e3e', '#a0614f', '#d39a76', '#f0d1b0'];
  try {
    return generateRamp(parseColor(primary));
  } catch {
    return ['#000000', '#ffffff'];
  }
}

function solid(c: string): string {
  if (c === 'transparent') return '#000000';
  const [r, g, b] = parseColor(c);
  return toHex([r, g, b, 255]);
}
