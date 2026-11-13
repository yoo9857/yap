// The fire drill's rules (craft/fire/drillRules.ts): the order of the lesson, the extinguisher,
// the smoke, and the end. Pure — no browser.
import { describe, expect, it } from "vitest";
import { fireSchool } from "@robo/shared";
import { CHARGE_S, DRAIN, EXTINGUISH_S, SMOKE_GRACE_S, drillStars, newDrill, panelDone, rayBox, smokeOn, tickDrill, useStation, type Drill, type DrillEnv } from "../src/craft/fire/drillRules.js";
import * as G from "../src/craft/fire/drillRules.js";
import { POSTURE_EYE } from "../src/craft/posture.js";

const school = fireSchool();
const small = school.fires.find((f) => f.small)!;
const CX=school.retry[0],CZ=(school.corridor[2]+school.corridor[5])/2;
const outside=(extra=0)=>env(0,school.exitZone[5]+1+extra,{y:4,eyeY:5.55});
const DT = 1 / 60;

/** Standing at (x, z) in the corridor, looking along +x unless told otherwise. */
function env(x: number, z: number, over: Partial<DrillEnv> = {}): DrillEnv {
  const y = school.retry[1];
  return { x, y, z, eyeY: y + POSTURE_EYE.stand, spraying: false, ox: x, oy: y + POSTURE_EYE.stand, oz: z, dx: 1, dy: 0, dz: 0, ...over };
}

/** Looking from the eye at a point. */
function aimAt(x: number, z: number, target: readonly [number, number, number], over: Partial<DrillEnv> = {}): DrillEnv {
  const e = env(x, z, over);
  const v = [target[0] - e.ox, target[1] - e.oy, target[2] - e.oz];
  const len = Math.hypot(v[0]!, v[1]!, v[2]!);
  return { ...e, dx: v[0]! / len, dy: v[1]! / len, dz: v[2]! / len };
}

function run(d: Drill, seconds: number, e: DrillEnv): string[] {
  const seen = new Set<string>();
  for (let i = 0; i < Math.round(seconds / DT); i++) for (const ev of tickDrill(d, DT, e).events) seen.add(ev);
  return [...seen];
}

/** A drill taken to `spray` with a full extinguisher in hand. */
function armed(): Drill {
  const d = newDrill();
  useStation(d, "alarm");
  useStation(d, "phone");
  panelDone(d, "call");
  useStation(d, "extinguisher");
  panelDone(d, "pass");
  return d;
}

describe("the order of the lesson", () => {
  it("alarm → 119 → extinguisher, each opening the next", () => {
    const d = newDrill();
    expect(useStation(d, "phone")).toBe("later");
    expect(useStation(d, "extinguisher")).toBe("later");
    expect(d.step).toBe("alarm");

    expect(useStation(d, "alarm")).toBe("alarm");
    expect(d.alarm).toBe(true);
    expect(d.step).toBe("call");
    expect(useStation(d, "alarm")).toBe("already");

    // the call is a lesson: opening it changes nothing until it is finished
    expect(useStation(d, "phone")).toBe("panel-call");
    expect(d.step).toBe("call");
    panelDone(d, "call");
    expect(d.step).toBe("grab");
    expect(useStation(d, "phone")).toBe("already");

    expect(useStation(d, "extinguisher")).toBe("panel-pass");
    expect(d.extinguisher).toBe(false); // closed without finishing: nothing in hand
    panelDone(d, "pass");
    expect(d).toMatchObject({ step: "spray", extinguisher: true, trained: true, charge: 1 });
  });

  it("a lesson finished out of turn does nothing", () => {
    const d = newDrill();
    panelDone(d, "pass");
    panelDone(d, "call");
    expect(d).toMatchObject({ step: "alarm", extinguisher: false, trained: false });
  });

  it("the exit sign only ever explains itself", () => {
    const d = newDrill();
    expect(useStation(d, "sign")).toBe("info");
    expect(d.step).toBe("alarm");
  });
});

