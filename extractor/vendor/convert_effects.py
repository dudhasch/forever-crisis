# Vendored from explorer/tools/convert_effects.py by release-tools/sync_vendor.py - do not edit here.
"""FF7 Ever Crisis particle effects (Unity ParticleSystem prefabs) -> explorer/generated/effects/.

Run with the UnityPy venv (a few minutes for everything):

    python tools\\convert_effects.py
        [--only battle/character/ch001,environment] [--force] [--no-stages]

Writes ONLY under generated/effects/:
    <group>/<bundle>/<prefab>.json   one effect prefab (keys below), e.g. battle/character/ch001/pfb_eff_wp_ch001_0035_hit01
    meshes/<name>_<id>.json          meshes used by mesh-mode particles, mesh shapes and plain MeshRenderers
    tex/<name>_<id>.png              textures that are not already extracted to 03-ExtractedAssets
    stages/<environment>.json        ambient effects placed in the environment_NNNN battle scenes (FieldEffect)
    fields/dungeon_map_NNNN.json     particle systems placed in the field map scenes (no FieldEffect there: every
                                     top-most active GameObject with a ParticleSystem)
    bodies.json                      per battle model: TransformType attach points -> bones (CharacterBody)
    index.json                       effect key -> file, stage list, stats

Sources: 02-DecodedBundles/effect/{battle/{character,monster,summonskill,common},environment,dungeonmap}/*.d (the
prefabs, their ParticleSystem / ParticleSystemRenderer / Material objects), effect/textures/*.d and effect/meshes/*.d
(shared textures and meshes, resolved through converters/catalog/cab-index.json), and
scenes/environment_NNNN.s for the stage ambience (GameObjects with a FieldEffect component, ParticleSystems inline).

Format (version 1). Everything stays in Unity's left-handed space; the runtime puts each effect under one node with
scale (-1, 1, 1), the same x mirror as the GLB conversion (unity_gltf.py: pos (-x, y, z), quat (x, -y, -z, w)).
    {v, key, dur, loop, nodes: [{n, p (parent index), t, r (quat xyzw), s, off?, ps? (system index), mesh?, bb?}],
     systems: [...], mats: [...]}
Curves ("MinMaxCurve"): number = constant; [a, b] = random between two constants; {c: [...]} = curve sampled at
SAMPLES even steps over 0..1 (already multiplied by the scalar); {c, d} = random between two curves.
Gradients ("MinMaxGradient"): [r, g, b, a] = constant; {a, b} = random between two colours; {g: flat rgba samples} =
gradient; {g, h} = random between two gradients; {g, rand: 1} = random colour from a gradient. Colours are linear
(sRGB keys converted), alpha untouched.

Materials follow the game's "Applibot/Particles/Standard" shader. Its D3D11 programs (shaders.d, disassembled with
d3dcompiler) give the maths the runtime copies:
    uv = rotate(uv0 - .5, _TexRotate + c) + .5) * _MainTex_ST.xy + _MainTex_ST.zw + (cU, cV)   (mask, dist the same)
    c* = custom vertex data picked by <Param>Coord (0 Custom1, 1 Custom2, 2 none) and <Param>Swizzle (x, y, z, w)
    USE_DISTORTION:   uv += dist.r * (_DistPow + c)
    USE_MASK:         a *= pow(mask.r, max(_MaskPow + c, 0.001))
    BLEND_RATE_FROM_RGB: rgb = vertex * _Color, a = avg(tex.rgb) * vertex.a * _Color.a  (else rgb *= tex.rgb, a *= tex.a)
    rgb *= _ColorMagnification + c;  a *= _ResultMultiplyAlpha;  blend _BlendSrc/_BlendDst (Unity BlendMode)
"""
import os as _os
from pathlib import Path as _P
import argparse, collections, json, math, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert_anims as ca  # noqa: E402  (bundle access, CAB index, UnityPy)

ASSETS = _P(_os.environ['FFCX_ARCHIVE'])
BUNDLES = ASSETS / '02-DecodedBundles'
EXTRACTED = _P(_os.environ['FFCX_EXTRACTED'])
OUT = _P(_os.environ['FFCX_GEN']) / 'effects'
VERSION = 1
SAMPLES = 16
GROUPS = ('effect/battle/character', 'effect/battle/monster', 'effect/battle/summonskill', 'effect/battle/common',
          'effect/environment', 'effect/dungeonmap')
DIGITS = 4


def effect_key(rel, name):
    """Effect key of prefab `name` in bundle `rel` ('effect/battle/character/ch001.d' -> 'battle/character/ch001/name')."""
    base = rel[len('effect/'):] if rel.startswith('effect/') else rel
    if base.endswith('.d'):
        base = base[:-2]
    return '%s/%s' % (base, name)


def rnd(x, d=DIGITS):
    x = float(x)
    if not math.isfinite(x):   # a few curves carry NaN / infinite keys: Unity treats them as 0 / clamps
        x = 0.0 if math.isnan(x) else math.copysign(1e6, x)
    x = round(x, d)
    return int(x) if x == int(x) and abs(x) < 1e9 else x


def v3(x):
    return [rnd(x['x']), rnd(x['y']), rnd(x['z'])]


# ---------------------------------------------------------------------------------------------- curves
def eval_curve(keys, t):
    """Unity AnimationCurve (hermite, clamped ends; weights ignored)."""
    if not keys:
        return 0.0
    if t <= keys[0]['time']:
        return keys[0]['value']
    if t >= keys[-1]['time']:
        return keys[-1]['value']
    for a, b in zip(keys, keys[1:]):
        if a['time'] <= t <= b['time']:
            dt = b['time'] - a['time']
            if dt <= 1e-9:
                return b['value']
            m0, m1 = a['outSlope'], b['inSlope']
            if not (math.isfinite(m0) and math.isfinite(m1)):
                return a['value']
            s = (t - a['time']) / dt
            s2, s3 = s * s, s * s * s
            return ((2 * s3 - 3 * s2 + 1) * a['value'] + (s3 - 2 * s2 + s) * m0 * dt
                    + (-2 * s3 + 3 * s2) * b['value'] + (s3 - s2) * m1 * dt)
    return keys[-1]['value']


def sample(keys, mul=1.0, digits=DIGITS):
    return [rnd(eval_curve(keys, i / (SAMPLES - 1)) * mul, digits) for i in range(SAMPLES)]


def mm(x, mul=1.0):
    """MinMaxCurve -> compact form (see module doc)."""
    if x is None:
        return 0
    st = x.get('minMaxState', 0)
    sc = x.get('scalar', 1.0) * mul
    if st == 0:
        return rnd(sc)
    if st == 3:
        a, b = rnd(x.get('minScalar', 0) * mul), rnd(sc)
        return a if a == b else [a, b]
    c = sample(x['maxCurve']['m_Curve'], sc)
    if st == 1:
        return c[0] if len(set(c)) == 1 else {'c': c}
    d = sample(x['minCurve']['m_Curve'], sc)
    if c == d:
        return c[0] if len(set(c)) == 1 else {'c': c}
    return {'c': c, 'd': d}


