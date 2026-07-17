// E2E mechanics verification: rides a moving platform, triggers a crumble,
// dies on the kill plane & a hazard, activates a checkpoint, reaches the goal.
// Drives the real game in headless Edge through the DEV __robo debug API.
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(
  () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
  { timeout: 20000 },
);
await page.click("#app");
await page.evaluate(() => {
  globalThis.__robo.startRun("테스트");
  // this suite tests LOCAL physics — go offline so server sanity corrections
  // (which rightly reject raw test teleports) can't yank the player around
  globalThis.__robo.offline();
});

const snap = () => page.evaluate(() => globalThis.__robo.snapshot());
const level = await page.evaluate(() => globalThis.__robo.level());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const teleportOnto = async (id) => {
  await page.evaluate((pid) => {
    const pos = globalThis.__robo.platformPos(pid);
    const p = globalThis.__robo.level().find((q) => q.id === pid);
    globalThis.__robo.sendRespawn("death"); globalThis.__robo.teleport(pos[0], pos[1] + p.size[1] / 2 + 0.05, pos[2]);
  }, id);
};

// ---- 1. moving platform ride: stand still 3 s, must stay aboard & oscillate
const moving = level.find((p) => p.kind === "moving");
await teleportOnto(moving.id);
await sleep(400);
const ridePositions = [];
for (let i = 0; i < 10; i++) {
  await sleep(300);
  const s = await snap();
  ridePositions.push(s.feet);
}
const rideYs = ridePositions.map((f) => f[1]);
const stayedOn = rideYs.every((y) => Math.abs(y - rideYs[0]) < 0.6);
const planarTravel = Math.max(
  ...ridePositions.map((f) => Math.hypot(f[0] - ridePositions[0][0], f[2] - ridePositions[0][2])),
);
check("moving platform: stays aboard for 3 s", stayedOn, `yΔ=${(Math.max(...rideYs) - Math.min(...rideYs)).toFixed(3)}`);
check("moving platform: carried along the swing", planarTravel > 0.8, `travel=${planarTravel.toFixed(2)} m`);

// ---- 2. crumbling platform: stand on it → collapses → we fall
const crumb = level.find((p) => p.kind === "crumbling");
await teleportOnto(crumb.id);
await sleep(300); // land + trigger shake
const before = await snap();
await sleep(800); // shake (0.55 s) + collapse
const after = await snap();
check(
  "crumbling platform: collapses under the player",
  after.feet[1] < before.feet[1] - 1,
  `y ${before.feet[1].toFixed(1)} → ${after.feet[1].toFixed(1)}`,
);

// falling in open air lands on the baseplate (Tower of Hell rule: falls
// don't kill you above the baseplate — you just climb again). Drop outside
// the tower column so no platform can catch us on the way down.
await page.evaluate(() => globalThis.__robo.teleport(14, 8, 14));
await sleep(2500);
const afterFall = await snap();
check(
  "falling in open air lands safely on the baseplate",
  afterFall.status === "alive" && Math.abs(afterFall.feet[1]) < 0.5,
  `feet.y=${afterFall.feet[1].toFixed(2)} status=${afterFall.status}`,
);

// ---- 3. hazard brick kills
const hazardP = level.find((p) => p.hazard);
if (hazardP) {
  const fallsBefore = (await snap()).falls;
  await page.evaluate((h) => {
    globalThis.__robo.sendRespawn("death"); globalThis.__robo.teleport(h.center[0], h.center[1] + 0.4, h.center[2]);
  }, hazardP.hazard);
  await sleep(400);
  const s = await snap();
  check("hazard: lava brick kills on touch", s.falls > fallsBefore || s.status === "dead", `falls=${s.falls} status=${s.status}`);
  await sleep(1500); // let respawn finish
} else {
  check("hazard: lava brick kills on touch", false, "no hazard in level (unexpected)");
}

// ---- 4. checkpoint activation
const cp0 = await page.evaluate(() => globalThis.__robo.checkpoints()[0]);
await page.evaluate((c) => {
  globalThis.__robo.sendRespawn("death");
  globalThis.__robo.teleport(c.center[0], c.center[1] + 0.1, c.center[2]);
}, cp0);
await sleep(400);
const sCp = await snap();
check("checkpoint 0 activates on touch", sCp.checkpoint === 0, `checkpoint=${sCp.checkpoint}`);

// ---- 5. respawn returns to checkpoint (not spawn) after death
await page.evaluate(() => {
  globalThis.__robo.sendRespawn("death");
  globalThis.__robo.teleport(0, -14, 0);
});
await sleep(1800);
const sResp = await snap();
const nearCp = Math.hypot(sResp.feet[0] - cp0.center[0], sResp.feet[2] - cp0.center[2]) < 2;
check("death after checkpoint respawns at the checkpoint", sResp.status === "alive" && nearCp, `feet=[${sResp.feet.map((v) => v.toFixed(1)).join(",")}] cp=[${cp0.center.map((v) => v.toFixed(1)).join(",")}]`);

// ---- 6. goal is BLOCKED until every checkpoint is collected
const goal = await page.evaluate(() => globalThis.__robo.goal());
await page.evaluate((g) => {
  globalThis.__robo.teleport(g.center[0], g.center[1] + 0.1, g.center[2]);
}, goal);
await sleep(400);
const sBlocked = await snap();
check(
  "goal without all checkpoints does NOT finish (blocked)",
  sBlocked.status === "alive",
  `status=${sBlocked.status}`,
);

// collect the remaining checkpoints, then the goal must finish
const allCps = await page.evaluate(() => globalThis.__robo.checkpoints());
for (const cp of allCps) {
  await page.evaluate((c) => {
    globalThis.__robo.teleport(c.center[0], c.center[1] + 0.1, c.center[2]);
  }, cp);
  await sleep(350);
}
await page.evaluate((g) => {
  globalThis.__robo.teleport(g.center[0], g.center[1] + 0.1, g.center[2]);
}, goal);
await sleep(400);
const sGoal = await snap();
check("goal after all checkpoints finishes the run", sGoal.status === "finished", `status=${sGoal.status}`);

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
