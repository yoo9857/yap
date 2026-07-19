import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { VignetteShader } from "three/examples/jsm/shaders/VignetteShader.js";
import { GameLoop } from "../app/loop.js";
import { GameRenderer } from "../render/renderer.js";
import { texturesReady, warmupGpu } from "../render/textures.js";
import { CharacterRig, VARIANT_CYCLE } from "../player/rig.js";
import { VoxelView } from "../craft/voxelView.js";
import { Atmosphere } from "../world/atmosphere.js";
import { FoliagePatch, pickFoliageType, type FoliagePlacement } from "../world/foliage.js";
import { PerfMonitor } from "../ui/perf.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";
import { generateForest, groundY, PATH_WAYPOINTS } from "./forestWorld.js";

const DEFAULT_SEED = 71725;
const CAST = 4; // robots trekking the trail
const WALK_SPEED = 2.4; // m/s along the trail

const UP = new THREE.Vector3(0, 1, 0);
const ease = (t: number): number => t * t * (3 - 2 * t); // smoothstep

/** The camera basis + subjects a shot is framed against, refreshed each frame. */
interface ShotCtx {
  lead: THREE.Vector3;
  centroid: THREE.Vector3;
  fwd: THREE.Vector3; // trail direction at the lead (unit, planar)
  right: THREE.Vector3; // fwd × up (unit, planar)
}

interface Shot {
  name: string;
  dur: number;
  /** t ∈ [0,1] over the shot → write camera pose into `out`. */
  fn: (t: number, c: ShotCtx, out: { pos: THREE.Vector3; look: THREE.Vector3; fov: number }) => void;
}

/**
 * A hand-cut sequence of moving shots. Each frames the moving cast against the
 * forest; the deck hard-cuts between shots (a cut reads more cinematic than one
 * endless move). Poses are built in the cast's own forward/right basis so every
 * shot tracks the group as it winds through the trees.
 */
const SHOTS: Shot[] = [
  {
    name: "lowTrack",
    dur: 6,
    fn: (t, c, o) => {
      o.pos
        .copy(c.centroid)
        .addScaledVector(c.right, 6.5 - 1.2 * t)
        .addScaledVector(UP, 2.1)
        .addScaledVector(c.fwd, -0.8);
      o.look.copy(c.centroid).addScaledVector(UP, 1.2);
      o.fov = 42;
    },
  },
  {
    name: "craneRise",
    dur: 6,
    fn: (t, c, o) => {
      const e = ease(t);
      o.pos
        .copy(c.centroid)
        .addScaledVector(c.fwd, -6)
        .addScaledVector(UP, 2 + e * 21)
        .addScaledVector(c.right, 3 * e);
      o.look.copy(c.centroid).addScaledVector(UP, 1);
      o.fov = 50;
    },
  },
  {
    name: "pushIn",
    dur: 6.5,
    fn: (t, c, o) => {
      o.pos
        .copy(c.lead)
        .addScaledVector(c.fwd, -(15 - 8.5 * ease(t)))
        .addScaledVector(UP, 3.4 - 1.1 * t);
      o.look.copy(c.lead).addScaledVector(UP, 1.15);
      o.fov = 46;
    },
  },
  {
    name: "orbit",
    dur: 7,
    fn: (t, c, o) => {
      const ang = t * Math.PI * 1.1;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ox = c.right.x * ca + c.fwd.x * sa;
      const oz = c.right.z * ca + c.fwd.z * sa;
      o.pos.set(c.centroid.x + ox * 8, c.centroid.y + 2.6, c.centroid.z + oz * 8);
      o.look.copy(c.centroid).addScaledVector(UP, 0.9);
      o.fov = 44;
    },
  },
  {
    name: "heroLow",
    dur: 5.5,
    fn: (t, c, o) => {
      o.pos
        .copy(c.lead)
        .addScaledVector(c.fwd, 4 - 1.5 * t)
        .addScaledVector(UP, 0.7)
        .addScaledVector(c.right, 0.9);
      o.look.copy(c.lead).addScaledVector(UP, 1.15);
      o.fov = 40;
    },
  },
  {
    name: "wideReveal",
    dur: 6.5,
    fn: (t, c, o) => {
      const e = ease(t);
      o.pos
        .copy(c.centroid)
        .addScaledVector(c.fwd, -10)
        .addScaledVector(UP, 18 + e * 10)
        .addScaledVector(c.right, 6);
      o.look.copy(c.centroid).addScaledVector(UP, 1);
      o.fov = 55;
    },
  },
];

const CYCLE = SHOTS.reduce((s, sh) => s + sh.dur, 0);

/**
 * Cinematic mode — a movie-grade attract reel. The robot cast treks a trail
 * through a LEGO forest while a scripted camera cuts between tracking, crane,
 * push-in and orbit shots; a film stack (bloom + vignette + ACES) and a 2.39:1
 * letterbox sell the trailer look. No input, no physics — pure spectacle, and
 * the source for Steam screenshots/capsules (drive via `__roboCine`).
 */
