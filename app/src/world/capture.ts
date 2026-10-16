import * as THREE from 'three';
import type { CaptureCamera } from '../types';
import { loadTexture } from '../assets';

/**
 * A pre-rendered background view of a dungeon map.
 *
 * Reverse-engineered format (see tools/extract_dungeon_maps.py):
 *  - color: perspective render (2:1, a few are square), vertical FOV = captureFov, from the camera_XX transform
 *  - depthA/depthB: red channel high/low byte of linear view depth. The game's PlaneEnvironment shader
 *    decodes (A + B/256) * 255/256 * far, i.e. metres = (A*256+B)/65536 * far, with far the camera's far plane
 * Unity cameras look down +Z; after the x-mirror into glTF space a three.js camera needs a
 * 180 degree turn about Y to look the same way.
 */
export const CAPTURE_ASPECT = 2;
export const DEPTH_FAR = 1000;

export class Capture {
  readonly def: CaptureCamera;
  readonly position = new THREE.Vector3();
  /** World rotation of an equivalent three.js camera (looks down -Z). */
  readonly quaternion = new THREE.Quaternion();
  readonly matrixWorld = new THREE.Matrix4();
  readonly viewMatrix = new THREE.Matrix4();
  readonly tanHalfV: number;
  readonly tanHalfH: number;
  /** Far plane the depth images are encoded against. */
  readonly far: number;
  color?: THREE.Texture;
  depthA?: THREE.Texture;
  depthB?: THREE.Texture;

