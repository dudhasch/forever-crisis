# Vendored from explorer/tools/convert_anims.py by release-tools/sync_vendor.py - do not edit here.
"""FF7 Ever Crisis Unity AnimationClips -> three.js AnimationClip JSON.

Run (from anywhere; uses the converters venv because it has UnityPy):

    python ^
        <explorer>\\tools\\convert_anims.py [--scope locomotion|all]
        [--only questcharacter/001,character/001] [--force] [--verify]

    --scope locomotion  (default) clips the game's Animator controllers actually use:
                        field (dungeon) controllers -> shared body-type motion sets
                        (questcharacter/common/<body>/motion) + per-character dungeon.d clips,
                        battle controllers -> character/<id>/motion.d clips they reference.
    --scope all         additionally every other clip of every character/<id>/motion.d
                        (battle skills, victory, menu poses ...) and every clip in
                        questcharacter/common/<body>/motion (story gestures ...). Big.
    --only              restrict to some families (comma separated, prefix match).
    --force             reconvert clips even if the output JSON already exists.
    --verify            after converting, run pose sanity checks (NaN, quaternion norms,
                        track/node binding, hip/feet heights via forward kinematics) for
                        Cloud's field + battle models and print a report.

Writes ONLY under explorer/generated/anims/:
    shared/qu_<body>/<clip>.json         field locomotion etc. shared by all field models of a body type
    questcharacter_<id>/<clip>.json      character-specific field clips (dungeon.d: auto idles ...)
    character_<id>/<clip>.json           battle clips (character/<id>/motion.d)
    monster_<id>/<clip>.json             enemy battle clips (monster/<id>/motion.d), always all of them
    index.json                           families, models, clip roles, locomotion picks

How the data is resolved
------------------------
* Field: data/questcharacter/3d/dat_asset_quXXX_NNN_default.a descriptors point to the prefab
  (-> model/NNN.d -> the converted GLB) and to a dat_dungeon_* MonoBehaviour in
  questcharacter/XXX/dungeon.d whose `controller` is an AnimatorOverrideController.  Its m_Clips
  pairs map placeholder "slot" clips of animations.d (idle_loop_slot, walk_loop_slot,
  run_loop_slot, ...) to the real clip, normally in questcharacter/common/<body>/motion/*.a.
  The slot name gives the locomotion role, so idle/walk/run are not guessed from names.
* Battle: data/character/3d/XXX/dat_asset_character_XXXNNN.a -> prefab + dat_chXXX_NNN in
  character/XXX/battle.d (`Controller` override, RunVelocity) -> clips in character/XXX/motion.d.
* External pointers (m_FileID) are resolved with the CAB -> bundle map
  converters/catalog/cab-index.json (read-only).
* GenericBinding.path is zlib.crc32 of the transform path relative to the Animator GameObject,
  e.g. "bone_gp/root/center/spine1" (the Animator root itself is hash 0 and is not part of the
  path).  Every clip bundle ships an Avatar whose m_TOS table maps hash -> path; that is used
  first, with crc32 of the GLB nodes' extras.unityPath (minus the first segment) as fallback.
  Track names are the leaf transform names == GLB node names.
* Unity -> glTF basis (identical to converters/pipeline/unity_gltf.py, X reflected):
  position (x,y,z) -> (-x,y,z); quaternion (x,y,z,w) -> (x,-y,-z,w); scale unchanged;
  Euler bindings use Unity's Z-X-Y order before the same conversion.
* Muscle clips: streamed (cubic hermite segment coefficients per key), dense (frame table) and
  constant curves are concatenated in that order and consumed by genericBindings in order.
* Root motion: the Avatar root-motion bone (bone_gp/root) carries the locomotion translation
  (walk ~1.42 m/s forward +Z).  By default its X/Z translation is pinned to the bind pose so
  clips play in place at the model origin (looping clips whose root stays still but whose hip
  children drift, e.g. ch009 battle run, get that linear drift removed instead); the removed displacement / speed is written to index.json
  (rootMotion) so the app can drive movement speed.  Root rotation (turn clips) is kept.
* Output is sampled at the clip's sample rate (<=60 fps), then keys that linear interpolation
  reproduces within a small tolerance are dropped; floats are rounded to 5 decimals.
"""
import os as _os
from pathlib import Path as _P
import argparse, collections, json, math, re, struct, sys, time, traceback, zlib
from pathlib import Path

import numpy as np
import UnityPy

ASSETS = _P(_os.environ['FFCX_ARCHIVE'])          # <archive>
BUNDLES = ASSETS / '02-DecodedBundles'
OUT = _P(_os.environ['FFCX_GEN']) / 'anims'
LIB = _P(_os.environ['FFCX_LIB'])
CAB_INDEX_PATH = _P(_os.environ['FFCX_CAB_INDEX'])
VERSION = 4

LOCO_NAME_PATTERNS = {'idle': r'(^|_)(idle|wait|breath)(_|$)', 'walk': r'(^|_)walk(_|$)', 'run': r'(^|_)run(_|$)'}
ROLE_BY_SLOT = {'idle_loop_slot': 'idle', 'walk_loop_slot': 'walk', 'run_loop_slot': 'run'}
POS_TOL, ROT_TOL, SCL_TOL = 5e-4, 5e-4, 5e-4   # metres / quaternion components (~0.06 deg)
DIGITS = 4
BIND_TOL = 1e-3   # constant tracks this close to every model's bind pose are dropped

# ----------------------------------------------------------------------------------------------
# bundle access

_CAB = None
def cab_index():
    global _CAB
    if _CAB is None:
        _CAB = json.loads(CAB_INDEX_PATH.read_text(encoding='utf8'))
    return _CAB

class Bundle:
    def __init__(self, rel):
        self.rel = rel
        self.env = UnityPy.load(str(BUNDLES / rel))
        self.objects = {o.path_id: o for o in self.env.objects}
        f = next(iter(self.env.objects)).assets_file
        self.externals = [e.path.rsplit('/', 1)[-1].lower() for e in f.externals]
        self._trees = {}
    def tree(self, pid):
        if pid not in self._trees:
            self._trees[pid] = self.objects[pid].read_typetree()
        return self._trees[pid]
    def of_type(self, name):
        return [o for o in self.objects.values() if o.type.name == name]
    def ext_bundle(self, file_id):
        """Bundle path (relative to 02-DecodedBundles) for a PPtr m_FileID."""
        if file_id == 0:
            return self.rel
        return cab_index().get(self.externals[file_id - 1])

