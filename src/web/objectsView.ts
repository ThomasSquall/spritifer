/** Objects page: the game's object types (player, enemies, pickups, HUD...) with behaviors, properties and events. */

import { BEHAVIORS, BEHAVIOR_MAP, defaultStep } from '../core/game/catalog.js';
import { type Behavior, GAME_NAME_RE, type ObjectType, type Value, normalizeObject, normalizeTags } from '../core/game/types.js';
import { behaviorKey } from '../core/game/variants.js';
import { api } from './api.js';
import { type SheetContext, paramInput, renderEventSheet } from './eventSheet.js';
import { gameApi } from './gameApi.js';
import { looksLikePlainText, previewText } from './textPreview.js';
import { state } from './gameState.js';
import { appNav } from './nav.js';
import { openUsages } from './usagesView.js';
import { clear, confirmDialog, h, icon, iconButton, promptText, toast } from './dom.js';
import { componentCard, componentPicker } from './componentsUi.js';
import { lightEditor } from './atmosphereUi.js';
import { VALUE_HINT, formatValue, parseValue } from './values.js';

interface Template {
  id: string;
  label: string;
  hint: string;
  /** Raw fields, normalized by normalizeObject. */
  make: (name: string, player: string) => Record<string, unknown>;
}

export const TEMPLATES: Template[] = [
  { id: 'platformer', label: 'Platformer player', hint: 'Runs and jumps, camera follows', make: () => ({ behaviors: [{ type: 'platformer', speed: 100, jump: 300 }, { type: 'camera' }], events: [{ trigger: { type: 'leftScene' }, conditions: [], actions: [{ type: 'restartScene' }] }] }) },
  { id: 'topdown', label: 'Top-down player', hint: '8-way movement, camera follows', make: () => ({ behaviors: [{ type: 'topdown', speed: 80 }, { type: 'camera' }] }) },
  { id: 'npc', label: 'NPC (talks)', hint: 'Place it many times: each one gets its own name, look and dialogue', make: () => ({ behaviors: [{ type: 'solid', oneWay: false }, { type: 'dialogue', dialogue: '' }] }) },
  { id: 'enemy', label: 'Patrolling enemy', hint: 'Walks and turns at walls/ledges', make: (_n, player) => ({ behaviors: [{ type: 'patrol', speed: 40 }], events: [{ trigger: { type: 'collision', with: player }, conditions: [], actions: [{ type: 'sound', sound: 'hurt' }, { type: 'restartScene' }] }] }) },
  { id: 'chaser', label: 'Chasing enemy', hint: 'Follows the player when near', make: (_n, player) => ({ behaviors: [{ type: 'chase', target: player, speed: 45, range: 140 }] }) },
  { id: 'pickup', label: 'Pickup (coin)', hint: 'Floats; +1 score when touched', make: (_n, player) => ({ behaviors: [{ type: 'sine', axis: 'y', amplitude: 2, period: 1.2 }], events: [{ trigger: { type: 'collision', with: player }, conditions: [], actions: [{ type: 'add', target: 'score', value: '1' }, { type: 'sound', sound: 'coin' }, { type: 'destroy', target: 'self' }] }] }) },
  { id: 'solid', label: 'Solid block', hint: 'Walls, crates, platforms', make: () => ({ behaviors: [{ type: 'solid', oneWay: false }] }) },
  { id: 'bullet', label: 'Bullet', hint: 'Flies straight, dies on walls', make: () => ({ behaviors: [{ type: 'bullet', speed: 220, angle: 0 }, { type: 'lifetime', seconds: 3 }] }) },
  { id: 'goal', label: 'Goal / door', hint: 'Next scene when touched', make: (_n, player) => ({ events: [{ trigger: { type: 'collision', with: player }, conditions: [], actions: [{ type: 'sound', sound: 'powerup' }, { type: 'restartScene' }] }] }) },
  { id: 'hud', label: 'Text / HUD', hint: 'Shows a score or a label', make: () => ({ text: '"SCORE " + score', hud: true, textColor: '#ffffff', textSize: 1 }) },
  { id: 'empty', label: 'Empty', hint: 'Start from nothing', make: () => ({}) },
];

export function sheetContext(obj: ObjectType | null, animations: string[]): SheetContext {
  const g = state.game!;
  return {
    objects: g.objects.map((o) => o.name),
    scenes: state.scenes.map((s) => s.name),
    isObject: !!obj,
    animations,
    variables: [...Object.keys(g.variables), ...(obj ? Object.keys(obj.properties).map((p) => `self.${p}`) : [])],
    functions: state.scriptInfo.functions,
    scriptBehaviors: state.scriptInfo.behaviors,
    dialogues: state.dialogueInfo.nodes,
    sprites: state.sprites.map((s) => s.name),
    audio: state.audio,
    actions: Object.keys(g.actions ?? {}),
    vfx: state.vfx,
  };
}

