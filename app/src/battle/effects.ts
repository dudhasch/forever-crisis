import * as THREE from 'three';
import { EffectPlayer, effectLibrary, playStageAmbience, type EffectInstance, type Placement } from '../effects/player';
import type { BodyDef } from '../effects/types';
import type { EffectEvent } from './data';

/**
 * Battle effects. EC's own particle prefabs (generated/effects, src/effects) play at the times and attach points
 * of each skill's Play*EffectEvents, with the shared hit sparks on every hit, and the stage's ambient FieldEffects
 * loop in the background. The old stand-ins (additive sprites, shells) stay as the fallback when an action has no
 * converted effect.
 */

let glow: THREE.Texture | null = null;
function glowTexture() {
  if (glow) return glow;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glow = new THREE.CanvasTexture(c);
  glow.colorSpace = THREE.SRGBColorSpace;
  return glow;
}

interface Particle {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  max: number;
  grow: number;
  gravity: number;
  base: number;
}

interface Shell {
  mesh: THREE.Mesh;
  life: number;
  max: number;
  from: number;
  to: number;
}

/** What the effects need of a battle fighter (src/battle/battle.ts Fighter). */
export interface FxFighter {
  char: { root: THREE.Object3D; model: THREE.Object3D; url: string; height: number };
  side: 'party' | 'enemy';
  home: THREE.Vector3;
  alive: boolean;
  radius: number;
}

/** Where an action's events play: who acts, on whom, and both sides (for area effects). */
export interface FxContext {
  actor: FxFighter;
  targets: FxFighter[];
  fighters: FxFighter[];
  /** battle clock (sleeps follow the battle's pause / slow motion) */
  sleep: (s: number) => Promise<void>;
}

/** Element id (m_skill_base.ElementType) -> name in EC's common effect prefabs. */
const ELEMENT_FX: Record<number, string> = { 1: 'none', 2: 'fire', 3: 'ice', 4: 'thunder', 5: 'earth', 6: 'water', 7: 'wind' };

/** EC TransformType -> bone the battle models use when bodies.json has no entry. */
const DEFAULT_BONES: Record<number, string[]> = {
  2: ['right_hand'],
  3: ['right_hand_weapon', 'right_hand'],
  4: ['right_toe'],
  5: ['left_hand'],
  6: ['left_hand_weapon', 'left_hand'],
  7: ['left_toe'],
  8: ['main_weapon'],
  9: ['head', 'head_a'],
  10: ['hip'],
  11: ['spine4', 'spine3'],
  12: ['spine3', 'hip'],
  14: ['head', 'head_a'],
  15: ['main_weapon', 'right_hand_weapon'],
  16: ['main_weapon', 'right_hand_weapon'],
  17: ['sub_weapon', 'left_hand_weapon'],
  18: ['sub_weapon', 'left_hand_weapon'],
  19: ['spine3', 'hip'],
  20: ['spine3', 'hip'],
};

