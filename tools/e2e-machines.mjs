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
  await mkdir("output/garage-ui-refined", { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const machine = () => page.evaluate(() => window.__roboCraft.machine());
  const screen = (name) => page.click(`.mw-section[data-screen="${name}"]`);
  const visiblePanes = () => page.$$eval('[data-pane]', panes => panes.filter(pane => !pane.hidden).map(pane => pane.dataset.pane));
  await page.goto(
    `${process.env.BASE_URL ?? "http://localhost:5173"}/?mode=craft`,
    { waitUntil: "networkidle2", timeout: 60000 },
  );
  await page.waitForFunction(() => !!window.__roboCraft, { timeout: 60000 });
  // the loading screen covers the chip until the boot warm-up is done: a click before that is lost
  await page.waitForFunction(() => document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.click(".machine-launch");
  await page.waitForFunction(() => window.__roboCraft.machine().active);
  // First visit shows the coach strip; dismiss it so it never covers a control.
  await page.click('.machine-coach [data-id="skip"]');
  await page.waitForFunction(
    () => document.querySelector(".machine-coach").hidden,
  );
  await wait(600);
  await page.waitForFunction(() => window.__roboCraft.machine().assetsLoaded);
  await page.waitForFunction(() => [...document.querySelectorAll('.machine-panel img')].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: "tmp/machine-editor.png" });
  let state = await machine();
  assert.equal(state.blueprint.parts.length, 21);
  assert.deepEqual(await visiblePanes(), ['parts'], 'B opens the horizontal block workbench');
  assert.equal(state.mirror, true, 'symmetry is the default editing workflow');
  assert.equal(await page.$eval('[data-id="toolrow"]', el => el.hidden), false);
  assert.equal(await page.$eval('[data-id="run"]', el => el.hidden), false);
  assert.equal(await page.$eval('[data-id="advanced"]', el => el.open), false, 'less-used tools stay out of the main toolbar');

  // Navigation uses native button activation; Enter must not start a drive.
  await page.focus('.mw-section[data-screen="help"]');
  await page.keyboard.press('Enter');
  assert.deepEqual(await visiblePanes(), ['help']);
  assert.equal((await machine()).simulation, null);
  const beforeBrowse = JSON.stringify((await machine()).blueprint);
  await page.mouse.click(930, 480);
  await page.mouse.click(930, 480, {button:'right'});
  assert.equal(JSON.stringify((await machine()).blueprint), beforeBrowse, 'browsing cannot place or erase parts');
  await screen('parts');
  assert.deepEqual(await visiblePanes(), ['parts']);

  // Colour swatches and performance controls edit the actual selected part.
  await screen('tune');
  const wheelIndex = (await machine()).blueprint.parts.findIndex(part => part.kind === 'wheel');
  await page.select('[data-inspect-index]', String(wheelIndex));
  assert.equal((await machine()).editor.scope.mode, 'paired');
  assert.equal((await machine()).editor.scope.indices.length, 2);
  assert.equal(await page.$eval('.mw-mirror-note', element => element.dataset.scope), 'paired');
  const waitForThumbnail = (previous = '') => page.waitForFunction(before => {
    const src = document.querySelector('.mw-inspected-heading img')?.src;
    return src?.startsWith('data:image/') && src !== before;
  }, {}, previous);
  await waitForThumbnail();
  const originalThumbnail = await page.$eval('.mw-inspected-heading img', element => element.src);
  assert.ok(originalThumbnail.startsWith('data:image/'), 'the selected block uses a real rendered thumbnail');
  await page.click('[data-custom-option="color"][data-value="coral"]');
  await waitForThumbnail(originalThumbnail);
  const paintedThumbnail = await page.$eval('.mw-inspected-heading img', element => element.src);
  assert.notEqual(paintedThumbnail, originalThumbnail, 'the thumbnail follows the paint colour');
  assert.equal((await machine()).blueprint.parts.filter(part => part.custom?.color === 'coral').length, 2, 'mirror applies the selected colour to the opposite wheel');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.customOption), 'color', 'tuning preserves keyboard focus after rendering');
  await page.click('[data-tune-section="performance"]');
  assert.equal(await page.$('[data-custom-option="color"]'), null, 'colour and performance have separate editing sections');
  await page.click('[data-custom-option="radius"][data-value="large"]');
  assert.equal((await machine()).blueprint.parts[wheelIndex].custom.radius, 'large');
  await waitForThumbnail(paintedThumbnail);
  assert.notEqual(await page.$eval('.mw-inspected-heading img', element => element.src), paintedThumbnail, 'the thumbnail follows the wheel size');
  await screen('library');
  await screen('tune');
  assert.equal(await page.$eval('[data-inspect-index]', el => Number(el.value)), wheelIndex, 'screen switches retain the selected part');
  await page.click('[data-custom-reset]');
  assert.equal((await machine()).blueprint.parts[wheelIndex].custom, undefined);
  console.log('PASS garage screens, keyboard navigation and live tuning');

  // ---- build ergonomics: hotkeys, rotation, mirror, undo/redo -------------
  await screen('parts');
  await page.click('[data-filter="구동"]');
  assert.equal(await page.$$eval('[data-part]', buttons => buttons.filter(button => !button.hidden).length), 1, 'block categories filter the actual palette');
  await page.keyboard.press("Digit5");
  assert.equal(await page.$$eval('[data-part]', buttons => buttons.filter(button => !button.hidden).length), 8, 'a shortcut reveals a block outside the current category');
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
  const beforePlacement = (await machine()).blueprint;
  let attachmentPoint;
  const preview = await page.$eval('[data-id="preview-stage"]', element => {
    const bounds = element.getBoundingClientRect();
    return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height};
  });
  for (const [u, v] of [[.5,.5], [.54,.54], [.46,.5], [.57,.6], [.5,.65], [.42,.6]]) {
    const x = preview.x + preview.width * u, y = preview.y + preview.height * v;
    await page.mouse.move(x, y);
    const state = await machine();
    if (state.editor.placement && !state.blueprint.parts.some(part => part.cell.every((value, axis) => value === state.editor.placement[axis]))) {
      attachmentPoint = [x,y];
      break;
    }
  }
  assert.ok(attachmentPoint, 'the live preview offers an exposed block face');
  await page.mouse.click(...attachmentPoint);
  assert.ok((await machine()).blueprint.parts.length > beforePlacement.parts.length, 'clicking the live studio preview attaches a block');
  await page.click('[data-id="undo"]');
  assert.deepEqual((await machine()).blueprint, beforePlacement, 'undo restores the live preview placement');
  for (const view of ['front', 'side', 'top', 'fit']) await page.click(`[data-preview="${view}"]`);
  assert.deepEqual((await machine()).blueprint, beforePlacement, 'preview cameras never modify the machine');

  // ---- blueprint library + share codes ------------------------------------
  await screen('library');
  await page.click('.machine-panel [data-id="save"]');
  assert.ok((await machine()).library.length >= 1, "design goes to the shelf");
  const firstSave = (await machine()).library[0];
  const originalDesign = (await machine()).blueprint;
  await page.click('[data-id="save"]');
  assert.equal((await machine()).library.length, 2, 'saving the same name creates an independent copy');
  const names = await page.$$eval('[data-action="load"] > span', elements => elements.map(element => element.textContent));
  assert.equal(new Set(names).size, 2, 'duplicate names are numbered');
  for (let count = 2; count < 12; count++) await page.click('[data-id="save"]');
  const fullLibrary = (await machine()).library;
  await page.click('[data-id="save"]');
  assert.deepEqual((await machine()).library, fullLibrary, 'the thirteenth save never evicts another machine');
  assert.match(await page.$eval('[data-id="message"]', element => element.textContent), /12/);
  assert.equal(await page.$eval('[data-id="slot-count"]', element => element.textContent), '12 / 12');

  await page.$eval(`[data-action="replace"][data-slot="${firstSave}"]`, element => element.click());
  assert.equal(await page.$eval('[data-id="replace-dialog"]', element => element.open), true);
  assert.equal(await page.$eval('[data-id="replace-target"]', element => element.textContent), originalDesign.name);
  await page.keyboard.press('b');
  assert.equal((await machine()).active, true, 'game shortcuts stay inactive inside the save dialog');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[data-id="replace-dialog"]', element => element.open), false);
  assert.deepEqual((await machine()).library, fullLibrary, 'cancelling replacement leaves the library intact');
  await page.click('[data-preset="plane"]');
  await page.$eval(`[data-action="replace"][data-slot="${firstSave}"]`, element => element.click());
  await page.click('[data-id="replace-confirm"]');
  const previousVersion = (await machine()).recovery[0];
  assert.ok(previousVersion, 'the replaced version is recoverable');
  assert.equal((await machine()).library.length, 12);
  await page.click('[data-id="recovery"] > summary');
  await page.click(`[data-restore="${previousVersion}"]`);
  assert.equal((await machine()).recovery.length, 1, 'a full library keeps the recovery copy intact');
  await page.click('[data-id="recovery"] > summary');
  await page.$eval(`[data-action="delete"][data-slot="${firstSave}"]`, element => element.click());
  assert.equal((await machine()).library.length, 11);
  assert.equal((await machine()).recovery.length, 2, 'deletion moves the design into recovery');
  await page.click('[data-id="recovery"] > summary');
  await page.click(`[data-restore="${previousVersion}"]`);
  assert.equal((await machine()).library.length, 12);
  await page.click('[data-id="recovery"] > summary');
  await page.$eval(`[data-action="load"][data-slot="${previousVersion}"]`, element => element.click());
  assert.deepEqual((await machine()).blueprint, originalDesign, 'restoring brings back the exact previous design');
  await page.screenshot({ path: 'output/garage-ui-refined/library-protected.png' });
  console.log('PASS save copies, full-library protection, explicit replacement and recovery');
  await page.evaluate(() => {
    window.__garageCopiedCode = null;
    Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async code => {window.__garageCopiedCode=code;}}});
  });
  await page.click('[data-id="copy"]');
  const share = await page.evaluate(() => window.__garageCopiedCode);
  assert.ok(share.startsWith("CYM1."), "share code is exported");
  assert.equal(share, (await machine()).share, 'copy exports the current machine independently of the import draft');
  assert.equal(await page.$eval('[data-id="share-import"]', el => el.open), false, 'raw share codes stay behind the import action');
  await page.click('.machine-panel [data-preset="plane"]');
  assert.notEqual((await machine()).blueprint.name, "초원 탐사차");
  await page.click('[data-id="share-import"] > summary');
  await page.$eval('[data-id="share"]', element => {element.value='broken-code';});
  const beforeBadImport = (await machine()).blueprint;
  await page.click('[data-id="import"]');
  assert.equal(await page.$eval('[data-id="share-import"]', el => el.open), true, 'an invalid code keeps the import sheet open');
  assert.equal(await page.$eval('[data-id="share"]', el => el.value), 'broken-code', 'an invalid import preserves the draft');
  assert.deepEqual((await machine()).blueprint, beforeBadImport, 'an invalid code leaves the machine intact');
  await page.$eval(
    '[data-id="share"]',
    (el, code) => {
      el.value = code;
    },
    share,
  );
  await page.click('.machine-panel [data-id="import"]');
  assert.equal(await page.$eval('[data-id="share-import"]', el => el.open), false, 'a successful import closes the sheet');
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
  await screen('missions');
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
  await screen('library');
  await page.click('.machine-panel [data-preset="ship"]');
  await screen('missions');
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
  await screen('library');
  await page.click('.machine-panel [data-preset="plane"]');
  await screen('missions');
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

  // ---- beginner path: one click to fly, assist does the hard part ---------
  await screen('missions');
  await page.click('[data-quick="plane"]');
  await page.waitForFunction(() => !!window.__roboCraft.machine().simulation, {
    timeout: 60000,
  });
  assert.equal((await machine()).assist, true, "assist is on by default");
  await wait(1200);
  // Space alone. No pitch, no roll, no understanding of gyros required.
  await page.keyboard.down("Space");
  await wait(4000);
  await page.keyboard.up("Space");
  const lifted = (await machine()).simulation;
  assert.ok(
    lifted.altitude > 8,
    `Space alone gets a beginner airborne (${lifted.altitude.toFixed(1)} m)`,
  );
  await wait(4000);
  const hands_off = (await machine()).simulation;
  const drift = Math.abs(hands_off.altitude - lifted.altitude);
  const tilt = (() => {
    const q = hands_off.rotation;
    const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
    return (Math.acos(Math.max(-1, Math.min(1, uy))) * 180) / Math.PI;
  })();
  assert.ok(drift < 5, `hands off holds altitude (drifted ${drift.toFixed(1)} m)`);
  assert.ok(tilt < 8, `hands off stays level (${tilt.toFixed(1)} degrees)`);
  await page.keyboard.down("KeyZ");
  await wait(3000);
  await page.keyboard.up("KeyZ");
  assert.ok(
    (await machine()).simulation.altitude < hands_off.altitude - 2,
    "Z brings it back down",
  );
  await page.keyboard.press("KeyG");
  assert.equal((await machine()).assist, false, "G turns assist off mid-flight");
  await page.keyboard.press("KeyG");
  assert.equal((await machine()).assist, true);
  console.log("PASS  beginner flight", {
    climb: lifted.altitude.toFixed(1),
    drift: drift.toFixed(1),
    tilt: tilt.toFixed(1),
  });
  await page.screenshot({ path: "tmp/machine-assist.png" });
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
  assert.ok(state.recovery.length >= 1, "recovery versions survive a reload too");
  assert.deepEqual(errors, []);
  console.log("PASS stop, exit, storage round-trip, no browser errors");
} finally {
  await browser.close();
}
