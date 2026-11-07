/** Top navigation shared by the project pages. */

import { h, icon } from './dom.js';
import { openExport, openPlay } from './play.js';

export type NavTab = 'sprites' | 'objects' | 'scenes' | 'game';

const TABS: { id: NavTab; label: string; href: string }[] = [
  { id: 'sprites', label: 'Sprites', href: '#/' },
  { id: 'objects', label: 'Objects', href: '#/objects' },
  { id: 'scenes', label: 'Scenes', href: '#/scenes' },
  { id: 'game', label: 'Game', href: '#/game' },
];

export function appNav(active: NavTab | null): HTMLElement {
  return h('nav', { class: 'appnav' },
    h('a', { class: 'appnav-brand', href: '#/' }, h('span', { class: 'logo small' }), 'Spritifer'),
    h('div', { class: 'appnav-tabs' }, ...TABS.map((t) => h('a', { class: `appnav-tab${t.id === active ? ' active' : ''}`, href: t.href }, t.label))),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small', title: 'Export the game as a single HTML file', onclick: () => void openExport() }, icon('export', 15), 'Export'),
    h('button', { class: 'primary small', title: 'Play the game (from the start scene)', onclick: () => void openPlay() }, icon('play', 13), 'Play'),
  );
}
