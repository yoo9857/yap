import { describe, expect, it } from "vitest";
import {
  ALL_STATIONS,
  DWELL_S,
  VrDirector,
  radiusProfile,
  stationPose,
  type VrDirectorContext,
  type VrStationName,
} from "../src/builder/vrDirector.js";

const CTX: VrDirectorContext = { heightM: 330, radiusM: 62, frontierY: 120 };

/** Deterministic rng so station order and azimuths are reproducible. */
function seededRng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Run the director for `seconds` at 90 Hz (a typical PC-VR refresh rate). */
function run(
  d: VrDirector,
  seconds: number,
  ctx: VrDirectorContext = CTX,
): ReturnType<VrDirector["update"]>[] {
  const dt = 1 / 90;
  const frames: ReturnType<VrDirector["update"]>[] = [];
  for (let t = 0; t < seconds; t += dt) frames.push(d.update(dt, ctx));
  return frames;
}

describe("VR station poses", () => {
  it("always faces the monument: yaw turns camera-forward toward the origin", () => {
    for (const station of ALL_STATIONS) {
      for (const az of [0, 0.7, 2.2, 4.9, 6.0]) {
        const p = stationPose(station, CTX, az);
        // a Y-rotation of yaw maps local −Z to world (−sin yaw, 0, −cos yaw)
        const fx = -Math.sin(p.yaw);
        const fz = -Math.cos(p.yaw);
        const dist = Math.hypot(p.x, p.z);
        // that forward vector must point from the station back at (0, _, 0)
        expect(fx).toBeCloseTo(-p.x / dist, 5);
        expect(fz).toBeCloseTo(-p.z / dist, 5);
      }
    }
  });

  it("never puts the viewer below the floor", () => {
    for (const station of ALL_STATIONS) {
      expect(stationPose(station, CTX, 1).y).toBeGreaterThanOrEqual(0);
    }
  });

  it("gives every mid-air viewpoint a platform to stand on", () => {
    for (const station of ALL_STATIONS) {
      const p = stationPose(station, CTX, 1);
      if (p.y > 1) expect(p.platformR).toBeGreaterThan(0);
    }
  });

  it("stands clear of the structure at the height it stands at", () => {
    // a tapering tower: 91 m at the base narrowing to a 3 m spire, like the
    // Eiffel's real profile
    const taper = (y: number): number =>
      Math.max(3, CTX.radiusM * (1 - (y / CTX.heightM) * 0.97));
    const ctx: VrDirectorContext = { ...CTX, radiusAt: taper };
    for (const station of ALL_STATIONS) {
      const p = stationPose(station, ctx, 1);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(taper(p.y));
    }
  });

  it("ground-level stations clear the whole base footprint", () => {
    for (const station of ALL_STATIONS) {
      const p = stationPose(station, CTX, 1);
      if (p.y === 0) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(CTX.radiusM);
    }
  });

  it("keeps its distance when the structure is broad at that height", () => {
    // the Colosseum is a 96 m ring only 48 m tall — its top is still wide, so
    // the same station must back off rather than stand inside the masonry
    const ring: VrDirectorContext = {
      heightM: 48,
      radiusM: 96,
      frontierY: 46,
      radiusAt: () => 96,
    };
    const p = stationPose("frontier", ring, 1);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(96);
  });

  it("never lifts the frontier station above what has been built", () => {
    // the build runs bottom-up, so anything above the frontier is unbuilt ghost;
    // this station's whole job is to be level with real, placed blocks
    for (const frontierY of [0, 30, 150, 331]) {
      const p = stationPose("frontier", { ...CTX, frontierY }, 1);
      expect(p.y).toBeLessThanOrEqual(Math.max(6, frontierY));
    }
    // the overlook is exempt on purpose: it frames the whole SITE from a fixed
    // balcony, ghost blueprint included, so it does not track the frontier
    const early = stationPose("overlook", { ...CTX, frontierY: 0 }, 1);
    const late = stationPose("overlook", { ...CTX, frontierY: 331 }, 1);
    expect(early.y).toBe(late.y);
  });

  it("makes the monument loom from the overlook at every scale", () => {
    // the overlook's job is presence, not framing: from it the structure should
    // span ~85° vertically whether it is 12 m or 330 m tall
    const scales: VrDirectorContext[] = [
      { heightM: 330, radiusM: 62, frontierY: 120 }, // Eiffel
      { heightM: 139, radiusM: 115, frontierY: 60 }, // a squat, wide pyramid
      { heightM: 30, radiusM: 10, frontierY: 5 }, // a small landmark
      { heightM: 12, radiusM: 8, frontierY: 6 }, // the smallest
    ];
    for (const ctx of scales) {
      const p = stationPose("overlook", ctx, 0);
      const dist = Math.hypot(p.x, p.z);
      const eye = p.y + 1.6;
      const deg = (rad: number): number => (rad * 180) / Math.PI;
      const vertical = deg(Math.atan((ctx.heightM - eye) / dist) + Math.atan(eye / dist));
      const horizontal = deg(2 * Math.atan(ctx.radiusM / dist));
      // A tall tower fills the view vertically; a squat, wide monument cannot —
      // standing clear of a 115 m footprint puts you too far back for that, so it
      // fills the view HORIZONTALLY instead. Either way the thing dominates.
      expect(Math.max(vertical, horizontal)).toBeGreaterThan(60);
      // ...and it must always stand clear of the monument's own footprint
      expect(dist).toBeGreaterThan(ctx.radiusM);
    }
  });

  it("puts something at eye level at every station but the plaza", () => {
    // pitch is forbidden, so a forward gaze must land ON the monument rather
    // than on empty sky — the station's own height is the only lever for that
    for (const station of ALL_STATIONS) {
      if (station === "plaza") continue; // the deliberate look-up-in-awe shot
      const p = stationPose(station, CTX, 1);
      const eye = p.y + 1.6; // headset eye height above the station floor
      expect(eye).toBeLessThan(CTX.heightM + 4);
    }
  });

  it("puts the frontier deck at the TOP of a completed monument, not the ground", () => {
    // during the completion parade the sim has already reset placedBlocks for
    // the next landmark. Feeding that through would drop the deck to y=6 in
    // front of a finished 331 m tower; the caller must pass the VIEW landmark's
    // progress, and this is the pose that proves it matters.
    const finished = stationPose("frontier", { ...CTX, frontierY: CTX.heightM }, 1);
    const justStarted = stationPose("frontier", { ...CTX, frontierY: 0 }, 1);
    expect(finished.y).toBeGreaterThan(100);
    expect(justStarted.y).toBe(6);
  });

  it("climbs the frontier deck as the build rises", () => {
    const heights = [0, 60, 150, 331].map(
      (frontierY) => stationPose("frontier", { ...CTX, frontierY }, 1).y,
    );
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!).toBeGreaterThan(heights[i - 1]!);
    }
  });

  it("keeps the built mass out from under the deck at elevated stations", () => {
    // the deck occludes anything steeper than ~58° below the horizon, so an
    // elevated station must stand back far enough to see the base above that
    const taper = (y: number): number =>
      Math.max(1.1, CTX.radiusM * (1 - (y / CTX.heightM) * 0.99));
    for (const frontierY of [40, 150, 331]) {
      for (const station of ["frontier", "overlook"] as const) {
        const p = stationPose(station, { ...CTX, frontierY, radiusAt: taper }, 1);
        if (p.y <= 1) continue;
        const eye = p.y + 1.6;
        const depressionToBase = (Math.atan(eye / Math.hypot(p.x, p.z)) * 180) / Math.PI;
        expect(depressionToBase).toBeLessThan(55);
      }
    }
  });

  it("keeps the plaza — and only the plaza — on real ground", () => {
    const ground = ALL_STATIONS.filter((s) => stationPose(s, CTX, 1).y === 0);
    expect(ground).toContain("plaza");
    expect(ground).toContain("yard"); // the workers' yard is a ground view too
    expect(ground).not.toContain("overlook");
  });

  it("never places a station inside a short monument's own height", () => {
    // a 12 m landmark must not put the viewer at y = 10 on a balcony in its roof
    const tiny: VrDirectorContext = { heightM: 12, radiusM: 8, frontierY: 11 };
    for (const station of ALL_STATIONS) {
      const p = stationPose(station, tiny, 1);
      expect(Math.hypot(p.x, p.z)).toBeGreaterThan(tiny.radiusM);
    }
  });

  it("keeps the frontier viewpoint inside the built structure's height", () => {
    const low = stationPose("frontier", { ...CTX, frontierY: 0 }, 1);
    expect(low.y).toBeGreaterThanOrEqual(6); // never at ankle height
    const high = stationPose("frontier", { ...CTX, frontierY: 10_000 }, 1);
    expect(high.y).toBeLessThanOrEqual(CTX.heightM);
  });

  it("scales with the monument — a small landmark is viewed from closer in", () => {
    const small: VrDirectorContext = { heightM: 30, radiusM: 10, frontierY: 5 };
    expect(Math.hypot(...xz(stationPose("overlook", small, 0)))).toBeLessThan(
      Math.hypot(...xz(stationPose("overlook", CTX, 0))),
    );
  });
});

