/**
 * Browser player: runs a GameBundle on a pixel-perfect canvas with keyboard, mouse/touch and sound.
 * Used by exported games and by the editor's Play button.
 */

import { type InputFrame, type PlaytestInput, type Renderer, STEP, World, renderWorld } from '../core/game/engine.js';
import { CanvasRenderer } from './canvasRenderer.js';
import { HdStage } from './hdStage.js';
import { type GameBundle, type Value, interfaceSize } from '../core/game/types.js';
import { SoundBoard } from './audio.js';

export interface PlayerOptions {
  scene?: string;
  /** Called with engine logs (log actions, errors, scene changes). */
  onLog?: (message: string) => void;
  /** Start with hitboxes visible (toggle with F2). */
  debug?: boolean;
  /** Focus the canvas so keys work immediately. */
  autofocus?: boolean;
  /** false: start this run without sound. Otherwise the last choice made in this browser applies. */
  music?: boolean;
  /** Small on-screen sound button and volume slider (off inside the editor, whose Play bar has its own). */
  musicButton?: boolean;
  /** Called with the sound state (music and effects) at start and whenever it changes. */
  onMusicChange?: (on: boolean) => void;
  /** Called once at start with the volume (0..1) remembered in this browser. */
  onMusicVolume?: (volume: number) => void;
  /** Small on-screen button for the frame-rate readout (for playing from the editor's server, not in exported games). */
  fpsButton?: boolean;
  /** Called with the state of the frame-rate readout at start and whenever it changes. */
  onFpsChange?: (on: boolean) => void;
  /** Start this run with 2D-HD on or off. Otherwise the last choice made in this browser, then the game's setting. */
  hd?: boolean;
  /** Called with the 2D-HD state at start and whenever it changes. */
  onHdChange?: (on: boolean) => void;
}

/** A run of the game played by hand, ready to be replayed headless. */
export interface Recording {
  seed: number;
  seconds: number;
  inputs: PlaytestInput[];
  finalScene: string;
  /** Global variables that ended with another value than they started with. */
  changed: Record<string, Value>;
}

