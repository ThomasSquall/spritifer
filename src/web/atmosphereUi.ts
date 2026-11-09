/**
 * Editor controls for the scene atmosphere (ambient light, glow, contact shadows, cloud shadows, color grade,
 * vignette, ambient particles) and for lights of object types and instances. Same fields as the MCP tools
 * (update_scene atmosphere, set_object light/shadow, update_instances light).
 */

import { type LightDef, MOTE_PRESETS, type SceneAtmosphere, type SceneMotes } from '../core/game/types.js';
import { clear, h } from './dom.js';

/** `before` runs once at the start of each edit gesture (undo snapshot); `changed` after every change. */
export interface EditHooks {
  before(): void;
  changed(): void;
}

const HEX6 = /^#[0-9a-f]{6}$/i;
/** A value an <input type=color> accepts ("#rgb" expanded, alpha dropped). */
function colorValue(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  let s = c.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((ch) => ch + ch).join('');
  s = '#' + s.slice(0, 6);
  return HEX6.test(s) ? s.toLowerCase() : fallback;
}

const round = (v: number) => Math.round(v * 100) / 100;

/** A labelled range with its value; `onInput` fires while dragging (one undo step per drag). */
function slider(label: string, value: number, min: number, max: number, step: number, hooks: EditHooks, onInput: (v: number) => void, title?: string): HTMLElement {
  const out = h('span', { class: 'slider-val' }, String(round(value)));
  let armed = false;
  const inp = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    oninput: () => {
      if (!armed) { hooks.before(); armed = true; }
      const v = Number(inp.value);
      out.textContent = String(round(v));
      onInput(v);
      hooks.changed();
    },
    onchange: () => { armed = false; },
  });
  return h('label', { class: 'slider-row', title }, h('span', { class: 'slider-head' }, label, out), inp);
}

function colorField(label: string, value: string | undefined, fallback: string, hooks: EditHooks, onInput: (v: string) => void, title?: string): HTMLElement {
  let armed = false;
  const inp = h('input', { type: 'color', value: colorValue(value, fallback),
    oninput: () => {
      if (!armed) { hooks.before(); armed = true; }
      onInput(inp.value);
      hooks.changed();
    },
    onchange: () => { armed = false; },
  });
  return h('label', { title }, label, inp);
}

function numberField(label: string, value: number | undefined, placeholder: string, hooks: EditHooks, onSet: (v: number | undefined) => void, attrs: Record<string, unknown> = {}): HTMLElement {
  const inp = h('input', { type: 'number', class: 'num', value: value === undefined ? '' : String(value), placeholder, ...attrs,
    onchange: () => {
      hooks.before();
      onSet(inp.value.trim() === '' || !Number.isFinite(Number(inp.value)) ? undefined : Number(inp.value));
      hooks.changed();
    },
  });
  return h('label', {}, label, inp);
}

// ---------------------------------------------------------------------------------------------- atmosphere