def mm_zero(v):
    return v == 0 or v == [0, 0]


def srgb_to_linear(c):
    c = max(0.0, c)
    if c > 1:  # HDR colour: keep the boost, linearise the base
        return c ** 2.2
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def color(c):
    return [rnd(srgb_to_linear(c['r']), 3), rnd(srgb_to_linear(c['g']), 3), rnd(srgb_to_linear(c['b']), 3),
            rnd(c['a'], 3)]


def eval_gradient(g, t):
    nc, na = max(1, g['m_NumColorKeys']), max(1, g['m_NumAlphaKeys'])
    fixed = g.get('m_Mode', 0) == 1

    def pick(times, vals, n):
        if t <= times[0] or n == 1:
            return vals[0]
        for i in range(n - 1):
            t0, t1 = times[i], times[i + 1]
            if t <= t1:
                if fixed:
                    return vals[i + 1]
                k = 0 if t1 <= t0 else (t - t0) / (t1 - t0)
                return [a + (b - a) * k for a, b in zip(vals[i], vals[i + 1])]
        return vals[n - 1]

    ct = [g['ctime%d' % i] / 65535 for i in range(nc)]
    at = [g['atime%d' % i] / 65535 for i in range(na)]
    cv = [[g['key%d' % i][k] for k in 'rgb'] for i in range(nc)]
    av = [[g['key%d' % i]['a']] for i in range(na)]
    rgb = pick(ct, cv, nc)
    a = pick(at, av, na)[0]
    return {'r': rgb[0], 'g': rgb[1], 'b': rgb[2], 'a': a}


def gradient_samples(g):
    out = []
    for i in range(SAMPLES):
        out.extend(color(eval_gradient(g, i / (SAMPLES - 1))))
    if all(out[j] == out[j % 4] for j in range(len(out))):
        return out[:4]
    return out


def grad(x):
    st = x.get('minMaxState', 0)
    if st == 0:
        return color(x['maxColor'])
    if st == 2:
        a, b = color(x['minColor']), color(x['maxColor'])
        return a if a == b else {'a': a, 'b': b}
    g = gradient_samples(x['maxGradient'])
    if st == 1:
        return g if len(g) == 4 else {'g': g}
    if st == 4:
        return {'g': g if len(g) > 4 else g * SAMPLES, 'rand': 1}
    h = gradient_samples(x['minGradient'])
    if g == h:
        return g if len(g) == 4 else {'g': g}
    return {'g': g if len(g) > 4 else g * SAMPLES, 'h': h if len(h) > 4 else h * SAMPLES}


def white(g):
    return g == [1, 1, 1, 1] or g == [1.0, 1.0, 1.0, 1.0]


# ---------------------------------------------------------------------------------------------- object graph
class Graph:
    """Typetrees + PPtr resolution over bundles (key = (bundle rel, path id)) and, optionally, one scene bundle
    (key = (serialized file name, path id)) whose externals go through the CAB index."""

    def __init__(self, scene=None):
        self.scene = scene

    def _scene_key(self, key):
        return self.scene is not None and key[0] in self.scene.files

    def obj(self, key):
        if self._scene_key(key):
            return self.scene.objects.get(key)
        return ca.bundle(key[0]).objects.get(key[1])

    def tree(self, key):
        if self._scene_key(key):
            return self.scene.tree(key)
        b = ca.bundle(key[0])
        if key[1] not in b.objects:
            return {}
        try:
            return b.tree(key[1])
        except Exception:
            return {}

    def type(self, key):
        o = self.obj(key)
        return o.type.name if o is not None else None

    def ref(self, key, ptr):
        if not ptr or not ptr.get('m_PathID'):
            return None
        if self._scene_key(key):
            k = self.scene.ref(key, ptr)
            if not k:
                return None
            if k[0] in self.scene.files:
                return k
            rel = ca.cab_index().get(k[0].lower())
            return (rel, k[1]) if rel else None
        return ca.deref(ca.bundle(key[0]), ptr)

    def name(self, key):
        o = self.obj(key)
        try:
            return o.peek_name() if o is not None else ''
        except Exception:
            return self.tree(key).get('m_Name', '')

    def script(self, key):
        t = self.tree(key)
        s = self.ref(key, t.get('m_Script'))
        return self.tree(s).get('m_ClassName', '') if s else ''


# ---------------------------------------------------------------------------------------------- textures / meshes
class Store:
    def __init__(self):
        self.inventories = {}
        self.textures = {}
        self.meshes = {}
        self.stats = collections.Counter()

    def inventory(self, rel):
        if rel not in self.inventories:
            d = EXTRACTED / rel[:-2] if rel.endswith('.d') else EXTRACTED / rel
            inv = {}
            p = d / '_bundle_inventory.json'
            if p.exists():
                for o in json.loads(p.read_text(encoding='utf8'))['objects']:
                    inv[o['path_id']] = o
            self.inventories[rel] = (d, inv)
        return self.inventories[rel]

    def texture(self, g, key):
        """URL of a Texture2D (the extracted PNG when there is one) + wrap mode."""
        if key in self.textures:
            return self.textures[key]
        res = None
        o = g.obj(key)
        if o is not None and o.type.name == 'Texture2D':
            wrap = 1
            try:
                tex = o.read()
                ts = tex.m_TextureSettings
                wrap = 0 if (ts.m_WrapU == 0 or ts.m_WrapV == 0) else 1   # 0 repeat, 1 clamp
                name = tex.m_Name
            except Exception:
                tex, name = None, g.name(key)
            url = None
            if isinstance(key[0], str) and key[0].endswith('.d'):
                d, inv = self.inventory(key[0])
                for cand in ('%s.png' % name, '%s__pathid_%s.png' % (name, key[1])):
                    if (d / 'Texture2D' / cand).exists():
                        url = '/arc/03-ExtractedAssets/%s/Texture2D/%s' % (d.relative_to(EXTRACTED).as_posix(), cand)
                        break
            if not url and tex is not None:
                fn = '%s_%d.png' % (re.sub(r'[^A-Za-z0-9_.-]', '_', name), key[1] & 0xffffffff)
                p = OUT / 'tex' / fn
                if not p.exists():
                    try:
                        p.parent.mkdir(parents=True, exist_ok=True)
                        tex.image.save(p)
                        self.stats['tex-exported'] += 1
                    except Exception:
                        self.stats['tex-failed'] += 1
                        p = None
                if p is not None:
                    url = '/gen/effects/tex/%s' % fn
            if url:
                res = {'url': url, 'repeat': wrap == 0}
        if res is None:
            self.stats['tex-missing'] += 1
        self.textures[key] = res
        return res

    def mesh(self, g, key):
        """Name of generated/effects/meshes/<name>.json for a Mesh object."""
        if key in self.meshes:
            return self.meshes[key]
        res = None
        o = g.obj(key)
        if o is not None and o.type.name == 'Mesh':
            try:
                m = o.read()
                name = '%s_%d' % (re.sub(r'[^A-Za-z0-9_.-]', '_', m.m_Name), key[1] & 0xffffffff)
                p = OUT / 'meshes' / (name + '.json')
                if not p.exists():
                    from UnityPy.helpers.MeshHelper import MeshHandler
                    h = MeshHandler(m)
                    h.process()
                    tris = [i for sm in h.get_triangles() for t in sm for i in t]
                    data = {'p': [rnd(c) for v in h.m_Vertices for c in v[:3]]}
                    if h.m_Normals:
                        data['n'] = [rnd(c, 3) for v in h.m_Normals for c in v[:3]]
                    if h.m_UV0:
                        data['uv'] = [rnd(c) for v in h.m_UV0 for c in v[:2]]
                    if h.m_Colors:
                        data['c'] = [rnd(c, 3) for v in h.m_Colors for c in v[:4]]
                    data['i'] = tris
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(json.dumps(data, separators=(',', ':')), encoding='utf8')
                    self.stats['meshes'] += 1
                res = name
            except Exception as e:
                self.stats['mesh-failed'] += 1
                print('  mesh %s: %s: %s' % (key, type(e).__name__, e))
        self.meshes[key] = res
        return res


