import { h } from '../../ui';
import { confirmBox, enter, heading, icon, mark, quantity, RowList, statLine, tabStrip, uiSound, type Mark, type RowItem, type UiAction } from '../../ui/kit';
import { allItems } from '../bridge';
import type { ShopOffer } from '../data';
import { OrbView, WeaponView, type MenuView } from '../menu3d';
import type { Equip, Loadout } from '../state';
import { describeSkill, materiaColor, sprite, STATS, type MenuCtx, type MenuScreen } from './common';

type Cat = ShopOffer['kind'] | 'sell';
const CATS: { cat: Cat; label: string }[] = [
  { cat: 'item', label: 'Items' },
  { cat: 'weapon', label: 'Weapons' },
  { cat: 'costume', label: 'Outfits' },
  { cat: 'memoria', label: 'Memoria' },
  { cat: 'materia', label: 'Materia' },
  { cat: 'sell', label: 'Sell' },
];

interface Row {
  item: RowItem;
  name: string;
  icon: string | null | undefined;
  text: string;
  /** Gil each (buying: the price, selling: what the shop pays). */
  each: number;
  /** How many can be bought / sold at once (1 for gear; 0 when not possible now). */
  max: number;
  offer?: ShopOffer;
  sell?: { kind: 'item' | 'material' | 'crystal'; id: number };
  locked?: boolean;
  owned?: boolean;
}

/** A rough "is it better" score for the who-can-equip marks. */
function score(lo: Loadout | null, weapon: boolean) {
  if (!lo) return 0;
  const s = lo.stats;
  return weapon ? s.patk + s.matk : s.hp / 10 + s.patk + s.matk + s.pdef + s.mdef + s.heal;
}

/**
 * The Shop, laid out like the Remake's: the list with Gil and Owned columns and the running total on the left;
 * the highlighted offer (3D weapon / materia, description, stats) and who in the party can equip it on the right.
 * Items and materia ask how many (quantity picker); gear asks to confirm.
 */
export class ShopScreen implements MenuScreen {
  readonly title = 'Shop';
  readonly root = h('div', { class: 'gmr-shop' });
  private mode = h('div', { class: 'gmr-shop__mode' });
  private tabs = tabStrip(
    CATS.map((c) => c.label),
    0,
    (i) => this.setCat(i),
  );
  private list = new RowList([]);
  private total = h('div', { class: 'gmr-shop__total' });
  private detail = h('div', { class: 'gmr-shop__detail rm-panel' });
  private who = h('div', { class: 'gmr-who rm-panel' });
  private viewEl = h('div', { class: 'gmr-shop__view' });
  private rows: Row[] = [];
  private cat: Cat = 'item';
  private qty: ReturnType<typeof quantity> | null = null;
  private view: MenuView | null = null;
  private viewKey = '';
  private live = false;

  constructor(private ctx: MenuCtx) {
    this.root.append(
      h(
        'div',
        { class: 'gmr-shop__left rm-panel' },
        this.mode,
        this.tabs.root,
        h('div', { class: 'gmr-cols-head gmr-shop__cols' }, h('span', {}, 'Item'), h('span', {}, 'Gil'), h('span', {}, 'Owned')),
        h('div', { class: 'gmr-scroll rm-scroll' }, this.list.root),
        this.total,
      ),
      h('div', { class: 'gmr-shop__right' }, this.detail, this.who),
    );
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.onPick(i);
    this.render();
  }

  private get game() {
    return this.ctx.game;
  }

  private skillName(k: string | null | undefined) {
    return k ? (this.ctx.battle?.skills[k]?.name ?? k) : '—';
  }

  private setCat(i: number) {
    this.cat = CATS[i].cat;
    this.qty = null;
    this.list.index = 0;
    this.render();
    void enter(this.list.root, 'fade');
    this.ctx.updateHints();
  }

  private preview(charId: number, change: (e: Equip) => void): Loadout | null {
    const e = this.game.equip(charId);
    const saved = JSON.stringify(e);
    change(e);
    const lo = this.game.loadout(charId);
    Object.assign(e, JSON.parse(saved));
    return lo;
  }

