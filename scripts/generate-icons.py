#!/usr/bin/env python3
"""Draws the installed-app icons in public/icons from the same compass star as public/favicon.svg.

Run: python3 scripts/generate-icons.py   (requires Pillow)

- icon-192.png / icon-512.png: rounded tile on a transparent background (manifest purpose "any").
- icon-maskable-192.png / icon-maskable-512.png: full-bleed tile; the star sits inside the central
  80% safe zone that Android masks to a circle or squircle.
- apple-touch-icon.png: 180px full-bleed tile; iOS rounds the corners itself and needs no transparency.
- shortcut-daily.png / shortcut-board.png: 96px glyphs for the home-screen shortcuts.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / 'public' / 'icons'
TILE = (23, 56, 62)      # #17383e, as in favicon.svg
GOLD = (231, 182, 99)    # #e7b663
SCALE = 4                # Drawn large and shrunk, for smooth edges.

# favicon.svg geometry on a 64-unit grid.
STAR = [(32, 12), (37, 27), (52, 32), (37, 37), (32, 52), (27, 37), (12, 32), (27, 27)]


def tile(size, rounded, art_scale=1.0):
    big = size * SCALE
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = big / 64
    if rounded:
        draw.rounded_rectangle([0, 0, big - 1, big - 1], radius=14 * unit, fill=TILE)
    else:
        draw.rectangle([0, 0, big, big], fill=TILE)

    def point(x, y):
        return ((32 + (x - 32) * art_scale) * unit, (32 + (y - 32) * art_scale) * unit)

    radius = 22 * art_scale * unit
    centre = 32 * unit
    draw.ellipse([centre - radius, centre - radius, centre + radius, centre + radius],
                 outline=GOLD, width=max(1, round(2 * art_scale * unit)))
    draw.polygon([point(x, y) for x, y in STAR], fill=GOLD)
    return image.resize((size, size), Image.LANCZOS)


def shortcut(size, kind):
    big = size * SCALE
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    unit = big / 64
    draw.ellipse([0, 0, big - 1, big - 1], fill=TILE)
    if kind == 'daily':
        draw.polygon([((32 + (x - 32) * .8) * unit, (32 + (y - 32) * .8) * unit) for x, y in STAR], fill=GOLD)
    else:  # Leaderboard: three podium bars.
        for left, top in ((17, 30), (27, 20), (37, 36)):
            draw.rounded_rectangle([left * unit, top * unit, (left + 9) * unit, 46 * unit], radius=2 * unit, fill=GOLD)
    return image.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        tile(size, rounded=True).save(OUT / f'icon-{size}.png', optimize=True)
        # 0.86 keeps the ring's outer edge at 61% of the width, inside the 80% safe zone.
        tile(size, rounded=False, art_scale=0.86).convert('RGB').save(OUT / f'icon-maskable-{size}.png', optimize=True)
    tile(180, rounded=False, art_scale=0.92).convert('RGB').save(OUT / 'apple-touch-icon.png', optimize=True)
    shortcut(96, 'daily').save(OUT / 'shortcut-daily.png', optimize=True)
    shortcut(96, 'board').save(OUT / 'shortcut-board.png', optimize=True)
    print('Wrote', ', '.join(sorted(path.name for path in OUT.glob('*.png'))))


if __name__ == '__main__':
    main()
