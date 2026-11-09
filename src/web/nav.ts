/** Top navigation shared by the project pages. */

import { h, icon } from './dom.js';
import { openExport, openPlay } from './play.js';
import { state } from './gameState.js';
import { openUsages } from './usagesView.js';

export type NavTab = 'sprites' | 'objects' | 'scenes' | 'world' | 'dialogues' | 'scripts' | 'data' | 'vfx' | 'tests' | 'game' | 'history' | 'git';

const TABS: { id: NavTab; label: string; href: string }[] = [
  { id: 'sprites', label: 'Sprites', href: '#/' },
  { id: 'objects', label: 'Objects', href: '#/objects' },
  { id: 'scenes', label: 'Scenes', href: '#/scenes' },
  { id: 'world', label: 'World', href: '#/world' },
  { id: 'dialogues', label: 'Dialogues', href: '#/dialogues' },
  { id: 'scripts', label: 'Scripts', href: '#/scripts' },
  { id: 'data', label: 'Data', href: '#/data' },
  { id: 'vfx', label: 'VFX', href: '#/vfx' },
  { id: 'tests', label: 'Tests', href: '#/tests' },
  { id: 'game', label: 'Game', href: '#/game' },
  { id: 'history', label: 'History', href: '#/history' },
  { id: 'git', label: 'Git', href: '#/git' },
];

export function appNav(active: NavTab | null): HTMLElement {
  return h('nav', { class: 'appnav' },
    h('a', { class: 'appnav-brand', href: '#/projects', title: 'All projects' }, h('span', { class: 'logo small' }), 'Spritifer'),
    h('a', { class: `appnav-project${active === null ? ' active' : ''}`, href: '#/projects', title: 'Switch or create projects' }, icon('swap', 14), h('span', {}, state.game?.title ?? 'Projects')),
    h('div', { class: 'appnav-tabs' }, ...TABS.map((t) => h('a', { class: `appnav-tab${t.id === active ? ' active' : ''}`, href: t.href }, t.label))),
    h('span', { class: 'spacer' }),
    h('button', { class: 'small', title: 'Find where a variable, object, sprite, scene or anything else is used', onclick: () => void openUsages() }, icon('target', 14), 'Find usages'),
    h('button', { class: 'small', title: 'Export the game as a single HTML file', onclick: () => void openExport() }, icon('export', 15), 'Export'),
    h('button', { class: 'primary small', title: 'Play the game (from the start scene)', onclick: () => void openPlay() }, icon('play', 13), 'Play'),
  );
}
