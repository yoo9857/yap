import { Vector3 } from "three";

/**
 * Aerodynamic surfaces for the single-rigid-body machine model.
 *
 * Wings use the flat-plate (Newtonian impact) normal-force model, NOT a
 * cambered-airfoil lift curve: a panel only reacts to the airflow that hits
 * its face, so an edge-on wing produces nothing and a wing at an angle of
 * attack produces a force along its own normal. That force is applied at the
 * mounting point, which is what makes a tail stabilise and a wing further out
 * roll the machine — the same rule as thrusters, no special-casing.
 *
 * What this is NOT: no camber, no stall break, no induced-drag polar, no
 * compressibility, no propeller/rotor model. Balloon buoyancy is a constant
 * upward force, not a gas-volume or altitude-density model.
 */
export const AIR = Object.freeze({
  density: 1.225, // kg/m^3, sea level
  wingArea: 1.8, // m^2 of panel per wing part
  wingNormalCoefficient: 2.6, // flat-plate normal force scale
  wingEdgeDrag: 0.09, // parasitic drag coefficient along the flow
  balloonLift: 230, // N of buoyancy per balloon part
  balloonArea: 1.25, // m^2 of frontal area per balloon part
  balloonDrag: 0.85, // bluff-body drag coefficient
  maxPanelForce: 9000, // N clamp, so a glitched velocity cannot explode the solver
});

/**
 * Velocity of a point rigidly attached to a body: v + ω × r.
 * `arm` is the point measured from the body's centre of mass, in world space.
 */
export function pointVelocity(
  linear: { x: number; y: number; z: number },
  angular: { x: number; y: number; z: number },
  arm: Vector3,
  out: Vector3,
): Vector3 {
  return out.set(
    linear.x + angular.y * arm.z - angular.z * arm.y,
    linear.y + angular.z * arm.x - angular.x * arm.z,
    linear.z + angular.x * arm.y - angular.y * arm.x,
  );
}

/**
 * Flat-plate normal force: F = -½·ρ·A·C·|v|·(v·n)·n.
 *
 * Quadratic in speed (the |v| and the v·n each carry one power), always
 * opposing the flow through the panel, and zero when the air slides along it.
 */
export function panelForce(
  flow: Vector3,
  normal: Vector3,
  area: number,
  coefficient: number,
  out: Vector3,
): Vector3 {
  const speed = flow.length();
  if (speed < 1e-4) return out.set(0, 0, 0);
  const through = flow.dot(normal);
  return out
    .copy(normal)
    .multiplyScalar(
      clampForce(-0.5 * AIR.density * area * coefficient * speed * through),
    );
}

/** Bluff-body drag: F = -½·ρ·A·C·|v|·v. Used by balloons and wing edges. */
export function dragForce(
  flow: Vector3,
  area: number,
  coefficient: number,
  out: Vector3,
): Vector3 {
  const speed = flow.length();
  if (speed < 1e-4) return out.set(0, 0, 0);
  const magnitude = clampForce(
    0.5 * AIR.density * area * coefficient * speed * speed,
  );
  return out.copy(flow).multiplyScalar(-magnitude / speed);
}

/** Angle between the flow and the panel's surface, in radians (0 = edge-on). */
export function angleOfAttack(flow: Vector3, normal: Vector3): number {
  const speed = flow.length();
  if (speed < 1e-4) return 0;
  return Math.asin(Math.max(-1, Math.min(1, -flow.dot(normal) / speed)));
}

function clampForce(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-AIR.maxPanelForce, Math.min(AIR.maxPanelForce, value));
}
