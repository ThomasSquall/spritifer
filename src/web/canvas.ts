import { parseColor, toHex, type RGBA } from '../core/color.js';
import { type Point, ellipsePoints, floodFill, getPixel, linePoints, plot, rectPoints, shift } from '../core/draw.js';
import type { Editor } from './editor.js';

const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64];

type Drag =
  | { kind: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { kind: 'paint'; color: RGBA; last: Point; changed: boolean }
  | { kind: 'shape'; color: RGBA; start: Point; end: Point }
  | { kind: 'move'; start: Point; original: Uint8ClampedArray; dx: number; dy: number };

/** The zoomable drawing surface: renders the sprite and turns pointer input into tool actions. */
export class CanvasView {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameCanvas = document.createElement('canvas');
  private checker: CanvasPattern;
  zoom = 8;
  ox = 0;
  oy = 0;
  private hover: Point | null = null;
  private drag: Drag | null = null;
  private spaceDown = false;
  private shiftDown = false;
  private wheelAccum = 0;
  private raf = 0;
  onHover: (p: Point | null, color: string | null) => void = () => {};
  onZoom: (zoom: number) => void = () => {};

  constructor(private editor: Editor) {
    this.el = document.createElement('div');
    this.el.className = 'canvas-wrap';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage';
    this.el.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.checker = this.makeChecker();

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover(null, null);
      this.requestRender();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        this.spaceDown = true;
        this.canvas.style.cursor = 'grab';
      }
      if (e.key === 'Shift') this.shiftDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.canvas.style.cursor = '';
      }
      if (e.key === 'Shift') this.shiftDown = false;
    });
    editor.on(() => this.requestRender());
  }

  private makeChecker(): CanvasPattern {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3a3f4b';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#323641';
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    return this.ctx.createPattern(c, 'repeat')!;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.el.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    // Keep the sprite fitted to the viewport until the user zooms or pans by hand.
    if (!this.userMoved && width > 0) this.fit();
    this.render();
  }
  private userMoved = false;

  /** Fits the sprite to the viewport; resumes auto-fitting on resize. */
  fit(): void {
    this.userMoved = false;
    const { width, height } = this.el.getBoundingClientRect();
    const s = this.editor.sprite;
    const max = Math.min((width - 48) / s.width, (height - 48) / s.height);
    this.zoom = ZOOMS.filter((z) => z <= max).pop() ?? 1;
    this.center();
  }

  center(): void {
    const { width, height } = this.el.getBoundingClientRect();
    const s = this.editor.sprite;
    this.ox = Math.round((width - s.width * this.zoom) / 2);
    this.oy = Math.round((height - s.height * this.zoom) / 2);
    this.onZoom(this.zoom);
    this.requestRender();
  }

  zoomBy(dir: 1 | -1, cx?: number, cy?: number): void {
    this.userMoved = true;
    const { width, height } = this.el.getBoundingClientRect();
    const px = cx ?? width / 2;
    const py = cy ?? height / 2;
    const i = ZOOMS.indexOf(this.zoom);
    const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.findIndex((z) => z > this.zoom) : i) + dir))];
    if (next === this.zoom) return;
    // Keep the point under the cursor fixed.
    this.ox = Math.round(px - ((px - this.ox) * next) / this.zoom);
    this.oy = Math.round(py - ((py - this.oy) * next) / this.zoom);
    this.zoom = next;
    this.onZoom(next);
    this.requestRender();
  }

  requestRender(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  // ------------------------------------------------------------------ rendering

  render(): void {
    const { ctx, editor } = this;
    const s = editor.sprite;
    const dpr = window.devicePixelRatio || 1;
    const z = this.zoom;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#1e2129';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const w = s.width * z;
    const h = s.height * z;
    ctx.save();
    this.checker.setTransform(new DOMMatrix().translate(this.ox, this.oy));
    ctx.fillStyle = this.checker;
    ctx.fillRect(this.ox, this.oy, w, h);
    ctx.restore();

    if (this.frameCanvas.width !== s.width || this.frameCanvas.height !== s.height) {
      this.frameCanvas.width = s.width;
      this.frameCanvas.height = s.height;
    }
    const fctx = this.frameCanvas.getContext('2d')!;
    const drawFrame = (f: number, alpha: number) => {
      fctx.putImageData(editor.composite(f), 0, 0);
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.frameCanvas, this.ox, this.oy, w, h);
      ctx.globalAlpha = 1;
    };
    if (editor.onion && !editor.playing) {
      if (editor.frame > 0) drawFrame(editor.frame - 1, 0.28);
      if (editor.frame < s.frames.length - 1) drawFrame(editor.frame + 1, 0.12);
    }
    drawFrame(editor.frame, 1);

    // Shape preview while dragging.
    if (this.drag?.kind === 'shape') {
      const pts = this.shapePoints(this.drag.start, this.drag.end);
      const c = this.drag.color;
      ctx.fillStyle = c[3] === 0 ? 'rgba(255,80,80,.55)' : `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
      for (const [x, y] of this.withMirror(this.expandBrush(pts))) {
        if (x >= 0 && y >= 0 && x < s.width && y < s.height) ctx.fillRect(this.ox + x * z, this.oy + y * z, z, z);
      }
    }

    // Pixel and tile grids.
    if (editor.grid && z >= 6) {
      ctx.beginPath();
      for (let x = 1; x < s.width; x++) {
        ctx.moveTo(this.ox + x * z + 0.5, this.oy);
        ctx.lineTo(this.ox + x * z + 0.5, this.oy + h);
      }
      for (let y = 1; y < s.height; y++) {
        ctx.moveTo(this.ox, this.oy + y * z + 0.5);
        ctx.lineTo(this.ox + w, this.oy + y * z + 0.5);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (s.grid && editor.grid) {
      ctx.beginPath();
      for (let x = s.grid.width; x < s.width; x += s.grid.width) {
        ctx.moveTo(this.ox + x * z + 0.5, this.oy);
        ctx.lineTo(this.ox + x * z + 0.5, this.oy + h);
      }
      for (let y = s.grid.height; y < s.height; y += s.grid.height) {
        ctx.moveTo(this.ox, this.oy + y * z + 0.5);
        ctx.lineTo(this.ox + w, this.oy + y * z + 0.5);
      }
      ctx.strokeStyle = 'rgba(120,200,255,0.35)';
      ctx.stroke();
    }
    if (editor.mirrorX) {
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(this.ox + w / 2 + 0.5, this.oy - 8);
      ctx.lineTo(this.ox + w / 2 + 0.5, this.oy + h + 8);
      ctx.strokeStyle = 'rgba(255,174,52,0.8)';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(this.ox - 0.5, this.oy - 0.5, w + 1, h + 1);

    // Brush cursor.
    if (this.hover && !this.drag && ['pencil', 'eraser', 'line', 'rect', 'ellipse'].includes(editor.tool)) {
      const pts = this.withMirror(this.expandBrush([this.hover]));
      ctx.lineWidth = 1;
      for (const [x, y] of pts) {
        ctx.strokeStyle = 'rgba(0,0,0,.7)';
        ctx.strokeRect(this.ox + x * z - 0.5, this.oy + y * z - 0.5, z + 1, z + 1);
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.strokeRect(this.ox + x * z + 0.5, this.oy + y * z + 0.5, z - 1, z - 1);
      }
    }
  }

  // ------------------------------------------------------------------ geometry helpers

  private toPixel(e: PointerEvent | WheelEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left - this.ox) / this.zoom), Math.floor((e.clientY - r.top - this.oy) / this.zoom)];
  }

  private shapePoints(a: Point, b: Point): Point[] {
    const tool = this.editor.tool;
    let [x1, y1] = b;
    if (this.shiftDown) {
      const dx = x1 - a[0];
      const dy = y1 - a[1];
      if (tool === 'line') {
        // Snap to 0°, 45° or 90°.
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if (adx > ady * 2) y1 = a[1];
        else if (ady > adx * 2) x1 = a[0];
        else {
          const m = Math.max(adx, ady);
          x1 = a[0] + Math.sign(dx) * m;
          y1 = a[1] + Math.sign(dy) * m;
        }
      } else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        x1 = a[0] + (Math.sign(dx) || 1) * m;
        y1 = a[1] + (Math.sign(dy) || 1) * m;
      }
    }
    if (tool === 'line') return linePoints(a[0], a[1], x1, y1);
    if (tool === 'rect') return rectPoints(a[0], a[1], x1, y1, this.editor.filled);
    return ellipsePoints(a[0], a[1], x1, y1, this.editor.filled);
  }

  private expandBrush(pts: Point[]): Point[] {
    const b = this.editor.tool === 'rect' || this.editor.tool === 'ellipse' ? 1 : this.editor.brush;
    if (b <= 1) return pts;
    const off = Math.floor((b - 1) / 2);
    const out: Point[] = [];
    for (const [x, y] of pts) for (let dy = 0; dy < b; dy++) for (let dx = 0; dx < b; dx++) out.push([x + dx - off, y + dy - off]);
    return out;
  }

  private withMirror(pts: Point[]): Point[] {
    if (!this.editor.mirrorX) return pts;
    const W = this.editor.sprite.width;
    return pts.concat(pts.map(([x, y]) => [W - 1 - x, y] as Point));
  }

  private paint(pts: Point[], c: RGBA): boolean {
    return plot(this.editor.currentCel(), this.withMirror(this.expandBrush(pts)), c) > 0;
  }

  // ------------------------------------------------------------------ input

  private colorFor(e: PointerEvent): RGBA {
    const ed = this.editor;
    if (ed.tool === 'eraser') return [0, 0, 0, 0];
    return parseColor(e.button === 2 ? ed.secondary : ed.primary);
  }

  private pick(p: Point, secondary: boolean): void {
    const img = this.editor.composite();
    const c = getPixel({ width: img.width, height: img.height, data: img.data }, p[0], p[1]);
    const hex = toHex(c);
    if (secondary) this.editor.secondary = hex;
    else this.editor.primary = hex;
    this.editor.emit('color');
  }

  private pointerDown(e: PointerEvent): void {
    const ed = this.editor;
    if (ed.playing) {
      ed.playing = false;
      ed.emit('view');
    }
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 1 || this.spaceDown) {
      this.userMoved = true;
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy };
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const p = this.toPixel(e);
    const layer = ed.layer;
    if (!layer.visible && ed.tool !== 'picker') {
      layer.visible = true;
      ed.emit('structure');
    }

    if (ed.tool === 'picker' || (e.altKey && ed.tool !== 'move')) {
      this.pick(p, e.button === 2);
      return;
    }
    switch (ed.tool) {
      case 'pencil':
      case 'eraser': {
        ed.checkpoint();
        const color = this.colorFor(e);
        const changed = this.paint([p], color);
        this.drag = { kind: 'paint', color, last: p, changed };
        if (changed) ed.emit('pixels');
        break;
      }
      case 'fill': {
        ed.checkpoint();
        const color = this.colorFor(e);
        let n = floodFill(ed.currentCel(), p[0], p[1], color, ed.contiguous);
        if (ed.mirrorX) n += floodFill(ed.currentCel(), ed.sprite.width - 1 - p[0], p[1], color, ed.contiguous);
        if (n) ed.commit('pixels');
        else ed.dropCheckpoint();
        break;
      }
      case 'line':
      case 'rect':
      case 'ellipse':
        this.drag = { kind: 'shape', color: this.colorFor(e), start: p, end: p };
        this.requestRender();
        break;
      case 'move':
        ed.checkpoint();
        this.drag = { kind: 'move', start: p, original: new Uint8ClampedArray(ed.currentCel().data), dx: 0, dy: 0 };
        break;
    }
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.toPixel(e);
    const s = this.editor.sprite;
    const inside = p[0] >= 0 && p[1] >= 0 && p[0] < s.width && p[1] < s.height;
    const prevHover = this.hover;
    this.hover = inside ? p : null;
    if (inside) {
      const img = this.editor.composite();
      const c = getPixel({ width: img.width, height: img.height, data: img.data }, p[0], p[1]);
      this.onHover(p, c[3] ? toHex(c) : null);
    } else this.onHover(null, null);

    const d = this.drag;
    if (!d) {
      if (prevHover?.[0] !== this.hover?.[0] || prevHover?.[1] !== this.hover?.[1]) this.requestRender();
      return;
    }
    switch (d.kind) {
      case 'pan':
        this.ox = d.ox + (e.clientX - d.sx);
        this.oy = d.oy + (e.clientY - d.sy);
        this.requestRender();
        break;
      case 'paint':
        if (p[0] === d.last[0] && p[1] === d.last[1]) return;
        if (this.paint(linePoints(d.last[0], d.last[1], p[0], p[1]), d.color)) {
          d.changed = true;
          this.editor.emit('pixels');
        }
        d.last = p;
        break;
      case 'shape':
        if (p[0] !== d.end[0] || p[1] !== d.end[1]) {
          d.end = p;
          this.requestRender();
        }
        break;
      case 'move': {
        const dx = p[0] - d.start[0];
        const dy = p[1] - d.start[1];
        if (dx === d.dx && dy === d.dy) return;
        d.dx = dx;
        d.dy = dy;
        const cel = this.editor.currentCel();
        cel.data.set(d.original);
        shift(cel, dx, dy, e.shiftKey);
        this.editor.emit('pixels');
        break;
      }
    }
  }

  private pointerUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    const ed = this.editor;
    switch (d.kind) {
      case 'pan':
        this.canvas.style.cursor = this.spaceDown ? 'grab' : '';
        break;
      case 'paint':
        if (d.changed) ed.commit('pixels');
        else ed.dropCheckpoint();
        break;
      case 'shape': {
        ed.checkpoint();
        if (this.paint(this.shapePoints(d.start, d.end), d.color)) ed.commit('pixels');
        else ed.dropCheckpoint();
        this.requestRender();
        break;
      }
      case 'move':
        if (d.dx || d.dy) ed.commit('pixels');
        else ed.dropCheckpoint();
        break;
    }
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    // Trackpads send many small deltas; step the zoom only after enough movement.
    this.wheelAccum += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    const step = e.ctrlKey ? 12 : 40;
    while (Math.abs(this.wheelAccum) >= step) {
      const dir = this.wheelAccum > 0 ? -1 : 1;
      this.wheelAccum -= -dir * step;
      this.zoomBy(dir, e.clientX - r.left, e.clientY - r.top);
    }
  }
}
