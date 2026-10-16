import { h } from '../../ui';
import { enter, heading, icon, orb, RowList, statLine, switcher, uiSound, type RowItem, type UiAction } from '../../ui/kit';
import { OrbView, PortraitView, WeaponView, type MenuView } from '../menu3d';
import { MATERIA_SLOTS, materiaStat, type Equip, type Loadout } from '../state';
import { describeSkill, ELEMENT_LABEL, materiaColor, sprite, STATS, weaponIcon, type MenuCtx, type MenuScreen } from './common';

type Slot = 'weapon' | 'outfit' | 'memoria' | 'summon' | `m${number}`;

interface Candidate {
  item: RowItem;
  /** What the showcase shows and the panels describe. */
  show: Showcase;
  apply: () => void;
  /** Equip with this change applied, for the stat preview. */
  change: (e: Equip) => void;
}

type Showcase =
  | { kind: 'weapon'; id: number }
  | { kind: 'outfit'; id: number }
  | { kind: 'memoria'; id: number | null }
  | { kind: 'materia'; uid: number | null }
  | { kind: 'summon'; id: number | null };

const MEMORIA_KEYS = ['hp', 'patk', 'matk', 'pdef', 'mdef', 'heal'] as const;

/**
 * Materia & Equipment, like the Remake's: the slots (or the list of what fits one) and the attributes with
 * before / after numbers on the left, the turning weapon (outfit, materia) on its disc in the middle, the ability
 * panel on the right. Q / E (L1 / R1) switch the character.
 */
export class EquipScreen implements MenuScreen {
  readonly title = 'Materia & Equipment';
  readonly root = h('div', { class: 'gmr-equip' });
  private sw = switcher('', (d) => this.switchChar(d));
  private listHead = h('div');
  private list = new RowList([]);
  private attrs = h('div', { class: 'gmr-attrs' });
  private head = h('div', { class: 'gmr-eq-head' });
  private showcase = h('div', { class: 'gmr-showcase' });
  private viewEl = h('div', { class: 'gmr-showcase__view' });
  private flat = h('div', { class: 'gmr-showcase__flat' });
  private side = h('div', { class: 'gmr-eq-side rm-panel' });
  private slots: { slot: Slot; show: Showcase }[] = [];
  private picking: Slot | null = null;
  private cands: Candidate[] = [];
  private view: MenuView | null = null;
  private viewKey = '';
  private live = false;

  constructor(
    private ctx: MenuCtx,
    start: 'equipment' | 'materia' = 'equipment',
  ) {
    this.showcase.append(this.viewEl, this.flat);
    this.root.append(
      h('div', { class: 'gmr-eq-left' }, this.sw.root, this.listHead, h('div', { class: 'gmr-eq-list rm-scroll' }, this.list.root), heading('Attributes'), this.attrs),
      h('div', { class: 'gmr-eq-mid' }, this.head, this.showcase),
      this.side,
    );
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.onPick(i);
    this.render();
    if (start === 'materia') this.list.select(3, false);
  }

  private get game() {
    return this.ctx.game;
  }

  private get id() {
    return this.ctx.charId;
  }

  private skillName(k: string | null | undefined) {
    return k ? (this.ctx.battle?.skills[k]?.name ?? k) : '—';
  }

  private spellName(id: string) {
    return this.ctx.battle?.index.spells.find((s) => s.id === id)?.name ?? id;
  }

  /** The loadout with one change applied (the save is put back right after). */
  private preview(change: (e: Equip) => void): Loadout | null {
    const e = this.game.equip(this.id);
    const saved = JSON.stringify(e);
    change(e);
    const lo = this.game.loadout(this.id);
    Object.assign(e, JSON.parse(saved));
    return lo;
  }

