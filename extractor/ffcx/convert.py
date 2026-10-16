"""Per-item conversions. Each function takes one recipe item and writes its outputs under the asset root.

All functions run inside worker processes set up by `init_worker`, which points the vendored converters at
the staging tree (FFCX_ARCHIVE), the output library (FFCX_LIB) and generated folder (FFCX_GEN), and installs
either the on-demand bundle decoder (game mode) or the access tracer (archive/recording mode).
"""
from __future__ import annotations

import builtins
import glob as globmod
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

CTX: dict = {}
# CRI key for FF7EC audio and movies. It is public: vgmstream lists it in src/meta/hca_keys.h (ISC-style license,
# LICENSES/vgmstream.txt). The only key in this repository; the catalog and MasterData keys come from the player's
# own IL2CPP metadata (catalog.py, textpool.py).
USM_KEY = 0x11DA4DE45ADE
NO_WINDOW = 0x08000000 if os.name == 'nt' else 0


def vendor_dir() -> Path:
    base = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
    return base / 'vendor'


def tool(name: str) -> str:
    """Bundled decoder binary (tools/<name>.exe next to the exe or in the source tree), else PATH."""
    roots = [Path(sys.executable).parent / 'tools', Path(getattr(sys, '_MEIPASS', '')) / 'tools',
             Path(__file__).resolve().parents[1] / 'tools']
    for r in roots:
        for cand in (r / f'{name}.exe', r / name / f'{name}.exe', r / 'vgmstream' / f'{name}.exe'):
            if cand.is_file():
                return str(cand)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f'{name} not found')
    return found


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, creationflags=NO_WINDOW, **kw)


# --- worker setup -------------------------------------------------------------------------------------------

def init_worker(ctx: dict, main: bool = False):
    CTX.update(ctx)
    if not main:
        # converters print progress; keep stdout clean for the JSON-lines protocol
        log = open(Path(ctx['out']) / '.ffcx' / f'worker-{os.getpid()}.log', 'a', encoding='utf-8', buffering=1)
        sys.stdout = log
        sys.stderr = log
    os.environ['FFCX_ARCHIVE'] = ctx['staging']
    os.environ['FFCX_LIB'] = str(Path(ctx['out']) / 'lib')
    os.environ['FFCX_GEN'] = str(Path(ctx['out']) / 'gen')
    # the exported PNGs (convert_effects names a prefab's texture by its exported file)
    os.environ['FFCX_EXTRACTED'] = ctx.get('extracted') or str(Path(ctx['out']) / 'arc' / '03-ExtractedAssets')
    os.environ['FFCX_CAB_INDEX'] = ctx['cab_index']
    os.environ['FFCX_NO_WORKSHOP'] = '1'
    vd = str(vendor_dir())
    if vd not in sys.path:
        sys.path.insert(0, vd)
    if ctx.get('trace'):
        _install_tracer(Path(ctx['staging']) / '02-DecodedBundles', Path(ctx['trace']))
    elif ctx.get('game'):
        _install_decoder(ctx)


def _install_decoder(ctx):
    """Decode any bundle a converter opens that the decode phase did not cover (safety net)."""
    import UnityPy
    from UnityPy import environment
    from . import bundles
    catalog = json.loads(Path(ctx['catalog']).read_text(encoding='utf-8'))
    octo = json.loads(Path(ctx['octo_index']).read_text(encoding='utf-8'))
    store = bundles.Store(catalog, octo, Path(ctx['staging']))
    root = os.path.normcase(str(Path(ctx['staging']) / '02-DecodedBundles')) + os.sep
    log = Path(ctx['out']) / '.ffcx' / 'on-demand.txt'

    def ensure(p):
        if isinstance(p, (str, os.PathLike)):
            s = os.path.normcase(os.path.abspath(p))
            if s.startswith(root) and not os.path.exists(s):
                name = s[len(root):].replace(os.sep, '/')
                for real in store.bundles:  # catalog names are case-sensitive; staging paths are not
                    if real.lower() == name:
                        store.ensure_bundle(real)
                        with open(log, 'a', encoding='utf-8') as f:
                            f.write(real + '\n')
                        break

    orig_load = UnityPy.load

    def load(*args, **kw):
        for a in args:
            ensure(a)
        return orig_load(*args, **kw)
    UnityPy.load = load
    orig_lf = environment.Environment.load_file

    def load_file(self, file, *a, **kw):
        ensure(file)
        return orig_lf(self, file, *a, **kw)
    environment.Environment.load_file = load_file


