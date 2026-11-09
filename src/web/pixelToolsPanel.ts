import { type RGBA, parseColor } from '../core/color.js';
import { clearRect, extractRegion, mirror, outline, pasteBitmap, replaceColor, shift, transform } from '../core/draw.js';
import { type Vec, darkestColor, findJaggies, findNoisePixels, fixPixels, formatLintReport, lintBitmap, maskFromBitmap, selout, shadeMask } from '../core/shapes.js';
import { type Bitmap, type Frame, type Layer, type Sprite, celBitmap, compositeFrame, deserializeSprite } from '../core/sprite.js';
import { type VersionSummary, api } from './api.js';
import type { Editor } from './editor.js';
import { clear, h, iconButton, modal, toast } from './dom.js';

type Op = 'flip_h' | 'flip_v' | 'rotate_180' | 'rotate_cw' | 'rotate_ccw';
type Half = 'left_to_right' | 'right_to_left' | 'top_to_bottom' | 'bottom_to_top';

const LIGHTS: [string, Vec][] = [['Top left', [-1, -1]], ['Top', [0, -1]], ['Top right', [1, -1]], ['Left', [-1, 0]], ['Right', [1, 0]], ['Bottom left', [-1, 1]], ['Bottom', [0, 1]], ['Bottom right', [1, 1]]];

/**
 * Operations on existing pixels, the ones Claude has as MCP tools: transform, mirror, outline, replace_color, shade,
 * selout, cleanup, lint, copy_region, versions and silhouette_check.
 */
