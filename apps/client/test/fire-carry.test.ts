import { readFile } from "node:fs/promises";
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FireCarryHands, FireFirstPersonArms, positionViewGrips, positionViewNozzleGrip } from "../src/craft/fire/fireCarryHands.js";
import { MITTEN } from "../src/craft/fire/toyGrip.js";
import { FireExtinguisher } from "../src/craft/fire/fireExtinguisher.js";
import leftSurface from "../src/craft/fire/characterGrip.json";
import rightSurface from "../src/craft/fire/characterGripRight.json";

async function load(path: string) {
  const raw = await readFile(new URL(`../public/models/${path}`, import.meta.url));
  const buffer = new Uint8Array(raw).buffer;
  const loader = new GLTFLoader();
  loader.register(() => ({ name: "NO_TEXTURE_DECODE", loadTexture: () => Promise.resolve(new THREE.Texture()) }));
  return loader.parseAsync(buffer, "");
}

describe("carrying the extinguisher with the shipped mascots", () => {
  for (const character of ["HOME", "TT"] as const) {
    it(`${character} keeps both shoulders attached and routes the equipment outside its torso`, async () => {
      const [avatar, extinguisher] = await Promise.all([load(`characters/${character}/${character}.glb`), load("items/fire/extinguisher/extinguisher.glb")]);
      const root = new THREE.Group(); root.add(avatar.scene);
      const mixer = new THREE.AnimationMixer(avatar.scene);
      const mesh = root.getObjectByProperty("type", "SkinnedMesh") as THREE.SkinnedMesh;
      const caps = ["R", "L"].map(side => {
        const i = mesh.skeleton.bones.findIndex(b => b.name.replace(/[._]/g, "") === `upperarm${side}`);
        return { bone: mesh.skeleton.bones[i]!, point: new THREE.Vector3(...mesh.userData[`arm_cap_${side}`] as [number, number, number]).applyMatrix4(mesh.bindMatrix).applyMatrix4(mesh.skeleton.boneInverses[i]!) };
      });
      const hands = new FireCarryHands();
      const right = new THREE.Vector3(), left = new THREE.Vector3(), forward = new THREE.Vector3(0,0,1);
      const spy = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockResolvedValue(extinguisher);
      const item = new FireExtinguisher();
      try {
        await item.ready;
        for (const name of ["Idle", "Walk", "Run"]) {
          const clip = avatar.animations.find(c => c.name.replace(/^(HOME|TT)_/, "") === name)!;
          const action = mixer.clipAction(clip);
          action.reset().play();
          for (const aim of [0, 1]) for (let frame = 0; frame < 10; frame++) {
            action.time = clip.duration * frame / 10; mixer.update(0); root.updateMatrixWorld(true);
            const shoulders = caps.map(({bone, point}) => bone.localToWorld(point.clone()));
            expect(hands.pose(root, right, left, 1, aim, -.55, .01)).toBe(true);
            caps.forEach(({bone, point}, i) => expect(bone.localToWorld(point.clone()).distanceTo(shoulders[i]!)).toBeLessThan(1e-5));
            expect(right.x).toBeLessThan(-.50);
            expect(left.z).toBeGreaterThan(.15);
            item.root.rotation.set(-.06*aim,-.55,-.10,"YXZ");
            item.root.position.copy(right).sub(item.grip.clone().applyQuaternion(item.root.quaternion));
            item.carry(aim,left,new THREE.Vector3(0,.55,4),forward);
            const tank = item.root.getObjectByName("Tank")!;
            tank.updateWorldMatrix(true, false);
            const tankBounds = new THREE.Box3().setFromObject(tank);
            expect(tankBounds.max.x).toBeLessThan(-.39);
            const tube = item.root.getObjectByName("Flexible_extinguisher_hose") as THREE.Mesh<THREE.BufferGeometry>;
            tube.updateWorldMatrix(true, false);
            const positions = tube.geometry.getAttribute("position");
            for (let i = 0; i < positions.count; i++) {
              const v = new THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(tube.matrixWorld);
              if (Math.abs(v.x) < .36) expect(v.z).toBeGreaterThan(.27);
            }
          }
          action.stop();
        }
      } finally { item.dispose(); spy.mockRestore(); }
    });
  }
});

