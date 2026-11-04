/** Stable per-cell geometry codes; 0..17 retain every older save's meaning. */
export const CUBE = 0, ROUND = 1, SLOPE_BASE = 2, SLOPE_MAX = 17, KIT_CUBE = 18, KIT_SLOPE_BASE = 19, CORNER_BASE = 35;
/** Half block (the lower half of the cell) and stairs (that half plus the back half of the top),
 *  each in the same 16 yaw×tilt orientations as the ramps. Appended: 0..50 keep their meaning. */
export const SLAB_BASE = 51, STAIRS_BASE = 67, MAX_BLOCK_SHAPE = 82;
export type ShapePoint = [
    number,
    number,
    number
];
export type BlockShapeFamily = "cube" | "round" | "slope" | "corner" | "slab" | "stairs";
const wrap4 = (n: number): number => ((n % 4) + 4) % 4;
export const slopeShape = (yaw: number, tilt: number): number => SLOPE_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const kitSlopeShape = (yaw: number, tilt: number): number => KIT_SLOPE_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const cornerShape = (yaw: number, tilt: number): number => CORNER_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const slabShape = (yaw: number, tilt: number): number => SLAB_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const stairsShape = (yaw: number, tilt: number): number => STAIRS_BASE + wrap4(yaw) + 4 * wrap4(tilt);
export const isBlockShape = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_BLOCK_SHAPE;
export const isSlope = (n: number): boolean => n >= SLOPE_BASE && n <= SLOPE_MAX;
function rotationBase(n: number): number { return n >= STAIRS_BASE && n <= MAX_BLOCK_SHAPE ? STAIRS_BASE : n >= SLAB_BASE && n < STAIRS_BASE ? SLAB_BASE : n >= CORNER_BASE && n < SLAB_BASE ? CORNER_BASE : n >= KIT_SLOPE_BASE && n < CORNER_BASE ? KIT_SLOPE_BASE : isSlope(n) ? SLOPE_BASE : 0; }
export const isOrientedShape = (n: number): boolean => rotationBase(n) !== 0;
export const shapeYaw = (n: number): number => (n - rotationBase(n)) & 3;
export const shapeTilt = (n: number): number => ((n - rotationBase(n)) >> 2) & 3;
export const slopeYaw = shapeYaw, slopeTilt = shapeTilt;
export const isFullCubeShape = (n: number): boolean => n === CUBE || n === KIT_CUBE;
export function blockShapeFamily(n: number): BlockShapeFamily { return n === ROUND ? "round" : n >= STAIRS_BASE ? "stairs" : n >= SLAB_BASE ? "slab" : n >= CORNER_BASE ? "corner" : isOrientedShape(n) ? "slope" : "cube"; }
/** The cell-space box the shape occupies, after its turn (half blocks: their half; everything
 *  else: the whole cell). What the aim box frames. */
export function shapeBounds(shape: number): ShapeBox {
    const boxes = shapeBoxes(blockShapeFamily(shape));
    if (!boxes) return { min: [0, 0, 0], max: [1, 1, 1] };
    const min: ShapePoint = [Infinity, Infinity, Infinity], max: ShapePoint = [-Infinity, -Infinity, -Infinity];
    for (const b of boxes) for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
        const v = rotateShapeVector([x - .5, y - .5, z - .5], shape);
        for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i]!, v[i]! + .5); max[i] = Math.max(max[i]!, v[i]! + .5); }
    }
    const tidy = (n: number) => Math.round(n * 1e6) / 1e6;
    return { min: min.map(tidy) as ShapePoint, max: max.map(tidy) as ShapePoint };
}
/**
 * Can furniture stand on this cell's top? Half blocks and stairs only when turned so their top is
 * the whole cell (upside down); otherwise a chair "on" a half block floated half a metre over it.
 * Every older shape keeps the rule it had (any block holds furniture up).
 */
export function holdsFurniture(shape: number): boolean {
    const family = blockShapeFamily(shape);
    if (family !== "slab" && family !== "stairs") return true;
    return shapeTilt(shape) === 2;
}
/** Box families are unions of axis boxes in the unrotated cell (min, max). Stairs are NOT convex,
 *  so they are two boxes; every test below handles a union, not a plane set. */
export function shapeBoxes(family: BlockShapeFamily): readonly ShapeBox[] | null {
    if (family === "slab") return [{ min: [0, 0, 0], max: [1, 0.5, 1] }];
    if (family === "stairs") return [{ min: [0, 0, 0], max: [1, 0.5, 1] }, { min: [0, 0.5, 0], max: [1, 1, 0.5] }];
    return null;
}
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
    const family = blockShapeFamily(shape), boxes = shapeBoxes(family);
    if (boxes) return boxes.some((b) => [0, 1, 2].every((i) => min[i]! < b.max[i]! - EPS && max[i]! > b.min[i]! + EPS));
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
export function blockShapePlanes(family: Exclude<BlockShapeFamily, "round" | "stairs">): readonly ShapePlane[] {
    const planes: ShapePlane[] = [[-1, 0, 0, 0], [1, 0, 0, 1], [0, -1, 0, 0], [0, 1, 0, 1], [0, 0, -1, 0], [0, 0, 1, 1]];
    if (family === "slab")
        planes[3] = [0, 1, 0, 0.5];
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
    const family = blockShapeFamily(shape);
    if (family === "stairs") {
        // a union: the nearer of the two boxes' hits (each box is convex)
        const o = toShapeLocal(origin, shape), d = rotateShapeVector(direction, shape, true);
        let best: ShapeRayHit | null = null;
        for (const b of shapeBoxes("stairs")!) {
            const hit = rayBox(o, d, b, maxDistance);
            if (hit && (!best || hit.distance < best.distance)) best = hit;
        }
        if (!best) return null;
        const n = rotateShapeVector(best.normal, shape);
        return { distance: best.distance, normal: n };
    }
    const o = toShapeLocal(origin, shape), d = rotateShapeVector(direction, shape, true);
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
/** Slab-method ray vs an axis box in local space (entry distance and the entered face's normal). */
function rayBox(o: ShapePoint, d: ShapePoint, b: ShapeBox, maxDistance: number): ShapeRayHit | null {
    let enter = 0, exit = maxDistance, normal: ShapePoint = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]!) < 1e-12) { if (o[i]! < b.min[i]! || o[i]! > b.max[i]!) return null; continue; }
        let t0 = (b.min[i]! - o[i]!) / d[i]!, t1 = (b.max[i]! - o[i]!) / d[i]!, sign = -1;
        if (t0 > t1) { [t0, t1] = [t1, t0]; sign = 1; }
        if (t0 > enter) { enter = t0; normal = [0, 0, 0]; normal[i] = sign; }
        exit = Math.min(exit, t1);
        if (enter > exit + EPS) return null;
    }
    return enter < 0 || enter > maxDistance ? null : { distance: enter, normal };
}
/** Upright ramps have a usable floor; wall/ceiling orientations are not stairs. */
export function rampHeight(shape: number, x: number, z: number): number | null {
    // half blocks and stairs are steps, climbed by the body's step-up, not a ramp it slides along
    if (!isOrientedShape(shape) || shapeTilt(shape) !== 0 || shapeBoxes(blockShapeFamily(shape)))
        return null;
    const p = toShapeLocal([x, 0, z], shape);
    if (p[0] < -EPS || p[0] > 1 + EPS || p[2] < -EPS || p[2] > 1 + EPS)
        return null;
    return Math.max(0, Math.min(1, blockShapeFamily(shape) === "corner" ? Math.min(1 - p[0], 1 - p[2]) : 1 - p[2]));
}
