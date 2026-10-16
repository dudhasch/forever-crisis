import './style.css';
import * as THREE from 'three';
import { tryJSON } from './assets';
import { Music } from './audio';
import { Battle, type BattleOutcome, type BattleRequest } from './battle/battle';
import { battleData } from './battle/data';
import { loadSettings, saveSettings, type BattleSettings } from './battle/rules';
import { CAMERA_LABEL, CAMERA_MODES, CameraRig, type CameraMode } from './camera/rig';
import { Character } from './player/character';
import { battleIdOf, weaponsFor } from './player/weapon';
import { contentKey, loadContent, mapKeyOf, storyIndex, StoryFlags, type StoryStep } from './story/data';
import type { Shape } from './story/data';
import { inShape, StoryDirector, type StoryPrompt, type StoryWorld } from './story/director';
import { SoundEffects, StoryOverlay } from './story/overlay';
import type { CharactersManifest, CharacterVariant, MapEntry, MusicTrack } from './types';
import { UI, normalizeCharacters, variantLabel, type BattleListItem, type CharacterGroup, type StoryPanel } from './ui';
import { CharacterController } from './world/collision';
import { GameMap, loadMapList, type Gimmick } from './world/map';
import { nearestNpc, spawnNpcs, type Npc } from './world/npcs';
import { FieldHud } from './world/fieldhud';
import { battleGame } from './game/bridge';
import { menuData, type MenuData } from './game/data';
import { GameMenu } from './game/menu';
import { GameState } from './game/state';
import { TITLE_BGM, TitleScreen, type TitleChoice } from './game/title';
import { startGamepad } from './game/gamepad';
import { KeyHints } from './game/hints';
import { PauseMenu } from './game/pause';
import { keyLabel, QUALITY_PIXEL_CAP, settings, type Action } from './game/settings';
import { SettingsScreen } from './game/settingsui';
import { TOON_SETTINGS } from './render/toon';
import { BLOOM_SAMPLES, PostFx, type BloomParams, type GradeParams } from './render/post';
import { STAGE_SETTINGS } from './render/stage';
import { EffectPlayer, playMapAmbience } from './effects/player';
import { startAutoBackup } from './platform/cloud';
import { ensureAssets } from './platform/firstrun';
import { checkForUpdates } from './platform/online';
import { instrument, startTelemetry } from './platform/telemetry';
import { openBugReport, setBugContext } from './platform/bugreport';
import { rewardText, TreasureBoxes, treasureEvent, treasureSounds, treasureSpots, type TreasureEvent } from './world/treasure';
import { loadTransports, TransportRun, firesOnTouch, transportAt, transportLabel, type TransportDef } from './world/transport';

const DEFAULT_MAP = 'dungeon_map_0001';
const DEFAULT_CHARACTER = '/lib/unity/questcharacter/001/model/001/model.glb';
const WALK_SPEED = 1.9;
const RUN_SPEED = 5.5;
const FLY_SPEED = 8;
// EnvironmentData.silhouetteColor is 50% grey on almost every map.
const SILHOUETTE = new THREE.Color().setRGB(0.5, 0.5, 0.5, THREE.SRGBColorSpace);

interface ExitMarker {
  to: string;
  title: string;
  /** Where the game puts you in the destination map. */
  startPointIndex?: number;
  group: THREE.Group;
  position: THREE.Vector3;
}

/** Which story content to run when a map loads (and from which start point), or one script to replay. */
interface StoryRequest {
  content: string;
  sp?: number;
  replay?: string;
  /** Index in storyIndex().story when started from the story order. */
  step?: number;
}

const STORY_MODE_KEY = 'ff7ec.storyMode';

/** generated/battle/encounters.json: the game's EncountArea volumes per dungeon map. */
interface EncounterArea {
  content: string;
  area: number;
  min: number;
  max: number;
  shapes: Shape[];
  battles: { battle: number; weight: number }[];
  /** Highest enemy level of its battles (filled in after loading). */
  level?: number;
}

type Interactable =
  | { kind: 'story'; prompt: StoryPrompt; label: string }
  | { kind: 'npc'; npc: Npc; label: string }
  | { kind: 'gimmick'; gimmick: Gimmick; label: string }
  | { kind: 'transport'; def: TransportDef; label: string }
  | { kind: 'treasure'; id: number; label: string }
  | { kind: 'exit'; exit: ExitMarker; label: string };

class App {
  readonly renderer: THREE.WebGLRenderer;
  /** Bloom (Settings → Graphics) on the scene's post profile. */
  private readonly post: PostFx;
  private bloomOn = true;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly ui = new UI();
  readonly music = new Music();
  readonly clock = new THREE.Clock();
  readonly controller = new CharacterController(null);
  readonly keys = new Set<string>();
  maps: MapEntry[] = [];
  mapsByKey = new Map<string, MapEntry>();
  characters: CharacterGroup[] = [];
  tracks: MusicTrack[] = [];
  map: GameMap | null = null;
  /** EC ambient particles of the current map (generated/effects stages / fields). */
  private mapFx: EffectPlayer | null = null;
  player: Character | null = null;
  playerUrl = DEFAULT_CHARACTER;
  npcs: Npc[] = [];
  exits: ExitMarker[] = [];
  heading = 0;
  speed = 0;
  talking: Npc | null = null;
  /** Weapon picked per battle model ("001/003" -> weapon id, or null for none). */
  weaponChoice = new Map<string, string | null>();
  focus: Interactable | null = null;
  manualCapture = false;
  loadingMap = false;
  private mapToken = 0;
  // field scripts
  readonly overlay = new StoryOverlay(document.getElementById('ui')!);
  readonly sfx = new SoundEffects();
  readonly flags = new StoryFlags('ff7ec.storyFlags');
  // save game, title screen, in-game menu (src/game)
  readonly game = new GameState();
  readonly title: TitleScreen;
  readonly gameMenu: GameMenu;
  private menuData: MenuData | null = null;
  readonly settingsUi: SettingsScreen;
  readonly pause: PauseMenu;
  readonly hints: KeyHints;
  /** Remake-style walking HUD: corner minimap and interaction prompts (src/world/fieldhud.ts). */
  readonly fieldHud: FieldHud;
  /** Cutscene pause: the field (story, movie, characters) stands still. */
  paused = false;
  /** A panel was opened from the menu's Extras tab: Esc goes back there. */
  private extrasReturn = false;
  /** Battle pause → Quit to title: leave once the battle has ended. */
  private quitAfterBattle = false;
  private lastFrame = 0;
  story: StoryDirector | null = null;
  storyMode = readStoryMode();
  /** Position in the global story order of the running content, when known. */
  storyStep: number | null = null;
  /** The user's character while a story character is the player. */
  userPlayer: Character | null = null;
  private pendingRun: (() => void) | null = null;
  // battles
  battle: Battle | null = null;
  battleLoading = false;
  readonly battleSettings: BattleSettings = loadSettings();
  /** Lua changeBattleField override for this map. */
  battleField: number | null = null;
  /** Story episode of the running content (its party fights). */
  storyEpisode: string | null = null;
  private lastEpisode: string | null = null;
  private encounterAreas: EncounterArea[] = [];
  /** The one encounter set this map rolls from (key: content it was chosen for). */
  private encounterSet: { content: string | undefined; areas: EncounterArea[] } | null = null;
  private encounterDist = 0;
  private encounterNext = 20;
  private encounterCooldown = 0;
  // treasure boxes
  boxes: TreasureBoxes | null = null;
  /** Called when the player opens a treasure box (also fired as a window `ff7ec:treasure` event): hook for an inventory. */
  onTreasure: ((e: TreasureEvent) => void) | null = null;
  // ladders and jumps (TransportTrigger)
  transports: TransportDef[] = [];
  transport: TransportRun | null = null;
  private transportStarting = false;
  private transportCooldown = 0;
  /** Which transport triggers the player stood in last frame (null: not sampled yet). */
  private transportInside: Map<number, boolean> | null = null;

