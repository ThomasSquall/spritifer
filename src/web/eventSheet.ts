/** Visual event sheet editor (WHEN trigger / IF conditions / DO actions) and parameter inputs built from the catalog. */

import {
  ACTIONS,
  ACTION_MAP,
  CONDITIONS,
  KEYS,
  type ParamSpec,
  SOUNDS,
  type StepSpec,
  TRIGGERS,
  TRIGGER_MAP,
  defaultStep,
} from '../core/game/catalog.js';
import { checkExpr } from '../core/game/expr.js';
import type { EventStep, GameEvent, Value } from '../core/game/types.js';
import { SoundBoard } from '../runtime/audio.js';
import { clear, h, icon, iconButton } from './dom.js';

export interface SheetContext {
  objects: string[];
  scenes: string[];
  /** Object sheets can use self/other; scene sheets cannot. */
  isObject: boolean;
  /** Animation tags of the object's sprite (suggestions). */
  animations: string[];
  /** Variable names for assignment suggestions. */
  variables: string[];
  /** Names registered by the project scripts. */
  functions: string[];
  scriptBehaviors: string[];
}

const sounds = new SoundBoard();
let dlCounter = 0;

function select(options: (string | [string, string])[], value: string, onChange: (v: string) => void, cls = ''): HTMLSelectElement {
  const sel = h('select', { class: cls, onchange: () => onChange(sel.value) },
    ...options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : [o, o];
      return h('option', { value: v, selected: v === value }, label);
    }),
  );
  if (!options.some((o) => (Array.isArray(o) ? o[0] : o) === value) && value !== '') {
    sel.prepend(h('option', { value, selected: true }, `${value} (missing)`));
  }
  return sel;
}

function datalist(values: string[]): { id: string; el: HTMLDataListElement } {
  const id = `dl${++dlCounter}`;
  return { id, el: h('datalist', { id }, ...values.map((v) => h('option', { value: v }))) };
}

/** An input for one parameter. Calls onChange with the parsed value. */
export function paramInput(spec: ParamSpec, value: Value | undefined, onChange: (v: Value) => void, ctx: SheetContext): HTMLElement {
  const v = value ?? spec.default ?? '';
  let input: HTMLElement;
  switch (spec.type) {
    case 'bool': {
      const cb = h('input', { type: 'checkbox', checked: v === true, onchange: () => onChange(cb.checked) });
      input = cb;
      break;
    }
    case 'number': {
      const n = h('input', { type: 'number', step: 'any', value: String(v), class: 'num', oninput: () => n.value !== '' && Number.isFinite(Number(n.value)) && onChange(Number(n.value)) });
      input = n;
      break;
    }
    case 'key':
      input = select(KEYS, String(v), onChange);
      break;
    case 'object':
      input = select([['', '— object —'], ...ctx.objects], String(v), onChange);
      break;
    case 'objectOrAny':
      input = select([['any', 'any object'], ...ctx.objects], String(v), onChange);
      break;
    case 'scene':
      input = select([['', '— scene —'], ...ctx.scenes], String(v), onChange);
      break;
    case 'instance':
      input = select(ctx.isObject ? [['self', 'self'], ['other', 'other']] : [['self', 'self']], String(v), onChange);
      break;
    case 'choice':
      input = select(spec.options ?? [], String(v), onChange);
      break;
    case 'function':
      input = select([['', ctx.functions.length ? '— function —' : '— no script functions —'], ...ctx.functions], String(v), onChange);
      break;
    case 'scriptBehavior':
      input = select([['', ctx.scriptBehaviors.length ? '— script behavior —' : '— none in scripts —'], ...ctx.scriptBehaviors], String(v), onChange);
      break;
    case 'sound': {
      const wrap = h('span', { class: 'param-inline' });
      let cur = String(v);
      wrap.append(
        select(SOUNDS, cur, (x) => { cur = x; onChange(x); }),
        h('button', { class: 'icon-btn tiny', title: 'Preview sound', type: 'button', onclick: () => { sounds.unlock(); sounds.play(cur, 0.5); } }, icon('play', 12)),
      );
      input = wrap;
      break;
    }
    case 'target':
    case 'text':
    case 'expr': {
      const suggestions =
        spec.type === 'target'
          ? [...ctx.variables, ...(ctx.isObject ? ['self.x', 'self.y', 'self.vx', 'self.vy', 'self.visible', 'self.flipX', 'self.opacity', 'self.text', 'other.x', 'other.y'] : []), 'camera.x', 'camera.y']
          : spec.name === 'animation'
            ? ctx.animations
            : [];
      const dl = suggestions.length ? datalist(suggestions) : null;
      const t = h('input', {
        type: 'text',
        value: String(v),
        spellcheck: false,
        class: spec.type === 'expr' ? 'expr' : spec.type === 'target' ? 'target' : 'txt',
        list: dl?.id,
        oninput: () => {
          if (spec.type === 'expr') {
            const err = checkExpr(t.value);
            t.classList.toggle('invalid', !!err);
            t.title = err ?? '';
          }
          onChange(t.value);
        },
      });
      if (spec.type === 'expr') {
        const err = checkExpr(t.value);
        t.classList.toggle('invalid', !!err);
        t.title = err ?? 'Expression';
      }
      if (dl) t.setAttribute('list', dl.id);
      input = dl ? h('span', { class: 'param-inline' }, t, dl.el) : t;
      break;
    }
  }
  return h('label', { class: `param p-${spec.type}`, title: spec.help ?? '' }, h('span', { class: 'param-name' }, spec.label ?? spec.name), input);
}

