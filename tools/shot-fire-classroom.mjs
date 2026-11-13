// Our classroom in the fire drill, from its middle, looking each way (and the quiz board close up):
// how what stands in the classroom gets judged. Needs `pnpm dev`.
//
//   node tools/shot-fire-classroom.mjs [outdir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2] ?? "shots-classroom";
const URL = process.env.URL ?? "http://localhost:5173/?mode=field&theme=fire&reset=1";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--window-size=1600,900"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__roboCraft?.fire?.(), { timeout: 120000 });
await sleep(2500);
await page.evaluate(() => globalThis.__roboCraft.firePlay(true));
await page.addStyleTag({ content: ".craft-hint, .game-menu { display: none !important; }" }); // the pause card: not what is being judged
const school = await page.evaluate(async () => (await import("/@fs/C:/craftyap/packages/shared/src/fireSchool.ts")).fireSchool());
const [x0, , z0, x1, , z1] = school.classroom, floor = school.spawns[0][1];
const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
console.log("classroom", school.classroom, "floor", floor);
const shot = async (name) => { await sleep(900); const f = join(OUT, `${name}.png`); await page.screenshot({ path: f }); console.log(f); };
for (const [name, yaw] of [["north", 0], ["east", Math.PI / 2], ["south", Math.PI], ["west", -Math.PI / 2]]) {
  await page.evaluate((x, y, z, yaw) => globalThis.__roboCraft.teleportAbs(x, y, z, yaw), cx, floor + 0.05, cz, yaw);
  await shot(`room-yaw-${name}`);
}
const board = await page.evaluate(() => globalThis.__roboCraft.fire().quizBoard ?? null);
if (board) {
  await page.evaluate((x, y, z, yaw) => globalThis.__roboCraft.teleportAbs(x, y, z, yaw), board.stand[0], floor + 0.05, board.stand[2], board.yaw);
  await shot("quiz-board");
  console.log("prompt:", (await page.evaluate(() => globalThis.__roboCraft.fire())).prompt);
}
await browser.close();