# ---------------------------------------------------------------------------------------------- materials
STD_COORDS = {  # param -> material property prefix of <prefix>Coord / <prefix>Swizzle
    'mainU': '_MainU', 'mainV': '_MainV', 'texRot': '_TexRotate', 'maskU': '_MaskU', 'maskV': '_MaskV',
    'maskPow': '_MaskPow', 'maskRot': '_MaskTexRotate', 'distU': '_DistU', 'distV': '_DistV', 'distPow': '_DistPow',
    'distRot': '_DistTexRotate', 'mag': '_ColorMagnification', 'rimSharp': '_BlendRateRimSharpness',
    'dissolveU': '_DissolveU', 'dissolveV': '_DissolveV', 'dissolve': '_DissolveProgress',
    'edgeLum': '_DissolveEdgeLuminance', 'emisU': '_EmissionMapU', 'emisV': '_EmissionMapV',
    'emis': '_EmissionMapIntensity',
}


_SHADER_NAMES = {}


def shader_name(g, key, t):
    """Name of a material's shader (m_ParsedForm.m_Name; the objects carry no m_Name)."""
    sk = g.ref(key, t.get('m_Shader'))
    if not sk:
        return ''
    if sk not in _SHADER_NAMES:
        try:
            _SHADER_NAMES[sk] = g.obj(sk).read_typetree()['m_ParsedForm']['m_Name']
        except Exception:
            _SHADER_NAMES[sk] = ''
    return _SHADER_NAMES[sk]


def material(g, store, key):
    t = g.tree(key)
    if not t:
        return None
    props = t['m_SavedProperties']
    fl = dict(props['m_Floats'])
    cols = dict(props['m_Colors'])
    texs = dict(props['m_TexEnvs'])
    kw = set(t.get('m_ValidKeywords') or []) | set((t.get('m_ShaderKeywords') or '').split())

    def tex(name):
        e = texs.get(name)
        if not e:
            return None
        k = g.ref(key, e['m_Texture'])
        if not k:
            return None
        x = store.texture(g, k)
        if not x:
            return None
        out = {'url': x['url']}
        if x['repeat']:
            out['repeat'] = 1
        st = [rnd(e['m_Scale']['x']), rnd(e['m_Scale']['y']), rnd(e['m_Offset']['x']), rnd(e['m_Offset']['y'])]
        if st != [1, 1, 0, 0]:
            out['st'] = st
        return out

    m = {'name': t.get('m_Name', '')}
    sn = shader_name(g, key, t)
    store.stats['shader ' + (sn or '?')] += 1
    if 'Distortion' in sn:
        # GrabPass refraction of what is behind; drawn as nothing (its texture is a normal map)
        m['shader'] = 'distort'
    elif sn.endswith('CommandParticleLit'):
        m['shader'] = 'lit'
    elif sn.startswith('Universal Render Pipeline'):
        m['shader'] = 'urp'
    elif sn:
        m['shader'] = 'std'   # Applibot/Particles/Standard and Dissolve (same family, Dissolve adds the dissolve)
    elif '_DissolveTex' in texs and '_MaskPow' not in fl:
        m['shader'] = 'lit'
    elif '_BaseMap' in texs and '_MainTex' not in texs:
        m['shader'] = 'urp'
    else:
        m['shader'] = 'std'
    main = tex('_MainTex') or tex('_BaseMap')
    if main:
        m['tex'] = main
    col = cols.get('_Color') or cols.get('_BaseColor') or cols.get('_TintColor')
    if col:
        c = color(col)
        if c != [1, 1, 1, 1]:
            m['color'] = c
    # blend: Unity BlendMode factors (0 Zero, 1 One, 2 DstColor, 3 SrcColor, 4 OneMinusDstColor, 5 SrcAlpha,
    # 6 OneMinusSrcColor, 7 DstAlpha, 8 OneMinusDstAlpha, 9 SrcAlphaSaturate, 10 OneMinusSrcAlpha)
    if m['shader'] == 'urp':
        src, dst = int(fl.get('_SrcBlend', 5)), int(fl.get('_DstBlend', 10))
        if fl.get('_Surface', 1) == 0:
            src, dst = 1, 0
    else:
        src, dst = int(fl.get('_BlendSrc', fl.get('_SrcBlend', 5))), int(fl.get('_BlendDst', fl.get('_DstBlend', 10)))
    m['blend'] = [src, dst]
    if m['shader'] == 'std':
        if fl.get('_UseMask') and 'USE_MASK' in kw:
            mk = tex('_MaskTex')
            if mk:
                m['mask'] = mk
                m['maskPow'] = rnd(fl.get('_MaskPow', 1))
                if fl.get('_MaskTexRotate'):
                    m['maskRot'] = rnd(fl['_MaskTexRotate'])
        if fl.get('_UseDist') and 'USE_DISTORTION' in kw:
            dt = tex('_DistTex')
            if dt:
                m['dist'] = dt
                m['distPow'] = rnd(fl.get('_DistPow', 0))
                if fl.get('_DistTexRotate'):
                    m['distRot'] = rnd(fl['_DistTexRotate'])
                # DistTargets: 1 base map only (DISTORTION_TARGET_BASEMAP), otherwise base + mask
                m['distMask'] = 0 if 'DISTORTION_TARGET_BASEMAP' in kw else 1
        if fl.get('_UseBlendRateFromRGB') and 'BLEND_RATE_FROM_RGB' in kw:
            m['rgbAlpha'] = 1
        if fl.get('_UseBlendRateFromHeight') and 'BLEND_RATE_FROM_HEIGHT' in kw:
            m['height'] = [rnd(fl.get('_BlendRateHeightStartOffset', 0)), rnd(fl.get('_BlendRateHeightDistance', 1))]
        if fl.get('_UseBlendRateFromZ') and 'BLEND_RATE_FROM_Z' in kw:
            m['soft'] = rnd(fl.get('_BlendRateFromZPower', 1))
        if fl.get('_UseBlendRateFromRim') and 'BLEND_RATE_FROM_RIM' in kw:
            m['rim'] = [rnd(fl.get('_BlendRateRimSharpness', 1)), int(fl.get('_BlendRateRimInverse', 0))]
        if fl.get('_UseRimColor') and 'USE_RIM_COLOR' in kw:
            m['rimColor'] = color(cols.get('_RimColor', {'r': 1, 'g': 1, 'b': 1, 'a': 1})) + [
                rnd(fl.get('_RimSharpness', 1)), rnd(fl.get('_RimContrast', 1)), int(fl.get('_RimColorAdditionalMode', 0)),
                int(fl.get('_RimColorInverse', 0))]
        if fl.get('_UseEmissionMap') and 'USE_EMISSION_MAP' in kw:
            em = tex('_EmissionTex')
            if em:
                m['emis'] = em
                m['emisColor'] = color(cols.get('_EmissionColor', {'r': 1, 'g': 1, 'b': 1, 'a': 1}))
                m['emisPow'] = rnd(fl.get('_EmissionIntensity', 1))
        if fl.get('_TexRotate'):
            m['texRot'] = rnd(fl['_TexRotate'])
    if m['shader'] == 'lit' or 'Dissolve' in sn:
        dz = tex('_DissolveTex')
        if dz:
            m['dissolveTex'] = dz
            m['dissolve'] = rnd(fl.get('_DissolveProgress', 0))
            m['dissolveEdge'] = rnd(fl.get('_DissolveEdge', 0.1))
            m['dissolveInv'] = int(fl.get('_InverseDissolveTex', 0))
            m['vertexAlpha'] = int(fl.get('_VertexAlphaMode', 0))   # 0 vertex alpha drives dissolve, 1 plain alpha
    if m['shader'] == 'lit':
        em = cols.get('_EmissionColor')
        if em and fl.get('_EmissionIntensity', 0) > 0:
            ec = color(em)
            if ec[:3] != [0, 0, 0]:
                m['emisColor'] = ec
                m['emisPow'] = rnd(fl.get('_EmissionIntensity', 1))
        m['lit'] = 1
    mag = fl.get('_ColorMagnification', 1)
    if mag != 1:
        m['mag'] = rnd(mag)
    if fl.get('_ResultMultiplyAlpha', 1) != 1:
        m['alpha'] = rnd(fl['_ResultMultiplyAlpha'])
    coords = {}
    for p, prefix in STD_COORDS.items():
        c = fl.get(prefix + 'Coord', 2)
        if c in (0, 1):
            coords[p] = int(c) * 4 + int(fl.get(prefix + 'Swizzle', 0))
    if coords:
        m['coords'] = coords
    cull = fl.get('_CullMode', fl.get('_Cull', 0))
    if cull:
        m['cull'] = int(cull)   # UnityEngine.Rendering.CullMode: 1 front, 2 back
    if fl.get('_UseZWrite') or (m['shader'] == 'urp' and fl.get('_ZWrite')):
        m['zwrite'] = 1
    zt = fl.get('_ZTest', 4)
    if zt in (0, 8):
        m['ztest'] = 0   # always (draws through geometry)
    if fl.get('_ZOffset'):
        m['zoffset'] = rnd(fl['_ZOffset'])
    q = t.get('m_CustomRenderQueue', -1)
    if q and q > 0:
        m['queue'] = q + int(fl.get('_RenderQueueOffset', 0) if abs(fl.get('_RenderQueueOffset', 0)) < 1000 else 0)
    if fl.get('_AlphaClip') or fl.get('_Mode') == 1:
        m['clip'] = rnd(fl.get('_Cutoff', 0.5))
    return m


