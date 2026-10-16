// Battle models (character/NNN) have their own skeleton (X-forward bone axes, spine1-4); the story-motion clips
// (ladders, jumps, ...) were authored for the questcharacter rig. Re-express a clip's bone rotations on the
// battle skeleton: every bone present in both rigs gets the same world-space rotation change from its rest pose.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { loadGLTF } from '../assets';

const cache = new Map<string, Promise<THREE.AnimationClip>>();
const FPS = 30;

export function retargetClip(clip: THREE.AnimationClip, targetUrl: string, refUrl: string): Promise<THREE.AnimationClip> {
  const key = `${targetUrl}|${refUrl}|${clip.uuid}`;
  let p = cache.get(key);
  if (!p) {
    p = build(clip, targetUrl, refUrl);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}

function nodesOf(root: THREE.Object3D) {
  const out: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o !== root && !(o as THREE.Mesh).isMesh && o.name) out.push(o);
  });
  return out; // traverse is parent-first
}

async function build(clip: THREE.AnimationClip, targetUrl: string, refUrl: string) {
  const [tg, rg] = await Promise.all([loadGLTF(targetUrl), loadGLTF(refUrl)]);
  const target = cloneSkinned(tg.scene);
  const ref = cloneSkinned(rg.scene);
  target.updateMatrixWorld(true);
  ref.updateMatrixWorld(true);

  const tNodes = nodesOf(target);
  const rByName = new Map(nodesOf(ref).map((o) => [o.name, o]));
  const worldQ = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());
  const tRest = new Map(tNodes.map((o) => [o, worldQ(o)]));
  const rRestInv = new Map([...rByName].map(([n, o]) => [n, worldQ(o).invert()]));
  const mapped = tNodes.filter((o) => rByName.has(o.name) && clip.tracks.some((t) => t.name.startsWith(`${o.name}.`)));
  if (!mapped.length) return clip;
  const mappedSet = new Set(mapped);

  // Only tracks whose node exists in the reference model can be played on it.
  const tracks = clip.tracks.filter((t) => ref.getObjectByName(t.name.slice(0, t.name.lastIndexOf('.'))));
  const mixer = new THREE.AnimationMixer(ref);
  mixer.clipAction(new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode)).play();

  const frames = Math.max(2, Math.ceil(clip.duration * FPS) + 1);
  const times = Array.from({ length: frames }, (_, i) => Math.min(clip.duration, i / FPS));
  const values = new Map(mapped.map((o) => [o, new Float32Array(frames * 4)]));
  const result = new Map<THREE.Object3D, THREE.Quaternion>();
  const tmp = new THREE.Quaternion();
  for (let i = 0; i < frames; i++) {
    mixer.setTime(times[i]);
    ref.updateMatrixWorld(true);
    result.clear();
    for (const node of tNodes) {
      const parentW = result.get(node.parent!) ?? tRest.get(node.parent!) ?? worldQ(node.parent!);
      const local = node.quaternion.clone();
      if (mappedSet.has(node)) {
        const delta = worldQ(rByName.get(node.name)!).multiply(rRestInv.get(node.name)!);
        const w = delta.multiply(tRest.get(node)!);
        local.copy(tmp.copy(parentW).invert().multiply(w));
        local.toArray(values.get(node)!, i * 4);
      }
      result.set(node, parentW.clone().multiply(local));
    }
  }
  const out = [...values].map(([node, v]) => new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, Array.from(v)));
  return new THREE.AnimationClip(`${clip.name}:${targetUrl}`, clip.duration, out, clip.blendMode);
}
