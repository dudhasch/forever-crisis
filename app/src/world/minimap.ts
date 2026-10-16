import * as THREE from 'three';
import type { CollisionWorld } from './collision';

/**
 * The Remake-style corner minimap: a top-down picture of the walkable floor, built from the map's collision
 * triangles, turned so that up is where the camera looks. The disc and the rim around it are UI-kit art
 * (public/ui/minimap-*.png, brand/gimp/ui/hud.py); this draws the floor, the markers and the player arrow.
 */

export type MarkerKind = 'objective' | 'exit' | 'examine' | 'treasure' | 'npc' | 'ladder';

export interface MapMarker {
  kind: MarkerKind;
  position: THREE.Vector3;
}

/** Metres from the centre to the edge of the disc. */
const VIEW_RADIUS = 22;
/** Floors further than this below / above the player belong to another storey. */
const BELOW = 2.6;
const ABOVE = 2.0;
/** Floor raster: at most this many pixels a side, at most this many pixels a metre. */
const RASTER_MAX = 1600;
const RASTER_PPM = 8;
/** Markers that stay on the rim when they are out of view. */
const PINNED: ReadonlySet<MarkerKind> = new Set(['objective', 'exit']);

const FLOOR = 'rgba(120, 200, 255, 0.24)';
const EDGE = 'rgba(190, 240, 255, 0.85)';

interface Floor {
  /** ax, az, bx, bz, cx, cz per triangle, wound the same way. */
  xz: Float32Array;
  /** min y, max y per triangle. */
  y: Float32Array;
  count: number;
  minX: number;
  minZ: number;
  ppm: number;
  w: number;
  h: number;
}

/** The walkable (flat enough) triangles of a collision mesh. */
export function floorTriangles(world: CollisionWorld): Floor | null {
  const pos = world.geometry.getAttribute('position');
  const idx = world.geometry.getIndex();
  const n = Math.floor((idx ? idx.count : pos.count) / 3);
  const xz = new Float32Array(n * 6);
  const ys = new Float32Array(n * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  let count = 0;
  for (let t = 0; t < n; t++) {
    const i = t * 3;
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const nx = ab.y * ac.z - ab.z * ac.y;
    const ny = ab.z * ac.x - ab.x * ac.z;
    const nz = ab.x * ac.y - ab.y * ac.x;
    const len = Math.hypot(nx, ny, nz);
    // walls and steep slopes are not floor (either winding: colliders are not consistent)
    if (len < 1e-6 || Math.abs(ny) / len < 0.55) continue;
    const o = count * 6;
    // same 2D winding for every triangle, so one nonzero fill never cancels overlapping ones
    const flip = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x) < 0;
    const p = flip ? [a, c, b] : [a, b, c];
    for (let k = 0; k < 3; k++) {
      xz[o + k * 2] = p[k].x;
      xz[o + k * 2 + 1] = p[k].z;
    }
    ys[count * 2] = Math.min(a.y, b.y, c.y);
    ys[count * 2 + 1] = Math.max(a.y, b.y, c.y);
    count++;
  }
  if (!count) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < count * 6; i += 2) {
    minX = Math.min(minX, xz[i]);
    maxX = Math.max(maxX, xz[i]);
    minZ = Math.min(minZ, xz[i + 1]);
    maxZ = Math.max(maxZ, xz[i + 1]);
  }
  minX -= 2;
  minZ -= 2;
  const ext = Math.max(maxX - minX + 2, maxZ - minZ + 2, 1);
  const ppm = Math.min(RASTER_PPM, RASTER_MAX / ext);
  return {
    xz,
    y: ys,
    count,
    minX,
    minZ,
    ppm,
    w: Math.ceil((maxX - minX + 2) * ppm),
    h: Math.ceil((maxZ - minZ + 2) * ppm),
  };
}

export class Minimap {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private floor: Floor | null = null;
  /** The floor around the player's storey, drawn once and reused while they stay on it. */
  private raster = document.createElement('canvas');
  private rasterY = NaN;
  private rasterAge = 0;
  private angle = NaN;
  private dir = new THREE.Vector3();
  private time = 0;

  setWorld(world: CollisionWorld | null) {
    this.floor = world ? floorTriangles(world) : null;
    this.rasterY = NaN;
    this.angle = NaN;
  }

  get hasMap() {
    return !!this.floor;
  }

