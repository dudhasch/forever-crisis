import * as THREE from 'three';
import type { ShadowQuality } from '../game/settings';
import type { StageLighting } from '../types';

/**
 * EC's scene lighting on three.js (generated/lighting/<map>.json, tools/extract_lighting.py):
 *  - baked lightmaps (converter v5: TEXCOORD_1 + root extras.lightmaps, RGBM in linear space) hold the sky light and
 *    the baked lamps; the sun ("directional_light_not_affect_bake") stays realtime and casts the shadows;
 *  - characters get the sun plus EnvironmentData's 4-way ambient (sky, ground, ±X, ±Z equator);
 *  - RenderSettings linear fog.
 * Unity's Lambert has no 1/π, three's does: light and lightmap intensities are scaled by π to match.
 */

/** Settings → Graphics, read by every GameMap each frame. */
export const STAGE_SETTINGS = { shadows: 'high' as ShadowQuality };

const SHADOW = {
  low: { size: 2048, distance: 28 },
  high: { size: 4096, distance: 45 },
} as const;

/** A Unity colour (stored in gamma) in three's linear working space. */
export function unityColor(c: readonly number[] | undefined, fallback: readonly number[]) {
  const v = c ?? fallback;
  return new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
}

/** Ambient light from six directions (three.js axes: Unity +X is three -X). */
export interface AmbientCube {
  px: THREE.Color;
  nx: THREE.Color;
  py: THREE.Color;
  ny: THREE.Color;
  pz: THREE.Color;
  nz: THREE.Color;
}

/** EnvironmentData's sky / ground / 4-way equator with its saturation and brightness, else RenderSettings' trilight. */
export function ambientCube(l: StageLighting | null): AmbientCube | null {
  const e = l?.env;
  const r = l?.render;
  if (!e && !r) return null;
  const sky = e?.skyColor ?? r?.ambientSky;
  const ground = e?.groundColor ?? r?.ambientGround;
  const eq = r?.ambientEquator;
  const cube: AmbientCube = {
    px: unityColor(e?.equatorColorMinusX ?? e?.equatorColorPlusX ?? eq, [0.4, 0.42, 0.48]),
    nx: unityColor(e?.equatorColorPlusX ?? eq, [0.4, 0.42, 0.48]),
    py: unityColor(sky, [0.55, 0.6, 0.7]),
    ny: unityColor(ground, [0.2, 0.2, 0.25]),
    pz: unityColor(e?.equatorColorPlusZ ?? e?.equatorColorPlusX ?? eq, [0.4, 0.42, 0.48]),
    nz: unityColor(e?.equatorColorMinusZ ?? e?.equatorColorPlusX ?? eq, [0.4, 0.42, 0.48]),
  };
  const sat = e?.saturation ?? 1;
  const bright = (e?.brightness ?? 1) * (e ? 1 : (r?.ambientIntensity ?? 1));
  for (const c of Object.values(cube) as THREE.Color[]) {
    const luma = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    c.setRGB(luma + (c.r - luma) * sat, luma + (c.g - luma) * sat, luma + (c.b - luma) * sat).multiplyScalar(bright);
  }
  return cube;
}

/** The cube's colour for a unit direction (squared-cosine blend, like Unity's ambient cube). */
export function cubeColor(cube: AmbientCube, n: THREE.Vector3, out = new THREE.Color()) {
  const x = n.x * n.x;
  const y = n.y * n.y;
  const z = n.z * n.z;
  const s = x + y + z || 1;
  out.setRGB(0, 0, 0);
  const add = (c: THREE.Color, w: number) => {
    out.r += c.r * w;
    out.g += c.g * w;
    out.b += c.b * w;
  };
  add(n.x >= 0 ? cube.px : cube.nx, x / s);
  add(n.y >= 0 ? cube.py : cube.ny, y / s);
  add(n.z >= 0 ? cube.pz : cube.nz, z / s);
  return out;
}

/** Image-based ambient from the cube, for MeshStandard characters and unlit-by-lightmap Lambert props. */
export function cubeEnvironment(renderer: THREE.WebGLRenderer, cube: AmbientCube) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 48, 24);
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(pos, i).normalize();
    cubeColor(cube, n, c).toArray(colors, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.04);
  pmrem.dispose();
  geo.dispose();
  return rt.texture;
}

/** How much of the baked (lightmap) light a realtime sun shadow takes away. */
const BAKED_SHADOW = 0.4;

export interface Lightmap {
  texture: THREE.Texture;
  encoding: 'RGBM' | 'dLDR' | 'HDR' | 'LDR' | string;
}

