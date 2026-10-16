"""The FINAL FANTASY VII FOREVER CRISIS logo and icons, rebuilt from the player's own game.

The explorer's title screen, favicon and app icons are composed from EVER CRISIS's title-logo sprites
(FF7EC_Data/data.unity3d -> sharedassets6.assets, img_title_*; the Title_FF7EC scene places them at 100 px per unit).
They are Square Enix artwork, so the release ships only this recipe and every install builds <root>/brand/* itself;
only local mode shows them (the hosted site uses a text title and its own icons).
The maintainers' reference build is GIMP (the explorer's brand/gimp/*.py); this is the same recipe in numpy/Pillow:

* FINAL FANTASY VII, the TM, the Buster Sword and the water streak: the original sprites at their scene positions.
* FOREVER CRISIS: EC's layered subtitle letters, gradient fill (sub_1), white edge (sub_2), black outline (sub_3).
  F = E without its lower arm plus E's foot serif mirrored to the right of the stem; O = the left half of C mirrored
  about its counter's centre line. Their edge and outline are regrown from the new fill: 2 px round, 6 px square (F)
  or round (O).
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

FILES = ['logo.png', 'logo-wide.png', 'favicon.ico', 'favicon-32.png', 'icon-192.png', 'icon-512.png',
         'apple-touch-icon.png', 'mark-sword.png', 'mark-fc.png']
NAVY = ('#0a1018', '#1f3444')  # icon tile gradient, top -> bottom

DISK2 = [(x, y) for x in range(-2, 3) for y in range(-2, 3) if x * x + y * y <= 5]
SQ6 = [(x, y) for x in range(-6, 7) for y in range(-6, 7)]
DISK6 = [(x, y) for x in range(-6, 7) for y in range(-6, 7) if x * x + y * y <= 39]
# ink columns of each 64 px subtitle cell (left, right)
INK = {'e': (12, 50), 'v': (8, 55), 'r': (10, 53), 'c': (14, 51), 'i': (18, 45), 's': (14, 50), 'f': (12, 50), 'o': (14, 51)}
# FINAL FANTASY VII letters and their scene x (centre) in the Title_FF7EC scene
FF = [('f', -402.5), ('i', -339.7), ('n', -271.8), ('a', -200.8), ('l', -130.6), ('f', -30.5), ('a', 37.0),
      ('n', 112.2), ('t', 190.2), ('a', 257.3), ('s', 327.2), ('y', 396.2), ('7', 513.1)]


# --- sprites -------------------------------------------------------------------------------------------------------
def needed() -> set[str]:
    names = {'logo_bg', 'logo_finalfantasy7_tm1'} | {'logo_finalfantasy7_' + c for c, _ in FF}
    for c in 'evrcis':
        names |= {f'sub_{k}_evercrisis_{c}' for k in (1, 2, 3)}
    return {'img_title_' + n for n in names}


def load_sprites(data_unity3d: Path) -> dict[str, Image.Image]:
    """img_title_* sprites from FF7EC_Data/data.unity3d (names without the img_title_ prefix)."""
    import UnityPy
    env = UnityPy.load(Path(data_unity3d).read_bytes())  # from memory: no handle stays open on the game folder
    want, out = needed(), {}
    for obj in env.objects:
        if obj.type.name != 'Sprite' or obj.assets_file.name != 'sharedassets6.assets':
            continue
        s = obj.read()
        name = getattr(s, 'm_Name', None) or getattr(s, 'name', '')
        if name in want:
            out[name[len('img_title_'):]] = s.image.convert('RGBA')
    missing = sorted(n for n in want if n[len('img_title_'):] not in out)
    if missing:
        raise RuntimeError(f'title sprites not found in {data_unity3d}: {", ".join(missing)}')
    return out


def load_sprite_dir(d: Path) -> dict[str, Image.Image]:
    """Same from a folder of img_title_*.png (the explorer's brand/work/scene_sprites)."""
    return {n[len('img_title_'):]: Image.open(Path(d) / f'{n}.png').convert('RGBA') for n in needed()}


# --- layers --------------------------------------------------------------------------------------------------------
class Layer:
    """Straight-alpha RGBA pixels (float 0..255) at an offset, like a GIMP layer."""

    def __init__(self, px: np.ndarray, x: int = 0, y: int = 0):
        self.px, self.x, self.y = px.astype(np.float32), int(x), int(y)

    @classmethod
    def of(cls, img: Image.Image, x=0, y=0):
        return cls(np.asarray(img.convert('RGBA')), x, y)

    @property
    def w(self):
        return self.px.shape[1]

    @property
    def h(self):
        return self.px.shape[0]

    def copy(self):
        return Layer(self.px.copy(), self.x, self.y)

    def image(self) -> Image.Image:
        return Image.fromarray(np.clip(np.rint(self.px), 0, 255).astype(np.uint8), 'RGBA')

    def at(self, x, y):
        self.x, self.y = int(x), int(y)
        return self

    def scaled(self, w, h):
        return Layer.of(resize(self.image(), w, h), self.x, self.y)

    def crop(self, x0, y0, w, h):
        """Keep the layer-local rect (GIMP layer resize); the layer offset follows."""
        out = np.zeros((h, w, 4), np.float32)
        sx0, sy0, sx1, sy1 = max(0, x0), max(0, y0), min(self.w, x0 + w), min(self.h, y0 + h)
        if sx1 > sx0 and sy1 > sy0:
            out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = self.px[sy0:sy1, sx0:sx1]
        return Layer(out, self.x + x0, self.y + y0)

    def clear(self, x, y, w, h, keep=False):
        """Make an image-space rect transparent (keep=True: everything outside it)."""
        m = np.zeros(self.px.shape[:2], bool)
        x0, y0 = max(0, x - self.x), max(0, y - self.y)
        m[y0:max(0, y + h - self.y), x0:max(0, x + w - self.x)] = True
        self.px[~m if keep else m] = 0
        return self

    def flip_x(self, axis: float):
        """Mirror horizontally about the image-space line x = axis."""
        self.px = self.px[:, ::-1].copy()
        self.x = int(round(2 * axis - self.x - self.w))
        return self


def over(top: Layer, bottom: Layer) -> Layer:
    """Merge top onto bottom, growing to the union of both (GIMP merge down, expand as necessary)."""
    x0, y0 = min(top.x, bottom.x), min(top.y, bottom.y)
    x1, y1 = max(top.x + top.w, bottom.x + bottom.w), max(top.y + top.h, bottom.y + bottom.h)
    c = Canvas(x1 - x0, y1 - y0)
    c.put(bottom.copy().at(bottom.x - x0, bottom.y - y0))
    c.put(top.copy().at(top.x - x0, top.y - y0))
    return Layer(c.px, x0, y0)


def grown(src: Layer, offsets, color, bounds=None) -> Layer:
    """Morphological dilation of src's alpha in src's own bounds (and the image's), filled with color.

    Matches GIMP's union of shifted alpha selections: the selection adds up (clamped), and filling through it
    reads the 8-bit mask as sRGB-encoded coverage."""
    a = src.px[..., 3]
    h, w = a.shape
    sel = np.zeros_like(a)
    for dx, dy in offsets:
        ys, yd = (slice(0, h - dy), slice(dy, h)) if dy >= 0 else (slice(-dy, h), slice(0, h + dy))
        xs, xd = (slice(0, w - dx), slice(dx, w)) if dx >= 0 else (slice(-dx, w), slice(0, w + dx))
        sel[yd, xd] += a[ys, xs]
    if bounds:
        bw, bh = bounds
        m = np.zeros_like(sel)
        m[max(0, -src.y):max(0, bh - src.y), max(0, -src.x):max(0, bw - src.x)] = 1
        sel *= m
    px = np.empty_like(src.px)
    px[..., :3] = rgb(color)
    px[..., 3] = np.rint(to_linear(np.minimum(sel, 255)) * 255)
    return Layer(px, src.x, src.y)


class Canvas:
    """Image being composed; layers are put bottom to top."""

    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = np.zeros((h, w, 4), np.float32)

    def put(self, l: Layer):
        x0, y0, x1, y1 = max(0, l.x), max(0, l.y), min(self.w, l.x + l.w), min(self.h, l.y + l.h)
        if x1 <= x0 or y1 <= y0:
            return self
        src = l.px[y0 - l.y:y1 - l.y, x0 - l.x:x1 - l.x]
        dst = self.px[y0:y1, x0:x1]
        sa, da = src[..., 3:] / 255, dst[..., 3:] / 255
        oa = sa + da * (1 - sa)
        rgb_ = (to_linear(src[..., :3]) * sa + to_linear(dst[..., :3]) * da * (1 - sa)) / np.maximum(oa, 1e-9)
        dst[..., :3], dst[..., 3:] = np.where(oa > 0, to_srgb(rgb_), 0), oa * 255  # GIMP 3 blends in linear light
        return self

    def puts(self, layers):
        for l in layers:
            self.put(l)
        return self

    def layer(self) -> Layer:
        return Layer(np.rint(self.px), 0, 0)

    def image(self) -> Image.Image:
        return self.layer().image()


def rgb(c: str):
    c = c.lstrip('#')
    return [int(c[i:i + 2], 16) for i in (0, 2, 4)]


def to_linear(v):
    v = np.asarray(v, np.float32) / 255
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def to_srgb(v):
    v = np.clip(v, 0, 1)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055) * 255


