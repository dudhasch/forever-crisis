import './menu.css';
import { storyIndex, type StoryIndex } from '../story/data';
import type { SoundEffects } from '../story/overlay';
import { assetMode, assetUrl } from '../platform/source';
import type { MapEntry } from '../types';
import { h } from '../ui';
import { canFullscreen, enterFullscreen, isFullscreen } from '../ui/fullscreen';
import { enter, heading, hints, preloadUiSounds, Specks, uiSound, type UiAction } from '../ui/kit';
import { uiPrefs } from '../ui/prefs';
import { menuGamepad } from './gamepad';
import { SE, type MenuData, type StoryLine } from './data';
import { modalOpen } from './modal';
import { formatTime, type GameState, type SaveData } from './state';

/**
 * The logo the extractor draws from the player's own game files (ffcx brand.py). It contains Square Enix artwork,
 * so it is only used where it was built on the player's PC: local mode (`ffcx serve`) and the dev server. The
 * hosted site always shows the plain text title.
 */
const LOGO_URLS = ['/brand/forever-crisis-logo.png', '/brand/logo.png', '/brand/logo.webp', '/brand/logo.svg'];
/** EC's title BGM (the client's title scene names it next to the se_ui_title bank). */
export const TITLE_BGM = 'bgm_ff7_087';
const SLIDE_SECONDS = 9;

/** What the player picked on the title screen. */
export type TitleChoice = { kind: 'continue' } | { kind: 'step'; step: number } | { kind: 'free'; map: string } | { kind: 'slot'; slot: number };

export interface TitleHost {
  game: GameState;
  sfx: SoundEffects;
  maps: MapEntry[];
  mapsByKey: Map<string, MapEntry>;
  /** Unlock audio after the first key press (browsers block it before). */
  unlockAudio: () => void;
  /** Start the title music. */
  titleMusic: () => void;
  /** The Settings window; resolves when it closes. */
  openSettings: () => Promise<void>;
  /** Report a bug (GitHub issue form in a new tab); resolves when the window closes. */
  reportBug: () => Promise<unknown>;
}

interface Opt {
  el: HTMLElement;
  enabled: boolean;
  run: () => void;
}

/** Chapters with their first playable story step (story order), or -1 when the archive has none of its maps. */
export interface ChapterEntry {
  id: number;
  name: string;
  order: number;
  step: number;
  steps: number;
}

export function chaptersOf(line: StoryLine, idx: StoryIndex, mapsByKey: Map<string, MapEntry>): ChapterEntry[] {
  const chapterOfEpisode = new Map(idx.episodes.map((e) => [e.id, (e as unknown as { chapterId?: number }).chapterId]));
  return line.chapters.map((c) => {
    const playable = (i: number) => {
      const s = idx.story[i];
      return s.hasScripts && mapsByKey.has(s.map) && chapterOfEpisode.get(s.episodeId) === c.id;
    };
    const step = idx.story.findIndex((_, i) => playable(i));
    const steps = idx.story.filter((_, i) => playable(i)).length;
    return { id: c.id, name: c.name ?? `Chapter ${c.order}`, order: c.order, step, steps };
  });
}

export function saveSummary(d: SaveData, menu: MenuData | null) {
  const p = d.position;
  const leader = menu?.characters[String(d.leader)]?.name ?? '';
  const where =
    p.mode === 'free' ? `Free Roam · ${p.mapTitle ?? p.map ?? ''}` : [p.family, p.chapter, p.title].filter(Boolean).join(' · ') || (p.mapTitle ?? p.map ?? '');
  return {
    where,
    line2: `${leader ? `${leader} · ` : ''}Lv ${d.level} · ${d.gil.toLocaleString()} Gil · ${formatTime(d.playTime)}`,
    when: d.savedAt ? new Date(d.savedAt).toLocaleString() : '',
  };
}