_BUNDLES = collections.OrderedDict()
def bundle(rel, keep=24):
    if rel in _BUNDLES:
        _BUNDLES.move_to_end(rel); return _BUNDLES[rel]
    b = Bundle(rel); _BUNDLES[rel] = b
    while len(_BUNDLES) > keep:
        _BUNDLES.popitem(last=False)
    return b

def deref(b, ptr):
    """(bundle_rel, path_id) of a PPtr seen from bundle b, or None."""
    if not ptr or not ptr.get('m_PathID'):
        return None
    rel = b.ext_bundle(ptr['m_FileID'])
    return (rel, ptr['m_PathID']) if rel else None

_SLOTS = None
def slot_names():
    global _SLOTS
    if _SLOTS is None:
        b = bundle('animations.d')
        _SLOTS = {o.path_id: o.peek_name() for o in b.of_type('AnimationClip')}
    return _SLOTS

def bundle_tos(b):
    """hash -> transform path from every Avatar in the bundle."""
    if not hasattr(b, '_tos'):
        tos = {}
        for o in b.of_type('Avatar'):
            for h, p in o.read_typetree()['m_TOS']:
                tos[h] = p
        b._tos = tos
        rm = set()
        for o in b.of_type('Avatar'):
            a = o.read_typetree()
            av = a['m_Avatar']; idx = av.get('m_RootMotionBoneIndex', -1)
            if idx is not None and idx >= 0:
                ids = av['m_AvatarSkeleton']['data']['m_ID']
                if idx < len(ids) and ids[idx] in tos:
                    rm.add(tos[ids[idx]].rsplit('/', 1)[-1])
        b._rootmotion = rm
    return b._tos

# ----------------------------------------------------------------------------------------------
# GLB skeletons

_GLB = {}
def glb_nodes(rel):
    """GLB json nodes for a library-relative model path."""
    if rel not in _GLB:
        data = (LIB / rel).read_bytes()
        n = struct.unpack_from('<I', data, 12)[0]
        _GLB[rel] = json.loads(data[20:20 + n])
    return _GLB[rel]

def glb_bone_names(rel):
    return {n['name'] for n in glb_nodes(rel)['nodes'] if n.get('extras', {}).get('unityPath')}

def glb_bind(rel):
    """node name -> {'position','quaternion','scale'} bind values (glTF basis)."""
    out = {}
    for n in glb_nodes(rel)['nodes']:
        if n.get('extras', {}).get('unityPath'):
            out[n['name']] = {'position': np.array(n.get('translation', [0, 0, 0]), float),
                              'quaternion': np.array(n.get('rotation', [0, 0, 0, 1]), float),
                              'scale': np.array(n.get('scale', [1, 1, 1]), float)}
    return out

def glb_hashes(rel):
    out = {}
    for n in glb_nodes(rel)['nodes']:
        p = n.get('extras', {}).get('unityPath')
        if p and '/' in p:
            out[zlib.crc32(p.split('/', 1)[1].encode())] = p.split('/', 1)[1]
    return out

# ----------------------------------------------------------------------------------------------
# clip decoding

def _streamed(stream, sc, times):
    out = np.zeros((len(times), sc))
    words = stream['data']
    if not sc or not words:
        return out
    data = struct.pack('<%dI' % len(words), *words)
    at = 0; keys = collections.defaultdict(list)
    while at < len(data):
        t, n = struct.unpack_from('<fi', data, at); at += 8
        if n < 0 or at + n * 20 > len(data):
            raise ValueError('malformed streamed clip')
        for _ in range(n):
            i, a, b, c, d = struct.unpack_from('<i4f', data, at); at += 20
            if not 0 <= i < sc:
                raise ValueError('streamed curve index out of range')
            keys[i].append((t, a, b, c, d))
    for i, k in keys.items():
        k = np.array(k)
        ix = np.clip(np.searchsorted(k[:, 0], times, side='right') - 1, 0, len(k) - 1)
        co = k[ix]; dt = times - co[:, 0]
        dt[(co[:, 0] < -1e10) | (co[:, 0] > 1e10) | (dt < 0)] = 0
        out[:, i] = ((co[:, 1] * dt + co[:, 2]) * dt + co[:, 3]) * dt + co[:, 4]
    return out

def sample_muscle_clip(clip, times):
    stream = clip['m_StreamedClip']; dense = clip['m_DenseClip']
    const = clip.get('m_ConstantClip', {}).get('data', [])
    sc = stream['curveCount']; dc = dense['m_CurveCount']
    parts = [_streamed(stream, sc, times)]
    if dc:
        arr = np.asarray(dense['m_SampleArray'], dtype=float).reshape(-1, dc)
        ft = dense['m_BeginTime'] + np.arange(len(arr)) / dense['m_SampleRate']
        parts.append(np.stack([np.interp(times, ft, arr[:, i]) for i in range(dc)], 1))
    if const:
        parts.append(np.tile(np.asarray(const, dtype=float), (len(times), 1)))
    return np.concatenate(parts, 1)

def euler_to_quat(e):
    """Unity euler degrees (N,3) -> Unity quaternion xyzw, order Z then X then Y."""
    x, y, z = np.radians(e).T / 2
    cx, sx, cy, sy, cz, sz = np.cos(x), np.sin(x), np.cos(y), np.sin(y), np.cos(z), np.sin(z)
    # q = qy * qx * qz
    w = cy * cx * cz + sy * sx * sz
    qx = cy * sx * cz + sy * cx * sz
    qy = sy * cx * cz - cy * sx * sz
    qz = cy * cx * sz - sy * sx * cz
    return np.stack([qx, qy, qz, w], 1)

