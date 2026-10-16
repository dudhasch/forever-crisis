import * as THREE from 'three';
import { tryJSON } from '../assets';
import { assetUrl } from '../platform/source';

/**
 * PBR look for battle models. Their GLBs only embed the base colour; the extracted bundle folder in the
 * archive also holds, per texture stem:
 *   _MROX  R = metallic, G = roughness, B = ambient occlusion
 *   _NNNX  Unity DXT5nm-style normal map: X in alpha (times red), Y in green
 *   _MROE  monsters: same packing as _MROX
 * plus the toon ramps (_RampMap, e.g. tex_ch001_001_ramp_skin) the materials point at.
 */

const loader = new THREE.TextureLoader();
const cache = new Map<string, Promise<THREE.Texture | null>>();

function loadLinear(url: string, colorSpace: THREE.ColorSpace = THREE.NoColorSpace) {
  let p = cache.get(url);
  if (!p) {
    p = loader
      .loadAsync(assetUrl(url))
      .then((t) => {
        t.colorSpace = colorSpace;
        t.flipY = false; // same convention as glTF textures
        t.anisotropy = 4;
        return t;
      })
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** "/lib/unity/character/001/model/003/model.glb" -> "/arc/03-ExtractedAssets/character/001/model/003/" (monster/NNN too) */
function extractedFolder(glbUrl: string) {
  const m = /\/unity\/((?:character|monster)\/[^/]+\/model\/[^/]+)\//.exec(glbUrl);
  return m ? `/arc/03-ExtractedAssets/${m[1]}/` : null;
}

export function isBattleModel(glbUrl: string) {
  return /\/unity\/(character|monster)\//.test(glbUrl);
}

interface Inventory {
  objects: { type: string; name: string; path_id: number }[];
}

export interface PbrMaps {
  mro: Map<string, THREE.Texture>;
  normal: Map<string, THREE.Texture>;
  /** Toon ramp per material name. */
  ramp: Map<string, THREE.Texture>;
}

/** A Unity texture slot's m_PathID, as preserved in glTF extras. */
export function unityTexture(m: THREE.Material, slot: string): number | undefined {
  const props = (m.userData as { unityShaderProperties?: { m_TexEnvs?: [string, { m_Texture: { m_FileID: number; m_PathID: number } }][] } }).unityShaderProperties;
  const t = props?.m_TexEnvs?.find(([k]) => k === slot)?.[1].m_Texture;
  return t && !t.m_FileID && t.m_PathID ? t.m_PathID : undefined;
}

/** Load the MRO and normal maps that belong to this battle model's base-colour textures. */
export async function loadPbrMaps(glbUrl: string, root: THREE.Object3D): Promise<PbrMaps | null> {
  const folder = extractedFolder(glbUrl);
  if (!folder) return null;
  const inv = await tryJSON<Inventory>(`${folder}_bundle_inventory.json`);
  const have = new Set(inv?.objects.filter((o) => o.type === 'Texture2D').map((o) => o.name) ?? []);
  // JSON numbers: int64 path ids round the same way here as in the glTF extras.
  const byId = new Map(inv?.objects.filter((o) => o.type === 'Texture2D').map((o) => [o.path_id, o.name]) ?? []);
  const stems = new Set<string>();
  const ramps = new Map<string, string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
      const name = m.map?.name ?? '';
      const stem = /^(tex_.+)_[A-Z]{4}$/.exec(name)?.[1];
      if (stem) stems.add(stem);
      const ramp = byId.get(unityTexture(m, '_RampMap') ?? NaN);
      if (ramp) ramps.set(m.name, ramp);
    }
  });
  const out: PbrMaps = { mro: new Map(), normal: new Map(), ramp: new Map() };
  await Promise.all([
    ...[...stems].flatMap((stem) =>
      (['MROX', 'MROE', 'NNNX'] as const).map(async (kind) => {
        if (!have.has(`${stem}_${kind}`)) return;
        const t = await loadLinear(`${folder}Texture2D/${stem}_${kind}.png`);
        if (t) (kind === 'NNNX' ? out.normal : out.mro).set(stem, t);
      }),
    ),
    ...[...ramps].map(async ([mat, tex]) => {
      const t = await loadLinear(`${folder}Texture2D/${tex}.png`, THREE.SRGBColorSpace);
      if (!t) return;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = 1;
      out.ramp.set(mat, t);
    }),
  ]);
  return out;
}

