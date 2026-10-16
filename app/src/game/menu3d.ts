import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF } from '../assets';
import { Character } from '../player/character';
import { weaponsFor, weaponsManifest, type WeaponEntry } from '../player/weapon';
import { h } from '../ui';
import { motionReduced } from '../ui/kit';

/**
 * Live 3D for the menus: party portraits (the battle models in their equipped outfits, idling) and the turning
 * weapon / materia of Materia & Equipment. One WebGL canvas covers the menu; every view is drawn into the screen
 * rectangle of its DOM element (scissor), so the panels lay the views out with plain CSS.
 */
export interface MenuView {
  /** The element whose box the view is drawn into. */
  readonly el: HTMLElement;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Metal and glass want reflections: the stage gives the view's scene its studio environment map. */
  readonly reflective?: boolean;
  update(dt: number): void;
  dispose(): void;
}

export class MenuStage {
  readonly canvas = h('canvas', { class: 'gmr-3d' });
  private renderer: THREE.WebGLRenderer | null = null;
  private views = new Set<MenuView>();
  private raf = 0;
  private last = 0;
  private size = new THREE.Vector2();
  private env: THREE.Texture | null = null;

  add<V extends MenuView>(v: V): V {
    this.views.add(v);
    return v;
  }

  remove(v: MenuView | null | undefined) {
    if (!v) return;
    this.views.delete(v);
    v.dispose();
  }

  clear() {
    for (const v of this.views) v.dispose();
    this.views.clear();
  }

  start() {
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      } catch {
        return; // no WebGL: the panels still work, just without the 3D
      }
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.renderer.setScissorTest(true);
      this.renderer.setClearColor(0x000000, 0);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const r = this.renderer;
    if (!r || document.hidden) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    if (!w || !hh) return;
    r.getSize(this.size);
    if (this.size.x !== w || this.size.y !== hh || r.getPixelRatio() !== dpr) {
      r.setPixelRatio(dpr);
      r.setSize(w, hh, false);
    }
    r.setScissor(0, 0, w, hh);
    r.clear();
    const box = this.canvas.getBoundingClientRect();
    for (const v of this.views) {
      if (v.reflective && !v.scene.environment) v.scene.environment = this.env;
      v.update(dt);
      const e = v.el.getBoundingClientRect();
      if (!v.el.isConnected || e.width < 2 || e.height < 2) continue;
      const x = e.left - box.left;
      const y = hh - (e.bottom - box.top);
      if (x > w || y > hh || x + e.width < 0 || y + e.height < 0) continue;
      // the element's own opacity (enter / exit transitions) fades the view with it
      const op = Number(getComputedStyle(v.el).opacity);
      if (op < 0.02) continue;
      r.setViewport(x, y, e.width, e.height);
      r.setScissor(x, y, e.width, e.height);
      v.camera.aspect = e.width / e.height;
      v.camera.updateProjectionMatrix();
      r.render(v.scene, v.camera);
    }
  };
}

/** Move the camera back until a `size`-unit object fits the view box both ways. */
function fit(cam: THREE.PerspectiveCamera, el: HTMLElement, size: number, y: number, lookY: number) {
  const aspect = el.clientWidth / Math.max(1, el.clientHeight) || 1;
  const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  const d = size / 2 / t / Math.min(1, aspect);
  cam.position.set(0, y, d);
  cam.lookAt(0, lookY, 0);
}

/** Soft studio light: blue-ish sky fill, a warm key from the front left and a cyan rim from behind. */
function lights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a2440, 1.4));
  const key = new THREE.DirectionalLight(0xfff4e8, 2.3);
  key.position.set(-1.2, 2.2, 2.4);
  const rim = new THREE.DirectionalLight(0x7fd8ff, 2.2);
  rim.position.set(1.6, 1.4, -2);
  scene.add(key, rim);
}

let discTex: THREE.Texture | null = null;

/** The kit's equipment disc (public/ui/disc.png, drawn in GIMP) as a glowing floor plate under a showcase. */
function disc(radius: number) {
  discTex ??= new THREE.TextureLoader().load('/ui/disc.png', (t) => (t.colorSpace = THREE.SRGBColorSpace));
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: discTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -1;
  return m;
}

const characters = new Map<string, Promise<Character>>();

/** A battle model with its weapon, cached per model + weapon (a portrait reopens instantly). */
function loadCharacter(model: string, weapon: string | null): Promise<Character> {
  const k = `${model}|${weapon ?? ''}`;
  let p = characters.get(k);
  if (!p) {
    p = (async () => {
      const c = await Character.load(model);
      const info = await weaponsFor(model);
      if (info) {
        const main = weapon ? (info.list.find((w) => w.id === weapon || w.glb === weapon) ?? null) : (info.list.find((w) => w.id === info.defaultId) ?? null);
        await c.setWeapons(main, info.extras, info.equipPoints);
      }
      return c;
    })();
    p.catch(() => characters.delete(k));
    characters.set(k, p);
  }
  return p;
}

/**
 * A character portrait: the model idling, framed from the head down to `span` of its height. `turn` faces it a
 * little towards the screen centre, like the Remake's lineup.
 */
