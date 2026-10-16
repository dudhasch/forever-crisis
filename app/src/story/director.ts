// Runs one dungeon content's field scripts (generated/scripts/<map>/<content>.json) against the explorer:
// the game's Lua library calls the `dungeon.*` natives and character/gimmick/trigger methods below, which
// drive story actors, the camera, fades, text windows, sound and the map's gimmicks.
import * as THREE from 'three';
import type { Music } from '../audio';
import type { CameraRig } from '../camera/rig';
import { Character, loadClip } from '../player/character';
import type { MusicTrack } from '../types';
import type { GameMap } from '../world/map';
import { globalLib, type CharacterDef, type ContentData, type MotionDef, type Shape, type StoryFlags, type TriggerDef } from './data';
import { easing } from './ease';
import { LuaVM, type LuaHandle, type LuaHost, type LuaValue, type ScriptThread } from './lua';
import { cssColor, plainText, type SoundEffects, type StoryOverlay } from './overlay';

const DEG = Math.PI / 180;
const Y = new THREE.Vector3(0, 1, 0);
/** Ground speed at move speed rate 1 (m/s). */
const RUN_SPEED = 5;
/** Head height as a fraction of the model's height (look-at IK and bubbles). */
const FACE = 0.92;
const LOOK_DEFAULT = 0.3;
/** Game talk offsets are in reference-screen pixels (750 high). */
const REF_HEIGHT = 750;

function num(v: unknown, d = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d: boolean) {
  return typeof v === 'boolean' ? v : d;
}
function str(v: unknown) {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}
/** Unity world position (what the Lua passes) -> three.js. */
function U(x: unknown, y: unknown, z: unknown) {
  return new THREE.Vector3(-num(x), num(y), num(z));
}
/** Unity yaw in degrees -> three.js rotation.y in radians. */
function yawOf(deg: unknown) {
  return -num(deg) * DEG;
}
function yawFromQuat(q: number[]) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(q));
  return Math.atan2(f.x, f.z);
}
function angleLerp(a: number, b: number, k: number) {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
}
function handleOf(v: LuaValue | undefined): string | null {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as LuaHandle).__handle === 'string' ? (v as LuaHandle).__handle : null;
}
/** "/gen/anims/shared/x.json" -> "shared/x.json" (what Character.loadClip takes). */
function animFile(url: string) {
  return url.replace(/^\/gen\/anims\//, '');
}

// ------------------------------------------------------------------------------------------- actions

type Phase = 'Idle' | 'ActionIn' | 'ActionLoop' | 'ActionOut';
const RANK: Record<string, number> = { ActionIn: 1, ActionLoop: 2, ActionOut: 3, Idle: 4 };

interface TrackOps {
  play(url: string, loop: boolean): Promise<boolean>;
  stop(): void;
  state(): string;
}

/** One animator layer of the game's ActionData state machine: In -> Loop (until stopped or loopTime) -> Out -> Idle. */
class ActionTrack {
  phase: Phase = 'Idle';
  private def: MotionDef | null = null;
  private loopTime = -1;
  private elapsed = 0;
  private pending = false;
  private failed = false;
  private token = 0;

  constructor(private ops: TrackOps) {}

  start(def: MotionDef, loopTime: number, immediate: boolean, fast: boolean) {
    this.def = def;
    this.loopTime = loopTime;
    this.elapsed = 0;
    if (def.type === 0 || (!def.in && !def.loop)) {
      if (fast) return this.idle();
      return this.enter('ActionOut');
    }
    if (immediate || fast) {
      if (fast && loopTime >= 0) return this.idle();
      return this.enter('ActionLoop');
    }
    this.enter(def.in ? 'ActionIn' : 'ActionLoop');
  }

  stop(fast: boolean) {
    if (this.phase !== 'ActionIn' && this.phase !== 'ActionLoop') return;
    if (fast || !this.def?.out) this.idle();
    else this.enter('ActionOut');
  }

  force() {
    this.idle();
  }

  /** Has the layer reached (or passed) this ACT_STATUS_*? */
  reached(status: string) {
    return RANK[this.phase] >= (RANK[status] ?? 0);
  }

  private enter(p: Phase) {
    const url = p === 'ActionIn' ? this.def?.in : p === 'ActionLoop' ? this.def?.loop : this.def?.out;
    this.phase = p;
    this.failed = false;
    if (!url) {
      if (p === 'ActionIn') this.enter('ActionLoop');
      else if (p === 'ActionOut') this.idle();
      return; // a loop without its own clip holds the In pose
    }
    const tok = ++this.token;
    this.pending = true;
    void this.ops.play(url, p === 'ActionLoop').then((ok) => {
      if (tok !== this.token) return;
      this.pending = false;
      this.failed = !ok;
    });
  }

  private idle() {
    this.token++;
    this.pending = false;
    if (this.phase !== 'Idle') this.ops.stop();
    this.phase = 'Idle';
    this.def = null;
  }

  update(dt: number) {
    if (this.phase === 'Idle' || this.pending) return;
    const st = this.ops.state();
    if (this.phase === 'ActionIn') {
      if (this.failed || st !== 'playing') this.enter('ActionLoop');
    } else if (this.phase === 'ActionLoop') {
      this.elapsed += dt;
      if (this.loopTime >= 0 && this.elapsed >= this.loopTime) this.stop(false);
      else if (st === 'none' && !this.failed && this.def?.loop) this.idle(); // walking cancelled it
    } else if (this.phase === 'ActionOut') {
      if (this.failed || st !== 'playing') this.idle();
    }
  }
}

/** Bone filters standing in for the game's AvatarMasks (mask_dungeon_qu000_*, not exported). */
const LAYER_BONES: Record<string, RegExp> = {
  ACT_TYPE_UPPER: /spine|chest|neck|head|shoulder|clavicle|arm|elbow|hand|wrist|finger|thumb|index|middle|ring|pinky|weapon/i,
  ACT_TYPE_NECK: /neck|head/i,
  ACT_TYPE_ARM: /shoulder|clavicle|arm|elbow|hand|wrist|finger|thumb|index|middle|ring|pinky|weapon/i,
  ACT_TYPE_LOWER: /hip|pelvis|upleg|leg|knee|foot|toe/i,
  ACT_TYPE_UNIQUE: /face|eye|brow|mouth|jaw|lip|tongue|cheek|teeth/i,
};
/** Natives with nothing to show in the explorer: logs, HUD widgets, menus, the chocobo farm. */
const SILENT_NATIVES = new Set([
  'addTalkLog',
  'addTalkCustomLog',
  'addTalkFlexibleLog',
  'addLocationLog',
  'startTimerWindow',
  'setTimerWindow',
  'closeTimerWindow',
  'setActiveNameLabel',
  'setNameLabel',
  'removeNameLabel',
  'showTriggerMarker',
  'hideTriggerMarker',
  'setPlaneEnvironmentAudioEnable',
  'playScreenEffect',
  'stopScreenEffect',
  'setScreenMode',
  'playNovel',
  'playWandering',
  'stopWandering',
  'setupWandering',
  'setReceiveEventRewardIcon',
  'setActiveReceiveEventRewardIcon',
  'removeReceiveEventRewardIcon',
  'getChocoboFarmEventTreasure',
  'resetChocoboFarmChocobos',
  'openChocoboAcquisitionResultModal',
  'endChocoboTutorial',
  'endChocoboExchangeTutorial',
  'getTalkChocoboName',
]);

const LAYER_OF: Record<string, string> ={ Upper: 'ACT_TYPE_UPPER', Neck: 'ACT_TYPE_NECK', Arm: 'ACT_TYPE_ARM', Lower: 'ACT_TYPE_LOWER', Unique: 'ACT_TYPE_UNIQUE' };

// ------------------------------------------------------------------------------------------- actors

/** A character the scripts address by its m_character_novel_set id. */
class Actor {
  character: Character | null = null;
  readonly ready: Promise<void>;
  readonly pos = new THREE.Vector3();
  yaw = 0;
  visible = true;
  gravity = true;
  readonly scale = new THREE.Vector3(1, 1, 1);
  route: THREE.Vector3[] | null = null;
  private routeAll: THREE.Vector3[] = [];
  private routeLoop = 'none';
  private speed = 0;
  slide: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; ease: (t: number) => number } | null = null;
  turn: { from: number; to: number; t: number; dur: number } | null = null;
  private look: (() => THREE.Vector3) | null = null;
  lookUntil = 0;
  fadeUntil = 0;
  private hideAt: number | null = null;
  trace: { target: Actor; offset: THREE.Vector3 } | null = null;
  readonly base: ActionTrack;
  private layers = new Map<string, ActionTrack>();
  disposed = false;

  constructor(
    readonly key: string,
    readonly def: CharacterDef | undefined,
    private d: StoryDirector,
  ) {
    this.base = new ActionTrack({
      play: (u, loop) => (this.character ? this.character.playMotion(animFile(u), { loop }) : Promise.resolve(false)),
      stop: () => this.character?.stopMotion(),
      state: () => this.character?.motionState ?? 'none',
    });
    this.ready = def?.glb
      ? // Only the player shows through scenery as a silhouette; NPCs are simply hidden, as in the game.
        Character.load(def.glb, { outline: true, silhouette: key === String(d.controlId) ? d.world.silhouette : undefined })
          .then((c) => {
            if (this.disposed) return c.dispose();
            this.character = c;
            c.root.visible = false;
            d.group.add(c.root);
            this.apply();
          })
          .catch((e) => console.warn('[story] character', key, def.glb, e))
      : Promise.resolve();
  }

  get name() {
    return this.def?.name ?? '';
  }

  get height() {
    return this.character?.height ?? 1.7;
  }

  motion(name: string) {
    return this.def?.motions?.[name] ?? null;
  }

  layer(type: string) {
    let t = this.layers.get(type);
    if (!t) {
      t = new ActionTrack({
        play: (u, loop) => (this.character ? this.character.playLayer(type, animFile(u), LAYER_BONES[type] ?? /./, loop) : Promise.resolve(false)),
        stop: () => this.character?.stopLayer(type),
        state: () => this.character?.layerState(type) ?? 'none',
      });
      this.layers.set(type, t);
    }
    return t;
  }

  /** World point at face height. */
  head() {
    return this.pos.clone().addScaledVector(Y, this.height * FACE);
  }

  warp(p: THREE.Vector3) {
    this.pos.copy(p);
    this.route = null;
    this.slide = null;
    this.trace = null;
  }

  moveTo(points: THREE.Vector3[], rate: number, loop = 'none') {
    this.slide = null;
    if (!points.length) return;
    if (this.d.fast) {
      this.pos.copy(points[points.length - 1]);
      const prev = points.length > 1 ? points[points.length - 2] : null;
      if (prev) this.yaw = Math.atan2(this.pos.x - prev.x, this.pos.z - prev.z);
      this.route = null;
      return;
    }
    this.routeAll = points.map((p) => p.clone());
    this.route = points.map((p) => p.clone());
    this.routeLoop = loop;
    this.speed = Math.max(0.3, rate * RUN_SPEED);
  }

  slideTo(p: THREE.Vector3, dur: number, ease: unknown) {
    this.route = null;
    if (this.d.fast || dur <= 0) {
      this.pos.copy(p);
      this.slide = null;
      return;
    }
    this.slide = { from: this.pos.clone(), to: p, t: 0, dur, ease: easing(ease ?? 'EASE_IN_OUT_SINE') };
  }

  turnTo(yaw: number, dur: number) {
    if (this.d.fast || dur <= 0) {
      this.yaw = yaw;
      this.turn = null;
      return;
    }
    this.turn = { from: this.yaw, to: yaw, t: 0, dur };
  }

  lookAt(target: (() => THREE.Vector3) | null, dur: number) {
    this.look = target;
    this.lookUntil = this.d.fast ? 0 : this.d.time + (dur < 0 ? LOOK_DEFAULT : dur);
  }

  fade(show: boolean, dur: number) {
    this.fadeUntil = this.d.fast ? 0 : this.d.time + dur;
    if (show) {
      this.visible = true;
      this.hideAt = null;
    } else this.hideAt = this.fadeUntil;
  }

  update(dt: number, drive: boolean) {
    this.base.update(dt);
    for (const l of this.layers.values()) l.update(dt);
    if (this.hideAt !== null && this.d.time >= this.hideAt) {
      this.visible = false;
      this.hideAt = null;
    }
    if (!drive) return;
    let ground = 0;
    if (this.trace) {
      this.pos.copy(this.trace.target.pos).add(this.trace.offset);
    } else if (this.slide) {
      const s = this.slide;
      s.t += dt;
      const k = s.ease(Math.min(1, s.t / s.dur));
      this.pos.lerpVectors(s.from, s.to, k);
      if (s.t >= s.dur) this.slide = null;
    } else if (this.route) {
      const target = this.route[0];
      const dx = target.x - this.pos.x;
      const dz = target.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step || dist < 1e-3) {
        this.pos.copy(target);
        this.route.shift();
        if (!this.route.length) {
          if (this.routeLoop === 'repeat') this.route = this.routeAll.map((p) => p.clone());
          else if (this.routeLoop === 'pingpong') this.route = (this.routeAll = this.routeAll.reverse()).map((p) => p.clone());
          else this.route = null;
        }
      } else {
        this.pos.x += (dx / dist) * step;
        this.pos.z += (dz / dist) * step;
        this.pos.y += (target.y - this.pos.y) * Math.min(1, step / dist);
        this.yaw = angleLerp(this.yaw, Math.atan2(dx, dz), 1 - Math.exp(-dt * 12));
      }
      ground = this.speed;
      if (this.gravity) {
        const g = this.d.ground(this.pos);
        if (g && Math.abs(g.y - this.pos.y) < 0.8) this.pos.y = g.y;
      }
    }
    if (this.turn) {
      const t = this.turn;
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      this.yaw = angleLerp(t.from, t.to, 0.5 - Math.cos(k * Math.PI) / 2);
      if (k >= 1) this.turn = null;
    }
    const c = this.character;
    if (!c) return;
    this.apply();
    c.lookAt(this.look ? this.look() : null);
    c.update(dt, ground);
  }

  apply() {
    const c = this.character;
    if (!c) return;
    c.root.position.copy(this.pos);
    c.root.rotation.y = this.yaw;
    c.root.scale.copy(this.scale);
    c.root.visible = this.visible;
  }

  dispose() {
    this.disposed = true;
    this.character?.dispose();
    this.character = null;
  }
}

