"""CAB name -> bundle map (how Unity cross-bundle pointers are resolved), read from UnityFS directory headers.

Port of the converters' pipeline/cab_index.py. For game files only the header and block-info bytes are
XOR-decoded, so all ~112k bundles are indexed without decoding them.
"""
from __future__ import annotations

import io
import json
import os
import struct
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import lz4.block
import numpy as np

from .bundles import bundle_key


def _cstr(b: bytes, i: int) -> tuple[str, int]:
    j = b.index(b'\x00', i)
    return b[i:j].decode('utf-8', 'replace'), j + 1


def _decode_range(raw: bytes, offset: int, key: np.ndarray) -> bytes:
    a = np.frombuffer(raw, dtype=np.uint8)
    out = np.bitwise_xor(a, key[(np.arange(len(a), dtype=np.int64) + offset) % len(key)])
    if offset == 0 and len(out):
        out[0] = 0x55
    return out.tobytes()


def cab_names(path: str, name: str | None) -> list[str]:
    """name=None: the file is already decoded UnityFS. name=catalog name: XOR-obfuscated game file."""
    key = np.frombuffer(bundle_key(name), dtype=np.uint8) if name else None
    size = os.path.getsize(path)
    with open(path, 'rb') as f:
        head = f.read(min(size, 512))
        if key is not None:
            head = _decode_range(head, 0, key)
        sig, i = _cstr(head, 0)
        if sig != 'UnityFS':
            raise ValueError('not UnityFS')
        ver = struct.unpack_from('>I', head, i)[0]
        i += 4
        _, i = _cstr(head, i)
        _, i = _cstr(head, i)
        total, compressed, raw_size, flags = struct.unpack_from('>qIII', head, i)
        i += 20
        if ver >= 7:
            i = (i + 15) & ~15
        pos = total - compressed if flags & 0x80 else i
        f.seek(pos)
        blk = f.read(compressed)
        if key is not None:
            blk = _decode_range(blk, pos, key)
    mode = flags & 0x3F
    if mode == 1:
        import lzma
        props, dict_size = blk[0], struct.unpack_from('<I', blk, 1)[0]
        lc, rem = props % 9, props // 9
        lp, pb = rem % 5, rem // 5
        filt = [{'id': lzma.FILTER_LZMA1, 'dict_size': dict_size, 'lc': lc, 'lp': lp, 'pb': pb}]
        blk = lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=filt).decompress(blk[5:], raw_size)
    elif mode in (2, 3):
        blk = lz4.block.decompress(blk, uncompressed_size=raw_size)
    elif mode != 0:
        raise ValueError('unsupported compression')
    q = io.BytesIO(blk)
    q.seek(16)
    nblocks = struct.unpack('>i', q.read(4))[0]
    q.seek(nblocks * 10, 1)
    out = []
    for _ in range(struct.unpack('>i', q.read(4))[0]):
        q.read(20)
        s = bytearray()
        while (c := q.read(1)) not in (b'\x00', b''):
            s += c
        out.append(s.decode('utf-8', 'replace'))
    return out


def build(items: list[tuple[str, str | None, str]], dest: Path, progress=None) -> dict:
    """items: (file path, catalog name or None if decoded, catalog name). Writes {cab: bundle} JSON."""
    index, errors = {}, 0

    def one(it):
        path, xor_name, name = it
        try:
            return name, cab_names(path, xor_name)
        except Exception:
            return name, None
    with ThreadPoolExecutor(16) as pool:
        for n, (name, cabs) in enumerate(pool.map(one, items), 1):
            if cabs is None:
                errors += 1
            else:
                for c in cabs:
                    index[c.lower()] = name
            if progress and n % 2000 == 0:
                progress(n, len(items))
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(index, separators=(',', ':')), encoding='utf-8')
    return {'entries': len(index), 'errors': errors}
