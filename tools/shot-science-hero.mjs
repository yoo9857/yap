// A clean "it runs" shot for notes: a fresh solo field, one wind turbine laid and fully fitted
// through the debug hooks (each mini-game finished by its own rules), switched on, framed from the
// side. Needs `pnpm dev` (dev hooks). node tools/shot-science-hero.mjs <outdir>
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
const R = (fn, ...a) => page.evaluate(fn, ...a);
const frames = (n) => R(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto("http://localhost:5173/?mode=field&reset=1", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 30000 });
await page.waitForFunction(() => globalThis.__roboCraft.snapshot().grounded, { timeout: 30000 }).catch(() => {});
await page.addStyleTag({ content: ".craft-hint{display:none!important}" });
await frames(10);
const s0 = await R(() => globalThis.__roboCraft.snapshot());
const [ax, az] = await R(() => globalThis.__roboCraft.absolute());
const ground = Math.round(s0.pos[1]);
const anchor = [Math.floor(ax) + 6, ground, Math.floor(az) + 6];
await R(() => globalThis.__roboCraft.scienceMode(true));
console.log("lay", await R((a) => globalThis.__roboCraft.scienceLay(...a), anchor));
// fit every socket in order; the key pieces open their mini-game, finished through its rules
for (let pass = 0; pass < 3; pass++) {
  const sockets = await R(() => globalThis.__roboCraft.scienceSockets(0));
  for (let i = 0; i < sockets.length; i++) {
    if (sockets[i].filled) continue;
    await R((k) => globalThis.__roboCraft.hold(k), sockets[i].item);
    await R((i) => globalThis.__roboCraft.scienceFit(0, i), i);
    if ((await R(() => globalThis.__roboCraft.scienceGame()))?.open) {
      for (let t = 0; t < 50 && (await R(() => globalThis.__roboCraft.scienceGame()))?.loading; t++) await wait(100);
      await R(() => globalThis.__roboCraft.scienceSolveGame());
      for (let t = 0; t < 80 && (await R(() => globalThis.__roboCraft.scienceGame()))?.open; t++) await wait(100);
    }
  }
}
// stand off to the side and look at the plant, then switch it on with a right click on it
const look = async (stand, target) => {
  await R((a) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [ax, az] = g.absolute();
    const ox = Math.round(ax - s.pos[0]), oz = Math.round(az - s.pos[2]);
    g.teleport(a.stand[0] - ox + 0.5, a.stand[1], a.stand[2] - oz + 0.5);
  }, { stand });
  await frames(6);
  await R((a) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [ax, az] = g.absolute();
    const dx = a.t[0] - ax, dz = a.t[2] - az, dy = a.t[1] - (s.pos[1] + 1.6);
    g.look(Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, { t: target });
  await frames(6);
};
await look([anchor[0] + 4, ground, anchor[2]], [anchor[0] + 0.5, ground + 3.5, anchor[2] + 0.5]);
await R(() => globalThis.__roboCraft.hold("stone-bricks"));
await R(() => globalThis.__roboCraft.scienceInteract());
console.log("status", (await R(() => globalThis.__roboCraft.science())).sites[0]?.status);
// the third-person camera sits behind the robot: aim a little to the robot's right so the plant
// stands beside it, and up, so the robot drops low in the frame; wait out the "houses lit" toast
await look([anchor[0] + 7, ground, anchor[2] - 5], [anchor[0] + 0.5, ground + 5.5, anchor[2] + 0.5]);
await R(() => {
  const g = globalThis.__roboCraft;
  const s = g.snapshot();
  g.look((s.yaw ?? 0) + 0.38, 0.32);
});
await wait(6500);
await frames(20);
await page.screenshot({ path: join(out, "hero-running.png") });
await page.keyboard.press("Tab");
await wait(900);
await page.screenshot({ path: join(out, "hero-board.png") });
await browser.close();
