/**
 * Looping background music from an mp3 asset. Autoplay-policy safe: if the
 * browser blocks the initial play(), it starts on the first user gesture.
 * M toggles the music (ignored while typing in an input).
 */
export class Bgm {
  private readonly el: HTMLAudioElement;
  private muted = false;

  constructor(src: string, volume = 0.35) {
    this.el = new Audio(src);
    this.el.loop = true;
    this.el.volume = volume;
    const tryPlay = () => {
      void this.el.play().catch(() => {
        /* blocked until a gesture — the unlock listeners retry */
      });
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

  toggleMute(): void {
    this.muted = !this.muted;
    this.el.muted = this.muted;
  }

  dispose(): void {
    this.el.pause();
    this.el.src = "";
  }
}
