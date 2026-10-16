import type { CharacterVariant, CharactersManifest, DialogueLine, MapDetail, MapEntry, MusicTrack } from './types';

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export interface CharacterGroup {
  name: string;
  kind: 'field' | 'battle';
  variants: CharacterVariant[];
}

/** Accept either grouped or flat manifests from tools/build_manifest.py. */
export function normalizeCharacters(m: CharactersManifest | null): CharacterGroup[] {
  if (!m) return [];
  const out: CharacterGroup[] = [];
  const add = (kind: 'field' | 'battle', list: unknown[]) => {
    const byName = new Map<string, CharacterGroup>();
    for (const item of list as Record<string, unknown>[]) {
      if (Array.isArray(item.variants)) {
        out.push({ name: String(item.name ?? '?'), kind, variants: item.variants as CharacterVariant[] });
      } else if (typeof item.glb === 'string') {
        const v = item as unknown as CharacterVariant;
        const name = String(v.name ?? v.characterId ?? '?');
        let g = byName.get(name);
        if (!g) {
          g = { name, kind, variants: [] };
          byName.set(name, g);
          out.push(g);
        }
        g.variants.push(v);
      }
    }
  };
  add('field', (m.field ?? []) as unknown[]);
  add('battle', (m.battle ?? []) as unknown[]);
  return out;
}

export function variantLabel(v: CharacterVariant) {
  return v.costume || v.label || v.id || v.glb.split('/').slice(-3, -1).join('/');
}

export interface StoryPanel {
  enabled: boolean;
  current: { title: string; sub: string } | null;
  next: { title: string; sub: string; go: () => void } | null;
  contents: {
    title: string;
    sub: string;
    play: () => void;
    scripts: { title: string; sub: string; played: boolean; replay: () => void }[];
  }[];
  onToggle: () => void;
  onRestart: () => void;
  onReset: () => void;
}

export interface BattleListItem {
  title: string;
  sub: string;
  search?: string;
  start: () => void;
}

export interface BattlesPanel {
  here: BattleListItem[];
  encounters: BattleListItem[];
  all: BattleListItem[];
}

export class UI {
  readonly root = document.getElementById('ui')!;
  readonly loading = h('div', { class: 'loading hidden' }, h('div', { class: 'spinner' }), h('div', { class: 'loading-text' }));
  readonly prompt = h('div', { class: 'prompt hidden' });
  readonly dialogue = h('div', { class: 'dialogue hidden' });
  readonly toastEl = h('div', { class: 'toast hidden' });
  readonly drawers: Record<string, HTMLElement> = {};
  private toastTimer = 0;
  onAction: (action: string) => void = () => {};

  constructor() {
    // the explorer tools open from the game menu's Extras tab (and their hotkeys); there is no top bar
    for (const name of ['maps', 'chars', 'weapons', 'music', 'story', 'battles', 'info', 'help']) {
      const d = h('aside', { class: `drawer drawer-${name} hidden` });
      this.drawers[name] = d;
    }
    this.root.append(...Object.values(this.drawers), this.prompt, this.dialogue, this.toastEl, this.loading);
  }

  toggle(name: string, force?: boolean) {
    const d = this.drawers[name];
    const open = force ?? d.classList.contains('hidden');
    // Left drawers share a side, right drawers share the other.
    const left = ['maps', 'chars', 'weapons', 'music'];
    for (const [n, other] of Object.entries(this.drawers)) {
      if (n !== name && left.includes(n) === left.includes(name)) other.classList.add('hidden');
    }
    d.classList.toggle('hidden', !open);
    if (open) (d.querySelector('input[type=search]') as HTMLInputElement | null)?.focus();
  }

  closeAll() {
    for (const d of Object.values(this.drawers)) d.classList.add('hidden');
  }

  anyOpen() {
    return Object.values(this.drawers).some((d) => !d.classList.contains('hidden'));
  }

  setLoading(msg: string | null) {
    this.loading.classList.toggle('hidden', !msg);
    if (msg) (this.loading.querySelector('.loading-text') as HTMLElement).textContent = msg;
  }

