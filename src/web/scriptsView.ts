/** Scripts page: write the project's JavaScript game scripts with a small code editor and the API reference. */

import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openPlay, registerFlusher } from './play.js';
import { clear, confirmDialog, h, icon, promptText, toast } from './dom.js';

const KEYWORDS = /\b(async|await|break|case|catch|class|const|continue|default|delete|do|else|false|finally|for|function|if|in|instanceof|let|new|null|of|return|switch|this|throw|true|try|typeof|undefined|var|void|while)\b/;
const API = /\b(behavior|func|onStart|onSceneStart|onUpdate|onDraw|onMessage|say|choose|wait|waitUntil|vars|scene|game|camera|find|findOne|player|spawn|goto|restart|sound|shake|emit|lockControls|log|key|pressed|random|randint|pick|save|load|ui)\b/;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tiny JavaScript highlighter (comments, strings, numbers, keywords, Spritifer API). */
export function highlight(code: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += esc(code.slice(last, m.index));
    const [t] = m;
    if (m[1]) out += `<span class="tk-c">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="tk-s">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="tk-n">${t}</span>`;
    else if (KEYWORDS.test(t) && KEYWORDS.exec(t)![0] === t) out += `<span class="tk-k">${t}</span>`;
    else if (API.test(t) && API.exec(t)![0] === t) out += `<span class="tk-a">${t}</span>`;
    else out += esc(t);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last)) + '\n';
}

