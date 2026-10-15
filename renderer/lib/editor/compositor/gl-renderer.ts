/**
 * WebGL2 executor for the scene built in scene.ts. Owns the GL objects (programs, framebuffers, textures) and draws
 * groups bottom → top into a float framebuffer ("comp"), then presents it to the canvas.
 *
 * Passes (per group):
 *  - single plain layer (no blur / background / veil): drawn straight into comp. Normal blend uses hardware
 *    premultiplied 'over'; the other blend modes read a copy of comp (`dstCopy`) in the fragment shader (ping-pong by copy);
 *  - otherwise: layers are rendered into transparent offscreen targets (group G, layer temp T), blurred
 *    (down-sampled gaussian pyramid) where asked, the veil is laid over G (src-atop), and G is composited onto comp
 *    with the group's blend mode.
 * Nothing is allocated per frame: targets and textures are created lazily and reused; source textures are re-uploaded
 * only when the source changes (video frame / mutable canvas), never for static layers.
 */
import type { Asset, BlendMode, Project } from '@shared/editor';
import type { EffectiveColor } from '@shared/editor-eval';
import type { FrameRequest, FrameSource } from './api';
import { hexToRgb, type Raster } from './raster';
import type { SceneGroup, SceneLayer, UvRect } from './scene';
import {
  FS_BLUR,
  FS_COMP,
  FS_COPY,
  FS_LAYER,
  FS_SHAPE,
  FS_SOLID,
  VS_FULL,
  VS_RECT,
} from './shaders';

const BLEND_INDEX: Record<BlendMode, number> = {
  normal: 0,
  multiply: 1,
  screen: 2,
  overlay: 3,
  add: 4,
  darken: 5,
  lighten: 6,
};

class Prog {
  readonly program: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(
    private gl: WebGL2RenderingContext,
    vs: string,
    fs: string,
  ) {
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type) as WebGLShader;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error(`shader compile failed: ${gl.getShaderInfoLog(sh) ?? ''}`);
      return sh;
    };
    const p = gl.createProgram() as WebGLProgram;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(`program link failed: ${gl.getProgramInfoLog(p) ?? ''}`);
    this.program = p;
  }
  u(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locs.set(name, l);
    }
    return l;
  }
}

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

interface SrcSlot {
  tex: WebGLTexture;
  src: unknown;
  w: number;
  h: number;
  version: string;
  mips: boolean;
  used: number;
}

export interface RenderInput {
  project: Project;
  assets: Map<string, Asset>;
  frames: FrameSource;
  /** Preview px per canvas px. */
  scale: number;
  /** Raster (text / subtitle) for a layer, cached by the caller. */
  raster: (layer: SceneLayer) => Raster | null;
  missing: FrameRequest[];
}

const MAX_SLOTS = 32;
const UNIT_TEX = 0;
const UNIT_DST = 1;
const UNIT_LUT = 2;

