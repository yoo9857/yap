/**
 * Brick SHAPE ids stored per cell in `VoxelWorld.shapes`. Cube is the default
 * grid brick; round + slope give the world real LEGO silhouettes beyond stacked
 * cubes. A slope also carries its ORIENTATION (yaw 0–3 about Y, tilt 0–3 about
 * X → 16 facings incl. wall/ceiling ramps) packed into the id, so one Uint8
 * cell holds everything the renderer needs.
 */
export const CUBE = 0;
export const ROUND = 1;
/** Slope ids occupy 2..17 = SLOPE_BASE + yaw + tilt*4. */
export const SLOPE_BASE = 2;
export const SLOPE_MAX = SLOPE_BASE + 15;

const wrap4 = (n: number): number => ((n % 4) + 4) % 4;

export const slopeShape = (yaw: number, tilt: number): number =>
  SLOPE_BASE + wrap4(yaw) + wrap4(tilt) * 4;

export const isSlope = (shape: number): boolean => shape >= SLOPE_BASE && shape <= SLOPE_MAX;
export const slopeYaw = (shape: number): number => (shape - SLOPE_BASE) & 3;
export const slopeTilt = (shape: number): number => ((shape - SLOPE_BASE) >> 2) & 3;