# ---------------------------------------------------------------------------------------------- particle systems
def shape_of(g, store, key, s):
    if not s.get('enabled'):
        return None
    out = {'type': s['type']}
    rad = s.get('radius', {})
    out['radius'] = rnd(rad.get('value', 1) if isinstance(rad, dict) else rad)
    if isinstance(rad, dict) and rad.get('mode', 0):
        out['radiusMode'] = [rad['mode'], rnd(rad.get('spread', 0)), mm(rad.get('speed'))]
    arc = s.get('arc', {})
    out['arc'] = rnd(arc.get('value', 360) if isinstance(arc, dict) else arc)
    if isinstance(arc, dict) and arc.get('mode', 0):
        out['arcMode'] = [arc['mode'], rnd(arc.get('spread', 0)), mm(arc.get('speed'))]
    ty = s['type']
    if ty in (4, 7, 8, 9):   # cones
        out['angle'] = rnd(s.get('angle', 25))
        if ty in (8, 9):
            out['length'] = rnd(s.get('length', 5))
    if ty == 17:
        out['donut'] = rnd(s.get('donutRadius', 0.2))
    if s.get('radiusThickness', 1) != 1:
        out['thick'] = rnd(s['radiusThickness'])
    for k, name in (('randomDirectionAmount', 'randDir'), ('sphericalDirectionAmount', 'sphDir'),
                    ('randomPositionAmount', 'randPos')):
        if s.get(k):
            out[name] = rnd(s[k])
    if s.get('alignToDirection'):
        out['align'] = 1
    pos, rot, scl = v3(s['m_Position']), v3(s['m_Rotation']), v3(s['m_Scale'])
    if pos != [0, 0, 0]:
        out['pos'] = pos
    if rot != [0, 0, 0]:
        out['rot'] = rot
    if scl != [1, 1, 1]:
        out['scale'] = scl
    bt = v3(s.get('boxThickness', {'x': 0, 'y': 0, 'z': 0}))
    if bt != [0, 0, 0]:
        out['boxThick'] = bt
    if s['type'] in (6, 13, 14):
        mk = g.ref(key, s.get('m_Mesh'))
        if not mk and s.get('m_MeshRenderer', {}).get('m_PathID'):
            rk = g.ref(key, s['m_MeshRenderer'])
            go = g.ref(rk, g.tree(rk).get('m_GameObject')) if rk else None
            for c in g.tree(go).get('m_Component', []) if go else []:
                ck = g.ref(go, c['component'])
                if ck and g.type(ck) == 'MeshFilter':
                    mk = g.ref(ck, g.tree(ck).get('m_Mesh'))
        if mk:
            out['mesh'] = store.mesh(g, mk)
        out['meshMode'] = s.get('placementMode', 0)
    return out


