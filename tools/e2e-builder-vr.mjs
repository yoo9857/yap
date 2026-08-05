// Builder VR E2E. Headless Edge exposes no XR device, so this drives the VR
// presentation through `__roboBuilder.vrPreview(true)` — the same rig, director,
// blinder, platform and plaque a headset gets, rendered to the flat screen.
// What it proves: the VR view builds and renders without errors, the rig is
// actually placed at the director's station facing the monument, cuts happen
// behind a black blinder, and leaving VR hands the camera back to the
// cinematic director.
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
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const pageErrors = [];
page.on("pageerror", (e) => {
  pageErrors.push(e.message);
  console.log("PAGEERROR:", e.message);
});
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

// ---- 1. ?vr=1 force-mounts the Enter VR button even with no device present
// domcontentloaded, not networkidle2: the builder holds a rAF loop and keeps
// fetching modules in dev, so network-idle is an unreliable signal here — the
// debug hook below is the real readiness gate.
await page.goto("http://localhost:5173/?mode=builder&vr=1&reset=1", {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await page.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 15000 });
// the button is mounted only after the GPU warmup completes
await page.waitForFunction(() => globalThis.__roboBuilder.vrStatus().buttonMounted, {
  timeout: 20000,
});
check("?vr=1 mounts the Enter VR button", true);
const vr0 = await page.evaluate(() => globalThis.__roboBuilder.vrStatus());
check("no session is presenting without a headset", vr0.presenting === false);
check("the VR view is inert until entered", vr0.station === null, `station=${vr0.station}`);

const status = () => page.evaluate(() => globalThis.__roboBuilder.vrStatus());

// ---- 2. entering the VR presentation places the rig at a station
await page.evaluate(() => globalThis.__roboBuilder.vrPreview(true));
await sleep(1500);
const vr1 = await status();
const STATIONS = ["plaza", "overlook", "frontier", "yard"];
check("a viewpoint station is active", STATIONS.includes(vr1.station), `station=${vr1.station}`);
check("the rig was moved off the origin", Math.hypot(vr1.rig[0], vr1.rig[2]) > 1, `rig=${vr1.rig}`);
check("the rig never sinks below the floor", vr1.rig[1] >= 0, `y=${vr1.rig[1]}`);

// the rig yaw must aim camera-forward (−Z) at the monument at the origin
const facing = await page.evaluate(() => {
  const s = globalThis.__roboBuilder.vrStatus();
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const d = Math.hypot(s.rig[0], s.rig[2]);
  // dot of the forward vector with the direction back to the origin
  return fx * (-s.rig[0] / d) + fz * (-s.rig[2] / d);
});
check("the viewpoint faces the monument", facing > 0.999, `dot=${facing.toFixed(5)}`);

// ---- 3. the headset's eye is above the rig floor (local-floor semantics)
check(
  "eye height sits above the station floor",
  vr1.eye[1] > vr1.rig[1],
  `eye=${vr1.eye[1].toFixed(2)} floor=${vr1.rig[1].toFixed(2)}`,
);

// ---- 4. the viewpoint is PERFECTLY still while visible (the comfort contract)
const before = await status();
await sleep(2500);
const after = await status();
const moved = Math.hypot(
  after.rig[0] - before.rig[0],
  after.rig[1] - before.rig[1],
  after.rig[2] - before.rig[2],
);
check(
  "the viewpoint does not drift while visible",
  moved === 0 && after.station === before.station,
  `moved=${moved} station=${after.station}`,
);
check("the blinder is clear during the dwell", after.blind === 0, `blind=${after.blind}`);

// ---- 5. a cut moves the viewpoint, and only from behind black.
// Reading the director's `blind` number only proves it INTENDS to black out; the
// comfort contract depends on the sphere actually occluding, so measure pixels.
// Screenshots are decoded in-page via a 2D canvas (no image deps needed), over a
// band that holds canvas rather than the DOM HUD strips.
async function canvasLuma() {
  const b64 = await page.screenshot({ encoding: "base64" });
  return page.evaluate(
    (data) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d");
          g.drawImage(img, 0, 0);
          const y0 = Math.round(img.height * 0.25);
          const px = g.getImageData(0, y0, img.width, Math.round(img.height * 0.35)).data;
          let sum = 0;
          for (let i = 0; i < px.length; i += 4) {
            sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          }
          resolve(sum / (px.length / 4));
        };
        img.src = `data:image/png;base64,${data}`;
      }),
    b64,
  );
}
const clearLuma = await canvasLuma();

