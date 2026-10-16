import { fetchJSON } from '../assets';

/** generated/battle/*.json (tools/build_battles.py). */

export interface ClipRef {
  name: string;
  /** /gen/anims/ relative file; missing when the clip was not converted. */
  file?: string;
}

export interface SkillAction {
  clips: { in?: ClipRef; loop?: ClipRef; out?: ClipRef };
  class: string;
  /** [seconds into the out clip, share of the damage] */
  hits?: [number, number][];
  inHits?: [number, number][];
  /** [seconds, sound url] */
  se?: [number, string][];
  inSe?: [number, string][];
  /** EC particle effects started during the out (fx) and in (inFx) clips. */
  fx?: EffectEvent[];
  inFx?: EffectEvent[];
  /** Summons: the movie the game plays before the events (/arc/06-Video-Extracted/...). */
  movie?: string;
  startDiff?: number;
  /** SkillRangeType: 1/2 = runs up to the target, 0/3 = acts from where it stands. */
  range: number;
  rangeMin?: number;
  rangeMax?: number;
  loopTime?: number;
  outDuration?: number;
}

/**
 * A Play*EffectEvent of the skill's action (tools/build_battles.py): prefab `fx` (a generated/effects key) started
 * `t` seconds into its clip. `at` / `rotAt` are EC TransformTypes (1 Root, 2 RightHand, 3 RightWeapon, 5 LeftHand,
 * 6 LeftWeapon, 9 Head, 10 Hip, 11 Chest, 15 MainWeaponRoot, 16 MainWeaponPoint, 19 SystemEffectTarget ...);
 * off / ang / scale are Unity-space offsets in that frame.
 */
export interface EffectEvent {
  t: number;
  /** self = on the actor, target = on each target, area = a side's area centre, long = projectile to each target */
  kind: 'self' | 'target' | 'area' | 'long';
  fx: string | null;
  at?: number;
  rotAt?: number;
  bone?: string;
  off: number[];
  ang?: number[];
  scale?: number[];
  follow?: number;
  /** loop events: seconds until the emission stops; long: flight time */
  dur?: number;
  scaleCurve?: number[];
  scaleDur?: number;
  /** area: 0 own side, 1 opponents */
  area?: number;
  between?: number[];
  facing?: number;
  jitter?: number;
  sizes?: Record<string, string>;
  outFx?: string;
  outScale?: number[];
  hitOff?: number[];
  hitHeight?: number;
  worldAxis?: number;
  homing?: { xBias: number; yBias: number; progress: number[] | null; x: number[] | null; y: number[] | null };
}

export type EffectKind ='damage' | 'heal' | 'buff' | 'status' | 'cleanse' | 'other';

export interface SkillEffect {
  /** m_skill_effect.TargetType: 1 one enemy, 2 all enemies, 3 one ally, 4 all allies, 5 self. */
  target: number;
  type: number;
  kind: EffectKind;
  /** BaseAttackType: 1 physical, 2 magic, 3 limit (physical). */
  attack?: number;
  element?: number;
  /** permil of the attack stat (1000 = 100%). */
  potency?: number;
  buff?: number;
  level?: number;
  status?: number;
  /** seconds */
  duration?: number;
  /** permil */
  chance?: number;
  child?: boolean;
}

export interface Skill {
  name: string;
  attack: number;
  element: number;
  effects: SkillEffect[];
  /** EC ATB cost (MP is derived from it). */
  cost?: number;
  action?: SkillAction;
}

export interface WeaponDef {
  id: number;
  name: string;
  type: number;
  /** generated/weapons.json entry id ("001_001"). */
  glb: string | null;
  base: number[];
  growth: number[];
  ability: string | null;
}

export interface CharacterDef {
  id: number;
  key: string;
  name: string;
  fullName: string | null;
  model: string | null;
  family: string;
  defaultWeapon: number;
  defaultCostume: number;
  /** [hp, patk, matk, pdef, mdef, heal] per level, index 0 = Lv 1. */
  levels: number[][];
  attack?: string;
  weapons: WeaponDef[];
  limits: string[];
  /** spell id -> this character's skill key (own cast animation). */
  spells: Record<string, string>;
}

export interface SpellDef {
  id: string;
  level: number;
  skill: string;
  name: string;
}

export interface SummonDef {
  id: number;
  name: string;
  skill: string;
  level: number;
  gauge: number;
}

