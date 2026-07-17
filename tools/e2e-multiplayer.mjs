// Multiplayer E2E: two headless tabs join the same daily room, see each
// other's ghost move, and race to a PERSISTED daily-board entry. The climb
// uses small hops that respect the server's speed envelope (the old
// respawn-teleport trick is now — correctly — rejected as cheating).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});

async function openPlayer(name) {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`PAGEERROR(${name}):`, e.message));
  await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
    { timeout: 20000 },
  );
  await page.evaluate((n) => globalThis.__robo.startRun(n), name);
  return page;
}

/**
 * Glide continuously toward a target with 60 ms micro-steps at sustained
 * rates the validator's kinematic envelope always permits (planar ≤5 m/s,
 * climb ≤8 m/s — far under the 15.7 / 32 m/s caps, so no message-arrival
 * jitter window can ever trip a violation). Discrete teleport hops are —
 * correctly — punished as cheating, so tests move like a fast player.
 */
async function glideTo(page, target) {
  const PLANAR_SPEED = 5;
  const CLIMB_SPEED = 8;
  const STEP_MS = 60;
  for (let i = 0; i < 600; i++) {
    const feet = await page.evaluate(() => globalThis.__robo.snapshot().feet);
    const dx = target[0] - feet[0];
    const dy = target[1] - feet[1];
    const dz = target[2] - feet[2];
    const planar = Math.hypot(dx, dz);
    if (planar < 0.4 && Math.abs(dy) < 0.8) return true;
    const pStep = Math.min(planar, PLANAR_SPEED * (STEP_MS / 1000));
    const yStep = Math.min(Math.max(dy, -0.6), CLIMB_SPEED * (STEP_MS / 1000));
    const scale = planar > 1e-6 ? pStep / planar : 0;
    await page.evaluate(
      (x, y, z) => globalThis.__robo.teleport(x, y, z),
      feet[0] + dx * scale,
      feet[1] + yStep,
      feet[2] + dz * scale,
    );
    await sleep(STEP_MS);
  }
  return false;
}

const alice = await openPlayer("영희");
const bob = await openPlayer("철수");
await alice.bringToFront();
await sleep(2500);

// 1. both online, same daily tower, both count 2 players
const netA = await alice.evaluate(() => globalThis.__robo.net());
const netB = await bob.evaluate(() => globalThis.__robo.net());
const dailyA = await alice.evaluate(() => globalThis.__robo.daily());
const dailyB = await bob.evaluate(() => globalThis.__robo.daily());
check("both clients online", netA.state === "online" && netB.state === "online", `A=${netA.state} B=${netB.state}`);
check("both see 2 players", netA.playerCount === 2 && netB.playerCount === 2, `A=${netA.playerCount} B=${netB.playerCount}`);
check(
  "identical daily tower on both clients",
  dailyA.seed === dailyB.seed && dailyA.dateStr === dailyB.dateStr,
  `A=#${dailyA.dayNumber}(${dailyA.seed}) B=#${dailyB.dayNumber}(${dailyB.seed})`,
);
check("bob sees alice's ghost by name", netB.remotes.some((r) => r.name === "영희"), JSON.stringify(netB.remotes.map((r) => r.name)));

// 2. SHARED PLATFORM TIMELINE: both clients must evaluate the analytic
//    platform positions at (nearly) the same server-time instant. We compare
//    the timeline TARGETS (mesh positions freeze in backgrounded tabs — the
//    browser pauses rAF — so they can't be compared directly across 2 tabs).
let maxTimelineDiff = 0;
for (let i = 0; i < 5; i++) {
  const [ta, tb] = await Promise.all([
    alice.evaluate(() => globalThis.__robo.timelineTarget()),
    bob.evaluate(() => globalThis.__robo.timelineTarget()),
  ]);
  maxTimelineDiff = Math.max(maxTimelineDiff, Math.abs(ta - tb));
  await sleep(300);
}
// 50 ms timeline agreement → same platform within ~0.24 m at max swing speed
check(
  "shared platform timeline agrees across clients",
  maxTimelineDiff < 0.05,
  `max Δt=${(maxTimelineDiff * 1000).toFixed(1)} ms`,
);

// 3. alice runs forward; her ghost on bob's screen must follow
await alice.click("#app");
await alice.keyboard.down("KeyW");
await sleep(1500);
await alice.keyboard.up("KeyW");
await sleep(400);
const alicePos = await alice.evaluate(() => globalThis.__robo.snapshot().feet);
const runClockStart = Date.now();
await bob.bringToFront();
await sleep(600);
const ghostOnBob = await bob.evaluate(() => globalThis.__robo.net().remotes.find((r) => r.name === "영희")?.pos);
const ghostDist = ghostOnBob
  ? Math.hypot(alicePos[0] - ghostOnBob[0], alicePos[2] - ghostOnBob[2])
  : Infinity;
check("ghost tracks the real player", ghostDist < 1.5, `dist=${ghostDist.toFixed(2)} m`);

// 4. alice climbs to every checkpoint within the speed envelope, waits out
//    the minimum finish time, and finishes on the goal pad
await alice.bringToFront();
const cps = await alice.evaluate(() => globalThis.__robo.checkpoints());
const meta = await alice.evaluate(() => globalThis.__robo.levelMeta());
for (const cp of cps) {
  const ok = await glideTo(alice, [cp.center[0], cp.center[1] + 0.1, cp.center[2]]);
  if (!ok) console.log(`WARN: glide to checkpoint ${cp.index} did not converge`);
  await sleep(400);
}
const cpState = await alice.evaluate(() => globalThis.__robo.snapshot().checkpoint);
check("alice collected all checkpoints", cpState === cps.length - 1, `checkpoint=${cpState}`);

const minMs = meta.minFinishSeconds * 1000 + 2000;
const elapsed = Date.now() - runClockStart;
if (elapsed < minMs) await sleep(minMs - elapsed);

const goal = await alice.evaluate(() => globalThis.__robo.goal());
await glideTo(alice, [goal.center[0], goal.center[1] + 0.1, goal.center[2]]);
await sleep(1200);
const statusA = await alice.evaluate(() => globalThis.__robo.snapshot().status);
const boardA = await alice.evaluate(() => globalThis.__robo.net().board);
const boardB = await bob.evaluate(() => globalThis.__robo.net().board);
check("alice finished", statusA === "finished", `status=${statusA}`);
check(
  "persisted daily board shows 영희 at rank 1 on BOTH clients",
  boardA.length >= 1 &&
    boardA[0].rank === 1 &&
    boardA[0].name === "영희" &&
    JSON.stringify(boardA) === JSON.stringify(boardB),
  `A=${JSON.stringify(boardA)} B=${JSON.stringify(boardB)}`,
);

// 5. leave: closing bob's tab removes his ghost from alice
await bob.close();
await sleep(800);
const netA2 = await alice.evaluate(() => globalThis.__robo.net());
check("leaving player disappears", netA2.playerCount === 1, `count=${netA2.playerCount}`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