describe("the extinguisher", () => {
  it("puts the small fire out when aimed at its base from close by", () => {
    const d = armed();
    const e = aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true });
    const events = run(d, EXTINGUISH_S + 0.2, e);
    expect(events).toContain("hit");
    expect(events).toContain("fire-out");
    expect(d.fire).toBe(0);
    expect(d.extinguisher).toBe(false); // set down: the big fire is not ours
    expect(d.step).toBe("towel");
    expect(smokeOn(d)).toBe(true);
  });

  it("barely helps on the flames, and says so", () => {
    const d = armed();
    const flames: [number, number, number] = [small.at[0], small.at[1] + 0.9 * small.size, small.at[2]];
    // from close and level with the flames, so the ray passes well over the base
    const e = aimAt(small.at[0] + 2, small.at[2], flames, { oy: flames[1], eyeY: flames[1], spraying: true });
    const events = run(d, EXTINGUISH_S, e);
    expect(events).toContain("aim-low");
    expect(events).not.toContain("hit");
    expect(d.fire).toBeGreaterThan(0.6);
    expect(d.step).toBe("spray");
  });

  it("does nothing from too far, or aimed elsewhere, or with the button up", () => {
    const far = armed();
    expect(run(far, 2, aimAt(small.at[0] + 9, small.at[2], small.at, { spraying: true }))).toContain("too-far");
    expect(far.fire).toBe(1);

    const away = armed();
    const events = run(away, 2, env(small.at[0] + 2, small.at[2], { spraying: true })); // looking east, the fire is west
    expect(events).toEqual(["spray"]);
    expect(away.fire).toBe(1);

    const idle = armed();
    expect(run(idle, 2, aimAt(small.at[0] + 2, small.at[2], small.at))).toEqual([]);
    expect(idle).toMatchObject({ fire: 1, charge: 1 });
  });

  it("runs dry, and a fresh one is simply picked up (the lesson is not repeated)", () => {
    const d = armed();
    const events = run(d, CHARGE_S + 0.5, env(small.at[0] + 2, small.at[2], { spraying: true }));
    expect(events).toContain("empty");
    expect(d).toMatchObject({ extinguisher: false, step: "spray", fire: 1 });
    expect(useStation(d, "extinguisher")).toBe("grab");
    expect(d).toMatchObject({ extinguisher: true, charge: 1 });
    expect(useStation(d, "extinguisher")).toBe("already");
  });

  it("is not taken again once the small fire is out", () => {
    const d = armed();
    run(d, EXTINGUISH_S + 0.2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    expect(useStation(d, "extinguisher")).toBe("already");
    expect(d.extinguisher).toBe(false);
  });
});

