import { AIR } from "./aero.js";
import { PHYSICS_RULES } from "./physicsRules.js";

export type PartKind =
  | "frame"
  | "cockpit"
  | "ballast"
  | "wheel"
  | "thruster"
  | "gyro"
  | "wing"
  | "balloon";
export type Cell = [number, number, number];
export interface MachinePart {
  kind: PartKind;
  cell: Cell;
  direction: number;
}
export interface Blueprint {
  version: 1;
  name: string;
  parts: MachinePart[];
}

export type PartGroup = "구조" | "구동" | "비행";
export interface PartInfo {
  name: string;
  mass: number;
  color: number;
  detail: string;
  /** Short line shown under the name in the palette tile. */
  blurb: string;
  group: PartGroup;
  /** Whether `direction` changes what the part does. */
  directional: boolean;
  /** Inline SVG body drawn in a 24×24 viewBox for the palette tile. */
  icon: string;
}

const svg = (body: string) => body;
export const PARTS: Record<PartKind, PartInfo> = {
  frame: {
    name: "프레임",
    mass: 8,
    color: 0xe6b450,
    group: "구조",
    directional: false,
    blurb: "8 kg · 구조",
    detail: "부품을 잇는 기본 차체입니다. 가볍고 어디에나 붙습니다.",
    icon: svg(
      "<rect x=\"4.5\" y=\"4.5\" width=\"15\" height=\"15\" rx=\"2.6\"/><path d=\"M4.5 12h15M12 4.5v15\"/>",
    ),
  },
  cockpit: {
    name: "조종석",
    mass: 12,
    color: 0x68ccea,
    group: "구조",
    directional: false,
    blurb: "12 kg · 1개 필수",
    detail: "기계마다 정확히 1개가 필요합니다. 1인칭 시점의 기준점입니다.",
    icon: svg(
      "<path d=\"M3.8 18.6a8.2 8.2 0 0 1 16.4 0z\"/><path d=\"M8 18.6a4 4 0 0 1 8 0\"/><path d=\"M12 6.2v4.2\"/>",
    ),
  },
  ballast: {
    name: "무게추",
    mass: 34,
    color: 0x8a7f73,
    group: "구조",
    directional: false,
    blurb: "34 kg · 무게중심",
    detail:
      "아주 무거운 쇳덩이입니다. 낮게 달면 무게중심이 내려가 잘 뒤집히지 않습니다.",
    icon: svg(
      "<path d=\"M6.4 8.6h11.2l1.9 10.6H4.5z\"/><path d=\"M9.4 8.6V7a2.6 2.6 0 0 1 5.2 0v1.6\"/>",
    ),
  },
  wheel: {
    name: "구동 바퀴",
    mass: 5,
    color: 0x303b46,
    group: "구동",
    directional: false,
    blurb: "5 kg · 서스펜션",
    detail:
      "모터와 서스펜션이 달린 바퀴입니다. 조종석보다 앞(+Z)쪽 바퀴가 조향합니다.",
    icon: svg(
      "<circle cx=\"12\" cy=\"12\" r=\"7.6\"/><circle cx=\"12\" cy=\"12\" r=\"2.7\"/><path d=\"M12 4.4v2.9M12 16.7v2.9M4.4 12h2.9M16.7 12h2.9\"/>",
    ),
  },
  thruster: {
    name: "추진기",
    mass: 6,
    color: 0xed754b,
    group: "비행",
    directional: true,
    blurb: `6 kg · ${PHYSICS_RULES.thrustPerEngine} N`,
    detail: `화살표 방향으로 ${PHYSICS_RULES.thrustPerEngine} N을 냅니다. 무게중심에서 벗어나면 기계가 돕니다.`,
    icon: svg(
      "<path d=\"M12 3.4c2.7 2.9 3.7 6.4 3.7 9.9H8.3c0-3.5 1-7 3.7-9.9z\"/><path d=\"M8.3 13.3 6.4 19.4l5.6-2.3 5.6 2.3-1.9-6.1\"/><circle cx=\"12\" cy=\"9.4\" r=\"1.5\"/>",
    ),
  },
  gyro: {
    name: "자이로",
    mass: 7,
    color: 0x90bda3,
    group: "비행",
    directional: false,
    blurb: "7 kg · 자세 제어",
    detail:
      "회전 입력과 흔들림 감쇠를 제공합니다. 자동 수평이나 고도 유지는 없습니다.",
    icon: svg(
      "<circle cx=\"12\" cy=\"12\" r=\"8\"/><ellipse cx=\"12\" cy=\"12\" rx=\"8\" ry=\"3.2\"/><ellipse cx=\"12\" cy=\"12\" rx=\"3.2\" ry=\"8\"/>",
    ),
  },
  wing: {
    name: "날개",
    mass: 4,
    color: 0xcfd8dc,
    group: "비행",
    directional: true,
    blurb: `4 kg · ${AIR.wingArea} m²`,
    detail:
      "속도가 붙으면 화살표 쪽으로 양력이 생깁니다. 바람이 면을 스치면 힘이 0이 됩니다.",
    icon: svg(
      "<path d=\"M2.6 15.6 11 6.4l10.4 3.9-6.6 3.9z\"/><path d=\"M11 6.4 13.1 14\"/>",
    ),
  },
  balloon: {
    name: "기구",
    mass: 3,
    color: 0xf2a0c0,
    group: "비행",
    directional: false,
    blurb: `3 kg · ${AIR.balloonLift} N`,
    detail: `항상 위로 ${AIR.balloonLift} N을 냅니다. 대신 공기 저항이 커서 느려집니다.`,
    icon: svg(
      "<path d=\"M12 3c3.6 0 6.1 3 6.1 6.5 0 3.7-3.3 6.2-6.1 7-2.8-.8-6.1-3.3-6.1-7C5.9 6 8.4 3 12 3z\"/><path d=\"M10.6 16.5h2.8l-.5 4.1h-1.8z\"/><path d=\"M9.2 5.6c-1 1-1.5 2.3-1.6 3.7\"/>",
    ),
  },
};
export const PART_ORDER = Object.keys(PARTS) as PartKind[];

