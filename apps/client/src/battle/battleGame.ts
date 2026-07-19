import * as THREE from "three";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu } from "../render/textures.js";
import { CharacterRig, VARIANT_CYCLE } from "../player/rig.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { PerfMonitor } from "../ui/perf.js";
import { Effects } from "../render/effects.js";
import { generateIsland, surfaceY, WORLD_X, WORLD_Z } from "../craft/voxelWorld.js";
import { stepBody, unstick, wishFromInput, type Body } from "../craft/voxelBody.js";
import { VoxelView } from "../craft/voxelView.js";
import { CraftCamera } from "../craft/craftCamera.js";
import { EYE_HEIGHT, FIRE_COOLDOWN, MAX_HP, resolveShot, type Fighter } from "./combat.js";
import { BOT_COUNT, botFighter, makeBot, stepBot, type Bot } from "./bots.js";
import { insideZone, zoneNextEventIn, zoneRadiusAt, zoneTicksBetween } from "./zone.js";
import { BattleHud } from "./battleHud.js";
import { ViewModel } from "./viewModel.js";

const ZONE_CX = WORLD_X / 2;
const ZONE_CZ = WORLD_Z / 2;
/** Weapons-free warm-up right after the drop — spawns sit within hunt range
 *  of each other, so without this half the lobby dies in the first seconds. */
const GRACE_SECONDS = 4;
const TRACER_LIFE = 0.09;
const TRACER_POOL = 14;

type Phase = "live" | "won" | "lost";

/**
 * Blast Royale — arcade solo battle royale on a voxel island: you vs 7 bot
 * robots (who also fight each other), hitscan blasters, a 3-phase shrinking
 * storm, last robot standing. Client-only; reuses the craft mode's voxel
 * world, physics and camera.
 */
export class BattleGame {
  private readonly renderer: GameRenderer;
  private readonly view: VoxelView;
  private readonly hud: BattleHud;
  private readonly sfx = new Sfx();
  private readonly bgm = new Bgm(BGM_PLAYLIST, 0.3);
  private readonly perf = new PerfMonitor(document.body);
  private readonly effects: Effects;
  private readonly camera: CraftCamera;
  private readonly viewModel: ViewModel;
  private readonly loop: GameLoop;

  private readonly world = generateIsland(1 + Math.floor(Math.random() * 1_000_000));
  private readonly playerRig = new CharacterRig();
  private readonly botRigs: CharacterRig[] = [];
  private readonly bots: Bot[] = [];
  private readonly player: Body;
  private playerHp = MAX_HP;

  private phase: Phase = "live";
  private elapsed = 0;
  private yaw = 0;
  private pitch = -0.15;
  private readonly keys = new Set<string>();
  private firing = false;
  private fireCooldown = 0;
  private locked = false;
  private robotMaterials: THREE.Material[] | null = null;
  private robotOpacity = 1;
  private fightAnnounced = false;
  private rng = Math.random;

  private readonly zoneMesh: THREE.Mesh;
  private readonly tracers: { mesh: THREE.Mesh; life: number }[] = [];

