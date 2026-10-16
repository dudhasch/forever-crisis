import { openOnlinePanel } from '../../platform/online';
import { h } from '../../ui';
import { confirmBox, enter, glyphEl, keyCap, RowList, tabStrip, uiSound, type RowItem, type UiAction } from '../../ui/kit';
import type { MenuCtx, MenuScreen } from './common';

interface Cmd {
  item: RowItem;
  help: string;
  run: () => void;
}

/** System: Options, Extras, the sandbox switches, online saves, bug reports and the title screen. */
export class SystemScreen implements MenuScreen {
  readonly title = 'System';
  readonly root = h('div', { class: 'gmr-system' });
  private list = new RowList([]);
  private cmds: Cmd[] = [];

  constructor(
    private ctx: MenuCtx,
    private openTool: (id: string) => void,
  ) {
    this.root.append(this.list.root);
    this.list.onSelect = (i) => ctx.setHelp(this.cmds[i]?.help ?? '');
    this.list.onPick = (i) => this.cmds[i]?.run();
    this.render();
  }

  private render() {
    const g = this.ctx.game;
    const host = this.ctx.host;
    const onOff = (v: boolean) => h('span', { class: v ? '' : 'rm-dim' }, v ? 'Enabled' : 'Disabled');
    this.cmds = [
      { item: { label: 'Options' }, help: 'Change game settings.', run: () => void host.openSettings() },
      { item: { label: 'Extras' }, help: 'Tools for exploring the archive: maps, characters, weapons, music, story, battles.', run: () => this.ctx.push(new ExtrasScreen(this.ctx, this.openTool)) },
      {
        item: { label: 'Sandbox', value: onOff(g.d.sandbox) },
        help: 'Unlock every weapon, outfit, memoria, materia and summon, with 99 of each item that are never used up.',
        run: () => {
          g.d.sandbox = !g.d.sandbox;
          g.changed();
          uiSound('toggle');
          host.toast(g.d.sandbox ? 'Sandbox on: everything unlocked' : 'Sandbox off: your own inventory');
          host.lookChanged();
          this.render();
        },
      },
      {
        item: { label: 'Carry HP / MP Between Battles', value: onOff(g.d.carryVitals) },
        help: 'Like FF7: damage stays until you heal. Disabled: every battle starts at full health.',
        run: () => {
          g.d.carryVitals = !g.d.carryVitals;
          g.changed();
          uiSound('toggle');
          this.render();
        },
      },
      {
        item: { label: 'Online' },
        help: 'Cloud saves, privacy and game files.',
        run: () => {
          this.ctx.close();
          void openOnlinePanel();
        },
      },
      { item: { label: 'Report a Bug' }, help: 'Open a GitHub issue with your version, browser and location filled in.', run: () => void host.reportBug() },
      {
        item: { label: 'Reset Inventory' },
        help: 'Forget items, gil, gear, materia and the party. Story progress stays.',
        run: () =>
          void confirmBox('Forget items, gil, gear, materia and the party?\nStory progress stays.', ['Reset', 'Cancel'], 1).then((c) => {
            if (c !== 0) return;
            g.reset();
            host.lookChanged();
            this.render();
          }),
      },
      {
        item: { label: 'Title Screen' },
        help: 'Return to the title screen. Continue resumes at the start of this story step.',
        run: () =>
          void confirmBox('Return to the title screen?', ['Title Screen', 'Cancel'], 1).then((c) => {
            if (c !== 0) return;
            this.ctx.close();
            host.toTitle();
          }),
      },
    ];
    const keep = this.list.index;
    this.list.setItems(this.cmds.map((c) => c.item));
    this.list.select(keep, false);
    this.ctx.setHelp(this.cmds[this.list.index]?.help ?? '');
  }

  hints(): [UiAction, string][] {
    return [
      ['confirm', 'Select'],
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
    this.ctx.setHelp(this.cmds[this.list.index]?.help ?? '');
  }

  refresh() {
    this.render();
  }
}

/** Extras: the explorer's tool panels (each opens over the field; Esc comes back here). */
export class ExtrasScreen implements MenuScreen {
  readonly title = 'Extras';
  readonly root = h('div', { class: 'gmr-system' });
  private list = new RowList([]);