/** Syntax check in the browser (parse only, nothing runs). */
function syntaxError(code: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`"use strict";\n${code}`);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export function renderScripts(root: HTMLElement, selected: string | null, go: (name: string | null) => void): { refresh: () => void; destroy: () => void } {
  clear(root);
  const list = h('div', { class: 'obj-list' });
  const main = h('section', { class: 'script-main' });
  root.append(h('div', { class: 'page script-page' }, appNav('scripts'), h('div', { class: 'obj-layout script-layout' }, h('aside', { class: 'obj-side' }, list), main)));

  let names: string[] = [];
  let editorState: { name: string; code: string; dirty: boolean; save: () => Promise<void> } | null = null;
  const unregister = registerFlusher(async () => editorState?.save());

  const renderList = async () => {
    try {
      names = (await gameApi.listScripts()).map((s) => s.name);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    clear(list);
    list.append(h('div', { class: 'side-title' }, `Scripts (${names.length})`));
    for (const n of names) {
      list.append(h('a', { class: `obj-item script-item${n === selected ? ' active' : ''}`, href: `#/scripts/${encodeURIComponent(n)}` }, h('span', { class: 'obj-item-name' }, `${n}.js`)));
    }
    list.append(h('button', { class: 'tpl-btn', onclick: async () => {
      const n = await promptText('New script', 'Name (e.g. npcs, battle, inventory)', names.length ? '' : 'main');
      if (!n) return;
      try {
        await gameApi.createScript(n);
        go(n);
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    } }, icon('plus', 13), h('span', {}, 'New script'), h('span', { class: 'muted small' }, 'Starts with an example NPC and function')));
    const info = state.scriptInfo;
    list.append(
      h('div', { class: 'side-title' }, 'Registered'),
      h('div', { class: 'reg-box' },
        h('div', { class: 'small' }, h('b', {}, 'Behaviors: '), info.behaviors.join(', ') || '—'),
        h('div', { class: 'small' }, h('b', {}, 'Functions: '), info.functions.join(', ') || '—'),
        ...info.errors.map((e) => h('div', { class: 'small problem' }, e)),
      ),
      h('p', { class: 'muted small reg-help' }, 'Use a behavior on an object type (Behaviors → Script behavior) and call functions from events (action “Run script function”).'),
    );
  };

  const renderEditor = async () => {
    clear(main);
    if (!selected) {
      main.append(h('div', { class: 'empty big' },
        h('h2', {}, 'Scripts'),
        h('p', { class: 'muted' }, 'Scripts are JavaScript files for what events can’t express well: conversations with choices, NPCs, cutscenes, turn-based battles, inventories, custom HUDs and menus.'),
        h('p', { class: 'muted' }, 'Ask Claude e.g. “write a script for a shopkeeper NPC that sells potions for 10 gold”, or create one on the left.'),
      ));
      return;
    }
    let code: string;
    try {
      code = (await gameApi.getScript(selected)).code;
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    const name = selected;
    const status = h('span', { class: 'save-label' }, 'Saved');
    const errorBox = h('div', { class: 'script-error' });
    const gutter = h('pre', { class: 'code-gutter' });
    const hl = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
    const ta = h('textarea', { class: 'code-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off' }) as HTMLTextAreaElement;
    ta.value = code;
    let timer = 0;
    const st = { name, code, dirty: false, save: async () => {} };
    editorState = st;
    const paint = () => {
      hl.innerHTML = highlight(ta.value);
      const lines = ta.value.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n') + '\n';
      const err = syntaxError(ta.value);
      errorBox.textContent = err ? `Syntax: ${err}` : '';
      errorBox.hidden = !err;
    };
    const sync = () => {
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
      gutter.scrollTop = ta.scrollTop;
    };
    st.save = async () => {
      clearTimeout(timer);
      if (!st.dirty) return;
      st.dirty = false;
      status.textContent = 'Saving…';
      status.dataset.state = 'saving';
      try {
        await gameApi.saveScript(name, ta.value);
        st.code = ta.value;
        status.textContent = 'Saved';
        status.dataset.state = '';
        state.scriptInfo = await gameApi.scriptInfo();
        void renderList();
      } catch (err) {
        st.dirty = true;
        status.textContent = 'Save failed';
        status.dataset.state = 'error';
        toast((err as Error).message, 'error');
      }
    };
    const changed = () => {
      st.dirty = true;
      status.textContent = 'Unsaved';
      status.dataset.state = 'dirty';
      paint();
      clearTimeout(timer);
      timer = window.setTimeout(() => void st.save(), 900);
    };
    ta.addEventListener('input', changed);
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void st.save();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = ta;
        if (e.shiftKey) {
          const lineStart = value.lastIndexOf('\n', a - 1) + 1;
          if (value.startsWith('  ', lineStart)) {
            ta.setRangeText('', lineStart, lineStart + 2, 'preserve');
          }
        } else ta.setRangeText('  ', a, b, 'end');
        changed();
        return;
      }
      if (e.key === 'Enter') {
        // Keep the indentation of the current line (+2 after an opening bracket).
        e.preventDefault();
        const a = ta.selectionStart;
        const lineStart = ta.value.lastIndexOf('\n', a - 1) + 1;
        const indent = /^\s*/.exec(ta.value.slice(lineStart, a))![0];
        const extra = /[{[(]\s*$/.test(ta.value.slice(lineStart, a)) ? '  ' : '';
        ta.setRangeText('\n' + indent + extra, a, ta.selectionEnd, 'end');
        changed();
      }
    });
    paint();

    const reference = h('pre', { class: 'script-ref' }, 'Loading…');
    void gameApi.scriptReference().then((r) => (reference.textContent = r.reference)).catch(() => {});

    main.append(
      h('header', { class: 'obj-head script-head' },
        h('h2', {}, `${name}.js`),
        status,
        h('span', { class: 'spacer' }),
        h('button', { class: 'small', onclick: async () => {
          const to = await promptText('Rename script', 'New name', name);
          if (!to || to === name) return;
          await st.save();
          try { await gameApi.renameScript(name, to); go(to); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('pencil', 13), 'Rename'),
        h('button', { class: 'small danger', onclick: async () => {
          if (!(await confirmDialog('Delete script', `Delete scripts/${name}.js?`))) return;
          try { await gameApi.deleteScript(name); go(null); } catch (err) { toast((err as Error).message, 'error'); }
        } }, icon('trash', 13), 'Delete'),
        h('button', { class: 'primary small', onclick: async () => { await st.save(); void openPlay(); } }, icon('play', 13), 'Play'),
      ),
      errorBox,
      h('div', { class: 'script-body' },
        h('div', { class: 'code-editor' }, gutter, h('div', { class: 'code-area' }, hl, ta)),
        h('details', { class: 'script-ref-box', open: true }, h('summary', {}, 'Script API reference'), reference),
      ),
    );
    ta.setSelectionRange(0, 0);
    ta.focus();
    ta.scrollTop = 0;
    sync();
  };

  const refresh = () => {
    void renderList();
  };
  void renderList();
  void renderEditor();
  return {
    refresh,
    destroy: () => {
      void editorState?.save();
      unregister();
    },
  };
}
