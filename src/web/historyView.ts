/** History page: every change to the game, by the person or by Claude, each one undoable on its own. */

import { clear, h, toast } from './dom.js';
import { type HistoryEntry, gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { flushAll } from './play.js';

const KIND_HREF: Record<HistoryEntry['kind'], (n: string) => string> = {
  game: () => '#/game',
  scene: (n) => `#/scene/${encodeURIComponent(n)}`,
  data: (n) => `#/data/${encodeURIComponent(n)}`,
  vfx: (n) => `#/vfx/${encodeURIComponent(n)}`,
  script: (n) => `#/scripts/${encodeURIComponent(n)}`,
  dialogue: (n) => `#/dialogues/${encodeURIComponent(n)}`,
};

const authorLabel = (a: string) => (a === 'claude' ? 'Claude' : a === 'editor' ? 'You' : a);

export function renderHistory(root: HTMLElement): () => void {
  clear(root);
  const list = h('div', { class: 'history-list' });
  let author = '';
  const filter = h('select', { 'aria-label': 'Who made the changes', onchange: () => { author = filter.value; void refresh(); } },
    h('option', { value: '' }, 'Everyone'), h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'editor' }, 'You'));
  root.append(h('div', { class: 'page' }, appNav('history'), h('main', { class: 'history-page' },
    h('div', { class: 'tests-bar' }, h('h2', {}, 'History'), h('span', { class: 'muted' }, 'Undoing a change keeps what was done after it.'), h('span', { class: 'spacer' }), filter),
    list)));

  const undo = async (e: HistoryEntry, btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      await flushAll();
      const r = await gameApi.undoChange(e.id);
      await state.load();
      toast(r.conflicts.length ? `Undone, except what changed again: ${r.conflicts.slice(0, 3).join(', ')}` : `Undone: ${e.name}`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    btn.disabled = false;
    void refresh();
  };

  async function refresh(): Promise<void> {
    try {
      const entries = await gameApi.history(author);
      clear(list);
      if (!entries.length) list.append(h('div', { class: 'empty big' }, h('h2', {}, 'Nothing yet'), h('p', {}, 'Changes to scenes, objects, tables, effects, scripts and dialogues appear here as they are made.')));
      for (const e of entries) {
        const btn: HTMLButtonElement = h('button', { class: 'small', disabled: !!e.undoneBy, onclick: () => void undo(e, btn) }, e.undoneBy ? 'Undone' : e.undoOf ? 'Redo' : 'Undo');
        list.append(h('div', { class: `history-row${e.undoneBy ? ' undone' : ''}` },
          h('span', { class: `history-author${e.author === 'claude' ? ' by-claude' : ''}` }, authorLabel(e.author)),
          h('a', { class: 'history-target', href: KIND_HREF[e.kind](e.name) }, e.kind === 'game' ? 'Game' : `${e.kind} ${e.name}`),
          h('span', { class: 'muted history-summary' }, `${e.undoOf ? 'undo: ' : ''}${e.summary}`),
          h('span', { class: 'spacer' }),
          h('time', { class: 'muted small' }, new Date(e.time).toLocaleString()),
          btn));
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  void refresh();
  return () => void refresh();
}
