import * as THREE from "three";
import { blob, bodyMat, box, part } from "./blockParts.js";
import type { PetAnim } from "./pet.js";

/**
 * Every CraftYap pet, drawn from the same rounded bricks, crayon grain and
 * constant-width ink line as the cube mascots (`blockParts.ts`), so the whole
 * cast reads as one toy set.
 *
 * ONE skeleton and ONE animation engine serve all of them — chest-pivot spine,
 * four legs in diagonal pairs, a hinged head and tail — and each species adds
 * its own head, ears and extras through a builder. That split is the point: a
 * trunk, a giraffe's neck and a cat's whip tail are genuinely different
 * geometry, but a trot is a trot, and five separately-written gaits would
 * drift apart the moment one of them was tuned.
 *
 * Four rules are load-bearing, and every one was found by LOOKING at the rigs
 * (`node tools/shot-pets.mjs <dir>`), not by reasoning about them:
 *
 * - **The spine pivots at the chest, not at the feet.** This is the whole
 *   reason the sit pose works. Rotating the torso about the origin swings the
 *   rump up and backwards and the animal reads as a teddy bear propped against
 *   something. Pivoting at the chest drops the rump to the floor and lifts the
 *   chest, which is what sitting actually is.
 * - **Faces are not bricks, and they carry no ink line.** Eyes, noses and
 *   markings are spheres (`blob`). At four or five centimetres a rounded box
 *   still shows its corners and its border, so an eye became a white tile, a
 *   nose a crate bolted to the muzzle, and a panda's patch a spectacle frame
 *   wider than its own skull. The eye's dark rim is drawn as another sphere —
 *   geometry that scales with the eye instead of a fixed-width shell.
 * - **Every eye must PROTRUDE from the skull**, and each layer of it must sit
 *   clearly in FRONT of the last. A feature level with what is behind it
 *   interleaves, and the face fills with z-fighting stripes.
 * - **A shape is one brick, or it is two things.** The outline draws a border
 *   around every piece, so a wide brick with a narrower one stacked on it does
 *   not read as a taper, it reads as two jar lids. Where a point is needed
 *   (the cat's ears) the trick is a square turned 45° and half-buried in its
 *   host — and with the line now thin, that overlap has to be real, or the
 *   ears float off the skull like paper cut-outs.
 * - **Markings must sit ON a surface, not float in front of it.** A pale brick
 *   parked just off the chest reads as a plaque bolted on; a mane set at the
 *   neck's own half-depth is buried inside it and the giraffe looks shaved.
 *
 * Faces are geometry, not decals: the cube mascots wear a face plane because a
 * flat cube front is a drawing surface and a muzzle is not. That also means the
 * pets need no PNG at all — nothing to preload, nothing to 404. Blinking
 * squashes the eye bricks, the way a toy would.
 *
 * Feet sit at the origin and the nose points +z, matching `CharacterRig`, so
 * callers place and yaw every creature identically. `update(anim, speed, dt)`
 * and `pop(impulse)` mirror that rig's signature too.
 */

export type PetSpecies = "dog" | "cat" | "elephant" | "giraffe" | "panda";

/** Display order in the adoption panel. */
export const PET_SPECIES: PetSpecies[] = ["dog", "cat", "elephant", "giraffe", "panda"];

export interface SpeciesInfo {
  key: PetSpecies;
  /** Panel label (Korean, the default UI language). */
  name: string;
  /** The same label in English. */
  nameEn: string;
  emoji: string;
  /** One line of character for the adoption card. */
  trait: string;
  traitEn: string;
  /** Voxel-grid collider (see voxelBody's `Body.w/h`). */
  bodyWidth: number;
  bodyHeight: number;
  /** Hop speed. Rise is v²/2g against voxelBody's 24 m/s², so anything under
   *  ~7 leaves the pet unable to climb the island's 1 m steps. */
  jumpSpeed: number;
  /** Multiplies the follow speed: a cat darts, an elephant lumbers. */
  pace: number;
}

/** Everything the panel and the physics need, with no three.js involved — so
 *  it can be unit-tested and read by DOM code without importing a renderer. */
export const SPECIES: Record<PetSpecies, SpeciesInfo> = {
  dog: {
    key: "dog",
    name: "시바견",
    nameEn: "Shiba",
    emoji: "🐕",
    trait: "제일 빨리 달려와요",
    traitEn: "Always first to come running",
    bodyWidth: 0.5,
    bodyHeight: 1.0,
    jumpSpeed: 7.6,
    pace: 1,
  },
  cat: {
    key: "cat",
    name: "하얀 고양이",
    nameEn: "White cat",
    emoji: "🐈",
    trait: "가볍고 높이 뜁니다",
    traitEn: "Light on its feet, jumps high",
    bodyWidth: 0.42,
    bodyHeight: 0.85,
    jumpSpeed: 8.6,
    pace: 1.08,
  },
  elephant: {
    key: "elephant",
    name: "아기 코끼리",
    nameEn: "Baby elephant",
    emoji: "🐘",
    trait: "코를 흔들며 느긋하게",
    traitEn: "Swings its trunk, takes its time",
    bodyWidth: 0.95,
    bodyHeight: 1.75,
    jumpSpeed: 7.2,
    pace: 0.78,
  },
  giraffe: {
    key: "giraffe",
    name: "아기 기린",
    nameEn: "Baby giraffe",
    emoji: "🦒",
    trait: "목이 담장 너머까지",
    traitEn: "Can see over the fence",
    bodyWidth: 0.7,
    bodyHeight: 2.45,
    jumpSpeed: 7.4,
    pace: 0.95,
  },
  panda: {
    key: "panda",
    name: "판다",
    nameEn: "Panda",
    emoji: "🐼",
    trait: "둥글고 느릿느릿",
    traitEn: "Round and in no hurry",
    bodyWidth: 0.72,
    bodyHeight: 1.15,
    jumpSpeed: 7.2,
    pace: 0.82,
  },
};

export const isPetSpecies = (v: unknown): v is PetSpecies =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(SPECIES, v);

