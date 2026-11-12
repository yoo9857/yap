/**
 * Snapshot interpolation for other players — how large online games keep a
 * crowd smooth on a jittery network.
 *
 * The server stamps every snapshot with its own clock (`ts`, ms). Each classmate keeps
 * a short history of (server time, position, yaw) and is DRAWN a little in the
 * past (RENDER_DELAY_MS), always between two received samples. A late or
 * bunched packet then changes nothing visible: the history still brackets the
 * drawn moment. When the history runs out (a long stall) the track extrapolates
 * along the last velocity for at most EXTRAPOLATE_MS, then holds.
 *
 * The clock: arrival time minus server time is the link's offset plus that
 * packet's delay. The smallest such value is the clean offset; it is tracked as
 * a running minimum that creeps up slowly, so a clock drift or a route change
 * is followed within seconds while one fast packet never drags the timeline.
 *
 * Pure (no three.js, no DOM): unit-tested with irregular arrival schedules.
 */

export const SNAP_MS = 100;
/** How far in the past remote players are drawn: one snapshot plus jitter headroom. */
export const RENDER_DELAY_MS = 130;
/** Past the newest sample, keep moving along the last velocity this long, then stop. */
export const EXTRAPOLATE_MS = 220;
/** Two consecutive samples farther apart than this are a teleport (gather, respawn): snap. */
export const TELEPORT_M = 8;
const HISTORY = 24; // ~2.4 s at full rate; far players (every 5th snapshot) keep ~12 s
const CLOCK_CREEP_MS = 0.4; // per snapshot: how fast the offset may rise after a delay spike
const RESYNC_MS = 5000;
/** A sample this far before the newest one starts a new timeline instead of being ignored. */
const CLOCK_RESET_MS = 2000;
/** The jitter buffer: a lateness peak decays by this fraction of elapsed time, and is
 *  covered with this margin; the buffer never grows past MAX_EXTRA_MS. */
const LATE_DECAY = 0.06;
const LATE_MARGIN_MS = 40;
const MAX_EXTRA_MS = 600;
/** Time constant (ms) over which a correction (path jump) is blended out instead of shown. */
const CORRECT_MS = 120; // a stamp this far off the timeline is a new clock, not a slow packet

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Arrival-time ↔ server-time offset, shared by every track of one connection. */
export class SnapClock {
  private offset = Number.POSITIVE_INFINITY;

  /** Feed one snapshot's arrival (local ms) and server stamp (ms). Returns the stamp. */
  observe(arrivalMs: number, serverMs: number): number {
    const sample = arrivalMs - serverMs;
    // first stamp, or the server's clock jumped (a restart behind the same link): resync
    if (!Number.isFinite(this.offset) || Math.abs(sample - this.offset) > RESYNC_MS) this.offset = sample;
    else this.offset = Math.min(this.offset + CLOCK_CREEP_MS, sample);
    return serverMs;
  }

  /** The server moment to draw at `nowMs` (local). NaN until the first snapshot. */
  renderTime(nowMs: number): number {
    return nowMs - this.offset - RENDER_DELAY_MS;
  }

  /** A reconnect: new server, new numbering. */
  reset(): void {
    this.offset = Number.POSITIVE_INFINITY;
  }
}

export interface TrackPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Horizontal speed (m/s) along the drawn path, for the walk/run animation. */
  speed: number;
}

/** One classmate's received path. */
export class RemoteTrack {
  private readonly samples: Sample[] = [];
  /** Typical gap between this player's samples (ms): 100 near, 500 for far players. */
  private interval = SNAP_MS;
  /** Extra delay on top of RENDER_DELAY_MS so a sparse track is still bracketed; eased, never jumped. */
  private extra = 0;
  private lastQuery = Number.NaN;
  /** Recent worst age of this player's positions when they reached the snapshot (ms):
   *  their own network's jitter. A peak that decays slowly (adaptive jitter buffer). */
  private latePeak = 0;

  /**
   * `age` (optional): how old this position already was when the snapshot carried it
   * (snapshot time − measured time). A player on a bad connection delivers old positions;
   * the track then draws them further back so they are still bracketed when drawn.
   */
  push(t: number, x: number, y: number, z: number, yaw: number, age = 0): void {
    const last = this.samples[this.samples.length - 1];
    // the clock went back (the server restarted, or the player came back on a new page):
    // a new timeline — keeping the old samples would refuse every new one until it caught up
    const clockReset = last !== undefined && t < last.t - CLOCK_RESET_MS;
    if (!clockReset && last && t <= last.t) {
      // a duplicate / reordered snapshot: keep the newest data for that moment only
      if (t === last.t) Object.assign(last, { x, y, z, yaw });
      return;
    }
    if (clockReset || (last && Math.hypot(x - last.x, z - last.z, y - last.y) > TELEPORT_M)) {
      this.samples.length = 0;
      this.interval = SNAP_MS;
      this.extra = this.latePeak = this.errX = this.errY = this.errZ = 0;
      this.lastQuery = this.drawnX = Number.NaN;
    } else if (last) {
      const gap = t - last.t;
      // The first gap sets the pace; an interruption longer than the normal
      // near or far cadence shouldn't be mistaken for a slower stream.
      if (gap <= 1000) {
        this.interval = this.samples.length === 1 ? gap : this.interval + (gap - this.interval) * 0.3;
      }
      this.latePeak -= Math.min(gap, 1000) * LATE_DECAY;
    }
    // Repeated positions from a stalled sender carry an ever-increasing age. Only new
    // positions describe transit jitter and should contribute to the interpolation delay.
    this.latePeak = Math.max(Math.min(age, MAX_EXTRA_MS + RENDER_DELAY_MS), this.latePeak, 0);
    this.samples.push({ t, x, y, z, yaw });
    if (this.samples.length > HISTORY) this.samples.shift();
  }

