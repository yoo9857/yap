import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {FireLessonView} from '../src/craft/fire/fireLessonView.js';

// Test DOM event routing and real model transforms without a browser/GPU.
class Element {
 style:Record<string,string>={};children:Element[]=[];clientWidth=600;clientHeight=300;width=600;height=300;hidden=false;className='';innerHTML='';tabIndex=0;
 onpointerdown:((e:PointerEvent)=>void)|null=null;onpointermove:((e:PointerEvent)=>void)|null=null;onpointerup:(()=>void)|null=null;onpointercancel:(()=>void)|null=null;
 setAttribute(){}append(...children:Element[]){this.children.push(...children);}remove(){}setPointerCapture(){}
 getBoundingClientRect(){return{left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
}
let frame:FrameRequestCallback=()=>{};
let cameraPose:number[]=[];
let cameraView:THREE.Camera;
const clearColor=new THREE.Color();
vi.mock('three',async original=>{
 const actual=await original<typeof import('three')>();
 return {...actual,WebGLRenderer:class{
  domElement=new Element();ratio=1;
  setPixelRatio(r:number){this.ratio=r;}getPixelRatio(){return this.ratio;}setClearColor(color:THREE.ColorRepresentation){clearColor.set(color);}
  setSize(w:number,h:number){this.domElement.width=w*this.ratio;this.domElement.height=h*this.ratio;}
  render(scene:import('three').Scene,camera:import('three').Camera){scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);cameraPose=[...camera.position.toArray(),...camera.quaternion.toArray()];cameraView=camera;}
  dispose(){}
 }};
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('grabbing the hollow safety ring',()=>{
 it('drags the real pin and holds the fourth-step framing while squeezing',async()=>{
  vi.stubGlobal('document',{createElement:()=>new Element()});vi.stubGlobal('devicePixelRatio',1);
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>{frame=cb;return 1;});vi.stubGlobal('cancelAnimationFrame',()=>{});
  const bytes=readFileSync(new URL('../public/models/items/fire/extinguisher/extinguisher.glb',import.meta.url));
  const asset=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length),'');
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockResolvedValue(asset);
  const container=new Element(),activated=vi.fn();const view=new FireLessonView(container as unknown as HTMLElement,activated);
  try{await view.model.ready;view.focus='pin';view.gauge=true;frame(1000);
   const canvas=container.children[0]!,marker=container.children[1]!;
   const x=Number.parseFloat(marker.style.left!),y=Number.parseFloat(marker.style.top!);
   const pointer=(clientX:number)=>({clientX,clientY:y,pointerId:1,preventDefault(){},stopPropagation(){}} as PointerEvent);
   const pin=view.model.root.getObjectByName('SafetyPin')!,start=pin.position.x;
   marker.onpointerdown!(pointer(x));canvas.onpointermove!(pointer(x+140));canvas.onpointerup!();
   expect(activated).toHaveBeenCalledWith('pin-drag',true,1);expect(activated).toHaveBeenCalledWith('pin-drag',false,1);
   frame(1050);expect(pin.position.x).toBeGreaterThan(start+.01);
   container.clientWidth=280;container.clientHeight=250;
   view.step=2;view.focus='handle';
   for(let i=0;i<30;i++)frame(1100+i*50);
   const beforePress=[...cameraPose];
   expect(clearColor.getHexString()).toBe('243445');
   const powderLabel=container.children.find(element=>element.className==='fire-powder-label')!;
   expect(powderLabel.hidden).toBe(true);
   const nozzle=new THREE.Vector3();expect(view.model.partPosition('nozzle',nozzle)).toBe(true);
   for(const point of [nozzle,new THREE.Vector3(-.14,.52,.07)]){
    point.project(cameraView);expect(Math.abs(point.x)).toBeLessThan(.92);expect(Math.abs(point.y)).toBeLessThan(.92);
   }
   view.squeezing=true;
   for(let i=0;i<10;i++)frame(2600+i*50);
   expect(cameraPose.every((v,i)=>Math.abs(v-beforePress[i]!)<1e-5)).toBe(true);
   expect(powderLabel.hidden).toBe(false);
   view.focus='sweep';view.sweep=.15;frame(3100);
   expect(clearColor.getHexString()).toBe('243445');expect(powderLabel.hidden).toBe(false);
  }finally{view.dispose();}
 });
});
