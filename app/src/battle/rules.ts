import type { BattleIndex, CharacterDef, EnemyDef, Skill, SkillEffect, WeaponDef } from './data';

/**
 * FF7 (1997) battle rules fed with Ever Crisis numbers.
 *
 * EC has no damage formula in its data (it is compiled code), so these are tuned by hand to play like FF7:
 * a normal attack takes a fresh story enemy down in two or three hits, an enemy attack takes roughly a tenth of
 * a character's HP, a Cure heals about a quarter. Stats, potencies, elements and resistances are EC's own.
 */

export type AtbMode = 'active' | 'slow' | 'wait';

export interface BattleSettings {
  /** What the ATB gauges do while a command menu is open: run (Active), crawl (Slow) or stop (Wait). */
  mode: AtbMode;
  /** Speed of the gauges in Slow mode, 0.05..0.9 (default 0.2 = an 80% slowdown). */
  slowFactor: number;
  /** 0.5..2 like FF7's Battle Speed slider. */
  speed: number;
  /** Random battles while walking on maps whose story has enemies. */
  encounters: boolean;
  /** Added to the party's fair level (negative = harder). */
  levelOffset: number;
  /** Enemy damage multiplier (difficulty). */
  enemyDamage: number;
  /** Streamlined Progression (Options → Game): double EXP and Gil from battles. */
  easyGains: boolean;
  /** Streamlined Progression: enemies hit half as hard and the party fights 5 levels above the fair level. */
  easyFights: boolean;
  /** Streamlined Progression: HP and MP are full again after every battle. */
  easyRecovery: boolean;
}

export const DEFAULT_SETTINGS: BattleSettings = {
  mode: 'slow',
  slowFactor: 0.2,
  speed: 1,
  encounters: true,
  levelOffset: 0,
  enemyDamage: 1,
  easyGains: false,
  easyFights: false,
  easyRecovery: false,
};

/** Enemy damage multiplier with Streamlined Progression applied. */
export function enemyDamageScale(s: BattleSettings) {
  return s.enemyDamage * (s.easyFights ? 0.5 : 1);
}

/** Party level offset with Streamlined Progression applied. */
export function partyLevelOffset(s: BattleSettings) {
  return s.levelOffset + (s.easyFights ? 5 : 0);
}

/** Battle EXP / Gil multiplier (Streamlined Progression). */
export function gainScale(s: BattleSettings) {
  return s.easyGains ? 2 : 1;
}
const SETTINGS_KEY = 'ff7ec.battleSettings';

