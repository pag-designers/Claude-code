/** GLSL sources for the compositor (WebGL2 / GLSL ES 3.00). All colour maths is in non-linear sRGB 0..1, like FFmpeg. */

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

/** Full-screen triangle strip from gl_VertexID (no buffers). */
export const VS_FULL = `${HEAD}
out vec2 vUv;
void main(){
  vec2 p = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * A rotated rectangle: uniforms give the centre (px, y down), half size and rotation (cos, sin, clockwise in y-down
 * space). \`vLocal\` is the pixel offset from the centre in the rect's own axes; \`uPad\` grows the quad for edge AA.
 */
export const VS_RECT = `${HEAD}
uniform vec2 uCanvas;
uniform vec4 uRect;   // cx, cy, hw, hh  (px)
uniform vec2 uRot;    // cos, sin
uniform float uPad;
out vec2 vLocal;
void main(){
  vec2 u = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vec2 l = u * (uRect.zw + uPad);
  vec2 p = vec2(uRot.x * l.x - uRot.y * l.y, uRot.y * l.x + uRot.x * l.y) + uRect.xy;
  vLocal = l;
  gl_Position = vec4(p.x / uCanvas.x * 2.0 - 1.0, 1.0 - p.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

/** Blend modes against an OPAQUE backdrop \`cb\` with straight source colour \`cs\` (W3C compositing formulas). */
const BLEND_FN = `
vec3 blendRGB(int mode, vec3 cb, vec3 cs){
  if (mode == 1) return cb * cs;                                   // multiply
  if (mode == 2) return cb + cs - cb * cs;                         // screen
  if (mode == 3) return mix(2.0 * cb * cs, 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs), step(0.5, cb)); // overlay
  if (mode == 4) return min(cb + cs, vec3(1.0));                   // add
  if (mode == 5) return min(cb, cs);                               // darken
  if (mode == 6) return max(cb, cs);                               // lighten
  return cs;                                                       // normal
}
// source colour (straight) + alpha -> output: normal = premultiplied (hardware 'over'); others replace the backdrop
vec4 emit(int mode, sampler2D dst, vec3 cs, float a){
  if (mode == 0) return vec4(cs * a, a);
  vec3 cb = texelFetch(dst, ivec2(gl_FragCoord.xy), 0).rgb;
  return vec4(mix(cb, blendRGB(mode, cb, cs), a), 1.0);
}`;

export const FS_LAYER = `${HEAD}
${BLEND_FN}
in vec2 vLocal;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uDst;
uniform sampler3D uLut;
uniform vec2 uHalf;      // half size of the drawn rect (px)
uniform vec4 uUV;        // normalised source rect x,y,w,h
uniform vec2 uTexel;     // 1 / texture size
uniform float uMirror;
uniform float uOpacity;
uniform int uBlend;
uniform float uColorOn;
uniform vec4 uColor;     // gain (2^ev), contrast, saturation, temperature
uniform float uLutOn;
uniform float uLutSize;
uniform float uLutAmount;
void main(){
  vec2 q = vLocal / (2.0 * uHalf) + 0.5;
  float cov = clamp(min(uHalf.x - abs(vLocal.x), uHalf.y - abs(vLocal.y)) + 0.5, 0.0, 1.0);
  if (uMirror > 0.5) q.x = 1.0 - q.x;
  vec2 lo = uUV.xy + 0.5 * uTexel;
  vec2 hi = max(lo, uUV.xy + uUV.zw - 0.5 * uTexel);
  vec2 uv = clamp(uUV.xy + q * uUV.zw, lo, hi);
  vec4 s = texture(uTex, uv);            // premultiplied
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  if (uColorOn > 0.5) {
    c = clamp((clamp(c * uColor.x, 0.0, 1.0) - 0.5) * uColor.y + 0.5, 0.0, 1.0);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = clamp(vec3(l) + (c - vec3(l)) * uColor.z, 0.0, 1.0);
    c.r = clamp(c.r * (1.0 + 0.25 * uColor.w), 0.0, 1.0);
    c.b = clamp(c.b * (1.0 - 0.25 * uColor.w), 0.0, 1.0);
  }
  if (uLutOn > 0.5) {
    vec3 lc = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
    c = mix(c, lc, uLutAmount);
  }
  o = emit(uBlend, uDst, c, s.a * cov * uOpacity);
}`;

/** rect / ellipse / line / arrow / progress-bar as signed-distance shapes; stroke is an INSIDE band of the natural rect. */
export const FS_SHAPE = `${HEAD}
${BLEND_FN}
in vec2 vLocal;
out vec4 o;
uniform sampler2D uDst;
uniform int uKind;       // 0 rect/line/progress, 1 ellipse, 2 arrow
uniform vec2 uHalf;      // natural half size (px)
uniform vec2 uBox;       // progress-bar: filled half width, centre x offset (px) -> (hw*frac, -hw + hw*frac)
uniform float uRadius;
uniform float uStrokeW;
uniform vec3 uFill;
uniform float uFillA;
uniform vec3 uStroke;
uniform float uOpacity;
uniform int uBlend;

float sdBox(vec2 p, vec2 b, float r){
  r = min(r, min(b.x, b.y));
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
float sdEllipse(vec2 p, vec2 r){
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k1 > 0.0 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
}
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }
// arrow pointing right: shaft (40 % of the height) + triangular head; polygon of 7 points
float sdArrow(vec2 p, vec2 h){
  float head = min(h.x, h.y * 1.8);               // head length
  float sh = h.y * 0.4;                            // shaft half thickness
  vec2 v[7];
  v[0] = vec2(-h.x, -sh); v[1] = vec2(h.x - head, -sh); v[2] = vec2(h.x - head, -h.y); v[3] = vec2(h.x, 0.0);
  v[4] = vec2(h.x - head, h.y); v[5] = vec2(h.x - head, sh); v[6] = vec2(-h.x, sh);
  float d = dot(p - v[0], p - v[0]);
  float s = 1.0;
  for (int i = 0, j = 6; i < 7; j = i, i++) {
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
void main(){
  float sd;
  if (uKind == 1) sd = sdEllipse(vLocal, uHalf);
  else if (uKind == 2) sd = sdArrow(vLocal, uHalf);
  else sd = sdBox(vLocal - vec2(uBox.y, 0.0), vec2(uBox.x, uHalf.y), uRadius);
  float cov = clamp(0.5 - sd, 0.0, 1.0);
  float inner = uStrokeW > 0.0 ? clamp(0.5 - (sd + uStrokeW), 0.0, 1.0) : cov;
  float sa = cov * (1.0 - inner);
  float fa = uFillA * inner;
  float a = sa + fa;
  vec3 c = a > 0.0 ? (uStroke * sa + uFill * fa) / a : uFill;
  o = emit(uBlend, uDst, c, a * uOpacity);
}`;

/** Composite a premultiplied layer texture (any size) onto the backdrop. */
export const FS_COMP = `${HEAD}
${BLEND_FN}
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform sampler2D uDst;
uniform vec2 uCanvas;
uniform float uOpacity;
uniform int uBlend;
void main(){
  vec4 s = texture(uTex, gl_FragCoord.xy / uCanvas);
  vec3 c = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  o = emit(uBlend, uDst, c, s.a * uOpacity);
}`;

/** Raw copy (down-sampling, presenting to the canvas). */
export const FS_COPY = `${HEAD}
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform float uOpaque;
void main(){
  vec4 s = texture(uTex, vUv);
  o = uOpaque > 0.5 ? vec4(s.rgb, 1.0) : s;
}`;

/** One pass of a separable gaussian (premultiplied, clamp-to-edge). */
export const FS_BLUR = `${HEAD}
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;      // texel step along the blur axis
uniform float uSigma;
uniform int uRadius;
void main(){
  vec4 acc = vec4(0.0);
  float ws = 0.0;
  float inv = -0.5 / (uSigma * uSigma);
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = exp(inv * float(i * i));
    acc += texture(uTex, vUv + uStep * float(i)) * w;
    ws += w;
  }
  o = acc / ws;
}`;

/** Solid colour (veil) laid over what is already in the group (blend: DST_ALPHA). */
export const FS_SOLID = `${HEAD}
out vec4 o;
uniform vec4 uColor;     // straight rgb + alpha
void main(){ o = vec4(uColor.rgb * uColor.a, uColor.a); }`;
