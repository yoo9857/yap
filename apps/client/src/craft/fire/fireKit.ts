/**
 * Everything of the fire drill the game itself touches, as ONE module to load.
 *
 * The drill is a theme, not the game: its code, its shaders and its hand-pose data are over a
 * megabyte that someone building in the sandbox never uses. So `craftGame.ts` only knows the
 * TYPES of these; `main.ts` imports this module when the fire theme is the one being played and
 * hands it to the game (`CraftGame` option `fireKit`). Whatever the game needs from the drill at
 * run time is exported from here — a value imported from `./fire/…` anywhere else puts the whole
 * drill back into every player's download (test/fire-split.test.ts fails on it).
 */
import { burnField, smokeField } from "./drillRules.js";
import { exitSign, stationProp } from "./fireProps.js";
import { Group } from "three";

export { FireDrill } from "./fireDrill.js";
export { fireSchoolCollision } from "./fireSchoolView.js";
// the school itself (its collision geometry alone is over a megabyte of numbers)
export { FIRE_CAMPUS, fireSchool } from "@robo/shared";

/**
 * What the drill works out once and keeps, done AHEAD of the game's construction with `pause`
 * between the pieces: where the fire spreads and the smoke goes (two searches over the school),
 * and the signs' lettering (the first text drawn with a font is slow, the running figure's most).
 * Inside the constructor they were ~100 ms of one long task (tools/profile-fire-boot.mjs,
 * 2026-11-14); the drill then finds them in their own caches.
 */
export async function primeFire(pause: () => Promise<void>): Promise<void> {
  burnField();
  await pause();
  smokeField();
  await pause();
  const scrap = new Group(); // the props are thrown away: their sign materials and shapes are what is kept
  exitSign(scrap, 0, 0, 0);
  await pause();
  for (const kind of ["alarm", "phone", "towel"] as const) scrap.add(stationProp(kind).root);
  await pause();
}
