"""Prepare generated UI art: preserve masters, trim unused alpha, encode WebP."""
from hashlib import sha256
from pathlib import Path
import json
from PIL import Image

HERE = Path(__file__).resolve().parent
TARGET = HERE.parents[1] / "apps/client/public/ui/garage/v1"
TARGET.mkdir(parents=True, exist_ok=True)
assets = []
for name, width in [("button-gold", 1024), ("button-navy", 1024), ("workbench-frame", 640), ("selection-cradle", 512)]:
    source = HERE / "raw" / f"{name}.png"
    image = Image.open(source).convert("RGBA")
    bounds = image.getchannel("A").point(lambda alpha: 255 if alpha >= 8 else 0).getbbox()
    if not bounds:
        raise ValueError(f"No visible pixels in {source}")
    bounds = (max(0, bounds[0]-3), max(0, bounds[1]-3), min(image.width, bounds[2]+3), min(image.height, bounds[3]+3))
    image = image.crop(bounds)
    if image.width > width:
        image = image.resize((width, round(image.height * width / image.width)), Image.Resampling.LANCZOS)
    destination = TARGET / f"{name}.webp"
    image.save(destination, "WEBP", quality=94, method=6, exact=True)
    assets.append({"file": destination.name, "width": image.width, "height": image.height, "source_sha256": sha256(source.read_bytes()).hexdigest(), "bytes": destination.stat().st_size})
    print(f"{destination.name}: {image.width}x{image.height}, {destination.stat().st_size} bytes")
(TARGET / "manifest.json").write_text(json.dumps({"version": 1, "generator": "ChatGPT built-in image_gen", "assets": assets}, indent=2) + "\n", encoding="utf-8")
