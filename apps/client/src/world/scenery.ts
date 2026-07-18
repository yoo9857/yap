import * as THREE from "three";
import { BRICK_COLORS, createRng } from "@robo/shared";
import { brickMaterial } from "./materials.js";

/**
 * Decorative clouds + floating brick islands around the tower (visual only,
 * no physics). Clouds drift slowly on render frames.
 */
export class Scenery {
  private readonly clouds: { mesh: THREE.Group; speed: number }[] = [];
  private readonly roots: THREE.Object3D[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    summitHeight: number,
  ) {
    const rng = createRng(777);
    const R = (a: number, b: number) => rng.range(a, b);
    const cloudMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.92,
    });

    for (let i = 0; i < 26; i++) {
      const cloud = new THREE.Group();
      const puffs = 2 + ((rng.next() * 3) | 0);
      for (let j = 0; j < puffs; j++) {
        const s = R(1.4, 3.2);
        const puff = new THREE.Mesh(new THREE.BoxGeometry(s * 1.6, s * 0.55, s), cloudMat);
        puff.position.set(j * s * 1.05 - puffs, R(-0.3, 0.3), R(-0.5, 0.5));
        cloud.add(puff);
      }
      // clouds live in the troposphere only — the ozone/space bands above
      // (see world/atmosphere.ts) should read as thin air, not cloud soup
      cloud.position.set(R(-70, 70), R(2, summitHeight * 0.55), R(-70, 70));
      scene.add(cloud);
      this.roots.push(cloud);
      this.clouds.push({ mesh: cloud, speed: R(0.15, 0.55) });
    }

    for (let i = 0; i < 10; i++) {
      const w = R(3.5, 8);
      const island = new THREE.Mesh(
        new THREE.BoxGeometry(w, R(0.8, 1.6), w * R(0.6, 1)),
        brickMaterial(rng.pick(BRICK_COLORS)),
      );
      // keep islands outside the play column so they never look reachable
      const angle = R(0, Math.PI * 2);
      const dist = R(28, 60);
      island.position.set(
        Math.cos(angle) * dist,
        R(4, summitHeight * 0.6),
        Math.sin(angle) * dist,
      );
      scene.add(island);
      this.roots.push(island);
    }
  }

  dispose(): void {
    for (const root of this.roots) {
      this.scene.remove(root);
      root.traverse((o: THREE.Object3D) => {
        if (o instanceof THREE.Mesh) (o.geometry as THREE.BufferGeometry).dispose();
      });
    }
    this.roots.length = 0;
    this.clouds.length = 0;
  }

  update(dt: number): void {
    for (const c of this.clouds) {
      c.mesh.position.x += c.speed * dt;
      if (c.mesh.position.x > 80) c.mesh.position.x = -80;
    }
  }
}