/** Starting points for a scene's look (the same values a designer would type in the fields). */
export const ATMOSPHERE_PRESETS: { name: string; atm: SceneAtmosphere }[] = [
  { name: 'Plain daylight', atm: { ambient: '#ffffff' } },
  { name: 'Warm day', atm: { ambient: '#fff4e6', glow: 0.6, vignette: 0.22, tint: '#ffcf8a', tintAmount: 0.12, motes: { preset: 'dust', count: 14 } } },
  { name: 'Golden hour', atm: { ambient: '#ffe2c4', glow: 0.7, vignette: 0.35, tint: '#ff9a5a', tintAmount: 0.2, motes: { preset: 'dust', count: 12 } } },
  { name: 'Overcast', atm: { ambient: '#d6dcf0', glow: 0.6, vignette: 0.3, tint: '#8090c0', tintAmount: 0.1 } },
  { name: 'Forest shade', atm: { ambient: '#a2acd0', glow: 0.8, vignette: 0.42, tint: '#4070b0', tintAmount: 0.14, motes: { preset: 'fireflies', count: 26 } } },
  { name: 'Dusk', atm: { ambient: '#8a7ab8', glow: 0.8, vignette: 0.4, tint: '#c070a0', tintAmount: 0.14, motes: { preset: 'fireflies', count: 14 } } },
  { name: 'Night', atm: { ambient: '#3a3c70', glow: 0.9, vignette: 0.5, tint: '#3050a0', tintAmount: 0.16, motes: { preset: 'fireflies', count: 20 } } },
  { name: 'Cave', atm: { ambient: '#463c60', glow: 0.9, vignette: 0.6, motes: { preset: 'spores', count: 16 } } },
  { name: 'Interior', atm: { ambient: '#e6d2c4', glow: 0.6, vignette: 0.5, tint: '#ffb070', tintAmount: 0.14, shadowOpacity: 0.45, motes: { preset: 'dust', count: 10 } } },
  { name: 'Snow', atm: { ambient: '#e2eaff', glow: 0.6, vignette: 0.25, tint: '#80a0ff', tintAmount: 0.12, motes: { preset: 'snow', count: 50 } } },
  { name: 'Lava', atm: { ambient: '#5c2c3c', glow: 1, vignette: 0.5, tint: '#ff6020', tintAmount: 0.16, motes: { preset: 'embers', count: 40 } } },
  { name: 'Underwater', atm: { ambient: '#6aa0c8', glow: 0.7, vignette: 0.45, tint: '#2080c0', tintAmount: 0.2, motes: { preset: 'bubbles', count: 24 } } },
];

const DEFAULT_SUN = { angle: -125, elevation: 48, color: '#ffe2b0', intensity: 1, shade: '#6470b8' };

const MOTE_LABELS: Record<SceneMotes['preset'], string> = {
  fireflies: 'Fireflies', dust: 'Dust motes', snow: 'Snow', embers: 'Embers', leaves: 'Falling leaves', spores: 'Glowing spores', bubbles: 'Bubbles',
};

export interface AtmosphereEditorOptions extends EditHooks {
  get(): SceneAtmosphere | undefined;
  set(v: SceneAtmosphere | undefined): void;
  /** Sprite names for the cloud shadows. */
  sprites(): string[];
  /** Re-render after a structural change (preset, on/off, clouds on/off). */
  rerender?(): void;
}

