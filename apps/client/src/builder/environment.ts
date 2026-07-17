import * as THREE from "three";
import {
  FoliagePatch,
  pickFoliageType,
  type FoliagePlacement,
} from "../world/foliage.js";
import type { Landmark } from "./landmarks.js";

type Theme = {
  ground: number;
  fog: number;
  sky: number;
  path: number;
  foliage: number;
  accent: number;
  urban: boolean;
  water?: boolean;
  desert?: boolean;
  mountain?: boolean;
};

const THEMES: Record<string, Theme> = {
  pyramid: { ground: 0xb79558, fog: 0xd8bd8b, sky: 0x9fc5d8, path: 0xd5bb84, foliage: 0x6f7841, accent: 0xc67a32, urban: false, desert: true },
  bigben: { ground: 0x50654f, fog: 0xaeb9c2, sky: 0x8fa9bd, path: 0x767b78, foliage: 0x355b36, accent: 0x9e2f28, urban: true, water: true },
  pisa: { ground: 0x66834d, fog: 0xc8c8b8, sky: 0x9fc4d5, path: 0xc5ad7d, foliage: 0x315d32, accent: 0x9f623c, urban: false },
  eiffel: { ground: 0x436b42, fog: 0xb9c2ca, sky: 0x9db7cc, path: 0xb0a48e, foliage: 0x2f5c38, accent: 0x315f83, urban: true },
  colosseum: { ground: 0x766c49, fog: 0xc9bca5, sky: 0xa9bfd0, path: 0xb89b6a, foliage: 0x435d35, accent: 0x9f4d35, urban: true },
  namsan: { ground: 0x315c38, fog: 0xa9bbc4, sky: 0x91b1c5, path: 0x777a70, foliage: 0x244c31, accent: 0x376f91, urban: true, mountain: true },
  liberty: { ground: 0x526d4d, fog: 0xa7bac5, sky: 0x91b2c9, path: 0x8d8c83, foliage: 0x315c39, accent: 0x316f82, urban: true, water: true },
};

const mat = (color: number, roughness = 0.82, metalness = 0.02) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

