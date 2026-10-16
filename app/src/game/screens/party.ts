import { h } from '../../ui';
import { heading, icon, RowList, statLine, uiSound, type UiAction } from '../../ui/kit';
import { PortraitView } from '../menu3d';
import { splitName, STATS, type MenuCtx, type MenuScreen } from './common';

/**
 * Party: every character with ✓ for the three who fight; Enter adds / removes, R (□ / X) makes the leader you walk
 * as. During the story the episode decides, so the list is read-only. The highlighted character stands on the right.
 */
export class PartyScreen implements MenuScreen {
  readonly title = 'Party';
  readonly root = h('div', { class: 'gmr-party' });
  private list = new RowList([]);
  private side = h('div', { class: 'gmr-party__side' });
  private viewEl = h('div', { class: 'gmr-party__view' });
  private info = h('div', { class: 'gmr-party__info rm-plate' });
  private ids: number[] = [];
  private view: PortraitView | null = null;
  private live = false;

  constructor(private ctx: MenuCtx) {
    this.side.append(this.viewEl, this.info);
    this.root.append(h('div', { class: 'gmr-party__left rm-panel' }, h('div', { class: 'gmr-party__slots' }), h('div', { class: 'gmr-scroll rm-scroll' }, this.list.root)), this.side);
    this.list.onSelect = (i) => this.onSelect(i);
    this.list.onPick = (i) => this.toggle(i);
    this.render();
  }

  private get game() {
    return this.ctx.game;
  }

  private get story() {
    return this.ctx.host.storyParty();
  }

  private render() {
    const g = this.game;
    const story = this.story;
    const party = story ?? g.d.party;
    this.ids = story ? story : this.ctx.roster();
    const keep = this.list.index;
    this.list.setItems(
      this.ids.map((id) => ({
        label: g.char(id)?.name ?? `#${id}`,
        value: h(
          'span',
          { class: 'gmr-party__val' },
          (story ? id === story[0] : id === g.d.leader) && party.includes(id) ? h('span', { class: 'rm-tag' }, 'Leader') : null,
          party.includes(id) ? icon('check', 'rm-icon--cyan') : null,
        ),
      })),
    );
    this.list.select(Math.min(keep, this.ids.length - 1), false);
    const slots = this.root.querySelector('.gmr-party__slots')!;
    slots.replaceChildren(
      heading(story ? 'Story Party' : 'Party', `${party.length}/3`),
      h('div', { class: 'gmr-party__names' }, ...[0, 1, 2].map((i) => h('span', { class: party[i] ? '' : 'rm-dim' }, party[i] ? (g.char(party[i])?.name ?? '') : '—'))),
      ...(story ? [h('div', { class: 'gmr-note' }, 'The story decides who fights. Pick your own party in Free Roam.')] : []),
    );
    this.onSelect(this.list.index);
  }

  private onSelect(i: number) {
    const id = this.ids[i];
    if (id === undefined) return;
    const g = this.game;
    const lo = g.loadout(id);
    const { first, last } = splitName(g.char(id));
    this.info.replaceChildren(
      h('div', { class: 'gmr-party__name' }, first, last ? h('small', {}, ` ${last}`) : null),
      ...(lo ? STATS.map((s) => statLine(s.icon, s.label, lo.stats[s.key])) : [h('div', { class: 'rm-dim' }, 'No battle data.')]),
    );
    this.ctx.setHelp(this.story ? 'The story decides the party.' : 'Add or remove party members (three at most).');
    this.setView(id);
    this.ctx.updateHints();
  }

  private setView(id: number) {
    this.ctx.stage.remove(this.view);
    this.view = null;
    const lo = this.game.loadout(id);
    if (this.live && lo?.model) this.view = this.ctx.stage.add(new PortraitView(this.viewEl, lo.model, lo.weapon?.glb ?? null, { span: 1.08, lift: 0.02, turn: -0.25 }));
  }

  private toggle(i: number) {
    const g = this.game;
    const id = this.ids[i];
    if (this.story || id === undefined) return void uiSound('error');
    const party = g.d.party;
    let next = party.includes(id) ? party.filter((x) => x !== id) : [...party, id];
    if (next.length > 3) next = next.slice(1);
    if (!next.length) return void uiSound('error');
    g.setParty(next, next.includes(g.d.leader) ? g.d.leader : next[0]);
    this.ctx.host.lookChanged();
    this.render();
  }

  private makeLeader() {
    const g = this.game;
    const id = this.ids[this.list.index];
    if (this.story || id === undefined || !g.d.party.includes(id)) return void uiSound('error');
    g.setParty(g.d.party, id);
    uiSound('confirm');
    this.ctx.host.lookChanged();
    this.render();
  }

  hints(): [UiAction, string][] {
    if (this.story) return [['back', 'Back']];
    return [
      ['alt', 'Make Leader'],
      ['confirm', 'Add / Remove'],
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else if (k === 'r') this.makeLeader();
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
