import './battle.css';
import { banner, bar, enter, glyphEl as kitGlyph, icon, motionReduced, NotifyFeed, onGlyphChange, type IconName } from '../ui/kit';
import { kitAction, type BattleAction } from './input';

/**
 * The battle screen in the style of FINAL FANTASY VII Remake / Rebirth, built on the UI kit (src/ui): the ability
 * name banner top centre (blue for the party, red for enemies), the controls guide top left, the target window top
 * right, the notification feed over the party panel, the party panel bottom right, the command list and its button
 * plate bottom left, small HP bars over the enemies and the shortcut palette. The battle itself stays classic FF7
 * ATB (battle.ts).
 */

export interface MenuItem {
  label: string;
  /** Right column: MP cost, item count. */
  right?: string;
  disabled?: boolean;
  /** Shown in the help line while the cursor is on this item. */
  help?: string;
  /** Shortcut slot (0..3) this entry is assigned to. */
  slot?: number;
  /** Costs the full ATB bar (every action does: shown as a pip). */
  atb?: boolean;
}

export interface MenuPanel {
  title: string;
  items: MenuItem[];
  cursor: number;
  columns?: number;
}

export interface CommandView {
  actor: string;
  top: MenuPanel;
  sub?: MenuPanel;
  /** Which panel has the cursor. */
  focus: 'top' | 'sub';
  /** Extra line under the help text, after the glyph of `tipAction` (e.g. how to assign shortcuts). */
  tip?: string;
  tipAction?: BattleAction;
}

export interface PartyRow {
  name: string;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  atb: number;
  limit: number;
  ready: boolean;
  active: boolean;
  dead: boolean;
  guard: boolean;
  statuses: string[];
}

export interface TargetView {
  name: string;
  /** 0..1 */
  hp: number;
  level?: number;
  statuses: string[];
  /** "All enemies" etc. when the skill hits several. */
  count?: number;
  /** A party member (green HP bar). */
  ally?: boolean;
}

export interface EnemyTag {
  x: number;
  y: number;
  name: string;
  hp: number;
  locked: boolean;
}

export interface ShortcutView {
  actor: string;
  ready: boolean;
  slots: ({ label: string; right: string; disabled: boolean } | null)[];
}

export interface Hint {
  action: BattleAction;
  label: string;
  dim?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The kit's button glyph(s) for a battle action; it follows the device and the Glyphs option by itself. */
export function glyphEl(a: BattleAction) {
  return kitGlyph(kitAction(a));
}

type Bar = ReturnType<typeof bar>;

interface PartyEls {
  row: HTMLDivElement;
  name: HTMLElement;
  st: HTMLElement;
  hp: HTMLElement;
  hpMax: HTMLElement;
  mp: HTMLElement;
  bars: { hp: Bar; mp: Bar; atb: Bar; limit: Bar };
}

export class BattleHud {
  readonly root = el('div', 'battle rm');
  private banners = { party: banner('party'), enemy: banner('enemy') };
  private bannerBox = el('div', 'b-banner');
  private feed = new NotifyFeed(5, 3800);
  private lastNote = new Map<string, number>();
  private guide = el('div', 'b-guide rm-hints');
  private guideKey = '';
  private target = el('div', 'b-target rm-plate hidden');
  private targetKey = '';
  private targetBar = bar('enemy');
  private tags = el('div', 'b-tags');
  private tagEls: { root: HTMLDivElement; name: HTMLElement; bar: Bar }[] = [];
  private reticles: HTMLDivElement[] = [];
  private lock = el('div', 'b-lock hidden');
  private partyWin = el('div', 'b-party');
  private partyRows: PartyEls[] = [];
  private cmd = el('div', 'b-cmd hidden');
  private cmdKey = '';
  private hints = el('div', 'b-hints');
  private hintKey = '';
  private shortcuts = el('div', 'b-short rm-panel rm-panel--plain hidden');
  private shortKey = '';
  private helpBar = el('div', 'b-helpbar hidden');
  private numbers = el('div', 'b-numbers');
  private modal = el('div', 'b-modal hidden');
  private flashEl = el('div', 'b-flash');
  private swirl = el('div', 'b-swirl hidden');
  private offGlyphs: () => void;
  /** Click on a command entry: panel 'top' or 'sub', entry index. */
  onMenuClick: ((panel: 'top' | 'sub', index: number) => void) | null = null;
  onMenuHover: ((panel: 'top' | 'sub', index: number) => void) | null = null;
  onModalPick: ((index: number) => void) | null = null;
  /** A button hint was clicked (mouse): the battle does what that button does. */
  onHint: ((action: BattleAction) => void) | null = null;
  /** Glyphs changed (keyboard <-> gamepad, the Glyphs option): the battle re-renders its menus. */
  onModeChange: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    const left = el('div', 'b-left');
    left.append(this.cmd, this.shortcuts, this.hints);
    this.bannerBox.append(this.banners.party.root, this.banners.enemy.root);
    this.feed.root.classList.add('b-feed');
    this.target.append(el('div', 't-head'), this.targetBar.root, el('div', 't-foot'));
    this.root.append(
      this.flashEl,
      this.tags,
      this.lock,
      this.numbers,
      this.guide,
      this.bannerBox,
      this.target,
      this.feed.root,
      this.helpBar,
      left,
      this.partyWin,
      this.modal,
      this.swirl,
    );
    parent.append(this.root);
    parent.classList.add('in-battle');
    this.offGlyphs = onGlyphChange((d) => {
      this.root.dataset.input = d;
      this.cmdKey = this.hintKey = this.shortKey = this.guideKey = '';
      this.onModeChange?.();
    });
  }

