/**
 * The Remake-style UI kit's behaviour: button glyphs for the current device, enter/exit transitions, the drifting
 * light specks, EC's own UI sounds, and small builders for the theme.css pieces. Art: public/ui (GIMP, see
 * brand/gimp/ui). Demo of everything: open the app with ?ui-kit.
 */
import './theme.css';
import { h } from '../ui';
import { inputMode, onInputMode, trackInputMode } from '../battle/input';
import { popModal, pushModal } from '../game/modal';
import { keyLabel, settings, type Action, type PadAction } from '../game/settings';
import { assetUrl } from '../platform/source';
import { GLYPH_ATLAS, ICON_ATLAS, MATERIA_ATLAS, type GlyphName, type IconName, type MateriaColor } from './atlas';
import { PAD_INDEX, pickDevice, resolveGlyph, type Device, type GlyphPart, type PadButton, type UiAction } from './glyphs';
import { uiPrefs } from './prefs';

export type { Device, UiAction } from './glyphs';
export type { GlyphName, IconName, MateriaColor } from './atlas';
export { uiPrefs } from './prefs';

// ------------------------------------------------------------------------------------------------------- glyphs

let padId: string | null = null;
const deviceListeners = new Set<(d: Device) => void>();
let lastDevice: Device | null = null;

function firstPadId(): string | null {
  for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected) return p.id;
  return null;
}

function deviceChanged() {
  const d = glyphDevice();
  if (d === lastDevice) return;
  lastDevice = d;
  // every glyph made by glyphEl() re-renders itself
  for (const el of document.querySelectorAll<HTMLElement>('[data-rm-glyph]')) renderGlyph(el, el.dataset.rmGlyph as UiAction, d);
  for (const fn of deviceListeners) fn(d);
}

let tracking = false;
function track() {
  if (tracking || typeof window === 'undefined') return;
  tracking = true;
  trackInputMode();
  onInputMode(deviceChanged);
  window.addEventListener('ff7ec:gamepad', () => {
    const id = firstPadId();
    if (id !== padId) {
      padId = id;
      deviceChanged();
    }
  });
  window.addEventListener('gamepadconnected', (e) => {
    padId = (e as GamepadEvent).gamepad.id;
    deviceChanged();
  });
  uiPrefs.onChange(deviceChanged);
  // a rebound key or button: redraw every glyph with its new label
  settings.onChange(() => {
    const d = glyphDevice();
    for (const el of document.querySelectorAll<HTMLElement>('[data-rm-glyph]')) renderGlyph(el, el.dataset.rmGlyph as UiAction, d);
  });
  lastDevice = glyphDevice();
}

/** The glyph set in use: the Glyphs option, or (Auto) the last input device and the pad's make. */
export function glyphDevice(): Device {
  return pickDevice(uiPrefs.p.glyphs, inputMode(), padId ?? firstPadId());
}

/** Called when the glyph set changes (another device used, the option changed, a pad plugged in). */
export function onGlyphChange(fn: (d: Device) => void) {
  track();
  deviceListeners.add(fn);
  return () => void deviceListeners.delete(fn);
}

const FIELD_KEYS: Partial<Record<UiAction, Action[]>> = {
  move: ['up', 'left', 'down', 'right'],
  interact: ['interact'],
  menu: ['menu'],
  run: ['run'],
  camera: ['camera'],
  rotate: ['rotL', 'rotR'],
};

/** Keyboard labels of rebindable field actions, from Settings → Controls (first non-arrow key of each). */
function keyFor(a: UiAction): string[] | null {
  const acts = FIELD_KEYS[a];
  if (!acts) return null;
  return acts.map((x) => {
    const keys = settings.keys(x);
    return keyLabel(keys.find((k) => !k.startsWith('arrow') && k !== 'enter') ?? keys[0] ?? '');
  });
}

/** Field actions the player can rebind on the pad (Options → Controls). */
const FIELD_PAD: Partial<Record<UiAction, PadAction[]>> = { interact: ['interact'], menu: ['menu'], run: ['run'], camera: ['camera'], rotate: ['rotL', 'rotR'] };

function padFor(a: UiAction): PadButton[] | null {
  const acts = FIELD_PAD[a];
  if (!acts) return null;
  const out = acts.flatMap((x) => settings.padButtons(x).slice(-1)).map((i) => PAD_INDEX[i]).filter(Boolean);
  return out.length ? out : null;
}

