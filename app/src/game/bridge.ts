import type { Battle, BattleGame, BattleLoadout, Fighter, ItemDef } from '../battle/battle';
import type { CharacterDef } from '../battle/data';
import { gainScale, loadSettings } from '../battle/rules';
import type { InstantItem } from './data';
import { PHOENIX_DOWN, type GameState } from './state';

/**
 * EC's consumables (m_instant_item_dungeon_effect) in FF7 terms, and the save game's side of a battle.
 *
 * EffectType: 1 / 5 HP (% of current / max: both heal that share of max HP here), 2 ATB +N (EC's skill
 * gauge: MP +N0% here), 3 Limit gauge %, 4 Summon gauge % (MP here, half of it), 6-9 PATK / PDEF / MATK / MDEF up
 * "for the next battle", 10-15 Fire / Ice / Lightning / Earth / Water / Wind potency up "for the next battle"
 * (FF7-style elemental grenades on all enemies here), 18 key, 19 Provoke, 22 cleanse.
 */

const BUFF_OF: Record<number, string> = { 6: 'patk+', 7: 'pdef+', 8: 'matk+', 9: 'mdef+' };
const ELEMENT_OF: Record<number, number> = { 10: 2, 11: 3, 12: 4, 13: 5, 14: 6, 15: 7 };

export const PHOENIX: InstantItem = {
  id: PHOENIX_DOWN,
  name: 'Phoenix Down',
  help: 'Revives a fallen ally with 30% of max HP. (Not in Ever Crisis: kept from FF7.)',
  rarity: 2,
  order: 150,
  icon: null,
  target: 1,
  effects: [],
};

export interface ItemUse {
  hp: number;
  mp: number;
  limit: number;
  revive: boolean;
  cleanse: boolean;
  buff: string | null;
  buffLevel: number;
  element: number;
  potency: number;
  all: boolean;
  usable: { field: boolean; battle: boolean };
}

/** What an item does, in shares of max HP/MP. */
export function itemUse(it: InstantItem): ItemUse {
  const u: ItemUse = {
    hp: 0,
    mp: 0,
    limit: 0,
    revive: it.id === PHOENIX_DOWN,
    cleanse: false,
    buff: null,
    buffLevel: 0,
    element: 0,
    potency: 0,
    all: it.target === 2,
    usable: { field: false, battle: false },
  };
  const has5 = it.effects.some((e) => e[0] === 5);
  for (const [type, , value] of it.effects) {
    if (type === 5 || (type === 1 && !has5)) u.hp = Math.max(u.hp, value / 100);
    else if (type === 2) u.mp = Math.max(u.mp, Math.min(1, value / 10));
    else if (type === 4) u.mp = Math.max(u.mp, value / 200);
    else if (type === 3) u.limit = value / 100;
    else if (type === 22) u.cleanse = true;
    else if (BUFF_OF[type]) {
      u.buff = BUFF_OF[type];
      u.buffLevel = Math.min(4, Math.max(1, Math.round(value / 120)));
    } else if (ELEMENT_OF[type]) {
      u.element = ELEMENT_OF[type];
      u.potency = 1000 + value * 1.6;
    }
  }
  u.usable.battle = !!(u.hp || u.mp || u.limit || u.revive || u.cleanse || u.buff || u.element);
  u.usable.field = !!(u.hp || u.mp || u.revive || u.buff);
  return u;
}

export function allItems(game: GameState): InstantItem[] {
  const list = [...(game.menu?.items ?? []).filter((i) => i.target !== 3), PHOENIX];
  return list.sort((a, b) => a.order - b.order);
}

function battleItem(it: InstantItem): ItemDef {
  const u = itemUse(it);
  const target: ItemDef['target'] = u.element ? 'enemies' : u.revive ? 'dead' : u.all ? 'allies' : 'ally';
  return {
    id: String(it.id),
    name: it.name,
    help: it.help.replace(/\s+/g, ' ') + (u.buff ? ' (In battle: at once.)' : ''),
    target,
    disabled: !u.usable.battle,
    use: (b: Battle, user: Fighter, targets: Fighter[]) => {
      if (u.element) return b.itemDamage(user, targets, u.element, u.potency);
      for (const f of targets) {
        if (u.revive) b.revive(f, 0.3);
        if (u.hp || u.mp) b.restore(f, f.stats.hp * u.hp, f.stats.mp * u.mp);
        if (u.limit) b.addLimit(f, u.limit);
        if (u.cleanse) b.cleanse(f);
        if (u.buff) b.buff(f, u.buff, u.buffLevel);
      }
    },
  };
}

/** Enemy drops: FF7-style common items, better ones from stronger enemies. */
const DROPS: [number, number, number][] = [
  // [item id, min enemy level, weight]
  [101, 0, 10],
  [103, 0, 4],
  [201, 0, 4],
  [PHOENIX_DOWN, 0, 3],
  [102, 12, 5],
  [104, 18, 3],
  [202, 25, 2],
  [301, 10, 2],
  [501, 15, 1],
  [503, 15, 1],
  [601, 8, 1],
  [602, 8, 1],
  [603, 8, 1],
  [105, 20, 1],
  [107, 35, 1],
];
const DROP_CHANCE = 0.22;

export function battleGame(game: GameState): BattleGame {
  return {
    loadout(c: CharacterDef, level: number): BattleLoadout | null {
      const lo = game.loadout(c.id, level);
      if (!lo) return null;
      const [hp, mp] = game.vitals(c.id);
      return {
        stats: lo.stats,
        weaponId: lo.weapon?.id,
        model: lo.model,
        spells: lo.spells,
        summons: lo.summons,
        abilities: lo.abilities,
        elements: lo.elements,
        buffs: game.takeBuffs(c.id),
        hp,
        mp,
      };
    },
    items: () => allItems(game).map(battleItem),
    itemCount: (id) => game.itemCount(Number(id)),
    consumeItem: (id) => void game.consumeItem(Number(id)),
    drop(level) {
      if (Math.random() > DROP_CHANCE) return null;
      const pool = DROPS.filter((d) => d[1] <= level);
      let r = Math.random() * pool.reduce((s, d) => s + d[2], 0);
      return String((pool.find((d) => (r -= d[2]) <= 0) ?? pool[0])[0]);
    },
    won(battleId, enemyLevels, partyLevel, loot) {
      // Streamlined Progression (Options → Game) doubles both
      const k = gainScale(loadSettings());
      const gil = k * enemyLevels.reduce((s, l) => s + 7 * l + 5, 0);
      const exp = k * (game.menu?.battles[String(battleId)]?.exp || enemyLevels.reduce((s, l) => s + 12 * l + 8, 0));
      const items: string[] = [];
      const before = game.d.level;
      const names = new Map(allItems(game).map((i) => [String(i.id), i.name]));
      for (const l of loot) {
        game.addItem(Number(l));
        items.push(names.get(l) ?? l);
      }
      items.push(...game.winBattle(battleId, gil));
      items.push(...game.setLevel(partyLevel));
      game.d.exp += exp;
      game.changed();
      return { gil, exp, items, level: game.d.level > before ? game.d.level : undefined };
    },
    shortcuts: (id) => game.shortcuts(id),
    setShortcuts: (id, keys) => game.setShortcuts(id, keys),
    ended(party, outcome) {
      if (outcome === 'retry') return;
      const recover = loadSettings().easyRecovery;
      for (const p of party) {
        if (!p.id) continue;
        if (outcome === 'skipped' || recover) game.setVitals(p.id, 1, 1);
        else game.setVitals(p.id, p.alive ? p.hp : 0, p.mp);
      }
    },
  };
}