it("keeps rounded first-person grips at the screen edges and the nozzle on the crosshair", async () => {
  const asset = await load("items/fire/extinguisher/extinguisher.glb");
  const spy = vi.spyOn(GLTFLoader.prototype,"loadAsync").mockResolvedValue(asset);
  const item = new FireExtinguisher();
  try {
    await item.ready;
    const viewArms = new FireFirstPersonArms();
    const right = new THREE.Vector3(), left = new THREE.Vector3(), direction = new THREE.Vector3(), tip = new THREE.Vector3(),nozzleGrip=new THREE.Vector3();
    for (const aspect of [.64, 16/9, 21/9]) for (const pitch of [-.95,-.25,0,.8]) {
      const vertical = THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(Math.PI/6)*Math.max(1,4/3/aspect)));
      const camera = new THREE.PerspectiveCamera(vertical,aspect,.1,100);
      camera.position.set(8,2.3,9);
      const forward = new THREE.Vector3(0,Math.sin(pitch),Math.cos(pitch));
      const target = camera.position.clone().addScaledVector(forward,4.5);
      camera.lookAt(target); camera.updateMatrixWorld(true);
      for (const aim of [0,1]) for(const grasp of [0,.5,1]) {
        positionViewGrips(camera,camera.quaternion,right,left,aim,0,0);

        expect(viewArms.root.children).toHaveLength(2);
        const rightScreen=right.clone().project(camera),leftScreen=left.clone().project(camera);
        expect(rightScreen.x-leftScreen.x).toBeGreaterThan(aspect>2?.35:.49);
        for (const hand of [right,left]) {
          const screen=hand.clone().project(camera);
          expect(Math.abs(screen.x)).toBeLessThan(.92);
          expect(screen.y).toBeGreaterThan(-.88);
          expect(screen.y,"hands should stay low in the frame").toBeLessThan(-.42);
        }
        item.root.quaternion.copy(camera.quaternion);
        item.root.position.copy(right).sub(item.viewGrip.clone().applyQuaternion(item.root.quaternion));
        positionViewNozzleGrip(camera.quaternion,left,nozzleGrip);
        item.carry(aim,nozzleGrip,target,new THREE.Vector3(0,-.9,-1),.17);
        expect(item.nozzleRay(tip,direction)).toBe(true);
        viewArms.pose(camera,right,left,0,0,"mascot",new THREE.Vector3(0,0,1).applyQuaternion(item.root.quaternion),direction,grasp);
        for (const index of [0,1]) {
          const mitten = viewArms.root.children[index] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
          expect(mitten.material.map).toBeNull();
          expect(mitten.position.distanceTo(index===0?right:left)).toBeLessThan(1e-5);
          const centre=mitten.position.clone().project(camera);
          expect(Math.abs(centre.x)).toBeGreaterThan(.10);
          mitten.updateMatrixWorld(true);
          const landmark=(index===0?rightSurface:leftSurface).landmarks.thumbTipVertex;
          const thumb=new THREE.Vector3().fromBufferAttribute(mitten.geometry.getAttribute("position"),landmark).applyMatrix4(mitten.matrixWorld).project(camera);
          expect(index===0?thumb.x<centre.x:thumb.x>centre.x,`thumb ${index}, pitch ${pitch}, aspect ${aspect}: ${thumb.x} vs ${centre.x}`).toBe(true);
          expect(Math.abs(thumb.y-centre.y),"direction nub should sit beside the grasp").toBeLessThan(.30);
          if (aspect>=.64) {
            mitten.updateMatrixWorld(true);
            const p=mitten.geometry.getAttribute("position");
            let lowest=Infinity;
            let highestTail=-Infinity;
            const rest=(index===0?rightSurface:leftSurface).poses.open.positions;
            let tailX=Infinity;for(let j=0;j<rest.length;j+=3)tailX=Math.min(tailX,rest[j]!);
            for(let j=0;j<p.count;j++) {
              const screen=new THREE.Vector3().fromBufferAttribute(p,j).applyMatrix4(mitten.matrixWorld).project(camera);
              lowest=Math.min(lowest,screen.y);
              if(rest[j*3]!<tailX+.006)highestTail=Math.max(highestTail,screen.y);
            }
            expect(lowest).toBeLessThan(-1);
            expect(highestTail,"short arm end must stay below the screen").toBeLessThan(-1);
          }
        }
        if(aspect===16/9) {
          for(const name of ["Tank","Tank_shoulder"]) {
            const collider=item.root.getObjectByName(name) as THREE.Mesh<THREE.BufferGeometry>;
            collider.updateWorldMatrix(true,false);
            collider.geometry.computeBoundingBox();
            const inverse=collider.matrixWorld.clone().invert();
            const probe=new THREE.Mesh(collider.geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
            probe.updateMatrixWorld();
            const point=new THREE.Vector3(),ray=new THREE.Raycaster();
            for(const hand of viewArms.root.children as THREE.Mesh<THREE.BufferGeometry>[]) {
              hand.updateMatrixWorld(true);
              const p=hand.geometry.getAttribute("position");
              let inside=0;
              for(let j=0;j<p.count;j++) {
                point.fromBufferAttribute(p,j).applyMatrix4(hand.matrixWorld).applyMatrix4(inverse);
                if(!collider.geometry.boundingBox!.containsPoint(point))continue;
                ray.set(point,new THREE.Vector3(1,0,0));
                const hit=ray.intersectObject(probe)[0];
                if(hit&&hit.face!.normal.x>0&&hit.distance>.0005)inside++;
              }
              expect(inside,`${name}, ${hand.name}, pitch ${pitch}`).toBe(0);
            }
            (probe.material as THREE.Material).dispose();
          }
        }
        expect(target.clone().sub(tip).normalize().dot(direction)).toBeGreaterThan(.999999);
        const leftHand=viewArms.root.children[1] as THREE.Mesh<THREE.BufferGeometry>;
        leftHand.updateMatrixWorld(true);
        const check=new THREE.Mesh(leftHand.geometry,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));check.updateMatrixWorld();
        const localTip=tip.clone().applyMatrix4(leftHand.matrixWorld.clone().invert());
        const testDirection=new THREE.Vector3(1,.237,.383).normalize();
        const muzzleHit=new THREE.Raycaster(localTip,testDirection).intersectObject(check)[0];
        expect(Boolean(muzzleHit&&muzzleHit.face!.normal.dot(testDirection)>0),"muzzle must stay outside the glove").toBe(false);
        const socket=item.root.getObjectByName("Nozzle_Hose_Socket")!;
        const inlet=socket.getWorldPosition(new THREE.Vector3()).applyMatrix4(camera.matrixWorldInverse);
        const palm=left.clone().applyMatrix4(camera.matrixWorldInverse);
        expect(inlet.y,"hose must leave underneath the palm").toBeLessThan(palm.y-.055);
        const inverseHand=leftHand.matrixWorld.clone().invert();
        const localGrip=nozzleGrip.clone().applyMatrix4(inverseHand);
        const toPalm=left.clone().applyMatrix4(inverseHand).sub(localGrip).normalize();
        const contact=new THREE.Raycaster(localGrip,toPalm).intersectObject(check)[0];
        expect(contact,"nozzle grip should touch the soft hand").toBeDefined();
        if(contact!.face!.normal.dot(toPalm)<0)expect(contact!.distance).toBeLessThan(.026);
        if(aspect===16/9) {
          const hose=item.root.getObjectByName("Flexible_extinguisher_hose") as THREE.Mesh<THREE.BufferGeometry>;
          hose.updateWorldMatrix(true,false);leftHand.geometry.computeBoundingBox();
          const vertices=hose.geometry.getAttribute("position");let inside=0;
          const ray=new THREE.Raycaster(),point=new THREE.Vector3();
          for(let j=0;j<vertices.count;j++) {
            point.fromBufferAttribute(vertices,j).applyMatrix4(hose.matrixWorld).applyMatrix4(inverseHand);
            if(!leftHand.geometry.boundingBox!.containsPoint(point))continue;
            ray.set(point,testDirection);const hit=ray.intersectObject(check)[0];
            if(hit&&hit.face!.normal.dot(testDirection)>0)inside++;
          }
          expect(inside,"hose must not pass through the palm or wrist").toBe(0);
        }
        (check.material as THREE.Material).dispose();
      }
    }
  } finally {item.dispose();spy.mockRestore();}
});

