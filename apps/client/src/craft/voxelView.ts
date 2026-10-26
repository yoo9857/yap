import * as THREE from "three";
import { castsInstancedShadow } from "../render/instancedDepth.js";
import { BLOCKS, SOLID_ID, blockById, textureUrl, type BlockDef } from "./blocks.js";
import { animateWater, buildWaterGeometry, makeWaterMaterial, prepareWaterTransition } from "./waterMesh.js";
import type { WaterWorkerRequest, WaterWorkerResponse } from "./waterWorkerTypes.js";
import { loadTexture } from "../render/textures.js";
import { WORLD_X, WORLD_Y, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";
import { ROUND, isSlope, slopeYaw, slopeTilt } from "./shapes.js";
import {
  brickOrientation,
  cubeBrickGeometry,
  roundBrickGeometry,
  slopeBrickGeometry,
  studGeometry,
} from "./brickGeometry.js";

/** 2×2 stud layout on a 1 m brick top (0.5 m sub-cells) — dense small studs to
 *  match the jump-map bricks instead of one oversized stud. */
const STUD_OFFSETS: readonly [number, number][] = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [-0.25, 0.25],
  [0.25, 0.25],
];

/** Columns per chunk. Chunks are the unit of culling, rebuilding and LOD. */
const CHUNK = 16;
/** Studs are 9 cm caps. Past this they are sub-pixel, but they were 41% of the
 *  island's triangles, so they are only emitted near the viewer. */
const STUD_RANGE = 32;
/** Chunks nearer than this (nearest point, metres, altitude included) draw
 *  real LEGO bricks: 108-triangle rounded cubes. Past it a chunk becomes ONE
 *  face-culled mesh, Minecraft style — 2 triangles per visible face — since
 *  a 7 cm bevel is under a pixel out there. */
const LOD_NEAR = 22;
/** Extra distance before a near chunk turns far again (no flicker on the line). */
const LOD_HYSTERESIS = 4;
/** How far the focus may move before studs and LOD are re-evaluated. */
const STUD_STEP = 8;
/** Per-frame chunk-build budget. Chunks build nearest-first, so the one you
 *  just edited lands this frame and far strips trickle in behind the fog. */
const BUILD_BUDGET_MS = 4;
const WATER_BUILD_BUDGET_MS = 2;

const CHUNKS_X = Math.ceil(WORLD_X / CHUNK);
const CHUNKS_Z = Math.ceil(WORLD_Z / CHUNK);
/** Packs a chunk coordinate (may be just outside the grid) into one number. */
const chunkId = (cx: number, cz: number) => (cx + 64) * 256 + (cz + 64);
const chunkX = (id: number) => Math.floor(id / 256) - 64;
const chunkZ = (id: number) => (id % 256) - 64;

interface ChunkState {
  /** Near representation: (id << 8 | shape) → instanced bricks. */
  meshes: Map<number, THREE.InstancedMesh>;
  /** Far representation: one merged, face-culled mesh. */
  far: THREE.Mesh | null;
  /** Which representation is (or is being made) current. */
  isFar: boolean;
  /** The world changed under this chunk since its meshes were built. */
  stale: boolean;
  /** Highest exposed cell's y — lets distance checks account for altitude. */
  top: number;
  /** Past the render distance: built, but neither drawn nor shadow-cast. */
  hidden: boolean;
  /** block id -> xyz... of cells whose top face carries studs. */
  studs: Map<number, number[]>;
  /** The chunk's water, one see-through mesh (any LOD). */
  water: THREE.Mesh | null;
  waterMinY: number;
  waterMaxY: number;
}

interface WaterBatch {
  id: number;
  waiting: boolean;
  world: Pick<VoxelWorld, "get">;
  jobs: [number, [number, number]][];
  cursor: number;
  results: { id: number; geometry: THREE.BufferGeometry | null; minY: number; maxY: number }[];
}

/** The six cube faces: normal n, and in-face axes u, v with u × v = n. Side
 *  faces keep v = up so block tiles stand upright, like the rounded bricks. */
const FACES = (
  [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ] as const
).map((n) => {
  const nv = new THREE.Vector3(...n);
  const v = n[1] === 1 ? new THREE.Vector3(0, 0, -1) : n[1] === -1 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(v, nv);
  // first corner = centre + n/2 - u/2 - v/2, relative to the cell's min corner
  const o = new THREE.Vector3(0.5, 0.5, 0.5).addScaledVector(nv, 0.5).addScaledVector(u, -0.5).addScaledVector(v, -0.5);
  return { n, u: u.toArray(), v: v.toArray(), o: o.toArray() };
});
const FACE_UV = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
const FACE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
];

/** Far meshes append raw triangles, so baked shapes must be non-indexed. */
function nonIndexed(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  return geometry.index ? geometry.toNonIndexed() : geometry;
}

