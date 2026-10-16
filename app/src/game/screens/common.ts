import type { BattleData, Skill } from '../../battle/data';
import { mpCost } from '../../battle/rules';
import { assetUrl } from '../../platform/source';
import { h } from '../../ui';
import { icon, type IconName, type MateriaColor, type UiAction } from '../../ui/kit';
import type { MateriaDef, MenuCharacter } from '../data';
import type { MenuHost } from '../menu';
import type { MenuStage } from '../menu3d';
import type { GameState, Loadout } from '../state';

/** What every menu screen gets from the menu shell. */
export interface MenuCtx {
  readonly host: MenuHost;
  readonly game: GameState;
  readonly battle: BattleData | null;
  readonly stage: MenuStage;
  /** The character the equipment / battle settings screens show (shared between screens). */
  charId: number;
  /** The fighting party (the story's or the player's). */
  party(): number[];
  /** Everyone: the party first. */
  roster(): number[];
  setHelp(text: string): void;
  /** Re-read the screen's hints() into the footer. */
  updateHints(): void;
  push(s: MenuScreen): void;
  pop(): void;
  close(): void;
}

/** One screen of the main menu (the rail title, the body, its keys and footer hints). */
export interface MenuScreen {
  readonly title: string;
  readonly root: HTMLElement;
  /** A key the shell did not use (lower-case e.key). True when the screen used it. */
  key(k: string, e: KeyboardEvent): boolean;
  /** Back (Esc / Backspace / B / right click): true when the screen handled it itself (left a sub-list). */
  back?(): boolean;
  hints(): [UiAction, string][];
  /** Attached and visible: create the 3D views. */
  shown?(): void;
  /** Leaving (another screen on top, or closed): drop the 3D views. */
  hidden?(): void;
  /** The save game changed under the screen. */
  refresh?(): void;
}

export const STATS: { key: keyof Loadout['stats']; icon: IconName; label: string }[] = [
  { key: 'hp', icon: 'hp', label: 'Max HP' },
  { key: 'mp', icon: 'mp', label: 'Max MP' },
  { key: 'patk', icon: 'attack', label: 'Attack' },
  { key: 'matk', icon: 'magic-attack', label: 'Magic Attack' },
  { key: 'pdef', icon: 'defense', label: 'Defense' },
  { key: 'mdef', icon: 'magic-defense', label: 'Magic Defense' },
  { key: 'heal', icon: 'heal', label: 'Healing' },
];

export const ELEMENT_LABEL: Record<string, string> = { 2: 'Fire', 3: 'Ice', 4: 'Lightning', 5: 'Earth', 6: 'Water', 7: 'Wind', 8: 'Holy', 9: 'Dark' };

/** An EC sprite (item, outfit, materia thumbnail), or a kit icon when there is none. */
export function sprite(src: string | null | undefined, fallback: IconName = 'item', cls = 'gmr-sprite') {
  if (src) return h('img', { class: cls, src: assetUrl(src), alt: '', loading: 'lazy', draggable: 'false' });
  return h('span', { class: `${cls} gmr-sprite--icon` }, icon(fallback));
}

/** The kit's weapon icon for a character (by who they are). */
export function weaponIcon(c: MenuCharacter | undefined): IconName {
  const n = (c?.name ?? '').toLowerCase();
  if (/tifa/.test(n)) return 'gloves';
  if (/barret/.test(n)) return 'gun-arm';
  if (/aerith/.test(n)) return 'staff';
  if (/red/.test(n)) return 'headdress';
  if (/yuffie/.test(n)) return 'shuriken';
  if (/cait/.test(n)) return 'megaphone';
  if (/vincent|lucia/.test(n)) return 'handgun';
  if (/matt/.test(n)) return 'rifle';
  if (/cid/.test(n)) return 'spear';
  if (/sephiroth/.test(n)) return 'katana';
  return 'sword';
}

/** Remake colours: green magic, yellow command, purple independent (stat) materia; summons are red. */
export function materiaColor(m: MateriaDef | undefined): MateriaColor {
  if (!m) return 'green';
  if (m.spells.length) return 'green';
  if (/blow|strike|slash|thrust/i.test(m.name)) return 'yellow';
  return 'purple';
}

/** First / last name for the vertical name plates. */
export function splitName(c: MenuCharacter | undefined) {
  const full = c?.fullName ?? c?.name ?? '';
  const first = c?.name ?? full;
  const last = full.startsWith(first) ? full.slice(first.length).trim() : '';
  return { first, last };
}

/** "Physical damage · one enemy · Fire · 12 MP" from EC's skill data. */
export function describeSkill(s: Skill | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  const main = s.effects.find((e) => !e.child && (e.kind === 'damage' || e.kind === 'heal')) ?? s.effects.find((e) => !e.child);
  if (main) {
    const who = { 1: 'one enemy', 2: 'all enemies', 3: 'one ally', 4: 'all allies', 5: 'self' }[main.target] ?? '';
    if (main.kind === 'damage') parts.push(`${main.attack === 2 ? 'Magic' : 'Physical'} damage to ${who}`);
    else if (main.kind === 'heal') parts.push(`Restores HP of ${who}`);
    else if (main.kind === 'buff') parts.push(`Raises a stat of ${who}`);
    else if (main.kind === 'status') parts.push(`Inflicts a status on ${who}`);
    else if (main.kind === 'cleanse') parts.push(`Cures ailments of ${who}`);
    if (main.potency && (main.kind === 'damage' || main.kind === 'heal')) parts.push(`potency ${Math.round(main.potency / 10)}%`);
  }
  const el = ELEMENT_LABEL[String(s.element)];
  if (el) parts.push(el);
  const mp = mpCost(s);
  if (mp) parts.push(`${mp} MP`);
  return parts.join(' · ');
}

/** "Hi-Potion ×3"-style count text, ∞ in the sandbox. */
export function countText(game: GameState, n: number) {
  return game.d.sandbox ? '∞' : String(n);
}
