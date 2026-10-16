import { PAD_ACTIONS, settings, type Action } from './settings';

/**
 * Gamepad support by key emulation: buttons and the left stick become the keys the menus and the field already
 * understand (standard mapping). Field defaults (Options → Controls rebinds them): D-pad / stick = arrows,
 * A = Enter, B = Backspace (back), Y = Tab (menu), Start = Esc (menu / pause), RT or RB = Shift (run),
 * LB / LT = Z / X (rotate view), R3 = C (camera).
 */
const FIXED: Record<number, string> = {
  12: 'ArrowUp',
  13: 'ArrowDown',
  14: 'ArrowLeft',
  15: 'ArrowRight',
};

/** The field layout from the player's pad bindings; each button sends its action's (rebindable) key. */
function fieldButtons(): Record<number, string> {
  const out: Record<number, string> = { ...FIXED };
  for (const a of PAD_ACTIONS) {
    // keyboard-rebindable actions send whatever key the player gave them, so the field reacts the same way
    const kb = a.id === 'interact' || a.id === 'back' || a.id === 'pause' ? null : settings.keys(a.id as Action).find((k) => !k.startsWith('arrow'));
    for (const b of settings.padButtons(a.id)) out[b] = kb ?? a.key;
  }
  return out;
}

/**
 * Menus (main menu, options, title, pauses): fixed like the Remake's. A = Enter, B = Backspace, X = R (alt),
 * Y = Tab, LB / RB = Q / E (previous / next tab), LT / RT = PageUp / PageDown, R3 = T (sort), Start = Esc.
 */
const MENU: Record<number, string> = {
  0: 'Enter',
  1: 'Backspace',
  2: 'r',
  3: 'Tab',
  4: 'q',
  5: 'e',
  6: 'PageUp',
  7: 'PageDown',
  9: 'Escape',
  11: 't',
  ...FIXED,
};
/**
 * Battles (src/battle): X/□ = F (attack), RB = G (guard), LB = Shift (shortcut palette) and LB + a face button =
 * 1–4 (fire or assign a shortcut: △ 1, ○ 2, ✕ 3, □ 4), LT + RT = Q + R (hold to escape), right stick = [ / ]
 * (switch target). A, B, Y, Start and the D-pad stay as in the field.
 */
const BATTLE: Record<number, string> = {
  0: 'Enter',
  1: 'Backspace',
  2: 'f',
  3: 'Tab',
  4: 'Shift',
  5: 'g',
  6: 'q',
  7: 'r',
  9: 'Escape',
  12: 'ArrowUp',
  13: 'ArrowDown',
  14: 'ArrowLeft',
  15: 'ArrowRight',
};
const BATTLE_CHORD: Record<number, string> = { 3: '1', 1: '2', 0: '3', 2: '4' };
/** Menu keys repeat while held, like a keyboard. */
const REPEAT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '[', ']', 'q', 'e', 'PageUp', 'PageDown']);

export type GamepadProfile = 'field' | 'battle' | 'menu';
let profile: GamepadProfile = 'field';

/** The battle switches the buttons to its own layout while it runs; menus to theirs while they are open. */
export function setGamepadProfile(p: GamepadProfile) {
  profile = p;
}

export function gamepadProfile() {
  return profile;
}

/** Menus: switch to the menu layout and get a function that restores the one before. */
export function menuGamepad(): () => void {
  const prev = profile;
  profile = 'menu';
  return () => {
    if (profile === 'menu') profile = prev;
  };
}

let capture: ((button: number) => void) | null = null;
/** Options → Controls: the next button pressed goes to `fn` instead of sending a key. */
export function captureButton(fn: ((button: number) => void) | null) {
  capture = fn;
  if (fn) for (const p of navigator.getGamepads?.() ?? []) p?.buttons.forEach((b, i) => b.pressed && wasDown.add(i));
}
const wasDown = new Set<number>();

const held = new Map<string, number>();
const heldButtons = new Set<number>();

function send(type: 'keydown' | 'keyup', key: string, repeat = false) {
  window.dispatchEvent(new KeyboardEvent(type, { key, repeat, bubbles: true }));
  if (type === 'keydown') window.dispatchEvent(new Event('ff7ec:gamepad'));
}

function poll(now: number) {
  const pads = navigator.getGamepads?.() ?? [];
  const want = new Set<string>();
  const field = profile === 'field' ? fieldButtons() : null;
  for (const p of pads) {
    if (!p || p.mapping !== 'standard') continue;
    if (capture) {
      // wait for a fresh press (buttons held when the capture started must be let go first)
      const down = p.buttons.findIndex((b, i) => b.pressed && !wasDown.has(i));
      p.buttons.forEach((b, i) => !b.pressed && wasDown.delete(i));
      if (down >= 0) {
        const fn = capture;
        capture = null;
        wasDown.clear();
        for (const [i, b] of p.buttons.entries()) if (b.pressed) heldButtons.add(i);
        window.dispatchEvent(new Event('ff7ec:gamepad'));
        fn(down);
      }
      continue;
    }
    const battle = profile === 'battle';
    const chord = battle && !!p.buttons[4]?.pressed;
    for (const [i, key] of Object.entries(battle ? BATTLE : (field ?? MENU))) {
      if (heldButtons.has(Number(i))) {
        // the button that was just captured sends nothing until it is let go
        if (!p.buttons[Number(i)]?.pressed) heldButtons.delete(Number(i));
        continue;
      }
      if (!p.buttons[Number(i)]?.pressed) continue;
      want.add(chord && BATTLE_CHORD[Number(i)] ? BATTLE_CHORD[Number(i)] : key);
    }
    const [x, y, rx] = p.axes;
    if (battle && rx < -0.5) want.add('[');
    if (battle && rx > 0.5) want.add(']');
    if (y < -0.5) want.add('ArrowUp');
    if (y > 0.5) want.add('ArrowDown');
    if (x < -0.5) want.add('ArrowLeft');
    if (x > 0.5) want.add('ArrowRight');
  }
  for (const key of want) {
    const since = held.get(key);
    if (since === undefined) {
      held.set(key, now);
      send('keydown', key);
    } else if (REPEAT.has(key) && now - since > 420) {
      held.set(key, now - 420 + 110);
      send('keydown', key, true);
    }
  }
  for (const key of [...held.keys()]) {
    if (want.has(key)) continue;
    held.delete(key);
    send('keyup', key);
  }
  requestAnimationFrame(poll);
}

let started = false;

export function startGamepad() {
  if (started || !('getGamepads' in navigator)) return;
  started = true;
  requestAnimationFrame(poll);
}
