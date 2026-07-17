import * as THREE from "three";
import { BRICK_COLORS } from "@robo/shared";

/** Shared material cache — one material per color, reused across meshes. */
const cache = new Map<string, THREE.MeshStandardMaterial>();

/**
 * CraftYap doodle block tile for each palette color (crayon fill + chunky
 * ink outline, generated set under /textures/blocks). The map is attached
 * asynchronously; until it loads — or if it never does — the flat color
 * stands in, never a black face.
 */
const DOODLE_TILES: Record<string, string> = {
  // rainbow obby bricks → wool tiles of the same hue
  "#e2231a": "red-wool",
  "#f5802b": "orange-wool",
  "#f9d71c": "yellow-wool",
  "#4bb54a": "green-wool",
  "#00a2ac": "diamond-block",
  "#0f6cbd": "blue-wool",
  "#7b4fd0": "purple-wool",
  "#e5418f": "pink-wool",
  // platform roles
  "#3ea33b": "grass-top",
  "#b8bcc2": "stone-bricks",
  "#ffd21c": "gold-block",
};

export function brickMaterial(hex: string): THREE.MeshStandardMaterial {
  let m = cache.get(hex);
  if (!m) {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: 0.75,
      metalness: 0.05,
    });
    const tile = DOODLE_TILES[hex.toLowerCase()];
    if (tile && typeof document !== "undefined") {
      new THREE.TextureLoader().load(`/textures/blocks/${tile}.png`, (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        material.map = tex;
        material.color.set(0xffffff); // the tile carries the hue
        material.needsUpdate = true;
      });
    }
    cache.set(hex, material);
    m = material;
  }
  return m;
}

export function brickColorByIndex(index: number): string {
  return BRICK_COLORS[index % BRICK_COLORS.length] ?? BRICK_COLORS[0];
}

export const ROLE_COLORS = {
  ground: "#3ea33b",
  checkpoint: "#b8bcc2",
  winner: "#ffd21c",
} as const;

/** Crumbling platforms wear visible cracks — the "this brick betrays you"
 *  cue that used to be carried by the (removed) studs. */
export const CRACKED_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0xa7adb3,
  roughness: 0.85,
  metalness: 0.02,
});

export const LAVA_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x8f1408,
  emissive: 0xff5a1f,
  emissiveIntensity: 0.85,
  roughness: 0.5,
});

// async texture attach for the shared specials
// (guarded: this module is also imported in DOM-free unit-test runs)
if (typeof document !== "undefined") {
  new THREE.TextureLoader().load("/textures/blocks/cracked-stone-bricks.png", (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    CRACKED_MATERIAL.map = tex;
    CRACKED_MATERIAL.color.set(0xffffff);
    CRACKED_MATERIAL.needsUpdate = true;
  });
  new THREE.TextureLoader().load("/textures/blocks/lava.png", (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    LAVA_MATERIAL.map = tex;
    LAVA_MATERIAL.emissiveMap = tex;
    LAVA_MATERIAL.color.set(0xffffff);
    LAVA_MATERIAL.emissive.set(0xffffff);
    LAVA_MATERIAL.emissiveIntensity = 0.6;
    LAVA_MATERIAL.needsUpdate = true;
  });
}
