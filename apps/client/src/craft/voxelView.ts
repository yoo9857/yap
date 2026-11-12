import { kitCellsGeometryRust } from "./kitRust.js";
import type { RustEngine } from "../engine/rustEngine.js";
import {kitCubeGeometry,kitRampGeometry,kitRoundGeometry,kitCellsGeometry,kitBoxesGeometry} from "./kitGeometry.js";
import * as THREE from "three";
import {mergeGeometries} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {KEEP_INK,framelessTile,repeatingKitTexture} from "./kitSurface.js";
import { AimOutline } from "./aimOutline.js";
import { STUD_HQ_DISTANCE, fallbackStuds, loadBlockStuds, type BlockStudGeometries } from "./blockStuds.js";
import {BlockMaterialLibrary,linkSurfaceTwin,materialFaceGroups,needsCatalogTexture} from "./blockMaterials.js";
import { castsInstancedShadow } from "../render/instancedDepth.js";
import { BLOCKS, SOLID_ID, blockById, textureUrl, type BlockDef } from "./blocks.js";
import { animateWater, buildWaterGeometry, makeWaterMaterial, prepareWaterTransition } from "./waterMesh.js";
import { drawWaterAsStreams, drawWaterFinite, drawWaterSimple, hasWaterEngine, loadWaterEngine } from "./waterMesher.js";
import type { WaterWorkerRequest, WaterWorkerResponse } from "./waterWorkerTypes.js";
import { loadTexture } from "../render/textures.js";
import { WORLD_X, WORLD_Y, WORLD_Z, type VoxelWorld } from "./voxelWorld.js";
import { WATER_FALLING, WATER_HELD, shapeProfile } from "@robo/shared";
import { WATER_LAYER, type WaterPipeline } from "../render/waterPipeline.js";
import { ROUND, KIT_CUBE, isOrientedShape, shapeYaw, shapeTilt, isFullCubeShape, blockShapeFamily, shapeBoxes } from "./shapes.js";
import {
  brickOrientation,
  cubeBrickGeometry,
  slopeBrickGeometry,
} from "./brickGeometry.js";

/** Columns per chunk. Chunks are the unit of culling, rebuilding and LOD. */
const CHUNK = 16;
/** Studs (4 cm tall caps, 20 cm across) are sub-pixel past this, and they were 41% of the
 *  island's triangles, so they are only emitted near the viewer. */
const STUD_RANGE = 32;
/** How far the focus may move before the Stud_HQ / Stud_LOD1 split is redone; tops are given
 *  the original within STUD_HQ_DISTANCE + this, so never less than STUD_HQ_DISTANCE. */
const STUD_HQ_STEP = 2;
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
  /** Near form only: the solid region's exact outer surface, drawn from inside only (dark), so the
   *  1 cm seams between construction bricks are never see-through (see GAP_BACKING). */
  backing: THREE.Mesh | null;
  waterMinY: number;
  waterMaxY: number;
  /** A far → near flip being built a few meshes per frame (see stepStaging); the far form stays
   *  drawn until every near mesh is ready, then the two swap in one frame. */
  staging: Staging | null;
}

/** The near form of an unchanged chunk, built in budgeted steps instead of one long frame. */
interface Staging {
  id: number;
  world: VoxelWorld;
  keys: number[];
  next: number;
  positions: Map<number, number[]>;
  backing: Floats;
  built: Map<number, THREE.InstancedMesh>;
}

interface WaterBatch {
  id: number;
  waiting: boolean;
  world: Pick<VoxelWorld, "get"> & { profile(x: number, y: number, z: number): number };
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
/**
 * How far the seam backing sits INSIDE the region's outer surface. The bricks are inset 1 cm on
 * their sides and up to 3.2 cm at their chamfered top/bottom edges (kitShell profile); a backing
 * on the exact cell boundary stuck out past them along every silhouette, and its dark seam
 * colour drew a black line around every block group. 3.5 cm keeps it inside the brick everywhere.
 */
const BACKING_INSET = 0.035;

const FACE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
];

/**
 * The water mesher sees one id per cell, so a shaped block holding water (VoxelWorld.wet, filled by
 * the water simulation — waterlog.ts) is handed to it AS that water, in the mesher's own snapshot
 * only. The block is drawn opaque over whatever of the water falls inside its solid part, so the
 * surface runs on through the open part of a ramp, round, half block or stairs and meets its face.
 * Only the chunks being rebuilt (plus a one-cell rim) are touched. Returns how many cells it filled.
 */
export function waterlogSnapshot(cells: Uint8Array, wet: Uint8Array, regions: readonly { x: number; z: number; minY: number; maxY: number }[],
  shapes?: Uint8Array, profile?: Uint8Array, live: Uint8Array = cells, marks?: number[]): number {
  let filled = 0;
  for (const r of regions) {
    for (let y = Math.max(0, r.minY - 1); y <= Math.min(WORLD_Y - 1, r.maxY + 1); y++)
      for (let z = Math.max(0, r.z - 1); z < Math.min(WORLD_Z, r.z + CHUNK + 1); z++) {
        let i = (y * WORLD_Z + z) * WORLD_X + Math.max(0, r.x - 1);
        for (let x = Math.max(0, r.x - 1); x < Math.min(WORLD_X, r.x + CHUNK + 1); x++, i++) {
          const w = wet[i]!;
          // Water that came down ONTO the block (falling: fed from above) runs over it as a film, so
          // the mesher gets the block's top at each corner (shapeProfile). Water that reached it
          // from the side stands at its own level around the block, as before.
          // Every other shaped block holding water is marked WATER_HELD: what spills out of it runs
          // down as a sheet instead of standing round it as a cell-wide collar.
          if (profile) {
            profile[i] = w === 0 || !shapes ? 0 : (w === WATER_FALLING ? shapeProfile(shapes[i]!) : 0) || WATER_HELD;
            if (marks && profile[i] !== 0) marks.push(i, profile[i]!); // the worker gets only these
          }
          // Water running over the block from the cell above (a lip hanging in the open: flowing,
          // with air beside it) is that same film, not a second body of water on top of it —
          // down a slide of ramps it stacked a cell of water on every step. Judged on the LIVE
          // cells, so hiding one lip never decides its neighbour (chunks must agree).
          if (profile && (profile[i]! & 3) !== 0 && y + 1 < WORLD_Y) {
            const j = i + WORLD_X * WORLD_Z, above = live[j]!;
            if (above > 19 && above < 27 && (x > 0 && live[j - 1] === 0 || x < WORLD_X - 1 && live[j + 1] === 0 ||
              z > 0 && live[j - WORLD_X] === 0 || z < WORLD_Z - 1 && live[j + WORLD_X] === 0)) cells[j] = 0;
          }
          if (w !== 0 && cells[i] !== w) { cells[i] = w; filled++; }
        }
      }
  }
  return filled;
}

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
/**
 * The block materials use vertexColors (the kit shells bake their shading into
 * a colour attribute). A geometry WITHOUT that attribute reads (0,0,0) from
 * WebGL and draws black — that was the studs and every far chunk. White = no
 * tint; one byte per channel keeps it cheap on the big merged meshes.
 */
/**
 * The generated grass top is painted for a bright studio and reads olive under
 * the game's sky light and fog; lift it toward the yellow-green of the block
 * review page. A colour above 1 is a plain multiplier in the shader.
 */
const GRASS_TINT: [number, number, number] = (() => {
  const raw = typeof location !== "undefined" ? new URLSearchParams(location.search).get("grassTint") : null;
  const v = raw?.split(",").map(Number);
  return v && v.length === 3 && v.every(Number.isFinite) ? [v[0]!, v[1]!, v[2]!] : [1.18, 1.3, 0.92];
})();

function whiteVertexColors<T extends THREE.BufferGeometry>(geometry: T): T {
  if (!geometry.getAttribute("color")) {
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(count * 3).fill(255), 3, true));
  }
  return geometry;
}