/** The "Atmosphere" section of the scene settings. */
export function atmosphereEditor(o: AtmosphereEditorOptions): HTMLElement {
  const box = h('div', { class: 'atm-editor' });
  const render = () => {
    clear(box);
    const atm = o.get();
    const enable = h('input', { type: 'checkbox', checked: !!atm, onchange: () => {
      o.before();
      o.set(enable.checked ? { ...ATMOSPHERE_PRESETS[1].atm } : undefined);
      o.changed();
      render();
      o.rerender?.();
    } });
    box.append(h('div', { class: 'panel-title atm-title' }, h('label', { class: 'inline', title: 'Lighting and mood: darker ambient light lets lamps, fires and crystals glow, plus soft shadows, drifting clouds, a color grade, a vignette and floating particles' }, enable, 'Atmosphere')));
    if (!atm) {
      box.append(h('p', { class: 'muted small' }, 'Off: the scene is drawn flat, lights are ignored. Turn it on for lighting, shadows, clouds, color grade and particles.'));
      return;
    }
    // Update in place: a field that clears itself (amount 0, no clouds) deletes its key.
    const put = <K extends keyof SceneAtmosphere>(k: K, v: SceneAtmosphere[K] | undefined) => {
      if (v === undefined) delete atm[k];
      else atm[k] = v;
    };
    const presetSel = h('select', { onchange: () => {
      const p = ATMOSPHERE_PRESETS.find((x) => x.name === presetSel.value);
      presetSel.value = '';
      if (!p) return;
      o.before();
      // Keep the scene's own clouds and shadow settings.
      const keep: SceneAtmosphere = { clouds: atm.clouds, shadows: atm.shadows, shadowColor: atm.shadowColor };
      for (const k of Object.keys(atm) as (keyof SceneAtmosphere)[]) delete atm[k];
      Object.assign(atm, JSON.parse(JSON.stringify(p.atm)));
      for (const [k, v] of Object.entries(keep)) if (v !== undefined && !(k in p.atm)) (atm as Record<string, unknown>)[k] = v;
      o.changed();
      render();
    } }, h('option', { value: '' }, 'Apply a preset…'), ...ATMOSPHERE_PRESETS.map((p) => h('option', { value: p.name }, p.name)));

    // Lighting.
    const lighting = h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, 'Light'),
      h('div', { class: 'row2' },
        colorField('Ambient', atm.ambient, '#ffffff', o, (v) => put('ambient', v), 'Multiplied over the world: white = plain day, warm white = afternoon, blue-violet = dusk, dark blue = night or caves. Lights cut through it.'),
        slider('Glow', atm.glow ?? 0.6, 0, 2, 0.05, o, (v) => put('glow', v), 'Bloom the lights add on top. Only visible when the ambient is darker than white'),
      ),
      h('p', { class: 'muted small' }, 'Lights come from object types and instances (Light field). They show only when the ambient is darker than white.'),
    );

    // Per-pixel light.
    const rf = atm.relief;
    const reliefOn = h('input', { type: 'checkbox', checked: !!rf, onchange: () => {
      o.before();
      put('relief', reliefOn.checked ? {} : undefined);
      o.changed();
      render();
    } });
    const relOpt = <K extends 'strength' | 'bands' | 'rim' | 'lightHeight'>(k: K, v: number, dflt: number) => { if (!rf) return; if (v === dflt) delete rf[k]; else rf[k] = v; };
    const tilesOn = rf ? h('input', { type: 'checkbox', checked: rf.tiles !== false, onchange: () => {
      o.before();
      if (tilesOn!.checked) delete rf.tiles;
      else rf.tiles = false;
      o.changed();
    } }) : null;
    const sun = rf?.sun;
    const sunOn = rf ? h('input', { type: 'checkbox', checked: !!sun, onchange: () => {
      o.before();
      if (sunOn!.checked) rf.sun = { ...DEFAULT_SUN };
      else delete rf.sun;
      o.changed();
      render();
    } }) : null;
    const sunOpt = <K extends 'angle' | 'elevation' | 'intensity'>(k: K, v: number) => { if (sun) sun[k] = v; };
    const relief = h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, h('label', { class: 'inline', title: 'Lights and the sun shape the volumes of the sprites instead of only tinting them. Each sprite\'s depth and glowing colors are set in the sprite editor (Relief, in the Rig & guide panel)' }, reliefOn, 'Relief lighting')),
      rf ? h('div', { class: 'row2' },
        slider('Strength', rf.strength ?? 1, 0, 2, 0.05, o, (v) => relOpt('strength', v, 1), 'How strongly light shapes the sprites'),
        slider('Light steps', rf.bands ?? 4, 0, 16, 1, o, (v) => relOpt('bands', v, 4), 'Bands of light on the sprites: few = painted pixel art, 0 = smooth'),
      ) : null,
      rf ? h('div', { class: 'row2' },
        slider('Rim', rf.rim ?? 0.9, 0, 2, 0.05, o, (v) => relOpt('rim', v, 0.9), 'Light caught on the edges facing it'),
        slider('Light height', rf.lightHeight ?? 0.3, 0.05, 2, 0.05, o, (v) => relOpt('lightHeight', v, 0.3), 'Lower = lamps graze the sprites and shadows get more dramatic'),
      ) : null,
      rf ? h('label', { class: 'inline', title: 'Tiles on solid layers (walls, cliffs, treetops) catch the light too, from the forms painted in them. The ground stays clean' }, tilesOn, 'Walls and treetops') : null,
      rf ? h('label', { class: 'inline', title: 'A directional light for the whole scene, with shadows cast on the ground. Use it as the moon too, with a blue color' }, sunOn, 'Sun') : null,
      sun ? h('div', { class: 'row2' },
        slider('Direction°', sun.angle ?? -135, -180, 180, 5, o, (v) => sunOpt('angle', v), '0 = from the right, 90 = from below, -90 = from above'),
        slider('Elevation°', sun.elevation ?? 50, 5, 90, 1, o, (v) => sunOpt('elevation', v), 'Low sun = long shadows'),
      ) : null,
      sun ? h('div', { class: 'row3 atm-row3' },
        colorField('Sun', sun.color, '#fff0d0', o, (v) => { sun.color = v; }),
        colorField('Shade', sun.shade, '#6a70b0', o, (v) => { sun.shade = v; }, 'Color of the side away from the sun'),
        slider('Intensity', sun.intensity ?? 1, 0, 3, 0.05, o, (v) => sunOpt('intensity', v)),
      ) : null,
    );

    // Shadows.
    const shadowsOn = h('input', { type: 'checkbox', checked: atm.shadows !== false, onchange: () => { o.before(); put('shadows', shadowsOn.checked ? undefined : false); o.changed(); render(); } });
    const shadows = h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, h('label', { class: 'inline', title: 'Soft ellipses under instances: width = the hitbox width, or the object type Shadow field' }, shadowsOn, 'Contact shadows')),
      atm.shadows === false ? null : h('div', { class: 'row2' },
        colorField('Color', atm.shadowColor, '#1a1030', o, (v) => put('shadowColor', v)),
        slider('Opacity', atm.shadowOpacity ?? 0.38, 0, 1, 0.01, o, (v) => put('shadowOpacity', v)),
      ),
    );

    // Clouds.
    const spriteNames = o.sprites();
    const cloudSel = h('select', { onchange: () => {
      o.before();
      if (cloudSel.value) atm.clouds = { ...(atm.clouds ?? { opacity: 0.3, speedX: 7, speedY: 2 }), sprite: cloudSel.value };
      else delete atm.clouds;
      o.changed();
      render();
      o.rerender?.();
    } }, h('option', { value: '' }, '— no clouds —'), ...spriteNames.map((n) => h('option', { value: n, selected: n === atm.clouds?.sprite }, n)));
    if (atm.clouds && !spriteNames.includes(atm.clouds.sprite)) cloudSel.prepend(h('option', { value: atm.clouds.sprite, selected: true }, `${atm.clouds.sprite} (missing)`));
    const cl = atm.clouds;
    const clouds = h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, 'Cloud shadows'),
      h('label', { title: 'A tileable sprite of dark soft blobs on transparent, moved by the wind' }, 'Sprite', cloudSel),
      cl ? h('div', { class: 'row3 atm-row3' },
        slider('Opacity', cl.opacity ?? 0.35, 0, 1, 0.01, o, (v) => { cl.opacity = v; }),
        numberField('Wind x', cl.speedX, '6', o, (v) => { if (v === undefined) delete cl.speedX; else cl.speedX = v; }, { step: '1' }),
        numberField('Wind y', cl.speedY, '2', o, (v) => { if (v === undefined) delete cl.speedY; else cl.speedY = v; }, { step: '1' }),
      ) : null,
    );

    // Color grade and vignette.
    const grade = h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, 'Color grade'),
      h('div', { class: 'row2' },
        colorField('Tint', atm.tint, '#ffcf8a', o, (v) => put('tint', v), 'Soft-light tint over the frame: orange = golden hour, blue = cold'),
        slider('Amount', atm.tint ? (atm.tintAmount ?? 0.3) : 0, 0, 1, 0.01, o, (v) => {
          if (v <= 0) { put('tintAmount', undefined); put('tint', undefined); return; }
          put('tint', atm.tint ?? '#ffcf8a');
          put('tintAmount', v);
        }),
      ),
      h('div', { class: 'row2' },
        colorField('Vignette color', atm.vignetteColor, '#0b0614', o, (v) => put('vignetteColor', v)),
        slider('Vignette', atm.vignette ?? 0, 0, 1, 0.01, o, (v) => put('vignette', v > 0 ? v : undefined), 'Darkens the screen edges'),
      ),
    );

    // Particles: a function because a scene can have two kinds at once.
    const moteGroup = (key: 'motes' | 'motes2', title: string) => {
    const m = atm[key];
    const moteSel = h('select', { onchange: () => {
      o.before();
      if (moteSel.value) atm[key] = { preset: moteSel.value as SceneMotes['preset'], ...(m?.count !== undefined ? { count: m.count } : {}) };
      else delete atm[key];
      o.changed();
      render();
    } }, h('option', { value: '' }, '— none —'), ...MOTE_PRESETS.map((p) => h('option', { value: p, selected: p === m?.preset }, MOTE_LABELS[p])));
    const colorsIn = m ? h('input', { type: 'text', spellcheck: false, placeholder: 'preset colors', value: m.color === undefined ? '' : Array.isArray(m.color) ? m.color.join(', ') : m.color,
      onchange: () => {
        o.before();
        const list = colorsIn!.value.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s));
        if (!list.length) delete m.color;
        else m.color = list.length === 1 ? list[0] : list;
        colorsIn!.value = m.color === undefined ? '' : Array.isArray(m.color) ? m.color.join(', ') : m.color;
        o.changed();
      } }) : null;
    return h('div', { class: 'atm-group' },
      h('div', { class: 'atm-group-title' }, title),
      h('div', { class: 'row2' },
        h('label', {}, 'Kind', moteSel),
        m ? numberField('On screen', m.count, '24', o, (v) => { if (v === undefined) delete m.count; else m.count = Math.max(0, Math.min(400, Math.round(v))); }, { min: '0', max: '400', step: '1' }) : h('span', {}),
      ),
      m ? h('label', { title: 'Comma-separated hex colors (e.g. #a0f0ff, #ffffff); empty = the preset colors' }, 'Colors', colorsIn) : null,
    );
    };

    box.append(h('div', { class: 'form atm-form' }, h('label', {}, 'Preset', presetSel), lighting, relief, shadows, clouds, grade, moteGroup('motes', 'Particles'), moteGroup('motes2', 'More particles')));
  };
  render();
  return box;
}

