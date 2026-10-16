import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { fetchJSON, loadGLTF, tryJSON } from '../assets';
import { isBattleModel, loadPbrMaps } from '../render/pbr';
import { attachWeapon, type WeaponEntry } from './weapon';
import { stylizeCharacter } from '../render/toon';
import type { AnimIndex } from '../types';

type Role = 'idle' | 'walk' | 'run';

let animIndex: Promise<AnimIndex | null> | null = null;
function getAnimIndex() {
  animIndex ??= tryJSON<AnimIndex>('/gen/anims/index.json');
  return animIndex;
}

const clipCache = new Map<string, Promise<THREE.AnimationClip>>();
export function loadClip(file: string) {
  let p = clipCache.get(file);
  if (!p) {
    p = fetchJSON<Partial<THREE.AnimationClipJSON>>(`/gen/anims/${file}`).then((j) =>
      THREE.AnimationClip.parse({ ...j, uuid: j.uuid ?? file, blendMode: j.blendMode ?? THREE.NormalAnimationBlendMode } as THREE.AnimationClipJSON),
    );
    clipCache.set(file, p);
  }
  return p;
}

/** "/lib/unity/questcharacter/001/model/003/model.glb" -> "questcharacter/001" */
export function familyOf(url: string) {
  const m = /unity\/(questcharacter|character|monster)\/([^/]+)\//.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface Loco {
  clip: THREE.AnimationClip;
  /** Ground speed the clip was authored for (m/s), from its stripped root motion. */
  speed?: number;
}

let speedByFile: Map<string, number> | null = null;
function clipSpeeds(index: AnimIndex) {
  if (!speedByFile) {
    speedByFile = new Map();
    const lists = [...Object.values(index.families), ...Object.values(index.shared ?? {})];
    for (const l of lists) for (const c of l.clips) if (c.rootMotion?.speed) speedByFile.set(c.file, c.rootMotion.speed);
  }
  return speedByFile;
}

