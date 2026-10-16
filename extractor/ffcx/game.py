"""Find and validate a FINAL FANTASY VII EVER CRISIS Steam install."""
from __future__ import annotations

import os
import re
from pathlib import Path

APP_FOLDER = 'FF7EC'
CATALOG_REVISION = 366  # the last catalog the game shipped before shutdown


def _registry_steam_paths() -> list[Path]:
    out: list[Path] = []
    try:
        import winreg
    except ImportError:  # not Windows
        return out
    for hive, key, value in [
        (winreg.HKEY_CURRENT_USER, r'Software\Valve\Steam', 'SteamPath'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\WOW6432Node\Valve\Steam', 'InstallPath'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Valve\Steam', 'InstallPath'),
    ]:
        try:
            with winreg.OpenKey(hive, key) as k:
                out.append(Path(winreg.QueryValueEx(k, value)[0]))
        except OSError:
            pass
    return out


def steam_libraries() -> list[Path]:
    """Every Steam library folder: the Steam folder itself plus libraryfolders.vdf entries."""
    roots = _registry_steam_paths()
    for env in ('ProgramFiles(x86)', 'ProgramFiles'):
        if os.environ.get(env):
            roots.append(Path(os.environ[env]) / 'Steam')
    libs: list[Path] = []
    for root in roots:
        for vdf in (root / 'steamapps' / 'libraryfolders.vdf', root / 'config' / 'libraryfolders.vdf'):
            try:
                text = vdf.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            for m in re.finditer(r'"path"\s+"([^"]+)"', text):
                libs.append(Path(m.group(1).replace('\\\\', '\\')))
        libs.append(root)
    seen, out = set(), []
    for lib in libs:
        key = os.path.normcase(os.path.abspath(lib))
        if key not in seen and lib.exists():
            seen.add(key)
            out.append(lib)
    return out


def octo_cache(game: Path) -> Path | None:
    pdb = game / 'octo' / 'pdb'
    if not pdb.is_dir():
        return None
    return next(pdb.rglob('octocacheevai'), None)


def validate(game: Path) -> dict:
    """Checks that do not need decryption; `catalog.load` does the rest."""
    game = Path(game)
    checks = {
        'exe': (game / 'FF7EC.exe').is_file(),
        'metadata': (game / 'FF7EC_Data' / 'il2cpp_data' / 'Metadata' / 'global-metadata.dat').is_file(),
        'catalog': octo_cache(game) is not None,
        'bundles': (game / 'octo' / 'v1').is_dir(),
        'masterdata': (game / 'FF7EC_Data' / 'StreamingAssets' / 'MasterData' / 'index.json').is_file(),
    }
    reason = None
    if not checks['exe']:
        reason = 'FF7EC.exe is not in this folder.'
    elif not checks['metadata']:
        reason = 'The game files look incomplete (no IL2CPP metadata).'
    elif not checks['catalog'] or not checks['bundles']:
        reason = ("The game's downloaded data is missing. Ever Crisis downloads about 50 GB after its first start; "
                  'the extractor needs that data (octo folder).')
    elif not checks['masterdata']:
        reason = 'The game data (MasterData) is missing.'
    return {'path': str(game), 'ok': reason is None, 'reason': reason, 'checks': checks}


def candidates() -> list[dict]:
    found = []
    for lib in steam_libraries():
        game = lib / 'steamapps' / 'common' / APP_FOLDER
        if game.is_dir():
            found.append(validate(game))
    return found


def data_size(game: Path) -> int:
    total = 0
    for folder, _, names in os.walk(Path(game) / 'octo' / 'v1'):
        for n in names:
            try:
                total += os.path.getsize(os.path.join(folder, n))
            except OSError:
                pass
    return total
