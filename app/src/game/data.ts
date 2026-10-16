import { fetchJSON } from '../assets';

/** generated/menu/menu.json (tools/build_menu.py). */

export type RewardKind = 'gil' | 'crystal' | 'item' | 'material' | 'materia' | 'weapon' | 'costume' | 'memoria' | 'keyitem' | 'dungeonkey';

export interface Reward {
  kind: RewardKind;
  id: number;
  count: number;
  name: string | null;
  icon?: string | null;
}

/** [EffectType, GrantValueType, EffectValue, TriggerType] from m_instant_item_dungeon_effect. */
export type ItemEffect = [number, number, number, number];

export interface InstantItem {
  id: number;
  name: string;
  help: string;
  rarity: number;
  order: number;
  icon: string | null;
  /** m_instant_item_dungeon.TargetType: 1 one ally, 2 all allies, 3 none (keys). */
  target: number;
  effects: ItemEffect[];
}

export interface Passive {
  id: number;
  name: string;
  level: number;
  desc: string;
  /** stat -> [flat, percent] */
  stats: Record<string, [number, number]>;
  /** element -> ability damage percent */
  elements: Record<string, number>;
}

export interface Outfit {
  id: number;
  name: string;
  rarity: number;
  glb: string | null;
  weapon: number;
  icon: string | null;
  bust: string | null;
  button: string | null;
  passives: Passive[];
}

export interface MenuCharacter {
  id: number;
  key: string;
  name: string;
  fullName: string | null;
  bust: string | null;
  button: string | null;
  defaultWeapon: number;
  defaultCostume: number;
  outfits: Outfit[];
  weapons: Record<string, { icon: string | null; rarity: number }>;
}

export interface MateriaDef {
  id: number;
  name: string;
  /** Battle spell ids it casts (the first at once, the others once the party is strong enough). */
  spells: string[];
  icon: string | null;
  stats: Record<string, number>;
}

export interface SummonDef {
  id: number;
  name: string;
  item: number;
  icon: string | null;
}

export interface MemoriaDef {
  id: number;
  name: string;
  help: string;
  series: string;
  /** [hp, patk, matk, pdef, mdef, heal] at max level */
  stats: number[];
  maxLevel: number;
  icon: string | null;
}

export interface KeyItemDef {
  id: number;
  name: string;
  help: string;
  icon: string | null;
}

export interface StoryLine {
  id: number;
  family: string;
  name: string | null;
  series: string | null;
  logo: string | null;
  chapters: { id: number; name: string | null; order: number }[];
}

/** One Shop offer (tools/build_menu.py `shop`): bought with Gil once the party reaches `level`. */
export interface ShopOffer {
  kind: 'item' | 'weapon' | 'costume' | 'memoria' | 'materia';
  id: number;
  /** weapons and outfits: whose */
  char?: number;
  price: number;
  level: number;
}

export interface ShopData {
  stock: ShopOffer[];
  sell: {
    /** Gil per Blue Crystal */
    crystal: number;
    /** material id -> Gil */
    material: Record<string, number>;
    /** share of an item's price paid for it */
    itemShare: number;
  };
}

export interface MenuData {
  items: InstantItem[];
  alias: Record<string, number>;
  characters: Record<string, MenuCharacter>;
  materia: MateriaDef[];
  materiaAlias: Record<string, number>;
  summons: SummonDef[];
  memoria: MemoriaDef[];
  keyItems: KeyItemDef[];
  dungeonKey: KeyItemDef;
  icons: { gil: string | null; crystal: string | null };
  treasures: Record<string, Reward[]>;
  battles: Record<string, { exp: number; rewards: Reward[] }>;
  episodes: Record<string, Reward[]>;
  shop: ShopData;
  /** Blue Crystals to raise a materia from level n to n+1, at index n-1 (tools/build_menu.py). */
  materiaLevels: number[];
  story: StoryLine[];
  backgrounds: string[];
}

let data: Promise<MenuData> | null = null;

export function menuData(): Promise<MenuData> {
  data ??= fetchJSON<MenuData>('/gen/menu/menu.json');
  data.catch(() => (data = null));
  return data;
}

export const SE = {
  decide: '/arc/08-Audio-Extracted/se_ui_common/0061_se_ui_common_decide_01.flac',
  cancel: '/arc/08-Audio-Extracted/se_ui_common/0056_se_ui_common_cancel_01.flac',
  select: '/arc/08-Audio-Extracted/se_ui_common/0106_se_ui_common_select_01.flac',
  menu: '/arc/08-Audio-Extracted/se_ui_common/0074_se_ui_common_globalmenu_01.flac',
  equip: '/arc/08-Audio-Extracted/se_ui_common/0071_se_ui_common_equipmentset_01.flac',
  item: '/arc/08-Audio-Extracted/se_ui_common/0124_se_ui_result_itemget_01.flac',
  titleStart: '/arc/08-Audio-Extracted/se_ui_title/0016_se_ui_title_start_01.flac',
  titleLogo: '/arc/08-Audio-Extracted/se_ui_title/0017_se_ui_title_logo_02.flac',
  ng: '/arc/08-Audio-Extracted/se_ui_title/0005_se_ui_common_ng_01.flac',
};