async function locomotionFor(url: string): Promise<Partial<Record<Role, Loco>>> {
  const index = await getAnimIndex();
  if (!index) return {};
  const rel = url.replace(/^\/lib\//, '');
  const speeds = clipSpeeds(index);
  const load = async (files: Partial<Record<Role, string | null>>) => {
    const out: Partial<Record<Role, Loco>> = {};
    for (const role of ['idle', 'walk', 'run'] as Role[]) {
      const file = files[role];
      if (!file) continue;
      const clip = await loadClip(file).catch((e) => {
        warnOnce(`character: ${role} clip /gen/anims/${file} for ${url} failed to load: ${e}`);
        return undefined;
      });
      if (clip) out[role] = { clip, speed: speeds.get(file) };
    }
    return out;
  };
  // Per-model entry: the game's own override-controller slots for exactly this model.
  const direct = index.models?.[rel]?.locomotionFiles;
  if (direct) {
    const out = await load(direct);
    if (out.idle || out.walk || out.run) return out;
  }
  // Otherwise borrow from the same character, then from that kind's first character.
  const fam = familyOf(url);
  const candidates = [
    ...Object.entries(index.families).filter(([k]) => k === fam),
    ...Object.entries(index.families).filter(([k]) => fam && k === `${fam.split('/')[0]}/001`),
  ];
  for (const [, family] of candidates) {
    const files: Partial<Record<Role, string>> = {};
    for (const role of ['idle', 'walk', 'run'] as Role[]) {
      const name = family.locomotion?.[role];
      const entry = name ? family.clips.find((c) => c.name === name) ?? Object.values(index.shared ?? {}).flatMap((s) => s.clips).find((c) => c.name === name) : undefined;
      if (entry) files[role] = entry.file;
    }
    const out = await load(files);
    if (out.walk || out.idle || out.run) return out;
  }
  return {};
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

/** Shared clips can animate bones a model lacks (weapon, shoulder pads): drop those tracks. */
function bindable(clip: THREE.AnimationClip, root: THREE.Object3D, who = '') {
  const tracks = clip.tracks.filter((t) => root.getObjectByName(t.name.slice(0, t.name.lastIndexOf('.'))));
  if (clip.tracks.length && tracks.length < clip.tracks.length * 0.5)
    warnOnce(`character: clip ${clip.name} binds only ${tracks.length}/${clip.tracks.length} tracks on ${who || root.name || 'model'} (wrong skeleton?)`);
  return tracks.length === clip.tracks.length ? clip : new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode);
}

export interface CharacterOptions {
  outline?: boolean;
  silhouette?: THREE.Color;
}

export class Character {
  readonly root = new THREE.Group();
  readonly url: string;
  model!: THREE.Object3D;
  mixer!: THREE.AnimationMixer;
  private actions: Partial<Record<Role, THREE.AnimationAction>> = {};
  private current: Role | null = null;
  private currentAction: THREE.AnimationAction | undefined;
  private phase = 0;
  private procBones: Record<string, { bone: THREE.Object3D; rest: THREE.Quaternion }> = {};
  private clipSpeed = new Map<THREE.AnimationAction, number>();
  /** A story motion (playAction) overriding locomotion, until it ends or is stopped. */
  private motion: { action: THREE.AnimationAction; loop: boolean; finished: boolean } | null = null;
  /** Partial-body story motions (upper body, neck, arms…), applied over the base pose by their own mixer. */
  private layerMixer: THREE.AnimationMixer | null = null;
  private layers = new Map<string, { action: THREE.AnimationAction; loop: boolean; finished: boolean }>();
  private lookTarget: THREE.Vector3 | null = null;
  private lookWeight = 0;
  private head: THREE.Object3D | null = null;
  procedural = false;
  height = 1.8;

  private constructor(url: string) {
    this.url = url;
    this.root.name = `character:${url}`;
  }

  static async load(url: string, opts: CharacterOptions = {}) {
    const c = new Character(url);
    const gltf = await loadGLTF(url);
    c.model = cloneSkinned(gltf.scene);
    const pbr = isBattleModel(url) ? await loadPbrMaps(url, c.model).catch(() => null) : undefined;
    stylizeCharacter(c.model, { outline: opts.outline ?? true, silhouette: opts.silhouette, pbr });
    c.root.add(c.model);
    const box = new THREE.Box3().setFromObject(c.model);
    if (isFinite(box.max.y)) c.height = Math.max(0.6, box.max.y - Math.min(0, box.min.y));
    c.mixer = new THREE.AnimationMixer(c.model);
    // Root motion is already stripped by tools/convert_anims.py; the controller moves us.
    const clips = await locomotionFor(url);
    for (const [role, loco] of Object.entries(clips) as [Role, Loco][]) {
      const a = c.mixer.clipAction(bindable(loco.clip, c.model, url));
      a.setLoop(THREE.LoopRepeat, Infinity);
      c.actions[role] = a;
      if (loco.speed) c.clipSpeed.set(a, loco.speed);
    }
    // Battle models only have run cycles; those get slowed down for walking instead.
    if (!c.actions.walk && !c.actions.run) c.setupProcedural();
    c.head = c.model.getObjectByName('head') ?? null;
    c.mixer.addEventListener('finished', (e) => {
      if (c.motion && e.action === c.motion.action) c.motion.finished = true;
    });
    c.play('idle');
    return c;
  }

  /**
   * Play a story motion clip (Lua playAction) over the locomotion cycle. One-shot clips hold their
   * last pose until stopMotion(); `loop` clips repeat.
   */
  async playMotion(file: string, opts: { loop?: boolean; blend?: number; speed?: number } = {}) {
    const clip = await loadClip(file).catch((e) => {
      warnOnce(`character: /gen/anims/${file} failed to load for ${this.url}: ${e}`);
      return null;
    });
    if (!clip) return false;
    return this.playClip(clip, opts);
  }

  /** playMotion for a clip already in memory (e.g. retargeted onto this model's skeleton). */
  playClip(clip: THREE.AnimationClip, opts: { loop?: boolean; blend?: number; speed?: number } = {}) {
    const action = this.mixer.clipAction(bindable(clip, this.model, this.url));
    const blend = Math.max(0.05, opts.blend ?? 0.2);
    action.reset();
    action.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, opts.loop ? Infinity : 1);
    action.clampWhenFinished = true;
    action.timeScale = opts.speed ?? 1;
    action.setEffectiveWeight(1).fadeIn(blend).play();
    if (this.motion && this.motion.action !== action) this.motion.action.fadeOut(blend);
    else this.currentAction?.fadeOut(blend);
    this.motion = { action, loop: !!opts.loop, finished: false };
    return true;
  }

  /**
   * Play the bones of `file` that match `bones` on top of the base pose (the game's masked action layers).
   * A second mixer runs after the first, so these bones take the layer's pose outright.
   */
  async playLayer(name: string, file: string, bones: RegExp, loop: boolean) {
    const clip = await loadClip(file).catch((e) => {
      warnOnce(`character: layer clip /gen/anims/${file} failed to load for ${this.url}: ${e}`);
      return null;
    });
    if (!clip) return false;
    let tracks = clip.tracks.filter((t) => {
      const node = t.name.slice(0, t.name.lastIndexOf('.'));
      return bones.test(node) && !!this.model.getObjectByName(node) && !t.name.endsWith('.position');
    });
    if (!tracks.length) return false;
    this.stopLayer(name);
    if (!this.layerMixer) {
      this.layerMixer = new THREE.AnimationMixer(this.model);
      this.layerMixer.addEventListener('finished', (e) => {
        for (const l of this.layers.values()) if (l.action === e.action) l.finished = true;
      });
    }
    const action = this.layerMixer.clipAction(new THREE.AnimationClip(`${clip.name}:${name}`, clip.duration, tracks));
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = true;
    action.play();
    this.layers.set(name, { action, loop, finished: false });
    return true;
  }

  stopLayer(name: string) {
    const l = this.layers.get(name);
    if (!l) return;
    l.action.stop();
    this.layerMixer?.uncacheAction(l.action.getClip());
    this.layers.delete(name);
  }

  layerState(name: string) {
    const l = this.layers.get(name);
    if (!l) return 'none';
    if (l.loop) return 'loop';
    return l.finished ? 'finished' : 'playing';
  }

  /** Back to locomotion (Lua stopAction). */
  stopMotion(blend = 0.2) {
    if (!this.motion) return;
    this.motion.action.fadeOut(blend);
    this.motion = null;
    this.current = null;
    this.currentAction = undefined;
  }

  /** 'none' (locomotion), 'playing', 'loop' (a looping motion is running) or 'finished' (holding the last pose). */
  get motionState() {
    if (!this.motion) return 'none';
    if (this.motion.loop) return 'loop';
    return this.motion.finished ? 'finished' : 'playing';
  }

  /** Turn the head toward a world point (Lua lookAtIK); null releases it. */
  lookAt(target: THREE.Vector3 | null) {
    this.lookTarget = target ? target.clone() : null;
  }

  get animationSummary() {
    if (this.procedural) return 'procedural walk (no converted clip)';
    return (Object.entries(this.actions) as [Role, THREE.AnimationAction][])
      .map(([r, a]) => `${r}: ${a.getClip().name}`)
      .join(' · ');
  }

  private setupProcedural() {
    this.procedural = true;
    for (const name of ['left_upleg', 'right_upleg', 'left_leg', 'right_leg', 'left_arm', 'right_arm', 'left_shoulder', 'right_shoulder', 'spine']) {
      const bone = this.model.getObjectByName(name);
      if (bone) this.procBones[name] = { bone, rest: bone.quaternion.clone() };
    }
  }

  private play(role: Role) {
    if (this.current === role) return;
    const next = this.actions[role] ?? (role === 'run' ? this.actions.walk : role === 'walk' ? this.actions.run : undefined);
    const prev = this.currentAction;
    if (next && next !== prev) {
      next.reset().setEffectiveWeight(1).fadeIn(0.18).play();
      prev?.fadeOut(0.18);
      this.currentAction = next;
    }
    this.current = role;
  }

  /** speed in m/s; drives the locomotion state. */
  update(dt: number, speed: number) {
    if (this.motion && speed > 0.15) this.stopMotion(0.15); // walking cancels a held pose
    if (this.motion) {
      this.mixer.update(dt);
      this.layerMixer?.update(dt);
      this.applyLook(dt);
      return;
    }
    const role: Role = speed < 0.15 ? 'idle' : speed > 3.2 ? 'run' : 'walk';
    this.play(role);
    const act = this.currentAction;
    if (act && role !== 'idle') {
      // Match foot speed loosely to ground speed.
      const nominal = this.clipSpeed.get(act) ?? (act === this.actions.run ? 5.5 : 1.42);
      act.timeScale = THREE.MathUtils.clamp(speed / nominal, 0.55, 1.8);
    } else if (act) act.timeScale = 1;
    this.mixer.update(dt);
    this.layerMixer?.update(dt);
    if (this.procedural) this.updateProcedural(dt, speed);
    this.applyLook(dt);
  }

  private applyLook(dt: number) {
    const head = this.head;
    if (!head) return;
    this.lookWeight += ((this.lookTarget ? 1 : 0) - this.lookWeight) * (1 - Math.exp(-dt * 6));
    if (this.lookWeight < 0.01) return;
    const target = this.lookTarget ?? this.lastLook;
    if (!target) return;
    this.lastLook = target;
    // Rotate the animated head so its forward (+Z in model space) points at the target, limited to 70 degrees.
    head.updateWorldMatrix(true, false);
    const headPos = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
    const want = target.clone().sub(headPos).normalize();
    const rootQ = this.root.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ);
    const angle = fwd.angleTo(want);
    if (angle > 0.01) {
      const limited = want.clone();
      if (angle > 1.22) limited.copy(fwd).lerp(want, 1.22 / angle).normalize();
      const delta = new THREE.Quaternion().setFromUnitVectors(fwd, limited);
      const parentQ = head.parent!.getWorldQuaternion(new THREE.Quaternion());
      const worldHead = head.getWorldQuaternion(new THREE.Quaternion());
      const targetWorld = delta.multiply(worldHead);
      const local = parentQ.invert().multiply(targetWorld);
      head.quaternion.slerp(local, this.lookWeight);
    }
  }
  private lastLook: THREE.Vector3 | null = null;

  /** Mounted weapon (battle models). */
  weaponId: string | null = null;
  private weaponParts: THREE.Object3D[] = [];
  private weaponToken = 0;

  async setWeapons(main: WeaponEntry | null, extras: WeaponEntry[], equipPoints: Record<string, string>) {
    const token = ++this.weaponToken;
    const parts: THREE.Object3D[] = [];
    for (const w of [main, ...extras]) {
      if (w) parts.push(...(await attachWeapon(w, this.model, this.mixer, equipPoints).catch((e) => (console.warn('weapon', w.id, e), []))));
    }
    if (token !== this.weaponToken) {
      for (const p of parts) p.removeFromParent();
      return;
    }
    for (const p of this.weaponParts) p.removeFromParent();
    this.weaponParts = parts;
    this.weaponId = main?.id ?? null;
  }

  private updateProcedural(dt: number, speed: number) {
    const amp = Math.min(speed / 3, 1) * 0.6;
    this.phase += dt * (4 + speed * 2.2);
    const s = Math.sin(this.phase);
    const q = new THREE.Quaternion();
    const set = (name: string, axis: THREE.Vector3, angle: number) => {
      const b = this.procBones[name];
      if (!b) return;
      b.bone.quaternion.copy(b.rest).multiply(q.setFromAxisAngle(axis, angle));
    };
    const X = new THREE.Vector3(1, 0, 0);
    const Z = new THREE.Vector3(0, 0, 1);
    set('left_upleg', X, s * amp);
    set('right_upleg', X, -s * amp);
    set('left_leg', X, -Math.max(0, -s) * amp * 1.2);
    set('right_leg', X, -Math.max(0, s) * amp * 1.2);
    set('left_shoulder', Z, -s * amp * 0.5);
    set('right_shoulder', Z, -s * amp * 0.5);
    this.model.position.y = Math.abs(Math.cos(this.phase)) * amp * 0.05;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.layerMixer?.stopAllAction();
    this.root.removeFromParent();
  }
}
