import * as THREE from "three";
import { kitFootprintGeometry } from "./kitShell.js";
export {kitFootprintGeometry,kitConnectorGeometry,kitRoundGeometry,kitCellsGeometry,KIT_CONNECTOR_HEIGHT} from "./kitShell.js";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { blockShapePlanes } from "@robo/shared";
/** One-cell construction bodies, bounded by the same unit cell as collision. */
export function kitCubeGeometry(): THREE.BufferGeometry {const g=kitFootprintGeometry([[0,0]]);g.translate(-.5,-.5,-.5);return g;}
/** Insets each supporting plane, then rounds the convex core. No vertex extends outside the original ramp. */
export function kitRampGeometry(corner = false, bevel = .028, _details=true): THREE.BufferGeometry {
    const planes = blockShapePlanes(corner ? "corner" : "slope").map(([x, y, z, d]) => { const l = Math.hypot(x, y, z); return { n: new THREE.Vector3(x / l, y / l, z / l), d: d / l - bevel - (bevel>0 && (x!==0||z===-1||y===1&&z===1)? .006:0) }; });
    const core: THREE.Vector3[] = [];
    for (let i = 0; i < planes.length; i++)
        for (let j = i + 1; j < planes.length; j++)
            for (let k = j + 1; k < planes.length; k++) {
                const a = planes[i]!, b = planes[j]!, c = planes[k]!, matrix = new THREE.Matrix3().set(a.n.x, a.n.y, a.n.z, b.n.x, b.n.y, b.n.z, c.n.x, c.n.y, c.n.z);
                if (Math.abs(matrix.determinant()) < 1e-8)
                    continue;
                const point = new THREE.Vector3(a.d, b.d, c.d).applyMatrix3(matrix.invert());
                if (planes.some(p => p.n.dot(point) > p.d + 1e-6))
                    continue;
                if (!core.some(p => p.distanceToSquared(point) < 1e-10))
                    core.push(point);
            }
    const points: THREE.Vector3[] = [];
    for (const p of core) {
        if (!bevel) {
            points.push(p.clone().addScalar(-.5));
            continue;
        }
        for (let x = -1; x <= 1; x++)
            for (let y = -1; y <= 1; y++)
                for (let z = -1; z <= 1; z++) {
                    if (x === 0 && y === 0 && z === 0)
                        continue;
                    points.push(new THREE.Vector3(x, y, z).normalize().multiplyScalar(bevel).add(p).addScalar(-.5));
                }
    }
    const geometry = new ConvexGeometry(points);
    const pos = geometry.getAttribute("position"), normal = geometry.getAttribute("normal"), uv: number[] = [];
    const normalVector=new THREE.Vector3(),u=new THREE.Vector3(),v=new THREE.Vector3(),point=new THREE.Vector3();
    for(let i=0;i<pos.count;i++){
      normalVector.fromBufferAttribute(normal,i);const x=Math.abs(normalVector.x),y=Math.abs(normalVector.y),z=Math.abs(normalVector.z);
      if(y>=x&&y>=z){u.set(1,0,0).addScaledVector(normalVector,-normalVector.x).normalize();v.crossVectors(normalVector,u);}else{v.set(0,1,0).addScaledVector(normalVector,-normalVector.y).normalize();u.crossVectors(v,normalVector);}
      point.fromBufferAttribute(pos,i);uv.push(point.dot(u),point.dot(v));
    }
    geometry.setAttribute("color",new THREE.Float32BufferAttribute(new Float32Array(pos.count*3).fill(1),3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}
