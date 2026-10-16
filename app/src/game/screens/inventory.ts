import { h } from '../../ui';
import { bar, enter, heading, RowList, tabStrip, uiSound, type RowItem, type UiAction } from '../../ui/kit';
import { allItems, itemUse } from '../bridge';
import { SE, type InstantItem } from '../data';
import { countText, sprite, type MenuCtx, type MenuScreen } from './common';

interface Entry {
  item: RowItem;
  icon: string | null | undefined;
  name: string;
  text: string;
  count?: string;
  use?: InstantItem;
}

const TABS = ['Items', 'Materials', 'Key Items'];

/** Inventory: items (use them on the party), materials and key items, with a detail panel on the right. */
export class InventoryScreen implements MenuScreen {
  readonly title = 'Inventory';
  readonly root = h('div', { class: 'gmr-inv' });
  private tabs = tabStrip(TABS, 0, (i) => this.setTab(i));
  private list = new RowList([]);
  private detail = h('div', { class: 'gmr-detail rm-panel' });
  private entries: Entry[] = [];
  /** Using an item: the party target list. */
  private using: InstantItem | null = null;
  private targets = new RowList([]);

  constructor(
    private ctx: MenuCtx,
    private tab = 0,
  ) {
    this.tabs.set(tab);
    this.root.append(
      h('div', { class: 'gmr-inv__left rm-panel' }, this.tabs.root, h('div', { class: 'gmr-cols-head' }, h('span', {}, 'Name'), h('span', {}, 'Owned')), h('div', { class: 'gmr-scroll rm-scroll' }, this.list.root)),
      this.detail,
    );
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.onPick(i);
    this.targets.onPick = (i) => this.useOn(i);
    this.render();
  }

  private get game() {
    return this.ctx.game;
  }

  private setTab(i: number) {
    this.tab = i;
    this.using = null;
    this.list.index = 0;
    this.render();
    void enter(this.list.root, 'fade');
    this.ctx.updateHints();
  }

  private materialNames() {
    const names = new Map<number, string>();
    const m = this.game.menu;
    for (const list of [...Object.values(m?.treasures ?? {}), ...Object.values(m?.battles ?? {}).map((b) => b.rewards), ...Object.values(m?.episodes ?? {})])
      for (const r of list) if (r.kind === 'material' && r.name) names.set(r.id, r.name);
    return names;
  }

  private build(): Entry[] {
    const g = this.game;
    if (this.tab === 0) {
      return allItems(g)
        .filter((it) => g.itemCount(it.id) > 0)
        .map((it) => {
          const u = itemUse(it);
          return {
            item: { label: it.name, value: countText(g, g.itemCount(it.id)), disabled: !u.usable.field },
            icon: it.icon,
            name: it.name,
            text: `${it.help.replace(/\s+/g, ' ')}${u.usable.field ? '' : '\nCan only be used in battle.'}`,
            use: it,
          };
        });
    }
    if (this.tab === 1) {
      const names = this.materialNames();
      const out: Entry[] = [];
      if (g.d.crystals > 0)
        out.push({ item: { label: 'Blue Crystal', value: g.d.crystals.toLocaleString('en-US') }, icon: g.menu?.icons.crystal, name: 'Blue Crystal', text: 'Raises materia levels (Upgrade Materia). The Shop also buys them.' });
      for (const [id, n] of Object.entries(g.d.materials)) {
        const name = names.get(Number(id)) ?? `Material ${id}`;
        const each = g.sellPrice('material', Number(id));
        out.push({ item: { label: name, value: String(n) }, icon: null, name, text: each ? `A crafting material. The Shop buys it for ${each.toLocaleString('en-US')} Gil each.` : 'A crafting material.' });
      }
      return out;
    }
    const menu = g.menu;
    const owned = new Set(g.keyItems());
    const out: Entry[] = [];
    if (menu?.dungeonKey) out.push({ item: { label: menu.dungeonKey.name, icon: 'key', value: countText(g, g.d.dungeonKeys) }, icon: menu.dungeonKey.icon, name: menu.dungeonKey.name, text: menu.dungeonKey.help });
    for (const k of menu?.keyItems ?? []) if (owned.has(k.id)) out.push({ item: { label: k.name, icon: 'key-item' }, icon: k.icon, name: k.name, text: k.help });
    const cleared = new Set(g.d.cleared.chapters);
    for (const line of menu?.story ?? [])
      for (const c of line.chapters)
        if (cleared.has(c.id)) out.push({ item: { label: c.name ?? `Chapter ${c.order}`, icon: 'star' }, icon: line.logo, name: c.name ?? `Chapter ${c.order}`, text: `${line.family}: chapter ${c.order} cleared.` });
    return out;
  }

