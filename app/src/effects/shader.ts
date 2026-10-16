import * as THREE from 'three';
import type { EffectMaterial, Renderer } from './types';

/**
 * three.js version of EC's "Applibot/Particles/Standard" particle shader (and a light version of
 * CommandParticleLit), for instanced particles. The maths follows the game's D3D11 programs (see
 * tools/convert_effects.py): UVs rotated + scaled + offset by custom vertex data, distortion, mask power,
 * blend-rate-from-RGB alpha, colour magnification, Unity blend factors.
 *
 * Per-instance attributes (written by ParticleSim): iPos (render space), iSize, iRot (billboard roll in x, or a
 * quaternion for meshes), iColor, iUV (sheet frame offset.xy, scale.zw), iVel (render space), iC1 / iC2 (custom data).
 */

const BLEND: Record<number, number> = {
  0: THREE.ZeroFactor,
  1: THREE.OneFactor,
  2: THREE.DstColorFactor,
  3: THREE.SrcColorFactor,
  4: THREE.OneMinusDstColorFactor,
  5: THREE.SrcAlphaFactor,
  6: THREE.OneMinusSrcColorFactor,
  7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor,
  9: THREE.SrcAlphaSaturateFactor,
  10: THREE.OneMinusSrcAlphaFactor,
};

const SWZ = ['x', 'y', 'z', 'w'];

/** GLSL expression for a custom-data driven parameter (0.0 when the material does not route one). */
function cd(m: EffectMaterial, p: string) {
  const v = m.coords?.[p];
  if (v === undefined) return '0.0';
  return `${v >= 4 ? 'iC2' : 'iC1'}.${SWZ[v & 3]}`;
}

export interface MaterialTextures {
  map?: THREE.Texture | null;
  mask?: THREE.Texture | null;
  dist?: THREE.Texture | null;
  emis?: THREE.Texture | null;
  dissolve?: THREE.Texture | null;
}

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iSize;
attribute vec4 iRot;
attribute vec4 iColor;
attribute vec4 iUV;
attribute vec3 iVel;
attribute vec4 iC1;
attribute vec4 iC2;
uniform vec4 uMainST;
uniform vec4 uMaskST;
uniform vec4 uDistST;
uniform vec4 uEmisST;
uniform vec4 uDissolveST;
uniform vec3 uRot;        // texRot, maskRot, distRot (degrees)
uniform vec3 uPows;       // maskPow, distPow, colorMag
uniform vec4 uStretch;    // lengthScale, velocityScale, pivot.x, pivot.y
varying vec2 vMain;
varying vec2 vMask;
varying vec2 vDist;
varying vec2 vEmis;
varying vec2 vDissolve;
varying vec4 vColor;
varying vec3 vPows;
varying vec4 vExtra;      // dissolve progress, edge luminance, rim sharpness, emission intensity
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vFogDepth;

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec2 rotUV(vec2 uv, float deg) {
  float r = radians(deg);
  float s = sin(r), c = cos(r);
  uv -= 0.5;
  return vec2(c * uv.x + s * uv.y, -s * uv.x + c * uv.y) + 0.5;
}

