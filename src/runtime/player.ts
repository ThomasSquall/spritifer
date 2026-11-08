/**
 * Browser player: runs a GameBundle on a pixel-perfect canvas with keyboard, mouse/touch and sound.
 * Used by exported games and by the editor's Play button.
 */

import { type InputFrame, type Renderer, STEP, World, renderWorld } from '../core/game/engine.js';
import type { ScreenLight } from '../core/game/atmosphere.js';
import { rasterText } from '../core/game/font.js';
import type { GameBundle } from '../core/game/types.js';
import { SoundBoard } from './audio.js';

export interface PlayerOptions {
  scene?: string;
  /** Called with engine logs (log actions, errors, scene changes). */
  onLog?: (message: string) => void;
  /** Start with hitboxes visible (toggle with F2). */
  debug?: boolean;
  /** Focus the canvas so keys work immediately. */
  autofocus?: boolean;
}

export interface Player {
  world: World;
  destroy(): void;
  restart(scene?: string): void;
  /** Paused games keep drawing but don't advance (inspector). */
  paused: boolean;
  /** Advances one frame while paused. */
  stepOnce(): void;
}

/** Physical key code → logical keys. Letters keep their own name and WASD also act as arrows. */
function logicalKeys(code: string): string[] {
  switch (code) {
    case 'ArrowLeft': return ['arrowleft', 'left'];
    case 'ArrowRight': return ['arrowright', 'right'];
    case 'ArrowUp': return ['arrowup', 'up'];
    case 'ArrowDown': return ['arrowdown', 'down'];
    case 'KeyA': return ['a', 'left'];
    case 'KeyD': return ['d', 'right'];
    case 'KeyW': return ['w', 'up'];
    case 'KeyS': return ['s', 'down'];
    case 'Space': return ['space', 'action'];
    case 'KeyZ': return ['z', 'action'];
    case 'KeyJ': return ['j', 'action'];
    case 'KeyX': return ['x', 'action2'];
    case 'KeyK': return ['k', 'action2'];
    case 'Enter': case 'NumpadEnter': return ['enter'];
    case 'Escape': return ['escape'];
    case 'ShiftLeft': case 'ShiftRight': return ['shift'];
  }
  if (/^Key[A-Z]$/.test(code)) return [code.slice(3).toLowerCase()];
  if (/^(Digit|Numpad)[0-9]$/.test(code)) return [code.slice(-1)];
  return [];
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load a sprite image'));
    img.src = src;
  });

class CanvasRenderer implements Renderer {
  private textCache = new Map<string, HTMLCanvasElement>();
  constructor(private ctx: CanvasRenderingContext2D, private images: Map<string, CanvasImageSource>, private w: number, private h: number) {}