/** The parts of an action's glyph on the current device (or a given one). */
export function glyph(a: UiAction, d: Device = glyphDevice()): GlyphPart[] {
  track();
  return resolveGlyph(a, d, keyFor, padFor);
}

function cellVars(el: HTMLElement, atlas: { cols: number; rows: number; cells: Record<string, readonly [number, number]> }, name: string) {
  const c = atlas.cells[name] ?? [0, 0];
  el.style.setProperty('--ix', String(c[0]));
  el.style.setProperty('--iy', String(c[1]));
  el.style.setProperty('--cols', String(atlas.cols));
  el.style.setProperty('--rows', String(atlas.rows));
}

/** One atlas glyph (pad button, D-pad, stick or mouse button). */
export function glyphImg(name: GlyphName): HTMLSpanElement {
  const el = h('span', { class: 'rm-glyph', role: 'img', 'aria-label': name });
  cellVars(el, GLYPH_ATLAS, name);
  return el;
}

/** A keyboard key: the keycap 9-slice with its label. */
export function keyCap(label: string): HTMLSpanElement {
  return h('span', { class: 'rm-key' }, h('span', {}, label));
}

function renderGlyph(el: HTMLElement, a: UiAction, d: Device) {
  el.replaceChildren(...resolveGlyph(a, d, keyFor, padFor).map((p) => ('atlas' in p ? glyphImg(p.atlas) : keyCap(p.key))));
  el.dataset.rmDevice = d;
}

/** The glyph(s) for an action; the element follows device changes by itself while it is in the document. */
export function glyphEl(a: UiAction): HTMLSpanElement {
  track();
  const el = h('span', { class: 'rm-glyphs', 'data-rm-glyph': a });
  renderGlyph(el, a, glyphDevice());
  return el;
}

/** [glyph] label */
export function hint(a: UiAction, label: string): HTMLSpanElement {
  return h('span', { class: 'rm-hint' }, glyphEl(a), h('span', {}, label));
}

export function hints(list: [UiAction, string][]): HTMLDivElement {
  return h('div', { class: 'rm-hints' }, ...list.map(([a, l]) => hint(a, l)));
}

// -------------------------------------------------------------------------------------------- icons, orbs, bars

/** A white/cyan icon from the atlas, tinted by `color` (CSS mask). Size = font-size. */
export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const el = h('span', { class: `rm-icon ${cls}`.trim(), role: 'img', 'aria-label': name });
  cellVars(el, ICON_ATLAS, name);
  return el;
}

/** A materia orb (null = an empty slot). */
export function orb(color: MateriaColor | null): HTMLSpanElement {
  if (!color) return h('span', { class: 'rm-orb rm-orb--empty' });
  const el = h('span', { class: 'rm-orb', role: 'img', 'aria-label': `${color} materia` });
  cellVars(el, MATERIA_ATLAS, color);
  return el;
}

export type BarKind = 'hp' | 'mp' | 'atb' | 'limit' | 'enemy';

/** A gauge; set(v) takes 0..1. HP turns amber below 1/4 and red below 1/10 and leaves a white "damage" ghost. */
export function bar(kind: BarKind, v = 1) {
  const fill = h('i');
  const ghost = kind === 'hp' || kind === 'enemy' ? h('b') : null;
  const root = h('div', { class: `rm-bar rm-bar--${kind}` }, ghost, fill);
  const set = (x: number) => {
    const c = Math.max(0, Math.min(1, x));
    root.style.setProperty('--v', String(c));
    // the ghost under the fill has a delayed, slower transition, so after a drop it trails behind
    root.style.setProperty('--ghost', String(c));
    root.classList.toggle('is-full', c >= 1);
    root.classList.toggle('is-low', kind === 'hp' && c < 0.25);
    root.classList.toggle('is-critical', kind === 'hp' && c < 0.1);
  };
  set(v);
  return { root, set };
}

// ------------------------------------------------------------------------------------------------------- motion

const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Reduced motion: the setting, or (Auto) the OS preference. */
export function motionReduced(): boolean {
  const m = uiPrefs.p.motion;
  return m === 'reduced' || (m === 'auto' && !!reducedQuery?.matches);
}

