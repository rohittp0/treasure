"""Render the 1200×630 link-preview card from the game's country outlines."""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SCALE = 2
WIDTH, HEIGHT = 1200 * SCALE, 630 * SCALE


def available_font(*paths):
    return next((Path(path) for path in paths if Path(path).exists()), None)


GEORGIA = available_font('/System/Library/Fonts/Supplemental/Georgia Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf')
ARIAL = available_font('/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
ARIAL_BOLD = available_font('/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
if not all((GEORGIA, ARIAL, ARIAL_BOLD)):
    raise RuntimeError('Georgia/Arial or DejaVu fonts are required to render the preview.')


def pt(x, y):
    return round(x * SCALE), round(y * SCALE)


def font(path, size):
    return ImageFont.truetype(str(path), size * SCALE)


def text(draw, xy, label, path, size, color, **kwargs):
    draw.text(pt(*xy), label, font=font(path, size), fill=color, anchor='lt', **kwargs)


def fit_font(draw, label, path, max_size, max_width):
    for size in range(max_size, 39, -1):
        candidate = font(path, size)
        if draw.textlength(label, font=candidate) <= max_width * SCALE:
            return size
    raise ValueError(f'Text does not fit: {label}')


image = Image.new('RGBA', (WIDTH, HEIGHT), '#0c2c33')
glow = Image.new('RGBA', image.size)
ImageDraw.Draw(glow).ellipse((*pt(530, -250), *pt(1450, 760)), fill=(75, 138, 138, 155))
image = Image.alpha_composite(image, glow.filter(ImageFilter.GaussianBlur(145 * SCALE)))

grid = Image.new('RGBA', image.size)
grid_draw = ImageDraw.Draw(grid)
for y in range(115, 630, 120):
    grid_draw.line((*pt(0, y), *pt(1200, y)), fill=(185, 207, 197, 31), width=SCALE)
for x in range(150, 1200, 150):
    grid_draw.line((*pt(x, 0), *pt(x, 630)), fill=(185, 207, 197, 31), width=SCALE)
image = Image.alpha_composite(image, grid)

map_layer = Image.new('RGBA', image.size)
map_draw = ImageDraw.Draw(map_layer)
countries = json.loads((ROOT / 'public/countries.geojson').read_text())


def project(point):
    longitude, latitude = point
    return pt(380 + (longitude + 180) / 360 * 880, 65 + (90 - latitude) / 180 * 500)


for country in countries['features']:
    geometry = country['geometry']
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    for polygon in polygons:
        for ring in polygon:
            points = [project(point) for point in ring]
            if len(points) > 2:
                map_draw.polygon(points, fill=(224, 208, 172, 75))
                map_draw.line(points, fill=(239, 222, 180, 105), width=SCALE, joint='curve')
image.alpha_composite(map_layer.crop((*pt(680, 43), *pt(1175, 587))), pt(680, 43))

draw = ImageDraw.Draw(image)
route = [pt(742, 449), pt(782, 438), pt(828, 399), pt(864, 339), pt(929, 343), pt(982, 303), pt(1013, 251)]
for start, end in zip(route, route[1:]):
    length = max(abs(end[0] - start[0]), abs(end[1] - start[1]))
    for offset in range(0, length, 26 * SCALE):
        finish = min(offset + 12 * SCALE, length)
        a = (start[0] + (end[0] - start[0]) * offset / length, start[1] + (end[1] - start[1]) * offset / length)
        b = (start[0] + (end[0] - start[0]) * finish / length, start[1] + (end[1] - start[1]) * finish / length)
        draw.line((a, b), fill='#f0bf76', width=3 * SCALE)
draw.ellipse((*pt(960, 198), *pt(1066, 304)), fill=(8, 38, 44, 180))
draw.ellipse((*pt(978, 216), *pt(1048, 286)), fill='#c77947', outline='#f7d9a0', width=3 * SCALE)
draw.polygon([pt(1013, 226), pt(1020, 244), pt(1038, 251), pt(1020, 258),
              pt(1013, 276), pt(1006, 258), pt(988, 251), pt(1006, 244)], fill='#fff0c6')
draw.ellipse((*pt(770, 431), *pt(784, 445)), fill='#f2c980')

shadow = Image.new('RGBA', image.size)
ImageDraw.Draw(shadow).rounded_rectangle((*pt(53, 55), *pt(687, 581)), radius=18 * SCALE, fill=(0, 11, 13, 160))
image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(18 * SCALE)))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((*pt(53, 50), *pt(681, 576)), radius=13 * SCALE, fill='#f2e5c7', outline='#fff2d7', width=2 * SCALE)
draw.rounded_rectangle((*pt(66, 63), *pt(668, 563)), radius=8 * SCALE, outline='#c8ad7a', width=SCALE)

draw.ellipse((*pt(84, 87), *pt(132, 135)), outline='#b87d48', width=2 * SCALE)
draw.polygon([pt(108, 93), pt(112, 107), pt(126, 111), pt(112, 115),
              pt(108, 129), pt(104, 115), pt(90, 111), pt(104, 107)], fill='#b87d48')
brand = font(GEORGIA, 34)
draw.text(pt(146, 91), 'Treasure', font=brand, fill='#173b3e', anchor='lt')
brand_width = draw.textlength('Treasure', font=brand)
draw.text((pt(146, 91)[0] + brand_width, pt(146, 91)[1]), 'Hunch', font=brand, fill='#b87742', anchor='lt')
draw.line((*pt(94, 152), *pt(640, 152)), fill='#bca374', width=SCALE)
text(draw, (94, 182), 'THE WORLD IS YOUR MAP', ARIAL_BOLD, 14, '#946d47', spacing=3)
text(draw, (92, 239), 'Three clues.', GEORGIA, 66, '#183a3e')
headline = 'One hidden country.'
text(draw, (92, 314), headline, GEORGIA, fit_font(draw, headline, GEORGIA, 61, 548), '#b87742')
text(draw, (95, 395), 'Find the treasure before time runs out.', ARIAL, 22, '#446063')
draw.line((*pt(94, 456), *pt(640, 456)), fill='#bca374', width=SCALE)
text(draw, (95, 488), 'HIDE IT  ·  HUNT IT  ·  SHARE THE THRILL', ARIAL_BOLD, 16, '#8f6742')
text(draw, (899, 537), 'HUNCH.ROHITTP.COM', ARIAL_BOLD, 13, '#f9e8bd')
draw.rounded_rectangle((*pt(20, 20), *pt(1180, 610)), radius=15 * SCALE, outline='#dbb97d', width=2 * SCALE)

output = ROOT / 'public/social-preview.png'
image.resize((1200, 630), Image.Resampling.LANCZOS).convert('RGB').save(output, 'PNG', optimize=True)
print(f'Wrote {output}')
