import * as THREE from "three";
import {
  SIM_DT,
  createRng,
  dayInfoAt,
  generateLevel,
  timelineSeconds,
  vec3DistXZ,
  type ClientMessage,
  type LevelDef,
} from "@robo/shared";
import { GameLoop } from "./loop.js";
import { SharedTimeline } from "./timeline.js";
import { PhysicsWorld, type RapierModule } from "../physics/physics.js";
import { InterpolationStore } from "../physics/interpolation.js";
import { GameRenderer } from "../render/renderer.js";
import { FollowCamera } from "../render/camera.js";
import { Effects } from "../render/effects.js";
import { InputState } from "../input/inputState.js";
import { KeyboardInput } from "../input/keyboard.js";
import { TouchInput } from "../input/touch.js";
import { LevelRuntime } from "../world/levelRuntime.js";
import { Scenery } from "../world/scenery.js";
import { FoliagePatch, pickFoliageType, type FoliagePlacement } from "../world/foliage.js";
import { LocalPlayer } from "../player/localPlayer.js";
import { NetworkClient, type DailyInfo } from "../net/client.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm } from "../audio/bgm.js";
import { Hud } from "../ui/hud.js";
import { Screens } from "../ui/screens.js";

type GameState = "title" | "play" | "clear";

const RUN_START_DISTANCE = 1.5; // leave the spawn area → the clock starts

