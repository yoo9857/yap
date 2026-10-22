// Pet E2E: the pet spawns, comes to heel after the player moves away, sits and
// holds on P, is recalled when stranded, survives the machine lab, and every
// adoptable species can be adopted, followed and reloaded.
// Needs `pnpm dev` running; drives dev debug hooks (__roboCraft.pet()).
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

await page.goto("http://localhost:5173/?mode=craft&reset=1", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
await wait(3000);

const probe = () => page.evaluate(() => globalThis.__roboCraft.pet());
const key = (k, code) =>
  page.evaluate((k2, c) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k2, code: c, bubbles: true })), k, code);

const start = await probe();
check(
  "the puppy spawns on the ground beside the player",
  start.grounded && start.gap < 4 && start.mode === "follow",
  JSON.stringify({ gap: +start.gap.toFixed(2), grounded: start.grounded }),
);

// --- comes to heel ---------------------------------------------------------
await page.evaluate(() => globalThis.__roboCraft.teleport(60.5, 20, 60.5));
await wait(1500);
const away = await probe();
check("the player can get away from it", away.gap > 6, `gap ${away.gap.toFixed(1)} m`);

// 14 s covers both routes to heel: walking it, or — if the island put a
// two-block wall in the way — hopping, sidestepping, and finally the give-up
// recall at LOST_TIME. A companion must arrive one way or the other.
await wait(14000);
const heel = await probe();
check("it closes the gap and comes to heel", heel.gap < 3.2, `gap ${heel.gap.toFixed(2)} m`);

// --- stay holds ------------------------------------------------------------
await key("p", "KeyP");
await wait(400);
const sat = await probe();
check("P puts it in stay", sat.mode === "stay");

await page.evaluate(() => globalThis.__roboCraft.teleport(40.5, 20, 40.5));
await wait(4000);
const stayed = await probe();
const moved = Math.hypot(stayed.pos[0] - sat.pos[0], stayed.pos[2] - sat.pos[2]);
check("stay holds it in place no matter how far the player goes", moved < 1.5, `moved ${moved.toFixed(2)} m`);

// --- recall when hopelessly far -------------------------------------------
await key("p", "KeyP");
await wait(400);
check("P puts it back into follow", (await probe()).mode === "follow");

await page.evaluate(() => globalThis.__roboCraft.teleport(120.5, 20, 120.5));
await wait(3000);
const recalled = await probe();
check(
  "a hopeless distance recalls it rather than stranding it",
  recalled.gap < 4,
  `gap ${recalled.gap.toFixed(2)} m`,
);

// --- the machine lab hides it ---------------------------------------------
await key("b", "KeyB");
await wait(1500);
const hidden = await page.evaluate(() => ({
  pet: globalThis.__roboCraft.pet(),
  chip: getComputedStyle(document.querySelector('[data-id="pet-chip"]')).display,
}));
check("entering the machine lab leaves the pet simulation alone", Number.isFinite(hidden.pet.gap));
check("the machine lab hides the adopt chip", hidden.chip === "none", hidden.chip);
await key("b", "KeyB");
await wait(1500);

// --- the adoption panel ----------------------------------------------------
const chipOpen = await page.evaluate(() => {
  document.querySelector('[data-id="pet-chip"]').click();
  return {
    open: globalThis.__roboCraft.petShopOpen(),
    cards: [...document.querySelectorAll("[data-species]")].map((el) => el.dataset.species),
    locked: document.pointerLockElement !== null,
  };
});
check("the chip opens a card for every species", chipOpen.open && chipOpen.cards.length >= 5, chipOpen.cards.join(","));
check("opening the panel releases pointer lock", chipOpen.locked === false);

for (const species of chipOpen.cards) {
  const adopted = await page.evaluate((s2) => {
    document.querySelector(`[data-id="pet-card-${s2}"]`).click();
    return globalThis.__roboCraft.pet();
  }, species);
  check(`adopting ${species} swaps the companion in place`, adopted.species === species, adopted.species);
}

// The last adopted species has to still be able to do the job.
const last = chipOpen.cards[chipOpen.cards.length - 1];
await page.evaluate(() => globalThis.__roboCraft.teleport(44.5, 20, 78.5));
await wait(14000);
const followed = await probe();
check(`a ${last} still comes to heel`, followed.gap < 3.5, `gap ${followed.gap.toFixed(2)} m`);

// --- the adoption persists -------------------------------------------------
await page.evaluate(() => globalThis.__roboCraft.saveNow());
await page.goto("http://localhost:5173/?mode=craft", { waitUntil: "networkidle2", timeout: 30000 });
await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
await wait(2500);
const reloaded = await probe();
check("the adopted species survives a reload", reloaded.species === last, `${reloaded.species} (wanted ${last})`);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
