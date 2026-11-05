"""The building-shape icons (piece-*.webp) and the turn glyph, drawn in the pack's lineless style
when Codex is not available: a cream toy brick in three-quarter view, three face tones (lit top,
mid left, shaded right), soft studs, a soft contact shadow, no outlines. Codex art in raw/ (run
generate.mjs, then build.mjs) replaces these.

    python assets/ui-game/draw-pieces.py
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "client", "public", "ui", "game")
S = 640  # drawn large, saved at 192
TOP, LEFT, RIGHT = (255, 238, 200), (238, 202, 142), (210, 166, 104)
STUD_TOP, STUD_SIDE = (255, 246, 222), (226, 190, 132)

# an isometric-ish projection: x right-down, z left-down, y up
def P(x, y, z, cx=S / 2, cy=S * 0.66, k=205):
    return (cx + (x - z) * k * 0.87, cy + (x + z) * k * 0.5 - y * k)

def poly(d, pts, fill):
    d.polygon([P(*p) for p in pts], fill=fill)

def shadow(img):
    sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sh).ellipse((S * 0.24, S * 0.80, S * 0.76, S * 0.93), fill=(40, 50, 80, 55))
    return Image.alpha_composite(sh.filter(ImageFilter.GaussianBlur(18)), img)

def stud(d, x, y, z, r=0.17):
    # a short cylinder standing on the top face at (x, y, z)
    k = 205
    (cx, cy) = P(x, y, z)
    rx, ry, h = r * k * 1.0, r * k * 0.58, 0.10 * k
    d.rectangle((cx - rx, cy - h, cx + rx, cy), fill=STUD_SIDE)
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=STUD_SIDE)
    d.ellipse((cx - rx, cy - h - ry, cx + rx, cy - h + ry), fill=STUD_TOP)

def box(d, x0, y0, z0, x1, y1, z1):
    # visible faces from the viewer: top (y1), front-left (z1), front-right (x1)
    poly(d, [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], TOP)
    poly(d, [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], LEFT)
    poly(d, [(x1, y0, z0), (x1, y0, z1), (x1, y1, z1), (x1, y1, z0)], RIGHT)

def cube(d):
    box(d, -0.5, 0, -0.5, 0.5, 1, 0.5)
    for sx in (-0.22, 0.22):
        for sz in (-0.22, 0.22):
            stud(d, sx, 1, sz)

def slab(d):
    box(d, -0.5, 0, -0.5, 0.5, 0.5, 0.5)
    for sx in (-0.22, 0.22):
        for sz in (-0.22, 0.22):
            stud(d, sx, 0.5, sz)

def stairs(d):
    box(d, -0.5, 0, -0.5, 0.5, 0.5, 0.5)
    box(d, -0.5, 0.5, -0.5, 0.5, 1, 0.0)
    for sx in (-0.22, 0.22):
        stud(d, sx, 1, -0.25)
        stud(d, sx, 0.5, 0.25)

def slope(d):
    # a wedge rising toward the back (-z): the slope faces the viewer's left-front
    poly(d, [(-0.5, 0, 0.5), (0.5, 0, 0.5), (0.5, 1, -0.5), (-0.5, 1, -0.5)], LEFT)  # the slope (lit like a side)
    poly(d, [(-0.5, 1, -0.5), (0.5, 1, -0.5), (0.5, 1, -0.3), (-0.5, 1, -0.3)], TOP)
    poly(d, [(0.5, 0, -0.5), (0.5, 0, 0.5), (0.5, 1, -0.5)], RIGHT)
    # lighten the slope's upper half (soft gradient)
    for sx in (-0.22, 0.22):
        stud(d, sx, 1, -0.4, 0.13)

def corner(d):
    # a pyramid corner: full base, one top vertex at the back-left; the two slopes face the viewer
    apex = (-0.5, 1, -0.5)
    poly(d, [(-0.5, 0, 0.5), (0.5, 0, 0.5), apex], LEFT)
    poly(d, [(0.5, 0, 0.5), (0.5, 0, -0.5), apex], RIGHT)
    # the slopes' ridge catches the light
    d.line([P(0.5, 0, 0.5), P(*apex)], fill=TOP, width=10)
    stud(d, -0.42, 0.96, -0.42, 0.12)

def round_(d):
    k = 205
    cx, cy_bottom = P(0, 0, 0)
    _, cy_top = P(0, 1, 0)
    rx, ry = 0.62 * k, 0.36 * k
    d.rectangle((cx - rx, cy_top, cx + rx, cy_bottom), fill=LEFT)
    d.pieslice((cx - rx, cy_bottom - ry, cx + rx, cy_bottom + ry), 0, 180, fill=LEFT)
    d.rectangle((cx, cy_top, cx + rx, cy_bottom), fill=RIGHT)
    d.pieslice((cx - rx, cy_bottom - ry, cx + rx, cy_bottom + ry), 0, 90, fill=RIGHT)
    d.ellipse((cx - rx, cy_top - ry, cx + rx, cy_top + ry), fill=TOP)
    stud(d, 0, 1, 0, 0.3)

def turn(img):
    d = ImageDraw.Draw(img)
    c, r, w = S / 2, S * 0.30, S * 0.09
    blue, deep = (77, 152, 244), (52, 112, 206)
    d.arc((c - r, c - r, c + r, c + r), 200, 470, fill=deep, width=int(w))
    d.arc((c - r, c - r - 6, c + r, c + r - 6), 200, 470, fill=blue, width=int(w))
    # the arrow head at the end (110°)
    a = math.radians(110)
    tip = (c + r * math.cos(a), c + r * math.sin(a))
    t = (-math.sin(a), math.cos(a))  # tangent (clockwise)
    n = (math.cos(a), math.sin(a))
    L = S * 0.13
    pts = [(tip[0] + t[0] * L * 0.9, tip[1] + t[1] * L * 0.9), (tip[0] + n[0] * L, tip[1] + n[1] * L), (tip[0] - n[0] * L, tip[1] - n[1] * L)]
    d.polygon(pts, fill=blue)
    # a small cream brick in the middle
    b = S * 0.10
    d.rounded_rectangle((c - b, c - b * 0.7, c + b, c + b * 0.9), radius=12, fill=LEFT)
    d.rounded_rectangle((c - b, c - b * 0.9, c + b, c + b * 0.3), radius=12, fill=TOP)

for name, fn in [("piece-cube", cube), ("piece-slab", slab), ("piece-stairs", stairs), ("piece-slope", slope), ("piece-corner", corner), ("piece-round", round_)]:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fn(ImageDraw.Draw(img))
    img = shadow(img).resize((192, 192), Image.LANCZOS)
    img.save(os.path.join(OUT, name + ".webp"), "WEBP", quality=90)
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
turn(img)
img.resize((160, 160), Image.LANCZOS).save(os.path.join(OUT, "glyph-turn.webp"), "WEBP", quality=90)
print("drawn")