export interface Player {
  world: World;
  destroy(): void;
  restart(scene?: string): void;
  /** Paused games keep drawing but don't advance (inspector). */
  paused: boolean;
  /** Advances one frame while paused. */
  stepOnce(): void;
  /** All game sound on or off while the game runs: music, effects and ambience. */
  music: boolean;
  /** Volume of music, effects and ambience, 0..1; remembered in this browser. */
  musicVolume: number;
  /** Frame-rate readout on or off (F4). */
  fps: boolean;
  /** Auto 2D-HD on or off (F6); remembered in this browser. */
  hd: boolean;
  /** Restarts the game with a known seed and no saved data, and records the input from the first frame. */
  startRecording(): void;
  stopRecording(): Recording;
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

const STYLE = `
.spf-root{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;background:#000;touch-action:none;user-select:none;-webkit-user-select:none}
.spf-root canvas{image-rendering:pixelated;image-rendering:crisp-edges;outline:none;display:block;grid-area:1/1}
.spf-touch{position:absolute;inset:0;pointer-events:none}
.spf-btns{position:absolute;bottom:18px;right:18px;display:grid;gap:6px;pointer-events:auto;grid-template-columns:repeat(2,64px);align-items:end}
.spf-stick{position:absolute;width:104px;height:104px;margin:-52px 0 0 -52px;border-radius:50%;border:2px solid #ffffff55;background:#ffffff18;box-sizing:border-box;display:none}
.spf-stick i{position:absolute;left:50%;top:50%;width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;background:#ffffff77}
.spf-touch button.spf-run{position:absolute;top:48px;right:8px;width:52px;height:52px;border-radius:50%;font-size:26px;line-height:1;pointer-events:auto}
.spf-touch button.spf-run.on{background:#ffd76a99;border-color:#ffd76a}
.spf-touch button{border:2px solid #ffffff55;background:#ffffff22;color:#fff;border-radius:12px;font:600 18px system-ui;touch-action:none;padding:0}
.spf-touch button.on{background:#ffffff66}
.spf-btns button{width:64px;height:64px;border-radius:50%}
.spf-loading{color:#888;font:14px system-ui}
.spf-controls{position:absolute;top:8px;right:8px;display:flex;align-items:center;gap:8px;pointer-events:none}
.spf-controls>*{pointer-events:auto}
.spf-music{width:30px;height:30px;padding:0;border:1px solid #ffffff55;border-radius:50%;background:#0008;color:#fff;font:16px system-ui;cursor:pointer;opacity:0;transition:opacity .15s}
.spf-volume{width:80px;margin:0;accent-color:#fff;cursor:pointer;opacity:0;transition:opacity .15s}
.spf-root:hover .spf-music,.spf-music:focus-visible,.spf-root:hover .spf-volume,.spf-volume:focus-visible{opacity:.85}
.spf-music.off{text-decoration:line-through;color:#ffffff99}
@media (hover:none){.spf-music,.spf-volume{opacity:.5}}
.spf-fps-btn{height:30px;padding:0 9px;border:1px solid #ffffff55;border-radius:15px;background:#0008;color:#fff;font:600 11px system-ui;cursor:pointer;opacity:.7}
.spf-fps-btn:hover,.spf-fps-btn:focus-visible{opacity:1}
.spf-fps-btn.on{background:#3b5dc9;border-color:#3b5dc9;opacity:1}
.spf-fps{position:absolute;top:44px;right:8px;padding:6px 9px;border-radius:6px;background:#000c;font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre;pointer-events:none}
`;

const MUSIC_PREF = '__music';
const MUSIC_VOLUME_PREF = '__musicVolume';
const FPS_PREF = '__fps';
const HD_PREF = '__hd';

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
  // Per-pixel lighting reads the frame back every time it is drawn.
  const usesRelief = Object.values(bundle.scenes).some((s) => s.atmosphere?.relief);
  const ctx = canvas.getContext('2d', usesRelief ? { willReadFrequently: true } : undefined)!;
  ctx.imageSmoothingEnabled = false;
  const renderer = new CanvasRenderer(ctx, images, game.width, game.height);
  if (usesRelief) renderer.useRelief(bundle.sprites, interfaceSize(game));

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
  // ---------------------------------------------------------------- auto 2D-HD
  const stage = new HdStage(canvas, ctx, renderer, images, game.width, game.height);
  const savedHd = storage.get(HD_PREF);
  let hdOn = opts.hd ?? (savedHd === null ? !!game.hd?.enabled : savedHd === 'on');
  const setHd = (on: boolean) => {
    hdOn = on;
    storage.set(HD_PREF, on ? 'on' : 'off');
    if (on) stage.start();
    else stage.stop();
    opts.onHdChange?.(on);
  };
  if (hdOn) stage.start();
  opts.onHdChange?.(hdOn);

  const makeWorld = (scene?: string, seed = (Math.random() * 2 ** 31) | 0, store: typeof storage = storage) => new World(bundle, { scene, storage: store, sound: (n, v) => sound.play(n, v), music: (cmd) => sound.music(cmd), hd: { get: () => hdOn, set: setHd }, log: opts.onLog, seed });
  let world: World;
  try {
    world = makeWorld(opts.scene);
  } catch (err) {
    root.innerHTML = `<div class="spf-loading">${String((err as Error).message)}</div>`;
    throw err;
  }

  // ---------------------------------------------------------------- music switch
  let musicOn = opts.music ?? storage.get(MUSIC_PREF) !== 'off';
  sound.muted = !musicOn;
  let musicBtn: HTMLButtonElement | null = null;
  const showMusic = () => {
    if (musicBtn) {
      musicBtn.classList.toggle('off', !musicOn);
      musicBtn.title = `Sound ${musicOn ? 'on' : 'off'} (F3)`;
      musicBtn.setAttribute('aria-pressed', String(musicOn));
    }
    opts.onMusicChange?.(musicOn);
  };
  const setMusic = (on: boolean) => {
    musicOn = on;
    sound.muted = !on;
    storage.set(MUSIC_PREF, on ? 'on' : 'off');
    showMusic();
  };
  const setMusicVolume = (volume: number) => {
    sound.volume = volume;
    storage.set(MUSIC_VOLUME_PREF, String(sound.volume));
  };
  const savedVolume = storage.get(MUSIC_VOLUME_PREF);
  sound.volume = savedVolume === null ? 1 : Number(savedVolume) || 0;
  opts.onMusicVolume?.(sound.volume);
  const controls = document.createElement('div');
  controls.className = 'spf-controls';
  root.append(controls);
  if (opts.musicButton !== false && Object.keys(bundle.audio ?? {}).length) {
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.className = 'spf-volume';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.value = String(Math.round(sound.volume * 100));
    volumeSlider.title = 'Volume';
    volumeSlider.setAttribute('aria-label', 'Volume');
    volumeSlider.addEventListener('input', () => {
      sound.unlock();
      const volume = Number(volumeSlider.value) / 100;
      setMusicVolume(volume);
      // Moving the slider while the sound is off would otherwise seem to do nothing.
      if (!musicOn && volume > 0) setMusic(true);
    });
    volumeSlider.addEventListener('change', () => canvas.focus());
    controls.append(volumeSlider);
    musicBtn = document.createElement('button');
    musicBtn.className = 'spf-music';
    musicBtn.textContent = '♪';
    musicBtn.setAttribute('aria-label', 'Sound');
    musicBtn.addEventListener('click', () => {
      sound.unlock();
      setMusic(!musicOn);
      canvas.focus();
    });
    controls.append(musicBtn);
  }
  showMusic();

