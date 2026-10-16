import * as THREE from 'three';
import { tryJSON } from '../assets';
import { assetUrl } from '../platform/source';
import { unityFloat, unityTexture } from './pbr';

/**
 * Normal and occlusion maps for 3D stages. Their environment materials name a _BumpMap (Unity DXT5nm-style: X in
 * alpha times red, Y in green) and a _MetallicGlossMap (_MROX / _MROE: R metallic, G roughness, B ambient occlusion)
 * by path id; generated/stage-textures.json (tools/build_stage_textures.py) says where those PNGs are in the archive.
 * They are 2048² and a stage has dozens, so they stream in after the stage is shown, downscaled, a few at a time.
 */

interface Index {
  dirs: string[];
  ids: Record<string, string>;
  local: Record<string, Record<string, string>>;
}

/** Longest side kept on the GPU: normals carry the detail, occlusion is low-frequency. */
const MAX_NORMAL = 1024;
const MAX_MRO = 512;
const CONCURRENCY = 3;

let indexPromise: Promise<Index | null> | null = null;
const cache = new Map<string, Promise<THREE.Texture | null>>();
/** Textures cloned for a different UV transform (they share the original's image). */
const clones = new Map<THREE.Texture, THREE.Texture[]>();
/** Which stage folders use a PNG: it is dropped when the last of them is released. */
const users = new Map<string, Set<string>>();
const waiting: (() => void)[] = [];
let running = 0;

function slot<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++;
      job()
        .then(resolve, reject)
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < CONCURRENCY) start();
    else waiting.push(start);
  });
}

async function decode(url: string, max: number): Promise<THREE.Texture | null> {
  const res = await fetch(assetUrl(url));
  if (!res.ok) return null;
  // Not premultiplied: the normal map's alpha is data (X), and its red channel must survive where alpha is low.
  const opts: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' };
  let bitmap = await createImageBitmap(await res.blob(), opts);
  const side = Math.max(bitmap.width, bitmap.height);
  if (side > max) {
    const k = max / side;
    const small = await createImageBitmap(bitmap, { ...opts, resizeWidth: Math.round(bitmap.width * k), resizeHeight: Math.round(bitmap.height * k), resizeQuality: 'high' });
    bitmap.close();
    bitmap = small;
  }
  const t = new THREE.Texture(bitmap as unknown as HTMLImageElement);
  t.colorSpace = THREE.NoColorSpace;
  t.flipY = false; // same convention as glTF textures
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

function load(url: string, max: number, scene: string) {
  (users.get(url) ?? users.set(url, new Set()).get(url)!).add(scene);
  let p = cache.get(url);
  if (!p) {
    p = slot(() => decode(url, max)).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Archive URL of a Unity texture slot of the stage's material, or null. */
function resolve(index: Index, scene: string, mat: THREE.Material, name: string) {
  const id = unityTexture(mat, name);
  if (id === undefined) return null;
  const hit = index.ids[String(id)];
  if (hit) {
    const slash = hit.indexOf('/');
    return `/arc/03-ExtractedAssets/${index.dirs[Number(hit.slice(0, slash))]}/Texture2D/${hit.slice(slash + 1)}.png`;
  }
  const local = index.local[scene]?.[String(id)];
  return local ? `/arc/03-ExtractedAssets/scenes/${scene}/Texture2D/${local}.png` : null;
}

/** Remap three's Lambert normal and AO sampling to EC's packing. */
function patch(mat: THREE.MeshLambertMaterial) {
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader
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
  };
  mat.customProgramCacheKey = () => `${prevKey()}|ec-stagemaps`;
}

/** Follow the base colour's UV transform (tiling / offset) so the detail lines up with the albedo. */
function matchUv(t: THREE.Texture, like: THREE.Texture | null) {
  if (!like || (like.repeat.x === 1 && like.repeat.y === 1 && like.offset.x === 0 && like.offset.y === 0 && like.rotation === 0)) return t;
  const c = t.clone();
  clones.set(t, [...(clones.get(t) ?? []), c]);
  c.repeat.copy(like.repeat);
  c.offset.copy(like.offset);
  c.rotation = like.rotation;
  c.center.copy(like.center);
  c.needsUpdate = true;
  return c;
}

/**
 * Give a stage's Lambert materials (render/toon.ts stylizeEnvironment) their normal and occlusion maps once the
 * PNGs have streamed in. `scene` is the stage folder name (environment_0156), which scopes small path ids.
 */
export function attachStageMaps(root: THREE.Object3D, scene: string) {
  const mats = new Set<THREE.MeshLambertMaterial>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of [mesh.material].flat()) if ((m as THREE.MeshLambertMaterial).isMeshLambertMaterial) mats.add(m as THREE.MeshLambertMaterial);
  });
  if (!mats.size) return Promise.resolve();
  indexPromise ??= tryJSON<Index>('/gen/stage-textures.json');
  return indexPromise.then((index) => {
    if (!index) return;
    const jobs: Promise<void>[] = [];
    for (const mat of mats) {
      const bump = resolve(index, scene, mat, '_BumpMap');
      const mro = resolve(index, scene, mat, '_MetallicGlossMap');
      if (!bump && !mro) continue;
      patch(mat);
      if (bump) {
        const scale = unityFloat(mat, '_BumpScale') ?? 1;
        jobs.push(
          load(bump, MAX_NORMAL, scene).then((t) => {
            if (!t) return;
            mat.normalMap = matchUv(t, mat.map);
            // Derivative tangent frames + glTF's flipped V: same correction GLTFLoader applies.
            mat.normalScale.set(scale, -scale);
            mat.needsUpdate = true;
          }),
        );
      }
      if (mro) {
        jobs.push(
          load(mro, MAX_MRO, scene).then((t) => {
            if (!t) return;
            mat.aoMap = matchUv(t, mat.map);
            mat.aoMapIntensity = unityFloat(mat, '_OcclusionStrength') ?? 1;
            mat.needsUpdate = true;
          }),
        );
      }
    }
    return Promise.all(jobs).then(() => undefined);
  });
}

/** Free the GPU and bitmap memory of the maps a stage streamed in (call when its GameMap is disposed). */
export function releaseStageMaps(scene: string) {
  for (const [url, set] of users) {
    if (!set.delete(scene) || set.size) continue;
    users.delete(url);
    const p = cache.get(url);
    cache.delete(url);
    void p?.then((t) => {
      if (!t) return;
      for (const c of clones.get(t) ?? []) c.dispose();
      clones.delete(t);
      t.dispose();
      (t.image as ImageBitmap).close?.();
    });
  }
}
