/** Find usages: a dialog that lists, with links, where something is used in the whole project. */

import type { Usage, UsageKind } from '../core/game/usages.js';
import { SOUNDS } from '../core/game/catalog.js';
import { clear, h, modal, toast } from './dom.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { flushAll } from './play.js';

const LABELS: Record<UsageKind, string> = {
  variable: 'Variable', object: 'Object type', sprite: 'Sprite', scene: 'Scene', dialogue: 'Dialogue',
  component: 'Component', sound: 'Sound or music', table: 'Data table', vfx: 'Effect',
};

function namesOf(kind: UsageKind): string[] {
  const g = state.game;
  switch (kind) {
    case 'variable': return Object.keys(g?.variables ?? {});
    case 'object': return (g?.objects ?? []).map((o) => o.name);
    case 'sprite': return state.sprites.map((s) => s.name);
    case 'scene': return state.scenes.map((s) => s.name);
    case 'dialogue': return state.dialogueInfo.nodes;
    case 'component': return state.scriptInfo.components.map((c) => c.name);
    case 'sound': return [...state.audio, ...SOUNDS];
    case 'table': return state.tables.map((t) => t.name);
    case 'vfx': return state.vfx;
  }
}

const enc = encodeURIComponent;

/** The editor page that shows a usage. */
export function usageHref(u: Usage): string {
  switch (u.area) {
    case 'instance': return `#/scene/${enc(u.owner)}~${enc(u.instanceId ?? '')}`;
    case 'scene': return `#/scene/${enc(u.owner)}`;
    case 'object': return `#/objects/${enc(u.owner)}`;
    case 'script': return `#/scripts/${enc(`${u.owner}:${u.line ?? 1}`)}`;
    case 'dialogue': return `#/dialogues/${enc(u.owner)}`;
    case 'data': return `#/data/${enc(u.owner)}`;
    case 'vfx': return `#/vfx/${enc(u.owner)}`;
    case 'game': return '#/game';
  }
}

const AREA_LABEL: Record<Usage['area'], string> = { game: 'Game', object: 'Object', scene: 'Scene', instance: 'Scene', script: 'Script', dialogue: 'Dialogue', data: 'Data', vfx: 'Effect' };

export async function openUsages(kind: UsageKind = 'variable', name = ''): Promise<void> {
  await state.ensure();
  await flushAll();
  await modal('Find usages', (close) => {
    const kindSel = h('select', { 'aria-label': 'What to look for', onchange: () => { fillNames(); nameIn.value = ''; clear(results); } },
      ...(Object.keys(LABELS) as UsageKind[]).map((k) => h('option', { value: k, selected: k === kind }, LABELS[k])));
    const list = h('datalist', { id: 'usage-names' });
    const nameIn = h('input', { type: 'text', list: 'usage-names', value: name, placeholder: 'Name', spellcheck: false, 'aria-label': 'Name' });
    const results = h('div', { class: 'usage-results' });
    const fillNames = () => list.replaceChildren(...namesOf(kindSel.value as UsageKind).sort().map((n) => h('option', { value: n })));

    const search = async () => {
      const target = nameIn.value.trim();
      if (!target) return;
      clear(results);
      results.append(h('p', { class: 'muted' }, 'Looking…'));
      try {
        show(await gameApi.usages(kindSel.value as UsageKind, target), target);
      } catch (err) {
        clear(results);
        toast((err as Error).message, 'error');
      }
    };

    const show = (usages: Usage[], target: string) => {
      clear(results);
      if (!usages.length) {
        results.append(h('p', { class: 'muted' }, `Nothing in this project uses “${target}”.`));
        return;
      }
      const groups = new Map<string, Usage[]>();
      for (const u of usages) {
        const key = `${AREA_LABEL[u.area]} ${u.owner}`;
        groups.set(key, [...(groups.get(key) ?? []), u]);
      }
      const reads = usages.filter((u) => u.access === 'read').length;
      const writes = usages.filter((u) => u.access === 'write').length;
      results.append(h('p', { class: 'small muted' }, `${usages.length} use${usages.length === 1 ? '' : 's'} in ${groups.size} place${groups.size === 1 ? '' : 's'}${kindSel.value === 'variable' ? ` · read ${reads} · written ${writes}` : ''}`));
      for (const [key, list2] of groups) {
        results.append(h('details', { class: 'usage-group', open: groups.size <= 6 },
          h('summary', {}, key, h('span', { class: 'muted small' }, ` ${list2.length}`)),
          ...list2.slice(0, 200).map((u) => h('a', { class: 'usage-row', href: usageHref(u), onclick: () => close() },
            u.access === 'ref' ? null : h('span', { class: `usage-access ${u.access}` }, u.access),
            h('span', { class: 'usage-where' }, u.where),
            u.text && u.text !== target ? h('code', { class: 'usage-text' }, u.text.slice(0, 120)) : null)),
          list2.length > 200 ? h('p', { class: 'muted small' }, `… ${list2.length - 200} more`) : null,
        ));
      }
    };

    fillNames();
    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void search();
    });
    if (name) void search();
    else setTimeout(() => nameIn.focus(), 0);
    return h('div', { class: 'form' },
      h('div', { class: 'usage-search' }, kindSel, nameIn, list, h('button', { class: 'primary', onclick: () => void search() }, 'Find')),
      results);
  }, { wide: true });
}
