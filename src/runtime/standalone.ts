/** Entry point of exported games: the bundle is embedded in the page as window.SPRITIFER_GAME. */

import type { GameBundle } from '../core/game/types.js';
import { mountPlayer } from './player.js';

declare global {
  interface Window {
    SPRITIFER_GAME?: GameBundle;
  }
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
    onLog: (m) => {
      post('log', m);
      if (m.startsWith('ERROR')) console.warn('[game]', m);
    },
  })
  playing.then(() => post('ready', bundle.game.title)).catch((err: unknown) => post('log', `ERROR ${(err as Error).message}`));

  // Hot reload from the editor (Play overlay): new script sources replace the running code, state stays.
  if (inFrame) {
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; scripts?: Record<string, string> };
      if (e.source !== window.parent || d?.source !== 'spritifer-editor' || d.type !== 'scripts' || !d.scripts) return;
      void playing.then((player) => {
        bundle.scripts = d.scripts;
        player.world.scripts.hotReload(d.scripts!);
      });
    });
  }
}
