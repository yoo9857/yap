// Science mode (T) E2E on the solo education field: T switches the mode (Shift+T still tips a block
// shape); a power-plant blueprint is laid (and refused where it cannot go); its ITEM SOCKETS are
// filled from the underbody up (aimed, middle-click pick, right click), parts after the frame; it
// runs only complete; the status board, beacon arrow, reload and X take-back. Needs `pnpm dev` running. Optional argv[2] = a directory for screenshots.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const SHOTS = process.argv[2];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: "new",
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const frames = (n) =>
  page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
  }, n);
const R = (fn, ...args) => page.evaluate(fn, ...args);
const shot = async (name) => {
  if (!SHOTS) return;
  await frames(20);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

async function boot(reset) {
  await page.goto(`${BASE}/?mode=field${reset ? "&reset=1" : ""}`, { waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft, { timeout: 20000 });
  await page.waitForFunction(() => globalThis.__roboCraft.snapshot().grounded, { timeout: 20000 }).catch(() => {});
  await frames(10);
}

await boot(true);
// headless has no pointer lock: hide the pause card so screenshots show the world
const hideMenu = () => page.addStyleTag({ content: ".craft-hint{display:none!important}" });
await hideMenu();
const s0 = await R(() => globalThis.__roboCraft.snapshot());
const [ax, az] = await R(() => globalThis.__roboCraft.absolute());
const origin = [Math.round(ax - s0.pos[0]), Math.round(az - s0.pos[2])];
const ground = Math.round(s0.pos[1]); // the first free layer on the flat field
const anchor = [Math.floor(ax) + 6, ground, Math.floor(az) + 6];
const liveOrigin = () => R(() => {
  const g = globalThis.__roboCraft;
  const s = g.snapshot();
  const [ax, az] = g.absolute();
  return [Math.round(ax - s.pos[0]), Math.round(az - s.pos[2])];
});
const grid = (x, z) => [x - origin[0], z - origin[1]]; // valid until the first teleport

// 1) T switches science mode on and off; Shift+T is still the shape tilt
check("science mode exists and starts off", (await R(() => globalThis.__roboCraft.science()))?.active === false);
await page.keyboard.press("t");
await frames(3);
check("T turns science mode on", (await R(() => globalThis.__roboCraft.science().active)) === true);
check("the guide bar shows", await R(() => document.body.classList.contains("sci-on") && !!document.querySelector(".sci-bar .sci-task span")?.textContent));
await page.keyboard.press("t");
await frames(3);
check("T again turns it off", (await R(() => globalThis.__roboCraft.science().active)) === false);
await page.keyboard.down("Shift");
await page.keyboard.press("t");
await page.keyboard.up("Shift");
await frames(2);
check("Shift+T leaves science mode alone", (await R(() => globalThis.__roboCraft.science().active)) === false);

// 2) laying: refused in the air and on top of a block, accepted on open ground
check("a blueprint is refused in mid-air", (await R((a) => globalThis.__roboCraft.scienceLay(a[0], a[1] + 3, a[2]), anchor)) === "ground");
{
  const [gx, gz] = grid(anchor[0], anchor[2]); // a tower cell
  await R((p) => globalThis.__roboCraft.placeAt(p[0], p[1] + 2, p[2], "oak-planks"), [gx, ground, gz]);
  check("a blueprint is refused where a block is in the way", (await R((a) => globalThis.__roboCraft.scienceLay(...a), anchor)) === "blocked");
  await R((p) => globalThis.__roboCraft.mineAt?.(p[0], p[1] + 2, p[2]), [gx, ground, gz]);
  if ((await R((p) => globalThis.__roboCraft.blockAt(p[0], p[1] + 2, p[2]), [gx, ground, gz])) !== 0) {
    // no mineAt hook on this build: lay the plan one cell over instead
    anchor[0] += 6;
  }
}
check("a blueprint lays on open ground", (await R((a) => globalThis.__roboCraft.scienceLay(...a), anchor)) === null);
let site = (await R(() => globalThis.__roboCraft.science())).sites[0];
check("the new site starts at 0%", site?.pct === 0 && site.state === "building", JSON.stringify(site));
check("a second blueprint may not overlap it", (await R((a) => globalThis.__roboCraft.scienceLay(a[0] + 1, a[1], a[2]), anchor)) === "overlap");

// stand back and look at it
const face = async () => {
  const o = await liveOrigin();
  const [gx, gz] = [anchor[0] - o[0], anchor[2] + 12 - o[1]];
  await R((p) => {
    globalThis.__roboCraft.teleport(p[0] + 0.5, p[1], p[2] + 0.5);
    globalThis.__roboCraft.look(Math.PI, 0.18);
  }, [gx, ground, gz]);
  await frames(30);
};
await face();
await page.keyboard.press("t");
await shot("1-blueprint");

// stand on a cell (a support block is placed under it if needed) and look at an absolute point
const standAndLook = async (stand, target) => {
  await R((a) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [ax, az] = g.absolute();
    const ox = Math.round(ax - s.pos[0]), oz = Math.round(az - s.pos[2]);
    if (g.blockAt(a.stand[0] - ox, a.stand[1] - 1, a.stand[2] - oz) === 0) g.placeAt(a.stand[0] - ox, a.stand[1] - 1, a.stand[2] - oz, "stone");
    g.teleport(a.stand[0] - ox + 0.5, a.stand[1], a.stand[2] - oz + 0.5);
  }, { stand });
  await frames(6);
  await R((a) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [ax, az] = g.absolute();
    const eye = s.pos[1] + 1.6;
    const dx = a.t[0] - ax, dz = a.t[2] - az, dy = a.t[1] - eye;
    g.look(Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  }, { t: target });
  await frames(6);
};
const aimSlot = async (slot, from) => standAndLook(from, [slot.x + 0.5, slot.y + 0.5, slot.z + 0.5]);
const socketsNow = () => R(() => globalThis.__roboCraft.scienceSockets(0));
// ---- mini-games: real mouse input on the SVG (viewBox units → screen pixels)
const gameNow = async () => {
  for (let i = 0; i < 100; i++) {
    const g = await R(() => globalThis.__roboCraft.scienceGame());
    if (!g?.loading) return g;
    await new Promise((r) => setTimeout(r, 100));
  }
  return R(() => globalThis.__roboCraft.scienceGame());
};
const svgToScreen = (x, y) => R(([x, y]) => {
  const svg = document.querySelector(".sci-game-svg");
  const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
  return [p.x, p.y];
}, [x, y]);
const dragSvg = async (path) => {
  const [x0, y0] = await svgToScreen(...path[0]);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (const pt of path.slice(1)) {
    const [x, y] = await svgToScreen(...pt);
    await page.mouse.move(x, y, { steps: 2 });
    await frames(1);
  }
  await page.mouse.up();
};
/** Wait for an open mini-game to finish its "done" beat and fit the piece. */
const waitGameClosed = async () => {
  // a page the browser treats as backgrounded pauses rAF and throttles timers: keep it in front
  await page.bringToFront();
  for (let i = 0; i < 120 && (await gameNow())?.open; i++) await new Promise((r) => setTimeout(r, 100));
};
const playGrounding = async () => {
  for (let i = 0; i < 4; i++) {
    await page.click(".sci-game-btn");
    await frames(2);
  }
  // quick taps queue up: wait until every blow has landed (the chip leaves "n / 4")
  await page.waitForFunction(() => !/\/\s*4/.test(document.querySelector(".sci-game-chip")?.textContent ?? ""), { timeout: 15000 }).catch(() => {});
  // the clip rests at (760, 300); the driven rod's glowing head is at (1010, 312)
  await dragSvg([[700, 300], [820, 300], [940, 306], [1010, 310], [1040, 312]]);
};
// blade assembly: three blades from the tray onto every other socket, then the bolts
const HUB = { x: 780, y: 285, r: 217 * 330 / 586 };
const mountXY = (i) => [HUB.x + Math.cos(-Math.PI / 2 + (i * Math.PI) / 3) * HUB.r, HUB.y + Math.sin(-Math.PI / 2 + (i * Math.PI) / 3) * HUB.r];
const playRotor = async () => {
  const tray = [[106, 395], [169, 395], [232, 395]];
  for (const [k, m] of [[0, 0], [1, 2], [2, 4]]) {
    const [mx, my] = mountXY(m);
    await dragSvg([tray[k], [(tray[k][0] + mx) / 2, (tray[k][1] + my) / 2], [mx, my - 112.5], [mx, my - 112.5]]);
    await frames(12);
  }
  for (const m of [0, 2, 4]) {
    const [x, y] = await svgToScreen(...mountXY(m));
    await page.mouse.click(x, y);
    await frames(8);
  }
};
const playGenerator = async () => {
  const pts = [];
  for (let k = 0; k <= 4 * 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    pts.push([415 + Math.cos(a) * 130, 256 + Math.sin(a) * 130]);
  }
  await dragSvg(pts);
};
const sciNow = async () => (await R(() => globalThis.__roboCraft.science())).sites[0];
const hold = (key) => R((k) => globalThis.__roboCraft.hold(k), key);
const fitIndex = (i) => R((i) => globalThis.__roboCraft.scienceFit(0, i), i);
let sockets = await socketsNow();
check("the blueprint is 19 item sockets: 16 frame + 3 parts", sockets.length === 19 && sockets.filter((s) => s.kind === "frame").length === 16, String(sockets.length));
check("only the underbody (foundation) is open at first", sockets.filter((s) => s.open).every((s) => s.y === ground) && sockets.filter((s) => s.open).length === 9);

// 3) order: the tower waits for the foundation
const towerBase = sockets.findIndex((s) => s.item === "frame-tower-base");
await hold("frame-tower-base");
check("a tower piece is refused before the foundation", (await fitIndex(towerBase)) === false);

// 4) the real path: aim at a foundation socket, middle click picks its item, right click fits it
const pad = sockets.find((s) => s.item === "frame-foundation");
await hold("stone-bricks");
await standAndLook([pad.x + 4, ground, pad.z], [pad.x + 0.5, ground + 0.5, pad.z + 0.5]);
let dbg = await R(() => globalThis.__roboCraft.science());
check("aiming at an empty socket finds it", dbg.aimedSlot?.part === "frame-foundation", JSON.stringify(dbg.aimedSlot));
const picked = await R(() => globalThis.__roboCraft.sciencePickAimed());
check("a middle click on a socket names its item", picked === "frame-foundation", String(picked));
// one right click fits it, whatever is in hand (the glowing shape shows what goes there)
await R(() => globalThis.__roboCraft.scienceInteract());
sockets = await socketsNow();
check("one right click on a glowing socket fits its piece", sockets.filter((s) => s.filled).length === 1);
// holding the button keeps building, in order
for (let i = 0; i < 3; i++) await R(() => globalThis.__roboCraft.scienceHoldBuild());
check("holding right click keeps fitting the next pieces", (await socketsNow()).filter((s) => s.filled).length === 4);
await shot("2-first-piece");

// 5) the rest of the frame, layer by layer (same rules as aiming): the % climbs, then parts wait
sockets = await socketsNow();
let lastPct = (await sciNow()).pct;
let climbing = true;
let groundingSeen = false;
for (let i = 0; i < sockets.length; i++) {
  const s = sockets[i];
  if (s.kind !== "frame" || s.filled) continue;
  await hold(s.item);
  let ok = await fitIndex(i);
  const game = await gameNow();
  if (game?.open) {
    // the tower anchor opens the grounding game: nothing is fitted until it is played through
    groundingSeen = game.kind === "grounding" && !(await socketsNow())[i].filled;
    await shot("5a-grounding");
    await playGrounding();
    await shot("5b-grounding-done");
    await waitGameClosed();
    ok = (await socketsNow())[i].filled;
    check("grounding by mouse (4 taps, drag the clip) fits the tower anchor", ok === true && groundingSeen, JSON.stringify({ ok, groundingSeen, game: await gameNow(), toast: await R(() => document.querySelector(".b-toast")?.textContent) }));
  }
  const pct = (await sciNow()).pct;
  if (!ok || pct <= lastPct) climbing = false;
  lastPct = pct;
}
await frames(5);
site = await sciNow();
check("every frame piece raises the frame %", climbing, String(lastPct));
check("the whole frame = 100%, then it waits for parts", site.pct === 100 && site.status === "parts", JSON.stringify(site));
await face();
await R(() => globalThis.__roboCraft.look(Math.PI * 0.85, 0.2));
await shot("3-frame-built");

// a fitted piece is solid: no block goes into its cell
{
  const tower = (await socketsNow()).find((s) => s.item === "frame-tower");
  const placed = await R((p) => {
    const g = globalThis.__roboCraft;
    const s = g.snapshot();
    const [ax, az] = g.absolute();
    return g.placePiece(p.x - Math.round(ax - s.pos[0]), p.y, p.z - Math.round(az - s.pos[2]), "stone");
  }, tower);
  check("a block cannot be placed into a fitted socket", placed === false, String(placed));
}

// 6) parts: aimed for real; the wrong one is refused; won't run until all three are in
sockets = await socketsNow();
const gen = sockets.find((s) => s.item === "part-generator");
const blades = sockets.find((s) => s.item === "part-blades");
const terminal = sockets.find((s) => s.item === "part-wire-terminal");
check("it does not run without its parts", (await sciNow()).status === "parts" && !(await sciNow()).on);
await hold("iron-block"); // any item in hand: the socket's own part comes out of the bag
await aimSlot(gen, [gen.x + 3, gen.y, gen.z]);
await shot("4-slot-aimed");
const fitted = [];
for (const [slot, from] of [[gen, [gen.x + 3, gen.y, gen.z]], [blades, [blades.x + 3, blades.y, blades.z + 1]], [terminal, [terminal.x + 4, ground, terminal.z]]]) {
  await aimSlot(slot, from);
  const aimed = (await R(() => globalThis.__roboCraft.science())).aimedSlot?.part;
  await R(() => globalThis.__roboCraft.scienceInteract());
  const game = await gameNow();
  check(`${slot.item} opens its mini-game and waits`, game?.open === true && !(await socketsNow()).find((s) => s.item === slot.item).filled, JSON.stringify(game));
  if (game?.open && game.kind === "generator") {
    await shot("5c-generator");
    await playGenerator();
    await shot("5d-generator-done");
  } else if (game?.open && game.kind === "rotor") {
    await shot("5f-rotor");
    await playRotor();
    await new Promise((r) => setTimeout(r, 700));
    await shot("5g-rotor-spin");
  } else if (game?.open && game.kind === "wiring") {
    const terms = await R(() => document.querySelectorAll(".sci-game-svg image[data-art^=\"w-jack\"]").length);
    check("the wiring game shows three terminals", terms === 3, String(terms));
    await shot("5e-wiring");
    // plug every wire into its own jack by mouse (red +, black −, earth ⏚) and catch the beats
    for (const [wire, jack, n] of [["red", "plus", 1], ["black", "minus", 2], ["earth", "ground", 3]]) {
      const [from, to] = await R(([wire, jack]) => {
        const b1 = document.querySelector(`.sci-game-svg g[data-wire="${wire}"] image`).getBoundingClientRect();
        const b2 = document.querySelector(`.sci-game-svg image[data-art="w-jack-${jack}"]`).getBoundingClientRect();
        return [[b1.x + b1.width / 2, b1.y + b1.height / 2], [b2.x + 6, b2.y + b2.height / 2]];
      }, [wire, jack]);
      await page.mouse.move(from[0], from[1]);
      await page.mouse.down();
      for (let k = 1; k <= 8; k++) {
        await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / 8, from[1] + ((to[1] - from[1]) * k) / 8);
        await frames(1);
      }
      await page.mouse.up();
      if (n === 1) {
        await new Promise((r) => setTimeout(r, 450));
        await shot("5e2-wiring-click");
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    await shot("5e3-wiring-live");
  }
  await waitGameClosed();
  const ok = (await socketsNow()).find((s) => s.item === slot.item).filled;
  fitted.push(`${slot.item}:${aimed}:${ok}`);
}
check("each part fits into its own socket", fitted.every((f) => f.endsWith(":true")), fitted.join(" "));
dbg = await R(() => globalThis.__roboCraft.science());
check("with every socket filled, it is ready", dbg.sites[0].status === "ready", dbg.sites[0].status);
check("the items show their Blender models (GLB)", (dbg.models ?? []).every((m) => m.endsWith(":glb")), JSON.stringify(dbg.models));

// switch it on: right click the plant
await standAndLook([anchor[0] + 4, ground, anchor[2]], [anchor[0] + 0.5, ground + 3.5, anchor[2] + 0.5]);
await hold("stone-bricks");
await R(() => globalThis.__roboCraft.scienceInteract());
dbg = await R(() => globalThis.__roboCraft.science());
check("a right click switches a ready plant on: it runs", dbg.sites[0].status === "running" && dbg.sites[0].spinning, dbg.sites[0].status);
// a running plant that loses a part stops for a check, and runs again once it is back
await R((g) => globalThis.__roboCraft.scienceTakeOut(g.x, g.y, g.z), gen);
check("taking a part out of a running plant stops it for a check", (await sciNow()).status === "inspection");
await hold("part-generator");
await fitIndex((await socketsNow()).findIndex((s) => s.item === "part-generator"));
await R(() => globalThis.__roboCraft.scienceSolveGame());
await waitGameClosed();
check("…fitting it back starts it again", (await sciNow()).status === "running");
// the rotor can be taken out with a held left click (aimed for real), and fitted back
{
  const bl = (await socketsNow()).find((s) => s.item === "part-blades");
  await standAndLook([bl.x + 3, bl.y, bl.z], [bl.x + 0.5, bl.y + 0.5, bl.z + 0.5]);
  const before = await R(() => globalThis.__roboCraft.aimInfo?.() ?? null);
  void before;
  const out = await R((p) => globalThis.__roboCraft.scienceTakeOut(p.x, p.y, p.z), bl);
  check("the blades can be taken back out", out === true && !(await socketsNow()).find((s) => s.item === "part-blades").filled && (await sciNow()).status === "inspection");
  await hold("part-blades");
  await fitIndex((await socketsNow()).findIndex((s) => s.item === "part-blades"));
  await R(() => globalThis.__roboCraft.scienceSolveGame());
  await waitGameClosed();
  check("…and fitted again: it runs", (await sciNow()).status === "running");
}
await R((p) => globalThis.__roboCraft.scienceTakeOut(p.x, p.y, p.z), (await socketsNow()).find((s) => s.dy === undefined && s.item === "frame-foundation") ?? (await socketsNow())[0]);
check("a foundation piece cannot come out from under the plant", (await socketsNow())[0].filled === true);
await face();
await R(() => globalThis.__roboCraft.look(Math.PI * 0.8, 0.22));
await shot("6-running");
await standAndLook([anchor[0] + 3, ground + 7, anchor[2] + 4], [anchor[0] + 0.5, ground + 7.4, anchor[2] + 1.2]);
await R(() => globalThis.__roboCraft.renderFlags({ robot: false }));
await shot("6b-nacelle");
await standAndLook([anchor[0] + 3, ground, anchor[2] + 2], [anchor[0] + 1.5, ground + 1.3, anchor[2] + 0.5]);
await shot("6c-terminal");
await R(() => globalThis.__roboCraft.renderFlags({ robot: true }));
site = await sciNow();

// 7) the status board (Tab): the village, a card per plant, the energy flow; a card lights a beacon
await page.keyboard.press("Tab");
await frames(10);
const board = await R(() => {
  const el = document.querySelector(".sci-board");
  return {
    open: el?.classList.contains("open"),
    cards: el?.querySelectorAll(".sci-card").length,
    badge: el?.querySelector(".sci-card .sci-badge")?.textContent,
    lit: el?.querySelectorAll(".sci-house.lit").length,
    houses: el?.querySelectorAll(".sci-house").length,
    flow: el?.querySelectorAll(".sci-flow-step").length,
  };
});
check("Tab opens the status board", board.open === true, JSON.stringify(board));
check("…one card per plant, showing it running", board.cards === 1 && /가동 중|Running/.test(board.badge ?? ""), JSON.stringify(board));
check("…a running wind turbine lights 3 of 12 houses", board.lit === 3 && board.houses === 12, `${board.lit}/${board.houses}`);
check("…and the energy flow lists each stage", board.flow === 5, String(board.flow));
await new Promise((r) => setTimeout(r, 600));
if (SHOTS) await page.screenshot({ path: join(SHOTS, "7-board.png") });
await R(() => document.querySelector(".sci-card")?.click());
await frames(10);
check("clicking a card closes the board", (await R(() => document.querySelector(".sci-board")?.classList.contains("open"))) === false);
await page.keyboard.press("Tab");
await frames(4);
await page.keyboard.press("e");
await frames(4);
const stacked = await R(() => ({ board: document.querySelector(".sci-board")?.classList.contains("open"), bag: !document.querySelector(".bag-screen")?.classList.contains("hidden") }));
check("no second panel opens over the board", stacked.board === true && stacked.bag === false, JSON.stringify(stacked));
await page.keyboard.press("Escape");
await frames(4);
check("Esc closes the board", (await R(() => document.querySelector(".sci-board")?.classList.contains("open"))) === false);
const o3 = await liveOrigin();
await R((p) => {
  globalThis.__roboCraft.teleport(p[0] + 0.5, p[1], p[2] + 0.5);
  globalThis.__roboCraft.look(Math.PI / 2, 0.1);
}, [anchor[0] - o3[0] + 20, ground, anchor[2] - o3[1]]);
await frames(20);
const arrow = await R(() => ({ show: document.querySelector(".sci-arrow")?.classList.contains("show"), text: document.querySelector(".sci-arrow")?.textContent }));
check("an off-screen picked plant gets an edge arrow with its distance", arrow.show === true && /m$/.test(arrow.text ?? ""), JSON.stringify(arrow));

// 8) saves: every fitted socket and the switch survive a reload
await R(() => globalThis.__roboCraft.saveNow());
await boot(false);
await hideMenu();
const after = (await R(() => globalThis.__roboCraft.science())).sites;
check("the site survives a reload", after.length === 1 && after[0].x === anchor[0] && after[0].z === anchor[2], JSON.stringify(after));
check("…fully built and still running", after[0]?.pct === 100 && after[0].status === "running", JSON.stringify(after[0]));

// 9) X takes the blueprint back (aimed); its items return to the bag
await page.keyboard.press("t");
const o2 = await liveOrigin();
await R((p) => {
  globalThis.__roboCraft.teleport(p[0] + 0.5, p[1], p[2] + 0.5);
  globalThis.__roboCraft.look(Math.PI, -0.35);
}, [anchor[0] - o2[0], ground, anchor[2] + 3 - o2[1]]);
await frames(20);
await page.keyboard.press("x");
await frames(3);
const gone = (await R(() => globalThis.__roboCraft.science())).sites.length;
check("X takes the aimed blueprint back", gone === 0, String(gone));
// laying with a real right click (the game's own click path, in science mode, aiming at the ground)
{
  const o4 = await liveOrigin();
  await R((p) => {
    globalThis.__roboCraft.teleport(p[0] + 0.5, p[1], p[2] + 0.5);
    globalThis.__roboCraft.look(Math.PI, -0.6);
  }, [anchor[0] - o4[0] + 30, ground, anchor[2] - o4[1] + 10]);
  await frames(15);
  const before = await R(() => { const d = globalThis.__roboCraft.science(); return { active: d.active, plan: d.plan, toast: document.querySelector(".b-toast")?.textContent }; });
  await R(() => globalThis.__roboCraft.scienceRightClick());
  await frames(3);
  const laid = (await R(() => globalThis.__roboCraft.science())).sites.length;
  const toast = await R(() => document.querySelector(".b-toast")?.textContent);
  check("a right click on open ground in science mode lays a blueprint", laid === 1, `${laid} ${JSON.stringify(before)} ${toast}`);
}

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} FAILED` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
