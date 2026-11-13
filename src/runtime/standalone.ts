/** Entry point of exported games: the bundle is embedded in the page as window.SPRITIFER_GAME. */

import type { GameBundle } from '../core/game/types.js';
import { mountPlayer } from './player.js';
import { markEndpoint } from './markEndpoint.js';
import { type WorldEdit, editWorld, inspectWorld } from '../core/game/debug.js';

declare global {
  interface Window {
    SPRITIFER_GAME?: GameBundle;
    /** Set by the editor's server in the game page it serves (play.html): where its tools answer. */
    SPRITIFER_DEV?: { marks?: string };
  }
  /** true in the runtime for the game page served by the editor, false in exported games (vite.runtime.config.ts). */
  const __SPRITIFER_DEV__: boolean;
}

const bundle = window.SPRITIFER_GAME;
const el = document.getElementById('game') ?? document.body;
const params = new URLSearchParams(location.search);
const inFrame = window.parent !== window;

const post = (type: string, message: string) => {
  if (inFrame) window.parent.postMessage({ source: 'spritifer-game', type, message }, '*');
};

if (!bundle) {
  el.textContent = 'No game data.';
} else {
  const playing = mountPlayer(el, bundle, {
    scene: params.get('scene') ?? undefined,
    debug: params.has('debug'),
    music: params.has('nomusic') ? false : undefined,
    hd: params.has('hd') ? params.get('hd') !== '0' : undefined,
    onHdChange: (on) => {
      if (inFrame) window.parent.postMessage({ source: 'spritifer-game', type: 'hd', on }, '*');
    },
    musicButton: !inFrame,
    onMusicChange: (on) => {
      if (inFrame) window.parent.postMessage({ source: 'spritifer-game', type: 'music', on }, '*');
    },
    onMusicVolume: (volume) => {
      if (inFrame) window.parent.postMessage({ source: 'spritifer-game', type: 'musicVolume', volume }, '*');
    },
    // The game page served by the editor; an exported game has no button, only F4.
    fpsButton: !inFrame && location.pathname.endsWith('/play.html'),
    onFpsChange: (on) => {
      if (inFrame) window.parent.postMessage({ source: 'spritifer-game', type: 'fps', on }, '*');
    },
    // "Mark here" (F8): only in the game page served by the editor's server, which stores the reports in the project.
    // An exported game has no such page, and F8 does nothing there.
    onMark: __SPRITIFER_DEV__ && markEndpoint(window.SPRITIFER_DEV, location.href)
      ? async (report, photo) => {
          const res = await fetch(markEndpoint(window.SPRITIFER_DEV, location.href)!, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ report, png: photo.toDataURL('image/png') }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const n = ((await res.json()) as { n: number }).n;
          post('log', `Marked #${n} (F8)`);
          return n;
        }
      : undefined,
    onLog: (m) => {
      post('log', m);
      if (m.startsWith('ERROR')) console.warn('[game]', m);
    },
  })
  playing.then(() => post('ready', bundle.game.title)).catch((err: unknown) => post('log', `ERROR ${(err as Error).message}`));

  // Messages from the editor's Play overlay: hot reload, and the live inspector (pause, step, inspect, edit).
  if (inFrame) {
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; scripts?: Record<string, string>; on?: boolean; volume?: number; edit?: WorldEdit };
      if (e.source !== window.parent || d?.source !== 'spritifer-editor') return;
      void playing.then((player) => {
        switch (d.type) {
          case 'scripts':
            if (!d.scripts) return;
            bundle.scripts = d.scripts;
            player.world.scripts.hotReload(d.scripts);
            return;
          case 'music':
            player.music = !!d.on;
            return;
          case 'musicVolume':
            player.musicVolume = Number(d.volume) || 0;
            return;
          case 'fps':
            player.fps = !!d.on;
            return;
          case 'hd':
            player.hd = !!d.on;
            return;
          case 'record':
            if (d.on) player.startRecording();
            else window.parent.postMessage({ source: 'spritifer-game', type: 'recording', data: player.stopRecording() }, '*');
            return;
          case 'pause':
            player.paused = !!d.on;
            break;
          case 'step':
            player.stepOnce();
            break;
          case 'edit':
            if (d.edit) editWorld(player.world, d.edit);
            break;
          case 'inspect':
            break;
          default:
            return;
        }
        // Every inspector message gets the fresh state back (after a step: on the next frame).
        const reply = () => window.parent.postMessage({ source: 'spritifer-game', type: 'inspect', data: { ...inspectWorld(player.world), paused: player.paused } }, '*');
        if (d.type === 'step') requestAnimationFrame(() => requestAnimationFrame(reply));
        else reply();
      });
    });
  }
}
