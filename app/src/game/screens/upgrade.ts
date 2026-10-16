import { mpCost } from '../../battle/rules';
import { h } from '../../ui';
import { enter, glyphEl, heading, icon, orb, RowList, statLine, switcher, uiSound, type RowItem, type UiAction } from '../../ui/kit';
import { OrbView } from '../menu3d';
import { MATERIA_MAX_LEVEL, materiaStat } from '../state';
import { describeSkill, materiaColor, STATS, type MenuCtx, type MenuScreen } from './common';

/** Upgrade Materia: spend Blue Crystals to raise a materia (EC's ten levels); the orb turns on the right. */
export class UpgradeScreen implements MenuScreen {
  readonly title = 'Upgrade Materia';
  readonly root = h('div', { class: 'gmr-upgrade' });
  private list = new RowList([]);
  private detail = h('div', { class: 'gmr-detail rm-panel' });
  private viewEl = h('div', { class: 'gmr-upgrade__view' });
  private uids: number[] = [];
  private view: OrbView | null = null;
  private live = false;

  constructor(private ctx: MenuCtx) {
    this.root.append(h('div', { class: 'gmr-inv__left rm-panel' }, h('div', { class: 'gmr-cols-head' }, h('span', {}, 'Materia'), h('span', {}, 'Level')), h('div', { class: 'gmr-scroll rm-scroll' }, this.list.root)), this.detail);
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.upgrade(i);
    this.render();
  }

  private get game() {
    return this.ctx.game;
  }

  private render() {
    const g = this.game;
    const owned = g.d.materia.filter((x) => g.materiaDef(x.uid));
    this.uids = owned.map((x) => x.uid);
    const keep = this.list.index;
    this.list.setItems(
      owned.map((x) => {
        const m = g.materiaDef(x.uid)!;
        const holder = g.materiaHolder(x.uid);
        return { label: m.name, value: h('span', { class: 'gmr-orbval' }, holder !== null ? h('span', { class: 'rm-dim' }, `${g.char(holder)?.name ?? ''}  `) : null, `Lv ${g.materiaLevel(x.uid)}`, orb(materiaColor(m))) };
      }),
    );
    if (owned.length) this.list.select(Math.min(keep, owned.length - 1), false);
    else this.list.root.replaceChildren(h('div', { class: 'gmr-empty' }, 'No materia yet. Treasure boxes, first wins in battle and the Shop give some.'));
    this.onSelect(this.list.index);
  }

  private onSelect(i: number) {
    const g = this.game;
    const uid = this.uids[i];
    const m = g.materiaDef(uid ?? null);
    if (uid === undefined || !m) {
      this.detail.replaceChildren(heading('Blue Crystals', g.d.crystals.toLocaleString('en-US')));
      return;
    }
    const lv = g.materiaLevel(uid);
    const cost = g.materiaUpgradeCost(lv);
    this.detail.replaceChildren(
      h('div', { class: 'gmr-detail__head' }, orb(materiaColor(m)), h('div', { class: 'gmr-detail__name' }, m.name)),
      h('div', { class: 'gmr-upgrade__lv' }, h('span', { class: 'rm-label' }, 'Level'), h('span', { class: 'rm-num rm-num--big' }, String(lv)), cost !== null ? [icon('chevron-right'), h('span', { class: 'rm-num rm-num--big rm-delta--up' }, String(lv + 1))] : h('span', { class: 'rm-dim' }, ' MAX')),
      this.viewEl,
      heading('Stats'),
      ...Object.entries(m.stats).map(([k, v]) => {
        const st = STATS.find((s) => s.key === k);
        const now = materiaStat(v, lv);
        const next = cost !== null ? materiaStat(v, lv + 1) : now;
        return statLine(st?.icon ?? 'plus', st?.label ?? k, next, next - now);
      }),
      heading('Cost', `Blue Crystals ${g.d.crystals.toLocaleString('en-US')}`),
      h('div', { class: cost !== null && g.d.crystals < cost ? 'rm-delta--down' : '' }, cost === null ? (lv >= MATERIA_MAX_LEVEL ? 'Mastered.' : 'Sandbox copies cannot be raised.') : `${cost.toLocaleString('en-US')} Blue Crystals`),
    );
    this.ctx.setHelp(cost === null ? 'This materia cannot be raised further.' : `Raise ${m.name} to Lv ${lv + 1}.`);
    this.ctx.stage.remove(this.view);
    this.view = this.live ? this.ctx.stage.add(new OrbView(this.viewEl, materiaColor(m))) : null;
  }

  private upgrade(i: number) {
    const g = this.game;
    const uid = this.uids[i];
    if (uid === undefined) return;
    const err = g.upgradeMateria(uid);
    if (err) {
      uiSound('error');
      this.ctx.setHelp(err);
      return;
    }
    uiSound('equip');
    this.ctx.host.toast(`${g.materiaDef(uid)?.name} is now Lv ${g.materiaLevel(uid)}`);
    this.render();
  }

  hints(): [UiAction, string][] {
    return [
      ['confirm', 'Upgrade'],
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else return false;
    return true;
  }

  shown() {
    this.live = true;
    this.onSelect(this.list.index);
  }

  hidden() {
    this.live = false;
    this.ctx.stage.remove(this.view);
    this.view = null;
  }

  refresh() {
    this.render();
  }
}

const SLOTS = 4;

/** Battle Settings: each character's four shortcut abilities (the battle's L1 / Shift palette). */
export class BattleSettingsScreen implements MenuScreen {
  readonly title = 'Battle Settings';
  readonly root = h('div', { class: 'gmr-bset' });
  private sw = switcher('', (d) => this.switchChar(d));
  private list = new RowList([]);
  private head = h('div');
  private detail = h('div', { class: 'gmr-detail rm-panel' });
  private picking: number | null = null;
  private choices: string[] = [];