describe("smoke", () => {
  /** A drill at `escape` with the towel on. */
  function escaping(towel = true): Drill {
    const d = armed();
    run(d, EXTINGUISH_S + 0.2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    if (towel) useStation(d, "towel");
    d.air = 1; d.smokeTime = 0; d.mistakes = 0; d.smokeIn = 0;
    d.time = d.smokeClock = 400; // …and the smoke has come all the way along the corridor
    return d;
  }
  const low = { eyeY: school.retry[1] + POSTURE_EYE.crawl };

  it("fills the corridor only once the small fire is dealt with", () => {
    const d = armed();
    expect(smokeOn(d)).toBe(false);
    expect(run(d, 3, env(CX, CZ))).toEqual([]);
    expect(d.air).toBe(1);
  });

  it("costs breath standing, nothing crawling with a towel", () => {
    const standing = escaping();
    expect(standing.step).toBe("escape");
    expect(run(standing, 2, env(CX, CZ))).toContain("smoke");
    expect(standing.air).toBeLessThan(0.9);
    expect(standing.air).toBeGreaterThan(0.8); // a towel buys time even upright
    expect(standing.smokeTime).toBeGreaterThan(1.9);

    const crawling = escaping();
    expect(run(crawling, 5, env(CX, CZ, low))).toEqual([]);
    expect(crawling).toMatchObject({ air: 1, smokeTime: 0 });
  });

  it("asks for the towel: low without one still costs a little, and upright costs more", () => {
    const bare = escaping(false);
    expect(bare.step).toBe("towel");
    expect(run(bare, 2, env(CX, CZ, low))).toContain("need-towel");
    const lowAir = bare.air;
    expect(lowAir).toBeLessThan(1);

    const upright = escaping(false);
    run(upright, 2, env(CX, CZ));
    const covered = escaping(true);
    run(covered, 2, env(CX, CZ));
    expect(upright.air).toBeLessThan(covered.air); // the towel helps even standing
    expect(covered.air).toBeLessThan(lowAir);
  });

  it("a towel taken early passes its step by itself", () => {
    const d = armed();
    expect(useStation(d, "towel")).toBe("towel");
    expect(d.step).toBe("spray");
    run(d, EXTINGUISH_S + 0.2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    expect(d.step).toBe("escape");
    expect(useStation(d, "towel")).toBe("already");
  });

  it("the west end is shut whatever you do, and the burning room is always too hot", () => {
    const d = escaping();
    expect(run(d, 1, env(school.thickWest - .3, CZ, low))).toContain("thick");
    expect(d.air).toBeLessThan(1);

    const fresh = newDrill(); // heat does not wait for the drill to get anywhere
    expect(run(fresh, 1, env((school.heat[0]+school.heat[3])/2,(school.heat[2]+school.heat[5])/2))).toContain("heat");
    expect(fresh.air).toBeLessThan(0.6);
  });

  it("gives a moment to react before it costs anything", () => {
    const d = armed();
    run(d, EXTINGUISH_S + 0.2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    d.time = d.smokeClock = 400; // the smoke has long come along the corridor: only the grace is being measured
    expect(d.smokeIn).toBeGreaterThan(SMOKE_GRACE_S - 0.5);
    expect(run(d, SMOKE_GRACE_S - 0.6, env(CX, CZ))).toEqual([]);
    expect(d.air).toBe(1);
    expect(run(d, 1.5, env(CX, CZ))).toContain("smoke");
  });

  it("overcome: one mistake, breath back, and the drill goes on", () => {
    const d = escaping(false);
    const events = run(d, 1 / DRAIN.upright + 1, env(CX, CZ));
    expect(events).toContain("fainted");
    expect(d.mistakes).toBe(1);
    expect(d.step).toBe("towel");
    expect(d.air).toBeGreaterThan(0);
  });

  it("clean air gives breath back", () => {
    const d = escaping();
    run(d, 2, env(CX, CZ));
    const spent = d.air;
    run(d, 3, outside(2)); // outside
    expect(d.air).toBeGreaterThan(spent);
  });
});

describe("the way out", () => {
  it("leaving before the drill gets there is only remarked on", () => {
    const d = newDrill();
    expect(run(d, 0.5, outside(1))).toContain("early");
    expect(d.step).toBe("alarm");
    // standing on the pad early finishes nothing
    run(d, 0.5, env(school.assembly.x, school.assembly.z,{y:4,eyeY:5.55}));
    expect(d.step).toBe("alarm");
  });

  it("out through the exit, then the gathering place ends it — and the clock stops", () => {
    const d = armed();
    run(d, EXTINGUISH_S + 0.2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    useStation(d, "towel");
    expect(run(d, 0.1, outside())).toContain("outside");
    expect(d.step).toBe("assemble");
    expect(run(d, 0.1, env(school.assembly.x + 1, school.assembly.z,{y:4,eyeY:5.55}))).toContain("done");
    expect(d.step).toBe("done");
    const time = d.time;
    expect(run(d, 5, env(CX, CZ))).toEqual([]);
    expect(d.time).toBe(time);
    expect(smokeOn(d)).toBe(false);
    expect(drillStars(d)).toBe(3);
  });

  it("stars: clean is three, a little smoke two, overcome more than once one", () => {
    const d = newDrill();
    expect(drillStars(d)).toBe(3);
    d.smokeTime = 5;
    expect(drillStars(d)).toBe(3); // the walk to the sink
    d.smokeTime = 9;
    expect(drillStars(d)).toBe(2);
    d.mistakes = 1;
    expect(drillStars(d)).toBe(2);
    d.mistakes = 2;
    expect(drillStars(d)).toBe(1);
    d.mistakes = 0; d.smokeTime = 30;
    expect(drillStars(d)).toBe(1);
  });
});

describe("aiming at a station", () => {
  const box = [0, 0, 0, 1, 1, 1] as const;
  it("hits a box ahead within reach, at the distance of its near face", () => {
    expect(rayBox(0.5, 0.5, -3, 0, 0, 1, box, 4.5)).toBeCloseTo(3);
    expect(rayBox(0.5, 0.5, -6, 0, 0, 1, box, 4.5)).toBeNull(); // out of reach
    expect(rayBox(0.5, 0.5, -3, 0, 0, -1, box, 4.5)).toBeNull(); // behind
    expect(rayBox(2.5, 0.5, -3, 0, 0, 1, box, 4.5)).toBeNull(); // beside
    expect(rayBox(0.5, 0.5, 0.5, 1, 0, 0, box, 4.5)).toBe(0); // from inside
  });
  it("every station can be aimed at from the corridor in front of it", () => {
    for (const s of school.stations) {
      const cx = (s.box[0] + s.box[3]) / 2, cy = (s.box[1] + s.box[4]) / 2, cz = (s.box[2] + s.box[5]) / 2;
      // two metres out along the way it faces
      const [fx, fz] = [[0, 1], [1, 0], [0, -1], [-1, 0]][s.rot]!;
      const ox = cx + fx! * 2, oz = cz + fz! * 2, oy = school.retry[1] + POSTURE_EYE.stand;
      const len = Math.hypot(cx - ox, cy - oy, cz - oz);
      expect(rayBox(ox, oy, oz, (cx - ox) / len, (cy - oy) / len, (cz - oz) / len, s.box, 4.5), s.kind).not.toBeNull();
    }
  });
});

// A fire left alone gets worse — by the drill's own clock, the same on every screen.
describe("the fire grows", () => {
  const f = G.burnField();

  it("is one burning area: it covers the burning room, and only it", () => {
    expect(f.x0).toBe(school.heat[0]);
    expect(f.z0).toBe(school.heat[2]);
    expect(f.x0 + f.w * f.cell).toBeGreaterThanOrEqual(school.heat[3]);
    expect(f.z0 + f.h * f.cell).toBeGreaterThanOrEqual(school.heat[5]);
    expect(G.burnAt(school.retry[0], school.retry[2], 1e4)).toBe(0); // the corridor never burns
  });

  it("burns where the school says the fire started, and only there at first", () => {
    const origin = school.fires.find((x) => x.id === "corner") ?? school.fires.find((x) => !x.small)!;
    expect(G.burnAt(origin.at[0], origin.at[2], 0)).toBeGreaterThan(0.5);
    let burning = 0;
    for (let k = 0; k < f.ignite.length; k++) if (f.ignite[k]! < 0) burning++;
    expect(burning).toBeGreaterThan(8);
    expect(burning / f.ignite.length).toBeLessThan(0.2);
  });

  it("spreads from its edge: every spot catches after a neighbour did (no fire appears out of nothing)", () => {
    let first = 0;
    for (let j = 0; j < f.h; j++) for (let i = 0; i < f.w; i++) {
      const t = f.ignite[j * f.w + i]!;
      let earlier = false;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < f.w && nj < f.h && f.ignite[nj * f.w + ni]! < t) earlier = true;
      }
      if (!earlier) first++;
    }
    expect(first).toBe(1); // the one place it started
  });

  it("takes the whole room in the end: what has caught never goes back", () => {
    for (let k = 0; k < f.ignite.length; k++) {
      expect(f.ignite[k]).toBeLessThanOrEqual(G.BURN_SPREAD_S + 1e-3);
      expect(f.fuel[k]).toBeGreaterThanOrEqual(1);
    }
    for (let t = 0, all = 0; t < 420; t += 3) {
      const level = G.blaze(t).level;
      expect(level).toBeGreaterThanOrEqual(all); expect(level).toBeLessThanOrEqual(1); all = level;
    }
    expect(G.blaze(0).level).toBeLessThan(0.15);
    expect(G.blaze(G.BURN_SPREAD_S + 150).level).toBeGreaterThan(0.99);
  });

  it("a spot burns up, then sinks to what its fuel keeps: a long fire is not one even wall of flame", () => {
    const peak = G.burnPower(G.BURN_GROW_S + 5), late = G.burnPower(600);
    expect(peak).toBeCloseTo(G.BURN_PEAK, 1);
    expect(late).toBeCloseTo(G.burnSettle(1));
    expect(late).toBeLessThan(peak * 0.4); // bare floor: a low fire over its coals
    expect(late).toBeGreaterThan(0.2); // …but still burning
    expect(G.burnPower(600, 1.5)).toBeGreaterThan(0.9); // real fuel (a bench) keeps its fire
    for (let age = -5, was = 0; age < G.BURN_GROW_S; age += 1) { const p = G.burnPower(age); expect(p).toBeGreaterThanOrEqual(was); was = p; }
    for (let age = G.BURN_HOLD_S, was = 9; age < 300; age += 5) { const p = G.burnPower(age); expect(p).toBeLessThanOrEqual(was); was = p; }
    expect(G.burnPower(-1)).toBe(0);
  });

  it("the middle of what burns walks from where it started toward the middle of the room", () => {
    const early = G.blaze(5), late = G.blaze(400);
    const cx = (school.heat[0] + school.heat[3]) / 2, cz = (school.heat[2] + school.heat[5]) / 2;
    expect(Math.hypot(late.x - cx, late.z - cz)).toBeLessThan(0.6);
    expect(Math.hypot(early.x - cx, early.z - cz)).toBeGreaterThan(3);
  });

  it("the waste-bin fire is small only for a while: bigger, and longer to put out", () => {
    expect(G.binSize(0)).toBe(1);
    expect(G.binSize(G.BIN_CALM_S)).toBe(1);
    expect(G.binSize(600)).toBeCloseTo(G.BIN_GROWTH);
    const late = armed();
    late.time = 600;
    const e = aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true });
    run(late, EXTINGUISH_S + 0.2, e);
    expect(late.fire).toBeGreaterThan(0); // what put a fresh fire out is not enough now
    run(late, EXTINGUISH_S * (G.BIN_GROWTH - 1) + 0.2, e);
    expect(late.fire).toBe(0); // …but one extinguisher still does it
    expect(EXTINGUISH_S * G.BIN_GROWTH).toBeLessThan(CHARGE_S);
  });

  it("flares up again when the spray stops", () => {
    const d = armed();
    run(d, EXTINGUISH_S / 2, aimAt(small.at[0] + 2.5, small.at[2], small.at, { spraying: true }));
    const left = d.fire;
    expect(left).toBeLessThan(0.6);
    run(d, 3, env(small.at[0] + 2.5, small.at[2]));
    expect(d.fire).toBeGreaterThan(left);
    run(d, 60, env(small.at[0] + 2.5, small.at[2]));
    expect(d.fire).toBe(1); // back to full, never more
  });

  it("the smoke sinks, but crawling is always under it and standing never is", () => {
    const d = newDrill();
    for (const age of [0, 20, 60, 90, 600]) {
      d.smokeAge = age;
      expect(G.smokeFloorAt(d)).toBeGreaterThan(school.retry[1] + POSTURE_EYE.crawl + 0.05);
      expect(G.smokeFloorAt(d)).toBeLessThanOrEqual(school.retry[1] + POSTURE_EYE.stand);
    }
    d.smokeAge = 0; const high = G.smokeFloorAt(d);
    d.smokeAge = 90; expect(G.smokeFloorAt(d)).toBeLessThan(high - 0.25);
  });

  it("the thick smoke creeps east only while the corridor fills, and stops short of our classroom", () => {
    const d = newDrill();
    run(d, 30, env(CX, CZ));
    expect(d.smokeAge).toBe(0); // no smoke yet: nothing creeps
    expect(G.thickFrontAt(d)).toBe(school.thickWest);
    d.smokeAge = 45; const mid = G.thickFrontAt(d);
    expect(mid).toBeGreaterThan(school.thickWest + 1);
    d.smokeAge = 600;
    expect(G.thickFrontAt(d)).toBeGreaterThan(mid);
    expect(G.thickFrontAt(d)).toBeLessThan(school.classroom[0]);
    expect(G.thickFrontAt(d)).toBeLessThan(school.retry[0] - 5); // the retry point stays breathable
  });
});

