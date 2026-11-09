/**
 * The 2D-HD view of the scene editor: the scene drawn by the game's own perspective renderer, standing still at its start
 * positions, over the map. Settings changed in the side panels show at once. It only looks: nothing placed or painted
 * goes through it, so what is drawn here cannot be edited by mistake on a map that is no longer where it seems.
 */

import { World, renderWorld } from '../core/game/engine.js';
import { type Scene, interfaceSize } from '../core/game/types.js';
import { CanvasRenderer } from '../runtime/canvasRenderer.js';
import { HdStage } from '../runtime/hdStage.js';
import { h, toast } from './dom.js';
import type { LoadedAsset } from './gameApi.js';
import { state } from './gameState.js';
import { isPlaying } from './play.js';

export interface HdPreviewHost {
  wrap(): HTMLElement;
  scene(): Scene;
  /** Every sprite the scene draws, tileset included. */
  sprites(): Map<string, LoadedAsset>;
  /** The point of the map the editor is looking at. */
  center(): { x: number; y: number };
  onVisible(on: boolean): void;
}

/** After the last change, how long to wait before placing every instance again. */
const REBUILD_DELAY = 300;
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

type Live = { root: HTMLElement; picture: HTMLCanvasElement; stage: HdStage; images: Map<string, CanvasImageSource>; world: World; observer: ResizeObserver };

export class HdPreview {
  private live: Live | null = null;
  private raf = 0;
  private last = 0;
  private dirtyAt = 0;
  private center = { x: 0, y: 0 };
  private zoom: number | null = null;
  private docked = false;

  constructor(private readonly host: HdPreviewHost) {}

  get visible(): boolean {
    return !!this.live;
  }

  get isDocked(): boolean {
    return !!this.live && this.docked;
  }

  /** Points the camera at a spot of the map. */
  look(x: number, y: number): void {
    const l = this.live;
    if (!l) return;
    this.center = { x, y };
    this.aim(l.world);
  }

  toggle(): void {
    if (this.live) this.hide();
    else this.show();
  }

