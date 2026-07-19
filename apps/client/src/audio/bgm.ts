/**
 * Background music. Give it one track (loops) or a playlist (plays each song
 * once per shuffled cycle, then reshuffles — never the same track twice in a
 * row). Autoplay-policy safe: if the browser blocks the initial play(), it
 * starts on the first user gesture. M toggles the music (ignored while typing).
 */

/** The game's song rotation — dropped-in tracks, shuffled each cycle. */
export const BGM_PLAYLIST: readonly string[] = [
  "/audio/rea.mp3",
  "/audio/rea1.mp3",
  "/audio/rea2.mp3",
  "/audio/rea4.mp3",
];

export class Bgm {
  private readonly el: HTMLAudioElement;
  private muted = false;
  private readonly tracks: string[];
  private queue: number[] = [];

  constructor(src: string | readonly string[], volume = 0.35) {
    this.tracks = typeof src === "string" ? [src] : [...src];
    this.el = new Audio();
    this.el.volume = volume;
    this.el.loop = this.tracks.length <= 1; // single track loops; a playlist advances
    this.el.src = this.tracks[this.nextIndex()]!;
    if (this.tracks.length > 1) {
      this.el.addEventListener("ended", () => {
        this.el.src = this.tracks[this.nextIndex()]!;
        if (!this.muted) void this.el.play().catch(() => {});
      });
    }

    const tryPlay = () => {
      if (!this.muted) {
        void this.el.play().catch(() => {
          /* blocked until a gesture — the unlock listeners retry */
        });
      }
    };
    tryPlay();
    const unlock = () => {
      if (this.el.paused && !this.muted) tryPlay();
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("keydown", (e) => {
      if (e.key.toLowerCase() !== "m") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      this.toggleMute();
    });
  }

  /** Next track from a reshuffled queue (each song once per cycle). */
  private nextIndex(): number {
    if (this.queue.length === 0) this.refill();
    return this.queue.shift()!;
  }

  private refill(): void {
    const order = this.tracks.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // don't let the new cycle open with the track that just played
    const current = this.el.src;
    if (order.length > 1 && current && current.endsWith(this.tracks[order[0]!]!)) {
      [order[0], order[1]] = [order[1]!, order[0]!];
    }
    this.queue = order;
  }

  toggleMute(): void {
    this.muted = !this.muted;
    this.el.muted = this.muted;
  }

  dispose(): void {
    this.el.pause();
    this.el.src = "";
  }
}
