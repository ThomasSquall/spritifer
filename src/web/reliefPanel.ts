import { buildNormalSheet, resolveRelief, shadeRelief } from '../core/game/relief.js';
import { type Sprite, type SpriteRelief, compositeFrame } from '../core/sprite.js';
import type { Editor } from './editor.js';
import { h, toast } from './dom.js';

const AMBIENT = '#585a78';
const BACKDROP = [42, 44, 64];

/**
 * How the sprite takes per-pixel light (set_relief): flat or shaped, depth, colors that glow by themselves.
 * The preview lights the current frame from wherever the pointer is.
 */
export function mountRelief(ed: Editor): { el: HTMLElement; render: () => void } {
  const canvas = h('canvas', { class: 'checker', style: 'display:block;height:150px;max-width:100%;margin:0 auto;image-rendering:pixelated;cursor:crosshair', title: 'Move the pointer to move the light' });
  let light = { x: -0.15, y: 0.25 };
  const draw = () => {
    const s = ed.sprite;
    const f = compositeFrame(s, ed.frame);
    if (canvas.width !== s.width || canvas.height !== s.height) {
      canvas.width = s.width;
      canvas.height = s.height;
    }
    const normals = buildNormalSheet(f.data, s.width, s.height, [{ x: 0, y: 0, w: s.width, h: s.height }], s.relief?.off ? undefined : s.relief);
    if (s.relief?.off) normals.fill(0);
    const data = new Uint8ClampedArray(f.data.length);
    for (let i = 0; i < data.length; i += 4) {
      const a = f.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) data[i + c] = f.data[i + c] * a + BACKDROP[c] * (1 - a);
      data[i + 3] = 255;
    }
    const frame = { width: s.width, height: s.height, data };
    const radius = Math.hypot(s.width, s.height) * 1.1;
    shadeRelief(frame, normals, resolveRelief({}), AMBIENT, [{ x: light.x * s.width, y: light.y * s.height, radius, color: '#ffe0b0', intensity: 1 }], 0);
    canvas.getContext('2d')!.putImageData(new ImageData(data, s.width, s.height), 0, 0);
  };
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    light = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    draw();
  });

  const apply = (change: (r: SpriteRelief) => void) => {
    const err = ed.tryEdit((sx: Sprite) => {
      const next: SpriteRelief = { ...(sx.relief ?? {}) };
      change(next);
      if (Object.keys(next).length) sx.relief = next;
      else delete sx.relief;
    });
    if (err) toast(err.message, 'error');
  };
  const flat = h('input', { type: 'checkbox', 'data-k': 'relief-off', onchange: () => apply((r) => { if (flat.checked) r.off = true; else delete r.off; }) });
  const depthOut = h('span', { class: 'slider-val' });
  const depth = h('input', { type: 'range', min: '0', max: '3', step: '0.1', 'data-k': 'relief-depth',
    oninput: () => { depthOut.textContent = depth.value; },
    onchange: () => apply((r) => { const v = Number(depth.value); if (v === 1) delete r.depth; else r.depth = v; }),
  });
  const glow = h('input', { type: 'text', spellcheck: false, placeholder: '#80e0ff, #ffffff', 'data-k': 'relief-glow',
    onchange: () => apply((r) => {
      const list = glow.value.split(/[\s,]+/).filter((c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c));
      if (list.length) r.glow = list;
      else delete r.glow;
    }),
  });

  const el = h('section', { class: 'dock-section' },
    h('div', { class: 'panel-title' }, 'Relief'),
    h('div', { class: 'dock-body form' },
      h('div', { class: 'checker' }, canvas),
      h('p', { class: 'muted small' }, 'How per-pixel light shapes this sprite. The volumes come from its pixels; scenes turn it on in their Atmosphere.'),
      h('label', { class: 'inline small', title: 'For rugs, puddles and anything lying on the ground' }, flat, 'Flat'),
      h('label', { class: 'slider-row', title: 'How pronounced the volumes are' }, h('span', { class: 'slider-head' }, 'Depth', depthOut), depth),
      h('label', { title: 'Comma-separated hex colors that are never darkened: crystals, eyes, lava' }, 'Glowing colors', glow),
    ),
  );

  const render = () => {
    const r = ed.sprite.relief ?? {};
    flat.checked = !!r.off;
    const d = String(r.depth ?? 1);
    if (document.activeElement !== depth) {
      depth.value = d;
      depthOut.textContent = d;
    }
    if (document.activeElement !== glow) glow.value = (r.glow ?? []).join(', ');
    draw();
  };
  return { el, render };
}
