import './screens.css';
import { CAMERA_LABEL, CAMERA_MODES } from '../camera/rig';
import type { BattleSettings } from '../battle/rules';
import type { SoundEffects } from '../story/overlay';
import { h } from '../ui';
import {
  backdrop,
  dropdown,
  enter,
  exit,
  footer,
  frame,
  glyphDevice,
  glyphImg,
  heading,
  keyCap,
  optionRow,
  RowList,
  slider,
  uiPrefs,
  uiSound,
  type UiAction,
} from '../ui/kit';
import { padGlyph, PAD_INDEX } from '../ui/glyphs';
import { captureButton, menuGamepad } from './gamepad';
import { popModal, pushModal } from './modal';
import { ACTIONS, keyLabel, PAD_ACTIONS, PAD_BUTTON_NAMES, settings, type Action, type PadAction, type Quality, type ShadowQuality } from './settings';

export interface SettingsHost {
  sfx: SoundEffects;
  /** The live battle settings object (battles read it every frame). */
  battle: BattleSettings;
  saveBattle(): void;
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'slider'; label: string; help: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void; fmt: (v: number) => string }
  | { kind: 'toggle'; label: string; help: string; get: () => boolean; set: (v: boolean) => void; on?: string; off?: string }
  | { kind: 'choice'; label: string; help: string; options: { v: string; label: string }[]; get: () => string; set: (v: string) => void }
  | { kind: 'key'; label: string; help: string; action: Action }
  | { kind: 'pad'; label: string; help: string; action: PadAction }
  | { kind: 'button'; label: string; help: string; value: string; run: () => void };

const CATS = [
  { id: 'game', label: 'Game', help: 'Streamlined Progression, the ATB and battle options, menus.' },
  { id: 'controls', label: 'Controls', help: 'Button glyphs, camera, and the keyboard and gamepad buttons.' },
  { id: 'graphics', label: 'Display & Graphics', help: 'Resolution, quality, shading, shadows and bloom.' },
  { id: 'audio', label: 'Audio', help: 'Music, sound effects, voices and menu sounds.' },
  { id: 'access', label: 'Accessibility', help: 'Reduced motion.' },
] as const;
type Cat = (typeof CATS)[number]['id'];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ARROWS = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'enter'];

/**
 * Options, laid out like FF7 Remake's: the categories down the left, label ◇ value rows on the right, a dropdown
 * for choices, over the blurred live scene. Opened from the title screen, the main menu (System) and pauses.
 * ↑↓ choose · ←→ change · Enter dropdown / rebind · Q / E (L1 / R1) category · Esc back.
 */
export class SettingsScreen {
  readonly root = h('div', { class: 'opt rm', hidden: true });
  private bd: ReturnType<typeof backdrop> | null = null;
  private fr = frame('Options');
  private ft = footer();
  private cats = new RowList(CATS.map((c) => ({ label: c.label })));
  private rowsEl = h('div', { class: 'rm-list opt-rows rm-scroll' });
  private ddHost = h('div', { class: 'opt-dd' });
  private cat: Cat = 'game';
  private focus: 'cats' | 'rows' = 'cats';
  private cursor = 0;
  private rows: Row[] = [];
  private rowEls: HTMLElement[] = [];
  private dd: { list: RowList; row: Row & { kind: 'choice' | 'toggle' } } | null = null;
  private listening: { kind: 'key'; action: Action } | { kind: 'pad'; action: PadAction } | null = null;
  private done: (() => void) | null = null;
  private restorePad: (() => void) | null = null;
  private key = (k: string, e: KeyboardEvent) => this.onKey(k, e);

