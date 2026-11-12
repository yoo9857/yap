// The teacher's tools against the class's water, the way a lesson uses them: seats arranged, water
// poured on and beside plots, one plot drained, the whole class drained, seats cleared, a plot
// reset — on both water engines. After every step two things must hold:
//   - a student's screen (the world built from the messages they were sent) holds exactly the
//     server's water — nothing left standing that the server took away, nothing missing;
//   - once the flow has settled no water is ORPHANED: every running cell has what feeds it (a
//     spring, a fall, stronger water beside it). Orphaned water is "the water stopped".
import { describe, expect, it } from "vitest";
import { WATER, WATER_FALLING, WATER_SETTLED, isWater, plotBounds, waterLevel, type ClassServerMessage } from "@robo/shared";
import { loadRustEngineSync } from "@robo/engine/node";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword } from "../src/classroom/classStore.js";

const { hash, salt } = hashPassword("1234");
const Y = 4;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** A peer that keeps the world its messages describe, as a client does. */
class Screen implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  cells = new Map<string, number>();
  send(msg: ClassServerMessage): void {
    this.inbox.push(msg);
    if (msg.t === "s-k-edit" || msg.t === "s-k-world") for (const [x, y, z, block] of msg.edits) { if (block) this.cells.set(key(x, y, z), block); else this.cells.delete(key(x, y, z)); }
    else if (msg.t === "s-k-water-drained") { for (const [k, block] of [...this.cells]) if (isWater(block)) this.cells.delete(k); }
    else if (msg.t === "s-k-world-reset") this.cells.clear();
    else if (msg.t === "s-k-reject") for (const [x, y, z, block] of msg.edits) { if (block) this.cells.set(key(x, y, z), block); else this.cells.delete(key(x, y, z)); }
  }
  close(): void {}
  water(): Map<string, number> { return new Map([...this.cells].filter(([, block]) => isWater(block))); }
}

for (const engine of ["ts", "rust"] as const) {
  describe(`teacher tools and water (${engine})`, () => {
    const lesson = () => {
      const room = new ClassRoom("Ms Kim", { passHash: hash, salt }, undefined, "Water", { rust: engine === "rust" ? loadRustEngineSync() : null });
      const teacher = new Screen();
      room.hostTeacher(teacher);
      const students = ["Ara", "Jun", "Bo"].map((name) => { const s = new Screen(); room.joinStudent(s, name); return s; });
      room.handle(teacher, { t: "k-move", pos: [500.4, 4, -30.2], yaw: 0, anim: "idle" });
      const settle = () => { for (let i = 0; i < 200; i++) room.stepFluids(Infinity); };
      const server = () => new Map(room.toSaved().edits.filter((e) => isWater(e[3])).map((e) => [key(e[0], e[1], e[2]), e[3]] as [string, number]));
      const plot = (name: string) => plotBounds((([...teacher.inbox].reverse().find((m) => m.t === "s-k-seats") as Extract<ClassServerMessage, { t: "s-k-seats" }>).seats.find((s) => s.name === name))!);
      const check = (step: string) => {
        settle();
        const truth = server();
        for (const [who, screen] of [["teacher", teacher], ["student", students[0]!]] as const) {
          const seen = screen.water();
          const stale = [...seen.keys()].filter((k) => !truth.has(k)), missing = [...truth.keys()].filter((k) => !seen.has(k));
          const wrong = [...truth].filter(([k, block]) => seen.has(k) && seen.get(k) !== block).map(([k]) => k);
          expect({ stale: stale.slice(0, 5), missing: missing.slice(0, 5), wrong: wrong.slice(0, 5) }, `${step}: the ${who}'s screen`).toEqual({ stale: [], missing: [], wrong: [] });
        }
        // no orphaned water
        const orphans: string[] = [];
        for (const [k, block] of truth) {
          if (block === WATER || block === WATER_SETTLED) continue;
          const [x, y, z] = k.split(",").map(Number) as [number, number, number];
          const at = (dx: number, dy: number, dz: number) => truth.get(key(x + dx, y + dy, z + dz)) ?? 0;
          if (block === WATER_FALLING) { if (!isWater(at(0, 1, 0))) orphans.push(k); continue; }
          const fed = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = at(dx!, 0, dz!); return isWater(n) && waterLevel(n) <= waterLevel(block); }) || isWater(at(0, 1, 0));
          if (!fed) orphans.push(k);
        }
        expect(orphans.slice(0, 5), `${step}: orphaned water`).toEqual([]);
        return truth;
      };
      // (a client writes its own edit at once — the server does not echo it back to the sender)
      const pour = (peer: Screen, x: number, z: number, y = Y) => { peer.cells.set(key(x, y, z), WATER); room.handle(peer, { t: "k-edit", edits: [[x, y, z, WATER, 0]] }); };
      return { room, teacher, students, check, pour, plot };
    };

    it("seats, pours, a plot drained, everything drained, seats cleared, a plot reset", () => {
      const { room, teacher, students, check, pour, plot } = lesson();
      // water before any seats, where the plots will be laid
      pour(teacher, 510, -20); pour(teacher, 500, -31);
      check("before seats");
      room.handle(teacher, { t: "k-arrange", yaw: 0 });
      check("seats arranged over standing water");
      const [ax0, , az0] = plot("Ara"), [jx0, , jz0] = plot("Jun");
      const ax = Math.ceil(ax0), az = Math.ceil(az0), jx = Math.ceil(jx0), jz = Math.ceil(jz0);
      pour(teacher, ax + 5, az + 5); pour(teacher, ax, az + 8); pour(teacher, jx + 4, jz + 4);
      pour(students[0]!, ax + 9, az + 12);          // Ara on her own plot
      pour(teacher, ax + 6, az + 6, Y + 4);          // from up in the air: a fall
      const full = check("poured on plots");
      expect(full.size).toBeGreaterThan(150);
      room.handle(teacher, { t: "k-plot", name: "Ara", op: "drain" });
      const drained = check("Ara's plot drained");
      expect(drained.size).toBeLessThan(full.size);
      expect(drained.size).toBeGreaterThan(20); // Jun's stays
      pour(teacher, ax + 5, az + 5);
      check("poured again on the drained plot");
      room.handle(teacher, { t: "k-lesson", freeze: true });
      pour(teacher, ax + 2, az + 2);
      check("frozen class, the teacher pours");
      room.handle(teacher, { t: "k-lesson", freeze: false });
      room.handle(teacher, { t: "k-drain-water" });
      expect(check("all water drained").size).toBe(0);
      pour(teacher, ax + 5, az + 5); pour(teacher, ax + 14, az + 5); pour(teacher, jx, jz + 5);
      check("poured after the drain, against the fences");
      room.handle(teacher, { t: "k-arrange", clear: true });
      check("seats cleared: the water crosses again");
      room.handle(teacher, { t: "k-arrange", yaw: 0 });
      check("seats arranged again");
      room.handle(teacher, { t: "k-plot", name: "Ara", op: "reset" });
      check("Ara's plot reset");
      room.handle(teacher, { t: "k-arrange", roam: true });
      pour(teacher, ax + 7, az + 7);
      check("roaming, poured");
    });
  });
}
