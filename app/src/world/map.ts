import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fetchJSON, loadGLTF, releaseTextures, tryJSON } from '../assets';
import { gradientEnvironment } from '../render/pbr';
import { gradeFromPost, type GradeParams } from '../render/post';
import { ambientCube, buildShadowProxy, cubeEnvironment, fitSunShadow, loadLightmaps, stageFog, stageSun, type AmbientCube } from '../render/stage';
import { attachStageMaps, releaseStageMaps } from '../render/stagemaps';
import { CHARACTER_FILL, stylizeEnvironment } from '../render/toon';
import type { Layout, MapDetail, MapEntry, StageLighting } from '../types';
import { BackgroundPass, Capture, createDepthMesh } from './capture';
import { CollisionWorld } from './collision';
import { createSky, skyboxFor } from './sky';

export interface Gimmick {
  name: string;
  position: THREE.Vector3;
  clips: Record<string, THREE.AnimationClip>;
  state: 'closed' | 'open';
}

const HIDE_MESH = /(_col$|_col_|collision|^col_|navmesh|camera_area|occluder)/i;

function glbDir(url: string) {
  return url.slice(0, url.lastIndexOf('/') + 1);
}

/** Node index -> Object3D, from GLTFLoader's parser associations. */
function nodeTable(gltf: GLTF) {
  const table = new Map<number, THREE.Object3D>();
  for (const [obj, assoc] of gltf.parser.associations as Map<THREE.Object3D, { nodes?: number }>) {
    if (assoc && typeof assoc.nodes === 'number' && (obj as THREE.Object3D).isObject3D) table.set(assoc.nodes, obj as THREE.Object3D);
  }
  return table;
}

export class GameMap {
  readonly entry: MapEntry;
  readonly group = new THREE.Group();
  detail: MapDetail | null = null;
  layout: Layout | null = null;
  gltf: GLTF | null = null;
  collision: CollisionWorld | null = null;
  captures: Capture[] = [];
  eventCaptures: Capture[] = [];
  background: BackgroundPass | null = null;
  readonly depthMeshes = new THREE.Group();
  readonly areasDebug = new THREE.Group();
  activeCapture: Capture | null = null;
  mixer: THREE.AnimationMixer | null = null;
  gimmicks: Gimmick[] = [];
  /** Gimmick clips by their game name (anim_dungeon_map_0001_prop_gate01_open), for field scripts. */
  readonly clipsByName = new Map<string, { clip: THREE.AnimationClip; gimmick: Gimmick }>();
  spawn = { position: new THREE.Vector3(), yaw: 0, name: 'origin' };
  fallY = -100;
  readonly lights = new THREE.Group();
  sky: THREE.Mesh | null = null;
  /** Ambient colours (already lifted for characters): sky, equator, ground. */
  readonly ambient = { sky: new THREE.Color(), equator: new THREE.Color(), ground: new THREE.Color() };
  private envTexture: THREE.Texture | null = null;
  backgroundColor = new THREE.Color(0x0a0c12);
  private areaBoxes: { camera: string; box: THREE.Box3; inv: THREE.Matrix4 }[] = [];
  private keyLight: THREE.DirectionalLight | null = null;
  private rimLight: THREE.DirectionalLight | null = null;
  /** generated/lighting: the scene's sun, 4-way ambient, fog and post-processing. */
  lighting: StageLighting | null = null;
  /** The scene's realtime sun (3D stages): lights characters and props, casts the shadows. */
  sun: THREE.DirectionalLight | null = null;
  fog: THREE.Fog | null = null;
  /** The post profile's Bloom (Unity URP values), if the scene has one. */
  bloom: { threshold: number; intensity: number; scatter: number } | null = null;
  /** The post profile's colour grading and vignette. */
  grade: GradeParams | null = null;
  /** Stage folder whose normal / occlusion maps this map streamed in. */
  stageMaps: string | null = null;
  private cube: AmbientCube | null = null;
  /** CHARACTER_FILL colour while this map is shown (black on pre-rendered fields: they keep their key light). */
  private readonly fill = new THREE.Color(0, 0, 0);
  /** Environment materials without a lightmap: they take the ambient environment once it exists. */
  private unbaked: THREE.MeshLambertMaterial[] = [];

  get isDungeon() {
    return this.captures.length > 0;
  }

