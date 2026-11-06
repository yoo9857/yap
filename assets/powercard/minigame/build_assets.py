"""Mini-game sprites → game assets: keep the alpha the generator gave (or key a flat light
background out by flood fill from the edges), crop to the content, cap the size, save WebP into
apps/client/public/ui/minigame/. Scenes (g-scene, w-scene) stay opaque and keep their framing.

python build_assets.py
"""
import os
from collections import deque

from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "sprites")
OUT = os.path.join(HERE, "..", "..", "..", "apps", "client", "public", "ui", "minigame")
os.makedirs(OUT, exist_ok=True)
SCENES = {"g-scene", "w-scene", "r-scene"}
# sprites whose generated art carries a stub the game draws itself (the earth plug's thin striped
# tail): trim this fraction of the cropped width off the left so the game's cable meets the body
TRIM_LEFT = {"w-plug-earth": 0.12}
MAX_SIDE = {"default": 512, "g-rod": 640, "gen-coil": 640, "g-hammer": 480, "r-blade": 720, "r-hub": 600}


def key_out(im: Image.Image) -> Image.Image:
    """No alpha from the generator: flood the near-flat background from the edges."""
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    mask = Image.new("L", (w, h), 255)
    m = mask.load()
    seen = bytearray(w * h)
    q = deque([(x, 0) for x in range(w)] + [(x, h - 1) for x in range(w)] + [(0, y) for y in range(h)] + [(w - 1, y) for y in range(h)])
    while q:
        x, y = q.popleft()
        i = y * w + x
        if seen[i]:
            continue
        seen[i] = 1
        r, g, b = px[x, y]
        if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 36:
            continue
        m[x, y] = 0
        if x > 0: q.append((x - 1, y))
        if x < w - 1: q.append((x + 1, y))
        if y > 0: q.append((x, y - 1))
        if y < h - 1: q.append((x, y + 1))
    mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.0))
    out = rgb.convert("RGBA")
    out.putalpha(mask)
    return out


for f in sorted(os.listdir(SRC)):
    if not f.endswith(".png"):
        continue
    name = f[:-4]
    im = Image.open(os.path.join(SRC, f))
    if name in SCENES:
        im = im.convert("RGB")
        im.thumbnail((1400, 1400), Image.LANCZOS)
        im.save(os.path.join(OUT, name + ".webp"), "WEBP", quality=86)
        print("scene ", name, im.size)
        continue
    rgba = im.convert("RGBA")
    alpha = rgba.getchannel("A")
    has_alpha = alpha.getextrema()[0] < 250
    if not has_alpha:
        rgba = key_out(im)
    bbox = rgba.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    if name in TRIM_LEFT:
        rgba = rgba.crop((round(rgba.width * TRIM_LEFT[name]), 0, rgba.width, rgba.height))
        bbox = rgba.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
        if bbox:
            rgba = rgba.crop(bbox)
    side = MAX_SIDE.get(name, MAX_SIDE["default"])
    rgba.thumbnail((side, side), Image.LANCZOS)
    rgba.save(os.path.join(OUT, name + ".webp"), "WEBP", quality=90)
    print("sprite", name, rgba.size, "alpha" if has_alpha else "keyed")