function xz(p: { x: number; z: number }): [number, number] {
  return [p.x, p.z];
}

describe("radiusProfile", () => {
  /** A 4-voxel-wide slab at the bottom, narrowing to a 1-voxel spire on top. */
  function taperBlocks(): { x: number; y: number; z: number }[] {
    const blocks: { x: number; y: number; z: number }[] = [];
    for (let y = 0; y < 20; y++) {
      const half = y < 10 ? 4 : 1;
      for (let x = -half; x <= half; x++) {
        for (let z = -half; z <= half; z++) blocks.push({ x, y, z });
      }
    }
    return blocks;
  }

  it("reports a wide base and a narrow tip", () => {
    const u = 2; // 2 m voxels → 40 m tall
    const at = radiusProfile(taperBlocks(), u, 40);
    expect(at(2)).toBeGreaterThan(at(38));
    // base: 4 voxels out (8 m) diagonally, plus one voxel of slop
    expect(at(2)).toBeGreaterThan(10);
    // tip: 1 voxel out (2 m) diagonally, plus slop — comfortably under 8 m
    expect(at(38)).toBeLessThan(8);
  });

  it("never returns zero, above the tip or below the base", () => {
    const at = radiusProfile(taperBlocks(), 2, 40);
    for (const y of [-50, 0, 20, 40, 5000]) expect(at(y)).toBeGreaterThan(0);
  });

  it("survives an empty blueprint without dividing by zero", () => {
    const at = radiusProfile([], 1, 0);
    expect(Number.isFinite(at(0))).toBe(true);
  });

  it("bridges a gap in the structure rather than reporting it as narrow", () => {
    // a tower with a hollow floor: a station level with the gap must still be
    // told the structure is wide there, or it would place itself inside
    const blocks: { x: number; y: number; z: number }[] = [];
    for (let y = 0; y < 30; y++) {
      if (y >= 14 && y <= 16) continue; // the empty floor
      for (let x = -5; x <= 5; x++) blocks.push({ x, y, z: 0 });
    }
    const at = radiusProfile(blocks, 1, 30);
    expect(at(15)).toBeGreaterThan(4);
  });
});

