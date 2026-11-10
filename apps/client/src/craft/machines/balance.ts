import { DIRECTIONS, machineStats, type Blueprint, type Cell, type MachinePart, type PartKind } from "./blueprint.js";
import { balloonLift, thrustForce } from "./customization.js";
import { t } from "../../ui/i18n.js";

/** Where the weight sits, in words a child can act on. */

export type BalanceSide = "center" | "left" | "right";
export type BalanceFore = "center" | "front" | "back";
export type BalanceHeight = "low" | "mid" | "high";
export type BalanceStance = "none" | "steady" | "edge" | "outside";
export type BalanceTone = "good" | "warn" | "bad";

export interface BalanceAdvice {
  side: BalanceSide;
  fore: BalanceFore;
  height: BalanceHeight;
  stance: BalanceStance;
  tone: BalanceTone;
  /** -1 left … 1 right, for the top-down plot. */
  plotX: number;
  /** -1 back … 1 front. */
  plotZ: number;
  /** 0 on the wheels (or the seat) … 1 two cells above them. */
  plotY: number;
  /** Signed cells from the wheel footprint (or seat). +x is right, +z is forward. */
  x: number;
  z: number;
  /** Cells above the wheels, or above the seat when there are no wheels. */
  rise: number;
}

export interface BalanceLines {
  summary: string;
  detail: string;
  hint: string;
}

const CENTERED = 0.35;
/** Top-down circle: 1 means this many cells from the centre. */
export const FACE_CELLS = 1.6;
const LOW = 0.55;
const HIGH = 1.05;
const PLOT_CELLS = 3;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The surface the weight is judged against: the wheels, else the seat. */
function supportCenter(blueprint: Blueprint): Cell {
  const wheels = blueprint.parts.filter((part) => part.kind === "wheel");
  if (wheels.length)
    return [
      (Math.min(...wheels.map(part => part.cell[0])) + Math.max(...wheels.map(part => part.cell[0]))) / 2,
      wheels.reduce((sum, part) => sum + part.cell[1], 0) / wheels.length,
      (Math.min(...wheels.map(part => part.cell[2])) + Math.max(...wheels.map(part => part.cell[2]))) / 2,
    ];
  const seat = blueprint.parts.find((part) => part.kind === "cockpit");
  if (seat) return seat.cell;
  return [
    (Math.min(...blueprint.parts.map(part => part.cell[0])) + Math.max(...blueprint.parts.map(part => part.cell[0]))) / 2,
    Math.min(...blueprint.parts.map(part => part.cell[1])),
    (Math.min(...blueprint.parts.map(part => part.cell[2])) + Math.max(...blueprint.parts.map(part => part.cell[2]))) / 2,
  ];
}

export function balanceAdvice(blueprint: Blueprint): BalanceAdvice {
  if (blueprint.parts.length === 0) {
    return {
      side: "center",
      fore: "center",
      height: "low",
      stance: "none",
      tone: "good",
      plotX: 0,
      plotZ: 0,
      plotY: 0,
      x: 0,
      z: 0,
      rise: 0,
    };
  }
  const stats = machineStats(blueprint);
  const support = supportCenter(blueprint);
  const x = stats.center[0] - support[0], z = stats.center[2] - support[2];
  const rise = stats.center[1] - support[1];
  const side: BalanceSide = x > CENTERED ? "right" : x < -CENTERED ? "left" : "center";
  const fore: BalanceFore = z > CENTERED ? "front" : z < -CENTERED ? "back" : "center";
  const height: BalanceHeight = rise > HIGH ? "high" : rise < LOW ? "low" : "mid";
  const stance: BalanceStance =
    stats.counts.wheel < 3
      ? "none"
      : stats.stanceMargin > 0.45
        ? "steady"
        : stats.stanceMargin > 0
          ? "edge"
          : "outside";
  const tone: BalanceTone =
    stance === "outside"
      ? "bad"
      : stance === "edge" || height === "high" || side !== "center" || fore !== "center"
        ? "warn"
        : "good";
  return {
    side,
    fore,
    height,
    stance,
    tone,
    plotX: clamp(x / PLOT_CELLS, -1, 1),
    plotZ: clamp(z / PLOT_CELLS, -1, 1),
    plotY: clamp(rise / 2, 0, 1),
    x,
    z,
    rise,
  };
}

