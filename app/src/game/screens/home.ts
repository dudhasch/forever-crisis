import { h } from '../../ui';
import { bar, enter, heading, icon, RowList, stagger, type UiAction } from '../../ui/kit';
import { PortraitView } from '../menu3d';
import { splitName, type MenuCtx, type MenuScreen } from './common';

export interface HomeCommand {
  id: 'equip' | 'upgrade' | 'battle' | 'items' | 'party' | 'shop' | 'save' | 'manual' | 'system';
  index: number;
}

const COMMANDS: { id: HomeCommand['id']; label: string; help: string }[] = [
  { id: 'equip', label: 'Materia & Equipment', help: 'Change equipment or set materia.' },
  { id: 'upgrade', label: 'Upgrade Materia', help: 'Raise materia levels with Blue Crystals.' },
  { id: 'battle', label: 'Battle Settings', help: 'Choose the four shortcut abilities of each character.' },
  { id: 'items', label: 'Inventory', help: 'Use items, and look at materials and key items.' },
  { id: 'party', label: 'Party', help: 'Choose who fights and who leads.' },
  { id: 'shop', label: 'Shop', help: 'Buy and sell items, gear and materia.' },
  { id: 'save', label: 'Save / Load', help: 'Save or load your progress.' },
  { id: 'manual', label: 'Manual', help: 'How to play: field, battle and menu controls.' },
  { id: 'system', label: 'System', help: 'Options, extras and the title screen.' },
];

/** The main menu: commands on the left, the party lineup (live 3D portraits) on the right, the objective below. */
export class HomeScreen implements MenuScreen {
  readonly title = 'Main Menu';
  readonly root = h('div', { class: 'gmr-home' });
  readonly list = new RowList(COMMANDS.map((c) => ({ label: c.label })));
  private lineup = h('div', { class: 'gmr-lineup' });
  private objective = h('div', { class: 'gmr-objective rm-plate' });
  private views: PortraitView[] = [];

  constructor(
    private ctx: MenuCtx,
    pick: (c: HomeCommand) => void,
    cursor = 0,
  ) {
    this.list.select(cursor, false);
    this.list.onSelect = (i) => ctx.setHelp(COMMANDS[i].help);
    this.list.onPick = (i) => pick({ id: COMMANDS[i].id, index: i });
    this.root.append(h('div', { class: 'gmr-home__left' }, this.list.root, this.objective), this.lineup);
    this.render();
  }

  private render() {
    const g = this.ctx.game;
    const story = this.ctx.host.storyParty();
    const party = this.ctx.party().slice(0, 3);
    this.lineup.replaceChildren(
      ...party.map((id, i) => {
        const c = g.char(id);
        const lo = g.loadout(id);
        const [hpS, mpS] = g.vitals(id);
        const hp = lo ? Math.round(lo.stats.hp * hpS) : 0;
        const mp = lo ? Math.round(lo.stats.mp * mpS) : 0;
        const { first, last } = splitName(c);
        const leader = story ? i === 0 : id === g.d.leader;
        const card = h(
          'div',
          { class: 'gmr-card', 'data-char': String(id) },
          h('div', { class: 'gmr-card__view' }),
          h('div', { class: 'gmr-card__name' }, leader ? h('span', { class: 'rm-tag' }, 'Leader') : null, h('span', { class: 'rm-vname' }, first, last ? h('small', {}, ` ${last}`) : null)),
          h(
            'div',
            { class: 'gmr-card__stats' },
            h('div', { class: 'gmr-card__level' }, h('span', { class: 'rm-label' }, 'Level'), h('span', { class: 'rm-num rm-num--big' }, String(g.d.level))),
            h('div', { class: 'gmr-card__exp' }, h('span', { class: 'rm-num' }, g.d.exp.toLocaleString('en-US')), h('span', { class: 'rm-label' }, 'EXP')),
            h('div', { class: 'gmr-card__line' }, h('span', { class: 'rm-label' }, 'HP'), h('span', { class: 'rm-num' }, hpS <= 0 ? h('span', { class: 'rm-delta--down' }, 'KO ') : null, String(hp), h('small', {}, `/${lo?.stats.hp ?? 0}`))),
            bar('hp', hpS).root,
            h('div', { class: 'gmr-card__line' }, h('span', { class: 'rm-label' }, 'MP'), h('span', { class: 'rm-num' }, String(mp), h('small', {}, `/${lo?.stats.mp ?? 0}`))),
            bar('mp', mpS).root,
          ),
        );
        card.addEventListener('click', () => {
          this.ctx.charId = id;
          this.list.select(0);
          this.list.pick();
        });
        return card;
      }),
    );
    // the objective, from where the save says the player is
    const p = g.d.position;
    const where = this.ctx.host.location();
    const goal =
      p.mode === 'story' && p.title
        ? [h('div', { class: 'gmr-objective__kicker' }, [p.family, p.chapter].filter(Boolean).join(' · ')), h('div', { class: 'gmr-objective__text' }, p.title)]
        : [h('div', { class: 'gmr-objective__text' }, 'Free Roam: explore as you like. Story chapters start from the title screen.')];
    this.objective.replaceChildren(heading('Objective'), ...goal, h('div', { class: 'gmr-objective__where' }, icon('search'), ' ', where));
  }

  hints(): [UiAction, string][] {
    return [
      ['confirm', 'Select'],
      ['back', 'Close'],
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
    this.ctx.setHelp(COMMANDS[this.list.index].help);
    const g = this.ctx.game;
    const cards = [...this.lineup.querySelectorAll<HTMLElement>('.gmr-card')];
    cards.forEach((card, i) => {
      const id = Number(card.dataset.char);
      const lo = g.loadout(id);
      if (!lo?.model) return;
      // turn the outer two a little towards the middle, like a lineup
      const turn = cards.length === 3 ? [0.28, 0, -0.28][i] : 0;
      this.views.push(this.ctx.stage.add(new PortraitView(card.querySelector('.gmr-card__view')!, lo.model, lo.weapon?.glb ?? null, { span: 0.66, turn })));
    });
    void stagger(cards, 'up', 70, 60);
    void enter(this.objective, 'up', 260);
  }

  hidden() {
    for (const v of this.views) this.ctx.stage.remove(v);
    this.views = [];
  }

  refresh() {
    const live = this.views.length > 0;
    this.hidden();
    this.render();
    if (live) this.shown();
  }
}
