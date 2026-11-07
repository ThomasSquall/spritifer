/**
 * Inspector UI for script components: param editors (object types, scenes, the game), per-instance
 * overrides (empty = inherit), "Add component" pickers and "New component" (creates the script file).
 */

import type { ParamSpec } from '../core/game/catalog.js';
import type { ComponentInfo, ComponentParam } from '../core/game/script.js';
import type { Behavior, Instance, ObjectType, Value } from '../core/game/types.js';
import { type SheetContext, paramInput } from './eventSheet.js';
import { gameApi } from './gameApi.js';
import { state } from './gameState.js';
import { clear, h, icon, iconButton, promptText, toast } from './dom.js';
import { SOUNDS, KEYS } from '../core/game/catalog.js';
import { LIBRARY } from '../core/game/library.js';

export function paramSpec(p: ComponentParam): ParamSpec {
  return { name: p.name, type: p.type, default: p.default, label: p.label ?? p.name, help: p.help, options: p.options, min: p.min, max: p.max, step: p.step };
}

const paramsOf = (b: Behavior) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'type' && k !== 'name')) as Record<string, Value>;

export function scriptLink(info: ComponentInfo | undefined): HTMLElement | null {
  if (!info?.path) return null;
  return h('a', { class: 'small comp-open', href: `#/scripts/${encodeURIComponent(info.path)}`, title: `Open scripts/${info.path}.js` }, icon('pencil', 12), `${info.path}.js`);
}

/** Header + doc + param inputs for one component entry ({ type: "script", name, ...params }). */
export function componentCard(b: Behavior, ctx: SheetContext, changed: () => void, opts: { remove?: () => void; moveUp?: () => void } = {}): HTMLElement {
  const name = String(b.name ?? '');
  const info = state.component(name);
  const enabled = b.enabled !== false;
  const en = h('input', { type: 'checkbox', checked: enabled, title: 'Enabled', onchange: () => { if (en.checked) delete b.enabled; else b.enabled = false; changed(); } });
  const body = h('div', { class: 'step-editor comp-params' });
  if (!info) body.append(h('p', { class: 'danger-text small' }, name ? `No component "${name}" in the scripts. Create scripts/${name}.js (export default class ${name} extends Behaviour).` : 'Pick a component.'));
  else if (info.legacy) {
    // behavior() registrations have no declared params: edit the raw ones.
    for (const [k, v] of Object.entries(paramsOf(b))) {
      if (k === 'enabled') continue;
      body.append(paramInput({ name: k, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text' }, v, (x) => { b[k] = x; changed(); }, ctx));
    }
  } else {
    for (const p of info.params) body.append(paramInput(paramSpec(p), b[p.name], (v) => { if (v === p.default) delete b[p.name]; else b[p.name] = v; changed(); }, ctx));
    if (!info.params.length) body.append(h('p', { class: 'muted small' }, 'No params. Public fields of the class (speed = 40) show up here.'));
  }
  const unknown = info && !info.legacy ? Object.keys(paramsOf(b)).filter((k) => k !== 'enabled' && !info.params.some((p) => p.name === k)) : [];
  return h('div', { class: `behavior comp-card${enabled ? '' : ' disabled'}` },
    h('div', { class: 'behavior-head' },
      en,
      h('span', { class: 'comp-icon' }, '◆'),
      h('strong', {}, name || '?'),
      info?.legacy ? h('span', { class: 'badge muted-badge' }, 'legacy') : null,
      h('span', { class: 'spacer' }),
      scriptLink(info),
      opts.moveUp ? iconButton('up', 'Move up', opts.moveUp, { class: 'icon-btn tiny' }) : null,
      opts.remove ? iconButton('close', 'Remove component', opts.remove, { class: 'icon-btn tiny' }) : null,
    ),
    info?.doc ? h('p', { class: 'muted small' }, info.doc) : null,
    body,
    ...unknown.map((k) => h('p', { class: 'danger-text small' }, `Unknown param "${k}" `, h('button', { class: 'ghost small', onclick: () => { delete b[k]; changed(); } }, 'remove'))),
    ...(info?.warnings ?? []).map((w) => h('p', { class: 'warn-text small' }, w)),
  );
}

/** A select listing script components (grouped by folder) plus "New component…". */
export function componentPicker(label: string, exclude: string[], onPick: (name: string) => void): HTMLSelectElement {
  const comps = state.scriptInfo.components.filter((c) => !exclude.includes(c.name));
  const groups = new Map<string, ComponentInfo[]>();
  for (const c of comps) {
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : c.legacy ? 'legacy' : '(root)';
    groups.set(dir, [...(groups.get(dir) ?? []), c]);
  }
  // Library components not in the project yet: picking one copies its script (and what it needs) first.
  const have = new Set(state.scriptInfo.components.map((c) => c.name));
  const lib = LIBRARY.filter((c) => !have.has(c.name) && !exclude.includes(c.name));
  const sel = h('select', { class: 'comp-picker', onchange: async () => {
    const v = sel.value;
    sel.value = '';
    if (v === '__new') {
      const n = await newComponentScript();
      if (n) onPick(n);
    } else if (v.startsWith('lib:')) {
      const n = await addFromLibrary([v.slice(4)]);
      if (n) onPick(v.slice(4));
    } else if (v) onPick(v);
  } },
    h('option', { value: '' }, label),
    ...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dir, list]) => h('optgroup', { label: dir }, ...list.map((c) => h('option', { value: c.name }, c.name)))),
    lib.length ? h('optgroup', { label: 'Library (adds the script)' }, ...lib.map((c) => h('option', { value: `lib:${c.name}`, title: c.summary }, `${c.name} — ${c.summary}`))) : null,
    h('option', { value: '__new' }, '＋ New component script…'),
  );
  return sel;
}

