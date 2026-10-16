// Ladders and jumps: the game's TransportTrigger components (generated/transports.json, tools/build_field_objects.py).
// A ladder is a "reach loop" action: walk to the start point, play the body's ladder_{up,down}_01 In clip, repeat
// the Loop clip until the height is covered, play Out, then walk to the end target. A jump is a "move" action:
// In clip, an arc over the trigger's forward/height curves with the Loop clip, then Out.
import * as THREE from 'three';
import { tryJSON } from '../assets';
import { loadClip, type Character } from '../player/character';
import { retargetClip } from '../player/retarget';
import type { SoundEffects } from '../story/overlay';
import type { CharacterController } from './collision';

type V3 = [number, number, number];

export interface TransportDef {
  id: number;
  name: string;
  /** ladder_up_01 | ladder_down_01 | jump_01 | slider_01 | lift_01 */
  action: string | null;
  behaviour: 'ReachLoopActionBehaviour' | 'MoveActionBehaviour' | null;
  /** Fires when the player walks in (jumps) instead of waiting for the interact key (ladders). */
  auto: boolean;
  priority: number;
  /** Trigger sphere (three.js space). */
  position: V3;
  radius: number;
  rotY: number;
  /** Where the character is positioned before the action (duration < 0: fire from where the player stands). */
  start: { position: V3; rotY: number; duration: number };
  endPosition: V3;
  speed: number;
  effectiveDistanceY: number;
  se: string | null;
  endActionOffset: V3;
  /** Walk here after the action. */
  endTarget?: V3;
  active: boolean;
  /** [time, value, inSlope, outSlope] keys (MoveActionBehaviour). */
  move?: { duration: number; forward: number[][]; height: number[][] };
}

type TransportFile = Record<string, TransportDef[]> & { _audio?: Record<string, Record<string, string[]>> };
let file: Promise<TransportFile | null> | null = null;
function transportFile() {
  file ??= tryJSON<TransportFile>('/gen/transports.json');
  return file;
}

export async function loadTransports(mapKey: string): Promise<TransportDef[]> {
  const f = await transportFile();
  const list = f?.[mapKey];
  return Array.isArray(list) ? list.filter((t) => t.active && (t.action?.startsWith('ladder_') || t.action === 'jump_01')) : [];
}

// ------------------------------------------------------------------------------------------- body clips

interface ClipRef {
  file: string;
  duration: number;
}
interface BodyAction {
  in?: ClipRef;
  loop?: ClipRef;
  out?: ClipRef;
  rootOffsetIn?: V3;
  rootOffsetLoop?: V3;
  rootOffsetOut?: V3;
}
interface ActionsFile {
  bodies: Record<string, Record<string, BodyAction>>;
  questcharacters: Record<string, { models: Record<string, { body: string }> }>;
}
let actionsFile: Promise<ActionsFile | null> | null = null;

/** "/lib/unity/questcharacter/001/model/002/model.glb" -> the body type (male, female, malehigh, fat, ...). */
export async function bodyOf(url: string) {
  const a = await (actionsFile ??= tryJSON<ActionsFile>('/gen/scripts/actions.json'));
  const q = /unity\/questcharacter\/([^/]+)\/model\/([^/]+)\//.exec(url);
  const b = /unity\/character\/([^/]+)\//.exec(url); // battle model: the same character's story model
  const id = q?.[1] ?? b?.[1];
  const models = id ? a?.questcharacters[id]?.models : undefined;
  const entry = (q && models?.[q[2]]) ?? models?.['001'] ?? Object.values(models ?? {})[0];
  // The story model whose skeleton the body clips were authored for (battle models retarget from it).
  const modelId = models ? (models['001'] ? '001' : Object.keys(models)[0]) : undefined;
  const refs = [id && modelId ? `/lib/unity/questcharacter/${id}/model/${modelId}/model.glb` : null, '/lib/unity/questcharacter/001/model/001/model.glb'];
  return { body: entry?.body && a?.bodies[entry.body] ? entry.body : 'male', actions: a, refs: refs.filter((r): r is string => !!r) };
}