function uniqueName(base: string): string {
  const names = new Set(state.game!.objects.map((o) => o.name));
  let n = base;
  for (let i = 2; names.has(n); i++) n = `${base}${i}`;
  return n;
}

/** Creates an object type from a template (used by the Objects page and the scene editor). */
export function createFromTemplate(t: Template, name: string, sprite?: string): ObjectType {
  const g = state.game!;
  const player = g.objects.find((o) => o.behaviors.some((b) => b.type === 'platformer' || b.type === 'topdown'))?.name ?? 'player';
  const obj = normalizeObject({ name, ...(sprite ? { sprite } : {}), ...t.make(name, player) });
  if (t.id === 'pickup' && !('score' in g.variables)) g.variables.score = 0;
  if (t.id === 'hud' && !('score' in g.variables)) g.variables.score = 0;
  g.objects.push(obj);
  state.change();
  return obj;
}

export function renderObjects(root: HTMLElement, selected: string | null, go: (name: string | null) => void): () => void {
  clear(root);
  const list = h('div', { class: 'obj-list' });
  const main = h('section', { class: 'obj-main' });
  root.append(h('div', { class: 'page' }, appNav('objects'), h('div', { class: 'obj-layout' }, h('aside', { class: 'obj-side' }, list), main)));

  const renderList = () => {
    clear(list);
    const g = state.game!;
    list.append(h('div', { class: 'side-title' }, `Object types (${g.objects.length})`));
    for (const o of g.objects) {
      const s = state.sprite(state.effective(o.name)?.sprite ?? o.sprite);
      list.append(h('a', { class: `obj-item${o.name === selected ? ' active' : ''}`, href: `#/objects/${encodeURIComponent(o.name)}` },
        h('span', { class: 'obj-thumb checker' }, s ? h('img', { src: api.previewUrl(s.name, s.rev, 2), alt: '' }) : o.text !== undefined ? h('span', { class: 'txt-badge' }, 'Aa') : null),
        h('span', { class: 'obj-item-name' }, o.name),
        h('span', { class: 'obj-item-tags muted' }, o.extends ? `↳ variant of ${o.extends}` : o.behaviors.map((b) => (b.type === 'script' ? String(b.name) : b.type)).join(', ')),
      ));
    }
    list.append(h('div', { class: 'side-title' }, 'New from template'));
    const sprites = state.sprites;
    for (const t of TEMPLATES) {
      list.append(h('button', { class: 'tpl-btn', title: t.hint, onclick: async () => {
        const name = await promptText(`New ${t.label.toLowerCase()}`, 'Object name (letters, digits, _)', uniqueName(t.id === 'platformer' || t.id === 'topdown' ? 'player' : t.id === 'pickup' ? 'coin' : t.id === 'hud' ? 'score_label' : t.id));
        if (!name) return;
        if (!GAME_NAME_RE.test(name) || state.object(name)) return toast(state.object(name) ? `"${name}" already exists` : 'Invalid name', 'error');
        const guess = t.id === 'hud' ? undefined : sprites.find((s) => s.name.toLowerCase().includes(name.toLowerCase()))?.name;
        createFromTemplate(t, name, guess);
        go(name);
      } }, icon('plus', 13), h('span', {}, t.label), h('span', { class: 'muted small' }, t.hint)));
    }
  };

  const renderMain = () => {
    clear(main);
    const g = state.game!;
    const obj = selected ? g.objects.find((o) => o.name === selected) : undefined;
    if (!obj) {
      main.append(h('div', { class: 'empty big' },
        h('h2', {}, g.objects.length ? 'Pick an object type' : 'No object types yet'),
        h('p', { class: 'muted' }, 'Object types are the things in your game: the player, enemies, coins, doors, bullets, score labels. Give them a sprite, behaviors (how they move) and events (what happens when...). Then place them in scenes.'),
        h('p', { class: 'muted' }, 'Start from a template on the left, or ask Claude: “make a platformer player with the hero sprite and coins that add to the score”.'),
      ));
      return;
    }
    main.append(objectEditor(obj, go));
  };

  const refresh = () => {
    renderList();
    renderMain();
  };
  refresh();
  return refresh;
}

