/**
 * ?ui-kit: every piece of the Remake-style UI kit on one screen, for review. Not part of the game (index.html
 * loads this instead of main.ts when the URL has ?ui-kit).
 */
import { startGamepad } from '../game/gamepad';
import { h } from '../ui';
import { ICON_ATLAS, GLYPH_ATLAS, MATERIA_ATLAS, type GlyphName, type IconName, type MateriaColor } from './atlas';
import {
  backdrop,
  banner,
  bar,
  confirmBox,
  dropdown,
  enter,
  footer,
  frame,
  glyphDevice,
  glyphEl,
  glyphImg,
  heading,
  icon,
  keyCap,
  mark,
  NotifyFeed,
  onGlyphChange,
  optionRow,
  orb,
  preloadUiSounds,
  quantity,
  RowList,
  slider,
  stagger,
  statLine,
  switcher,
  tabStrip,
  uiPrefs,
  uiSound,
  type UiAction,
} from './kit';
import type { GlyphPref, MotionPref } from './prefs';

document.title = 'UI kit · FF7 Forever Crisis';
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
for (const id of ['scene', 'splash']) document.getElementById(id)?.remove();
const host = document.getElementById('ui') ?? document.body;
host.style.cssText = 'position:fixed;inset:0;';

const bd = backdrop({ grid: true });
const fr = frame('UI Kit');
host.append(bd.root, fr.root);

const css = document.createElement('style');
css.textContent = `
.kd { position:absolute; inset:0; display:grid; grid-template-columns: calc(600*var(--u)) 1fr; gap: calc(30*var(--u)); padding: calc(10*var(--u)) calc(30*var(--u)) 0 calc(10*var(--u)); }
.kd-right { overflow-y:auto; padding: calc(20*var(--u)) calc(24*var(--u)) calc(70*var(--u)); display:flex; flex-wrap:wrap; gap: calc(40*var(--u)) calc(44*var(--u)); align-content:flex-start; }
.kd-sec { display:flex; flex-direction:column; gap: calc(12*var(--u)); }
.kd-h { font-size: var(--rm-fs-small); color: var(--rm-label); letter-spacing:.06em; text-transform:uppercase; }
.kd-grid { display:grid; gap: calc(10*var(--u)); }
.kd-cell { display:flex; flex-direction:column; align-items:center; gap: calc(3*var(--u)); font-size: calc(11*var(--u)); color: var(--rm-text-dim); width: calc(64*var(--u)); text-align:center; }
.kd-cell .rm-icon { font-size: calc(30*var(--u)); color: #fff; }
.kd-cell .rm-glyph { font-size: calc(30*var(--u)); }
.kd-cell .rm-glyphs { font-size: calc(24*var(--u)); min-height: calc(34*var(--u)); }
.kd-cell .rm-glyphs .rm-glyph { font-size: 1em; }
.kd-cell .rm-orb { font-size: calc(40*var(--u)); }
.kd-btns { display:flex; gap: calc(8*var(--u)); flex-wrap:wrap; }
.kd-btn { font: inherit; font-size: var(--rm-fs-small); color: var(--rm-text); background: rgba(10,40,90,.6); border: 1px solid rgba(120,220,255,.45); padding: calc(4*var(--u)) calc(12*var(--u)); cursor:pointer; }
.kd-btn.on { background: rgba(40,130,235,.75); box-shadow: var(--rm-glow); }
.kd-party { display:flex; gap: calc(26*var(--u)); }
.kd-card { width: calc(250*var(--u)); display:flex; flex-direction:column; gap: calc(6*var(--u)); }
.kd-card .rm-bar { margin-bottom: calc(4*var(--u)); }
.kd-line { display:flex; justify-content:space-between; align-items:baseline; }
.kd-disc { position:relative; width: calc(300*var(--u)); height: calc(170*var(--u)); display:flex; align-items:center; justify-content:center; }
.kd-disc .rm-disc { position:absolute; width: calc(300*var(--u)); }
.kd-disc .rm-icon { position:relative; font-size: calc(90*var(--u)); color:#e9f6ff; transform: translateY(calc(-30*var(--u))) rotate(-20deg); filter: drop-shadow(0 0 calc(10*var(--u)) rgba(120,220,255,.8)); }
`;
document.head.append(css);

