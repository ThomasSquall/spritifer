/** Game page: settings, global variables, validation and export. */

import type { Value } from '../core/game/types.js';
import { GAME_NAME_RE } from '../core/game/types.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openExport, openPlay } from './play.js';
import { clear, h, icon, iconButton, linkScriptRefs, promptText, toast } from './dom.js';
import { componentListCard } from './componentsUi.js';
import { sheetContext } from './objectsView.js';

const RESOLUTIONS: [number, number, string][] = [
  [160, 144, 'handheld'],
  [256, 224, 'console'],
  [320, 180, '16:9 small'],
  [384, 216, '16:9'],
  [480, 270, '16:9 large'],
  [640, 360, '16:9 HD'],
];

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
      ...[1, 2, 3, 4, 5, 6].map((z) => h('option', { value: String(z), selected: g.zoom === z }, `${z}×`)),
    );
    const bgIn = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(g.background) ? g.background : '#181425', oninput: () => { g.background = bgIn.value; changed(); } });
    const gravIn = h('input', { type: 'number', value: String(g.gravity), oninput: () => { g.gravity = Number(gravIn.value) || 0; changed(); } });
    const startSel = h('select', { onchange: () => { g.startScene = startSel.value; changed(); } }, ...state.scenes.map((s) => h('option', { value: s.name, selected: s.name === g.startScene }, s.name)));
    const touchIn = h('input', { type: 'checkbox', checked: g.touchControls, onchange: () => { g.touchControls = touchIn.checked; changed(); } });

    const vars = h('div', { class: 'props' });
    const parse = (s: string): Value => (s === 'true' ? true : s === 'false' ? false : s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s);
    for (const [k, v] of Object.entries(g.variables)) {
      const vi = h('input', { type: 'text', value: String(v), oninput: () => { g.variables[k] = parse(vi.value); changed(); } });
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
          h('div', { class: 'row2' }, h('label', {}, 'Zoom', zoomSel), h('label', {}, 'Background', bgIn)),
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
        h('div', { class: 'card' },
          h('h3', {}, 'Checks'),
          problems,
          h('h3', { class: 'mt' }, 'Controls in the game'),
          h('table', { class: 'keys' },
            h('tr', {}, h('td', {}, h('kbd', {}, '←→↑↓'), ' / ', h('kbd', {}, 'WASD')), h('td', {}, 'left, right, up, down')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'Space'), ' ', h('kbd', {}, 'Z'), ' ', h('kbd', {}, 'J')), h('td', {}, 'action (jump)')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'X'), ' ', h('kbd', {}, 'K')), h('td', {}, 'action2')),
            h('tr', {}, h('td', {}, h('kbd', {}, 'F2')), h('td', {}, 'show hitboxes')),
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