/** Growable float buffer for the merged far meshes. */
class Floats {
  data = new Float32Array(1024);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  push2(a: number, b: number): void {
    if (this.length + 2 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
  }
}

interface FarBuffers {
  pos: Floats;
  nrm: Floats;
  uv: Floats;
}

/**
 * Renders a voxel world in CHUNK × CHUNK columns, EXPOSED cells only.
 *
 * Near chunks draw instanced LEGO bricks (rounded cube / cylinder / wedge,
 * capped with studs) — that's what reads as toy bricks, not a Minecraft tile.
 * Far chunks collapse into one face-culled mesh each, so the horizon costs a
 * few thousand triangles instead of millions. Edits rebuild only the chunk
 * they touch; rebuilds go through a nearest-first queue with a frame budget.
 */
export class VoxelView {
  private readonly cubeGeo = cubeBrickGeometry();
  private readonly roundGeo = roundBrickGeometry();
  private readonly slopeGeo = slopeBrickGeometry();
  /** Cheap non-indexed shapes baked into far meshes for round/slope bricks. */
  private readonly farRound = new THREE.CylinderGeometry(0.5, 0.5, 1, 8).toNonIndexed();
  private readonly farSlope = nonIndexed(slopeBrickGeometry());
  private readonly studGeometry = studGeometry();
  private readonly studMeshes = new Map<number, THREE.InstancedMesh>();
  private chunks = new Map<number, ChunkState>();
  private readonly queue = new Set<number>();
  private readonly materials = new Map<number, THREE.Material>();
  /** Material index for far-mesh groups (block ids are sparse-ish). */
  private readonly materialList: THREE.Material[] = [];
  private readonly materialIndex = new Map<number, number>();
  /** Blocks you can see through: they never hide a neighbour's face. */
  private readonly seeThrough = new Set<number>();
  private readonly highlight: THREE.LineSegments;
  private dirty = true;
  private primed = false;
  private readonly focus = new THREE.Vector3(Infinity, Infinity, Infinity);
  private hasFocus = false;
  private studsDirty = true;
  private renderDistance = Infinity;

