import * as THREE from 'three';
import { fetchJSON, tryJSON } from '../assets';
import { assetUrl } from '../platform/source';
import { ParticleSim, type SimFrame } from './sim';
import { buildMaterial, type MaterialTextures } from './shader';
import type { BodyDef, EffectDef, EffectMaterial, MeshData, Renderer, StagePlacement, TexRef } from './types';

/**
 * Plays EC's converted particle prefabs (generated/effects, tools/convert_effects.py).
 *
 * An instance is: root (where the game puts it, three space) -> mirror (scale -1, 1, 1) -> offset (the event's
 * Unity offset / angles / scale) -> the prefab's GameObjects (Unity local transforms) -> one ParticleSim per
 * ParticleSystem, each drawn as one instanced mesh.
 */

const BASE = '/gen/effects/';
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------------------------------- library
interface IndexEntry {
  dur: number;
  loop: number;
  n: number;
}

const texLoader = new THREE.TextureLoader();
const textures = new Map<string, Promise<THREE.Texture | null>>();

function loadFxTexture(ref: TexRef | undefined, color: boolean): Promise<THREE.Texture | null> {
  if (!ref) return Promise.resolve(null);
  const key = `${color ? 'c' : 'd'}:${ref.url}`;
  let p = textures.get(key);
  if (!p) {
    p = texLoader
      .loadAsync(assetUrl(ref.url))
      .then((t) => {
        t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = ref.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        t.anisotropy = 2;
        return t;
      })
      .catch(() => {
        console.warn(`effects: texture ${ref.url} failed to load`);
        return null;
      });
    textures.set(key, p);
  }
  return p;
}

const meshes = new Map<string, Promise<THREE.BufferGeometry | null>>();

function loadMesh(name: string): Promise<THREE.BufferGeometry | null> {
  let p = meshes.get(name);
  if (!p) {
    p = fetchJSON<MeshData>(`${BASE}meshes/${name}.json`)
      .then((m) => meshGeometry(m))
      .catch(() => {
        console.warn(`effects: mesh ${name} failed to load`);
        return null;
      });
    meshes.set(name, p);
  }
  return p;
}

const meshData = new Map<string, Promise<MeshData | null>>();
function loadMeshData(name: string) {
  let p = meshData.get(name);
  if (!p) {
    p = tryJSON<MeshData>(`${BASE}meshes/${name}.json`);
    meshData.set(name, p);
  }
  return p;
}

function meshGeometry(m: MeshData) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.p, 3));
  if (m.n) g.setAttribute('normal', new THREE.Float32BufferAttribute(m.n, 3));
  else g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(m.p.length).fill(0), 3));
  const vc = m.p.length / 3;
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv ?? new Float32Array(vc * 2), 2));
  g.setIndex(m.i);
  return g;
}

let quad: THREE.BufferGeometry | null = null;
function quadGeometry() {
  if (!quad) {
    quad = new THREE.PlaneGeometry(1, 1);
    quad.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  }
  return quad;
}

/** A loaded effect: definition, textures, render geometry and (lazily built) materials. */
interface Loaded {
  def: EffectDef;
  tex: MaterialTextures[];
  geoms: (THREE.BufferGeometry | null)[];
  shapes: (MeshData | null)[];
  materials: Map<string, THREE.ShaderMaterial>;
}

export class EffectLibrary {
  private index: Promise<Record<string, IndexEntry>> | null = null;
  private loaded = new Map<string, Promise<Loaded | null>>();
  private bodies: Promise<Record<string, BodyDef>> | null = null;
  private missing = new Set<string>();

  entries() {
    this.index ??= tryJSON<{ effects: Record<string, IndexEntry> }>(`${BASE}index.json`).then((x) => {
      if (!x) console.warn('effects: generated/effects/index.json missing (npm run extract:effects)');
      return x?.effects ?? {};
    });
    return this.index;
  }

  async has(key: string) {
    return !!(await this.entries())[key];
  }

  bodyDefs() {
    this.bodies ??= tryJSON<{ bodies: Record<string, BodyDef> }>(`${BASE}bodies.json`).then((x) => x?.bodies ?? {});
    return this.bodies;
  }

  /** Body (attach points) of a battle model url ("/lib/unity/character/001/model/003/model.glb"). */
  async body(url: string): Promise<BodyDef | null> {
    const m = /(character|monster)\/(\d+)\/model\/(\d+)\//.exec(url);
    if (!m) return null;
    const all = await this.bodyDefs();
    return all[`${m[1]}/${m[2]}/${m[3]}`] ?? all[`${m[1]}/${m[2]}/001`] ?? null;
  }