def decode_clip(tree, resolve_path):
    """-> dict with name, duration, fps, loop, channels {(leaf, kind): (N,k) array in glTF basis}."""
    mc = tree.get('m_MuscleClip') or {}
    clip = mc.get('m_Clip', {}); clip = clip.get('data', clip)
    if tree.get('m_Legacy') or not clip or 'm_StreamedClip' not in clip:
        raise ValueError('legacy clip (not a muscle clip)')
    start, stop = float(mc['m_StartTime']), float(mc['m_StopTime'])
    dur = stop - start
    fps = float(tree.get('m_SampleRate') or 30); fps = min(60.0, max(1.0, fps))
    if dur <= 1e-6:
        times = np.array([start]); dur = 0.0
    else:
        times = np.linspace(start, stop, max(2, int(round(dur * fps)) + 1))
    values = sample_muscle_clip(clip, times)
    chans = {}; paths = {}; unresolved = []; skipped = collections.Counter(); off = 0
    for b in tree['m_ClipBindingConstant']['genericBindings']:
        if b.get('isPPtrCurve'):
            continue
        typ, attr = b['typeID'], b['attribute']
        width = {1: 3, 2: 4, 3: 3, 4: 3}.get(attr, 1) if typ == 4 else 1
        data = values[:, off:off + width].copy(); off += width
        if typ != 4 or attr not in (1, 2, 3, 4):
            skipped[f'type{typ}'] += 1; continue
        if b['path'] == 0:
            skipped['animator_root'] += 1; continue
        path = resolve_path(b['path'])
        if path is None:
            unresolved.append(b['path']); continue
        leaf = path.rsplit('/', 1)[-1]
        if attr == 1:
            data[:, 0] *= -1; kind = 'position'
        elif attr == 3:
            kind = 'scale'
        else:
            if attr == 4:
                data = euler_to_quat(data)
            data[:, 1:3] *= -1
            n = np.linalg.norm(data, axis=1, keepdims=True)
            if (n < 1e-8).any():
                raise ValueError('zero quaternion')
            data /= n
            for i in range(1, len(data)):
                if np.dot(data[i - 1], data[i]) < 0:
                    data[i] *= -1
            kind = 'quaternion'
        if (leaf, kind) in chans:
            skipped['duplicate'] += 1; continue
        chans[(leaf, kind)] = data
        paths[leaf] = path
    if off != values.shape[1]:
        raise ValueError(f'binding width {off} != curve count {values.shape[1]}')
    if not np.isfinite(values).all():
        raise ValueError('non-finite curve values')
    events = [{'time': round(e['time'] - start, 4), 'name': e['functionName'],
               **({'data': e['data']} if e.get('data') else {})} for e in tree.get('m_Events', [])]
    return {'name': tree['m_Name'], 'duration': dur, 'fps': fps, 'times': times - start,
            'loop': bool(mc.get('m_LoopTime')), 'channels': chans, 'unresolved': unresolved,
            'skipped': dict(skipped), 'events': events, 'paths': paths}

def reduce_keys(times, vals, tol):
    """Greedy removal of keys reproduced by linear interpolation within tol."""
    n = len(times)
    if n <= 2:
        if n == 2 and np.abs(vals[1] - vals[0]).max() <= tol:
            return [0]
        return list(range(n))
    if np.abs(vals - vals[0]).max() <= tol:
        return [0]
    keep = [0]; a = 0
    while a < n - 1:
        b = a + 1
        while b + 1 < n:
            c = b + 1
            w = ((times[a + 1:c] - times[a]) / (times[c] - times[a]))[:, None]
            interp = vals[a] * (1 - w) + vals[c] * w
            if np.abs(interp - vals[a + 1:c]).max() > tol:
                break
            b = c
        keep.append(b); a = b
    return keep

def equals_bind(leaf, kind, value, binds):
    """True when a constant value equals the bind pose of every model that has the bone."""
    have = [b[leaf][kind] for b in binds if leaf in b]
    if not have:
        return False
    for v in have:
        d = np.abs(value - v).max()
        if kind == 'quaternion':
            d = min(d, np.abs(value + v).max())
        if d > BIND_TOL:
            return False
    return True

def strip_child_drift(dec, chans, rootmotion_bones, binds):
    """Looping clips only.  Some (e.g. ch009 battle run) leave the root-motion bone still and translate its
    children (center, main_weapon ...) forward instead.  Remove that linear X/Z drift (and the
    average X/Z offset of the hip from its bind position) from all root children alike."""
    paths = dec['paths']; times = dec['times']; dur = dec['duration']
    rm_path = next((p for l, p in paths.items() if l in rootmotion_bones), None)
    if rm_path is None:
        rm_path = next((p.rsplit('/', 1)[0] for p in paths.values() if p.endswith('/root/center')), None)
    if rm_path is None:
        return None
    rm_leaf = rm_path.rsplit('/', 1)[-1]
    rp = chans.get((rm_leaf, 'position'))
    if rp is not None and math.hypot(*(rp[-1] - rp[0])[[0, 2]]) > 0.05:
        return None                                       # proper root motion, handled normally
    kids = [l for (l, k) in chans if k == 'position' and paths.get(l, '').rsplit('/', 1)[0] == rm_path]
    if not kids:
        return None
    def dxz(l):
        d = chans[(l, 'position')][-1] - chans[(l, 'position')][0]
        return math.hypot(d[0], d[2])
    best = max(kids, key=dxz)
    if dxz(best) < 0.3:
        return None
    d = chans[(best, 'position')][-1] - chans[(best, 'position')][0]; d[1] = 0
    ramp = (times / dur)[:, None] * d[None, :]
    bind = next((b[best]['position'] for b in binds if best in b), None)
    det = chans[(best, 'position')] - ramp
    off = det.mean(0) - (bind if bind is not None else 0); off[1] = 0
    for l in kids:
        chans[(l, 'position')] = chans[(l, 'position')] - ramp - off[None, :]
    return {'bone': best, 'delta': [round(float(v), 4) for v in d],
            'speed': round(float(math.hypot(d[0], d[2]) / dur), 4), 'yawDelta': None, 'stripped': True,
            'note': f'root bone static; linear X/Z drift removed from children of {rm_leaf}: ' + ','.join(sorted(kids))}

