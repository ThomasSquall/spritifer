/** A small code editor: textarea over a highlighted <pre>, line numbers, Tab/Enter indentation, Ctrl+S, autosave. */

import { h } from './dom.js';

export interface CodeEditorOptions {
  value: string;
  highlight: (code: string) => string;
  /** Returns an error message to show under the toolbar, or null. */
  check?: (code: string) => string | null;
  /** Saves; called after a pause in typing and on Ctrl+S. */
  save: (code: string) => Promise<void>;
  onChange?: (code: string) => void;
}

export interface CodeEditor {
  el: HTMLElement;
  status: HTMLElement;
  errorBox: HTMLElement;
  textarea: HTMLTextAreaElement;
  flush(): Promise<void>;
  value(): string;
  /** Moves the caret to a 1-based line and scrolls it into view. */
  gotoLine(line: number): void;
}

export function createCodeEditor(opts: CodeEditorOptions): CodeEditor {
  const status = h('span', { class: 'save-label' }, 'Saved');
  const errorBox = h('div', { class: 'script-error', hidden: true });
  const gutter = h('pre', { class: 'code-gutter' });
  const hl = h('pre', { class: 'code-hl', 'aria-hidden': 'true' });
  const ta = h('textarea', { class: 'code-input', spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off' }) as HTMLTextAreaElement;
  ta.value = opts.value;
  let timer = 0;
  let dirty = false;

  const paint = () => {
    hl.innerHTML = opts.highlight(ta.value);
    const lines = ta.value.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n') + '\n';
    const err = opts.check?.(ta.value) ?? null;
    errorBox.textContent = err ?? '';
    errorBox.hidden = !err;
  };
  const sync = () => {
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  };
  const flush = async () => {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    status.textContent = 'Saving…';
    status.dataset.state = 'saving';
    try {
      await opts.save(ta.value);
      status.textContent = 'Saved';
      status.dataset.state = '';
    } catch (err) {
      dirty = true;
      status.textContent = 'Save failed';
      status.dataset.state = 'error';
      throw err;
    }
  };
  const changed = () => {
    dirty = true;
    status.textContent = 'Unsaved';
    status.dataset.state = 'dirty';
    paint();
    opts.onChange?.(ta.value);
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush().catch(() => {}), 900);
  };
  ta.addEventListener('input', changed);
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void flush().catch(() => {});
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value } = ta;
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', a - 1) + 1;
        if (value.startsWith('  ', lineStart)) ta.setRangeText('', lineStart, lineStart + 2, 'preserve');
      } else ta.setRangeText('  ', a, b, 'end');
      changed();
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      // Keep the indentation of the current line (+2 after an opening bracket, a choice or an if).
      e.preventDefault();
      const a = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', a - 1) + 1;
      const before = ta.value.slice(lineStart, a);
      const indent = /^\s*/.exec(before)![0];
      const extra = /[{[(]\s*$/.test(before) || /^\s*(\*|if\b|elif\b|else\b)/.test(before) ? '  ' : '';
      ta.setRangeText('\n' + indent + extra, a, ta.selectionEnd, 'end');
      changed();
    }
  });
  paint();
  const el = h('div', { class: 'code-editor' }, gutter, h('div', { class: 'code-area' }, hl, ta));
  requestAnimationFrame(() => {
    ta.setSelectionRange(0, 0);
    ta.scrollTop = 0;
    sync();
  });
  return {
    el,
    status,
    errorBox,
    textarea: ta,
    flush,
    value: () => ta.value,
    gotoLine(line: number) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
      ta.focus();
      ta.setSelectionRange(pos, pos + (lines[line - 1]?.length ?? 0));
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
      ta.scrollTop = Math.max(0, (line - 4) * lh);
      sync();
    },
  };
}
