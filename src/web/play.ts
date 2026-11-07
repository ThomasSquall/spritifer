/** Play overlay (the real exported game in an iframe, with a log console) and the export dialog. */

import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { h, icon, iconButton, linkScriptRefs, modal, toast } from './dom.js';

const flushers = new Set<() => Promise<void>>();

/** Editors register a function that saves pending changes before the game is played or exported. */
export function registerFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

async function flushAll(): Promise<void> {
  await state.flush();
  await Promise.all([...flushers].map((f) => f().catch(() => {})));
}

let open = false;
/** The game iframe while the Play overlay is open (for hot reload). */
let playFrame: HTMLIFrameElement | null = null;
let hotReload = true;

/** Sends the current scripts to the running game, which swaps the code in place (components keep their state). */
export async function pushScriptsToPlay(): Promise<void> {
  const frame = playFrame;
  if (!frame?.contentWindow || !hotReload) return;
  try {
    const scripts = await gameApi.scriptSources();
    frame.contentWindow.postMessage({ source: 'spritifer-editor', type: 'scripts', scripts }, '*');
  } catch {
    // The next Restart picks the scripts up anyway.
  }
}

export async function openPlay(scene?: string): Promise<void> {
  if (open) return;
  await flushAll();
  const scenes = await gameApi.listScenes();
  if (!scenes.length) {
    toast('Create a scene first (Scenes tab)', 'error');
    return;
  }
  open = true;
  let debug = false;
  const logs = h('div', { class: 'play-logs' });
  const frame = h('iframe', { class: 'play-frame', src: gameApi.playUrl(scene), allow: 'autoplay; fullscreen; gamepad', title: 'Game' });
  const errCount = h('span', { class: 'play-errcount' });
  let errors = 0;
  const addLog = (msg: string) => {
    const isErr = msg.startsWith('ERROR');
    if (isErr) {
      errors++;
      errCount.textContent = `${errors} error${errors === 1 ? '' : 's'}`;
    }
    logs.append(h('div', { class: isErr ? 'err' : '' }, ...linkScriptRefs(msg, () => close())));
    while (logs.childElementCount > 300) logs.firstElementChild?.remove();
    logs.scrollTop = logs.scrollHeight;
  };
  const onMsg = (e: MessageEvent) => {
    const d = e.data as { source?: string; type?: string; message?: string };
    if (e.source !== frame.contentWindow || d?.source !== 'spritifer-game') return;
    if (d.type === 'log' && d.message) addLog(d.message);
    if (d.type === 'ready') frame.focus();
  };
  window.addEventListener('message', onMsg);
  const reload = () => {
    logs.textContent = '';
    errors = 0;
    errCount.textContent = '';
    frame.src = gameApi.playUrl(scene, debug);
  };
  const close = () => {
    playFrame = null;
    window.removeEventListener('message', onMsg);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    open = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const hotBtn = h('button', { class: `small${hotReload ? ' on' : ''}`, title: 'Apply script changes to the running game without restarting (components keep their state)', onclick: () => { hotReload = !hotReload; hotBtn.classList.toggle('on', hotReload); } }, 'Hot reload');
  const hitBtn = h('button', { class: 'small', title: 'Show collision boxes (F2 in game)', onclick: () => { debug = !debug; hitBtn.classList.toggle('on', debug); reload(); } }, 'Hitboxes');
  const overlay = h('div', { class: 'play-overlay' },
    h('header', { class: 'play-head' },
      h('span', { class: 'play-title' }, icon('play', 14), ` ${state.game?.title ?? 'Game'}`, scene ? h('span', { class: 'muted' }, ` · ${scene}`) : null),
      h('span', { class: 'muted small' }, 'Arrows/WASD move · Space/Z jump & action · X action 2 · Esc closes'),
      h('span', { class: 'spacer' }),
      errCount,
      hotBtn,
      hitBtn,
      h('button', { class: 'small', onclick: reload }, 'Restart'),
      h('button', { class: 'small', onclick: () => window.open(gameApi.playUrl(scene), '_blank') }, 'New tab'),
      iconButton('close', 'Close (Esc)', close),
    ),
    h('div', { class: 'play-body' }, frame, logs),
  );
  document.body.append(overlay);
  playFrame = frame;
  frame.addEventListener('load', () => frame.focus());
}

export async function openExport(): Promise<void> {
  await flushAll();
  let result: Awaited<ReturnType<typeof gameApi.exportGame>>;
  try {
    result = await gameApi.exportGame();
  } catch (err) {
    toast((err as Error).message, 'error');
    return;
  }
  await modal('Exported for the web', () =>
    h('div', { class: 'form' },
      h('p', {}, `A single HTML file with everything inside (${(result.bytes / 1024).toFixed(0)} KB, ${result.scenes} scene${result.scenes === 1 ? '' : 's'}, ${result.sprites} sprite${result.sprites === 1 ? '' : 's'}). It runs offline in any browser, on any static host, and can be uploaded to itch.io as an HTML5 game.`),
      h('code', { class: 'path' }, result.file),
      result.problems.length
        ? h('div', { class: 'problems' }, h('strong', {}, `${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}:`), ...result.problems.slice(0, 12).map((p) => h('div', { class: 'small' }, `${p.where}: ${p.message}`)))
        : null,
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: gameApi.downloadUrl(), download: '' }, icon('export', 16), 'Download HTML'),
        h('button', { class: 'primary', onclick: () => void openPlay() }, icon('play', 14), 'Play'),
      ),
    ),
  );
}
