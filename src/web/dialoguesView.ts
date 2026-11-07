/** Dialogues page: write conversations as plain text (speakers, choices, conditions...) and try them out. */

import { DIALOGUE_REFERENCE, buildDialogueBook, parseDialogues } from '../core/game/dialogue.js';
import { World, emptyInput } from '../core/game/engine.js';
import { createScene, normalizeObject, type Value } from '../core/game/types.js';
import { createCodeEditor, type CodeEditor } from './codeEditor.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { registerFlusher } from './play.js';
import { clear, confirmDialog, h, icon, modal, promptText, toast } from './dom.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Line-based highlighter for the dialogue format. */
export function highlightDialogue(code: string): string {
  const inline = (t: string) => esc(t).replace(/\{([^}]*)\}/g, '<span class="tk-a">{$1}</span>');
  return (
    code
      .split('\n')
      .map((line) => {
        const m = /^(\s*)(.*)$/.exec(line)!;
        const [, ws, t] = m;
        if (!t) return line;
        if (t.startsWith('#') || t.startsWith('//')) return `${ws}<span class="tk-c">${esc(t)}</span>`;
        if (t.startsWith('===')) return `${ws}<span class="tk-h">${esc(t)}</span>`;
        if (t.startsWith('->')) return `${ws}<span class="tk-k">${esc(t)}</span>`;
        if (t.startsWith('~')) return `${ws}<span class="tk-n">~</span>${esc(t.slice(1))}`;
        if (t.startsWith('!')) return `${ws}<span class="tk-a">${esc(t)}</span>`;
        if (t.startsWith('*')) {
          const c = /^(\*)(.*?)(\[if [^\]]*\])?\s*$/.exec(t)!;
          return `${ws}<span class="tk-k">*</span>${inline(c[2])}${c[3] ? `<span class="tk-a">${esc(c[3])}</span>` : ''}`;
        }
        const kw = /^(if|elif|else)\b(.*)$/.exec(t);
        if (kw) return `${ws}<span class="tk-k">${kw[1]}</span>${esc(kw[2])}`;
        const sp = /^([^:{}"'*~!#=-][^:{}"']{0,39}):(\s+.*)$/.exec(t);
        if (sp) return `${ws}<span class="tk-s">${esc(sp[1])}:</span>${inline(sp[2])}`;
        return `${ws}<span class="tk-narr">${inline(t)}</span>`;
      })
      .join('\n') + '\n'
  );
}

