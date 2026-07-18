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
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

export class PerfMonitor {
  private el: HTMLElement | null = null;
  private frames = 0;
  private acc = 0;
  private worst = 0;
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

  update(renderer: THREE.WebGLRenderer, frameDt: number): void {
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
    this.frames = 0;
    this.acc = 0;
    this.worst = 0;

    if (this.el) {
      this.el.textContent =
        `${s.fps.toFixed(0)} fps  ${s.avgMs.toFixed(1)}ms  worst ${s.worstMs.toFixed(0)}ms\n` +
        `draw ${s.drawCalls}  tri ${(s.triangles / 1000).toFixed(0)}k  prog ${s.programs}\n` +
        `geo ${s.geometries}  tex ${s.textures}  heap ${s.heapMB?.toFixed(0) ?? "?"}MB`;
    }
  }

  /** Last completed window — for debug hooks / automated leak checks. */
  sample(): PerfSample {
    return { ...this.current };
  }
}