export const DIRECTIONS: readonly { name: string; short: string; vector: Cell }[] =
  [
    { name: "위 ↑", short: "위", vector: [0, 1, 0] },
    { name: "전방 +Z", short: "앞", vector: [0, 0, 1] },
    { name: "뒤 -Z", short: "뒤", vector: [0, 0, -1] },
    { name: "오른쪽 +X", short: "오른쪽", vector: [1, 0, 0] },
    { name: "왼쪽 -X", short: "왼쪽", vector: [-1, 0, 0] },
    { name: "아래 ↓", short: "아래", vector: [0, -1, 0] },
  ];
/** Mirroring across X swaps the two sideways directions and leaves the rest. */
export function mirrorDirection(direction: number): number {
  return direction === 3 ? 4 : direction === 4 ? 3 : direction;
}
export const MAX_PARTS = 128;
const key = (cell: Cell) => cell.join(",");
export const cloneBlueprint = (b: Blueprint): Blueprint => structuredClone(b);

export function blueprintError(b: Blueprint): string | null {
  if (!validBlueprintShape(b))
    return "설계도에 잘못된 부품 또는 좌표가 있습니다.";
  if (b.parts.length === 0 || b.parts.length > MAX_PARTS)
    return `부품은 1~${MAX_PARTS}개까지 사용할 수 있습니다.`;
  if (b.parts.filter((p) => p.kind === "cockpit").length !== 1)
    return "조종석을 정확히 1개 설치해 주세요.";
  const cells = new Set(b.parts.map((p) => key(p.cell)));
  if (cells.size !== b.parts.length) return "부품이 겹쳐 있습니다.";
  const visited = new Set<string>();
  const queue: Cell[] = [b.parts[0]!.cell];
  while (queue.length) {
    const cell = queue.pop()!;
    if (visited.has(key(cell))) continue;
    visited.add(key(cell));
    for (const { vector } of DIRECTIONS) {
      const next: Cell = [
        cell[0] + vector[0],
        cell[1] + vector[1],
        cell[2] + vector[2],
      ];
      if (cells.has(key(next)) && !visited.has(key(next))) queue.push(next);
    }
  }
  return visited.size === cells.size
    ? null
    : "떨어진 부품이 있습니다. 면이 닿도록 프레임으로 연결해 주세요.";
}

export function addPart(b: Blueprint, part: MachinePart): boolean {
  if (
    b.parts.length >= MAX_PARTS ||
    part.cell.some((n) => !Number.isInteger(n) || Math.abs(n) > 12)
  )
    return false;
  if (b.parts.some((p) => key(p.cell) === key(part.cell))) return false;
  b.parts.push(structuredClone(part));
  return true;
}

export interface MachineStats {
  mass: number;
  center: Cell;
  liftRatio: number;
  counts: Record<PartKind, number>;
  wingArea: number;
  /** Horizontal distance from the centre of mass to the wheel footprint edge,
   * in cells. Negative means the centre of mass hangs outside the wheels. */
  stanceMargin: number;
}

