export interface ItemAttackStep {
    from: number;
    to: number;
    active: boolean;
    started: boolean;
    completed: boolean;
    changed: boolean;
}
/** One click commits one whole strike. Holding repeats; release completes the
 * current stroke. Changing equipment or leaving attack posture cancels it. */
export class ItemAttack {
    private identity: string | null = null;
    private requested: string | null = null;
    private elapsed = 0;
    private finishAt = Infinity;
    private committedUntil = 0;
    private running = false;
    get active(): boolean { return this.running; }
    get time(): number { return this.elapsed; }
    request(identity: string): void { this.requested = identity; }
    reset(): void {
        this.identity = this.requested = null;
        this.elapsed = 0;
        this.finishAt = Infinity;
        this.committedUntil = 0;
        this.running = false;
    }
    step(dt: number, held: boolean, identity: string | null, cycle: number): ItemAttackStep {
        const changed = identity !== this.identity;
        if (changed) {
            this.identity = identity;
            this.elapsed = 0;
            this.finishAt = Infinity;
            this.committedUntil = 0;
            this.running = false;
        }
        const empty = {from: this.elapsed, to: this.elapsed, active: false, started: false, completed: false, changed};
        if (!identity || !Number.isFinite(cycle) || cycle <= 0) { this.reset(); return empty; }
        if (!Number.isFinite(dt) || dt <= 0) return {...empty, active: this.running};
        const pressed = this.requested === identity;
        this.requested = null;
        const started = !this.running && (pressed || held);
        if (started) { this.running = true; this.elapsed = 0; this.finishAt = Infinity; this.committedUntil = cycle; }
        if (!this.running) return empty;
        // Keep at most one upcoming stroke. Holding naturally consumes the
        // commitment, so releasing after a long hold adds no extra swing.
        if (pressed && !started) this.committedUntil = Math.max(this.committedUntil, (Math.floor(this.elapsed / cycle) + 2) * cycle);
        if (held) this.finishAt = Infinity;
        else this.finishAt = Math.max(this.committedUntil, cycle, Math.ceil((this.elapsed - 1e-9) / cycle) * cycle);
        const from = this.elapsed;
        this.elapsed = Math.min(this.elapsed + dt, this.finishAt);
        const completed = this.elapsed + 1e-9 >= this.finishAt;
        if (completed) this.running = false;
        return {from, to: this.elapsed, active: this.running, started, completed, changed};
    }
}
