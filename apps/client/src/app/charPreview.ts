import * as THREE from "three";
import { CharacterRig, VARIANT_CYCLE, preloadCharacter } from "../player/rig.js";
import type { AnimState } from "@robo/shared";

/**
 * Dev-only character turntable (`?preview=char`): the mascot variants side by
 * side, facing the camera, slowly rotating, cycling through their animations —
 * so the blocky rigs can be reviewed without driving a whole game mode.
 */
export async function bootCharPreview(mount: HTMLElement): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfbf7ee);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.5, 5.2);
  camera.lookAt(0, 1.0, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a0, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.0);
  sun.position.set(3, 6, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
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

  const forced = new URLSearchParams(location.search).get("anim") as AnimState | null;
  const cycle: AnimState[] = forced ? [forced] : ["idle", "run", "jump", "fall", "idle"];
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
      if (cycle[step] === "jump") for (const r of rigs) r.pop(7);
    }
    const anim = cycle[step]!;
    for (const r of rigs) {
      r.root.rotation.y = Math.sin(clock.t * 0.5) * 0.6; // gentle turntable around front
      r.update(anim, anim === "run" ? 6 : 0, dt);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  (window as unknown as Record<string, unknown>).__charPreview = { rigs, cycle: () => (step = (step + 1) % 5) };
}