/** GLSL that turns the raw lightmap texel into linear irradiance (URP's UnpackLightmapRGBM / DoubleLDR, linear). */
function decodeLightmap(encoding: string) {
  if (encoding === 'RGBM') return 'lightMapTexel.rgb * ( 34.493242 * pow( lightMapTexel.a, 2.2 ) )';
  if (encoding === 'dLDR') return 'lightMapTexel.rgb * 4.594794';
  return 'lightMapTexel.rgb';
}

/**
 * A lightmapped environment material: the lightmap replaces ambient (sky, hemisphere, probes); the sun still adds
 * its direct light and shadows on top, as with Unity's mixed sun that is not in the bake.
 */
export function applyLightmap(mat: THREE.MeshLambertMaterial, lm: Lightmap) {
  mat.lightMap = lm.texture;
  mat.lightMapIntensity = Math.PI;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.ecBakedShadow = { value: BAKED_SHADOW };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float ecBakedShadow;')
      .replace(
        '#include <lights_fragment_maps>',
        'irradiance = vec3( 0.0 );\n' +
          THREE.ShaderChunk.lights_fragment_maps.replace(
            'irradiance += lightMapIrradiance;',
            `// Like Unity's subtractive shadows: the sun's shadow (characters, scenery) also dims the baked light.
		#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
			DirectionalLightShadow ecSun = directionalLightShadows[ 0 ];
			float ecLit = receiveShadow ? getShadow( directionalShadowMap[ 0 ], ecSun.shadowMapSize, 1.0, ecSun.shadowBias, ecSun.shadowRadius, vDirectionalShadowCoord[ 0 ] ) : 1.0;
			lightMapIrradiance *= mix( 1.0 - ecBakedShadow, 1.0, ecLit );
		#endif
		irradiance += lightMapIrradiance;`,
          ).replace('lightMapTexel.rgb * lightMapIntensity', `${decodeLightmap(lm.encoding)} * lightMapIntensity`),
      );
  };
  mat.customProgramCacheKey = () => `ec-lightmap-${lm.encoding}`;
  return mat;
}

/** The lightmap textures a v5 stage GLB lists in its root extras (raw texels, second UV set). */
export async function loadLightmaps(parser: { json: { extras?: { lightmaps?: ({ texture: number; encoding: string } | null)[] } }; getDependency: (type: string, i: number) => Promise<unknown> }) {
  const defs = parser.json.extras?.lightmaps ?? [];
  return Promise.all(
    defs.map(async (d): Promise<Lightmap | null> => {
      if (!d) return null;
      const texture = (await parser.getDependency('texture', d.texture).catch(() => null)) as THREE.Texture | null;
      if (!texture) return null;
      texture.colorSpace = THREE.NoColorSpace;
      texture.channel = 1;
      texture.flipY = false;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return { texture, encoding: d.encoding };
    }),
  );
}

/** RenderSettings / EnvironmentData linear fog. */
export function stageFog(l: StageLighting | null): THREE.Fog | null {
  const e = l?.env;
  const r = l?.render;
  const on = e && e.affectFog ? !!e.useFog : !!r?.fog;
  if (!on) return null;
  const near = (e?.affectFog ? e.fogStartDistance : undefined) ?? r?.fogStart ?? 10;
  const far = (e?.affectFog ? e.fogEndDistance : undefined) ?? r?.fogEnd ?? 500;
  if (!(far > near)) return null;
  return new THREE.Fog(unityColor(e?.affectFog ? e.fogColor : r?.fogColor, [0.5, 0.5, 0.5]), near, far);
}

/** The scene's sun: its first active directional light (Unity intensities are linear, times π for three). */
export function stageSun(l: StageLighting | null) {
  const d = l?.lights.find((x) => x.type === 'directional' && x.active) ?? l?.lights.find((x) => x.type === 'directional');
  if (!d) return null;
  const light = new THREE.DirectionalLight(unityColor(d.color, [1, 1, 1]), d.intensity * Math.PI);
  light.name = d.name;
  // three lights shine from position towards target: the opposite of the Unity forward axis.
  const dir = new THREE.Vector3().fromArray(d.direction).normalize();
  light.userData.direction = dir;
  light.userData.softShadows = d.shadows === 'soft';
  light.userData.castsShadows = d.shadows !== 'none';
  light.shadow.intensity = d.shadowStrength ?? 1;
  light.shadow.normalBias = 0.02;
  light.shadow.bias = -0.0004;
  light.shadow.radius = 2;
  return light;
}