// ------------------------------------------------------------------------------------------- triggers

interface TriggerState {
  def: TriggerDef;
  enabled: boolean;
  inside: boolean;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
export function inShape(s: Shape, p: THREE.Vector3) {
  if (s.enabled === false) return false;
  tmpV.copy(p).sub(new THREE.Vector3().fromArray(s.center));
  if (s.shape === 'sphere') return tmpV.length() <= (s.radius ?? 0.5);
  if (s.shape === 'capsule') return tmpV.length() <= Math.max(s.radius ?? 0.5, (s.height ?? 1) / 2);
  if (s.quaternion) tmpV.applyQuaternion(tmpQ.fromArray(s.quaternion).invert());
  const size = s.size ?? [1, 1, 1];
  return Math.abs(tmpV.x) <= size[0] / 2 && Math.abs(tmpV.y) <= size[1] / 2 && Math.abs(tmpV.z) <= size[2] / 2;
}

// ------------------------------------------------------------------------------------------- director

export interface StoryWorld {
  readonly map: GameMap;
  readonly rig: CameraRig;
  readonly music: Music;
  readonly overlay: StoryOverlay;
  readonly sfx: SoundEffects;
  readonly silhouette: THREE.Color;
  /** The player capsule's feet (live vector). */
  readonly playerPosition: THREE.Vector3;
  heading: number;
  placePlayer(p: THREE.Vector3, yaw: number): void;
  /** The control character's body becomes the player (null: back to the user's pick). */
  setPlayerBody(c: Character | null): void;
  /** Show a named pre-rendered view, or go back to the area camera (null). */
  setCapture(name: string | null): Promise<void>;
  changeDungeon(mapId: number, contentId: number, startPointIndex: number): void;
  clearDungeon(): void;
  /** Fight a battle (m_story_battle id + its m_battle ids); resolves true when won (or skipped after a loss). */
  battle(storyBattle: number, battleIds: number[]): Promise<boolean>;
  /** Lua changeBattleField(n) / resetBattleField(): the stage later battles use. */
  setBattleField(field: number | null): void;
  toast(msg: string): void;
  /** The player opened treasure box `id` (m_dungeon_treasure): show it open and grant the rewards. */
  openTreasure(id: number): void;
  /** party.openPartyEditMenu: show the in-game menu's Party tab. */
  openPartyMenu?(): void;
}

export interface StoryPrompt {
  label: string;
  run: () => void;
  /** Where the trigger is (three.js), for the HUD's interaction prompt. */
  position?: THREE.Vector3;
}

/** What the field HUD's minimap shows for a trigger: the story's next event, a way out, something to examine. */
export interface StoryMarker {
  kind: 'objective' | 'exit' | 'examine' | 'treasure';
  position: THREE.Vector3;
}

interface Fade {
  amount: number;
  color: string;
  tween: { from: number; to: number; t: number; dur: number } | null;
}

export class StoryDirector implements LuaHost {
  readonly vm: LuaVM;
  readonly group = new THREE.Group();
  readonly flagKey: string;
  private actors = new Map<string, Actor>();
  private triggers: TriggerState[];
  control: Actor | null = null;
  controlEnabled = true;
  skipEnabled = false;
  fast = false;
  busy = false;
  /** changeDungeon / clearDungeon was called: this content is ending. */
  leaving = false;
  disposed = false;
  time = 0;
  /** Name of the running script (for the UI). */
  current: string | null = null;
  onChange: () => void = () => {};
  private inputSeq = 0;
  private running: { thread: ScriptThread; skip: string | null } | null = null;
  private skipRequested = false;
  private exitRequested = false;
  private nextIndex: number | null = null;
  private timers: { at: number; fn: () => void }[] = [];
  private checkCache = new Map<string, { version: number; ok: boolean }>();
  private checkEnvs = new Map<string, number>();
  // camera
  private cam: { from: THREE.Vector3; to: () => THREE.Vector3; t: number; dur: number; ease: (t: number) => number; follow: boolean; release: boolean } | null = null;
  private focusLocked = false;
  private fov: { from: number; to: number; t: number; dur: number; ease: (t: number) => number; reset: boolean } | null = null;
  private shake: { until: number; strength: number } | null = null;
  scriptCapture: string | null = null;
  // fades and text
  private fades: Record<'ui' | 'env', Fade> = {
    ui: { amount: 0, color: '#000', tween: null },
    env: { amount: 0, color: '#000', tween: null },
  };
  private bubbles = new Map<string, { actor: Actor; ox: number; oy: number; pivot: string; autoClose: boolean }>();
  private talk2dAuto = false;
  private narrationAuto = false;
  private effectSeq = 0;
  private warned = new Set<string>();
  /** Arriving (setup still running): scripts may not hand control to the player yet. */
  private entering = false;
  private bar: string | null = null;

