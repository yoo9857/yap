import puppeteer from "puppeteer-core";
import { readFileSync, writeFileSync, statSync } from "node:fs";

// Convert the master banner (cl.png) into the deployed OG PNG + CSS-bg WebP,
// resized/re-encoded via a Chromium canvas (no cwebp/ImageMagick needed).
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SRC = process.argv[2] || "C:\\robo\\cl.png";
const JPG_OUT = "C:\\robo\\apps\\client\\public\\craftyap-banner.jpg";
const WEBP_OUT = "C:\\robo\\apps\\client\\public\\craftyap-banner.webp";
const TARGET_W = 1200; // standard OG width

const src = readFileSync(SRC).toString("base64");
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
const out = await p.evaluate(async (dataUri, targetW) => {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = dataUri;
  });
  const w = targetW;
  const h = Math.round((img.height / img.width) * targetW);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha — flatten onto white
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { jpg: c.toDataURL("image/jpeg", 0.9), webp: c.toDataURL("image/webp", 0.82), w, h, ow: img.width, oh: img.height };
}, `data:image/png;base64,${src}`, TARGET_W);
await b.close();

const bytes = (d) => Buffer.from(d.split(",")[1], "base64");
writeFileSync(JPG_OUT, bytes(out.jpg));
writeFileSync(WEBP_OUT, bytes(out.webp));
const kb = (f) => (statSync(f).size / 1024).toFixed(0) + "KB";
console.log(`source ${out.ow}x${out.oh} → ${out.w}x${out.h}`);
console.log(`craftyap-banner.jpg  ${kb(JPG_OUT)}`);
console.log(`craftyap-banner.webp ${kb(WEBP_OUT)}`);
