"""Builds the pictures of a school story for /cases/ from the photos and screenshots a school sent.

    python assets/cases/build.py "<folder with the originals>" [preview-dir]

The originals are NEVER copied into the repository: they show children's faces and, in the game
screenshots, the school's, the teacher's and the children's names. What is written to
apps/client/public/cases/school-1/ is cropped so that no roster, name sign or name label is in it,
and what could not be cropped out is blurred (BLUR boxes). Every output must be LOOKED AT before it
is committed (the preview sheet): a name or a face that is still readable does not go on the site.
Coordinates are fractions of the source picture's width and height.
"""
import sys, os, io
import pymupdf as fitz
from PIL import Image, ImageFilter

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "../../apps/client/public/cases/school-1")
W, H = 1456, 816  # the screenshots' own size, for readable numbers below

def shot(name):  # a game screenshot saved as a one-page PDF
    page = fitz.open(os.path.join(SRC, name))[0]
    pix = page.get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
    return Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")

def photo(name):
    return Image.open(os.path.join(SRC, name)).convert("RGB")

def cut(img, box, blur=(), base=(1, 1)):
    w, h = img.size
    fx, fy = w / base[0], h / base[1]
    for (x0, y0, x1, y1) in blur:
        b = (int(x0 * fx), int(y0 * fy), int(x1 * fx), int(y1 * fy))
        patch = img.crop(b).resize((max(1, (b[2] - b[0]) // 14), max(1, (b[3] - b[1]) // 14))).resize((b[2] - b[0], b[3] - b[1]), Image.BILINEAR).filter(ImageFilter.GaussianBlur(6))
        img.paste(patch, b)
    return img.crop((int(box[0] * fx), int(box[1] * fy), int(box[2] * fx), int(box[3] * fy)))

def save(img, name, width, quality=80):
    img = img.resize((width, round(img.size[1] * width / img.size[0])), Image.LANCZOS)
    path = os.path.join(OUT, name)
    img.save(path, "WEBP", quality=quality, method=6)
    print(f"{name}  {img.size[0]}x{img.size[1]}  {os.path.getsize(path) // 1024} KB")
    return img

os.makedirs(OUT, exist_ok=True)
made = []
# the computer room from the back: every child is seen from behind; the one profile is blurred
made.append(save(cut(photo("KakaoTalk_20261110_140310218.jpg"), (0, 0.10, 1, 0.94), blur=[(0.735, 0.455, 0.795, 0.575), (0.83, 0.39, 0.875, 0.47)]), "room.webp", 1400, 78))
# one seat: the screen and the hands, the child's face left out of the frame
made.append(save(cut(photo("KakaoTalk_20261112_153452119.jpg"), (0.27, 0.10, 1, 0.92), blur=[(0.462, 0.185, 0.512, 0.30)]), "seat.webp", 1000))
# what the children built (rosters, name signs and labels cropped away; small far labels blurred)
made.append(save(cut(shot("크얍4.pdf"), (352, 140, 1012, 556), base=(W, H)), "built-house.webp", 900))
made.append(save(cut(shot("크얍3.pdf"), (536, 270, 1010, 556), base=(W, H)), "built-library.webp", 900))
made.append(save(cut(shot("크얍1.pdf"), (300, 146, 880, 344), base=(W, H)), "built-brick.webp", 900))
if len(sys.argv) > 2:
    os.makedirs(sys.argv[2], exist_ok=True)
    for i, img in enumerate(made): img.save(os.path.join(sys.argv[2], f"check{i}.png"))

# The video that fills the top of /cases/ is built by assets/cases/video.py (its own rules are written there).
