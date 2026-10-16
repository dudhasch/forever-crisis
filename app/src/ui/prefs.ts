/**
 * UI-kit preferences: button glyph style and reduced motion. Kept in their own key (ff7ec.ui) so the kit does not
 * depend on the Settings window's store; the Options screen reads and writes them through `uiPrefs`.
 */

export type GlyphPref = 'auto' | 'ps' | 'xbox' | 'kb';
/** auto = follow the OS "reduce motion" setting. */
export type MotionPref = 'auto' | 'reduced' | 'full';

export interface UiPrefs {
  glyphs: GlyphPref;
  motion: MotionPref;
  /** Menu cursor / confirm / cancel sounds (their level is Settings → Audio → Sound effects). */
  sounds: boolean;
  /** Main menu: reopen on the last command (memory) or always on the first (forget). */
  cursor: 'memory' | 'forget';
  /** Title screen when the game is not full screen: offer it (ask), switch on the first key press (always), or not. */
  fullscreen: 'ask' | 'always' | 'never';
}

export const DEFAULT_UI_PREFS: UiPrefs = { glyphs: 'auto', motion: 'auto', sounds: true, cursor: 'memory', fullscreen: 'ask' };

const KEY = 'ff7ec.ui';

function load(): UiPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) return { ...DEFAULT_UI_PREFS, ...(JSON.parse(raw) as Partial<UiPrefs>) };
  } catch {
    /* private mode / corrupt: defaults */
  }
  return { ...DEFAULT_UI_PREFS };
}

type Listener = (p: UiPrefs) => void;

class UiPrefsStore {
  readonly p = load();
  private listeners = new Set<Listener>();

  onChange(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  set<K extends keyof UiPrefs>(k: K, v: UiPrefs[K]) {
    this.p[k] = v;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(this.p));
    } catch {
      /* private mode */
    }
    for (const fn of this.listeners) fn(this.p);
  }
}

export const uiPrefs = new UiPrefsStore();