  // ------------------------------------------------------------------ rows
  private build(): Row[] {
    const g = this.game;
    const gil = g.d.gil;
    if (this.cat === 'sell') return this.sellRows();
    const party = this.ctx.party();
    const stock = this.cat === 'weapon' || this.cat === 'costume' ? party.flatMap((id) => g.shopStock(this.cat as ShopOffer['kind'], id)) : g.shopStock(this.cat as ShopOffer['kind']);
    return stock.map(({ offer: o, locked, owned }) => {
      const info = this.info(o);
      const stack = o.kind === 'item' || o.kind === 'materia';
      const have = o.kind === 'item' ? g.itemCount(o.id) : o.kind === 'materia' ? g.d.materia.filter((x) => x.id === o.id).length : owned ? 1 : 0;
      const room = o.kind === 'item' ? 99 - (g.d.items[String(o.id)] ?? 0) : 99;
      const max = locked || owned ? 0 : stack ? Math.max(0, Math.min(room, Math.floor(gil / o.price))) : gil >= o.price ? 1 : 0;
      const price = owned ? 'Owned' : locked ? `Lv ${o.level}` : o.price.toLocaleString('en-US');
      return {
        item: {
          label: info.name,
          disabled: locked || owned,
          value: h('span', { class: 'gmr-shop__vals' }, h('span', { class: !locked && !owned && gil < o.price ? 'rm-delta--down' : '' }, price), h('span', {}, g.d.sandbox && o.kind === 'item' ? '∞' : String(have))),
        },
        name: info.name,
        icon: info.icon,
        text: info.text,
        each: o.price,
        max,
        offer: o,
        locked,
        owned,
      };
    });
  }

  private info(o: ShopOffer): { name: string; icon: string | null | undefined; text: string } {
    const g = this.game;
    switch (o.kind) {
      case 'item': {
        const it = allItems(g).find((i) => i.id === o.id);
        return { name: it?.name ?? String(o.id), icon: it?.icon, text: (it?.help ?? '').replace(/\s+/g, ' ') };
      }
      case 'weapon': {
        const w = g.def(o.char ?? 0)?.weapons.find((x) => x.id === o.id);
        return { name: w?.name ?? String(o.id), icon: g.char(o.char ?? 0)?.weapons[String(o.id)]?.icon, text: `${g.char(o.char ?? 0)?.name ?? ''}'s weapon. C.Ability: ${this.skillName(w?.ability)}.` };
      }
      case 'costume': {
        const c = g.char(o.char ?? 0)?.outfits.find((x) => x.id === o.id);
        return { name: c?.name ?? String(o.id), icon: c?.icon, text: c?.passives.map((p) => p.desc || p.name).join(' · ') || `${g.char(o.char ?? 0)?.name ?? ''}'s outfit.` };
      }
      case 'memoria': {
        const m = g.menu?.memoria.find((x) => x.id === o.id);
        return { name: m?.name ?? String(o.id), icon: m?.icon, text: (m?.help ?? '').replace(/\s+/g, ' ') };
      }
      case 'materia': {
        const m = g.menu?.materia.find((x) => x.id === o.id);
        const spells = m?.spells.map((s) => this.ctx.battle?.index.spells.find((x) => x.id === s)?.name ?? s) ?? [];
        return { name: m?.name ?? String(o.id), icon: m?.icon, text: spells.length ? `Allows you to cast ${spells.join(' and ')}.` : 'Raises stats while equipped.' };
      }
    }
  }

  private sellRows(): Row[] {
    const g = this.game;
    const names = new Map<number, string>();
    const m = g.menu;
    for (const list of [...Object.values(m?.treasures ?? {}), ...Object.values(m?.battles ?? {}).map((b) => b.rewards), ...Object.values(m?.episodes ?? {})])
      for (const r of list) if (r.kind === 'material' && r.name) names.set(r.id, r.name);
    const out: Row[] = [];
    const add = (kind: 'item' | 'material' | 'crystal', id: number, name: string, ico: string | null | undefined, text: string) => {
      const each = g.sellPrice(kind, id);
      const n = g.holdings(kind, id);
      if (each <= 0 || n <= 0) return;
      out.push({
        item: { label: name, value: h('span', { class: 'gmr-shop__vals' }, h('span', {}, each.toLocaleString('en-US')), h('span', {}, n.toLocaleString('en-US'))) },
        name,
        icon: ico,
        text,
        each,
        max: n,
        sell: { kind, id },
      });
    };
    if (g.d.crystals > 0) add('crystal', 0, 'Blue Crystal', m?.icons.crystal, 'Raises materia levels. Keep some for Upgrade Materia.');
    for (const id of Object.keys(g.d.materials)) add('material', Number(id), names.get(Number(id)) ?? `Material ${id}`, null, 'A crafting material.');
    for (const it of allItems(g)) if (g.d.items[String(it.id)]) add('item', it.id, it.name, it.icon, it.help.replace(/\s+/g, ' '));
    return out;
  }

