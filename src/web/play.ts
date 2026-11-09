/** Play overlay (the real exported game in an iframe, with a log console) and the export dialog. */

import { gameApi } from './gameApi.js';
import { createPlayInspector } from './playInspector.js';
import type { Recording } from '../runtime/player.js';
import { normalizeTest } from '../core/game/gameTests.js';
import { reportPlayLog, resetPlayLog, updateContext } from './editorContext.js';
import { state } from './gameState.js';
import { clear, h, icon, iconButton, linkScriptRefs, modal, toast } from './dom.js';

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
  updateContext({ playing: on ? true : undefined });
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

/** Saves what was just played as a test, after asking what must be true at the end. */
async function saveRecording(r: Recording, scene: string | undefined): Promise<void> {
  const taken = new Set((await gameApi.listTests().catch(() => [])).map((t) => t.name));
  let suggested = 'playthrough';
  for (let i = 2; taken.has(suggested); i++) suggested = `playthrough_${i}`;
  await modal('Save this run as a test', (close) => {
    const name = h('input', { type: 'text', value: suggested, spellcheck: false });
    const description = h('input', { type: 'text', placeholder: 'What this run covers (optional)' });
    const endScene = h('input', { type: 'text', value: r.finalScene, spellcheck: false });
    const lines = Object.entries(r.changed).map(([k, v]) => `${k} == ${JSON.stringify(v)}`);
    const exprs = h('textarea', { rows: Math.min(10, Math.max(3, lines.length)), spellcheck: false, value: lines.join('\n') });
    const save = async () => {
      try {
        await gameApi.saveTest(normalizeTest({ name: name.value.trim(), description: description.value.trim(), scene, seed: r.seed, seconds: r.seconds, inputs: r.inputs, autoDialog: false, expect: { scene: endScene.value.trim(), exprs: exprs.value.split('\n'), noErrors: true } }, name.value.trim()));
        toast(`Test saved: ${name.value.trim()}`);
        close();
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    };
    return h('div', { class: 'form' },
      h('p', { class: 'muted small' }, `${r.seconds.toFixed(1)} seconds, ${r.inputs.length} inputs. Keep the lines that matter and remove the rest.`),
      h('label', {}, 'Name', name),
      h('label', {}, 'Description', description),
      h('label', {}, 'Ends in scene', endScene),
      h('label', {}, 'True at the end (one expression per line)', exprs),
      h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { onclick: close }, 'Discard'), h('button', { class: 'primary', onclick: () => void save() }, 'Save test')));
  });
}

export async function openPlay(scene?: string, opts: { record?: boolean } = {}): Promise<void> {
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
    reportPlayLog(msg);
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
    if (d.type === 'ready') {
      frame.focus();
      if (wantRecord) {
        wantRecord = false;
        toggleRecord();
      }
    }
    if (d.type === 'recording' && d.data) {
      close();
      void saveRecording(d.data as Recording, scene);
    }
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
  let wantRecord = !!opts.record;
  let recording = false;
  const toggleRecord = () => {
    recording = !recording;
    recBtn.classList.toggle('rec', recording);
    recBtn.textContent = recording ? 'Stop and save' : 'Record';
    if (recording) {
      logs.textContent = '';
      errors = 0;
      errCount.textContent = '';
      resetPlayLog();
    }
    sendToGame({ type: 'record', on: recording });
    frame.focus();
  };
  const reload = () => {
    resetPlayLog();
    recording = false;
    recBtn.classList.remove('rec');
    recBtn.textContent = 'Record';
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
  const recBtn = h('button', { class: 'small', title: 'Restart the game and record what you press, to save it as a test', onclick: () => toggleRecord() }, 'Record');
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
      recBtn,
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
  resetPlayLog();
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

/** Builds the APK; the dialog stays open on "building" because it can take a while with big games. */
export async function openAndroidExport(): Promise<void> {
  await flushAll();
  await modal('Export for Android', (close) => {
    const body = h('div', { class: 'form' }, h('p', {}, 'Building the Android app…'));
    gameApi.exportAndroid().then((r) => {
      clear(body);
      body.append(
        h('p', {}, `An APK that installs on Android 7 or newer and plays offline (${(r.bytes / 1048576).toFixed(1)} MB, ${r.scenes} scene${r.scenes === 1 ? '' : 's'}, ${r.sprites} sprite${r.sprites === 1 ? '' : 's'}). Package ${r.package}, version ${r.version}.`),
        h('code', { class: 'path' }, r.file),
        h('p', { class: 'muted small' }, 'Keep a copy of the signing key: updates to the app need the same one.'),
        h('code', { class: 'path' }, r.keystore),
        ...r.warnings.map((w) => h('p', { class: 'small' }, w)),
        ...(r.problems.length
          ? [h('div', { class: 'problems' }, h('strong', {}, `${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}:`), ...r.problems.slice(0, 12).map((p) => h('div', { class: 'small' }, `${p.where}: ${p.message}`)))]
          : []),
        h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: gameApi.apkUrl(), download: '' }, icon('export', 16), 'Download APK')),
      );
    }).catch((err: Error) => {
      close();
      toast(err.message, 'error');
    });
    return body;
  });
}

export async function openExportMenu(): Promise<void> {
  await modal('Export', (close) =>
    h('div', { class: 'form' },
      h('p', {}, 'Where will the game run?'),
      h('div', { class: 'actions' },
        h('button', { onclick: () => { close(); void openExport(); } }, icon('export', 16), 'Export for web'),
        h('button', { class: 'primary', onclick: () => { close(); void openAndroidExport(); } }, icon('export', 16), 'Export for Android'),
      ),
    ),
  );
}