  constructor() {
    const canvas = document.getElementById('scene') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    // The stage's sun casts shadows (Settings → Graphics → Shadows picks the map size or turns them off).
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.post = new PostFx(this.renderer);
    this.rig = new CameraRig(canvas);
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('hashchange', () => this.applyHash());
    this.ui.onAction = (a) => this.action(a);
    canvas.addEventListener('click', (e) => {
      if (this.battle) return this.battle.click(e.clientX, e.clientY);
      if (this.story?.locked && !this.paused) this.story.advance();
    });
    this.music.onChange = () => this.renderMusic();
    const app = this;
    this.title = new TitleScreen({
      game: this.game,
      sfx: this.sfx,
      get maps() {
        return app.maps;
      },
      get mapsByKey() {
        return app.mapsByKey;
      },
      unlockAudio: () => this.music.unlock(),
      titleMusic: () => this.music.play(this.tracks.find((t) => t.id === TITLE_BGM) ?? { id: TITLE_BGM, url: `/arc/05-Music-FLAC/${TITLE_BGM}.flac` }, { pin: false }),
      openSettings: () => this.settingsUi.show(),
      reportBug: () => this.reportBug(),
    });
    this.settingsUi = new SettingsScreen({
      sfx: this.sfx,
      battle: this.battleSettings,
      saveBattle: () => saveSettings(this.battleSettings),
    });
    this.pause = new PauseMenu(this.sfx);
    setBugContext(() => this.bugContext());
    this.hints = new KeyHints(this.ui.root);
    this.fieldHud = new FieldHud(this.ui.root, this);
    this.applySettings();
    settings.onChange(() => this.applySettings());
    startGamepad();
    this.gameMenu = new GameMenu({
      game: this.game,
      sfx: this.sfx,
      storyParty: () => this.storyParty(),
      location: () => (this.map ? `${this.map.entry.title || this.map.entry.key}${this.story && this.storyStep !== null ? '' : ' · Free Roam'}` : '—'),
      openSettings: () => this.settingsUi.show(),
      tools: () => this.tools(),
      reportBug: () => this.reportBug(),
      openTool: (id) => {
        this.extrasReturn = true;
        this.action(id);
      },
      toTitle: () => void this.toTitle(),
      snapshot: () => ({ flags: this.flags.snapshot(), battleSettings: { ...this.battleSettings } }),
      loadSlot: (slot) => void this.applyChoice({ kind: 'slot', slot }),
      lookChanged: () => void this.applyLook(),
      toast: (m) => this.ui.toast(m),
    });
    // treasure boxes (src/world/treasure.ts) hand their rewards to the save game
    this.onTreasure = (e) => {
      this.game.treasure(e.treasureId);
    };
  }

  async start() {
    this.ui.setLoading('Reading the archive…');
    const [maps, chars, music] = await Promise.all([
      loadMapList(),
      tryJSON<CharactersManifest>('/gen/characters.json'),
      tryJSON<MusicTrack[] | { tracks: MusicTrack[] }>('/gen/music.json'),
    ]);
    this.maps = maps;
    this.mapsByKey = new Map(maps.map((m) => [m.key, m]));
    this.characters = normalizeCharacters(chars);
    this.tracks = music ? (Array.isArray(music) ? music : music.tracks) : [];
    const firstField = this.characters.find((g) => g.kind === 'field' && /cloud/i.test(g.name))?.variants[0];
    if (firstField) this.playerUrl = firstField.glb;
    this.renderMusic();
    const hash = this.readHash();
    // A deep link (#map=…) skips the title screen; a reload of the URL this tab's app wrote shows it (Continue).
    const deepLink = !!hash.map && this.mapsByKey.has(hash.map) && !ownHash();
    if (hash.char) this.playerUrl = `/lib/unity/${hash.char}/model.glb`;
    if (hash.cam && CAMERA_MODES.includes(hash.cam as CameraMode)) this.rig.setMode(hash.cam as CameraMode);
    else this.rig.setMode(settings.s.controls.camera);
    const [menu, battle] = await Promise.all([menuData().catch(() => null), battleData().catch(() => null)]);
    this.menuData = menu;
    if (menu && battle) this.game.init(menu, battle.index);
    await this.loadPlayer(this.playerUrl);
    if (deepLink) {
      this.game.active = true;
      await this.loadMap(hash.map!, undefined, hash.sp, hash.content ? { content: hash.content, sp: hash.sp } : undefined);
      this.renderer.setAnimationLoop(() => this.frame());
      this.showSplash();
      return;
    }
    this.ui.setLoading(null);
    this.renderer.setAnimationLoop(() => this.frame());
    await this.titleFlow(true);
  }

  // ---------------------------------------------------------------- title, save game, menu
  /** Show the title screen and start whatever the player picks. */
  private async titleFlow(press: boolean) {
    const choice = await this.title.show(this.menuData, press);
    await this.applyChoice(choice);
  }

  private async toTitle() {
    this.game.save();
    this.game.active = false;
    this.resumeField();
    this.gameMenu.hide();
    this.disposeStory();
    this.ui.closeAll();
    await this.titleFlow(false);
  }

  private async applyChoice(c: TitleChoice) {
    const g = this.game;
    if (c.kind === 'slot') {
      const snap = g.loadSlot(c.slot);
      if (!snap) return void this.ui.toast(`Slot ${c.slot} is empty`);
      if (snap.flags) this.flags.restore(snap.flags);
      if (snap.battleSettings) {
        Object.assign(this.battleSettings, snap.battleSettings);
        saveSettings(this.battleSettings);
      }
    }
    g.active = true;
    const pos = g.d.position;
    if (c.kind === 'step' || ((c.kind === 'continue' || c.kind === 'slot') && pos.mode === 'story' && pos.step !== null)) {
      this.setStoryModeQuiet(true);
      await this.restoreFieldBody();
      await this.playStep(c.kind === 'step' ? c.step : pos.step!);
      return;
    }
    const map = (c.kind === 'free' ? c.map : pos.map) ?? DEFAULT_MAP;
    if (!map || !this.mapsByKey.has(map)) return void (await this.titleFlow(false));
    const free = c.kind === 'free' || pos.mode === 'free';
    this.setStoryModeQuiet(!free);
    if (free) await this.applyLook();
    else await this.restoreFieldBody();
    await this.loadMap(map, undefined, undefined, !free && pos.content ? { content: pos.content } : undefined);
  }

  private setStoryModeQuiet(on: boolean) {
    this.storyMode = on;
    writeStoryMode(on);
  }

  /** Story mode walks as the field model; Free Roam as the party leader's battle model and gear. */
  private async restoreFieldBody() {
    const field = this.characters.find((g) => g.kind === 'field' && /cloud/i.test(g.name))?.variants[0]?.glb ?? DEFAULT_CHARACTER;
    if (this.playerUrl !== field && !/\/questcharacter\//.test(this.playerUrl)) await this.loadPlayer(field);
  }

  /** Free Roam: walk as the party leader, in their outfit, holding their weapon. */
  private async applyLook() {
    if (this.story && !this.story.replay && this.storyMode) return;
    const look = this.game.leaderLook();
    if (!look?.model) return;
    const ids = battleIdOf(look.model);
    if (ids) this.weaponChoice.set(ids.battleId, look.weaponGlb);
    if (this.playerUrl !== look.model) await this.loadPlayer(look.model);
    else await this.equipWeapon(look.weaponGlb);
  }

  /** The running episode's party (character ids), or null when the menu's party fights (Free Roam). */
  storyParty(): number[] | null {
    const idx = this.game.index;
    if (!this.story || this.story.replay || !this.storyEpisode || !idx) return null;
    const party = idx.parties[this.storyEpisode];
    if (!party) return null;
    const out: number[] = [];
    for (const m of [...party.members].sort((a, b) => Number(b.fixed) - Number(a.fixed) || a.slot - b.slot)) {
      if (idx.characters[String(m.character)]?.model && !out.includes(m.character)) out.push(m.character);
      if (out.length >= Math.min(3, party.count || 3)) break;
    }
    return out.length ? out : null;
  }

  /** Autosave where the player is (Continue resumes the story step, or the Free Roam map). */
  private recordPosition() {
    if (!this.game.active || !this.map) return;
    const map = this.map;
    const step = this.story && !this.story.replay ? this.storyStep : null;
    const content = this.story && !this.story.replay ? this.story.content.content : null;
    void storyIndex().then((idx) => {
      const s = step !== null ? idx?.story[step] : undefined;
      this.game.setPosition({
        mode: this.storyMode && this.story ? 'story' : 'free',
        map: map.entry.key,
        content,
        step,
        title: s?.title,
        chapter: s?.chapter,
        family: s?.family,
        mapTitle: map.entry.title || map.entry.key,
      });
    });
  }

  private showSplash() {
    const splash = document.getElementById('splash')!;
    splash.classList.remove('hidden');
    const go = () => {
      splash.classList.add('hidden');
      this.music.unlock();
      window.removeEventListener('keydown', go);
    };
    splash.addEventListener('click', go, { once: true });
    window.addEventListener('keydown', go);
  }

  // ---------------------------------------------------------------- state & URL
  private readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const sp = p.get('sp');
    return {
      map: p.get('map') ?? undefined,
      char: p.get('char') ?? undefined,
      cam: p.get('cam') ?? undefined,
      content: p.get('content') ?? undefined,
      sp: sp !== null && sp !== '' ? Number(sp) : undefined,
    };
  }

  private writeHash() {
    const p = new URLSearchParams();
    if (this.map) p.set('map', this.map.entry.key);
    if (this.story && !this.story.replay) p.set('content', this.story.content.content);
    const char = /\/lib\/unity\/(.+)\/model\.glb$/.exec(this.playerUrl)?.[1];
    if (char) p.set('char', char);
    p.set('cam', this.rig.mode);
    const next = `#${p.toString()}`;
    if (location.hash !== next) history.replaceState(null, '', next);
    markOwnHash(next);
    this.recordPosition();
  }

  private applyHash() {
    const h = this.readHash();
    if (h.map && h.map !== this.map?.entry.key && this.mapsByKey.has(h.map)) void this.loadMap(h.map);
  }

