import { describe, expect, it } from "vitest";
import { blockByKey } from "../src/craft/blocks.js";
import {
  BLUEPRINTS,
  fitItem,
  isFilled,
  loadPlants,
  missingParts,
  plantProgress,
  plantStatus,
  savePlants,
  siteAt,
  siteProblem,
  siteSockets,
  socketMask,
  socketOpen,
  turn,
  type PlantSite,
} from "../src/craft/science/plants.js";
import { FRAMES } from "../src/craft/science/frames.js";
import { PARTS } from "../src/craft/science/parts.js";

const id = (key: string) => blockByKey(key)!.id;
const GROUND = 10;

/** A tiny absolute world: flat ground at y < GROUND, a map of edits above it. */
function fakeWorld() {
  const cells = new Map<string, number>();
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
  return {
    cells,
    set: (x: number, y: number, z: number, b: number) => cells.set(k(x, y, z), b),
    blockAt: (x: number, y: number, z: number) => cells.get(k(x, y, z)) ?? (y < GROUND ? id("grass") : 0),
    inBounds: (_x: number, y: number) => y >= 0 && y < 64,
    isEmpty: (b: number) => b === 0,
    isGround(this: void, x: number, y: number, z: number) { return (cells.get(k(x, y, z)) ?? (y < GROUND ? 1 : 0)) !== 0; },
  };
}

const site = (over: Partial<PlantSite> = {}): PlantSite => ({ id: 1, kind: "wind", x: 0, y: GROUND, z: 0, rot: 0, filled: 0, on: false, ...over });

/** Fit every socket of a kind in blueprint order (frames bottom-up come first in the list). */
function fillAll(s: PlantSite, kind?: "frame" | "part"): PlantSite {
  let cur = s;
  for (const sock of siteSockets(s)) {
    if (kind && sock.kind !== kind) continue;
    const fit = fitItem(cur, sock.index, sock.item, true);
    expect(fit.result, `${sock.item} #${sock.index}`).toBe("ok");
    cur = fit.site;
  }
  return cur;
}