  private render() {
    this.entries = this.build();
    const keep = this.list.index;
    this.list.setItems(this.entries.map((e) => e.item));
    if (this.entries.length) this.list.select(Math.min(keep, this.entries.length - 1), false);
    else {
      const empty = ['No items. Open treasure boxes and win battles to find some.', 'No materials yet: treasure boxes, battles and story clears give them.', 'No key items yet.'][this.tab];
      this.list.root.replaceChildren(h('div', { class: 'gmr-empty' }, empty));
    }
    this.onSelect(this.list.index);
  }

  private onSelect(i: number) {
    const e = this.entries[i];
    if (!e) {
      this.detail.replaceChildren();
      this.ctx.setHelp('');
      return;
    }
    this.ctx.setHelp(e.text.split('\n')[0]);
    const kids: Node[] = [h('div', { class: 'gmr-detail__head' }, sprite(e.icon, this.tab === 2 ? 'key-item' : 'item', 'gmr-detail__icon'), h('div', { class: 'gmr-detail__name' }, e.name)), h('div', { class: 'gmr-detail__text' }, e.text)];
    if (e.use) kids.push(heading(this.using ? `Use ${this.using.name} on` : 'Party'), this.partyList(!!this.using));
    this.detail.replaceChildren(...kids);
  }

  /** The party with HP / MP; a target list while an item is being used. */
  private partyList(pick: boolean) {
    const g = this.game;
    const party = this.ctx.party();
    const rows: RowItem[] = party.map((id) => {
      const lo = g.loadout(id);
      const [hp, mp] = g.vitals(id);
      return {
        label: g.char(id)?.name ?? `#${id}`,
        value: h(
          'span',
          { class: 'gmr-vitals' },
          h('span', { class: 'rm-label' }, 'HP'),
          h('span', { class: 'rm-num' }, hp <= 0 ? 'KO' : String(Math.round((lo?.stats.hp ?? 0) * hp))),
          bar('hp', hp).root,
          h('span', { class: 'rm-label' }, 'MP'),
          h('span', { class: 'rm-num' }, String(Math.round((lo?.stats.mp ?? 0) * mp))),
          bar('mp', mp).root,
        ),
      };
    });
    const keep = this.targets.index;
    this.targets.setItems(rows);
    this.targets.root.classList.toggle('gmr-passive', !pick);
    if (pick) this.targets.select(Math.min(keep, rows.length - 1), false);
    else this.targets.rowEls.forEach((r) => r.classList.remove('is-selected'));
    return this.targets.root;
  }

  private onPick(i: number) {
    const e = this.entries[i];
    if (!e?.use) return;
    const u = itemUse(e.use);
    if (u.all) return this.use(e.use, this.ctx.party());
    this.using = e.use;
    this.targets.index = 0;
    this.onSelect(i);
    this.ctx.updateHints();
  }

  private useOn(i: number) {
    const id = this.ctx.party()[i];
    if (this.using && id !== undefined) this.use(this.using, [id]);
  }

  private use(it: InstantItem, targets: number[]) {
    const g = this.game;
    const u = itemUse(it);
    const useful = targets.some((id) => {
      const [hp, mp] = g.vitals(id);
      if (u.revive) return hp <= 0;
      if (hp <= 0) return false;
      return (u.hp > 0 && hp < 1) || (u.mp > 0 && mp < 1) || !!u.buff;
    });
    if (!useful) {
      uiSound('error');
      this.ctx.setHelp(u.revive ? 'Nobody needs reviving.' : 'It would have no effect.');
      return;
    }
    if (!g.consumeItem(it.id)) return;
    for (const id of targets) {
      const [hp, mp] = g.vitals(id);
      if (u.revive) {
        if (hp <= 0) g.setVitals(id, 0.3, mp);
        continue;
      }
      if (hp <= 0) continue;
      if (!g.d.carryVitals && (u.hp || u.mp)) continue;
      g.setVitals(id, hp + u.hp, mp + u.mp);
      if (u.buff) g.addBuff(id, u.buff);
    }
    this.ctx.host.sfx.play(SE.item);
    if (g.itemCount(it.id) <= 0) this.using = null;
    this.render();
    this.ctx.setHelp(u.buff ? `${it.name}: active in the next battle.` : `Used ${it.name}.`);
  }

  hints(): [UiAction, string][] {
    if (this.using)
      return [
        ['confirm', 'Use'],
        ['back', 'Back'],
      ];
    return [
      ['tabPrev', ''],
      ['tabNext', 'Category'],
      ...(this.tab === 0 ? ([['confirm', 'Use']] as [UiAction, string][]) : []),
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    const list = this.using ? this.targets : this.list;
    if (k === 'arrowup' || k === 'w') list.move(-1);
    else if (k === 'arrowdown' || k === 's') list.move(1);
    else if (k === 'enter' || k === ' ') list.pick();
    else if (k === 'q' || k === 'e') this.tabs.step(k === 'q' ? -1 : 1);
    else return false;
    return true;
  }

  back(): boolean {
    if (!this.using) return false;
    this.using = null;
    uiSound('cancel');
    this.onSelect(this.list.index);
    this.ctx.updateHints();
    return true;
  }

  refresh() {
    this.render();
  }
}