function applyMotion() {
  if (typeof document !== 'undefined') document.documentElement.dataset.rmMotion = motionReduced() ? 'reduced' : 'full';
}
applyMotion();
uiPrefs.onChange(applyMotion);
reducedQuery?.addEventListener?.('change', applyMotion);

export type Transition = 'left' | 'right' | 'up' | 'fade' | 'zoom';
const ANIM = /^rm-(in|out)-/;

function play(el: HTMLElement, cls: string, delay: number): Promise<void> {
  for (const c of [...el.classList]) if (ANIM.test(c)) el.classList.remove(c);
  void el.offsetWidth; // restart the animation
  el.style.animationDelay = delay ? `${delay}ms` : '';
  el.classList.add(cls);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      el.removeEventListener('animationend', onEnd);
      resolve();
    };
    const onEnd = (e: AnimationEvent) => e.target === el && done();
    el.addEventListener('animationend', onEnd);
    const t = setTimeout(done, delay + 600); // hidden tabs never fire animationend
  });
}

/**
 * Panel / screen entrance: slide in from a side, rise, zoom or fade (a fade only, with reduced motion). The class
 * goes once the animation is done: a finished but still applied opacity animation would keep the element a
 * "backdrop root" and stop the blur of backdrop-filter (scene backdrops) from seeing what lies under it.
 */
export function enter(el: HTMLElement, kind: Transition = 'fade', delay = 0) {
  const cls = `rm-in-${kind}`;
  return play(el, cls, delay).then(() => {
    el.classList.remove(cls);
    el.style.animationDelay = '';
  });
}

/** The matching exit; resolves when it is done so the caller can remove the element. */
export function exit(el: HTMLElement, kind: Transition = 'fade', delay = 0) {
  return play(el, `rm-out-${kind}`, delay);
}

/** Enter a list of elements one after another (menu rows, cards). */
export function stagger(els: Iterable<HTMLElement>, kind: Transition = 'left', step = 35, delay = 0) {
  return Promise.all([...els].map((el, i) => enter(el, kind, delay + i * (motionReduced() ? 0 : step))));
}

/** A light sweep across a row (when it is picked). */
export function sweep(row: HTMLElement) {
  if (motionReduced()) return;
  row.querySelector(':scope > .rm-sweep')?.remove();
  const s = h('span', { class: 'rm-sweep' });
  s.addEventListener('animationend', () => s.remove());
  row.prepend(s);
}

// ------------------------------------------------------------------------------------------------------- specks

/**
 * Drifting light specks on a canvas over the nebula: a few hundred soft sprites at most, additive, capped at
 * 30 fps, paused while the tab is hidden. With reduced motion they hold still.
 */
export class Specks {
  readonly canvas = h('canvas', { class: 'rm-specks' });
  private ctx = this.canvas.getContext('2d')!;
  private sprite = Specks.makeSprite();
  private p: { x: number; y: number; vx: number; vy: number; r: number; a: number; tw: number; ph: number }[] = [];
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver;

  constructor(
    parent: HTMLElement,
    private density = 1,
  ) {
    parent.append(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.resize();
    this.start();
  }

  private static makeSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(235,250,255,1)');
    grd.addColorStop(0.18, 'rgba(160,225,255,0.85)');
    grd.addColorStop(0.45, 'rgba(90,170,255,0.25)');
    grd.addColorStop(1, 'rgba(60,140,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 32, 32);
    return c;
  }

  private resize() {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h_ = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.canvas.width && h_ === this.canvas.height && this.p.length) return;
    this.canvas.width = w;
    this.canvas.height = h_;
    const n = Math.round(((w * h_) / (1920 * 1080)) * 140 * this.density);
    this.p = Array.from({ length: Math.min(400, n) }, () => this.spawn(w, h_, true));
    this.draw(0);
  }

  private spawn(w: number, h_: number, anywhere: boolean) {
    const s = Math.min(w, h_) / 1080;
    const near = Math.random() ** 2.5; // a few big, near specks; mostly tiny far ones
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h_ : h_ + 20,
      vx: (-4 - 10 * near) * s,
      vy: (-6 - 22 * near) * s,
      r: (3 + 14 * near) * s,
      a: 0.25 + 0.6 * near,
      tw: 0.5 + Math.random() * 1.5,
      ph: Math.random() * Math.PI * 2,
    };
  }

  private draw(dt: number) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h_ = canvas.height;
    ctx.clearRect(0, 0, w, h_);
    ctx.globalCompositeOperation = 'lighter';
    const t = performance.now() / 1000;
    for (let i = 0; i < this.p.length; i++) {
      const q = this.p[i];
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.y < -20 || q.x < -20) this.p[i] = Object.assign(q, this.spawn(w, h_, false), { x: Math.random() * w * 1.2 });
      ctx.globalAlpha = q.a * (0.6 + 0.4 * Math.sin(t * q.tw + q.ph));
      ctx.drawImage(this.sprite, q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (now - this.last < 33 || document.hidden) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.draw(motionReduced() ? 0 : dt);
  };

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  dispose() {
    this.stop();
    this.ro.disconnect();
    this.canvas.remove();
  }
}

