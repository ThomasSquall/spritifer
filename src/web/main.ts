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
import { renderProjects } from './projectsView.js';
import { renderScripts } from './scriptsView.js';
import { renderDialogues } from './dialoguesView.js';
import { currentProjectId } from './api.js';

const root = document.getElementById('app')!;

let live = false;
let current: { editor: Editor; view: ReturnType<typeof mountEditor> } | null = null;
let sceneEd: SceneEditorHandle | null = null;
/** Re-renders the current list page after remote changes. */
let refreshPage: (() => void) | null = null;
let page: 'sprites' | 'objects' | 'scenes' | 'scripts' | 'dialogues' | 'game' | 'sprite' | 'scene' | 'projects' = 'sprites';
let scriptsPage: { refresh: () => void; destroy: () => void } | null = null;

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
  if (scriptsPage) {
    scriptsPage.destroy();
    scriptsPage = null;
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
    const stale = /not found/i.test((err as Error).message);
    if (stale) {
      // The page is newer than the server process (e.g. an MCP server started before an update).
      page = 'sprites';
      root.replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'stale-server',
          innerHTML: `<h2>The Spritifer server needs a restart</h2><p>The server running on this port is an older version that doesn't know about games (objects, scenes, variables). The editor pages are new, but nothing can be loaded or saved.</p><p>Stop the old process and start it again: <code>npm start</code>, or restart Claude Code if it started the server through MCP.</p><p><a href="#/">← Back to sprites</a></p>`,
        }),
      );
      return;
    }
    toast(`Could not load the game project: ${(err as Error).message}`, 'error');
  }

  if (hash === '#/projects') {
    page = 'projects';
    document.title = 'Projects · Spritifer';
    refreshPage = renderProjects(root);
    return;
  }
  if ((m = /^#\/dialogues(?:\/(.+))?$/.exec(hash))) {
    page = 'dialogues';
    document.title = 'Dialogues · Spritifer';
    scriptsPage = renderDialogues(root, m[1] ? decodeURIComponent(m[1]) : null, (name) => go(name ? `#/dialogues/${encodeURIComponent(name)}` : '#/dialogues'));
    refreshPage = scriptsPage.refresh;
    return;
  }
  if ((m = /^#\/scripts(?:\/(.+))?$/.exec(hash))) {
    page = 'scripts';
    document.title = 'Scripts · Spritifer';
    scriptsPage = renderScripts(root, m[1] ? decodeURIComponent(m[1]) : null, (name) => go(name ? `#/scripts/${encodeURIComponent(name)}` : '#/scripts'));
    refreshPage = scriptsPage.refresh;
    return;
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
  const kind = e.type.replace('-changed', '') as 'sprite' | 'scene' | 'game' | 'script' | 'dialogue';
  const fromSelf = e.updatedBy === 'editor';
  // Changes to other projects (e.g. Claude working elsewhere) only show a note.
  const mine = currentProjectId();
  if (e.project && mine && e.project !== mine) {
    if (page === 'projects') refreshSoon();
    if (e.updatedBy === 'claude') toast(`Claude is editing project "${e.project}"`, 'claude');
    return;
  }
  if (kind === 'dialogue') {
    await state.remote('dialogue', e.rev);
    if (page === 'dialogues') refreshSoon();
    return;
  }
  if (kind === 'script') {
    await state.remote('script', e.rev);
    if (page === 'scripts') refreshSoon();
    return;
  }
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
