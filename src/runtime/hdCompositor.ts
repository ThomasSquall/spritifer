/**
 * Draws the 2D-HD look with WebGL2, at the resolution of the screen: the world arrives as a low-resolution picture and
 * leaves with square pixels, depth of field, bloom, haze and smooth halos. The interface is not drawn here: it stays on
 * the game canvas, above this one, so text remains crisp. core/game/hd.ts has the same look on plain pixels.
 */

import { type HdFrame, hdFocus } from '../core/game/hd.js';

const MAX_LIGHTS = 16;
/** Longest side of the output: beyond this the extra pixels cost more than they show. */
const MAX_OUTPUT = 2560;

const VERTEX = `#version 300 es
out vec2 v;
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1));
  v = p * 0.5;
  gl_Position = vec4(p - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 v;
out vec4 o;
`;

const BRIGHT = `${HEAD}
uniform sampler2D a;
uniform float threshold;
void main() {
  vec3 c = texture(a, v).rgb;
  o = vec4(c * smoothstep(threshold - 0.12, threshold + 0.12, max(c.r, max(c.g, c.b))), 1.0);
}`;

const DOWN = `${HEAD}
uniform sampler2D a;
uniform vec2 texel;
void main() {
  vec3 c = texture(a, v).rgb * 4.0;
  c += texture(a, v - texel).rgb;
  c += texture(a, v + texel).rgb;
  c += texture(a, v + vec2(texel.x, -texel.y)).rgb;
  c += texture(a, v - vec2(texel.x, -texel.y)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;

const UP = `${HEAD}
uniform sampler2D a;
uniform sampler2D b;
uniform vec2 texel;
void main() {
  vec3 w = texture(b, v - texel).rgb + texture(b, v + texel).rgb + texture(b, v + vec2(texel.x, -texel.y)).rgb + texture(b, v - vec2(texel.x, -texel.y)).rgb;
  o = vec4(mix(texture(a, v).rgb, w / 4.0, 0.62), 1.0);
}`;

const COMPOSITE = `${HEAD}
uniform sampler2D source, d1, d2, d3, glow;
uniform vec2 size, game;
uniform float useDepth, gradeAmount, sceneVignette;
uniform vec3 gradeColor, sceneVignetteColor;
uniform float scale, focus, band, far, near, haze, bloom, halo, exposure, contrast, saturation, vignette;
uniform vec3 hazeColor;
uniform int lightCount;
uniform vec4 lights[${MAX_LIGHTS}];
uniform vec3 lightColors[${MAX_LIGHTS}];

// A small copy read back with a cubic B-spline instead of straight lines between its pixels: enlarged many times, the
// lines show as a grid of squares, the curve does not. Four fetches, each already mixing four pixels.
vec3 bspline(sampler2D t, vec2 at) {
  vec2 size = vec2(textureSize(t, 0));
  vec2 p = at * size - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * texture(t, h0).rgb + g1.x * texture(t, vec2(h1.x, h0.y)).rgb)
       + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)).rgb + g1.x * texture(t, h1).rgb);
}

vec3 tent(sampler2D t, float cell) {
  vec2 d = cell / game;
  return (bspline(t, v - d) + bspline(t, v + d) + bspline(t, v + vec2(d.x, -d.y)) + bspline(t, v - vec2(d.x, -d.y))) * 0.25;
}

