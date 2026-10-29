import * as THREE from "three";
import {loadTexture} from "../render/textures.js";
import {GENERATED_BLOCK_TEXTURES} from "./generatedBlockTextures.js";
import type {BlockDef} from "./blocks.js";
export type SurfaceFamily="coat"|"snow"|"grass"|"dirt"|"gem"|"ore"|"wood"|"wool"|"sand"|"metal"|"glass"|"stone";
export interface MaterialMaps {map:THREE.DataTexture;normal:THREE.DataTexture;roughness:THREE.DataTexture}
export interface SurfaceStyle {family:SurfaceFamily;roughness:number;metalness:number;normal:number;clearcoat:number}
export function surfaceStyle(key:string):SurfaceStyle {
 const family:SurfaceFamily=key==="snow"?"snow":key==="grass"||key==="flower-grass"?"grass":key==="dirt"?"dirt":key==="diamond-block"||key==="obsidian"?"gem":key.endsWith("-ore")?"ore":/planks|log|bookshelf|hay/.test(key)?"wood":key.includes("wool")?"wool":/sand|gravel|clay|terracotta/.test(key)?"sand":key==="iron-block"||key==="gold-block"?"metal":key==="glass"||key==="ice"?"glass":key==="coat"?"coat":"stone";
 const values:Record<SurfaceFamily,readonly [number,number,number,number]>={coat:[.67,0,.45,.15],snow:[.97,0,.62,0],grass:[.91,0,.42,0],dirt:[.96,0,.42,0],gem:[.21,.12,.32,.8],ore:[.79,.06,.8,.15],wood:[.83,0,.78,.03],wool:[1,0,.95,0],sand:[.99,0,.28,0],metal:[.31,.78,.24,.4],glass:[.13,.03,.16,.8],stone:[.9,0,.7,.02]};
 const [roughness,metalness,normal,clearcoat]=values[family];return {family,roughness,metalness,normal,clearcoat};
}
const hash=(x:number,y:number):number=>{let h=Math.imul(x+29,374761393)^Math.imul(y+71,668265263);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967295;};
const clamp=(n:number)=>Math.max(0,Math.min(255,Math.round(n)));
const pixelCache=new Map<string,{colour:Uint8Array;normals:Uint8Array;rough:Uint8Array}>();
export function createMaterialMaps(family:SurfaceFamily|"grass-side",size=128):MaterialMaps {
 const cacheKey=family+"|"+size,cached=pixelCache.get(cacheKey),colour=cached?.colour??new Uint8Array(size*size*4),normals=cached?.normals??new Uint8Array(size*size*4),rough=cached?.rough??new Uint8Array(size*size*4),height=new Float32Array(size*size);
 if(!cached){
 const noise=(x:number,y:number,scale=8)=>{const px=x/size*scale,py=y/size*scale,ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy),h=(a:number,b:number)=>hash((a+scale)%scale,(b+scale)%scale);return (h(ix,iy)*(1-sx)+h(ix+1,iy)*sx)*(1-sy)+(h(ix,iy+1)*(1-sx)+h(ix+1,iy+1)*sx)*sy;};
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const i=y*size+x,h=hash(x,y),n=noise(x,y),u=x/size,v=y/size;let base=[240,240,240],bump=(h-.5)*.08,r=.77;
  const ground=family==="dirt"||(family==="grass-side"&&v<.93+.018*Math.sin(u*Math.PI*6));
  if(ground){
   // Broad compacted-earth variation plus fine grain, without stamped circular pebbles.
   const fine=noise(x,y,32),mottle=noise(x,y,4),tone=(n-.5)*15+(fine-.5)*8+(mottle-.5)*8+(h-.5)*3;
   base=[145+tone,109+tone*.82,76+tone*.65];bump=n*.045+fine*.018+(h-.5)*.006;r=.96;
  }
  else if(family==="grass"||family==="grass-side"){const blade=Math.abs(Math.sin((u*26+noise(x,y,16)*.85)*Math.PI))<.22;const tone=(n-.5)*32+(blade?16:0)+(h-.5)*8;base=[65+tone*.8,136+tone,42+tone*.5];bump=n*.18+(blade?.11:0);r=.91;}
  else if(family==="snow"){const t=(n-.5)*16+(h-.5)*5;base=[240+t*.7,247+t*.45,253+t*.15];bump=n*.23+(h-.5)*.045;r=.94;}
  else if(family==="gem"){const gx=u*6,gy=v*6,cx=gx%1,cy=gy%1,facet=cx+cy>1,band=hash(Math.floor(gx),Math.floor(gy)),t=.65+band*.23+(facet?.1:0);base=[69*t,220*t,226*t];const seam=Math.min(cx,cy,1-cx,1-cy)<.027;bump=seam?-.08:facet?.008:.014;r=.22+band*.13;if(seam)base=base.map(c=>c*.8);}
  else if(family==="sand"){
   const fine=noise(x,y,32),drift=noise(x,y,4),tone=(n-.5)*5+(fine-.5)*5+(drift-.5)*3+(h-.5)*2;
   base=[243+tone,241+tone,235+tone];bump=n*.012+fine*.008+(h-.5)*.003;r=.99;
  }
  else if(family==="wood"){const grain=Math.sin((u*13+Math.sin(v*Math.PI*4)*.22+n*.25)*Math.PI*2),seam=(v*4)%1<.022;base=[240+grain*9,235+grain*10,225+grain*12];bump=grain*.08+(seam?-.2:0);r=.76;}
  else if(family==="wool"){const weave=Math.sin(u*Math.PI*48)*Math.sin(v*Math.PI*48);base=[240+weave*11,240+weave*11,240+weave*11];bump=weave*.15+(h-.5)*.07;r=.98;}
  else if(family==="metal"){const brush=Math.sin(v*Math.PI*96)*.5+(h-.5)*.5;base=[239+brush*8,239+brush*8,239+brush*8];bump=brush*.025;r=.4+brush*.08;}
  else if(family==="glass"){const vein=Math.abs(Math.sin((u-v)*Math.PI*5+n*.12))<.04;base=[248,251,255];bump=vein?.035:0;r=.18;}
  else{const grit=family==="ore"?.24:.2;base=[235+(n-.5)*26,235+(n-.5)*26,235+(n-.5)*26];bump=n*grit+(h-.5)*.08;r=family==="coat"?.73:.88;}
  height[i]=bump;colour.set([clamp(base[0]!),clamp(base[1]!),clamp(base[2]!),255],i*4);rough.set([255,clamp(r*255+(h-.5)*12),family==="metal"?255:0,255],i*4);
 }
 const at=(x:number,y:number)=>height[((y+size)%size)*size+(x+size)%size]!;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const dx=(at(x-1,y)-at(x+1,y))*1.5,dy=(at(x,y-1)-at(x,y+1))*1.5,l=Math.hypot(dx,dy,1);normals.set([clamp((dx/l*.5+.5)*255),clamp((dy/l*.5+.5)*255),clamp((1/l*.5+.5)*255),255],(y*size+x)*4);}
 pixelCache.set(cacheKey,{colour,normals,rough});}
 const tex=(data:Uint8Array,name:string,srgb=false)=>{const t=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);t.name="CraftYap "+family+" "+name;t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.generateMipmaps=true;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.needsUpdate=true;return t;};
 return {map:tex(colour,"colour",true),normal:tex(normals,"normal"),roughness:tex(rough,"roughness-metalness")};
}
/** Only three draw groups, keeping different grass faces inexpensive in a voxel world. */
export function materialFaceGroups(geometry:THREE.BufferGeometry,q?:THREE.Quaternion):THREE.BufferGeometry {
 const n=geometry.getAttribute("normal"),index=geometry.index,source=index?Array.from(index.array):Array.from({length:n.count},(_,i)=>i),groups:[number[],number[],number[]]=[[],[],[]],v=new THREE.Vector3();
 for(let i=0;i<source.length;i+=3){v.set(0,0,0);for(let j=0;j<3;j++)v.add(new THREE.Vector3().fromBufferAttribute(n,source[i+j]!));v.normalize();if(q)v.applyQuaternion(q);groups[v.y>.52?0:v.y<-.52?2:1].push(source[i]!,source[i+1]!,source[i+2]!);}
 geometry.setIndex(groups.flat());geometry.clearGroups();let offset=0;groups.forEach((g,i)=>{if(g.length)geometry.addGroup(offset,g.length,i);offset+=g.length;});return geometry;
}
/** Shared profile maps are cached once per family; each catalog block retains its own pigment. */
export class BlockMaterialLibrary {
 private disposed=false;
 constructor(private readonly generated=false){}
 private readonly maps=new Map<string,MaterialMaps>();private readonly materials=new Map<string,THREE.MeshPhysicalMaterial[]>();
 private surface(family:SurfaceFamily|"grass-side"):MaterialMaps {let maps=this.maps.get(family);if(!maps){maps=createMaterialMaps(family);this.maps.set(family,maps);}return maps;}
 get(key:string,colour="#eee4cd",source?:THREE.MeshStandardMaterial):THREE.MeshPhysicalMaterial[] {
  const cacheKey=key+"|"+colour;const cached=this.materials.get(cacheKey);if(cached)return cached;
  const style=surfaceStyle(key),featured=["snow","grass","dirt","diamond-block"].includes(key),families:(SurfaceFamily|"grass-side")[]=style.family==="grass"?["grass","grass-side","dirt"]:[style.family];
  const result=families.map(family=>{const maps=this.surface(family),material=new THREE.MeshPhysicalMaterial({color:featured?0xffffff:colour,map:maps.map,normalMap:maps.normal,normalScale:new THREE.Vector2(style.normal,style.normal),roughnessMap:maps.roughness,metalnessMap:maps.roughness,roughness:style.roughness,metalness:style.metalness,// below 0.1 a clearcoat is invisible but still adds a second specular lobe to every pixel of the block
   clearcoat:style.clearcoat>=.1?style.clearcoat:0,clearcoatRoughness:style.family==="gem"?.13:.6,vertexColors:true});
   material.name="CraftYap "+key+" / "+family;
   if(source){material.transparent=source.transparent;material.opacity=source.opacity;material.emissive.copy(source.emissive);material.emissiveIntensity=source.emissiveIntensity;}
   if(style.family==="gem"&&key!=="obsidian"){material.emissive.set("#0a5760");material.emissiveIntensity=.1;}
   if(family==="dirt"||family==="grass-side"||family==="sand")material.userData.surface_detail="restrained microdetail v2";
   material.userData.surface_family=style.family;material.userData.key=key;
   const generated=GENERATED_BLOCK_TEXTURES[family];
   if(this.generated&&generated&&family!=="dirt"&&family!=="grass-side"&&typeof document!=="undefined"){
    void Promise.all([loadTexture(generated.albedo,{repeat:true}),loadTexture(generated.normal,{repeat:true,srgb:false}),loadTexture(generated.roughness,{repeat:true,srgb:false})]).then(([colour,normal,roughness])=>{
      if(this.disposed)return;
      for(const map of [colour,normal,roughness])if(map){map.flipY=false;map.anisotropy=4;map.needsUpdate=true;}
      if(colour)material.map=colour;if(normal)material.normalMap=normal;if(roughness){material.roughnessMap=roughness;material.metalnessMap=roughness;}
      material.userData.texture_source="image_gen v3";material.needsUpdate=true;
    });
   }
   return material;});
  this.materials.set(cacheKey,result);return result;
 }
 dispose():void {this.disposed=true;for(const mats of this.materials.values())for(const m of mats)m.dispose();for(const maps of this.maps.values())for(const t of [maps.map,maps.normal,maps.roughness])t.dispose();this.materials.clear();this.maps.clear();}
}
export const REVIEW_MATERIALS:readonly {key:string;name:string;colour:string;description:string}[]=[
 {key:"coat",name:"조립 블록",colour:"#77b693",description:"작은 결합부와 은은한 코팅 표면"},
 {key:"snow",name:"눈",colour:"#f7fbff",description:"포슬한 입자 · 부드러운 무광"},
 {key:"grass",name:"잔디",colour:"#5cbe4a",description:"초록 잔디 윗면 · 흙 옆면과 바닥"},
 {key:"dirt",name:"흙",colour:"#9c6b3f",description:"자갈과 흙 알갱이 · 거친 무광"},
 {key:"diamond-block",name:"보석",colour:"#5fe0d8",description:"결정 면과 반사광 · 약한 자체 빛"}
];
export function needsCatalogTexture(def:BlockDef):boolean {return !["snow","grass","dirt","diamond-block","sand","red-sand"].includes(def.key);}