await page.evaluate(() => globalThis.__roboBuilder.vrSkip());
// sample fast enough to catch the fade-out peak (0.5 s)
let peakBlind = 0;
let peakLuma = null;
for (let i = 0; i < 60; i++) {
  const s = await status();
  if (s.blind > peakBlind) {
    peakBlind = s.blind;
    peakLuma = await canvasLuma();
  }
  if (s.blind > 0.98) break;
  await sleep(10);
}
check("the cut is hidden behind a black blinder", peakBlind > 0.9, `peak=${peakBlind.toFixed(2)}`);
// a truly opaque overlay at opacity `blind` leaves clearLuma * (1 - blind)
const expectedLuma = clearLuma * (1 - peakBlind);
check(
  "the blinder actually occludes the world, not just in name",
  peakLuma !== null && peakLuma <= expectedLuma + 8,
  `luma ${clearLuma.toFixed(1)} → ${peakLuma === null ? "n/a" : peakLuma.toFixed(1)} (opaque would be ${expectedLuma.toFixed(1)})`,
);
await sleep(1200);
const vr2 = await status();
check("the cut landed on a different station", vr2.station !== before.station, `${before.station} → ${vr2.station}`);
check("the blinder clears again after the cut", vr2.blind === 0, `blind=${vr2.blind}`);

// ---- 6. the sim keeps running while in VR (it is still an idle game).
// Gold lands per worker DELIVERY, so hire a crew first — otherwise the sample
// window can fall entirely between two trips of a single worker.
await page.evaluate(() => {
  globalThis.__roboBuilder.addGold(5000);
  for (let i = 0; i < 4; i++) globalThis.__roboBuilder.buy("worker");
  globalThis.__roboBuilder.buy("speed");
});
const s0 = await page.evaluate(() => globalThis.__roboBuilder.snapshot());
await sleep(6000);
const s1 = await page.evaluate(() => globalThis.__roboBuilder.snapshot());
check("gold still accrues inside VR", s1.gold > s0.gold, `${s0.gold.toFixed(1)} → ${s1.gold.toFixed(1)}`);
check(
  "the monument keeps rising inside VR",
  s1.placedBlocks > s0.placedBlocks,
  `${s0.placedBlocks} → ${s1.placedBlocks} blocks`,
);

// ---- 6b. the completion parade must describe the VIEW landmark. The sim moves
// on and resets placedBlocks the moment a landmark finishes, so a naive read
// drops the frontier deck to ground level in front of a finished monument.
await page.evaluate(() => {
  const b = globalThis.__roboBuilder;
  b.vrPreview(false);
  b.jumpTo(3, 1); // Eiffel, complete → the sim rolls over into a parade
  b.vrPreview(true);
});
// wait for the parade to actually be running (view landmark behind the sim's)
await page.waitForFunction(
  () => globalThis.__roboBuilder.viewLandmarkIndex() !== globalThis.__roboBuilder.snapshot().landmarkIndex,
  { timeout: 15000 },
);
// hold the frontier deck station so we can read its height during the parade
let paradeDeckY = null;
for (let i = 0; i < 60; i++) {
  const s = await status();
  if (s.station === "frontier") {
    paradeDeckY = s.rig[1];
    break;
  }
  await page.evaluate(() => globalThis.__roboBuilder.vrSkip());
  await sleep(1400);
}
check(
  "the frontier deck stays high during a completion parade",
  paradeDeckY !== null && paradeDeckY > 100,
  `deck y=${paradeDeckY === null ? "station never came up" : paradeDeckY.toFixed(1)}`,
);

// ---- 6c. the wrist shop panel: without it a VR session cannot progress at
// all — gold piles up while the build rate stays frozen. Headless Edge has no
// controller poses, so press the buttons through the same handler the ray uses.
const panel0 = await page.evaluate(() => globalThis.__roboBuilder.vrPanelState());
check("the wrist panel is mounted in VR", panel0.mounted === true);
check(
  "no controller is reported without a headset",
  panel0.hasPointer === false && panel0.hasWrist === false,
);

await page.evaluate(() => globalThis.__roboBuilder.addGold(100000));
const buy0 = await page.evaluate(() => globalThis.__roboBuilder.snapshot());
await page.evaluate(() => {
  globalThis.__roboBuilder.vrPress("worker");
  globalThis.__roboBuilder.vrPress("speed");
  globalThis.__roboBuilder.vrPress("value");
  globalThis.__roboBuilder.vrPress("crane");
});
const buy1 = await page.evaluate(() => globalThis.__roboBuilder.snapshot());
check(
  "every upgrade is purchasable from inside VR",
  buy1.workers === buy0.workers + 1 &&
    buy1.speedLevel === buy0.speedLevel + 1 &&
    buy1.valueLevel === buy0.valueLevel + 1 &&
    buy1.crane === true,
  `crew ${buy0.workers}→${buy1.workers} spd ${buy0.speedLevel}→${buy1.speedLevel} val ${buy0.valueLevel}→${buy1.valueLevel} crane=${buy1.crane}`,
);
check("gold was actually spent", buy1.gold < buy0.gold, `${buy0.gold.toFixed(0)} → ${buy1.gold.toFixed(0)}`);
const toastAfterBuy = await page.evaluate(() => globalThis.__roboBuilder.vrPanelState().toast);
check("a purchase is confirmed on the panel", !!toastAfterBuy, `toast=${toastAfterBuy}`);

