import { stepBody, type Body } from "../craft/voxelBody.js";
import type { VoxelWorld } from "../craft/voxelWorld.js";
import { EYE_HEIGHT, FIRE_COOLDOWN, alive, hasLineOfSight, type Fighter } from "./combat.js";
import { insideZone } from "./zone.js";

/**
 * Bot brains — a tiny FSM per bot: stay inside the storm first, otherwise
 * hunt the nearest visible enemy (strafing while shooting), otherwise wander.
 * Deliberately imperfect: aim error and slow trigger keep it arcade-fair.
 * The rng is injected so tests can be deterministic.
 */

export interface BotShot {
  shooter: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface Bot {
  body: Body;
  hp: number;
  cooldown: number;
  wanderDir: number;
  wanderLeft: number;
  strafeSign: number;
  /** index into the shared fighters array */
  index: number;
}

export const BOT_COUNT = 7;
const HUNT_RANGE = 17;
const BOT_FIRE_COOLDOWN = FIRE_COOLDOWN * 3; // slower trigger than the player
const AIM_ERROR = 0.09;

export function makeBot(index: number, x: number, y: number, z: number): Bot {
  return {
    body: { x, y, z, vx: 0, vy: 0, vz: 0, grounded: false },
    hp: 3,
    cooldown: 1 + index * 0.13, // stagger the first shots
    wanderDir: (index / BOT_COUNT) * Math.PI * 2,
    wanderLeft: 0,
    strafeSign: index % 2 === 0 ? 1 : -1,
    index,
  };
}

export const botFighter = (bot: Bot): Fighter => ({
  x: bot.body.x,
  y: bot.body.y,
  z: bot.body.z,
  hp: bot.hp,
});

/** Nearest LIVE fighter (any index but the bot's own). */
function nearestEnemy(bot: Bot, fighters: readonly Fighter[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < fighters.length; i++) {
    if (i === bot.index || !alive(fighters[i]!)) continue;
    const f = fighters[i]!;
    const d = Math.hypot(f.x - bot.body.x, f.z - bot.body.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Advance one bot by dt. Returns a shot request when the bot pulls the
 * trigger (the caller resolves it through combat.resolveShot so bots obey
 * exactly the same rules as the player).
 */
export function stepBot(
  world: VoxelWorld,
  bot: Bot,
  fighters: readonly Fighter[],
  zone: { cx: number; cz: number; radius: number },
  dt: number,
  rng: () => number,
): BotShot | null {
  if (bot.hp <= 0) return null;
  bot.cooldown = Math.max(0, bot.cooldown - dt);

  let wishX = 0;
  let wishZ = 0;
  let shot: BotShot | null = null;

  const outside = !insideZone(bot.body.x, bot.body.z, zone.cx, zone.cz, zone.radius - 1);
  const targetIndex = nearestEnemy(bot, fighters);
  const target = targetIndex >= 0 ? fighters[targetIndex]! : null;
  const targetDist = target ? Math.hypot(target.x - bot.body.x, target.z - bot.body.z) : Infinity;

  if (outside) {
    // storm first: run for the center
    const dx = zone.cx - bot.body.x;
    const dz = zone.cz - bot.body.z;
    const len = Math.hypot(dx, dz) || 1;
    wishX = dx / len;
    wishZ = dz / len;
  } else if (target && targetDist < HUNT_RANGE && hasLineOfSight(world, botFighter(bot), target)) {
    // strafe around the target, keep ~7m
    const dx = target.x - bot.body.x;
    const dz = target.z - bot.body.z;
    const len = Math.hypot(dx, dz) || 1;
    const toward = targetDist > 8 ? 0.8 : targetDist < 5 ? -0.6 : 0;
    wishX = (dx / len) * toward + (-dz / len) * bot.strafeSign * 0.8;
    wishZ = (dz / len) * toward + (dx / len) * bot.strafeSign * 0.8;
    if (rng() < 0.02) bot.strafeSign *= -1;

    if (bot.cooldown <= 0) {
      bot.cooldown = BOT_FIRE_COOLDOWN * (0.8 + rng() * 0.6);
      const ay = target.y + EYE_HEIGHT * 0.7 - (bot.body.y + EYE_HEIGHT);
      const dist = Math.hypot(dx, ay, dz) || 1;
      shot = {
        shooter: bot.index,
        dx: dx / dist + (rng() - 0.5) * AIM_ERROR,
        dy: ay / dist + (rng() - 0.5) * AIM_ERROR,
        dz: dz / dist + (rng() - 0.5) * AIM_ERROR,
      };
    }
  } else {
    // wander
    bot.wanderLeft -= dt;
    if (bot.wanderLeft <= 0) {
      bot.wanderLeft = 1.5 + rng() * 2.5;
      bot.wanderDir += (rng() - 0.5) * Math.PI;
    }
    wishX = Math.sin(bot.wanderDir) * 0.7;
    wishZ = Math.cos(bot.wanderDir) * 0.7;
  }

  // hop when a wall blocks the way
  const aheadX = Math.floor(bot.body.x + wishX * 0.8);
  const aheadZ = Math.floor(bot.body.z + wishZ * 0.8);
  const feetY = Math.floor(bot.body.y + 0.1);
  const blocked = world.isSolid(aheadX, feetY, aheadZ) && !world.isSolid(aheadX, feetY + 1, aheadZ);
  stepBody(world, bot.body, dt, wishX, wishZ, blocked && bot.body.grounded);
  return shot;
}
