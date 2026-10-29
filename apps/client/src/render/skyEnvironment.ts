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
export function createSkyEnvironment(
  renderer: THREE.WebGLRenderer,
  top: THREE.ColorRepresentation,
  horizon: THREE.ColorRepresentation,
  ground: THREE.ColorRepresentation,
): THREE.WebGLRenderTarget {
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
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 0.1, 50);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return target;
}
