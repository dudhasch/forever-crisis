# Vendored from explorer/tools/extract_dungeon_maps.py by release-tools/sync_vendor.py - do not edit here.
"""Extract the walkable layout of every Ever Crisis map scene into JSON for the explorer.

Run with the UnityPy environment:
    python tools\\extract_dungeon_maps.py [map_key ...]

Reads  02-DecodedBundles/scenes/{dungeon_map,environment}_*.s  (read-only) and writes
generated/layout/<map_key>.json containing, in glTF/three.js space (Unity x negated):
  cameras      pre-render capture cameras (position, quaternion, capture FOV, pan limits, textures)
  cameraAreas  trigger boxes that select the active camera
  startPoints  spawn points
  collision    floor/wall/other collider meshes as world-space triangle soups
  gimmicks     gimmick objects with their animation clip names
"""
import os as _os
from pathlib import Path as _P
import json
import math
import sys
from pathlib import Path

import numpy as np
import UnityPy

ARCHIVE = _P(_os.environ['FFCX_ARCHIVE'])
SCENES = ARCHIVE / '02-DecodedBundles' / 'scenes'
OUT = _P(_os.environ['FFCX_GEN']) / 'layout'


def to_pos(v):
    return [-v['x'], v['y'], v['z']]


def to_quat(q):
    return [q['x'], -q['y'], -q['z'], q['w']]


