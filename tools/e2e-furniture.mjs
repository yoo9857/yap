// Furniture E2E: the 🛋️ chip opens the catalog (category tabs, search, colour
// swatches) and releases pointer lock; a card or swatch picks a piece and goes
// straight back into play; G / 1-9 / Q-E / X drive the furniture bar without
// the mouse; floor, rug, surface and wall pieces place under their own rules
// (and refuse overlaps / thin air / blocks); a real held left click puts a
// picture away; what stood on a piece goes with it and mining a wall drops its
// picture; pieces survive the education field scrolling and a reload; the
// machine lab hides the chip.
// Needs `pnpm dev` running; drives dev debug hooks (__roboCraft.furniture*).
//   node tools/e2e-furniture.mjs [screenshot.png]
import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const SHOT = process.argv[2] ?? null;
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// capture the mouse as a player does: the start/pause card's play button, or the scene
const capture = async () => {
  if (await page.evaluate(() => !document.querySelector(".game-menu")?.classList.contains("hidden"))) await page.click('[data-id="gm-play"]');
  else await page.mouse.click(640, 500);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));

const boot = async (reset) => {
  await page.goto(`http://localhost:5173/?mode=field${reset ? "&reset=1" : ""}`, {
    waitUntil: "networkidle2",
    timeout: 30000,
  });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 15000 });
  await wait(2500);
};
await boot(true);

/** Run `fn(__roboCraft, ...args)` in the page. */
const craft = (fn, ...args) =>
  page.evaluate((src, a) => new Function("c", "a", `return (${src})(c, ...a)`)(globalThis.__roboCraft, a), fn.toString(), args);
const press = (k, code) =>
  page.evaluate((k2, c) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k2, code: c, bubbles: true })), k, code);
const state = () => craft((c) => c.furniture());
const cards = () => page.evaluate(() => [...document.querySelectorAll("[data-furniture]")].map((el) => el.dataset.furniture));

// --- the panel -------------------------------------------------------------
await page.evaluate(() => document.querySelector('[data-id="furniture-chip"]').click());
const opened = await page.evaluate(() => ({
  open: globalThis.__roboCraft.furnitureShopOpen(),
  tabs: document.querySelectorAll(".furn-tab").length,
  locked: document.pointerLockElement !== null,
  kbd: document.querySelector('[data-id="furniture-chip"] kbd')?.textContent,
}));
check("the chip opens the panel and shows its G shortcut", opened.open && opened.kbd === "G", JSON.stringify(opened));
check("opening the panel releases pointer lock", opened.locked === false);
check("the panel has a tab per category", opened.tabs === 8, `${opened.tabs}`);
const living = await cards();
check("it opens on the living room", living.includes("sofa") && !living.includes("fridge"), living.join(","));

await page.evaluate(() => document.querySelector('[data-id="furniture-tab-kitchen"]').click());
const kitchen = await cards();
check("a tab shows that category", kitchen.includes("fridge") && !kitchen.includes("sofa"), kitchen.join(","));

await page.type('[data-id="furniture-search"]', "침대");
const found = await cards();
check("search finds pieces across categories", found.includes("bed") && found.includes("double-bed") && found.length <= 3, found.join(","));
await page.evaluate(() => {
  const input = document.querySelector('[data-id="furniture-search"]');
  input.value = "";
  input.dispatchEvent(new Event("input"));
  document.querySelector('[data-id="furniture-tab-living"]').click();
});

const petOpen = await page.evaluate(() => {
  document.querySelector('[data-id="pet-chip"]').click();
  return { furniture: globalThis.__roboCraft.furnitureShopOpen(), pet: globalThis.__roboCraft.petShopOpen() };
});
check("opening the adoption panel closes the furniture panel", petOpen.pet && !petOpen.furniture);
await page.evaluate(() => globalThis.__roboCraft.petShopToggle());

// A real click on a swatch (a user gesture) must pick that colour AND take the
// player straight back into play — no "Click to play" stop in between.
await capture(); // capture the mouse first, as in play
await wait(300);
await page.evaluate(() => document.querySelector('[data-id="furniture-chip"]').click());
await wait(300);
await page.click('[data-id="furniture-swatch-sofa-2"]');
await wait(500);
const resumed = await page.evaluate(() => ({
  open: globalThis.__roboCraft.furnitureShopOpen(),
  locked: document.pointerLockElement !== null,
  hint: !document.querySelector(".craft-hint").classList.contains("hidden"),
  ...globalThis.__roboCraft.furniture(),
}));
check(
  "a swatch picks that colour and goes straight back into play",
  resumed.locked && !resumed.hint && !resumed.open && resumed.mode === "sofa" && resumed.variant === 2,
  JSON.stringify({ open: resumed.open, locked: resumed.locked, mode: resumed.mode, variant: resumed.variant }),
);

