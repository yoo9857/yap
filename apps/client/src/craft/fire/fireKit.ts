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
export { FireDrill } from "./fireDrill.js";
export { fireSchoolCollision } from "./fireSchoolView.js";
// the school itself (its collision geometry alone is over a megabyte of numbers)
export { FIRE_CAMPUS, fireSchool } from "@robo/shared";
