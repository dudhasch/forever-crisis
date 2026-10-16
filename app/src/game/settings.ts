import type { CameraMode } from '../camera/rig';

/**
 * Player settings outside battle (battle settings stay in ff7ec.battleSettings, see battle/rules.ts, because save
 * slots carry them). Stored as one JSON object in ff7ec.settings; older separate keys are migrated on first load.
 */

/** Field actions the player can rebind. Arrow keys and Enter always work as well (see FIXED_KEYS). */
export const ACTIONS = [
  { id: 'up', label: 'Move forward', keys: ['w'] },
  { id: 'down', label: 'Move back', keys: ['s'] },
  { id: 'left', label: 'Move left', keys: ['a'] },
  { id: 'right', label: 'Move right', keys: ['d'] },
  { id: 'run', label: 'Run (hold)', keys: ['shift'] },
  { id: 'interact', label: 'Talk / interact', keys: ['e'] },
  { id: 'menu', label: 'Menu', keys: ['tab'] },
  { id: 'camera', label: 'Change camera', keys: ['c'] },
  { id: 'rotL', label: 'Rotate view left', keys: ['z'] },
  { id: 'rotR', label: 'Rotate view right', keys: ['x'] },
  { id: 'reset', label: 'Back to start point', keys: ['r'] },
  { id: 'noclip', label: 'No-clip fly', keys: ['n'] },
  { id: 'maps', label: 'Extras: Maps', keys: ['m'] },
  { id: 'chars', label: 'Extras: Characters', keys: ['p'] },
  { id: 'weapons', label: 'Extras: Weapons', keys: ['o'] },
  { id: 'story', label: 'Extras: Story', keys: ['l'] },
  { id: 'battles', label: 'Extras: Battles', keys: ['b'] },
  { id: 'music', label: 'Extras: Music', keys: ['j'] },
  { id: 'info', label: 'Extras: Info', keys: ['i'] },
  { id: 'help', label: 'Extras: Controls help', keys: ['h'] },
  { id: 'settings', label: 'Settings', keys: ['k'] },
  { id: 'debug', label: 'Show collision', keys: ['v'] },
] as const;

export type Action = (typeof ACTIONS)[number]['id'];

/** Keys that always do their thing, whatever the bindings say. */
export const FIXED_KEYS: Partial<Record<Action, string[]>> = {
  up: ['arrowup'],
  down: ['arrowdown'],
  left: ['arrowleft'],
  right: ['arrowright'],
  interact: ['enter'],
};

/**
 * Field / menu actions a gamepad button can be rebound to (standard mapping indices, see src/game/gamepad.ts). The
 * button sends the action's key; battles keep their own layout.
 */
export const PAD_ACTIONS = [
  { id: 'interact', label: 'Confirm / interact', key: 'Enter', buttons: [0] },
  { id: 'back', label: 'Back', key: 'Backspace', buttons: [1] },
  { id: 'menu', label: 'Menu', key: 'Tab', buttons: [3] },
  { id: 'pause', label: 'Pause', key: 'Escape', buttons: [9] },
  { id: 'run', label: 'Run (hold)', key: 'Shift', buttons: [5, 7] },
  { id: 'rotL', label: 'Rotate view left', key: 'z', buttons: [4] },
  { id: 'rotR', label: 'Rotate view right', key: 'x', buttons: [6] },
  { id: 'camera', label: 'Change camera', key: 'c', buttons: [11] },
] as const;

export type PadAction = (typeof PAD_ACTIONS)[number]['id'];

/** Standard-mapping button names, for labels. */
export const PAD_BUTTON_NAMES = ['A / ✕', 'B / ○', 'X / □', 'Y / △', 'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'View / Share', 'Menu / Options', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →'];

export type Quality = 'low' | 'medium' | 'high';
export type ShadowQuality = 'off' | 'low' | 'high';

export interface GameSettings {
  v: 1;
  audio: { music: number; sfx: number; voice: number };
  graphics: {
    /** Multiplies the device pixel ratio (after the quality cap). */
    resolution: number;
    quality: Quality;
    /** 0 = flat lighting, 1 = EC's toon ramp. */
    toon: number;
    outlines: boolean;
    /** 0 = uncapped (display refresh rate). */
    fpsCap: number;
    /** The stage sun's shadow map: off, 2048 px over ~28 m, or 4096 px over ~45 m. */
    shadows: ShadowQuality;
    /** The scene's post-processing bloom (lamps, emissive props). */
    bloom: boolean;
  };
  controls: {
    bindings: Partial<Record<Action, string>>;
    /** Gamepad buttons per action (-1 = unbound); missing = the default buttons. */
    pad: Partial<Record<PadAction, number>>;
    mouse: number;
    invertY: boolean;
    camera: CameraMode;
    hints: boolean;
  };
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  v: 1,
  audio: { music: 0.5, sfx: 0.8, voice: 0.9 },
  graphics: { resolution: 1, quality: 'high', toon: 1, outlines: true, fpsCap: 0, shadows: 'high', bloom: true },
  controls: { bindings: {}, pad: {}, mouse: 1, invertY: false, camera: 'ec', hints: true },
};

