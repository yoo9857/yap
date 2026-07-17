/** Immutable per-tick input sample. Axes are raw (rotated by camera yaw in
 *  the controller): x = strafe right, z = forward. */
export interface InputFrame {
  moveX: number;
  moveZ: number;
  jumpHeld: boolean;
  /** True if a jump press EDGE happened since the previous sample — presses
   *  between ticks are never lost, preserving the prototype's jump buffer. */
  jumpPressed: boolean;
  respawnPressed: boolean;
}

export interface InputSource {
  /** Additive contribution to the current frame. */
  read(frame: MutableInputFrame): void;
}

export interface MutableInputFrame {
  moveX: number;
  moveZ: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
  respawnPressed: boolean;
}

export class InputState {
  private readonly sources: InputSource[] = [];

  addSource(source: InputSource): void {
    this.sources.push(source);
  }

  /** Drains edge flags from all sources into one immutable frame. */
  sample(): InputFrame {
    const frame: MutableInputFrame = {
      moveX: 0,
      moveZ: 0,
      jumpHeld: false,
      jumpPressed: false,
      respawnPressed: false,
    };
    for (const s of this.sources) s.read(frame);
    frame.moveX = Math.max(-1, Math.min(1, frame.moveX));
    frame.moveZ = Math.max(-1, Math.min(1, frame.moveZ));
    return frame;
  }
}