  // ------------------------------------------------------------------ render
  private render() {
    const g = this.game;
    const mc = g.char(this.id);
    this.sw.set(mc?.name ?? `#${this.id}`);
    if (this.picking) return this.renderPick();
    const e = g.equip(this.id);
    const lo = g.loadout(this.id);
    const mem = g.menu?.memoria.find((m) => m.id === e.memoria);
    const summon = g.menu?.summons.find((s) => s.id === e.summon);
    const items: RowItem[] = [
      { label: 'Weapon', icon: weaponIcon(mc), value: lo?.weapon?.name ?? '—' },
      { label: 'Outfit', icon: 'outfit', value: lo?.outfit?.name ?? '—' },
      { label: 'Memoria', icon: 'memoria', value: mem?.name ?? '(none)' },
    ];
    this.slots = [
      { slot: 'weapon', show: { kind: 'weapon', id: e.weapon } },
      { slot: 'outfit', show: { kind: 'outfit', id: e.costume } },
      { slot: 'memoria', show: { kind: 'memoria', id: e.memoria } },
    ];
    for (let i = 0; i < MATERIA_SLOTS; i++) {
      const uid = e.materia[i] ?? null;
      const m = g.materiaDef(uid);
      items.push({ label: `Materia ${i + 1}`, value: h('span', { class: 'gmr-orbval' }, orb(m ? materiaColor(m) : null), m ? `${m.name}  Lv ${g.materiaLevel(uid)}` : '(empty)') });
      this.slots.push({ slot: `m${i}`, show: { kind: 'materia', uid } });
    }
    items.push({ label: 'Summon', value: h('span', { class: 'gmr-orbval' }, orb(summon ? 'red' : null), summon?.name ?? '(empty)') });
    this.slots.push({ slot: 'summon', show: { kind: 'summon', id: e.summon } });
    this.listHead.replaceChildren(heading('Equipment', lo ? `Lv ${g.d.level}` : ''));
    const keep = this.list.index;
    this.list.setItems(items);
    this.list.select(Math.min(keep, items.length - 1), false);
    this.onSelect(this.list.index);
  }

  private renderPick() {
    const g = this.game;
    const id = this.id;
    const def = g.def(id);
    const mc = g.char(id);
    const e = g.equip(id);
    const slot = this.picking!;
    const c: Candidate[] = [];
    const tick = (on: boolean) => (on ? icon('check', 'rm-icon--cyan') : '');
    let title = '';
    if (slot === 'weapon') {
      title = 'Weapon';
      for (const w of def?.weapons.filter((x) => g.ownsWeapon(x.id)) ?? [])
        c.push({ item: { label: w.name, icon: weaponIcon(mc), value: tick(w.id === e.weapon) }, show: { kind: 'weapon', id: w.id }, change: (x) => (x.weapon = w.id), apply: () => g.setWeapon(id, w.id) });
    } else if (slot === 'outfit') {
      title = 'Outfit';
      for (const o of mc?.outfits.filter((x) => g.ownsCostume(x.id)) ?? [])
        c.push({ item: { label: o.name, icon: 'outfit', value: tick(o.id === e.costume) }, show: { kind: 'outfit', id: o.id }, change: (x) => (x.costume = o.id), apply: () => g.setCostume(id, o.id) });
    } else if (slot === 'memoria') {
      title = 'Memoria';
      c.push({ item: { label: '(none)', icon: 'minus', value: tick(e.memoria === null) }, show: { kind: 'memoria', id: null }, change: (x) => (x.memoria = null), apply: () => g.setMemoria(id, null) });
      for (const m of (g.menu?.memoria ?? []).filter((x) => g.ownsMemoria(x.id)))
        c.push({ item: { label: m.name, icon: 'memoria', value: tick(m.id === e.memoria) }, show: { kind: 'memoria', id: m.id }, change: (x) => (x.memoria = m.id), apply: () => g.setMemoria(id, m.id) });
    } else if (slot === 'summon') {
      title = 'Summon Materia';
      c.push({ item: { label: '(remove)', icon: 'minus' }, show: { kind: 'summon', id: null }, change: (x) => (x.summon = null), apply: () => g.setSummon(id, null) });
      for (const s of (g.menu?.summons ?? []).filter((x) => g.ownsSummon(x.id))) {
        const holder = Object.entries(g.d.equip).find(([, x]) => x.summon === s.id)?.[0];
        const on = holder && Number(holder) !== id && !g.d.sandbox ? `on ${g.char(Number(holder))?.name}` : '';
        c.push({ item: { label: s.name, value: h('span', { class: 'gmr-orbval' }, on, orb('red')) }, show: { kind: 'summon', id: s.id }, change: (x) => (x.summon = s.id), apply: () => g.setSummon(id, s.id) });
      }
    } else {
      const i = Number(slot.slice(1));
      title = `Materia ${i + 1}`;
      c.push({ item: { label: '(remove)', icon: 'minus' }, show: { kind: 'materia', uid: null }, change: (x) => (x.materia[i] = null), apply: () => g.setMateria(id, i, null) });
      for (const inst of g.materiaList()) {
        const m = g.materiaDef(inst.uid);
        if (!m) continue;
        const holder = g.materiaHolder(inst.uid);
        const who = holder !== null && holder !== id ? `on ${g.char(holder)?.name ?? holder}  ` : '';
        c.push({
          item: { label: `${m.name}`, value: h('span', { class: 'gmr-orbval' }, who, `Lv ${g.materiaLevel(inst.uid)}`, orb(materiaColor(m))) },
          show: { kind: 'materia', uid: inst.uid },
          change: (x) => (x.materia[i] = inst.uid),
          apply: () => g.setMateria(id, i, inst.uid),
        });
      }
    }
    this.cands = c;
    this.listHead.replaceChildren(heading(title, `${c.length}`));
    this.list.setItems(c.map((x) => x.item));
    // start on what is equipped now
    const cur = c.findIndex((x) => x.item.value instanceof Node && (x.item.value as HTMLElement).classList?.contains('rm-icon'));
    this.list.select(Math.max(0, cur), false);
    this.onSelect(this.list.index);
    void enter(this.list.root, 'right');
  }

