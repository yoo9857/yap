import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { kitCubeGeometry, kitRampGeometry, kitConnectorGeometry } from "../src/craft/kitGeometry.js";
import { blockShapePlanes, kitSlopeShape, cornerShape } from "@robo/shared";
import { VoxelWorld } from "../src/craft/voxelWorld.js";
import { stepBody, overlapsShapedVoxel, type Body } from "../src/craft/voxelBody.js";
import { PIECES, MAX_PIECE_CELLS, pieceShape } from "../src/craft/pieces.js";
import { planPiecePlacement } from "../src/craft/blockPlacement.js";
const body = (): Body => ({ x: 8.5, y: 1, z: 10, vx: 0, vy: 0, vz: 0, grounded: true, w: .2 });
function ground(): VoxelWorld { const w = new VoxelWorld(); for (let x = 6; x <= 12; x++)
    for (let z = 4; z <= 14; z++)
        w.set(x, 0, z, 3); return w; }
describe("custom block kit", () => {
    it("fits every softened body inside its collision hull with outward finite normals", () => {
        for (const corner of [false, true]) {
            const geometry = kitRampGeometry(corner), p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
            let volume = 0;
            for (let i = 0; i < p.count; i++) {
                expect([p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), uv.getX(i), uv.getY(i)].every(Number.isFinite)).toBe(true);
                for (const [x, y, z, d] of blockShapePlanes(corner ? "corner" : "slope"))
                    expect(x * (p.getX(i) + .5) + y * (p.getY(i) + .5) + z * (p.getZ(i) + .5)).toBeLessThanOrEqual(d + 1e-5);
            }
            for (let i = 0; i < p.count; i += 3) {
                const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
                volume += a.dot(b.cross(c)) / 6;
            }
            expect(volume).toBeGreaterThan(corner ? .25 : .40);
            expect(volume).toBeLessThanOrEqual(corner ? 1 / 3 : .5);
            geometry.dispose();
        }
        for (const g of [kitCubeGeometry(), kitConnectorGeometry()]) {
            g.computeBoundingBox();
            expect(g.boundingBox!.max.x).toBeLessThanOrEqual(.50001);
            g.dispose();
        }
    });
    it("plans eight-cell plates atomically, including inventory, furniture and player overlap", () => {
        const world = new VoxelWorld(), b = body(), piece = PIECES.find(p => p.key === "2x4")!;
        expect(MAX_PIECE_CELLS).toBe(8);
        expect(planPiecePlacement(world, b, piece, 0, 0, [20, 2, 20], 8, () => false)?.cost).toBe(8);
        expect(planPiecePlacement(world, b, piece, 0, 0, [20, 2, 20], 7, () => false)).toBeNull();
        expect(planPiecePlacement(world, b, piece, 0, 0, [20, 2, 20], 8, (x, _y, z) => x === 21 && z === 23)).toBeNull();
        world.set(21, 2, 23, 3);
        expect(planPiecePlacement(world, b, piece, 0, 0, [20, 2, 20], 8, () => false)).toBeNull();
        expect(overlapsShapedVoxel({ ...b, x: 8.9, y: 1.7, z: 8.9, h: .1 }, 8, 1, 8, cornerShape(0, 0))).toBe(false);
    });
    it("walks up and down a ramp smoothly while full cube ledges still require a jump", () => {
        const world = ground();
        world.setShaped(8, 1, 8, 3, kitSlopeShape(0, 0));
        world.set(8, 1, 7, 3);
        const b = body();
        for (let i = 0; i < 50; i++) {
            const y = b.y;
            stepBody(world, b, 1 / 60, 0, -.7, false);
            expect(Math.abs(b.y - y)).toBeLessThan(.14);
        }
        expect(b.y).toBeCloseTo(2, 2);
        expect(b.z).toBeLessThan(8);
        for (let i = 0; i < 50; i++) {
            const y = b.y;
            stepBody(world, b, 1 / 60, 0, .7, false);
            expect(Math.abs(b.y - y)).toBeLessThan(.14);
        }
        expect(b.y).toBeCloseTo(1, 2);
        const flat = ground();
        flat.set(8, 1, 8, 3);
        const stopped = body();
        for (let i = 0; i < 50; i++)
            stepBody(flat, stopped, 1 / 60, 0, -.7, false);
        expect(stopped.y).toBeCloseTo(1, 2);
        expect(stopped.z).toBeGreaterThan(9);
    });
    it("lets aiming rays pass through empty ramp volume and returns the visible sloped surface", () => {
        const w = new VoxelWorld();
        w.setShaped(8, 1, 8, 3, kitSlopeShape(0, 0));
        const hit = w.raycast(8.5, 4, 8.5, 0, -1, 0, 6)!;
        expect(hit.voxel).toEqual([8, 1, 8]);
        expect(hit.dist).toBeCloseTo(2.5);
        expect(hit.before).toEqual([8, 2, 8]);
        w.setShaped(8, 1, 8, 3, cornerShape(0, 0));
        expect(w.raycast(8.9, 1.8, 10, 0, 0, -1, 3)).toBeNull();
    });
    it("keeps a neighbouring face exposed beside an incomplete ramp cell", () => {
        const w = new VoxelWorld();
        for (const [x, y, z] of [[7, 8, 8], [9, 8, 8], [8, 7, 8], [8, 9, 8], [8, 8, 7], [8, 8, 9], [8, 8, 8]])
            w.set(x!, y!, z!, 3);
        expect(w.isExposed(8, 8, 8)).toBe(false);
        w.setShaped(9, 8, 8, 3, cornerShape(0, 0));
        expect(w.isExposed(8, 8, 8)).toBe(true);
    });
    it("keeps new codes in the world and preserves the older slope ids", () => {
        const w = new VoxelWorld();
        for (const p of PIECES) {
            const s = pieceShape(p, 3, 3);
            w.setShaped(4, 4, 4, 3, s);
            expect(w.getShape(4, 4, 4)).toBe(s);
        }
        w.setShaped(4, 4, 4, 3, 17);
        expect(w.getShape(4, 4, 4)).toBe(17);
    });
});
