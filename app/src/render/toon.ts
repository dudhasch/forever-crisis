import * as THREE from 'three';
import { toPbr, unityFloat, type PbrMaps } from './pbr';
import { applyLightmap, type Lightmap } from './stage';

/**
 * EC's character shading on top of MeshStandardMaterial: the direct light goes through a ramp instead of N·L
 * (battle models: their own _RampMap, e.g. tex_ch001_001_ramp_skin; story models: a two-tone step to
 * _ShadeColor), plus a view rim (_RimPower / _rimPower), _SpecularIntensity and _AmbientMutiply.
 */
export interface EcToonParams {
  ramp: THREE.Texture | null;
  /** Shadow tone when there is no ramp texture. */
  shade: THREE.Color;
  /** Half-width of the shade step in half-Lambert units (0.5 = terminator). */
  softness: number;
  rimColor: THREE.Color;
  rimPower: number;
  specular: number;
  ambient: THREE.Color;
}

/**
 * Settings → Graphics, shared by every toon material: `strength` blends EC's ramp and rim (1) with plain N·L
 * lighting (0); `outline` 0 hides the character outlines.
 */
export const TOON_SETTINGS = { strength: { value: 1 }, outline: { value: 1 } };

/**
 * EC's additional character light (EnvironmentData.additionalLightPower): a fill from above-left behind the camera
 * (view space), so fighters with the stage sun at their back still read. Only toon materials see it, not the
 * scenery. GameMap sets the colour each frame for the map being shown.
 */
export const CHARACTER_FILL = { dir: { value: new THREE.Vector3(-0.35, 0.75, 0.55).normalize() }, color: { value: new THREE.Color(0, 0, 0) } };

/** Battle rim when the material leaves _RimColor black (the game drives it per scene). */
const BATTLE_RIM = new THREE.Color(0.32, 0.31, 0.3);

function unityColor(m: THREE.Material, name: string): THREE.Color | undefined {
  const props = (m.userData as { unityShaderProperties?: { m_Colors?: [string, { r: number; g: number; b: number }][] } }).unityShaderProperties;
  const c = props?.m_Colors?.find(([k]) => k === name)?.[1];
  return c ? new THREE.Color(c.r, c.g, c.b) : undefined;
}

/** EC toon parameters from the Unity material properties kept in glTF extras. */
export function ecToonParams(src: THREE.Material, ramp: THREE.Texture | null, battle: boolean): EcToonParams {
  if (battle) {
    const rim = unityColor(src, '_RimColor');
    return {
      ramp,
      // Monsters without a ramp (_rampEnable 0): a soft cel step.
      shade: new THREE.Color(0.42, 0.4, 0.42),
      softness: 0.12,
      rimColor: rim && rim.getHex() ? rim : BATTLE_RIM.clone(),
      rimPower: unityFloat(src, '_RimPower') || 5,
      specular: unityFloat(src, '_SpecularIntensity') ?? 1,
      ambient: unityColor(src, '_AmbientMutiply') ?? new THREE.Color(1, 1, 1),
    };
  }
  // Story (questcharacter) shader: _ShadeColor two-tone, _rimColor x _rimIntensity, _unlight for faces.
  const unlit = (unityFloat(src, '_unlight') ?? 0) > 0.5;
  const shade = unityColor(src, '_ShadeColor') ?? new THREE.Color(0.8, 0.8, 0.8);
  const rim = (unityColor(src, '_rimColor') ?? new THREE.Color(1, 1, 1)).multiplyScalar((unityFloat(src, '_rimIntensity') ?? 1) * 0.12);
  return {
    ramp: null,
    // EC's shade colour multiplies the lit colour; deepen it a little since our key light is softer.
    shade: unlit ? new THREE.Color(0.92, 0.9, 0.9) : shade.clone().multiplyScalar(0.72),
    softness: 0.03,
    rimColor: rim,
    rimPower: unityFloat(src, '_rimPower') || 8,
    specular: 0.3,
    ambient: new THREE.Color(1, 1, 1),
  };
}

