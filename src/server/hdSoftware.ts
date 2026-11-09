/**
 * The 2D-HD perspective without a GPU: the geometry of runtime/hdScene.ts drawn into a bitmap, for the MCP previews and the
 * headless screenshots. Same camera, same walls (wallQuads), same order of what covers what; light is the unshaped branch
 * of the browser's shader, without the normals, which is enough to judge architecture.
 */

import type { CastShape, ScreenLight } from '../core/game/atmosphere.js';
import type { Renderer, WorldMark } from '../core/game/engine.js';
import type { PixelFont } from '../core/game/font.js';
import { type HdFrame, type ResolvedHd, applyHdBuffer } from '../core/game/hd.js';
import { type Camera3d, type WallCell, makeCamera, overscanOf, projectWorld, wallQuads, worldPoint } from '../core/game/hd3d.js';
import type { ResolvedRelief } from '../core/game/relief.js';
import type { Bitmap } from '../core/sprite.js';
import type { BitmapRenderer } from './game.js';

type Vec3 = readonly [number, number, number];

interface Quad {
  sheet: Bitmap;
  src: readonly [number, number, number, number];
  at: readonly Vec3[];
  flat: readonly (readonly [number, number])[];
  depth: number;
  mirror: boolean;
  color: readonly [number, number, number, number];
  lit: boolean;
  blend: 0 | 1 | 2;
  z: number;
}

const MAX_Z = 40;
const WHITE: Bitmap = { width: 1, height: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };

