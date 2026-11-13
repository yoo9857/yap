// node tools/shot-fire-blaze.mjs [outdir] — the fire itself, as it grows: the burning room and the
// waste-bin fire at several moments of the drill's clock, then the corridor's smoke young and old.
// Needs the client dev server. This is how the flames, the smoke and the spread get judged.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const out = process.argv[2] ?? "shots-fire-blaze";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1600,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
page.on("console", (m) => { if (m.type() === "error" || /shader|WebGL|GLSL/i.test(m.text())) console.log("console", m.type(), m.text().slice(0, 600)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: join(out, `${name}.png`) }); console.log("shot", name); };

await page.goto(`${BASE}/?mode=field&theme=fire${process.env.EXTRA_QUERY ?? ""}`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => !!globalThis.__roboCraft?.fire?.(), { timeout: 30000 });
await wait(2500);
await page.evaluate(() => { globalThis.__roboCraft.firePlay(true); document.querySelector(".game-menu")?.style.setProperty("display", "none"); });
const at = (x, y, z, yaw, pitch, patch) => page.evaluate((x, y, z, yaw, pitch, patch) => {
  const c = globalThis.__roboCraft;
  c.fireSet({ air: 1, ...patch });
  c.teleportAbs(x, y, z, yaw); c.look(yaw, pitch);
}, x, y, z, yaw, pitch, patch);
const FLOOR = 8.4;
// the burning room, from just inside its corridor side, looking at the far corner
for (const t of [5, 70, 130, 260]) {
  await at(-16.5, FLOOR, -8.2, Math.atan2(-4.5, -8), -0.02, { time: t });
  await wait(700);
  await shot(`room-${String(t).padStart(3, "0")}s`);
}
// INSIDE the burning room: the fire on the floor, on the benches, and climbing the walls and cabinets
for (const [name, x, z, yaw, t] of [["in-west", -17, -14, -Math.PI / 2, 120], ["in-north", -19, -10, Math.PI, 200], ["in-south", -19, -17, 0, 200]]) {
  await at(x, FLOOR, z, yaw, -0.05, { time: t });
  await wait(700);
  await shot(name);
}
// the waste-bin fire from the corridor, fresh and left too long
for (const t of [5, 200]) {
  await at(-16.2, FLOOR, -4.3, -Math.PI / 2, -0.12, { time: t, fire: 1 });
  await wait(700);
  await shot(`bin-${String(t).padStart(3, "0")}s`);
}
// the corridor's smoke: just begun, and after a minute and a half
for (const age of [3, 90]) {
  await at(-6, FLOOR, -4.3, -Math.PI / 2, 0.02, { time: 150, step: "escape", towel: true, fire: 0, smokeAge: age });
  await wait(2500);
  await at(-6, FLOOR, -4.3, -Math.PI / 2, 0.02, { smokeAge: age });
  await shot(`smoke-${String(age).padStart(2, "0")}s`);
}
console.log(JSON.stringify((await page.evaluate(() => globalThis.__roboCraft.fire())).fx));
console.log(JSON.stringify(await page.evaluate(() => globalThis.__roboCraft.perf?.() ?? null)));
await browser.close();
