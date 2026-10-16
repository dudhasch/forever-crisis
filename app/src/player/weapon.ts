import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF, tryJSON } from '../assets';

/** generated/weapons.json (tools/build_weapons.py). */
export interface WeaponAttach {
  /** rigid: parent to `bone`; skin: rebind the weapon's skinned mesh to the character's bones of the same names. */
  mode: 'rigid' | 'skin';
  point: string;
  bone: string | null;
  /** Hand bone holding the weapon when no battle clip animates `bone`. */
  fallbackBone?: string | null;
  /** Only this node of a multi-part weapon. */
  node?: string | null;
  position?: number[];
  quaternion?: number[];
  scale?: number[];
}

export interface WeaponEntry {
  id: string;
  name: string;
  glb: string;
  rarity?: number;
  rarities?: number[];
  attach: WeaponAttach[];
}

interface ModelInfo {
  equipPoints?: Record<string, string>;
  noEquip?: boolean;
}

export interface WeaponsManifest {
  byCharacter: Record<string, WeaponEntry[]>;
  costumeDefault: Record<string, string>;
  costumeExtras?: Record<string, string[]>;
  models: Record<string, ModelInfo>;
}

let manifest: Promise<WeaponsManifest | null> | null = null;
export function weaponsManifest() {
  manifest ??= tryJSON<WeaponsManifest>('/gen/weapons.json');
  return manifest;
}

/** "/lib/unity/character/001/model/003/model.glb" -> { characterId: "001", battleId: "001/003" } */
export function battleIdOf(url: string) {
  const m = /\/unity\/character\/([^/]+)\/model\/([^/]+)\//.exec(url);
  return m ? { characterId: m[1], battleId: `${m[1]}/${m[2]}` } : null;
}

/** Weapons the given battle model can hold (its own character's), plus its default and built-in extras. */
export async function weaponsFor(url: string) {
  const ids = battleIdOf(url);
  const w = await weaponsManifest();
  if (!ids || !w || w.models[ids.battleId]?.noEquip) return null;
  const list = w.byCharacter[ids.characterId] ?? [];
  const all = Object.values(w.byCharacter).flat();
  const find = (id: string) => list.find((x) => x.id === id) ?? all.find((x) => x.id === id);
  return {
    list,
    defaultId: w.costumeDefault[ids.battleId] ?? null,
    extras: (w.costumeExtras?.[ids.battleId] ?? []).map(find).filter((x): x is WeaponEntry => !!x),
    equipPoints: w.models[ids.battleId]?.equipPoints ?? {},
  };
}

/** Does any running animation clip move this bone? (main_weapon only moves in battle clips.) */
function animated(mixer: THREE.AnimationMixer, root: THREE.Object3D, bone: string) {
  const actions = (mixer as unknown as { _actions: THREE.AnimationAction[] })._actions ?? [];
  return actions.some((a) => a.getRoot() === root && a.getClip().tracks.some((t) => t.name.startsWith(`${bone}.`)));
}

/**
 * Mount a weapon on a battle model. Returns the created objects so they can be removed again.
 */
export async function attachWeapon(
  weapon: WeaponEntry,
  model: THREE.Object3D,
  mixer: THREE.AnimationMixer,
  equipPoints: Record<string, string>,
): Promise<THREE.Object3D[]> {
  const gltf = await loadGLTF(weapon.glb);
  const created: THREE.Object3D[] = [];
  for (const a of weapon.attach) {
    const src = cloneSkinned(gltf.scene);
    const part = a.node ? src.getObjectByName(a.node) : src;
    if (!part) continue;
    part.removeFromParent();
    part.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        m.castShadow = true;
        for (const mat of [m.material].flat()) {
          mat.stencilWrite = true; // keep the occlusion silhouette off the weapon's own pixels
          mat.stencilRef = 1;
          mat.stencilFunc = THREE.AlwaysStencilFunc;
          mat.stencilZPass = THREE.ReplaceStencilOp;
        }
      }
    });
    if (a.mode === 'skin') {
      // Gloves etc.: skinned to a copy of the arm skeleton; use the character's bones instead.
      part.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (!sm.isSkinnedMesh) return;
        const bones = sm.skeleton.bones.map((b) => (model.getObjectByName(b.name) as THREE.Bone | undefined) ?? b);
        sm.bind(new THREE.Skeleton(bones, sm.skeleton.boneInverses), sm.bindMatrix);
      });
      model.add(part);
      created.push(part);
      continue;
    }
    const want = (a.point && equipPoints[a.point]) || a.bone;
    let bone = want ? model.getObjectByName(want) : undefined;
    // main_weapon / sub_weapon only follow the hand in battle clips; otherwise hold it in the hand.
    if (bone && a.fallbackBone && !animated(mixer, model, bone.name)) bone = model.getObjectByName(a.fallbackBone) ?? bone;
    bone ??= a.fallbackBone ? model.getObjectByName(a.fallbackBone) : undefined;
    if (!bone) continue;
    if (a.position) part.position.fromArray(a.position);
    if (a.quaternion) part.quaternion.fromArray(a.quaternion);
    if (a.scale) part.scale.fromArray(a.scale);
    bone.add(part);
    created.push(part);
  }
  return created;
}