  clear(color: string): void {
    this.ctx.globalAlpha = 1;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.w, this.h);
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number }): void {
    const img = this.images.get(sprite);
    if (!img) return;
    const c = this.ctx;
    const k = o.scale ?? 1;
    if (!o.flipX && !o.angle && o.opacity >= 1) {
      c.drawImage(img, sx, sy, sw, sh, dx, dy, sw * k, sh * k);
      return;
    }
    c.save();
    c.globalAlpha = o.opacity;
    c.translate(dx + (sw * k) / 2, dy + (sh * k) / 2);
    if (o.angle) c.rotate((o.angle * Math.PI) / 180);
    if (o.flipX) c.scale(-1, 1);
    c.drawImage(img, sx, sy, sw, sh, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
    c.restore();
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
    this.ctx.globalAlpha = 1;
  }

  private lightCanvas: HTMLCanvasElement | null = null;

  lighting(ambient: string, lights: ScreenLight[], glow: number): void {
    const c = this.ctx;
    if (!this.lightCanvas) {
      this.lightCanvas = document.createElement('canvas');
      this.lightCanvas.width = this.w;
      this.lightCanvas.height = this.h;
    }
    const g = this.lightCanvas.getContext('2d')!;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = ambient;
    g.fillRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = 'lighter';
    for (const l of lights) radial(g, l.x, l.y, l.radius, l.color, Math.min(1, l.intensity));
    c.save();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'multiply';
    c.drawImage(this.lightCanvas, 0, 0);
    if (glow > 0) {
      c.globalCompositeOperation = 'lighter';
      for (const l of lights) radial(c, l.x, l.y, l.radius * 0.7, l.color, Math.min(1, l.intensity * glow * 0.35));
    }
    c.restore();
  }

  grade(tint: string, amount: number): void {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'soft-light';
    c.globalAlpha = amount;
    c.fillStyle = tint;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
  }

  vignette(strength: number, color: string): void {
    const c = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const r = Math.hypot(cx, cy);
    const grad = c.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
    grad.addColorStop(0, withAlpha(color, 0));
    grad.addColorStop(1, withAlpha(color, strength));
    c.save();
    c.globalAlpha = 1;
    c.fillStyle = grad;
    c.fillRect(0, 0, this.w, this.h);
    c.restore();
  }

  text(text: string, x: number, y: number, color: string, scale: number): void {
    const key = color + '\u0000' + text;
    let cv = this.textCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      const lines = text.split('\n');
      cv.width = Math.max(1, Math.max(...lines.map((l) => [...l].length)) * 4);
      cv.height = Math.max(1, lines.length * 6);
      const g = cv.getContext('2d')!;
      g.fillStyle = color;
      rasterText(text, (px, py) => g.fillRect(px, py, 1, 1));
      if (this.textCache.size > 400) this.textCache.clear();
      this.textCache.set(key, cv);
    }
    this.ctx.drawImage(cv, Math.round(x), Math.round(y), cv.width * scale, cv.height * scale);
  }
}