def to_three(dec, bones, rootmotion_bones, keep_root_motion=False, binds=()):
    """Build three.js AnimationClip JSON + metadata. bones = set of node names allowed."""
    times = dec['times']; tracks = []; dropped = []; root_motion = None; at_bind = 0
    chans = {k: v.copy() for k, v in dec['channels'].items()}
    drift = None
    if not keep_root_motion and dec['loop'] and dec['duration'] > 0 and len(times) > 1:
        drift = strip_child_drift(dec, chans, rootmotion_bones, binds)
    for (leaf, kind), data in sorted(chans.items()):
        if bones is not None and leaf not in bones:
            dropped.append(leaf); continue
        data = data.copy()
        if kind == 'position' and leaf in rootmotion_bones and len(data) > 1:
            d = data[-1] - data[0]
            yaw = None
            q = dec['channels'].get((leaf, 'quaternion'))
            if q is not None:
                # yaw change of the root (glTF basis, around +Y)
                def yaw_of(qq):
                    x, y, z, w = qq
                    return math.degrees(math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + x * x)))
                yaw = round(yaw_of(q[-1]) - yaw_of(q[0]), 2)
            if drift:
                root_motion = drift
            else:
                root_motion = {'bone': leaf, 'delta': [round(float(v), 4) for v in d],
                               'speed': round(float(math.hypot(d[0], d[2]) / dec['duration']), 4) if dec['duration'] else 0,
                               'yawDelta': yaw, 'stripped': not keep_root_motion}
            if not keep_root_motion:
                # in place: X/Z pinned to the bone's bind position (Unity moves the GameObject instead)
                bx = next((bb[leaf]['position'] for bb in binds if leaf in bb), np.zeros(3))
                data[:, 0] = bx[0]; data[:, 2] = bx[2]
        tol = {'position': POS_TOL, 'quaternion': ROT_TOL, 'scale': SCL_TOL}[kind]
        idx = reduce_keys(times, data, tol)
        if len(idx) == 1 and equals_bind(leaf, kind, data[0], binds):
            at_bind += 1; continue
        tracks.append({'name': f'{leaf}.{kind}', 'type': 'quaternion' if kind == 'quaternion' else 'vector',
                       'times': [round(float(t), DIGITS) for t in times[idx]],
                       'values': [round(float(v), DIGITS) for v in data[idx].ravel()]})
    if drift and root_motion is None:
        root_motion = drift
    clip = {'name': dec['name'], 'duration': round(dec['duration'], DIGITS), 'blendMode': 2500,
            'tracks': tracks}
    clip['_atBind'] = at_bind
    return clip, sorted(set(dropped)), root_motion

# ----------------------------------------------------------------------------------------------
# family discovery

def model_from_prefab(prefab_rel):
    """Library GLB path(s) of the model bundle a prefab references."""
    if not prefab_rel:
        return None
    b = bundle(prefab_rel)
    cab = cab_index()
    for e in b.externals:
        rel = cab.get(e)
        if rel and re.match(r'(questcharacter|character|monster)/\w+/model/\w+\.d$', rel):
            glb = 'unity/' + rel[:-2] + '/model.glb'
            if (LIB / glb).exists():
                return glb
    # fallback: naming convention pfb_qu001_005.a -> model/005
    m = re.match(r'(questcharacter|character|monster)/(\w+)/pfb_\w+?_(\d+)\.a$', prefab_rel)
    if m:
        glb = f'unity/{m[1]}/{m[2]}/model/{m[3]}/model.glb'
        if (LIB / glb).exists():
            return glb
    return None

def override_clips(b, ctl_pid):
    """[(slot, (bundle_rel, path_id))] of an AnimatorOverrideController."""
    t = b.tree(ctl_pid); slots = slot_names(); out = []
    for c in t['m_Clips']:
        ref = deref(b, c['m_OverrideClip'])
        if ref:
            out.append((slots.get(c['m_OriginalClip']['m_PathID'], str(c['m_OriginalClip']['m_PathID'])), ref))
    return t['m_Name'], out

def discover_field():
    fams = {}  # (qid, controller) -> {...}
    for desc in sorted((BUNDLES / 'data/questcharacter/3d').glob('dat_asset_qu*_default.a')):
        rel = desc.relative_to(BUNDLES).as_posix()
        try:
            b = bundle(rel)
            mb = next(o for o in b.of_type('MonoBehaviour'))
            t = mb.read_typetree()
            prefab = deref(b, t.get('prefab')); data = deref(b, t.get('data'))
            model = model_from_prefab(prefab[0] if prefab else None)
            if not data:
                continue
            db = bundle(data[0]); dt = db.tree(data[1])
            ctl = deref(db, dt.get('controller'))
            if not ctl:
                continue
            cb = bundle(ctl[0]); name, clips = override_clips(cb, ctl[1])
            qid = re.search(r'qu(\d+)_', t['m_Name'])[1]
            key = (qid, name)
            f = fams.setdefault(key, {'kind': 'questcharacter', 'id': qid, 'controller': name,
                                      'controllerBundle': ctl[0], 'slots': clips, 'models': set(),
                                      'descriptors': [], 'localBundle': data[0],
                                      'dataName': dt.get('m_Name'),
                                      'uniqueActions': list(dt.get('uniqueActionDataNames') or []) +
                                                       list(dt.get('uniquePoseDataNames') or [])})
            if model:
                f['models'].add(model)
            f['descriptors'].append(t['m_Name'])
        except Exception as e:
            print('field descriptor failed', rel, type(e).__name__, e)
    return fams