void main() {
  vec2 uv0 = iUV.xy + uv * iUV.zw;
  vMain = rotUV(uv0, uRot.x + CD_TEXROT) * uMainST.xy + uMainST.zw + vec2(CD_MAINU, CD_MAINV);
  vMask = rotUV(uv0, uRot.y + CD_MASKROT) * uMaskST.xy + uMaskST.zw + vec2(CD_MASKU, CD_MASKV);
  vDist = rotUV(uv0, uRot.z + CD_DISTROT) * uDistST.xy + uDistST.zw + vec2(CD_DISTU, CD_DISTV);
  vEmis = uv0 * uEmisST.xy + uEmisST.zw + vec2(CD_EMISU, CD_EMISV);
  vDissolve = uv0 * uDissolveST.xy + uDissolveST.zw + vec2(CD_DISSOLVEU, CD_DISSOLVEV);
  vPows = vec3(uPows.x + CD_MASKPOW, uPows.y + CD_DISTPOW, uPows.z + CD_MAG);
  vExtra = vec4(CD_DISSOLVE, CD_EDGELUM, CD_RIMSHARP, CD_EMIS);
  vColor = iColor;
  vec3 n = vec3(0.0, 0.0, 1.0);
  vec4 wp;
#if MODE == 6
  // trail ribbons: built in world space on the CPU
  wp = vec4(position, 1.0);
  n = normalize(cameraPosition - position);
#elif MODE == 4
  // mesh particles: Unity mesh space, rotated (quaternion), scaled, placed; view alignment uses camera axes
  #if ALIGN == 0
    vec3 off = qrot(iRot, position * iSize);
    vec4 mvc = modelViewMatrix * vec4(iPos, 1.0);
    vec4 mv = mvc + vec4(off.x, off.y, -off.z, 0.0);
    wp = inverse(viewMatrix) * mv;
    n = normalize((inverse(viewMatrix) * vec4(qrot(iRot, normal) * vec3(1.0, 1.0, -1.0), 0.0)).xyz);
  #else
    wp = modelMatrix * vec4(qrot(iRot, position * iSize) + iPos, 1.0);
    n = normalize(mat3(modelMatrix) * qrot(iRot, normal));
  #endif
#else
  vec4 wc = modelMatrix * vec4(iPos, 1.0);
  vec2 corner = (position.xy + uStretch.zw) * iSize.xy;
  #if MODE == 1
    // stretched billboard: texture U runs back along the velocity (EC streaks have their head at u = 0)
    vec3 wv = mat3(modelMatrix) * iVel;
    vec3 vv = mat3(viewMatrix) * wv;
    float spd = length(wv);
    vec2 d = length(vv.xy) > 1e-5 ? normalize(vv.xy) : vec2(1.0, 0.0);
    vec2 perp = vec2(-d.y, d.x);
    float len = iSize.x * uStretch.x + spd * uStretch.y;
    vec4 mvs = viewMatrix * wc;
    mvs.xy += d * (-position.x) * len + perp * position.y * iSize.y;
    wp = inverse(viewMatrix) * mvs;
  #elif MODE == 2
    // horizontal billboard: flat on the ground plane
    float a = iRot.x;
    float s = sin(a), c = cos(a);
    wp = wc + vec4(c * corner.x - s * corner.y, 0.0, s * corner.x + c * corner.y, 0.0);
    n = vec3(0.0, 1.0, 0.0);
  #elif MODE == 3
    // vertical billboard: faces the camera, stays upright
    vec3 toCam = cameraPosition - wc.xyz;
    toCam.y = 0.0;
    vec3 right = length(toCam) > 1e-5 ? normalize(cross(vec3(0.0, 1.0, 0.0), toCam)) : vec3(1.0, 0.0, 0.0);
    float a = -iRot.x;
    float s = sin(a), c = cos(a);
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    wp = wc + vec4(right * rc.x + vec3(0.0, rc.y, 0.0), 0.0);
  #elif ALIGN == 2 || ALIGN == 1
    // local / world aligned quad: the system's XY plane
    float a = -iRot.x;
    float s = sin(a), c = cos(a);
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    wp = modelMatrix * vec4(iPos + vec3(rc, 0.0), 1.0);
    n = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, -1.0));
  #else
    // view-facing billboard; Unity rolls clockwise for positive angles
    float a = -iRot.x;
    float s = sin(a), c = cos(a);
    vec4 mvb = viewMatrix * wc;
    mvb.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    wp = inverse(viewMatrix) * mvb;
  #endif
#endif
  vWorld = wp.xyz;
  vNormal = n;
  vViewDir = normalize(cameraPosition - wp.xyz);
  vec4 mvPosition = viewMatrix * wp;
  vFogDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
#ifdef ZOFFSET
  gl_Position.z += ZOFFSET * 0.0001 * gl_Position.w;
#endif
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uMaskMap;
uniform sampler2D uDistMap;
uniform sampler2D uEmisMap;
uniform sampler2D uDissolveMap;
uniform vec4 uColor;
uniform float uAlpha;
uniform vec2 uHeight;
uniform vec2 uRim;
uniform vec4 uRimColor;
uniform vec4 uRimParams;
uniform vec4 uEmisColor;
uniform vec4 uDissolveParams;  // progress, edge, inverse, vertexAlphaMode
uniform float uClip;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogDensity;
varying vec2 vMain;
varying vec2 vMask;
varying vec2 vDist;
varying vec2 vEmis;
varying vec2 vDissolve;
varying vec4 vColor;
varying vec3 vPows;
varying vec4 vExtra;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vViewDir;
varying float vFogDepth;

