"""Developer tool: build extractor/data/recipe.json from the maintainer's local extraction.

The recipe lists every file the explorer can request and how the extractor rebuilds it from a player's own
game install. It holds names, ids and hashes only, never game content.

    .venv\\Scripts\\python.exe release-tools\\make_recipe.py [--no-hash]

Inputs (read-only, see release-tools/paths.py): the explorer (src + generated), the converted model library and
the extraction's 99-Manifests.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'release-tools'))
from paths import get  # noqa: E402

ARCHIVE = get('FFC_ARCHIVE')
EXPLORER = get('FFC_EXPLORER')
LIBRARY = get('FFC_LIBRARY')
GEN = EXPLORER / 'generated'
MOUNTS = {'arc': ARCHIVE, 'lib': LIBRARY, 'gen': GEN}
OUT = ROOT / 'extractor' / 'data' / 'recipe.json'

GEN_SKIP = re.compile(r'(\.log$|^capture-check\.json$|^stats\.json$|SPEC\.md$|^weapons/_conversion\.json$)')
URL = re.compile(r'^/(arc|lib|gen)/')


def local(url: str) -> Path:
    top, rel = url[1:4], url[5:]
    return MOUNTS[top] / rel


def crawl_json(v, out: set):
    if isinstance(v, str):
        if URL.match(v):
            out.add(v)
    elif isinstance(v, dict):
        for x in v.values():
            crawl_json(x, out)
    elif isinstance(v, list):
        for x in v:
            crawl_json(x, out)


def collect_urls() -> set[str]:
    urls: set[str] = set()
    for p in GEN.rglob('*'):
        if not p.is_file():
            continue
        rel = p.relative_to(GEN).as_posix()
        if GEN_SKIP.search(rel):
            continue
        urls.add('/gen/' + rel)
        if p.suffix == '.json' and not rel.startswith('anims/'):
            crawl_json(json.loads(p.read_text(encoding='utf-8')), urls)
    # stage normal / MRO maps (render/stagemaps.ts builds their URLs from stage-textures.json)
    st = GEN / 'stage-textures.json'
    if st.is_file():
        idx = json.loads(st.read_text(encoding='utf-8'))
        for v in idx['ids'].values():
            i, name = v.split('/', 1)
            urls.add(f"/arc/03-ExtractedAssets/{idx['dirs'][int(i)]}/Texture2D/{name}.png")
        for scene, names in idx['local'].items():
            for name in names.values():
                urls.add(f'/arc/03-ExtractedAssets/scenes/{scene}/Texture2D/{name}.png')
    # literal URLs in the app source
    for p in (EXPLORER / 'src').rglob('*.ts'):
        src = p.read_text(encoding='utf-8')
        for m in re.finditer(r"""['"`](/(?:arc|lib|gen)/[^'"`$]+)['"`]""", src):
            urls.add(m.group(1))
        # a sound bank the code picks from at runtime (`/arc/08-Audio-Extracted/se_ui_common/${...}.flac`): all of it
        for m in re.finditer(r"`/arc/08-Audio-Extracted/([^/`$]+)/\$\{", src):
            urls.update(f'/arc/08-Audio-Extracted/{m.group(1)}/{f.name}' for f in (ARCHIVE / '08-Audio-Extracted' / m.group(1)).glob('*.flac'))
    # scene conversion.json + animation glTFs (map.ts)
    for u in list(urls):
        m = re.match(r'^/lib/(unity/scenes/[^/]+)/model\.glb$', u)
        if m:
            conv = LIBRARY / m.group(1) / 'conversion.json'
            if conv.exists():
                urls.add(f'/lib/{m.group(1)}/conversion.json')
                for a in json.loads(conv.read_text(encoding='utf-8')).get('animations', []):
                    urls.add(f'/lib/{m.group(1)}/{a["file"]}')
    # battle model PBR maps (render/pbr.ts)
    for u in list(urls):
        m = re.match(r'^/lib/unity/((?:character|monster)/[^/]+/model/[^/]+)/model\.glb$', u)
        if not m:
            continue
        folder = ARCHIVE / '03-ExtractedAssets' / m.group(1)
        if (folder / '_bundle_inventory.json').exists():
            urls.add(f'/arc/03-ExtractedAssets/{m.group(1)}/_bundle_inventory.json')
        for png in (folder / 'Texture2D').glob('*.png') if (folder / 'Texture2D').is_dir() else []:
            if re.search(r'_(MROX|MROE|NNNX)$|ramp', png.stem):
                urls.add(f'/arc/03-ExtractedAssets/{m.group(1)}/Texture2D/{png.name}')
    return {u for u in urls if local(u).is_file()}, {u for u in urls if not local(u).is_file()}


def jsonl(paths):
    for p in paths:
        if p.exists():
            with p.open(encoding='utf-8') as f:
                for line in f:
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-hash', action='store_true')
    ap.add_argument('--rehash', action='store_true', help='hash every file of the dev tree, also those the last recording run measured')
    args = ap.parse_args()
    t0 = time.time()
    urls, missing = collect_urls()
    print(f'{len(urls)} files referenced ({len(missing)} referenced but absent in the dev tree)', flush=True)

    man = ARCHIVE / '99-Manifests'
    exported = {}
    for r in jsonl([man / 'extracted-assets.jsonl', *sorted(man.glob('extracted-assets.shard-*.jsonl'))]):
        for o in r.get('outputs', []):
            if o.get('file'):
                f = '/arc/' + o['file'].replace('\\', '/')
                exported[f] = (r['name'], o['path_id'], o['type'])
                # a re-run of the original export wrote __pathid_ twins; the plain name is the same object
                exported.setdefault(re.sub(r'__pathid_-?\d+(\.\w+)$', r'\1', f), (r['name'], o['path_id'], o['type']))
    sfx = {}
    for r in jsonl([man / 'audio-conversion.jsonl']):
        for o in r.get('outputs', []):
            if o.get('file'):
                sfx['/arc/' + o['file'].replace('\\', '/')] = r['name']

    recipe = {'glb': {}, 'export': collections.defaultdict(list), 'inventory': [], 'music': [], 'sfx': collections.defaultdict(list),
              'video': [], 'weapon': [], 'sky': {}, 'anims': [], 'effects': [], 'lighting': [], 'template': [], 'unknown': []}
    for u in sorted(urls):
        if u.startswith('/lib/unity/'):
            folder = local(u).parent
            conv = folder / 'conversion.json'
            bundle = json.loads(conv.read_text(encoding='utf-8'))['bundle'] if conv.exists() else None
            if not bundle:
                recipe['unknown'].append(u)
                continue
            recipe['glb'].setdefault(bundle, []).append(u)
        elif u.startswith('/arc/03-ExtractedAssets/'):
            if u.endswith('/_bundle_inventory.json'):
                inv = json.loads(local(u).read_text(encoding='utf-8'))
                recipe['inventory'].append({'bundle': inv['bundle'], 'out': u})
            elif u in exported:
                b, pid, typ = exported[u]
                recipe['export'][b].append({'path_id': pid, 'type': typ, 'out': u})
            else:
                recipe['unknown'].append(u)
        elif u.startswith('/arc/05-Music-FLAC/'):
            recipe['music'].append({'resource': Path(u).stem + '.awb', 'out': u})
        elif u.startswith('/arc/08-Audio-Extracted/'):
            if u in sfx:
                m = re.match(r'^(\d+)_', Path(u).name)
                recipe['sfx'][sfx[u]].append({'subsong': int(m.group(1)), 'out': u})
            else:
                recipe['unknown'].append(u)
        elif u.startswith('/arc/06-Video-Extracted/Playable-MKV/'):
            recipe['video'].append({'resource': Path(u).stem + '.usm', 'out': u})
        elif u.startswith('/gen/anims/'):
            recipe['anims'].append(u)
        elif u.startswith('/gen/effects/'):  # convert_effects.py rebuilds all of it (meshes too) on the player's PC
            recipe['effects'].append(u)
        elif re.match(r'^/gen/lighting/[^/]+\.json$', u):
            recipe['lighting'].append({'map': Path(u).stem, 'out': u})
        elif re.match(r'^/gen/weapons/[^/]+/[^/]+\.glb$', u):
            f, m = u.split('/')[-2], Path(u).stem
            recipe['weapon'].append({'bundle': f'weapon/{f}/model/{m}.d', 'prefab': f'weapon/{f}/pfb_we{f}_{m}.a', 'out': u})
        elif u.startswith('/gen/sky/') and u.endswith('.jpg'):
            recipe['sky'].setdefault(u.split('/')[3], []).append(u)
        elif u.startswith('/gen/') and u.endswith('.json'):
            recipe['template'].append(u)
        else:
            recipe['unknown'].append(u)

    # skybox cubemaps: name -> (bundle, path_id), from the skybox texture bundles (names + ids only)
    import UnityPy
    sky_dir = ARCHIVE / '02-DecodedBundles' / 'environment' / 'common' / 'skybox' / 'materials'
    cubes = {}
    for f in sorted(sky_dir.glob('tex_env_skybox_*.a')):
        for o in UnityPy.load(str(f)).objects:
            if o.type.name == 'Cubemap':
                cubes[o.read().m_Name] = (f.relative_to(ARCHIVE / '02-DecodedBundles').as_posix(), o.path_id)
    recipe['sky'] = [{'name': n, 'bundle': cubes[n][0], 'path_id': cubes[n][1], 'out': sorted(v)} for n, v in sorted(recipe['sky'].items())]

    recipe['export'] = [{'bundle': b, 'objects': sorted(v, key=lambda o: o['out'])} for b, v in sorted(recipe['export'].items())]
    recipe['sfx'] = [{'bank': b, 'streams': sorted(v, key=lambda o: o['subsong'])} for b, v in sorted(recipe['sfx'].items())]
    recipe['glb'] = [{'bundle': b, 'out': sorted(v)} for b, v in sorted(recipe['glb'].items())]

    old = json.loads(OUT.read_text(encoding='utf-8')) if OUT.exists() else {}
    files = {u: {'size': local(u).stat().st_size} for u in urls}
    # files the last recording run (release-tools/record.py) measured keep that run's size and hash; a new recording
    # replaces those of the items it redoes, the rest stay right because their converters did not change
    recorded = {} if args.rehash else {u: f for u, f in old.get('reference_files', {}).items() if u in urls}
    files.update(recorded)
    if not args.no_hash:
        to_hash = sorted(u for u in urls if u not in recorded)
        def h(u):
            p = local(u)
            d = hashlib.sha256()
            with p.open('rb') as f:
                while b := f.read(8 << 20):
                    d.update(b)
            return u, {'size': p.stat().st_size, 'sha256': d.hexdigest()}
        with ThreadPoolExecutor(12) as pool:
            for i, (u, rec) in enumerate(pool.map(h, to_hash), 1):
                files[u] = rec
                if i % 5000 == 0:
                    print(f'hashed {i}/{len(to_hash)}', flush=True)
    print(f'{len(recorded)} sizes and hashes kept from the last recording run, {len(urls) - len(recorded)} from the dev tree', flush=True)
    counts = {k: len(v) for k, v in recipe.items()}
    sizes = collections.Counter()
    for u in urls:
        sizes[u.split('/')[1] + '/' + u.split('/')[2]] += local(u).stat().st_size
    doc = {'format': 1, 'catalog_revision': 366, 'built': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'counts': counts, 'reference_files': files, **recipe}
    if old.get('decode'):  # keep the recorded decode list (release-tools/record.py)
        doc['decode'] = old['decode']
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(',', ':')), encoding='utf-8')
    print(json.dumps(counts))
    for k, v in sorted(sizes.items(), key=lambda x: -x[1]):
        print(f'  {k:40} {v / 1e9:7.2f} GB')
    print(f'total {sum(sizes.values()) / 1e9:.2f} GB, unknown sample {recipe["unknown"][:5]}, missing sample {sorted(missing)[:5]}')
    print(f'{time.time() - t0:.0f}s')


if __name__ == '__main__':
    sys.exit(main())
