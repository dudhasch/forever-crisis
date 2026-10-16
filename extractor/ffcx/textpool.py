"""Text references between the shipped JSON templates and the player's own game data.

Generated explorer data (story scripts, dialogue, names, menus) is shipped as *templates*: every string that
is game text was replaced, at release time, by a reference to where that text lives in the game's own files:

    "\x01H<hash>"                 the whole string equals a game string with that hash
    "\x01C<json segments>"        a composite: [hash, start, length] slices of game strings and literal glue

The hash is the first 12 hex digits of sha1(utf-8 text). The extractor rebuilds the pool from the player's
install (decrypted MasterData + Lua TextAssets) and fills the references back in.
"""
from __future__ import annotations

import base64
import binascii
import gzip
import hashlib
import json
import re
from pathlib import Path
from typing import Iterable, Iterator

MARK = '\x01'
_TEXTY = re.compile(r'[\s\u0080-￿]')
_IDENT = re.compile(r'^[A-Za-z0-9_./:#@+\-]*$')


def h(s: str) -> str:
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:12]


def is_text(s: str) -> bool:
    """Strings that are written content (have whitespace or non-ASCII), not identifiers or paths."""
    return len(s) >= 4 and not s.startswith('/') and bool(_TEXTY.search(s)) and not _IDENT.match(s)


# --- sources ------------------------------------------------------------------------------------------------

# The MasterData files are AES-256-CBC encrypted (IV = first 16 bytes, PKCS7). No key is stored here: the game
# keeps it as a base64 string literal in its IL2CPP metadata, so every literal that decodes to an AES key is tried
# on one of the player's own MasterData files and the one that yields readable data wins (like catalog.py).

class MasterDataKeyError(RuntimeError):
    pass