  // ---------------------------------------------------------------- frame-rate readout
  let fpsOn = storage.get(FPS_PREF) === 'on';
  const fpsBox = document.createElement('div');
  fpsBox.className = 'spf-fps';
  root.append(fpsBox);
  let fpsBtn: HTMLButtonElement | null = null;
  // Counted over a second, then shown: refreshes of the screen, pictures drawn, how long they took, how many came late.
  const fpsStats = { since: performance.now(), refreshes: 0, draws: 0, cost: 0, worst: 0, late: 0, lastDraw: 0 };
  const resetFps = (now: number) => Object.assign(fpsStats, { since: now, refreshes: 0, draws: 0, cost: 0, worst: 0, late: 0 });
  const showFps = () => {
    fpsBox.hidden = !fpsOn;
    if (fpsBtn) {
      fpsBtn.classList.toggle('on', fpsOn);
      fpsBtn.title = `Frame rate ${fpsOn ? 'on' : 'off'} (F4)`;
      fpsBtn.setAttribute('aria-pressed', String(fpsOn));
    }
    opts.onFpsChange?.(fpsOn);
  };
  const setFps = (on: boolean) => {
    fpsOn = on;
    storage.set(FPS_PREF, on ? 'on' : 'off');
    resetFps(performance.now());
    fpsStats.lastDraw = 0;
    if (on) {
      fpsBox.textContent = 'FPS …';
      fpsBox.style.color = '#fff';
    }
    showFps();
  };
  const updateFps = (now: number) => {
    const s = fpsStats;
    const elapsed = now - s.since;
    if (elapsed < 1000) return;
    const fps = (s.draws * 1000) / elapsed;
    fpsBox.style.color = fps >= 55 ? '#7dff9a' : fps >= 40 ? '#ffd76a' : '#ff8a8a';
    fpsBox.textContent = [
      `FPS    ${fps.toFixed(0)}`,
      `screen ${((s.refreshes * 1000) / elapsed).toFixed(0)} Hz`,
      `frame  ${(s.draws ? s.cost / s.draws : 0).toFixed(1)} ms`,
      `worst  ${s.worst.toFixed(1)} ms`,
      `late   ${s.late}`,
    ].join('\n');
    resetFps(now);
  };
  if (opts.fpsButton) {
    fpsBtn = document.createElement('button');
    fpsBtn.className = 'spf-fps-btn';
    fpsBtn.textContent = 'FPS';
    fpsBtn.setAttribute('aria-label', 'Frame rate');
    fpsBtn.addEventListener('click', () => {
      setFps(!fpsOn);
      canvas.focus();
    });
    controls.prepend(fpsBtn);
  }
  showFps();

