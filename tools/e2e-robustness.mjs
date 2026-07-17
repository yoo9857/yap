// Robustness E2E: forged-move snapback, violation kick, server-restart
// auto-reconnect (solo play continues while offline).
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SERVER_ENTRY = "C:/robo/apps/server/src/index.ts";
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
  await page.goto("http://localhost:5173/?mode=tower", { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(
    () => document.getElementById("boot-overlay")?.classList.contains("hidden"),
    { timeout: 20000 },
  );
  await page.evaluate((n) => globalThis.__robo.startRun(n), name);
  await sleep(1500);
  return page;
}

// ---- 1. forged teleport gets snapped back by s-correction
const cheater = await openPlayer("치터");
await cheater.bringToFront();
const forged = await cheater.evaluate(() => {
  const s = globalThis.__robo.snapshot();
  globalThis.__robo.debugSend({
    t: "c-move",
    seq: 99999,
    pos: [s.feet[0], s.feet[1] + 100, s.feet[2]],
    vel: [0, 0, 0],
    yaw: 0,
    anim: "run",
    grounded: false,
  });
  return s.feet;
});
await sleep(600);
const afterForge = await cheater.evaluate(() => ({
  net: globalThis.__robo.net(),
  feet: globalThis.__robo.snapshot().feet,
}));
check(
  "forged +100 m move triggers a server correction",
  afterForge.net.corrections >= 1,
  `corrections=${afterForge.net.corrections}`,
);
check(
  "player stays at a legit position",
  Math.abs(afterForge.feet[1] - forged[1]) < 3,
  `y=${afterForge.feet[1].toFixed(1)} (was ${forged[1].toFixed(1)})`,
);

// ---- 2. repeated violations get the cheater kicked
await cheater.evaluate(() => {
  for (let i = 0; i < 20; i++) {
    globalThis.__robo.debugSend({
      t: "c-move",
      seq: 100000 + i,
      pos: [i % 2 === 0 ? 15 : -15, 50, 0],
      vel: [0, 0, 0],
      yaw: 0,
      anim: "run",
      grounded: false,
    });
  }
});
await sleep(1200);
const kicked = await cheater.evaluate(() => globalThis.__robo.net().state);
check("cheater is kicked and stays offline", kicked === "offline", `state=${kicked}`);
await cheater.close();

// ---- 3. server restart: reconnect banner + auto-rejoin, game keeps running
const honest = await openPlayer("성실이");
await honest.bringToFront();
const before = await honest.evaluate(() => globalThis.__robo.net().state);
check("honest player online before restart", before === "online");

// trigger a tsx-watch server restart by touching the entry file
const original = readFileSync(SERVER_ENTRY, "utf8");
appendFileSync(SERVER_ENTRY, "\n// e2e-restart-trigger\n");
await sleep(1200); // server goes down & comes back
writeFileSync(SERVER_ENTRY, original); // restore (triggers one more clean restart)

// while (re)connecting, solo play must continue: hold W and confirm movement
await honest.click("#app");
const posBefore = await honest.evaluate(() => globalThis.__robo.snapshot().feet);
await honest.keyboard.down("KeyW");
await sleep(800);
await honest.keyboard.up("KeyW");
const posAfter = await honest.evaluate(() => globalThis.__robo.snapshot().feet);
const moved = Math.hypot(posAfter[0] - posBefore[0], posAfter[2] - posBefore[2]);
check("solo play continues through the outage", moved > 2, `moved=${moved.toFixed(1)} m`);

// wait for auto-reconnect (backoff 0.5→8 s)
let finalState = "offline";
for (let i = 0; i < 30; i++) {
  await sleep(500);
  finalState = await honest.evaluate(() => globalThis.__robo.net().state);
  if (finalState === "online") break;
}
check("auto-reconnected after server restart", finalState === "online", `state=${finalState}`);

// daily records survive the restart (SQLite): the multiplayer E2E's finish
// must still be on the welcome board
await sleep(500);
const boardAfterRestart = await honest.evaluate(() => globalThis.__robo.net().board);
check(
  "daily records persist across server restarts",
  boardAfterRestart.some((e) => e.name === "영희"),
  JSON.stringify(boardAfterRestart),
);

await honest.close();
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