  load(key: string): Promise<Loaded | null> {
    let p = this.loaded.get(key);
    if (!p) {
      p = (async () => {
        if (!(await this.has(key))) {
          if (!this.missing.has(key)) {
            this.missing.add(key);
            console.warn(`effects: ${key} is not converted (tools/convert_effects.py)`);
          }
          return null;
        }
        const def = await fetchJSON<EffectDef>(`${BASE}${key}.json`).catch(() => null);
        if (!def) {
          console.warn(`effects: ${BASE}${key}.json failed to load`);
          return null;
        }
        return prepare(def);
      })();
      this.loaded.set(key, p);
    }
    return p;
  }
}

async function prepare(def: EffectDef): Promise<Loaded> {
  const tex = await Promise.all(
    def.mats.map(async (m: EffectMaterial) => {
      const [map, mask, dist, emis, dissolve] = await Promise.all([
        loadFxTexture(m.tex, true),
        loadFxTexture(m.mask, false),
        loadFxTexture(m.dist, false),
        loadFxTexture(m.emis, true),
        loadFxTexture(m.dissolveTex, false),
      ]);
      return { map, mask, dist, emis, dissolve };
    }),
  );
  const geoms = await Promise.all(
    def.systems.map((s) => (s.r.mode === 4 ? (s.r.meshes?.[0] ? loadMesh(s.r.meshes[0]) : Promise.resolve(null)) : Promise.resolve(quadGeometry()))),
  );
  const shapes = await Promise.all(def.systems.map((s) => (s.shape?.mesh ? loadMeshData(s.shape.mesh) : Promise.resolve(null))));
  return { def, tex, geoms, shapes, materials: new Map() };
}

const fogIds = new WeakMap<object, number>();
let fogCount = 0;
function fogId(fog: THREE.Fog | THREE.FogExp2 | null) {
  if (!fog) return 0;
  let id = fogIds.get(fog);
  if (id === undefined) {
    id = ++fogCount;
    fogIds.set(fog, id);
  }
  return id;
}

function materialFor(l: Loaded, matIndex: number, r: Renderer, fog: THREE.Fog | THREE.FogExp2 | null) {
  const key = `${matIndex}:${r.mode}:${r.align ?? 0}:${r.len ?? 1}:${r.vel ?? 0}:${r.pivot?.join(',') ?? ''}:${fogId(fog)}`;
  let m = l.materials.get(key);
  if (!m) {
    const em = l.def.mats[matIndex];
    m = buildMaterial(em, r, l.tex[matIndex], fog);
    m.userData.queue = em.queue ?? 3000;
    l.materials.set(key, m);
  }
  return m;
}

// ------------------------------------------------------------------------------------------- instances
export interface Placement {
  /** Follow this object every frame (EC's _trace), else take its pose once. */
  anchor?: THREE.Object3D;
  follow?: boolean;
  /** Pose in three space when there is no anchor (or added to it with `anchorOffset`). */
  position?: THREE.Vector3;
  quaternion?: THREE.Quaternion;
  /** Unity-space offset / Euler angles (degrees) / scale applied under the mirror, like the game's events. */
  offset?: number[];
  angles?: number[];
  scale?: number[] | number;
  /** Stop emitting after this many seconds (loop events). */
  duration?: number;
  prewarm?: boolean;
  /** Scale over time: samples over `scaleDuration` seconds. */
  scaleCurve?: number[];
  scaleDuration?: number;
  /** Ambient: keep looping forever. */
  ambient?: boolean;
}

export class EffectInstance {
  readonly root = new THREE.Group();
  readonly offset = new THREE.Group();
  private mirror = new THREE.Group();
  private nodes: THREE.Object3D[] = [];
  private sims: (ParticleSim | null)[] = [];
  private frames: SimFrame[] = [];
  private age = 0;
  private stopped = false;
  private baseScale = new THREE.Vector3(1, 1, 1);
  readonly key: string;
  done = false;