export class GlRenderer {
  readonly gl: WebGL2RenderingContext;
  drawCalls = 0;
  private w = 0;
  private h = 0;
  private floatTargets: boolean;
  private pLayer: Prog;
  private pShape: Prog;
  private pComp: Prog;
  private pCopy: Prog;
  private pBlur: Prog;
  private pSolid: Prog;
  private vao: WebGLVertexArrayObject;
  private comp: Target | null = null;
  private dstCopy: Target | null = null;
  private group: Target | null = null;
  private temp: Target | null = null;
  private scratch: Target | null = null;
  private blurA = new Map<string, Target>();
  private dummy2D: WebGLTexture;
  private dummy3D: WebGLTexture;
  private slots = new Map<string, SrcSlot>();
  private rasterTex = new Map<number, WebGLTexture>();
  private luts = new Map<string, { tex: WebGLTexture; data: Float32Array }>();
  private frameNo = 0;
  private lost = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, powerPreference?: WebGLPowerPreference) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      powerPreference,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.floatTargets =
      !!gl.getExtension('EXT_color_buffer_float') ||
      !!gl.getExtension('EXT_color_buffer_half_float');
    this.pLayer = new Prog(gl, VS_RECT, FS_LAYER);
    this.pShape = new Prog(gl, VS_RECT, FS_SHAPE);
    this.pComp = new Prog(gl, VS_FULL, FS_COMP);
    this.pCopy = new Prog(gl, VS_FULL, FS_COPY);
    this.pBlur = new Prog(gl, VS_FULL, FS_BLUR);
    this.pSolid = new Prog(gl, VS_FULL, FS_SOLID);
    this.vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(this.vao);
    this.dummy2D = this.makeDummy2D();
    this.dummy3D = this.makeDummy3D();
    const el = canvas as HTMLCanvasElement;
    if (typeof el.addEventListener === 'function') {
      el.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  get size(): { w: number; h: number } {
    return { w: this.w, h: this.h };
  }

  get contextLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }

  /* ------------------------------------------------------------------ resources ---------------- */

  private makeDummy2D(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
    return t;
  }
  private makeDummy3D(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      1,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(4),
    );
    return t;
  }

  private makeTarget(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.floatTargets)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  private freeTarget(t: Target | null): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /** (Re)allocates the screen-sized targets. Source textures survive. */
  resize(w: number, h: number): void {
    if (w === this.w && h === this.h && this.comp) return;
    this.w = w;
    this.h = h;
    for (const t of [this.comp, this.dstCopy, this.group, this.temp, this.scratch])
      this.freeTarget(t);
    for (const t of this.blurA.values()) this.freeTarget(t);
    this.blurA.clear();
    this.comp = this.makeTarget(w, h);
    this.dstCopy = null;
    this.group = null;
    this.temp = null;
    this.scratch = null;
  }

  private ensure(name: 'dstCopy' | 'group' | 'temp' | 'scratch'): Target {
    let t = this[name];
    if (!t) {
      t = this.makeTarget(this.w, this.h);
      this[name] = t;
    }
    return t;
  }

  private blurTarget(level: number, which: 'a' | 'b'): Target {
    const k = `${level}${which}`;
    let t = this.blurA.get(k);
    if (!t) {
      const f = 2 ** level;
      t = this.makeTarget(Math.max(1, Math.ceil(this.w / f)), Math.max(1, Math.ceil(this.h / f)));
      this.blurA.set(k, t);
    }
    return t;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [this.comp, this.dstCopy, this.group, this.temp, this.scratch])
      this.freeTarget(t);
    for (const t of this.blurA.values()) this.freeTarget(t);
    for (const s of this.slots.values()) gl.deleteTexture(s.tex);
    for (const t of this.rasterTex.values()) gl.deleteTexture(t);
    for (const l of this.luts.values()) gl.deleteTexture(l.tex);
    gl.deleteTexture(this.dummy2D);
    gl.deleteTexture(this.dummy3D);
    this.slots.clear();
    this.rasterTex.clear();
    this.luts.clear();
    for (const p of [this.pLayer, this.pShape, this.pComp, this.pCopy, this.pBlur, this.pSolid])
      gl.deleteProgram(p.program);
  }

  /** Drops the texture of an evicted raster. */
  dropRaster(id: number): void {
    const t = this.rasterTex.get(id);
    if (t) {
      this.gl.deleteTexture(t);
      this.rasterTex.delete(id);
    }
  }

  /** Forgets cached source textures whose slot key is not in `keep` (project changed). */
  pruneSlots(keep: (key: string) => boolean): void {
    for (const [k, s] of this.slots) {
      if (!keep(k)) {
        this.gl.deleteTexture(s.tex);
        this.slots.delete(k);
      }
    }
  }

  /** Texture uploads performed so far (tests assert static layers cost none). */
  uploads = 0;

  /* ------------------------------------------------------------------ textures --------------- */

  private sourceSize(src: CanvasImageSource): { w: number; h: number } {
    const s = src as unknown as Record<string, number>;
    if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement)
      return { w: src.videoWidth, h: src.videoHeight };
    if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame)
      return { w: src.displayWidth, h: src.displayHeight };
    if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement)
      return { w: src.naturalWidth, h: src.naturalHeight };
    return { w: s.width ?? 0, h: s.height ?? 0 };
  }

  /** Uploads (if needed) and returns the texture for a frame source object. */
  private sourceTexture(key: string, src: CanvasImageSource): SrcSlot | null {
    const gl = this.gl;
    const { w, h } = this.sourceSize(src);
    if (w <= 0 || h <= 0) return null;
    if (
      typeof HTMLVideoElement !== 'undefined' &&
      src instanceof HTMLVideoElement &&
      src.readyState < 2
    )
      return null; // no frame decoded yet
    let slot = this.slots.get(key);
    const isVideoEl = typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement;
    const mutable =
      (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) ||
      (typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas);
    const version = isVideoEl
      ? `${(src as HTMLVideoElement).currentTime}|${(src as HTMLVideoElement).readyState}`
      : '';
    const immutable =
      !isVideoEl && !mutable && !(typeof VideoFrame !== 'undefined' && src instanceof VideoFrame);
    const needsUpload =
      !slot ||
      slot.src !== src ||
      slot.w !== w ||
      slot.h !== h ||
      mutable ||
      (isVideoEl && slot.version !== version);
    if (!slot) {
      const tex = gl.createTexture() as WebGLTexture;
      slot = { tex, src: null, w: 0, h: 0, version: '', mips: false, used: 0 };
      this.slots.set(key, slot);
    }
    slot.used = this.frameNo;
    if (needsUpload) {
      gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
      gl.bindTexture(gl.TEXTURE_2D, slot.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      const same = slot.w === w && slot.h === h && slot.src !== null;
      const mips = immutable && w > 1 && h > 1;
      if (same && !mips)
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      else
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      slot.src = src;
      slot.w = w;
      slot.h = h;
      slot.version = version;
      slot.mips = mips;
      this.uploads++;
      if (this.slots.size > MAX_SLOTS) this.evictSlots();
    }
    return slot;
  }

  private evictSlots(): void {
    const arr = [...this.slots.entries()].sort((a, b) => a[1].used - b[1].used);
    while (this.slots.size > MAX_SLOTS && arr.length) {
      const [k, s] = arr.shift() as [string, SrcSlot];
      if (s.used === this.frameNo) break;
      this.gl.deleteTexture(s.tex);
      this.slots.delete(k);
    }
  }

  private rasterTexture(r: Raster): { tex: WebGLTexture; w: number; h: number } {
    const gl = this.gl;
    let tex = this.rasterTex.get(r.id);
    if (!tex) {
      tex = gl.createTexture() as WebGLTexture;
      gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        r.canvas as TexImageSource,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.rasterTex.set(r.id, tex);
      this.uploads++;
    }
    return { tex, w: r.pxW, h: r.pxH };
  }

  private lutTexture(id: string, lut: { size: number; data: Float32Array }): WebGLTexture {
    const gl = this.gl;
    let e = this.luts.get(id);
    if (!e || e.data !== lut.data) {
      if (e) gl.deleteTexture(e.tex);
      const tex = gl.createTexture() as WebGLTexture;
      gl.activeTexture(gl.TEXTURE0 + UNIT_LUT);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGB16F,
        lut.size,
        lut.size,
        lut.size,
        0,
        gl.RGB,
        gl.FLOAT,
        lut.data,
      );
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
        gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      e = { tex, data: lut.data };
      this.luts.set(id, e);
      this.uploads++;
    }
    return e.tex;
  }

  /* ------------------------------------------------------------------ pass helpers ------------- */

  private bind(t: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.w, t ? t.h : this.h);
  }

  private clear(t: Target, r = 0, g = 0, b = 0, a = 0): void {
    this.bind(t);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.clearColor(r, g, b, a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private setBlend(normal: boolean): void {
    const gl = this.gl;
    if (normal) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else gl.disable(gl.BLEND);
  }

  /** comp → dstCopy so a blend-mode shader can read the backdrop while writing comp. */
  private snapshotComp(): void {
    const gl = this.gl;
    const dst = this.ensure('dstCopy');
    const comp = this.comp as Target;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, comp.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  private bindDst(tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT_DST);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private fullscreen(): void {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  /* ------------------------------------------------------------------ blur ------------------- */

  /** Gaussian-blurs `src` (full size, premultiplied) and returns a texture holding the result. */
  private blur(src: WebGLTexture, sigmaPx: number): WebGLTexture {
    const gl = this.gl;
    let level = 0;
    let k = 1;
    while (sigmaPx / k > 3.2 && level < 5) {
      k *= 2;
      level++;
    }
    const sigma = sigmaPx / k;
    const radius = Math.min(16, Math.max(1, Math.ceil(sigma * 3)));
    gl.disable(gl.BLEND);
    // down-sample chain (bilinear = 2×2 box)
    let input = src;
    for (let l = 1; l <= level; l++) {
      const tgt = this.blurTarget(l, 'a');
      this.bind(tgt);
      gl.useProgram(this.pCopy.program);
      gl.uniform1i(this.pCopy.u('uTex'), UNIT_TEX);
      gl.uniform1f(this.pCopy.u('uOpaque'), 0);
      gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
      gl.bindTexture(gl.TEXTURE_2D, input);
      this.fullscreen();
      input = tgt.tex;
    }
    const pass = (from: WebGLTexture, to: Target, dx: number, dy: number): void => {
      this.bind(to);
      gl.useProgram(this.pBlur.program);
      gl.uniform1i(this.pBlur.u('uTex'), UNIT_TEX);
      gl.uniform2f(this.pBlur.u('uStep'), dx / to.w, dy / to.h);
      gl.uniform1f(this.pBlur.u('uSigma'), Math.max(0.05, sigma));
      gl.uniform1i(this.pBlur.u('uRadius'), radius);
      gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
      gl.bindTexture(gl.TEXTURE_2D, from);
      this.fullscreen();
    };
    // level 0: src → a (H) → b (V). level>0: input lives in blurTarget(level,'a'); H → b, V → a
    if (level === 0) {
      const a = this.blurTarget(0, 'a');
      const b = this.blurTarget(0, 'b');
      pass(input, a, 1, 0);
      pass(a.tex, b, 0, 1);
      return b.tex;
    }
    const inTarget = this.blurTarget(level, 'a');
    const other = this.blurTarget(level, 'b');
    pass(inTarget.tex, other, 1, 0);
    pass(other.tex, inTarget, 0, 1);
    return inTarget.tex;
  }

  /* ------------------------------------------------------------------ drawing ---------------- */

  private compositeTexture(
    tex: WebGLTexture,
    target: Target,
    opacity: number,
    blend: number,
  ): void {
    const gl = this.gl;
    this.bind(target);
    gl.useProgram(this.pComp.program);
    gl.uniform1i(this.pComp.u('uTex'), UNIT_TEX);
    gl.uniform1i(this.pComp.u('uDst'), UNIT_DST);
    gl.uniform2f(this.pComp.u('uCanvas'), this.w, this.h);
    gl.uniform1f(this.pComp.u('uOpacity'), opacity);
    gl.uniform1i(this.pComp.u('uBlend'), blend);
    if (blend !== 0 && target === this.comp) {
      this.snapshotComp();
      this.bind(target);
      this.bindDst((this.dstCopy as Target).tex);
    } else this.bindDst(this.dummy2D);
    this.setBlend(blend === 0);
    gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.fullscreen();
  }

  private setRect(
    p: Prog,
    g: { cx: number; cy: number; hw: number; hh: number; rot: number },
    k: number,
  ): void {
    const gl = this.gl;
    const r = (g.rot * Math.PI) / 180;
    gl.uniform2f(p.u('uCanvas'), this.w, this.h);
    gl.uniform4f(p.u('uRect'), g.cx * k, g.cy * k, g.hw * k, g.hh * k);
    gl.uniform2f(p.u('uRot'), Math.cos(r), Math.sin(r));
    gl.uniform1f(p.u('uPad'), 1.5);
  }

  /** Textured quad (media / text / subtitle). `blend` ≠ 0 only when drawing straight into comp. */
  private drawTextured(
    target: Target,
    geom: { cx: number; cy: number; hw: number; hh: number; rot: number },
    tex: WebGLTexture,
    texW: number,
    texH: number,
    uv: UvRect,
    mirror: boolean,
    opacity: number,
    blend: number,
    color: EffectiveColor | null,
    lut: { tex: WebGLTexture; size: number; amount: number } | null,
    k: number,
  ): void {
    const gl = this.gl;
    this.bind(target);
    const p = this.pLayer;
    gl.useProgram(p.program);
    this.setRect(p, geom, k);
    gl.uniform1i(p.u('uTex'), UNIT_TEX);
    gl.uniform1i(p.u('uDst'), UNIT_DST);
    gl.uniform1i(p.u('uLut'), UNIT_LUT);
    gl.uniform2f(p.u('uHalf'), geom.hw * k, geom.hh * k);
    gl.uniform4f(p.u('uUV'), uv.x, uv.y, uv.w, uv.h);
    gl.uniform2f(p.u('uTexel'), 1 / texW, 1 / texH);
    gl.uniform1f(p.u('uMirror'), mirror ? 1 : 0);
    gl.uniform1f(p.u('uOpacity'), opacity);
    gl.uniform1i(p.u('uBlend'), blend);
    if (color) {
      gl.uniform1f(p.u('uColorOn'), 1);
      gl.uniform4f(
        p.u('uColor'),
        Math.pow(2, color.ev),
        color.contrast,
        color.saturation,
        color.temperature,
      );
    } else gl.uniform1f(p.u('uColorOn'), 0);
    gl.activeTexture(gl.TEXTURE0 + UNIT_LUT);
    if (lut) {
      gl.bindTexture(gl.TEXTURE_3D, lut.tex);
      gl.uniform1f(p.u('uLutOn'), 1);
      gl.uniform1f(p.u('uLutSize'), lut.size);
      gl.uniform1f(p.u('uLutAmount'), lut.amount);
    } else {
      gl.bindTexture(gl.TEXTURE_3D, this.dummy3D);
      gl.uniform1f(p.u('uLutOn'), 0);
    }
    if (blend !== 0 && target === this.comp) {
      this.snapshotComp();
      this.bind(target);
      this.bindDst((this.dstCopy as Target).tex);
    } else this.bindDst(this.dummy2D);
    this.setBlend(blend === 0);
    gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.fullscreenRect();
  }

  private fullscreenRect(): void {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  private drawShape(
    target: Target,
    layer: SceneLayer,
    opacity: number,
    blend: number,
    k: number,
  ): void {
    const c = layer.content;
    if (c.kind !== 'shape') return;
    const gl = this.gl;
    this.bind(target);
    const p = this.pShape;
    gl.useProgram(p.program);
    const g = layer.geom;
    this.setRect(p, g, k);
    gl.uniform1i(p.u('uDst'), UNIT_DST);
    const kind = c.shape === 'ellipse' ? 1 : c.shape === 'arrow' ? 2 : 0;
    gl.uniform1i(p.u('uKind'), kind);
    gl.uniform2f(p.u('uHalf'), g.hw * k, g.hh * k);
    const frac = c.shape === 'progress-bar' ? c.progress : 1;
    gl.uniform2f(p.u('uBox'), g.hw * k * frac, -g.hw * k + g.hw * k * frac);
    gl.uniform1f(p.u('uRadius'), c.radius * layer.scaleK * k);
    gl.uniform1f(p.u('uStrokeW'), c.stroke ? c.stroke.width * layer.scaleK * k : 0);
    const f = hexToRgb(c.fill);
    gl.uniform3f(p.u('uFill'), f[0] / 255, f[1] / 255, f[2] / 255);
    gl.uniform1f(p.u('uFillA'), c.fillOpacity);
    const s = hexToRgb(c.stroke ? c.stroke.color : c.fill);
    gl.uniform3f(p.u('uStroke'), s[0] / 255, s[1] / 255, s[2] / 255);
    gl.uniform1f(p.u('uOpacity'), opacity);
    gl.uniform1i(p.u('uBlend'), blend);
    if (blend !== 0 && target === this.comp) {
      this.snapshotComp();
      this.bind(target);
      this.bindDst((this.dstCopy as Target).tex);
    } else this.bindDst(this.dummy2D);
    this.setBlend(blend === 0);
    this.fullscreenRect();
  }

  /** Draws the visual of one layer into `target` at `opacity` with `blend`. Returns false when its frame is missing. */
  private drawLayerContent(
    layer: SceneLayer,
    target: Target,
    opacity: number,
    blend: number,
    input: RenderInput,
    stage: 'bg' | 'main',
  ): boolean {
    const k = input.scale;
    const c = layer.content;
    switch (c.kind) {
      case 'shape':
        this.drawShape(target, layer, opacity, blend, k);
        return true;
      case 'text':
      case 'subtitle': {
        const r = input.raster(layer);
        if (!r) return true;
        const t = this.rasterTexture(r);
        const q = {
          ...layer.quad,
          hw: (r.drawW / 2) * layer.scaleK,
          hh: (r.drawH / 2) * layer.scaleK,
        };
        this.drawTextured(
          target,
          q,
          t.tex,
          t.w,
          t.h,
          { x: 0, y: 0, w: 1, h: 1 },
          false,
          opacity,
          blend,
          null,
          null,
          k,
        );
        return true;
      }
      case 'media': {
        const item = layer.item;
        const src =
          c.mediaType === 'video'
            ? input.frames.video(c.assetId, c.srcSec)
            : input.frames.image(c.assetId);
        if (!src) {
          if (stage === 'main')
            input.missing.push({ assetId: c.assetId, srcSec: c.srcSec, itemId: item.id });
          return false;
        }
        const slot = this.sourceTexture(`${c.mediaType}:${item.id}`, src);
        if (!slot) {
          if (stage === 'main')
            input.missing.push({ assetId: c.assetId, srcSec: c.srcSec, itemId: item.id });
          return false;
        }
        let lut: { tex: WebGLTexture; size: number; amount: number } | null = null;
        if (c.color && c.color.lutAssetId) {
          const l = input.frames.lut(c.color.lutAssetId);
          if (l)
            lut = {
              tex: this.lutTexture(c.color.lutAssetId, l),
              size: l.size,
              amount: c.color.lutAmount,
            };
        }
        if (stage === 'bg' && c.bg) {
          const W = input.project.canvas.width;
          const H = input.project.canvas.height;
          const g = { cx: W / 2, cy: H / 2, hw: W / 2, hh: H / 2, rot: 0 };
          this.drawTextured(
            target,
            g,
            slot.tex,
            slot.w,
            slot.h,
            c.bg.uv,
            c.mirror,
            opacity,
            blend,
            c.color,
            lut,
            k,
          );
        } else {
          this.drawTextured(
            target,
            layer.quad,
            slot.tex,
            slot.w,
            slot.h,
            c.uv,
            c.mirror,
            opacity,
            blend,
            c.color,
            lut,
            k,
          );
        }
        return true;
      }
    }
  }

  private renderLayer(
    layer: SceneLayer,
    target: Target,
    blend: BlendMode,
    input: RenderInput,
  ): void {
    if (layer.opacity <= 0.0005) return; // invisible: nothing to draw, no frame needed
    const k = input.scale;
    const bi = BLEND_INDEX[blend];
    const c = layer.content;
    const bg = c.kind === 'media' ? c.bg : null;
    const sigmaPx = layer.blurSigma * k;
    const needsTemp = sigmaPx > 0.25 || bg !== null;
    if (!needsTemp) {
      this.drawLayerContent(layer, target, layer.opacity, bi, input, 'main');
      return;
    }
    const T = this.ensure('temp');
    this.clear(T);
    if (bg) {
      const S = this.ensure('scratch');
      this.clear(S);
      if (this.drawLayerContent(layer, S, 1, 0, input, 'bg')) {
        const blurred = this.blur(S.tex, bg.sigma * k);
        this.compositeTexture(blurred, T, 1, 0);
      }
    }
    if (!this.drawLayerContent(layer, T, 1, 0, input, 'main')) return;
    const out = sigmaPx > 0.25 ? this.blur(T.tex, sigmaPx) : T.tex;
    this.compositeTexture(out, target, layer.opacity, bi);
  }

  private drawVeil(target: Target, veil: { color: string; alpha: number }): void {
    if (veil.alpha <= 0) return;
    const gl = this.gl;
    this.bind(target);
    gl.useProgram(this.pSolid.program);
    const c = hexToRgb(veil.color);
    gl.uniform4f(
      this.pSolid.u('uColor'),
      c[0] / 255,
      c[1] / 255,
      c[2] / 255,
      Math.min(1, veil.alpha),
    );
    gl.enable(gl.BLEND);
    // lay the colour over what the group already holds, keeping the group's own alpha (src-atop)
    gl.blendFuncSeparate(gl.DST_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    this.fullscreen();
  }

  /* ------------------------------------------------------------------ frame ------------------ */

  render(groups: SceneGroup[], input: RenderInput): void {
    const gl = this.gl;
    if (!this.comp) this.resize(this.w || 1, this.h || 1);
    this.frameNo++;
    this.drawCalls = 0;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const comp = this.comp as Target;
    const bgc = hexToRgb(input.project.canvas.background);
    this.clear(comp, bgc[0] / 255, bgc[1] / 255, bgc[2] / 255, 1);

    for (const g of groups) {
      const simple = g.layers.length === 1 && g.veil === null;
      if (simple) {
        const l = g.layers[0] as SceneLayer;
        this.renderLayer(l, comp, l.blend, input);
        continue;
      }
      const G = this.ensure('group');
      this.clear(G);
      for (const l of g.layers) this.renderLayer(l, G, 'normal', input);
      if (g.veil) this.drawVeil(G, g.veil);
      this.compositeTexture(G.tex, comp, 1, BLEND_INDEX[g.blend]);
    }
    this.present();
  }

  private present(): void {
    const gl = this.gl;
    const comp = this.comp as Target;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.pCopy.program);
    gl.uniform1i(this.pCopy.u('uTex'), UNIT_TEX);
    gl.uniform1f(this.pCopy.u('uOpaque'), 1);
    gl.activeTexture(gl.TEXTURE0 + UNIT_TEX);
    gl.bindTexture(gl.TEXTURE_2D, comp.tex);
    this.fullscreen();
  }

  /** RGBA8, top row first. Reads the presented default framebuffer. */
  readPixels(): { width: number; height: number; data: Uint8Array } {
    const gl = this.gl;
    const w = this.w;
    const h = this.h;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return { width: w, height: h, data: out };
  }
}