def _install_tracer(bundles_root: Path, trace_dir: Path):
    """Record every decoded bundle the converters look at (open, load, exists, glob) - dev recording runs."""
    import UnityPy
    from UnityPy import environment
    trace_dir.mkdir(parents=True, exist_ok=True)
    root = os.path.normcase(str(bundles_root)) + os.sep
    seen: set[str] = set()
    lock = threading.Lock()
    out = trace_dir / f'trace-{os.getpid()}.txt'

    def note(p):
        try:
            s = os.path.normcase(os.path.abspath(os.fspath(p)))
        except TypeError:
            return
        if s.startswith(root) and os.path.isfile(s):
            name = s[len(root):].replace(os.sep, '/')
            with lock:
                if name not in seen:
                    seen.add(name)
                    with open(out, 'a', encoding='utf-8') as f:
                        f.write(name + '\n')

    real_open = builtins.open

    def traced_open(file, *a, **kw):
        if isinstance(file, (str, os.PathLike)):
            note(file)
        return real_open(file, *a, **kw)
    builtins.open = traced_open
    for meth in ('exists', 'is_file'):
        orig = getattr(pathlib.Path, meth)

        def wrapped(self, *a, _orig=orig, **kw):
            r = _orig(self, *a, **kw)
            if r:
                note(self)
            return r
        setattr(pathlib.Path, meth, wrapped)
    for meth in ('glob', 'rglob', 'iterdir'):
        orig = getattr(pathlib.Path, meth)

        def wrapped(self, *a, _orig=orig, **kw):
            for x in _orig(self, *a, **kw):
                note(x)
                yield x
        setattr(pathlib.Path, meth, wrapped)
    orig_glob = globmod.glob

    def g(*a, **kw):
        r = orig_glob(*a, **kw)
        for x in r:
            note(x)
        return r
    globmod.glob = g
    orig_load = UnityPy.load

    def load(*args, **kw):
        for a in args:
            if isinstance(a, (str, os.PathLike)):
                note(a)
        return orig_load(*args, **kw)
    UnityPy.load = load
    orig_lf = environment.Environment.load_file

    def load_file(self, file, *a, **kw):
        if isinstance(file, (str, os.PathLike)):
            note(file)
        return orig_lf(self, file, *a, **kw)
    environment.Environment.load_file = load_file


# --- helpers -------------------------------------------------------------------------------------------------

def out_path(url: str) -> Path:
    """'/arc/05-Music-FLAC/x.flac' -> <root>/arc/05-Music-FLAC/x.flac"""
    return Path(CTX['out']) / url[1:4] / url[5:]


def bundle_file(name: str) -> Path:
    return Path(CTX['staging']) / '02-DecodedBundles' / name


def resource_file(name: str) -> Path:
    if CTX.get('resources'):
        return Path(CTX['resources']) / name
    return Path(CTX['staging']) / '01-Resources' / name


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.partial')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def scratch() -> Path:
    d = Path(CTX['out']) / '.ffcx' / 'tmp'
    d.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(dir=d))


# --- converters ----------------------------------------------------------------------------------------------

def do_glb(item) -> dict:
    """Unity bundle -> glTF via the vendored unity_gltf converter; keep only the files the explorer loads."""
    import unity_gltf
    lib_unity = Path(CTX['out']) / 'lib' / 'unity'
    report = unity_gltf.convert(CTX['staging'], item['bundle'], lib_unity)
    folder = lib_unity / Path(item['bundle']).with_suffix('')
    keep = {out_path(u).name for u in item['out']} | {'conversion.json'}
    for p in list(folder.iterdir()) if folder.exists() else []:
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.name not in keep:
            p.unlink()
    missing = [u for u in item['out'] if not out_path(u).exists()]
    return {'status': report.get('status'), 'missing': missing}


def _png(obj, path: Path):
    data = obj.read()
    img = data.image
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.stem + '.partial.png')
    img.save(tmp)
    os.replace(tmp, path)


