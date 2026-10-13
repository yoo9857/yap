/**
 * Test-drive objectives. Pure accumulation over telemetry — no DOM, no
 * storage, no physics access — so the whole play loop is unit-testable and the
 * same tracker can later run on a server or in a replay.
 *
 * A mission is "what the machine did", never "which part you used": any design
 * that reaches the number clears it, which is the point of a build game.
 */

export interface MachineTelemetry {
  position: { x: number; y: number; z: number };
  speed: number;
  /** Metres above the terrain column underneath, not absolute Y. */
  altitude: number;
  contacts: number;
}

export interface Mission {
  id: string;
  name: string;
  hint: string;
  /** Headline target, formatted for the checklist. */
  target: string;
}

export const MISSIONS: readonly Mission[] = [
  {
    id: "first-roll",
    name: "첫 주행",
    hint: "출발점에서 40 m 떨어진 곳까지 가 보세요.",
    target: "40 m 이동",
  },
  {
    id: "speed-run",
    name: "속도 돌파",
    hint: "바퀴를 늘리거나 추진기를 뒤로 달아 가속해 보세요.",
    target: "55 km/h",
  },
  {
    id: "hill-climb",
    name: "언덕 등반",
    hint: "출발 지점보다 10 m 높은 땅에 바퀴를 디디세요.",
    target: "고도 +10 m 접지",
  },
  {
    id: "hover",
    name: "공중 정지",
    hint: "상승 추력과 중량의 비가 1을 넘으면 뜹니다.",
    target: "20 m에서 3초",
  },
  {
    id: "soft-landing",
    name: "안전 착륙",
    hint: "15 m 이상 올라갔다가 천천히 내려와 땅에 닿으세요.",
    target: "2.5 m/s 이하 접지",
  },
  {
    id: "long-haul",
    name: "장거리 원정",
    hint: "한 번의 시험 운전에서 누적 300 m를 달리거나 날아가세요.",
    target: "누적 300 m",
  },
];

export interface MissionProgress {
  /** 0‒1 per mission id, for the checklist meters. */
  ratio: Record<string, number>;
  completed: string[];
  distance: number;
  displacement: number;
  topSpeed: number;
  peakAltitude: number;
  climb: number;
  seconds: number;
}

const SPEED_GOAL = 55 / 3.6;
const HOVER_ALTITUDE = 20;
const HOVER_SECONDS = 3;
const CLIMB_GOAL = 10;
const LANDING_FROM = 15;
const LANDING_SPEED = 2.5;
const DISTANCE_GOAL = 300;
const DISPLACEMENT_GOAL = 40;

const ratio = (value: number, goal: number) =>
  Math.max(0, Math.min(1, value / goal));

/** Accumulates one test drive. Construct per run; `completed` is cumulative. */
export class MissionRun {
  private readonly done = new Set<string>();
  private distance = 0;
  private displacement = 0;
  private topSpeed = 0;
  private peakAltitude = 0;
  private climb = 0;
  private hoverSeconds = 0;
  private airPeak = 0;
  private seconds = 0;
  private last: { x: number; y: number; z: number };

  constructor(
    private readonly origin: { x: number; y: number; z: number },
    already: readonly string[] = [],
  ) {
    this.last = { ...origin };
    for (const id of already) this.done.add(id);
  }

  /** Feed one fixed step. Returns the ids completed by this very step. */
  update(t: MachineTelemetry, dt: number): string[] {
    if (!Number.isFinite(dt) || dt <= 0) return [];
    this.seconds += dt;
    const step = Math.hypot(
      t.position.x - this.last.x,
      t.position.y - this.last.y,
      t.position.z - this.last.z,
    );
    // Ignore teleport-sized jumps so a respawn cannot pay out a distance goal.
    if (step < 5) this.distance += step;
    this.last = { ...t.position };
    this.displacement = Math.hypot(
      t.position.x - this.origin.x,
      t.position.z - this.origin.z,
    );
    this.topSpeed = Math.max(this.topSpeed, t.speed);
    this.peakAltitude = Math.max(this.peakAltitude, t.altitude);
    this.climb = Math.max(this.climb, t.position.y - this.origin.y);

    const grounded = t.contacts > 0 || t.altitude <= 1.3;
    this.hoverSeconds =
      !grounded && t.altitude >= HOVER_ALTITUDE ? this.hoverSeconds + dt : 0;
    const fresh: string[] = [];
    const clear = (id: string) => {
      if (!this.done.has(id)) {
        this.done.add(id);
        fresh.push(id);
      }
    };
    if (this.displacement >= DISPLACEMENT_GOAL) clear("first-roll");
    if (this.topSpeed >= SPEED_GOAL) clear("speed-run");
    if (grounded && this.climb >= CLIMB_GOAL) clear("hill-climb");
    if (this.hoverSeconds >= HOVER_SECONDS) clear("hover");
    if (this.distance >= DISTANCE_GOAL) clear("long-haul");
    if (grounded) {
      if (this.airPeak >= LANDING_FROM && t.speed <= LANDING_SPEED)
        clear("soft-landing");
      this.airPeak = 0;
    } else this.airPeak = Math.max(this.airPeak, t.altitude);
    return fresh;
  }

  progress(): MissionProgress {
    return {
      ratio: {
        "first-roll": ratio(this.displacement, DISPLACEMENT_GOAL),
        "speed-run": ratio(this.topSpeed, SPEED_GOAL),
        "hill-climb": ratio(this.climb, CLIMB_GOAL),
        hover: ratio(this.hoverSeconds, HOVER_SECONDS),
        "soft-landing": ratio(this.airPeak || this.peakAltitude, LANDING_FROM),
        "long-haul": ratio(this.distance, DISTANCE_GOAL),
      },
      completed: [...this.done],
      distance: this.distance,
      displacement: this.displacement,
      topSpeed: this.topSpeed,
      peakAltitude: this.peakAltitude,
      climb: this.climb,
      seconds: this.seconds,
    };
  }

  /** Mission ids already cleared, for persisting between runs. */
  get cleared(): string[] {
    return [...this.done];
  }
}
