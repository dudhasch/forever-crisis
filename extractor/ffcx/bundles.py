"""Locate and decode the game's cached asset bundles and resources.

Bundles in octo/v1 are named by their catalog md5 and obfuscated with a name-derived XOR mask (port of
Utils/Xor.cs from shalzuth/ff7ecapi, MIT). Decoded output is a standard UnityFS file.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import threading
from pathlib import Path

import numpy as np

HEX32 = re.compile(r'^[0-9a-f]{32}$')


def bundle_key(name: str) -> bytes:
    mask = bytearray(len(name) * 2)
    for i, ch in enumerate(name):
        mask[i * 2] = ord(ch) & 255
        mask[-1 - i * 2] = ord(ch) & 255
    state = 0xAB
    for v in mask:
        state = (((state & 1) << 7) | (state >> 1)) ^ v
    return bytes(v ^ state for v in mask)


def index_octo(game: Path) -> dict[str, str]:
    """catalog md5 -> cached file path."""
    out: dict[str, str] = {}
    for folder, _, names in os.walk(Path(game) / 'octo' / 'v1'):
        for n in names:
            if HEX32.match(n):
                out.setdefault(n, os.path.join(folder, n))
    return out


class Store:
    """Decodes bundles/resources from the game into a staging tree laid out like the archive
    (<work>/02-DecodedBundles/<name>, <work>/01-Resources/<name>), on demand and thread-safe."""

    def __init__(self, catalog: dict, octo: dict[str, str], work: Path):
        self.work = Path(work)
        self.bundles = {b['name']: b for b in catalog['bundles']}
        self.by_id = {b['id']: b for b in catalog['bundles'] if 'id' in b}
        self.resources = {Path(r['name']).name: r for r in catalog['resources']}
        self.octo = octo
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self.decoded_bytes = 0

    def bundle_path(self, name: str) -> Path:
        return self.work / '02-DecodedBundles' / name

    def resource_path(self, name: str) -> Path:
        return self.work / '01-Resources' / name

    def _lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def has_bundle(self, name: str) -> bool:
        item = self.bundles.get(name)
        return bool(item) and item['md5'] in self.octo

    def ensure_bundle(self, name: str) -> Path:
        dest = self.bundle_path(name)
        item = self.bundles.get(name)
        if item is None:
            raise KeyError(f'not in catalog: {name}')
        if dest.exists() and dest.stat().st_size == item['size']:
            return dest
        with self._lock(name):
            if dest.exists() and dest.stat().st_size == item['size']:
                return dest
            src = self.octo.get(item['md5'])
            if not src:
                raise FileNotFoundError(f'bundle not downloaded by the game: {name}')
            key = np.frombuffer(bundle_key(name), dtype=np.uint8)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.partial')
            md5 = hashlib.md5()
            pos = 0
            with open(src, 'rb') as fi, open(tmp, 'wb') as fo:
                while raw := fi.read(8 << 20):
                    md5.update(raw)
                    a = np.frombuffer(raw, dtype=np.uint8)
                    out = np.bitwise_xor(a, key[(np.arange(len(a), dtype=np.int64) + pos) % len(key)])
                    if pos == 0:
                        out[0] = 0x55
                    fo.write(out.tobytes())
                    pos += len(raw)
            if md5.hexdigest() != item['md5']:
                tmp.unlink(missing_ok=True)
                raise ValueError(f'corrupt game file for {name} (md5 mismatch)')
            with open(tmp, 'rb') as f:
                if f.read(8) != b'UnityFS\x00':
                    tmp.unlink(missing_ok=True)
                    raise ValueError(f'not a Unity bundle after decoding: {name}')
            os.replace(tmp, dest)
            self.decoded_bytes += item['size']
            return dest

    def ensure_with_dependencies(self, name: str) -> list[str]:
        """The bundle plus its catalog dependency closure; returns names decoded."""
        todo, seen = [name], set()
        while todo:
            n = todo.pop()
            if n in seen or n not in self.bundles:
                continue
            seen.add(n)
            self.ensure_bundle(n)
            for dep in self.bundles[n].get('dependencies', []):
                d = self.by_id.get(dep)
                if d and d['name'] not in seen:
                    todo.append(d['name'])
        return sorted(seen)

    def ensure_resource(self, name: str) -> Path:
        dest = self.resource_path(name)
        item = self.resources.get(name)
        if item is None:
            raise KeyError(f'not in catalog: {name}')
        if dest.exists() and dest.stat().st_size == item['size']:
            return dest
        with self._lock('res:' + name):
            src = self.octo.get(item['md5'])
            if not src:
                raise FileNotFoundError(f'resource not downloaded by the game: {name}')
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_name(dest.name + '.partial')
            shutil.copyfile(src, tmp)
            os.replace(tmp, dest)
            return dest
