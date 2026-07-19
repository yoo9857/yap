import * as THREE from "three";
import { SIM_DT } from "@robo/shared";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { Effects } from "../render/effects.js";
import { brickMaterial } from "../world/materials.js";
import { loadTexture, texturesReady, warmupGpu } from "../render/textures.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import {
  buy,
  createInitialState,
  currentLandmark,
  voxelsPerSecond,
  type BuilderState,
  type ShopItem,
} from "./state.js";
import { tick } from "./sim.js";
import { tryCompleteGoal } from "./goals.js";
import { LANDMARKS, landmarkAt } from "./landmarks.js";
import { clearSave, load, save } from "./save.js";
import { LandmarkView } from "./landmarkView.js";
import { WorkersView } from "./workersView.js";
import { BlockFlights } from "./blockFlights.js";
import { BuilderHud } from "./hud.js";
import { PerfMonitor } from "../ui/perf.js";
import { BuilderEnvironment } from "./environment.js";
import { CameraDirector, type ShotName } from "./cameraDirector.js";

const SAVE_INTERVAL_MS = 5000;
const BLOCK_SFX_MIN_GAP_MS = 120; // don't machine-gun the pop sound

// (viewing distances are now computed per frame from the monument's bounding
//  sphere — see CameraDirector's framing guarantee)

/**
 * Robo Builder — idle WORLD-LANDMARK construction. A faint ghost of the
 * blueprint shows the goal; blocky workers fill it in block by block. No
 * physics, no server: the pure sim ticks at 60 Hz, the render layer reuses
 * the tower game's renderer/rigs/effects/sfx, localStorage keeps the save.
 */
export class BuilderGame {
  private readonly renderer: GameRenderer;
  private readonly effects: Effects;
  private readonly sfx = new Sfx();
  private readonly bgm = new Bgm(BGM_PLAYLIST);
  private readonly landmarkView: LandmarkView;
  private readonly workersView: WorkersView;
  private readonly flights: BlockFlights;
  private readonly flightFrom = new THREE.Vector3();
  private readonly hud: BuilderHud;
  private readonly environment: BuilderEnvironment;
  private readonly loop: GameLoop;
  private readonly state: BuilderState;
  private readonly director = new CameraDirector();
  private readonly perf = new PerfMonitor(document.body);
  private readonly pile = new THREE.Group();
  private ground: THREE.Mesh | null = null;
  private lastSaveAt = 0;
  private lastBlockSfxAt = 0;
  private paused = false;

