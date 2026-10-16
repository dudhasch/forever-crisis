import * as THREE from 'three';
import { curve, curveMax, gradient, rng } from './curves';
import { Trails } from './trail';
import type { Curve, MeshData, SystemDef } from './types';

/**
 * CPU simulation of one Unity ParticleSystem (Shuriken) with the modules EC uses, drawn as one instanced mesh.
 * Positions live in Unity space: the system's local space (simulation space Local) or Unity world (World),
 * where Unity world = mirrorX * three world.
 */

const CAP = 1500;
const STRIDE = 32;
// particle record layout (Float32Array, STRIDE floats each)
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, SEED = 8, SX = 9, SY = 10, SZ = 11,
  RX = 12, RY = 13, RZ = 14, CR = 15, CG = 16, CB = 17, CA = 18, GRAV = 19, FRAME = 20, ROW = 21, ID = 22, SPIN = 23,
  AVX = 24, AVY = 25, AVZ = 26, R2 = 27, R3 = 28, R4 = 29;

const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const DEG = Math.PI / 180;
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpN = new THREE.Matrix3();
const col4 = [0, 0, 0, 0];
const col4b = [0, 0, 0, 0];

/** Where a sub emitter emits from (a parent particle, or the spot where one died). */
interface SubContext {
  id: number;
  x: number;
  y: number;
  z: number;
  t: number;
  acc: number;
  fired: number[];
  alive: boolean;
  /** inherited colour / size factor */
  color?: number[];
  size?: number;
  follow: boolean;
}

function eulerQuat(d: number[] | undefined, out: THREE.Quaternion) {
  if (!d) return out.identity();
  // Unity Quaternion.Euler: Z, then X, then Y (three order 'YXZ'); stays in Unity space
  tmpE.set(d[0] * DEG, d[1] * DEG, d[2] * DEG, 'YXZ');
  return out.setFromEuler(tmpE);
}

function hash3(x: number, y: number, z: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise in -1..1. */
function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let v = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    const w = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    v += w * hash3(ix + dx, iy + dy, iz + dz);
  }
  return v * 2 - 1;
}

export interface SimFrame {
  /** system local (Unity) -> Unity world */
  l2w: THREE.Matrix4;
  /** Unity world -> system local */
  w2l: THREE.Matrix4;
  /** three world matrix of the system node (local-space systems render with it) */
  nodeWorld: THREE.Matrix4;
  /** uniform scale of the node (hierarchy scaling) */
  scale: number;
}

export class ParticleSim {
  readonly def: SystemDef;
  readonly mesh: THREE.Mesh | null = null;
  private data: Float32Array;
  private count = 0;
  private cap: number;
  private time = 0;
  private delay: number;
  private emitAcc = 0;
  /** rate-over-time accumulator of the system's own timeline */
  acc = 0;
  private fired: number[] = [];
  private loops = 0;
  private emitting = true;
  private started = false;
  private nextId = 1;
  private random: () => number;
  private lastPos = new THREE.Vector3();
  private hasLast = false;
  private shapeQ = new THREE.Quaternion();
  private hasShapeRot = false;
  private meshShape: MeshData | null;
  /** sub emitter contexts (when this system is someone's sub emitter) */
  private contexts: SubContext[] = [];
  /** [sim, type, props, prob] of this system's sub emitters */
  subs: { sim: ParticleSim; type: number; props: number; prob: number }[] = [];
  private attrs: Record<string, THREE.InstancedBufferAttribute> = {};
  private geom: THREE.InstancedBufferGeometry | null = null;
  frame: SimFrame | null = null;
  /** set false to stop emitting (looping effects that end) */
  playing = true;
  /** Trail module ribbons (own draw), when the system has a trail material. */
  readonly trails: Trails | null = null;

