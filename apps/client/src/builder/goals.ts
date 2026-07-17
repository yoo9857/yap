import { LANDMARKS, landmarkAt } from "./landmarks.js";
import type { BuilderState } from "./state.js";

/**
 * The quest chain — the "give me a goal, watch it happen" heart of the game.
 * Landmark completions carry the story; crew/upgrade goals pace the economy
 * between them. After the scripted world tour, endless landmark goals repeat
 * with rising rewards.
 */
export interface Goal {
  title: string;
  kind: "blocks" | "workers" | "speedLevel" | "valueLevel" | "crane" | "landmark";
  target: number;
  reward: number;
}

function landmarkGoal(index: number, reward: number): Goal {
  const lm = landmarkAt(index);
  return {
    title: `Complete ${lm.emoji} ${lm.name} (${lm.country})`,
    kind: "landmark",
    target: index + 1,
    reward,
  };
}

export const GOALS: Goal[] = [
  { title: "Place your first 15 blocks", kind: "blocks", target: 15, reward: 15 },
  { title: "Hire 2 workers", kind: "workers", target: 2, reward: 25 },
  landmarkGoal(0, 150), // pyramid
  { title: "Raise block value to Lv 2", kind: "valueLevel", target: 2, reward: 80 },
  { title: "Grow the crew to 4 workers", kind: "workers", target: 4, reward: 120 },
  landmarkGoal(1, 300), // big ben
  { title: "🏗️ Install the crane", kind: "crane", target: 1, reward: 400 },
  { title: "Upgrade shoes to Lv 3", kind: "speedLevel", target: 3, reward: 250 },
  landmarkGoal(2, 600), // pisa
  { title: "Grow the crew to 7 workers", kind: "workers", target: 7, reward: 700 },
  landmarkGoal(3, 1000), // eiffel
  { title: "Block value Lv 5", kind: "valueLevel", target: 5, reward: 900 },
  landmarkGoal(4, 1500), // colosseum
  { title: "Complete a crew of 10", kind: "workers", target: 10, reward: 1500 },
  landmarkGoal(5, 2500), // namsan tower
  { title: "Upgrade shoes to Lv 6", kind: "speedLevel", target: 6, reward: 2000 },
  landmarkGoal(6, 5000), // statue of liberty — world tour complete!
];

export function goalAt(index: number): Goal {
  const scripted = GOALS[index];
  if (scripted) return scripted;
  // endless: keep completing the next landmark, rewards scale with the tour
  const n = index - GOALS.length;
  const landmarkIndex = LANDMARKS.length + n;
  const tour = Math.floor(landmarkIndex / LANDMARKS.length) + 1;
  return {
    ...landmarkGoal(landmarkIndex, Math.round(1000 * tour * 1.5)),
    title: `${landmarkAt(landmarkIndex).emoji} ${landmarkAt(landmarkIndex).name} — tour ${tour + 1}`,
  };
}

export function goalProgress(state: BuilderState, goal: Goal): number {
  switch (goal.kind) {
    case "blocks":
      return state.totalBlocks;
    case "workers":
      return state.workers;
    case "speedLevel":
      return state.speedLevel;
    case "valueLevel":
      return state.valueLevel;
    case "crane":
      return state.crane ? 1 : 0;
    case "landmark":
      return state.landmarkIndex;
  }
}

/** Check & advance; returns the completed goal (reward already paid) or null. */
export function tryCompleteGoal(state: BuilderState): Goal | null {
  const goal = goalAt(state.goalIndex);
  if (goalProgress(state, goal) < goal.target) return null;
  state.gold += goal.reward;
  state.goalIndex++;
  return goal;
}