void main() {
  float y = 1.0 - v.y;
  // Square pixels with a one-screen-pixel soft edge: no shimmer while scrolling, at any window size.
  vec2 at = v * size;
  vec2 cell = floor(at + 0.5);
  vec3 c = texture(source, (cell + clamp((at - cell) * scale, -0.5, 0.5)) / size).rgb;

  // In perspective each pixel knows how far up the screen the ground under it is: a treetop is as far as its roots.
  float depthY = useDepth > 0.5 ? texture(source, v).a * 3.0 - 1.0 : y;
  float dist = depthY - focus;
  float t = clamp((abs(dist) - band * 0.5) / 0.4, 0.0, 1.0);
  float level = min(3.0, t * t * (3.0 - 2.0 * t) * (dist < 0.0 ? far : near) * 2.2);
  if (level > 0.001) {
    vec3 first = tent(d1, 2.0);
    if (level < 1.0) c = mix(c, first, level);
    else if (level < 2.0) c = mix(first, tent(d2, 4.0), level - 1.0);
    else c = mix(tent(d2, 4.0), tent(d3, 8.0), level - 2.0);
  }

  if (gradeAmount > 0.0) {
    vec3 soft = mix(2.0 * c * gradeColor + c * c * (1.0 - 2.0 * gradeColor), sqrt(max(c, 0.0)) * (2.0 * gradeColor - 1.0) + 2.0 * c * (1.0 - gradeColor), step(0.5, gradeColor));
    c = mix(c, soft, gradeAmount);
  }
  if (focus > 0.0) c = mix(c, hazeColor, haze * (1.0 - clamp(depthY / focus, 0.0, 1.0)));
  c += tent(glow, 2.0) * bloom * 1.6;

  vec2 p = vec2(v.x, y) * game;
  for (int i = 0; i < lightCount; i++) {
    float d = length(p - lights[i].xy) / lights[i].z;
    if (d < 1.0) c += lightColors[i] * pow(1.0 - d, 3.0) * lights[i].w * halo;
  }

  c *= exposure;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(luma), c, saturation);
  c = (c - 0.5) * contrast + 0.5;
  float corner = smoothstep(0.35, 0.85, length(v - 0.5) * 1.2);
  if (sceneVignette > 0.0) c = mix(c, sceneVignetteColor, sceneVignette * corner);
  c *= 1.0 - vignette * corner;
  // A touch of noise keeps the long soft gradients from banding.
  c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export type ProgramInfo = { program: WebGLProgram; uniform: (name: string) => WebGLUniformLocation | null };
