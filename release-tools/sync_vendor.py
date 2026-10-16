"""Developer tool: copy the explorer's asset converters into extractor/vendor with configurable paths.

The originals (the explorer's tools/ and the converters' pipeline/unity_gltf.py) hard-code the maintainer's folder layout.
The copies read FFCX_ARCHIVE (staging tree with 02-DecodedBundles / 03-ExtractedAssets), FFCX_LIB (converted GLB
library), FFCX_GEN (generated/ output) and FFCX_CAB_INDEX instead. Every exact replacement must apply exactly once;
afterwards the maintainer's folder names are taken out of comments, and the generator strings name ffcx.
Source folders: FFC_EXPLORER and FFC_MODS (see release-tools/paths.py).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from paths import get  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
EXPLORER = get('FFC_EXPLORER')
MODS = get('FFC_MODS')
ARCHIVE = EXPLORER.parent
VENDOR = ROOT / 'extractor' / 'vendor'
EX, MO = EXPLORER.name, MODS.name

ENV = "import os as _os\nfrom pathlib import Path as _P\n"
FILES = {
    MODS / 'pipeline' / 'unity_gltf.py': [
        ("cp=Path(__file__).resolve().parents[1]/'catalog/cab-index.json'", "cp=_P(_os.environ['FFCX_CAB_INDEX'])"),
        # the explorer never loads the lossy "workshop" derivatives; FFCX_NO_WORKSHOP skips building them
        ("            if (mid,sub) in parted:continue", "            if (mid,sub) in parted or _os.environ.get('FFCX_NO_WORKSHOP'):continue"),
        ("    if rotations['channels'] and duration<=120:", "    if rotations['channels'] and duration<=120 and not _os.environ.get('FFCX_NO_WORKSHOP'):"),
        (re.compile(r"'generator':'[^']*'\+VERSION"), "'generator':'ffcx unity_gltf '+VERSION"),
        # its command-line entry point hard-codes the maintainer's folders; ffcx imports convert() instead
        (re.compile(r"\nif __name__=='__main__':\n(?:[ \t].*\n?)+\Z"), '\n'),
    ],
    EXPLORER / 'tools' / 'convert_anims.py': [
        ("ASSETS = Path(__file__).resolve().parents[2]", "ASSETS = _P(_os.environ['FFCX_ARCHIVE'])"),
        (f"OUT = ASSETS / '{EX}' / 'generated' / 'anims'", "OUT = _P(_os.environ['FFCX_GEN']) / 'anims'"),
        ("LIB = MODS / 'library'", "LIB = _P(_os.environ['FFCX_LIB'])"),
        ("CAB_INDEX_PATH = MODS / 'catalog' / 'cab-index.json'", "CAB_INDEX_PATH = _P(_os.environ['FFCX_CAB_INDEX'])"),
        (f"MODS = ASSETS.parent / '{MO}'\n", ''),
        (f"'generatedBy': '{EX}/tools/convert_anims.py'", "'generatedBy': 'ffcx convert_anims.py'"),
        (f"glTF basis of {MO} GLBs", "glTF basis of the converted GLBs"),
    ],
    EXPLORER / 'tools' / 'build_weapons.py': [
        ("ARCHIVE = ROOT.parent ", "ARCHIVE = _P(_os.environ['FFCX_ARCHIVE']) "),
        (f"LIB = ARCHIVE.parent / '{MO}' / 'library'", "LIB = _P(_os.environ['FFCX_LIB'])"),
        ("OUT_DIR = ROOT / 'generated' / 'weapons'", "OUT_DIR = _P(_os.environ['FFCX_GEN']) / 'weapons'"),
        (f"'generator': f'{EX} build_weapons.py v{{VERSION}}'", "'generator': f'ffcx build_weapons.py v{VERSION}'"),
    ],
    EXPLORER / 'tools' / 'extract_skyboxes.py': [
        ("ARCHIVE = Path(__file__).resolve().parents[2]", "ARCHIVE = _P(_os.environ['FFCX_ARCHIVE'])"),
        ("OUT = Path(__file__).resolve().parents[1] / 'generated' / 'sky'", "OUT = _P(_os.environ['FFCX_GEN']) / 'sky'"),
    ],
    EXPLORER / 'tools' / 'extract_dungeon_maps.py': [
        ("ARCHIVE = Path(__file__).resolve().parents[2]", "ARCHIVE = _P(_os.environ['FFCX_ARCHIVE'])"),
        ("OUT = Path(__file__).resolve().parents[1] / 'generated' / 'layout'", "OUT = _P(_os.environ['FFCX_GEN']) / 'layout'"),
    ],
    # EC's particle prefabs, stage ambience and attach points -> gen/effects. The prefabs' textures are looked up
    # among the PNGs the textures phase already wrote (FFCX_EXTRACTED = <root>/arc/03-ExtractedAssets), so the JSON
    # names the same /arc/ files as the maintainer's tree does.
    EXPLORER / 'tools' / 'convert_effects.py': [
        ("ROOT = Path(__file__).resolve().parents[1]\nASSETS = ROOT.parent\n", "ASSETS = _P(_os.environ['FFCX_ARCHIVE'])\n"),
        ("EXTRACTED = ASSETS / '03-ExtractedAssets'", "EXTRACTED = _P(_os.environ['FFCX_EXTRACTED'])"),
        ("OUT = ROOT / 'generated' / 'effects'", "OUT = _P(_os.environ['FFCX_GEN']) / 'effects'"),
        (f"'generatedBy': '{EX}/tools/convert_effects.py'", "'generatedBy': 'ffcx convert_effects.py'"),
        # field-map ambience comes from a set of GameObject keys: walk it in a fixed order so every player's
        # fields/*.json matches the reference hashes (set order changes with Python's string hash seed)
        ("        for go in ps_gos:\n", "        for go in sorted(ps_gos, key=repr):\n"),
    ],
    # scene lighting (EnvironmentData, RenderSettings, realtime lights, post-processing) -> gen/lighting
    EXPLORER / 'tools' / 'extract_lighting.py': [
        ("OUT = Path(__file__).resolve().parents[1] / 'generated' / 'lighting'", "OUT = _P(_os.environ['FFCX_GEN']) / 'lighting'"),
    ],
}


def neutral(text: str) -> str:
    """Comments and docstrings: the maintainer's absolute paths and folder names -> neutral words."""
    for path, word in ((MODS / '.venv' / 'Scripts' / 'python.exe', 'python'), (EXPLORER, '<explorer>'),
                       (MODS, '<converters>'), (ARCHIVE, '<archive>')):
        parts = [re.escape(p) for p in path.parts[1:]]
        drive = re.escape(path.drive)
        text = re.sub(drive + r'(?:\\\\|\\|/)+' + r'(?:\\\\|\\|/)+'.join(parts), lambda _m, w=word: w, text, flags=re.I)
    for name, word in ((EX, 'explorer'), (MO, 'converters'), (ARCHIVE.name, 'archive')):
        text = re.sub(rf'(?<![\w-]){re.escape(name)}(?![\w-])', word, text)
    return text