def resize(img: Image.Image, w, h) -> Image.Image:
    """Scale like GIMP's NoHalo: in linear light with premultiplied alpha. From half size up it interpolates with a
    locally bounded cubic (no halos); below that it averages over a one-output-pixel radial footprint."""
    w, h = int(w), int(h)
    px = np.asarray(img.convert('RGBA'), np.float32)
    a = px[..., 3:] / 255
    c = np.concatenate([to_linear(px[..., :3]) * a, a], -1)
    if w >= px.shape[1] / 2 and h >= px.shape[0] / 2:
        out = _lbb_axis(_lbb_axis(c, w, 1), h, 0)
    else:
        out = _ewa(c, w, h)
    oa = np.clip(out[..., 3:], 0, 1)
    rgb_ = to_srgb(np.where(oa > 0, np.clip(out[..., :3], 0, None) / np.maximum(oa, 1e-9), 0))
    return Image.fromarray(np.clip(np.rint(np.concatenate([rgb_, oa * 255], -1)), 0, 255).astype(np.uint8), 'RGBA')


def _lbb_axis(c, n, axis):
    """Cubic Hermite along one axis with slopes limited to 3x the smaller neighbouring difference (monotone)."""
    size = c.shape[axis]
    u = (np.arange(n) + 0.5) * size / n - 0.5
    i0 = np.floor(u).astype(int)
    p = [np.take(c, np.clip(i0 + o, 0, size - 1), axis=axis) for o in (-1, 0, 1, 2)]
    shape = [1] * c.ndim
    shape[axis] = n
    t = (u - i0).reshape(shape).astype(np.float32)

    def slope(l, r):
        m = (l + r) / 2
        return np.where(l * r > 0, np.sign(m) * np.minimum(np.abs(m), 3 * np.minimum(np.abs(l), np.abs(r))), 0)
    m1, m2 = slope(p[1] - p[0], p[2] - p[1]), slope(p[2] - p[1], p[3] - p[2])
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * p[1] + (t3 - 2 * t2 + t) * m1 + (3 * t2 - 2 * t3) * p[2] + (t3 - t2) * m2