  constructor(private ctx: MenuCtx) {
    this.root.append(h('div', { class: 'gmr-inv__left rm-panel' }, this.sw.root, this.head, h('div', { class: 'gmr-scroll rm-scroll' }, this.list.root)), this.detail);
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.onPick(i);
    this.render();
  }

  private get game() {
    return this.ctx.game;
  }

  private skill(k: string | null | undefined) {
    return k ? this.ctx.battle?.skills[k] : undefined;
  }

  /** What the battle offers for shortcuts: the C.Abilities, then the spells from materia (as battle.ts does). */
  private options(): string[] {
    const g = this.game;
    const lo = g.loadout(this.ctx.charId);
    const def = g.def(this.ctx.charId);
    const b = this.ctx.battle;
    if (!lo || !b) return [];
    const out = lo.abilities.filter((k) => b.skills[k]?.action);
    for (const sp of b.index.spells) {
      if (!lo.spells.includes(sp.id)) continue;
      const key = def?.spells[sp.id] ?? sp.skill;
      if (b.skills[key] && !out.includes(key)) out.push(key);
    }
    return out;
  }

  /** The saved shortcuts, or what the battle would pick (the first four). */
  private current(): (string | null)[] {
    const opts = this.options();
    const valid = new Set(opts);
    const saved = this.game.shortcuts(this.ctx.charId) ?? opts.slice(0, SLOTS);
    return Array.from({ length: SLOTS }, (_, i) => (saved[i] && valid.has(saved[i]!) ? saved[i]! : null));
  }

  private render() {
    this.sw.set(this.game.char(this.ctx.charId)?.name ?? '');
    const keep = this.list.index;
    if (this.picking === null) {
      const cur = this.current();
      this.head.replaceChildren(heading('Shortcuts', 'Hold L1 / Shift in battle'));
      const items: RowItem[] = cur.map((k, i) => {
        const s = this.skill(k);
        return { label: s?.name ?? '(empty)', value: h('span', { class: 'gmr-orbval' }, s ? `${mpCost(s)} MP  ` : '', glyphEl(`slot${i + 1}` as UiAction)) };
      });
      items.push({ label: 'ATB mode and battle speed…', icon: 'clock' });
      this.list.setItems(items);
    } else {
      this.choices = this.options();
      this.head.replaceChildren(heading(`Shortcut ${this.picking + 1}`, `${this.choices.length}`));
      this.list.setItems([{ label: '(empty)', icon: 'minus' }, ...this.choices.map((k) => ({ label: this.skill(k)?.name ?? k, value: `${mpCost(this.skill(k))} MP` }))]);
      void enter(this.list.root, 'right');
    }
    this.list.select(Math.min(keep, 99), false);
    this.onSelect(this.list.index);
  }

  private onSelect(i: number) {
    const k = this.picking === null ? this.current()[i] : i === 0 ? null : this.choices[i - 1];
    if (this.picking === null && i === SLOTS) {
      this.ctx.setHelp('Open Options → Game for the ATB mode, battle speed and Streamlined Progression.');
      this.detail.replaceChildren(heading('Options'), h('div', { class: 'gmr-detail__text' }, 'ATB mode (Active, Slow, Wait), battle speed, random encounters and Streamlined Progression are in Options → Game.'));
      return;
    }
    const s = this.skill(k);
    this.ctx.setHelp(this.picking === null ? 'Choose the shortcut to change.' : 'Choose an ability or spell.');
    this.detail.replaceChildren(
      heading(this.picking === null ? `Shortcut ${i + 1}` : 'Ability'),
      h('div', { class: 'gmr-detail__name' }, s?.name ?? '(empty)'),
      h('div', { class: 'gmr-detail__text' }, describeSkill(s) || 'Nothing on this shortcut.'),
    );
  }

  private onPick(i: number) {
    if (this.picking === null) {
      if (i === SLOTS) return void this.ctx.host.openSettings();
      this.picking = i;
      this.list.index = 0;
      return this.render();
    }
    const keys = this.current();
    const key = i === 0 ? null : this.choices[i - 1];
    // a skill sits on one shortcut: it leaves the one it had, which gets this slot's old skill
    const was = key ? keys.indexOf(key) : -1;
    if (was >= 0) keys[was] = keys[this.picking];
    keys[this.picking] = key;
    this.game.setShortcuts(this.ctx.charId, keys);
    uiSound('equip');
    const slot = this.picking;
    this.picking = null;
    this.list.index = slot;
    this.render();
  }

  private switchChar(d: number) {
    const all = this.ctx.roster();
    const i = all.indexOf(this.ctx.charId);
    this.ctx.charId = all[(i + d + all.length) % all.length];
    this.picking = null;
    uiSound('tab');
    this.render();
  }

  hints(): [UiAction, string][] {
    return this.picking === null
      ? [
          ['tabPrev', ''],
          ['tabNext', 'Character'],
          ['confirm', 'Select'],
          ['back', 'Back'],
        ]
      : [
          ['confirm', 'Set'],
          ['back', 'Back'],
        ];
  }

  key(k: string): boolean {
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else if (k === 'q' || k === 'e' || ((k === 'arrowleft' || k === 'arrowright') && this.picking === null)) this.switchChar(k === 'q' || k === 'arrowleft' ? -1 : 1);
    else return false;
    return true;
  }

  back(): boolean {
    if (this.picking === null) return false;
    this.list.index = this.picking;
    this.picking = null;
    uiSound('cancel');
    this.render();
    this.ctx.updateHints();
    return true;
  }

  refresh() {
    this.render();
  }
}
