import * as THREE from "three";
import { createRng } from "@robo/shared";
import { brickMaterial } from "./materials.js";

/**
 * Decorative clouds + grass-topped floating islands around the tower (visual
 * only, no physics). Everything drifts / bobs gently on render frames to give
 * the crayon-doodle world a soft, hand-animated feel.
 */
export class Scenery {
  private readonly clouds: { mesh: THREE.Group; driftSpeed: number; bob: number; phase: number; baseY: number }[] = [];
  private readonly islands: { mesh: THREE.Group; bob: number; phase: number; spin: number; baseY: number }[] = [];
  private readonly roots: THREE.Object3D[] = [];
  private time = 0;

  constructor(
    private readonly scene: THREE.Scene,
    summitHeight: number,
  ) {
    const rng = createRng(777);
    const R = (a: number, b: number) => rng.range(a, b);

    // two-tone cloud shading: bright crown, faintly cooler belly — reads as a
    // soft doodle puff instead of a flat white box
    const cloudTop = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
    const cloudBelly = new THREE.MeshLambertMaterial({ color: 0xdfeefb, transparent: true, opacity: 0.95 });

    for (let i = 0; i < 26; i++) {
      const cloud = this.makeCloud(rng, R, cloudTop, cloudBelly);
      const baseY = R(6, summitHeight * 0.55);
      // clouds live in the troposphere only — the ozone/space bands above
      // (see world/atmosphere.ts) should read as thin air, not cloud soup
      cloud.position.set(R(-72, 72), baseY, R(-72, 72));
      scene.add(cloud);
      this.roots.push(cloud);
      this.clouds.push({
        mesh: cloud,
        driftSpeed: R(0.12, 0.5),
        bob: R(0.25, 0.7),
        phase: R(0, Math.PI * 2),
        baseY,
      });
    }

    for (let i = 0; i < 11; i++) {
      const island = this.makeIsland(rng, R);
      const angle = R(0, Math.PI * 2);
      const dist = R(30, 62); // outside the play column — never looks reachable
      const baseY = R(5, summitHeight * 0.6);
      island.position.set(Math.cos(angle) * dist, baseY, Math.sin(angle) * dist);
      island.rotation.y = R(0, Math.PI * 2);
      scene.add(island);
      this.roots.push(island);
      this.islands.push({
        mesh: island,
        bob: R(0.3, 0.9),
        phase: R(0, Math.PI * 2),
        spin: R(-0.05, 0.05),
        baseY,
      });
    }
  }

  /** A rounded doodle cloud: one flat crown box + a few overlapping puffs. */
  private makeCloud(
    rng: ReturnType<typeof createRng>,
    R: (a: number, b: number) => number,
    top: THREE.Material,
    belly: THREE.Material,
  ): THREE.Group {
    const cloud = new THREE.Group();
    const puffs = 3 + ((rng.next() * 3) | 0);
    let x = -puffs * 0.5;
    for (let j = 0; j < puffs; j++) {
      const s = R(1.6, 3.4);
      // belly slab (slightly wider, sits low) + brighter crown on top
      const belowGeo = new THREE.BoxGeometry(s * 1.7, s * 0.42, s * 1.05);
      const below = new THREE.Mesh(belowGeo, belly);
      below.position.set(x, R(-0.25, 0.05), R(-0.35, 0.35));
      cloud.add(below);
      const crownGeo = new THREE.BoxGeometry(s * 1.25, s * 0.5, s * 0.8);
      const crown = new THREE.Mesh(crownGeo, top);
      crown.position.set(x + R(-0.2, 0.2), below.position.y + s * 0.32, below.position.z);
      cloud.add(crown);
      x += s * 0.9;
    }
    return cloud;
  }

  /** A grass-topped stone chunk with a little bush crown. */
  private makeIsland(rng: ReturnType<typeof createRng>, R: (a: number, b: number) => number): THREE.Group {
    const island = new THREE.Group();
    const w = R(3.5, 7.5);
    const d = w * R(0.7, 1.05);

    // rocky underside — tapers down so it reads as a torn-off chunk of ground
    const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, R(1.4, 2.6), d * 0.82), brickMaterial("#b8bcc2"));
    base.position.y = -R(0.9, 1.4);
    island.add(base);

    // grass cap
    const grass = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, d), brickMaterial("#3ea33b"));
    island.add(grass);

    // 1–3 crayon-green bush blobs scattered on the grass
    const bushMat = brickMaterial("#4bb54a");
    const bushes = 1 + ((rng.next() * 3) | 0);
    for (let b = 0; b < bushes; b++) {
      const bs = R(0.6, 1.3);
      const bush = new THREE.Mesh(new THREE.BoxGeometry(bs, bs * 0.85, bs), bushMat);
      bush.position.set(R(-w * 0.3, w * 0.3), 0.35 + bs * 0.4, R(-d * 0.3, d * 0.3));
      island.add(bush);
    }
    return island;
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
    this.islands.length = 0;
  }

  update(dt: number): void {
    this.time += dt;
    for (const c of this.clouds) {
      c.mesh.position.x += c.driftSpeed * dt;
      if (c.mesh.position.x > 82) c.mesh.position.x = -82;
      c.mesh.position.y = c.baseY + Math.sin(this.time * 0.5 + c.phase) * c.bob;
    }
    for (const s of this.islands) {
      s.mesh.position.y = s.baseY + Math.sin(this.time * 0.6 + s.phase) * s.bob;
      s.mesh.rotation.y += s.spin * dt;
    }
  }
}