  /** `docked`: small in a corner, with the map still usable around it. */
  show(docked = false): void {
    if (this.live || !state.game) return;
    this.docked = docked;
    this.center = this.host.center();
    this.zoom = null;
    if (!this.mount()) return;
    this.host.onVisible(true);
    window.addEventListener('keydown', this.onKey, true);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  hide(): void {
    if (!this.live) return;
    this.unmount();
    window.removeEventListener('keydown', this.onKey, true);
    this.host.onVisible(false);
  }

  /** The scene changed: settings show by themselves, tiles and instances need the world placed again. */
  invalidate(): void {
    if (this.live) this.dirtyAt = performance.now();
  }

  /** Sprites were loaded again. Saving a scene does this too, with the same pictures: then there is nothing to redo. */
  reload(): void {
    if (!this.live) return;
    const sprites = this.host.sprites();
    if (sprites.size === this.live.images.size && [...sprites.values()].every((a) => this.live!.images.get(a.name) === a.img)) {
      this.invalidate();
      return;
    }
    this.unmount();
    this.mount();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  private mount(): boolean {
    const game = state.game!;
    const sprites = Object.fromEntries(this.host.sprites());
    const images = new Map<string, CanvasImageSource>(Object.values(sprites).map((a) => [a.name, a.img]));
    const picture = h('canvas', { width: String(game.width), height: String(game.height), style: 'grid-area:1/1;image-rendering:pixelated;pointer-events:none' }) as HTMLCanvasElement;
    const ctx = picture.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    const renderer = new CanvasRenderer(ctx, images, game.width, game.height).useRelief(sprites, interfaceSize(game));
    const place = this.docked ? `right:12px;bottom:12px;width:min(52%,620px);aspect-ratio:${game.width}/${game.height};border:1px solid #fff4;border-radius:6px;box-shadow:0 6px 24px #0008` : 'inset:0';
    const root = h('div', { class: 'hd-preview', style: `position:absolute;${place};z-index:5;display:grid;place-items:center;background:#000;cursor:grab;overflow:hidden;touch-action:none` }, picture,
      h('div', { style: 'position:absolute;left:8px;top:8px;padding:3px 7px;border-radius:6px;background:#000a;color:#fff;font:11px system-ui;pointer-events:none' }, this.docked ? '2D-HD' : '2D-HD view · drag to move, wheel to zoom, Esc to close'));
    const wrap = this.host.wrap();
    if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
    wrap.append(root);
    const stage = new HdStage(picture, ctx, renderer, images, game.width, game.height);
    const fit = () => {
      const r = root.getBoundingClientRect();
      const k = Math.min(r.width / game.width, r.height / game.height);
      picture.style.width = `${game.width * k}px`;
      picture.style.height = `${game.height * k}px`;
      stage.resize();
    };
    const fail = (message: string) => {
      stage.dispose();
      root.remove();
      toast(message, 'error');
      return false;
    };
    fit();
    if (!stage.start()) return fail('This browser has no WebGL2: the 2D-HD view needs it');
    const world = this.place(sprites);
    if (!world) return fail('Could not place this scene in the 2D-HD view');
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    this.live = { root, picture, stage, images, world, observer };
    this.listen(root);
    this.dirtyAt = 0;
    return true;
  }

  private unmount(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const l = this.live;
    if (!l) return;
    l.observer.disconnect();
    l.stage.dispose();
    l.root.remove();
    this.live = null;
  }

  /** A world that stands still: one step sets the camera and the sizes, as when the scene starts. */
  private place(sprites: Record<string, LoadedAsset>): World | null {
    const scene = this.host.scene();
    try {
      // The scene and the game are shared, not copied: that is how a slider shows while it moves.
      const world = new World({ game: state.game!, scenes: { [scene.name]: scene }, sprites, scripts: {} }, { scene: scene.name, seed: 1 });
      world.step();
      world.cameraHeld = null;
      this.zoom ??= world.camera.zoom;
      world.camera.zoom = this.zoom;
      this.aim(world);
      return world;
    } catch (err) {
      console.warn('[2D-HD view]', err);
      return null;
    }
  }

  /** Points the camera at `center`, keeping the screen inside the map when the map is big enough. */
  private aim(world: World): void {
    const s = world.scene;
    const W = s.cols * s.tileSize;
    const H = s.rows * s.tileSize;
    const vw = world.viewWidth;
    const vh = world.viewHeight;
    this.center.x = clamp(this.center.x, Math.min(vw, W) / 2, W - Math.min(vw, W) / 2);
    this.center.y = clamp(this.center.y, Math.min(vh, H) / 2, H - Math.min(vh, H) / 2);
    world.camera.x = this.center.x - vw / 2;
    world.camera.y = this.center.y - vh / 2;
  }

  private readonly tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const l = this.live;
    // Behind the Play overlay it would only take the GPU from the game.
    if (!l || isPlaying()) {
      this.last = now;
      return;
    }
    if (this.dirtyAt && now - this.dirtyAt > REBUILD_DELAY) {
      this.dirtyAt = 0;
      const world = this.place(Object.fromEntries(this.host.sprites()));
      if (world) l.world = world;
    }
    const w = l.world;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    w.clock += dt;
    const view = { x: w.camera.x, y: w.camera.y, w: w.viewWidth, h: w.viewHeight };
    w.motes.tick(dt, view);
    w.motes2.tick(dt, view);
    w.rain.tick(dt, view);
    renderWorld(w, l.stage.target(w));
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    this.hide();
  };

  /** Everything that reaches this view stops here: the map underneath must not paint or select. */
  private listen(root: HTMLElement): void {
    let drag: { x: number; y: number } | null = null;
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerup']) root.addEventListener(type, (e) => e.stopPropagation());
    root.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      root.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
      root.style.cursor = 'grabbing';
    });
    root.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      const l = this.live;
      if (!drag || !l) return;
      // Screen pixels to map pixels.
      const k = l.picture.getBoundingClientRect().width / state.game!.width / l.world.zoom;
      this.center.x -= (e.clientX - drag.x) / k;
      this.center.y -= (e.clientY - drag.y) / k;
      drag = { x: e.clientX, y: e.clientY };
      this.aim(l.world);
    });
    const stop = () => {
      drag = null;
      root.style.cursor = 'grab';
    };
    root.addEventListener('pointerup', stop);
    root.addEventListener('pointercancel', stop);
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const l = this.live;
      if (!l) return;
      this.zoom = clamp((this.zoom ?? 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), 0.5, 4);
      l.world.camera.zoom = this.zoom;
      this.aim(l.world);
    }, { passive: false });
  }
}