  private constructor(
    readonly world: StoryWorld,
    readonly content: ContentData,
    readonly flags: StoryFlags,
    readonly controlId: number,
    readonly replay: boolean,
  ) {
    this.vm = new LuaVM(this);
    this.group.name = `story:${content.map}/${content.content}`;
    this.flagKey = `${content.mapId}:${content.contentId}`;
    this.triggers = (content.triggers ?? []).map((def) => ({ def, enabled: def.active !== false, inside: false }));
  }

  static async create(world: StoryWorld, content: ContentData, flags: StoryFlags, controlId: number, replay = false) {
    const lib = await globalLib();
    const d = new StoryDirector(world, content, flags, controlId, replay);
    for (const name of lib.loadOrder) d.vm.exec(lib.files[name], name);
    for (const name of content.defineOrder ?? []) {
      const src = content.defineFiles?.[name];
      if (!src) continue;
      try {
        d.vm.exec(src, name);
      } catch (e) {
        console.warn('[story] define', name, e);
      }
    }
    world.map.group.add(d.group);
    return d;
  }

  /** Player input is off while a cutscene runs. */
  get locked() {
    return !this.controlEnabled;
  }

  /** The player may act on the world now (nothing scripted is running). */
  get free() {
    return this.controlEnabled && !this.busy && !this.leaving && !this.entering;
  }

  /** The player is on a ladder / mid-jump: triggers stay quiet until it ends. */
  private transporting = false;

  setTransporting(on: boolean) {
    this.transporting = on;
    if (!on) this.armTriggers();
  }

  get cameraLocked() {
    return this.scriptCapture !== null;
  }

  get scripts() {
    return Object.keys(this.content.files ?? {});
  }

  // ------------------------------------------------------------------ running scripts

  /** Arrive at this content: setup, then the start point's arrival script (or just give control). */
  async enter(startPointIndex: number) {
    this.setFade('ui', 1, '#000', 0);
    this.controlEnabled = false;
    this.entering = true;
    if (this.content.setup && this.content.files[this.content.setup]) await this.runScript(this.content.setup, { force: true, quiet: true });
    this.controlEnabled = false;
    if (this.disposed || this.leaving) return;
    const control = this.ensureControl();
    await control.ready;
    if (this.disposed) return;
    this.world.setPlayerBody(control.character);
    const sp = this.content.startPoints?.find((s) => s.index === startPointIndex) ?? this.content.startPoints?.[0];
    if (sp?.position && sp.quaternion) {
      control.warp(new THREE.Vector3().fromArray(sp.position));
      control.yaw = yawFromQuat(sp.quaternion);
    } else {
      control.warp(this.world.playerPosition.clone());
      control.yaw = this.world.heading;
    }
    this.world.placePlayer(control.pos, control.yaw);
    this.armTriggers();
    this.entering = false;
    const ran = sp?.script && this.content.files[sp.script] ? await this.runScript(sp.script) : false;
    if (!ran && !this.disposed && !this.leaving) {
      control.visible = true;
      control.apply();
      this.setFade('ui', 0, '#000', 0.6);
      this.setControl(true);
    }
    this.armTriggers();
  }

  /**
   * Replay one script on its own (cutscene list). Events assume the state earlier scripts left behind
   * (who stands where, which door is open), so the arrival script and the earlier scripts of the same kind
   * are run first at full speed and silently; then the player stands at the script's trigger and it plays.
   */
  async replayScript(name: string) {
    this.setFade('ui', 1, '#000', 0);
    this.controlEnabled = false;
    this.entering = true;
    if (this.content.setup && this.content.files[this.content.setup]) await this.runScript(this.content.setup, { force: true, quiet: true });
    if (this.disposed) return;
    const control = this.ensureControl();
    await control.ready;
    if (this.disposed) return;
    this.world.setPlayerBody(control.character);
    const sp = this.content.startPoints?.[0];
    if (sp?.position && sp.quaternion) {
      control.warp(new THREE.Vector3().fromArray(sp.position));
      control.yaw = yawFromQuat(sp.quaternion);
    }
    control.visible = true;
    this.world.placePlayer(control.pos, control.yaw);
    this.rehearsing = true;
    this.fast = true;
    for (const before of this.scriptsBefore(name)) {
      await this.runScript(before, { force: true, quiet: true });
      if (this.disposed) return;
    }
    this.fast = false;
    this.rehearsing = false;
    this.leaving = false;
    this.entering = false;
    const trig = this.triggers.find((t) => t.def.script === name);
    if (trig) {
      const at = trig.def.approach?.position ?? trig.def.position;
      control.warp(new THREE.Vector3().fromArray(at));
      const g = this.ground(control.pos);
      if (g) control.pos.y = g.y;
    }
    control.visible = true;
    control.apply();
    this.world.placePlayer(control.pos, control.yaw);
    this.closeAllText();
    this.setFade('env', 0, '#000', 0);
    this.setFade('ui', 0, '#000', 0.4);
    await this.runScript(name, { force: true });
    this.armTriggers();
  }

  /** The arrival script plus same-kind scripts numbered below `name` (novel_01, novel_02 before novel_03). */
  private scriptsBefore(name: string) {
    const arrival = this.content.startPoints?.[0]?.script;
    const m = /^(.*)_(\d+)$/.exec(name);
    const out: string[] = [];
    if (arrival && arrival !== name && this.content.files[arrival]) out.push(arrival);
    if (m && !name.startsWith('startpoint')) {
      for (let i = 1; i < Number(m[2]); i++) {
        const prev = `${m[1]}_${String(i).padStart(m[2].length, '0')}`;
        if (this.content.files[prev]) out.push(prev);
      }
    }
    return out;
  }
  /** Replay prelude: scripts may not leave the content. */
  private rehearsing = false;

