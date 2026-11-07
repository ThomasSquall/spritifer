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
  mountPlayer(el, bundle, {
    scene: params.get('scene') ?? undefined,
    debug: params.has('debug'),
    onLog: (m) => {
      post('log', m);
      if (m.startsWith('ERROR')) console.warn('[game]', m);
    },
  })
    .then(() => post('ready', bundle.game.title))
    .catch((err: unknown) => post('log', `ERROR ${(err as Error).message}`));
}
