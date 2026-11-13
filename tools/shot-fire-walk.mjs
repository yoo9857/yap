// node tools/shot-fire-walk.mjs [outdir] — the whole fire drill as a child meets it, one picture
// per moment: the classroom, the alarm, both lesson cards, the spray on the small fire, the smoke
// coming along the corridor after it, the towel, the stairs, the way out, the gathering place and
// the result. Needs the client dev server. This is the review of what the LESSON looks like —
// tools/shot-fire-blaze.mjs is the review of the fire itself.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const out = process.argv[2] ?? "shots-fire-walk";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1600,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => console.log("PAGE ERROR", e.message));
page.on("console", (m) => { if ((m.type() === "error" && !/google/.test(m.text())) || /shader|GLSL/i.test(m.text())) console.log("console", m.type(), m.text().slice(0, 500)); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const shot = async (name) => { const file = `${String(++n).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(out, file) }); console.log("shot", file); };
const fire = () => page.evaluate(() => globalThis.__roboCraft.fire());
const NORTH = Math.PI, SOUTH = 0, EAST = Math.PI / 2, WEST = -Math.PI / 2, FLOOR = 8.4, CORRIDOR = -4.4;
const stand = async (x, y, z, yaw, pitch = -0.05, ms = 600) => {
  await page.evaluate((x, y, z, yaw, pitch) => { const c = globalThis.__roboCraft; c.firePlay(true); c.fireSet({ air: 1 }); c.teleportAbs(x, y, z, yaw); c.look(yaw, pitch); }, x, y, z, yaw, pitch); // (breath topped up: the pictures are of the place, not of how long the camera stood in the smoke)
  await wait(ms);
};
const say = async (label) => { const f = await fire(); console.log(`  ${label}: step=${f.step} guide="${f.guide}" prompt=${JSON.stringify(f.prompt)} air=${f.air.toFixed(2)} smokeFloor=${f.smokeFloor.toFixed(2)} quality=${f.fx.quality}`); };

await page.goto(`${BASE}/?mode=field&theme=fire${process.env.EXTRA_QUERY ?? ""}`, { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => !!globalThis.__roboCraft?.fire?.(), { timeout: 30000 });
await wait(2500);
await page.evaluate(() => { globalThis.__roboCraft.firePlay(true); document.querySelector(".game-menu")?.style.setProperty("display", "none"); });
await wait(800);
await shot("classroom"); await say("start");

// the alarm
await stand(-11.8, FLOOR, CORRIDOR, NORTH, 0.02);
await shot("alarm-aimed"); await say("alarm");
await page.evaluate(() => globalThis.__roboCraft.fireInteract());
await wait(500);
// 119
await stand(-9.2, FLOOR, CORRIDOR, NORTH, 0.02);
await shot("phone-aimed"); await say("phone");
await page.evaluate(() => globalThis.__roboCraft.fireInteract());
await wait(700);
await shot("card-119");
await page.evaluate(() => globalThis.__roboCraft.fireSolve());
await wait(500);
// the extinguisher
await stand(-14.5, FLOOR, CORRIDOR, NORTH, -0.3);
await shot("extinguisher-aimed"); await say("extinguisher");
await page.evaluate(() => globalThis.__roboCraft.fireInteract());
await wait(700);
await shot("card-pass");
await page.evaluate(() => globalThis.__roboCraft.fireSolve());
await wait(500);
// the small fire: from the corridor, then spraying at its base
await stand(-16.2, FLOOR, -4.3, WEST, -0.12);
await shot("small-fire"); await say("spray");
await stand(-17.6, FLOOR, -4.3, WEST, -0.2);
await page.evaluate(() => globalThis.__roboCraft.fireSpray(true));
await wait(1300);
await shot("spraying");
await page.waitForFunction(() => globalThis.__roboCraft.fire().fire === 0, { timeout: 15000 }).catch(() => console.log("  the fire did not go out"));
await page.evaluate(() => globalThis.__roboCraft.fireSpray(false));
await wait(500);
await shot("fire-out"); await say("fire out");
// the smoke comes along the corridor
await stand(-12, FLOOR, CORRIDOR, EAST, 0.12);
await shot("smoke-coming-0s");
await wait(5000);
await stand(-12, FLOOR, CORRIDOR, EAST, 0.12, 300);
await shot("smoke-coming-5s");
await wait(7000);
await stand(-12, FLOOR, CORRIDOR, EAST, 0.12, 300);
await shot("smoke-coming-12s"); await say("smoke");
// the towel
await stand(5.5, FLOOR, -4.1, SOUTH, -0.2);
await shot("towel-aimed"); await say("towel");
await page.evaluate(() => globalThis.__roboCraft.fireInteract());
await wait(600);
// the corridor to the stairs, standing in the smoke
await stand(-6, FLOOR, CORRIDOR, EAST, -0.02);
await shot("escape-corridor"); await say("escape");
await stand(0.4, FLOOR, -7.5, NORTH, -0.1);
await shot("stairs-top");
await stand(0.4, 6.2, -15.6, SOUTH, -0.1);
await shot("stairs-landing");
// out, and the gathering place
await stand(0, 4.1, -3, SOUTH, -0.05);
await shot("exit-door"); await say("exit");
await stand(0, 4.1, 6, SOUTH, -0.05, 900);
await shot("outside"); await say("outside");
await stand(0, 4.2, 16.5, NORTH, 0.1, 1500);
await shot("gathered"); await say("gathered");
await wait(1500);
await shot("result");
await browser.close();
