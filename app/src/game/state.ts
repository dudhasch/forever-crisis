import type { BattleIndex, CharacterDef, WeaponDef } from '../battle/data';
import { characterStats, type Stats } from '../battle/rules';
import type { MateriaDef, MenuCharacter, MenuData, Outfit, Reward, ShopOffer } from './data';

/**
 * The save game: story position, inventory, gear, party and settings. The running game autosaves to
 * localStorage (Continue on the title screen); three slots hold copies.
 */

export const STAT_KEYS = ['hp', 'mp', 'patk', 'matk', 'pdef', 'mdef', 'heal'] as const;
const MEMORIA_STATS = ['hp', 'patk', 'matk', 'pdef', 'mdef', 'heal'] as const;
/** EC lists memoria stats at max level for a fully geared account: here they give 10% of that at party Lv 100. */
const MEMORIA_SHARE = 0.1;
/** EC materia sub-stats are sized for EC's endgame numbers (Fira: MATK +145): a quarter of them here. */
const MATERIA_STAT_SHARE = 0.25;
/** Materia levels (Blue Crystal upgrades, EC's 10 levels in m_materia_level): sub-stats and the MP bonus grow with them. */
export const MATERIA_MAX_LEVEL = 10;
const STAT_PER_LEVEL = 0.1;
export function materiaStat(v: number, lv = 1) {
  return Math.max(1, Math.round(v * MATERIA_STAT_SHARE * (1 + STAT_PER_LEVEL * (lv - 1))));
}
/** FF7: each magic materia raises max MP a little (more with its level). */
const MP_PER_MATERIA = 0.05;
const MP_PER_LEVEL = 0.005;
export const MATERIA_SLOTS = 4;
export const PHOENIX_DOWN = 9001;
const CURRENT_KEY = 'ff7ec.game';
const SLOT_KEY = (n: number) => `ff7ec.save.${n}`;
export const SLOT_COUNT = 3;
export const DEFAULT_PARTY = [1, 2, 3];
const START_ITEMS: Record<number, number> = { 101: 10, 102: 2, [PHOENIX_DOWN]: 3, 201: 4, 301: 1 };
/** Starter materia per character, like FF7's first pieces: an element and Cure. */
const STARTER_ELEMENTS = [2111001, 2131001, 2121001, 2161001, 2141001, 2151001];
const CURE = 2200001;

export interface Equip {
  weapon: number;
  costume: number;
  memoria: number | null;
  /** materia instance uids (negative = sandbox copy of materia -uid) */
  materia: (number | null)[];
  summon: number | null;
}

export interface MateriaInst {
  uid: number;
  id: number;
  /** upgrade level, 1 when missing (older saves) */
  lv?: number;
}

export interface Position {
  mode: 'story' | 'free';
  map: string | null;
  content: string | null;
  step: number | null;
  title?: string;
  chapter?: string;
  family?: string;
  mapTitle?: string;
}

export interface SaveData {
  version: 1;
  savedAt: number;
  playTime: number;
  position: Position;
  /** StoryFlags snapshot (only in slots: the running game keeps it under ff7ec.storyFlags). */
  flags?: unknown;
  battleSettings?: unknown;
  gil: number;
  crystals: number;
  items: Record<string, number>;
  materials: Record<string, number>;
  keyItems: number[];
  dungeonKeys: number;
  weapons: number[];
  costumes: number[];
  memoria: number[];
  materia: MateriaInst[];
  summons: number[];
  nextUid: number;
  equip: Record<string, Equip>;
  party: number[];
  leader: number;
  level: number;
  exp: number;
  cleared: { episodes: number[]; chapters: number[]; battles: number[]; treasures?: number[] };
  /** Jellies used in the field: buffs for the next battle, per character. */
  buffs: Record<string, string[]>;
  /** HP / MP shares carried from battle to battle (FF7), per character. */
  vitals: Record<string, [number, number]>;
  /** Carry HP/MP between battles; off = every battle starts at full health. */
  carryVitals: boolean;
  /** Battle shortcut palette per character: four skill keys (null = empty slot). */
  shortcuts?: Record<string, (string | null)[]>;
  sandbox: boolean;
}

