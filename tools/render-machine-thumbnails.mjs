// Render the shipped machine kit, so selection images always match real blocks.
// Requires the client dev server: node tools/render-machine-thumbnails.mjs.
import { mkdir, writeFile, unlink, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, "apps/client/.tmp-garage");
const output = path.join(root, "apps/client/public/ui/machines");
const pagePath = path.join(scratch, "thumbnails.html");
await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
await writeFile(pagePath, `<!doctype html><html><body><script type="module">
import * as THREE from 'three';
import {MachineAssets, MachineVisual} from '/src/craft/machines/machineVisual.ts';
import {PART_ORDER, PRESETS, preset} from '/src/craft/machines/blueprint.ts';
import {PART_COLORS} from '/src/craft/machines/customization.ts';
const assets = new MachineAssets();
await assets.ready;
const scene = new THREE.Scene();
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});
renderer.setSize(256,256); renderer.setClearColor(0,0);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
scene.add(new THREE.HemisphereLight(0xfffaf0,0x60748e,2.7));
const light = new THREE.DirectionalLight(0xfff3df,3.2); light.position.set(-3,7,5); scene.add(light);
const rim = new THREE.DirectionalLight(0xb3dbff,2); rim.position.set(5,3,-4); scene.add(rim);
const camera = new THREE.OrthographicCamera(-1,1,1,-1,.01,100);
const visual = new MachineVisual(assets); scene.add(visual.root);
window.renderBlock = kind => {
  const colour = kind.startsWith('color-') ? kind.slice(6) : null;
  const blueprint = colour ? {version:1,name:kind,parts:[{kind:'frame',cell:[0,0,0],direction:0,custom:{color:colour}}]} : PART_ORDER.includes(kind) ? {version:1,name:kind,parts:[{kind,cell:[0,0,0],direction:0}]} : preset(kind);
  visual.rebuild(blueprint);
  for (const mesh of visual.meshes) mesh.computeBoundingBox();
  const bounds = new THREE.Box3().setFromObject(visual.root), centre = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x,size.y,size.z) * .85;
  camera.left = camera.bottom = -radius; camera.right = camera.top = radius;
  camera.position.copy(centre).add(new THREE.Vector3(3,2.2,4).normalize().multiplyScalar(10));
  camera.lookAt(centre); camera.updateProjectionMatrix(); renderer.render(scene,camera);
  return renderer.domElement.toDataURL('image/webp',.96).split(',')[1];
};
window.blockKinds = [...PART_ORDER, ...PRESETS.map(preset => preset.kind), ...Object.keys(PART_COLORS).map(colour => 'color-' + colour)];
</script></body></html>`);

const browser = await puppeteer.launch({
  executablePath: process.env.BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
});
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.BASE_URL ?? "http://127.0.0.1:5173"}/.tmp-garage/thumbnails.html`, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.blockKinds, { timeout: 60000 });
  for (const kind of await page.evaluate(() => window.blockKinds)) {
    const image = await page.evaluate(kind => window.renderBlock(kind), kind);
    const bytes = Buffer.from(image, "base64");
    await writeFile(path.join(output, `${kind}.webp`), bytes);
    console.log(`${kind}: ${bytes.length} bytes`);
  }
} finally {
  await browser.close();
  await unlink(pagePath);
  await rmdir(scratch);
}
