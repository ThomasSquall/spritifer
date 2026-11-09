/** Tells the server what the person is looking at, so Claude can read it (MCP get_editor_context). */

import { gameApi } from './gameApi.js';

let current: Record<string, unknown> = { page: 'sprites' };
let timer = 0;

const send = () => {
  timer = 0;
  gameApi.postContext(current).catch(() => {});
};

const later = () => {
  if (!timer) timer = window.setTimeout(send, 300);
};

/** A new page: forgets what the previous one reported, except whether Play is open. */
export function setPageContext(page: string, details: Record<string, unknown> = {}): void {
  current = { page, ...(current.playing ? { playing: true } : {}), ...details };
  later();
}

/** More about the current page: selection, tool, pointer. Undefined removes a field. */
export function updateContext(details: Record<string, unknown>): void {
  current = { ...current, ...details };
  for (const k of Object.keys(current)) if (current[k] === undefined) delete current[k];
  later();
}

let lines: string[] = [];
let reset = false;
let logTimer = 0;

const sendLog = () => {
  logTimer = 0;
  const body = { lines, reset };
  lines = [];
  reset = false;
  gameApi.postPlayLog(body).catch(() => {});
};

/** The log of the running game, in small batches. */
export function reportPlayLog(message: string): void {
  lines.push(message);
  if (!logTimer) logTimer = window.setTimeout(sendLog, 1000);
}

/** A new run of the game starts with an empty log. */
export function resetPlayLog(): void {
  lines = [];
  reset = true;
  if (!logTimer) logTimer = window.setTimeout(sendLog, 200);
}
