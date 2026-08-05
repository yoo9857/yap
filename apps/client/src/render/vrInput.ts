import * as THREE from "three";

/**
 * XR controllers: a pointing ray and a trigger, nothing more.
 *
 * Hand assignment comes from the runtime's `handedness` rather than the
 * controller index, which is not a reliable left/right signal — a session that
 * connects the right hand first would otherwise put the wrist panel on the hand
 * doing the pointing.
 */
export class VrControllers {
  /** The hand carrying the wrist UI, once the runtime tells us which it is. */
  private wrist: THREE.Group | null = null;
  /** The hand that aims. */
  private pointer: THREE.Group | null = null;
  private readonly groups: THREE.Group[] = [];
  private readonly rays: THREE.Line[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private selectPending = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    rig: THREE.Group,
    /** Called once a hand is known, so the caller can mount the wrist UI. */
    private readonly onWristReady: (controller: THREE.Group) => void,
  ) {
    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      rig.add(controller);
      this.groups.push(controller);

      // a 1 m aiming ray; hidden until this hand is known to be the pointer
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      const ray = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xf9d71c, transparent: true, opacity: 0.85 }),
      );
      ray.visible = false;
      controller.add(ray);
      this.rays.push(ray);

      const onConnected = (event: { data?: { handedness?: string } }): void => {
        const handedness = event.data?.handedness;
        if (handedness === "left" && !this.wrist) {
          this.wrist = controller;
          this.onWristReady(controller);
        } else {
          this.pointer = controller;
          ray.visible = true;
        }
      };
      const onDisconnected = (): void => {
        ray.visible = false;
        if (this.pointer === controller) this.pointer = null;
        if (this.wrist === controller) this.wrist = null;
      };
      const onSelect = (): void => {
        this.selectPending = true;
      };
      controller.addEventListener("connected", onConnected);
      controller.addEventListener("disconnected", onDisconnected);
      controller.addEventListener("selectstart", onSelect);
      this.cleanups.push(() => {
        controller.removeEventListener("connected", onConnected);
        controller.removeEventListener("disconnected", onDisconnected);
        controller.removeEventListener("selectstart", onSelect);
      });
    }
  }

  /** True if a hand is available to aim with. */
  get hasPointer(): boolean {
    return this.pointer !== null;
  }

  /** Did the runtime hand us a left controller to hang the wrist UI on? */
  get hasWrist(): boolean {
    return this.wrist !== null;
  }

  /**
   * Cast the pointing hand's ray at `target` and return the UV it struck.
   * `null` when nothing is aimed at it — including when there is no pointer.
   */
  pick(target: THREE.Object3D): THREE.Vector2 | null {
    const pointer = this.pointer;
    if (!pointer || !target.visible) return null;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(0, 0, -1);
    pointer.getWorldPosition(origin);
    direction.applyQuaternion(pointer.getWorldQuaternion(new THREE.Quaternion()));
    this.raycaster.set(origin, direction);
    const hit = this.raycaster.intersectObject(target, false)[0];
    // shorten the ray to the panel so it reads as a laser touching a surface
    const ray = this.rays[this.groups.indexOf(pointer)];
    if (ray) ray.scale.z = hit ? hit.distance : 1;
    return hit?.uv ?? null;
  }

  /** Consume a trigger press; true at most once per press. */
  consumeSelect(): boolean {
    if (!this.selectPending) return false;
    this.selectPending = false;
    return true;
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const ray of this.rays) {
      ray.removeFromParent();
      ray.geometry.dispose();
      (ray.material as THREE.Material).dispose();
    }
    this.rays.length = 0;
    for (const group of this.groups) group.removeFromParent();
    this.groups.length = 0;
    this.wrist = null;
    this.pointer = null;
  }
}