export class VoxelView {
  private disposed = false;
  private readonly fallingHidden=new Set<number>();
  private miningHidden:readonly [number,number,number]|null=null;
  private readonly miningPriority=new Set<number>();
  private readonly blockSurfaces:BlockMaterialLibrary;
  private readonly clonedBlockTextures=new Set<THREE.Texture>();
  private readonly faceMaterialIndices=new Map<number,number[]>();
  private readonly kitCubeGeo=kitCubeGeometry();
  private readonly kitSlopeGeo=kitRampGeometry();
  private readonly cornerGeo=kitRampGeometry(true);
  private readonly farCorner=kitRampGeometry(true,0);
  /** Half block and stairs (blockShapes shapeBoxes): one bevelled box-union each, near and far. */
  private readonly slabGeo=kitBoxesGeometry(shapeBoxes("slab")!);
  private readonly stairsGeo=kitBoxesGeometry(shapeBoxes("stairs")!);
  private readonly farSlab=nonIndexed(kitBoxesGeometry(shapeBoxes("slab")!));
  private readonly farStairs=nonIndexed(kitBoxesGeometry(shapeBoxes("stairs")!));
  private readonly cubeGeo = cubeBrickGeometry();
  private readonly roundGeo = kitRoundGeometry();
  private readonly slopeGeo = slopeBrickGeometry();
  /** Cheap non-indexed shapes baked into far meshes for round/slope bricks. */
  private readonly farRound = new THREE.CylinderGeometry(0.5, 0.5, 1, 8).toNonIndexed();
  private readonly farSlope = nonIndexed(kitRampGeometry(false,0));
  /** The Blender studs (blockStuds.ts): this view's own copies, the code twin until the GLB lands. */
  private studs: BlockStudGeometries = fallbackStuds();
  /** key = ((block << 1 | style) << 1) | form (0 Stud_HQ, 1 Stud_LOD1). */
  private readonly studMeshes = new Map<number, THREE.InstancedMesh>();
  /** Where the stud forms were last split; the HQ ring is re-split every STUD_HQ_STEP. */
  private readonly studFocus = new THREE.Vector3(Infinity, Infinity, Infinity);
  private chunks = new Map<number, ChunkState>();
  private readonly queue = new Set<number>();
  private readonly materials = new Map<number, THREE.Material>();
  private readonly kitMaterials = new Map<number,THREE.MeshPhysicalMaterial[]>();
  private readonly ownedShells = new WeakSet<THREE.BufferGeometry>();
  /** Material index for far-mesh groups (block ids are sparse-ish). */
  private readonly materialList: THREE.Material[] = [];
  private readonly materialIndex = new Map<number, number>();
  /** Blocks you can see through: they never hide a neighbour's face. */
  private readonly seeThrough = new Set<number>();
  /** The seam colour seen through gaps between bricks (GAP_BACKING). */
  private readonly backingMaterial = new THREE.MeshBasicMaterial({ color: 0x1d1a16, side: THREE.BackSide });
  /** Shaped cells the last water build drew as water (dev audit: __roboCraft.waterlogStats). */
  lastWaterlog = 0;
  /** The crosshair's box: thick, two-tone, never lost in a joined neighbour (aimOutline.ts). */
  private readonly highlight = new AimOutline();
  private dirty = true;
  private primed = false;
  private readonly focus = new THREE.Vector3(Infinity, Infinity, Infinity);
  private hasFocus = false;
  private studsDirty = true;
  private renderDistance = Infinity;

  constructor(private readonly scene: THREE.Scene,private readonly options:{catalogTextures?:boolean;generatedSurfaces?:boolean}={}) {
    this.blockSurfaces=new BlockMaterialLibrary(options.generatedSurfaces===true);
    for (const def of BLOCKS) {
      if (def.fluid) continue; // drawn by the water mesh, never as a brick
      const [material, merged] = this.makeMaterials(def);
      this.materials.set(def.id, material);
      const kit=this.blockSurfaces.get(def.key,def.color,material as THREE.MeshStandardMaterial);
      this.kitMaterials.set(def.id,kit);
      for(const m of kit)if(m.name.endsWith("/ grass"))m.color.setRGB(...GRASS_TINT);
      const far=kit.map(m=>{const twin=m.clone();linkSurfaceTwin(m,twin);return twin;});this.materialIndex.set(def.id,this.materialList.length);this.faceMaterialIndices.set(def.id,far.map((_,i)=>this.materialList.length+i));this.materialList.push(...far);merged.dispose();
      if(options.catalogTextures!==false&&needsCatalogTexture(def))void loadTexture(textureUrl(def)).then(tex=>{if(this.disposed||!tex)return;const map=repeatingKitTexture(tex,KEEP_INK.has(def.texture));this.clonedBlockTextures.add(map);for(const m of [...kit,...far]){m.map=map;m.color.set(0xffffff);if(def.emissive)m.emissiveMap=map;m.needsUpdate=true;}});
      if (def.seeThrough) this.seeThrough.add(def.id);
    }
    scene.add(this.highlight.object);
    // the Blender studs replace the code twin as soon as they land (craftGame awaits them at boot)
    void loadBlockStuds().then((s) => this.useStuds(s));
  }