def _aes_cbc(key: bytes, b: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    d = Cipher(algorithms.AES(key), modes.CBC(b[:16])).decryptor()
    p = d.update(b[16:]) + d.finalize()
    u = PKCS7(128).unpadder()
    return u.update(p) + u.finalize()


def _decode(raw: bytes):
    import lz4.frame
    import msgpack
    for f in (lambda r: msgpack.unpackb(lz4.frame.decompress(r), raw=False, strict_map_key=False),
              lambda r: json.loads(gzip.decompress(r)), lambda r: json.loads(r)):
        try:
            return f(raw)
        except Exception:
            pass
    return None


def key_candidates(literals: Iterable[bytes]) -> Iterator[bytes]:
    """AES-128/192/256 keys spelled as base64 (or hex) string literals, each once, in metadata order."""
    seen = set()
    for s in literals:
        k = None
        if len(s) in (24, 32, 44):
            try:
                k = base64.b64decode(s, validate=True)
            except (binascii.Error, ValueError):
                k = None
        if k is None and len(s) in (32, 48, 64) and re.fullmatch(rb'[0-9A-Fa-f]+', s):
            k = bytes.fromhex(s.decode('ascii'))
        if k is not None and len(k) in (16, 24, 32) and k not in seen:
            seen.add(k)
            yield k


def _samples(md_dir: Path, n: int = 3) -> list[bytes]:
    sized = sorted((p.stat().st_size, p.as_posix(), p) for p in Path(md_dir).rglob('*') if p.is_file() and p.name != 'index.json')
    return [p.read_bytes() for size, _, p in sized if size >= 32][:n]


def find_masterdata_key(md_dir: Path, metadata: Path | None = None) -> bytes:
    """The MasterData key, found among the string literals of the player's own global-metadata.dat."""
    from .catalog import il2cpp_literals
    md_dir = Path(md_dir)
    metadata = Path(metadata) if metadata else md_dir.parents[1] / 'il2cpp_data' / 'Metadata' / 'global-metadata.dat'
    if not metadata.is_file():
        raise MasterDataKeyError(f"The game's IL2CPP metadata was not found ({metadata}); it is needed to read MasterData. "
                                 'Check that the game folder is complete (verify the game files in Steam).')
    samples = _samples(md_dir)
    if not samples:
        raise MasterDataKeyError(f'No MasterData files found in {md_dir}.')
    for key in key_candidates(il2cpp_literals(metadata.read_bytes())):
        try:
            if all(_decode(_aes_cbc(key, b)) is not None for b in samples):
                return key
        except ValueError:  # bad padding: wrong key
            continue
    raise MasterDataKeyError("Could not find the MasterData key in this game build's IL2CPP metadata "
                             f"({metadata}). The game's data format may have changed; please report it with your game version.")


def _strings(v) -> Iterator[str]:
    stack = [v]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            yield v
        elif isinstance(v, dict):
            for k, x in v.items():
                if isinstance(k, str):
                    yield k
                stack.append(x)
        elif isinstance(v, (list, tuple)):
            stack.extend(v)


def masterdata_strings(md_dir: Path, key: bytes | None = None) -> Iterator[str]:
    """Every string in the game's encrypted MasterData (all catalogs, tables and language files)."""
    key = key or find_masterdata_key(md_dir)
    for p in sorted(Path(md_dir).rglob('*')):
        if not p.is_file() or p.name == 'index.json':
            continue
        try:
            raw = _aes_cbc(key, p.read_bytes())
        except Exception:
            continue
        obj = _decode(raw)
        if obj is not None:
            yield from _strings(obj)


def textasset_strings(bundle_paths: Iterable[Path]) -> Iterator[str]:
    import UnityPy
    for bp in bundle_paths:
        try:
            env = UnityPy.load(str(bp))
        except Exception:
            continue
        for o in env.objects:
            if o.type.name == 'MonoBehaviour':
                try:
                    yield from (x for x in _strings(o.read_typetree()) if len(x) >= 4)
                except Exception:
                    pass
                continue
            if o.type.name != 'TextAsset':
                continue
            try:
                s = o.read().m_Script
            except Exception:
                continue
            if isinstance(s, bytes):
                s = s.decode('utf-8', 'replace')
            yield s


_LUA_STR = re.compile(r'"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'', re.S)
_LUA_ESC = re.compile(r'\\(x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|\d{1,3}|.)', re.S)
_SIMPLE = {'n': '\n', 't': '\t', 'r': '\r', 'a': '\a', 'b': '\b', 'f': '\f', 'v': '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n'}


def _lua_unescape(s: str) -> str:
    def rep(m):
        e = m.group(1)
        if e[0] == 'x':
            return chr(int(e[1:], 16))
        if e[0] == 'u':
            return chr(int(e[2:-1], 16))
        if e[0].isdigit():
            return chr(int(e))
        return _SIMPLE.get(e, e)
    return _LUA_ESC.sub(rep, s)


def lua_literals(text: str) -> Iterator[str]:
    """Decoded string literals of a Lua source (dialogue lines are written as Lua strings)."""
    for m in _LUA_STR.finditer(text):
        s = m.group(1) if m.group(1) is not None else m.group(2)
        if '\\' in s:
            s = _lua_unescape(s)
        if len(s) >= 4:
            yield s


# --- rehydrate ----------------------------------------------------------------------------------------------

def needed_hashes(template) -> set[str]:
    out = set()
    for s in _strings(template):
        if s.startswith(MARK + 'H'):
            out.add(s[2:])
        elif s.startswith(MARK + 'C'):
            for seg in json.loads(s[2:]):
                if isinstance(seg, list):
                    out.add(seg[0])
    return out


# Strings that exist only in MasterData files a Steam update has since pruned cannot be rebuilt (the text is not
# in this repository, by design). Instead of an empty string, names and titles fall back to the row's id; longer
# texts and grouping labels stay empty (the explorer drops empty parts when it joins labels).
LABEL_KEYS = frozenset(('name', 'title', 'fullName', 'label', 'costume'))
ID_KEYS = ('id', 'key', 'characterId', 'costumeId', 'enemyId', 'questcharacter', 'episodeId', 'reward')
_GLUE = ' ·›;:/|\n'
_LEAD_GLUE = re.compile(r'^(?:\s*[·›;:/|]\s*|\n)+')


def fallback_label(key, parent) -> str:
    if key in LABEL_KEYS and isinstance(parent, dict):
        for k in ID_KEYS:
            v = parent.get(k)
            if v not in (None, '') and not (isinstance(v, str) and v.startswith(MARK)):
                return f'#{v}'
        if 'effects' in parent and 'attack' in parent:  # battle skills carry no id of their own
            return 'Skill'
    return ''


class Rehydrator:
    def __init__(self, pool: dict[str, str]):
        self.pool = pool
        self.missing: set[str] = set()   # distinct hashes that were not found
        self.blank = 0                   # string instances that got a fallback

    def text(self, s: str, key=None, parent=None) -> str:
        if not s.startswith(MARK):
            return s
        if s[1] == 'H':
            v = self.pool.get(s[2:])
            if v is None:
                self.missing.add(s[2:])
                self.blank += 1
                return fallback_label(key, parent)
            return v
        out: list[str] = []
        gap = partial = False   # partial: a segment was missing; gap: the next literal's leading separator goes too
        for seg in json.loads(s[2:]):
            if isinstance(seg, str):
                out.append(_LEAD_GLUE.sub('', seg) if gap else seg)
                gap = False
                continue
            v = self.pool.get(seg[0])
            if v is None:
                self.missing.add(seg[0])
                gap = partial = True
                continue
            out.append(v[seg[1]:seg[1] + seg[2]])
            gap = False
        r = ''.join(out)
        if not partial:
            return r
        r = r.strip(_GLUE + ' ')
        if not r:
            self.blank += 1
            return fallback_label(key, parent)
        return r

    def __call__(self, v, key=None, parent=None):
        if isinstance(v, str):
            return self.text(v, key, parent)
        if isinstance(v, dict):
            return {self.text(k) if isinstance(k, str) else k: self(x, k, v) for k, x in v.items()}
        if isinstance(v, list):
            return [self(x, key, parent) for x in v]
        return v