/** The full nebula backdrop: image, speck tile, canvas specks, optional grid / hex lines, vignette. */
export function backdrop(opts: { scene?: boolean; specks?: boolean; grid?: boolean; hex?: boolean; vignette?: boolean } = {}) {
  const root = h('div', { class: `rm-backdrop${opts.scene ? ' rm-backdrop--scene' : ''}` });
  if (opts.hex) root.append(h('div', { class: 'rm-layer rm-hex' }));
  if (opts.grid !== false) root.append(h('div', { class: 'rm-layer rm-grid' }));
  if (opts.specks !== false) root.append(h('div', { class: 'rm-layer rm-specks-tile' }));
  const specks = opts.specks !== false ? new Specks(root, opts.scene ? 0.5 : 1) : null;
  if (opts.vignette !== false) root.append(h('div', { class: 'rm-layer rm-vignette' }));
  return { root, specks, dispose: () => specks?.dispose() };
}

// -------------------------------------------------------------------------------------------------------- sounds

/** EC's own menu sounds (se_ui_common), read from the player's extracted audio at runtime; silent if missing. */
const UI_SE = {
  cursor: '0106_se_ui_common_select_01',
  confirm: '0061_se_ui_common_decide_01',
  cancel: '0056_se_ui_common_cancel_01',
  error: '0082_se_ui_common_ng_01',
  open: '0074_se_ui_common_globalmenu_01',
  close: '0073_se_ui_common_globalback_01',
  tab: '0112_se_ui_common_tab_01',
  toggle: '0111_se_ui_common_switch_01',
  dropdown: '0093_se_ui_common_pulldown_01',
  equip: '0071_se_ui_common_equipmentset_01',
  buy: '0054_se_ui_common_buy_01',
  count: '0059_se_ui_common_count_01',
  notice: '0083_se_ui_common_notice_01',
  popup: '0092_se_ui_common_popup_01',
} as const;
export type UiSound = keyof typeof UI_SE;

let actx: AudioContext | null = null;
const buffers = new Map<UiSound, Promise<AudioBuffer | null>>();
const lastPlayed = new Map<UiSound, number>();

function audio() {
  if (!actx) {
    try {
      actx = new AudioContext();
    } catch {
      return null;
    }
  }
  return actx;
}

function load(name: UiSound): Promise<AudioBuffer | null> {
  let p = buffers.get(name);
  if (!p) {
    const ctx = audio();
    p = !ctx
      ? Promise.resolve(null)
      : fetch(assetUrl(`/arc/08-Audio-Extracted/se_ui_common/${UI_SE[name]}.flac`))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((b) => ctx.decodeAudioData(b))
          .catch(() => null); // not extracted / no audio: stay silent
    buffers.set(name, p);
  }
  return p;
}

/** Fetch and decode the menu sounds ahead of time (call after the first user gesture). */
export function preloadUiSounds() {
  for (const k of Object.keys(UI_SE) as UiSound[]) void load(k);
}

/** Play a menu sound at the Sound effects level (Settings → Audio), unless UI sounds are off. */
export function uiSound(name: UiSound) {
  if (!uiPrefs.p.sounds) return;
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -1e9) < 35) return; // a held key repeats faster than the sound
  lastPlayed.set(name, now);
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  void load(name).then((buf) => {
    if (!buf) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = settings.s.audio.sfx;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start();
  });
}

// ------------------------------------------------------------------------------------------------------ builders

/** The full-screen menu frame with its vertical title rail. Put content in `body`, a footer() in `root`. */
export function frame(title: string) {
  const titleEl = h('span', { class: 'rm-frame__title' }, title);
  const rail = h('div', { class: 'rm-frame__rail' }, titleEl);
  const body = h('div', { class: 'rm-frame__body' });
  const root = h('div', { class: 'rm-frame rm' }, rail, body);
  return { root, rail, body, setTitle: (t: string) => (titleEl.textContent = t) };
}