  constructor(
    private ctx: MenuCtx,
    private openTool: (id: string) => void,
  ) {
    const tools = ctx.host.tools();
    const rows = [...tools.map((t) => ({ item: { label: t.label, value: t.key ? keyCap(t.key) : undefined }, help: t.help, run: () => openTool(t.id) })), { item: { label: 'Report a Bug' }, help: 'Open a GitHub issue with your version, browser and location filled in.', run: () => void ctx.host.reportBug() }];
    this.list.setItems(rows.map((r) => r.item));
    this.list.onSelect = (i) => ctx.setHelp(rows[i]?.help ?? '');
    this.list.onPick = (i) => rows[i]?.run();
    this.root.append(this.list.root);
    this.tools = tools;
  }

  private tools: { id: string; key: string }[];

  hints(): [UiAction, string][] {
    return [
      ['confirm', 'Open'],
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    if (k === 'arrowup' || k === 'w') this.list.move(-1);
    else if (k === 'arrowdown' || k === 's') this.list.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else {
      // a tool's own key opens it from here too
      const t = this.tools.find((x) => x.key.toLowerCase() === k);
      if (!t) return false;
      uiSound('confirm');
      this.openTool(t.id);
    }
    return true;
  }

  shown() {
    this.list.select(this.list.index, false);
    this.ctx.setHelp(this.ctx.host.tools()[this.list.index]?.help ?? '');
  }
}

const MANUAL: { tab: string; rows: [UiAction, string][] }[] = [
  {
    tab: 'Field',
    rows: [
      ['move', 'Walk (hold Run to run)'],
      ['run', 'Run'],
      ['interact', 'Talk, open, examine; advance a scene'],
      ['camera', 'Change camera (fixed, orbit, first person)'],
      ['rotate', 'Rotate the view'],
      ['menu', 'Main menu'],
      ['pause', 'Pause a scene or movie (skip it from there)'],
    ],
  },
  {
    tab: 'Battle',
    rows: [
      ['attack', 'Attack the locked-on enemy (when the ATB gauge is full)'],
      ['commands', 'Commands: Abilities, Magic, Items, Summon, Limit'],
      ['guard', 'Guard: spends the gauge, halves damage until it fills again'],
      ['shortcuts', 'Hold for the shortcut palette (set them in Battle Settings)'],
      ['target', 'Switch the locked-on enemy'],
      ['next', 'Next ready character'],
      ['escape', 'Hold both to escape'],
      ['pause', 'Pause'],
    ],
  },
  {
    tab: 'Menus',
    rows: [
      ['cursor', 'Move the cursor'],
      ['confirm', 'Confirm'],
      ['back', 'Back (right click too)'],
      ['tabPrev', 'Previous tab or character'],
      ['tabNext', 'Next tab or character'],
      ['alt', 'Remove / make leader, where shown'],
      ['menu', 'Close the menu'],
    ],
  },
];

/** Manual: the controls of the field, battles and menus, with the glyphs of the device in use. */
export class ManualScreen implements MenuScreen {
  readonly title = 'Manual';
  readonly root = h('div', { class: 'gmr-manual rm-panel' });
  private tabs = tabStrip(
    MANUAL.map((m) => m.tab),
    0,
    (i) => this.render(i),
  );
  private body = h('div', { class: 'gmr-manual__rows' });

  constructor(private ctx: MenuCtx) {
    this.root.append(this.tabs.root, this.body);
    this.render(0);
  }

  private render(i: number) {
    this.body.replaceChildren(...MANUAL[i].rows.map(([a, text]) => h('div', { class: 'gmr-manual__row' }, h('span', { class: 'gmr-manual__glyph' }, glyphEl(a)), h('span', {}, text))));
    void enter(this.body, 'fade');
    this.ctx.setHelp(['Exploring the field.', 'Battles keep FF7’s ATB: one gauge per character, act when it is full.', 'Every menu works with keyboard, mouse and gamepad.'][i]);
  }

  hints(): [UiAction, string][] {
    return [
      ['tabPrev', ''],
      ['tabNext', 'Category'],
      ['back', 'Back'],
    ];
  }

  key(k: string): boolean {
    if (k === 'q' || k === 'e' || k === 'arrowleft' || k === 'arrowright') this.tabs.step(k === 'q' || k === 'arrowleft' ? -1 : 1);
    else return false;
    return true;
  }

  shown() {
    this.render(this.tabs.index);
  }
}
