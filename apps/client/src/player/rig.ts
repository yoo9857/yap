import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { AnimState } from "@robo/shared";
import { loadTexture } from "../render/textures.js";

/**
 * CraftYap's own mascots, built EXACTLY like the banner drawings: each
 * character is ONE chunky rounded cube with the hand-drawn face right on it,
 * stubby little arms and feet, and a per-variant topper (the yellow mascot's
 * blue star-cap, the blue & purple cubes' sprout). That single-cube anatomy is
 * what makes the banner characters read as creatures — no head/torso seam, no
 * floating limbs. Faces blink and react (jump = "oh!", dead = X X) via decal
 * swaps; an inverted-hull shader gives every part a constant-width ink line.
 *
 * Drop-in for the former glTF rig: `root` (feet at origin), `update(anim,
 * planarSpeed, dt)`, `pop()` for the squash spring, free `disposeRig(root)`.
 */

export type CharacterVariant = "mascot" | "blue" | "purple";

/** Cycle for giving crowds (bots, remote players, builder crew) some variety. */
export const VARIANT_CYCLE: CharacterVariant[] = ["mascot", "blue", "purple"];

type Anim = AnimState | "carry" | "place";
type Expr = "happy" | "blink" | "oh" | "dead";

interface VariantSpec {
  body: number;
  limb: number;
  faceBase: string;
  topper: "cap" | "sprout";
  topA: number;
  topB: number;
}

const VARIANTS: Record<CharacterVariant, VariantSpec> = {
  mascot: { body: 0xf9d71c, limb: 0xeec21a, faceBase: "mascot", topper: "cap", topA: 0x2f6fd6, topB: 0xffd21c },
  blue: { body: 0x37a6ea, limb: 0x2f95d6, faceBase: "blue", topper: "sprout", topA: 0x3fa93d, topB: 0x7bd85f },
  purple: { body: 0x8a5cd0, limb: 0x7c50be, faceBase: "purple", topper: "sprout", topA: 0x3fa93d, topB: 0x7bd85f },
};

const faceUrl = (base: string, e: Expr): string =>
  e === "dead" ? "/textures/char/face-dead.png" : `/textures/char/face-${base}${e === "happy" ? "" : `-${e}`}.png`;