/** 000:00:00, like the Remake menu's play time. */
export function formatPlayTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(s / 3600), 3)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export const RIGHTS_LINE = '© SQUARE ENIX CO., LTD. All Rights Reserved. Unofficial fan project.';

/** Footer: play time + gil (left), help text (centre), button hints (right), tiny rights line (bottom right). */
export function footer(o: { time?: number; gil?: number; help?: string; hints?: [UiAction, string][]; rights?: string } = {}) {
  const time = h('span', { class: 'rm-num' });
  const gil = h('span', { class: 'rm-num' });
  const help = h('div', { class: 'rm-footer__help' });
  const hintBox = h('div', { class: 'rm-footer__hints' });
  const root = h(
    'footer',
    { class: 'rm-footer' },
    help,
    h('div', { class: 'rm-footer__left' }, h('span', { class: 'rm-footer__stat' }, icon('clock'), time), h('span', { class: 'rm-footer__stat' }, icon('gil'), gil)),
    h('div'),
    hintBox,
    h('div', { class: 'rm-footer__rights' }, o.rights ?? RIGHTS_LINE),
  );
  const api = {
    root,
    setTime: (s: number) => (time.textContent = formatPlayTime(s)),
    setGil: (g: number) => (gil.textContent = g.toLocaleString('en-US')),
    setHelp: (t: string) => (help.textContent = t),
    setHints: (l: [UiAction, string][]) => hintBox.replaceChildren(hints(l)),
  };
  api.setTime(o.time ?? 0);
  api.setGil(o.gil ?? 0);
  api.setHelp(o.help ?? '');
  api.setHints(o.hints ?? []);
  return api;
}

export interface RowItem {
  label: string;
  value?: string | Node;
  icon?: IconName;
  disabled?: boolean;
  help?: string;
}

/**
 * A selectable list (rows, highlight, sounds). Keyboard / pad: call move(±1) and pick() from the screen's key
 * handler; the mouse hovers and clicks by itself.
 */
export class RowList {
  readonly root = h('div', { class: 'rm-list' });
  private rows: HTMLDivElement[] = [];
  index = 0;
  onSelect: (i: number, item: RowItem) => void = () => {};
  onPick: (i: number, item: RowItem) => void = () => {};

  constructor(
    private items: RowItem[],
    accent = true,
  ) {
    if (accent) this.root.classList.add('rm-list--accent');
    this.render();
  }

  setItems(items: RowItem[]) {
    this.items = items;
    this.render();
  }

  private render() {
    this.rows = this.items.map((it, i) => {
      const row = h(
        'div',
        { class: `rm-row${it.disabled ? ' is-disabled' : ''}`, role: 'option' },
        it.icon ? icon(it.icon, 'rm-icon--cyan') : null,
        h('span', { class: 'rm-row__label' }, it.label),
        it.value !== undefined ? h('span', { class: 'rm-row__value' }, it.value) : null,
      );
      row.addEventListener('mouseenter', () => this.select(i));
      row.addEventListener('click', () => {
        this.select(i, false);
        this.pick();
      });
      return row;
    });
    this.root.replaceChildren(...this.rows);
    this.select(Math.min(this.index, this.items.length - 1), false);
  }

  select(i: number, sound = true) {
    if (i < 0 || i >= this.rows.length) return;
    if (sound && i !== this.index) uiSound('cursor');
    this.rows[this.index]?.classList.remove('is-selected');
    this.index = i;
    this.rows[i].classList.add('is-selected');
    this.rows[i].scrollIntoView?.({ block: 'nearest' });
    this.onSelect(i, this.items[i]);
  }

  move(d: number) {
    const n = this.rows.length;
    if (n) this.select((this.index + d + n) % n);
  }

  pick() {
    const it = this.items[this.index];
    if (!it) return;
    if (it.disabled) return uiSound('error');
    uiSound('confirm');
    sweep(this.rows[this.index]);
    this.onPick(this.index, it);
  }

  get rowEls(): readonly HTMLDivElement[] {
    return this.rows;
  }
}

