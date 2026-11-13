import * as THREE from "three";
import type {FireSchool} from "@robo/shared";

/** Static campus shadows stop the orange glow crossing classroom walls.
 * The two cube maps update on map/origin changes, not on every flicker. */
export class FireLighting {
  private readonly lamps:THREE.PointLight[]=[];
  private readonly blaze:THREE.Vector3;
  private originX=NaN;
  private originZ=NaN;
  private enabled=false;
  constructor(root:THREE.Object3D,school:FireSchool){
    this.blaze=new THREE.Vector3((school.heat[0]+school.heat[3])/2,school.heat[1]+1.1,/* low: a lamp near the ceiling draws a round pool on it; the ceiling's fire light is fireFx CEIL_FRAG */(school.heat[2]+school.heat[5])/2);
    root.traverse(o=>{if(o instanceof THREE.PointLight){
      o.castShadow=true;o.shadow.mapSize.set(512,512);o.shadow.camera.near=.08;o.shadow.camera.far=o.distance;
      o.shadow.bias=-.00005;o.shadow.normalBias=.012;o.shadow.autoUpdate=false;o.shadow.needsUpdate=true;
      this.lamps.push(o);
    }});
  }
  invalidate():void{for(const light of this.lamps)light.shadow.needsUpdate=true;}
  update(originX:number,originZ:number,shadows:boolean):void{
    if(originX!==this.originX||originZ!==this.originZ||shadows!==this.enabled){this.originX=originX;this.originZ=originZ;this.enabled=shadows;this.invalidate();}
    for(const light of this.lamps){
      if(light.distance>10)light.position.copy(this.blaze);
      // Without shadow support an unoccluded point light would shine through
      // every room. Flames and their local floor glow remain visible on low.
      light.intensity=shadows?light.intensity*.55:0;
    }
  }
  dispose():void{for(const light of this.lamps)light.shadow.dispose();}
}