// ---------------------------------------------------------------------------------------------- lights

export const LIGHT_PRESETS: { name: string; light: LightDef }[] = [
  { name: 'Torch', light: { radius: 56, color: '#ffb060', intensity: 1, flicker: 0.2 } },
  { name: 'Campfire', light: { radius: 80, color: '#ff9040', intensity: 1.1, flicker: 0.25 } },
  { name: 'Street lamp', light: { radius: 64, color: '#ffd9a0', intensity: 0.9, flicker: 0.04 } },
  { name: 'Candle', light: { radius: 28, color: '#ffc070', intensity: 0.8, flicker: 0.3 } },
  { name: 'Crystal', light: { radius: 48, color: '#80d8ff', intensity: 1, pulse: 0.35 } },
  { name: 'Magic', light: { radius: 40, color: '#c090ff', intensity: 1, pulse: 0.3 } },
  { name: 'Lantern (player)', light: { radius: 52, color: '#ffe0a8', intensity: 0.85, flicker: 0.05 } },
];

const describeLight = (l: LightDef | undefined) => (!l || !l.radius ? 'no light' : `${l.radius}px ${l.color ?? '#ffd9a0'}`);

export interface LightEditorOptions extends EditHooks {
  /** The light stored on this type / instance. */
  get(): LightDef | undefined;
  set(v: LightDef | undefined): void;
  /** What applies when nothing is stored: the parent type's light (variants) or the object type's (instances). */
  inherited?: { light: LightDef | undefined; from: string };
  /** Instances can switch their type's light off (stored as radius 0). */
  allowOff?: boolean;
}

