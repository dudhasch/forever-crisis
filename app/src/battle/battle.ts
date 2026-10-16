import * as THREE from 'three';
import { tryJSON } from '../assets';
import type { Music } from '../audio';
import { Character, loadClip } from '../player/character';
import { weaponsFor, weaponsManifest, type WeaponEntry } from '../player/weapon';
import type { SoundEffects } from '../story/overlay';
import type { AnimIndex, MapEntry, MusicTrack } from '../types';
import { GameMap } from '../world/map';
import { Brain } from './ai';
import {
  battleData,
  ELEMENT_COLORS,
  STATUS_NAMES,
  type BattleData,
  type BattleDefinition,
  type CharacterDef,
  type ClipRef,
  type EnemyDef,
  type Skill,
  type SkillEffect,
  type WeaponDef,
  type Zone,
} from './data';
import { setGamepadProfile } from '../game/gamepad';
import { Effects } from './effects';
import { BattleHud, type CommandView, type MenuItem, type MenuPanel } from './hud';
import { slotOf, trackInputMode } from './input';
import {
  calibrate,
  characterStats,
  enemyStats,
  ENEMY_ATB_SECONDS,
  enemyDamageScale,
  fairLevel,
  limitGain,
  mpCost,
  PARTY_ATB_SECONDS,
  partyLevelOffset,
  resolve,
  targetsAll,
  targetsAllies,
  targetType,
  type BattleSettings,
  type Combatant,
  type Stats,
} from './rules';

// ------------------------------------------------------------------------------------------- requests

export interface BattleRequest {
  /** m_battle id (story battles: their StoryPartyBattleId). */
  battleId: number;
  /** m_story_episode id whose story party fights. */
  episode?: string | null;
  /** Field map the battle starts from (its default battle stage). */
  mapKey?: string | null;
  /** Lua changeBattleField override. */
  field?: number | null;
  /** Random encounters can be escaped from. */
  escapable?: boolean;
  /** Free Roam: the menu's party (character ids) instead of the story's. */
  party?: number[];
}

/** won; skipped = lost but the player chose to carry on; retry = lost, fight again; escaped. */
export type BattleOutcome = 'won' | 'skipped' | 'retry' | 'escaped';

export interface BattleHost {
  renderer: THREE.WebGLRenderer;
  mapsByKey: Map<string, MapEntry>;
  music: Music;
  sfx: SoundEffects;
  tracks: MusicTrack[];
  uiRoot: HTMLElement;
  settings: BattleSettings;
  /** The save game (src/game): gear, materia and items. Without it the battle uses built-in defaults. */
  game?: BattleGame;
  /** Full-screen movie (summons play theirs before their effects). */
  playMovie?: (url: string) => Promise<void>;
}

/** What the save game decides for one character in this battle. */
export interface BattleLoadout {
  stats: Stats;
  weaponId?: number;
  model?: string | null;
  /** battle spell ids (index.spells[].id) from equipped materia */
  spells: string[];
  summons: number[];
  /** C.Ability skill keys */
  abilities: string[];
  /** element -> extra damage share from outfit passives */
  elements: Record<string, number>;
  /** buff names to start with (jellies used in the field) */
  buffs: string[];
  /** HP / MP carried over from the last battle, as shares of the maximum */
  hp: number;
  mp: number;
}

export interface BattleGame {
  loadout(c: CharacterDef, level: number): BattleLoadout | null;
  items(): ItemDef[];
  itemCount(id: string): number;
  consumeItem(id: string): void;
  /** An item id an enemy of this level may drop, or null. */
  drop(level: number): string | null;
  /** Battle won: grant rewards; returns what the victory window lists. */
  won(battleId: number, enemyLevels: number[], partyLevel: number, loot: string[]): { gil: number; exp: number; items: string[]; level?: number };
  /** Battle over (any outcome): the party's HP/MP to carry on. */
  ended(party: { id: number; hp: number; mp: number; alive: boolean }[], outcome: BattleOutcome): void;
  /** The character's four shortcut skills (skill keys, null = empty), or null when none are saved yet. */
  shortcuts?(charId: number): (string | null)[] | null;
  setShortcuts?(charId: number, keys: (string | null)[]): void;
}

const SE = {
  encounter: '/arc/08-Audio-Extracted/se_ui_common/0013_se_ui_battle_encount_01.flac',
  cursor: '/arc/08-Audio-Extracted/se_ui_common/0106_se_ui_common_select_01.flac',
  decide: '/arc/08-Audio-Extracted/se_ui_common/0008_se_ui_battle_commandbutton_01.flac',
  cancel: '/arc/08-Audio-Extracted/se_ui_common/0056_se_ui_common_cancel_01.flac',
  atbFull: '/arc/08-Audio-Extracted/se_ui_common/0020_se_ui_battle_gauge_atb_charge_full.flac',
  limitFull: '/arc/08-Audio-Extracted/se_ui_common/0021_se_ui_battle_gauge_limit_charge_full.flac',
  finish: '/arc/08-Audio-Extracted/se_ui_common/0023_se_ui_battle_finish_01.flac',
  wave: '/arc/08-Audio-Extracted/se_ui_common/0044_se_ui_battle_wavechange_01.flac',
  gameover: '/arc/08-Audio-Extracted/se_ui_common/0016_se_ui_battle_gameover_01.flac',
  item: '/arc/08-Audio-Extracted/se_ui_common/0124_se_ui_result_itemget_01.flac',
  hit: '/arc/08-Audio-Extracted/se_battle_common/0026_se_battle_common_hit_blow_01.flac',
  slash: '/arc/08-Audio-Extracted/se_battle_common/0052_se_battle_common_hit_slash_01; se_battle_common_hit_slashlarge_01.flac',
  buff: '/arc/08-Audio-Extracted/se_battle_common/0018_se_battle_common_invoke_buff_01.flac',
  debuff: '/arc/08-Audio-Extracted/se_battle_common/0017_se_battle_common_invoke_debuff_01.flac',
  explosion: '/arc/08-Audio-Extracted/se_battle_common/0041_se_battle_common_hit_explosion_02.flac',
};
const DEFAULT_BGM = 'bgm_ff7_010';
const FANFARE = 'bgm_ff7_011';
const DEFAULT_PARTY = [1, 2, 3];

// ------------------------------------------------------------------------------------------- items

export interface ItemDef {
  id: string;
  name: string;
  help: string;
  target: 'ally' | 'dead' | 'enemies' | 'allies';
  use: (b: Battle, user: Fighter, target: Fighter[]) => void;
  /** Shown but not usable here. */
  disabled?: boolean;
}

const ITEMS: ItemDef[] = [
  { id: 'potion', name: 'Potion', help: 'Restores 30% HP', target: 'ally', use: (b, _u, t) => t.forEach((f) => b.restore(f, Math.max(100, f.stats.hp * 0.3), 0)) },
  { id: 'hipotion', name: 'Hi-Potion', help: 'Restores 60% HP', target: 'ally', use: (b, _u, t) => t.forEach((f) => b.restore(f, Math.max(500, f.stats.hp * 0.6), 0)) },
  { id: 'phoenix', name: 'Phoenix Down', help: 'Revives a fallen ally', target: 'dead', use: (b, _u, t) => t.forEach((f) => b.revive(f, 0.3)) },
  { id: 'ether', name: 'Ether', help: 'Restores 50 MP', target: 'ally', use: (b, _u, t) => t.forEach((f) => b.restore(f, 0, 50)) },
  { id: 'turboether', name: 'Turbo Ether', help: 'Restores all MP', target: 'ally', use: (b, _u, t) => t.forEach((f) => b.restore(f, 0, f.stats.mp)) },
  { id: 'elixir', name: 'Elixir', help: 'Restores all HP and MP', target: 'ally', use: (b, _u, t) => t.forEach((f) => b.restore(f, f.stats.hp, f.stats.mp)) },
  { id: 'firecocktail', name: 'Fire Cocktail', help: 'Fire damage to all enemies', target: 'enemies', use: (b, u, t) => b.itemDamage(u, t, 2) },
  { id: 'blizzardcocktail', name: 'Blizzard Cocktail', help: 'Ice damage to all enemies', target: 'enemies', use: (b, u, t) => b.itemDamage(u, t, 3) },
  { id: 'thundercocktail', name: 'Thunder Cocktail', help: 'Lightning damage to all enemies', target: 'enemies', use: (b, u, t) => b.itemDamage(u, t, 4) },
];
const START_ITEMS: Record<string, number> = { potion: 15, hipotion: 3, phoenix: 5, ether: 6, turboether: 1, elixir: 2, firecocktail: 2, blizzardcocktail: 2, thundercocktail: 2 };
const ITEMS_KEY = 'ff7ec.battleItems';
/** Shortcuts without a save game (the battle viewer): per character id. */
const SHORTCUTS_KEY = 'ff7ec.battleShortcuts'; // gitleaks:allow (a localStorage key)
export const SHORTCUT_SLOTS = 4;
/** Guard: damage taken until the character's next turn (Remake's guard cuts most of a hit). */
const GUARD_TAKEN = 0.5;
const GUARD_TINT = new THREE.Color(0x0c4652);

function loadItems(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ITEMS_KEY);
    if (raw) return { ...START_ITEMS, ...(JSON.parse(raw) as Record<string, number>) };
  } catch {
    /* private mode */
  }
  return { ...START_ITEMS };
}
function saveItems(items: Record<string, number>) {
  try {
    localStorage.setItem(ITEMS_KEY, JSON.stringify(items));
  } catch {
    /* private mode */
  }
}

// ------------------------------------------------------------------------------------------- clips

let animIndex: Promise<AnimIndex | null> | null = null;
const familyClipCache = new Map<string, Promise<Map<string, string>>>();
/** clip name -> file of an animation family ("monster/002"). */
function familyClips(family: string | null) {
  if (!family) return Promise.resolve(new Map<string, string>());
  let p = familyClipCache.get(family);
  if (!p) {
    animIndex ??= tryJSON<AnimIndex>('/gen/anims/index.json');
    p = animIndex.then((idx) => new Map((idx?.families[family]?.clips ?? []).map((c) => [c.name, c.file] as [string, string])));
    familyClipCache.set(family, p);
  }
  return p;
}

const warned = new Set<string>();
function warnOnce(msg: string) {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(msg);
}

function findClip(clips: Map<string, string>, re: RegExp): ClipRef | undefined {
  for (const [name, file] of clips) if (re.test(name)) return { name, file };
  return undefined;
}

// ------------------------------------------------------------------------------------------- fighters