/** Inline editor for a step (trigger, condition, action or behavior): type select + params. */
export function stepEditor(step: EventStep, specs: StepSpec[], ctx: SheetContext, onChange: () => void, onTypeChange: (next: EventStep) => void): HTMLElement {
  const usable = specs.filter((s) => ctx.isObject || !s.objectOnly);
  const spec = specs.find((s) => s.type === step.type);
  const typeSel = select(usable.map((s) => [s.type, s.label] as [string, string]), step.type, (t) => {
    const next = specs.find((s) => s.type === t);
    if (next) onTypeChange(defaultStep(next));
  }, 'step-type');
  if (spec) typeSel.title = spec.help;
  return h('div', { class: 'step-editor' },
    typeSel,
    ...(spec?.params ?? []).map((p) => paramInput(p, step[p.name], (v) => { step[p.name] = v; onChange(); }, ctx)),
  );
}

function newEvent(isObject: boolean): GameEvent {
  return { trigger: defaultStep(TRIGGER_MAP.get(isObject ? 'collision' : 'start')!), conditions: [], actions: [defaultStep(ACTION_MAP.get('add')!)] };
}

/**
 * Renders an event sheet into `container`. `events` is edited in place; onChange is called after every edit.
 * Returns a refresh function.
 */
export function renderEventSheet(container: HTMLElement, events: () => GameEvent[], ctx: () => SheetContext, onChange: () => void): () => void {
  const render = () => {
    clear(container);
    const list = events();
    const c = ctx();
    const changed = () => onChange();
    const structural = () => {
      onChange();
      render();
    };
    if (!list.length) container.append(h('p', { class: 'muted empty-sheet' }, c.isObject ? 'No events. Add one: e.g. WHEN collides with coin DO add 1 to score, destroy other.' : 'No scene events. Add one: e.g. WHEN every frame IF count("coin") == 0 DO go to scene level2.'));
    list.forEach((e, i) => {
      const card = h('div', { class: `event-card${e.disabled ? ' disabled' : ''}` });
      const head = h('div', { class: 'event-row when' },
        h('span', { class: 'kw' }, 'WHEN'),
        stepEditor(e.trigger, TRIGGERS, c, changed, (next) => { e.trigger = next; structural(); }),
        h('span', { class: 'spacer' }),
        iconButton(e.disabled ? 'eyeoff' : 'eye', e.disabled ? 'Enable event' : 'Disable event', () => { e.disabled = !e.disabled || undefined; if (!e.disabled) delete e.disabled; structural(); }, { class: 'icon-btn tiny' }),
        iconButton('copy', 'Duplicate', () => { list.splice(i + 1, 0, JSON.parse(JSON.stringify(e))); structural(); }, { class: 'icon-btn tiny' }),
        iconButton('up', 'Move up', () => { if (i > 0) { list.splice(i - 1, 0, ...list.splice(i, 1)); structural(); } }, { class: 'icon-btn tiny', disabled: i === 0 }),
        iconButton('down', 'Move down', () => { if (i < list.length - 1) { list.splice(i + 1, 0, ...list.splice(i, 1)); structural(); } }, { class: 'icon-btn tiny', disabled: i === list.length - 1 }),
        iconButton('trash', 'Delete event', () => { list.splice(i, 1); structural(); }, { class: 'icon-btn tiny' }),
      );
      card.append(head);
      const rows = (kw: string, steps: EventStep[], specs: StepSpec[], fallback: string) => {
        steps.forEach((s, k) => {
          card.append(h('div', { class: `event-row ${kw.toLowerCase()}` },
            h('span', { class: 'kw' }, k === 0 ? kw : kw === 'IF' ? 'AND' : ''),
            stepEditor(s, specs, c, changed, (next) => { steps[k] = next; structural(); }),
            h('span', { class: 'spacer' }),
            kw === 'DO' ? iconButton('up', 'Move up', () => { if (k > 0) { steps.splice(k - 1, 0, ...steps.splice(k, 1)); structural(); } }, { class: 'icon-btn tiny', disabled: k === 0 }) : null,
            iconButton('close', 'Remove', () => { steps.splice(k, 1); structural(); }, { class: 'icon-btn tiny' }),
          ));
        });
        card.append(h('div', { class: 'event-row add' },
          h('span', { class: 'kw' }, steps.length ? '' : kw),
          h('button', { class: 'ghost small add-step', onclick: () => { const spec = specs.find((x) => x.type === fallback)!; steps.push(defaultStep(spec)); structural(); } }, icon('plus', 13), kw === 'IF' ? 'condition' : 'action'),
        ));
      };
      rows('IF', e.conditions, CONDITIONS, 'expr');
      rows('DO', e.actions, ACTIONS, 'set');
      const comment = h('input', { type: 'text', class: 'event-comment', placeholder: '// comment', value: e.comment ?? '', oninput: () => { if (comment.value) e.comment = comment.value; else delete e.comment; changed(); } });
      card.append(comment);
      container.append(card);
    });
    container.append(h('button', { class: 'add-event', onclick: () => { list.push(newEvent(c.isObject)); structural(); } }, icon('plus', 15), 'Add event'));
  };
  render();
  return render;
}

