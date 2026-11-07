type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper: h('button', { class: 'x', onclick: fn }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

const ICONS: Record<string, string> = {
  pencil: '<path d="M4 16l1-4 8-8 3 3-8 8z"/><path d="M11.5 5.5l3 3"/>',
  eraser: '<path d="M3.5 13.5l7-7 6 6-4 4h-5z"/><path d="M7 10l6 6"/><path d="M8 16.5h9"/>',
  fill: '<path d="M4 9l5-5 7 7-5 5z"/><path d="M4 9h12"/><path d="M17.5 13s1.5 2 1.5 3a1.5 1.5 0 0 1-3 0c0-1 1.5-3 1.5-3z"/>',
  picker: '<path d="M13 3.5l3.5 3.5-2 2-3.5-3.5z"/><path d="M11.5 7.5l-7 7V17h2.5l7-7"/>',
  line: '<path d="M4 16L16 4"/>',
  rect: '<rect x="3.5" y="5" width="13" height="10" rx="0.5"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="6.5" ry="5.5"/>',
  move: '<path d="M10 2.5v15M2.5 10h15"/><path d="M8 4.5l2-2 2 2M8 15.5l2 2 2-2M4.5 8l-2 2 2 2M15.5 8l2 2-2 2"/>',
  undo: '<path d="M7 5L3.5 8.5 7 12"/><path d="M4 8.5h8a4 4 0 0 1 0 8H9"/>',
  redo: '<path d="M13 5l3.5 3.5L13 12"/><path d="M16 8.5H8a4 4 0 0 0 0 8h3"/>',
  grid: '<path d="M3 3h14v14H3zM3 7.7h14M3 12.3h14M7.7 3v14M12.3 3v14"/>',
  onion: '<circle cx="8" cy="10" r="5"/><circle cx="12" cy="10" r="5" stroke-dasharray="2 1.5"/>',
  mirror: '<path d="M10 2.5v15" stroke-dasharray="2 1.5"/><path d="M8 6L3 10l5 4zM12 6l5 4-5 4z"/>',
  play: '<path d="M6 4l10 6-10 6z" fill="currentColor"/>',
  pause: '<path d="M6 4h3v12H6zM11 4h3v12h-3z" fill="currentColor"/>',
  prev: '<path d="M14 4L7 10l7 6z" fill="currentColor"/><path d="M5.5 4v12"/>',
  next: '<path d="M6 4l7 6-7 6z" fill="currentColor"/><path d="M14.5 4v12"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  minus: '<path d="M4 10h12"/>',
  close: '<path d="M5 5l10 10M15 5L5 15"/>',
  copy: '<rect x="6.5" y="6.5" width="10" height="10" rx="1"/><path d="M13.5 6.5v-3h-10v10h3"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M5.5 6l1 11h7l1-11"/>',
  up: '<path d="M10 15V5M5.5 9.5L10 5l4.5 4.5"/>',
  down: '<path d="M10 5v10M5.5 10.5L10 15l4.5-4.5"/>',
  left: '<path d="M15 10H5M9.5 5.5L5 10l4.5 4.5"/>',
  right: '<path d="M5 10h10M10.5 5.5L15 10l-4.5 4.5"/>',
  merge: '<path d="M10 3v9M6 8l4 4 4-4M4 16h12"/>',
  eye: '<path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.2"/>',
  eyeoff: '<path d="M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z" opacity=".35"/><path d="M4 16L16 4"/>',
  export: '<path d="M10 3v10M6 7l4-4 4 4"/><path d="M4 12v4h12v-4"/>',
  back: '<path d="M12 4l-6 6 6 6"/>',
  swap: '<path d="M5 7h10l-3-3M15 13H5l3 3"/>',
  tag: '<path d="M3 3h7l7 7-7 7-7-7z"/><circle cx="7" cy="7" r="1.2"/>',
  fit: '<path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4"/>',
  help: '<circle cx="10" cy="10" r="7.5"/><path d="M8 8a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.6"/><circle cx="10" cy="14" r=".6" fill="currentColor"/>',
  resize: '<path d="M3 3h9v9H3z"/><path d="M12 8h5v9H8v-5"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

export function iconButton(name: string, title: string, onclick: (e: MouseEvent) => void, extra: Attrs = {}): HTMLButtonElement {
  return h('button', { class: 'icon-btn', title, 'aria-label': title, onclick, ...extra }, icon(name));
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'info' | 'error' | 'claude' = 'info'): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.append(el);
  }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el!.className = ''), kind === 'error' ? 5000 : 2600);
}

/** Opens a modal; resolves when closed. `build` receives a close callback. */
export function modal(title: string, build: (close: () => void) => Node, opts: { wide?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = h('div', { class: 'modal-backdrop' });
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => e.target === backdrop && close());
    backdrop.append(
      h('div', { class: `modal${opts.wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title },
        h('header', {}, h('h2', {}, title), iconButton('close', 'Close', close)),
        build(close),
      ),
    );
    document.body.append(backdrop);
    backdrop.querySelector<HTMLElement>('input, select, button.primary')?.focus();
  });
}

/** Prompt for a single text value. */
export async function promptText(title: string, label: string, initial = '', opts: { caretAtEnd?: boolean } = {}): Promise<string | null> {
  let result: string | null = null;
  await modal(title, (close) => {
    const input = h('input', { type: 'text', value: initial, spellcheck: false });
    const form = h('form', {
      class: 'form',
      onsubmit: (e: Event) => {
        e.preventDefault();
        result = input.value.trim();
        close();
      },
    },
      h('label', {}, label, input),
      h('div', { class: 'actions' }, h('button', { type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'OK')),
    );
    setTimeout(() => (opts.caretAtEnd ? input.setSelectionRange(input.value.length, input.value.length) : input.select()));
    return form;
  });
  return result;
}

export async function confirmDialog(title: string, message: string, okLabel = 'Delete'): Promise<boolean> {
  let ok = false;
  await modal(title, (close) =>
    h('div', { class: 'form' },
      h('p', {}, message),
      h('div', { class: 'actions' },
        h('button', { onclick: close }, 'Cancel'),
        h('button', { class: 'primary danger', onclick: () => { ok = true; close(); } }, okLabel),
      ),
    ),
  );
  return ok;
}
