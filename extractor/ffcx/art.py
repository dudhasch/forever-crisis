"""Artwork for the installer, taken from the player's own game: the story logos, a few key-art backdrops and the
FOREVER CRISIS logo (drawn by brand.py from the game's title sprites).

Only a handful of small bundles are decoded (about 10 s), so the installer can show the game's own pictures while
it works. Nothing here is shipped with the release; the pictures are written into the install folder.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from PIL import Image, ImageOps

from . import brand, bundles, catalog

LOGOS = [f'sprites/story/logo/en/img_thumb_story_logo_{i:03d}.a' for i in range(1, 8)]
SCENES = [f'sprites/dungeon/background/img_dungeon_bg_{i:03d}.a' for i in (25, 11, 27, 4, 12, 28, 26, 15, 29)]
SCENE_SIZE = (960, 720)
BACKGROUND = (12, 12, 12)  # Windows Terminal's default; Sixel has no transparency


def _image(bundle: Path):
    import UnityPy
    env = UnityPy.load(bundle.read_bytes())  # from memory: no open handle keeps the work folder
    objs = [o for o in env.objects if o.type.name in ('Sprite', 'Texture2D')]
    objs.sort(key=lambda o: o.type.name != 'Sprite')  # a sprite is the cropped picture, the texture its atlas
    for o in objs:
        try:
            return o.read().image
        except Exception:
            continue
    return None


def _trim(img):
    """Backdrops sit on black bars inside a square texture; keep the picture."""
    box = img.convert('L').point(lambda v: 255 if v > 10 else 0).getbbox()
    return img.crop(box) if box else img


def hero(logo: Path, dest: Path):
    """The logo is black lettering for light backgrounds: put it on a light card for dark terminals."""
    lg = Image.open(logo).convert('RGBA')
    w = 1200
    lg = lg.resize((w - 120, round(lg.height * (w - 120) / lg.width)), Image.LANCZOS)
    h = lg.height + 100
    top, bottom = (246, 243, 236), (214, 208, 196)
    card = Image.new('RGBA', (w, h))
    for y in range(h):
        t = y / (h - 1)
        card.paste(tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,), (0, y, w, y + 1))
    card.alpha_composite(lg, (60, 50))
    card.convert('RGB').save(dest)


def build(game: Path, out: Path, cache_dir: Path, root: Path | None = None) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    res = {'logos': [], 'scenes': [], 'hero': None}
    if root is not None:  # the brand phase of the extraction, done early (3 s) so the installer can show the logo
        dest = Path(root) / 'brand'
        try:
            if not all((dest / f).exists() for f in brand.FILES):
                brand.build(Path(game) / 'FF7EC_Data' / 'data.unity3d', dest)
                done = Path(cache_dir) / 'done'
                done.mkdir(parents=True, exist_ok=True)
                with open(done / 'brand.txt', 'a', encoding='utf-8') as f:
                    f.write('all\n')  # pipeline.Run.mark_done: the brand phase is skipped later
            if not (out / 'hero.png').exists():
                hero(dest / 'logo.png', out / 'hero.png')
            res['hero'] = str(out / 'hero.png')
        except Exception:
            pass  # the installer shows the game's pictures without the logo
    cat = catalog.load(Path(game), cache_dir)
    store = bundles.Store(cat, bundles.index_octo(Path(game)), out / '.work')
    try:
        for kind, names in (('logos', LOGOS), ('scenes', SCENES)):
            for i, name in enumerate(names, 1):
                dest = out / (f'{kind[:-1]}-{i:02d}.' + ('jpg' if kind == 'scenes' else 'png'))
                if not dest.exists():
                    if not store.has_bundle(name):
                        continue
                    try:
                        img = _image(store.ensure_bundle(name))
                    except Exception:
                        img = None
                    if img is None:
                        continue
                    if kind == 'scenes':
                        img = ImageOps.fit(_trim(img.convert('RGB')), SCENE_SIZE)  # all the same size: no jumps in the slideshow
                    else:
                        flat = Image.new('RGBA', img.size, BACKGROUND + (255,))
                        img = Image.alpha_composite(flat, img.convert('RGBA')).convert('RGB')
                    if kind == 'scenes':
                        img.save(dest, quality=90)
                    else:
                        img.save(dest)
                res[kind].append(str(dest))
    finally:
        shutil.rmtree(out / '.work', ignore_errors=True)
    (out / 'art.json').write_text(json.dumps(res, indent=1), encoding='utf-8')
    return res
