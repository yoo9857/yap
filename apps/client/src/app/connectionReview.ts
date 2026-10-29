import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {VoxelView} from "../craft/voxelView.js";
import {VoxelWorld} from "../craft/voxelWorld.js";
import {SandSim} from "../craft/sandSim.js";
import {blockByKey} from "../craft/blocks.js";
export function bootConnectionReview(mount:HTMLElement):void {
 const scene=new THREE.Scene();scene.background=new THREE.Color("#e9e9df");const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));renderer.setSize(mount.clientWidth,mount.clientHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;mount.append(renderer.domElement);
 const camera=new THREE.PerspectiveCamera(35,1,.1,100);camera.position.set(20.5,4.1,21);const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(17,1.55,16.5);controls.enableDamping=true;controls.minDistance=2.5;controls.maxDistance=12;controls.maxPolarAngle=Math.PI*.49;
 scene.add(new THREE.HemisphereLight(0xfff7e2,0x91a2a6,2.1));const sun=new THREE.DirectionalLight(0xffe6c2,3);sun.position.set(13,8,20);sun.target.position.set(17,1.5,16.5);sun.castShadow=true;sun.shadow.camera.left=-4;sun.shadow.camera.right=4;sun.shadow.camera.top=4;sun.shadow.camera.bottom=-4;sun.shadow.mapSize.set(1024,1024);scene.add(sun,sun.target);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:"#c3d1b8",roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.set(17,.985,16.5);floor.receiveShadow=true;scene.add(floor);
 const world=new VoxelWorld(),view=new VoxelView(scene,{catalogTextures:false});view.setRenderDistance(20);const status=document.getElementById("connection-status")!,select=document.getElementById("connection-layout") as HTMLSelectElement;
 const focus=new THREE.Vector3(17,1.55,16.5);
 const wood=blockByKey("oak-log")!.id,stone=blockByKey("stone")!.id,grass=blockByKey("grass")!.id,dirt=blockByKey("dirt")!.id,sand=blockByKey("sand")!.id;
 const sim=new SandSim(world,{scene,shape:(block,shape,cell)=>view.miningShape(shape,block,cell,world),write:(x,y,z,block,shape)=>{world.setShaped(x,y,z,block,shape);view.markCellDirty(x,y,z);sim.touch(x,y,z);},hidden:cells=>view.setFallingHidden(cells)});
 function layout(value:string):void {
  sim.clear();for(let x=15;x<=18;x++)for(let z=15;z<=18;z++)for(let y=0;y<=5;y++)world.set(x,y,z,0);
  if(value==="grass-stack"||value==="dirt-stack"){for(let y=1;y<=3;y++)world.setShaped(16,y,16,value==="grass-stack"?grass:dirt,18);}
  else if(value==="sand"){for(let x=15;x<=18;x++)for(let z=15;z<=18;z++)world.set(x,0,z,stone);world.setShaped(16,1,16,stone,18);world.setShaped(16,2,16,sand,18);world.setShaped(16,3,16,sand,18);sim.wakeAll();}
  else{world.setShaped(16,1,16,value==="soil-sand"?dirt:wood,18);if(value!=="single")world.setShaped(value==="depth"?16:17,1,value==="depth"?17:16,value==="soil-sand"?sand:value==="mixed"?stone:wood,18);if(value==="corner")world.setShaped(16,1,17,stone,18);}
  const tall=value.endsWith("stack")||value==="sand",narrow=tall||value==="single"||value==="depth";focus.set(narrow?16.5:17,tall?2.5:1.5,value==="depth"||value==="corner"?17:16.5);controls.target.copy(focus);camera.position.copy(focus).add(new THREE.Vector3(3.5,tall?3.1:2.8,5.5));
  const descriptions:Record<string,string>={same:"나무 + 나무 · 옆면 밀착, 일정한 돌기 간격",mixed:"나무 + 돌 · 재질 경계만 유지","soil-sand":"흙 + 모래 · 큰 자갈 무늬 없이 고운 잔결과 무광 표면",depth:"앞뒤 연결 · 틈 없이 이어지는 옆면",corner:"모서리 연결 · 안쪽 틈과 바깥 마감",single:"단독 블록 · 바깥 모서리 마감","grass-stack":"잔디 3층 · 맨 위만 초록, 묻힌 층은 흙","dirt-stack":"흙 3층 · 초록 띠 없는 연속된 흙",sand:"모래 2층 · 받침 제거 버튼으로 낙하 확인"};
  view.markDirty();view.update(world,camera.position);status.textContent=descriptions[value]!;const release=document.getElementById("sand-release") as HTMLButtonElement;release.hidden=value!=="sand";release.disabled=false;

 }
 document.getElementById("connection-reset")!.addEventListener("click",()=>layout(select.value));
 document.getElementById("sand-release")!.addEventListener("click",()=>{(document.getElementById("sand-release") as HTMLButtonElement).disabled=true;world.set(16,1,16,0);view.markCellDirty(16,1,16);sim.touch(16,1,16);status.textContent="받침 제거 · 모래가 내려와 바닥에 쌓입니다";});
 select.addEventListener("change",()=>layout(select.value));layout(select.value);
 document.getElementById("connection-front")!.addEventListener("click",()=>{camera.position.copy(focus).add(new THREE.Vector3(0,.6,7));controls.target.copy(focus);});
 document.getElementById("connection-top")!.addEventListener("click",()=>{camera.position.copy(focus).add(new THREE.Vector3(0,7,1.5));controls.target.copy(focus);});
 const resize=()=>{renderer.setSize(mount.clientWidth,mount.clientHeight);camera.aspect=mount.clientWidth/mount.clientHeight;camera.updateProjectionMatrix();},observer=new ResizeObserver(resize);observer.observe(mount);resize();
 const clock=new THREE.Clock();
 renderer.setAnimationLoop(()=>{sim.update(Math.min(.05,clock.getDelta()));controls.update();view.update(world,camera.position);renderer.render(scene,camera);});
 addEventListener("pagehide",()=>{renderer.setAnimationLoop(null);observer.disconnect();controls.dispose();sim.dispose();view.dispose();floor.geometry.dispose();(floor.material as THREE.Material).dispose();renderer.dispose();},{once:true});
}