  /**
   * The game's entry protocol: check() decides, then `execute` or execute_1..N in order, each as its own
   * coroutine, with skip_N standing in for an execute_N the player skipped.
   */
  async runScript(name: string, opts: { force?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    const src = this.content.files?.[name];
    if (!src || this.disposed) return false;
    let env: number;
    try {
      env = this.vm.load(src, name);
    } catch (e) {
      console.warn('[story] load', name, e);
      return false;
    }
    if (!opts.force && this.vm.callSync(env, 'check', name) === false) {
      this.vm.unref(env);
      return false;
    }
    const outer = this.current;
    this.busy = true;
    this.current = name;
    this.exitRequested = false;
    this.onChange();
    try {
      if (this.vm.has(env, 'execute')) await this.runPhase(env, name, 'execute', null);
      else {
        for (let i = 1; this.vm.has(env, `execute_${i}`) && !this.exitRequested && !this.disposed && !this.leaving; ) {
          this.nextIndex = null;
          await this.runPhase(env, name, `execute_${i}`, `skip_${i}`);
          i = this.nextIndex ?? i + 1;
        }
      }
    } finally {
      this.vm.unref(env);
      this.current = outer;
      this.busy = outer !== null;
      if (!this.busy && !opts.quiet) this.afterScript();
      this.onChange();
    }
    return true;
  }

  private async runPhase(env: number, name: string, fn: string, skip: string | null) {
    const t = this.vm.spawn(env, fn, name);
    this.running = { thread: t, skip: skip && this.vm.has(env, skip) ? skip : null };
    await t.finished;
    const run = this.running;
    this.running = null;
    if (this.skipRequested && !this.disposed) {
      this.skipRequested = false;
      if (run?.skip) {
        this.fast = true;
        const s = this.vm.spawn(env, run.skip, name);
        await s.finished;
        this.fast = false;
      }
    }
  }

  /** Leave the world in a playable state once no script runs any more. */
  private afterScript() {
    if (this.disposed || this.leaving) return;
    this.closeAllText();
    this.skipEnabled = false;
    if (!this.controlEnabled) this.setControl(true);
    if (this.fades.ui.amount > 0.01 && !this.fades.ui.tween) this.setFade('ui', 0, this.fades.ui.color, 0.5);
    if (this.fades.env.amount > 0.01 && !this.fades.env.tween) this.setFade('env', 0, this.fades.env.color, 0.5);
    if (!this.focusLocked) this.releaseCamera();
  }

  /** E / Enter / click. */
  advance() {
    const o = this.world.overlay;
    if (o.choosing) return o.choicePick?.();
    this.inputSeq++;
  }

  /** Esc: stop a movie, else skip the running cutscene phase (when the script allows skipping). */
  skip() {
    const o = this.world.overlay;
    if (o.moviePlaying) return o.stopMovie();
    if (!this.running || !this.skipEnabled || this.fast) return;
    this.skipRequested = true;
    o.showCard(null);
    o.stopMovie();
    this.closeAllText();
    this.running.thread.kill();
  }

  get canSkip() {
    return !!this.running && this.skipEnabled && !this.fast;
  }

  private setControl(on: boolean) {
    if (on && this.entering) return;
    this.controlEnabled = on;
    if (on && this.control) {
      this.world.placePlayer(this.control.pos, this.control.yaw);
      if (!this.focusLocked) this.releaseCamera();
      this.armTriggers();
    }
  }

  // ------------------------------------------------------------------ frame

  update(dt: number) {
    if (this.disposed) return;
    this.time += dt;
    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.time);
      this.timers = this.timers.filter((t) => t.at > this.time);
      for (const t of due) t.fn();
    }
    const control = this.control;
    if (control && this.controlEnabled) {
      control.pos.copy(this.world.playerPosition);
      control.yaw = this.world.heading;
    }
    for (const a of this.actors.values()) a.update(dt, !(a === control && this.controlEnabled));
    this.updateFades(dt);
    this.updateCamera(dt);
    this.vm.update();
    if (control && !this.controlEnabled) this.world.placePlayer(control.pos, control.yaw);
    if (this.free && !this.transporting) this.updateTriggers();
    const bar = this.busy && !this.fast && !this.controlEnabled ? '<kbd>E</kbd> next · <kbd>Esc</kbd> pause' : null;
    if (bar !== this.bar) this.world.overlay.setBar((this.bar = bar));
  }