const INK = 0x241d22;
const EYE_WHITE = 0xfdfbf6;

/** The skeleton each species builder fills in. All distances are metres, feet
 *  at y = 0, nose toward +z. */
interface Skeleton {
  /** Chest pivot — where `spine` sits, and what a lean or a sit rotates about. */
  chestY: number;
  chestZ: number;
  /** Hip/shoulder height and footprint of the four legs. */
  shoulderY: number;
  legSpreadX: number;
  legSpreadZ: number;
  /** Hip height when sitting; the haunches fold forward and the rear drops. */
  sitHipY: number;
  /** How far the torso tips back when sitting (radians, negative = nose up). */
  sitLean: number;
  /** Leg swing amplitude, in radians at full gait. The legs now run from the
   *  shoulder all the way to the ground, so this is far smaller than it looks
   *  like it should be — at the old values the animals did the splits. */
  stride: number;
  /** Gait cadence per m/s of travel. */
  cadence: number;
  /** Vertical bob amplitude while moving. */
  bob: number;
}

interface Built {
  skeleton: Skeleton;
  /** Blinkable eyes (a group per eye: rim, white, pupil, glint). */
  eyes: THREE.Object3D[];
  /** Ear roots that flop with the gait. */
  ears: THREE.Object3D[];
  /** Trunk segments that undulate; empty for every species but the elephant. */
  chain: THREE.Object3D[];
  /** How the tail is carried at rest (radians about x) and how hard it swings. */
  tailPitch: number;
  tailAmp: number;
}

/** Rest pitch of each chain segment, so the wave is ADDED to the curl rather
 *  than replacing it — writing rotation.x outright straightens the trunk. */
const CHAIN_REST = new WeakMap<THREE.Object3D, number>();

export class CreatureRig {
  readonly root = new THREE.Group();
  readonly species: PetSpecies;
  /** Everything hangs here so squash never fights the caller, which overwrites
   *  `root`'s position and yaw every frame. */
  private readonly toy = new THREE.Group();
  /** Torso, neck, head and tail. Pivots at the chest. */
  private readonly spine = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly tail = new THREE.Group();
  private readonly legs: THREE.Group[] = []; // FL, FR, BL, BR
  private readonly built: Built;

  private phase = Math.random() * Math.PI * 2; // a litter doesn't march in step
  private blinkT = 1.5 + Math.random() * 3;
  private blink = 0;
  private sit = 0; // 0 = standing, 1 = fully sat
  private air = 0; // 0 = feet down, 1 = fully airborne
  private lastAir = 1; // +1 rising, -1 falling — held while `air` eases out
  private squash = 0;
  private squashVel = 0;
  private static readonly SQUASH_STIFF = 190;
  private static readonly SQUASH_DAMP = 15;

  constructor(species: PetSpecies = "dog") {
    this.species = SPECIES[species] ? species : "dog";
    this.root.add(this.toy);
    this.toy.add(this.spine);
    this.spine.add(this.head, this.tail);

    this.built = BUILDERS[this.species]({
      spine: this.spine,
      head: this.head,
      tail: this.tail,
      toy: this.toy,
      legs: this.legs,
    });

    const s = this.built.skeleton;
    this.spine.position.set(0, s.chestY, s.chestZ);
    this.tail.rotation.x = this.built.tailPitch;
  }

  /** Squash spring — same feel as the mascots', fired on hops and landings. */
  pop(impulse: number): void {
    this.squashVel += impulse;
  }

  private stepSquash(dt: number): void {
    const h = Math.min(dt, 1 / 30);
    this.squashVel +=
      (-CreatureRig.SQUASH_STIFF * this.squash - CreatureRig.SQUASH_DAMP * this.squashVel) * h;
    this.squash += this.squashVel * h;
    this.squash = Math.max(-0.35, Math.min(0.45, this.squash));
    const sy = 1 + this.squash;
    const sxz = 1 / Math.sqrt(sy);
    this.toy.scale.set(sxz, sy, sxz);
  }

