import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\scratchpad-shots";
const mode = process.argv[3] || "craft";
mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.goto(`http://localhost:5173/?mode=${mode}${mode === "craft" ? "&reset=1" : ""}`, { waitUntil: "networkidle2", timeout: 30000 });
await p.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 25000 });
if (mode === "craft") {
  await p.mouse.click(640, 400);
  await p.evaluate(() => globalThis.__roboCraft?.teleport(40.5, 18, 70.5));
  await p.evaluate(() => globalThis.__roboCraft?.look(Math.PI, -0.12));
  await new Promise((r) => setTimeout(r, 1200));
}
await new Promise((r) => setTimeout(r, 3000));
await p.screenshot({ path: `${OUT}\\${mode}.png` });
console.log("shot →", `${OUT}\\${mode}.png`);
await b.close();
