import * as THREE from "three";
import { clamp } from "@robo/shared";
import type { PhysicsWorld, RapierCollider } from "../physics/physics.js";

const MIN_DIST = 3;
const MAX_DIST = 16;
const MIN_PITCH = -0.25;
const MAX_PITCH = 1.25;

/**
 * Roblox-style third-person follow camera: drag to orbit, wheel to zoom,
 * raycast toward the player so world geometry never blocks the view.
 * `yaw` is the movement basis for camera-relative controls.
 */
export class FollowCamera {
  yaw = Math.PI; // look at the tower from the front
  pitch = 0.35;
  private distance = 9;
  private readonly target = new THREE.Vector3();
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    domElement.addEventListener("pointerdown", (e) => {
      // touch movement joystick owns the left third of the screen
      if (e.pointerType === "touch" && e.clientX < window.innerWidth * 0.35) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      domElement.setPointerCapture(e.pointerId);
    });
    domElement.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      // clamp the per-event drag delta so a stale/jumped pointer can't whip the
      // camera around in one frame
      const dx = clamp(e.clientX - this.lastX, -180, 180);
      const dy = clamp(e.clientY - this.lastY, -180, 180);
      this.yaw -= dx * 0.005;
      this.pitch = clamp(this.pitch + dy * 0.005, MIN_PITCH, MAX_PITCH);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const stop = () => (this.dragging = false);
    domElement.addEventListener("pointerup", stop);
    domElement.addEventListener("pointercancel", stop);
    domElement.addEventListener(
      "wheel",
      (e) => {
        this.distance = clamp(this.distance + e.deltaY * 0.01, MIN_DIST, MAX_DIST);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  /** Called every render frame with the interpolated player head position. */
  update(playerHead: THREE.Vector3, physics: PhysicsWorld, playerCollider?: RapierCollider): void {
    this.target.copy(playerHead);
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );

    // pull the camera in if something solid sits between player and camera
    let dist = this.distance;
    const ray = new physics.rapier.Ray(
      { x: this.target.x, y: this.target.y, z: this.target.z },
      { x: offset.x, y: offset.y, z: offset.z },
    );
    const hit = physics.world.castRay(ray, this.distance, true, undefined, undefined, playerCollider);
    if (hit) dist = Math.max(MIN_DIST * 0.4, hit.timeOfImpact - 0.3);

    this.camera.position.copy(this.target).addScaledVector(offset, dist);
    this.camera.lookAt(this.target);
  }
}