  // ------------------------------------------------------------------ selection
  private onSelect(i: number) {
    const g = this.game;
    const now = g.loadout(this.id);
    if (this.picking) {
      const cand = this.cands[i];
      if (!cand) return;
      this.renderAttrs(now, this.preview(cand.change));
      this.describe(cand.show, cand.item.label);
      this.ctx.setHelp(`Select ${this.picking === 'weapon' ? 'a weapon' : this.picking === 'outfit' ? 'an outfit' : this.picking === 'memoria' ? 'a memoria' : 'materia'} to equip.`);
    } else {
      const s = this.slots[i];
      if (!s) return;
      this.renderAttrs(now, null);
      this.describe(s.show, '');
      this.ctx.setHelp(s.slot === 'weapon' ? 'Change weapons.' : s.slot === 'outfit' ? 'Change outfits: their passives add stats and element damage.' : s.slot === 'memoria' ? 'A memoria adds stats that grow with the party level.' : s.slot === 'summon' ? 'The summon materia decides the battle Summon command.' : 'Magic materia add their spells to the battle Magic list.');
    }
    this.ctx.updateHints();
  }

  private onPick(i: number) {
    if (!this.picking) {
      const s = this.slots[i];
      if (!s) return;
      this.picking = s.slot;
      this.renderPick();
      return;
    }
    const cand = this.cands[i];
    if (!cand) return;
    cand.apply();
    uiSound('equip');
    const slot = this.picking;
    this.picking = null;
    if (this.id === this.game.d.leader || this.ctx.party()[0] === this.id) this.ctx.host.lookChanged();
    this.render();
    this.list.select(this.slots.findIndex((s) => s.slot === slot), false);
    this.onSelect(this.list.index);
  }

  // ------------------------------------------------------------------ panels
  private renderAttrs(now: Loadout | null, next: Loadout | null) {
    if (!now) return void this.attrs.replaceChildren(h('div', { class: 'rm-dim' }, 'No battle data for this character.'));
    const [hpS, mpS] = this.game.vitals(this.id);
    this.attrs.replaceChildren(
      h(
        'div',
        { class: 'gmr-attrs__top' },
        h('span', { class: 'rm-label' }, 'Level'),
        h('span', { class: 'rm-num rm-num--big' }, String(this.game.d.level)),
        h('span', { class: 'rm-label' }, 'HP'),
        h('span', { class: 'rm-num' }, String(Math.round(now.stats.hp * hpS)), h('small', {}, `/${now.stats.hp}`)),
        h('span', { class: 'rm-label' }, 'MP'),
        h('span', { class: 'rm-num' }, String(Math.round(now.stats.mp * mpS)), h('small', {}, `/${now.stats.mp}`)),
      ),
      ...STATS.map((s) => {
        const a = now.stats[s.key];
        const b = next ? next.stats[s.key] : a;
        return statLine(s.icon, s.label, b, b - a);
      }),
    );
  }