  private render() {
    const selling = this.cat === 'sell';
    this.mode.replaceChildren(h('div', { class: 'gmr-shop__verb' }, selling ? 'Selling' : 'Buying'), h('div', { class: 'gmr-shop__sub' }, 'Item Shop'));
    this.rows = this.build();
    const keep = this.list.index;
    this.list.setItems(this.rows.map((r) => r.item));
    if (this.rows.length) this.list.select(Math.min(keep, this.rows.length - 1), false);
    else this.list.root.replaceChildren(h('div', { class: 'gmr-empty' }, selling ? 'Nothing to sell yet: crystals and materials come from treasure boxes, battles and story clears.' : 'Nothing for sale here.'));
    this.onSelect(this.list.index);
  }

  private renderTotal() {
    const r = this.rows[this.list.index];
    const n = this.qty?.value ?? 0;
    const sum = r ? n * r.each : 0;
    this.total.replaceChildren(
      this.qty ? h('span', { class: 'gmr-shop__qty' }, h('span', { class: 'rm-label' }, 'Quantity'), this.qty.root) : h('span', { class: 'rm-label' }, 'Total'),
      h('span', { class: 'gmr-shop__sum' }, h('span', { class: 'rm-num rm-num--big' }, sum.toLocaleString('en-US')), ' G'),
    );
  }

  // ------------------------------------------------------------------ detail + who can equip
  private onSelect(i: number) {
    const r = this.rows[i];
    this.renderTotal();
    if (!r) {
      this.detail.replaceChildren();
      this.who.replaceChildren();
      this.setView(null);
      return;
    }
    this.ctx.setHelp(this.cat === 'sell' ? 'Sell items.' : r.locked ? `Sold once the party reaches Lv ${r.offer?.level}.` : r.owned ? 'You already own this.' : 'Purchase item.');
    const g = this.game;
    const o = r.offer;
    const kids: (Node | null)[] = [h('div', { class: 'gmr-detail__head' }, sprite(r.icon, o?.kind === 'materia' ? 'materia' : 'item', 'gmr-detail__icon'), h('div', { class: 'gmr-detail__name' }, r.name))];
    let view: { key: string; make: () => MenuView } | null = null;
    if (o?.kind === 'weapon') {
      const w = g.def(o.char ?? 0)?.weapons.find((x) => x.id === o.id);
      const lo = this.preview(o.char ?? 0, (x) => (x.weapon = o.id));
      kids.push(h('div', { class: 'gmr-eq-stats' }, icon('attack'), String(lo?.stats.patk ?? '—'), icon('magic-attack'), String(lo?.stats.matk ?? '—')));
      kids.push(h('div', { class: 'gmr-detail__text' }, r.text), h('div', { class: 'gmr-detail__text rm-dim' }, describeSkill(w?.ability ? this.ctx.battle?.skills[w.ability] : undefined)));
      if (w?.glb) view = { key: `w:${w.glb}`, make: () => new WeaponView(this.viewEl, w.glb!) };
    } else if (o?.kind === 'materia') {
      const m = g.menu?.materia.find((x) => x.id === o.id);
      kids.push(h('div', { class: 'gmr-detail__text' }, r.text), ...Object.entries(m?.stats ?? {}).map(([k, v]) => statLine(STATS.find((s) => s.key === k)?.icon ?? 'plus', STATS.find((s) => s.key === k)?.label ?? k, `+${v}`)));
      if (m) view = { key: `m:${materiaColor(m)}`, make: () => new OrbView(this.viewEl, materiaColor(m)) };
    } else kids.push(h('div', { class: 'gmr-detail__text' }, r.text));
    kids.push(this.viewEl);
    this.detail.replaceChildren(...kids.filter((x): x is Node => !!x));
    // no 3D model (items, outfits, memoria): the sprite, large
    this.viewEl.replaceChildren(...(view ? [] : [sprite(r.icon, 'item', 'gmr-shop__art')]));
    this.setView(view);
    this.renderWho(r);
  }