  update(anim: PetAnim, speed: number, dt: number): void {
    const sk = this.built.skeleton;
    const moving = anim === "walk" || anim === "run";
    const cadence = moving ? Math.max(4, Math.min(18, speed * sk.cadence)) : 3;
    this.phase += dt * cadence;

    // Sit is a pose, not a frame: ease into it so the animal settles instead of
    // snapping, and so a sit interrupted by a recall looks like standing up.
    this.sit += ((anim === "sit" ? 1 : 0) - this.sit) * Math.min(1, dt * 7);

    // Blink: eye bricks squash flat for a beat. No texture swap, no decal.
    this.blinkT -= dt;
    if (this.blinkT <= 0) {
      this.blink = 1;
      if (this.blinkT <= -0.1) {
        this.blink = 0;
        this.blinkT = 1.5 + Math.random() * 3.5;
      }
    }
    for (const eye of this.built.eyes) eye.scale.y = 1 - this.blink * 0.8;

    // The airborne pose is BLENDED in, never switched to. A pet skimming the
    // ground has `grounded` flicker on and off between ticks, and snapping
    // between a swinging gait and tucked-up legs on each flicker is the
    // shivering that made jumps look broken. Easing the weight costs one lerp
    // and makes the flicker invisible.
    const airborne = anim === "jump" || anim === "fall";
    this.air += ((airborne ? 1 : 0) - this.air) * Math.min(1, dt * 11);

    // --- the pose with feet on the ground ---
    let swing = 0, bobY = 0, lean = 0, headPitch = 0;
    let tailRate = 2.2, tailAmp = this.built.tailAmp * 0.6;
    if (moving) {
      swing = Math.sin(this.phase);
      bobY = Math.abs(Math.sin(this.phase)) * sk.bob;
      lean = anim === "run" ? 0.1 : 0.04;
      tailRate = anim === "run" ? 13 : 8;
      tailAmp = this.built.tailAmp * (anim === "run" ? 1.5 : 1);
    } else {
      bobY = Math.sin(this.phase * 0.6) * 0.012; // breathing
      headPitch = Math.sin(this.phase * 0.23) * 0.07; // idle glance
      tailRate = anim === "sit" ? 5 : 3.2;
      tailAmp = this.built.tailAmp * (anim === "sit" ? 0.9 : 0.6);
    }

    // --- blend toward the airborne pose ---
    if (this.air > 0.001) {
      // `lastAir` keeps the up/down shape stable while the weight eases out,
      // so the legs do not flip direction on the way back to the ground.
      if (airborne) this.lastAir = anim === "jump" ? 1 : -1;
      const up = this.lastAir > 0;
      swing = THREE.MathUtils.lerp(swing, up ? -0.34 : 0.26, this.air);
      bobY = THREE.MathUtils.lerp(bobY, 0, this.air);
      lean = THREE.MathUtils.lerp(lean, up ? -0.06 : 0.08, this.air);
      headPitch = THREE.MathUtils.lerp(headPitch, up ? -0.22 : 0.18, this.air);
      tailRate = THREE.MathUtils.lerp(tailRate, 6, this.air);
      tailAmp = THREE.MathUtils.lerp(tailAmp, this.built.tailAmp, this.air);
    }

    // Diagonal pairs — FL+BR against FR+BL. This is the trot, and it is the one
    // thing that stops four swinging boxes from looking like a sliding table.
    const [fl, fr, bl, br] = this.legs as [THREE.Group, THREE.Group, THREE.Group, THREE.Group];
    // The airborne tuck needs an amplitude of its own: a pet that hops from a
    // standstill has no gait amplitude, and multiplying by zero would leave
    // the legs dead straight in mid-air.
    const a = swing * Math.max(moving ? sk.stride : 0, this.air);
    fl.rotation.x = a;
    br.rotation.x = a;
    fr.rotation.x = -a;
    bl.rotation.x = -a;
    bl.position.y = sk.shoulderY;
    br.position.y = sk.shoulderY;

    // Sitting: the chest pivot tips the torso back so the rump comes DOWN, the
    // haunches fold forward and drop, and the front legs stay straight.
    if (this.sit > 0.01) {
      const t = this.sit;
      for (const back of [bl, br]) {
        back.rotation.x = THREE.MathUtils.lerp(back.rotation.x, -1.25, t);
        back.position.y = THREE.MathUtils.lerp(sk.shoulderY, sk.sitHipY, t);
      }
      fl.rotation.x = THREE.MathUtils.lerp(fl.rotation.x, 0, t);
      fr.rotation.x = THREE.MathUtils.lerp(fr.rotation.x, 0, t);
      lean = THREE.MathUtils.lerp(lean, sk.sitLean, t);
      bobY = THREE.MathUtils.lerp(bobY, -0.06, t);
      headPitch = THREE.MathUtils.lerp(headPitch, 0.12, t);
    }

    this.spine.position.y = sk.chestY + bobY;
    this.spine.rotation.x = lean;
    this.spine.rotation.z = moving ? Math.sin(this.phase) * 0.035 : 0; // toy waddle
    this.head.rotation.x = headPitch;
    this.head.rotation.z = moving ? 0 : Math.sin(this.phase * 0.31) * 0.09; // head tilt

    // Ears lag the body — the flop is what sells a stack of boxes as an animal.
    const flop = moving ? Math.sin(this.phase - 0.9) * 0.22 : Math.sin(this.phase * 0.5) * 0.05;
    for (let i = 0; i < this.built.ears.length; i++) {
      const sx = i === 0 ? -1 : 1;
      this.built.ears[i]!.rotation.x = flop;
      this.built.ears[i]!.rotation.z = sx * flop * 0.4;
    }

    // The trunk undulates with a travelling wave — each link lags the one
    // before it, which is what makes it read as soft rather than as a hinged
    // arm. Added to each segment's rest curl, never written over it.
    const drive = moving ? 1 : 0.45;
    for (let i = 0; i < this.built.chain.length; i++) {
      const seg = this.built.chain[i]!;
      const lag = i * 0.7;
      seg.rotation.x = (CHAIN_REST.get(seg) ?? 0) + Math.sin(this.phase * 1.6 - lag) * 0.14 * drive;
      seg.rotation.y = Math.sin(this.phase * 0.9 - lag) * 0.1 * drive;
    }

    this.tail.rotation.y = Math.sin(this.phase * tailRate) * tailAmp;
    this.tail.rotation.x = this.built.tailPitch + (anim === "fall" ? 0.5 : 0);

    this.stepSquash(dt);
  }

  /** Mirrors `disposeRig` — shared geometry and materials deliberately stay. */
  dispose(): void {
    this.root.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Builder toolkit
// ---------------------------------------------------------------------------

interface Rigging {
  spine: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
  toy: THREE.Group;
  legs: THREE.Group[];
}

/** A rounded brick with NO ink outline — for details small enough that the
 *  constant-width line would be most of the part. */
function bare(color: number, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(box(w, h, d, 0.45), bodyMat(color));
  mesh.position.set(x, y, z);
  return mesh;
}

/**
 * Four legs hung off `toy` (not the bobbing spine) so the feet stay planted
 * while the body bobs, leans and sits.
 *
 * The leg's LENGTH IS DERIVED from the shoulder height, never passed in.
 * Taking both as independent numbers is how all five pets ended up hovering
 * above the ground — the panda by 20 cm — because nothing tied the two
 * together and every species drifted on its own. The paw is `h * 0.3` tall and
 * centred on the leg's end, so `shoulderY = 1.15h` puts its underside exactly
 * on y = 0.
 */
const PAW_RATIO = 0.3;
function legs(
  r: Rigging,
  sk: Skeleton,
  coat: number,
  paw: number,
  w: number,
  d: number,
  /** Colour of the shoulder/hip mass; defaults to the leg's own. */
  hip = coat,
): void {
  const h = sk.shoulderY / (1 + PAW_RATIO / 2);
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]] as const) {
    // A shoulder/hip filling the armpit, overlapping both the torso and the
    // limb. Without it the body is a box and the legs are four posts bolted
    // under it, and the animal reads as a table.
    //
    // It is a BLOB, not a brick, and that is the whole trick: an outlined
    // shoulder puts a third ink ring into a joint that already has two (the
    // torso's and the leg's), and three nested rings read as a lump stuck on
    // rather than as a joint. Un-outlined and in the limb's own colour it
    // simply melts the corner away. It rides `toy` with the leg, so it does
    // not swing when the limb does.
    blob(r.toy, hip, w * 1.34, w * 1.5, d * 1.32, sx * sk.legSpreadX, sk.shoulderY, sz * sk.legSpreadZ);

    const leg = new THREE.Group();
    leg.position.set(sx * sk.legSpreadX, sk.shoulderY, sz * sk.legSpreadZ);
    r.toy.add(leg);
    part(leg, coat, w, h, d, 0, -h / 2, 0, 0.3);
    part(leg, paw, w * 1.12, h * PAW_RATIO, d * 1.2, 0, -h, 0.012, 0.4);
    r.legs.push(leg);
  }
}

