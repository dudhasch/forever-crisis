"""The extraction pipeline: game install -> asset root the explorer serves.

Progress goes to stdout as JSON lines (one object per line) for the installer's console UI:
    {"event":"phase","id":"models","label":"Building 3D models","index":4,"count":11,"total":1291}
    {"event":"progress","id":"models","done":120,"total":1291}
    {"event":"warn","message":"..."}          {"event":"error","message":"..."}
    {"event":"done","files":32386,"bytes":...,"seconds":...,"missing":0}
Details go to <root>/.ffcx/extract.log. Every phase is resumable: finished items are listed in
<root>/.ffcx/done/<phase>.txt and skipped on the next run. A marker carries a stamp of the reference hashes of the
item's outputs, so a newer recipe (a new converter version, more textures in a bundle) redoes exactly the items whose
outputs changed.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import sys
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

from . import __version__, ASSET_FORMAT
from . import brand, bundles, cabindex, catalog, convert, game as gamemod, textpool


DATA_FILES = ('recipe.json', 'templates.json.gz', 'text-bundles.json')


def data_dir() -> Path:
    """The release's data pack (recipe, text templates, bundle list). Not part of the source tree: the installer
    downloads it (pinned by hash in extractor/data.lock.json) and passes it as --data / FFCX_DATA. Maintainers
    can keep the files in extractor/data, which is the fallback."""
    env = os.environ.get('FFCX_DATA')
    if env:
        return Path(env)
    base = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[1]))
    return base / 'data'


def check_data() -> Path:
    d = data_dir()
    missing = [n for n in DATA_FILES if not (d / n).is_file()]
    if missing:
        raise RuntimeError(f'The data pack is missing ({", ".join(missing)} not found in {d}). '
                           'Run the installer again, or pass --data <folder>.')
    return d


class Run:
    def __init__(self, out: Path, game: Path | None = None, archive: Path | None = None, trace: bool = False,
                 workers: int | None = None, keep_work: bool = False, only: list[str] | None = None, limit: int = 0,
                 client: Path | None = None):
        self.out = Path(out)
        self.game = Path(game) if game else None
        # developer mode: `archive` is the maintainer's local extraction (already decoded bundles), `client` the copy
        # of the game folder that belongs to it (MasterData, data.unity3d)
        self.archive = Path(archive) if archive else None
        self.client = Path(client) if client else self.game
        if self.client is None:
            raise RuntimeError('No game folder: pass --game (or --client with --archive).')
        self.trace = trace
        self.workers = workers or max(2, min(16, (os.cpu_count() or 4) - 2))
        self.keep_work = keep_work
        self.only = only
        self.limit = limit
        self.meta = self.out / '.ffcx'
        self.meta.mkdir(parents=True, exist_ok=True)
        (self.meta / 'done').mkdir(exist_ok=True)
        self.log = open(self.meta / 'extract.log', 'a', encoding='utf-8')
        self.recipe = json.loads((check_data() / 'recipe.json').read_text(encoding='utf-8'))
        self.staging = (self.archive if self.archive else self.meta / 'staging')
        self.t0 = time.time()
        self.failures: list[dict] = []
        self.phase_index = 0
        self.text_only = bool(only) and set(only) <= {'text', 'verify'}
        self.bundle_free = bool(only) and set(only) <= {'brand', 'verify'}  # brand reads data.unity3d itself

    # --- reporting -------------------------------------------------------------------------------------------
    def emit(self, **ev):
        line = json.dumps(ev, ensure_ascii=False)
        print(line, flush=True)
        self.log.write(time.strftime('%H:%M:%S ') + line + '\n')
        self.log.flush()

    def note(self, msg: str):
        self.log.write(time.strftime('%H:%M:%S ') + msg + '\n')
        self.log.flush()

    def phase(self, pid: str, label: str, total: int):
        self.phase_index += 1
        self.emit(event='phase', id=pid, label=label, index=self.phase_index, count=len(self.PHASES), total=total)

    def done_set(self, pid: str) -> set[str]:
        p = self.meta / 'done' / f'{pid}.txt'
        return set(p.read_text(encoding='utf-8').split('\n')) - {''} if p.exists() else set()

    def mark_done(self, pid: str, key: str):
        (self.meta / 'done').mkdir(parents=True, exist_ok=True)
        with open(self.meta / 'done' / f'{pid}.txt', 'a', encoding='utf-8') as f:
            f.write(key + '\n')

    PHASES = ['catalog', 'index', 'decode', 'models', 'textures', 'weapons', 'sky', 'music', 'sounds', 'movies', 'animations',
              'effects', 'lighting', 'text', 'brand', 'verify']

    def outputs(self, kind: str, x) -> list[str]:
        """The files one recipe item writes (URLs as in reference_files)."""
        r = self.recipe
        if kind in ('glb', 'sky'):
            return x['out']
        if kind == 'export':
            return [o['out'] for o in x['objects']]
        if kind == 'sfx':
            return [st['out'] for st in x['streams']]
        if kind == 'anims':
            return r.get('anims', [])
        if kind == 'effects':
            return r.get('effects', [])
        return [x['out']]

    def stamp(self, kind: str, x) -> str:
        ref = self.recipe.get('reference_files', {})
        d = hashlib.sha1()
        for u in sorted(self.outputs(kind, x)):
            f = ref.get(u, {})
            d.update(f'{u} {f.get("sha256") or f.get("size", "")}\n'.encode('utf-8'))
        return d.hexdigest()[:12]

    def is_done(self, done: set[str], kind: str, key: str, stamp: str, x) -> bool:
        if f'{kind}:{key}#{stamp}' in done:
            return True
        if f'{kind}:{key}' not in done:
            return False
        # a marker without a stamp (test builds before 0.1.0): still done if every output is there at its reference size
        ref = self.recipe.get('reference_files', {})
        for u in self.outputs(kind, x):
            p = self.out / u[1:4] / u[5:]
            if u not in ref or not p.is_file() or p.stat().st_size != ref[u]['size']:
                return False
        return True

    # --- phases ------------------------------------------------------------------------------------------------
    def run(self) -> int:
        try:
            self._run()
            return 0
        except Exception as e:
            self.note(traceback.format_exc())
            self.emit(event='error', message=str(e))
            return 1

    def _run(self):
        r = self.recipe
        self.emit(event='start', version=__version__, out=str(self.out), workers=self.workers,
                  mode='archive' if self.archive else 'game')
        self._check_space()

        # 1. catalog
        self.phase('catalog', 'Reading the game catalog', 1)
        if self.game:
            v = gamemod.validate(self.game)
            if not v['ok']:
                raise RuntimeError(v['reason'])
            self.catalog = catalog.load(self.game, self.meta)
            if self.catalog['revision'] != r['catalog_revision']:
                self.emit(event='warn', message=f"Catalog revision {self.catalog['revision']} (expected {r['catalog_revision']}); continuing.")
            octo_path = self.meta / 'octo.json'
            self.octo = bundles.index_octo(self.game)
            octo_path.write_text(json.dumps(self.octo), encoding='utf-8')
            self.store = bundles.Store(self.catalog, self.octo, self.staging)
        else:
            raw = json.loads((self.archive / '00-Catalog' / 'catalog.json').read_text(encoding='utf-8'))
            self.catalog = {'revision': raw['revision'], 'bundles': raw['asset_bundle_list'], 'resources': raw['resource_list']}
            (self.meta / 'catalog.json').write_text(json.dumps(self.catalog), encoding='utf-8')
            self.store = None
        self.emit(event='progress', id='catalog', done=1, total=1)

        # 2. CAB index (cross-bundle references)
        cab = self.meta / 'cab-index.json'
        items = []
        for b in self.catalog['bundles']:
            if self.game:
                src = self.octo.get(b['md5'])
                if src:
                    items.append((src, b['name'], b['name']))
            else:
                items.append((str(self.staging / '02-DecodedBundles' / b['name']), None, b['name']))
        self.phase('index', 'Indexing game files', len(items))
        if not cab.exists() and not (self.text_only or self.bundle_free):
            res = cabindex.build(items, cab, lambda n, t: self.emit(event='progress', id='index', done=n, total=t))
            self.note(f'cab index {res}')
        self.emit(event='progress', id='index', done=len(items), total=len(items))

        # 3. decode the minimal set of bundles and resources
        self.decode()

        ctx = {'out': str(self.out), 'staging': str(self.staging), 'cab_index': str(cab),
               'catalog': str(self.meta / 'catalog.json'), 'octo_index': str(self.meta / 'octo.json'),
               'game': str(self.game) if self.game else None,
               'resources': str(self.archive / '01-Resources') if self.archive else None,
               # PNGs a converter may name instead of exporting its own copy (convert_effects): the textures phase's
               # output, or in developer mode the maintainer's full export (a superset with the same names)
               'extracted': str((self.archive if self.archive else self.out / 'arc') / '03-ExtractedAssets'),
               'trace': str(self.meta / 'trace') if self.trace else None}
        self.ctx = ctx
        convert.init_worker(ctx, main=True)  # main process too (templates, single-threaded steps)

        # 4..10 conversions
        self.pool_phase('models', 'Building 3D models', 'glb', r['glb'], lambda x: x['bundle'])
        self.pool_phase('textures', 'Exporting textures', 'export', r['export'], lambda x: x['bundle'],
                        extra=('inventory', r['inventory'], lambda x: x['out']))
        self.pool_phase('weapons', 'Building weapons', 'weapon', r['weapon'], lambda x: x['out'])
        self.pool_phase('sky', 'Exporting skies', 'sky', r['sky'], lambda x: x['name'])
        self.pool_phase('music', 'Converting music', 'music', r['music'], lambda x: x['out'])
        self.pool_phase('sounds', 'Converting sound effects', 'sfx', r['sfx'], lambda x: x['bank'])
        self.pool_phase('movies', 'Converting movies', 'video', r['video'], lambda x: x['out'])
        self.pool_phase('animations', 'Preparing animations', 'anims', [{'key': 'all'}], lambda x: 'all', workers=1)
        if r.get('effects'):  # needs the textures phase first: effects name the PNGs it exported
            self.pool_phase('effects', 'Building battle effects', 'effects', [{'key': 'all'}], lambda x: 'all', workers=1)
        self.pool_phase('lighting', 'Reading stage lighting', 'lighting', r.get('lighting', []), lambda x: x['map'])
        if not self.bundle_free:
            self.templates()
        self.brand()
        if self.text_only and 'verify' not in self.only:
            self.emit(event='done', textMissing=self.text_missing, textFallbacks=self.text_blank, seconds=round(time.time() - self.t0))
        elif self.bundle_free and 'verify' not in self.only:
            self.emit(event='done', failures=len(self.failures), seconds=round(time.time() - self.t0))
        else:
            self.verify()
        if not self.keep_work and not self.archive:
            shutil.rmtree(self.meta / 'staging', ignore_errors=True)
        shutil.rmtree(self.meta / 'tmp', ignore_errors=True)

    def _check_space(self):
        if self.bundle_free:
            return
        need = sum(f['size'] for f in self.recipe.get('reference_files', {}).values())
        have = 0
        for u, f in self.recipe.get('reference_files', {}).items():
            p = self.out / u[1:4] / u[5:]
            if p.exists():
                have += p.stat().st_size
        need = max(0, need - have) + (0 if self.archive else 30 << 30)  # staging for decoded bundles
        free = shutil.disk_usage(self.out).free
        if need and free < need:
            raise RuntimeError(f'Not enough free disk space: about {need / 2**30:.0f} GB needed, {free / 2**30:.0f} GB free on this drive.')

    def decode(self):
        r = self.recipe
        if self.text_only or self.bundle_free:  # --only text: just the Lua/data bundles the text pool reads
            r = {k: [] for k in ('decode', 'glb', 'export', 'inventory', 'sky', 'weapon', 'music', 'video', 'sfx', 'lighting')}
        names = set(r.get('decode', []))
        if not self.bundle_free:
            names |= set(json.loads((data_dir() / 'text-bundles.json').read_text(encoding='utf-8')))
        for kind in ('glb', 'export', 'inventory', 'sky'):
            names |= {x['bundle'] for x in r[kind]}
        for w in r['weapon']:
            names |= {w['bundle'], w['prefab']}
        names |= {f"scenes/{x['map']}.s" for x in r.get('lighting', [])}
        in_catalog = {b['name'] for b in self.catalog['bundles']}
        names = sorted(n for n in names if n in in_catalog)
        res = {x['resource'] for x in r['music'] + r['video']}
        for s in r['sfx']:
            res.add(s['bank'])
            if s['bank'].endswith('.acb'):
                res.add(s['bank'][:-4] + '.awb')
        known = {Path(x['name']).name for x in self.catalog['resources']}
        res = sorted(x for x in res if x in known)
        self.phase('decode', 'Unpacking game data', len(names) + len(res))
        if self.archive:
            self.emit(event='progress', id='decode', done=len(names) + len(res), total=len(names) + len(res))
            return
        done = self.done_set('decode')
        todo = [('b', n) for n in names if 'b:' + n not in done] + [('r', n) for n in res if 'r:' + n not in done]
        n_done = len(names) + len(res) - len(todo)

        def one(t):
            kind, n = t
            try:
                if kind == 'b':
                    if self.store.has_bundle(n):
                        self.store.ensure_bundle(n)
                else:
                    self.store.ensure_resource(n)
                return t, None
            except Exception as e:
                return t, str(e)
        with ThreadPoolExecutor(8) as pool:
            for i, (t, err) in enumerate(pool.map(one, todo), 1):
                if err:
                    self.failures.append({'phase': 'decode', 'item': t[1], 'error': err})
                    self.emit(event='warn', message=f'Could not unpack {t[1]}: {err}')
                else:
                    self.mark_done('decode', f'{t[0]}:{t[1]}')
                if i % 200 == 0 or i == len(todo):
                    self.emit(event='progress', id='decode', done=n_done + i, total=len(names) + len(res))

    def pool_phase(self, pid, label, kind, items, key, workers=None, extra=None):
        jobs = [(kind, x, key(x)) for x in items]
        if extra:
            jobs += [(extra[0], x, extra[2](x)) for x in extra[1]]
        if self.only and pid not in self.only:
            return
        if self.limit:
            jobs = jobs[:self.limit]
        self.phase(pid, label, len(jobs))
        done = self.done_set(pid)
        stamps = {(k, kk): self.stamp(k, x) for k, x, kk in jobs}
        todo = [j for j in jobs if not self.is_done(done, j[0], j[2], stamps[j[0], j[2]], j[1])]
        base = len(jobs) - len(todo)
        self.emit(event='progress', id=pid, done=base, total=len(jobs))
        if not todo:
            return
        n = 0
        retry = []

        def run(batch, max_workers, last_try):
            nonlocal n
            with ProcessPoolExecutor(max_workers=max_workers, initializer=convert.init_worker, initargs=(self.ctx,)) as pool:
                futs = {pool.submit(convert.run_item, k, x): (k, x, kk) for k, x, kk in batch}
                for f in as_completed(futs):
                    k, x, kk = futs[f]
                    try:
                        res = f.result()
                    except Exception as e:  # worker crashed (out of memory, ...): the pool is gone for every item left
                        res = {'ok': False, 'error': f'{type(e).__name__}: {e}', 'crash': True}
                    if res.get('ok'):
                        self.mark_done(pid, f'{k}:{kk}#{stamps[k, kk]}')
                    elif not last_try and (res.get('crash') or str(res.get('error', '')).startswith('MemoryError')):
                        retry.append((k, x, kk))  # big stages need more memory than a full set of workers leaves
                        self.note(f'RETRY {pid} {kk} later on its own: {res.get("error")}')
                        continue
                    else:
                        self.failures.append({'phase': pid, 'item': kk, **{a: res.get(a) for a in ('error', 'missing')}})
                        self.note(f'FAILED {pid} {kk}: {res.get("error")} missing={res.get("missing")}\n{res.get("trace", "")}')
                    n += 1
                    if n % max(1, len(todo) // 200) == 0 or n == len(todo):
                        self.emit(event='progress', id=pid, done=base + n, total=len(jobs))
        run(todo, workers or self.workers, last_try=(workers or self.workers) == 1)
        if retry:
            self.note(f'{pid}: retrying {len(retry)} item(s) one at a time')
            run(retry, 1, last_try=True)
        if any(fl['phase'] == pid for fl in self.failures):
            c = sum(fl['phase'] == pid for fl in self.failures)
            self.emit(event='warn', message=f'{label}: {c} item(s) could not be converted (see the log).')

    def templates(self):
        tmpl_path = data_dir() / 'templates.json.gz'
        with gzip.open(tmpl_path, 'rt', encoding='utf-8') as f:
            templates = json.load(f)
        self.phase('text', 'Preparing story text', len(templates))
        need = set()
        for t in templates.values():
            need |= textpool.needed_hashes(t)
        pool: dict[str, str] = {}
        md = self.client / 'FF7EC_Data' / 'StreamingAssets' / 'MasterData'

        def add(s):
            k = textpool.h(s)
            if k in need:
                pool[k] = s
        for s in textpool.masterdata_strings(md):
            add(s)
        tb = json.loads((data_dir() / 'text-bundles.json').read_text(encoding='utf-8'))
        for s in textpool.textasset_strings(self.staging / '02-DecodedBundles' / n for n in tb):
            add(s)
            for x in textpool.lua_literals(s):
                add(x)
        reh = textpool.Rehydrator(pool)
        self.note(f'text pool: {len(pool)} of {len(need)} referenced strings found')
        for i, (u, t) in enumerate(templates.items(), 1):
            dest = self.out / 'gen' / u[len('/gen/'):]
            convert.atomic_write(dest, json.dumps(reh(t), ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            if i % 100 == 0 or i == len(templates):
                self.emit(event='progress', id='text', done=i, total=len(templates))
        self.text_missing = len(reh.missing)
        self.text_blank = reh.blank
        self.text_needed = len(need)
        if reh.missing:
            self.emit(event='warn', message=f'{len(reh.missing)} of {len(need)} text entries are no longer in this game install (the game dropped them from its data); '
                      'names show their id and other texts are left blank.')

    def brand(self):
        """The logo, favicon and app icons, drawn from the game's own title sprites into <root>/brand (brand.py)."""
        if self.only and 'brand' not in self.only:
            return
        self.phase('brand', 'Drawing the logo and icons', 1)
        dest = self.out / 'brand'
        if 'all' not in self.done_set('brand') or not all((dest / f).exists() for f in brand.FILES):
            src = self.client / 'FF7EC_Data' / 'data.unity3d'
            try:
                brand.build(src, dest)
                self.mark_done('brand', 'all')
            except Exception as e:
                self.failures.append({'phase': 'brand', 'item': 'brand', 'error': str(e)})
                self.note(traceback.format_exc())
                self.emit(event='warn', message=f'Could not draw the logo ({e}); the title screen shows a text logo instead.')
        self.emit(event='progress', id='brand', done=1, total=1)

    def verify(self):
        ref = self.recipe.get('reference_files', {})
        urls = sorted(ref)
        self.phase('verify', 'Checking files', len(urls))
        files, missing, total = {}, [], 0

        def one(u):
            p = self.out / u[1:4] / u[5:]
            if not p.exists():
                return u, None
            return u, {'size': p.stat().st_size, 'sha256': convert.sha256(p)}
        with ThreadPoolExecutor(8) as pool:
            for i, (u, rec) in enumerate(pool.map(one, urls), 1):
                if rec is None:
                    missing.append(u)
                else:
                    files[u] = rec
                    total += rec['size']
                if i % 500 == 0 or i == len(urls):
                    self.emit(event='progress', id='verify', done=i, total=len(urls))
        same = sum(1 for u, rec in files.items() if ref[u].get('sha256') == rec['sha256'])
        for f in brand.FILES:
            p = self.out / 'brand' / f
            if p.exists():
                files[f'/brand/{f}'] = {'size': p.stat().st_size, 'sha256': convert.sha256(p)}
                total += p.stat().st_size
        manifest = {'format': 1, 'assetFormat': ASSET_FORMAT, 'extractor': __version__,
                    'catalogRevision': self.catalog['revision'], 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    'source': 'archive' if self.archive else 'steam', 'files': files, 'missing': missing,
                    'stats': {'files': len(files), 'bytes': total, 'missing': len(missing), 'identicalToReference': same,
                              'textMissing': getattr(self, 'text_missing', 0), 'textFallbacks': getattr(self, 'text_blank', 0), 'seconds': round(time.time() - self.t0)}}
        (self.out / 'ffcx-manifest.json').write_text(json.dumps(manifest, separators=(',', ':')), encoding='utf-8')
        (self.meta / 'failures.json').write_text(json.dumps(self.failures, indent=1), encoding='utf-8')
        self.emit(event='done', files=len(files), bytes=total, missing=len(missing), identical=same,
                  failures=len(self.failures), seconds=round(time.time() - self.t0))
