// BEFORE/AFTER for a science-mode patch note: a fresh solo education field, then T pressed, at
// 1280×800. Run it against production BEFORE a deploy and against the new build after it (or the
// dev server): node tools/shot-science-ba.mjs <url> <outdir> <prefix>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [url = "https://craftyap.com", outDir = ".", prefix = "shot"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await page.goto(`${url}/?mode=field&reset=1`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden") || document.body.classList.contains("in-game"), { timeout: 60000 }).catch(() => {});
// headless has no pointer lock: hide the pause card so the shot shows the world
await page.addStyleTag({ content: ".craft-hint{display:none!important}" });
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
await settle(4000);
await page.screenshot({ path: join(outDir, `${prefix}-field.png`) });
await page.keyboard.press("t");
await settle(1500);
await page.screenshot({ path: join(outDir, `${prefix}-t.png`) });
await browser.close();
console.log("saved", prefix);
