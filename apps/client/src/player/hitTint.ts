import * as THREE from "three";

/**
 * A light red wash over a character who was just tapped. `amount` is 1 at
 * the hit and 0 when it has faded. The hue stays: yellow goes warm, it does
 * not become a flat red.
 */
export function hitTint(
  base: { r: number; g: number; b: number },
  amount: number,
): { r: number; g: number; b: number } {
  const k = Math.min(1, Math.max(0, amount));
  return {
    r: Math.min(1, base.r * (1 - k) + k),
    g: base.g * (1 - 0.42 * k),
    b: base.b * (1 - 0.48 * k),
  };
}

interface SavedColor {
  color: THREE.Color;
  emissive: THREE.Color;
  intensity: number;
}

const saved = new WeakMap<THREE.MeshStandardMaterial, SavedColor>();

/**
 * Paint `root` for this frame, then put the calm colours back when `amount`
 * is 0. The worn material stays on the mesh — a swapped material type drops
 * the skinned program and the body stops drawing. Three uploads `color` on
 * the next draw: every render starts with no current material, and `id` is
 * read-only so it cannot be bumped to force that.
 */
export function applyHitFlash(root: THREE.Object3D, amount: number): void {
  const k = Math.min(1, Math.max(0, amount));
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || Array.isArray(obj.material)) return;
    const mat: unknown = obj.material;
    if (!(mat instanceof THREE.MeshStandardMaterial)) return;
    let base = saved.get(mat);
    if (k <= 0) {
      if (!base) return;
      mat.color.copy(base.color);
      mat.emissive.copy(base.emissive);
      mat.emissiveIntensity = base.intensity;
      saved.delete(mat);
      return;
    }
    if (!base) {
      base = {
        color: mat.color.clone(),
        emissive: mat.emissive.clone(),
        intensity: mat.emissiveIntensity,
      };
      saved.set(mat, base);
    }
    const tint = hitTint(base.color, k);
    mat.color.setRGB(tint.r, tint.g, tint.b);
    const glow = hitTint(base.emissive, k);
    mat.emissive.setRGB(glow.r, glow.g, glow.b);
  });
}

/** Put any in-progress wash back. Used when a rig is disposed or swapped. */
export function releaseHitFlash(root: THREE.Object3D): void {
  applyHitFlash(root, 0);
}
