import { describe, expect, it } from "vitest";
import { EXTRAPOLATE_MS, RENDER_DELAY_MS, RemoteTrack, SNAP_MS, SnapClock, type TrackPose } from "../src/craft/remoteTrack.js";

const pose = (): TrackPose => ({ x: 0, y: 0, z: 0, yaw: 0, speed: 0 });

/** A player walking +x at `speed` m/s, snapshot n at x = n * speed * 0.1. */
function walk(speed: number, n: number): [number, number, number, number] {
  return [n * speed * (SNAP_MS / 1000), 4, 0, 0];
}

/** Run a jittery link: snapshot n leaves at n*100 ms and arrives `delay(n)` later. Draw at 60 fps. */
function simulate(delay: (n: number) => number, speed = 4, snaps = 60, every = 1) {
  const clock = new SnapClock();
  const track = new RemoteTrack();
  const arrivals = Array.from({ length: snaps }, (_, n) => ({ n, at: n * SNAP_MS + delay(n) }))
    .filter(({ n }) => n % every === 0)
    .sort((a, b) => a.at - b.at);
  const drawn: number[] = [];
  const out = pose();
  let next = 0;
  for (let now = 0; now < snaps * SNAP_MS; now += 1000 / 60) {
    while (next < arrivals.length && arrivals[next]!.at <= now) {
      const { n } = arrivals[next++]!;
      const [x, y, z, yaw] = walk(speed, n);
      track.push(clock.observe(arrivals[next - 1]!.at, n * SNAP_MS), x, y, z, yaw);
    }
    if (track.draw(clock.renderTime(now), 1000 / 60, out)) drawn.push(out.x);
  }
  return drawn;
}

/** Largest per-frame step, and frames where the drawn player went backwards. */
function quality(drawn: number[]) {
  let maxStep = 0, backwards = 0;
  for (let i = 1; i < drawn.length; i++) {
    const d = drawn[i]! - drawn[i - 1]!;
    maxStep = Math.max(maxStep, Math.abs(d));
    if (d < -1e-6) backwards++;
  }
  return { maxStep, backwards };
}

describe("remote player interpolation", () => {
  it("is smooth on a clean link: every frame moves about speed/60", () => {
    const { maxStep, backwards } = quality(simulate(() => 30));
    expect(backwards).toBe(0);
    expect(maxStep).toBeLessThan(0.1); // 4 m/s → 0.067 m per frame
  });

  it("stays smooth under heavy jitter (0–120 ms) with bunched arrivals", () => {
    // pseudo-random but deterministic delays, two packets often arriving together
    const { maxStep, backwards } = quality(simulate((n) => 20 + ((n * 37) % 120)));
    expect(backwards).toBe(0);
    expect(maxStep).toBeLessThan(0.12);
  });

  it("keeps far players (one snapshot in five) gliding instead of stepping", () => {
    // after the first second (the track learns this player's pace from its first samples)
    const { maxStep, backwards } = quality(simulate(() => 30, 4, 80, 5).slice(60));
    expect(backwards).toBe(0);
    // 0.5 s between samples would be a 2 m jump with the old catch-up; interpolated it is per-frame
    expect(maxStep).toBeLessThan(0.15);
  });

  it("a stall extrapolates briefly, then holds still", () => {
    const clock = new SnapClock();
    const track = new RemoteTrack();
    for (let n = 0; n < 10; n++) track.push(clock.observe(n * SNAP_MS, n * SNAP_MS), ...walk(4, n));
    const out = pose();
    const lastServer = 9 * SNAP_MS;
    track.sample(lastServer + EXTRAPOLATE_MS / 2, out);
    expect(out.x).toBeCloseTo(walk(4, 9)[0] + 4 * (EXTRAPOLATE_MS / 2) / 1000, 5);
    track.sample(lastServer + 5000, out);
    expect(out.x).toBeCloseTo(walk(4, 9)[0] + 4 * EXTRAPOLATE_MS / 1000, 5);
    expect(out.speed).toBe(0);
  });

  it("a teleport snaps instead of sliding across the map", () => {
    const track = new RemoteTrack();
    track.push(0, 0, 4, 0, 0);
    track.push(100, 1, 4, 0, 0);
    track.push(200, 500, 4, 0, 0); // gathered by the teacher
    const out = pose();
    track.sample(150, out);
    expect(out.x).toBe(500);
  });

  it("draws RENDER_DELAY_MS behind the clean server clock", () => {
    const clock = new SnapClock();
    clock.observe(1000 + 25, 1000); // stamped 1000 ms, arrived after 25 ms
    expect(clock.renderTime(2000)).toBe(2000 - 25 - RENDER_DELAY_MS);
  });
});