export class TitleScreen {
  readonly root = h('div', { class: 'title-screen rm hidden' });
  private readonly bg = h('div', { class: 'ts-bg' }, h('div', { class: 'ts-layer' }), h('div', { class: 'ts-layer' }));
  private readonly content = h('div', { class: 'ts-content' });
  private readonly footer = h(
    'div',
    { class: 'ts-footer' },
    h('div', {}, 'FINAL FANTASY VII EVER CRISIS © SQUARE ENIX CO., LTD. All Rights Reserved.'),
    h('div', {}, 'Unofficial fan project, not affiliated with Square Enix.'),
  );
  private readonly hintBox = h('div', { class: 'ts-hints' });
  private specks: Specks | null = null;
  private restorePad: (() => void) | null = null;
  private opts: Opt[] = [];
  private cursor = 0;
  private back: (() => void) | null = null;
  private resolve: ((c: TitleChoice) => void) | null = null;
  private menu: MenuData | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private slides: string[] = [];
  private slide = 0;
  private slideTimer = 0;
  private logo: string | null = null;

  constructor(private readonly host: TitleHost) {
    this.root.append(this.bg, h('div', { class: 'ts-vignette' }), this.content, this.hintBox, this.footer);
    // right click goes back, like Esc
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.back || modalOpen()) return;
      uiSound('cancel');
      this.back();
    });
    document.body.append(this.root);
    void this.findLogo();
  }

  get open() {
    return !this.root.classList.contains('hidden');
  }

  /** Show the title; `press` starts at "press any key" (cold start). */
  show(menu: MenuData | null, press: boolean): Promise<TitleChoice> {
    this.menu = menu;
    this.root.classList.remove('hidden');
    window.addEventListener('keydown', this.keyHandler, true);
    this.restorePad?.();
    this.restorePad = menuGamepad();
    this.startBackdrop(menu?.backgrounds ?? []);
    if (press) this.pressScreen();
    else {
      this.host.titleMusic();
      this.mainScreen();
    }
    return new Promise((r) => (this.resolve = r));
  }

  hide() {
    this.root.classList.add('hidden');
    window.removeEventListener('keydown', this.keyHandler, true);
    clearInterval(this.slideTimer);
    this.specks?.dispose();
    this.specks = null;
    this.restorePad?.();
    this.restorePad = null;
  }

  // ------------------------------------------------------------------ backdrop
  /** EC home artwork: a slow pan on each picture and a cross-fade to the next. */
  private startBackdrop(all: string[]) {
    clearInterval(this.slideTimer);
    const pool = [...all];
    this.slides = [];
    while (pool.length && this.slides.length < 6) this.slides.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    this.slide = 0;
    for (const l of this.bg.children) l.classList.remove('show');
    this.nextSlide();
    if (this.slides.length > 1) this.slideTimer = window.setInterval(() => this.nextSlide(), SLIDE_SECONDS * 1000);
    this.startMotes();
  }

  private nextSlide() {
    const url = this.slides[this.slide++ % Math.max(1, this.slides.length)];
    if (!url) return;
    const layers = [...this.bg.children] as HTMLElement[];
    const next = layers.find((l) => !l.classList.contains('show')) ?? layers[0];
    const prev = layers.find((l) => l !== next);
    const img = new Image();
    img.onload = () => {
      next.style.backgroundImage = `url("${img.src}")`;
      // a different drift each time, from one corner towards the other
      const dir = Math.floor(Math.random() * 4);
      next.style.setProperty('--fx', `${dir & 1 ? -3 : 3}%`);
      next.style.setProperty('--fy', `${dir & 2 ? -2 : 2}%`);
      next.classList.remove('pan');
      void next.offsetWidth;
      next.classList.add('pan', 'show');
      prev?.classList.remove('show');
    };
    img.src = assetUrl(url);
  }

  /** The kit's drifting light specks over the artwork (they hold still with reduced motion). */
  private startMotes() {
    this.specks?.dispose();
    this.specks = new Specks(this.root, 0.6);
    this.specks.canvas.classList.add('ts-motes');
    this.bg.after(this.specks.canvas);
  }

  private async findLogo() {
    if (assetMode() !== 'local' && assetMode() !== 'dev') return;
    for (const url of LOGO_URLS) {
      const ok = await new Promise<boolean>((r) => {
        const i = new Image();
        i.onload = () => r(i.naturalWidth > 0);
        i.onerror = () => r(false);
        i.src = url;
      });
      if (ok) {
        this.logo = url;
        this.root.querySelectorAll('.ts-logo').forEach((el) => el.replaceWith(this.logoEl(el.classList.contains('compact'))));
        return;
      }
    }
  }

  private logoEl(small = false) {
    if (this.logo) return h('div', { class: `ts-logo${small ? ' compact' : ''}` }, h('img', { src: this.logo, alt: 'Forever Crisis' }));
    // plain text title (hosted site, or no logo was drawn)
    return h(
      'div',
      { class: `ts-logo ts-logo-text${small ? ' compact' : ''}` },
      h('div', { class: 'ts-word' }, h('span', {}, 'FOREVER'), h('span', { class: 'ts-crisis' }, 'CRISIS')),
      h('div', { class: 'ts-kicker' }, 'unofficial fan project'),
    );
  }

  private finish(c: TitleChoice) {
    this.host.sfx.play(SE.titleStart);
    uiSound('confirm');
    this.hide();
    const r = this.resolve;
    this.resolve = null;
    r?.(c);
  }

  private head() {
    return this.logoEl(true);
  }

  /** Swap what is shown under the logo. */
  private screen(...children: (Node | null)[]) {
    this.content.replaceChildren(...children.filter((c): c is Node => c !== null));
    const sub = this.content.querySelector('.ts-logo.compact') !== null;
    this.root.classList.toggle('ts-sub', sub);
    const list: [UiAction, string][] = [['confirm', 'Select'], ...(sub ? ([['back', 'Back']] as [UiAction, string][]) : [])];
    this.hintBox.replaceChildren(hints(list));
    this.hintBox.hidden = !this.content.querySelector('.ts-menu, .title-panel');
    const panel = this.content.querySelector<HTMLElement>('.title-panel, .ts-menu');
    if (panel) void enter(panel, 'up');
  }

  private pressScreen() {
    this.opts = [];
    this.back = null;
    const go = () => {
      this.root.removeEventListener('click', go);
      this.host.unlockAudio();
      preloadUiSounds();
      this.host.sfx.play(SE.titleLogo);
      this.host.titleMusic();
      // the press is a user gesture, so full screen can be asked for right here
      const offer = canFullscreen() && !isFullscreen() ? uiPrefs.p.fullscreen : 'never';
      if (offer === 'always') void enterFullscreen();
      if (offer === 'ask') this.fullscreenScreen();
      else this.mainScreen();
    };
    this.root.addEventListener('click', go);
    this.pressGo = go;
    this.screen(this.logoEl(), h('div', { class: 'title-press' }, 'PRESS ANY BUTTON'));
  }

  private pressGo: (() => void) | null = null;

  /** Not full screen after the first press: offer it (Settings → Display & Graphics → Full Screen at Start). */
  private fullscreenScreen(refused = false) {
    const note = refused
      ? 'The browser only switches to full screen after a click or a key press. Click Full Screen, or press Enter.'
      : 'The game is not running in full screen. Switch to full screen?';
    const opts = [
      this.opt('Full Screen', () => {
        // go on at once (some hosts never settle the request); come back only if the browser says no
        this.mainScreen();
        void enterFullscreen().then((ok) => !ok && this.open && this.content.querySelector('.ts-menu') && this.fullscreenScreen(true));
      }),
      this.opt('Play in a Window', () => this.mainScreen()),
      this.opt("Don't Ask Again", () => (uiPrefs.set('fullscreen', 'never'), this.mainScreen())),
    ];
    this.back = () => this.mainScreen();
    this.screen(
      this.logoEl(),
      h('div', { class: 'title-panel ts-fullscreen rm-panel' }, heading('Full Screen'), h('p', { class: 'ts-fs-note' }, note), h('div', { class: 'title-list' }, ...opts.map((o) => o.el))),
    );
    this.setOpts(opts);
  }

  private setOpts(opts: Opt[], cursor = 0) {
    this.opts = opts;
    this.cursor = Math.max(0, Math.min(cursor, opts.length - 1));
    if (!opts[this.cursor]?.enabled)
      this.cursor = Math.max(
        0,
        opts.findIndex((o) => o.enabled),
      );
    opts.forEach((o, i) => {
      o.el.addEventListener('click', () => {
        if (!o.enabled) return void uiSound('error');
        this.cursor = i;
        uiSound('confirm');
        o.run();
      });
      o.el.addEventListener('mouseenter', () => {
        if (o.enabled && this.cursor !== i) {
          this.cursor = i;
          uiSound('cursor');
          this.paint();
        }
      });
    });
    this.paint();
  }

  private paint() {
    this.opts.forEach((o, i) => {
      o.el.classList.toggle('is-selected', i === this.cursor);
      o.el.classList.toggle('cursor', i === this.cursor);
    });
    this.opts[this.cursor]?.el.scrollIntoView({ block: 'nearest' });
  }

  private opt(label: string | Node, run: () => void, enabled = true, extra?: Node): Opt {
    const el = h('div', { class: `rm-row ts-row${enabled ? '' : ' is-disabled'}` }, h('div', { class: 'ts-row__text' }, label, extra ?? null));
    return { el, enabled, run };
  }

  private mainScreen(focus?: number) {
    const g = this.host.game;
    const cur = g.current();
    const sum = cur ? saveSummary(cur, this.menu) : null;
    const anySlot = g.slots().some((s) => s.data);
    // a browser tab cannot close itself; an installed app window (or one a script opened) can
    const canQuit = matchMedia('(display-mode: standalone)').matches || !!window.opener;
    const opts = [
      this.opt('Continue', () => this.finish({ kind: 'continue' }), !!cur, sum ? h('div', { class: 'title-save' }, h('div', {}, sum.where), h('div', {}, sum.line2)) : undefined),
      this.opt('New Game', () => void this.storyScreen()),
      this.opt('Free Roam', () => this.freeScreen()),
      this.opt('Load Game', () => this.loadScreen(), anySlot),
      this.opt('Settings', () => void this.host.openSettings().then(() => this.open && this.mainScreen(4))),
      this.opt('Report a bug', () => void this.host.reportBug().then(() => this.open && this.mainScreen(5))),
      ...(canQuit ? [this.opt('Quit', () => window.close())] : []),
    ];
    this.back = null;
    this.screen(this.logoEl(), h('div', { class: 'ts-menu' }, ...opts.map((o) => o.el)));
    this.setOpts(opts, focus ?? (cur ? 0 : 1));
  }

  private async storyScreen(focus = 0) {
    const lines = this.menu?.story ?? [];
    const idx = await storyIndex();
    if (!idx) return;
    const opts = lines.map((l) => {
      const chapters = chaptersOf(l, idx, this.host.mapsByKey);
      const ok = chapters.some((c) => c.step >= 0);
      const el = h(
        'div',
        { class: `title-logo${ok ? '' : ' disabled'}`, title: l.name ?? l.family },
        l.logo ? h('img', { src: assetUrl(l.logo), alt: l.name ?? l.family }) : h('b', {}, l.name ?? l.family),
        ok ? null : h('span', { class: 'note' }, 'no maps in the archive'),
      );
      return { el, enabled: ok, run: () => this.chapterScreen(l, chapters, lines.indexOf(l)) };
    });
    this.back = () => this.mainScreen();
    this.screen(
      this.head(),
      h(
        'div',
        { class: 'title-panel rm-panel' },
        heading('Choose a Story'),
        h('div', { class: 'title-logos' }, ...opts.map((o) => o.el)),
      ),
    );
    this.setOpts(opts, focus);
  }

  private chapterScreen(line: StoryLine, chapters: ChapterEntry[], lineIndex: number) {
    const cleared = new Set(this.host.game.d.cleared.chapters);
    const opts = chapters.map((c) =>
      this.opt(
        h('span', {}, `${c.id >= 999000 ? '' : `Chapter ${c.order} · `}${c.name}`),
        () => this.finish({ kind: 'step', step: c.step }),
        c.step >= 0,
        h('div', { class: 'title-save' }, c.step >= 0 ? `${c.steps} story steps${cleared.has(c.id) ? ' · ★ cleared' : ''}` : 'Not in the archive'),
      ),
    );
    this.back = () => void this.storyScreen(lineIndex);
    this.screen(
      this.head(),
      h(
        'div',
        { class: 'title-panel rm-panel' },
        line.logo
          ? h('img', { src: assetUrl(line.logo), style: { maxHeight: '64px', objectFit: 'contain', alignSelf: 'center', marginBottom: '6px' } })
          : heading(line.name ?? line.family),
        h('div', { class: 'title-list' }, ...opts.map((o) => o.el)),
        h('div', { class: 'title-foot' }, 'Your items, gear and party carry over · Esc back'),
      ),
    );
    this.setOpts(opts);
  }

  private freeScreen() {
    const maps = this.host.maps.filter((m) => m.kind === 'dungeon' || m.kind === 'environment');
    const search = h('input', { type: 'search', placeholder: 'Search maps…' }) as HTMLInputElement;
    const list = h('div', { class: 'title-list' });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const hits = maps.filter((m) => !q || `${m.title} ${m.key}`.toLowerCase().includes(q)).slice(0, 300);
      const opts = hits.map((m) =>
        this.opt(h('span', {}, m.title || m.key), () => this.finish({ kind: 'free', map: m.key }), true, h('div', { class: 'title-save' }, m.key)),
      );
      list.replaceChildren(...opts.map((o) => o.el));
      this.setOpts(opts);
    };
    search.addEventListener('input', render);
    this.back = () => this.mainScreen();
    this.screen(
      this.head(),
      h(
        'div',
        { class: 'title-panel rm-panel' },
        heading('Free Roam', 'Pick a map'),
        search,
        h('div', { style: { height: '6px' } }),
        list,
        h('div', { class: 'title-foot' }, 'No story scripts: walk anywhere, pick your own party in the menu (Tab)'),
      ),
    );
    render();
    search.focus();
  }

  private loadScreen() {
    const opts = this.host.game.slots().map((s) => {
      const sum = s.data ? saveSummary(s.data, this.menu) : null;
      return this.opt(
        h('span', {}, `Slot ${s.slot}`),
        () => this.finish({ kind: 'slot', slot: s.slot }),
        !!s.data,
        h('div', { class: 'title-save' }, sum ? [sum.where, h('br'), sum.line2, h('br'), sum.when] : 'Empty'),
      );
    });
    this.back = () => this.mainScreen();
    this.screen(
      this.head(),
      h('div', { class: 'title-panel title-main rm-panel' }, heading('Load Game'), h('div', { class: 'title-list' }, ...opts.map((o) => o.el))),
    );
    this.setOpts(opts);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.open || modalOpen()) return;
    const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
    const k = e.key.toLowerCase();
    e.stopImmediatePropagation();
    if (this.pressGo && this.opts.length === 0) {
      e.preventDefault();
      const go = this.pressGo;
      this.pressGo = null;
      go();
      return;
    }
    const grid = this.root.querySelector('.title-logos');
    const cols = grid ? Math.max(1, Math.round(grid.clientWidth / ((grid.firstElementChild as HTMLElement)?.offsetWidth || 200))) : 1;
    const move = (d: number) => {
      const n = this.opts.length;
      if (!n) return;
      let c = this.cursor;
      for (let i = 0; i < n; i++) {
        c = (c + d + n) % n;
        if (this.opts[c].enabled) break;
      }
      this.cursor = c;
      uiSound('cursor');
      this.paint();
    };
    if (k === 'arrowdown' || (!typing && k === 's')) move(grid ? cols : 1);
    else if (k === 'arrowup' || (!typing && k === 'w')) move(grid ? -cols : -1);
    else if (grid && (k === 'arrowright' || k === 'd')) move(1);
    else if (grid && (k === 'arrowleft' || k === 'a')) move(-1);
    else if (k === 'enter' || (!typing && (k === 'e' || k === ' '))) {
      const o = this.opts[this.cursor];
      if (!o?.enabled) return void uiSound('error');
      uiSound('confirm');
      o.run();
    } else if (k === 'escape' || (!typing && k === 'backspace')) {
      if (this.back) {
        uiSound('cancel');
        this.back();
      }
    } else return;
    e.preventDefault();
  }
}