void main() {
  vec2 uvMain = vMain;
  vec2 uvMask = vMask;
#ifdef USE_DIST
  float dd = texture2D(uDistMap, vDist).r * vPows.y;
  uvMain += dd;
  #ifdef DIST_MASK
  uvMask += dd;
  #endif
#endif
#ifdef USE_MAP
  vec4 tex = texture2D(uMap, uvMain);
#else
  vec4 tex = vec4(1.0);
#endif
  vec4 col = vColor * uColor;
#ifdef RGB_ALPHA
  vec3 rgb = col.rgb;
  float a = (tex.r + tex.g + tex.b) * (1.0 / 3.0) * col.a;
#else
  vec3 rgb = tex.rgb * col.rgb;
  float a = tex.a * col.a;
#endif
#ifdef USE_MASK
  a *= pow(max(texture2D(uMaskMap, uvMask).r, 0.0), max(vPows.x, 0.001));
#endif
#ifdef USE_HEIGHT
  a *= clamp((vWorld.y - uHeight.x) / max(uHeight.y, 0.0001), 0.0, 1.0);
#endif
  vec3 nrm = normalize(vNormal);
  float facing = abs(dot(nrm, normalize(vViewDir)));
#ifdef USE_RIM
  float rim = 1.0 - facing;
  if (uRim.y > 0.5) rim = 1.0 - rim;
  a *= pow(max(rim, 0.0), max(uRim.x + vExtra.z, 0.001));
#endif
#ifdef USE_RIM_COLOR
  float rc = pow(max(1.0 - facing, 0.0), uRimParams.x) * uRimParams.y;
  if (uRimParams.w > 0.5) rc = 1.0 - rc;
  rgb = uRimParams.z > 0.5 ? rgb + uRimColor.rgb * rc : mix(rgb, uRimColor.rgb, clamp(rc, 0.0, 1.0));
#endif
#ifdef USE_EMIS
  rgb += texture2D(uEmisMap, vEmis).rgb * uEmisColor.rgb * (uEmisColor.a + vExtra.w);
#endif
#ifdef LIT
  rgb *= 0.55 + 0.45 * facing;
  rgb += uEmisColor.rgb * uEmisColor.a;
#endif
#ifdef USE_DISSOLVE
  float prog = uDissolveParams.w < 0.5 ? 1.0 - vColor.a : uDissolveParams.x + vExtra.x;
  float dv = texture2D(uDissolveMap, vDissolve).r;
  if (uDissolveParams.z > 0.5) dv = 1.0 - dv;
  a = uDissolveParams.w < 0.5 ? tex.a * uColor.a : a;
  a *= smoothstep(prog, prog + max(uDissolveParams.y, 0.001), dv);
#endif
#ifdef MULTIPLY
  rgb = mix(vec3(1.0), min(rgb, vec3(1.0)), clamp(a, 0.0, 1.0));
#endif
  rgb *= vPows.z;
  a *= uAlpha;
#ifdef USE_CLIP
  if (a < uClip) discard;
#endif
#ifdef USE_FOG
  #ifdef FOG_EXP2
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
  float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  a *= 1.0 - fogFactor;
  #ifdef MULTIPLY
  rgb = mix(rgb, vec3(1.0), fogFactor);
  #endif
#endif
  // EC's materials carry HDR multipliers (x48 ... x225000) on the particle colour. Limit by the brightest channel so
  // the hue survives (orange fire, blue thunder), with a little headroom over 1 for the bloom pass.
  rgb = max(rgb, vec3(0.0));
  float peak = max(rgb.r, max(rgb.g, rgb.b));
  if (peak > HDR_MAX) rgb *= HDR_MAX / peak;
  gl_FragColor = vec4(rgb, clamp(a, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function st(t: { st?: number[] } | undefined) {
  const s = t?.st ?? [1, 1, 0, 0];
  return new THREE.Vector4(s[0], s[1], s[2], s[3]);
}

/** One three.js material for an EC effect material drawn by one renderer mode (6 = trail ribbons). */
export function buildMaterial(m: EffectMaterial, r: Renderer, tex: MaterialTextures, fog: THREE.Fog | THREE.FogExp2 | null): THREE.ShaderMaterial {
  const defines: Record<string, string | number> = {
    MODE: r.mode === 4 ? 4 : r.mode,
    HDR_MAX: '1.6',
    ALIGN: r.align ?? 0,
    CD_MAINU: cd(m, 'mainU'),
    CD_MAINV: cd(m, 'mainV'),
    CD_TEXROT: cd(m, 'texRot'),
    CD_MASKU: cd(m, 'maskU'),
    CD_MASKV: cd(m, 'maskV'),
    CD_MASKROT: cd(m, 'maskRot'),
    CD_MASKPOW: cd(m, 'maskPow'),
    CD_DISTU: cd(m, 'distU'),
    CD_DISTV: cd(m, 'distV'),
    CD_DISTROT: cd(m, 'distRot'),
    CD_DISTPOW: cd(m, 'distPow'),
    CD_MAG: cd(m, 'mag'),
    CD_RIMSHARP: cd(m, 'rimSharp'),
    CD_EMISU: cd(m, 'emisU'),
    CD_EMISV: cd(m, 'emisV'),
    CD_EMIS: cd(m, 'emis'),
    CD_DISSOLVEU: cd(m, 'dissolveU'),
    CD_DISSOLVEV: cd(m, 'dissolveV'),
    CD_DISSOLVE: cd(m, 'dissolve'),
    CD_EDGELUM: cd(m, 'edgeLum'),
  };
  if (tex.map) defines.USE_MAP = 1;
  if (tex.mask) defines.USE_MASK = 1;
  if (tex.dist) {
    defines.USE_DIST = 1;
    if (m.distMask) defines.DIST_MASK = 1;
  }
  if (tex.emis) defines.USE_EMIS = 1;
  if (tex.dissolve) defines.USE_DISSOLVE = 1;
  if (m.rgbAlpha) defines.RGB_ALPHA = 1;
  if (m.height) defines.USE_HEIGHT = 1;
  if (m.rim) defines.USE_RIM = 1;
  if (m.rimColor) defines.USE_RIM_COLOR = 1;
  if (m.lit) defines.LIT = 1;
  if (m.clip !== undefined) defines.USE_CLIP = 1;
  if (m.zoffset) defines.ZOFFSET = (-m.zoffset).toFixed(3);
  const [src, dst] = m.blend;
  if (src === 2 && (dst === 0 || dst === 1)) defines.MULTIPLY = 1;
  if (fog) {
    defines.USE_FOG = 1;
    if ((fog as THREE.FogExp2).isFogExp2) defines.FOG_EXP2 = 1;
  }
  const white = new THREE.Vector4(1, 1, 1, 1);
  const c = m.color ?? [1, 1, 1, 1];
  const rc = m.rimColor ?? [1, 1, 1, 1, 1, 1, 0, 0];
  const ec = m.emisColor ?? [0, 0, 0, 0];
  const mat = new THREE.ShaderMaterial({
    name: `fx:${m.name}`,
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    uniforms: {
      uMap: { value: tex.map ?? null },
      uMaskMap: { value: tex.mask ?? null },
      uDistMap: { value: tex.dist ?? null },
      uEmisMap: { value: tex.emis ?? null },
      uDissolveMap: { value: tex.dissolve ?? null },
      uMainST: { value: st(m.tex) },
      uMaskST: { value: st(m.mask) },
      uDistST: { value: st(m.dist) },
      uEmisST: { value: st(m.emis) },
      uDissolveST: { value: st(m.dissolveTex) },
      uRot: { value: new THREE.Vector3(m.texRot ?? 0, m.maskRot ?? 0, m.distRot ?? 0) },
      uPows: { value: new THREE.Vector3(m.maskPow ?? 1, m.distPow ?? 0, m.mag ?? 1) },
      uStretch: { value: new THREE.Vector4(r.len ?? 1, r.vel ?? 0, r.pivot?.[0] ?? 0, r.pivot?.[1] ?? 0) },
      uColor: { value: new THREE.Vector4(c[0], c[1], c[2], c[3]) },
      uAlpha: { value: m.alpha ?? 1 },
      uHeight: { value: new THREE.Vector2(m.height?.[0] ?? 0, m.height?.[1] ?? 1) },
      uRim: { value: new THREE.Vector2(m.rim?.[0] ?? 1, m.rim?.[1] ?? 0) },
      uRimColor: { value: m.rimColor ? new THREE.Vector4(rc[0], rc[1], rc[2], rc[3]) : white },
      uRimParams: { value: new THREE.Vector4(rc[4] ?? 1, rc[5] ?? 1, rc[6] ?? 0, rc[7] ?? 0) },
      uEmisColor: { value: new THREE.Vector4(ec[0], ec[1], ec[2], m.emisPow ?? 1) },
      uDissolveParams: { value: new THREE.Vector4(m.dissolve ?? 0, m.dissolveEdge ?? 0.1, m.dissolveInv ?? 0, m.vertexAlpha ?? 0) },
      uClip: { value: m.clip ?? 0 },
      fogColor: { value: fog ? fog.color : new THREE.Color() },
      fogNear: { value: (fog as THREE.Fog | null)?.near ?? 1 },
      fogFar: { value: (fog as THREE.Fog | null)?.far ?? 1000 },
      fogDensity: { value: (fog as THREE.FogExp2 | null)?.density ?? 0 },
    },
    transparent: true,
    depthWrite: !!m.zwrite,
    depthTest: m.ztest !== 0,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: BLEND[src] as THREE.BlendingSrcFactor,
    blendDst: (BLEND[dst] ?? THREE.OneMinusSrcAlphaFactor) as THREE.BlendingDstFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  mat.toneMapped = true;
  return mat;
}
