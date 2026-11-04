// The game's water on the Rust engine (`?engine=rust`) must leave the world EXACTLY as the
// TypeScript rules do, tick by tick: the real VoxelWorld/FieldWindow, shaped blocks holding water,
// solid furniture, edits while it flows and field scrolls (the mirror reloads, the ring outside the
// window comes from the field's bank). Runs on the committed build (@robo/engine), i.e. what ships.
import { loadRustEngineSync } from "@robo/engine/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLUID_STEP, ROUND, WATER, kitSlopeShape, slabShape, stairsShape, cornerShape } from "@robo/shared";
import { FieldWindow } from "../src/craft/fieldWorld.js";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { WaterSim, type FurnitureSource } from "../src/craft/waterSim.js";
import type { VoxelView } from "../src/craft/voxelView.js";
import type { RustEngine } from "../src/engine/rustEngine.js";

const STONE = 3;
const view = { markWaterDirty: () => {} } as unknown as VoxelView;
const SHAPES = [slabShape(0, 0), slabShape(0, 2), kitSlopeShape(0, 0), kitSlopeShape(2, 0), stairsShape(1, 0), cornerShape(0, 0), ROUND];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** One side of the comparison: a world, its furniture, its water. */
function side(field: boolean, rust: RustEngine | null) {
  const fw = field ? new FieldWindow() : null;
  const world = fw ? fw.world : new VoxelWorld();
  if (!fw) for (let x = 0; x < 160; x++) for (let z = 0; z < 160; z++) for (let y = 0; y < 4; y++) world.set(x, y, z, STONE);
  const props = new Set<string>();
  let propsVersion = 0;
  const ox = () => fw?.absOriginX ?? 0, oz = () => fw?.absOriginZ ?? 0;
  world.propSolid = (x, y, z) => props.has(`${x + ox()},${y},${z + oz()}`);
  const furniture: FurnitureSource = { version: () => propsVersion, solidCells: () => [...props].flatMap((k) => k.split(",").map(Number)) };
  const sim = new WaterSim(world, view, fw, { rust, furniture, maxStepMs: Infinity });
  return {
    world, fw, sim,
    /** A solid furniture cell at a GRID cell (absolute inside). */
    prop: (x: number, y: number, z: number) => { props.add(`${x + ox()},${y},${z + oz()}`); propsVersion++; sim.touch(x, y, z); },
    edit: (x: number, y: number, z: number, block: number, shape = 0) => { world.setShaped(x, y, z, block, shape); sim.touch(x, y, z); },
  };
}

describe("the game's water: Rust engine = TypeScript (?engine=rust)", () => {
  const engine: RustEngine = loadRustEngineSync();
  // wakeSlice yields on a 1 ms clock: freeze it so both sides wake the same cells on the same tick
  beforeEach(() => { vi.spyOn(performance, "now").mockReturnValue(0); });
  afterEach(() => { vi.restoreAllMocks(); });

  for (let seed = 1; seed <= 10; seed++) {
    const field = seed % 4 !== 0;
    it(`seed ${seed} (${field ? "field" : "island"}): identical world after every tick`, () => {
      const r = rng(seed), ts = side(field, null), rs = side(field, engine);
      expect(ts.sim.engine).toBe("ts");
      expect(rs.sim.engine).toBe("rust");
      const both = (fn: (s: ReturnType<typeof side>) => void) => { fn(ts); fn(rs); };
      const Y = field ? 4 : 4, cx = 80, cz = 80;
      // a dug pool with stone rims, shaped blocks scattered in and around it, and furniture
      const ops: [number, number, number, number, number][] = [];
      for (let x = cx - 6; x <= cx + 6; x++) for (let z = cz - 6; z <= cz + 6; z++) {
        const rim = Math.abs(x - cx) === 6 || Math.abs(z - cz) === 6;
        ops.push([x, Y - 1, z, rim ? STONE : 0, 0]);
        if (rim && r() < 0.15) ops.push([x, Y - 1, z, STONE, SHAPES[Math.floor(r() * SHAPES.length)]!]);
      }
      for (let i = 0; i < 40; i++) ops.push([cx - 12 + Math.floor(r() * 24), Y - 1 + Math.floor(r() * 2), cz - 12 + Math.floor(r() * 24), STONE, r() < 0.7 ? SHAPES[Math.floor(r() * SHAPES.length)]! : 0]);
      both((s) => { for (const [x, y, z, b, sh] of ops) s.edit(x, y, z, b, sh); });
      both((s) => { s.prop(cx + 3, Y - 1, cz + 2); s.prop(cx - 9, Y, cz); });
      const sources = [[cx - 3, Y - 1, cz - 3], [cx + 2, Y - 1, cz + 4], [cx - 10, Y, cz + 8]] as const;
      both((s) => { for (const [x, y, z] of sources) s.edit(x, y, z, WATER); s.sim.wakeAll(); });

      let moved = 0;
      for (let tick = 0; tick < 260; tick++) {
        if (tick === 60) both((s) => { s.edit(cx - 3, Y - 1, cz - 3, 0); s.edit(cx, Y - 1, cz + 1, STONE, stairsShape(2, 0)); });
        if (tick === 90) both((s) => s.prop(cx + 1, Y - 1, cz - 1));
        if (tick === 120 && field) both((s) => { s.fw!.recenter({ x: 80 + 32, z: 80 }); });
        if (tick === 170 && field) both((s) => { s.fw!.recenter({ x: 80 - 32, z: 80 }); });
        const a = ts.sim.update(FLUID_STEP), b = rs.sim.update(FLUID_STEP);
        expect(b, `changes at tick ${tick}`).toBe(a);
        moved += a;
        if (a > 0 || tick % 20 === 0) {
          expect(Buffer.compare(rs.world.cells, ts.world.cells), `cells at tick ${tick}`).toBe(0);
          expect(Buffer.compare(rs.world.shapes, ts.world.shapes), `shapes at tick ${tick}`).toBe(0);
          expect(Buffer.compare(rs.world.wet, ts.world.wet), `wet at tick ${tick}`).toBe(0);
        }
      }
      expect(moved, "the scenario must move water").toBeGreaterThan(50);
      expect(ts.world.wet.some((w) => w !== 0), "some shaped block must hold water").toBe(true);
      ts.sim.dispose(); rs.sim.dispose();
    });
  }

  it("a Rust failure mid-game falls back to the TypeScript rules and the water carries on", () => {
    const rs = side(true, engine);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    rs.edit(80, 4, 80, WATER); rs.sim.wakeAll();
    for (let i = 0; i < 5; i++) rs.sim.update(FLUID_STEP);
    // make the wasm trap on its next step
    const backend = (rs.sim as unknown as { backend: { water: { step(): Int32Array } } }).backend;
    backend.water.step = () => { throw new WebAssembly.RuntimeError("unreachable"); };
    expect(() => rs.sim.update(FLUID_STEP)).not.toThrow();
    expect(rs.sim.engine).toBe("ts");
    expect(rs.world.onWrite).toBeNull();
    for (let i = 0; i < 80; i++) rs.sim.update(FLUID_STEP);
    expect(rs.world.get(87, 4, 80)).not.toBe(0); // the stream reached its full reach anyway
    expect(warn).toHaveBeenCalled();
  });
});
