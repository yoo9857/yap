import * as THREE from "three";
import { lerp, type AnimState } from "@robo/shared";

/**
 * Classic R6 blocky character: 6 boxes + canvas-texture face, with procedural
 * idle/run/jump/fall/dead poses. Limbs pivot at shoulder/hip via groups whose
 * geometry hangs downward. `root` origin is at the FEET.
 */
export class CharacterRig {
  readonly root = new THREE.Group();
  private readonly leftArm: THREE.Group;
  private readonly rightArm: THREE.Group;
  private readonly leftLeg: THREE.Group;
  private readonly rightLeg: THREE.Group;
  private animTime = 0;

  constructor(torsoColor = 0x0f6cbd, limbColor = 0xf9d71c, legColor = 0x4bb54a) {
    const mat = (c: number | THREE.Color) =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 });

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.28), mat(torsoColor));
    torso.position.y = 0.9;
    torso.castShadow = true;
    this.root.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.38), mat(0xf9d71c));
    head.position.y = 1.42;
    head.castShadow = true;
    this.root.add(head);

    // face decal on the +z side of the head
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.34),
      new THREE.MeshBasicMaterial({ map: makeFaceTexture(), transparent: true }),
    );
    face.position.set(0, 1.42, 0.195);
    this.root.add(face);

    const limb = (color: number, x: number, pivotY: number, w = 0.22, h = 0.6) => {
      const group = new THREE.Group();
      group.position.set(x, pivotY, 0);
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.22), mat(color));
      box.position.y = -h / 2;
      box.castShadow = true;
      group.add(box);
      this.root.add(group);
      return group;
    };

    this.leftArm = limb(limbColor, -0.37, 1.18);
    this.rightArm = limb(limbColor, 0.37, 1.18);
    this.leftLeg = limb(legColor, -0.13, 0.6);
    this.rightLeg = limb(legColor, 0.13, 0.6);
  }

  /** Drive the procedural pose. `planarSpeed` in m/s, `dt` real frame time.
   *  `carry` = builder mode: legs walk, both arms stretched forward holding
   *  a load between the hands. `place` = builder mode: standing bow with the
   *  arms lowering the load (also reads as picking one up). */
  update(anim: AnimState | "carry" | "place", planarSpeed: number, dt: number): void {
    this.animTime += dt * Math.max(planarSpeed * 1.6, 3);
    const t = this.animTime;
    const ease = 1 - Math.pow(0.0001, dt); // frame-rate independent smoothing

    let armSwing = 0;
    let legSwing = 0;
    let armLift = 0;
    let bodyTilt = 0;

    switch (anim) {
      case "run": {
        const cycle = Math.sin(t);
        armSwing = cycle * 0.9;
        legSwing = cycle * 0.9;
        bodyTilt = 0.08;
        break;
      }
      case "jump":
        armLift = Math.PI * 0.9;
        legSwing = 0.35;
        break;
      case "fall":
        armLift = Math.PI * 0.55;
        legSwing = -0.25;
        break;
      case "dead":
        bodyTilt = Math.PI / 2;
        break;
      case "idle": {
        armSwing = Math.sin(t * 0.35) * 0.05;
        break;
      }
      case "carry": {
        // arms locked forward around the load; legs keep the walk cycle
        armLift = Math.PI * 0.5;
        legSwing = Math.sin(t) * 0.9;
        bodyTilt = 0.06;
        break;
      }
      case "place": {
        // bow forward, arms lowering — the smoothing lerp turns the
        // carry→place transition into a visible "setting it down" motion
        armLift = Math.PI * 0.2;
        bodyTilt = 0.38;
        break;
      }
    }

    const approach = (obj: THREE.Object3D, target: number, axis: "x" | "z" = "x") => {
      obj.rotation[axis] = lerp(obj.rotation[axis], target, ease);
    };

    approach(this.leftArm, armSwing - armLift);
    approach(this.rightArm, -armSwing - armLift);
    approach(this.leftLeg, -legSwing);
    approach(this.rightLeg, legSwing);
    this.root.rotation.x = lerp(this.root.rotation.x, bodyTilt === 0 ? 0 : bodyTilt, ease);
  }
}

/** Frees every geometry/material/texture a rig (or its sprites) allocated. */
export function disposeRig(root: THREE.Object3D): void {
  root.traverse((o: THREE.Object3D) => {
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Sprite)) return;
    if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
    const material = (o as THREE.Mesh).material;
    const mats: THREE.Material[] = Array.isArray(material) ? material : [material];
    for (const m of mats) {
      const tex = (m as THREE.Material & { map?: THREE.Texture | null }).map;
      if (tex) tex.dispose();
      m.dispose();
    }
  });
}

function makeFaceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#1a1a1a";
    // eyes
    ctx.beginPath();
    ctx.ellipse(40, 48, 9, 13, 0, 0, Math.PI * 2);
    ctx.ellipse(88, 48, 9, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // smile
    ctx.lineWidth = 8;
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(64, 62, 34, Math.PI * 0.2, Math.PI * 0.8);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
