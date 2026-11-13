import * as THREE from "three";
import { browserStorage } from "../ui/storage.js";
import { TouchControls, isTouchPlay } from "./touchControls.js";
import { framelessTile } from "./kitSurface.js";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu, warmupGpuAsync } from "../render/textures.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import { SeatingView } from "./seatingView.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { PerfMonitor } from "../ui/perf.js";
import { t } from "../ui/i18n.js";
import { onSettings, settings, updateSettings } from "../ui/settings.js";
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
  roomFor,
  slotForNew,
  fieldStarterHotbar,
  readStoredHotbar,
  removeItem,
  type CraftRecipe,
} from "./inventory.js";
import { CRAFT_SAVE_KEY, clearCraftSave, loadCraft, saveCraft, saveStatus, type CraftGameState } from "./craftSave.js";
import { FIELD_MAX_VIEW, FIELD_SAVE_KEY, FieldWindow, clearFieldSave, fieldStarterInventory } from "./fieldWorld.js";
import { SkyDome } from "./skyDome.js";
import { createSkyEnvironment } from "../render/skyEnvironment.js";
import { ClassSync } from "./classSync.js";
import type { ClassClient, ClassSession } from "../net/classClient.js";
import { SWIM_DEPTH, pointInWater, waterDepthAt, stepBody, unstick, overlapsShapedVoxel, overlapsVoxel, wishFromInput, type Body } from "./voxelBody.js";
import {SandSim} from "./sandSim.js";
import { WaterSim } from "./waterSim.js";
import type { WaterPipeline } from "../render/waterPipeline.js";
import { classKey, seatLayout, WATER, WATER_SETTLED, drawWaterByAmount, isWater, emoteDef, lookDirection, pickBonk, bonkBlocked, tapBeatsDig, BONK_COOLDOWN_MS, BONK_DECAY, BONK_PUSH_CAP, type EmoteId, type CharacterId, type ClassAnim, type CharacterAction, type CharacterPresentation, postureTransition } from "@robo/shared";
import { EmoteMenu } from "./emoteMenu.js";
import { adoptPosture, moveScale, POSTURE_EYE, type Posture } from "./posture.js";
import { gaitBlend } from "../player/motionPolicy.js";
import { CRAFT_SPAWN, WORLD_X, WORLD_Y, WORLD_Z, surfaceY, type RayHit } from "./voxelWorld.js";
import { PIECES, MAX_PIECE_CELLS, pieceCells, pieceShape } from "./pieces.js";
import { ROUND, KIT_CUBE, isOrientedShape, blockShapeFamily, shapeBoxes, shapeBounds } from "./shapes.js";
import {kitCubeGeometry,kitRampGeometry,kitConnectorGeometry,kitRoundGeometry,kitCellsGeometry,kitBoxesGeometry} from "./kitGeometry.js";
import {planPiecePlacement} from "./blockPlacement.js";
import {
  brickOrientation,
} from "./brickGeometry.js";
import { VoxelView } from "./voxelView.js";
import {preloadHeldItemsWithin} from "../player/heldItem.js";
import { loadBlockStuds } from "./blockStuds.js";
import {PICKAXE,pickaxeWork,pickaxeInReach,pickaxeCycle,pickaxeImpacts,pickaxeOptionName} from "./toolDefinitions.js";
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
import type { RustEngine } from "../engine/rustEngine.js";
import { FurnitureController, PICKUP_TIME } from "./furniture/controller.js";
import { ScienceMode, itemLabel } from "./science/scienceMode.js";
import { FireDrill, type FireSound } from "./fire/fireDrill.js";
import { fireSchoolCollision } from "./fire/fireSchoolView.js";
import { FIRE_CAMPUS, fireSchool, type ClassTheme } from "@robo/shared";
import { loadItemModels } from "./science/itemModels.js";
import { isFrameKey } from "./science/frames.js";
import { isPartKey } from "./science/parts.js";
import type { PlacedFurniture } from "./furniture/types.js";

/** The grid the near plane is measured on for how much of the screen is under water (updateUnderwater). */
const INSIDE_W = 16, INSIDE_H = 9;
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
/** The fire drill's sounds, as the shared synth's names. */
const FIRE_SOUNDS = { alarm: "alarm", spray: "spray", cough: "cough", good: "clear", step: "checkpoint", oof: "oof", click: "click", pickup: "pickup", crackle: "fire-crackle", roar: "fire-roar", hiss: "fire-hiss" } as const satisfies Record<FireSound, string>;
/** Keys the fire drill leaves alone: nothing is built, crafted, adopted or driven there. */
const FIRE_OFF_KEYS = new Set(["b", "t", "g", "i", "q", "y", "p", "f", "r", "x", "tab"]);
/** No walls anywhere: the room echo goes dry. */
const OPEN_AIR = { enclosure: 0, size: 14 } as const;

/**
 * The key a press means, by its physical position: with the Korean IME on,
 * `e.key` arrives as "ㄱ" or "Process" and R, Q, E… would do nothing.
 */
