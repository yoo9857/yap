import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\scratchpad-shots";
mkdirSync(OUT, { recursive: true });
const b = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"] });
for (const anim of ["idle", "run", "jump", "dead"]) {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.goto(`http://localhost:5173/?preview=char&anim=${anim}`, { waitUntil: "networkidle2", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));
  await p.screenshot({ path: `${OUT}\\anim-${anim}.png` });
  await p.close();
}
console.log("shots →", OUT);
await b.close();