  toast(msg: string, ms = 2600) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.add('hidden'), ms);
  }

  setPrompt(text: string | null) {
    this.prompt.classList.toggle('hidden', !text);
    if (text) this.prompt.innerHTML = text;
  }

  showDialogue(speaker: string, line: DialogueLine | null, index: number, total: number) {
    this.dialogue.classList.remove('hidden');
    this.dialogue.replaceChildren(
      h('div', { class: 'speaker' }, line?.speaker || speaker),
      h('div', { class: 'line' }, line ? line.text : '…'),
      h(
        'div',
        { class: 'meta' },
        line?.sceneId ? `scene ${line.sceneId} · ` : '',
        total ? `${index + 1}/${total} · ` : 'no preserved lines tied to this character here · ',
        h('kbd', {}, 'E'),
        ' next  ',
        h('kbd', {}, 'Esc'),
        ' close',
      ),
    );
  }

  hideDialogue() {
    this.dialogue.classList.add('hidden');
  }

  get dialogueOpen() {
    return !this.dialogue.classList.contains('hidden');
  }

  renderMaps(maps: MapEntry[], current: string | null, onPick: (m: MapEntry) => void) {
    const d = this.drawers.maps;
    const search = h('input', { type: 'search', placeholder: `Search ${maps.length} maps — title, chapter, id…` }) as HTMLInputElement;
    const list = h('div', { class: 'list' });
    const order = ['FINAL FANTASY VII', 'FF7', 'CRISIS CORE', 'THE FIRST SOLDIER', 'THE FIRST SOLDIER — Part 2', 'Character Stories', 'Events'];
    const rank = (g: string) => {
      const i = order.findIndex((o) => g.toUpperCase().startsWith(o.toUpperCase()));
      return i < 0 ? (g === 'Other' ? 999 : 100) : i;
    };
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const groups = new Map<string, MapEntry[]>();
      for (const m of maps) {
        const hay = `${m.title} ${m.key} ${(m.groups ?? []).join(' ')} ${(m.episodes ?? []).map((e) => `${e.title ?? ''} ${e.chapter ?? ''}`).join(' ')}`.toLowerCase();
        if (q && !q.split(/\s+/).every((t) => hay.includes(t))) continue;
        const gs = m.groups?.length ? m.groups : ['Other'];
        const g = m.kind === 'dungeon' ? gs[0] : `${gs[0]} · 3D stages`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(m);
      }
      const sorted = [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
      list.replaceChildren(
        ...sorted.map(([g, ms]) =>
          h(
            'details',
            { open: q || ms.some((m) => m.key === current) ? true : undefined },
            h('summary', {}, g, h('span', { class: 'count' }, String(ms.length))),
            ...ms.map((m) =>
              h(
                'button',
                { class: `item ${m.key === current ? 'active' : ''}`, onclick: () => onPick(m) },
                h('span', { class: 'item-title' }, m.title || m.key),
                h('span', { class: 'item-sub' }, `${m.key}${m.bgm?.length ? ' · ♪' : ''}${m.exits?.length ? ` · ${m.exits.length} exits` : ''}`),
              ),
            ),
          ),
        ),
      );
      if (!sorted.length) list.append(h('p', { class: 'empty' }, 'No maps match.'));
    };
    search.addEventListener('input', draw);
    d.replaceChildren(h('h2', {}, 'Maps'), search, list);
    draw();
  }

  renderCharacters(groups: CharacterGroup[], currentUrl: string, onPick: (v: CharacterVariant) => void) {
    const d = this.drawers.chars;
    let kind: 'field' | 'battle' = groups.some((g) => g.variants.some((v) => v.glb === currentUrl) && g.kind === 'battle') ? 'battle' : 'field';
    const search = h('input', { type: 'search', placeholder: 'Search characters & costumes…' }) as HTMLInputElement;
    const tabs = h('div', { class: 'tabs' });
    const list = h('div', { class: 'list' });
    const draw = () => {
      tabs.replaceChildren(
        ...(['field', 'battle'] as const).map((k) =>
          h(
            'button',
            { class: `tab ${k === kind ? 'active' : ''}`, onclick: () => ((kind = k), draw()) },
            k === 'field' ? 'Field models' : 'Battle models & costumes',
          ),
        ),
      );
      const q = search.value.trim().toLowerCase();
      const gs = groups.filter((g) => g.kind === kind);
      list.replaceChildren(
        ...gs
          .map((g) => {
            const vs = g.variants.filter((v) => !q || `${g.name} ${variantLabel(v)} ${v.glb}`.toLowerCase().includes(q));
            if (!vs.length) return null;
            return h(
              'details',
              { open: q || vs.some((v) => v.glb === currentUrl) ? true : undefined },
              h('summary', {}, g.name, h('span', { class: 'count' }, String(vs.length))),
              ...vs.map((v) =>
                h(
                  'button',
                  { class: `item ${v.glb === currentUrl ? 'active' : ''}`, onclick: () => onPick(v) },
                  h('span', { class: 'item-title' }, variantLabel(v)),
                  h('span', { class: 'item-sub' }, v.glb.replace('/lib/unity/', '').replace('/model.glb', '')),
                ),
              ),
            );
          })
          .filter(Boolean) as HTMLElement[],
      );
      if (!list.children.length) list.append(h('p', { class: 'empty' }, groups.length ? 'No match.' : 'Character manifest not generated yet.'));
    };
    search.addEventListener('input', draw);
    d.replaceChildren(h('h2', {}, 'Character'), tabs, search, list);
    draw();
  }

  renderWeapons(
    who: string,
    weapons: { id: string; name: string; sub: string }[] | null,
    currentId: string | null,
    onPick: (id: string | null) => void,
  ) {
    const d = this.drawers.weapons;
    if (!weapons) {
      d.replaceChildren(h('h2', {}, 'Weapon'), h('p', { class: 'empty' }, 'Weapons are held by battle models. Pick one under Character → Battle models (P).'));
      return;
    }
    const search = h('input', { type: 'search', placeholder: `Search ${weapons.length} weapons…` }) as HTMLInputElement;
    const list = h('div', { class: 'list' });
    const item = (id: string | null, title: string, sub: string) =>
      h('button', { class: `item ${id === currentId ? 'active' : ''}`, onclick: () => onPick(id) }, h('span', { class: 'item-title' }, title), h('span', { class: 'item-sub' }, sub));
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        item(null, 'No weapon', 'empty-handed'),
        ...weapons.filter((w) => !q || `${w.name} ${w.id}`.toLowerCase().includes(q)).map((w) => item(w.id, w.name, w.sub)),
      );
    };
    search.addEventListener('input', draw);
    d.replaceChildren(h('h2', {}, 'Weapon'), h('p', { class: 'item-sub' }, `Weapons ${who} can equip`), search, list);
    draw();
  }

  renderMusic(
    tracks: MusicTrack[],
    current: MusicTrack | null,
    pinned: boolean,
    volume: number,
    on: { pick: (t: MusicTrack) => void; follow: () => void; volume: (v: number) => void; toggle: () => void },
  ) {
    const d = this.drawers.music;
    const search = h('input', { type: 'search', placeholder: `Search ${tracks.length} tracks…` }) as HTMLInputElement;
    const list = h('div', { class: 'list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(
        ...tracks
          .filter((t) => !q || `${t.id} ${t.title ?? ''} ${(t.usedBy ?? []).join(' ')}`.toLowerCase().includes(q))
          .slice(0, 400)
          .map((t) =>
            h(
              'button',
              { class: `item ${t.url === current?.url ? 'active' : ''}`, onclick: () => on.pick(t) },
              h('span', { class: 'item-title' }, t.title || t.id),
              h('span', { class: 'item-sub' }, `${t.id}${t.usedBy?.length ? ` · ${t.usedBy.length} maps` : ''}`),
            ),
          ),
      );
    };
    search.addEventListener('input', draw);
    const vol = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(volume) }) as HTMLInputElement;
    vol.addEventListener('input', () => on.volume(Number(vol.value)));
    d.replaceChildren(
      h('h2', {}, 'Music'),
      h(
        'div',
        { class: 'now' },
        h('div', {}, current ? `♪ ${current.title || current.id}` : 'Nothing playing'),
        h('div', { class: 'item-sub' }, pinned ? 'Jukebox pick (stays across maps)' : 'Following the map’s BGM'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'small', onclick: on.toggle }, 'Play / pause'),
          pinned ? h('button', { class: 'small', onclick: on.follow }, 'Follow map BGM') : null,
          h('label', { class: 'vol' }, 'Vol', vol),
        ),
      ),
      search,
      list,
    );
    draw();
  }

  renderInfo(
    entry: MapEntry,
    detail: MapDetail | null,
    extra: { rows: [string, string][]; exits: { key: string; title: string }[]; onTravel: (key: string) => void },
  ) {
    const d = this.drawers.info;
    const lore = detail?.lore;
    const eps = lore?.episodes ?? detail?.episodes ?? entry.episodes ?? [];
    const enemies = (lore?.enemies ?? []).map((e) => (typeof e === 'string' ? e : e.name));
    const scenes = (lore?.scenes ?? []).map((s) => (typeof s === 'string' ? { id: s } : s));
    const section = (title: string, ...body: (Child | Child[])[]) => h('section', {}, h('h3', {}, title), ...body);
    const parts: (HTMLElement | null)[] = [
      h('h2', {}, entry.title || entry.key),
      h('div', { class: 'chips' }, ...(entry.groups ?? []).map((g) => h('span', { class: 'chip' }, g)), h('span', { class: 'chip mono' }, entry.key)),
      section('This map', h('table', {}, ...extra.rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))),
      extra.exits.length
        ? section(
            'Exits',
            h('p', { class: 'item-sub' }, 'Connections found in story routing data. Glowing markers in the map lead there too.'),
            ...extra.exits.map((x) => h('button', { class: 'item', onclick: () => extra.onTravel(x.key) }, h('span', { class: 'item-title' }, `→ ${x.title}`), h('span', { class: 'item-sub' }, x.key))),
          )
        : null,
      eps.length
        ? section(
            `Story (${eps.length})`,
            h('ul', {}, ...eps.slice(0, 40).map((e) => h('li', {}, [e.family, e.chapter, e.section].filter(Boolean).join(' · ') + (e.title ? ` — ${e.title}` : ''), h('span', { class: 'mono dim' }, ` ${e.id}`)))),
          )
        : null,
      (detail?.bgm ?? entry.bgm ?? []).length
        ? section('Music', h('ul', {}, ...(detail?.bgm ?? entry.bgm ?? []).map((b) => h('li', {}, b.title || b.id, h('span', { class: 'mono dim' }, ` ${b.id}`)))))
        : null,
      enemies.length ? section(`Enemies met here (${enemies.length})`, h('div', { class: 'chips' }, ...enemies.slice(0, 60).map((e) => h('span', { class: 'chip' }, e)))) : null,
      detail?.npcs?.length ? section(`Characters in scenes (${detail.npcs.length})`, h('div', { class: 'chips' }, ...detail.npcs.map((n) => h('span', { class: 'chip' }, n.name)))) : null,
      scenes.length ? section(`Scenes (${scenes.length})`, h('ul', {}, ...scenes.slice(0, 50).map((s) => h('li', {}, h('span', { class: 'mono' }, s.id), s.title ? ` — ${s.title}` : '')))) : null,
      !detail ? h('p', { class: 'empty' }, 'Lore details not generated for this map yet.') : null,
    ];
    d.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
  }

  renderStory(m: StoryPanel) {
    const d = this.drawers.story;
    const section = (title: string, ...body: (Child | Child[])[]) => h('section', { class: 'story-list' }, h('h3', {}, title), ...body);
    const btn = (label: string, on: () => void, cls = 'small') => h('button', { class: cls, onclick: on }, label);
    const parts: (HTMLElement | null)[] = [
      h('h2', {}, 'Story'),
      h(
        'div',
        { class: 'now' },
        h('div', {}, m.enabled ? 'Story mode is on' : 'Story mode is off'),
        h('div', { class: 'item-sub' }, m.enabled ? 'Maps play their story content: setup, arrival scene and triggered events, with saved progress.' : 'Maps are free to explore. Turn it on to play the field scripts.'),
        h('div', { class: 'row' }, btn(m.enabled ? 'Turn off' : 'Turn on', m.onToggle), m.current ? btn('Restart content', m.onRestart) : null, btn('Reset progress', m.onReset)),
      ),
      m.current ? section('Now playing', h('div', {}, m.current.title), h('div', { class: 'item-sub' }, m.current.sub)) : null,
      m.next ? section('Story order', h('button', { class: 'item', onclick: m.next.go }, h('span', { class: 'item-title' }, `→ ${m.next.title}`), h('span', { class: 'item-sub' }, m.next.sub))) : null,
      ...(m.contents.length
        ? m.contents.map((c) =>
            section(
              c.title,
              h('div', { class: 'item-sub' }, c.sub),
              h('button', { class: 'item', onclick: c.play }, h('span', { class: 'item-title' }, '▶ Play this content'), h('span', { class: 'item-sub' }, 'setup → arrival → triggers')),
              ...c.scripts.map((x) => h('button', { class: `item ${x.played ? 'played' : ''}`, onclick: x.replay }, h('span', { class: 'item-title' }, x.title), h('span', { class: 'item-sub' }, x.sub))),
            ),
          )
        : [h('p', { class: 'empty' }, 'No field scripts for this map.')]),
    ];
    d.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
  }

  renderBattles(m: BattlesPanel) {
    const d = this.drawers.battles;
    const item = (x: BattleListItem) => h('button', { class: 'item', onclick: x.start }, h('span', { class: 'item-title' }, x.title), h('span', { class: 'item-sub' }, x.sub));
    const search = h('input', { type: 'search', placeholder: `Search ${m.all.length} battles — enemy, id…` }) as HTMLInputElement;
    const all = h('div', { class: 'list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hits = m.all.filter((x) => !q || q.split(/\s+/).every((t) => (x.search ?? `${x.title} ${x.sub}`).toLowerCase().includes(t)));
      all.replaceChildren(...hits.slice(0, 200).map(item));
      if (!hits.length) all.append(h('p', { class: 'empty' }, 'No battle matches.'));
    };
    search.addEventListener('input', draw);
    d.replaceChildren(
      ...[
      h('h2', {}, 'Battles'),
      h('p', { class: 'item-sub' }, 'FF7-style ATB battles with Ever Crisis enemies, skills and stages. The story party fights at a fair level.'),
      h('section', { class: 'story-list' }, h('h3', {}, 'This map'), ...(m.here.length ? m.here.map(item) : [h('p', { class: 'empty' }, 'No story battles on this map.')])),
      m.encounters.length ? h('section', { class: 'story-list' }, h('h3', {}, 'Random encounters here'), ...m.encounters.map(item)) : null,
      h('section', { class: 'story-list' }, h('h3', {}, 'All battles'), search, all),
      ].filter((x): x is HTMLElement => x !== null),
    );
    draw();
  }

  /** `key(action)` = the key bound to a field action (Settings → Controls). */
  renderHelp(key: (action: string) => string) {
    const row = (keys: string, what: string) => h('tr', {}, h('th', {}, ...keys.split(' ').map((k) => h('kbd', {}, k))), h('td', {}, what));
    const k = (...as: string[]) => as.map(key).join(' ');
    this.drawers.help.replaceChildren(
      h('h2', {}, 'Controls'),
      h('p', { class: 'item-sub' }, 'Field keys follow Settings → Controls (Esc menu → Settings, or K).'),
      h(
        'table',
        { class: 'keys' },
        row(k('up', 'left', 'down', 'right'), 'Walk (arrow keys work too)'),
        row(k('run'), 'Run'),
        row(`${k('interact')} Enter`, 'Talk / use gimmick / take exit · next line in cutscenes'),
        row(`${k('menu')} Esc`, 'Menu: items, equipment, materia, shop, party, status, save, Extras, settings'),
        row('Esc', 'In a cutscene or movie: pause (resume, skip the scene, settings, title) · closes panels'),
        row(k('camera'), 'Cycle camera: Ever Crisis → Orbit → First person'),
        row('1 2 3', 'Pick camera directly'),
        row(k('rotL', 'rotR'), '(EC camera, 3D stages) rotate view 45° — or drag the mouse'),
        row('Mouse', 'Orbit: drag to rotate, wheel to zoom · First person: click to capture mouse'),
        row(k('noclip'), 'No-clip fly (Space up, Ctrl down)'),
        row(k('reset'), 'Back to the start point'),
        row('[ ]', 'Previous / next pre-rendered view (dungeon maps)'),
        row(k('debug'), 'Show collision & camera areas'),
        row(k('maps', 'chars', 'weapons', 'music'), 'Extras: Maps · Character · Weapon · Music'),
        row(k('story', 'battles', 'info', 'help'), 'Extras: Story · Battles · Info · this help'),
        row(k('settings'), 'Settings (battle, audio, graphics, controls)'),
        row('Battle: F', 'Attack the locked-on enemy (or left-click an enemy) · uses the full ATB bar'),
        row('Battle: Space', 'Command list: Abilities, Magic, Items, Summon, Limit (right-click too) · Enter / E confirm'),
        row('Battle: G', 'Guard: spend the ATB bar to halve damage until that character’s next turn'),
        row('Battle: Shift 1 2 3 4', 'Hold Shift for the shortcut palette · 1–4 fire a shortcut · in a skill list, 1–4 put the highlighted skill on that shortcut'),
        row('Battle: ← → [ ]', 'Switch the lock-on target (↑↓ / ←→ move the cursor in lists and while targeting)'),
        row('Battle: Esc', 'Back / close the list · pause when no list or cursor is open: resume, settings, retry, escape, title'),
        row('Battle: Tab ↑ ↓', 'Hand the turn to the next character whose ATB is full'),
        row('Battle: Q+R', 'Hold to escape a random encounter'),
        row('Gamepad', 'Stick/D-pad move · A confirm · B back · Y menu · Start pause/menu · RB run'),
        row('Gamepad battle', '□ attack · ✕ commands / confirm · ○ back · R1 guard · L1 + △○✕□ shortcuts · R-stick target · △ next · L2+R2 escape · Start pause'),
      ),
      h(
        'p',
        { class: 'item-sub' },
        'Dungeon maps in Ever Crisis are pre-rendered backgrounds with depth. The EC camera shows them exactly as the game did; Orbit and First person rebuild them as 3D from the depth maps, so expect stretched edges where the original view could not see.',
      ),
    );
  }
}
