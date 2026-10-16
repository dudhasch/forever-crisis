import * as THREE from 'three';
import { curve, gradient } from './curves';
import type { SystemDef } from './types';

/**
 * Trail module (mode Particles): each particle drags a camera-facing ribbon through the points it passed. Points
 * live `trail.life` of the particle's lifetime; with "die with particles" off the ribbon fades out after the particle.
 * Ribbons are built on the CPU in three world space, one draw for all trails of a system.
 */

const POINTS = 24;
const MAX_TRAILS = 256;
const tmp = new THREE.Vector3();
const side = new THREE.Vector3();
const toCam = new THREE.Vector3();
const col = [0, 0, 0, 0];
const colU = [0, 0, 0, 0];

interface Ribbon {
  id: number;
  /** newest first: x, y, z, time */
  pts: Float32Array;
  n: number;
  /** seconds a point lives */
  life: number;
  width: number;
  color: number[];
  born: number;
  particleLife: number;
  dead: boolean;
}

export class Trails {
  readonly mesh: THREE.Mesh;
  private ribbons = new Map<number, Ribbon>();
  private geom = new THREE.BufferGeometry();
  private pos: Float32Array;
  private uv: Float32Array;
  private color: Float32Array;
  private rect: Float32Array;

  constructor(
    private def: NonNullable<SystemDef['trail']>,
    material: THREE.Material,
    private random: () => number,
  ) {
    const verts = MAX_TRAILS * POINTS * 2;
    this.pos = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.color = new Float32Array(verts * 4);
    this.rect = new Float32Array(verts * 4);
    const g = this.geom;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iColor', new THREE.BufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iUV', new THREE.BufferAttribute(this.rect, 4));
    // custom data stays 0 (unset attributes would read as (0, 0, 0, 1))
    g.setAttribute('iC1', new THREE.BufferAttribute(new Float32Array(verts * 4), 4));
    g.setAttribute('iC2', new THREE.BufferAttribute(new Float32Array(verts * 4), 4));
    for (let i = 0; i < verts; i++) this.rect.set([0, 0, 1, 1], i * 4);
    const idx: number[] = [];
    for (let r = 0; r < MAX_TRAILS; r++)
      for (let p = 0; p < POINTS - 1; p++) {
        const a = (r * POINTS + p) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
  }

  /** A new particle: maybe give it a ribbon (ratio), sized and coloured from the particle. */
  add(id: number, particleLife: number, size: number, color: number[], now: number) {
    if (this.ribbons.size >= MAX_TRAILS || (this.def.ratio < 1 && this.random() > this.def.ratio)) return;
    const life = Math.max(0.01, curve(this.def.life, 0, this.random()) * particleLife);
    this.ribbons.set(id, {
      id,
      pts: new Float32Array(POINTS * 4),
      n: 0,
      life,
      width: this.def.sizeWidth ? size : 1,
      color: this.def.inheritColor ? [...color] : [1, 1, 1, 1],
      born: now,
      particleLife,
      dead: false,
    });
  }

  /** The particle is at (x, y, z) (three world). */
  push(id: number, x: number, y: number, z: number, now: number) {
    const r = this.ribbons.get(id);
    if (!r || r.dead) return;
    const p = r.pts;
    if (r.n > 0 && Math.hypot(p[0] - x, p[1] - y, p[2] - z) < Math.max(0.005, this.def.minDist)) {
      // the head follows the particle; a new point only once it moved far enough
      if (r.n > 1) {
        p[0] = x;
        p[1] = y;
        p[2] = z;
      }
      return;
    }
    p.copyWithin(4, 0, (POINTS - 1) * 4);
    p[0] = x;
    p[1] = y;
    p[2] = z;
    p[3] = now;
    r.n = Math.min(POINTS, r.n + 1);
  }

  end(id: number) {
    const r = this.ribbons.get(id);
    if (!r) return;
    if (this.def.die) this.ribbons.delete(id);
    else r.dead = true;
  }

  get alive() {
    return this.ribbons.size;
  }

  /** Rebuild the ribbons facing the camera. */
  build(now: number, camera: THREE.Camera) {
    const cam = tmp.setFromMatrixPosition(camera.matrixWorld).clone();
    let v = 0;
    let slot = 0;
    for (const r of this.ribbons.values()) {
      // drop expired points (and ribbons whose particle is gone and whose points all expired)
      while (r.n > 0 && now - r.pts[(r.n - 1) * 4 + 3] > r.life) r.n--;
      if (r.n === 0 && r.dead) {
        this.ribbons.delete(r.id);
        continue;
      }
      if (r.n < 2) continue;
      const age = Math.min(1, (now - r.born) / Math.max(0.01, r.particleLife));
      gradient(this.def.color, age, 0.5, col);
      const base = slot * POINTS * 2;
      for (let i = 0; i < POINTS; i++) {
        const k = Math.min(i, r.n - 1);
        const o = k * 4;
        const u = r.n > 1 ? k / (r.n - 1) : 0;
        // direction along the ribbon, width across it facing the camera
        const a = Math.max(0, k - 1) * 4, b = Math.min(r.n - 1, k + 1) * 4;
        side.set(r.pts[a] - r.pts[b], r.pts[a + 1] - r.pts[b + 1], r.pts[a + 2] - r.pts[b + 2]);
        toCam.set(cam.x - r.pts[o], cam.y - r.pts[o + 1], cam.z - r.pts[o + 2]);
        side.cross(toCam);
        const len = side.length();
        if (len > 1e-6) side.multiplyScalar(1 / len);
        const w = curve(this.def.width, u, 0.5, 1) * r.width * 0.5 * (i < r.n ? 1 : 0);
        gradient(this.def.colorTrail, u, 0.5, colU);
        for (let s = 0; s < 2; s++) {
          const vi = base + i * 2 + s;
          const sg = s ? -w : w;
          this.pos[vi * 3] = r.pts[o] + side.x * sg;
          this.pos[vi * 3 + 1] = r.pts[o + 1] + side.y * sg;
          this.pos[vi * 3 + 2] = r.pts[o + 2] + side.z * sg;
          this.uv[vi * 2] = this.def.tex === 0 ? u : u * r.n * 0.25;
          this.uv[vi * 2 + 1] = s;
          for (let c = 0; c < 4; c++) this.color[vi * 4 + c] = col[c] * colU[c] * r.color[c];
        }
      }
      v = base + POINTS * 2;
      slot++;
      if (slot >= MAX_TRAILS) break;
    }
    const g = this.geom;
    g.setDrawRange(0, slot * (POINTS - 1) * 6);
    for (const name of ['position', 'uv', 'iColor'] as const) {
      const at = g.getAttribute(name) as THREE.BufferAttribute;
      at.needsUpdate = true;
      at.clearUpdateRanges();
      at.addUpdateRange(0, v * at.itemSize);
    }
  }

  dispose() {
    this.geom.dispose();
    this.mesh.removeFromParent();
  }
}