def _ewa(c, w, h, radius=0.96):
    """Elliptical weighted average: a radial tent `radius` output pixels wide around each output pixel."""
    H, W = c.shape[:2]
    sx, sy = w / W, h / H
    u, v = (np.arange(w) + 0.5) / sx - 0.5, (np.arange(h) + 0.5) / sy - 0.5
    iu, iv = np.floor(u).astype(int), np.floor(v).astype(int)
    kx, ky = int(np.ceil(radius / sx)) + 1, int(np.ceil(radius / sy)) + 1
    acc, wsum = np.zeros((h, w, 4), np.float64), np.zeros((h, w), np.float64)
    for oy in range(-ky, ky + 1):
        j = iv + oy
        dy = ((j - v) * sy)[:, None]
        jok = ((j >= 0) & (j < H))[:, None]
        rows = c[np.clip(j, 0, H - 1)]
        for ox in range(-kx, kx + 1):
            i = iu + ox
            dx = ((i - u) * sx)[None, :]
            k = np.clip(1 - np.sqrt(dx * dx + dy * dy) / radius, 0, None) * jok * ((i >= 0) & (i < W))[None, :]
            acc += k[..., None] * rows[:, np.clip(i, 0, W - 1)]
            wsum += k
    return (acc / np.maximum(wsum, 1e-12)[..., None]).astype(np.float32)