export function machineStats(b: Blueprint): MachineStats {
  const mass = b.parts.reduce((sum, p) => sum + PARTS[p.kind].mass, 0);
  const center: Cell = [0, 0, 0];
  for (const p of b.parts)
    for (const i of [0, 1, 2] as const)
      center[i] += (p.cell[i] * PARTS[p.kind].mass) / (mass || 1);
  const counts = Object.fromEntries(
    PART_ORDER.map((kind) => [kind, 0]),
  ) as Record<PartKind, number>;
  for (const p of b.parts) counts[p.kind]++;
  const lift =
    b.parts.filter((p) => p.kind === "thruster" && p.direction === 0).length *
      PHYSICS_RULES.thrustPerEngine +
    counts.balloon * AIR.balloonLift;
  const wheels = b.parts.filter((p) => p.kind === "wheel");
  let stanceMargin = 0;
  if (wheels.length >= 3) {
    const xs = wheels.map((p) => p.cell[0]);
    const zs = wheels.map((p) => p.cell[2]);
    stanceMargin = Math.min(
      center[0] - Math.min(...xs),
      Math.max(...xs) - center[0],
      center[2] - Math.min(...zs),
      Math.max(...zs) - center[2],
    );
  }
  return {
    mass,
    center,
    liftRatio: mass ? lift / (mass * PHYSICS_RULES.gravity) : 0,
    counts,
    wingArea: counts.wing * AIR.wingArea,
    stanceMargin,
  };
}

export type PresetKind = "rover" | "ship" | "plane";
export const PRESETS: readonly { kind: PresetKind; label: string }[] = [
  { kind: "rover", label: "탐사차" },
  { kind: "ship", label: "비행체" },
  { kind: "plane", label: "활공기" },
];

export function preset(kind: PresetKind): Blueprint {
  const parts: MachinePart[] = [];
  const put = (
    kind: PartKind,
    x: number,
    y: number,
    z: number,
    direction = 0,
  ) => parts.push({ kind, cell: [x, y, z], direction });
  if (kind === "plane") {
    // Every mass and every nozzle is mirrored about both the x and z axes, so
    // the thrust line runs exactly through the centre of mass: the gyro only
    // damps rotation, it never levels anything, and any off-centre thrust
    // would spin the craft up to torque/damping and keep it there.
    // Thrusters sit a cell ABOVE the mass centre (the gyro hangs below it),
    // which is what makes it hang upright instead of balancing on its exhaust.
    // Fly it like a quadcopter: Space to climb, ↑/↓ to tip and translate, and
    // the wings turn that forward speed into a long flat glide.
    for (let z = -2; z <= 2; z++) put("frame", 0, 0, z);
    for (const x of [-1, 1]) {
      put("frame", x, 0, 0);
      put("wing", x * 2, 0, 0);
      put("wing", x * 3, 0, 0);
      put("thruster", x, 1, 0);
    }
    put("cockpit", 0, 1, 0);
    put("gyro", 0, -1, 0);
    put("thruster", 0, 1, -1);
    put("thruster", 0, 1, 1);
    return { version: 1, name: "날개 활공기", parts };
  }
  for (let z = -2; z <= 2; z++)
    for (let x = -1; x <= 1; x++) put("frame", x, 0, z);
  put("cockpit", 0, 1, 1);
  put("gyro", 0, 1, 0);
  if (kind === "rover") {
    for (const x of [-2, 2]) for (const z of [-2, 2]) put("wheel", x, 0, z);
  } else {
    for (const x of [-1, 1])
      for (const z of [-2, 0, 2]) put("thruster", x, -1, z);
    put("thruster", 0, 0, -3, 1);
  }
  return {
    version: 1,
    name: kind === "rover" ? "초원 탐사차" : "아일랜드 호퍼",
    parts,
  };
}

export const BLUEPRINT_KEY = "craftyap-machine-blueprint-v1";
function validBlueprintShape(value: unknown): value is Blueprint {
  if (!value || typeof value !== "object") return false;
  const b = value as Blueprint;
  if (
    b.version !== 1 ||
    typeof b.name !== "string" ||
    b.name.length > 48 ||
    !Array.isArray(b.parts) ||
    b.parts.length > MAX_PARTS
  )
    return false;
  return b.parts.every(
    (p) =>
      p &&
      Object.hasOwn(PARTS, p.kind) &&
      Array.isArray(p.cell) &&
      p.cell.length === 3 &&
      p.cell.every((n) => Number.isInteger(n) && Math.abs(n) <= 12) &&
      Number.isInteger(p.direction) &&
      p.direction >= 0 &&
      p.direction < DIRECTIONS.length,
  );
}
/** Validate local storage before any data reaches the physics engine. */
export function parseBlueprint(raw: string | null): Blueprint | null {
  if (!raw || raw.length > 100_000) return null;
  try {
    const b: unknown = JSON.parse(raw);
    return validateBlueprint(b);
  } catch {
    return null;
  }
}
/** Shape + duplicate-cell gate for any blueprint arriving from outside. */
export function validateBlueprint(value: unknown): Blueprint | null {
  if (!validBlueprintShape(value)) return null;
  if (new Set(value.parts.map((p) => key(p.cell))).size !== value.parts.length)
    return null;
  return value;
}
