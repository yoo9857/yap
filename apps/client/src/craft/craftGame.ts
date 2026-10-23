import * as THREE from "three";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu, warmupGpuAsync } from "../render/textures.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { PerfMonitor } from "../ui/perf.js";
import { AIR, SOLID_ID, blockById, blockByKey, dropOf, textureUrl } from "./blocks.js";
import { loadTexture } from "../render/textures.js";
import {
  CRAFT_RECIPES,
  HOTBAR,
  addItem,
  countOf,
  craftRecipe,
  removeItem,
  type CraftRecipe,
} from "./inventory.js";
import { clearCraftSave, loadCraft, saveCraft, type CraftGameState } from "./craftSave.js";
import { FIELD_MAX_VIEW, FieldWindow, clearFieldSave, fieldStarterInventory } from "./fieldWorld.js";
import { SkyDome } from "./skyDome.js";
import { ClassSync } from "./classSync.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { SWIM_DEPTH, pointInWater, stepBody, overlapsVoxel, unstick, wishFromInput, type Body } from "./voxelBody.js";
import { WaterSim } from "./waterSim.js";
import { WATER, WATER_SETTLED, isWater } from "@robo/shared";
import { CRAFT_SPAWN, surfaceY, type RayHit } from "./voxelWorld.js";
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
import { MachineWorkshop } from "./machines/workshop.js";
import { PetCompanion } from "./petCompanion.js";
import { PetShop } from "./petShop.js";
import { SPECIES, isPetSpecies, type PetSpecies } from "../player/creatureRig.js";
import { withObjectParticle } from "./korean.js";
import { approach, easeAngle, interpolate, turnToward } from "./smoothing.js";
import { FurnitureLayout } from "./furniture/layout.js";
import { FurnitureController, PICKUP_TIME } from "./furniture/controller.js";
import type { PlacedFurniture } from "./furniture/types.js";

const DEFAULT_SEED = 20260718;
const SAVE_INTERVAL_MS = 5000;
const REACH = 6;
const EYE_HEIGHT = 1.55;
/** The field's far-ground plane: a hair under the top of bedrock (cell y 0). */
const FIELD_GROUND_Y = 1 - 0.03;
/** Horizon colour: fog and the sky dome's lower band share it. */
const FOG_COLOR = 0x9fd8f5;
/** Murky blue the fog turns while the camera is underwater. */
const UNDERWATER_FOG = 0x1d5f9e;
const SKY_TOP = 0x6fbfee;
/** Render distance presets (metres), cycled with O. The island is 160 m
 *  across, so its far preset shows nearly all of it; the field's window can
 *  only back FIELD_MAX_VIEW. */
