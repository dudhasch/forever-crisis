import * as THREE from 'three';
import type { Capture } from '../world/capture';
import type { CollisionWorld } from '../world/collision';

export type CameraMode = 'ec' | 'orbit' | 'fps';
export const CAMERA_MODES: CameraMode[] = ['ec', 'orbit', 'fps'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  ec: 'Ever Crisis',
  orbit: 'Orbit',
  fps: 'First person',
};

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const DEG = Math.PI / 180;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'ec';
  /** Dungeon maps: the active pre-rendered view. Null on 3D environments. */
  capture: Capture | null = null;
  collision: CollisionWorld | null = null;

  // EC capture camera pan (relative to the capture's orientation)
  private capYaw = 0;
  private capPitch = 0;
  private snap = true;
  // EC fixed-angle follow on 3D environments
  envYaw = Math.PI;
  private envYawTarget = Math.PI;
  envPitch = 42 * DEG;
  envDistance = 9;
  // orbit
  orbitYaw = Math.PI;
  orbitPitch = 20 * DEG;
  orbitDistance = 5;
  // first person
  fpsYaw = 0;
  fpsPitch = 0;

  /** Set by the story director: where the camera looks and the lens FOV during cutscenes. */
  readonly script: { target: THREE.Vector3 | null; fov: number | null } = { target: null, fov: null };

  /** Settings → Controls. */
  sensitivity = 1;
  invertY = false;

  private dragging = false;
  private readonly dom: HTMLElement;
  private readonly target = new THREE.Vector3();

  constructor(dom: HTMLElement) {
    this.dom = dom;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
    dom.addEventListener('mousedown', (e) => {
      if (this.mode === 'fps') {
        if (document.pointerLockElement !== dom) dom.requestPointerLock?.();
        return;
      }
      if (e.button === 0 || e.button === 2) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    dom.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setMode(mode: CameraMode) {
    if (mode === this.mode) return;
    if (mode === 'fps') {
      this.fpsYaw = this.headingYaw();
      this.fpsPitch = 0;
    } else if (mode === 'orbit') {
      this.orbitYaw = this.headingYaw() + Math.PI;
    }
    if (this.mode === 'fps' && document.pointerLockElement === this.dom) document.exitPointerLock();
    this.mode = mode;
    this.snap = true;
  }

  setCapture(c: Capture | null) {
    if (c !== this.capture) this.snap = true;
    this.capture = c;
  }

  /** The lens FOV the current view uses when no script overrides it. */
  defaultLens() {
    const c = this.capture;
    return c ? (c.def.lensFov ?? Math.min(c.def.captureFov * 0.6, 30)) : 35;
  }

  /** Rotate the EC environment camera in 45 degree steps (Q/E). */
  rotateEnv(steps: number) {
    this.envYawTarget += (steps * Math.PI) / 4;
  }

  private onMouseMove(e: MouseEvent) {
    const mx = e.movementX * this.sensitivity;
    const my = e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
    if (this.mode === 'fps' && document.pointerLockElement === this.dom) {
      this.fpsYaw -= mx * 0.0025;
      this.fpsPitch = THREE.MathUtils.clamp(this.fpsPitch - my * 0.0025, -1.4, 1.4);
    } else if (this.mode === 'orbit' && this.dragging) {
      this.orbitYaw -= mx * 0.006;
      this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + my * 0.005, -1.2, 1.45);
    } else if (this.mode === 'ec' && !this.capture && this.dragging) {
      this.envYawTarget -= mx * 0.006;
      this.envPitch = THREE.MathUtils.clamp(this.envPitch + my * 0.004, 10 * DEG, 80 * DEG);
    }
  }

  private onWheel(e: WheelEvent) {
    const k = Math.exp(e.deltaY * 0.001);
    if (this.mode === 'orbit') this.orbitDistance = THREE.MathUtils.clamp(this.orbitDistance * k, 1.2, 60);
    if (this.mode === 'ec' && !this.capture) this.envDistance = THREE.MathUtils.clamp(this.envDistance * k, 3, 40);
    if (this.mode === 'ec' && this.capture) this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom / k, 1, 2.5);
  }

  /** Yaw (around +Y, 0 = looking down -Z) of the current view, for movement input. */
  headingYaw() {
    this.camera.getWorldDirection(tmpV);
    return Math.atan2(-tmpV.x, -tmpV.z);
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** `feet` = player position; `height` = character height. */
  update(dt: number, feet: THREE.Vector3, height: number) {
    const cam = this.camera;
    // Script-driven views are already eased by the director: follow them exactly.
    const k = this.snap || this.script.target ? 1 : 1 - Math.exp(-dt * 5);
    if (this.script.target) this.target.copy(this.script.target);
    else this.target.copy(feet).addScaledVector(Y, height * 0.6);
    if (this.mode === 'fps') {
      cam.fov = 70;
      cam.zoom = 1;
      cam.position.copy(feet).addScaledVector(Y, height * 0.92);
      cam.quaternion.setFromAxisAngle(Y, this.fpsYaw).multiply(tmpQ.setFromAxisAngle(X, this.fpsPitch));
    } else if (this.mode === 'orbit') {
      cam.fov = 50;
      cam.zoom = 1;
      const dir = new THREE.Vector3(
        Math.sin(this.orbitYaw) * Math.cos(this.orbitPitch),
        Math.sin(this.orbitPitch),
        Math.cos(this.orbitYaw) * Math.cos(this.orbitPitch),
      );
      let dist = this.orbitDistance;
      const hit = this.collision?.raycast(new THREE.Ray(this.target.clone(), dir.clone()), dist);
      if (hit) dist = Math.max(0.8, hit.distance - 0.25);
      cam.position.copy(this.target).addScaledVector(dir, dist);
      cam.lookAt(this.target);
    } else if (this.capture) {
      this.updateCapture(k);
    } else {
      cam.fov = this.script.fov ?? 35;
      this.envYaw += (this.envYawTarget - this.envYaw) * (1 - Math.exp(-dt * 8));
      const dir = new THREE.Vector3(
        Math.sin(this.envYaw) * Math.cos(this.envPitch),
        Math.sin(this.envPitch),
        Math.cos(this.envYaw) * Math.cos(this.envPitch),
      );
      const want = this.target.clone().addScaledVector(dir, this.envDistance);
      cam.position.lerp(want, this.snap ? 1 : 1 - Math.exp(-dt * 6));
      cam.lookAt(this.target);
    }
    this.snap = false;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  /** Pan inside the pre-rendered image like EC's Cinemachine camera, never showing its borders. */
  private updateCapture(k: number) {
    const c = this.capture!;
    const cam = this.camera;
    cam.position.copy(c.position);
    // Field of view: the game's lens, shrunk if the window is wider than the capture.
    const lens = this.script.fov ?? this.defaultLens();
    let tanV = Math.tan((lens * DEG) / 2) / cam.zoom;
    tanV = Math.min(tanV, (c.tanHalfH / cam.aspect) * 0.98, c.tanHalfV * 0.98);
    cam.fov = (2 * Math.atan(tanV * cam.zoom)) / DEG;

    // Desired look direction in capture space.
    const inv = tmpQ.copy(c.quaternion).invert();
    const d = tmpV.copy(this.target).sub(c.position).applyQuaternion(inv).normalize();
    let yaw = Math.atan2(-d.x, -d.z);
    let pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    const maxH = (c.def.maxHorizontalAngle / 2) * DEG;
    const maxV = (c.def.maxVerticalAngle / 2) * DEG;
    yaw = THREE.MathUtils.clamp(yaw, -maxH, maxH);
    pitch = THREE.MathUtils.clamp(pitch, -maxV, maxV);
    const tanH = tanV * cam.aspect;
    const fits = (y: number, p: number) => {
      const q = tmpQ2.setFromAxisAngle(Y, y).multiply(new THREE.Quaternion().setFromAxisAngle(X, p));
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const v = new THREE.Vector3(sx * tanH, sy * tanV, -1).applyQuaternion(q);
          if (!c.containsDir(v)) return false;
        }
      return true;
    };
    // Largest fraction of the wanted pan that keeps all four view corners inside the capture.
    const maxScale = (test: (s: number) => boolean) => {
      if (test(1)) return 1;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (test(mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    // Move toward the target on both axes together (so a maxed-out yaw can't block all pitch),
    // then use whatever room is left on each axis.
    const s = maxScale((t) => fits(yaw * t, pitch * t));
    const y0 = yaw * s;
    const p0 = pitch * s;
    const y1 = y0 + (yaw - y0) * maxScale((t) => fits(y0 + (yaw - y0) * t, p0));
    pitch = p0 + (pitch - p0) * maxScale((t) => fits(y1, p0 + (pitch - p0) * t));
    yaw = y1;
    this.capYaw += (yaw - this.capYaw) * k;
    this.capPitch += (pitch - this.capPitch) * k;
    cam.quaternion
      .copy(c.quaternion)
      .multiply(tmpQ.setFromAxisAngle(Y, this.capYaw))
      .multiply(tmpQ2.setFromAxisAngle(X, this.capPitch));
  }
}
