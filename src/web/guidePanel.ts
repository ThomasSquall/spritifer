import { STANDARD_JOINTS, editGuide, isDefaultBone, removeBone, renameJoint } from '../core/reference.js';
import type { CanvasInteraction, CanvasMetrics, CanvasView, FPoint } from './canvas.js';
import type { Editor } from './editor.js';
import { clear, confirmDialog, h, icon, iconButton, promptText, toast } from './dom.js';
import { keepFocus } from './panelUtil.js';
import './spriteTools.css';

const SIDE = (n: string) => (/_f$|_front$/.test(n) ? 'f' : /_b$|_back$/.test(n) ? 'b' : '');
export function guideColor(a: string, b = a): string {
  const s = SIDE(a) || SIDE(b);
  return s === 'f' ? '#22e0ff' : s === 'b' ? '#ffa030' : '#ffffff';
}

/**
 * Pose guide (pose_guide): a gesture skeleton drawn over the canvas. In edit mode, click empty space to place the next
 * joint, drag joints to move them (Alt: half-pixel steps), and edit names, positions and bones in the panel.
 */
export function mountGuide(ed: Editor, view: CanvasView): { el: HTMLElement; render: () => void } {
  let selected: string | null = null;
  let hover: string | null = null;
  let nextJoint = '';
  const body = h('div', { class: 'dock-body' });
  const showBtn = iconButton('eye', 'Show / hide the pose guide on the canvas', () => { ed.guideShow = !ed.guideShow; ed.emit('view'); }, { class: 'icon-btn tiny' });
  const editBtn = iconButton('skeleton', 'Edit the guide on the canvas: click to place joints, drag to move them', () => toggleEdit(), { class: 'icon-btn tiny' });
  const el = h('section', { class: 'dock-section' },
    h('div', { class: 'panel-title' }, 'Pose guide', h('div', { class: 'spacer' }), showBtn, editBtn,
      iconButton('trash', 'Clear the guide', async () => {
        if (!ed.sprite.guide) return;
        if (await confirmDialog('Clear pose guide', 'Remove every joint and bone of the pose guide?', 'Clear')) ed.edit((s) => { editGuide(s, { clear: true }); });
      }, { class: 'icon-btn tiny' })),
    body,
  );

  const jointAt = (p: FPoint, m: number): string | null => {
    const g = ed.sprite.guide;
    if (!g) return null;
    let best: string | null = null;
    let bd = Math.max(0.6, 9 / m);
    for (const [name, [x, y]] of Object.entries(g.joints)) {
      const d = Math.hypot(p[0] - (x + 0.5), p[1] - (y + 0.5));
      if (d <= bd) {
        bd = d;
        best = name;
      }
    }
    return best;
  };
  const snap = (v: number, fine: boolean) => (fine ? Math.round((v - 0.5) * 2) / 2 : Math.floor(v));

  let drag: { name: string; moved: boolean } | null = null;
  const interaction: CanvasInteraction = {
    cursor: 'crosshair',
    down: (p, e) => {
      const hit = jointAt(p, view.zoom);
      if (hit) {
        selected = hit;
        ed.checkpoint();
        drag = { name: hit, moved: false };
        render();
        return true;
      }
      if (e.button !== 0) return false;
      const name = nextJoint || missingJoints()[0];
      if (!name) {
        toast('Pick a joint name to place (or add a custom one)');
        return true;
      }
      const err = ed.tryEdit((s) => { editGuide(s, { joints: { [name]: [snap(p[0], e.altKey), snap(p[1], e.altKey)] } }); });
      if (err) toast(err.message, 'error');
      selected = name;
      nextJoint = missingJoints()[0] ?? '';
      render();
      return true;
    },
    move: (p, e) => {
      const g = ed.sprite.guide;
      if (!drag || !g?.joints[drag.name]) return;
      const pos: [number, number] = [snap(p[0], e.altKey), snap(p[1], e.altKey)];
      const cur = g.joints[drag.name];
      if (cur[0] === pos[0] && cur[1] === pos[1]) return;
      g.joints[drag.name] = pos;
      drag.moved = true;
      ed.emit('view');
    },
    up: () => {
      if (drag?.moved) ed.commit('structure');
      else ed.dropCheckpoint();
      drag = null;
    },
    hover: (p) => {
      const hNew = p ? jointAt(p, view.zoom) : null;
      if (hNew !== hover) {
        hover = hNew;
        view.requestRender();
      }
    },
  };

  function toggleEdit() {
    view.interaction = view.interaction === interaction ? null : interaction;
    if (view.interaction) ed.guideShow = true;
    ed.emit('tool');
  }

  view.overlays.add({
    draw(ctx: CanvasRenderingContext2D, m: CanvasMetrics) {
      const g = ed.sprite.guide;
      if (!g || !ed.guideShow) return;
      const editing = view.interaction === interaction;
      const at = (j: [number, number]): [number, number] => [m.ox + (j[0] + 0.5) * m.zoom, m.oy + (j[1] + 0.5) * m.zoom];
      const lw = Math.max(1.5, Math.min(4, m.zoom / 6));
      ctx.lineCap = 'round';
      for (const pass of [0, 1]) {
        for (const [a, b] of g.bones) {
          if (!g.joints[a] || !g.joints[b]) continue;
          const [x0, y0] = at(g.joints[a]);
          const [x1, y1] = at(g.joints[b]);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.strokeStyle = pass ? guideColor(a, b) : 'rgba(20,16,32,.85)';
          ctx.lineWidth = pass ? lw : lw + 2.5;
          ctx.stroke();
        }
      }
      for (const [name, j] of Object.entries(g.joints)) {
        const [x, y] = at(j);
        const r = lw * 1.8 + (name === selected || name === hover ? 2 : 0);
        ctx.beginPath();
        ctx.arc(x, y, r + 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,16,32,.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = guideColor(name);
        ctx.fill();
        if (name === selected && editing) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4, 0, Math.PI * 2);
          ctx.strokeStyle = '#feae34';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (editing || name === hover || m.zoom >= 14) {
          ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(20,16,32,.9)';
          ctx.strokeText(name, x + r + 4, y - r - 2);
          ctx.fillStyle = '#e6e8ee';
          ctx.fillText(name, x + r + 4, y - r - 2);
        }
      }
    },
  });

  function missingJoints(): string[] {
    const g = ed.sprite.guide;
    return STANDARD_JOINTS.filter((n) => !g?.joints[n]);
  }

  function render() {
    keepFocus(body, () => build());
    showBtn.replaceChildren(icon(ed.guideShow ? 'eye' : 'eyeoff', 16));
    showBtn.classList.toggle('active', ed.guideShow && !!ed.sprite.guide);
    editBtn.classList.toggle('active', view.interaction === interaction);
    view.requestRender();
  }

  function build() {
    clear(body);
    const g = ed.sprite.guide;
    const editing = view.interaction === interaction;
    const missing = missingJoints();
    if (nextJoint && g?.joints[nextJoint]) nextJoint = '';
    const nextSel = h('select', { 'data-k': 'guide-next', title: 'Joint placed by the next click on the canvas', onchange: async () => {
      if (nextSel.value === '__custom') {
        const n = await promptText('Custom joint', 'Joint name (e.g. tail_tip, ear_f)');
        nextJoint = n && /^[A-Za-z_][\w-]*$/.test(n) ? n : '';
        if (n && !nextJoint) toast('Joint names use letters, digits, "_" and "-"', 'error');
      } else nextJoint = nextSel.value;
      if (!editing) toggleEdit();
      else render();
    } },
      ...missing.map((n) => h('option', { value: n, selected: n === (nextJoint || missing[0]) }, n)),
      nextJoint && !missing.includes(nextJoint) ? h('option', { value: nextJoint, selected: true }, nextJoint) : null,
      h('option', { value: '__custom' }, 'Custom name…'),
    );
    body.append(
      h('div', { class: 'row-inline' },
        h('button', { class: `small${editing ? ' on' : ''}`, onclick: toggleEdit }, icon('skeleton', 14), editing ? 'Editing on canvas' : 'Edit on canvas'),
        h('label', { class: 'inline small' }, 'Place', nextSel),
      ),
    );
    if (editing) body.append(h('p', { class: 'muted small' }, 'Click empty canvas to place the joint, drag a joint to move it (Alt: half pixels).'));
    if (!g || !Object.keys(g.joints).length) {
      body.append(h('p', { class: 'muted small' }, 'No guide yet. Trace the reference\'s joints (head, neck, pelvis, shoulders, hands, hips, knees, feet) to plan the pose before drawing. "_f" = near side (cyan), "_b" = far side (orange).'));
      return;
    }
    const joints = h('div', { class: 'joint-list' });
    for (const [name, [x, y]] of Object.entries(g.joints)) {
      const xIn = h('input', { type: 'number', step: '0.5', value: String(x), 'data-k': `j-${name}-x`, class: 'num' });
      const yIn = h('input', { type: 'number', step: '0.5', value: String(y), 'data-k': `j-${name}-y`, class: 'num' });
      const upd = () => {
        const err = ed.tryEdit((s) => { editGuide(s, { joints: { [name]: [Number(xIn.value) || 0, Number(yIn.value) || 0] } }); });
        if (err) toast(err.message, 'error');
      };
      xIn.onchange = upd;
      yIn.onchange = upd;
      joints.append(
        h('div', { class: `joint-row${name === selected ? ' active' : ''}`, onclick: () => { selected = name; render(); } },
          h('span', { class: 'dot', style: `background:${guideColor(name)}` }),
          h('span', { class: 'joint-name', title: 'Double-click to rename', ondblclick: async () => {
            const to = await promptText('Rename joint', 'Name', name);
            if (!to || to === name) return;
            const err = ed.tryEdit((s) => renameJoint(s, name, to));
            if (err) toast(err.message, 'error');
            else selected = to;
          } }, name),
          xIn, yIn,
          iconButton('trash', `Delete joint ${name}`, (e) => { e.stopPropagation(); ed.edit((s) => { editGuide(s, { remove: [name] }); }); }, { class: 'icon-btn tiny' }),
        ),
      );
    }
    body.append(joints);

    // Bones: standard ones connect automatically, custom ones are listed and removable.
    const std = g.bones.filter((b) => isDefaultBone(b[0], b[1]));
    const custom = g.bones.filter((b) => !isDefaultBone(b[0], b[1]));
    const names = Object.keys(g.joints);
    const aSel = h('select', { 'data-k': 'bone-a' }, ...names.map((n) => h('option', { value: n }, n)));
    const bSel = h('select', { 'data-k': 'bone-b' }, ...names.map((n, i) => h('option', { value: n, selected: i === 1 }, n)));
    body.append(
      h('div', { class: 'sub-title' }, `Bones · ${std.length} standard`),
      ...custom.map(([a, b]) =>
        h('div', { class: 'bone-row' },
          h('span', { class: 'dot', style: `background:${guideColor(a, b)}` }),
          h('span', {}, `${a} – ${b}`),
          h('div', { class: 'spacer' }),
          iconButton('close', 'Remove bone', () => { const err = ed.tryEdit((s) => removeBone(s, a, b)); if (err) toast(err.message, 'error'); }, { class: 'icon-btn tiny' }),
        ),
      ),
      h('div', { class: 'row-inline' }, aSel, h('span', { class: 'muted' }, '–'), bSel,
        h('button', { class: 'small', onclick: () => {
          if (aSel.value === bSel.value) return toast('Pick two different joints', 'error');
          const err = ed.tryEdit((s) => { editGuide(s, { bones: [[aSel.value, bSel.value]] }); });
          if (err) toast(err.message, 'error');
        } }, 'Add bone')),
    );
  }

  return { el, render };
}