def system_of(g, store, key, t, rkey, r, mat_index, node_of_ps):
    """One ParticleSystem (+ its renderer) -> dict."""
    im = t['InitialModule']
    out = {'dur': rnd(t['lengthInSec']), 'loop': int(bool(t['looping']))}
    if t.get('prewarm'):
        out['prewarm'] = 1
    d = mm(t.get('startDelay'))
    if not mm_zero(d):
        out['delay'] = d
    if t.get('simulationSpeed', 1) != 1:
        out['simSpeed'] = rnd(t['simulationSpeed'])
    out['space'] = int(t.get('moveWithTransform', 0))
    if t.get('scalingMode', 0):
        out['scaling'] = t['scalingMode']
    out['life'] = mm(im['startLifetime'])
    out['speed'] = mm(im['startSpeed'])
    if im.get('size3D'):
        out['size3'] = [mm(im['startSize']), mm(im['startSizeY']), mm(im['startSizeZ'])]
    else:
        out['size'] = mm(im['startSize'])
    if im.get('rotation3D'):
        out['rot3'] = [mm(im['startRotationX']), mm(im['startRotationY']), mm(im['startRotation'])]
    else:
        rv = mm(im['startRotation'])
        if not mm_zero(rv):
            out['rot'] = rv
    if im.get('randomizeRotationDirection'):
        out['flipRot'] = rnd(im['randomizeRotationDirection'])
    c = grad(im['startColor'])
    if not white(c):
        out['color'] = c
    gv = mm(im['gravityModifier'])
    if not mm_zero(gv):
        out['grav'] = gv
    out['max'] = im.get('maxNumParticles', 1000)
    # emission
    em = t['EmissionModule']
    if em.get('enabled'):
        e = {}
        rate = mm(em['rateOverTime'])
        if not mm_zero(rate):
            e['rate'] = rate
        rd = mm(em['rateOverDistance'])
        if not mm_zero(rd):
            e['dist'] = rd
        bursts = []
        for b in em.get('m_Bursts') or []:
            bursts.append([rnd(b['time']), mm(b['countCurve']), b.get('cycleCount', 1), rnd(b.get('repeatInterval', 0.01)),
                           rnd(b.get('probability', 1))])
        if bursts:
            e['bursts'] = bursts
        out['emit'] = e
    else:
        out['emit'] = {}
    sh = shape_of(g, store, key, t['ShapeModule'])
    if sh:
        out['shape'] = sh
    vm = t['VelocityModule']
    if vm.get('enabled'):
        v = {'x': mm(vm['x']), 'y': mm(vm['y']), 'z': mm(vm['z'])}
        orb = [mm(vm['orbitalX']), mm(vm['orbitalY']), mm(vm['orbitalZ'])]
        if any(not mm_zero(o) for o in orb):
            v['orbital'] = orb
            off = [mm(vm['orbitalOffsetX']), mm(vm['orbitalOffsetY']), mm(vm['orbitalOffsetZ'])]
            if any(not mm_zero(o) for o in off):
                v['offset'] = off
        rad = mm(vm['radial'])
        if not mm_zero(rad):
            v['radial'] = rad
        sm = mm(vm['speedModifier'])
        if sm != 1:
            v['speedMod'] = sm
        if vm.get('inWorldSpace'):
            v['world'] = 1
        if all(mm_zero(v[k]) for k in 'xyz'):
            for k in 'xyz':
                del v[k]
        if v:
            out['vel'] = v
    cv = t['ClampVelocityModule']
    if cv.get('enabled'):
        lim = {'dampen': rnd(cv.get('dampen', 0))}
        if cv.get('separateAxis'):
            lim['xyz'] = [mm(cv['x']), mm(cv['y']), mm(cv['z'])]
            if cv.get('inWorldSpace'):
                lim['world'] = 1
        else:
            lim['mag'] = mm(cv['magnitude'])
        dr = mm(cv.get('drag'))
        if not mm_zero(dr):
            lim['drag'] = dr
            if cv.get('multiplyDragByParticleSize'):
                lim['dragSize'] = 1
            if cv.get('multiplyDragByParticleVelocity'):
                lim['dragVel'] = 1
        out['limit'] = lim
    fm = t['ForceModule']
    if fm.get('enabled'):
        f = {'x': mm(fm['x']), 'y': mm(fm['y']), 'z': mm(fm['z'])}
        if fm.get('inWorldSpace'):
            f['world'] = 1
        out['force'] = f
    iv = t['InheritVelocityModule']
    if iv.get('enabled'):
        out['inherit'] = [iv.get('m_Mode', 0), mm(iv['m_Curve'])]
    co = t['ColorModule']
    if co.get('enabled'):
        c = grad(co['gradient'])
        if not white(c):
            out['col'] = c
    so = t['SizeModule']
    if so.get('enabled'):
        out['sol'] = [mm(so['curve']), mm(so['y']), mm(so['z'])] if so.get('separateAxes') else mm(so['curve'])
    ro = t['RotationModule']
    if ro.get('enabled'):
        if ro.get('separateAxes'):
            out['rol'] = [mm(ro['x']), mm(ro['y']), mm(ro['curve'])]
        else:
            rv = mm(ro['curve'])
            if not mm_zero(rv):
                out['rol'] = rv
    sb = t['SizeBySpeedModule']
    if sb.get('enabled'):
        out['sbs'] = [mm(sb['curve']), rnd(sb['range']['x']), rnd(sb['range']['y'])]
    rb = t['RotationBySpeedModule']
    if rb.get('enabled'):
        out['rbs'] = [mm(rb['curve']), rnd(rb['range']['x']), rnd(rb['range']['y'])]
    cb = t['ColorBySpeedModule']
    if cb.get('enabled'):
        out['cbs'] = [grad(cb['gradient']), rnd(cb['range']['x']), rnd(cb['range']['y'])]
    uv = t['UVModule']
    if uv.get('enabled') and uv.get('mode', 0) == 0 and (uv['tilesX'] > 1 or uv['tilesY'] > 1):
        u = {'tx': uv['tilesX'], 'ty': uv['tilesY'], 'fot': mm(uv['frameOverTime']), 'cycles': rnd(uv.get('cycles', 1))}
        st = mm(uv['startFrame'])
        if not mm_zero(st):
            u['start'] = st
        if uv.get('animationType') == 1:
            u['row'] = uv.get('rowIndex', 0)
            u['rowMode'] = uv.get('rowMode', 0)   # 0 custom row, 1 random row, 2 mesh index
        if uv.get('timeMode', 0):
            u['timeMode'] = uv['timeMode']
            u['fps'] = rnd(uv.get('fps', 30))
            u['speedRange'] = [rnd(uv['speedRange']['x']), rnd(uv['speedRange']['y'])]
        if uv.get('flipU') or uv.get('flipV'):
            u['flip'] = [rnd(uv.get('flipU', 0)), rnd(uv.get('flipV', 0))]
        out['uv'] = u
    nm = t['NoiseModule']
    if nm.get('enabled'):
        n = {'str': [mm(nm['strength']), mm(nm['strengthY']), mm(nm['strengthZ'])] if nm.get('separateAxes')
             else mm(nm['strength']),
             'freq': rnd(nm.get('frequency', 0.5)), 'scroll': mm(nm['scrollSpeed']), 'damp': int(bool(nm.get('damping'))),
             'oct': nm.get('octaves', 1), 'pos': mm(nm['positionAmount'])}
        ra, sa = mm(nm['rotationAmount']), mm(nm['sizeAmount'])
        if not mm_zero(ra):
            n['rot'] = ra
        if not mm_zero(sa):
            n['size'] = sa
        out['noise'] = n
    cd = t['CustomDataModule']
    if cd.get('enabled'):
        custom = []
        for i in (0, 1):
            mode = cd.get('mode%d' % i, 0)
            if mode == 1:
                n = cd.get('vectorComponentCount%d' % i, 4)
                custom.append({'v': [mm(cd['vector%d_%d' % (i, j)]) for j in range(n)]})
            elif mode == 2:
                custom.append({'c': grad(cd['color%d' % i])})
            else:
                custom.append(None)
        if any(custom):
            out['custom'] = custom
    sub = t['SubModule']
    if sub.get('enabled'):
        subs = []
        for s in sub.get('subEmitters') or []:
            k = g.ref(key, s.get('emitter'))
            if k and k in node_of_ps:
                subs.append({'ps': k, 'type': s.get('type', 0), 'props': s.get('properties', 0),
                             'prob': rnd(s.get('emitProbability', 1))})
        if subs:
            out['sub'] = subs
    tr = t['TrailModule']
    if tr.get('enabled'):
        out['trail'] = {'mode': tr.get('mode', 0), 'ratio': rnd(tr.get('ratio', 1)), 'life': mm(tr['lifetime']),
                        'minDist': rnd(tr.get('minVertexDistance', 0.2)), 'tex': tr.get('textureMode', 0),
                        'world': int(bool(tr.get('worldSpace'))), 'die': int(bool(tr.get('dieWithParticles', True))),
                        'sizeWidth': int(bool(tr.get('sizeAffectsWidth', True))),
                        'inheritColor': int(bool(tr.get('inheritParticleColor', True))),
                        'color': grad(tr['colorOverLifetime']), 'width': mm(tr['widthOverTrail']),
                        'colorTrail': grad(tr['colorOverTrail'])}
    # renderer
    rr = {'mode': 0}
    if r:
        rr['mode'] = r.get('m_RenderMode', 0)   # 0 billboard, 1 stretched, 2 horizontal, 3 vertical, 4 mesh, 5 none
        if r.get('m_RenderAlignment', 0):
            rr['align'] = r['m_RenderAlignment']   # 0 view, 1 world, 2 local, 3 facing, 4 velocity
        mats = [mat_index(g.ref(rkey, m)) for m in r.get('m_Materials') or []]
        rr['mat'] = mats[0] if mats else None
        if len(mats) > 1 and 'trail' in out:
            rr['trailMat'] = mats[1]
        if rr['mode'] == 4:
            meshes = []
            for f in ('m_Mesh', 'm_Mesh1', 'm_Mesh2', 'm_Mesh3'):
                mk = g.ref(rkey, r.get(f))
                if mk:
                    n = store.mesh(g, mk)
                    if n:
                        meshes.append(n)
            rr['meshes'] = meshes
        if rr['mode'] == 1:
            rr['len'] = rnd(r.get('m_LengthScale', 2))
            rr['vel'] = rnd(r.get('m_VelocityScale', 0))
            if r.get('m_CameraVelocityScale'):
                rr['camVel'] = rnd(r['m_CameraVelocityScale'])
            if r.get('m_FreeformStretching'):
                rr['freeform'] = 1
        if r.get('m_SortingFudge'):
            rr['fudge'] = rnd(r['m_SortingFudge'])
        if r.get('m_SortMode'):
            rr['sort'] = r['m_SortMode']
        if r.get('m_SortingOrder'):
            rr['order'] = r['m_SortingOrder']
        if r.get('m_MinParticleSize', 0):
            rr['minSize'] = rnd(r['m_MinParticleSize'])
        if r.get('m_MaxParticleSize', 0.5) != 0.5:
            rr['maxSize'] = rnd(r['m_MaxParticleSize'])
        pv = v3(r.get('m_Pivot', {'x': 0, 'y': 0, 'z': 0}))
        if pv != [0, 0, 0]:
            rr['pivot'] = pv
        fl = v3(r.get('m_Flip', {'x': 0, 'y': 0, 'z': 0}))
        if fl != [0, 0, 0]:
            rr['flip'] = fl
        if not r.get('m_Enabled', True):
            rr['off'] = 1
    out['r'] = rr
    return out