// --- left column: the main menu list (↑↓ / mouse, Enter picks with the sweep, Esc = cancel sound) ---------------
const MENU = ['Materia & Equipment', 'Upgrade Weapons', 'Battle Settings', 'Inventory', 'Party', 'Shop', 'Save / Load', 'Manual', 'System'];
const HELP = [
  'Change equipment or set materia.',
  'Strengthen weapons and learn their abilities.',
  'Set battle speed, ATB mode and shortcuts.',
  'Use items and look at key items.',
  'Choose who fights at the front.',
  'Buy and sell items and gear.',
  'Save or load your progress.',
  'How to play.',
  'Options, extras and the title screen.',
];
const list = new RowList(MENU.map((label, i) => ({ label, disabled: i === 1 })));
const left = h('div', { class: 'kd-sec' }, list.root);

// --- right column: one section per kit element ---------------------------------------------------------------------
const sec = (title: string, ...kids: (Node | null)[]) => h('section', { class: 'kd-sec' }, h('div', { class: 'kd-h' }, title), ...kids);
const right = h('div', { class: 'kd-right rm-scroll' });

// party cards: vertical names, level, HP / MP / ATB / Limit gauges
const party = h('div', { class: 'kd-party' });
const gauges: ReturnType<typeof bar>[] = [];
for (const [first, last, hp, mx, mp] of [
  ['Cloud', 'Strife', 1840, 2210, 84],
  ['Tifa', 'Lockhart', 512, 1980, 80],
  ['Aerith', 'Gainsborough', 160, 1720, 131],
] as const) {
  const g = { hp: bar('hp', hp / mx), mp: bar('mp', 0.8), atb: bar('atb', 0.4), limit: bar('limit', 0.7) };
  gauges.push(g.hp, g.atb, g.limit);
  party.append(
    h(
      'div',
      { class: 'rm-panel kd-card' },
      h('div', { class: 'kd-line' }, h('span', { class: 'rm-label' }, 'Level'), h('span', { class: 'rm-num rm-num--big' }, '24')),
      h('div', { class: 'kd-line' }, h('span', {}, `${first} `, h('span', { class: 'rm-dim' }, last)), first === 'Cloud' ? h('span', { class: 'rm-tag' }, 'Leader') : null),
      h('div', { class: 'kd-line' }, h('span', { class: 'rm-label' }, 'HP'), h('span', { class: 'rm-num' }, String(hp), h('small', {}, `/${mx}`))),
      g.hp.root,
      h('div', { class: 'kd-line' }, h('span', { class: 'rm-label' }, 'MP'), h('span', { class: 'rm-num' }, String(mp))),
      g.mp.root,
      h('div', { class: 'kd-line' }, h('span', { class: 'rm-label' }, 'ATB'), h('span', { class: 'rm-label' }, 'Limit')),
      g.atb.root,
      g.limit.root,
    ),
  );
}
const gaugeBtns = h(
  'div',
  { class: 'kd-btns' },
  h('button', { class: 'kd-btn', onclick: () => gauges.forEach((g) => g.set(Math.random() * 0.6)) }, 'Hit'),
  h('button', { class: 'kd-btn', onclick: () => gauges.forEach((g) => g.set(1)) }, 'Fill'),
);
right.append(sec('Party, gauges (rm-panel, rm-bar)', party, gaugeBtns));

// options rows + dropdown
const dd = dropdown(['Classic', 'Easy', 'Normal'], 0);
dd.root.style.marginLeft = 'calc(330 * var(--u))';
right.append(
  sec(
    'Options (rm-option, rm-dropdown)',
    h(
      'div',
      { class: 'rm-list', style: { width: 'calc(760 * var(--u))' } },
      optionRow('Battle Mode', 'Active'),
      optionRow('Cursor Position', 'Memory'),
      optionRow('Button Glyphs', 'Auto'),
      optionRow('Combat Controls Guide', 'Show'),
    ),
    dd.root,
  ),
);
// show the Button Glyphs row selected
(right.querySelectorAll('.rm-option')[2] as HTMLElement).classList.add('is-selected');

