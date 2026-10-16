import './menu.css';
import './rmenu.css';
import { battleData, type BattleData } from '../battle/data';
import type { SoundEffects } from '../story/overlay';
import { h } from '../ui';
import { backdrop, enter, exit, footer, frame, preloadUiSounds, stagger, uiPrefs, uiSound } from '../ui/kit';
import { menuGamepad } from './gamepad';
import { MenuStage } from './menu3d';
import { modalOpen } from './modal';
import type { MenuCtx, MenuScreen } from './screens/common';
import { EquipScreen } from './screens/equip';
import { HomeScreen, type HomeCommand } from './screens/home';
import { InventoryScreen } from './screens/inventory';
import { PartyScreen } from './screens/party';
import { SaveScreen } from './screens/save';
import { ShopScreen } from './screens/shop';
import { BattleSettingsScreen, UpgradeScreen } from './screens/upgrade';
import { ExtrasScreen, ManualScreen, SystemScreen } from './screens/system';
import type { GameState } from './state';

export interface MenuHost {
  game: GameState;
  sfx: SoundEffects;
  /** The story episode's party (locked), or null in Free Roam. */
  storyParty(): number[] | null;
  location(): string;
  /** The Settings window over the menu; resolves when it closes. */
  openSettings(): Promise<void>;
  /** Extras: the explorer tools (their panels), with the key each one is bound to. */
  tools(): { id: string; label: string; help: string; key: string }[];
  openTool(id: string): void;
  /** Report a bug (GitHub issue form in a new tab); resolves when the window closes. */
  reportBug(): Promise<unknown>;
  toTitle(): void;
  /** Story flags and battle settings to store with a slot. */
  snapshot(): { flags: unknown; battleSettings: unknown };
  loadSlot(slot: number): void;
  /** Party leader / their gear changed: refresh the walking model. */
  lookChanged(): void;
  toast(msg: string): void;
}

export type MenuTab = 'home' | 'items' | 'equip' | 'materia' | 'shop' | 'party' | 'status' | 'keys' | 'save' | 'config' | 'extras';

/**
 * The main menu, laid out like FF7 Remake's: the frame with its title rail over the nebula, the command list and
 * the party's live 3D portraits, and one full-screen screen per command (src/game/screens). Keys: ↑↓←→ / WASD,
 * Enter / Space confirm, Esc / Backspace / right click back, Q / E (L1 / R1) previous / next tab, Tab closes.
 */
export class GameMenu {
  readonly root = h('div', { class: 'gmr rm', hidden: true });
  private readonly stage = new MenuStage();
  private readonly fr = frame('Main Menu');
  private readonly ft = footer();
  private bd: ReturnType<typeof backdrop> | null = null;
  private stack: MenuScreen[] = [];
  private battle: BattleData | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private unsub: (() => void) | null = null;
  private restorePad: (() => void) | null = null;
  private clock = 0;
  private closing = false;
  /** The home command last picked (Options → Game → Cursor Position: Memory). */
  private lastCommand = 0;
  tab: MenuTab = 'home';
  private readonly ctx: MenuCtx;

  constructor(private readonly host: MenuHost) {
    // the 3D canvas lies over the screens (each view draws only inside its own element's box)
    this.fr.root.append(this.stage.canvas, this.ft.root);
    this.root.append(this.fr.root);
    this.root.addEventListener('contextmenu', (e) => {
      if (!this.open || modalOpen()) return;
      e.preventDefault();
      this.back();
    });
    document.body.append(this.root);
    void battleData()
      .then((d) => (this.battle = d))
      .catch(() => {});
    const menu = this;
    this.ctx = {
      host,
      get game() {
        return host.game;
      },
      get battle() {
        return menu.battle;
      },
      stage: this.stage,
      charId: 1,
      party: () => this.party(),
      roster: () => {
        const party = this.party();
        const all = Object.values(host.game.menu?.characters ?? {}).map((c) => c.id);
        return [...party, ...all.filter((id) => !party.includes(id))];
      },
      setHelp: (t) => this.ft.setHelp(t),
      updateHints: () => this.ft.setHints(this.top?.hints() ?? []),
      push: (s) => this.push(s),
      pop: () => this.pop(),
      close: () => this.hide(),
    };
  }

  get open() {
    return !this.root.hidden && !this.closing;
  }

  private get game() {
    return this.host.game;
  }

  private get top(): MenuScreen | undefined {
    return this.stack[this.stack.length - 1];
  }

  private party() {
    return this.host.storyParty() ?? this.game.d.party;
  }

  show(tab: MenuTab = 'home') {
    if (!this.open) {
      this.closing = false;
      this.root.hidden = false;
      window.addEventListener('keydown', this.keyHandler, true);
      this.unsub = this.game.onChange(() => this.onGameChange());
      this.restorePad?.();
      this.restorePad = menuGamepad();
      this.bd?.dispose();
      this.bd = backdrop({ hex: true });
      this.bd.root.classList.add('gmr-backdrop');
      this.root.prepend(this.bd.root);
      this.stage.start();
      this.clock = window.setInterval(() => this.ft.setTime(this.game.playTime()), 1000);
      preloadUiSounds();
      uiSound('open');
      void enter(this.root, 'fade');
    }
    const party = this.party();
    if (!party.includes(this.ctx.charId)) this.ctx.charId = party[0] ?? 1;
    this.go(tab);
  }