def discover_battle():
    fams = {}
    # Human enemy bosses (dat_asset_enemy1CCCYYY: Reno, Rude, Elena ...) have no playable descriptor; their
    # own descriptor points to the same character/CCC/battle.d data with an *_enemy controller.
    enemy_descs = sorted((BUNDLES / 'data/enemy/3d').glob('dat_asset_enemy1*.a'))
    for desc in sorted((BUNDLES / 'data/character/3d').glob('*/dat_asset_character_*.a')) + enemy_descs:
        is_enemy = desc.parent.name == '3d' and desc.name.startswith('dat_asset_enemy')
        rel = desc.relative_to(BUNDLES).as_posix()
        try:
            b = bundle(rel)
            mb = next(o for o in b.of_type('MonoBehaviour'))
            t = mb.read_typetree()
            prefab = deref(b, t.get('prefab')); data = deref(b, t.get('data'))
            model = model_from_prefab(prefab[0] if prefab else None)
            cid = desc.parent.name
            if is_enemy:
                pm = re.match(r'character/(\w+)/', prefab[0] if prefab else '')
                if not pm:
                    continue
                cid = pm[1]
            ctl = None; name = None; clips = []; dt = {}
            if data:
                db = bundle(data[0]); dt = db.tree(data[1])
                ctl = deref(db, dt.get('Controller'))
                if ctl:
                    cb = bundle(ctl[0]); name, clips = override_clips(cb, ctl[1])
            wait = deref(b, t.get('waitHasWeaponAnimationClip')) or deref(b, t.get('waitAnimationClip'))
            key = (cid, name)
            f = fams.setdefault(key, {'kind': 'character', 'id': cid, 'controller': name,
                                      'controllerBundle': ctl[0] if ctl else None, 'slots': list(clips),
                                      'models': set(), 'descriptors': [],
                                      'runVelocity': dt.get('RunVelocity'), 'wait': {}})
            if model:
                f['models'].add(model)
                if wait:
                    f['wait'][model] = wait
            f['descriptors'].append(t['m_Name'])
        except Exception as e:
            print('battle descriptor failed', rel, type(e).__name__, e)
    return fams

def discover_monster():
    """Enemies: data/enemy/3d/dat_asset_enemy2XXXYYY.a -> prefab (monster/XXX/model/YYY) + dat_moXXX_NNN in
    monster/XXX/battle.d (`Controller` override) -> clips in monster/XXX/motion.d.  Human bosses
    (dat_asset_enemy1CCCYYY) reuse the character/CCC families and are skipped here."""
    fams = {}
    for desc in sorted((BUNDLES / 'data/enemy/3d').glob('dat_asset_enemy2*.a')):
        rel = desc.relative_to(BUNDLES).as_posix()
        try:
            b = bundle(rel)
            t = next(o for o in b.of_type('MonoBehaviour')).read_typetree()
            prefab = deref(b, t.get('prefab')); data = deref(b, t.get('data'))
            model = model_from_prefab(prefab[0] if prefab else None)
            m = re.match(r'monster/(\w+)/', prefab[0] if prefab else '')
            if not m:
                continue
            mid = m[1]; name = None; clips = []; ctl = None
            if data:
                db = bundle(data[0]); dt = db.tree(data[1])
                ctl = deref(db, dt.get('Controller'))
                if ctl:
                    cb = bundle(ctl[0]); name, clips = override_clips(cb, ctl[1])
            key = (mid, name)
            f = fams.setdefault(key, {'kind': 'monster', 'id': mid, 'controller': name,
                                      'controllerBundle': ctl[0] if ctl else None, 'slots': list(clips),
                                      'models': set(), 'descriptors': []})
            if model:
                f['models'].add(model)
            f['descriptors'].append(t['m_Name'])
        except Exception as e:
            print('enemy descriptor failed', rel, type(e).__name__, e)
    # one family per monster id: battle clips are shared by every variant's controller
    merged = {}
    for (mid, name), f in sorted(fams.items(), key=lambda kv: (kv[0][0], kv[0][1] or '')):
        g = merged.setdefault(mid, f)
        if g is not f:
            g['models'] |= f['models']; g['descriptors'] += f['descriptors']
            have = {r for _, r in g['slots']}
            g['slots'] += [(s, r) for s, r in f['slots'] if r not in have]
    return {(mid, f['controller']): f for mid, f in merged.items()}

# ----------------------------------------------------------------------------------------------

def family_key(f, all_fams):
    same = [g for g in all_fams if g['kind'] == f['kind'] and g['id'] == f['id']]
    base = f"{f['kind']}/{f['id']}"
    if len(same) == 1:
        return base
    main = max(same, key=lambda g: (len(g['models']), (g['controller'] or '').endswith('_001')))
    if f is main:
        return base
    suffix = (f['controller'] or 'none').rsplit('_', 1)[-1]
    return f'{base}/{suffix}'

def out_dir_for(clip_bundle):
    m = re.match(r'questcharacter/common/(\w+)/motion/', clip_bundle)
    if m:
        return f'shared/qu_{m[1]}'
    m = re.match(r'(questcharacter|character|monster)/(\w+)/', clip_bundle)
    if m:
        return f'{m[1]}_{m[2]}'
    return 'misc/' + re.sub(r'[^A-Za-z0-9_]+', '_', clip_bundle)