  // ---------------------------------------------------------------- scaling
  const fit = () => {
    const r = root.getBoundingClientRect();
    const exact = Math.min(r.width / game.width, r.height / game.height);
    let z: number;
    if (game.zoom !== 'fit') z = game.zoom;
    else {
      // A whole number of physical screen pixels per game pixel keeps pixels square: at a fraction they come out uneven
      // and shimmer while the view scrolls. Only when that would waste too much of the window does it fit exactly.
      const dpr = window.devicePixelRatio || 1;
      const whole = Math.floor(exact * dpr);
      z = whole >= 1 && whole / (exact * dpr) >= 0.75 ? whole / dpr : exact;
    }
    canvas.style.width = `${game.width * z}px`;
    canvas.style.height = `${game.height * z}px`;
    stage.resize();
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
    if (e.code === 'F3') {
      if (!e.repeat) setMusic(!musicOn);
      e.preventDefault();
      return;
    }
    if (e.code === 'F4') {
      if (!e.repeat) setFps(!fpsOn);
      e.preventDefault();
      return;
    }
    if (e.code === 'F6') {
      if (!e.repeat) setHd(!hdOn);
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
  /** Touches on the stick's half of the screen count as clicks only if they turn out to be taps. */
  let onStickSide = (_e: PointerEvent) => false;
  const onPointerDown = (e: PointerEvent) => {
    sound.unlock();
    canvas.focus();
    if (!onStickSide(e)) clicks.push(toGame(e));
  };
  const onPointerMove = (e: PointerEvent) => {
    pointer = toGame(e);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  // In the Android app the game stops drawing in the background, and the music must stop with it.
  const onVisibility = () => sound.suspend(document.hidden);
  if (location.href.startsWith('file:///android_asset/')) document.addEventListener('visibilitychange', onVisibility);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);

  // On-screen controls for phones and tablets.
  const touch = game.touchControls && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
  if (touch) {
    const layer = document.createElement('div');
    layer.className = 'spf-touch';
    const btns = document.createElement('div');
    btns.className = 'spf-btns';
    const mk = (label: string, key: string, parent: HTMLElement) => {
      const b = document.createElement('button');
      b.textContent = label;
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
    mk('B', 'action2', btns);
    mk('A', 'action', btns);

    // The left half of the screen is a stick that appears under the thumb, so nothing covers the game until it is used.
    const STICK_REACH = 40;
    const STICK_DEAD = 14;
    const stick = document.createElement('div');
    stick.className = 'spf-stick';
    const knob = document.createElement('i');
    stick.append(knob);
    let held: { id: number; down: PointerEvent; x: number; y: number; moved: boolean } | null = null;
    onStickSide = (e) => {
      const r = root.getBoundingClientRect();
      return e.clientX - r.left < r.width / 2;
    };
    const setDirections = (dx: number, dy: number) => {
      const d = Math.hypot(dx, dy);
      // sin(22.5°): splits the circle in eight equal directions.
      const lean = d < STICK_DEAD ? Infinity : d * 0.383;
      const wanted: Record<string, boolean> = { left: dx < -lean, right: dx > lean, up: dy < -lean, down: dy > lean };
      for (const [key, on] of Object.entries(wanted)) {
        if (on && !virtual.has(key)) queuedPress.add(key);
        if (on) virtual.add(key);
        else virtual.delete(key);
      }
    };
    root.addEventListener('pointerdown', (e) => {
      if (held || !onStickSide(e) || (e.target as HTMLElement).closest('button,input')) return;
      sound.unlock();
      const r = root.getBoundingClientRect();
      held = { id: e.pointerId, down: e, x: e.clientX, y: e.clientY, moved: false };
      stick.style.display = 'block';
      stick.style.left = `${e.clientX - r.left}px`;
      stick.style.top = `${e.clientY - r.top}px`;
      knob.style.transform = '';
      root.setPointerCapture?.(e.pointerId);
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId !== held?.id) return;
      let dx = e.clientX - held.x;
      let dy = e.clientY - held.y;
      const d = Math.hypot(dx, dy);
      if (d >= STICK_DEAD) held.moved = true;
      if (d > STICK_REACH) {
        // The base follows the thumb: going the other way answers at once.
        held.x += (dx * (d - STICK_REACH)) / d;
        held.y += (dy * (d - STICK_REACH)) / d;
        dx = e.clientX - held.x;
        dy = e.clientY - held.y;
        const r = root.getBoundingClientRect();
        stick.style.left = `${held.x - r.left}px`;
        stick.style.top = `${held.y - r.top}px`;
      }
      knob.style.transform = `translate(${dx}px,${dy}px)`;
      setDirections(dx, dy);
    });
    const release = (e: PointerEvent) => {
      if (e.pointerId !== held?.id) return;
      if (e.type === 'pointerup' && !held.moved && e.timeStamp - held.down.timeStamp < 300 && held.down.target === canvas) clicks.push(toGame(held.down));
      held = null;
      stick.style.display = 'none';
      setDirections(0, 0);
    };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);

    layer.append(stick);
    // A switch rather than a button to hold: the left thumb is on the stick and the right one on A and B.
    if (game.objects.some((o) => o.behaviors.some((b) => Number((b as { runSpeed?: unknown }).runSpeed) > 0))) {
      const run = document.createElement('button');
      run.className = 'spf-run';
      run.textContent = '»';
      run.setAttribute('aria-label', 'Run');
      run.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        sound.unlock();
        const on = !virtual.has('shift');
        if (on) virtual.add('shift');
        else virtual.delete('shift');
        run.classList.toggle('on', on);
      });
      layer.append(run);
    }
    layer.append(btns);
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

