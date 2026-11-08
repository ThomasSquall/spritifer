/**
 * Measures how an animation moves, so problems can be found without watching it play: detached parts, wasted or
 * popping frames, a jump at the loop point, feet that skate, missing weight, even timing and pixel crawl on rotating parts.
 * Works on any tagged sprite; the rig-based checks (feet, trails of joints, crawl) run on frames that have a pose.
 * Pure and browser-safe: used by the anim_check MCP tool and by the editor's rig panel.
 */
import { getPixel, linePoints, setPixel } from './draw.js';
import { drawRotated, layoutPose, renderPose } from './rig.js';
import { type Bitmap, type Pose, type Sprite, compositeFrame } from './sprite.js';

export interface AnimIssue {
  severity: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  frames: number[];
}

export interface AnimTrail {
  name: string;
  color: [number, number, number];
  points: [number, number][];
}

export interface AnimReport {
  tag: string;
  from: number;
  to: number;
  loop: boolean;
  /** 100 = no problem found. Errors cost 15 points, warnings 5. */
  score: number;
  issues: AnimIssue[];
  metrics: {
    frames: number;
    totalMs: number;
    /** Height of the up-and-down motion of the figure's center, in pixels. */
    bob: number;
    /** Largest and median share of the figure that changes between two frames. */
    maxChange: number;
    medianChange: number;
  };
  trails: AnimTrail[];
  /** Tag-relative frames rendered for the motion map. */
  images: Bitmap[];
}

const LOOPING = /^(idle|walk|run|fall)/;
const MOVING = /^(walk|run)/;
const ATTACK = /^(attack|slash|strike)/;
const FOOT_PRIORITY: RegExp[] = [/^foot_/, /^shin_/, /^leg_/];
const TRAIL_COLORS: [number, number, number][] = [[230, 40, 60], [30, 110, 240], [20, 170, 90], [240, 140, 20], [150, 60, 220], [0, 170, 190]];

/** The frame without its ground shadow. */
function figure(s: Sprite, frame: number): Bitmap {
  const pose = s.frames[frame].pose;
  if (pose && s.rig) return renderPose(s, { ...pose, parts: { ...pose.parts, shadow: { ...pose.parts.shadow, hide: true } } });
  return compositeFrame(s, frame);
}

function opaque(b: Bitmap): number {
  let n = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i]) n++;
  return n;
}

/** Share of the figure that differs between two frames (silhouette or color). */
function changeRatio(a: Bitmap, b: Bitmap): number {
  let union = 0;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const ao = a.data[i + 3] > 0;
    const bo = b.data[i + 3] > 0;
    if (!ao && !bo) continue;
    union++;
    if (ao !== bo || a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
  }
  return union ? diff / union : 0;
}

/** Sizes of the 8-connected pieces of the figure, biggest first. */
function pieces(b: Bitmap): number[] {
  const seen = new Uint8Array(b.width * b.height);
  const out: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !b.data[start * 4 + 3]) continue;
    const stack = [start];
    seen[start] = 1;
    let n = 0;
    while (stack.length) {
      const p = stack.pop()!;
      n++;
      const x = p % b.width;
      const y = (p - x) / b.width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= b.width || ny >= b.height) continue;
          const q = ny * b.width + nx;
          if (seen[q] || !b.data[q * 4 + 3]) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    out.push(n);
  }
  return out.sort((x, y) => y - x);
}

function centerOfMass(b: Bitmap): [number, number] {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (!b.data[(y * b.width + x) * 4 + 3]) continue;
      sx += x;
      sy += y;
      n++;
    }
  }
  return n ? [sx / n, sy / n] : [b.width / 2, b.height / 2];
}

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** World position of a local point of a placed part. */
function worldOf(p: ReturnType<typeof layoutPose>[number], local: [number, number]): [number, number] {
  const a = (p.rot * Math.PI) / 180;
  const lx = (local[0] - p.view!.pivot[0]) * p.sx;
  const ly = (local[1] - p.view!.pivot[1]) * p.sy;
  return [p.px + lx * Math.cos(a) - ly * Math.sin(a), p.py + lx * Math.sin(a) + ly * Math.cos(a)];
}

/** The lowest opaque point of a part's drawing, in part coordinates. */
function solePoint(p: ReturnType<typeof layoutPose>[number]): [number, number] {
  const b = p.view!.bmp;
  for (let y = b.height - 1; y >= 0; y--) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < b.width; x++) {
      if (getPixel(b, x, y)[3]) {
        sum += x;
        n++;
      }
    }
    if (n) return [sum / n, y];
  }
  return [p.view!.pivot[0], p.view!.pivot[1]];
}