it("keeps the fingerless soft hand pad and wrist on one closed connected surface", () => {
  const geometry=MITTEN;
  const index=geometry.index!,positions=geometry.getAttribute("position");
  const neighbors=Array.from({length:positions.count},()=>new Set<number>());
  const edges=new Map<string,number>();
  for(let i=0;i<index.count;i+=3) {
    const face=[index.getX(i),index.getX(i+1),index.getX(i+2)];
    for(let j=0;j<3;j++) {
      const a=face[j]!,b=face[(j+1)%3]!;
      neighbors[a]!.add(b);neighbors[b]!.add(a);
      const key=a<b?`${a},${b}`:`${b},${a}`;
      edges.set(key,(edges.get(key)??0)+1);
    }
  }
  const visited=new Set([0]),queue=[0];
  for(let i=0;i<queue.length;i++) for(const n of neighbors[queue[i]!]!) if(!visited.has(n)){visited.add(n);queue.push(n);}
  expect(visited.size).toBe(positions.count);
  expect([...edges.values()].every(n=>n===2)).toBe(true);
  const material=new THREE.MeshBasicMaterial();
  const grip=new THREE.Mesh(geometry,material);grip.updateMatrixWorld();
  const outside=new THREE.Raycaster(new THREE.Vector3(.2,0,-.01),new THREE.Vector3(-1,0,0));
  expect(outside.intersectObject(grip)[0]?.point.x).toBeGreaterThan(0);
  material.dispose();
});

