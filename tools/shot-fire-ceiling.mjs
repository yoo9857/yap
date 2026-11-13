// The fire's light on the ceilings, looked up at: the corridor over the waste-bin fire and the
// burning room at three moments of its fire, plus the smoke layer from under it. This is how the
// ceiling's light (fireFx CEIL_FRAG) and the smoke's lighting get judged. Needs `pnpm dev`.
//
//   node tools/shot-fire-ceiling.mjs [outdir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? "shots-ceiling";
const URL = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1600,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" || /shader|program/i.test(m.text())) console.log(`console ${m.type()}: ${m.text().slice(0, 300)}`); });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
await sleep(3000);
await page.addStyleTag({ content: ".craft-hint, .game-menu, .craft-toast, .fire-guide { display: none !important; }" });
const school = await page.evaluate(async () => (await import("/@fs/C:/craftyap/packages/shared/src/fireSchool.ts")).fireSchool());
const floor = school.spawns[0][1];
const [, , hz0, , , hz1] = school.heat;
const shot = async (name) => { await sleep(1200); const f = join(OUT, `${name}.png`); await page.screenshot({ path: f }); console.log(f); };
const at = (x, z, yaw, pitch, patch) => page.evaluate((x, y, z, yaw, pitch, patch) => {
  const c = globalThis.__roboCraft;
  c.firePlay(true);
  if (patch) c.fireSet(patch);
  c.teleportAbs(x, y, z, yaw);
  c.look(yaw, pitch);
}, x, floor + 0.05, z, yaw, pitch, patch ?? null);

// the corridor, a few metres from the bin, looking up over it
const [bx, , bz] = school.bin;
await at(bx + 3.2, bz, -Math.PI / 2, 0.45, { time: 30 });
await shot("corridor-bin");
// the burning room from its doorway side, looking up, as the fire grows
const cz = (hz0 + hz1) / 2;
const door = school.fireDoor, dx = (door[0] + door[3]) / 2, dz = (door[2] + door[5]) / 2;
// (from the doorway, looking in and up: inside, the heat sends the player back before a picture is taken)
const out = dz > cz ? 1 : -1;
for (const time of [12, 40, 90, 170]) {
  // (a step inside and to one side, so the robot's own back is not the picture)
  await at(dx - 1.1, dz - out * 1.6, (out > 0 ? Math.PI : 0) - 0.35, 0.12, { time, air: 1, mistakes: 0 });
  await shot(`room-${String(time).padStart(3, "0")}s`);
}
console.log(JSON.stringify((await page.evaluate(() => globalThis.__roboCraft.fire())).fx));
await browser.close();
