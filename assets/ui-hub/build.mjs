// raw/*.png (generated, 1024–1536 px, transparent) → apps/client/public/ui/hub/*.webp
// Trims the empty margin, scales to the size the page draws it at (×2 for
// retina), encodes WebP in headless Edge, and writes sizes.json so the CSS
// 9-slice numbers can be checked against the real pixels.
//
//   node assets/ui-hub/build.mjs
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const OUT = join(ROOT, "apps/client/public/ui/hub");
const puppeteer = createRequire(join(ROOT, "package.json"))("puppeteer-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/** Longest side after trimming, in px. */
const SIZE = (name) =>
  name.startsWith("icon-") ? 160
  : name.startsWith("panel-frame") ? 480
  : name.startsWith("card-frame") ? 420
  : name.startsWith("start-button") || name === "bar-frame" ? 960
  : name === "title-plaque" ? 640
  : name === "tab-active" ? 260
  : 480;

mkdirSync(OUT, { recursive: true });
const files = readdirSync(join(HERE, "raw")).filter((f) => f.endsWith(".png")).sort();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const sizes = {};
for (const file of files) {
  const name = file.replace(/\.png$/, "");
  const src = `data:image/png;base64,${readFileSync(join(HERE, "raw", file)).toString("base64")}`;
  const result = await page.evaluate(async (src, max) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const { data, width, height } = x.getImageData(0, 0, c.width, c.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) for (let i = 0; i < width; i++) {
      if (data[(y * width + i) * 4 + 3] > 10) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const pad = 2;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(width - 1, x1 + pad); y1 = Math.min(height - 1, y1 + pad);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const scale = Math.min(1, max / Math.max(w, h));
    const o = document.createElement("canvas");
    o.width = Math.round(w * scale);
    o.height = Math.round(h * scale);
    const ox = o.getContext("2d");
    ox.imageSmoothingQuality = "high";
    ox.drawImage(c, x0, y0, w, h, 0, 0, o.width, o.height);
    return { w: o.width, h: o.height, url: o.toDataURL("image/webp", 0.9) };
  }, src, SIZE(name));
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(result.url.split(",")[1], "base64"));
  sizes[name] = [result.w, result.h];
  console.log(`${name}.webp  ${result.w}×${result.h}`);
}
writeFileSync(join(HERE, "sizes.json"), JSON.stringify(sizes, null, 2));
await browser.close();
if (!existsSync(join(OUT, "panel-frame.webp"))) process.exitCode = 1;