/** The ability-name banner (party blue / enemy red). show() fades it in, holds, and fades it out. */
export function banner(side: 'party' | 'enemy' = 'party') {
  const root = h('div', { class: `rm rm-banner${side === 'enemy' ? ' rm-banner--enemy' : ''}`, hidden: true });
  let timer = 0;
  return {
    root,
    async show(text: string, ms = 1600) {
      clearTimeout(timer);
      root.textContent = text;
      root.hidden = false;
      await enter(root, 'zoom');
      timer = window.setTimeout(() => void exit(root, 'fade').then(() => (root.hidden = true)), ms);
    },
  };
}

/** Battle notifications ("Guard Hound defeated.", "436 EXP gained."): newest at the bottom, max lines, auto-expire. */
export class NotifyFeed {
  readonly root = h('div', { class: 'rm rm-notify-feed' });

  constructor(
    private max = 4,
    private ms = 3600,
  ) {}

  push(iconName: IconName, text: string, hi = false) {
    const line = h('div', { class: `rm-notify${hi ? ' rm-notify--hi' : ''}` }, icon(iconName), h('span', {}, text));
    this.root.append(line);
    void enter(line, 'left');
    while (this.root.children.length > this.max) this.root.firstElementChild!.remove();
    setTimeout(() => void exit(line, 'fade').then(() => line.remove()), this.ms);
    uiSound('notice');
  }
}

/** A dropdown list (Options values). */
export function dropdown(options: string[], selected = 0) {
  const list = new RowList(options.map((label) => ({ label })), false);
  list.select(selected, false);
  const root = h('div', { class: 'rm rm-dropdown' }, list.root);
  return { root, list };
}

/** An Options row: label right, diamond node, value left. */
export function optionRow(label: string, value: string | Node) {
  return h(
    'div',
    { class: 'rm-row rm-option' },
    h('span', { class: 'rm-option__label' }, label),
    h('span', { class: 'rm-option__node' }),
    h('span', { class: 'rm-option__value' }, value),
  );
}

/** [icon] Label .... value  delta (equipment stat line). */
export function statLine(iconName: IconName, label: string, value: number | string, delta = 0) {
  return h(
    'div',
    { class: 'rm-stat' },
    icon(iconName),
    h('span', { class: 'rm-stat__label' }, label),
    h('span', { class: 'rm-stat__value' }, String(value)),
    h('span', { class: `rm-stat__delta ${delta > 0 ? 'rm-delta--up' : delta < 0 ? 'rm-delta--down' : ''}` }, delta ? (delta > 0 ? `+${delta}` : String(delta)) : ''),
  );
}

/** Quantity picker: ◂ 03 ▸ with the decrease / increase glyphs. */
export function quantity(min: number, max: number, value = min, onChange: (n: number) => void = () => {}) {
  const n = h('span', { class: 'rm-qty__n' });
  const less = icon('chevron-left');
  const more = icon('chevron-right');
  const root = h('div', { class: 'rm rm-qty' }, glyphEl('decrease'), less, n, more, glyphEl('increase'));
  let v = value;
  less.style.cursor = more.style.cursor = 'pointer';
  less.addEventListener('click', (e) => (e.stopPropagation(), set(v - 1)));
  more.addEventListener('click', (e) => (e.stopPropagation(), set(v + 1)));
  const set = (x: number) => {
    const c = Math.max(min, Math.min(max, x));
    if (c !== v) uiSound('count');
    v = c;
    n.textContent = String(v).padStart(2, '0');
    onChange(v);
  };
  n.textContent = String(v).padStart(2, '0');
  return { root, set, step: (d: number) => set(v + d), get value() { return v; } };
}

// ------------------------------------------------------------------------------------------ menu screen pieces

/** A section heading with the glowing underline ("Weapon", "Attributes"); `aside` sits on the right. */
export function heading(text: string, aside?: string | Node) {
  return h('div', { class: 'rm-heading' }, h('span', {}, text), aside !== undefined ? h('span', { class: 'rm-heading__aside' }, aside) : null);
}

