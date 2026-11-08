import { type ArtBackground, type ArtItem, artContactSheet, cleanArt } from '../core/artImport.js';
import type { Bitmap } from '../core/sprite.js';
import { bytesToBase64 } from '../core/base64.js';
import { api } from './api.js';
import { clear, h, modal, toast } from './dom.js';

interface Piece { name: string; x: number; y: number; width: number; height: number; inset: number; background: ArtBackground; tag: string }

const VIEW_WIDTH = 860;

async function decode(file: File): Promise<Bitmap> {
  const img = await createImageBitmap(file, { premultiplyAlpha: 'none' });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height);
  return { width: d.width, height: d.height, data: d.data };
}

/** Cuts a sheet made by an image generator into pieces, shows them cleaned, and saves them as sprites. */
export function openArtImport(done: (name: string) => void): void {
  void modal('Import AI art', (close) => {
    let picture: Bitmap | null = null;
    let source: HTMLCanvasElement | null = null;
    const pieces: Piece[] = [];
    let drag: { x: number; y: number; w: number; h: number } | null = null;

    const view = h('canvas', { class: 'art-view', width: VIEW_WIDTH, height: 200, style: 'width:100%;cursor:crosshair;background:#111;display:block' });
    const list = h('div', { class: 'art-list', style: 'display:grid;gap:4px;max-height:180px;overflow:auto' });
    const result = h('canvas', { width: 10, height: 10, style: 'max-width:100%;image-rendering:pixelated;display:block' });
    const report = h('p', { class: 'muted' }, 'Choose a picture, then drag a box around each piece: a portrait, a full figure, a frame.');
    const colorsIn = h('input', { type: 'number', min: '2', max: '128', value: '32' });
    const sizeIn = h('input', { type: 'number', min: '1', step: '0.1', placeholder: 'auto' });
    const toleranceIn = h('input', { type: 'number', min: '0', max: '1', step: '0.01', placeholder: 'auto' });
    const overwriteIn = h('input', { type: 'checkbox' });
    const biasIn = h('input', { type: 'number', min: '0', max: '1', step: '0.01', placeholder: '0.5', style: 'width:60px' });
    const outlineIn = h('input', { type: 'checkbox' });
    const exactIn = h('input', { type: 'checkbox', checked: true });
    const canvasW = h('input', { type: 'number', min: '1', placeholder: 'tight', style: 'width:60px' });
    const canvasH = h('input', { type: 'number', min: '1', placeholder: 'tight', style: 'width:60px' });
    const baselineIn = h('input', { type: 'number', min: '0', placeholder: 'last', style: 'width:60px' });
    const alignSel = h('select', {}, h('option', { value: 'center' }, 'Align figure'), h('option', { value: 'head' }, 'Align head'));

    const scale = () => (picture ? view.width / picture.width : 1);

    const draw = () => {
      const g = view.getContext('2d')!;
      g.clearRect(0, 0, view.width, view.height);
      if (!source) return;
      g.imageSmoothingEnabled = false;
      g.drawImage(source, 0, 0, view.width, view.height);
      const k = scale();
      g.font = '11px sans-serif';
      for (const p of pieces) {
        g.strokeStyle = '#ffcd75';
        g.strokeRect(p.x * k + 0.5, p.y * k + 0.5, p.width * k, p.height * k);
        g.fillStyle = '#ffcd75';
        g.fillText(p.name, p.x * k + 3, p.y * k + 12);
      }
      if (drag) {
        g.strokeStyle = '#73eff7';
        g.strokeRect(drag.x * k + 0.5, drag.y * k + 0.5, drag.w * k, drag.h * k);
      }
    };

    const items = (): ArtItem[] => pieces.map((p) => ({ sprite: p.name, crop: { x: p.x, y: p.y, width: p.width, height: p.height }, inset: p.inset, background: p.background, tag: p.tag || undefined }));
    const options = () => ({ colors: Number(colorsIn.value) || 32, pixelSize: Number(sizeIn.value) || undefined, tolerance: toleranceIn.value ? Number(toleranceIn.value) : undefined, exact: exactIn.checked, align: alignSel.value as 'center' | 'head', lineBias: biasIn.value ? Number(biasIn.value) : undefined, outline: outlineIn.checked, canvas: Number(canvasW.value) && Number(canvasH.value) ? { width: Number(canvasW.value), height: Number(canvasH.value), baseline: baselineIn.value ? Number(baselineIn.value) : undefined } : undefined });

    const renderList = () => {
      clear(list);
      pieces.forEach((p, i) => {
        const name = h('input', { type: 'text', value: p.name, spellcheck: false, title: 'Sprite name; the same name twice makes frames', oninput: () => { p.name = name.value.trim(); draw(); } });
        const inset = h('input', { type: 'number', min: '0', value: String(p.inset), title: 'Pixels cut from each side (frames, borders)', style: 'width:52px', oninput: () => { p.inset = Number(inset.value) || 0; } });
        const bg = h('select', { title: 'Background', onchange: () => { p.background = bg.value as ArtBackground; } }, h('option', { value: 'remove' }, 'Remove background'), h('option', { value: 'keep' }, 'Keep background'));
        bg.value = p.background;
        const tag = h('input', { type: 'text', value: p.tag, placeholder: 'animation', spellcheck: false, style: 'width:90px', oninput: () => { p.tag = tag.value.trim(); } });
        const cols = h('input', { type: 'number', min: '1', value: '1', title: 'Columns', style: 'width:44px' });
        const rows = h('input', { type: 'number', min: '1', value: '1', title: 'Rows', style: 'width:44px' });
        const split = () => {
          const c = Math.max(1, Number(cols.value) || 1);
          const r = Math.max(1, Number(rows.value) || 1);
          const made: Piece[] = [];
          for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) made.push({ ...p, x: p.x + Math.round((x * p.width) / c), y: p.y + Math.round((y * p.height) / r), width: Math.round(p.width / c), height: Math.round(p.height / r) });
          pieces.splice(i, 1, ...made);
          renderList();
          draw();
        };
        list.append(h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;align-items:center' }, name, 'inset', inset, bg, tag, cols, '×', rows,
          h('button', { type: 'button', class: 'ghost small', title: 'Split this box into equal cells, all frames of this sprite', onclick: split }, 'Split'),
          h('button', { type: 'button', class: 'ghost small', onclick: () => { pieces.splice(i, 1); renderList(); draw(); } }, 'Remove')));
      });
    };

    const at = (e: PointerEvent) => {
      const b = view.getBoundingClientRect();
      const k = view.width / b.width / scale();
      return { x: Math.round((e.clientX - b.left) * k), y: Math.round((e.clientY - b.top) * k) };
    };
    let start: { x: number; y: number } | null = null;
    view.addEventListener('pointerdown', (e) => { if (picture) { start = at(e); view.setPointerCapture(e.pointerId); } });
    view.addEventListener('pointermove', (e) => {
      if (!start) return;
      const p = at(e);
      drag = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
      draw();
    });
    view.addEventListener('pointerup', () => {
      if (drag && drag.w > 3 && drag.h > 3) {
        pieces.push({ name: `art_${pieces.length + 1}`, x: drag.x, y: drag.y, width: drag.w, height: drag.h, inset: 0, background: 'remove', tag: '' });
        renderList();
      }
      start = null;
      drag = null;
      draw();
    });

    const fileIn = h('input', {
      type: 'file',
      accept: 'image/*',
      onchange: async () => {
        const f = fileIn.files?.[0];
        if (!f) return;
        try {
          picture = await decode(f);
          source = document.createElement('canvas');
          source.width = picture.width;
          source.height = picture.height;
          source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(picture.data), picture.width, picture.height), 0, 0);
          view.height = Math.round((picture.height * view.width) / picture.width);
          pieces.length = 0;
          renderList();
          draw();
        } catch (err) {
          toast(String((err as Error).message), 'error');
        }
      },
    });

    const clean = () => {
      if (!picture) throw new Error('Choose a picture first');
      if (!pieces.length) throw new Error('Drag a box around at least one piece');
      return cleanArt(picture, items(), options());
    };

    const preview = () => {
      try {
        const res = clean();
        const sheet = artContactSheet(res, 3);
        result.width = sheet.width;
        result.height = sheet.height;
        result.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(sheet.data), sheet.width, sheet.height), 0, 0);
        report.textContent = res.map((r) => `${r.sprite}: ${r.width}x${r.height}, fake pixel ${r.grids[0].size}px`).join(' · ');
      } catch (err) {
        toast(String((err as Error).message), 'error');
      }
    };

    const save = async () => {
      try {
        const res = clean();
        const sprites = res.map((r) => ({ name: r.sprite, width: r.width, height: r.height, frames: r.frames.map((f) => bytesToBase64(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength))), tags: r.tags.map((t) => t ?? null) }));
        const out = await api.importArt({ sprites, overwrite: overwriteIn.checked });
        toast(`Imported ${out.names.length} sprite(s)`);
        close();
        done(out.names[0]);
      } catch (err) {
        toast(String((err as Error).message), 'error');
      }
    };

    return h('div', { style: `display:grid;gap:8px;width:${VIEW_WIDTH}px;max-width:90vw` },
      h('label', {}, 'Picture', fileIn),
      view,
      list,
      h('div', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
        h('label', {}, 'Colors ', colorsIn),
        h('label', { title: 'Size of the fake pixels; leave empty to measure it' }, 'Pixel size ', sizeIn),
        h('label', { title: 'Raise if background is left, lower if the figure is eaten' }, 'Background tolerance ', toleranceIn),
        h('label', { title: 'Fixed canvas, to replace an existing sprite without touching hitboxes' }, 'Canvas ', canvasW, ' × ', canvasH),
        h('label', { title: 'Row the feet stand on' }, 'Baseline ', baselineIn),
        alignSel,
        h('label', { title: 'How much of a pixel dark lines must cover to win; raise it when small sprites come out too dark' }, 'Line bias ', biasIn),
        h('label', { title: 'Darken the edge of the figure, for small sprites on busy ground' }, outlineIn, ' Outline'),
        h('label', {}, overwriteIn, ' Replace existing'),
        h('label', { title: 'Keep the art as it is: no palette reduction, no outline rules. For clean sheets with a flat background' }, exactIn, ' Exact'),
        h('button', { type: 'button', onclick: preview }, 'Preview'),
        h('button', { type: 'button', class: 'primary', onclick: save }, 'Import')),
      report,
      result);
  }, { wide: true });
}
