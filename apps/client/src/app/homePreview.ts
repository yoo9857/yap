import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { INK_LAYER, InkOutline } from "../render/inkOutline.js";
import { loadTexture, warmupGpuAsync } from "../render/textures.js";

/** Local art-review entry. Uses the project's renderer/ink/texture conventions. */
export async function bootHomePreview(mount: HTMLElement): Promise<void> {
  const status = document.getElementById("home-status");
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mount.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf8f4e9);
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 100);
  camera.position.set(3.2, 3.8, 5.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.73, 0);
  controls.enableDamping = true;
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.48;
  const ink = new InkOutline(renderer);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x788d72, 1.4);
  hemi.layers.enableAll();
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff5dd, 2.4);
  sun.position.set(3, 7, 4);
  sun.layers.enableAll();
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -5;
  sun.shadow.camera.right = sun.shadow.camera.top = 5;
  sun.shadow.normalBias = 0.015;
  scene.add(sun);
  const floorGeo = new THREE.PlaneGeometry(16, 16);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xd6dfc4, roughness: 1 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.008;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(12, 24, 0xb6c3a5, 0xc3cfb5);
  grid.position.y = -0.006;
  scene.add(grid);
  const expressionNames = ["neutral", "blink", "happy", "hurt", "oh", "dead"] as const;
  type Expression = typeof expressionNames[number];
  const [gltf, loadedTextures] = await Promise.all([
    new GLTFLoader().loadAsync("/models/home/home-v4.glb"),
    Promise.all(expressionNames.map((name) => loadTexture(`/textures/char/home/face-mascot-${name}.png`))),
  ]);
  const textures = new Map<Expression, THREE.Texture>();
  loadedTextures.forEach((tex, index) => {
    if (!tex) throw new Error(`Missing HOME face: ${expressionNames[index]}`);
    tex.flipY = false; // glTF UV convention; URLs belong only to this atlas.
    tex.needsUpdate = true;
    textures.set(expressionNames[index]!, tex);
  });
  const model = gltf.scene;
  scene.add(model);
  const materials = new Set<THREE.MeshStandardMaterial>();
  const embeddedMaps = new Set<THREE.Texture>();
  model.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.layers.enable(INK_LAYER); // project's INK_LAYER: one silhouette around the character.
    node.castShadow = true;
    node.receiveShadow = true;
    node.frustumCulled = false;
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of mats) if (material instanceof THREE.MeshStandardMaterial) {
      if (material.map) embeddedMaps.add(material.map);
      material.map = textures.get("neutral")!;
      material.roughness = 0.95;
      material.metalness = 0;
      material.needsUpdate = true;
      materials.add(material);
    }
  });
  for (const map of embeddedMaps) map.dispose();
  let triangles = 0;
  const referenceSpeed = { Walk: 0.23 / (0.8 * 0.62), Run: 0.34 / (0.6 * 0.4) };
  model.traverse((node) => {
    if (node instanceof THREE.Mesh) { const geometry = node.geometry as THREE.BufferGeometry; triangles += (geometry.index?.count ?? geometry.attributes.position!.count) / 3; }
    if (typeof node.userData.walk_reference_speed === "number") referenceSpeed.Walk = node.userData.walk_reference_speed;
    if (typeof node.userData.run_reference_speed === "number") referenceSpeed.Run = node.userData.run_reference_speed;
  });
  const mixer = new THREE.AnimationMixer(model);
  const actions = new Map(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
  const motion = document.getElementById("home-motion") as HTMLSelectElement;
  const expression = document.getElementById("home-expression") as HTMLSelectElement;
  const pause = document.getElementById("home-pause") as HTMLButtonElement;
  const orbit = document.getElementById("home-turntable") as HTMLInputElement;
  const playback = document.getElementById("home-speed") as HTMLInputElement;
  const speedLabel = document.getElementById("home-speed-label")!;
  const travel = document.getElementById("home-travel") as HTMLInputElement;
  const follow = document.getElementById("home-follow") as HTMLInputElement;
  const velocity = new THREE.Vector3();
  const targetVelocity = new THREE.Vector3();
  const followDelta = new THREE.Vector3();
  const followTarget = new THREE.Vector3();
  let demoAngle = 0;
  let movementMotion: "Walk" | "Run" = "Walk";
  let flightVelocity = 0;
  let flightActive = false;
  let landing = 0;
  function jumpTest(): void {
    if (flightActive || paused) return;
    flightActive = true; flightVelocity = 7.2; landing = 0;
    motion.value = "Idle"; idleVariant = "Idle"; idleTimer = 5.8;
  }
  document.getElementById("home-jump")?.addEventListener("click", jumpTest);
  let current: THREE.AnimationAction | undefined;
  let paused = false;
  let alive = true;
  let selectedExpression = "auto";
  let blinkClock = 0;
  let blinkDuration = 0;
  let blinkDelay = 3.7;
  let blinkIndex = 0;
  const blinkIntervals = [4.3, 0.28, 5.1, 3.3, 3.7];
  let idleVariant = "Idle";
  let idleTimer = 5.8;
  let idleIndex = 0;
  function nextIdle(dt: number): string {
    idleTimer -= dt;
    if (idleTimer <= 0) {
      if (idleVariant === "Idle") {
        idleVariant = idleIndex++ % 2 === 0 ? "IdleLook" : "IdleShift";
        idleTimer = actions.get(`HOME_${idleVariant}`)?.getClip().duration ?? 3.6;
      } else {
        idleVariant = "Idle";
        idleTimer = 6.2 + Math.random() * 3;
      }
    }
    return idleVariant;
  }
  let last = performance.now();
  let raf = 0;
  const size = new THREE.Vector2();
  const keys = new Set<string>();
  const motionLabels: Record<string, string> = { Idle: "Relaxed idle", IdleShift: "Idle · shifting weight", IdleLook: "Idle · looking around", Walk: "Walking", Run: "Running", Wave: "Waving", Jump: "Jumping", Fall: "Falling", Land: "Landing", Carry: "Carrying", Hold: "Holding", Place: "Placing", Sit: "Sitting" };
  function setMotion(name: string): void {
    const next = actions.get(`HOME_${name}`) ?? actions.get("HOME_Idle");
    if (!next || next === current) return;
    const phase = current ? current.time / current.getClip().duration : 0;
    const wasGait = current?.getClip().name === "HOME_Walk" || current?.getClip().name === "HOME_Run";
    const transition = current ? (name.startsWith("Idle") ? 0.35 : 0.2) : 0;
    current?.fadeOut(transition);
    next.reset();
    if (wasGait && (name === "Walk" || name === "Run")) next.time = phase * next.getClip().duration;
    next.setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (transition > 0) next.fadeIn(transition);
    current = next;
    if (status) status.textContent = `${motionLabels[name] ?? name} · WASD to move · Shift to run`;
  }
  function setExpression(name: Expression): void {
    const map = textures.get(name)!;
    for (const material of materials) if (material.map !== map) material.map = map;
  }
  function keyDown(e: KeyboardEvent): void {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat) jumpTest(); return; }
    if (["w", "a", "s", "d", "shift"].includes(e.key.toLowerCase())) keys.add(e.key.toLowerCase());
  }
  function keyUp(e: KeyboardEvent): void { keys.delete(e.key.toLowerCase()); }
  function resize(): void {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }
  pause.addEventListener("click", () => { paused = !paused; pause.textContent = paused ? "Resume" : "Pause"; });
  motion.addEventListener("change", () => {
    idleVariant = "Idle"; idleTimer = 5.8;
    setMotion(motion.value);
  });
  playback.addEventListener("input", () => { speedLabel.textContent = `${Number(playback.value).toFixed(2)}×`; });
  expression.addEventListener("change", () => {
    selectedExpression = expression.value;
    if (selectedExpression !== "auto") setExpression(selectedExpression as Expression);
  });
  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-home-view]")) btn.addEventListener("click", () => {
    const view = btn.dataset.homeView;
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    velocity.set(0, 0, 0); demoAngle = 0; keys.clear();
    flightActive = false; flightVelocity = 0; landing = 0;
    controls.target.set(0, 0.73, 0);
    if (view === "front") camera.position.set(0, 0.9, 4.3);
    else if (view === "back") camera.position.set(0, 1.1, -4.3);
    else if (view === "side") camera.position.set(4.3, 1.1, 0);
    else camera.position.set(3.2, 3.8, 5.2);
    controls.update();
    orbit.checked = false;
  });
  setMotion("Idle");
  function draw(): void {
    renderer.getDrawingBufferSize(size);
    ink.setSize(size.x, size.y);
    ink.render(renderer, scene, camera);
  }
  await warmupGpuAsync(renderer, scene, camera, draw, 2);
  if (status) status.textContent = "Relaxed idle · WASD to move · Shift to run";
  function loop(now: number): void {
    if (!alive) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) {
      const motionDt = dt * Number(playback.value);
      const x = Number(keys.has("d")) - Number(keys.has("a"));
      const z = Number(keys.has("s")) - Number(keys.has("w"));
      const automatic = travel.checked && !x && !z && (motion.value === "Walk" || motion.value === "Run");
      targetVelocity.set(0, 0, 0);
      if (x || z) {
        movementMotion = keys.has("shift") ? "Run" : "Walk";
        targetVelocity.set(x, 0, z).normalize().multiplyScalar(referenceSpeed[movementMotion]);
      } else if (automatic) {
        movementMotion = motion.value as "Walk" | "Run";
        const speed = referenceSpeed[movementMotion];
        demoAngle += motionDt * speed / 1.35;
        targetVelocity.set(Math.sin(demoAngle), 0, Math.cos(demoAngle)).multiplyScalar(speed);
      }
      // Time-based acceleration and heading retain the same feel at different frame rates.
      velocity.lerp(targetVelocity, 1 - Math.exp(-motionDt * 9));
      if (velocity.lengthSq() < 0.000036 && targetVelocity.lengthSq() === 0) velocity.set(0, 0, 0);
      const movingSpeed = velocity.length();
      let desiredMotion = motion.value;
      let motionRate = 1;
      if (movingSpeed > 0.006) {
        model.position.addScaledVector(velocity, motionDt);
        model.position.x = THREE.MathUtils.clamp(model.position.x, -4, 4);
        model.position.z = THREE.MathUtils.clamp(model.position.z, -4, 4);
        const angle = Math.atan2(velocity.x, velocity.z);
        const delta = Math.atan2(Math.sin(angle - model.rotation.y), Math.cos(angle - model.rotation.y));
        model.rotation.y += delta * (1 - Math.exp(-motionDt * 13));
        const gait = movingSpeed > referenceSpeed.Walk * 1.65 ? "Run" : "Walk";
        idleVariant = "Idle"; idleTimer = 5.8;
        desiredMotion = gait;
        motionRate = movingSpeed / referenceSpeed[gait];
      } else {
        desiredMotion = motion.value === "Idle" ? nextIdle(motionDt) : motion.value;
      }
      if (orbit.checked && movingSpeed < 0.006) model.rotation.y += motionDt * 0.4;
      if (flightActive) {
        model.position.y += flightVelocity * motionDt - 12 * motionDt * motionDt;
        flightVelocity -= 24 * motionDt;
        if (model.position.y <= 0 && flightVelocity < 0) {
          model.position.y = 0; flightActive = false; landing = 0.25;
        }
        desiredMotion = flightActive ? (flightVelocity > 0 ? "Jump" : "Fall") : "Land";
        motionRate = 1;
      } else if (landing > 0) {
        landing = Math.max(0, landing - motionDt); desiredMotion = "Land"; motionRate = 1;
      }
      setMotion(desiredMotion); current?.setEffectiveTimeScale(motionRate);
      mixer.update(motionDt);
      if (follow.checked && movingSpeed > 0.006) {
        followTarget.copy(model.position); followTarget.y += 0.73;
        followDelta.copy(followTarget).sub(controls.target).multiplyScalar(1 - Math.exp(-dt * 7));
        controls.target.add(followDelta); camera.position.add(followDelta);
      }
      if (selectedExpression === "auto") {
        blinkClock += motionDt;
        blinkDuration = Math.max(0, blinkDuration - motionDt);
        if (blinkClock >= blinkDelay) {
          blinkClock = 0; blinkDuration = 0.12;
          blinkDelay = blinkIntervals[blinkIndex++ % blinkIntervals.length]!;
        }
        setExpression(flightActive ? "oh" : blinkDuration > 0 ? "blink" : "neutral");
      }
    }
    controls.update();
    draw();
    raf = requestAnimationFrame(loop);
  }
  addEventListener("keydown", keyDown);
  addEventListener("keyup", keyUp);
  addEventListener("resize", resize);
  addEventListener("blur", () => keys.clear());
  raf = requestAnimationFrame(loop);
  const debug = {
    ready: true, model, scene, camera, mixer,
    info: () => ({ clips: gltf.animations.map((c) => c.name), triangles, materials: materials.size, referenceSpeed, drawCalls: renderer.info.render.calls }),
    pinMotion: (name: string, time: number) => {
      mixer.stopAllAction(); const pinned = actions.get(`HOME_${name}`); if (!pinned) return; current = pinned; pinned.reset().play();
      pinned.stopFading().setEffectiveWeight(1);
      pinned.time = time;
      mixer.update(0); paused = true; pause.textContent = "Resume"; draw();
    },
  };
  (window as unknown as Record<string, unknown>).__homePreview = debug;
  addEventListener("pagehide", () => {
    alive = false;
    cancelAnimationFrame(raf);
    removeEventListener("keydown", keyDown);
    removeEventListener("keyup", keyUp);
    removeEventListener("resize", resize);
    mixer.stopAllAction();
    mixer.uncacheRoot(model);
    model.traverse((node) => { if (node instanceof THREE.Mesh) (node.geometry as THREE.BufferGeometry).dispose(); if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose(); });
    for (const material of materials) material.dispose();
    floorGeo.dispose(); floorMat.dispose(); controls.dispose(); ink.dispose(); renderer.dispose();
  }, { once: true });
}