  // ---------------------------------------------------------------- recording
  let recording: { seed: number; frame: number; held: Map<string, number>; inputs: PlaytestInput[]; start: Record<string, Value> } | null = null;
  const recordFrame = (input: InputFrame) => {
    const r = recording!;
    for (const k of input.down) if (!r.held.has(k)) r.held.set(k, r.frame);
    for (const [k, from] of r.held) {
      if (input.down.has(k)) continue;
      r.inputs.push({ at: from * STEP, key: k, duration: (r.frame - from) * STEP });
      r.held.delete(k);
    }
    for (const click of input.clicks) r.inputs.push({ at: r.frame * STEP, click });
    r.frame++;
  };

  // ---------------------------------------------------------------- loop
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let busy = false;
  let paused = false;
  let stepRequests = 0;
  let drawn = false;
  const frame = async (now: number) => {
    raf = requestAnimationFrame((t) => void frame(t));
    if (fpsOn) fpsStats.refreshes++;
    if (busy) return;
    const started = performance.now();
    busy = true;
    // The clock of a screen wobbles by a millisecond or two: taken literally, some frames would get no step and others
    // two, and movement would stutter. A frame close to a whole number of half steps counts as exactly that.
    let dt = Math.min(0.25, (now - last) / 1000);
    const halves = Math.round(dt / (STEP / 2));
    if (halves > 0 && halves <= 8 && Math.abs(dt - (halves * STEP) / 2) < 0.002) dt = (halves * STEP) / 2;
    acc += dt;
    last = now;
    if (paused) {
      // Only the frames asked for with stepOnce().
      acc = stepRequests * STEP;
      stepRequests = 0;
    }
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      const input = readInput();
      if (recording) recordFrame(input);
      world.step(input);
      // Let dialogue and script continuations (await say / choose / wait) run before the next step.
      await world.settle();
      acc -= STEP;
      steps++;
    }
    if (steps === 5) acc = 0;
    busy = false;
    // Nothing moved (a screen faster than the game): the picture on it is already right.
    if (steps === 0 && !paused && drawn) return;
    drawn = true;
    renderWorld(world, stage.target(world));
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
    if (fpsOn) {
      const end = performance.now();
      const cost = end - started;
      const s = fpsStats;
      s.draws++;
      s.cost += cost;
      if (cost > s.worst) s.worst = cost;
      // A picture that arrives more than half a step later than expected is a visible hitch.
      if (s.lastDraw && end - s.lastDraw > STEP * 1500) s.late++;
      s.lastDraw = end;
      updateFps(end);
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
    get music() {
      return musicOn;
    },
    set music(on: boolean) {
      setMusic(on);
    },
    get musicVolume() {
      return sound.volume;
    },
    set musicVolume(volume: number) {
      setMusicVolume(volume);
    },
    get fps() {
      return fpsOn;
    },
    set fps(on: boolean) {
      setFps(on);
    },
    get hd() {
      return hdOn;
    },
    set hd(on: boolean) {
      setHd(on);
    },
    startRecording() {
      const seed = (Math.random() * 2 ** 31) | 0;
      // Headless replays have no saved data: neither does a recording.
      const memory = new Map<string, string>();
      world = makeWorld(opts.scene, seed, { get: (k) => memory.get(k) ?? null, set: (k, v) => void memory.set(k, v) });
      codes.clear();
      virtual.clear();
      queuedPress.clear();
      prevDown = new Set();
      clicks = [];
      acc = 0;
      recording = { seed, frame: 0, held: new Map(), inputs: [], start: world.snapshot().globals };
    },
    stopRecording() {
      const r = recording;
      if (!r) throw new Error('Not recording');
      recording = null;
      for (const [k, from] of r.held) r.inputs.push({ at: from * STEP, key: k, duration: (r.frame - from) * STEP });
      r.inputs.sort((a, b) => a.at - b.at);
      const end = world.snapshot();
      const changed = Object.fromEntries(Object.entries(end.globals).filter(([k, v]) => r.start[k] !== v));
      return { seed: r.seed, seconds: r.frame * STEP, inputs: r.inputs, finalScene: end.scene, changed };
    },
    destroy() {
      sound.music({ type: 'ambience', layers: [], fade: 0.1 });
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      root.remove();
    },
  };
  return player;
}