/**
 * The standard eye: a pale bead proud of the skull, a round pupil floating on
 * its front, a highlight on top.
 *
 * `faceZ` is the skull's front face — the bead is placed to stick out past it,
 * which is the difference between an eye and two black smudges. The pupil and
 * highlight are SPHERES, not bricks: at four centimetres a rounded box still
 * shows its corners and the eye reads as a postage stamp. They carry no ink
 * line either, since at that size the line is the whole shape.
 */
function eyes(
  host: THREE.Object3D,
  out: THREE.Object3D[],
  spreadX: number,
  y: number,
  faceZ: number,
  size: number,
  /** Pupil height multiplier — above 1 narrows it toward a cat's slit. */
  slit = 1,
): void {
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * spreadX, y, faceZ - size * 0.14);
    host.add(eye);
    out.push(eye);
    // Four nested spheres, each clearly in front of the last. The dark rim is
    // what the ink line used to do; drawing it as geometry instead means it
    // scales with the eye and cannot interleave with whatever is behind it.
    blob(eye, INK, size * 1.04, size * 1.2, size * 0.5, 0, 0, 0);
    blob(eye, EYE_WHITE, size * 0.88, size * 1.02, size * 0.5, 0, 0, size * 0.1);
    blob(eye, INK, (size * 0.42) / slit, size * 0.5 * slit, size * 0.3, 0, -size * 0.02, size * 0.22);
    blob(eye, EYE_WHITE, size * 0.17, size * 0.17, size * 0.15, sx * size * 0.14, size * 0.2, size * 0.3);
  }
}

/** A nose: a smooth lump, because a dark brick on a pale muzzle reads as a
 *  small crate bolted to the face. */
function snoutNose(
  host: THREE.Object3D,
  color: number,
  w: number, h: number, d: number,
  y: number, z: number,
  x = 0,
): void {
  blob(host, color, w, h, d, x, y, z);
}

/** A mouth line: thin, dark, and barely proud of the muzzle. */
function mouthLine(host: THREE.Object3D, color: number, w: number, y: number, z: number): void {
  blob(host, color, w, w * 0.22, w * 0.5, 0, y, z);
}

/**
 * A torso built from a chain of overlapping ellipsoids, given nose-to-tail as
 * `[z, y, width, height, depth]`.
 *
 * Animals are not rectangular, and the old single-brick bodies read as crates
 * on legs however much their corners were rounded. Lumps give a chest that is
 * deeper than the waist, a belly that sags, a rump that tapers — the curves a
 * real body has.
 *
 * This is only affordable because the ink moved to screen space
 * (`render/inkOutline.ts`). Every extra brick used to add its own black ring,
 * so a body made of six pieces was six rings; now the silhouette is found from
 * a mask and the interior is seamless, so a form can be modelled with as many
 * lumps as it needs.
 *
 * Spacing is what decides whether this reads as a body or as a string of
 * beads. For lumps of radius R set S apart the surface ripples by
 * `R - sqrt(R² - (S/2)²)`; keep S at about a quarter of the DEPTH and the
 * ripple lands near 3% of the radius, which the eye reads as one smooth form.
 * The first attempt spaced them at nearly a full radius and the dog came out
 * as a caterpillar.
 */
function torso(
  host: THREE.Object3D,
  sk: Skeleton,
  color: number,
  segments: readonly (readonly [number, number, number, number, number])[],
): void {
  for (const [z, y, w, h, d] of segments) {
    blob(host, color, w, h, d, 0, y - sk.chestY, z - sk.chestZ);
  }
}

/**
 * Markings on both flanks, from `[y, z, width, height]` quads. They are thin
 * and sit just proud of the hide rather than floating in front of it, and each
 * gets its own size and a small roll so the hide never looks tiled.
 */
function patches(
  host: THREE.Object3D,
  sk: Skeleton,
  color: number,
  halfWidth: number,
  quads: readonly (readonly [number, number, number, number])[],
): void {
  quads.forEach(([y, z, w, h], i) => {
    for (const sx of [-1, 1]) {
      const spot = part(host, color, 0.04, h, w, sx * halfWidth, y - sk.chestY, z - sk.chestZ, 0.45);
      spot.scale.x = 0.6;
      // Barely any roll. Tilt a patch and one edge lifts off the hide, and
      // with its own ink line it reads as a tile glued on at an angle.
      spot.rotation.x = (i % 2 === 0 ? 1 : -1) * 0.07;
    }
  });
}

/**
 * Spine parts are written as plain height-off-the-floor and distance-ahead and
 * shifted onto the chest pivot here, so each species' layout reads as real
 * measurements instead of offsets from an invisible origin.
 */
function spineHelper(r: Rigging, sk: Skeleton) {
  return (
    color: number,
    w: number, h: number, d: number,
    y: number, z: number,
    soft = 0.24,
  ): THREE.Mesh => part(r.spine, color, w, h, d, 0, y - sk.chestY, z - sk.chestZ, soft);
}