/** Patch a MeshStandardMaterial with EC's toon terms; keeps any onBeforeCompile it already has. */
export function applyEcToon(mat: THREE.MeshStandardMaterial, p: EcToonParams) {
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.ecRamp = { value: p.ramp };
    shader.uniforms.ecShade = { value: p.shade };
    shader.uniforms.ecSoftness = { value: p.softness };
    shader.uniforms.ecRimColor = { value: p.rimColor };
    shader.uniforms.ecRimPower = { value: p.rimPower };
    shader.uniforms.ecSpecular = { value: p.specular };
    shader.uniforms.ecAmbient = { value: p.ambient };
    shader.uniforms.ecToonStrength = TOON_SETTINGS.strength;
    shader.uniforms.ecFillDir = CHARACTER_FILL.dir;
    shader.uniforms.ecFillColor = CHARACTER_FILL.color;
    const lightsPars = THREE.ShaderChunk.lights_physical_pars_fragment
      .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = mix( vec3( dotNL ), ecRampLight( dot( geometryNormal, directLight.direction ) ), ecToonStrength ) * directLight.color;')
      .replace('reflectedLight.directSpecular += irradiance * specularBRDF', 'reflectedLight.directSpecular += ecSpecular * dotNL * directLight.color * specularBRDF');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 ecShade;
uniform float ecSoftness;
uniform vec3 ecRimColor;
uniform float ecRimPower;
uniform float ecSpecular;
uniform vec3 ecAmbient;
uniform float ecToonStrength;
uniform vec3 ecFillDir;
uniform vec3 ecFillColor;
${p.ramp ? 'uniform sampler2D ecRamp;' : ''}
vec3 ecRampLight( float nl ) {
	float u = clamp( nl * 0.5 + 0.5, 0.004, 0.996 );
	${p.ramp ? 'return texture2D( ecRamp, vec2( u, 0.5 ) ).rgb;' : 'return mix( ecShade, vec3( 1.0 ), smoothstep( 0.5 - ecSoftness, 0.5 + ecSoftness, u ) );'}
}`,
      )
      .replace('#include <lights_physical_pars_fragment>', lightsPars)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
	reflectedLight.indirectDiffuse *= ecAmbient;
	{
		float ecFillNl = dot( normal, ecFillDir );
		reflectedLight.directDiffuse += mix( vec3( saturate( ecFillNl ) ), ecRampLight( ecFillNl ), ecToonStrength ) * ecFillColor * BRDF_Lambert( material.diffuseColor );
	}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
		float ecRim = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), ecRimPower );
		// Tinted by the albedo, plus a little white so dark cloth still shows its edge.
		outgoingLight += ecToonStrength * ecRimColor * ecRim * ( diffuseColor.rgb * 1.5 + 0.3 );
	}
	#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey()}|ec-toon${p.ramp ? '-ramp' : ''}`;
  return mat;
}

function textureName(m: THREE.MeshStandardMaterial) {
  return (m.map?.name || (m.map?.image as HTMLImageElement | undefined)?.src || m.name || '').toString();
}

/** Story model material -> EC toon, honouring EC's texture suffixes (_AAAT = alpha cut-out). */
export function toToon(src: THREE.Material): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return src;
  const name = textureName(m);
  const cutout = /_AAAT\b|_AAAT$|_AAAT\./i.test(name) || /eyelash|eye_shadow|hair_tp/i.test(m.name);
  const toon = new THREE.MeshStandardMaterial({
    name: m.name,
    map: m.map,
    color: m.color.clone(),
    metalness: 0,
    roughness: 0.7,
    envMapIntensity: 0.35,
    alphaTest: cutout ? 0.5 : 0,
    transparent: false,
    side: m.side,
  });
  toon.userData = m.userData;
  if (/eye_shadow/i.test(m.name)) {
    toon.transparent = true;
    toon.alphaTest = 0;
    toon.depthWrite = false;
  }
  return applyEcToon(toon, ecToonParams(m, null, false));
}

/** Inverted-hull outline material that works for skinned meshes too. */
export function outlineMaterial(width = 0.006, color = 0x101014) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    // Offset in bind space, before skinning, so it follows the skeleton.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineWidth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;');
    shader.uniforms.outlineOn = TOON_SETTINGS.outline;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float outlineOn;')
      .replace('void main() {', 'void main() {\n\tif ( outlineOn < 0.5 ) discard;');
  };
  return mat;
}

/** Ghost material for the occluded-character silhouette EC draws behind scenery. */
export function silhouetteMaterial(color: THREE.ColorRepresentation, opacity: number) {
  // Only where scenery hides the character: depth behind, and not on pixels the character
  // itself already covers (stencil set by markStencil), so self-occlusion doesn't ghost.
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
}

function markStencil(m: THREE.Material) {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = THREE.AlwaysStencilFunc;
  m.stencilZPass = THREE.ReplaceStencilOp;
  return m;
}

/**
 * Prepare a character model: toon materials, EC's own `backface_geo` hull as outline, an
 * outline for models without one, and an occlusion silhouette pass.
 */