# --- letters -------------------------------------------------------------------------------------------------------
def ec_letter(sp, c, ox, oy, bounds) -> list[Layer]:
    """One EVER CRISIS-style letter, bottom to top (outline, white edge, fill), its 64x96 cell at ox, oy."""
    if c == 'f':
        fill = Layer.of(sp['sub_1_evercrisis_e'], ox, oy)
        foot = fill.copy().clear(ox + 16, oy + 84, 5, 6, keep=True)  # E's left foot serif
        fill.clear(ox + 30, oy + 63, 34, 33)                          # lower arm
        fill.clear(ox + 40, oy + 59, 24, 4)                           # lower arm's top edge
        fill = over(foot.flip_x(ox + 25.5), fill)                     # stem x 21..29
        return [grown(fill, SQ6, '#000000', bounds), grown(fill, DISK2, '#ffffff', bounds), fill]
    if c == 'o':
        fill = Layer.of(sp['sub_1_evercrisis_c'], ox, oy)
        mir = fill.copy().flip_x(ox + 32.5)
        fill.clear(ox + 33, oy, 40, 96)
        mir.clear(ox - 8, oy, 41, 96)
        fill = over(mir, fill)
        return [grown(fill, DISK6, '#000000', bounds), grown(fill, DISK2, '#ffffff', bounds), fill]
    return [Layer.of(sp[f'sub_{k}_evercrisis_{c}'], ox, oy) for k in (3, 2, 1)]


def ec_word(sp, cells, bounds) -> list[Layer]:
    """Letters bottom to top; the first letter lies on top of its neighbours, as in the GIMP layer stack."""
    out = []
    for c, ox, oy in reversed(cells):
        out += ec_letter(sp, c, ox, oy, bounds)
    return out


def word_centres(word, left, right, word_gap):
    """Letter-cell centres so the ink spans left..right with equal gaps; the space is word_gap gaps wide."""
    letters = [c for c in word if c != ' ']
    ink = sum(INK[c][1] - INK[c][0] for c in letters)
    gap = (right - left - ink) / (len(letters) - 1 + word.count(' ') * (word_gap - 1))
    return word_centres_gap(word, left, gap, word_gap)[0]


def word_centres_gap(word, left, gap, word_gap):
    out, x = [], left
    for c in word:
        if c == ' ':
            x += gap * (word_gap - 1)
            continue
        if out:
            x += gap
        out.append((c, x - INK[c][0] + 32))
        x += INK[c][1] - INK[c][0]
    return out, x


# --- the pictures --------------------------------------------------------------------------------------------------
def logo(sp) -> Image.Image:
    """Main logo: EC title layout (scene px) with FOREVER CRISIS justified under FINAL FANTASY VII."""
    X0, Y0, W, H = -694, 546, 1408, 600

    def px(cx, cy, w, h):
        return int(round(cx - w / 2 - X0)), int(round(Y0 - cy - h / 2))
    c = Canvas(W, H)
    c.put(Layer.of(sp['logo_bg']).scaled(1408, 563).at(*px(10, 264, 1408, 563)))
    c.put(Layer.of(sp['logo_finalfantasy7_tm1']).scaled(29, 14).at(*px(434.2, 99.9, 29, 14)))
    for ch, cx in FF:
        l = Layer.of(sp['logo_finalfantasy7_' + ch])
        c.put(l.at(*px(cx, 184.7, l.w, l.h)))
    cells = [(ch, *px(cx, 17, 64, 96)) for ch, cx in word_centres('forever crisis', -433.0, 568.0, 1.9)]
    c.puts(ec_word(sp, cells, (W, H)))
    return c.image().crop((8, 15, 8 + 1390, 15 + 572))


def logo_wide(sp) -> Image.Image:
    """One-line header lockup: FINAL FANTASY VII + FOREVER CRISIS on one baseline, the water streak underneath."""
    SHIFT, TOP = 454.5, 14
    BASE = TOP + 186
    ec_left = 513.1 - 64 + 115 + SHIFT + 58  # after the VII
    cent, ec_right = word_centres_gap('forever crisis', ec_left, 20, 2.3)
    W, H = int(ec_right + 24), BASE + 66
    c = Canvas(W, H)
    bg = Layer.of(sp['logo_bg'])
    dot = bg.copy().clear(538, 390, 46, 24, keep=True)  # the baseline dot, sprite coordinates
    streak = bg.copy().clear(538, 390, 46, 24)
    c.put(streak.crop(300, 392, 980, 100).scaled(W - 10, 92).at(-10, BASE - 30))
    c.put(dot.crop(538, 390, 46, 24).scaled(51, 26).at(int(-78 + SHIFT - 24), BASE + 1 - 23))
    c.put(Layer.of(sp['logo_finalfantasy7_tm1']).scaled(29, 14).at(int(434.2 - 14.5 + SHIFT), int(TOP + 96 + (184.7 - 99.9) - 7)))
    for ch, cx in FF:
        l = Layer.of(sp['logo_finalfantasy7_' + ch])
        c.put(l.at(int(round(cx - l.w / 2 + SHIFT)), TOP))
    c.puts(ec_word(sp, [(ch, int(round(cx - 32)), BASE - 94) for ch, cx in cent], (W, H)))
    return c.image()