  // ---------------------------------------------------------------- loading
  async loadMap(key: string, from?: string, startPointIndex?: number, story?: StoryRequest) {
    const entry = this.mapsByKey.get(key);
    if (!entry || this.loadingMap) return;
    this.loadingMap = true;
    const token = ++this.mapToken;
    this.talking = null;
    this.ui.hideDialogue();
    this.ui.closeAll();
    try {
      const map = await GameMap.load(entry, (m) => this.ui.setLoading(`${entry.title || key}\n${m}`));
      if (token !== this.mapToken) return map.dispose();
      this.disposeStory();
      this.map?.dispose();
      for (const n of this.npcs) n.character.dispose();
      for (const x of this.exits) x.group.removeFromParent();
      this.boxes?.dispose();
      this.boxes = null;
      this.npcs = [];
      this.exits = [];
      this.map = map;
      this.scene.add(map.group);
      this.mapFx?.dispose();
      this.mapFx = new EffectPlayer();
      this.scene.add(this.mapFx.group);
      void playMapAmbience(this.mapFx, key);
      this.scene.background = map.backgroundColor;
      this.scene.environment = map.environment(this.renderer);
      this.controller.world = map.collision;
      this.transport = null;
      this.transportInside = null;
      this.transports = await loadTransports(key);
      this.rig.collision = map.collision;
      this.manualCapture = false;
      this.battleField = null;
      this.encounterDist = 0;
      this.encounterCooldown = 4;
      this.encounterAreas = (await tryJSON<Record<string, EncounterArea[]>>('/gen/battle/encounters.json'))?.[key] ?? [];
      this.encounterSet = null;
      try {
        const d = await battleData();
        for (const a of this.encounterAreas) {
          a.level = Math.max(0, ...a.battles.flatMap((b) => (d.battles[String(b.battle)]?.waves ?? []).flatMap((w) => w.enemies.map((e) => d.enemies[e.enemy]?.level ?? 0))));
        }
      } catch {
        /* no battle data: encounters stay off */
      }
      // Arrive at the marker leading back to where we came from, like walking through a door.
      // Prefer the start point the game's map-change trigger names; else the marker leading back.
      const named = startPointIndex !== undefined ? map.layout?.startPoints.find((s) => s.name === `start_point_${String(startPointIndex + 1).padStart(2, '0')}`) : undefined;
      const back = from ? this.exits.find((x) => x.to === from) : undefined;
      let spawn = map.spawn.position.clone();
      this.heading = map.spawn.yaw;
      if (named) {
        spawn = new THREE.Vector3().fromArray(named.position);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(named.quaternion));
        this.heading = Math.atan2(fwd.x, fwd.z);
      } else if (back) {
        spawn = back.position.clone();
        this.heading = Math.atan2(map.spawn.position.x - spawn.x, map.spawn.position.z - spawn.z);
      }
      this.controller.teleport(spawn);
      if (map.isDungeon) {
        const cap = map.captureFor(spawn) ?? map.activeCapture;
        if (cap && cap !== map.activeCapture) {
          await cap.load();
          map.setCapture(cap);
        }
      }
      this.rig.setCapture(map.activeCapture);
      map.setFreeView(this.rig.mode !== 'ec');
      this.ui.setLoading(`${entry.title || key}\nPlacing characters…`);
      // Story mode: the field scripts place the characters; otherwise scatter the map's NPCs.
      const scripted = await this.startStory(map, story ?? null, true);
      if (!scripted) {
        this.buildExits(map);
        this.npcs = await spawnNpcs(map.detail, map.spawn.position, map.collision, null, this.playerUrl);
        for (const n of this.npcs) map.group.add(n.character.root);
        await this.buildTreasures(map);
      }
      const bgm = map.detail?.bgm?.[0] ?? entry.bgm?.[0];
      this.music.mapTrack(bgm ? (this.tracks.find((t) => t.id === bgm.id) ?? { id: bgm.id, url: bgm.url, title: bgm.title }) : null);
      this.ui.renderMaps(this.maps, key, (m) => void this.loadMap(m.key));
      this.updateTitles();
      this.renderInfo();
      this.writeHash();
      if (!map.collision) this.ui.toast('No collision data for this map — no-clip enabled', 4000);
      this.controller.noclip = !map.collision;
    } catch (e) {
      console.error(e);
      this.ui.toast(`Could not load ${key}: ${(e as Error).message}`, 5000);
    } finally {
      this.loadingMap = false;
      this.ui.setLoading(null);
    }
    const run = this.pendingRun;
    this.pendingRun = null;
    run?.();
  }

  // ---------------------------------------------------------------- field scripts
  private storyWorld(map: GameMap): StoryWorld {
    const app = this;
    return {
      map,
      rig: this.rig,
      music: this.music,
      overlay: this.overlay,
      sfx: this.sfx,
      silhouette: SILHOUETTE,
      playerPosition: this.controller.position,
      get heading() {
        return app.heading;
      },
      set heading(v: number) {
        app.heading = v;
      },
      placePlayer: (p, yaw) => {
        this.controller.position.copy(p);
        this.controller.velocity.set(0, 0, 0);
        this.heading = yaw;
      },
      setPlayerBody: (c) => this.setPlayerBody(c),
      setCapture: (name) => this.setStoryCapture(map, name),
      changeDungeon: (m, c, sp) => void this.storyChangeDungeon(m, c, sp),
      clearDungeon: () => void this.storyClear(),
      battle: (sb, ids) => this.storyBattle(sb, ids),
      setBattleField: (f) => (this.battleField = f),
      toast: (m) => this.ui.toast(m),
      openTreasure: (id) => this.openTreasure(id, false),
      openPartyMenu: () => this.gameMenu.show('party'),
    };
  }

  /**
   * Run the map's story content (story mode), or the requested one. With `deferRun` the scripts start
   * once the map has finished loading. Returns whether a content was set up.
   */
  private async startStory(map: GameMap, req: StoryRequest | null, deferRun = false): Promise<boolean> {
    this.disposeStory();
    if (!req && !this.storyMode) return false;
    const idx = await storyIndex();
    const entry = idx?.maps[map.entry.key];
    const contentId = req?.content ?? entry?.storyContent;
    if (!idx || !contentId) return false;
    const data = await loadContent(map.entry.key, contentId).catch(() => null);
    if (!data || this.map !== map) return false;
    const ic = entry?.contents.find((c) => c.id === contentId);
    this.storyEpisode = ic?.episode?.id ? String(ic.episode.id) : null;
    if (this.storyEpisode) this.lastEpisode = this.storyEpisode;
    const controlId = idx.episodes.find((e) => e.id === ic?.episode?.id)?.controlCharacter || 10010101;
    const flags = req?.replay ? this.flags.sandbox() : this.flags;
    let d: StoryDirector;
    try {
      d = await StoryDirector.create(this.storyWorld(map), data, flags, controlId, !!req?.replay);
    } catch (e) {
      console.error(e);
      this.ui.toast(`Field scripts failed: ${(e as Error).message}`, 5000);
      return false;
    }
    if (this.map !== map) {
      d.dispose();
      return false;
    }
    for (const n of this.npcs) n.character.dispose();
    for (const x of this.exits) x.group.removeFromParent();
    this.npcs = [];
    this.exits = [];
    this.story = d;
    void this.buildTreasures(map);
    d.onChange = () => {
      if (!this.ui.drawers.story.classList.contains('hidden')) void this.renderStory();
    };
    const step = req?.step ?? idx.story.findIndex((s) => s.map === map.entry.key && s.content === contentId);
    this.storyStep = step >= 0 ? step : null;
    const sp = req?.sp ?? (this.storyStep !== null ? idx.story[this.storyStep].startPointIndex : 0);
    const run = () => {
      if (this.story !== d) return;
      void (req?.replay ? d.replayScript(req.replay) : d.enter(sp)).catch((e) => console.error('[story]', e));
    };
    if (deferRun) this.pendingRun = run;
    else run();
    this.writeHash();
    return true;
  }

  private disposeStory() {
    if (!this.story) return;
    this.story.dispose();
    this.story = null;
  }

  /** A story character became the player (or null: back to the user's pick). */
  private setPlayerBody(c: Character | null) {
    if (c) {
      if (c === this.player) return;
      if (!this.userPlayer) {
        this.userPlayer = this.player;
        this.userPlayer?.root.removeFromParent();
      }
      this.player = c;
    } else if (this.userPlayer) {
      this.player = this.userPlayer;
      this.userPlayer = null;
      this.scene.add(this.player.root);
      this.player.root.visible = this.rig.mode !== 'fps';
    }
  }

  /** dungeon.changeCamera / resetCamera. */
  private async setStoryCapture(map: GameMap, name: string | null) {
    const cap = name ? map.findCapture(name) : map.captureFor(this.controller.position);
    if (!cap) return;
    await cap.load().catch((e) => console.warn('capture', name, e));
    if (this.map !== map || !map.setCapture(cap)) return;
    this.rig.setCapture(cap);
    this.updateTitles();
  }

  private async storyChangeDungeon(mapId: number, contentId: number, sp: number) {
    const key = mapKeyOf(mapId);
    if (!this.mapsByKey.has(key)) {
      this.ui.toast(`${key} is not in the archive — staying here`, 4000);
      if (this.map) void this.startStory(this.map, null);
      return;
    }
    const content = await contentKey(key, contentId);
    const idx = await storyIndex();
    const at = this.storyStep;
    const step = idx?.story.findIndex((s, i) => s.map === key && s.content === content && (at === null || i > at)) ?? -1;
    const req: StoryRequest = { content, sp, step: step >= 0 ? step : undefined };
    if (this.map && key === this.map.entry.key) await this.startStory(this.map, req);
    else await this.loadMap(key, undefined, sp, req);
  }

  /** dungeon.clearDungeon: the episode is over; go on with the next one in story order. */
  private async storyClear() {
    const idx = await storyIndex();
    const cur = this.story?.content;
    const steps = idx?.story ?? [];
    const at = this.storyStep ?? steps.findIndex((s) => s.map === cur?.map && s.content === cur?.content);
    const next = this.nextStep(steps, at);
    const nextLine = next ? `<div class="dim">Next: ${escapeHtml(next.step.title)}</div>` : '';
    // first clear: the episode's rewards; a chapter is cleared when the story moves on to the next one
    const ep = steps[at]?.episodeId;
    const chapterOf = (id?: number) => (idx?.episodes.find((e) => e.id === id) as { chapterId?: number } | undefined)?.chapterId;
    const got = ep ? this.game.clearEpisode(ep) : [];
    const chapter = chapterOf(ep);
    if (chapter && chapter !== chapterOf(next?.step.episodeId)) this.game.clearChapter(chapter);
    const gotLine = got.length ? `<div>Received: ${escapeHtml(got.join(', '))}</div>` : '';
    this.overlay.showCard(`<h3>EPISODE CLEAR</h3><div>${escapeHtml(steps[at]?.title ?? cur?.map ?? '')}</div>${gotLine}${nextLine}`);
    await new Promise((r) => setTimeout(r, 2500));
    this.overlay.showCard(null);
    if (next) await this.playStep(next.index);
    else {
      this.ui.toast('That was the last story content in this archive', 4000);
      if (this.map) void this.startStory(this.map, null);
    }
  }

  private nextStep(steps: StoryStep[], at: number) {
    for (let i = at + 1; i < steps.length; i++) {
      const s = steps[i];
      if (s.hasScripts && this.mapsByKey.has(s.map) && (s.map !== steps[at]?.map || s.content !== steps[at]?.content)) return { index: i, step: s };
    }
    return null;
  }

  private async playStep(i: number) {
    const s = (await storyIndex())?.story[i];
    if (!s) return;
    const req: StoryRequest = { content: s.content, sp: s.startPointIndex, step: i };
    if (this.map?.entry.key === s.map) await this.startStory(this.map, req);
    else await this.loadMap(s.map, undefined, s.startPointIndex, req);
  }

  private setStoryMode(on: boolean) {
    this.storyMode = on;
    writeStoryMode(on);
    this.ui.toast(on ? 'Story mode on — field scripts play' : 'Story mode off — free exploring');
    if (this.map) void this.loadMap(this.map.entry.key);
  }

  private async renderStory() {
    const m = this.map;
    const idx = await storyIndex();
    const key = m?.entry.key ?? '';
    const contents = idx?.maps[key]?.contents ?? [];
    const story = this.story;
    const cur = story ? contents.find((c) => c.id === story.content.content) : undefined;
    const steps = idx?.story ?? [];
    const next = story && this.storyStep !== null ? this.nextStep(steps, this.storyStep) : null;
    const pretty = (name: string) => {
      const n = /_(\d+)$/.exec(name)?.[1] ?? '';
      if (name.startsWith('startpoint')) return `Arrival ${n}`;
      if (name.startsWith('novel')) return `Event ${n}`;
      if (name.startsWith('battle')) return `Battle ${n}`;
      if (name.startsWith('selection')) return `Choice ${n}`;
      return name;
    };
    const order = (n: string) => (n.startsWith('startpoint') ? 0 : n.startsWith('novel') ? 1 : n.startsWith('battle') ? 2 : 3);
    const panel: StoryPanel = {
      enabled: this.storyMode,
      current: story
        ? {
            title: `${cur?.title ?? story.content.content}${story.replay ? ' (replay)' : ''}`,
            sub: `${key} · content ${story.content.content}${cur?.kind ? ` · ${cur.kind}` : ''}${story.current ? ` · running ${story.current}` : ''}`,
          }
        : null,
      next: next
        ? { title: next.step.title, sub: `${next.step.map} · content ${next.step.content}${next.step.section ? ` · ${next.step.section}` : ''}`, go: () => void this.playStep(next.index) }
        : null,
      contents: contents
        .filter((c) => c.scripts.some((x) => x !== 'setup'))
        .map((c) => ({
          title: `${c.title ?? c.kind} · ${c.id}`,
          sub: [c.kind, c.episode?.chapter, c.episode?.section].filter(Boolean).join(' · '),
          play: () => {
            if (!this.storyMode) {
              this.storyMode = true;
              writeStoryMode(true);
            }
            if (m) void this.startStory(m, { content: c.id });
          },
          scripts: c.scripts
            .filter((x) => x !== 'setup' && !x.startsWith('gimmick'))
            .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
            .map((x) => ({ title: pretty(x), sub: x, played: false, replay: () => void (m && this.startStory(m, { content: c.id, replay: x })) })),
        })),
      onToggle: () => this.setStoryMode(!this.storyMode),
      onRestart: () => {
        if (!story || !m) return;
        this.flags.clearContent(story.flagKey);
        void this.startStory(m, { content: story.content.content, step: this.storyStep ?? undefined });
      },
      onReset: () => {
        if (!confirm('Forget all story progress (content flags, opened treasure boxes)?')) return;
        this.flags.clearAll();
        if (m && this.storyMode) void this.startStory(m, null);
        this.ui.toast('Story progress reset');
      },
    };
    this.ui.renderStory(panel);
  }

  // ---------------------------------------------------------------- battles
  /** A field script's playBattle: fight its story-party battle; a loss the player skips counts as won. */
  private async storyBattle(storyBattle: number, battleIds: number[]) {
    const data = await battleData().catch(() => null);
    const id = battleIds.find((b) => data?.battles[String(b)]) ?? (data?.battles[String(storyBattle)] ? storyBattle : undefined);
    if (id === undefined) {
      this.ui.toast(`Battle ${storyBattle} has no exported data — counted as won`, 3500);
      return true;
    }
    const o = await this.runBattle({ battleId: id, episode: this.storyEpisode, mapKey: this.map?.entry.key, field: this.battleField });
    return o !== 'escaped';
  }

  async runBattle(req: BattleRequest): Promise<BattleOutcome> {
    if (this.battle || this.battleLoading) return 'escaped';
    // Free Roam (no story party): the menu's party fights
    if (!req.party && this.game.active && !this.storyParty()) req = { ...req, party: this.game.d.party };
    this.battleLoading = true;
    this.keys.clear();
    this.ui.closeAll();
    this.ui.setPrompt(null);
    let outcome: BattleOutcome = 'skipped';
    const host = {
      renderer: this.renderer,
      mapsByKey: this.mapsByKey,
      music: this.music,
      sfx: this.sfx,
      tracks: this.tracks,
      uiRoot: this.ui.root,
      settings: this.battleSettings,
      game: this.game.index ? battleGame(this.game) : undefined,
      playMovie: (url: string) => this.overlay.playMovie(url),
    };
    try {
      for (;;) {
        const b = await Battle.create(host, req, () => {});
        b.resize(window.innerWidth, window.innerHeight);
        this.battle = b;
        this.battleLoading = false;
        outcome = await b.outcome;
        this.battle = null;
        b.dispose();
        if (outcome !== 'retry') break;
        this.battleLoading = true;
      }
    } catch (e) {
      console.error(e);
      this.ui.toast(`Battle failed: ${(e as Error).message}`, 5000);
      this.battle?.dispose();
      this.battle = null;
    } finally {
      this.battleLoading = false;
    }
    this.keys.clear();
    this.pause.hide();
    this.encounterDist = 0;
    this.encounterCooldown = 5;
    if (this.quitAfterBattle) {
      this.quitAfterBattle = false;
      void this.toTitle();
      return outcome;
    }
    if (outcome === 'skipped') this.ui.toast('Battle skipped — counted as won', 2200);
    return outcome;
  }

  /**
   * Several contents share a map (the story area plus Hard / Very Hard and score replays), each with its own
   * EncountArea boxes. Roll from one set for the whole map: the running content's, else the easiest. Picking per
   * spot let a harder replay's box take over wherever it was the only one covering the player.
   */
  private currentEncounterSet() {
    const content = this.story?.content.content;
    if (this.encounterSet && this.encounterSet.content === content) return this.encounterSet.areas;
    let areas = this.encounterAreas.filter((a) => a.content === content);
    if (!areas.length) {
      const level = new Map<string, number>();
      for (const a of this.encounterAreas) level.set(a.content, Math.max(level.get(a.content) ?? 0, a.level ?? 999));
      const easiest = [...level].sort((a, b) => a[1] - b[1])[0]?.[0];
      areas = this.encounterAreas.filter((a) => a.content === easiest);
    }
    this.encounterSet = { content, areas };
    return areas;
  }

  /** FF7-style random battles inside the game's EncountArea volumes. */
  private updateEncounters(dt: number, moved: number) {
    if (!this.battleSettings.encounters || this.battle || this.battleLoading || !this.encounterAreas.length) return;
    if (this.story?.locked || this.story?.busy || this.talking || this.loadingMap || this.controller.noclip) return;
    this.encounterCooldown = Math.max(0, this.encounterCooldown - dt);
    const p = this.controller.position.clone().add(new THREE.Vector3(0, 0.5, 0));
    const area = this.currentEncounterSet().find((a) => a.shapes.some((sh) => inShape(sh, p)));
    if (!area || this.encounterCooldown > 0) return;
    this.encounterDist += moved;
    if (this.encounterDist < this.encounterNext) return;
    this.encounterDist = 0;
    const lo = Math.max(10, area.min * 2);
    const hi = Math.max(lo + 8, area.max * 1.6);
    this.encounterNext = lo + Math.random() * (hi - lo);
    const total = area.battles.reduce((sum, b) => sum + b.weight, 0);
    let r = Math.random() * total;
    const pick = area.battles.find((b) => (r -= b.weight) <= 0) ?? area.battles[0];
    void this.runBattle({ battleId: pick.battle, episode: this.storyEpisode ?? this.lastEpisode, mapKey: this.map?.entry.key, field: this.battleField, escapable: true });
  }

  private async renderBattles() {
    const data = await battleData().catch(() => null);
    if (!data) {
      this.ui.drawers.battles.replaceChildren(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'Battle data not generated yet (npm run extract:battles).' }));
      return;
    }
    const key = this.map?.entry.key ?? '';
    const perMap = (await tryJSON<Record<string, { battle: number; name: string; content: string; script: string }[]>>('/gen/battle/perMap.json')) ?? {};
    const names = (id: number) => {
      const b = data.battles[String(id)];
      if (!b) return { title: `Battle ${id}`, level: 0, count: 0 };
      const list = b.waves.flatMap((w) => w.enemies.map((e) => data.enemies[e.enemy])).filter(Boolean);
      const uniq = [...new Set(list.map((e) => e.name))];
      return { title: uniq.join(', ') || `Battle ${id}`, level: Math.max(0, ...list.map((e) => e.level)), count: b.waves.length };
    };
    const start = (battleId: number, escapable = false) => () => {
      this.ui.closeAll();
      void this.runBattle({ battleId, episode: this.storyEpisode ?? this.lastEpisode, mapKey: this.map?.entry.key, field: this.battleField, escapable });
    };
    const item = (id: number, sub: string, escapable = false): BattleListItem => {
      const n = names(id);
      return { title: n.title, sub: `${sub} · Lv ${n.level}${n.count > 1 ? ` · ${n.count} waves` : ''} · #${id}`, start: start(id, escapable) };
    };
    const encIds = [...new Set(this.currentEncounterSet().flatMap((a) => a.battles.map((b) => b.battle)))];
    this.ui.renderBattles({
      here: (perMap[key] ?? []).map((x) => item(x.battle, `${x.name.replace(/^BTL_/, '')} · content ${x.content}`)),
      encounters: encIds.map((id) => item(id, 'encounter', true)),
      all: Object.values(data.battles)
        .sort((a, b) => a.id - b.id)
        .map((b) => {
          const it = item(b.id, b.source === 'script' ? 'story' : 'encounter');
          return { ...it, search: `${it.title} ${it.sub}` };
        }),
    });
  }

  // ---------------------------------------------------------------- settings
  /** Settings → Audio / Graphics / Controls take effect at once. */
  private applySettings() {
    const { audio, graphics, controls } = settings.s;
    this.music.volume = audio.music;
    this.sfx.setVolumes(audio.sfx, audio.voice);
    this.overlay.setMovieVolume(audio.music);
    const ratio = Math.min(window.devicePixelRatio, QUALITY_PIXEL_CAP[graphics.quality]) * graphics.resolution;
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-3) {
      this.renderer.setPixelRatio(ratio);
      this.onResize();
    }
    TOON_SETTINGS.strength.value = graphics.toon;
    TOON_SETTINGS.outline.value = graphics.outlines ? 1 : 0;
    STAGE_SETTINGS.shadows = graphics.shadows;
    this.bloomOn = graphics.bloom;
    // MSAA on the bloom's HDR target is the costly part: Quality picks it.
    this.post.setSamples(BLOOM_SAMPLES[graphics.quality]);
    this.rig.sensitivity = controls.mouse;
    this.rig.invertY = controls.invertY;
    this.ui.renderHelp((a) => keyLabel(this.bound(a as Action)));
    if (this.ui.drawers.music && !this.ui.drawers.music.classList.contains('hidden')) this.renderMusic();
  }

  /** The key shown for an action (the rebindable one, not the arrow / Enter fallbacks). */
  private bound(a: Action) {
    return settings.keys(a).find((k) => !k.startsWith('arrow') && k !== 'enter') ?? '';
  }

  /** The explorer tools listed in the menu's Extras tab. */
  private tools() {
    const t = (id: Action | 'camera', label: string, help: string) => ({ id, label, help, key: keyLabel(this.bound(id as Action)) });
    return [
      t('maps', 'Maps', 'Travel to any of the field maps and 3D stages'),
      t('chars', 'Characters', 'Walk as any field or battle model and costume'),
      t('weapons', 'Weapons', 'The weapon a battle model holds'),
      t('music', 'Music', 'Jukebox: every track of the game'),
      t('story', 'Story', 'Story mode, and replay any cutscene of this map'),
      t('battles', 'Battles', 'Start any of the exported battles'),
      t('info', 'Map info', 'Lore, episodes, music, enemies and exits of this map'),
      t('camera', 'Camera', `Change camera (now: ${CAMERA_LABEL[this.rig.mode]})`),
      t('help', 'Controls', 'Every key in the field and in battle'),
    ];
  }

  async loadPlayer(url: string) {
    this.ui.setLoading('Loading character…');
    try {
      const c = await Character.load(url, { outline: true, silhouette: SILHOUETTE });
      this.playerUrl = url;
      if (this.userPlayer) {
        // A story character is playing: swap the pick that comes back afterwards.
        this.userPlayer.dispose();
        this.userPlayer = c;
      } else {
        this.player?.dispose();
        this.player = c;
        this.scene.add(c.root);
      }
      await this.equipWeapon();
      this.writeHash();
      this.renderCharacters();
      if (this.map) this.renderInfo();
    } catch (e) {
      console.error(e);
      this.ui.toast(`Could not load character: ${(e as Error).message}`, 5000);
    } finally {
      this.ui.setLoading(null);
    }
  }

  /** Mount the chosen (or the costume's default) weapon on a battle model and refresh the panel. */
  private async equipWeapon(id?: string | null) {
    const player = this.userPlayer ?? this.player;
    if (!player) return;
    const info = await weaponsFor(player.url);
    const ids = battleIdOf(player.url);
    if (info && ids) {
      if (id !== undefined) this.weaponChoice.set(ids.battleId, id);
      const want = this.weaponChoice.has(ids.battleId) ? this.weaponChoice.get(ids.battleId)! : info.defaultId;
      const main = want ? (info.list.find((w) => w.id === want) ?? null) : null;
      await player.setWeapons(main, info.extras, info.equipPoints);
    }
    this.renderWeapons();
  }

  private renderWeapons() {
    const player = this.userPlayer ?? this.player;
    const label = this.playerLabel().split(' — ')[0];
    void (player ? weaponsFor(player.url) : Promise.resolve(null)).then((info) => {
      this.ui.renderWeapons(
        label,
        info ? info.list.map((w) => ({ id: w.id, name: w.name, sub: `${w.id}${w.id === info.defaultId ? ' · costume default' : ''}` })) : null,
        player?.weaponId ?? null,
        (id) => void this.equipWeapon(id).then(() => this.ui.toast(id ? `Equipped ${info?.list.find((w) => w.id === id)?.name ?? id}` : 'Weapon removed')),
      );
    });
  }

  // ---------------------------------------------------------------- exits
  private buildExits(map: GameMap) {
    const links = map.detail?.exits ?? map.entry.exits ?? [];
    const targets = [...new Map(links.filter((l) => this.mapsByKey.has(l.to) && l.to !== map.entry.key).map((l) => [l.to, l])).values()];
    if (!targets.length) return;
    // Start points other than the default spawn are the map's entrances; give each one a destination.
    const spots = (map.layout?.startPoints ?? []).filter((s) => s.name !== map.spawn.name).map((s) => new THREE.Vector3().fromArray(s.position));
    if (!spots.length && map.collision) {
      // 3D stages have no start points: use the far edges of the walkable area.
      const b = map.collision.bounds;
      const c = map.spawn.position;
      const r = Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.35;
      for (let i = 0; i < targets.length; i++) {
        const a = (i / targets.length) * Math.PI * 2;
        const g = map.collision.groundBelow(new THREE.Vector3(c.x + Math.cos(a) * r, b.max.y + 1, c.z + Math.sin(a) * r), b.max.y - b.min.y + 5);
        if (g) spots.push(g);
      }
    }
    let spot = 0;
    targets.forEach((t) => {
      const rp = t.returnPosition;
      const pos = rp ? new THREE.Vector3(rp.x, rp.y, rp.z) : spots[spot++];
      if (!pos) return;
      const title = this.mapsByKey.get(t.to)?.title ?? t.to;
      const group = exitMarker(title);
      group.position.copy(pos);
      map.group.add(group);
      this.exits.push({ to: t.to, title, group, position: pos.clone(), startPointIndex: t.startPointIndex });
    });
  }

  // ---------------------------------------------------------------- UI
  /** The view line of the Info panel (map, camera, pre-rendered view); refreshes the panel when it is open. */
  private updateTitles() {
    const m = this.map;
    if (!m) return;
    const cap = m.activeCapture ? ` · view ${m.activeCapture.def.name}${this.manualCapture ? ' (manual)' : ''}` : '';
    this.viewLabel = `${CAMERA_LABEL[this.rig.mode]} camera${cap}${this.controller.noclip ? ' · no-clip' : ''}`;
    if (!this.ui.drawers.info.classList.contains('hidden')) this.renderInfo();
  }

  private viewLabel = '';

  private renderInfo() {
    const m = this.map;
    if (!m) return;
    const allExits = [...new Set((m.detail?.exits ?? m.entry.exits ?? []).map((x) => x.to))].filter((k) => this.mapsByKey.has(k));
    const rows: [string, string][] = [
      ['View', this.viewLabel],
      ['Kind', m.isDungeon ? `Pre-rendered dungeon map (${m.captures.length} views, ${m.eventCaptures.length} event views)` : '3D stage'],
      ['Collision', m.collision ? `${m.collision.source === 'colliders' ? 'game colliders' : 'render meshes (approx.)'} · ${m.collision.bvh.geometry.index ? m.collision.bvh.geometry.index.count / 3 : 0} triangles` : 'none'],
      ['Start points', String(m.layout?.startPoints?.length ?? 0)],
      ['Gimmicks', m.gimmicks.length ? m.gimmicks.map((g) => g.name).join(', ') : '—'],
      ['You', `${this.playerLabel()} · ${this.player?.animationSummary || 'no animation'}`],
    ];
    this.ui.renderInfo(m.entry, m.detail, {
      rows,
      exits: allExits.map((k) => ({ key: k, title: this.mapsByKey.get(k)?.title ?? k })),
      onTravel: (k) => void this.loadMap(k, m.entry.key, (m.detail?.exits ?? m.entry.exits ?? []).find((x) => x.to === k)?.startPointIndex),
    });
  }

  private playerLabel() {
    for (const g of this.characters) {
      const v = g.variants.find((x) => x.glb === this.playerUrl);
      if (v) return `${g.name} — ${variantLabel(v)}`;
    }
    return this.playerUrl.replace('/lib/unity/', '').replace('/model.glb', '');
  }

  private renderCharacters() {
    this.ui.renderCharacters(this.characters, this.playerUrl, (v: CharacterVariant) => void this.loadPlayer(v.glb));
  }

  private renderMusic() {
    this.ui.renderMusic(this.tracks, this.music.current, this.music.pinned, this.music.volume, {
      pick: (t) => this.music.play(t, { pin: true }),
      follow: () => {
        this.music.pinned = false;
        const b = this.map?.detail?.bgm?.[0] ?? this.map?.entry.bgm?.[0];
        this.music.play(b ? (this.tracks.find((t) => t.id === b.id) ?? { id: b.id, url: b.url }) : null);
      },
      volume: (v) => {
        settings.s.audio.music = v;
        settings.changed();
      },
      toggle: () => this.music.toggle(),
    });
  }

  private action(a: string) {
    switch (a) {
      case 'maps':
      case 'music':
      case 'help':
        this.ui.toggle(a);
        break;
      case 'chars':
        this.renderCharacters();
        this.ui.toggle('chars');
        break;
      case 'weapons':
        this.renderWeapons();
        this.ui.toggle('weapons');
        break;
      case 'story':
        void this.renderStory();
        this.ui.toggle('story');
        break;
      case 'battles':
        void this.renderBattles();
        this.ui.toggle('battles');
        break;
      case 'settings':
        void this.settingsUi.show();
        break;
      case 'info':
        this.renderInfo();
        this.ui.toggle('info');
        break;
      case 'camera':
        this.setCameraMode(CAMERA_MODES[(CAMERA_MODES.indexOf(this.rig.mode) + 1) % CAMERA_MODES.length]);
        if (this.extrasReturn) {
          this.extrasReturn = false;
          this.gameMenu.show('extras');
        }
        break;
    }
  }

  private setCameraMode(mode: CameraMode) {
    this.rig.setMode(mode);
    this.map?.setFreeView(mode !== 'ec');
    if (this.player) this.player.root.visible = mode !== 'fps';
    this.updateTitles();
    this.writeHash();
    this.ui.toast(`${CAMERA_LABEL[mode]} camera`);
  }

  // ---------------------------------------------------------------- input
  private onKey(e: KeyboardEvent, down: boolean) {
    const target = e.target as HTMLElement;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      if (down && e.key === 'Escape') target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (this.battle) {
      const b = this.battle;
      if (down) b.keysDown.add(k);
      else b.keysDown.delete(k);
      if (k === 'tab' || k === ' ' || k.startsWith('arrow')) e.preventDefault();
      if (!down || e.repeat) return;
      // Esc pauses on the command menu or between turns; inside a sub-menu or the target cursor it still backs out
      if (k === 'escape' && b.canPause) {
        e.preventDefault();
        return this.pauseBattle(b);
      }
      if (b.onKey(k, e.code)) e.preventDefault();
      return;
    }
    if (this.battleLoading) return;
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down || e.repeat) return;
    const act = settings.action(k);
    // Hotkeys must not also type into the search box their panel focuses.
    if (act || (k.length === 1 && '123[]?'.includes(k))) e.preventDefault();
    const story = this.story;
    if (k === 'escape') {
      e.preventDefault();
      if (this.cutscene()) return this.pauseCutscene();
      if (this.talking) return this.endTalk();
      if (this.ui.anyOpen()) {
        this.ui.closeAll();
        // a panel opened from the menu's Extras tab goes back there
        if (this.extrasReturn && this.canOpenMenu()) this.gameMenu.show('extras');
        this.extrasReturn = false;
        return;
      }
      if (this.canOpenMenu()) this.gameMenu.show();
      return;
    }
    if (act === 'menu') {
      e.preventDefault();
      if (this.canOpenMenu()) {
        this.ui.closeAll();
        this.extrasReturn = false;
        this.gameMenu.show();
      }
      return;
    }
    if (story && (story.locked || story.busy)) {
      if (act === 'interact' || k === ' ') {
        e.preventDefault();
        return story.advance();
      }
      if (this.overlay.choosing && (act === 'up' || act === 'down')) {
        e.preventDefault();
        return this.overlay.choiceMove?.(act === 'up' ? -1 : 1);
      }
    }
    if (act === 'interact') return this.interact();
    if (this.talking) return;
    const m = this.map;
    switch (act) {
      case 'maps':
      case 'chars':
      case 'weapons':
      case 'story':
      case 'battles':
      case 'settings':
      case 'music':
      case 'info':
      case 'help':
      case 'camera':
        this.extrasReturn = false;
        return this.action(act);
      case 'rotL':
        return this.rig.rotateEnv(1);
      case 'rotR':
        return this.rig.rotateEnv(-1);
      case 'noclip':
        this.controller.noclip = !this.controller.noclip;
        this.updateTitles();
        return this.ui.toast(this.controller.noclip ? 'No-clip on (Space up, Ctrl down)' : 'No-clip off');
      case 'reset':
        if (m) {
          this.controller.teleport(m.spawn.position);
          this.heading = m.spawn.yaw;
          this.manualCapture = false;
        }
        return;
      case 'debug':
        if (m) {
          const on = !(m.collision?.debug.visible ?? m.areasDebug.visible);
          if (m.collision) m.collision.debug.visible = on;
          m.areasDebug.visible = on;
          this.ui.toast(on ? 'Showing collision (red) and camera areas (blue)' : 'Debug overlay off');
        }
        return;
    }
    switch (k) {
      case '?':
        return this.action('help');
      case '1':
      case '2':
      case '3':
        return this.setCameraMode(CAMERA_MODES[Number(k) - 1]);
      case '[':
      case ']':
        if (m?.captures.length) {
          const i = m.activeCapture ? m.captures.indexOf(m.activeCapture) : 0;
          const next = m.captures[(i + (k === ']' ? 1 : m.captures.length - 1)) % m.captures.length];
          if (!next.ready) this.ui.toast('Loading view…', 1200);
          void next.load().then(() => {
            if (this.map !== m || !m.setCapture(next)) return;
            this.rig.setCapture(next);
            this.manualCapture = true;
            this.updateTitles();
          });
        }
        return;
    }
  }

  // ---------------------------------------------------------------- report a bug
  private reportBug() {
    return openBugReport(this.sfx);
  }

  /** What a bug report says about where the player is (see platform/bugreport.ts). */
  private bugContext() {
    const b = this.battle;
    const s = this.story;
    return {
      map: this.map?.entry.key ?? null,
      content: s && !s.replay ? s.content.content : null,
      step: s && !s.replay ? this.storyStep : null,
      battle: b ? b.battleId : null,
      wave: b ? b.waveIndex : null,
      busy: !!b || this.cutscene(),
      save: () => {
        const d = this.game.current();
        if (!d) return null;
        return JSON.stringify({ playTime: Math.round(d.playTime), level: d.level, party: d.party, leader: d.leader, gil: d.gil, cleared: { episodes: d.cleared.episodes, chapters: d.cleared.chapters.length, battles: d.cleared.battles.length } });
      },
    };
  }

  // ---------------------------------------------------------------- pause (Esc in battles and cutscenes)
  /** A cutscene or movie is running: Esc pauses it instead of opening the menu. */
  private cutscene() {
    if (this.overlay.moviePlaying) return true;
    const s = this.story;
    return !!s && (s.locked || s.busy);
  }

  private pauseCutscene() {
    if (this.paused) return;
    this.paused = true;
    this.keys.clear();
    this.overlay.pauseMovie(true);
    this.showCutscenePause();
  }

  private showCutscenePause() {
    const movie = this.overlay.moviePlaying;
    const canSkip = movie || !!this.story?.canSkip;
    this.pause.show(
      movie ? 'Movie paused' : 'Scene paused',
      [
        { label: 'Resume', run: () => this.resumeField() },
        {
          label: movie ? 'Skip movie' : 'Skip scene',
          enabled: canSkip,
          sub: canSkip ? undefined : 'This part of the scene cannot be skipped',
          run: () => {
            this.resumeField();
            if (this.story) this.story.skip();
            else this.overlay.stopMovie();
          },
        },
        {
          label: 'Settings',
          run: () => {
            this.pause.hide();
            void this.settingsUi.show().then(() => this.paused && this.showCutscenePause());
          },
        },
        {
          label: 'Report a bug',
          run: () => {
            this.pause.hide();
            void this.reportBug().then(() => this.paused && this.showCutscenePause());
          },
        },
        { label: 'Quit to title', sub: 'Continue resumes at the start of this story step', run: () => void this.toTitle() },
      ],
      () => this.resumeField(),
    );
  }

  /** Leave the cutscene pause. */
  private resumeField() {
    this.pause.hide();
    if (!this.paused) return;
    this.paused = false;
    this.keys.clear();
    this.overlay.pauseMovie(false);
  }

  private pauseBattle(b: Battle) {
    b.paused = true;
    const resume = () => {
      this.pause.hide();
      b.paused = false;
    };
    this.pause.show(
      'Pause',
      [
        { label: 'Resume', run: resume },
        {
          label: 'Settings',
          run: () => {
            this.pause.hide();
            void this.settingsUi.show().then(() => this.battle === b && this.pauseBattle(b));
          },
        },
        {
          label: 'Report a bug',
          run: () => {
            this.pause.hide();
            void this.reportBug().then(() => this.battle === b && this.pauseBattle(b));
          },
        },
        {
          label: 'Retry',
          sub: 'Start this battle over',
          run: () => {
            resume();
            b.abort('retry');
          },
        },
        {
          label: 'Escape',
          enabled: b.escapable,
          sub: b.escapable ? 'Run from this encounter' : 'You can’t escape from this battle',
          run: () => {
            resume();
            b.abort('escaped');
          },
        },
        {
          label: 'Quit to title',
          run: () => {
            resume();
            this.quitAfterBattle = true;
            b.abort('escaped');
          },
        },
      ],
      resume,
      b.title,
    );
  }

  private interact() {
    if (this.transport) return;
    if (this.talking) return this.nextLine();
    const f = this.focus;
    if (!f) return;
    if (f.kind === 'story') return f.prompt.run();
    if (f.kind === 'transport') return void this.startTransport(f.def);
    if (f.kind === 'treasure') return this.openTreasure(f.id, true);
    if (f.kind === 'npc') {
      this.talking = f.npc;
      this.showLine();
    } else if (f.kind === 'gimmick') {
      this.map?.triggerGimmick(f.gimmick);
    } else if (f.kind === 'exit' && this.map) {
      void this.loadMap(f.exit.to, this.map.entry.key, f.exit.startPointIndex);
    }
  }

  private showLine() {
    const n = this.talking!;
    this.ui.showDialogue(n.entry.name, n.lines[n.lineIndex] ?? null, n.lineIndex, n.lines.length);
  }

  private nextLine() {
    const n = this.talking!;
    if (!n.lines.length || n.lineIndex >= n.lines.length - 1) {
      n.lineIndex = 0;
      return this.endTalk();
    }
    n.lineIndex++;
    this.showLine();
  }

  private endTalk() {
    this.talking = null;
    this.ui.hideDialogue();
  }

  // ---------------------------------------------------------------- frame
  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.post?.setSize(w, h);
    this.rig.resize(w, h);
    this.battle?.resize(w, h);
  }

  private frame() {
    // Settings → Graphics → FPS limit
    const cap = settings.s.graphics.fpsCap;
    const now = performance.now();
    if (cap && now - this.lastFrame < 1000 / cap - 1) return;
    this.lastFrame = now;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const battle = this.battle;
    this.hints.update(dt, this.hintsWanted(), { env: !!this.map && !this.map.isDungeon, fps: this.rig.mode === 'fps' });
    this.fieldHud.update(dt, this.hintsWanted());
    if (battle) {
      if (!battle.paused) battle.update(dt);
      this.present(battle.scene, battle.camera);
      return;
    }
    const map = this.map;
    const player = this.player;
    if (!map || !player || this.paused) {
      this.present(this.scene, this.rig.camera);
      return;
    }
    // Movement relative to the view
    const input = new THREE.Vector2(
      (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0),
      (this.held('up') ? 1 : 0) - (this.held('down') ? 1 : 0),
    );
    const story = this.story;
    const scripted = !!story?.locked;
    const typing = this.talking !== null || this.loadingMap || scripted;
    if (typing) input.set(0, 0);
    const run = this.held('run');
    const yaw = this.rig.mode === 'fps' ? this.rig.fpsYaw : this.rig.headingYaw();
    const move = new THREE.Vector3();
    let vertical = 0;
    if (input.lengthSq() > 0) {
      input.normalize();
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      move.addScaledVector(fwd, input.y).addScaledVector(right, input.x);
      const speed = this.controller.noclip ? FLY_SPEED * (run ? 2.5 : 1) : run ? RUN_SPEED : WALK_SPEED;
      move.multiplyScalar(speed * dt);
      const target = Math.atan2(move.x, move.z);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-dt * 14));
    }
    if (this.controller.noclip && !typing) vertical = ((this.down(' ') ? 1 : 0) - (this.down('control') ? 1 : 0)) * FLY_SPEED * dt;
    if (this.transport) {
      const run = this.transport;
      run.update(dt);
      this.speed = run.speed;
      player.root.position.copy(this.controller.position);
      player.root.rotation.y = this.heading;
      player.update(dt, run.speed);
      if (run.done) this.endTransport();
    } else if (!scripted) {
      const before = this.controller.position.clone();
      this.controller.step(move, dt, vertical);
      const moved = this.controller.position.clone().sub(before).setY(0).length();
      this.speed += (moved / Math.max(dt, 1e-4) - this.speed) * (1 - Math.exp(-dt * 12));
      this.updateEncounters(dt, moved);
      if (this.controller.position.y < map.fallY) {
        this.controller.teleport(map.spawn.position);
        this.ui.toast('Fell out of the map — back to the start');
      }
      if (this.rig.mode === 'fps') this.heading = this.rig.fpsYaw + Math.PI;
      player.root.position.copy(this.controller.position);
      player.root.rotation.y = this.heading;
      player.update(dt, this.controller.noclip ? 0 : this.speed);
    } else this.speed = 0;
    // The story moves its characters (and, during cutscenes, the player) itself.
    story?.update(dt);

    // Camera areas switch the pre-rendered view (unless the user or a script picked one).
    if (!this.manualCapture && !story?.cameraLocked) {
      const changed = map.updateArea(this.controller.position);
      if (changed) {
        this.rig.setCapture(changed);
        this.updateTitles();
      }
    }

    for (const n of this.npcs) {
      if (n === this.talking) {
        const want = Math.atan2(player.root.position.x - n.character.root.position.x, player.root.position.z - n.character.root.position.z);
        let d = want - n.character.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        n.character.root.rotation.y += d * (1 - Math.exp(-dt * 6));
      }
      n.character.update(dt, 0);
    }
    for (const x of this.exits) x.group.rotation.y += dt * 0.8;

    this.boxes?.update(dt);
    this.updateAutoTransports(dt);
    this.updateFocus();
    this.rig.update(dt, this.controller.position, (this.player ?? player).height);
    story?.updateScreen(this.rig.camera);
    map.update(dt, this.rig.camera);
    if (this.mapFx) {
      this.mapFx.fog = this.scene.fog;
      this.mapFx.update(dt, this.rig.camera);
    }
    this.present(this.scene, this.rig.camera);
  }

  /** Draw a frame, through the bloom pass when the map's post profile has one (GameMap puts it on the scene). */
  private present(scene: THREE.Scene, camera: THREE.Camera) {
    const bloom = this.bloomOn ? ((scene.userData.bloom as BloomParams | null | undefined) ?? null) : null;
    const grade = (scene.userData.grade as GradeParams | null | undefined) ?? null;
    this.post.render(scene, camera, bloom, grade);
  }

  /** The in-game menu opens while the player is free to act (no cutscene, battle or loading). */
  private canOpenMenu() {
    if (!this.game.active || this.title.open || this.battle || this.battleLoading || this.loadingMap || this.talking) return false;
    return !this.story || !(this.story.locked || this.story.busy);
  }

  private down(...keys: string[]) {
    return keys.some((k) => this.keys.has(k));
  }

  /** A rebindable action's key is held. */
  private held(a: Action) {
    return settings.keys(a).some((k) => this.keys.has(k));
  }

  /** The key hints show while the player walks around freely. */
  private hintsWanted() {
    if (!this.game.active && !this.map) return false;
    if (this.battle || this.battleLoading || this.loadingMap || this.paused || this.talking || this.title.open || this.gameMenu.open) return false;
    if (this.ui.anyOpen() || this.settingsUi.open || this.transport) return false;
    return !this.story || !(this.story.locked || this.story.busy);
  }

  // ---------------------------------------------------------------- treasure boxes
  /** Place the chest models of the running content (free roam: the map's story content); opened ones show open. */
  private async buildTreasures(map: GameMap) {
    this.boxes?.dispose();
    this.boxes = null;
    const story = this.story;
    const idx = await storyIndex();
    const key = map.entry.key;
    const spots = await treasureSpots(key, story ? story.content.content : null, idx?.maps[key]?.storyContent);
    const flags = story?.flags ?? this.flags;
    const boxes = await TreasureBoxes.create(spots, (id) => flags.opened(id));
    if (this.map !== map || this.story !== story) return boxes.dispose();
    this.boxes = boxes;
    map.group.add(boxes.group);
  }

  /** The player opened a box: lid, sound, the real rewards (toast, onTreasure hook and a window event). */
  openTreasure(id: number, persist: boolean) {
    if (persist) this.flags.setOpened(id);
    this.boxes?.open(id);
    void (async () => {
      const [e, snd] = await Promise.all([treasureEvent(id), treasureSounds()]);
      if (snd.open) this.sfx.play(snd.open);
      if (snd.item) setTimeout(() => this.sfx.play(snd.item!), 450);
      this.ui.toast(rewardText(e), 3800);
      this.onTreasure?.(e);
      window.dispatchEvent(new CustomEvent('ff7ec:treasure', { detail: e }));
    })();
  }

  // ---------------------------------------------------------------- ladders and jumps
  private transportAvailable() {
    if (!this.player || !this.transports.length || this.transport || this.transportStarting) return false;
    if (this.loadingMap || this.talking || this.battle || this.battleLoading || this.controller.noclip) return false;
    return !this.story || this.story.free;
  }

  private async startTransport(def: TransportDef) {
    const player = this.player;
    if (!player || !this.transportAvailable()) return;
    this.transportStarting = true;
    const app = this;
    try {
      const run = await TransportRun.create(def, {
        character: player,
        controller: this.controller,
        sfx: this.sfx,
        heading: {
          get value() {
            return app.heading;
          },
          set value(v: number) {
            app.heading = v;
          },
        },
      });
      if (!run) return void this.ui.toast('This character has no climbing animation');
      if (this.player !== player || this.loadingMap) return;
      this.transport = run;
      this.story?.setTransporting(true);
      this.focus = null;
      this.ui.setPrompt(null);
    } finally {
      this.transportStarting = false;
    }
  }

  private endTransport() {
    this.transport = null;
    this.transportCooldown = 0.8;
    this.story?.setTransporting(false);
    this.transportInside = null;
    this.speed = 0;
  }

  private sampleTransports() {
    const p = this.controller.position;
    return new Map(this.transports.map((d) => [d.id, transportAt([d], p) !== null]));
  }

  /** Jumps fire when the player walks into their trigger sphere. */
  private updateAutoTransports(dt: number) {
    this.transportCooldown = Math.max(0, this.transportCooldown - dt);
    if (!this.transports.length || this.transport || this.loadingMap) return;
    const now = this.sampleTransports();
    const prev = this.transportInside;
    this.transportInside = now;
    if (!prev || this.transportCooldown > 0 || !this.transportAvailable()) return;
    const hit = this.transports.find((d) => firesOnTouch(d) && now.get(d.id) && !prev.get(d.id));
    if (hit) void this.startTransport(hit);
  }

  private transportFocus(): Interactable | null {
    if (!this.transportAvailable()) return null;
    const d = transportAt(
      this.transports.filter((t) => !firesOnTouch(t)),
      this.controller.position,
    );
    return d ? { kind: 'transport', def: d, label: transportLabel(d) } : null;
  }

  private updateFocus() {
    const p = this.controller.position;
    let f: Interactable | null = null;
    if (this.transport) {
      this.focus = null;
      this.ui.setPrompt(null);
      return;
    }
    if (this.story) {
      const sp = this.story.prompt();
      this.focus = sp ? { kind: 'story', prompt: sp, label: sp.label } : this.transportFocus();
      return;
    }
    const npc = nearestNpc(this.npcs, p);
    if (npc) f = { kind: 'npc', npc, label: `Talk to <b>${escapeHtml(npc.entry.name)}</b>` };
    if (!f) {
      for (const x of this.exits) {
        if (x.position.distanceTo(p) < 1.8) f = { kind: 'exit', exit: x, label: `Go to <b>${escapeHtml(x.title)}</b>` };
      }
    }
    if (!f) f = this.transportFocus();
    if (!f) {
      const spot = this.boxes?.nearest(p);
      if (spot) f = { kind: 'treasure', id: spot.id, label: 'Open <b>treasure box</b>' };
    }
    if (!f && this.map) {
      for (const g of this.map.gimmicks) {
        const flat = new THREE.Vector3(g.position.x - p.x, 0, g.position.z - p.z).length();
        if (flat < 3 && Math.abs(g.position.y - p.y) < 4) {
          f = { kind: 'gimmick', gimmick: g, label: `${g.state === 'closed' ? 'Use' : 'Reset'} <b>${escapeHtml(g.name.replace(/^prop_/, ''))}</b>` };
        }
      }
    }
    this.focus = f;
  }
}

