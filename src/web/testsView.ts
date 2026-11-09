/** Tests page: the saved playtests, recorded in Play or written by Claude. */

import type { GameTest, TestOutcome } from '../core/game/gameTests.js';
import { clear, confirmDialog, h, icon, toast } from './dom.js';
import { gameApi } from './gameApi.js';
import { appNav } from './nav.js';
import { flushAll, openPlay } from './play.js';

export function renderTests(root: HTMLElement): () => void {
  clear(root);
  const body = h('main', { class: 'tests-page' });
  root.append(h('div', { class: 'page' }, appNav('tests'), body));
  const results = new Map<string, TestOutcome>();
  let running: Set<string> | null = null;
  let tests: GameTest[] = [];

  const run = async (names?: string[]) => {
    await flushAll();
    running = new Set(names ?? tests.map((t) => t.name));
    paint();
    try {
      for (const o of await gameApi.runTests(names)) results.set(o.name, o);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    running = null;
    paint();
  };

  const save = async (t: GameTest) => {
    try {
      await gameApi.saveTest(t);
      toast('Saved');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const row = (t: GameTest) => {
    const r = results.get(t.name);
    const busy = running?.has(t.name);
    const status = busy ? 'running' : r ? (r.passed ? 'passed' : 'failed') : 'not run';
    const exprs = h('textarea', { class: 'test-exprs', rows: Math.max(2, (t.expect.exprs?.length ?? 0) + 1), spellcheck: false, placeholder: 'One expression per line, true at the end: gold >= 10', value: (t.expect.exprs ?? []).join('\n') });
    const scene = h('input', { type: 'text', value: t.expect.scene ?? '', placeholder: 'any', spellcheck: false });
    const noErrors = h('input', { type: 'checkbox', checked: t.expect.noErrors !== false });
    const applyExpect = () => save({ ...t, expect: { ...t.expect, scene: scene.value.trim() || undefined, exprs: exprs.value.split('\n').map((x) => x.trim()).filter(Boolean), noErrors: noErrors.checked } });
    return h('article', { class: `test-row ${status.replace(' ', '-')}` },
      h('div', { class: 'test-head' },
        h('span', { class: 'test-status' }, status),
        h('strong', {}, t.name),
        h('span', { class: 'muted small' }, `${t.seconds.toFixed(1)} s · ${t.inputs.length} inputs${t.scene ? ` · from ${t.scene}` : ''}${t.updatedBy ? ` · by ${t.updatedBy}` : ''}`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', disabled: !!running, onclick: () => void run([t.name]) }, icon('play', 12), 'Run'),
        h('button', { class: 'small danger', 'aria-label': `Delete test ${t.name}`, onclick: async () => {
          if (!(await confirmDialog('Delete this test?', `“${t.name}” will be gone from the tests folder.`))) return;
          await gameApi.deleteTest(t.name).catch((err: Error) => toast(err.message, 'error'));
          results.delete(t.name);
          void refresh();
        } }, icon('trash', 13))),
      t.description ? h('p', { class: 'muted small test-desc' }, t.description) : null,
      r && !r.passed ? h('ul', { class: 'test-failures' }, ...r.failures.map((f) => h('li', {}, f))) : null,
      r && !r.passed && r.logs.length ? h('details', {}, h('summary', { class: 'small muted' }, 'Last log lines'), h('pre', { class: 'test-log' }, r.logs.slice(-20).join('\n'))) : null,
      h('details', { class: 'test-expect' }, h('summary', { class: 'small muted' }, 'What it checks'),
        h('div', { class: 'form' },
          h('div', { class: 'row2' }, h('label', {}, 'Ends in scene', scene), h('label', { class: 'inline' }, noErrors, 'Fail on script errors')),
          h('label', {}, 'True at the end', exprs),
          h('div', { class: 'actions' }, h('button', { class: 'small', onclick: () => void applyExpect() }, 'Save checks')))),
    );
  };

  const paint = () => {
    clear(body);
    const failed = [...results.values()].filter((r) => !r.passed).length;
    body.append(h('div', { class: 'tests-bar' },
      h('h2', {}, 'Tests'),
      h('span', { class: 'muted' }, results.size ? `${results.size - failed} of ${results.size} passed` : 'Play the game with fixed input and check how it ends'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'small', title: 'Open Play, then press Record', onclick: () => void openPlay(undefined, { record: true }) }, 'Record a test'),
      h('button', { class: 'primary small', disabled: !tests.length || !!running, onclick: () => void run() }, icon('play', 12), running ? 'Running…' : 'Run all')));
    if (!tests.length) body.append(h('div', { class: 'empty big' }, h('h2', {}, 'No tests yet'), h('p', {}, 'Record a test: play a stretch of the game, then say what must be true when it ends. Run it again after every change.')));
    for (const t of tests) body.append(row(t));
  };

  async function refresh(): Promise<void> {
    try {
      tests = await gameApi.listTests();
      paint();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  void refresh();
  return () => void refresh();
}