/** Category strip with the previous / next tab glyphs; click a tab or call set(). */
export function tabStrip(labels: string[], index = 0, onPick: (i: number) => void = () => {}) {
  let cur = index;
  const tabs = labels.map((l, i) => {
    const t = h('span', { class: 'rm-tab' }, l);
    t.addEventListener('click', () => {
      if (i !== cur) uiSound('tab');
      api.set(i);
      onPick(i);
    });
    return t;
  });
  const step = (d: number) => {
    const n = labels.length;
    uiSound('tab');
    api.set((cur + d + n) % n);
    onPick(cur);
  };
  const prev = icon('chevron-left');
  const next = icon('chevron-right');
  prev.style.cursor = next.style.cursor = 'pointer';
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  const root = h('div', { class: 'rm-tabs' }, glyphEl('tabPrev'), prev, ...tabs, next, glyphEl('tabNext'));
  const api = {
    root,
    get index() {
      return cur;
    },
    set(i: number) {
      tabs[cur]?.classList.remove('is-selected');
      cur = i;
      tabs[cur]?.classList.add('is-selected');
    },
    /** Q / E, L1 / R1: the previous / next tab (with sound), then onPick. */
    step,
  };
  api.set(cur);
  return api;
}

/** Character switcher: [L1] ‹ Name › [R1]; the arrows call onStep(±1). */
export function switcher(name: string, onStep: (d: number) => void) {
  const label = h('span', { class: 'rm-switcher__name' }, name);
  const prev = icon('chevron-left');
  const next = icon('chevron-right');
  prev.addEventListener('click', () => onStep(-1));
  next.addEventListener('click', () => onStep(1));
  return { root: h('div', { class: 'rm-switcher' }, glyphEl('tabPrev'), prev, label, next, glyphEl('tabNext')), set: (n: string) => (label.textContent = n) };
}

export type Mark = 'check' | 'up' | 'down' | 'none';

/** Who-can-equip marks: ✓ can equip, ↑ better than now, ↓ worse, – cannot. */
export function mark(m: Mark) {
  const el = h('span', { class: `rm-mark rm-mark--${m}`, role: 'img', 'aria-label': m });
  if (m === 'check') el.append(icon('check'));
  else if (m === 'up') el.append(icon('chevron-up'));
  else if (m === 'down') el.append(icon('chevron-down'));
  else el.textContent = '–';
  return el;
}

/** An Options slider: ticks filled to v (0..1) and the value text; click the track to set it (onPick gets 0..1). */
export function slider(v: number, text: string, onPick?: (v: number) => void) {
  const fill = h('span', { class: 'rm-slider__fill' });
  const track = h('span', { class: 'rm-slider__track' }, fill);
  const label = h('span', { class: 'rm-slider__text' }, text);
  if (onPick)
    track.addEventListener('click', (e) => {
      const r = track.getBoundingClientRect();
      onPick(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    });
  const root = h('span', { class: 'rm-slider' }, track, label);
  const set = (x: number, t: string) => {
    root.style.setProperty('--v', String(Math.max(0, Math.min(1, x))));
    label.textContent = t;
  };
  set(v, text);
  return { root, set };
}

/**
 * A confirmation popup ("Overwrite slot 2?") with a short choice list. Takes the keyboard while it is open
 * (↑↓ Enter, Esc / Backspace = cancel). Resolves with the picked index, or null when cancelled.
 */
export function confirmBox(text: string, options: string[] = ['Yes', 'No'], selected = 0): Promise<number | null> {
  return new Promise((resolve) => {
    const list = new RowList(options.map((label) => ({ label })), false);
    list.select(selected, false);
    const panel = h('div', { class: 'rm-panel' }, h('div', { class: 'rm-confirm__text' }, text), list.root);
    const root = h('div', { class: 'rm rm-confirm' }, panel);
    const done = (v: number | null) => {
      popModal(key);
      root.removeEventListener('contextmenu', onCtx);
      void exit(root, 'fade').then(() => root.remove());
      resolve(v);
    };
    const key = (k: string) => {
      if (k === 'arrowup' || k === 'w') list.move(-1);
      else if (k === 'arrowdown' || k === 's') list.move(1);
      else if (k === 'enter' || k === ' ') list.pick();
      else if (k === 'escape' || k === 'backspace') {
        uiSound('cancel');
        done(null);
      }
    };
    const onCtx = (e: Event) => {
      e.preventDefault();
      uiSound('cancel');
      done(null);
    };
    list.onPick = (i) => done(i);
    root.addEventListener('contextmenu', onCtx);
    root.addEventListener('click', (e) => e.target === root && (uiSound('cancel'), done(null)));
    pushModal(key);
    document.body.append(root);
    uiSound('popup');
    void enter(panel, 'zoom');
  });
}
