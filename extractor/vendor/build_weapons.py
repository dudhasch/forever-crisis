# Vendored from explorer/tools/build_weapons.py by release-tools/sync_vendor.py - do not edit here.
"""build_weapons.py -- weapon data layer for the FF7 Ever Crisis three.js explorer.

Run (UnityPy venv):

    python ^
        <explorer>\\tools\\build_weapons.py
        [--only 001,003/001] [--force] [--albedo-size 1024] [--map-size 512] [--no-models]

    --only        restrict GLB conversion to weapon folders / folder/model ids (prefix match).
                  weapons.json is always rebuilt from everything present in generated/weapons.
    --force       reconvert GLBs that already exist.
    --no-models   only rebuild weapons.json (+ checks) from existing GLBs.

Reads (read-only): 02-DecodedBundles/weapon/<NNN>/model/<MMM>.d (meshes, materials, textures),
02-DecodedBundles/weapon/<NNN>/pfb_we<NNN>_<MMM>.a (weapon prefab: locator + equipment type),
02-DecodedBundles/character/<NNN>/pfb_ch<NNN>_<MMM>*.a (battle prefab: equip points),
10-Database/FF7EC-Knowledge.sqlite (master data, opened ?mode=ro), generated/characters.json and the
converted character GLBs in converters/library/unity/character (node names only).
Writes ONLY generated/weapons/<NNN>/<MMM>.glb and generated/weapons.json.

GLB CONVENTION (same as the character GLBs, extras.basis)
  "Unity X reflected; Y up; units unchanged": position (-x,y,z), quaternion (x,-y,-z,w), triangle
  winding flipped (0,2,1), inverse bind matrices R*M*R with R=diag(-1,1,1,1), uv.v -> 1-v.
  No tangents are written (three.js derives the TBN from screen-space derivatives of the mirrored
  geometry, which stays consistent with the unmodified tangent-space normal map).

MATERIAL / TEXTURE CHANNEL MAPPING (Unity custom URP-like toon/PBR shader "_BaseMap/_BumpMap/_MetallicGlossMap")
  tex_*_AAAX / AAAT  -> baseColorTexture (sRGB). AAAX alpha is unused (always 255) -> JPEG RGB;
                        AAAT carries cut-out alpha -> PNG RGBA, alphaMode MASK (cutoff _Cutoff) when the
                        material has _ALPHATEST_ON / RenderType TransparentCutout, BLEND when _Surface=1.
  tex_*_NNNX         -> normalTexture. Stored DXT5nm-style: R=1, G=Y, A=X (Unity UnpackNormalAG).
                        Rewritten as a standard RGB tangent-space normal (z reconstructed), scale=_BumpScale.
  tex_*_MROX         -> R=Metallic, G=Roughness, B=Occlusion, A unused (verified visually: polished
                        blade edges are bright in R and dark in G, leather/wood/cloth dark in R, mid/bright
                        in G, B is a baked AO with dark creases).  Rewritten as one glTF "ORM" image
                        (R=occlusion, G=roughness, B=metallic) used by occlusionTexture
                        (strength=_OcclusionStrength) and metallicRoughnessTexture (factors 1/1).
  Particle-effect children (pfb_eff_*) and Unity spring-bone/collider behaviours are not exported.

ATTACHMENT (see weapons.json "notes")
  Battle prefabs carry a MonoBehaviour with `_equipPointInfos` [{name:"Main", point:<transform>},
  {name:"Sub", ...}, ...] and `_transformReference` {RightWeapon, LeftWeapon, ...}.  A weapon prefab
  (MonoBehaviour `_equipmentType`) is mounted on the "Main" equip point with an identity local
  transform: its origin is the grip.  `main_weapon`/`sub_weapon` are root-level bones whose battle
  animation tracks carry the weapon (in idle they coincide with right/left_hand_weapon); with no
  animation they sit at the model origin, so `fallbackBone` (right/left_hand_weapon) is given.
  `_equipmentType` 1 (Tifa's gloves) is a skinned mesh bound to a copy of the character skeleton:
  rebind its joints to the character's bones by name instead of parenting.
"""
import os as _os
from pathlib import Path as _P
import argparse, collections, io, json, math, re, sqlite3, struct, sys, time
from pathlib import Path

import numpy as np
import UnityPy
from UnityPy.helpers.MeshHelper import MeshHandler
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]                 # explorer
ARCHIVE = _P(_os.environ['FFCX_ARCHIVE'])                                      # archive
BUNDLES = ARCHIVE / '02-DecodedBundles'
DB = ARCHIVE / '10-Database' / 'FF7EC-Knowledge.sqlite'
LIB = _P(_os.environ['FFCX_LIB'])
OUT_DIR = _P(_os.environ['FFCX_GEN']) / 'weapons'
OUT_JSON = ROOT / 'generated' / 'weapons.json'
CHARACTERS_JSON = ROOT / 'generated' / 'characters.json'
BASIS = 'Unity X reflected; Y up; units unchanged'
VERSION = 1

# ----------------------------------------------------------------------------------------------- glTF
def pos(v): return [-float(v['x']), float(v['y']), float(v['z'])]
def quat(q):
    a = np.array([q['x'], -q['y'], -q['z'], q['w']], dtype=float)
    n = np.linalg.norm(a)
    return (a / n).tolist() if n > 1e-10 else [0.0, 0.0, 0.0, 1.0]
def scl(v): return [float(v['x']), float(v['y']), float(v['z'])]
REFLECT = np.diag([-1., 1., 1., 1.])

def trs_matrix(t, r, s):
    x, y, z, w = r
    m = np.eye(4)
    m[:3, :3] = np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                          [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                          [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]]) @ np.diag(s)
    m[:3, 3] = t
    return m

