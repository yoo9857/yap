// Flowing water meeting walls and things: an open-ground stream against a wall, a waterfall beside a
// wall, a stream round a pillar and furniture, a fall onto furniture, a cascade down steps.
// Prints each scene's cells layer by layer (S source, 1‒7 flow, F falling, P settled, # solid,
// o furniture, . air) and shoots it from two sides.
//   node tools/shot-water-flow.mjs [outdir]     (needs `pnpm dev`)
import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "tmp/water-flow";
await mkdir(OUT, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const QUERY = process.env.QUERY ?? "";
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const browser = await puppeteer.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: "new", args: ["--enable-unsafe-swiftshader", "--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 680 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?mode=field&reset=1${QUERY}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForFunction(() => !!globalThis.__roboCraft && document.getElementById("boot-overlay")?.classList.contains("hidden"), { timeout: 90000 });
  await page.addStyleTag({ content: ".craft-hint,.craft-hud,.game-menu{display:none!important}" });
  const frames = async (n) => { for (let i = 0; i < n; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); };
  const P = await page.evaluate(() => globalThis.__roboCraft.snapshot().pos.map(Math.floor));
  const [X, Y, Z] = P;
  // every scene: centre (cx, Y, cz), the box dumped/shot is ±6 around it
  const scenes = [
    { name: "wall", cx: X - 30, cz: Z - 12 },
    { name: "fall", cx: X - 15, cz: Z - 12 },
    { name: "things", cx: X, cz: Z - 12 },
    { name: "fall-things", cx: X + 15, cz: Z - 12 },
    { name: "steps", cx: X + 30, cz: Z - 12 },
    // shaped blocks (triangle 1, corner 2, round 3, half 4, stairs 5)
    { name: "shape-fall", cx: X - 30, cz: Z + 16 },
    { name: "shape-tower", cx: X - 10, cz: Z + 16 },
    { name: "shape-stream", cx: X + 10, cz: Z + 16 },
    { name: "shape-slide", cx: X + 30, cz: Z + 16 },
    { name: "shape-hover", cx: X - 30, cz: Z + 34 },
    { name: "corner", cx: X - 10, cz: Z + 34 },
    { name: "float", cx: X + 10, cz: Z + 34 },
    { name: "pool", cx: X + 30, cz: Z + 34 },
  ];
  await page.evaluate((scenes, Y) => {
    const c = globalThis.__roboCraft;
    const put = (x, y, z, k = "stone") => c.placeAt(x, y, z, k);
    const water = (x, y, z) => { c.give("water", 1); c.placeAt(x, y, z, "water"); };
    const shape = (piece, rot, tilt, x, y, z, k) => { c.setPieceShape(piece, rot, tilt); c.give(k, 2); c.placePiece(x, y, z, k); };
    for (const { name, cx, cz } of scenes) {
      if (name === "wall") {
        for (let x = cx - 5; x <= cx + 5; x++) for (let y = Y; y <= Y + 2; y++) put(x, y, cz - 2, "red-bricks");
        for (let z = cz - 1; z <= cz + 4; z++) for (let y = Y; y <= Y + 1; y++) put(cx + 3, y, z, "red-bricks");
        water(cx, Y, cz);
      } else if (name === "fall") {
        for (let x = cx - 4; x <= cx + 4; x++) for (let y = Y; y <= Y + 5; y++) put(x, y, cz - 1, "red-bricks");
        put(cx + 2, Y, cz + 1); put(cx + 2, Y + 1, cz + 1); // a post in the landing
        water(cx, Y + 4, cz);
      } else if (name === "things") {
        put(cx - 2, Y, cz); put(cx - 2, Y + 1, cz); // pillar in the stream
        c.furniturePlace("sofa", cx + 2, Y, cz, 0);
        c.furniturePlace("coffee-table", cx, Y, cz + 2, 0);
        c.furniturePlace("armchair", cx, Y, cz - 2, 0);
        water(cx, Y, cz);
      } else if (name === "fall-things") {
        c.furniturePlace("coffee-table", cx, Y, cz, 0);
        c.furniturePlace("bookshelf", cx + 2, Y, cz, 0);
        water(cx, Y + 4, cz);
        water(cx + 2, Y + 5, cz);
      } else if (name === "steps") {
        // 3 wide, each step 2 long, dropping 1 per step toward +z; side walls
        for (let s = 0; s < 4; s++) for (let d = 0; d < 2; d++) {
          const z = cz - 4 + s * 2 + d, top = Y + 3 - s;
          for (let x = cx - 1; x <= cx + 1; x++) for (let y = Y; y < top; y++) put(x, y, z);
          for (const x of [cx - 2, cx + 2]) for (let y = Y; y <= top; y++) put(x, y, z, "red-bricks");
        }
        for (let x = cx - 2; x <= cx + 2; x++) for (let y = Y; y <= Y + 4; y++) put(x, y, cz - 5, "red-bricks");
        water(cx, Y + 3, cz - 4);
      } else if (name === "shape-fall") {
        // a fall onto each shape standing on the ground
        [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]].forEach(([piece, rot], i) => {
          const x = cx - 6 + i * 3;
          shape(piece, rot, 0, x, Y, cz, "oak-planks");
          water(x, Y + 3, cz);
        });
      } else if (name === "shape-tower") {
        // a source on a pillar; ramps and corners round its foot and half way up
        for (let y = Y; y <= Y + 2; y++) put(cx, y, cz, "oak-planks");
        shape(1, 0, 0, cx, Y, cz + 1, "oak-planks"); shape(1, 2, 0, cx, Y, cz - 1, "oak-planks");
        shape(1, 1, 0, cx + 1, Y, cz, "oak-planks"); shape(1, 3, 0, cx - 1, Y, cz, "oak-planks");
        shape(2, 0, 0, cx + 1, Y, cz + 1, "oak-planks"); shape(2, 2, 0, cx - 1, Y, cz - 1, "oak-planks");
        shape(1, 0, 0, cx, Y + 2, cz + 1, "birch-planks");
        water(cx, Y + 3, cz);
      } else if (name === "shape-stream") {
        // a ground stream meeting every turn of a triangle, a corner, a round and stairs
        for (let r = 0; r < 4; r++) {
          shape(1, r, 0, cx - 4 + r * 2, Y, cz - 2, "oak-planks");
          shape(2, r, 0, cx - 4 + r * 2, Y, cz + 2, "birch-planks");
          shape(5, r, 0, cx + 3, Y, cz - 3 + r * 2, "cobblestone");
        }
        shape(3, 0, 0, cx - 3, Y, cz, "oak-planks");
        water(cx, Y, cz);
      } else if (name === "shape-hover") {
        // shapes hanging one block above the ground with water poured onto them (the "water dome")
        put(cx - 2, Y + 1, cz, "oak-planks");
        shape(2, 0, 0, cx - 1, Y + 1, cz, "oak-planks"); shape(4, 0, 0, cx, Y + 1, cz, "birch-planks");
        shape(2, 1, 0, cx + 1, Y + 1, cz, "oak-planks"); shape(1, 0, 0, cx, Y + 1, cz + 1, "oak-planks");
        water(cx, Y + 3, cz);
      } else if (name === "corner") {
        // water from the top of a square pillar runs down all four faces and must meet round its corners
        for (let y = Y; y <= Y + 3; y++) for (let x = cx; x <= cx + 1; x++) for (let z = cz; z <= cz + 1; z++) put(x, y, z, "oak-planks");
        for (let x = cx; x <= cx + 1; x++) for (let z = cz; z <= cz + 1; z++) water(x, Y + 4, z);
      } else if (name === "float") {
        // full blocks hanging in the air with water poured on top: it must run down their faces and
        // drop, never stretch from a block's lower edge to the ground
        for (let x = cx - 2; x <= cx; x++) put(x, Y + 1, cz, "oak-planks");
        put(cx + 2, Y + 1, cz, "dirt"); put(cx + 2, Y + 2, cz + 1, "oak-planks"); put(cx + 1, Y, cz + 2, "cobblestone");
        water(cx - 1, Y + 2, cz); water(cx + 2, Y + 3, cz + 1);
      } else if (name === "pool") {
        // a pit three deep with a fall into it, a glass wall beside it and a ramp and a chair in the water
        for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 3; z <= cz + 3; z++) for (let y = Y - 3; y <= Y - 1; y++) c.mineAt(x, y, z);
        for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 3; z <= cz + 3; z++) water(x, Y - 1, z);
        for (let x = cx - 3; x <= cx + 3; x++) for (let y = Y; y <= Y + 2; y++) put(x, y, cz - 4, "glass");
        put(cx - 2, Y + 3, cz - 4, "stone"); water(cx - 2, Y + 4, cz - 4);
        shape(1, 0, 0, cx + 2, Y - 3, cz + 1, "oak-planks"); shape(4, 0, 0, cx + 2, Y - 1, cz - 2, "birch-planks");
        c.furniturePlace("armchair", cx - 1, Y - 3, cz + 2, 0);
      } else if (name === "shape-slide") {
        // a slide: ramps stepping down from a platform, walls beside it, water from the top
        for (let s = 0; s < 3; s++) {
          const z = cz - 2 + s, top = Y + 2 - s;
          for (let x = cx - 1; x <= cx + 1; x++) { for (let y = Y; y < top; y++) put(x, y, z); shape(1, 0, 0, x, top, z, "oak-planks"); }
        }
        for (let x = cx - 1; x <= cx + 1; x++) for (let y = Y; y <= Y + 2; y++) put(x, y, cz - 3);
        water(cx, Y + 3, cz - 3);
      }
    }
    c.renderFlags({ robot: false });
  }, scenes, Y);
  for (let i = 0; i < 14; i++) { await frames(60); await new Promise((r) => setTimeout(r, 500)); }
  // teleports scroll the field window: grid coordinates move, so follow the origin
  const origin = () => page.evaluate(() => { const c = globalThis.__roboCraft, a = c.absolute(), p = c.snapshot().pos; return [Math.round(a[0] - p[0]), Math.round(a[1] - p[2])]; });
  const o0 = await origin();
  const report = { errors, stats: await page.evaluate(() => globalThis.__roboCraft.waterStats()) };
  for (const scene of scenes) {
    if (ONLY && !ONLY.some((k) => scene.name.startsWith(k))) continue;
    const o = await origin(), name = scene.name, cx = scene.cx + o0[0] - o[0], cz = scene.cz + o0[1] - o[1];
    const dump = await page.evaluate((cx, cz, Y) => {
      const c = globalThis.__roboCraft, rows = [];
      for (let y = Y + 5; y >= Y; y--) {
        const layer = [];
        for (let z = cz - 6; z <= cz + 6; z++) {
          let row = "";
          for (let x = cx - 7; x <= cx + 7; x++) {
            const id = c.blockAt(x, y, z), w = c.waterAt(x, y, z);
            const wet = w || (id >= 19 && id <= 28 ? id : 0);
            row += wet ? (wet === 19 ? "S" : wet === 27 ? "F" : wet === 28 ? "P" : String(wet - 19))
              : id ? (c.shapeAt?.(x, y, z) ? "s" : "#") : c.furnitureAt(x, y, z) ? "o" : ".";
          }
          layer.push(row);
        }
        if (layer.some((r) => /[S1-7FP]/.test(r))) rows.push(`y=+${y - Y}`, ...layer);
      }
      return rows.join("\n");
    }, cx, cz, Y);
    console.log(`--- ${name}\n${dump}`);
    const views = [
      ["a", [cx + 0.5, Y + 5.5, cz + 7.5], Math.PI, -0.75],
      ["b", [cx - 4.5, Y + 2.6, cz + 3.5], Math.PI - 0.9, -0.5],
      ["c", [cx + 0.5, Y + 2.4, cz + 3.6], Math.PI, -0.6],
      ["d", [cx + 4.5, Y + 1.6, cz + 2.5], Math.PI + 1.0, -0.3],
      ["e", [cx + 4.2, Y + 4.2, cz + 4.6], Math.PI + 0.75, -0.5],
      ["f", [cx - 0.5, Y + 0.2, cz + 3.4], Math.PI, 0.12],
      ["g", [cx + 3.6, Y + 0.3, cz + 2.4], Math.PI + 1.1, 0.1],
      ["h", [cx - 1.0, Y + 0.4, cz - 0.4], Math.PI - 1.2, 0.05],
      ["u", [cx + 0.5, Y - 2.6, cz + 1.5], Math.PI, 0.35],
      ["v", [cx + 2.5, Y - 2.2, cz + 2.5], Math.PI + 0.8, 0.1],
      ["i", [cx + 1.2, Y + 2.2, cz + 2.2], Math.PI + 0.5, -0.35],
    ];

    for (const [tag, pos, yaw, pitch] of views) {
      const now = await origin();
      pos[0] += o[0] - now[0]; pos[2] += o[1] - now[1];
      await page.evaluate(([p, y, pi]) => { const c = globalThis.__roboCraft; c.teleport(...p); c.look(y, pi); }, [pos, yaw, pitch]);
      await frames(40);
      await page.screenshot({ path: `${OUT}/${name}-${tag}.png` });
    }
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
