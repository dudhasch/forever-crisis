"""Original artwork drawn by code (no game assets): spinning materia orbs for the installer, and the site icons.

    python release-tools/make_installer_art.py          -> installer/art/materia-<color>.gif (+ .png first frame)
    python release-tools/make_installer_art.py --icons  -> app/public/icons (favicon, touch and app icons)

The GIFs loop; the installer animates them with Sixel graphics where the terminal supports it
(Windows Terminal 1.22+) and shows the first frame as colored blocks elsewhere.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'installer' / 'art'
ICONS = ROOT / 'app' / 'public' / 'icons'
SIZE = 96          # pixels; the installer shows them about 12 cells wide
FRAMES = 24
BG = np.array([12, 12, 12], float)  # Windows Terminal's default background
COLORS = {         # (core, glow) per materia type
    'green': ((70, 235, 120), (20, 160, 70)),
    'blue': ((90, 170, 255), (30, 80, 210)),
    'red': ((255, 90, 80), (190, 30, 30)),
    'yellow': ((255, 220, 90), (200, 150, 20)),
    'purple': ((200, 120, 255), (120, 40, 200)),
}


def layers(t: float, core, glow, n: int = SIZE, radius: float = 0.36):
    """The orb's colour, the halo strength around it and the anti-aliased edge mask, each n x n."""
    y, x = np.mgrid[0:n, 0:n].astype(float)
    cx = cy = (n - 1) / 2
    R = n * radius
    u, v = (x - cx) / R, (y - cy) / R
    d2 = u * u + v * v
    inside = d2 <= 1
    z = np.sqrt(np.clip(1 - d2, 0, 1))
    core, glow = np.array(core, float), np.array(glow, float)

    # inside the orb: a slowly turning swirl of light (the sphere rotates around its vertical axis)
    a = 2 * math.pi * t
    ru = u * math.cos(a) + z * math.sin(a)
    rz = -u * math.sin(a) + z * math.cos(a)
    lon = np.arctan2(ru, rz)  # longitude on the turning sphere, so the bands wrap all the way round
    swirl = (0.5 + 0.5 * np.sin(3 * lon + 5 * v)) ** 3
    heart = np.exp(-d2 / 0.22)  # light from deep inside, brightest in the middle
    inner = np.clip(0.1 + 0.8 * swirl * (0.4 + 0.6 * z) + 0.55 * heart, 0, 1.3)[..., None]
    col = glow * (1 - inner) + core * inner

    # lighting: soft key light from the upper left, rim darkening, a sharp highlight
    L = np.array([-0.5, -0.6, 0.62])
    L /= np.linalg.norm(L)
    diff = np.clip(u * L[0] + v * L[1] + z * L[2], 0, 1)
    col = col * (0.45 + 0.75 * diff)[..., None]
    col = col * (0.55 + 0.45 * z)[..., None]
    hx, hy = u + 0.38, v + 0.42
    spec = np.exp(-(hx * hx + hy * hy) / 0.018)
    col = col + 255 * spec[..., None] * 0.95
    col = np.clip(col, 0, 255)

    # outside: a pulsing halo
    pulse = 0.8 + 0.2 * math.sin(2 * math.pi * t * 2)
    dist = np.sqrt(d2)
    halo = np.clip(np.exp(-((dist - 1) / 0.32) ** 2) * pulse * 0.75, 0, 1)[..., None]

    # anti-aliased edge
    edge = np.clip((1 - dist) * R, 0, 1)[..., None]
    return col, halo, edge, inside


def frame(t: float, core, glow) -> Image.Image:
    col, halo, edge, inside = layers(t, core, glow)
    outside = BG * (1 - halo) + np.array(glow, float) * halo
    img = outside * (1 - edge) + col * edge
    img = np.where(inside[..., None] | (edge > 0), img, outside)
    return Image.fromarray(img.astype(np.uint8), 'RGB')


# --- site icons: the green orb on a transparent background (favicons, "any" app icons) or on the site's
# dark tile (apple-touch-icon, maskable icon with the orb inside the 80 % safe zone)
ICON_COLOR = 'green'
TILE = (10, 16, 24)  # theme_color #0a1018


def orb(size: int, scale: float = 1.0, tile=None) -> Image.Image:
    """The orb drawn at 4x and reduced to size x size; scale < 1 leaves more margin."""
    core, glow = COLORS[ICON_COLOR]
    n = size * 4
    col, halo, edge, _ = layers(0.0, core, glow, n, 0.36 * scale)
    y, x = np.mgrid[0:n, 0:n].astype(float)
    border = np.minimum(np.minimum(x, n - 1 - x), np.minimum(y, n - 1 - y))
    halo = halo * np.clip(border / (0.12 * n), 0, 1)[..., None]  # the glow fades out before the icon's edge
    glow = np.array(glow, float)
    a = np.clip(edge + halo * (1 - edge), 0, 1)
    rgb = (col * edge + glow * halo * (1 - edge)) / np.maximum(a, 1e-6)
    rgba = np.concatenate([np.clip(rgb, 0, 255), a * 255], axis=2).astype(np.uint8)
    im = Image.new('RGBA', (n, n), (*TILE, 255) if tile else (0, 0, 0, 0))
    im.alpha_composite(Image.fromarray(rgba, 'RGBA'))
    return im.resize((size, size), Image.LANCZOS)


def icons():
    ICONS.mkdir(parents=True, exist_ok=True)
    files = {
        'favicon-32.png': orb(32, 1.15),
        'icon-192.png': orb(192),
        'icon-512.png': orb(512),
        'apple-touch-icon.png': orb(180, 0.9, tile=True).convert('RGB'),
        'icon-maskable-512.png': orb(512, 0.62, tile=True).convert('RGB'),
    }
    for name, im in files.items():
        im.save(ICONS / name, optimize=True)
    orb(48, 1.15).save(ICONS / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
    for f in sorted(ICONS.iterdir()):
        print(f.name, f.stat().st_size)


def main():
    if '--icons' in sys.argv[1:]:
        return icons()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (core, glow) in COLORS.items():
        frames = [frame(i / FRAMES, core, glow) for i in range(FRAMES)]
        frames[0].save(OUT / f'materia-{name}.png')
        frames[0].save(OUT / f'materia-{name}.gif', save_all=True, append_images=frames[1:], duration=70, loop=0,
                       optimize=True, disposal=1)
        print(name, (OUT / f'materia-{name}.gif').stat().st_size)


if __name__ == '__main__':
    main()
