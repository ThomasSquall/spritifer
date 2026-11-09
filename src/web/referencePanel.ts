import type { Bitmap } from '../core/sprite.js';
import { addLayer, celBitmap } from '../core/sprite.js';
import { type CropRect, attachReference, pixelizeToLayer, preparePicture, referencePixels } from '../core/reference.js';
import { extractPalette } from '../core/shapes.js';
import type { CanvasInteraction, CanvasView } from './canvas.js';
import type { Editor } from './editor.js';
import { h, icon, iconButton, modal, toast } from './dom.js';
import './spriteTools.css';

/**
 * Reference picture (set_reference): top-bar controls to load / crop / scale / place a picture, show it under, over
 * or beside the art with an opacity, and drag it into place. It is stored with the sprite and never exported.
 */
export function mountReferenceControls(ed: Editor, view: CanvasView): { el: HTMLElement; render: () => void } {
  const openBtn = h('button', { class: 'ghost small', title: 'Reference picture: load, crop, scale, place (never exported)', onclick: () => void referenceDialog(ed, view) }, icon('image', 15), 'Reference');
  const showBtn = iconButton('eye', 'Show / hide the reference', () => { ed.refShow = !ed.refShow; ed.emit('view'); });
  const opacityIn = h('input', { type: 'range', min: '5', max: '100', title: 'Reference opacity', class: 'ref-opacity' });
  opacityIn.oninput = () => { ed.refOpacity = Number(opacityIn.value) / 100; view.requestRender(); };
  const modeSel = h('select', { class: 'ref-mode', title: 'Where the reference is drawn', onchange: () => { ed.refMode = modeSel.value as Editor['refMode']; ed.refShow = true; view.fit(); ed.emit('view'); } },
    h('option', { value: 'under' }, 'Under art'),
    h('option', { value: 'over' }, 'Over art'),
    h('option', { value: 'side' }, 'Side by side'),
  );

  // Drag the reference to move it on the canvas.
  let start: { p: [number, number]; x: number; y: number; moved: boolean } | null = null;
  const moveRef: CanvasInteraction = {
    cursor: 'move',
    down: (p) => {
      const ref = ed.sprite.reference;
      if (!ref) return false;
      ed.checkpoint();
      start = { p, x: ref.x, y: ref.y, moved: false };
      return true;
    },
    move: (p) => {
      const ref = ed.sprite.reference;
      if (!start || !ref) return;
      const x = start.x + Math.round(p[0] - start.p[0]);
      const y = start.y + Math.round(p[1] - start.p[1]);
      if (x === ref.x && y === ref.y) return;
      start.moved = true;
      ed.sprite.reference = { ...ref, x, y };
    },
    up: () => {
      if (start?.moved) ed.commit('structure');
      else ed.dropCheckpoint();
      start = null;
    },
  };
  const moveBtn = iconButton('move', 'Drag the reference on the canvas to place it', () => {
    view.interaction = view.interaction === moveRef ? null : moveRef;
    if (view.interaction) { ed.refShow = true; if (ed.refMode === 'side') ed.refMode = 'under'; }
    ed.emit('tool');
  });

  const group = h('span', { class: 'ref-controls' }, openBtn, showBtn, opacityIn, modeSel, moveBtn);

  function render() {
    const has = !!ed.sprite.reference;
    for (const el of [showBtn, opacityIn, modeSel, moveBtn]) el.style.display = has ? '' : 'none';
    showBtn.replaceChildren(icon(ed.refShow ? 'eye' : 'eyeoff'));
    showBtn.classList.toggle('active', has && ed.refShow);
    opacityIn.value = String(Math.round(ed.refOpacity * 100));
    modeSel.value = ed.refMode;
    moveBtn.classList.toggle('active', view.interaction === moveRef);
    if (!has && view.interaction === moveRef) view.interaction = null;
    openBtn.classList.toggle('has-ref', has);
  }

  return { el: group, render };
}

/** Decodes an image file / blob into RGBA pixels. */
async function decodeImage(blob: Blob): Promise<Bitmap> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  bmp.close();
  return { width: d.width, height: d.height, data: d.data };
}

function bitmapCanvas(b: Bitmap): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = b.width;
  c.height = b.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(b.data), b.width, b.height), 0, 0);
  return c;
}