  constructor(
    def: SystemDef,
    material: THREE.Material | null,
    renderGeometry: THREE.BufferGeometry | null,
    shapeMesh: MeshData | null,
    seed: number,
    trailMaterial: THREE.Material | null = null,
  ) {
    this.def = def;
    this.cap = Math.max(1, Math.min(CAP, def.max || CAP));
    this.data = new Float32Array(this.cap * STRIDE);
    this.random = rng(seed);
    this.delay = curve(def.delay, 0, this.random());
    this.meshShape = shapeMesh;
    if (def.shape?.rot) {
      eulerQuat(def.shape.rot, this.shapeQ);
      this.hasShapeRot = true;
    }
    if (def.trail && trailMaterial) {
      this.trails = new Trails(def.trail, trailMaterial, this.random);
      const queue = (trailMaterial.userData.queue as number | undefined) ?? 3000;
      this.trails.mesh.renderOrder = 100 + (queue - 3000) * 0.01 - (def.r.fudge ?? 0) * 0.0001;
    }
    if (material && renderGeometry) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = renderGeometry.index;
      for (const [k, a] of Object.entries(renderGeometry.attributes)) g.setAttribute(k, a);
      const add = (name: string, size: number) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * size), size);
        a.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute(name, a);
        this.attrs[name] = a;
      };
      add('iPos', 3);
      add('iSize', 3);
      add('iRot', 4);
      add('iColor', 4);
      add('iUV', 4);
      add('iVel', 3);
      add('iC1', 4);
      add('iC2', 4);
      g.instanceCount = 0;
      this.geom = g;
      const mesh = new THREE.Mesh(g, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      const queue = (material.userData.queue as number | undefined) ?? 3000;
      mesh.renderOrder = 100 + (queue - 3000) * 0.01 - (def.r.fudge ?? 0) * 0.0001 + (def.r.order ?? 0) * 0.001;
      this.mesh = mesh;
    }
  }

  get alive() {
    return this.count;
  }

  /** Finished: past its duration (or stopped), no particles left, no sub contexts. */
  get done() {
    if (this.trails?.alive) return false;
    if (this.def.isSub) return this.count === 0 && !this.contexts.some((c) => c.alive);
    if (this.count > 0) return false;
    if (!this.started) return !this.playing;
    return !this.emitting;
  }

  /** Simulate ahead (prewarm of looping ambience). */
  prewarm(frame: SimFrame) {
    const d = Math.max(0.5, Math.min(this.def.dur, 10));
    const steps = Math.ceil(d * 15);
    for (let i = 0; i < steps; i++) this.update(d / steps, frame, null);
  }

  // ------------------------------------------------------------------------------------------- emission
  addContext(id: number, x: number, y: number, z: number, follow: boolean, color?: number[], size?: number) {
    this.contexts.push({ id, x, y, z, t: 0, acc: 0, fired: [], alive: true, follow, color, size });
  }

  moveContext(id: number, x: number, y: number, z: number) {
    for (const c of this.contexts) if (c.id === id && c.follow) {
      c.x = x;
      c.y = y;
      c.z = z;
    }
  }

  endContext(id: number) {
    for (const c of this.contexts) if (c.id === id && c.follow) c.alive = false;
  }

  /** Emission over [t0, t1) of one emitter timeline (the system itself or a sub context). */
  private emissionCount(_t0: number, t1: number, dt: number, accRef: { acc: number }, fired: number[]) {
    const def = this.def;
    const dur = Math.max(0.0001, def.dur);
    let n = 0;
    const rate = def.emit.rate;
    if (rate !== undefined) {
      const r = curve(rate, (t1 % dur) / dur, this.random());
      accRef.acc += r * dt;
      const k = Math.floor(accRef.acc);
      accRef.acc -= k;
      n += k;
    }
    for (let bi = 0; bi < (def.emit.bursts?.length ?? 0); bi++) {
      const [bt, count, cycles, interval, prob] = def.emit.bursts![bi];
      const done = fired[bi] ?? 0;
      const maxCycles = cycles > 0 ? cycles : Infinity;
      let c = done;
      while (c < maxCycles) {
        const at = bt + c * Math.max(0.01, interval);
        if (at >= t1 || at > dur + 1e-4) break;
        if (prob >= 1 || this.random() < prob) n += Math.round(curve(count, 0, this.random()));
        c++;
      }
      fired[bi] = c;
    }
    return n;
  }

  update(dt: number, frame: SimFrame, camera: THREE.Camera | null) {
    this.frame = frame;
    const def = this.def;
    dt *= def.simSpeed ?? 1;
    if (!def.isSub) {
      const before = this.time;
      this.time += dt;
      const t = this.time - this.delay;
      if (t >= 0 && this.playing && this.emitting) {
        this.started = true;
        const dur = Math.max(0.0001, def.dur);
        let t0 = Math.max(0, before - this.delay);
        let t1 = t;
        if (def.loop) {
          // wrap per cycle so bursts repeat
          while (t1 - this.loops * dur >= dur) {
            const end = (this.loops + 1) * dur;
            const n = this.emissionCount(t0 - this.loops * dur, dur, end - t0, this, this.fired);
            this.spawnBatch(n, frame, null, (end - this.loops * dur) / dur);
            this.loops++;
            this.fired = [];
            t0 = end;
          }
          const n = this.emissionCount(t0 - this.loops * dur, t1 - this.loops * dur, t1 - t0, this, this.fired);
          this.spawnBatch(n, frame, null, (t1 - this.loops * dur) / dur);
        } else {
          t1 = Math.min(t1, dur);
          if (t1 > t0 || before - this.delay < 0) {
            const n = this.emissionCount(t0, t1 + (t >= dur ? 1e-4 : 0), Math.max(0, t1 - t0), this, this.fired);
            this.spawnBatch(n, frame, null, t1 / dur);
          }
          if (t >= dur) this.emitting = false;
        }
        // rate over distance
        if (def.emit.dist !== undefined) {
          tmpV.setFromMatrixPosition(frame.l2w);
          if (this.hasLast) {
            const d = tmpV.distanceTo(this.lastPos);
            this.emitAcc += d * curve(def.emit.dist, (t % dur) / dur, this.random());
            const k = Math.floor(this.emitAcc);
            this.emitAcc -= k;
            this.spawnBatch(k, frame, null, (t % dur) / dur);
          }
          this.lastPos.copy(tmpV);
          this.hasLast = true;
        }
      } else if (!this.playing) this.emitting = false;
    } else {
      for (const c of this.contexts) {
        if (!c.alive) continue;
        const before = c.t;
        c.t += dt;
        if (c.t > def.dur && !def.loop) {
          c.alive = false;
        }
        const n = this.emissionCount(before, Math.min(c.t, def.dur + 1e-4), dt, c, c.fired);
        this.spawnBatch(n, frame, c, Math.min(1, c.t / Math.max(0.0001, def.dur)));
      }
      this.contexts = this.contexts.filter((c) => c.alive);
    }
    this.simulate(dt, frame);
    if (camera) {
      this.write(frame);
      if (this.trails) this.writeTrails(frame, camera);
    }
  }

  // ------------------------------------------------------------------------------------------- spawning
  private spawnBatch(n: number, frame: SimFrame, ctx: SubContext | null, ts: number) {
    for (let i = 0; i < n && this.count < this.cap; i++) this.spawn(frame, ctx, Math.min(1, Math.max(0, ts)));
  }

  /** Shape module: position and direction in system-local Unity space. */
  private shapeSample(pos: THREE.Vector3, dir: THREE.Vector3) {
    const s = this.def.shape;
    const R = this.random;
    pos.set(0, 0, 0);
    dir.set(0, 0, 1);
    if (!s) return;
    const radius = s.radius;
    const thick = s.thick ?? 1;
    const arc = (s.arc ?? 360) * DEG;
    const shellR = (r: number) => r * (1 - thick + thick * Math.cbrt(R()));
    const discR = (r: number) => r * (1 - thick + thick * Math.sqrt(R()));
    switch (s.type) {
      case 0: // sphere
      case 1: {
        const u = R() * 2 - 1, th = R() * Math.PI * 2, q = Math.sqrt(1 - u * u);
        dir.set(q * Math.cos(th), u, q * Math.sin(th));
        pos.copy(dir).multiplyScalar(s.type === 1 ? radius : shellR(radius));
        break;
      }
      case 2: // hemisphere (+z)
      case 3: {
        const u = R(), th = R() * Math.PI * 2, q = Math.sqrt(1 - u * u);
        dir.set(q * Math.cos(th), q * Math.sin(th), u);
        pos.copy(dir).multiplyScalar(s.type === 3 ? radius : shellR(radius));
        break;
      }
      case 4: // cone (base), 7 cone shell, 8 cone volume, 9 cone volume shell
      case 7:
      case 8:
      case 9: {
        const ang = Math.min(89.9, s.angle ?? 25) * DEG;
        const th = this.arcAngle(arc);
        const rr = s.type === 7 || s.type === 9 ? radius : discR(radius);
        const k = radius > 0 ? rr / radius : 0;
        const cx = Math.cos(th), cy = Math.sin(th);
        pos.set(cx * rr, cy * rr, 0);
        dir.set(cx * Math.sin(ang * k), cy * Math.sin(ang * k), Math.cos(ang * k)).normalize();
        if (s.type === 8 || s.type === 9) {
          const l = (s.length ?? 5) * R();
          pos.addScaledVector(dir, l);
        }
        break;
      }
      case 5: // box volume, 15 shell, 16 edge
      case 15:
      case 16: {
        pos.set(R() - 0.5, R() - 0.5, R() - 0.5);
        if (s.type !== 5) {
          const ax = Math.floor(R() * 3);
          pos.setComponent(ax, R() < 0.5 ? -0.5 : 0.5);
          if (s.type === 16) {
            const ax2 = (ax + 1 + Math.floor(R() * 2)) % 3;
            pos.setComponent(ax2, R() < 0.5 ? -0.5 : 0.5);
          }
        }
        dir.set(0, 0, 1);
        break;
      }
      case 10: // circle, 11 edge
      case 11: {
        const th = this.arcAngle(arc);
        const rr = s.type === 11 ? radius : discR(radius);
        dir.set(Math.cos(th), Math.sin(th), 0);
        pos.copy(dir).multiplyScalar(rr);
        break;
      }
      case 12: { // single sided edge along x
        const x = (this.arcFraction() * 2 - 1) * radius;
        pos.set(x, 0, 0);
        dir.set(0, 1, 0);
        break;
      }
      case 17: { // donut
        const th = this.arcAngle(arc);
        const ph = R() * Math.PI * 2;
        const dr = (s.donut ?? 0.2) * (1 - thick + thick * Math.sqrt(R()));
        const cx = Math.cos(th), cy = Math.sin(th);
        dir.set(cx * Math.cos(ph), cy * Math.cos(ph), Math.sin(ph));
        pos.set(cx * radius, cy * radius, 0).addScaledVector(dir, dr);
        break;
      }
      case 18: // rectangle
        pos.set(R() - 0.5, R() - 0.5, 0);
        dir.set(0, 0, 1);
        break;
      case 6: case 13: case 14: { // mesh
        const m = this.meshShape;
        if (m && m.p.length >= 3) {
          const vi = Math.floor(R() * (m.p.length / 3));
          pos.set(m.p[vi * 3], m.p[vi * 3 + 1], m.p[vi * 3 + 2]);
          if (m.n) dir.set(m.n[vi * 3], m.n[vi * 3 + 1], m.n[vi * 3 + 2]);
        }
        break;
      }
      default:
        break;
    }
    if (s.scale) {
      pos.x *= s.scale[0];
      pos.y *= s.scale[1];
      pos.z *= s.scale[2];
    }
    if (s.randPos) pos.add(tmpV2.set(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(2 * s.randPos));
    if (this.hasShapeRot) {
      pos.applyQuaternion(this.shapeQ);
      dir.applyQuaternion(this.shapeQ);
    }
    if (s.pos) pos.add(tmpV2.set(s.pos[0], s.pos[1], s.pos[2]));
    if (s.randDir) {
      const u = R() * 2 - 1, th = R() * Math.PI * 2, q = Math.sqrt(1 - u * u);
      dir.lerp(tmpV2.set(q * Math.cos(th), u, q * Math.sin(th)), s.randDir).normalize();
    }
    if (s.sphDir && pos.lengthSq() > 1e-9) dir.lerp(tmpV2.copy(pos).normalize(), s.sphDir).normalize();
  }

  private arcCounter = 0;
  private arcFraction() {
    const s = this.def.shape!;
    const mode = s.arcMode?.[0] ?? 0;
    if (mode === 0) return this.random();
    // loop / ping-pong / burst spread: walk around the arc
    this.arcCounter += 1;
    const spd = curve(s.arcMode?.[2], 0, 0.5, 1);
    const f = (this.arcCounter * 0.1 * spd) % 1;
    return mode === 2 ? 1 - Math.abs(f * 2 - 1) : f;
  }

  private arcAngle(arc: number) {
    return this.arcFraction() * arc;
  }

  private spawn(frame: SimFrame, ctx: SubContext | null, ts: number) {
    const def = this.def;
    const R = this.random;
    const o = this.count * STRIDE;
    const d = this.data;
    const pos = tmpV.set(0, 0, 0);
    const dir = new THREE.Vector3();
    this.shapeSample(pos, dir);
    const speed = curve(def.speed, ts, R());
    let vx = dir.x * speed, vy = dir.y * speed, vz = dir.z * speed;
    let px = pos.x, py = pos.y, pz = pos.z;
    let scale = 1;
    if (def.space === 1) {
      // world simulation: bake the emitter transform in
      tmpV2.set(px, py, pz).applyMatrix4(frame.l2w);
      const dv = new THREE.Vector3(vx, vy, vz).transformDirection(frame.l2w).multiplyScalar(Math.hypot(vx, vy, vz));
      px = tmpV2.x;
      py = tmpV2.y;
      pz = tmpV2.z;
      vx = dv.x;
      vy = dv.y;
      vz = dv.z;
      scale = frame.scale;
      if (ctx) {
        // sub emitter: shape offset rotated with the system, placed at the context
        tmpV2.set(pos.x, pos.y, pos.z).transformDirection(frame.l2w).multiplyScalar(pos.length() * frame.scale);
        px = ctx.x + tmpV2.x;
        py = ctx.y + tmpV2.y;
        pz = ctx.z + tmpV2.z;
      }
    } else if (ctx) {
      px += ctx.x;
      py += ctx.y;
      pz += ctx.z;
    }
    d[o + PX] = px;
    d[o + PY] = py;
    d[o + PZ] = pz;
    d[o + VX] = vx;
    d[o + VY] = vy;
    d[o + VZ] = vz;
    d[o + AVX] = d[o + AVY] = d[o + AVZ] = 0;
    d[o + AGE] = 0;
    let life = Math.max(0.0001, curve(def.life, ts, R()));
    d[o + SEED] = R();
    d[o + R2] = R();
    d[o + R3] = R();
    d[o + R4] = R();
    if (def.size3) {
      const r = R();
      d[o + SX] = curve(def.size3[0], ts, r) * scale;
      d[o + SY] = curve(def.size3[1], ts, r) * scale;
      d[o + SZ] = curve(def.size3[2], ts, r) * scale;
    } else {
      const s = curve(def.size, ts, R(), 1) * scale;
      d[o + SX] = d[o + SY] = d[o + SZ] = s;
    }
    if (ctx?.size !== undefined) {
      d[o + SX] *= ctx.size;
      d[o + SY] *= ctx.size;
      d[o + SZ] *= ctx.size;
    }
    const spin = def.flipRot && R() < def.flipRot ? -1 : 1;
    d[o + SPIN] = spin;
    if (def.rot3) {
      const r = R();
      d[o + RX] = curve(def.rot3[0], ts, r) * spin;
      d[o + RY] = curve(def.rot3[1], ts, r) * spin;
      d[o + RZ] = curve(def.rot3[2], ts, r) * spin;
    } else {
      d[o + RX] = d[o + RY] = 0;
      d[o + RZ] = curve(def.rot, ts, R()) * spin;
    }
    gradient(def.color, ts, R(), col4);
    if (ctx?.color) for (let k = 0; k < 4; k++) col4[k] *= ctx.color[k];
    d[o + CR] = col4[0];
    d[o + CG] = col4[1];
    d[o + CB] = col4[2];
    d[o + CA] = col4[3];
    d[o + GRAV] = curve(def.grav, ts, R());
    const uv = def.uv;
    d[o + FRAME] = uv ? curve(uv.start, ts, R()) : 0;
    d[o + ROW] = uv?.row !== undefined ? (uv.rowMode === 1 ? Math.floor(R() * uv.ty) : uv.row) : 0;
    const id = this.nextId++;
    d[o + ID] = id;
    for (const sb of this.subs) {
      if (sb.props & 8) life = Math.max(life, 0.0001);
      if (sb.type === 0 && (sb.prob >= 1 || R() < sb.prob)) {
        const w = this.worldPos(px, py, pz, frame, tmpV2);
        const sp = sb.sim.toSimSpace(w, new THREE.Vector3());
        sb.sim.addContext(id, sp.x, sp.y, sp.z, true, sb.props & 1 ? [col4[0], col4[1], col4[2], col4[3]] : undefined, sb.props & 2 ? d[o + SX] : undefined);
      }
    }
    d[o + LIFE] = life;
    this.trails?.add(id, life, d[o + SX], col4, this.time);
    this.count++;
  }

  /** Unity world position of a point in this system's simulation space. */
  worldPos(x: number, y: number, z: number, frame: SimFrame, out: THREE.Vector3) {
    out.set(x, y, z);
    if (this.def.space !== 1) out.applyMatrix4(frame.l2w);
    return out;
  }

  /** Unity world -> this system's simulation space. */
  toSimSpace(w: THREE.Vector3, out: THREE.Vector3) {
    out.copy(w);
    if (this.def.space !== 1 && this.frame) out.applyMatrix4(this.frame.w2l);
    return out;
  }

  // ------------------------------------------------------------------------------------------- simulation
  private simulate(dt: number, frame: SimFrame) {
    const def = this.def;
    const d = this.data;
    const local = def.space !== 1;
    // gravity in simulation space
    const g = tmpV2.set(0, -9.81, 0);
    if (local) {
      tmpN.setFromMatrix4(frame.w2l);
      g.applyMatrix3(tmpN);
    }
    const gx = g.x, gy = g.y, gz = g.z;
    const vel = def.vel;
    const lim = def.limit;
    const force = def.force;
    const noise = def.noise;
    const orbital = vel?.orbital;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      d[o + AGE] += dt;
      if (d[o + AGE] >= d[o + LIFE]) {
        this.kill(i, frame);
        i--;
        continue;
      }
      const t = d[o + AGE] / d[o + LIFE];
      const seed = d[o + SEED];
      // gravity + force
      const gm = d[o + GRAV];
      if (gm) {
        d[o + VX] += gx * gm * dt;
        d[o + VY] += gy * gm * dt;
        d[o + VZ] += gz * gm * dt;
      }
      if (force) {
        tmpV.set(curve(force.x, t, seed), curve(force.y, t, seed), curve(force.z, t, seed));
        this.toSpace(tmpV, !!force.world, local, frame);
        d[o + VX] += tmpV.x * dt;
        d[o + VY] += tmpV.y * dt;
        d[o + VZ] += tmpV.z * dt;
      }
      // drag / limit on the base velocity
      if (lim) {
        if (lim.drag !== undefined) {
          let k = curve(lim.drag, t, seed);
          if (lim.dragSize) k *= d[o + SX];
          const f = Math.max(0, 1 - k * dt);
          d[o + VX] *= f;
          d[o + VY] *= f;
          d[o + VZ] *= f;
        }
        if (lim.mag !== undefined) {
          const m = curve(lim.mag, t, seed);
          const s = Math.hypot(d[o + VX], d[o + VY], d[o + VZ]);
          if (s > m && s > 1e-6) {
            const ns = s - (s - m) * Math.min(1, lim.dampen * dt * 30);
            const k = ns / s;
            d[o + VX] *= k;
            d[o + VY] *= k;
            d[o + VZ] *= k;
          }
        } else if (lim.xyz) {
          for (let a = 0; a < 3; a++) {
            const m = Math.abs(curve(lim.xyz[a], t, seed));
            const v = d[o + VX + a];
            if (Math.abs(v) > m) d[o + VX + a] = v - (v - Math.sign(v) * m) * Math.min(1, lim.dampen * dt * 30);
          }
        }
      }
      let ax = 0, ay = 0, az = 0;
      if (vel) {
        if (vel.x !== undefined) {
          tmpV.set(curve(vel.x, t, d[o + R2]), curve(vel.y, t, d[o + R3]), curve(vel.z, t, d[o + R4]));
          this.toSpace(tmpV, !!vel.world, local, frame);
          ax += tmpV.x;
          ay += tmpV.y;
          az += tmpV.z;
        }
        if (vel.radial !== undefined) {
          const r = curve(vel.radial, t, seed);
          tmpV.set(d[o + PX], d[o + PY], d[o + PZ]);
          if (!local) tmpV.sub(tmpV2.setFromMatrixPosition(frame.l2w));
          if (tmpV.lengthSq() > 1e-9) {
            tmpV.normalize().multiplyScalar(r);
            ax += tmpV.x;
            ay += tmpV.y;
            az += tmpV.z;
          }
        }
      }
      if (noise) {
        const freq = noise.freq || 0.5;
        const sc = curve(noise.scroll, t, seed) * this.time;
        const str = Array.isArray(noise.str) && noise.str.length === 3 && typeof noise.str[0] !== 'number'
          ? (noise.str as Curve[]).map((c) => curve(c, t, seed))
          : [curve(noise.str as Curve, t, seed), curve(noise.str as Curve, t, seed), curve(noise.str as Curve, t, seed)];
        const amt = curve(noise.pos, t, seed, 1);
        const x = d[o + PX] * freq + seed * 17, y = d[o + PY] * freq + sc, z = d[o + PZ] * freq;
        ax += noise3(x, y, z) * str[0] * amt;
        ay += noise3(x + 31.4, y, z + 7.1) * str[1] * amt;
        az += noise3(x, y + 13.7, z + 3.3) * str[2] * amt;
      }
      const sm = vel?.speedMod !== undefined ? curve(vel.speedMod, t, seed, 1) : 1;
      d[o + AVX] = ax;
      d[o + AVY] = ay;
      d[o + AVZ] = az;
      d[o + PX] += (d[o + VX] + ax) * sm * dt;
      d[o + PY] += (d[o + VY] + ay) * sm * dt;
      d[o + PZ] += (d[o + VZ] + az) * sm * dt;
      if (orbital) {
        // rotate the particle around the system centre (local axes), radians per second
        const wx = curve(orbital[0], t, seed) * dt, wy = curve(orbital[1], t, seed) * dt, wz = curve(orbital[2], t, seed) * dt;
        if (wx || wy || wz) {
          const off = vel?.offset;
          const cx = off ? curve(off[0], t, seed) : 0, cy = off ? curve(off[1], t, seed) : 0, cz = off ? curve(off[2], t, seed) : 0;
          tmpV.set(d[o + PX] - cx, d[o + PY] - cy, d[o + PZ] - cz);
          if (!local) tmpV.sub(tmpV2.setFromMatrixPosition(frame.l2w));
          tmpE.set(wx, wy, wz, 'XYZ');
          tmpV.applyQuaternion(tmpQ.setFromEuler(tmpE));
          if (!local) tmpV.add(tmpV2.setFromMatrixPosition(frame.l2w));
          d[o + PX] = tmpV.x + cx;
          d[o + PY] = tmpV.y + cy;
          d[o + PZ] = tmpV.z + cz;
        }
      }
      // rotation over lifetime (radians / second)
      const rol = def.rol;
      if (rol !== undefined) {
        if (Array.isArray(rol) && rol.length === 3 && typeof rol[0] !== 'number') {
          const rr = rol as Curve[];
          d[o + RX] += curve(rr[0], t, seed) * d[o + SPIN] * dt;
          d[o + RY] += curve(rr[1], t, seed) * d[o + SPIN] * dt;
          d[o + RZ] += curve(rr[2], t, seed) * d[o + SPIN] * dt;
        } else d[o + RZ] += curve(rol as Curve, t, seed) * d[o + SPIN] * dt;
      }
      if (def.rbs) {
        const s = Math.hypot(d[o + VX] + ax, d[o + VY] + ay, d[o + VZ] + az);
        const k = (s - def.rbs[1]) / Math.max(1e-4, def.rbs[2] - def.rbs[1]);
        d[o + RZ] += curve(def.rbs[0], Math.min(1, Math.max(0, k)), seed) * dt;
      }
      for (const sb of this.subs) {
        if (sb.type !== 0) continue;
        const w = this.worldPos(d[o + PX], d[o + PY], d[o + PZ], frame, tmpV);
        const sp = sb.sim.toSimSpace(w, tmpV);
        sb.sim.moveContext(d[o + ID], sp.x, sp.y, sp.z);
      }
    }
  }

  /** Convert a module vector from its space (module world flag) into the simulation space. */
  private toSpace(v: THREE.Vector3, moduleWorld: boolean, simLocal: boolean, frame: SimFrame) {
    if (moduleWorld && simLocal) {
      const l = v.length();
      if (l > 0) v.transformDirection(frame.w2l).multiplyScalar(l / Math.max(1e-6, frame.scale));
    }
    else if (!moduleWorld && !simLocal) {
      const l = v.length();
      if (l > 0) v.transformDirection(frame.l2w).multiplyScalar(l * frame.scale);
    }
  }

  private kill(i: number, frame: SimFrame) {
    const d = this.data;
    const o = i * STRIDE;
    const id = d[o + ID];
    this.trails?.end(id);
    for (const sb of this.subs) {
      if (sb.type === 0) sb.sim.endContext(id);
      else if (sb.type === 2 && (sb.prob >= 1 || this.random() < sb.prob)) {
        const w = this.worldPos(d[o + PX], d[o + PY], d[o + PZ], frame, tmpV);
        const sp = sb.sim.toSimSpace(w, new THREE.Vector3());
        sb.sim.addContext(id, sp.x, sp.y, sp.z, false);
      }
    }
    const last = (this.count - 1) * STRIDE;
    if (o !== last) d.copyWithin(o, last, last + STRIDE);
    this.count--;
  }

  // ------------------------------------------------------------------------------------------- output
  private write(frame: SimFrame) {
    if (!this.mesh || !this.geom) return;
    const def = this.def;
    const d = this.data;
    const a = this.attrs;
    const P = a.iPos.array as Float32Array, S = a.iSize.array as Float32Array, Q = a.iRot.array as Float32Array,
      C = a.iColor.array as Float32Array, U = a.iUV.array as Float32Array, V = a.iVel.array as Float32Array,
      C1 = a.iC1.array as Float32Array, C2 = a.iC2.array as Float32Array;
    const local = def.space !== 1;
    const isMesh = def.r.mode === 4;
    const sizeScale = local && !isMesh ? frame.scale : 1;
    const uv = def.uv;
    const tiles = uv ? (uv.row !== undefined ? uv.tx : uv.tx * uv.ty) : 1;
    const custom = def.custom;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      const t = d[o + AGE] / d[o + LIFE];
      const seed = d[o + SEED];
      P[i * 3] = d[o + PX];
      P[i * 3 + 1] = d[o + PY];
      P[i * 3 + 2] = d[o + PZ];
      const vx = d[o + VX] + d[o + AVX], vy = d[o + VY] + d[o + AVY], vz = d[o + VZ] + d[o + AVZ];
      V[i * 3] = vx;
      V[i * 3 + 1] = vy;
      V[i * 3 + 2] = vz;
      // size over lifetime (and by speed)
      let kx = 1, ky = 1, kz = 1;
      const sol = def.sol;
      if (sol !== undefined) {
        if (Array.isArray(sol) && sol.length === 3 && typeof sol[0] !== 'number') {
          const ss = sol as Curve[];
          kx = curve(ss[0], t, seed, 1);
          ky = curve(ss[1], t, seed, 1);
          kz = curve(ss[2], t, seed, 1);
        } else kx = ky = kz = curve(sol as Curve, t, seed, 1);
      }
      if (def.sbs) {
        const s = Math.hypot(vx, vy, vz);
        const k = curve(def.sbs[0], Math.min(1, Math.max(0, (s - def.sbs[1]) / Math.max(1e-4, def.sbs[2] - def.sbs[1]))), seed, 1);
        kx *= k;
        ky *= k;
        kz *= k;
      }
      S[i * 3] = d[o + SX] * kx * sizeScale;
      S[i * 3 + 1] = (def.size3 ? d[o + SY] * ky : d[o + SX] * kx) * sizeScale;
      S[i * 3 + 2] = (def.size3 ? d[o + SZ] * kz : d[o + SX] * kx) * sizeScale;
      if (isMesh) {
        tmpE.set(d[o + RX], d[o + RY], d[o + RZ], 'YXZ');
        tmpQ.setFromEuler(tmpE);
        if (def.r.align === 4) {
          // velocity aligned meshes: +z along the velocity
          tmpV.set(vx, vy, vz);
          if (tmpV.lengthSq() > 1e-9) tmpQ.premultiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tmpV.normalize()));
        }
        Q[i * 4] = tmpQ.x;
        Q[i * 4 + 1] = tmpQ.y;
        Q[i * 4 + 2] = tmpQ.z;
        Q[i * 4 + 3] = tmpQ.w;
      } else {
        Q[i * 4] = d[o + RZ];
        Q[i * 4 + 1] = d[o + RX];
        Q[i * 4 + 2] = d[o + RY];
        Q[i * 4 + 3] = 0;
      }
      // colour over lifetime (and by speed)
      gradient(def.col, t, seed, col4b);
      let r = d[o + CR] * col4b[0], g = d[o + CG] * col4b[1], b = d[o + CB] * col4b[2], al = d[o + CA] * col4b[3];
      if (def.cbs) {
        const s = Math.hypot(vx, vy, vz);
        gradient(def.cbs[0], Math.min(1, Math.max(0, (s - def.cbs[1]) / Math.max(1e-4, def.cbs[2] - def.cbs[1]))), seed, col4b);
        r *= col4b[0];
        g *= col4b[1];
        b *= col4b[2];
        al *= col4b[3];
      }
      C[i * 4] = r;
      C[i * 4 + 1] = g;
      C[i * 4 + 2] = b;
      C[i * 4 + 3] = al;
      // texture sheet frame
      if (uv) {
        const x = (t * (uv.cycles || 1)) % 1;
        let f = Math.floor(curve(uv.fot, x, seed) * tiles + d[o + FRAME]);
        f = ((f % tiles) + tiles) % tiles;
        let col: number, row: number;
        if (uv.row !== undefined) {
          col = f;
          row = d[o + ROW];
        } else {
          col = f % uv.tx;
          row = Math.floor(f / uv.tx);
        }
        // Unity sheets run from the top-left; three uv (0,0) is bottom-left
        U[i * 4] = col / uv.tx;
        U[i * 4 + 1] = 1 - (row + 1) / uv.ty;
        U[i * 4 + 2] = 1 / uv.tx;
        U[i * 4 + 3] = 1 / uv.ty;
      } else {
        U[i * 4] = 0;
        U[i * 4 + 1] = 0;
        U[i * 4 + 2] = 1;
        U[i * 4 + 3] = 1;
      }
      if (custom) {
        for (let ci = 0; ci < 2; ci++) {
          const arr = ci ? C2 : C1;
          const cs = custom[ci];
          if (!cs) {
            arr[i * 4] = arr[i * 4 + 1] = arr[i * 4 + 2] = arr[i * 4 + 3] = 0;
          } else if ('v' in cs) {
            for (let k = 0; k < 4; k++) arr[i * 4 + k] = k < cs.v.length ? curve(cs.v[k], t, (seed * (k + 3.17)) % 1) : 0;
          } else {
            gradient(cs.c, t, seed, arr, i * 4);
          }
        }
      }
    }
    this.geom.instanceCount = this.count;
    for (const k in a) {
      a[k].needsUpdate = true;
      a[k].clearUpdateRanges();
      a[k].addUpdateRange(0, this.count * a[k].itemSize);
    }
    this.mesh.matrixWorld.copy(local ? frame.nodeWorld : MIRROR);
  }

  /** Feed the particles' positions (three world) to their ribbons and rebuild them. */
  private writeTrails(frame: SimFrame, camera: THREE.Camera) {
    const t = this.trails!;
    const d = this.data;
    const m = this.def.space !== 1 ? frame.nodeWorld : MIRROR;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      tmpV.set(d[o + PX], d[o + PY], d[o + PZ]).applyMatrix4(m);
      t.push(d[o + ID], tmpV.x, tmpV.y, tmpV.z, this.time);
    }
    t.build(this.time, camera);
  }

  /** Longest a particle of this system can live (for effect durations). */
  maxLife() {
    return curveMax(this.def.life, 1);
  }

  dispose() {
    this.geom?.dispose();
    this.mesh?.removeFromParent();
    this.trails?.dispose();
  }
}