  /** The storey's floor with a glowing outline (re-drawn when the player climbs to another storey). */
  private buildRaster(py: number) {
    const f = this.floor!;
    const r = this.raster;
    r.width = f.w;
    r.height = f.h;
    const mask = document.createElement('canvas');
    mask.width = f.w;
    mask.height = f.h;
    const m = mask.getContext('2d')!;
    const path = new Path2D();
    for (let t = 0; t < f.count; t++) {
      if (f.y[t * 2 + 1] < py - BELOW || f.y[t * 2] > py + ABOVE) continue;
      const o = t * 6;
      path.moveTo((f.xz[o] - f.minX) * f.ppm, (f.xz[o + 1] - f.minZ) * f.ppm);
      path.lineTo((f.xz[o + 2] - f.minX) * f.ppm, (f.xz[o + 3] - f.minZ) * f.ppm);
      path.lineTo((f.xz[o + 4] - f.minX) * f.ppm, (f.xz[o + 5] - f.minZ) * f.ppm);
      path.closePath();
    }
    m.fillStyle = '#fff';
    m.fill(path);
    // close the hairline seams between neighbouring triangles
    m.lineWidth = 1;
    m.strokeStyle = '#fff';
    m.stroke(path);
    // outline = the mask grown by ~1.5 px, minus the mask
    const edge = document.createElement('canvas');
    edge.width = f.w;
    edge.height = f.h;
    const e = edge.getContext('2d')!;
    const d = Math.max(1.5, f.ppm * 0.2);
    for (const [dx, dy] of [
      [d, 0],
      [-d, 0],
      [0, d],
      [0, -d],
      [d * 0.7, d * 0.7],
      [-d * 0.7, d * 0.7],
      [d * 0.7, -d * 0.7],
      [-d * 0.7, -d * 0.7],
    ])
      e.drawImage(mask, dx, dy);
    e.globalCompositeOperation = 'source-in';
    e.fillStyle = EDGE;
    e.fillRect(0, 0, f.w, f.h);
    e.globalCompositeOperation = 'destination-out';
    e.drawImage(mask, 0, 0);
    const c = r.getContext('2d')!;
    c.clearRect(0, 0, f.w, f.h);
    c.drawImage(mask, 0, 0);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = FLOOR;
    c.fillRect(0, 0, f.w, f.h);
    c.globalCompositeOperation = 'source-over';
    c.drawImage(edge, 0, 0);
    this.rasterY = py;
    this.rasterAge = 0;
  }