export function loadSettings(): BattleSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<BattleSettings>) };
  } catch {
    /* private mode */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: BattleSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

export interface Stats {
  hp: number;
  mp: number;
  patk: number;
  matk: number;
  pdef: number;
  mdef: number;
  heal: number;
}

/** Normal attacks a Cloud-like attacker needs for a standard (coefficient 1000) enemy of the same level. */
const HITS_PER_STANDARD_ENEMY = 2.3;
/** Share of a Cloud-like character's HP a standard enemy attack (70% potency) takes. */
const ENEMY_HIT_SHARE = 0.12;
/** Boss HP above the standard curve is compressed by this exponent (EC bosses are balanced for gear). */
const BOSS_HP_EXPONENT = 0.45;
/** Enemy attack above 1.5x the reference is compressed the same way (big hits stay big, not lethal). */
const BOSS_ATK_EXPONENT = 0.5;

/**
 * Level curves the damage is calibrated against: EC's reference enemy (level parameter group 1) and Cloud
 * with his first weapon. EC players carry far more gear than an FF7 party, so raw numbers would make every
 * fight a slog; these keep the game's ratios (weak/strong enemies, potencies, weaknesses) intact.
 */
interface Curves {
  refHp: (l: number) => number;
  refAtk: (l: number) => number;
  heroAtk: (l: number) => number;
  heroHp: (l: number) => number;
  heroHeal: (l: number) => number;
}
let curves: Curves | null = null;

export function calibrate(index: BattleIndex) {
  const ref = index.enemyReference;
  const cloud = index.characters['1'];
  const weapon = cloud?.weapons.find((w) => w.id === cloud.defaultWeapon) ?? cloud?.weapons[0];
  const at = (arr: number[], l: number) => {
    const i = ref.levels.findIndex((x) => x >= l);
    return arr[i < 0 ? arr.length - 1 : i] ?? arr[0];
  };
  const hero = (l: number) => (cloud ? characterStats(cloud, l, weapon) : { hp: 300 + l * 24, patk: 50 + l * 2.4, heal: 80 + l });
  curves = {
    refHp: (l) => at(ref.hp, l),
    refAtk: (l) => at(ref.patk, l),
    heroAtk: (l) => hero(l).patk,
    heroHp: (l) => hero(l).hp,
    heroHeal: (l) => hero(l).heal,
  };
}

function playerScale(level: number) {
  if (!curves) return 1;
  return curves.refHp(level) / (HITS_PER_STANDARD_ENEMY * curves.heroAtk(level));
}

function enemyScale(level: number) {
  if (!curves) return 0.3;
  return (curves.heroHp(level) * ENEMY_HIT_SHARE) / (0.7 * curves.refAtk(level));
}
/** Seconds for an empty ATB gauge to fill at battle speed 1. */
export const PARTY_ATB_SECONDS = 4.2;
export const ENEMY_ATB_SECONDS = 5.6;
export const MP_PER_COST = 4;
export const MAX_LEVEL = 100;

/** Weapon stats at a weapon level; EC grows them by m_weapon_level permil up to the growth value at max level. */
function weaponStat(w: WeaponDef | undefined, i: number, level: number) {
  if (!w) return 0;
  const f = Math.min(1, Math.max(0, (level - 1) / 110));
  return Math.round((w.base[i] ?? 0) + (w.growth[i] ?? 0) * f);
}

export function characterStats(c: CharacterDef, level: number, weapon?: WeaponDef): Stats {
  const row = c.levels[Math.min(c.levels.length, Math.max(1, level)) - 1] ?? c.levels[0];
  const [hp, patk, matk, pdef, mdef, heal] = row;
  const s = {
    hp: hp + weaponStat(weapon, 0, level),
    patk: patk + weaponStat(weapon, 1, level),
    matk: matk + weaponStat(weapon, 2, level),
    pdef: pdef + weaponStat(weapon, 3, level),
    mdef: mdef + weaponStat(weapon, 4, level),
    heal: heal + weaponStat(weapon, 5, level),
    mp: 0,
  };
  s.mp = Math.round(40 + level * 4 + s.matk / 3);
  return s;
}

export function enemyStats(e: EnemyDef): Stats {
  let hp = e.hp;
  if (curves) {
    const ref = curves.refHp(e.level);
    const ratio = hp / ref;
    if (ratio > 2) hp = Math.round(ref * 2 * Math.pow(ratio / 2, BOSS_HP_EXPONENT));
  }
  const atk = (v: number) => {
    if (!curves) return v;
    const ref = curves.refAtk(e.level);
    const r = v / ref;
    return r > 1.5 ? Math.round(ref * 1.5 * Math.pow(r / 1.5, BOSS_ATK_EXPONENT)) : v;
  };
  return { hp, mp: 999, patk: atk(e.patk), matk: atk(e.matk), pdef: e.pdef, mdef: e.mdef, heal: e.heal || e.matk };
}

export function mpCost(skill: Skill | undefined) {
  return Math.max(0, Math.round((skill?.cost ?? 0) * MP_PER_COST));
}

/** Element multiplier from an EC resistance permil (-1000 = weak x2, 500 = half, 1000 = immune, more = absorb). */
export function elementFactor(resist: Record<string, number> | undefined, element: number, buffs = 0) {
  const r = (resist?.[String(element)] ?? 0) - buffs * 200;
  return 1 - r / 1000;
}

export interface Hit {
  amount: number;
  crit: boolean;
  miss: boolean;
  heal: boolean;
  /** 'weak' | 'resist' | 'immune' | 'absorb' */
  note?: string;
}

export interface Combatant {
  stats: Stats;
  level: number;
  side: 'party' | 'enemy';
  buffs: Map<string, { level: number; until: number }>;
  statuses: Map<number, number>;
  resist?: Record<string, number>;
  physCut?: number;
  magCut?: number;
  crit?: number;
}

function buffLevel(c: Combatant, name: string) {
  return c.buffs.get(name)?.level ?? 0;
}

function stat(c: Combatant, which: 'patk' | 'matk' | 'pdef' | 'mdef') {
  const up = buffLevel(c, `${which}+`);
  const down = buffLevel(c, `${which}-`);
  return c.stats[which] * Math.max(0.3, 1 + 0.12 * up - 0.12 * down);
}

/** One damage or heal effect, scaled by the share of the hit (`rate`). */
export function resolve(effect: SkillEffect, skill: Skill, user: Combatant, target: Combatant, rate: number, scale = 1): Hit {
  let potency = (effect.potency ?? 1000) / 1000;
  // Enemy specials in EC reach 50x potency (meant for a geared party): keep them big, not absurd.
  if (user.side === 'enemy' && potency > 1.5) potency = 1.5 * Math.sqrt(potency / 1.5);
  const heal = effect.kind === 'heal';
  if (heal) {
    // Cure (150%) restores about 30% of the target's HP, more with a strong healer.
    const healer = curves ? Math.sqrt(user.stats.heal / Math.max(1, curves.heroHeal(user.level))) : 1;
    const amount = Math.max(1, Math.round(potency * 0.2 * target.stats.hp * healer * rate * (0.95 + Math.random() * 0.1)));
    return { amount, crit: false, miss: false, heal: true };
  }
  const attack = effect.attack ?? skill.attack;
  const magic = attack === 2;
  const atk = stat(user, magic ? 'matk' : 'patk');
  const def = stat(target, magic ? 'mdef' : 'pdef');
  const defFactor = Math.min(2.5, Math.max(0.25, 100 / Math.max(1, def)));
  if (!magic && user.statuses.has(4) && Math.random() < 0.5) return { amount: 0, crit: false, miss: true, heal: false };
  const element = effect.element ?? skill.element;
  const elementBuff = target.buffs.get(`${elementName(element)}-`)?.level ?? 0;
  let elem = element > 1 ? elementFactor(target.resist, element, elementBuff) : 1;
  let note: string | undefined;
  if (elem >= 1.4) note = 'weak';
  else if (elem <= 0) note = elem < 0 ? 'absorb' : 'immune';
  else if (elem < 0.9) note = 'resist';
  const cut = magic ? target.magCut : target.physCut;
  if (cut !== undefined) elem *= cut / 1000;
  const critChance = (user.crit ?? 50) / 1000 + (attack === 3 ? 0 : 0.04);
  const crit = !magic && Math.random() < critChance;
  const side = user.side === 'party' ? playerScale(user.level) : enemyScale(user.level) * scale;
  let amount = potency * atk * defFactor * elem * (crit ? 1.5 : 1) * side * rate * (0.94 + Math.random() * 0.12);
  if (note === 'absorb') return { amount: Math.round(-amount), crit, miss: false, heal: true, note };
  amount = Math.round(amount);
  // No single enemy hit takes more than 75% of a character's HP.
  if (user.side === 'enemy') amount = Math.min(amount, Math.round(target.stats.hp * 0.75 * rate));
  if (note === 'immune') amount = 0;
  return { amount: Math.max(note === 'immune' ? 0 : 1, Math.min(9999, amount)), crit, miss: false, heal: false, note };
}

const ELEMENT_KEYS: Record<number, string> = { 2: 'fire', 3: 'ice', 4: 'lightning', 5: 'earth', 6: 'water', 7: 'wind' };
function elementName(e: number) {
  return ELEMENT_KEYS[e] ?? 'none';
}

/** Target type of a skill: its first damage/heal effect decides (EC TargetType 1..5). */
export function targetType(skill: Skill): number {
  const main = skill.effects.find((e) => !e.child && (e.kind === 'damage' || e.kind === 'heal')) ?? skill.effects.find((e) => !e.child) ?? skill.effects[0];
  return main?.target ?? 1;
}

export function targetsAllies(skill: Skill) {
  const t = targetType(skill);
  return t === 3 || t === 4 || t === 5;
}

export function targetsAll(skill: Skill) {
  const t = targetType(skill);
  return t === 2 || t === 4;
}

/** Party level for a battle: about the enemies' level, like the game's recommended level. */
export function fairLevel(enemyLevels: number[], offset: number) {
  const top = enemyLevels.length ? Math.max(...enemyLevels) : 1;
  return Math.min(MAX_LEVEL, Math.max(1, Math.round(top + 1 + offset)));
}

/** Limit gauge gained from damage taken (FF7: proportional to the HP lost). */
export function limitGain(damage: number, maxHp: number) {
  return (damage / Math.max(1, maxHp)) * 160;
}
