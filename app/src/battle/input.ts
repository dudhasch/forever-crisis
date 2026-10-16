/**
 * Battle controls: which device the player used last (keyboard + mouse or gamepad) and which UI-kit glyph each
 * battle action shows. The gamepad itself arrives as emulated keys (src/game/gamepad.ts, battle profile).
 */
import type { UiAction } from '../ui/glyphs';

export type InputMode = 'kb' | 'pad';

export type BattleAction =
  | 'attack'
  | 'commands'
  | 'confirm'
  | 'back'
  | 'guard'
  | 'shortcuts'
  | 'next'
  | 'target'
  | 'cursor'
  | 'assign'
  | 'move'
  | 'escape'
  | 'pause'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4';

/**
 * The UI kit's glyph action for each battle action (src/ui/glyphs.ts draws it for the current device and the
 * Glyphs option). Keyboard keys match the battle's own handling in battle.ts.
 */
const KIT: Record<BattleAction, UiAction> = {
  attack: 'attack',
  commands: 'commands',
  confirm: 'confirm',
  back: 'back',
  guard: 'guard',
  shortcuts: 'shortcuts',
  next: 'next',
  target: 'target',
  cursor: 'cursorLR',
  assign: 'assign',
  move: 'cursorUD',
  escape: 'escape',
  pause: 'pause',
  slot1: 'slot1',
  slot2: 'slot2',
  slot3: 'slot3',
  slot4: 'slot4',
};

export function kitAction(a: BattleAction): UiAction {
  return KIT[a];
}

let mode: InputMode = 'kb';
const listeners = new Set<(m: InputMode) => void>();
let started = false;

function set(m: InputMode) {
  if (m === mode) return;
  mode = m;
  for (const fn of listeners) fn(m);
}

/** Start tracking (idempotent). Real key presses and the mouse mean keyboard; the gamepad module's event means pad. */
export function trackInputMode() {
  if (started) return;
  started = true;
  window.addEventListener('keydown', (e) => e.isTrusted && set('kb'), true);
  window.addEventListener('mousedown', () => set('kb'), true);
  window.addEventListener('ff7ec:gamepad', () => set('pad'));
}

export function inputMode() {
  return mode;
}

export function onInputMode(fn: (m: InputMode) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Shortcut slot (0..3) of a key press: number keys 1–4 (top row or numpad, Shift or not), gamepad L1 + face. */
export function slotOf(key: string, code = ''): number | null {
  const m = /^(?:Digit|Numpad)([1-4])$/.exec(code) ?? /^([1-4])$/.exec(key);
  return m ? Number(m[1]) - 1 : null;
}
