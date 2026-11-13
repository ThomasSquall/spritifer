/**
 * Live inspector of the running game (Play overlay): pause, step one frame, and read/edit global and scene
 * variables, scene/game components and every instance (fields, properties, component fields) while it runs.
 */

import type { ComponentView, WorldEdit, WorldView } from '../core/game/debug.js';
import type { Value } from '../core/game/types.js';
import { clear, h } from './dom.js';

export interface PlayInspector {
  el: HTMLElement;
  /** State from the game (reply to inspect/pause/step/edit). */
  update(view: WorldView & { paused?: boolean }): void;
  setVisible(on: boolean): void;
  destroy(): void;
}

export function createPlayInspector(send: (msg: Record<string, unknown>) => void): PlayInspector {
  const el = h('div', { class: 'play-inspector' });
  const head = h('div', { class: 'pi-head' });
  const body = h('div', { class: 'pi-body' });
  el.append(head, body);
  let view: (WorldView & { paused?: boolean }) | null = null;
  let selected: number | null = null;
  let filter = '';
  /** Rows of the instance list drawn at once. */
  const MAX_ROWS = 200;
  let visible = false;
  const open = new Set<string>(['instances']);
  const edit = (e: WorldEdit) => send({ type: 'edit', edit: e });

  const valueInput = (value: Value, onSet: (v: Value) => void): HTMLElement => {
    if (typeof value === 'boolean') {
      const cb = h('input', { type: 'checkbox', checked: value, onchange: () => onSet(cb.checked) });
      return cb;
    }
    const num = typeof value === 'number';
    const inp = h('input', { type: num ? 'number' : 'text', step: 'any', value: String(value), class: 'pi-in', onchange: () => {
      if (num) {
        if (inp.value !== '' && Number.isFinite(Number(inp.value))) onSet(Number(inp.value));
      } else onSet(inp.value);
    } });
    // Enter applies, Escape restores; keys don't reach the game.
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') inp.blur();
      if (e.key === 'Escape') {
        inp.value = String(value);
        inp.blur();
      }
    });
    return inp;
  };

  const rows = (values: Record<string, Value>, onSet: (k: string, v: Value) => void) =>
    Object.entries(values).map(([k, v]) => h('div', { class: 'pi-row' }, h('code', { title: k }, k), valueInput(v, (x) => onSet(k, x))));

  const section = (key: string, title: string, count: number | null, build: () => (Node | null)[]) => {
    const d = h('details', { class: 'pi-sec', open: open.has(key) }, h('summary', {}, title, count !== null ? h('span', { class: 'muted' }, ` ${count}`) : null));
    d.addEventListener('toggle', () => {
      if (d.open) open.add(key);
      else open.delete(key);
      if (d.open) render(true);
    });
    if (d.open) d.append(...build().filter((x): x is Node => !!x));
    return d;
  };

  const comps = (list: ComponentView[], scope: 'game' | 'scene' | 'object', id?: number) =>
    list.map((c) => h('div', { class: `pi-comp${c.enabled ? '' : ' off'}` },
      h('div', { class: 'pi-comp-head' },
        h('input', { type: 'checkbox', checked: c.enabled, title: 'Enabled', onchange: (e: Event) => edit({ kind: 'component', scope, id, index: c.index, key: 'enabled', value: (e.target as HTMLInputElement).checked }) }),
        h('span', { class: 'comp-icon' }, '◆'), h('b', {}, c.name)),
      ...rows(c.fields, (k, v) => edit({ kind: 'component', scope, id, index: c.index, key: k, value: v })),
    ));

  const renderHead = () => {
    clear(head);
    const paused = !!view?.paused;
    head.append(
      h('button', { class: `small${paused ? ' on' : ''}`, title: 'Pause / resume the game', onclick: () => send({ type: 'pause', on: !paused }) }, paused ? '▶ Resume' : '❚❚ Pause'),
      h('button', { class: 'small', disabled: !paused, title: 'Advance one frame (1/60 s)', onclick: () => send({ type: 'step' }) }, '⏭ Step'),
      h('span', { class: 'muted small pi-clock' }, view ? `${view.scene} · ${view.time.toFixed(2)}s · frame ${view.frame}` : '…'),
    );
  };

  const render = (force = false) => {
    renderHead();
    // Don't rebuild while the user is typing in a field.
    if (!force && el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT' && (document.activeElement as HTMLInputElement).type !== 'checkbox') return;
    clear(body);
    const v = view;
    if (!v) {
      body.append(h('p', { class: 'muted small' }, 'Waiting for the game…'));
      return;
    }
    if (v.dialog) body.append(h('div', { class: 'pi-note' }, `Dialog: ${v.dialog}`));
    if (v.controlsLocked) body.append(h('div', { class: 'pi-note' }, 'Player controls locked'));
    const parts: (Node | null)[] = [
      section('globals', 'Global variables', Object.keys(v.globals).length, () => rows(v.globals, (k, x) => edit({ kind: 'global', key: k, value: x }))),
      section('scene', `Scene ${v.scene}`, null, () => [
        ...rows(v.sceneVars, (k, x) => edit({ kind: 'sceneVar', key: k, value: x })),
        ...rows({ 'camera.x': v.camera.x, 'camera.y': v.camera.y, 'camera.zoom': v.camera.zoom }, (k, x) => edit({ kind: 'camera', key: k.slice(7) as 'x' | 'y' | 'zoom', value: Number(x) })),
        ...comps(v.sceneComponents, 'scene'),
      ]),
      v.gameComponents.length ? section('game', 'Global components', v.gameComponents.length, () => comps(v.gameComponents, 'game')) : null,
      section('instances', 'Instances', v.actors.length, () => {
        const search = h('input', { type: 'text', class: 'pi-in pi-search', placeholder: 'Filter…', value: filter, oninput: () => { filter = search.value.toLowerCase(); render(true); search.focus(); search.setSelectionRange(search.value.length, search.value.length); } });
        search.addEventListener('keydown', (e) => e.stopPropagation());
        const list = v.actors.filter((a) => !filter || a.name.toLowerCase().includes(filter) || a.object.toLowerCase().includes(filter) || a.tags.some((t) => t.includes(filter)));
        const out: Node[] = [search];
        // A map made of thousands of pieces: the first rows only, the rest through the filter (and the selected one).
        const shown = list.length > MAX_ROWS ? [...list.slice(0, MAX_ROWS), ...list.slice(MAX_ROWS).filter((a) => a.id === selected)] : list;
        if (shown.length < list.length) out.push(h('p', { class: 'muted small' }, `${list.length} instances: showing ${MAX_ROWS}. Type in the filter to find the others.`));
        for (const a of shown) {
          const isSel = a.id === selected;
          out.push(h('div', { class: `pi-actor${isSel ? ' active' : ''}`, onclick: () => { selected = isSel ? null : a.id; render(true); } },
            h('span', { class: 'pi-actor-name' }, a.name), a.name !== a.object ? h('span', { class: 'muted small' }, a.object) : null,
            h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, `${Math.round(a.x)}, ${Math.round(a.y)}`)));
          if (isSel) {
            const actorEdit = (k: string, x: Value) => edit({ kind: 'actor', id: a.id, key: k, value: x });
            out.push(h('div', { class: 'pi-detail' },
              ...rows({ x: a.x, y: a.y, vx: a.vx, vy: a.vy, visible: a.visible, opacity: a.opacity, z: a.z, facing: a.facing, animation: a.animation }, actorEdit),
              a.tags.length ? h('div', { class: 'muted small pi-tags' }, `tags: ${a.tags.join(', ')}`) : null,
              Object.keys(a.vars).length ? h('div', { class: 'pi-sub' }, 'Properties') : null,
              ...rows(a.vars, (k, x) => edit({ kind: 'actorVar', id: a.id, key: k, value: x })),
              ...comps(a.components, 'object', a.id),
            ));
          }
        }
        if (!list.length) out.push(h('p', { class: 'muted small' }, 'No instances.'));
        return out;
      }),
    ];
    body.append(...parts.filter((x): x is Node => !!x));
  };

  // Poll while visible and running (paused games answer each action).
  const timer = window.setInterval(() => {
    if (visible && !view?.paused) send({ type: 'inspect' });
  }, 300);

  render();
  return {
    el,
    update(v) {
      view = v;
      if (selected !== null && !v.actors.some((a) => a.id === selected)) selected = null;
      if (visible) render();
    },
    setVisible(on) {
      visible = on;
      el.hidden = !on;
      if (on) {
        send({ type: 'inspect' });
        render(true);
      }
    },
    destroy() {
      clearInterval(timer);
    },
  };
}
