import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({
  executablePath:
    process.env.BROWSER_PATH ??
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
try {
  await mkdir("tmp/science", { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `${process.env.BASE_URL ?? "http://localhost:5173"}/?mode=craft`,
    { waitUntil: "networkidle2", timeout: 60000 },
  );
  await page.waitForFunction(() => window.__roboCraft?.machine().assetsLoaded);
  await page.click(".machine-launch");
  await page.click('[data-id="science"]');
  await page.waitForFunction(
    () => window.__roboCraft.machine().science?.active,
  );
  await page.screenshot({ path: "tmp/science/incline-ready.png" });
  await page.type(
    '.science-lab [data-id="prediction"]',
    "기어비가 크면 같은 토크로 더 큰 구동력을 얻을 것이다.",
  );
  const run = async () => {
    await page.click('.science-lab [data-id="run"]');
    await page.waitForFunction(
      () => window.__roboCraft.machine().science.running,
    );
  };
  const done = async () => {
    await page.waitForFunction(
      () => !window.__roboCraft.machine().science.running,
      { timeout: 25000 },
    );
  };
  await run();
  assert.equal(
    await page.$eval(".lab-side", (e) => getComputedStyle(e).display),
    "none",
  );
  await done();
  let snap = await page.evaluate(() => window.__roboCraft.machine().science);
  assert.deepEqual(
    snap.incline.map((s) => s.distance.toFixed(2)),
    ["0.00", "6.00"],
  );
  assert.deepEqual(
    snap.incline.map((s) => s.time),
    [5, 5],
  );
  await page.screenshot({ path: "tmp/science/incline-comparison.png" });
  console.log(
    "PASS gear comparison",
    snap.incline.map((s) => ({ force: s.wheelForce, distance: s.distance })),
  );
  await page.click('[data-mode="dust"]');
  await run();
  await done();
  snap = await page.evaluate(() => window.__roboCraft.machine().science);
  assert.ok(snap.dust.captured > 150);
  const captured = snap.dust.captured;
  await page.screenshot({ path: "tmp/science/dust-filter.png" });
  await page.click('[data-field="filter"]');
  await run();
  await done();
  snap = await page.evaluate(() => window.__roboCraft.machine().science);
  assert.equal(snap.dust.captured, 0);
  assert.ok(snap.dust.escaped > 200);
  console.log("PASS filtration", {
    connected: captured,
    disconnected: snap.dust.captured,
    escaped: snap.dust.escaped,
  });
  await page.click('[data-mode="energy"]');
  for (const source of ["wind", "battery", "hydrogen", "fuel"]) {
    await page.select('[data-field="source"]', source);
    snap = await page.evaluate(() => window.__roboCraft.machine().science);
    assert.ok(
      Math.abs(snap.energy.outputWatts + snap.energy.lossWatts - 100) < 0.001,
    );
  }
  await page.select('[data-field="source"]', "hydrogen");
  await run();
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: "tmp/science/hydrogen.png" });
  await page.click('[data-mode="ascent"]');
  await run();
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: "tmp/science/boarding.png" });
  await done();
  snap = await page.evaluate(() => window.__roboCraft.machine().science);
  assert.equal(snap.ascent.phase, "ascent");
  assert.equal(snap.ascent.spaceBlend, 1);
  assert.ok(snap.ascent.altitude > 100);
  await page.screenshot({ path: "tmp/science/ascent.png" });
  console.log("PASS energy paths and boarding/ascent", snap.ascent);
  await page.click('[data-mode="incline"]');
  assert.match(
    await page.$eval('.science-lab [data-id="prediction"]', (e) => e.value),
    /기어비/,
  );
  await page.click('.science-lab [data-id="close"]');
  assert.equal(
    await page.evaluate(() => window.__roboCraft.machine().science.active),
    false,
  );
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(() => window.__roboCraft?.machine().assetsLoaded);
  await page.click(".machine-launch");
  await page.click('[data-id="science"]');
  await page.waitForFunction(
    () => window.__roboCraft.machine().science?.active,
  );
  assert.match(
    await page.$eval('.science-lab [data-id="prediction"]', (e) => e.value),
    /기어비/,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    "tmp/science/acceptance.json",
    JSON.stringify(
      {
        passed: true,
        errors,
        checked: [
          "shared conditions",
          "0m / 6m",
          "hidden running settings",
          "dust captured / escaped",
          "four energy paths",
          "boarding / ascent / camera",
          "notes reload",
        ],
      },
      null,
      2,
    ),
  );
  console.log("PASS notes persisted; zero browser exceptions");
} finally {
  await browser.close();
}
