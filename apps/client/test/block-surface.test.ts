import * as THREE from "three";
import {describe,it,expect} from "vitest";
import {kitFootprintGeometry,kitConnectorGeometry,kitRoundGeometry,kitRampGeometry,KIT_CONNECTOR_HEIGHT} from "../src/craft/kitGeometry.js";
import {createKitSurfaceMaps,disposeKitSurfaceMaps,repeatingKitTexture} from "../src/craft/kitSurface.js";
import {BlockKitModels,PIECES} from "../src/craft/blockKitModels.js";
import {brickOrientation} from "../src/craft/brickGeometry.js";
import {kitSlopeShape,cornerShape,rotateShapeVector} from "@robo/shared";

describe("block UV, surface and orientation",()=>{
  it("keeps every triangle unmirrored at one texture tile per physical unit",()=>{
    const geometries=[kitFootprintGeometry([[0,0],[1,0],[2,0],[0,1]]),kitConnectorGeometry(),kitRoundGeometry(),kitRampGeometry(),kitRampGeometry(true)];
    for(const g of geometries){
      const p=g.getAttribute("position"),uv=g.getAttribute("uv");
      for(let i=0;i<p.count;i+=3){
        const a=new THREE.Vector3().fromBufferAttribute(p,i),b=new THREE.Vector3().fromBufferAttribute(p,i+1),c=new THREE.Vector3().fromBufferAttribute(p,i+2);
        const physical=b.sub(a).cross(c.sub(a)).length();
        const area=(uv.getX(i+1)-uv.getX(i))*(uv.getY(i+2)-uv.getY(i))-(uv.getY(i+1)-uv.getY(i))*(uv.getX(i+2)-uv.getX(i));
        expect(area).toBeGreaterThan(0);
        if(g.userData.cosmetic===true){expect(area/physical).toBeGreaterThan(.9);expect(area/physical).toBeLessThanOrEqual(1.0001);}else expect(area/physical).toBeCloseTo(1,3);
      }g.dispose();
    }
  });
  it("continues the top texture coordinates across the flat stud tops without a separate badge pattern",()=>{
    const g=kitConnectorGeometry(),p=g.getAttribute("position"),n=g.getAttribute("normal"),uv=g.getAttribute("uv");
    for(let i=0;i<p.count;i++)if(n.getY(i)>.999){expect(uv.getX(i)).toBeCloseTo(p.getX(i)+.5,6);expect(uv.getY(i)).toBeCloseTo(-p.getZ(i)-.5,6);}g.dispose();
  });
  it("keeps exported models upright without negative or mirrored transforms",()=>{
    const lib=new BlockKitModels();
    for(const piece of PIECES){
      const group=lib.build(piece);group.updateMatrixWorld(true);
      expect(group.userData.up_axis).toBe("+Y");expect(group.userData.default_tilt).toBe(0);
      group.traverse(object=>{expect(object.matrixWorld.determinant()).toBeGreaterThan(0);});
      if(!piece.shape||piece.shape==="round"){
        const ray=new THREE.Raycaster(new THREE.Vector3(.25,3,.25),new THREE.Vector3(0,-1,0));
        expect(ray.intersectObject(group)[0]!.point.y).toBeCloseTo(1+KIT_CONNECTOR_HEIGHT,4);
        const bottom=new THREE.Raycaster(new THREE.Vector3(.5,-1,.5),new THREE.Vector3(0,1,0));
        expect(bottom.intersectObject(group)[0]!.point.y).toBeCloseTo(0,4);
      }
    }
    for(const corner of [false,true])for(let yaw=0;yaw<4;yaw++)for(let tilt=0;tilt<4;tilt++){
      const shape=(corner?cornerShape:kitSlopeShape)(yaw,tilt),q=brickOrientation(yaw,tilt);
      const point=new THREE.Vector3(.17,.23,-.31),rotated=point.clone().applyQuaternion(q);
      const expected=rotateShapeVector(point.toArray(),shape);rotated.toArray().forEach((n,i)=>expect(n).toBeCloseTo(expected[i]!,8));
      expect(new THREE.Matrix4().makeRotationFromQuaternion(q).determinant()).toBeCloseTo(1);
    }
    lib.dispose();
  });
  it("provides deterministic embedded colour, normal and roughness data without changing terrain wrapping",()=>{
    const maps=createKitSurfaceMaps(64),copy=createKitSurfaceMaps(64);
    const bytes=(t:THREE.DataTexture):Uint8Array=>new Uint8Array(t.image.data.buffer,t.image.data.byteOffset,t.image.data.byteLength);
    expect([...bytes(maps.albedo)]).toEqual([...bytes(copy.albedo)]);
    for(const t of [maps.albedo,maps.normal,maps.roughness]){expect(t.wrapS).toBe(THREE.RepeatWrapping);expect(t.wrapT).toBe(THREE.RepeatWrapping);expect(t.image.data.byteLength).toBe(64*64*4);}
    expect(maps.albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(maps.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(maps.roughness.colorSpace).toBe(THREE.NoColorSpace);
    const source=new THREE.Texture(),wrapped=repeatingKitTexture(source);
    expect(source.wrapS).toBe(THREE.ClampToEdgeWrapping);expect(wrapped.wrapS).toBe(THREE.RepeatWrapping);
    expect(new Set(bytes(maps.roughness).filter((_,i)=>i%4===1)).size).toBeGreaterThan(40);
    source.dispose();wrapped.dispose();disposeKitSurfaceMaps(maps);disposeKitSurfaceMaps(copy);
  });
});

