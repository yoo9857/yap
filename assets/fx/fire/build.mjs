// node assets/fx/fire/build.mjs <column workdir> [ridge workdir]
// Turns the baked flame sheets (<workdir>/fire.png, from source/bake_fire.py) into the WebPs the
// game loads: apps/client/public/textures/fx/fire-flames.webp (column) and fire-ridge.webp. Re-encoded through a Chromium
// canvas, like the other art (no cwebp / ImageMagick needed). After a re-bake, bump the `?v=`
// of FIRE_FLAMES_URL in apps/client/src/craft/fire/fireFx.ts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const here = dirname(fileURLToPath(import.meta.url));
const [column, ridge, wall] = process.argv.slice(2);
if (!column) throw new Error("usage: node assets/fx/fire/build.mjs <column workdir> [ridge workdir]");
const out = resolve(here, "../../../apps/client/public/textures/fx");
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
for (const [work, from, to, quality] of [
  [column, "fire.png", "fire-flames.webp", 0.9], [ridge, "fire.png", "fire-ridge.webp", 0.9],
  [wall, "fire.png", "fire-wall.webp", 0.9], // (side.png, the profile, is baked too but not used: see fireFx.ts)
]) {
  if (!work) continue;
  const png = readFileSync(join(work, from)).toString("base64");
  const webp = await page.evaluate(async (png, quality) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    return { data: canvas.toDataURL("image/webp", quality).split(",")[1], w: canvas.width, h: canvas.height };
  }, png, quality);
  writeFileSync(join(out, to), Buffer.from(webp.data, "base64"));
  console.log(`${to}: ${webp.w}x${webp.h}, ${(Buffer.from(webp.data, "base64").length / 1024).toFixed(0)} KB`);
}
await browser.close();