  /** The party, each with ✓ (can equip), ↑ / ↓ (better / worse than now) or – (cannot). */
  private renderWho(r: Row) {
    const o = r.offer;
    const g = this.game;
    if (!o || o.kind === 'item') {
      this.who.replaceChildren(heading('Owned'), h('div', { class: 'gmr-who__owned rm-num rm-num--big' }, r.sell ? String(r.max) : String(g.itemCount(o?.id ?? 0))));
      return;
    }
    const markFor = (id: number): Mark => {
      if (o.kind === 'materia') return 'check';
      if ((o.kind === 'weapon' || o.kind === 'costume') && o.char !== id) return 'none';
      const change = (x: Equip) => {
        if (o.kind === 'weapon') x.weapon = o.id;
        else if (o.kind === 'costume') x.costume = o.id;
        else if (o.kind === 'memoria') x.memoria = o.id;
      };
      const now = score(g.loadout(id), o.kind === 'weapon');
      const next = score(this.preview(id, change), o.kind === 'weapon');
      return next > now ? 'up' : next < now ? 'down' : 'check';
    };
    this.who.replaceChildren(
      heading('Can Equip'),
      ...this.ctx.party().map((id) => {
        const m = markFor(id);
        return h('div', { class: `gmr-who__row${m === 'none' ? ' rm-dim' : ''}` }, mark(m), h('span', {}, g.char(id)?.name ?? `#${id}`));
      }),
    );
  }

  private setView(v: { key: string; make: () => MenuView } | null) {
    const key = v?.key ?? '';
    if (key === this.viewKey && (this.view || !v)) return;
    this.ctx.stage.remove(this.view);
    this.view = null;
    this.viewKey = key;
    if (v && this.live) this.view = this.ctx.stage.add(v.make());
  }

  // ------------------------------------------------------------------ buying / selling
  private onPick(i: number) {
    const r = this.rows[i];
    if (!r) return;
    // clicking the row again while choosing how many: buy / sell that many
    if (this.qty) return this.deal(r, this.qty.value);
    if (r.max <= 0) {
      uiSound('error');
      this.ctx.setHelp(r.sell ? 'Nothing left to sell.' : this.game.d.gil < r.each ? 'Not enough Gil.' : 'You carry the maximum.');
      return;
    }
    const stack = r.sell || r.offer?.kind === 'item' || r.offer?.kind === 'materia';
    if (!stack) {
      void confirmBox(`Buy ${r.name} for ${r.each.toLocaleString('en-US')} Gil?`, ['Buy', 'Cancel']).then((c) => c === 0 && this.deal(r, 1));
      return;
    }
    this.qty = quantity(1, r.max, 1, () => this.renderTotal());
    this.renderTotal();
    this.ctx.setHelp(`${r.sell ? 'Sell' : 'Buy'} how many? ${r.max} at most.`);
    this.ctx.updateHints();
  }

  private deal(r: Row, n: number) {
    const g = this.game;
    if (r.sell) {
      const gil = g.sell(r.sell.kind, r.sell.id, n);
      if (!gil) return void uiSound('error');
      uiSound('buy');
      this.ctx.host.toast(`Sold ${r.name}${n > 1 ? ` ×${n}` : ''} for ${gil.toLocaleString('en-US')} Gil`);
    } else if (r.offer) {
      const err = g.buy(r.offer, n);
      if (err) {
        uiSound('error');
        return this.ctx.host.toast(err);
      }
      uiSound('buy');
      this.ctx.host.toast(`Bought ${r.name}${n > 1 ? ` ×${n}` : ''}`);
    }
    this.qty = null;
    this.render();
    this.ctx.updateHints();
  }

  hints(): [UiAction, string][] {
    if (this.qty)
      return [
        ['cursorLR', 'Quantity'],
        ['confirm', this.cat === 'sell' ? 'Sell' : 'Buy'],
        ['back', 'Back'],
      ];
    return [
      ['tabPrev', ''],
      ['tabNext', 'Change Category'],
      ['confirm', 'Confirm'],
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    if (this.qty) {
      if (k === 'arrowleft' || k === 'a') this.qty.step(-1);
      else if (k === 'arrowright' || k === 'd') this.qty.step(1);
      else if (k === 'arrowup' || k === 'w') this.qty.step(10);
      else if (k === 'arrowdown' || k === 's') this.qty.step(-10);
      else if (k === 'enter' || k === ' ') {
        const r = this.rows[this.list.index];
        if (r) this.deal(r, this.qty.value);
      } else return false;
      return true;
    }
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else if (k === 'q' || k === 'e') this.tabs.step(k === 'q' ? -1 : 1);
    else return false;
    return true;
  }

  back(): boolean {
    if (!this.qty) return false;
    this.qty = null;
    uiSound('cancel');
    this.renderTotal();
    this.onSelect(this.list.index);
    this.ctx.updateHints();
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
    if (!this.qty) this.render();
  }
}
