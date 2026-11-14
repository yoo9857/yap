import {changePartCustom} from "./customization.js";
import { customizationScope } from "./editScope.js";
import * as THREE from "three";
import type { RapierModule } from "../../physics/physics.js";
import { surfaceY, type VoxelWorld } from "../voxelWorld.js";
import { PartSelection } from "./partSelection.js";
import { GarageThumbnails } from "./garageThumbnails.js";
import {
  addPart,
  BLUEPRINT_KEY,
  blueprintError,
  cloneBlueprint,
  DIRECTIONS,
  usesSkylarkModel,
  machineStats,
  mirrorDirection,
  parseBlueprint,
  PARTS,
  PART_ORDER,
  preset,
  type Blueprint,
  type Cell,
  type MachinePart,
  type PartKind,
  type PresetKind,
} from "./blueprint.js";
import { IDLE_INPUT, MachinePhysics } from "./machinePhysics.js";
import { GhostPart, MachineAssets, MachineVisual, wheelMountSide } from "./machineVisual.js";
import type { SkylarkPart } from "./skylarkParts.js";
import { SkylarkVisual } from "./skylarkVisual.js";
import { DustField, MachineAudio } from "./machineFx.js";
import { MachineStore, decodeShare, encodeShare } from "./library.js";
import { MISSIONS, MissionRun } from "./missions.js";
import { ScienceLab } from "./scienceLab.js";
import { GARAGE_LAYER, GarageStage } from "./garageStage.js";
import {
  guideAim,
  guideReach,
  SHAFT_TURN,
  thrustGuides,
  thrustMisses,
  turnAxisId,
  turnBasis,
  turnSweep,
  type ThrustAxisId,
  type ThrustGuide,
} from "./balance.js";
import { t } from "../../ui/i18n.js";
import {
  BuildPanel,
  CAMERA_LABEL,
  Coach,
  DriveHud,
  Toasts,
  type BuildScreen,
  type BuildView,
  type CameraMode,
  type MessageTone,
} from "./workshopUi.js";
import "./workshop.css";
import "./garage.css";

let physicsModule: Promise<RapierModule> | undefined;
const loadPhysics = () =>
  (physicsModule ??= import("@dimforge/rapier3d-compat")
    .then(async (m) => {
      await m.init();
      return m;
    })
    .catch((error) => {
      physicsModule = undefined;
      throw error;
    }));

const COACH_KEY = "craftyap-machine-coach-v1";
const ASSIST_KEY = "craftyap-machine-assist-v1";
const CAMERA_ORDER: readonly CameraMode[] = ["chase", "orbit", "cockpit"];
const HIGHLIGHT = new THREE.Color(0xff6b84);
const GUIDE_COLOR: Record<ThrustAxisId, number> = {
  vertical: 0xffd21c,
  side: 0xff7a90,
  fore: 0x7ec8ff,
};

interface GuideAxis {
  shaft: THREE.Mesh;
  cones: [THREE.Mesh, THREE.Mesh];
  material: THREE.MeshBasicMaterial;
}
/** Test-drive bounds. Leaving them respawns rather than ending the run. */
const BOUNDS = { minX: -20, maxX: 180, minZ: -20, maxZ: 180, minY: -15, maxY: 250 };

export class MachineWorkshop {
  active = false;
  private blueprint = preset("rover");
  private readonly undoStack: Blueprint[] = [];
  private readonly redoStack: Blueprint[] = [];
  private selected: PartKind = "frame";
  private direction = 0;
  private mirror = true;
  private showCenter = true;
  private erase = false;
  private inspectMode=false;
  private inspectedCell:Cell|null=null;
  /** Beginner autopilot, on until the player turns it off. */
  private assist = true;