export interface SlotInfo {
  slot: number;
  data: SaveData | null;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* private mode or full */
  }
}

function blank(): SaveData {
  return {
    version: 1,
    savedAt: 0,
    playTime: 0,
    position: { mode: 'story', map: null, content: null, step: null },
    gil: 0,
    crystals: 0,
    items: {},
    materials: {},
    keyItems: [],
    dungeonKeys: 0,
    weapons: [],
    costumes: [],
    memoria: [],
    materia: [],
    summons: [],
    nextUid: 1,
    equip: {},
    party: [...DEFAULT_PARTY],
    leader: 1,
    level: 1,
    exp: 0,
    cleared: { episodes: [], chapters: [], battles: [] },
    buffs: {},
    vitals: {},
    carryVitals: true,
    sandbox: false,
  };
}

export interface Loadout {
  weapon: WeaponDef | undefined;
  outfit: Outfit | undefined;
  stats: Stats;
  /** Battle spell ids from the equipped materia. */
  spells: string[];
  summons: number[];
  /** element -> extra ability damage share (0.35 = +35%) */
  elements: Record<string, number>;
  /** C.Abilities: the equipped weapon's, then those of other owned weapons */
  abilities: string[];
  model: string | null;
}

export class GameState {
  d: SaveData;
  private listeners = new Set<() => void>();
  private saveTimer = 0;
  private started = performance.now();
  /** Set once menu.json and the battle index are in. */
  menu: MenuData | null = null;
  index: BattleIndex | null = null;
  /** Whether a game is running (title screen passed). */
  active = false;

  constructor() {
    this.d = { ...blank(), ...(read<SaveData>(CURRENT_KEY) ?? {}) };
  }

  get hasSave() {
    return this.d.savedAt > 0 && !!this.d.position.map;
  }

  init(menu: MenuData, index: BattleIndex) {
    this.menu = menu;
    this.index = index;
    this.ensureDefaults();
  }