function cells(value: number): string {
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function axisLine(
  value: number,
  negative: [string, string],
  positive: [string, string],
  middle: [string, string],
): string {
  if (value > CENTERED) return t(`${positive[0]} ${cells(value)}칸`, `${cells(value)} cells ${positive[1]}`);
  if (value < -CENTERED) return t(`${negative[0]} ${cells(value)}칸`, `${cells(value)} cells ${negative[1]}`);
  return t(middle[0], middle[1]);
}

/** The three lines on the workshop card. The first is the one to read. */
export function balanceLines(advice: BalanceAdvice): BalanceLines {
  const summary =
    advice.stance === "outside"
      ? t("무게가 바퀴 밖으로 나갔어요", "The weight sits outside the wheels")
      : advice.stance === "edge"
        ? t("무게가 바퀴 끝에 있어요", "The weight is on the edge of the wheels")
        : advice.height === "high"
          ? t("무게가 높아서 잘 뒤집혀요", "The weight is high, so it tips over")
          : advice.side === "left"
            ? t("무게가 왼쪽으로 기울었어요", "The weight leans left")
            : advice.side === "right"
              ? t("무게가 오른쪽으로 기울었어요", "The weight leans right")
              : advice.fore === "front"
                ? t("무게가 앞으로 쏠렸어요", "The weight sits toward the front")
                : advice.fore === "back"
                  ? t("무게가 뒤로 쏠렸어요", "The weight sits toward the back")
                  : t("무게가 가운데에 있어요", "The weight is in the middle");
  const hint =
    advice.stance === "outside"
      ? t("반대쪽에 무게추를 달아 바퀴 안으로 넣어요", "Add a weight on the other side, back over the wheels")
      : advice.stance === "edge"
        ? t("무게추를 가운데 쪽으로 옮겨 봐요", "Move a weight toward the middle")
        : advice.height === "high"
          ? t("무게추를 아래쪽에 달아 봐요", "Hang a weight underneath")
          : advice.side === "left"
            ? t("오른쪽에 무게추를 달아 봐요", "Add a weight on the right")
            : advice.side === "right"
              ? t("왼쪽에 무게추를 달아 봐요", "Add a weight on the left")
              : advice.fore === "front"
                ? t("뒤쪽에 무게추를 달아 봐요", "Add a weight at the back")
                : advice.fore === "back"
                  ? t("앞쪽에 무게추를 달아 봐요", "Add a weight at the front")
                  : t("노란 점이 세 선이 만나는 자리예요", "The yellow dot is where the three lines meet");
  const height =
    advice.height === "high" ? t("높음", "High") : advice.height === "low" ? t("낮음", "Low") : t("중간", "Middle");
  const detail = `${axisLine(advice.x, ["왼쪽", "left"], ["오른쪽", "right"], ["좌우 가운데", "Centred left–right"])} · ${axisLine(advice.z, ["뒤", "back"], ["앞", "front"], ["앞뒤 가운데", "Centred front–back"])} · ${height}`;
  return { summary, detail, hint };
}

/** Which way a push misses the centre of mass. */
export type ThrustAxisId = "vertical" | "side" | "fore";
export type ThrustLean = "none" | "left" | "right" | "front" | "back" | "up" | "down";
export type ThrustTone = "good" | "warn" | "bad" | "empty";

export interface ThrustGuide {
  id: ThrustAxisId;
  present: boolean;
  /** Net push is almost zero because opposite nozzles fire together. */
  cancel: boolean;
  /** They cancel and the pair still twists the machine. */
  spin: boolean;
  /** How far the push line misses the centre of mass, in cells. */
  miss: number;
  /** Where that line passes, in cells from the centre of mass. +x right, +y up, +z front. 0 when there is no single line. */
  armX: number;
  armY: number;
  armZ: number;
  /** +1 pushes toward up, right, or front. -1 the other way. 0 when the pushes cancel. */
  sign: number;
  /** Unit torque. Zero when this push will not turn the machine. Right-handed about the centre of mass. */
  turnX: number;
  turnY: number;
  turnZ: number;
  lean: ThrustLean;
  tone: ThrustTone;
  /** The row describes a Shift boost. Up nozzles and balloons are not boosts. */
  boost: boolean;
  status: string;
  hint: string;
}

export interface ThrustReport {
  vertical: ThrustGuide;
  side: ThrustGuide;
  fore: ThrustGuide;
  /** Sideways, fore-aft, and downward groups that Shift fires together. */
  boostGroups: number;
  liftRatio: number;
}

/**
 * A +Y cylinder (Three.js) turned onto a cell axis.
 * side: rotation.z = -π/2 sends +Y to +X (right).
 * fore: rotation.x = +π/2 sends +Y to +Z (front).
 */
export const SHAFT_TURN = {
  side: { x: 0, y: 0, z: -Math.PI / 2 },
  fore: { x: Math.PI / 2, y: 0, z: 0 },
} as const;

const MISS_BAD = 1;
const CANCEL_NET = 0.25;
const SPIN_ARM = 0.35;
const WEAK_LIFT = 0.85;
const GUIDE_MIN = 1.6;
const GUIDE_PAD = 1.35;

interface Push {
  /** Newtons along the axis. Positive is +X, +Y, or +Z. */
  f: number;
  r: Cell;
}

export function thrustAxisOf(part: MachinePart): ThrustAxisId | null {
  if (part.kind === "balloon") return "vertical";
  if (part.kind !== "thruster") return null;
  const vector = DIRECTIONS[part.direction]?.vector;
  if (!vector) return null;
  if (vector[1] !== 0) return "vertical";
  if (vector[0] !== 0) return "side";
  if (vector[2] !== 0) return "fore";
  return null;
}

/** The axis to draw brighter while that part is in hand. */
export function guideFocus(kind: PartKind, direction: number): ThrustAxisId | null {
  return thrustAxisOf({ kind, cell: [0, 0, 0], direction });
}

/** Which way the part in hand pushes. Balloons always push up. */
export function guideAim(kind: PartKind, direction: number): { id: ThrustAxisId | null; sign: number } {
  const id = guideFocus(kind, direction);
  if (!id) return { id: null, sign: 0 };
  if (kind === "balloon") return { id, sign: 1 };
  const vector = DIRECTIONS[direction]?.vector;
  const sign = !vector
    ? 1
    : id === "vertical"
      ? Math.sign(vector[1])
      : id === "side"
        ? Math.sign(vector[0])
        : Math.sign(vector[2]);
  return { id, sign: sign || 1 };
}

/** Half-length of each guide shaft, in cells, so it clears the outermost part. */
export function guideReach(blueprint: Blueprint): Record<ThrustAxisId, number> {
  const center = machineStats(blueprint).center;
  const reach = { vertical: GUIDE_MIN, side: GUIDE_MIN, fore: GUIDE_MIN };
  for (const part of blueprint.parts) {
    reach.side = Math.max(reach.side, Math.abs(part.cell[0] - center[0]) + GUIDE_PAD);
    reach.vertical = Math.max(reach.vertical, Math.abs(part.cell[1] - center[1]) + GUIDE_PAD);
    reach.fore = Math.max(reach.fore, Math.abs(part.cell[2] - center[2]) + GUIDE_PAD);
  }
  return reach;
}

export interface ThrustMiss {
  axis: ThrustAxisId;
  /** Cell offset from the centre of mass to the part. */
  from: Cell;
  /** Same offset, dropped onto that part's guide axis. */
  to: Cell;
}

/** Parts whose push does not run along the matching line through the centre of mass. */
export function thrustMisses(blueprint: Blueprint): ThrustMiss[] {
  const center = machineStats(blueprint).center;
  const misses: ThrustMiss[] = [];
  for (const part of blueprint.parts) {
    const axis = thrustAxisOf(part);
    if (!axis) continue;
    const from: Cell = [
      part.cell[0] - center[0],
      part.cell[1] - center[1],
      part.cell[2] - center[2],
    ];
    const to: Cell = [0, 0, 0];
    const along = axis === "side" ? 0 : axis === "vertical" ? 1 : 2;
    to[along] = from[along];
    const perp = Math.hypot(
      along === 0 ? 0 : from[0],
      along === 1 ? 0 : from[1],
      along === 2 ? 0 : from[2],
    );
    if (perp > CENTERED) misses.push({ axis, from, to });
  }
  return misses;
}

function judge(pushes: readonly Push[], along: 0 | 1 | 2): {
  present: boolean;
  cancel: boolean;
  spin: boolean;
  miss: number;
  lean: ThrustLean;
  armX: number;
  armY: number;
  armZ: number;
  sign: number;
  turnX: number;
  turnY: number;
  turnZ: number;
} {
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let gross = 0;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (const push of pushes) {
    const force: Cell = [0, 0, 0];
    force[along] = push.f;
    fx += force[0];
    fy += force[1];
    fz += force[2];
    gross += Math.abs(push.f);
    const [rx, ry, rz] = push.r;
    tx += ry * force[2] - rz * force[1];
    ty += rz * force[0] - rx * force[2];
    tz += rx * force[1] - ry * force[0];
  }
  const net = Math.hypot(fx, fy, fz);
  const torque = Math.hypot(tx, ty, tz);
  const present = gross > 1e-6;
  const cancel = present && net < CANCEL_NET * gross;
  const spin = cancel && torque > SPIN_ARM * gross;
  const miss = net > 1e-6 ? torque / net : 0;
  let lean: ThrustLean = "none";
  let armX = 0;
  let armY = 0;
  let armZ = 0;
  let sign = 0;
  let turnX = 0;
  let turnY = 0;
  let turnZ = 0;
  if (present && torque > 1e-6 && (miss > CENTERED || spin)) {
    turnX = tx / torque;
    turnY = ty / torque;
    turnZ = tz / torque;
  }
  if (present && !cancel && net > 1e-6) {
    const scale = net * net;
    const mx = (fy * tz - fz * ty) / scale;
    const my = (fz * tx - fx * tz) / scale;
    const mz = (fx * ty - fy * tx) / scale;
    armX = mx;
    armY = my;
    armZ = mz;
    const alongForce = along === 0 ? fx : along === 1 ? fy : fz;
    sign = Math.sign(alongForce);
    if (miss > CENTERED) {
      const ranked: [ThrustLean, number][] = [
        ["right", mx],
        ["left", -mx],
        ["up", my],
        ["down", -my],
        ["front", mz],
        ["back", -mz],
      ];
      ranked.sort((a, b) => b[1] - a[1]);
      lean = ranked[0]![0];
    }
  }
  return { present, cancel, spin, miss, lean, armX, armY, armZ, sign, turnX, turnY, turnZ };
}

/**
 * How far the round guide sweeps a turn, in radians.
 * A push inside the centre draws no arc. A couple that still twists draws a long one.
 */
export function turnSweep(miss: number, spin: boolean): number {
  if (spin) return 2.15;
  if (miss <= CENTERED) return 0;
  const t = clamp((miss - CENTERED) / 1.25, 0, 1);
  return 0.55 + t * 1.35;
}

/** Which axis the torque is most around. That axis's colour paints the arc. */
export function turnAxisId(x: number, y: number, z: number): ThrustAxisId {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  if (ay >= ax && ay >= az) return "vertical";
  if (ax >= az) return "side";
  return "fore";
}

/**
 * Right-handed frame for a turn arc.
 * z is the torque axis, x is where the arc starts, y is the positive curl (z × x).
 * The round guide and the 3D arc both use this, so they curl the same way.
 */
export function turnBasis(ax: number, ay: number, az: number): { x: Cell; y: Cell; z: Cell } | null {
  const len = Math.hypot(ax, ay, az);
  if (len < 1e-6) return null;
  const zx = ax / len;
  const zy = ay / len;
  const zz = az / len;
  const hx = Math.abs(zy) < 0.85 ? 0 : 1;
  const hy = Math.abs(zy) < 0.85 ? 1 : 0;
  let xx = hy * zz;
  let xy = -hx * zz;
  let xz = hx * zy - hy * zx;
  const xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-6) return null;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  return {
    x: [xx, xy, xz],
    y: [zy * xz - zz * xy, zz * xx - zx * xz, zx * xy - zy * xx],
    z: [zx, zy, zz],
  };
}