  /** The ability name banner top centre (blue for the party, red for an enemy's move); null hides it. */
  showBanner(text: string | null, seconds = 1.6, side: 'party' | 'enemy' = 'party') {
    const other = this.banners[side === 'party' ? 'enemy' : 'party'];
    other.root.hidden = true;
    if (!text) {
      this.banners[side].root.hidden = true;
      return;
    }
    void this.banners[side].show(text, seconds * 1000);
  }

  /** A line in the notification feed ("Guard Hound defeated.", "Obtained Potion"); repeats within 1.5 s are dropped. */
  notify(iconName: IconName, text: string, hi = false) {
    const now = performance.now();
    if (now - (this.lastNote.get(text) ?? -1e9) < 1500) return;
    this.lastNote.set(text, now);
    this.feed.push(iconName, text, hi);
  }

  /** Help line (targeting: what the move does); the command list has its own. */
  setHelp(text: string | null) {
    this.helpBar.textContent = text ?? '';
    this.helpBar.classList.toggle('hidden', !text);
  }

  /** The controls guide top left: the buttons that work any time (Guard, Shortcuts, Switch, Pause, …). */
  showGuide(list: Hint[]) {
    const key = list.map((h) => `${h.action}:${h.label}:${h.dim ? 1 : 0}`).join('|');
    if (key === this.guideKey) return;
    this.guideKey = key;
    this.guide.replaceChildren(...list.map((h) => this.hintEl(h, 'b-guide__row')));
  }

