"""Logo/icon builder tests on synthetic sprites (no game files)."""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ffcx import brand  # noqa: E402

SIZES = {'logo_bg': (1280, 512), 'logo_finalfantasy7_7': (128, 192), 'logo_finalfantasy7_tm1': (64, 32)}


def fake_sprites():
    """Every sprite the builder reads, as an opaque block inside its cell (sizes as in the game)."""
    out = {}
    for n in brand.needed():
        n = n[len('img_title_'):]
        w, h = SIZES.get(n, (96, 192) if n.startswith('logo_') else (64, 96))
        px = np.zeros((h, w, 4), np.uint8)
        px[h // 8:-h // 8, w // 4:-w // 4] = (200, 120, 40, 255)
        out[n] = Image.fromarray(px, 'RGBA')
    return out


class Brand(unittest.TestCase):
    def test_grown_matches_gimp_selection_fill(self):
        # GIMP adds the shifted alpha selections up (clamped) and the fill reads the mask as sRGB-coded coverage
        px = np.zeros((5, 5, 4), np.float32)
        px[2, 2, 3] = 52
        g = brand.grown(brand.Layer(px), [(0, 0)], '#ffffff')
        self.assertEqual(g.px[2, 2, 3], 9)
        px[2, 3, 3] = 255
        g = brand.grown(brand.Layer(px), [(0, 0), (1, 0)], '#000000')
        self.assertEqual(g.px[2, 3, 3], 255)
        self.assertEqual(g.px[2, 4, 3], 255)
        self.assertEqual(g.px[0, 0, 3], 0)

    def test_resize_keeps_flat_colour(self):
        img = Image.new('RGBA', (40, 30), (31, 52, 68, 255))
        for w, h in ((44, 33), (90, 70), (12, 9), (5, 4)):
            out = np.asarray(brand.resize(img, w, h))
            self.assertEqual(out.shape, (h, w, 4))
            self.assertTrue((np.abs(out.astype(int) - (31, 52, 68, 255)) <= 1).all(), (w, h))

    def test_build_from_synthetic_sprites(self):
        imgs = brand.build_images(fake_sprites())
        self.assertEqual(set(imgs), set(brand.FILES))
        self.assertEqual(imgs['logo.png'].size, (1390, 572))
        self.assertEqual(imgs['logo-wide.png'].size, (1856, 266))
        self.assertEqual(imgs['icon-192.png'].size, (192, 192))
        self.assertEqual(imgs['apple-touch-icon.png'].size, (180, 180))
        self.assertEqual(imgs['mark-fc.png'].size, (256, 256))
        with tempfile.TemporaryDirectory() as d:
            written = brand.save(imgs, Path(d))
            self.assertEqual(sorted(p.name for p in written), sorted(brand.FILES))
            with Image.open(Path(d) / 'favicon.ico') as ico:
                self.assertEqual(sorted(ico.ico.sizes()), [(16, 16), (32, 32), (48, 48)])


if __name__ == '__main__':
    unittest.main()
