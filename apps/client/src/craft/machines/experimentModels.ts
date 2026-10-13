/** Educational models intentionally separate from the free-driving rigid-body
 * simulation. Units and omissions are visible in the lab and exported reports. */
export interface InclineConditions {
  mass: number;
  radius: number;
  slopeDegrees: number;
  torque: number;
  resistance: number;
  seconds: number;
  grip: number;
}
export const REFERENCE_INCLINE: Readonly<InclineConditions> = Object.freeze({
  mass: 30,
  radius: 0.8,
  slopeDegrees: 12,
  torque: 22,
  resistance: 6.9,
  seconds: 5,
  grip: 0.9,
});
export const EXPERIMENT_REVISION = 1;
const finiteRange = (
  value: number,
  min: number,
  max: number,
  name: string,
): number => {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name}: ${min}~${max} 범위의 숫자가 필요합니다.`);
  return value;
};
export function validateIncline(c: InclineConditions): void {
  finiteRange(c.mass, 5, 500, "질량");
  finiteRange(c.radius, 0.1, 2, "반지름");
  finiteRange(c.slopeDegrees, 0, 35, "경사");
  finiteRange(c.torque, 0, 200, "토크");
  finiteRange(c.resistance, 0, 100, "저항");
  finiteRange(c.seconds, 1, 20, "시간");
  finiteRange(c.grip, 0, 2, "접지계수");
}
export function inclineSample(
  c: InclineConditions,
  ratio: number,
  time: number,
) {
  validateIncline(c);
  finiteRange(ratio, 0.5, 8, "기어비");
  finiteRange(time, 0, 100, "경과 시간");
  const t = Math.min(time, c.seconds),
    angle = (c.slopeDegrees * Math.PI) / 180;
  const wheelForce = (c.torque * ratio) / c.radius;
  const tractionLimit = c.grip * c.mass * 9.81 * Math.cos(angle);
  const appliedForce = Math.min(wheelForce, tractionLimit);
  const gravityForce = c.mass * 9.81 * Math.sin(angle);
  // A holding brake prevents rollback while the drive cannot overcome load.
  const acceleration = Math.max(
    0,
    (appliedForce - gravityForce - c.resistance) / c.mass,
  );
  const distance = 0.5 * acceleration * t * t,
    speed = acceleration * t;
  return {
    time: t,
    wheelForce,
    appliedForce,
    tractionLimit,
    gravityForce,
    resistance: c.resistance,
    acceleration,
    distance,
    speed,
    slipping: wheelForce > tractionLimit,
    kineticEnergy: 0.5 * c.mass * speed * speed,
    potentialEnergy: gravityForce * distance,
    lostEnergy: c.resistance * distance,
    driveWork: appliedForce * distance,
  };
}

export type DustStatus = "moving" | "captured" | "escaped" | "settled";
export interface DustParticle {
  x: number;
  y: number;
  z: number;
  vx: number;
  status: DustStatus;
  captureRoll: number;
}
export class DustExperiment {
  readonly particles: DustParticle[] = [];
  elapsed = 0;
  constructor(
    readonly strength: number,
    readonly filter: boolean,
    readonly seed = 42,
    readonly efficiency = 0.85,
  ) {
    finiteRange(strength, 0, 3, "팬 세기");
    finiteRange(efficiency, 0, 1, "필터 효율");
    let s = seed >>> 0;
    const random = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 240; i++)
      this.particles.push({
        x: -4 + random() * 1.8,
        y: -0.8 + random() * 1.6,
        z: -0.65 + random() * 1.3,
        vx: 0,
        status: "moving",
        captureRoll: random(),
      });
  }
  step(dt: number): void {
    finiteRange(dt, 0, 0.1, "시간 간격");
    this.elapsed += dt;
    for (const p of this.particles) {
      if (p.status !== "moving") continue;
      const previous = p.x;
      p.vx += (this.strength * 1.4 - p.vx) * (1 - Math.exp(-dt * 3));
      p.x += p.vx * dt;
      p.y -= 0.025 * dt;
      if (
        this.filter &&
        previous < 1.6 &&
        p.x >= 1.6 &&
        Math.abs(p.y) < 1.05 &&
        Math.abs(p.z) < 0.9 &&
        p.captureRoll < this.efficiency
      ) {
        p.x = 1.6;
        p.status = "captured";
      } else if (p.x > 4.5) p.status = "escaped";
      else if (p.y < -1.15) {
        p.y = -1.15;
        p.status = "settled";
      }
    }
  }
  counts() {
    const result = {
      moving: 0,
      captured: 0,
      escaped: 0,
      settled: 0,
      total: this.particles.length,
    };
    for (const p of this.particles) result[p.status]++;
    return result;
  }
}

export type EnergySource = "wind" | "battery" | "hydrogen" | "fuel";
export const ENERGY_PATHS: Record<
  EnergySource,
  {
    name: string;
    stages: string[];
    kinds: ("mechanical" | "electrical" | "gas" | "fuel")[];
    efficiencies: number[];
    note: string;
  }
> = {
  wind: {
    name: "풍력",
    stages: ["바람", "터빈", "발전기", "모터", "바퀴"],
    kinds: ["mechanical", "mechanical", "electrical", "mechanical"],
    efficiencies: [0.35, 0.9, 0.85, 1],
    note: "풍력은 전기를 거쳐 모터로 전달됩니다. 풍속 변화는 이 도식에서 계산하지 않습니다.",
  },
  battery: {
    name: "배터리",
    stages: ["배터리", "전력 조절기", "모터", "바퀴"],
    kinds: ["electrical", "electrical", "mechanical"],
    efficiencies: [0.95, 0.85, 1],
    note: "배터리는 에너지를 저장합니다. 생산 과정의 환경 영향은 별도 비교 대상입니다.",
  },
  hydrogen: {
    name: "수소",
    stages: ["수소 탱크", "연료전지", "모터", "바퀴"],
    kinds: ["gas", "electrical", "mechanical"],
    efficiencies: [0.55, 0.85, 1],
    note: "연료전지는 수소와 산소의 반응으로 전기를 만듭니다. 물과 열이 발생하며, 수소 생산 과정은 여기서 계산하지 않습니다.",
  },
  fuel: {
    name: "탄소기반 연료",
    stages: ["연료 탱크", "엔진", "구동축", "바퀴"],
    kinds: ["fuel", "mechanical", "mechanical"],
    efficiencies: [0.3, 0.9, 1],
    note: "연소 에너지가 회전으로 바뀝니다. 배기가스와 열이 발생합니다. 표시 효율은 설명용 가정입니다.",
  },
};
export function energyFlow(source: EnergySource, inputWatts: number) {
  finiteRange(inputWatts, 0, 10000, "입력 에너지율");
  const path = ENERGY_PATHS[source];
  if (!path) throw new Error("알 수 없는 에너지원입니다.");
  let output = inputWatts;
  const links = path.efficiencies.map((efficiency, i) => {
    const input = output;
    output *= efficiency;
    return {
      from: path.stages[i]!,
      to: path.stages[i + 1]!,
      kind: path.kinds[i]!,
      input,
      output,
      loss: input - output,
    };
  });
  return {
    inputWatts,
    outputWatts: output,
    lossWatts: inputWatts - output,
    links,
  };
}

/** Presentation sequence, not an orbital solver. Kept explicit in UI/reports. */
export function ascentSequence(time: number) {
  finiteRange(time, 0, 100, "경과 시간");
  const flightTime = Math.max(0, time - 2);
  const altitude = flightTime * flightTime * 2.5;
  return {
    phase: time < 2 ? ("boarding" as const) : ("ascent" as const),
    boarding: Math.min(1, time / 2),
    altitude,
    spaceBlend: Math.min(1, altitude / 150),
  };
}