/** Light of an object type or of one instance: mode (inherit / none / off / custom) and the light fields. */
export function lightEditor(o: LightEditorOptions): HTMLElement {
  const box = h('div', { class: 'light-editor' });
  type Mode = 'inherit' | 'none' | 'off' | 'custom';
  const render = () => {
    clear(box);
    const cur = o.get();
    const mode: Mode = !cur ? (o.inherited ? 'inherit' : 'none') : cur.radius <= 0 ? 'off' : 'custom';
    const modes: [Mode, string][] = [];
    if (o.inherited) modes.push(['inherit', `— ${o.inherited.from}: ${describeLight(o.inherited.light)} —`]);
    else modes.push(['none', 'No light']);
    if (o.allowOff) modes.push(['off', 'Off on this instance']);
    modes.push(['custom', o.inherited ? 'Custom light' : 'Gives off light']);
    const modeSel = h('select', { onchange: () => {
      o.before();
      const m = modeSel.value as Mode;
      if (m === 'inherit' || m === 'none') o.set(undefined);
      else if (m === 'off') o.set({ radius: 0 });
      else o.set({ ...(o.inherited?.light?.radius ? o.inherited.light : LIGHT_PRESETS[0].light) });
      o.changed();
      render();
    } }, ...modes.map(([v, label]) => h('option', { value: v, selected: v === mode }, label)));
    box.append(h('label', { title: 'A point light. It shows in scenes whose atmosphere has an ambient darker than white' }, 'Light', modeSel));
    if (mode !== 'custom' || !cur) return;
    const l = cur;
    const opt = (k: 'intensity' | 'flicker' | 'pulse', v: number, dflt: number) => { if (v === dflt) delete l[k]; else l[k] = v; };
    const presetSel = h('select', { onchange: () => {
      const p = LIGHT_PRESETS.find((x) => x.name === presetSel.value);
      presetSel.value = '';
      if (!p) return;
      o.before();
      const keepOffset = { x: l.x, y: l.y };
      for (const k of Object.keys(l) as (keyof LightDef)[]) if (k !== 'radius') delete l[k];
      Object.assign(l, p.light);
      if (keepOffset.x !== undefined) l.x = keepOffset.x;
      if (keepOffset.y !== undefined) l.y = keepOffset.y;
      o.changed();
      render();
    } }, h('option', { value: '' }, 'Preset…'), ...LIGHT_PRESETS.map((p) => h('option', { value: p.name }, p.name)));
    box.append(h('div', { class: 'form light-form' },
      h('div', { class: 'row2' },
        numberField('Radius (px)', l.radius, '48', o, (v) => { l.radius = Math.max(1, Math.min(1024, Math.round(v ?? 48))); }, { min: '1', max: '1024', step: '1' }),
        colorField('Color', l.color, '#ffd9a0', o, (v) => { l.color = v; }),
      ),
      h('div', { class: 'row2' },
        slider('Intensity', l.intensity ?? 1, 0, 3, 0.05, o, (v) => opt('intensity', v, 1)),
        h('label', {}, 'Preset', presetSel),
      ),
      h('div', { class: 'row2' },
        slider('Flicker', l.flicker ?? 0, 0, 1, 0.01, o, (v) => opt('flicker', v, 0), 'Fire ~0.2, none for crystals'),
        slider('Pulse', l.pulse ?? 0, 0, 1, 0.01, o, (v) => opt('pulse', v, 0), 'Slow breathing: magic, crystals ~0.3'),
      ),
      h('div', { class: 'row2' },
        numberField('Offset x', l.x, '0', o, (v) => { if (!v) delete l.x; else l.x = v; }, { step: '1' }),
        numberField('Offset y', l.y, '0', o, (v) => { if (!v) delete l.y; else l.y = v; }, { step: '1' }),
      ),
    ));
  };
  render();
  return box;
}