def quat_mat(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def png_size(path):
    """(width, height) from a PNG's IHDR chunk without decoding it."""
    with open(path, 'rb') as f:
        head = f.read(24)
    return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')


def r(v, n=4):
    if isinstance(v, (list, tuple)):
        return [r(x, n) for x in v]
    return round(float(v), n)


class Scene:
    """Object graph of one scene bundle. Keys are (serialized file name, path id) because the scene file
    and its .sharedAssets companion reuse path ids."""

    def __init__(self, path):
        self.env = UnityPy.load(str(path))
        self.files = {}
        for bundle in self.env.files.values():
            for name, f in getattr(bundle, 'files', {}).items():
                if hasattr(f, 'objects') and hasattr(f, 'externals'):
                    self.files[name] = f
        self.objects = {}
        for fname, f in self.files.items():
            for pid, o in f.objects.items():
                self.objects[(fname, pid)] = o
        self.trees = {}
        self.scripts = {}
        for key, o in self.objects.items():
            if o.type.name == 'MonoScript':
                self.scripts[key] = o.read_typetree().get('m_Name', '')
        self.go = {}
        self.transform_of = {}
        for key, o in self.objects.items():
            if o.type.name == 'GameObject':
                t = self.tree(key)
                comps = [self.ref(key, c['component']) for c in t.get('m_Component', [])]
                self.go[key] = {'name': t.get('m_Name', ''), 'components': comps}
                for c in comps:
                    co = self.objects.get(c)
                    if co is not None and co.type.name in ('Transform', 'RectTransform'):
                        self.transform_of[key] = c
        self.world_cache = {}

    def ref(self, owner, ptr):
        """Resolve a PPtr found in object `owner` to an object key (may point outside this bundle)."""
        if not ptr:
            return None
        fid, pid = ptr.get('m_FileID', 0), ptr.get('m_PathID', 0)
        if not pid:
            return None
        if fid == 0:
            return (owner[0], pid)
        f = self.files[owner[0]]
        try:
            ext = f.externals[fid - 1].path
        except IndexError:
            return None
        base = ext.split('/')[-1]
        return (base, pid)

    def tree(self, key):
        if key not in self.trees:
            try:
                self.trees[key] = self.objects[key].read_typetree()
            except Exception:
                self.trees[key] = {}
        return self.trees[key]

    def script_name(self, key):
        return self.scripts.get(self.ref(key, self.tree(key).get('m_Script')), '?')

    def components(self, go_key, type_name=None):
        for c in self.go.get(go_key, {}).get('components', []):
            o = self.objects.get(c)
            if o is None:
                continue
            if type_name and o.type.name != type_name:
                continue
            yield c

    def go_of(self, key):
        return self.ref(key, self.tree(key).get('m_GameObject'))

    def path(self, tr_key):
        t = self.tree(tr_key)
        name = self.go.get(self.ref(tr_key, t.get('m_GameObject')), {}).get('name', '?')
        father = self.ref(tr_key, t.get('m_Father'))
        return (self.path(father) + '/' if father in self.objects else '') + name

    def world(self, tr_key):
        """World transform in Unity space: (position, rotation matrix, lossy scale)."""
        if tr_key in self.world_cache:
            return self.world_cache[tr_key]
        t = self.tree(tr_key)
        lp = np.array([t['m_LocalPosition'][k] for k in 'xyz'])
        lq = [t['m_LocalRotation'][k] for k in 'xyzw']
        ls = np.array([t['m_LocalScale'][k] for k in 'xyz'])
        father = self.ref(tr_key, t.get('m_Father'))
        if father in self.objects:
            fp, fr, fs = self.world(father)
            p = fp + fr @ (fs * lp)
            rm = fr @ quat_mat(lq)
            s = fs * ls
        else:
            p, rm, s = lp, quat_mat(lq), ls
        self.world_cache[tr_key] = (p, rm, s)
        return p, rm, s

    def world_of_go(self, go_key):
        return self.world(self.transform_of[go_key])


def mat_to_quat(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1.0) * 2
        return [(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s]
    if m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return [0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s]
    if m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return [(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s]
    s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return [(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s]


def unity_pose(scene, go_pid):
    p, rm, s = scene.world_of_go(go_pid)
    q = mat_to_quat(rm)
    return to_pos(dict(zip('xyz', p))), to_quat(dict(zip('xyzw', q))), s


def mesh_triangles(scene, mesh_key):
    """Return (vertices Nx3 unity-local, triangles Mx3) for a Mesh object."""
    from UnityPy.helpers.MeshHelper import MeshHandler
    h = MeshHandler(scene.objects[mesh_key].read())
    h.process()
    verts = np.array(h.m_Vertices, dtype=float).reshape(-1, 3)
    tris = []
    for sub in h.get_triangles():
        tris.extend(sub)
    return verts, np.array(tris, dtype=np.int64).reshape(-1, 3)


_cab_cache = {}


def texture_bundles(key):
    """Map CAB name -> texture bundle stem for the pre-rendered backgrounds of a dungeon map."""
    num = key.rsplit('_', 1)[-1]
    folder = ARCHIVE / '02-DecodedBundles' / 'dungeonmap' / num / 'textures'
    if folder in _cab_cache:
        return _cab_cache[folder]
    out = {}
    for f in sorted(folder.glob('*.a')) if folder.exists() else []:
        try:
            env = UnityPy.load(str(f))
        except Exception:
            continue
        for bundle in env.files.values():
            for name in getattr(bundle, 'files', {}):
                if not name.endswith('.resS'):
                    out[name] = f.stem
    _cab_cache[folder] = out
    return out


def extract(key):
    src = SCENES / f'{key}.s'
    scene = Scene(src)
    data = {'key': key, 'cameras': [], 'cameraAreas': [], 'startPoints': [], 'collision': [], 'gimmicks': [],
            'environment': None, 'defaultCameras': []}

    by_script = {}
    for k, o in scene.objects.items():
        if o.type.name == 'MonoBehaviour':
            by_script.setdefault(scene.script_name(k), []).append((k, scene.tree(k)))

    cabs = texture_bundles(key) if key.startswith('dungeon_map_') else {}

    def tex(owner, ptr):
        """URL (under the /arc mount) of the PNG export of a background texture bundle."""
        ref = scene.ref(owner, ptr)
        stem = cabs.get(ref[0]) if ref else None
        if not stem:
            return None
        folder = ARCHIVE / '03-ExtractedAssets' / 'dungeonmap' / key.rsplit('_', 1)[-1] / 'textures' / stem / 'Texture2D'
        pngs = sorted(folder.glob('*.png'))
        if not pngs:
            return None
        return '/arc/' + pngs[0].relative_to(ARCHIVE).as_posix()

    # Capture cameras: PlaneEnvironmentCamera lives on the camera_XX object.
    for k, t in by_script.get('PlaneEnvironmentCamera', []):
        go = scene.go_of(k)
        name = scene.go[go]['name']
        pos, quat, _ = unity_pose(scene, go)
        cam = {'name': name.replace('camera_', ''), 'object': name, 'position': r(pos), 'quaternion': r(quat, 6),
               'captureFov': r(t.get('_captureFov')), 'maxVerticalAngle': r(t.get('_maxVerticalAngle')),
               'maxHorizontalAngle': r(t.get('_maxHorizontalAngle')), 'upDirection': t.get('_upDirection'),
               'color': tex(k, t.get('_colorTexture')), 'depthA': tex(k, t.get('_depthATexture')),
               'depthB': tex(k, t.get('_depthBTexture'))}
        vc = scene.ref(k, t.get('_virtualCamera'))
        if vc in scene.objects:
            vt = scene.tree(vc)
            lens = vt.get('m_Lens', {})
            cam['lensFov'] = r(lens.get('FieldOfView', 0))
            cam['near'] = r(lens.get('NearClipPlane', 0.3))
            cam['far'] = r(lens.get('FarClipPlane', 1000))
            cam['hasFollow'] = bool(scene.ref(vc, vt.get('m_Follow')))
            cam['hasLookAt'] = bool(scene.ref(vc, vt.get('m_LookAt')))
        for c in scene.components(go, 'Camera'):
            cam['unityCameraFov'] = r(scene.tree(c).get('field of view', 0))
        if cam['color']:
            w, h = png_size(ARCHIVE / cam['color'][len('/arc/'):])
            cam['aspect'] = round(w / h, 4)  # most captures are 2:1, a few are square
        data['cameras'].append(cam)
    data['cameras'].sort(key=lambda c: c['name'])

    for k, t in by_script.get('CameraArea', []):
        go = scene.go_of(k)
        p, rm, s = scene.world_of_go(go)
        boxes = []
        for c in scene.components(go, 'BoxCollider'):
            bt = scene.tree(c)
            center = np.array([bt['m_Center'][a] for a in 'xyz'])
            size = np.array([bt['m_Size'][a] for a in 'xyz']) * np.abs(s)
            wc = p + rm @ (s * center)
            q = mat_to_quat(rm)
            boxes.append({'center': r(to_pos(dict(zip('xyz', wc)))), 'size': r(list(size)),
                          'quaternion': r(to_quat(dict(zip('xyzw', q))), 6)})
        data['cameraAreas'].append({'object': scene.go[go]['name'], 'camera': t.get('_cameraName'),
                                    'fadeCameras': t.get('_fadeCameraNames', []), 'boxes': boxes})
    data['cameraAreas'].sort(key=lambda a: a['object'])

    for k, t in by_script.get('StartPoint', []):
        go = scene.go_of(k)
        pos, quat, _ = unity_pose(scene, go)
        data['startPoints'].append({'name': scene.go[go]['name'], 'position': r(pos), 'quaternion': r(quat, 6)})
    data['startPoints'].sort(key=lambda s: s['name'])

    for k, t in by_script.get('DungeonMap', []):
        cams = []
        for ptr in t.get('_defaultCameras', []):
            ref = scene.ref(k, ptr)
            if ref in scene.objects:
                g = scene.go_of(ref) if scene.objects[ref].type.name != 'GameObject' else ref
                cams.append(scene.go.get(g, {}).get('name'))
        data['defaultCameras'] = cams
        data['fallY'] = t.get('_forceReturnFromFallPosY')

    for k, t in by_script.get('EnvironmentData', []):
        if t.get('m_Name', '').startswith('dat_env_') and 'camera' not in t.get('m_Name', ''):
            def col(c):
                return r([c['r'], c['g'], c['b']])
            env = {a: col(t[a]) for a in ('skyColor', 'equatorColorPlusX', 'groundColor', 'fogColor',
                                         'silhouetteColor', 'shadowColor') if a in t}
            env.update({'useFog': t.get('useFog'), 'fogStart': t.get('fogStartDistance'),
                        'fogEnd': t.get('fogEndDistance'), 'additionalLightPower': t.get('additionalLightPower')})
            data['environment'] = env

    for k, t in by_script.get('Gimmick', []):
        go = scene.go_of(k)
        data['gimmicks'].append({'name': scene.go[go]['name'], 'path': scene.path(scene.transform_of[go]),
                                 'fields': {a: v for a, v in t.items()
                                            if not isinstance(v, (dict, list)) and not a.startswith('m_')}})
    data['gimmickClips'] = sorted(o.read().m_Name for o in scene.objects.values() if o.type.name == 'AnimationClip')

    # Collision: every MeshCollider + non-trigger BoxCollider (camera areas are triggers).
    area_gos = {scene.go_of(k) for k, _ in by_script.get('CameraArea', [])}
    for k, o in scene.objects.items():
        if o.type.name not in ('MeshCollider', 'BoxCollider'):
            continue
        t = scene.tree(k)
        go = scene.go_of(k)
        if go in area_gos or t.get('m_IsTrigger') or go not in scene.transform_of or not t.get('m_Enabled', 1):
            continue
        name = scene.go[go]['name']
        if 'shadow' in name.lower():  # off-stage shadow-caster helpers
            continue
        p, rm, s = scene.world_of_go(go)
        if o.type.name == 'MeshCollider':
            mk = scene.ref(k, t.get('m_Mesh'))
            if mk not in scene.objects:
                continue
            try:
                verts, tris = mesh_triangles(scene, mk)
            except Exception as e:  # pragma: no cover - diagnostic
                print(f'  ! {key}: mesh collider {name}: {e}')
                continue
        else:
            c = np.array([t['m_Center'][a] for a in 'xyz'])
            hs = np.array([t['m_Size'][a] for a in 'xyz']) / 2
            verts = np.array([[sx, sy, sz] for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]) * hs + c
            tris = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1],
                             [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])
        world = (rm @ (verts * s).T).T + p
        world[:, 0] *= -1
        lname = name.lower()
        kind = 'floor' if 'floor' in lname or 'ground' in lname else 'wall' if 'wall' in lname else 'other'
        data['collision'].append({'name': name, 'kind': kind, 'collider': o.type.name,
                                  'layer': scene.tree(go).get('m_Layer'),
                                  'path': scene.path(scene.transform_of[go]),
                                  'positions': r(world.reshape(-1).tolist(), 3),
                                  'indices': tris.reshape(-1).tolist()})
    return data


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    keys = sys.argv[1:] or sorted(p.stem for p in SCENES.glob('*.s')
                                  if p.stem.startswith(('dungeon_map_', 'environment_', 'out_game_environment_')))
    ok = 0
    for key in keys:
        try:
            data = extract(key)
        except Exception as e:
            print(f'! {key}: {type(e).__name__}: {e}')
            continue
        (OUT / f'{key}.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
        ok += 1
        print(f'{key}: cams={len(data["cameras"])} areas={len(data["cameraAreas"])} starts={len(data["startPoints"])} '
              f'col={len(data["collision"])}')
    index = sorted(p.stem for p in OUT.glob('*.json') if p.stem != 'index')
    (OUT / 'index.json').write_text(json.dumps(index), encoding='utf-8')
    print(f'done {ok}/{len(keys)}')


if __name__ == '__main__':
    main()
