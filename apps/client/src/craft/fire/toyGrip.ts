import * as THREE from "three";
import surface from "./characterGrip.json";
import rightSurface from "./characterGripRight.json";

/** One fingerless cartoon puff and its thick wrist share a continuous surface. */
export const MITTEN = new THREE.BufferGeometry();
MITTEN.setAttribute("position", new THREE.Float32BufferAttribute(surface.positions, 3));
MITTEN.setAttribute("normal", new THREE.Float32BufferAttribute(surface.normals, 3));
MITTEN.setIndex(surface.indices);
MITTEN.computeBoundingSphere();

export const RIGHT_MITTEN = new THREE.BufferGeometry();
RIGHT_MITTEN.setAttribute("position",new THREE.Float32BufferAttribute(rightSurface.positions,3));
RIGHT_MITTEN.setAttribute("normal",new THREE.Float32BufferAttribute(rightSurface.normals,3));
RIGHT_MITTEN.setIndex(rightSurface.indices);
function forearmWeights(positions:number[]): {reach:Float32Array;bend:Float32Array} {
  const reach=new Float32Array(positions.length/3),bend=new Float32Array(reach.length);
  for(let i=0;i<reach.length;i++) {
    const distance=Math.max(0,-positions[i*3]!-.015);
    bend[i]=1-Math.exp(-distance/.018);
    reach[i]=distance-.018*bend[i]!;
  }
  return {reach,bend};
}
const leftWeights=forearmWeights(surface.poses.open.positions),rightWeights=forearmWeights(rightSurface.poses.open.positions);
const samples=[surface,rightSurface].map(data=>[data.poses.open,data.poses.half,data].map(pose=>({
  positions:new Float32Array(pose.positions),normals:new Float32Array(pose.normals),
})));

/** Wrap the soft hand as one piece and ease its wrist into the forearm. */
export function fitGrip(geometry: THREE.BufferGeometry, wrist: THREE.Vector3, right=false, grasp=1): void {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  const normals = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const {reach,bend}=right?rightWeights:leftWeights;
  const amount=THREE.MathUtils.clamp(grasp,0,1)*2;
  const segment=Math.min(1,Math.floor(amount)),mix=amount-segment;
  const poses=samples[right?1:0]!,a=poses[segment]!,b=poses[segment+1]!;
  const dx = wrist.x + 1, dy = wrist.y, dz = wrist.z;
  for (let i = 0; i < positions.count; i++) {
    const j=i*3;
    const x=THREE.MathUtils.lerp(a.positions[j]!,b.positions[j]!,mix);
    const y=THREE.MathUtils.lerp(a.positions[j+1]!,b.positions[j+1]!,mix);
    const z=THREE.MathUtils.lerp(a.positions[j+2]!,b.positions[j+2]!,mix);
    const blend = bend[i]!, extension = reach[i]!;
    positions.setXYZ(i, x + dx*extension, y + dy*extension, z + dz*extension);
    const ny=THREE.MathUtils.lerp(a.normals[j+1]!,b.normals[j+1]!,mix),nz=THREE.MathUtils.lerp(a.normals[j+2]!,b.normals[j+2]!,mix);
    const baseNx=THREE.MathUtils.lerp(a.normals[j]!,b.normals[j]!,mix);
    const nx=(baseNx + blend*(dy*ny + dz*nz)) / (1-blend*dx);
    const length=Math.hypot(nx,ny,nz)||1;
    normals.setXYZ(i,nx/length,ny/length,nz/length);
  }
  positions.needsUpdate = true;
  normals.needsUpdate = true;
}

const materialCache = new Map<number,THREE.MeshStandardMaterial>();
export function gripMaterial(color:number):THREE.MeshStandardMaterial {
  let material=materialCache.get(color);
  if (!material) {
    material=new THREE.MeshStandardMaterial({color,roughness:.80,metalness:0,emissive:color,emissiveIntensity:.035});
    materialCache.set(color,material);
  }
  return material;
}