export class CinematicGame {
  private readonly renderer: GameRenderer;
  private readonly view: VoxelView;
  private readonly atmosphere: Atmosphere;
  private readonly perf = new PerfMonitor(document.body);
  private readonly bgm = new Bgm(BGM_PLAYLIST);
  private readonly loop: GameLoop;
  private readonly world = generateForest(DEFAULT_SEED);
  private readonly rigs: CharacterRig[] = [];
  private readonly offsets: number[] = [];
  private readonly lateral: number[] = [];
  private readonly curve: THREE.CatmullRomCurve3;
  private readonly curveLen: number;

  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;
  private motes!: THREE.Points;
  private moteBase!: Float32Array;
  private fadeEl!: HTMLDivElement;

  private time = 0;
  private paused = false;
  private pinnedShot = -1;
  private curShot = "lowTrack";

  // scratch — never allocate per frame
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpT = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();
  private readonly lead = new THREE.Vector3();
  private readonly centroid = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly right = new THREE.Vector3(1, 0, 0);
  private readonly out = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 45 };

  constructor(mount: HTMLElement) {
    this.renderer = new GameRenderer(mount);
    this.view = new VoxelView(this.renderer.scene);
    this.atmosphere = new Atmosphere(this.renderer.scene, this.renderer.sun, this.renderer.hemi);
    this.atmosphere.setSummit(28);
    this.view.markDirty();

    // trail as a smooth closed curve through the waypoints, laid on the ground
    const pts = PATH_WAYPOINTS.map(
      ([x, z]) => new THREE.Vector3(x + 0.5, groundY(this.world, x, z) + 1, z + 0.5),
    );
    this.curve = new THREE.CatmullRomCurve3(pts, true, "catmullrom", 0.5);
    this.curveLen = this.curve.getLength();

    // the cast: staggered single file, small side offsets so they read as a group
    for (let i = 0; i < CAST; i++) {
      const rig = new CharacterRig(VARIANT_CYCLE[i % VARIANT_CYCLE.length]);
      this.renderer.scene.add(rig.root);
      this.rigs.push(rig);
      this.offsets.push(0.03 - i * 0.011); // index 0 = lead (furthest ahead)
      this.lateral.push(i === 0 ? 0 : (i % 2 === 0 ? 0.75 : -0.75) * (0.6 + 0.25 * i));
    }

    this.scatterFoliage();
    this.buildMotes();
    this.setupPostFx();
    this.buildLetterbox();
    window.addEventListener("resize", this.onResize);

    this.loop = new GameLoop({
      fixedUpdate: () => {
        /* no physics — everything is driven analytically in render() */
      },
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

  // ------------------------------------------------------------ scene extras

  private scatterFoliage(): void {
    const placements: FoliagePlacement[] = [];
    for (let i = 0; i < 520; i++) {
      const x = 4 + Math.random() * 72;
      const z = 4 + Math.random() * 72;
      const gy = groundY(this.world, x, z);
      if (gy < 4) continue; // skip the sandy/underwater rim
      placements.push({
        x,
        y: gy + 1,
        z,
        yaw: Math.random() * Math.PI,
        scale: 0.8 + Math.random() * 0.7,
        type: pickFoliageType(Math.random()),
      });
    }
    new FoliagePatch(this.renderer.scene, placements);
  }

  /** Drifting pollen motes — cheap additive sparkle that reads as "film". */
  private buildMotes(): void {
    const N = 160;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = 8 + Math.random() * 64;
      pos[i * 3 + 1] = 3 + Math.random() * 15;
      pos[i * 3 + 2] = 8 + Math.random() * 64;
    }
    this.moteBase = pos.slice();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfff2c2,
      size: 0.13,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.renderer.scene.add(this.motes);
  }

  private setupPostFx(): void {
    const r = this.renderer.renderer;
    const size = r.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(r);
    this.composer.setPixelRatio(r.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    this.composer.addPass(new RenderPass(this.renderer.scene, this.renderer.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.42, 0.7, 0.82);
    this.composer.addPass(this.bloom);
    const vign = new ShaderPass(VignetteShader);
    vign.uniforms.offset!.value = 0.92;
    vign.uniforms.darkness!.value = 1.15;
    this.composer.addPass(vign);
    this.composer.addPass(new OutputPass());
  }

  /** 2.39:1 letterbox bars + a fade-from-black on entry (all DOM overlay). */
  private buildLetterbox(): void {
    const barCss =
      "position:fixed;left:0;right:0;height:11%;background:#000;z-index:40;pointer-events:none";
    const top = document.createElement("div");
    top.style.cssText = barCss + ";top:0";
    const bot = document.createElement("div");
    bot.style.cssText = barCss + ";bottom:0";
    this.fadeEl = document.createElement("div");
    this.fadeEl.style.cssText =
      "position:fixed;inset:0;background:#000;z-index:41;pointer-events:none;opacity:1;transition:opacity 1.8s ease";
    document.body.append(top, bot, this.fadeEl);
    requestAnimationFrame(() => (this.fadeEl.style.opacity = "0"));
  }

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
  };

  // ------------------------------------------------------------------ frame

  private render(dt: number): void {
    if (!this.paused) this.time += dt;

    this.updateCast(dt);
    this.view.update(this.world);
    this.atmosphere.update(0, dt); // hold the warm ground grade
    this.updateMotes();
    this.driveCamera();

    // shadows + a low, warm key light rimming the cast from behind-left
    this.renderer.trackTarget(this.centroid);
    this.renderer.sun.position.set(this.centroid.x - 30, this.centroid.y + 22, this.centroid.z - 22);

    this.composer.render();
    this.perf.update(this.renderer.renderer, dt);
  }

  /** Walk the cast along the trail; refresh lead / centroid / camera basis. */
  private updateCast(dt: number): void {
    this.centroid.set(0, 0, 0);
    for (let i = 0; i < this.rigs.length; i++) {
      const rig = this.rigs[i]!;
      let u = ((this.time * WALK_SPEED) / this.curveLen + this.offsets[i]!) % 1;
      if (u < 0) u += 1;
      this.curve.getPointAt(u, this.tmpP);
      this.curve.getTangentAt(u, this.tmpT);
      this.tmpT.y = 0;
      this.tmpT.normalize();
      this.tmpR.crossVectors(this.tmpT, UP).normalize(); // planar right
      const lat = this.lateral[i]!;
      const gx = this.tmpP.x + this.tmpR.x * lat;
      const gz = this.tmpP.z + this.tmpR.z * lat;
      const gy = groundY(this.world, gx, gz) + 1;
      rig.root.position.set(gx, gy, gz);
      rig.root.rotation.y = Math.atan2(this.tmpT.x, this.tmpT.z);
      rig.update("run", WALK_SPEED, dt);
      this.centroid.add(rig.root.position);
      if (i === 0) {
        this.lead.set(gx, gy, gz);
        this.fwd.copy(this.tmpT);
        this.right.copy(this.tmpR);
      }
    }
    this.centroid.multiplyScalar(1 / this.rigs.length);
  }

  private driveCamera(): void {
    // pick the current shot (pinned for screenshots, else cycle by wall-time)
    let shot = SHOTS[0]!;
    let local: number;
    if (this.pinnedShot >= 0) {
      shot = SHOTS[this.pinnedShot % SHOTS.length]!;
      local = (this.time % shot.dur) / shot.dur;
    } else {
      const tt = this.time % CYCLE;
      let acc = 0;
      for (const s of SHOTS) {
        if (tt < acc + s.dur) {
          shot = s;
          break;
        }
        acc += s.dur;
      }
      local = (tt - acc) / shot.dur;
    }
    this.curShot = shot.name;

    const ctx: ShotCtx = { lead: this.lead, centroid: this.centroid, fwd: this.fwd, right: this.right };
    shot.fn(Math.min(1, Math.max(0, local)), ctx, this.out);

    // subtle handheld sway keeps every shot alive
    const s = this.time;
    const cam = this.renderer.camera;
    cam.position.set(
      this.out.pos.x + Math.sin(s * 1.3) * 0.05,
      this.out.pos.y + Math.sin(s * 1.7 + 1) * 0.04,
      this.out.pos.z + Math.cos(s * 1.1) * 0.05,
    );
    cam.lookAt(this.out.look);
    if (Math.abs(cam.fov - this.out.fov) > 0.01) {
      cam.fov = this.out.fov;
      cam.updateProjectionMatrix();
    }
  }

  private updateMotes(): void {
    const pos = this.motes.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const t = this.time;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = this.moteBase[i]! + Math.sin(t * 0.4 + i) * 1.2;
      arr[i + 1] = (((this.moteBase[i + 1]! - t * 0.35) % 14) + 14) % 14 + 2; // slow drift down, wrap 2..16
      arr[i + 2] = this.moteBase[i + 2]! + Math.cos(t * 0.33 + i) * 1.2;
    }
    pos.needsUpdate = true;
  }

  // ------------------------------------------------------------------ debug

  private installDebugHooks(): void {
    (window as unknown as Record<string, unknown>).__roboCine = {
      shots: SHOTS.map((s) => s.name),
      pin: (i: number) => {
        this.pinnedShot = i;
      },
      unpin: () => {
        this.pinnedShot = -1;
      },
      seek: (t: number) => {
        this.time = t;
      },
      pause: () => {
        this.paused = true;
      },
      play: () => {
        this.paused = false;
      },
      snapshot: () => ({ time: this.time, shot: this.curShot, paused: this.paused }),
    };
  }
}
