"""Developer tool: zip extractor/data into the data pack the installer downloads, and pin it.

    .venv\Scripts\python.exe release-tools\pack_data.py [--base https://<account>.blob.core.windows.net/ffcx-data]

Writes release-tools/out/ffcx-data-<catalog revision>-<sha256 prefix>.zip (deterministic: same files -> same
bytes) and updates extractor/data.lock.json with its name, size and SHA-256. The lock file is the only thing
that is committed; stage-release.ps1 copies it into release.json and the installer refuses any other bytes.
Upload the zip with release-tools/publish-data.ps1. The data pack is a recipe of ids, offsets and hashes, with no text, models, textures or audio. It is built from the
maintainer's local extraction and cannot be rebuilt from a player's install, so it is hosted outside the repository
and its releases.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'extractor' / 'data'
LOCK = ROOT / 'extractor' / 'data.lock.json'
OUT = ROOT / 'release-tools' / 'out'
FILES = ('recipe.json', 'templates.json.gz', 'text-bundles.json')  # keep in step with ffcx.pipeline.DATA_FILES


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', help='public URL of the blob container (stored in the lock file)')
    a = ap.parse_args()
    revision = json.loads((DATA / 'recipe.json').read_text(encoding='utf-8')).get('catalog_revision', 0)
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / 'ffcx-data.partial.zip'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for n in FILES:
            info = zipfile.ZipInfo(n, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, (DATA / n).read_bytes(), compresslevel=9)
    sha = hashlib.sha256(tmp.read_bytes()).hexdigest()
    name = f'ffcx-data-{revision}-{sha[:12]}.zip'
    final = OUT / name
    final.unlink(missing_ok=True)
    tmp.rename(final)
    old = json.loads(LOCK.read_text(encoding='utf-8')) if LOCK.exists() else {}
    lock = {
        'file': name,
        'sha256': sha,
        'size': final.stat().st_size,
        'catalogRevision': revision,
        'base': (a.base or old.get('base', '')).rstrip('/'),
    }
    LOCK.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(lock, indent=2))
    print(f'wrote {final}')


if __name__ == '__main__':
    main()
