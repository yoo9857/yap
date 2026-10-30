import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {deflateSync} from 'node:zlib';
const dir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../textures');
const crc32=buffer=>{let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;};
const chunk=(type,data)=>{const text=Buffer.from(type),out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length);text.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([text,data])),8+data.length);return out;};
const png=(rgba,width,height)=>{const hdr=Buffer.alloc(13);hdr.writeUInt32BE(width,0);hdr.writeUInt32BE(height,4);hdr[8]=8;hdr[9]=6;const rows=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)rgba.copy(rows,y*(width*4+1)+1,y*width*4,(y+1)*width*4);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',hdr),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);};
fs.mkdirSync(dir,{recursive:true});
const size=512,albedo=Buffer.alloc(size*size*4),normal=Buffer.alloc(size*size*4),orm=Buffer.alloc(size*size*4);
const noise=(x,y)=>{let n=Math.imul(x+17,374761393)^Math.imul(y+73,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295-.5;};
const clamp=v=>Math.max(0,Math.min(255,Math.round(v)));
for(let y=0;y<size;y++)for(let x=0;x<size;x++){
 const i=(y*size+x)*4,u=x/size,v=1-y/size,h=noise(x,y);let c,r,m,nx=0,ny=0;
 if(v>=.5&&u<.5){const grain=Math.sin(x*.115+Math.sin(y*.025)*.8+Math.sin(y*.007)*1.2),fine=Math.sin(x*.43+Math.sin(y*.013));const t=grain*5+fine*1.5+h*2;c=[179+t,126+t*.8,74+t*.6];r=.77+h*.035;m=0;nx=Math.cos(x*.115+Math.sin(y*.025))*.018;}
 else if(v>=.5){const cloud=Math.sin(x*.038+y*.015)*Math.sin(y*.033)*1.8,brush=Math.sin(y*1.9)*.6;c=[158+cloud+h*1.5,176+cloud+h*1.5,177+cloud+h*1.5];r=.43+h*.025+brush*.008;m=.68;ny=h*.008;}
 else if(u<.25){const weave=Math.sin(x*2.1)*Math.sin(y*2.1);c=[78+weave+h*2,109+weave+h*2,91+weave+h*2];r=.85+h*.04;m=0;nx=weave*.009;}
 else if(u<.5){c=[188+h*2,143+h*2,76+h];r=.39+h*.035;m=.65;}
 else if(u<.75){c=[191+h*2,205+h*2,199+h*2];r=.35+h*.02;m=.72;}
 else{const ring=Math.sin(Math.hypot(x-448,y-384)*.27)*3;c=[177+ring+h,127+ring*.7+h,77+ring*.5+h];r=.81;m=0;}
 albedo.set([clamp(c[0]),clamp(c[1]),clamp(c[2]),255],i);normal.set([clamp(128+nx*127),clamp(128+ny*127),255,255],i);orm.set([255,clamp(r*255),clamp(m*255),255],i);
}
for(const [name,data] of [['pickaxe-albedo.png',albedo],['pickaxe-normal.png',normal],['pickaxe-orm.png',orm]])fs.writeFileSync(path.join(dir,name),png(data,size,size));
fs.writeFileSync(path.join(dir,'atlas-regions.json'),JSON.stringify({size,origin:'UV bottom-left',padding:.015,regions:{wood:[0,.5,.5,1],iron:[.5,.5,1,1],grip:[0,0,.25,.5],brass:[.25,0,.5,.5],edge:[.5,0,.75,.5],endgrain:[.75,0,1,.5]},channels:{albedo:'sRGB',normal:'tangent-space OpenGL +Y',orm:'R occlusion=1, G roughness, B metallic'}},null,2));console.log('Created original 512px albedo / normal / ORM atlas.');