/** Hinged floppy ears (dog). Returns the hinges for the gait flop. */
function floppyEars(
  host: THREE.Object3D,
  coat: number,
  inner: number,
  x: number, y: number, z: number,
  splay: number,
  w: number, h: number, d: number,
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * x, y, z);
    hinge.rotation.z = sx * splay;
    host.add(hinge);
    part(hinge, coat, w, h, d, 0, -h * 0.37, 0, 0.36);
    part(hinge, inner, w * 0.5, h * 0.45, d * 0.38, 0, -h * 0.45, d * 0.44, 0.4);
    out.push(hinge);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Species builders
// ---------------------------------------------------------------------------

// ---- 시바견 ---------------------------------------------------------------
function buildDog(r: Rigging): Built {
  const coat = 0xe2a356, cream = 0xf7e7cd, collar = 0xd9484f, nose = 0x2a2026;
  const sk: Skeleton = {
    chestY: 0.53, chestZ: 0.18, shoulderY: 0.46, legSpreadX: 0.15, legSpreadZ: 0.2,
    sitHipY: 0.28, sitLean: -0.45, stride: 0.5, cadence: 3.4, bob: 0.035,
  };
  const on = spineHelper(r, sk);
  legs(r, sk, coat, cream, 0.155, 0.165);

  // Barrel chest at the front, a tucked waist, a lighter rump — the taper is
  // the difference between an animal and a tube.
  torso(r.spine, sk, coat, [
    [0.15, 0.555, 0.405, 0.4, 0.38],
    [0.075, 0.55, 0.395, 0.39, 0.38],
    [0.0, 0.535, 0.37, 0.365, 0.38],
    [-0.075, 0.525, 0.35, 0.345, 0.38],
    [-0.15, 0.535, 0.365, 0.355, 0.38],
  ]);
  blob(r.spine, cream, 0.26, 0.13, 0.46, 0, 0.4 - sk.chestY, 0.02 - sk.chestZ); // belly
  // No chest patch: a pale brick on the chest front reads as a plaque bolted
  // on rather than fur. The muzzle, paws and tail tip carry the marking.
  on(coat, 0.2, 0.17, 0.18, 0.68, 0.28, 0.34); // neck — what lets the collar wrap
  on(collar, 0.24, 0.075, 0.22, 0.655, 0.285, 0.45);
  const tag = on(0xf9d71c, 0.075, 0.075, 0.04, 0.585, 0.37, 0.3);
  tag.rotation.z = Math.PI / 4;

  r.head.position.set(0, 0.74 - sk.chestY, 0.3 - sk.chestZ);
  part(r.head, coat, 0.3, 0.28, 0.26, 0, 0.09, 0.03, 0.28);
  part(r.head, cream, 0.17, 0.14, 0.17, 0, 0.03, 0.19, 0.36); // muzzle
  snoutNose(r.head, nose, 0.105, 0.072, 0.07, 0.072, 0.265);
  mouthLine(r.head, nose, 0.07, -0.025, 0.235);

  const eyeList: THREE.Object3D[] = [];
  eyes(r.head, eyeList, 0.088, 0.125, 0.165, 0.085);

  // Floppy ears, set BACK from the face: a pale inner ear at eye height and eye
  // brightness reads as a second pair of eyes from the front.
  const earList = floppyEars(r.head, coat, cream, 0.125, 0.21, -0.02, 0.3, 0.09, 0.19, 0.08);

  r.tail.position.set(0, 0.69 - sk.chestY, -0.3 - sk.chestZ);
  part(r.tail, coat, 0.1, 0.26, 0.1, 0, 0.13, 0, 0.4);
  part(r.tail, cream, 0.1, 0.1, 0.1, 0, 0.29, 0, 0.45);

  // Negative pitch sweeps the tail up and BACK. Positive lays it forward along
  // the spine, where the torso hides all but the tip and the dog looks tailless.
  return { skeleton: sk, eyes: eyeList, ears: earList, chain: [], tailPitch: -0.7, tailAmp: 0.34 };
}

