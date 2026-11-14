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
import { fireSchool } from "@robo/shared";
import { FireFx } from "./fireFx.js";
import { primeBadges } from "./fireDrill.js";
import { primeQuizBoard } from "./quizBoard.js";
import { fireSchoolCollision } from "./fireSchoolView.js";
import { isTouchPlay } from "../../input/touchPlay.js";

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
  // the search trees over the campus's collision boxes (kept: the game's two scenes share them)
  fireSchoolCollision(() => [0, 0]);
  await pause();
  fireSchoolCollision(() => [0, 0], true);
  await pause();
  // the first emoji and the first line in the board's font
  primeBadges();
  await pause();
  primeQuizBoard(isTouchPlay());
  await pause();
}

/**
 * The fire's effects (flames, smoke columns, sparks scattered over the room: ~25 ms), made before
 * the game is: hand them to it as `fireFx`, and the drill it builds takes them over.
 */
export function makeFireFx(): FireFx {
  return new FireFx(fireSchool());
}