  constructor(private readonly host: SettingsHost) {
    this.fr.body.append(h('div', { class: 'opt-body' }, h('div', { class: 'opt-cats' }, this.cats.root), h('div', { class: 'opt-main' }, this.rowsEl, this.ddHost)));
    this.fr.root.append(this.ft.root);
    this.root.append(this.fr.root);
    this.cats.onSelect = (i) => {
      if (CATS[i].id === this.cat) return;
      this.cat = CATS[i].id;
      this.cursor = 0;
      this.render();
    };
    this.cats.onPick = () => this.focusRows();
    this.cats.root.addEventListener('mouseenter', () => this.setFocus('cats'));
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.onKey('escape', e as unknown as KeyboardEvent);
    });
    document.body.append(this.root);
    settings.onChange(() => this.open && !this.listening && this.paint());
  }

  get open() {
    return !this.root.hidden;
  }

  /** Resolves when the player closes the window. `cat`: a category to open on. */
  show(cat?: string): Promise<void> {
    const c = CATS.find((x) => x.id === cat?.toLowerCase() || x.label.toLowerCase() === cat?.toLowerCase());
    if (c) this.cat = c.id;
    if (!this.open) {
      this.root.hidden = false;
      pushModal(this.key);
      this.restorePad = menuGamepad();
      this.bd = backdrop({ scene: true, grid: false });
      this.root.prepend(this.bd.root);
      uiSound('open');
      void enter(this.root, 'fade');
      void enter(this.fr.body, 'right');
    }
    this.cats.select(CATS.findIndex((x) => x.id === this.cat), false);
    this.focus = 'cats';
    this.cursor = 0;
    this.render();
    return new Promise((r) => (this.done = r));
  }

  hide() {
    if (!this.open) return;
    this.closeDropdown();
    this.stopListening();
    popModal(this.key);
    this.restorePad?.();
    this.restorePad = null;
    void exit(this.root, 'fade').then(() => {
      this.root.hidden = true;
      this.bd?.dispose();
      this.bd?.root.remove();
      this.bd = null;
    });
    const d = this.done;
    this.done = null;
    d?.();
  }

  // ------------------------------------------------------------------ rows per category
  private gameRows(): Row[] {
    const b = this.host.battle;
    const set = <K extends keyof BattleSettings>(k: K) => (v: BattleSettings[K]) => {
      b[k] = v;
      this.host.saveBattle();
    };
    const toggle = (label: string, help: string, k: 'easyGains' | 'easyFights' | 'easyRecovery' | 'encounters', on = 'Enabled', off = 'Disabled'): Row => ({ kind: 'toggle', label, help, get: () => b[k], set: set(k), on, off });
    return [
      { kind: 'header', label: 'Streamlined Progression' },
      toggle('2x EXP & Gil Gain', 'Battles give twice the EXP and Gil.', 'easyGains'),
      toggle('Gentler Enemies', 'Enemies hit half as hard and the party fights five levels above the fair level.', 'easyFights'),
      toggle('Full Recovery After Battle', 'HP and MP are full again after every battle.', 'easyRecovery'),
      { kind: 'header', label: 'Battle' },
      {
        kind: 'choice',
        label: 'ATB Mode',
        help: 'What the ATB gauges do while a command menu is open. Active: time never stops. Slow: gauges crawl. Wait: time stops in sub-menus and targeting.',
        options: [
          { v: 'active', label: 'Active' },
          { v: 'slow', label: 'Slow' },
          { v: 'wait', label: 'Wait' },
        ],
        get: () => b.mode,
        set: (v) => set('mode')(v as BattleSettings['mode']),
      },
      {
        kind: 'slider',
        label: 'Menu Slowdown',
        help: 'How much the gauges slow down in Slow mode (and in Wait mode on the command menu).',
        min: 0.05,
        max: 0.9,
        step: 0.05,
        get: () => b.slowFactor,
        set: set('slowFactor'),
        fmt: (v) => `${Math.round((1 - v) * 100)}% slower`,
      },
      { kind: 'slider', label: 'Battle Speed', help: 'Like FF7’s Battle Speed: how fast every gauge fills.', min: 0.5, max: 2, step: 0.1, get: () => b.speed, set: set('speed'), fmt: (v) => `${v.toFixed(1)}×` },
      toggle('Random Encounters', 'Fights while walking in the game’s encounter areas.', 'encounters', 'On', 'Off'),
      {
        kind: 'slider',
        label: 'Party Level',
        help: 'Added to the party’s fair level (about the enemies’ level). Negative makes battles harder.',
        min: -10,
        max: 30,
        step: 1,
        get: () => b.levelOffset,
        set: set('levelOffset'),
        fmt: (v) => (v >= 0 ? `fair +${v}` : `fair ${v}`),
      },
      { kind: 'slider', label: 'Enemy Damage', help: 'How hard enemies hit.', min: 0.25, max: 2, step: 0.05, get: () => b.enemyDamage, set: set('enemyDamage'), fmt: pct },
      { kind: 'header', label: 'Menus' },
      {
        kind: 'choice',
        label: 'Cursor Position',
        help: 'Memory: the main menu opens on the command you used last. Forget: always on the first.',
        options: [
          { v: 'memory', label: 'Memory' },
          { v: 'forget', label: 'Forget' },
        ],
        get: () => uiPrefs.p.cursor,
        set: (v) => uiPrefs.set('cursor', v as 'memory' | 'forget'),
      },
    ];
  }

  private controlRows(): Row[] {
    const c = settings.s.controls;
    const ch = () => settings.changed();
    return [
      {
        kind: 'choice',
        label: 'Button Glyphs',
        help: 'The button pictures in hints and menus. Auto follows the last device you used (and the pad’s make).',
        options: [
          { v: 'auto', label: 'Auto' },
          { v: 'ps', label: 'PlayStation' },
          { v: 'xbox', label: 'Xbox' },
          { v: 'kb', label: 'Keyboard' },
        ],
        get: () => uiPrefs.p.glyphs,
        set: (v) => uiPrefs.set('glyphs', v as typeof uiPrefs.p.glyphs),
      },
      {
        kind: 'choice',
        label: 'Default Camera',
        help: 'The camera a new session starts with (Change camera switches it in the field).',
        options: CAMERA_MODES.map((m) => ({ v: m, label: CAMERA_LABEL[m] })),
        get: () => c.camera,
        set: (v) => ((c.camera = v as typeof c.camera), ch()),
      },
      { kind: 'slider', label: 'Camera Sensitivity', help: 'Orbit and first-person camera speed with the mouse.', min: 0.2, max: 3, step: 0.1, get: () => c.mouse, set: (v) => ((c.mouse = v), ch()), fmt: (v) => `${v.toFixed(1)}×` },
      { kind: 'toggle', label: 'Invert Vertical', help: 'Mouse up looks down.', get: () => c.invertY, set: (v) => ((c.invertY = v), ch()), on: 'On', off: 'Off' },
      { kind: 'toggle', label: 'Field Key Hints', help: 'The small list of keys in the field. It fades out while you play and comes back on input.', get: () => c.hints, set: (v) => ((c.hints = v), ch()), on: 'Show', off: 'Hide' },
      { kind: 'header', label: 'Keyboard' },
      ...ACTIONS.map((a): Row => ({ kind: 'key', label: a.label, help: 'Enter or click, then press the new key (Esc cancels). The arrow keys and Enter always work as well.', action: a.id })),
      {
        kind: 'button',
        label: 'Reset Keyboard',
        value: 'Default keys',
        help: 'Back to W A S D, Shift, E, Tab and the letter hotkeys.',
        run: () => {
          settings.resetBindings();
          uiSound('confirm');
        },
      },
      { kind: 'header', label: 'Gamepad' },
      ...PAD_ACTIONS.map((a): Row => ({ kind: 'pad', label: a.label, help: 'Enter or click, then press the new button on the gamepad (Esc cancels). Menus and battles keep their own layout.', action: a.id })),
      {
        kind: 'button',
        label: 'Reset Gamepad',
        value: 'Default buttons',
        help: 'Back to A / ✕ confirm, Y / △ menu, Start pause, RB / RT run, LB / LT rotate, R3 camera.',
        run: () => {
          settings.resetPad();
          uiSound('confirm');
        },
      },
    ];
  }

  private graphicsRows(): Row[] {
    const g = settings.s.graphics;
    const ch = () => settings.changed();
    const lowHigh = [
      { v: 'off', label: 'Off' },
      { v: 'low', label: 'Low' },
      { v: 'high', label: 'High' },
    ];
    return [
      {
        kind: 'choice',
        label: 'Full Screen at Start',
        help: 'When the game is not full screen at the title: Ask offers it, Always switches on the first key press or click, Never leaves the window as it is.',
        options: [
          { v: 'ask', label: 'Ask' },
          { v: 'always', label: 'Always' },
          { v: 'never', label: 'Never' },
        ],
        get: () => uiPrefs.p.fullscreen,
        set: (v) => uiPrefs.set('fullscreen', v as typeof uiPrefs.p.fullscreen),
      },
      { kind: 'slider', label: 'Resolution', help: 'Render resolution relative to the screen. Lower is faster; above 100% sharpens edges on strong GPUs.', min: 0.5, max: 1.5, step: 0.05, get: () => g.resolution, set: (v) => ((g.resolution = v), ch()), fmt: pct },
      {
        kind: 'choice',
        label: 'Quality',
        help: 'Low renders at most one pixel per screen pixel, Medium 1.5, High up to 2 on high-DPI displays.',
        options: [
          { v: 'low', label: 'Low' },
          { v: 'medium', label: 'Medium' },
          { v: 'high', label: 'High' },
        ],
        get: () => g.quality,
        set: (v) => ((g.quality = v as Quality), ch()),
      },
      { kind: 'slider', label: 'Toon Shading', help: 'Strength of EC’s toon lighting on characters and enemies (their ramp and rim). 0% is plain lighting.', min: 0, max: 1, step: 0.05, get: () => g.toon, set: (v) => ((g.toon = v), ch()), fmt: pct },
      { kind: 'toggle', label: 'Outlines', help: 'The dark outline around characters.', get: () => g.outlines, set: (v) => ((g.outlines = v), ch()), on: 'On', off: 'Off' },
      {
        kind: 'choice',
        label: 'Shadows',
        help: 'Shadows from the stage’s sun on 3D maps and battle stages (the rest of EC’s lighting is baked into lightmaps). Low uses a smaller shadow map over a shorter distance.',
        options: lowHigh,
        get: () => g.shadows,
        set: (v) => ((g.shadows = v as ShadowQuality), ch()),
      },
      { kind: 'toggle', label: 'Bloom', help: 'The glow around lamps and bright light, from each scene’s post-processing profile.', get: () => g.bloom, set: (v) => ((g.bloom = v), ch()), on: 'On', off: 'Off' },
      {
        kind: 'choice',
        label: 'Frame Rate Limit',
        help: 'Cap the frame rate to save power. Off follows the display.',
        options: [
          { v: '0', label: 'Off' },
          { v: '30', label: '30' },
          { v: '60', label: '60' },
          { v: '120', label: '120' },
        ],
        get: () => String(g.fpsCap),
        set: (v) => ((g.fpsCap = Number(v)), ch()),
      },
    ];
  }

  private audioRows(): Row[] {
    const a = settings.s.audio;
    const vol = (label: string, help: string, k: keyof typeof a): Row => ({
      kind: 'slider',
      label,
      help,
      min: 0,
      max: 1,
      step: 0.05,
      get: () => a[k],
      set: (v) => {
        a[k] = v;
        settings.changed();
        if (k === 'sfx') uiSound('cursor');
      },
      fmt: (v) => String(Math.round(v * 10)),
    });
    return [
      vol('Music Volume', 'Background music, the jukebox and movies.', 'music'),
      vol('Sound Effects Volume', 'Menus, battles, footsteps and the field scripts’ sounds.', 'sfx'),
      vol('Voice Volume', 'Battle voices of the party and enemies.', 'voice'),
      { kind: 'toggle', label: 'Menu Sounds', help: 'Cursor, confirm and cancel sounds in the menus.', get: () => uiPrefs.p.sounds, set: (v) => uiPrefs.set('sounds', v), on: 'On', off: 'Off' },
    ];
  }

  private accessRows(): Row[] {
    return [
      {
        kind: 'choice',
        label: 'Reduced Motion',
        help: 'Cuts menu slides, drifting specks and turning models down to plain fades. Auto follows the system setting.',
        options: [
          { v: 'auto', label: 'Auto' },
          { v: 'reduced', label: 'On' },
          { v: 'full', label: 'Off' },
        ],
        get: () => uiPrefs.p.motion,
        set: (v) => uiPrefs.set('motion', v as typeof uiPrefs.p.motion),
      },
    ];
  }

  // ------------------------------------------------------------------ render
  private render() {
    this.rows = { game: () => this.gameRows(), controls: () => this.controlRows(), graphics: () => this.graphicsRows(), audio: () => this.audioRows(), access: () => this.accessRows() }[this.cat]();
    this.rowEls = this.rows.map((r, i) => this.rowEl(r, i));
    this.rowsEl.replaceChildren(...this.rowEls);
    this.cursor = this.selectable(Math.min(this.cursor, this.rows.length - 1), 1);
    this.paint();
    void enter(this.rowsEl, 'fade');
  }

  /** The nearest selectable row from i in direction d (headers are skipped). */
  private selectable(i: number, d: number) {
    const n = this.rows.length;
    for (let k = 0; k < n; k++) {
      const j = (((i + d * k) % n) + n) % n;
      if (this.rows[j].kind !== 'header') return j;
    }
    return 0;
  }

  private value(r: Row): Node | string {
    switch (r.kind) {
      case 'slider': {
        const v = r.get();
        return slider((v - r.min) / (r.max - r.min), r.fmt(v), (x) => {
          r.set(Number((Math.round((r.min + x * (r.max - r.min)) / r.step) * r.step).toFixed(4)));
          uiSound('cursor');
          this.paint();
        }).root;
      }
      case 'toggle':
        return r.get() ? (r.on ?? 'Enabled') : (r.off ?? 'Disabled');
      case 'choice':
        return r.options.find((o) => o.v === r.get())?.label ?? r.get();
      case 'key': {
        if (this.listening?.kind === 'key' && this.listening.action === r.action) return h('span', { class: 'opt-listen' }, 'Press a key…');
        const own = settings.keys(r.action).filter((k) => !ARROWS.includes(k));
        return own.length ? keyCap(keyLabel(own[0])) : h('span', { class: 'rm-dim' }, 'Not set');
      }
      case 'pad': {
        if (this.listening?.kind === 'pad' && this.listening.action === r.action) return h('span', { class: 'opt-listen' }, 'Press a button…');
        const bs = settings.padButtons(r.action);
        const fam = glyphDevice() === 'ps' ? 'ps' : 'xbox';
        return bs.length ? h('span', { class: 'opt-pad' }, ...bs.map((b) => glyphImg(padGlyph(PAD_INDEX[b], fam))), h('span', { class: 'rm-dim' }, bs.map((b) => PAD_BUTTON_NAMES[b]).join(', '))) : h('span', { class: 'rm-dim' }, 'Not set');
      }
      case 'button':
        return h('span', { class: 'rm-dim' }, r.value);
      case 'header':
        return '';
    }
  }

  private rowEl(r: Row, i: number): HTMLElement {
    if (r.kind === 'header') return h('div', { class: 'opt-header' }, heading(r.label));
    const el = optionRow(r.label, this.value(r));
    el.addEventListener('mouseenter', () => {
      if (this.dd || this.listening) return;
      this.setFocus('rows');
      if (this.cursor !== i) {
        this.cursor = i;
        this.paint(false);
      }
    });
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.rm-slider__track')) return;
      this.cursor = i;
      this.setFocus('rows');
      this.activate();
    });
    return el;
  }

  /** Redraw values and the highlight (cheap: no rebuild of the rows). */
  private paint(sound = false) {
    this.rows.forEach((r, i) => {
      const el = this.rowEls[i];
      if (!el || r.kind === 'header') return;
      el.classList.toggle('is-selected', this.focus === 'rows' && i === this.cursor);
      el.querySelector('.rm-option__value')?.replaceChildren(this.value(r));
    });
    this.cats.root.classList.toggle('opt-dim', this.focus === 'rows');
    const r = this.rows[this.cursor];
    this.ft.setHelp(this.focus === 'cats' ? CATS.find((c) => c.id === this.cat)!.help : r && r.kind !== 'header' ? r.help : '');
    this.ft.setHints(this.hints());
    if (this.focus === 'rows') this.rowEls[this.cursor]?.scrollIntoView({ block: 'nearest' });
    if (sound) uiSound('cursor');
  }

  private hints(): [UiAction, string][] {
    if (this.listening) return [['back', 'Cancel']];
    if (this.dd)
      return [
        ['cursorUD', 'Choose'],
        ['confirm', 'Set'],
        ['back', 'Back'],
      ];
    const r = this.rows[this.cursor];
    return this.focus === 'cats'
      ? [
          ['tabPrev', ''],
          ['tabNext', 'Category'],
          ['confirm', 'Select'],
          ['back', 'Close'],
        ]
      : [
          ['tabPrev', ''],
          ['tabNext', 'Category'],
          ...(r && (r.kind === 'slider' || r.kind === 'toggle' || r.kind === 'choice') ? ([['cursorLR', 'Change']] as [UiAction, string][]) : []),
          ['confirm', r?.kind === 'key' || r?.kind === 'pad' ? 'Rebind' : 'Select'],
          ['back', 'Back'],
        ];
  }

  private setFocus(f: 'cats' | 'rows') {
    if (this.focus === f) return;
    this.focus = f;
    this.paint();
  }

  private focusRows() {
    this.focus = 'rows';
    this.cursor = this.selectable(this.cursor, 1);
    this.paint();
  }

  // ------------------------------------------------------------------ editing
  private adjust(d: number) {
    const r = this.rows[this.cursor];
    if (!r) return;
    if (r.kind === 'slider') {
      const v = Math.min(r.max, Math.max(r.min, Math.round((r.get() + d * r.step) / r.step) * r.step));
      if (v === r.get()) return;
      r.set(Number(v.toFixed(4)));
    } else if (r.kind === 'toggle') r.set(!r.get());
    else if (r.kind === 'choice') {
      const i = r.options.findIndex((o) => o.v === r.get());
      r.set(r.options[(i + d + r.options.length) % r.options.length].v);
    } else return;
    uiSound(r.kind === 'slider' ? 'cursor' : 'toggle');
    this.paint();
  }

  /** Enter / click on a row: a dropdown for choices, listen for keys / buttons, run buttons. */
  private activate() {
    const r = this.rows[this.cursor];
    if (!r) return;
    if (r.kind === 'choice' || r.kind === 'toggle') return this.openDropdown(r);
    if (r.kind === 'slider') return this.adjust(1);
    if (r.kind === 'button') return r.run();
    if (r.kind === 'key') {
      this.listening = { kind: 'key', action: r.action };
      uiSound('confirm');
      return this.paint();
    }
    if (r.kind === 'pad') {
      const action = r.action;
      this.listening = { kind: 'pad', action };
      uiSound('confirm');
      captureButton((b) => {
        this.listening = null;
        settings.bindPad(action, b);
        uiSound('equip');
        this.paint();
      });
      this.paint();
    }
  }

  private openDropdown(r: Row & { kind: 'choice' | 'toggle' }) {
    const opts = r.kind === 'choice' ? r.options : [
      { v: 'on', label: r.on ?? 'Enabled' },
      { v: 'off', label: r.off ?? 'Disabled' },
    ];
    const cur = r.kind === 'choice' ? opts.findIndex((o) => o.v === r.get()) : r.get() ? 0 : 1;
    const dd = dropdown(
      opts.map((o) => o.label),
      Math.max(0, cur),
    );
    dd.list.onPick = (i) => {
      if (r.kind === 'choice') r.set(opts[i].v);
      else r.set(i === 0);
      this.closeDropdown();
      this.paint();
    };
    // next to the row's value, like the Remake's
    const row = this.rowEls[this.cursor];
    const host = this.ddHost.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    dd.root.style.top = `${box.bottom - host.top}px`;
    this.ddHost.replaceChildren(dd.root);
    this.dd = { list: dd.list, row: r };
    uiSound('dropdown');
    void enter(dd.root, 'up');
    this.paint();
  }

  private closeDropdown() {
    this.dd = null;
    this.ddHost.replaceChildren();
  }

  private stopListening() {
    if (this.listening?.kind === 'pad') captureButton(null);
    this.listening = null;
  }

  private close() {
    uiSound('close');
    this.hide();
  }

  private onKey(k: string, e: KeyboardEvent) {
    if (this.listening) {
      const l = this.listening;
      if (k === 'escape' || k === 'backspace') {
        // the pad's B / ○ sends Backspace: only cancel a pad capture from the keyboard's Esc
        if (l.kind === 'pad' && k === 'backspace') return;
        this.stopListening();
        uiSound('cancel');
      } else if (l.kind === 'key') {
        this.listening = null;
        if (ARROWS.includes(k)) uiSound('error');
        else {
          settings.bind(l.action, k);
          uiSound('equip');
        }
      } else return; // waiting for a pad button
      return this.paint();
    }
    if (this.dd) {
      const list = this.dd.list;
      if (k === 'arrowup' || k === 'w') list.move(-1);
      else if (k === 'arrowdown' || k === 's') list.move(1);
      else if (k === 'enter' || k === ' ') list.pick();
      else if (k === 'escape' || k === 'backspace') {
        uiSound('cancel');
        this.closeDropdown();
        this.paint();
      }
      return;
    }
    if (k === 'q' || k === 'e' || k === 'pageup' || k === 'pagedown' || (k === 'tab' && this.focus === 'rows')) {
      const d = k === 'q' || k === 'pageup' || (k === 'tab' && e.shiftKey) ? -1 : 1;
      const i = CATS.findIndex((c) => c.id === this.cat);
      uiSound('tab');
      this.cats.select((i + d + CATS.length) % CATS.length, false);
      return;
    }
    if (this.focus === 'cats') {
      if (k === 'arrowup' || k === 'w') this.cats.move(-1);
      else if (k === 'arrowdown' || k === 's') this.cats.move(1);
      else if (k === 'enter' || k === ' ' || k === 'arrowright' || k === 'd') {
        uiSound('confirm');
        this.focusRows();
      } else if (k === 'escape' || k === 'backspace' || k === 'tab') this.close();
      return;
    }
    if (k === 'arrowup' || k === 'w' || k === 'arrowdown' || k === 's') {
      const d = k === 'arrowup' || k === 'w' ? -1 : 1;
      this.cursor = this.selectable(this.cursor + d, d);
      return this.paint(true);
    }
    if (k === 'arrowleft' || k === 'a') return this.adjust(-1);
    if (k === 'arrowright' || k === 'd') return this.adjust(1);
    if (k === 'enter' || k === ' ') return this.activate();
    if (k === 'escape' || k === 'backspace') {
      uiSound('cancel');
      this.setFocus('cats');
    }
  }
}