/**
 * Stages have up to a few thousand opaque meshes, and drawing each one into the shadow map every frame halves the
 * frame rate. Their geometry never moves, so merge it (world space, positions only) into one shadow-only mesh;
 * the meshes themselves stop casting. Alpha-tested ones (fences, leaves) keep casting on their own so their holes
 * still let light through. Returns a child for `root`; call after the world matrices are up to date.
 */
export function buildShadowProxy(root: THREE.Object3D): THREE.Mesh | null {
  const parts: { geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }[] = [];
  const toRoot = root.matrixWorld.clone().invert();
  let vertices = 0;
  let indices = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    for (let p: THREE.Object3D | null = mesh; p; p = p.parent) if (!p.visible) return;
    const mats = [mesh.material].flat();
    if (mats.some((m) => m.transparent || m.alphaTest > 0 || !m.colorWrite)) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    parts.push({ geo: mesh.geometry, matrix: toRoot.clone().multiply(mesh.matrixWorld) });
    vertices += pos.count;
    indices += mesh.geometry.index ? mesh.geometry.index.count : pos.count;
    mesh.castShadow = false;
  });
  if (!parts.length) return null;
  const position = new Float32Array(vertices * 3);
  const index = new Uint32Array(indices);
  const v = new THREE.Vector3();
  let vo = 0;
  let io = 0;
  for (const { geo, matrix } of parts) {
    const pos = geo.getAttribute('position');
    const base = vo;
    for (let i = 0; i < pos.count; i++, vo++) v.fromBufferAttribute(pos, i).applyMatrix4(matrix).toArray(position, vo * 3);
    if (geo.index) for (let i = 0; i < geo.index.count; i++) index[io++] = base + geo.index.getX(i);
    else for (let i = 0; i < pos.count; i++) index[io++] = base + i;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeBoundingSphere();
  const proxy = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false, depthWrite: false }));
  proxy.name = 'shadow-proxy';
  proxy.castShadow = true;
  proxy.receiveShadow = false;
  proxy.matrixAutoUpdate = false;
  // Drawn only into the shadow map: the colour pass sees an empty draw range (the shadow pass calls
  // onBeforeShadow instead of onBeforeRender).
  proxy.onBeforeRender = () => geo.setDrawRange(0, 0);
  proxy.onAfterRender = () => geo.setDrawRange(0, Infinity);
  return proxy;
}

const corner = new THREE.Vector3();
const center = new THREE.Vector3();
const lightSpace = new THREE.Matrix4();
const lightSpaceInv = new THREE.Matrix4();

/**
 * Point the sun's shadow camera at what the view can see: the bounding sphere of the view frustum up to the
 * shadow distance, snapped to whole shadow texels so the shadows do not swim as the camera moves.
 */
export function fitSunShadow(light: THREE.DirectionalLight, camera: THREE.PerspectiveCamera) {
  const want = STAGE_SETTINGS.shadows;
  const cast = want !== 'off' && !!light.userData.castsShadows;
  if (light.castShadow !== cast) light.castShadow = cast;
  if (!cast) return;
  const q = SHADOW[want];
  if (light.shadow.mapSize.x !== q.size) {
    light.shadow.mapSize.set(q.size, q.size);
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }
  const dir = light.userData.direction as THREE.Vector3;
  // Bounding sphere of the frustum slice [near, distance].
  const far = Math.min(camera.far, q.distance);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const tanX = tanY * camera.aspect;
  const mid = (camera.near + far) / 2;
  const fx = far * tanX;
  const fy = far * tanY;
  const radius = Math.sqrt((far - mid) ** 2 + fx * fx + fy * fy);
  camera.getWorldDirection(center).multiplyScalar(mid).add(camera.getWorldPosition(corner));
  // Snap the centre in light space.
  lightSpace.lookAt(new THREE.Vector3(), dir, Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0));
  lightSpaceInv.copy(lightSpace).invert();
  const texel = (2 * radius) / q.size;
  center.applyMatrix4(lightSpaceInv);
  center.x = Math.round(center.x / texel) * texel;
  center.y = Math.round(center.y / texel) * texel;
  center.applyMatrix4(lightSpace);
  const back = radius + 80; // casters behind the view (walls, the skyline helpers) still throw their shadows in
  light.target.position.copy(center);
  light.position.copy(center).addScaledVector(dir, -back);
  light.target.updateMatrixWorld();
  light.updateMatrixWorld();
  const cam = light.shadow.camera;
  cam.left = -radius;
  cam.right = radius;
  cam.top = radius;
  cam.bottom = -radius;
  cam.near = 0.5;
  cam.far = back + radius;
  cam.updateProjectionMatrix();
}