// equipment: stat lines with deltas, materia slots, the disc
const stats = h(
  'div',
  { class: 'rm-panel rm-panel--plain', style: { width: 'calc(380 * var(--u))' } },
  statLine('attack', 'Attack', 355, 12),
  statLine('magic-attack', 'Magic Attack', 252, -4),
  statLine('defense', 'Defense', 116),
  statLine('magic-defense', 'Magic Defense', 115),
  statLine('strength', 'Strength', 109),
  statLine('magic', 'Magic', 103, 6),
  statLine('vitality', 'Vitality', 66),
  statLine('spirit', 'Spirit', 65),
  statLine('luck', 'Luck', 72),
  statLine('speed', 'Speed', 55),
);
const slots = h('div', { class: 'kd-btns', style: { fontSize: 'calc(34 * var(--u))' } }, ...(['green', 'green', 'yellow', 'red', null, 'purple', 'blue'] as (MateriaColor | null)[]).map(orb));
const disc = h('div', { class: 'kd-disc' }, h('div', { class: 'rm-disc' }), icon('sword'));
right.append(sec('Equipment (rm-stat, orbs, rm-disc)', h('div', { class: 'kd-party' }, stats, h('div', { class: 'kd-sec' }, slots, disc))));

// banners + notification feed
const pb = banner('party');
const eb = banner('enemy');
const feed = new NotifyFeed();
const NOTES: [IconName, string, boolean][] = [
  ['defeated', 'Guard Hound defeated.', false],
  ['exp', '436 EXP & 12 AP gained.', false],
  ['materia-up', 'Fire Materia improved!', true],
  ['info', 'Weak to lightning.', false],
];
let note = 0;
right.append(
  sec(
    'Battle HUD (rm-banner, rm-notify)',
    h('div', { style: { display: 'flex', gap: 'calc(20 * var(--u))', minHeight: 'calc(44 * var(--u))' } }, pb.root, eb.root),
    h(
      'div',
      { class: 'kd-btns' },
      h('button', { class: 'kd-btn', onclick: () => void pb.show('Braver') }, 'Party ability'),
      h('button', { class: 'kd-btn', onclick: () => void eb.show('Tail Laser') }, 'Enemy ability'),
      h('button', { class: 'kd-btn', onclick: () => feed.push(...NOTES[note++ % NOTES.length]) }, 'Notification'),
    ),
    h('div', { style: { minHeight: 'calc(160 * var(--u))' } }, feed.root),
  ),
);

// quantity picker
const qty = quantity(1, 99, 3);
right.append(sec('Shop quantity (rm-qty)', qty.root));

// menu screen pieces: headings, category strip, character switcher, who-can-equip marks, slider, confirm popup
const tabs = tabStrip(['Items', 'Weapons', 'Outfits', 'Materia', 'Sell'], 1);
const sw = switcher('Cloud', () => uiSound('tab'));
const sl = slider(0.6, '6', (v) => sl.set(v, String(Math.round(v * 10))));
right.append(
  sec(
    'Menu screens (rm-heading, rm-tabs, rm-switcher, rm-mark, rm-slider, rm-confirm)',
    h('div', { style: { width: 'calc(520 * var(--u))' } }, heading('Attributes', 'Lv 40'), tabs.root, sw.root),
    h('div', { class: 'kd-btns', style: { alignItems: 'center' } }, ...(['check', 'up', 'down', 'none'] as const).map((m) => h('span', { class: 'kd-cell' }, mark(m), m))),
    sl.root,
    h('div', { class: 'kd-btns' }, h('button', { class: 'kd-btn', onclick: () => void confirmBox('Overwrite slot 1?', ['Overwrite', 'Cancel'], 1).then((c) => feed.push('info', `Picked ${c ?? 'nothing'}`)) }, 'Confirm box')),
  ),
);

// icons
const iconGrid = h('div', { class: 'kd-grid', style: { gridTemplateColumns: 'repeat(10, auto)' } });
for (const n of Object.keys(ICON_ATLAS.cells) as IconName[]) iconGrid.append(h('div', { class: 'kd-cell' }, icon(n), n));
right.append(sec('Icons (rm-icon, tinted with color)', iconGrid));

// materia
right.append(
  sec('Materia (rm-orb)', h('div', { class: 'kd-grid', style: { gridTemplateColumns: 'repeat(5, auto)' } }, ...(Object.keys(MATERIA_ATLAS.cells) as MateriaColor[]).map((c) => h('div', { class: 'kd-cell' }, orb(c), c)))),
);

// glyph atlas
const glyphGrid = h('div', { class: 'kd-grid', style: { gridTemplateColumns: 'repeat(8, auto)' } });
for (const n of Object.keys(GLYPH_ATLAS.cells) as GlyphName[]) glyphGrid.append(h('div', { class: 'kd-cell' }, glyphImg(n), n));
right.append(sec('Button glyphs (rm-glyph)', glyphGrid));