  /** Take (copies of) the stud geometries: every stud mesh is rebuilt on them next frame. */
  private useStuds(s: BlockStudGeometries): void {
    if (this.disposed || !s.fromBlender) return;
    for (const mesh of this.studMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.studMeshes.clear();
    this.studs.hq.dispose();
    this.studs.lod.dispose();
    this.studs = { hq: s.hq.clone(), lod: s.lod.clone(), fromBlender: true };
    this.studsDirty = true;
  }

  /** Whether the studs drawn are the Blender ones (debug: __roboCraft). */
  studsFromBlender(): boolean {
    return this.studs.fromBlender;
  }

  private geometryFor(shape: number): THREE.BufferGeometry {
    const family=blockShapeFamily(shape);if(family==="slab")return this.slabGeo;if(family==="stairs")return this.stairsGeo;
    return isFullCubeShape(shape)?this.kitCubeGeo:shape===ROUND?this.roundGeo:family==="corner"?this.cornerGeo:isOrientedShape(shape)?(shape>=19?this.kitSlopeGeo:this.slopeGeo):this.cubeGeo;
  }

  /** Visual masking never mutates world cells, collision, saves or inventory. */
  setMiningHidden(cell:readonly [number,number,number]|null):void {
    if(this.miningHidden?.join(",")===cell?.join(","))return;
    const previous=this.miningHidden;this.miningHidden=cell?[...cell]:null;
    for(const c of [previous,cell]){if(!c)continue;this.markCellDirty(...c);
      const cx=Math.floor(c[0]/CHUNK),cz=Math.floor(c[2]/CHUNK),lx=c[0]-cx*CHUNK,lz=c[2]-cz*CHUNK;
      this.miningPriority.add(chunkId(cx,cz));
      if(lx===0)this.miningPriority.add(chunkId(cx-1,cz));if(lx===CHUNK-1)this.miningPriority.add(chunkId(cx+1,cz));
      if(lz===0)this.miningPriority.add(chunkId(cx,cz-1));if(lz===CHUNK-1)this.miningPriority.add(chunkId(cx,cz+1));
    }
  }
  setFallingHidden(cells:readonly (readonly [number,number,number])[]):void {
    const next=new Set(cells.map(([x,y,z])=>(y*WORLD_Z+z)*WORLD_X+x));
    for(const index of new Set([...next,...this.fallingHidden]))if(next.has(index)!==this.fallingHidden.has(index)){
      const x=index%WORLD_X,y=Math.floor(index/(WORLD_X*WORLD_Z)),z=Math.floor(index/WORLD_X)%WORLD_Z;this.markCellDirty(x,y,z);const cx=Math.floor(x/CHUNK),cz=Math.floor(z/CHUNK);this.miningPriority.add(chunkId(cx,cz));
      if(x%CHUNK===0)this.miningPriority.add(chunkId(cx-1,cz));if(x%CHUNK===CHUNK-1)this.miningPriority.add(chunkId(cx+1,cz));
      if(z%CHUNK===0)this.miningPriority.add(chunkId(cx,cz-1));if(z%CHUNK===CHUNK-1)this.miningPriority.add(chunkId(cx,cz+1));
    }
    this.fallingHidden.clear();for(const index of next)this.fallingHidden.add(index);
  }
  private isMiningHidden(x:number,y:number,z:number):boolean {return (x>=0&&x<WORLD_X&&y>=0&&y<WORLD_Y&&z>=0&&z<WORLD_Z&&this.fallingHidden.has((y*WORLD_Z+z)*WORLD_X+x))||!!this.miningHidden&&x===this.miningHidden[0]&&y===this.miningHidden[1]&&z===this.miningHidden[2];}


  /**
   * The merged-mesh twins, not the instanced kit materials: a shard is a plain Mesh, and an
   * instanced material drawn on one flips its shader variant every frame (see render/instancedDepth.ts).
   */
  /**
   * Give the reflective surfaces (metal, gem, glass) a sky to reflect. Applied to
   * the instanced kit materials and their merged-mesh twins alike, before the
   * boot warm-up compiles them; matte blocks are left untouched.
   */
  setEnvironment(texture:THREE.Texture|null):void {
    const strength:Record<string,number>={metal:1.15,gem:.8,glass:.7,ore:.25};
    const apply=(m:THREE.Material)=>{if(!(m instanceof THREE.MeshStandardMaterial))return;const s=strength[String(m.userData.surface_family)];if(s===undefined)return;m.envMap=texture;m.envMapIntensity=s;m.needsUpdate=true;};
    for(const list of this.kitMaterials.values())list.forEach(apply);
    this.materialList.forEach(apply);
  }

  miningMaterials(block:number):THREE.Material[] {return (this.faceMaterialIndices.get(block)??[]).map(i=>this.materialList[i]!);}

  /** Preserve live surface materials, orientation, UVs and exposed connectors on the fractured copy. */
  miningShape(shape:number,block:number,cell?:readonly [number,number,number],world?:Pick<VoxelWorld,"isSolid">):{geometry:THREE.BufferGeometry;rotation:THREE.Quaternion;materials:THREE.Material[]} {
    if(cell&&world&&["grass","flower-grass"].includes(blockById(block)?.key??"")&&world.isSolid(cell[0],cell[1]+1,cell[2]))block=2;
    let geometry=this.geometryFor(shape).clone();const rotation=isOrientedShape(shape)?brickOrientation(shapeYaw(shape),shapeTilt(shape)):new THREE.Quaternion();
    const materials=this.miningMaterials(block);
    if(cell&&world&&!blockById(block)?.noStud&&(isFullCubeShape(shape)||shape===ROUND)&&!world.isSolid(cell[0],cell[1]+1,cell[2])){
      const parts=[geometry.index?geometry.toNonIndexed():geometry.clone()];
      const cap=this.studs.hq.clone().translate(0,.5,0);parts.push(cap.index?cap.toNonIndexed():cap);if(cap.index)cap.dispose();
      const merged=mergeGeometries(parts);for(const p of parts)p.dispose();if(merged){geometry.dispose();geometry=merged;}
    }
    if(materials.length>1)materialFaceGroups(geometry,rotation);
    return {geometry,rotation,materials};
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
    const clear = def.seeThrough === true;
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      roughness: 0.75,
      metalness: 0.05,
      transparent: clear,
      opacity: clear ? 0.55 : 1,
    });
    if (def.emissive) {
      material.emissive = new THREE.Color(def.color);
      material.emissiveIntensity = 0.55;
    }
    if(this.options.catalogTextures!==false)void loadTexture(textureUrl(def)).then((tex) => {
      if (this.disposed || !tex) return; // keep the solid crayon colour
      const tile = framelessTile(tex, KEEP_INK.has(def.texture)); // no icon frame or ink grid (kitSurface)
      material.map = tile;
      material.color.set(0xffffff); // the tile carries the hue, exactly like the tower
      if (def.emissive) material.emissiveMap = tile;
      material.needsUpdate = true;
    });
    return material;
  }

  // ------------------------------------------------------------ dirtiness

  /** Rebuild every chunk (initial load, wholesale world changes). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Water cleanup is immediate: cancel stale worker results and drop water meshes only. */
  drainWater(): void {
    this.cancelWaterBatch();
    this.waterQueue.clear();
    for (const chunk of this.chunks.values()) this.installWater(chunk, null, WORLD_Y, -1);
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
  private waterProfile: Uint8Array | null = null;
  private finiteWater = false;
  /** Finite water is drawn by amount; the worker has its own copy of that switch. */
  setFiniteWater(on: boolean): void { this.finiteWater = on; drawWaterFinite(on); }
  private waterSimple = true;
  /** The simple, Minecraft-like water (default) or the surface net (waterMesher.ts). */
  setWaterSimple(on: boolean): void { this.waterSimple = on; drawWaterSimple(on); }
  private waterStreams = false;
  /** Water in the air as films and streams (waterMesher.ts); the worker is told with each build. */
  setWaterStreams(on: boolean): void { this.waterStreams = on; drawWaterAsStreams(on); }
  private waterBuildPeak = 0;
  /** Main-thread cost of a water generation: handing it to the worker / installing its meshes (ms). */
  private waterCost = { snapshotPeak: 0, snapshotSum: 0, installPeak: 0, installSum: 0, vertices: 0 };
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
        // the worker is gone (or its engine failed): mesh on this thread, within the frame budget,
        // once the engine has been loaded here
        this.waterWorkerFailed = true; worker.terminate(); this.waterWorker = null;
        if (this.waterBatch) this.waterBatch.waiting = false;
        void loadWaterEngine();
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
      const profile = this.waterProfile ??= new Uint8Array(world.cells.length);
      // The whole height each chunk is re-meshed over, not just the layers that changed: the mesher
      // reads the chunk's every water cell, so a shaped block holding water BELOW or ABOVE the
      // change must be handed over too (limited to the changed layers, its water vanished from the
      // new mesh whenever something else in its chunk moved).
      const spans = jobs.map(([id, range]) => {
        const c = this.chunks.get(id)!;
        return { id, x: chunkX(id) * CHUNK, z: chunkZ(id) * CHUNK,
          minY: Math.max(0, Math.min(c.waterMinY, range[0])), maxY: Math.min(WORLD_Y - 1, Math.max(c.waterMaxY, range[1])) };
      });
      const marks: number[] = [];
      this.lastWaterlog = waterlogSnapshot(snapshot, world.wet, spans, world.shapes, profile, world.cells, marks);
      const outside = world.outsideColumn?.slice();
      const frozen = { get: (x: number, y: number, z: number) =>
        x >= 0 && x < WORLD_X && z >= 0 && z < WORLD_Z && y >= 0 && y < WORLD_Y
          ? snapshot[(y * WORLD_Z + z) * WORLD_X + x]!
          : y >= 0 && y < WORLD_Y ? outside?.[y] ?? 0 : 0,
        profile: (x: number, y: number, z: number) =>
          x >= 0 && x < WORLD_X && z >= 0 && z < WORLD_Z && y >= 0 && y < WORLD_Y ? profile[(y * WORLD_Z + z) * WORLD_X + x]! : 0 };
      this.waterBatch = { id: ++this.waterSerial, waiting: false, world: frozen, jobs, cursor: 0, results: [] };
      const worker = this.ensureWaterWorker();
      if (worker) {
        const request: WaterWorkerRequest = { t: "build", id: this.waterBatch.id, cells: snapshot, profile: Int32Array.from(marks), finite: this.finiteWater, streams: this.waterStreams, simple: this.waterSimple,
          outside: outside ?? null, jobs: spans };
        // Keep the immutable snapshot for bounded main-thread fallback if a
        // worker is unavailable; all result buffers return by transfer.
        this.waterBatch.waiting = true;
        worker.postMessage(request);
      }
      const cost = performance.now() - start;
      this.waterCost.snapshotPeak = Math.max(this.waterCost.snapshotPeak, cost); this.waterCost.snapshotSum += cost;
    }
    const batch = this.waterBatch;
    if (batch.waiting) { this.waterBuildPeak = Math.max(this.waterBuildPeak, performance.now() - start); return; }
    if (!hasWaterEngine()) { void loadWaterEngine(); return; } // no worker: wait for the engine on this thread
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
    const cost = performance.now() - commitTime * 1000;
    this.waterCost.installPeak = Math.max(this.waterCost.installPeak, cost); this.waterCost.installSum += cost;
    this.waterCost.vertices = batch.results.reduce((n, r) => n + (r.geometry?.getAttribute("position").count ?? 0), 0);
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
      commits: this.waterCommits, peakBuildMs: this.waterBuildPeak, worker: !!this.waterWorker, workerMeshMs: this.workerMeshMs, cost: { ...this.waterCost } };
  }

  chunkStats() {
    let near = 0, far = 0, water = 0;
    for (const chunk of this.chunks.values()) {
      near += chunk.meshes.size; far += Number(chunk.far !== null); water += Number(chunk.water !== null);
    }
    return { chunks: this.chunks.size, queued: this.queue.size, staged: this.staged.size, nearMeshes: near, farMeshes: far, waterMeshes: water,
      disposed: this.disposed };
  }

  private invalidate(id: number): void {
    const cx = chunkX(id);
    const cz = chunkZ(id);
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return;
    this.cancelWaterBatch();
    const chunk = this.chunks.get(id);
    if (chunk) { chunk.stale = true; this.dropStaging(chunk); }
    this.queue.add(id);
  }

  /**
   * The world's contents moved by (-dx, -dz) cells (the education field
   * scrolled its window). For multiples of CHUNK, chunks still inside the
   * window are slid instead of re-scanned and only the strip that scrolled in
   * is queued for building.
   */
  shift(dx: number, dz: number): void {
    this.dropAllStaging(); // staged positions are grid cells from before the scroll
    this.setMiningHidden(null);this.setFallingHidden([]);this.miningPriority.clear();
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
      if (chunk.backing) {
        chunk.backing.position.x -= dx;
        chunk.backing.position.z -= dz;
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
    // Retained boundary faces were meshed against the old outside column or
    // a neighbour that just unloaded. Restored neighbours can change both
    // brick exposure and a perfectly stable water surface without any edit.
    for (const [id] of chunks) {
      const cx = chunkX(id), cz = chunkZ(id);
      if (scx !== 0 && (cx === 0 || cx === CHUNKS_X - 1 || !chunks.has(chunkId(cx - 1, cz)) || !chunks.has(chunkId(cx + 1, cz))) ||
        scz !== 0 && (cz === 0 || cz === CHUNKS_Z - 1 || !chunks.has(chunkId(cx, cz - 1)) || !chunks.has(chunkId(cx, cz + 1)))) this.invalidate(id);
    }
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

  /**
   * Dev audit (`__roboCraft.auditFaces()`, tools/e2e-holes.mjs): every face of a solid, opaque,
   * full-cube cell that borders AIR must be drawn by its chunk's current, settled form. A short ray
   * from just outside the face centre must hit one of the chunk's shells (near) or its merged mesh
   * (far). Chunks still queued or stale are reported separately — a hole there may only be a frame
   * old. Players reported "blocks with holes here and there while walking around".
   */
  auditFaces(world: VoxelWorld, limit = 40): { holes: { cell: number[]; face: number[]; far: boolean }[]; pending: number; checked: number } {
    const ray = new THREE.Raycaster(), origin = new THREE.Vector3(), dir = new THREE.Vector3();
    const holes: { cell: number[]; face: number[]; far: boolean }[] = [];
    let pending = 0, checked = 0;
    for (const [id, chunk] of this.chunks) {
      if (chunk.hidden) continue;
      if (this.queue.has(id) || chunk.stale) { pending++; continue; }
      const cx = Math.floor(id / 256) - 64, cz = (id % 256) - 64;
      const targets: THREE.Object3D[] = chunk.isFar ? (chunk.far ? [chunk.far] : []) : [...chunk.meshes.values()];
      for (let z = cz * CHUNK; z < Math.min(WORLD_Z, cz * CHUNK + CHUNK); z++) for (let x = cx * CHUNK; x < Math.min(WORLD_X, cx * CHUNK + CHUNK); x++) for (let y = 1; y < WORLD_Y - 1; y++) {
        const block = world.get(x, y, z);
        if (!world.isSolid(x, y, z) || !isFullCubeShape(world.getShape(x, y, z)) || this.seeThrough.has(block) || this.isMiningHidden(x, y, z)) continue;
        for (const face of FACES) {
          const [nx, ny, nz] = face.n, ax = x + nx, ay = y + ny, az = z + nz;
          if (ax < 0 || ax >= WORLD_X || az < 0 || az >= WORLD_Z || ay < 0 || ay >= WORLD_Y) continue;
          if (world.get(ax, ay, az) !== 0) continue; // only faces that border plain air
          checked++;
          origin.set(x + 0.5 + nx * 0.8 + 0.13 * (ny ? 1 : 0), y + 0.5 + ny * 0.8 + 0.11 * (ny ? 0 : 1), z + 0.5 + nz * 0.8 + 0.07);
          dir.set(-nx, -ny, -nz);
          ray.set(origin, dir); ray.far = 0.75;
          if (ray.intersectObjects(targets, false).length) continue;
          holes.push({ cell: [x, y, z], face: [nx, ny, nz], far: chunk.isFar });
          if (holes.length >= limit) return { holes, pending, checked };
        }
      }
    }
    return { holes, pending, checked };
  }

  setHighlight(voxel: [number, number, number] | null, mining = false, bounds?: { min: readonly number[]; max: readonly number[] }): void {
    this.highlight.show(voxel, mining, bounds);
  }

  // ------------------------------------------------------------ per frame

  /**
   * Re-evaluate LOD/studs if the focus moved, then build queued chunks
   * nearest-first within the frame budget. `eye` is the point of interest
   * (the player or the driven machine). Without it every chunk is near and
   * every stud is emitted — the old behaviour, which a fly-through wants.
   */
  update(world: VoxelWorld, eye?: THREE.Vector3): void {
    if (this.disposed) return;
    this.hasFocus = !!eye;
    if (eye && this.focus.distanceToSquared(eye) > STUD_STEP * STUD_STEP) {
      this.focus.copy(eye);
      this.studsDirty = true;
      this.queueLodChanges();
      this.applyVisibility();
    }
    // the original studs follow closely (a small ring, cheap to re-split)
    if (eye && this.studFocus.distanceToSquared(eye) > STUD_HQ_STEP * STUD_HQ_STEP) this.studsDirty = true;
    if (this.dirty) {
      this.cancelWaterBatch();
      this.dropAllStaging();
      this.dirty = false;
      for (const chunk of this.chunks.values()) chunk.stale = true;
      for (let cz = 0; cz < CHUNKS_Z; cz++) {
        for (let cx = 0; cx < CHUNKS_X; cx++) this.queue.add(chunkId(cx, cz));
      }
    }
    // A replacement and its original must swap in the same frame, even during a queued terrain rebuild.
    for(const id of this.miningPriority){this.queue.delete(id);if(this.buildChunk(world,chunkX(id),chunkZ(id)))this.studsDirty=true;}
    this.miningPriority.clear();
    // The first fill and focus-less callers build everything at once, so a
    // world never appears half-drawn on load.
    const budget = this.primed && eye ? BUILD_BUDGET_MS : Infinity;
    const start = performance.now();
    if (this.queue.size > 0) {
      const order = [...this.queue].sort((a, b) => this.distSqTo(a) - this.distSqTo(b));
      const studRange = (STUD_RANGE + CHUNK) ** 2;
      for (const id of order) {
        this.queue.delete(id);
        // only a rescanned chunk near the focus changes the stud ring
        if (this.buildChunk(world, chunkX(id), chunkZ(id)) && this.distSqTo(id) <= studRange) this.studsDirty = true;
        if (performance.now() - start > budget) break;
      }
      this.primed = true;
    }
    if (this.staged.size > 0) this.stepStaging(start, budget);
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
      chunk = { meshes: new Map(), far: null, isFar: false, stale: true, top: 0, hidden: false, studs: new Map(), water: null, waterMinY: WORLD_Y, waterMaxY: -1, backing: null, staging: null };
      this.chunks.set(id, chunk);
    }
    const far = this.wantsFar(id, chunk);
    if (chunk.staging && (chunk.stale || far)) this.dropStaging(chunk);
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
    // Walking turns far chunks near: an unchanged chunk that still shows its far form is built near
    // in budgeted steps (one chunk's meshes in one frame took up to 37 ms), then swapped.
    if (!chunk.stale && !far && chunk.isFar && chunk.far && this.primed && this.hasFocus) {
      if (!chunk.staging) this.startStaging(world, chunk, cx, cz);
      return false;
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
    if (chunk.backing) chunk.backing.visible = !chunk.isFar && !chunk.hidden;
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
  private scanChunk(world: VoxelWorld, chunk: ChunkState, cx: number, cz: number, far: boolean, rebuildWater: boolean, staged = false): { positions: Map<number, number[]>; backing: Floats } | null {
    const { cells, shapes } = world;
    const W = WORLD_X;
    const layer = WORLD_X * WORLD_Z;
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const x1 = Math.min(WORLD_X, x0 + CHUNK);
    const z1 = Math.min(WORLD_Z, z0 + CHUNK);
    const positions = new Map<number, number[]>(); // near: (id << 8 | shape) → xyz…
    const farBuffers = new Map<number, FarBuffers>(); // far: block id → faces
    const backing = new Floats(); // near: exposed cube faces, positions only
    chunk.studs.clear();
    const water: number[] = [];
    let top = 0;

    const hiddenIndex=this.miningHidden?(this.miningHidden[1]*WORLD_Z+this.miningHidden[2])*W+this.miningHidden[0]:-1;
    const opaque=(index:number)=>index!==hiddenIndex&&!this.fallingHidden.has(index)&&SOLID_ID[cells[index]!]===1&&isFullCubeShape(shapes[index]!)&&!this.seeThrough.has(cells[index]!);
    const occludes = (nx: number, ny: number, nz: number): boolean => {
      if(this.isMiningHidden(nx,ny,nz))return false;
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
      return SOLID_ID[block] === 1 && isFullCubeShape(shape) && !this.seeThrough.has(block);
    };

    // `?engine=rust`: the same walk in the Rust engine (scan.rs); TypeScript if it is off or fails
    const rustTop = this.scanRust(world, chunk, x0, z0, x1, z1, far, positions, farBuffers, backing, water);
    if (rustTop !== null) top = rustTop;
    else for (let y = 0; y < WORLD_Y; y++) {
      for (let z = z0; z < z1; z++) {
        let i = (y * WORLD_Z + z) * W + x0;
        for (let x = x0; x < x1; x++, i++) {
          if(i===hiddenIndex||this.fallingHidden.has(i))continue;
          let block = cells[i]!;
          if (SOLID_ID[block] === 0) {
            if (block !== 0) water.push(x, y, z); // water: its own mesh below
            continue;
          }
          // direct neighbour reads in the interior; the bounds-aware path
          // (which also sees the field's endless ground) only at the edges
          const interior = x > 0 && x < W - 1 && z > 0 && z < WORLD_Z - 1 && y > 0 && y < WORLD_Y - 1;
          const exposed=interior ? !opaque(i-1)||!opaque(i+1)||!opaque(i-W)||!opaque(i+W)||!opaque(i-layer)||!opaque(i+layer) : !occludes(x-1,y,z)||!occludes(x+1,y,z)||!occludes(x,y-1,z)||!occludes(x,y+1,z)||!occludes(x,y,z-1)||!occludes(x,y,z+1);
          if (!exposed) continue;
          top = y;
          const shape = shapes[i]!;
          let def = blockById(block);
          if(def&&(def.key==="grass"||def.key==="flower-grass")&&occludes(x,y+1,z)){block=2;def=blockById(block);}
          const airAbove = i+layer===hiddenIndex||this.fallingHidden.has(i+layer)||(y < WORLD_Y - 1 ? SOLID_ID[cells[i + layer]!] === 0 : !world.isSolid(x, y + 1, z));
          // studs only cap flat-topped bricks (cube/round), never a slope
          if (def && !def.noStud && (isFullCubeShape(shape) || shape === ROUND) && airAbove) {
            const studKey=(block<<1)|((shape===KIT_CUBE||shape===ROUND)?1:0);
            let studs = chunk.studs.get(studKey);
            if (!studs) chunk.studs.set(studKey, (studs = []));
            studs.push(x, y, z);
          }

          if (!far) {
            const key = (block << 8) | shape;
            let list = positions.get(key);
            if (!list) positions.set(key, (list = []));
            list.push(x, y, z);
            // the cell's exposed faces, BACKING_INSET inside the cell: the backing behind the seams
            if (isFullCubeShape(shape) && !this.seeThrough.has(block)) {
              const s = BACKING_INSET;
              for (const face of FACES) {
                const [nx, ny, nz] = face.n;
                if (occludes(x + nx, y + ny, z + nz)) continue;
                // along each edge: a convex edge (open beside) pulls in, a concave one (the
                // neighbour beside and the cell beyond it both solid) reaches out to meet the
                // other inset plane, a flat continuation stays — so the shrunk surface is closed
                const edge = (d: readonly number[]): number =>
                  !occludes(x + d[0]!, y + d[1]!, z + d[2]!) ? s : occludes(x + d[0]! + nx, y + d[1]! + ny, z + d[2]! + nz) ? -s : 0;
                const u = face.u, v = face.v;
                const u0 = edge([-u[0], -u[1], -u[2]]), u1 = edge(u), v0 = edge([-v[0], -v[1], -v[2]]), v1 = edge(v);
                for (let k = 0; k < 6; k++) {
                  const [cu, cv] = FACE_CORNERS[k]!;
                  const a = cu ? 1 - u1 : u0, b = cv ? 1 - v1 : v0;
                  backing.push3(
                    x + face.o[0] + u[0] * a + v[0] * b - nx * s,
                    y + face.o[1] + u[1] * a + v[1] * b - ny * s,
                    z + face.o[2] + u[2] * a + v[2] * b - nz * s,
                  );
                }
              }
            }
            continue;
          }

          if (isFullCubeShape(shape)) {
            for (const face of FACES) {
              const buf=this.farBuffer(farBuffers,block,face.n[1]);
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
            this.bakeShape(farBuffers,block, x, y, z, shape);
          }
        }
      }
    }
    chunk.top = top;

    if (!this.primed && typeof Worker === "undefined" && hasWaterEngine()) this.buildWater(world, chunk, water);
    else if (!this.primed || rebuildWater) this.waterQueue.set(chunkId(cx, cz), [0, WORLD_Y - 1]);
    if (far) this.buildFarMesh(chunk, farBuffers);
    else if (staged) return { positions, backing };
    else {
      this.buildNearMeshes(chunk, positions,world);
      this.buildBacking(chunk, backing);
    }
    return null;
  }

  /**
   * Construction bricks are drawn 1 cm inside their cell with chamfered edges (the toy look),
   * so two neighbours leave a 2 cm seam — and through a wall one brick thick, or where a wall
   * meets a ceiling, that seam went all the way through and showed the sky. Behind the bricks
   * sits the solid region's exact outer surface, drawn BACK faces only in the seam colour:
   * invisible from outside (its fronts are culled and the bricks cover it), but whatever you
   * see INTO a seam ends on it. One draw call per near chunk, no shadow, no ink.
   */
  private buildBacking(chunk: ChunkState, backing: Floats): void {
    if (backing.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(backing.data.slice(0, backing.length), 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.backingMaterial);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.raycast = () => {}; // a seam filler, never something to aim at
    mesh.userData.seamBacking = true;
    this.scene.add(mesh);
    chunk.backing = mesh;
  }

  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpV = new THREE.Vector3();

  /** Append a round/slope brick's cheap geometry, transformed, to a far buffer. */
  private bakeShape(buffers:Map<number,FarBuffers>,block:number, x: number, y: number, z: number, shape: number): void {
    const family = blockShapeFamily(shape);
    const geo = shape === ROUND ? this.farRound : family==="corner"?this.farCorner:family==="slab"?this.farSlab:family==="stairs"?this.farStairs:this.farSlope;
    if (isOrientedShape(shape)) brickOrientation(shapeYaw(shape), shapeTilt(shape), this.tmpQ);
    else this.tmpQ.identity();
    const p = geo.attributes.position!;
    const n = geo.attributes.normal!;
    const uv = geo.attributes.uv;
    const v = this.tmpV;
    let buf=this.farBuffer(buffers,block,0);
    for (let k = 0; k < p.count; k++) {
      if(k%3===0){v.fromBufferAttribute(n,k).applyQuaternion(this.tmpQ);buf=this.farBuffer(buffers,block,v.y);}
      v.fromBufferAttribute(p, k).applyQuaternion(this.tmpQ);
      buf.pos.push3(v.x + x + 0.5, v.y + y + 0.5, v.z + z + 0.5);
      v.fromBufferAttribute(n, k).applyQuaternion(this.tmpQ);
      buf.nrm.push3(v.x, v.y, v.z);
      buf.uv.push2(uv ? uv.getX(k) : 0, uv ? uv.getY(k) : 0);
    }
  }

  private farBuffer(buffers:Map<number,FarBuffers>,block:number,normalY:number):FarBuffers {
    const indices=this.faceMaterialIndices.get(block)!;
    const index=indices.length>1?indices[normalY>.52?0:normalY<-.52?2:1]!:indices[0]!;
    let buffer=buffers.get(index);if(!buffer){buffer={pos:new Floats(),nrm:new Floats(),uv:new Floats()};buffers.set(index,buffer);}return buffer;
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
    for (const [index, buf] of farBuffers) {
      const count = buf.pos.length / 3;
      if (count === 0) continue;
      pos.set(buf.pos.data.subarray(0, buf.pos.length), at * 3);
      nrm.set(buf.nrm.data.subarray(0, buf.nrm.length), at * 3);
      uv.set(buf.uv.data.subarray(0, buf.uv.length), at * 2);
      geometry.addGroup(at, count, index);
      if (this.materialList[index]?.transparent) glass = true;
      at += count;
    }
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    whiteVertexColors(geometry);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.materialList);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (glass) mesh.renderOrder = 2;
    this.scene.add(mesh);
    chunk.far = mesh;
  }

  /** `?engine=rust`: brick shells from the Rust engine (kit.rs, bit-identical to kitShell.ts). */
  private rustKit: RustEngine | null = null;
  useRustShells(engine: RustEngine | null): void { this.rustKit = engine; }
  get shellEngine(): "rust" | "ts" { return this.rustKit ? "rust" : "ts"; }
  get scanEngine(): "rust" | "ts" { return this.rustKit && !this.rustScanOff ? "rust" : "ts"; }

  /** A chunk's joined shell for one block: Rust when enabled, TypeScript otherwise and after any
   *  Rust failure (a trap switches this view back to TypeScript for good). */
  private shellGeometry(cells: [number, number, number][], joined: (x: number, y: number, z: number) => boolean): THREE.BufferGeometry {
    if (this.rustKit) {
      try {
        const g = kitCellsGeometryRust(this.rustKit, cells, joined);
        if (g) return g;
      } catch (err) {
        console.warn("Rust brick shells failed, continuing on TypeScript", err);
        this.rustKit = null;
      }
    }
    return kitCellsGeometry(cells, false, joined);
  }

  private buildNearMeshes(chunk: ChunkState, positions: Map<number, number[]>,world:VoxelWorld): void {
    for (const [key, list] of positions) {
      const mesh = this.buildNearMesh(key, list, world);
      if (!mesh) continue;
      this.scene.add(mesh);
      chunk.meshes.set(key, mesh);
    }
  }

  private readonly nearQ = new THREE.Quaternion();
  private readonly nearScale = new THREE.Vector3(1, 1, 1);
  private readonly nearPos = new THREE.Vector3();
  private readonly nearMatrix = new THREE.Matrix4();

  /** One near mesh of a chunk: a block's joined shell (full cubes) or its instanced shaped bricks.
   *  Not added to the scene — the caller decides when it shows. */
  private buildNearMesh(key: number, list: number[], world: VoxelWorld): THREE.InstancedMesh | null {
    const q = this.nearQ, scl = this.nearScale, pos = this.nearPos, matrix = this.nearMatrix;
    {
      const count = list.length / 3;
      const block = key >> 8;
      const shape = key & 0xff;
      const materials=this.kitMaterials.get(block);const material=materials?.length===1?materials[0]:materials;
      if (!material) return null;
      if(isFullCubeShape(shape)){
        const cells:[number,number,number][]=[];for(let i=0;i<list.length;i+=3)cells.push([list[i]!,list[i+1]!,list[i+2]!]);
        const joined=(x:number,y:number,z:number)=>!this.isMiningHidden(x,y,z)&&world.isSolid(x,y,z)&&isFullCubeShape(world.getShape(x,y,z));
        const geometry=this.shellGeometry(cells,joined);
        if(materials!.length>1)materialFaceGroups(geometry);
        const shell=new THREE.InstancedMesh(geometry,material,1);shell.setMatrixAt(0,new THREE.Matrix4());shell.instanceMatrix.needsUpdate=true;
        castsInstancedShadow(shell);shell.receiveShadow=true;if(this.seeThrough.has(block))shell.renderOrder=2;
        shell.computeBoundingSphere();this.ownedShells.add(geometry);return shell;
      }
      let geometry=this.geometryFor(shape);
      if(materials!.length>1){geometry=materialFaceGroups(geometry.clone(),isOrientedShape(shape)?brickOrientation(shapeYaw(shape),shapeTilt(shape)):undefined);this.ownedShells.add(geometry);}
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      castsInstancedShadow(mesh);
      mesh.receiveShadow = true;
      if (this.seeThrough.has(block)) mesh.renderOrder = 2;
      if (isOrientedShape(shape)) brickOrientation(shapeYaw(shape), shapeTilt(shape), q);
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
      return mesh;
    }
  }

  // ------------------------------------------------------------ the chunk scan on Rust

  private rustScanner: InstanceType<RustEngine["WasmScanner"]> | null = null;
  private rustScanOff = false;
  private readonly slabCells = new Uint8Array((CHUNK + 2) * (CHUNK + 2) * WORLD_Y);
  private readonly slabShapes = new Uint8Array(this.slabCells.length);
  private readonly slabHidden = new Uint8Array(this.slabCells.length);

  /** The view's tables for scan.rs: block flags, materials per face band, face geometry, the far
   *  templates and every shape's orientation — fixed for the view's life. */
  private makeScanner(engine: RustEngine): InstanceType<RustEngine["WasmScanner"]> {
    const solid = new Uint8Array(256), see = new Uint8Array(256), def = new Uint8Array(256), count = new Uint8Array(256), mats = new Int32Array(256 * 3);
    const full = new Uint8Array(256), family = new Uint8Array(256), quats = new Float64Array(256 * 4);
    for (let id = 0; id < 256; id++) {
      solid[id] = SOLID_ID[id] === 1 ? 1 : 0;
      see[id] = this.seeThrough.has(id) ? 1 : 0;
      const d = blockById(id);
      if (d) def[id] = 1 | (d.noStud ? 2 : 0) | (d.key === "grass" || d.key === "flower-grass" ? 4 : 0);
      const m = this.faceMaterialIndices.get(id);
      if (m) { count[id] = m.length; for (let k = 0; k < m.length; k++) mats[id * 3 + k] = m[k]!; }
      full[id] = isFullCubeShape(id) ? 1 : 0;
      const fam = blockShapeFamily(id);
      family[id] = id === ROUND ? 0 : fam === "corner" ? 1 : fam === "slab" ? 2 : fam === "stairs" ? 3 : 4;
      const q = isOrientedShape(id) ? brickOrientation(shapeYaw(id), shapeTilt(id), new THREE.Quaternion()) : new THREE.Quaternion();
      quats.set([q.x, q.y, q.z, q.w], id * 4);
    }
    const faces = new Float64Array(FACES.flatMap((fc) => [...fc.n, ...fc.u, ...fc.v, ...fc.o]));
    const sc = new engine.WasmScanner(solid, see, def, count, mats, full, family, 2, KIT_CUBE, ROUND, faces, new Float64Array(FACE_CORNERS.flat()), new Float64Array(FACE_UV), BACKING_INSET, quats, WORLD_Y);
    for (const g of [this.farRound, this.farCorner, this.farSlab, this.farStairs, this.farSlope]) {
      const uv = g.attributes.uv;
      sc.add_template(g.attributes.position!.array as Float32Array, g.attributes.normal!.array as Float32Array, uv ? new Float32Array(uv.array as Float32Array) : undefined);
    }
    return sc;
  }

  /** scanChunk's walk on Rust: fills the same containers and returns the top, or null (off, or
   *  failed — then the TypeScript walk runs). The slab is the chunk plus a one-cell ring at every
   *  height: raw blocks as `world.get` sees them (the field's ground beyond the window included),
   *  shapes (0 beyond the window) and the hidden flags. */
  private scanRust(world: VoxelWorld, chunk: ChunkState, x0: number, z0: number, x1: number, z1: number, far: boolean,
    positions: Map<number, number[]>, farBuffers: Map<number, FarBuffers>, backing: Floats, water: number[]): number | null {
    if (!this.rustKit || this.rustScanOff) return null;
    try {
      const sc = (this.rustScanner ??= this.makeScanner(this.rustKit));
      const sx0 = x0 - 1, sz0 = z0 - 1, sw = x1 - x0 + 2, sd = z1 - z0 + 2, n = sw * sd * WORLD_Y;
      const cells = this.slabCells.subarray(0, n), shapes = this.slabShapes.subarray(0, n), hidden = this.slabHidden.subarray(0, n);
      const wc = world.cells, ws = world.shapes;
      // rows inside the window are copied whole; the ring beyond it reads world.get (the field's ground)
      const ax = Math.max(sx0, 0), bx = Math.min(sx0 + sw, WORLD_X);
      for (let y = 0, i = 0; y < WORLD_Y; y++) for (let lz = 0; lz < sd; lz++, i += sw) {
        const z = sz0 + lz;
        if (z >= 0 && z < WORLD_Z && ax < bx) {
          const wi = (y * WORLD_Z + z) * WORLD_X;
          cells.set(wc.subarray(wi + ax, wi + bx), i + ax - sx0);
          shapes.set(ws.subarray(wi + ax, wi + bx), i + ax - sx0);
          for (let x = sx0; x < ax; x++) { cells[i + x - sx0] = world.get(x, y, z); shapes[i + x - sx0] = 0; }
          for (let x = bx; x < sx0 + sw; x++) { cells[i + x - sx0] = world.get(x, y, z); shapes[i + x - sx0] = 0; }
        } else for (let lx = 0; lx < sw; lx++) { cells[i + lx] = world.get(sx0 + lx, y, z); shapes[i + lx] = 0; }
      }
      // hidden: the cell being mined and the falling ones (isMiningHidden), wherever they sit in the slab
      hidden.fill(0);
      const hide = (x: number, y: number, z: number) => {
        const lx = x - sx0, lz = z - sz0;
        if (lx >= 0 && lx < sw && lz >= 0 && lz < sd && y >= 0 && y < WORLD_Y && this.isMiningHidden(x, y, z)) hidden[(y * sd + lz) * sw + lx] = 1;
      };
      if (this.miningHidden) hide(this.miningHidden[0], this.miningHidden[1], this.miningHidden[2]);
      for (const index of this.fallingHidden) hide(index % WORLD_X, Math.floor(index / (WORLD_X * WORLD_Z)), Math.floor(index / WORLD_X) % WORLD_Z);
      const out = sc.scan(cells, shapes, hidden, sx0, sz0, sw, sd, x0, z0, x1, z1, far);
      if (out[0] !== 1) return null;
      let at = 1;
      const next = () => out[at++]!;
      const ints = (len: number) => { const a = Array.from(out.subarray(at, at + len)); at += len; return a; };
      const floats = (len: number) => { const fl = new Floats(); fl.data = out.slice(at, at + len); fl.length = len; at += len; return fl; };
      const top = next();
      for (let k = next(); k > 0; k--) water.push(next());
      for (let k = next(); k > 0; k--) { const key = next(); chunk.studs.set(key, ints(next())); }
      for (let k = next(); k > 0; k--) { const key = next(); positions.set(key, ints(next())); }
      const b = floats(next());
      backing.data = b.data; backing.length = b.length;
      for (let k = next(); k > 0; k--) {
        const index = next(), verts = next();
        farBuffers.set(index, { pos: floats(verts * 3), nrm: floats(verts * 3), uv: floats(verts * 2) });
      }
      return top;
    } catch (err) {
      console.warn("Rust chunk scan failed, continuing on TypeScript", err);
      this.rustScanOff = true;
      return null;
    }
  }

  // ------------------------------------------------------------ staged near builds

  /** Chunks whose near form is being built in steps (far → near flips while walking). */
  private readonly staged = new Set<ChunkState>();

  /** Scan once now; the meshes follow in budgeted steps (stepStaging). */
  private startStaging(world: VoxelWorld, chunk: ChunkState, cx: number, cz: number): void {
    const scan = this.scanChunk(world, chunk, cx, cz, false, false, true)!;
    chunk.staging = { id: chunkId(cx, cz), world, keys: [...scan.positions.keys()], next: 0, positions: scan.positions, backing: scan.backing, built: new Map() };
    this.staged.add(chunk);
  }

  /** Build staged meshes while the frame's budget lasts; a chunk whose meshes are all ready swaps
   *  to its near form at once. Builds from the queue come first; the queue only refills when the
   *  focus moves, so staging always gets its turn. */
  private stepStaging(start: number, budget: number): void {
    for (const chunk of this.staged) {
      const st = chunk.staging!;
      // walked away again before it was ready: it stays far (the queue never sees it, it is not stale)
      if (this.wantsFar(st.id, chunk)) { this.dropStaging(chunk); continue; }
      while (st.next < st.keys.length) {
        if (performance.now() - start > budget) return;
        const key = st.keys[st.next++]!;
        const mesh = this.buildNearMesh(key, st.positions.get(key)!, st.world);
        if (mesh) st.built.set(key, mesh);
      }
      this.finishStaging(chunk);
    }
  }

  private finishStaging(chunk: ChunkState): void {
    const st = chunk.staging!;
    chunk.staging = null;
    this.staged.delete(chunk);
    this.disposeNear(chunk);
    for (const [key, mesh] of st.built) {
      this.scene.add(mesh);
      chunk.meshes.set(key, mesh);
    }
    this.buildBacking(chunk, st.backing);
    chunk.isFar = false;
    this.showForm(chunk);
    this.studsDirty = true;
  }

  /** Throw a staged build away (the chunk changed, moved, went far again or is dropped). */
  private dropStaging(chunk: ChunkState): void {
    const st = chunk.staging;
    if (!st) return;
    chunk.staging = null;
    this.staged.delete(chunk);
    for (const mesh of st.built.values()) {
      mesh.dispose();
      if (this.ownedShells.has(mesh.geometry)) { mesh.geometry.dispose(); this.ownedShells.delete(mesh.geometry); }
    }
  }

  private dropAllStaging(): void {
    for (const chunk of [...this.staged]) this.dropStaging(chunk);
  }

  private disposeNear(chunk: ChunkState): void {
    for (const mesh of chunk.meshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
      if(this.ownedShells.has(mesh.geometry))mesh.geometry.dispose();
    }
    chunk.meshes.clear();
    if (chunk.backing) {
      this.scene.remove(chunk.backing);
      chunk.backing.geometry.dispose();
      chunk.backing = null;
    }
  }

  // ------------------------------------------------------------ water

  /** One shader, three passes (waterMesh.ts): level surfaces, then the steep faces' depth, then
   *  their colour. `waterMaterial` (everything) is only the boot warm-up quad's. */
  private readonly waterMaterial = makeWaterMaterial();
  private readonly waterPasses = [makeWaterMaterial("level"), makeWaterMaterial("depth"), makeWaterMaterial("steep")] as const;
  /** `?water2=1`: the frame is built round the water (render/waterPipeline.ts). The water is then
   *  ONE mesh per chunk on WATER_LAYER, drawn by the pipeline with its own three materials. */
  private waterPipeline: WaterPipeline | null = null;
  private pipelineMaterials: THREE.Material[] = [];
  useWaterPipeline(pipeline: WaterPipeline): void {
    this.waterPipeline = pipeline;
    const front = makeWaterMaterial("front"), back = makeWaterMaterial("back"), surface = makeWaterMaterial("surface");
    this.pipelineMaterials = [front, back, surface];
    pipeline.materials = { front, back, surface };
    for (const chunk of this.chunks.values()) if (chunk.water) this.pipelineMesh(chunk.water);
  }
  private pipelineMesh(mesh: THREE.Mesh): void {
    mesh.clear(); // the three-pass children are the plain path's
    mesh.material = this.waterMaterial;
    mesh.layers.set(WATER_LAYER);
  }
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
      // with the pipeline it is a water mesh like any other: the warm-up frames draw it through the
      // front, back and surface passes, so those variants compile behind the loading screen too
      if (this.waterPipeline) quad.layers.set(WATER_LAYER);
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
      for (const child of chunk.water.children) (child as THREE.Mesh).geometry = geometry;
      // Vertices rebuilt in the new field grid must lose the old scroll offset.
      chunk.water.position.set(0, 0, 0);
      chunk.water.visible = !chunk.hidden;
      old.dispose();
      return;
    }
    // level surfaces, then (children: same place, same visibility) the steep faces' depth and colour —
    // each pass for every chunk before the next one starts
    const mesh = new THREE.Mesh(geometry, this.waterPasses[0]);
    mesh.receiveShadow = true;
    mesh.renderOrder = 3; // after glass, so glass behind water still shows
    for (let i = 1; i < 3 && !this.waterPipeline; i++) {
      const pass = new THREE.Mesh(geometry, this.waterPasses[i]);
      pass.receiveShadow = true;
      pass.renderOrder = 3 + i * 0.2;
      mesh.add(pass);
    }
    if (this.waterPipeline) this.pipelineMesh(mesh);
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
    this.dropStaging(chunk);
    this.disposeNear(chunk);
    this.disposeFar(chunk);
    this.disposeWater(chunk);
    chunk.studs.clear();
  }

  // ------------------------------------------------------------ studs

  /**
   * The Blender studs (blockStuds.ts): one 2×2 stud mesh per open top. Tops within
   * STUD_HQ_DISTANCE (+ the re-evaluation step, so never less) of the focus get the original
   * Stud_HQ, the rest out to STUD_RANGE the light Stud_LOD1. Chunks wholly out of range are
   * skipped without walking their cells.
   */
  private rebuildStuds(eye?: THREE.Vector3): void {
    this.studsDirty = false;
    if (eye) this.studFocus.copy(eye);
    const range = STUD_RANGE * STUD_RANGE;
    const hqRange = (STUD_HQ_DISTANCE + STUD_HQ_STEP) ** 2;
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
    // a top's form: 0 = Stud_HQ, 1 = Stud_LOD1, -1 = out of range (no focus: every top, original)
    const formOf = (list: number[], i: number): number => (!eye ? 0 : this.withinRange(list, i, eye, hqRange) ? 0 : this.withinRange(list, i, eye, range) ? 1 : -1);
    for (const def of BLOCKS) for (const style of [0, 1]) for (const form of [0, 1]) {
      const key = (((def.id << 1) | style) << 1) | form;
      const bucket = near.get((def.id << 1) | style) ?? [];
      // Count what is actually in range before touching the GPU buffer.
      let count = 0;
      for (const list of bucket) {
        for (let i = 0; i < list.length; i += 3) if (formOf(list, i) === form) count++;
      }
      let mesh = this.studMeshes.get(key);
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
        const material = this.kitMaterials.get(def.id)?.[0];
        if (!material) continue;
        const capacity = Math.max(256, Math.ceil(count * 1.25));
        mesh = new THREE.InstancedMesh(form === 0 ? this.studs.hq : this.studs.lod, material, capacity);
        // 4 cm caps on terrain: their shadows are invisible but doubled the shadow pass
        mesh.castShadow = false;
        if(style===1)castsInstancedShadow(mesh);
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.studMeshes.set(key, mesh);
      }
      let k = 0;
      for (const list of bucket) {
        for (let i = 0; i < list.length; i += 3) {
          if (formOf(list, i) !== form) continue;
          matrix.makeTranslation(list[i]! + 0.5, list[i + 1]! + 1, list[i + 2]! + 0.5);
          mesh.setMatrixAt(k++, matrix);
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
    if (this.disposed) return;
    this.disposed = true;
    this.dropAllStaging();
    this.cancelWaterBatch();
    this.waterQueue.clear();
    this.waterWorker?.terminate(); this.waterWorker = null;
    for (const chunk of this.chunks.values()) this.dropChunk(chunk);
    this.chunks.clear(); this.queue.clear(); this.waterSnapshot = null; this.waterProfile = null;
    this.setWarm(false);
    this.waterMaterial.dispose();
    for (const material of [...this.waterPasses, ...this.pipelineMaterials]) material.dispose();
    for (const mesh of this.studMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.studMeshes.clear();
    this.studs.hq.dispose();this.studs.lod.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.kitMaterials.clear();this.blockSurfaces.dispose();for(const map of this.clonedBlockTextures)map.dispose();this.clonedBlockTextures.clear();
    for (const material of this.materialList) material.dispose(); // the merged twins
    this.materials.clear(); this.materialList.length = 0;
    this.scene.remove(this.highlight.object);
    this.highlight.dispose();
    this.kitCubeGeo.dispose();this.kitSlopeGeo.dispose();this.cornerGeo.dispose();this.farCorner.dispose();
    this.slabGeo.dispose();this.stairsGeo.dispose();this.farSlab.dispose();this.farStairs.dispose();
    this.cubeGeo.dispose();
    this.roundGeo.dispose();
    this.slopeGeo.dispose();
    this.farRound.dispose();
    this.farSlope.dispose();
  }
}