export function renderDialogues(root: HTMLElement, selected: string | null, go: (name: string | null) => void): { refresh: () => void; destroy: () => void } {
  clear(root);
  const list = h('div', { class: 'obj-list' });
  const main = h('section', { class: 'script-main' });
  root.append(h('div', { class: 'page script-page' }, appNav('dialogues'), h('div', { class: 'obj-layout script-layout' }, h('aside', { class: 'obj-side' }, list), main)));
  let editor: CodeEditor | null = null;
  const unregister = registerFlusher(async () => editor?.flush());

  const renderList = async () => {
    let files: string[] = [];
    try {
      files = (await gameApi.listDialogues()).map((d) => d.name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    clear(list);
    list.append(h('div', { class: 'side-title' }, `Dialogue files (${files.length})`));
    for (const f of files) list.append(h('a', { class: `obj-item script-item${f === selected ? ' active' : ''}`, href: `#/dialogues/${encodeURIComponent(f)}` }, `${f}.dialogue`));
    list.append(h('button', { class: 'tpl-btn', onclick: async () => {
      const n = await promptText('New dialogue file', 'File name (e.g. village, quests, shop)', files.length ? '' : 'village');
      if (!n) return;
      try {
        await gameApi.createDialogue(n);
        go(n);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    } }, icon('plus', 13), h('span', {}, 'New dialogue file'), h('span', { class: 'muted small' }, 'A file can hold many dialogues')));
    const info = state.dialogueInfo;
    list.append(h('div', { class: 'side-title' }, `Dialogues (${info.nodes.length})`), h('div', { class: 'reg-box node-list' }, ...info.nodes.map((n) => h('code', { class: 'small' }, n))));
    if (info.errors.length) list.append(h('div', { class: 'reg-box' }, ...info.errors.map((e) => h('div', { class: 'small problem' }, `${e.file}:${e.line} ${e.message}`))));
  };

  const renderEditor = async () => {
    clear(main);
    if (!selected) {
      main.append(h('div', { class: 'empty big' },
        h('h2', {}, 'Dialogues'),
        h('p', { class: 'muted' }, 'Write conversations like a screenplay: who speaks, what they say, the choices the player can make, and what happens after each one. No code needed.'),
        h('p', { class: 'muted' }, 'Make an NPC object type with the behavior “Talks (dialogue)”, place it as many times as you like, and give every placed character its own name, look and dialogue in the scene inspector.'),
        h('pre', { class: 'dialogue-sample' }, `=== baker\nself: Fresh bread! Only 5 gold.\n* Buy bread [if gold >= 5]\n  ~ gold -= 5\n  ! sound coin\n  self: Enjoy!\n* No thanks\n  self: Come back later.`),
      ));
      return;
    }
    let code: string;
    try {
      code = (await gameApi.getDialogue(selected)).code;
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const file = selected;
    const nodesBox = h('div', { class: 'node-chips' });
    const ed = createCodeEditor({
      value: code,
      highlight: highlightDialogue,
      check: (src) => {
        const r = parseDialogues(src, file);
        return r.errors.length ? r.errors.slice(0, 4).map((e) => `Line ${e.line}: ${e.message}`).join('\n') : null;
      },
      onChange: () => renderNodes(),
      save: async (src) => {
        await gameApi.saveDialogue(file, src);
        state.dialogueInfo = await gameApi.dialogueInfo();
        void renderList();
      },
    });
    editor = ed;
    const renderNodes = () => {
      clear(nodesBox);
      for (const n of parseDialogues(ed.value(), file).nodes) {
        nodesBox.append(h('span', { class: 'node-chip' },
          h('button', { class: 'ghost small', title: `Go to line ${n.line}`, onclick: () => ed.gotoLine(n.line) }, n.name),
          h('button', { class: 'icon-btn tiny', title: `Try "${n.name}"`, onclick: () => void tryDialogue(n.name, file, ed.value()) }, icon('play', 11)),
        ));
      }
    };
    renderNodes();
    const reference = h('pre', { class: 'script-ref' }, DIALOGUE_REFERENCE);
    main.append(
      h('header', { class: 'obj-head script-head' },
        h('h2', {}, `${file}.dialogue`),
        ed.status,
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: async () => {
          const to = await promptText('Rename file', 'New name', file);
          if (!to || to === file) return;
          await ed.flush();
          try { await gameApi.renameDialogue(file, to); go(to); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('pencil', 13), 'Rename'),
        h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Delete dialogue file', `Delete dialogues/${file}.dialogue?`))) return;
          try { await gameApi.deleteDialogue(file); go(null); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('trash', 13), 'Delete'),
      ),
      h('div', { class: 'node-bar' }, h('span', { class: 'muted small' }, 'Dialogues in this file:'), nodesBox),
      ed.errorBox,
      h('div', { class: 'script-body' }, ed.el, h('details', { class: 'script-ref-box', open: true }, h('summary', {}, 'How to write dialogues'), reference)),
    );
    ed.textarea.focus();
  };

  void renderList();
  void renderEditor();
  return {
    refresh: () => void renderList(),
    destroy: () => {
      void editor?.flush().catch(() => {});
      unregister();
    },
  };
}

/**
 * Plays a dialogue in a chat-like window, with the game's starting variables, so it can be tested
 * without running the game. Choices are buttons; variables changes are listed at the end.
 */
export async function tryDialogue(name: string, file: string, currentText: string): Promise<void> {
  const g = state.game;
  if (!g) return;
  let files: Record<string, string> = {};
  try {
    const list = await gameApi.listDialogues();
    files = Object.fromEntries(await Promise.all(list.map(async (d) => [d.name, d.name === file ? currentText : (await gameApi.getDialogue(d.name)).code])));
  } catch {
    files = { [file]: currentText };
  }
  files[file] = currentText;
  const book = buildDialogueBook(files);
  if (!book.nodes.has(name)) return toast(`No dialogue "${name}"`, 'error');

  await modal(`Try “${name}”`, (close) => {
    const speakerIn = h('input', { type: 'text', value: 'NPC', class: 'small-in' });
    const log = h('div', { class: 'chat-log' });
    const controls = h('div', { class: 'chat-controls' });
    const varsBox = h('div', { class: 'chat-vars small muted' });
    let timer = 0;
    let world: World | null = null;

    const start = () => {
      clearInterval(timer);
      clear(log);
      clear(controls);
      clear(varsBox);
      const preview = createScene({ name: '__preview', cols: 4, rows: 4 });
      preview.instances.push({ id: 'npc', object: '__npc', name: speakerIn.value || 'NPC', x: 8, y: 8 });
      const bundle = {
        game: { ...g, startScene: '__preview', objects: [...g.objects, normalizeObject({ name: '__npc', text: '' })] },
        // Empty stand-ins for the real scenes, so "! goto" just ends the conversation.
        scenes: { __preview: preview, ...Object.fromEntries(state.scenes.map((sc) => [sc.name, createScene({ name: sc.name, cols: 4, rows: 4 })])) },
        sprites: {},
        scripts: {},
        dialogues: files,
      };
      const w = new World(bundle, { seed: Date.now() & 0xffff });
      world = w;
      const initial: Record<string, Value> = { ...w.globals };
      w.step();
      const npc = w.actors.find((a) => a.sceneId === 'npc');
      let done = false;
      let lastDialog: unknown = null;
      void w.startDialogue(name, npc).then(() => (done = true));
      const press = async () => {
        w.step({ ...emptyInput(), pressed: new Set(['action']), down: new Set(['action']) });
        await w.settle();
      };
      const tick = async () => {
        w.step();
        await w.settle();
        const d = w.scripts.dialog;
        if (d && d !== lastDialog) {
          lastDialog = d;
          d.shown = d.text.length;
          if (d.text) log.append(h('div', { class: `chat-line${d.speaker ? '' : ' narr'}` }, d.speaker ? h('b', {}, d.speaker) : null, d.text));
          clear(controls);
          if (d.choices) {
            d.choices.forEach((c, i) => controls.append(h('button', { class: 'chat-choice', onclick: async () => {
              log.append(h('div', { class: 'chat-line me' }, `→ ${c}`));
              d.selected = i;
              clear(controls);
              await press();
            } }, c)));
          } else controls.append(h('button', { class: 'primary small', onclick: async () => { clear(controls); await press(); } }, 'Next ▸'));
          log.scrollTop = log.scrollHeight;
        }
        if (done && !w.scripts.dialog) {
          clearInterval(timer);
          log.append(h('div', { class: 'chat-end muted small' }, '— end —'));
          const changes = Object.keys(w.globals).filter((k) => w.globals[k] !== initial[k]).map((k) => `${k}: ${JSON.stringify(initial[k])} → ${JSON.stringify(w.globals[k])}`);
          const own = npc ? Object.entries(npc.vars).filter(([k]) => !k.startsWith('__')).map(([k, v]) => `self.${k} = ${JSON.stringify(v)}`) : [];
          const errs = w.logs.filter((l) => l.includes('ERROR'));
          clear(controls);
          varsBox.append(
            h('div', {}, changes.length || own.length ? `Changed: ${[...changes, ...own].join(', ')}` : 'No variables changed.'),
            ...errs.map((e) => h('div', { class: 'problem' }, e)),
          );
          controls.append(h('button', { class: 'small', onclick: start }, 'Play again'));
        }
      };
      timer = window.setInterval(() => void tick(), 40);
    };

    const wrap = h('div', { class: 'chat' },
      h('div', { class: 'chat-head' }, h('label', { class: 'inline small' }, 'Name of “self”', speakerIn), h('button', { class: 'small', onclick: start }, 'Restart'),
        h('span', { class: 'muted small' }, 'Uses the game’s starting variables. Sounds, goto and other commands have no effect here.')),
      log,
      controls,
      varsBox,
    );
    const obs = new MutationObserver(() => {
      if (!document.body.contains(wrap)) {
        clearInterval(timer);
        world = null;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true });
    void close;
    void world;
    setTimeout(start);
    return wrap;
  }, { wide: true });
}