const stripUrl = (u: string) => u.replace(/^\/gen\/anims\//, '');
const sheetOf = (body: string) => (body === 'female' ? 'woman' : body === 'fat' || body === 'malehigh' ? 'bigman' : 'man');

// ------------------------------------------------------------------------------------------- curves

/** Unity AnimationCurve with two Hermite keys: [time, value, inSlope, outSlope]. */
function evalCurve(keys: number[][] | undefined, t: number) {
  if (!keys || keys.length < 2) return Math.min(1, Math.max(0, t));
  const [k0, k1] = [keys[0], keys[keys.length - 1]];
  const dt = k1[0] - k0[0];
  if (dt <= 0) return k1[1];
  const x = Math.min(1, Math.max(0, (t - k0[0]) / dt));
  const x2 = x * x;
  const x3 = x2 * x;
  return (2 * x3 - 3 * x2 + 1) * k0[1] + (x3 - 2 * x2 + x) * dt * k0[3] + (-2 * x3 + 3 * x2) * k1[1] + (x3 - x2) * dt * k1[2];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const DEG = Math.PI / 180;
const WALK = 1.9;

// ------------------------------------------------------------------------------------------- the run

export interface TransportHost {
  character: Character;
  controller: CharacterController;
  sfx: SoundEffects;
  /** The player's facing (radians, live). */
  heading: { value: number };
}

interface Phase {
  name: 'position' | 'in' | 'loop' | 'out' | 'walk';
  dur: number;
  begin?: () => void;
  /** t in 0..1 */
  apply: (t: number, dt: number) => void;
}

export class TransportRun {
  private phases: Phase[] = [];
  private clips: Partial<Record<'in' | 'loop' | 'out', THREE.AnimationClip>> = {};
  private index = -1;
  private t = 0;
  /** Ground speed for the character's locomotion animation (the walk-off at the end). */
  speed = 0;
  done = false;

  private constructor(
    readonly def: TransportDef,
    private host: TransportHost,
    private audio: string[],
  ) {}

  /** Null when the player's body has no clips for this action. */
  static async create(def: TransportDef, host: TransportHost): Promise<TransportRun | null> {
    const url = host.character.url;
    const { body, actions, refs } = await bodyOf(url);
    const act = actions?.bodies[body]?.[def.action ?? ''] ?? actions?.bodies.male?.[def.action ?? ''];
    if (!act?.loop && !act?.in) return null;
    const audio = (await transportFile())?._audio?.[def.se ?? '']?.[sheetOf(body)] ?? [];
    const run = new TransportRun(def, host, audio);
    // Battle models have their own skeleton: retarget the quest-rig clips onto it.
    const battle = /\/unity\/character\//.test(url);
    for (const k of ['in', 'loop', 'out'] as const) {
      const ref = act[k];
      if (!ref) continue;
      let clip = await loadClip(stripUrl(ref.file)).catch(() => null);
      if (clip && battle) {
        const base = clip;
        clip = null;
        for (const r of refs) {
          clip = await retargetClip(base, url, r).catch(() => null);
          if (clip) break;
        }
      }
      if (clip) run.clips[k] = clip;
    }
    if (!run.clips.loop && !run.clips.in) return null;
    if (def.behaviour === 'MoveActionBehaviour') run.buildJump(act);
    else run.buildLadder(act);
    return run;
  }

  private play(kind: 'in' | 'loop' | 'out', loop: boolean, speed = 1) {
    const clip = this.clips[kind];
    if (clip) this.host.character.playClip(clip, { loop, blend: 0.08, speed });
  }

  private step(sound = true) {
    if (!sound || !this.audio.length) return;
    this.host.sfx.play(this.audio[Math.floor(Math.random() * this.audio.length)]);
  }

  private buildPositioning(pos: THREE.Vector3, yaw: number, dur: number) {
    const c = this.host.controller;
    const h = this.host.heading;
    const from = c.position.clone();
    const fromYaw = h.value;
    const delta = angleDelta(fromYaw, yaw);
    this.phases.push({
      name: 'position',
      dur,
      apply: (t) => {
        const k = 0.5 - Math.cos(Math.min(1, t) * Math.PI) / 2;
        c.position.lerpVectors(from, pos, k);
        h.value = fromYaw + delta * k;
      },
    });
  }

  private buildLadder(act: BodyAction) {
    const d = this.def;
    const c = this.host.controller;
    const h = this.host.heading;
    const speed = d.speed || 1;
    const start = new THREE.Vector3().fromArray(d.start.position);
    const yaw = d.start.rotY * DEG;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const off = (o: V3 | undefined, k: number) => new THREE.Vector3(0, (o?.[1] ?? 0) * k, 0).addScaledVector(fwd, (o?.[2] ?? 0) * k);
    const inDur = (act.in?.duration ?? 0) / speed;
    const outDur = (act.out?.duration ?? 0) / speed;
    const loopDur = act.loop?.duration ?? 0.4667;
    const p1 = start.clone().add(off(act.rootOffsetIn, 1));
    const topY = d.endPosition[1] + d.endActionOffset[1];
    const restY = topY - (act.rootOffsetOut?.[1] ?? 0) - p1.y;
    const loopStep = Math.abs(act.rootOffsetLoop?.[1] ?? 0.98) || 0.98;
    const cycles = Math.max(1, Math.round(Math.abs(restY) / loopStep));
    const loopTotal = (cycles * loopDur) / speed;
    const p2 = p1.clone().add(new THREE.Vector3(0, restY, 0));
    const p3 = p2.clone().add(off(act.rootOffsetOut, 1));
    const ctl = (p: THREE.Vector3) => c.position.copy(p);

    this.buildPositioning(start, yaw, Math.max(0, Math.min(0.5, d.start.duration)));
    this.phases[0].begin = () => {
      c.velocity.set(0, 0, 0);
    };
    this.phases.push({
      name: 'in',
      dur: Math.max(0.05, inDur),
      begin: () => {
        h.value = yaw;
        this.play('in', false, speed);
        this.step();
      },
      apply: (t) => ctl(new THREE.Vector3().lerpVectors(start, p1, t)),
    });
    let lastCycle = -1;
    this.phases.push({
      name: 'loop',
      dur: loopTotal,
      begin: () => {
        lastCycle = -1;
        this.play('loop', true, speed);
      },
      apply: (t) => {
        ctl(new THREE.Vector3().lerpVectors(p1, p2, t));
        const cycle = Math.floor(t * cycles * 2); // a footstep on every half cycle
        if (cycle !== lastCycle) {
          lastCycle = cycle;
          this.step();
        }
      },
    });
    this.phases.push({
      name: 'out',
      dur: Math.max(0.05, outDur),
      begin: () => {
        this.play('out', false, speed);
        this.step();
      },
      apply: (t) => ctl(new THREE.Vector3().lerpVectors(p2, p3, t)),
    });
    this.buildWalkOff(d.endTarget ? new THREE.Vector3().fromArray(d.endTarget) : null, p3);
  }

  private buildJump(act: BodyAction) {
    const d = this.def;
    const c = this.host.controller;
    const h = this.host.heading;
    const speed = d.speed || 1;
    const direct = d.start.duration <= 0; // fire from where the player stands
    const from = direct ? c.position.clone() : new THREE.Vector3().fromArray(d.start.position);
    const end = new THREE.Vector3().fromArray(d.endPosition);
    end.y += d.endActionOffset[1];
    const yaw = Math.hypot(end.x - from.x, end.z - from.z) > 0.3 ? Math.atan2(end.x - from.x, end.z - from.z) : d.start.rotY * DEG;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const move = d.move;
    const moveDur = (move?.duration ?? 1) / speed;
    const outZ = act.rootOffsetOut?.[2] ?? 0;
    const landing = end.clone().addScaledVector(fwd, outZ);

    if (!direct) this.buildPositioning(from, yaw, Math.max(0, Math.min(0.5, d.start.duration)));
    else
      this.phases.push({
        name: 'position',
        dur: 0.12,
        apply: (t) => {
          h.value += angleDelta(h.value, yaw) * Math.min(1, t * 2);
        },
      });
    this.phases.push({
      name: 'in',
      dur: Math.max(0.05, (act.in?.duration ?? 0.3) / speed),
      begin: () => {
        h.value = yaw;
        this.play('in', false, speed);
      },
      apply: () => {},
    });
    this.phases.push({
      name: 'loop',
      dur: moveDur,
      begin: () => this.play('loop', true, speed),
      apply: (t) => {
        const f = evalCurve(move?.forward, t);
        const hy = evalCurve(move?.height, t);
        c.position.set(lerp(from.x, end.x, f), lerp(from.y, end.y, hy), lerp(from.z, end.z, f));
      },
    });
    this.phases.push({
      name: 'out',
      dur: Math.max(0.05, (act.out?.duration ?? 0.5) / speed),
      begin: () => this.play('out', false, speed),
      apply: (t) => c.position.lerpVectors(end, landing, Math.min(1, t * 2.2)),
    });
    this.buildWalkOff(d.endTarget ? new THREE.Vector3().fromArray(d.endTarget) : null, landing);
  }

  /** Back on the ground controller: settle (gravity) and walk to the end target. */
  private buildWalkOff(target: THREE.Vector3 | null, at: THREE.Vector3) {
    const c = this.host.controller;
    const h = this.host.heading;
    this.phases.push({
      name: 'walk',
      dur: target ? 3 : 0.2,
      begin: () => {
        this.host.character.stopMotion(0.15);
        // The end offsets are approximate: settle on the ledge just below them instead of falling past it.
        const g = c.world?.groundBelow(at.clone().add(new THREE.Vector3(0, 1.2, 0)), 2.8);
        c.teleport(g && Math.abs(g.y - at.y) < 1.5 ? g : at);
      },
      apply: (_t, dt) => {
        const move = new THREE.Vector3();
        this.speed = 0;
        if (target) {
          const dx = target.x - c.position.x;
          const dz = target.z - c.position.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.15) {
            this.t = Infinity; // arrived
          } else {
            const step = Math.min(dist, WALK * dt);
            move.set((dx / dist) * step, 0, (dz / dist) * step);
            h.value += angleDelta(h.value, Math.atan2(dx, dz)) * (1 - Math.exp(-dt * 14));
            this.speed = WALK;
          }
        }
        c.step(move, dt);
      },
    });
  }

  private enter(i: number) {
    this.index = i;
    this.t = 0;
    this.phases[i]?.begin?.();
  }

  update(dt: number) {
    if (this.done) return;
    if (this.index < 0) this.enter(0);
    this.t += dt;
    for (;;) {
      const p = this.phases[this.index];
      p.apply(p.dur > 0 ? Math.min(1, this.t / p.dur) : 1, dt);
      if (this.t < p.dur) return;
      if (this.index + 1 >= this.phases.length) {
        this.done = true;
        this.speed = 0;
        this.host.character.stopMotion(0.1);
        return;
      }
      const carry = Number.isFinite(this.t) ? this.t - p.dur : 0;
      this.enter(this.index + 1);
      this.t = carry;
      dt = 0;
    }
  }
}

// ------------------------------------------------------------------------------------------- finding triggers

/** The nearest transport the player stands at, within `margin` metres beyond the trigger sphere. */
export function transportAt(defs: TransportDef[], p: THREE.Vector3, margin = 0.45): TransportDef | null {
  let best: TransportDef | null = null;
  let bestScore = Infinity;
  for (const d of defs) {
    const flat = Math.hypot(d.position[0] - p.x, d.position[2] - p.z);
    if (flat > d.radius + margin) continue;
    if (Math.abs(d.position[1] - p.y) > Math.max(1, d.effectiveDistanceY) + 0.8) continue;
    const score = d.priority * 100 + flat;
    if (score < bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Does walking into the trigger fire it? Invisible hop-downs do. A jump UP onto a higher ledge is offered with the
 * interact key instead, because the game places such a trigger on top of a hop-down one (both are "auto" in the
 * data): firing both by touch would make the higher ledge unreachable.
 */
export function firesOnTouch(d: TransportDef) {
  return d.auto && (d.start.duration <= 0 || d.endPosition[1] - d.start.position[1] <= 1.5);
}

export function transportLabel(d: TransportDef) {
  if (d.action === 'ladder_up_01') return 'Climb <b>up</b>';
  if (d.action === 'ladder_down_01') return 'Climb <b>down</b>';
  return 'Jump';
}
