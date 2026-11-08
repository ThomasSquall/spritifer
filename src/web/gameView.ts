/** Game page: settings, global variables, validation and export. */

import type { GameProject, Value } from '../core/game/types.js';
import { GAME_NAME_RE, normalizeActions } from '../core/game/types.js';
import { previewSound } from './eventSheet.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openExport, openPlay } from './play.js';
import { clear, h, icon, iconButton, linkScriptRefs, promptText, toast } from './dom.js';
import { componentListCard } from './componentsUi.js';
import { sheetContext } from './objectsView.js';
import { VALUE_HINT, formatValue, parseValue } from './values.js';
import { colorInput } from './colorInput.js';

const RESOLUTIONS: [number, number, string][] = [
  [160, 144, 'handheld'],
  [256, 224, 'console'],
  [320, 180, '16:9 small'],
  [384, 216, '16:9'],
  [480, 270, '16:9 large'],
  [640, 360, '16:9 HD'],
];

const KEY_HINT = 'Keys: a–z, 0–9, space, enter, escape, shift, arrowleft/right/up/down, left/right/up/down (arrows + WASD), action, action2; gamepad: pad:a, pad:b, pad:x, pad:y, pad:lb, pad:rb, pad:lt, pad:rt, pad:start, pad:select, pad:up/down/left/right';

/** Input actions: name → keys and gamepad buttons. */
function actionsCard(g: GameProject, changed: () => void, rerender: () => void): HTMLElement {
  const rows = h('div', { class: 'props' });
  for (const [name, keys] of Object.entries(g.actions ?? {})) {
    const inp = h('input', { type: 'text', value: keys.join(', '), spellcheck: false, placeholder: 'space, w, pad:a', onchange: () => {
      g.actions = normalizeActions({ ...g.actions, [name]: inp.value }) ?? {};
      inp.value = (g.actions[name] ?? []).join(', ');
      changed();
    } });
    rows.append(h('div', { class: 'prop-row' }, h('code', {}, name), inp, iconButton('close', 'Remove', () => {
      delete g.actions![name];
      if (!Object.keys(g.actions!).length) delete g.actions;
      changed();
      rerender();
    }, { class: 'icon-btn tiny' })));
  }
  if (!Object.keys(g.actions ?? {}).length) rows.append(h('p', { class: 'muted small' }, 'Name actions (jump, attack, menu) and bind keys and gamepad buttons to them. Events and scripts use the name like a key: pressed("attack"). An action named action, up, left… remaps that built-in key.'));
  return h('div', { class: 'card' },
    h('h3', {}, 'Input actions'),
    rows,
    h('p', { class: 'muted small' }, KEY_HINT),
    h('button', { class: 'small', onclick: async () => {
      const name = await promptText('New input action', 'Name (e.g. jump, attack, menu)', '');
      if (!name) return;
      if (!GAME_NAME_RE.test(name)) return toast('Invalid name', 'error');
      g.actions = { ...(g.actions ?? {}), [name]: [] };
      changed();
      rerender();
    } }, icon('plus', 13), 'Action'),
  );
}

