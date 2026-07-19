import * as THREE from "three";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu } from "../render/textures.js";
import { CharacterRig } from "../player/rig.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { PerfMonitor } from "../ui/perf.js";
import { AIR, blockById, blockByKey, dropOf } from "./blocks.js";
import {
  CRAFT_RECIPES,
  HOTBAR,
  addItem,
  countOf,
  craftRecipe,
  removeItem,
  type CraftRecipe,
} from "./inventory.js";
import { clearCraftSave, loadCraft, saveCraft } from "./craftSave.js";
import { stepBody, overlapsVoxel, unstick, wishFromInput, type Body } from "./voxelBody.js";
import { WORLD_X, WORLD_Z, surfaceY } from "./voxelWorld.js";
import { PIECES, pieceCells } from "./pieces.js";
import { CUBE, ROUND, slopeShape } from "./shapes.js";
import {
  brickOrientation,
  cubeBrickGeometry,
  roundBrickGeometry,
  slopeBrickGeometry,
} from "./brickGeometry.js";
import { VoxelView } from "./voxelView.js";
import { CraftCamera } from "./craftCamera.js";
import { CraftHud } from "./craftHud.js";

const DEFAULT_SEED = 20260718;
const SAVE_INTERVAL_MS = 5000;
const REACH = 6;
const EYE_HEIGHT = 1.55;

/**
 * Craft mode — a small voxel island you actually PLAY: mine blocks, craft
 * them into new ones, build whatever you like. Third-person robot, pointer
 * lock aim, grid physics (no rapier). Composition root only; every rule
 * lives in the pure craft/* modules.
 */
export class CraftGame {
  private readonly renderer: GameRenderer;
  private readonly view: VoxelView;
  private readonly hud: CraftHud;
  private readonly sfx = new Sfx();
  private readonly bgm = new Bgm(BGM_PLAYLIST);
  private readonly perf = new PerfMonitor(document.body);
  private readonly rig = new CharacterRig();
  private readonly loop: GameLoop;
  private readonly state;
  private readonly body: Body;

  private yaw = 0;
  private pitch = -0.25;
  private readonly keys = new Set<string>();
  private mining = false;
  private placing = false;
  private miningTarget: [number, number, number] | null = null;
  private miningProgress = 0;
  private miningFrac: number | null = null;
  private selected = 0;
  private pieceIndex = 0;
  private pieceRot = 0;
  private pieceTilt = 0;
  private readonly ghost = new THREE.Group();
  private readonly ghostMeshes: THREE.Mesh[] = [];
  private ghostOk!: THREE.MeshBasicMaterial;
  private ghostBad!: THREE.MeshBasicMaterial;
  private ghostCubeGeo!: THREE.BufferGeometry;
  private ghostRoundGeo!: THREE.BufferGeometry;
  private ghostSlopeGeo!: THREE.BufferGeometry;
  private readonly ghostQuat = new THREE.Quaternion();
  private locked = false;
  private readonly camera;
  private robotMaterials: THREE.Material[] | null = null;
  private robotOpacity = 1;
  private prevVy = 0;
  private lastSaveAt = 0;
  private aim: { voxel: [number, number, number]; before: [number, number, number] } | null = null;