  private constructor(entry: MapEntry) {
    this.entry = entry;
    this.group.name = `map:${entry.key}`;
    this.depthMeshes.name = 'depth-meshes';
    this.areasDebug.name = 'camera-areas';
    this.areasDebug.visible = false;
  }

  static async load(entry: MapEntry, progress: (msg: string) => void): Promise<GameMap> {
    const map = new GameMap(entry);
    progress('Reading map layout…');
    const [layout, detail, lighting] = await Promise.all([
      tryJSON<Layout>(`/gen/layout/${entry.key}.json`),
      tryJSON<MapDetail>(`/gen/maps/${entry.key}.json`),
      tryJSON<StageLighting>(`/gen/lighting/${entry.key}.json`),
    ]);
    map.layout = layout;
    map.detail = detail;
    map.lighting = lighting;
    progress('Loading scene model…');
    try {
      map.gltf = await loadGLTF(entry.glb);
    } catch (e) {
      console.warn('map glb failed', entry.glb, e);
    }
    const scene = map.gltf ? map.gltf.scene.clone(true) : new THREE.Group();
    // The clone keeps the same node order, so rebuild the index table against it.
    const original = map.gltf ? nodeTable(map.gltf) : new Map<number, THREE.Object3D>();
    const nodes = new Map<number, THREE.Object3D>();
    if (map.gltf) {
      const origList: THREE.Object3D[] = [];
      map.gltf.scene.traverse((o) => origList.push(o));
      const cloneList: THREE.Object3D[] = [];
      scene.traverse((o) => cloneList.push(o));
      const pos = new Map(origList.map((o, i) => [o, i]));
      for (const [idx, obj] of original) {
        const i = pos.get(obj);
        if (i !== undefined) nodes.set(idx, cloneList[i]);
      }
    }
    const shadowOnly: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && HIDE_MESH.test(o.name)) o.visible = false;
      // Converter flags (unity_gltf.py v4): inactive GameObjects, disabled or shadow-only renderers.
      const ud = o.userData as { unityActive?: boolean; unityRenderer?: string };
      if (ud.unityActive === false || ud.unityRenderer) o.visible = false;
      if (ud.unityRenderer === 'shadowsOnly' && ud.unityActive !== false && !HIDE_MESH.test(o.name)) shadowOnly.push(o);
      if ((o as THREE.Light).isLight) o.visible = false;
    });
    // Converter v5: baked lightmaps (second UV set) listed in the GLB's root extras.
    const lightmaps = map.gltf ? await loadLightmaps(map.gltf.parser).catch((e) => (console.warn('lightmaps', e), [])) : [];
    map.unbaked = stylizeEnvironment(scene, lightmaps);
    // Shadow-only renderers (off-stage skyline helpers): invisible, but they still throw the sun's shadow.
    const casterOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    for (const o of shadowOnly) {
      o.visible = true;
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = casterOnly;
        m.castShadow = true;
        m.receiveShadow = false;
      });
    }
    map.group.add(scene);

    // Collision
    map.collision = layout ? CollisionWorld.fromLayout(layout) : null;
    if (!map.collision) map.collision = CollisionWorld.fromObject(scene);
    if (map.collision) map.group.add(map.collision.debug);
    if (layout?.fallY !== undefined && layout.fallY !== null) map.fallY = layout.fallY;
    else if (map.collision) map.fallY = map.collision.bounds.min.y - 30;

    // Pre-rendered views
    if (layout?.cameras?.length) {
      for (const def of layout.cameras) {
        if (!def.color || !def.depthA || !def.depthB) continue;
        (def.name.startsWith('ev') ? map.eventCaptures : map.captures).push(new Capture(def));
      }
      // Cutscene-only maps (e.g. dungeon_map_5024) have nothing but event views: walk in those.
      if (!map.captures.length && map.eventCaptures.length) map.captures = map.eventCaptures.splice(0);
      if (map.captures.length) {
        map.background = new BackgroundPass();
        map.group.add(map.background.mesh);
        map.group.add(map.depthMeshes);
        for (const area of layout.cameraAreas) {
          for (const b of area.boxes) {
            const m = new THREE.Matrix4().compose(
              new THREE.Vector3().fromArray(b.center),
              new THREE.Quaternion().fromArray(b.quaternion),
              new THREE.Vector3(1, 1, 1),
            );
            const half = new THREE.Vector3().fromArray(b.size).multiplyScalar(0.5);
            map.areaBoxes.push({ camera: area.camera, box: new THREE.Box3(half.clone().negate(), half), inv: m.clone().invert() });
            const helper = new THREE.Mesh(
              new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]),
              new THREE.MeshBasicMaterial({ color: 0x40c0ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.5 }),
            );
            helper.applyMatrix4(m);
            map.areasDebug.add(helper);
          }
        }
        map.group.add(map.areasDebug);
      }
    }

    map.setupLights();
    if (map.sun) {
      // One merged caster for the static scenery instead of thousands of shadow draws per frame.
      scene.updateMatrixWorld(true);
      const proxy = buildShadowProxy(scene);
      if (proxy) scene.add(proxy);
    }
    // 3D stages: the game's skybox (RenderSettings.m_SkyboxMaterial).
    if (!map.captures.length) {
      const sky = await skyboxFor(entry.key).catch(() => null);
      if (sky) {
        progress('Loading sky…');
        map.sky = await createSky(sky).catch((e) => (console.warn('sky', e), null));
        if (map.sky) map.group.add(map.sky);
      }
    }
    // Normal / occlusion maps stream in behind the first frames; pre-rendered fields only show characters.
    const stageName = /\/scenes\/([^/]+)\//.exec(entry.glb)?.[1];
    if (stageName && !map.captures.length) {
      map.stageMaps = stageName;
      void attachStageMaps(scene, stageName);
    }
    map.pickSpawn();
    progress('Loading gimmicks…');
    await map.loadGimmicks(scene, nodes).catch((e) => console.warn('gimmicks', e));
    if (map.captures.length) {
      progress('Loading pre-rendered backgrounds…');
      const first = map.captureFor(map.spawn.position) ?? map.captures[0];
      await first.load();
      map.activeCapture = first;
      map.background!.setCapture(first);
      // Other views load when the player walks into their camera area (each is ~60 MB on the GPU).
    }
    return map;
  }

  private setupLights() {
    const l = this.lighting;
    const post = l?.post.Bloom;
    const num = (k: string, d: number) => (typeof post?.[k]?.value === 'number' ? (post[k].value as number) : d);
    // Pre-rendered fields are an LDR picture: nothing in them crosses the threshold.
    if (post && !this.captures.length) this.bloom = { threshold: num('threshold', 1), intensity: num('intensity', 0), scatter: num('scatter', 0.7) };
    if (this.bloom && this.bloom.intensity <= 0) this.bloom = null;
    if (!this.captures.length) this.grade = gradeFromPost(l?.post);
    // 3D stages: EC's own sun, 4-way ambient and fog. Pre-rendered fields keep the camera-side key light
    // (their scenery is a picture; only the characters are lit).
    const sun = !this.captures.length ? stageSun(l) : null;
    this.cube = sun ? ambientCube(l) : null;
    if (sun && this.cube) {
      this.sun = sun;
      this.fog = stageFog(l);
      const c = this.cube;
      this.ambient.sky.copy(c.py);
      this.ambient.ground.copy(c.ny);
      this.ambient.equator.copy(c.px).add(c.nx).add(c.pz).add(c.nz).multiplyScalar(0.25);
      // Unity units (no 1/π), tinted like the sun.
      this.fill.copy(sun.color).multiplyScalar((l?.env?.additionalLightPower ?? 0.5) * Math.PI);
      this.lights.add(sun, sun.target);
      this.group.add(this.lights);
      if (this.fog) this.backgroundColor.copy(this.fog.color);
      return;
    }
    const env = this.layout?.environment;
    const sky = new THREE.Color().fromArray(env?.skyColor ?? [0.55, 0.6, 0.7]);
    const ground = new THREE.Color().fromArray(env?.groundColor ?? [0.2, 0.2, 0.25]);
    // Pre-rendered ambient values are dark; lift them so characters read like in the game.
    const lift = (c: THREE.Color, min: number) => {
      const l = Math.max(c.r, c.g, c.b);
      return l < min ? c.clone().multiplyScalar(min / Math.max(l, 0.01)) : c.clone();
    };
    const equator = new THREE.Color().fromArray(env?.equatorColorPlusX ?? [0.4, 0.42, 0.48]);
    this.ambient.sky.copy(lift(sky, 0.75));
    this.ambient.equator.copy(lift(equator, 0.5));
    this.ambient.ground.copy(lift(ground, 0.35));
    const hemi = new THREE.HemisphereLight(this.ambient.sky, this.ambient.ground, 0.9);
    const key = new THREE.DirectionalLight(0xfff4e8, 1.1);
    key.position.set(-3, 8, 4);
    const rim = new THREE.DirectionalLight(0xa0c0ff, 0.35);
    rim.position.set(4, 3, -6);
    this.keyLight = key;
    this.rimLight = rim;
    this.lights.add(hemi, key, rim);
    this.group.add(this.lights);
    if (env?.fogColor) this.backgroundColor.fromArray(env.fogColor).multiplyScalar(0.18);
  }

  /** Is there walkable ground within a couple of metres below `p`? */
  private onGround(p: THREE.Vector3) {
    if (!this.collision) return true;
    return !!this.collision.groundBelow(p.clone().add(new THREE.Vector3(0, 1, 0)), 3);
  }

  private pickSpawn() {
    // Some event maps only carry a placeholder start point at the origin, off the walkable area.
    const sp = this.layout?.startPoints?.find((s) => this.onGround(new THREE.Vector3().fromArray(s.position)));
    if (sp) {
      this.spawn.position.fromArray(sp.position);
      const q = new THREE.Quaternion().fromArray(sp.quaternion);
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      this.spawn.yaw = Math.atan2(fwd.x, fwd.z);
      this.spawn.name = sp.name;
      return;
    }
    // Pre-rendered maps without a usable start point: stand where the first view looks.
    for (const c of this.captures) {
      const ray = new THREE.Ray(c.position.clone(), new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion));
      const hit = this.collision?.raycast(ray, c.far);
      if (hit && this.onGround(hit.point)) {
        this.spawn.position.copy(hit.point);
        this.spawn.yaw = Math.atan2(ray.direction.x, ray.direction.z) + Math.PI;
        this.spawn.name = `view ${c.def.name}`;
        return;
      }
    }
    const db = this.detail?.bounds;
    const b = db ? new THREE.Box3(new THREE.Vector3().fromArray(db.min), new THREE.Vector3().fromArray(db.max)) : (this.collision?.bounds ?? new THREE.Box3().setFromObject(this.group));
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3());
    // Search outward from the centre for walkable ground with headroom.
    for (const r of [0, 2, 4, 8, 12]) {
      for (let a = 0; a < (r ? 8 : 1); a++) {
        const p = new THREE.Vector3(c.x + Math.cos(a) * r, b.max.y + 2, c.z + Math.sin(a) * r);
        const g = this.collision?.groundBelow(p, b.max.y - b.min.y + 4);
        if (g) {
          this.spawn.position.copy(g);
          this.spawn.name = 'centre';
          return;
        }
      }
    }
    this.spawn.position.set(c.x, b.min.y, c.z);
  }

  private async loadGimmicks(scene: THREE.Object3D, nodes: Map<number, THREE.Object3D>) {
    const conv = await tryJSON<{ animations?: { name: string; file: string }[] }>(`${glbDir(this.entry.glb)}conversion.json`);
    const anims = conv?.animations ?? [];
    if (!anims.length) return;
    this.mixer = new THREE.AnimationMixer(scene);
    const groups = new Map<string, Gimmick>();
    for (const a of anims) {
      let gltf: GLTF;
      try {
        gltf = await loadGLTF(glbDir(this.entry.glb) + a.file);
      } catch {
        continue;
      }
      const clip = gltf.animations[0];
      if (!clip) continue;
      const animNodes = nodeTable(gltf);
      const byName = new Map<string, number>();
      for (const [i, o] of animNodes) byName.set(o.name, i);
      const tracks: THREE.KeyframeTrack[] = [];
      let anchor: THREE.Object3D | null = null;
      for (const t of clip.tracks) {
        const dot = t.name.lastIndexOf('.');
        const nodeName = t.name.slice(0, dot);
        const idx = byName.get(nodeName) ?? [...animNodes].find(([, o]) => o.uuid === nodeName)?.[0];
        const target = idx !== undefined ? nodes.get(idx) : undefined;
        if (!target) continue;
        anchor ??= target;
        const nt = t.clone();
        nt.name = `${target.uuid}${t.name.slice(dot)}`;
        tracks.push(nt);
      }
      if (!tracks.length || !anchor) continue;
      const remapped = new THREE.AnimationClip(clip.name || a.name, clip.duration, tracks);
      // anim_<map>_prop_gate01_slow_open -> group "prop_gate01", verb "slow_open"
      const m = /anim_(?:dungeon_map|environment)_\d+_(.+?)_((?:slow_)?(?:open|close|on|off|start|end|lp|loop|idle).*)$/i.exec(a.name);
      const groupName = m ? m[1] : a.name;
      const verb = m ? m[2].toLowerCase() : 'play';
      let g = groups.get(groupName);
      if (!g) {
        const box = new THREE.Box3().setFromObject(anchor);
        const pos = box.isEmpty() ? anchor.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
        g = { name: groupName, position: pos, clips: {}, state: 'closed' };
        groups.set(groupName, g);
      }
      g.clips[verb] = remapped;
      this.clipsByName.set(a.name, { clip: remapped, gimmick: g });
      this.clipsByName.set(a.file.replace(/^.*\//, '').replace(/(_\d+)?\.gltf?$/, ''), { clip: remapped, gimmick: g });
      if (/lp|loop/.test(verb)) this.mixer.clipAction(remapped).play();
    }
    this.gimmicks = [...groups.values()].filter((g) => Object.keys(g.clips).some((v) => !/lp|loop/.test(v)));
  }

  /** Toggle a gimmick (gates, shutters…): plays open/close the way the game would. */
  triggerGimmick(g: Gimmick) {
    if (!this.mixer) return;
    const want = g.state === 'closed' ? ['open', 'slow_open', 'on', 'start', 'play'] : ['close', 'slow_close', 'off', 'end'];
    const verb = want.find((v) => g.clips[v]) ?? Object.keys(g.clips)[0];
    for (const c of Object.values(g.clips)) this.mixer.existingAction(c)?.stop();
    const action = this.mixer.clipAction(g.clips[verb]);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    g.state = g.state === 'closed' ? 'open' : 'closed';
  }

  /**
   * Play a gimmick clip by name (field-script GimmickAnimationBehaviour). `immediate` jumps to its end pose.
   * Returns the clip length in seconds (0 if the clip is unknown).
   */
  playClip(name: string, immediate: boolean) {
    const hit = this.clipsByName.get(name);
    if (!hit || !this.mixer) return 0;
    for (const c of Object.values(hit.gimmick.clips)) if (c !== hit.clip) this.mixer.existingAction(c)?.stop();
    const action = this.mixer.clipAction(hit.clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    if (immediate) {
      action.time = hit.clip.duration;
      this.mixer.update(0);
    }
    hit.gimmick.state = /close|off/i.test(name) ? 'closed' : 'open';
    return immediate ? 0 : hit.clip.duration;
  }

  /** A pre-rendered view by its camera name ("04", "ev_01"). */
  findCapture(name: string) {
    return this.captures.find((c) => c.def.name === name) ?? this.eventCaptures.find((c) => c.def.name === name) ?? null;
  }

  /** dungeon.changeCameraAreaCameraNames: areas that used camera `from` now use `to`. */
  renameAreaCamera(from: string, to: string) {
    for (const a of this.areaBoxes) if (a.camera === from) a.camera = to;
  }

  captureFor(p: THREE.Vector3, current?: Capture | null): Capture | null {
    if (!this.areaBoxes.length) return current ?? null;
    const inside = (a: (typeof this.areaBoxes)[number]) => a.box.containsPoint(p.clone().add(new THREE.Vector3(0, 0.5, 0)).applyMatrix4(a.inv));
    // Stay on the current camera while still inside one of its areas (avoids flicker on overlaps).
    if (current && this.areaBoxes.some((a) => a.camera === current.def.name && inside(a))) return current;
    const hit = this.areaBoxes.find(inside);
    if (!hit) return current ?? null;
    return this.findCapture(hit.camera) ?? current ?? null;
  }

  /** Switch the active pre-rendered view if the player crossed into another camera area. */
  updateArea(p: THREE.Vector3): Capture | null {
    if (!this.captures.length) return null;
    const next = this.captureFor(p, this.activeCapture);
    if (!next || next === this.activeCapture) return null;
    if (!next.ready) {
      void next.load().catch((e) => console.warn('capture', next.def.name, e));
      return null;
    }
    this.activeCapture = next;
    this.background!.setCapture(next);
    return next;
  }

  setCapture(c: Capture) {
    if (!c.ready) return false;
    this.activeCapture = c;
    this.background?.setCapture(c);
    return true;
  }

  /** EC mode shows the exact pre-render; free cameras see depth-reconstructed geometry. */
  setFreeView(free: boolean) {
    if (!this.background) return;
    this.background.mesh.visible = !free;
    this.depthMeshes.visible = free;
    if (free) {
      // Free cameras need every view to rebuild the whole map.
      for (const c of this.captures) {
        if (this.depthMeshes.getObjectByName(`depth-mesh-${c.def.name}`)) continue;
        void c
          .load()
          .then(() => {
            if (!this.depthMeshes.getObjectByName(`depth-mesh-${c.def.name}`)) this.depthMeshes.add(createDepthMesh(c));
          })
          .catch((e) => console.warn('capture', c.def.name, e));
      }
    }
  }

  /** Image-based light for PBR (battle) models, built once per map from its ambient colours. */
  environment(renderer: THREE.WebGLRenderer) {
    if (!this.envTexture) {
      this.envTexture = this.cube ? cubeEnvironment(renderer, this.cube) : gradientEnvironment(renderer, this.ambient.sky, this.ambient.equator, this.ambient.ground);
      // Props without a lightmap take the same ambient as the characters (IBL irradiance; reflectivity is 0).
      for (const m of this.unbaked) {
        m.envMap = this.envTexture;
        m.needsUpdate = true;
      }
    }
    return this.envTexture;
  }

  /**
   * Key light from above-left behind the camera, rim light from behind the subjects: characters read the
   * same from every view (the battle camera looks at the party's backs and the enemies' fronts).
   */
  private aimLights(camera: THREE.Camera) {
    if (!this.keyLight || !this.rimLight) return;
    const fwd = camera.getWorldDirection(new THREE.Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) return;
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    this.keyLight.position.copy(fwd).multiplyScalar(-4).addScaledVector(right, -3).setY(8);
    this.rimLight.position.copy(fwd).multiplyScalar(6).addScaledVector(right, 4).setY(3);
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    this.mixer?.update(dt);
    this.aimLights(camera);
    if (this.sun) fitSunShadow(this.sun, camera);
    CHARACTER_FILL.color.value.copy(this.fill);
    // The scene that shows this map (field or battle) takes its fog.
    const root = this.group.parent as THREE.Scene | null;
    if (root?.isScene && root.fog !== this.fog) root.fog = this.fog;
    if (root?.isScene) root.userData.bloom = this.bloom;
    if (root?.isScene) root.userData.grade = this.grade;
    if (this.background?.mesh.visible) this.background.update(camera);
  }

  dispose() {
    const root = this.group.parent as THREE.Scene | null;
    if (root?.isScene && root.fog === this.fog) root.fog = null;
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.material as THREE.ShaderMaterial).isShaderMaterial) (m.material as THREE.Material).dispose();
      if (m.isMesh && (m.name.startsWith('depth-mesh') || m.name === 'background-pass' || m.name === 'shadow-proxy')) m.geometry.dispose();
    });
    this.envTexture?.dispose();
    if (this.stageMaps) releaseStageMaps(this.stageMaps);
    this.sun?.shadow.map?.dispose();
    if (this.sky) {
      const mat = this.sky.material as THREE.ShaderMaterial;
      (mat.uniforms.cube.value as THREE.Texture).dispose();
      mat.dispose();
    }
    const urls = this.captures.concat(this.eventCaptures).flatMap((c) => [c.def.color, c.def.depthA, c.def.depthB]);
    releaseTextures(urls.filter((u): u is string => !!u));
  }
}

export async function loadMapList(): Promise<MapEntry[]> {
  const list = await tryJSON<MapEntry[] | { maps: MapEntry[] }>('/gen/maps.json');
  if (list) return Array.isArray(list) ? list : list.maps;
  // Fallback before tools/build_manifest.py ran: every layout we extracted.
  const idx = await fetchJSON<string[]>('/gen/layout/index.json').catch(() => [] as string[]);
  return idx.map((key) => ({
    key,
    kind: key.startsWith('dungeon') ? 'dungeon' : 'environment',
    glb: `/lib/unity/scenes/${key}/model.glb`,
    title: key,
    groups: ['Other'],
  }));
}