it("ships identical hand vertices and normals to the native app",async()=>{
  for(const [side,data]of [["",leftSurface],["-right",rightSurface]] as const) {
    for(const [pose,state]of [["-open",data.poses.open],["-half",data.poses.half],["",data]] as const) {
      const raw=await readFile(new URL(`../../../engine/assets/character-grip/model${side}${pose}.bin`,import.meta.url));
      const buffer=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
      expect(raw.length).toBe(data.indices.length*24);
      let maxError=0;
      for(let i=0;i<data.indices.length;i++) {
        const j=data.indices[i]!*3;
        const expected=[...state.positions.slice(j,j+3),...state.normals.slice(j,j+3)];
        for(let k=0;k<6;k++)maxError=Math.max(maxError,Math.abs(buffer.getFloat32(i*24+k*4,true)-Math.fround(expected[k]!)));
      }
      expect(maxError,`native pose ${side}${pose}`).toBe(0);
    }
  }
});

it("relaxes and wraps both soft pads without changing topology or producing invalid normals",()=>{
  const camera=new THREE.PerspectiveCamera(70,16/9,.1,100);camera.lookAt(0,0,1);camera.updateMatrixWorld(true);
  const arms=new FireFirstPersonArms(),right=new THREE.Vector3(),left=new THREE.Vector3();
  positionViewGrips(camera,camera.quaternion,right,left,0,0,0);
  const padTipIndex=rightSurface.poses.open.positions.reduce((best,_,j)=>j%3===0&&rightSurface.poses.open.positions[j]!>rightSurface.poses.open.positions[best*3]!?j/3:best,0);
  const points:THREE.Vector3[][]=[];
  for(const grasp of [0,.25,.5,.75,1]) {
    arms.pose(camera,right,left,0,0,"mascot",new THREE.Vector3(0,0,-1),new THREE.Vector3(0,0,1),grasp);
    points.push(arms.root.children.map(child=>{
      const hand=child as THREE.Mesh<THREE.BufferGeometry>;
      expect([...hand.geometry.getAttribute("normal").array].every(Number.isFinite)).toBe(true);
      return new THREE.Vector3().fromBufferAttribute(hand.geometry.getAttribute("position"),padTipIndex);
    }));
  }
  for(const i of [0,1])expect(points[0]![i]!.distanceTo(points[4]![i]!)).toBeGreaterThan(.015);
  arms.dispose();
});
