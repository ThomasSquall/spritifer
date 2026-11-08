import { checkAnimation, formatAnimReport, renderMotionMap } from '../core/animCheck.js';
import { ANIMS, ANIM_DEFAULTS, ANIM_STYLES, type AnimName, type AnimStyle, type Ease, type Keyframe } from '../core/animate.js';
import { extractRegion } from '../core/draw.js';
import { type PlacedPart, ensureRig, layoutPose, limbChain, lowerSegmentName, partDepth, renderPose, resolveView, restPose, rigFacings, topoParts, viewBitmap, viewKey } from '../core/rig.js';
import { animateRig, keyframeRig, movePivot, poseFrames, removeRigPart, renameRigPart, reparentPart, setPartPose, setRigFinish, setRigPart, splitLimb } from '../core/rigEdit.js';
import { type Bitmap, type Facing, type PartPose, type Pose, type RigPart, FACINGS, celBitmap, compositeFrame } from '../core/sprite.js';
import type { CanvasInteraction, CanvasMetrics, CanvasView, FPoint } from './canvas.js';
import type { Editor } from './editor.js';
import { clear, confirmDialog, h, icon, iconButton, modal, promptText, toast } from './dom.js';
import { keepFocus } from './panelUtil.js';
import './spriteTools.css';

const OPPOSITE: Partial<Record<Facing, Facing>> = { left: 'right', right: 'left' };
const EASES: Ease[] = ['inout', 'linear', 'in', 'out', 'step'];
const PART_NAMES = ['body', 'head', 'arm_r', 'arm_l', 'forearm_r', 'forearm_l', 'leg_r', 'leg_l', 'shin_r', 'shin_l', 'foot_r', 'foot_l', 'weapon', 'shield', 'cape', 'hair', 'tail', 'shadow'];

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Character rig panel (create_character, rig_part, rig_remove_part, rig_pose, rig_animate, rig_keyframes, rig_preview):
 * parts tree, per-facing drawings (pivot, at, z, parent, variants), the current frame's pose with on-canvas dragging,
 * and the animation generators. Every change re-bakes the rig layer and goes through the editor's undo history.
 */