// ---- 하얀 고양이 ----------------------------------------------------------
function buildCat(r: Rigging): Built {
  const coat = 0xf6f3ec, shade = 0xe3ddd0, pink = 0xf0a3ae, nose = 0x3a2a30;
  // Low and long. The first cat stood as tall as the dog on legs of the same
  // length and read as a rabbit; dropping the shoulder and stretching the
  // spine is half of what makes it a cat (the ears are the other half).
  const sk: Skeleton = {
    chestY: 0.4, chestZ: 0.15, shoulderY: 0.34, legSpreadX: 0.105, legSpreadZ: 0.19,
    sitHipY: 0.19, sitLean: -0.5, stride: 0.56, cadence: 4.0, bob: 0.03,
  };
  const on = spineHelper(r, sk);
  legs(r, sk, coat, coat, 0.105, 0.11);

  // A cat dips behind the shoulders and rises again at the haunches.
  torso(r.spine, sk, coat, [
    [0.15, 0.415, 0.275, 0.265, 0.3],
    [0.075, 0.41, 0.27, 0.255, 0.3],
    [0.0, 0.4, 0.25, 0.235, 0.3],
    [-0.075, 0.405, 0.25, 0.24, 0.3],
    [-0.15, 0.425, 0.272, 0.262, 0.3],
  ]);
  blob(r.spine, shade, 0.18, 0.09, 0.44, 0, 0.32 - sk.chestY, 0.02 - sk.chestZ);
  on(coat, 0.14, 0.13, 0.14, 0.5, 0.26, 0.36); // neck

  // ONE head shape and one small muzzle. The first cat had cheek tufts either
  // side and a muzzle ball half the size of the skull, and all those lumps
  // added up to a face that read as damaged rather than feline. A cat's head
  // is a circle; everything on it has to stay small.
  r.head.position.set(0, 0.55 - sk.chestY, 0.27 - sk.chestZ);
  part(r.head, coat, 0.26, 0.22, 0.21, 0, 0.075, 0.01, 0.42);
  blob(r.head, coat, 0.135, 0.085, 0.075, 0, 0.015, 0.115); // muzzle
  snoutNose(r.head, pink, 0.044, 0.033, 0.032, 0.048, 0.145);
  mouthLine(r.head, nose, 0.04, -0.005, 0.14);

  const eyeList: THREE.Object3D[] = [];
  // Smaller than they want to be. At 0.088 on a 0.26-wide head the eyes
  // covered the cheeks and the cat read as a startled plush.
  eyes(r.head, eyeList, 0.068, 0.108, 0.125, 0.052, 1.25);

  // Whiskers: bare rods (an outlined 1 cm rod is pure ink), anchored OUTSIDE
  // the muzzle and sweeping away from it. Long ones centred on the muzzle
  // skewer the face and come out the far cheek.
  for (const sx of [-1, 1]) {
    for (const [dy, tilt] of [[0.012, 0.16], [-0.016, -0.13]] as const) {
      const w = bare(0x5b5661, 0.085, 0.005, 0.005, sx * 0.105, 0.018 + dy, 0.1);
      w.rotation.z = sx * tilt;
      r.head.add(w);
    }
  }

  // A SQUARE TURNED 45°, half-buried in the skull: the visible part is a
  // triangle, which is the only way to get a point out of a rounded box. Two
  // earlier tries failed — a tall narrow box is a rabbit's ear, and a wide
  // brick with a narrower one stacked on it reads as two jar lids.
  const earList: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * 0.091, 0.098, -0.012);
    hinge.rotation.z = sx * 0.3; // leaned out to the sides
    r.head.add(hinge);
    // Sunk half into the skull. With the thin ink line the diamond no longer
    // fuses to the head visually, so the overlap has to be real or the ears
    // read as two paper cut-outs balanced on top.
    const ear = part(hinge, coat, 0.125, 0.125, 0.06, 0, 0.045, 0, 0.14);
    ear.rotation.z = Math.PI / 4;
    // Up near the point and shallow, so the pink stays inside the visible
    // triangle instead of poking out along the buried lower edge.
    const inner = part(hinge, pink, 0.046, 0.046, 0.022, 0, 0.072, 0.028, 0.18);
    inner.rotation.z = Math.PI / 4;
    earList.push(hinge);
  }

  // Long and whippy, carried high in a question mark. It has to be a CURVE: a
  // couple of long straight pieces on one hinge reads as a radio aerial with
  // an elbow in it, which is what the first cat wore. Five short overlapping
  // links, each adding a little pitch, bend it smoothly from the rump up and
  // over — and because they overlap there is no gap at any joint.
  r.tail.position.set(0, 0.5 - sk.chestY, -0.3 - sk.chestZ);
  let link: THREE.Object3D = r.tail;
  const BEND = [0, 0.26, 0.3, 0.32, 0.34];
  for (let i = 0; i < BEND.length; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, i === 0 ? 0 : 0.085, 0);
    seg.rotation.x = BEND[i]!;
    link.add(seg);
    const w = 0.072 - i * 0.004;
    part(seg, coat, w, 0.115, w, 0, 0.05, 0, 0.5);
    link = seg;
  }
  part(link, shade, 0.065, 0.085, 0.065, 0, 0.115, 0, 0.5); // pale tip

  return { skeleton: sk, eyes: eyeList, ears: earList, chain: [], tailPitch: -0.95, tailAmp: 0.4 };
}

// ---- 아기 코끼리 ----------------------------------------------------------
function buildElephant(r: Rigging): Built {
  const coat = 0x9aa3b2, shade = 0x7f8897, ivory = 0xf6f1e2, nose = 0x4a4a55;
  const sk: Skeleton = {
    chestY: 0.95, chestZ: 0.2, shoulderY: 0.86, legSpreadX: 0.28, legSpreadZ: 0.33,
    sitHipY: 0.5, sitLean: -0.32, stride: 0.34, cadence: 2.4, bob: 0.03,
  };
  const on = spineHelper(r, sk);
  // Pillar legs: thick, barely tapered, wide apart. Thin legs under this body
  // read as a grey cow.
  legs(r, sk, coat, shade, 0.28, 0.3);

  torso(r.spine, sk, coat, [
    [0.26, 0.96, 0.72, 0.64, 0.64],
    [0.13, 0.98, 0.76, 0.68, 0.64],
    [0.0, 0.975, 0.775, 0.69, 0.64], // widest amidships, like a barrel
    [-0.13, 0.955, 0.74, 0.66, 0.64],
    [-0.26, 0.935, 0.68, 0.61, 0.62],
  ]);
  blob(r.spine, shade, 0.52, 0.2, 0.78, 0, 0.68 - sk.chestY, 0.02 - sk.chestZ);
  on(coat, 0.4, 0.3, 0.3, 1.26, 0.38, 0.32); // neck hump

  r.head.position.set(0, 1.3 - sk.chestY, 0.45 - sk.chestZ);
  part(r.head, coat, 0.52, 0.48, 0.42, 0, 0.12, 0.02, 0.3);
  part(r.head, coat, 0.38, 0.2, 0.12, 0, 0.3, 0.14, 0.4); // domed brow

  const eyeList: THREE.Object3D[] = [];
  eyes(r.head, eyeList, 0.17, 0.14, 0.25, 0.105);

  // Tusks hang from under the cheeks, splay OUT past the trunk, and curl
  // forward. They have to clear the trunk's silhouette — tucked in tight
  // against it they vanish into the same grey mass, and angled upward beside
  // it they read as a pair of little horns.
  for (const sx of [-1, 1]) {
    const tusk = part(r.head, ivory, 0.06, 0.22, 0.06, sx * 0.235, -0.2, 0.16, 0.45);
    tusk.rotation.set(-0.28, 0, sx * 0.3);
    part(tusk, ivory, 0.054, 0.12, 0.054, 0, -0.14, 0.05, 0.48); // curled point
  }

  // THE TRUNK. Four hinged segments, each parented to the last, so the wave in
  // `update` travels down it. One rigid cone would read as a pipe — and so
  // does an evenly-curled chain: the rest angles are small at the top and
  // large at the tip, which hangs the trunk and curls only its end, instead of
  // lifting the whole thing into a horizontal spout.
  const CURL = [-0.1, -0.15, -0.35, -0.55];
  const chain: THREE.Object3D[] = [];
  let anchor: THREE.Object3D = r.head;
  let y = -0.06, z = 0.2;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.Group();
    seg.position.set(0, y, z);
    const rest = CURL[i]!;
    seg.rotation.x = rest;
    CHAIN_REST.set(seg, rest);
    anchor.add(seg);
    const w = 0.2 - i * 0.03;
    part(seg, i === 3 ? shade : coat, w, 0.16, w, 0, -0.08, 0, 0.42);
    chain.push(seg);
    anchor = seg;
    y = -0.16;
    z = 0;
  }
  blob(anchor, nose, 0.1, 0.05, 0.1, 0, -0.17, 0); // nostril tip

  // Fan ears. The sweep angle is the whole game and both extremes fail: edge
  // on to the camera (swept hard back) they are flat slabs behind the skull,
  // and square to it they are solar panels bolted to the sides. A quarter turn
  // back shows the fan's face while keeping it attached to the head.
  const earList: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * 0.21, 0.16, -0.04);
    hinge.rotation.set(0.1, sx * 0.28, sx * -0.4); // droop, or they are wings
    r.head.add(hinge);
    // Three overlapping plates tapering downward, so the fan has a droop and a
    // lobe rather than being one rectangle.
    part(hinge, coat, 0.34, 0.3, 0.075, sx * 0.15, 0.1, 0, 0.5);
    part(hinge, coat, 0.3, 0.22, 0.075, sx * 0.14, -0.1, 0, 0.5);
    part(hinge, coat, 0.2, 0.16, 0.075, sx * 0.12, -0.26, 0, 0.5);
    // A soft inner shadow, not a crisp inset plate: a rectangle inside a
    // rectangle is what made the first ears read as solar panels.
    blob(hinge, shade, 0.22, 0.3, 0.03, sx * 0.15, 0.02, 0.042);
    // A lump where the fan meets the skull, so the ear is attached rather than
    // hovering beside the head with daylight behind it.
    part(hinge, coat, 0.1, 0.26, 0.16, sx * 0.02, 0.02, 0, 0.5);
    earList.push(hinge);
  }

  r.tail.position.set(0, 1.08 - sk.chestY, -0.48 - sk.chestZ);
  part(r.tail, coat, 0.08, 0.3, 0.08, 0, -0.15, 0, 0.45);
  part(r.tail, shade, 0.1, 0.1, 0.06, 0, -0.32, 0, 0.45); // tuft

  // Tail hangs DOWN — an elephant's does not stick up like a dog's.
  return { skeleton: sk, eyes: eyeList, ears: earList, chain, tailPitch: 0.1, tailAmp: 0.3 };
}