# ---------------------------------------------------------------------------------------------- prefabs
def components(g, go):
    out = []
    for c in g.tree(go).get('m_Component', []):
        k = g.ref(go, c.get('component'))
        if k:
            out.append((g.type(k), k))
    return out


def convert_prefab(g, store, root_go, key_name):
    """GameObject hierarchy under root_go -> effect dict (local transforms; root transform reset)."""
    nodes, systems, mats, mat_ids = [], [], [], {}
    order = []   # (go, parent index)

    def walk(go, parent):
        idx = len(order)
        order.append((go, parent))
        tf = next((k for ty, k in components(g, go) if ty in ('Transform', 'RectTransform')), None)
        for ch in g.tree(tf).get('m_Children', []) if tf else []:
            ck = g.ref(tf, ch)
            cgo = g.ref(ck, g.tree(ck).get('m_GameObject')) if ck else None
            if cgo:
                walk(cgo, idx)

    walk(root_go, -1)

    def mat_index(k):
        if not k:
            return None
        if k not in mat_ids:
            m = material(g, store, k)
            if m is None:
                mat_ids[k] = None
            else:
                mat_ids[k] = len(mats)
                mats.append(m)
        return mat_ids[k]

    # node index of every ParticleSystem (for sub emitters)
    ps_of_node = {}
    for i, (go, _) in enumerate(order):
        for ty, k in components(g, go):
            if ty == 'ParticleSystem':
                ps_of_node[k] = i
    sys_index = {}
    pending_subs = []
    for i, (go, parent) in enumerate(order):
        gt = g.tree(go)
        comps = components(g, go)
        tf = next((k for ty, k in comps if ty in ('Transform', 'RectTransform')), None)
        tt = g.tree(tf) if tf else {}
        n = {'n': gt.get('m_Name', ''), 'p': parent}
        if i > 0:   # the root's own transform is replaced by where the game places the effect
            tp = v3(tt.get('m_LocalPosition', {'x': 0, 'y': 0, 'z': 0}))
            q = tt.get('m_LocalRotation', {'x': 0, 'y': 0, 'z': 0, 'w': 1})
            tr = [rnd(q['x'], 5), rnd(q['y'], 5), rnd(q['z'], 5), rnd(q['w'], 5)]
            if tp != [0, 0, 0]:
                n['t'] = tp
            if tr != [0, 0, 0, 1]:
                n['r'] = tr
        ts = v3(tt.get('m_LocalScale', {'x': 1, 'y': 1, 'z': 1}))
        if ts != [1, 1, 1]:
            n['s'] = ts
        if not gt.get('m_IsActive', True):
            n['off'] = 1
        ps = next((k for ty, k in comps if ty == 'ParticleSystem'), None)
        psr = next((k for ty, k in comps if ty == 'ParticleSystemRenderer'), None)
        if ps:
            try:
                s = system_of(g, store, ps, g.tree(ps), psr, g.tree(psr) if psr else None, mat_index, ps_of_node)
                s['node'] = i
                n['ps'] = len(systems)
                sys_index[ps] = len(systems)
                systems.append(s)
                store.stats['systems'] += 1
            except Exception as e:
                store.stats['system-failed'] += 1
                print('  %s/%s: %s: %s' % (key_name, n['n'], type(e).__name__, e))
        mf = next((k for ty, k in comps if ty == 'MeshFilter'), None)
        mr = next((k for ty, k in comps if ty == 'MeshRenderer'), None)
        if mf and mr:
            mk = g.ref(mf, g.tree(mf).get('m_Mesh'))
            mt = g.tree(mr)
            if mk and mt.get('m_Enabled', 1):
                name = store.mesh(g, mk)
                ms = [mat_index(g.ref(mr, m)) for m in mt.get('m_Materials') or []]
                if name and ms and ms[0] is not None:
                    n['mesh'] = {'mesh': name, 'mat': ms[0]}
        for ty, k in comps:
            if ty == 'MonoBehaviour':
                sc = g.script(k)
                if sc == 'Billboard':
                    bt = g.tree(k)
                    if bt.get('m_Enabled', 1):
                        n['bb'] = [bt.get('_fixedAxisType', 0), bt.get('_lookAt', 0), bt.get('_direction', 0),
                                   bt.get('_inverted', 0)]
            elif ty == 'Light':
                lt = g.tree(k)
                if lt.get('m_Enabled', 1) and lt.get('m_Type', 2) == 2:
                    n['light'] = color(lt['m_Color'])[:3] + [rnd(lt.get('m_Intensity', 1)), rnd(lt.get('m_Range', 1))]
        nodes.append(n)
    # sub emitters -> system indices (a sub emitter does not play on its own)
    for s in systems:
        for sb in s.get('sub', []):
            sb['ps'] = sys_index.get(sb['ps'], -1)
        s['sub'] = [sb for sb in s.get('sub', []) if sb['ps'] >= 0]
        if not s['sub']:
            del s['sub']
    for s in systems:
        for sb in s.get('sub', []):
            systems[sb['ps']]['isSub'] = 1
    dur, loop = 0.0, False
    for s in systems:
        if s.get('isSub'):
            continue
        life = s['life']
        lmax = life if isinstance(life, (int, float)) else (max(life) if isinstance(life, list) else max(life['c']))
        delay = s.get('delay', 0)
        dmax = delay if isinstance(delay, (int, float)) else (max(delay) if isinstance(delay, list) else max(delay['c']))
        dur = max(dur, dmax + s['dur'] + lmax)
        loop = loop or bool(s['loop'])
    return {'v': VERSION, 'key': key_name, 'dur': rnd(min(dur, 30), 2), 'loop': int(loop), 'nodes': nodes,
            'systems': systems, 'mats': mats}


