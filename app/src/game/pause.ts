import './screens.css';
import type { SoundEffects } from '../story/overlay';
import { h } from '../ui';
import { backdrop, enter, footer, frame, RowList, stagger, uiSound } from '../ui/kit';
import { menuGamepad } from './gamepad';
import { popModal, pushModal } from './modal';

export interface PauseOption {
  label: string;
  run: () => void;
  enabled?: boolean;
  /** Help text for the option (the footer shows it while the option is highlighted). */
  sub?: string;
}

/** The pause menu of battles and cutscenes: the Remake frame over the blurred, paused scene. */
export class PauseMenu {
  readonly root = h('div', { class: 'pz rm', hidden: true });
  private fr = frame('Pause');
  private ft = footer({
    hints: [
      ['confirm', 'Select'],
      ['back', 'Resume'],
    ],
  });
  private list = new RowList([]);
  private note = h('div', { class: 'pz-note' });
  private bd: ReturnType<typeof backdrop> | null = null;
  private opts: PauseOption[] = [];
  private onBack: () => void = () => {};
  private restorePad: (() => void) | null = null;
  private key = (k: string) => this.onKey(k);

  /** `sfx`: kept for the callers; the menu plays the kit's UI sounds. */
  constructor(readonly sfx: SoundEffects) {
    this.fr.body.append(h('div', { class: 'pz-body' }, this.list.root, this.note));
    this.fr.root.append(this.ft.root);
    this.root.append(this.fr.root);
    this.list.onSelect = (i) => this.ft.setHelp(this.opts[i]?.sub ?? '');
    this.list.onPick = (i) => this.opts[i]?.run();
    this.root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.back();
    });
    document.body.append(this.root);
  }

  get open() {
    return !this.root.hidden;
  }

  show(title: string, opts: PauseOption[], onBack: () => void, note = '') {
    this.opts = opts;
    this.onBack = onBack;
    this.fr.setTitle(title);
    this.note.textContent = note;
    this.note.hidden = !note;
    this.list.setItems(opts.map((o) => ({ label: o.label, disabled: o.enabled === false })));
    this.list.select(
      Math.max(
        0,
        opts.findIndex((o) => o.enabled !== false),
      ),
      false,
    );
    this.ft.setHelp(opts[this.list.index]?.sub ?? '');
    if (!this.open) {
      this.root.hidden = false;
      pushModal(this.key);
      this.restorePad = menuGamepad();
      this.bd = backdrop({ scene: true, grid: false });
      this.root.prepend(this.bd.root);
      uiSound('open');
      void enter(this.root, 'fade');
      void stagger(this.list.rowEls, 'left', 30, 60);
    }
  }

  hide() {
    if (!this.open) return;
    popModal(this.key);
    this.restorePad?.();
    this.restorePad = null;
    const bd = this.bd;
    this.bd = null;
    // hidden at once (the game resumes under it); the backdrop's specks stop with it
    this.root.hidden = true;
    bd?.dispose();
    bd?.root.remove();
  }

  private back() {
    uiSound('cancel');
    this.onBack();
  }

  private onKey(k: string) {
    if (k === 'arrowup' || k === 'w') this.move(-1);
    else if (k === 'arrowdown' || k === 's') this.move(1);
    else if (k === 'enter' || k === ' ') this.list.pick();
    else if (k === 'escape' || k === 'backspace') this.back();
  }

  /** Skip options that cannot be picked now. */
  private move(d: number) {
    const n = this.opts.length;
    let c = this.list.index;
    for (let i = 0; i < n; i++) {
      c = (c + d + n) % n;
      if (this.opts[c].enabled !== false) break;
    }
    this.list.select(c);
  }
}