// buying the crane twice must not charge again
const craneAgain = await page.evaluate(() => {
  const before = globalThis.__roboBuilder.snapshot().gold;
  globalThis.__roboBuilder.vrPress("crane");
  return { before, after: globalThis.__roboBuilder.snapshot().gold };
});
check(
  "an already-owned upgrade cannot be bought twice",
  craneAgain.after === craneAgain.before,
  `${craneAgain.before.toFixed(0)} → ${craneAgain.after.toFixed(0)}`,
);

// an unaffordable press must be refused, not go negative
const broke = await page.evaluate(() => {
  const b = globalThis.__roboBuilder;
  const s = b.snapshot();
  b.addGold(-s.gold); // drain the wallet
  const before = b.snapshot();
  b.vrPress("worker");
  return { before, after: b.snapshot(), toast: b.vrPanelState().toast };
});
check(
  "an unaffordable purchase is refused and never goes negative",
  broke.after.workers === broke.before.workers && broke.after.gold >= 0,
  `crew ${broke.before.workers}→${broke.after.workers} gold=${broke.after.gold.toFixed(1)} toast=${broke.toast}`,
);

// the "next view" button must cut the viewpoint, behind the blinder as always
const stationBeforePress = (await status()).station;
await page.evaluate(() => globalThis.__roboBuilder.vrPress("next"));
let pressPeakBlind = 0;
for (let i = 0; i < 60; i++) {
  const s = await status();
  pressPeakBlind = Math.max(pressPeakBlind, s.blind);
  if (s.blind > 0.98) break;
  await sleep(10);
}
await sleep(1200);
const stationAfterPress = (await status()).station;
check(
  "the Next view button cuts the viewpoint from behind the blinder",
  stationAfterPress !== stationBeforePress && pressPeakBlind > 0.9,
  `${stationBeforePress} → ${stationAfterPress}, peak blind=${pressPeakBlind.toFixed(2)}`,
);

// ---- 7. leaving VR hands the camera back to the cinematic director
await page.evaluate(() => globalThis.__roboBuilder.vrPreview(false));
await sleep(600);
const vr3 = await status();
check("the VR view is torn down", vr3.station === null && vr3.rig === null);
const eyeA = (await status()).eye;
await sleep(1200);
const eyeB = (await status()).eye;
const flatMoved = Math.hypot(eyeB[0] - eyeA[0], eyeB[1] - eyeA[1], eyeB[2] - eyeA[2]);
check("the flat-screen camera is animating again", flatMoved > 0.001, `moved=${flatMoved.toFixed(4)}`);

// ---- 7b. entering VR must not seal the player inside a frozen world: the
// welcome-back modal pauses the sim and is DOM-only, so it is invisible in a
// headset — and the VR button sits above it and stays clickable.
// Own browser context so the main page's 5-second autosave can't interfere.
const ctx = await browser.createBrowserContext();
// 1. play briefly so a save exists, then CLOSE the game page — while it lives it
//    keeps saving with a fresh timestamp, and its save-on-hidden handler would
//    also overwrite the timestamp we are about to age.
const seed = await ctx.newPage();
await seed.goto("http://localhost:5173/?mode=builder&reset=1", {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await seed.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 15000 });
await seed.evaluate(() => globalThis.__roboBuilder.saveNow());
await seed.close();

// 2. age the save from a page that is NOT running the builder (the mode
//    selector), so nothing re-saves over it before the next navigation
const modalPage = await ctx.newPage();
await modalPage.setViewport({ width: 1280, height: 800 });
await modalPage.goto("http://localhost:5173/", { waitUntil: "domcontentloaded", timeout: 30000 });
const aged = await modalPage.evaluate(() => {
  const KEY = "robo-builder-save-v1";
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  const s = JSON.parse(raw);
  s.savedAtMs = Date.now() - 3 * 60 * 60 * 1000; // a 3-hour absence
  localStorage.setItem(KEY, JSON.stringify(s));
  return true;
});
check("a builder save exists to age", aged);

// 3. now boot the builder: it should settle the absence and raise the modal
await modalPage.goto("http://localhost:5173/?mode=builder&vr=1", {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await modalPage.waitForFunction(() => !!globalThis.__roboBuilder, { timeout: 15000 });
const modalUp = await modalPage.evaluate(
  () => !!document.querySelector(".screen") && globalThis.__roboBuilder.snapshot().paused,
);
check("welcome-back modal pauses the sim", modalUp);
if (modalUp) {
  await modalPage.evaluate(() => globalThis.__roboBuilder.vrPreview(true));
  await sleep(300);
  const freed = await modalPage.evaluate(() => ({
    modal: !!document.querySelector(".screen"),
    paused: globalThis.__roboBuilder.snapshot().paused,
  }));
  check(
    "entering VR dismisses the modal and unpauses",
    !freed.modal && !freed.paused,
    `modal=${freed.modal} paused=${freed.paused}`,
  );
}
await ctx.close();

// ---- 8. nothing threw anywhere along the way
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
