import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { qualityProfile } from "../../render/display.js";
import { isTouchPlay } from "../../input/touchPlay.js";
import { settings } from "../../ui/settings.js";
import { FIRE_CAMPUS, fireSchool } from "@robo/shared";
import { StaticScene } from "../staticScene.js";

/** Same physical data is compiled into the Android client. No rounding to voxel cells. */
export function fireSchoolCollision(origin:()=>readonly[number,number],camera=false):StaticScene {
  return new StaticScene([...(camera?[...FIRE_CAMPUS.cameraBoxes,...FIRE_CAMPUS.boxes]:FIRE_CAMPUS.boxes),...fireSchool().obstacles],FIRE_CAMPUS.ramps,origin);
}
/**
 * The school as the game loads it: school.min.glb — the Blender export with everything that
 * shares a material joined into one mesh (47 draw calls for 255) and its buffers meshopt-
 * compressed (1.5 MB for 6.8) — made by `node tools/optimize-fire-school.mjs`, which has to be
 * run after every export (test/fire-school-asset.test.ts fails on a stale one). The plain export
 * is the fallback.
 */
async function loadSchool(): Promise<GLTF> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const dir = "/models/environments/fire-school", v = `?v=${FIRE_CAMPUS.version}`;
  try {
    return await loader.loadAsync(`${dir}/school.min.glb${v}`);
  } catch {
    return loader.loadAsync(`${dir}/school.glb${v}`);
  }
}

/** The cheapest lit material that keeps a surface's colour, picture and see-through: for phones and the low preset. */
function liteMaterial(from: THREE.Material): THREE.Material {
  if (!(from instanceof THREE.MeshStandardMaterial)) return from;
  const lite = new THREE.MeshLambertMaterial({
    name: from.name, color: from.color, map: from.map, transparent: from.transparent, opacity: from.opacity,
    side: from.side, alphaTest: from.alphaTest, depthWrite: from.depthWrite,
    emissive: from.emissive, emissiveMap: from.emissiveMap, emissiveIntensity: from.emissiveIntensity,
    vertexColors: from.vertexColors,
  });
  from.dispose();
  return lite;
}

export class FireSchoolView {
  readonly root=new THREE.Group();
  readonly ready:Promise<void>;
  private disposed=false;
  constructor(){
    this.root.name="CraftYap fire campus";
    this.ready=loadSchool().then(g=>{
      if(this.disposed){this.free(g.scene);return;}
      g.scene.position.y=4;
      // one material per surface kind, swapped for the cheap one where the device asks for it
      const lite = qualityProfile(settings.graphics, isTouchPlay()).lite, swapped = new Map<THREE.Material, THREE.Material>();
      const fit = (m: THREE.Material): THREE.Material => {
        let to = swapped.get(m);
        if (!to) { to = lite ? liteMaterial(m) : m; swapped.set(m, to); }
        if (!to.transparent) to.shadowSide = THREE.DoubleSide;
        return to;
      };
      g.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mesh = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fit) : fit(mesh.material);
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.receiveShadow = true;
        mesh.castShadow = !mats.some((m) => m.transparent);
      });
      this.root.add(g.scene);
      const school=fireSchool(),towel=school.stations.find(s=>s.kind==="towel")!;
      const sink=new THREE.Group();sink.position.set(towel.cell[0]+.5,8.4,-2.7);
      const add=(size:readonly[number,number,number],pos:readonly[number,number,number],color:number)=>{
        const box=new THREE.Mesh(new THREE.BoxGeometry(...size),new THREE.MeshStandardMaterial({color,roughness:.5}));box.position.set(...pos);box.castShadow=box.receiveShadow=true;sink.add(box);
      };
      add([1.4,.8,.8],[0,.4,0],0x109991);add([1.5,.12,.95],[0,.88,0],0xfff9ec);add([.9,.04,.55],[0,.955,-.02],0x45b9e2);add([.1,.4,.1],[0,1.12,.28],0x536771);
      this.root.add(sink);
      const ring=new THREE.Mesh(new THREE.RingGeometry(school.assembly.r-.16,school.assembly.r,48),new THREE.MeshBasicMaterial({color:0x23a86a,side:THREE.DoubleSide,depthWrite:false}));
      ring.rotation.x=-Math.PI/2;ring.position.set(school.assembly.x,(school.assembly.y??4.15)+.006,school.assembly.z);this.root.add(ring);
    });
  }
  private free(root:THREE.Object3D):void {
    const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const mesh = o as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      geometry.add(mesh.geometry);
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
    });
    for(const m of materials){for(const value of Object.values(m) as unknown[])if(value instanceof THREE.Texture)textures.add(value);m.dispose();}
    for(const t of textures)t.dispose();for(const g of geometry)g.dispose();
  }
  dispose():void {this.disposed=true;this.free(this.root);this.root.clear();}
}