const rgb = (c: string): [number, number, number] => {
  let s = c.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((x) => x + x).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export class SoftHdRenderer implements Renderer {
  overscan: { left: number; top: number; right: number; bottom: number };
  wallRows: number;
  private readonly cam: Camera3d;
  private inWorld = false;
  private markNow: WorldMark = { kind: 'backdrop' };
  private lists: Record<'backdrop' | 'ground' | 'stand' | 'air' | 'screen', Quad[]> = { backdrop: [], ground: [], stand: [], air: [], screen: [] };
  private ambient: [number, number, number] = [1, 1, 1];
  private lights: ScreenLight[] = [];
  private glow = 0;
  private grading: { tint: string; amount: number } | null = null;
  private vignetting: { strength: number; color: string } | null = null;
  private readonly vw: number;
  private readonly vh: number;

  /** `effects` false leaves out bloom, depth of field and haze: for looking at the shape of a place. */
  constructor(private readonly base: BitmapRenderer, private readonly sheets: Map<string, Bitmap>, private readonly hd: ResolvedHd, private readonly effects = true) {
    this.vw = base.out.width;
    this.vh = base.out.height;
    this.cam = makeCamera(this.vw, this.vh, hd.perspective, hd.elevation);
    this.overscan = overscanOf(this.cam);
    this.wallRows = Math.round(hd.wallRows);
  }

  mark(m: WorldMark): void {
    this.markNow = m;
  }

  clear(color: string): void {
    this.inWorld = true;
    this.markNow = { kind: 'backdrop' };
    this.base.clear(color);
    this.ambient = [1, 1, 1];
    this.lights = [];
    this.glow = 0;
    this.grading = null;
    this.vignetting = null;
    for (const k of Object.keys(this.lists) as (keyof typeof this.lists)[]) this.lists[k] = [];
  }

  lighting(ambient: string, lights: ScreenLight[], glow: number): void {
    this.ambient = rgb(ambient);
    this.lights = lights;
    this.glow = glow;
  }

  reliefLighting(_relief: ResolvedRelief, ambient: string, lights: ScreenLight[], glow: number): void {
    this.lighting(ambient, lights, glow);
  }

  grade(tint: string, amount: number): void {
    this.grading = { tint, amount };
  }

  vignette(strength: number, color: string): void {
    this.vignetting = { strength, color };
  }

  text(text: string, x: number, y: number, color: string, scale: number, font?: PixelFont): void {
    this.base.text(text, x, y, color, scale, font);
  }

  private placed(): { list: keyof SoftHdRenderer['lists']; point: (x: number, y: number) => Vec3; depthOf: (y: number) => number; z: number; lit: boolean } {
    const cam = this.cam;
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const flat = (x: number, y: number): Vec3 => [x - cx, 0, y - cy];
    const onGround = (x: number, y: number): Vec3 => worldPoint(cam, x - cx, y - cy);
    const raise = this.hd.wallHeight;
    const m = this.markNow;
    switch (m.kind) {
      case 'backdrop': return { list: 'backdrop', point: flat, depthOf: () => this.vh * 2, z: 0, lit: false };
      case 'screen': return { list: 'screen', point: flat, depthOf: (y) => y - cy, z: 0, lit: false };
      case 'air': return { list: 'air', point: onGround, depthOf: (y) => y - cy, z: 0, lit: false };
      case 'ground': return { list: 'ground', point: onGround, depthOf: (y) => y - cy, z: 0, lit: true };
      case 'wall': return { list: 'stand', depthOf: () => m.foot - cy + 1, point: (x, y) => worldPoint(cam, x - cx, m.foot - cy, (m.foot - y) * raise), z: m.z, lit: true };
      case 'top': return { list: 'stand', depthOf: (y) => y + m.h - cy, point: (x, y) => worldPoint(cam, x - cx, y + m.h - cy, m.h * raise), z: m.z, lit: true };
      case 'stand': {
        const base = worldPoint(cam, m.x - cx, m.y - cy);
        return { list: 'stand', depthOf: () => m.y - cy, z: m.z, lit: true, point: (x, y) => {
          const h = m.y - y;
          return [base[0] + (x - m.x), h * cam.cos, base[2] - h * cam.sin];
        } };
      }
    }
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number; flat?: boolean; white?: number }): void {
    if (!this.inWorld) return this.base.image(sprite, sx, sy, sw, sh, dx, dy, o);
    const sheet = this.sheets.get(sprite);
    if (!sheet) return;
    const k = o.scale ?? 1;
    const w = sw * k;
    const h = sh * k;
    const corners: [number, number][] = [[dx, dy], [dx + w, dy], [dx + w, dy + h], [dx, dy + h]];
    if (o.angle) {
      const a = (o.angle * Math.PI) / 180;
      const cx = dx + w / 2;
      const cy = dy + h / 2;
      for (const c of corners) {
        const x = c[0] - cx;
        const y = c[1] - cy;
        c[0] = cx + x * Math.cos(a) - y * Math.sin(a);
        c[1] = cy + x * Math.sin(a) + y * Math.cos(a);
      }
    }
    const p = this.placed();
    const hung = this.markNow;
    const out = hung.kind === 'wall' && hung.relief ? hung.relief + 1 : 0;
    const at = out && hung.kind === 'wall'
      ? corners.map(([x, y]) => worldPoint(this.cam, x - this.vw / 2, hung.foot - this.vh / 2 + out, (hung.foot - y) * this.hd.wallHeight))
      : corners.map(([x, y]) => p.point(x, y));
    this.lists[p.list].push({ sheet, src: [sx, sy, sx + sw, sy + sh], at, flat: corners, depth: p.depthOf(dy + h) + out, mirror: o.flipX, color: [1, 1, 1, o.opacity], lit: p.lit, blend: o.opacity < 1 || p.list === 'air' || p.list === 'screen' ? 1 : 0, z: p.z });
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1, blend?: 'add'): void {
    if (!this.inWorld) return this.base.rect(x, y, w, h, color, alpha, blend);
    const p = this.placed();
    const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const [r, g, b] = rgb(color);
    this.lists[p.list].push({ sheet: WHITE, src: [0, 0, 1, 1], at: corners.map(([px, py]) => p.point(px, py)), flat: corners, depth: p.depthOf(y + h), mirror: false, color: [r, g, b, alpha], lit: false, blend: blend === 'add' ? 2 : 1, z: 0 });
  }

  stamp(shape: CastShape, x: number, y: number, zoom: number, color: string, alpha: number, slice?: { row: number; rows: number }): void {
    const [r, g, b] = rgb(color);
    const sheet: Bitmap = { width: Math.max(1, shape.width), height: Math.max(1, shape.height), data: new Uint8ClampedArray(Math.max(1, shape.width) * Math.max(1, shape.height) * 4) };
    for (let i = 0; i < shape.runs.length; i += 3) {
      const row = shape.runs[i + 1]!;
      for (let c = shape.runs[i]!; c < shape.runs[i]! + shape.runs[i + 2]!; c++) sheet.data.set([r * 255, g * 255, b * 255, 255], (row * sheet.width + c) * 4);
    }
    const row = slice?.row ?? 0;
    const rows = slice?.rows ?? shape.height;
    const top = y + row * zoom;
    const corners: [number, number][] = [[x, top], [x + shape.width * zoom, top], [x + shape.width * zoom, top + rows * zoom], [x, top + rows * zoom]];
    const p = this.placed();
    this.lists[p.list].push({ sheet, src: [0, row, shape.width, row + rows], at: corners.map(([px, py]) => p.point(px, py)), flat: corners, depth: p.depthOf(top), mirror: false, color: [1, 1, 1, alpha], lit: false, blend: 1, z: 0 });
  }

  tileWall(sprite: string, sx: number, sy: number, sw: number, sh: number, x: number, y: number, size: number, cell: WallCell, sides: ([number, number] | null)[] | null): void {
    if (!this.inWorld) return;
    const sheet = this.sheets.get(sprite);
    if (!sheet) return;
    for (const q of wallQuads(this.cam, this.hd.wallHeight, this.hd.wallTrim, sx, sy, sw, sh, x, y, size, cell, sides)) this.lists.stand.push({ sheet, src: q.src, at: q.at, flat: q.flat, depth: q.depth, mirror: false, color: q.color, lit: true, blend: 0, z: 0 });
  }

  endWorld(frame: HdFrame | null): void {
    this.inWorld = false;
    if (!frame) return;
    const out = this.base.out;
    const sort = new Float32Array(out.width * out.height).fill(-1);
    this.paint(this.lists.backdrop, false, sort, true);
    this.paint(this.lists.ground, false, sort, false);
    this.paint(this.lists.stand, true, sort, false);
    this.paint(this.lists.air, false, sort, false);
    this.paint(this.lists.screen, false, sort, true);
    if (this.grading) this.base.grade(this.grading.tint, this.grading.amount);
    if (this.vignetting) this.base.vignette(this.vignetting.strength, this.vignetting.color);
    if (!this.effects) return;
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const placed = frame.lights.map((l) => {
      const s = projectWorld(this.cam, worldPoint(this.cam, l.x - cx, l.y - cy));
      return { ...l, x: s.x + cx, y: s.y + cy, radius: l.radius * s.scale };
    });
    applyHdBuffer(out.data, out.width, out.height, { ...frame, lights: placed });
  }

  private paint(list: Quad[], depthTest: boolean, sortBuffer: Float32Array, flatPlane: boolean): void {
    for (const q of list) {
      const [sx0, sy0, sx1, sy1] = q.src;
      const us = q.mirror ? [sx1, sx0, sx0, sx1] : [sx0, sx1, sx1, sx0];
      const vs = [sy0, sy0, sy1, sy1];
      const depth = Math.min(1, Math.max(0, ((q.depth + this.vh / 2) / this.vh + 1) / 3));
      const sort = (depth + Math.min(MAX_Z, Math.max(0, q.z))) / (MAX_Z + 1);
      const v = q.at.map((p, c) => this.project(p, us[c]!, vs[c]!, q.flat[c]!, flatPlane));
      if (v.some((p) => !p)) continue;
      this.triangle(q, v[0]!, v[1]!, v[2]!, sort, depthTest, sortBuffer);
      this.triangle(q, v[0]!, v[2]!, v[3]!, sort, depthTest, sortBuffer);
    }
  }

  private project(p: Vec3, u: number, v: number, flat: readonly [number, number], flatPlane: boolean): number[] | null {
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    if (flatPlane) return [p[0] + cx, p[2] + cy, 1, u, v, flat[0], flat[1]];
    const { distance: d, sin: s, cos: c, near } = this.cam;
    const w = d - p[2] * c - p[1] * s;
    if (w < near) return null;
    const k = d / w;
    return [p[0] * k + cx, (p[2] * s - p[1] * c) * k + cy, 1 / w, u / w, v / w, flat[0] / w, flat[1] / w];
  }

  private triangle(q: Quad, a: number[], b: number[], c: number[], sort: number, depthTest: boolean, sortBuffer: Float32Array): void {
    const out = this.base.out;
    const W = out.width;
    const H = out.height;
    const area = (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);
    if (Math.abs(area) < 1e-6) return;
    const x0 = Math.max(0, Math.floor(Math.min(a[0]!, b[0]!, c[0]!)));
    const y0 = Math.max(0, Math.floor(Math.min(a[1]!, b[1]!, c[1]!)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0]!, b[0]!, c[0]!)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1]!, b[1]!, c[1]!)));
    const flatPlane = a[2] === 1 && b[2] === 1 && c[2] === 1;
    const [srcL, srcT, srcR, srcB] = q.src;
    const left = Math.min(srcL, srcR);
    const right = Math.max(srcL, srcR);
    const d = out.data;
    const tex = q.sheet;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((b[0]! - px) * (c[1]! - py) - (b[1]! - py) * (c[0]! - px)) / area;
        const w1 = ((c[0]! - px) * (a[1]! - py) - (c[1]! - py) * (a[0]! - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const i = y * W + x;
        if (depthTest && sort < sortBuffer[i]!) continue;
        const oow = flatPlane ? 1 : w0 * a[2]! + w1 * b[2]! + w2 * c[2]!;
        const at = (n: number) => (w0 * a[n]! + w1 * b[n]! + w2 * c[n]!) / oow;
        const u = Math.min(right - 1, Math.max(left, Math.floor(at(3))));
        const v = Math.min(srcB - 1, Math.max(srcT, Math.floor(at(4))));
        const t = (v * tex.width + u) * 4;
        let alpha = (tex.data[t + 3]! / 255) * q.color[3];
        if (!q.blend && alpha < 0.5) continue;
        if (!q.blend) alpha = 1;
        if (alpha <= 0) continue;
        let r = (tex.data[t]! / 255) * q.color[0];
        let g = (tex.data[t + 1]! / 255) * q.color[1];
        let bl = (tex.data[t + 2]! / 255) * q.color[2];
        if (q.lit) [r, g, bl] = this.light(r, g, bl, at(5), at(6));
        const o = i * 4;
        if (q.blend === 2) {
          d[o] = d[o]! + r * alpha * 255;
          d[o + 1] = d[o + 1]! + g * alpha * 255;
          d[o + 2] = d[o + 2]! + bl * alpha * 255;
        } else {
          d[o] = d[o]! * (1 - alpha) + r * alpha * 255;
          d[o + 1] = d[o + 1]! * (1 - alpha) + g * alpha * 255;
          d[o + 2] = d[o + 2]! * (1 - alpha) + bl * alpha * 255;
        }
        d[o + 3] = 255;
        if (depthTest && !q.blend) sortBuffer[i] = sort;
      }
    }
  }

  private light(r: number, g: number, b: number, fx: number, fy: number): [number, number, number] {
    let lr = this.ambient[0];
    let lg = this.ambient[1];
    let lb = this.ambient[2];
    let ar = 0;
    let ag = 0;
    let ab = 0;
    for (const l of this.lights.slice(0, 16)) {
      const dist = Math.hypot(l.x - fx, l.y - fy);
      const radius = Math.max(1, l.radius);
      if (dist >= radius) continue;
      const t = 1 - dist / radius;
      const f = t * t * Math.min(1, l.intensity);
      const [cr, cg, cb] = rgb(l.color);
      lr += cr * f;
      lg += cg * f;
      lb += cb * f;
      const gl = Math.min(1, l.intensity * this.glow * 0.35);
      if (gl > 0 && dist < radius * 0.7) {
        const tg = 1 - dist / (radius * 0.7);
        ar += cr * tg * tg * gl;
        ag += cg * tg * tg * gl;
        ab += cb * tg * tg * gl;
      }
    }
    return [r * Math.min(1, lr) + ar, g * Math.min(1, lg) + ag, b * Math.min(1, lb) + ab];
  }
}
