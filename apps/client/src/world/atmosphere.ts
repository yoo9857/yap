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
  // ground: warm storybook day — a picture-book sky, soft golden sun
  { frac: 0.0, sky: 0x8fd3f4, fogColor: 0xc4ecfb, fogNear: 60, fogFar: 165, sunIntensity: 2.0, sunColor: 0xfff0c8, hemiIntensity: 0.92, stars: 0 },
  // sky: brighter, thinner air with a hint of high haze
  { frac: 0.35, sky: 0xa6def9, fogColor: 0xd6f0fd, fogNear: 75, fogFar: 215, sunIntensity: 2.05, sunColor: 0xfff6df, hemiIntensity: 0.85, stars: 0 },
  // ozone layer: dreamy violet-indigo, first stars blink in
  { frac: 0.65, sky: 0x3b3f96, fogColor: 0x565bb0, fogNear: 95, fogFar: 285, sunIntensity: 2.25, sunColor: 0xfff2ff, hemiIntensity: 0.58, stars: 0.4 },
  // space: deep midnight blue (not black) so the doodle stars read, cool sun
  { frac: 0.9, sky: 0x0a1233, fogColor: 0x0a1233, fogNear: 135, fogFar: 400, sunIntensity: 2.5, sunColor: 0xf2f4ff, hemiIntensity: 0.34, stars: 1 },
];

/** HUD band names — chosen by fraction, independent of the visual blend. */
const ZONE_LABELS: { upTo: number; label: string }[] = [
  { upTo: 0.3, label: "🌱 Ground" },
  { upTo: 0.6, label: "☁️ Sky" },
  { upTo: 0.85, label: "🌀 Ozone Layer" },
  { upTo: Infinity, label: "🌌 Space" },
];

const STAR_COUNT = 900;

/**
 * A hand-painted deep-space backdrop on a transparent tile: soft crayon nebula
 * clouds + scattered chalk stars. Drawn once onto the inside of the sky dome,
 * it fades in with altitude so the top of the tower sits in textured space
 * rather than a flat colour. Transparent base → it composites over the band's
 * sky colour.
 */
function makeSpaceTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const W = 1024, H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // soft nebula blobs — crayon hues, very low alpha so they read as haze
  const NEBULA = ["#7b4fd0", "#00a2ac", "#e5418f", "#0f6cbd", "#4bb54a"];
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 9; i++) {
    const cx = Math.random() * W;
    const cy = Math.random() * H;
    const r = 120 + Math.random() * 260;
    const col = NEBULA[(Math.random() * NEBULA.length) | 0]!;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, col + "44");
    g.addColorStop(0.5, col + "18");
    g.addColorStop(1, col + "00");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // stars — mostly small chalk specks, a few warm/cool glows
  ctx.globalCompositeOperation = "source-over";
  for (let i = 0; i < 620; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const s = 0.5 + Math.random() * Math.random() * 2.2;
    const warm = Math.random();
    const tint = warm < 0.15 ? "255,236,200" : warm > 0.9 ? "205,225,255" : "255,255,250";
    ctx.fillStyle = `rgba(${tint},${0.45 + Math.random() * 0.55})`;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H;
    const r = 2.5 + Math.random() * 4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, "rgba(255,255,245,0.95)");
    g.addColorStop(1, "rgba(255,255,245,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export class Atmosphere {
  private summit = 60;
  private frac = 0; // smoothed view fraction
  private readonly stars: THREE.Points;
  private readonly starMaterial: THREE.PointsMaterial;
  private readonly skyDome: THREE.Mesh;
  private readonly skyDomeMaterial: THREE.MeshBasicMaterial;
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
      color: 0xfffdf0, // faintly warm — chalk stars, not clinical white
      size: 2.8,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.stars = new THREE.Points(geo, this.starMaterial);
    this.stars.visible = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);

    // textured deep-space dome: nebula + broad stars, behind everything, fading
    // in with altitude so the summit sits in painted space, not flat colour
    this.skyDomeMaterial = new THREE.MeshBasicMaterial({
      map: makeSpaceTexture() ?? undefined,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(390, 48, 32), this.skyDomeMaterial);
    this.skyDome.renderOrder = -2;
    this.skyDome.visible = false;
    scene.add(this.skyDome);
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

    this.twinkle += dt;
    // gentle global shimmer on top of the band's star opacity
    this.starMaterial.opacity = p.stars * (0.82 + 0.18 * Math.sin(this.twinkle * 2.3));
    this.stars.visible = p.stars > 0.02;
    if (this.stars.visible) this.stars.rotation.y += dt * 0.004;

    // the painted nebula dome fades in a touch earlier than the point stars so
    // the sky gains texture through the ozone band on the way up to space
    const domeOp = Math.min(1, p.stars * 1.15);
    this.skyDomeMaterial.opacity = domeOp * 0.85;
    this.skyDome.visible = domeOp > 0.02;
    if (this.skyDome.visible) this.skyDome.rotation.y += dt * 0.003;
  }

  private twinkle = 0;

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