export class PortraitView implements MenuView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(20, 0.5, 0.05, 50);
  private char: Character | null = null;
  private disposed = false;
  private plate: THREE.Mesh | null = null;
  private posed = false;

  constructor(
    readonly el: HTMLElement,
    model: string,
    weapon: string | null,
    private opts: { span?: number; turn?: number; lift?: number; disc?: boolean } = {},
  ) {
    lights(this.scene);
    if (opts.disc) {
      this.plate = disc(0.75);
      this.scene.add(this.plate);
    }
    void loadCharacter(model, weapon)
      .then((c) => {
        if (this.disposed) return;
        this.char = c;
        c.root.position.set(0, 0, 0);
        c.root.rotation.set(0, opts.turn ?? 0, 0);
        this.scene.add(c.root);
        this.frame();
      })
      .catch((e) => console.warn('menu portrait', model, e));
  }

  private frame() {
    const c = this.char;
    if (!c) return;
    const hgt = c.height;
    const span = (this.opts.span ?? 0.62) * hgt;
    const top = hgt * (1.07 + (this.opts.lift ?? 0));
    const mid = top - span / 2;
    const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.set(0, mid, dist);
    this.camera.lookAt(0, mid, 0);
  }

  update(dt: number) {
    if (!this.char) return;
    // the shared Character may also be in another view; only the latest one drives it
    if (this.char.root.parent !== this.scene) this.scene.add(this.char.root);
    // reduced motion: settle into the idle pose once (its fade-in needs time), then hold still
    if (!motionReduced()) this.char.update(dt, 0);
    else if (!this.posed) this.char.update(0.6, 0);
    this.posed = true;
    if (this.plate && !motionReduced()) this.plate.rotation.z += dt * 0.15;
  }

  dispose() {
    this.disposed = true;
    this.char?.root.removeFromParent();
  }
}

let weaponEntries: Promise<Map<string, WeaponEntry>> | null = null;
function weaponEntry(id: string) {
  weaponEntries ??= weaponsManifest().then((m) => new Map(Object.values(m?.byCharacter ?? {}).flat().map((w) => [w.id, w])));
  return weaponEntries.then((m) => m.get(id) ?? null);
}

/** A weapon turning slowly over the equipment disc (still with reduced motion). */
export class WeaponView implements MenuView {
  readonly scene = new THREE.Scene();
  readonly reflective = true;
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  private pivot = new THREE.Group();
  private plate = disc(1.3);
  private t = 0;
  private disposed = false;

  constructor(
    readonly el: HTMLElement,
    weaponId: string,
  ) {
    lights(this.scene);
    this.scene.add(this.pivot, this.plate);
    this.plate.position.y = -1.15;
    this.camera.position.set(0, 0.35, 3.4);
    this.camera.lookAt(0, -0.1, 0);
    void weaponEntry(weaponId)
      .then((w) => (w ? loadGLTF(w.glb) : null))
      .then((g) => {
        if (!g || this.disposed) return;
        const obj = cloneSkinned(g.scene);
        obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.frustumCulled = false;
        });
        // centre it and fit its longest side to the view, standing diagonally like the Remake's showcase
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const centre = box.getCenter(new THREE.Vector3());
        obj.position.sub(centre);
        const holder = new THREE.Group();
        holder.add(obj);
        const long = Math.max(size.x, size.y, size.z) || 1;
        holder.scale.setScalar(2.1 / long);
        // lay the longest axis along Y, then tilt it
        if (size.x === long) holder.rotation.z = Math.PI / 2;
        else if (size.z === long) holder.rotation.x = Math.PI / 2;
        const tilt = new THREE.Group();
        tilt.add(holder);
        tilt.rotation.z = -0.62;
        this.pivot.add(tilt);
      })
      .catch((e) => console.warn('menu weapon', weaponId, e));
  }

  update(dt: number) {
    if (!motionReduced()) this.t += dt;
    fit(this.camera, this.el, 2.7, 0.3, -0.1);
    this.pivot.rotation.y = 0.5 + this.t * 0.6;
    this.pivot.position.y = motionReduced() ? 0 : Math.sin(this.t * 1.3) * 0.04;
    this.plate.rotation.z = this.t * 0.15;
  }

  dispose() {
    this.disposed = true;
  }
}

const MATERIA_RGB: Record<string, number> = { green: 0x2bd46a, blue: 0x3a8cff, red: 0xff3a3a, yellow: 0xffd23a, purple: 0xb05cff };

/** A materia orb: a glossy, glowing glass sphere, turning. */
export class OrbView implements MenuView {
  readonly scene = new THREE.Scene();
  readonly reflective = true;
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  private orb: THREE.Mesh;
  private plate = disc(1.1);
  private t = 0;

  constructor(
    readonly el: HTMLElement,
    color: string,
  ) {
    lights(this.scene);
    const c = new THREE.Color(MATERIA_RGB[color] ?? MATERIA_RGB.green);
    const mat = new THREE.MeshPhysicalMaterial({
      color: c.clone().multiplyScalar(0.55),
      emissive: c.clone().multiplyScalar(0.22),
      roughness: 0.12,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 0.8,
    });
    this.orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 48, 32), mat);
    // a brighter swirl seen through the glass
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.35), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.orb.add(core);
    this.scene.add(this.orb, this.plate);
    this.plate.position.y = -0.85;
    this.camera.position.set(0, 0.45, 4.6);
    this.camera.lookAt(0, -0.15, 0);
  }

  update(dt: number) {
    if (!motionReduced()) this.t += dt;
    fit(this.camera, this.el, 2.3, 0.45, -0.15);
    this.orb.rotation.y = this.t * 0.8;
    this.orb.position.y = motionReduced() ? 0 : Math.sin(this.t * 1.5) * 0.05;
    this.plate.rotation.z = this.t * 0.15;
  }

  dispose() {
    this.orb.geometry.dispose();
  }
}