export function mountRig(ed: Editor, view: CanvasView): { el: HTMLElement; render: (kind?: string) => void } {
  let selected: string | null = null;
  let viewFacing: Facing = 'down';
  let viewVariant = '';
  let lastFrame = -1;
  let rotateMode = false;
  let keepPivotArt = true;
  let cutRect: Rect | null = null;
  let cutTarget: { name?: string; variant?: string } = {};
  let hoverPx: [number, number] | null = null;
  const gen = { anim: 'walk' as AnimName, facings: new Set<Facing>(), frames: '', strength: '1', duration: '', style: 'normal' as AnimStyle, tag: '' };
  let checkTag = '';
  const kf = { name: '', facing: '' as Facing | '', frames: '', loop: false, duration: '100', keys: [] as { src: number; at: number; ease: Ease }[], gap: '2' };

  const body = h('div', { class: 'dock-body' });
  const showBtn = iconButton('eye', 'Show pivots and the selected part on the canvas', () => { ed.rigShow = !ed.rigShow; ed.emit('view'); }, { class: 'icon-btn tiny' });
  const el = h('section', { class: 'dock-section rig-section' },
    h('div', { class: 'panel-title' }, 'Rig', h('div', { class: 'spacer' }), showBtn),
    body,
  );

  const s = () => ed.sprite;
  const frame = () => s().frames[ed.frame];
  const pose = (): Pose | undefined => frame()?.pose;
  const shownPose = (): Pose => pose() ?? restPose(viewFacing);
  const part = (name: string | null): RigPart | undefined => (name ? s().rig?.parts.find((p) => p.name === name) : undefined);

  // ---------------------------------------------------------------- geometry

  /** Part-local pixel under a canvas pixel (inverse of drawRotated). */
  const toLocal = (q: PlacedPart, cx: number, cy: number): [number, number] => {
    const a = ((((q.rot % 360) + 360) % 360) * Math.PI) / 180;
    const right = Math.abs(Math.round(q.rot / 90) * 90 - q.rot) < 0.5 && q.sx === 1 && q.sy === 1;
    const cos = right ? Math.round(Math.cos(a)) : Math.cos(a);
    const sin = right ? Math.round(Math.sin(a)) : Math.sin(a);
    const ox = cx - q.px;
    const oy = cy - q.py;
    const pv = q.view!.pivot;
    return [Math.floor((ox * cos + oy * sin) / q.sx + pv[0] + 0.5), Math.floor((-ox * sin + oy * cos) / q.sy + pv[1] + 0.5)];
  };

  const hitPart = (p: FPoint): PlacedPart | null => {
    const cx = Math.floor(p[0]);
    const cy = Math.floor(p[1]);
    const placed = layoutPose(s(), shownPose()).map((q, i) => ({ q, i })).filter(({ q }) => q.view && !q.hidden);
    placed.sort((a, b) => b.q.z - a.q.z || b.i - a.i);
    for (const { q } of placed) {
      const [lx, ly] = toLocal(q, cx, cy);
      const b = q.view!.bmp;
      if (lx < 0 || ly < 0 || lx >= b.width || ly >= b.height) continue;
      if (b.data[(ly * b.width + lx) * 4 + 3]) return q;
    }
    return null;
  };

  const corners = (q: PlacedPart): [number, number][] => {
    const a = (q.rot * Math.PI) / 180;
    const pv = q.view!.pivot;
    const b = q.view!.bmp;
    const wx = q.px + 0.5;
    const wy = q.py + 0.5;
    return [[0, 0], [b.width, 0], [b.width, b.height], [0, b.height]].map(([x, y]) => {
      const lx = (x - pv[0] - 0.5) * q.sx;
      const ly = (y - pv[1] - 0.5) * q.sy;
      return [wx + lx * Math.cos(a) - ly * Math.sin(a), wy + lx * Math.sin(a) + ly * Math.cos(a)];
    });
  };

  // ---------------------------------------------------------------- canvas interactions

  let poseDrag: { name: string; start: FPoint; pp: PartPose; cx: number; cy: number; rotate: boolean; moved: boolean } | null = null;
  const poseMode: CanvasInteraction = {
    cursor: 'grab',
    down: (p, e) => {
      const f = frame();
      if (!f?.pose) {
        toast('This frame has no pose yet: pick a facing in the Pose section');
        return true;
      }
      const hit = hitPart(p);
      const q = hit ?? layoutPose(s(), f.pose).find((x) => x.part.name === selected);
      if (!q) return true;
      selected = q.part.name;
      ed.checkpoint();
      poseDrag = { name: q.part.name, start: p, pp: { ...(f.pose.parts[q.part.name] ?? {}) }, cx: q.px + 0.5, cy: q.py + 0.5, rotate: rotateMode || e.shiftKey, moved: false };
      render();
      return true;
    },
    move: (p, e) => {
      const d = poseDrag;
      const f = frame();
      if (!d || !f?.pose) return;
      const next: PartPose = { ...d.pp };
      if (d.rotate) {
        const a0 = Math.atan2(d.start[1] - d.cy, d.start[0] - d.cx);
        const a1 = Math.atan2(p[1] - d.cy, p[0] - d.cx);
        let deg = (d.pp.rot ?? 0) + ((a1 - a0) * 180) / Math.PI;
        deg = e.altKey ? Math.round(deg / 15) * 15 : Math.round(deg);
        next.rot = deg;
      } else {
        next.dx = (d.pp.dx ?? 0) + Math.round(p[0] - d.start[0]);
        next.dy = (d.pp.dy ?? 0) + Math.round(p[1] - d.start[1]);
      }
      const cur = f.pose.parts[d.name] ?? {};
      if ((cur.dx ?? 0) === (next.dx ?? 0) && (cur.dy ?? 0) === (next.dy ?? 0) && (cur.rot ?? 0) === (next.rot ?? 0)) return;
      setPartPose(s(), ed.frame, d.name, next);
      d.moved = true;
      ed.emit('pixels');
    },
    up: () => {
      if (poseDrag?.moved) ed.commit('structure');
      else ed.dropCheckpoint();
      poseDrag = null;
    },
  };

  const pivotMode: CanvasInteraction = {
    cursor: 'crosshair',
    down: (p) => {
      const pt = part(selected);
      if (!pt) {
        toast('Select a part first');
        return true;
      }
      const ps = shownPose();
      const q = layoutPose(s(), ps).find((x) => x.part === pt);
      if (!q?.view) {
        toast(`"${pt.name}" has no drawing facing ${ps.facing}`);
        return true;
      }
      if (q.view.mirrored) {
        toast(`"${pt.name}" facing ${ps.facing} is mirrored from ${OPPOSITE[ps.facing]}: set the pivot there`);
        return true;
      }
      const variant = ps.parts[pt.name]?.variant;
      const key = variant && pt.views[viewKey(ps.facing, variant)] ? viewKey(ps.facing, variant) : ps.facing;
      const local = toLocal(q, Math.floor(p[0]), Math.floor(p[1]));
      const err = ed.tryEdit((sp) => movePivot(sp, pt.name, key, local, keepPivotArt));
      if (err) toast(err.message, 'error');
      return true;
    },
    hover: (p) => {
      hoverPx = p ? [Math.floor(p[0]), Math.floor(p[1])] : null;
      view.requestRender();
    },
  };

  let cutStart: [number, number] | null = null;
  const cutMode: CanvasInteraction = {
    cursor: 'crosshair',
    down: (p) => {
      const sp = s();
      cutStart = [Math.max(0, Math.min(sp.width - 1, Math.floor(p[0]))), Math.max(0, Math.min(sp.height - 1, Math.floor(p[1])))];
      cutRect = { x: cutStart[0], y: cutStart[1], width: 1, height: 1 };
      return true;
    },
    move: (p) => {
      if (!cutStart) return;
      const sp = s();
      const x1 = Math.max(0, Math.min(sp.width - 1, Math.floor(p[0])));
      const y1 = Math.max(0, Math.min(sp.height - 1, Math.floor(p[1])));
      cutRect = { x: Math.min(cutStart[0], x1), y: Math.min(cutStart[1], y1), width: Math.abs(x1 - cutStart[0]) + 1, height: Math.abs(y1 - cutStart[1]) + 1 };
    },
    up: () => {
      cutStart = null;
      if (cutRect) void cutDialog(cutRect);
    },
  };

  const setMode = (m: CanvasInteraction | null) => {
    view.interaction = view.interaction === m ? null : m;
    if (view.interaction !== cutMode) cutRect = null;
    if (view.interaction) ed.rigShow = true;
    ed.emit('tool');
  };

  view.overlays.add({
    draw(ctx: CanvasRenderingContext2D, m: CanvasMetrics) {
      const sp = s();
      const z = m.zoom;
      const X = (x: number) => m.ox + x * z;
      const Y = (y: number) => m.oy + y * z;
      if (cutRect) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#feae34';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(X(cutRect.x) + 0.5, Y(cutRect.y) + 0.5, cutRect.width * z - 1, cutRect.height * z - 1);
        ctx.setLineDash([]);
        label(ctx, `${cutRect.width}×${cutRect.height}`, X(cutRect.x), Y(cutRect.y) - 6);
      }
      if (!sp.rig || !ed.rigShow) return;
      const active = view.interaction === poseMode || view.interaction === pivotMode;
      if (!pose() && !active && !selected) return;
      const placed = layoutPose(sp, shownPose());
      for (const q of placed) {
        if (!q.view || q.hidden) continue;
        const sel = q.part.name === selected;
        if (sel) {
          const c = corners(q);
          ctx.beginPath();
          c.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
          ctx.closePath();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#feae34';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const px = X(q.px + 0.5);
        const py = Y(q.py + 0.5);
        const r = sel ? Math.max(3.5, z * 0.3) : Math.max(2, z * 0.18);
        ctx.beginPath();
        ctx.arc(px, py, r + 1.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,16,32,.9)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = sel ? '#ff3df5' : 'rgba(255,61,245,.75)';
        ctx.fill();
        if (sel || (active && z >= 10)) label(ctx, q.part.name, px + r + 4, py - r - 2);
      }
      if (view.interaction === pivotMode && hoverPx) {
        ctx.strokeStyle = '#ff3df5';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(X(hoverPx[0]) + 0.5, Y(hoverPx[1]) + 0.5, z - 1, z - 1);
      }
    },
  });

  // ---------------------------------------------------------------- cut a part out of the art

  async function cutDialog(rect: Rect) {
    const sp = s();
    const rig = sp.rig;
    const parts = rig?.parts ?? [];
    const facing0 = pose()?.facing ?? viewFacing;
    const layer = ed.layer;
    const onRigLayer = rig && layer.id === rig.layer;
    const target = cutTarget;
    cutTarget = {};
    const existingName = target.name ?? (selected && target.variant !== undefined ? selected : undefined);
    const suggestion = PART_NAMES.find((n) => !parts.some((p) => p.name === n)) ?? `part${parts.length + 1}`;
    await modal('Rig part from rectangle', (close) => {
      const nameSel = h('select', {},
        h('option', { value: '' }, 'New part…'),
        ...parts.map((p) => h('option', { value: p.name, selected: p.name === existingName }, p.name)),
      );
      const nameIn = h('input', { type: 'text', value: suggestion, spellcheck: false });
      const nameLabel = h('label', {}, 'New part name', nameIn);
      const facingSel = h('select', {}, ...FACINGS.map((f) => h('option', { value: f, selected: f === facing0 }, f)));
      const variantIn = h('input', { type: 'text', value: target.variant ?? '', placeholder: 'base drawing', spellcheck: false });
      const parentSel = h('select', {}, h('option', { value: '' }, 'none (root)'), ...parts.map((p) => h('option', { value: p.name }, p.name)));
      const sourceSel = h('select', {},
        h('option', { value: 'layer', selected: !onRigLayer }, `Layer “${layer.name}”`),
        h('option', { value: 'composite', selected: !!onRigLayer }, 'All visible layers'),
      );
      const pxIn = h('input', { type: 'number' });
      const pyIn = h('input', { type: 'number' });
      const zIn = h('input', { type: 'number', step: '1' });
      const eraseChk = h('input', { type: 'checkbox' });
      const thumb = h('canvas', { class: 'part-thumb' });
      const note = h('p', { class: 'muted small' });

      const name = () => nameSel.value || nameIn.value.trim();
      const sync = () => {
        const n = name();
        const p = parts.find((x) => x.name === n);
        nameLabel.style.visibility = nameSel.value ? 'hidden' : '';
        const variant = variantIn.value.trim();
        if (p) parentSel.value = p.parent ?? '';
        else parentSel.value = defaultParent(n, parts);
        const prev = p?.views[viewKey(facingSel.value as Facing, variant || undefined)] ?? p?.views[facingSel.value];
        const [dx, dy] = defaultPivot(n, rect);
        pxIn.value = String(prev && !variant ? Math.min(prev.pivot[0], rect.width - 1) : dx);
        pyIn.value = String(prev && !variant ? Math.min(prev.pivot[1], rect.height - 1) : dy);
        // Variants inherit z from the base drawing unless one is typed.
        zIn.value = variant ? (prev && p?.views[viewKey(facingSel.value as Facing, variant)]?.z !== undefined ? String(prev.z) : '') : String(prev?.z ?? defaultZ(n));
        zIn.placeholder = String(p?.views[facingSel.value]?.z ?? defaultZ(n));
        parentSel.disabled = !!variant && !!p;
        pxIn.disabled = pyIn.disabled = !!variant;
        note.textContent = variant
          ? 'A variant uses the base drawing\'s position: its pivot is set so the art stays where it is.'
          : 'The part is placed where the pixels are now ("at" is computed from the pivot and the parent).';
        eraseChk.disabled = sourceSel.value !== 'layer';
      };
      for (const e of [nameSel, facingSel, sourceSel]) e.addEventListener('change', sync);
      variantIn.addEventListener('input', sync);
      nameIn.addEventListener('input', sync);
      sync();

      const sourceBitmap = (): Bitmap => (sourceSel.value === 'composite' ? compositeFrame(sp, ed.frame) : celBitmap(sp, layer.id, sp.frames[ed.frame].id));
      const drawThumb = () => {
        const b = extractRegion(sourceBitmap(), rect);
        const k = Math.max(1, Math.floor(Math.min(96 / b.width, 96 / b.height)));
        thumb.width = b.width * k;
        thumb.height = b.height * k;
        const tmp = document.createElement('canvas');
        tmp.width = b.width;
        tmp.height = b.height;
        tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), 0, 0);
        const g = thumb.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        g.drawImage(tmp, 0, 0, thumb.width, thumb.height);
        if (!variantIn.value.trim()) {
          g.fillStyle = '#ff3df5';
          g.fillRect(Number(pxIn.value) * k, Number(pyIn.value) * k, k, k);
        }
      };
      for (const e of [sourceSel, pxIn, pyIn, variantIn, nameSel, nameIn, facingSel]) e.addEventListener('input', drawThumb);
      drawThumb();

      return h('form', {
        class: 'form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const n = name();
          if (!/^[A-Za-z_][\w-]*$/.test(n)) return toast('Part names use letters, digits, "_" and "-"', 'error');
          const facing = facingSel.value as Facing;
          const variant = variantIn.value.trim() || undefined;
          if (variant && !/^[A-Za-z_][\w-]*$/.test(variant)) return toast('Variant names use letters, digits, "_" and "-"', 'error');
          const err = ed.tryEdit((sx) => {
            const src = sourceSel.value === 'composite' ? compositeFrame(sx, ed.frame) : celBitmap(sx, layer.id, sx.frames[ed.frame].id);
            const bmp = extractRegion(src, rect);
            if (!bmp.data.some((v, i) => i % 4 === 3 && v > 0)) throw new Error('The rectangle has no pixels on this source');
            const r = ensureRig(sx);
            const existing = r.parts.find((p) => p.name === n);
            const parent = variant && existing ? undefined : parentSel.value || null;
            // Make sure the part and its parent exist before computing where it sits.
            if (!existing && variant) throw new Error(`Draw the base "${facing}" drawing of "${n}" before adding a variant`);
            let pivot: [number, number];
            let at: [number, number] | undefined;
            if (variant) {
              const base = layoutPose(sx, restPose(facing)).find((q) => q.part.name === n);
              if (!base?.view) throw new Error(`"${n}" has no "${facing}" drawing to attach the variant to`);
              pivot = [Math.round(base.x) - rect.x, Math.round(base.y) - rect.y];
            } else {
              pivot = [Math.round(Number(pxIn.value) || 0), Math.round(Number(pyIn.value) || 0)];
              const wx = rect.x + pivot[0];
              const wy = rect.y + pivot[1];
              const par = parent ? layoutPose(sx, restPose(facing)).find((q) => q.part.name === parent) : undefined;
              if (parent && !par) throw new Error(`No part named "${parent}"`);
              at = par ? [wx - Math.round(par.x), wy - Math.round(par.y)] : [wx, wy];
            }
            setRigPart(sx, { name: n, facing, variant, parent, bitmap: bmp, pivot, at, z: zIn.value.trim() === '' ? undefined : Number(zIn.value) });
            if (eraseChk.checked && sourceSel.value === 'layer') {
              const cel = celBitmap(sx, layer.id, sx.frames[ed.frame].id);
              for (let y = rect.y; y < rect.y + rect.height; y++) cel.data.fill(0, (y * sx.width + rect.x) * 4, (y * sx.width + rect.x + rect.width) * 4);
            }
          });
          if (err) return toast(err.message, 'error');
          selected = n;
          viewFacing = facing;
          viewVariant = variant ?? '';
          close();
        },
      },
        h('div', { class: 'cut-grid' },
          h('div', { class: 'checker part-thumb-box' }, thumb),
          h('div', { class: 'form' },
            h('div', { class: 'row2' }, h('label', {}, 'Part', nameSel), nameLabel),
            h('div', { class: 'row2' }, h('label', {}, 'Facing', facingSel), h('label', {}, 'Variant (e.g. blink)', variantIn)),
            h('div', { class: 'row2' }, h('label', {}, 'Parent', parentSel), h('label', {}, 'Cut from', sourceSel)),
            h('div', { class: 'row3' }, h('label', {}, 'Pivot x', pxIn), h('label', {}, 'Pivot y', pyIn), h('label', {}, 'z (draw order)', zIn)),
          ),
        ),
        note,
        h('p', { class: 'muted small' }, `Rectangle ${rect.width}×${rect.height} at (${rect.x}, ${rect.y}), frame ${ed.frame}. The pivot is the joint pixel inside the part (magenta).`),
        h('label', { class: 'inline' }, eraseChk, 'Erase these pixels from the layer'),
        h('div', { class: 'actions' }, h('button', { type: 'button', onclick: close }, 'Cancel'), h('button', { class: 'primary', type: 'submit' }, 'Save part')),
      );
    });
    cutRect = null;
    if (view.interaction === cutMode) view.interaction = null;
    ed.emit('tool');
    render();
  }

  // ---------------------------------------------------------------- panel

  function render(kind?: string) {
    // During playback only the header follows; the panel catches up when it stops.
    if (kind === 'view' && (lastFrame === ed.frame || ed.playing)) {
      syncHeader();
      return;
    }
    if (lastFrame !== ed.frame) {
      lastFrame = ed.frame;
      const f = pose()?.facing;
      if (f && f !== viewFacing) {
        viewFacing = f;
        viewVariant = '';
      }
    }
    keepFocus(body, build);
    syncHeader();
  }

  function syncHeader() {
    showBtn.replaceChildren(icon(ed.rigShow ? 'eye' : 'eyeoff', 16));
    showBtn.classList.toggle('active', ed.rigShow && !!s().rig);
    for (const b of body.querySelectorAll<HTMLElement>('[data-mode]')) {
      const m = b.dataset.mode === 'pose' ? poseMode : b.dataset.mode === 'pivot' ? pivotMode : cutMode;
      b.classList.toggle('on', view.interaction === m);
    }
    view.requestRender();
  }

  function modeButton(mode: 'pose' | 'pivot' | 'cut', label: string, title: string, iconName: string, onBefore?: () => void) {
    const m = mode === 'pose' ? poseMode : mode === 'pivot' ? pivotMode : cutMode;
    const b = h('button', { class: `small${view.interaction === m ? ' on' : ''}`, title, onclick: () => { onBefore?.(); setMode(m); } }, icon(iconName, 14), label);
    b.dataset.mode = mode;
    return b;
  }

  function build() {
    clear(body);
    const sp = s();
    const rig = sp.rig;
    if (!rig) {
      body.append(
        h('p', { class: 'muted small' }, 'No rig. A rig turns a character into parts (body, head, arms, legs…) that are posed per frame and baked into a "rig" layer, so animations are pose data instead of redrawn pixels.'),
        h('button', { class: 'small primary', onclick: () => {
          ed.edit((sx) => { ensureRig(sx); });
          ed.layerId = ed.sprite.rig!.layer;
          ed.emit('structure');
          toast('Rig created: draw each part on its own layer, then cut it with "Part from rectangle"');
        } }, icon('rig', 14), 'Create rig'),
      );
      return;
    }
    buildParts(rig.parts);
    const pt = part(selected);
    if (pt) buildPartView(pt);
    buildPose();
    buildAnimate();
    buildTurnaround();
  }

  function buildParts(parts: RigPart[]) {
    const sp = s();
    if (selected && !part(selected)) selected = null;
    const list = h('div', { class: 'part-list' });
    const posed = pose()?.parts ?? {};
    for (const p of topoParts(sp.rig!)) {
      const depth = partDepth(sp.rig!, p);
      list.append(
        h('div', { class: `part-row${p.name === selected ? ' active' : ''}`, style: `padding-left:${6 + depth * 14}px`, onclick: () => { selected = p.name; viewVariant = ''; render(); } },
          depth ? h('span', { class: 'muted tree-mark' }, '└') : null,
          h('span', { class: 'part-name', title: 'Double-click to rename', ondblclick: () => void renamePart(p.name) }, p.name),
          posed[p.name] && Object.keys(posed[p.name]).length ? h('span', { class: 'posed-dot', title: 'Posed in this frame' }) : null,
          h('div', { class: 'spacer' }),
          h('span', { class: 'facing-badges' }, ...FACINGS.map((f) => {
            const own = !!p.views[f];
            const mirrored = !own && !!OPPOSITE[f] && !!p.views[OPPOSITE[f]!];
            return h('span', { class: `fb${own ? ' own' : mirrored ? ' mir' : ''}`, title: `${f}: ${own ? 'drawn' : mirrored ? `mirrored from ${OPPOSITE[f]}` : 'missing'}` }, f[0].toUpperCase());
          })),
        ),
      );
    }
    if (!parts.length) list.append(h('p', { class: 'muted small empty-note' }, 'No parts yet. Draw the character (one layer per part helps), then drag a rectangle around each part.'));
    body.append(
      h('div', { class: 'sub-title' }, `Parts · ${parts.length}`),
      list,
      h('div', { class: 'row-inline wrap' },
        modeButton('cut', 'Part from rectangle', 'Drag a rectangle on the canvas around a part (current layer or all visible layers)', 'crop', () => { cutTarget = {}; }),
      ),
    );
  }

  async function renamePart(name: string) {
    const to = await promptText('Rename part', 'Name', name);
    if (!to || to === name) return;
    if (!/^[A-Za-z_][\w-]*$/.test(to)) return toast('Part names use letters, digits, "_" and "-"', 'error');
    const err = ed.tryEdit((sx) => renameRigPart(sx, name, to));
    if (err) toast(err.message, 'error');
    else if (selected === name) selected = to;
    render();
  }

  function descendantsOf(name: string): Set<string> {
    const out = new Set<string>();
    const walk = (n: string) => {
      for (const p of s().rig!.parts) if (p.parent === n && !out.has(p.name)) { out.add(p.name); walk(p.name); }
    };
    walk(name);
    return out;
  }

  function buildPartView(pt: RigPart) {
    const sp = s();
    const variants = [...new Set(Object.keys(pt.views).filter((k) => k.startsWith(viewFacing + ':')).map((k) => k.split(':')[1]))];
    if (viewVariant && !variants.includes(viewVariant)) viewVariant = '';
    const key = viewKey(viewFacing, viewVariant || undefined);
    const v = pt.views[key];
    const desc = descendantsOf(pt.name);
    const facingSel = h('select', { 'data-k': 'pv-facing', onchange: () => { viewFacing = facingSel.value as Facing; viewVariant = ''; render(); } },
      ...FACINGS.map((f) => h('option', { value: f, selected: f === viewFacing }, f)));
    const variantSel = h('select', { 'data-k': 'pv-variant', onchange: () => { viewVariant = variantSel.value; render(); } },
      h('option', { value: '' }, 'base'), ...variants.map((n) => h('option', { value: n, selected: n === viewVariant }, n)));
    const parentSel = h('select', { 'data-k': 'pv-parent', title: 'The part keeps its place in the rest pose', onchange: () => {
      const err = ed.tryEdit((sx) => reparentPart(sx, pt.name, parentSel.value || null));
      if (err) toast(err.message, 'error');
    } },
      h('option', { value: '' }, 'none (root)'),
      ...sp.rig!.parts.filter((p) => p.name !== pt.name && !desc.has(p.name)).map((p) => h('option', { value: p.name, selected: p.name === pt.parent }, p.name)),
    );

    const box = h('div', { class: 'card part-card' },
      h('div', { class: 'part-card-head' },
        h('strong', {}, pt.name),
        h('div', { class: 'spacer' }),
        iconButton('pencil', 'Rename part', () => void renamePart(pt.name), { class: 'icon-btn tiny' }),
        iconButton('trash', 'Delete part (children move to its parent)', async () => {
          if (!(await confirmDialog('Delete part', `Delete rig part "${pt.name}" and all its drawings? Its children move up to its parent.`))) return;
          const err = ed.tryEdit((sx) => removeRigPart(sx, pt.name));
          if (err) toast(err.message, 'error');
        }, { class: 'icon-btn tiny' }),
      ),
      h('div', { class: 'row2' }, h('label', {}, 'Facing', facingSel), h('label', {}, 'Drawing', variantSel)),
      h('label', {}, 'Parent', parentSel),
      /^(arm|leg)_/.test(pt.name) && !sp.rig!.parts.some((q) => q.name === lowerSegmentName(pt.name))
        ? h('button', { class: 'small', title: 'Cut this limb so it bends at the elbow or knee (and ankle). The rest pose does not change; regenerate the animations afterwards.', onclick: () => {
            const err = ed.tryEdit((sx) => { splitLimb(sx, pt.name); });
            if (err) toast(err.message, 'error');
            else toast(`Split ${pt.name}. Regenerate the animations to use the new joints.`);
          } }, 'Split into segments')
        : null,
    );

    if (v) {
      const num = (k: string, val: number | undefined, placeholder = '') => h('input', { type: 'number', step: '1', value: val === undefined ? '' : String(val), placeholder, 'data-k': k, class: 'num' });
      const pvx = num('pv-px', v.pivot[0]);
      const pvy = num('pv-py', v.pivot[1]);
      const base = pt.views[viewFacing];
      const atx = num('pv-ax', v.at?.[0], viewVariant ? String(base?.at?.[0] ?? 0) : '0');
      const aty = num('pv-ay', v.at?.[1], viewVariant ? String(base?.at?.[1] ?? 0) : '0');
      const zIn = num('pv-z', v.z, viewVariant ? String(base?.z ?? 0) : '0');
      const apply = () => {
        const err = ed.tryEdit((sx) => {
          const pv = sx.rig!.parts.find((x) => x.name === pt.name)!.views[key];
          pv.pivot = [Math.round(Number(pvx.value) || 0), Math.round(Number(pvy.value) || 0)];
          if (atx.value.trim() === '' && aty.value.trim() === '') {
            if (viewVariant) delete pv.at;
            else pv.at = [0, 0];
          } else pv.at = [Math.round(Number(atx.value) || 0), Math.round(Number(aty.value) || 0)];
          if (zIn.value.trim() === '') delete pv.z;
          else pv.z = Number(zIn.value);
          setRigPart(sx, { name: pt.name, facing: viewFacing, variant: viewVariant || undefined });
        });
        if (err) toast(err.message, 'error');
      };
      for (const i of [pvx, pvy, atx, aty, zIn]) i.onchange = apply;
      const thumb = viewThumb(viewBitmap(v), v.pivot);
      box.append(
        h('div', { class: 'part-view' },
          h('div', { class: 'checker part-thumb-box small-thumb', title: `${v.width}×${v.height}, pivot in magenta` }, thumb),
          h('div', { class: 'form grow' },
            h('div', { class: 'row-label' }, h('span', { class: 'muted small' }, 'Pivot'), pvx, pvy),
            h('div', { class: 'row-label' }, h('span', { class: 'muted small', title: pt.parent ? `Offset of the pivot from ${pt.parent}'s pivot` : 'Canvas position of the pivot' }, pt.parent ? 'At (offset)' : 'At (canvas)'), atx, aty),
            h('div', { class: 'row-label' }, h('span', { class: 'muted small' }, 'z'), zIn, h('span', { class: 'muted small' }, `${v.width}×${v.height}`)),
          ),
        ),
        h('div', { class: 'row-inline wrap' },
          modeButton('pivot', 'Set pivot on canvas', 'Click the joint pixel on the canvas (uses the facing shown on the canvas)', 'target'),
          h('label', { class: 'inline small', title: 'Move "at" with the pivot (and children the other way) so nothing shifts in the rest pose' },
            h('input', { type: 'checkbox', checked: keepPivotArt, onchange: (e: Event) => { keepPivotArt = (e.target as HTMLInputElement).checked; } }), 'keep art in place'),
        ),
        h('div', { class: 'row-inline wrap' },
          modeButton('cut', 'Redraw from rectangle', 'Replace this drawing with pixels from a rectangle on the canvas', 'crop', () => { cutTarget = { name: pt.name, variant: viewVariant || undefined }; }),
          h('button', { class: 'small danger', title: 'Delete this drawing only', onclick: async () => {
            if (!(await confirmDialog('Delete drawing', `Delete the "${key}" drawing of "${pt.name}"?`))) return;
            const err = ed.tryEdit((sx) => removeRigPart(sx, pt.name, viewFacing, viewVariant || undefined));
            if (err) toast(err.message, 'error');
            viewVariant = '';
          } }, 'Delete drawing'),
        ),
      );
    } else {
      const mirrored = !viewVariant && OPPOSITE[viewFacing] && pt.views[OPPOSITE[viewFacing]!];
      box.append(
        h('p', { class: 'muted small' }, mirrored ? `Facing ${viewFacing} is mirrored from ${OPPOSITE[viewFacing]}. Draw it to override the mirror.` : `No ${viewFacing} drawing yet.`),
        h('div', { class: 'row-inline' }, modeButton('cut', `Draw ${viewFacing} from rectangle`, 'Drag a rectangle on the canvas', 'crop', () => { cutTarget = { name: pt.name }; })),
      );
    }
    if (pt.views[viewFacing]) {
      box.append(
        h('div', { class: 'row-inline wrap' },
          h('span', { class: 'muted small' }, `Variants: ${variants.join(', ') || 'none'}`),
          h('div', { class: 'spacer' }),
          modeButton('cut', '+ Variant', 'Cut a variant drawing (blink, hurt, fist…) from a rectangle', 'crop', () => {
            cutTarget = { name: pt.name, variant: 'blink' };
          }),
        ),
      );
    }
    body.append(box);
  }

  function buildPose() {
    const sp = s();
    const f = frame();
    const p = pose();
    const facingSel = h('select', { 'data-k': 'pose-facing' }, ...FACINGS.map((x) => h('option', { value: x, selected: x === (p?.facing ?? viewFacing) }, x)));
    const section = h('div', { class: 'card pose-card' }, h('div', { class: 'part-card-head' }, h('strong', {}, `Pose · frame ${ed.frame}`), h('div', { class: 'spacer' }),
      h('button', { class: 'small ghost', title: 'Append a new frame with a rest pose in this facing', onclick: () => {
        const err = ed.tryEdit((sx) => { poseFrames(sx, { new: true, facing: facingSel.value as Facing }); ed.frame = sx.frames.length - 1; ed.range = null; });
        if (err) toast(err.message, 'error');
      } }, '+ Posed frame')));
    if (!p) {
      section.append(
        h('p', { class: 'muted small' }, 'This frame has no pose: its rig layer is not rendered from the rig.'),
        h('div', { class: 'row-inline' }, h('label', { class: 'inline small' }, 'Facing', facingSel),
          h('button', { class: 'small primary', onclick: () => {
            const err = ed.tryEdit((sx) => { poseFrames(sx, { frames: [ed.frame], facing: facingSel.value as Facing }); });
            if (err) toast(err.message, 'error');
          } }, 'Pose this frame')),
      );
      body.append(section);
      return;
    }
    facingSel.onchange = () => {
      const err = ed.tryEdit((sx) => { poseFrames(sx, { frames: [ed.frame], facing: facingSel.value as Facing }); });
      if (err) toast(err.message, 'error');
    };
    section.append(
      h('div', { class: 'row-inline wrap' },
        h('label', { class: 'inline small' }, 'Facing', facingSel),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small ghost', title: 'Back to the rest pose (keeps the facing)', onclick: () => {
          const err = ed.tryEdit((sx) => { poseFrames(sx, { frames: [ed.frame], replace: true, parts: {} }); });
          if (err) toast(err.message, 'error');
        } }, 'Reset pose'),
      ),
      h('div', { class: 'row-inline wrap' },
        modeButton('pose', 'Drag parts', 'Drag a part on the canvas to move it; Shift+drag (or Rotate) turns it around its pivot, Alt snaps to 15°', 'move'),
        h('label', { class: 'inline small' }, h('input', { type: 'checkbox', checked: rotateMode, onchange: (e: Event) => { rotateMode = (e.target as HTMLInputElement).checked; } }), 'Rotate'),
      ),
    );
    const pt = part(selected);
    if (!pt) {
      section.append(h('p', { class: 'muted small' }, 'Select a part (in the list or by dragging it on the canvas) to edit its pose.'));
      body.append(section);
      return;
    }
    const pp: PartPose = p.parts[pt.name] ?? {};
    const variants = [...new Set(Object.keys(pt.views).filter((k) => k.includes(':') && (k.startsWith(p.facing + ':') || (OPPOSITE[p.facing] && k.startsWith(OPPOSITE[p.facing] + ':')))).map((k) => k.split(':')[1]))];
    const n = (k: keyof PartPose, step: string, placeholder: string) => {
      const v = pp[k] as number | undefined;
      return h('input', { type: 'number', step, value: v === undefined ? '' : String(v), placeholder, 'data-k': `pp-${k}`, class: 'num' });
    };
    const dx = n('dx', '1', '0');
    const dy = n('dy', '1', '0');
    const rot = n('rot', '1', '0');
    const sx = n('sx', '0.05', '1');
    const sy = n('sy', '0.05', '1');
    const zIn = n('z', '1', String(resolveView(sp, pt, p.facing, pp.variant)?.z ?? 0));
    const smear = n('smear', '5', '0');
    const smearColor = h('input', { type: 'color', value: pp.smearColor ? pp.smearColor.slice(0, 7) : '#f2f6ff', 'data-k': 'pp-smearColor', title: 'Smear color' });
    const variantSel = h('select', { 'data-k': 'pp-variant' }, h('option', { value: '' }, 'base'), ...variants.map((x) => h('option', { value: x, selected: x === pp.variant }, x)));
    const hideChk = h('input', { type: 'checkbox', checked: !!pp.hide, 'data-k': 'pp-hide' });
    const read = (): PartPose => {
      const num = (i: HTMLInputElement) => (i.value.trim() === '' ? undefined : Number(i.value));
      return {
        dx: num(dx), dy: num(dy), rot: num(rot), sx: num(sx), sy: num(sy), z: num(zIn),
        variant: variantSel.value || undefined, hide: hideChk.checked || undefined,
        smear: num(smear), smearColor: num(smear) ? smearColor.value : undefined,
      };
    };
    const apply = () => {
      const err = ed.tryEdit((s2) => setPartPose(s2, ed.frame, pt.name, read()));
      if (err) toast(err.message, 'error');
    };
    for (const i of [dx, dy, rot, sx, sy, zIn, smear, smearColor, variantSel, hideChk]) i.addEventListener('change', apply);
    const [ra, rb] = ed.range ?? [ed.frame, ed.frame];
    const ikChain = limbChain(sp, p.facing, pt.name);
    const ikX = h('input', { type: 'number', step: '1', placeholder: 'x', 'data-k': 'ik-x', class: 'num' });
    const ikY = h('input', { type: 'number', step: '1', placeholder: 'y', 'data-k': 'ik-y', class: 'num' });
    const ikRow = ikChain
      ? h('div', { class: 'row-inline wrap' },
          h('span', { class: 'muted small', title: `Canvas position for the end of this limb (${ikChain.tip ?? ikChain.lower}). The segments rotate to reach it.` }, 'Reach'), ikX, ikY,
          h('button', { class: 'small', onclick: () => {
            if (ikX.value.trim() === '' || ikY.value.trim() === '') return toast('Enter the x and y to reach', 'error');
            const err = ed.tryEdit((s2) => { poseFrames(s2, { frames: [ed.frame], ik: { [pt.name]: { x: Number(ikX.value), y: Number(ikY.value) } } }); });
            if (err) toast(err.message, 'error');
          } }, 'Solve'))
      : null;
    section.append(
      h('div', { class: 'sub-title' }, `Part “${pt.name}”`),
      ...(ikRow ? [ikRow] : []),
      h('div', { class: 'pose-grid' },
        h('label', {}, 'dx', dx), h('label', {}, 'dy', dy), h('label', {}, 'rot°', rot),
        h('label', {}, 'scale x', sx), h('label', {}, 'scale y', sy), h('label', {}, 'z', zIn),
        h('label', {}, 'smear°', smear), h('label', {}, 'smear color', smearColor), h('label', {}, 'drawing', variantSel),
      ),
      h('div', { class: 'row-inline wrap' },
        h('label', { class: 'inline small' }, hideChk, 'Hide'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'small ghost', onclick: () => { const err = ed.tryEdit((s2) => setPartPose(s2, ed.frame, pt.name, {})); if (err) toast(err.message, 'error'); } }, 'Reset part'),
        ra !== rb ? h('button', { class: 'small', title: 'Copy this part\'s pose to every posed frame of the selected range', onclick: () => {
          const cur = read();
          const err = ed.tryEdit((s2) => { for (let i = ra; i <= rb; i++) if (s2.frames[i].pose) setPartPose(s2, i, pt.name, cur); });
          if (err) toast(err.message, 'error');
        } }, `Apply to ${ra}–${rb}`) : null,
      ),
    );
    body.append(section);
  }

  function buildAnimate() {
    const sp = s();
    const available = rigFacings(sp);
    if (!gen.facings.size) for (const f of available) gen.facings.add(f);
    const animSel = h('select', { 'data-k': 'gen-anim', onchange: () => { gen.anim = animSel.value as AnimName; render(); } }, ...ANIMS.map((a) => h('option', { value: a, selected: a === gen.anim }, a)));
    const loop = ANIM_DEFAULTS[gen.anim].loop;
    const framesIn = h('input', { type: 'number', min: '2', max: '24', value: gen.frames, placeholder: String(ANIM_DEFAULTS[gen.anim].frames), disabled: !loop, 'data-k': 'gen-frames', class: 'num', oninput: () => { gen.frames = framesIn.value; } });
    const strengthIn = h('input', { type: 'number', min: '0.25', max: '3', step: '0.25', value: gen.strength, 'data-k': 'gen-strength', class: 'num', oninput: () => { gen.strength = strengthIn.value; } });
    const durIn = h('input', { type: 'number', min: '1', value: gen.duration, placeholder: 'auto', 'data-k': 'gen-dur', class: 'num', oninput: () => { gen.duration = durIn.value; } });
    const styleSel = h('select', { 'data-k': 'gen-style', title: 'How the character carries its weight', onchange: () => { gen.style = styleSel.value as AnimStyle; } }, ...ANIM_STYLES.map((a) => h('option', { value: a, selected: a === gen.style }, a)));
    const tagIn = h('input', { type: 'text', value: gen.tag, placeholder: '<animation>_<facing>', spellcheck: false, 'data-k': 'gen-tag', title: 'Custom tag name, for a single facing (platformer characters use "run", "jump"...)', oninput: () => { gen.tag = tagIn.value; } });
    const facingChecks = FACINGS.map((f) => h('label', { class: 'inline small', title: available.includes(f) ? '' : 'No art for this facing' },
      h('input', { type: 'checkbox', checked: gen.facings.has(f), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) gen.facings.add(f); else gen.facings.delete(f); } }), f));
    const generate = async () => {
      const facings = FACINGS.filter((f) => gen.facings.has(f));
      if (!(await confirmReuseRest())) return;
      let tags: string[] = [];
      const err = ed.tryEdit((s2) => {
        tags = animateRig(s2, gen.anim, facings, {
          frames: loop && gen.frames ? Math.max(2, Math.min(24, Number(gen.frames))) : undefined,
          strength: gen.strength ? Math.max(0.25, Math.min(3, Number(gen.strength))) : undefined,
          duration: gen.duration ? Math.max(1, Number(gen.duration)) : undefined,
          style: gen.style,
          tag: gen.tag.trim() || undefined,
        });
        const t = s2.tags.find((x) => x.name === tags[0]);
        if (t) { ed.frame = t.from; ed.range = [t.from, t.to]; ed.playTag = t.name; }
      });
      if (err) toast(err.message, 'error');
      else toast(`Generated ${tags.join(', ')}`);
    };

    // Keyframes: key poses taken from existing posed frames, inbetweens interpolated.
    const posedFrames = sp.frames.map((f, i) => (f.pose ? i : -1)).filter((i) => i >= 0);
    kf.keys = kf.keys.filter((k) => sp.frames[k.src]?.pose);
    const kName = h('input', { type: 'text', value: kf.name, placeholder: 'e.g. jump_right', spellcheck: false, 'data-k': 'kf-name', oninput: () => { kf.name = kName.value; } });
    const kFacing = h('select', { 'data-k': 'kf-facing', onchange: () => { kf.facing = kFacing.value as Facing | ''; } },
      h('option', { value: '' }, 'from 1st key'), ...FACINGS.map((f) => h('option', { value: f, selected: f === kf.facing }, f)));
    const kFrames = h('input', { type: 'number', min: '1', max: '64', value: kf.frames, placeholder: 'auto', 'data-k': 'kf-frames', class: 'num', oninput: () => { kf.frames = kFrames.value; } });
    const kDur = h('input', { type: 'number', min: '1', value: kf.duration, 'data-k': 'kf-dur', class: 'num', oninput: () => { kf.duration = kDur.value; } });
    const kLoop = h('input', { type: 'checkbox', checked: kf.loop, onchange: () => { kf.loop = kLoop.checked; } });
    const kGap = h('input', { type: 'number', min: '1', max: '16', value: kf.gap, 'data-k': 'kf-gap', class: 'num', title: 'Frames from one key to the next', oninput: () => { kf.gap = kGap.value; } });
    const keyRows = kf.keys.map((k, i) => {
      const srcSel = h('select', { 'data-k': `kf-src-${i}`, onchange: () => { k.src = Number(srcSel.value); } }, ...posedFrames.map((fi) => h('option', { value: String(fi), selected: fi === k.src }, `frame ${fi}`)));
      const atIn = h('input', { type: 'number', min: '0', value: String(k.at), 'data-k': `kf-at-${i}`, class: 'num', oninput: () => { k.at = Math.max(0, Number(atIn.value) || 0); } });
      const easeSel = h('select', { 'data-k': `kf-ease-${i}`, onchange: () => { k.ease = easeSel.value as Ease; } }, ...EASES.map((e) => h('option', { value: e, selected: e === k.ease }, e)));
      return h('div', { class: 'key-row' }, h('span', { class: 'muted small' }, 'pose of'), srcSel, h('span', { class: 'muted small' }, 'at'), atIn, easeSel,
        iconButton('close', 'Remove key', () => { kf.keys.splice(i, 1); render(); }, { class: 'icon-btn tiny' }));
    });
    const fromRange = () => {
      const [a, b] = ed.range ?? [ed.frame, ed.frame];
      const gap = Math.max(1, Number(kf.gap) || 2);
      const src = posedFrames.filter((i) => i >= a && i <= b);
      if (!src.length) return toast('Select posed frames in the timeline (Shift+click for a range)', 'error');
      kf.keys = src.map((fi, i) => ({ src: fi, at: i * gap, ease: 'inout' as Ease }));
      kf.frames = '';
      if (!kf.name) kf.name = `anim_${sp.frames[src[0]].pose!.facing}`;
      render();
    };
    const buildKeys = async () => {
      if (!kf.keys.length) return toast('Add keys first', 'error');
      if (!(await confirmReuseRest())) return;
      const keys: Keyframe[] = kf.keys.map((k) => ({ frame: k.at, parts: structuredClone(sp.frames[k.src].pose!.parts), ease: k.ease }));
      const lastAt = Math.max(...kf.keys.map((k) => k.at));
      const frames = kf.frames ? Number(kf.frames) : lastAt + 1 + (kf.loop ? Math.max(1, Number(kf.gap) || 2) - 1 : 0);
      const facing = (kf.facing || sp.frames[kf.keys[0].src].pose!.facing) as Facing;
      const name = kf.name.trim();
      if (!name) return toast('Name the animation tag', 'error');
      const err = ed.tryEdit((s2) => {
        keyframeRig(s2, { name, facing, frames, keys, loop: kf.loop, duration: Math.max(1, Number(kf.duration) || 100) });
        const t = s2.tags.find((x) => x.name === name);
        if (t) { ed.frame = t.from; ed.range = [t.from, t.to]; ed.playTag = t.name; }
      });
      if (err) toast(err.message, 'error');
      else toast(`Tag "${name}": ${frames} frame(s)`);
    };

    body.append(
      h('details', { class: 'card anim-card', open: true },
        h('summary', {}, 'Generate animation'),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Animation', animSel), h('label', { class: 'inline small' }, 'frames', framesIn)),
        h('div', { class: 'row-inline wrap' }, ...facingChecks),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'style', styleSel), h('label', { class: 'inline small' }, 'tag', tagIn)),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'strength', strengthIn), h('label', { class: 'inline small' }, 'ms', durIn),
          h('div', { class: 'spacer' }), h('button', { class: 'small primary', onclick: generate }, 'Generate')),
        h('p', { class: 'muted small' }, 'Creates (or replaces) tags "<animation>_<facing>" from key poses, with planted feet when the legs are split. Uses part names body, head, arm_l/r, forearm_l/r, leg_l/r, shin_l/r, foot_l/r, weapon, cape…'),
      ),
      buildFinish(),
      buildMotionCheck(),
      h('details', { class: 'card anim-card', open: kf.keys.length > 0 },
        h('summary', {}, 'Keyframes → inbetweens'),
        h('p', { class: 'muted small' }, 'Pose a few frames as keys, select them in the timeline, then interpolate dx, dy, rot and scale between them.'),
        h('div', { class: 'row-inline wrap' },
          h('button', { class: 'small', onclick: fromRange }, 'Keys from selected frames'),
          h('label', { class: 'inline small' }, 'every', kGap, 'frames'),
          h('button', { class: 'small ghost', onclick: () => { kf.keys.push({ src: posedFrames.includes(ed.frame) ? ed.frame : (posedFrames[0] ?? 0), at: kf.keys.length ? Math.max(...kf.keys.map((k) => k.at)) + (Number(kf.gap) || 2) : 0, ease: 'inout' }); render(); }, disabled: !posedFrames.length }, '+ Key'),
        ),
        ...keyRows,
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Tag', kName), h('label', { class: 'inline small' }, 'facing', kFacing)),
        h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'frames', kFrames), h('label', { class: 'inline small' }, 'ms', kDur), h('label', { class: 'inline small' }, kLoop, 'loop'),
          h('div', { class: 'spacer' }), h('button', { class: 'small primary', onclick: buildKeys, disabled: !kf.keys.length }, 'Build tag')),
      ),
    );
  }

  function buildFinish() {
    const sp = s();
    const cur = sp.rig?.finish ?? {};
    const seams = h('input', { type: 'checkbox', checked: !!cur.seams, 'data-k': 'finish-seams' });
    const close = h('input', { type: 'checkbox', checked: !!cur.closeOutline, 'data-k': 'finish-close' });
    const useColor = h('input', { type: 'checkbox', checked: !!cur.outline, 'data-k': 'finish-use-color', title: 'Off: detected from the drawings' });
    const color = h('input', { type: 'color', value: cur.outline ? cur.outline.slice(0, 7) : '#1a1c2c', 'data-k': 'finish-color', title: 'Outline color' });
    const apply = () => {
      const err = ed.tryEdit((sx) => setRigFinish(sx, { seams: seams.checked, closeOutline: close.checked, outline: useColor.checked ? color.value : undefined }));
      if (err) toast(err.message, 'error');
    };
    for (const i of [seams, close, useColor, color]) i.addEventListener('change', apply);
    return h('details', { class: 'card anim-card', open: !!sp.rig?.finish },
      h('summary', {}, 'Finish'),
      h('p', { class: 'muted small' }, 'Cleans every rendered pose, so the character stops looking like cut-out pieces.'),
      h('div', { class: 'row-inline wrap' },
        h('label', { class: 'inline small', title: 'Removes outline pixels left inside the figure at elbows, knees and ankles' }, seams, 'Clean joints'),
        h('label', { class: 'inline small', title: 'Repaints exposed edges of outlined parts, so rotated limbs keep a closed line' }, close, 'Close outline'),
      ),
      h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, useColor, 'Outline color'), color),
    );
  }

  function buildMotionCheck() {
    const sp = s();
    const here = sp.tags.find((t) => ed.frame >= t.from && ed.frame <= t.to)?.name;
    if (!sp.tags.some((t) => t.name === checkTag)) checkTag = here ?? sp.tags[0]?.name ?? '';
    const tagSel = h('select', { 'data-k': 'check-tag', onchange: () => { checkTag = tagSel.value; } }, ...sp.tags.map((t) => h('option', { value: t.name, selected: t.name === checkTag }, t.name)));
    const run = () => {
      let report;
      try {
        report = checkAnimation(sp, checkTag);
      } catch (e) {
        return toast((e as Error).message, 'error');
      }
      const map = renderMotionMap(sp, report, 6);
      const canvas = h('canvas', { width: map.width, height: map.height, style: 'max-width:100%;image-rendering:pixelated' });
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(map.data), map.width, map.height), 0, 0);
      const legend = h('div', { class: 'row-inline wrap' }, ...report.trails.map((tr) => h('span', { class: 'small', style: `color:rgb(${tr.color.join(',')})` }, `● ${tr.name}`)));
      void modal(`Motion check · ${report.tag}`, () => h('div', { class: 'form' },
        h('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0' }, formatAnimReport(report)),
        canvas,
        legend,
        h('p', { class: 'muted small' }, 'Every frame overlaid, with the path of each joint. A dot marks each frame: bunched dots are slow, spread dots fast. The numbers find defects; only your eye can say it looks good.'),
      ), { wide: true });
    };
    return h('details', { class: 'card anim-card', open: sp.tags.length > 0 },
      h('summary', {}, 'Motion check'),
      h('div', { class: 'row-inline wrap' }, h('label', { class: 'inline small' }, 'Tag', tagSel), h('div', { class: 'spacer' }), h('button', { class: 'small', onclick: run, disabled: !sp.tags.length }, 'Check')),
    );
  }

  /** A fresh character's lone frame is replaced by the first generated animation (as rig_animate does): warn when it holds other art. */
  async function confirmReuseRest(): Promise<boolean> {
    const sp = s();
    if (sp.tags.length || sp.frames.length !== 1) return true;
    const f = sp.frames[0];
    const art = sp.layers.some((l) => l.id !== sp.rig?.layer && sp.cels.get(`${l.id}/${f.id}`)?.some((v, i) => i % 4 === 3 && v > 0));
    if (!art) return true;
    return confirmDialog('Replace frame 0?', 'Frame 0 is replaced by the animation frames, so the art drawn on other layers in it is removed (Undo brings it back). Cut every part into the rig first.', 'Generate');
  }

  function buildTurnaround() {
    const sp = s();
    const facings = rigFacings(sp);
    if (!facings.length) return;
    const row = h('div', { class: 'turnaround' });
    const box = 56;
    const k = Math.max(1, Math.floor(box / Math.max(sp.width, sp.height)));
    for (const f of facings) {
      const ps = restPose(f);
      const bmp = renderPose(sp, ps);
      const c = h('canvas', { class: 'checker' });
      c.width = sp.width * k;
      c.height = sp.height * k;
      const tmp = document.createElement('canvas');
      tmp.width = sp.width;
      tmp.height = sp.height;
      tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(bmp.data), sp.width, sp.height), 0, 0);
      const g = c.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, c.width, c.height);
      g.fillStyle = '#ff3df5';
      for (const q of layoutPose(sp, ps)) if (q.view && !q.hidden) g.fillRect(q.px * k, q.py * k, k, k);
      row.append(h('button', { class: `turn-cell${f === viewFacing ? ' active' : ''}`, title: `Rest pose facing ${f} — click to edit this facing`, onclick: () => { viewFacing = f; viewVariant = ''; render(); } }, c, h('span', { class: 'small muted' }, f)));
    }
    body.append(h('div', { class: 'sub-title' }, 'Turnaround (rest pose)'), row);
  }

  return { el, render };
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number) {
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,16,32,.9)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#e6e8ee';
  ctx.fillText(text, x, y);
}