def do_export(item) -> dict:
    """Texture2D/Sprite objects of one bundle -> PNG (same encoder settings as the archive export)."""
    import UnityPy
    todo = [o for o in item['objects'] if not out_path(o['out']).exists()]
    if not todo:
        return {'missing': []}
    env = UnityPy.load(str(bundle_file(item['bundle'])))
    # a scene bundle holds several serialized files whose small path ids repeat: match the type too, then the name
    objs: dict[int, list] = {}
    for obj in env.objects:
        objs.setdefault(obj.path_id, []).append(obj)
    missing = []
    for o in todo:
        cands = [x for x in objs.get(o['path_id'], []) if x.type.name == o.get('type', x.type.name)]
        if len(cands) > 1:
            name = re.sub(r'__pathid_-?\d+$', '', Path(o['out']).stem)
            cands = [x for x in cands if x.peek_name() == name] or cands
        if not cands:
            missing.append(o['out'])
            continue
        _png(cands[0], out_path(o['out']))
    return {'missing': missing}


def do_inventory(item) -> dict:
    import UnityPy
    env = UnityPy.load(str(bundle_file(item['bundle'])))
    inv = []
    for obj in env.objects:
        t = obj.type.name
        try:
            name = obj.peek_name() or f'{t}_{obj.path_id}'
        except Exception:
            name = f'{t}_{obj.path_id}'
        inv.append({'path_id': obj.path_id, 'type': t, 'name': name, 'bytes': obj.byte_size})
    atomic_write(out_path(item['out']), json.dumps({'bundle': item['bundle'], 'objects': inv}, ensure_ascii=False, indent=2).encode('utf-8'))
    return {'missing': []}


