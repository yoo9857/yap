import * as THREE from "three";

/**
 * A faint hand-drawn crayon grain on a WHITE base — a few soft strokes + specks.
 * Used as a material `map`, it multiplies the material's solid colour, so one
 * neutral texture tints to every block/character hue and the whole toy world
 * shares the same crayon-doodle surface (this is what pulls the voxel bricks
 * away from a flat Minecraft tile and into the CraftYap look).
 *
 * Cached (one GPU upload) and DOM-guarded so it no-ops in unit-test runs.
 */
let grain: THREE.Texture | null = null;

export function crayonGrain(): THREE.Texture | null {
  if (grain) return grain;
  if (typeof document === "undefined") return null;
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, S, S);
  ctx.lineWidth = 2;
  for (let i = 0; i < 48; i++) {
    ctx.strokeStyle = "rgba(0,0,0,0.05)";
    ctx.beginPath();
    const x = Math.random() * S;
    const y = Math.random() * S;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 44, y + (Math.random() - 0.5) * 44);
    ctx.stroke();
  }
  for (let i = 0; i < 280; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 1.5, 1.5);
  }
  grain = new THREE.CanvasTexture(c);
  grain.wrapS = grain.wrapT = THREE.RepeatWrapping;
  grain.colorSpace = THREE.SRGBColorSpace;
  return grain;
}