function viewThumb(b: Bitmap, pivot: [number, number]): HTMLCanvasElement {
  const k = Math.max(1, Math.floor(Math.min(64 / b.width, 64 / b.height)));
  const c = document.createElement('canvas');
  c.width = b.width * k;
  c.height = b.height * k;
  const tmp = document.createElement('canvas');
  tmp.width = b.width;
  tmp.height = b.height;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), 0, 0);
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, 0, c.width, c.height);
  g.strokeStyle = '#ff3df5';
  g.lineWidth = Math.max(1, k / 4);
  g.strokeRect(pivot[0] * k + 0.5, pivot[1] * k + 0.5, k - 1, k - 1);
  return c;
}

function defaultParent(name: string, parts: RigPart[]): string {
  const has = (n: string) => parts.some((p) => p.name === n);
  if (/^(head|arm|cape|cloak|hair|scarf)/.test(name) && has('body')) return 'body';
  if (/^(weapon|sword)/.test(name)) return has('arm_r') ? 'arm_r' : has('arm_l') ? 'arm_l' : '';
  if (/^shield/.test(name)) return has('arm_l') ? 'arm_l' : '';
  if (/^tail/.test(name) && has('body')) return 'body';
  return '';
}

/** Conventional pivots: hips / neck at the bottom center, shoulders / hips at the top center, grip in the middle. */
function defaultPivot(name: string, r: Rect): [number, number] {
  const cx = Math.floor((r.width - 1) / 2);
  if (/^(body|head)/.test(name)) return [cx, r.height - 1];
  if (/^(arm|leg|cape|cloak|hair|scarf|tail|ponytail)/.test(name)) return [cx, 0];
  return [cx, Math.floor((r.height - 1) / 2)];
}

function defaultZ(name: string): number {
  if (/^shadow/.test(name)) return 0;
  if (/^leg/.test(name)) return 1;
  if (/^body/.test(name)) return 2;
  if (/^arm/.test(name)) return 3;
  if (/^head/.test(name)) return 4;
  if (/^(weapon|shield)/.test(name)) return 5;
  return 2;
}
