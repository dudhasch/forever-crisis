"""Where a maintainer's own working trees are. Players and CI never need these tools or paths.

Each path comes from an environment variable or, failing that, from release-tools/paths.local.json
(git-ignored), for example:

    {"FFC_ARCHIVE": "D:/ec/archive", "FFC_EXPLORER": "D:/ec/explorer", "FFC_MODS": "D:/ec/converters"}

    FFC_ARCHIVE   the maintainer's local extraction (00-Catalog, 02-DecodedBundles, 03-ExtractedAssets, ...)
    FFC_EXPLORER  the explorer's working tree (src/, tools/, generated/)
    FFC_MODS      the converters (pipeline/unity_gltf.py, catalog/cab-index.json) and their model library (library/)
    FFC_LIBRARY   the converted model library (default: FFC_MODS/library)
    FFC_CLIENT    the copy of the game folder kept with that extraction (older MasterData, data.unity3d)
    FFC_GAME      the Steam install (default: the usual Steam folder)
"""
from __future__ import annotations

import json
import os
from pathlib import Path

LOCAL = Path(__file__).resolve().with_name('paths.local.json')
DEFAULTS = {'FFC_GAME': r'C:\Program Files (x86)\Steam\steamapps\common\FF7EC'}


def get(name: str) -> Path:
    v = os.environ.get(name)
    if not v and LOCAL.is_file():
        v = json.loads(LOCAL.read_text(encoding='utf-8')).get(name)
    if not v and name == 'FFC_LIBRARY':
        return get('FFC_MODS') / 'library'
    v = v or DEFAULTS.get(name)
    if not v:
        raise SystemExit(f'{name} is not set. Set it in the environment or in {LOCAL.name} (see release-tools/paths.py).')
    return Path(v)