describe("the wind turbine blueprint", () => {
  it("is a socket per cell: a 3×3 underbody, the tower, the head, then three parts — no cell twice", () => {
    const bp = BLUEPRINTS.wind;
    const seen = new Set<string>();
    for (const s of bp.sockets) {
      const key = `${s.dx},${s.dy},${s.dz}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
      expect(s.kind === "frame" ? s.item in FRAMES : s.item in PARTS, s.item).toBe(true);
    }
    const frames = bp.sockets.filter((s) => s.kind === "frame");
    expect(frames.filter((s) => s.dy === 0)).toHaveLength(9);
    expect(frames.filter((s) => s.item === "frame-foundation-center")).toHaveLength(1);
    expect(frames.filter((s) => s.item === "frame-tower")).toHaveLength(3);
    expect(frames).toHaveLength(16);
    expect(bp.sockets.filter((s) => s.kind === "part").map((s) => s.item)).toEqual(["part-generator", "part-blades", "part-wire-terminal"]);
    // frames are listed before parts, bottom layer first (the order the game fills them in)
    const dys = frames.map((s) => s.dy);
    expect([...dys].sort((a, b) => a - b)).toEqual(dys);
  });

  it("some sockets span cells: the two-storey tower base and the two-cell generator, turned with the site", () => {
    const base = siteSockets(site()).find((c) => c.item === "frame-tower-base")!;
    expect(base.cells.map((c) => [c.x, c.y, c.z])).toEqual([[0, GROUND + 1, 0], [0, GROUND + 2, 0]]);
    expect([base.cx, base.cy, base.cz]).toEqual([0.5, GROUND + 2, 0.5]);
    const gen = (rot: number) => siteSockets(site({ rot })).find((c) => c.item === "part-generator")!;
    expect(gen(0).cells.map((c) => [c.x, c.z])).toEqual([[0, -1], [0, 0]]);
    expect(gen(1).cells.map((c) => [c.x, c.z])).toEqual([[1, 0], [0, 0]]);
    expect([gen(0).cx, gen(0).cz]).toEqual([0.5, 0]);
    // no two sockets share a cell, in any turn
    for (let rot = 0; rot < 4; rot++) {
      const cells = siteSockets(site({ rot })).flatMap((c) => c.cells.map((x) => `${x.x},${x.y},${x.z}`));
      expect(new Set(cells).size).toBe(cells.length);
    }
  });

  it("turning is a quarter turn that comes back after four", () => {
    expect(turn(0, 1, 1)).toEqual([-1, 0]);
    expect(turn(1, 0, 1)).toEqual([0, 1]);
    for (let r = 0; r < 4; r++) expect(turn(...turn(2, 3, r), 4 - r).map((v) => v + 0)).toEqual([2, 3]);
  });

  it("a turned site keeps its foundation on the anchor and swings the head round", () => {
    const hub = (rot: number) => siteSockets(site({ rot })).find((c) => c.item === "frame-hub")!;
    expect([hub(0).x, hub(0).z]).toEqual([0, 1]);
    expect([hub(1).x, hub(1).z]).toEqual([-1, 0]);
    expect([hub(2).x, hub(2).z]).toEqual([0, -1]);
    expect(siteSockets(site({ rot: 3 })).filter((c) => c.dy === 0)).toHaveLength(9);
  });
});

describe("building with item sockets", () => {
  it("goes layer by layer from the underbody: the tower waits for the whole foundation", () => {
    let s = site();
    const sockets = siteSockets(s);
    const base = sockets.find((c) => c.item === "frame-tower-base")!;
    expect(socketOpen(s, base.index)).toBe(false);
    expect(fitItem(s, base.index, base.item, true).result).toBe("order");
    for (const c of sockets.filter((x) => x.dy === 0).slice(0, 8)) s = fitItem(s, c.index, c.item, true).site;
    expect(socketOpen(s, base.index)).toBe(false); // one foundation pad still missing
    const last = sockets.filter((x) => x.dy === 0)[8]!;
    s = fitItem(s, last.index, last.item, true).site;
    expect(socketOpen(s, base.index)).toBe(true);
    expect(plantProgress(s).layer).toBe(1);
  });

  it("the frame's % climbs with each piece and the next layer is named", () => {
    let s = site();
    expect(plantProgress(s)).toMatchObject({ filled: 0, total: 16, pct: 0, state: "building", layer: 0 });
    for (const c of siteSockets(s).filter((x) => x.dy === 0)) s = fitItem(s, c.index, c.item, true).site;
    const p = plantProgress(s);
    expect(p.pct).toBe(Math.floor((9 / 16) * 100));
    expect(p.missing["frame-tower"]).toBe(3);
    expect(p.missing["frame-foundation"]).toBeUndefined();
  });

  it("refuses the wrong item, a filled socket, a blocked cell, and parts before the frame", () => {
    const s = site();
    const pad = siteSockets(s)[0]!;
    expect(fitItem(s, pad.index, "frame-tower", true).result).toBe("wrong-item");
    expect(fitItem(s, pad.index, pad.item, false).result).toBe("blocked");
    const once = fitItem(s, pad.index, pad.item, true).site;
    expect(fitItem(once, pad.index, pad.item, true).result).toBe("filled");
    const gen = siteSockets(s).find((c) => c.item === "part-generator")!;
    expect(fitItem(s, gen.index, gen.item, true).result).toBe("frame-first");
  });

  it("building → parts → ready → running; it never runs with anything missing", () => {
    let s = site();
    expect(plantStatus(s)).toBe("building");
    s = fillAll(s, "frame");
    expect(plantStatus(s)).toBe("parts");
    expect(missingParts(s)).toEqual(["part-generator", "part-blades", "part-wire-terminal"]);
    s = fillAll(s, "part");
    expect(s.filled).toBe(socketMask("wind"));
    expect(plantStatus(s)).toBe("ready");
    expect(plantStatus({ ...s, on: true })).toBe("running");
    expect(plantStatus({ ...s, on: true, filled: s.filled & ~1 })).toBe("inspection");
  });
});

describe("laying a blueprint", () => {
  it("fits on flat open ground", () => {
    expect(siteProblem(site(), fakeWorld(), [])).toBeNull();
  });

  it("refuses floating, blocked, overlapping, occupied or out-of-world spots", () => {
    const w = fakeWorld();
    expect(siteProblem(site({ y: GROUND + 2 }), w, [])).toBe("ground");
    w.set(0, GROUND + 3, 0, id("oak-planks"));
    expect(siteProblem(site(), w, [])).toBe("blocked");
    expect(siteProblem(site({ x: 1 }), fakeWorld(), [site()])).toBe("overlap");
    expect(siteProblem(site(), { ...fakeWorld(), occupied: (x, y, z) => x === 0 && y === GROUND + 1 && z === 0 }, [])).toBe("player");
    expect(siteProblem(site({ y: 60 }), fakeWorld(), [])).toBe("outside");
  });

  it("finds the site a cell belongs to", () => {
    const a = site();
    const b = site({ id: 2, x: 20 });
    expect(siteAt([a, b], 20, GROUND + 3, 0)).toBe(b);
    expect(siteAt([a, b], 0, GROUND + 7, 2)).toBe(a); // the blades' socket counts too
    expect(siteAt([a, b], 5, GROUND, 5)).toBeNull();
  });
});

describe("plant saves", () => {
  it("round-trips the filled sockets and the switch", () => {
    const full = fillAll(site(), undefined);
    const sites = [site({ id: 3, x: -40, rot: 3 }), { ...full, on: true }];
    const back = loadPlants(JSON.parse(JSON.stringify(savePlants(sites))));
    expect(back.map(({ x, rot, filled, on }) => ({ x, rot, filled, on }))).toEqual(sites.map(({ x, rot, filled, on }) => ({ x, rot, filled, on })));
  });

  it("drops bad rows, impossible switches and pieces floating over an empty layer", () => {
    expect(loadPlants([["wind", 1, 2, 3, 0], ["nuclear", 0, 0, 0, 0], ["wind", 1, 2, 3, 9], "junk", ["wind", 1.5, 2, 3, 0]])).toHaveLength(1);
    expect(loadPlants(undefined)).toEqual([]);
    expect(loadPlants([["wind", 0, 0, 0, 0, -1, 1]])[0]).toMatchObject({ filled: 0, on: false });
    // the tower base (index 9) with no foundation under it: dropped; a lone foundation pad stays
    const [row] = loadPlants([["wind", 0, 0, 0, 0, (1 << 9) | 1, 1]]);
    expect(isFilled(row!, 0)).toBe(true);
    expect(isFilled(row!, 9)).toBe(false);
    expect(row!.on).toBe(false);
  });
});

describe("energy on the status board", () => {
  it("each stage passes on less than it takes in, and the chain multiplies out", async () => {
    const { energyChain, efficiency } = await import("../src/craft/science/energy.js");
    const chain = energyChain("wind", 100);
    expect(chain[0]!.in).toBe(100);
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i]!.in).toBeCloseTo(chain[i - 1]!.out);
      expect(chain[i]!.out).toBeLessThan(chain[i]!.in);
    }
    expect(chain.at(-1)!.out).toBeCloseTo(100 * efficiency("wind"));
    expect(efficiency("wind")).toBeLessThan(0.593); // the Betz limit
  });

  it("only running plants light the village, and never more houses than it has", async () => {
    const { villagePower, VILLAGE_HOUSES, PLANT_OUTPUT } = await import("../src/craft/science/energy.js");
    expect(villagePower([{ kind: "wind", running: false }])).toMatchObject({ supply: 0, lit: 0, running: 0 });
    expect(villagePower([{ kind: "wind", running: true }, { kind: "wind", running: false }]).lit).toBe(PLANT_OUTPUT.wind);
    expect(villagePower(Array.from({ length: 10 }, () => ({ kind: "wind" as const, running: true }))).lit).toBe(VILLAGE_HOUSES);
  });
});

describe("science items in the bag", () => {
  it("frames and parts are stocked only where science mode runs", async () => {
    const { ensureFieldStacks } = await import("../src/craft/inventory.js");
    expect(ensureFieldStacks({}, true)["frame-tower"]).toBe(99);
    expect(ensureFieldStacks({}, true)["part-generator"]).toBe(99);
    expect(ensureFieldStacks({})["frame-tower"]).toBeUndefined();
    expect(ensureFieldStacks({ "part-blades": 5 })["part-blades"]).toBeUndefined();
  });
});

describe("taking items back out", () => {
  it("parts come out any time; the frame only from the top down and after the parts", async () => {
    const { takeOut } = await import("../src/craft/science/plants.js");
    let s = fillAll(fillAll(site(), "frame"), "part");
    const sockets = siteSockets(s);
    const pad = sockets[0]!;
    const hub = sockets.find((c) => c.item === "frame-hub")!;
    const gen = sockets.find((c) => c.item === "part-generator")!;
    expect(takeOut(s, pad.index).result).toBe("parts-first");
    const run = { ...s, on: true };
    const noGen = takeOut(run, gen.index);
    expect(noGen.result).toBe("ok");
    expect(plantStatus(noGen.site)).toBe("inspection"); // a running plant that loses a part stops for a check
    s = fillAll(site(), "frame");
    expect(takeOut(s, pad.index).result).toBe("above"); // the tower rests on it
    expect(takeOut(s, hub.index).result).toBe("ok"); // the top layer comes off
    expect(takeOut(site(), pad.index).result).toBe("empty");
  });
});

describe("fitting mini-games", () => {
  it("grounding: the rod goes in with taps, and the wire holds only on a driven rod", async () => {
    const { grounding, ROD_HITS } = await import("../src/craft/science/miniGameRules.js");
    let s = grounding.start();
    expect(grounding.drop(s, 0).result).toBe("rod-first");
    for (let i = 0; i < ROD_HITS + 2; i++) s = grounding.hit(s);
    expect(grounding.depth(s)).toBe(1);
    expect(grounding.drop(s, 200).result).toBe("miss");
    const ok = grounding.drop(s, 10);
    expect(ok.result).toBe("ok");
    expect(grounding.done(ok.state)).toBe(true);
  });

  it("generator: the meter moves only while the magnet turns, and turning charges it", async () => {
    const { generator, TURNS_NEEDED } = await import("../src/craft/science/miniGameRules.js");
    let s = generator.start();
    s = generator.turn(s, Math.PI / 2, 1 / 30);
    expect(s.meter).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) s = generator.idle(s, 1 / 30);
    expect(s.meter).toBeLessThan(0.05); // stopped: no electricity
    expect(generator.done(s)).toBe(false);
    // either direction counts
    for (let i = 0; i < TURNS_NEEDED * 8; i++) s = generator.turn(s, -Math.PI / 4, 1 / 30);
    expect(generator.done(s)).toBe(true);
  });

  it("wiring: the colour code decides, wrong tries count, a shuffled board never starts solved", async () => {
    const { startWiring, wiring, WIRE_TO } = await import("../src/craft/science/miniGameRules.js");
    for (let seed = 0; seed < 50; seed++) {
      let n = seed;
      const rand = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
      const s = startWiring(rand);
      expect(s.wires.some((w, i) => WIRE_TO[w] === s.terminals[i])).toBe(false);
    }
    let s = startWiring(() => 0.3);
    const bad = wiring.connect(s, "red", "minus");
    expect(bad.result).toBe("wrong");
    s = bad.state;
    expect(s.mistakes).toBe(1);
    for (const w of ["red", "black", "earth"] as const) s = wiring.connect(s, w, WIRE_TO[w]).state;
    expect(wiring.done(s)).toBe(true);
    expect(wiring.connect(s, "red", "plus").result).toBe("taken");
  });

  it("opens on the anchor and the three parts", async () => {
    const { MINI_GAMES } = await import("../src/craft/science/miniGameRules.js");
    expect(Object.keys(MINI_GAMES).sort()).toEqual(["frame-foundation-center", "part-blades", "part-generator", "part-wire-terminal"]);
  });

  it("rotor: three blades, every bolt tight, and it spins smoothly only when evenly spaced", async () => {
    const { rotor } = await import("../src/craft/science/miniGameRules.js");
    let s = rotor.start();
    // bunched on one side: it wobbles
    for (const m of [0, 1, 2]) s = rotor.attach(s, m).state;
    expect(rotor.attach(s, 4).result).toBe("full");
    expect(rotor.attach(s, 0).result).toBe("taken");
    s = rotor.spin(s);
    expect(s.test).toBeNull(); // bolts loose: no test yet
    for (const m of [0, 1, 2]) s = rotor.tighten(s, m).state;
    expect(rotor.tighten(s, 5).result).toBe("no-blade");
    s = rotor.spin(s);
    expect(s.test).toBe("wobble");
    expect(rotor.done(s)).toBe(false);
    // move two blades to every other socket: 120° apart, smooth
    s = rotor.detach(rotor.detach(s, 1), 2);
    expect(s.tight).toEqual([0]);
    for (const m of [2, 4]) s = rotor.tighten(rotor.attach(s, m).state, m).state;
    expect(rotor.balanced(s)).toBe(true);
    expect(rotor.done(rotor.spin(s))).toBe(true);
    // the other even set works too
    let o = rotor.start();
    for (const m of [1, 3, 5]) o = rotor.tighten(rotor.attach(o, m).state, m).state;
    expect(rotor.done(rotor.spin(o))).toBe(true);
  });
});
