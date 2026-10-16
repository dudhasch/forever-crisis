/**
 * Which button glyph to show for a UI action on the current device (pure logic, no DOM; kit.ts renders it).
 *
 * Pad buttons are named by position on the standard mapping (south = A / ✕, east = B / ○, west = X / □,
 * north = Y / △) and follow src/game/gamepad.ts: the field and menu layout, plus the battle layout for the battle
 * actions. Keyboard labels for actions the player can rebind come from the caller (Settings → Controls).
 */
import type { GlyphName } from './atlas';

export type Device = 'ps' | 'xbox' | 'kb';
export type PadFamily = 'ps' | 'xbox';
export type PadButton =
  | 'south'
  | 'east'
  | 'west'
  | 'north'
  | 'l1'
  | 'r1'
  | 'l2'
  | 'r2'
  | 'l3'
  | 'r3'
  | 'start'
  | 'select'
  | 'ls'
  | 'rs'
  | 'dpad'
  | 'dpad-ud'
  | 'dpad-lr'
  | 'dpad-up'
  | 'dpad-down'
  | 'dpad-left'
  | 'dpad-right';

export type UiAction =
  // menus
  | 'confirm'
  | 'back'
  | 'menu'
  | 'pause'
  | 'tabPrev'
  | 'tabNext'
  | 'pagePrev'
  | 'pageNext'
  | 'alt'
  | 'save'
  | 'sort'
  | 'cursor'
  | 'cursorUD'
  | 'cursorLR'
  | 'decrease'
  | 'increase'
  // field
  | 'move'
  | 'look'
  | 'interact'
  | 'run'
  | 'camera'
  | 'rotate'
  // battle (as in src/battle/input.ts)
  | 'attack'
  | 'commands'
  | 'guard'
  | 'shortcuts'
  | 'next'
  | 'target'
  | 'escape'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  /** a skill list's "put on a shortcut" chord: 1-4 / L1 + a face button */
  | 'assign';

/** One piece of a glyph: an atlas image (pad button, mouse) or a keyboard key with its label. */
export type GlyphPart = { atlas: GlyphName } | { key: string };

const PAD: Record<UiAction, PadButton[]> = {
  confirm: ['south'],
  back: ['east'],
  menu: ['north'],
  pause: ['start'],
  tabPrev: ['l1'],
  tabNext: ['r1'],
  pagePrev: ['l2'],
  pageNext: ['r2'],
  alt: ['west'],
  save: ['north'],
  sort: ['r3'],
  cursor: ['dpad'],
  cursorUD: ['dpad-ud'],
  cursorLR: ['dpad-lr'],
  decrease: ['dpad-left'],
  increase: ['dpad-right'],
  move: ['ls'],
  look: ['rs'],
  interact: ['south'],
  run: ['r2'],
  camera: ['r3'],
  rotate: ['l1', 'l2'],
  attack: ['west'],
  commands: ['south'],
  guard: ['r1'],
  shortcuts: ['l1'],
  next: ['north'],
  target: ['rs'],
  escape: ['l2', 'r2'],
  slot1: ['north'],
  slot2: ['east'],
  slot3: ['south'],
  slot4: ['west'],
  assign: ['l1', 'north', 'east', 'south', 'west'],
};

/** Keyboard labels; 'mouse-*' entries are mouse glyphs. Rebindable field actions are looked up via `keyFor`. */
const KB: Record<UiAction, string[]> = {
  confirm: ['Enter'],
  back: ['Esc'],
  menu: ['Tab'],
  pause: ['Esc'],
  tabPrev: ['Q'],
  tabNext: ['E'],
  pagePrev: ['PgUp'],
  pageNext: ['PgDn'],
  alt: ['R'],
  save: ['F5'],
  sort: ['T'],
  cursor: ['↑', '↓'],
  cursorUD: ['↑', '↓'],
  cursorLR: ['←', '→'],
  decrease: ['←'],
  increase: ['→'],
  move: ['W', 'A', 'S', 'D'],
  look: ['mouse-move'],
  interact: ['E'],
  run: ['Shift'],
  camera: ['C'],
  rotate: ['Z', 'X'],
  attack: ['F'],
  commands: ['Space'],
  guard: ['G'],
  shortcuts: ['Shift'],
  next: ['Tab'],
  target: ['←', '→'],
  escape: ['Q', 'R'],
  slot1: ['1'],
  slot2: ['2'],
  slot3: ['3'],
  slot4: ['4'],
  assign: ['1–4'],
};

const FACE: Record<PadFamily, Record<'south' | 'east' | 'west' | 'north', GlyphName>> = {
  ps: { south: 'ps-cross', east: 'ps-circle', west: 'ps-square', north: 'ps-triangle' },
  xbox: { south: 'xb-a', east: 'xb-b', west: 'xb-x', north: 'xb-y' },
};

export function padGlyph(b: PadButton, f: PadFamily): GlyphName {
  if (b === 'south' || b === 'east' || b === 'west' || b === 'north') return FACE[f][b];
  if (b.startsWith('dpad')) return b as GlyphName;
  if (b === 'ls') return 'stick-l';
  if (b === 'rs') return 'stick-r';
  const ps: Record<string, GlyphName> = { l1: 'ps-l1', r1: 'ps-r1', l2: 'ps-l2', r2: 'ps-r2', l3: 'ps-l3', r3: 'ps-r3', start: 'ps-options', select: 'ps-touchpad' };
  const xb: Record<string, GlyphName> = { l1: 'xb-lb', r1: 'xb-rb', l2: 'xb-lt', r2: 'xb-rt', l3: 'xb-ls', r3: 'xb-rs', start: 'xb-menu', select: 'xb-view' };
  return (f === 'ps' ? ps : xb)[b];
}

/** Sony pads (DualShock / DualSense, vendor 054c) get PlayStation glyphs; every other pad gets Xbox-style ones. */
export function padFamily(id: string): PadFamily {
  return /054c|playstation|dualshock|dualsense|wireless controller|ps[345]\b/i.test(id) ? 'ps' : 'xbox';
}

/** The glyph set to draw: the player's choice, or (Auto) the last device used and the pad's make. */
export function pickDevice(pref: 'auto' | Device, last: 'kb' | 'pad', padId: string | null): Device {
  if (pref !== 'auto') return pref;
  return last === 'pad' ? padFamily(padId ?? '') : 'kb';
}

/** Standard-mapping button index -> button, for rebound pad actions. */
export const PAD_INDEX: PadButton[] = ['south', 'east', 'west', 'north', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right'];

export function resolveGlyph(a: UiAction, d: Device, keyFor?: (a: UiAction) => string[] | null, padFor?: (a: UiAction) => PadButton[] | null): GlyphPart[] {
  if (d !== 'kb') return (padFor?.(a) ?? PAD[a]).map((b) => ({ atlas: padGlyph(b, d) }));
  const keys = keyFor?.(a) ?? KB[a];
  return keys.map((k) => (k.startsWith('mouse') ? { atlas: k as GlyphName } : { key: k }));
}
