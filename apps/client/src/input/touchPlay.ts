/**
 * Is this a touch-only device (a phone or tablet: a coarse pointer and no fine one)? `?touch=1`
 * forces it, to check the touch layout on a PC. Read once: the answer decides how a mode is built.
 */
let cached: boolean | null = null;

export function isTouchPlay(): boolean {
  if (cached !== null) return cached;
  try {
    cached = new URLSearchParams(location.search).get("touch") === "1"
      || (matchMedia("(pointer: coarse)").matches && !matchMedia("(pointer: fine)").matches);
  } catch {
    cached = false;
  }
  return cached;
}