/** Audio files of the project: upload, listen, delete. */
function audioCard(rerender: () => void): HTMLElement {
  const list = h('div', { class: 'audio-list' });
  const draw = () => {
    clear(list);
    if (!state.audio.length) list.append(h('p', { class: 'muted small' }, 'Music and sound effects (mp3, ogg, wav, m4a). Use them with sound("name"), music("name"), the Scene tab (music of a scene) and the events Play sound / Play music.'));
    for (const name of state.audio) {
      list.append(h('div', { class: 'prop-row' },
        h('code', {}, name),
        h('span', { class: 'param-inline' },
          iconButton('play', 'Listen', () => previewSound(name, state.audio), { class: 'icon-btn tiny' }),
          iconButton('trash', 'Delete', async () => {
            try {
              await gameApi.deleteAudio(name);
              state.audio = state.audio.filter((x) => x !== name);
              draw();
            } catch (err) {
              toast((err as Error).message, 'error');
            }
          }, { class: 'icon-btn tiny' })),
        h('span', {}),
      ));
    }
  };
  const file = h('input', { type: 'file', accept: '.mp3,.ogg,.wav,.m4a,audio/*', multiple: true, hidden: true, onchange: async () => {
    for (const f of [...(file.files ?? [])]) {
      const m = /^(.*)\.(mp3|ogg|wav|m4a)$/i.exec(f.name);
      if (!m) {
        toast(`${f.name}: use mp3, ogg, wav or m4a`, 'error');
        continue;
      }
      const name = m[1].replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^([^A-Za-z_])/, '_$1').slice(0, 64);
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        await gameApi.uploadAudio(name, m[2], btoa(bin));
        if (!state.audio.includes(name)) state.audio = [...state.audio, name].sort();
        toast(`Added audio/${name}.${m[2].toLowerCase()}`);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    }
    file.value = '';
    draw();
    void rerender;
  } });
  draw();
  return h('div', { class: 'card' }, h('h3', {}, 'Audio'), list, file, h('button', { class: 'small', onclick: () => file.click() }, icon('plus', 13), 'Import audio files'));
}

