import * as THREE from "three";
import {naturalCellsGeometry,type NaturalBlockKey} from "./naturalBlockGeometry.js";
import {connectedNaturalWorld,type NaturalWorldCell} from "./connectedNaturalGeometry.js";
import {BlockMaterialLibrary,materialFaceGroups} from "./blockMaterials.js";
import {PIECES,pieceCells,pieceShape,type Piece} from "./pieces.js";
import {ROUND,isOrientedShape,blockShapeFamily} from "./shapes.js";
import {brickOrientation} from "./brickGeometry.js";
import {kitCellsGeometry,kitRampGeometry,kitRoundGeometry,kitConnectorGeometry} from "./kitGeometry.js";
export function pieceFamily(piece:Piece):string{return piece.shape==="cornerSlope"?"모서리":piece.shape==="slope"?"경사":piece.shape==="round"?"둥근":piece.key.startsWith("corner")?"모서리":piece.key.startsWith("2x")?"판":piece.cells.length>1?"긴 블록":"큐브";}
export const KIT_COLOURS:Readonly<Record<string,string>>={"큐브":"#edbd46","긴 블록":"#77b693","판":"#87a1d8","경사":"#df946f","모서리":"#ad89cf","둥근":"#daa2b7"};
/** Explicit kit/nature inspection modes. Natural prototypes preserve grid bounds without changing runtime terrain. */
export class BlockKitModels {
  constructor(private readonly design:"kit"|"nature"="nature"){}
  private readonly surfaceLibrary=new BlockMaterialLibrary(true);
  private readonly slope=kitRampGeometry();private readonly corner=kitRampGeometry(true);private readonly round=kitRoundGeometry();private readonly cap=kitConnectorGeometry();
  private readonly shells=new Map<string,THREE.BufferGeometry>();
  private readonly connections=new Map<string,ReturnType<typeof connectedNaturalWorld>>();
  build(piece:Piece,yaw=0,tilt=0,materialKey="coat",variant=0):THREE.Group {
    const root=new THREE.Group();root.name="CraftYap "+piece.key;
    root.userData={piece:piece.key,cells:piece.cells.length,nominal_unit:1,design_version:"2.1.0",connector:"four small closed round studs",underside:"flat closed base",up_axis:"+Y",front_axis:"+Z",default_tilt:0};
    const family=pieceFamily(piece),materials=this.surfaceLibrary.get(materialKey,KIT_COLOURS[family]??"#eee4cd"),material=materials.length===1?materials[0]!:materials;
    root.userData.surface=materialKey;
    const natural=this.design==="nature"&&["snow","grass","dirt","diamond-block"].includes(materialKey);
    if(natural){root.userData.design_version="4.2.0";root.userData.connector="four small same-material closed studs";root.userData.underside="plain terrain base";for(const m of materials){const scale=materialKey==="diamond-block"?.14:materialKey==="snow"?.2:.28;m.normalScale.setScalar(scale);if(materialKey==="diamond-block"){m.roughness=.32;m.clearcoat=.55;}}}
    const shape=pieceShape(piece,yaw,tilt),cells=pieceCells(piece,yaw,tilt);
    if(!piece.shape||piece.shape==="cube"){
      const key=cells.map(c=>c.join(",")).sort().join(";")+"|"+materialKey+"|"+this.design+"|"+variant;let geometry=this.shells.get(key);
      if(!geometry){geometry=natural?naturalCellsGeometry(cells,materialKey as NaturalBlockKey,variant):kitCellsGeometry(cells);if(materials.length>1&&!natural)materialFaceGroups(geometry);this.shells.set(key,geometry);}
      const body=new THREE.Mesh(geometry,material);body.name="Soft continuous shell and low closed connectors";body.castShadow=true;body.receiveShadow=true;root.add(body);
    }else{
      let geometry=shape===ROUND?this.round:blockShapeFamily(shape)==="corner"?this.corner:this.slope;
      if(natural&&shape===ROUND){const key="natural-round|"+materialKey;let grouped=this.shells.get(key);if(!grouped){grouped=naturalCellsGeometry([[0,0,0]],materialKey as NaturalBlockKey,variant,true);grouped.translate(-.5,-.5,-.5);this.shells.set(key,grouped);}geometry=grouped;}
      else if(natural){const key="natural-ramp|"+piece.key+"|"+materialKey;let grouped=this.shells.get(key);if(!grouped){grouped=kitRampGeometry(piece.shape==="cornerSlope",.045,false);this.shells.set(key,grouped);}geometry=grouped;}
      if(materials.length>1&&!(natural&&shape===ROUND)){const key=piece.key+"|"+yaw+"|"+tilt+"|"+materialKey;let grouped=this.shells.get(key);if(!grouped){grouped=materialFaceGroups(geometry.clone(),isOrientedShape(shape)?brickOrientation(yaw,tilt):undefined);this.shells.set(key,grouped);}geometry=grouped;}
      const body=new THREE.Mesh(geometry,material);body.name="Soft "+piece.shape;body.position.set(.5,.5,.5);
      if(isOrientedShape(shape))body.quaternion.copy(brickOrientation(yaw,tilt));body.castShadow=true;body.receiveShadow=true;root.add(body);
      if(shape===ROUND&&!natural){const cap=new THREE.Mesh(this.cap,materials[0]);cap.name="Low closed connector";cap.position.set(.5,1,.5);cap.castShadow=true;root.add(cap);}
    }
    return root;
  }
  buildConnected(cells:readonly NaturalWorldCell[],resolution=8):THREE.Group {
    const cacheKey=resolution+"|"+cells.map(c=>[c.x,c.y,c.z,c.key].join(",")).sort().join(";");
    let data=this.connections.get(cacheKey);if(!data){data=connectedNaturalWorld(cells,resolution);this.connections.set(cacheKey,data);this.shells.set("connected|"+cacheKey,data.geometry);}
    const materials=data.slots.map(slot=>{
      const options=this.surfaceLibrary.get(slot.key);const material=options[Math.min(slot.face,options.length-1)]!;material.normalScale.setScalar(slot.key==="snow"?.2:slot.key==="diamond-block"?.14:.28);return material;
    });
    const root=new THREE.Group();root.name="Connected natural terrain";root.userData={design_version:"4.2.0",cells:cells.length,connection_axes:["-X","+X","-Y","+Y","-Z","+Z"],masks:data.masks};
    const mesh=new THREE.Mesh(data.geometry,materials);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);
    return root;
  }
  dispose():void{this.surfaceLibrary.dispose();for(const g of [this.slope,this.corner,this.round,this.cap,...this.shells.values()])g.dispose();this.shells.clear();this.connections.clear();}
}
export {PIECES};
