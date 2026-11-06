/**
 * The mini-games' motion kit: particles, a verlet rope, damped springs, tweens and a screen shake —
 * small, allocation-light, driven by the game window's own animation frame. SVG only.
 */
const NS = "http://www.w3.org/2000/svg";

export const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
};

// ------------------------------------------------------------------ easing / tween

export const ease = {
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  outBack: (t: number) => {
    const c = 1.9;
    return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
  },
  inOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
};

interface Tween {
  t: number;
  dur: number;
  step: (k: number) => void;
  done?: () => void;
}

/** Tweens that run inside the window's frame (no timers of their own). */
export class Tweens {
  private list: Tween[] = [];
  add(dur: number, step: (k: number) => void, done?: () => void): void {
    this.list.push({ t: 0, dur, step, done });
  }
  update(dt: number): void {
    if (!this.list.length) return;
    const keep: Tween[] = [];
    for (const tw of this.list) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.step(k);
      if (k < 1) keep.push(tw);
      else tw.done?.();
    }
    this.list = keep;
  }
  clear(): void {
    this.list = [];
  }
}

// ------------------------------------------------------------------ spring

/** A damped spring toward a target (a needle that overshoots and settles, a rod that bounces). */
export class Spring {
  vel = 0;
  constructor(public value: number, public target: number, private readonly k = 120, private readonly damp = 12) {}
  update(dt: number): number {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vel += ((this.target - this.value) * this.k - this.vel * this.damp) * h;
      this.value += this.vel * h;
    }
    return this.value;
  }
}

// ------------------------------------------------------------------ particles

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  r: number;
  g: number;
  node: SVGCircleElement;
}

export interface BurstOptions {
  count: number;
  colours: string[];
  speed: [number, number];
  /** Spread around `angle` (radians); a full circle by default. */
  angle?: number;
  spread?: number;
  gravity?: number;
  life?: [number, number];
  size?: [number, number];
}

/** A pooled particle layer: bursts of soft dots (dirt, sparks, zaps, wind). */
export class Particles {
  private live: Particle[] = [];
  private pool: SVGCircleElement[] = [];
  constructor(private readonly layer: SVGGElement) {}
  burst(x: number, y: number, o: BurstOptions): void {
    const rnd = (a: [number, number]) => a[0] + Math.random() * (a[1] - a[0]);
    for (let i = 0; i < o.count; i++) {
      const a = (o.angle ?? 0) + (Math.random() - 0.5) * (o.spread ?? Math.PI * 2);
      const v = rnd(o.speed);
      const node = this.pool.pop() ?? svgEl("circle", {}, this.layer);
      node.setAttribute("fill", o.colours[i % o.colours.length]!);
      node.style.display = "";
      const max = rnd(o.life ?? [0.5, 0.9]);
      this.live.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: max, max, r: rnd(o.size ?? [5, 11]), g: o.gravity ?? 900, node });
    }
  }
  update(dt: number): void {
    if (!this.live.length) return;
    const keep: Particle[] = [];
    for (const p of this.live) {
      p.life -= dt;
      if (p.life <= 0) {
        p.node.style.display = "none";
        this.pool.push(p.node);
        continue;
      }
      p.vy += p.g * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      p.node.setAttribute("cx", p.x.toFixed(1));
      p.node.setAttribute("cy", p.y.toFixed(1));
      p.node.setAttribute("r", (p.r * (0.4 + 0.6 * k)).toFixed(1));
      p.node.setAttribute("opacity", Math.min(1, k * 1.6).toFixed(2));
      keep.push(p);
    }
    this.live = keep;
  }
}

// ------------------------------------------------------------------ rope

/**
 * A hanging cable: verlet points between a fixed start and a moving end, with gravity — it swings
 * when its end is dragged and settles in a sag. `d()` is a smooth SVG path through the points.
 */