  constructor(
    l: Loaded,
    private place: Placement,
    fog: THREE.Fog | THREE.FogExp2 | null,
    group: THREE.Group,
  ) {
    const def = l.def;
    this.key = def.key;
    this.root.name = `fx:${def.key}`;
    this.mirror.scale.set(-1, 1, 1);
    this.root.add(this.mirror);
    this.mirror.add(this.offset);
    const o = place.offset;
    if (o) this.offset.position.set(o[0], o[1], o[2]);
    if (place.angles) this.offset.quaternion.setFromEuler(new THREE.Euler(place.angles[0] * DEG, place.angles[1] * DEG, place.angles[2] * DEG, 'YXZ'));
    const s = place.scale;
    if (s !== undefined) {
      if (typeof s === 'number') this.offset.scale.setScalar(s);
      else this.offset.scale.set(s[0], s[1], s[2]);
    }
    this.baseScale.copy(this.offset.scale);
    const active: boolean[] = [];
    def.nodes.forEach((n) => {
      const obj = new THREE.Object3D();
      obj.name = n.n;
      if (n.t) obj.position.set(n.t[0], n.t[1], n.t[2]);
      if (n.r) obj.quaternion.set(n.r[0], n.r[1], n.r[2], n.r[3]);
      if (n.s) obj.scale.set(n.s[0], n.s[1], n.s[2]);
      (n.p < 0 ? this.offset : this.nodes[n.p]).add(obj);
      this.nodes.push(obj);
      active.push(!n.off && (n.p < 0 || active[n.p]));
    });
    const seed = (Math.random() * 1e9) | 0;
    def.systems.forEach((sd, i) => {
      if (!active[sd.node]) {
        this.sims.push(null);
        return;
      }
      const r = sd.r;
      // EC's GrabPass distortion (heat haze) refracts the frame behind it; it is not drawn here
      const drawn = !r.off && r.mode !== 5 && r.mat !== null && r.mat !== undefined && !!l.geoms[i] && def.mats[r.mat].shader !== 'distort';
      const mat = drawn ? materialFor(l, r.mat as number, r, fog) : null;
      const tm = sd.trail && r.trailMat !== null && r.trailMat !== undefined && def.mats[r.trailMat]?.shader !== 'distort'
        ? materialFor(l, r.trailMat, { ...r, mode: 6, align: 0 }, fog)
        : null;
      const sim = new ParticleSim(sd, mat, drawn ? l.geoms[i] : null, l.shapes[i], seed + i * 7919, tm);
      if (sim.mesh) group.add(sim.mesh);
      if (sim.trails) group.add(sim.trails.mesh);
      this.sims.push(sim);
    });
    // sub emitters
    def.systems.forEach((sd, i) => {
      const sim = this.sims[i];
      if (!sim) return;
      for (const sb of sd.sub ?? []) {
        const child = this.sims[sb.ps];
        if (child) sim.subs.push({ sim: child, type: sb.type, props: sb.props, prob: sb.prob });
      }
    });
    this.frames = this.sims.map(() => ({ l2w: new THREE.Matrix4(), w2l: new THREE.Matrix4(), nodeWorld: new THREE.Matrix4(), scale: 1 }));
    group.add(this.root);
    this.pose();
    if (place.prewarm || place.ambient) {
      this.updateFrames();
      this.sims.forEach((sim, i) => {
        if (sim && sim.def.loop && (sim.def.prewarm || place.ambient)) sim.prewarm(this.frames[i]);
      });
    }
  }

  /** Root pose from the anchor (once, or every frame when following). */
  private pose() {
    const p = this.place;
    if (p.anchor) {
      p.anchor.updateWorldMatrix(true, false);
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const sc = new THREE.Vector3();
      p.anchor.matrixWorld.decompose(pos, q, sc);
      this.root.position.copy(pos);
      this.root.quaternion.copy(q);
      if (p.position) this.root.position.add(p.position);
      if (p.quaternion) this.root.quaternion.multiply(p.quaternion);
    } else {
      if (p.position) this.root.position.copy(p.position);
      if (p.quaternion) this.root.quaternion.copy(p.quaternion);
    }
  }

  private updateFrames() {
    this.root.updateMatrixWorld(true);
    this.sims.forEach((sim, i) => {
      if (!sim) return;
      const f = this.frames[i];
      const node = this.nodes[sim.def.node];
      f.nodeWorld.copy(node.matrixWorld);
      f.l2w.multiplyMatrices(MIRROR, node.matrixWorld);
      f.w2l.copy(f.l2w).invert();
      f.scale = node.matrixWorld.getMaxScaleOnAxis();
      sim.frame = f;
    });
  }

