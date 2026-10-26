import type * as THREE from "three";

/**
 * Lightweight runtime instrumentation, always collecting (cheap counters),
 * rendered as an overlay only with `?perf=1`. `sample()` feeds the debug
 * hooks so soak tests can assert "no leaks" from real numbers instead of
 * vibes: GPU geometry/texture/program counts must plateau, heap must not
 * climb monotonically, worst-frame time catches the "순간 끊김" hitches.
 */
export interface PerfSample {
  fps: number;
  avgMs: number;
  /** Worst single frame in the last window — hitches live here. */
  worstMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMB: number | null;
  /**
   * Where the window's most expensive frame spent its time, by phase (ms of
   * main-thread work the mode reported through `phase()`). A hitch report
   * that says "render 180 ms" and one that says "fixed 180 ms" are different
   * bugs; the frame interval alone cannot tell them apart.
   */
  worstFrame: { totalMs: number; phases: Record<string, number> };
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

export class PerfMonitor {
  dispose(): void { this.el?.remove(); this.el = null; }
  private el: HTMLElement | null = null;
  private frames = 0;
  private acc = 0;
  private worst = 0;
  /** Phase times of the frame being built, and of the window's worst one. */
  private phases: Record<string, number> = {};
  private worstWork = 0;
  private worstPhases: Record<string, number> = {};
  private readonly current: PerfSample = {
    fps: 0,
    avgMs: 0,
    worstMs: 0,
    drawCalls: 0,
    triangles: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    heapMB: null,
    worstFrame: { totalMs: 0, phases: {} },
  };

  constructor(parent: HTMLElement) {
    if (new URLSearchParams(location.search).has("perf")) {
      const el = document.createElement("div");
      el.style.cssText =
        "position:fixed;left:10px;bottom:10px;z-index:60;pointer-events:none;" +
        "font:12px/1.5 Consolas,monospace;color:#d8f6ff;background:rgba(8,14,20,.78);" +
        "padding:6px 10px;border-radius:8px;white-space:pre";
      parent.appendChild(el);
      this.el = el;
    }
  }

  /** Add `ms` of work to a named phase of the current frame. */
  phase(name: string, ms: number): void {
    this.phases[name] = (this.phases[name] ?? 0) + ms;
  }

  /** Time `fn` as phase `name` (returns its result). */
  time<T>(name: string, fn: () => T): T {
    const t0 = performance.now();
    const out = fn();
    this.phase(name, performance.now() - t0);
    return out;
  }

  update(renderer: THREE.WebGLRenderer, frameDt: number): void {
    let work = 0;
    for (const ms of Object.values(this.phases)) work += ms;
    if (work > this.worstWork) {
      this.worstWork = work;
      this.worstPhases = this.phases;
    }
    this.phases = {};
    this.frames++;
    this.acc += frameDt;
    if (frameDt > this.worst) this.worst = frameDt;
    if (this.acc < 0.5) return;

    const s = this.current;
    s.fps = this.frames / this.acc;
    s.avgMs = (this.acc / this.frames) * 1000;
    s.worstMs = this.worst * 1000;
    const info = renderer.info;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
    s.programs = info.programs?.length ?? 0;
    const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
    s.heapMB = memory ? memory.usedJSHeapSize / 1048576 : null;
    s.worstFrame = { totalMs: this.worstWork, phases: this.worstPhases };
    this.frames = 0;
    this.acc = 0;
    this.worst = 0;
    this.worstWork = 0;
    this.worstPhases = {};

    if (this.el) {
      this.el.textContent =
        `${s.fps.toFixed(0)} fps  ${s.avgMs.toFixed(1)}ms  worst ${s.worstMs.toFixed(0)}ms\n` +
        `draw ${s.drawCalls}  tri ${(s.triangles / 1000).toFixed(0)}k  prog ${s.programs}\n` +
        `geo ${s.geometries}  tex ${s.textures}  heap ${s.heapMB?.toFixed(0) ?? "?"}MB
` +
        `worst work ${s.worstFrame.totalMs.toFixed(1)}ms: ` +
        Object.entries(s.worstFrame.phases)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, v]) => `${k} ${v.toFixed(1)}`)
          .join(" · ");
    }
  }

  /** Last completed window — for debug hooks / automated leak checks. */
  sample(): PerfSample {
    return { ...this.current, worstFrame: { ...this.current.worstFrame, phases: { ...this.current.worstFrame.phases } } };
  }
}
