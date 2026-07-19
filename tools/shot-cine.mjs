import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = process.argv[2] || "C:\\robo\\export\\steam";
mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080;
const b = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", `--window-size=${W},${H}`],
});
const p = await b.newPage();
await p.setViewport({ width: W, height: H });
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
p.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
await p.goto("http://localhost:5173/?mode=cinematic", { waitUntil: "networkidle2", timeout: 30000 });
await p.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 25000 });
await new Promise((r) => setTimeout(r, 2500)); // let the fade lift + trees pour in

const shots = await p.evaluate(() => window.__roboCine?.shots ?? []);
console.log("shots:", shots.join(", "));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < shots.length; i++) {
  await p.evaluate((idx) => { window.__roboCine.pin(idx); window.__roboCine.seek(24 + idx * 9); }, i);
  await sleep(700);
  const name = `cine-${String(i).padStart(2, "0")}-${shots[i]}.png`;
  await p.screenshot({ path: `${OUT}\\${name}` });
  console.log("shot →", name);
}
await b.close();
console.log("done →", OUT);