describe("server pauses", () => {
  it("a 450 ms server stall ends in a glide, not a jump", () => {
    // snapshots 20–23 are held up and all leave at once when the server recovers
    const { maxStep, backwards } = quality(simulate((n) => (n >= 20 && n <= 23 ? (24 - n) * SNAP_MS + 30 : 30)).slice(30));
    expect(backwards).toBeLessThanOrEqual(3);
    expect(maxStep).toBeLessThan(0.3); // without correction: ~1.3 m in one frame
  });
});

describe("timestamps: when the server RECEIVED a move, not when it snapshotted it", () => {
  /**
   * The real pipeline: the player sends a move every ~100 ms with network jitter; the server
   * snapshots every 100 ms on its own phase and includes whatever move it last received.
   * Stamped with the snapshot time, the path stalls (no new move) then leaps (two moves) —
   * the stutter players saw. Stamped with the move's arrival time, it stays even.
   */
  function pipeline(stampWithArrival: boolean) {
    const clock = new SnapClock();
    const track = new RemoteTrack();
    const moves = Array.from({ length: 80 }, (_, i) => ({ x: i * 0.4, at: i * 100 + 7 + ((i * 53) % 45) })); // 4 m/s, 7–52 ms in
    const out = pose();
    const drawn: number[] = [];
    let snapAt = 50;
    for (let now = 0; now < 7800; now += 1000 / 60) {
      while (snapAt <= now) {
        const latest = [...moves].reverse().find((m) => m.at <= snapAt);
        if (latest) {
          const ts = clock.observe(snapAt + 20, snapAt);
          track.push(stampWithArrival ? latest.at : ts, latest.x, 4, 0, 0);
        }
        snapAt += 100;
      }
      if (track.draw(clock.renderTime(now), 1000 / 60, out)) drawn.push(out.x);
    }
    return drawn.slice(90);
  }

  it("with move-arrival stamps every frame advances about the same", () => {
    const steps = pipeline(true).map((x, i, a) => (i ? x - a[i - 1]! : 0)).slice(1);
    const avg = 4 / 60;
    expect(Math.max(...steps)).toBeLessThan(avg * 1.9);
    expect(steps.filter((s) => s < avg * 0.2).length).toBeLessThan(steps.length * 0.03); // almost never stalls
  });

  it("(the old snapshot stamps stall and leap — kept as the reason for the field)", () => {
    const steps = pipeline(false).map((x, i, a) => (i ? x - a[i - 1]! : 0)).slice(1);
    expect(steps.filter((s) => s < (4 / 60) * 0.2).length).toBeGreaterThan(steps.length * 0.03);
  });
});

describe("adaptive jitter buffer", () => {
  it("measured-time positions on a 0–200 ms link: no stalls, no leaps once the buffer has grown", () => {
    const clock = new SnapClock();
    const track = new RemoteTrack();
    const moves = Array.from({ length: 140 }, (_, i) => ({ x: i * 0.4, t: i * 100, arrive: i * 100 + ((i * 97) % 200) }));
    const out = pose();
    const drawn: number[] = [];
    let snapAt = 50;
    for (let now = 0; now < 13800; now += 1000 / 60) {
      while (snapAt <= now) {
        const latest = moves.filter((m) => m.arrive <= snapAt).sort((a, b) => b.t - a.t)[0];
        if (latest) { const ts = clock.observe(snapAt + 20, snapAt); track.push(latest.t, latest.x, 4, 0, 0, ts - latest.t); }
        snapAt += 100;
      }
      if (track.draw(clock.renderTime(now), 1000 / 60, out)) drawn.push(out.x);
    }
    const steps = drawn.slice(300).map((x, i, a) => (i ? x - a[i - 1]! : 4 / 60)).slice(1);
    const avg = 4 / 60;
    expect(steps.filter((s) => s < avg * 0.25).length).toBe(0);
    expect(steps.filter((s) => s > avg * 1.8).length).toBe(0);
  });
});