const VIEW_PRESETS = { island: [56, 88, 130], field: [40, 56, FIELD_MAX_VIEW] } as const;
const VIEW_NAMES = ["Short", "Normal", "Far"];
/** After placing (or while mining) the body faces the crosshair this long (s). */
const ACTION_FACE_TIME = 0.6;
const VIEW_KEY = "craftyap-view-distance";

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
  private readonly pet: PetCompanion;
  private readonly petShop: PetShop;
  private readonly furniture: FurnitureController;
  /** Furniture under the crosshair (nearer than the block the ray hit). */
  private aimFurniture: PlacedFurniture | null = null;
  /** The piece a held left click is putting away. */
  private pickupTarget: PlacedFurniture | null = null;
  private readonly loop: GameLoop;
  private readonly workshop: MachineWorkshop;
  private readonly state: CraftGameState;
  /** Education mode's endless flat field; null on the island. */
  private readonly field: FieldWindow | null;
  private fieldGround: THREE.Mesh | null = null;
  private readonly body: Body;

  // The outer-south spawn looks north toward the academy on first load.
  private yaw = Math.PI;
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
  private aim: RayHit | null = null;

  constructor(
    mount: HTMLElement,
    opts: { field?: boolean; classroom?: { client: ClassClient; session: ClassSession } } = {},
  ) {
    this.renderer = new GameRenderer(mount);
    this.renderer.scene.fog = new THREE.Fog(FOG_COLOR, 95, 245);
    this.sky = new SkyDome(this.renderer.scene, SKY_TOP, FOG_COLOR);
    this.camera = new CraftCamera(this.renderer.camera);
    this.view = new VoxelView(this.renderer.scene);
    this.hud = new CraftHud(document.body, (recipe) => this.handleCraft(recipe), { furniture: true });

    const reset = new URLSearchParams(location.search).has("reset");
    if (opts.classroom) {
      // a class field belongs to the server: no local save is read or written
      this.field = new FieldWindow();
      const spawn = this.field.spawn;
      this.state = {
        seed: 0,
        world: this.field.world,
        inventory: fieldStarterInventory(),
        // spread arrivals out so a whole class doesn't land in one cell
        player: { x: spawn.x + (Math.random() - 0.5) * 8, y: spawn.y, z: spawn.z + (Math.random() - 0.5) * 8 },
        pet: "dog",
        furniture: new FurnitureLayout(),
      };
      this.buildFieldGround();
    } else if (opts.field) {
      if (reset) clearFieldSave(localStorage);
      this.field = new FieldWindow();
      const saved = this.field.load(localStorage);
      this.state = {
        seed: 0,
        world: this.field.world,
        inventory: saved?.inventory ?? fieldStarterInventory(),
        player: saved?.player ?? this.field.spawn,
        pet: isPetSpecies(saved?.pet) ? saved.pet : "dog",
        furniture: new FurnitureLayout(),
      };
      this.state.furniture.load(saved?.furniture);
      this.buildFieldGround();
    } else {
      if (reset) clearCraftSave(localStorage);
      this.field = null;
      this.state = loadCraft(localStorage, DEFAULT_SEED);
    }
    // Before the first unstick: the player must not spawn inside a sofa. The
    // host reads the game's fields lazily, since some are built further down.
    this.furniture = new FurnitureController({
      scene: this.renderer.scene,
      world: this.state.world,
      layout: this.state.furniture,
      originX: () => this.field?.absOriginX ?? 0,
      originZ: () => this.field?.absOriginZ ?? 0,
      player: () => this.body,
      pet: () => this.pet.body,
      hud: this.hud,
      sfx: this.sfx,
      canBuild: () => this.canBuild(),
      changed: (placed, removed) => {
        for (const [kind, x, y, z, rot] of [...placed, ...removed])
          for (const [ax, ay, az] of this.state.furniture.cellsOf({ kind, x, y, z, rot }))
            this.water?.touch(ax - (this.field?.absOriginX ?? 0), ay, az - (this.field?.absOriginZ ?? 0));
        if (!opts.classroom) return;
        this.sync?.flushEdits();
        opts.classroom.client.send({ t: "k-furniture", placed, removed });
      },
      resumePlay: () => this.resumePlay(),
      closeOtherPanels: () => {
        this.petShop.setOpen(false);
        this.hud.hideRecipes();
      },
    }, true);
    this.body = { ...this.state.player, vx: 0, vy: 0, vz: 0, grounded: false };
    unstick(this.state.world, this.body); // never spawn embedded in a block
    this.renderer.scene.add(this.rig.root);
    this.pet = new PetCompanion(
      this.renderer.scene,
      this.state.world,
      { x: this.body.x + 1.2, y: this.body.y, z: this.body.z + 1.2 },
      this.state.pet,
    );
    this.petShop = new PetShop(document.body, this.state.pet, (species) => this.adoptPet(species),
      () => this.furniture.closePanel());
    this.view.markDirty();
    this.applyViewDistance(this.loadViewPreset());
    this.buildGhost();
    if (opts.classroom && this.field) {
      this.sync = new ClassSync(opts.classroom.client, opts.classroom.session, this.field, this.view,
        this.renderer.scene, {
          teleport: (x, y, z) => {
            this.body.x = x;
            this.body.y = y;
            this.body.z = z;
            this.body.vx = this.body.vy = this.body.vz = 0;
            unstick(this.state.world, this.body);
          },
          toast: (text) => this.hud.toast(text),
          clearKeys: () => {
            this.keys.clear();
            this.mining = this.placing = false;
          },
        }, this.state.furniture);
      unstick(this.state.world, this.body);
      this.view.markDirty(); // the class's field replaced the empty one
    }

    this.workshop = new MachineWorkshop(this.renderer.scene, this.renderer.camera,
      this.renderer.renderer.domElement, this.state.world, (active) => {
        this.keys.clear(); this.mining = this.placing = false;
        this.miningFrac = null; this.miningProgress = 0; this.miningTarget = null;
        this.hud.setWorkshopOpen(active);
        if (!active) this.renderer.camera.clearViewOffset();
      });

    this.bindInput(mount);
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.persist();
    });

    // solo play runs the water itself; a classroom's water is the server's
    this.water = this.sync ? null : new WaterSim(this.state.world, this.view, this.field);
    this.water?.wakeAll();
    this.underwaterTint.className = "craft-underwater";
    document.body.appendChild(this.underwaterTint);

    this.loop = new GameLoop({
      fixedUpdate: () => this.fixedUpdate(),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
    if (import.meta.env.DEV) this.installDebugHooks();
  }

  /** Solo play's flowing water (null in a classroom — the server flows it). */
  private readonly water: WaterSim | null;
  /** Blue wash over the screen while the camera is underwater. */
  private readonly underwaterTint = document.createElement("div");
  private underwater = false;
  /** How wet the body was last tick — a dry → wet change with speed splashes. */
  private lastWet = 0;

  /** Is the selected hotbar slot the water bucket? */
  private holdingWater(): boolean {
    return blockByKey(HOTBAR[this.selected]!)?.fluid === true;
  }

  /**
   * Everything slow, done behind the boot overlay before the first playable
   * frame: textures, every shader (in parallel where the browser can), and two
   * real frames through the whole pipeline. See `warmupGpuAsync`.
   */
  async prepare(setMessage: (text: string) => void = () => {}): Promise<void> {
    setMessage("Loading textures…");
    await texturesReady();
    setMessage("Preparing graphics…");
    this.furniture.setWarm(true);
    this.view.setWarm(true); // the water shader, too
    this.warming = true;
    await warmupGpuAsync(this.renderer.renderer, this.renderer.scene, this.renderer.camera, () => this.render(1, 1 / 60));
    this.warming = false;
    this.furniture.setWarm(false);
    this.view.setWarm(false);
    this.warmed = true;
    this.facing = this.yaw; // start facing the way the camera looks
  }

  start(): void {
    this.loop.start();
    // started without `prepare` (a test harness): warm up the old way
    if (!this.warmed) {
      void texturesReady().then(() => {
        warmupGpu(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
      });
    }
  }

  private warmed = false;
  /** True only while `prepare` draws its warm-up frames. */
  private warming = false;

  /** Release the WebGL/audio-facing resources when the mode is replaced. */
  dispose(): void {
    this.loop.stop();
    this.persist();
    this.underwaterTint.remove();
    this.workshop.dispose();
    this.view.dispose();
    this.sky.dispose();
    this.sync?.dispose();
    if (this.fieldGround) {
      this.renderer.scene.remove(this.fieldGround);
      this.fieldGround.geometry.dispose();
      const material = this.fieldGround.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.dispose();
    }
    disposeRig(this.rig.root);
    this.pet.dispose();
    this.petShop.dispose();
    this.furniture.dispose();
    this.bgm.dispose();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- input

  private bindInput(mount: HTMLElement): void {
    mount.addEventListener("click", () => {
      if (!this.locked && !this.hud.recipesOpen && !this.workshop.active) {
        void Promise.resolve(mount.querySelector("canvas")?.requestPointerLock()).catch(() => {}); // refused during the browser's re-lock cooldown: the next click retries
      }
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement !== null;
      this.hud.setPointerLocked(this.locked);
      if (this.locked) {
        // back in play: a panel left open would sit over the view, unusable
        this.furniture.closePanel();
        this.petShop.setOpen(false);
      }
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
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll cursor
        if (this.aimFurniture) this.furniture.pickKind(this.aimFurniture);
      }
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mining = false;
      if (e.button === 2) this.placing = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("wheel", (e) => {
      if (!this.locked) return;
      if (this.furniture.handleWheel(e.deltaY > 0)) return;
      this.selected = (this.selected + (e.deltaY > 0 ? 1 : HOTBAR.length - 1)) % HOTBAR.length;
    });
    document.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === "b" && !e.repeat) { this.workshop.toggle(); return; }
      if (this.workshop.active) return;
      this.keys.add(e.code);
      // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) undo and redo furniture work
      if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
        e.preventDefault();
        if (key === "y" || e.shiftKey) this.furniture.redo();
        else this.furniture.undo();
        return;
      }
      // furniture's keys first: in furniture mode 1-9, Q/E, X and R are its own
      if (this.furniture.handleKey(key, e.repeat)) return;
      if (key >= "1" && key <= "9") this.selected = Number(key) - 1;
      if (key === "0" && HOTBAR.length > 9) this.selected = 9;
      if (key === "c") {
        this.hud.toggleRecipes();
        if (this.hud.recipesOpen) document.exitPointerLock();
      }
      if (key === "v") this.camera.toggleView();
      if (key === "p" && !e.repeat) {
        this.hud.toast(this.pet.toggleMode() === "stay" ? "🐶 Buddy: stay" : "🐶 Buddy: follow");
      }
      if (key === "o") {
        const next = (this.viewPreset + 1) % VIEW_NAMES.length;
        this.applyViewDistance(next);
        try {
          localStorage.setItem(VIEW_KEY, String(next));
        } catch {
          /* remembered for this session only */
        }
        this.hud.toast(`👁️ View distance: ${VIEW_NAMES[next]} (${this.viewPresets[next]} m)`);
      }
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
    // where the body was before this tick: render() blends prev → current
    this.prevBody.set(this.body.x, this.body.y, this.body.z);
    if (this.sync) {
      const planar = Math.hypot(this.body.vx, this.body.vz);
      this.sync.tick(1 / 60, this.body, this.facing, !this.body.grounded ? "jump" : planar > 0.5 ? "run" : "idle");
    }
    if (this.workshop.active) { this.workshop.fixedUpdate(); return; }
    const dt = 1 / 60;
    if (this.seated && this.stepSeated()) {
      this.perf.time("pet", () => this.pet.fixedUpdate(this.state.world, dt, this.body));
      this.perf.time("aim", () => this.updateAim());
      if (this.mining) this.stepMining(dt);
      if (this.placing) {
        this.tryPlace();
        this.placing = false;
      }
      return;
    }
    let fwd = 0;
    let strafe = 0;
    if (this.locked) {
      if (this.keys.has("KeyW")) fwd += 1;
      if (this.keys.has("KeyS")) fwd -= 1;
      if (this.keys.has("KeyA")) strafe -= 1;
      if (this.keys.has("KeyD")) strafe += 1;
    }
    const [rawX, rawZ] = wishFromInput(this.yaw, fwd, strafe);
    // the way the keys point (camera-relative), for the body to turn toward
    if (fwd || strafe) this.moveYaw = Math.atan2(rawX, rawZ);
    else this.moveYaw = null;
    // Ease toward the wanted direction instead of switching speed in one tick:
    // full speed in ~0.1 s, stopped in ~0.08 s. Instant start/stop read as
    // stiff and steppy. Only the PLAYER's input is eased — voxelBody's physics
    // (and the pet riding on it) are untouched.
    const k = approach(dt, fwd || strafe ? 0.045 : 0.035);
    this.wishX += (rawX - this.wishX) * k;
    this.wishZ += (rawZ - this.wishZ) * k;
    if (Math.abs(this.wishX) < 1e-3 && Math.abs(this.wishZ) < 1e-3) this.wishX = this.wishZ = 0;
    const wishX = this.wishX;
    const wishZ = this.wishZ;
    this.prevVy = this.body.vy;
    this.perf.time("physics", () => stepBody(this.state.world, this.body, dt, wishX, wishZ, this.locked && this.keys.has("Space")));
    // hard landings thump the camera a little
    if (this.body.grounded && this.prevVy < -11) {
      this.camera.addShake(Math.min(0.11, -this.prevVy * 0.006));
    }
    const wet = this.body.wet ?? 0;
    if (this.lastWet === 0 && wet > 0 && this.prevVy < -4) this.sfx.play("splash");
    this.lastWet = wet;
    if (this.water) this.perf.time("water", () => this.water!.update(dt));

    // walked far across the field → scroll the voxel window under the player
    if (this.field) {
      const shift = this.field.recenter(this.body);
      if (shift) {
        this.body.x -= shift.dx;
        this.body.z -= shift.dz;
        this.prevBody.x -= shift.dx;
        this.prevBody.z -= shift.dz;
        this.miningTarget = null;
        this.miningProgress = 0;
        this.view.shift(shift.dx, shift.dz);
        this.pet.shift(shift.dx, shift.dz);
      }
    }

    // fell off the island → respawn on the open grass south of the castle
    // (never the castle centre), lifted clear of any block
    if (this.body.y < -12) {
      const spawn = this.field?.spawn ?? CRAFT_SPAWN;
      this.body.x = spawn.x;
      this.body.z = spawn.z;
      this.body.y = surfaceY(this.state.world, Math.floor(this.body.x), Math.floor(this.body.z)) + 1;
      this.body.vx = this.body.vz = this.body.vy = 0;
      unstick(this.state.world, this.body);
      this.sfx.play("oof");
    }

    // After the player's own step, so the pet chases where they ARE, not where
    // they were a tick ago — a frame of lag here reads as the dog lagging.
    this.perf.time("pet", () => this.pet.fixedUpdate(this.state.world, dt, this.body));

    this.perf.time("aim", () => this.updateAim());
    if (this.mining) this.stepMining(dt);
    else {
      this.miningTarget = null;
      this.pickupTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
    }
    if (this.placing) {
      this.tryPlace();
      this.placing = false; // one block per press
    }

    if (Date.now() - this.lastSaveAt > SAVE_INTERVAL_MS) this.perf.time("save", () => this.persist());
  }

  private updateAim(): void {
    const eyeY = this.body.y + EYE_HEIGHT;
    const dx = Math.sin(this.yaw) * Math.cos(this.pitch);
    const dy = Math.sin(this.pitch);
    const dz = Math.cos(this.yaw) * Math.cos(this.pitch);
    // furniture stops the ray too: you aim at a chair, not the floor under it
    // holding the bucket, water is a target too (to scoop it back up)
    this.aim = this.state.world.raycast(this.body.x, eyeY, this.body.z, dx, dy, dz, REACH, true, this.holdingWater());
    this.aimFurniture = this.furniture.aimAt(
      { x: this.body.x, y: eyeY, z: this.body.z },
      { x: dx, y: dy, z: dz },
      this.aim,
      REACH,
    );
  }

  private stepMining(dt: number): void {
    if (this.aimFurniture) {
      this.stepPickup(this.aimFurniture, dt);
      return;
    }
    this.pickupTarget = null;
    if (!this.aim) {
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      return;
    }
    const [x, y, z] = this.aim.voxel;
    const cellId = this.state.world.get(x, y, z);
    if (isWater(cellId)) {
      this.scoop(x, y, z, cellId);
      return;
    }
    const def = blockById(cellId);
    if (!def || def.hardness <= 0 || !this.canBuild()) {
      this.miningFrac = null; // bedrock: unbreakable (or the teacher locked building)
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
      this.writeCell(x, y, z, AIR, 0);
      addItem(this.state.inventory, dropOf(def));
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      this.sfx.play("crumble");
      this.camera.addShake(0.04);
    }
  }

  // ------------------------------------------------------------ sitting

  /** The seat being sat on, and where the robot sits on it (grid coords). */
  private seated: { item: PlacedFurniture; x: number; y: number; z: number; yaw: number } | null = null;

  private trySit(item: PlacedFurniture): boolean {
    const seat = this.furniture.seatAt(item, this.aim?.voxel ?? null);
    if (!seat) return false;
    this.seated = { item, ...seat };
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.wishX = this.wishZ = 0;
    this.sfx.play("sit");
    this.hud.toast("🪑 앉았어요 — 움직이면 일어나요");
    return true;
  }

  /**
   * One tick seated: hold the body on the seat (no physics — it is INSIDE the
   * piece's solid cells), and stand up on any move or jump, or if the seat is
   * gone (put away, undone, or its floor mined). Returns false once standing.
   */
  private stepSeated(): boolean {
    const s = this.seated!;
    const wantsUp =
      this.locked && ["KeyW", "KeyA", "KeyS", "KeyD", "Space"].some((k) => this.keys.has(k));
    if (wantsUp || !this.furniture.has(s.item)) {
      this.standUp();
      return false;
    }
    this.body.x = s.x;
    this.body.y = s.y;
    this.body.z = s.z;
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.body.grounded = true;
    return true;
  }

  /** Off the seat: onto the floor in front of it if that is clear, else on top. */
  private standUp(): void {
    const s = this.seated;
    if (!s) return;
    this.seated = null;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    this.body.x = s.x + fx * 0.75;
    this.body.z = s.z + fz * 0.75;
    this.body.y = s.item.y;
    this.body.vx = this.body.vy = this.body.vz = 0;
    unstick(this.state.world, this.body); // blocked in front: lifted clear, never stuck
  }

  /**
   * Left click on water with the bucket: a SOURCE is scooped up (and the
   * stream it fed drains on its own); flowing water just refills, so it says
   * where to scoop instead. One scoop per click.
   */
  private scoop(x: number, y: number, z: number, id: number): void {
    this.mining = false;
    this.miningFrac = null;
    if (!this.canBuild()) {
      this.hud.toast("🧱 지금은 건축이 잠겨 있어요");
      return;
    }
    if (id !== WATER && id !== WATER_SETTLED) {
      this.hud.toast("💧 흐르는 물이에요 — 물이 시작된 곳(원천)을 떠야 없어져요");
      return;
    }
    this.writeCell(x, y, z, AIR, 0);
    this.sfx.play("pour");
  }

  /** Right click with the bucket: a water source in the aimed cell. */
  private pour(x: number, y: number, z: number): void {
    const world = this.state.world;
    if (!world.inBounds(x, y, z) || !world.isReplaceable(x, y, z) || this.furniture.blocksCell(x, y, z)) return;
    if (world.get(x, y, z) === WATER) return;
    this.writeCell(x, y, z, WATER, 0);
    this.sfx.play("pour");
  }

  /** Held left click on furniture: a short hold puts it away (it is free). */
  private stepPickup(item: PlacedFurniture, dt: number): void {
    if (!this.canBuild()) {
      this.miningFrac = null;
      return;
    }
    if (this.pickupTarget !== item) {
      this.pickupTarget = item;
      this.miningProgress = 0;
    }
    this.miningTarget = null; // a block mined next starts from zero
    this.miningProgress += dt;
    this.miningFrac = this.miningProgress / PICKUP_TIME;
    if (this.miningProgress < PICKUP_TIME) return;
    this.furniture.pickUp(item);
    this.pickupTarget = null;
    this.miningProgress = 0;
    this.miningFrac = null;
  }

  /**
   * Stamp the selected LEGO piece at the aim cell: every footprint cell must be
   * free, in-bounds and clear of the player, and you need one block per cell —
   * it's all-or-nothing so a piece never lands half-placed.
   */
  private tryPlace(): void {
    this.actionHold = ACTION_FACE_TIME; // face what you are building on
    // right click ON a door/gate/curtain opens or closes it, whatever you hold
    if (this.aimFurniture && this.furniture.interact(this.aimFurniture)) return;
    // ...and on a chair, sofa or bed you sit down — unless you are placing
    // furniture, where the click means "put the piece here"
    if (this.aimFurniture && !this.furniture.active && this.trySit(this.aimFurniture)) return;
    if (!this.aim) return;
    if (!this.canBuild()) {
      this.hud.toast("🧱 지금은 건축이 잠겨 있어요");
      return;
    }
    if (this.furniture.active) {
      this.furniture.place(this.aim, this.yaw);
      return;
    }
    if (this.holdingWater()) {
      this.pour(...this.aim.before);
      return;
    }
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
      if (!this.state.world.isReplaceable(x, y, z)) return false; // air, or water it displaces
      if (this.furniture.blocksCell(x, y, z)) return false;
      if (overlapsVoxel(this.body, x, y, z)) return false; // never bury yourself
      targets.push([x, y, z]);
    }
    if (countOf(this.state.inventory, key) < targets.length) return false;
    const id = blockByKey(key)!.id;
    for (const [x, y, z] of targets) {
      removeItem(this.state.inventory, key);
      this.writeCell(x, y, z, id, shape);
    }
    return true;
  }

  /** Every local block write: world, renderer and (in a class) the network. */
  private writeCell(x: number, y: number, z: number, block: number, shape: number): void {
    const world = this.state.world;
    const prevBlock = world.get(x, y, z);
    const prevShape = world.getShape(x, y, z);
    world.setShaped(x, y, z, block, shape);
    if (SOLID_ID[prevBlock] === 0 && SOLID_ID[block] === 0) this.view.markWaterDirty(x, y, z);
    else { this.view.markCellDirty(x, y, z); this.view.markWaterDirty(x, y, z); }
    this.water?.touch(x, y, z); // water around it may flow in, or drain
    this.sync?.recordEdit(x, y, z, prevBlock, prevShape, block, shape);
    if (block === AIR) this.furniture.onBlockRemoved(x, y, z);
  }

  private canBuild(): boolean {
    return this.sync ? this.sync.canBuild() : true;
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
    // polygonOffset pulls the preview toward the camera: where it shares
    // surfaces with what is already there (a red "taken" preview over a placed
    // piece, a brick flush with a wall) it wins cleanly instead of z-fighting
    // into a flickering glow
    const ghost = { transparent: true, opacity: 0.34, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
    this.ghostOk = new THREE.MeshBasicMaterial({ color: 0x8ce87a, ...ghost });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: 0xe8695b, ...ghost });
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(this.ghostCubeGeo, this.ghostOk);
      m.visible = false;
      m.frustumCulled = false; // drawn off-screen by the boot warm-up (see prepare)
      this.ghost.add(m);
      this.ghostMeshes.push(m);
    }
    this.renderer.scene.add(this.ghost);
  }

  private updateGhost(): void {
    if (this.warming) {
      // boot warm-up: draw the block preview far below the world so its
      // programs compile now, not at the first aim of play
      this.ghostMeshes.forEach((m, i) => {
        m.visible = i < 2;
        m.material = i === 0 ? this.ghostOk : this.ghostBad;
        m.position.set(0, -1000, 0);
      });
      return;
    }
    // furniture mode draws its own ghost (FurnitureController.render)
    if (!this.locked || !this.aim || this.mining || this.furniture.active) {
      for (const m of this.ghostMeshes) m.visible = false;
      return;
    }
    // the bucket pours one cell, whatever brick shape is picked
    const piece = this.holdingWater() ? PIECES[0]! : PIECES[this.pieceIndex]!;
    const geo =
      piece.shape === "round"
        ? this.ghostRoundGeo
        : piece.shape === "slope"
          ? this.ghostSlopeGeo
          : this.ghostCubeGeo;
    if (piece.shape === "slope") brickOrientation(this.pieceRot, this.pieceTilt, this.ghostQuat);
    else this.ghostQuat.identity();
    const cells = this.holdingWater() ? [[0, 0, 0] as const] : pieceCells(piece, this.pieceRot, this.pieceTilt);
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
      const ok = this.state.world.inBounds(x, y, z) && this.state.world.isReplaceable(x, y, z) && !this.furniture.blocksCell(x, y, z);
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

  /**
   * Swap the companion. The pet keeps its position, brain and follow mode —
   * only the collider and the model change — so an adoption mid-walk looks
   * like the new animal was the one following you all along.
   */
  private adoptPet(species: PetSpecies): void {
    this.pet.adopt(this.state.world, species);
    this.state.pet = species;
    this.petShop.setCurrent(species);
    const info = SPECIES[species];
    this.hud.toast(`${info.emoji} ${withObjectParticle(info.name)} 입양했어요`);
    this.persist();
  }

  /**
   * Re-capture the mouse straight from a panel click. Picking a piece means
   * "let me place it", so stopping at "Click to play" first was one click too
   * many. Must run inside the click handler: browsers only grant pointer lock
   * during a user gesture.
   */
  private resumePlay(): void {
    if (this.locked || this.workshop.active) return;
    const canvas = this.renderer.renderer.domElement;
    try {
      // newer browsers return a promise that rejects instead of throwing
      void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    } catch {
      /* the hint stays up; a click on the world still resumes */
    }
  }

  private lastSaveSignature = "";
  private persist(): void {
    this.lastSaveAt = Date.now();
    if (this.sync) return; // the class's field lives on the server
    // standing still with no edits: nothing to write, skip the serialise +
    // synchronous localStorage write entirely
    const signature = `${this.state.world.version}|${Math.round(this.body.x * 2)},${Math.round(this.body.y * 2)},${Math.round(this.body.z * 2)}|${JSON.stringify(this.state.inventory)}|${this.pet.species}|${this.state.furniture.version}`;
    if (signature === this.lastSaveSignature) return;
    this.lastSaveSignature = signature;
    this.state.player = { x: this.body.x, y: this.body.y, z: this.body.z };
    this.state.pet = this.pet.species;
    if (this.field) {
      this.field.save(localStorage, this.state.inventory, this.state.player, this.state.pet, this.state.furniture.toJSON());
    } else {
      saveCraft(this.state, localStorage, Date.now());
    }
  }

  /**
   * Smooth robot fade near the camera. Materials are CLONED once (the GLTF
   * shares materials across every rig clone — mutating the shared ones would
   * fade other modes' robots too).
   */
  private applyRobotOpacity(target: number, dt: number): void {
    if (!this.robotMaterials) {
      // one clone per SOURCE material: parts that shared a colour keep sharing
      const clones = new Map<THREE.Material, THREE.Material>();
      this.rig.root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const source = o.material as THREE.Material;
          let cloned = clones.get(source);
          if (!cloned) {
            cloned = source.clone();
            cloned.transparent = true;
            clones.set(source, cloned);
          }
          o.material = cloned;
        }
      });
      if (clones.size === 0) return; // model still loading
      this.robotMaterials = [...clones.values()];
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
  private smoothedEyeY(bodyY: number, dt: number): number {
    const target = bodyY + EYE_HEIGHT;
    if (!Number.isFinite(this.smoothEyeY) || Math.abs(target - this.smoothEyeY) > 1.6) {
      this.smoothEyeY = target;
    } else {
      this.smoothEyeY += (target - this.smoothEyeY) * (1 - Math.pow(1e-9, dt));
    }
    return this.smoothEyeY;
  }

  /**
   * A huge grass plane that carries the ground out to the fog past the voxel
   * window, so the field reads as endless.
   *
   * It lies just under the top of the BEDROCK layer, not under the grass: at
   * grass height it covered every hole dug in the top layer, so a mined grass
   * block left green "grass" behind. Bedrock cannot be mined, so inside the
   * window the plane is always hidden beneath it, and past the render distance
   * — where it shows — the fog is opaque, so the drop in height never shows.
   */
  private buildFieldGround(): void {
    const size = 1024;
    const material = new THREE.MeshStandardMaterial({ color: 0x5cbe4a, roughness: 0.75, metalness: 0.05 });
    const geometry = new THREE.PlaneGeometry(size, size);
    geometry.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(geometry, material);
    ground.receiveShadow = true;
    this.renderer.scene.add(ground);
    this.fieldGround = ground;
    void loadTexture(textureUrl(blockByKey("grass")!)).then((tex) => {
      if (!tex) return;
      const tiled = tex.clone();
      tiled.wrapS = tiled.wrapT = THREE.RepeatWrapping;
      tiled.repeat.set(size, size);
      tiled.needsUpdate = true;
      material.map = tiled;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    });
  }

  // ---------------------------------------------------------------- render

  /**
   * The body as it should be DRAWN this frame: blended between the last two
   * 60 Hz physics ticks by the loop's `alpha`. Drawing the raw tick position
   * moved the robot (and the camera riding on it) in steps — some frames two
   * ticks' worth, some frames none — which reads as stutter, worst on a
   * 120/144 Hz screen and when sliding along a wall. A jump of more than a
   * couple of metres in one tick (respawn, teleport, class gather) is a cut,
   * not motion, and is drawn where it landed.
   */
  private interpolatedBody(alpha: number): THREE.Vector3 {
    interpolate(this.prevBody, this.body, alpha, this.drawBody);
    return this.drawBody;
  }

  private render(alpha: number, frameDt: number): void {
    const drawn = this.interpolatedBody(alpha);
    this.sky.update(this.renderer.camera);
    this.sync?.render(frameDt);
    // integer steps keep the 1 m texture tiles aligned with the voxel grid
    this.fieldGround?.position.set(Math.round(this.body.x), FIELD_GROUND_Y, Math.round(this.body.z));
    // Detail (rounded bricks, studs) follows what you're looking AT — the
    // robot, or the machine being driven/flown. Not the orbiting camera:
    // turning the view would swing it metres around and re-ring every frame.
    if (!this.workshop.active) this.detailFocus.set(drawn.x, drawn.y + EYE_HEIGHT, drawn.z);
    this.perf.time("chunks", () => this.view.update(this.state.world, this.detailFocus));
    if (this.workshop.active) {
      this.rig.root.visible = false;
      this.pet.setVisible(false);
      this.petShop.setVisible(false);
      this.furniture.setVisible(false);
      this.ghost.visible = false;
      this.view.setHighlight(null);
      if (this.workshop.scienceActive) { this.workshop.renderScience(frameDt); return; }
      const target = this.workshop.render(frameDt);
      this.detailFocus.copy(target);
      this.renderer.trackTarget(target);
      this.perf.time("render", () => this.renderer.render());
      this.perf.update(this.renderer.renderer, frameDt);
      return;
    }
    this.ghost.visible = true;
    this.pet.setVisible(true);
    this.petShop.setVisible(true);
    this.furniture.setVisible(true);
    this.pet.render(alpha, frameDt);
    // on furniture the mining bar is the feedback; a cell box would frame one
    // cell of a two-cell sofa, or the block under a rug
    // (during the boot warm-up the cell box draws far below the world, so its
    // line shader compiles behind the loading screen, not on the first aim)
    this.view.setHighlight(this.warming ? [0, -1000, 0] : this.aim && !this.aimFurniture ? this.aim.voxel : null);

    this.rig.root.position.copy(drawn);
    this.updateView(frameDt);
    this.updateFacing(frameDt);
    this.rig.root.rotation.y = this.facing;
    const planar = Math.hypot(this.body.vx, this.body.vz);
    // swimming is paddling (run) or treading water (idle) — not a jump pose
    const swimming = (this.body.wet ?? 0) >= SWIM_DEPTH;
    const anim = this.seated ? "sit" : !this.body.grounded && !swimming ? "jump" : planar > 0.5 ? "run" : "idle";
    this.rig.update(anim, planar, frameDt);

    const eye = this.tmpEye.set(drawn.x, this.smoothedEyeY(drawn.y, frameDt), drawn.z);
    const t0 = performance.now();
    const robotOpacity = this.camera.update(
      this.state.world,
      eye,
      this.viewYaw,
      this.viewPitch,
      planar > 0.5,
      frameDt,
    );
    this.applyRobotOpacity(this.debugHideRobot ? 0 : robotOpacity, frameDt);
    this.renderer.trackTarget(eye);
    this.updateUnderwater();
    this.view.animateWater(performance.now() / 1000, this.field?.absOriginX ?? 0, this.field?.absOriginZ ?? 0);

    this.updateGhost();
    this.hud.update(this.state.inventory, this.selected);
    this.hud.setMineProgress(this.miningFrac);
    this.perf.phase("camera", performance.now() - t0);
    this.perf.time("furniture", () => this.furniture.render(this.aim, this.yaw, this.locked && !this.mining, this.ghostOk, this.ghostBad));
    if (!this.furniture.active) this.hud.setPiece(PIECES[this.pieceIndex]!.name, this.pieceRot, this.pieceTilt);
    this.perf.time("render", () => this.renderer.render());
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private readonly tmpEye = new THREE.Vector3();
  /** Eased movement input (see fixedUpdate). */
  private wishX = 0;
  private wishZ = 0;
  /** The view angles the camera DRAWS with — `yaw`/`pitch` lightly smoothed. */
  private viewYaw = Math.PI;
  private viewPitch = -0.25;

  /**
   * A mouse reports at its own rate (often 125 Hz) and the screen refreshes at
   * another (60–144 Hz), so some frames carry two mouse moves and some none:
   * the view turned in a stop–jump rhythm. Easing the DRAWN angles over ~25 ms
   * spreads those moves evenly across frames. Aim, mining and placing still use
   * the exact `yaw`/`pitch`, so nothing lands anywhere but under the crosshair
   * once the view settles a frame later. A big jump (a teleport's `look`, a
   * respawn) is taken at once.
   */
  /**
   * Which way the robot's BODY faces — third-person game style, not glued to
   * the camera: walking, it turns toward where the keys point (S walks it
   * toward the camera, face first, so you actually see your character);
   * mining or placing, it turns to the crosshair so it never digs with its
   * back to the block; seated, it faces the way the seat does; in first person
   * it is the view. The camera stays on the mouse throughout.
   */
  private updateFacing(frameDt: number): void {
    this.actionHold = Math.max(0, this.actionHold - frameDt);
    if (this.mining) this.actionHold = ACTION_FACE_TIME;
    if (this.seated) {
      this.facing = this.seated.yaw;
      return;
    }
    if (this.camera.firstPerson) {
      this.facing = this.viewYaw;
      return;
    }
    const target = this.actionHold > 0 ? this.yaw : this.moveYaw;
    if (target !== null) this.facing = turnToward(this.facing, target, frameDt);
  }

  /** The body's drawn heading (see updateFacing). */
  private facing = 0;
  /** The keys' heading this tick, or null while no move key is held. */
  private moveYaw: number | null = null;
  /** Seconds the body keeps facing the crosshair after an action. */
  private actionHold = 0;

  private updateView(frameDt: number): void {
    this.viewYaw = easeAngle(this.viewYaw, this.yaw, frameDt);
    this.viewPitch = easeAngle(this.viewPitch, this.pitch, frameDt);
  }
  /** Body position at the start of the last physics tick (see interpolatedBody). */
  private readonly prevBody = new THREE.Vector3();
  private readonly drawBody = new THREE.Vector3();
  /** Dev-only perf bisection switch (`__roboCraft.renderFlags`). */
  private debugHideRobot = false;
  private readonly sky: SkyDome;
  /** Live classroom link (education mode with a teacher); null when solo. */
  private readonly sync: ClassSync | null = null;
  private viewPreset = 1;

  private get viewPresets(): readonly number[] {
    return this.field ? VIEW_PRESETS.field : VIEW_PRESETS.island;
  }

  private loadViewPreset(): number {
    try {
      const raw = localStorage.getItem(VIEW_KEY);
      const n = raw === null ? NaN : Number(raw); // Number(null) is 0, not "unset"
      if (Number.isInteger(n) && n >= 0 && n < VIEW_NAMES.length) return n;
    } catch {
      /* default */
    }
    return 1;
  }

  /**
   * Under the surface the world goes murky blue: the fog closes in to a few
   * metres and a tint washes the screen. Only fog numbers change (uniforms,
   * no shader recompile), and the render distance's fog comes back on exit.
   */
  private updateUnderwater(): void {
    const p = this.renderer.camera.position;
    // A small hysteresis band stops tiny surface waves/camera bobbing from
    // flashing between the underwater fog and the daylight fog every frame.
    const under = pointInWater(this.state.world, p.x, p.y + (this.underwater ? -0.07 : 0.07), p.z);
    if (under === this.underwater) return;
    this.underwater = under;
    this.underwaterTint.classList.toggle("on", under);
    const fog = this.renderer.scene.fog as THREE.Fog;
    if (under) {
      fog.color.set(UNDERWATER_FOG);
      fog.near = 0.5;
      fog.far = 18;
    } else {
      fog.color.set(FOG_COLOR);
      this.applyViewDistance(this.viewPreset);
    }
  }

  /**
   * Minecraft-style render distance: fog thickens from ~45% of the distance
   * and is opaque exactly where chunks stop being drawn, so far terrain fades
   * into the horizon instead of popping at the cut.
   */
  private applyViewDistance(preset: number): void {
    this.viewPreset = preset;
    const metres = this.viewPresets[preset]!;
    const fog = this.renderer.scene.fog as THREE.Fog;
    if (!this.underwater) {
      fog.near = metres * 0.45;
      fog.far = metres;
    }
    this.view.setRenderDistance(metres + 8);
  }
  private readonly detailFocus = new THREE.Vector3();

  // ---------------------------------------------------------------- debug

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__roboCraft = {
      snapshot: () => ({
        pos: [this.body.x, this.body.y, this.body.z],
        grounded: this.body.grounded,
        seed: this.state.seed,
        selected: this.selected,
        yaw: this.yaw,
        inventory: { ...this.state.inventory },
      }),
      seated: () => (this.seated ? { kind: this.seated.item.kind, pos: [this.body.x, this.body.y, this.body.z] } : null),
      /** What the crosshair is on: the voxel ray's hit and any furniture. */
      aimInfo: () => ({
        locked: this.locked,
        voxel: this.aim?.voxel ?? null,
        furniture: this.aimFurniture?.kind ?? null,
      }),
      /** Compiled shader programs (name + a short cache key) — to see what
       *  a warm-up missed: diff this before and after an action. */
      programs: () =>
        (this.renderer.renderer.info.programs ?? []).map((p) => `${p.name}|${p.cacheKey}`),
      /** Water state: how wet the body is, the camera underwater, and every
       *  water cell in the live window (count + how many are sources). */
      water: () => {
        let cells = 0;
        let sources = 0;
        for (const id of this.state.world.cells) {
          if (!isWater(id)) continue;
          cells++;
          if (id === WATER) sources++;
        }
        return { wet: this.body.wet ?? 0, underwater: this.underwater, cells, sources, y: this.body.y, selected: HOTBAR[this.selected] };
      },
      /** The live scene — for resource audits (duplicate materials/geometries). */
      scene: () => this.renderer.scene,
      cameraState: () => {
        const p = this.renderer.camera.position;
        return { dist: this.camera.distance, x: p.x, y: p.y, z: p.z, t: performance.now() };
      },
      /** Perf bisection: switch costly render features off one at a time. */
      renderFlags: (flags: { shadows?: boolean; robot?: boolean }) => {
        if (flags.shadows !== undefined) this.renderer.renderer.shadowMap.enabled = flags.shadows;
        if (flags.robot !== undefined) this.debugHideRobot = !flags.robot;
      },
      give: (key: string, n = 1) => addItem(this.state.inventory, key, n),
      teleport: (x: number, y: number, z: number) => {
        this.body.x = x;
        this.body.y = y;
        this.body.z = z;
        this.body.vy = 0;
      },
      pet: () => ({
        pos: [this.pet.body.x, this.pet.body.y, this.pet.body.z],
        mode: this.pet.mode,
        species: this.pet.species,
        grounded: this.pet.body.grounded,
        gap: Math.hypot(this.pet.body.x - this.body.x, this.pet.body.z - this.body.z),
        ...this.pet.debug,
      }),
      petToggle: () => this.pet.toggleMode(),
      petAdopt: (species: string) => {
        if (!(species in SPECIES)) return false;
        this.adoptPet(species as PetSpecies);
        return true;
      },
      petShopOpen: () => this.petShop.open,
      petShopToggle: () => this.petShop.toggle(),
      ...this.furniture.debug(),
      blockAt: (x: number, y: number, z: number) => this.state.world.get(x, y, z),
      mineAt: (x: number, y: number, z: number) => {
        const def = blockById(this.state.world.get(x, y, z));
        if (!def || def.hardness <= 0) return false;
        this.writeCell(x, y, z, AIR, 0);
        addItem(this.state.inventory, dropOf(def));
        return true;
      },
      placeAt: (x: number, y: number, z: number, key: string) => {
        const def = blockByKey(key);
        if (!def || !this.state.world.isReplaceable(x, y, z) || this.furniture.blocksCell(x, y, z)) return false;
        this.writeCell(x, y, z, def.id, 0);
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
        this.facing = yaw;
        if (pitch !== undefined) this.pitch = pitch;
      },
      saveNow: () => this.persist(),
      perf: () => this.perf.sample(),
      waterStats: () => this.view.waterStats(),
      machine: () => this.workshop.snapshot(),
      classroom: () => this.sync?.debug() ?? null,
      classSend: (msg: Parameters<ClassClient["send"]>[0]) => this.sync?.client.send(msg),
      absolute: () => (this.field ? this.field.toAbsolute(this.body.x, this.body.z) : null),
    };
  }
}