function readStoryMode() {
  try {
    return localStorage.getItem(STORY_MODE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeStoryMode(on: boolean) {
  try {
    localStorage.setItem(STORY_MODE_KEY, on ? '1' : '0');
  } catch {
    /* private mode */
  }
}

/** The URL hash this tab's app wrote last (sessionStorage survives a reload, not a new tab). */
function markOwnHash(hash: string) {
  try {
    sessionStorage.setItem('ff7ec.ownHash', hash);
  } catch {
    /* private mode */
  }
}

function ownHash() {
  try {
    return sessionStorage.getItem('ff7ec.ownHash') === location.hash;
  } catch {
    return false;
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** A slowly spinning ring + light shaft with a floating label. */
function exitMarker(title: string) {
  const g = new THREE.Group();
  g.name = `exit:${title}`;
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.7, 0.05, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.85 }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.05;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.65, 0.65, 2.4, 32, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x7fe0ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  beam.position.y = 1.2;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,14,24,0.75)';
  ctx.fillRect(0, 0, 512, 96);
  ctx.strokeStyle = '#7fe0ff';
  ctx.strokeRect(2, 2, 508, 92);
  ctx.fillStyle = '#e8f6ff';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title.length > 28 ? `${title.slice(0, 27)}…` : title, 256, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  label.scale.set(2.4, 0.45, 1);
  label.position.y = 2.7;
  label.renderOrder = 50;
  g.add(ring, beam, label);
  return g;
}

async function boot() {
  await ensureAssets(); // hosted / local mode: the player's extracted game folder (platform/firstrun.ts)
  const app = new App();
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) (window as unknown as { app: App }).app = app;
  instrument(app); // opt-in play statistics (platform/telemetry.ts); no-op unless enabled
  startTelemetry();
  await app.start();
  startAutoBackup();
  void checkForUpdates((msg) => app.ui.toast(msg, 8000));
}
boot().catch((e) => {
  console.error(e);
  document.getElementById('ui')!.append(Object.assign(document.createElement('pre'), { className: 'fatal', textContent: String(e?.stack ?? e) }));
});