// keycaps
right.append(sec('Keyboard keys (rm-key)', h('div', { class: 'kd-btns', style: { fontSize: 'calc(30 * var(--u))' } }, ...['Esc', 'Enter', 'Space', 'Shift', 'Tab', 'W', 'A', 'S', 'D', '↑', '←', 'F5', 'PgDn'].map(keyCap))));

// glyph(action) for the current device + the Glyphs and Reduced motion options
const ACTIONS: UiAction[] = ['confirm', 'back', 'menu', 'pause', 'tabPrev', 'tabNext', 'cursor', 'move', 'interact', 'run', 'attack', 'commands', 'guard', 'shortcuts', 'escape', 'look'];
const actGrid = h('div', { class: 'kd-grid', style: { gridTemplateColumns: 'repeat(8, auto)', fontSize: 'calc(26 * var(--u))' } });
for (const a of ACTIONS) actGrid.append(h('div', { class: 'kd-cell' }, glyphEl(a), a));
const devLabel = h('span', { class: 'rm-dim' });
const showDev = () => (devLabel.textContent = `showing: ${glyphDevice()}`);
onGlyphChange(showDev);
showDev();
const prefBtns = <T extends string>(key: 'glyphs' | 'motion', values: [T, string][]) => {
  const btns = values.map(([v, label]) => {
    const b = h('button', { class: 'kd-btn' }, label);
    b.addEventListener('click', () => {
      uiPrefs.set(key, v as never);
      uiSound('toggle');
      sync();
    });
    return [v, b] as const;
  });
  const sync = () => btns.forEach(([v, b]) => b.classList.toggle('on', uiPrefs.p[key] === v));
  sync();
  return h('div', { class: 'kd-btns' }, ...btns.map(([, b]) => b));
};
right.append(
  sec(
    'glyph(action) · Glyphs option',
    prefBtns<GlyphPref>('glyphs', [
      ['auto', 'Auto'],
      ['ps', 'PlayStation'],
      ['xbox', 'Xbox'],
      ['kb', 'Keyboard'],
    ]),
    devLabel,
    actGrid,
  ),
);
const panelDemo = h('div', { class: 'rm-panel', style: { width: 'calc(300 * var(--u))' } }, 'Panel enter / exit');
right.append(
  sec(
    'Transitions · Reduced motion option',
    prefBtns<MotionPref>('motion', [
      ['auto', 'Auto (OS)'],
      ['reduced', 'Reduced'],
      ['full', 'Full'],
    ]),
    h(
      'div',
      { class: 'kd-btns' },
      ...(['left', 'right', 'up', 'zoom', 'fade'] as const).map((k) => h('button', { class: 'kd-btn', onclick: () => void enter(panelDemo, k) }, k)),
      h('button', { class: 'kd-btn', onclick: () => void stagger(list.rowEls, 'left') }, 'menu rows'),
    ),
    panelDemo,
  ),
);

fr.body.append(h('div', { class: 'kd' }, left, right));

// footer: play time + gil, help, hints, rights line
const ft = footer({
  time: 245_655,
  gil: 500_847,
  help: HELP[0],
  hints: [
    ['confirm', 'Select'],
    ['back', 'Back'],
    ['save', 'Save'],
  ],
});
fr.root.append(ft.root);
let t = 245_655;
setInterval(() => ft.setTime(++t), 1000);
list.onSelect = (i) => ft.setHelp(HELP[i]);
list.onPick = (i) => feed.push('info', `${MENU[i]} picked.`);

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') list.move(1);
  else if (e.key === 'ArrowUp') list.move(-1);
  else if (e.key === 'Enter') list.pick();
  else if (e.key === 'Escape' || e.key === 'Backspace') uiSound('cancel');
  else if (e.key === 'ArrowLeft') qty.step(-1);
  else if (e.key === 'ArrowRight') qty.step(1);
});
startGamepad(); // a pad's buttons arrive as keys, and switch Auto glyphs to the pad
window.addEventListener('pointerdown', () => preloadUiSounds(), { once: true });
window.addEventListener('keydown', () => preloadUiSounds(), { once: true });

void enter(fr.root, 'fade');
void stagger(list.rowEls, 'left', 35, 120);
// expose for checks in the browser console
Object.assign(window, { uiKit: { list, feed, pb, eb, qty, tabs, uiPrefs } });