  renderParty(rows: PartyRow[]) {
    if (this.partyRows.length !== rows.length) {
      this.partyWin.replaceChildren();
      this.partyRows = rows.map(() => {
        const bars = { hp: bar('hp'), mp: bar('mp'), atb: bar('atb'), limit: bar('limit') };
        const name = el('b', 'p-name');
        const st = el('em', 'p-st');
        const hp = el('span', 'p-num');
        const hpMax = el('small', 'rm-max');
        const mp = el('span', 'p-num');
        const row = el('div', 'p-row') as HTMLDivElement;
        const lbl = (t: string) => el('span', 'p-lbl', t);
        row.append(
          el('span', 'p-ready'),
          el('div', 'p-main', undefined),
          el('div', 'p-side', undefined),
        );
        const main = row.children[1] as HTMLElement;
        const side = row.children[2] as HTMLElement;
        const hpNum = el('span', 'p-hpnum');
        hpNum.append(lbl('HP'), hp, hpMax);
        const head = el('div', 'p-head');
        head.append(name, st, hpNum);
        const gauges = el('div', 'p-gauges');
        gauges.append(bars.atb.root, lbl('ATB'));
        main.append(head, bars.hp.root, gauges);
        const mpNum = el('div', 'p-mpnum');
        mpNum.append(lbl('MP'), mp);
        const lim = el('div', 'p-gauges');
        lim.append(bars.limit.root, lbl('Limit'));
        side.append(mpNum, bars.mp.root, lim);
        this.partyWin.append(row);
        return { row, name, st, hp, hpMax, mp, bars };
      });
    }
    rows.forEach((p, i) => {
      const r = this.partyRows[i];
      r.row.classList.toggle('ready', p.ready);
      r.row.classList.toggle('active', p.active);
      r.row.classList.toggle('dead', p.dead);
      r.row.classList.toggle('guard', p.guard);
      setText(r.name, p.name);
      setText(r.st, [...(p.guard ? ['Guard'] : []), ...p.statuses].join(' · '));
      setText(r.hp, String(p.hp));
      setText(r.hpMax, `/${p.maxHp}`);
      setText(r.mp, String(p.mp));
      r.bars.hp.set(p.maxHp ? p.hp / p.maxHp : 0);
      r.bars.mp.set(p.maxMp ? p.mp / p.maxMp : 0);
      r.bars.atb.set(Math.min(1, p.atb));
      r.bars.limit.set(Math.min(100, p.limit) / 100);
    });
  }

  /** The target window (top right): name and HP of what the cursor or the lock-on points at. */
  renderTarget(t: TargetView | null) {
    const key = t ? `${t.name}|${t.hp.toFixed(3)}|${t.level}|${t.statuses.join()}|${t.count ?? ''}|${t.ally}` : '';
    if (key === this.targetKey) return;
    const was = this.targetKey.split('|')[0];
    this.targetKey = key;
    this.target.classList.toggle('hidden', !t);
    if (!t) return;
    this.target.classList.toggle('ally', !!t.ally);
    const head = el('div', 't-head');
    head.append(icon('diamond', 't-mark'), el('span', 't-name', t.count && t.count > 1 ? `${t.name}  ×${t.count}` : t.name));
    if (t.level) head.append(el('span', 't-lv', `Lv ${t.level}`));
    const foot = el('div', 't-foot');
    foot.append(el('span', 't-st', t.statuses.join(' · ')), el('span', 't-pct rm-num', `${Math.ceil(t.hp * 100)}%`));
    this.target.firstElementChild!.replaceWith(head);
    this.target.lastElementChild!.replaceWith(foot);
    this.targetBar.root.className = `rm-bar rm-bar--${t.ally ? 'hp' : 'enemy'}`;
    this.targetBar.set(Math.max(0, Math.min(1, t.hp)));
    if (t.name !== was) void enter(this.target, 'right');
  }

  /** Enemy names and HP bars over their heads (screen pixels). */
  renderTags(tags: EnemyTag[]) {
    while (this.tagEls.length < tags.length) {
      const root = el('div', 'b-tag') as HTMLDivElement;
      const name = el('span', 'tag-name');
      const b = bar('enemy');
      b.root.classList.add('tag-bar');
      root.append(name, b.root);
      this.tags.append(root);
      this.tagEls.push({ root, name, bar: b });
    }
    this.tagEls.forEach((e, i) => {
      const t = tags[i];
      e.root.classList.toggle('hidden', !t);
      if (!t) return;
      e.root.style.transform = `translate(${Math.round(t.x)}px, ${Math.round(t.y)}px)`;
      e.root.classList.toggle('locked', t.locked);
      setText(e.name, t.name);
      e.bar.set(t.hp);
    });
  }