describe("VR director comfort contract", () => {
  it("holds the viewpoint perfectly still while it is visible", () => {
    const d = new VrDirector(seededRng());
    const frames = run(d, DWELL_S * 3);
    // group consecutive frames by station and assert the pose never varies
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!;
      const cur = frames[i]!;
      if (cur.cut) continue;
      expect(cur.pose.x).toBe(prev.pose.x);
      expect(cur.pose.y).toBe(prev.pose.y);
      expect(cur.pose.z).toBe(prev.pose.z);
      expect(cur.pose.yaw).toBe(prev.pose.yaw);
    }
  });

  it("does not drift the viewpoint as the build frontier climbs", () => {
    const d = new VrDirector(seededRng(7));
    const dt = 1 / 90;
    let frontierY = 0;
    let first: number | null = null;
    // hold well inside one dwell while the frontier rises 100 m
    for (let i = 0; i < 90 * 10; i++) {
      frontierY += 0.11;
      const f = d.update(dt, { ...CTX, frontierY });
      first ??= f.pose.y;
      if (!f.cut) expect(f.pose.y).toBe(first);
    }
  });

  it("hides every cut behind a fully black blinder", () => {
    const d = new VrDirector(seededRng(3));
    for (const f of run(d, DWELL_S * 4)) {
      if (f.cut) expect(f.blind).toBe(1);
    }
  });

  it("opens from black and settles to a clear view", () => {
    const d = new VrDirector(seededRng());
    const frames = run(d, DWELL_S * 0.9);
    expect(frames[0]!.blind).toBeGreaterThan(0.9);
    expect(frames[frames.length - 1]!.blind).toBe(0);
    // and it is monotonically clearing during the fade-in, never flickering
    const fadeIn = frames.slice(0, 60);
    for (let i = 1; i < fadeIn.length; i++) {
      expect(fadeIn[i]!.blind).toBeLessThanOrEqual(fadeIn[i - 1]!.blind);
    }
  });

  it("cuts on a steady cadence, once per dwell", () => {
    const d = new VrDirector(seededRng(11));
    const cycles = 5;
    const frames = run(d, DWELL_S * cycles);
    const cuts = frames.filter((f) => f.cut).length;
    // one opening cut plus one per completed cycle (±1 for the loop boundary)
    expect(cuts).toBeGreaterThanOrEqual(cycles - 1);
    expect(cuts).toBeLessThanOrEqual(cycles + 1);
  });

  it("never shows the same station twice in a row", () => {
    const d = new VrDirector(seededRng(5));
    const visited: VrStationName[] = [];
    for (const f of run(d, DWELL_S * 12)) {
      if (f.cut) visited.push(f.station);
    }
    expect(visited.length).toBeGreaterThan(6);
    for (let i = 1; i < visited.length; i++) {
      expect(visited[i]).not.toBe(visited[i - 1]);
    }
  });

  it("visits every station over a full deck", () => {
    const d = new VrDirector(seededRng(9));
    const seen = new Set<VrStationName>();
    for (const f of run(d, DWELL_S * (ALL_STATIONS.length + 2))) seen.add(f.station);
    expect(seen.size).toBe(ALL_STATIONS.length);
  });

  it("skip() cuts early, and still behind the fade", () => {
    const d = new VrDirector(seededRng(2));
    run(d, 2); // get past the fade-in, into the dwell
    const before = d.currentStation;
    d.skip();
    const frames = run(d, 1.5);
    const cut = frames.find((f) => f.cut);
    expect(cut).toBeDefined();
    expect(cut!.blind).toBe(1);
    expect(cut!.station).not.toBe(before);
  });

  it("ignores skip() mid-transition rather than double-cutting", () => {
    const d = new VrDirector(seededRng(4));
    d.update(1 / 90, CTX); // first frame: fading in
    d.skip();
    const frames = run(d, 1.0);
    expect(frames.filter((f) => f.cut).length).toBe(0);
  });
});
