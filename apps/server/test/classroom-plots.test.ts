// The teacher's per-student tools (kids' feedback 2026-11-11): one plot's water out, one plot
// back to grass, power plants locked for students, pets off for the class.
import { describe, expect, it } from "vitest";
import { PLANT_KINDS, WATER, classSettingsSchema, decodeClassClient, isWater, plotBounds, type ClassServerMessage } from "@robo/shared";
import { loadRustEngineSync } from "@robo/engine/node";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
import { hashPassword } from "../src/classroom/classStore.js";

const { hash, salt } = hashPassword("1234");
const AUTH = { passHash: hash, salt };
const STONE = 3, Y = 4;

class Peer implements ClassPeer {
  inbox: ClassServerMessage[] = [];
  send(msg: ClassServerMessage): void { this.inbox.push(msg); }
  close(): void {}
  last<T extends ClassServerMessage["t"]>(t: T): Extract<ClassServerMessage, { t: T }> | undefined {
    return [...this.inbox].reverse().find((m) => m.t === t) as Extract<ClassServerMessage, { t: T }> | undefined;
  }
}

/** A class seated in front of the teacher, and a cell well inside each student's plot. */
function seated(...names: string[]) {
  const room = new ClassRoom("Ms Kim", AUTH), teacher = new Peer();
  room.hostTeacher(teacher);
  const peers = new Map<string, Peer>();
  for (const n of names) { const p = new Peer(); room.joinStudent(p, n); peers.set(n, p); }
  room.handle(teacher, { t: "k-move", pos: [500.4, 4, -30.2], yaw: 0, anim: "idle" });
  room.handle(teacher, { t: "k-arrange", yaw: 0 });
  const cell = (name: string, dx = 3, dz = 3): [number, number] => {
    const [x0, , z0] = plotBounds(teacher.last("s-k-seats")!.seats.find((s) => s.name === name)!);
    return [Math.ceil(x0) + dx, Math.ceil(z0) + dz];
  };
  const blockAt = (x: number, y: number, z: number) => room.toSaved().edits.find((e) => e[0] === x && e[1] === y && e[2] === z)?.[3];
  return { room, teacher, peers, cell, blockAt };
}

describe("one student's plot", () => {
  it("drain takes the water out of that plot only; blocks and the neighbour's water stay", () => {
    const { room, teacher, peers, cell, blockAt } = seated("Ara", "Jun");
    const [ax, az] = cell("Ara"), [jx, jz] = cell("Jun");
    room.handle(teacher, { t: "k-edit", edits: [[ax, Y, az, WATER, 0], [ax + 1, Y, az, STONE, 0], [jx, Y, jz, WATER, 0]] });
    room.handle(teacher, { t: "k-plot", name: "ara ", op: "drain" }); // by name, any case or spacing
    expect(blockAt(ax, Y, az)).toBeUndefined();
    expect(blockAt(ax + 1, Y, az)).toBe(STONE);
    expect(blockAt(jx, Y, jz)).toBe(WATER);
    // everyone is told with an ordinary edit from the server
    const told = peers.get("Jun")!.inbox.filter((m) => m.t === "s-k-edit" && m.by === "").flatMap((m) => (m.t === "s-k-edit" ? m.edits : []));
    expect(told).toContainEqual([ax, Y, az, 0, 0]);
  });

  it("reset puts that plot back to grass: blocks, dug holes, furniture and power plants; the neighbour's stay", () => {
    const { room, teacher, peers, cell, blockAt } = seated("Ara", "Jun");
    const [ax, az] = cell("Ara"), [jx, jz] = cell("Jun");
    room.handle(teacher, { t: "k-edit", edits: [[ax, Y, az, STONE, 0], [ax + 2, Y - 1, az, 0, 0], [jx, Y, jz, STONE, 0]] }); // a block, a dug hole
    room.handle(teacher, { t: "k-furniture", placed: [["chair", ax + 4, Y, az, 0, 0], ["chair", jx + 4, Y, jz, 0, 0]], removed: [] });
    room.handle(teacher, { t: "k-plant", op: "lay", kind: PLANT_KINDS[0]!, x: ax, y: Y, z: az + 6, rot: 0 });
    const plant = teacher.last("s-k-plants")!.plants[0]![0];
    expect(room.toSaved().plants).toHaveLength(1);

    room.handle(teacher, { t: "k-plot", name: "Ara", op: "reset" });
    expect(blockAt(ax, Y, az)).toBeUndefined();
    expect(blockAt(ax + 2, Y - 1, az)).toBeUndefined();          // the hole is ground again
    expect(blockAt(jx, Y, jz)).toBe(STONE);
    expect(room.toSaved().furniture).toEqual([["chair", jx + 4, Y, jz, 0, 0]]);
    expect(room.toSaved().plants ?? []).toHaveLength(0);
    const jun = peers.get("Jun")!;
    expect(jun.last("s-k-plants")!.removed).toEqual([plant]);
    expect(jun.last("s-k-furniture")!.furniture).toEqual([["chair", jx + 4, Y, jz, 0, 0]]);
    const told = jun.inbox.filter((m) => m.t === "s-k-edit" && m.by === "").flatMap((m) => (m.t === "s-k-edit" ? m.edits : []));
    expect(told).toContainEqual([ax, Y, az, 0, 0]);
    expect(told.find((e) => e[0] === ax + 2 && e[1] === Y - 1 && e[2] === az)![3]).not.toBe(0); // ground, not air
  });

  it("is the teacher's alone, and needs a seating", () => {
    const { room, teacher, peers, cell, blockAt } = seated("Ara");
    const [ax, az] = cell("Ara");
    room.handle(teacher, { t: "k-edit", edits: [[ax, Y, az, STONE, 0]] });
    room.handle(peers.get("Ara")!, { t: "k-plot", name: "Ara", op: "reset" });
    expect(blockAt(ax, Y, az)).toBe(STONE);
    room.handle(teacher, { t: "k-arrange", clear: true });
    room.handle(teacher, { t: "k-plot", name: "Ara", op: "reset" });
    expect(blockAt(ax, Y, az)).toBe(STONE);
    expect(teacher.last("s-k-chat")!.text).toContain("자리");
    expect(decodeClassClient(JSON.stringify({ t: "k-plot", name: "Ara", op: "explode" }))).toBeNull();
  });
});