def prefabs_of(rel):
    """[(prefab name, root GameObject path id)] of an effect bundle (AssetBundle container)."""
    b = ca.bundle(rel)
    out = []
    for o in b.of_type('AssetBundle'):
        t = b.tree(o.path_id)
        for path, info in t['m_Container']:
            if path.endswith('.prefab'):
                pid = info['asset']['m_PathID']
                if pid in b.objects and b.objects[pid].type.name == 'GameObject':
                    out.append((b.objects[pid].peek_name(), pid))
    return out


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(',', ':'), ensure_ascii=False), encoding='utf8')


# ---------------------------------------------------------------------------------------------- stages
def world_matrix(scene, tkey):
    pos, rot, scl = scene.world(tkey)
    return pos, rot, scl


def mat_to_quat(m):
    tr = m[0][0] + m[1][1] + m[2][2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        return [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, 0.25 * s]
    if m[0][0] > m[1][1] and m[0][0] > m[2][2]:
        s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
        return [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s]
    if m[1][1] > m[2][2]:
        s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
        return [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s]
    s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
    return [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s]


def convert_scene(path, store, out_name, fallback_roots=False):
    """FieldEffect placements of one scene -> stages/<name>.json (Unity world TRS + inline effect)."""
    from extract_dungeon_maps import Scene
    sc = Scene(path)
    g = Graph(sc)
    placed = []
    for key, o in sc.objects.items():
        if o.type.name != 'MonoBehaviour' or sc.script_name(key) != 'FieldEffect':
            continue
        t = sc.tree(key)
        if not t.get('m_Enabled', 1):
            continue
        go = sc.ref(key, t.get('m_GameObject'))
        if not go or go not in sc.go:
            continue
        # skip FieldEffects nested under another FieldEffect (the parent converts the whole tree)
        placed.append(go)
    if not placed and fallback_roots:
        # field maps have no FieldEffect markers: each top-most GameObject with a ParticleSystem is one effect
        ps_gos = set()
        for key, o in sc.objects.items():
            if o.type.name == 'ParticleSystem':
                go = sc.ref(key, sc.tree(key).get('m_GameObject'))
                if go in sc.go:
                    ps_gos.add(go)
        for go in sorted(ps_gos, key=repr):
            tf = sc.transform_of.get(go)
            father = sc.tree(tf).get('m_Father') if tf else None
            fk = sc.ref(tf, father) if father and father.get('m_PathID') else None
            pgo = sc.ref(fk, sc.tree(fk).get('m_GameObject')) if fk else None
            if pgo not in ps_gos:
                placed.append(go)
    roots = set(placed)
    effects = []
    for go in placed:
        tf = sc.transform_of.get(go)
        if not tf:
            continue
        nested = False
        cur = sc.tree(tf).get('m_Father')
        owner = tf
        while cur and cur.get('m_PathID'):
            fk = sc.ref(owner, cur)
            if not fk:
                break
            pgo = sc.ref(fk, sc.tree(fk).get('m_GameObject'))
            if pgo in roots:
                nested = True
                break
            owner, cur = fk, sc.tree(fk).get('m_Father')
        if nested or not active_in_hierarchy(sc, go):
            continue
        name = sc.go[go]['name']
        fx = convert_prefab(g, store, go, '%s#%s' % (out_name, name))
        if not fx['systems']:
            continue
        pos, rot, scl = world_matrix(sc, tf)
        q = mat_to_quat(rot.tolist() if hasattr(rot, 'tolist') else rot)
        effects.append({'name': name, 't': [rnd(x) for x in pos], 'r': [rnd(x, 5) for x in q],
                        's': [rnd(x) for x in scl], 'fx': fx})
    return effects


def active_in_hierarchy(sc, go):
    tf = sc.transform_of.get(go)
    k = go
    while True:
        if not sc.tree(k).get('m_IsActive', True):
            return False
        if not tf:
            return True
        father = sc.tree(tf).get('m_Father')
        fk = sc.ref(tf, father) if father and father.get('m_PathID') else None
        if not fk:
            return True
        k = sc.ref(fk, sc.tree(fk).get('m_GameObject'))
        tf = fk
        if not k:
            return True


# ---------------------------------------------------------------------------------------------- bodies
TRANSFORM_TYPES = {'RightHand': 2, 'RightWeapon': 3, 'RightToe': 4, 'LeftHand': 5, 'LeftWeapon': 6, 'LeftToe': 7,
                   'CenterWeapon': 8, 'Head': 9, 'Hip': 10, 'Chest': 11, 'CameraTarget': 12, 'UIHead': 14,
                   'SystemEffectTarget': 19, 'SecondaryCameraTarget': 20}


def convert_bodies():
    """CharacterBody of every character / monster battle prefab -> bodies.json:
    "character/001/001": {points: {TransformType: [node, parent, [x, y, z], [qx, qy, qz, qw]]}, customs: [...],
    equip: {Main, Sub}, effectScale, offsetScale, between}. The node may be a locator the model GLB lacks
    (camera_target, system_effect_target ...): the runtime then adds it under `parent` with the local transform
    (Unity space)."""
    out = {}
    for fam in ('character', 'monster'):
        for p in sorted((BUNDLES / fam).glob('*/pfb_*.a')):
            m = re.match(r'pfb_(?:ch|mo)(\d+)_(\d+)\.a$', p.name)
            if not m:
                continue
            rel = p.relative_to(BUNDLES).as_posix()
            try:
                b = ca.bundle(rel)
            except Exception:
                continue
            for o in b.of_type('MonoBehaviour'):
                try:
                    t = b.tree(o.path_id)
                except Exception:
                    continue
                if '_transformReference' not in t:
                    continue

                def node(ptr):
                    if not ptr or not ptr.get('m_PathID') or ptr['m_PathID'] not in b.objects:
                        return None
                    tr = b.tree(ptr['m_PathID'])
                    name = b.objects[tr['m_GameObject']['m_PathID']].peek_name()
                    father = tr.get('m_Father') or {}
                    parent = None
                    if father.get('m_PathID') in b.objects:
                        ft = b.tree(father['m_PathID'])
                        parent = b.objects[ft['m_GameObject']['m_PathID']].peek_name()
                    q = tr['m_LocalRotation']
                    return [name, parent, v3(tr['m_LocalPosition']), [rnd(q[k], 5) for k in 'xyzw']]

                ref = t['_transformReference']
                points = {}
                for k, ty in TRANSFORM_TYPES.items():
                    n = node(ref.get(k))
                    if n:
                        points[str(ty)] = n
                body = {'points': points, 'customs': [n for n in (node(c) for c in ref.get('Customs') or []) if n],
                        'equip': {e['name']: (node(e.get('point')) or [None])[0] for e in t.get('_equipPointInfos') or []},
                        'effectScale': rnd(t.get('_effectScale', 1)), 'offsetScale': rnd(t.get('_offsetScale', 1)),
                        'between': v3(t.get('_betweenOffset') or {'x': 0, 'y': 1, 'z': 0})}
                if t.get('_size'):
                    body['size'] = t['_size']
                out['%s/%s/%s' % (fam, '%03d' % int(m.group(1)), m.group(2))] = body
                break
        ca._BUNDLES.clear()
    write_json(OUT / 'bodies.json', {'version': VERSION, 'bodies': out})
    print('bodies: %d' % len(out))


# ---------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='comma separated bundle prefixes under effect/ (e.g. battle/character/ch001)')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-stages', action='store_true')
    ap.add_argument('--stages-only', action='store_true')
    ap.add_argument('--bodies-only', action='store_true')
    args = ap.parse_args()
    if args.bodies_only or not args.only:
        convert_bodies()
        if args.bodies_only:
            return
    only = [s.strip() for s in args.only.split(',')] if args.only else None
    t0 = time.time()
    store = Store()
    idx_path = OUT / 'index.json'
    index = json.loads(idx_path.read_text(encoding='utf8')) if idx_path.exists() else {}
    if index.get('version') != VERSION:
        index = {}
    effects = index.get('effects', {})
    bundles = []
    for grp in GROUPS:
        for p in sorted((BUNDLES / grp).glob('*.d')):
            rel = p.relative_to(BUNDLES).as_posix()
            if only and not any(rel[len('effect/'):].startswith(o) for o in only):
                continue
            bundles.append(rel)
    if args.stages_only:
        bundles = []
    for bi, rel in enumerate(bundles):
        g = Graph()
        try:
            prefabs = prefabs_of(rel)
        except Exception as e:
            print('%s: %s: %s' % (rel, type(e).__name__, e))
            continue
        n = 0
        for name, pid in prefabs:
            k = effect_key(rel, name)
            path = OUT / (k + '.json')
            if path.exists() and not args.force and k in effects:
                continue
            try:
                fx = convert_prefab(g, store, (rel, pid), k)
            except Exception as e:
                store.stats['prefab-failed'] += 1
                print('  %s: %s: %s' % (k, type(e).__name__, e))
                continue
            if not fx['systems'] and not any('mesh' in nd for nd in fx['nodes']):
                store.stats['prefab-empty'] += 1
                continue
            write_json(path, fx)
            effects[k] = {'dur': fx['dur'], 'loop': fx['loop'], 'n': len(fx['systems'])}
            n += 1
        store.stats['prefabs'] += n
        print('[%d/%d] %s: %d prefabs (%.0fs)' % (bi + 1, len(bundles), rel, n, time.time() - t0))
        ca._BUNDLES.clear()
    stages = index.get('stages', {})
    if not args.no_stages and (not only or args.stages_only or 'environment' in only):
        for p in sorted((BUNDLES / 'scenes').glob('environment_*.s')):
            env = p.stem.split('_')[1]
            try:
                placed = convert_scene(p, store, 'environment_' + env)
            except Exception as e:
                print('  stage %s: %s: %s' % (p.name, type(e).__name__, e))
                continue
            if placed:
                write_json(OUT / 'stages' / ('%s.json' % env), {'v': VERSION, 'environment': int(env), 'effects': placed})
                stages[str(int(env))] = len(placed)
                store.stats['stage-effects'] += len(placed)
            print('stage %s: %d effects (%.0fs)' % (env, len(placed), time.time() - t0))
            ca._BUNDLES.clear()
        fields = index.get('fields', {})
        for p in sorted((BUNDLES / 'scenes').glob('dungeon_map_*.s')):
            key = p.stem
            try:
                placed = convert_scene(p, store, key, fallback_roots=True)
            except Exception as e:
                print('  field %s: %s: %s' % (p.name, type(e).__name__, e))
                continue
            if placed:
                write_json(OUT / 'fields' / ('%s.json' % key), {'v': VERSION, 'map': key, 'effects': placed})
                fields[key] = len(placed)
                store.stats['field-effects'] += len(placed)
            ca._BUNDLES.clear()
        print('fields: %d maps with ambient particles (%.0fs)' % (len(fields), time.time() - t0))
        index['fields'] = fields
    write_json(idx_path, {'version': VERSION, 'generatedBy': 'ffcx convert_effects.py',
                          'effects': dict(sorted(effects.items())), 'stages': dict(sorted(stages.items(), key=lambda x: int(x[0]))),
                          'fields': dict(sorted(index.get('fields', {}).items()))})
    print('done in %.0fs: %s' % (time.time() - t0, dict(store.stats)))


if __name__ == '__main__':
    main()