export class Fighter implements Combatant {
  side: 'party' | 'enemy';
  name: string;
  char: Character;
  stats: Stats;
  hp: number;
  mp: number;
  atb: number;
  limit = 0;
  level: number;
  buffs = new Map<string, { level: number; until: number }>();
  statuses = new Map<number, number>();
  resist?: Record<string, number>;
  physCut?: number;
  magCut?: number;
  crit?: number;
  home = new THREE.Vector3();
  homeYaw = 0;
  radius = 0.6;
  alive = true;
  /** Waiting for a command (party) or in the action queue. */
  ready = false;
  queued = false;
  acting = false;
  /** Guard: spent the turn to take less damage until the gauge fills again. */
  guarding = false;
  removed = false;
  turns = 0;
  brain: Brain | null = null;
  enemy?: EnemyDef;
  def?: CharacterDef;
  weapon?: WeaponDef;
  /** From the save game: equipped materia spells, summons, C.Abilities, outfit element boosts. */
  spellIds?: string[];
  summonIds?: number[];
  abilityKeys?: string[];
  elementBoost?: Record<string, number>;
  charId = 0;
  skills: string[] = [];
  clips = new Map<string, string>();
  moveSpeed = 0;
  private move: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; done: () => void } | null = null;
  private reactToken = 0;
  private poisonTick = 0;
  fade = 1;

  constructor(side: 'party' | 'enemy', name: string, char: Character, stats: Stats, level: number) {
    this.side = side;
    this.name = name;
    this.char = char;
    this.stats = stats;
    this.hp = stats.hp;
    this.mp = stats.mp;
    this.level = level;
    this.atb = Math.random() * 0.5;
    const box = new THREE.Box3().setFromObject(char.model);
    if (!box.isEmpty()) this.radius = Math.max(0.4, Math.min(4, Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.5));
  }

  get height() {
    return this.char.height;
  }

  /** World point at about chest height (numbers, sparks, cursor). */
  chest(out = new THREE.Vector3()) {
    return out.copy(this.char.root.position).add(new THREE.Vector3(0, this.height * 0.6, 0));
  }

  top(out = new THREE.Vector3()) {
    return out.copy(this.char.root.position).add(new THREE.Vector3(0, this.height + 0.15, 0));
  }

  faceTo(p: THREE.Vector3) {
    const d = p.clone().sub(this.char.root.position);
    if (d.lengthSq() > 1e-6) this.char.root.rotation.y = Math.atan2(d.x, d.z);
  }

  runTo(p: THREE.Vector3, speed = 7): Promise<void> {
    const from = this.char.root.position.clone();
    const dist = from.distanceTo(p);
    if (dist < 0.05) return Promise.resolve();
    this.char.stopMotion(0.1);
    this.faceTo(p);
    return new Promise((done) => (this.move = { from, to: p.clone(), t: 0, dur: dist / speed, done }));
  }

  update(dt: number) {
    if (this.move) {
      const m = this.move;
      m.t += dt;
      const k = Math.min(1, m.t / m.dur);
      this.char.root.position.lerpVectors(m.from, m.to, k);
      this.moveSpeed = m.from.distanceTo(m.to) / m.dur;
      if (k >= 1) {
        this.move = null;
        this.moveSpeed = 0;
        m.done();
      }
    }
    this.char.update(dt, this.moveSpeed);
  }

  async playClip(ref: ClipRef | undefined, loop = false, blend = 0.12): Promise<number> {
    if (!ref) return 0;
    if (!ref.file) {
      warnOnce(`battle: ${this.name}: clip ${ref.name} is not converted (npm run extract:anims -- --scope all)`);
      return 0;
    }
    const clip = await loadClip(ref.file).catch((e) => {
      warnOnce(`battle: ${this.name}: /gen/anims/${ref.file} failed to load: ${e}`);
      return null;
    });
    if (!clip) return 0;
    const ok = await this.char.playMotion(ref.file, { loop, blend });
    return ok ? clip.duration : 0;
  }

  clip(re: RegExp) {
    return findClip(this.clips, re);
  }

  /** Flinch, unless busy with its own move. */
  react() {
    if (!this.alive || this.acting || this.guarding) return;
    const ref = this.clip(/_damage_f_001$/) ?? this.clip(/_damage_f_00\d$/);
    if (!ref) return;
    const token = ++this.reactToken;
    void this.playClip(ref, false, 0.05).then((d) =>
      setTimeout(() => {
        if (token === this.reactToken && this.alive && !this.acting) this.char.stopMotion(0.2);
      }, Math.max(200, d * 1000 - 100)),
    );
  }

  cancelReact() {
    this.reactToken++;
  }

  hasStatus(s: number) {
    return this.statuses.has(s);
  }

  /** Expire statuses and buffs, apply poison. Returns poison damage dealt this tick. */
  tick(time: number, dt: number) {
    for (const [s, until] of this.statuses) if (time >= until) this.statuses.delete(s);
    for (const [b, v] of this.buffs) if (time >= v.until) this.buffs.delete(b);
    if (this.statuses.has(1) && this.alive) {
      this.poisonTick += dt;
      if (this.poisonTick >= 3) {
        this.poisonTick = 0;
        return Math.max(1, Math.round(this.stats.hp * 0.04));
      }
    }
    return 0;
  }

  statusLabels() {
    return [...this.statuses.keys()].map((s) => STATUS_NAMES[s]).filter(Boolean);
  }
}

// ------------------------------------------------------------------------------------------- menus

interface Entry {
  item: MenuItem;
  run: () => void;
  /** Skill key: abilities and spells can be put on a shortcut. */
  key?: string;
}

/**
 * command: a character's turn (its gauge is full). `open` = Remake's command list is up (Abilities, Magic, …);
 * closed, the player can Attack, Guard, fire a shortcut or open the list. list: a sub-list. target: the cursor.
 */
type Menu =
  | { kind: 'command'; actor: Fighter; cursor: number; entries: Entry[]; open: boolean }
  | { kind: 'list'; actor: Fighter; title: string; cursor: number; entries: Entry[]; back: Menu; columns?: number }
  | { kind: 'target'; actor: Fighter; cursor: number; pool: Fighter[]; all: boolean; back: Menu; pick: (t: Fighter[]) => void; help: string };

interface QueueEntry {
  actor: Fighter;
  skill?: string;
  item?: ItemDef;
  targets: Fighter[];
}

// ------------------------------------------------------------------------------------------- battle

