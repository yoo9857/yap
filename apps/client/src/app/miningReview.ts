import * as THREE from "three";
import {OrbitControls} from "three/examples/jsm/controls/OrbitControls.js";
import {BlockKitModels,PIECES} from "../craft/blockKitModels.js";
import {MiningEffects,miningDamageStage} from "../craft/miningEffects.js";
import {surfaceStyle} from "../craft/blockMaterials.js";
import {blockByKey} from "../craft/blocks.js";
export function bootMiningReview(mount:HTMLElement,initialMaterial="stone",options:{autoplay?:boolean}={}):void {
 const scene=new THREE.Scene();scene.background=new THREE.Color("#e9e9df");const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.7));renderer.setSize(mount.clientWidth,mount.clientHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;mount.append(renderer.domElement);
 const camera=new THREE.PerspectiveCamera(35,1,.1,50);camera.position.set(3.3,2.8,4.3);const orbit=new OrbitControls(camera,renderer.domElement);orbit.target.set(.5,.6,.5);orbit.enableDamping=true;orbit.minDistance=2;orbit.maxDistance=9;orbit.maxPolarAngle=Math.PI*.49;
 scene.add(new THREE.HemisphereLight(0xfff7e2,0x91a2a6,2.1));const sun=new THREE.DirectionalLight(0xffe6c2,3);sun.position.set(-3,7,4);sun.castShadow=true;sun.shadow.camera.left=-3;sun.shadow.camera.right=3;sun.shadow.camera.top=3;sun.shadow.camera.bottom=-3;sun.shadow.mapSize.set(1024,1024);scene.add(sun);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:"#c3d1b8",roughness:1}));floor.rotation.x=-Math.PI/2;floor.position.y=-.015;floor.receiveShadow=true;scene.add(floor);
 const library=new BlockKitModels("nature"),fx=new MiningEffects(scene),status=document.getElementById("mining-status")!,progressBar=document.getElementById("mining-progress")!;
 function buildModel(key:string):THREE.Group {const group=library.build(PIECES[0]!,0,0,key);if(!["grass","dirt","snow","diamond-block"].includes(key))group.traverse(o=>{if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material as THREE.Material[]:[o.material as THREE.Material])if(m instanceof THREE.MeshStandardMaterial)m.color.set(blockByKey(key)!.color);});return group;}
 let variation=0,material=initialMaterial,model=buildModel(material),age=0,playing=options.autoplay??true,broken=false;scene.add(model);
 const response=document.getElementById("mining-response")!;
 const materialLabels:Record<string,string[]>={metal:["대기","표면 압흔","국부 찌그러짐","눌림 깊어짐","가장자리 휨","판 벌어짐·찢김"],wood:["대기","결의 첫 갈라짐","금이 아래로 뻗음","밝은 속살 노출","가는 조각 분리","섬유가 벌어짐"],snow:["대기","표면 눌림","압축·미세틈","작은 덩어리 탈락","부스러짐","흐트러지기 직전"]};
 const responseText:Record<string,string>={metal:"금속: 먼저 눌리고 찌그러집니다. 후반에 가장자리가 휘고, 판이 벌어져 무겁게 떨어집니다.",wood:"나무: 결 방향으로 긴 균열과 섬유 조각이 생깁니다. 통나무는 세로, 판자는 가로로 쪼개집니다.",snow:"눈: 살짝 눌린 뒤 작은 덩어리로 흐트러집니다.",sand:"모래: 작은 덩어리가 먼저 떨어지고, 짧게 흩어지며 무너집니다.",glass:"유리: 얇고 각진 조각으로 갈라집니다.",gem:"보석: 단단한 면을 따라 각진 파편으로 깨지며 가볍게 튑니다.",wool:"양털: 눌리고 늘어진 뒤 부드러운 조각으로 뜯깁니다."};
 const labels=["대기","미세한 틈","갈라짐 확산","내부 단면 노출","모서리 조각 탈락","틈 확대 · 붕괴 직전"];
 function upright():void {model.rotation.set(0,0,0);model.position.set(0,0,0);}
 function target(progress:number):void {upright();const mesh=model.children[0] as THREE.Mesh<THREE.BufferGeometry>;fx.setProgress([0,0,0],blockByKey(material)!,18,progress,()=>({geometry:mesh.geometry.clone().translate(-.5,-.5,-.5),rotation:new THREE.Quaternion(),materials:mesh.material}));model.visible=miningDamageStage(progress)===0||!fx.stats().geometry;const family=surfaceStyle(material).family;status.textContent=(materialLabels[family]??labels)[miningDamageStage(progress)]!;response.textContent=responseText[family]??"돌·흙: 불규칙한 균열이 깊어지고 모서리부터 깨져 무너집니다.";progressBar.style.width=Math.min(100,progress*100)+"%";}
 function reset():void {upright();fx.reset();model.visible=true;broken=false;age=0;progressBar.style.width="0%";}
 document.getElementById("mining-material")!.addEventListener("change",event=>{material=(event.target as HTMLSelectElement).value;scene.remove(model);model=buildModel(material);scene.add(model);reset();});
 document.getElementById("mining-variation")?.addEventListener("click",()=>{variation++;fx.setVariation(variation);reset();playing=false;target(.72);status.textContent="다른 균열 · 패턴 "+(variation+1);});
 document.getElementById("mining-play")!.addEventListener("click",()=>{reset();playing=true;});
 document.getElementById("mining-break")!.addEventListener("click",()=>{playing=false;if(!fx.stats().geometry)target(.05);model.visible=false;fx.burst([0,0,0],blockByKey(material)!,18);broken=true;status.textContent="조각 분리 · 낙하 · 정리";progressBar.style.width="100%";});
 document.querySelectorAll<HTMLButtonElement>("[data-stage]").forEach(button=>button.addEventListener("click",()=>{reset();playing=false;target(Number(button.dataset.stage));}));
 document.getElementById("mining-top")?.addEventListener("click",()=>{reset();playing=false;target(0);status.textContent="윗면 · 작은 원형 돌기 2×2";});
 document.getElementById("mining-bottom")?.addEventListener("click",()=>{reset();playing=false;const height=new THREE.Box3().setFromObject(model).max.y;model.rotation.x=Math.PI;model.position.set(0,height,1);status.textContent="아랫면 · 홈 없는 평평한 바닥";});
 if(!playing)target(0);
 const ground={isBlocked:(_x:number,y:number,_z:number)=>y<0},clock=new THREE.Clock();
 const resize=()=>{renderer.setSize(mount.clientWidth,mount.clientHeight);camera.aspect=mount.clientWidth/mount.clientHeight;camera.updateProjectionMatrix();},observer=new ResizeObserver(resize);observer.observe(mount);resize();
 renderer.setAnimationLoop(()=>{const dt=Math.min(.05,clock.getDelta());if(playing){age+=dt;if(age<1.7){target(age/1.7);}else if(!broken){model.visible=false;fx.burst([0,0,0],blockByKey(material)!,18);broken=true;status.textContent="조각 분리 · 낙하 · 정리";}else if(age>(surfaceStyle(material).family==="wood"?3.9:3.3))reset();}fx.update(dt,ground);if(!broken)model.visible=!fx.stats().geometry;orbit.update();renderer.render(scene,camera);});
 addEventListener("pagehide",()=>{renderer.setAnimationLoop(null);observer.disconnect();orbit.dispose();fx.dispose();library.dispose();floor.geometry.dispose();(floor.material as THREE.Material).dispose();renderer.dispose();},{once:true});
}