  constructor(def: CaptureCamera) {
    this.def = def;
    this.position.fromArray(def.position);
    this.quaternion
      .fromArray(def.quaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    this.matrixWorld.compose(this.position, this.quaternion, new THREE.Vector3(1, 1, 1));
    this.viewMatrix.copy(this.matrixWorld).invert();
    this.tanHalfV = Math.tan(THREE.MathUtils.degToRad(def.captureFov) / 2);
    this.tanHalfH = this.tanHalfV * (def.aspect ?? CAPTURE_ASPECT);
    this.far = def.far || DEPTH_FAR;
  }

  get isEvent() {
    return this.def.name.startsWith('ev');
  }

  get ready() {
    return !!(this.color && this.depthA && this.depthB);
  }

  async load() {
    if (this.ready) return;
    const { color, depthA, depthB } = this.def;
    if (!color || !depthA || !depthB) throw new Error(`capture ${this.def.name} has no textures`);
    [this.color, this.depthA, this.depthB] = await Promise.all([
      loadTexture(color, 'color'),
      loadTexture(depthA, 'data'),
      loadTexture(depthB, 'data'),
    ]);
  }

  /** Is a direction given in this capture's camera space inside its image? */
  containsDir(d: THREE.Vector3, margin = 0) {
    if (d.z >= 0) return false;
    const x = d.x / -d.z / this.tanHalfH;
    const y = d.y / -d.z / this.tanHalfV;
    return Math.abs(x) <= 1 - margin && Math.abs(y) <= 1 - margin;
  }
}

/** Mirrors the shipped PlaneEnvironment pixel shader: (A + B/256) * 255/256 * far. */
const DEPTH_GLSL = /* glsl */ `
  uniform float depthFar;
  float decodeDepth(vec2 uv) {
    float a = texture2D(depthA, uv).r;
    float b = texture2D(depthB, uv).r;
    return (a + b * 0.00390625) * 0.99609375 * depthFar;
  }
  bool isSky(float z) { return z > depthFar * 0.99; }
`;

/**
 * Full-screen pass that draws the active capture through the live camera and writes per-pixel
 * depth, so 3D characters are correctly hidden behind pre-rendered railings, pillars, etc.
 */
export class BackgroundPass {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        colorTex: { value: null },
        depthA: { value: null },
        depthB: { value: null },
        captureView: { value: new THREE.Matrix4() },
        captureWorld: { value: new THREE.Matrix4() },
        captureTan: { value: new THREE.Vector2(1, 1) },
        camWorld: { value: new THREE.Matrix4() },
        camTan: { value: new THREE.Vector2(1, 1) },
        camViewProj: { value: new THREE.Matrix4() },
        depthFar: { value: DEPTH_FAR },
        fade: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vNdc;
        void main() {
          vNdc = position.xy;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D colorTex;
        uniform sampler2D depthA;
        uniform sampler2D depthB;
        uniform mat4 captureView;
        uniform mat4 captureWorld;
        uniform vec2 captureTan;
        uniform mat4 camWorld;
        uniform vec2 camTan;
        uniform mat4 camViewProj;
        uniform float fade;
        varying vec2 vNdc;
        ${DEPTH_GLSL}
        void main() {
          vec3 dirView = vec3(vNdc * camTan, -1.0);
          vec3 dirWorld = mat3(camWorld) * dirView;
          vec3 dirCap = mat3(captureView) * dirWorld;
          if (dirCap.z >= -1e-4) discard;
          vec2 ndc = dirCap.xy / -dirCap.z / captureTan;
          if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) {
            gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
            gl_FragDepth = 0.99999;
            return;
          }
          vec2 uv = ndc * 0.5 + 0.5;
          float z = decodeDepth(uv);
          vec3 pCap = dirCap * (z / -dirCap.z);
          vec4 clip = camViewProj * (captureWorld * vec4(pCap, 1.0));
          float depth = clip.z / clip.w * 0.5 + 0.5;
          gl_FragDepth = isSky(z) ? 0.99999 : clamp(depth, 0.0, 0.99999);
          gl_FragColor = vec4(texture2D(colorTex, uv).rgb * fade, 1.0);
          #include <colorspace_fragment>
        }
      `,
      // GL skips depth writes entirely when the depth test is off, so test with ALWAYS instead.
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'background-pass';
  }

  setCapture(c: Capture) {
    const u = this.material.uniforms;
    u.colorTex.value = c.color;
    u.depthA.value = c.depthA;
    u.depthB.value = c.depthB;
    u.captureView.value.copy(c.viewMatrix);
    u.captureWorld.value.copy(c.matrixWorld);
    u.captureTan.value.set(c.tanHalfH, c.tanHalfV);
    u.depthFar.value = c.far;
  }

  /** Call every frame after the camera moved. */
  update(camera: THREE.PerspectiveCamera) {
    const u = this.material.uniforms;
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom;
    u.camTan.value.set(tv * camera.aspect, tv);
    u.camWorld.value.copy(camera.matrixWorld);
    u.camViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }
}

/**
 * Re-projects a capture into a displaced grid so the background can be seen from any angle
 * (orbit / first-person modes). Steep depth discontinuities are cut to avoid rubber sheets.
 */
export function createDepthMesh(c: Capture, segmentsX = 320, segmentsY = Math.round(320 / (c.def.aspect ?? CAPTURE_ASPECT))): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(2, 2, segmentsX, segmentsY);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      colorTex: { value: c.color },
      depthA: { value: c.depthA },
      depthB: { value: c.depthB },
      captureTan: { value: new THREE.Vector2(c.tanHalfH, c.tanHalfV) },
      depthFar: { value: c.far },
      texel: { value: new THREE.Vector2(1 / segmentsX, 1 / segmentsY) },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D depthA;
      uniform sampler2D depthB;
      uniform vec2 captureTan;
      uniform vec2 texel;
      varying vec2 vUv;
      varying float vCut;
      ${DEPTH_GLSL}
      void main() {
        vUv = uv;
        float z = decodeDepth(uv);
        float zx = decodeDepth(uv + vec2(texel.x, 0.0));
        float zy = decodeDepth(uv + vec2(0.0, texel.y));
        float zx2 = decodeDepth(uv - vec2(texel.x, 0.0));
        float zy2 = decodeDepth(uv - vec2(0.0, texel.y));
        // 1/z is linear across any plane in screen space, so a large second difference of 1/z
        // marks a real silhouette edge, while floors seen at grazing angles stay connected.
        float w = 1.0 / z;
        float ddx = abs(1.0 / zx + 1.0 / zx2 - 2.0 * w);
        float ddy = abs(1.0 / zy + 1.0 / zy2 - 2.0 * w);
        vCut = (isSky(z) || max(ddx, ddy) > 0.035 * w) ? 1.0 : 0.0;
        vec3 dir = vec3(position.xy * captureTan, -1.0);
        vec3 p = dir * z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D colorTex;
      varying vec2 vUv;
      varying float vCut;
      void main() {
        if (vCut > 0.01) discard;
        gl_FragColor = vec4(texture2D(colorTex, vUv).rgb, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(c.matrixWorld);
  mesh.frustumCulled = false;
  mesh.name = `depth-mesh-${c.def.name}`;
  return mesh;
}
