/**
 * The 2D-HD perspective view: stands in for the game's renderer while the world is drawn and turns every draw call into
 * geometry, with the ground on a tilted plane, walls raised from the map and sprites upright where their feet are.
 * Light is computed here, per pixel, with the same formulas as relief.ts and on the same flat coordinates, so a scene
 * keeps the lighting it was tuned with. The interface is forwarded to the game's canvas, untouched.
 */

import type { CastShape, ScreenLight } from '../core/game/atmosphere.js';
import type { Renderer, WorldMark } from '../core/game/engine.js';
import type { PixelFont } from '../core/game/font.js';
import type { ReflectionBand, WaterPiece } from '../core/game/reflections.js';
import type { HdFrame, ResolvedHd } from '../core/game/hd.js';
import { type Camera3d, type HdShape, type SpriteProfile, type WallCell, cameraMatrix, flatMatrix, makeCamera, overscanOf, projectWorld, shapeSurface, spriteProfile, wallQuads, worldPoint } from '../core/game/hd3d.js';
import type { ResolvedRelief } from '../core/game/relief.js';
import type { CanvasRenderer } from './canvasRenderer.js';
import type { HdCompositor, ProgramInfo } from './hdCompositor.js';

const MAX_LIGHTS = 16;
/** position 3, uv 2, rect 4, color 4, flat position 2, depth 1, misc 4, sort 1, bend 1. */
const FLOATS = 22;
/** Bend of everything that isn't wrapped on a solid. */
const NO_BEND = 2;
/** Highest draw order that still counts: above this, everything is just in front. */
const MAX_Z = 40;
const VERTICES_PER_QUAD = 6;

