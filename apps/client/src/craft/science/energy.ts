/**
 * The numbers behind the status board: what a running plant makes, where the energy goes on the
 * way, and how much of the village it lights. Pure and unit-tested.
 *
 * Units are a kid-sized "⚡" (one lights one house), not watts. The losses are rounded teaching
 * values, labelled as approximate on screen: a wind rotor catches well under half of the wind
 * passing through it (the theoretical ceiling is 59 %), a generator loses about a tenth as heat,
 * and a cable a few percent more.
 */
import { BLUEPRINTS, type PlantKind } from "./plants.js";

/** One step of the energy chain: what reaches it, and what leaves it as useful energy. */
export interface FlowStage {
  name: string;
  nameEn: string;
  /** Share (0–1) of this stage's input passed on; 1 for the source. */
  keep: number;
  /** What is lost here, in words. */
  loss: string;
  lossEn: string;
}

export const FLOWS: Readonly<Record<PlantKind, readonly FlowStage[]>> = {
  wind: [
    { name: "바람", nameEn: "Wind", keep: 1, loss: "", lossEn: "" },
    { name: "날개", nameEn: "Blades", keep: 0.45, loss: "바람의 반 이상은 날개를 그냥 지나가요", lossEn: "Over half the wind passes the blades by" },
    { name: "발전기", nameEn: "Generator", keep: 0.9, loss: "열과 소리로 조금 새어 나가요", lossEn: "A little leaks away as heat and sound" },
    { name: "전선", nameEn: "Wire", keep: 0.95, loss: "전선이 따뜻해지며 조금 줄어요", lossEn: "The wire warms up and loses a bit" },
  ],
};

/** The energy entering each stage and leaving it, starting from `input` at the source. */
export function energyChain(kind: PlantKind, input = 100): Array<FlowStage & { in: number; out: number }> {
  let level = input;
  return FLOWS[kind].map((s) => {
    const enter = level;
    level = enter * s.keep;
    return { ...s, in: enter, out: level };
  });
}

/** Overall share of the source that arrives as electricity. */
export function efficiency(kind: PlantKind): number {
  return FLOWS[kind].reduce((k, s) => k * s.keep, 1);
}

/** ⚡ a running plant of this kind delivers (one lights one house). */
export const PLANT_OUTPUT: Readonly<Record<PlantKind, number>> = { wind: 3 };

/** The village on the board: how many houses want light. */
export const VILLAGE_HOUSES = 12;

export interface VillagePower {
  supply: number;
  demand: number;
  lit: number;
  running: number;
}

/** Supply from the plants that are RUNNING (a plant waiting for a part or a check gives nothing). */
export function villagePower(plants: ReadonlyArray<{ kind: PlantKind; running: boolean }>): VillagePower {
  const running = plants.filter((p) => p.running);
  const supply = running.reduce((n, p) => n + PLANT_OUTPUT[p.kind], 0);
  return { supply, demand: VILLAGE_HOUSES, lit: Math.min(VILLAGE_HOUSES, supply), running: running.length };
}

/** "날개 → 발전기 …" names for a kind's chain (board and toasts). */
export function chainNames(kind: PlantKind, en: boolean): string[] {
  return [...(en ? BLUEPRINTS[kind].chainEn : BLUEPRINTS[kind].chain)];
}
