"""Unit tests that need no game files (CI)."""
import base64
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ffcx import art, bundles, catalog, game, textpool  # noqa: E402


class BundleKey(unittest.TestCase):
    def test_xor_roundtrip(self):
        name = 'character/001/model/001.d'
        key = bundles.bundle_key(name)
        self.assertEqual(len(key), len(name) * 2)
        plain = b'UnityFS\x00' + bytes(range(200))
        enc = bytes(b ^ key[i % len(key)] for i, b in enumerate(plain))
        dec = bytes(b ^ key[i % len(key)] for i, b in enumerate(enc))
        self.assertEqual(dec, plain)


class Proto(unittest.TestCase):
    def test_parse_database(self):
        def varint(n):
            out = bytearray()
            while True:
                b = n & 0x7F
                n >>= 7
                out.append(b | (0x80 if n else 0))
                if not n:
                    return bytes(out)

        def field(num, wt, payload):
            return varint(num << 3 | wt) + (varint(len(payload)) + payload if wt == 2 else payload)
        data = field(1, 0, varint(7)) + field(3, 2, b'a/b.d') + field(4, 0, varint(1234)) + field(10, 2, b'0' * 32) + field(9, 2, varint(3) + varint(4))
        db = field(1, 0, varint(366)) + field(2, 2, data) + field(4, 2, data)
        p = catalog.parse_database(db)
        self.assertEqual(p['revision'], 366)
        self.assertEqual(p['bundles'][0], {'id': 7, 'name': 'a/b.d', 'size': 1234, 'md5': '0' * 32, 'dependencies': [3, 4]})
        self.assertEqual(len(p['resources']), 1)


class TextPool(unittest.TestCase):
    def test_is_text(self):
        self.assertTrue(textpool.is_text('Hello there'))
        self.assertTrue(textpool.is_text('クラウド'))
        self.assertFalse(textpool.is_text('dungeon_map_0001'))
        self.assertFalse(textpool.is_text('/arc/05-Music-FLAC/x.flac'))

    def test_lua_literals(self):
        src = r'''TXT_A = "There's light up ahead.\nThat must lead outside."
local b = 'Hi \"you\"' '''
        lits = list(textpool.lua_literals(src))
        self.assertIn("There's light up ahead.\nThat must lead outside.", lits)
        self.assertIn('Hi "you"', lits)

    def test_rehydrate(self):
        a, b = 'Mako Reactor 1', 'The Destruction of Mako Reactor 1'
        pool = {textpool.h(a): a, textpool.h(b): b}
        t = {'title': textpool.MARK + 'H' + textpool.h(a),
             'sub': textpool.MARK + 'C' + json.dumps([[textpool.h(b), 4, 11], ' · ', [textpool.h(a), 0, 4]]),
             textpool.MARK + 'H' + textpool.h(a): 1, 'n': 5}
        r = textpool.Rehydrator(pool)
        self.assertEqual(r(t), {'title': a, 'sub': 'Destruction · Mako', a: 1, 'n': 5})
        self.assertFalse(r.missing)
        r2 = textpool.Rehydrator({})
        self.assertEqual(r2({'x': textpool.MARK + 'H' + textpool.h(a)}), {'x': ''})
        self.assertEqual(len(r2.missing), 1)

    def test_rehydrate_fallbacks(self):
        M, h = textpool.MARK, textpool.h
        a, b = 'Mako Reactor 1', 'The Destruction of Mako Reactor 1'
        ref = lambda t: M + 'H' + h(t)  # noqa: E731
        comp = M + 'C' + json.dumps([[h(a), 0, 4], ' · Ch.9 · ', [h(b), 4, 11]])
        # names and titles fall back to the row id; other texts and grouping labels stay empty
        r = textpool.Rehydrator({})
        self.assertEqual(r({'id': '210153', 'title': ref(a), 'family': ref(a), 'text': ref(b)}),
                         {'id': '210153', 'title': '#210153', 'family': '', 'text': ''})
        self.assertEqual(r({'costumeId': 1005, 'costume': ref(a)}), {'costumeId': 1005, 'costume': '#1005'})
        self.assertEqual(r({'name': ref(a)}), {'name': ''})  # no id to show
        self.assertEqual(r({'name': ref(a), 'attack': 1, 'effects': []}), {'name': 'Skill', 'attack': 1, 'effects': []})
        # a composite with missing parts keeps the explorer's own wording and drops the dangling separators
        self.assertEqual(textpool.Rehydrator({})({'id': 7, 'title': comp}), {'id': 7, 'title': 'Ch.9'})
        self.assertEqual(textpool.Rehydrator({h(a): a})({'title': comp}), {'title': 'Mako · Ch.9'})
        self.assertEqual(textpool.Rehydrator({h(b): b})({'title': comp}), {'title': 'Ch.9 · Destruction'})
        self.assertEqual(textpool.Rehydrator({h(a): a, h(b): b})({'title': comp}), {'title': 'Mako · Ch.9 · Destruction'})
        # a composite with nothing left of the game's text falls back like a plain reference
        only = M + 'C' + json.dumps([[h(a), 0, 4]])
        self.assertEqual(textpool.Rehydrator({})({'id': 3, 'name': only}), {'id': 3, 'name': '#3'})