/** "#rgb" / "#rrggbb" with an alpha, as an rgba() string. */
function withAlpha(color: string, a: number): string {
  let h = color.replace('#', '');
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

/** Additive light blob with a (1 - d/r)^2 falloff, like the bitmap renderer. */
function radial(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, k: number): void {
  if (r <= 0 || k <= 0) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) grad.addColorStop(t, withAlpha(color, k * (1 - t) * (1 - t)));
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

const STYLE = `
.spf-root{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;background:#000;touch-action:none;user-select:none;-webkit-user-select:none}
.spf-root canvas{image-rendering:pixelated;image-rendering:crisp-edges;outline:none;display:block}
.spf-touch{position:absolute;inset:0;pointer-events:none}
.spf-pad,.spf-btns{position:absolute;bottom:18px;display:grid;gap:6px;pointer-events:auto}
.spf-pad{left:18px;grid-template-columns:repeat(3,52px);grid-template-rows:repeat(3,52px)}
.spf-btns{right:18px;grid-template-columns:repeat(2,64px);align-items:end}
.spf-touch button{border:2px solid #ffffff55;background:#ffffff22;color:#fff;border-radius:12px;font:600 18px system-ui;touch-action:none;padding:0}
.spf-touch button.on{background:#ffffff66}
.spf-btns button{width:64px;height:64px;border-radius:50%}
.spf-loading{color:#888;font:14px system-ui}
`;

/** Starts the game inside `container`. Resolves once the sprites are loaded. */
export async function mountPlayer(container: HTMLElement, bundle: GameBundle, opts: PlayerOptions = {}): Promise<Player> {
  if (!document.getElementById('spf-style')) {
    const st = document.createElement('style');
    st.id = 'spf-style';
    st.textContent = STYLE;
    document.head.append(st);
  }
  const root = document.createElement('div');
  root.className = 'spf-root';
  root.innerHTML = '<div class="spf-loading">Loading…</div>';
  container.append(root);

  const images = new Map<string, CanvasImageSource>();
  await Promise.all(
    Object.values(bundle.sprites).map(async (s) => {
      if (s.image) images.set(s.name, await loadImage(s.image));
    }),
  );
  root.innerHTML = '';

  const game = bundle.game;
  const canvas = document.createElement('canvas');
  canvas.width = game.width;
  canvas.height = game.height;
  canvas.tabIndex = 0;
  root.append(canvas);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const renderer = new CanvasRenderer(ctx, images, game.width, game.height);

  const sound = new SoundBoard();
  sound.setFiles(bundle.audio);
  const storagePrefix = `spritifer:${game.title}:`;
  const storage = {
    get: (k: string) => {
      try { return localStorage.getItem(storagePrefix + k); } catch { return null; }
    },
    set: (k: string, v: string) => {
      try { localStorage.setItem(storagePrefix + k, v); } catch { /* storage unavailable */ }
    },
  };
  const makeWorld = (scene?: string) => new World(bundle, { scene, storage, sound: (n, v) => sound.play(n, v), music: (cmd) => sound.music(cmd), log: opts.onLog, seed: (Math.random() * 2 ** 31) | 0 });
  let world: World;
  try {
    world = makeWorld(opts.scene);
  } catch (err) {
    root.innerHTML = `<div class="spf-loading">${String((err as Error).message)}</div>`;
    throw err;
  }

  // ---------------------------------------------------------------- scaling
  const fit = () => {
    const r = root.getBoundingClientRect();
    const exact = Math.min(r.width / game.width, r.height / game.height);
    let z: number;
    if (game.zoom !== 'fit') z = game.zoom;
    else {
      // Integer zoom keeps pixels perfectly square; fall back to a smooth fit when it would waste too much space.
      const whole = Math.floor(exact);
      z = whole >= 1 && whole / exact >= 0.8 ? whole : exact;
    }
    canvas.style.width = `${Math.round(game.width * z)}px`;
    canvas.style.height = `${Math.round(game.height * z)}px`;
  };
  const ro = new ResizeObserver(fit);
  ro.observe(root);
  fit();

  // ---------------------------------------------------------------- input
  const codes = new Set<string>();
  const virtual = new Set<string>();
  const queuedPress = new Set<string>();
  let prevDown = new Set<string>();
  let clicks: [number, number][] = [];
  let pointer: [number, number] | null = null;
  let showHitboxes = !!opts.debug;

  const onKeyDown = (e: KeyboardEvent) => {
    sound.unlock();
    if (e.code === 'F2') {
      showHitboxes = !showHitboxes;
      e.preventDefault();
      return;
    }
    const keys = logicalKeys(e.code);
    if (!keys.length) return;
    if (!e.repeat) for (const k of keys) queuedPress.add(k);
    codes.add(e.code);
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    codes.delete(e.code);
  };
  const onBlur = () => codes.clear();
  const toGame = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * game.width, ((e.clientY - r.top) / r.height) * game.height];
  };
  const onPointerDown = (e: PointerEvent) => {
    sound.unlock();
    canvas.focus();
    clicks.push(toGame(e));
  };
  const onPointerMove = (e: PointerEvent) => {
    pointer = toGame(e);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);

  // On-screen controls for phones and tablets.
  const touch = game.touchControls && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  if (touch) {
    const layer = document.createElement('div');
    layer.className = 'spf-touch';
    const pad = document.createElement('div');
    pad.className = 'spf-pad';
    const btns = document.createElement('div');
    btns.className = 'spf-btns';
    const mk = (label: string, key: string, parent: HTMLElement, area?: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (area) b.style.gridArea = area;
      const on = (e: PointerEvent) => {
        e.preventDefault();
        sound.unlock();
        if (!virtual.has(key)) queuedPress.add(key);
        virtual.add(key);
        b.classList.add('on');
        b.setPointerCapture?.(e.pointerId);
      };
      const off = () => {
        virtual.delete(key);
        b.classList.remove('on');
      };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointercancel', off);
      b.addEventListener('lostpointercapture', off);
      parent.append(b);
    };
    mk('▲', 'up', pad, '1 / 2');
    mk('◀', 'left', pad, '2 / 1');
    mk('▶', 'right', pad, '2 / 3');
    mk('▼', 'down', pad, '3 / 2');
    mk('B', 'action2', btns);
    mk('A', 'action', btns);
    layer.append(pad, btns);
    root.append(layer);
  }

  /**
   * Standard-mapping gamepads: d-pad / left stick = arrows, A = action, B/X = action2, Start = enter,
   * plus every button by name (pad:a, pad:b, pad:x, pad:y, pad:lb, pad:rb, pad:lt, pad:rt, pad:select, pad:start, pad:up...) for input actions.
   */
  const PAD_BUTTONS = ['pad:a', 'pad:b', 'pad:x', 'pad:y', 'pad:lb', 'pad:rb', 'pad:lt', 'pad:rt', 'pad:select', 'pad:start', 'pad:l3', 'pad:r3', 'pad:up', 'pad:down', 'pad:left', 'pad:right'];
  const padKeys = (): string[] => {
    const out: string[] = [];
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p) continue;
      const b = (i: number) => !!p.buttons[i]?.pressed;
      const ax = p.axes[0] ?? 0;
      const ay = p.axes[1] ?? 0;
      PAD_BUTTONS.forEach((name, i) => b(i) && out.push(name));
      if (ax < -0.4) out.push('pad:left');
      if (ax > 0.4) out.push('pad:right');
      if (ay < -0.4) out.push('pad:up');
      if (ay > 0.4) out.push('pad:down');
      if (b(14) || ax < -0.4) out.push('left');
      if (b(15) || ax > 0.4) out.push('right');
      if (b(12) || ay < -0.4) out.push('up');
      if (b(13) || ay > 0.4) out.push('down');
      if (b(0)) out.push('action', 'space');
      if (b(1) || b(2)) out.push('action2');
      if (b(9)) out.push('enter');
    }
    return out;
  };

  const readInput = (): InputFrame => {
    const pad = padKeys();
    const down = new Set<string>([...virtual, ...pad]);
    for (const c of codes) for (const k of logicalKeys(c)) down.add(k);
    const pressed = new Set<string>(queuedPress);
    for (const k of down) if (!prevDown.has(k)) pressed.add(k);
    for (const k of pressed) down.add(k);
    const released = new Set<string>([...prevDown].filter((k) => !down.has(k)));
    queuedPress.clear();
    prevDown = new Set([...codes].flatMap(logicalKeys).concat([...virtual], pad));
    const f: InputFrame = { down, pressed, released, clicks, pointer };
    clicks = [];
    return f;
  };

  // ---------------------------------------------------------------- loop
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let busy = false;
  let paused = false;
  let stepRequests = 0;
  const frame = async (now: number) => {
    raf = requestAnimationFrame((t) => void frame(t));
    if (busy) return;
    busy = true;
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    if (paused) {
      // Only the frames asked for with stepOnce().
      acc = stepRequests * STEP;
      stepRequests = 0;
    }
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      world.step(readInput());
      // Let dialogue and script continuations (await say / choose / wait) run before the next step.
      await world.settle();
      acc -= STEP;
      steps++;
    }
    if (steps === 5) acc = 0;
    busy = false;
    renderWorld(world, renderer);
    if (showHitboxes) {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = '#ff004d';
      ctx.lineWidth = 1;
      for (const a of world.actors) {
        const b = a.box();
        const z = a.type.hud ? 1 : world.zoom;
        const ox = a.type.hud ? 0 : world.camera.x;
        const oy = a.type.hud ? 0 : world.camera.y;
        ctx.strokeRect(Math.round((b.x - ox) * z) + 0.5, Math.round((b.y - oy) * z) + 0.5, Math.max(0, b.w * z - 1), Math.max(0, b.h * z - 1));
      }
      ctx.globalAlpha = 1;
    }
  };
  raf = requestAnimationFrame((t) => void frame(t));
  if (opts.autofocus !== false) canvas.focus();

  const player: Player = {
    get world() {
      return world;
    },
    restart(scene?: string) {
      world = makeWorld(scene ?? opts.scene);
    },
    get paused() {
      return paused;
    },
    set paused(on: boolean) {
      paused = on;
      acc = 0;
    },
    stepOnce() {
      stepRequests++;
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      root.remove();
    },
  };
  return player;
}