  /** Stop emitting; live particles finish their lives. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sims) if (s) s.playing = false;
  }

  /** Move a non-following instance (projectiles). */
  moveTo(pos: THREE.Vector3, q?: THREE.Quaternion) {
    this.place.anchor = undefined;
    this.place.position = pos.clone();
    if (q) this.place.quaternion = q.clone();
    this.pose();
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.done) return;
    this.age += dt;
    if (this.place.follow && this.place.anchor) this.pose();
    if (this.place.scaleCurve && this.place.scaleCurve.length) {
      const c = this.place.scaleCurve;
      const x = Math.min(1, this.age / Math.max(0.01, this.place.scaleDuration ?? 1)) * (c.length - 1);
      const i = Math.min(c.length - 2, Math.floor(x));
      const k = c[i] + (c[i + 1] - c[i]) * (x - i);
      this.offset.scale.copy(this.baseScale).multiplyScalar(Math.max(0, k));
    }
    if (!this.place.ambient && this.place.duration !== undefined && this.age >= this.place.duration) this.stop();
    this.updateFrames();
    let alive = false;
    this.sims.forEach((sim, i) => {
      if (!sim) return;
      sim.update(dt, this.frames[i], camera);
      if (!sim.done) alive = true;
    });
    // safety net: nothing EC plays per action runs for half a minute
    if (!alive || (!this.place.ambient && this.age > 30)) this.dispose();
  }

  dispose() {
    this.done = true;
    for (const s of this.sims) s?.dispose();
    this.sims = [];
    this.root.removeFromParent();
  }
}

// ------------------------------------------------------------------------------------------- player
export const effectLibrary = new EffectLibrary();

/** Owns the live effect instances of one scene (a battle, a field map). */
export class EffectPlayer {
  readonly group = new THREE.Group();
  private instances: EffectInstance[] = [];
  fog: THREE.Fog | THREE.FogExp2 | null = null;
  /** Particles alive last frame (debug / perf HUD). */
  stats = { instances: 0 };

  constructor(readonly library = effectLibrary) {
    this.group.name = 'ec-effects';
  }

  /** Start loading effects so they play on time later. */
  preload(keys: Iterable<string>) {
    return Promise.all([...keys].map((k) => this.library.load(k)));
  }

  async spawn(key: string, place: Placement): Promise<EffectInstance | null> {
    const l = await this.library.load(key);
    if (!l) return null;
    const inst = new EffectInstance(l, place, this.fog, this.group);
    this.instances.push(inst);
    return inst;
  }

  /** Spawn from an already loaded definition (stage ambience carries its own). */
  spawnDef(def: EffectDef, place: Placement): Promise<EffectInstance> {
    return prepare(def).then((l) => {
      const inst = new EffectInstance(l, place, this.fog, this.group);
      this.instances.push(inst);
      return inst;
    });
  }

  update(dt: number, camera: THREE.Camera) {
    for (const i of this.instances) i.update(dt, camera);
    if (this.instances.some((i) => i.done)) this.instances = this.instances.filter((i) => !i.done);
    this.stats.instances = this.instances.length;
  }

  stopAll() {
    for (const i of this.instances) i.stop();
  }

  dispose() {
    for (const i of this.instances) i.dispose();
    this.instances = [];
    this.group.removeFromParent();
  }
}

// ------------------------------------------------------------------------------------------- ambience
/**
 * Loop the ambient effects EC places in a battle scene (FieldEffect components): smoke, light shafts, glows.
 * Positions are Unity world; the stage GLB sits at the origin with x mirrored, like these.
 */
export function playStageAmbience(player: EffectPlayer, environment: number): Promise<number> {
  return playPlacements(player, `${BASE}stages/${String(environment).padStart(4, '0')}.json`);
}

/**
 * Ambient particles of a walkable map: an environment_NNNN scene's FieldEffects, or the particle systems placed in a
 * dungeon_map scene (fires, steam, sparks; generated/effects/fields/<key>.json).
 */
export function playMapAmbience(player: EffectPlayer, mapKey: string): Promise<number> {
  const m = /^environment_(\d+)$/.exec(mapKey);
  if (m) return playStageAmbience(player, Number(m[1]));
  return playPlacements(player, `${BASE}fields/${mapKey}.json`);
}

async function playPlacements(player: EffectPlayer, url: string): Promise<number> {
  const idx = await tryJSON<{ effects: StagePlacement[] }>(url);
  if (!idx?.effects?.length) return 0;
  let n = 0;
  await Promise.all(
    idx.effects.map(async (e) => {
      const pos = new THREE.Vector3(-e.t[0], e.t[1], e.t[2]);
      const q = new THREE.Quaternion(e.r[0], -e.r[1], -e.r[2], e.r[3]);
      await player.spawnDef(e.fx, { position: pos, quaternion: q, scale: e.s, ambient: true, prewarm: true });
      n++;
    }),
  );
  return n;
}