  /**
   * Draw one frame. `size` = the disc's diameter in CSS px. Returns the arrow's screen angle (radians, 0 = up,
   * clockwise) and the objective's distance in metres (or null), for the DOM around the canvas.
   */
  draw(dt: number, size: number, camera: THREE.Camera, player: THREE.Vector3, heading: number, markers: MapMarker[], still: boolean) {
    this.time += dt;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const px = Math.max(1, Math.round(size * dpr));
    if (this.canvas.width !== px) {
      this.canvas.width = this.canvas.height = px;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    // up on the map = where the camera looks (turned smoothly when a fixed camera cuts)
    camera.getWorldDirection(this.dir);
    const want = Math.hypot(this.dir.x, this.dir.z) > 0.05 ? -Math.PI / 2 - Math.atan2(this.dir.z, this.dir.x) : this.angle || 0;
    if (Number.isNaN(this.angle) || still) this.angle = want;
    else {
      const d = Math.atan2(Math.sin(want - this.angle), Math.cos(want - this.angle));
      this.angle += d * (1 - Math.exp(-dt * 8));
    }
    const th = this.angle;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const R = px / 2;
    const k = R / VIEW_RADIUS; // canvas px per metre
    ctx.save();
    ctx.beginPath();
    ctx.arc(R, R, R, 0, Math.PI * 2);
    ctx.clip();
    const f = this.floor;
    if (f) {
      this.rasterAge += dt;
      if (Number.isNaN(this.rasterY) || (Math.abs(player.y - this.rasterY) > 1.2 && this.rasterAge > 0.4)) this.buildRaster(player.y);
      ctx.translate(R, R);
      ctx.rotate(th);
      ctx.scale(k / f.ppm, k / f.ppm);
      ctx.translate(-(player.x - f.minX) * f.ppm, -(player.z - f.minZ) * f.ppm);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.raster, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // markers: world (x, z) relative to the player, turned like the map
    let objective: number | null = null;
    const order: MarkerKind[] = ['npc', 'ladder', 'treasure', 'examine', 'exit', 'objective'];
    const sorted = [...markers].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    ctx.restore();
    for (const m of sorted) {
      const dx = m.position.x - player.x;
      const dz = m.position.z - player.z;
      if (Math.abs(m.position.y - player.y) > 6 && m.kind !== 'objective' && m.kind !== 'exit') continue;
      let sx = (dx * cos - dz * sin) * k;
      let sy = (dx * sin + dz * cos) * k;
      const dist = Math.hypot(dx, dz);
      if (m.kind === 'objective' && (objective === null || dist < objective)) objective = dist;
      const r = Math.hypot(sx, sy);
      const edge = R - 9 * dpr;
      let pinned = false;
      if (r > edge) {
        if (!PINNED.has(m.kind)) continue;
        sx *= edge / r;
        sy *= edge / r;
        pinned = true;
      }
      this.marker(m.kind, R + sx, R + sy, dpr, pinned, still);
    }
    // the player's facing on screen: world forward (sin h, cos h), turned like the map
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const ax = fx * cos - fz * sin;
    const ay = fx * sin + fz * cos;
    return { arrow: Math.atan2(ax, -ay), objective };
  }

  private marker(kind: MarkerKind, x: number, y: number, s: number, pinned: boolean, still: boolean) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.shadowBlur = 6 * s;
    switch (kind) {
      case 'objective': {
        // a gold diamond that breathes (holds still with reduced motion)
        const p = still ? 1 : 1 + 0.12 * Math.sin(this.time * 4);
        const r = 7.5 * s * p;
        ctx.shadowColor = 'rgba(255, 207, 90, 0.95)';
        ctx.fillStyle = '#ffd25a';
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r, 0);
        ctx.lineTo(0, r);
        ctx.lineTo(-r, 0);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#fff6d6';
        ctx.beginPath();
        ctx.moveTo(0, -r * 0.45);
        ctx.lineTo(r * 0.45, 0);
        ctx.lineTo(0, r * 0.45);
        ctx.lineTo(-r * 0.45, 0);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'exit': {
        // a cyan doorway chevron pointing away from the centre when it sits on the rim
        ctx.shadowColor = 'rgba(120, 220, 255, 0.9)';
        ctx.fillStyle = pinned ? 'rgba(120, 220, 255, 0.85)' : '#78dcff';
        if (pinned) ctx.rotate(Math.atan2(y - this.canvas.height / 2, x - this.canvas.width / 2) + Math.PI / 2);
        const r = 6.5 * s;
        ctx.beginPath();
        ctx.moveTo(0, -r);
        ctx.lineTo(r, r * 0.7);
        ctx.lineTo(0, r * 0.15);
        ctx.lineTo(-r, r * 0.7);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'examine': {
        ctx.shadowColor = 'rgba(205, 245, 255, 0.9)';
        ctx.strokeStyle = '#cdf5ff';
        ctx.lineWidth = 1.5 * s;
        ctx.beginPath();
        ctx.arc(0, 0, 4.5 * s, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(0, 0, 1.8 * s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'treasure': {
        ctx.shadowColor = 'rgba(255, 207, 90, 0.8)';
        ctx.fillStyle = '#e6b44a';
        const r = 4 * s;
        ctx.fillRect(-r, -r * 0.75, r * 2, r * 1.5);
        ctx.fillStyle = '#fff2c4';
        ctx.fillRect(-r, -r * 0.15, r * 2, r * 0.3);
        break;
      }
      case 'npc': {
        ctx.shadowColor = 'rgba(111, 227, 154, 0.8)';
        ctx.fillStyle = '#9af0bd';
        ctx.beginPath();
        ctx.arc(0, 0, 3.6 * s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'ladder': {
        ctx.shadowColor = 'rgba(120, 220, 255, 0.8)';
        ctx.strokeStyle = '#a8e8ff';
        ctx.lineWidth = 1.4 * s;
        const r = 4.5 * s;
        ctx.beginPath();
        ctx.moveTo(-r * 0.55, -r);
        ctx.lineTo(-r * 0.55, r);
        ctx.moveTo(r * 0.55, -r);
        ctx.lineTo(r * 0.55, r);
        for (const yy of [-0.45, 0.15, 0.75]) {
          ctx.moveTo(-r * 0.55, r * yy);
          ctx.lineTo(r * 0.55, r * yy);
        }
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }
}
