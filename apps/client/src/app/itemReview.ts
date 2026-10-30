import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {CharacterRig, preloadCharacter, disposeRig} from "../player/rig.js";
import {preloadHeldItems} from "../player/heldItem.js";
import {PICKAXE, pickaxeCycle, pickaxeOption, pickaxeInReach} from "../craft/toolDefinitions.js";

/** The same rigs and clock as gameplay, with repeatable movement and views. */
export async function bootItemReview(mount: HTMLElement): Promise<void> {
    await Promise.all([preloadCharacter(), preloadHeldItems()]);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#eeeede");
    const renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    mount.append(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 40);
    camera.position.set(-3.5, 2.8, 5.5);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.set(0, .8, 0);
    orbit.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xfff7e4, 0x91a785, 2));
    const sun = new THREE.DirectionalLight(0xffefd9, 3);
    sun.position.set(-3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({color: "#c1d0ae", roughness: 1}));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const rigs = [new CharacterRig("mascot"), new CharacterRig("tt")];
    rigs.forEach((rig, i) => { rig.root.position.set(i * 2 - 1, 0, 0); rig.setHeldItem("pickaxe-basic"); scene.add(rig.root); });
    const option = document.getElementById("item-option") as HTMLSelectElement;
    const action = document.getElementById("item-action") as HTMLSelectElement;
    const hitbox = document.getElementById("item-hitbox") as HTMLInputElement;
    const status = document.getElementById("item-stats")!;
    const speedControl = document.getElementById("item-speed") as HTMLInputElement;
    const phaseLabel = document.getElementById("item-phase")!;
    const pauseButton = document.getElementById("item-pause") as HTMLButtonElement;
    for (const o of PICKAXE.options) {
        const el = document.createElement("option"); el.value = o.id; el.textContent = o.name; option.append(el);
    }
    const markers = new Map<THREE.Object3D, THREE.Mesh>();
    let seq = 0, manual = false, workTime = 0, elapsed = 0, paused = false, wasAttacking = false;
    const clearMarkers = (): void => {
        for (const marker of markers.values()) { marker.removeFromParent(); marker.geometry.dispose(); (marker.material as THREE.Material).dispose(); }
        markers.clear();
    };
    const updateStats = (): void => {
        const o = pickaxeOption(option.value);
        for (const rig of rigs) rig.setHeldItem("pickaxe-basic", o.id);
        status.textContent = `유효 거리 ${PICKAXE.targeting.reach}m · 정면 ${Math.round(PICKAXE.targeting.arcDegrees * o.arc)}° · 단일 블록\n스윙 ${pickaxeCycle(o.id).toFixed(2)}초 · ${Math.round(PICKAXE.swing.impactAt * 100)}%에 타격\n돌 효율 ×${(PICKAXE.efficiency.stone * o.mining).toFixed(2)} · 광석 ×${(PICKAXE.efficiency.ore * o.mining).toFixed(2)}\n플레이어 피해 0 · 광역 파괴 꺼짐`;
    };
    option.addEventListener("change", () => { manual = false; workTime = 0; wasAttacking = false; seq++; updateStats(); });
    updateStats();
    document.getElementById("item-swing")!.addEventListener("click", () => { seq++; manual = true; workTime = 0; wasAttacking = false; paused = false; pauseButton.textContent = "일시정지"; });
    pauseButton.addEventListener("click", () => { paused = !paused; pauseButton.textContent = paused ? "재생" : "일시정지"; pauseButton.setAttribute("aria-pressed", String(paused)); });
    action.addEventListener("change", () => { manual = false; wasAttacking = false; workTime = 0; seq++; speedControl.value = action.value === "run" || action.value === "move-attack" ? "4.4" : "2.2"; });
    document.querySelectorAll<HTMLButtonElement>("[data-item-view]").forEach(button => button.addEventListener("click", () => {
        const positions: Record<string, [number, number, number]> = {front: [0, 2, 6], left: [-5, 2.4, 3], right: [5, 2.4, 3], back: [0, 2.1, -6]};
        camera.position.set(...positions[button.dataset.itemView!]!); orbit.target.set(0, .8, 0); orbit.update();
    }));
    const clock = new THREE.Clock();
    const resize = (): void => { renderer.setSize(mount.clientWidth, mount.clientHeight); camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    renderer.setAnimationLoop(() => {
        const rawDt = Math.min(.05, clock.getDelta()), dt = paused ? 0 : rawDt, pose = action.value;
        const moving = pose === "walk" || pose === "run" || pose === "move-attack" || pose === "turn";
        const speed = moving ? Number(speedControl.value) : 0;
        const attacking = manual || pose === "mine" || pose === "move-attack";
        if (dt > 0) {
            elapsed += dt;
            if (attacking && !wasAttacking) workTime = 0;
            if (attacking) workTime += dt;
            for (const rig of rigs) {
                rig.root.rotation.y = pose === "turn" ? Math.sin(elapsed * 1.6) * 1.1 : 0;
                rig.performAction(attacking ? "interact" : "none", seq, attacking && !manual);
                rig.update(moving ? "run" : pose === "crawl" ? "crawl" : "idle", speed, dt, {toolTime: attacking ? workTime : undefined});
            }
            wasAttacking = attacking;
            if (manual && workTime >= pickaxeCycle(option.value)) { manual = false; wasAttacking = false; }
        }
        const phase = attacking ? workTime / pickaxeCycle(option.value) % 1 : 0;
        const label = !attacking ? "그립 유지" : phase < .39 ? "준비" : phase < .58 ? "내려찍기" : phase < .69 ? "타격 · 잔동작" : "복귀";
        phaseLabel.textContent = `${label} · ${speed.toFixed(1)}m/s${paused ? " · 정지" : ""}`;
        for (const rig of rigs) {
            const anchor = rig.root.getObjectByName(PICKAXE.swing.impactNode);
            if (anchor && !markers.has(anchor)) {
                const marker = new THREE.Mesh(new THREE.SphereGeometry(PICKAXE.targeting.contactRadius, 16, 12), new THREE.MeshBasicMaterial({color: 0xff9239, wireframe: true, transparent: true, opacity: .7}));
                anchor.add(marker); markers.set(anchor, marker);
            }
            if (anchor) { const marker = markers.get(anchor)!; marker.visible = hitbox.checked; marker.scale.setScalar(pickaxeOption(option.value).radius / PICKAXE.grip.scale); }
        }
        orbit.update(); renderer.render(scene, camera);
    });
    const distance = document.getElementById("item-distance") as HTMLInputElement;
    const updateDistance = (): void => { document.getElementById("item-distance-label")!.textContent = `${Number(distance.value).toFixed(1)}m · ${pickaxeInReach(Number(distance.value), 0, option.value) ? "유효 거리 안" : "유효 거리 밖"}`; };
    distance.addEventListener("input", updateDistance);
    addEventListener("pagehide", () => { renderer.setAnimationLoop(null); observer.disconnect(); orbit.dispose(); clearMarkers(); for (const rig of rigs) disposeRig(rig.root); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); renderer.dispose(); }, {once: true});
}