  constructor(private readonly scene: THREE.Scene) {
    for (const def of BLOCKS) {
      if (def.fluid) continue; // drawn by the water mesh, never as a brick
      const [material, merged] = this.makeMaterials(def);
      this.materials.set(def.id, material);
      this.materialIndex.set(def.id, this.materialList.length);
      this.materialList.push(merged);
      if (def.key === "glass") this.seeThrough.add(def.id);
    }
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002));
    this.highlight = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x1f1f1f, linewidth: 2 }),
    );
    this.highlight.visible = false;
    this.highlight.frustumCulled = false; // one box: never worth culling, and the boot warm-up draws it far below the world
    scene.add(this.highlight);
  }

  private geometryFor(shape: number): THREE.BufferGeometry {
    return shape === ROUND ? this.roundGeo : isSlope(shape) ? this.slopeGeo : this.cubeGeo;
  }

  /**
   * Matched to the tower's `brickMaterial`: MeshStandard (same roughness/
   * metalness → same lighting) carrying the SAME crayon-doodle tile as the jump
   * map (grass-top, stone, …). The tile carries the hue; the solid crayon colour
   * is only the fallback until it loads / for a block with no tile.
   */
  /**
   * Two identical materials per block: one for the instanced near bricks and
   * studs, one for the merged far meshes. A single material shared by both
   * needs two shader programs, and three re-derives the program on every
   * switch between them — every object, every frame (see render/instancedDepth.ts).
   */
  private makeMaterials(def: BlockDef): [THREE.Material, THREE.Material] {
    const a = this.makeMaterial(def);
    const b = this.makeMaterial(def);
    return [a, b];
  }

  private makeMaterial(def: BlockDef): THREE.Material {
    const isGlass = def.key === "glass";
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      roughness: 0.75,
      metalness: 0.05,
      transparent: isGlass,
      opacity: isGlass ? 0.55 : 1,
    });
    if (def.emissive) {
      material.emissive = new THREE.Color(def.color);
      material.emissiveIntensity = 0.55;
    }
    void loadTexture(textureUrl(def)).then((tex) => {
      if (!tex) return; // keep the solid crayon colour
      material.map = tex;
      material.color.set(0xffffff); // the tile carries the hue, exactly like the tower
      if (def.emissive) material.emissiveMap = tex;
      material.needsUpdate = true;
    });
    return material;
  }

  // ------------------------------------------------------------ dirtiness

  /** Rebuild every chunk (initial load, wholesale world changes). */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Rebuild only the chunk holding this cell — plus the neighbouring chunk
   * when the cell sits on a chunk border, since its neighbours' exposure
   * changes too.
   */
  markCellDirty(x: number, _y: number, z: number): void {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    this.invalidate(chunkId(cx, cz));
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    if (lx === 0) this.invalidate(chunkId(cx - 1, cz));
    if (lx === CHUNK - 1) this.invalidate(chunkId(cx + 1, cz));
    if (lz === 0) this.invalidate(chunkId(cx, cz - 1));
    if (lz === CHUNK - 1) this.invalidate(chunkId(cx, cz + 1));
  }

  /**
   * Only WATER changed in this cell (a flow step: water ↔ air ↔ water).
   * Neither is solid, so no brick face can have appeared or vanished: just
   * the water meshes around it are redrawn — never the chunk's bricks, which
   * would make every running stream rebuild its chunks four times a second.
   * Corners are shared with all eight neighbours, so a cell on a chunk's
   * edge redraws the next chunk's water too.
   */
  markWaterDirty(x: number, y: number, z: number): void {
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    const lx = x - cx * CHUNK;
    const lz = z - cz * CHUNK;
    for (let dx = lx === 0 ? -1 : 0; dx <= (lx === CHUNK - 1 ? 1 : 0); dx++) {
      for (let dz = lz === 0 ? -1 : 0; dz <= (lz === CHUNK - 1 ? 1 : 0); dz++) {
        const ncx = cx + dx;
        const ncz = cz + dz;
        if (ncx < 0 || ncz < 0 || ncx >= CHUNKS_X || ncz >= CHUNKS_Z) continue;
        const id = chunkId(ncx, ncz), range = this.waterQueue.get(id);
        if (range) { range[0] = Math.min(range[0], y); range[1] = Math.max(range[1], y); }
        else this.waterQueue.set(id, [y, y]);
      }
    }
  }

  private readonly waterQueue = new Map<number, [number, number]>();
  private waterBatch: WaterBatch | null = null;
  private waterSnapshot: Uint8Array | null = null;
  private waterBuildPeak = 0;
  private waterCommits = 0;
  private waterSerial = 0;
  private waterWorker: Worker | null = null;
  private waterWorkerFailed = false;
  private workerMeshMs = 0;

  private ensureWaterWorker(): Worker | null {
    if (this.waterWorkerFailed || typeof Worker === "undefined") return null;
    if (this.waterWorker) return this.waterWorker;
    try {
      const worker = new Worker(new URL("./waterWorker.ts", import.meta.url), { type: "module" });
      const fallback = () => {
        this.waterWorkerFailed = true; worker.terminate(); this.waterWorker = null;
        if (this.waterBatch) this.waterBatch.waiting = false;
      };
      worker.onerror = fallback;
      worker.onmessage = (event: MessageEvent<WaterWorkerResponse>) => {
        const data = event.data, batch = this.waterBatch;
        if (!batch || data.id !== batch.id) return;
        if (data.t === "failed") { fallback(); return; }
        this.workerMeshMs = data.ms;
        for (const result of data.results) {
          let geometry: THREE.BufferGeometry | null = null;
          if (result.attributes && result.index && result.sphere) {
            geometry = new THREE.BufferGeometry();
            for (const [name, a] of Object.entries(result.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(a.array, a.itemSize));
            geometry.setIndex(new THREE.BufferAttribute(result.index, 1));
            const [x, y, z, r] = result.sphere;
            geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), r);
          }
          batch.results.push({ id: result.id, geometry, minY: result.minY, maxY: result.maxY });
        }
        batch.cursor = batch.jobs.length; batch.waiting = false;
      };
      this.waterWorker = worker; return worker;
    } catch { this.waterWorkerFailed = true; return null; }
  }

  /** Build an immutable generation within a CPU budget; install ALL its meshes
   *  together so neighbours never show different flow generations. */
  private rebuildQueuedWater(world: VoxelWorld): void {
    const start = performance.now();
    if (!this.waterBatch) {
      if (this.waterQueue.size === 0) return;
      // A terrain edit also changes the water boundary in diagonal chunks.
      // Wait until its brick scans finish, then mesh all affected water from
      // one snapshot instead of replacing one chunk early with a new lip.
      if ([...this.waterQueue.keys()].some((id) => this.queue.has(id) || this.chunks.get(id)?.stale)) return;
      const jobs = [...this.waterQueue].filter(([id]) => {
        const c = this.chunks.get(id);
        return c && !c.stale && !this.queue.has(id);
      }).sort((a, b) => this.distSqTo(a[0]) - this.distSqTo(b[0]));
      this.waterQueue.clear();
      if (jobs.length === 0) return;
      const snapshot = this.waterSnapshot ??= new Uint8Array(world.cells.length);
      snapshot.set(world.cells);
      const outside = world.outsideColumn?.slice();
      const frozen = { get: (x: number, y: number, z: number) =>
        x >= 0 && x < WORLD_X && z >= 0 && z < WORLD_Z && y >= 0 && y < WORLD_Y
          ? snapshot[(y * WORLD_Z + z) * WORLD_X + x]!
          : y >= 0 && y < WORLD_Y ? outside?.[y] ?? 0 : 0 };
      this.waterBatch = { id: ++this.waterSerial, waiting: false, world: frozen, jobs, cursor: 0, results: [] };
      const worker = this.ensureWaterWorker();
      if (worker) {
        const request: WaterWorkerRequest = { t: "build", id: this.waterBatch.id, cells: snapshot,
          outside: outside ?? null, jobs: jobs.map(([id, range]) => {
            const c = this.chunks.get(id)!;
            return { id, x: chunkX(id) * CHUNK, z: chunkZ(id) * CHUNK,
              minY: Math.max(0, Math.min(c.waterMinY, range[0])), maxY: Math.min(WORLD_Y - 1, Math.max(c.waterMaxY, range[1])) };
          }) };
        // Keep the immutable snapshot for bounded main-thread fallback if a
        // worker is unavailable; all result buffers return by transfer.
        this.waterBatch.waiting = true;
        worker.postMessage(request);
      }
    }
    const batch = this.waterBatch;
    if (batch.waiting) { this.waterBuildPeak = Math.max(this.waterBuildPeak, performance.now() - start); return; }
    while (batch.cursor < batch.jobs.length) {
      const [id, range] = batch.jobs[batch.cursor++]!;
      const chunk = this.chunks.get(id);
      if (!chunk || chunk.stale || this.queue.has(id)) continue;
      const x0 = chunkX(id) * CHUNK;
      const z0 = chunkZ(id) * CHUNK;
      const water: number[] = [];
      let minY = WORLD_Y, maxY = -1;
      const lo = Math.max(0, Math.min(chunk.waterMinY, range[0]));
      const hi = Math.min(WORLD_Y - 1, Math.max(chunk.waterMaxY, range[1]));
      for (let y = lo; y <= hi; y++) {
        for (let z = z0; z < Math.min(WORLD_Z, z0 + CHUNK); z++) {
          for (let x = x0; x < Math.min(WORLD_X, x0 + CHUNK); x++) {
            const block = batch.world.get(x, y, z);
            if (block !== 0 && SOLID_ID[block] === 0) {
              water.push(x, y, z); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
        }
      }
      const geometry = water.length ? buildWaterGeometry(batch.world, water) : null;
      batch.results.push({ id, geometry, minY, maxY });
      if (performance.now() - start >= WATER_BUILD_BUDGET_MS) break;
    }
    this.waterBuildPeak = Math.max(this.waterBuildPeak, performance.now() - start);
    if (batch.cursor < batch.jobs.length) return;
    const commitTime = performance.now() / 1000;
    // A maliciously fragmented batch can contain hundreds of thousands of
    // vertices. Preserve every surface, but omit expensive morph matching as
    // one atomic generation rather than blocking input or splitting seams.
    const animate = batch.results.reduce((n, r) => n + (r.geometry?.getAttribute("position").count ?? 0), 0) <= 32_768;
    for (const { id, geometry, minY, maxY } of batch.results) {
      const chunk = this.chunks.get(id);
      if (!chunk || chunk.stale || this.queue.has(id)) { geometry?.dispose(); continue; }
      this.installWater(chunk, geometry, minY, maxY, commitTime, animate);
    }
    this.waterBatch = null;
    this.waterCommits++;
  }

  private cancelWaterBatch(): void {
    if (!this.waterBatch) return;
    this.waterWorker?.postMessage({ t: "cancel", id: ++this.waterSerial } satisfies WaterWorkerRequest);
    for (const result of this.waterBatch.results) result.geometry?.dispose();
    for (const [id] of this.waterBatch.jobs) this.waterQueue.set(id, [0, WORLD_Y - 1]);
    this.waterBatch = null;
  }

  waterStats() {
    return { queued: this.waterQueue.size, pending: this.waterBatch ? this.waterBatch.jobs.length - this.waterBatch.cursor : 0,
      commits: this.waterCommits, peakBuildMs: this.waterBuildPeak, worker: !!this.waterWorker, workerMeshMs: this.workerMeshMs };
  }

  private invalidate(id: number): void {
    const cx = chunkX(id);
    const cz = chunkZ(id);
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return;
    this.cancelWaterBatch();
    const chunk = this.chunks.get(id);
    if (chunk) chunk.stale = true;
    this.queue.add(id);
  }

  /**
   * The world's contents moved by (-dx, -dz) cells (the education field
   * scrolled its window). For multiples of CHUNK, chunks still inside the
   * window are slid instead of re-scanned and only the strip that scrolled in
   * is queued for building.
   */
  shift(dx: number, dz: number): void {
    this.cancelWaterBatch();
    const waterQueued = [...this.waterQueue];
    this.waterQueue.clear();
    if (dx % CHUNK !== 0 || dz % CHUNK !== 0 || this.dirty) {
      this.dirty = true;
      return;
    }
    const scx = dx / CHUNK;
    const scz = dz / CHUNK;
    const queued = [...this.queue];
    this.queue.clear();
    const chunks = new Map<number, ChunkState>();
    for (const [id, chunk] of this.chunks) {
      const cx = chunkX(id) - scx;
      const cz = chunkZ(id) - scz;
      if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) {
        this.dropChunk(chunk);
        continue;
      }
      for (const mesh of chunk.meshes.values()) {
        mesh.position.x -= dx;
        mesh.position.z -= dz;
      }
      if (chunk.far) {
        chunk.far.position.x -= dx;
        chunk.far.position.z -= dz;
      }
      if (chunk.water) {
        chunk.water.position.x -= dx;
        chunk.water.position.z -= dz;
      }
      for (const list of chunk.studs.values()) {
        for (let i = 0; i < list.length; i += 3) {
          list[i] = list[i]! - dx;
          list[i + 2] = list[i + 2]! - dz;
        }
      }
      chunks.set(chunkId(cx, cz), chunk);
    }
    this.chunks = chunks;
    for (const [id, range] of waterQueued) {
      const cx = chunkX(id) - scx, cz = chunkZ(id) - scz;
      if (cx >= 0 && cz >= 0 && cx < CHUNKS_X && cz < CHUNKS_Z) this.waterQueue.set(chunkId(cx, cz), range);
    }
    // pending rebuilds follow their chunk to its new id
    for (const id of queued) this.invalidate(chunkId(chunkX(id) - scx, chunkZ(id) - scz));
    for (let cz = 0; cz < CHUNKS_Z; cz++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        if (!chunks.has(chunkId(cx, cz))) this.queue.add(chunkId(cx, cz));
      }
    }
    this.studsDirty = true;
  }

  setHighlight(voxel: [number, number, number] | null): void {
    if (!voxel) {
      this.highlight.visible = false;
      return;
    }
    this.highlight.visible = true;
    this.highlight.position.set(voxel[0] + 0.5, voxel[1] + 0.5, voxel[2] + 0.5);
  }

  // ------------------------------------------------------------ per frame

  /**
   * Re-evaluate LOD/studs if the focus moved, then build queued chunks
   * nearest-first within the frame budget. `eye` is the point of interest
   * (the player or the driven machine). Without it every chunk is near and
   * every stud is emitted — the old behaviour, which a fly-through wants.
   */
  update(world: VoxelWorld, eye?: THREE.Vector3): void {
    this.hasFocus = !!eye;
    if (eye && this.focus.distanceToSquared(eye) > STUD_STEP * STUD_STEP) {
      this.focus.copy(eye);
      this.studsDirty = true;
      this.queueLodChanges();
      this.applyVisibility();
    }
    if (this.dirty) {
      this.cancelWaterBatch();
      this.dirty = false;
      for (const chunk of this.chunks.values()) chunk.stale = true;
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) this.queue.add(chunkId(cx, cz));
      }
    }
    if (this.queue.size > 0) {
      const order = [...this.queue].sort((a, b) => this.distSqTo(a) - this.distSqTo(b));
      // The first fill and focus-less callers build everything at once, so a
      // world never appears half-drawn on load.
      const budget = this.primed && eye ? BUILD_BUDGET_MS : Infinity;
      const start = performance.now();
      const studRange = (STUD_RANGE + CHUNK) ** 2;
      for (const id of order) {
        this.queue.delete(id);
        // only a rescanned chunk near the focus changes the stud ring
        if (this.buildChunk(world, chunkX(id), chunkZ(id)) && this.distSqTo(id) <= studRange) this.studsDirty = true;
        if (performance.now() - start > budget) break;
      }
      this.primed = true;
    }
    if (this.waterQueue.size > 0 || this.waterBatch) this.rebuildQueuedWater(world);
    if (this.studsDirty) this.rebuildStuds(eye);
  }

  /** Squared distance from the focus to the nearest point of a chunk's box —
   *  including height, so climbing or flying high counts as moving away. */
  private distSqTo(id: number): number {
    if (!this.hasFocus) return 0;
    const eye = this.focus;
    const x0 = chunkX(id) * CHUNK;
    const z0 = chunkZ(id) * CHUNK;
    const dx = Math.max(x0, Math.min(eye.x, x0 + CHUNK)) - eye.x;
    const dz = Math.max(z0, Math.min(eye.z, z0 + CHUNK)) - eye.z;
    const chunk = this.chunks.get(id);
    const top = Math.max(chunk?.top ?? 0, chunk?.waterMaxY ?? -1);
    const dy = Math.max(0, eye.y - (top + 1));
    return dx * dx + dy * dy + dz * dz;
  }

  private wantsFar(id: number, chunk: ChunkState | undefined): boolean {
    if (!this.hasFocus) return false;
    const d = Math.sqrt(this.distSqTo(id));
    return chunk && !chunk.isFar ? d > LOD_NEAR + LOD_HYSTERESIS : d > LOD_NEAR;
  }

  /** Queue every chunk whose LOD band changed since it was built. */
  private queueLodChanges(): void {
    for (const [id, chunk] of this.chunks) {
      if (this.wantsFar(id, chunk) !== chunk.isFar) this.queue.add(id);
    }
  }

  // ------------------------------------------------------------ building

  /** Bring a chunk up to date; true if its cells were (re)scanned. */
  private buildChunk(world: VoxelWorld, cx: number, cz: number): boolean {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return false;
    const id = chunkId(cx, cz);
    let chunk = this.chunks.get(id);
    if (!chunk) {
      chunk = { meshes: new Map(), far: null, isFar: false, stale: true, top: 0, hidden: false, studs: new Map(), water: null, waterMinY: WORLD_Y, waterMaxY: -1 };
      this.chunks.set(id, chunk);
    }
    const far = this.wantsFar(id, chunk);
    const built = chunk.isFar ? chunk.far !== null : chunk.meshes.size > 0;
    if (!chunk.stale && far === chunk.isFar && built) return false;
    // A pure LOD flip of an unchanged chunk whose other form is still cached
    // is just a visibility swap.
    if (!chunk.stale && far !== chunk.isFar) {
      const cached = far ? chunk.far !== null : chunk.meshes.size > 0;
      if (cached) {
        chunk.isFar = far;
        this.showForm(chunk);
        return false;
      }
    }
    const rebuildWater = chunk.stale;
    if (chunk.stale) {
      // both forms describe old contents now
      this.disposeNear(chunk);
      this.disposeFar(chunk);
    }
    chunk.isFar = far;
    chunk.stale = false;
    this.scanChunk(world, chunk, cx, cz, far, rebuildWater);
    chunk.hidden = this.hasFocus && this.distSqTo(id) > this.renderDistance * this.renderDistance;
    this.showForm(chunk);
    return true;
  }

  private showForm(chunk: ChunkState): void {
    for (const mesh of chunk.meshes.values()) mesh.visible = !chunk.isFar && !chunk.hidden;
    if (chunk.far) chunk.far.visible = chunk.isFar && !chunk.hidden;
    if (chunk.water) chunk.water.visible = !chunk.hidden;
  }

  /**
   * Minecraft's render distance: chunks whose nearest point is farther than
   * this are hidden — no draw call, no shadow pass. Pair it with fog that is
   * fully opaque at the same distance so a chunk never visibly pops.
   */
  setRenderDistance(metres: number): void {
    this.renderDistance = metres;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const limit = this.renderDistance * this.renderDistance;
    for (const [id, chunk] of this.chunks) {
      const hidden = this.hasFocus && this.distSqTo(id) > limit;
      if (hidden === chunk.hidden) continue;
      chunk.hidden = hidden;
      this.showForm(chunk);
    }
  }

  /** Walk the chunk's cells once, emitting studs + either near instances or
   *  far face geometry. */
  private scanChunk(world: VoxelWorld, chunk: ChunkState, cx: number, cz: number, far: boolean, rebuildWater: boolean): void {
    const { cells, shapes } = world;
    const W = WORLD_X;
    const layer = WORLD_X * WORLD_Z;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const x1 = Math.min(WORLD_X, x0 + CHUNK);
    const z1 = Math.min(WORLD_Z, z0 + CHUNK);
    const positions = new Map<number, number[]>(); // near: (id << 8 | shape) → xyz…
    const farBuffers = new Map<number, FarBuffers>(); // far: block id → faces
    chunk.studs.clear();
    const water: number[] = [];
    let top = 0;

    const occludes = (nx: number, ny: number, nz: number): boolean => {
      let block: number;
      let shape: number;
      if (nx >= 0 && nx < W && nz >= 0 && nz < WORLD_Z && ny >= 0 && ny < WORLD_Y) {
        const ni = (ny * WORLD_Z + nz) * W + nx;
        block = cells[ni]!;
        shape = shapes[ni]!;
      } else {
        block = world.get(nx, ny, nz);
        shape = 0;
      }
      return SOLID_ID[block] === 1 && shape === 0 && !this.seeThrough.has(block);
    };

    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = z0; z < z1; z++) {
        let i = (y * WORLD_Z + z) * W + x0;
        for (let x = x0; x < x1; x++, i++) {
          const block = cells[i]!;
          if (SOLID_ID[block] === 0) {
            if (block !== 0) water.push(x, y, z); // water: its own mesh below
            continue;
          }
          // direct neighbour reads in the interior; the bounds-aware path
          // (which also sees the field's endless ground) only at the edges
          const interior = x > 0 && x < W - 1 && z > 0 && z < WORLD_Z - 1 && y > 0 && y < WORLD_Y - 1;
          const exposed = interior
            ? SOLID_ID[cells[i - 1]!] === 0 || SOLID_ID[cells[i + 1]!] === 0 || SOLID_ID[cells[i - W]!] === 0 ||
              SOLID_ID[cells[i + W]!] === 0 || SOLID_ID[cells[i - layer]!] === 0 || SOLID_ID[cells[i + layer]!] === 0
            : world.isExposed(x, y, z);
          if (!exposed) continue;
          top = y;
          const shape = shapes[i]!;
          const def = blockById(block);
          const airAbove = y < WORLD_Y - 1 ? SOLID_ID[cells[i + layer]!] === 0 : !world.isSolid(x, y + 1, z);
          // studs only cap flat-topped bricks (cube/round), never a slope
          if (def && !def.noStud && (shape === 0 || shape === ROUND) && airAbove) {
            let studs = chunk.studs.get(block);
            if (!studs) chunk.studs.set(block, (studs = []));
            studs.push(x, y, z);
          }

          if (!far) {
            const key = (block << 8) | shape;
            let list = positions.get(key);
            if (!list) positions.set(key, (list = []));
            list.push(x, y, z);
            continue;
          }

          let buf = farBuffers.get(block);
          if (!buf) farBuffers.set(block, (buf = { pos: new Floats(), nrm: new Floats(), uv: new Floats() }));
          if (shape === 0) {
            for (const face of FACES) {
              if (occludes(x + face.n[0], y + face.n[1], z + face.n[2])) continue;
              // a glass face next to glass is hidden too (no inner panes)
              if (this.seeThrough.has(block) && world.get(x + face.n[0], y + face.n[1], z + face.n[2]) === block) continue;
              for (let k = 0; k < 6; k++) {
                const [cu, cv] = FACE_CORNERS[k]!;
                buf.pos.push3(
                  x + face.o[0] + face.u[0] * cu + face.v[0] * cv,
                  y + face.o[1] + face.u[1] * cu + face.v[1] * cv,
                  z + face.o[2] + face.u[2] * cu + face.v[2] * cv,
                );
                buf.nrm.push3(face.n[0], face.n[1], face.n[2]);
                buf.uv.push2(FACE_UV[k * 2]!, FACE_UV[k * 2 + 1]!);
              }
            }
          } else {
            this.bakeShape(buf, x, y, z, shape);
          }
        }
      }
    }
    chunk.top = top;

    if (!this.primed && typeof Worker === "undefined") this.buildWater(world, chunk, water);
    else if (!this.primed || rebuildWater) this.waterQueue.set(chunkId(cx, cz), [0, WORLD_Y - 1]);
    if (far) this.buildFarMesh(chunk, farBuffers);
    else this.buildNearMeshes(chunk, positions);
  }

  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();

  /** Append a round/slope brick's cheap geometry, transformed, to a far buffer. */
  private bakeShape(buf: FarBuffers, x: number, y: number, z: number, shape: number): void {
    const geo = shape === ROUND ? this.farRound : this.farSlope;
    if (isSlope(shape)) brickOrientation(slopeYaw(shape), slopeTilt(shape), this.tmpQ);
    else this.tmpQ.identity();
    const p = geo.attributes.position!;
    const n = geo.attributes.normal!;
    const uv = geo.attributes.uv;
    const v = this.tmpV;
    for (let k = 0; k < p.count; k++) {
      v.fromBufferAttribute(p, k).applyQuaternion(this.tmpQ);
      buf.pos.push3(v.x + x + 0.5, v.y + y + 0.5, v.z + z + 0.5);
      v.fromBufferAttribute(n, k).applyQuaternion(this.tmpQ);
      buf.nrm.push3(v.x, v.y, v.z);
      buf.uv.push2(uv ? uv.getX(k) : 0, uv ? uv.getY(k) : 0);
    }
  }

  private buildFarMesh(chunk: ChunkState, farBuffers: Map<number, FarBuffers>): void {
    let vertices = 0;
    for (const buf of farBuffers.values()) vertices += buf.pos.length / 3;
    if (vertices === 0) return;
    const pos = new Float32Array(vertices * 3);
    const nrm = new Float32Array(vertices * 3);
    const uv = new Float32Array(vertices * 2);
    const geometry = new THREE.BufferGeometry();
    let at = 0;
    let glass = false;
    for (const [block, buf] of farBuffers) {
      const count = buf.pos.length / 3;
      if (count === 0) continue;
      pos.set(buf.pos.data.subarray(0, buf.pos.length), at * 3);
      nrm.set(buf.nrm.data.subarray(0, buf.nrm.length), at * 3);
      uv.set(buf.uv.data.subarray(0, buf.uv.length), at * 2);
      geometry.addGroup(at, count, this.materialIndex.get(block) ?? 0);
      if (this.seeThrough.has(block)) glass = true;
      at += count;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.materialList);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (glass) mesh.renderOrder = 2;
    this.scene.add(mesh);
    chunk.far = mesh;
  }

  private buildNearMeshes(chunk: ChunkState, positions: Map<number, number[]>): void {
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3(1, 1, 1);
    const pos = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (const [key, list] of positions) {
      const count = list.length / 3;
      const block = key >> 8;
      const shape = key & 0xff;
      const material = this.materials.get(block);
      if (!material) continue;
      const mesh = new THREE.InstancedMesh(this.geometryFor(shape), material, count);
      castsInstancedShadow(mesh);
      mesh.receiveShadow = true;
      if (this.seeThrough.has(block)) mesh.renderOrder = 2;
      if (isSlope(shape)) brickOrientation(slopeYaw(shape), slopeTilt(shape), q);
      else q.identity();
      for (let i = 0; i < count; i++) {
        pos.set(list[i * 3]! + 0.5, list[i * 3 + 1]! + 0.5, list[i * 3 + 2]! + 0.5);
        matrix.compose(pos, q, scl);
        mesh.setMatrixAt(i, matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      // instance bounds are NOT tracked automatically — without this the stale
      // sphere gets frustum-culled once the camera drops into a dig hole
      mesh.computeBoundingSphere();
      this.scene.add(mesh);
      chunk.meshes.set(key, mesh);
    }
  }

  private disposeNear(chunk: ChunkState): void {
    for (const mesh of chunk.meshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    chunk.meshes.clear();
  }

  // ------------------------------------------------------------ water

  private readonly waterMaterial = makeWaterMaterial();
  /** One quad far below the world, drawn only during the boot warm-up so the
   *  water shader compiles behind the loading screen, not at the first pour. */
  private waterWarm: THREE.Mesh | null = null;

  setWarm(on: boolean): void {
    if (on) this.ensureWaterWorker();
    if (on && !this.waterWarm) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.waterMaterial);
      quad.position.set(0, -1000, 0);
      quad.receiveShadow = true;
      quad.frustumCulled = false;
      this.scene.add(quad);
      this.waterWarm = quad;
    } else if (!on && this.waterWarm) {
      this.scene.remove(this.waterWarm);
      this.waterWarm.geometry.dispose();
      this.waterWarm = null;
    }
  }

  /** (Re)build the chunk's water mesh from the cells its scan collected. */
  private buildWater(world: VoxelWorld, chunk: ChunkState, cells: number[]): void {
    let minY = WORLD_Y, maxY = -1;
    for (let i = 1; i < cells.length; i += 3) { minY = Math.min(minY, cells[i]!); maxY = Math.max(maxY, cells[i]!); }
    this.installWater(chunk, cells.length ? buildWaterGeometry(world, cells) : null, minY, maxY);
  }

  private installWater(chunk: ChunkState, geometry: THREE.BufferGeometry | null, minY: number, maxY: number,
    time = performance.now() / 1000, animate = true): void {
    chunk.waterMinY = minY; chunk.waterMaxY = maxY;
    if (!geometry) { this.disposeWater(chunk); return; }
    prepareWaterTransition(geometry, chunk.water?.geometry ?? null,
      chunk.water?.position.x ?? 0, chunk.water?.position.z ?? 0, time, animate);
    if (chunk.water) {
      const old = chunk.water.geometry;
      chunk.water.geometry = geometry;
      // Vertices rebuilt in the new field grid must lose the old scroll offset.
      chunk.water.position.set(0, 0, 0);
      chunk.water.visible = !chunk.hidden;
      old.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, this.waterMaterial);
    mesh.receiveShadow = true;
    mesh.renderOrder = 3; // after glass, so glass behind water still shows
    mesh.visible = !chunk.hidden;
    this.scene.add(mesh);
    chunk.water = mesh;
  }

  private disposeWater(chunk: ChunkState): void {
    if (!chunk.water) return;
    this.scene.remove(chunk.water);
    chunk.water.geometry.dispose();
    chunk.water = null;
  }

  /** Per frame: the water's clock, and the field origin its ripples are pinned to. */
  animateWater(time: number, originX = 0, originZ = 0): void {
    animateWater(time, originX, originZ);
  }

  private disposeFar(chunk: ChunkState): void {
    if (!chunk.far) return;
    this.scene.remove(chunk.far);
    chunk.far.geometry.dispose();
    chunk.far = null;
  }

  private dropChunk(chunk: ChunkState): void {
    this.disposeNear(chunk);
    this.disposeFar(chunk);
    this.disposeWater(chunk);
    chunk.studs.clear();
  }

  // ------------------------------------------------------------ studs

  /**
   * 2×2 studs per top face (0.5 m sub-cells) so a 1 m voxel reads as small,
   * densely-studded LEGO like the jump-map's 0.7 m bricks — not one big cube.
   * Only cells within STUD_RANGE of the focus are emitted, and chunks wholly
   * out of range are skipped without walking their cells.
   */
  private rebuildStuds(eye?: THREE.Vector3): void {
    this.studsDirty = false;
    const range = STUD_RANGE * STUD_RANGE;
    const near = new Map<number, number[][]>();
    for (const [id, chunk] of this.chunks) {
      if (eye && this.distSqTo(id) > range) continue;
      for (const [block, list] of chunk.studs) {
        let bucket = near.get(block);
        if (!bucket) near.set(block, (bucket = []));
        bucket.push(list);
      }
    }
    const matrix = new THREE.Matrix4();
    for (const def of BLOCKS) {
      const bucket = near.get(def.id) ?? [];
      // Count what is actually in range before touching the GPU buffer.
      let inRange = 0;
      for (const list of bucket) {
        for (let i = 0; i < list.length; i += 3) {
          if (!eye || this.withinRange(list, i, eye, range)) inRange++;
        }
      }
      const count = inRange * STUD_OFFSETS.length;
      let mesh = this.studMeshes.get(def.id);
      // Do not create a GPU buffer for an unused block type.
      if (count === 0) {
        if (mesh) mesh.count = 0;
        continue;
      }
      if (!mesh || mesh.instanceMatrix.count < count) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.dispose();
        }
        const material = this.materials.get(def.id);
        if (!material) continue;
        const capacity = Math.max(256, Math.ceil(count * 1.25));
        mesh = new THREE.InstancedMesh(this.studGeometry, material, capacity);
        // 10 cm caps: their shadows are invisible but doubled the shadow pass
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.studMeshes.set(def.id, mesh);
      }
      let k = 0;
      for (const list of bucket) {
        for (let i = 0; i < list.length; i += 3) {
          if (eye && !this.withinRange(list, i, eye, range)) continue;
          const x = list[i]! + 0.5;
          const y = list[i + 1]! + 1;
          const z = list[i + 2]! + 0.5;
          for (const [ox, oz] of STUD_OFFSETS) {
            matrix.makeTranslation(x + ox, y, z + oz);
            mesh.setMatrixAt(k++, matrix);
          }
        }
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  private withinRange(
    list: number[],
    i: number,
    eye: THREE.Vector3,
    range: number,
  ): boolean {
    const dx = list[i]! + 0.5 - eye.x;
    const dy = list[i + 1]! + 1 - eye.y;
    const dz = list[i + 2]! + 0.5 - eye.z;
    return dx * dx + dy * dy + dz * dz <= range;
  }

  dispose(): void {
    this.cancelWaterBatch();
    this.waterQueue.clear();
    this.waterWorker?.terminate(); this.waterWorker = null;
    for (const chunk of this.chunks.values()) this.dropChunk(chunk);
    this.setWarm(false);
    this.waterMaterial.dispose();
    for (const mesh of this.studMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.studGeometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const material of this.materialList) material.dispose(); // the merged twins
    this.scene.remove(this.highlight);
    this.highlight.geometry.dispose();
    (this.highlight.material as THREE.Material).dispose();
    this.cubeGeo.dispose();
    this.roundGeo.dispose();
    this.slopeGeo.dispose();
    this.farRound.dispose();
    this.farSlope.dispose();
  }
}