// ---- shared geometry (soft rounded boxes, cached by size) ------------------
const geoCache = new Map<string, RoundedBoxGeometry>();
function box(w: number, h: number, d: number, soft = 0.24): RoundedBoxGeometry {
  const key = `${w.toFixed(2)},${h.toFixed(2)},${d.toFixed(2)},${soft}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 4, Math.min(w, h, d) * soft);
    geoCache.set(key, g);
  }
  return g;
}
const STUD_GEO = new THREE.CylinderGeometry(0.1, 0.105, 0.08, 18);

// Constant-width ink outline: an inverted hull pushed out along the normal in
// the vertex shader, so every part shares the same line weight.
const OUTLINE_MAT = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: { t: { value: 0.02 } },
  vertexShader:
    "uniform float t; void main(){ vec3 p = position + normalize(normal) * t; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }",
  fragmentShader: "void main(){ gl_FragColor = vec4(0.09, 0.09, 0.12, 1.0); }",
});
const FACE_QUAD = new THREE.PlaneGeometry(1, 1);

// ---- crayon grain (faint hand-drawn strokes, tinted by body colour) --------
let grainTex: THREE.Texture | null = null;
function crayonGrain(): THREE.Texture | null {
  if (grainTex) return grainTex;
  if (typeof document === "undefined") return null;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = 2;
  for (let i = 0; i < 55; i++) {
    ctx.strokeStyle = "rgba(0,0,0,0.045)";
    ctx.beginPath();
    const x = Math.random() * S, y = Math.random() * S;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40);
    ctx.stroke();
  }
  for (let i = 0; i < 300; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.035})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  grainTex = new THREE.CanvasTexture(c);
  grainTex.wrapS = grainTex.wrapT = THREE.RepeatWrapping;
  grainTex.colorSpace = THREE.SRGBColorSpace;
  return grainTex;
}

const matCache = new Map<number, THREE.MeshStandardMaterial>();
function bodyMat(color: number): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.02, map: crayonGrain() });
    matCache.set(color, m);
  }
  return m;
}

let fallbackFaceTex: THREE.Texture | null = null;
function fallbackFace(): THREE.Texture | null {
  if (fallbackFaceTex) return fallbackFaceTex;
  if (typeof document === "undefined") return null;
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#1a1a22";
  ctx.strokeStyle = "#1a1a22";
  ctx.lineCap = "round";
  ctx.lineWidth = 12;
  for (const ex of [S * 0.34, S * 0.66]) {
    ctx.beginPath();
    ctx.arc(ex, S * 0.42, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(ex - 6, S * 0.38, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a1a22";
  }
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.52, S * 0.2, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,120,150,0.55)";
  for (const bx of [S * 0.22, S * 0.78]) {
    ctx.beginPath();
    ctx.ellipse(bx, S * 0.6, 16, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  fallbackFaceTex = new THREE.CanvasTexture(c);
  fallbackFaceTex.colorSpace = THREE.SRGBColorSpace;
  return fallbackFaceTex;
}

/** Preload every face decal (all expressions) + grain for boot warmup. */
export function preloadCharacter(): Promise<void> {
  fallbackFace();
  crayonGrain();
  const urls = new Set<string>();
  for (const v of Object.values(VARIANTS))
    for (const e of ["happy", "blink", "oh", "dead"] as Expr[]) urls.add(faceUrl(v.faceBase, e));
  return Promise.all([...urls].map((u) => loadTexture(u).catch(() => null))).then(() => undefined);
}

/** Add a constant-width ink outline shell to a mesh (rides its transform). */
function outline(mesh: THREE.Mesh): THREE.Mesh {
  mesh.add(new THREE.Mesh(mesh.geometry, OUTLINE_MAT));
  return mesh;
}

/** A soft rounded part (outlined), parented to `p`. */
function part(
  p: THREE.Object3D,
  color: number,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  soft = 0.24,
): THREE.Mesh {
  const mesh = new THREE.Mesh(box(w, h, d, soft), bodyMat(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  p.add(mesh);
  outline(mesh);
  return mesh;
}

function stud(p: THREE.Object3D, color: number, x: number, y: number, z: number): void {
  const s = new THREE.Mesh(STUD_GEO, bodyMat(color));
  s.position.set(x, y, z);
  s.castShadow = true;
  p.add(s);
  outline(s);
}

export class CharacterRig {
  readonly root = new THREE.Group();
  /** Everything lives under this inner group — callers own root's transform
   *  (position/yaw are overwritten every frame), so squash & the dead-topple
   *  animate `toy` instead and never fight them. */
  private readonly toy = new THREE.Group();
  private readonly bob = new THREE.Group(); // the cube + arms (bobs, leans, tilts)
  private readonly hipL = new THREE.Group();
  private readonly hipR = new THREE.Group();
  private readonly shoulderL = new THREE.Group();
  private readonly shoulderR = new THREE.Group();
  private readonly facePlane: THREE.Mesh;
  private readonly faceMat: THREE.MeshBasicMaterial;
  private readonly faceBase: string;
  private readonly faceTex = new Map<Expr, THREE.Texture>();
  private expr: Expr = "happy";
  private blinkT = 2 + Math.random() * 3;
  private phase = Math.random() * Math.PI * 2; // crowds don't move in lockstep
  private squash = 0;
  private squashVel = 0;
  private static readonly SQUASH_STIFF = 190;
  private static readonly SQUASH_DAMP = 15;

  constructor(variant: CharacterVariant = "mascot") {
    const v = VARIANTS[variant] ?? VARIANTS.mascot;
    this.faceBase = v.faceBase;
    this.root.add(this.toy);
    this.toy.add(this.bob);

    // ---- feet: stubby legs + rounded shoes (pivot at the hip) --------------
    // Legs hang off `toy` (not the bobbing cube) so the feet stay planted
    // while the body bounces — this is what kills the "floaty slide" look.
    this.hipL.position.set(-0.2, 0.42, 0);
    this.hipR.position.set(0.2, 0.42, 0);
    this.toy.add(this.hipL, this.hipR);
    for (const hip of [this.hipL, this.hipR]) {
      part(hip, v.limb, 0.22, 0.34, 0.26, 0, -0.14, 0, 0.3);
      part(hip, 0x3a3a44, 0.28, 0.17, 0.4, 0, -0.33, 0.05, 0.38); // soft shoe
    }

    // ---- THE cube: one body, face right on it (exactly like the banner) ----
    part(this.bob, v.body, 0.95, 1.0, 0.78, 0, 0.92, 0, 0.2);

    this.faceMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.06, depthWrite: false });
    this.facePlane = new THREE.Mesh(FACE_QUAD, this.faceMat);
    this.facePlane.scale.set(0.8, 0.8, 1);
    this.facePlane.position.set(0, 0.98, 0.41);
    this.bob.add(this.facePlane);
    const fb = fallbackFace();
    if (fb) this.faceMat.map = fb;
    for (const e of ["happy", "blink", "oh", "dead"] as Expr[]) this.loadExpr(e);

    // ---- stubby arms with mitten hands, hugging the cube's sides -----------
    this.shoulderL.position.set(-0.5, 1.06, 0);
    this.shoulderR.position.set(0.5, 1.06, 0);
    this.bob.add(this.shoulderL, this.shoulderR);
    for (const [sh, s] of [[this.shoulderL, -1], [this.shoulderR, 1]] as const) {
      part(sh, v.limb, 0.17, 0.36, 0.2, s * 0.03, -0.15, 0, 0.34);
      part(sh, v.body, 0.2, 0.2, 0.22, s * 0.05, -0.36, 0.01, 0.42); // mitten
    }

    // ---- topper -------------------------------------------------------------
    if (v.topper === "cap") this.buildCap(v);
    else this.buildSprout(v);
  }

  /**
   * The mascot's baseball cap. The crown is WIDER than the cube so it wraps
   * over the top edge like a real cap (a smaller crown sinks into the cube and
   * reads as clipped); the bill clears the face, and the star sits proud of
   * the crown's front so nothing intersects.
   */
  private buildCap(v: VariantSpec): void {
    part(this.bob, v.topA, 1.06, 0.34, 0.92, 0, 1.46, 0, 0.26); // crown, capping the cube
    const bill = part(this.bob, v.topA, 0.62, 0.09, 0.34, 0, 1.35, 0.6, 0.3);
    bill.rotation.x = 0.18;
    stud(this.bob, v.topA, 0, 1.66, 0); // top button
    const star = new THREE.Mesh(box(0.17, 0.17, 0.07, 0.2), bodyMat(v.topB));
    star.position.set(0, 1.47, 0.47); // proud of the crown front
    star.rotation.z = Math.PI / 4;
    this.bob.add(star);
    outline(star);
  }

  /** The sprout: stem + leaves, with toy studs flanking it on the cube top. */
  private buildSprout(v: VariantSpec): void {
    stud(this.bob, v.body, -0.26, 1.46, 0);
    stud(this.bob, v.body, 0.26, 1.46, 0);
    part(this.bob, v.topA, 0.09, 0.26, 0.09, 0, 1.53, 0, 0.4); // stem
    const lL = part(this.bob, v.topB, 0.28, 0.13, 0.15, -0.15, 1.62, 0, 0.4);
    lL.rotation.z = 0.6;
    const lR = part(this.bob, v.topB, 0.28, 0.13, 0.15, 0.15, 1.62, 0, 0.4);
    lR.rotation.z = -0.6;
    part(this.bob, v.topB, 0.18, 0.12, 0.14, 0, 1.72, 0, 0.4);
  }

  private loadExpr(e: Expr): void {
    void loadTexture(faceUrl(this.faceBase, e)).then((tex) => {
      if (tex) {
        this.faceTex.set(e, tex);
        if (this.expr === e) this.faceMat.map = tex;
      }
    });
  }

  private setExpr(e: Expr): void {
    if (this.expr === e) return;
    this.expr = e;
    const tex = this.faceTex.get(e) ?? this.faceTex.get("happy") ?? this.faceMat.map;
    if (tex && this.faceMat.map !== tex) {
      this.faceMat.map = tex;
      this.faceMat.needsUpdate = true;
    }
  }

  pop(impulse: number): void {
    this.squashVel += impulse;
  }

  private stepSquash(dt: number): void {
    const h = Math.min(dt, 1 / 30);
    this.squashVel +=
      (-CharacterRig.SQUASH_STIFF * this.squash - CharacterRig.SQUASH_DAMP * this.squashVel) * h;
    this.squash += this.squashVel * h;
    this.squash = Math.max(-0.42, Math.min(0.55, this.squash));
    const sy = 1 + this.squash;
    const sxz = 1 / Math.sqrt(sy);
    this.toy.scale.set(sxz, sy, sxz);
  }

  update(anim: Anim, planarSpeed: number, dt: number): void {
    const moving = anim === "run" || anim === "carry";
    const cadence = moving ? Math.max(4, Math.min(15, planarSpeed * 2.1)) : 3.2;
    this.phase += dt * cadence;

    // --- expression state machine ---
    if (anim === "dead") this.setExpr("dead");
    else if (anim === "jump" || anim === "fall") this.setExpr("oh");
    else {
      this.blinkT -= dt;
      if (this.blinkT <= 0) {
        this.setExpr("blink");
        if (this.blinkT <= -0.12) this.blinkT = 2 + Math.random() * 3.5;
      } else this.setExpr("happy");
    }

    if (anim === "dead") {
      // keel over sideways, whole toy
      this.toy.rotation.z = Math.min(Math.PI / 2, this.toy.rotation.z + dt * 6);
      this.toy.position.y = Math.max(-0.15, this.toy.position.y - dt * 1.2);
      this.stepSquash(dt);
      return;
    }
    this.toy.rotation.z += (0 - this.toy.rotation.z) * Math.min(1, dt * 12);
    this.toy.position.y += (0 - this.toy.position.y) * Math.min(1, dt * 12);

    let legSwing = 0, armSwing = 0, bobY = 0, lean = 0, armRaise = 0, waddle = 0, armSplay = 0;

    if (anim === "jump") {
      armRaise = -1.9; // arms up-and-OUT — "wheee!", not teddy ears
      armSplay = 0.55;
      legSwing = -0.55; // legs tucked
    } else if (anim === "fall") {
      armRaise = -2.2;
      armSplay = 0.75;
      legSwing = 0.35;
    } else if (moving) {
      const s = Math.sin(this.phase);
      legSwing = s * 1.0;
      armSwing = -s * 0.55;
      bobY = Math.abs(Math.sin(this.phase)) * 0.06;
      lean = 0.14;
      waddle = Math.sin(this.phase) * 0.06; // side-to-side toy waddle
      if (anim === "carry") {
        armRaise = -1.3;
        armSwing = 0;
      }
    } else {
      // idle: soft breathing + a lazy arm sway
      const s = Math.sin(this.phase * 0.55);
      bobY = s * 0.02;
      armSwing = s * 0.08;
      waddle = Math.sin(this.phase * 0.28) * 0.015;
    }

    this.hipL.rotation.x = legSwing;
    this.hipR.rotation.x = -legSwing;
    this.shoulderL.rotation.x = armSwing + armRaise;
    this.shoulderR.rotation.x = -armSwing + armRaise;
    this.shoulderL.rotation.z = armSplay;
    this.shoulderR.rotation.z = -armSplay;
    this.bob.position.y = bobY;
    this.bob.rotation.x = lean;
    this.bob.rotation.z = waddle;

    this.stepSquash(dt);
  }
}

/** Frees per-instance extras (name-label sprites). Shared geo/materials stay. */
export function disposeRig(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Sprite) {
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}