  private readonly group = new THREE.Group();
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd21c, depthTest: false }),
  );
  /** Three cell-axis shafts through the centre of mass, plus a link from each off-axis push. */
  private readonly guideShaft = new THREE.CylinderGeometry(0.03, 0.03, 1, 8);
  private readonly guideCone = new THREE.ConeGeometry(0.13, 0.3, 8);
  private readonly guide = new THREE.Group();
  private guideAxes!: Record<ThrustAxisId, GuideAxis>;
  private readonly missGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 6);
  private missMaterial!: Record<ThrustAxisId, THREE.MeshBasicMaterial>;
  private readonly missPool: THREE.Mesh[] = [];
  /** Arc around the centre of mass. Same basis as the round guide, so both curl the same way. */
  private turnArc!: THREE.Mesh;
  private turnHead!: THREE.Mesh;
  private turnMaterial!: THREE.MeshBasicMaterial;
  private turnShown = 0;
  private readonly turnMatrix = new THREE.Matrix4();
  private readonly turnX = new THREE.Vector3();
  private readonly turnY = new THREE.Vector3();
  private readonly turnZ = new THREE.Vector3();
  private readonly turnUp = new THREE.Vector3(0, 1, 0);
  private readonly turnTangent = new THREE.Vector3();
  private readonly assets = new MachineAssets();
  private readonly visual = new MachineVisual(this.assets);
  private readonly skylark = new SkylarkVisual();
  private detailedSkylark = false;
  private skylarkPreviewRequested = false;
  private skylarkExploded = false;
  private skylarkSelected: SkylarkPart | null = null;
  private readonly ghost = new GhostPart(this.assets);
  private readonly dust = new DustField();
  private readonly audio = new MachineAudio();
  private readonly store = new MachineStore();
  private record = this.store.record();
  private entries = this.store.entries();
  private run: MissionRun | null = null;
  private disposed = false;
  private assetFailure = "";
  private assetsRequested = false;
  private science: ScienceLab | null = null;

  private readonly launch: HTMLButtonElement;
  private readonly panel: BuildPanel;
  private readonly hud = new DriveHud();
  private readonly stage = new GarageStage();
  private readonly selectionOutline = new PartSelection();
  private readonly thumbnails: GarageThumbnails;
  private readonly partMatrix = new THREE.Matrix4();
  private readonly previewBounds = new THREE.Box3();
  private readonly previewPartBounds = new THREE.Box3();
  private readonly skylarkPreviewCorners: THREE.Vector3[] = [];
  private readonly previewFocus = new THREE.Vector3();
  private readonly faceNormal = new THREE.Vector3();
  private readonly toasts = new Toasts();
  private readonly coach: Coach;
  private readonly keys = new Set<string>();
  private readonly events = new AbortController();

  private readonly origin = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly scratch = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly chasePosition = new THREE.Vector3();
  private readonly bodyQuaternion = new THREE.Quaternion();
  private readonly cockpitTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI,
  );
  // Look back along the apron so the open ground the machine will drive into
  // is the backdrop, not the castle wall immediately behind the workbench.
  private theta = 2.34;
  private elevation = 0.5;
  private distance = 10.5;
  private previewViewport = "";
  private previewDirty = true;
  private physicsWarmup: number | undefined;
  private camera3rd: CameraMode = "chase";
  private chaseReady = false;
  private baseFov = 0;
  private baseCameraLayers = 1;
  private shake = 0;
  private lastVerticalSpeed = 0;
  private hudUpdateIn = 0;
  private readonly driveAngles = new THREE.Euler(0, 0, 0, "YXZ");

  private drag: {
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    button: number;
  } | null = null;
  private hovered = -1;
  private placement: Cell | null = null;
  private physics: MachinePhysics | null = null;
  private loading = false;
  private generation = 0;
  private message = "";
  private messageTimeout: number | undefined;
  private tone: MessageTone = "info";
  private saveFailed = false;
  private readonly canvas: HTMLCanvasElement;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly voxels: VoxelWorld,
    private readonly onActive: (active: boolean) => void,
  ) {
    const canvas = this.canvas = renderer.domElement;
    this.thumbnails = new GarageThumbnails(this.assets, renderer);
    try {
      this.blueprint =
        parseBlueprint(localStorage.getItem(BLUEPRINT_KEY)) ?? this.blueprint;
      this.assist = localStorage.getItem(ASSIST_KEY) !== "0";
    } catch {
      /* storage unavailable */
    }
    // The island's one real test ground: a 7-wide apron on the northern plain
    // that stays dead level for ~48 m straight ahead (+Z). Spawning anywhere
    // near the castle stops a build against a step within a few seconds, and a
    // sloped spawn tips a wide machine onto a wingtip before it even starts.
    this.origin.set(79.5, this.groundY() + 4, 18.5);
    this.group.visible = false;
    this.marker.visible = false;
    this.marker.renderOrder = 13;
    this.guideAxes = {
      vertical: this.makeGuide("vertical", null),
      side: this.makeGuide("side", SHAFT_TURN.side),
      fore: this.makeGuide("fore", SHAFT_TURN.fore),
    };
    this.missMaterial = {
      vertical: this.guideMaterial(GUIDE_COLOR.vertical, 0.95),
      side: this.guideMaterial(GUIDE_COLOR.side, 0.95),
      fore: this.guideMaterial(GUIDE_COLOR.fore, 0.95),
    };
    this.turnMaterial = this.guideMaterial(GUIDE_COLOR.vertical, 1);
    this.turnArc = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.028, 6, 20, 1), this.turnMaterial);
    this.turnHead = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 8), this.turnMaterial);
    this.turnArc.add(this.turnHead);
    this.turnArc.visible = false;
    this.turnArc.renderOrder = 12;
    this.turnHead.renderOrder = 13;
    this.turnArc.frustumCulled = false;
    this.turnHead.frustumCulled = false;
    this.guide.add(this.turnArc);
    this.marker.add(this.guide);
    this.marker.traverse(object => object.layers.enable(GARAGE_LAYER));
    this.selectionOutline.object.traverse(object => object.layers.enable(GARAGE_LAYER));
    this.ghost.root.visible = false;
    scene.add(this.group, this.marker, this.ghost.root, this.dust.points, this.stage.root, this.selectionOutline.object);

    const signal = this.events.signal;
    this.launch = document.createElement("button");
    this.launch.className = "machine-ui machine-launch mw-btn";
    this.launch.innerHTML = `<span class="chip-emoji">🔧</span> <span class="chip-label">${t("기계 작업실", "Machine lab")}</span> <kbd class='mw-kbd'>B</kbd>`;
    this.launch.title = t("기계 작업실 (B)", "Machine lab (B)");
    this.panel = new BuildPanel(
      {
        navigate: (screen) => this.navigate(screen),
        explodeSkylark: () => {
          this.skylarkExploded = !this.skylarkExploded;
          this.refresh();
        },
        selectSkylarkPart: (part) => this.selectSkylarkPart(part),
        preview: (view) => {
          if (this.physics || this.loading) return;
          if (view === "fit") this.frameCamera();
          else {
            this.theta = view === "side" ? Math.PI / 2
              : view === "front" && this.skylark.root.visible ? 0 : Math.PI;
            this.frameCamera(view === "top" ? 1.4 : .2);
          }
        },
        selectPart: (kind) => this.pickPart(kind),
        inspectPart:index=>this.inspectPart(index),
        customizePart:(index,key,value)=>this.customizePart(index,key,value),
        setDirection: (direction) => {
          this.direction = direction;
          this.refresh();
        },
        usePreset: (kind) => this.applyPreset(kind),
        quickStart: (kind) => void this.quickStart(kind),
        toggleAssist: () => this.setAssist(!this.assist),
        rename: (name) => {
          this.blueprint.name = name.trim().slice(0, 48) || t("나의 기계", "My machine");
          this.commit(false);
        },
        undo: () => this.undo(),
        redo: () => this.redo(),
        toggleMirror: () => {
          this.mirror = !this.mirror;
          this.say(
            this.mirror
              ? t("좌우 대칭 켜짐 · 반대쪽에도 똑같이 붙습니다.", "Mirror on · parts are copied to the other side.")
              : t("좌우 대칭 꺼짐", "Mirror off"),
            "info",
          );
        },
        toggleCenter: () => {
          this.showCenter = !this.showCenter;
          this.refresh();
        },
        toggleErase: () => {
          this.inspectMode=false;
          this.erase = !this.erase;
          this.ghost.setErasing(this.erase);
          this.refresh();
        },
        frame: () => this.frameCamera(),
        clearAll: () => this.clearAll(),
        run: () => void this.runOrStop(),
        close: () => this.toggle(),
        science: () => void this.openScience(),
        saveSlot: () => this.saveSlot(),
        thumbnail: (blueprint, index) => this.thumbnails.render(blueprint, index),
        replaceSlot: (id) => this.replaceSlot(id),
        loadSlot: (id) => this.loadSlot(id),
        deleteSlot: (id) => {
          this.entries = this.store.remove(id);
          this.say(this.store.failed
            ? t("삭제하지 못했습니다. 설계도는 그대로 보관됩니다.", "Couldn't delete. Your blueprint is still saved.")
            : t("설계도를 복구함으로 옮겼습니다. 복구함에서 다시 꺼낼 수 있어요.", "Moved to recovery. You can restore it from there."), this.store.failed ? "bad" : "good");
        },
        restoreSlot: (id) => {
          this.entries = this.store.restore(id);
          this.libraryResult(t("설계도를 보관함으로 복구했습니다.", "Blueprint restored to the library."));
        },
        importShare: (code) => this.importShare(code),
      },
      signal,
    );
    this.coach = new Coach(() => {
      try {
        localStorage.setItem(COACH_KEY, "1");
      } catch {
        /* storage unavailable */
      }
    }, signal);
    document.body.append(
      this.launch,
      this.panel.element,
      this.hud.element,
      this.hud.chips,
      this.toasts.element,
      this.coach.element,
    );

    this.launch.addEventListener("click", () => this.toggle(), { signal });
    // capture: runs before the music's M toggle (bgm.ts), which skips a key the lab consumed
    window.addEventListener("keydown", (e) => this.onKeyDown(e), { signal, capture: true });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code), {
      signal,
    });
    window.addEventListener("blur", () => this.keys.clear(), { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.keys.clear();
        else this.previewDirty = true;
      },
      { signal },
    );
    canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (!this.active) return;
        this.drag = {
          x: e.clientX,
          y: e.clientY,
          lastX: e.clientX,
          lastY: e.clientY,
          moved: false,
          button: e.button,
        };
        canvas.setPointerCapture(e.pointerId);
      },
      { signal },
    );
    canvas.addEventListener(
      "pointermove",
      (e) => {
        if (!this.active) return;
        if (this.drag) {
          if (Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 4)
            this.drag.moved = true;
          if (this.drag.moved) {
            this.previewDirty = true;
            this.theta -= (e.clientX - this.drag.lastX) * 0.008;
            this.elevation = THREE.MathUtils.clamp(
              this.elevation + (e.clientY - this.drag.lastY) * 0.006,
              0.08,
              1.4,
            );
          }
          this.drag.lastX = e.clientX;
          this.drag.lastY = e.clientY;
        }
        this.aim(e.clientX, e.clientY);
      },
      { signal },
    );
    canvas.addEventListener(
      "pointerup",
      (e) => {
        if (!this.active) return;
        const click = this.drag && !this.drag.moved;
        this.drag = null;
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId);
        if (!click || this.physics || this.loading) return;
        if (this.panel.showingModel && this.skylark.root.visible) {
          if (e.button === 0) {
            this.aimRay(e.clientX, e.clientY);
            this.selectSkylarkPart(this.skylark.pick(this.ray));
          }
          return;
        }
        if (!this.panel.canEdit) return;
        this.aim(e.clientX, e.clientY);
        if (e.button === 2 || this.erase) this.removeHovered();
        else if (e.button === 0) {if(this.inspectMode)this.inspectPart(this.hovered);else this.placeHere();}
      },
      { signal },
    );
    canvas.addEventListener(
      "pointercancel",
      () => {
        this.drag = null;
      },
      { signal },
    );
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.active || this.physics) return;
        e.preventDefault();
        this.distance = THREE.MathUtils.clamp(
          this.distance + e.deltaY * 0.015,
          5,
          38,
        );
        this.previewDirty = true;
      },
      { signal, passive: false },
    );

    this.group.add(this.visual.root);
    this.rebuild();
    // (the panel's first fill is `prime`'s: ~20 ms of the game's constructor, for a lab nobody has opened)
  }

  private primed = false;
  /** Fill the panel for the first time. The game asks behind its loading screen; opening the lab does it too. */
  prime(): void {
    if (!this.primed && !this.disposed) this.refresh();
  }

  // ------------------------------------------------------------- editing

  private selectSkylarkPart(part: SkylarkPart | null): void {
    if (!this.panel.showingModel || !this.skylark.loaded || this.physics || this.loading) return;
    this.skylarkSelected = part;
    this.refresh();
  }

  private navigate(screen: BuildScreen): void {
    if (this.physics || this.loading || (screen === "model" && !this.detailedSkylark)) return;
    this.message = "";
    this.inspectMode = screen === "tune";
    if (this.inspectMode && this.inspectedIndex() < 0) {
      const part = this.blueprint.parts.find(part => part.kind === this.selected) ?? this.blueprint.parts[0];
      this.inspectedCell = part ? [...part.cell] : null;
    }
    this.erase = false;
    this.ghost.root.visible = false;
    this.ghost.setErasing(false);
    this.visual.highlight(-1, HIGHLIGHT);
    this.panel.showScreen(screen, true);
    this.refresh();
  }

  private pickPart(kind: PartKind): void {
    this.inspectMode=false;this.inspectedCell=null;
    this.selected = kind;
    this.erase = false;
    this.ghost.setErasing(false);
    this.panel.showScreen("parts");
    if (!PARTS[kind].directional) this.direction = 0;
    this.refresh();
  }

  private remember(): void {
    this.undoStack.push(cloneBlueprint(this.blueprint));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private undo(): void {
    if (this.physics || this.loading) return; // before popping, or a step is lost
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(cloneBlueprint(this.blueprint));
    this.blueprint = previous;
    this.commit();
  }

  private redo(): void {
    if (this.physics || this.loading) return;
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(cloneBlueprint(this.blueprint));
    this.blueprint = next;
    this.commit();
  }

  private inspectedIndex():number {return this.inspectedCell?this.blueprint.parts.findIndex(p=>p.cell.every((v,i)=>v===this.inspectedCell![i])):-1;}
  private toggleInspect():void {
    if(this.physics||this.loading)return;
    this.navigate(this.inspectMode ? "parts" : "tune");
  }
  private inspectPart(index:number):void {
    if(this.physics||this.loading)return;
    if(index===-1){this.inspectedCell=null;this.visual.highlight(-1,HIGHLIGHT);this.refresh();return;}
    const part=this.blueprint.parts[index];if(!part)return;
    this.inspectMode=true;this.inspectedCell=[...part.cell];
    this.refresh();
  }
  private customizePart(index:number,key:string,value:string):void {
    if(this.physics||this.loading)return;
    const part=this.blueprint.parts[index];if(!part)return;
    const next=cloneBlueprint(this.blueprint),direction=Number(value);
    if(key==="direction"){
      if(!PARTS[part.kind].directional||!Number.isInteger(direction)||direction<0||direction>=DIRECTIONS.length||direction===part.direction)return;
      next.parts[index]!.direction=direction;
    }else if(!changePartCustom(next.parts[index]!,key,value))return;
    for (const twinIndex of customizationScope(this.blueprint, index, this.mirror).indices.slice(1)) {
      const twin = next.parts[twinIndex]!;
      if(key==="direction") twin.direction=mirrorDirection(direction);
      else changePartCustom(twin,key,value);
    }
    this.remember();this.blueprint=next;this.commit();
  }

  /** Place at the aimed cell, plus its mirrored twin when symmetry is on. */
  private placeHere(): void {
    if (!this.placement) return;
    const next = cloneBlueprint(this.blueprint);
    // Exactly one cockpit is a hard rule, so placing a second one moves the
    // seat instead of refusing the click and leaving the player to hunt for it.
    if (this.selected === "cockpit")
      next.parts = next.parts.filter((p) => p.kind !== "cockpit");
    const cells: MachinePart[] = [
      {
        kind: this.selected,
        cell: this.placement,
        direction: this.direction,
      },
    ];
    if (this.mirror && this.placement[0] !== 0)
      cells.push({
        kind: this.selected,
        cell: [-this.placement[0], this.placement[1], this.placement[2]],
        direction: mirrorDirection(this.direction),
      });
    const added = cells.filter((part) => addPart(next, part)).length;
    if (!added) {
      this.say(
        t(`여기에는 붙일 수 없습니다. 부품 ${this.blueprint.parts.length}/128, 중심에서 12칸까지입니다.`, `Can't attach here. Parts ${this.blueprint.parts.length}/128, up to 12 cells from the centre.`),
        "bad",
      );
      return;
    }
    this.remember();
    this.blueprint = next;
    this.commit();
  }

  private removeHovered(): void {
    if (this.hovered < 0) return;
    const part = this.blueprint.parts[this.hovered]!;
    const twin: Cell = [-part.cell[0], part.cell[1], part.cell[2]];
    const next = cloneBlueprint(this.blueprint);
    next.parts = next.parts.filter(
      (p, i) =>
        i !== this.hovered &&
        !(
          this.mirror &&
          part.cell[0] !== 0 &&
          p.kind === part.kind &&
          p.cell.join() === twin.join()
        ),
    );
    this.remember();
    this.blueprint = next;
    this.commit();
  }

  private clearAll(): void {
    this.remember();
    const cockpit = this.blueprint.parts.find((p) => p.kind === "cockpit");
    this.blueprint = {
      version: 1,
      name: this.blueprint.name,
      parts: [cockpit ?? { kind: "cockpit", cell: [0, 0, 0], direction: 0 }],
    };
    this.commit();
    this.say(t("조종석만 남겼습니다. 여기서 다시 시작해 보세요.", "Only the cockpit is left. Start again from here."), "info");
  }

  /** Skip the workbench entirely: load an example and drive it right away. */
  private async quickStart(kind: PresetKind): Promise<void> {
    if (this.physics || this.loading) return;
    if (kind !== "skylark" || this.blueprint.design !== "skylark") this.applyPreset(kind, false);
    await this.runOrStop();
  }

  private setAssist(on: boolean): void {
    this.assist = on;
    try {
      localStorage.setItem(ASSIST_KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    this.toasts.show(
      on ? t("조작 보조 켜짐 · 저절로 수평을 잡아요", "Pilot assist on · levels itself") : t("조작 보조 꺼짐 · 물리 그대로", "Pilot assist off · raw physics"),
      "good",
      on ? "🛟" : "🎛️",
    );
    this.refresh();
  }

  private loadBlueprint(blueprint: Blueprint, showModel = true): void {
    this.remember();
    this.blueprint = blueprint;
    this.skylarkSelected = null;
    this.skylarkExploded = false;
    if (!this.skylark.loaded) this.skylarkPreviewRequested = false;
    if (showModel && usesSkylarkModel(blueprint)) {
      this.theta = .93;
      this.inspectMode = false;
      this.panel.showScreen("model");
    } else if (this.panel.showingModel) this.panel.showScreen("parts");
    this.commit();
    this.frameCamera();
  }

  private applyPreset(kind: PresetKind, showModel = true): void {
    this.loadBlueprint(preset(kind), showModel);
    this.say(t(`${this.blueprint.name} 예제를 불러왔습니다.`, `Loaded the ${this.blueprint.name} example.`), "good");
  }

  private commit(rebuild = true): void {
    this.save();
    if (rebuild) this.rebuild();
    this.refresh();
  }

  private save(): void {
    try {
      localStorage.setItem(BLUEPRINT_KEY, JSON.stringify(this.blueprint));
      this.saveFailed = false;
    } catch {
      this.saveFailed = true;
    }
  }

  private saveSlot(): void {
    this.entries = this.store.create(this.blueprint, Date.now());
    this.libraryResult(t(`'${this.entries[0]?.blueprint.name}'을(를) 새 설계도로 저장했습니다.`, `Saved '${this.entries[0]?.blueprint.name}' as a new blueprint.`));
  }

  private replaceSlot(id: string): boolean {
    if (!this.entries.some(entry => entry.id === id)) return false;
    this.entries = this.store.put(id, this.blueprint, Date.now());
    this.libraryResult(t("현재 기계로 교체했습니다. 교체 전 설계도는 복구함에 보관됩니다.", "Replaced with this machine. The previous version is in recovery."));
    return !this.store.failed;
  }

  private libraryResult(success: string): void {
    this.say(this.store.failure === "full"
      ? t("보관함 12칸이 찼습니다. 기존 설계도를 교체하거나 복구함으로 옮겨 자리를 비워 주세요.", "All 12 slots are full. Replace a saved blueprint or move one to recovery first.")
      : this.store.failed
        ? t("브라우저 저장 공간에 접근할 수 없습니다. 기존 설계도는 그대로 보관됩니다.", "Browser storage is unavailable. Existing blueprints are unchanged.")
        : success, this.store.failed ? "bad" : "good");
  }

  private loadSlot(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    this.loadBlueprint(cloneBlueprint(entry.blueprint));
    this.say(t(`'${entry.blueprint.name}'을(를) 불러왔습니다.`, `Loaded '${entry.blueprint.name}'.`), "good");
  }

  private importShare(code: string): boolean {
    const loaded = decodeShare(code);
    if (!loaded) {
      this.say(t("공유 코드를 읽지 못했습니다. CYM으로 시작하는 코드 전체를 붙여넣어 주세요.", "Couldn't read that share code. Paste the whole code starting with CYM."), "bad");
      return false;
    }
    this.loadBlueprint(loaded);
    this.say(t(`'${loaded.name}'을(를) 코드에서 불러왔습니다.`, `Loaded '${loaded.name}' from the code.`), "good");
    return true;
  }

  private say(text: string, tone: MessageTone = "info"): void {
    window.clearTimeout(this.messageTimeout);
    this.message = text;
    this.tone = tone;
    if (tone !== "bad") this.messageTimeout = window.setTimeout(() => {
      this.message = "";
      if (!this.disposed) this.refresh();
    }, 4500);
    this.refresh();
  }

  // --------------------------------------------------------------- input

  private typing(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      /INPUT|SELECT|TEXTAREA/.test(target.tagName)
    );
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (!this.active || this.science?.active || this.panel.hasModal || this.typing(event.target) ||
      (!this.physics && !this.loading && ["Enter", "Space"].includes(event.code) &&
        event.target instanceof Element && event.target.closest("button")))
      return;
    if (
      ["Space", "ArrowUp", "ArrowDown", "KeyW", "KeyS", "KeyA", "KeyD"].includes(
        event.code,
      ) ||
      (this.physics && (event.ctrlKey || event.metaKey) && /^Key[A-Z]$/.test(event.code))
    )
      event.preventDefault(); // while driving, no Ctrl+R/E/F browser shortcut mid-flight
    this.keys.add(event.code);
    if (event.repeat) return;
    const driving = !!this.physics;
    if ((event.ctrlKey || event.metaKey) && !this.physics) {
      if (event.code === "KeyZ") {
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
      } else if (event.code === "KeyY") {
        event.preventDefault();
        this.redo();
      }
      return;
    }
    if (event.code === "Enter") {
      event.preventDefault();
      void this.runOrStop();
      return;
    }
    if (event.code === "KeyG") {
      this.setAssist(!this.assist);
      return;
    }
    if (driving) {
      if (event.code === "KeyC") this.cycleCamera();
      if (event.code === "KeyR") this.respawn(t("제자리로 돌아왔습니다.", "Back at the start."));
      return;
    }
    const slot = Number(event.key);
    if (Number.isInteger(slot) && slot >= 1 && slot <= PART_ORDER.length) {
      this.pickPart(PART_ORDER[slot - 1]!);
      return;
    }
    switch (event.code) {
      case "KeyR":
        if(this.inspectMode){const i=this.inspectedIndex(),part=this.blueprint.parts[i];if(part&&PARTS[part.kind].directional)this.customizePart(i,"direction",String((part.direction+1)%DIRECTIONS.length));break;}
        if (PARTS[this.selected].directional) {
          this.direction = (this.direction + 1) % DIRECTIONS.length;
          this.refresh();
        }
        break;
      case "KeyM":
        event.preventDefault(); // M is mirror here, not the music
        this.mirror = !this.mirror;
        this.say(this.mirror ? t("좌우 대칭 켜짐", "Mirror on") : t("좌우 대칭 꺼짐", "Mirror off"), "info");
        break;
      case "KeyV":
        this.toggleInspect();
        break;
      case "KeyX":
        this.panel.showScreen("parts");
        this.inspectMode=false;
        this.erase = !this.erase;
        this.ghost.setErasing(this.erase);
        this.refresh();
        break;
      case "KeyF":
        this.frameCamera();
        break;
      default:
        break;
    }
  }

  private cycleCamera(): void {
    this.camera3rd =
      CAMERA_ORDER[(CAMERA_ORDER.indexOf(this.camera3rd) + 1) % CAMERA_ORDER.length]!;
    this.chaseReady = false;
    this.toasts.show(CAMERA_LABEL[this.camera3rd], "good", "🎥");
  }

  // ----------------------------------------------------------- lifecycle

  toggle(): void {
    this.prime();
    if (this.science?.active) {
      this.science.close();
      return;
    }
    if (this.active) {
      this.panel.dismissOverlays();
      this.stop();
      this.save();
      this.thumbnails.release();
      window.clearTimeout(this.physicsWarmup);
      this.physicsWarmup = undefined;
    }
    this.active = !this.active;
    this.stage.root.visible = this.active;
    this.selectionOutline.object.visible = false;
    this.keys.clear();
    this.drag = null;
    this.launch.hidden = this.active;
    this.panel.element.hidden = !this.active;
    this.group.visible = this.active;
    this.marker.visible = this.active;
    this.ghost.root.visible = false;
    this.hud.setVisible(false);
    if (this.active) {
      document.exitPointerLock();
      this.baseCameraLayers = this.camera.layers.mask;
      this.inspectMode = false;
      this.mirror = true;
      this.showCenter = true;
      this.erase = false;
      this.ghost.setErasing(false);
      const showModel = usesSkylarkModel(this.blueprint);
      this.panel.showScreen(showModel ? "model" : "parts");
      if (showModel) this.theta = .93;
      this.assetFailure = "";
      this.baseFov ||= this.camera.fov;
      this.entries = this.store.entries();
      this.record = this.store.record();
      this.rebuild();
      this.frameCamera();
      this.refresh();
      this.maybeCoach();
    } else {
      this.coach.element.hidden = true;
      this.restoreCamera();
    }
    this.onActive(this.active);
  }

  /** First open pays for the kit; later opens hit the resolved promise. */
  private loadAssets(): void {
    if (this.assetsRequested) return;
    this.assetsRequested = true;
    void this.assets.ready
      .then(() => {
        if (this.disposed || !this.active) return;
        this.rebuild();
        this.frameCamera();
        this.ghost.set(this.selected, this.direction);
        this.refresh();
      })
      .catch(() => {
        this.assetsRequested = false;
        this.assetFailure =
          t("기계 에셋을 불러오지 못했습니다. 새로고침해 주세요.", "Couldn't load the machine parts. Please refresh.");
        if (!this.disposed) this.say(this.assetFailure, "bad");
      });
  }

  private maybeCoach(): void {
    if (this.panel.showingModel) return;
    let seen = "1";
    try {
      seen = localStorage.getItem(COACH_KEY) ?? "";
    } catch {
      /* storage unavailable */
    }
    if (!seen) this.coach.start();
  }

  private restoreCamera(): void {
    this.camera.layers.mask = this.baseCameraLayers;
    if (this.baseFov && this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private guideMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** CylinderGeometry points +Y. The turn puts that shaft on a cell axis (see SHAFT_TURN). */
  private makeGuide(id: ThrustAxisId, turn: { x: number; y: number; z: number } | null): GuideAxis {
    const material = this.guideMaterial(GUIDE_COLOR[id], 0.85);
    const shaft = new THREE.Mesh(this.guideShaft, material);
    const positive = new THREE.Mesh(this.guideCone, material);
    const negative = new THREE.Mesh(this.guideCone, material);
    negative.rotation.x = Math.PI;
    const root = new THREE.Group();
    if (turn) root.rotation.set(turn.x, turn.y, turn.z);
    root.add(shaft, positive, negative);
    shaft.renderOrder = 11;
    positive.renderOrder = 12;
    negative.renderOrder = 12;
    shaft.frustumCulled = false;
    positive.frustumCulled = false;
    negative.frustumCulled = false;
    this.guide.add(root);
    return { shaft, cones: [positive, negative], material };
  }

  private layoutGuide(axis: GuideAxis, half: number): void {
    axis.shaft.scale.y = half * 2;
    const tip = half + 0.15;
    axis.cones[0].position.y = tip;
    axis.cones[1].position.y = -tip;
  }

  /** The axis in hand stays bright, and its arrowhead points the way that part will push. */
  private emphasizeGuide(): void {
    const aim = guideAim(this.selected, this.direction);
    const report = thrustGuides(this.blueprint);
    for (const id of ["vertical", "side", "fore"] as const) {
      const axis = this.guideAxes[id];
      const guide = report[id];
      const hot = aim.id === id;
      const show = hot || guide.present;
      axis.shaft.visible = show;
      for (const cone of axis.cones) cone.visible = show;
      const push = guide.present && !guide.cancel ? guide.sign : 0;
      const sign = hot ? aim.sign : push;
      axis.material.opacity = hot ? 1 : aim.id !== null && !hot ? 0.28 : 0.85;
      const thick = hot ? 1.6 : 1;
      axis.shaft.scale.x = thick;
      axis.shaft.scale.z = thick;
      const pos = sign > 0 ? 1.55 : sign < 0 ? 0.45 : 1;
      const neg = sign < 0 ? 1.55 : sign > 0 ? 0.45 : 1;
      axis.cones[0].scale.set(thick * pos, sign > 0 ? 1.3 : 1, thick * pos);
      axis.cones[1].scale.set(thick * neg, sign < 0 ? 1.3 : 1, thick * neg);
    }
    this.layoutTurn(aim.id, report);
  }

  /** One arc at the centre of mass, curling the way that push will turn the machine. */
  private layoutTurn(focus: ThrustAxisId | null, report: ReturnType<typeof thrustGuides>): void {
    let chosen: ThrustGuide | null = null;
    if (focus && turnSweep(report[focus].miss, report[focus].spin) > 0) chosen = report[focus];
    if (!chosen) {
      for (const id of ["vertical", "side", "fore"] as const) {
        const guide = report[id];
        if (turnSweep(guide.miss, guide.spin) <= 0) continue;
        if (!chosen || (guide.spin && !chosen.spin) || (guide.spin === chosen.spin && guide.miss > chosen.miss))
          chosen = guide;
      }
    }
    const sweep = chosen ? turnSweep(chosen.miss, chosen.spin) : 0;
    const basis = chosen && sweep > 0.05 ? turnBasis(chosen.turnX, chosen.turnY, chosen.turnZ) : null;
    this.turnArc.visible = !!basis;
    if (!basis || !chosen) return;
    if (Math.abs(sweep - this.turnShown) > 0.03) {
      this.turnShown = sweep;
      this.turnArc.geometry.dispose();
      this.turnArc.geometry = new THREE.TorusGeometry(0.82, 0.028, 6, Math.max(10, Math.round(18 * sweep)), sweep);
    }
    this.turnX.fromArray(basis.x);
    this.turnY.fromArray(basis.y);
    this.turnZ.fromArray(basis.z);
    this.turnArc.quaternion.setFromRotationMatrix(this.turnMatrix.makeBasis(this.turnX, this.turnY, this.turnZ));
    this.turnMaterial.color.setHex(GUIDE_COLOR[turnAxisId(chosen.turnX, chosen.turnY, chosen.turnZ)]);
    this.turnHead.position.set(Math.cos(sweep) * 0.82, Math.sin(sweep) * 0.82, 0);
    this.turnTangent.set(-Math.sin(sweep), Math.cos(sweep), 0);
    this.turnHead.quaternion.setFromUnitVectors(this.turnUp, this.turnTangent);
  }

  /** A bar from an off-axis thruster or balloon to the line its push should follow. */
  private layoutMisses(): void {
    const misses = thrustMisses(this.blueprint);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < misses.length; i++) {
      const miss = misses[i]!;
      let mesh = this.missPool[i];
      if (!mesh) {
        mesh = new THREE.Mesh(this.missGeo, this.missMaterial[miss.axis]);
        mesh.frustumCulled = false;
        mesh.renderOrder = 12;
        mesh.layers.enable(GARAGE_LAYER);
        this.guide.add(mesh);
        this.missPool.push(mesh);
      }
      const from = new THREE.Vector3().fromArray(miss.from);
      const to = new THREE.Vector3().fromArray(miss.to);
      const dir = to.clone().sub(from);
      const length = dir.length();
      mesh.visible = length > 1e-4;
      if (!mesh.visible) continue;
      mesh.material = this.missMaterial[miss.axis];
      mesh.position.copy(from).add(to).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(up, dir.multiplyScalar(1 / length));
      mesh.scale.set(1, length, 1);
    }
    for (let i = misses.length; i < this.missPool.length; i++) this.missPool[i]!.visible = false;
  }

  /** Yellow dot at the centre of mass. The cross is the three ways a push can go straight. */
  private placeMarker(center: Cell): void {
    this.marker.position.fromArray(center).add(this.origin);
    const reach = guideReach(this.blueprint);
    this.layoutGuide(this.guideAxes.vertical, reach.vertical);
    this.layoutGuide(this.guideAxes.side, reach.side);
    this.layoutGuide(this.guideAxes.fore, reach.fore);
    this.layoutMisses();
    this.emphasizeGuide();
  }

  private rebuild(): void {
    this.group.clear();
    this.group.position.copy(this.origin);
    this.group.quaternion.identity();
    this.detailedSkylark = usesSkylarkModel(this.blueprint);
    this.visual.rebuild(this.blueprint);
    this.group.add(this.visual.root, this.skylark.root);
    this.group.traverse(object => object.layers.enable(GARAGE_LAYER));
    this.measurePreview();
    this.placeMarker(machineStats(this.blueprint).center);
    this.ghost.root.visible = false;
    this.hovered = -1;
    this.placement = null;
    this.stage.root.position.copy(this.origin);
    this.stage.fit(this.blueprint);
  }

  private measurePreview(): void {
    this.group.updateMatrixWorld(true);
    this.previewBounds.makeEmpty();
    this.skylarkPreviewCorners.length = 0;
    if (this.detailedSkylark && this.skylark.root.visible) {
      this.skylark.measure(this.previewBounds, this.skylarkPreviewCorners);
    } else {
      for (const mesh of this.visual.meshes) {
        mesh.computeBoundingBox();
        if (mesh.boundingBox) this.previewBounds.union(this.previewPartBounds.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld));
      }
    }
    if (this.previewBounds.isEmpty()) this.previewFocus.copy(this.origin);
    else this.previewBounds.getCenter(this.previewFocus);
  }

  private refreshSkylark(): void {
    const show = this.active && this.detailedSkylark && (!!this.physics || !this.panel.canEdit);
    const visible = show && this.skylark.loaded;
    const changed = this.skylark.root.visible !== visible;
    this.skylark.root.visible = visible;
    this.visual.root.visible = !show;
    const inspect = !this.physics && this.panel.showingModel;
    const layoutChanged = this.skylark.setMode(
      !!this.physics,
      inspect && this.skylarkExploded,
      inspect ? this.skylarkSelected : null,
    );
    if ((changed || (visible && layoutChanged)) && !this.physics) {
      this.measurePreview();
      this.frameCamera(this.elevation);
    }
    if (!show || this.skylark.loaded || this.skylarkPreviewRequested) return;
    this.skylarkPreviewRequested = true;
    void this.skylark.ready.then(() => {
      if (!this.disposed) this.refresh();
    }).catch(() => {
      if (!this.disposed && this.active && this.detailedSkylark) {
        this.say(t("Skylark 외형을 불러오지 못했습니다. 시험 비행을 누르면 다시 시도합니다.",
          "Skylark's model couldn't load. Try again with Test flight."), "bad");
      }
    });
  }

  private refresh(): void {
    this.primed = true;
    this.previewDirty = true;
    if (this.panel.showingModel && !this.detailedSkylark) this.panel.showScreen("parts");
    if (this.panel.showingModel) this.coach.element.hidden = true;
    const needsBlockThumbnails = this.panel.element.dataset.screen === "library" &&
      this.entries.some(entry => !usesSkylarkModel(entry.blueprint));
    if (this.active && !this.assetFailure && (!this.detailedSkylark || this.panel.canEdit || needsBlockThumbnails)) this.loadAssets();
    this.refreshSkylark();
    this.schedulePhysicsWarmup();
    this.stage.root.visible = this.active && !this.physics;
    this.marker.visible = this.active && !this.physics && this.showCenter && !this.skylark.root.visible;
    const view: BuildView = {
      blueprint: this.blueprint,
      stats: machineStats(this.blueprint),
      selected: this.selected,
      direction: this.direction,
      mirror: this.mirror,
      centerVisible: this.showCenter,
      erase: this.erase,
      assist: this.assist,
      inspectMode:this.inspectMode,
      inspected:this.inspectedIndex(),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      running: !!this.physics,
      loading: this.loading,
      assetsReady: this.assets.loaded,
      skylark: this.detailedSkylark ? {
        components: this.skylark.components,
        selected: this.skylarkSelected,
        exploded: this.skylarkExploded,
      } : null,
      message: this.statusLine(),
      tone: this.statusTone(),
      entries: this.entries,
      recovery: this.store.recovery(),
      record: this.record,
    };
    this.showInspection(this.inspectMode ? this.inspectedIndex() : -1);
    this.panel.update(view);
    this.panel.setShare(encodeShare(this.blueprint));
    this.emphasizeGuide();
    this.ghost.set(this.selected, this.direction);
    this.ghost.root.traverse(object => object.layers.enable(GARAGE_LAYER));
  }

  private statusLine(): string {
    if (this.assetFailure) return this.assetFailure;
    const error = blueprintError(this.blueprint);
    if (error) return error;
    if (this.saveFailed) return t("설계도 저장에 실패했습니다.", "Saving the blueprint failed.");
    // Nothing to report is its own answer: the hint block collapses rather
    // than holding 50px of panel open to repeat itself.
    return this.message;
  }
  private statusTone(): MessageTone {
    if (this.assetFailure || blueprintError(this.blueprint) || this.saveFailed)
      return "bad";
    return this.message ? this.tone : "info";
  }

  // ---------------------------------------------------------- 3D picking

  /** Follow the actual block edges while preserving the selected paint colour. */
  private showInspection(index: number): void {
    this.visual.highlight(-1, HIGHLIGHT);
    const outline = this.selectionOutline.object;
    outline.visible = this.active && !this.physics && index >= 0;
    if (!outline.visible) return;
    this.group.updateMatrixWorld(true);
    this.selectionOutline.show(this.visual.meshes, customizationScope(this.blueprint, index, this.mirror).indices);
  }

  private aimRay(x: number, y: number): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.group.updateMatrixWorld(true);
    this.ray.setFromCamera(
      this.pointer.set(
        ((x - bounds.left) / bounds.width) * 2 - 1,
        (-(y - bounds.top) / bounds.height) * 2 + 1,
      ),
      this.camera,
    );
  }

  private aim(x: number, y: number): void {
    this.ghost.root.visible = false;
    this.hovered = -1;
    this.placement = null;
    if (this.physics || this.loading || !this.panel.canEdit) {
      this.visual.highlight(-1, HIGHLIGHT);
      return;
    }
    this.previewDirty = true;
    this.aimRay(x, y);
    const hit = this.ray.intersectObjects(this.visual.meshes, false)[0];
    const index = hit ? this.visual.partIndex(hit) : undefined;
    if (!hit || index === undefined) {
      this.visual.highlight(-1, HIGHLIGHT);
      if (this.inspectMode) this.showInspection(this.inspectedIndex());
      return;
    }
    const part = this.blueprint.parts[index]!;
    this.hovered = index;
    if(this.inspectMode){this.showInspection(this.inspectedIndex());return;}
    this.visual.highlight(this.erase ? index : -1, HIGHLIGHT);
    if (this.erase) return;
    const offset = this.scratch
      .copy(hit.point)
      .sub(this.origin)
      .sub(this.desired.fromArray(part.cell));
    if(part.kind==="wheel"&&["body","wheel-hub"].includes(String(hit.object.userData.machineRole??"body")))offset.y+=0.65;
    const axes = [Math.abs(offset.x), Math.abs(offset.y), Math.abs(offset.z)];
    // Use the actual hit face, including the instance's rotation. Picking by
    // distance from a hollow cockpit's centre could aim at an occupied cell.
    if (hit.face && hit.instanceId !== undefined && hit.object instanceof THREE.InstancedMesh) {
      hit.object.getMatrixAt(hit.instanceId, this.partMatrix);
      this.partMatrix.premultiply(hit.object.matrixWorld);
      this.faceNormal.copy(hit.face.normal).transformDirection(this.partMatrix);
      axes[0] = Math.abs(this.faceNormal.x);
      axes[1] = Math.abs(this.faceNormal.y);
      axes[2] = Math.abs(this.faceNormal.z);
      offset.copy(this.faceNormal);
    }
    const axis = axes.indexOf(Math.max(...axes)) as 0 | 1 | 2;
    const cell: Cell = [...part.cell];
    cell[axis] += Math.sign(offset.getComponent(axis)) || 1;
    this.placement = cell;
    this.ghost.set(this.selected,this.direction,wheelMountSide(this.blueprint,cell));
    this.ghost.root.traverse(object => object.layers.enable(GARAGE_LAYER));
    this.ghost.setErasing(this.blueprint.parts.some(part => part.cell.every((value, axis) => value === cell[axis])));
    this.ghost.root.position.fromArray(cell).add(this.origin);
    this.ghost.root.visible = true;
  }

  private frameCamera(elevation = .42): void {
    this.previewDirty = true;
    this.elevation = elevation;
    if (this.previewBounds.isEmpty()) { this.distance = 10.5; return; }
    // Fit the real geometry into the clear stage above the workbench.
    const out = new THREE.Vector3(Math.sin(this.theta) * Math.cos(this.elevation), Math.sin(this.elevation), Math.cos(this.theta) * Math.cos(this.elevation));
    const right = new THREE.Vector3(out.z, 0, -out.x).normalize();
    const up = new THREE.Vector3().crossVectors(out, right);
    const tangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const vertical = tangent * (this.panel.previewHeight || window.innerHeight * .48) / window.innerHeight * .8;
    const lane = this.panel.balanceLane;
    const widthScale = lane > 0 ? Math.max(0.62, (window.innerWidth - lane) / window.innerWidth) : 1;
    const horizontal = tangent * window.innerWidth / window.innerHeight * (this.panel.previewWidth || window.innerWidth) / window.innerWidth * .88 * widthScale;
    const point = new THREE.Vector3();
    let required = 1;
    const fitPoint = () => {
      point.sub(this.previewFocus);
      required = Math.max(required, point.dot(out) + Math.abs(point.dot(right)) / horizontal, point.dot(out) + Math.abs(point.dot(up)) / vertical);
    };
    if (this.skylarkPreviewCorners.length) {
      for (const corner of this.skylarkPreviewCorners) {
        point.copy(corner);
        fitPoint();
      }
    } else {
      for (const x of [this.previewBounds.min.x, this.previewBounds.max.x])
        for (const y of [this.previewBounds.min.y, this.previewBounds.max.y])
          for (const z of [this.previewBounds.min.z, this.previewBounds.max.z]) {
            point.set(x, y, z);
            fitPoint();
          }
    }
    this.distance = Math.max(6, required / this.panel.previewZoom);
  }

  // ------------------------------------------------------------ test run

  /** Highest ground under the 7×7 test apron: blocks built there since the lab opened (or a
   *  field/classroom that scrolled) must not leave the machine spawning inside them. */
  private groundY(): number {
    let top = 0;
    for (let x = 76; x <= 82; x++) for (let z = 15; z <= 21; z++) top = Math.max(top, surfaceY(this.voxels, x, z));
    return top;
  }

  private settleOrigin(): void {
    const y = this.groundY() + 4;
    if (y === this.origin.y) return;
    this.origin.y = y;
    this.rebuild();
  }

  async runOrStop(): Promise<void> {
    if (!this.active || this.loading) return;
    if (this.physics) {
      this.stop();
      return;
    }
    const error = blueprintError(this.blueprint);
    if (error) {
      this.say(error, "bad");
      this.toasts.show(error, "bad");
      return;
    }
    this.loading = true;
    const generation = ++this.generation;
    this.refresh();
    let failure = "";
    try {
      const [rapier] = await Promise.all([
        loadPhysics(),
        this.detailedSkylark ? this.skylark.ready : this.assets.ready,
      ]);
      if (generation !== this.generation || !this.active) return;
      this.settleOrigin();
      this.physics = new MachinePhysics(
        rapier,
        this.voxels,
        cloneBlueprint(this.blueprint),
        this.origin,
      );
      this.run = new MissionRun(this.origin, this.record.cleared);
      this.marker.visible = false;
      this.ghost.root.visible = false;
      this.visual.highlight(-1, HIGHLIGHT);
      this.coach.element.hidden = true;
      this.chaseReady = false;
      this.shake = 0;
      this.lastVerticalSpeed = 0;
      this.hudUpdateIn = 0;
      this.keys.clear();
      this.dust.clear();
      this.audio.start();
      this.hud.setVisible(true);
      this.camera.clearViewOffset();
      this.message = "";
    } catch (error) {
      failure = t(`시험을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, `Couldn't start the test: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        if (failure) {
          this.say(failure, "bad");
          this.toasts.show(failure, "bad");
        } else this.refresh();
      }
    }
  }

  private stop(): void {
    if (!this.physics && !this.loading) return;
    this.generation++;
    this.loading = false;
    if (this.run) {
      const progress = this.run.progress();
      this.record = this.store.mergeRecord({
        cleared: this.run.cleared,
        topSpeed: progress.topSpeed,
        peakAltitude: progress.peakAltitude,
        distance: progress.distance,
        runs: 1,
      });
      this.run = null;
    }
    this.physics?.dispose();
    this.physics = null;
    this.keys.clear();
    this.audio.stop();
    this.dust.clear();
    this.hud.setVisible(false);
    this.restoreCamera();
    this.chaseReady = false;
    this.rebuild();
    this.marker.visible = this.active;
    this.refresh();
  }

  private respawn(reason: string): void {
    if (!this.physics) return;
    try {
      this.physics.respawn(this.origin);
    } catch {
      this.stop();
      return;
    }
    this.chaseReady = false;
    this.dust.clear();
    this.toasts.show(reason, "bad");
  }

  fixedUpdate(): void {
    if (this.science?.active) {
      this.science.fixedUpdate(1 / 60);
      return;
    }
    if (!this.active || !this.physics) return;
    const axis = (a: string, b: string) =>
      Number(this.keys.has(a)) - Number(this.keys.has(b));
    try {
      // With assist on, Space/Ctrl are a climb REQUEST that the autopilot
      // turns into thruster throttle; with it off they are the raw lift input,
      // so switching assist off leaves the original model exactly as it was.
      // Z descends: Ctrl did, but Ctrl+W (held with throttle) closes the tab and cannot be cancelled
      const climb = axis("Space", "KeyZ");
      this.physics.step({
        ...IDLE_INPUT,
        throttle: axis("KeyW", "KeyS"),
        steer: axis("KeyA", "KeyD"),
        lift: this.assist ? 0 : Number(this.keys.has("Space")),
        vertical: this.assist ? climb : 0,
        assist: this.assist,
        boost: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
        brake: this.keys.has("KeyX"),
        pitch: axis("ArrowUp", "ArrowDown") ||
          (this.detailedSkylark ? axis("KeyW", "KeyS") : 0),
        roll: axis("KeyQ", "KeyE"),
      });
    } catch (error) {
      this.stop();
      this.say(
        error instanceof Error
          ? error.message
          : t("시험 중 오류가 발생해 제작대로 돌아왔습니다.", "Something went wrong during the test — back to the workbench."),
        "bad",
      );
      return;
    }
    const state = this.physics.snapshot();
    const cleared = this.run?.update(state, 1 / 60) ?? [];
    for (const id of cleared) {
      const mission = MISSIONS.find((m) => m.id === id);
      if (!mission) continue;
      this.toasts.show(`${t("임무 완료", "Mission complete")} · ${t(mission.name, mission.en.name)}`, "good");
      this.audio.fanfare();
    }
    // Landing thump: the vertical speed that vanished in this one step.
    const landing = this.lastVerticalSpeed - state.velocity.y;
    if (state.contacts > 0 && landing > 3) {
      this.shake = Math.min(0.9, landing / 16);
      this.audio.impact(Math.min(1, landing / 14));
    }
    this.lastVerticalSpeed = state.velocity.y;
    const p = state.position;
    if (
      p.y < BOUNDS.minY ||
      p.y > BOUNDS.maxY ||
      p.x < BOUNDS.minX ||
      p.z < BOUNDS.minZ ||
      p.x > BOUNDS.maxX ||
      p.z > BOUNDS.maxZ
    )
      this.respawn(t("시험 구역을 벗어나 출발점으로 되돌렸습니다.", "You left the test area — back to the start."));
  }

  // -------------------------------------------------------------- render

  get previewing(): boolean {
    return this.active && !this.physics && !this.scienceActive;
  }

  /** Prepare nearby terrain in the existing chunk budget while the test screen is open. */
  get flightPreparationFocus(): THREE.Vector3 | null {
    const ready = this.detailedSkylark ? this.skylark.loaded : this.assets.loaded;
    return this.loading || (ready && this.flightScreen) ? this.origin : null;
  }

  private get flightScreen(): boolean {
    return this.panel.showingModel || this.panel.element.dataset.screen === "missions";
  }

  private schedulePhysicsWarmup(): void {
    const ready = this.detailedSkylark ? this.skylark.loaded : this.assets.loaded;
    if (!this.active || !this.flightScreen || !ready || physicsModule || this.loading) {
      window.clearTimeout(this.physicsWarmup);
      this.physicsWarmup = undefined;
      return;
    }
    if (this.physicsWarmup !== undefined) return;
    this.physicsWarmup = window.setTimeout(() => {
      this.physicsWarmup = undefined;
      void loadPhysics().catch(() => undefined); // The actual test can retry a failed warm-up.
    }, 350);
  }

  render(dt = 1 / 60): THREE.Vector3 | null {
    const step = Math.min(0.05, Math.max(0.001, dt));
    if (this.physics) {
      this.renderDriving(step);
      this.dust.update(step);
    } else if (!this.renderBuilding()) return null;
    return this.target;
  }

  private renderBuilding(): boolean {
    const { previewWidth, previewHeight, previewOffsetY, balanceLane } = this.panel;
    const viewport = `${this.canvas.width}:${this.canvas.height}:${previewWidth}:${previewHeight}:${previewOffsetY}:${balanceLane}:${this.camera.fov}:${this.renderer.shadowMap.enabled}`;
    if (viewport !== this.previewViewport) {
      this.previewViewport = viewport;
      this.frameCamera(this.elevation);
    }
    if (!this.previewDirty) return false;
    this.previewDirty = false;
    this.camera.layers.set(GARAGE_LAYER);
    this.target.copy(this.previewFocus);
    this.orbitCamera(this.distance * this.panel.previewZoom);
    // Leave space for the tool palette without skewing the machine itself.
    this.camera.setViewOffset(
      window.innerWidth,
      window.innerHeight,
      this.panel.balanceLane / 2,
      this.panel.previewOffsetY,
      window.innerWidth,
      window.innerHeight,
    );
    return true;
  }

  private renderDriving(dt: number): void {
    this.camera.layers.mask = this.baseCameraLayers;
    const physics = this.physics!;
    const state = physics.snapshot();
    const q = state.rotation;
    this.group.position.copy(state.position);
    this.group.quaternion.set(q.x, q.y, q.z, q.w);
    this.bodyQuaternion.set(q.x, q.y, q.z, q.w);
    physics.wheelParts.forEach((partIndex, i) => {
      this.visual.wheel(
        partIndex,
        physics.wheels.wheelSuspensionLength(i) ?? 0.65,
        physics.wheels.wheelRotation(i) ?? 0,
        physics.wheels.wheelSteering(i) ?? 0,
      );
    });
    this.visual.flushWheels();
    const lift = Math.max(
      Number(this.keys.has("Space")),
      state.hoverThrottle,
    );
    const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    if (this.detailedSkylark) this.skylark.step(dt, lift);
    else this.visual.thrust(lift, boost, performance.now() / 1000);

    this.spawnDust(physics, state.speed);
    const throttle =
      Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    this.audio.update(throttle, state.speed, lift || (boost ? 1 : 0));
    this.hudUpdateIn -= dt;
    if (this.hudUpdateIn <= 0) {
      this.hudUpdateIn = .08;
      this.updateDriveHud(state, throttle, lift, boost);
    }
    this.target.copy(this.group.position);
    this.driveCamera(dt, state.speed);
  }

  private updateDriveHud(state: ReturnType<MachinePhysics["snapshot"]>, throttle: number, lift: number, boost: boolean): void {
    const euler = this.driveAngles.setFromQuaternion(this.bodyQuaternion);
    this.hud.update({
      speed: state.speed,
      altitude: Math.max(0, state.altitude),
      contacts: state.contacts,
      wheels: state.wheels,
      pitch: euler.x,
      roll: euler.z,
      throttle,
      lift,
      boost,
      camera: this.camera3rd,
      assist: this.assist,
      canHover: state.canHover,
      hasWings: this.blueprint.parts.some((p) => p.kind === "wing"),
      hasBoost: this.blueprint.parts.some(
        (p) => p.kind === "thruster" && p.direction !== 0,
      ),
    });
    if (this.run) {
      const progress = this.run.progress();
      this.hud.updateMissions(progress);
      this.panel.setRunLine(
        progress.seconds,
        progress.distance,
        progress.topSpeed,
      );
    }
  }

  private spawnDust(physics: MachinePhysics, speed: number): void {
    if (speed < 2.2) return;
    physics.wheelParts.forEach((partIndex, i) => {
      if (!physics.wheels.wheelIsInContact(i)) return;
      if (Math.random() > Math.min(0.5, speed / 40)) return;
      const cell = this.blueprint.parts[partIndex]?.cell;
      if (!cell) return;
      this.scratch
        .fromArray(cell)
        .applyQuaternion(this.bodyQuaternion)
        .add(this.group.position);
      this.dust.spawn(
        this.scratch.x,
        this.scratch.y - 0.7,
        this.scratch.z,
        Math.min(1, speed / 18),
      );
    });
  }

  private driveCamera(dt: number, speed: number): void {
    if (this.camera3rd === "orbit") {
      this.orbitCamera();
      this.applyFov(speed);
      return;
    }
    if (this.camera3rd === "cockpit") {
      // Sit just outside the canopy: anywhere inside the 1 m cockpit cell puts
      // the near plane through the machine's own hull and fills the screen.
      const seat = this.blueprint.parts.find((p) => p.kind === "cockpit");
      if (this.detailedSkylark) this.scratch.set(0, 1.55, 2.50);
      else this.scratch.fromArray(seat?.cell ?? [0, 0, 0]).add(this.desired.set(0, .45, .95));
      this.scratch.applyQuaternion(this.bodyQuaternion).add(this.group.position);
      this.camera.position.copy(this.scratch);
      this.camera.quaternion
        .copy(this.bodyQuaternion)
        .multiply(this.cockpitTurn);
      this.applyFov(speed);
      return;
    }
    // Chase: follow the machine's heading in yaw only. Pitch and roll on the
    // camera is what makes a flying build unwatchable, so the rig stays level
    // and the horizon ball on the HUD carries the attitude instead.
    this.forward.set(0, 0, 1).applyQuaternion(this.bodyQuaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-4) this.forward.set(0, 0, 1);
    this.forward.normalize();
    const velocity = this.physics!.body.linvel();
    if (speed > 5) {
      this.desired.set(velocity.x, 0, velocity.z);
      if (this.desired.lengthSq() > 1e-4)
        this.forward.lerp(this.desired.normalize(), 0.45).normalize();
    }
    const back = 8.5 + Math.min(5, speed * 0.22);
    this.desired
      .copy(this.group.position)
      .addScaledVector(this.forward, -back)
      .add(this.scratch.set(0, 3.4 + Math.min(2.4, speed * 0.08), 0));
    if (!this.chaseReady) {
      this.chasePosition.copy(this.desired);
      this.chaseReady = true;
    } else
      this.chasePosition.lerp(this.desired, 1 - Math.pow(0.0016, dt));
    this.camera.position.copy(this.chasePosition);
    if (this.shake > 0.002) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.pow(0.02, dt);
    }
    this.camera.lookAt(
      this.scratch
        .copy(this.group.position)
        .addScaledVector(this.forward, 2.5)
        .add(this.desired.set(0, 1.1, 0)),
    );
    this.applyFov(speed);
  }

  private applyFov(speed: number): void {
    if (!this.baseFov) return;
    const target = this.baseFov + Math.min(11, speed * 0.42);
    if (Math.abs(this.camera.fov - target) > 0.05) {
      this.camera.fov = target;
      this.camera.updateProjectionMatrix();
    }
  }

  private orbitCamera(distance = this.distance): void {
    const offset = this.scratch.set(
      Math.sin(this.theta) * Math.cos(this.elevation),
      Math.sin(this.elevation),
      Math.cos(this.theta) * Math.cos(this.elevation),
    );
    this.camera.position
      .copy(this.target)
      .addScaledVector(offset, distance);
    this.camera.lookAt(this.target);
  }

  // ------------------------------------------------------------- exposed

  private previewFootprint(): { left: number; top: number; right: number; bottom: number } | null {
    if (!this.active || this.physics || this.previewBounds.isEmpty()) return null;
    const rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const x of [this.previewBounds.min.x, this.previewBounds.max.x]) {
      for (const y of [this.previewBounds.min.y, this.previewBounds.max.y]) {
        for (const z of [this.previewBounds.min.z, this.previewBounds.max.z]) {
          this.scratch.set(x, y, z).project(this.camera);
          const px = (this.scratch.x + 1) * window.innerWidth / 2;
          const py = (1 - this.scratch.y) * window.innerHeight / 2;
          rect.left = Math.min(rect.left, px); rect.right = Math.max(rect.right, px);
          rect.top = Math.min(rect.top, py); rect.bottom = Math.max(rect.bottom, py);
        }
      }
    }
    return rect;
  }

  snapshot() {
    return {
      active: this.active,
      loading: this.loading,
      blueprint: cloneBlueprint(this.blueprint),
      simulation: this.physics?.snapshot() ?? null,
      assetsLoaded: this.assets.loaded,
      editor: {
        screen: this.panel.element.dataset.screen,
        skylark: this.detailedSkylark ? {
          visible: this.skylark.root.visible,
          parts: this.skylark.components.length,
          exploded: this.skylarkExploded && this.panel.showingModel && !this.physics,
          selected: this.skylarkSelected,
        } : null,
        inspectMode: this.inspectMode,
        inspected: this.inspectedIndex(),
        scope: customizationScope(this.blueprint, this.inspectedIndex(), this.mirror),
        hovered: this.hovered,
        placement: this.placement ? [...this.placement] : null,
        preview: this.previewFootprint(),
      },
      science: this.science?.snapshot() ?? null,
      mirror: this.mirror,
      erase: this.erase,
      assist: this.assist,
      selected: this.selected,
      direction: this.direction,
      camera: this.camera3rd,
      missions: this.run?.progress() ?? null,
      record: this.record,
      library: this.entries.map((e) => e.id),
      recovery: this.store.recovery().map(entry => entry.id),
      share: encodeShare(this.blueprint),
    };
  }

  dispose(): void {
    window.clearTimeout(this.messageTimeout);
    window.clearTimeout(this.physicsWarmup);
    this.restoreCamera();
    this.stage.dispose();
    this.selectionOutline.dispose();
    this.thumbnails.dispose();
    this.selectionOutline.object.removeFromParent();
    this.generation++;
    this.events.abort();
    this.physics?.dispose();
    this.physics = null;
    this.science?.dispose();
    this.audio.dispose();
    this.group.clear();
    this.scene.remove(
      this.group,
      this.marker,
      this.ghost.root,
      this.dust.points,
    );
    this.disposed = true;
    this.visual.dispose();
    this.skylark.dispose();
    this.ghost.dispose();
    this.dust.dispose();
    this.assets.dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
    this.guideShaft.dispose();
    this.guideCone.dispose();
    this.missGeo.dispose();
    this.turnArc.geometry.dispose();
    this.turnHead.geometry.dispose();
    this.turnMaterial.dispose();
    for (const axis of Object.values(this.guideAxes)) axis.material.dispose();
    for (const material of Object.values(this.missMaterial)) material.dispose();
    this.launch.remove();
    this.panel.element.remove();
    this.hud.element.remove();
    this.hud.chips.remove();
    this.coach.element.remove();
    this.toasts.dispose();
  }

  get scienceActive(): boolean {
    return this.science?.active ?? false;
  }
  renderScience(dt: number): void {
    this.science?.render(dt);
  }
  private async openScience(): Promise<void> {
    if (this.physics || this.loading) return;
    try {
      await this.assets.ready;
      if (this.disposed || !this.active) return;
      this.keys.clear();
      this.science ??= new ScienceLab(this.assets, () => this.keys.clear());
      this.science.open();
    } catch (error) {
      this.say(
        error instanceof Error
          ? error.message
          : t("과학 실험실을 열지 못했습니다.", "Couldn't open the science lab."),
        "bad",
      );
    }
  }
}