def label(src: Path) -> str:
    if src.is_relative_to(EXPLORER):
        return f'explorer/{src.relative_to(EXPLORER).as_posix()}'
    return f'converters/{src.relative_to(MODS).as_posix()}'


def main():
    VENDOR.mkdir(parents=True, exist_ok=True)
    stamp = {}
    for src, reps in FILES.items():
        text = src.read_text(encoding='utf-8')
        for old, new in reps:
            n = len(old.findall(text)) if isinstance(old, re.Pattern) else text.count(old)
            if n != 1:
                raise SystemExit(f'{src.name}: expected 1 occurrence of {getattr(old, "pattern", old)!r}, found {n} - update sync_vendor.py')
            text = old.sub(lambda _m, r=new: r, text) if isinstance(old, re.Pattern) else text.replace(old, new)
        text = neutral(text)
        # the env import goes right after the module docstring / future imports
        lines = text.split('\n')
        at = 0
        if lines[0].startswith(('"""', "'''")):
            q = lines[0][:3]
            at = 1 if lines[0].count(q) >= 2 and len(lines[0]) > 3 else next(i for i in range(1, len(lines)) if q in lines[i]) + 1
        while at < len(lines) and lines[at].startswith('from __future__'):
            at += 1
        lines.insert(at, ENV.rstrip('\n'))
        out = '\n'.join(lines)
        header = f'# Vendored from {label(src)} by release-tools/sync_vendor.py - do not edit here.\n'
        (VENDOR / src.name).write_text(header + out, encoding='utf-8', newline='\n')
        stamp[src.name] = {'sha256': hashlib.sha256(src.read_bytes()).hexdigest()}
    (VENDOR / 'SOURCES.json').write_text(json.dumps(stamp, indent=1) + '\n', encoding='utf-8', newline='\n')
    print('vendored', ', '.join(stamp))


if __name__ == '__main__':
    main()