  /** Every character starts with its default weapon and outfit (and FF7-like starter materia on a new game). */
  private ensureDefaults() {
    const idx = this.index;
    if (!idx) return;
    const fresh = this.d.savedAt === 0 && !Object.keys(this.d.equip).length;
    let n = 0;
    for (const c of Object.values(idx.characters)) {
      if (!this.d.weapons.includes(c.defaultWeapon)) this.d.weapons.push(c.defaultWeapon);
      if (!this.d.costumes.includes(c.defaultCostume)) this.d.costumes.push(c.defaultCostume);
      const e = (this.d.equip[String(c.id)] ??= { weapon: c.defaultWeapon, costume: c.defaultCostume, memoria: null, materia: [], summon: null });
      while (e.materia.length < MATERIA_SLOTS) e.materia.push(null);
      if (fresh) {
        e.materia[0] = this.addMateria(STARTER_ELEMENTS[n++ % STARTER_ELEMENTS.length]);
        e.materia[1] = this.addMateria(CURE);
      }
    }
    if (fresh) for (const [id, n2] of Object.entries(START_ITEMS)) this.d.items[id] = n2;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 300);
  }

  /** Autosave the running game (what Continue resumes). */
  save() {
    clearTimeout(this.saveTimer);
    if (!this.active) return;
    this.d.playTime += (performance.now() - this.started) / 1000;
    this.started = performance.now();
    this.d.savedAt = Date.now();
    write(CURRENT_KEY, { ...this.d, flags: undefined, battleSettings: undefined });
  }

  saveSlot(slot: number, flags: unknown, battleSettings: unknown) {
    this.active = true;
    this.save();
    write(SLOT_KEY(slot), { ...this.d, flags, battleSettings });
  }

  slots(): SlotInfo[] {
    return Array.from({ length: SLOT_COUNT }, (_, i) => ({ slot: i + 1, data: read<SaveData>(SLOT_KEY(i + 1)) }));
  }

  current(): SaveData | null {
    return this.hasSave ? this.d : null;
  }

  /** Load a slot as the running game; returns its flags/settings snapshot for the caller to restore. */
  loadSlot(slot: number) {
    const s = read<SaveData>(SLOT_KEY(slot));
    if (!s) return null;
    const { flags, battleSettings, ...rest } = s;
    this.d = { ...blank(), ...rest };
    this.ensureDefaults();
    this.started = performance.now();
    this.active = true;
    this.save();
    this.changed();
    return { flags, battleSettings };
  }

  deleteSlot(slot: number) {
    try {
      localStorage.removeItem(SLOT_KEY(slot));
    } catch {
      /* ignore */
    }
  }

  /** Forget inventory and gear (story flags are the caller's). */
  reset() {
    this.d = blank();
    this.ensureDefaults();
    this.changed();
  }

  setPosition(p: Position) {
    this.d.position = p;
    this.changed();
  }

  // ------------------------------------------------------------------ inventory
  char(id: number): MenuCharacter | undefined {
    return this.menu?.characters[String(id)];
  }

  def(id: number): CharacterDef | undefined {
    return this.index?.characters[String(id)];
  }

  itemCount(id: number) {
    if (this.d.sandbox) return 99;
    return this.d.items[String(id)] ?? 0;
  }

  addItem(id: number, n = 1) {
    const k = String(this.menu?.alias[String(id)] ?? id);
    this.d.items[k] = Math.min(99, (this.d.items[k] ?? 0) + n);
  }

  consumeItem(id: number) {
    if (this.d.sandbox) return true;
    const k = String(id);
    if ((this.d.items[k] ?? 0) <= 0) return false;
    this.d.items[k]--;
    if (!this.d.items[k]) delete this.d.items[k];
    this.changed();
    return true;
  }

  private addMateria(id: number) {
    const uid = this.d.nextUid++;
    this.d.materia.push({ uid, id: this.menu?.materiaAlias[String(id)] ?? id });
    return uid;
  }

  materiaDef(uid: number | null): MateriaDef | undefined {
    // negative uids are the sandbox's copies: gone with the sandbox
    if (uid === null || (uid < 0 && !this.d.sandbox)) return undefined;
    const id = uid < 0 ? -uid : this.d.materia.find((m) => m.uid === uid)?.id;
    return this.menu?.materia.find((m) => m.id === id);
  }

  /** Upgrade level of a materia instance (sandbox copies are maxed). */
  materiaLevel(uid: number | null): number {
    if (uid === null) return 1;
    if (uid < 0) return this.d.sandbox ? MATERIA_MAX_LEVEL : 1;
    return Math.min(MATERIA_MAX_LEVEL, this.d.materia.find((m) => m.uid === uid)?.lv ?? 1);
  }

  /** Blue Crystals to take a materia from `lv` to the next level (null at the maximum). */
  materiaUpgradeCost(lv: number): number | null {
    return lv >= MATERIA_MAX_LEVEL ? null : (this.menu?.materiaLevels?.[lv - 1] ?? null);
  }

  /** Spend Blue Crystals to raise an owned materia one level. Returns an error message or null. */
  upgradeMateria(uid: number): string | null {
    const inst = uid > 0 ? this.d.materia.find((m) => m.uid === uid) : undefined;
    if (!inst) return 'Sandbox materia are already at the maximum';
    const lv = this.materiaLevel(uid);
    const cost = this.materiaUpgradeCost(lv);
    if (cost === null) return 'Already at the maximum level';
    if (this.d.crystals < cost) return 'Not enough Blue Crystals';
    this.d.crystals -= cost;
    inst.lv = lv + 1;
    this.changed();
    return null;
  }

  /** Materia the player can put into slots: owned instances, or one of everything in the sandbox. */
  materiaList(): MateriaInst[] {
    if (this.d.sandbox) return (this.menu?.materia ?? []).map((m) => ({ uid: -m.id, id: m.id }));
    return this.d.materia;
  }

  /** Who has this materia instance equipped. */
  materiaHolder(uid: number) {
    if (uid < 0) return null;
    for (const [c, e] of Object.entries(this.d.equip)) if (e.materia.includes(uid)) return Number(c);
    return null;
  }

  ownsWeapon(id: number) {
    return this.d.sandbox || this.d.weapons.includes(id);
  }

  ownsCostume(id: number) {
    return this.d.sandbox || this.d.costumes.includes(id);
  }

  ownsMemoria(id: number) {
    return this.d.sandbox || this.d.memoria.includes(id);
  }

  ownsSummon(id: number) {
    return this.d.sandbox || this.d.summons.includes(id);
  }

  keyItems(): number[] {
    return this.d.sandbox ? (this.menu?.keyItems ?? []).map((k) => k.id) : this.d.keyItems;
  }

  // ------------------------------------------------------------------ shop
  /** Whether a unique piece of gear (weapon, outfit, memoria) is already owned. Sandbox ownership doesn't count. */
  private ownedForShop(o: ShopOffer) {
    if (o.kind === 'weapon') return this.d.weapons.includes(o.id);
    if (o.kind === 'costume') return this.d.costumes.includes(o.id);
    if (o.kind === 'memoria') return this.d.memoria.includes(o.id);
    return false;
  }

  /** What the Shop shows for a category: the curated stock, in price order. */
  shopStock(kind: ShopOffer['kind'], charId?: number): { offer: ShopOffer; locked: boolean; owned: boolean }[] {
    return (this.menu?.shop.stock ?? [])
      .filter((o) => o.kind === kind && (charId === undefined || o.char === charId))
      .sort((a, b) => a.price - b.price || a.id - b.id)
      .map((offer) => ({ offer, locked: offer.level > this.d.level, owned: this.ownedForShop(offer) }));
  }

  /** Buy `qty` of an offer for Gil (items and materia can be bought repeatedly, gear once). Returns an error message or null. */
  buy(o: ShopOffer, qty = 1): string | null {
    if (o.level > this.d.level) return `Unlocks at party Lv ${o.level}`;
    if (this.ownedForShop(o)) return 'Already owned';
    if (o.kind === 'item') qty = Math.min(qty, 99 - (this.d.items[String(o.id)] ?? 0));
    else if (o.kind !== 'materia') qty = 1;
    if (qty <= 0) return 'You carry the maximum';
    const cost = o.price * qty;
    if (this.d.gil < cost) return 'Not enough Gil';
    this.d.gil -= cost;
    if (o.kind === 'item') this.addItem(o.id, qty);
    else if (o.kind === 'materia') for (let i = 0; i < qty; i++) this.addMateria(o.id);
    else this.grant([{ kind: o.kind, id: o.id, count: 1, name: null }]);
    this.changed();
    return null;
  }

  /** Gil for one of an item (half its shop price), a material or a crystal. */
  sellPrice(kind: 'item' | 'material' | 'crystal', id: number) {
    const sell = this.menu?.shop.sell;
    if (!sell) return 0;
    if (kind === 'crystal') return sell.crystal;
    if (kind === 'material') return sell.material[String(id)] ?? 0;
    const offer = this.menu?.shop.stock.find((o) => o.kind === 'item' && o.id === id);
    return Math.max(1, Math.floor(((offer?.price ?? 0) * sell.itemShare)));
  }

  /** How many of an item, material or crystal the player holds. */
  holdings(kind: 'item' | 'material' | 'crystal', id: number) {
    if (kind === 'crystal') return this.d.crystals;
    if (kind === 'material') return this.d.materials[String(id)] ?? 0;
    return this.d.items[String(id)] ?? 0;
  }

  /** Sell `qty` (clamped to what is held). Returns the Gil earned. */
  sell(kind: 'item' | 'material' | 'crystal', id: number, qty = 1): number {
    const n = Math.min(qty, this.holdings(kind, id));
    const gil = n * this.sellPrice(kind, id);
    if (n <= 0 || gil <= 0) return 0;
    if (kind === 'crystal') this.d.crystals -= n;
    else if (kind === 'material') {
      const k = String(id);
      this.d.materials[k] -= n;
      if (this.d.materials[k] <= 0) delete this.d.materials[k];
    } else {
      const k = String(id);
      this.d.items[k] -= n;
      if (this.d.items[k] <= 0) delete this.d.items[k];
    }
    this.d.gil += gil;
    this.changed();
    return gil;
  }

  /** Add rewards (treasures, battles, episode clears). Returns "Potion ×4"-style lines. */
  grant(rewards: Reward[]): string[] {
    const lines: string[] = [];
    for (const r of rewards) {
      const name = r.name ?? r.kind;
      switch (r.kind) {
        case 'gil':
          this.d.gil += r.count;
          lines.push(`${r.count.toLocaleString()} Gil`);
          continue;
        case 'crystal':
          this.d.crystals += r.count;
          break;
        case 'item':
          this.addItem(r.id, r.count);
          break;
        case 'material':
          this.d.materials[String(r.id)] = (this.d.materials[String(r.id)] ?? 0) + r.count;
          break;
        case 'materia':
          for (let i = 0; i < r.count; i++) this.addMateria(r.id);
          lines.push(`${name} materia${r.count > 1 ? ` ×${r.count}` : ''}`);
          continue;
        case 'weapon':
          if (!this.d.weapons.includes(r.id)) this.d.weapons.push(r.id);
          break;
        case 'costume':
          if (!this.d.costumes.includes(r.id)) this.d.costumes.push(r.id);
          break;
        case 'memoria':
          if (!this.d.memoria.includes(r.id)) this.d.memoria.push(r.id);
          break;
        case 'keyitem':
          if (!this.d.keyItems.includes(r.id)) this.d.keyItems.push(r.id);
          break;
        case 'dungeonkey':
          this.d.dungeonKeys += r.count;
          break;
      }
      lines.push(r.count > 1 ? `${name} ×${r.count}` : name);
    }
    if (rewards.length) this.changed();
    return lines;
  }

  /** FF7's summons were found along the way: here each one turns up once the party reaches its level. */
  grantSummonsUpTo(level: number): string[] {
    const out: string[] = [];
    for (const s of this.index?.summons ?? []) {
      if (s.level <= level && !this.d.summons.includes(s.id)) {
        this.d.summons.push(s.id);
        out.push(`${s.name} materia`);
      }
    }
    if (out.length) this.changed();
    return out;
  }

  setLevel(level: number) {
    if (level <= this.d.level) return [];
    this.d.level = level;
    const got = this.grantSummonsUpTo(level);
    this.changed();
    return got;
  }

  // ------------------------------------------------------------------ equipment
  equip(charId: number): Equip {
    const k = String(charId);
    const def = this.def(charId);
    const e = (this.d.equip[k] ??= { weapon: def?.defaultWeapon ?? 0, costume: def?.defaultCostume ?? 0, memoria: null, materia: [], summon: null });
    while (e.materia.length < MATERIA_SLOTS) e.materia.push(null);
    return e;
  }

  setWeapon(charId: number, id: number) {
    this.equip(charId).weapon = id;
    this.changed();
  }

  setCostume(charId: number, id: number) {
    this.equip(charId).costume = id;
    this.changed();
  }

  setMemoria(charId: number, id: number | null) {
    // one memoria, one wearer
    if (id !== null && !this.d.sandbox) for (const e of Object.values(this.d.equip)) if (e.memoria === id) e.memoria = null;
    this.equip(charId).memoria = id;
    this.changed();
  }

  setMateria(charId: number, slot: number, uid: number | null) {
    if (uid !== null && uid > 0) for (const e of Object.values(this.d.equip)) e.materia = e.materia.map((m) => (m === uid ? null : m));
    this.equip(charId).materia[slot] = uid;
    this.changed();
  }

  setSummon(charId: number, id: number | null) {
    if (id !== null && !this.d.sandbox) for (const e of Object.values(this.d.equip)) if (e.summon === id) e.summon = null;
    this.equip(charId).summon = id;
    this.changed();
  }

  setParty(members: number[], leader?: number) {
    this.d.party = members.slice(0, 3);
    this.d.leader = leader !== undefined && members.includes(leader) ? leader : (members[0] ?? 1);
    this.changed();
  }

  /** Stats, spells and gear of a character at a level (menu Status and the battle). */
  loadout(charId: number, level = this.d.level): Loadout | null {
    const def = this.def(charId);
    if (!def) return null;
    const e = this.equip(charId);
    // Gear picked in the sandbox and not owned falls back to the defaults once the sandbox is off.
    const weapon = def.weapons.find((w) => w.id === e.weapon && this.ownsWeapon(w.id)) ?? def.weapons.find((w) => w.id === def.defaultWeapon) ?? def.weapons[0];
    const mc = this.char(charId);
    // costume -1: no outfit at all (the Status screen's "base" column)
    const outfit =
      mc?.outfits.find((o) => o.id === e.costume && this.ownsCostume(o.id)) ??
      (e.costume === -1 ? undefined : mc?.outfits.find((o) => o.id === def.defaultCostume));
    const s = characterStats(def, level, weapon);
    const flat: Record<string, number> = {};
    const pct: Record<string, number> = {};
    const elements: Record<string, number> = {};
    for (const p of outfit?.passives ?? []) {
      for (const [k, [f, q]] of Object.entries(p.stats)) {
        flat[k] = (flat[k] ?? 0) + f;
        pct[k] = (pct[k] ?? 0) + q;
      }
      for (const [el, q] of Object.entries(p.elements)) elements[el] = (elements[el] ?? 0) + q / 100;
    }
    const mem = e.memoria !== null && this.ownsMemoria(e.memoria) ? this.menu?.memoria.find((m) => m.id === e.memoria) : undefined;
    if (mem) MEMORIA_STATS.forEach((k, i) => (flat[k] = (flat[k] ?? 0) + Math.round(mem.stats[i] * MEMORIA_SHARE * (level / 100))));
    const materia: (MateriaDef & { lv: number })[] = [];
    for (const u of e.materia) {
      const m = this.materiaDef(u);
      if (m) materia.push({ ...m, lv: this.materiaLevel(u) });
    }
    for (const m of materia) for (const [k, v] of Object.entries(m.stats)) flat[k] = (flat[k] ?? 0) + materiaStat(v, m.lv);
    const stats: Stats = { ...s };
    for (const k of ['hp', 'patk', 'matk', 'pdef', 'mdef', 'heal'] as const) {
      stats[k] = Math.round((s[k] + (flat[k] ?? 0)) * (1 + (pct[k] ?? 0) / 100));
    }
    // MP follows the rules' formula with the new MATK, plus FF7's bonus per magic materia
    let mpBonus = e.summon !== null ? MP_PER_MATERIA : 0;
    for (const m of materia) if (m.spells.length) mpBonus += MP_PER_MATERIA + MP_PER_LEVEL * (m.lv - 1);
    stats.mp = Math.round((40 + level * 4 + stats.matk / 3) * (1 + mpBonus));
    // spells: the first of each materia at once, its stronger spell once the party reaches that spell's level
    const spellLevel = new Map((this.index?.spells ?? []).map((sp) => [sp.id, sp.level]));
    const spells: string[] = [];
    for (const m of materia) {
      m.spells.forEach((sp, i) => {
        if ((i === 0 || (spellLevel.get(sp) ?? 0) <= level) && !spells.includes(sp)) spells.push(sp);
      });
    }
    const summons = e.summon !== null && this.ownsSummon(e.summon) ? [e.summon] : [];
    const abilities: string[] = [];
    if (weapon?.ability) abilities.push(weapon.ability);
    const extra = Math.min(5, 1 + Math.floor(level / 12));
    for (const w of def.weapons) {
      if (abilities.length >= extra + 1) break;
      if (w.ability && !abilities.includes(w.ability) && this.ownsWeapon(w.id)) abilities.push(w.ability);
    }
    return { weapon, outfit, stats, spells, summons, elements, abilities, model: outfit?.glb ?? def.model };
  }

  /** The field model and weapon glb of the party leader (Free Roam). */
  leaderLook() {
    const id = this.d.party.includes(this.d.leader) ? this.d.leader : (this.d.party[0] ?? 1);
    const lo = this.loadout(id);
    return lo ? { model: lo.model, weaponGlb: lo.weapon?.glb ?? null } : null;
  }

  // ------------------------------------------------------------------ story milestones
  clearEpisode(id: number): string[] {
    if (this.d.cleared.episodes.includes(id)) return [];
    this.d.cleared.episodes.push(id);
    return this.grant(this.menu?.episodes[String(id)] ?? []);
  }

  clearChapter(id: number) {
    if (!this.d.cleared.chapters.includes(id)) this.d.cleared.chapters.push(id);
    this.changed();
  }

  /** Rewards for winning a battle: EC's first-win wave rewards, then gil every time. */
  winBattle(id: number, gil: number): string[] {
    const lines: string[] = [];
    if (!this.d.cleared.battles.includes(id)) {
      this.d.cleared.battles.push(id);
      lines.push(...this.grant(this.menu?.battles[String(id)]?.rewards ?? []));
    }
    this.d.gil += gil;
    this.changed();
    return lines;
  }

  /** A treasure box's rewards, once per box (replays reopen boxes with throwaway flags). */
  treasure(id: number): string[] {
    const got = (this.d.cleared.treasures ??= []);
    if (got.includes(id)) return [];
    got.push(id);
    return this.grant(this.menu?.treasures[String(id)] ?? []);
  }

  takeBuffs(charId: number) {
    const b = this.d.buffs[String(charId)] ?? [];
    delete this.d.buffs[String(charId)];
    if (b.length) this.changed();
    return b;
  }

  addBuff(charId: number, buff: string) {
    const list = (this.d.buffs[String(charId)] ??= []);
    if (!list.includes(buff)) list.push(buff);
    this.changed();
  }

  vitals(charId: number): [number, number] {
    if (!this.d.carryVitals) return [1, 1];
    return this.d.vitals[String(charId)] ?? [1, 1];
  }

  setVitals(charId: number, hp: number, mp: number) {
    this.d.vitals[String(charId)] = [Math.max(0, Math.min(1, hp)), Math.max(0, Math.min(1, mp))];
    this.changed();
  }

  /** The character's battle shortcuts, or null when none were set yet (the battle then uses its first abilities). */
  shortcuts(charId: number): (string | null)[] | null {
    return this.d.shortcuts?.[String(charId)] ?? null;
  }

  setShortcuts(charId: number, keys: (string | null)[]) {
    (this.d.shortcuts ??= {})[String(charId)] = [...keys];
    this.changed();
  }

  /** Inn / Tent: everyone back to full. */
  restoreAll() {
    this.d.vitals = {};
    this.changed();
  }

  playTime() {
    return this.d.playTime + (this.active ? (performance.now() - this.started) / 1000 : 0);
  }
}

export function formatTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
