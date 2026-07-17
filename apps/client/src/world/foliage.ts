import * as THREE from "three";

/**
 * Minecraft-style crossed-plane plant sprites (CraftYap doodle set under
 * /textures/foliage). Purely decorative: no physics, no shadows, and the
 * meshes appear only once their texture has actually loaded — a missing
 * file just means no plants, never white squares.
 */

interface SpriteDef {
  name: string;
  w: number;
  h: number;
}

const SPRITES: SpriteDef[] = [
  { name: "grass-tuft", w: 1.0, h: 0.72 },
  { name: "flower-yellow", w: 0.62, h: 0.74 },
  { name: "flower-pink", w: 0.62, h: 0.74 },
  { name: "mushroom-red", w: 0.6, h: 0.58 },
  { name: "bush-berry", w: 1.05, h: 0.85 },
];

/** Weighted pick from a uniform roll — grass is common, the rest accent. */
export function pickFoliageType(roll: number): number {
  if (roll < 0.52) return 0;
  if (roll < 0.66) return 1;
  if (roll < 0.78) return 2;
  if (roll < 0.88) return 3;
  return 4;
}

export interface FoliagePlacement {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** Index into the sprite set (use pickFoliageType). */
  type: number;
}

const textureCache = new Map<string, THREE.Texture>();

function loadSprite(name: string, onReady: (tex: THREE.Texture) => void): void {
  const cached = textureCache.get(name);
  if (cached) {
    onReady(cached);
    return;
  }
  new THREE.TextureLoader().load(`/textures/foliage/${name}.png`, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    textureCache.set(name, tex);
    onReady(tex);
  });
}

/** Two crossed unit quads, pivot at the bottom — the classic plant billboard. */
function crossedGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  // prettier-ignore
  const positions = new Float32Array([
    -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,   -0.5, 1, 0,
    0, 0, -0.5,   0, 0, 0.5,   0, 1, 0.5,   0, 1, -0.5,
  ]);
  // prettier-ignore
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
  ]);
  // prettier-ignore
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return geo;
}

/** One scattered batch of plants (per world/landmark); dispose on rebuild. */
export class FoliagePatch {
  private readonly group = new THREE.Group();
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    placements: FoliagePlacement[],
  ) {
    scene.add(this.group);

    for (let t = 0; t < SPRITES.length; t++) {
      const items = placements.filter((p) => p.type === t);
      if (items.length === 0) continue;
      const sprite = SPRITES[t]!;
      loadSprite(sprite.name, (tex) => {
        if (this.disposed) return;
        const material = new THREE.MeshLambertMaterial({
          map: tex,
          alphaTest: 0.55,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.InstancedMesh(crossedGeometry(), material, items.length);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const up = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < items.length; i++) {
          const p = items[i]!;
          q.setFromAxisAngle(up, p.yaw);
          m.compose(
            new THREE.Vector3(p.x, p.y, p.z),
            q,
            new THREE.Vector3(sprite.w * p.scale, sprite.h * p.scale, sprite.w * p.scale),
          );
          mesh.setMatrixAt(i, m);
        }
        mesh.instanceMatrix.needsUpdate = true;
        this.group.add(mesh);
      });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        (o.geometry as THREE.BufferGeometry).dispose();
        (o.material as THREE.Material).dispose(); // textures stay cached
      }
    });
  }
}