  /** After the camera moved: place speech bubbles, shake. */
  updateScreen(camera: THREE.PerspectiveCamera) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const s = h / REF_HEIGHT;
    for (const [key, b] of this.bubbles) {
      const p = b.actor.head().addScaledVector(Y, 0.25).project(camera);
      const vis = p.z < 1 && b.actor.visible;
      this.world.overlay.placeBubble(key, ((p.x + 1) / 2) * w + b.ox * s, ((1 - p.y) / 2) * h - b.oy * s, b.pivot, vis);
    }
    if (this.shake) {
      if (this.shake.until >= 0 && this.time > this.shake.until) this.shake = null;
      else {
        const k = 0.004 * this.shake.strength;
        camera.rotateY((Math.random() - 0.5) * k);
        camera.rotateX((Math.random() - 0.5) * k);
        camera.updateMatrixWorld(true);
      }
    }
  }

  private after(sec: number, fn: () => void) {
    this.timers.push({ at: this.time + sec, fn });
  }

  ground(p: THREE.Vector3) {
    return this.world.map.collision?.groundBelow(p.clone().addScaledVector(Y, 0.6), 1.4) ?? null;
  }

  // ------------------------------------------------------------------ actors

  private actor(id: number, index = 0) {
    const key = index ? `${id}#${index}` : String(id);
    let a = this.actors.get(key);
    if (!a) {
      a = new Actor(key, this.content.characters?.[String(id)], this);
      this.actors.set(key, a);
    }
    return a;
  }

  private ensureControl() {
    this.control ??= this.actor(this.controlId);
    return this.control;
  }

  private actorOf(v: LuaValue | undefined) {
    const h = handleOf(v);
    return h?.startsWith('c:') ? (this.actors.get(h.slice(2)) ?? null) : null;
  }

  private handle(a: Actor): LuaHandle {
    return { __handle: `c:${a.key}` };
  }

  /** Start loading every motion clip a character will use, so playAction starts without a gap. */
  private preload(a: Actor, motions: LuaValue[]) {
    for (const m of motions) {
      const def = a.motion(str(m));
      for (const u of [def?.in, def?.loop, def?.out]) if (u) void loadClip(animFile(u)).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ camera, fades, text

  private playerLook() {
    const c = this.control;
    const p = c ? c.pos.clone() : this.world.playerPosition.clone();
    return p.addScaledVector(Y, (c?.height ?? 1.7) * 0.6);
  }

  private lookPoint() {
    return this.world.rig.script.target?.clone() ?? this.playerLook();
  }

  private focusTo(to: () => THREE.Vector3, dur: number, ease: unknown, follow: boolean, release = false) {
    this.cam = { from: this.lookPoint(), to, t: 0, dur: this.fast ? 0 : dur, ease: easing(ease ?? 'EASE_IN_OUT_SINE'), follow, release };
    this.updateCamera(0);
  }

  private releaseCamera() {
    this.cam = null;
    this.world.rig.script.target = null;
  }

  private camDone() {
    return !this.cam || (this.cam.follow && this.cam.t >= this.cam.dur);
  }

  private updateCamera(dt: number) {
    const rig = this.world.rig;
    const c = this.cam;
    if (c) {
      c.t += dt;
      const k = c.dur > 0 ? c.ease(Math.min(1, c.t / c.dur)) : 1;
      rig.script.target = c.from.clone().lerp(c.to(), k);
      if (c.t >= c.dur && !c.follow) {
        this.cam = null;
        if (c.release) rig.script.target = null;
      }
    }
    const f = this.fov;
    if (f) {
      f.t += dt;
      const k = f.dur > 0 ? f.ease(Math.min(1, f.t / f.dur)) : 1;
      rig.script.fov = f.from + (f.to - f.from) * k;
      if (f.t >= f.dur) {
        this.fov = null;
        if (f.reset) rig.script.fov = null;
      }
    }
  }

  private setFov(to: number, dur: number, ease: unknown, reset = false) {
    const rig = this.world.rig;
    this.fov = { from: rig.script.fov ?? rig.defaultLens(), to, t: 0, dur: this.fast ? 0 : dur, ease: easing(ease ?? 'EASE_IN_OUT_SINE'), reset };
    this.updateCamera(0);
  }

  private setFade(which: 'ui' | 'env', to: number, color: string, dur: number) {
    const f = this.fades[which];
    f.color = color;
    if (this.fast || dur <= 0) {
      f.amount = to;
      f.tween = null;
    } else f.tween = { from: f.amount, to, t: 0, dur };
    this.world.overlay.setFade(which === 'ui', f.amount, f.color);
  }

  private updateFades(dt: number) {
    for (const which of ['ui', 'env'] as const) {
      const f = this.fades[which];
      if (f.tween) {
        f.tween.t += dt;
        const k = Math.min(1, f.tween.t / f.tween.dur);
        f.amount = f.tween.from + (f.tween.to - f.tween.from) * k;
        if (k >= 1) f.tween = null;
      }
      this.world.overlay.setFade(which === 'ui', f.amount, f.color);
    }
  }

  private talk(a: Actor, speaker: string, text: string, ox: number, oy: number, autoClose: boolean, pivot: string, slot: number) {
    if (this.fast) return;
    const key = `${a.key}:${slot}`;
    this.world.overlay.bubble(key, speaker, text);
    this.bubbles.set(key, { actor: a, ox, oy, pivot: pivot || 'BC', autoClose });
  }

  private closeTalk(a: Actor, slot: number | null) {
    for (const key of [...this.bubbles.keys()]) {
      if (key === `${a.key}:${slot}` || (slot === null && key.startsWith(`${a.key}:`))) {
        this.bubbles.delete(key);
        this.world.overlay.closeBubble(key);
      }
    }
  }

  /** What a tap closes: every window shown with autoClose. */
  private closeAuto() {
    for (const [key, b] of [...this.bubbles]) {
      if (!b.autoClose) continue;
      this.bubbles.delete(key);
      this.world.overlay.closeBubble(key);
    }
    if (this.talk2dAuto) this.world.overlay.hideTalk();
    if (this.narrationAuto) this.world.overlay.hideNarration();
  }

  private closeAllText() {
    this.bubbles.clear();
    const o = this.world.overlay;
    o.closeBubbles();
    o.hideTalk();
    o.hideNarration();
    o.setWaiting(false);
  }

  private waitInput(t: ScriptThread | null, seconds: number) {
    if (!t || this.fast) return this.closeAuto();
    const seq = this.inputSeq;
    const until = seconds > 0 ? this.time + seconds : Infinity;
    this.world.overlay.setWaiting(true);
    t.waitFor(() => {
      if (this.inputSeq === seq && this.time < until && !this.fast) return false;
      this.world.overlay.setWaiting(false);
      this.closeAuto();
      return true;
    });
  }

  private waitTime(t: ScriptThread | null, seconds: number) {
    if (!t || this.fast || seconds <= 0) return;
    const until = this.time + seconds;
    t.waitFor(() => this.time >= until || this.fast);
  }

  private text(id: unknown) {
    const k = str(id);
    return this.content.languageTexts?.[k] ?? this.content.locationNames?.[k] ?? k;
  }

  // ------------------------------------------------------------------ gimmicks

  private gimmickDef(name: string) {
    const g = this.content.gimmicks;
    if (!g) return null;
    return g[name] ?? Object.values(g).find((x) => x.object === name || x.node === name) ?? null;
  }

  private setGimmick(name: string, status: string, animate: boolean) {
    const def = this.gimmickDef(name);
    for (const b of def?.statuses[status] ?? []) {
      const delay = this.fast || !animate ? 0 : num(b.delay);
      if (b.kind === 'GimmickAnimationBehaviour' && b.clip) {
        const clip = b.clip;
        const play = () => this.world.map.playClip(clip, !animate || this.fast);
        if (delay > 0) this.after(delay, play);
        else play();
      } else if (b.kind === 'GimmickSEBehaviour' && b.url && animate && !this.fast) {
        const url = b.url;
        this.after(delay, () => this.world.sfx.play(url));
      }
    }
  }

  // ------------------------------------------------------------------ triggers

  private armTriggers() {
    const p = this.world.playerPosition.clone().addScaledVector(Y, 0.5);
    for (const t of this.triggers) t.inside = t.def.shapes.some((s) => inShape(s, p));
  }

  /** Would this trigger's script run now (its check())? Cached until a flag changes. */
  private available(t: TriggerState) {
    const def = t.def;
    if (!t.enabled) return false;
    if (def.type === 'ChangeMapTrigger') return !!def.changeMap;
    if (def.type === 'TreasureBoxTrigger') return !this.flags.opened(num(def.params?._treasureId));
    if (!def.script || !this.content.files[def.script]) return false;
    const cached = this.checkCache.get(def.script);
    if (cached && cached.version === this.flags.version) return cached.ok;
    let env = this.checkEnvs.get(def.script);
    if (env === undefined) {
      try {
        env = this.vm.load(this.content.files[def.script], def.script);
      } catch {
        return false;
      }
      this.checkEnvs.set(def.script, env);
    }
    const ok = this.vm.callSync(env, 'check', def.script) !== false;
    this.checkCache.set(def.script, { version: this.flags.version, ok });
    return ok;
  }

  private updateTriggers() {
    const p = this.world.playerPosition.clone().addScaledVector(Y, 0.5);
    for (const t of this.triggers) {
      const inside = t.def.shapes.some((s) => inShape(s, p));
      const entered = inside && !t.inside;
      const exited = !inside && t.inside;
      t.inside = inside;
      if (!t.def.auto) continue;
      if ((t.def.autoOnExit ? exited : entered) && this.available(t)) {
        void this.fire(t);
        return;
      }
    }
  }

  /** Interact prompt for the trigger the player stands in (non-auto ones: examine, treasure). */
  prompt(): StoryPrompt | null {
    if (!this.free || this.transporting) return null;
    const p = this.world.playerPosition.clone().addScaledVector(Y, 0.5);
    let best: TriggerState | null = null;
    for (const t of this.triggers) {
      if (t.def.auto || !this.available(t)) continue;
      const near = t.def.shapes.some((s) => inShape(s, p)) || (t.def.tapAreas ?? []).some((s) => inShape(s, p));
      if (near && (!best || t.def.priority < best.def.priority)) best = t;
    }
    if (!best) return null;
    const t = best;
    const label = t.def.type === 'TreasureBoxTrigger' ? 'Open <b>treasure box</b>' : t.def.type === 'ChangeMapTrigger' ? 'Go on' : 'Examine';
    return { label, run: () => void this.fire(t), position: new THREE.Vector3().fromArray(t.def.position) };
  }

  /**
   * Minimap markers for the triggers that would run now: auto script triggers are where the story goes on (the
   * objective), map changes are exits, interact triggers are things to examine or open.
   */
  markers(): StoryMarker[] {
    const out: StoryMarker[] = [];
    for (const t of this.triggers) {
      const def = t.def;
      if (!t.enabled || /Battle|Encount|TrackEnemy/.test(def.type)) continue;
      const exit = def.type.startsWith('ChangeMap') && !!def.changeMap;
      if (!exit && !this.available(t)) continue;
      const kind = exit ? 'exit' : def.type === 'TreasureBoxTrigger' ? 'treasure' : def.auto ? 'objective' : 'examine';
      out.push({ kind, position: new THREE.Vector3().fromArray(def.position) });
    }
    return out;
  }

  private async fire(t: TriggerState) {
    if (this.busy || this.leaving) return;
    const def = t.def;
    if (def.oneShot) t.enabled = false;
    if (def.type === 'ChangeMapTrigger' && def.changeMap) {
      const cm = def.changeMap;
      this.leaving = true;
      this.controlEnabled = false;
      this.setFade('ui', 1, '#000', 0.35);
      this.after(0.4, () => this.world.changeDungeon(cm.map, cm.content, cm.startPointIndex));
      return;
    }
    if (def.type === 'TreasureBoxTrigger') {
      const id = num(def.params?._treasureId);
      this.flags.setOpened(id);
      this.world.openTreasure(id);
      return;
    }
    if (!def.script) return;
    // Face the trigger before examining it, like the game's approach move.
    if (!def.auto && this.control && def.approach) {
      const a = def.approach;
      this.control.turnTo(yawOf(-a.rotY) /* already three.js degrees */, 0.25);
    }
    const ran = await this.runScript(def.script);
    if (ran && def.type === 'ChangeMapScriptTrigger' && def.changeMap && !this.leaving) {
      const cm = def.changeMap;
      this.leaving = true;
      this.world.changeDungeon(cm.map, cm.content, cm.startPointIndex);
    }
  }

  // ------------------------------------------------------------------ Lua host: dungeon.*

  native(name: string, a: LuaValue[], t: ScriptThread | null): LuaValue | void {
    const o = this.world.overlay;
    switch (name) {
      // flags
      case 'checkContentFlag':
        return typeof a[0] === 'number' ? this.flags.contentFlag(this.flagKey, a[0]) : false;
      case 'setContentFlag':
        if (typeof a[0] === 'number') this.flags.setContentFlag(this.flagKey, a[0], bool(a[1], true));
        this.checkCache.clear();
        return;
      case 'checkFlag':
        return typeof a[0] === 'number' ? this.flags.flag(a[0]) : false;
      case 'setFlag':
        if (typeof a[0] === 'number') this.flags.setFlag(a[0], bool(a[1], true));
        return;
      case 'getInteger':
        return this.flags.int(str(a[0]));
      case 'setInteger':
        return this.flags.setInt(str(a[0]), num(a[1]));
      case 'getContentInteger':
        return this.flags.contentInt(this.flagKey, str(a[0]));
      case 'setContentInteger':
        return this.flags.setContentInt(this.flagKey, str(a[0]), num(a[1]));
      case 'setSelectionResult':
        return this.flags.setInt(`selection:${str(a[0])}`, num(a[1]));
      case 'getSelectionResult':
        return this.flags.int(`selection:${str(a[0])}`);
      case 'setEventSelectionResult':
      case 'getEventSelectionResult':
        return 0;

      // time and input
      case 'wait':
        return this.waitTime(t, num(a[0]));
      case 'waitInput':
        return this.waitInput(t, num(a[0]));
      case 'cancelWaitInput':
        this.inputSeq++;
        return;
      case 'setEnableSkip':
        this.skipEnabled = bool(a[0], true);
        return;
      case 'setNextExecuteIndex':
        this.nextIndex = num(a[0], 1);
        return;
      case 'exit':
        this.exitRequested = true;
        if (t) {
          t.waitFor(() => false);
          queueMicrotask(() => t.kill());
        }
        return;
      case 'setCharacterControl':
        this.setControl(bool(a[0], true));
        return;

      // fades
      case 'fadeInImmediate':
        return this.setFade('ui', 0, this.fades.ui.color, 0);
      case 'fadeIn':
        return this.setFade('ui', 0, this.fades.ui.color, num(a[0]));
      case 'fadeOutImmediate':
        return this.setFade('ui', 1, cssColor(a[0]), 0);
      case 'fadeOut':
        return this.setFade('ui', num(a[1], 255) / 255, cssColor(a[0]), num(a[2]));
      case 'environmentFadeInImmediate':
        return this.setFade('env', 0, this.fades.env.color, 0);
      case 'environmentFadeIn':
        return this.setFade('env', 0, this.fades.env.color, num(a[0]));
      case 'environmentFadeOutImmediate':
        return this.setFade('env', 1, cssColor(a[0]), 0);
      case 'environmentFadeOut':
        return this.setFade('env', num(a[1], 255) / 255, cssColor(a[0]), num(a[2]));
      case 'onFinishedFade':
        t?.waitFor(() => !this.fades.ui.tween);
        return;
      case 'onFinishedEnvironmentFade':
        t?.waitFor(() => !this.fades.env.tween);
        return;

      // camera
      case 'changeCamera': {
        const view = str(a[0]);
        this.scriptCapture = view;
        let done = false;
        void this.world.setCapture(view).finally(() => (done = true));
        t?.waitFor(() => done || this.disposed);
        return;
      }
      case 'resetCamera':
        this.scriptCapture = null;
        void this.world.setCapture(null);
        return;
      case 'changeCameraAreaCameraNames':
        this.world.map.renameAreaCamera(str(a[0]), str(a[1]));
        return;
      case 'focusPosition': {
        const p = U(a[0], a[1], a[2]);
        return this.focusTo(() => p, num(a[3]), a[4], false);
      }
      case 'focusCharacter': {
        const c = this.actorOf(a[0]);
        if (!c) return;
        const off = U(a[1], a[2], a[3]);
        return this.focusTo(() => c.pos.clone().add(off), num(a[4]), a[5], bool(a[6], false));
      }
      case 'lookControlCharacter':
        return this.focusTo(() => this.playerLook(), num(a[0]), a[1], false, true);
      case 'lockFocus':
        this.focusLocked = true;
        return;
      case 'unlockFocus':
        this.focusLocked = false;
        return;
      case 'onFinishedFocus':
        t?.waitFor(() => this.camDone());
        return;
      case 'setFov':
        return this.setFov(num(a[0], 30), num(a[1]), a[2]);
      case 'resetFov':
        return this.setFov(this.world.rig.defaultLens(), num(a[0]), a[1], true);
      case 'onFinishedFov':
        t?.waitFor(() => !this.fov);
        return;
      case 'shiftCameraLens':
      case 'onFinishedShiftCameraLens':
        return;
      case 'playShakeOneShot':
        if (!this.fast) this.shake = { until: this.time + num(a[0], 0.3), strength: num(a[1], 1) };
        return;
      case 'playShakeLoop':
        if (!this.fast) this.shake = { until: -1, strength: num(a[0], 1) };
        return;
      case 'stopShakeLoop':
        this.shake = null;
        return;
      case 'onFinishedShake':
        t?.waitFor(() => !this.shake || this.shake.until < 0);
        return;

      // text
      case 'flexibleTalk':
        if (this.fast) return;
        o.showNarration(this.text(a[0]), str(a[1]));
        this.narrationAuto = bool(a[4], true);
        return;
      case 'closeFlexibleTalk':
        if (str(a[0]) === 'location') o.hideLocation();
        else o.hideNarration();
        return;
      case 'narrationTalk':
        if (!this.fast) o.showNarration(this.text(a[1]), str(a[0]));
        this.narrationAuto = bool(a[2], true);
        return;
      case 'closeNarrationTalk':
        return o.hideNarration();
      case 'showLocationName':
        if (!this.fast) o.showLocation(str(a[0]), num(a[6], 3));
        return;
      case 'getStoryLanguageText':
        return this.text(a[0]);
      case 'queueNotification':
        this.world.toast(plainText(str(a[0])));
        return;
      case 'selectionTalk': {
        // The pick is remembered under its id: later scripts read it back with getSelection(id).
        const id = `selection:${str(a[0])}`;
        const options = Array.isArray(a[1]) ? a[1].map(str) : [];
        if (!t || this.fast || !options.length) {
          this.flags.setInt(id, 0);
          t?.resumeWith(0);
          return;
        }
        let picked: number | null = null;
        void o.choose(options).then((i) => (picked = i));
        t.waitFor(() => {
          if (picked === null) return false;
          this.flags.setInt(id, picked);
          t.resumeWith(picked);
          return true;
        });
        return;
      }
      case 'eventSelectionTalk':
        t?.resumeWith(0);
        return;
      case 'characterSelectionTalk': {
        const list = Array.isArray(a[0]) ? a[0] : [];
        t?.resumeWith(typeof list[0] === 'number' ? list[0] : 0);
        return;
      }
      case 'showBackground':
        o.showStill(this.content.backgrounds?.[str(a[0])] ?? null);
        return;
      case 'hideBackground':
        o.showStill(null);
        return;

      // characters
      case 'bulkLoad': {
        const list = Array.isArray(a[0]) ? a[0] : [];
        const loads: Promise<void>[] = [];
        for (const entry of list) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const e = entry as Record<string, LuaValue>;
          const actor = this.actor(num(e.characterNovelSetId), num(e.index));
          if (Array.isArray(e.actions)) this.preload(actor, e.actions);
          loads.push(actor.ready);
        }
        let done = false;
        const timeout = this.time + 30;
        void Promise.all(loads).finally(() => (done = true));
        t?.waitFor(() => done || this.time > timeout);
        return;
      }
      case 'loadCharacter': {
        const actor = this.actor(num(a[0]), num(a[1]));
        let done = false;
        void actor.ready.finally(() => (done = true));
        t?.waitFor(() => done);
        return;
      }
      case 'getCharacter':
        return this.handle(this.actor(num(a[0]), num(a[1])));
      case 'destroyCharacter': {
        const c = this.actorOf(a[0]);
        if (c && c !== this.control) {
          c.dispose();
          this.actors.delete(c.key);
        }
        return;
      }
      case 'getControlCharacter':
      case 'getLeaderCharacter':
        return this.handle(this.ensureControl());
      case 'getPartyCharacter':
        return num(a[0]) === 0 ? this.handle(this.ensureControl()) : this.handle(this.actor(-1, num(a[0])));
      case 'setControlCharacter': {
        const c = this.actorOf(a[0]);
        if (!c || c === this.control) return;
        this.control = c;
        let done = false;
        void c.ready.then(() => {
          done = true;
          if (this.control === c && !this.disposed) this.world.setPlayerBody(c.character);
        });
        t?.waitFor(() => done);
        return;
      }
      case 'hasPartyCharacter':
        return false;
      case 'getEscapePartyCharacterIndex':
        return -1;
      case 'openPartyEditMenu':
        this.world.openPartyMenu?.();
        return;
      case 'loadPartyCharacter':
      case 'escapePartyCharacter':
      case 'rejoinEscapePartyCharacter':
      case 'setForceOpenPartyEditFlag':
        return;
      case 'getForceOpenPartyEditFlag':
        return false;

      // gimmicks, triggers, effects
      case 'getGimmick':
        t?.resumeWith({ __handle: `g:${str(a[0])}` });
        return;
      case 'getTrigger': {
        const key = str(a[0]);
        return { __handle: `t:${key}` };
      }
      case 'playEffect':
      case 'attachPlayEffect':
      case 'createAndPlayEffect':
      case 'getEffect':
        return { __handle: `e:${++this.effectSeq}` };
      case 'loadEffects':
      case 'createCharacterMoveStopper':
      case 'destroyCharacterMoveStopper':
        return;

      // sound, music, movies
      case 'playBGM': {
        const id = str(a[1]);
        const b = this.content.bgm?.[id];
        if (!id) return;
        const track: MusicTrack = { id, title: id, url: b?.url ?? `/arc/05-Music-FLAC/${id}.flac`, loopStart: b?.loopStart ?? null, loopEnd: b?.loopEnd ?? null };
        this.world.music.mapTrack(track);
        return;
      }
      case 'stopBGM':
        this.world.music.mapTrack(null);
        return;
      case 'onFinishedBGM':
        return;
      case 'playSE':
      case 'playDungeonSE': {
        const url = this.content.se?.[str(a[0])];
        if (url && !this.fast) this.world.sfx.play(url);
        return;
      }
      case 'playLoopSE': {
        const url = this.content.se?.[str(a[0])];
        if (url) this.world.sfx.loop(url, num(a[1]));
        return;
      }
      case 'stopLoopSE':
        this.world.sfx.stopSlot(num(a[0]));
        return;
      case 'setSEVolume':
        this.world.sfx.volume = Math.max(0, Math.min(1, num(a[0], 1))) * 0.8;
        return;
      case 'playMovie': {
        const url = this.content.movies?.[str(a[0])];
        if (!url || !t || this.fast) return;
        let done = false;
        void o.playMovie(url).then(() => (done = true));
        t.waitFor(() => done || this.fast);
        return;
      }

      // battles, dungeon changes
      case 'playBattle': {
        if (!t) return;
        const id = num(a[0]);
        const b = Object.values(this.content.battles ?? {}).find((v) => v.id === id);
        if (this.fast) {
          t.resumeWith(true);
          return;
        }
        let won: boolean | null = null;
        void this.world
          .battle(id, b?.battleIds ?? [])
          .catch((e) => (console.warn('[story] battle failed', e), true))
          .then((w) => (won = w));
        t.waitFor(() => {
          if (won === null) return false;
          t.resumeWith(won);
          return true;
        });
        return;
      }
      case 'changeBattleField':
        this.world.setBattleField(num(a[0]) || null);
        return;
      case 'resetBattleField':
        this.world.setBattleField(null);
        return;
      case 'playMiniGame':
        t?.resumeWith(true);
        return;
      case 'changeDungeon': {
        if (this.rehearsing) {
          // Replay prelude: stop this script here instead of leaving the map.
          this.exitRequested = true;
          if (t) {
            t.waitFor(() => false);
            queueMicrotask(() => t.kill());
          }
          return;
        }
        this.leaving = true;
        const [m, c, sp] = [num(a[0]), num(a[1]), num(a[2])];
        queueMicrotask(() => this.world.changeDungeon(m, c, sp));
        t?.waitFor(() => false);
        return;
      }
      case 'clearDungeon':
        if (this.rehearsing) return;
        this.leaving = true;
        queueMicrotask(() => this.world.clearDungeon());
        return;
      case 'gameoverDungeon':
        this.world.toast('Game over (battle lost)');
        return;

      // ids and info
      case 'getDungeonMapId':
        return this.content.mapId;
      case 'getDungeonContentId':
        return this.content.contentId;
      case 'isTutorial':
        return false;
      case 'log':
        console.debug('[lua]', ...a);
        return;
      case 'getWanderingChocoboCharacterNovelSetIds':
        return [];
      case 'getTalkChocoboCharacterNovelSetId':
      case 'getChocoboExpeditionRewardCountType':
        return 0;
      case 'isAchievedChocoboSpecialTalkConditions':
      case 'hasChocoboFarmEventTreasure':
      case 'canExecuteChocoboTutorial':
      case 'canExecuteChocoboExchangeTutorial':
        return false;
      default:
        if (SILENT_NATIVES.has(name)) return;
        if (!this.warned.has(name)) {
          this.warned.add(name);
          console.debug(`[story] dungeon.${name} not implemented`, a);
        }
        return;
    }
  }

  // ------------------------------------------------------------------ Lua host: object methods

  method(id: string, name: string, a: LuaValue[], t: ScriptThread | null): LuaValue | void {
    const kind = id.slice(0, 2);
    const key = id.slice(2);
    if (kind === 'g:') {
      if (name === 'setStatus') this.setGimmick(key, str(a[0]), true);
      else if (name === 'setStatusImmediate') this.setGimmick(key, str(a[0]), false);
      return;
    }
    if (kind === 't:') {
      const trig = this.triggers.find((x) => String(x.def.triggerId) === key || x.def.object === key);
      if (name === 'setActive' && trig) {
        trig.enabled = bool(a[0], true);
        this.checkCache.clear();
      }
      if (name === 'getActive') return trig?.enabled ?? false;
      return;
    }
    if (kind === 'e:') return; // effects are not converted
    const c = this.actors.get(key);
    if (!c) return;
    return this.characterMethod(c, name, a, t);
  }

  private characterMethod(c: Actor, name: string, a: LuaValue[], t: ScriptThread | null): LuaValue | void {
    const fast = this.fast;
    const layerName = /^(?:play|stop|forceIdle|onFinished|wait)(Upper|Neck|Arm|Lower|Unique)/.exec(name)?.[1];
    const layer = layerName ? c.layer(LAYER_OF[layerName]) : null;
    switch (name) {
      // transform
      case 'setVisible':
        c.visible = bool(a[0], true);
        c.apply();
        return;
      case 'setAngle':
        c.yaw = a.length >= 3 ? yawOf(a[1]) : yawOf(a[0]);
        c.turn = null;
        return;
      case 'setGravityMode':
        c.gravity = bool(a[0], true);
        return;
      case 'setScale':
        c.scale.set(num(a[0], 1), num(a[1], num(a[0], 1)), num(a[2], num(a[0], 1)));
        return;
      case 'warp':
        c.warp(U(a[0], a[1], a[2]));
        c.apply();
        return;
      case 'warpStartPoint': {
        const sp = this.content.startPoints?.find((s) => s.index === num(a[0])) ?? this.content.startPoints?.[0];
        if (!sp?.position || !sp.quaternion) return;
        c.warp(new THREE.Vector3().fromArray(sp.position).add(U(a[1], a[2], a[3])));
        c.yaw = yawFromQuat(sp.quaternion);
        return;
      }
      case 'warpTarget': {
        const tg = this.actorOf(a[0]);
        if (tg) c.warp(tg.pos.clone().add(U(a[1], a[2], a[3])));
        return;
      }
      case 'trace': {
        const tg = this.actorOf(a[0]);
        if (tg) c.trace = { target: tg, offset: c.pos.clone().sub(tg.pos) };
        return;
      }
      case 'unTrace':
        c.trace = null;
        return;

      // movement
      case 'move':
        return c.moveTo([U(a[0], a[1], a[2])], num(a[3], 1));
      case 'moveRelative': {
        const off = handleOf(a[0]) ? U(a[1], a[2], a[3]) : U(a[0], a[1], a[2]);
        return c.moveTo([c.pos.clone().add(off.applyAxisAngle(Y, c.yaw))], num(handleOf(a[0]) ? a[4] : a[3], 1));
      }
      case 'moveRoute': {
        const pts = Array.isArray(a[0]) ? a[0].filter(Array.isArray).map((p) => U(p[0], p[1], p[2])) : [];
        return c.moveTo(pts, num(a[1], 1), str(a[2]) || 'none');
      }
      case 'tweenMove':
        return c.slideTo(U(a[0], a[1], a[2]), num(a[3]), a[4]);
      case 'approachMove':
        return;
      case 'stopMove':
        c.route = null;
        return;
      case 'stopTweenMove':
        c.slide = null;
        return;
      case 'onFinishedMove':
        t?.waitFor(() => (!c.route && !c.slide) || this.fast);
        return;

      // turning
      case 'turnAngle':
        return c.turnTo(yawOf(a[0]), num(a[1], 0.8));
      case 'lookAtAngle':
        return c.turnTo(yawOf(a[0]), 0.5);
      case 'turnPosition':
      case 'lookAtPosition': {
        const p = U(a[0], a[1], a[2]);
        return c.turnTo(Math.atan2(p.x - c.pos.x, p.z - c.pos.z), name === 'turnPosition' ? num(a[3], 0.8) : 0.5);
      }
      case 'turnTarget':
      case 'lookAtTarget': {
        const tg = this.actorOf(a[0]) ?? c;
        const base = tg === c ? c.yaw : Math.atan2(tg.pos.x - c.pos.x, tg.pos.z - c.pos.z);
        return c.turnTo(base + yawOf(a[1]), name === 'turnTarget' ? num(a[2], 0.8) : 0.5);
      }
      case 'tweenRotate':
        return c.turnTo(yawOf(a[1]), num(a[3], 0.5));
      case 'stopTurn':
      case 'stopLookAt':
        c.turn = null;
        return;
      case 'onFinishedTurn':
      case 'onFinishedLookAt':
        t?.waitFor(() => !c.turn || this.fast);
        return;

      // head IK. Offsets are relative to a point 1 m above the feet; aim that at face height instead.
      case 'lookAtIK': {
        const p = U(a[0], a[1], a[2]);
        return c.lookAt(() => p, num(a[3], -1));
      }
      case 'lookAtIKRelative': {
        const off = U(a[0], a[1], a[2]);
        return c.lookAt(() => c.pos.clone().add(off.clone().applyAxisAngle(Y, c.yaw)).addScaledVector(Y, c.height * FACE - 1), num(a[3], -1));
      }
      case 'lookAtIKTarget': {
        const tg = this.actorOf(a[0]);
        if (!tg) return;
        const off = U(a[1], a[2], a[3]);
        return c.lookAt(() => tg.pos.clone().add(off.clone().applyAxisAngle(Y, tg.yaw)).addScaledVector(Y, tg.height * FACE - 1), num(a[4], -1));
      }
      case 'resetLookAtIK':
        return c.lookAt(null, num(a[0], -1));
      case 'onFinishedLookAtIK':
        t?.waitFor(() => this.time >= c.lookUntil || this.fast);
        return;

      // actions
      case 'playAction': {
        const m = c.motion(str(a[0]));
        // A motion the export has no clip for still replaces whatever was playing (else a looping action
        // from an earlier script would hold the next onFinishedAction forever).
        if (m) c.base.start(m, num(a[1], -1), num(a[3], 1) <= 0, fast);
        else c.base.force();
        return;
      }
      case 'playActionLoopImmediate': {
        const m = c.motion(str(a[0]));
        if (m) c.base.start(m, -1, true, fast);
        else c.base.force();
        return;
      }
      case 'stopAction':
      case 'stopActionWithSpeed':
        return c.base.stop(fast);
      case 'forceIdle':
        return c.base.force();
      case 'waitAnimatorStatusUntilTo': {
        const st = str(a[0]);
        t?.waitFor(() => c.base.reached(st) || this.fast);
        return;
      }
      case 'onFinishedAction':
        t?.waitFor(() => c.base.phase === 'Idle' || this.fast);
        return;

      // talk
      case 'talk':
        return this.talk(c, c.name, str(a[0]), num(a[1]), num(a[2]), bool(a[3], true), str(a[4]), num(a[6]));
      case 'talkCustom':
        return this.talk(c, str(a[0]), str(a[1]), num(a[2]), num(a[3]), bool(a[4], true), str(a[5]), num(a[7]));
      case 'talkSimple':
        return this.talk(c, '', str(a[0]), num(a[1]), num(a[2]), bool(a[3], true), str(a[4]), num(a[6]));
      case 'closeTalk':
        return this.closeTalk(c, typeof a[0] === 'number' ? a[0] : null);
      case 'screenTalk':
      case 'screenTalkCustom': {
        if (fast) return;
        const custom = name === 'screenTalkCustom';
        this.world.overlay.showTalk(custom ? str(a[0]) : c.name, str(custom ? a[1] : a[0]));
        this.talk2dAuto = bool(custom ? a[2] : a[1], true);
        return;
      }
      case 'closeScreenTalk':
        this.world.overlay.hideTalk();
        return;

      // fades
      case 'fadeIn':
        return c.fade(true, num(a[0], 0.5));
      case 'fadeOut':
        return c.fade(false, num(a[0], 0.5));
      case 'onFinishedFadeIn':
      case 'onFinishedFadeOut':
        t?.waitFor(() => this.time >= c.fadeUntil || this.fast);
        return;

      case 'setUseUpdateUpAxis':
      case 'setUseHorizontalFloorTransformName':
      case 'setSpringManagerBlendRate':
      case 'setCharacterAnimationEventEnabled':
      case 'setMouthFacial':
      case 'setEyeFacial':
      case 'setupDynamicCustomTransform':
      case 'getTransform':
      case 'loadAction':
      case 'loadActions':
        return;
    }
    if (layer && layerName) {
      const verb = name.slice(0, name.indexOf(layerName));
      if (verb === 'play') {
        const m = c.motion(str(a[0]));
        if (m) layer.start(m, num(a[1], -1), name.endsWith('LoopImmediate') || num(a[2], 1) <= 0, fast);
        else layer.force();
      } else if (verb === 'stop') layer.stop(fast);
      else if (verb === 'forceIdle') layer.force();
      else if (verb === 'onFinished') t?.waitFor(() => layer.phase === 'Idle' || this.fast);
      else if (verb === 'wait') {
        const st = str(a[0]);
        t?.waitFor(() => layer.reached(st) || this.fast);
      }
      return;
    }
    if (!this.warned.has(name)) {
      this.warned.add(name);
      console.debug(`[story] character.${name} not implemented`, a);
    }
  }

  dispose() {
    this.disposed = true;
    this.world.setPlayerBody(null);
    this.vm.killAll();
    for (const env of this.checkEnvs.values()) this.vm.unref(env);
    for (const a of this.actors.values()) a.dispose();
    this.actors.clear();
    this.group.removeFromParent();
    this.world.rig.script.target = null;
    this.world.rig.script.fov = null;
    this.world.overlay.reset();
    this.world.sfx.stopAll();
  }
}

