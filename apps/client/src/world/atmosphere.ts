import * as THREE from "three";

/**
 * Altitude-band atmosphere for the tower: the world's look is a pure function
 * of the view height (y), blended piecewise through four zones —
 * Ground → Sky → Ozone Layer → Space. Purely visual and client-side; physics,
 * networking and the level itself are untouched.
 */

interface ZoneStop {
  /** Fraction of the summit height at which this look fully applies. */
  frac: number;
  sky: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  sunIntensity: number;
  sunColor: number;
  hemiIntensity: number;
  /** 0..1 starfield opacity. */
  stars: number;
}

const STOPS: ZoneStop[] = [
  // ground: the game's classic bright day
  { frac: 0.0, sky: 0x7ec8f0, fogColor: 0x9fd8f5, fogNear: 60, fogFar: 160, sunIntensity: 2.0, sunColor: 0xfff4d6, hemiIntensity: 0.9, stars: 0 },
  // sky: thinner, paler air
  { frac: 0.35, sky: 0xa9dcf8, fogColor: 0xc3e7fa, fogNear: 70, fogFar: 210, sunIntensity: 2.05, sunColor: 0xfff8e6, hemiIntensity: 0.85, stars: 0 },
  // ozone layer: deep indigo, first stars
  { frac: 0.65, sky: 0x2e4e94, fogColor: 0x41629d, fogNear: 90, fogFar: 280, sunIntensity: 2.2, sunColor: 0xffffff, hemiIntensity: 0.6, stars: 0.35 },
  // space: near-black, harsh white sun, full starfield
  { frac: 0.9, sky: 0x05080f, fogColor: 0x05080f, fogNear: 130, fogFar: 380, sunIntensity: 2.5, sunColor: 0xffffff, hemiIntensity: 0.32, stars: 1 },
];

/** HUD band names — chosen by fraction, independent of the visual blend. */
const ZONE_LABELS: { upTo: number; label: string }[] = [
  { upTo: 0.3, label: "🌱 Ground" },
  { upTo: 0.6, label: "☁️ Sky" },
  { upTo: 0.85, label: "🌀 Ozone Layer" },
  { upTo: Infinity, label: "🌌 Space" },
];

const STAR_COUNT = 900;

export class Atmosphere {
  private summit = 60;
  private frac = 0; // smoothed view fraction
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly skyColor = new THREE.Color();
  private readonly fogColor = new THREE.Color();
  private readonly sunColor = new THREE.Color();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly sun: THREE.DirectionalLight,
    private readonly hemi: THREE.HemisphereLight,
  ) {
    // starfield shell around the tower, far outside the play column
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.acos(2 * Math.random() - 1);
      const r = 280 + Math.random() * 60;
      positions[i * 3] = r * Math.sin(v) * Math.cos(u);
      positions[i * 3 + 1] = Math.abs(r * Math.cos(v)); // upper hemisphere only
      positions[i * 3 + 2] = r * Math.sin(v) * Math.sin(u);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.starMaterial = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2.1,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.stars = new THREE.Points(geo, this.starMaterial);
    this.stars.visible = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);
  }

  /** Call on every (re)build — bands scale with the day's tower. */
  setSummit(summitHeight: number): void {
    this.summit = Math.max(1, summitHeight);
    this.stars.position.y = this.summit * 0.6;
  }

  /** HUD band label for a given height (meters). */
  zoneLabel(y: number): string {
    const f = y / this.summit;
    for (const z of ZONE_LABELS) if (f < z.upTo) return z.label;
    return ZONE_LABELS[ZONE_LABELS.length - 1]!.label;
  }

  /** Blend the world's look toward the band at view height `y` (meters). */
  update(y: number, dt: number): void {
    const target = Math.min(Math.max(y / this.summit, 0), 1);
    // frame-rate independent smoothing — respawn teleports fade, not snap
    this.frac += (target - this.frac) * (1 - Math.pow(0.002, dt));

    const p = this.paramsAt(this.frac);
    (this.scene.background as THREE.Color).copy(p.sky);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(p.fog);
    fog.near = p.fogNear;
    fog.far = p.fogFar;
    this.sun.intensity = p.sunIntensity;
    this.sun.color.copy(p.sun);
    this.hemi.intensity = p.hemiIntensity;

    this.starMaterial.opacity = p.stars;
    this.stars.visible = p.stars > 0.02;
    if (this.stars.visible) this.stars.rotation.y += dt * 0.004;
  }

  private readonly blended = {
    sky: this.skyColor,
    fog: this.fogColor,
    sun: this.sunColor,
    fogNear: 60,
    fogFar: 160,
    sunIntensity: 2,
    hemiIntensity: 0.9,
    stars: 0,
  };

  private paramsAt(frac: number) {
    const out = this.blended;
    const last = STOPS[STOPS.length - 1]!;
    let a = STOPS[0]!;
    let b = STOPS[0]!;
    let t = 0;
    if (frac >= last.frac) {
      a = b = last;
    } else {
      for (let i = 1; i < STOPS.length; i++) {
        if (frac <= STOPS[i]!.frac) {
          a = STOPS[i - 1]!;
          b = STOPS[i]!;
          t = (frac - a.frac) / (b.frac - a.frac);
          break;
        }
      }
    }
    out.sky.setHex(a.sky).lerp(this.tmp.setHex(b.sky), t);
    out.fog.setHex(a.fogColor).lerp(this.tmp.setHex(b.fogColor), t);
    out.sun.setHex(a.sunColor).lerp(this.tmp.setHex(b.sunColor), t);
    out.fogNear = a.fogNear + (b.fogNear - a.fogNear) * t;
    out.fogFar = a.fogFar + (b.fogFar - a.fogFar) * t;
    out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
    out.hemiIntensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;
    out.stars = a.stars + (b.stars - a.stars) * t;
    return out;
  }

  private readonly tmp = new THREE.Color();
}
