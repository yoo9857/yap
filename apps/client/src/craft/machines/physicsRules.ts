/** Machine simulation contract. SI units: metres, kilograms, seconds, newtons,
 * radians. Change the revision when tuning alters saved designs' behaviour. */
export const PHYSICS_RULES = Object.freeze({
  revision: 1,
  timestep: 1 / 60,
  gravity: 9.81,
  thrustPerEngine: 360,
  wheelForce: 130,
  poweredSpeedLimit: 22,
  suspensionLength: 0.65,
  wheelRadius: 0.58,
  suspensionStiffness: 32,
  suspensionCompression: 4.4,
  suspensionRelaxation: 5.2,
  maxSuspensionTravel: 0.4,
  maxSuspensionForce: 12000,
  tireFrictionSlip: 2.2,
  steeringAngle: 0.45,
  gyroPitchTorque: 100,
  gyroYawTorque: 75,
  gyroRollTorque: 100,
  gyroDamping: 35,
});

export type MachineFaultCode =
  | "INVALID_BLUEPRINT"
  | "INVALID_INPUT"
  | "NON_FINITE_STATE";
export class MachineFault extends Error {
  constructor(
    readonly code: MachineFaultCode,
    message: string,
  ) {
    super(message);
    this.name = "MachineFault";
  }
}

/** Reject NaN/Infinity before they reach WASM; clamp finite controller values. */
export function controlAxis(value: number, unsigned = false): number {
  if (!Number.isFinite(value))
    throw new MachineFault(
      "INVALID_INPUT",
      "조작 입력이 올바른 숫자가 아닙니다.",
    );
  return Math.max(unsigned ? 0 : -1, Math.min(1, value));
}