// Re-capturing the mouse makes the browser report the cursor's jump to the
// screen centre as movement. Applied, it threw the view to a new height on
// every furniture pick, so the view seemed stuck; it is now ignored.
const view = () => page.evaluate(() => { const s = globalThis.__roboCraft.snapshot(); return { yaw: s.yaw, pitch: s.pitch }; });
const nudge = (mx, my) => page.evaluate(([x, y]) => document.dispatchEvent(new MouseEvent("mousemove", { movementX: x, movementY: y })), [mx, my]);
const beforeJump = await view();
await nudge(-500, 640);
const afterJump = await view();
await wait(250);
await nudge(0, 900); // a lone OS spike
const afterSpike = await view();
await nudge(20, 10); // an ordinary hand movement
const afterHand = await view();
check(
  "the cursor jump on re-capture and lone spikes do not turn the view; a hand does",
  afterJump.yaw === beforeJump.yaw && afterJump.pitch === beforeJump.pitch && afterSpike.pitch === afterJump.pitch &&
    afterHand.yaw !== afterSpike.yaw && afterHand.pitch !== afterSpike.pitch,
  JSON.stringify({ beforeJump, afterJump, afterSpike, afterHand }),
);

// --- the bar (keyboard only) ----------------------------------------------
const bar = () =>
  page.evaluate(() => ({
    mode: globalThis.__roboCraft.furniture().mode,
    variant: globalThis.__roboCraft.furniture().variant,
    furniture: !document.querySelector('[data-id="furniture-bar"]').classList.contains("hidden"),
    blocks: getComputedStyle(document.querySelector('[data-id="hotbar"]')).display !== "none",
    label: document.querySelector('[data-id="furniture-cat-name"]').textContent,
    prev: document.querySelector('[data-id="furniture-cat-prev"]').textContent.replace(/\s+/g, " ").trim(),
    next: document.querySelector('[data-id="furniture-cat-next"]').textContent.replace(/\s+/g, " ").trim(),
    selected: document.querySelector(".furn-slot.selected")?.dataset.id ?? null,
  }));
let b = await bar();
check("furniture mode swaps the block hotbar for the furniture bar", b.furniture && !b.blocks && b.label.includes("거실"), JSON.stringify(b));
check("the switcher names where Q and E go", b.prev.includes("Q") && b.prev.includes("야외") && b.next.includes("E") && b.next.includes("침실"), `${b.prev} | ${b.next}`);
await press("x", "KeyX");
b = await bar();
check("X cycles the colour", b.mode === "sofa" && b.variant === 3, JSON.stringify(b));
await press("4", "Digit4");
b = await bar();
check("number keys pick within the category", b.mode === "side-table" && b.selected === "furniture-slot-side-table", JSON.stringify(b));
await press("e", "KeyE");
b = await bar();
check("E moves to the next category", b.mode === "bed" && b.label.includes("침실"), JSON.stringify(b));
await press("q", "KeyQ");
b = await bar();
check("Q goes back and lands on the piece last used there", b.mode === "side-table" && b.label.includes("거실"), JSON.stringify(b));
await press("1", "Digit1");
b = await bar();
check("a piece remembers its colour", b.mode === "sofa" && b.variant === 3, JSON.stringify(b));
await press("g", "KeyG");
b = await bar();
check("G goes back to blocks and the block hotbar", b.mode === null && !b.furniture && b.blocks, JSON.stringify(b));
await press("g", "KeyG");
check("G again brings back the last piece", (await bar()).mode === "sofa");
await page.evaluate(() => document.exitPointerLock());
await wait(300);
// with the mouse free, the switcher's arrows are buttons too
await page.click('[data-id="furniture-cat-next"]');
b = await bar();
check("clicking the switcher's arrow changes category", b.label.includes("침실"), JSON.stringify(b));
await press("g", "KeyG");

// --- placing -----------------------------------------------------------------
// The field's grass top is y = 3, so pieces stand at y = 4. The player spawns
// at grid (80.5, 80.5); lay a room out in front of them.
const spots = [
  ["chair", 75, 4, 86, 2],
  ["table", 77, 4, 86, 2],
  ["sofa", 80, 4, 87, 2, 1],
  ["bed", 83, 4, 86, 0],
  ["bookshelf", 85, 4, 88, 2],
  ["lamp", 86, 4, 88, 2],
  ["plant", 75, 4, 88, 0],
  ["tv", 78, 4, 89, 2],
  ["rug", 80, 4, 87, 2, 3], // under the sofa: rugs share cells with floor pieces
  ["vase", 77, 4, 86, 0, 1], // on the table
  ["candles", 72, 4, 82, 0], // on bare ground
];
for (const [kind, x, y, z, rot, variant = 0] of spots) {
  const ok = await craft((c, ...a) => c.furniturePlace(...a), kind, x, y, z, rot, variant);
  check(`a ${kind} can be placed`, ok === true);
}
check("every piece is in the layout", (await state()).count === spots.length, `${(await state()).count}`);
check("the rug lies under the sofa", (await craft((c) => c.furnitureAt(80, 4, 87, "rug"))) === "rug");
check("the vase stands on the table", (await craft((c) => c.furnitureAt(77, 4, 86, "surface"))) === "vase");