/** Copies library components into the project's scripts/ and refreshes what the editor knows. */
export async function addFromLibrary(names: string[]): Promise<boolean> {
  try {
    const r = await gameApi.addLibrary(names);
    state.scriptInfo = await gameApi.scriptInfo();
    if (r.created.length) toast(`Added ${r.created.map((p) => `scripts/${p}.js`).join(', ')}`);
    return true;
  } catch (err) {
    toast((err as Error).message, 'error');
    return false;
  }
}

/** Asks for a path ("enemies/Patrol"), creates the component file from the template, refreshes the script info. */
export async function newComponentScript(folder = ''): Promise<string | null> {
  const path = await promptText('New component', 'Script path: folder/Name (e.g. enemies/Patrol, player/Health)', folder ? `${folder}/` : '', { caretAtEnd: true });
  if (!path) return null;
  const clean = path.trim().replace(/\.js$/, '').replace(/^\/+|\/+$/g, '');
  const base = clean.split('/').pop() ?? '';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(base)) {
    toast('The name must be a class name: letters, digits and _ (e.g. Patrol)', 'error');
    return null;
  }
  try {
    await gameApi.createScript(clean, 'component');
    state.scriptInfo = await gameApi.scriptInfo();
    toast(`Created scripts/${clean}.js`);
    return base;
  } catch (err) {
    toast((err as Error).message, 'error');
    return null;
  }
}

/** Editable list of components (scene or game components). */
export function componentListCard(title: string, help: string, get: () => Behavior[] | undefined, set: (list: Behavior[] | undefined) => void, ctx: () => SheetContext, changed: () => void): HTMLElement {
  const box = h('div', { class: 'comp-list' });
  const render = () => {
    clear(box);
    const list = get() ?? [];
    list.forEach((b, i) => box.append(componentCard(b, ctx(), changed, {
      remove: () => { list.splice(i, 1); set(list.length ? list : undefined); changed(); render(); },
      moveUp: i > 0 ? () => { list.splice(i - 1, 0, ...list.splice(i, 1)); changed(); render(); } : undefined,
    })));
    if (!list.length) box.append(h('p', { class: 'muted small' }, help));
    box.append(componentPicker('+ Add component…', list.map((b) => String(b.name)), (name) => {
      const next = [...list, { type: 'script', name }];
      set(next);
      changed();
      render();
    }));
  };
  render();
  return h('div', { class: 'comp-section' }, h('div', { class: 'comp-section-title' }, title), box);
}

