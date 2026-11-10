import type { Blueprint } from "./blueprint.js";

/** The exact blocks affected by a customization, shared by the UI and editor. */
export function customizationScope(blueprint: Blueprint, index: number, mirror: boolean): {
  mode: "single" | "center" | "paired" | "missing";
  indices: number[];
} {
  const part = blueprint.parts[index];
  if (!part) return { mode: "single", indices: [] };
  if (!mirror) return { mode: "single", indices: [index] };
  if (part.cell[0] === 0) return { mode: "center", indices: [index] };
  const twin = blueprint.parts.findIndex(other => other.kind === part.kind &&
    other.cell[0] === -part.cell[0] && other.cell[1] === part.cell[1] && other.cell[2] === part.cell[2]);
  return twin < 0 ? { mode: "missing", indices: [index] } : { mode: "paired", indices: [index, twin] };
}
