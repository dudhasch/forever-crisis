// Shapes of generated/scripts/* (tools/build_scripts.py; see generated/scripts/SPEC.md).
import { fetchJSON, tryJSON } from '../assets';

export interface MotionDef {
  in?: string;
  loop?: string;
  out?: string;
  type: number;
}

export interface CharacterDef {
  glb: string | null;
  name: string;
  motions?: Record<string, MotionDef>;
  locomotion?: Partial<Record<'idle' | 'walk' | 'run', string>>;
}

export interface Shape {
  shape: 'box' | 'sphere' | 'capsule';
  center: number[];
  size?: number[];
  quaternion?: number[];
  radius?: number;
  height?: number;
  enabled?: boolean;
}

export interface TriggerDef {
  type: string;
  triggerId: number;
  object: string;
  active: boolean;
  position: number[];
  rotY: number;
  script?: string;
  auto: boolean;
  autoOnExit: boolean;
  oneShot: boolean;
  priority: number;
  shapes: Shape[];
  tapAreas?: Shape[];
  params?: Record<string, unknown>;
  changeMap?: { map: number; content: number; startPointIndex: number };
  approach?: { position: number[]; rotY: number; duration: number };
  marker?: { type: number };
}

export interface Behaviour {
  kind: string;
  delay?: number;
  clip?: string;
  file?: string;
  blendDuration?: number;
  target?: string;
  active?: number;
  se?: string;
  url?: string;
}

export interface GimmickDef {
  object: string;
  node: string;
  defaultStatus: string | null;
  statuses: Record<string, Behaviour[]>;
}

export interface BattleDef {
  id: number;
  storyBattle?: boolean;
  /** m_battle ids: story-party battle first. */
  battleIds?: number[];
  enemies?: string[];
}

export interface StartPointDef {
  index: number;
  script: string | null;
  node: string | null;
  /** Missing when the start point has no scene node (some arrival scripts only need the script). */
  position?: number[];
  quaternion?: number[];
}

export interface ContentData {
  map: string;
  mapId: number;
  content: string;
  contentId: number;
  setup: string | null;
  startPoints: StartPointDef[];
  triggers: TriggerDef[];
  defineOrder: string[];
  defineFiles: Record<string, string>;
  files: Record<string, string>;
  characters: Record<string, CharacterDef> | null;
  languageTexts: Record<string, string> | null;
  locationNames: Record<string, string> | null;
  gimmicks: Record<string, GimmickDef> | null;
  se: Record<string, string | null> | null;
  bgm: Record<string, { url: string; duration?: number; loopStart?: number; loopEnd?: number }> | null;
  movies: Record<string, string> | null;
  backgrounds: Record<string, string> | null;
  battles: Record<string, BattleDef> | null;
}

export interface IndexContent {
  id: string;
  contentId: number;
  kind: string;
  file: string;
  scripts: string[];
  title?: string;
  storyOrder?: number;
  episode?: { id: number; title: string; subTitle?: string; chapter?: string; section?: string; family?: string };
}

export interface StoryStep {
  order: number;
  episodeId: number;
  map: string;
  mapId: number;
  content: string;
  contentId: number;
  startPointIndex: number;
  hasScripts: boolean;
  title: string;
  chapter?: string;
  section?: string;
  family?: string;
}

export interface EpisodeDef {
  id: number;
  title: string;
  controlCharacter?: number;
}

export interface StoryIndex {
  maps: Record<string, { mapId: number; storyContent: string | null; contents: IndexContent[] }>;
  story: StoryStep[];
  episodes: EpisodeDef[];
}

export interface GlobalLib {
  loadOrder: string[];
  files: Record<string, string>;
}

let index: Promise<StoryIndex | null> | null = null;
export function storyIndex() {
  index ??= tryJSON<StoryIndex>('/gen/scripts/index.json');
  return index;
}

let lib: Promise<GlobalLib> | null = null;
export function globalLib() {
  lib ??= fetchJSON<GlobalLib>('/gen/scripts/global.json');
  return lib;
}

export function loadContent(map: string, content: string) {
  return fetchJSON<ContentData>(`/gen/scripts/${map}/${content}.json`);
}

export function mapKeyOf(mapId: number) {
  return `dungeon_map_${String(mapId).padStart(4, '0')}`;
}

/** contentId 2 -> "002" (the file name the index uses for it). */
export async function contentKey(mapKey: string, contentId: number) {
  const idx = await storyIndex();
  return idx?.maps[mapKey]?.contents.find((c) => c.contentId === contentId)?.id ?? String(contentId).padStart(3, '0');
}

/** Save state: content flags, story flags, counters (localStorage unless it is a throwaway replay). */
export class StoryFlags {
  private data: {
    content: Record<string, number[]>;
    flags: number[];
    ints: Record<string, number>;
    contentInts: Record<string, Record<string, number>>;
    opened: number[];
  } = { content: {}, flags: [], ints: {}, contentInts: {}, opened: [] };
  /** Bumped on every change, so cached trigger checks know to re-run. */
  version = 0;

  constructor(private readonly key: string | null) {
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch {
      /* private mode or bad JSON: start fresh */
    }
  }

  private save() {
    this.version++;
    if (!this.key) return;
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* ignore */
    }
  }

  contentFlag(content: string, n: number) {
    return this.data.content[content]?.includes(n) ?? false;
  }

  setContentFlag(content: string, n: number, v: boolean) {
    const list = (this.data.content[content] ??= []);
    const has = list.includes(n);
    if (v && !has) list.push(n);
    if (!v && has) list.splice(list.indexOf(n), 1);
    this.save();
  }

  flag(n: number) {
    return this.data.flags.includes(n);
  }

  setFlag(n: number, v: boolean) {
    const has = this.data.flags.includes(n);
    if (v && !has) this.data.flags.push(n);
    if (!v && has) this.data.flags.splice(this.data.flags.indexOf(n), 1);
    this.save();
  }

  int(k: string) {
    return this.data.ints[k] ?? 0;
  }

  setInt(k: string, v: number) {
    this.data.ints[k] = v;
    this.save();
  }

  contentInt(content: string, k: string) {
    return this.data.contentInts[content]?.[k] ?? 0;
  }

  setContentInt(content: string, k: string, v: number) {
    (this.data.contentInts[content] ??= {})[k] = v;
    this.save();
  }

  opened(id: number) {
    return this.data.opened.includes(id);
  }

  setOpened(id: number) {
    if (!this.data.opened.includes(id)) this.data.opened.push(id);
    this.save();
  }

  clearContent(content: string) {
    delete this.data.content[content];
    delete this.data.contentInts[content];
    this.save();
  }

  clearAll() {
    this.data = { content: {}, flags: [], ints: {}, contentInts: {}, opened: [] };
    this.save();
  }

  /** Everything, for a save slot. */
  snapshot(): unknown {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** Replace everything with a save slot's snapshot. */
  restore(snap: unknown) {
    this.data = { content: {}, flags: [], ints: {}, contentInts: {}, opened: [], ...((snap as Partial<typeof this.data>) ?? {}) };
    this.save();
  }

  /** A copy that forgets everything it is told (cutscene replays). */
  sandbox() {
    const s = new StoryFlags(null);
    s.data = JSON.parse(JSON.stringify(this.data));
    return s;
  }
}