  /** The lock-on reticle on the current target while nobody is choosing one. */
  lockOn(p: { x: number; y: number } | null) {
    this.lock.classList.toggle('hidden', !p);
    if (p) this.lock.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }

  /** Target cursors over the chosen targets (screen pixels), none when the list is empty. */
  pointAt(points: { x: number; y: number }[]) {
    while (this.reticles.length < points.length) {
      const h = el('div', 'b-reticle') as HTMLDivElement;
      h.innerHTML = '<span class="ret-arrow"></span><span class="ret-ring"></span>';
      this.root.append(h);
      this.reticles.push(h);
    }
    this.reticles.forEach((h, i) => {
      const p = points[i];
      h.classList.toggle('hidden', !p);
      if (p) h.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    });
  }

  /** The command list (top level + sub-list), or null to close it. */
  showCommands(v: CommandView | null) {
    const key = v ? JSON.stringify(v) : '';
    if (key === this.cmdKey) return;
    const opening = !this.cmdKey && !!v;
    this.cmdKey = key;
    this.cmd.classList.toggle('hidden', !v);
    if (!v) return;
    const help = (v.focus === 'sub' ? v.sub : v.top)?.items[(v.focus === 'sub' ? v.sub : v.top)!.cursor]?.help ?? '';
    const helpEl = el('div', 'c-help');
    helpEl.append(el('div', 'c-help-text', help || ' '));
    if (v.tip) {
      const tip = el('div', 'c-tip rm-hint');
      if (v.tipAction) tip.append(glyphEl(v.tipAction));
      tip.append(el('span', '', v.tip));
      helpEl.append(tip);
    }
    const panels = el('div', 'c-panels');
    const top = this.panel(v.top, 'top', v.focus === 'top', v.actor);
    panels.append(top);
    if (v.sub) panels.append(this.panel(v.sub, 'sub', v.focus === 'sub'));
    this.cmd.replaceChildren(panels, helpEl);
    this.cmd.querySelector('.c-item.is-selected')?.scrollIntoView({ block: 'nearest' });
    if (opening) void enter(top, 'left');
  }

