/**
 * The 2D-HD canvas and everything that draws on it, for whoever shows a world: the game player and the scene editor.
 * It sits under the game's canvas, which is emptied once the world is taken from it, so the interface drawn there
 * afterwards floats, crisp, above the finished picture.
 */

import { type Renderer, type World } from '../core/game/engine.js';
import { type HdFrame, resolveHd } from '../core/game/hd.js';
import type { CanvasRenderer } from './canvasRenderer.js';
import { HdCompositor } from './hdCompositor.js';
import { HdScene } from './hdScene.js';

export class HdStage {
  private readonly canvas = document.createElement('canvas');
  private compositor: HdCompositor | null = null;
  private perspective: HdScene | null = null;
  private wanted = false;

  constructor(
    private readonly picture: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly renderer: CanvasRenderer,
    private readonly images: Map<string, CanvasImageSource>,
    private readonly width: number,
    private readonly height: number,
  ) {
    this.canvas.style.cssText = 'display:none;grid-area:1/1;pointer-events:none;image-rendering:auto';
    picture.before(this.canvas);
    // A phone can take the GPU away while the game is in the background.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.compositor = null;
      this.perspective = null;
      this.unhook();
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      if (this.wanted) this.start();
    });
  }

  private readonly finishWorld = (frame: HdFrame | null): void => {
    if (!frame || !this.compositor) {
      this.canvas.style.display = 'none';
      return;
    }
    this.compositor.draw(this.picture, frame);
    this.canvas.style.display = '';
    this.ctx.clearRect(0, 0, this.width, this.height);
  };

  private unhook(): void {
    this.renderer.endWorld = undefined;
    this.canvas.style.display = 'none';
  }

  /** False when this browser has no WebGL2: the world stays as it is. */
  start(): boolean {
    this.wanted = true;
    this.compositor ??= HdCompositor.create(this.canvas, this.width, this.height);
    if (!this.compositor) {
      this.unhook();
      return false;
    }
    this.resize();
    this.renderer.endWorld = this.finishWorld;
    return true;
  }

  stop(): void {
    this.wanted = false;
    this.unhook();
  }

  /** Follows the size the game's canvas has been given. */
  resize(): void {
    const box = this.picture.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = this.picture.style.width;
    this.canvas.style.height = this.picture.style.height;
    this.compositor?.resize(box.width * dpr, box.height * dpr);
  }

  /** What to draw this world with: the perspective view when its scene has one, otherwise the flat canvas. */
  target(world: World): Renderer {
    const compositor = this.compositor;
    if (!compositor || !this.renderer.endWorld) return this.renderer;
    const atmosphere = world.scene.atmosphere;
    const look = resolveHd(world.game.hd, atmosphere?.hd, atmosphere?.ambient);
    if (!look || look.perspective <= 0) return this.renderer;
    this.perspective ??= new HdScene(compositor, this.renderer, this.ctx, this.images, this.width, this.height);
    this.perspective.prepare(look);
    this.canvas.style.display = '';
    return this.perspective;
  }

  /** Copies the 2D-HD picture into a 2D context (call it in the frame it was drawn: WebGL keeps nothing after). */
  drawInto(g: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.canvas.style.display === 'none' || !this.compositor) return;
    g.drawImage(this.canvas, 0, 0, width, height);
  }

  /** Lets the GPU go at once: browsers allow only a few of these canvases. */
  dispose(): void {
    this.stop();
    this.compositor?.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.compositor = null;
    this.perspective = null;
    this.canvas.remove();
  }
}
