import * as THREE from "three";

/**
 * A reflection map of the mode's own sky: blue overhead, the fog colour at the
 * horizon, grass below. Metals, gems and glass have nothing to reflect without
 * one — with only a hemisphere light and a sun, a gold block renders as a
 * brown-black slab apart from a pinpoint highlight.
 *
 * Rendered once into a tiny PMREM (a few hundred KB of GPU memory). It is
 * attached per material (`envMap`), not as `scene.environment`, so the matte
 * blocks keep exactly the light they were painted under and pay nothing.
 */
interface Prepared { pmrem: THREE.PMREMGenerator; scene: THREE.Scene; geometry: THREE.BufferGeometry; material: THREE.Material }
const prepared = new WeakMap<THREE.WebGLRenderer, Prepared>();
const held = new WeakMap<THREE.WebGLRenderer, { dispose(): void }[]>();

function prepare(top: THREE.ColorRepresentation, horizon: THREE.ColorRepresentation, ground: THREE.ColorRepresentation, renderer: THREE.WebGLRenderer): Prepared {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(top) },
      horizon: { value: new THREE.Color(horizon) },
      ground: { value: new THREE.Color(ground) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      uniform vec3 ground;
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 sky = mix(horizon, top, smoothstep(0.0, 0.5, y));
        vec3 below = mix(horizon, ground, smoothstep(0.0, -0.18, y));
        // a soft sun disc in the light's direction gives metal a warm glint; the ground is a
        // neutral warm grey, not grass: gold reflecting green reads as olive
        float sun = pow(max(dot(normalize(vDir), normalize(vec3(18.0, 35.0, 14.0))), 0.0), 64.0);
        gl_FragColor = vec4((y >= 0.0 ? sky : below) + vec3(1.0, 0.92, 0.75) * sun * 2.5, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geometry, material));
  return { pmrem: new THREE.PMREMGenerator(renderer), scene, geometry, material };
}

/**
 * Start the compile of the three programs the map is made with (the sky, the generator's
 * backdrop, its blur), well before `createSkyEnvironment` - which draws at once, so each program
 * it had to make itself was waited for with the loading screen standing still (~25 ms apiece,
 * tools/profile-fire-boot.mjs 2026-11-14). Compiled as the generator will use them: into a target
 * like its own, without tone mapping. The blur material is the generator's own (reached through
 * its private fields: a three.js that keeps them elsewhere just makes the map as before).
 */
export function warmSkyEnvironment(renderer: THREE.WebGLRenderer, top: THREE.ColorRepresentation, horizon: THREE.ColorRepresentation, ground: THREE.ColorRepresentation): void {
  if (prepared.has(renderer)) return;
  const made = prepare(top, horizon, ground, renderer);
  prepared.set(renderer, made);
  const prevTarget = renderer.getRenderTarget(), prevTone = renderer.toneMapping;
  let target: THREE.WebGLRenderTarget | null = null;
  const scrap: { dispose(): void }[] = [];
  try {
    const inner = made.pmrem as unknown as { _setSize(size: number): void; _allocateTargets(): THREE.WebGLRenderTarget; _blurMaterial: THREE.Material; _lodPlanes: THREE.BufferGeometry[] };
    inner._setSize(256); // the default size of fromScene
    target = inner._allocateTargets();
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(target);
    const flat = new THREE.OrthographicCamera(), cube = new THREE.PerspectiveCamera(90, 1, 0.1, 50);
    renderer.compile(new THREE.Mesh(inner._lodPlanes[0], inner._blurMaterial), flat);
    renderer.compile(made.scene, cube);
    // the backdrop the generator draws first (it makes a new one each time: the same parameters, the same program)
    const backdrop = new THREE.MeshBasicMaterial({ name: "PMREM.Background", side: THREE.BackSide, depthWrite: false, depthTest: false });
    const box = new THREE.BoxGeometry();
    scrap.push(backdrop, box);
    renderer.compile(new THREE.Mesh(box, backdrop), cube);
  } catch {
    // made at first use, as before
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTone;
    target?.dispose();
    held.set(renderer, scrap); // a program lives while a material holds it: kept until the map is made
  }
}

export function createSkyEnvironment(
  renderer: THREE.WebGLRenderer,
  top: THREE.ColorRepresentation,
  horizon: THREE.ColorRepresentation,
  ground: THREE.ColorRepresentation,
): THREE.WebGLRenderTarget {
  const { pmrem, scene, geometry, material } = prepared.get(renderer) ?? prepare(top, horizon, ground, renderer);
  prepared.delete(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 50);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  for (const item of held.get(renderer) ?? []) item.dispose();
  held.delete(renderer);
  return target;
}
