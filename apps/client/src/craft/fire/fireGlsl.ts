import { BURN_FADE_S, BURN_GROW_S, BURN_HOLD_S, BURN_PEAK } from "./drillRules.js";

/**
 * GLSL that more than one of the fire's shaders needs, written ONCE. `burnPower` is the shader's
 * twin of drillRules.burnPower (how hard a spot burns, by how long ago it caught and its fuel):
 * the flames, the floor, the ceiling's light and the smoke volume must all agree with the rules
 * and with each other, and two copies kept by hand would not for long.
 */
export const BURN_POWER_GLSL = /* glsl */ `
  /** The rule (drillRules burnPower): up to its peak, then down to what the spot's fuel keeps burning. */
  float burnPower(float age, float fuel) {
    float settle = min(0.95, 0.38 + (fuel - 1.0) * 1.1);
    return smoothstep(0.0, ${BURN_GROW_S.toFixed(1)}, age) * (settle + (${BURN_PEAK.toFixed(2)} - settle) * (1.0 - smoothstep(${BURN_HOLD_S.toFixed(1)}, ${(BURN_HOLD_S + BURN_FADE_S).toFixed(1)}, age)));
  }
`;