/** Isometric round guide. +y is up the picture, +x is down-right, +z (front) is down-left. */
const FACE_OX = 60;
const FACE_OY = 64;
const FACE_PX = 20;

export function facePoint(x: number, y: number, z: number): { x: number; y: number } {
  const c = Math.cos(Math.PI / 6);
  const s = Math.sin(Math.PI / 6);
  return {
    x: FACE_OX + (x - z) * c * FACE_PX,
    y: FACE_OY - y * FACE_PX + (x + z) * s * FACE_PX,
  };
}

/** Screen points of a turn arc around a cell. Empty when there is no axis or no sweep. */
export function faceArc(
  centerX: number,
  centerY: number,
  centerZ: number,
  axisX: number,
  axisY: number,
  axisZ: number,
  sweep: number,
  radius = 0.78,
  samples = 14,
): { x: number; y: number }[] {
  const basis = sweep > 0 ? turnBasis(axisX, axisY, axisZ) : null;
  if (!basis) return [];
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const angle = (i / samples) * sweep;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    points.push(
      facePoint(
        centerX + (basis.x[0] * cos + basis.y[0] * sin) * radius,
        centerY + (basis.x[1] * cos + basis.y[1] * sin) * radius,
        centerZ + (basis.x[2] * cos + basis.y[2] * sin) * radius,
      ),
    );
  }
  return points;
}