export class Battle {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 3000);
  readonly hud: BattleHud;
  private stage: GameMap | null = null;
  private effects = new Effects();
  /** The running action plays EC effects (generated/effects), so the stand-in sparks stay off. */
  private ecAction = false;
  /** Party members whose animation family lacks battle skill clips (partial anims extract). */
  private missingSkillClips: string[] = [];
  private data!: BattleData;
  private def!: BattleDefinition;
  party: Fighter[] = [];
  enemies: Fighter[] = [];
  private wave = 0;
  /** For bug reports: the battle id and the current wave (0-based). */
  get battleId() {
    return this.req.battleId;
  }
  get waveIndex() {
    return this.wave;
  }
  private zones: { party: Zone[]; opponents: Record<string, Zone[]> } = { party: [], opponents: {} };
  private queue: QueueEntry[] = [];
  private executing = false;
  private menu: Menu | null = null;
  private readyOrder: Fighter[] = [];
  private time = 0;
  private realTime = 0;
  private waits: { at: number; done: () => void }[] = [];
  private items = loadItems();
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private focus: { from: Fighter; to: Fighter[] } | null = null;
  private shake = 0;
  private finished = false;
  private resolveOutcome!: (o: BattleOutcome) => void;
  readonly outcome: Promise<BattleOutcome>;
  private modal: { buttons: string[]; cursor: number; pick: (i: number) => void } | null = null;
  private escapeHeld = 0;
  private loot: string[] = [];
  private prevMusic: { track: MusicTrack | null; pinned: boolean } | null = null;
  title = '';
  ready = false;
  /** Pause menu open: time, gauges and animations stand still (main.ts stops calling update). */
  paused = false;
  private over = false;
  /** The enemy Attack and single-target shortcuts hit (Remake's lock-on); the target window shows it. */
  private lockOn: Fighter | null = null;
  /** charId -> four skill keys on the shortcut palette */
  private shortcuts = new Map<number, (string | null)[]>();
  private guardFx = new Map<Fighter, { shell: THREE.Mesh; tinted: { m: THREE.MeshStandardMaterial; e: THREE.Color }[] }>();
  private offCanvas: () => void;

  private constructor(
    private readonly host: BattleHost,
    private readonly req: BattleRequest,
  ) {
    this.hud = new BattleHud(host.uiRoot);
    this.hud.onMenuClick = (panel, i) => this.clickMenu(panel, i);
    this.hud.onMenuHover = (panel, i) => this.hoverMenu(panel, i);
    this.hud.onModalPick = (i) => this.modal?.pick(i);
    this.hud.onModeChange = () => this.showMenu();
    this.hud.onHint = (a) => this.hint(a);
    this.outcome = new Promise((r) => (this.resolveOutcome = r));
    this.scene.add(this.effects.group);
    trackInputMode();
    setGamepadProfile('battle');
    // right click opens / closes the command list (left click is Attack, see click())
    const canvas = host.renderer.domElement;
    const menu = (e: MouseEvent) => {
      e.preventDefault();
      this.toggleCommands();
    };
    canvas.addEventListener('contextmenu', menu);
    this.offCanvas = () => canvas.removeEventListener('contextmenu', menu);
  }

  /** Load the stage and fighters. Resolves once the battle is on screen. */
  static async create(host: BattleHost, req: BattleRequest, progress: (m: string) => void): Promise<Battle> {
    const b = new Battle(host, req);
    b.hud.setSwirl(true);
    host.sfx.play(SE.encounter);
    try {
      await b.load(progress);
    } catch (e) {
      b.dispose();
      throw e;
    }
    b.hud.setSwirl(false);
    b.ready = true;
    return b;
  }

  private async load(progress: (m: string) => void) {
    this.data = await battleData();
    calibrate(this.data.index);
    const def = this.data.battles[String(this.req.battleId)];
    if (!def) throw new Error(`battle ${this.req.battleId} is not in generated/battle`);
    this.def = def;
    // stage: battle's own environment, else the field's override, else the map's default battle field
    const env = def.environment ?? this.req.field ?? (this.req.mapKey ? this.data.maps[this.req.mapKey] : undefined) ?? 7;
    const key = `environment_${String(env).padStart(4, '0')}`;
    const entry = this.host.mapsByKey.get(key) ?? this.host.mapsByKey.get('environment_0007');
    if (entry) {
      progress('Loading battle stage…');
      this.stage = await GameMap.load(entry, progress);
      this.scene.add(this.stage.group);
      this.scene.background = this.stage.backgroundColor;
      this.scene.environment = this.stage.environment(this.host.renderer);
      void this.effects.stage(env, null);
      void this.effects.preloadCommon();
    } else {
      this.scene.background = new THREE.Color(0x101820);
      this.scene.add(new THREE.HemisphereLight(0xc0d0ff, 0x302820, 1.2));
    }
    const st = this.data.stages[String(env)];
    const area = st?.areas[Math.min(def.area || st.defaultArea || 0, st.areas.length - 1)];
    this.zones = { party: [], opponents: area?.opponents ?? {} };
    progress('Assembling the party…');
    await this.loadParty(area?.own ?? {});
    for (const f of this.party) this.shortcuts.set(f.charId, this.loadShortcuts(f));
    if (this.missingSkillClips.length)
      this.hud.notify('warning', `No skill animations for ${this.missingSkillClips.join(', ')}: run npm run extract:anims -- --scope all`);
    progress('Enemies approaching…');
    await this.loadWave(0);
    this.title = def.waves[0].enemies.map((e) => this.data.enemies[e.enemy]?.name ?? '?').filter((n, i, a) => a.indexOf(n) === i).join(', ');
    // music: wave or enemy BGM, else the battle's, else FF7's battle theme
    const enemyBgm = def.waves[0].enemies.map((e) => this.data.enemies[e.enemy]?.bgm).find(Boolean);
    this.playMusic(def.waves[0].bgm ?? enemyBgm ?? def.bgm ?? DEFAULT_BGM);
    this.resetCamera(true);
  }

  private playMusic(id: string) {
    const m = this.host.music;
    this.prevMusic ??= { track: m.current, pinned: m.pinned };
    const t = this.host.tracks.find((x) => x.id === id) ?? { id, url: `/arc/05-Music-FLAC/${id}.flac`, title: id };
    m.play(t, { pin: m.pinned });
  }

  // ------------------------------------------------------------------ setup
  private partyMembers(): { def: CharacterDef; weaponId?: number }[] {
    const idx = this.data.index;
    const ep = (this.def.storyBattle ? idx.partyOfStoryBattle[String(this.def.storyBattle)] : undefined) ?? this.req.episode;
    const party = ep ? idx.parties[ep] : undefined;
    const out: { def: CharacterDef; weaponId?: number }[] = [];
    for (const id of this.req.party ?? []) {
      const d = idx.characters[String(id)];
      if (d?.model && out.length < 3 && !out.some((o) => o.def.id === d.id)) out.push({ def: d });
    }
    if (party && !out.length) {
      const members = [...party.members].sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.slot - b.slot);
      for (const m of members) {
        const d = idx.characters[String(m.character)];
        if (d?.model && !out.some((o) => o.def.id === d.id)) out.push({ def: d, weaponId: m.weapon });
        if (out.length >= Math.min(3, party.count || 3)) break;
      }
    }
    if (!out.length) for (const id of DEFAULT_PARTY) if (idx.characters[String(id)]?.model) out.push({ def: idx.characters[String(id)] });
    return out;
  }

  private async loadParty(own: Record<string, Zone[]>) {
    const members = this.partyMembers();
    const levels = this.def.waves.flatMap((w) => w.enemies.map((e) => this.data.enemies[e.enemy]?.level ?? 1));
    const level = fairLevel(levels, partyLevelOffset(this.host.settings));
    const zones = own[['one', 'two', 'three'][members.length - 1]] ?? [];
    const wm = await weaponsManifest();
    await Promise.all(
      members.map(async (m, i) => {
        const d = m.def;
        const lo = this.host.game?.loadout(d, level) ?? null;
        const weapon = d.weapons.find((w) => w.id === (lo?.weaponId ?? m.weaponId ?? d.defaultWeapon)) ?? d.weapons[0];
        const model = lo?.model ?? d.model!;
        const char = await Character.load(model, { outline: true }).catch(() => Character.load(d.model!, { outline: true }));
        const f = new Fighter('party', d.name, char, lo?.stats ?? characterStats(d, level, weapon), level);
        f.def = d;
        f.charId = d.id;
        f.weapon = weapon;
        if (lo) {
          f.spellIds = lo.spells;
          f.summonIds = lo.summons;
          f.abilityKeys = lo.abilities;
          f.elementBoost = lo.elements;
          f.hp = Math.max(1, Math.round(f.stats.hp * lo.hp));
          f.mp = Math.round(f.stats.mp * lo.mp);
          for (const b of lo.buffs) f.buffs.set(b, { level: 3, until: 90 });
        }
        f.clips = await familyClips(d.family);
        if (![...f.clips.keys()].some((n) => n.includes('_skill_'))) {
          warnOnce(`battle: /gen/anims/index.json has no _skill_ clips for ${d.family} (a partial extract?)`);
          this.missingSkillClips.push(f.name);
        }
        const info = await weaponsFor(model);
        const entry = (weapon?.glb && wm?.byCharacter[d.key]?.find((w) => w.id === weapon.glb)) || (info?.defaultId ? info.list.find((w) => w.id === info.defaultId) : undefined);
        if (info) await char.setWeapons(entry ?? null, info.extras, info.equipPoints);
        const z = zones[i] ?? { p: [(i - (members.length - 1) / 2) * 2.6, 0, -1.5], yaw: 0 };
        f.home.fromArray(z.p);
        f.homeYaw = (z.yaw * Math.PI) / 180;
        char.root.position.copy(f.home);
        char.root.rotation.y = f.homeYaw;
        this.scene.add(char.root);
        this.party[i] = f;
      }),
    );
    this.party = this.party.filter(Boolean);
  }

  private async loadWave(n: number) {
    this.wave = n;
    const wave = this.def.waves[n];
    const wm = await weaponsManifest();
    const loaded = await Promise.all(
      wave.enemies.map(async (we) => {
        const e = this.data.enemies[we.enemy];
        if (!e) return null;
        // Enemies without a model of their own (the Left/Right Hand parts of Buno D'rhad use a prefab that
        // was never converted) stand in as a half-size copy of the wave's main model so they still fight.
        const stand = e.model ? null : wave.enemies.map((x) => this.data.enemies[x.enemy]).find((x) => x?.model);
        const model = e.model ?? stand?.model;
        const char = model ? await Character.load(model, { outline: true }).catch(() => null) : null;
        if (!char) return null;
        if (stand) {
          char.root.scale.setScalar(0.5);
          char.height *= 0.5;
        }
        const f = new Fighter('enemy', e.name, char, enemyStats(e), e.level);
        f.enemy = e;
        f.resist = e.elements;
        f.physCut = e.physCut;
        f.magCut = e.magCut;
        f.crit = e.crit;
        f.skills = [...e.skills, ...(e.aiSkills ?? [])].filter((k) => this.data.skills[k]);
        f.clips = await familyClips(e.family ?? stand?.family ?? null);
        const brain = e.brain ? this.data.brains[e.brain] : undefined;
        if (brain) f.brain = new Brain(brain);
        if (e.weapon) {
          const owner = e.weapon.split('_')[0];
          const w: WeaponEntry | undefined = wm?.byCharacter[owner]?.find((x) => x.id === e.weapon);
          if (w) await char.setWeapons(w, [], {});
        }
        f.atb = Math.random() * 0.35;
        return f;
      }),
    );
    const list = loaded.filter((f): f is Fighter => !!f);
    this.placeEnemies(list);
    for (const f of list) this.scene.add(f.char.root);
    this.enemies = list;
  }

  /** Pick the stage layout that fits the enemies' sizes (S/M/L/LL), like the game's opponentLayouts. */
  private placeEnemies(list: Fighter[]) {
    const size = (f: Fighter) => (f.height > 5.5 ? 'LL' : f.height > 3.4 ? 'L' : f.height > 2.2 ? 'M' : 'S');
    const sorted = [...list].sort((a, b) => b.height - a.height);
    const counts: Record<string, number> = {};
    for (const f of sorted) counts[size(f)] = (counts[size(f)] ?? 0) + 1;
    const name = ['LL', 'L', 'M', 'S'].filter((s) => counts[s]).map((s) => `${s}${counts[s]}`).join('');
    const opp = this.zones.opponents;
    let zones = opp[name];
    if (!zones && list.length <= 3) zones = opp[`S${list.length}`] ?? opp[`M${list.length}`];
    if (!zones || zones.length < list.length) {
      // More enemies than any layout holds: spread them on an arc around the layouts' centre.
      const all = Object.values(opp).flat();
      const c = all.length ? all.reduce((a, z) => a.add(new THREE.Vector3().fromArray(z.p)), new THREE.Vector3()).divideScalar(all.length) : new THREE.Vector3(0, 0, 7);
      const partyC = this.party.reduce((a, f) => a.add(f.home), new THREE.Vector3()).divideScalar(Math.max(1, this.party.length));
      const toParty = partyC.clone().sub(c).setY(0).normalize();
      const side = new THREE.Vector3(toParty.z, 0, -toParty.x);
      const spread = Math.max(2.2, ...list.map((f) => f.radius * 2.2));
      zones = sorted.map((_, i) => {
        const k = i - (sorted.length - 1) / 2;
        const p = c.clone().addScaledVector(side, k * spread).addScaledVector(toParty, -Math.abs(k) * 0.8 + (i % 2) * 1.2);
        return { p: p.toArray(), yaw: (Math.atan2(toParty.x, toParty.z) * 180) / Math.PI };
      });
    } else {
      zones = [...zones].sort((a, b) => (b.sizeType ?? 0) - (a.sizeType ?? 0));
    }
    sorted.forEach((f, i) => {
      const z = zones![i];
      f.home.fromArray(z.p);
      f.homeYaw = (z.yaw * Math.PI) / 180;
      f.char.root.position.copy(f.home);
      f.char.root.rotation.y = f.homeYaw;
    });
  }

  // ------------------------------------------------------------------ time
  private sleep(s: number) {
    return new Promise<void>((done) => this.waits.push({ at: this.realTime + Math.max(0, s), done }));
  }

  /** ATB time factor: menus slow or stop the gauges depending on the setting. */
  private timeScale() {
    const s = this.host.settings;
    let k = s.speed;
    const inMenu = this.menu !== null && this.menu.kind !== 'command';
    const anyMenu = this.menu !== null;
    if (s.mode === 'wait' && inMenu) k = 0;
    else if (s.mode === 'wait' && anyMenu) k *= s.slowFactor;
    else if (s.mode === 'slow' && anyMenu) k *= s.slowFactor;
    if (this.modal || this.finished) k = 0;
    return k;
  }

  // ------------------------------------------------------------------ frame
  update(dt: number) {
    if (!this.ready) return;
    this.realTime += dt;
    for (let i = this.waits.length - 1; i >= 0; i--) {
      if (this.realTime >= this.waits[i].at) {
        const w = this.waits.splice(i, 1)[0];
        w.done();
      }
    }
    const k = this.timeScale();
    const gdt = dt * k;
    this.time += gdt;
    if (!this.finished) {
      for (const f of [...this.party, ...this.enemies]) {
        if (!f.alive) continue;
        const poison = f.tick(this.time, gdt);
        if (poison) this.damage(f, poison, false, 'Poison');
        if (f.ready || f.queued || f.acting || f.hasStatus(5)) continue;
        const secs = f.side === 'party' ? PARTY_ATB_SECONDS : ENEMY_ATB_SECONDS;
        f.atb = Math.min(1, f.atb + gdt / secs);
        if (f.atb >= 1) {
          if (f.side === 'party') {
            this.endGuard(f);
            f.ready = true;
            this.readyOrder.push(f);
            this.host.sfx.play(SE.atbFull);
          } else this.enemyTurn(f);
        }
      }
      if (!this.menu && !this.modal) {
        this.readyOrder = this.readyOrder.filter((f) => f.ready && f.alive);
        const next = this.readyOrder[0];
        if (next) this.openCommand(next);
      }
      if (!this.executing && this.queue.length) void this.runQueue();
      this.checkEnd();
      this.escapeCheck(dt);
    }
    for (const f of [...this.party, ...this.enemies]) f.update(dt);
    this.updateGuardFx();
    this.effects.update(dt, this.camera);
    this.updateCamera(dt);
    this.stage?.update(dt, this.camera);
    this.renderHud();
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ camera
  private centers() {
    const pc = new THREE.Vector3();
    const live = this.party.length ? this.party : [];
    for (const f of live) pc.add(f.home);
    pc.divideScalar(Math.max(1, live.length));
    const ec = new THREE.Vector3();
    const en = this.enemies.filter((e) => !e.removed);
    for (const f of en) ec.add(f.home);
    if (en.length) ec.divideScalar(en.length);
    else ec.copy(pc).add(new THREE.Vector3(0, 0, 7));
    return { pc, ec };
  }

  private resetCamera(snap = false) {
    this.focus = null;
    if (snap) {
      const { pos, look } = this.cameraGoal();
      this.camPos.copy(pos);
      this.camLook.copy(look);
    }
  }

  private cameraGoal() {
    const { pc, ec } = this.centers();
    const fwd = ec.clone().sub(pc).setY(0);
    const dist = Math.max(4, fwd.length());
    fwd.normalize();
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
    if (this.focus) {
      const a = this.focus.from.char.root.position.clone();
      const t = this.focus.to.length ? this.focus.to.reduce((s, f) => s.add(f.char.root.position), new THREE.Vector3()).divideScalar(this.focus.to.length) : a.clone();
      const mid = a.clone().lerp(t, 0.5);
      const span = Math.max(3, a.distanceTo(t));
      const across = t.clone().sub(a).setY(0).normalize();
      const perp = new THREE.Vector3(across.z, 0, -across.x);
      if (perp.dot(side) < 0) perp.negate();
      const h = Math.max(this.focus.from.height, ...this.focus.to.map((f) => f.height));
      const pos = mid.clone().addScaledVector(perp, span * 0.95 + 2.5).addScaledVector(across, -span * 0.25).add(new THREE.Vector3(0, h * 0.55 + 1.2, 0));
      return { pos, look: mid.add(new THREE.Vector3(0, h * 0.45, 0)) };
    }
    // FF7's idle view: behind and beside the party, slowly drifting
    const sway = Math.sin(this.realTime * 0.12) * 0.35;
    const big = Math.max(1, ...this.enemies.filter((e) => e.alive).map((e) => e.height));
    const pos = pc
      .clone()
      .addScaledVector(fwd, -dist * 0.55 - 1.5 - big * 0.9)
      .addScaledVector(side, dist * (0.55 + sway) + big * 0.4)
      .add(new THREE.Vector3(0, 2.6 + big * 0.55, 0));
    const look = pc.clone().lerp(ec, 0.55).add(new THREE.Vector3(0, 0.9 + big * 0.25, 0));
    return { pos, look };
  }

  private updateCamera(dt: number) {
    const { pos, look } = this.cameraGoal();
    const k = 1 - Math.exp(-dt * (this.focus ? 3.5 : 1.6));
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    this.camera.position.copy(this.camPos);
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.25;
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
    }
    this.camera.lookAt(this.camLook);
  }

  private project(p: THREE.Vector3) {
    const v = p.clone().project(this.camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, behind: v.z > 1 };
  }

  // ------------------------------------------------------------------ HUD
  private renderHud() {
    const m = this.menu;
    const active = m?.actor ?? null;
    this.hud.renderParty(
      this.party.map((f) => ({
        name: f.name,
        hp: Math.max(0, Math.round(f.hp)),
        maxHp: f.stats.hp,
        mp: Math.round(f.mp),
        maxMp: f.stats.mp,
        atb: f.ready || f.queued ? 1 : f.atb,
        limit: f.limit,
        ready: f.ready,
        active: f === active,
        dead: !f.alive,
        guard: f.guarding,
        statuses: f.statusLabels(),
      })),
    );
    this.validateLock();
    const targeting = m?.kind === 'target' ? m : null;
    const targeted = targeting ? this.targetsOf(targeting) : [];
    // target window: what the cursor points at while choosing, else the lock-on
    const shown = targeting ? targeted : this.lockOn ? [this.lockOn] : [];
    const main = shown[0];
    if (main && !this.finished) {
      const many = shown.length > 1;
      const hp = many ? shown.reduce((s, f) => s + Math.max(0, f.hp), 0) / shown.reduce((s, f) => s + f.stats.hp, 0) : Math.max(0, main.hp) / main.stats.hp;
      this.hud.renderTarget({
        name: many ? (main.side === 'enemy' ? 'All enemies' : 'All allies') : main.name,
        hp,
        level: !many && main.side === 'enemy' ? main.level : undefined,
        statuses: many ? [] : main.statusLabels(),
        count: many ? shown.length : undefined,
        ally: main.side === 'party',
      });
    } else this.hud.renderTarget(null);
    const tags = [];
    if (!this.finished) {
      for (const e of this.enemies) {
        if (!e.alive || e.removed) continue;
        const p = this.project(e.top());
        if (p.behind) continue;
        tags.push({ x: p.x, y: p.y - 6, name: e.name, hp: Math.max(0, e.hp) / e.stats.hp, locked: targeting ? targeted.includes(e) : e === this.lockOn });
      }
    }
    this.hud.renderTags(tags);
    const lock = !targeting && !this.finished && this.lockOn ? this.project(this.lockOn.chest()) : null;
    this.hud.lockOn(lock && !lock.behind ? lock : null);
    this.hud.pointAt(
      targeted
        .map((t) => this.project(t.chest()))
        .filter((p) => !p.behind)
        .map((p) => ({ x: p.x, y: p.y })),
    );
    this.renderControls();
  }

  /** The controls guide, the button plate and, while Shift / L1 is held, the shortcut palette. */
  private renderControls() {
    const m = this.menu;
    const over = this.finished || !!this.modal;
    const who = m && m.kind !== 'target' ? m.actor : m ? null : (this.party.find((f) => f.alive && !f.ready && !f.queued) ?? null);
    const holding = !over && this.keysDown.has('shift') && !!who && m?.kind !== 'target';
    this.hud.showShortcuts(holding && who ? this.shortcutView(who, m?.kind === 'command' || m?.kind === 'list') : null);
    const many = this.readyOrder.length > 1;
    // top left: what works at any time (Remake's controls guide)
    this.hud.showGuide(
      over
        ? []
        : [
            { action: 'guard', label: 'Guard', dim: m?.kind !== 'command' },
            { action: 'shortcuts', label: 'Command Shortcuts' },
            ...(this.party.filter((f) => f.alive).length > 1 ? [{ action: 'next' as const, label: 'Switch Characters', dim: !many }] : []),
            { action: 'target', label: 'Switch Target' },
            ...(this.req.escapable ? [{ action: 'escape' as const, label: 'Hold: Escape' }] : []),
            { action: 'pause', label: 'Pause', dim: !this.canPause },
          ],
    );
    if (over) return this.hud.showHints(null, []);
    if (!m) {
      return this.hud.showHints(who?.name ?? null, [
        { action: 'attack', label: 'Attack', dim: true },
        { action: 'commands', label: 'Commands Menu', dim: true },
      ]);
    }
    if (m.kind === 'target') {
      return this.hud.showHints(null, [
        { action: 'confirm', label: 'Confirm' },
        { action: 'back', label: 'Back' },
        ...(m.all || m.pool.length < 2 ? [] : [{ action: 'cursor' as const, label: 'Change target' }]),
      ]);
    }
    if (m.kind === 'list') {
      return this.hud.showHints(
        m.actor.name,
        [{ action: 'confirm', label: 'Select' }, { action: 'back', label: 'Back' }, ...(many ? [{ action: 'next' as const, label: 'Next' }] : [])],
        'line',
      );
    }
    if (m.open) {
      return this.hud.showHints(
        m.actor.name,
        [{ action: 'confirm', label: 'Select' }, { action: 'back', label: 'Close' }, { action: 'attack', label: 'Attack' }, ...(many ? [{ action: 'next' as const, label: 'Next' }] : [])],
        'line',
      );
    }
    this.hud.showHints(m.actor.name, [
      { action: 'attack', label: 'Attack' },
      { action: 'commands', label: 'Commands Menu' },
    ]);
  }

  // ------------------------------------------------------------------ menus
  /** A character's turn: the menu jumps to it (FF7's ready queue). `open` shows the command list right away. */
  private openCommand(actor: Fighter, open = false, cursor = 0) {
    const d = actor.def!;
    const silenced = actor.hasStatus(3);
    const limitReady = actor.limit >= 100 && d.limits.length > 0;
    const abilities = this.abilities(actor);
    const entries: Entry[] = [
      { item: { label: 'Abilities', disabled: !abilities.length, help: abilities.length ? 'Weapon abilities' : 'No weapon abilities' }, run: () => this.openAbilities(actor) },
      { item: { label: 'Magic', disabled: silenced, help: silenced ? 'Silenced' : 'Cast materia magic' }, run: () => this.openMagic(actor) },
      { item: { label: 'Items', help: 'Use an item' }, run: () => this.openItems(actor) },
      { item: { label: 'Summon', disabled: silenced || !this.summons(actor).length, help: 'Call a summon' }, run: () => this.openSummons(actor) },
      {
        item: {
          label: 'Limit',
          disabled: !limitReady,
          right: limitReady ? 'READY' : `${Math.floor(actor.limit)}%`,
          help: limitReady ? 'Limit Break' : d.limits.length ? 'The Limit gauge fills as you take damage' : 'No Limit Break',
        },
        run: () => this.openLimits(actor),
      },
    ];
    this.menu = { kind: 'command', actor, cursor, entries, open };
    this.focus = null;
    this.showMenu();
  }

  /** Space / gamepad ✕ / right click: open or close the command list. */
  private toggleCommands() {
    const m = this.menu;
    if (!m || m.kind !== 'command') {
      if (!m) this.host.sfx.play(SE.cancel);
      return;
    }
    if (m.open) {
      m.open = false;
      this.host.sfx.play(SE.cancel);
      this.showMenu();
    } else {
      this.host.sfx.play(SE.decide);
      this.openCommand(m.actor, true, m.cursor);
    }
  }

  private rootOf(m: Menu): Extract<Menu, { kind: 'command' }> | null {
    let x: Menu | undefined = m;
    while (x && x.kind !== 'command') x = x.back;
    return x ?? null;
  }

  private showMenu() {
    const m = this.menu;
    if (!m || m.kind === 'target') {
      this.hud.showCommands(null);
      this.hud.setHelp(m?.kind === 'target' ? m.help : null);
      return;
    }
    this.hud.setHelp(null);
    const root = this.rootOf(m);
    if (!root || (m.kind === 'command' && !m.open)) return this.hud.showCommands(null);
    const items = (entries: Entry[]) => entries.map((e) => ({ ...e.item, slot: this.slotOfKey(m.actor, e.key) }));
    const top: MenuPanel = { title: 'Commands', items: items(root.entries), cursor: root.cursor };
    const sub: MenuPanel | undefined = m.kind === 'list' ? { title: m.title, items: items(m.entries), cursor: m.cursor, columns: m.columns } : undefined;
    const view: CommandView = {
      actor: m.actor.name,
      top,
      sub,
      focus: m.kind === 'list' ? 'sub' : 'top',
      tip: m.kind === 'list' && m.entries.some((e) => e.key) ? 'Put the highlighted skill on a shortcut' : undefined,
      tipAction: 'assign',
    };
    this.hud.showCommands(view);
  }

  private abilities(actor: Fighter) {
    if (actor.abilityKeys) return actor.abilityKeys.filter((k) => this.data.skills[k]?.action);
    const d = actor.def!;
    const keys: string[] = [];
    if (actor.weapon?.ability) keys.push(actor.weapon.ability);
    // More C.Abilities as the party levels up, from the character's other weapons (like collecting them).
    const extra = Math.min(5, 1 + Math.floor(actor.level / 12));
    for (const w of d.weapons) {
      if (keys.length >= extra + 1) break;
      if (w.ability && !keys.includes(w.ability) && this.data.skills[w.ability]?.action) keys.push(w.ability);
    }
    return keys;
  }

  /** Skill keys of the spells this character can cast (equipped materia). */
  private spells(actor: Fighter) {
    const keys: string[] = [];
    for (const sp of this.data.index.spells) {
      if (actor.spellIds ? !actor.spellIds.includes(sp.id) : sp.level > actor.level) continue;
      const key = actor.def!.spells[sp.id] ?? sp.skill;
      if (this.data.skills[key] && !keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  private skillEntry(actor: Fighter, key: string, magic: boolean): Entry {
    const s = this.data.skills[key];
    const cost = mpCost(s);
    const silenced = magic && actor.hasStatus(3);
    return {
      item: { label: s.name, right: `${cost} MP`, atb: true, disabled: actor.mp < cost || silenced, help: this.describe(s) },
      run: () => this.chooseTargets(actor, key),
      key,
    };
  }

  private openAbilities(actor: Fighter) {
    this.pushList(actor, 'Abilities', this.abilities(actor).map((k) => this.skillEntry(actor, k, false)));
  }

  private openMagic(actor: Fighter) {
    this.pushList(actor, 'Magic', this.spells(actor).map((k) => this.skillEntry(actor, k, true)), 2);
  }

  private summons(actor: Fighter) {
    return this.data.index.summons.filter((s) => (actor.summonIds ? actor.summonIds.includes(s.id) : s.level <= actor.level) && this.data.skills[s.skill]);
  }

  private summonCost(level: number) {
    return 20 + level * 2;
  }

  private openSummons(actor: Fighter) {
    const entries = this.summons(actor).map((su) => {
      const cost = this.summonCost(su.level);
      return {
        item: { label: su.name, right: `${cost} MP`, atb: true, disabled: actor.mp < cost, help: this.describe(this.data.skills[su.skill]) },
        run: () => this.confirmAction({ actor, skill: su.skill, targets: this.enemies.filter((e) => e.alive) }, cost),
      };
    });
    this.pushList(actor, 'Summon', entries);
  }

  private openLimits(actor: Fighter) {
    const unlocked = actor.def!.limits.filter((_, i) => i === 0 || actor.level >= 12 + i * 14).filter((k) => this.data.skills[k]);
    if (unlocked.length === 1) return this.chooseTargets(actor, unlocked[0]);
    this.pushList(
      actor,
      'Limit',
      unlocked.map((k) => ({ item: { label: this.data.skills[k].name, atb: true, help: this.describe(this.data.skills[k]) }, run: () => this.chooseTargets(actor, k) })),
    );
  }

  private openItems(actor: Fighter) {
    const entries: Entry[] = [];
    const game = this.host.game;
    for (const it of game ? game.items() : ITEMS) {
      const n = game ? game.itemCount(it.id) : (this.items[it.id] ?? 0);
      if (n <= 0) continue;
      entries.push({
        item: { label: it.name, right: `×${n}`, atb: true, help: it.help, disabled: it.disabled },
        run: () => {
          if (it.target === 'enemies') return this.confirmAction({ actor, item: it, targets: this.enemies.filter((e) => e.alive) });
          if (it.target === 'allies') return this.confirmAction({ actor, item: it, targets: this.party.filter((f) => f.alive) });
          const pool = it.target === 'dead' ? this.party.filter((f) => !f.alive) : this.party.filter((f) => f.alive);
          if (!pool.length) return this.host.sfx.play(SE.cancel);
          this.menu = {
            kind: 'target',
            actor,
            cursor: Math.max(0, pool.indexOf(actor)),
            pool,
            all: false,
            back: this.menu!,
            pick: (t) => this.confirmAction({ actor, item: it, targets: t }),
            help: `${it.name}: choose who`,
          };
          this.showMenu();
        },
      });
    }
    if (!entries.length) entries.push({ item: { label: '(no items)', disabled: true }, run: () => {} });
    this.pushList(actor, 'Items', entries, 2);
  }

  private pushList(actor: Fighter, title: string, entries: Entry[], columns = 1) {
    if (!entries.length) {
      this.host.sfx.play(SE.cancel);
      return;
    }
    this.menu = { kind: 'list', actor, title, cursor: Math.max(0, entries.findIndex((e) => !e.item.disabled)), entries, back: this.menu!, columns };
    this.showMenu();
  }

  private describe(s: Skill | undefined) {
    if (!s) return '';
    const main = s.effects.find((e) => !e.child && (e.kind === 'damage' || e.kind === 'heal'));
    const el = s.element > 1 ? this.data.index.elements[String(s.element)] : '';
    const tgt = ['', 'One enemy', 'All enemies', 'One ally', 'All allies', 'Self'][targetType(s)] ?? '';
    const pot = main?.potency ? `${main.kind === 'heal' ? 'Heal' : s.attack === 2 ? 'Mag.' : 'Phys.'} ${Math.round(main.potency / 10)}%` : '';
    const extra = s.effects
      .filter((e) => e.kind === 'buff' || e.kind === 'status')
      .map((e) => (e.kind === 'buff' ? this.data.index.buffTypes[String(e.buff)] : STATUS_NAMES[e.status ?? 0]))
      .filter(Boolean);
    return [tgt, el, pot, ...extra].filter(Boolean).join(' · ');
  }

  /** Pick targets for a skill. `direct` (Attack, shortcuts): enemies are the lock-on, no cursor; one ally still asks. */
  private chooseTargets(actor: Fighter, key: string, direct = false) {
    const s = this.data.skills[key];
    if (!s) return;
    const allies = targetsAllies(s);
    if (targetType(s) === 5) return this.confirmAction({ actor, skill: key, targets: [actor] });
    const pool = allies ? this.party.filter((f) => f.alive) : this.enemies.filter((f) => f.alive);
    if (!pool.length) return;
    const all = targetsAll(s);
    if (direct && (all || !allies)) return this.confirmAction({ actor, skill: key, targets: all ? pool : [this.lockTarget(pool)] });
    const back = this.menu!;
    const lock = this.lockOn ? pool.indexOf(this.lockOn) : -1;
    this.menu = {
      kind: 'target',
      actor,
      cursor: allies ? Math.max(0, pool.indexOf(actor)) : lock >= 0 ? lock : this.defaultEnemyIndex(pool),
      pool,
      all,
      back,
      pick: (t) => {
        if (!allies && !all && t[0]) this.lockOn = t[0];
        this.confirmAction({ actor, skill: key, targets: t });
      },
      help: `${s.name}${all ? ' · all targets' : ''}`,
    };
    this.showMenu();
  }

  private defaultEnemyIndex(pool: Fighter[]) {
    // the enemy nearest the screen centre
    let best = 0;
    let bd = Infinity;
    pool.forEach((f, i) => {
      const p = this.project(f.chest());
      const d = Math.abs(p.x - window.innerWidth / 2);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private targetsOf(m: Extract<Menu, { kind: 'target' }>) {
    return m.all ? m.pool.filter((f) => f.alive) : [m.pool[m.cursor]].filter(Boolean);
  }

  /** Keep the lock-on on a living enemy (the one nearest the screen centre when it falls). */
  private validateLock() {
    const t = this.lockOn;
    if (t && t.alive && !t.removed && this.enemies.includes(t)) return;
    const live = this.enemies.filter((e) => e.alive && !e.removed);
    this.lockOn = live.length ? live[this.defaultEnemyIndex(live)] : null;
  }

  private lockTarget(pool: Fighter[]) {
    this.validateLock();
    if (this.lockOn && pool.includes(this.lockOn)) return this.lockOn;
    this.lockOn = pool[this.defaultEnemyIndex(pool)];
    return this.lockOn;
  }

  /** Switch the lock-on to the next enemy on screen, left to right. */
  private cycleLock(step: number) {
    const live = this.enemies.filter((e) => e.alive && !e.removed);
    if (live.length < 2) return;
    this.validateLock();
    const order = live.map((f) => ({ f, x: this.project(f.chest()).x })).sort((a, b) => a.x - b.x);
    const at = Math.max(0, order.findIndex((o) => o.f === this.lockOn));
    this.lockOn = order[(at + step + order.length) % order.length].f;
    this.host.sfx.play(SE.cursor);
  }

  private confirmAction(entry: QueueEntry, mpOverride?: number) {
    const a = entry.actor;
    const cost = mpOverride ?? (entry.skill ? mpCost(this.data.skills[entry.skill]) : 0);
    const isLimit = entry.skill?.startsWith('lb:');
    if (entry.skill && !isLimit && entry.skill !== a.def?.attack && a.mp < cost) {
      this.host.sfx.play(SE.cancel);
      return;
    }
    this.host.sfx.play(SE.decide);
    a.ready = false;
    a.queued = true;
    (entry as QueueEntry & { cost?: number }).cost = isLimit || entry.skill === a.def?.attack ? 0 : cost;
    this.queue.push(entry);
    this.readyOrder = this.readyOrder.filter((f) => f !== a);
    this.menu = null;
    this.showMenu();
  }

  // ------------------------------------------------------------------ attack, guard, shortcuts
  /** Attack (F, left click, gamepad □): the character's normal attack on the lock-on target. Uses the turn. */
  private attack() {
    const m = this.menu;
    if (!m || m.kind !== 'command') {
      this.host.sfx.play(SE.cancel);
      return;
    }
    const a = m.actor;
    const atk = a.def?.attack;
    const pool = this.enemies.filter((e) => e.alive);
    if (!atk || !this.data.skills[atk] || !pool.length) {
      this.host.sfx.play(SE.cancel);
      return;
    }
    this.confirmAction({ actor: a, skill: atk, targets: [this.lockTarget(pool)] });
  }

  /** Guard (G, gamepad R1): spend the ATB bar to take less damage until this character's next turn. */
  private guard() {
    const m = this.menu;
    if (!m || m.kind !== 'command') {
      this.host.sfx.play(SE.cancel);
      return;
    }
    const a = m.actor;
    this.host.sfx.play(SE.buff);
    a.ready = false;
    a.atb = 0;
    a.guarding = true;
    this.readyOrder = this.readyOrder.filter((f) => f !== a);
    this.menu = null;
    this.showMenu();
    this.number(a, 'Guard', 'info');
    this.startGuardFx(a);
  }

  private endGuard(f: Fighter) {
    if (!f.guarding) return;
    f.guarding = false;
    this.stopGuardFx(f);
  }

  /** Guard look (EC has no guard clip): a teal tint on the model and a slowly turning barrier around it. */
  private startGuardFx(f: Fighter) {
    this.stopGuardFx(f);
    const r = Math.max(0.75, f.radius * 1.15);
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x66eaff, wireframe: true, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    shell.scale.set(r, Math.max(0.9, f.height * 0.62), r);
    shell.renderOrder = 5;
    this.scene.add(shell);
    const tinted: { m: THREE.MeshStandardMaterial; e: THREE.Color }[] = [];
    f.char.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mm of [mesh.material].flat()) {
        const s = mm as THREE.MeshStandardMaterial;
        if (s.side === THREE.BackSide || !s.emissive || tinted.some((t) => t.m === s)) continue;
        tinted.push({ m: s, e: s.emissive.clone() });
      }
    });
    this.guardFx.set(f, { shell, tinted });
  }

  private updateGuardFx() {
    if (!this.guardFx.size) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.realTime * 4);
    for (const [f, fx] of this.guardFx) {
      fx.shell.position.copy(f.char.root.position).add(new THREE.Vector3(0, f.height * 0.5, 0));
      fx.shell.rotation.y = this.realTime * 0.6;
      (fx.shell.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.16 * pulse;
      for (const t of fx.tinted) t.m.emissive.copy(t.e).add(GUARD_TINT.clone().multiplyScalar(0.55 + 0.45 * pulse));
    }
  }

  private stopGuardFx(f: Fighter) {
    const fx = this.guardFx.get(f);
    if (!fx) return;
    this.guardFx.delete(f);
    this.scene.remove(fx.shell);
    fx.shell.geometry.dispose();
    (fx.shell.material as THREE.Material).dispose();
    for (const t of fx.tinted) t.m.emissive.copy(t.e);
  }

  /** Shortcut skills a character can choose from: abilities first, then spells. */
  private shortcutChoices(f: Fighter) {
    return [...this.abilities(f), ...this.spells(f)];
  }

  private loadShortcuts(f: Fighter): (string | null)[] {
    const choices = this.shortcutChoices(f);
    const valid = new Set(choices);
    const game = this.host.game;
    let saved: (string | null)[] | null | undefined;
    if (game?.shortcuts) saved = game.shortcuts(f.charId);
    else
      try {
        saved = (JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '{}') as Record<string, (string | null)[]>)[f.charId];
      } catch {
        saved = null;
      }
    // nothing saved yet: the first four abilities (then spells)
    const keys = saved ?? choices.slice(0, SHORTCUT_SLOTS);
    return Array.from({ length: SHORTCUT_SLOTS }, (_, i) => (keys[i] && valid.has(keys[i]!) ? keys[i]! : null));
  }

  private saveShortcuts(f: Fighter, keys: (string | null)[]) {
    const game = this.host.game;
    if (game?.setShortcuts) return game.setShortcuts(f.charId, keys);
    try {
      const all = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '{}') as Record<string, (string | null)[]>;
      all[f.charId] = keys;
      localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(all));
    } catch {
      /* private mode */
    }
  }

  private slotOfKey(f: Fighter, key: string | undefined) {
    if (!key) return undefined;
    const i = this.shortcuts.get(f.charId)?.indexOf(key) ?? -1;
    return i >= 0 ? i : undefined;
  }

  /** Put a skill on a shortcut slot (it leaves the slot it had; the slot's old skill takes that place). */
  private assignShortcut(f: Fighter, slot: number, key: string) {
    const keys = [...(this.shortcuts.get(f.charId) ?? Array<string | null>(SHORTCUT_SLOTS).fill(null))];
    const was = keys.indexOf(key);
    if (was >= 0) keys[was] = keys[slot];
    keys[slot] = key;
    this.shortcuts.set(f.charId, keys);
    this.saveShortcuts(f, keys);
    this.host.sfx.play(SE.decide);
    this.hud.notify('check', `${this.data.skills[key]?.name ?? key} set to Shortcut ${slot + 1}`);
    this.showMenu();
  }

  private shortcutUsable(f: Fighter, key: string) {
    const s = this.data.skills[key];
    if (!s) return false;
    if (f.mp < mpCost(s)) return false;
    return !(f.hasStatus(3) && this.spells(f).includes(key));
  }

  private shortcutView(f: Fighter, ready: boolean) {
    const keys = this.shortcuts.get(f.charId) ?? [];
    return {
      actor: f.name,
      ready,
      slots: Array.from({ length: SHORTCUT_SLOTS }, (_, i) => {
        const k = keys[i];
        const s = k ? this.data.skills[k] : undefined;
        return s && k ? { label: s.name, right: `${mpCost(s)} MP`, disabled: !this.shortcutUsable(f, k) } : null;
      }),
    };
  }

  /** Number keys 1–4 / L1 + face button: use that shortcut now (the gauge must be full). */
  private fireShortcut(slot: number) {
    const m = this.menu;
    if (!m || m.kind !== 'command') {
      this.host.sfx.play(SE.cancel);
      return;
    }
    const a = m.actor;
    const key = this.shortcuts.get(a.charId)?.[slot];
    if (!key || !this.shortcutUsable(a, key)) {
      this.host.sfx.play(SE.cancel);
      return;
    }
    this.chooseTargets(a, key, true);
  }

  // ------------------------------------------------------------------ input
  /** Tab / gamepad △ / ↑↓ on a turn: hand the turn to the next (or previous) character whose gauge is full. */
  private nextReady(step: number) {
    const n = this.readyOrder.length;
    if (n < 2) return false;
    const m = this.menu;
    const cur = m?.actor;
    const i = cur ? this.readyOrder.indexOf(cur) : -1;
    const next = this.readyOrder[(i + step + n) % n];
    this.readyOrder = [next, ...this.readyOrder.filter((f) => f !== next)];
    this.openCommand(next, m ? m.kind !== 'command' || m.open : false);
    this.host.sfx.play(SE.cursor);
    return true;
  }

  /** Keyboard input while the battle runs (gamepad buttons arrive as keys too). Returns true when the key was used. */
  onKey(k: string, code = ''): boolean {
    if (this.modal) {
      const m = this.modal;
      if (['arrowleft', 'arrowup', 'a', 'w'].includes(k)) m.cursor = (m.cursor + m.buttons.length - 1) % m.buttons.length;
      else if (['arrowright', 'arrowdown', 'd', 's'].includes(k)) m.cursor = (m.cursor + 1) % m.buttons.length;
      else if (['enter', 'e', ' '].includes(k)) {
        m.pick(m.cursor);
        return true;
      } else return false;
      this.host.sfx.play(SE.cursor);
      this.renderModalButtons();
      return true;
    }
    if (this.finished) return false;
    const m = this.menu;
    const up = k === 'arrowup' || k === 'w';
    const down = k === 'arrowdown' || k === 's';
    const left = k === 'arrowleft' || k === 'a';
    const right = k === 'arrowright' || k === 'd';
    const ok = k === 'enter' || k === 'e' || k === ' ';
    const back = k === 'escape' || k === 'backspace' || k === 'q';
    const slot = slotOf(k, code);
    if (k === 'tab') {
      this.nextReady(this.keysDown.has('shift') ? -1 : 1);
      return true;
    }
    if (m?.kind === 'target') {
      if (left || right || up || down || k === '[' || k === ']') {
        if (!m.all && m.pool.length > 1) {
          // step by screen position, like FF7's cursor
          const order = m.pool.map((f, i) => ({ i, x: this.project(f.chest()).x })).sort((a, b) => a.x - b.x);
          const at = order.findIndex((o) => o.i === m.cursor);
          const step = left || up || k === '[' ? -1 : 1;
          m.cursor = order[(at + step + order.length) % order.length].i;
          this.host.sfx.play(SE.cursor);
        }
        return true;
      }
      if (ok) {
        m.pick(this.targetsOf(m));
        return true;
      }
      if (back) {
        this.menu = m.back;
        this.host.sfx.play(SE.cancel);
        this.showMenu();
        return true;
      }
      return false;
    }
    if (k === '[' || k === ']') {
      this.cycleLock(k === ']' ? 1 : -1);
      return true;
    }
    if (!m || (m.kind === 'command' && !m.open)) {
      // nobody's menu is open: Attack, Guard and shortcuts act, ←→ switch the lock-on, ↑↓ the ready character
      if (left || right) {
        this.cycleLock(right ? 1 : -1);
        return true;
      }
      if (m && (up || down)) {
        this.nextReady(up ? -1 : 1);
        return true;
      }
      if (k === 'f') return this.attack(), true;
      if (k === 'g') return this.guard(), true;
      if (slot !== null) return this.fireShortcut(slot), true;
      if (ok) return this.toggleCommands(), true;
      return !!m && back;
    }
    if (m.kind === 'command') {
      if (k === 'f') return this.attack(), true;
      if (k === 'g') return this.guard(), true;
      if (slot !== null) return this.fireShortcut(slot), true;
      if (back) return this.toggleCommands(), true;
    } else if (slot !== null) {
      const key = m.entries[m.cursor]?.key;
      if (key) this.assignShortcut(m.actor, slot, key);
      else this.host.sfx.play(SE.cancel);
      return true;
    }
    const n = m.entries.length;
    const cols = m.kind === 'list' ? (m.columns ?? 1) : 1;
    if (up || down || left || right) {
      let c = m.cursor;
      if (cols === 2 && (left || right)) c = c + (right ? 1 : -1);
      else if (up || down) c = c + (down ? cols : -cols);
      else return true;
      m.cursor = (c + n) % n;
      this.host.sfx.play(SE.cursor);
      this.showMenu();
      return true;
    }
    if (ok) {
      this.clickMenu(m.kind === 'list' ? 'sub' : 'top', m.cursor);
      return true;
    }
    if (back && m.kind === 'list') {
      this.menu = m.back;
      this.host.sfx.play(SE.cancel);
      this.showMenu();
      return true;
    }
    return back;
  }

  private clickMenu(panel: 'top' | 'sub', i: number) {
    let m = this.menu;
    if (!m || m.kind === 'target') return;
    // a click on the command list while a sub-list is open goes back to it
    if (panel === 'top' && m.kind === 'list') {
      const root = this.rootOf(m);
      if (!root) return;
      this.menu = m = root;
    }
    if (m.kind === 'command' && !m.open) return;
    const e = m.entries[i];
    if (!e) return;
    m.cursor = i;
    if (e.item.disabled) {
      this.host.sfx.play(SE.cancel);
      this.showMenu();
      return;
    }
    this.host.sfx.play(SE.decide);
    e.run();
  }

  /** The mouse moves the cursor of the list that has it. */
  private hoverMenu(panel: 'top' | 'sub', i: number) {
    const m = this.menu;
    if (!m || m.kind === 'target' || m.cursor === i) return;
    if ((panel === 'sub') !== (m.kind === 'list')) return;
    m.cursor = i;
    this.host.sfx.play(SE.cursor);
    this.showMenu();
  }

  /** A click on a button hint does what the button does (mouse players). */
  private hint(a: string) {
    if (a === 'attack') this.attack();
    else if (a === 'guard') this.guard();
    else if (a === 'commands') this.toggleCommands();
    else if (a === 'next') this.nextReady(1);
    else if (a === 'back') this.onKey('backspace');
    else if (a === 'confirm') this.onKey('enter');
  }

  /** Left click: pick the target while choosing; otherwise lock on to the clicked enemy and Attack. */
  click(x: number, y: number) {
    if (this.modal || this.finished) return;
    const m = this.menu;
    const nearest = (pool: Fighter[]) => {
      let best = -1;
      let bd = 90;
      pool.forEach((f, i) => {
        const p = this.project(f.chest());
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    if (m?.kind === 'target') {
      const best = nearest(m.pool);
      if (best < 0) return;
      if (!m.all && best !== m.cursor) {
        m.cursor = best;
        this.host.sfx.play(SE.cursor);
        return;
      }
      m.pick(this.targetsOf(m));
      return;
    }
    const live = this.enemies.filter((e) => e.alive && !e.removed);
    const hit = nearest(live);
    if (hit >= 0 && live[hit] !== this.lockOn) {
      this.lockOn = live[hit];
      if (m?.kind !== 'command') this.host.sfx.play(SE.cursor);
    }
    if (m?.kind === 'command') this.attack();
  }

  // ------------------------------------------------------------------ enemy turns
  private enemyTurn(f: Fighter) {
    const e = f.enemy!;
    let key: string | null = null;
    if (f.brain) {
      const id = f.brain.next({
        hpPercent: (f.hp / f.stats.hp) * 100,
        turns: f.turns,
        allies: this.enemies.filter((x) => x.alive).length,
        opponents: this.party.filter((x) => x.alive).length,
        enemyId: e.id,
      });
      if (id && this.data.skills[`en:${id}`]?.action) key = `en:${id}`;
    }
    if (!key) {
      const usable = f.skills.filter((k) => this.data.skills[k]?.action);
      key = usable.length ? usable[Math.floor(Math.random() * usable.length)] : (f.skills[0] ?? null);
    }
    f.turns++;
    if (!key) {
      f.atb = 0;
      return;
    }
    const s = this.data.skills[key];
    let targets: Fighter[];
    if (targetType(s) === 5) targets = [f];
    else if (targetsAllies(s)) {
      const pool = this.enemies.filter((x) => x.alive);
      targets = targetsAll(s) ? pool : [pool.sort((a, b) => a.hp / a.stats.hp - b.hp / b.stats.hp)[0]];
    } else {
      const pool = this.party.filter((x) => x.alive);
      if (!pool.length) return;
      targets = targetsAll(s) ? pool : [pool[Math.floor(Math.random() * pool.length)]];
    }
    f.queued = true;
    this.queue.push({ actor: f, skill: key, targets });
  }

  // ------------------------------------------------------------------ actions
  private async runQueue() {
    this.executing = true;
    while (this.queue.length && !this.finished) {
      const e = this.queue.shift()!;
      const a = e.actor;
      if (!a.alive) {
        a.queued = false;
        continue;
      }
      // retarget if the chosen targets fell meanwhile
      const enemiesOfA = a.side === 'party' ? this.enemies : this.party;
      const friendsOfA = a.side === 'party' ? this.party : this.enemies;
      if (!e.item || e.item.target !== 'dead') {
        e.targets = e.targets.filter((t) => t.alive);
        if (!e.targets.length) {
          const s = e.skill ? this.data.skills[e.skill] : undefined;
          const pool = (s && targetsAllies(s)) || e.item?.target === 'ally' ? friendsOfA : enemiesOfA;
          const live = pool.filter((t) => t.alive);
          if (live.length) e.targets = [live[0]];
        }
      }
      if (!e.targets.length) {
        a.queued = false;
        a.atb = 0;
        continue;
      }
      a.acting = true;
      a.cancelReact();
      try {
        if (e.item) await this.useItem(a, e.item, e.targets);
        else if (e.skill) await this.perform(a, e.skill, e.targets, (e as QueueEntry & { cost?: number }).cost ?? 0);
      } catch (err) {
        console.warn('[battle] action failed', err);
      }
      a.acting = false;
      a.queued = false;
      a.atb = 0;
      if (a.alive) a.char.stopMotion(0.25);
      this.resetCamera();
      await this.sleep(0.15);
    }
    this.executing = false;
  }

  private async useItem(a: Fighter, it: ItemDef, targets: Fighter[]) {
    const game = this.host.game;
    if (game) {
      if (game.itemCount(it.id) <= 0) return;
      game.consumeItem(it.id);
    } else {
      if ((this.items[it.id] ?? 0) <= 0) return;
      this.items[it.id]--;
      saveItems(this.items);
    }
    this.hud.showBanner(it.name);
    this.focus = { from: a, to: targets };
    a.faceTo(targets[0].char.root.position);
    const ref = a.clip(/_skill_00[12]$/) ?? a.clip(/_step_f_001$/);
    void a.playClip(ref);
    await this.sleep(0.5);
    this.host.sfx.play(SE.item);
    it.use(this, a, targets);
    await this.sleep(0.8);
    a.char.root.rotation.y = a.homeYaw;
  }

  /** Play a skill: run up, play its clips, deal its hits at the game's own hit times, run back. */
  private async perform(a: Fighter, key: string, targets: Fighter[], cost: number) {
    const s = this.data.skills[key];
    if (!s) return;
    a.mp = Math.max(0, a.mp - cost);
    const isLimit = key.startsWith('lb:');
    const isSummon = key.startsWith('su:');
    if (isLimit) a.limit = 0;
    if (key !== a.def?.attack || a.side === 'enemy') this.hud.showBanner(s.name, 2, a.side === 'enemy' ? 'enemy' : 'party');
    const act = s.action;
    const color = ELEMENT_COLORS[s.element] ?? 0xffffff;
    this.focus = { from: a, to: targets.filter((t) => t !== a) };
    const center = targets.reduce((p, t) => p.add(t.char.root.position), new THREE.Vector3()).divideScalar(targets.length);
    const allies = targetsAllies(s);
    const melee = !!act && (act.range === 1 || act.range === 2) && !allies && !isSummon;
    if (melee) {
      const t = targets[0];
      const dir = a.char.root.position.clone().sub(t.char.root.position).setY(0).normalize();
      const stop = Math.max(act.rangeMin ?? 0, t.radius * 0.9 + 0.7);
      await a.runTo(t.char.root.position.clone().addScaledVector(dir, stop));
    }
    a.faceTo(center);
    if (isSummon) {
      this.hud.flash('#fff', 600);
      this.shake = 0.6;
    }
    // hits: at the game's hit times in the out clip, or once in the middle of the move
    const hits = act?.hits?.length ? act.hits : null;
    const totalRate = hits ? hits.reduce((x, h) => x + h[1], 0) || 1 : 1;
    let applied = false;
    let hitIndex = 0;
    const applyHit = (rate: number) => {
      this.applySkill(a, s, targets, rate, !applied);
      applied = true;
      hitIndex++;
    };
    const playSounds = (list?: [number, string][]) => {
      for (const [t, url] of list ?? []) void this.sleep(t).then(() => this.host.sfx.play(encodeURI(url)));
    };
    // EC's particle effects at the action's event times; the stand-ins only when it has none converted
    const fxCtx = { actor: a, targets, fighters: [...this.party, ...this.enemies], sleep: (t: number) => this.sleep(t) };
    const [ecIn, ecOut] = await Promise.all([this.effects.ready(act?.inFx), this.effects.ready(act?.fx)]);
    this.ecAction = ecIn || ecOut;
    if (act?.clips.in) {
      playSounds(act.inSe);
      if (ecIn) void this.effects.play(act.inFx, fxCtx);
      const d = await a.playClip(act.clips.in);
      if (!this.ecAction && (act.clips.loop || !act.clips.out)) this.effects.charge(a.chest(), color);
      await this.sleep(Math.max(0.2, d - 0.05));
    }
    if (act?.clips.loop) {
      await a.playClip(act.clips.loop, true);
      if (!this.ecAction) this.effects.charge(a.chest(), color);
      await this.sleep(Math.min(1.2, act.loopTime && act.loopTime > 0.3 ? act.loopTime : 0.7));
    }
    if (act?.movie && this.host.playMovie) await this.host.playMovie(act.movie);
    if (ecOut) void this.effects.play(act?.fx, fxCtx);
    let outDur = 0;
    if (act?.clips.out) {
      playSounds(act.se);
      outDur = await a.playClip(act.clips.out);
    } else if (act?.se) playSounds(act.se);
    if (hits) {
      let t0 = 0;
      for (const [t, rate] of hits) {
        await this.sleep(Math.max(0, t - t0));
        t0 = t;
        applyHit(rate / totalRate);
      }
    } else {
      await this.sleep(outDur ? Math.min(outDur * 0.5, 1.2) : 0.5);
      applyHit(1);
    }
    if (isSummon && !this.ecAction) {
      for (const t of targets) this.effects.pillar(t.char.root.position, color);
      this.host.sfx.play(SE.explosion);
    }
    const left = Math.min(outDur - (hits ? hits[hits.length - 1][0] : outDur * 0.5), isLimit ? 3.5 : 2);
    await this.sleep(Math.max(0.35, left));
    void hitIndex;
    if (melee && a.alive) {
      await a.runTo(a.home);
      a.char.root.rotation.y = a.homeYaw;
    } else a.char.root.rotation.y = a.homeYaw;
  }

  private applySkill(a: Fighter, s: Skill, targets: Fighter[], rate: number, first: boolean) {
    const color = ELEMENT_COLORS[s.element] ?? 0xffffff;
    const scale = enemyDamageScale(this.host.settings);
    for (const e of s.effects) {
      const recipients = this.recipients(e, a, targets);
      if (e.kind === 'damage' || e.kind === 'heal') {
        for (const t of recipients) {
          if (!t.alive) continue;
          const r = resolve(e, s, a, t, rate, scale);
          const at = t.chest();
          if (r.miss) {
            this.number(t, 'Miss', 'miss');
            continue;
          }
          if (r.heal) {
            this.heal(t, Math.abs(r.amount));
            if (rate >= 0.99 || first) {
              if (this.ecAction) void this.effects.cure(t);
              else this.effects.heal(t.char.root.position.clone());
            }
            continue;
          }
          if (this.ecAction) void this.effects.impact(t, s.element, r.crit);
          else if (s.attack === 2 || s.element > 1) this.effects.burst(at, color, Math.min(2.5, 0.8 + t.radius * 0.5));
          else this.effects.hit(at, color, r.crit ? 1.5 : 1);
          if (!s.action?.se?.length) this.host.sfx.play(SE.hit);
          if (r.crit) this.shake = Math.max(this.shake, 0.25);
          const boost = 1 + (a.elementBoost?.[String(s.element)] ?? 0);
          this.damage(t, Math.min(9999, Math.round(r.amount * boost)), r.crit, undefined, r.note);
        }
      } else if (first && (e.kind === 'buff' || e.kind === 'status' || e.kind === 'cleanse')) {
        for (const t of recipients) {
          if (!t.alive) continue;
          if (e.chance && Math.random() * 1000 > e.chance) continue;
          if (e.kind === 'buff') {
            const name = this.data.index.buffTypes[String(e.buff)];
            if (!name) continue;
            const prev = t.buffs.get(name)?.level ?? 0;
            t.buffs.set(name, { level: Math.min(4, Math.max(prev, e.level ?? 1)), until: this.time + (e.duration ?? 30) });
            this.number(t, name.replace('patk', 'ATK').replace('matk', 'MAG').replace('pdef', 'DEF').replace('mdef', 'MDEF').replace('+', ' Up').replace('-', ' Down'), 'info');
            this.host.sfx.play(name.endsWith('+') ? SE.buff : SE.debuff);
          } else if (e.kind === 'status') {
            const st = e.status ?? 0;
            if (!STATUS_NAMES[st]) continue;
            const resist = t.enemy?.status?.[String(st)];
            if (resist === 0) {
              this.number(t, 'Immune', 'miss');
              continue;
            }
            t.statuses.set(st, this.time + (e.duration ?? 20));
            this.number(t, STATUS_NAMES[st], 'info');
            this.hud.notify(t.side === 'party' ? 'warning' : 'info', `${t.name}: ${STATUS_NAMES[st]}`);
          } else {
            this.cleanse(t);
          }
        }
      }
    }
  }

  private recipients(e: SkillEffect, a: Fighter, targets: Fighter[]) {
    if (e.target === 5) return [a];
    const mainAllies = targets.every((t) => t.side === a.side);
    const effectAllies = e.target === 3 || e.target === 4;
    if (effectAllies === mainAllies) return targets;
    return effectAllies ? [a] : targets;
  }

  private number(t: Fighter, text: string, kind: 'damage' | 'heal' | 'miss' | 'mp' | 'crit' | 'info') {
    const p = this.project(t.top());
    if (!p.behind) this.hud.number(text, p.x, p.y, kind);
  }

  damage(t: Fighter, amount: number, crit: boolean, label?: string, note?: string) {
    if (!t.alive) return;
    // Guard cuts hits (not poison) until the character's next turn
    if (t.guarding && !label) amount = Math.round(amount * GUARD_TAKEN);
    t.hp = Math.max(0, t.hp - amount);
    this.number(t, label ? `${amount}` : String(amount), crit ? 'crit' : 'damage');
    if (note === 'weak') {
      this.number(t, 'Weak!', 'info');
      this.hud.notify('star', `Exploited ${t.name}'s weakness`);
    }
    if (t.side === 'party' && amount > 0) {
      const before = t.limit;
      t.limit = Math.min(100, t.limit + limitGain(amount, t.stats.hp));
      if (before < 100 && t.limit >= 100) {
        this.host.sfx.play(SE.limitFull);
        this.limitReady(t);
        // the open command list shows Limit as ready right away
        const m = this.menu;
        if (m?.kind === 'command' && m.actor === t) this.openCommand(t, m.open, m.cursor);
      }
    }
    if (t.hp <= 0) this.kill(t);
    else if (amount > 0) t.react();
  }

  heal(t: Fighter, amount: number) {
    if (!t.alive) return;
    const before = t.hp;
    t.hp = Math.min(t.stats.hp, t.hp + amount);
    this.number(t, String(Math.round(t.hp - before) || amount), 'heal');
  }

  restore(t: Fighter, hp: number, mp: number) {
    if (!t.alive) return;
    if (hp > 0) this.heal(t, Math.round(hp));
    if (mp > 0) {
      const before = t.mp;
      t.mp = Math.min(t.stats.mp, t.mp + Math.round(mp));
      this.number(t, `${Math.round(t.mp - before)} MP`, 'mp');
    }
    this.effects.heal(t.char.root.position.clone());
  }

  revive(t: Fighter, share: number) {
    if (t.alive) return;
    t.alive = true;
    t.hp = Math.max(1, Math.round(t.stats.hp * share));
    t.atb = 0;
    t.statuses.clear();
    this.number(t, String(t.hp), 'heal');
    this.effects.heal(t.char.root.position.clone());
    void t.playClip(t.clip(/_die_001_03$/)).then((d) => setTimeout(() => t.alive && !t.acting && t.char.stopMotion(0.3), d * 1000));
  }

  /** An item's stat buff (jellies): level 1..4, like the skills' buffs. */
  buff(t: Fighter, name: string, level: number, seconds = 60) {
    if (!t.alive) return;
    const prev = t.buffs.get(name)?.level ?? 0;
    t.buffs.set(name, { level: Math.min(4, Math.max(prev, level)), until: this.time + seconds });
    this.number(t, name.replace('patk', 'ATK').replace('matk', 'MAG').replace('pdef', 'DEF').replace('mdef', 'MDEF').replace('+', ' Up'), 'info');
    this.host.sfx.play(SE.buff);
  }

  addLimit(t: Fighter, share: number) {
    if (!t.alive) return;
    const before = t.limit;
    t.limit = Math.min(100, t.limit + share * 100);
    if (before < 100 && t.limit >= 100) {
      this.host.sfx.play(SE.limitFull);
      this.limitReady(t);
    }
  }

  private limitReady(t: Fighter) {
    if (t.def?.limits.length) this.hud.notify('star', `${t.name}'s Limit Break is ready`, true);
  }

  cleanse(t: Fighter) {
    if (!t.alive) return;
    if (t.statuses.size) this.hud.notify('check', `${t.name}: status ailments cured`);
    t.statuses.clear();
  }

  itemDamage(u: Fighter, targets: Fighter[], element: number, potency = 1400) {
    const fake: Skill = { name: 'Cocktail', attack: 2, element, effects: [{ target: 2, type: 1, kind: 'damage', attack: 2, element, potency }] };
    this.applySkill(u, fake, targets, 1, true);
  }

  private kill(t: Fighter) {
    this.endGuard(t);
    t.alive = false;
    t.ready = false;
    t.atb = 0;
    t.statuses.clear();
    this.queue = this.queue.filter((q) => q.actor !== t);
    this.readyOrder = this.readyOrder.filter((f) => f !== t);
    if (this.menu?.actor === t) {
      this.menu = null;
      this.showMenu();
    }
    t.queued = false;
    this.hud.notify(t.side === 'party' ? 'warning' : 'defeated', t.side === 'party' ? `${t.name} was knocked out.` : `${t.name} defeated.`, t.side === 'enemy');
    if (t.side === 'party') {
      t.limit = 0;
      void t.playClip(t.clip(/_die_001_01$/)).then((d) =>
        setTimeout(() => {
          if (!t.alive) void t.playClip(t.clip(/_die_001_02_lp$/), true);
        }, Math.max(0, d * 1000 - 80)),
      );
      return;
    }
    // enemies: fall, then fade away
    // monsters name it die_001, die_001_01 or die_001_01_01
    void t.playClip(t.clip(/_die_001(?:_01){0,2}$/)).then(async (d) => {
      await this.sleep(Math.min(d, 1.6));
      await this.fadeOut(t);
    });
    if (this.host.game) {
      const d = this.host.game.drop(t.level);
      if (d) this.loot.push(d);
    } else if (Math.random() < 0.18) this.loot.push(['potion', 'ether', 'phoenix', 'hipotion'][Math.floor(Math.random() * 4)]);
  }

  private async fadeOut(t: Fighter) {
    const mats: THREE.Material[] = [];
    t.char.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (/outline|silhouette/i.test(m.name) || (m.material as THREE.Material).side === THREE.BackSide) {
        m.visible = false;
        return;
      }
      m.material = [m.material].flat().map((x) => {
        const c = x.clone();
        c.transparent = true;
        mats.push(c);
        return c;
      }) as unknown as THREE.Material;
      if (Array.isArray(m.material) && m.material.length === 1) m.material = m.material[0];
    });
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      for (const m of mats) {
        (m as THREE.MeshBasicMaterial).opacity = 1 - i / steps;
        if ('emissive' in m) (m as THREE.MeshStandardMaterial).emissive?.setRGB(0.6 * (i / steps), 0.05, 0.25 * (i / steps));
      }
      await this.sleep(0.035);
    }
    t.char.root.visible = false;
    t.removed = true;
  }

  // ------------------------------------------------------------------ end of battle
  private checkEnd() {
    if (this.finished || this.executing) return;
    if (this.party.length && this.party.every((f) => !f.alive)) return void this.defeat();
    if (this.enemies.every((f) => !f.alive) && this.enemies.every((f) => f.removed)) {
      if (this.wave + 1 < this.def.waves.length) void this.nextWave();
      else void this.victory();
    }
  }

  private async nextWave() {
    this.finished = true;
    this.host.sfx.play(SE.wave);
    this.hud.notify('warning', `Wave ${this.wave + 2} of ${this.def.waves.length}: more enemies approaching`, true);
    for (const e of this.enemies) e.char.dispose();
    await this.loadWave(this.wave + 1);
    const bgm = this.def.waves[this.wave].bgm;
    if (bgm) this.playMusic(bgm);
    this.finished = false;
  }

  private async victory() {
    this.finished = true;
    this.menu = null;
    this.showMenu();
    this.readyOrder = [];
    this.host.sfx.play(SE.finish);
    this.resetCamera();
    await this.sleep(0.6);
    this.playMusic(FANFARE);
    for (const f of this.party) {
      if (!f.alive) continue;
      f.ready = false;
      void f.playClip(f.clip(/_win_001_01$/)).then((d) => setTimeout(() => f.alive && void f.playClip(f.clip(/_win_001_02_lp$/), true), Math.max(0, d * 1000 - 100)));
    }
    const all = this.def.waves.flatMap((w) => w.enemies.map((e) => this.data.enemies[e.enemy])).filter(Boolean);
    let exp = all.reduce((s, e) => s + 12 * e.level + 8, 0);
    let gil = all.reduce((s, e) => s + 7 * e.level + 5, 0);
    let got: string[];
    let level: number | undefined;
    if (this.host.game) {
      const r = this.host.game.won(this.def.id, all.map((e) => e.level), this.party[0]?.level ?? 1, this.loot);
      ({ exp, gil, level } = r);
      got = r.items;
    } else {
      for (const l of this.loot) this.items[l] = (this.items[l] ?? 0) + 1;
      if (this.loot.length) saveItems(this.items);
      got = this.loot.map((l) => ITEMS.find((i) => i.id === l)?.name ?? l);
    }
    const lootText = got.length ? got.join(', ') : 'Nothing';
    // the feed tells the rewards one by one, like Remake's after-battle notices
    this.hud.notify('exp', `${exp.toLocaleString('en-US')} EXP gained.`);
    this.hud.notify('gil', `${gil.toLocaleString('en-US')} gil obtained.`);
    for (const g of got) this.hud.notify('item', `Obtained ${g}`);
    if (level) this.hud.notify('star', `Level up! The party reached level ${level}.`, true);
    await this.sleep(1.4);
    const choice = await this.ask(
      `<h3>Victory</h3><table><tr><td>EXP</td><td>${exp}</td></tr><tr><td>Gil</td><td>${gil}</td></tr><tr><td>Items</td><td>${lootText}</td></tr></table>`,
      ['Continue'],
    );
    void choice;
    this.end('won');
  }

  private async defeat() {
    this.finished = true;
    this.menu = null;
    this.showMenu();
    this.host.music.play(null);
    this.host.sfx.play(SE.gameover);
    await this.sleep(2);
    const i = await this.ask('<h3 class="gameover">GAME OVER</h3><p>The party has fallen.</p>', ['Retry', 'Skip battle']);
    this.end(i === 0 ? 'retry' : 'skipped');
  }

  private escapeCheck(dt: number) {
    if (!this.req.escapable) return;
    // FF7 escape: hold L1 + R1 (here Q + R, gamepad L2 + R2)
    if (this.keysDown.has('q') && this.keysDown.has('r')) {
      this.escapeHeld += dt;
      if (this.escapeHeld > 1.4) {
        this.finished = true;
        this.hud.showBanner('Escaped!', 1.5);
        void this.sleep(1.2).then(() => this.end('escaped'));
      }
    } else this.escapeHeld = 0;
  }

  keysDown = new Set<string>();

  private ask(html: string, buttons: string[]) {
    return new Promise<number>((resolve) => {
      this.modal = {
        buttons,
        cursor: 0,
        pick: (i) => {
          this.modal = null;
          this.hud.showModal(null);
          this.host.sfx.play(SE.decide);
          resolve(i);
        },
      };
      this.hud.showModal(html, buttons, 0);
    });
  }

  private renderModalButtons() {
    const m = this.modal;
    if (!m) return;
    this.hud.root.querySelectorAll('.b-modal .b-btn').forEach((b, i) => b.classList.toggle('cursor', i === m.cursor));
  }

  /** Esc may pause the battle: no command list, target cursor or dialog is open, and it is not over. */
  get canPause() {
    return this.ready && !this.finished && !this.modal && (!this.menu || (this.menu.kind === 'command' && !this.menu.open));
  }

  /** The battle can be fled (random encounters). */
  get escapable() {
    return !!this.req.escapable;
  }

  /** Pause menu: Retry ('retry'), Escape or Quit to title ('escaped'). */
  abort(o: BattleOutcome) {
    if (this.over) return;
    this.finished = true;
    this.menu = null;
    this.showMenu();
    this.end(o);
  }

  private end(o: BattleOutcome) {
    if (this.over) return;
    this.over = true;
    this.host.game?.ended(
      this.party.map((f) => ({ id: f.charId, hp: f.hp / f.stats.hp, mp: f.mp / Math.max(1, f.stats.mp), alive: f.alive })),
      o,
    );
    // back to the field's track, from its start like FF7
    if (this.prevMusic) this.host.music.play(this.prevMusic.track, { pin: this.prevMusic.pinned });
    this.resolveOutcome(o);
  }

  dispose() {
    for (const f of [...this.guardFx.keys()]) this.stopGuardFx(f);
    this.offCanvas();
    setGamepadProfile('field');
    for (const f of [...this.party, ...this.enemies]) f.char.dispose();
    this.effects.dispose();
    this.stage?.dispose();
    this.hud.dispose();
    this.waits = [];
  }
}

/** Battle ids a field-script battle stands for: its story-party battle first. */
export function battleIdsOf(storyBattle: number, battleIds: number[] | undefined) {
  return battleIds?.length ? battleIds : [storyBattle];
}
