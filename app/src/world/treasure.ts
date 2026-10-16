// Treasure boxes: the TreasureBoxTrigger positions of a content (generated/treasures.json, tools/build_field_objects.py)
// get the game's chest model (object/001: pfb_ob001_001..004, ResourceId of m_dungeon_treasure) whose lid swings open.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF, tryJSON } from '../assets';
import { toToon } from '../render/toon';

type V3 = [number, number, number];

export interface TreasureReward {
  /** m_reward id */
  reward: number;
  /** m_reward.RewardType: 1 item (incl. gil), 3 materia, 10 crystal, 11 instant item, ... */
  type: number;
  /** Id in the table RewardType names (m_item, m_materia, ...). */
  target: number;
  name: string;
  min: number;
  max: number;
  pickup: boolean;
}

export interface TreasureDef {
  dungeon: number | null;
  type: number;
  onlyOnce: boolean;
  lockId: number;
  /** m_dungeon_treasure.ResourceId */
  resource: number;
  /** Node of the chest GLB, e.g. pfb_ob001_001 */
  model: string;
  rewardSet: number | null;
  rewards: TreasureReward[];
}

export interface TreasureSpot {
  id: number;
  node: string;
  position: V3;
  rotY: number;
  active: boolean;
}

interface TreasureFile {
  glb: string;
  sfx: { open?: string; item?: string };
  treasures: Record<string, TreasureDef>;
  maps: Record<string, Record<string, TreasureSpot[]>>;
}

/** What a later inventory feature receives when the player opens a box. */
export interface TreasureEvent {
  treasureId: number;
  def: TreasureDef | null;
  /** The granted rewards with their resolved counts. */
  rewards: (TreasureReward & { count: number })[];
}

let file: Promise<TreasureFile | null> | null = null;
export function treasureFile() {
  file ??= tryJSON<TreasureFile>('/gen/treasures.json');
  return file;
}

/** The boxes placed in a map's content (free roam: its story content, else the first one that has boxes). */
export async function treasureSpots(mapKey: string, content: string | null | undefined, fallback?: string | null) {
  const f = await treasureFile();
  const byContent = f?.maps[mapKey];
  if (!byContent) return [];
  const list = content ? (byContent[content] ?? []) : ((fallback && byContent[fallback]) || Object.values(byContent)[0] || []);
  return list.filter((s) => s.active);
}

export async function treasureEvent(id: number): Promise<TreasureEvent> {
  const f = await treasureFile();
  const def = f?.treasures[String(id)] ?? null;
  return { treasureId: id, def, rewards: (def?.rewards ?? []).map((r) => ({ ...r, count: r.min })) };
}

export function rewardText(e: TreasureEvent) {
  if (!e.rewards.length) return 'Opened a treasure box';
  return `Obtained ${e.rewards.map((r) => `${r.name} ×${r.count.toLocaleString('en-US')}`).join(', ')}`;
}

export async function treasureSounds() {
  return (await treasureFile())?.sfx ?? {};
}

const OPEN_ANGLE = -(110 * Math.PI) / 180;
const OPEN_TIME = 0.75;

class Box {
  readonly root = new THREE.Group();
  private lid: THREE.Object3D | null = null;
  private lidRest = new THREE.Quaternion();
  /** 0 closed .. 1 open */
  amount = 0;
  private from = 0;
  private to = 0;
  private t = 1;

  constructor(
    readonly spot: TreasureSpot,
    model: THREE.Object3D | null,
  ) {
    this.root.name = `treasure:${spot.id}`;
    this.root.position.fromArray(spot.position);
    this.root.rotation.y = (spot.rotY * Math.PI) / 180;
    if (model) {
      this.root.add(model);
      // GLTFLoader renames repeated node names (lid_geo_4), so match the prefix on the chest's direct children.
      this.lid = model.children.find((c) => /^lid_geo/.test(c.name)) ?? null;
      this.lidRest.copy(this.lid?.quaternion ?? this.lidRest);
    } else {
      // The model is missing: a plain crate so the position is still visible.
      this.root.add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x9a7b3a })));
    }
    this.apply();
  }

  get isOpen() {
    return this.to === 1;
  }

  set(open: boolean, animate: boolean) {
    this.from = this.amount;
    this.to = open ? 1 : 0;
    this.t = animate ? 0 : 1;
    if (!animate) this.amount = this.to;
    this.apply();
  }

  update(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / OPEN_TIME);
    // ease out with a little overshoot, like a lid settling against its hinges
    const x = this.t - 1;
    const k = 1 + 2.2 * x * x * x + 1.2 * x * x;
    this.amount = this.from + (this.to - this.from) * k;
    this.apply();
  }

  private apply() {
    if (!this.lid) return;
    // The hinge is the lid node's origin (back edge); the chest faces +Z, so opening tips +Z up around X.
    this.lid.quaternion.copy(this.lidRest).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), OPEN_ANGLE * this.amount));
  }
}

export class TreasureBoxes {
  readonly group = new THREE.Group();
  private boxes = new Map<number, Box>();

  private constructor() {
    this.group.name = 'treasure-boxes';
  }

  /** `isOpen` tells which boxes were opened before: they show open. */
  static async create(spots: TreasureSpot[], isOpen: (id: number) => boolean) {
    const t = new TreasureBoxes();
    const f = await treasureFile();
    if (!f || !spots.length) return t;
    const gltf = await loadGLTF(f.glb).catch(() => null);
    for (const spot of spots) {
      if (t.boxes.has(spot.id)) continue;
      const def = f.treasures[String(spot.id)];
      const src = gltf?.scene.getObjectByName(def?.model ?? 'pfb_ob001_001') ?? gltf?.scene.getObjectByName('pfb_ob001_001') ?? null;
      let model: THREE.Object3D | null = null;
      if (src) {
        model = cloneSkinned(src);
        model.position.set(0, 0, 0);
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.frustumCulled = false;
          m.material = Array.isArray(m.material) ? m.material.map(toToon) : toToon(m.material);
        });
      }
      const box = new Box(spot, model);
      box.set(isOpen(spot.id), false);
      t.boxes.set(spot.id, box);
      t.group.add(box.root);
    }
    return t;
  }

  has(id: number) {
    return this.boxes.has(id);
  }

  open(id: number) {
    this.boxes.get(id)?.set(true, true);
  }

  /** The closed box nearest to `p` within `reach` metres (flat distance), if any. */
  nearest(p: THREE.Vector3, reach = 1.9) {
    let best: Box | null = null;
    let bestD = reach;
    for (const b of this.boxes.values()) {
      if (b.isOpen) continue;
      const d = Math.hypot(b.root.position.x - p.x, b.root.position.z - p.z);
      if (d < bestD && Math.abs(b.root.position.y - p.y) < 2.2) {
        best = b;
        bestD = d;
      }
    }
    return best?.spot ?? null;
  }

  /** Where the boxes not opened yet stand (the field HUD's minimap). */
  closedPositions(): THREE.Vector3[] {
    return [...this.boxes.values()].filter((b) => !b.isOpen).map((b) => b.root.position);
  }

  update(dt: number) {
    for (const b of this.boxes.values()) b.update(dt);
  }

  dispose() {
    this.group.removeFromParent();
    this.boxes.clear();
  }
}
