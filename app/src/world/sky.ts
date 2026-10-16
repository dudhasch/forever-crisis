import * as THREE from 'three';
import { tryJSON } from '../assets';
import { assetUrl } from '../platform/source';

/** One entry of generated/sky/index.json (tools/extract_skyboxes.py). */
export interface SkyboxDef {
  /** Cube faces in Unity order: +X -X +Y -Y +Z -Z. */
  faces: string[];
  exposure: number;
  /** Degrees about +Y, as Unity's Skybox/Cubemap `_Rotation`. */
  rotation: number;
  /** sRGB tint; 0.5 grey is neutral. */
  tint: [number, number, number];
}

interface SkyIndex {
  skyboxes: Record<string, SkyboxDef>;
  maps: Record<string, string>;
}

let index: Promise<SkyIndex | null> | null = null;

export async function skyboxFor(mapKey: string): Promise<SkyboxDef | null> {
  index ??= tryJSON<SkyIndex>('/gen/sky/index.json');
  const i = await index;
  const name = i?.maps[mapKey];
  return name ? (i!.skyboxes[name] ?? null) : null;
}

const cubeLoader = new THREE.CubeTextureLoader();

/**
 * Unity's Skybox/Cubemap shader as a camera-centred cube: the colour is
 * texCUBE(dir) * tint * unity_ColorSpaceDouble * exposure, with dir rotated about Y.
 */
export async function createSky(def: SkyboxDef): Promise<THREE.Mesh> {
  const tex = await cubeLoader.loadAsync(def.faces.map(assetUrl));
  tex.colorSpace = THREE.SRGBColorSpace;
  // unity_ColorSpaceDouble in a linear-space project.
  const tint = new THREE.Color().setRGB(def.tint[0], def.tint[1], def.tint[2], THREE.SRGBColorSpace).multiplyScalar(4.59479380 * def.exposure);
  const rot = THREE.MathUtils.degToRad(def.rotation);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      cube: { value: tex },
      tint: { value: tint },
      rotCos: { value: Math.cos(rot) },
      rotSin: { value: Math.sin(rot) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww; // on the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform samplerCube cube;
      uniform vec3 tint;
      uniform float rotCos;
      uniform float rotSin;
      varying vec3 vDir;
      void main() {
        // glTF space mirrors Unity's X axis; sample in Unity space.
        vec3 d = vec3(-vDir.x, vDir.y, vDir.z);
        d.xz = vec2(rotCos * d.x - rotSin * d.z, rotSin * d.x + rotCos * d.z);
        gl_FragColor = vec4(textureCube(cube, d).rgb * tint, 1.0);
        #include <colorspace_fragment>
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  mesh.name = 'skybox';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
