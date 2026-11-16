import * as THREE from "three";
import type { PlazaPhysics } from "./plazaPhysics.js";

export class PlazaCamera {
  yaw = 0;
  pitch = .31;
  private distance = 8;
  private pointer: number | null = null;
  private x = 0; private y = 0;
  private readonly events = new AbortController();
  private readonly offset = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  constructor(private camera: THREE.PerspectiveCamera, canvas: HTMLCanvasElement) {
    canvas.style.touchAction = "none";
    const signal = this.events.signal;
    canvas.addEventListener("pointerdown", e => { this.pointer = e.pointerId; this.x = e.clientX; this.y = e.clientY; canvas.setPointerCapture(e.pointerId); }, { signal });
    canvas.addEventListener("pointermove", e => {
      if (e.pointerId !== this.pointer) return;
      this.yaw -= Math.max(-120, Math.min(120, e.clientX - this.x)) * .005;
      this.pitch = THREE.MathUtils.clamp(this.pitch + Math.max(-120, Math.min(120, e.clientY - this.y)) * .004, -.15, 1.15);
      this.x = e.clientX; this.y = e.clientY;
    }, { signal });
    const end = () => { this.pointer = null; };
    canvas.addEventListener("pointerup", end, { signal }); canvas.addEventListener("pointercancel", end, { signal });
    canvas.addEventListener("wheel", e => { this.distance = THREE.MathUtils.clamp(this.distance + e.deltaY * .008, 2.5, 13); e.preventDefault(); }, { passive: false, signal });
  }
  update(feet: THREE.Vector3, physics: PlazaPhysics): number {
    this.target.copy(feet); this.target.y += 1.4;
    this.offset.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    let distance = this.distance;
    // Five rays protect the near plane as well as the centre. A wall may pull
    // the camera all the way to the character, without pushing it through.
    for (const [x, y, z] of [[0, 0, 0], [.19, 0, 0], [-.19, 0, 0], [0, .19, 0], [0, -.19, 0]]) {
      const ray = new physics.physics.rapier.Ray({ x: this.target.x + x!, y: this.target.y + y!, z: this.target.z + z! }, this.offset);
      const hit = physics.physics.world.castRay(ray, distance, true, undefined, undefined, physics.collider);
      if (hit) distance = Math.max(.18, Math.min(distance, hit.timeOfImpact - .22));
    }
    this.camera.position.copy(this.target).addScaledVector(this.offset, distance); this.camera.lookAt(this.target);
    return distance;
  }
  dispose(): void { this.events.abort(); }
}