/** The point of a part's drawing farthest from its pivot: hand, blade tip, top of the head. */
function farPoint(p: ReturnType<typeof layoutPose>[number]): [number, number] {
  const b = p.view!.bmp;
  const [px, py] = p.view!.pivot;
  let best: [number, number] = [px, py];
  let bd = -1;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (!getPixel(b, x, y)[3]) continue;
      const d = Math.hypot(x - px, y - py);
      if (d > bd) {
        bd = d;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Feet of the rig: the lowest segment of each leg. */
function footParts(s: Sprite): string[] {
  const names = s.rig?.parts.map((p) => p.name) ?? [];
  const legs = names.filter((n) => n.startsWith('leg_')).map((n) => n.slice(4));
  return legs.map((id) => FOOT_PRIORITY.map((re) => names.find((n) => re.test(n) && n.endsWith('_' + id))).find(Boolean)!).filter(Boolean);
}

/** Share of a part's pixels whose color changes while it only rotates a little: RotSprite crawl. */
function crawl(p0: ReturnType<typeof layoutPose>[number], p1: ReturnType<typeof layoutPose>[number]): number | null {
  const size = Math.ceil(Math.hypot(p0.view!.bmp.width, p0.view!.bmp.height)) * 2 + 4;
  const mk = (): Bitmap => ({ width: size, height: size, data: new Uint8ClampedArray(size * size * 4) });
  const a = mk();
  const b = mk();
  const c = Math.floor(size / 2);
  drawRotated(a, p0.view!.bmp, p0.view!.pivot, c, c, p0.rot, p0.sx, p0.sy);
  drawRotated(b, p1.view!.bmp, p1.view!.pivot, c, c, p1.rot, p1.sx, p1.sy);
  let both = 0;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (!a.data[i + 3] || !b.data[i + 3]) continue;
    both++;
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) diff++;
  }
  return both >= 8 ? diff / both : null;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const list = (v: number[]) => v.join(', ');

/** Analyses one tag. `loop` defaults to true for idle/walk/run/fall tags and pingpong tags. */
export function checkAnimation(s: Sprite, tagName: string, opts: { loop?: boolean } = {}): AnimReport {
  const tag = s.tags.find((t) => t.name === tagName);
  if (!tag) throw new Error(`No tag named "${tagName}". Tags: ${s.tags.map((t) => t.name).join(', ') || 'none'}`);
  const loop = opts.loop ?? (LOOPING.test(tag.name) || tag.direction === 'pingpong');
  const idx: number[] = [];
  for (let i = tag.from; i <= tag.to; i++) idx.push(i);
  const n = idx.length;
  const images = idx.map((i) => figure(s, i));
  const issues: AnimIssue[] = [];
  const issue = (severity: AnimIssue['severity'], code: string, message: string, frames: number[] = []) => issues.push({ severity, code, message, frames });
  const durations = idx.map((i) => s.frames[i].duration);

  // Detached pieces.
  const detached = idx.filter((_, k) => pieces(images[k]).slice(1).some((size) => size >= 2));
  if (detached.length) issue('error', 'detached', `The figure breaks into separate pieces: a joint opens or a part floats (check overlap between parts). Frames: ${list(detached)}.`, detached);

  // Empty frames.
  const empty = idx.filter((_, k) => opaque(images[k]) === 0);
  if (empty.length) issue('error', 'empty', `Frames with nothing drawn: ${list(empty)}.`, empty);

  // Change between frames.
  const change: number[] = [];
  for (let k = 1; k < n; k++) change.push(changeRatio(images[k - 1], images[k]));
  const med = median(change);
  const maxChange = change.length ? Math.max(...change) : 0;
  const wasted = idx.filter((_, k) => k > 0 && change[k - 1] < 0.005);
  if (wasted.length && n > 2) issue('warn', 'duplicates', `Frames identical to the previous one: ${list(wasted)}. Remove them or hold the frame with a longer duration.`, wasted);
  const pops = idx.filter((_, k) => k > 0 && change[k - 1] > 0.25 && change[k - 1] > med * 3);
  if (pops.length && !ATTACK.test(tag.name)) issue('warn', 'pop', `Sudden jump compared to the other frames at: ${list(pops)}. Add an inbetween or spread the motion.`, pops);

  // Loop point.
  if (loop && n > 2) {
    const seam = changeRatio(images[n - 1], images[0]);
    if (seam > 0.25 && seam > maxChange * 1.3) issue('error', 'loop_seam', `The last frame does not lead back into the first: ${pct(seam)} of the figure jumps there (largest other step ${pct(maxChange)}).`, [tag.to, tag.from]);
  }

  // Weight: vertical motion of the figure.
  const com = images.map(centerOfMass);
  const ys = com.map((c) => c[1]);
  const bob = Math.max(...ys) - Math.min(...ys);
  if (MOVING.test(tag.name) && bob < 0.4) issue('warn', 'no_weight', `The figure barely rises and falls (${bob.toFixed(1)}px): it will look like it glides. It should drop on contact and rise while passing.`);

  // Timing.
  const allEven = durations.every((d) => d === durations[0]);
  if (allEven && n >= 4 && !/^idle/.test(tag.name)) issue('info', 'even_timing', `Every frame lasts ${durations[0]}ms. Holding the key poses a little longer gives the motion more snap.`);

  const trails: AnimTrail[] = [{ name: 'center', color: [120, 120, 120], points: com }];
  const rigged = !!s.rig && idx.every((i) => s.frames[i].pose);
  if (rigged) {
    const poses = idx.map((i) => s.frames[i].pose as Pose);
    const layouts = poses.map((p) => layoutPose(s, p));
    const facing = poses[0].facing;
    const side = facing === 'left' || facing === 'right';
    const at = (k: number, name: string) => layouts[k].find((p) => p.part.name === name);

    // Feet.
    const feet = footParts(s).filter((f) => at(0, f)?.view);
    const soles = feet.map((f) => layouts.map((_, k) => {
      const p = at(k, f);
      return p?.view ? worldOf(p, solePoint(p)) : ([0, 0] as [number, number]);
    }));
    feet.forEach((f, i) => trails.push({ name: f, color: TRAIL_COLORS[i % TRAIL_COLORS.length], points: soles[i] }));
    if (feet.length) {
      const ground = Math.max(...soles.flat().map((p) => p[1]));
      const moving = MOVING.test(tag.name);
      const back = facing === 'left' ? 1 : -1;
      feet.forEach((f, i) => {
        const stance = soles[i].map((p) => p[1] >= ground - 0.75);
        for (let k = 0; k < n; k++) {
          const next = (k + 1) % n;
          if (next === 0 && !loop) break;
          if (!stance[k] || !stance[next]) continue;
          const dx = soles[i][next][0] - soles[i][k][0];
          if (!side) continue;
          if (moving && dx * back < -1) issue('error', 'foot_skate', `${f} slides the wrong way while planted, between frames ${idx[k]} and ${idx[next]} (${dx.toFixed(1)}px).`, [idx[k], idx[next]]);
          if (!moving && !ATTACK.test(tag.name) && Math.abs(dx) >= 1.5) issue('warn', 'foot_slide', `${f} slides ${Math.abs(dx).toFixed(1)}px while it should stay planted, between frames ${idx[k]} and ${idx[next]}.`, [idx[k], idx[next]]);
        }
        if (moving && side) {
          // A planted foot must travel backward at a steady speed under the body.
          const speeds: number[] = [];
          for (let k = 0; k < n - 1; k++) if (stance[k] && stance[k + 1]) speeds.push((soles[i][k + 1][0] - soles[i][k][0]) * back);
          if (speeds.length >= 2 && Math.max(...speeds) - Math.min(...speeds) > 2.5) issue('warn', 'foot_speed', `${f} changes speed while planted (${speeds.map((v) => v.toFixed(1)).join(', ')} px per frame). It should move back steadily.`);
          if (!stance.some(Boolean)) issue('warn', 'foot_float', `${f} never touches the ground in this cycle.`);
        }
      });
      const airborne = idx.filter((_, k) => !soles.some((sole) => sole[k][1] >= ground - 0.75));
      if (/^walk/.test(tag.name) && side && airborne.length) issue('warn', 'walk_flight', `No foot on the ground at frames ${list(airborne)}: a walk always keeps one foot down.`, airborne);
    }

    // Hands, weapon tip and head.
    const tips = (s.rig?.parts ?? []).map((p) => p.name).filter((name) => /^(weapon|forearm_|head)/.test(name) || (/^arm_/.test(name) && !s.rig!.parts.some((q) => q.parent === name && q.name.startsWith('forearm_'))));
    tips.forEach((name, i) => {
      if (!at(0, name)?.view) return;
      trails.push({ name, color: TRAIL_COLORS[(i + feet.length) % TRAIL_COLORS.length], points: layouts.map((_, k) => { const p = at(k, name); return p?.view ? worldOf(p, farPoint(p)) : ([0, 0] as [number, number]); }) });
    });

    // One-shot strikes: the fast part has to be the shortest.
    if (ATTACK.test(tag.name) && n >= 3) {
      const weapon = trails.find((t) => t.name.startsWith('weapon')) ?? trails.find((t) => /^(forearm_|arm_)/.test(t.name));
      if (weapon) {
        const speeds = weapon.points.slice(1).map((p, k) => Math.hypot(p[0] - weapon.points[k][0], p[1] - weapon.points[k][1]));
        const fastest = speeds.indexOf(Math.max(...speeds));
        const strike = durations[fastest + 1];
        const hold = Math.max(...durations.slice(0, fastest + 1));
        if (strike >= hold) issue('warn', 'no_snap', `The fastest frame (${idx[fastest + 1]}, ${strike}ms) is not shorter than the wind-up (${hold}ms): the strike has no snap.`, [idx[fastest + 1]]);
      }
    }

    // Strikes come from the whole body: the torso has to turn or the legs have to move, not only the arm.
    if (ATTACK.test(tag.name) && n >= 3 && side) {
      const range = (name: string) => {
        const placed = layouts.map((_, k) => at(k, name)).filter((p) => p?.view);
        if (placed.length < n) return null;
        return Math.max(...placed.map((p) => p!.rot)) - Math.min(...placed.map((p) => p!.rot));
      };
      const torso = range('body');
      if (torso !== null && torso < 4) issue('warn', 'stiff_body', `Only the arm moves: the torso turns ${torso.toFixed(0)}° in the whole strike. Twist it back in the wind-up and forward on the hit.`);
    }

    // Pixel crawl on parts that turn by small angles.
    for (const part of s.rig!.parts) {
      const values: number[] = [];
      for (let k = 1; k < n; k++) {
        const a = at(k - 1, part.name);
        const b = at(k, part.name);
        if (!a?.view || !b?.view || poses[k - 1].parts[part.name]?.variant !== poses[k].parts[part.name]?.variant) continue;
        const d = Math.abs(a.rot - b.rot);
        if (d < 0.5 || d > 20) continue;
        const c = crawl(a, b);
        if (c !== null) values.push(c);
      }
      if (values.length >= 2) {
        const avg = values.reduce((x, y) => x + y, 0) / values.length;
        if (avg > 0.4) issue('info', 'pixel_crawl', `${part.name}: ${pct(avg)} of its pixels change color while it turns by small angles, so its detail shimmers. Fewer, larger angle steps or a simpler texture help.`);
      }
    }
  }

  const score = Math.max(0, 100 - issues.reduce((sum, i) => sum + (i.severity === 'error' ? 15 : i.severity === 'warn' ? 5 : 0), 0));
  return {
    tag: tag.name,
    from: tag.from,
    to: tag.to,
    loop,
    score,
    issues,
    metrics: { frames: n, totalMs: durations.reduce((a, b) => a + b, 0), bob, maxChange, medianChange: med },
    trails,
    images,
  };
}

/** Text summary shared by the MCP tool and the editor. */
export function formatAnimReport(r: AnimReport): string {
  const head = `${r.tag}: score ${r.score}/100 — ${r.metrics.frames} frames, ${r.metrics.totalMs}ms${r.loop ? ', loop' : ''}, bob ${r.metrics.bob.toFixed(1)}px, change per frame median ${pct(r.metrics.medianChange)} / max ${pct(r.metrics.maxChange)}`;
  const label = { error: 'ERROR', warn: 'WARN', info: 'NOTE' } as const;
  const lines = r.issues.map((i) => `  ${label[i.severity]} [${i.code}] ${i.message}`);
  return [head, ...(lines.length ? lines : ['  No problems found.'])].join('\n');
}

/**
 * Motion map: every frame overlaid in gray, with the path of the center, feet, hands, weapon and head drawn on top.
 * A dot marks each frame; the path's first frame is white-ringed. Bunched dots mean slow motion, spread dots fast motion.
 */
export function renderMotionMap(s: Sprite, r: AnimReport, scale = 6): Bitmap {
  const W = s.width * scale;
  const H = s.height * scale;
  const out: Bitmap = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const counts = new Uint16Array(s.width * s.height);
  for (const img of r.images) for (let i = 0; i < counts.length; i++) if (img.data[i * 4 + 3]) counts[i]++;
  const max = Math.max(1, r.images.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = counts[Math.floor(y / scale) * s.width + Math.floor(x / scale)];
      const v = c ? Math.round(225 - (c / max) * 90) : 248;
      setPixel(out, x, y, [v, v, v, 255]);
    }
  }
  const dot = (x: number, y: number, rad: number, c: [number, number, number]) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) if (dx * dx + dy * dy <= rad * rad) setPixel(out, x + dx, y + dy, [c[0], c[1], c[2], 255]);
  };
  const toPx = (p: [number, number]): [number, number] => [Math.round((p[0] + 0.5) * scale), Math.round((p[1] + 0.5) * scale)];
  for (const t of r.trails) {
    const pts = t.points.map(toPx);
    const closed = r.loop ? [...pts, pts[0]] : pts;
    for (let i = 1; i < closed.length; i++) {
      for (const [x, y] of linePoints(closed[i - 1][0], closed[i - 1][1], closed[i][0], closed[i][1])) setPixel(out, x, y, [t.color[0], t.color[1], t.color[2], 255]);
    }
    pts.forEach(([x, y], i) => {
      if (i === 0) dot(x, y, 4, [255, 255, 255]);
      dot(x, y, 2, t.color);
    });
  }
  return out;
}
