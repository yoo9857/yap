import { buildWaterGeometry } from "./waterGeometry.js";
import { WORLD_X, WORLD_Y, WORLD_Z } from "./voxelWorld.js";
import { SOLID_ID } from "./blocks.js";
import type { WaterWorkerRequest, WaterWorkerResponse, WaterWorkerResult } from "./waterWorkerTypes.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<WaterWorkerRequest>) => void) | null;
  postMessage(message: WaterWorkerResponse, transfer?: Transferable[]): void };
let latest = 0;
scope.onmessage = (event) => {
  const request = event.data;
  latest = request.id;
  if (request.t === "cancel") return;
  void (async () => {
    const start = performance.now(), results: WaterWorkerResult[] = [], transfers: Transferable[] = [];
    const world = { get: (x: number, y: number, z: number) =>
      x >= 0 && x < WORLD_X && z >= 0 && z < WORLD_Z && y >= 0 && y < WORLD_Y
        ? request.cells[(y * WORLD_Z + z) * WORLD_X + x]!
        : y >= 0 && y < WORLD_Y ? request.outside?.[y] ?? 0 : 0 };
    try {
      for (let j = 0; j < request.jobs.length; j++) {
        if (latest !== request.id) return;
        const job = request.jobs[j]!, cells: number[] = [];
        let minY = WORLD_Y, maxY = -1;
        for (let y = job.minY; y <= job.maxY; y++) for (let z = job.z; z < job.z + 16; z++)
          for (let x = job.x; x < job.x + 16; x++) {
            const block = world.get(x, y, z);
            if (block !== 0 && SOLID_ID[block] === 0) { cells.push(x, y, z); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
          }
        const geometry = cells.length ? buildWaterGeometry(world, cells) : null;
        const result: WaterWorkerResult = { id: job.id, minY, maxY, attributes: null, index: null, sphere: null };
        if (geometry) {
          result.attributes = {};
          for (const [name, attribute] of Object.entries(geometry.attributes)) {
            const array = attribute.array as Float32Array;
            result.attributes[name] = { array, itemSize: attribute.itemSize }; transfers.push(array.buffer);
          }
          result.index = geometry.index!.array as Uint16Array | Uint32Array;
          transfers.push(result.index.buffer);
          const s = geometry.boundingSphere!;
          result.sphere = [s.center.x, s.center.y, s.center.z, s.radius];
          geometry.dispose();
        }
        results.push(result);
        // Let cancellation/new snapshots pre-empt a long rebuild.
        if (j % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (latest === request.id) scope.postMessage({ t: "ready", id: request.id, results, ms: performance.now() - start }, transfers);
    } catch (error) {
      if (latest === request.id) scope.postMessage({ t: "failed", id: request.id, reason: error instanceof Error ? error.message : "water meshing failed" });
    }
  })();
};
