import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Layout } from '../types';

export const CAPSULE_RADIUS = 0.28;
export const CAPSULE_HEIGHT = 1.6;

/** Static collision world for one map, built from extracted colliders (or render meshes as fallback). */
export class CollisionWorld {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  readonly bounds = new THREE.Box3();
  readonly debug: THREE.Group;
  readonly source: 'colliders' | 'render-meshes';

  constructor(geometry: THREE.BufferGeometry, source: CollisionWorld['source']) {
    this.geometry = geometry;
    this.source = source;
    this.bvh = new MeshBVH(geometry);
    geometry.computeBoundingBox();
    this.bounds.copy(geometry.boundingBox!);
    this.debug = new THREE.Group();
    this.debug.name = 'collision-debug';
    this.debug.visible = false;
    const wire = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0xff4060, wireframe: true, transparent: true, opacity: 0.45, depthTest: false }),
    );
    wire.renderOrder = 999;
    this.debug.add(wire);
  }

  static fromLayout(layout: Layout): CollisionWorld | null {
    // Shadow_only boxes are huge off-stage shadow casters, not walkable geometry.
    const parts = layout.collision.filter((c) => c.indices.length >= 3 && !/shadow/i.test(c.name));
    if (!parts.length) return null;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const c of parts) {
      const base = positions.length / 3;
      for (const v of c.positions) positions.push(v);
      for (const i of c.indices) indices.push(i + base);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    return new CollisionWorld(g, 'colliders');
  }

  static fromObject(root: THREE.Object3D): CollisionWorld | null {
    root.updateMatrixWorld(true);
    const positions: number[] = [];
    const v = new THREE.Vector3();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.visible) return;
      const pos = m.geometry.getAttribute('position');
      if (!pos) return;
      const idx = m.geometry.getIndex();
      const count = idx ? idx.count : pos.count;
      for (let i = 0; i < count; i++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
        positions.push(v.x, v.y, v.z);
      }
    });
    if (positions.length < 9) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return new CollisionWorld(g, 'render-meshes');
  }

  /** First hit straight down from `from` within `maxDist`. */
  groundBelow(from: THREE.Vector3, maxDist = 50): THREE.Vector3 | null {
    const ray = new THREE.Ray(from.clone(), new THREE.Vector3(0, -1, 0));
    const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit || hit.distance > maxDist) return null;
    return hit.point.clone();
  }

  raycast(ray: THREE.Ray, far = Infinity) {
    const hit = this.bvh.raycastFirst(ray, THREE.DoubleSide);
    return hit && hit.distance <= far ? hit : null;
  }
}

const tmpBox = new THREE.Box3();
const tmpSeg = new THREE.Line3();
const triPoint = new THREE.Vector3();
const capPoint = new THREE.Vector3();
const delta = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Capsule walker in the style of three-mesh-bvh's character-movement example. */
export class CharacterController {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  grounded = false;
  noclip = false;
  gravity = -24;

  constructor(public world: CollisionWorld | null) {}

  teleport(p: THREE.Vector3) {
    this.position.copy(p);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }

  /** Move by a desired horizontal displacement; `vertical` is only used in noclip. */
  step(move: THREE.Vector3, dt: number, vertical = 0) {
    if (this.noclip || !this.world) {
      this.position.add(move);
      this.position.y += vertical;
      this.velocity.set(0, 0, 0);
      this.grounded = false;
      return;
    }
    const world = this.world;
    const wasGrounded = this.grounded;
    this.velocity.y += this.gravity * dt;
    this.velocity.y = Math.max(this.velocity.y, -30);
    this.position.add(move);
    this.position.y += this.velocity.y * dt;

    const r = CAPSULE_RADIUS;
    tmpSeg.start.copy(this.position).addScaledVector(UP, r);
    tmpSeg.end.copy(this.position).addScaledVector(UP, CAPSULE_HEIGHT - r);
    // Several relaxation passes keep us out of thin wall boxes and corners.
    for (let pass = 0; pass < 3; pass++) {
      tmpBox.makeEmpty().expandByPoint(tmpSeg.start).expandByPoint(tmpSeg.end);
      tmpBox.min.addScalar(-r);
      tmpBox.max.addScalar(r);
      let pushed = false;
      world.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(tmpBox),
        intersectsTriangle: (tri) => {
          const dist = tri.closestPointToSegment(tmpSeg, triPoint, capPoint);
          if (dist < r) {
            const depth = r - dist;
            const dir = capPoint.sub(triPoint).normalize();
            if (dir.lengthSq() === 0) return;
            tmpSeg.start.addScaledVector(dir, depth);
            tmpSeg.end.addScaledVector(dir, depth);
            pushed = true;
          }
        },
      });
      if (!pushed) break;
    }
    const newPos = delta.copy(tmpSeg.start).addScaledVector(UP, -r);
    const d = newPos.clone().sub(this.position);
    this.grounded = d.y > Math.abs(dt * this.velocity.y * 0.25);
    this.position.copy(newPos);

    // Stick to stairs / slopes when walking down instead of hopping off each step.
    if (!this.grounded && wasGrounded && this.velocity.y <= 0) {
      const g = world.groundBelow(this.position.clone().addScaledVector(UP, 0.3), 0.75);
      if (g) {
        this.position.y = g.y;
        this.grounded = true;
      }
    }
    if (this.grounded) this.velocity.y = 0;
  }
}