export function stylizeCharacter(root: THREE.Object3D, opts: { outline: boolean; silhouette?: THREE.Color; pbr?: PbrMaps | null }) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  const hasHull = meshes.some((m) => /backface/i.test(m.name));
  for (const mesh of meshes) {
    // The stage's sun casts the characters' shadows (EC's "limited shadow" around them).
    mesh.castShadow = !/backface/i.test(mesh.name);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    if (/backface/i.test(mesh.name)) {
      // EC's own hull is already offset: a zero-width outline, so it follows the Outlines setting too
      mesh.material = outlineMaterial(0, 0x0c0c10);
      continue;
    }
    // Battle models: their own MRO / normal maps and ramps; story models: EC's two-tone toon.
    const battle = (m: THREE.Material) => {
      const out = toPbr(m, opts.pbr ?? null) as THREE.MeshStandardMaterial;
      return out.isMeshStandardMaterial ? applyEcToon(out, ecToonParams(m, opts.pbr?.ramp.get(m.name) ?? null, true)) : out;
    };
    const conv = (m: THREE.Material) => markStencil(opts.pbr !== undefined ? battle(m) : toToon(m));
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
  }
  for (const mesh of meshes) {
    if (/backface/i.test(mesh.name)) continue;
    const skinned = mesh as THREE.SkinnedMesh;
    const extra: THREE.Mesh[] = [];
    if (opts.outline && !hasHull && !/eye|mouth|lash|shadow/i.test(mesh.name)) extra.push(cloneWith(skinned, outlineMaterial()));
    if (opts.silhouette) extra.push(cloneWith(skinned, silhouetteMaterial(opts.silhouette, 0.45)));
    for (const e of extra) mesh.parent?.add(e);
  }
}

function cloneWith(mesh: THREE.SkinnedMesh, material: THREE.Material): THREE.Mesh {
  if (mesh.isSkinnedMesh) {
    const s = new THREE.SkinnedMesh(mesh.geometry, material);
    s.bind(mesh.skeleton, mesh.bindMatrix);
    s.position.copy(mesh.position);
    s.quaternion.copy(mesh.quaternion);
    s.scale.copy(mesh.scale);
    s.frustumCulled = false;
    s.renderOrder = material.depthFunc === THREE.GreaterDepth ? 10 : 0;
    return s;
  }
  const m = new THREE.Mesh(mesh.geometry, material);
  m.position.copy(mesh.position);
  m.quaternion.copy(mesh.quaternion);
  m.scale.copy(mesh.scale);
  return m;
}

/** The baked lightmap a stage mesh uses (converter v5 puts lightmapIndex on the node; multi-material nodes are groups). */
function lightmapIndex(o: THREE.Object3D): number | undefined {
  for (let p: THREE.Object3D | null = o, i = 0; p && i < 2; p = p.parent, i++) {
    const v = (p.userData as { lightmapIndex?: number }).lightmapIndex;
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * Light-touch toon conversion for 3D environment meshes (keeps textures, flattens shading). Lightmapped meshes get
 * their baked lightmap; the others are lit by the scene's lights and ambient. Returns the unlightmapped materials
 * (they take the stage's ambient environment once the renderer has built it).
 */
export function stylizeEnvironment(root: THREE.Object3D, lightmaps: (Lightmap | null)[] = []) {
  const cache = new Map<string, THREE.MeshLambertMaterial>();
  const unbaked = new Set<THREE.MeshLambertMaterial>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const index = lightmapIndex(mesh);
    const lm = index !== undefined && mesh.geometry.getAttribute('uv1') ? (lightmaps[index] ?? null) : null;
    const conv = (m: THREE.Material) => {
      const s = m as THREE.MeshStandardMaterial;
      if (!s.isMeshStandardMaterial) return m;
      const key = `${s.uuid}|${lm ? index : '-'}`;
      let lam = cache.get(key);
      if (!lam) {
        lam = new THREE.MeshLambertMaterial({
          name: s.name,
          map: s.map,
          color: s.color.clone(),
          transparent: s.transparent,
          opacity: s.opacity,
          alphaTest: s.alphaTest || (s.transparent ? 0.3 : 0),
          side: s.side,
          emissive: s.emissive?.clone(),
          emissiveMap: s.emissiveMap,
          emissiveIntensity: s.emissiveIntensity,
          reflectivity: 0,
        });
        lam.userData = s.userData;
        if (lm) applyLightmap(lam, lm);
        else unbaked.add(lam);
        cache.set(key, lam);
      }
      return lam;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(conv) : conv(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  return [...unbaked];
}
