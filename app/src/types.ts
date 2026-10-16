// Shapes of the JSON produced by tools/*.py.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** generated/layout/<key>.json — tools/extract_dungeon_maps.py */
export interface Layout {
  key: string;
  cameras: CaptureCamera[];
  cameraAreas: CameraArea[];
  startPoints: { name: string; position: Vec3; quaternion: Quat }[];
  collision: { name: string; kind: 'floor' | 'wall' | 'other'; collider: string; positions: number[]; indices: number[] }[];
  gimmicks: { name: string; path: string }[];
  gimmickClips: string[];
  defaultCameras: string[];
  fallY?: number;
  environment: null | {
    skyColor?: Vec3;
    equatorColorPlusX?: Vec3;
    groundColor?: Vec3;
    fogColor?: Vec3;
    silhouetteColor?: Vec3;
    useFog?: number;
    fogStart?: number;
    fogEnd?: number;
  };
}

/** generated/lighting/<key>.json — tools/extract_lighting.py (glTF space; colours as stored by Unity, gamma). */
export interface StageLighting {
  key: string;
  /** EnvironmentData (dat_env_*): every non-reference field. */
  env: null | {
    affectAmbient?: number;
    skyColor?: Vec3;
    equatorColorPlusX?: Vec3;
    equatorColorMinusX?: Vec3;
    equatorColorPlusZ?: Vec3;
    equatorColorMinusZ?: Vec3;
    groundColor?: Vec3;
    saturation?: number;
    brightness?: number;
    affectFog?: number;
    useFog?: number;
    fogStartDistance?: number;
    fogEndDistance?: number;
    fogColor?: Vec3;
    additionalLightPower?: number;
    affectShadowColor?: number;
    shadowColor?: Vec3;
    shadowColorIntensity?: number;
    [k: string]: unknown;
  };
  render: null | {
    fog: boolean;
    fogMode: number;
    fogColor: Vec3;
    fogStart: number;
    fogEnd: number;
    fogDensity: number;
    ambientMode: number;
    ambientIntensity: number;
    ambientSky: Vec3;
    ambientEquator: Vec3;
    ambientGround: Vec3;
    subtractiveShadowColor: Vec3;
  };
  /** Realtime and mixed lights (baked ones only exist in the lightmaps). */
  lights: {
    name: string;
    type: 'directional' | 'point' | 'spot' | 'area' | number;
    active: boolean;
    mode: 'realtime' | 'mixed' | number;
    position: Vec3;
    /** Where the light shines (Unity forward axis). */
    direction: Vec3;
    color: Vec3;
    intensity: number;
    range: number;
    spotAngle: number;
    shadows: 'none' | 'hard' | 'soft' | null;
    shadowStrength: number;
    shadowNormalBias: number;
  }[];
  /** Post-processing volume components: parameter -> value (+ whether the profile overrides it). */
  post: Record<string, Record<string, { value: unknown; override: boolean }>>;
  gi: { lightmaps?: number; lightmapsMode?: number; m_IndirectOutputScale?: number; [k: string]: unknown };
}

/** A pre-rendered background view: perspective capture, vertical FOV `captureFov`, 2:1 texture. */
export interface CaptureCamera {
  name: string;
  object: string;
  position: Vec3;
  quaternion: Quat;
  captureFov: number;
  maxVerticalAngle: number;
  maxHorizontalAngle: number;
  color: string | null;
  depthA: string | null;
  depthB: string | null;
  lensFov?: number;
  near?: number;
  far?: number;
  /** Colour image width / height (2 for almost all captures, 1 for a few). */
  aspect?: number;
  /** PlaneEnvironmentCamera._upDirection; 0 = world up. */
  upDirection?: number;
}

export interface CameraArea {
  object: string;
  camera: string;
  fadeCameras: string[];
  boxes: { center: Vec3; size: Vec3; quaternion: Quat }[];
}

/** generated/maps.json — tools/build_manifest.py */
export interface MapEntry {
  key: string;
  kind: 'dungeon' | 'environment' | string;
  glb: string;
  title: string;
  groups: string[];
  episodes?: EpisodeRef[];
  bgm?: BgmRef[];
  exits?: ExitRef[];
}

export interface EpisodeRef {
  id: string | number;
  title?: string;
  family?: string;
  chapter?: string;
  section?: string;
}
export interface BgmRef {
  id: string;
  url: string;
  title?: string | null;
}
export interface ExitRef {
  to: string;
  via?: string;
  /** Start point index in the destination map (start_point_{N+1}). */
  startPointIndex?: number;
  /** Approximate trigger location in this map, glTF space. */
  returnPosition?: { x: number; y: number; z: number };
  walkTrigger?: boolean;
}

export interface NpcEntry {
  characterId: string | number;
  name: string;
  glb: string;
  positions?: { x: number; y: number; z: number; rotY?: number; sceneId?: string }[];
}

export interface DialogueLine {
  sceneId?: string;
  speaker?: string;
  text: string;
}

/** generated/maps/<key>.json */
export interface MapDetail extends MapEntry {
  /** Visible-geometry bounds in glTF space. */
  bounds?: { min: Vec3; max: Vec3 };
  npcs?: NpcEntry[];
  dialogue?: Record<string, DialogueLine[]>;
  lore?: {
    episodes?: EpisodeRef[];
    enemies?: (string | { name: string })[];
    scenes?: ({ id: string; title?: string } | string)[];
  };
}

export interface CharacterVariant {
  id?: string;
  glb: string;
  label?: string;
  costume?: string;
  name?: string;
  characterId?: string | number;
}

/** generated/characters.json */
export interface CharactersManifest {
  field: { name: string; characterId?: string | number; variants: CharacterVariant[] }[] | CharacterVariant[];
  battle: CharacterVariant[] | { name: string; variants: CharacterVariant[] }[];
}

export interface MusicTrack {
  id: string;
  title?: string | null;
  url: string;
  usedBy?: string[];
  loopStart?: number | null;
  loopEnd?: number | null;
}

/** generated/anims/index.json — tools/convert_anims.py */
export interface AnimClipEntry {
  name: string;
  file: string;
  duration: number;
  role: string;
  loop?: boolean;
  rootMotion?: { bone: string; delta: Vec3; speed: number; yawDelta: number; stripped: boolean };
}

export interface AnimIndex {
  families: Record<
    string,
    {
      models: string[];
      clips: AnimClipEntry[];
      locomotion?: Partial<Record<'idle' | 'walk' | 'run', string | null>>;
    }
  >;
  shared?: Record<string, { clips: AnimClipEntry[] }>;
  /** Keyed by GLB path relative to the Mods library, e.g. "unity/questcharacter/001/model/001/model.glb". */
  models?: Record<string, { family: string; locomotionFiles?: Partial<Record<'idle' | 'walk' | 'run', string | null>> }>;
}
