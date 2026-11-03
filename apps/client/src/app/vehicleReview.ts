import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {MachineAssets,MachineVisual} from "../craft/machines/machineVisual.js";
import {PARTS,PART_ORDER,DIRECTIONS,preset,machineStats,mirrorDirection,type Blueprint,type PartKind} from "../craft/machines/blueprint.js";
import {changePartCustom,springFactor,wheelRadius} from "../craft/machines/customization.js";
import {partInspectorMarkup} from "../craft/machines/workshopUi.js";
import {PHYSICS_RULES} from "../craft/machines/physicsRules.js";
import "./vehicleReview.css";

declare global{interface Window{__vehicleReviewModels?:Record<string,string>;}}
const mount=document.getElementById("vehicle-review")!;
if(window.__vehicleReviewModels)THREE.DefaultLoadingManager.setURLModifier(url=>window.__vehicleReviewModels![url.split("?")[0]!]??url);
mount.innerHTML=`<main class="vr"><header><b>CraftYap · 부품 학습 작업대</b><span>Blender kit 2.0</span></header><h1>한 부품씩 바꾸고,<br>왜 달라지는지 살펴봐요.</h1><p>8종 부품의 색과 물리 설정을 바꿀 수 있습니다. 아래 구조 시연으로 연결부를 확인하고, 실제 결과는 게임의 시험 운전에서 비교해 보세요.</p><nav class="vr-parts" aria-label="부품 종류">${PART_ORDER.map(k=>`<button data-kind="${k}">${PARTS[k].name}</button>`).join("")}</nav><div class="vr-controls"><button data-mode="car" aria-pressed="true">전체 자동차</button><button data-mode="part" aria-pressed="false">선택 부품 크게 보기</button><label><input type="checkbox" id="vr-motion" checked> 바퀴 연결 구조 시연</label><label><input type="checkbox" id="vr-mirror" checked> 좌우 함께 바꾸기</label><button id="vr-reset">예제 초기화</button></div><div class="vr-layout"><section><div class="vr-view"><div id="vr-canvas"></div><p id="vr-status" role="status">부품을 불러오는 중…</p></div><div class="vr-views"><button data-view="game">위에서 보기</button><button data-view="front">정면</button><button data-view="side">측면</button><button data-view="wheel">바퀴 안쪽</button></div><p class="vr-caption">드래그: 회전 · 휠: 확대. 구조 시연은 타이어 회전·조향·서스펜션 연결을 보여 주는 반복 동작입니다.</p><div id="vr-stats" class="vr-stats"></div><p class="vr-flow">게임에서는 <strong>B → 기계 작업실 → 조립한 부품 조정(V)</strong>을 누르고 부품을 선택합니다. 값을 바꾼 뒤 <strong>Enter</strong>로 시험 운전해 보세요.</p></section><aside id="vr-inspector" aria-label="선택 부품 설정"></aside></div><footer>실제 게임의 부품 모델·설정·표시 코드를 사용한 검수 화면입니다. 이 화면의 반복 시연은 주행 시뮬레이션이 아니며, 물리 효과는 게임에 연결하고 자동 검사했습니다.</footer></main>`;
const status=document.getElementById("vr-status")!,inspector=document.getElementById("vr-inspector")!,stats=document.getElementById("vr-stats")!;
let blueprint:Blueprint=preset("rover"),kind:PartKind="wheel",mode:"car"|"part"="car",selected=blueprint.parts.findIndex(p=>p.kind===kind),visual:MachineVisual|null=null;
const partLibrary=new Map<PartKind,Blueprint>();
for(const k of PART_ORDER)partLibrary.set(k,{version:1,name:PARTS[k].name,parts:[{kind:k,cell:[0,0,0],direction:0},...(k==="wheel"?[{kind:"frame" as const,cell:[-1,0,0] as [number,number,number],direction:0}]:[])]});
const current=()=>mode==="car"?blueprint:partLibrary.get(kind)!;
const index=()=>mode==="car"?selected:0;
const scene=new THREE.Scene();scene.background=new THREE.Color(0xe9eddf);
const selectedBox=new THREE.Box3(),selectedBounds=new THREE.Box3(),partMatrix=new THREE.Matrix4(),outline=new THREE.Box3Helper(selectedBox,0xeab343);outline.visible=false;scene.add(outline);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;document.getElementById("vr-canvas")!.append(renderer.domElement);
const camera=new THREE.PerspectiveCamera(38,1,.05,100),orbit=new OrbitControls(camera,renderer.domElement);orbit.enableDamping=true;orbit.target.set(0,.1,0);camera.position.set(-7,5.5,8.5);
scene.add(new THREE.HemisphereLight(0xfff6e4,0xb3bea4,2.5));const sun=new THREE.DirectionalLight(0xfff3dc,3);sun.position.set(-5,9,6);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);sun.shadow.camera.left=sun.shadow.camera.bottom=-6;sun.shadow.camera.right=sun.shadow.camera.top=6;sun.shadow.normalBias=.035;scene.add(sun);
const floor=new THREE.Mesh(new THREE.PlaneGeometry(100,100),new THREE.MeshStandardMaterial({color:0xc7d2b7,roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-1.24;floor.receiveShadow=true;scene.add(floor);
const motion=document.getElementById("vr-motion") as HTMLInputElement,mirror=document.getElementById("vr-mirror") as HTMLInputElement;
function sync():void{
 const b=current(),p=b.parts[index()];if(!p)return;
 kind=p.kind;inspector.innerHTML=partInspectorMarkup(b,index(),mirror.checked,false);const s=machineStats(b);stats.textContent=`${b.parts.length}개 부품 · 총 질량 ${s.mass.toFixed(1)} kg · 무게중심 (${s.center.map(n=>n.toFixed(2)).join(", ")})`;
 document.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.kind===kind)));
 document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.mode===mode)));
 visual?.rebuild(b);status.textContent="";
}
function fit(view="game"):void{
 const small=mode==="part",target=small?new THREE.Vector3(0,kind==="wheel"?-.3:0,0):new THREE.Vector3(0,.1,0),positions:Record<string,[number,number,number]>={game:small?[2,1.7,2.8]:[-7,5.5,8.5],front:small?[0,.5,3.4]:[0,2.4,10],side:small?[3.4,.6,0]:[10,2.5,0],wheel:small?[-2.5,1.2,2.6]:[-6,1.3,6]};camera.position.set(...positions[view]!);orbit.target.copy(target);orbit.update();
}
function change(key:string,value:string):void{
 const b=current(),p=b.parts[index()];if(!p)return;
 if(key==="direction"){
  const d=Number(value);if(!PARTS[p.kind].directional||!Number.isInteger(d)||d<0||d>=DIRECTIONS.length)return;p.direction=d;
 }else if(!changePartCustom(p,key,value))return;
 if(mirror.checked&&p.cell[0]!==0){const twin=b.parts.find(v=>v.kind===p.kind&&v.cell[0]===-p.cell[0]&&v.cell[1]===p.cell[1]&&v.cell[2]===p.cell[2]);if(twin){if(key==="direction")twin.direction=mirrorDirection(p.direction);else changePartCustom(twin,key,value);}}
 sync();
}
inspector.addEventListener("change",e=>{const field=e.target as HTMLSelectElement;if(field.dataset.inspectIndex!==undefined){const i=Number(field.value);if(current().parts[i]){if(mode==="car")selected=i;else if(i!==0)kind=current().parts[i]!.kind;sync();fit();}}else if(field.dataset.custom)change(field.dataset.custom,field.value);});
inspector.addEventListener("click",e=>{if((e.target as HTMLElement).closest("[data-custom-reset]"))change("reset","");});
document.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach(button=>button.addEventListener("click",()=>{kind=button.dataset.kind as PartKind;const i=blueprint.parts.findIndex(p=>p.kind===kind);if(mode==="car"&&i>=0)selected=i;else mode="part";sync();fit();}));
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button=>button.addEventListener("click",()=>{mode=button.dataset.mode as typeof mode;if(mode==="car"){selected=blueprint.parts.findIndex(p=>p.kind===kind);if(selected<0)selected=0;}sync();fit();}));
document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach(button=>button.addEventListener("click",()=>fit(button.dataset.view)));
mirror.addEventListener("change",sync);document.getElementById("vr-reset")!.addEventListener("click",()=>{blueprint=preset("rover");for(const b of partLibrary.values())for(const p of b.parts){delete p.custom;p.direction=0;}selected=blueprint.parts.findIndex(p=>p.kind===kind);if(selected<0)selected=0;sync();fit();});
const assets=new MachineAssets();void assets.ready.then(()=>{visual=new MachineVisual(assets);scene.add(visual.root);sync();fit();}).catch(()=>{status.textContent="부품을 불러오지 못했습니다. 페이지를 새로고침해 주세요.";});
const resize=()=>{const target=document.getElementById("vr-canvas")!;renderer.setSize(target.clientWidth,target.clientHeight);camera.aspect=target.clientWidth/target.clientHeight;camera.updateProjectionMatrix();};const observer=new ResizeObserver(resize);observer.observe(document.getElementById("vr-canvas")!);resize();const clock=new THREE.Clock();let time=0;
renderer.setAnimationLoop(()=>{const dt=Math.min(.05,clock.getDelta());time+=dt;
 if(visual){let bottom=Infinity;current().parts.forEach((p,i)=>{if(p.kind==="wheel"){const travel=motion.checked?Math.sin(time*2.2+i*.4)*.11/Math.sqrt(springFactor(p)):0;visual!.wheel(i,PHYSICS_RULES.suspensionLength+travel,motion.checked?time*2.8:0,motion.checked?Math.sin(time*.8)*.22:0);bottom=Math.min(bottom,p.cell[1]-PHYSICS_RULES.suspensionLength-travel-wheelRadius(p));}else bottom=Math.min(bottom,p.cell[1]-.51);});floor.position.y=bottom-.015;visual.flushWheels();}
 if(visual){selectedBox.makeEmpty();for(const mesh of visual.meshes){const slot=(mesh.userData.partIndices as number[]).indexOf(index());if(slot<0)continue;if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();mesh.getMatrixAt(slot,partMatrix);selectedBounds.copy(mesh.geometry.boundingBox!).applyMatrix4(partMatrix);selectedBox.union(selectedBounds);}outline.visible=!selectedBox.isEmpty();if(outline.visible)selectedBox.expandByScalar(.035);}
 orbit.update();renderer.render(scene,camera);
});
window.addEventListener("pagehide",()=>{renderer.setAnimationLoop(null);observer.disconnect();orbit.dispose();visual?.dispose();assets.dispose();outline.geometry.dispose();(outline.material as THREE.Material).dispose();floor.geometry.dispose();(floor.material as THREE.Material).dispose();renderer.dispose();},{once:true});