function keyName(e: KeyboardEvent): string {
  if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  return e.key.toLowerCase();
}

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
  /** Science mode (T): power-plant blueprints. Solo education field only for now (W1). */
  private readonly science: ScienceMode | null = null;
  /** The field's learning theme: the sandbox, or the fire drill (its school is the whole field,
   *  nothing is built, and `fire` runs the lesson). */
  private readonly theme: ClassTheme;
  private readonly fire: FireDrill | null = null;
  /** Dev hooks: run the drill without a captured mouse / hold the spray button. */
  private debugFirePlay = false;
  private debugFireSpray = false;
  private readonly firePlayer = { x: 0, y: 0, z: 0, facing: 0, speed: 0, eye: 0, opacity: 1 };
  private readonly fireLook = { yaw: 0, pitch: 0 };
  /** Dev only (solo field, F2): sample classroom plots with stand-in students, to see 자리 배치
   *  without a class. */
  private samples: { view: SeatingView; rigs: { rig: CharacterRig; pos: [number, number, number]; yaw: number }[] } | null = null;
  /** The field save's plants, held until science mode exists (it is built after the world). */
  private savedPlants: unknown = undefined;
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
  /** Phones and tablets: on-screen controls stand in for the captured mouse (null on a PC). */
  private touch: TouchControls | null = null;
  /** Touch play: the player chose to play (Play / a panel closed back to play); a panel or the menu still pauses it. */
  private touchPlaying = false;
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
  /** The class and seat this game plays in (classroom only): where our position is remembered. */
  private classSession: { room: string; you: string } | null = null;
  private seatBlendDuration = .65;
  private mining = false;
  /** Dev hook (`__roboCraft.mineProgress`): a dig shown on a cell without a captured mouse. */
  private debugMine: { cell: [number, number, number]; progress: number } | null = null;
  /** Dev hook (`__roboCraft.debugWalk`): [strafe, forward] held without a captured mouse. */
  private debugWalkInput: [number, number] | null = null;
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
  private ghostSlabGeo!: THREE.BufferGeometry;
  private ghostStairsGeo!: THREE.BufferGeometry;
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
    opts: { field?: boolean; classroom?: { client: ClassClient; session: ClassSession }; rust?: RustEngine | null; theme?: ClassTheme } = {},
  ) {
    // a class has its own theme; solo play is told one (only the education field has themes)
    this.theme = opts.classroom ? opts.classroom.session.theme : opts.field ? opts.theme ?? "craft" : "craft";
    const fireTheme = this.theme === "fire";
    this.renderer = new GameRenderer(mount);
    this.renderer.scene.fog = new THREE.Fog(FOG_COLOR, 95, 245);
    this.sky = new SkyDome(this.renderer.scene, SKY_TOP, FOG_COLOR);
    this.camera = new CraftCamera(this.renderer.camera);
    // ?blocks=classic draws the pre-v4 surfaces, for comparison
    this.view = new VoxelView(this.renderer.scene, { generatedSurfaces: new URLSearchParams(location.search).get("blocks") !== "classic" });
    this.view.useRustShells(opts.rust ?? null);
    if (fireTheme) {
      // the campus has its own ground: the field's chunks wholly under it are not drawn
      const [x0, x1, z0, z1] = FIRE_CAMPUS.bounds;
      this.view.setCovered((cx, cz) => {
        const field = this.field;
        if (!field) return false;
        const ax = cx * 16 + field.absOriginX, az = cz * 16 + field.absOriginZ;
        return ax >= x0 && ax + 16 <= x1 && az >= z0 && az + 16 <= z1;
      }, (x, z) => {
        const field = this.field;
        if (!field) return false;
        const ax = x + field.absOriginX, az = z + field.absOriginZ;
        return ax >= x0 && ax < x1 && az >= z0 && az < z1;
      });
    }
    this.skyEnvironment = createSkyEnvironment(this.renderer.renderer, SKY_TOP, FOG_COLOR, 0x9a8f78);
    this.view.setEnvironment(this.skyEnvironment.texture);
    this.miningEffects=new MiningEffects(this.renderer.scene,cell=>this.view.setMiningHidden(cell));
    // the world as an acoustic space: bricks block sound, glass/ice/leaves let most of it through,
    // water damps a little (read live, so field scrolls and classroom resyncs need nothing)
    this.sfx.setAcoustics((x, y, z) => {
      const id = this.state.world.get(x, y, z);
      // furniture is lighter than brick: a bookcase between you damps a sound, it does not wall it off
      if (!id) return this.state.world.propSolid?.(x, y, z) ? 0.6 : 0;
      const def = blockById(id);
      if (!def) return 0;
      if (def.fluid) return 0.15;
      if (def.seeThrough || def.key.endsWith("leaves")) return 0.35;
      return SOLID_ID[id] ? 1 : 0;
    });
    this.hud = new CraftHud(document.body, (recipe, many) => this.handleCraft(recipe, many), {
      furniture: true,
      science: !fireTheme && (opts.field === true || opts.classroom !== undefined),
      fire: fireTheme,
      creative: opts.field === true || opts.classroom !== undefined,
      mode: opts.classroom
        ? fireTheme ? t(`화재 체험 · ${opts.classroom.session.room}`, `Fire drill · ${opts.classroom.session.room}`)
          : t(`교실 · ${opts.classroom.session.room}`, `Class · ${opts.classroom.session.room}`)
        : fireTheme ? t("화재 체험 · 대피 훈련", "Fire drill")
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
        inventory: ensureFieldStacks(fieldStarterInventory(), true), // science mode's frames and parts too
        hotbar: readStoredHotbar(browserStorage(), CLASS_HOTBAR_KEY, fieldStarterHotbar),
        // back where this seat last stood (a refresh, or the automatic reload after a deploy);
        // a first visit spreads arrivals out so a whole class doesn't land in one cell
        // (the fire drill starts over in its classroom every visit)
        player: fireTheme ? this.fireSpawn()
          : this.rememberedClassPos(opts.classroom.session.room, opts.classroom.session.you)
          ?? { x: spawn.x + (Math.random() - 0.5) * 8, y: spawn.y, z: spawn.z + (Math.random() - 0.5) * 8 },
        pet: "dog",
        furniture: new FurnitureLayout(),
      };
      this.buildFieldGround();
    } else if (opts.field && fireTheme) {
      // the fire drill alone: the school stamped on an empty field; nothing is saved (and the
      // sandbox field's own save is never read or written)
      this.field = new FieldWindow();
      const school = fireSchool();
      this.field.replaceAll(school.edits);
      this.state = {
        seed: 0,
        world: this.field.world,
        inventory: {},
        hotbar: fieldStarterHotbar(),
        player: this.fireSpawn(),
        pet: "dog",
        furniture: new FurnitureLayout(),
      };
      this.state.furniture.load(school.furniture);
      this.buildFieldGround();
    } else if (opts.field) {
      if (reset) clearFieldSave(browserStorage());
      this.field = new FieldWindow();
      const saved = this.field.load(browserStorage());
      this.state = {
        seed: 0,
        world: this.field.world,
        inventory: ensureFieldStacks(saved?.inventory ?? {}, true), // the solo field has science mode: parts too
        hotbar: saved?.hotbar ?? fieldStarterHotbar(),
        player: saved?.player ?? this.field.spawn,
        pet: isPetSpecies(saved?.pet) ? saved.pet : "dog",
        furniture: new FurnitureLayout(),
      };
      this.state.furniture.load(saved?.furniture);
      this.savedPlants = saved?.plants;
      this.buildFieldGround();
    } else {
      if (reset) clearCraftSave(browserStorage());
      this.field = null;
      this.state = loadCraft(browserStorage(), DEFAULT_SEED);
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
      othersIn: (x, y, z) => this.sync?.bodyIn(x, y, z) ?? false,
      hud: this.hud,
      sfx: this.sfx,
      canBuild: () => this.canBuild(),
      canEditCell: (ax, az) => {
        if (!this.field || !this.sync) return true;
        const [gx, gz] = this.field.toGrid(ax, az);
        return this.sync.canEditAt(gx, gz);
      },
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
    if(fireTheme&&this.field){const field=this.field;this.state.world.staticScene=fireSchoolCollision(()=>[field.absOriginX,field.absOriginZ]);this.state.world.staticCameraScene=fireSchoolCollision(()=>[field.absOriginX,field.absOriginZ],true);}
    this.body = { ...this.state.player, vx: 0, vy: 0, vz: 0, grounded: false };
    unstick(this.state.world, this.body); // never spawn embedded in a block
    if (this.field && !fireTheme) {
      const field = this.field;
      const classroom = opts.classroom !== undefined;
      this.science = new ScienceMode({
        scene: this.renderer.scene,
        world: this.state.world,
        originX: () => field.absOriginX,
        originZ: () => field.absOriginZ,
        blockAt: (x, y, z) => field.blockIdAt(x, y, z),
        playerIn: (x, y, z) => overlapsVoxel(this.body, x, y, z),
        furnitureIn: (x, y, z) => this.furniture.blocksCell(x, y, z),
        ray: () => {
          const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
          return { ox: this.body.x, oy: this.body.y + POSTURE_EYE[this.seated ? "sit" : this.posture], oz: this.body.z, dx, dy, dz, reach: REACH };
        },
        heldKey: () => (this.emptyHands ? "" : this.heldKey()),
        // the education field never runs out (like its blocks): a part is only checked, not spent
        takeItem: (key, check) => (this.field || check ? countOf(this.state.inventory, key) > 0 : removeItem(this.state.inventory, key)),
        giveItem: (key, n) => { if (!this.field) addItem(this.state.inventory, key, n); },
        holdItem: (key) => { this.assignToHotbar(this.selected, key, false, true); this.emptyHands = false; },
        toast: (text) => this.hud.toast(text),
        sound: (name) => this.sfx.play(name),
        changed: () => { this.mining = this.placing = false; },
        openPanel: () => {
          this.hud.hideRecipes(); this.petShop.setOpen(false); this.furniture.closePanel();
          this.keys.clear(); this.mining = this.placing = false; this.rightHeld = false;
          document.exitPointerLock();
        },
        resumePlay: () => this.resumePlay(),
        // bodies and rays read propSolid live: nothing is cached to refresh
        solidsChanged: () => {},
        // a classroom's server judges every plant change (ClassSync exists by the time anyone builds)
        net: classroom ? {
          send: (op) => this.sync?.sendPlant(op),
          blocked: () => this.sync?.plantsLocked ? t("⚡ 지금은 선생님이 발전소 짓기를 잠가 뒀어요", "⚡ The teacher has power plants locked right now")
            : !this.sync || this.sync.canBuild() ? null
            : this.sync.frozen ? t("✋ 지금은 선생님을 봐요 — 짓기는 잠시 후에", "✋ Eyes on the teacher — build in a moment")
            : t("🔒 지금은 선생님이 짓기를 잠가 뒀어요", "🔒 The teacher has building locked right now"),
          canEditAt: (x, z) => this.sync?.canEditAbs(x, z) ?? true,
          mine: (owner) => this.sync?.role === "teacher" || classKey(owner) === classKey(this.sync?.myName ?? ""),
          own: (owner) => classKey(owner) === classKey(this.sync?.myName ?? ""),
        } : undefined,
      });
      // fitted plant items are solid: walls for bodies, targets for rays (furniture's hook stays first)
      const science = this.science;
      const furnitureSolid = this.state.world.propSolid;
      this.state.world.propSolid = (x, y, z) => (furnitureSolid?.(x, y, z) ?? false) || science.solidAt(x, y, z);
      const furnitureDry = this.state.world.propDry;
      this.state.world.propDry = (x, y, z) => (furnitureDry?.(x, y, z) ?? false) || science.solidAt(x, y, z);
      this.science.load(this.savedPlants);
      this.savedPlants = undefined;
    }
    this.renderer.scene.add(this.rig.root);
    this.pet = new PetCompanion(
      this.renderer.scene,
      this.state.world,
      { x: this.body.x + 1.2, y: this.body.y, z: this.body.z + 1.2 },
      this.state.pet,
    );
    this.petShop = new PetShop(document.body, this.state.pet, (species) => this.adoptPet(species),
      () => { this.furniture.closePanel(); this.hud.hideRecipes(); }, () => this.resumePlay());
    this.view.markDirty();
    this.applyViewDistance(this.loadViewPreset());
    // the view distance can change from the settings card (or O): apply it live
    this.offSettings = onSettings((st) => {
      if (st.view !== this.viewPreset) this.applyViewDistance(Math.min(VIEW_NAMES.length - 1, Math.max(0, st.view)));
    });
    this.buildGhost();
    if (opts.classroom && this.field) {
      this.classSession = { room: opts.classroom.session.room, you: opts.classroom.session.you };
      this.sync = new ClassSync(opts.classroom.client, opts.classroom.session, this.field, this.view,
        this.renderer.scene, {
          camera: () => this.renderer.camera,
          rescue: () => this.rescue(),
          teleport: (x, y, z) => {
            // a test drive keeps its machine, colliders and apron in grid coordinates: scrolling the
            // field under it would leave the machine on invisible old terrain — leave the lab first
            if (this.workshop.active) this.workshop.toggle();
            // a seated or crawling student is called over too (stepSeated would pin them to the seat)
            if (this.seated) this.standUp();
            if (this.posture !== "stand") this.changePosture("stand", false);
            this.body.x = x;
            this.body.y = y;
            this.body.z = z;
            this.body.vx = this.body.vy = this.body.vz = 0;
            this.knockX = this.knockZ = 0;
            // a far teacher lies outside the voxel window: scroll it there BEFORE unsticking, or the
            // check runs against empty ground and the class's buildings arrive around the student
            this.scrollField();
            unstick(this.state.world, this.body);
            this.prevBody.set(this.body.x, this.body.y, this.body.z);
            // standUp() started a blend from the seat; the body is somewhere else entirely now
            this.seatBlend = 0;
            this.pet.recall(this.state.world, this.body);
          },
          furnitureReset: () => this.furniture.forgetHistory(),
          face: (yaw) => {
            this.yaw = yaw;
            this.facing = yaw;
          },
          resumePlay: () => this.resumePlay(),
          viewYaw: () => this.yaw,
          panelBusy: () => this.workshop.active || this.furniture.panelOpen || this.petShop.open || this.emoteMenu.open
            || this.hud.recipesOpen || this.science?.panelOpen === true || this.fire?.panelOpen === true,
          furnitureMoved: () => {
            // a classmate's sofa can land on us (the server judges bodies at 10 Hz) or on the pet
            if (!this.seated) {
              const y = this.body.y;
              unstick(this.state.world, this.body);
              if (this.body.y !== y) this.prevBody.set(this.body.x, this.body.y, this.body.z);
            }
            unstick(this.state.world, this.pet.body);
          },
          solidPlaced: (x, y, z) => {
            // a classmate's brick (or a refused edit rolled back) landed where we stand: step out of it
            if (overlapsShapedVoxel(this.body, x, y, z, 0)) { unstick(this.state.world, this.body); this.prevBody.set(this.body.x, this.body.y, this.body.z); }
            if (overlapsShapedVoxel(this.pet.body, x, y, z, 0)) unstick(this.state.world, this.pet.body);
          },
          bonked: (push) => this.receiveBonk(push),
          chime: (kind) => this.sfx.play(kind === "time" ? "clear" : "checkpoint"),
          plants: (msg) => this.science?.applyNet(msg),
          drill: (msg) => this.fire?.applyClass(msg),
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

    if (fireTheme && this.field) {
      if(this.fieldGround)this.fieldGround.visible=false;
      const field = this.field;
      this.emptyHands = true; // nothing is held or placed here
      this.yaw = this.viewYaw = this.facing = fireSchool().spawnYaw;
      this.pitch = this.viewPitch = -0.12;
      const sync = this.sync;
      this.fire = new FireDrill({
        // a class: the teacher runs the drill (briefing, teams, start); alone it starts at once
        net: sync ? {
          role: sync.role,
          myName: () => sync.myName,
          students: () => sync.onlineStudents(),
          drill: (op) => sync.sendDrill({ t: "k-drill", ...op }),
          quizReport: (step, answered, score) => sync.sendDrill({ t: "k-drill-report", step, quiz: answered, quizScore: score }),
          mountTools: (title, content) => sync.hud.mountToolsSection(title, content, true), // the school is the theme's: no plot / build / water tools
          report: (step, stars, seconds) => sync.sendDrill({ t: "k-drill-report", step, ...(stars !== undefined ? { stars } : {}), ...(seconds !== undefined ? { seconds } : {}) }),
        } : undefined,
        scene: this.renderer.scene,
        pipeline: () => this.renderer.waterPipeline,
        characterRoot:()=>this.rig.root,
        firstPerson:()=>this.camera.firstPerson,
        characterVariant:()=>this.character,
        obstacle:(from,dir,range)=>this.state.world.raycastCamera(from.x,from.y,from.z,dir.x,dir.y,dir.z,range)?.dist??range,
        shadowsEnabled: () => this.renderer.renderer.shadowMap.enabled,
        originX: () => field.absOriginX,
        originZ: () => field.absOriginZ,
        toast: (text) => this.hud.toast(text),
        sound: (name) => this.sfx.play(FIRE_SOUNDS[name]),
        // from where it burns (absolute → the scene's coordinates): further is quieter, and it has a side
        soundAt: (name, x, y, z) => this.sfx.at(x - field.absOriginX, y, z - field.absOriginZ, () => this.sfx.play(FIRE_SOUNDS[name])),
        openPanel: () => {
          this.keys.clear(); this.mining = this.placing = false; this.rightHeld = false;
          if (document.pointerLockElement) document.exitPointerLock();
        },
        resumePlay: () => this.resumePlay(),
        teleport: (x, y, z, yaw) => this.teleportAbs(x, y, z, yaw),
        touch: isTouchPlay(),
        toggleLow: () => { if (this.locked) this.changePosture(this.posture === "stand" || this.posture === "sit" ? "crawl" : "stand"); },
      });
    }

    this.workshop = new MachineWorkshop(this.renderer.scene, this.renderer.camera,
      this.renderer.renderer, this.state.world, (active) => {
        this.keys.clear(); this.mining = this.placing = false;
        this.miningFrac = null; this.miningProgress = 0; this.miningTarget = null;
        this.hud.setWorkshopOpen(active);
        if (!active) {
          this.renderer.camera.clearViewOffset();
          this.resumePlay();
        }
      });

    this.bindInput(mount);
    if (isTouchPlay()) {
      this.touch = new TouchControls(document.body, {
        look: (dx, dy) => {
          if (!this.locked) return;
          const look = 0.0062 * settings.sensitivity;
          this.yaw -= dx * look;
          this.pitch = Math.min(1.35, Math.max(-1.25, this.pitch - dy * look * (settings.invertY ? -1 : 1)));
        },
        primary: (down) => { if (down) this.primaryDown(); else this.mining = false; },
        secondary: (down) => { if (down) this.secondaryDown(); else this.placing = this.rightHeld = false; },
        pause: () => { this.touchPlaying = false; this.syncLock(); },
        bag: () => { if (!this.workshop.active) this.toggleBag("e"); },
        emotes: () => this.openEmotes(),
        chat: this.sync ? () => this.sync?.hud.openChat() : null,
        tools: this.sync?.hud.hasTools ? () => this.sync?.hud.toggleTools() : null,
      });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.persist();
    }, { signal: this.events.signal });
    // Another tab of the same mode wrote this save: from now on this tab's
    // world is the stale one, and writing it would erase that tab's work.
    window.addEventListener("storage", (e) => {
      if (this.sync || this.savedElsewhere || e.key !== (this.field ? FIELD_SAVE_KEY : CRAFT_SAVE_KEY)) return;
      this.savedElsewhere = true;
      this.hud.toast(t(
        "💾 다른 탭에서 이 세계를 저장했어요. 이 탭은 더 저장하지 않아요 — 새로고침하면 최신 상태를 불러와요",
        "💾 This world was saved in another tab. This tab stops saving — reload to pick up the latest",
      ));
    }, { signal: this.events.signal });

    // solo play runs the water itself; a classroom's water is the server's
    // `?engine=rust`: the same rules in the Rust engine (docs/ENGINE.md), loaded by main.ts
    const layout = this.state.furniture;
    // The frame is built round the water — tint and murk by how much water each pixel looks
    // through, above, at and under the surface alike (docs/WATER_DESIGN_KO.md, stages A and B).
    // On by default where there is a mouse; a phone keeps the plain path until it is measured
    // there (`?water2=1` forces it on, `?water2=0` off).
    const water2 = new URLSearchParams(location.search).get("water2");
    if (water2 === "1" || water2 !== "0" && !isTouchPlay()) {
      this.waterPipeline = this.renderer.enableWaterPipeline();
      if (this.waterPipeline) this.view.useWaterPipeline(this.waterPipeline);
    }
    // `?water=finite` (solo): water is an amount — a bucket is one cell of it and a pool that is
    // opened runs out (packages/shared/src/fluidVolume.ts). Old poured water stays a spring.
    this.finiteWater = !this.sync && new URLSearchParams(location.search).get("water") === "finite";
    drawWaterByAmount(this.finiteWater);
    this.view.setFiniteWater(this.finiteWater);
    this.water = this.sync ? null : new WaterSim(this.state.world, this.view, this.field, {
      finite: this.finiteWater,
      rust: opts.rust ?? null,
      furniture: { version: () => layout.version, dryCells: () => layout.waterCells() },
    });
    this.water?.wakeAll();
    this.sand=this.sync?null:new SandSim(this.state.world,{scene:this.renderer.scene,shape:(block,shape,cell)=>this.view.miningShape(shape,block,cell,this.state.world),write:(x,y,z,block,shape)=>this.writeCell(x,y,z,block,shape),hidden:cells=>this.view.setFallingHidden(cells),canEnter:(x,y,z)=>!overlapsShapedVoxel(this.body,x,y,z,0)&&!overlapsShapedVoxel(this.pet.body,x,y,z,0)&&!this.furniture.blocksCell(x,y,z)});this.sand?.wakeAll();
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
  /** `?water2=1`: see where it is asked for. The pipeline draws the underwater look per pixel, so the
   *  wash and the fog switch below are the plain path's alone. */
  private waterPipeline: WaterPipeline | null = null;
  /** How much of the screen (from the bottom) is below the waterline, 0‒1. */
  private underwaterCover = 0;
  private underwater = false;
  /** How wet the body was last tick — a dry → wet change with speed splashes. */
  private lastWet = 0;

  private heldKey(): string {
    return this.state.hotbar[this.selected] ?? "";
  }

  /** Is the selected hotbar slot the water bucket? */
  /** Cells a placed block may not take: solid furniture, the pet (a block dropped on it buried it
   *  until the recall teleported it out), and a classmate (it popped them up out of the block). */
  private readonly buildBlocked = (x: number, y: number, z: number): boolean =>
    this.furniture.blocksCell(x, y, z) || !this.petsOff() && overlapsShapedVoxel(this.pet.body, x, y, z, 0) ||
    (this.science?.solidAt(x, y, z) ?? false) ||
    (this.sync?.bodyInGridCell(x, y, z, 0) ?? false) ||
    // a student kept on their plot builds only inside it
    !(this.sync?.canEditAt(x, z) ?? true);

  /** The teacher turned pets off for this class: no pet, no adoption chip, and P / Y do nothing. */
  private petsOff(): boolean { return this.theme === "fire" || (this.sync?.petsOff ?? false); }

  /** A free spot in the fire drill's classroom, in this window's grid coordinates. */
  private fireSpawn(): { x: number; y: number; z: number } {
    const spawns = fireSchool().spawns;
    const s = spawns[Math.floor(Math.random() * spawns.length)]!;
    const [gx, gz] = this.field!.toGrid(s[0], s[2]);
    return { x: gx, y: s[1], z: gz };
  }

  /** Stand at ABSOLUTE (x, y, z) on the field, optionally looking along `yaw` (the fire drill's retry and restart). */
  private teleportAbs(ax: number, y: number, az: number, yaw?: number): void {
    if (!this.field) return;
    if (this.seated) this.standUp();
    if (this.posture !== "stand") this.changePosture("stand", false);
    const [gx, gz] = this.field.toGrid(ax, az);
    this.body.x = gx; this.body.y = y; this.body.z = gz;
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.knockX = this.knockZ = 0;
    this.scrollField();
    unstick(this.state.world, this.body);
    this.prevBody.set(this.body.x, this.body.y, this.body.z);
    this.seatBlend = 0;
    if (yaw !== undefined) { this.yaw = this.facing = yaw; this.pitch = -0.12; }
  }

  /** A student waiting through the fire drill's briefing (or for their team's turn) stays in the classroom. */
  private keepInFireRoom(): void {
    const box = this.fire?.confineBox();
    if (!box || !this.field) return;
    const half = (this.body.w ?? 0.6) / 2 + 0.05, ox = this.field.absOriginX, oz = this.field.absOriginZ;
    const x0 = box[0] - ox + half, x1 = box[1] - ox - half, z0 = box[2] - oz + half, z1 = box[3] - oz - half;
    let hit = false;
    // far outside (a rejoin, a stopped run): the drill's own teleport brings them back, not this wall
    if (this.body.x < x0 - 3 || this.body.x > x1 + 3 || this.body.z < z0 - 3 || this.body.z > z1 + 3) return;
    if (this.body.x < x0) { this.body.x = x0; if (this.body.vx < 0) this.body.vx = 0; hit = true; }
    if (this.body.x > x1) { this.body.x = x1; if (this.body.vx > 0) this.body.vx = 0; hit = true; }
    if (this.body.z < z0) { this.body.z = z0; if (this.body.vz < 0) this.body.vz = 0; hit = true; }
    if (this.body.z > z1) { this.body.z = z1; if (this.body.vz > 0) this.body.vz = 0; hit = true; }
    const now = performance.now();
    if (hit && now - this.fenceToldAt > 6000) {
      this.fenceToldAt = now;
      this.hud.toast(t("🧑‍🏫 지금은 교실에서 선생님 설명을 들어요 — 출발 신호를 기다려요", "🧑‍🏫 Stay in the classroom for the briefing — wait for the go"));
    }
  }

  /** The fire drill's tick: where we stand, where we look, and whether the spray button is held. */
  private tickFire(dt: number): void {
    if (!this.fire || !this.field) return;
    const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
    const playing = this.locked || this.debugFirePlay;
    this.fire.tick(dt, {
      playing,
      x: this.body.x + this.field.absOriginX, y: this.body.y, z: this.body.z + this.field.absOriginZ,
      eyeY: this.body.y + POSTURE_EYE[this.seated ? "sit" : this.posture],
      dx, dy, dz,
      blockDist: this.aim?.dist ?? Infinity,
      spraying: playing && (this.mining || this.debugFireSpray),
    });
    if (this.fire.sprayingNow) this.actionHold = ACTION_FACE_TIME; // the body faces what it sprays
  }

  /**
   * The teacher's 땅 위로 올라오기 (F2): dug in and stuck. Up to the nearest place ABOVE where they
   * are with ground under it and room to stand: this very column under a roof of earth, and in an
   * open shaft (whose own column is air all the way up) the rim beside it.
   */
  private rescue(): void {
    const world = this.state.world, bx = Math.floor(this.body.x), bz = Math.floor(this.body.z);
    const standAt = (x: number, z: number): number => {
      for (let y = WORLD_Y - 3; y >= 1; y--)
        if (world.isBlocked(x, y - 1, z) && !world.isBlocked(x, y, z) && !world.isBlocked(x, y + 1, z)) return y;
      return -1;
    };
    // Only when actually dug in: earth over the head, or walled in on every side two blocks high
    // (a shaft). Standing in the open, "the nearest higher place" was the top of a student's tower.
    const feet = Math.floor(this.body.y + 0.01);
    let roofed = false;
    for (let y = feet + 2; y < WORLD_Y && !roofed; y++) roofed = world.isBlocked(bx, y, bz);
    const walled = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) =>
      world.isBlocked(bx + dx!, feet, bz + dz!) && world.isBlocked(bx + dx!, feet + 1, bz + dz!));
    if (!roofed && !walled) { this.hud.toast(t("이미 땅 위에 있어요", "You are already above ground")); return; }
    let spot: [number, number, number] | null = null;
    for (let r = 0; r <= 8 && !spot; r++)
      for (let dx = -r; dx <= r && !spot; dx++) for (let dz = -r; dz <= r && !spot; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || !world.inBounds(bx + dx, 1, bz + dz)) continue;
        const y = standAt(bx + dx, bz + dz);
        if (y > this.body.y + 0.5) spot = [bx + dx, y, bz + dz];
      }
    if (!spot) { this.hud.toast(t("이미 땅 위에 있어요", "You are already above ground")); return; }
    if (this.workshop.active) this.workshop.toggle();
    if (this.seated) this.standUp();
    if (this.posture !== "stand") this.changePosture("stand", false);
    this.body.x = spot[0] + 0.5; this.body.y = spot[1] + 0.05; this.body.z = spot[2] + 0.5;
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.knockX = this.knockZ = 0;
    this.prevBody.set(this.body.x, this.body.y, this.body.z);
    this.seatBlend = 0;
    this.pet.recall(world, this.body);
    this.hud.toast(t("↑ 땅 위로 올라왔어요", "↑ Back on the surface"));
  }

  /** `?water=finite`: see where the WaterSim is made. */
  private finiteWater = false;
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
    const slot = slotForNew(this.state.hotbar, this.selected);
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
    this.assignToHotbar(slotForNew(this.state.hotbar, this.selected), def.key);
  }

  /**
   * Everything slow, done behind the boot overlay before the first playable
   * frame: textures, every shader (in parallel where the browser can), and two
   * real frames through the whole pipeline. See `warmupGpuAsync`.
   */
  async prepare(setMessage: (text: string) => void = () => {}): Promise<void> {
    setMessage(t("텍스처 불러오는 중…", "Loading textures…"));
    // the Blender studs too: the first frame shows them, not the code twin
    await Promise.all([texturesReady(),preloadHeldItemsWithin(8000),loadBlockStuds(),this.fire?.ready,
      this.science ? Promise.race([loadItemModels(), new Promise((r) => setTimeout(r, 6000))]) : null]);
    if(!this.disposed)this.rig.setHeldItem(this.heldTool(),this.toolOption);
    if (this.disposed || this.started) return; // timed out (main.ts): start() warmed up its own way
    setMessage(t("그래픽 준비하는 중…", "Preparing graphics…"));
    this.furniture.setWarm(true);
    this.science?.setWarm(true); // holograms, part models, sparks, beacon
    this.view.setWarm(true); // the water shader, too
    this.miningEffects.prewarm(BLOCKS.filter((def) => !def.fluid).map((def) => ({ def, materials: this.view.miningMaterials(def.id) })));
    this.warming = true;
    this.sync?.warm(true, this.body); // a classroom: the first classmate's one-time cost, now
    try {
      await warmupGpuAsync(this.renderer.renderer, this.renderer.scene, this.renderer.camera, () => {
        if (!this.disposed && !this.started) this.render(1, 1 / 60); // once playing, the loop draws
      }, 2, this.events.signal, this.renderer.compileTargets());
    } catch (error) { if (!this.disposed) throw error; }
    if (this.disposed || this.started) return;
    this.endWarm();
  }

  /** Leave the warm-up state: ghosts and the highlight back where they belong. */
  private endWarm(): void {
    this.warming = false;
    this.furniture.setWarm(false);
    this.science?.setWarm(false);
    this.view.setWarm(false);
    this.miningEffects.endWarm();
    this.sync?.warm(false);
    this.warmed = true;
    this.facing = this.yaw; // start facing the way the camera looks
  }

  start(): void {
    if (this.disposed) return;
    this.started = true;
    this.loop.start();
    // A slow PC's warm-up outlived main.ts's 20 s limit: its shader compiles keep going in the
    // background, but play must not run with the ghosts parked at y = -1000.
    if (this.warming) { this.endWarm(); return; }
    // started without `prepare`, or before it reached the GPU step: warm up the old way
    if (!this.warmed) {
      void texturesReady().then(() => {
        if (this.disposed) return;
        warmupGpu(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
      });
    }
  }

  private warmed = false;
  private started = false;
  /** True only while `prepare` draws its warm-up frames. */
  private warming = false;

  /** Release the WebGL/audio-facing resources when the mode is replaced. */
  private offSettings: (() => void) | null = null;

  /**
   * Classroom plots: while the teacher keeps the class on its plots, a student cannot walk out of
   * theirs — the body is held inside the fence after every physics step (a wall, not a teleport;
   * the server pulls back anything that still gets out). Says why, now and then.
   */
  private keepInPlot(): void {
    const box = this.sync?.confineBox();
    if (!box) return;
    const half = (this.body.w ?? 0.6) / 2 + 0.05;
    const [x0, x1, z0, z1] = box;
    let hit = false;
    if (this.body.x < x0 + half) { this.body.x = x0 + half; if (this.body.vx < 0) this.body.vx = 0; hit = true; }
    if (this.body.x > x1 - half) { this.body.x = x1 - half; if (this.body.vx > 0) this.body.vx = 0; hit = true; }
    if (this.body.z < z0 + half) { this.body.z = z0 + half; if (this.body.vz < 0) this.body.vz = 0; hit = true; }
    if (this.body.z > z1 - half) { this.body.z = z1 - half; if (this.body.vz > 0) this.body.vz = 0; hit = true; }
    if (hit && this.knockX * this.knockX + this.knockZ * this.knockZ > 0) this.knockX = this.knockZ = 0;
    const now = performance.now();
    if (hit && now - this.fenceToldAt > 6000) {
      this.fenceToldAt = now;
      this.hud.toast(t("🪑 지금은 내 자리 안에서만 움직여요 — 선생님이 풀어 줄 때까지", "🪑 Stay on your plot for now — until the teacher lets you out"));
    }
  }
  private fenceToldAt = -Infinity;

  /** Moving while frozen: say why, now and then (the big card is already on screen). */
  private tellFrozen(): void {
    const now = performance.now();
    if (now - this.frozenToldAt < 5000) return;
    this.frozenToldAt = now;
    this.hud.toast(t("✋ 지금은 멈춰 있어요 — 선생님이 풀어 줄 때까지 기다려요", "✋ You're frozen — wait until the teacher lets you go"));
  }
  private frozenToldAt = -Infinity;

  /**
   * Dev (solo field): lay out the teacher's 자리 배치 for `count` stand-in students in front of the
   * player — the same layout, fences and name signs a class gets — or take it away again.
   */
  toggleSamplePlots(count = 12): number {
    if (this.samples) {
      this.samples.view.dispose();
      for (const r of this.samples.rigs) {
        this.renderer.scene.remove(r.rig.root);
        disposeRig(r.rig.root);
      }
      this.samples = null;
      this.hud.toast(t("🧹 샘플 자리를 치웠어요", "🧹 Sample plots put away"));
      return 0;
    }
    if (!this.field) return 0;
    const NAMES = ["민지", "준", "서연", "하준", "지우", "도윤", "서윤", "시우", "하은", "예준", "지아", "주원", "수아", "유준", "채원", "지호", "다은", "건우", "소율", "우진", "윤서", "선우", "나은", "현우"];
    const names = Array.from({ length: Math.max(1, Math.min(count, 60)) }, (_, i) => NAMES[i % NAMES.length]! + (i >= NAMES.length ? String(Math.floor(i / NAMES.length) + 1) : ""))
      .sort((a, b) => a.localeCompare(b, "ko"));
    const [ax, az] = this.field.toAbsolute(this.body.x, this.body.z);
    const spots = seatLayout(names.length, [ax, this.body.y, az], this.facing);
    const view = new SeatingView(this.renderer.scene);
    view.set(names.map((name, i) => ({ name, pos: spots[i]!.pos, yaw: spots[i]!.yaw })));
    const rigs = spots.map((spot) => {
      const rig = new CharacterRig("mascot");
      this.renderer.scene.add(rig.root);
      return { rig, pos: spot.pos, yaw: spot.yaw };
    });
    this.samples = { view, rigs };
    this.hud.toast(t(`🪑 샘플: 학생 ${names.length}명에게 15×20칸 땅을 나눠 줬어요 (F2 치우기)`, `🪑 Sample: ${names.length} students got a 15×20 plot each (F2 to clear)`));
    return names.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.samples) this.toggleSamplePlots();
    this.offSettings?.();
    this.loop.dispose();
    this.persist();
    this.events.abort();
    this.emoteMenu.dispose();
    this.touch?.dispose();
    if (document.pointerLockElement === this.renderer.renderer.domElement) document.exitPointerLock();
    const globals = window as unknown as Record<string, unknown>;
    if (globals.__roboCraft === this.debugHooks) delete globals.__roboCraft;
    this.debugHooks = null;
    this.water?.clear();
    this.water?.dispose();
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
    this.science?.dispose();
    this.fire?.dispose();
    this.bgm.dispose();
    this.sfx.dispose();
    this.perf.dispose();
    this.hud.dispose();
    this.ghostCubeGeo.dispose(); this.ghostRoundGeo.dispose(); this.ghostSlopeGeo.dispose();this.ghostCornerGeo.dispose();this.ghostSlabGeo.dispose();this.ghostStairsGeo.dispose();this.ghostCapGeo.dispose();this.ghostShellGeo?.dispose();
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
      if (this.touch) return; // touch plays from the menu's Play button; a stray tap must not resume
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
      this.touchPlaying = false;
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
      this.pitch = Math.min(1.35, Math.max(-1.25, this.pitch - dy * look * (settings.invertY ? -1 : 1)));
    });
    on("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.primaryDown();
      if (e.button === 2) this.secondaryDown();
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll cursor
        if (this.fire) return; // nothing to pick up in the drill
        const socketItem = this.science?.pickAimed();
        if (socketItem) { this.assignToHotbar(this.selected, socketItem, false, true); this.emptyHands = false; }
        else if (this.aimFurniture) this.furniture.pickKind(this.aimFurniture);
        else this.pickAimedBlock();
      }
    });
    on("mouseup", (e) => {
      if (e.button === 0) this.mining = false;
      if (e.button === 2) { this.placing = false; this.rightHeld = false; }
    });
    on("contextmenu", (e) => e.preventDefault());
    on("wheel", (e) => {
      if (!this.locked || this.fire) return;
      if (this.furniture.handleWheel(e.deltaY > 0)) return;
      this.selected = (this.selected + (e.deltaY > 0 ? 1 : this.state.hotbar.length - 1)) % this.state.hotbar.length;
      this.emptyHands = false; // picking a block means "let me build"
    });
    on("keydown", (e) => {
      if (e.target instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable)) return;
      if (this.emoteMenu.handleKey(e)) return;
      const key = keyName(e);
      if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey && !this.workshop.active) {
        e.preventDefault(); if (e.repeat) return;
        this.openEmotes(); return;
      }
      if (this.fire) {
        // the drill: E uses what is under the crosshair; a lesson card owns the keys while it is up
        if (key === "escape" && this.fire.panelOpen) { this.fire.closePanels(true); return; }
        // Tab: the class's board — teams and progress (the teacher's has the buttons)
        if (key === "tab") {
          e.preventDefault();
          if (!e.repeat && !this.sync?.toolsOpen && (this.locked || this.fire.boardOpen)) this.fire.toggleBoard();
          return;
        }
        if (this.fire.panelOpen) return;
        if (key === "e" && !e.ctrlKey && !e.metaKey && !e.altKey && !this.sync?.toolsOpen) {
          if (!e.repeat && this.locked && this.fire.interact()) this.beginWork("place");
          return;
        }
        if (FIRE_OFF_KEYS.has(key) || (key >= "0" && key <= "9")) return;
      }
      if (key === "b" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) { this.workshop.toggle(); return; }
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
      // past undo/redo, a Ctrl/Alt/Meta chord belongs to the browser: Ctrl+F is
      // find, not "next shape", and Ctrl+R a reload, not a rotation
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // an open bag owns E / I (furniture mode would take E for its categories and the bag could not be closed)
      if (this.hud.recipesOpen && (key === "e" || key === "i") && !e.repeat) { this.toggleBag(key); return; }
      // G from the bag goes straight to furniture: one panel at a time
      if (key === "g" && this.hud.recipesOpen) { this.hud.hideRecipes(); this.resumePlay(); }
      // T: science mode (power-plant blueprints). Shift+T still tips a block shape.
      if (key === "t" && !e.shiftKey && this.science) {
        if (!e.repeat) {
          if (this.furniture.active) this.furniture.select(null);
          this.science.toggle();
        }
        return;
      }
      if (key === "g" && this.science?.active) this.science.setActive(false); // furniture replaces it
      // dev, solo field: F2 lays out sample classroom plots (the teacher's 자리 배치) to look at
      if (key === "f2" && import.meta.env.DEV && this.field && !this.sync) {
        e.preventDefault();
        if (!e.repeat) this.toggleSamplePlots();
        return;
      }
      // Tab: the power plants' status board (it frees the mouse; Tab or Esc closes it)
      if (key === "tab" && this.science) {
        e.preventDefault();
        if (!e.repeat) this.science.toggleBoard();
        return;
      }
      if (key === "escape" && this.science?.panelOpen) {
        if (this.science.boardOpen) this.science.closeBoard(true);
        else this.science.closePanels(); // a mini-game: its close resumes play
        return;
      }
      // a science panel is up (board, mini-game): no second panel over it, no walking
      if (this.science?.panelOpen) return;
      if (this.sync?.toolsOpen) return; // the teacher's F2 class tools own the keys
      if (!e.shiftKey && this.science?.handleKey(key, e.repeat)) return;
      if (e.shiftKey && this.science?.active && (key === "r" || key === "t")) return; // no hidden shape changes
      // furniture's keys first: in furniture mode 1-9, Q/E, X and R are its own
      if (this.furniture.handleKey(key, e.repeat)) return;
      if (key >= "1" && key <= "9") {
        this.selected = Number(key) - 1;
        this.emptyHands = false;
        if (this.hud.recipesOpen) this.hud.armBag(this.selected);
      }
      if (key === "0") { this.selected = WATER_SLOT; this.emptyHands = false; }
      if(key==="r"&&!e.repeat&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&this.heldTool()){
        if(this.hud.recipesOpen)return; // the bag is up: R is not the pickaxe's
        const index=PICKAXE.options.findIndex(o=>o.id===this.toolOption);this.toolOption=PICKAXE.options[(index+1)%PICKAXE.options.length]!.id as import("@robo/shared").ToolOptionId;
        this.itemAttack.reset();this.beginWork("none");this.mining=false;this.clearMiningTarget();
        this.hud.toast(`${t("곡괭이", "Pickaxe")} · ${pickaxeOptionName(this.toolOption)}`);return;
      }
      // Q (furniture mode keeps Q for its categories, handled above)
      if (key === "q" && !e.repeat) {
        this.emptyHands = !this.emptyHands;
        this.mining = this.placing = false;
        this.hud.toast(this.emptyHands
          ? t("✋ 빈손 — 캐기만 해요, 놓지 않아요 · Q로 다시 들기", "✋ Empty hands — mine only, nothing is placed · Q to pick blocks back up")
          : t("🧱 블록 쌓기 — 다시 놓을 수 있어요", "🧱 Building — placing again"));
      }
      if ((key === "e" || key === "i") && !e.repeat) this.toggleBag(key);
      if (key === "escape" && this.hud.recipesOpen) {
        this.hud.hideRecipes();
        this.resumePlay();
        return;
      }
      if (key === "v" && !e.repeat) this.camera.toggleView();
      if (key === "p" && !e.repeat && !this.petsOff()) {
        this.hud.toast(this.pet.toggleMode() === "stay" ? t("🐶 앉아! 여기서 기다려요", "🐶 Buddy: stay") : t("🐶 따라와! 다시 따라와요", "🐶 Buddy: follow"));
      }
      // Y opens and closes the adoption panel (Ctrl+Y, handled above, is redo)
      if (key === "y" && !e.repeat && !this.petsOff()) this.petShop.toggle(); // its onOpen closes the bag and the furniture panel
      if (key === "o" && !e.repeat) {
        const next = (this.viewPreset + 1) % VIEW_NAMES.length;
        updateSettings({ view: next }); // the settings listener applies it
        this.hud.toast(`👁️ ${t("시야 거리", "View distance")}: ${viewName(next)} (${this.viewPresets[next]} m)`);
      }
      if (key === "r" && e.shiftKey && !e.repeat) {this.pieceRot=0;this.pieceTilt=0;this.hud.toast(t("기본 방향으로 맞췄어요", "Reset to upright"));return;}
      if (key === "r" && !e.repeat) this.pieceRot = (this.pieceRot + 1) % 4; // spin (yaw)
      // tip sideways (tilt): Shift+T where T is science mode, plain T elsewhere
      if (key === "t" && !e.repeat && (e.shiftKey || !this.science)) this.pieceTilt = (this.pieceTilt + 1) % 4;
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

  /** Left mouse / ⛏: a classmate under the crosshair is tapped, whatever is in hand; otherwise the pickaxe swings or the hand digs. */
  private primaryDown(): void {
    // with an extinguisher in hand the button sprays: no tap on a classmate standing in the way
    if (!this.fire?.holding && this.tryBonk()) return;
    if(!this.emptyHands&&toolByKey(this.heldKey())){const key=this.attackIdentity();if(key)this.itemAttack.request(key);}
    this.mining = true;
  }

  /** Right mouse / 🧱: place (held: keep building), sit, open a door. */
  private secondaryDown(): void {
    this.placing = true; this.rightHeld = true; this.sciHold = 0;
  }

  /** C / 😊: the emote and character menu (it takes the screen like the bag). */
  private openEmotes(): void {
    if (this.workshop.active) return;
    this.hud.hideRecipes(); this.petShop.setOpen(false); this.furniture.closePanel();
    this.keys.clear(); this.mining = this.placing = false;
    this.emoteMenu.setOpen(true); document.exitPointerLock();
  }

  /** Jump / stand up: Space, or the jump touch button. */
  private jumpHeld(): boolean {
    return this.keys.has("Space") || this.touch?.jump === true;
  }

  /** Any move input this tick: WASD, or the touch joystick off centre. */
  private moveHeld(): boolean {
    return ["KeyW","KeyA","KeyS","KeyD"].some((k) => this.keys.has(k)) || (this.touch !== null && (this.touch.moveX !== 0 || this.touch.moveZ !== 0));
  }

  /** E (blocks) / I (recipes): open that bag tab, or close the bag. Opening it closes every other panel. */
  private toggleBag(key: "e" | "i"): void {
    const open = this.hud.toggleBag(key === "i" ? "craft" : "blocks", this.selected);
    if (open) {
      this.petShop.setOpen(false);
      this.furniture.closePanel();
      this.keys.clear();
      this.mining = this.placing = false;
      document.exitPointerLock();
    } else this.resumePlay();
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
    const movement = this.locked && this.moveHeld();
    // standing can fail under a low ceiling: then moving still turns lying into crawling
    const stood = this.locked && this.jumpHeld() && this.posture !== "stand" && this.changePosture("stand",false);
    if (stood) { /* up */ }
    else if (movement && this.posture === "lie") this.changePosture("crawl",false);
    else if (movement && this.posture === "sit") this.changePosture("stand",false);
    if (this.seated && this.stepSeated()) {
      this.perf.time("pet", () => this.pet.fixedUpdate(this.state.world, dt, this.body));
      this.perf.time("aim", () => this.updateAim());
      this.tickFire(dt);
      this.stepInteraction(dt);
      if (this.placing) {
        this.tryPlace();
        this.placing = false;
      }
      return;
    }
    let fwd = 0;
    let strafe = 0;
    // the teacher froze the class (F2 → 모두 멈춰): a student stands still until let go
    const frozen = this.sync?.frozen === true;
    if (frozen && movement) this.tellFrozen();
    if (!frozen && this.locked && this.posture !== "lie" && this.postureDelay <= 0 && !this.rig.postureBusy && !this.emoteMenu.open) {
      if (this.keys.has("KeyW")) fwd += 1;
      if (this.keys.has("KeyS")) fwd -= 1;
      if (this.keys.has("KeyA")) strafe -= 1;
      if (this.keys.has("KeyD")) strafe += 1;
      if (this.touch) { fwd += this.touch.moveZ; strafe += this.touch.moveX; }
    }
    // dev hook (`__roboCraft.debugWalk`): hold movement without a captured mouse, for headless checks
    if (this.debugWalkInput && !frozen) { fwd = this.debugWalkInput[1]; strafe = this.debugWalkInput[0]; }
    // a joystick part-way out walks slower; keys (length >= 1) are full speed
    const push = Math.min(1, Math.hypot(fwd, strafe));
    const [unitX, unitZ] = wishFromInput(this.yaw, fwd, strafe);
    const rawX = unitX * push, rawZ = unitZ * push;
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
    // touch: the joystick pushed to its rim runs (there is no Shift)
    const sprint = this.posture === "stand" && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || (this.touch !== null && Math.hypot(this.touch.moveX, this.touch.moveZ) > 0.95));
    const targetRatio = moveScale(this.posture, sprint, this.isSwimming());
    // Crawl and swimming snap. On foot, Shift eases up into the run and back down into the walk.
    if (this.posture !== "stand" || this.isSwimming()) this.moveRatio = targetRatio;
    else this.moveRatio += (targetRatio - this.moveRatio) * approach(dt, sprint ? 0.06 : 0.09);
    const wishX = this.wishX * this.moveRatio;
    const wishZ = this.wishZ * this.moveRatio;
    this.prevVy = this.body.vy;
    this.perf.time("physics", () => stepBody(this.state.world, this.body, dt, wishX, wishZ, !frozen && this.locked && this.posture === "stand" && this.postureDelay <= 0 && !this.rig.postureBusy && this.jumpHeld(), this.knockX, this.knockZ));
    this.keepInPlot();
    this.keepInFireRoom();
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
    this.scrollField();

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
    this.tickFire(dt);
    this.stepInteraction(dt);
    if (this.placing) {
      this.tryPlace();
      this.placing = false; // one block per press
    }
    // power plants: holding the right button keeps building, one piece every 0.3 s after a beat
    if (this.rightHeld && this.science && this.locked) {
      this.sciHold += dt;
      if (this.sciHold >= 0.45) {
        this.sciHold -= 0.3;
        if (this.science.holdBuild()) this.beginWork("place");
      }
    }

    if (Date.now() - this.lastSaveAt > SAVE_INTERVAL_MS) this.perf.time("save", () => this.persist());
  }

  private updateAim(): void {
    const eyeY = this.body.y + POSTURE_EYE[this.seated ? "sit" : this.posture];
    const [dx, dy, dz] = lookDirection(this.yaw, this.pitch);
    // furniture stops the ray too: you aim at a chair, not the floor under it
    // holding the bucket, water is a target too (to scoop it back up)
    // — but not with the eye under water: the ray stopped in the cell around
    // our own head, so nothing else could be aimed at, mined or built on
    const fluids = this.holdingWater() && !pointInWater(this.state.world, this.body.x, eyeY, this.body.z);
    this.aim = this.state.world.raycast(this.body.x, eyeY, this.body.z, dx, dy, dz, REACH, true, fluids);
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
        if (def) this.blockSound("hit", surfaceStyle(def.key).family, this.miningTarget);
      }
      this.cueDig = cue.digPhase;
    } else this.cueDig = -1;
  }

  /** Our own block sound, heard from where the block is (its direction, not a flat centre). */
  private blockSound(kind: "hit" | "break" | "place", family: string, cell: readonly [number, number, number]): void {
    this.sfx.at(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5, () => this.sfx.material(kind, family), { own: true });
  }

  private heldTool(){return this.furniture.active?null:selectedTool(this.state.inventory,this.state.hotbar,this.selected,this.emptyHands);}
  /** A swing STARTS on the ground; one already under way finishes through a hop or a one-block step down instead of cancelling (and wiping the crack). */
  private usingPickaxe():boolean {return !!this.heldTool()&&this.posture==="stand"&&!this.seated&&!this.isSwimming()&&(this.body.grounded||this.itemAttack.active)&&!this.rig.postureBusy;}
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
    // heldTool(), not the raw slot: furniture mode puts the pickaxe away, and
    // the slot alone blocked holding left click to put a piece away
    else if(this.heldTool())this.clearMiningTarget();
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
    // a fitted power-plant item: a held left click takes it back out (like putting furniture away)
    if (this.aim && this.science?.fittedAt(...this.aim.voxel)) {
      this.stepTakeOut(this.aim.voxel, dt);
      return;
    }
    this.takeOutKey = "";
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
    if (!def || def.hardness <= 0 || !this.canBuild() || !this.mayEditAt(x, z)) {
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
    if(strike&&pickaxeImpacts(strike.from,strike.to,this.toolOption)>0&&this.miningProgress<def.hardness)this.blockSound("hit",family,[x,y,z]);
    // hand digging taps when the hand meets the block (render-side cue); a rig without cues taps on a beat
    if(!strike&&!this.rig.motionCue&&(this.hitBeat-=dt)<=0){this.hitBeat=.35;if(this.miningProgress<def.hardness)this.blockSound("hit",family,[x,y,z]);}
    this.miningFrac = this.miningProgress/def.hardness;
    if (this.miningProgress >= def.hardness && !roomFor(this.state.inventory, dropOf(def))) {
      // a full pile would swallow the drop: the block holds, cracked, until there is room
      this.miningProgress = def.hardness * 0.98;
      this.miningFrac = 0.98;
      this.bagFullToast();
      return;
    }
    if (this.miningProgress >= def.hardness) {
      this.miningEffects.burst([x,y,z],def,shape,()=>this.view.miningShape(shape,def.id,[x,y,z],this.state.world));
      this.writeCell(x, y, z, AIR, 0);
      addItem(this.state.inventory, dropOf(def));
      this.miningTarget = null;
      this.miningProgress = 0;
      this.miningFrac = null;
      this.blockSound("break",family,[x,y,z]);
      this.camera.addShake(0.04);
    }
  }

  /** Next time the "bag is full" toast may show (ms), so held mining does not repeat it every tick. */
  private fullToastAt = 0;
  private bagFullToast(): void {
    if (performance.now() < this.fullToastAt) return;
    this.fullToastAt = performance.now() + 3000;
    this.hud.toast(t("그 블록은 가방에 가득 찼어요 (9999개)", "Your bag is full of that block (9999)"));
  }
  /** Education field: slide the voxel window under the player (repeats until it is centred: a gather can jump far). */
  private scrollField(): void {
    if (!this.field) return;
    for (let guard = 0; guard < 64; guard++) {
      const shift = this.field.recenter(this.body);
      if (!shift) return;
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
      // the camera moves with the window too: anything reading it before this frame's camera
      // update (culling, LOD) must not see the old window's coordinates
      this.renderer.camera.position.x -= shift.dx;
      this.renderer.camera.position.z -= shift.dz;
      this.renderer.camera.updateMatrixWorld();
      // the aimed cell was a grid coordinate: re-aim, or a frame drawn before the next tick
      // highlights a different absolute block
      this.updateAim();
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
    // a block under the aim box is dug unless the classmate is clearly in front of it (and not
    // overlapping us — then they cross the look ray at ~0 m whatever we aim at)
    if (!tapBeatsDig(this.body, hit, this.aim ? this.aim.dist : null)) return false;
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
    if (this.workshop?.active) return "idle";
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
      this.locked && (this.moveHeld() || this.jumpHeld());
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
    if (!this.mayEditAt(x, z)) return;
    if (!this.canBuild()) {
      this.hud.toast(t("🧱 지금은 건축이 잠겨 있어요", "🧱 Building is locked right now"));
      return;
    }
    if (!this.finiteWater && id !== WATER && id !== WATER_SETTLED) {
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
    const poured = this.finiteWater ? WATER_SETTLED : WATER; // finite: one cell of water, not a spring
    if (world.get(x, y, z) === poured) return;
    this.writeCell(x, y, z, poured, 0);
    this.sfx.play("pour");this.beginWork("place");
  }

  /** Held left click on furniture: a short hold puts it away (it is free). */
  /** The right mouse button is down, and for how long (power plants build while it is held). */
  private rightHeld = false;
  private sciHold = 0;

  /** The fitted item being taken out ("x,y,z" of its cell) and the hold so far. */
  private takeOutKey = "";

  private stepTakeOut(cell: [number, number, number], dt: number): void {
    const key = cell.join(",");
    if (this.takeOutKey !== key) {
      this.takeOutKey = key;
      this.miningProgress = 0;
    }
    this.miningTarget = null;
    this.miningProgress += dt;
    this.beginWork("interact", true);
    this.miningFrac = this.miningProgress / PICKUP_TIME;
    if (this.miningProgress < PICKUP_TIME) return;
    this.science?.takeOutAt(...cell);
    this.takeOutKey = "";
    this.miningProgress = 0;
    this.miningFrac = null;
    this.mining = false; // one piece per hold: no chain of take-outs
  }

  private stepPickup(item: PlacedFurniture, dt: number): void {
    // every cell of the piece, not just its anchor (a sofa reaching over the fence)
    const offPlot = this.state.furniture.cellsOf(item).find(([cx, , cz]) => {
      const [gx, gz] = this.field ? this.field.toGrid(cx, cz) : [cx, cz];
      return !(this.sync?.canEditAt(gx, gz) ?? true);
    });
    const [pgx, pgz] = offPlot ? (this.field ? this.field.toGrid(offPlot[0], offPlot[2]) : [offPlot[0], offPlot[2]]) : [0, 0];
    if (!this.canBuild() || (offPlot !== undefined && !this.mayEditAt(pgx, pgz))) {
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
    // the fire drill: a right click (the 🧱 touch button) uses the station under the crosshair
    if (this.fire?.interact()) { this.beginWork("place"); return; }
    // right click ON a door/gate/curtain opens or closes it, whatever you hold
    if (this.aimFurniture && this.furniture.interact(this.aimFurniture)) { this.beginWork("place"); return; }
    // ...and on a chair, sofa or bed you sit down — unless you are placing
    // furniture, where the click means "put the piece here"
    if (this.aimFurniture && !this.furniture.active && this.trySit(this.aimFurniture)) return;
    // power plants: fit a part into the aimed gold slot, or switch a ready plant on (any mode)
    if (this.science?.interact()) { this.beginWork("place"); return; }
    // science mode: a right click lays the previewed power-plant blueprint
    if (this.science?.active) {
      if (this.science.place()) this.beginWork("place");
      return;
    }
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
    if (held && this.stampPiece(this.aim.before, held)) { this.blockSound("place", surfaceStyle(held).family, this.aim.before); this.beginWork("place"); }
  }

  /** Try to place the active piece with anchor at `before`; true if it landed. */
  private stampPiece(before:[number,number,number],key:string):boolean {
    if(!key||!blockByKey(key))return false;
    const plan=planPiecePlacement(this.state.world,this.body,PIECES[this.pieceIndex]!,this.pieceRot,this.pieceTilt,before,countOf(this.state.inventory,key),this.buildBlocked);
    if(!plan)return false;const id=blockByKey(key)!.id;
    // education fields are free building (999 of everything, never running out); the island spends its blocks
    for(const [x,y,z] of plan.cells){if(!this.field)removeItem(this.state.inventory,key);this.writeCell(x,y,z,id,plan.shape);}
    return true;
  }

  /** Every local block write: world, renderer and (in a class) the network. */
  private writeCell(x: number, y: number, z: number, block: number, shape: number): void {
    const world = this.state.world;
    const prevBlock = world.get(x, y, z);
    const prevShape = world.getShape(x, y, z);
    // mining a shaped block that held water leaves that water standing in the cell (no dry flash
    // until the next flow step). A classroom still sends air: the server makes the same swap.
    const held = block === AIR ? world.wetAt(x, y, z) : 0;
    world.setShaped(x, y, z, block, shape);
    if (held) world.set(x, y, z, held);
    if (SOLID_ID[prevBlock] === 0 && SOLID_ID[block] === 0) this.view.markWaterDirty(x, y, z);
    else { this.view.markCellDirty(x, y, z); this.view.markWaterDirty(x, y, z); }
    this.water?.touch(x, y, z); // water around it may flow in, or drain
    this.sand?.touch(x,y,z);
    this.sync?.recordEdit(x, y, z, prevBlock, prevShape, block, shape);
    if (block === AIR) this.furniture.onBlockRemoved(x, y, z);
    this.science?.onCellWritten(x + (this.field?.absOriginX ?? 0), y, z + (this.field?.absOriginZ ?? 0));
  }

  /** A classroom student kept on their plot may change only its cells (grid x, z); says so now and then. */
  private mayEditAt(x: number, z: number): boolean {
    if (this.sync?.canEditAt(x, z) ?? true) return true;
    const now = performance.now();
    if (now - this.plotEditToldAt > 4000) {
      this.plotEditToldAt = now;
      this.hud.toast(t("🪑 지금은 내 자리 안의 블록만 바꿀 수 있어요", "🪑 Only the blocks on your own plot, for now"));
    }
    return false;
  }
  private plotEditToldAt = -Infinity;

  private canBuild(): boolean {
    if (this.theme === "fire") return false; // the drill's school is not for building
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
    this.ghostSlabGeo = kitBoxesGeometry(shapeBoxes("slab")!);
    this.ghostStairsGeo = kitBoxesGeometry(shapeBoxes("stairs")!);
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
    if (!this.locked || !this.aim || this.mining || this.furniture.active || this.science?.active || this.emptyHands || !!this.heldTool() || isPartKey(this.heldKey()) || isFrameKey(this.heldKey())) {
      for (const m of this.ghostMeshes) m.visible = false;
      return;
    }
    // the bucket pours one cell, whatever brick shape is picked
    const piece = this.holdingWater() ? PIECES[0]! : PIECES[this.pieceIndex]!;
    const shape=pieceShape(piece,this.pieceRot,this.pieceTilt);
    const family=blockShapeFamily(shape);
    const geo=shape===ROUND?this.ghostRoundGeo:family==="corner"?this.ghostCornerGeo:family==="slab"?this.ghostSlabGeo:family==="stairs"?this.ghostStairsGeo:isOrientedShape(shape)?this.ghostSlopeGeo:this.ghostCubeGeo;
    if(isOrientedShape(shape))brickOrientation(this.pieceRot,this.pieceTilt,this.ghostQuat);else this.ghostQuat.identity();
    const cells = this.holdingWater() ? [[0, 0, 0] as const] : pieceCells(piece, this.pieceRot, this.pieceTilt);
    const [ax, ay, az] = this.aim.before;
    const valid=this.canBuild() && (this.holdingWater() ? this.state.world.inBounds(ax,ay,az)&&this.state.world.isReplaceable(ax,ay,az)&&!this.furniture.blocksCell(ax,ay,az) : planPiecePlacement(this.state.world,this.body,piece,this.pieceRot,this.pieceTilt,[ax,ay,az],countOf(this.state.inventory,this.heldKey()),this.buildBlocked)!==null);
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
    // the chip or button that closed the panel keeps focus otherwise, and the
    // next Space (jump) or Enter "clicks" it and opens the panel again
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused !== document.body) focused.blur();
    if (this.touch) {
      this.touchPlaying = true;
      this.resumeUntil = 0;
      this.syncLock();
      return;
    }
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
  private savedElsewhere = false;
  /** Classroom: where this seat stood, in absolute field coordinates (localStorage, per class + seat). */
  private classPosKey(room: string, you: string): string {
    return `craftyap-class-pos:${room.trim().replace(/\s+/g, " ").toLowerCase()}:${you}`;
  }

  private rememberClassPos(): void {
    const session = this.classSession;
    if (!session || !this.field) return;
    const [ax, az] = this.field.toAbsolute(this.body.x, this.body.z);
    try {
      localStorage.setItem(this.classPosKey(session.room, session.you), JSON.stringify({ x: ax, y: this.body.y, z: az, at: Date.now() }));
    } catch { /* storage is optional: the class spawn is the fallback */ }
  }

  /** The remembered absolute spot converted to this window's grid, if recent (12 h) and sane. */
  private rememberedClassPos(room: string, you: string): { x: number; y: number; z: number } | null {
    try {
      const raw = localStorage.getItem(this.classPosKey(room, you));
      if (!raw) return null;
      const p = JSON.parse(raw) as { x?: unknown; y?: unknown; z?: unknown; at?: unknown };
      if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number" || typeof p.at !== "number") return null;
      if (![p.x, p.y, p.z].every(Number.isFinite) || Date.now() - p.at > 12 * 3600_000 || p.y < 1 || p.y > 60) return null;
      const [gx, gz] = this.field!.toGrid(p.x, p.z);
      return { x: gx, y: p.y, z: gz };
    } catch {
      return null;
    }
  }

  private persist(): void {
    this.lastSaveAt = Date.now();
    if (this.theme === "fire") return; // the drill starts over every visit: nothing to keep
    if (this.sync) { this.rememberClassPos(); return; } // the class's field lives on the server; our spot is ours
    if (this.savedElsewhere) return; // another tab owns the save now
    // standing still with no edits: nothing to write, skip the serialise +
    // synchronous localStorage write entirely
    const signature = `${this.field?.absOriginX ?? 0},${this.field?.absOriginZ ?? 0}|${this.state.world.version}|${Math.round(this.body.x * 2)},${Math.round(this.body.y * 2)},${Math.round(this.body.z * 2)}|${JSON.stringify(this.state.inventory)}|${this.state.hotbar.join(",")}|${this.pet.species}|${this.state.furniture.version}|${this.science?.version ?? 0}`;
    if (signature === this.lastSaveSignature) return;
    this.state.player = { x: this.body.x, y: this.body.y, z: this.body.z };
    this.state.pet = this.pet.species;
    let saved = false;
    try {
      saved = this.field
        ? this.field.save(browserStorage(), this.state.inventory, this.state.player, this.state.pet, this.state.furniture.toJSON(), this.state.hotbar, this.science?.toJSON())
        : saveCraft(this.state, browserStorage(), Date.now());
    } catch { /* access to localStorage itself can be disabled by the browser */ }
    if (saved) {
      this.lastSaveSignature = signature;
      if (this.saveFailed) this.hud.toast(t("💾 자동 저장이 다시 정상 작동해요", "💾 Autosave is working again"));
    } else if (!this.saveFailed) {
      this.hud.toast(saveStatus.tooBig
        ? t("💾 자동 저장에 실패했어요 — 브라우저 저장 공간이 꽉 찼어요. 지은 것을 조금 치우면 다시 저장돼요", "💾 Autosave failed — the browser's storage is full. Take down some of your builds and it will save again")
        : t("💾 자동 저장에 실패했어요. 최근 변경사항이 저장되지 않았으니 이 탭을 닫지 마세요", "💾 Autosave failed. Recent changes are not saved yet — please keep this tab open"));
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
      const tiled = framelessTile(tex).clone(); // the far plane continues the bricks: no tile grid
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
    const locked = this.touch ? this.touchPlaying && !this.touchPaused() : document.pointerLockElement === this.renderer.renderer.domElement;
    this.touch?.setPlaying(locked);
    if (locked === this.locked) return;
    this.locked = locked;
    if (locked) {
      this.resumeUntil = 0;
      this.lockedAt = performance.now();
    }
    if (locked && this.workshop.active && !this.touch) {
      // a capture that lands while the lab is open would hide the cursor over its UI
      document.exitPointerLock();
      return;
    }
    this.hud.setPointerLocked(locked);
    if (locked) {
      // back in play: a panel left open would sit over the view, unusable
      this.science?.closePanels();
      this.fire?.closePanels();
      this.furniture.closePanel();
      this.petShop.setOpen(false);
      this.hud.hideRecipes();
      this.emoteMenu.setOpen(false);
    } else {
      this.mining = false;
      this.placing = false;
    }
  }

  /**
   * Touch play has no capture for a panel to release: whatever owns the screen (a panel, the
   * machine lab, a text box, the class-over card) pauses play while it is up, and play goes on
   * when it closes - the same moment a PC re-captures the mouse.
   */
  private touchPaused(): boolean {
    const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
    return document.hidden || typing || this.workshop.active || this.hud.recipesOpen || this.furniture.panelOpen || this.petShop.open
      || this.emoteMenu.open || this.science?.panelOpen === true || this.fire?.panelOpen === true || this.sync?.toolsOpen === true || document.querySelector(".class-ended") !== null;
  }

  private render(alpha: number, frameDt: number): void {
    this.syncLock();
    this.hud.syncMenu(this.workshop.active || this.furniture.panelOpen || this.petShop.open || this.emoteMenu.open || this.science?.panelOpen === true || this.fire?.panelOpen === true || this.sync?.toolsOpen === true
      || performance.now() < this.resumeUntil || document.querySelector(".class-ended") !== null);
    if (this.workshop.previewing) {
      const flightFocus = this.workshop.flightPreparationFocus;
      if (flightFocus) {
        this.detailFocus.copy(flightFocus);
        this.perf.time("chunks", () => this.view.update(this.state.world, this.detailFocus));
      }
      this.renderWorkshop(frameDt);
      return;
    }
    const target=this.miningTarget,progress=this.miningFrac;
    if(this.debugMine){const t=this.debugMine.cell,def=blockById(this.state.world.get(...t));if(def){const shape=this.state.world.getShape(...t);this.miningEffects.setProgress(t,def,shape,this.debugMine.progress,()=>this.view.miningShape(shape,def.id,t,this.state.world));}}
    else if(this.locked&&(this.mining||this.itemAttack.active)&&!this.workshop.active&&target&&progress!==null&&!this.aimFurniture){
      const def=blockById(this.state.world.get(...target));if(def){const shape=this.state.world.getShape(...target);this.miningEffects.setProgress(target,def,shape,progress,()=>this.view.miningShape(shape,def.id,target,this.state.world));}else this.miningEffects.clearTarget();
    }else this.miningEffects.clearTarget();
    this.miningEffects.update(frameDt,this.state.world);
    const drawn = this.interpolatedBody(alpha);
    this.sky.update(this.renderer.camera);
    // integer steps keep the 1 m texture tiles aligned with the voxel grid
    this.fieldGround?.position.set(Math.round(this.body.x), FIELD_GROUND_Y, Math.round(this.body.z));
    // Detail (rounded bricks, studs) follows what you're looking AT — the
    // robot, or the machine being driven/flown. Not the orbiting camera:
    // turning the view would swing it metres around and re-ring every frame.
    if (!this.workshop.active) this.detailFocus.set(drawn.x, drawn.y + EYE_HEIGHT, drawn.z);
    this.perf.time("chunks", () => this.view.update(this.state.world, this.detailFocus));
    if (this.workshop.active) {
      this.renderWorkshop(frameDt);
      return;
    }
    this.ghost.visible = true;
    const pets = !this.petsOff();
    if (!pets && this.petShop.open) this.petShop.setOpen(false);
    this.pet.setVisible(pets);
    this.petShop.setVisible(pets);
    this.furniture.setVisible(true);
    this.pet.render(alpha, frameDt);
    // on furniture the mining bar is the feedback; a cell box would frame one
    // cell of a two-cell sofa, or the block under a rug
    // (during the boot warm-up the cell box draws far below the world, so its
    // line shader compiles behind the loading screen, not on the first aim)
    // While that cell is breaking, the cracking block IS the feedback: the box steps aside and
    // comes back when the dig stops or the next block is aimed at (players found a box drawn over
    // the shards distracting).
    // (the fire drill frames no block: nothing there is dug or built on)
    const aimed = this.aim && !this.aimFurniture && !this.fire ? this.aim.voxel : null;
    const breaking = !!aimed && this.miningEffects.breaking(aimed);
    const aimBounds = aimed && !breaking ? shapeBounds(this.state.world.getShape(...aimed)) : undefined;
    this.view.setHighlight(this.warming ? [0, -1000, 0] : breaking ? null : aimed, false, aimBounds);

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
      drawn.y + POSTURE_EYE[this.seated ? "sit" : this.posture],
    );
    this.applyRobotOpacity(this.debugHideRobot ? 0 : robotOpacity, frameDt);
    // classmates AFTER the camera has its place for this frame: they are culled against it, and the
    // camera of the frame before — still in the old window after a field scroll (16 m) — culled a
    // classmate standing right ahead for one frame every time a running player crossed a scroll
    this.sync?.render(frameDt);
    if (this.samples && this.field) {
      const field = this.field;
      this.samples.view.update((ax, az) => field.toGrid(ax, az));
      for (const r of this.samples.rigs) {
        const [gx, gz] = field.toGrid(r.pos[0], r.pos[2]);
        r.rig.root.position.set(gx, r.pos[1], gz);
        r.rig.root.rotation.y = r.yaw;
        r.rig.update("idle", 0, frameDt);
      }
    }
    this.renderer.trackTarget(eye);
    this.updateUnderwater();
    this.view.animateWater(performance.now() / 1000, this.field?.absOriginX ?? 0, this.field?.absOriginZ ?? 0);

    this.updateGhost();
    this.hud.update(this.state.inventory, this.emptyHands ? -1 : this.selected, this.state.hotbar);
    this.hud.setMineProgress(this.miningFrac);
    this.perf.phase("camera", performance.now() - t0);
    this.perf.time("furniture", () => this.furniture.render(this.aim, this.yaw, this.locked && !this.mining, this.ghostOk, this.ghostBad));
    this.perf.time("science", () => this.science?.render(this.aim, this.renderer.camera, this.locked && !this.mining));
    if (this.fire) {
      const p = this.firePlayer, look = this.fireLook;
      p.x = drawn.x; p.y = drawn.y; p.z = drawn.z; p.facing = this.facing;
      p.speed = planar; p.eye = eye.y; p.opacity = robotOpacity;
      look.yaw = this.viewYaw; look.pitch = this.viewPitch;
      this.perf.time("fire", () => this.fire!.render(frameDt, this.renderer.camera, p, look));
    }
    if (this.science?.active) this.hud.setPiece(t("🌬️ 풍력 발전기 설계도 · R 돌리기", "🌬️ Wind turbine blueprint · R to turn"), 0, 0, "🔬");
    else if (!this.furniture.active) {
      if(this.heldTool())this.hud.setPiece(this.toolLabel(),0,0,"⛏️");
      else if (!this.emptyHands && (isPartKey(this.heldKey()) || isFrameKey(this.heldKey()))) this.hud.setPiece(`${itemLabel(this.heldKey() as import("./science/plants.js").SocketItem)} · ${t("빛나는 칸에 끼우기", "fit into a glowing slot")}`, 0, 0, "🔩");
      else if (this.emptyHands) this.hud.setPiece(t("빈손 · Q로 블록 들기", "Empty hands · Q to hold blocks"), 0, 0, "✋");
      else this.hud.setPiece(PIECES[this.pieceIndex]!, this.pieceRot, this.pieceTilt);
    }
    this.perf.time("render", () => this.renderer.render());
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private readonly tmpEye = new THREE.Vector3();
  /** The HUD's pickaxe line, built once per option (render() asks every frame). */
  private toolLabelText = "";
  private toolLabelFor = "";
  private toolLabel(): string {
    if (this.toolLabelFor !== this.toolOption) {
      this.toolLabelFor = this.toolOption;
      this.toolLabelText = `${t("공격 모드 · 곡괭이", "Attack · Pickaxe")} · ${pickaxeOptionName(this.toolOption)} · ${t("R 옵션", "R options")} · ${PICKAXE.targeting.reach}m`;
    }
    return this.toolLabelText;
  }
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
    // (spraying is an action like mining: the body turns to the crosshair for it, and is the keys' again after —
    // held to the view for as long as the extinguisher was carried, the robot only ever showed its back)
    if (this.mining || this.fire?.sprayingNow) this.actionHold = ACTION_FACE_TIME;
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

  /** The view distance preset lives in the shared settings (O and the settings card change it). */
  private loadViewPreset(): number {
    return Math.min(VIEW_NAMES.length - 1, Math.max(0, settings.view));
  }

  /**
   * Under the surface the world goes murky blue: the fog closes in to a few
   * metres and a tint washes the screen. Only fog numbers change (uniforms,
   * no shader recompile), and the render distance's fog comes back on exit.
   */
  private readonly nearCorner = new THREE.Vector3();
  private updateUnderwater(): void {
    // Is the eye in water, and how much of the screen? With the pipeline the PICTURE answers per
    // pixel and exactly: it counts the water faces each ray leaves and enters by (the simple
    // water is a closed volume; one more out than in = the ray started in water) — level
    // surfaces, slopes, a fall's side and water that only just touches a corner of the view are
    // all that one rule. The game only says whether the camera is at water at all (any water in
    // the cells round it), and measures roughly how much of the near plane is under the drawn
    // surface for what is not per pixel: the muffle, the fog, the touch path's wash.
    const camera = this.renderer.camera, world = this.state.world;
    camera.updateMatrixWorld();
    const eye = camera.position, ex = Math.floor(eye.x), ey = Math.floor(eye.y), ez = Math.floor(eye.z);
    let atWater = false;
    for (let dy = -1; dy <= 1 && !atWater; dy++) for (let dz = -1; dz <= 1 && !atWater; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (isWater(world.waterAt(ex + dx, ey + dy, ez + dz))) { atWater = true; break; }
    }
    let covered = 0;
    if (atWater) {
      const half = camera.near * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), wide = half * camera.aspect;
      let wet = 0;
      for (let row = 0; row < INSIDE_H; row++) for (let col = 0; col < INSIDE_W; col++) {
        const p = this.nearCorner.set(((col + 0.5) / INSIDE_W * 2 - 1) * wide, ((row + 0.5) / INSIDE_H * 2 - 1) * half, -camera.near).applyMatrix4(camera.matrixWorld);
        const depth = waterDepthAt(world, p.x, p.y, p.z) ?? -1;
        if (depth > 0) wet++;
      }
      covered = wet / (INSIDE_W * INSIDE_H);
    }
    if (this.waterPipeline) {
      this.waterPipeline.atWater = atWater;
      this.underwaterCover = covered;
    } else if (covered !== this.underwaterCover) {
      this.underwaterCover = covered;
      this.underwaterTint.classList.toggle("on", covered > 0);
      this.underwaterTint.classList.toggle("split", covered > 0 && covered < 1);
      this.underwaterTint.style.clipPath = covered >= 1 || covered <= 0 ? "" : `inset(${((1 - covered) * 100).toFixed(1)}% 0 0 0)`;
    }
    // the murk (fog) and the muffle follow the larger half of the screen, with a band between so
    // a camera bobbing at the waterline does not flick them every frame
    const under = this.underwater ? covered > 0.4 : covered > 0.6;
    if (under !== this.underwater) this.setUnderwater(under);
  }

  /**
   * The machine lab draws its own scene and skips the world's per-frame audio:
   * leave the water (muffle, tint, fog) and the cave echo behind, and keep the
   * ears on the lab camera so classmates are still heard from the right side.
   */
  private labAudio(frameDt: number): void {
    if (this.underwater) this.setUnderwater(false);
    if (this.underwaterCover > 0) { this.underwaterCover = 0; this.underwaterTint.classList.remove("on", "split"); this.underwaterTint.style.clipPath = ""; }
    const cam = this.renderer.camera;
    this.sfx.setListener(cam.position.x, cam.position.y, cam.position.z, this.viewYaw, this.viewPitch);
    if ((this.roomProbeIn -= frameDt) <= 0) { this.roomProbeIn = 0.25; this.sfx.setRoom(OPEN_AIR); }
  }

  private renderWorkshop(frameDt: number): void {
    if (this.workshop.scienceActive) {
      this.labAudio(frameDt);
      this.workshop.renderScience(frameDt);
      return;
    }
    const target = this.workshop.render(frameDt);
    if (target) {
      this.rig.root.visible = false;
      this.pet.setVisible(false);
      this.petShop.setVisible(false);
      this.furniture.setVisible(false);
      this.ghost.visible = false;
      this.view.setHighlight(null);
      this.labAudio(frameDt);
      if (!this.workshop.previewing) {
        this.detailFocus.copy(target);
        this.sync?.render(frameDt, target);
      }
      this.renderer.trackTarget(target);
      this.perf.time("render", () => this.renderer.render());
    }
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private setUnderwater(under: boolean): void {
    this.underwater = under;
    this.sfx.setUnderwater(under);
    if (this.waterPipeline) return; // the murk is per pixel there: the distance fog stays the air's
    const fog = this.renderer.scene.fog as THREE.Fog;
    if (under) {
      fog.color.set(UNDERWATER_FOG);
      fog.near = 0.3;
      fog.far = 12; // bricks a few metres off fade into the blue: at 18 they read as if in air
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
      /** The fire drill (theme "fire"): its state, the aimed station, the open card. */
      fire: () => this.fire?.debug() ?? null,
      /** Run the drill's clock without a captured mouse (headless checks). */
      firePlay: (on = true) => { this.debugFirePlay = on; },
      /** Hold the spray button. */
      fireSpray: (on = true) => { this.debugFireSpray = on; },
      /** Use a station by kind, without aiming at it. */
      fireUse: (kind: import("@robo/shared").FireStationKind) => this.fire?.debugUse(kind),
      /** The real E / right-click path: use what is under the crosshair. */
      fireInteract: () => this.fire?.interact() ?? false,
      /** Finish the open lesson card. */
      fireSolve: () => this.fire?.debugSolve() ?? false,
      fireQuiz: (right: boolean) => this.fire?.debugQuiz(right) ?? false,
      fireSet: (patch: Parameters<FireDrill["debugSet"]>[0]) => this.fire?.debugSet(patch),
      fireRestart: () => this.fire?.restart(),
      /** Tab: the class's drill board (teams, progress; the teacher's has the buttons). */
      fireBoard: () => this.fire?.toggleBoard(),
      /** Stand at ABSOLUTE field coordinates. */
      teleportAbs: (x: number, y: number, z: number, yaw?: number) => this.teleportAbs(x, y, z, yaw),
      /** Science mode (T): sites with their build %, the live preview. */
      science: () => this.science?.debug() ?? null,
      /** Toggle science mode without a key press. */
      scienceMode: (on: boolean) => this.science?.setActive(on),
      /** Dev: sample classroom plots (F2 on the solo field) — lay out / take away; returns the count. */
      samplePlots: (count?: number) => this.toggleSamplePlots(count),
      /** Lay a blueprint at an ABSOLUTE anchor; returns the problem (null = laid). */
      scienceLay: (x: number, y: number, z: number, rot = 0) => (this.science ? this.science.debugLay(x, y, z, rot) : "outside"),
      /** A site's cells (ABSOLUTE) with the block id each wants. */
      /** A site's sockets (ABSOLUTE): item, frame/part, filled, open now. */
      scienceSockets: (index = 0) => this.science?.socketsOf(index) ?? [],
      /** Fit the held item into a socket by index (the same rules as aiming + right click). */
      scienceFit: (site: number, socket: number) => this.science?.debugFit(site, socket) ?? false,
      /** What a middle click would put in hand now. */
      sciencePickAimed: () => this.science?.pickAimed() ?? null,
      /** One step of "right button held" (the timer calls it every 0.3 s). */
      scienceHoldBuild: () => this.science?.holdBuild() ?? false,
      /** The real right-click path (tryPlace): in science mode it lays the previewed blueprint. */
      scienceRightClick: () => { this.tryPlace(); },
      /** The open fitting mini-game, and finishing it through its own rules. */
      scienceGame: () => this.science?.gameState() ?? null,
      scienceSolveGame: () => this.science?.solveGame(),
      /** Take the fitted item in an ABSOLUTE cell back out (the held-left-click path). */
      scienceTakeOut: (ax: number, y: number, az: number) => this.science?.takeOutAt(ax - (this.field?.absOriginX ?? 0), y, az - (this.field?.absOriginZ ?? 0)) ?? false,
      /** A right click's power-plant meaning right now (fit / switch on); true when it acted. */
      scienceInteract: () => this.science?.interact() ?? false,
      /** The status board: toggle it, or pick a plant's card (lights its beacon). */
      scienceBoard: () => this.science?.toggleBoard(),
      sciencePick: (id: number) => this.science?.pick(id),
      /** Put an item into the selected hotbar slot and hold it (as the bag's "load" does). */
      hold: (key: string) => { this.assignToHotbar(this.selected, key, false, true); this.emptyHands = false; return this.heldKey(); },
      /** Which model the player's rig shows: a skinned HOME/TT, or the code-built fallback mascot. */
      rigInfo: () => {
        let skinned = false;
        this.rig.root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
        return { character: this.rig.root.userData.characterId as string | undefined, skinned };
      },
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
        /** The own robot's fade (1 = solid) and whether it is drawn at all. */
        robotOpacity: this.robotOpacity,
        robotVisible: this.rig.root.visible,
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
        return { wet: this.body.wet ?? 0, underwater: this.underwater, cover: this.underwaterCover, pipeline: this.waterPipeline !== null, cells, sources, y: this.body.y, selected: this.heldKey() };
      },
      /** The live scene — for resource audits (duplicate materials/geometries). */
      scene: () => this.renderer.scene,
      cameraState: () => {
        const p = this.renderer.camera.position;
        const dir = this.renderer.camera.getWorldDirection(new THREE.Vector3());
        const cam = this.renderer.camera;
        const matrix = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).toArray();
        return { dist: this.camera.distance, x: p.x, y: p.y, z: p.z, dirY: dir.y, t: performance.now(), matrix };
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
      shapeAt: (x: number, y: number, z: number) => this.state.world.getShape(x, y, z),
      /** Pour the bucket into a grid cell, as a right click does (a spring, or one cell of finite water). */
      pourAt: (x: number, y: number, z: number) => this.pour(x, y, z),
      /** The teacher's F2 tools, without the panel: back to the surface; are pets off in this class. */
      rescue: () => this.rescue(),
      petsOff: () => this.petsOff(),
      /** First person on/off (the V key), for checks that need the camera at the eye. */
      firstPerson: (on: boolean) => { if (this.camera.firstPerson !== on) this.camera.toggleView(); },
      mineAt: (x: number, y: number, z: number) => {
        const def = blockById(this.state.world.get(x, y, z));
        if (!def || def.hardness <= 0) return false;
        this.writeCell(x, y, z, AIR, 0);
        addItem(this.state.inventory, dropOf(def));
        return true;
      },
      /** Hold movement (strafe, forward) as if the keys were down; (0, 0) releases. */
      debugWalk: (strafe: number, forward: number) => {
        this.debugWalkInput = strafe || forward ? [strafe, forward] : null;
      },
      /** Water held inside shaped blocks: how many cells hold it now, how many the last water mesh
       *  drew, and each wet shaped cell [x, y, z, waterId] (grid coordinates). */
      waterlogStats: () => {
        const { wet, cells, shapes } = this.state.world, held: number[][] = [];
        let dry = 0;
        for (let i = 0; i < wet.length; i++) {
          if (wet[i]) held.push([i % WORLD_X, Math.floor(i / (WORLD_X * WORLD_Z)), Math.floor(i / WORLD_X) % WORLD_Z, wet[i]!]);
          else if (shapes[i] && cells[i] && !isWater(cells[i]!)) dry++;
        }
        return { held: held.length, dryShaped: dry, drawn: this.view.lastWaterlog, cells: held.slice(0, 200) };
      },
      /** The water a cell holds: its own water id, or what a shaped block holds (0: none). */
      waterAt: (x: number, y: number, z: number) => this.state.world.waterAt(x, y, z),
      /** Faces bordering air that no shell draws (see VoxelView.auditFaces). */
      auditFaces: (limit?: number) => this.view.auditFaces(this.state.world, limit),
      /** Show a dig in progress on a cell (0..1) without a captured mouse; null stops it. */
      mineProgress: (x: number, y: number, z: number, progress: number | null) => {
        this.debugMine = progress === null ? null : { cell: [x, y, z], progress };
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
      /** What a left click would do now: the classmates it can see, the tap hit, the aimed block. */
      tapInfo: () => {
        const targets = this.sync?.bonkTargets() ?? [];
        const hit = this.sync ? pickBonk(
          { x: this.body.x, y: this.body.y, z: this.body.z, yaw: this.yaw, pitch: this.pitch, eye: POSTURE_EYE[this.seated ? "sit" : this.posture] },
          targets, { aim: "body", blocked: (from, to) => bonkBlocked(from, to, (x, y, z) => this.state.world.isBlocked(x, y, z)) }) : null;
        return { me: [this.body.x, this.body.y, this.body.z], targets, hit, aim: this.aim?.dist ?? null,
          taps: hit ? tapBeatsDig(this.body, hit, this.aim ? this.aim.dist : null) : false, allowed: this.sync?.tapsAllowed ?? false };
      },
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
      /** Which engine runs each part (`?engine=rust`: docs/ENGINE.md). */
      engines: () => ({ water: this.water?.engine ?? null, shells: this.view.shellEngine, scan: this.view.scanEngine }),
      chunks: () => this.view.chunkStats(),
      miningVisual:()=>this.miningEffects.stats(),
      audio: () => this.sfx.debug(),
      dispose: () => this.dispose(),
      machine: () => this.workshop.snapshot(),
      classroom: () => this.sync?.debug() ?? null,
      classSend: (msg: Parameters<ClassClient["send"]>[0]) => this.sync?.client.send(msg),
      absolute: () => (this.field ? this.field.toAbsolute(this.body.x, this.body.z) : null),
      /** The block at ABSOLUTE field coordinates (a classroom's coordinates), through the current window. */
      blockAtAbs: (ax: number, y: number, az: number) => {
        if (!this.field) return this.state.world.get(ax, y, az);
        const [x, z] = this.field.toGrid(ax, az);
        return this.state.world.inBounds(x, y, z) ? this.state.world.get(x, y, z) : -1;
      },
    };
    this.debugHooks = hooks;
    (window as unknown as Record<string, unknown>).__roboCraft = hooks;
  }
}


