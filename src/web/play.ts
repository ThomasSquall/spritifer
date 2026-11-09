/** Play overlay (the real exported game in an iframe, with a log console) and the export dialog. */

import { gameApi } from './gameApi.js';
import { createPlayInspector } from './playInspector.js';
import { state } from './gameState.js';
import { h, icon, iconButton, linkScriptRefs, modal, toast } from './dom.js';

const flushers = new Set<() => Promise<void>>();

/** Editors register a function that saves pending changes before the game is played or exported. */
export function registerFlusher(fn: () => Promise<void>): () => void {
  flushers.add(fn);
  return () => flushers.delete(fn);
}

export async function flushAll(): Promise<void> {
  await state.flush();
  await Promise.all([...flushers].map((f) => f().catch(() => {})));
}

let open = false;
const playWatchers = new Set<() => void>();

/** Is the Play overlay open? Views keep their animated previews still meanwhile: they share the browser's thread with the game. */
export const isPlaying = (): boolean => open;

/** Called when the Play overlay opens or closes. Returns the function that stops listening. */
export function onPlayChange(fn: () => void): () => void {
  playWatchers.add(fn);
  return () => playWatchers.delete(fn);
}

function setOpen(on: boolean): void {
  open = on;
  for (const fn of playWatchers) fn();
}

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
  setOpen(true);
  let debug = false;
  const logs = h('div', { class: 'play-logs' });
  const sendToGame = (msg: Record<string, unknown>) => frame.contentWindow?.postMessage({ source: 'spritifer-editor', ...msg }, '*');
  const inspector = createPlayInspector(sendToGame);
  inspector.setVisible(false);
  const showTab = (tab: 'log' | 'inspector') => {
    logs.hidden = tab !== 'log';
    inspector.setVisible(tab === 'inspector');
    logTab.classList.toggle('active', tab === 'log');
    inspTab.classList.toggle('active', tab === 'inspector');
  };
  const logTab = h('button', { class: 'right-tab active', onclick: () => showTab('log') }, 'Log');
  const inspTab = h('button', { class: 'right-tab', title: 'Pause, step and edit the running game', onclick: () => showTab('inspector') }, 'Inspector');
  const side = h('div', { class: 'play-side' }, h('div', { class: 'right-tabs' }, logTab, inspTab), logs, inspector.el);
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
    const d = e.data as { source?: string; type?: string; message?: string; data?: unknown; on?: boolean; volume?: number };
    if (e.source === frame.contentWindow && d?.source === 'spritifer-game' && d.type === 'inspect' && d.data) inspector.update(d.data as Parameters<typeof inspector.update>[0]);
    if (e.source !== frame.contentWindow || d?.source !== 'spritifer-game') return;
    if (d.type === 'log' && d.message) addLog(d.message);
    if (d.type === 'ready') frame.focus();
    if (d.type === 'music') {
      musicOn = !!d.on;
      musicBtn.classList.toggle('on', musicOn);
    }
    if (d.type === 'musicVolume') showVolume(Number(d.volume) || 0);
    if (d.type === 'fps') {
      fpsOn = !!d.on;
      fpsBtn.classList.toggle('on', fpsOn);
    }
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
    inspector.destroy();
    window.removeEventListener('message', onMsg);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('fullscreenchange', onFullscreen);
    overlay.remove();
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent) => {
    // In full screen Esc belongs to the browser: it leaves full screen and must not also close the game.
    if (document.fullscreenElement || performance.now() - leftFullscreenAt < 300) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  const hotBtn = h('button', { class: `small${hotReload ? ' on' : ''}`, title: 'Apply script changes to the running game without restarting (components keep their state)', onclick: () => { hotReload = !hotReload; hotBtn.classList.toggle('on', hotReload); } }, 'Hot reload');
  const hitBtn = h('button', { class: 'small', title: 'Show collision boxes (F2 in game)', onclick: () => { debug = !debug; hitBtn.classList.toggle('on', debug); reload(); } }, 'Hitboxes');
  let musicOn = true;
  const musicBtn = h('button', { class: 'small on', title: 'Sound on or off while the game runs: music and effects (F3 in game); remembered for the next Play', onclick: () => { sendToGame({ type: 'music', on: !musicOn }); frame.focus(); } }, 'Sound');
  const volumeSlider = h('input', {
    type: 'range', min: '0', max: '100', value: '100', 'aria-label': 'Volume',
    oninput: () => {
      const volume = Number(volumeSlider.value) / 100;
      sendToGame({ type: 'musicVolume', volume });
      volumeSlider.title = volumeTitle(volume);
      // Moving the slider while the sound is off would otherwise seem to do nothing.
      if (!musicOn && volume > 0) sendToGame({ type: 'music', on: true });
    },
    onchange: () => frame.focus(),
  });
  const volumeTitle = (volume: number) => `Volume of music and effects: ${Math.round(volume * 100)}%; remembered for the next Play`;
  const showVolume = (volume: number) => {
    volumeSlider.value = String(Math.round(volume * 100));
    volumeSlider.title = volumeTitle(volume);
  };
  showVolume(1);
  let leftFullscreenAt = -Infinity;
  const fullscreenLabel = () => (document.fullscreenElement === overlay ? 'Exit full screen' : 'Full screen');
  const fullscreenBtn = h('button', {
    class: 'small play-keep-fullscreen', title: 'Play on the whole screen (Esc leaves full screen)',
    onclick: () => {
      const change = document.fullscreenElement === overlay ? document.exitFullscreen() : overlay.requestFullscreen();
      change.catch(() => toast('This browser refused full screen', 'error'));
    },
  }, 'Full screen');
  fullscreenBtn.hidden = !document.fullscreenEnabled;
  const onFullscreen = () => {
    if (document.fullscreenElement !== overlay) leftFullscreenAt = performance.now();
    fullscreenBtn.textContent = fullscreenLabel();
    frame.focus();
  };
  document.addEventListener('fullscreenchange', onFullscreen);
  let fpsOn = false;
  const fpsBtn = h('button', { class: 'small', title: 'Show frame rate and frame time on the game (F4 in game); remembered for the next Play', onclick: () => { sendToGame({ type: 'fps', on: !fpsOn }); frame.focus(); } }, 'FPS');
  const overlay = h('div', { class: 'play-overlay' },
    h('header', { class: 'play-head' },
      h('span', { class: 'play-title' }, icon('play', 14), ` ${state.game?.title ?? 'Game'}`, scene ? h('span', { class: 'muted' }, ` · ${scene}`) : null),
      h('span', { class: 'muted small' }, 'Arrows/WASD move · Space/Z jump & action · X action 2 · Esc closes'),
      h('span', { class: 'spacer' }),
      errCount,
      hotBtn,
      h('span', { class: 'play-volume play-keep-fullscreen' }, musicBtn, volumeSlider),
      fpsBtn,
      hitBtn,
      h('button', { class: 'small', onclick: reload }, 'Restart'),
      fullscreenBtn,
      h('button', { class: 'small', onclick: () => window.open(gameApi.playUrl(scene), '_blank') }, 'New tab'),
      iconButton('close', 'Close (Esc)', close),
    ),
    h('div', { class: 'play-body' }, frame, side),
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