// ---- 아기 기린 ------------------------------------------------------------
function buildGiraffe(r: Rigging): Built {
  const coat = 0xf0c470, patch = 0xa9713a, cream = 0xfaeccd, nose = 0x4a382c;
  const sk: Skeleton = {
    chestY: 0.95, chestZ: 0.18, shoulderY: 0.88, legSpreadX: 0.2, legSpreadZ: 0.28,
    sitHipY: 0.5, sitLean: -0.3, stride: 0.46, cadence: 2.8, bob: 0.04,
  };
  legs(r, sk, coat, cream, 0.175, 0.185);

  // The back SLOPES: withers high over the shoulder, rump a hand lower. That
  // slope is most of what says "giraffe" below the neck.
  torso(r.spine, sk, coat, [
    [0.2, 1.025, 0.455, 0.5, 0.42],
    [0.1, 1.01, 0.46, 0.48, 0.42],
    [0.0, 0.985, 0.445, 0.455, 0.42],
    [-0.1, 0.955, 0.425, 0.43, 0.42],
    [-0.2, 0.93, 0.4, 0.405, 0.4],
  ]);
  blob(r.spine, cream, 0.32, 0.15, 0.56, 0, 0.76 - sk.chestY, 0.02 - sk.chestZ);
  patches(r.spine, sk, patch, 0.214, [
    [1.09, 0.2, 0.2, 0.16], [1.07, -0.08, 0.17, 0.19], [1.05, -0.3, 0.16, 0.15],
    [0.88, 0.28, 0.15, 0.14], [0.86, 0.02, 0.19, 0.17], [0.84, -0.24, 0.16, 0.16],
    [1.18, 0.06, 0.14, 0.12],
  ]);

  // THE NECK — the silhouette, and the thing that has to be right. It is its
  // own raked group: giraffe necks lean FORWARD about 20°, and a vertical
  // column reads as a chimney. Three overlapping segments, so the ink outline
  // never shows a seam where two boxes butt together.
  const neck = new THREE.Group();
  neck.position.set(0, 1.18 - sk.chestY, 0.26 - sk.chestZ);
  neck.rotation.x = -0.34;
  r.spine.add(neck);
  part(neck, coat, 0.27, 0.42, 0.27, 0, 0.18, 0, 0.3);
  part(neck, coat, 0.245, 0.4, 0.245, 0, 0.5, 0, 0.3);
  part(neck, coat, 0.22, 0.36, 0.22, 0, 0.8, 0, 0.3);
  for (const [ny, pw] of [[0.06, 0.13], [0.26, 0.12], [0.46, 0.13], [0.66, 0.11], [0.86, 0.1]] as const) {
    for (const sx of [-1, 1]) {
      const spot = part(neck, patch, 0.04, pw, pw, sx * 0.126, ny, 0.02, 0.45);
      spot.scale.x = 0.65;
    }
  }
  // Mane: a dense comb down the BACK of the neck, inside the neck group so it
  // follows the rake. It must sit PROUD of the neck — at the neck's own half
  // depth it is buried inside it and the giraffe looks shaved — and the combs
  // must overlap, because spaced ones read as warts.
  for (let i = 0; i < 11; i++) {
    part(neck, patch, 0.08, 0.1, 0.09, 0, i * 0.096, -0.165, 0.45);
  }

  // The head rides the neck, so it keeps the rake instead of floating above it.
  r.head.position.set(0, 1.04, 0.02);
  neck.add(r.head);
  part(r.head, coat, 0.23, 0.2, 0.25, 0, 0.06, 0.03, 0.3);
  part(r.head, cream, 0.16, 0.14, 0.19, 0, -0.005, 0.19, 0.38); // long snout
  snoutNose(r.head, nose, 0.042, 0.032, 0.04, 0.03, 0.265, -0.04); // nostrils
  snoutNose(r.head, nose, 0.042, 0.032, 0.04, 0.03, 0.265, 0.04);
  mouthLine(r.head, nose, 0.085, -0.045, 0.245);

  const eyeList: THREE.Object3D[] = [];
  eyes(r.head, eyeList, 0.09, 0.1, 0.155, 0.072);

  // Ossicones — the little knobbed horns. Without these it is a llama.
  for (const sx of [-1, 1]) {
    const stalk = part(r.head, coat, 0.042, 0.11, 0.042, sx * 0.058, 0.21, 0.0, 0.45);
    part(stalk, patch, 0.072, 0.058, 0.072, 0, 0.075, 0, 0.45);
  }
  // Small side ears, hinged so they flick.
  const earList: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * 0.1, 0.14, -0.01);
    hinge.rotation.z = sx * 0.5;
    r.head.add(hinge);
    part(hinge, coat, 0.11, 0.07, 0.05, sx * 0.05, 0.01, 0, 0.4);
    earList.push(hinge);
  }

  r.tail.position.set(0, 1.12 - sk.chestY, -0.38 - sk.chestZ);
  part(r.tail, coat, 0.06, 0.3, 0.06, 0, -0.15, 0, 0.45);
  part(r.tail, patch, 0.07, 0.11, 0.07, 0, -0.33, 0, 0.45);

  return { skeleton: sk, eyes: eyeList, ears: earList, chain: [], tailPitch: 0.1, tailAmp: 0.34 };
}

