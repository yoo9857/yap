import * as THREE from "three";
import type { RapierModule } from "../../physics/physics.js";
import { surfaceY, type VoxelWorld } from "../voxelWorld.js";
import {
  addPart,
  BLUEPRINT_KEY,
  blueprintError,
  cloneBlueprint,
  DIRECTIONS,
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
import { GhostPart, MachineAssets, MachineVisual } from "./machineVisual.js";
import { DustField, MachineAudio } from "./machineFx.js";
import { MachineStore, decodeShare, encodeShare } from "./library.js";
import { MISSIONS, MissionRun } from "./missions.js";
import { ScienceLab } from "./scienceLab.js";
import {
  BuildPanel,
  CAMERA_LABEL,
  Coach,
  DriveHud,
  Toasts,
  type BuildView,
  type CameraMode,
  type MessageTone,
} from "./workshopUi.js";
import "./workshop.css";

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
  private erase = false;
  /** Beginner autopilot, on until the player turns it off. */
  private assist = true;

  private readonly group = new THREE.Group();
  private readonly marker = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd21c, depthTest: false }),
  );
  private readonly markerRing = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.56, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffd21c,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );
  private readonly assets = new MachineAssets();
  private readonly visual = new MachineVisual(this.assets);
  private readonly ghost = new GhostPart(this.assets);
  private readonly dust = new DustField();
  private readonly audio = new MachineAudio();
  private readonly store = new MachineStore();
  private record = this.store.record();
  private entries = this.store.entries();
  private run: MissionRun | null = null;
  private disposed = false;
  private assetFailure = "";
  private science: ScienceLab | null = null;

  private readonly launch: HTMLButtonElement;
  private readonly panel: BuildPanel;
  private readonly hud = new DriveHud();
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
  private distance = 13;
  private camera3rd: CameraMode = "chase";
  private chaseReady = false;
  private baseFov = 0;
  private shake = 0;
  private lastVerticalSpeed = 0;

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
  private tone: MessageTone = "info";
  private saveFailed = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly voxels: VoxelWorld,
    private readonly onActive: (active: boolean) => void,
  ) {
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
    this.origin.set(79.5, surfaceY(voxels, 79, 18) + 4, 18.5);
    this.group.visible = false;
    this.marker.visible = false;
    this.marker.renderOrder = 11;
    this.markerRing.renderOrder = 11;
    this.markerRing.rotation.x = -Math.PI / 2;
    this.marker.add(this.markerRing);
    this.ghost.root.visible = false;
    scene.add(this.group, this.marker, this.ghost.root, this.dust.points);

    const signal = this.events.signal;
    this.launch = document.createElement("button");
    this.launch.className = "machine-ui machine-launch mw-btn";
    this.launch.innerHTML = "🔧 기계 제작소 <kbd class='mw-kbd'>B</kbd>";
    this.panel = new BuildPanel(
      {
        selectPart: (kind) => this.pickPart(kind),
        setDirection: (direction) => {
          this.direction = direction;
          this.refresh();
        },
        usePreset: (kind) => this.applyPreset(kind),
        quickStart: (kind) => void this.quickStart(kind),
        toggleAssist: () => this.setAssist(!this.assist),
        rename: (name) => {
          this.blueprint.name = name.trim().slice(0, 48) || "나의 기계";
          this.commit(false);
        },
        undo: () => this.undo(),
        redo: () => this.redo(),
        toggleMirror: () => {
          this.mirror = !this.mirror;
          this.say(
            this.mirror
              ? "좌우 대칭 켜짐 · 반대쪽에도 똑같이 붙습니다."
              : "좌우 대칭 꺼짐",
            "info",
          );
        },
        toggleErase: () => {
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
        loadSlot: (id) => this.loadSlot(id),
        deleteSlot: (id) => {
          this.entries = this.store.remove(id);
          this.refresh();
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
    window.addEventListener("keydown", (e) => this.onKeyDown(e), { signal });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code), {
      signal,
    });
    window.addEventListener("blur", () => this.keys.clear(), { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) this.keys.clear();
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
        this.aim(e.clientX, e.clientY);
        if (e.button === 2 || this.erase) this.removeHovered();
        else if (e.button === 0) this.placeHere();
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
      },
      { signal, passive: false },
    );

    this.group.add(this.visual.root);
    void this.assets.ready
      .then(() => {
        if (this.disposed) return;
        this.rebuild();
        this.ghost.set(this.selected, this.direction);
      })
      .catch(() => {
        this.assetFailure =
          "기계 에셋을 불러오지 못했습니다. 새로고침해 주세요.";
        if (!this.disposed) this.say(this.assetFailure, "bad");
      });
    this.rebuild();
    this.refresh();
  }

  // ------------------------------------------------------------- editing

  private pickPart(kind: PartKind): void {
    this.selected = kind;
    this.erase = false;
    this.ghost.setErasing(false);
    if (!PARTS[kind].directional) this.direction = 0;
    this.refresh();
  }

  private remember(): void {
    this.undoStack.push(cloneBlueprint(this.blueprint));
    if (this.undoStack.length > 30) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous || this.physics || this.loading) return;
    this.redoStack.push(cloneBlueprint(this.blueprint));
    this.blueprint = previous;
    this.commit();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next || this.physics || this.loading) return;
    this.undoStack.push(cloneBlueprint(this.blueprint));
    this.blueprint = next;
    this.commit();
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
        `여기에는 붙일 수 없습니다. 부품 ${this.blueprint.parts.length}/128, 중심에서 12칸까지입니다.`,
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
    this.say("조종석만 남겼습니다. 여기서 다시 시작해 보세요.", "info");
  }

  /** Skip the workbench entirely: load an example and drive it right away. */
  private async quickStart(kind: PresetKind): Promise<void> {
    if (this.physics || this.loading) return;
    this.applyPreset(kind);
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
      on ? "조작 보조 켜짐 · 저절로 수평을 잡아요" : "조작 보조 꺼짐 · 물리 그대로",
      "good",
      on ? "🛟" : "🎛️",
    );
    this.refresh();
  }

  private applyPreset(kind: PresetKind): void {
    this.remember();
    this.blueprint = preset(kind);
    this.commit();
    this.frameCamera();
    this.say(`${this.blueprint.name} 예제를 불러왔습니다.`, "good");
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
    this.entries = this.store.put(
      this.blueprint.name || "이름 없는 기계",
      this.blueprint,
      Date.now(),
    );
    this.say(
      this.store.failed
        ? "저장 공간에 접근할 수 없어 보관하지 못했습니다."
        : `'${this.blueprint.name}'을(를) 보관함에 넣었습니다.`,
      this.store.failed ? "bad" : "good",
    );
    this.refresh();
  }

  private loadSlot(id: string): void {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    this.remember();
    this.blueprint = cloneBlueprint(entry.blueprint);
    this.commit();
    this.frameCamera();
    this.say(`'${entry.blueprint.name}'을(를) 불러왔습니다.`, "good");
  }

  private importShare(code: string): void {
    const loaded = decodeShare(code);
    if (!loaded) {
      this.say("공유 코드를 읽지 못했습니다. CYM1… 전체를 붙여넣어 주세요.", "bad");
      return;
    }
    this.remember();
    this.blueprint = loaded;
    this.commit();
    this.frameCamera();
    this.say(`'${loaded.name}'을(를) 코드에서 불러왔습니다.`, "good");
  }

  private say(text: string, tone: MessageTone = "info"): void {
    this.message = text;
    this.tone = tone;
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
    if (!this.active || this.science?.active || this.typing(event.target))
      return;
    if (
      ["Space", "ArrowUp", "ArrowDown", "KeyW", "KeyS", "KeyA", "KeyD"].includes(
        event.code,
      )
    )
      event.preventDefault();
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
      if (event.code === "KeyR") this.respawn("제자리로 돌아왔습니다.");
      return;
    }
    const slot = Number(event.key);
    if (Number.isInteger(slot) && slot >= 1 && slot <= PART_ORDER.length) {
      this.pickPart(PART_ORDER[slot - 1]!);
      return;
    }
    switch (event.code) {
      case "KeyR":
        if (PARTS[this.selected].directional) {
          this.direction = (this.direction + 1) % DIRECTIONS.length;
          this.refresh();
        }
        break;
      case "KeyM":
        this.mirror = !this.mirror;
        this.say(this.mirror ? "좌우 대칭 켜짐" : "좌우 대칭 꺼짐", "info");
        break;
      case "KeyX":
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
    if (this.science?.active) {
      this.science.close();
      return;
    }
    if (this.active) {
      this.stop();
      this.save();
    }
    this.active = !this.active;
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
      this.baseFov ||= this.camera.fov;
      this.entries = this.store.entries();
      this.record = this.store.record();
      this.rebuild();
      this.refresh();
      this.maybeCoach();
    } else {
      this.coach.element.hidden = true;
      this.restoreCamera();
    }
    this.onActive(this.active);
  }

  private maybeCoach(): void {
    let seen = "1";
    try {
      seen = localStorage.getItem(COACH_KEY) ?? "";
    } catch {
      /* storage unavailable */
    }
    if (!seen) this.coach.start();
  }

  private restoreCamera(): void {
    if (this.baseFov && this.camera.fov !== this.baseFov) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
  }

  private rebuild(): void {
    this.group.clear();
    this.group.position.copy(this.origin);
    this.group.quaternion.identity();
    this.visual.rebuild(this.blueprint);
    this.group.add(this.visual.root);
    this.marker.position
      .fromArray(machineStats(this.blueprint).center)
      .add(this.origin);
    this.ghost.root.visible = false;
    this.hovered = -1;
    this.placement = null;
  }

  private refresh(): void {
    const view: BuildView = {
      blueprint: this.blueprint,
      stats: machineStats(this.blueprint),
      selected: this.selected,
      direction: this.direction,
      mirror: this.mirror,
      erase: this.erase,
      assist: this.assist,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      running: !!this.physics,
      loading: this.loading,
      message: this.statusLine(),
      tone: this.statusTone(),
      entries: this.entries,
      record: this.record,
    };
    this.panel.update(view);
    this.panel.setShare(encodeShare(this.blueprint));
    this.ghost.set(this.selected, this.direction);
  }

  private statusLine(): string {
    if (this.assetFailure) return this.assetFailure;
    const error = blueprintError(this.blueprint);
    if (error) return error;
    if (this.saveFailed) return "설계도 저장에 실패했습니다.";
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

  private aim(x: number, y: number): void {
    this.ghost.root.visible = false;
    this.hovered = -1;
    this.placement = null;
    if (this.physics || this.loading) {
      this.visual.highlight(-1, HIGHLIGHT);
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    this.group.updateMatrixWorld(true);
    this.ray.setFromCamera(
      this.pointer.set(
        ((x - bounds.left) / bounds.width) * 2 - 1,
        (-(y - bounds.top) / bounds.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = this.ray.intersectObjects(this.visual.meshes, false)[0];
    const index = hit ? this.visual.partIndex(hit) : undefined;
    if (!hit || index === undefined) {
      this.visual.highlight(-1, HIGHLIGHT);
      return;
    }
    const part = this.blueprint.parts[index]!;
    this.hovered = index;
    this.visual.highlight(this.erase ? index : -1, HIGHLIGHT);
    if (this.erase) return;
    const offset = this.scratch
      .copy(hit.point)
      .sub(this.origin)
      .sub(this.desired.fromArray(part.cell));
    const axes = [Math.abs(offset.x), Math.abs(offset.y), Math.abs(offset.z)];
    const axis = axes.indexOf(Math.max(...axes)) as 0 | 1 | 2;
    const cell: Cell = [...part.cell];
    cell[axis] += Math.sign(offset.getComponent(axis)) || 1;
    this.placement = cell;
    this.ghost.root.position.fromArray(cell).add(this.origin);
    this.ghost.root.visible = true;
  }

  private frameCamera(): void {
    const cells = this.blueprint.parts.map((p) => p.cell);
    const span = Math.max(
      3,
      ...cells.map((c) => Math.max(Math.abs(c[0]), Math.abs(c[1]), Math.abs(c[2]))),
    );
    this.distance = THREE.MathUtils.clamp(span * 2.6 + 5, 6, 38);
    this.elevation = 0.42;
  }

  // ------------------------------------------------------------ test run

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
      await this.assets.ready;
      const rapier = await loadPhysics();
      if (generation !== this.generation || !this.active) return;
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
      this.keys.clear();
      this.dust.clear();
      this.audio.start();
      this.hud.setVisible(true);
      this.camera.clearViewOffset();
      this.message = "";
    } catch (error) {
      failure = `시험을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        if (failure) {
          this.say(failure, "bad");
          this.toasts.show("물리 엔진을 불러오지 못했습니다.", "bad");
        } else this.refresh();
      }
    }
  }

  private stop(): void {
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
      const climb = axis("Space", "ControlLeft") || -Number(this.keys.has("ControlRight"));
      this.physics.step({
        ...IDLE_INPUT,
        throttle: axis("KeyW", "KeyS"),
        steer: axis("KeyA", "KeyD"),
        lift: this.assist ? 0 : Number(this.keys.has("Space")),
        vertical: this.assist ? climb : 0,
        assist: this.assist,
        boost: this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"),
        brake: this.keys.has("KeyX"),
        pitch: axis("ArrowUp", "ArrowDown"),
        roll: axis("KeyQ", "KeyE"),
      });
    } catch (error) {
      this.stop();
      this.say(
        error instanceof Error
          ? error.message
          : "시험 중 오류가 발생해 제작대로 돌아왔습니다.",
        "bad",
      );
      return;
    }
    const state = this.physics.snapshot();
    const cleared = this.run?.update(state, 1 / 60) ?? [];
    for (const id of cleared) {
      const mission = MISSIONS.find((m) => m.id === id);
      if (!mission) continue;
      this.toasts.show(`임무 완료 · ${mission.name}`, "good");
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
      this.respawn("시험 구역을 벗어나 출발점으로 되돌렸습니다.");
  }

  // -------------------------------------------------------------- render

  render(dt = 1 / 60): THREE.Vector3 {
    const step = Math.min(0.05, Math.max(0.001, dt));
    if (this.physics) this.renderDriving(step);
    else this.renderBuilding();
    this.dust.update(step);
    return this.target;
  }

  private renderBuilding(): void {
    this.target.copy(this.group.position).add(this.scratch.set(0, 0.5, 0));
    this.orbitCamera();
    // Leave space for the tool palette without skewing the machine itself.
    this.camera.setViewOffset(
      window.innerWidth,
      window.innerHeight,
      -Math.min(170, window.innerWidth * 0.17),
      0,
      window.innerWidth,
      window.innerHeight,
    );
  }

  private renderDriving(dt: number): void {
    const physics = this.physics!;
    const p = physics.body.translation(),
      q = physics.body.rotation();
    this.group.position.copy(p);
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
      physics.snapshot().hoverThrottle,
    );
    const boost = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
    this.visual.thrust(lift, boost, performance.now() / 1000);

    const state = physics.snapshot();
    this.spawnDust(physics, state.speed);
    const throttle =
      Number(this.keys.has("KeyW")) - Number(this.keys.has("KeyS"));
    this.audio.update(throttle, state.speed, lift || (boost ? 1 : 0));
    const euler = new THREE.Euler().setFromQuaternion(
      this.bodyQuaternion,
      "YXZ",
    );
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
    this.target.copy(this.group.position);
    this.driveCamera(dt, state.speed);
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
      this.scratch
        .fromArray(seat?.cell ?? [0, 0, 0])
        .add(this.desired.set(0, 0.45, 0.95))
        .applyQuaternion(this.bodyQuaternion)
        .add(this.group.position);
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

  private orbitCamera(): void {
    const offset = this.scratch.set(
      Math.sin(this.theta) * Math.cos(this.elevation),
      Math.sin(this.elevation),
      Math.cos(this.theta) * Math.cos(this.elevation),
    );
    this.camera.position
      .copy(this.target)
      .addScaledVector(offset, this.distance);
    this.camera.lookAt(this.target);
  }

  // ------------------------------------------------------------- exposed

  snapshot() {
    return {
      active: this.active,
      loading: this.loading,
      blueprint: cloneBlueprint(this.blueprint),
      simulation: this.physics?.snapshot() ?? null,
      assetsLoaded: this.assets.loaded,
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
      share: encodeShare(this.blueprint),
    };
  }

  dispose(): void {
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
    this.ghost.dispose();
    this.dust.dispose();
    this.assets.dispose();
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
    this.markerRing.geometry.dispose();
    (this.markerRing.material as THREE.Material).dispose();
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
          : "과학 실험실을 열지 못했습니다.",
        "bad",
      );
    }
  }
}
