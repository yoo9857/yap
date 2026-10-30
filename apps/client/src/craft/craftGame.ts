import * as THREE from "three";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu, warmupGpuAsync } from "../render/textures.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { PerfMonitor } from "../ui/perf.js";
import { t } from "../ui/i18n.js";
import { settings } from "../ui/settings.js";
import { lookDelta } from "../input/mouseLook.js";
import { AIR, BLOCKS, SOLID_ID, blockById, blockByKey, dropOf, isPlaceableItem, textureUrl } from "./blocks.js";
import { loadTexture } from "../render/textures.js";
import {
  CLASS_HOTBAR_KEY,
  CRAFT_RECIPES,
  WATER_SLOT,
  addItem,
  assignHotbar,
  clearHotbarSlot,
  countOf,
  craftBatch,
  craftRecipe,
  ensureFieldStacks,
  fieldStarterHotbar,
  readStoredHotbar,
  removeItem,
  type CraftRecipe,
} from "./inventory.js";
import { clearCraftSave, loadCraft, saveCraft, type CraftGameState } from "./craftSave.js";
import { FIELD_MAX_VIEW, FieldWindow, clearFieldSave, fieldStarterInventory } from "./fieldWorld.js";
import { SkyDome } from "./skyDome.js";
import { createSkyEnvironment } from "../render/skyEnvironment.js";
import { ClassSync } from "./classSync.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { SWIM_DEPTH, pointInWater, stepBody, unstick, overlapsShapedVoxel, wishFromInput, type Body } from "./voxelBody.js";
import {SandSim} from "./sandSim.js";
import { WaterSim } from "./waterSim.js";
import { WATER, WATER_SETTLED, isWater, emoteDef, lookDirection, pickBonk, bonkBlocked, BONK_COOLDOWN_MS, BONK_DECAY, BONK_PUSH_CAP, type EmoteId, type CharacterId, type ClassAnim, type CharacterAction, type CharacterPresentation, postureTransition } from "@robo/shared";
import { EmoteMenu } from "./emoteMenu.js";
import { adoptPosture, moveScale, POSTURE_EYE, type Posture } from "./posture.js";
import { gaitBlend } from "../player/motionPolicy.js";
import { CRAFT_SPAWN, surfaceY, type RayHit } from "./voxelWorld.js";
import { PIECES, MAX_PIECE_CELLS, pieceCells, pieceShape } from "./pieces.js";
import { ROUND, KIT_CUBE, isOrientedShape, blockShapeFamily } from "./shapes.js";
import {kitCubeGeometry,kitRampGeometry,kitConnectorGeometry,kitRoundGeometry,kitCellsGeometry} from "./kitGeometry.js";
import {planPiecePlacement} from "./blockPlacement.js";
import {
  brickOrientation,
} from "./brickGeometry.js";
import { VoxelView } from "./voxelView.js";
import {preloadHeldItems} from "../player/heldItem.js";
import {PICKAXE,pickaxeWork,pickaxeInReach,pickaxeCycle,pickaxeImpacts} from "./toolDefinitions.js";
import {selectedTool,toolByKey,withStarterTools,itemByKey} from "./itemCatalog.js";
import {ItemAttack,type ItemAttackStep} from "./itemAttack.js";
import {MiningEffects} from "./miningEffects.js";
import {surfaceStyle} from "./blockMaterials.js";
import {measureRoom} from "../audio/acoustics.js";
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
const viewName = (i: number): string => [t("가깝게", "Short"), t("보통", "Normal"), t("멀리", "Far")][i] ?? "";
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
  private readonly events = new AbortController();
  private disposed = false;
  private debugHooks: object | null = null;
  private readonly renderer: GameRenderer;
  private readonly view: VoxelView;
  private readonly miningEffects:MiningEffects;
  private miningIdentity="";
  private readonly itemAttack=new ItemAttack();
  private toolOption:import("@robo/shared").ToolOptionId=PICKAXE.defaultOption as import("@robo/shared").ToolOptionId;
  private toolElapsed=0;
  private sand:SandSim|null=null;
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
  private readonly emoteMenu: EmoteMenu;
  private character: CharacterId = "mascot";
  private emote: EmoteId = "none";
  private emoteSeq = 0;
  private emoteLeft = 0;
  private posture: Posture = "stand";
  private postureDelay = 0;
  private workAction: CharacterAction = "none";
  private workSeq = 0;
  private workLoop = false;
  private workLeft = 0;
  /** What's left of a classroom tap's shove, added on top of walking. */
  private knockX = 0;
  private knockZ = 0;
  /** Earliest time another tap may be thrown. */
  private bonkAt = 0;
  private readonly seatOffset = new THREE.Vector3();
  private seatBlend = 0;
  private seatBlendDuration = .65;
  private mining = false;
  private placing = false;
  private miningTarget: [number, number, number] | null = null;
  private miningProgress = 0;
  /** Hand digging taps the block on a steady beat (the pickaxe taps on its own strike frame). */
  private hitBeat = 0;
  /** Last rendered gait / dig phases, to catch the frame a foot lands or the hand meets the block. */
  private cuePhase = -1;
  private stepQuietUntil = 0;
  private roomProbeIn = 0;
  private cueDig = -1;
  /** Metres walked since the last footstep, and whether the body was on the ground last tick. */
  private stepDistance = 0;
  private wasGrounded = true;
  private miningFrac: number | null = null;
  private selected = 0;
  /** Q: nothing in hand. Mining, doors and seats still work; nothing is placed
   *  or poured and there is no preview, so a stray right click builds nothing. */
  private emptyHands = false;
  /** A re-capture of the mouse is on its way (pointer lock is asynchronous):
   *  until it lands or is refused, the pause card must not flash up. */
  private resumeUntil = 0;
  /** When the mouse was last captured (see lookDelta). */
  private lockedAt = 0;
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
  private ghostCornerGeo!:THREE.BufferGeometry;
  private ghostCapGeo!:THREE.BufferGeometry;
  private ghostShellGeo:THREE.BufferGeometry|null=null;
  private ghostShellKey="";
  private readonly ghostCaps:THREE.Mesh[]=[];
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
    // ?blocks=classic draws the pre-v4 surfaces, for comparison
    this.view = new VoxelView(this.renderer.scene, { generatedSurfaces: new URLSearchParams(location.search).get("blocks") !== "classic" });
    this.skyEnvironment = createSkyEnvironment(this.renderer.renderer, SKY_TOP, FOG_COLOR, 0x9a8f78);
    this.view.setEnvironment(this.skyEnvironment.texture);
    this.miningEffects=new MiningEffects(this.renderer.scene,cell=>this.view.setMiningHidden(cell));
    // the world as an acoustic space: bricks block sound, glass/ice/leaves let most of it through,
    // water damps a little (read live, so field scrolls and classroom resyncs need nothing)
    this.sfx.setAcoustics((x, y, z) => {
      const id = this.state.world.get(x, y, z);
      if (!id) return 0;
      const def = blockById(id);
      if (!def) return 0;
      if (def.fluid) return 0.15;
      if (def.seeThrough || def.key.endsWith("leaves")) return 0.35;
      return SOLID_ID[id] ? 1 : 0;
    });
    this.hud = new CraftHud(document.body, (recipe, many) => this.handleCraft(recipe, many), {
      furniture: true,
      creative: opts.field === true || opts.classroom !== undefined,
      mode: opts.classroom
        ? t(`교실 · ${opts.classroom.session.room}`, `Class · ${opts.classroom.session.room}`)
        : opts.field ? t("교육 모드 · 들판", "Education field") : "Craft Island",
      onResume: () => this.resumePlay(),
      onRecipesClose: () => this.resumePlay(),
      onAssign: (slot, key, move, hold) => this.assignToHotbar(slot, key, move, hold === true),
      onClearSlot: (slot) => this.clearHotbar(slot),
      onArm: (slot) => { this.selected = slot; this.emptyHands = false; },
      onSelect: (slot) => {
        this.selected = slot;
        this.emptyHands = false;
        if (slot < WATER_SLOT) this.hud.armBag(slot);
      },
    });

    this.emoteMenu = new EmoteMenu(document.body, id => this.chooseEmote(id), id => this.chooseCharacter(id), () => this.resumePlay());
    try { if (localStorage.getItem("craftyap-character-v1") === "tt") this.character = "tt"; } catch { /* optional preference */ }
    this.rig.setCharacter(this.character); this.emoteMenu.setCharacter(this.character);
    const reset = new URLSearchParams(location.search).has("reset");
    if (opts.classroom) {
      // a class field belongs to the server: no local save is read or written
      this.field = new FieldWindow();
      const spawn = this.field.spawn;
      this.state = {
        seed: 0,
        world: this.field.world,
        inventory: fieldStarterInventory(),
        hotbar: readStoredHotbar(localStorage, CLASS_HOTBAR_KEY, fieldStarterHotbar),
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
        inventory: ensureFieldStacks(saved?.inventory ?? {}),
        hotbar: saved?.hotbar ?? fieldStarterHotbar(),
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
    this.state.inventory=withStarterTools(this.state.inventory);
    // Before the first unstick: the player must not spawn inside a sofa. The
    // host reads the game's fields lazily, since some are built further down.
    const classroomClient = opts.classroom?.client;
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
            {this.water?.touch(ax - (this.field?.absOriginX ?? 0), ay, az - (this.field?.absOriginZ ?? 0));this.sand?.touch(ax-(this.field?.absOriginX??0),ay,az-(this.field?.absOriginZ??0));}
        if (!classroomClient) return;
        this.sync?.flushEdits();
        classroomClient.send({ t: "k-furniture", placed, removed });
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
      () => this.furniture.closePanel(), () => this.resumePlay());
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
            this.knockX = this.knockZ = 0;
            unstick(this.state.world, this.body);
          },
          bonked: (push) => this.receiveBonk(push),
          impact: (x, y, z) => x === undefined ? this.sfx.play("bonk") : this.sfx.at(x, y!, z!, () => this.sfx.play("bonk")),
          sound: (kind, family, x, y, z, wet) => this.sfx.at(x, y, z, () => {
            if (kind === "step") this.sfx.step(family, wet, 0.8);
            else if (kind === "swing") this.sfx.swing(0.12);
            else this.sfx.material(kind, family);
          }),
          toast: (text) => this.hud.toast(text),
          clearKeys: () => {
            this.keys.clear();
            this.mining = this.placing = false;
          },
          worldChanged: () => {
            unstick(this.state.world, this.body);
            this.body.vx = this.body.vy = this.body.vz = 0;
            this.prevBody.set(this.body.x, this.body.y, this.body.z);
            unstick(this.state.world, this.pet.body);
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
        if (!active) {
          this.renderer.camera.clearViewOffset();
          this.resumePlay();
        }
      });

    this.bindInput(mount);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.persist();
    }, { signal: this.events.signal });

    // solo play runs the water itself; a classroom's water is the server's
    this.water = this.sync ? null : new WaterSim(this.state.world, this.view, this.field);
    this.water?.wakeAll();
    this.sand=this.sync?null:new SandSim(this.state.world,{scene:this.renderer.scene,shape:(block,shape,cell)=>this.view.miningShape(shape,block,cell,this.state.world),write:(x,y,z,block,shape)=>this.writeCell(x,y,z,block,shape),hidden:cells=>this.view.setFallingHidden(cells),canEnter:(x,y,z)=>!overlapsShapedVoxel(this.body,x,y,z,0)&&!overlapsShapedVoxel(this.pet.body,x,y,z,0)});this.sand?.wakeAll();
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

  private heldKey(): string {
    return this.state.hotbar[this.selected] ?? "";
  }

  /** Is the selected hotbar slot the water bucket? */
  private holdingWater(): boolean {
    return !this.emptyHands && blockByKey(this.heldKey())?.fluid === true;
  }

  /** Remember a classroom loadout locally. Solo modes persist it with the save. */
  private rememberHotbar(): void {
    if (!this.sync) {
      this.persist();
      return;
    }
    try {
      localStorage.setItem(CLASS_HOTBAR_KEY, JSON.stringify(this.state.hotbar));
    } catch {
      /* the loadout lasts for this visit */
    }
  }

  private assignToHotbar(slot: number, key: string, move = false, hold = false): void {
    if (!move) {
      const existing = this.state.hotbar.indexOf(key);
      if (existing >= 0 && existing < WATER_SLOT) {
        this.selected = existing;
        this.emptyHands = false;
        this.hud.armBag(existing);
        return;
      }
    }
    if (!assignHotbar(this.state.hotbar, slot, key)) return;
    this.selected = slot;
    this.emptyHands = false;
    // A click fills the next slot. A drag stays on the slot the block landed on.
    this.hud.armBag(hold ? slot : (slot + 1) % WATER_SLOT);
    this.rememberHotbar();
  }

  /** A craft you can place immediately: hold it if it is already on the bar, otherwise take the slot in hand. */
  private holdCrafted(key: string): void {
    const existing = this.state.hotbar.indexOf(key);
    if (existing >= 0 && existing < WATER_SLOT) {
      this.selected = existing;
      this.emptyHands = false;
      if (this.hud.recipesOpen) this.hud.armBag(existing);
      return;
    }
    const slot = this.selected < WATER_SLOT ? this.selected : 0;
    if (!assignHotbar(this.state.hotbar, slot, key)) return;
    this.selected = slot;
    this.emptyHands = false;
    if (this.hud.recipesOpen) this.hud.armBag(slot);
    this.rememberHotbar();
  }

  private clearHotbar(slot: number): void {
    if (!clearHotbarSlot(this.state.hotbar, slot)) return;
    this.rememberHotbar();
  }

  /** Middle-click: hold the block you are looking at, if you own it. */
  private pickAimedBlock(): void {
    if (!this.aim || this.furniture.active) return;
    const [x, y, z] = this.aim.voxel;
    const def = blockById(this.state.world.get(x, y, z));
    if (!def || !isPlaceableItem(def)) return;
    const creative = this.field !== null;
    if (!creative && countOf(this.state.inventory, def.key) <= 0) {
      this.hud.toast(t("그 블록은 아직 없어요. 캐거나 조합해 보세요", "You don't have that block yet. Mine or craft one"));
      return;
    }
    const existing = this.state.hotbar.indexOf(def.key);
    if (existing >= 0 && existing < WATER_SLOT) {
      this.selected = existing;
      this.emptyHands = false;
      return;
    }
    const slot = this.selected < WATER_SLOT ? this.selected : 0;
    this.assignToHotbar(slot, def.key);
  }

  /**
   * Everything slow, done behind the boot overlay before the first playable
   * frame: textures, every shader (in parallel where the browser can), and two
   * real frames through the whole pipeline. See `warmupGpuAsync`.
   */
  async prepare(setMessage: (text: string) => void = () => {}): Promise<void> {
    setMessage(t("텍스처 불러오는 중…", "Loading textures…"));
    await Promise.all([texturesReady(),preloadHeldItems()]);
    if(!this.disposed)this.rig.setHeldItem(this.heldTool(),this.toolOption);
    if (this.disposed) return;
    setMessage(t("그래픽 준비하는 중…", "Preparing graphics…"));
    this.furniture.setWarm(true);
    this.view.setWarm(true); // the water shader, too
    this.miningEffects.prewarm(BLOCKS.filter((def) => !def.fluid).map((def) => ({ def, materials: this.view.miningMaterials(def.id) })));
    this.warming = true;
    try {
      await warmupGpuAsync(this.renderer.renderer, this.renderer.scene, this.renderer.camera, () => {
        if (!this.disposed) this.render(1, 1 / 60);
      }, 2, this.events.signal);
    } catch (error) { if (!this.disposed) throw error; }
    if (this.disposed) return;
    this.warming = false;
    this.furniture.setWarm(false);
    this.view.setWarm(false);
    this.miningEffects.endWarm();
    this.warmed = true;
    this.facing = this.yaw; // start facing the way the camera looks
  }

  start(): void {
    if (this.disposed) return;
    this.loop.start();
    // started without `prepare` (a test harness): warm up the old way
    if (!this.warmed) {
      void texturesReady().then(() => {
        if (this.disposed) return;
        warmupGpu(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
      });
    }
  }

  private warmed = false;
  /** True only while `prepare` draws its warm-up frames. */
  private warming = false;

  /** Release the WebGL/audio-facing resources when the mode is replaced. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.dispose();
    this.persist();
    this.events.abort();
    this.emoteMenu.dispose();
    if (document.pointerLockElement === this.renderer.renderer.domElement) document.exitPointerLock();
    const globals = window as unknown as Record<string, unknown>;
    if (globals.__roboCraft === this.debugHooks) delete globals.__roboCraft;
    this.debugHooks = null;
    this.water?.clear();
    this.sand?.dispose();
    this.underwaterTint.remove();
    this.workshop.dispose();
    this.miningEffects.dispose();
    this.view.dispose();
    this.sky.dispose();
    this.skyEnvironment.dispose();
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
    this.sfx.dispose();
    this.perf.dispose();
    this.hud.dispose();
    this.ghostCubeGeo.dispose(); this.ghostRoundGeo.dispose(); this.ghostSlopeGeo.dispose();this.ghostCornerGeo.dispose();this.ghostCapGeo.dispose();this.ghostShellGeo?.dispose();
    this.ghostOk.dispose(); this.ghostBad.dispose();
    for (const material of this.robotMaterials ?? []) material.dispose();
    this.robotMaterials = null;
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- input

  private bindInput(mount: HTMLElement): void {
    const on = <K extends keyof DocumentEventMap>(name: K, handler: (event: DocumentEventMap[K]) => void) =>
      document.addEventListener(name, handler, { signal: this.events.signal });
    mount.addEventListener("click", () => {
      if (!this.locked && !this.hud.recipesOpen && !this.workshop.active && !this.emoteMenu.open) {
        void Promise.resolve(mount.querySelector("canvas")?.requestPointerLock()).catch(() => {}); // refused during the browser's re-lock cooldown: the next click retries
      }
    }, { signal: this.events.signal });
    on("pointerlockchange", () => this.syncLock());
    // Minimised, another window or tab: let go of the mouse ourselves and pause.
    // Waiting for the browser to say so has left the game believing it still
    // held a mouse it had lost — no menu, and a click on the scene did nothing.
    const letGo = () => {
      this.resumeUntil = 0;
      if (document.pointerLockElement) document.exitPointerLock();
      this.syncLock();
    };
    window.addEventListener("blur", letGo, { signal: this.events.signal });
    on("visibilitychange", () => { if (document.hidden) letGo(); });
    // refused (e.g. the browser's re-lock cooldown right after Esc): show the card now
    on("pointerlockerror", () => { this.resumeUntil = 0; });
    on("mousemove", (e) => {
      if (!this.locked) return;
      // the cursor's jump on capture and OS spikes are dropped, not clamped (mouseLook.ts)
      const d = lookDelta(e.movementX, e.movementY, performance.now() - this.lockedAt);
      if (!d) return;
      const [dx, dy] = d;
      const look = 0.0026 * settings.sensitivity;
      this.yaw -= dx * look;
      this.pitch = Math.min(1.35, Math.max(-1.25, this.pitch - dy * look));
    });
    on("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) {
        if(!this.emptyHands&&toolByKey(this.heldKey())){const key=this.attackIdentity();if(key)this.itemAttack.request(key);this.mining=true;}
        else if (!this.tryBonk()) this.mining = true;
      }
      if (e.button === 2) this.placing = true;
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll cursor
        if (this.aimFurniture) this.furniture.pickKind(this.aimFurniture);
        else this.pickAimedBlock();
      }
    });
    on("mouseup", (e) => {
      if (e.button === 0) this.mining = false;
      if (e.button === 2) this.placing = false;
    });
    on("contextmenu", (e) => e.preventDefault());
    on("wheel", (e) => {
      if (!this.locked) return;
      if (this.furniture.handleWheel(e.deltaY > 0)) return;
      this.selected = (this.selected + (e.deltaY > 0 ? 1 : this.state.hotbar.length - 1)) % this.state.hotbar.length;
      this.emptyHands = false; // picking a block means "let me build"
    });
    on("keydown", (e) => {
      if (e.target instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable)) return;
      if (this.emoteMenu.handleKey(e)) return;
      const key = e.key.toLowerCase();
      if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey && !this.workshop.active) {
        e.preventDefault(); if (e.repeat) return;
        this.hud.hideRecipes(); this.petShop.setOpen(false); this.furniture.closePanel();
        this.keys.clear(); this.mining = this.placing = false;
        this.emoteMenu.setOpen(true); document.exitPointerLock(); return;
      }
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
      if (e.code === "KeyZ" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); if (e.repeat) return;
        this.changePosture(this.posture === "stand" || this.posture === "sit" ? "crawl" : "stand"); return;
      }
      // furniture's keys first: in furniture mode 1-9, Q/E, X and R are its own
      if (this.furniture.handleKey(key, e.repeat)) return;
      if (key >= "1" && key <= "9") {
        this.selected = Number(key) - 1;
        this.emptyHands = false;
        if (this.hud.recipesOpen) this.hud.armBag(this.selected);
      }
      if (key === "0") { this.selected = WATER_SLOT; this.emptyHands = false; }
      if(key==="r"&&!e.repeat&&!e.ctrlKey&&!e.metaKey&&this.heldTool()){
        const index=PICKAXE.options.findIndex(o=>o.id===this.toolOption);this.toolOption=PICKAXE.options[(index+1)%PICKAXE.options.length]!.id as import("@robo/shared").ToolOptionId;
        this.itemAttack.reset();this.beginWork("none");this.mining=false;this.clearMiningTarget();
        this.hud.toast(t(`곡괭이 · ${PICKAXE.options.find(o=>o.id===this.toolOption)!.name}`,`Pickaxe · ${this.toolOption}`));return;
      }
      // Q (furniture mode keeps Q for its categories, handled above)
      if (key === "q" && !e.repeat) {
        this.emptyHands = !this.emptyHands;
        this.mining = this.placing = false;
        this.hud.toast(this.emptyHands
          ? t("✋ 빈손 — 캐기만 해요, 놓지 않아요 · Q로 다시 들기", "✋ Empty hands — mine only, nothing is placed · Q to pick blocks back up")
          : t("🧱 블록 쌓기 — 다시 놓을 수 있어요", "🧱 Building — placing again"));
      }
      if ((key === "e" || key === "i") && !e.repeat) {
        const open = this.hud.toggleBag(key === "i" ? "craft" : "blocks", this.selected);
        if (open) {
          this.keys.clear();
          this.mining = this.placing = false;
          document.exitPointerLock();
        } else this.resumePlay();
      }
      if (key === "escape" && this.hud.recipesOpen) {
        this.hud.hideRecipes();
        this.resumePlay();
        return;
      }
      if (key === "v") this.camera.toggleView();
      if (key === "p" && !e.repeat) {
        this.hud.toast(this.pet.toggleMode() === "stay" ? t("🐶 앉아! 여기서 기다려요", "🐶 Buddy: stay") : t("🐶 따라와! 다시 따라와요", "🐶 Buddy: follow"));
      }
      // Y opens and closes the adoption panel (Ctrl+Y, handled above, is redo)
      if (key === "y" && !e.repeat) this.petShop.toggle();
      if (key === "o") {
        const next = (this.viewPreset + 1) % VIEW_NAMES.length;
        this.applyViewDistance(next);
        try {
          localStorage.setItem(VIEW_KEY, String(next));
        } catch {
          /* remembered for this session only */
        }
        this.hud.toast(`👁️ ${t("시야 거리", "View distance")}: ${viewName(next)} (${this.viewPresets[next]} m)`);
      }
      if (key === "r" && e.shiftKey && !e.repeat) {this.pieceRot=0;this.pieceTilt=0;this.hud.toast(t("기본 방향으로 맞췄어요", "Reset to upright"));return;}
      if (key === "r" && !e.repeat) this.pieceRot = (this.pieceRot + 1) % 4; // spin (yaw)
      if (key === "t" && !e.repeat) this.pieceTilt = (this.pieceTilt + 1) % 4; // tip sideways (tilt)
      if (key === "f" && !e.repeat) {
        this.pieceIndex = (this.pieceIndex + 1) % PIECES.length;
        this.pieceRot = 0;
        this.pieceTilt = 0;
      }
    });
    on("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear(); this.mining = this.placing = false;
    }, { signal: this.events.signal });
  }

  // ---------------------------------------------------------------- sim

  private fixedUpdate(): void {
    // where the body was before this tick: render() blends prev → current
    this.prevBody.set(this.body.x, this.body.y, this.body.z);
    if (this.sync) {
      this.sync.tick(1 / 60, this.body, this.facing, this.characterAnimation(), this.presentation());
    }
    if (this.workshop.active) { this.knockX = this.knockZ = 0;this.itemAttack.reset();this.beginWork("none");this.clearMiningTarget();this.workshop.fixedUpdate(); return; }
    const dt = 1 / 60;
    if(this.sand)this.perf.time("sand",()=>this.sand!.update(dt));
    this.postureDelay = Math.max(0, this.postureDelay-dt);
    this.seatBlend = Math.max(0,this.seatBlend-dt);
    this.workLeft = Math.max(0,this.workLeft-dt);
    if(this.workLeft===0 && this.workAction!=="none")this.beginWork("none");
    if(this.isSwimming() && this.posture!=="stand")this.changePosture("stand",false);
    if (this.emoteLeft > 0) { this.emoteLeft -= dt; if (this.emoteLeft <= 0) this.clearEmote(); }
    const movement = this.locked && ["KeyW","KeyA","KeyS","KeyD"].some(k=>this.keys.has(k));
    if (this.locked && this.keys.has("Space") && this.posture !== "stand") this.changePosture("stand",false);
    else if (movement && this.posture === "lie") this.changePosture("crawl",false);
    else if (movement && this.posture === "sit") this.changePosture("stand",false);
    if (this.seated && this.stepSeated()) {
      this.perf.time("pet", () => this.pet.fixedUpdate(this.state.world, dt, this.body));
      this.perf.time("aim", () => this.updateAim());
      this.stepInteraction(dt);
      if (this.placing) {
        this.tryPlace();
        this.placing = false;
      }
      return;
    }
    let fwd = 0;
    let strafe = 0;
    if (this.locked && this.posture !== "lie" && this.postureDelay <= 0 && !this.rig.postureBusy && !this.emoteMenu.open) {
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
    const sprint = this.posture === "stand" && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
    const targetRatio = moveScale(this.posture, sprint, this.isSwimming());
    // Crawl and swimming snap. On foot, Shift eases up into the run and back down into the walk.
    if (this.posture !== "stand" || this.isSwimming()) this.moveRatio = targetRatio;
    else this.moveRatio += (targetRatio - this.moveRatio) * approach(dt, sprint ? 0.06 : 0.09);
    const wishX = this.wishX * this.moveRatio;
    const wishZ = this.wishZ * this.moveRatio;
    this.prevVy = this.body.vy;
    this.perf.time("physics", () => stepBody(this.state.world, this.body, dt, wishX, wishZ, this.locked && this.posture === "stand" && this.postureDelay <= 0 && !this.rig.postureBusy && this.keys.has("Space"), this.knockX, this.knockZ));
    const knockKeep = Math.exp(-BONK_DECAY * dt);
    this.knockX *= knockKeep;
    this.knockZ *= knockKeep;
    if (this.knockX * this.knockX + this.knockZ * this.knockZ < 0.04) this.knockX = this.knockZ = 0;
    this.footsteps(dt);
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
        this.sand?.shift();
        this.miningEffects.shift(shift.dx,shift.dz);
        this.pet.shift(shift.dx, shift.dz);
        this.sync?.shift(shift.dx, shift.dz);
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
    this.stepInteraction(dt);
    if (this.placing) {
      this.tryPlace();
      this.placing = false; // one block per press
    }

    if (Date.now() - this.lastSaveAt > SAVE_INTERVAL_MS) this.perf.time("save", () => this.persist());
  }

  private updateAim(): void {
    const eyeY = this.body.y + POSTURE_EYE[this.seated ? "sit" : this.posture];
    const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
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

  /**
   * Footsteps on whatever block is underfoot: one every ~1.6 m running (closer
   * when crawling, none while swimming or seated), and one on touching down.
   */
  private footsteps(dt: number): void {
    const b = this.body;
    const under = () => {
      const id = this.state.world.get(Math.floor(b.x), Math.floor(b.y - 0.05), Math.floor(b.z));
      const def = id ? blockById(id) : undefined;
      return def ? surfaceStyle(def.key).family : "grass";
    };
    const wet = (b.wet ?? 0) > 0;
    // a touch-down is one step: the gait cue planting a foot in the same instant is not a second one
    if (b.grounded && !this.wasGrounded && this.prevVy < -3) { this.sfx.step(under(), wet); this.stepDistance = 0; this.stepQuietUntil = performance.now() + 160; }
    this.wasGrounded = b.grounded;
    if (!b.grounded || this.seated || this.isSwimming()) { this.stepDistance = 0; return; }
    const speed = Math.hypot(b.vx, b.vz);
    if (speed < 0.6) { this.stepDistance = Math.min(this.stepDistance, 0.9); return; }
    this.stepDistance += speed * dt;
    const stride = this.posture === "crawl" || this.posture === "lie" ? 0.9 : 1.6;
    if (this.rig.motionCue) return; // the rig's own foot plants drive the steps (cueSounds)
    if (this.stepDistance >= stride) { this.stepDistance -= stride; this.sfx.step(under(), wet); }
  }

  /**
   * Per rendered frame, after the rig moves: a footstep on the frame a foot
   * plants (Walk/Run 0 and 0.5 of the gait, Crawl ~0.44 and ~0.94) and a dig tap
   * on the frame the digging hand meets the block (0.5 of the Interact loop).
   * Sound follows what is drawn, not a separate timer, so it never drifts.
   */
  private cueSounds(): void {
    const cue = this.rig.motionCue;
    if (!cue) return;
    const crossed = (prev: number, cur: number, at: number) => prev >= 0 && (prev <= cur ? prev < at && at <= cur : prev < at || at <= cur);
    const b = this.body;
    const moving = cue.gait && b.grounded && !this.seated && !this.isSwimming() && Math.hypot(b.vx, b.vz) > 0.3;
    if (moving) {
      const plants = cue.gait === "crawl" ? [0.44, 0.94] : [0, 0.5];
      if (plants.some((p) => crossed(this.cuePhase, cue.phase, p)) && performance.now() >= this.stepQuietUntil) {
        const id = this.state.world.get(Math.floor(b.x), Math.floor(b.y - 0.05), Math.floor(b.z));
        const def = id ? blockById(id) : undefined;
        // a toy's short legs plant ~8 times a second at a run: every plant sounds (it is what
        // is drawn), lighter and a touch higher the faster the feet go, so it patters, not rattles
        const run = Math.min(1, Math.max(0, (Math.hypot(b.vx, b.vz) - 2) / 3));
        this.sfx.step(def ? surfaceStyle(def.key).family : "grass", (b.wet ?? 0) > 0, cue.gait === "crawl" ? 0.6 : 1 - run * 0.5, 1 + run * 0.12);
      }
      this.cuePhase = cue.phase;
    } else this.cuePhase = -1;
    if (cue.digPhase !== null && this.mining && this.miningTarget) {
      if (crossed(this.cueDig, cue.digPhase, 0.5)) {
        const def = blockById(this.state.world.get(...this.miningTarget));
        if (def) this.sfx.material("hit", surfaceStyle(def.key).family);
      }
      this.cueDig = cue.digPhase;
    } else this.cueDig = -1;
  }

  private heldTool(){return this.furniture.active?null:selectedTool(this.state.inventory,this.state.hotbar,this.selected,this.emptyHands);}
  private usingPickaxe():boolean {return !!this.heldTool()&&this.posture==="stand"&&!this.seated&&!this.isSwimming()&&this.body.grounded&&!this.rig.postureBusy;}
  private attackIdentity():string|null {return this.usingPickaxe()?this.heldTool()+"/"+this.toolOption:null;}
  private clearMiningTarget():void {this.miningTarget=null;this.pickupTarget=null;this.miningProgress=0;this.miningFrac=null;this.miningIdentity="";}
  private stepInteraction(dt:number):void {
    const key=this.locked?this.attackIdentity():null;
    const wasAttacking=this.itemAttack.active;
    const cycle=pickaxeCycle(this.toolOption);
    const step=this.itemAttack.step(dt,this.mining,key,cycle);this.toolElapsed=this.itemAttack.time;
    // each stroke's whoosh is scheduled from its start so it crests just before that stroke's blade impact
    if(step.to>step.from&&(step.started||Math.floor(step.from/cycle)!==Math.floor(step.to/cycle))){
      const impactIn=(Math.floor(step.to/cycle)+PICKAXE.swing.impactAt)*cycle-step.to;
      if(impactIn>0)this.sfx.swing(impactIn);
    }
    if(step.changed)this.clearMiningTarget();
    if(step.started){this.clearEmote();this.beginWork("none");}
    if(step.active){this.actionHold=ACTION_FACE_TIME;this.beginWork("interact",true);}
    if(step.active||step.completed)this.stepMining(dt,step);
    else if(!this.emptyHands&&toolByKey(this.heldKey()))this.clearMiningTarget();
    else if(this.mining)this.stepMining(dt);
    else this.clearMiningTarget();
    if(step.completed||wasAttacking&&step.changed&&!step.active)this.beginWork("none");
  }
  private stepMining(dt: number,strike?:ItemAttackStep): void {
    if (this.aimFurniture) {
      if(!this.heldTool())this.stepPickup(this.aimFurniture, dt);
      else this.clearMiningTarget();
      return;
    }
    this.pickupTarget = null;
    if (!this.aim || this.usingPickaxe()&&!pickaxeInReach(this.aim.dist,this.yaw-this.facing,this.toolOption)) {
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      return;
    }
    const [x, y, z] = this.aim.voxel;
    const cellId = this.state.world.get(x, y, z);
    if (isWater(cellId)) {
      // Only the bucket may remove water; tools and block items leave it intact.
      if (!this.holdingWater()) { this.clearMiningTarget(); return; }
      this.scoop(x, y, z, cellId);
      return;
    }
    const def = blockById(cellId);
    if (!def || def.hardness <= 0 || !this.canBuild()) {
      this.miningFrac = null;this.miningTarget=null;this.miningProgress=0;this.miningIdentity=""; // bedrock or build lock cancels accumulated damage
      return;
    }
    if(!strike)this.beginWork("interact",true);
    const t = this.miningTarget,shape=this.state.world.getShape(x,y,z),identity=cellId+":"+shape;
    if (!t || t[0] !== x || t[1] !== y || t[2] !== z || identity!==this.miningIdentity) {
      this.miningIdentity=identity;
      this.miningTarget = [x, y, z];
      this.miningProgress = 0;
      if(this.usingPickaxe())this.miningEffects.primeTarget([x,y,z],def,shape,()=>this.view.miningShape(shape,def.id,[x,y,z],this.state.world));
    }
    if(strike)this.miningProgress+=pickaxeWork(strike.from,strike.to,def.key,this.toolOption);else this.miningProgress+=dt;
    const family=surfaceStyle(def.key).family;
    // the pickaxe sounds only on its blade-impact frames (strike is every tick of the swing), and the
    // breaking blow plays the break, not a hit and a break on top of each other
    if(strike&&pickaxeImpacts(strike.from,strike.to,this.toolOption)>0&&this.miningProgress<def.hardness)this.sfx.material("hit",family);
    // hand digging taps when the hand meets the block (render-side cue); a rig without cues taps on a beat
    if(!strike&&!this.rig.motionCue&&(this.hitBeat-=dt)<=0){this.hitBeat=.35;if(this.miningProgress<def.hardness)this.sfx.material("hit",family);}
    this.miningFrac = this.miningProgress/def.hardness;
    if (this.miningProgress >= def.hardness) {
      this.miningEffects.burst([x,y,z],def,shape,()=>this.view.miningShape(shape,def.id,[x,y,z],this.state.world));
      this.writeCell(x, y, z, AIR, 0);
      addItem(this.state.inventory, dropOf(def));
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      this.sfx.material("break",family);
      this.camera.addShake(0.04);
    }
  }

  private isSwimming(): boolean { return !this.seated && (this.body.wet ?? 0) >= SWIM_DEPTH; }
  private presentation(): CharacterPresentation {
    return { character: this.character, emote: this.emote, emoteSeq: this.emoteSeq, action: this.workAction, actionSeq: this.workSeq, actionLoop: this.workLoop, swimming: this.isSwimming(), heldItem:this.heldTool(), toolOption:this.toolOption, toolPhase:this.itemAttack.active?this.toolElapsed/pickaxeCycle(this.toolOption)%1:0 };
  }

  /**
   * Left click on a classmate in reach taps them instead of mining. A miss
   * falls through to the normal dig. The server decides the shove.
   */
  private tryBonk(): boolean {
    if (!this.sync || !this.sync.tapsAllowed || this.workshop.active || this.furniture.active) return false;
    const hit = pickBonk(
      { x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.yaw, pitch: this.pitch, eye: POSTURE_EYE[this.seated ? "sit" : this.posture] },
      this.sync.bonkTargets(),
      { aim: "body", blocked: (from, to) => bonkBlocked(from, to, (x, y, z) => this.state.world.isBlocked(x, y, z)) },
    );
    if (!hit) return false;
    // the crosshair is on a block in front of them: that click digs the block
    if (this.aim && this.aim.dist < hit.dist) return false;
    if (performance.now() < this.bonkAt) return true;
    this.bonkAt = performance.now() + BONK_COOLDOWN_MS;
    this.actionHold = ACTION_FACE_TIME;
    this.beginWork("hit");
    // the Hit clip's hand reaches the friend 0.216 s in: hear the swing and the bump there, not at
    // the click or a network round trip later (the server echo is silent for the tapper, see ClassSync)
    this.sfx.swing(0.216);
    this.sfx.punch(0.216);
    this.sync.reportNow(this.body, this.facing, this.characterAnimation(), this.presentation());
    this.sync.sendBonk(hit.id, this.yaw, this.pitch, this.workSeq);
    return true;
  }

  /** The server said this tap connected. The shove is theirs, not ours. */
  private receiveBonk(push: { vx: number; vz: number; vy: number }): void {
    if (this.seated) this.standUp();
    this.knockX += push.vx;
    this.knockZ += push.vz;
    const speed = Math.hypot(this.knockX, this.knockZ);
    if (speed > BONK_PUSH_CAP) {
      const scale = BONK_PUSH_CAP / speed;
      this.knockX *= scale;
      this.knockZ *= scale;
    }
    this.body.vy = Math.max(this.body.vy, push.vy);
    this.body.grounded = false;
    this.rig.flashHit();
    this.rig.pop(-1.3);
    this.camera.addShake(0.045);
  }

  private beginWork(action:CharacterAction,loop=false):void {
    if(loop && !this.workLoop && this.workLeft>.17)return;
    if(action!==this.workAction || loop!==this.workLoop || !loop){this.workAction=action;this.workLoop=loop;this.workSeq=(this.workSeq+1)%1_000_000_000;}
    this.workLeft=action==="none"?0:loop?.15:action==="place"?.45:.55;
  }
  private characterAnimation(): ClassAnim {
    if (this.seated || this.posture === "sit") return "sit";
    if (this.posture === "lie") return "lie";
    if (this.posture === "crawl") return "crawl";
    if (!this.body.grounded && (this.body.wet ?? 0) < SWIM_DEPTH) return this.body.vy > .1 ? "jump" : "fall";
    return Math.hypot(this.body.vx,this.body.vz) > .5 ? "run" : "idle";
  }
  private clearEmote(): void { this.emote="none"; this.emoteLeft=0; this.emoteSeq=(this.emoteSeq+1)%1_000_000_000; }
  private changePosture(next: Posture, announce=true): boolean {
    if (this.seated) this.standUp();
    if (next === this.posture) return true;
    if (!adoptPosture(this.state.world,this.body,next,this.posture)) {
      if (announce) this.hud.toast(t("바닥과 머리 위 공간을 확인해 주세요", "Check the ground and space above you"));
      return false;
    }
    const old=this.posture; this.posture=next; this.wishX=this.wishZ=0;
    this.postureDelay=postureTransition(old,next)?.seconds ?? .65;
    this.clearEmote();
    if (announce) this.hud.toast(next === "crawl" ? t("Z 기어가기 · WASD 이동 · Z/Space 일어나기", "Crawling · WASD move · Z/Space stand") : next === "lie" ? t("누웠어요 · WASD 기어가기 · Z/Space 일어나기", "Lying down · WASD crawl · Z/Space stand") : t("자세를 바꿨어요", "Posture changed"));
    return true;
  }
  private chooseEmote(id: EmoteId): void {
    const def=emoteDef(id); if (!def) return;
    if (def.posture && !this.changePosture(def.posture)) return;
    if (def.posture === "stand") { this.clearEmote(); this.rig.setEmote("none",this.emoteSeq); return; }
    this.emote=id; this.emoteSeq=(this.emoteSeq+1)%1_000_000_000;
    this.emoteLeft=def.posture ? Infinity : def.seconds;
    this.rig.setEmote(this.emote,this.emoteSeq);
  }
  private chooseCharacter(id: CharacterId): void {
    this.character=id; this.rig.setCharacter(id);
    this.rig.setEmote(this.emote,this.emoteSeq);
    for (const material of this.robotMaterials ?? []) material.dispose();
    this.robotMaterials=null; this.robotOpacity=1;
    try { localStorage.setItem("craftyap-character-v1",id); } catch { /* optional preference */ }
  }

  // ------------------------------------------------------------ sitting

  /** The seat being sat on, and where the robot sits on it (grid coords). */
  private seated: { item: PlacedFurniture; x: number; y: number; z: number; yaw: number } | null = null;

  private trySit(item: PlacedFurniture): boolean {
    const seat = this.furniture.seatAt(item, this.aim?.voxel ?? null,this.rig.seatContactHeight);
    if (!seat) return false;
    this.seated = { item, ...seat };
    this.posture="stand";this.clearEmote();this.beginWork("none");
    this.body.x=seat.x;this.body.y=seat.y;this.body.z=seat.z;
    this.blendSeatAnchor(.65);
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.wishX = this.wishZ = 0;
    this.sfx.play("sit");
    this.hud.toast(t("🪑 앉았어요 — 움직이면 일어나요", "🪑 Sitting down — move to stand up"));
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

  private blendSeatAnchor(seconds:number):void {
    this.seatOffset.copy(this.rig.root.position).sub(new THREE.Vector3(this.body.x,this.body.y,this.body.z));
    this.seatBlend=this.seatBlendDuration=seconds;
    this.prevBody.set(this.body.x,this.body.y,this.body.z);
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
    this.body.h=1.8;this.posture="stand";
    unstick(this.state.world, this.body); // blocked in front: lifted clear, never stuck
    this.postureDelay=.65;this.blendSeatAnchor(.65);
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
      this.hud.toast(t("🧱 지금은 건축이 잠겨 있어요", "🧱 Building is locked right now"));
      return;
    }
    if (id !== WATER && id !== WATER_SETTLED) {
      this.hud.toast(t("💧 흐르는 물이에요 — 물이 시작된 곳(원천)을 떠야 없어져요", "💧 That water is flowing — scoop up its source to clear it"));
      return;
    }
    this.writeCell(x, y, z, AIR, 0);
    this.sfx.play("pour");this.beginWork("place");
  }

  /** Right click with the bucket: a water source in the aimed cell. */
  private pour(x: number, y: number, z: number): void {
    const world = this.state.world;
    if (!world.inBounds(x, y, z) || !world.isReplaceable(x, y, z) || this.furniture.blocksCell(x, y, z)) return;
    if (world.get(x, y, z) === WATER) return;
    this.writeCell(x, y, z, WATER, 0);
    this.sfx.play("pour");this.beginWork("place");
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
    this.beginWork("interact",true);
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
    if (this.aimFurniture && this.furniture.interact(this.aimFurniture)) { this.beginWork("place"); return; }
    // ...and on a chair, sofa or bed you sit down — unless you are placing
    // furniture, where the click means "put the piece here"
    if (this.aimFurniture && !this.furniture.active && this.trySit(this.aimFurniture)) return;
    if ((this.emptyHands||!!this.heldTool()) && !this.furniture.active) return;
    if (!this.aim) return;
    if (!this.canBuild()) {
      this.hud.toast(t("🧱 지금은 건축이 잠겨 있어요", "🧱 Building is locked right now"));
      return;
    }
    if (this.furniture.active) {
      if(this.furniture.place(this.aim, this.yaw))this.beginWork("place");
      return;
    }
    if (this.holdingWater()) {
      this.pour(...this.aim.before);
      return;
    }
    const held = this.heldKey();
    if (held && this.stampPiece(this.aim.before, held)) { this.sfx.material("place", surfaceStyle(held).family); this.beginWork("place"); }
  }

  /** Try to place the active piece with anchor at `before`; true if it landed. */
  private stampPiece(before:[number,number,number],key:string):boolean {
    if(!key||!blockByKey(key))return false;
    const plan=planPiecePlacement(this.state.world,this.body,PIECES[this.pieceIndex]!,this.pieceRot,this.pieceTilt,before,countOf(this.state.inventory,key),(x,y,z)=>this.furniture.blocksCell(x,y,z));
    if(!plan)return false;const id=blockByKey(key)!.id;
    for(const [x,y,z] of plan.cells){removeItem(this.state.inventory,key);this.writeCell(x,y,z,id,plan.shape);}
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
    this.sand?.touch(x,y,z);
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
    this.ghostCubeGeo = kitCubeGeometry();
    this.ghostRoundGeo = kitRoundGeometry();
    this.ghostSlopeGeo = kitRampGeometry();
    this.ghostCornerGeo=kitRampGeometry(true);this.ghostCapGeo=kitConnectorGeometry();
    // polygonOffset pulls the preview toward the camera: where it shares
    // surfaces with what is already there (a red "taken" preview over a placed
    // piece, a brick flush with a wall) it wins cleanly instead of z-fighting
    // into a flickering glow
    const ghost = { transparent: true, opacity: 0.34, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 };
    this.ghostOk = new THREE.MeshBasicMaterial({ color: 0x8ce87a, ...ghost });
    this.ghostBad = new THREE.MeshBasicMaterial({ color: 0xe8695b, ...ghost });
    for (let i = 0; i < MAX_PIECE_CELLS; i++) {
      const m = new THREE.Mesh(this.ghostCubeGeo, this.ghostOk);
      m.visible = false;
      m.frustumCulled = false; // drawn off-screen by the boot warm-up (see prepare)
      this.ghost.add(m);
      this.ghostMeshes.push(m);
      const cap=new THREE.Mesh(this.ghostCapGeo,this.ghostOk);cap.position.y=.5;cap.visible=false;m.add(cap);this.ghostCaps.push(cap);
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
    if (!this.locked || !this.aim || this.mining || this.furniture.active || this.emptyHands || !!this.heldTool()) {
      for (const m of this.ghostMeshes) m.visible = false;
      return;
    }
    // the bucket pours one cell, whatever brick shape is picked
    const piece = this.holdingWater() ? PIECES[0]! : PIECES[this.pieceIndex]!;
    const shape=pieceShape(piece,this.pieceRot,this.pieceTilt);
    const geo=shape===ROUND?this.ghostRoundGeo:blockShapeFamily(shape)==="corner"?this.ghostCornerGeo:isOrientedShape(shape)?this.ghostSlopeGeo:this.ghostCubeGeo;
    if(isOrientedShape(shape))brickOrientation(this.pieceRot,this.pieceTilt,this.ghostQuat);else this.ghostQuat.identity();
    const cells = this.holdingWater() ? [[0, 0, 0] as const] : pieceCells(piece, this.pieceRot, this.pieceTilt);
    const [ax, ay, az] = this.aim.before;
    const valid=this.canBuild() && (this.holdingWater() ? this.state.world.inBounds(ax,ay,az)&&this.state.world.isReplaceable(ax,ay,az)&&!this.furniture.blocksCell(ax,ay,az) : planPiecePlacement(this.state.world,this.body,piece,this.pieceRot,this.pieceTilt,[ax,ay,az],countOf(this.state.inventory,this.heldKey()),(x,y,z)=>this.furniture.blocksCell(x,y,z))!==null);
    if(!this.holdingWater()&&shape===KIT_CUBE){
      const cacheKey=piece.key+"/"+this.pieceRot+"/"+this.pieceTilt;
      if(cacheKey!==this.ghostShellKey){this.ghostShellGeo?.dispose();this.ghostShellGeo=kitCellsGeometry(cells);this.ghostShellGeo.translate(-.5,-.5,-.5);this.ghostShellKey=cacheKey;}
      for(let i=0;i<this.ghostMeshes.length;i++){this.ghostMeshes[i]!.visible=i===0;this.ghostCaps[i]!.visible=false;}
      const m=this.ghostMeshes[0]!;m.geometry=this.ghostShellGeo!;m.material=valid?this.ghostOk:this.ghostBad;m.quaternion.identity();m.position.set(ax+.5,ay+.5,az+.5);return;
    }
    const occupied=new Set(cells.map(c=>c.join(",")));
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
      const ok = valid;
      m.visible = true;
      m.geometry = geo;
      m.material = ok ? this.ghostOk : this.ghostBad;
      const cap=this.ghostCaps[i]!;cap.visible=!this.holdingWater()&&(shape===KIT_CUBE||shape===ROUND)&&!occupied.has([c[0],c[1]+1,c[2]].join(","))&&!this.state.world.isSolid(x,y+1,z);cap.material=m.material;
      m.quaternion.copy(this.ghostQuat);
      m.position.set(x + 0.5, y + 0.5, z + 0.5);
    }
  }

  private handleCraft(recipe: CraftRecipe, many = false): void {
    const outKey = Object.keys(recipe.output)[0];
    if (!outKey) return;
    const before = countOf(this.state.inventory, outKey);
    const made = craftBatch(this.state.inventory, recipe, many ? 16 : 1);
    if (made === 0) return;
    this.sfx.play("checkpoint");
    this.holdCrafted(outKey);
    const gained = countOf(this.state.inventory, outKey) - before;
    const def = itemByKey(outKey);
    this.hud.toast(t(`🛠️ ${def?.ko ?? recipe.name} ${gained}개 만들었어요`, `🛠️ Crafted ${gained} ${def?.name ?? recipe.name}`));
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
    this.hud.toast(t(`${info.emoji} ${withObjectParticle(info.name)} 입양했어요`, `${info.emoji} You adopted the ${info.nameEn.toLowerCase()}!`));
    this.persist();
  }

  /**
   * Re-capture the mouse straight from a panel click. Picking a piece means
   * "let me place it", so stopping at "Click to play" first was one click too
   * many. Must run inside the click handler: browsers only grant pointer lock
   * during a user gesture.
   */
  private resumePlay(): void {
    // a hidden or minimised window cannot take the mouse; the card waits for its return
    if (this.locked || this.workshop.active || document.hidden) return;
    this.resumeUntil = performance.now() + 800;
    const canvas = this.renderer.renderer.domElement;
    try {
      // newer browsers return a promise that rejects instead of throwing
      void Promise.resolve(canvas.requestPointerLock()).catch(() => {});
    } catch {
      /* the hint stays up; a click on the world still resumes */
    }
  }

  private lastSaveSignature = "";
  private saveFailed = false;
  private persist(): void {
    this.lastSaveAt = Date.now();
    if (this.sync) return; // the class's field lives on the server
    // standing still with no edits: nothing to write, skip the serialise +
    // synchronous localStorage write entirely
    const signature = `${this.field?.absOriginX ?? 0},${this.field?.absOriginZ ?? 0}|${this.state.world.version}|${Math.round(this.body.x * 2)},${Math.round(this.body.y * 2)},${Math.round(this.body.z * 2)}|${JSON.stringify(this.state.inventory)}|${this.state.hotbar.join(",")}|${this.pet.species}|${this.state.furniture.version}`;
    if (signature === this.lastSaveSignature) return;
    this.state.player = { x: this.body.x, y: this.body.y, z: this.body.z };
    this.state.pet = this.pet.species;
    let saved = false;
    try {
      saved = this.field
        ? this.field.save(localStorage, this.state.inventory, this.state.player, this.state.pet, this.state.furniture.toJSON(), this.state.hotbar)
        : saveCraft(this.state, localStorage, Date.now());
    } catch { /* access to localStorage itself can be disabled by the browser */ }
    if (saved) {
      this.lastSaveSignature = signature;
      if (this.saveFailed) this.hud.toast(t("💾 자동 저장이 다시 정상 작동해요", "💾 Autosave is working again"));
    } else if (!this.saveFailed) {
      this.hud.toast(t("💾 자동 저장에 실패했어요. 최근 변경사항이 저장되지 않았으니 이 탭을 닫지 마세요", "💾 Autosave failed. Recent changes are not saved yet — please keep this tab open"));
    }
    this.saveFailed = !saved;
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
        if (o instanceof THREE.Mesh && !o.userData.heldItem) {
          const source = o.material as THREE.Material;
          let cloned = clones.get(source);
          if (!cloned) {
            cloned = source.clone();
            cloned.transparent = true;
            // transparent + DoubleSide makes three draw back then front faces, re-deriving the program twice a frame
            cloned.forceSinglePass = true;
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
    this.rig.setHeldOpacity(opacity);
  }

  /**
   * Ease the camera's eye height toward the body's so landings and terrain
   * steps read smoothly instead of snapping. Big gaps (long falls, respawns,
   * teleports) snap instantly so the view never trails the body.
   */
  private smoothEyeY = Number.NaN;
  private smoothedEyeY(bodyY: number, dt: number): number {
    const target = bodyY + POSTURE_EYE[this.seated ? "sit" : this.posture];
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
      if (this.disposed || !tex) return;
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
    const remaining=this.seatBlend/this.seatBlendDuration;
    const weight=remaining*remaining*(3-2*remaining);
    this.drawBody.addScaledVector(this.seatOffset,weight);
    return this.drawBody;
  }

  /**
   * Mouse capture is the browser's to decide: read it, never trust a cached
   * flag. Runs on every pointerlockchange and once a frame, so a missed or
   * late event can't leave the game thinking it holds (or lacks) the mouse.
   */
  private syncLock(): void {
    const locked = document.pointerLockElement === this.renderer.renderer.domElement;
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) {
      this.resumeUntil = 0;
      this.lockedAt = performance.now();
    }
    if (locked && this.workshop.active) {
      // a capture that lands while the lab is open would hide the cursor over its UI
      document.exitPointerLock();
      return;
    }
    this.hud.setPointerLocked(locked);
    if (locked) {
      // back in play: a panel left open would sit over the view, unusable
      this.furniture.closePanel();
      this.petShop.setOpen(false);
      this.hud.hideRecipes();
      this.emoteMenu.setOpen(false);
    } else {
      this.mining = false;
      this.placing = false;
    }
  }

  private render(alpha: number, frameDt: number): void {
    this.syncLock();
    const target=this.miningTarget,progress=this.miningFrac;
    if(this.locked&&(this.mining||this.itemAttack.active)&&!this.workshop.active&&target&&progress!==null&&!this.aimFurniture){
      const def=blockById(this.state.world.get(...target));if(def){const shape=this.state.world.getShape(...target);this.miningEffects.setProgress(target,def,shape,progress,()=>this.view.miningShape(shape,def.id,target,this.state.world));}else this.miningEffects.clearTarget();
    }else this.miningEffects.clearTarget();
    this.miningEffects.update(frameDt,this.state.world);
    const drawn = this.interpolatedBody(alpha);
    this.hud.syncMenu(this.workshop.active || this.furniture.panelOpen || this.petShop.open || this.emoteMenu.open
      || performance.now() < this.resumeUntil || document.querySelector(".class-ended") !== null);
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
    const anim = this.characterAnimation();
    this.rig.setHeldItem(this.heldTool(),this.toolOption);
    this.rig.setEmote(this.emote, this.emoteSeq);
    this.rig.performAction(this.workAction,this.workSeq,this.workLoop);
    this.rig.update(anim, planar, frameDt,{swimming:this.isSwimming(),toolTime:this.itemAttack.active?this.toolElapsed:undefined});
    this.cueSounds();
    { const cam = this.renderer.camera; this.sfx.setListener(cam.position.x, cam.position.y, cam.position.z, this.viewYaw, this.viewPitch);
      // how enclosed the ears are, a few times a second: the echo follows from the room's size
      if ((this.roomProbeIn -= frameDt) <= 0) { this.roomProbeIn = 0.25; this.sfx.setRoom(measureRoom([cam.position.x, cam.position.y, cam.position.z], (x, y, z) => this.state.world.isSolid(x, y, z))); } }

    const eye = this.tmpEye.set(drawn.x, this.smoothedEyeY(drawn.y, frameDt), drawn.z);
    const t0 = performance.now();
    const robotOpacity = this.camera.update(
      this.state.world,
      eye,
      this.viewYaw,
      this.viewPitch,
      planar > 0.8 && gaitBlend(planar) >= 0.5,
      frameDt,
    );
    this.applyRobotOpacity(this.debugHideRobot ? 0 : robotOpacity, frameDt);
    this.renderer.trackTarget(eye);
    this.updateUnderwater();
    this.view.animateWater(performance.now() / 1000, this.field?.absOriginX ?? 0, this.field?.absOriginZ ?? 0);

    this.updateGhost();
    this.hud.update(this.state.inventory, this.emptyHands ? -1 : this.selected, this.state.hotbar);
    this.hud.setMineProgress(this.miningFrac);
    this.perf.phase("camera", performance.now() - t0);
    this.perf.time("furniture", () => this.furniture.render(this.aim, this.yaw, this.locked && !this.mining, this.ghostOk, this.ghostBad));
    if (!this.furniture.active) {
      if(this.heldTool())this.hud.setPiece(t(`공격 모드 · 곡괭이 · ${PICKAXE.options.find(o=>o.id===this.toolOption)!.name} · R 옵션 · ${PICKAXE.targeting.reach}m`,`Attack · Pickaxe · ${this.toolOption} · R options · ${PICKAXE.targeting.reach}m`),0,0,"⛏️");
      else if (this.emptyHands) this.hud.setPiece(t("빈손 · Q로 블록 들기", "Empty hands · Q to hold blocks"), 0, 0, "✋");
      else this.hud.setPiece(PIECES[this.pieceIndex]!, this.pieceRot, this.pieceTilt);
    }
    this.perf.time("render", () => this.renderer.render());
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private readonly tmpEye = new THREE.Vector3();
  /** Eased movement input (see fixedUpdate). */
  private wishX = 0;
  private wishZ = 0;
  /** 1 is a run. Eases between the walk and the run while Shift is held. */
  private moveRatio = moveScale("stand", false);
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
    const emoting = this.emote !== "none" && this.posture === "stand" && this.moveYaw === null;
    const target = this.actionHold > 0 ? this.yaw : emoting ? this.viewYaw + Math.PI : this.moveYaw;
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
  /** Reflections for metal/gem/glass blocks (see render/skyEnvironment.ts). */
  private readonly skyEnvironment: THREE.WebGLRenderTarget;
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
    this.sfx.setUnderwater(under);
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
    const hooks = {
      snapshot: () => ({
        pos: [this.body.x, this.body.y, this.body.z],
        grounded: this.body.grounded,
        seed: this.state.seed,
        selected: this.selected,
        emptyHands: this.emptyHands,
        heldItem: this.heldTool(),
        attackMode: !!this.heldTool(),
        attacking: this.itemAttack.active,
        toolOption: this.toolOption,
        toolTime: this.toolElapsed,
        pitch: this.pitch,
        yaw: this.yaw,
        inventory: { ...this.state.inventory },
        hotbar: [...this.state.hotbar],
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
        return { wet: this.body.wet ?? 0, underwater: this.underwater, cells, sources, y: this.body.y, selected: this.heldKey() };
      },
      /** The live scene — for resource audits (duplicate materials/geometries). */
      scene: () => this.renderer.scene,
      cameraState: () => {
        const p = this.renderer.camera.position;
        const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
        return { dist: this.camera.distance, x: p.x, y: p.y, z: p.z, dirY: dir.y, t: performance.now() };
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
      sandStats:()=>this.sand?.stats()??null,
      waterStats: () => ({ ...this.view.waterStats(), simulation: this.water?.stats() ?? null }),
      chunks: () => this.view.chunkStats(),
      miningVisual:()=>this.miningEffects.stats(),
      audio: () => this.sfx.debug(),
      dispose: () => this.dispose(),
      machine: () => this.workshop.snapshot(),
      classroom: () => this.sync?.debug() ?? null,
      classSend: (msg: Parameters<ClassClient["send"]>[0]) => this.sync?.client.send(msg),
      absolute: () => (this.field ? this.field.toAbsolute(this.body.x, this.body.z) : null),
    };
    this.debugHooks = hooks;
    (window as unknown as Record<string, unknown>).__roboCraft = hooks;
  }
}