def safe(n):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', n)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scope', choices=['locomotion', 'all'], default='locomotion')
    ap.add_argument('--only', default='')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--verify', action='store_true')
    ap.add_argument('--keep-root-motion', action='store_true')
    args = ap.parse_args()
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)

    print('discovering field families ...'); field = discover_field()
    print('discovering battle families ...'); battle = discover_battle()
    print('discovering monster families ...'); monster = discover_monster()
    fams = list(field.values()) + list(battle.values()) + list(monster.values())
    for f in fams:
        f['key'] = family_key(f, fams)
    # models present in the library without a descriptor -> attach to the main family of that id
    for kind in ('questcharacter', 'character', 'monster'):
        for glb in sorted((LIB / 'unity' / kind).glob('*/model/*/model.glb')):
            rel = glb.relative_to(LIB).as_posix(); cid = glb.parts[-4]
            if any(rel in f['models'] for f in fams):
                continue
            main_f = next((f for f in fams if f['kind'] == kind and f['id'] == cid and f['key'] == f'{kind}/{cid}'), None)
            if main_f:
                main_f['models'].add(rel); main_f.setdefault('inferredModels', []).append(rel)
    only = [s for s in args.only.split(',') if s]
    if only:
        fams = [f for f in fams if any(f['key'].startswith(o) for o in only)]

    # ---- clip jobs: (bundle_rel, path_id) -> set of family keys + roles
    jobs = collections.OrderedDict()
    def add_job(ref, fam, role=None, slot=None):
        j = jobs.setdefault(ref, {'families': set(), 'roles': {}, 'slots': set()})
        j['families'].add(fam['key'])
        if role and j['roles'].get(fam['key'], 'other') == 'other':
            j['roles'][fam['key']] = role       # idle/walk/run win over 'other' when a clip fills several slots
        if slot:
            j['slots'].add(slot)
    for f in fams:
        for slot, ref in f['slots']:
            add_job(ref, f, ROLE_BY_SLOT.get(slot, 'other'), slot)
        if f['kind'] == 'questcharacter':
            # character-specific clips (auto idles, chocobo farm ...) via the data's action lists
            lb = bundle(f['localBundle'])
            wanted = {n.replace('dat_asset_', 'dat_') for n in f['uniqueActions']}
            for o in lb.of_type('MonoBehaviour'):
                if o.peek_name() in wanted:
                    t = lb.tree(o.path_id)
                    for k in ('clipIn', 'clipLoop', 'clipOut'):
                        r = deref(lb, t.get(k))
                        if r:
                            add_job(r, f, None, 'unique_action')
        if f['kind'] == 'character':
            for ref in f.get('wait', {}).values():
                add_job(ref, f, None, 'menu_wait')
            if args.scope == 'all':
                mb = f"character/{f['id']}/motion.d"
                if (BUNDLES / mb).exists():
                    for o in bundle(mb, keep=4).of_type('AnimationClip'):
                        add_job((mb, o.path_id), f)
        if f['kind'] == 'monster':
            # every battle clip (skills, damage, death) is needed by the battle runtime
            mb = f"monster/{f['id']}/motion.d"
            if (BUNDLES / mb).exists():
                for o in bundle(mb, keep=4).of_type('AnimationClip'):
                    add_job((mb, o.path_id), f)
    # local dungeon.d clips nobody claimed -> main family of that character
    for f in fams:
        if f['kind'] == 'questcharacter' and f['key'] == f"questcharacter/{f['id']}":
            lb = bundle(f['localBundle'])
            for o in lb.of_type('AnimationClip'):
                if (f['localBundle'], o.path_id) not in jobs:
                    add_job((f['localBundle'], o.path_id), f)
    if args.scope == 'all':
        # whole shared field motion sets, attached to every family that uses that body type
        bodies = collections.defaultdict(set)
        for ref, j in list(jobs.items()):
            m = re.match(r'questcharacter/common/(\w+)/motion/', ref[0])
            if m:
                bodies[m[1]] |= j['families']
        for body, keys in bodies.items():
            for p in sorted((BUNDLES / f'questcharacter/common/{body}/motion').glob('*.a')):
                rel = p.relative_to(BUNDLES).as_posix()
                if any(r[0] == rel for r in jobs):
                    continue
                try:
                    for o in bundle(rel).of_type('AnimationClip'):
                        j = jobs.setdefault((rel, o.path_id), {'families': set(), 'roles': {}, 'slots': set()})
                        j['families'] |= keys
                except Exception as e:
                    print('load failed', rel, e)

    fam_by_key = {f['key']: f for f in fams}
    bones_cache = {}
    def bones_for(keys):
        k = tuple(sorted(keys))
        if k not in bones_cache:
            s = set()
            for key in keys:
                for m in fam_by_key[key]['models']:
                    s |= glb_bone_names(m)
            bones_cache[k] = s
        return bones_cache[k]
    binds_cache = {}
    def binds_for(keys):
        k = tuple(sorted(keys))
        if k not in binds_cache:
            binds_cache[k] = [glb_bind(m) for key in keys for m in sorted(fam_by_key[key]['models'])]
        return binds_cache[k]
    hash_cache = {}
    def glb_hash_for(keys):
        k = tuple(sorted(keys))
        if k not in hash_cache:
            h = {}
            for key in keys:
                for m in fam_by_key[key]['models']:
                    h.update(glb_hashes(m))
            hash_cache[k] = h
        return hash_cache[k]

    # ---- convert
    manifest_path = OUT / 'manifest.json'
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    except (OSError, ValueError):
        manifest = {}
    if manifest.get('version') != VERSION:
        manifest = {'version': VERSION, 'clips': {}}
    results = {}; failures = []
    # group by bundle so heavy bundles load once
    by_bundle = collections.defaultdict(list)
    for ref in jobs:
        by_bundle[ref[0]].append(ref)
    done = 0
    for brel, refs in by_bundle.items():
        try:
            b = bundle(brel, keep=4)
        except Exception as e:
            for ref in refs:
                failures.append({'bundle': brel, 'pathId': str(ref[1]), 'error': f'load: {e}'})
            continue
        tos = bundle_tos(b)
        rm_bones = b._rootmotion or {'root'}
        for ref in refs:
            j = jobs[ref]; mkey = f'{brel}:{ref[1]}'
            if ref[1] not in b.objects:
                failures.append({'bundle': brel, 'pathId': str(ref[1]), 'error': 'missing object'}); continue
            name = b.objects[ref[1]].peek_name()
            if name and name.endswith('_cam'):
                continue                                   # camera animation, no character bones
            bones = bones_for(j['families'])
            cached = manifest['clips'].get(mkey)
            outfile = f'{out_dir_for(brel)}/{safe(name)}.json'
            if cached and not args.force and (OUT / cached['file']).exists() \
                    and cached.get('bonesSig') == len(bones):
                results[ref] = cached; done += 1; continue
            try:
                tree = b.tree(ref[1])
                fallback = glb_hash_for(j['families'])
                dec = decode_clip(tree, lambda h: tos.get(h) or fallback.get(h))
                clip, dropped, rmo = to_three(dec, bones, rm_bones, args.keep_root_motion,
                                              binds_for(j['families']))
                at_bind = clip.pop('_atBind')
                if not clip['tracks']:
                    raise ValueError('no transform track binds to the family skeletons')
                p = OUT / outfile; p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(clip, separators=(',', ':'), allow_nan=False), encoding='utf8')
                info = {'name': name, 'file': outfile, 'duration': clip['duration'], 'loop': dec['loop'],
                        'fps': dec['fps'], 'tracks': len(clip['tracks']), 'bytes': p.stat().st_size,
                        'bonesSig': len(bones), 'source': f'02-DecodedBundles/{brel}', 'pathId': str(ref[1])}
                if at_bind: info['tracksAtBindDropped'] = at_bind
                if rmo: info['rootMotion'] = rmo
                if dec['events']: info['events'] = dec['events']
                if dropped: info['droppedBones'] = dropped
                if dec['unresolved']: info['unresolvedHashes'] = len(dec['unresolved'])
                if '_add' in name: info['additive'] = True
                manifest['clips'][mkey] = info; results[ref] = info
            except Exception as e:
                failures.append({'bundle': brel, 'pathId': str(ref[1]), 'name': name,
                                 'error': f'{type(e).__name__}: {e}'})
            done += 1
            if done % 200 == 0:
                print(f'  {done}/{len(jobs)} clips  {time.time() - t0:.0f}s')
                manifest_path.write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf8')
    manifest_path.write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf8')

    # ---- index
    index = {'version': VERSION,
             'generatedBy': 'ffcx convert_anims.py',
             'coordinateSystem': 'glTF basis of the converted GLBs (Unity X reflected): pos(-x,y,z), quat(x,-y,-z,w)',
             'trackBinding': 'track names are GLB node names: <node>.quaternion | <node>.position | <node>.scale',
             'rootMotion': 'root-motion bone X/Z translation pinned to bind (in place, at model origin); see clip.rootMotion for removed delta/speed',
             'families': {}, 'shared': {}, 'models': {}, 'failures': failures}
    def clip_entry(ref, role=None, slot=None):
        r = results[ref]
        e = {k: r[k] for k in ('name', 'file', 'duration', 'loop') if k in r}
        e['role'] = role or 'other'
        if slot: e['slot'] = slot
        for k in ('rootMotion', 'additive', 'events'):
            if k in r: e[k] = r[k]
        return e
    shared = collections.defaultdict(dict)
    for ref, j in jobs.items():
        if ref in results and results[ref]['file'].startswith('shared/'):
            sk = results[ref]['file'].split('/')[1]
            roles = set(j['roles'].values())
            role = next((r for r in ('idle', 'walk', 'run') if r in roles), None)
            shared[sk][results[ref]['name']] = clip_entry(ref, role, ','.join(sorted(j['slots'])) or None)
    for sk, clips in sorted(shared.items()):
        users = sorted({k for ref, j in jobs.items() if ref in results and results[ref]['file'].startswith(f'shared/{sk}/') for k in j['families'] if j['roles']})
        index['shared'][sk] = {'source': f'02-DecodedBundles/questcharacter/common/{sk[3:]}/motion',
                               'usedBy': users, 'clips': sorted(clips.values(), key=lambda c: c['name']),
                               'locomotion': {r: next((c['name'] for c in clips.values() if c['role'] == r), None)
                                              for r in ('idle', 'walk', 'run')}}
    for f in sorted(fams, key=lambda f: f['key']):
        refs = [ref for ref, j in jobs.items() if f['key'] in j['families'] and ref in results]
        slot_of = collections.defaultdict(list)
        for slot, ref in f['slots']:
            slot_of[ref].append(slot)
        clips = []; loco = {'idle': None, 'walk': None, 'run': None}; loco_files = {}
        for ref in refs:
            j = jobs[ref]; role = j['roles'].get(f['key'])
            if not role and slot_of.get(ref) is None and 'menu_wait' in j['slots'] and ref in f.get('wait', {}).values():
                role = 'other'
            e = clip_entry(ref, role, ','.join(slot_of.get(ref, [])) or ('menu_wait' if ref in f.get('wait', {}).values() else None))
            if e['file'].startswith('shared/') and not slot_of.get(ref) and args.scope == 'all':
                continue        # bulk shared clips are listed under "shared" only
            clips.append(e)
            if role in loco and loco[role] is None:
                loco[role] = e['name']; loco_files[role] = e['file']
        # controller lacks a slot -> best guess from clip names (marked in locomotionSource)
        source = {r: 'controller' for r, v in loco.items() if v}
        for r, pat in LOCO_NAME_PATTERNS.items():
            if loco[r] is None:
                cands = [c for c in clips if re.search(pat, c['name']) and not c.get('additive')
                         and not re.search(r'adjust|turn|_cam$', c['name'])]
                cands.sort(key=lambda c: (not c.get('loop'), not c['name'].endswith('_lp'), c['name']))
                if cands:
                    loco[r] = cands[0]['name']; loco_files[r] = cands[0]['file']; source[r] = 'name-guess'
                    if cands[0]['role'] == 'other':
                        cands[0]['role'] = r + '?'
        fam = {'kind': f['kind'], 'id': f['id'], 'controller': f['controller'],
               'models': sorted(f['models']), 'clips': sorted(clips, key=lambda c: (c['role'] == 'other', c['name'])),
               'locomotion': loco, 'locomotionFiles': loco_files, 'locomotionSource': source}
        if f.get('inferredModels'):
            fam['modelsWithoutDescriptor'] = sorted(f['inferredModels'])
        if f.get('runVelocity'):
            fam['runVelocity'] = f['runVelocity']
        shared_used = sorted({c['file'].split('/')[1] for c in clips if c['file'].startswith('shared/')})
        if shared_used:
            fam['sharedSets'] = shared_used
        if f['kind'] == 'character' and loco['walk'] is None:
            fam['note'] = 'battle controllers have no walk slot; use run (or the menu wait clip) instead'
        index['families'][f['key']] = fam
        for m in sorted(f['models']):
            names = glb_bone_names(m)
            missing = sorted({t.split('.')[0] for role, fn in loco_files.items()
                              for t in track_names(OUT / fn)} - names)
            entry = {'family': f['key'], 'locomotion': loco, 'locomotionFiles': loco_files,
                     'locomotionSource': source}
            if missing:
                entry['locomotionTracksWithoutNode'] = missing
            w = f.get('wait', {}).get(m)
            if w and w in results:
                entry['menuWait'] = results[w]['file']
            index['models'][m] = entry
    if only and (OUT / 'index.json').exists():
        # partial run: keep every family / model / shared set this run did not touch
        old = json.loads((OUT / 'index.json').read_text(encoding='utf8'))
        for k in ('families', 'models', 'shared'):
            index[k] = {**old.get(k, {}), **index[k]}
        index['failures'] = [f for f in old.get('failures', []) if not any(
            f.get('bundle', '').startswith(o.split('/')[0] + '/' + o.split('/')[1]) for o in only if '/' in o)] + failures
    (OUT / 'index.json').write_text(json.dumps(index, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    total = sum(1 for p in OUT.rglob('*.json'))
    size = sum(p.stat().st_size for p in OUT.rglob('*.json'))
    print(f'converted/available {len(results)} clips, failed {len(failures)}, families {len(index["families"])}, '
          f'shared sets {len(index["shared"])}, files {total}, {size / 1e6:.1f} MB, {time.time() - t0:.0f}s')
    for fl in failures[:20]:
        print('  FAIL', fl)
    if args.verify:
        verify(index)

_TN = {}
def track_names(p):
    if p not in _TN:
        _TN[p] = [t['name'] for t in json.loads(Path(p).read_text(encoding='utf8'))['tracks']]
    return _TN[p]

# ----------------------------------------------------------------------------------------------
# verification (forward kinematics on the GLB node tree)

def _qmul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return np.array([aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz])

def _qrot(q, v):
    u = np.array(q[:3]); w = q[3]
    return v + 2 * np.cross(u, np.cross(u, v) + w * v)

def sample_track(t, time_):
    times = np.array(t['times']); k = 4 if t['type'] == 'quaternion' else 3
    vals = np.array(t['values']).reshape(-1, k)
    if len(times) == 1 or time_ <= times[0]:
        return vals[0]
    if time_ >= times[-1]:
        return vals[-1]
    i = np.searchsorted(times, time_) - 1; w = (time_ - times[i]) / (times[i + 1] - times[i])
    a, b = vals[i], vals[i + 1]
    if k == 4 and np.dot(a, b) < 0:
        b = -b
    v = a * (1 - w) + b * w
    return v / np.linalg.norm(v) if k == 4 else v

def world_positions(glb, clip, time_):
    nodes = glb['nodes']; parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    tr = {}
    if clip:
        for t in clip['tracks']:
            node, prop = t['name'].rsplit('.', 1); tr[(node, prop)] = sample_track(t, time_)
    cache = {}
    def world(i):
        if i in cache:
            return cache[i]
        n = nodes[i]
        p = np.array(tr.get((n['name'], 'position'), n.get('translation', [0, 0, 0])), float)
        q = np.array(tr.get((n['name'], 'quaternion'), n.get('rotation', [0, 0, 0, 1])), float)
        s = np.array(tr.get((n['name'], 'scale'), n.get('scale', [1, 1, 1])), float)
        if i in parent:
            pp, pq, ps = world(parent[i])
            res = (pp + _qrot(pq, ps * p), _qmul(pq, q), ps * s)
        else:
            res = (p, q, s)
        cache[i] = res; return res
    return {n['name']: world(i)[0] for i, n in enumerate(nodes)}

def verify(index):
    print('\n=== verification ===')
    ok = True
    for model in ['unity/questcharacter/001/model/001/model.glb', 'unity/character/001/model/001/model.glb']:
        m = index['models'].get(model)
        if not m:
            print('MISSING model entry', model); ok = False; continue
        glb = glb_nodes(model); names = [n['name'] for n in glb['nodes']]
        dup = [n for n, c in collections.Counter(names).items() if c > 1]
        print(f'\n{model}  family={m["family"]}  duplicate node names: {dup or "none"}')
        bind = world_positions(glb, None, 0)
        hipname = 'center' if 'center' in bind else 'hip'
        print(f'  bind: {hipname} y={bind[hipname][1]:.3f}  left_foot y={bind["left_foot"][1]:.3f}  head y={bind.get("head", [0, 0, 0])[1]:.3f}')
        for role, fn in m['locomotionFiles'].items():
            clip = json.loads((OUT / fn).read_text(encoding='utf8'))
            missing = [t['name'] for t in clip['tracks'] if t['name'].rsplit('.', 1)[0] not in names]
            nan = any(not math.isfinite(v) for t in clip['tracks'] for v in t['values'])
            qerr = max((abs(np.linalg.norm(q) - 1) for t in clip['tracks'] if t['type'] == 'quaternion'
                        for q in np.array(t['values']).reshape(-1, 4)), default=0)
            hy = []; fy = []; fz = []; heady = []; hxz = []
            for tt in np.linspace(0, clip['duration'], 25):
                w = world_positions(glb, clip, tt)
                hy.append(w[hipname][1]); hxz.append(math.hypot(w[hipname][0], w[hipname][2])); fy.append(min(w['left_foot'][1], w['right_foot'][1]))
                fz.append(w['left_foot'][2] - w['right_foot'][2]); heady.append(w['head'][1])
            print(f'  {role:4s} {clip["name"]}: tracks={len(clip["tracks"])} missingNodes={len(missing)} nan={nan} '
                  f'max|q|-1={qerr:.1e} {hipname}.y=[{min(hy):.3f},{max(hy):.3f}] head.y=[{min(heady):.3f},{max(heady):.3f}] '
                  f'lowestFoot.y=[{min(fy):.3f},{max(fy):.3f}] footZ(L-R)=[{min(fz):.3f},{max(fz):.3f}] max|{hipname}.xz|={max(hxz):.3f}')
            if missing or nan or qerr > 1e-3 or max(hxz) > 0.5 or abs(np.mean(hy) - bind[hipname][1]) > 0.35 * max(bind[hipname][1], 0.1):
                ok = False; print('    !! check failed', missing[:5])
    print('\nverification', 'PASSED' if ok else 'FAILED')

if __name__ == '__main__':
    main()
