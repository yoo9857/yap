import { postureTransition, type CharacterPosture } from "@robo/shared";
export interface PoseStep {
    from: CharacterPosture;
    to: CharacterPosture;
    clip: string;
    seconds: number;
    elapsed: number;
    serial: number;
}
/** Completion and reversal are independent of walk/run changes. */
export class PostureMotion {
    pose: CharacterPosture = "stand";
    transition: PoseStep | null = null;
    private requested: CharacterPosture = "stand";
    private serial = 0;
    reset(pose: CharacterPosture = "stand"): void { this.pose = pose; this.requested = pose; this.transition = null; }
    update(wanted: CharacterPosture, dt: number): PoseStep | null {
        this.requested = wanted;
        const active = this.transition;
        if (active && wanted === active.from && wanted !== active.to) {
            const reverse = postureTransition(active.to, active.from);
            if (reverse)
                this.transition = { from: active.to, to: active.from, ...reverse, elapsed: (1 - active.elapsed / active.seconds) * reverse.seconds, serial: ++this.serial };
        }
        if (!this.transition && wanted !== this.pose)
            this.begin(wanted);
        let remaining = Math.max(0, dt);
        for (let guard = 0; this.transition && guard < 3; guard++) {
            const step = this.transition, advance = Math.min(remaining, Math.max(0, step.seconds - step.elapsed));
            step.elapsed += advance;
            remaining -= advance;
            if (step.elapsed + 1e-7 < step.seconds)
                break;
            this.pose = step.to;
            this.transition = null;
            if (this.requested !== this.pose)
                this.begin(this.requested);
            if (remaining <= 1e-7)
                break;
        }
        return this.transition;
    }
    private begin(to: CharacterPosture): void {
        const spec = postureTransition(this.pose, to);
        if (spec)
            this.transition = { from: this.pose, to, ...spec, elapsed: 0, serial: ++this.serial };
        else
            this.pose = to;
    }
}
/** At or below this planar speed the clip is a walk. At or above {@link RUN_GAIT} it is a run. */
export const WALK_GAIT = 2.9;
export const RUN_GAIT = 3.5;
export function gaitBlend(speed: number): number {
    const t = Math.min(1, Math.max(0, (speed - WALK_GAIT) / (RUN_GAIT - WALK_GAIT)));
    return t * t * (3 - 2 * t);
}
/** Local stance travel per cycle: mixing these distances keeps foot speed continuous. */
export function gaitCadence(speed: number, blend = gaitBlend(speed)): number { return Math.max(0, speed) / ((.42 / .64) * (1 - blend) + (.50 / .42) * blend); }