check("a piece cannot overlap another", (await craft((c) => c.furniturePlace("chair", 75, 4, 86, 0))) === false);
check("a piece cannot float in mid-air", (await craft((c) => c.furniturePlace("chair", 70, 6, 70, 0))) === false);
check("a vase cannot stand on a chair", (await craft((c) => c.furniturePlace("vase", 75, 4, 86, 0))) === false);
check("a picture cannot hang on thin air", (await craft((c) => c.furniturePlace("painting", 70, 5, 70, 2))) === false);
await craft((c) => c.placeAt(70, 4, 70, "stone"));
check("a piece cannot go inside a block", (await craft((c) => c.furniturePlace("chair", 70, 4, 70, 0))) === false);
check("a block cannot be placed into a piece", (await craft((c) => c.placePiece(75, 4, 86, "stone"))) === false);
check("nor onto a rug", (await craft((c) => c.placePiece(79, 4, 86, "stone"))) === false);

// --- a real held left click puts a picture away ---------------------------
// stone wall at z = 85, picture hung on its near face (facing -z = rot 2)
await craft((c) => {
  c.placeAt(80, 4, 85, "stone");
  c.placeAt(80, 5, 85, "stone");
});
check("a picture hangs on a wall", (await craft((c) => c.furniturePlace("painting", 80, 5, 84, 2))) === true);
await craft((c) => {
  c.teleport(80.5, 4, 81.5);
  c.look(0, 0.03);
});
await capture();
await wait(400);
await page.mouse.down({ button: "left" });
await wait(900);
await page.mouse.up({ button: "left" });
check(
  "holding left click on the picture puts it away (not the wall behind it)",
  (await craft((c) => c.furnitureAt(80, 5, 84, "wall"))) === null && (await craft((c) => c.blockAt(80, 5, 85))) !== 0,
);
await page.evaluate(() => document.exitPointerLock());

// --- doors: a real right click opens and closes them, in any mode ----------
// (all near the field's centre: a teleport more than 8 cells out recentres the
// window, and every grid coordinate below would then point somewhere else)
await craft((c) => c.furniturePlace("door", 78, 4, 76, 2));
check("a door starts closed and solid", (await craft((c) => c.furnitureState(78, 4, 76))) === "closed");
await craft((c) => {
  c.furnitureSelect(null); // holding blocks: the click must still open it, not place a block
  c.teleport(78.5, 4, 73.5);
  c.look(0, 0.12);
});
// Chrome refuses to re-capture the mouse for about a second after a release
await wait(1500);
await capture();
await wait(400);
const rightClick = async () => {
  await page.mouse.down({ button: "right" });
  await wait(120);
  await page.mouse.up({ button: "right" });
  await wait(300);
};
await rightClick();
check("right-clicking a door opens it (and places no block)", (await craft((c) => c.furnitureState(78, 4, 76))) === "open" && (await craft((c) => c.blockAt(78, 4, 75))) === 0);
// walk through the open doorway for real: hold W from in front of it
await craft((c) => c.look(0, 0));
await page.keyboard.down("KeyW");
await wait(2200);
await page.keyboard.up("KeyW");
const through = await craft((c) => c.snapshot().pos);
check("an open door can be walked through", through[2] > 77, JSON.stringify(through));
await craft((c) => c.teleport(78.5, 4, 76.5)); // stand IN the doorway
await craft((c) => c.furnitureToggle(78, 4, 76));
check("but not shut on someone standing in it", (await craft((c) => c.furnitureState(78, 4, 76))) === "open");
await craft((c) => {
  c.teleport(78.5, 4, 73.5);
  c.look(0, 0.12);
});
await wait(300);
await rightClick();
check("right-clicking again closes it", (await craft((c) => c.furnitureState(78, 4, 76))) === "closed");
// middle click picks the piece under the crosshair: same kind, same colour
await craft((c) => c.furniturePlace("sofa", 84, 4, 76, 2, 3));
await craft((c) => {
  c.teleport(83.5, 4, 73.5);
  c.look(0, -0.38);
});
await wait(300);
await page.mouse.click(640, 400, { button: "middle" });
await wait(300);
const picked2 = await craft((c) => c.furniture());
check("middle-click picks that piece and its colour", picked2.mode === "sofa" && picked2.variant === 3, JSON.stringify({ mode: picked2.mode, variant: picked2.variant }));
await craft((c) => c.furnitureSelect(null));