export function renderGameSettings(root: HTMLElement): () => void {
  clear(root);
  const body = h('div', { class: 'settings' });
  root.append(h('div', { class: 'page' }, appNav('game'), h('div', { class: 'gallery' }, body)));

  const render = () => {
    clear(body);
    const g = state.game!;
    const changed = () => state.change();
    const titleIn = h('input', { type: 'text', value: g.title, oninput: () => { g.title = titleIn.value || 'My Game'; changed(); } });
    const wIn = h('input', { type: 'number', min: '16', max: '1920', value: String(g.width), onchange: () => { g.width = Math.max(16, Number(wIn.value) || 320); changed(); } });
    const hIn = h('input', { type: 'number', min: '16', max: '1080', value: String(g.height), onchange: () => { g.height = Math.max(16, Number(hIn.value) || 180); changed(); } });
    const presets = h('div', { class: 'chips' }, ...RESOLUTIONS.map(([w, hh, label]) => h('button', { type: 'button', class: `chip${g.width === w && g.height === hh ? ' on' : ''}`, title: label, onclick: () => { g.width = w; g.height = hh; changed(); render(); } }, `${w}×${hh}`)));
    const zoomSel = h('select', { onchange: () => { g.zoom = zoomSel.value === 'fit' ? 'fit' : Number(zoomSel.value); changed(); } },
      h('option', { value: 'fit', selected: g.zoom === 'fit' }, 'Fit window (integer)'),
      ...Array.from({ length: 16 }, (_, i) => i + 1).map((z) => h('option', { value: String(z), selected: g.zoom === z }, `${z}×`)),
    );
    const uiScaleIn = h('input', { type: 'number', min: '1', max: '8', title: 'Interface pixels are this many canvas pixels: width 960 with UI scale 3 keeps scripts and dialogs in 320×180', value: String(g.uiScale ?? 1), onchange: () => {
      const k = Math.max(1, Math.min(8, Math.round(Number(uiScaleIn.value) || 1)));
      if (k > 1) g.uiScale = k;
      else delete g.uiScale;
      changed();
    } });
    const bgIn = colorInput(g.background, (v) => { if (v) { g.background = v; changed(); } }, { fallback: '#181425' });
    const gravIn = h('input', { type: 'number', value: String(g.gravity), oninput: () => { g.gravity = Number(gravIn.value) || 0; changed(); } });
    const startSel = h('select', { onchange: () => { g.startScene = startSel.value; changed(); } }, ...state.scenes.map((s) => h('option', { value: s.name, selected: s.name === g.startScene }, s.name)));
    const touchIn = h('input', { type: 'checkbox', checked: g.touchControls, onchange: () => { g.touchControls = touchIn.checked; changed(); } });

    const vars = h('div', { class: 'props' });
    const parse = parseValue;
    for (const [k, v] of Object.entries(g.variables)) {
      const vi = h('input', { type: 'text', title: VALUE_HINT, value: formatValue(v), oninput: () => { g.variables[k] = parse(vi.value); changed(); } });
      vars.append(h('div', { class: 'prop-row' }, h('code', {}, k), vi, iconButton('close', 'Remove', () => { delete g.variables[k]; changed(); render(); }, { class: 'icon-btn tiny' })));
    }
    if (!Object.keys(g.variables).length) vars.append(h('p', { class: 'muted small' }, 'Global variables (score, lives, coins…) are kept across scenes. Use them in events and text.'));

    const problems = h('div', { class: 'problems-list' }, h('p', { class: 'muted small' }, 'Checking…'));
    void gameApi.problems().then((ps) => {
      clear(problems);
      if (!ps.length) problems.append(h('p', { class: 'ok-line' }, '✓ No problems found'));
      for (const p of ps) problems.append(h('div', { class: 'problem' }, h('code', {}, p.where), ' ', ...linkScriptRefs(p.message)));
    }).catch((err: Error) => toast(err.message, 'error'));

    body.append(
      h('div', { class: 'settings-head' },
        h('h1', {}, g.title),
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => void openExport() }, icon('export', 16), 'Export for web'),
        h('button', { class: 'primary', onclick: () => void openPlay() }, icon('play', 14), 'Play'),
      ),
      h('div', { class: 'settings-grid' },
        h('div', { class: 'card form' },
          h('h3', {}, 'Game'),
          h('label', {}, 'Title', titleIn),
          h('div', { class: 'row2' }, h('label', {}, 'Screen width (px)', wIn), h('label', {}, 'Screen height (px)', hIn)),
          presets,
          h('div', { class: 'row2' }, h('label', {}, 'Zoom', zoomSel), h('label', {}, 'UI scale', uiScaleIn)),
          h('label', {}, 'Background', bgIn),
          h('div', { class: 'row2' }, h('label', {}, 'Gravity (px/s²)', gravIn), h('label', {}, 'Start scene', startSel)),
          h('label', { class: 'inline' }, touchIn, 'On-screen controls on phones and tablets'),
        ),
        h('div', { class: 'card' },
          h('h3', {}, 'Global variables'),
          vars,
          h('button', { class: 'small', onclick: async () => {
            const name = await promptText('New variable', 'Name (e.g. score, lives)', '');
            if (!name) return;
            if (!GAME_NAME_RE.test(name)) return toast('Invalid name', 'error');
            g.variables[name] = 0;
            changed();
            render();
          } }, icon('plus', 13), 'Variable'),
        ),
        h('div', { class: 'card' },
          h('h3', {}, 'Global components'),
          componentListCard('', 'Created when the game starts and kept across scenes: a GameManager, an inventory, a HUD on every scene. They get onSceneStart(name) / onSceneEnd(name).', () => g.components, (list) => { if (list?.length) g.components = list; else delete g.components; }, () => sheetContext(null, []), changed),
        ),
        audioCard(render),
        actionsCard(g, changed, render),
        h('div', { class: 'card' },
          h('h3', {}, 'Checks'),
          problems,
          h('h3', { class: 'mt' }, 'Controls in the game'),
          h('table', { class: 'keys' },
            h('tr', {}, h('td', {}, h('kbd', {}, '←→↑↓'), ' / ', h('kbd', {}, 'WASD')), h('td', {}, 'left, right, up, down')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'Space'), ' ', h('kbd', {}, 'Z'), ' ', h('kbd', {}, 'J')), h('td', {}, 'action (jump)')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'X'), ' ', h('kbd', {}, 'K')), h('td', {}, 'action2')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'F2')), h('td', {}, 'show hitboxes')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'F3')), h('td', {}, 'music on/off')),
          ),
        ),
      ),
    );
  };
  render();
  return () => {
    if (!body.contains(document.activeElement) || document.activeElement === document.body) render();
  };
}