/** Unity material floats preserved by the converter in glTF extras. */
export function unityFloat(m: THREE.Material, name: string): number | undefined {
  const props = (m.userData as { unityShaderProperties?: { m_Floats?: [string, number][] } }).unityShaderProperties;
  return props?.m_Floats?.find(([k]) => k === name)?.[1];
}

/** Remap three's channel conventions to EC's packing. */
function patchShader(shader: THREE.WebGLProgramParametersWithUniforms, glossScale: number) {
  shader.uniforms.glossScale = { value: glossScale };
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float glossScale;`)
    // G is roughness; _GlossMapScale scales the smoothness it implies.
    .replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment.replace('roughnessFactor *= texelRoughness.g;', 'roughnessFactor *= 1.0 - ( 1.0 - texelRoughness.g ) * glossScale;'))
    .replace('#include <metalnessmap_fragment>', THREE.ShaderChunk.metalnessmap_fragment.replace('texelMetalness.b', 'texelMetalness.r'))
    .replace('#include <aomap_fragment>', THREE.ShaderChunk.aomap_fragment.replace('texture2D( aoMap, vAoMapUv ).r', 'texture2D( aoMap, vAoMapUv ).b'))
    .replace(
      '#include <normal_fragment_maps>',
      THREE.ShaderChunk.normal_fragment_maps.replace(
        'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
        `vec4 packedN = texture2D( normalMap, vNormalMapUv );
	vec3 mapN;
	mapN.xy = vec2( packedN.r * packedN.a, packedN.g ) * 2.0 - 1.0;
	mapN.z = sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) );`,
      ),
    );
}

/** glTF material -> MeshStandardMaterial with the battle model's own MRO / normal maps. */
export function toPbr(src: THREE.Material, maps: PbrMaps | null): THREE.Material {
  const m = src as THREE.MeshStandardMaterial;
  if (!m.isMeshStandardMaterial) return src;
  const name = m.map?.name ?? '';
  const stem = /^(tex_.+)_[A-Z]{4}$/.exec(name)?.[1] ?? '';
  const cutout = /_AAAT$/.test(name) || /eyelash|eye_shadow|hair_tp/i.test(m.name);
  const mro = maps?.mro.get(stem) ?? null;
  const normal = maps?.normal.get(stem) ?? null;
  const out = new THREE.MeshStandardMaterial({
    name: m.name,
    map: m.map,
    color: m.color.clone(),
    // _Metallic scales the map's red channel (hair maps are solid white, with _Metallic 0.4).
    metalness: mro ? (unityFloat(m, '_Metallic') ?? 1) : 0,
    roughness: mro ? 1 : 0.75,
    metalnessMap: mro,
    roughnessMap: mro,
    aoMap: mro,
    aoMapIntensity: 1,
    normalMap: normal,
    // Derivative tangent frames + glTF's flipped V: same correction GLTFLoader applies.
    normalScale: new THREE.Vector2(1, -1),
    alphaTest: cutout ? 0.5 : 0,
    side: m.side,
    envMapIntensity: 0.8,
  });
  if (/eye_shadow/i.test(m.name)) {
    out.transparent = true;
    out.alphaTest = 0;
    out.depthWrite = false;
  }
  const glossScale = unityFloat(m, '_GlossMapScale') ?? 1;
  if (mro || normal) out.onBeforeCompile = (shader) => patchShader(shader, glossScale);
  out.customProgramCacheKey = () => (mro || normal ? 'ec-pbr' : '');
  return out;
}

/**
 * A soft image-based light from a map's ambient colours (sky above, equator around, ground below),
 * so metal surfaces reflect something plausible instead of black.
 */
export function gradientEnvironment(renderer: THREE.WebGLRenderer, sky: THREE.Color, equator: THREE.Color, ground: THREE.Color) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const colors: number[] = [];
  const pos = geo.getAttribute('position');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(equator).lerp(sky, Math.pow(y, 0.6));
    else c.copy(equator).lerp(ground, Math.pow(-y, 0.6));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.02);
  pmrem.dispose();
  geo.dispose();
  return rt.texture;
}