function objectEditor(obj: ObjectType, go: (name: string | null) => void): HTMLElement {
  const g = state.game!;
  const changed = () => state.change();
  /** The parent type with what it inherits itself (variants). */
  const parent = obj.extends ? state.effective(obj.extends) : undefined;
  const variants = state.resolved.lineage;
  const descendants = new Set([...variants].filter(([, line]) => line.includes(obj.name)).map(([n]) => n));
  const el = h('div', { class: 'obj-editor' });
  let animations: string[] = [];

  // ---------------------------------------------------------------- header
  const nameIn = h('input', { type: 'text', value: obj.name, class: 'obj-name-in', spellcheck: false });
  nameIn.addEventListener('change', async () => {
    const to = nameIn.value.trim();
    if (to === obj.name) return;
    if (!GAME_NAME_RE.test(to) || state.object(to)) {
      toast(state.object(to) ? `"${to}" already exists` : 'Invalid name', 'error');
      nameIn.value = obj.name;
      return;
    }
    try {
      await state.flush();
      await gameApi.renameObject(obj.name, to);
      await state.load();
      go(to);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  const usage = h('span', { class: 'muted small' });
  void (async () => {
    let count = 0;
    for (const s of state.scenes) {
      try {
        count += (await gameApi.getScene(s.name)).instances.filter((i) => i.object === obj.name).length;
      } catch { /* ignore */ }
    }
    usage.textContent = count ? `${count} instance${count === 1 ? '' : 's'} in scenes` : 'not placed in any scene yet';
  })();
  el.append(h('header', { class: 'obj-head' },
    nameIn,
    usage,
    iconButton('target', `Find what uses ${obj.name}`, () => void openUsages('object', obj.name), { class: 'icon-btn tiny' }),
    h('span', { class: 'spacer' }),
    obj.extends ? h('a', { class: 'small variant-link', href: `#/objects/${encodeURIComponent(obj.extends)}` }, `↳ variant of ${obj.extends}`) : null,
    h('button', { class: 'small', title: 'A new type based on this one: it inherits everything and keeps only what you change (like a Unity prefab variant)', onclick: async () => {
      const name = await promptText('New variant', `Name of the variant of ${obj.name} (e.g. red_${obj.name}, ${obj.name}_boss)`, uniqueName(`${obj.name}_variant`));
      if (!name) return;
      if (!GAME_NAME_RE.test(name) || state.object(name)) return toast(state.object(name) ? `"${name}" already exists` : 'Invalid name', 'error');
      g.objects.push(normalizeObject({ name, extends: obj.name }));
      changed();
      go(name);
    } }, icon('copy', 14), 'Variant'),
    h('button', { class: 'small', onclick: () => {
      const copy = normalizeObject(JSON.parse(JSON.stringify(obj)));
      copy.name = uniqueName(obj.name + '_copy');
      g.objects.push(copy);
      changed();
      go(copy.name);
    } }, icon('copy', 14), 'Duplicate'),
    h('button', { class: 'small danger', onclick: async () => {
      if (!(await confirmDialog('Delete object type', `Delete "${obj.name}"? Its instances stay in scenes but won't appear in the game.`))) return;
      g.objects.splice(g.objects.indexOf(obj), 1);
      changed();
      go(null);
    } }, icon('trash', 14), 'Delete'),
  ));

  // ---------------------------------------------------------------- appearance
  const preview = h('canvas', { class: 'obj-preview', width: 1, height: 1 });
  const animSel = h('select', {});
  const hbAuto = h('input', { type: 'checkbox', checked: !obj.hitbox });
  const hbIns = (['x', 'y', 'w', 'h'] as const).map((k) => h('input', { type: 'number', class: 'num', value: String(obj.hitbox?.[k] ?? ''), disabled: !obj.hitbox }));
  const offsetIns = (['x', 'y'] as const).map((k) => {
    const inp = h('input', { type: 'number', class: 'num', value: String(obj.spriteOffset?.[k] ?? 0) });
    inp.addEventListener('change', () => {
      const [x, y] = offsetIns.map((field) => Number(field.value) || 0);
      if (x || y) obj.spriteOffset = { x, y };
      else delete obj.spriteOffset;
      changed();
    });
    return inp;
  });
  let frameSize = { w: 16, h: 16 };
  let assetImg: { img: HTMLImageElement; frame: { x: number; y: number; w: number; h: number } } | null = null;

  const drawPreview = () => {
    const scale = Math.max(2, Math.min(8, Math.floor(160 / Math.max(frameSize.w, frameSize.h))));
    preview.width = frameSize.w * scale;
    preview.height = frameSize.h * scale;
    const c = preview.getContext('2d')!;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, preview.width, preview.height);
    if (assetImg) c.drawImage(assetImg.img, assetImg.frame.x, assetImg.frame.y, assetImg.frame.w, assetImg.frame.h, 0, 0, preview.width, preview.height);
    const hb = obj.hitbox ?? parent?.hitbox ?? { x: 0, y: 0, w: frameSize.w, h: frameSize.h };
    c.strokeStyle = '#ff004d';
    c.lineWidth = 2;
    c.strokeRect(hb.x * scale + 1, hb.y * scale + 1, hb.w * scale - 2, hb.h * scale - 2);
  };

  const loadSprite = async () => {
    const a = await state.asset(obj.sprite ?? parent?.sprite);
    clear(animSel);
    animSel.append(h('option', { value: '' }, 'all frames'));
    animations = a?.tags.map((t) => t.name) ?? [];
    if (parent) animSel.firstElementChild!.textContent = `— inherit (${parent.animation ?? 'all frames'}) —`;
    for (const t of animations) animSel.append(h('option', { value: t, selected: t === obj.animation }, t));
    if (a) {
      frameSize = { w: a.width, h: a.height };
      const tag = a.tags.find((t) => t.name === (obj.animation ?? parent?.animation));
      assetImg = { img: a.img, frame: a.frames[tag?.from ?? 0] ?? a.frames[0] };
    } else {
      assetImg = null;
    }
    drawPreview();
    refreshEvents();
  };

  const spriteSel = h('select', { onchange: () => {
    if (spriteSel.value) obj.sprite = spriteSel.value;
    else delete obj.sprite;
    changed();
    void loadSprite();
  } }, h('option', { value: '' }, parent ? `— inherit (${parent.sprite ?? 'none'}) —` : '— none —'), ...state.sprites.map((s) => h('option', { value: s.name, selected: s.name === obj.sprite }, `${s.name} (${s.width}×${s.height})`)));
  if (obj.sprite && !state.sprite(obj.sprite)) spriteSel.prepend(h('option', { value: obj.sprite, selected: true }, `${obj.sprite} (missing)`));
  animSel.addEventListener('change', () => {
    if (animSel.value) obj.animation = animSel.value;
    else delete obj.animation;
    changed();
    void loadSprite();
  });
  hbAuto.addEventListener('change', () => {
    if (hbAuto.checked) delete obj.hitbox;
    else obj.hitbox = { x: 0, y: 0, w: frameSize.w, h: frameSize.h };
    hbIns.forEach((inp, i) => {
      inp.disabled = hbAuto.checked;
      inp.value = obj.hitbox ? String(obj.hitbox[(['x', 'y', 'w', 'h'] as const)[i]]) : '';
    });
    changed();
    drawPreview();
  });
  hbIns.forEach((inp, i) => inp.addEventListener('input', () => {
    if (!obj.hitbox || inp.value === '') return;
    obj.hitbox[(['x', 'y', 'w', 'h'] as const)[i]] = Math.max(i >= 2 ? 1 : -999, Number(inp.value));
    changed();
    drawPreview();
  }));
  const zIn = h('input', { type: 'number', class: 'num', value: String(obj.z ?? 0), oninput: () => { obj.z = Number(zIn.value) || 0; if (!obj.z) delete obj.z; changed(); } });
  // Light and contact shadow (seen in scenes with an atmosphere; the scene editor previews them).
  const hooks = { before: () => {}, changed };
  const lightBox = lightEditor({ ...hooks, get: () => obj.light, set: (v) => { if (v) obj.light = v; else delete obj.light; },
    inherited: parent ? { light: parent.light, from: `inherit from ${obj.extends}` } : undefined });
  const inheritedShadow = parent?.shadow;
  const shadowIn = h('input', { type: 'number', class: 'num', min: '0', step: '1', value: obj.shadow === undefined ? '' : String(obj.shadow),
    placeholder: inheritedShadow !== undefined ? `${inheritedShadow} (inherited)` : 'auto = hitbox width',
    onchange: () => {
      const v = shadowIn.value.trim();
      if (v === '' || !Number.isFinite(Number(v))) delete obj.shadow;
      else obj.shadow = Math.max(0, Math.round(Number(v)));
      changed();
    } });
  const poseSel = h('select', { onchange: () => {
    if (poseSel.value === 'flat' || poseSel.value === 'stand') obj.hdPose = poseSel.value;
    else delete obj.hdPose;
    changed();
  } },
    h('option', { value: '', selected: !obj.hdPose }, 'Automatic'),
    h('option', { value: 'stand', selected: obj.hdPose === 'stand' }, 'Stands up'),
    h('option', { value: 'flat', selected: obj.hdPose === 'flat' }, 'Lies flat'),
  );
  const shapeSel = h('select', { onchange: () => {
    if (shapeSel.value) obj.hdShape = shapeSel.value as NonNullable<typeof obj.hdShape>;
    else delete obj.hdShape;
    changed();
  } },
    h('option', { value: '', selected: !obj.hdShape }, 'Flat sprite'),
    h('option', { value: 'round', selected: obj.hdShape === 'round' }, 'Round'),
    h('option', { value: 'octagon', selected: obj.hdShape === 'octagon' }, 'Octagon'),
    h('option', { value: 'hexagon', selected: obj.hdShape === 'hexagon' }, 'Hexagon'),
    h('option', { value: 'square', selected: obj.hdShape === 'square' }, 'Square, corner forward'),
  );
  const reliefIn = h('input', { type: 'number', class: 'num', min: '0', max: '40', step: '1', value: obj.hdRelief === undefined ? '' : String(obj.hdRelief), placeholder: '0', onchange: () => {
    const v = Math.round(Number(reliefIn.value));
    if (v > 0) obj.hdRelief = Math.min(40, v);
    else delete obj.hdRelief;
    changed();
  } });
  // Wind: seen moving in Play and in the scene editor's game look.
  const swaySet = (amount: string, speed: string, react = swayReactIn.value) => {
    const a = Number(amount);
    if (!(a > 0)) delete obj.sway;
    else {
      const s = Number(speed);
      const r = Number(react);
      obj.sway = { amount: Math.min(24, a), ...(s > 0 && s !== 1 ? { speed: Math.min(5, Math.max(0.1, s)) } : {}), ...(r > 0 ? { react: Math.min(24, r) } : {}) };
    }
    changed();
  };
  const swayIn = h('input', { type: 'number', class: 'num', min: '0', max: '24', step: '1', value: obj.sway ? String(obj.sway.amount) : '',
    placeholder: parent?.sway ? `${parent.sway.amount} (inherited)` : 'none',
    onchange: () => swaySet(swayIn.value, swaySpeedIn.value) });
  const swaySpeedIn = h('input', { type: 'number', class: 'num', min: '0.1', max: '5', step: '0.1', value: obj.sway?.speed !== undefined ? String(obj.sway.speed) : '',
    placeholder: '1', onchange: () => swaySet(swayIn.value, swaySpeedIn.value) });
  const swayReactIn = h('input', { type: 'number', class: 'num', min: '0', max: '24', step: '1', value: obj.sway?.react !== undefined ? String(obj.sway.react) : '',
    placeholder: '0', onchange: () => swaySet(swayIn.value, swaySpeedIn.value) });
  // A sound looping around the instances: fires, fountains.
  const ambientSet = () => {
    if (!ambientSel.value) delete obj.ambientSound;
    else {
      const v = Number(ambientVolIn.value);
      const r = Number(ambientRadiusIn.value);
      obj.ambientSound = { sound: ambientSel.value, ...(ambientVolIn.value !== '' && v >= 0 ? { volume: Math.min(1, v) } : {}), ...(r >= 8 ? { radius: Math.min(4096, r) } : {}) };
    }
    changed();
  };
  const ambientCurrent = obj.ambientSound?.sound ?? '';
  const ambientSel = h('select', { onchange: ambientSet },
    h('option', { value: '', selected: !ambientCurrent }, parent?.ambientSound ? `${parent.ambientSound.sound} (inherited)` : '— none —'),
    ...state.audio.map((a) => h('option', { value: a, selected: a === ambientCurrent }, a)),
    ...(ambientCurrent && !state.audio.includes(ambientCurrent) ? [h('option', { value: ambientCurrent, selected: true }, `${ambientCurrent} (missing)`)] : []));
  const ambientVolIn = h('input', { type: 'number', class: 'num', min: '0', max: '1', step: '0.05', value: obj.ambientSound?.volume !== undefined ? String(obj.ambientSound.volume) : '', placeholder: '0.4', onchange: ambientSet });
  const ambientRadiusIn = h('input', { type: 'number', class: 'num', min: '8', max: '4096', step: '8', value: obj.ambientSound?.radius !== undefined ? String(obj.ambientSound.radius) : '', placeholder: '160', onchange: ambientSet });

  const isText = obj.text !== undefined;
  const textPreviewEl = h('div', { class: 'text-preview' });
  const plainBtn = h('button', { type: 'button', class: 'small', onclick: () => {
    textIn.value = JSON.stringify(textIn.value.trim());
    obj.text = textIn.value;
    changed();
    updateTextPreview();
  } }, 'Use as fixed text');
  const updateTextPreview = () => {
    const r = previewText(textIn.value, obj);
    textIn.classList.toggle('invalid', !!r.error);
    plainBtn.hidden = !looksLikePlainText(textIn.value);
    textPreviewEl.className = `text-preview${r.error ? ' err' : ''}`;
    textPreviewEl.textContent = r.error ? (plainBtn.hidden ? `Error: ${r.error}` : 'Fixed words need quotes, e.g. "GAME OVER".') : `Shows: ${r.text || '(empty)'}`;
  };
  const textIn = h('input', { type: 'text', class: 'expr', value: obj.text ?? '', spellcheck: false, oninput: () => { obj.text = textIn.value; changed(); updateTextPreview(); } });
  const colorIn = h('input', { type: 'color', value: obj.textColor ?? '#ffffff', oninput: () => { obj.textColor = colorIn.value; changed(); } });
  const sizeIn = h('input', { type: 'number', class: 'num', min: '1', max: '8', value: String(obj.textSize ?? 1), oninput: () => { obj.textSize = Math.max(1, Number(sizeIn.value) || 1); changed(); } });
  const hudIn = h('input', { type: 'checkbox', checked: !!obj.hud, onchange: () => { if (hudIn.checked) obj.hud = true; else delete obj.hud; changed(); } });
  const textBox = h('div', { class: 'text-box' },
    h('label', {}, 'Text', textIn),
    h('div', { class: 'text-preview-row' }, textPreviewEl, plainBtn),
    h('p', { class: 'muted small' }, 'Fixed text goes in quotes: ', h('code', {}, '"GAME OVER"'), '. Join values with +: ', h('code', {}, '"Score: " + score'), ' (score is a global variable, see the Game tab). To change the text while playing, use the action Set variable with target ', h('code', {}, 'self.text'), '.'),
    h('div', { class: 'row3' }, h('label', {}, 'Color', colorIn), h('label', {}, 'Size', sizeIn), h('label', { class: 'inline' }, hudIn, 'HUD (fixed on screen)')),
  );
  const textToggle = h('input', { type: 'checkbox', checked: isText, onchange: () => {
    if (textToggle.checked) {
      obj.text = textIn.value || '"TEXT"';
      textIn.value = obj.text;
    } else delete obj.text;
    textBox.hidden = !textToggle.checked;
    changed();
  } });
  textBox.hidden = !isText;
  updateTextPreview();

  el.append(h('div', { class: 'obj-grid' },
    h('div', { class: 'card' },
      h('h3', {}, 'Appearance'),
      h('div', { class: 'appearance' },
        h('div', { class: 'preview-box checker' }, preview),
        h('div', { class: 'form' },
          h('label', { title: 'A variant inherits sprite, hitbox, properties, tags, components and events, and keeps only what you change' }, 'Based on', h('select', { onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v) obj.extends = v;
            else delete obj.extends;
            changed();
            go(obj.name);
          } }, h('option', { value: '' }, '— nothing (standalone type) —'), ...g.objects.filter((o) => o !== obj && !descendants.has(o.name)).map((o) => h('option', { value: o.name, selected: o.name === obj.extends }, o.name)))),
          h('label', {}, 'Sprite', spriteSel),
          h('label', {}, 'Default animation', animSel),
          h('label', { class: 'inline' }, hbAuto, 'Hitbox = whole frame'),
          h('div', { class: 'row4' }, ...hbIns.map((inp, i) => h('label', {}, ['x', 'y', 'width', 'height'][i], inp))),
          h('div', { class: 'row4', title: 'Draws the sprite shifted from the instance position, so a larger canvas keeps the same position and hitbox' }, ...offsetIns.map((inp, i) => h('label', {}, `Sprite offset ${'xy'[i]}`, inp))),
          h('label', {}, 'Draw order (z)', zIn),
          h('label', { title: 'Soft contact shadow under instances in scenes with an atmosphere: width in px. Empty = automatic (hitbox width), 0 = none (rugs, doormats, flowerbeds)' }, 'Shadow width (px)', shadowIn),
          h('label', { title: 'In the 2D-HD perspective: lies on the ground (rugs, decals) or stands up (characters, trees). Automatic = flat when the draw order is below 0' }, '2D-HD pose', poseSel),
          h('label', { title: 'In the 2D-HD perspective, the solid a standing sprite is wrapped on: its width row by row gives the size, so base and capital come out wider than the shaft. For columns, barrels, pillars' }, '2D-HD shape', shapeSel),
          h('label', { title: 'In the 2D-HD perspective, pixels a sprite hung on a wall stands out from it: its outline is extruded. For reliefs and statues in niches' }, '2D-HD relief (px)', reliefIn),
          h('div', { class: 'row4', title: 'The wind bends the sprite when drawn, without new art or frames: the top moves by this many pixels, the foot stays still and the hitbox does not move. Trees want 2-4' }, h('label', {}, 'Wind sway (px)', swayIn), h('label', {}, 'Wind speed', swaySpeedIn), h('label', { title: 'Pixels a character walking through pushes the top aside; it springs back after. Grass and ferns want 2-4. Seen in Play' }, 'Pushed by walkers (px)', swayReactIn)),
          h('div', { class: 'row4', title: 'A sound that loops around every instance of this object (fire, fountain): louder the closer the camera is. Heard in Play' }, h('label', {}, 'Ambient sound', ambientSel), h('label', {}, 'Volume', ambientVolIn), h('label', {}, 'Heard up to (px)', ambientRadiusIn)),
          lightBox,
        ),
      ),
      h('label', { class: 'inline text-toggle' }, textToggle, 'Text object (score, label, timer)'),
      textBox,
    ),
    propertiesCard(obj, changed, () => refreshEvents(), parent),
    behaviorsCard(obj, changed, parent),
  ));

  // ---------------------------------------------------------------- events
  const sheet = h('div', { class: 'event-sheet' });
  el.append(h('div', { class: 'card events-card' },
    h('h3', {}, 'Events ', h('span', { class: 'muted small' }, '— when something happens to an instance of ', h('b', {}, obj.name), ', check the conditions and run the actions. ', h('code', {}, 'self'), ' is this instance, ', h('code', {}, 'other'), ' the one it collided with.')),
    parent?.events.length ? h('p', { class: 'muted small' }, `${parent.events.length} event${parent.events.length === 1 ? '' : 's'} inherited from `, h('a', { href: `#/objects/${encodeURIComponent(obj.extends!)}` }, obj.extends!), ' run first; the ones below are added.') : null,
    sheet,
  ));
  const refreshEvents = renderEventSheet(sheet, () => obj.events, () => sheetContext(obj, animations), changed);
  void loadSprite();
  return el;
}

