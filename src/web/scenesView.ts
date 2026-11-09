/** Scenes page: list of scenes with previews and a "new scene" form. */

import { GAME_NAME_RE } from '../core/game/types.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openPlay } from './play.js';
import { clear, confirmDialog, h, icon, promptText, toast } from './dom.js';

export function renderScenes(root: HTMLElement, open: (name: string) => void): () => void {
  clear(root);
  const grid = h('div', { class: 'gallery-grid scenes-grid' });
  const form = h('form', { class: 'form panel-card' });
  root.append(h('div', { class: 'page' }, appNav('scenes'),
    h('div', { class: 'gallery' },
      h('div', { class: 'gallery-body' },
        h('section', { class: 'gallery-main' }, h('h2', {}, 'Scenes'), grid),
        h('aside', { class: 'gallery-side' }, form,
          h('div', { class: 'panel-card help' },
            h('h3', {}, 'How scenes work'),
            h('p', { class: 'muted' }, 'A scene is a level or screen: a tile map painted with a tileset (a sprite with a tile grid), plus placed instances of your object types. Layers marked solid are walls and floors. The game starts in the start scene (★); events switch scenes with “Go to scene”.'),
          ),
        ),
      ),
    ),
  ));

  const renderForm = () => {
    clear(form);
    const tilesets = state.sprites.filter((s) => s.grid);
    const nameIn = h('input', { type: 'text', placeholder: 'level1', spellcheck: false, required: true });
    const tsSel = h('select', {}, h('option', { value: '' }, '— none (draw later) —'), ...tilesets.map((s) => h('option', { value: s.name }, `${s.name} (${s.grid!.width}px tiles)`)));
    if (tilesets.length) tsSel.value = tilesets[0].name;
    const g = state.game!;
    const tile = () => state.sprite(tsSel.value)?.grid?.width ?? 16;
    const colsIn = h('input', { type: 'number', min: '1', max: '1024', value: String(Math.ceil(g.width / tile()) * 3) });
    const rowsIn = h('input', { type: 'number', min: '1', max: '1024', value: String(Math.ceil(g.height / tile())) });
    tsSel.addEventListener('change', () => {
      colsIn.value = String(Math.ceil(g.width / tile()) * 3);
      rowsIn.value = String(Math.ceil(g.height / tile()));
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!GAME_NAME_RE.test(name)) return toast('Scene names use letters, digits and _ and start with a letter', 'error');
      try {
        await gameApi.createScene({ name, cols: Number(colsIn.value), rows: Number(rowsIn.value), tileset: tsSel.value || undefined });
        await state.load();
        open(name);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    };
    form.append(
      h('h3', {}, 'New scene'),
      h('label', {}, 'Name', nameIn),
      h('label', {}, 'Tileset', tsSel),
      h('p', { class: 'muted small', hidden: tilesets.length > 0 }, 'No tileset yet: create a sprite with a tile grid (Sprites → New sprite → Tile grid), e.g. 64×64 with 16px tiles.'),
      h('div', { class: 'row2' }, h('label', {}, 'Width (tiles)', colsIn), h('label', {}, 'Height (tiles)', rowsIn)),
      h('p', { class: 'muted small' }, `The screen shows ${g.width}×${g.height} px.`),
      h('button', { class: 'primary', type: 'submit' }, 'Create scene'),
    );
  };

  const renderGrid = () => {
    clear(grid);
    const g = state.game!;
    if (!state.scenes.length) grid.append(h('div', { class: 'empty' }, h('p', {}, 'No scenes yet.'), h('p', { class: 'muted' }, 'Create one on the right, or ask Claude to build a level.')));
    for (const s of state.scenes) {
      const isStart = g.startScene === s.name || (!g.startScene && s === state.scenes[0]);
      grid.append(h('article', { class: 'sprite-card scene-card', onclick: () => open(s.name) },
        h('div', { class: 'thumb' }, h('img', { loading: 'lazy', src: gameApi.scenePreviewUrl(s.name, s.rev, 1), alt: s.name, draggable: false })),
        h('div', { class: 'meta' },
          h('strong', {}, isStart ? '★ ' : '', s.name),
          h('span', { class: 'muted' }, `${s.cols}×${s.rows} tiles · ${s.instances} instance${s.instances === 1 ? '' : 's'}`),
        ),
        h('div', { class: 'card-actions' },
          h('button', { class: 'icon-btn', title: 'Play this scene', onclick: (e: Event) => { e.stopPropagation(); void openPlay(s.name); } }, icon('play', 14)),
          isStart ? null : h('button', { class: 'icon-btn', title: 'Make start scene', onclick: (e: Event) => { e.stopPropagation(); g.startScene = s.name; state.change(); } }, '★'),
          h('button', { class: 'icon-btn', title: 'Rename', onclick: async (e: Event) => {
            e.stopPropagation();
            const to = await promptText('Rename scene', 'New name', s.name);
            if (!to || to === s.name) return;
            try { await state.flush(); await gameApi.renameScene(s.name, to); await state.load(); } catch (err) { toast((err as Error).message, 'error'); }
          } }, icon('pencil', 14)),
          h('button', { class: 'icon-btn', title: 'Duplicate', onclick: async (e: Event) => {
            e.stopPropagation();
            const to = await promptText('Duplicate scene', 'New name', `${s.name}_copy`);
            if (!to) return;
            try { await gameApi.duplicateScene(s.name, to); await state.load(); } catch (err) { toast((err as Error).message, 'error'); }
          } }, icon('copy', 14)),
          h('button', { class: 'icon-btn', title: 'Delete', onclick: async (e: Event) => {
            e.stopPropagation();
            if (!(await confirmDialog('Delete scene', `Delete "${s.name}" permanently?`))) return;
            try { await gameApi.deleteScene(s.name); await state.load(); } catch (err) { toast((err as Error).message, 'error'); }
          } }, icon('trash', 14)),
        ),
      ));
    }
  };

  const refresh = () => {
    renderGrid();
    if (!form.contains(document.activeElement)) renderForm();
  };
  renderForm();
  renderGrid();
  return refresh;
}
