/**
 * A small code editor: textarea over a highlighted <pre>, line numbers, Tab/Enter indentation, Ctrl+S,
 * autosave, and optional autocompletion (popup at the caret) with a signature hint.
 */

import { clear, h } from './dom.js';
import type { Completion, CompletionItem } from './scriptComplete.js';

export interface CodeEditorOptions {
  value: string;
  highlight: (code: string) => string;
  /** Returns an error message to show under the toolbar, or null. */
  check?: (code: string) => string | null;
  /** Saves; called after a pause in typing and on Ctrl+S. */
  save: (code: string) => Promise<void>;
  onChange?: (code: string) => void;
  /** Completions at the caret (`explicit` = Ctrl+Space). */
  complete?: (code: string, pos: number, explicit: boolean) => Completion | null;
  /** Signature of the call around the caret, shown under the editor. */
  signature?: (code: string, pos: number) => { ts: string; doc: string } | null;
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

  // ---------------------------------------------------------------- autocompletion
  const popup = h('div', { class: 'cc-popup', hidden: true });
  const list = h('div', { class: 'cc-list' });
  const docBox = h('div', { class: 'cc-doc' });
  popup.append(list, docBox);
  // Clicking the popup must not blur the textarea.
  popup.addEventListener('mousedown', (e) => e.preventDefault());
  const hint = h('div', { class: 'cc-hint', hidden: true });
  let comp: Completion | null = null;
  let sel = 0;
  const KIND: Record<string, string> = { function: 'ƒ', method: 'ƒ', property: '◇', field: '◇', value: '"', variable: 'x', namespace: '{}', class: 'C', hook: '⟳', keyword: 'k', component: '◆', file: '📄', snippet: '✎' };
  const measure = h('span', { class: 'cc-measure' }, 'MMMMMMMMMM');
  let charW = 0;
  const closePopup = () => {
    comp = null;
    popup.hidden = true;
  };
  const renderPopup = () => {
    if (!comp) return;
    clear(list);
    comp.items.forEach((it, i) => {
      const row = h('div', { class: `cc-item${i === sel ? ' active' : ''}`, onclick: () => accept(i) },
        h('span', { class: `cc-kind k-${it.kind}` }, KIND[it.kind] ?? '·'),
        h('span', { class: 'cc-label' }, it.label),
        it.detail ? h('span', { class: 'cc-detail' }, it.detail.length > 48 ? it.detail.slice(0, 47) + '…' : it.detail) : null,
      );
      list.append(row);
    });
    const cur = comp.items[sel];
    clear(docBox);
    if (cur?.detail || cur?.doc) docBox.append(...[cur.detail ? h('code', {}, cur.detail) : null, cur.doc ? h('p', {}, cur.doc) : null].filter((x): x is HTMLElement => !!x));
    docBox.hidden = !cur?.detail && !cur?.doc;
    list.querySelector('.cc-item.active')?.scrollIntoView({ block: 'nearest' });
    // Position under the start of the word.
    if (!charW) charW = measure.getBoundingClientRect().width / 10 || 7.5;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 19;
    const before = ta.value.slice(0, comp.from);
    const line = before.split('\n').length - 1;
    const col = comp.from - (before.lastIndexOf('\n') + 1);
    const x = parseFloat(cs.paddingLeft) + col * charW - ta.scrollLeft;
    const y = parseFloat(cs.paddingTop) + (line + 1) * lh - ta.scrollTop;
    const areaW = ta.clientWidth;
    popup.style.left = `${Math.max(0, Math.min(x - 22, areaW - 300))}px`;
    const below = y + 2;
    popup.hidden = false;
    const ph = popup.offsetHeight;
    popup.style.top = `${below + ph > ta.clientHeight && y - lh - ph > 0 ? y - lh - ph - 2 : below}px`;
  };
  const openCompletion = (explicit: boolean) => {
    if (!opts.complete || ta.selectionStart !== ta.selectionEnd) return closePopup();
    const r = opts.complete(ta.value, ta.selectionStart, explicit);
    if (!r || !r.items.length) return closePopup();
    const prevLabel = comp?.items[sel]?.label;
    comp = r;
    sel = Math.max(0, prevLabel ? r.items.findIndex((i) => i.label === prevLabel) : 0);
    renderPopup();
  };
  const accept = (i: number) => {
    if (!comp) return;
    const it: CompletionItem | undefined = comp.items[i];
    if (!it) return closePopup();
    const lineStart = ta.value.lastIndexOf('\n', comp.from - 1) + 1;
    const indent = /^\s*/.exec(ta.value.slice(lineStart, comp.from))![0];
    let text = it.insert.replace(/\n/g, '\n' + indent);
    // Don't double a "(" that is already there.
    if (ta.value[comp.to] === '(' && /\(\$0\)|\(\)\$0$/.test(text)) text = text.replace(/\(\$0\)$|\(\)\$0$/, '$0');
    const caret = text.indexOf('$0');
    text = text.replace('$0', '');
    const from = comp.from;
    ta.setRangeText(text, from, comp.to, 'end');
    const at = caret >= 0 ? from + caret : from + text.length;
    ta.setSelectionRange(at, at);
    closePopup();
    changed();
    // Inside quotes now (getComponent('|')): show the names right away.
    if (/['"]$/.test(ta.value.slice(0, at))) openCompletion(true);
  };
  const updateHint = () => {
    if (!opts.signature) return;
    const sig = document.activeElement === ta && ta.selectionStart === ta.selectionEnd ? opts.signature(ta.value, ta.selectionStart) : null;
    hint.hidden = !sig;
    if (sig) {
      clear(hint);
      hint.append(h('code', {}, sig.ts), h('span', { class: 'muted' }, ' — ' + sig.doc));
    }
  };

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
  ta.addEventListener('input', (e) => {
    changed();
    const ie = e as InputEvent;
    if (!opts.complete) return;
    if (ie.inputType === 'insertText' && ie.data && /[\w$.'"/]$/.test(ie.data)) openCompletion(false);
    else if (ie.inputType?.startsWith('delete') && comp) openCompletion(false);
    else closePopup();
  });
  ta.addEventListener('scroll', () => {
    sync();
    if (comp) renderPopup();
  });
  ta.addEventListener('blur', () => {
    closePopup();
    hint.hidden = true;
  });
  ta.addEventListener('mousedown', closePopup);
  ta.addEventListener('keyup', updateHint);
  ta.addEventListener('click', updateHint);
  ta.addEventListener('keydown', (e) => {
    if (comp) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = comp.items.length;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderPopup();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        accept(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopup();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') closePopup();
    }
    if (opts.complete && e.ctrlKey && (e.key === ' ' || e.code === 'Space')) {
      e.preventDefault();
      openCompletion(true);
      return;
    }
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
  const el = h('div', { class: 'code-editor-wrap' }, h('div', { class: 'code-editor' }, gutter, h('div', { class: 'code-area' }, hl, ta, popup, measure)), hint);
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
