import {
  type Sprite,
  type Layer,
  celBitmap,
  cloneSprite,
  deserializeSprite,
  serializeSprite,
  compositeFrame,
  tagSequence,
} from '../core/sprite.js';
import { api } from './api.js';

export type ToolName = 'pencil' | 'eraser' | 'fill' | 'picker' | 'line' | 'rect' | 'ellipse' | 'move';

export type ChangeKind = 'pixels' | 'structure' | 'view' | 'tool' | 'color' | 'status';

const HISTORY_LIMIT = 100;

/** Holds the open sprite, the current selection/tool state, undo history and persistence. */
export class Editor {
  sprite: Sprite;
  frame = 0;
  layerId: string;
  tool: ToolName = 'pencil';
  primary = '#181425';
  secondary = 'transparent';
  brush = 1;
  filled = false;
  contiguous = true;
  mirrorX = false;
  onion = false;
  grid = true;
  /** Inclusive frame range selected in the timeline (for tags and multi-frame ops). */
  range: [number, number] | null = null;
  playing = false;
  playTag: string | null = null;

  saveState: 'saved' | 'saving' | 'dirty' | 'error' = 'saved';
  lastRev: string;

  private undoStack: Sprite[] = [];
  private redoStack: Sprite[] = [];
  private listeners = new Set<(kind: ChangeKind) => void>();
  private saveTimer: number | undefined;
  private saving: Promise<void> | null = null;
  private compositeCache = new Map<number, ImageData>();

  constructor(sprite: Sprite) {
    this.sprite = sprite;
    this.layerId = sprite.layers[sprite.layers.length - 1].id;
    this.lastRev = sprite.rev;
    if (sprite.palette.length) this.primary = sprite.palette[sprite.palette.length > 25 ? 25 : 0];
  }

  on(fn: (kind: ChangeKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(kind: ChangeKind): void {
    if (kind === 'pixels' || kind === 'structure') this.compositeCache.clear();
    for (const fn of this.listeners) fn(kind);
  }

  get layer(): Layer {
    return this.sprite.layers.find((l) => l.id === this.layerId) ?? this.sprite.layers[this.sprite.layers.length - 1];
  }

  get layerIndex(): number {
    return this.sprite.layers.indexOf(this.layer);
  }

  currentCel() {
    return celBitmap(this.sprite, this.layer.id, this.sprite.frames[this.frame].id);
  }

  /** Composited frame as ImageData (cached until the next pixel change). */
  composite(frame = this.frame): ImageData {
    let img = this.compositeCache.get(frame);
    if (!img) {
      const bmp = compositeFrame(this.sprite, frame);
      img = new ImageData(bmp.data as Uint8ClampedArray<ArrayBuffer>, bmp.width, bmp.height);
      this.compositeCache.set(frame, img);
    }
    return img;
  }

  // ------------------------------------------------------------ history

  /** Snapshot before a change; call `commit` afterwards. */
  checkpoint(): void {
    this.undoStack.push(cloneSprite(this.sprite));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Discards the latest checkpoint (e.g. a stroke that changed nothing). */
  dropCheckpoint(): void {
    this.undoStack.pop();
  }

  commit(kind: ChangeKind = 'pixels'): void {
    this.emit(kind);
    this.scheduleSave();
  }

  /** Runs a structural edit with undo support. */
  edit(fn: (s: Sprite) => void, kind: ChangeKind = 'structure'): void {
    this.checkpoint();
    try {
      fn(this.sprite);
    } catch (err) {
      this.restore(this.undoStack.pop()!);
      throw err;
    }
    this.clampSelection();
    this.commit(kind);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(cloneSprite(this.sprite));
    this.restore(prev);
    this.commit('structure');
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneSprite(this.sprite));
    this.restore(next);
    this.commit('structure');
  }

  private restore(s: Sprite): void {
    const rev = this.sprite.rev;
    this.sprite = s;
    this.sprite.rev = rev;
    this.clampSelection();
  }

  clampSelection(): void {
    const s = this.sprite;
    this.frame = Math.max(0, Math.min(this.frame, s.frames.length - 1));
    if (!s.layers.some((l) => l.id === this.layerId)) this.layerId = s.layers[Math.min(this.layerIndex, s.layers.length - 1)]?.id ?? s.layers[0].id;
    if (this.range && (this.range[1] >= s.frames.length || this.range[0] >= s.frames.length)) this.range = null;
    if (this.playTag && !s.tags.some((t) => t.name === this.playTag)) this.playTag = null;
  }

  // ------------------------------------------------------------ remote sync

  /** Applies a newer version written by someone else (e.g. Claude via MCP); undoable. */
  applyRemote(file: Parameters<typeof deserializeSprite>[0]): void {
    if (file.rev === this.lastRev) return;
    // The remote version wins; any unsaved local stroke stays reachable through undo.
    clearTimeout(this.saveTimer);
    if (this.saveState === 'dirty') this.saveState = 'saved';
    this.undoStack.push(cloneSprite(this.sprite));
    const next = deserializeSprite(file);
    this.sprite = next;
    this.lastRev = next.rev;
    this.clampSelection();
    this.emit('structure');
  }

  // ------------------------------------------------------------ persistence

  scheduleSave(): void {
    this.saveState = 'dirty';
    this.emit('status');
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), 350);
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    if (this.saving) await this.saving;
    if (this.saveState !== 'dirty') return;
    this.saveState = 'saving';
    this.emit('status');
    this.saving = (async () => {
      try {
        const { rev } = await api.save(serializeSprite(this.sprite, 'editor'));
        this.lastRev = rev;
        this.sprite.rev = rev;
        if (this.saveState === 'saving') this.saveState = 'saved';
      } catch (err) {
        this.saveState = 'error';
        console.error(err);
      } finally {
        this.saving = null;
        this.emit('status');
      }
    })();
    await this.saving;
  }

  // ------------------------------------------------------------ playback

  /** Frames to loop through during playback. */
  playSequence(): number[] {
    const tag = this.sprite.tags.find((t) => t.name === this.playTag);
    if (tag) return tagSequence(tag);
    if (this.range && this.range[0] !== this.range[1]) {
      const out: number[] = [];
      for (let i = this.range[0]; i <= this.range[1]; i++) out.push(i);
      return out;
    }
    return this.sprite.frames.map((_, i) => i);
  }
}