def fake_metadata(literals: list[bytes]) -> bytes:
    """A global-metadata.dat with only a string-literal table (header fields at offset 8, as il2cpp_literals reads)."""
    table, data = b'', b''
    for s in literals:
        table += struct.pack('<2I', len(s), len(data))
        data += s
    head = 24
    return bytes.fromhex('af1bb1fa') + struct.pack('<I', 29) + struct.pack('<4I', head, len(table), head + len(table), len(data)) + table + data


def encrypt_md(key: bytes, obj) -> bytes:
    import lz4.frame
    import msgpack
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    iv = os.urandom(16)
    pad = PKCS7(128).padder()
    plain = pad.update(lz4.frame.compress(msgpack.packb(obj))) + pad.finalize()
    e = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return iv + e.update(plain) + e.finalize()


class MasterDataKey(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.game = Path(self.tmp.name)
        self.md = self.game / 'FF7EC_Data' / 'StreamingAssets' / 'MasterData'
        (self.md / 'catalogs').mkdir(parents=True)
        self.meta = self.game / 'FF7EC_Data' / 'il2cpp_data' / 'Metadata' / 'global-metadata.dat'
        self.meta.parent.mkdir(parents=True)
        self.key = os.urandom(32)
        (self.md / 'index.json').write_text('{}')
        (self.md / 'catalogs' / 'a').write_bytes(encrypt_md(self.key, {'name': 'Cloud Strife', 'rows': ['Hello there']}))
        (self.md / 'catalogs' / 'b').write_bytes(encrypt_md(self.key, [{'title': 'Midgar'}]))

    def tearDown(self):
        self.tmp.cleanup()

    def write_meta(self, *literals):
        self.meta.write_bytes(fake_metadata([b'Assets/Scripts', os.urandom(32).hex().encode(), base64.b64encode(os.urandom(32)), *literals, b'tail']))

    def test_key_is_found_among_base64_literals(self):
        self.write_meta(base64.b64encode(self.key))
        self.assertEqual(textpool.find_masterdata_key(self.md), self.key)
        self.assertEqual(set(textpool.masterdata_strings(self.md)), {'name', 'Cloud Strife', 'rows', 'Hello there', 'title', 'Midgar'})

    def test_hex_literal_works_too(self):
        self.write_meta(self.key.hex().encode())
        self.assertEqual(textpool.find_masterdata_key(self.md), self.key)

    def test_clear_error_when_no_literal_fits(self):
        self.write_meta()
        with self.assertRaises(textpool.MasterDataKeyError) as e:
            textpool.find_masterdata_key(self.md)
        self.assertIn('Could not find the MasterData key', str(e.exception))

    def test_clear_error_without_metadata(self):
        with self.assertRaises(textpool.MasterDataKeyError) as e:
            list(textpool.masterdata_strings(self.md))
        self.assertIn('IL2CPP metadata was not found', str(e.exception))

    def test_candidates_skip_non_keys(self):
        lits = [b'not a key', base64.b64encode(b'x' * 20), b'AAAAAAAAAAAAAAAAAAAAAA==', b'AAAAAAAAAAAAAAAAAAAAAA==']
        self.assertEqual(list(textpool.key_candidates(lits)), [bytes(16)])


class Art(unittest.TestCase):
    def test_trim_drops_black_bars(self):
        from PIL import Image
        img = Image.new('RGB', (100, 100))
        img.paste((200, 120, 40), (0, 20, 100, 80))
        self.assertEqual(art._trim(img).size, (100, 60))


class Game(unittest.TestCase):
    def test_validate_reports_missing_exe(self):
        with tempfile.TemporaryDirectory() as d:
            v = game.validate(Path(d))
            self.assertFalse(v['ok'])
            self.assertIn('FF7EC.exe', v['reason'])

    def test_validate_missing_download(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / 'FF7EC.exe').write_bytes(b'')
            meta = p / 'FF7EC_Data' / 'il2cpp_data' / 'Metadata'
            meta.mkdir(parents=True)
            (meta / 'global-metadata.dat').write_bytes(b'')
            v = game.validate(p)
            self.assertFalse(v['ok'])
            self.assertIn('downloads about 50 GB', v['reason'])


class DataPack(unittest.TestCase):
    def test_env_overrides_and_missing_files_are_reported(self):
        from ffcx import pipeline
        old = os.environ.get('FFCX_DATA')
        try:
            with tempfile.TemporaryDirectory() as d:
                os.environ['FFCX_DATA'] = d
                self.assertEqual(pipeline.data_dir(), Path(d))
                with self.assertRaisesRegex(RuntimeError, 'data pack is missing'):
                    pipeline.check_data()
                for n in pipeline.DATA_FILES:
                    (Path(d) / n).write_bytes(b'x')
                self.assertEqual(pipeline.check_data(), Path(d))
        finally:
            if old is None:
                os.environ.pop('FFCX_DATA', None)
            else:
                os.environ['FFCX_DATA'] = old


class ResumeMarkers(unittest.TestCase):
    """Finished items are skipped on the next run only while the recipe expects the same outputs."""

    def run_for(self, out, ref):
        from ffcx import pipeline
        r = pipeline.Run.__new__(pipeline.Run)
        r.out = Path(out)
        r.recipe = {'reference_files': ref, 'effects': ['/gen/effects/index.json']}
        return r

    def test_stamp_follows_reference(self):
        item = {'bundle': 'scenes/environment_0001.s', 'out': ['/lib/unity/scenes/environment_0001/model.glb']}
        with tempfile.TemporaryDirectory() as d:
            v4 = self.run_for(d, {item['out'][0]: {'size': 10, 'sha256': 'aa'}})
            v5 = self.run_for(d, {item['out'][0]: {'size': 12, 'sha256': 'bb'}})
            s4, s5 = v4.stamp('glb', item), v5.stamp('glb', item)
            self.assertNotEqual(s4, s5)
            done = {f'glb:{item["bundle"]}#{s4}'}
            self.assertTrue(v4.is_done(done, 'glb', item['bundle'], s4, item))
            self.assertFalse(v5.is_done(done, 'glb', item['bundle'], s5, item))
            self.assertEqual(v4.outputs('effects', {'key': 'all'}), ['/gen/effects/index.json'])

    def test_marker_without_stamp(self):
        item = {'bundle': 'b.d', 'objects': [{'path_id': 1, 'out': '/arc/03-ExtractedAssets/b/Texture2D/t.png'}]}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'arc' / '03-ExtractedAssets' / 'b' / 'Texture2D' / 't.png'
            p.parent.mkdir(parents=True)
            p.write_bytes(b'12345')
            same = self.run_for(d, {item['objects'][0]['out']: {'size': 5}})
            grown = self.run_for(d, {item['objects'][0]['out']: {'size': 6}})
            self.assertTrue(same.is_done({'export:b.d'}, 'export', 'b.d', 'x', item))
            self.assertFalse(grown.is_done({'export:b.d'}, 'export', 'b.d', 'x', item))


if __name__ == '__main__':
    unittest.main()