/** Transient toast for rare events (connection, new tower, blocked goal). */
function showNotice(text: string): void {
  const el = document.createElement("div");
  el.className = "hud-banner";
  el.style.position = "fixed";
  el.style.top = "60px";
  el.style.left = "50%";
  el.style.transform = "translateX(-50%)";
  el.style.zIndex = "40";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

const EMPTY_FRAME = {
  moveX: 0,
  moveZ: 0,
  jumpHeld: false,
  jumpPressed: false,
  respawnPressed: false,
} as const;

interface WorldBundle {
  level: LevelDef;
  runtime: LevelRuntime;
  scenery: Scenery;
  foliage: FoliagePatch;
  player: LocalPlayer;
}

/**
 * Composition root. Owns the explicit per-tick update order — the anti-jitter
 * contract of the whole game:
 *   input → platforms move on the SHARED timeline → player KCC (with
 *   platform carry) → ONE physics step → triggers/watchdog → interp commit.
 *
 * The world is rebuilt in place when the daily tower changes (s-welcome with
 * a different seed, or the midnight rollover notice).
 */
export class Game {
  private readonly renderer: GameRenderer;
  private readonly physics: PhysicsWorld;
  private readonly interpStore = new InterpolationStore();
  private readonly input = new InputState();
  private readonly followCamera: FollowCamera;
  private readonly effects: Effects;
  private readonly sfx = new Sfx();
  private readonly bgm = new Bgm("/audio/bgm-tower.mp3");
  private readonly hud: Hud;
  private readonly screens: Screens;
  private readonly net: NetworkClient;
  private readonly loop: GameLoop;
  private readonly timeline = new SharedTimeline();
  private readonly headPos = new THREE.Vector3();

  private world: WorldBundle;
  private daily: DailyInfo;

  private state: GameState = "title";
  playerName = "Player";
  runTimeMs = 0;
  private runStartTick: number | null = null;
  private finalTimeMs = 0;
  private correctionCount = 0;
  private pendingNewDay = false;
  private lastGoalBlockedAt = 0;
  private lastFrame: ReturnType<InputState["sample"]> | null = null;

  get player(): LocalPlayer {
    return this.world.player;
  }

  constructor(rapier: RapierModule, mount: HTMLElement) {
    this.renderer = new GameRenderer(mount);
    this.physics = new PhysicsWorld(rapier);
    this.followCamera = new FollowCamera(this.renderer.camera, this.renderer.renderer.domElement);
    this.input.addSource(new KeyboardInput());
    if (TouchInput.isTouchDevice()) {
      this.input.addSource(new TouchInput(document.body));
      document.body.classList.add("touch");
    }

    this.effects = new Effects(this.renderer.scene);
    this.hud = new Hud(document.body);
    this.hud.setVisible(false);
    this.screens = new Screens(document.body, {
      onStart: (name) => {
        this.playerName = name;
        this.sfx.play("click");
        this.startRun();
      },
      onRestart: () => {
        this.sfx.play("click");
        this.startRun();
      },
    });

    this.net = new NetworkClient(this.renderer.scene, {
      onCorrection: (pos) => {
        this.correctionCount++;
        this.world.player.applyCorrection(pos);
      },
      onWelcome: (daily) => this.onWelcome(daily),
      onBoard: (entries) => this.screens.setBoard(entries),
      onNewDay: () => this.onNewDayNotice(),
      onFinishResult: (entry, isLocal) => {
        if (isLocal) {
          this.screens.updateClearResult(entry.timeMs, this.world.player.falls, entry.rank);
        } else {
          showNotice(`🏁 ${entry.name} finished at #${entry.rank} today!`);
        }
      },
      onRemoteCheckpoint: (playerId, index) => {
        const name = this.net.nameOf(playerId);
        if (name) showNotice(`🚩 ${name} reached checkpoint ${index + 1}`);
      },
      onKicked: (msg) => {
        console.warn("kicked by server:", msg);
        showNotice(`Disconnected from the server (${msg}) — playing on solo.`);
      },
    });

    // provisional tower from the local clock; the server's welcome corrects it
    const localDay = dayInfoAt(Date.now());
    this.daily = {
      seed: localDay.seed,
      dateStr: localDay.dateStr,
      dayNumber: localDay.dayNumber,
      dayStartMs: localDay.dayStartMs,
      nextDayStartMs: localDay.nextDayStartMs,
    };
    this.world = this.buildWorld(this.daily.seed);
    this.screens.setDay(this.daily.dayNumber);
    this.screens.setBoard([]);
    this.screens.showTitle();

    this.loop = new GameLoop({
      fixedUpdate: (tick) => this.fixedUpdate(tick),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });

    if (import.meta.env.DEV) this.installDebugHooks();
  }

  start(): void {
    this.loop.start();
  }

  // ---------------------------------------------------------------- world

  private buildWorld(seed: number): WorldBundle {
    const level = generateLevel(seed);
    const runtime = new LevelRuntime(level, this.renderer.scene, this.physics, this.interpStore);
    const scenery = new Scenery(this.renderer.scene, level.summitHeight);
    const foliage = new FoliagePatch(this.renderer.scene, this.foliagePlacements(level));
    const player = new LocalPlayer(
      this.physics,
      this.renderer.scene,
      this.interpStore,
      runtime,
      {
        onJump: () => {
          this.sfx.play("jump");
          this.effects.jumpDust(this.world.player.rig.root.position);
        },
        onLand: () => {
          this.sfx.play("land");
          this.effects.landPoof(this.world.player.rig.root.position);
        },
        onDeath: () => {
          this.sfx.play("oof");
          this.effects.deathBurst(
            this.world.player.rig.root.position.clone().add(new THREE.Vector3(0, 0.9, 0)),
          );
        },
        onCheckpoint: (i) => {
          this.sfx.play("checkpoint");
          const cp = level.checkpoints[i];
          if (cp) this.effects.checkpointBurst(new THREE.Vector3(...cp.center));
          this.net.sendCheckpoint(i);
        },
        onGoal: () => this.onGoal(),
        onGoalBlocked: () => {
          const now = performance.now();
          if (now - this.lastGoalBlockedAt > 3000) {
            this.lastGoalBlockedAt = now;
            showNotice("🚩 Pass every checkpoint before finishing!");
          }
        },
        onRespawn: () => this.net.sendRespawn("death"),
      },
    );

    for (const c of runtime.crumbling) {
      c.onShake = () => this.sfx.play("crumble");
      // stone grey to match the cracked-brick look of crumbling platforms
      c.onCollapse = (center) => this.effects.crumbleDebris(center, 0xa7adb3);
    }

    return { level, runtime, scenery, foliage, player };
  }

  /** Doodle plants scattered on the baseplate — deterministic per seed so
   *  every player sees the same meadow; kept clear of the spawn point. */
  private foliagePlacements(level: LevelDef): FoliagePlacement[] {
    const ground = level.platforms.find((p) => p.kind === "solid" && p.role === "ground");
    if (!ground) return [];
    const rng = createRng(level.seed + 9137);
    const top = ground.center[1] + ground.size[1] / 2;
    const placements: FoliagePlacement[] = [];
    const count = Math.floor(ground.size[0] * ground.size[2] * 0.11);
    for (let i = 0; i < count; i++) {
      const x = ground.center[0] + rng.range(-0.5, 0.5) * (ground.size[0] - 1.2);
      const z = ground.center[2] + rng.range(-0.5, 0.5) * (ground.size[2] - 1.2);
      const dx = x - level.spawn[0];
      const dz = z - level.spawn[2];
      if (dx * dx + dz * dz < 2.5 * 2.5) continue; // keep the spawn clear
      placements.push({
        x,
        y: top,
        z,
        yaw: rng.range(0, Math.PI * 2),
        scale: rng.range(0.8, 1.3),
        type: pickFoliageType(rng.next()),
      });
    }
    return placements;
  }

  private rebuildWorld(seed: number): void {
    const old = this.world;
    old.player.dispose(this.renderer.scene, this.interpStore);
    old.runtime.dispose();
    old.scenery.dispose();
    old.foliage.dispose();
    this.timeline.reset();
    this.world = this.buildWorld(seed);
  }

  // ---------------------------------------------------------------- daily

  private onWelcome(daily: DailyInfo): void {
    const seedChanged = daily.seed !== this.daily.seed;
    this.daily = daily;
    this.pendingNewDay = false;
    this.screens.setDay(daily.dayNumber);
    if (seedChanged) {
      this.rebuildWorld(daily.seed);
      showNotice(`🗼 Moved to Daily Tower #${daily.dayNumber}!`);
      if (this.state !== "title") this.startRun();
    }
  }

  private onNewDayNotice(): void {
    this.pendingNewDay = true;
    if (this.state === "title") {
      this.net.reconnect(); // fresh welcome → rebuild to the new tower now
    } else {
      showNotice("🗼 A new tower has opened! Your next run starts on it.");
    }
  }

  /** Offline fallback: roll the tower over from the local clock. */
  private maybeLocalRollover(): void {
    if (this.net.state === "online") return;
    if (Date.now() < this.daily.nextDayStartMs) return;
    const d = dayInfoAt(Date.now());
    this.daily = {
      seed: d.seed,
      dateStr: d.dateStr,
      dayNumber: d.dayNumber,
      dayStartMs: d.dayStartMs,
      nextDayStartMs: d.nextDayStartMs,
    };
    this.screens.setDay(d.dayNumber);
    this.rebuildWorld(d.seed);
    if (this.state !== "title") this.startRun();
    showNotice(`🗼 Daily Tower #${d.dayNumber} is open!`);
  }

  // ---------------------------------------------------------------- run

  private startRun(): void {
    if (this.pendingNewDay && this.net.state === "online") {
      // our room is on yesterday's tower — rejoin gets today's via welcome
      this.net.reconnect();
    }
    this.input.sample(); // drain edge flags latched on menu screens
    this.world.player.resetRun();
    this.runTimeMs = 0;
    this.runStartTick = null;
    this.finalTimeMs = 0;
    this.state = "play";
    this.screens.hideAll();
    this.hud.setVisible(true);
    this.net.connect(this.playerName);
    this.net.sendRespawn("restart");
  }

  private onGoal(): void {
    this.finalTimeMs = this.runTimeMs;
    this.sfx.play("clear");
    this.effects.goalConfetti(new THREE.Vector3(...this.world.level.goal.center));
    this.net.sendFinish(this.finalTimeMs);
    this.state = "clear";
    this.screens.setBoard(this.net.board);
    this.screens.showClear(this.finalTimeMs, this.world.player.falls, null);
  }

  // ---------------------------------------------------------------- loop

  private fixedUpdate(tick: number): void {
    this.interpStore.beginTick();
    const frame = this.state === "play" ? this.input.sample() : { ...EMPTY_FRAME };
    this.lastFrame = frame;
    const player = this.world.player;

    // precise run clock: starts the tick the player leaves the spawn area
    if (this.state === "play" && this.runStartTick === null && player.status === "alive") {
      if (vec3DistXZ(player.controller.feetPosition(), this.world.level.spawn) > RUN_START_DISTANCE) {
        this.runStartTick = tick;
      }
    }
    if (this.runStartTick !== null && player.status !== "finished") {
      this.runTimeMs = (tick - this.runStartTick) * SIM_DT * 1000;
    }

    // moving platforms live on the shared server-time axis
    const serverNow = this.net.serverNowMs() ?? Date.now();
    const t = this.timeline.sample(timelineSeconds(serverNow, this.daily.dayStartMs));
    this.world.runtime.fixedUpdate(t);

    player.fixedUpdate(frame, this.followCamera.yaw, tick);
    this.physics.step();
    player.postStep();

    this.net.sendMoveIfDue(tick, {
      pos: player.controller.feetPosition(),
      vel: [
        player.controller.velocity.x,
        player.controller.velocity.y,
        player.controller.velocity.z,
      ],
      yaw: player.yaw,
      anim: player.anim,
      grounded: player.controller.grounded,
    });
  }

  private render(alpha: number, frameDt: number): void {
    const timeSec = performance.now() / 1000;
    const player = this.world.player;
    this.world.runtime.frameUpdate(alpha, timeSec);
    player.frameUpdate(alpha, frameDt);
    this.effects.update(frameDt);
    this.world.scenery.update(frameDt);
    this.net.update(frameDt);
    this.maybeLocalRollover();

    if (this.state !== "play") {
      const serverNow = this.net.serverNowMs() ?? Date.now();
      this.screens.updateCountdown(this.daily.nextDayStartMs - serverNow);
    }

    if (this.state === "title") {
      // slow cinematic orbit around the tower
      const midY = this.world.level.summitHeight * 0.45;
      const angle = timeSec * 0.12;
      this.renderer.camera.position.set(Math.cos(angle) * 34, midY + 12, Math.sin(angle) * 34);
      this.renderer.camera.lookAt(0, midY, 0);
      this.renderer.trackTarget(new THREE.Vector3(0, midY, 0));
    } else {
      player.headPosition(alpha, this.headPos);
      this.followCamera.update(this.headPos, this.physics, player.controller.collider);
      this.renderer.trackTarget(this.headPos);
    }

    if (this.state !== "title") {
      const level = this.world.level;
      this.hud.update({
        heightPercent: (player.controller.feetPosition()[1] / level.summitHeight) * 100,
        runTimeMs: this.state === "clear" ? this.finalTimeMs : this.runTimeMs,
        stage: Math.min(player.checkpoint + 2, level.totalStages),
        totalStages: level.totalStages,
        falls: player.falls,
        playerCount: this.net.playerCount,
        connection: this.net.state === "online" ? "online" : this.net.state,
      });
    }

    this.renderer.render();
  }

  // ---------------------------------------------------------------- debug

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__robo = {
      game: this,
      snapshot: () => ({
        feet: this.world.player.controller.feetPosition(),
        vel: this.world.player.controller.velocity.toArray(),
        standingOn: this.world.player.controller.standingOnPlatformId(),
        lastFrame: this.lastFrame,
        camYaw: this.followCamera.yaw,
        grounded: this.world.player.controller.grounded,
        status: this.world.player.status,
        anim: this.world.player.anim,
        checkpoint: this.world.player.checkpoint,
        falls: this.world.player.falls,
        runTimeMs: Math.round(this.runTimeMs),
        tick: this.loop.currentTick,
        state: this.state,
      }),
      level: () =>
        this.world.level.platforms.map((p) => ({
          id: p.id,
          kind: p.kind,
          center: p.center,
          size: p.size,
          role: p.kind === "solid" ? p.role : undefined,
          hazard: p.kind === "solid" ? p.hazard : undefined,
        })),
      checkpoints: () => this.world.level.checkpoints,
      goal: () => this.world.level.goal,
      levelMeta: () => ({
        seed: this.world.level.seed,
        summitHeight: this.world.level.summitHeight,
        totalStages: this.world.level.totalStages,
        minFinishSeconds: this.world.level.minFinishSeconds,
      }),
      daily: () => this.daily,
      timelineTarget: () => {
        const serverNow = this.net.serverNowMs() ?? Date.now();
        return timelineSeconds(serverNow, this.daily.dayStartMs);
      },
      platformPos: (id: number) => {
        const e = this.world.runtime.byId.get(id);
        return e ? e.mesh.position.toArray() : null;
      },
      teleport: (x: number, y: number, z: number) => {
        this.world.player.controller.teleportToFeet([x, y, z]);
      },
      startRun: (name?: string) => {
        if (name) this.playerName = name;
        this.startRun();
      },
      sendRespawn: (reason: "death" | "restart") => this.net.sendRespawn(reason),
      offline: () => this.net.disconnect(),
      net: () => ({
        state: this.net.state,
        playerCount: this.net.playerCount,
        remotes: this.net.debugRemotes(),
        board: this.net.board,
        corrections: this.correctionCount,
      }),
      debugSend: (msg: ClientMessage) => this.net.debugSend(msg),
      trace: () => this.world.player.controller.trace,
    };
  }
}