/** An input for an instance override: empty = inherit `inherited`. */
function overrideInput(p: ComponentParam, cur: Value | undefined, inherited: Value, onChange: (v: Value | undefined) => void): HTMLElement {
  const ctx = state;
  const opts = (values: string[]) => [h('option', { value: '' }, `— ${inherited === '' ? 'none' : String(inherited)} (inherit) —`), ...values.map((v) => h('option', { value: v, selected: cur !== undefined && String(cur) === v }, v))];
  let input: HTMLElement;
  switch (p.type) {
    case 'number': {
      const n = h('input', { type: 'number', class: 'num', step: p.step !== undefined ? String(p.step) : 'any', value: cur !== undefined ? String(cur) : '', placeholder: String(inherited), oninput: () => onChange(n.value === '' ? undefined : Number(n.value)) });
      input = n;
      break;
    }
    case 'bool': {
      const s = h('select', { onchange: () => onChange(s.value === '' ? undefined : s.value === 'true') }, ...opts(['true', 'false']));
      input = s;
      break;
    }
    case 'color': {
      const c = h('input', { type: 'color', value: String(cur ?? inherited), oninput: () => { onChange(c.value); reset.hidden = false; } });
      const reset = iconButton('undo', 'Inherit', () => { onChange(undefined); c.value = String(inherited); reset.hidden = true; }, { class: 'icon-btn tiny' });
      reset.hidden = cur === undefined;
      input = h('span', { class: 'param-inline' }, c, reset);
      break;
    }
    case 'text': {
      const t = h('input', { type: 'text', value: cur !== undefined ? String(cur) : '', placeholder: String(inherited), oninput: () => onChange(t.value === '' ? undefined : t.value) });
      input = t;
      break;
    }
    default: {
      const values = p.type === 'choice' ? (p.options ?? []) : p.type === 'object' ? (ctx.game?.objects.map((o) => o.name) ?? []) : p.type === 'scene' ? ctx.scenes.map((s) => s.name) : p.type === 'sound' ? SOUNDS : p.type === 'sprite' ? ctx.sprites.map((s) => s.name) : p.type === 'dialogue' ? ctx.dialogueInfo.nodes : p.type === 'key' ? KEYS : [];
      const s = h('select', { onchange: () => onChange(s.value === '' ? undefined : s.value) }, ...opts(values));
      input = s;
    }
  }
  return h('label', { class: `param p-${p.type}${cur !== undefined ? ' overridden' : ''}`, title: p.help ?? '' }, h('span', { class: 'param-name' }, p.label ?? p.name), input);
}

/**
 * Components of a placed instance: the object type's ones with per-instance overrides (empty = inherit),
 * plus components only this instance has.
 */
export function instanceComponents(inst: Instance, obj: ObjectType | undefined, edit: (fn: () => void) => void, rerender: () => void): HTMLElement {
  const box = h('div', { class: 'comp-list inst-comps' });
  const typeComps = (obj?.behaviors ?? []).filter((b) => b.type === 'script');
  const own = Object.keys(inst.components ?? {}).filter((n) => !typeComps.some((b) => b.name === n));
  const setOverride = (comp: string, key: string, v: Value | undefined) => {
    inst.components ??= {};
    const cur = (inst.components[comp] ??= {});
    if (v === undefined) delete cur[key];
    else cur[key] = v;
    // Keep an empty entry for instance-only components (it is what adds them).
    if (!Object.keys(cur).length && typeComps.some((b) => b.name === comp)) delete inst.components[comp];
    if (!Object.keys(inst.components).length) delete inst.components;
  };
  const card = (name: string, base: Record<string, Value>, instanceOnly: boolean) => {
    const info = state.component(name);
    const cfg = inst.components?.[name] ?? {};
    const enabled = (cfg.enabled ?? base.enabled ?? true) !== false;
    const en = h('input', { type: 'checkbox', checked: enabled, title: 'Enabled on this instance', onchange: () => edit(() => setOverride(name, 'enabled', en.checked === ((base.enabled ?? true) !== false) ? undefined : en.checked)) });
    const params = h('div', { class: 'step-editor comp-params' });
    if (!info) params.append(h('p', { class: 'danger-text small' }, `No component "${name}" in the scripts.`));
    else for (const p of info.params) params.append(overrideInput(p, cfg[p.name], base[p.name] ?? p.default, (v) => edit(() => setOverride(name, p.name, v))));
    const overridden = Object.keys(cfg).filter((k) => k !== 'enabled').length;
    return h('div', { class: `behavior comp-card${enabled ? '' : ' disabled'}` },
      h('div', { class: 'behavior-head' },
        en,
        h('span', { class: 'comp-icon' }, '◆'),
        h('strong', {}, name),
        instanceOnly ? h('span', { class: 'badge muted-badge', title: 'Only this instance has it' }, 'instance') : overridden ? h('span', { class: 'badge', title: 'Params changed on this instance' }, `${overridden} override${overridden > 1 ? 's' : ''}`) : null,
        h('span', { class: 'spacer' }),
        scriptLink(info),
        instanceOnly
          ? iconButton('close', 'Remove from this instance', () => { edit(() => { delete inst.components![name]; if (!Object.keys(inst.components!).length) delete inst.components; }); rerender(); }, { class: 'icon-btn tiny' })
          : overridden ? iconButton('undo', 'Reset overrides', () => { edit(() => { delete inst.components![name]; if (!Object.keys(inst.components!).length) delete inst.components; }); rerender(); }, { class: 'icon-btn tiny' }) : null,
      ),
      params,
    );
  };
  for (const b of typeComps) box.append(card(String(b.name), paramsOf(b), false));
  for (const n of own) box.append(card(n, {}, true));
  box.append(componentPicker('+ Add component to this instance…', [...typeComps.map((b) => String(b.name)), ...own], (name) => {
    edit(() => {
      inst.components ??= {};
      inst.components[name] = {};
    });
    rerender();
  }));
  return box;
}