export interface PartyDef {
  members: { character: number; fixed: boolean; slot: number; weapon?: number; costume?: number }[];
  count: number;
  power: number;
}

export interface BattleIndex {
  elements: Record<string, string>;
  /** EC's reference enemy (level parameter group 1) per level. */
  enemyReference: { levels: number[]; hp: number[]; patk: number[]; pdef: number[] };
  buffTypes: Record<string, string>;
  characters: Record<string, CharacterDef>;
  spells: SpellDef[];
  summons: SummonDef[];
  parties: Record<string, PartyDef>;
  partyOfStoryBattle: Record<string, string>;
}

export interface EnemyDef {
  id: number;
  name: string;
  level: number;
  model: string | null;
  family: string | null;
  hp: number;
  patk: number;
  matk: number;
  pdef: number;
  mdef: number;
  heal: number;
  crit: number;
  /** element -> permil: negative = weakness (-1000 = double), 1000 = immune, more = absorbs. */
  elements: Record<string, number>;
  /** status -> trigger permil (0 = immune). */
  status: Record<string, number>;
  skills: string[];
  aiSkills?: string[];
  physCut?: number;
  magCut?: number;
  weapon?: string;
  bgm?: string;
  brain?: string;
  caution?: string;
}

export interface WaveDef {
  enemies: { enemy: string; target?: boolean; display?: number }[];
  bgm?: string;
  enter?: string;
}

export interface BattleDefinition {
  id: number;
  source: 'script' | 'encounter';
  waves: WaveDef[];
  environment: number | null;
  area: number;
  bgm: string | null;
  timeLimit: number | null;
  storyBattle?: number;
}

export interface Zone {
  p: number[];
  yaw: number;
  sizeType?: number;
  radius?: number;
}

export interface StageDef {
  defaultArea: number;
  areas: { own: Record<string, Zone[]>; opponents: Record<string, Zone[]>; root?: Zone }[];
}

export interface Condition {
  c: string;
  calcOperator?: number;
  constValue?: number;
  useConst?: number;
  target?: number;
  property?: number;
}

export interface BrainNode {
  t: string;
  p?: { c: Condition[]; n: number | null }[];
  skill?: number;
  max?: number;
  time?: number;
  turn?: number;
  result?: number;
}

export interface BrainDef {
  root: number;
  nodes: BrainNode[];
}

export interface BattleData {
  index: BattleIndex;
  battles: Record<string, BattleDefinition>;
  enemies: Record<string, EnemyDef>;
  skills: Record<string, Skill>;
  stages: Record<string, StageDef>;
  brains: Record<string, BrainDef>;
  /** dungeon map key -> default battle environment id */
  maps: Record<string, number>;
}

let data: Promise<BattleData> | null = null;

export function battleData(): Promise<BattleData> {
  data ??= (async () => {
    const [index, battles, enemies, skills, stages, brains, maps] = await Promise.all([
      fetchJSON<BattleIndex>('/gen/battle/index.json'),
      fetchJSON<Record<string, BattleDefinition>>('/gen/battle/battles.json'),
      fetchJSON<Record<string, EnemyDef>>('/gen/battle/enemies.json'),
      fetchJSON<Record<string, Skill>>('/gen/battle/skills.json'),
      fetchJSON<Record<string, StageDef>>('/gen/battle/stages.json'),
      fetchJSON<Record<string, BrainDef>>('/gen/battle/brains.json'),
      fetchJSON<Record<string, number>>('/gen/battle/maps.json'),
    ]);
    return { index, battles, enemies, skills, stages, brains, maps };
  })();
  data.catch(() => (data = null));
  return data;
}

export const ELEMENT_COLORS: Record<number, number> = {
  1: 0xffffff,
  2: 0xff7a2a,
  3: 0x8fe6ff,
  4: 0xfff15a,
  5: 0xc89a5a,
  6: 0x4aa8ff,
  7: 0x8dff9a,
  8: 0xfff6c8,
  9: 0xb070ff,
};

/** EC status conditions the runtime understands (StatusConditionType). */
export const STATUS_NAMES: Record<number, string> = {
  1: 'Poison',
  2: 'Sedate',
  3: 'Silence',
  4: 'Darkness',
  5: 'Stun',
  6: 'Fatigue',
  7: 'Fog',
};