def gradient(w, h, top, bottom) -> np.ndarray:
    t = ((np.arange(h, dtype=np.float32) + 0.5) / h)[:, None, None]
    a, b = np.array(rgb(top), np.float32), np.array(rgb(bottom), np.float32)
    px = np.empty((h, w, 4), np.float32)
    px[..., :3] = a + (b - a) * t
    px[..., 3] = 255
    return px


def tile(size, rounded=0) -> Layer:
    """The navy icon tile: a top-to-bottom gradient, optionally with round corners of radius `rounded`."""
    px = gradient(size, size, *NAVY)
    if rounded:
        ss = 16  # coverage of the rounded rectangle, 16x16 samples per pixel
        y, x = (np.mgrid[0:size * ss, 0:size * ss] + 0.5) / ss
        cx, cy = np.clip(x, rounded, size - rounded), np.clip(y, rounded, size - rounded)
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= rounded * rounded
        px[..., 3] = np.rint(inside.reshape(size, ss, size, ss).mean((1, 3)) * 255)
    return Layer(px)


def sword(sp) -> Layer:
    """Buster Sword in the water, from the EC logo bg, on a 512 canvas (transparent)."""
    sw = Layer.of(sp['logo_bg']).crop(24, 18, 300, 460).at(0, 0)
    x = np.arange(300, dtype=np.float32) + 0.5
    fade = to_linear(255 * np.clip(1 - (x - 236) / 60, 0, 1))  # the streak fades out (a GIMP mask: sRGB-coded)
    sw.px[..., 3] = np.rint(sw.px[..., 3] * fade[None, :])
    s = 452 / 460.0
    sw = sw.scaled(int(300 * s), 452)
    return sw.at(int(256 - (62 + 232) / 2 * s), 30)


def fc(sp) -> Image.Image:
    """FC monogram in the logo lettering, 150x112."""
    cox = 6 + INK['f'][1] - 2 - INK['c'][0]  # outlines overlap by 2 px -> one silhouette
    return Canvas(150, 112).puts(ec_word(sp, [('f', 6, 8), ('c', cox, 8)], (150, 112))).image()


def icon_from(mark: Image.Image, size, pad, tiled=False, rounded=0) -> Image.Image:
    """The mark cropped to its ink and fitted into size x size with pad, optionally on the navy tile."""
    ink = mark.crop(mark.getchannel('A').getbbox())
    k = size * (1 - 2 * pad) / max(ink.size)
    ink = resize(ink, max(1, round(ink.width * k)), max(1, round(ink.height * k)))
    c = Canvas(size, size)
    if tiled:
        c.put(tile(size, rounded))
    c.put(Layer.of(ink, (size - ink.width) // 2, (size - ink.height) // 2))
    return c.image()


def build_images(sp) -> dict[str, Image.Image]:
    out = {'logo.png': logo(sp), 'logo-wide.png': logo_wide(sp)}
    sw = sword(sp)
    out['mark-sword.png'] = Canvas(512, 512).put(sw).image()
    icon = Canvas(512, 512).put(tile(512)).put(sw).image()
    out['icon-512.png'] = icon
    for n, s in (('icon-192.png', 192), ('apple-touch-icon.png', 180)):
        out[n] = resize(icon, s, s)
    mark = fc(sp)
    favs = {n: icon_from(mark, n, 0.12 if n > 32 else 0.04, True, max(2, n // 6)) for n in (48, 32, 16)}
    out['favicon-32.png'] = favs[32]
    out['favicon.ico'] = favs
    out['mark-fc.png'] = icon_from(mark, 256, 0.04)
    return out


def save(images: dict, dest: Path) -> list[Path]:
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    written = []
    for name, img in images.items():
        p = dest / name
        tmp = p.with_name(p.name + '.tmp')
        if name.endswith('.ico'):
            sizes = sorted(img, reverse=True)
            img[sizes[0]].save(tmp, format='ICO', sizes=[(s, s) for s in sizes], append_images=[img[s] for s in sizes[1:]])
        else:
            img.save(tmp, format='PNG', optimize=True)
        tmp.replace(p)
        written.append(p)
    return written


def build(data_unity3d: Path, dest: Path) -> list[Path]:
    return save(build_images(load_sprites(data_unity3d)), dest)