/** -1..1 across the round guide. +1 is FACE_CELLS to the right or the front. */
export function faceOffset(cells: number): number {
  return clamp(cells / FACE_CELLS, -1, 1);
}

export interface ScalePose {
  /** Degrees. Positive dips the right side of the dish. */
  roll: number;
  /** Degrees. Positive dips the front edge of the dish. */
  pitch: number;
  /** 0 sits on the dish. 1 is raised, so the weight looks top-heavy. */
  lift: number;
  /** -1..1. Positive puts the ball on the right of the dish. */
  slideX: number;
  /** -1..1. Positive puts the ball toward the front mark. */
  slideZ: number;
}

/** How far the dish tips. Flat while the weight is still in the middle. */
function dishTip(cells: number): number {
  const mag = Math.abs(cells);
  if (mag <= CENTERED) return 0;
  const t = Math.min(1, (mag - CENTERED) / 0.85);
  return Math.sign(cells) * (20 + t * 12);
}

/** Where the ball sits. It jumps toward the heavy side as soon as the dish tips. */
function dishSlide(cells: number): number {
  const mag = Math.abs(cells);
  if (mag <= CENTERED) return 0;
  const t = Math.min(1, (mag - CENTERED) / 0.85);
  return Math.sign(cells) * (0.55 + t * 0.45);
}