const VERTEX = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUv;
layout(location=2) in vec4 aRect;
layout(location=3) in vec4 aColor;
layout(location=4) in vec2 aFlat;
layout(location=5) in float aDepth;
layout(location=6) in vec4 aMisc;
layout(location=7) in float aSort;
layout(location=8) in float aBend;
uniform mat4 matrix;
out vec2 vUv;
flat out vec4 vRect;
out vec4 vColor;
out vec2 vFlat;
out float vDepth;
flat out vec4 vMisc;
flat out float vBend;
void main() {
  vBend = aBend;
  vUv = aUv; vRect = aRect; vColor = aColor; vFlat = aFlat; vDepth = aDepth; vMisc = aMisc;
  gl_Position = matrix * vec4(aPos, 1.0);
  // Who covers whom follows the game's own order, the one the flat picture is painted in, not the distance from the
  // camera: otherwise a wall that leans towards the camera would cut the head off whoever stands in front of it.
  gl_Position.z = (1.0 - 2.0 * aSort) * gl_Position.w;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
flat in vec4 vRect;
in vec4 vColor;
in vec2 vFlat;
in float vDepth;
flat in vec4 vMisc;
flat in float vBend;
uniform sampler2D albedo;
uniform sampler2D normals;
uniform vec2 texSize;
uniform float blended, hasNormals, relief, strength, bands, rimLight, lightHeight, sunOn, sunIntensity, glow;
uniform vec3 ambient, sunDir, sunColor, sunShade;
uniform int lightCount;
uniform vec4 lights[${MAX_LIGHTS}];
uniform vec3 lightColors[${MAX_LIGHTS}];
out vec4 o;

float band(float v) { return bands > 0.0 ? floor(v * bands + 0.5) / bands : v; }

void main() {
  // Square pixels with a soft one-screen-pixel edge, kept inside this sprite's own frame on the sheet.
  vec2 cell = floor(vUv + 0.5);
  vec2 uv = cell + clamp((vUv - cell) / max(fwidth(vUv), vec2(0.0001)), -0.5, 0.5);
  uv = clamp(uv, vRect.xy + 0.5, vRect.zw - 0.5) / texSize;
  vec4 c = texture(albedo, uv) * vColor;
  if (blended < 0.5 && c.a < 0.5) discard;

  if (vMisc.x > 0.5) {
    vec4 n = vMisc.y > 0.5 && hasNormals > 0.5 ? texture(normals, uv) : vec4(0.0);
    bool shaped = n.a > 0.5 && relief > 0.5;
    vec3 nv = vec3(0.0, 0.0, 1.0);
    if (shaped) {
      nv.xy = n.rg * 255.0 / 127.5 - 1.0;
      if (vMisc.z > 0.5 && vMisc.z < 1.5) nv.x = -nv.x;
      nv.z = sqrt(max(0.0, 1.0 - dot(nv.xy, nv.xy)));
      // The side of a wall: its art runs along the depth, and it faces east or west instead of the camera.
      if (vMisc.z > 1.5) nv = vec3((vMisc.z > 2.5 ? -1.0 : 1.0) * nv.z, nv.x, -nv.y);
      // Wrapped on a solid: the surface turns away, and what is painted on it only adds its detail.
      if (vBend < 1.5) nv = normalize(vec3(vBend + nv.x * 0.35, nv.y, sqrt(max(0.0, 1.0 - vBend * vBend))));
    }
    // A surface turned sideways is all "edge" to the rim light: only a trace of it, or the whole wall would shine.
    float rim = vMisc.z > 1.5 ? rimLight * 0.2 : rimLight;
    vec3 light = ambient;
    if (shaped && strength > 0.0) light *= max(0.3, 1.0 + band(-nv.y * 0.75 * strength));
    vec3 added = vec3(0.0);
    for (int i = 0; i < lightCount; i++) {
      vec2 to = lights[i].xy - vFlat;
      float dist = length(to);
      float radius = lights[i].z;
      if (dist >= radius) continue;
      float t = 1.0 - dist / radius;
      float f = t * t * min(1.0, lights[i].w);
      if (shaped) {
        float lift = radius * lightHeight;
        float len = max(sqrt(dist * dist + lift * lift), 0.0001);
        float side = dot(nv.xy, to);
        float facing = max(0.0, (side + nv.z * lift) / len);
        float shape = clamp(band(1.0 + strength * 2.4 * (facing - lift / len)), 0.08, 2.6);
        float edge = rim > 0.0 && dist > 0.5 ? rim * (1.0 - nv.z) * (1.0 - nv.z) * max(0.0, side / dist) : 0.0;
        f *= shape + edge * 2.0;
      }
      light += lightColors[i] * f;
      float g = min(1.0, lights[i].w * glow * 0.35);
      if (g > 0.0 && dist < radius * 0.7) {
        float tg = 1.0 - dist / (radius * 0.7);
        added += lightColors[i] * tg * tg * g;
      }
    }
    if (shaped) {
      if (sunOn > 0.5) {
        float planar = max(length(sunDir.xy), 0.0001);
        float along = dot(nv.xy, sunDir.xy) / planar;
        float v = band(along * (1.15 - sunDir.z * 0.5) * strength);
        if (v < 0.0) light *= 1.0 + (sunShade - 1.0) * min(1.0, -v * sunIntensity * 1.3);
        float add = v > 0.0 ? v * sunIntensity * 0.7 : 0.0;
        if (rim > 0.0) add += rim * (1.0 - nv.z) * (1.0 - nv.z) * max(0.0, along) * sunIntensity * 0.5;
        light += sunColor * add;
      }
      if (n.b > 0.0) light = max(light, vec3(1.1));
      light = min(light, vec3(1.45));
      vec3 v = c.rgb * light;
      c.rgb = mix(v, min(v, vec3(200.0 / 255.0)) + max(v - 200.0 / 255.0, 0.0) * 0.38, step(1.0, max(light.r, max(light.g, light.b))));
    } else {
      c.rgb *= min(light, vec3(1.0));
    }
    c.rgb += added;
  }

  c.rgb = mix(c.rgb, vec3(1.0), vMisc.w);
  // Solid pixels carry, in alpha, the height on the screen of the ground they stand on: the depth of field reads it.
  o = vec4(c.rgb, blended > 0.5 ? c.a : vDepth);
}`;

/** Consecutive quads sharing their texture and blending. */
interface Batch {
  tex: WebGLTexture;
  normals: WebGLTexture | null;
  size: [number, number];
  blend: 0 | 1 | 2;
  stencil: 0 | 1 | 2 | 3 | 4;
  first: number;
  count: number;
}

class DrawList {
  data = new Float32Array(FLOATS * VERTICES_PER_QUAD * 1024);
  vertices = 0;
  batches: Batch[] = [];

  reset(): void {
    this.vertices = 0;
    this.batches = [];
  }

  room(): number {
    const need = (this.vertices + VERTICES_PER_QUAD) * FLOATS;
    if (need > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    return this.vertices * FLOATS;
  }

  batch(tex: WebGLTexture, normals: WebGLTexture | null, size: [number, number], blend: 0 | 1 | 2, stencil: 0 | 1 | 2 | 3 | 4): void {
    const last = this.batches[this.batches.length - 1];
    if (last && last.tex === tex && last.normals === normals && last.blend === blend && last.stencil === stencil) last.count += VERTICES_PER_QUAD;
    else this.batches.push({ tex, normals, size, blend, stencil, first: this.vertices, count: VERTICES_PER_QUAD });
  }
}

type Sheet = { tex: WebGLTexture; size: [number, number]; normals: WebGLTexture | null };
type Quad = {
  /** World position of the corners: top-left, top-right, bottom-right, bottom-left. */
  at: readonly (readonly [number, number, number])[];
  /** Where the same corners are in the flat picture: the light is computed there. */
  flat: readonly (readonly [number, number])[];
  /** Height on the screen of the ground it stands on, in view pixels. */
  depth: number;
  /** The same, corner by corner, for a surface whose foot runs at an angle (a wall along a line on the ground). */
  depths?: readonly number[];
  sheet: Sheet;
  /** Source rectangle in sheet pixels; `mirror` swaps its left and right. */
  src: readonly [number, number, number, number];
  mirror: boolean;
  color: readonly [number, number, number, number];
  lit: boolean;
  shaped: boolean;
  white: number;
  blend: 0 | 1 | 2;
  /** Draw order of what this belongs to. */
  z?: number;
  /** 1: only marks where water is. 2: shows only over what was marked. */
  stencil?: 0 | 1 | 2 | 3 | 4;
  /** Upside down. */
  flipV?: boolean;
  /** The side of a wall, facing east (1) or west (-1). */
  sideOf?: 1 | -1;
  /** Wrapped on a solid: the sideways part of the direction it faces. */
  bend?: number;
};

const parseColor = (c: string): [number, number, number] => {
  let s = c.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = [...s.slice(0, 3)].map((x) => x + x).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export class HdScene implements Renderer {
  overscan = { left: 0, top: 0, right: 0, bottom: 0 };
  wallRows = 0;

  private readonly gl: WebGL2RenderingContext;
  private readonly program: ProgramInfo;
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private readonly white: Sheet;
  private readonly sheets = new Map<string, Sheet | null>();
  private readonly stamps = new WeakMap<CastShape, { color: string; sheet: Sheet }>();
  private readonly waterMasks = new WeakMap<HTMLCanvasElement, Sheet>();
  private readonly profiles = new Map<string, SpriteProfile | null>();
  private readonly backdrop = new DrawList();
  private readonly ground = new DrawList();
  private readonly stand = new DrawList();
  private readonly air = new DrawList();
  private readonly screen = new DrawList();
  private fbo: WebGLFramebuffer | null = null;
  private color: WebGLTexture | null = null;
  private depth: WebGLRenderbuffer | null = null;
  private fboW = 0;
  private fboH = 0;

  private hd!: ResolvedHd;
  private cam!: Camera3d;
  private inWorld = false;
  private mark_: WorldMark = { kind: 'backdrop' };
  private background: [number, number, number] = [0, 0, 0];
  private ambient: [number, number, number] = [1, 1, 1];
  private lights: ScreenLight[] = [];
  private glow = 0;
  private relief: ResolvedRelief | null = null;
  private grading: { tint: string; amount: number } | null = null;
  private vignetting: { strength: number; color: string } | null = null;

  constructor(
    private readonly compositor: HdCompositor,
    private readonly base: CanvasRenderer,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly images: Map<string, CanvasImageSource>,
    private readonly vw: number,
    private readonly vh: number,
  ) {
    const gl = (this.gl = compositor.gl);
    this.program = compositor.compile(VERTEX, FRAGMENT);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    let offset = 0;
    [3, 2, 4, 4, 2, 1, 4, 1, 1].forEach((n, i) => {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, n, gl.FLOAT, false, FLOATS * 4, offset);
      offset += n * 4;
    });
    gl.bindVertexArray(null);
    this.white = { tex: this.upload(new Uint8Array([255, 255, 255, 255]), 1, 1, gl.NEAREST), size: [1, 1], normals: null };
  }

  /** Called before each frame drawn with this view. */
  prepare(hd: ResolvedHd): void {
    this.hd = hd;
    this.cam = makeCamera(this.vw, this.vh, hd.perspective, hd.elevation);
    this.overscan = overscanOf(this.cam);
    this.wallRows = Math.round(hd.wallRows);
  }

  private upload(data: Uint8Array | Uint8ClampedArray | null, w: number, h: number, filter: number, image?: TexImageSource): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data && new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private sheet(sprite: string): Sheet | null {
    let s = this.sheets.get(sprite);
    if (s !== undefined) return s;
    s = null;
    const img = this.images.get(sprite) as HTMLImageElement | HTMLCanvasElement | undefined;
    if (img) {
      const w = (img as HTMLImageElement).naturalWidth || img.width;
      const h = (img as HTMLImageElement).naturalHeight || img.height;
      const n = this.base.normalsOf(sprite);
      s = { tex: this.upload(null, w, h, this.gl.LINEAR, img), size: [w, h], normals: n ? this.upload(n, w, h, this.gl.NEAREST) : null };
    }
    this.sheets.set(sprite, s);
    return s;
  }

  // ------------------------------------------------------------------ frame state

  mark(m: WorldMark): void {
    this.mark_ = m;
  }

  clear(color: string): void {
    this.inWorld = true;
    this.mark_ = { kind: 'backdrop' };
    this.background = parseColor(color);
    this.ambient = [1, 1, 1];
    this.lights = [];
    this.glow = 0;
    this.relief = null;
    this.grading = null;
    this.vignetting = null;
    for (const l of [this.backdrop, this.ground, this.stand, this.air, this.screen]) l.reset();
    this.ctx.clearRect(0, 0, this.vw, this.vh);
  }

  beginRelief(on: boolean, tiles = true): void {
    this.base.beginRelief(on, tiles);
  }

  endRelief(): void {
    this.base.endRelief();
  }

  spriteMask(sprite: string, x: number, y: number, w: number, h: number): Uint8Array | null {
    return this.base.spriteMask(sprite, x, y, w, h);
  }

  lighting(ambient: string, lights: ScreenLight[], glow: number): void {
    this.ambient = parseColor(ambient);
    this.lights = lights;
    this.glow = glow;
  }

  reliefLighting(relief: ResolvedRelief, ambient: string, lights: ScreenLight[], glow: number): void {
    this.lighting(ambient, lights, glow);
    this.relief = relief;
  }

  grade(tint: string, amount: number): void {
    this.grading = { tint, amount };
  }

  vignette(strength: number, color: string): void {
    this.vignetting = { strength, color };
  }

  // ------------------------------------------------------------------ geometry

  private push(list: DrawList, q: Quad): void {
    list.batch(q.sheet.tex, q.shaped ? q.sheet.normals : null, q.sheet.size, q.blend, q.stencil ?? (this.keepOffWater ? 3 : 0));
    const [sx0, sy0, sx1, sy1] = q.src;
    const us = q.mirror ? [sx1, sx0, sx0, sx1] : [sx0, sx1, sx1, sx0];
    const vs = q.flipV ? [sy1, sy1, sy0, sy0] : [sy0, sy0, sy1, sy1];
    const depthOf = (v: number) => Math.min(1, Math.max(0, ((v + this.vh / 2) / this.vh + 1) / 3));
    const lift = Math.min(MAX_Z, Math.max(0, q.z ?? 0));
    const depths = [0, 1, 2, 3].map((c) => depthOf(q.depths?.[c] ?? q.depth));
    const put = (d: Float32Array, o: number, c: number) => {
      const depth = depths[c]!;
      const sort = (depth + lift) / (MAX_Z + 1);
      const p = q.at[c]!;
      const f = q.flat[c]!;
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2];
      d[o + 3] = us[c]!; d[o + 4] = vs[c]!;
      d[o + 5] = sx0; d[o + 6] = sy0; d[o + 7] = sx1; d[o + 8] = sy1;
      d[o + 9] = q.color[0]; d[o + 10] = q.color[1]; d[o + 11] = q.color[2]; d[o + 12] = q.color[3];
      d[o + 13] = f[0]; d[o + 14] = f[1];
      d[o + 15] = depth;
      d[o + 16] = q.lit ? 1 : 0; d[o + 17] = q.shaped ? 1 : 0; d[o + 18] = q.sideOf ? (q.sideOf > 0 ? 2 : 3) : q.mirror ? 1 : 0; d[o + 19] = q.white;
      d[o + 20] = sort;
      d[o + 21] = q.bend ?? NO_BEND;
    };
    for (const c of [0, 1, 2, 0, 2, 3]) {
      const o = list.room();
      put(list.data, o, c);
      list.vertices++;
    }
  }

  /** The list of the current mark, and the world position of a flat view point in it. */
  private placed(): { list: DrawList; point: (x: number, y: number) => readonly [number, number, number]; depthOf: (y: number) => number; depthAt?: (x: number) => number } {
    const cam = this.cam;
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const flat = (x: number, y: number) => [x - cx, 0, y - cy] as const;
    const onGround = (x: number, y: number) => worldPoint(cam, x - cx, y - cy);
    const m = this.mark_;
    switch (m.kind) {
      case 'backdrop': return { list: this.backdrop, point: flat, depthOf: () => this.vh * 2 };
      case 'screen': return { list: this.screen, point: flat, depthOf: (y) => y - cy };
      case 'air': return { list: this.air, point: onGround, depthOf: (y) => y - cy };
      case 'ground': return { list: this.ground, point: onGround, depthOf: (y) => y - cy };
      case 'wall': {
        // On the plane of the wall's front, leaning as it leans, a hair in front of it. With a run, the foot goes from one
        // end to the other: a wall front along a line at an angle, still one flat vertical surface.
        const raise = this.hd.wallHeight;
        const run = m.run;
        const foot = run ? (x: number) => run.f0 + ((x - run.x0) * (run.f1 - run.f0)) / Math.max(1e-6, run.x1 - run.x0) : () => m.foot;
        return {
          list: this.stand,
          depthOf: () => m.foot - cy + 1,
          ...(run ? { depthAt: (x: number) => foot(x) - cy + 1 } : {}),
          point: (x, y) => worldPoint(cam, x - cx, foot(x) - cy, (foot(x) - y) * raise),
        };
      }
      case 'top': {
        const raise = this.hd.wallHeight;
        return { list: this.stand, depthOf: (y) => y + m.h - cy, point: (x, y) => worldPoint(cam, x - cx, y + m.h - cy, m.h * raise) };
      }
      case 'stand': {
        // Upright and facing the camera, on the spot of the feet: a sprite stays the drawing it is. With a run, every column
        // stands on its own foot, from one end to the other (a picture whose foot runs at an angle: one continuous ribbon).
        const run = m.run;
        if (run) {
          const foot = (x: number) => run.f0 + ((x - run.x0) * (run.f1 - run.f0)) / Math.max(1e-6, run.x1 - run.x0);
          return {
            list: this.stand,
            depthOf: () => m.y - cy,
            depthAt: (x: number) => foot(x) - cy,
            point: (x, y) => {
              const f = foot(x);
              const h = f - y;
              return [x - cx, h * cam.cos, (f - cy) * cam.depthScale - h * cam.sin] as const;
            },
          };
        }
        const base = worldPoint(cam, m.x - cx, m.y - cy);
        return {
          list: this.stand,
          depthOf: () => m.y - cy,
          point: (x, y) => {
            const h = m.y - y;
            return [base[0] + (x - m.x), h * cam.cos, base[2] - h * cam.sin] as const;
          },
        };
      }
    }
  }

  image(sprite: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, o: { flipX: boolean; opacity: number; angle: number; scale?: number; flat?: boolean; white?: number }): void {
    if (!this.inWorld) return this.base.image(sprite, sx, sy, sw, sh, dx, dy, o);
    const sheet = this.sheet(sprite);
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
    const hung = this.mark_;
    if (hung.kind === 'wall' && hung.relief) {
      // Copies of the drawing one behind the other: its own outline, extruded out of the wall. The ones behind are in shade.
      const cam = this.cam;
      const cx = this.vw / 2;
      const cy = this.vh / 2;
      const raise = this.hd.wallHeight;
      const slices = Math.max(1, Math.ceil(hung.relief / 0.75));
      for (let s = 1; s <= slices; s++) {
        const out = 1 + (hung.relief * s) / slices;
        const front = s === slices;
        const tone = front ? 1 : 0.42 + (0.3 * s) / slices;
        this.push(this.stand, {
          at: corners.map(([x, y]) => worldPoint(cam, x - cx, hung.foot - cy + out, (hung.foot - y) * raise)),
          flat: corners, depth: hung.foot - cy + out, sheet, src: [sx, sy, sx + sw, sy + sh], mirror: o.flipX, color: [tone, tone, tone, o.opacity],
          lit: true, shaped: front && !o.flat && !!sheet.normals && this.relief0(), white: Math.min(1, o.white ?? 0), blend: o.opacity < 1 ? 1 : 0, z: hung.z,
        });
      }
      return;
    }
    if (hung.kind === 'stand' && hung.solid && !o.angle && this.wrapOnSolid(sprite, sheet, sx, sy, sw, sh, dx, dy, k, o, hung.solid, hung.z)) return;
    const { list, point, depthOf, depthAt } = this.placed();
    const kind = this.mark_.kind;
    const lit = kind === 'ground' || kind === 'stand' || kind === 'wall' || kind === 'top';
    this.push(list, {
      at: corners.map(([x, y]) => point(x, y)),
      flat: corners,
      depth: depthOf(dy + h),
      ...(depthAt ? { depths: corners.map(([x]) => depthAt(x)) } : {}),
      sheet,
      src: [sx, sy, sx + sw, sy + sh],
      mirror: o.flipX,
      color: [1, 1, 1, o.opacity],
      lit,
      shaped: lit && !o.flat && !!sheet.normals && !!this.relief0(),
      white: Math.min(1, o.white ?? 0),
      blend: o.opacity < 1 || kind === 'air' || kind === 'screen' ? 1 : 0,
      z: 'z' in this.mark_ ? this.mark_.z : 0,
    });
  }

  private profileOf(sprite: string, frame: { x: number; y: number; w: number; h: number }): SpriteProfile | null {
    const key = `${sprite}|${frame.x}|${frame.y}|${frame.w}|${frame.h}`;
    let p = this.profiles.get(key);
    if (p === undefined) {
      const alpha = this.base.alphaMask(sprite);
      p = alpha ? spriteProfile(alpha.mask, alpha.width, frame) : null;
      this.profiles.set(key, p);
    }
    return p;
  }

  /**
   * A standing sprite on a solid: strips down its height and bands across it, each pushed towards the camera as far as the
   * solid's surface is there. The feet stay on the spot, because the surface is measured back from the frontmost point.
   */
  private wrapOnSolid(sprite: string, sheet: Sheet, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, k: number, o: { flipX: boolean; opacity: number; flat?: boolean; white?: number }, solid: { shape: HdShape; frame: { x: number; y: number; w: number; h: number } }, z: number): boolean {
    const profile = this.profileOf(sprite, solid.frame);
    if (!profile || profile.largest <= 0) return false;
    const { point, depthOf } = this.placed();
    const firstRow = sy - solid.frame.y;
    const radius = (row: number) => profile.radius[Math.max(0, Math.min(profile.radius.length - 1, row))]!;
    const screen = (u: number) => dx + (o.flipX ? sw - u : u) * k;
    const surface = (u: number, r: number) => (r > 0 && Math.abs(u - profile.axis) < r ? shapeSurface(solid.shape, (u - profile.axis) / r).forward * r : 0);
    const front = (u: number, r: number) => (surface(u, r) - profile.largest) * k;
    const shaped = !o.flat && !!sheet.normals && this.relief0();
    const depth = depthOf(dy + sh * k);
    let row = 0;
    while (row < sh) {
      const r0 = radius(firstRow + row);
      let next = row + 1;
      while (next < sh && next - row < 6 && Math.abs(radius(firstRow + next) - r0) <= 1) next++;
      const r1 = radius(firstRow + Math.min(sh - 1, next));
      for (let u = 0; u < sw; u += 2) {
        const v = Math.min(sw, u + 2);
        // Nothing of this frame reaches these columns on these rows.
        if (Math.max(r0, r1) <= 0 || Math.max(Math.abs(u - profile.axis), Math.abs(v - profile.axis)) > Math.max(r0, r1) + 2) continue;
        const left = Math.min(screen(u), screen(v));
        const right = Math.max(screen(u), screen(v));
        const top = dy + row * k;
        const bottom = dy + next * k;
        const uL = o.flipX ? v : u;
        const uR = o.flipX ? u : v;
        const lift = (x: number, y: number, by: number) => {
          const p = point(x, y);
          return [p[0], p[1], p[2] + by] as const;
        };
        const middle = (u + v) / 2;
        const side = shapeSurface(solid.shape, Math.max(-1, Math.min(1, (middle - profile.axis) / Math.max(1, Math.max(r0, r1))))).side;
        this.push(this.stand, {
          at: [lift(left, top, front(uL, r0)), lift(right, top, front(uR, r0)), lift(right, bottom, front(uR, r1)), lift(left, bottom, front(uL, r1))],
          flat: [[left, top], [right, top], [right, bottom], [left, bottom]],
          depth, sheet, src: [sx + u, sy + row, sx + v, sy + next], mirror: o.flipX, color: [1, 1, 1, o.opacity], lit: true, shaped, white: Math.min(1, o.white ?? 0), blend: o.opacity < 1 ? 1 : 0, z,
          bend: o.flipX ? -side : side,
        });
      }
      row = next;
    }
    return true;
  }

  /** Relief lighting arrives after the sprites: what counts while they are placed is whether the scene will have it. */
  private relief0(): boolean {
    return this.base.reliefActive;
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1, blend?: 'add'): void {
    if (!this.inWorld) return this.base.rect(x, y, w, h, color, alpha, blend);
    const { list, point, depthOf } = this.placed();
    const corners: [number, number][] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const [r, g, b] = parseColor(color);
    this.push(list, { at: corners.map(([px, py]) => point(px, py)), flat: corners, depth: depthOf(y + h), sheet: this.white, src: [0, 0, 1, 1], mirror: false, color: [r, g, b, alpha], lit: false, shaped: false, white: 0, blend: blend === 'add' ? 2 : 1 });
  }

  /** Text stays on the canvas above: it has to be read. */
  text(text: string, x: number, y: number, color: string, scale: number, font?: PixelFont): void {
    this.base.text(text, x, y, color, scale, font);
  }

  stamp(shape: CastShape, x: number, y: number, zoom: number, color: string, alpha: number, slice?: { row: number; rows: number }): void {
    let entry = this.stamps.get(shape);
    if (!entry || entry.color !== color) {
      const w = Math.max(1, shape.width);
      const h = Math.max(1, shape.height);
      const data = new Uint8Array(w * h * 4);
      const [r, g, b] = parseColor(color);
      for (let i = 0; i < shape.runs.length; i += 3) {
        const row = shape.runs[i + 1]!;
        for (let c = shape.runs[i]!; c < shape.runs[i]! + shape.runs[i + 2]!; c++) data.set([r * 255, g * 255, b * 255, 255], (row * w + c) * 4);
      }
      entry = { color, sheet: { tex: this.upload(data, w, h, this.gl.LINEAR), size: [w, h], normals: null } };
      this.stamps.set(shape, entry);
    }
    const row = slice?.row ?? 0;
    const rows = slice?.rows ?? shape.height;
    const top = y + row * zoom;
    const corners: [number, number][] = [[x, top], [x + shape.width * zoom, top], [x + shape.width * zoom, top + rows * zoom], [x, top + rows * zoom]];
    const { list, point, depthOf } = this.placed();
    this.push(list, { at: corners.map(([px, py]) => point(px, py)), flat: corners, depth: depthOf(top), sheet: entry.sheet, src: [0, row, shape.width, row + rows], mirror: false, color: [1, 1, 1, alpha], lit: false, shaped: false, white: 0, blend: 1 });
  }

  private keepOffWater = false;

  /** Writes the pixels of the water into the stencil, or (mode 4) takes those of what lies across it out again. */
  private markWater(water: WaterPiece[], zoom: number, stencil: 1 | 4 = 1): void {
    const { list, point, depthOf } = this.placed();
    for (const piece of water) {
      const mask = this.base.waterMask(piece);
      if (!mask) continue;
      let sheet = this.waterMasks.get(mask);
      if (!sheet) {
        sheet = { tex: this.upload(null, piece.sw, piece.sh, this.gl.NEAREST, mask), size: [piece.sw, piece.sh], normals: null };
        this.waterMasks.set(mask, sheet);
      }
      const w = piece.sw * zoom;
      const h = piece.sh * zoom;
      const corners: [number, number][] = [[piece.x, piece.y], [piece.x + w, piece.y], [piece.x + w, piece.y + h], [piece.x, piece.y + h]];
      this.push(list, { at: corners.map(([x, y]) => point(x, y)), flat: corners, depth: depthOf(piece.y), sheet, src: [0, 0, piece.sw, piece.sh], mirror: false, color: [1, 1, 1, 1], lit: false, shaped: false, white: 0, blend: 0, stencil });
    }
  }

  offWater(water: WaterPiece[], dry: WaterPiece[], zoom: number, draw: () => void): void {
    this.markWater(water, zoom);
    this.markWater(dry, zoom, 4);
    this.keepOffWater = true;
    try {
      draw();
    } finally {
      this.keepOffWater = false;
    }
  }

  /** Water marks where the reflections may show; the reflections are drawn upside down, only there. */
  reflections(water: WaterPiece[], bands: ReflectionBand[], zoom: number): void {
    const { list, point, depthOf } = this.placed();
    const box = (x: number, y: number, w: number, h: number): [number, number][] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    this.markWater(water, zoom);
    for (const b of bands) {
      const sheet = this.sheet(b.sprite);
      if (!sheet) continue;
      const corners = box(b.dx, b.dy, b.sw * zoom, b.sh * zoom);
      this.push(list, { at: corners.map(([x, y]) => point(x, y)), flat: corners, depth: depthOf(b.dy), sheet, src: [b.sx, b.sy, b.sx + b.sw, b.sy + b.sh], mirror: b.flipX, flipV: true, color: [1, 1, 1, b.alpha], lit: true, shaped: false, white: 0, blend: 1, stencil: 2 });
    }
  }

  /** One map tile standing up, per its place in the wall. `x` and `y` are where it is in the flat picture. */
  tileWall(sprite: string, sx: number, sy: number, sw: number, sh: number, x: number, y: number, size: number, cell: WallCell, sides: ([number, number] | null)[] | null): void {
    if (!this.inWorld) return;
    const sheet = this.sheet(sprite);
    if (!sheet) return;
    // Walls take the light through the normals of their tiles; the stretched edges have none worth using.
    const shaped = !!sheet.normals && this.relief0();
    for (const q of wallQuads(this.cam, this.hd.wallHeight, this.hd.wallTrim, sx, sy, sw, sh, x, y, size, cell, sides)) {
      this.push(this.stand, { sheet, mirror: false, color: q.color, lit: true, shaped: shaped && q.shaped, white: 0, blend: 0, src: q.src, flat: q.flat, depth: q.depth, at: q.at, ...(q.sideOf ? { sideOf: q.sideOf } : {}) });
    }
  }

  // ------------------------------------------------------------------ drawing

  private target(w: number, h: number): void {
    const gl = this.gl;
    if (this.fbo && this.fboW === w && this.fboH === h) return;
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo);
      gl.deleteTexture(this.color);
      gl.deleteRenderbuffer(this.depth);
    }
    this.fboW = w;
    this.fboH = h;
    this.color = this.upload(null, w, h, gl.LINEAR);
    this.depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.depth);
  }

  private drawList(list: DrawList, matrix: Float32Array, depthTest: boolean): void {
    if (!list.vertices) return;
    const gl = this.gl;
    const p = this.program;
    gl.bufferData(gl.ARRAY_BUFFER, list.data.subarray(0, list.vertices * FLOATS), gl.STREAM_DRAW);
    gl.uniformMatrix4fv(p.uniform('matrix'), false, matrix);
    gl.depthFunc(gl.LEQUAL);
    if (depthTest) gl.enable(gl.DEPTH_TEST);
    else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(depthTest);
    for (const b of list.batches) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, b.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, b.normals ?? this.white.tex);
      gl.uniform1f(p.uniform('hasNormals'), b.normals ? 1 : 0);
      gl.uniform2f(p.uniform('texSize'), b.size[0], b.size[1]);
      gl.uniform1f(p.uniform('blended'), b.blend ? 1 : 0);
      if (b.blend) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, b.blend === 2 ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA);
        // The depth of field keeps what the solid pixels wrote.
        gl.colorMask(true, true, true, false);
      } else {
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
      }
      if (b.stencil) {
        gl.enable(gl.STENCIL_TEST);
        if (b.stencil === 1 || b.stencil === 4) {
          gl.stencilFunc(gl.ALWAYS, b.stencil === 1 ? 1 : 0, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.colorMask(false, false, false, false);
        } else {
          gl.stencilFunc(b.stencil === 3 ? gl.NOTEQUAL : gl.EQUAL, 1, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        }
      } else gl.disable(gl.STENCIL_TEST);
      gl.drawArrays(gl.TRIANGLES, b.first, b.count);
    }
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
  }

  /** The world is complete: draws it, hands it to the compositor and lets the interface through to the canvas. */
  endWorld(frame: HdFrame | null): void {
    this.inWorld = false;
    if (!frame) return;
    const gl = this.gl;
    const w = this.compositor.outputWidth;
    const h = this.compositor.outputHeight;
    this.target(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const p = this.program;
    gl.useProgram(p.program);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.uniform1i(p.uniform('albedo'), 0);
    gl.uniform1i(p.uniform('normals'), 1);
    gl.uniform3fv(p.uniform('ambient'), this.ambient);
    gl.uniform1f(p.uniform('glow'), this.glow);
    const rel = this.relief;
    gl.uniform1f(p.uniform('relief'), rel ? 1 : 0);
    gl.uniform1f(p.uniform('strength'), rel?.strength ?? 0);
    gl.uniform1f(p.uniform('bands'), rel?.bands ?? 0);
    gl.uniform1f(p.uniform('rimLight'), rel?.rim ?? 0);
    gl.uniform1f(p.uniform('lightHeight'), rel?.lightHeight ?? 0.3);
    gl.uniform1f(p.uniform('sunOn'), rel?.sun ? 1 : 0);
    if (rel?.sun) {
      gl.uniform3f(p.uniform('sunDir'), rel.sun.x, rel.sun.y, rel.sun.z);
      gl.uniform3fv(p.uniform('sunColor'), rel.sun.color);
      gl.uniform3fv(p.uniform('sunShade'), rel.sun.shade);
      gl.uniform1f(p.uniform('sunIntensity'), rel.sun.intensity);
    }
    const count = Math.min(MAX_LIGHTS, this.lights.length);
    const lights = new Float32Array(MAX_LIGHTS * 4);
    const colors = new Float32Array(MAX_LIGHTS * 3);
    for (let i = 0; i < count; i++) {
      const l = this.lights[i]!;
      lights.set([l.x, l.y, Math.max(1, l.radius), l.intensity], i * 4);
      colors.set(parseColor(l.color), i * 3);
    }
    gl.uniform1i(p.uniform('lightCount'), count);
    gl.uniform4fv(p.uniform('lights'), lights);
    gl.uniform3fv(p.uniform('lightColors'), colors);

    const perspective = cameraMatrix(this.cam);
    const flat = flatMatrix(this.vw, this.vh);
    this.drawList(this.backdrop, flat, false);
    this.drawList(this.ground, perspective, false);
    this.drawList(this.stand, perspective, true);
    this.drawList(this.air, perspective, false);
    this.drawList(this.screen, flat, false);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.bindVertexArray(null);

    // Halos belong where the lamps ended up.
    const cx = this.vw / 2;
    const cy = this.vh / 2;
    const placed = frame.lights.map((l) => {
      const s = projectWorld(this.cam, worldPoint(this.cam, l.x - cx, l.y - cy));
      return { ...l, x: s.x + cx, y: s.y + cy, radius: l.radius * s.scale };
    });
    this.compositor.drawScene(this.color!, w, h, { ...frame, lights: placed }, this.grading, this.vignetting);
  }
}
