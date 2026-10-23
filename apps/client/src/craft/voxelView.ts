import * as THREE from "three";
import { castsInstancedShadow } from "../render/instancedDepth.js";
import { BLOCKS, blockById, textureUrl, type BlockDef } from "./blocks.js";
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

  private invalidate(id: number): void {
    const cx = chunkX(id);
    const cz = chunkZ(id);
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return;
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
      for (const list of chunk.studs.values()) {
        for (let i = 0; i < list.length; i += 3) {
          list[i] = list[i]! - dx;
          list[i + 2] = list[i + 2]! - dz;
        }
      }
      chunks.set(chunkId(cx, cz), chunk);
    }
    this.chunks = chunks;
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
    const top = this.chunks.get(id)?.top ?? 0;
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
      chunk = { meshes: new Map(), far: null, isFar: false, stale: true, top: 0, hidden: false, studs: new Map() };
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
    if (chunk.stale) {
      // both forms describe old contents now
      this.disposeNear(chunk);
      this.disposeFar(chunk);
    }
    chunk.isFar = far;
    chunk.stale = false;
    this.scanChunk(world, chunk, cx, cz, far);
    chunk.hidden = this.hasFocus && this.distSqTo(id) > this.renderDistance * this.renderDistance;
    this.showForm(chunk);
    return true;
  }

  private showForm(chunk: ChunkState): void {
    for (const mesh of chunk.meshes.values()) mesh.visible = !chunk.isFar && !chunk.hidden;
    if (chunk.far) chunk.far.visible = chunk.isFar && !chunk.hidden;
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
  private scanChunk(world: VoxelWorld, chunk: ChunkState, cx: number, cz: number, far: boolean): void {
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
      return block !== 0 && shape === 0 && !this.seeThrough.has(block);
    };

    for (let y = 0; y < WORLD_Y; y++) {
      for (let z = z0; z < z1; z++) {
        let i = (y * WORLD_Z + z) * W + x0;
        for (let x = x0; x < x1; x++, i++) {
          const block = cells[i]!;
          if (block === 0) continue;
          // direct neighbour reads in the interior; the bounds-aware path
          // (which also sees the field's endless ground) only at the edges
          const interior = x > 0 && x < W - 1 && z > 0 && z < WORLD_Z - 1 && y > 0 && y < WORLD_Y - 1;
          const exposed = interior
            ? cells[i - 1] === 0 || cells[i + 1] === 0 || cells[i - W] === 0 || cells[i + W] === 0 ||
              cells[i - layer] === 0 || cells[i + layer] === 0
            : world.isExposed(x, y, z);
          if (!exposed) continue;
          top = y;
          const shape = shapes[i]!;
          const def = blockById(block);
          const airAbove = y < WORLD_Y - 1 ? cells[i + layer] === 0 : !world.isSolid(x, y + 1, z);
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

  private disposeFar(chunk: ChunkState): void {
    if (!chunk.far) return;
    this.scene.remove(chunk.far);
    chunk.far.geometry.dispose();
    chunk.far = null;
  }

  private dropChunk(chunk: ChunkState): void {
    this.disposeNear(chunk);
    this.disposeFar(chunk);
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
    for (const chunk of this.chunks.values()) this.dropChunk(chunk);
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
