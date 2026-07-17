import { SIM_DT } from "@robo/shared";

export interface LoopCallbacks {
  /** Runs at exactly 60 Hz; `tick` increments by 1 per call. */
  fixedUpdate(tick: number): void;
  /** Runs once per animation frame; `alpha` ∈ [0,1) interpolates between the
   *  last two fixed ticks, `frameDt` is the real elapsed seconds. */
  render(alpha: number, frameDt: number): void;
}

const MAX_FRAME_DT = 0.25; // hidden-tab / breakpoint clamp
const MAX_STEPS_PER_FRAME = 5; // spiral-of-death guard

/**
 * Fixed-timestep accumulator loop. Physics always steps at SIM_DT; rendering
 * interpolates. Excess sim debt beyond MAX_STEPS_PER_FRAME is dropped rather
 * than burst-simulated.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime: number | null = null;
  private tick = 0;
  private rafId = 0;
  private running = false;

  constructor(private readonly callbacks: LoopCallbacks) {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // never replay time that passed while hidden
        this.lastTime = null;
        this.accumulator = 0;
      }
    });
  }

  get currentTick(): number {
    return this.tick;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    const now = nowMs / 1000;
    const frameDt = this.lastTime === null ? SIM_DT : Math.min(now - this.lastTime, MAX_FRAME_DT);
    this.lastTime = now;
    this.accumulator += frameDt;

    let steps = 0;
    while (this.accumulator >= SIM_DT) {
      if (steps >= MAX_STEPS_PER_FRAME) {
        this.accumulator = 0; // drop the debt, never burst-simulate
        break;
      }
      this.tick++;
      this.callbacks.fixedUpdate(this.tick);
      this.accumulator -= SIM_DT;
      steps++;
    }

    this.callbacks.render(this.accumulator / SIM_DT, frameDt);
  };
}