// --- sitting: right-click a chair, a move key stands you back up ----------
await craft((c) => {
  c.furniturePlace("chair", 82, 4, 76, 2);
  c.teleport(82.5, 4, 73.5);
  c.look(0, -0.3);
});
await wait(300);
await rightClick();
const sat = await craft((c) => c.seated());
check("right-clicking a chair sits the robot on it", sat?.kind === "chair" && sat.pos[1] > 4.1, JSON.stringify(sat));
await page.keyboard.down("KeyS");
await wait(400);
await page.keyboard.up("KeyS");
const stood = await craft((c) => ({ seated: c.seated(), pos: c.snapshot().pos }));
check("a move key stands it back up, clear of the chair", stood.seated === null && stood.pos[1] < 4.2, JSON.stringify(stood));

// --- undo / redo ----------------------------------------------------------
const before3 = (await state()).count;
await craft((c) => {
  c.furnitureSelect("plant");
  c.teleport(80.5, 4, 73.5);
  c.look(0, -0.6);
});
await wait(300);
await rightClick();
const afterPlace = (await state()).count;
const ctrl = async (k, code) => {
  await page.keyboard.down("Control");
  await page.keyboard.press(code);
  await page.keyboard.up("Control");
  await wait(250);
  void k;
};
await ctrl("z", "KeyZ");
const afterUndo = (await state()).count;
await ctrl("y", "KeyY");
const afterRedo = (await state()).count;
check("Ctrl+Z undoes a placement and Ctrl+Y redoes it", afterPlace === before3 + 1 && afterUndo === before3 && afterRedo === before3 + 1, `${before3} → ${afterPlace} → ${afterUndo} → ${afterRedo}`);
await craft((c) => c.furnitureSelect(null));
await page.evaluate(() => document.exitPointerLock());

// --- support and cascades -------------------------------------------------
await craft((c) => c.furniturePlace("clock", 80, 5, 84, 2));
await craft((c) => c.mineAt(80, 5, 85));
check("mining the wall drops the clock hung on it", (await craft((c) => c.furnitureAt(80, 5, 84, "wall"))) === null);
await craft((c) => c.furniturePlace("plant", 72, 4, 72, 0));
await craft((c) => c.mineAt(72, 3, 72));
check("mining the ground out from under a piece puts it away", (await craft((c) => c.furnitureAt(72, 4, 72))) === null);
await craft((c) => c.furniturePlace("coffee-table", 66, 4, 66, 0)); // cells 66 and 67
await craft((c) => c.furniturePlace("succulent", 66, 4, 66, 0));
await craft((c) => c.mineAt(66, 3, 66));
check("one supported leg is enough to stay", (await craft((c) => c.furnitureAt(66, 4, 66))) === "coffee-table");
await craft((c) => c.mineAt(67, 3, 66));
check(
  "when the last leg goes, what stood on it goes too",
  (await craft((c) => c.furnitureAt(66, 4, 66))) === null && (await craft((c) => c.furnitureAt(66, 4, 66, "surface"))) === null,
);

if (SHOT) {
  await craft((c) => {
    c.teleport(80.5, 4, 80.5);
    c.look(0, -0.32);
  });
  await wait(1500);
  await page.screenshot({ path: SHOT });
  console.log(`screenshot → ${SHOT}`);
}

// --- the field scrolls under it -------------------------------------------
const before = (await state()).items;
// one big step east: the window recentres and stays there, so the grid
// coordinates of every piece really have changed
await craft((c) => c.teleport(80.5 + 48, 4, 80.5));
await wait(600);
const after = (await state()).items;
check("absolute positions survive the window scrolling", JSON.stringify(before) === JSON.stringify(after));
// the sofa's anchor is absolute (80 - 80, 87 - 80) = (0, 7); find it on the grid now
const sofaGrid = await craft((c) => {
  const [ax, az] = c.absolute();
  const [px, , pz] = c.snapshot().pos;
  return c.furnitureAt(Math.round(px - ax), 4, 7 + Math.round(pz - az));
});
check("and the scrolled grid still collides with them", sofaGrid === "sofa", `${sofaGrid}`);

// --- persistence -----------------------------------------------------------
await craft((c) => c.saveNow());
await boot(false);
const reloaded = (await state()).items;
check("furniture (with colours) survives a reload", JSON.stringify(reloaded) === JSON.stringify(after), `${reloaded.length} pieces`);

// --- the machine lab -------------------------------------------------------
await press("b", "KeyB");
await wait(1200);
const chip = await page.evaluate(() => getComputedStyle(document.querySelector('[data-id="furniture-chip"]')).display);
check("the machine lab hides the furniture chip", chip === "none", chip);

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
