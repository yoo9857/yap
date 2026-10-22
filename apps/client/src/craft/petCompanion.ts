import type * as THREE from "three";
import { CreatureRig, SPECIES, type PetSpecies } from "../player/creatureRig.js";
import {
  createPetBrain,
  thinkPet,
  togglePetMode,
  type PetBrain,
  type PetMode,
  type PetSense,
} from "../player/pet.js";
import { stepBody, unstick, type Body } from "./voxelBody.js";
import { surfaceY, type VoxelWorld } from "./voxelWorld.js";

/**
 * The pet that tags along in Craft Island and the education field: the pure
 * brain (`player/pet.ts`) bolted to the voxel sweep and a `CreatureRig`.
 *
 * It is a `Body` like the player, with the adopted species' own footprint,
 * which buys two things for free: it cannot pass through anything the player
 * cannot, and it falls, slides and lands under exactly the same rules. The one
 * privilege it has is recall — when the brain gives up (`TELEPORT_DIST`, or a
 * long spell of getting nowhere), we place it on solid ground near the owner
 * rather than leave it stranded behind a wall.
 *
 * Fixed-tick physics, variable-rate rendering, mirroring how the player is
 * driven — the rig's gait must follow real frame time or it stutters.
 */
export class PetCompanion {
  readonly body: Body;
  private rig: CreatureRig;
  private readonly brain: PetBrain;
  private readonly scene: THREE.Scene;
  /** Whether the pet was on the ground last tick, so landings can squash. */
  private wasGrounded = true;

  constructor(
    scene: THREE.Scene,
    world: VoxelWorld,
    spawn: { x: number; y: number; z: number },
    species: PetSpecies = "dog",
  ) {
    this.scene = scene;
    this.rig = new CreatureRig(species);
    scene.add(this.rig.root);
    const info = SPECIES[this.rig.species];
    this.body = {
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      vx: 0,
      vy: 0,
      vz: 0,
      grounded: false,
      w: info.bodyWidth,
      h: info.bodyHeight,
      jumpSpeed: info.jumpSpeed,
    };
    unstick(world, this.body);
    this.brain = createPetBrain();
  }

  get species(): PetSpecies {
    return this.rig.species;
  }

  get mode(): PetMode {
    return this.brain.mode;
  }

  /** Read-only view of the brain, for the E2E harness. */
  get debug(): { blocked: number; noGain: number; chasing: boolean; anim: string; side: number } {
    return {
      blocked: this.brain.blocked,
      noGain: this.brain.noGain,
      chasing: this.brain.chasing,
      anim: this.brain.anim,
      side: this.brain.sideSign,
    };
  }

  /**
   * Adopt a different animal. The brain, the position and the follow mode all
   * carry over — only the collider and the model change, so swapping mid-walk
   * looks like the new pet was always the one following you. Bodies are
   * feet-centred, so a taller animal can end up overlapping a ceiling;
   * `unstick` lifts it clear rather than letting it wedge.
   */
  adopt(world: VoxelWorld, species: PetSpecies): void {
    if (!SPECIES[species] || species === this.rig.species) return;
    const visible = this.rig.root.visible;
    this.rig.dispose();
    this.rig = new CreatureRig(species);
    this.rig.root.visible = visible;
    this.scene.add(this.rig.root);
    const info = SPECIES[species];
    this.body.w = info.bodyWidth;
    this.body.h = info.bodyHeight;
    this.body.jumpSpeed = info.jumpSpeed;
    unstick(world, this.body);
    this.rig.pop(3); // a little "hello" squash on arrival
  }

  /** Sit/stay ↔ follow. Returns the new mode so the caller can toast it. */
  toggleMode(): PetMode {
    return togglePetMode(this.brain);
  }