class Gltf:
    def __init__(self):
        self.j = {'asset': {'version': '2.0', 'generator': f'ffcx build_weapons.py v{VERSION}'},
                  'scene': 0, 'scenes': [{'nodes': []}], 'nodes': [], 'bufferViews': [], 'accessors': []}
        self.bin = bytearray()
    def view(self, data, target=None):
        self.bin.extend(b'\0' * ((-len(self.bin)) % 4))
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target: v['target'] = target
        self.bin.extend(data)
        self.j['bufferViews'].append(v)
        return len(self.j['bufferViews']) - 1
    def acc(self, data, kind, component=5126, bounds=False, target=None):
        a = np.asarray(data, dtype={5126: '<f4', 5125: '<u4', 5123: '<u2'}[component])
        if not np.isfinite(a.astype(float)).all(): raise ValueError('non-finite accessor')
        count = len(a); a = a.reshape(count, -1)
        if not count: raise ValueError('empty accessor')
        e = {'bufferView': self.view(a.tobytes(), target), 'componentType': component, 'count': count, 'type': kind}
        if bounds: e.update(min=a.min(axis=0).astype(float).tolist(), max=a.max(axis=0).astype(float).tolist())
        self.j['accessors'].append(e)
        return len(self.j['accessors']) - 1
    def image(self, name, data, mime):
        imgs = self.j.setdefault('images', [])
        imgs.append({'name': name, 'mimeType': mime, 'bufferView': self.view(data)})
        texs = self.j.setdefault('textures', [])
        texs.append({'source': len(imgs) - 1, 'sampler': 0})
        self.j.setdefault('samplers', [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}])
        return len(texs) - 1
    def bytes(self):
        j = dict(self.j)
        if not j.get('accessors'): j.pop('accessors', None); j.pop('bufferViews', None)
        if self.bin: j['buffers'] = [{'byteLength': len(self.bin)}]
        jb = json.dumps(j, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
        jb += b' ' * ((-len(jb)) % 4)
        bb = bytes(self.bin); bb += b'\0' * ((-len(bb)) % 4)
        payload = struct.pack('<II', len(jb), 0x4E4F534A) + jb
        if bb: payload += struct.pack('<II', len(bb), 0x004E4942) + bb
        return struct.pack('<III', 0x46546C67, 2, 12 + len(payload)) + payload

def read_glb_json(path):
    with open(path, 'rb') as f:
        head = f.read(20)
        magic, ver, total, clen, ctype = struct.unpack('<IIIII', head)
        if magic != 0x46546C67 or ver != 2 or ctype != 0x4E4F534A: raise ValueError(f'not a GLB 2.0: {path}')
        return json.loads(f.read(clen))

# ------------------------------------------------------------------------------------------- textures
def encode(im, fmt, quality=90):
    b = io.BytesIO()
    if fmt == 'png': im.save(b, format='PNG', optimize=True); return b.getvalue(), 'image/png'
    im.convert('RGB').save(b, format='JPEG', quality=quality, subsampling=0 if quality >= 92 else 2); return b.getvalue(), 'image/jpeg'

def fit(im, size):
    if size and max(im.size) > size:
        im = im.copy(); im.thumbnail((size, size), Image.Resampling.LANCZOS)
    return im

def normal_rgb(im):
    a = np.asarray(im.convert('RGBA')).astype(np.float32) / 255.0
    if a[..., 0].mean() > 0.98 and a[..., 3].std() > 0.01:      # DXT5nm: X in alpha, Y in green
        x, y = a[..., 3] * 2 - 1, a[..., 1] * 2 - 1
    else:                                                        # plain RGB normal
        x, y = a[..., 0] * 2 - 1, a[..., 1] * 2 - 1
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    out = np.stack([x, y, z], -1) * 0.5 + 0.5
    return Image.fromarray((out * 255 + 0.5).clip(0, 255).astype(np.uint8), 'RGB')

def orm_rgb(im):
    a = np.asarray(im.convert('RGBA'))
    return Image.fromarray(np.stack([a[..., 2], a[..., 1], a[..., 0]], -1), 'RGB')   # occ, rough, metal

# --------------------------------------------------------------------------------------- conversion
def tt(o):
    return o.read_typetree()

def convert_weapon_bundle(bundle_path, out_path, args, prefab_info):
    env = UnityPy.load(str(bundle_path))
    objs = {o.path_id: o for o in env.objects}
    gos, trs = {}, {}
    for pid, o in objs.items():
        if o.type.name == 'GameObject': gos[pid] = tt(o)
        elif o.type.name == 'Transform': trs[pid] = tt(o)
    g = Gltf()
    ids = {pid: i for i, pid in enumerate(trs)}
    go_node = {}
    paths = {}
    def path_of(pid):
        if pid in paths: return paths[pid]
        t = trs[pid]; name = gos.get(t['m_GameObject']['m_PathID'], {}).get('m_Name', str(pid))
        f = t['m_Father']['m_PathID']
        paths[pid] = (path_of(f) + '/' if f in trs else '') + name
        return paths[pid]
    for pid, t in trs.items():
        gid = t['m_GameObject']['m_PathID']; go_node[gid] = ids[pid]
        node = {'name': gos.get(gid, {}).get('m_Name', str(pid)),
                'translation': pos(t['m_LocalPosition']), 'rotation': quat(t['m_LocalRotation']),
                'scale': scl(t['m_LocalScale'])}
        kids = [ids[c['m_PathID']] for c in t['m_Children'] if c['m_PathID'] in ids]
        if kids: node['children'] = kids
        if not gos.get(gid, {}).get('m_IsActive', 1): node.setdefault('extras', {})['inactive'] = True
        if t['m_Father']['m_PathID'] not in trs: g.j['scenes'][0]['nodes'].append(ids[pid])
        g.j['nodes'].append(node)
    for pid in trs: path_of(pid)
    roots = g.j['scenes'][0]['nodes']
    warnings = []
    excluded = set()          # GameObject ids of a dropped duplicate root (stat_* vs skin_* variant)
    if len(roots) > 1:
        # Some bundles ship both a static (stat_weNNN_MMM) and a skinned (skin_weNNN_MMM) model of the same
        # weapon; the prefab uses one of them (skinned if it has a SkinnedMeshRenderer, which also carries
        # the spring bones).  Keep that one, drop the other subtree from the scene.
        want = 'skin_' if (prefab_info or {}).get('hasSkin', True) else 'stat_'
        keep = next((r for r in roots if g.j['nodes'][r]['name'].startswith(want)), roots[0])
        node_pid = {i: pid for pid, i in ids.items()}
        def sub(i):
            out = {i}
            for c in g.j['nodes'][i].get('children', []): out |= sub(c)
            return out
        for r in [r for r in roots if r != keep]:
            for i in sub(r): excluded.add(trs[node_pid[i]]['m_GameObject']['m_PathID'])
            warnings.append(f"dropped duplicate root {g.j['nodes'][r]['name']}")
        roots[:] = [keep]
    # world matrices (GLB space) for bounds / checks
    world = {}
    def wm(i, parent=np.eye(4)):
        n = g.j['nodes'][i]
        world[i] = parent @ trs_matrix(n['translation'], n['rotation'], n['scale'])
        for c in n.get('children', []): wm(c, world[i])
    for r in roots: wm(r)

    tex_cache = {}
    def texture(ptr, kind):
        if not ptr or not ptr['m_PathID'] or ptr['m_FileID'] != 0 or ptr['m_PathID'] not in objs: return None, None
        key = (ptr['m_PathID'], kind)
        if key in tex_cache: return tex_cache[key]
        tex = objs[ptr['m_PathID']].read()
        im = tex.image
        name = tex.m_Name
        if kind == 'base':
            has_alpha = name.endswith('T') or np.asarray(im.convert('RGBA'))[..., 3].min() < 250
            im = fit(im, args.albedo_size)
            data, mime = encode(im.convert('RGBA') if has_alpha else im, 'png' if has_alpha else 'jpg', 90)
        elif kind == 'normal':
            data, mime = encode(normal_rgb(fit(im, args.map_size)), 'jpg', 92)
        else:
            data, mime = encode(orm_rgb(fit(im, args.map_size)), 'jpg', 90)
        tex_cache[key] = (g.image(name + {'base': '', 'normal': '_normal', 'orm': '_orm'}[kind], data, mime), name)
        return tex_cache[key]

    mat_cache = {}
    def material(ptr):
        if not ptr or ptr['m_FileID'] != 0 or ptr['m_PathID'] not in objs: return None
        if ptr['m_PathID'] in mat_cache: return mat_cache[ptr['m_PathID']]
        d = tt(objs[ptr['m_PathID']])
        sp = d['m_SavedProperties']
        texenv = {k: v for k, v in sp['m_TexEnvs']}
        floats = {k: v for k, v in sp['m_Floats']}
        colors = {k: v for k, v in sp['m_Colors']}
        kw = d.get('m_ValidKeywords') or (d.get('m_ShaderKeywords') or '').split()
        tags = dict(d.get('stringTagMap', []))
        c = colors.get('_BaseColor', colors.get('_Color', {'r': 1, 'g': 1, 'b': 1, 'a': 1}))
        m = {'name': d['m_Name'], 'pbrMetallicRoughness': {
            'baseColorFactor': [max(0., min(1., float(c[k]))) for k in 'rgba'],
            'metallicFactor': 1.0, 'roughnessFactor': 1.0}}
        used = {}
        e = texenv.get('_BaseMap') or texenv.get('_MainTex')
        if e:
            ti, nm = texture(e['m_Texture'], 'base')
            if ti is not None:
                m['pbrMetallicRoughness']['baseColorTexture'] = {'index': ti}; used['base'] = nm
                if (e['m_Scale']['x'], e['m_Scale']['y'], e['m_Offset']['x'], e['m_Offset']['y']) != (1, 1, 0, 0):
                    warnings.append(f"{d['m_Name']}: _BaseMap tiling/offset not applied")
        e = texenv.get('_BumpMap')
        if e:
            ti, nm = texture(e['m_Texture'], 'normal')
            if ti is not None:
                m['normalTexture'] = {'index': ti, 'scale': float(floats.get('_BumpScale', 1.0))}; used['normal'] = nm
        e = texenv.get('_MetallicGlossMap')
        if e:
            ti, nm = texture(e['m_Texture'], 'orm')
            if ti is not None:
                m['pbrMetallicRoughness']['metallicRoughnessTexture'] = {'index': ti}
                m['occlusionTexture'] = {'index': ti, 'strength': float(floats.get('_OcclusionStrength', 1.0))}
                used['mro'] = nm
        else:
            m['pbrMetallicRoughness']['metallicFactor'] = float(floats.get('_Metallic', 0.0))
            m['pbrMetallicRoughness']['roughnessFactor'] = 1.0 - float(floats.get('_Smoothness', floats.get('_Glossiness', 0.5)))
        ec = colors.get('_EmissionColor')
        e = texenv.get('_EmissionMap')
        if ec and max(ec['r'], ec['g'], ec['b']) > 0:
            m['emissiveFactor'] = [min(1.0, float(ec[k])) for k in 'rgb']
            if e:
                ti, nm = texture(e['m_Texture'], 'base')
                if ti is not None: m['emissiveTexture'] = {'index': ti}
        if floats.get('_AlphaClip', 0) or floats.get('_Alphatest_on', 0) or '_ALPHATEST_ON' in kw or tags.get('RenderType') == 'TransparentCutout':
            m['alphaMode'] = 'MASK'; m['alphaCutoff'] = float(floats.get('_Cutoff', 0.5))
        elif floats.get('_Surface', 0) or tags.get('RenderType') == 'Transparent':
            m['alphaMode'] = 'BLEND'
        if floats.get('_Cull', 2) == 0: m['doubleSided'] = True
        m['extras'] = {'unityTextures': used, 'unityKeywords': kw, 'renderQueue': d.get('m_CustomRenderQueue', -1)}
        mats = g.j.setdefault('materials', [])
        mats.append(m)
        mat_cache[ptr['m_PathID']] = len(mats) - 1
        return mat_cache[ptr['m_PathID']]

    renderers = []
    for o in objs.values():
        if o.type.name == 'SkinnedMeshRenderer':
            d = tt(o); renderers.append(('skin', d, d['m_Mesh']))
        elif o.type.name == 'MeshFilter':
            d = tt(o)
            mr = next((tt(z) for z in objs.values() if z.type.name == 'MeshRenderer'
                       and tt(z)['m_GameObject']['m_PathID'] == d['m_GameObject']['m_PathID']), None)
            renderers.append(('static', mr or {'m_Materials': [], 'm_GameObject': d['m_GameObject'], 'm_Enabled': 1}, d['m_Mesh']))
    meshes_rec = []
    bbox_min = np.full(3, np.inf); bbox_max = np.full(3, -np.inf)
    for kind, r, mptr in renderers:
        if r['m_GameObject']['m_PathID'] in excluded: continue
        if not mptr or mptr['m_FileID'] != 0 or mptr['m_PathID'] not in objs:
            warnings.append('unresolved mesh'); continue
        mesh = objs[mptr['m_PathID']].read()
        h = MeshHandler(mesh); h.process()
        if not h.m_Vertices: warnings.append(f'{mesh.m_Name}: empty'); continue
        v = np.asarray(h.m_Vertices, dtype=float)[:, :3].copy(); v[:, 0] *= -1
        nrm = np.asarray(h.m_Normals, dtype=float)[:, :3].copy() if h.m_Normals else None
        if nrm is not None:
            nrm[:, 0] *= -1
            ln = np.linalg.norm(nrm, axis=1); nrm[ln > 0] /= ln[ln > 0, None]; nrm[ln == 0] = [0, 1, 0]
        uv = None
        if h.m_UV0:
            uv = np.asarray(h.m_UV0, dtype=float)[:, :2].copy(); uv[:, 1] = 1 - uv[:, 1]
        node = go_node.get(r['m_GameObject']['m_PathID'])
        bones = r.get('m_Bones', []) if kind == 'skin' else []
        skin = bool(bones) and bool(h.m_BoneIndices) and bool(mesh.m_BindPose) and all(b['m_PathID'] in trs for b in bones)
        if kind == 'skin' and not skin: warnings.append(f'{mesh.m_Name}: skin unresolved, exported rigid')
        attrs = {'POSITION': g.acc(v, 'VEC3', bounds=True, target=34962)}
        if nrm is not None: attrs['NORMAL'] = g.acc(nrm, 'VEC3', target=34962)
        if uv is not None: attrs['TEXCOORD_0'] = g.acc(uv, 'VEC2', target=34962)
        skin_index = None
        if skin:
            joints = np.zeros((len(v), 4), dtype=np.uint16); weights = np.zeros((len(v), 4))
            src = np.asarray(h.m_BoneIndices); joints[:, :src.shape[1]] = src
            if h.m_BoneWeights:
                w = np.asarray(h.m_BoneWeights); weights[:, :w.shape[1]] = w
            else: weights[:, 0] = 1
            weights = np.maximum(weights, 0); s = weights.sum(axis=1); weights[s == 0, 0] = 1
            weights /= weights.sum(axis=1)[:, None]
            if joints.max() >= len(bones): raise ValueError('joint index out of range')
            attrs['JOINTS_0'] = g.acc(joints, 'VEC4', 5123, target=34962)
            attrs['WEIGHTS_0'] = g.acc(weights, 'VEC4', target=34962)
            bind = []
            for bp in mesh.m_BindPose:
                M = np.array([[getattr(bp, f'e{i}{j}') for j in range(4)] for i in range(4)])
                bind.append((REFLECT @ M @ REFLECT).T.flatten())
            if len(bind) != len(bones): raise ValueError('bindpose/bones mismatch')
            skins = g.j.setdefault('skins', [])
            skins.append({'joints': [ids[b['m_PathID']] for b in bones],
                          'inverseBindMatrices': g.acc(bind, 'MAT4'),
                          'name': mesh.m_Name})
            skin_index = len(skins) - 1
            # bind-pose geometry in model space: vertices are already in the renderer's mesh space;
            # for bounds use the node world matrix of the renderer as an approximation
        prims = []
        mats = r.get('m_Materials', [])
        for sub, tris in enumerate(h.get_triangles()):
            if not tris: continue
            t = np.asarray(tris, dtype=np.uint32)[:, [0, 2, 1]]
            p = {'attributes': attrs, 'indices': g.acc(t.flatten(), 'SCALAR', 5125, target=34963), 'mode': 4}
            mi = material(mats[min(sub, len(mats) - 1)]) if mats else None
            if mi is not None: p['material'] = mi
            prims.append(p)
        if not prims: continue
        gm = g.j.setdefault('meshes', []); gm.append({'name': mesh.m_Name, 'primitives': prims})
        if skin:
            # glTF ignores a skinned node's own transform; keep it at the scene root like the character GLBs
            ni = len(g.j['nodes']); g.j['nodes'].append({'name': mesh.m_Name + '__skinned', 'mesh': len(gm) - 1, 'skin': skin_index})
            g.j['scenes'][0]['nodes'].append(ni)
            if node is not None: g.j['nodes'][ni]['extras'] = {'rendererNode': g.j['nodes'][node]['name']}
            M = np.eye(4)
        else:
            if node is None:
                node = len(g.j['nodes']); g.j['nodes'].append({'name': mesh.m_Name}); roots.append(node); world[node] = np.eye(4)
            if 'mesh' in g.j['nodes'][node]:
                child = len(g.j['nodes']); g.j['nodes'].append({'name': mesh.m_Name, 'mesh': len(gm) - 1})
                g.j['nodes'][node].setdefault('children', []).append(child); world[child] = world[node]
            else:
                g.j['nodes'][node]['mesh'] = len(gm) - 1
            M = world[node]
        if not r.get('m_Enabled', 1): warnings.append(f'{mesh.m_Name}: renderer disabled in source')
        wv = (M @ np.column_stack([v, np.ones(len(v))]).T).T[:, :3]
        bbox_min = np.minimum(bbox_min, wv.min(0)); bbox_max = np.maximum(bbox_max, wv.max(0))
        meshes_rec.append({'name': mesh.m_Name, 'vertices': len(v), 'triangles': int(sum(len(t) for t in h.get_triangles())),
                           'skinned': skin, 'bones': [g.j['nodes'][ids[b['m_PathID']]]['name'] for b in bones] if skin else []})
    if not meshes_rec: return None
    root_name = g.j['nodes'][roots[0]]['name'] if roots else None
    extras = {'basis': BASIS, 'sourceBundle': bundle_path.relative_to(BUNDLES).as_posix(), 'unityRoot': root_name}
    if prefab_info:
        extras.update({k: prefab_info[k] for k in ('prefab', 'equipmentType', 'tip', 'outgameDisplay') if k in prefab_info})
    g.j['extras'] = extras
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data = g.bytes()
    out_path.write_bytes(data)
    return {'meshes': meshes_rec, 'warnings': sorted(set(warnings)), 'bytes': len(data),
            'bounds': [bbox_min.round(4).tolist(), bbox_max.round(4).tolist()],
            'nodes': {paths[pid].split('/', 1)[1] if '/' in paths[pid] else '': g.j['nodes'][ids[pid]]['name'] for pid in trs},
            'textures': len(g.j.get('images', []))}

# ----------------------------------------------------------------------------------------- prefabs
def read_prefab(path):
    """Weapon prefab: equipment type, tip locator (GLB space, relative to the prefab root), outgame display."""
    env = UnityPy.load(str(path))
    gos, trs, mb = {}, {}, None
    has_skin = False
    for o in env.objects:
        n = o.type.name
        if n == 'SkinnedMeshRenderer': has_skin = True
        if n == 'GameObject': gos[o.path_id] = tt(o)['m_Name']
        elif n == 'Transform': trs[o.path_id] = tt(o)
        elif n == 'MonoBehaviour' and mb is None:
            try:
                d = tt(o)
                if '_equipmentType' in d: mb = d
            except Exception: pass
    if mb is None: return None
    def world(pid):
        M = np.eye(4)
        while pid in trs:
            t = trs[pid]
            M = trs_matrix(pos(t['m_LocalPosition']), quat(t['m_LocalRotation']), scl(t['m_LocalScale'])) @ M
            pid = t['m_Father']['m_PathID']
        return M
    roots = [k for k, t in trs.items() if t['m_Father']['m_PathID'] not in trs]
    info = {'prefab': path.relative_to(BUNDLES).as_posix(), 'equipmentType': int(mb['_equipmentType']), 'hasSkin': has_skin}
    root = trs[roots[0]] if roots else None
    if root:
        info['rootTransform'] = {'position': pos(root['m_LocalPosition']), 'quaternion': quat(root['m_LocalRotation']),
                                 'scale': scl(root['m_LocalScale'])}
    pt = mb.get('_transformReference', {}).get('point', {}).get('m_PathID')
    if pt and pt in trs:
        info['tip'] = [round(x, 5) for x in world(pt)[:3, 3].tolist()]
    info['outgameDisplay'] = {'scale': mb.get('_outgameDisplayScale'),
                              'offsetPosition': pos(mb['_outgameDisplayOffsetPosition']),
                              'offsetQuaternion': quat(mb['_outgameDisplayOffsetRotation'])}
    info['seType'] = mb.get('_weaponSeTypeId') or None
    info['effects'] = sorted({gos[t['m_GameObject']['m_PathID']] for t in trs.values()
                              if gos.get(t['m_GameObject']['m_PathID'], '').startswith('pfb_eff_')})
    return info

def read_character_prefab(path):
    env = UnityPy.load(str(path))
    gos, trs, objs = {}, {}, {}
    for o in env.objects:
        objs[o.path_id] = o
        if o.type.name == 'GameObject': gos[o.path_id] = tt(o)['m_Name']
        elif o.type.name == 'Transform': trs[o.path_id] = tt(o)
    tname = {k: gos.get(v['m_GameObject']['m_PathID']) for k, v in trs.items()}
    tgo = {v['m_GameObject']['m_PathID']: k for k, v in trs.items()}
    def tpath(pid):
        names = []
        while pid in trs:
            names.append(tname[pid]); pid = trs[pid]['m_Father']['m_PathID']
        return '/'.join(reversed(names))
    for o in env.objects:
        if o.type.name != 'MonoBehaviour': continue
        try: d = tt(o)
        except Exception: continue
        if '_equipPointInfos' not in d: continue
        ref = lambda p: tname.get(p['m_PathID']) if p and p['m_PathID'] else None
        tr = d.get('_transformReference', {})
        res = {'prefab': path.relative_to(BUNDLES).as_posix(),
               'equipPoints': {e['name']: ref(e['point']) for e in d['_equipPointInfos']},
               'rightWeapon': ref(tr.get('RightWeapon')), 'leftWeapon': ref(tr.get('LeftWeapon')),
               'centerWeapon': ref(tr.get('CenterWeapon')), 'builtIn': []}
        for s in d.get('_setupEquipInfos', []):
            wb = s.get('weaponBody')
            if not wb or not wb['m_PathID'] or wb['m_PathID'] not in objs: continue
            wd = tt(objs[wb['m_PathID']])
            tp = tgo.get(wd['m_GameObject']['m_PathID'])
            full = tpath(tp)
            m = re.search(r'(?:^|/)pfb_we(\d+)_(\d+)(?:/(.*))?$', full)
            t = trs[tp]
            res['builtIn'].append({'point': s['equipPointName'], 'sourcePath': full,
                                   'weapon': f'{m.group(1)}_{m.group(2)}' if m else None,
                                   'node': (m.group(3).rsplit('/', 1)[-1] if m.group(3) else None) if m else None,
                                   'nodePath': (m.group(3) or None) if m else None,
                                   'equipmentType': wd.get('_equipmentType'),
                                   'localInPrefab': {'position': pos(t['m_LocalPosition']), 'quaternion': quat(t['m_LocalRotation']),
                                                     'scale': scl(t['m_LocalScale']),
                                                     'parent': tname.get(t['m_Father']['m_PathID'])}})
        return res
    return None

# ------------------------------------------------------------------------------------------ master
def master():
    c = sqlite3.connect(f'file:{DB.as_posix()}?mode=ro', uri=True)
    def rows(t): return [json.loads(r[0]) for r in c.execute('select raw_json from master_rows where table_name=? order by row_index', (t,))]
    def cols(t): return {n: i for i, n in c.execute('select field_index, field_name from master_columns where table_name=?', (t,))}
    def loc(t): return dict(c.execute("select text_id, value from localizations where table_name=? and language='en'", (t,)).fetchall())
    W, WC = rows('m_weapon'), cols('m_weapon')
    R, RC = rows('m_weapon_rarity'), cols('m_weapon_rarity')
    CC, CCC = rows('m_character_costume'), cols('m_character_costume')
    CH, CHC = rows('m_character'), cols('m_character')
    wl = loc('m_weapon')
    rar = collections.defaultdict(set)
    for r in R: rar[r[RC['WeaponId']]].add(r[RC['RarityType']])
    weapons = {}
    for w in W:
        wid = w[WC['Id']]
        weapons[wid] = {'id': wid, 'characterId': w[WC['CharacterId']], 'resourceId': w[WC['ResourceId']],
                        'weaponType': w[WC['WeaponType']], 'name': wl.get(str(w[WC['NameLanguageId']])),
                        'rarities': sorted(rar.get(wid, []))}
    costumes = {r[CCC['Id']]: {'characterId': r[CCC['CharacterId']], 'resourceId': r[CCC['ResourceId']],
                               'setWeaponId': r[CCC['SetWeaponId']]} for r in CC}
    chars = {r[CHC['Id']]: {'resourceId': r[CHC['ResourceId']], 'defaultWeaponId': r[CHC['DefaultWeaponId']],
                            'defaultCostumeId': r[CHC['DefaultCharacterCostumeId']]} for r in CH}
    return weapons, costumes, chars

def res_key(resource_id): return f'{resource_id // 1000:03d}_{resource_id % 1000:03d}'

# -------------------------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--no-models', action='store_true')
    ap.add_argument('--albedo-size', type=int, default=1024)
    ap.add_argument('--map-size', type=int, default=512)
    args = ap.parse_args()
    t0 = time.time()
    only = [s.strip() for s in args.only.split(',') if s.strip()]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report_path = OUT_DIR / '_conversion.json'
    conv = json.loads(report_path.read_text(encoding='utf8')) if report_path.exists() else {}

    # 1. weapon GLBs ---------------------------------------------------------------------------------
    bundles = sorted((BUNDLES / 'weapon').glob('*/model/*.d'))
    for b in bundles:
        folder, model = b.parent.parent.name, b.stem
        key = f'{folder}_{model}'
        if only and not any(f'{folder}/{model}'.startswith(o) for o in only): continue
        out = OUT_DIR / folder / f'{model}.glb'
        if args.no_models or (out.exists() and not args.force and key in conv): continue
        pfb = b.parent.parent / f'pfb_we{folder}_{model}.a'
        info = read_prefab(pfb) if pfb.exists() else None
        try:
            r = convert_weapon_bundle(b, out, args, info)
        except Exception as e:
            conv[key] = {'status': 'failed', 'error': f'{type(e).__name__}: {e}'}
            print('FAILED', key, e, flush=True); continue
        if r is None:
            conv[key] = {'status': 'no-geometry'}; continue
        conv[key] = {'status': 'converted', 'glb': f'/gen/weapons/{folder}/{model}.glb', 'prefab': info, **r}
        print(f'{key}: {len(r["meshes"])} mesh(es), {r["bytes"]//1024} KiB', ' '.join(r['warnings']), flush=True)
    report_path.write_text(json.dumps(conv, ensure_ascii=False, indent=1), encoding='utf8')

    # 2. character equip points ----------------------------------------------------------------------
    chars_manifest = json.loads(CHARACTERS_JSON.read_text(encoding='utf8'))
    battle = chars_manifest['battle']
    prefab_cache = {}
    def char_prefab(cid, model):
        d = BUNDLES / 'character' / cid
        exact = d / f'pfb_ch{cid}_{model}.a'
        cands = [exact] if exact.exists() else sorted(d.glob(f'pfb_ch{cid}_{model}_*.a'),
                                                      key=lambda p: ('cutscene' in p.name, 'aura' in p.name, len(p.name), p.name))
        for p in cands:
            if p not in prefab_cache: prefab_cache[p] = read_character_prefab(p)
            if prefab_cache[p]: return prefab_cache[p]
        return None
    weapons_m, costumes_m, chars_m = master()
    glb_json = {}
    def glb_nodes_of(url):
        if url not in glb_json:
            p = LIB / url[len('/lib/'):]
            glb_json[url] = read_glb_json(p)['nodes'] if p.exists() else []
        return glb_json[url]
    def glb_names(url): return {n.get('name') for n in glb_nodes_of(url)}
    anim_index_path = ROOT / 'generated' / 'anims' / 'index.json'
    anim_models = json.loads(anim_index_path.read_text(encoding='utf8'))['models'] if anim_index_path.exists() else {}
    clip_cache = {}
    CARRIERS = ('right_hand_weapon', 'left_hand_weapon', 'loc_back_weapon', 'caitsith_right_hand_weapon',
                'caitsith_left_hand_weapon', 'gun', 'right_hand', 'left_hand')
    def idle_carrier(url):
        """FK of the model's battle idle clip (generated/anims, frame 0): which hand/locator bone the
        root-level main_weapon/sub_weapon carriers coincide with."""
        entry = anim_models.get(url[len('/lib/'):])
        f = entry and (entry.get('locomotionFiles') or {}).get('idle')
        if not f or not (ROOT / 'generated' / 'anims' / f).exists(): return None
        if f not in clip_cache: clip_cache[f] = json.loads((ROOT / 'generated' / 'anims' / f).read_text(encoding='utf8'))
        nodes = glb_nodes_of(url)
        idx = {n.get('name'): i for i, n in enumerate(nodes)}
        trs_ = [[list(n.get('translation', [0, 0, 0])), list(n.get('rotation', [0, 0, 0, 1])), list(n.get('scale', [1, 1, 1]))] for n in nodes]
        animated = set()
        for t in clip_cache[f]['tracks']:
            nm, prop = t['name'].rsplit('.', 1)
            if nm not in idx: continue
            k, n = {'position': (0, 3), 'quaternion': (1, 4), 'scale': (2, 3)}[prop]
            trs_[idx[nm]][k] = t['values'][:n]; animated.add(nm)
        par = {c: i for i, n in enumerate(nodes) for c in n.get('children', [])}
        Wm = {}
        def w(i):
            if i not in Wm: Wm[i] = (w(par[i]) if i in par else np.eye(4)) @ trs_matrix(*trs_[i])
            return Wm[i]
        out = {'clip': f}
        for carrier in ('main_weapon', 'sub_weapon'):
            if carrier not in idx: continue
            if carrier not in animated: out[carrier] = {'animated': False}; continue
            pc = w(idx[carrier])[:3, 3]
            best = min(((float(np.linalg.norm(w(idx[b])[:3, 3] - pc)), b) for b in CARRIERS if b in idx), default=None)
            out[carrier] = {'animated': True, 'nearest': best[1], 'distance': round(best[0], 4)} if best else {'animated': True}
        return out

    models = {}
    for b in battle:
        cid, model = b['id'].split('/')
        pf = char_prefab(cid, model)
        names = glb_names(b['glb'])
        e = {'characterId': cid, 'glb': b['glb'], 'costumeId': b.get('costumeId'), 'prefab': pf['prefab'] if pf else None,
             'equipPoints': {k: v for k, v in (pf['equipPoints'] if pf else {}).items() if v},
             'rightWeapon': pf.get('rightWeapon') if pf else None, 'leftWeapon': pf.get('leftWeapon') if pf else None,
             'builtIn': pf['builtIn'] if pf else []}
        missing = sorted({v for v in list(e['equipPoints'].values()) + [e['rightWeapon'], e['leftWeapon']] if v and v not in names})
        if missing: e['missingBones'] = missing
        if not e['equipPoints']: e['noEquip'] = True      # e.g. x/998, x/999 placeholder models, some cutscene rigs
        ic = idle_carrier(b['glb']) if not e.get('noEquip') else None
        if ic: e['idleCarrier'] = ic
        models[b['id']] = e

    # per-character majority equip points
    per_char_points = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    per_char_lr = collections.defaultdict(lambda: [collections.Counter(), collections.Counter()])
    for mid, e in models.items():
        for k, v in e['equipPoints'].items(): per_char_points[e['characterId']][k][v] += 1
        if e['rightWeapon']: per_char_lr[e['characterId']][0][e['rightWeapon']] += 1
        if e['leftWeapon']: per_char_lr[e['characterId']][1][e['leftWeapon']] += 1
    def char_point(cid, point):
        c = per_char_points[cid].get(point)
        return c.most_common(1)[0][0] if c else None
    per_char_carrier = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
    for mid, e in models.items():
        for carrier, v in (e.get('idleCarrier') or {}).items():
            if isinstance(v, dict) and v.get('distance') is not None and v['distance'] < 0.05 and v['nearest'] not in ('right_hand', 'left_hand'):
                per_char_carrier[e['characterId']][carrier][v['nearest']] += 1
    def char_fallback(cid, side):
        # the hand bone the animated carrier sits on in the idle pose (Sephiroth: left_hand_weapon)
        c = per_char_carrier[cid].get('main_weapon' if side == 'R' else 'sub_weapon')
        if not c and cid.startswith('9'):     # 9NN battle rigs are variants of playable 0NN (949 -> 049 Sephiroth)
            c = per_char_carrier.get('0' + cid[1:], {}).get('main_weapon' if side == 'R' else 'sub_weapon')
        if c: return c.most_common(1)[0][0]
        c = per_char_lr[cid][0 if side == 'R' else 1]
        return c.most_common(1)[0][0] if c else None

    # 3. weapons per character -------------------------------------------------------------------------
    by_res = collections.defaultdict(list)
    for w in weapons_m.values(): by_res[res_key(w['resourceId'])].append(w)
    converted = {k: v for k, v in conv.items() if v.get('status') == 'converted'}
    battle_chars = sorted({b['characterId'] for b in battle})
    # weapons referenced as built-ins by a character's prefabs (e.g. 902 -> 002_001)
    builtin_refs = collections.defaultdict(set)
    for mid, e in models.items():
        for bi in e['builtIn']:
            if bi['weapon']: builtin_refs[e['characterId']].add(bi['weapon'])

    def weapon_entry(key, cid, point='Main', node=None):
        c = converted[key]
        pf = c.get('prefab') or {}
        mw = sorted(by_res.get(key, []), key=lambda w: w['id'])
        mode = 'skin' if pf.get('equipmentType') == 1 else 'rigid'
        main_bone = char_point(cid, point) or (char_fallback(cid, 'R') if point.startswith('Main') else char_fallback(cid, 'L'))
        fb = None
        if main_bone in ('main_weapon',): fb = char_fallback(cid, 'R')
        elif main_bone in ('sub_weapon',): fb = char_fallback(cid, 'L')
        ent = {'id': key, 'name': mw[0]['name'] if mw else None, 'glb': c['glb']}
        if mw:
            ent['weaponIds'] = [w['id'] for w in mw]
            if len(mw) > 1: ent['names'] = [w['name'] for w in mw]
            rs = sorted({r for w in mw for r in w['rarities']})
            ent['rarity'] = rs[0] if rs else None
            ent['rarities'] = rs
            ent['weaponType'] = mw[0]['weaponType']
        else:
            ent['masterData'] = False
        if pf.get('tip'): ent['tip'] = pf['tip']
        if pf.get('effects'): ent['effects'] = pf['effects']
        ent['equipmentType'] = pf.get('equipmentType', 0)
        if mode == 'skin':
            ent['attach'] = [{'mode': 'skin', 'point': point, 'bone': None,
                              'skinJoints': sorted({j for m in c['meshes'] for j in m['bones']})}]
        else:
            ent['attach'] = [{'mode': 'rigid', 'point': point, 'bone': main_bone, 'fallbackBone': fb, 'node': node,
                              'position': [0, 0, 0], 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]}]
        return ent

    by_character = {}
    for cid in battle_chars:
        keys = sorted(k for k in converted if k.startswith(cid + '_'))
        keys += sorted(k for k in builtin_refs[cid] if k in converted and k not in keys)
        lst = []
        for key in keys:
            # built-in multi-part weapons (Rufus 015_001: right_weapon -> Main, left_weapon -> Main2)
            parts = [bi for e in models.values() if e['characterId'] == cid for bi in e['builtIn'] if bi['weapon'] == key and bi['node']]
            if parts:
                seen = {}
                for bi in parts: seen.setdefault(bi['node'], bi['point'])
                ent = weapon_entry(key, cid)
                ent['attach'] = [weapon_entry(key, cid, pt, nd)['attach'][0] for nd, pt in sorted(seen.items(), key=lambda x: x[1])]
            else:
                pts = {bi['point'] for e in models.values() if e['characterId'] == cid for bi in e['builtIn'] if bi['weapon'] == key}
                pt = sorted(pts)[0] if pts else 'Main'
                ent = weapon_entry(key, cid, pt)
            lst.append(ent)
        if lst: by_character[cid] = lst

    # 4. costume defaults ----------------------------------------------------------------------------
    costume_default, costume_extras, default_source = {}, {}, {}
    def starting_weapon(cid):
        ch = chars_m.get(int(cid))
        if ch and ch['defaultWeaponId'] in weapons_m:
            k = res_key(weapons_m[ch['defaultWeaponId']]['resourceId'])
            if k in converted: return k, 'm_character.DefaultWeaponId'
        cands = sorted((w for w in weapons_m.values() if w['characterId'] == int(cid) and res_key(w['resourceId']) in converted),
                       key=lambda w: (min(w['rarities'] or [99]), w['id']))
        if cands: return res_key(cands[0]['resourceId']), 'lowest master weapon id'
        return None, None
    for mid, e in models.items():
        cid = e['characterId']
        main_bi = [bi for bi in e['builtIn'] if bi['point'] == 'Main' and bi['weapon'] in converted]
        extra_bi = [bi for bi in e['builtIn'] if bi['point'] != 'Main' and bi['weapon'] in converted]
        dflt, src = None, None
        cos = costumes_m.get(e['costumeId']) if e['costumeId'] else None
        if cos and cos['setWeaponId'] in weapons_m:
            k = res_key(weapons_m[cos['setWeaponId']]['resourceId'])
            if k in converted: dflt, src = k, 'm_character_costume.SetWeaponId'
        if dflt is None and main_bi:
            dflt, src = main_bi[0]['weapon'], f"prefab built-in ({e['prefab']})"
        if dflt is None and e['equipPoints'] and cid in by_character:
            dflt, src = starting_weapon(cid)
        if dflt is None and e['equipPoints']:
            # same model, other prefab variants (pfb_ch010_001_enemy mounts pfb_we010_001 itself)
            cid_, model_ = mid.split('/')
            for vp in sorted((BUNDLES / 'character' / cid_).glob(f'pfb_ch{cid_}_{model_}_*.a')):
                if vp not in prefab_cache: prefab_cache[vp] = read_character_prefab(vp)
                v = prefab_cache[vp]
                hit = [bi for bi in (v['builtIn'] if v else []) if bi['point'] == 'Main' and bi['weapon'] in converted]
                if hit: dflt, src = hit[0]['weapon'], f"prefab built-in ({v['prefab']})"; break
        if dflt is None and e['equipPoints'] and len(by_character.get(cid, [])) == 1:
            dflt, src = by_character[cid][0]['id'], "character's only weapon model"
        if dflt:
            costume_default[mid] = dflt; default_source[mid] = src
        if extra_bi:
            costume_extras[mid] = [{'id': bi['weapon'], 'point': bi['point'], 'node': bi['node'],
                                    'bone': e['equipPoints'].get(bi['point']),
                                    'fallbackBone': char_fallback(cid, 'L') if e['equipPoints'].get(bi['point']) == 'sub_weapon'
                                                    else char_fallback(cid, 'R') if e['equipPoints'].get(bi['point']) == 'main_weapon' else None,
                                    'position': [0, 0, 0], 'quaternion': [0, 0, 0, 1], 'scale': [1, 1, 1]}
                                   for bi in extra_bi]
            # Rufus-style multi-part built-ins listed under Main2 etc. are already in the weapon's attach list
            costume_extras[mid] = [x for x in costume_extras[mid] if not (x['id'] == dflt and x['node'])]
            if not costume_extras[mid]: del costume_extras[mid]

    unassigned = sorted(k for k in converted if not any(k == w['id'] for lst in by_character.values() for w in lst))
    out = {
        'version': VERSION, 'generatedBy': 'tools/build_weapons.py',
        'basis': BASIS,
        'notes': {
            'attach': 'Parent the weapon GLB scene (or attach[i].node inside it, detached from its parent) to the bone '
                      'named attach[i].bone of the character GLB with the given local position/quaternion/scale '
                      '(identity: the weapon origin is the grip). If the playing clip has no track for that bone '
                      '(main_weapon/sub_weapon are root-level carriers driven only by battle animations), use '
                      'attach[i].fallbackBone. Per-costume overrides: models[<battle id>].equipPoints[attach[i].point].',
            'skin': "mode 'skin' (equipmentType 1, Tifa's gloves): the GLB holds skinned meshes whose joints are a copy of "
                    'the character skeleton; add the scene under the character root and rebind every SkinnedMesh joint to '
                    "the character node with the same name (keep the GLB's inverse bind matrices).",
            'extras': 'costumeExtras: additional built-in weapons a costume prefab mounts itself (setupEquipInfos), '
                      'e.g. Matt Sub, Lucia Sub2, Angeal Sword on loc_back_weapon.',
            'textures': 'baseColor sRGB from *_AAAX/AAAT; normal from *_NNNX (DXT5nm AG -> RGB); MROX R=metal G=rough '
                        'B=occlusion -> glTF ORM (R=occ,G=rough,B=metal).',
            'tip': 'tip = Locators/point of the weapon prefab (blade tip / muzzle) in weapon GLB space.',
        },
        'byCharacter': by_character,
        'costumeDefault': costume_default,
        'costumeDefaultSource': default_source,
        'costumeExtras': costume_extras,
        'models': models,
        'unassigned': [{'id': k, 'glb': converted[k]['glb']} for k in unassigned],
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf8')

    # 5. checks --------------------------------------------------------------------------------------
    problems = []
    for k, c in converted.items():
        p = OUT_DIR / c['glb'].split('/gen/weapons/')[1]
        try:
            j = read_glb_json(p)
            assert j['asset']['version'] == '2.0' and j.get('meshes'), 'no meshes'
        except Exception as ex: problems.append(f'GLB {k}: {ex}')
    for mid, e in models.items():
        if e.get('noEquip'): continue
        names = glb_names(e['glb'])
        cid = e['characterId']
        for w in by_character.get(cid, []):
            for a in w['attach']:
                bone = e['equipPoints'].get(a['point'], a.get('bone'))
                if a['mode'] == 'rigid' and bone and bone not in names: problems.append(f'{mid}: bone {bone} missing for {w["id"]}')
                if a['mode'] == 'rigid' and a.get('fallbackBone') and a['fallbackBone'] not in names:
                    problems.append(f'{mid}: fallback {a["fallbackBone"]} missing')
                if a['mode'] == 'skin':
                    miss = [j for j in a['skinJoints'] if j not in names]
                    if miss: problems.append(f'{mid}: skin joints missing for {w["id"]}: {miss[:5]}')
    n_w = sum(len(v) for v in by_character.values())
    print(f'converted GLBs: {len(converted)} (failed {sum(1 for v in conv.values() if v.get("status") == "failed")})')
    print(f'characters: {len(by_character)} / battle characters {len(battle_chars)}; weapon entries {n_w}; unassigned {len(unassigned)}')
    print(f'battle models: {len(models)}; defaults resolved {len(costume_default)}; extras {len(costume_extras)}')
    print('default sources:', dict(collections.Counter(s.split(' (')[0] for s in default_source.values())))
    print('no default:', sorted(m for m in models if m not in costume_default))
    print(f'problems: {len(problems)}')
    for p in sorted(set(problems))[:60]: print('  ', p)
    print(f'done in {time.time() - t0:.0f}s')

if __name__ == '__main__':
    main()