describe("a fire stands on something", () => {
  it("a flame's foot is the top of what the school has there", () => {
    const floor = school.heat[1];
    const [x0, , z0, x1, , z1] = school.heat;
    for (let u = 0.1; u < 1; u += 0.2) for (let v = 0.1; v < 1; v += 0.2) {
      const x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * v, y = G.fireFoot(x, floor + 1, z);
      expect(y).toBeGreaterThanOrEqual(floor - 0.01); // never under the floor
      expect(y).toBeLessThanOrEqual(floor + 1.41); // on the floor, a bench or what stands on it — never a cabinet's top
      expect(G.fireFoot(x, y, z)).toBe(y); // already resting: asking again changes nothing
    }
    // the small fire burns in the bin: on its rim, not over it
    expect(Math.abs(G.fireFoot(...small.at) - small.at[1])).toBeLessThan(0.12);
  });
});

describe("fire follows what it reaches", () => {
  let seed = 7;
  const rand = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

  it("climbs upright faces of the burning room from their FOOT, as far as the face goes", () => {
    const spots = G.climbSpots(60, rand);
    expect(spots.length).toBeGreaterThan(25);
    const [x0, floor, z0, x1, , z1] = school.heat;
    for (const s of spots) {
      expect(s.at[0]).toBeGreaterThan(x0 - 0.25); expect(s.at[0]).toBeLessThan(x1 + 0.25);
      expect(s.at[2]).toBeGreaterThan(z0 - 0.25); expect(s.at[2]).toBeLessThan(z1 + 0.25);
      expect(Math.hypot(s.normal[0], s.normal[1])).toBeCloseTo(1);
      // the foot stands on something (the floor, a bench): never half-way up a wall
      expect(s.at[1]).toBe(G.fireFoot(s.at[0] + s.normal[0] * 0.12, s.at[1], s.at[2] + s.normal[1] * 0.12));
      expect(s.at[1]).toBeGreaterThanOrEqual(floor - 0.05);
      expect(s.rise).toBeGreaterThanOrEqual(0.5);
      expect(s.at[1] + s.rise).toBeLessThan(school.corridor[4]);
      expect(s.delay).toBe(G.CLIMB_DELAY_S);
    }
    expect(new Set(spots.map((s) => `${s.normal[0]},${s.normal[1]}`)).size).toBeGreaterThan(2); // more than one wall
    expect(spots.some((s) => s.rise > 2)).toBe(true); // a real wall, floor to ceiling
  });

  it("a flame is no wider than what carries it", () => {
    const floor = school.heat[1];
    const cx = (school.heat[0] + school.heat[3]) / 2, cz = (school.heat[2] + school.heat[5]) / 2;
    let open = 0, narrow = 0;
    for (let i = 0; i < 80; i++) {
      const x = cx + (rand() - 0.5) * 7, z = cz + (rand() - 0.5) * 12, y = G.fireFoot(x, floor + 1, z);
      const r = G.supportRadius(x, y, z, 2.2);
      expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThanOrEqual(2.2);
      // within that radius the surface really is there, all round
      if (r >= 0.3) for (let k = 0; k < 8; k++) expect(Math.abs(G.fireFoot(x + Math.cos(k * Math.PI / 4) * (r - 0.15), y, z + Math.sin(k * Math.PI / 4) * (r - 0.15)) - y)).toBeLessThanOrEqual(0.1);
      if (r >= 1) open++; else narrow++;
    }
    expect(open).toBeGreaterThan(0); // open floor carries a wide fire
    expect(narrow).toBeGreaterThan(0); // …and beside or on furniture it is cut to fit
    // the bin's rim carries only a narrow flame
    expect(G.supportRadius(small.at[0], G.fireFoot(...small.at), small.at[2], 2.2)).toBeLessThan(0.6);
  });
});

