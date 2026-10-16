import * as THREE from 'three';
import { Character } from '../player/character';
import type { DialogueLine, MapDetail, NpcEntry } from '../types';
import type { CollisionWorld } from './collision';

export interface Npc {
  entry: NpcEntry;
  character: Character;
  lines: DialogueLine[];
  lineIndex: number;
  yaw: number;
}

const MAX_NPCS = 8;

function linesFor(detail: MapDetail, npc: NpcEntry): DialogueLine[] {
  const d = detail.dialogue ?? {};
  const keys = [String(npc.characterId), npc.name, npc.name?.toLowerCase()];
  for (const k of keys) if (k && d[k]?.length) return d[k];
  // Fall back to lines whose speaker matches the NPC name.
  const all = Object.values(d).flat();
  const own = all.filter((l) => l.speaker && npc.name && l.speaker.toLowerCase() === npc.name.toLowerCase());
  return own;
}

/**
 * Places the characters story scripts loaded on this map. Uses scripted coordinates when the data
 * has them; otherwise they stand in a loose ring around the spawn point.
 */
export async function spawnNpcs(
  detail: MapDetail | null,
  spawn: THREE.Vector3,
  world: CollisionWorld | null,
  silhouette: THREE.Color | null,
  exclude: string,
): Promise<Npc[]> {
  const entries = (detail?.npcs ?? []).filter((n) => n.glb && n.glb !== exclude).slice(0, MAX_NPCS);
  const out: Npc[] = [];
  let ring = 0;
  for (const entry of entries) {
    let character: Character;
    try {
      character = await Character.load(entry.glb, { outline: true, silhouette: silhouette ?? undefined });
    } catch (e) {
      console.warn('npc failed', entry.glb, e);
      continue;
    }
    let pos: THREE.Vector3 | null = null;
    let yaw = 0;
    const scripted = entry.positions?.find((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
    if (scripted) {
      pos = new THREE.Vector3(scripted.x, scripted.y, scripted.z);
      // Scripts give rotY in degrees (already mirrored into glTF space by the manifest).
      yaw = THREE.MathUtils.degToRad(scripted.rotY ?? 0);
    }
    if (!pos || (world && !world.groundBelow(pos.clone().add(new THREE.Vector3(0, 1.5, 0)), 4))) {
      // Ring placement, snapped to the floor, skipping spots without ground.
      for (let tries = 0; tries < 12; tries++) {
        const a = ring * 1.1 + 0.6;
        const r = 2.2 + Math.floor(ring / 6) * 1.4;
        ring++;
        const p = new THREE.Vector3(spawn.x + Math.cos(a) * r, spawn.y + 2, spawn.z + Math.sin(a) * r);
        const g = world ? world.groundBelow(p, 5) : p.setY(spawn.y);
        if (g) {
          pos = g;
          yaw = Math.atan2(spawn.x - g.x, spawn.z - g.z);
          break;
        }
      }
    }
    if (!pos) {
      character.dispose();
      continue;
    }
    character.root.position.copy(pos);
    character.root.rotation.y = yaw;
    out.push({ entry, character, lines: detail ? linesFor(detail, entry) : [], lineIndex: 0, yaw });
  }
  return out;
}

export function nearestNpc(npcs: Npc[], p: THREE.Vector3, maxDist = 2.2): Npc | null {
  let best: Npc | null = null;
  let bestD = maxDist;
  for (const n of npcs) {
    const d = n.character.root.position.distanceTo(p);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}
