// Water meshing off the main thread, on the Rust engine (water_mesh.rs through WASM): one snapshot
// of the grid per generation, one `chunk` per job. If the engine cannot be loaded or traps, the
// answer is "failed" and the view meshes on its own thread instead (voxelView.ts).
import { loadRustEngine, type RustEngine } from "@robo/engine/browser";
import { resultFromRust } from "./waterMesher.js";
import type { WaterWorkerRequest, WaterWorkerResponse, WaterWorkerResult } from "./waterWorkerTypes.js";

const scope = self as unknown as { onmessage: ((event: MessageEvent<WaterWorkerRequest>) => void) | null;
  postMessage(message: WaterWorkerResponse, transfer?: Transferable[]): void };
let latest = 0;
let loading: Promise<RustEngine> | null = null;
scope.onmessage = (event) => {
  const request = event.data;
  latest = request.id;
  if (request.t === "cancel") return;
  void (async () => {
    const start = performance.now(), results: WaterWorkerResult[] = [], transfers: Transferable[] = [];
    let mesher: InstanceType<RustEngine["WaterMesher"]> | null = null;
    try {
      const rust = await (loading ??= loadRustEngine());
      if (latest !== request.id) return;
      rust.draw_water_by_amount(request.finite);
      mesher = new rust.WaterMesher(request.cells, request.outside ?? new Uint8Array(0));
      for (let j = 0; j < request.jobs.length; j++) {
        if (latest !== request.id) return;
        const job = request.jobs[j]!;
        results.push(resultFromRust(job.id, mesher.chunk(job.x, job.z, job.minY, job.maxY), transfers));
        // Let cancellation/new snapshots pre-empt a long rebuild.
        if (j % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (latest === request.id) scope.postMessage({ t: "ready", id: request.id, results, ms: performance.now() - start }, transfers);
    } catch (error) {
      if (latest === request.id) scope.postMessage({ t: "failed", id: request.id, reason: error instanceof Error ? error.message : "water meshing failed" });
    } finally {
      try { mesher?.free(); } catch { /* the module is gone */ }
    }
  })();
};