  get empty(): boolean {
    return this.samples.length === 0;
  }

  /** Newest received server time (ms), or -Infinity. */
  get newest(): number {
    return this.samples[this.samples.length - 1]?.t ?? Number.NEGATIVE_INFINITY;
  }

  /** The pose at server time `t` into `out`. False when there is nothing to draw yet. */
  sample(renderT: number, out: TrackPose): boolean {
    const s = this.samples;
    if (s.length === 0) return false;
    // a sparse track (far player) is drawn further back, eased at ±25% of real time so the
    // drawn path only slows or speeds a little while the delay changes, never steps back
    const target = Math.min(MAX_EXTRA_MS, Math.max(0, this.interval - SNAP_MS, this.latePeak + LATE_MARGIN_MS - RENDER_DELAY_MS));
    const step = Number.isFinite(this.lastQuery) ? Math.max(0, renderT - this.lastQuery) * 0.25 : Number.POSITIVE_INFINITY;
    this.extra += Math.max(-step, Math.min(step, target - this.extra));
    this.lastQuery = renderT;
    const t = renderT - this.extra;
    const first = s[0]!, last = s[s.length - 1]!;
    if (s.length === 1 || t <= first.t) return this.hold(t <= first.t ? first : last, out);
    if (t >= last.t) {
      // past the newest sample: carry on along the last leg briefly, then stop
      const prev = s[s.length - 2]!;
      const leg = last.t - prev.t;
      const ahead = Math.min(t - last.t, EXTRAPOLATE_MS);
      const vx = (last.x - prev.x) / leg, vy = (last.y - prev.y) / leg, vz = (last.z - prev.z) / leg;
      out.x = last.x + vx * ahead;
      out.y = last.y + vy * ahead;
      out.z = last.z + vz * ahead;
      out.yaw = last.yaw;
      out.speed = t - last.t < EXTRAPOLATE_MS ? Math.hypot(vx, vz) * 1000 : 0;
      return true;
    }
    // binary search the leg that brackets t
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.t <= t) lo = mid; else hi = mid;
    }
    const a = s[lo]!, b = s[hi]!;
    const k = (t - a.t) / (b.t - a.t);
    out.x = a.x + (b.x - a.x) * k;
    out.y = a.y + (b.y - a.y) * k;
    out.z = a.z + (b.z - a.z) * k;
    out.yaw = lerpAngle(a.yaw, b.yaw, k);
    out.speed = (Math.hypot(b.x - a.x, b.z - a.z) / (b.t - a.t)) * 1000;
    return true;
  }

  // ------------------------------------------------------------------ drawing
  /** Where this player was drawn last frame, and how far that sits off the true path. */
  private drawnX = Number.NaN;
  private drawnY = 0;
  private drawnZ = 0;
  private errX = 0;
  private errY = 0;
  private errZ = 0;

  /**
   * The pose to DRAW this frame: the interpolated pose plus a correction that
   * fades out. When the path itself jumps (a server pause ended, a burst after
   * a stall, a far player's pace changing), the drawn player does not jump with
   * it: the gap becomes an offset that decays over ~CORRECT_MS. Real teleports
   * (TELEPORT_M) still snap.
   */
  draw(renderT: number, frameMs: number, out: TrackPose): boolean {
    if (!this.sample(renderT, out)) return false;
    if (Number.isFinite(this.drawnX)) {
      const prevX = this.drawnX + 0, prevY = this.drawnY, prevZ = this.drawnZ;
      // what the path did this frame beyond walking speed is error to absorb
      const reach = (Math.max(out.speed, 1) * frameMs) / 1000 + 0.05;
      const dx = out.x + this.errX - prevX, dy = out.y + this.errY - prevY, dz = out.z + this.errZ - prevZ;
      const jump = Math.hypot(dx, dz);
      if (jump > TELEPORT_M) {
        this.errX = this.errY = this.errZ = 0;
      } else if (jump > reach) {
        const keep = (jump - reach) / jump;
        this.errX -= dx * keep;
        this.errY -= dy * keep;
        this.errZ -= dz * keep;
      }
      const fade = Math.exp(-frameMs / CORRECT_MS);
      this.errX *= fade;
      this.errY *= fade;
      this.errZ *= fade;
    }
    out.x += this.errX;
    out.y += this.errY;
    out.z += this.errZ;
    this.drawnX = out.x;
    this.drawnY = out.y;
    this.drawnZ = out.z;
    return true;
  }

  private hold(p: Sample, out: TrackPose): boolean {
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.yaw = p.yaw;
    out.speed = 0;
    return true;
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