async function referenceDialog(ed: Editor, view: CanvasView) {
  const s = ed.sprite;
  const stored = s.reference;
  // Without a new picture, the stored one (hi-res copy when available) can be re-cropped, re-scaled or moved.
  let full: Bitmap | null = stored ? (stored.source ? referencePixels({ ...stored, ...stored.source }) : referencePixels(stored)) : null;
  let fromStored = !!stored;
  let crop: CropRect | null = null;

  await modal('Reference picture', (close) => {
    const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden-file' });
    const sourceInfo = h('span', { class: 'muted small' });
    const pick = h('canvas', { class: 'ref-pick' });
    const result = h('canvas', { class: 'ref-result' });
    const resultInfo = h('p', { class: 'muted small' });
    const cx = h('input', { type: 'number', min: '0' });
    const cy = h('input', { type: 'number', min: '0' });
    const cw = h('input', { type: 'number', min: '1' });
    const ch = h('input', { type: 'number', min: '1' });
    const bgChk = h('input', { type: 'checkbox', checked: !stored });
    const tolIn = h('input', { type: 'number', min: '0', max: '160', value: '8' });
    const heightIn = h('input', { type: 'number', min: '1', placeholder: 'fit', value: stored ? String(stored.height) : '' });
    const xIn = h('input', { type: 'number', placeholder: 'center', value: stored ? String(stored.x) : '' });
    const yIn = h('input', { type: 'number', placeholder: 'bottom', value: stored ? String(stored.y) : '' });
    const palIn = h('input', { type: 'number', min: '2', max: '64', placeholder: 'keep palette' });
    const layerIn = h('input', { type: 'text', placeholder: 'none', spellcheck: false });
    const pixChk = h('input', { type: 'checkbox', 'data-k': 'ref-pixelize' });
    const pixColors = h('input', { type: 'number', min: '2', max: '64', placeholder: '24', title: 'Colors extracted from the picture' });
    const pixOwnPal = h('input', { type: 'checkbox', title: 'Use the palette of the sprite instead of extracting one' });
    const pixLayer = h('input', { type: 'text', placeholder: 'pixelized', spellcheck: false, title: 'Layer of frame 0 that receives the result (created if missing, replaced otherwise)' });
    const hiResChk = h('input', { type: 'checkbox', checked: ed.refHiRes, onchange: () => { ed.refHiRes = hiResChk.checked; view.requestRender(); } });

    // Scale of the crop picker preview.
    let k = 1;
    const drawPick = () => {
      const g = pick.getContext('2d')!;
      if (!full) {
        pick.width = 360;
        pick.height = 120;
        g.fillStyle = '#1e2129';
        g.fillRect(0, 0, pick.width, pick.height);
        g.fillStyle = '#8a92a6';
        g.font = '13px system-ui';
        g.textAlign = 'center';
        g.fillText('Choose, drop or paste (Ctrl/⌘+V) an image', pick.width / 2, pick.height / 2 + 4);
        return;
      }
      k = Math.min(440 / full.width, 300 / full.height);
      if (k > 1) k = Math.floor(k);
      pick.width = Math.max(1, Math.round(full.width * k));
      pick.height = Math.max(1, Math.round(full.height * k));
      g.imageSmoothingEnabled = k < 1;
      g.imageSmoothingQuality = 'high';
      g.clearRect(0, 0, pick.width, pick.height);
      g.drawImage(bitmapCanvas(full), 0, 0, pick.width, pick.height);
      if (crop) {
        g.fillStyle = 'rgba(0,0,0,.55)';
        g.beginPath();
        g.rect(0, 0, pick.width, pick.height);
        g.rect(crop.x * k, crop.y * k, crop.width * k, crop.height * k);
        g.fill('evenodd');
        g.strokeStyle = '#feae34';
        g.lineWidth = 1.5;
        g.strokeRect(crop.x * k + 0.5, crop.y * k + 0.5, crop.width * k - 1, crop.height * k - 1);
      }
    };

    const syncCropInputs = () => {
      cx.value = crop ? String(crop.x) : '';
      cy.value = crop ? String(crop.y) : '';
      cw.value = crop ? String(crop.width) : '';
      ch.value = crop ? String(crop.height) : '';
      cx.placeholder = cy.placeholder = '0';
      cw.placeholder = full ? String(full.width) : '';
      ch.placeholder = full ? String(full.height) : '';
    };

    const readCrop = (): CropRect | null => {
      if (!full || (!cw.value && !ch.value && !cx.value && !cy.value)) return null;
      const x = Math.max(0, Math.min(full.width - 1, Math.round(Number(cx.value) || 0)));
      const y = Math.max(0, Math.min(full.height - 1, Math.round(Number(cy.value) || 0)));
      const w = Math.max(1, Math.min(full.width - x, Math.round(Number(cw.value) || full.width - x)));
      const hh = Math.max(1, Math.min(full.height - y, Math.round(Number(ch.value) || full.height - y)));
      return { x, y, width: w, height: hh };
    };

    const numOr = (el: HTMLInputElement) => (el.value.trim() === '' ? undefined : Math.round(Number(el.value)));

    /** What the reference would become, without touching the sprite. */
    const build = () => {
      if (!full) return null;
      const src = preparePicture(full, crop ?? undefined, bgChk.checked, Number(tolIn.value));
      const probe = { ...s, reference: null } as typeof s;
      const placed = attachReference(probe, src, numOr(heightIn), numOr(xIn), numOr(yIn));
      return { src, placed, ref: probe.reference! };
    };

    let previewTimer = 0;
    const updatePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(() => {
        const g = result.getContext('2d')!;
        if (!full) {
          result.width = result.height = 1;
          resultInfo.textContent = '';
          return;
        }
        try {
          const b = build()!;
          const z = Math.max(1, Math.floor(Math.min(200 / s.width, 200 / s.height)));
          result.width = s.width * z;
          result.height = s.height * z;
          g.imageSmoothingEnabled = false;
          g.clearRect(0, 0, result.width, result.height);
          g.drawImage(bitmapCanvas(referencePixels(b.ref)), b.ref.x * z, b.ref.y * z, b.ref.width * z, b.ref.height * z);
          g.strokeStyle = 'rgba(254,174,52,.6)';
          g.strokeRect(0.5, 0.5, result.width - 1, result.height - 1);
          resultInfo.textContent = `${b.placed.w}×${b.placed.h} canvas px at (${b.placed.x}, ${b.placed.y}) on the ${s.width}×${s.height} canvas`;
        } catch (err) {
          resultInfo.textContent = (err as Error).message;
        }
      }, 120);
    };

    const setPicture = (b: Bitmap, label: string) => {
      full = b;
      fromStored = false;
      crop = null;
      heightIn.value = '';
      xIn.value = '';
      yIn.value = '';
      bgChk.checked = true;
      sourceInfo.textContent = `${label} · ${b.width}×${b.height}px`;
      syncCropInputs();
      drawPick();
      updatePreview();
    };

    const loadBlob = async (blob: Blob, label: string) => {
      try {
        setPicture(await decodeImage(blob), label);
      } catch {
        toast('Could not read that image', 'error');
      }
    };

    fileIn.onchange = () => {
      const f = fileIn.files?.[0];
      if (f) void loadBlob(f, f.name);
    };
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (!f) return;
      e.preventDefault();
      void loadBlob(f, 'Pasted image');
    };
    document.addEventListener('paste', onPaste);
    const observer = new MutationObserver(() => {
      if (!pick.isConnected) {
        document.removeEventListener('paste', onPaste);
        observer.disconnect();
      }
    });
    setTimeout(() => observer.observe(document.body, { childList: true }));

    // Drag on the picture to choose the crop.
    let dragFrom: [number, number] | null = null;
    const imgPoint = (e: PointerEvent): [number, number] => {
      const r = pick.getBoundingClientRect();
      const sx = pick.width / r.width;
      return [Math.max(0, Math.min(full!.width, Math.round(((e.clientX - r.left) * sx) / k))), Math.max(0, Math.min(full!.height, Math.round(((e.clientY - r.top) * sx) / k)))];
    };
    pick.addEventListener('pointerdown', (e) => {
      if (!full) return void fileIn.click();
      pick.setPointerCapture(e.pointerId);
      dragFrom = imgPoint(e);
    });
    pick.addEventListener('pointermove', (e) => {
      if (!dragFrom || !full) return;
      const p = imgPoint(e);
      const x = Math.min(p[0], dragFrom[0]);
      const y = Math.min(p[1], dragFrom[1]);
      const w = Math.abs(p[0] - dragFrom[0]);
      const hh = Math.abs(p[1] - dragFrom[1]);
      crop = w >= 2 && hh >= 2 ? { x, y, width: w, height: hh } : null;
      syncCropInputs();
      drawPick();
    });
    pick.addEventListener('pointerup', () => {
      if (!dragFrom) return;
      dragFrom = null;
      updatePreview();
    });
    const dropZone = h('div', { class: 'ref-drop' }, pick);
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) void loadBlob(f, f.name);
    });

    for (const el of [cx, cy, cw, ch]) el.addEventListener('change', () => { crop = readCrop(); drawPick(); updatePreview(); });
    for (const el of [bgChk, tolIn, heightIn, xIn, yIn]) el.addEventListener('change', updatePreview);

    if (stored) sourceInfo.textContent = `Stored reference · ${full!.width}×${full!.height}px (load a new picture to replace it)`;
    syncCropInputs();
    drawPick();
    updatePreview();

    const apply = (e: Event) => {
      e.preventDefault();
      if (!full) return toast('Load a picture first', 'error');
      const pal = numOr(palIn);
      const layerName = layerIn.value.trim();
      const err = ed.tryEdit((sp) => {
        const src = preparePicture(full!, crop ?? undefined, bgChk.checked, Number(tolIn.value));
        const placed = attachReference(sp, src, numOr(heightIn), numOr(xIn), numOr(yIn));
        if (pal) sp.palette = extractPalette(src, Math.max(2, Math.min(64, pal)));
        if (pixChk.checked) pixelizeToLayer(sp, src, { height: placed.h, x: placed.x, y: placed.y, colors: numOr(pixColors), usePalette: pixOwnPal.checked, layer: pixLayer.value.trim() || undefined, keepReference: true });
        if (layerName) {
          const layer = sp.layers.find((l) => l.name === layerName) ?? addLayer(sp, layerName);
          const ref = sp.reference!;
          const px = referencePixels(ref);
          for (const f of sp.frames) {
            const cel = celBitmap(sp, layer.id, f.id);
            cel.data.fill(0);
            for (let y = 0; y < px.height; y++)
              for (let x = 0; x < px.width; x++) {
                const tx = ref.x + x;
                const ty = ref.y + y;
                if (tx < 0 || ty < 0 || tx >= sp.width || ty >= sp.height) continue;
                cel.data.set(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4), (ty * sp.width + tx) * 4);
              }
          }
        }
      });
      if (err) return toast(err.message, 'error');
      ed.refShow = true;
      ed.emit('view');
      close();
    };

    return h('form', { class: 'form ref-form', onsubmit: apply },
      h('div', { class: 'ref-grid' },
        h('div', { class: 'ref-col' },
          h('div', { class: 'row-inline' },
            h('button', { type: 'button', class: 'small', onclick: () => fileIn.click() }, 'Choose image…'),
            fileIn,
            sourceInfo,
          ),
          dropZone,
          h('p', { class: 'muted small' }, 'Drag on the picture to crop one pose. Drop or paste an image to replace it.'),
          h('div', { class: 'row4' }, h('label', {}, 'Crop x', cx), h('label', {}, 'y', cy), h('label', {}, 'width', cw), h('label', {}, 'height', ch)),
          h('div', { class: 'row-inline' },
            h('label', { class: 'inline' }, bgChk, 'Remove background'),
            h('label', { class: 'inline' }, 'tolerance', tolIn),
            h('button', { type: 'button', class: 'small ghost', onclick: () => { crop = null; syncCropInputs(); drawPick(); updatePreview(); } }, 'Reset crop'),
          ),
        ),
        h('div', { class: 'ref-col' },
          h('div', { class: 'checker ref-result-box' }, result),
          resultInfo,
          h('div', { class: 'row3' }, h('label', {}, 'Height (canvas px)', heightIn), h('label', {}, 'x', xIn), h('label', {}, 'y', yIn)),
          h('div', { class: 'row2' }, h('label', {}, 'Palette from picture (colors)', palIn), h('label', {}, 'Also copy into layer', layerIn)),
          h('label', { class: 'inline', title: 'Turn the picture into clean pixel art: colors are reduced, each pixel takes the majority color of its area, outlines are kept' }, pixChk, 'Pixelize it onto a layer'),
          h('div', { class: 'row3' }, h('label', {}, 'Layer', pixLayer), h('label', {}, 'Colors', pixColors), h('label', { class: 'inline' }, pixOwnPal, 'Own palette')),
          h('label', { class: 'inline' }, hiResChk, 'Show the hi-res picture on the canvas (smooth)'),
        ),
      ),
      h('div', { class: 'actions' },
        stored ? h('button', { type: 'button', class: 'danger', onclick: () => { ed.edit((sp) => { sp.reference = null; }); close(); } }, 'Remove reference') : null,
        h('div', { class: 'spacer' }),
        h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'primary', type: 'submit' }, fromStored && stored ? 'Update reference' : 'Set reference'),
      ),
    );
  }, { wide: true });
}
