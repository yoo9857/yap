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
 * Who calls us back once per displayed frame. rAF drives the flat screen; a
 * WebXR session insists on driving its OWN frames (`renderer.setAnimationLoop`)
 * because only the headset knows when the next pose is due — so the scheduler
 * is swappable while the loop keeps its tick count and accumulator.
 */
export interface FrameScheduler {
  /** Begin calling `frame(nowMs)` every displayed frame. */
  start(frame: (nowMs: number) => void): void;
  stop(): void;
}

/** The default flat-screen scheduler. */
export class RafScheduler implements FrameScheduler {
  private id = 0;
  private frame: ((nowMs: number) => void) | null = null;

  start(frame: (nowMs: number) => void): void {
    this.frame = frame;
    const step = (nowMs: number): void => {
      if (!this.frame) return;
      // re-arm BEFORE the callback so a throw inside it can't kill the loop
      this.id = requestAnimationFrame(step);
      this.frame(nowMs);
    };
    this.id = requestAnimationFrame(step);
  }

  stop(): void {
    this.frame = null;
    cancelAnimationFrame(this.id);
  }
}

/**
 * Fixed-timestep accumulator loop. Physics always steps at SIM_DT; rendering
 * interpolates. Excess sim debt beyond MAX_STEPS_PER_FRAME is dropped rather
 * than burst-simulated.
 */
export class GameLoop {
  private readonly events = new AbortController();
  private disposed = false;
  private accumulator = 0;
  private lastTime: number | null = null;
  private tick = 0;
  private running = false;
  private scheduler: FrameScheduler;

  constructor(
    private readonly callbacks: LoopCallbacks,
    scheduler: FrameScheduler = new RafScheduler(),
  ) {
    this.scheduler = scheduler;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // never replay time that passed while hidden
        this.lastTime = null;
        this.accumulator = 0;
      }
    }, { signal: this.events.signal });
  }

  get currentTick(): number {
    return this.tick;
  }

  start(): void {
    if (this.disposed) return;
    if (this.running) return;
    this.running = true;
    this.lastTime = null;
    this.scheduler.start(this.frame);
  }

  stop(): void {
    this.running = false;
    this.scheduler.stop();
  }

  dispose(): void { this.stop(); this.disposed = true; this.events.abort(); }

  /**
   * Hand frame timing to a different source (entering/leaving VR). The tick
   * count survives — sim state must not jump — but the elapsed-time baseline is
   * dropped exactly like a tab regaining focus, so the switch costs no debt.
   */
  setScheduler(scheduler: FrameScheduler): void {
    if (scheduler === this.scheduler) return;
    const wasRunning = this.running;
    if (wasRunning) this.scheduler.stop();
    this.scheduler = scheduler;
    this.lastTime = null;
    this.accumulator = 0;
    if (wasRunning) this.scheduler.start(this.frame);
  }

  private readonly frame = (nowMs: number): void => {
    if (!this.running) return;

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