  constructor(mount: HTMLElement) {
    this.renderer = new GameRenderer(mount);
    this.camera = new CraftCamera(this.renderer.camera);
    this.camera.firstPerson = true; // FPS by default (V toggles to 3rd person)
    this.viewModel = new ViewModel(this.renderer.scene, this.renderer.camera);
    this.view = new VoxelView(this.renderer.scene);
    this.view.markDirty();
    this.effects = new Effects(this.renderer.scene);
    this.hud = new BattleHud(document.body);

    // everyone drops on a ring around the island edge; slot 0 is the player
    const spawns: [number, number][] = [];
    for (let i = 0; i < BOT_COUNT + 1; i++) {
      const a = (i / (BOT_COUNT + 1)) * Math.PI * 2;
      // drop on a wide ring around the castle so fights close in on it
      const r = WORLD_X * 0.33;
      spawns.push([ZONE_CX + Math.cos(a) * r, ZONE_CZ + Math.sin(a) * r]);
    }
    const [px, pz] = spawns[0]!;
    this.player = {
      x: px, y: surfaceY(this.world, Math.floor(px), Math.floor(pz)) + 1.2, z: pz,
      vx: 0, vy: 0, vz: 0, grounded: false,
    };
    unstick(this.world, this.player); // never spawn embedded (tree/castle edge)
    // face the island center, but if a hill is right there, face the open
    // side instead — nobody should spawn staring into a wall
    this.yaw = this.bestFacing(px, this.player.y, pz, Math.atan2(ZONE_CX - px, ZONE_CZ - pz));
    this.pitch = -0.05;
    this.renderer.scene.add(this.playerRig.root);
    for (let i = 0; i < BOT_COUNT; i++) {
      const [bx, bz] = spawns[i + 1]!;
      const bot = makeBot(i + 1, bx, surfaceY(this.world, Math.floor(bx), Math.floor(bz)) + 1.2, bz);
      unstick(this.world, bot.body);
      this.bots.push(bot);
      const rig = new CharacterRig(VARIANT_CYCLE[(i + 1) % VARIANT_CYCLE.length]);
      this.botRigs.push(rig);
      this.renderer.scene.add(rig.root);
    }

    // the storm wall
    this.zoneMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 44, 48, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x8a4fd7,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.zoneMesh.position.set(ZONE_CX, 20, ZONE_CZ);
    this.renderer.scene.add(this.zoneMesh);

    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.05, 1),
        new THREE.MeshBasicMaterial({ color: 0xffe36b, transparent: true }),
      );
      mesh.visible = false;
      this.renderer.scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }

    this.bindInput(mount);
    this.loop = new GameLoop({
      fixedUpdate: () => this.fixedUpdate(),
      render: (_alpha, frameDt) => this.render(frameDt),
    });
    if (import.meta.env.DEV) this.installDebugHooks();
  }

  /** Pick whichever of `yaw` / `yaw+π` has more open air ahead at eye level. */
  private bestFacing(x: number, feetY: number, z: number, yaw: number): number {
    const oy = feetY + EYE_HEIGHT;
    const clear = (a: number): number => {
      const hit = this.world.raycast(x, oy, z, Math.sin(a), 0, Math.cos(a), 6);
      return hit ? hit.dist : 6;
    };
    return clear(yaw) >= clear(yaw + Math.PI) ? yaw : yaw + Math.PI;
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
      if (!this.locked && this.phase === "live") {
        void mount.querySelector("canvas")?.requestPointerLock();
      }
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement !== null;
      this.hud.setPointerLocked(this.locked || this.phase !== "live");
      if (!this.locked) this.firing = false;
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0026;
      this.pitch = Math.min(1.35, Math.max(-1.25, this.pitch - e.movementY * 0.0026));
    });
    document.addEventListener("mousedown", (e) => {
      if (this.locked && e.button === 0) this.firing = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false;
    });
    document.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.key.toLowerCase() === "v") this.camera.toggleView();
    });
    document.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  // ---------------------------------------------------------------- sim

  private fighters(): Fighter[] {
    return [
      { x: this.player.x, y: this.player.y, z: this.player.z, hp: this.playerHp },
      ...this.bots.map(botFighter),
    ];
  }

  private fixedUpdate(): void {
    const dt = 1 / 60;
    if (this.phase === "live") this.elapsed += dt;
    const radius = zoneRadiusAt(this.elapsed);
    const prevElapsed = this.elapsed - dt;

    // player movement + fire
    let fwd = 0;
    let strafe = 0;
    if (this.locked && this.playerHp > 0) {
      if (this.keys.has("KeyW")) fwd += 1;
      if (this.keys.has("KeyS")) fwd -= 1;
      if (this.keys.has("KeyA")) strafe -= 1;
      if (this.keys.has("KeyD")) strafe += 1;
    }
    const [wishX, wishZ] = wishFromInput(this.yaw, fwd, strafe);
    stepBody(this.world, this.player, dt, wishX, wishZ, this.locked && this.keys.has("Space"));
    if (this.player.y < -12) {
      // fell off the island — the storm doesn't forgive that either
      this.hurtPlayer(this.playerHp, "The void");
    }

    const weaponsFree = this.elapsed >= GRACE_SECONDS;
    if (weaponsFree && !this.fightAnnounced) {
      this.fightAnnounced = true;
      this.hud.addFeed("⚔️ FIGHT!");
      this.sfx.play("checkpoint");
      // stagger the opening shots — without this every bot in range unloads
      // on the same frame the grace ends
      for (const bot of this.bots) bot.cooldown = 0.6 + this.rng() * 1.8;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    if (
      this.firing && weaponsFree && this.playerHp > 0 &&
      this.phase === "live" && this.fireCooldown <= 0
    ) {
      this.fireCooldown = FIRE_COOLDOWN;
      this.playerShoot();
    }

    // bots
    const fighters = this.fighters();
    const zone = { cx: ZONE_CX, cz: ZONE_CZ, radius };
    for (const bot of this.bots) {
      const shot = stepBot(this.world, bot, fighters, zone, dt, this.rng);
      if (shot && weaponsFree && this.phase === "live") {
        this.botShoot(bot, shot.dx, shot.dy, shot.dz);
      }
      // a bot that walked off the island edge dies too — otherwise a fallen
      // bot never takes storm damage and "last robot standing" never resolves
      if (bot.hp > 0 && bot.body.y < -12) {
        bot.hp = 0;
        this.onBotDown(bot, "The void");
      }
    }

    // storm damage (player + bots share the same rule)
    const ticks = zoneTicksBetween(prevElapsed, this.elapsed);
    if (ticks > 0 && this.phase === "live") {
      if (this.playerHp > 0 && !insideZone(this.player.x, this.player.z, ZONE_CX, ZONE_CZ, radius)) {
        this.hurtPlayer(ticks, "The storm");
      }
      for (const bot of this.bots) {
        if (bot.hp > 0 && !insideZone(bot.body.x, bot.body.z, ZONE_CX, ZONE_CZ, radius)) {
          bot.hp -= ticks;
          if (bot.hp <= 0) this.onBotDown(bot, "The storm");
        }
      }
    }

    // match end
    const botsAlive = this.bots.filter((b) => b.hp > 0).length;
    if (this.phase === "live") {
      if (this.playerHp <= 0) this.endMatch(false, botsAlive);
      else if (botsAlive === 0) this.endMatch(true, 0);
    }
  }

  private eyeDir(): [number, number, number] {
    return [
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
  }

  private playerShoot(): void {
    const [dx, dy, dz] = this.eyeDir();
    const ox = this.player.x;
    const oy = this.player.y + EYE_HEIGHT;
    const oz = this.player.z;
    const hit = resolveShot(this.world, ox, oy, oz, dx, dy, dz, this.fighters(), 0);
    this.spawnTracer(ox, oy - 0.18, oz, dx, dy, dz, hit.dist);
    this.viewModel.fire();
    this.sfx.play("click");
    this.camera.addShake(0.015);
    if (hit.kind === "fighter") {
      const bot = this.bots[hit.index - 1]!;
      bot.hp -= 1;
      const down = bot.hp <= 0;
      this.hud.hitMarker(down);
      this.sfx.play(down ? "checkpoint" : "land");
      if (down) this.onBotDown(bot, "You");
    }
  }

  private botShoot(bot: Bot, dx: number, dy: number, dz: number): void {
    const ox = bot.body.x;
    const oy = bot.body.y + EYE_HEIGHT;
    const oz = bot.body.z;
    const hit = resolveShot(this.world, ox, oy, oz, dx, dy, dz, this.fighters(), bot.index);
    this.spawnTracer(ox, oy - 0.18, oz, dx, dy, dz, hit.dist);
    if (hit.kind !== "fighter") return;
    if (hit.index === 0) {
      this.hurtPlayer(1, `Bot ${bot.index}`);
    } else {
      const other = this.bots[hit.index - 1]!;
      other.hp -= 1;
      if (other.hp <= 0) this.onBotDown(other, `Bot ${bot.index}`);
    }
  }

  private readonly hurtLog: string[] = [];

  private hurtPlayer(amount: number, from: string): void {
    if (this.playerHp <= 0) return;
    this.hurtLog.push(`${from} -${amount} @${this.elapsed.toFixed(2)}s`);
    this.playerHp = Math.max(0, this.playerHp - amount);
    this.hud.damageFlash();
    this.camera.addShake(0.06);
    this.sfx.play("oof");
    if (this.playerHp <= 0) this.hud.addFeed(`${from} ⚡ You`);
  }

  private onBotDown(bot: Bot, by: string): void {
    this.hud.addFeed(`${by} ⚡ Bot ${bot.index}`);
    const rig = this.botRigs[bot.index - 1]!;
    rig.root.visible = false;
    this.effects.deathBurst(
      new THREE.Vector3(bot.body.x, bot.body.y + 1, bot.body.z),
    );
  }

  private endMatch(won: boolean, botsAlive: number): void {
    this.phase = won ? "won" : "lost";
    this.sfx.play(won ? "clear" : "crumble");
    this.hud.showEnd(won, botsAlive);
  }

  // ---------------------------------------------------------------- render

  private spawnTracer(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    dist: number,
  ): void {
    const tracer = this.tracers.find((t) => t.life <= 0);
    if (!tracer) return;
    tracer.life = TRACER_LIFE;
    const mesh = tracer.mesh;
    mesh.visible = true;
    mesh.scale.set(1, 1, Math.max(0.5, dist));
    mesh.position.set(ox + (dx * dist) / 2, oy + (dy * dist) / 2, oz + (dz * dist) / 2);
    mesh.lookAt(ox + dx * dist, oy + dy * dist, oz + dz * dist);
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
  }

  private render(frameDt: number): void {
    this.view.update(this.world);

    // rigs
    this.playerRig.root.position.set(this.player.x, this.player.y, this.player.z);
    this.playerRig.root.rotation.y = this.yaw;
    const planar = Math.hypot(this.player.vx, this.player.vz);
    this.playerRig.update(
      this.playerHp <= 0 ? "dead" : !this.player.grounded ? "jump" : planar > 0.5 ? "run" : "idle",
      planar,
      frameDt,
    );
    for (const bot of this.bots) {
      const rig = this.botRigs[bot.index - 1]!;
      if (bot.hp <= 0) continue;
      rig.root.position.set(bot.body.x, bot.body.y, bot.body.z);
      const speed = Math.hypot(bot.body.vx, bot.body.vz);
      if (speed > 0.3) rig.root.rotation.y = Math.atan2(bot.body.vx, bot.body.vz);
      rig.update(!bot.body.grounded ? "jump" : speed > 0.5 ? "run" : "idle", speed, frameDt);
    }

    // storm wall
    const radius = zoneRadiusAt(this.elapsed);
    this.zoneMesh.scale.set(radius, 1, radius);

    // tracers
    for (const tracer of this.tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= frameDt;
      (tracer.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, tracer.life / TRACER_LIFE);
      if (tracer.life <= 0) tracer.mesh.visible = false;
    }
    this.effects.update(frameDt);

    const eye = this.tmpEye.set(this.player.x, this.smoothedEyeY(frameDt), this.player.z);
    const robotOpacity = this.camera.update(this.world, eye, this.yaw, this.pitch, planar > 0.5, frameDt);
    this.applyRobotOpacity(robotOpacity, frameDt);
    // the blaster only shows in first person, and only while you're alive
    this.viewModel.setVisible(this.camera.firstPerson && this.playerHp > 0 && this.phase === "live");
    this.viewModel.update(frameDt, planar > 0.5);
    this.renderer.trackTarget(eye);

    const next = zoneNextEventIn(this.elapsed);
    const zoneLabel = next
      ? next.label === "shrinking"
        ? `🌀 shrinking ${Math.ceil(next.seconds)}s`
        : `🌀 closes in ${Math.ceil(next.seconds)}s`
      : "🌀 closed";
    const outside = !insideZone(this.player.x, this.player.z, ZONE_CX, ZONE_CZ, radius);
    this.hud.update(this.playerHp, this.bots.filter((b) => b.hp > 0).length, zoneLabel, outside);

    this.renderer.render();
    this.perf.update(this.renderer.renderer, frameDt);
  }

  private applyRobotOpacity(target: number, dt: number): void {
    if (!this.robotMaterials) {
      const collected: THREE.Material[] = [];
      this.playerRig.root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const cloned = (o.material as THREE.Material).clone();
          cloned.transparent = true;
          o.material = cloned;
          collected.push(cloned);
        }
      });
      if (collected.length === 0) return;
      this.robotMaterials = collected;
    }
    this.robotOpacity += (target - this.robotOpacity) * (1 - Math.pow(0.001, dt));
    const opacity = Math.min(1, Math.max(0, this.robotOpacity));
    this.playerRig.root.visible = opacity > 0.03 && this.playerHp > 0;
    for (const material of this.robotMaterials) material.opacity = opacity;
  }

  private readonly tmpEye = new THREE.Vector3();

  /** Ease eye height for smooth landings/steps; snap on big jumps (respawns). */
  private smoothEyeY = Number.NaN;
  private smoothedEyeY(dt: number): number {
    const target = this.player.y + EYE_HEIGHT;
    if (!Number.isFinite(this.smoothEyeY) || Math.abs(target - this.smoothEyeY) > 1.6) {
      this.smoothEyeY = target;
    } else {
      this.smoothEyeY += (target - this.smoothEyeY) * (1 - Math.pow(1e-9, dt));
    }
    return this.smoothEyeY;
  }

  // ---------------------------------------------------------------- debug

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__roboBattle = {
      snapshot: () => ({
        phase: this.phase,
        hp: this.playerHp,
        botsAlive: this.bots.filter((b) => b.hp > 0).length,
        elapsed: +this.elapsed.toFixed(2),
        zoneRadius: +zoneRadiusAt(this.elapsed).toFixed(2),
        pos: [this.player.x, this.player.y, this.player.z],
        bots: this.bots.map((b) => ({ i: b.index, hp: b.hp, x: +b.body.x.toFixed(1), z: +b.body.z.toFixed(1) })),
        hurtLog: [...this.hurtLog],
      }),
      killBot: (i: number) => {
        const bot = this.bots[i - 1];
        if (!bot || bot.hp <= 0) return false;
        bot.hp = 0;
        this.onBotDown(bot, "Debug");
        return true;
      },
      damagePlayer: (n: number) => this.hurtPlayer(n, "Debug"),
      skipTime: (sec: number) => {
        this.elapsed += sec;
      },
      teleport: (x: number, y: number, z: number) => {
        this.player.x = x;
        this.player.y = y;
        this.player.z = z;
        this.player.vy = 0;
      },
      perf: () => this.perf.sample(),
    };
  }
}
