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
import { pushScriptsToPlay } from './play.js';
import { renderDialogues } from './dialoguesView.js';
import { renderData } from './dataView.js';
import { renderVfx } from './vfxView.js';
import { renderGit } from './gitView.js';
import { currentProjectId } from './api.js';
import { renderWorld } from './worldView.js';
import { renderTests } from './testsView.js';
import { renderHistory } from './historyView.js';
import { setPageContext } from './editorContext.js';

const root = document.getElementById('app')!;

let live = false;
let current: { editor: Editor; view: ReturnType<typeof mountEditor> } | null = null;
let sceneEd: SceneEditorHandle | null = null;
/** Re-renders the current list page after remote changes. */
let refreshPage: (() => void) | null = null;
let page: 'sprites' | 'objects' | 'scenes' | 'world' | 'scripts' | 'dialogues' | 'data' | 'vfx' | 'tests' | 'game' | 'history' | 'git' | 'sprite' | 'scene' | 'projects' = 'sprites';
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
    setPageContext('sprite', { sprite: name });
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

  if (hash === '#/world') {
    page = 'world';
    document.title = 'World · Spritifer';
    setPageContext('world');
    refreshPage = renderWorld(root);
    return;
  }
  if (hash === '#/tests') {
    page = 'tests';
    document.title = 'Tests · Spritifer';
    setPageContext('tests');
    refreshPage = renderTests(root);
    return;
  }
  if (hash === '#/history') {
    page = 'history';
    document.title = 'History · Spritifer';
    setPageContext('history');
    refreshPage = renderHistory(root);
    return;
  }
  if (hash === '#/git') {
    page = 'git';
    document.title = 'Git · Spritifer';
    setPageContext('git');
    refreshPage = renderGit(root);
    return;
  }
  if (hash === '#/projects') {
    page = 'projects';
    document.title = 'Projects · Spritifer';
    setPageContext('projects');
    refreshPage = renderProjects(root);
    return;
  }
  if ((m = /^#\/dialogues(?:\/(.+))?$/.exec(hash))) {
    page = 'dialogues';
    document.title = 'Dialogues · Spritifer';
    setPageContext('dialogues', m[1] ? { dialogue: decodeURIComponent(m[1]) } : {});
    scriptsPage = renderDialogues(root, m[1] ? decodeURIComponent(m[1]) : null, (name) => go(name ? `#/dialogues/${encodeURIComponent(name)}` : '#/dialogues'));
    refreshPage = scriptsPage.refresh;
    return;
  }
  if ((m = /^#\/data(?:\/(.+))?$/.exec(hash))) {
    page = 'data';
    document.title = 'Data · Spritifer';
    setPageContext('data', m[1] ? { table: decodeURIComponent(m[1]) } : {});
    scriptsPage = renderData(root, m[1] ? decodeURIComponent(m[1]) : null, (name) => go(name ? `#/data/${encodeURIComponent(name)}` : '#/data'));
    refreshPage = scriptsPage.refresh;
    return;
  }
  if ((m = /^#\/vfx(?:\/(.+))?$/.exec(hash))) {
    page = 'vfx';
    document.title = 'VFX · Spritifer';
    setPageContext('vfx', m[1] ? { effect: decodeURIComponent(m[1]) } : {});
    scriptsPage = renderVfx(root, m[1] ? decodeURIComponent(m[1]) : null, (name) => go(name ? `#/vfx/${encodeURIComponent(name)}` : '#/vfx'));
    refreshPage = scriptsPage.refresh;
    return;
  }
  if ((m = /^#\/scripts(?:\/(.+))?$/.exec(hash))) {
    page = 'scripts';
    document.title = 'Scripts · Spritifer';
    // "#/scripts/<path>:<line>" opens the script at a line (links in errors).
    const target = m[1] ? /^(.*?)(?::(\d+))?$/.exec(decodeURIComponent(m[1]))! : null;
    setPageContext('scripts', target ? { script: target[1] } : {});
    scriptsPage = renderScripts(root, target ? target[1] : null, (name) => go(name ? `#/scripts/${encodeURIComponent(name)}` : '#/scripts'), target?.[2] ? Number(target[2]) : undefined);
    refreshPage = scriptsPage.refresh;
    return;
  }
  if ((m = /^#\/scene\/([^~]+)(?:~(.+))?$/.exec(hash))) {
    page = 'scene';
    setPageContext('scene', { scene: decodeURIComponent(m[1]) });
    try {
      sceneEd = await mountSceneEditor(root, decodeURIComponent(m[1]), () => go('#/scenes'), m[2] ? decodeURIComponent(m[2]) : undefined);
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
    setPageContext('objects', sel ? { object: sel } : {});
    refreshPage = renderObjects(root, sel, (name) => go(name ? `#/objects/${encodeURIComponent(name)}` : '#/objects'));
    return;
  }
  if (hash === '#/scenes') {
    page = 'scenes';
    document.title = 'Scenes · Spritifer';
    setPageContext('scenes');
    refreshPage = renderScenes(root, (name) => go(`#/scene/${encodeURIComponent(name)}`));
    return;
  }
  if (hash === '#/game') {
    page = 'game';
    document.title = 'Game · Spritifer';
    setPageContext('game');
    refreshPage = renderGameSettings(root);
    return;
  }
  page = 'sprites';
  document.title = 'Spritifer';
  setPageContext('sprites');
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
  const kind = e.type.replace('-changed', '') as 'sprite' | 'scene' | 'game' | 'script' | 'dialogue' | 'data' | 'vfx' | 'notes' | 'test';
  const fromSelf = e.updatedBy === 'editor';
  // Changes to other projects (e.g. Claude working elsewhere) only show a note.
  const mine = currentProjectId();
  if (e.project && mine && e.project !== mine) {
    if (page === 'projects') refreshSoon();
    if (e.updatedBy === 'claude') toast(`Claude is editing project "${e.project}"`, 'claude');
    return;
  }
  if (page === 'git') refreshSoon();
  if (kind === 'notes') {
    sceneEd?.notesChanged();
    return;
  }
  if (kind === 'test') {
    if (page === 'tests') refreshSoon();
    return;
  }
  if (page === 'history' && kind !== 'sprite') refreshSoon();
  if (page === 'world' && (kind === 'scene' || kind === 'game') && !fromSelf) refreshSoon();
  if (kind === 'data') {
    await state.remote('data', e.rev);
    if (page === 'data' && !fromSelf) refreshSoon();
    if (e.updatedBy === 'claude') toast(`Data table "${e.name}" updated by Claude`, 'claude');
    return;
  }
  if (kind === 'vfx') {
    await state.remote('vfx', e.rev);
    if (page === 'vfx' && !fromSelf) refreshSoon();
    if (e.updatedBy === 'claude') toast(`Effect "${e.name}" updated by Claude`, 'claude');
    return;
  }
  if (kind === 'dialogue') {
    await state.remote('dialogue', e.rev);
    if (page === 'dialogues') refreshSoon();
    return;
  }
  if (kind === 'script') {
    void pushScriptsToPlay();
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
