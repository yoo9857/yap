/** Stable per-cell geometry codes; 0..17 retain every older save's meaning. */
export const CUBE = 0, ROUND = 1, SLOPE_BASE = 2, SLOPE_MAX = 17, KIT_CUBE = 18, KIT_SLOPE_BASE = 19, CORNER_BASE = 35, MAX_BLOCK_SHAPE = 50;
export type ShapePoint = [
    number,
    number,
    number
];
export type BlockShapeFamily = "cube" | "round" | "slope" | "corner";
const wrap4 = (n: number): number => ((n % 4) + 4) % 4;
export const slopeShape = (yaw: number, tilt: number): number => SLOPE_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const kitSlopeShape = (yaw: number, tilt: number): number => KIT_SLOPE_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const cornerShape = (yaw: number, tilt: number): number => CORNER_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const isBlockShape = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_BLOCK_SHAPE;
export const isSlope = (n: number): boolean => n >= SLOPE_BASE && n <= SLOPE_MAX;
function rotationBase(n: number): number { return n >= CORNER_BASE && n <= MAX_BLOCK_SHAPE ? CORNER_BASE : n >= KIT_SLOPE_BASE && n < CORNER_BASE ? KIT_SLOPE_BASE : isSlope(n) ? SLOPE_BASE : 0; }
export const isOrientedShape = (n: number): boolean => rotationBase(n) !== 0;
export const shapeYaw = (n: number): number => (n - rotationBase(n)) & 3;
export const shapeTilt = (n: number): number => ((n - rotationBase(n)) >> 2) & 3;
export const slopeYaw = shapeYaw, slopeTilt = shapeTilt;
export const isFullCubeShape = (n: number): boolean => n === CUBE || n === KIT_CUBE;
export function blockShapeFamily(n: number): BlockShapeFamily { return n === ROUND ? "round" : n >= CORNER_BASE ? "corner" : isOrientedShape(n) ? "slope" : "cube"; }
/** Same yaw-then-tilt convention as the displayed block. */
export function rotateShapeVector(p: ShapePoint, shape: number, inverse = false): ShapePoint {
    let [x, y, z] = p;
    const yaw = isOrientedShape(shape) ? shapeYaw(shape) : 0, tilt = isOrientedShape(shape) ? shapeTilt(shape) : 0;
    if (inverse) {
        for (let i = 0; i < tilt; i++) {
            const t = y;
            y = z;
            z = -t;
        }
        for (let i = 0; i < yaw; i++) {
            const t = x;
            x = -z;
            z = t;
        }
    }
    else {
        for (let i = 0; i < yaw; i++) {
            const t = x;
            x = z;
            z = -t;
        }
        for (let i = 0; i < tilt; i++) {
            const t = y;
            y = -z;
            z = t;
        }
    }
    return [x, y, z];
}
export function toShapeLocal(p: ShapePoint, shape: number): ShapePoint { const v = rotateShapeVector([p[0] - .5, p[1] - .5, p[2] - .5], shape, true); return [v[0] + .5, v[1] + .5, v[2] + .5]; }
export interface ShapeBox {
    min: ShapePoint;
    max: ShapePoint;
}
const EPS = 1e-7;
/** Exact intersection for our convex, quarter-turn grid shapes. Touching is clear. */
export function shapeIntersectsBox(shape: number, box: ShapeBox): boolean {
    let min: ShapePoint = [Math.max(0, box.min[0]), Math.max(0, box.min[1]), Math.max(0, box.min[2])], max: ShapePoint = [Math.min(1, box.max[0]), Math.min(1, box.max[1]), Math.min(1, box.max[2])];
    if (min.some((n, i) => n >= max[i]! - EPS))
        return false;
    if (isFullCubeShape(shape))
        return true;
    if (isOrientedShape(shape)) {
        const corners: ShapePoint[] = [];
        for (const x of [min[0], max[0]])
            for (const y of [min[1], max[1]])
                for (const z of [min[2], max[2]])
                    corners.push(toShapeLocal([x, y, z], shape));
        min = [0, 1, 2].map(i => Math.min(...corners.map(p => p[i]!))) as ShapePoint;
        max = [0, 1, 2].map(i => Math.max(...corners.map(p => p[i]!))) as ShapePoint;
    }
    const family = blockShapeFamily(shape);
    if (family === "round") {
        const x = Math.max(min[0], Math.min(.5, max[0])) - .5, z = Math.max(min[2], Math.min(.5, max[2])) - .5;
        return x * x + z * z < .25 - EPS;
    }
    return min[1] + min[2] < 1 - EPS && (family !== "corner" || min[1] + min[0] < 1 - EPS);
}
/** Outward planes n·p <= d in the unrotated unit cell. Used by geometry and rays. */
export type ShapePlane = readonly [
    number,
    number,
    number,
    number
];
export function blockShapePlanes(family: Exclude<BlockShapeFamily, "round">): readonly ShapePlane[] {
    const planes: ShapePlane[] = [[-1, 0, 0, 0], [1, 0, 0, 1], [0, -1, 0, 0], [0, 1, 0, 1], [0, 0, -1, 0], [0, 0, 1, 1]];
    if (family === "slope" || family === "corner")
        planes.push([0, 1, 1, 1]);
    if (family === "corner")
        planes.push([1, 1, 0, 1]);
    return planes;
}
export interface ShapeRayHit {
    distance: number;
    normal: ShapePoint;
}
export function raycastBlockShape(shape: number, origin: ShapePoint, direction: ShapePoint, maxDistance: number): ShapeRayHit | null {
    const o = toShapeLocal(origin, shape), d = rotateShapeVector(direction, shape, true), family = blockShapeFamily(shape);
    let enter = 0, exit = maxDistance, normal: ShapePoint = [0, 0, 0];
    const clip = (n: ShapePoint, limit: number): boolean => { const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2], gap = limit - n[0] * o[0] - n[1] * o[1] - n[2] * o[2]; if (Math.abs(denom) < 1e-12)
        return gap >= 0; const t = gap / denom; if (denom < 0) {
        if (t > enter) {
            enter = t;
            normal = n;
        }
    }
    else
        exit = Math.min(exit, t); return enter <= exit + EPS; };
    if (family === "round") {
        if (!clip([0, -1, 0], 0) || !clip([0, 1, 0], 1))
            return null;
        const x = o[0] - .5, z = o[2] - .5, a = d[0] ** 2 + d[2] ** 2, b = 2 * (x * d[0] + z * d[2]), c = x * x + z * z - .25;
        if (a < 1e-12) {
            if (c > 0)
                return null;
        }
        else {
            const disc = b * b - 4 * a * c;
            if (disc < 0)
                return null;
            const lo = (-b - Math.sqrt(disc)) / (2 * a), hi = (-b + Math.sqrt(disc)) / (2 * a);
            if (lo > enter) {
                enter = lo;
                normal = [x + lo * d[0], 0, z + lo * d[2]];
            }
            exit = Math.min(exit, hi);
        }
    }
    else
        for (const [x, y, z, limit] of blockShapePlanes(family))
            if (!clip([x, y, z], limit))
                return null;
    if (enter < 0 || enter > maxDistance || enter > exit + EPS)
        return null;
    const n = rotateShapeVector(normal, shape), len = Math.hypot(...n) || 1;
    return { distance: enter, normal: [n[0] / len, n[1] / len, n[2] / len] };
}
/** Upright ramps have a usable floor; wall/ceiling orientations are not stairs. */
export function rampHeight(shape: number, x: number, z: number): number | null {
    if (!isOrientedShape(shape) || shapeTilt(shape) !== 0)
        return null;
    const p = toShapeLocal([x, 0, z], shape);
    if (p[0] < -EPS || p[0] > 1 + EPS || p[2] < -EPS || p[2] > 1 + EPS)
        return null;
    return Math.max(0, Math.min(1, blockShapeFamily(shape) === "corner" ? Math.min(1 - p[0], 1 - p[2]) : 1 - p[2]));
}