/** The right-hand dish: the ball sits on the heavy side, and the plate leans that way. */
export function scalePose(advice: BalanceAdvice): ScalePose {
  return {
    roll: dishTip(advice.x),
    pitch: dishTip(advice.z),
    lift: advice.height === "low" ? 0 : clamp((advice.rise - LOW) / 0.9, 0, 1),
    slideX: dishSlide(advice.x),
    slideZ: dishSlide(advice.z),
  };
}

function toneOf(present: boolean, cancel: boolean, miss: number, weak: boolean): ThrustTone {
  if (!present) return "empty";
  if (cancel || miss >= MISS_BAD) return "bad";
  if (miss > CENTERED || weak) return "warn";
  return "good";
}

function leanWord(lean: ThrustLean): string {
  switch (lean) {
    case "right":
      return t("오른쪽에서", "from the right");
    case "left":
      return t("왼쪽에서", "from the left");
    case "front":
      return t("앞에서", "from the front");
    case "back":
      return t("뒤에서", "from the back");
    case "up":
      return t("위에서", "from above");
    case "down":
      return t("아래에서", "from below");
    default:
      return "";
  }
}

function guideCopy(
  id: ThrustAxisId,
  firing: "up" | "down" | "flat",
  judged: ReturnType<typeof judge>,
  weak: boolean,
): Pick<ThrustGuide, "status" | "hint" | "tone" | "boost"> {
  const tone = toneOf(judged.present, judged.cancel, judged.miss, weak);
  if (!judged.present) {
    return {
      tone,
      boost: firing !== "up",
      status: t("없음", "None"),
      hint: t("이 선 위에 달면 곧게 나가요", "Put it on this line and it goes straight"),
    };
  }
  const line =
    id === "vertical"
      ? t("노란 세로선 위로 옮겨요", "Move it onto the yellow vertical line")
      : id === "side"
        ? t("빨간 가로선 위로 옮겨요", "Move it onto the red sideways line")
        : t("파란 가로선 위로 옮겨요", "Move it onto the blue front-back line");
  if (judged.cancel) {
    const status = judged.spin
      ? t("서로 밀면서 돌아요", "They push against each other and it spins")
      : id === "side"
        ? t("왼쪽과 오른쪽이 서로 밀어요", "Left and right push against each other")
        : id === "fore"
          ? t("앞과 뒤가 서로 밀어요", "Front and back push against each other")
          : t("서로 밀어요", "They push against each other");
    return {
      tone,
      boost: firing !== "up",
      status,
      hint: t("가고 싶은 쪽만 남겨요", "Keep only the way you want to go"),
    };
  }
  if (weak && judged.miss <= CENTERED) {
    return {
      tone,
      boost: false,
      status: t("곧게 뜨지만 힘이 약해요", "It goes straight up, but the push is weak"),
      hint: t("추진기를 더 달거나 힘을 키워요", "Add another thruster, or turn its power up"),
    };
  }
  const verb =
    firing === "up" ? t("떠요", "it lifts") : firing === "down" ? t("내려가요", "it sinks") : t("밀려요", "it pushes");
  const straight =
    firing === "up"
      ? t("곧게 떠요", "It lifts straight")
      : firing === "down"
        ? t("곧게 내려가요", "It sinks straight")
        : t("곧게 밀려요", "It pushes straight");
  return {
    tone,
    boost: firing !== "up",
    status: judged.lean === "none" ? straight : `${leanWord(judged.lean)} ${verb}`,
    hint: line,
  };
}