export function mountPixelTools(ed: Editor): { el: HTMLElement; render: () => void } {
  const scope = h('select', { 'data-k': 'px-scope', title: 'Frames the operation works on' },
    h('option', { value: 'frame' }, 'This frame'), h('option', { value: 'range' }, 'Selected frames'), h('option', { value: 'all' }, 'All frames'));
  const layers = h('select', { 'data-k': 'px-layers', title: 'Layers the operation works on' },
    h('option', { value: 'layer' }, 'This layer'), h('option', { value: 'all' }, 'All layers'));
  const areaIns = (['x', 'y', 'w', 'h'] as const).map((k) => h('input', { type: 'number', class: 'num tiny-num', placeholder: k, 'data-k': `px-area-${k}`, title: 'Area in canvas pixels; empty = the whole canvas' }));

  const framesOf = (s: Sprite): Frame[] => {
    if (scope.value === 'all') return s.frames;
    if (scope.value === 'range' && ed.range) return s.frames.slice(ed.range[0], ed.range[1] + 1);
    return [s.frames[ed.frame]];
  };
  const layersOf = (s: Sprite): Layer[] => (layers.value === 'all' ? s.layers : [s.layers.find((l) => l.id === ed.layerId) ?? s.layers[s.layers.length - 1]]);
  const eachCel = (s: Sprite, fn: (b: Bitmap) => number | void): number => {
    let n = 0;
    for (const f of framesOf(s)) for (const l of layersOf(s)) n += fn(celBitmap(s, l.id, f.id)) || 0;
    return n;
  };
  /** The area typed in the panel, kept inside the canvas. */
  const area = (s: Sprite) => {
    const [x, y, w, hh] = areaIns.map((i) => (i.value.trim() === '' ? null : Math.round(Number(i.value))));
    if (x === null && y === null && w === null && hh === null) return undefined;
    const rx = Math.max(0, x ?? 0);
    const ry = Math.max(0, y ?? 0);
    const width = Math.min(s.width - rx, w ?? s.width);
    const height = Math.min(s.height - ry, hh ?? s.height);
    if (width <= 0 || height <= 0) throw new Error('The area is outside the canvas');
    return { x: rx, y: ry, width, height };
  };
  const apply = (fn: (s: Sprite) => number | void, done?: (n: number) => string) => {
    let n = 0;
    const err = ed.tryEdit((s) => { n = fn(s) || 0; });
    if (err) toast(err.message, 'error');
    else if (done) toast(done(n));
  };
  const opaque = (c: string, what: string): RGBA => {
    if (c === 'transparent') throw new Error(`Pick a ${what} color first`);
    return parseColor(c);
  };
  const button = (label: string, title: string, onclick: () => void) => h('button', { type: 'button', class: 'small', title, onclick }, label);
  const card = (title: string, ...children: (Node | null)[]) => h('details', { class: 'card anim-card' }, h('summary', {}, title), ...children);

  // ---------------------------------------------------------------- transform & mirror
  const tf = (op: Op) => apply((s) => { const r = area(s); eachCel(s, (b) => transform(b, op, r)); });
  const dx = h('input', { type: 'number', class: 'num tiny-num', value: '0', 'data-k': 'px-dx', title: 'Pixels to the right (negative = left)' });
  const dy = h('input', { type: 'number', class: 'num tiny-num', value: '0', 'data-k': 'px-dy', title: 'Pixels down (negative = up)' });
  const wrap = h('input', { type: 'checkbox', title: 'Pixels leaving one side come back on the other' });
  const doShift = () => apply((s) => {
    const r = area(s);
    const [mx, my] = [Math.round(Number(dx.value) || 0), Math.round(Number(dy.value) || 0)];
    eachCel(s, (b) => {
      if (!r) return shift(b, mx, my, wrap.checked);
      const part = extractRegion(b, r);
      clearRect(b, r);
      pasteBitmap(b, part, r.x + mx, r.y + my, 'over');
    });
  });
  const halves: [Half, string][] = [['left_to_right', 'Left → right'], ['right_to_left', 'Right → left'], ['top_to_bottom', 'Top → bottom'], ['bottom_to_top', 'Bottom → top']];
  const halfSel = h('select', { 'data-k': 'px-half' }, ...halves.map(([v, t]) => h('option', { value: v }, t)));

  // ---------------------------------------------------------------- outline & recolor
  const diagonals = h('input', { type: 'checkbox', title: 'Also outline diagonally (thicker look)' });

  // ---------------------------------------------------------------- shade & clean
  const rampSel = h('select', { 'data-k': 'px-ramp', title: 'Ramp to shade with (the Ramps section of the palette)' });
  const modeSel = h('select', { title: 'Cel: bands along the light. Form: rounded volume' }, h('option', { value: 'cel' }, 'Cel'), h('option', { value: 'form' }, 'Form'));
  const lightSel = h('select', { 'data-k': 'px-light', title: 'Where the light comes from' }, ...LIGHTS.map(([t], i) => h('option', { value: String(i) }, t)));
  const onlyPrimary = h('input', { type: 'checkbox', title: 'Shade only the pixels of the primary color (one material)' });
  const rimChk = h('input', { type: 'checkbox', title: 'Form: reflected light on the shadow-side edge' });
  const fraction = (placeholder: string, title: string) => h('input', { type: 'number', class: 'num tiny-num', min: '0', max: '1', step: '0.05', placeholder, title });
  const shadowIn = fraction('.35', 'Fraction of the form in shadow');
  const deepIn = fraction('.12', 'Fraction in core shadow on the far edge');
  const highIn = fraction('.18', 'Fraction lit');
  const optional = (i: HTMLInputElement) => (i.value.trim() === '' ? undefined : Number(i.value));
  const light = (): Vec => LIGHTS[Number(lightSel.value)][1];
  const allRamps = (s: Sprite) => Object.values(s.ramps).map((r) => r.map((c) => parseColor(c)));

  const doShade = () => apply((s) => {
    const colors = s.ramps[rampSel.value];
    if (!colors) throw new Error('Create a ramp first (Ramps, under the palette)');
    const only = onlyPrimary.checked ? [opaque(ed.primary, 'primary')] : undefined;
    const r = area(s);
    return eachCel(s, (b) => {
      const m = maskFromBitmap(b, only);
      if (r) for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) if (x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) m.data[y * m.width + x] = 0;
      return shadeMask(b, m, { ramp: colors.map((c) => parseColor(c)), light: light(), mode: modeSel.value as 'cel' | 'form', rim: rimChk.checked, shadow: optional(shadowIn), deep: optional(deepIn), highlight: optional(highIn) });
    });
  }, (n) => `Shaded ${n} pixel(s)`);

  const useLine = h('input', { type: 'checkbox', title: 'Off: the darkest color of the cel is the outline' });
  const lineOf = (b: Bitmap) => (useLine.checked ? opaque(ed.primary, 'primary') : darkestColor(b));
  const doSelout = () => apply((s) => eachCel(s, (b) => { const line = lineOf(b); return line ? selout(b, line, allRamps(s), light()) : 0; }), (n) => `Recolored ${n} outline pixel(s)`);
  const jaggiesChk = h('input', { type: 'checkbox', checked: true });
  const orphansChk = h('input', { type: 'checkbox' });
  const doCleanup = () => apply((s) => eachCel(s, (b) => {
    let n = 0;
    if (jaggiesChk.checked) { const line = lineOf(b); if (line) n += fixPixels(b, findJaggies(b, line)); }
    if (orphansChk.checked) n += fixPixels(b, findNoisePixels(b));
    return n;
  }), (n) => `Fixed ${n} pixel(s)`);
  const report = (title: string, text: string, extra?: Node) => void modal(title, () => h('div', { class: 'form' }, h('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0' }, text), extra ?? h('span', {})), { wide: true });
  const doLint = () => report(`Lint · frame ${ed.frame}`, formatLintReport(lintBitmap(compositeFrame(ed.sprite, ed.frame))));

  // ---------------------------------------------------------------- copy from
  const srcSprite = h('select', { 'data-k': 'px-source', title: 'Sprite to copy from' });
  const srcFrame = h('input', { type: 'number', class: 'num tiny-num', min: '0', value: '0', title: 'Frame of the source' });
  const srcLayer = h('input', { type: 'text', placeholder: 'all visible', spellcheck: false, title: 'Layer name of the source; empty = all visible layers together' });
  const toX = h('input', { type: 'number', class: 'num tiny-num', value: '0', 'data-k': 'px-to-x' });
  const toY = h('input', { type: 'number', class: 'num tiny-num', value: '0', 'data-k': 'px-to-y' });
  const flipChk = h('input', { type: 'checkbox' });
  const replaceChk = h('input', { type: 'checkbox', title: 'Off: transparent source pixels leave the destination as it is' });
  const doCopy = async () => {
    try {
      await ed.flush();
      const from = srcSprite.value && srcSprite.value !== ed.sprite.name ? deserializeSprite(await api.get(srcSprite.value)) : ed.sprite;
      const f = from.frames[Math.max(0, Math.min(from.frames.length - 1, Number(srcFrame.value) || 0))];
      const lname = srcLayer.value.trim();
      const l = lname ? from.layers.find((x) => x.name === lname) : undefined;
      if (lname && !l) throw new Error(`No layer "${lname}" in ${from.name}`);
      const source = l ? celBitmap(from, l.id, f.id) : compositeFrame(from, from.frames.indexOf(f));
      const part = extractRegion(source, area(from) ?? { x: 0, y: 0, width: from.width, height: from.height });
      const piece: Bitmap = { ...part, data: new Uint8ClampedArray(part.data) };
      if (flipChk.checked) transform(piece, 'flip_h');
      apply((s) => eachCel(s, (b) => pasteBitmap(b, piece, Math.round(Number(toX.value) || 0), Math.round(Number(toY.value) || 0), replaceChk.checked ? 'replace' : 'over')));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  // ---------------------------------------------------------------- versions
  const versionList = h('div', { class: 'row-col', 'data-k': 'px-versions' });
  const refreshVersions = async () => {
    let list: VersionSummary[];
    try {
      list = await api.versions(ed.sprite.name);
    } catch (err) {
      return toast((err as Error).message, 'error');
    }
    clear(versionList);
    if (!list.length) versionList.append(h('p', { class: 'muted small' }, 'No versions yet.'));
    const best = list.filter((v) => v.iou >= 0).sort((x, y) => y.iou - x.iou || x.advice - y.advice)[0];
    for (const v of list.slice(0, 12)) {
      versionList.append(h('div', { class: 'row-inline' },
        h('span', { class: 'small' }, v.time),
        h('span', { class: 'muted small' }, v.iou >= 0 ? `${v.iou}%${v === best ? ' ← best' : ''}` : 'manual'),
        h('div', { class: 'spacer' }),
        iconButton('undo', 'Restore this version (the current state is saved first)', () => void restore(v.id), { class: 'icon-btn tiny' }),
      ));
    }
  };
  const restore = async (id: string) => {
    try {
      await ed.flush();
      await api.restoreVersion(ed.sprite.name, id);
      void refreshVersions();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const saveVersion = async () => {
    try {
      await ed.flush();
      await api.saveVersion(ed.sprite.name);
      toast('Version saved');
      void refreshVersions();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const checkBtn = h('button', { type: 'button', class: 'small', 'data-k': 'px-silhouette', title: 'Compare the art with the reference picture: overlap, what to add or trim, values and colors. Saves a scored version', onclick: () => void silhouette() }, 'Check against reference');
  const silhouette = async () => {
    try {
      await ed.flush();
      const r = await api.silhouette(ed.sprite.name, ed.frame);
      void refreshVersions();
      report(`Reference check · frame ${ed.frame}`, r.summary, h('img', { src: `data:image/png;base64,${r.png}`, alt: 'Reference, art and difference', style: 'max-width:100%;image-rendering:pixelated' }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const versionsCard = card('Versions & reference check',
    h('div', { class: 'row-inline wrap' }, button('Save version', 'Keep the current state: it survives restarts, unlike undo', () => void saveVersion()), checkBtn),
    versionList,
  );
  versionsCard.addEventListener('toggle', () => { if (versionsCard.open) void refreshVersions(); });

  const el = h('section', { class: 'dock-section' },
    h('div', { class: 'panel-title' }, 'Pixel tools'),
    h('div', { class: 'dock-body form' },
      h('div', { class: 'row-inline wrap' }, scope, layers),
      h('div', { class: 'row-inline wrap' }, h('span', { class: 'muted small' }, 'Area'), ...areaIns),
      card('Flip, rotate, shift',
        h('div', { class: 'row-inline wrap' },
          button('Flip H', 'Flip horizontally', () => tf('flip_h')),
          button('Flip V', 'Flip vertically', () => tf('flip_v')),
          button('180°', 'Rotate 180°', () => tf('rotate_180')),
          button('90° ↻', 'Rotate clockwise (the area must be square)', () => tf('rotate_cw')),
          button('90° ↺', 'Rotate counter-clockwise (the area must be square)', () => tf('rotate_ccw')),
        ),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'x', dx), h('label', { class: 'inline small' }, 'y', dy), h('label', { class: 'inline small' }, wrap, 'Wrap'), button('Shift', 'Move the pixels', doShift)),
        h('div', { class: 'row-inline wrap' }, halfSel, button('Mirror', 'Copy one half onto the other, mirrored', () => apply((s) => { eachCel(s, (b) => mirror(b, halfSel.value as Half)); }))),
      ),
      card('Outline & recolor',
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, diagonals, 'Diagonals'), button('Outline', 'Outline what is drawn, in the primary color', () => apply((s) => { const c = opaque(ed.primary, 'primary'); return eachCel(s, (b) => outline(b, c, diagonals.checked)); }, (n) => `Outlined ${n} pixel(s)`))),
        h('div', { class: 'row-inline wrap' }, button('Primary → secondary', 'Replace the primary color with the secondary one', () => apply((s) => eachCel(s, (b) => replaceColor(b, parseColor(ed.primary), parseColor(ed.secondary))), (n) => `Replaced ${n} pixel(s)`))),
      ),
      card('Shade & clean',
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Ramp', rampSel), h('label', { class: 'inline small' }, 'Mode', modeSel)),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Light', lightSel), h('label', { class: 'inline small' }, onlyPrimary, 'Primary only'), h('label', { class: 'inline small' }, rimChk, 'Rim')),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Shadow', shadowIn), h('label', { class: 'inline small' }, 'Core', deepIn), h('label', { class: 'inline small' }, 'Lit', highIn), button('Shade', 'Cel-shade the pixels with the ramp', doShade)),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, useLine, 'Primary is the outline'), button('Selout', 'Selective outline: inner lines take a dark shade of their material', doSelout)),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, jaggiesChk, 'Jaggies'), h('label', { class: 'inline small' }, orphansChk, 'Orphans'), button('Clean up', 'Fix L-corners on outlines and isolated noise pixels', doCleanup), button('Lint', 'List pixel-art problems with their coordinates', doLint)),
      ),
      card('Copy pixels from',
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Sprite', srcSprite), h('label', { class: 'inline small' }, 'frame', srcFrame)),
        h('label', { class: 'inline small' }, 'Layer', srcLayer),
        h('p', { class: 'muted small' }, 'The Area above is the part of the source to copy.'),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'to x', toX), h('label', { class: 'inline small' }, 'y', toY), h('label', { class: 'inline small' }, flipChk, 'Flip'), h('label', { class: 'inline small' }, replaceChk, 'Replace'), button('Paste', 'Paste into the chosen frames and layers', () => void doCopy())),
      ),
      versionsCard,
    ),
  );

  let knownSprites = false;
  const render = () => {
    const names = Object.keys(ed.sprite.ramps);
    if ([...rampSel.options].map((o) => o.value).join() !== names.join()) {
      const cur = rampSel.value;
      clear(rampSel);
      rampSel.append(...names.map((n) => h('option', { value: n, selected: n === cur }, n)));
    }
    checkBtn.disabled = !ed.sprite.reference;
    if (!knownSprites) {
      knownSprites = true;
      void api.list().then((list) => {
        clear(srcSprite);
        srcSprite.append(h('option', { value: '' }, 'this sprite'), ...list.filter((x) => x.name !== ed.sprite.name).map((x) => h('option', { value: x.name }, x.name)));
      }).catch(() => { knownSprites = false; });
    }
  };
  return { el, render };
}
