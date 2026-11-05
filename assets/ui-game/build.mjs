// raw/*.png (Codex, 1024–1536 px, transparent) → apps/client/public/ui/game/*.webp, used by the web and
// compiled into the native app (engine/crates/client/src/art.rs). Like assets/ui-hub/build.mjs: trims
// the empty margin, scales to the size it is drawn at (×2–3 for dense phones), encodes WebP in headless
// Edge. The animated sheets (fx-*, a 3 × 2 grid) are sliced into fx-<name>-1..6, every frame cropped to
// the SAME box (the union of the frames' content) so the animation does not jitter.
//
//   node assets/ui-game/build.mjs
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const OUT = join(ROOT, "apps/client/public/ui/game");
const puppeteer = createRequire(join(ROOT, "package.json"))("puppeteer-core");
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/** Longest side after trimming, in px. */
const SIZE = (name) =>
  name.startsWith("glyph-") ? 160
  : name.startsWith("slot") ? 192
  : name.startsWith("btn-start") ? 1024
  : name.startsWith("btn-") || name.startsWith("stick-") ? 256
  : name.startsWith("fx-") ? 256
  : name.startsWith("pet-") || name.startsWith("nav-") ? 192
  : 640;

mkdirSync(OUT, { recursive: true });
const files = readdirSync(join(HERE, "raw")).filter((f) => f.endsWith(".png")).sort();
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const sizes = {};
for (const file of files) {
  const name = file.replace(/\.png$/, "");
  const src = `data:image/png;base64,${readFileSync(join(HERE, "raw", file)).toString("base64")}`;
  const sheet = name.startsWith("fx-");
  const outs = await page.evaluate(async (src, max, sheet, halo) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const { data, width } = g.getImageData(0, 0, c.width, c.height);
    const bbox = (cx, cy, cw, ch) => {
      let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        if (data[((cy + y) * width + cx + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return x1 < 0 ? null : [x0, y0, x1, y1];
    };
    const encode = (sx, sy, w, h) => {
      const scale = Math.min(1, max / Math.max(w, h));
      const o = document.createElement("canvas");
      o.width = Math.max(1, Math.round(w * scale));
      o.height = Math.max(1, Math.round(h * scale));
      const ox = o.getContext("2d");
      ox.imageSmoothingQuality = "high";
      if (halo) {
        // a white rim under the ink: the silhouette in white, stamped around a ring, then the art
        const t = document.createElement("canvas");
        t.width = o.width;
        t.height = o.height;
        const tx = t.getContext("2d");
        tx.drawImage(c, sx, sy, w, h, 0, 0, t.width, t.height);
        tx.globalCompositeOperation = "source-in";
        tx.fillStyle = "#fffaf0";
        tx.fillRect(0, 0, t.width, t.height);
        for (let a = 0; a < 16; a++) ox.drawImage(t, Math.cos(a * Math.PI / 8) * halo, Math.sin(a * Math.PI / 8) * halo);
      }
      ox.drawImage(c, sx, sy, w, h, 0, 0, o.width, o.height);
      return { w: o.width, h: o.height, url: o.toDataURL("image/webp", 0.9) };
    };
    const pad = 2;
    if (!sheet) {
      const b = bbox(0, 0, c.width, c.height) ?? [0, 0, c.width - 1, c.height - 1];
      const [x0, y0] = [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad)];
      const [x1, y1] = [Math.min(c.width - 1, b[2] + pad), Math.min(c.height - 1, b[3] + pad)];
      return [encode(x0, y0, x1 - x0 + 1, y1 - y0 + 1)];
    }
    // a 3 × 2 sheet: one crop box for all six cells (their union), so the frames stay aligned
    const cw = Math.floor(c.width / 3), ch = Math.floor(c.height / 2);
    let u = null;
    for (let i = 0; i < 6; i++) {
      const b = bbox((i % 3) * cw, Math.floor(i / 3) * ch, cw, ch);
      if (b) u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : b;
    }
    u = u ?? [0, 0, cw - 1, ch - 1];
    // a square box centred on the union (an effect is drawn centred on its spot)
    const side = Math.min(cw, ch, Math.max(u[2] - u[0], u[3] - u[1]) + 2 * pad);
    const cx = (u[0] + u[2]) / 2, cy = (u[1] + u[3]) / 2;
    const bx = Math.round(Math.min(Math.max(0, cx - side / 2), cw - side)), by = Math.round(Math.min(Math.max(0, cy - side / 2), ch - side));
    return Array.from({ length: 6 }, (_, i) => encode((i % 3) * cw + bx, Math.floor(i / 3) * ch + by, side, side));
  }, src, SIZE(name), sheet, name === "fx-crack" ? 4 : 0);
  outs.forEach((r, i) => {
    const out = sheet ? `${name}-${i + 1}` : name;
    writeFileSync(join(OUT, `${out}.webp`), Buffer.from(r.url.split(",")[1], "base64"));
    sizes[out] = [r.w, r.h];
    console.log(`${out}.webp  ${r.w}×${r.h}`);
  });
}
writeFileSync(join(HERE, "sizes.json"), JSON.stringify(sizes, null, 2));
await browser.close();