function seeded(index: number, salt: number): number {
  const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/** Location-specific procedural set dressing for the monument showcase. */
export class BuilderEnvironment {
  private readonly content = new THREE.Group();
  private landmarkId: string | null = null;
  private foliagePatch: FoliagePatch | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly ground: THREE.Mesh,
  ) {
    this.content.name = "landmark-environment";
    scene.add(this.content);
    this.addSkyDome();
  }

  update(landmark: Landmark): void {
    if (landmark.id === this.landmarkId) return;
    this.landmarkId = landmark.id;
    this.clearContent();
    const theme = THEMES[landmark.id] ?? THEMES.eiffel!;
    // brightened tint: the ground carries a crayon-doodle texture map, so the
    // theme color only grades it — a full-strength dark tint would mud it out
    (this.ground.material as THREE.MeshStandardMaterial).color
      .setHex(theme.ground)
      .lerp(new THREE.Color(0xffffff), 0.45);
    this.scene.background = new THREE.Color(theme.sky);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.setHex(theme.fog);
      this.scene.fog.near = Math.max(180, landmark.radiusM * 2.5);
      this.scene.fog.far = Math.max(1100, landmark.heightM * 5);
    }

    const safe = landmark.radiusM + 18;
    const backdrop = Math.max(safe * 2.7, landmark.heightM * 1.08, 170);
    this.addPaths(safe, theme);
    this.addLampsAndBenches(safe);
    this.addConstructionProps(safe);

    if (theme.desert) this.addDesert(backdrop, theme);
    else {
      this.addTrees(safe, backdrop, theme, landmark.id === "pisa" || landmark.id === "colosseum");
      if (theme.urban) this.addSkyline(backdrop, landmark.heightM, theme, landmark.id);
      if (theme.water) this.addWater(backdrop, theme);
      if (theme.mountain) this.addMountains(backdrop);
    }

    // doodle plants around the site (deserts stay bare)
    this.foliagePatch?.dispose();
    this.foliagePatch = theme.desert
      ? null
      : new FoliagePatch(this.scene, this.foliagePlacements(safe));
  }

  /** Scatter ring outside the plaza, skipping the stone paths. */
  private foliagePlacements(safe: number): FoliagePlacement[] {
    const placements: FoliagePlacement[] = [];
    const inner = safe + 1.5;
    const outer = Math.min(inner + 75, 150);
    const pathHalfAngle = (r: number) => Math.atan(3.4 / r);
    for (let i = 0; i < 170; i++) {
      const a = seeded(i, 11 + safe) * Math.PI * 2;
      const r = inner + (outer - inner) * Math.sqrt(seeded(i, 23));
      if (Math.abs(r - (safe + 6.5)) < 2.3) continue; // ring path band
      // the four straight paths at 0/90/180/270°
      const rel = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
      if (Math.min(rel, Math.PI / 2 - rel) < pathHalfAngle(r)) continue;
      placements.push({
        x: Math.cos(a) * r,
        y: 0,
        z: Math.sin(a) * r,
        yaw: seeded(i, 37) * Math.PI * 2,
        // oversized on purpose: the camera frames whole monuments, so
        // life-size plants would vanish — doodle scale reads better
        scale: 1.8 + seeded(i, 53) * 1.7,
        type: pickFoliageType(seeded(i, 71)),
      });
    }
    return placements;
  }

  private addSkyDome(): void {
    const geometry = new THREE.SphereGeometry(1900, 32, 16);
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x607f9f) },
        horizonColor: { value: new THREE.Color(0xd7d7ca) },
      },
      vertexShader: `varying vec3 vWorld; void main(){ vWorld=(modelMatrix*vec4(position,1.0)).xyz; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vWorld; uniform vec3 topColor; uniform vec3 horizonColor; void main(){ float h=clamp(normalize(vWorld).y*.78+.22,0.0,1.0); gl_FragColor=vec4(mix(horizonColor,topColor,pow(h,.7)),1.0); }`,
    });
    const sky = new THREE.Mesh(geometry, material);
    sky.name = "architectural-sky";
    this.scene.add(sky);
  }

  private addPaths(radius: number, theme: Theme): void {
    const pathMaterial = mat(theme.path, 0.92);
    const accentMaterial = mat(theme.accent, 0.45, 0.25);
    const segments = 64;
    const ringRadius = radius + 6.5;
    const segmentLength = (Math.PI * 2 * ringRadius) / segments + 0.25;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const tile = new THREE.Mesh(new THREE.BoxGeometry(segmentLength, 0.14, 3), pathMaterial);
      tile.position.set(Math.cos(angle) * ringRadius, 0.07, Math.sin(angle) * ringRadius);
      tile.rotation.y = -angle + Math.PI / 2;
      tile.receiveShadow = true;
      this.content.add(tile);
      if (i % 2 === 0) {
        const curb = new THREE.Mesh(new THREE.BoxGeometry(segmentLength, 0.22, 0.28), accentMaterial);
        curb.position.set(Math.cos(angle) * (ringRadius + 1.65), 0.11, Math.sin(angle) * (ringRadius + 1.65));
        curb.rotation.y = tile.rotation.y;
        this.content.add(curb);
      }
    }

    for (let i = 0; i < 4; i++) {
      const length = radius * 0.8 + 28;
      const path = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.12, length), pathMaterial);
      const angle = i * Math.PI / 2;
      path.rotation.y = -angle;
      path.position.set(Math.cos(angle) * (radius + length / 2 + 5), 0.06, Math.sin(angle) * (radius + length / 2 + 5));
      path.receiveShadow = true;
      this.content.add(path);
    }
  }

  private addLampsAndBenches(radius: number): void {
    const dark = mat(0x252b2d, 0.28, 0.8);
    const glow = new THREE.MeshStandardMaterial({ color: 0xffd58a, emissive: 0xffa52d, emissiveIntensity: 2.2, roughness: 0.2 });
    const wood = mat(0x76513a, 0.76);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r = radius + 10;
      const lamp = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.24, 4.4, 0.24), dark);
      pole.position.y = 2.2;
      pole.castShadow = true;
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.52), glow);
      cap.position.y = 4.45;
      lamp.add(pole, cap);
      lamp.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.content.add(lamp);

      if (i % 2 === 0) {
        const bench = new THREE.Group();
        for (const y of [0.62, 1.1]) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.16, 0.42), wood);
          slat.position.y = y;
          if (y > 1) slat.rotation.x = -0.12;
          slat.castShadow = true;
          bench.add(slat);
        }
        const legs = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.65, 0.16), dark);
        legs.position.y = 0.34;
        bench.add(legs);
        bench.position.set(Math.cos(a) * (r + 3), 0, Math.sin(a) * (r + 3));
        bench.rotation.y = -a + Math.PI / 2;
        this.content.add(bench);
      }
    }
  }

  private addConstructionProps(radius: number): void {
    const orange = mat(0xf06a20, 0.55);
    const white = mat(0xf2eee4, 0.65);
    const steel = mat(0x343b40, 0.35, 0.72);
    const baseAngle = 0.2;
    for (let i = 0; i < 7; i++) {
      const cone = new THREE.Group();
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.72), steel);
      foot.position.y = 0.04;
      cone.add(foot);
      for (let layer = 0; layer < 4; layer++) {
        const size = 0.48 - layer * 0.09;
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(size, 0.2, size),
          layer === 2 ? white : orange,
        );
        body.position.y = 0.16 + layer * 0.2;
        cone.add(body);
      }
      const a = baseAngle + i * 0.055;
      cone.position.set(Math.cos(a) * (radius + 5), 0, Math.sin(a) * (radius + 5));
      this.content.add(cone);
    }
  }

  private addTrees(inner: number, outer: number, theme: Theme, cypress: boolean): void {
    const trunk = mat(0x4a3425, 1);
    const leafA = mat(theme.foliage, 0.96);
    const leafB = mat(new THREE.Color(theme.foliage).offsetHSL(0.02, 0.03, 0.07).getHex(), 0.96);
    const count = 46;
    for (let i = 0; i < count; i++) {
      const a = seeded(i, 1) * Math.PI * 2;
      const r = inner + 18 + seeded(i, 2) * Math.max(25, outer - inner - 38);
      const scale = 0.78 + seeded(i, 3) * 0.65;
      const tree = new THREE.Group();
      const stem = new THREE.Mesh(new THREE.BoxGeometry(0.72 * scale, 4.8 * scale, 0.72 * scale), trunk);
      stem.position.y = 2.4 * scale;
      stem.castShadow = true;
      tree.add(stem);
      const leaves = i % 2 ? leafA : leafB;
      if (cypress) {
        for (let layer = 0; layer < 6; layer++) {
          const width = (2.8 - layer * 0.34) * scale;
          const crown = new THREE.Mesh(new THREE.BoxGeometry(width, 1.35 * scale, width), leaves);
          crown.position.y = (4.6 + layer * 1.18) * scale;
          crown.castShadow = true;
          tree.add(crown);
        }
      } else {
        const offsets = [[0, 5.2, 0], [-1.35, 5.1, 0.3], [1.25, 5.45, -0.25], [0.25, 6.75, 0.2], [0, 5.45, 1.25]];
        for (const [x, y, z] of offsets) {
          const crown = new THREE.Mesh(new THREE.BoxGeometry(2.8 * scale, 2.5 * scale, 2.8 * scale), leaves);
          crown.position.set(x! * scale, y! * scale, z! * scale);
          crown.castShadow = true;
          tree.add(crown);
        }
      }
      tree.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      tree.rotation.y = seeded(i, 8) * Math.PI;
      this.content.add(tree);
    }
  }

  private addSkyline(distance: number, monumentHeight: number, theme: Theme, id: string): void {
    const wallColors = [0x6e7274, 0x85817a, 0x666d72, 0x9a8e7c];
    const windowMaterial = new THREE.MeshStandardMaterial({ color: 0x9bc1d0, emissive: 0x31566a, emissiveIntensity: 0.65, roughness: 0.18, metalness: 0.35 });
    const count = id === "liberty" || id === "namsan" ? 34 : 26;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + seeded(i, 9) * 0.08;
      const r = distance + seeded(i, 4) * 75;
      let height = 16 + seeded(i, 5) * Math.min(70, monumentHeight * 0.24);
      if (id === "liberty" || id === "namsan") height *= 1.45;
      const width = 10 + seeded(i, 6) * 18;
      const depth = 9 + seeded(i, 7) * 15;
      const building = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat(wallColors[i % wallColors.length]!, 0.72, 0.08));
      body.position.y = height / 2;
      body.castShadow = true;
      building.add(body);
      const rows = Math.max(2, Math.floor(height / 5));
      for (let row = 1; row < rows; row++) {
        const window = new THREE.Mesh(new THREE.BoxGeometry(width * 0.72, 1.15, 0.08), windowMaterial);
        window.position.set(0, row * (height / rows), depth / 2 + 0.05);
        building.add(window);
      }
      if (height > 60) {
        const antenna = new THREE.Mesh(new THREE.BoxGeometry(0.2, height * 0.22, 0.2), mat(theme.accent, 0.35, 0.7));
        antenna.position.y = height * 1.11;
        building.add(antenna);
      }
      building.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      building.rotation.y = -a + Math.PI / 2;
      this.content.add(building);
    }
  }

  private addWater(distance: number, theme: Theme): void {
    const waterMaterial = new THREE.MeshPhysicalMaterial({ color: 0x3e7185, roughness: 0.16, metalness: 0.22, clearcoat: 0.9, clearcoatRoughness: 0.12, transparent: true, opacity: 0.88 });
    for (const side of [-1, 1]) {
      for (let tile = -3; tile <= 3; tile++) {
        const water = new THREE.Mesh(new THREE.BoxGeometry(distance * 0.19, 0.16, distance * 0.55), waterMaterial);
        water.position.set(tile * distance * 0.19, 0.08 + (tile % 2) * 0.025, side * distance * 0.82);
        this.content.add(water);
      }
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(distance * 1.5, 0.16, 0.18), mat(theme.accent, 0.3, 0.75));
    rail.position.set(0, 1.1, distance * 0.54);
    this.content.add(rail);
  }

  private addDesert(distance: number, theme: Theme): void {
    const duneMaterial = mat(theme.ground, 0.98);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const r = distance + seeded(i, 4) * 120;
      const base = 26 + seeded(i, 3) * 34;
      for (let layer = 0; layer < 5; layer++) {
        const dune = new THREE.Mesh(new THREE.BoxGeometry(base * (1 - layer * 0.13), 2.4, base * 0.46 * (1 - layer * 0.11)), duneMaterial);
        dune.position.set(Math.cos(a) * r, -2.8 + layer * 2.1, Math.sin(a) * r);
        dune.rotation.y = a + seeded(i, 8);
        dune.receiveShadow = true;
        this.content.add(dune);
      }
    }
    // Two distant companion pyramids make the Giza plateau read immediately.
    for (const [x, z, size] of [[-distance * 0.72, -distance * 0.65, 32], [distance * 0.68, -distance * 0.8, 23]] as const) {
      const pyramidMaterial = mat(0xc9a467, 0.94);
      for (let layer = 0; layer < 9; layer++) {
        const width = size * (1 - layer / 10);
        const course = new THREE.Mesh(new THREE.BoxGeometry(width, size * 0.08, width), pyramidMaterial);
        course.position.set(x, size * 0.04 + layer * size * 0.08, z);
        this.content.add(course);
      }
    }
  }

  private addMountains(distance: number): void {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const height = 60 + seeded(i, 4) * 95;
      const mountainMaterial = mat(i % 2 ? 0x4c6353 : 0x586b56, 1);
      for (let layer = 0; layer < 8; layer++) {
        const width = height * 0.92 * (1 - layer / 9);
        const mountain = new THREE.Mesh(new THREE.BoxGeometry(width, height / 8, width * 1.35), mountainMaterial);
        mountain.position.set(
          Math.cos(a) * (distance * 1.25),
          -5 + (layer + 0.5) * (height / 8),
          Math.sin(a) * (distance * 1.25),
        );
        mountain.rotation.y = a;
        this.content.add(mountain);
      }
    }
  }

  private clearContent(): void {
    for (const child of [...this.content.children]) {
      child.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.dispose();
      });
      this.content.remove(child);
    }
  }
}