export class Rope {
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  /** `stiff` (0‥0.5) is a bending stiffness: a real cable curves, it does not fold into a V. */
  constructor(private readonly n: number, ax: number, ay: number, bx: number, by: number, private slack = 1.12, private readonly gravity = 1600, private readonly stiff = 0) {
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      this.x[i] = this.px[i] = ax + (bx - ax) * k;
      this.y[i] = this.py[i] = ay + (by - ay) * k;
    }
  }
  /**
   * Pin both ends (start: the socket; end: the plug/clip) and step the physics. A lead pins the
   * point next to an end along a direction, so the cable leaves that end straight (a socket's
   * outlet, a plug's strain relief) instead of folding at it.
   */
  update(dt: number, ax: number, ay: number, bx: number, by: number, leadA?: { dx: number; dy: number }, leadB?: { dx: number; dy: number }): void {
    const n = this.n;
    const h = Math.min(dt, 1 / 30);
    for (let i = 1; i < n - 1; i++) {
      const vx = (this.x[i]! - this.px[i]!) * 0.985;
      const vy = (this.y[i]! - this.py[i]!) * 0.985;
      this.px[i] = this.x[i]!;
      this.py[i] = this.y[i]!;
      this.x[i] = this.x[i]! + vx;
      this.y[i] = this.y[i]! + vy + this.gravity * h * h;
    }
    this.x[0] = ax;
    this.y[0] = ay;
    this.x[n - 1] = bx;
    this.y[n - 1] = by;
    const seg = (Math.hypot(bx - ax, by - ay) * this.slack + (this.stiff > 0 ? 8 : 30)) / (n - 1);
    for (let it = 0; it < 14; it++) {
      for (let i = 0; i < n - 1; i++) {
        const dx = this.x[i + 1]! - this.x[i]!;
        const dy = this.y[i + 1]! - this.y[i]!;
        const d = Math.hypot(dx, dy) || 1e-6;
        const diff = (d - seg) / d / 2;
        const ox = dx * diff;
        const oy = dy * diff;
        if (i > 0) {
          this.x[i] = this.x[i]! + ox;
          this.y[i] = this.y[i]! + oy;
        }
        if (i + 1 < n - 1) {
          this.x[i + 1] = this.x[i + 1]! - ox;
          this.y[i + 1] = this.y[i + 1]! - oy;
        }
      }
      this.x[0] = ax;
      this.y[0] = ay;
      this.x[n - 1] = bx;
      this.y[n - 1] = by;
      // leads are springs, not pins: a pinned point made the whole turn in one segment (a kink)
      if (leadA) {
        this.x[1] = this.x[1]! + (ax + leadA.dx - this.x[1]!) * 0.5;
        this.y[1] = this.y[1]! + (ay + leadA.dy - this.y[1]!) * 0.5;
      }
      if (leadB) {
        this.x[n - 2] = this.x[n - 2]! + (bx + leadB.dx - this.x[n - 2]!) * 0.5;
        this.y[n - 2] = this.y[n - 2]! + (by + leadB.dy - this.y[n - 2]!) * 0.5;
      }
      if (this.stiff > 0) {
        // bending: pull each free point toward the midpoint of its neighbours
        const lo = 1;
        const hi = n - 2;
        for (let i = lo; i <= hi; i++) {
          this.x[i] = this.x[i]! + ((this.x[i - 1]! + this.x[i + 1]!) / 2 - this.x[i]!) * this.stiff;
          this.y[i] = this.y[i]! + ((this.y[i - 1]! + this.y[i + 1]!) / 2 - this.y[i]!) * this.stiff;
        }
      }
    }
  }
  /** The direction the cable arrives at its end from (unit vector, end - a few points back). */
  endDir(back = 3): { x: number; y: number } {
    const n = this.n;
    const dx = this.x[n - 1]! - this.x[n - 1 - back]!;
    const dy = this.y[n - 1]! - this.y[n - 1 - back]!;
    const d = Math.hypot(dx, dy) || 1;
    return { x: dx / d, y: dy / d };
  }
  d(): string {
    const n = this.n;
    let s = `M ${this.x[0]!.toFixed(1)} ${this.y[0]!.toFixed(1)}`;
    for (let i = 1; i < n - 1; i++) {
      const mx = (this.x[i]! + this.x[i + 1]!) / 2;
      const my = (this.y[i]! + this.y[i + 1]!) / 2;
      s += ` Q ${this.x[i]!.toFixed(1)} ${this.y[i]!.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    s += ` L ${this.x[n - 1]!.toFixed(1)} ${this.y[n - 1]!.toFixed(1)}`;
    return s;
  }
  setSlack(s: number): void {
    this.slack = s;
  }
}

// ------------------------------------------------------------------ shake

/** A decaying shake applied to an element's transform. */
export class Shake {
  private amp = 0;
  constructor(private readonly target: SVGElement | HTMLElement) {}
  kick(amount: number): void {
    this.amp = Math.max(this.amp, amount);
  }
  update(dt: number): void {
    if (this.amp <= 0.2) {
      if (this.amp > 0) {
        this.target.style.transform = "";
        this.amp = 0;
      }
      return;
    }
    const x = (Math.random() - 0.5) * 2 * this.amp;
    const y = (Math.random() - 0.5) * 2 * this.amp;
    this.target.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.amp *= Math.exp(-14 * dt);
  }
}

// ------------------------------------------------------------------ flow along a path

/** Glowing dots running along an SVG path (electrons in a wire); `rate` 0 hides them. */
export class Flow {
  private readonly dots: SVGCircleElement[] = [];
  private phase = 0;
  constructor(layer: SVGGElement, private readonly path: SVGPathElement, count: number, colour = "#fff27a", r = 7) {
    for (let i = 0; i < count; i++) this.dots.push(svgEl("circle", { r, fill: colour, opacity: 0 }, layer));
  }
  update(dt: number, rate: number): void {
    let len = 0;
    try {
      len = this.path.getTotalLength();
    } catch {
      len = 0;
    }
    this.phase = (this.phase + dt * rate) % 1;
    this.dots.forEach((d, i) => {
      if (rate <= 0.01 || len <= 0) {
        d.setAttribute("opacity", "0");
        return;
      }
      const k = (this.phase + i / this.dots.length) % 1;
      const p = this.path.getPointAtLength(k * len);
      d.setAttribute("cx", p.x.toFixed(1));
      d.setAttribute("cy", p.y.toFixed(1));
      d.setAttribute("opacity", Math.min(1, rate).toFixed(2));
    });
  }
}