def _flac(wav: Path, dest: Path, metadata: list[str]):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.stem + '.partial.flac')
    r = run([tool('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(wav),
             '-c:a', 'flac', '-compression_level', '8', *metadata, str(tmp)], timeout=600)
    if r.returncode:
        raise RuntimeError('ffmpeg: ' + r.stderr[-500:])
    os.replace(tmp, dest)


def do_music(item) -> dict:
    """BGM bank (.awb, CRI HCA) -> FLAC with LOOPSTART/LOOPEND tags (convert_music.py settings)."""
    dest = out_path(item['out'])
    src = resource_file(item['resource'])
    tmp = scratch()
    try:
        wav = tmp / (src.stem + '.wav')
        r = run([tool('vgmstream-cli'), '-i', '-o', str(wav), str(src)], timeout=600)
        if r.returncode or not wav.exists():
            raise RuntimeError('vgmstream: ' + (r.stdout + r.stderr)[-500:])
        meta = ['-metadata', 'title=' + src.stem, '-metadata', 'album=FINAL FANTASY VII EVER CRISIS - Local Preservation']
        for key, pat in (('LOOPSTART', r'loop start: (\d+) samples'), ('LOOPEND', r'loop end: (\d+) samples')):
            m = re.search(pat, r.stdout)
            if m:
                meta += ['-metadata', f'{key}={m.group(1)}']
        _flac(wav, dest, meta)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {'missing': []}


def do_sfx(item) -> dict:
    """Sound bank (.acb/.awb) -> the subsongs the explorer plays, named like extract_all_audio.py."""
    bank = resource_file(item['bank'])
    tmp = scratch()
    missing = []
    try:
        for s in item['streams']:
            dest = out_path(s['out'])
            if dest.exists():
                continue
            r = run([tool('vgmstream-cli'), '-i', '-s', str(s['subsong']), '-o', str(tmp / '?04s_?n.wav'), str(bank)], timeout=600)
            wavs = list(tmp.glob('*.wav'))
            if r.returncode or not wavs:
                missing.append(s['out'])
                continue
            _flac(wavs[0], dest, ['-metadata', f'source_bank={bank.name}'])
            for w in wavs:
                w.unlink()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {'missing': missing}


def do_video(item) -> dict:
    """CRI USM -> MKV (VP9 copied, HCA audio -> FLAC), like postprocess_videos.py."""
    from wannacri.usm import Usm
    dest = out_path(item['out'])
    src = resource_file(item['resource'])
    tmp = scratch()
    try:
        Usm.open(str(src), encoding='shift-jis', key=USM_KEY).demux(path=str(tmp), save_video=True, save_audio=True,
                                                                   save_pages=False, folder_name=src.name)
        folder = tmp / src.name
        video = next((folder / 'videos').glob('*'), None)
        audio = next((folder / 'audios').glob('*'), None) if (folder / 'audios').exists() else None
        if video is None:
            raise RuntimeError('no video stream')
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.stem + '.partial.mkv')
        cmd = [tool('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(video)]
        if audio:
            wav = folder / 'decoded-audio.wav'
            r = run([tool('vgmstream-cli'), '-i', '-o', str(wav), str(audio)], timeout=600)
            if r.returncode or not wav.exists():
                raise RuntimeError('vgmstream: ' + (r.stdout + r.stderr)[-500:])
            cmd += ['-i', str(wav), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'flac', '-shortest', str(part)]
        else:
            cmd += ['-map', '0:v:0', '-c:v', 'copy', str(part)]
        r = run(cmd, timeout=1800)
        if r.returncode:
            raise RuntimeError('ffmpeg: ' + r.stderr[-500:])
        os.replace(part, dest)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return {'missing': []}


def do_weapon(item) -> dict:
    """Weapon bundle -> GLB via build_weapons.convert_weapon_bundle (step 1 of its main)."""
    import argparse
    import build_weapons as bw
    dest = out_path(item['out'])
    pfb = bundle_file(item['prefab'])
    info = bw.read_prefab(pfb) if pfb.exists() else None
    args = argparse.Namespace(albedo_size=1024, map_size=512, force=False, only='', no_models=False)
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = bw.convert_weapon_bundle(bundle_file(item['bundle']), dest, args, info)
    return {'missing': [] if dest.exists() else [item['out']], 'status': 'converted' if r else 'no-geometry'}


def do_sky(item) -> dict:
    import extract_skyboxes as sky
    sky.export_cubemap(bundle_file(item['bundle']), item['path_id'], item['name'])
    return {'missing': [u for u in item['out'] if not out_path(u).exists()]}


def do_anims(_item) -> dict:
    """All animation clips (three.js JSON + index.json) via convert_anims.py --scope all."""
    import convert_anims
    argv = sys.argv
    sys.argv = ['convert_anims.py', '--scope', 'all']
    try:
        convert_anims.main()
    finally:
        sys.argv = argv
    return {'missing': []}


def do_effects(_item) -> dict:
    """EC's particle effects: every prefab of the effect bundles, the ambience placed in battle stages and field
    maps, and the battle models' attach points (convert_effects.py, all of it)."""
    import convert_effects
    # the converter skips prefabs its index lists; after an interrupted run start over so no half-written file stays
    (Path(CTX['out']) / 'gen' / 'effects' / 'index.json').unlink(missing_ok=True)
    argv = sys.argv
    sys.argv = ['convert_effects.py']
    try:
        convert_effects.main()
    finally:
        sys.argv = argv
    return {'missing': []}


def do_lighting(item) -> dict:
    """One map scene's lighting (fog, ambient, sun, post-processing) -> gen/lighting/<map>.json."""
    import extract_lighting
    data = extract_lighting.extract(item['map'])
    dest = out_path(item['out'])
    atomic_write(dest, json.dumps(data, separators=(',', ':')).encode('utf-8'))
    return {'missing': []}


WORKERS = {'glb': do_glb, 'export': do_export, 'inventory': do_inventory, 'music': do_music, 'sfx': do_sfx,
           'video': do_video, 'weapon': do_weapon, 'sky': do_sky, 'anims': do_anims, 'effects': do_effects,
           'lighting': do_lighting}


def run_item(kind: str, item) -> dict:
    try:
        r = WORKERS[kind](item)
        r['ok'] = not r.get('missing')
        return r
    except Exception as e:  # reported, the pipeline carries on
        import traceback
        return {'ok': False, 'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-2000:]}


def sha256(path: Path) -> str:
    d = hashlib.sha256()
    with open(path, 'rb') as f:
        while b := f.read(8 << 20):
            d.update(b)
    return d.hexdigest()