  fixedUpdate(world: VoxelWorld, dt: number, owner: { x: number; y: number; z: number }): void {
    const cmd = thinkPet(this.brain, this.body, owner, dt, this.senseAhead(world, owner));
    if (cmd.teleport) {
      this.recall(world, owner);
      return;
    }
    // `pace` scales the wish vector, which `stepBody` turns into speed — so a
    // cat darts and an elephant lumbers without either needing its own physics
    // path, and the brain stays species-blind.
    const pace = SPECIES[this.rig.species].pace;
    stepBody(world, this.body, dt, cmd.wishX * pace, cmd.wishZ * pace, cmd.jump);
    // Gentle, and never both in the same breath. A hop followed a few ticks
    // later by its own landing used to kick the squash spring twice and the
    // pet shivered through the whole arc.
    if (cmd.jump) this.rig.pop(1.5);
    else if (this.body.grounded && !this.wasGrounded) this.rig.pop(2.4); // landing
    this.wasGrounded = this.body.grounded;

    // Fell down a hole or off the edge: come back rather than drown offscreen.
    if (this.body.y < -12) this.recall(world, owner);
  }

  /**
   * Is there a one-block step right in front of us, on the way to the owner?
   * Probed just past the pet's own footprint, at ankle height, with the cells
   * above required to be clear — a two-block wall is not something to hop at,
   * and hopping into it would just rattle the animal against the face of it.
   */
  private senseAhead(world: VoxelWorld, owner: { x: number; z: number }): PetSense {
    if (!this.body.grounded) return { stepAhead: false };
    const dx = owner.x - this.body.x;
    const dz = owner.z - this.body.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.4) return { stepAhead: false };
    const reach = (this.body.w ?? 0.5) / 2 + 0.25;
    const px = this.body.x + (dx / len) * reach;
    const pz = this.body.z + (dz / len) * reach;
    const foot = Math.floor(this.body.y + 0.1);
    const solid = (y: number): boolean => world.isSolid(Math.floor(px), y, Math.floor(pz));
    // Headroom scales with the animal: a giraffe hopping onto a step needs a
    // whole neck's worth of clear air above it, a cat needs one cell.
    const headroom = Math.ceil(this.body.h ?? 1);
    for (let i = 1; i <= headroom; i++) if (solid(foot + i)) return { stepAhead: false };
    return { stepAhead: solid(foot) };
  }

  /**
   * Drop the pet onto solid ground a short step behind the owner. Behind, not
   * on top: landing in the player's face is the one placement that always
   * reads as a glitch. `unstick` then guarantees it is never left embedded.
   */
  private recall(world: VoxelWorld, owner: { x: number; y: number; z: number }): void {
    const x = owner.x + 1.2;
    const z = owner.z + 1.2;
    this.body.x = x;
    this.body.z = z;
    this.body.y = Math.max(owner.y, surfaceY(world, Math.floor(x), Math.floor(z)) + 1);
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.body.grounded = false;
    unstick(world, this.body);
    // A recall is a fresh start: the attempt that failed must not be held
    // against the new position, or the pet recalls again a tick later.
    this.brain.blocked = 0;
    this.brain.noGain = 0;
    this.brain.bestDist = Number.POSITIVE_INFINITY;
    this.brain.lastX = this.body.x;
    this.brain.lastZ = this.body.z;
  }

  /** The education field scrolled its voxel window — move with it. The brain
   *  needs no fixing up: it tracks distance to the owner, and the owner
   *  shifted by the same amount. */
  shift(dx: number, dz: number): void {
    this.body.x -= dx;
    this.body.z -= dz;
    this.brain.lastX -= dx;
    this.brain.lastZ -= dz;
  }

  render(frameDt: number): void {
    this.rig.root.position.set(this.body.x, this.body.y, this.body.z);
    // Ease the turn: snapping yaw to the brain's bearing makes the pet pivot
    // like a turret every time the owner strafes.
    let delta = this.brain.yaw - this.rig.root.rotation.y;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.rig.root.rotation.y += delta * Math.min(1, frameDt * 9);
    this.rig.update(this.brain.anim, Math.hypot(this.body.vx, this.body.vz), frameDt);
  }

  setVisible(visible: boolean): void {
    this.rig.root.visible = visible;
  }

  dispose(): void {
    this.rig.dispose();
  }
}