  hide() {
    if (!this.open) return;
    this.closing = true;
    window.removeEventListener('keydown', this.keyHandler, true);
    this.unsub?.();
    this.unsub = null;
    this.restorePad?.();
    this.restorePad = null;
    clearInterval(this.clock);
    uiSound('close');
    this.game.save();
    void exit(this.root, 'fade').then(() => {
      if (!this.closing) return; // reopened meanwhile
      this.teardown();
    });
  }

  /** Remove everything at once (no exit animation): a tool from Extras opens over the field. */
  private teardown() {
    this.closing = false;
    this.root.hidden = true;
    for (const s of this.stack) s.hidden?.();
    this.stack = [];
    this.stage.stop();
    this.stage.clear();
    this.bd?.dispose();
    this.bd?.root.remove();
    this.bd = null;
  }

  toggle(tab?: MenuTab) {
    if (this.open) this.hide();
    else this.show(tab);
  }

  // ------------------------------------------------------------------ navigation
  private go(tab: MenuTab) {
    this.tab = tab;
    for (const s of this.stack) s.hidden?.();
    this.stack = [];
    this.fr.body.replaceChildren();
    const home = new HomeScreen(this.ctx, (c) => this.command(c), uiPrefs.p.cursor === 'forget' ? 0 : this.lastCommand);
    this.attach(home, 'fade');
    void stagger(home.list.rowEls, 'left', 30, 80);
    const map: Partial<Record<MenuTab, () => MenuScreen>> = {
      items: () => new InventoryScreen(this.ctx, 0),
      keys: () => new InventoryScreen(this.ctx, 2),
      equip: () => new EquipScreen(this.ctx),
      materia: () => new EquipScreen(this.ctx, 'materia'),
      status: () => new EquipScreen(this.ctx),
      shop: () => new ShopScreen(this.ctx),
      party: () => new PartyScreen(this.ctx),
      save: () => new SaveScreen(this.ctx),
      config: () => new SystemScreen(this.ctx, (id) => this.openTool(id)),
      extras: () => new ExtrasScreen(this.ctx, (id) => this.openTool(id)),
    };
    const make = map[tab];
    if (make) this.push(make());
    this.ft.setGil(this.game.d.gil);
    this.ft.setTime(this.game.playTime());
  }

  private command(c: HomeCommand) {
    this.lastCommand = c.index;
    const s: Record<HomeCommand['id'], () => MenuScreen> = {
      equip: () => new EquipScreen(this.ctx),
      upgrade: () => new UpgradeScreen(this.ctx),
      battle: () => new BattleSettingsScreen(this.ctx),
      items: () => new InventoryScreen(this.ctx, 0),
      party: () => new PartyScreen(this.ctx),
      shop: () => new ShopScreen(this.ctx),
      save: () => new SaveScreen(this.ctx),
      manual: () => new ManualScreen(this.ctx),
      system: () => new SystemScreen(this.ctx, (id) => this.openTool(id)),
    };
    this.push(s[c.id]());
  }

  private attach(s: MenuScreen, how: 'fade' | 'left' | 'right') {
    this.stack.push(s);
    // the home lineup's name plates and level boxes lie over the portraits: there the 3D goes under the content
    this.root.classList.toggle('gmr--3d-under', s instanceof HomeScreen);
    this.fr.body.append(s.root);
    this.fr.setTitle(s.title);
    void enter(s.root, how);
    void enter(this.fr.rail, 'fade');
    s.shown?.();
    this.ctx.updateHints();
  }

  private push(s: MenuScreen) {
    const prev = this.top;
    if (prev) {
      prev.hidden?.();
      prev.root.remove();
    }
    this.attach(s, 'right');
  }

  private pop() {
    if (this.stack.length <= 1) return this.hide();
    const s = this.stack.pop()!;
    s.hidden?.();
    s.root.remove();
    const top = this.stack.pop()!;
    uiSound('cancel');
    top.refresh?.();
    this.attach(top, 'left');
  }

  private back() {
    const top = this.top;
    if (top?.back?.()) return;
    if (this.stack.length > 1) return this.pop();
    this.hide();
  }

  private openTool(id: string) {
    window.removeEventListener('keydown', this.keyHandler, true);
    this.unsub?.();
    this.unsub = null;
    this.restorePad?.();
    this.restorePad = null;
    clearInterval(this.clock);
    this.game.save();
    this.teardown();
    this.host.openTool(id);
  }

  private onGameChange() {
    this.ft.setGil(this.game.d.gil);
    this.top?.refresh?.();
  }

  // ------------------------------------------------------------------ keys
  private onKey(e: KeyboardEvent) {
    if (!this.open || modalOpen()) return;
    const k = e.key.toLowerCase();
    const t = e.target as HTMLElement;
    const typing = t?.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox';
    if (typing && k !== 'escape' && k !== 'arrowup' && k !== 'arrowdown' && k !== 'enter') return;
    e.stopImmediatePropagation();
    if (k === 'tab') {
      e.preventDefault();
      return this.hide();
    }
    if (k === 'escape' || (!typing && k === 'backspace')) {
      e.preventDefault();
      return this.back();
    }
    if (this.top?.key(k, e)) e.preventDefault();
  }
}
