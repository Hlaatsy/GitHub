#!/usr/bin/env python3
"""Render the AMAWELE app icon from its SVG master into the PNG export set.

Requires: cairosvg, pillow  ->  pip install cairosvg pillow
Usage:    python assets/brand/build_icons.py
"""
from pathlib import Path

import cairosvg
from PIL import Image

HERE = Path(__file__).resolve().parent
MASTER = HERE / "amawele-icon.svg"

# App Store needs 1024 flat; the rest cover common iOS/Android/web slots.
SIZES = (1024, 512, 256, 180, 120, 60)


def render(size: int) -> Path:
    out = HERE / f"amawele-icon-{size}.png"
    cairosvg.svg2png(
        url=str(MASTER), write_to=str(out), output_width=size, output_height=size
    )
    # App Store rejects icons with an alpha channel; the art is fully opaque.
    Image.open(out).convert("RGB").save(out)
    return out


def squircle_mask(size: int, exponent: float = 5.0, supersample: int = 4) -> Image.Image:
    """iOS-style rounded mask: a superellipse, not a rounded rectangle."""
    n = size * supersample
    mask = Image.new("L", (n, n), 0)
    px = mask.load()
    r = (n - 1) / 2.0
    for y in range(n):
        v = abs((y - r) / r) ** exponent
        if v > 1.0:
            continue
        # solve |u|^e + |v|^e = 1 for the row's half-width
        half = (1.0 - v) ** (1.0 / exponent) * r
        for x in range(int(r - half), int(r + half) + 1):
            px[x, y] = 255
    return mask.resize((size, size), Image.LANCZOS)


def render_rounded(size: int = 1024) -> Path:
    out = HERE / f"amawele-icon-rounded-{size}.png"
    tmp = HERE / ".tmp-rounded.png"
    cairosvg.svg2png(
        url=str(MASTER), write_to=str(tmp), output_width=size, output_height=size
    )
    img = Image.open(tmp).convert("RGBA")
    img.putalpha(squircle_mask(size))
    img.save(out)
    tmp.unlink()
    return out


if __name__ == "__main__":
    for s in SIZES:
        print("wrote", render(s).name)
    print("wrote", render_rounded().name)
