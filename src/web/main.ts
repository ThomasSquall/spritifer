import './styles.css';
import { deserializeSprite } from '../core/sprite.js';
import { api, connectLive, type ChangeEvent } from './api.js';
import { Editor } from './editor.js';
import { mountEditor } from './editorView.js';
import { renderGallery } from './gallery.js';
import { toast } from './dom.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { renderObjects } from './objectsView.js';
import { renderScenes } from './scenesView.js';
import { renderGameSettings } from './gameView.js';
import { type SceneEditorHandle, mountSceneEditor } from './sceneEditor.js';

const root = document.getElementById('app')!;

let live = false;
let current: { editor: Editor; view: ReturnType<typeof mountEditor> } | null = null;
let sceneEd: SceneEditorHandle | null = null;
/** Re-renders the current list page after remote changes. */
let refreshPage: (() => void) | null = null;
let page: 'sprites' | 'objects' | 'scenes' | 'game' | 'sprite' | 'scene' = 'sprites';

/** The previous in-app page, so "back" from the sprite editor returns where the user came from. */
let prevHash = '#/';
let curHash = location.hash || '#/';
window.addEventListener('hashchange', () => {
  if (!/^#\/edit\//.test(curHash)) prevHash = curHash;
  curHash = location.hash || '#/';
});

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

async function route(): Promise<void> {
  if (current) {
    await current.editor.flush();
    current.view.destroy();
    current = null;
  }
  if (sceneEd) {
    sceneEd.destroy();
    sceneEd = null;
  }
  refreshPage = null;
  const hash = location.hash;
  let m: RegExpExecArray | null;

  if ((m = /^#\/edit\/(.+)$/.exec(hash))) {
    page = 'sprite';
    const name = decodeURIComponent(m[1]);
    try {
      const editor = new Editor(deserializeSprite(await api.get(name)));
      const view = mountEditor(root, editor, { onBack: () => go(/^#\/edit\//.test(prevHash) ? '#/' : prevHash), liveStatus: () => live });
      current = { editor, view };
    } catch (err) {
      toast((err as Error).message, 'error');
      go('#/');
    }
    return;
  }

  try {
    await state.ensure();
  } catch (err) {
    toast(`Could not load the game project: ${(err as Error).message}`, 'error');
  }

  if ((m = /^#\/scene\/(.+)$/.exec(hash))) {
    page = 'scene';
    try {
      sceneEd = await mountSceneEditor(root, decodeURIComponent(m[1]), () => go('#/scenes'));
    } catch (err) {
      toast((err as Error).message, 'error');
      go('#/scenes');
    }
    return;
  }
  if ((m = /^#\/objects(?:\/(.+))?$/.exec(hash))) {
    page = 'objects';
    document.title = 'Objects · Spritifer';
    const sel = m[1] ? decodeURIComponent(m[1]) : (state.game?.objects[0]?.name ?? null);
    refreshPage = renderObjects(root, sel, (name) => go(name ? `#/objects/${encodeURIComponent(name)}` : '#/objects'));
    return;
  }
  if (hash === '#/scenes') {
    page = 'scenes';
    document.title = 'Scenes · Spritifer';
    refreshPage = renderScenes(root, (name) => go(`#/scene/${encodeURIComponent(name)}`));
    return;
  }
  if (hash === '#/game') {
    page = 'game';
    document.title = 'Game · Spritifer';
    refreshPage = renderGameSettings(root);
    return;
  }
  page = 'sprites';
  document.title = 'Spritifer';
  const refreshGallery = renderGallery(root, (name) => go(`#/edit/${encodeURIComponent(name)}`));
  const gallery = root.firstElementChild;
  const wrapper = document.createElement('div');
  wrapper.className = 'page';
  wrapper.append(appNav('sprites'));
  if (gallery) wrapper.append(gallery);
  root.prepend(wrapper);
  refreshPage = refreshGallery;
}

let pageTimer = 0;
const refreshSoon = () => {
  clearTimeout(pageTimer);
  pageTimer = window.setTimeout(() => refreshPage?.(), 150);
};

// Objects/game pages re-render when the shared game state changes (e.g. Claude edits game.json),
// but not while the user is typing in them.
state.subscribe(() => {
  if (page === 'scenes') refreshSoon();
});

async function onRemoteChange(e: ChangeEvent): Promise<void> {
  const kind = e.type.replace('-changed', '') as 'sprite' | 'scene' | 'game';
  const fromSelf = e.updatedBy === 'editor';
  if (kind === 'game') {
    const changed = await state.remote('game', e.rev);
    if (changed && !fromSelf) {
      if (page === 'objects' || page === 'game') {
        const active = document.activeElement;
        if (!active || active === document.body || !root.contains(active)) refreshSoon();
      }
      if (e.updatedBy === 'claude') toast('Game updated by Claude', 'claude');
    }
    return;
  }
  if (kind === 'scene') {
    await state.remote('scene', e.rev);
    if (page === 'scene' && sceneEd && location.hash === `#/scene/${encodeURIComponent(e.name)}`) await sceneEd.remote(e.rev);
    if (page === 'scenes') refreshSoon();
    return;
  }
  // Sprites.
  await state.remote('sprite', e.rev);
  if (page === 'sprites' || page === 'objects') refreshSoon();
  if (page === 'scene') sceneEd?.refreshAssets();
  if (!current || e.name !== current.editor.sprite.name) return;
  if (e.rev === null) {
    toast(`"${e.name}" was deleted`, 'error');
    go('#/');
    return;
  }
  if (e.rev === current.editor.lastRev) return;
  try {
    const file = await api.get(e.name);
    if (!current || file.rev === current.editor.lastRev) return;
    current.editor.applyRemote(file);
    current.view.flashRemote(file.updatedBy);
  } catch (err) {
    console.error(err);
  }
}

connectLive(
  (e) => void onRemoteChange(e).catch((err) => console.error(err)),
  (on) => {
    live = on;
    current?.view.setLive(on);
  },
);

window.addEventListener('hashchange', () => void route());
window.addEventListener('beforeunload', () => void state.flush());
void route();
