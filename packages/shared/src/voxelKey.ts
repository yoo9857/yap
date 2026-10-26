/** Exact, compact voxel keys within ±2097 km and -128..127 height. The
 *  scrolling solo field can travel farther, so keep a lossless string fallback.
 *  22 + 22 + 8 bits fit exactly in a JavaScript number (no bitwise truncation). */
export type VoxelKey = number | string;
const AXIS = 4_194_304, OFFSET = AXIS / 2;
export function voxelKey(x: number, y: number, z: number): VoxelKey {
  if (x < -OFFSET || x >= OFFSET || z < -OFFSET || z >= OFFSET || y < -128 || y >= 128)
    return `${x},${y},${z}`;
  return ((x + OFFSET) * AXIS + z + OFFSET) * 256 + y + 128;
}
export function voxelCoordinates(key: VoxelKey): [number, number, number] {
  if (typeof key === "string") return key.split(",").map(Number) as [number, number, number];
  const column = Math.floor(key / 256);
  return [Math.floor(column / AXIS) - OFFSET, key % 256 - 128, column % AXIS - OFFSET];
}