// ---- 판다 -----------------------------------------------------------------
function buildPanda(r: Rigging): Built {
  const coat = 0xf7f4ee, ink = 0x2c2a2e, nose = 0x221f24;
  const sk: Skeleton = {
    chestY: 0.5, chestZ: 0.16, shoulderY: 0.38, legSpreadX: 0.2, legSpreadZ: 0.22,
    sitHipY: 0.2, sitLean: -0.5, stride: 0.38, cadence: 2.8, bob: 0.03,
  };
  const on = spineHelper(r, sk);
  // Short, tucked limbs. The first pass gave it tall posts and the panda stood
  // on four black pillars like a table.
  legs(r, sk, ink, ink, 0.2, 0.215);

  // Round and wide — a panda is a ball with limbs. The black is the FRONT of
  // that one body, not a mass bolted onto it: same width, same height, same
  // corner rounding, a hair larger so it wins the z-fight, and its front face
  // lands exactly on the body's. Any of those four wrong and the panda reads
  // as a white box with a black box stuck to the chest.
  // A panda is a ball with limbs, and its black is the FRONT of that ball —
  // so the dark lumps are part of the same chain and their edge falls as a
  // curve across the body instead of a brick's flat face.
  torso(r.spine, sk, ink, [
    [0.15, 0.525, 0.555, 0.52, 0.46],
    [0.075, 0.535, 0.575, 0.545, 0.46],
  ]);
  torso(r.spine, sk, coat, [
    [0.0, 0.535, 0.57, 0.54, 0.46],
    [-0.075, 0.525, 0.545, 0.515, 0.46],
    [-0.15, 0.505, 0.5, 0.475, 0.44],
  ]);
  on(coat, 0.26, 0.17, 0.2, 0.78, 0.2, 0.4); // neck

  r.head.position.set(0, 0.84 - sk.chestY, 0.2 - sk.chestZ);
  part(r.head, coat, 0.42, 0.37, 0.34, 0, 0.11, 0.02, 0.36); // big round head, front face at z 0.19
  // Muzzle and nose are smooth lumps. As outlined bricks they drew a hard ring
  // on the face and read as a snout pasted on.
  blob(r.head, coat, 0.2, 0.15, 0.14, 0, 0.035, 0.195);
  snoutNose(r.head, nose, 0.095, 0.062, 0.06, 0.08, 0.245);
  mouthLine(r.head, nose, 0.07, 0.025, 0.235);

  // The eye patches ARE the panda, and three things about them are load-bearing:
  //
  // - They are LUMPS, not bricks. As outlined slabs they were a pair of
  //   spectacle frames sitting on the face, wider than the skull itself.
  // - They slant DOWN AND OUT toward the cheeks. Tilted the other way the
  //   outer edge lifts into a scowl and the panda reads as a villain.
  // - The eye must stand clearly PROUD of the patch. Parked at the same depth
  //   the two surfaces interleave and the face fills with z-fighting stripes.
  const eyeList: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const blot = blob(r.head, ink, 0.175, 0.135, 0.1, sx * 0.1, 0.14, 0.16);
    blot.rotation.z = sx * -0.38;
  }
  // Small, so the eye sits inside its patch instead of punching a white window
  // through it — and only JUST forward of the patch. Pushed further out it
  // leaves the skull entirely (the face ends at z 0.19) and the eyes hang off
  // the silhouette in profile like a pair of headlights.
  eyes(r.head, eyeList, 0.1, 0.142, 0.206, 0.048);

  // Round black ears, high and wide.
  const earList: THREE.Object3D[] = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * 0.16, 0.26, -0.02);
    r.head.add(hinge);
    part(hinge, ink, 0.15, 0.14, 0.09, 0, 0.04, 0, 0.48);
    earList.push(hinge);
  }

  r.tail.position.set(0, 0.62 - sk.chestY, -0.3 - sk.chestZ);
  part(r.tail, coat, 0.11, 0.1, 0.08, 0, 0.0, 0, 0.48); // a stub

  return { skeleton: sk, eyes: eyeList, ears: earList, chain: [], tailPitch: 0.2, tailAmp: 0.18 };
}

const BUILDERS: Record<PetSpecies, (r: Rigging) => Built> = {
  dog: buildDog,
  cat: buildCat,
  elephant: buildElephant,
  giraffe: buildGiraffe,
  panda: buildPanda,
};
