/**
 * generated/effects/*.json (tools/convert_effects.py): EC's Unity ParticleSystem prefabs, in Unity's own (left-handed)
 * space. The player mirrors x once at each effect's root, like the GLB conversion.
 */

/** number = constant, [a, b] = random between, {c} = curve over 0..1, {c, d} = random between two curves. */
export type Curve = number | [number, number] | { c: number[]; d?: number[] };

/** [r, g, b, a] constant, {a, b} random between, {g} gradient (flat rgba samples), {g, h} random between two, {g, rand} random colour. */
export type Gradient = number[] | { a: number[]; b: number[] } | { g: number[]; h?: number[]; rand?: number };

export interface TexRef {
  url: string;
  /** Unity wrap mode repeat (else clamp) */
  repeat?: number;
  /** _ST: scale x, y, offset x, y */
  st?: [number, number, number, number];
}

export interface EffectMaterial {
  name: string;
  /** std = Applibot/Particles/Standard (and Dissolve), lit = Command/Particle/CommandParticleLit, urp = URP
   * Particles/Unlit, distort = Applibot/Particles/Distortion (GrabPass), not drawn */
  shader: 'std' | 'lit' | 'urp' | 'distort';
  tex?: TexRef;
  color?: number[];
  /** Unity BlendMode factors [src, dst] */
  blend: [number, number];
  mask?: TexRef;
  maskPow?: number;
  maskRot?: number;
  dist?: TexRef;
  distPow?: number;
  distRot?: number;
  distMask?: number;
  rgbAlpha?: number;
  height?: [number, number];
  soft?: number;
  rim?: [number, number];
  rimColor?: number[];
  emis?: TexRef;
  emisColor?: number[];
  emisPow?: number;
  texRot?: number;
  dissolveTex?: TexRef;
  dissolve?: number;
  dissolveEdge?: number;
  dissolveInv?: number;
  vertexAlpha?: number;
  lit?: number;
  mag?: number;
  alpha?: number;
  /** param -> coord * 4 + swizzle (coord 0 Custom1, 1 Custom2) */
  coords?: Record<string, number>;
  cull?: number;
  zwrite?: number;
  ztest?: number;
  zoffset?: number;
  queue?: number;
  clip?: number;
}

export interface Shape {
  type: number;
  radius: number;
  radiusMode?: [number, number, Curve];
  arc: number;
  arcMode?: [number, number, Curve];
  angle?: number;
  length?: number;
  donut?: number;
  thick?: number;
  randDir?: number;
  sphDir?: number;
  randPos?: number;
  align?: number;
  pos?: number[];
  rot?: number[];
  scale?: number[];
  boxThick?: number[];
  mesh?: string;
  meshMode?: number;
}

export interface Renderer {
  /** 0 billboard, 1 stretched, 2 horizontal, 3 vertical, 4 mesh, 5 none */
  mode: number;
  /** 0 view, 1 world, 2 local, 3 facing, 4 velocity */
  align?: number;
  mat: number | null;
  trailMat?: number | null;
  meshes?: string[];
  len?: number;
  vel?: number;
  camVel?: number;
  freeform?: number;
  fudge?: number;
  sort?: number;
  order?: number;
  minSize?: number;
  maxSize?: number;
  pivot?: number[];
  flip?: number[];
  off?: number;
}

export interface SystemDef {
  node: number;
  dur: number;
  loop: number;
  prewarm?: number;
  delay?: Curve;
  simSpeed?: number;
  /** 0 local, 1 world */
  space: number;
  scaling?: number;
  life: Curve;
  speed: Curve;
  size?: Curve;
  size3?: [Curve, Curve, Curve];
  rot?: Curve;
  rot3?: [Curve, Curve, Curve];
  flipRot?: number;
  color?: Gradient;
  grav?: Curve;
  max: number;
  emit: { rate?: Curve; dist?: Curve; bursts?: [number, Curve, number, number, number][] };
  shape?: Shape;
  vel?: { x?: Curve; y?: Curve; z?: Curve; orbital?: [Curve, Curve, Curve]; offset?: [Curve, Curve, Curve]; radial?: Curve; speedMod?: Curve; world?: number };
  limit?: { dampen: number; mag?: Curve; xyz?: [Curve, Curve, Curve]; world?: number; drag?: Curve; dragSize?: number; dragVel?: number };
  force?: { x: Curve; y: Curve; z: Curve; world?: number };
  inherit?: [number, Curve];
  col?: Gradient;
  sol?: Curve | [Curve, Curve, Curve];
  rol?: Curve | [Curve, Curve, Curve];
  sbs?: [Curve, number, number];
  rbs?: [Curve, number, number];
  cbs?: [Gradient, number, number];
  uv?: { tx: number; ty: number; fot: Curve; cycles: number; start?: Curve; row?: number; rowMode?: number; timeMode?: number; fps?: number; speedRange?: [number, number]; flip?: [number, number] };
  noise?: { str: Curve | [Curve, Curve, Curve]; freq: number; scroll: Curve; damp: number; oct: number; pos: Curve; rot?: Curve; size?: Curve };
  custom?: ({ v: Curve[] } | { c: Gradient } | null)[];
  sub?: { ps: number; type: number; props: number; prob: number }[];
  isSub?: number;
  trail?: {
    mode: number; ratio: number; life: Curve; minDist: number; tex: number; world: number; die: number;
    sizeWidth: number; inheritColor: number; color: Gradient; width: Curve; colorTrail: Gradient;
  };
  r: Renderer;
}

export interface EffectNode {
  n: string;
  p: number;
  t?: number[];
  r?: number[];
  s?: number[];
  off?: number;
  ps?: number;
  mesh?: { mesh: string; mat: number };
  /** Billboard script: fixedAxisType, lookAt, direction, inverted */
  bb?: number[];
  light?: number[];
}

export interface EffectDef {
  v: number;
  key: string;
  dur: number;
  loop: number;
  nodes: EffectNode[];
  systems: SystemDef[];
  mats: EffectMaterial[];
}

export interface MeshData {
  p: number[];
  n?: number[];
  uv?: number[];
  c?: number[];
  i: number[];
}

/** bodies.json: battle model -> attach points (TransformType -> [node, parent, Unity local pos, quat]). */
export interface BodyDef {
  points: Record<string, [string, string | null, number[], number[]]>;
  customs: [string, string | null, number[], number[]][];
  equip: Record<string, string | null>;
  effectScale: number;
  offsetScale: number;
  between: number[];
  size?: number;
}

export interface StagePlacement {
  name: string;
  t: number[];
  r: number[];
  s: number[];
  fx: EffectDef;
}