  constructor(mount: HTMLElement) {
    this.renderer = new GameRenderer(mount);
    this.gradeMood();
    this.effects = new Effects(this.renderer.scene);
    this.buildGround();
    this.environment = new BuilderEnvironment(this.renderer.scene, this.ground!);

    this.landmarkView = new LandmarkView(this.renderer.scene);
    this.workersView = new WorkersView(this.renderer.scene);
    // the delivered block lands on the frontier — dust marks the impact
    this.flights = new BlockFlights(this.renderer.scene, (pos) => this.effects.jumpDust(pos));
    this.hud = new BuilderHud(document.body, (item) => this.handleBuy(item));

    // ?reset=1 wipes all progress (upgrades, gold, tour) before loading
    if (new URLSearchParams(location.search).has("reset")) {
      clearSave(localStorage);
    }
    const { state, offline } = load(localStorage, Date.now());
    this.state = state;
    if (offline) {
      this.paused = true; // let the player read the modal before time flows
      this.hud.showOfflineModal(offline, () => {
        this.paused = false;
        this.sfx.play("checkpoint");
      });
    }

    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        save(this.state, localStorage, Date.now());
      }
    });

    this.loop = new GameLoop({
      fixedUpdate: () => this.fixedUpdate(),
      render: (alpha, frameDt) => this.render(frameDt),
    });

    if (import.meta.env.DEV) this.installDebugHooks();
  }

  start(): void {
    this.loop.start();
    // builder starts instantly by design — warm the GPU right after instead:
    // upload every texture and compile every shader so the first camera cut
    // that reveals a material doesn't hitch
    void texturesReady().then(() => {
      warmupGpu(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
    });
  }

  /** Golden-hour grading: low warm sun, deep shadows, muted sky — 장엄함. */
  private gradeMood(): void {
    const scene = this.renderer.scene;
    scene.background = new THREE.Color(0x9fb4c9);
    scene.fog = new THREE.Fog(0xaebfd0, 120, 1400);
    this.renderer.camera.far = 2400; // real-scale monuments are HUGE
    this.renderer.camera.near = 1.5; // better depth precision at 300 m+
    this.renderer.camera.updateProjectionMatrix();
    this.renderer.sun.color.set(0xffd9a6);
    this.renderer.sun.intensity = 2.4;
    this.renderer.hemi.color.set(0xd4e0ea);
    this.renderer.hemi.groundColor.set(0x5d6b58);
    // brighter fill than the old "golden hour" grade: the CraftYap crayon
    // textures need readable shadow sides, not moody silhouettes
    this.renderer.hemi.intensity = 0.85;
    // Cool frontal fill catches glass and metal; the warm sun still defines the form.
    const architecturalFill = new THREE.DirectionalLight(0x9fd8ff, 0.72);
    architecturalFill.position.set(-180, 120, -140);
    scene.add(architecturalFill);
  }

  /** Fit the shadow frustum + sun distance to the current monument. */
  private fitLightsTo(landmarkId: string, radiusM: number, heightM: number): void {
    if (this.lightsFittedTo === landmarkId) return;
    this.lightsFittedTo = landmarkId;
    const extent = radiusM + heightM * 0.35 + 25;
    const cam = this.renderer.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.far = (radiusM + heightM) * 4 + 200;
    cam.updateProjectionMatrix();
    // shadow-map texels grow with the frustum — rescale the bias with them
    // or the whole monument shows striping (shadow acne)
    this.renderer.sun.shadow.bias = -0.0002 - extent * 0.000004;
    this.renderer.sun.shadow.normalBias = Math.max(0.3, extent * 0.006);
  }

  private lightsFittedTo: string | null = null;

  private plaza: THREE.Mesh | null = null;

  /** Crayon-doodle tile applied on top of the flat theme color; if the file
   *  is missing the material simply stays flat — never a black plane. */
  private loadDoodleTexture(
    material: THREE.MeshStandardMaterial,
    url: string,
    repeat: number,
  ): void {
    void loadTexture(url, { repeat: true }).then((tex) => {
      if (!tex) return;
      tex.repeat.set(repeat, repeat);
      tex.anisotropy = this.renderer.renderer.capabilities.getMaxAnisotropy();
      material.map = tex;
      material.needsUpdate = true;
    });
  }

  private buildGround(): void {
    // dedicated materials (not the shared brick cache): the environment tints
    // the ground per landmark, and both get a CraftYap doodle texture map
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x31633a, roughness: 0.9 });
    this.loadDoodleTexture(groundMat, "/textures/doodle-grass.png", 90);
    this.ground = new THREE.Mesh(new THREE.BoxGeometry(1200, 1, 1200), groundMat);
    this.ground.position.y = -0.5;
    this.ground.receiveShadow = true;
    this.renderer.scene.add(this.ground);

    // stone plaza under the monument (rescaled per landmark)
    const plazaMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b2, roughness: 0.85 });
    this.loadDoodleTexture(plazaMat, "/textures/doodle-stone.png", 14);
    this.plaza = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 2), plazaMat);
    this.plaza.position.y = 0.15;
    this.plaza.receiveShadow = true;
    this.renderer.scene.add(this.plaza);

    // the brick pile the workers fetch from (repositioned per landmark)
    for (let i = 0; i < 14; i++) {
      const brick = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, 0.45, 0.6),
        brickMaterial(["#e2231a", "#f5802b", "#f9d71c", "#0f6cbd"][i % 4] ?? "#e2231a"),
      );
      brick.position.set(
        (i % 3) * 0.95 - 0.95 + 0.6,
        0.225 + Math.floor(i / 6) * 0.46,
        ((i * 7) % 5) * 0.5 - 1,
      );
      brick.rotation.y = (i * 0.7) % 0.5;
      brick.castShadow = true;
      this.pile.add(brick);
    }
    this.renderer.scene.add(this.pile);
  }

  private handleBuy(item: ShopItem): void {
    if (buy(this.state, item)) {
      this.sfx.play("click");
    }
  }

  private fixedUpdate(): void {
    if (this.paused) return;
    const landmark = currentLandmark(this.state);
    const events = tick(this.state, SIM_DT);
    const now = performance.now();

    // during the completion parade the sim already builds the NEXT blueprint
    // off-screen — suppress its POSITIONAL visuals (they'd land on the wrong
    // monument) but keep the SOUNDS: audio has no position, and muting it
    // made the game fall silent on every camera/landmark transition
    const parading = this.viewLandmarkIndex >= 0 && this.viewLandmarkIndex !== this.state.landmarkIndex;

    for (const e of events) {
      switch (e.type) {
        case "block": {
          this.hud.pulseGold();
          if (now - this.lastBlockSfxAt > BLOCK_SFX_MIN_GAP_MS) {
            this.lastBlockSfxAt = now;
            this.sfx.play("land");
          }
          if (parading) break;
          const index = Math.max(0, this.state.placedBlocks - 1);
          const pos = this.landmarkView.blockPosition(landmark, index);
          // the placing worker TOSSES the carried block to the frontier —
          // the delivery visibly becomes part of the monument
          const from = this.workersView.launchAnchor(e.workerIndex, this.flightFrom);
          if (from) {
            const block = landmark.blocks[index];
            // one delivery = a whole voxel BUNDLE, so the tossed block grows
            // with the monument — it must stay readable when the camera
            // frames a 300 m silhouette
            const bundleSize = Math.min(
              Math.max(landmark.voxelSizeM * 2.2, landmark.heightM * 0.02, 0.8),
              7,
            );
            this.flights.launch(from, pos, block?.color ?? "#f5802b", bundleSize);
          } else {
            // worker beyond the visual cap — no hands to launch from
            this.effects.jumpDust(pos);
          }
          break;
        }
        case "milestone":
          this.sfx.play("checkpoint");
          if (parading) break;
          this.effects.checkpointBurst(
            this.landmarkView.blockPosition(landmark, this.state.placedBlocks - 1),
          );
          break;
        case "landmark": {
          this.sfx.play("clear");
          this.hud.goalToast(`${e.landmark.emoji} ${e.landmark.name} complete!`, e.bonus);
          const top = new THREE.Vector3(0, e.landmark.heightM + 1, 0);
          this.effects.goalConfetti(top);
          this.effects.goalConfetti(top.clone().setY(e.landmark.heightM * 0.5));
          break;
        }
      }
    }

    // several goals may be complete at once right after an offline settle —
    // drain them all this tick but celebrate only once
    let lastCompleted = null;
    let completedCount = 0;
    for (let g = tryCompleteGoal(this.state); g; g = tryCompleteGoal(this.state)) {
      lastCompleted = g;
      completedCount++;
    }
    if (lastCompleted) {
      this.sfx.play("clear");
      this.hud.goalToast(
        completedCount > 1 ? `${completedCount} goals completed in a row!` : lastCompleted.title,
        lastCompleted.reward,
      );
    }

    if (Date.now() - this.lastSaveAt > SAVE_INTERVAL_MS) {
      this.lastSaveAt = Date.now();
      save(this.state, localStorage, Date.now());
    }
  }

  /** The monument the CAMERA is on — lags the sim during the completion
   *  parade so a finished landmark is fully poured and admired before the
   *  next blueprint appears (블록이 다 그려지기 전에 넘어가지 않도록). */
  private viewLandmarkIndex = -1;
  private dwellStartSec: number | null = null;
  private static readonly COMPLETION_DWELL_S = 4.5;

  private render(frameDt: number): void {
    const timeSec = performance.now() / 1000;
    if (this.viewLandmarkIndex < 0) this.viewLandmarkIndex = this.state.landmarkIndex;
    const pourRate = voxelsPerSecond(this.state);

    // completion parade: finish pouring the old monument, admire it on a
    // DEDICATED camera scene, then cut to a fresh scene for the next one
    let landmark = landmarkAt(this.viewLandmarkIndex);
    if (this.viewLandmarkIndex !== this.state.landmarkIndex) {
      if (this.state.landmarkIndex - this.viewLandmarkIndex > 1) {
        // offline settle skipped ahead — no parade, jump straight there
        this.director.pin(null);
        this.flights.clear();
        this.viewLandmarkIndex = this.state.landmarkIndex;
        landmark = landmarkAt(this.viewLandmarkIndex);
        this.landmarkView.update(landmark, this.state.placedBlocks, frameDt, pourRate);
      } else {
        this.director.pin("craneRise"); // rise along the finished monument
        this.landmarkView.update(landmark, landmark.blocks.length, frameDt, pourRate);
        if (this.landmarkView.isFullyPoured(landmark)) {
          this.dwellStartSec ??= timeSec;
          if (timeSec - this.dwellStartSec > BuilderGame.COMPLETION_DWELL_S) {
            this.dwellStartSec = null;
            this.director.pin(null); // the new landmark opens its own scene
            this.flights.clear(); // in-flight blocks belong to the old monument
            this.viewLandmarkIndex = this.state.landmarkIndex;
            landmark = landmarkAt(this.viewLandmarkIndex);
            this.landmarkView.update(landmark, this.state.placedBlocks, frameDt, pourRate);
          }
        }
      }
    } else {
      this.landmarkView.update(landmark, this.state.placedBlocks, frameDt, pourRate);
    }
    this.environment.update(landmark);
    this.pile.position.x = landmark.radiusM + 1.5;
    if (this.plaza) {
      const r = landmark.radiusM + 12;
      this.plaza.scale.set(r, 1, r);
    }
    // workers head for the spot where the next blocks actually land — except
    // during the parade, when the sim's frontier belongs to the unseen next
    // monument
    const workFrontier =
      this.viewLandmarkIndex === this.state.landmarkIndex
        ? this.landmarkView.blockPosition(
            landmark,
            Math.min(this.state.placedBlocks, landmark.blocks.length - 1),
          )
        : null;
    this.workersView.update(this.state, this.paused ? 0 : frameDt, landmark.radiusM, workFrontier);
    this.flights.update(this.paused ? 0 : frameDt);
    this.effects.update(frameDt);
    this.hud.update(this.state, {
      landmarkIndex: this.viewLandmarkIndex,
      parade: this.viewLandmarkIndex !== this.state.landmarkIndex,
    });

    // cinematic camera director: documentary shots that CUT between angles,
    // every pose fit-framed so the WHOLE monument is always on screen
    this.fitLightsTo(landmark.id, landmark.radiusM, landmark.heightM);
    const frontierY =
      (Math.min(this.state.placedBlocks, landmark.blocks.length) / landmark.blocks.length) *
      landmark.heightM;
    this.director.update(frameDt, this.renderer.camera, landmark, frontierY);
    // sun proportional to monument scale so shadows stay long and dramatic
    const target = new THREE.Vector3(0, landmark.heightM * 0.4, 0);
    const s = landmark.radiusM + landmark.heightM;
    this.renderer.sun.position.set(target.x + s * 0.7, target.y + s * 0.95, target.z + s * 0.5);
    this.renderer.sun.target.position.copy(target);

    this.renderer.render();
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__roboBuilder = {
      snapshot: () => ({
        gold: this.state.gold,
        landmarkIndex: this.state.landmarkIndex,
        placedBlocks: this.state.placedBlocks,
        workers: this.state.workers,
        speedLevel: this.state.speedLevel,
        valueLevel: this.state.valueLevel,
        crane: this.state.crane,
        goalIndex: this.state.goalIndex,
        totalBlocks: this.state.totalBlocks,
        paused: this.paused,
      }),
      landmarks: () =>
        LANDMARKS.map((l) => ({
          id: l.id,
          name: l.name,
          blocks: l.blocks.length,
          bonus: l.bonus,
          deliverySize: l.deliverySize,
        })),
      buy: (item: ShopItem) => this.handleBuy(item),
      addGold: (n: number) => {
        this.state.gold += n;
      },
      /** Gallery/testing: jump to landmark `i` with `fraction` built. */
      jumpTo: (i: number, fraction = 1) => {
        this.state.landmarkIndex = i;
        this.viewLandmarkIndex = i;
        this.flights.clear();
        this.dwellStartSec = null;
        const total = currentLandmark(this.state).blocks.length;
        this.state.placedBlocks = Math.max(0, Math.min(total - 1, Math.floor(total * fraction)));
      },
      viewLandmarkIndex: () => this.viewLandmarkIndex,
      flightsActive: () => this.flights.activeCount(),
      pourDone: () => this.landmarkView.isFullyPoured(landmarkAt(this.viewLandmarkIndex)),
      pinShot: (shot: ShotName | null) => this.director.pin(shot),
      currentShot: () => this.director.currentShot,
      saveNow: () => save(this.state, localStorage, Date.now()),
      perf: () => this.perf.sample(),
      /** Wipe all progress (gold/workers/speed/…) back to a fresh game. */
      reset: () => {
        Object.assign(this.state, createInitialState());
        this.viewLandmarkIndex = 0;
        this.dwellStartSec = null;
        this.flights.clear();
        save(this.state, localStorage, Date.now());
      },
    };
  }
}
