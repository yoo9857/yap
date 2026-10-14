// Local browser acceptance: pnpm --filter @robo/client dev, then node tools/e2e-machines.mjs.
// Uses an isolated browser profile; never touches the player's browser saves.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import puppeteer from "puppeteer-core";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await puppeteer.launch({
  executablePath:
    process.env.BROWSER_PATH ??
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
try {
  await mkdir("tmp", { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const machine = () => page.evaluate(() => window.__roboCraft.machine());
  await page.goto(
    `${process.env.BASE_URL ?? "http://127.0.0.1:5173"}/?mode=craft`,
    { waitUntil: "networkidle2", timeout: 60000 },
  );
  await page.waitForFunction(() => !!window.__roboCraft, { timeout: 60000 });
  await page.click(".machine-launch");
  await page.waitForFunction(() => window.__roboCraft.machine().active);
  // First visit shows the coach strip; dismiss it so it never covers a control.
  await page.click('.machine-coach [data-id="skip"]');
  await page.waitForFunction(
    () => document.querySelector(".machine-coach").hidden,
  );
  await wait(600);
  await page.screenshot({ path: "tmp/machine-editor.png" });
  let state = await machine();
  assert.equal(state.blueprint.parts.length, 21);

  // ---- build ergonomics: hotkeys, rotation, mirror, undo/redo -------------
  await page.keyboard.press("Digit5");
  state = await machine();
  assert.equal(state.selected, "thruster", "number keys pick a part");
  await page.keyboard.press("KeyR");
  assert.equal((await machine()).direction, 1, "R rotates a directional part");
  await page.keyboard.press("KeyM");
  assert.equal((await machine()).mirror, false, "M toggles symmetry");
  await page.keyboard.press("KeyM");
  assert.equal((await machine()).mirror, true);
  await page.keyboard.press("KeyX");
  assert.equal((await machine()).erase, true, "X arms the eraser");
  await page.keyboard.press("Digit1");
  state = await machine();
  assert.equal(state.erase, false, "picking a part disarms the eraser");
  assert.equal(state.selected, "frame");
  console.log("PASS build shortcuts", {
    selected: state.selected,
    mirror: state.mirror,
  });

  // ---- blueprint library + share codes ------------------------------------
  await page.click('.machine-panel [data-tab="library"]');
  await page.click('.machine-panel [data-id="save"]');
  assert.ok((await machine()).library.length >= 1, "design goes to the shelf");
  const share = await page.$eval('[data-id="share"]', (el) => el.value);
  assert.ok(share.startsWith("CYM1."), "share code is exported");
  await page.click('.machine-panel [data-preset="plane"]');
  assert.notEqual((await machine()).blueprint.name, "초원 탐사차");
  await page.$eval(
    '[data-id="share"]',
    (el, code) => {
      el.value = code;
    },
    share,
  );
  await page.click('.machine-panel [data-id="import"]');
  assert.equal(
    (await machine()).blueprint.parts.length,
    21,
    "the rover comes back from its share code",
  );
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyZ");
  await page.keyboard.up("Control");
  assert.ok((await machine()).blueprint.parts.length > 0, "ctrl+z undoes");
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyY");
  await page.keyboard.up("Control");
  assert.equal((await machine()).blueprint.parts.length, 21, "ctrl+y redoes");
  console.log("PASS library and share round-trip", { share: share.length });

  // Keyboard focus in the name field must not trigger the B shortcut.
  await page.click('.machine-panel [data-id="name"]');
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("Build B rover");
  await page.keyboard.press("Tab");
  assert.equal((await machine()).active, true);

  // ---- test drive ----------------------------------------------------------
  await page.click('.machine-panel [data-id="run"]');
  await page.waitForFunction(() => !!window.__roboCraft.machine().simulation, {
    timeout: 60000,
  });
  await wait(2200);
  const start = (await machine()).simulation;
  await page.keyboard.down("KeyW");
  await wait(2600);
  await page.keyboard.up("KeyW");
  const driven = await machine();
  assert.ok(driven.simulation, "car stays in the simulation");
  assert.ok(
    Math.hypot(
      driven.simulation.position.x - start.position.x,
      driven.simulation.position.z - start.position.z,
    ) > 1,
    "car travels on the island",
  );
  assert.ok(driven.missions, "mission tracking runs with the drive");
  assert.ok(
    driven.missions.distance > 1 && driven.missions.topSpeed > 1,
    "mission progress accumulates",
  );
  assert.ok(
    driven.simulation.altitude >= 0 && driven.simulation.altitude < 8,
    "altitude is measured above the terrain",
  );
  console.log("PASS car motion", {
    distance: driven.missions.distance.toFixed(1),
    topSpeed: driven.missions.topSpeed.toFixed(1),
  });
  await page.screenshot({ path: "tmp/machine-driving.png" });

  await page.keyboard.press("KeyC");
  assert.equal((await machine()).camera, "orbit", "C cycles the camera");
  await page.keyboard.press("KeyC");
  assert.equal((await machine()).camera, "cockpit");
  await page.screenshot({ path: "tmp/machine-cockpit.png" });
  await page.keyboard.press("KeyC");
  assert.equal((await machine()).camera, "chase");
  await page.keyboard.press("KeyR");
  await wait(250);
  const respawned = (await machine()).simulation;
  assert.ok(
    Math.hypot(
      respawned.position.x - start.position.x,
      respawned.position.z - start.position.z,
    ) < 3,
    "R returns the machine to the start without ending the run",
  );
  console.log("PASS camera modes and respawn");

  await page.click('.machine-panel [data-id="run"]');
  assert.equal((await machine()).simulation, null);
  assert.ok(
    (await machine()).record.topSpeed > 0,
    "records persist after a run",
  );

  // ---- powered flight ------------------------------------------------------
  await page.click('.machine-panel [data-tab="library"]');
  await page.click('.machine-panel [data-preset="ship"]');
  await page.click('.machine-panel [data-id="run"]');
  await page.waitForFunction(() => !!window.__roboCraft.machine().simulation);
  const beforeLift = (await machine()).simulation.position.y;
  await page.keyboard.down("Space");
  await wait(2500);
  await page.keyboard.up("Space");
  const flying = (await machine()).simulation;
  assert.ok(
    flying.position.y > beforeLift + 1,
    "ship gains altitude under thrust",
  );
  console.log("PASS powered flight", { beforeLift, position: flying.position });
  await page.screenshot({ path: "tmp/machine-flying.png" });
  await page.click('.machine-panel [data-id="run"]');

  // ---- gliding wings -------------------------------------------------------
  await page.click('.machine-panel [data-tab="library"]');
  await page.click('.machine-panel [data-preset="plane"]');
  state = await machine();
  assert.ok(
    state.blueprint.parts.some((p) => p.kind === "wing"),
    "the plane preset uses wings",
  );
  await page.click('.machine-panel [data-id="run"]');
  await page.waitForFunction(() => !!window.__roboCraft.machine().simulation);
  await page.keyboard.down("Space");
  await wait(4000);
  const climbed = (await machine()).simulation;
  assert.ok(
    climbed.altitude > 8,
    `vertical thrust gets the wings into the air (${climbed.altitude.toFixed(1)} m)`,
  );
  // Tip it over like a quadcopter, then cut the lift and let the wings glide.
  await page.keyboard.down("ArrowUp");
  await wait(2000);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.up("Space");
  const cruising = (await machine()).simulation;
  await wait(3000);
  const glided = (await machine()).simulation;
  const travelled = Math.hypot(
    glided.position.x - cruising.position.x,
    glided.position.z - cruising.position.z,
  );
  assert.ok(
    travelled > 5, // a dead weight falls almost straight down from here
    `wings carry it forward with the lift off (${travelled.toFixed(1)} m)`,
  );
  assert.ok(glided.aeroLift > 0, "the wings are pushing up during the glide");
  await page.screenshot({ path: "tmp/machine-glider.png" });
  console.log("PASS wings glide", {
    climb: climbed.altitude.toFixed(1),
    travelled: travelled.toFixed(1),
    aeroLift: glided.aeroLift.toFixed(0),
  });
  await page.click('.machine-panel [data-id="run"]');

  // ---- exit and persistence ------------------------------------------------
  await page.click('.machine-panel [data-id="close"]');
  state = await machine();
  assert.equal(state.active, false);
  assert.equal(state.simulation, null);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__roboCraft);
  state = await machine();
  assert.equal(state.blueprint.name, "날개 활공기");
  assert.ok(state.record.runs >= 3, "every run is counted");
  assert.ok(state.library.length >= 1, "the shelf survives a reload");
  assert.deepEqual(errors, []);
  console.log("PASS stop, exit, storage round-trip, no browser errors");
} finally {
  await browser.close();
}