describe("class switches for power plants and pets", () => {
  it("plants locked: a student cannot start one, the teacher can; both switches reach everyone and are saved", () => {
    const { room, teacher, peers, cell } = seated("Ara");
    const [ax, az] = cell("Ara"), ara = peers.get("Ara")!;
    room.handle(teacher, { t: "k-settings", chatLocked: false, buildLocked: false, plantsLocked: true, petsOff: true });
    expect(ara.last("s-k-settings")!.settings).toMatchObject({ plantsLocked: true, petsOff: true });
    room.handle(ara, { t: "k-move", pos: [ax + 0.5, Y, az + 0.5], yaw: 0, anim: "idle" });
    room.handle(ara, { t: "k-plant", op: "lay", kind: PLANT_KINDS[0]!, x: ax, y: Y, z: az + 3, rot: 0 });
    expect(ara.last("s-k-plants")!.refused).toBe("locked");
    room.handle(teacher, { t: "k-plant", op: "lay", kind: PLANT_KINDS[0]!, x: ax, y: Y, z: az + 3, rot: 0 });
    expect(room.toSaved().plants).toHaveLength(1);
    // an older "taps only" settings message keeps the two switches as they were
    room.handle(teacher, { t: "k-settings", chatLocked: false, buildLocked: false });
    expect(room.toSaved().settings).toMatchObject({ plantsLocked: true, petsOff: true });
    expect(classSettingsSchema.safeParse(room.toSaved().settings).success).toBe(true);
  });
});

describe("water stays on the plot it was poured on", () => {
  const settle = (room: ClassRoom) => { for (let i = 0; i < 120; i++) room.stepFluids(Infinity); };
  /** Every water cell of the saved field that lies inside a named student's plot. */
  const wetOn = (room: ClassRoom, seat: { pos: [number, number, number]; yaw: number }) => {
    const [x0, x1, z0, z1] = plotBounds(seat);
    return room.toSaved().edits.filter((e) => isWater(e[3]) && e[0] >= x0 && e[0] + 1 <= x1 && e[2] >= z0 && e[2] + 1 <= z1).length;
  };

  for (const engine of ["ts", "rust"] as const) it(`${engine}: a bucket by the fence floods its own plot, not the neighbour's; without plots it runs free`, () => {
    const room = new ClassRoom("Ms Kim", AUTH, undefined, "Walls", { rust: engine === "rust" ? loadRustEngineSync() : null });
    const teacher = new Peer();
    room.hostTeacher(teacher);
    for (const n of ["Ara", "Jun"]) room.joinStudent(new Peer(), n);
    room.handle(teacher, { t: "k-move", pos: [500.4, 4, -30.2], yaw: 0, anim: "idle" });
    room.handle(teacher, { t: "k-arrange", yaw: 0 });
    const seats = teacher.last("s-k-seats")!.seats, ara = seats.find((x) => x.name === "Ara")!, jun = seats.find((x) => x.name === "Jun")!;
    const [ax0, ax1, az0] = plotBounds(ara), [jx0, jx1] = plotBounds(jun);
    // the two plots share a fence: pour in Ara's cell right against it
    const shared = ax1 === jx0 ? Math.ceil(ax1) - 1 : Math.ceil(ax0);
    expect(ax1 === jx0 || jx1 === ax0).toBe(true);
    room.handle(teacher, { t: "k-edit", edits: [[shared, Y, Math.ceil(az0) + 5, WATER, 0]] });
    settle(room);
    expect(room.fluidEngine).toBe("ts"); // a seated class runs the rules that know the walls
    expect(wetOn(room, ara)).toBeGreaterThan(8);
    expect(wetOn(room, jun)).toBe(0);
    // the plots go: the same source now runs across where the fence was
    room.handle(teacher, { t: "k-arrange", clear: true });
    settle(room);
    expect(wetOn(room, jun)).toBeGreaterThan(0);
    // and seated again, what had crossed drains away
    room.handle(teacher, { t: "k-arrange", yaw: 0 });
    settle(room);
    const again = teacher.last("s-k-seats")!.seats.find((x) => x.name === "Jun")!;
    expect(wetOn(room, again)).toBe(0);
  });
});