  constructor(mount: HTMLElement) {
    this.renderer = new GameRenderer(mount);
    this.camera = new CraftCamera(this.renderer.camera);
    this.view = new VoxelView(this.renderer.scene);
    this.hud = new CraftHud(document.body, (recipe) => this.handleCraft(recipe));

    if (new URLSearchParams(location.search).has("reset")) clearCraftSave(localStorage);
    this.state = loadCraft(localStorage, DEFAULT_SEED);
    this.body = { ...this.state.player, vx: 0, vy: 0, vz: 0, grounded: false };
    unstick(this.state.world, this.body); // never spawn embedded in a block
    this.renderer.scene.add(this.rig.root);
    this.view.markDirty();
    this.buildGhost();

    this.bindInput(mount);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.persist();
    });

    this.loop = new GameLoop({
      fixedUpdate: () => this.fixedUpdate(),
      render: (_alpha, frameDt) => this.render(frameDt),
    });
    if (import.meta.env.DEV) this.installDebugHooks();
  }

  start(): void {
    this.loop.start();
    void texturesReady().then(() => {
      warmupGpu(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
    });
  }

  // ---------------------------------------------------------------- input

  private bindInput(mount: HTMLElement): void {
    mount.addEventListener("click", () => {
      if (!this.locked && !this.hud.recipesOpen) {
        void mount.querySelector("canvas")?.requestPointerLock();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement !== null;
      this.hud.setPointerLocked(this.locked);
      if (!this.locked) {
        this.mining = false;
        this.placing = false;
      }
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      // clamp the per-event delta: pointer lock occasionally emits a huge
      // spurious movementX/Y (browser/OS spike) that whips the camera around
      const dx = Math.max(-180, Math.min(180, e.movementX));
      const dy = Math.max(-180, Math.min(180, e.movementY));
      this.yaw -= dx * 0.0026;
      this.pitch = Math.min(1.35, Math.max(-1.25, this.pitch - dy * 0.0026));
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.mining = true;
      if (e.button === 2) this.placing = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mining = false;
      if (e.button === 2) this.placing = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("wheel", (e) => {
      if (!this.locked) return;
      this.selected = (this.selected + (e.deltaY > 0 ? 1 : HOTBAR.length - 1)) % HOTBAR.length;
    });
    document.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      this.keys.add(e.code);
      if (key >= "1" && key <= "9") this.selected = Number(key) - 1;
      if (key === "c") {
        this.hud.toggleRecipes();
        if (this.hud.recipesOpen) document.exitPointerLock();
      }
      if (key === "v") this.camera.toggleView();
      if (key === "r") this.pieceRot = (this.pieceRot + 1) % 4; // spin (yaw)
      if (key === "t") this.pieceTilt = (this.pieceTilt + 1) % 4; // tip sideways (tilt)
      if (key === "f") {
        this.pieceIndex = (this.pieceIndex + 1) % PIECES.length;
        this.pieceRot = 0;
        this.pieceTilt = 0;
      }
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  // ---------------------------------------------------------------- sim

  private fixedUpdate(): void {
    const dt = 1 / 60;
    let fwd = 0;
    let strafe = 0;
    if (this.locked) {
      if (this.keys.has("KeyW")) fwd += 1;
      if (this.keys.has("KeyS")) fwd -= 1;
      if (this.keys.has("KeyA")) strafe -= 1;
      if (this.keys.has("KeyD")) strafe += 1;
    }
    const [wishX, wishZ] = wishFromInput(this.yaw, fwd, strafe);
    this.prevVy = this.body.vy;
    stepBody(this.state.world, this.body, dt, wishX, wishZ, this.locked && this.keys.has("Space"));
    // hard landings thump the camera a little
    if (this.body.grounded && this.prevVy < -11) {
      this.camera.addShake(Math.min(0.11, -this.prevVy * 0.006));
    }

    // fell off the island → respawn on the open grass south of the castle
    // (never the castle centre), lifted clear of any block
    if (this.body.y < -12) {
      this.body.x = WORLD_X / 2 + 0.5;
      this.body.z = WORLD_Z / 2 + 22.5;
      this.body.y = surfaceY(this.state.world, Math.floor(this.body.x), Math.floor(this.body.z)) + 1;
      this.body.vx = this.body.vz = this.body.vy = 0;
      unstick(this.state.world, this.body);
      this.sfx.play("oof");
    }

    this.updateAim();
    if (this.mining) this.stepMining(dt);
    else {
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
    }
    if (this.placing) {
      this.tryPlace();
      this.placing = false; // one block per press
    }

    if (Date.now() - this.lastSaveAt > SAVE_INTERVAL_MS) this.persist();
  }

  private updateAim(): void {
    const eyeY = this.body.y + EYE_HEIGHT;
    const dx = Math.sin(this.yaw) * Math.cos(this.pitch);
    const dy = Math.sin(this.pitch);
    const dz = Math.cos(this.yaw) * Math.cos(this.pitch);
    this.aim = this.state.world.raycast(this.body.x, eyeY, this.body.z, dx, dy, dz, REACH);
  }

  private stepMining(dt: number): void {
    if (!this.aim) {
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      return;
    }
    const [x, y, z] = this.aim.voxel;
    const def = blockById(this.state.world.get(x, y, z));
    if (!def || def.hardness <= 0) {
      this.miningFrac = null; // bedrock: unbreakable
      return;
    }
    const t = this.miningTarget;
    if (!t || t[0] !== x || t[1] !== y || t[2] !== z) {
      this.miningTarget = [x, y, z];
      this.miningProgress = 0;
    }
    this.miningProgress += dt;
    this.miningFrac = this.miningProgress / def.hardness;
    if (this.miningProgress >= def.hardness) {
      this.state.world.set(x, y, z, AIR);
      addItem(this.state.inventory, dropOf(def));
      this.view.markDirty();
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      this.sfx.play("crumble");
      this.camera.addShake(0.04);
    }
  }

  /**
   * Stamp the selected LEGO piece at the aim cell: every footprint cell must be
   * free, in-bounds and clear of the player, and you need one block per cell —
   * it's all-or-nothing so a piece never lands half-placed.
   */
  private tryPlace(): void {
    if (!this.aim) return;
    if (this.stampPiece(this.aim.before, HOTBAR[this.selected]!)) this.sfx.play("land");
  }

  /** Try to place the active piece with anchor at `before`; true if it landed. */
  private stampPiece(before: [number, number, number], key: string): boolean {
    const [ax, ay, az] = before;
    const piece = PIECES[this.pieceIndex]!;
    const cells = pieceCells(piece, this.pieceRot, this.pieceTilt);
    const shape =
      piece.shape === "round"
        ? ROUND
        : piece.shape === "slope"
          ? slopeShape(this.pieceRot, this.pieceTilt)
          : CUBE;
    const targets: [number, number, number][] = [];
    for (const [dx, dy, dz] of cells) {
      const x = ax + dx;
      const y = ay + dy;
      const z = az + dz;
      if (!this.state.world.inBounds(x, y, z)) return false;
      if (this.state.world.get(x, y, z) !== AIR) return false;
      if (overlapsVoxel(this.body, x, y, z)) return false; // never bury yourself
      targets.push([x, y, z]);
    }
    if (countOf(this.state.inventory, key) < targets.length) return false;
    const id = blockByKey(key)!.id;
    for (const [x, y, z] of targets) {
      removeItem(this.state.inventory, key);
      this.state.world.setShaped(x, y, z, id, shape);
    }
    this.view.markDirty();
    return true;
  }

  // ---------------------------------------------------------------- ghost

  /**
   * A pooled translucent preview that mirrors the ACTUAL piece — real cube/
   * round/slope geometry, oriented by yaw+tilt — so what you see is what lands
   * (green = fits, red = blocked).
   */
  private buildGhost(): void {
    this.ghostCubeGeo = cubeBrickGeometry();
    this.ghostRoundGeo = roundBrickGeometry();
    this.ghostSlopeGeo = slopeBrickGeometry();
    this.ghostOk = new THREE.MeshBasicMaterial({ color: 0x8ce87a, transparent: true, opacity: 0.34, depthWrite: false });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: 0xe8695b, transparent: true, opacity: 0.34, depthWrite: false });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(this.ghostCubeGeo, this.ghostOk);
      m.visible = false;
      this.ghost.add(m);
      this.ghostMeshes.push(m);
    }
    this.renderer.scene.add(this.ghost);
  }

  private updateGhost(): void {
    if (!this.locked || !this.aim || this.mining) {
      for (const m of this.ghostMeshes) m.visible = false;
      return;
    }
    const piece = PIECES[this.pieceIndex]!;
    const geo =
      piece.shape === "round"
        ? this.ghostRoundGeo
        : piece.shape === "slope"
          ? this.ghostSlopeGeo
          : this.ghostCubeGeo;
    if (piece.shape === "slope") brickOrientation(this.pieceRot, this.pieceTilt, this.ghostQuat);
    else this.ghostQuat.identity();
    const cells = pieceCells(piece, this.pieceRot, this.pieceTilt);
    const [ax, ay, az] = this.aim.before;
    for (let i = 0; i < this.ghostMeshes.length; i++) {
      const m = this.ghostMeshes[i]!;
      const c = cells[i];
      if (!c) {
        m.visible = false;
        continue;
      }
      const x = ax + c[0];
      const y = ay + c[1];
      const z = az + c[2];
      const ok = this.state.world.inBounds(x, y, z) && this.state.world.get(x, y, z) === AIR;
      m.visible = true;
      m.geometry = geo;
      m.material = ok ? this.ghostOk : this.ghostBad;
      m.quaternion.copy(this.ghostQuat);
      m.position.set(x + 0.5, y + 0.5, z + 0.5);
    }
  }

  private handleCraft(recipe: CraftRecipe): void {
    if (!craftRecipe(this.state.inventory, recipe)) return;
    this.sfx.play("checkpoint");
    this.hud.toast(`🛠️ Crafted ${recipe.name}!`);
  }

  private persist(): void {
    this.lastSaveAt = Date.now();
    this.state.player = { x: this.body.x, y: this.body.y, z: this.body.z };
    saveCraft(this.state, localStorage, Date.now());
  }

  /**
   * Smooth robot fade near the camera. Materials are CLONED once (the GLTF
   * shares materials across every rig clone — mutating the shared ones would
   * fade other modes' robots too).
   */
  private applyRobotOpacity(target: number, dt: number): void {
    if (!this.robotMaterials) {
      const collected: THREE.Material[] = [];
      this.rig.root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const cloned = (o.material as THREE.Material).clone();
          cloned.transparent = true;
          o.material = cloned;
          collected.push(cloned);
        }
      });
      if (collected.length === 0) return; // model still loading
      this.robotMaterials = collected;
    }
    this.robotOpacity += (target - this.robotOpacity) * (1 - Math.pow(0.001, dt));
    const opacity = Math.min(1, Math.max(0, this.robotOpacity));
    this.rig.root.visible = opacity > 0.03;
    for (const material of this.robotMaterials) material.opacity = opacity;
  }

  /**
   * Ease the camera's eye height toward the body's so landings and terrain
   * steps read smoothly instead of snapping. Big gaps (long falls, respawns,
   * teleports) snap instantly so the view never trails the body.
   */
  private smoothEyeY = Number.NaN;
  private smoothedEyeY(dt: number): number {
    const target = this.body.y + EYE_HEIGHT;
    if (!Number.isFinite(this.smoothEyeY) || Math.abs(target - this.smoothEyeY) > 1.6) {
      this.smoothEyeY = target;
    } else {
      this.smoothEyeY += (target - this.smoothEyeY) * (1 - Math.pow(1e-9, dt));
    }
    return this.smoothEyeY;
  }

  // ---------------------------------------------------------------- render

  private render(frameDt: number): void {
    this.view.update(this.state.world);
    this.view.setHighlight(this.aim ? this.aim.voxel : null);

    this.rig.root.position.set(this.body.x, this.body.y, this.body.z);
    this.rig.root.rotation.y = this.yaw;
    const planar = Math.hypot(this.body.vx, this.body.vz);
    const anim = !this.body.grounded ? "jump" : planar > 0.5 ? "run" : "idle";
    this.rig.update(anim, planar, frameDt);

    const eye = this.tmpEye.set(this.body.x, this.smoothedEyeY(frameDt), this.body.z);
    const robotOpacity = this.camera.update(
      this.state.world,
      eye,
      this.yaw,
      this.pitch,
      planar > 0.5,
      frameDt,
    );
    this.applyRobotOpacity(robotOpacity, frameDt);
    this.renderer.trackTarget(eye);

    this.updateGhost();
    this.hud.update(this.state.inventory, this.selected);
    this.hud.setMineProgress(this.miningFrac);
    this.hud.setPiece(PIECES[this.pieceIndex]!.name, this.pieceRot, this.pieceTilt);
    this.renderer.render();
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private readonly tmpEye = new THREE.Vector3();

  // ---------------------------------------------------------------- debug

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__roboCraft = {
      snapshot: () => ({
        pos: [this.body.x, this.body.y, this.body.z],
        grounded: this.body.grounded,
        seed: this.state.seed,
        selected: this.selected,
        inventory: { ...this.state.inventory },
      }),
      give: (key: string, n = 1) => addItem(this.state.inventory, key, n),
      teleport: (x: number, y: number, z: number) => {
        this.body.x = x;
        this.body.y = y;
        this.body.z = z;
        this.body.vy = 0;
      },
      blockAt: (x: number, y: number, z: number) => this.state.world.get(x, y, z),
      mineAt: (x: number, y: number, z: number) => {
        const def = blockById(this.state.world.get(x, y, z));
        if (!def || def.hardness <= 0) return false;
        this.state.world.set(x, y, z, AIR);
        addItem(this.state.inventory, dropOf(def));
        this.view.markDirty();
        return true;
      },
      placeAt: (x: number, y: number, z: number, key: string) => {
        const def = blockByKey(key);
        if (!def || this.state.world.get(x, y, z) !== AIR) return false;
        this.state.world.set(x, y, z, def.id);
        this.view.markDirty();
        return true;
      },
      craft: (id: string) => {
        const recipe = CRAFT_RECIPES.find((r) => r.id === id);
        return recipe ? craftRecipe(this.state.inventory, recipe) : false;
      },
      setPieceShape: (i: number, rot = 0, tilt = 0) => {
        this.pieceIndex = ((i % PIECES.length) + PIECES.length) % PIECES.length;
        this.pieceRot = ((rot % 4) + 4) % 4;
        this.pieceTilt = ((tilt % 4) + 4) % 4;
      },
      placePiece: (x: number, y: number, z: number, key: string) => this.stampPiece([x, y, z], key),
      pieces: () => PIECES.map((p) => p.key),
      look: (yaw: number, pitch?: number) => {
        this.yaw = yaw;
        if (pitch !== undefined) this.pitch = pitch;
      },
      saveNow: () => this.persist(),
      perf: () => this.perf.sample(),
    };
  }
}
