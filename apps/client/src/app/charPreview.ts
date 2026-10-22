import * as THREE from "three";
import { CharacterRig, VARIANT_CYCLE, preloadCharacter } from "../player/rig.js";
import { CreatureRig, PET_SPECIES } from "../player/creatureRig.js";
import type { AnimState } from "@robo/shared";
import type { PetAnim } from "../player/pet.js";
import { HULL_LAYER, InkOutline } from "../render/inkOutline.js";

/**
 * Dev-only character turntable (`?preview=char`): the cube mascots in a back
 * row with every adoptable pet in front, facing the camera, slowly rotating,
 * cycling through their animations — so the blocky rigs can be reviewed without
 * driving a whole game mode. They share one stage on purpose: coats,
 * proportions and ink weight only look wrong next to each other, and a species
 * that has drifted off-model is invisible in isolation.
 *
 * `tools/shot-pets.mjs` drives the `pinPets` / `solo` hooks at the bottom.
 */
export async function bootCharPreview(mount: HTMLElement): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);
  // The turntable runs the same ink pass the game does, or it would be
  // reviewing a different picture from the one players see.
  const ink = renderer.capabilities.isWebGL2
    && new URLSearchParams(location.search).get("ink") !== "0"
    ? new InkOutline(renderer)
    : null;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfbf7ee);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.5, 5.2);
  camera.lookAt(0, 1.0, 0);
  if (!ink) camera.layers.enable(HULL_LAYER);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.0);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(12, 64),
    new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  await preloadCharacter();

  const rigs = VARIANT_CYCLE.map((v, i) => {
    const rig = new CharacterRig(v);
    rig.root.position.set((i - 1) * 1.7, 0, 0);
    scene.add(rig.root); // face (+z) already points at the +z camera
    return rig;
  });

  // The pets stand in a row in front of the mascots, spaced for the widest of
  // them so a giraffe and a cat can share a lineup without overlapping.
  const petHome = new Map<CreatureRig, number>();
  const pets = PET_SPECIES.map((key, i) => {
    const pet = new CreatureRig(key);
    const x = (i - (PET_SPECIES.length - 1) / 2) * 2.1;
    pet.root.position.set(x, 0, 1.8);
    petHome.set(pet, x);
    scene.add(pet.root);
    return pet;
  });

  const forced = new URLSearchParams(location.search).get("anim") as AnimState | null;
  const cycle: AnimState[] = forced ? [forced] : ["idle", "run", "jump", "fall", "idle"];
  /** The pets' vocabulary differs (walk/sit instead of one run), so the
   *  turntable maps the shared cycle onto it rather than inventing a second. */
  const PET_ANIM: Record<string, PetAnim> = {
    idle: "sit", run: "run", jump: "jump", fall: "fall", carry: "walk", place: "idle", dead: "idle",
  };
  /** Screenshot seam, same idea as the builder's `pinShot()`: hold one pose and
   *  one heading so a shot is reproducible instead of whatever frame landed. */
  let pin: { anim: PetAnim; yaw: number } | null = null;
  let last = performance.now();
  let acc = 0;
  let step = 0;
  const clock = { t: 0 };

  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock.t += dt;
    acc += dt;
    if (acc > 1.6) {
      acc = 0;
      step = (step + 1) % cycle.length;
      if (cycle[step] === "jump") {
        for (const r of rigs) r.pop(7);
        for (const p of pets) p.pop(4);
      }
    }
    const anim = cycle[step]!;
    for (const r of rigs) {
      r.root.rotation.y = Math.sin(clock.t * 0.5) * 0.6; // gentle turntable around front
      r.update(anim, anim === "run" ? 6 : 0, dt);
    }
    const petAnim = pin ? pin.anim : PET_ANIM[anim] ?? "idle";
    const petSpeed = petAnim === "run" ? 5 : petAnim === "walk" ? 2.4 : 0;
    for (const p of pets) {
      p.root.rotation.y = pin ? pin.yaw : Math.sin(clock.t * 0.5) * 0.6;
      p.update(petAnim, petSpeed, dt);
    }
    if (ink) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      ink.setSize(size.x, size.y);
      ink.render(renderer, scene, camera);
    } else {
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  (window as unknown as Record<string, unknown>).__charPreview = {
    rigs,
    pets,
    camera,
    scene,
    cycle: () => (step = (step + 1) % 5),
    pinPets: (petAnim: PetAnim | null, yaw = 0) => (pin = petAnim ? { anim: petAnim, yaw } : null),
    /** Show one species centred (or `null` to restore the whole lineup). */
    solo: (key: string | null) => {
      for (const p of pets) {
        p.root.visible = key === null || p.species === key;
        p.root.position.x = key === null ? petHome.get(p)! : 0;
      }
      for (const r of rigs) r.root.visible = key === null;
    },
  };
}