function relative(cell: Cell, center: Cell): Cell {
  return [cell[0] - center[0], cell[1] - center[1], cell[2] - center[2]];
}

/** How each push lines up with the centre of mass. Wings are left out: they only push once the machine is moving. */
export function thrustGuides(blueprint: Blueprint): ThrustReport {
  const stats = machineStats(blueprint);
  const up: Push[] = [];
  const down: Push[] = [];
  const side: Push[] = [];
  const fore: Push[] = [];
  for (const part of blueprint.parts) {
    const offset = relative(part.cell, stats.center);
    if (part.kind === "balloon") {
      up.push({ f: balloonLift(part), r: offset });
      continue;
    }
    if (part.kind !== "thruster") continue;
    const vector = DIRECTIONS[part.direction]?.vector;
    if (!vector) continue;
    const force = thrustForce(part);
    if (vector[1] > 0) up.push({ f: force, r: offset });
    else if (vector[1] < 0) down.push({ f: -force, r: offset });
    else if (vector[0] !== 0) side.push({ f: vector[0] * force, r: offset });
    else if (vector[2] !== 0) fore.push({ f: vector[2] * force, r: offset });
  }
  const upJudge = judge(up, 1);
  const downJudge = judge(down, 1);
  const sideJudge = judge(side, 0);
  const foreJudge = judge(fore, 2);
  const weak = upJudge.present && stats.liftRatio < WEAK_LIFT;
  const upTone = toneOf(upJudge.present, upJudge.cancel, upJudge.miss, weak && upJudge.miss <= CENTERED);
  const downTone = toneOf(downJudge.present, downJudge.cancel, downJudge.miss, false);
  const rank = (tone: ThrustTone) => (tone === "bad" ? 3 : tone === "warn" ? 2 : tone === "good" ? 1 : 0);
  const showDown =
    downJudge.present &&
    (!upJudge.present ||
      rank(downTone) > rank(upTone) ||
      (rank(downTone) === rank(upTone) && downJudge.miss > upJudge.miss + 1e-9));
  const verticalJudged = showDown ? downJudge : upJudge;
  const verticalCopy = guideCopy(
    "vertical",
    !upJudge.present && !downJudge.present ? "up" : showDown ? "down" : "up",
    verticalJudged,
    !showDown && weak,
  );
  const sideCopy = guideCopy("side", "flat", sideJudge, false);
  const foreCopy = guideCopy("fore", "flat", foreJudge, false);
  const pack = (
    id: ThrustAxisId,
    judged: ReturnType<typeof judge>,
    copy: ReturnType<typeof guideCopy>,
  ): ThrustGuide => ({
    id,
    present: judged.present,
    cancel: judged.cancel,
    spin: judged.spin,
    miss: judged.miss,
    armX: judged.armX,
    armY: judged.armY,
    armZ: judged.armZ,
    sign: judged.sign,
    turnX: judged.turnX,
    turnY: judged.turnY,
    turnZ: judged.turnZ,
    lean: judged.lean,
    ...copy,
  });
  return {
    vertical: pack("vertical", verticalJudged, verticalCopy),
    side: pack("side", sideJudge, sideCopy),
    fore: pack("fore", foreJudge, foreCopy),
    boostGroups: (sideJudge.present ? 1 : 0) + (foreJudge.present ? 1 : 0) + (downJudge.present ? 1 : 0),
    liftRatio: stats.liftRatio,
  };
}

