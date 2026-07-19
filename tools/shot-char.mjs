import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\scratchpad-shots";
mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 800 });
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
await p.goto("http://localhost:5173/?preview=char", { waitUntil: "networkidle2", timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [name, wait] of [["idle", 0], ["run", 1700], ["jump", 1700], ["front", 1700]]) {
  await sleep(wait);
  await p.screenshot({ path: `${OUT}\\char-${name}.png` });
}
console.log("shots →", OUT);
await b.close();