export const QUALITY_PIXEL_CAP: Record<Quality, number> = { low: 1, medium: 1.5, high: 2 };

const KEY = 'ff7ec.settings';

function read(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function load(): GameSettings {
  const d = structuredClone(DEFAULT_GAME_SETTINGS);
  const raw = read(KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as Partial<GameSettings>;
      return {
        v: 1,
        audio: { ...d.audio, ...s.audio },
        graphics: { ...d.graphics, ...s.graphics },
        controls: { ...d.controls, ...s.controls, bindings: { ...s.controls?.bindings }, pad: { ...s.controls?.pad } },
      };
    } catch {
      /* corrupt: defaults */
    }
  }
  // migrate the jukebox volume (ff7ec.volume) from before there was a settings screen
  const vol = Number(read('ff7ec.volume'));
  if (read('ff7ec.volume') !== null && Number.isFinite(vol)) d.audio.music = vol;
  return d;
}

type Listener = (s: GameSettings) => void;

class SettingsStore {
  readonly s = load();
  private listeners = new Set<Listener>();

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Persist and tell everyone (call after changing `s`). */
  changed() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.s));
    } catch {
      /* private mode */
    }
    for (const fn of this.listeners) fn(this.s);
  }

  /** The keys bound to an action: the player's binding (or the default) plus the fixed ones. */
  keys(a: Action): string[] {
    const def = ACTIONS.find((x) => x.id === a)!;
    const bound = this.s.controls.bindings[a];
    // '' = unbound (its key went to another action)
    const own: readonly string[] = bound === undefined ? def.keys : bound ? [bound] : [];
    return [...own, ...(FIXED_KEYS[a] ?? [])];
  }

  /** The action a key press triggers in the field, if any. */
  action(key: string): Action | null {
    for (const a of ACTIONS) if (this.keys(a.id).includes(key)) return a.id;
    return null;
  }

  bind(a: Action, key: string) {
    const b = this.s.controls.bindings;
    // a key does one thing: whoever had it gets their default back (or nothing if that is the key)
    for (const x of ACTIONS) {
      if (x.id === a || !this.keys(x.id).includes(key) || FIXED_KEYS[x.id]?.includes(key)) continue;
      const def = x.keys[0] as string;
      if (def !== key && !Object.values(b).includes(def)) delete b[x.id];
      else b[x.id] = '';
    }
    const def = ACTIONS.find((x) => x.id === a)!;
    if (def.keys[0] === key) delete b[a];
    else b[a] = key;
    this.changed();
  }

  resetBindings() {
    this.s.controls.bindings = {};
    this.changed();
  }

  /** The gamepad buttons bound to an action (standard mapping indices). */
  padButtons(a: PadAction): number[] {
    const b = this.s.controls.pad[a];
    if (b === undefined) return [...PAD_ACTIONS.find((x) => x.id === a)!.buttons];
    return b >= 0 ? [b] : [];
  }

  bindPad(a: PadAction, button: number) {
    const p = this.s.controls.pad;
    // a button does one thing: whoever had it gets their default back (or nothing if that is the button)
    for (const x of PAD_ACTIONS) {
      if (x.id === a || !this.padButtons(x.id).includes(button)) continue;
      const def = x.buttons as readonly number[];
      const taken = def.includes(button) || def.some((d) => PAD_ACTIONS.some((y) => y.id !== x.id && p[y.id] === d));
      if (taken) p[x.id] = -1;
      else delete p[x.id];
    }
    const def = PAD_ACTIONS.find((x) => x.id === a)!.buttons as readonly number[];
    if (def.length === 1 && def[0] === button) delete p[a];
    else p[a] = button;
    this.changed();
  }

  resetPad() {
    this.s.controls.pad = {};
    this.changed();
  }
}

export const settings = new SettingsStore();

/** How a key looks on a keycap. */
export function keyLabel(k: string): string {
  if (!k) return '—';
  const names: Record<string, string> = {
    ' ': 'Space',
    arrowup: '↑',
    arrowdown: '↓',
    arrowleft: '←',
    arrowright: '→',
    escape: 'Esc',
    enter: 'Enter',
    tab: 'Tab',
    shift: 'Shift',
    control: 'Ctrl',
    alt: 'Alt',
    backspace: 'Bksp',
  };
  return names[k] ?? (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1));
}