function propertiesCard(obj: ObjectType, changed: () => void, onKeys: () => void, parent?: ObjectType): HTMLElement {
  const body = h('div', { class: 'props' });
  const parse = parseValue;
  const render = () => {
    clear(body);
    // Inherited properties: shown with the parent's value, overridable.
    for (const [k, v] of Object.entries(parent?.properties ?? {})) {
      if (k in obj.properties) continue;
      body.append(h('div', { class: 'prop-row inherited', title: `Inherited from ${obj.extends}` }, h('code', {}, `self.${k}`), h('span', { class: 'muted small' }, `${JSON.stringify(v)} (inherited)`),
        iconButton('pencil', 'Override for this variant', () => { obj.properties[k] = v; changed(); render(); }, { class: 'icon-btn tiny' })));
    }
    for (const [k, v] of Object.entries(obj.properties)) {
      const valIn = h('input', { type: 'text', title: VALUE_HINT, value: formatValue(v), spellcheck: false, oninput: () => { obj.properties[k] = parse(valIn.value); changed(); } });
      body.append(h('div', { class: 'prop-row' }, h('code', {}, `self.${k}`), valIn, iconButton('close', 'Remove', () => { delete obj.properties[k]; changed(); render(); onKeys(); }, { class: 'icon-btn tiny' })));
    }
    if (!Object.keys(obj.properties).length && !Object.keys(parent?.properties ?? {}).length) body.append(h('p', { class: 'muted small' }, 'Instance variables, e.g. hp = 3, speed = 50. Read and change them in events as self.hp.'));
  };
  render();
  const tagsIn = h('input', { type: 'text', value: (obj.tags ?? []).join(', '), placeholder: parent?.tags?.length ? `+ ${parent.tags.join(', ')} (inherited)` : 'enemy, pickup…', spellcheck: false, onchange: () => {
    const t = normalizeTags(tagsIn.value);
    if (t) obj.tags = t;
    else delete obj.tags;
    tagsIn.value = (obj.tags ?? []).join(', ');
    changed();
  } });
  return h('div', { class: 'card' },
    h('h3', {}, 'Properties'),
    h('label', { class: 'tags-in', title: 'Group tags for scripts: self.hasTag("enemy"), findWithTag("enemy"), raycast/overlap filters, countTag("enemy") in expressions' }, h('span', { class: 'muted small' }, 'Tags'), tagsIn),
    body,
    h('button', { class: 'small', onclick: async () => {
      const name = await promptText('New property', 'Name (e.g. hp)', '');
      if (!name) return;
      if (!GAME_NAME_RE.test(name)) return toast('Invalid name', 'error');
      obj.properties[name] = 0;
      changed();
      render();
      onKeys();
    } }, icon('plus', 13), 'Property'),
  );
}

