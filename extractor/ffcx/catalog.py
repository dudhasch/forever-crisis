"""Decrypt the game's Octo asset catalog (octocacheevai).

Port of the method in shalzuth/ff7ecapi (MIT, see LICENSES/ff7ecapi.txt): the catalog is AES-CBC encrypted
(first byte is a format marker) with key = md5 of an application string. No key is stored here: as in the
maintainer's local extraction, every string literal in the player's own IL2CPP metadata is tried as the key and the
one that yields a valid catalog wins.
"""
from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from . import game as gamemod


def il2cpp_literals(metadata: bytes) -> list[bytes]:
    offset, count, data_offset, data_count = struct.unpack_from('<4I', metadata, 8)
    out = []
    for pos in range(offset, offset + count, 8):
        length, index = struct.unpack_from('<2I', metadata, pos)
        if index + length <= data_count:
            out.append(metadata[data_offset + index:data_offset + index + length])
    return out


# --- minimal protobuf reader for Octo.Proto.Database (Database.proto, proto2) -----------------------------

def _varint(b: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        c = b[i]
        i += 1
        result |= (c & 0x7F) << shift
        if not c & 0x80:
            return result, i
        shift += 7


def _fields(b: bytes):
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise ValueError(f'unsupported wire type {wt}')
        yield num, wt, v


def _data(b: bytes) -> dict:
    d: dict = {'dependencies': []}
    for num, wt, v in _fields(b):
        if num == 1:
            d['id'] = v
        elif num == 3:
            d['name'] = v.decode('utf-8')
        elif num == 4:
            d['size'] = v
        elif num == 9:
            if wt == 2:  # packed
                j = 0
                while j < len(v):
                    x, j = _varint(v, j)
                    d['dependencies'].append(x)
            else:
                d['dependencies'].append(v)
        elif num == 10:
            d['md5'] = v.decode('ascii')
    return d


def parse_database(payload: bytes) -> dict:
    db = {'revision': None, 'bundles': [], 'resources': []}
    for num, _, v in _fields(payload):
        if num == 1:
            db['revision'] = v
        elif num == 2:
            db['bundles'].append(_data(v))
        elif num == 4:
            db['resources'].append(_data(v))
    return db


def decrypt(encrypted: bytes, literals: list[bytes]) -> tuple[bytes, int]:
    body = encrypted[1:]
    seen = set()
    for index, s in enumerate(literals):
        if not (8 <= len(s) <= 64 and all(32 <= c < 127 for c in s)):
            continue
        key = hashlib.md5(s).digest()
        if key in seen:
            continue
        seen.add(key)
        head = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).decryptor().update(body[:128])
        if head[16] != 8:  # field 1 (revision), varint
            continue
        try:
            d = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).decryptor()
            plain = d.update(body) + d.finalize()
            u = PKCS7(128).unpadder()
            plain = u.update(plain) + u.finalize()
        except ValueError:
            continue
        payload = plain[16:]
        try:
            db = parse_database(payload)
        except Exception:
            continue
        if len(db['bundles']) > 100:
            return payload, index
    raise RuntimeError('Could not decrypt the asset catalog with any key from this game build.')


def load(game: Path, cache_dir: Path | None = None) -> dict:
    """Decrypted catalog as {'revision', 'bundles': [...], 'resources': [...]} (cached as JSON)."""
    game = Path(game)
    enc_path = gamemod.octo_cache(game)
    if enc_path is None:
        raise FileNotFoundError('octocacheevai not found')
    encrypted = enc_path.read_bytes()
    digest = hashlib.sha256(encrypted).hexdigest()
    cached = cache_dir / 'catalog.json' if cache_dir else None
    if cached and cached.exists():
        db = json.loads(cached.read_text(encoding='utf-8'))
        if db.get('source_sha256') == digest:
            return db
    metadata = (game / 'FF7EC_Data' / 'il2cpp_data' / 'Metadata' / 'global-metadata.dat').read_bytes()
    payload, _ = decrypt(encrypted, il2cpp_literals(metadata))
    db = parse_database(payload)
    db['source_sha256'] = digest
    if cached:
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(db), encoding='utf-8')
    return db