  /** The centre header and showcase, and the ability panel, for a weapon / outfit / memoria / materia. */
  private describe(s: Showcase, pickLabel: string) {
    const g = this.game;
    const id = this.id;
    const mc = g.char(id);
    const lo = g.loadout(id);
    const e = g.equip(id);
    const tag = h('span', { class: 'rm-tag gmr-tag' }, mc?.name ?? '');
    const orbs = h('div', { class: 'gmr-eq-orbs' }, ...e.materia.slice(0, MATERIA_SLOTS).map((u) => orb(u === null ? null : materiaColor(g.materiaDef(u)))), orb(e.summon !== null ? 'red' : null));
    const side: (Node | null)[] = [];
    let name = pickLabel;
    let desc = '';
    let statsRow: Node | null = null;
    let flat: string | null = null;
    let view: { key: string; make: () => MenuView } | null = null;
    switch (s.kind) {
      case 'weapon': {
        const w = g.def(id)?.weapons.find((x) => x.id === s.id);
        const next = this.preview((x) => (x.weapon = s.id));
        name = w?.name ?? name;
        statsRow = h('div', { class: 'gmr-eq-stats' }, icon('attack'), String(next?.stats.patk ?? '—'), icon('magic-attack'), String(next?.stats.matk ?? '—'), icon('heal'), String(next?.stats.heal ?? '—'));
        const sk = w?.ability ? this.ctx.battle?.skills[w.ability] : undefined;
        desc = w?.ability ? `C.Ability: ${this.skillName(w.ability)}` : '';
        side.push(heading('Ability'), h('div', { class: 'gmr-side__name' }, this.skillName(w?.ability)), h('div', { class: 'gmr-side__text' }, describeSkill(sk) || 'No command ability.'));
        if (w?.glb) view = { key: `w:${w.glb}`, make: () => new WeaponView(this.viewEl, w.glb!) };
        break;
      }
      case 'outfit': {
        const o = mc?.outfits.find((x) => x.id === s.id);
        name = o?.name ?? name;
        desc = o ? `${'★'.repeat(Math.max(1, o.rarity))} outfit` : '';
        side.push(heading('Passives'), ...(o?.passives ?? []).map((p) => h('div', { class: 'gmr-side__item' }, h('div', { class: 'gmr-side__name' }, `${p.name}  Lv ${p.level}`), h('div', { class: 'gmr-side__text' }, p.desc || '—'))));
        if (!o?.passives.length) side.push(h('div', { class: 'gmr-side__text' }, 'No passive skills.'));
        const model = o?.glb ?? lo?.model;
        if (model) view = { key: `o:${model}`, make: () => new PortraitView(this.viewEl, model, lo?.weapon?.glb ?? null, { span: 1.12, lift: 0.02, disc: true }) };
        break;
      }
      case 'memoria': {
        const m = g.menu?.memoria.find((x) => x.id === s.id);
        name = m?.name ?? '(no memoria)';
        desc = m?.help.replace(/\s+/g, ' ') ?? 'A memoria adds stats that grow with the party level.';
        const lv = g.d.level;
        const add = MEMORIA_KEYS.map((k, i) => [k, m ? Math.round(m.stats[i] * 0.1 * (lv / 100)) : 0] as const).filter(([, v]) => v > 0);
        side.push(heading('Bonus'), ...add.map(([k, v]) => statLine(STATS.find((x) => x.key === k)!.icon, STATS.find((x) => x.key === k)!.label, `+${v}`)));
        if (!add.length) side.push(h('div', { class: 'gmr-side__text' }, m ? 'Grows with the party level.' : 'Nothing equipped.'));
        flat = m?.icon ?? null;
        break;
      }
      case 'materia': {
        const m = g.materiaDef(s.uid);
        const lv = g.materiaLevel(s.uid);
        name = m ? m.name : '(empty slot)';
        desc = m ? (m.spells.length ? `Allows you to cast ${m.spells.map((x) => this.spellName(x)).join(' and ')}.` : 'Raises stats while equipped.') : 'Set a materia here.';
        if (m) {
          side.push(
            heading('Materia', `Lv ${lv}`),
            ...m.spells.map((sp, i) => {
              const key = g.def(id)?.spells[sp] ?? this.ctx.battle?.index.spells.find((x) => x.id === sp)?.skill;
              const sk = key ? this.ctx.battle?.skills[key] : undefined;
              return h('div', { class: 'gmr-side__item' }, h('div', { class: 'gmr-side__name' }, `${'★'.repeat(i + 1)} ${this.spellName(sp)}`), h('div', { class: 'gmr-side__text' }, describeSkill(sk)));
            }),
            heading('Stats'),
            ...Object.entries(m.stats).map(([k, v]) => {
              const st = STATS.find((x) => x.key === k);
              return statLine(st?.icon ?? 'plus', st?.label ?? k, `+${materiaStat(v, lv)}`);
            }),
          );
          view = { key: `m:${materiaColor(m)}`, make: () => new OrbView(this.viewEl, materiaColor(m)) };
        } else side.push(heading('Materia'), h('div', { class: 'gmr-side__text' }, 'Empty. Magic materia put their spells in the battle Magic list and raise max MP.'));
        break;
      }
      case 'summon': {
        const sm = g.menu?.summons.find((x) => x.id === s.id);
        name = sm?.name ?? '(no summon)';
        desc = sm ? `Call ${sm.name} with the battle Summon command.` : 'Set a summon materia here.';
        side.push(heading('Summon'), h('div', { class: 'gmr-side__text' }, sm ? `${sm.name} joins the battle Summon list. The summon gauge fills as the battle goes on.` : 'Nothing equipped.'));
        if (sm) view = { key: 'm:red', make: () => new OrbView(this.viewEl, 'red') };
        break;
      }
    }
    // the character's battle kit: magic, limit breaks, element damage
    if (lo) {
      const def = g.def(id);
      const limits = (def?.limits ?? []).filter((_, i) => i === 0 || g.d.level >= 12 + i * 14).map((k) => this.skillName(k));
      const els = Object.entries(lo.elements).map(([el, v]) => `${ELEMENT_LABEL[el] ?? el} +${Math.round(v * 100)}%`);
      side.push(
        heading('In Battle'),
        h('div', { class: 'gmr-side__kv' }, h('span', { class: 'rm-label' }, 'Magic'), h('span', {}, lo.spells.map((x) => this.spellName(x)).join(', ') || '—')),
        h('div', { class: 'gmr-side__kv' }, h('span', { class: 'rm-label' }, 'Limit'), h('span', {}, limits.join(', ') || '—')),
        els.length ? h('div', { class: 'gmr-side__kv' }, h('span', { class: 'rm-label' }, 'Element'), h('span', {}, els.join(', '))) : null,
      );
    }
    this.head.replaceChildren(
      tag,
      h('div', { class: 'gmr-eq-name' }, name),
      ...(statsRow ? [statsRow] : []),
      orbs,
      h('div', { class: 'gmr-eq-desc' }, desc),
    );
    this.side.replaceChildren(...side.filter((x): x is Node => !!x));
    // no 3D for memoria (and empty slots): the kit's CSS disc with the sprite over it
    this.flat.replaceChildren(...(view ? [] : [h('div', { class: 'rm-disc' }), ...(flat ? [sprite(flat, 'memoria', 'gmr-flat')] : [])]));
    this.setView(view);
  }