const worseRank = (tone: ThrustTone) => (tone === "bad" ? 3 : tone === "warn" ? 2 : 0);

/**
 * One line under the three axis rows.
 * A machine that will tip keeps the weight hint. Otherwise the worst push wins.
 */
export function guideHint(advice: BalanceAdvice, report: ThrustReport, centerVisible = true): string {
  if (advice.stance === "outside" || advice.stance === "edge" || advice.height === "high")
    return balanceLines(advice).hint;
  let worst: ThrustGuide | null = null;
  for (const axis of [report.vertical, report.side, report.fore]) {
    if (worseRank(axis.tone) === 0) continue;
    if (
      !worst ||
      worseRank(axis.tone) > worseRank(worst.tone) ||
      (worseRank(axis.tone) === worseRank(worst.tone) && axis.miss > worst.miss)
    )
      worst = axis;
  }
  if (worst) {
    const shift =
      worst.boost && report.boostGroups > 1
        ? t("Shift는 위가 아닌 추진기를 같이 밀어요", "Shift pushes every thruster that is not pointing up")
        : "";
    return shift ? `${worst.hint} ${shift}` : worst.hint;
  }
  if (advice.side !== "center" || advice.fore !== "center") return balanceLines(advice).hint;
  if (!report.vertical.present && !report.side.present && !report.fore.present)
    return t(
      "같은 색 선 위에 추진기를 달면 곧게 나가요",
      "Put a thruster on the matching coloured line and it goes straight",
    );
  if (!centerVisible)
    return t("추가 도구에서 노란 안내선을 켤 수 있어요", "Turn the yellow guide on in More tools");
  return t("선 위에 있어서 곧게 나가요", "It sits on the line, so it goes straight");
}
