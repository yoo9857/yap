import * as THREE from "three";
/** Fresh exposed fibers: no plank joints or bark bands on the cut surface. */
export function woodFractureSurface(colour:string):{material:THREE.MeshStandardMaterial;textures:THREE.Texture[]} {
 const size=128,pixels=new Uint8Array(size*size*4),normals=new Uint8Array(size*size*4),heights=new Float32Array(size*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const u=x/size,v=y/size,wave=Math.sin((u*29+Math.sin(v*Math.PI*2)*.19+Math.sin(u*Math.PI*6+v*Math.PI*4)*.05)*Math.PI*2),fine=Math.sin(u*Math.PI*146+Math.sin(v*Math.PI*6)*.3),shade=.94+wave*.045+fine*.015,index=(y*size+x)*4;
  pixels.set([Math.round(255*shade),Math.round(250*shade),Math.round(238*shade),255],index);heights[y*size+x]=wave*.035+fine*.012;
 }
 const height=(x:number,y:number)=>heights[((y+size)%size)*size+(x+size)%size]!;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const dx=(height(x-1,y)-height(x+1,y))*1.2,dy=(height(x,y-1)-height(x,y+1))*1.2,length=Math.hypot(dx,dy,1);normals.set([Math.round((dx/length*.5+.5)*255),Math.round((dy/length*.5+.5)*255),Math.round((1/length*.5+.5)*255),255],(y*size+x)*4);}
 const texture=(data:Uint8Array,name:string,srgb=false)=>{const t=new THREE.DataTexture(data,size,size,THREE.RGBAFormat);t.name=name;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.colorSpace=srgb?THREE.SRGBColorSpace:THREE.NoColorSpace;t.generateMipmaps=true;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.needsUpdate=true;return t;};
 const map=texture(pixels,"Fresh longitudinal wood fibers",true),normal=texture(normals,"Fine exposed wood fibers");
 const material=new THREE.MeshStandardMaterial({color:new THREE.Color(colour).lerp(new THREE.Color("#f0cf9b"),.52),map,normalMap:normal,normalScale:new THREE.Vector2(.2,.2),roughness:.93});
 return {material,textures:[map,normal]};
}
