import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { Quality } from '../game/settings';

/** Brightest value (linear) a pixel contributes to the bloom. */
const BLOOM_CLAMP = 3;

/** MSAA samples of the HDR target per Settings → Graphics → Quality (4x cost ~15 fps more than 2x for little gain). */
export const BLOOM_SAMPLES: Record<Quality, number> = { low: 0, medium: 2, high: 2 };

/** A scene's URP Bloom (post_profile_env_*): threshold in linear HDR, intensity, scatter 0..1. */
export interface BloomParams {
  threshold: number;
  intensity: number;
  scatter: number;
}

/** A scene's URP colour grading and vignette (ColorAdjustments, LiftGammaGain, Vignette), already in linear light. */
export interface GradeParams {
  /** 2^postExposure. */
  exposure: number;
  colorFilter: THREE.Color;
  /** 1 + contrast / 100. */
  contrast: number;
  /** 1 + saturation / 100. */
  saturation: number;
  lift: THREE.Vector3;
  gain: THREE.Vector3;
  invGamma: THREE.Vector3;
  vignette: { color: THREE.Color; intensity: number; smoothness: number; center: THREE.Vector2; rounded: boolean } | null;
}

type PostProfile = Record<string, Record<string, { value: unknown; override: boolean }>>;

const LUMA = [0.2126, 0.7152, 0.0722];

/** URP's colour wheel + slider vector -> per-channel tint around grey plus the brightness slider. */
function wheel(v: { x: number; y: number; z: number; w: number } | undefined) {
  const c = v ?? { x: 1, y: 1, z: 1, w: 0 };
  const luma = c.x * LUMA[0] + c.y * LUMA[1] + c.z * LUMA[2];
  return { tint: new THREE.Vector3(c.x - luma, c.y - luma, c.z - luma), w: c.w };
}

/**
 * The scene's ColorAdjustments (post exposure, filter, contrast, saturation), LiftGammaGain and Vignette overrides,
 * or null when it has none. The lift / gamma / gain mapping approximates URP's colour wheels.
 */
export function gradeFromPost(post: PostProfile | undefined): GradeParams | null {
  if (!post) return null;
  const get = <T>(effect: string, key: string, fallback: T): T => {
    const p = post[effect]?.[key];
    return p?.override && p.value !== undefined ? (p.value as T) : fallback;
  };
  const has = (effect: string) => Object.values(post[effect] ?? {}).some((p) => p.override);
  const adjust = has('ColorAdjustments');
  const lgg = has('LiftGammaGain');
  const vig = has('Vignette');
  if (!adjust && !lgg && !vig) return null;
  const rgb = (v: readonly number[]) => new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
  const lift = wheel(get('LiftGammaGain', 'lift', undefined));
  const gamma = wheel(get('LiftGammaGain', 'gamma', undefined));
  const gain = wheel(get('LiftGammaGain', 'gain', undefined));
  const g: GradeParams = {
    exposure: 2 ** get('ColorAdjustments', 'postExposure', 0),
    colorFilter: rgb(get('ColorAdjustments', 'colorFilter', [1, 1, 1])),
    contrast: 1 + get('ColorAdjustments', 'contrast', 0) / 100,
    saturation: 1 + get('ColorAdjustments', 'saturation', 0) / 100,
    lift: lift.tint.multiplyScalar(0.15).addScalar(lift.w * 0.15),
    gain: gain.tint.addScalar(1 + gain.w),
    invGamma: new THREE.Vector3(1, 1, 1).divide(gamma.tint.multiplyScalar(0.8).addScalar(1 + gamma.w).max(new THREE.Vector3(0.05, 0.05, 0.05))),
    vignette: null,
  };
  if (vig) {
    const center = get<{ x: number; y: number }>('Vignette', 'center', { x: 0.5, y: 0.5 });
    g.vignette = {
      color: rgb(get('Vignette', 'color', [0, 0, 0])),
      intensity: get('Vignette', 'intensity', 0),
      smoothness: get('Vignette', 'smoothness', 0.2),
      center: new THREE.Vector2(center.x, center.y),
      rounded: !!get('Vignette', 'rounded', 0),
    };
    if (g.vignette.intensity <= 0) g.vignette = null;
  }
  // A vignette of zero intensity and nothing else overridden is no grade at all.
  return !g.vignette && !adjust && !lgg ? null : g;
}

/**
 * Vignette, then URP's colour grade, on the HDR frame. It runs inside the output pass (before the tonemap): a pass of
 * its own would cost a full-screen resolve of the multisampled target.
 */
const GRADE_UNIFORMS = {
  gradeOn: { value: 0 },
  exposure: { value: 1 },
  colorFilter: { value: new THREE.Color(1, 1, 1) },
  contrast: { value: 1 },
  saturation: { value: 1 },
  lift: { value: new THREE.Vector3() },
  gain: { value: new THREE.Vector3(1, 1, 1) },
  invGamma: { value: new THREE.Vector3(1, 1, 1) },
  vigColor: { value: new THREE.Color(0, 0, 0) },
  vigParams: { value: new THREE.Vector2(0, 1) },
  vigCenter: { value: new THREE.Vector2(0.5, 0.5) },
  vigAspect: { value: 1 },
};