function behaviorsCard(obj: ObjectType, changed: () => void, parent?: ObjectType): HTMLElement {
  const body = h('div', { class: 'behaviors' });
  const ctx = () => sheetContext(obj, []);
  const inheritedOf = (b: Behavior) => parent?.behaviors.find((x) => behaviorKey(x) === behaviorKey(b));
  const render = () => {
    clear(body);
    // Inherited components the variant doesn't change: listed, with Override.
    for (const pb of parent?.behaviors ?? []) {
      if (obj.behaviors.some((b) => behaviorKey(b) === behaviorKey(pb))) continue;
      const label = pb.type === 'script' ? String(pb.name) : (BEHAVIOR_MAP.get(pb.type)?.label ?? pb.type);
      body.append(h('div', { class: 'behavior inherited-row' },
        h('div', { class: 'behavior-head' }, pb.type === 'script' ? h('span', { class: 'comp-icon' }, '◆') : null, h('strong', {}, label), h('span', { class: 'badge muted-badge' }, `from ${obj.extends}`), h('span', { class: 'spacer' }),
          h('button', { class: 'small ghost', title: 'Change its params for this variant', onclick: () => { obj.behaviors.push(pb.type === 'script' ? { type: 'script', name: String(pb.name) } : { type: pb.type }); changed(); render(); } }, 'Override')),
      ));
    }
    obj.behaviors.forEach((b, i) => {
      const remove = () => { obj.behaviors.splice(i, 1); changed(); render(); };
      const base = inheritedOf(b);
      if (b.type === 'script') {
        body.append(componentCard(b, ctx(), changed, { remove, base, moveUp: i > 0 ? () => { obj.behaviors.splice(i - 1, 0, ...obj.behaviors.splice(i, 1)); changed(); render(); } : undefined }));
        return;
      }
      const spec = BEHAVIOR_MAP.get(b.type);
      body.append(h('div', { class: 'behavior' },
        h('div', { class: 'behavior-head' }, h('strong', {}, spec?.label ?? b.type), h('span', { class: 'badge muted-badge' }, base ? 'override' : 'built-in'), h('span', { class: 'spacer' }), iconButton('close', base ? 'Remove override (back to the inherited one)' : 'Remove behavior', remove, { class: 'icon-btn tiny' })),
        h('p', { class: 'muted small' }, spec?.help ?? 'Unknown behavior'),
        h('div', { class: 'step-editor' }, ...(spec?.params ?? []).map((p) => paramInput(p, b[p.name] ?? base?.[p.name], (v) => { if (base && v === base[p.name]) delete b[p.name]; else b[p.name] = v; changed(); }, ctx()))),
      ));
    });
    if (!obj.behaviors.length) body.append(h('p', { class: 'muted small' }, 'Components give an object its logic: built-in movement (platformer, top-down, patrol, bullet, solid…) or your own script components (scripts/…/Name.js). Run in this order every frame.'));
  };
  const builtIns = BEHAVIORS.filter((b) => b.type !== 'script');
  const addBuiltIn = h('select', { onchange: () => {
    const spec = BEHAVIOR_MAP.get(addBuiltIn.value);
    addBuiltIn.value = '';
    if (!spec) return;
    if (obj.behaviors.some((b) => b.type === spec.type) || parent?.behaviors.some((b) => b.type === spec.type)) return toast(`Already has ${spec.label}`, 'error');
    obj.behaviors.push(defaultStep(spec));
    changed();
    render();
  } }, h('option', { value: '' }, '+ Built-in behavior…'), ...builtIns.map((b) => h('option', { value: b.type }, b.label)));
  const addScript = () => componentPicker('+ Script component…', obj.behaviors.filter((b) => b.type === 'script').map((b) => String(b.name)), (name) => {
    obj.behaviors.push({ type: 'script', name });
    changed();
    render();
    picker.replaceWith((picker = addScript()));
  });
  let picker = addScript();
  render();
  return h('div', { class: 'card' }, h('h3', {}, 'Components'), body, h('div', { class: 'add-row' }, picker, addBuiltIn));
}