  private setView(v: { key: string; make: () => MenuView } | null) {
    const key = v?.key ?? '';
    if (key === this.viewKey && (this.view || !v)) return;
    this.ctx.stage.remove(this.view);
    this.view = null;
    this.viewKey = key;
    if (v && this.live) this.view = this.ctx.stage.add(v.make());
  }

  // ------------------------------------------------------------------ input
  private switchChar(d: number) {
    const all = this.ctx.roster();
    const i = all.indexOf(this.id);
    this.ctx.charId = all[(i + d + all.length) % all.length];
    this.picking = null;
    uiSound('tab');
    this.render();
    void enter(this.root.querySelector('.gmr-eq-mid')!, d > 0 ? 'right' : 'left');
  }

  hints(): [UiAction, string][] {
    const s = this.slots[this.list.index];
    return this.picking
      ? [
          ['confirm', 'Equip'],
          ['back', 'Back'],
        ]
      : [
          ['tabPrev', ''],
          ['tabNext', 'Character'],
          ...(s && (s.slot.startsWith('m') || s.slot === 'memoria' || s.slot === 'summon') ? ([['alt', 'Remove']] as [UiAction, string][]) : []),
          ['confirm', 'Select'],
          ['back', 'Back'],
        ];
  }

  key(k: string): boolean {
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else if (k === 'q' || k === 'e' || ((k === 'arrowleft' || k === 'arrowright' || k === 'a' || k === 'd') && !this.picking)) this.switchChar(k === 'q' || k === 'arrowleft' || k === 'a' ? -1 : 1);
    else if (k === 'r' && !this.picking) this.remove();
    else return false;
    return true;
  }

  /** R / X: empty the highlighted materia, memoria or summon slot. */
  private remove() {
    const s = this.slots[this.list.index];
    const g = this.game;
    if (!s) return;
    if (s.slot === 'memoria') g.setMemoria(this.id, null);
    else if (s.slot === 'summon') g.setSummon(this.id, null);
    else if (s.slot.startsWith('m')) g.setMateria(this.id, Number(s.slot.slice(1)), null);
    else return void uiSound('error');
    uiSound('equip');
    this.render();
  }

  back(): boolean {
    if (!this.picking) return false;
    const slot = this.picking;
    this.picking = null;
    uiSound('cancel');
    this.render();
    this.list.select(this.slots.findIndex((s) => s.slot === slot), false);
    this.onSelect(this.list.index);
    return true;
  }

  shown() {
    this.live = true;
    this.viewKey = '';
    this.onSelect(this.list.index);
  }

  hidden() {
    this.live = false;
    this.ctx.stage.remove(this.view);
    this.view = null;
    this.viewKey = '';
  }

  refresh() {
    this.render();
  }
}