describe("smoke goes where the air lets it", () => {
  const f = G.smokeField();
  const cells = Array.from({ length: f.count }, (_, q) => ({ x: f.at[q * 3]!, y: f.at[q * 3 + 1]!, z: f.at[q * 3 + 2]!, t: f.arrive[q]!, room: f.room[q] === 1 }));
  const ceiling = school.corridor[4];

  it("fills the burning room and reaches the corridor — through the door, so later", () => {
    const room = cells.filter((c) => c.room), out = cells.filter((c) => !c.room);
    expect(room.length).toBeGreaterThan(200);
    expect(out.length).toBeGreaterThan(200);
    expect(Math.min(...out.map((c) => c.t))).toBeGreaterThan(Math.min(...room.map((c) => c.t)));
    for (const c of cells) { expect(Number.isFinite(c.t)).toBe(true); expect(c.y).toBeLessThan(ceiling); expect(c.y).toBeGreaterThan(school.heat[1]); }
  });

  it("leaves the fire and comes: when the drill begins the storey is NOT already full of it", () => {
    const origin = school.fires.find((x) => x.id === "corner") ?? school.fires.find((x) => !x.small)!;
    const reached = (t: number) => cells.filter((c) => c.t <= t);
    const start = reached(0);
    expect(start.length).toBeGreaterThan(0); // the fire has been burning: there is smoke over it
    expect(start.length / cells.length).toBeLessThan(0.06); // …but only there
    for (const c of start) { expect(c.room).toBe(true); expect(Math.hypot(c.x - origin.at[0], c.z - origin.at[2])).toBeLessThan(9); }
    // the corridor gets its first smoke well into the drill, and its far end much later still
    const corridor = cells.filter((c) => !c.room && c.z > school.corridor[2]);
    expect(Math.min(...corridor.map((c) => c.t))).toBeGreaterThan(8);
    expect(Math.max(...corridor.map((c) => c.t))).toBeGreaterThan(Math.min(...corridor.map((c) => c.t)) + 45);
    // and it grows without a jump: every 20 s more of the storey has it
    for (let t = 0, was = 0; t <= 200; t += 20) { const now = reached(t).length; expect(now).toBeGreaterThanOrEqual(was); was = now; }
    expect(reached(60).length).toBeGreaterThan(start.length * 3);
  });

  it("costs breath only where it has come", () => {
    const far = { x: school.retry[0], z: (school.corridor[2] + school.corridor[5]) / 2 };
    const comes = G.smokeOverhead(far.x, far.z);
    expect(comes).toBeGreaterThan(20); expect(Number.isFinite(comes)).toBe(true);
    const d = newDrill();
    d.step = "escape"; d.towel = false; d.fire = 0;
    d.time = d.smokeClock = comes - 30;
    expect(run(d, 1, env(far.x, far.z))).not.toContain("smoke"); // escaping already, but the smoke is not here yet
    expect(d.air).toBe(1);
    d.time = d.smokeClock = comes + 1;
    expect(run(d, 2, env(far.x, far.z))).toContain("smoke");
    expect(G.smokeOverhead(school.assembly.x, school.assembly.z)).toBe(Infinity); // never outside
  });

  it("is over the way out soon after the escape begins, however fast the child was", () => {
    const need = G.smokeOverRoute();
    expect(need).toBeGreaterThan(30); expect(need).toBeLessThan(300);
    // before the escape the smoke's clock is the drill's
    const slow = newDrill();
    run(slow, 20, env(CX, CZ));
    expect(slow.smokeClock).toBeCloseTo(slow.time, 1);
    // a child who dealt with the small fire in the first seconds: the smoke hurries, it does not jump
    const d = newDrill();
    d.step = "escape"; d.towel = true; d.fire = 0; d.time = 15; d.smokeClock = 15;
    run(d, 1, env(CX, CZ));
    expect(d.smokeClock).toBeGreaterThan(15 + G.SMOKE_HURRY * 0.9); expect(d.smokeClock).toBeLessThan(15 + G.SMOKE_HURRY * 1.2);
    run(d, (need - 15) / (G.SMOKE_HURRY - 1) + 2, env(CX, CZ));
    expect(d.smokeClock).toBeGreaterThanOrEqual(need);
    for (let x = school.classroom[0] + 1; x < school.retry[0]; x += 2) expect(G.smokeOverhead(x, CZ)).toBeLessThan(d.smokeClock);
    // …and from then on it keeps the drill's pace again
    const at = d.smokeClock;
    run(d, 10, env(CX, CZ));
    expect(d.smokeClock - at).toBeCloseTo(10, 0);
  });

  it("rises first: in every column of the room the smoke is under the ceiling before it is at the floor", () => {
    const columns = new Map<string, { y: number; t: number }[]>();
    for (const c of cells) if (c.room) (columns.get(`${c.x},${c.z}`) ?? columns.set(`${c.x},${c.z}`, []).get(`${c.x},${c.z}`)!).push(c);
    let judged = 0;
    for (const col of columns.values()) {
      if (col.length < 3) continue;
      col.sort((a, b) => a.y - b.y);
      const top = col[col.length - 1]!, low = col[0]!;
      // where the fire itself is under the column the smoke starts low; everywhere else it comes in along the ceiling
      if (top.t < low.t) judged++;
    }
    expect(judged).toBeGreaterThan(columns.size * 0.5);
  });

  it("runs along the corridor's ceiling: the further from the burning room, the later", () => {
    const top = cells.filter((c) => !c.room && c.y > ceiling - G.SMOKE_CELL && c.z > school.corridor[2] && c.z < school.corridor[5]);
    const near = top.filter((c) => c.x < school.heat[3]), far = top.filter((c) => c.x > school.retry[0]);
    expect(near.length).toBeGreaterThan(5); expect(far.length).toBeGreaterThan(5);
    expect(Math.max(...near.map((c) => c.t))).toBeLessThan(Math.min(...far.map((c) => c.t)) + 20);
    expect(Math.min(...far.map((c) => c.t))).toBeGreaterThan(Math.min(...near.map((c) => c.t)) + 3);
  });

  it("no cell of it is inside something solid", () => {
    // a cell's centre is free air: where a wall or a cabinet is, there is no smoke cell
    const keys = new Set(cells.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)}`));
    expect(keys.size).toBe(cells.length);
    const wall = cells.filter((c) => Math.abs(c.z - school.heat[5]) < 0.05 && c.x > school.heat[0] + 1 && c.x < school.heat[3] - 1);
    // the wall between the burning room and the corridor is not full of smoke cells (only its doorway may be)
    expect(wall.length).toBeLessThan(40);
  });
});
