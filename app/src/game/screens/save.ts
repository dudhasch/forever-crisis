import { h } from '../../ui';
import { confirmBox, formatPlayTime, heading, icon, RowList, uiSound, type UiAction } from '../../ui/kit';
import { saveSummary } from '../title';
import type { MenuCtx, MenuScreen } from './common';

/** Save / Load: the three slots; Enter asks what to do with the highlighted one. */
export class SaveScreen implements MenuScreen {
  readonly title = 'Save / Load';
  readonly root = h('div', { class: 'gmr-save' });
  private list = new RowList([]);

  constructor(private ctx: MenuCtx) {
    this.root.append(
      h(
        'div',
        { class: 'gmr-save__panel' },
        heading('Save Data', 'The game also autosaves: Continue on the title screen resumes the current story step.'),
        this.list.root,
      ),
    );
    this.list.onSelect = (i) => ctx.setHelp(this.ctx.game.slots()[i]?.data ? 'Save over this slot, load it or delete it.' : 'Save your progress here.');
    this.list.onPick = (i) => void this.pick(i);
    this.render();
  }

  private render() {
    const g = this.ctx.game;
    const keep = this.list.index;
    this.list.setItems(
      g.slots().map((s) => {
        const d = s.data;
        const sum = d ? saveSummary(d, g.menu) : null;
        return {
          label: `Slot ${s.slot}`,
          value: sum
            ? h(
                'span',
                { class: 'gmr-save__sum' },
                h('span', { class: 'gmr-save__where' }, sum.where),
                h(
                  'span',
                  { class: 'gmr-save__meta' },
                  icon('clock'),
                  formatPlayTime(d!.playTime),
                  icon('gil'),
                  d!.gil.toLocaleString('en-US'),
                  h('span', { class: 'rm-label' }, ' Lv '),
                  String(d!.level),
                  h('span', { class: 'rm-dim' }, `  ${sum.when}`),
                ),
              )
            : h('span', { class: 'rm-dim' }, 'No data'),
        };
      }),
    );
    this.list.select(Math.min(keep, 99), false);
  }

  private async pick(i: number) {
    const g = this.ctx.game;
    const s = g.slots()[i];
    if (!s) return;
    const opts = s.data ? ['Save', 'Load', 'Delete', 'Cancel'] : ['Save', 'Cancel'];
    const c = await confirmBox(`Slot ${s.slot}`, opts);
    const what = c === null ? 'Cancel' : opts[c];
    if (what === 'Save') {
      if (s.data && (await confirmBox(`Overwrite slot ${s.slot}?`, ['Overwrite', 'Cancel'], 1)) !== 0) return;
      const snap = this.ctx.host.snapshot();
      g.saveSlot(s.slot, snap.flags, snap.battleSettings);
      uiSound('notice');
      this.ctx.setHelp(`Saved to slot ${s.slot}.`);
      this.render();
    } else if (what === 'Load') {
      if ((await confirmBox(`Load slot ${s.slot}?\nProgress since your last save in a slot is replaced.`, ['Load', 'Cancel'], 1)) !== 0) return;
      this.ctx.close();
      this.ctx.host.loadSlot(s.slot);
    } else if (what === 'Delete') {
      if ((await confirmBox(`Delete slot ${s.slot}?`, ['Delete', 'Cancel'], 1)) !== 0) return;
      g.deleteSlot(s.slot);
      uiSound('cancel');
      this.render();
    }
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

  refresh() {
    this.render();
  }
}