type Program = ProgramInfo;

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export class HdCompositor {
  private readonly source: WebGLTexture;
  private readonly blur: Target[];
  /** The perspective view arrives at screen size: this brings it down to the game's before blurring. */
  private readonly settle: Target;
  private readonly glow: Target[];
  private readonly glowUp: Target[];
  private readonly bright: Program;
  private readonly down: Program;
  private readonly up: Program;
  private readonly composite: Program;
  private readonly lights = new Float32Array(MAX_LIGHTS * 4);
  private readonly lightColors = new Float32Array(MAX_LIGHTS * 3);

  private constructor(readonly gl: WebGL2RenderingContext, private readonly canvas: HTMLCanvasElement, private readonly width: number, private readonly height: number) {
    this.source = this.texture(width, height);
    const level = (n: number) => this.target(Math.max(1, width >> n), Math.max(1, height >> n));
    this.blur = [level(1), level(2), level(3)];
    this.settle = level(0);
    this.glow = [level(1), level(2), level(3), level(4)];
    this.glowUp = [level(1), level(2), level(3)];
    this.bright = this.compile(VERTEX, BRIGHT);
    this.down = this.compile(VERTEX, DOWN);
    this.up = this.compile(VERTEX, UP);
    this.composite = this.compile(VERTEX, COMPOSITE);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  }

  /** null when this browser has no WebGL2: the game simply stays as it is. */
  static create(canvas: HTMLCanvasElement, width: number, height: number): HdCompositor | null {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
    if (!gl) return null;
    try {
      return new HdCompositor(gl, canvas, width, height);
    } catch (err) {
      console.warn('[2D-HD]', err);
      return null;
    }
  }

  private texture(w: number, h: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = this.texture(w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  compile(vertex: string, fragment: string): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'Shader error');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Link error');
    const cache = new Map<string, WebGLUniformLocation | null>();
    return {
      program,
      uniform: (name) => {
        if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
        return cache.get(name)!;
      },
    };
  }

  /** Output size in physical pixels, and how many of them a game pixel covers. */
  resize(physicalWidth: number, physicalHeight: number): void {
    const k = Math.min(1, MAX_OUTPUT / Math.max(physicalWidth, physicalHeight, 1));
    this.canvas.width = Math.max(1, Math.round(physicalWidth * k));
    this.canvas.height = Math.max(1, Math.round(physicalHeight * k));
  }

  private bind(p: Program, textures: Record<string, WebGLTexture>): void {
    const gl = this.gl;
    gl.useProgram(p.program);
    let unit = 0;
    for (const [name, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(p.uniform(name), unit++);
    }
  }

  private pass(to: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.fbo : null);
    gl.viewport(0, 0, to ? to.w : this.canvas.width, to ? to.h : this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private shrink(from: WebGLTexture, fromW: number, fromH: number, to: Target): void {
    this.bind(this.down, { a: from });
    this.gl.uniform2f(this.down.uniform('texel'), 0.5 / fromW, 0.5 / fromH);
    this.pass(to);
  }

  get outputWidth(): number {
    return this.canvas.width;
  }

  get outputHeight(): number {
    return this.canvas.height;
  }

  /** Takes the finished world from `picture` and draws the look on this compositor's canvas. */
  draw(picture: HTMLCanvasElement, frame: HdFrame): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, picture);
    this.finish(this.source, this.width, this.height, frame, null, null, false);
  }

  /** Like draw, for a picture already rendered at screen size, with the screen height of its ground in alpha. */
  drawScene(texture: WebGLTexture, w: number, h: number, frame: HdFrame, grade: { tint: string; amount: number } | null, vignette: { strength: number; color: string } | null): void {
    this.shrink(texture, w, h, this.settle);
    this.finish(texture, w, h, frame, grade, vignette, true, this.settle);
  }

  private finish(source: WebGLTexture, sourceW: number, sourceH: number, frame: HdFrame, grade: { tint: string; amount: number } | null, sceneVignette: { strength: number; color: string } | null, depth: boolean, start?: Target): void {
    const gl = this.gl;
    const { hd } = frame;

    // Blurred copies of the picture, for the depth of field.
    let from = start ? start.tex : source;
    let fromW = start ? start.w : sourceW;
    let fromH = start ? start.h : sourceH;
    for (const t of this.blur) {
      this.shrink(from, fromW, fromH, t);
      from = t.tex;
      fromW = t.w;
      fromH = t.h;
    }

    // The bright parts, shrunk and grown back: each level adds a wider glow.
    this.bind(this.bright, { a: this.blur[0].tex });
    gl.uniform1f(this.bright.uniform('threshold'), hd.bloomThreshold);
    this.pass(this.glow[0]);
    for (let i = 1; i < this.glow.length; i++) this.shrink(this.glow[i - 1].tex, this.glow[i - 1].w, this.glow[i - 1].h, this.glow[i]);
    let wide = this.glow[this.glow.length - 1];
    for (let i = this.glowUp.length - 1; i >= 0; i--) {
      this.bind(this.up, { a: this.glow[i].tex, b: wide.tex });
      gl.uniform2f(this.up.uniform('texel'), 0.5 / wide.w, 0.5 / wide.h);
      this.pass(this.glowUp[i]);
      wide = this.glowUp[i];
    }

    const c = this.composite;
    this.bind(c, { source, d1: this.blur[0].tex, d2: this.blur[1].tex, d3: this.blur[2].tex, glow: this.glowUp[0].tex });
    gl.uniform2f(c.uniform('size'), sourceW, sourceH);
    gl.uniform2f(c.uniform('game'), this.width, this.height);
    gl.uniform1f(c.uniform('scale'), depth ? 1 : this.canvas.width / this.width);
    gl.uniform1f(c.uniform('useDepth'), depth ? 1 : 0);
    gl.uniform1f(c.uniform('gradeAmount'), grade?.amount ?? 0);
    gl.uniform3fv(c.uniform('gradeColor'), rgb(grade?.tint ?? '#808080'));
    gl.uniform1f(c.uniform('sceneVignette'), sceneVignette?.strength ?? 0);
    gl.uniform3fv(c.uniform('sceneVignetteColor'), rgb(sceneVignette?.color ?? '#000000'));
    gl.uniform1f(c.uniform('focus'), hdFocus(frame));
    gl.uniform1f(c.uniform('band'), hd.focusBand);
    gl.uniform1f(c.uniform('far'), hd.blurFar);
    gl.uniform1f(c.uniform('near'), hd.blurNear);
    gl.uniform1f(c.uniform('haze'), hd.haze);
    gl.uniform3fv(c.uniform('hazeColor'), rgb(hd.hazeColor));
    gl.uniform1f(c.uniform('bloom'), hd.bloom);
    gl.uniform1f(c.uniform('halo'), hd.halo * hd.darkness);
    gl.uniform1f(c.uniform('exposure'), hd.exposure);
    gl.uniform1f(c.uniform('contrast'), hd.contrast);
    gl.uniform1f(c.uniform('saturation'), hd.saturation);
    gl.uniform1f(c.uniform('vignette'), hd.vignette);
    const count = Math.min(MAX_LIGHTS, frame.lights.length);
    for (let i = 0; i < count; i++) {
      const l = frame.lights[i];
      this.lights.set([l.x, l.y, Math.max(1, l.radius), l.intensity], i * 4);
      this.lightColors.set(rgb(l.color), i * 3);
    }
    gl.uniform1i(c.uniform('lightCount'), count);
    gl.uniform4fv(c.uniform('lights'), this.lights);
    gl.uniform3fv(c.uniform('lightColors'), this.lightColors);
    this.pass(null);
  }
}