const tmpV = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Effects {
  readonly group = new THREE.Group();
  readonly ec = new EffectPlayer();
  private particles: Particle[] = [];
  private shells: Shell[] = [];
  private bodies = new Map<string, Promise<BodyDef | null>>();
  /** locators added to models for attach points the GLB lacks (camera_target, system_effect_target ...) */
  private locators = new WeakMap<THREE.Object3D, Map<number, THREE.Object3D>>();
  private camera: THREE.Camera | null = null;
  private ambience = 0;

  constructor() {
    this.group.name = 'battle-effects';
    this.group.add(this.ec.group);
  }

  // ------------------------------------------------------------------------------------- EC effects
  /** Loop the stage's ambient particles; returns how many effects were placed. */
  async stage(environment: number, fog: THREE.Fog | THREE.FogExp2 | null) {
    this.ec.fog = fog;
    this.ambience = await playStageAmbience(this.ec, environment).catch((e) => {
      console.warn('effects: stage ambience', environment, e);
      return 0;
    });
    return this.ambience;
  }

  /** Are the action's effects converted? (else battle.ts keeps the stand-ins) */
  async ready(events: EffectEvent[] | undefined) {
    if (!events?.length) return false;
    const keys = new Set<string>();
    for (const e of events) {
      if (e.fx) keys.add(e.fx);
      if (e.outFx) keys.add(e.outFx);
    }
    const loaded = await this.ec.preload(keys);
    return loaded.some(Boolean);
  }

  /** Preload the shared hit sparks. */
  preloadCommon() {
    const keys: string[] = [];
    for (const el of Object.values(ELEMENT_FX)) keys.push(`battle/common/hit/pfb_eff_cm_hit_${el}`, `battle/common/hit/pfb_eff_cm_hit_${el}_strong`);
    keys.push('battle/common/statuschange/pfb_eff_cm_sc_cure');
    return this.ec.preload(keys);
  }

  private body(f: FxFighter) {
    const url = f.char.url;
    let p = this.bodies.get(url);
    if (!p) {
      p = effectLibrary.body(url);
      this.bodies.set(url, p);
    }
    return p;
  }

  /** The object an EC TransformType refers to on this fighter. */
  async point(f: FxFighter, type: number | undefined, bone?: string): Promise<THREE.Object3D> {
    const model = f.char.model;
    if (bone) {
      const b = model.getObjectByName(bone);
      if (b) return b;
    }
    if (!type || type === 1) return f.char.root;
    let cache = this.locators.get(model);
    if (!cache) {
      cache = new Map();
      this.locators.set(model, cache);
    }
    const hit = cache.get(type);
    if (hit) return hit;
    let found: THREE.Object3D | null = null;
    const body = await this.body(f);
    if (type === 15 || type === 16 || type === 17 || type === 18) {
      // weapon: the equip point, or the weapon's own tip ("point" in its GLB) for *Point
      const equip = body?.equip?.[type <= 16 ? 'Main' : 'Sub'] ?? (type <= 16 ? 'main_weapon' : 'sub_weapon');
      const root = model.getObjectByName(equip) ?? null;
      if (root && (type === 16 || type === 18)) {
        let tip: THREE.Object3D | null = null;
        root.traverse((o) => {
          if (!tip && o.name === 'point') tip = o;
        });
        found = tip ?? root;
      } else found = root;
    }
    const p = body?.points?.[String(type)];
    if (!found && p) {
      found = model.getObjectByName(p[0]) ?? null;
      if (!found) {
        // a locator the model GLB does not have: add it under its parent with the Unity local transform
        const parent = (p[1] ? model.getObjectByName(p[1]) : null) ?? model;
        const loc = new THREE.Object3D();
        loc.name = `fx-point:${p[0]}`;
        loc.position.set(-p[2][0], p[2][1], p[2][2]);
        loc.quaternion.set(p[3][0], -p[3][1], -p[3][2], p[3][3]);
        // parent "Locators" sits at the model root in the prefab
        if (parent === model) model.add(loc);
        else parent.add(loc);
        found = loc;
      }
    }
    if (!found) for (const n of DEFAULT_BONES[type] ?? []) {
      found = model.getObjectByName(n) ?? null;
      if (found) break;
    }
    const res = found ?? f.char.root;
    cache.set(type, res);
    return res;
  }

  /**
   * Schedule an action's effect events (times relative to now, i.e. the start of the clip they belong to).
   * Resolves when the last one has started.
   */
  async play(events: EffectEvent[] | undefined, ctx: FxContext) {
    if (!events?.length) return;
    let t0 = 0;
    const started: Promise<unknown>[] = [];
    for (const e of [...events].sort((a, b) => a.t - b.t)) {
      if (e.t > t0) {
        await ctx.sleep(e.t - t0);
        t0 = e.t;
      }
      started.push(this.event(e, ctx).catch((err) => console.warn('effects: event', e.fx, err)));
    }
    await Promise.all(started);
  }

  private async event(e: EffectEvent, ctx: FxContext) {
    const a = ctx.actor;
    if (e.kind === 'area') {
      if (!e.fx) return;
      const opp = e.area !== 0;
      const side = ctx.fighters.filter((f) => (f.side === a.side) !== opp);
      const list = side.length ? side : ctx.targets;
      const center = list.reduce((p, f) => p.add(f.home), new THREE.Vector3()).divideScalar(Math.max(1, list.length));
      center.y = 0;
      // face the other side
      const other = ctx.fighters.filter((f) => (f.side === a.side) === opp);
      const toward = other.length ? other.reduce((p, f) => p.add(f.home), new THREE.Vector3()).divideScalar(other.length) : a.home;
      const q = yawTo(center, toward);
      await this.ec.spawn(e.fx, { position: center, quaternion: q, offset: e.off, angles: e.ang, scale: e.scale });
      return;
    }
    if (e.kind === 'long') {
      await Promise.all(ctx.targets.map((t) => this.projectile(e, a, t, ctx)));
      return;
    }
    const on = e.kind === 'target' ? ctx.targets : [a];
    await Promise.all(
      on.map(async (f, i) => {
        if (e.jitter && i) await ctx.sleep(Math.random() * e.jitter);
        const body = await this.body(f);
        let key = e.fx;
        if (e.sizes && body?.size) key = e.sizes[['S', 'S', 'M', 'L', 'LL'][body.size] ?? 'M'] ?? key;
        if (!key) return;
        const anchor = await this.point(f, e.at, e.bone);
        const place: Placement = { anchor, follow: !!e.follow, offset: [...e.off], angles: e.ang, scale: e.scale, duration: e.dur };
        if (e.scaleCurve) {
          place.scaleCurve = e.scaleCurve;
          place.scaleDuration = e.scaleDur;
        }
        if (e.kind === 'target' && e.between && f !== a) {
          // EC's between offset: placed on the target, turned toward the attacker
          place.anchor = undefined;
          place.position = f.char.root.position.clone();
          place.quaternion = yawTo(f.char.root.position, a.char.root.position);
          const b = body?.between ?? [0, 1, 0];
          if (e.between[1]) place.offset![1] += b[1];
          if (e.between[2]) place.offset![2] += Math.max(b[2], f.radius * 0.5);
        } else if (e.at === 1 || !e.at) {
          // root-anchored: the fighter's ground position and facing, not following the model's bones
          if (!e.follow) {
            place.anchor = undefined;
            place.position = f.char.root.position.clone();
            place.quaternion = f.char.root.quaternion.clone();
          } else place.anchor = f.char.root;
        }
        const scale = body?.effectScale ?? 1;
        if (scale !== 1) place.scale = (e.scale ?? [1, 1, 1]).map((x) => x * scale);
        await this.ec.spawn(key, place);
      }),
    );
  }

  private async projectile(e: EffectEvent, a: FxFighter, t: FxFighter, ctx: FxContext) {
    const from = await this.point(a, e.at ?? 1, e.bone);
    from.updateWorldMatrix(true, false);
    const start = new THREE.Vector3();
    const q = new THREE.Quaternion();
    from.matrixWorld.decompose(start, q, tmpV);
    // EC's offsets are in the actor's frame (x mirrored to three)
    const yaw = a.char.root.quaternion;
    start.add(new THREE.Vector3(-e.off[0], e.off[1], e.off[2]).applyQuaternion(yaw));
    const end = t.char.root.position.clone();
    const ho = e.hitOff ?? [0, 0, 0];
    end.y += t.char.height * 0.55 * (e.hitHeight ?? 1) + ho[1];
    const dur = Math.max(0.05, e.dur ?? 0.4);
    let inst: EffectInstance | null = null;
    if (e.fx) inst = await this.ec.spawn(e.fx, { position: start, quaternion: yawTo(start, end), scale: e.scale, duration: dur + 0.1 });
    const h = e.homing;
    const side = new THREE.Vector3().subVectors(end, start).cross(UP).normalize();
    const steps = Math.max(2, Math.round(dur * 30));
    const pos = new THREE.Vector3();
    const prev = start.clone();
    for (let i = 1; i <= steps; i++) {
      await ctx.sleep(dur / steps);
      const k = i / steps;
      const p = h?.progress ? sampleAt(h.progress, k) : k;
      pos.lerpVectors(start, end, p);
      if (h?.x) pos.addScaledVector(side, sampleAt(h.x, k) * h.xBias);
      if (h?.y) pos.y += sampleAt(h.y, k) * h.yBias;
      inst?.moveTo(pos, yawTo(prev, pos));
      prev.copy(pos);
    }
    inst?.stop();
    if (e.outFx) await this.ec.spawn(e.outFx, { position: end, quaternion: yawTo(end, start), scale: e.outScale });
  }

  /** EC's shared hit spark on a target (by element, strong on criticals); false when not converted. */
  async impact(t: FxFighter, element: number, strong: boolean) {
    const el = ELEMENT_FX[element] ?? 'none';
    const key = `battle/common/hit/pfb_eff_cm_hit_${el}${strong ? '_strong' : ''}`;
    if (!(await effectLibrary.has(key))) return false;
    const anchor = await this.point(t, 19);
    anchor.updateWorldMatrix(true, false);
    const pos = new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld);
    if (anchor === t.char.root) pos.y += t.char.height * 0.55;
    const cam = this.camera ? new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld) : pos.clone().add(new THREE.Vector3(0, 0, 1));
    await this.ec.spawn(key, { position: pos, quaternion: yawTo(pos, cam) });
    return true;
  }

  /** EC's cure sparkles (items, heals without their own effect). */
  async cure(t: FxFighter) {
    const key = 'battle/common/statuschange/pfb_eff_cm_sc_cure';
    if (!(await effectLibrary.has(key))) return false;
    await this.ec.spawn(key, { position: t.char.root.position.clone(), quaternion: t.char.root.quaternion.clone() });
    return true;
  }

  // ------------------------------------------------------------------------------------- stand-ins
  private spark(pos: THREE.Vector3, color: number, vel: THREE.Vector3, size: number, life: number, gravity = 0, grow = 0) {
    const mat = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const s = new THREE.Sprite(mat);
    s.position.copy(pos);
    s.scale.setScalar(size);
    s.renderOrder = 20;
    this.group.add(s);
    this.particles.push({ sprite: s, vel, life, max: life, grow, gravity, base: size });
  }

  /** Weapon / claw impact. */
  hit(pos: THREE.Vector3, color = 0xffffff, strength = 1) {
    this.spark(pos, 0xffffff, new THREE.Vector3(), 0.9 * strength, 0.12, 0, 4);
    for (let i = 0; i < 12; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      this.spark(pos, color, dir.multiplyScalar(3 + Math.random() * 4), 0.18 + Math.random() * 0.12, 0.25 + Math.random() * 0.2, -6);
    }
  }

  /** Spell burst on a target: a glowing shell plus a ring of motes. */
  burst(pos: THREE.Vector3, color: number, radius = 1.2) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.1);
    this.group.add(mesh);
    this.shells.push({ mesh, life: 0.55, max: 0.55, from: 0.2, to: radius });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), (Math.random() - 0.3) * 0.8, Math.sin(a));
      this.spark(pos, color, dir.multiplyScalar(2 + Math.random() * 3), 0.3 + Math.random() * 0.3, 0.5 + Math.random() * 0.3, -1.5);
    }
    this.spark(pos, 0xffffff, new THREE.Vector3(), 1.6 * radius, 0.18, 0, 6);
  }

  /** Charging glow at a caster's hands. */
  charge(pos: THREE.Vector3, color: number) {
    for (let i = 0; i < 10; i++) {
      const off = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).multiplyScalar(1.6);
      this.spark(pos.clone().add(off), color, off.clone().multiplyScalar(-2.2), 0.22, 0.45, 0);
    }
  }

  /** Healing sparkles rising around a target. */
  heal(pos: THREE.Vector3) {
    for (let i = 0; i < 18; i++) {
      const off = new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 0.6, (Math.random() - 0.5) * 1.2);
      this.spark(pos.clone().add(off), i % 3 ? 0x9dffb0 : 0xffffff, new THREE.Vector3(0, 1.5 + Math.random() * 1.5, 0), 0.2, 0.9 + Math.random() * 0.4, 0);
    }
  }

  /** Summon finale: a large column of light on the enemies' side. */
  pillar(pos: THREE.Vector3, color: number) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 14, 32, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    mesh.position.copy(pos).add(new THREE.Vector3(0, 7, 0));
    this.group.add(mesh);
    this.shells.push({ mesh, life: 1.4, max: 1.4, from: 0.5, to: 7 });
    for (let i = 0; i < 40; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      this.spark(pos.clone().add(new THREE.Vector3(0, 0.5, 0)), color, dir.multiplyScalar(4 + Math.random() * 6), 0.5, 1 + Math.random() * 0.5, -3);
    }
  }

  update(dt: number, camera?: THREE.Camera) {
    if (camera) {
      this.camera = camera;
      // the stage sets the scene's fog; new effect materials fade with it
      this.ec.fog = (this.group.parent as THREE.Scene | null)?.fog ?? null;
      this.ec.update(dt, camera);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.sprite.removeFromParent();
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y += p.gravity * dt;
      p.sprite.position.addScaledVector(p.vel, dt);
      const k = p.life / p.max;
      p.sprite.material.opacity = Math.min(1, k * 1.6);
      p.sprite.scale.setScalar(p.base * (1 + p.grow * (1 - k)));
    }
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      const mat = s.mesh.material as THREE.MeshBasicMaterial;
      if (s.life <= 0) {
        s.mesh.removeFromParent();
        s.mesh.geometry.dispose();
        mat.dispose();
        this.shells.splice(i, 1);
        continue;
      }
      const k = 1 - s.life / s.max;
      const r = s.from + (s.to - s.from) * (1 - (1 - k) * (1 - k));
      if (s.mesh.geometry.type === 'CylinderGeometry') s.mesh.scale.set(r * 0.3, 1, r * 0.3);
      else s.mesh.scale.setScalar(r);
      mat.opacity = 0.55 * (1 - k);
    }
  }

  dispose() {
    for (const p of this.particles) p.sprite.material.dispose();
    for (const s of this.shells) {
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
    }
    this.particles = [];
    this.shells = [];
    this.ec.dispose();
    this.group.removeFromParent();
  }
}

/** Yaw-only rotation at `from` looking toward `to` (three space, +z forward like the models). */
function yawTo(from: THREE.Vector3, to: THREE.Vector3) {
  const d = tmpV.subVectors(to, from);
  return new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(d.x, d.z));
}

function sampleAt(s: number[], t: number) {
  const n = s.length - 1;
  if (n <= 0) return s[0] ?? 0;
  const x = Math.min(1, Math.max(0, t)) * n;
  const i = Math.min(n - 1, Math.floor(x));
  return s[i] + (s[i + 1] - s[i]) * (x - i);
}