const GRADE_PARS = /* glsl */ `
uniform float gradeOn;
uniform float exposure;
uniform vec3 colorFilter;
uniform float contrast;
uniform float saturation;
uniform vec3 lift;
uniform vec3 gain;
uniform vec3 invGamma;
uniform vec3 vigColor;
uniform vec2 vigParams;
uniform vec2 vigCenter;
uniform float vigAspect;

vec3 ecGrade( vec3 c, vec2 uv ) {
	if ( vigParams.x > 0.0 ) {
		vec2 d = abs( uv - vigCenter ) * vigParams.x;
		d.x *= vigAspect;
		c *= mix( vigColor, vec3( 1.0 ), pow( clamp( 1.0 - dot( d, d ), 0.0, 1.0 ), vigParams.y ) );
	}
	c *= exposure * colorFilter;
	c = c * gain + lift;
	c = sign( c ) * pow( abs( c ), invGamma );
	if ( contrast != 1.0 ) {
		// Around mid grey in ACEScc, like URP.
		vec3 cc = ( log2( max( c, vec3( 1e-5 ) ) ) + 9.72 ) / 17.52;
		cc = ( cc - 0.4135884 ) * contrast + 0.4135884;
		c = exp2( cc * 17.52 - 9.72 );
	}
	float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	return max( vec3( 0.0 ), mix( vec3( luma ), c, saturation ) );
}
`;

/**
 * HDR post-processing: the scene renders into a half-float, multisampled target, then URP-style bloom picks out
 * what is brighter than the profile's threshold (emissive lamps, sun glare), the profile's vignette and colour
 * grade apply, and the output pass encodes sRGB. With neither bloom nor grading the frame goes straight to the canvas.
 */
export class PostFx {
  private readonly composer: EffectComposer;
  private readonly pass: RenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly output: OutputPass;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: BLOOM_SAMPLES.high, stencilBuffer: true });
    this.composer = new EffectComposer(renderer, target);
    this.pass = new RenderPass(new THREE.Scene(), new THREE.PerspectiveCamera());
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 1, 0.5, 1);
    // Like URP's bloom clamp: stacked additive particles reach hundreds in HDR and would flood the screen.
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace('vec4 texel = texture2D( tDiffuse, vUv );', `vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\ttexel.rgb = min( texel.rgb, vec3( ${BLOOM_CLAMP.toFixed(1)} ) );`);
    hp.needsUpdate = true;
    this.output = new OutputPass();
    Object.assign(this.output.uniforms, GRADE_UNIFORMS);
    const frag = this.output.material.fragmentShader;
    this.output.material.fragmentShader = frag
      .replace('varying vec2 vUv;', `varying vec2 vUv;\n${GRADE_PARS}`)
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );', 'gl_FragColor = texture2D( tDiffuse, vUv );\n\t\t\tif ( gradeOn > 0.5 ) gl_FragColor.rgb = ecGrade( gl_FragColor.rgb, vUv );');
    this.composer.addPass(this.pass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
  }

  /** MSAA samples of the HDR target (the canvas' own antialiasing does not apply to it). */
  setSamples(samples: number) {
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples === samples) continue;
      t.samples = samples;
      t.dispose();
    }
  }

  setSize(width: number, height: number) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, bloom: BloomParams | null, grade: GradeParams | null = null) {
    if (!bloom && !grade) {
      this.renderer.render(scene, camera);
      return;
    }
    this.pass.scene = scene;
    this.pass.camera = camera;
    this.bloom.enabled = !!bloom;
    this.output.uniforms.gradeOn.value = grade ? 1 : 0;
    if (bloom) this.setBloom(bloom);
    if (grade) this.setGrade(grade);
    this.composer.render();
  }

  private setBloom(bloom: BloomParams) {
    // URP's intensity is a gain on the blurred highlights; Unreal's strength spreads over five mips, so scale it down.
    this.bloom.strength = bloom.intensity * 0.4;
    this.bloom.radius = THREE.MathUtils.clamp(bloom.scatter, 0, 1) * 0.6;
    this.bloom.threshold = bloom.threshold;
    // URP's soft knee: pixels just over the threshold (white sky, clouds) barely glow; lamps far above it do.
    (this.bloom.highPassUniforms as Record<string, THREE.IUniform<number>>).smoothWidth.value = Math.max(bloom.threshold, 0.25);
  }

  private setGrade(g: GradeParams) {
    const u = this.output.uniforms as typeof GRADE_UNIFORMS;
    u.exposure.value = g.exposure;
    u.colorFilter.value.copy(g.colorFilter);
    u.contrast.value = g.contrast;
    u.saturation.value = g.saturation;
    u.lift.value.copy(g.lift);
    u.gain.value.copy(g.gain);
    u.invGamma.value.copy(g.invGamma);
    const v = g.vignette;
    u.vigParams.value.set(v ? v.intensity * 3 : 0, v ? v.smoothness * 5 : 1);
    if (v) {
      u.vigColor.value.copy(v.color);
      u.vigCenter.value.copy(v.center);
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      u.vigAspect.value = v.rounded ? size.x / size.y : 1;
    }
  }
}
