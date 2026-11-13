import * as THREE from "three";

type Spray = { from: THREE.Vector3; dir: THREE.Vector3; len: number };

interface Puff {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  velocity: THREE.Vector3;
  travel: number;
  range: number;
  size: number;
  age: number;
  lifetime: number;
  seed: number;
  settled: boolean;
}

const CAPACITY = 448;
const EMISSION_RATE = 340;

/** Each puff retains the nozzle pose at emission, including when the user sweeps or releases. */
export class ExtinguisherPowder {
  readonly root: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  private readonly puffs: Puff[] = Array.from({length: CAPACITY}, () => ({
    position: new THREE.Vector3(), direction: new THREE.Vector3(), velocity: new THREE.Vector3(),
    travel: 0, range: 0, size: 0, age: 0, lifetime: 0, seed: 0, settled: false,
  }));
  private readonly centres = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
  private readonly shapes = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly depthAxis = new THREE.Vector3(0, 0, 1);
  private readonly radial = new THREE.Vector3();
  private readonly previousFrom = new THREE.Vector3();
  private readonly previousDir = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly sortOrder: Puff[] = [];
  private cursor = 0;
  private spawnBudget = 0;
  private wasSpraying = false;
  private sequence = 1;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(quad.index);
    geometry.setAttribute("position", quad.getAttribute("position"));
    geometry.setAttribute("uv", quad.getAttribute("uv"));
    geometry.setAttribute("aCentre", this.centres.setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("aShape", this.shapes.setUsage(THREE.DynamicDrawUsage));
    geometry.instanceCount = 0;
    quad.dispose();
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      vertexShader: `
        attribute vec3 aCentre;
        attribute vec4 aShape;
        varying vec2 vUv;
        varying vec3 vDust;
        void main() {
          vec4 centre = modelViewMatrix * vec4(aCentre, 1.0);
          centre.xy += position.xy * aShape.x;
          gl_Position = projectionMatrix * centre;
          vUv = uv;
          vDust = aShape.yzw;
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying vec3 vDust;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),f.x),
                     mix(hash(i+vec2(0.0,1.0)),hash(i+1.0),f.x),f.y);
        }
        void main() {
          vec2 p = vUv*2.0-1.0;
          float lobes = noise(p*3.4+vec2(vDust.y*83.0, vDust.z*1.8));
          float detail = noise(p*8.0+vDust.y*41.0-vDust.z);
          float r = length(p) + (lobes-0.5)*0.28;
          float density = (1.0-smoothstep(0.04,0.94,r)) * (0.68+0.32*detail);
          float alpha = density*vDust.x;
          if (alpha<0.002) discard;
          vec3 shadow = vec3(0.60,0.57,0.51);
          vec3 lit = vec3(1.0,0.97,0.86);
          vec3 colour = mix(shadow,lit,clamp(0.72+p.y*0.22+lobes*0.19,0.0,1.0));
          gl_FragColor = vec4(colour,alpha);
        }`,
    });
    this.root = new THREE.Mesh(geometry, material);
    this.root.name = "ABC powder plume";
    this.root.frustumCulled = false;
    this.root.visible = false;
  }

  private emit(from: THREE.Vector3, direction: THREE.Vector3, range: number, age: number): void {
    const puff = this.puffs[this.cursor]!;
    this.cursor = (this.cursor + 1) % CAPACITY;
    const seed = this.sequence++;
    const spread = Math.sqrt((seed * 0.754877666) % 1);
    const angle = seed * 2.39996323;
    const speed = range * (3.4 + (seed * 0.56984029) % 1 * 2.2);
    this.right.crossVectors(direction, Math.abs(direction.y) > .95 ? this.depthAxis : THREE.Object3D.DEFAULT_UP).normalize();
    this.up.crossVectors(this.right, direction);
    this.radial.copy(this.right).multiplyScalar(Math.cos(angle)).addScaledVector(this.up, Math.sin(angle));
    const scale = THREE.MathUtils.clamp(range * .58, .35, 1);
    puff.position.copy(from).addScaledVector(this.radial, .006 * scale * spread);
    puff.direction.copy(direction);
    puff.velocity.copy(direction).multiplyScalar(speed).addScaledVector(this.radial, speed * (.042 + spread * .133));
    puff.range = range * (.88 + ((seed * .31830989) % 1) * .12);
    puff.travel = 0;
    puff.age = 0;
    puff.lifetime = .64 + ((seed * .618033989) % 1) * .56;
    puff.size = scale * (.018 + spread * .015);
    puff.seed = (seed * .381966011) % 1;
    puff.settled = false;
    this.move(puff, age);
  }

  private move(puff: Puff, dt: number): void {
    puff.age += dt;
    if (puff.age >= puff.lifetime) return;
    const forwardSpeed = puff.velocity.dot(puff.direction);
    if (!puff.settled && forwardSpeed * dt >= puff.range - puff.travel) {
      const impactTime = (puff.range - puff.travel) / Math.max(forwardSpeed, 1e-5);
      puff.position.addScaledVector(puff.velocity, impactTime);
      puff.velocity.addScaledVector(puff.direction, -forwardSpeed).multiplyScalar(.36);
      puff.velocity.y += .08;
      puff.settled = true;
      dt -= impactTime;
    } else {
      puff.travel += Math.max(0, forwardSpeed) * dt;
    }
    puff.position.addScaledVector(puff.velocity, dt);
    puff.velocity.multiplyScalar(Math.exp(-(puff.settled ? 4.7 : 1.8) * dt));
    puff.velocity.y -= (puff.settled ? .16 : .26) * dt;
  }

  update(dt: number, spray: Spray | null, enabled = true, cameraPosition?: THREE.Vector3): void {
    if (!enabled) {
      for (const puff of this.puffs) puff.lifetime = 0;
      this.wasSpraying = false;
      this.spawnBudget = 0;
      this.root.visible = false;
      return;
    }
    const elapsed = Math.min(dt, .08);
    for (const puff of this.puffs) if (puff.age < puff.lifetime) this.move(puff, elapsed);
    if (spray) {
      const range = THREE.MathUtils.clamp(spray.len, .09, 4.7);
      if (!this.wasSpraying) {
        this.previousFrom.copy(spray.from);
        this.previousDir.copy(spray.dir);
        this.spawnBudget = 3;
      }
      this.spawnBudget += elapsed * EMISSION_RATE;
      const count = Math.floor(this.spawnBudget);
      this.spawnBudget -= count;
      for (let i = 0; i < count; i++) {
        const fraction = (i + .5) / count;
        this.from.copy(this.previousFrom).lerp(spray.from, fraction);
        this.dir.copy(this.previousDir).lerp(spray.dir, fraction).normalize();
        this.emit(this.from, this.dir, range, elapsed * (1 - fraction));
      }
      this.previousFrom.copy(spray.from);
      this.previousDir.copy(spray.dir);
    }
    this.wasSpraying = spray !== null;

    const ordered = this.sortOrder;
    ordered.length = 0;
    for (const puff of this.puffs) if (puff.age < puff.lifetime) ordered.push(puff);
    if (cameraPosition) {
      this.cameraPosition.copy(cameraPosition);
      ordered.sort((a, b) => b.position.distanceToSquared(this.cameraPosition) - a.position.distanceToSquared(this.cameraPosition));
    }
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i]!;
      const remaining = 1 - p.age / p.lifetime;
      const expansion = p.age * (.08 + p.range * .11) + (p.settled ? p.age * .095 : 0);
      this.centres.setXYZ(i, p.position.x, p.position.y, p.position.z);
      this.shapes.setXYZW(i, p.size + expansion, Math.pow(remaining, 1.35) * (p.settled ? .55 : .86), p.seed, p.age);
    }
    this.centres.needsUpdate = this.shapes.needsUpdate = true;
    this.root.geometry.instanceCount = ordered.length;
    this.root.visible = ordered.length > 0;
  }

  dispose(): void {
    this.root.geometry.dispose();
    this.root.material.dispose();
  }
}