  private panel(p: MenuPanel, which: 'top' | 'sub', focused: boolean, actor?: string) {
    const win = el('div', `rm-panel rm-panel--plain c-panel c-${which}${focused ? ' focused' : ''}${(p.columns ?? 1) === 2 ? ' cols2' : ''}`);
    const head = el('div', 'c-title');
    head.append(el('span', '', p.title));
    if (actor) head.append(el('span', 'c-actor', actor));
    win.append(head);
    const list = el('div', 'c-list');
    p.items.forEach((it, i) => {
      const row = el('div', `rm-row c-item${i === p.cursor ? (focused ? ' is-selected' : ' is-hover') : ''}${it.disabled ? ' is-disabled' : ''}`);
      row.append(el('span', 'rm-row__label c-label', it.label));
      const right = el('span', 'c-right');
      if (it.slot !== undefined) right.append(glyphEl(`slot${it.slot + 1}` as BattleAction));
      if (it.right) right.append(el('span', 'c-cost', it.right));
      if (it.atb) right.append(el('span', 'c-atb'));
      row.append(right);
      row.addEventListener('mouseenter', () => this.onMenuHover?.(which, i));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onMenuClick?.(which, i);
      });
      list.append(row);
    });
    win.append(list);
    return win;
  }

  private hintEl(h: Hint, cls: string) {
    const r = el('div', `rm-hint ${cls}${h.dim ? ' dim' : ''}`);
    r.append(glyphEl(h.action), el('span', 'h-label', h.label));
    r.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onHint?.(h.action);
    });
    return r;
  }

  /**
   * The button plate bottom left: `rows` = Remake's stacked plate ([□] Attack / [✕] Commands Menu) under the
   * actor's name, `line` = one row of hints under an open list.
   */
  showHints(title: string | null, hints: Hint[], layout: 'rows' | 'line' = 'rows') {
    const key = `${title}|${layout}|${hints.map((h) => `${h.action}:${h.label}:${h.dim ? 1 : 0}`).join('|')}`;
    if (key === this.hintKey) return;
    this.hintKey = key;
    this.hints.classList.toggle('hidden', !hints.length);
    this.hints.classList.toggle('b-hints--line', layout === 'line');
    const rows = hints.map((h) => this.hintEl(h, 'h-row'));
    this.hints.replaceChildren(...(title && layout === 'rows' ? [el('div', 'h-title', title)] : []), ...rows);
  }

  /** The shortcut palette (four abilities on a diamond), or null. */
  showShortcuts(v: ShortcutView | null) {
    const key = v ? JSON.stringify(v) : '';
    if (key === this.shortKey) return;
    const opening = !this.shortKey && !!v;
    this.shortKey = key;
    this.shortcuts.classList.toggle('hidden', !v);
    if (!v) return;
    const dia = el('div', `s-dia${v.ready ? '' : ' waiting'}`);
    v.slots.forEach((s, i) => {
      const cell = el('div', `s-cell s${i + 1}${!s ? ' empty' : s.disabled ? ' disabled' : ''}`);
      cell.append(glyphEl(`slot${i + 1}` as BattleAction));
      const txt = el('div', 's-txt');
      txt.append(el('span', 's-label', s?.label ?? '—'));
      if (s?.right) txt.append(el('span', 's-cost', s.right));
      cell.append(txt);
      dia.append(cell);
    });
    const head = el('div', 's-head');
    head.append(el('span', '', 'Shortcuts'), el('span', 's-actor', v.ready ? v.actor : `${v.actor} · waiting for ATB`));
    this.shortcuts.replaceChildren(head, dia);
    if (opening) void enter(this.shortcuts, 'zoom');
  }

  /** Floating damage / heal number at a screen point. */
  number(text: string, x: number, y: number, kind: 'damage' | 'heal' | 'miss' | 'mp' | 'crit' | 'info') {
    const n = el('div', `b-num ${kind}`, text);
    n.style.left = `${x}px`;
    n.style.top = `${y}px`;
    this.numbers.append(n);
    setTimeout(() => n.remove(), 1300);
  }

  flash(color = '#fff', ms = 160) {
    // a softer flash with reduced motion
    const peak = motionReduced() ? '0.35' : '0.85';
    this.flashEl.style.background = color;
    this.flashEl.style.transition = 'none';
    this.flashEl.style.opacity = peak;
    requestAnimationFrame(() => {
      this.flashEl.style.transition = `opacity ${ms}ms ease-out`;
      this.flashEl.style.opacity = '0';
    });
  }

  /** The FF7 battle swirl while the stage loads. */
  setSwirl(on: boolean) {
    this.swirl.classList.toggle('hidden', !on);
  }

  /** Victory / Game Over window with buttons; resolves through onModalPick. */
  showModal(html: string | null, buttons: string[] = [], selected = 0) {
    if (html === null) {
      this.modal.classList.add('hidden');
      return;
    }
    const fresh = this.modal.classList.contains('hidden');
    this.modal.classList.remove('hidden');
    this.modal.innerHTML = `<div class="rm-panel b-modal-box">${html}<div class="b-buttons"></div></div>`;
    const box = this.modal.querySelector('.b-buttons')!;
    buttons.forEach((b, i) => {
      const btn = el('button', `rm-row b-btn${i === selected ? ' is-selected' : ''}`, b);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onModalPick?.(i);
      });
      box.append(btn);
    });
    if (fresh) void enter(this.modal.firstElementChild as HTMLElement, 'zoom');
  }

  setHidden(hidden: boolean) {
    this.root.classList.toggle('hidden', hidden);
  }

  dispose() {
    this.offGlyphs();
    this.root.parentElement?.classList.remove('in-battle');
    this.root.remove();
  }
}

function setText(e: Element, t: string) {
  if (e.textContent !== t) e.textContent = t;
}
