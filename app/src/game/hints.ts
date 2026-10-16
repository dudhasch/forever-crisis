import './screens.css';
import { h } from '../ui';
import { keyLabel, settings, type Action } from './settings';

const IDLE_SECONDS = 4.5;

/**
 * The field's key hints: a small FF7 window bottom-left that lists the current bindings. It fades out after a few
 * seconds without input and comes back on the next key press, click or gamepad input.
 */
export class KeyHints {
  readonly root = h('div', { class: 'kh ff ff-win' });
  private idle = 0;
  private wanted = false;
  private sig = '';

  constructor(parent: HTMLElement) {
    parent.append(this.root);
    const wake = () => (this.idle = 0);
    window.addEventListener('keydown', wake, true);
    window.addEventListener('mousedown', wake, true);
    window.addEventListener('wheel', wake, { capture: true, passive: true });
    window.addEventListener('ff7ec:gamepad', wake);
    settings.onChange(() => (this.sig = ''));
  }

  /** Every frame: `show` = the player is free to walk around (no menu, battle, cutscene or loading). */
  update(dt: number, show: boolean, ctx: { env: boolean; fps: boolean }) {
    this.wanted = show && settings.s.controls.hints;
    if (this.wanted) this.idle += dt;
    const visible = this.wanted && this.idle < IDLE_SECONDS;
    this.root.classList.toggle('kh-off', !visible);
    this.root.classList.toggle('kh-gone', !this.wanted);
    const sig = `${ctx.env}|${ctx.fps}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.render(ctx);
    }
  }

  /** Show again (e.g. right after a map loads). */
  wake() {
    this.idle = 0;
  }

  private render(ctx: { env: boolean; fps: boolean }) {
    const k = (a: Action) => {
      const own = settings.keys(a).filter((x) => !x.startsWith('arrow') && x !== 'enter');
      return own.length ? own[0] : (settings.keys(a)[0] ?? '');
    };
    const keys = (...as: Action[]) => as.map((a) => h('kbd', {}, keyLabel(k(a))));
    const row = (label: string, ...kb: Node[]) => h('div', { class: 'kh-row' }, h('span', { class: 'kh-keys' }, ...kb), h('span', {}, label));
    const rows = [
      row('Move', ...keys('up', 'left', 'down', 'right')),
      row('Run', ...keys('run')),
      row('Talk / check', ...keys('interact')),
      row('Menu', ...keys('menu'), h('kbd', {}, 'Esc')),
      row('Camera', ...keys('camera')),
      ctx.env && !ctx.fps ? row('Rotate view', ...keys('rotL', 'rotR')) : null,
      ctx.fps ? row('Look', h('kbd', {}, 'Mouse')) : null,
      row('Controls', ...keys('help')),
    ];
    this.root.replaceChildren(...rows.filter((r): r is HTMLDivElement => r !== null));
  }
}
