#!/usr/bin/env python3
"""
The web app's PWA icons, generated from the brand mark rather than drawn by
hand — so they can be regenerated when the brand moves, and so a reviewer can
see WHERE they came from instead of finding four unexplained PNGs in a commit.

The mark is the one in views/app.html:
    .mark{border-radius:7px;background:linear-gradient(135deg,#38bdf8,#8b5cf6 55%,#34d399)}

Two shapes, for two different jobs:

  "any"       a rounded square, transparent outside the corners. This is shown
              as-is, so it has to carry its own shape.
  "maskable"  a full-bleed square. The platform clips it to whatever silhouette
              it likes — circle, squircle, rounded rect — and because a
              gradient has no detail to lose, every one of those crops still
              reads as the mark. That is why there is no safe-zone padding
              here: there is nothing to keep out of the corners.

Run: python3 scripts/make-app-icons.py
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")

# The three gradient stops, and where the middle one sits, straight from the CSS.
A, B, C = (0x38, 0xBD, 0xF8), (0x8B, 0x5C, 0xF6), (0x34, 0xD3, 0x99)
MID = 0.55


def lerp(c1, c2, t):
    return tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def gradient(size):
    """135deg in CSS runs top-left -> bottom-right, so the position along the
    gradient is (x + y) normalised over both axes."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = lerp(A, B, t / MID) if t <= MID else lerp(B, C, (t - MID) / (1 - MID))
    return img


def rounded(size, radius_ratio=7 / 22):
    """The CSS is a 7px radius on a 22px box; keep that proportion at any size."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=round(size * radius_ratio), fill=255
    )
    return mask


def write(name, size, mask=None):
    # No alpha channel unless the shape actually needs one. iOS composites
    # black behind any transparency it finds, so an opaque icon that merely
    # CARRIES an alpha channel is a trap waiting for a future edit.
    img = gradient(size).convert("RGBA") if mask is not None else gradient(size)
    if mask is not None:
        img.putalpha(mask)
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print(f"{name}  {size}x{size}  {os.path.getsize(path)} bytes")


if __name__ == "__main__":
    write("app-icon-192.png", 192, rounded(192))
    write("app-icon-512.png", 512, rounded(512))
    write("app-icon-maskable-512.png", 512)          # full bleed, platform crops it
    write("apple-touch-icon.png", 180)               # iOS applies its own squircle
