import {ExtinguisherPowder} from "./extinguisherPowder.js";
import * as THREE from 'three';
import {FireExtinguisher} from './fireExtinguisher.js';
import {t} from '../../ui/i18n.js';

/** Interactive close-up of the exact model carried in the school. */
export class FireLessonView {
 readonly model=new FireExtinguisher();
 private readonly renderer:THREE.WebGLRenderer;
 private readonly scene=new THREE.Scene();
 private readonly camera=new THREE.PerspectiveCamera(35,1,.01,10);
 private readonly cameraGoal=new THREE.Vector3();
 private readonly lookGoal=new THREE.Vector3();
 private readonly cameraLook=new THREE.Vector3();
 private cameraStarted=false;
 private readonly ray=new THREE.Raycaster();
 private readonly pointer=new THREE.Vector2();
 private readonly nozzle=new THREE.Vector3();
 private readonly direction=new THREE.Vector3();
 private readonly hand=new THREE.Vector3(.27,.28,.07);
 private readonly aim=new THREE.Vector3(.63,.06,.03);
 private readonly forwardAim=new THREE.Vector3(0,0,.8);
 private readonly parked=new THREE.Vector3(-.028,.216,.176);
 private readonly nozzleHand=new THREE.Vector3();
 private readonly nozzleAim=new THREE.Vector3();
 private readonly fireTarget=document.createElement("div");
 pinProgress=0;aimProgress=0;
 private readonly powder=new ExtinguisherPowder();
 private readonly powderRay={from:this.nozzle,dir:this.direction,len:.5};
 private readonly flame:THREE.Mesh;
 private readonly ground:THREE.Mesh<THREE.PlaneGeometry,THREE.MeshStandardMaterial>;
 private readonly powderLabel=document.createElement('span');
 private readonly inspectionBackground=new THREE.Color(0xe9f0e8);
 private readonly sprayBackground=new THREE.Color(0x243445);
 private readonly inspectionFloor=new THREE.Color(0xd8e5da);
 private readonly sprayFloor=new THREE.Color(0x3f5265);
 private readonly backdrop=new THREE.Color();
 private backdropMix=0;
 private readonly tray:THREE.Mesh;
 private pinDrop=0;
 private readonly pinTray=new THREE.Vector3(.10,.0058,.13);
 private raf=0;private last=0;private pin=0;private alive=true;
 step=0;squeezing=false;passes=0;gauge=false;sweep=.5;focus="gauge";
 private readonly marker=document.createElement("div");
 private readonly markerPoint=new THREE.Vector3();
 private readonly ownedMaterials:THREE.MeshStandardMaterial[]=[];
 private focused="";
 constructor(private readonly container:HTMLElement,private readonly activate:(part:string,down:boolean,progress?:number)=>void){
  this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  this.renderer.setClearColor(0xe9f0e8);this.renderer.outputColorSpace=THREE.SRGBColorSpace;
  const canvas=this.renderer.domElement;canvas.style.cssText='width:100%;height:100%;display:block;touch-action:none';canvas.setAttribute('aria-label','실제 사용 모델: 압력계, 안전핀, 레버와 노즐');container.append(canvas);this.marker.className="fire-model-target";this.marker.setAttribute('role','button');this.marker.tabIndex=0;this.marker.innerHTML="<i></i><span>☝</span><b>여기!</b>";container.append(this.marker);this.fireTarget.className="fire-aim-target";this.fireTarget.innerHTML="<i></i><b>불 아래</b>";container.append(this.fireTarget);
  this.scene.add(new THREE.HemisphereLight(0xffffff,0x6c8871,2));const key=new THREE.DirectionalLight(0xfff4dc,3);key.position.set(1,2,3);this.scene.add(key);
  this.model.showRemovedPin=true;
  this.tray=new THREE.Mesh(new THREE.BoxGeometry(.19,.006,.10),new THREE.MeshStandardMaterial({color:0xe7c46d,roughness:.7}));this.tray.position.set(.08,0,.13);this.scene.add(this.tray);
  this.model.root.position.x=-.14;this.scene.add(this.model.root);
  this.ground=new THREE.Mesh(new THREE.PlaneGeometry(3,3),new THREE.MeshStandardMaterial({color:0xd8e5da,roughness:.9}));this.ground.rotation.x=-Math.PI/2;this.ground.position.y=-.003;this.scene.add(this.ground);
  this.flame=new THREE.Mesh(new THREE.ConeGeometry(.06,.17,7),new THREE.MeshBasicMaterial({color:0xff8b22}));this.flame.position.set(.63,.09,.03);this.scene.add(this.flame);
  this.scene.add(this.powder.root);
  this.powderLabel.className='fire-powder-label';
  this.powderLabel.textContent=t('ABC 분말','ABC dry powder');
  this.powderLabel.hidden=true;
  container.append(this.powderLabel);
  const hit=(e:PointerEvent)=>{
   const rect=canvas.getBoundingClientRect();this.pointer.set((e.clientX-rect.left)/rect.width*2-1,1-(e.clientY-rect.top)/rect.height*2);this.ray.setFromCamera(this.pointer,this.camera);
   // A ring's empty centre must be grabbable too. Use a generous screen-space
   // hit area for the current part before considering its thin triangle edges.
   const markerX=Number.parseFloat(this.marker.style.left),markerY=Number.parseFloat(this.marker.style.top);
   const x=e.clientX-rect.left,y=e.clientY-rect.top;
   if(Number.isFinite(markerX)&&Math.hypot(x-markerX,y-markerY)<=48){
    if(this.focus==='pin')return 'pin';if(this.focus==='hose')return 'hose';if(this.focus==='gauge')return 'gauge';if(this.focus==='handle')return 'handle';
   }
   const mesh=this.ray.intersectObject(this.model.root,true)[0]?.object;if(!mesh)return '';
   for(let o:THREE.Object3D|null=mesh;o;o=o.parent){if(/gauge/i.test(o.name))return 'gauge';if(o.name==='SafetyPin')return 'pin';if(o.name==='Lever')return 'handle';if(o.name==='Nozzle'||o.name==='Hose')return 'hose';}return '';
  };
  let drag:{part:string;x:number;y:number;start:number;dx:number;dy:number}|null=null;
  canvas.onpointerdown=e=>{
   const part=hit(e);if(!part)return;
   if((part==='pin'||part==='hose')&&!this.model.partPosition(part==='pin'?'pin':'nozzle',this.markerPoint))return;
   e.preventDefault();e.stopPropagation();canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';
   if((part==='pin'&&this.focus==='pin')||(part==='hose'&&this.focus==='hose')){
    const rect=canvas.getBoundingClientRect();const a=new THREE.Vector3(),b=new THREE.Vector3();
    if(part==='pin'){this.model.partPosition('pin',a);b.copy(a).add(new THREE.Vector3(.136,0,0));}
    else{this.model.root.getObjectByName('Nozzle_Tip')!.getWorldPosition(a);b.copy(this.flame.position);b.y=.035;}
    a.project(this.camera);b.project(this.camera);
    drag={part,x:e.clientX,y:e.clientY,start:part==='pin'?this.pinProgress:this.aimProgress,dx:(b.x-a.x)*rect.width*.5,dy:-(b.y-a.y)*rect.height*.5};
    const length=Math.hypot(drag.dx,drag.dy);
    if(length<1){drag.dx=64;drag.dy=0;}else{const travel=Math.min(88,Math.max(48,length));drag.dx*=travel/length;drag.dy*=travel/length;}
   }else this.activate(part,true);
  };
  canvas.onpointermove=e=>{
   if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
   const value=THREE.MathUtils.clamp(drag.start+(dx*drag.dx+dy*drag.dy)/(drag.dx*drag.dx+drag.dy*drag.dy),0,1);
   if(drag.part==='pin')this.pinProgress=value;else this.aimProgress=value;
   this.activate(`${drag.part}-drag`,true,value);
  };
  const release=()=>{canvas.style.cursor='grab';if(drag){const value=drag.part==='pin'?this.pinProgress:this.aimProgress;this.activate(`${drag.part}-drag`,false,value);drag=null;}else this.activate('handle',false);};
  canvas.onpointerup=release;canvas.onpointercancel=()=>{drag=null;this.activate('handle',false);};
  this.marker.onpointerdown=e=>{canvas.onpointerdown!(e);};
  this.marker.onkeydown=e=>{if(e.key==='ArrowRight'&&(this.focus==='pin'||this.focus==='hose')){e.preventDefault();const part=this.focus==='pin'?'pin':'hose';const value=Math.min(1,(part==='pin'?this.pinProgress:this.aimProgress)+.2);if(part==='pin')this.pinProgress=value;else this.aimProgress=value;this.activate(`${part}-drag`,false,value);}};
  void this.model.ready.then(()=>{this.model.root.traverse(o=>{if(o instanceof THREE.Mesh){const m=o.material as THREE.MeshStandardMaterial;if(m.isMeshStandardMaterial){o.material=m.clone();this.ownedMaterials.push(o.material as THREE.MeshStandardMaterial);}}});this.focused="";}).catch(()=>{if(this.alive)container.dataset.error='모델을 불러오지 못했어요. 화면을 다시 열어 주세요.';});
  this.frame(0);
 }
 closeup(on:boolean):void{this.zoom=on;}
 private zoom=true;
 private frame=(now:number):void=>{
  if(!this.alive)return;this.raf=requestAnimationFrame(this.frame);
  const dt=Math.min(.05,(now-this.last)/1000);if(dt<1/30&&this.last)return;this.last=now;
  const w=Math.max(1,this.container.clientWidth),h=Math.max(1,this.container.clientHeight);if(this.renderer.domElement.width!==Math.round(w*this.renderer.getPixelRatio())||this.renderer.domElement.height!==Math.round(h*this.renderer.getPixelRatio())){this.renderer.setSize(w,h,false);this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  if(this.camera.aspect!==w/h){this.camera.aspect=w/h;this.camera.updateProjectionMatrix();}
  // The action state never changes the framing. Step four needs the lever and
  // the nozzle in one shot, including before the learner presses anything.
  if(this.zoom&&this.focus==='pin'){
   this.cameraGoal.set(.05+this.pinProgress*.08,.59,.36);
   this.lookGoal.set(-.075+this.pinProgress*.08,.512,.025);
  }else if(this.zoom&&this.focus==='gauge'){
   this.cameraGoal.set(.12,.62,.52);
   this.lookGoal.set(-.10,.47,.04);
  }else if(this.zoom&&this.focus==='handle'){
   const distance=Math.max(1.10,1.10/this.camera.aspect);
   this.cameraGoal.set(.15,.53,distance);
   this.lookGoal.set(.106,.355,.055);
  }else{
   const distance=Math.max(1.48,1.76/this.camera.aspect);
   this.cameraGoal.set(.23,.59,distance);
   this.lookGoal.set(.24,.29,.04);
  }
  const transition=this.cameraStarted?1-Math.exp(-dt*9):1;
  this.cameraStarted=true;
  this.camera.position.lerp(this.cameraGoal,transition);
  this.cameraLook.lerp(this.lookGoal,transition);
  this.camera.lookAt(this.cameraLook);
  this.camera.updateMatrixWorld();
  this.pin=THREE.MathUtils.damp(this.pin,this.step>0?1:this.pinProgress,10,dt);if(this.pin>.995)this.pin=1;
  this.aim.x=.48+this.sweep*.30;
  const aiming=this.step>1?1:this.aimProgress;
  this.nozzleHand.copy(this.parked).lerp(this.hand,aiming);this.nozzleAim.copy(this.parked).add(this.forwardAim).lerp(this.aim,aiming);
  this.model.pose(this.pin,this.squeezing?1:0,aiming>0?this.nozzleHand:undefined,aiming>0?this.nozzleAim:undefined);
  if(this.step>0&&this.pin>.995){this.pinDrop=Math.min(1,this.pinDrop+dt*2);this.model.displayRemovedPin(this.pinTray,this.pinDrop);}
  let spray:typeof this.powderRay|null=null;
  if(this.squeezing&&this.pin===1&&this.step>=2&&this.model.nozzleRay(this.nozzle,this.direction)){this.powderRay.len=this.nozzle.distanceTo(this.aim);spray=this.powderRay;}
  this.powder.update(dt,spray,true,this.camera.position);
  const sprayStep=this.focus==='handle'||this.focus==='sweep'||this.focus==='done';
  this.backdropMix=THREE.MathUtils.damp(this.backdropMix,sprayStep?1:0,9,dt);
  this.renderer.setClearColor(this.backdrop.copy(this.inspectionBackground).lerp(this.sprayBackground,this.backdropMix));
  this.ground.material.color.copy(this.inspectionFloor).lerp(this.sprayFloor,this.backdropMix);
  this.powderLabel.hidden=!this.powder.root.visible;
  this.flame.scale.set(Math.max(.02,1-this.passes/4)*(1+Math.sin(now*.009)*.08),Math.max(.02,1-this.passes/4)*(1+Math.sin(now*.012)*.12),Math.max(.02,1-this.passes/4));
  if(this.focused!==this.focus){this.focused=this.focus;
   this.model.root.traverse(o=>{if(o instanceof THREE.Mesh){let hit=false;for(let p:THREE.Object3D|null=o;p;p=p.parent){if(this.focus==='gauge'&&/Gauge[_ ]face|Gauge[_ ]normal|Gauge[_ ]needle/i.test(p.name)||this.focus==='pin'&&p.name==='SafetyPin'||this.focus==='hose'&&p.name==='Nozzle'||this.focus==='handle'&&p.name==='Lever')hit=true;}
    const m=o.material as THREE.MeshStandardMaterial;if(m.isMeshStandardMaterial){m.emissive.setHex(hit?(this.focus==='gauge'?0x19b96f:0xf0bc32):0);m.emissiveIntensity=hit?(this.focus==='pin'?.08:.45):0;}}});
  }
  const local=this.focus==='gauge'?new THREE.Vector3(.0288,.4384,.1112):this.focus==='pin'?new THREE.Vector3(.0584,.508,.028):this.focus==='handle'?new THREE.Vector3(0,.52,.07):new THREE.Vector3(.27,.28,.1);
  let targetVisible=true;
  if(this.focus==='pin')targetVisible=this.model.partPosition('pin',this.markerPoint);
  else if(this.focus==='hose')targetVisible=this.model.partPosition('nozzle',this.markerPoint);
  else this.model.root.localToWorld(this.markerPoint.copy(local));

  this.marker.setAttribute('aria-label',this.focus==='pin'?'안전핀: 고리 가운데를 잡고 오른쪽으로 끌어요':this.focus==='hose'?'노즐을 불 아래 표시로 끌어요':'반짝이는 부품을 눌러요');
  this.markerPoint.project(this.camera);this.marker.hidden=!targetVisible||this.focus==='done'||this.focus==='sweep';this.marker.style.left=`${THREE.MathUtils.clamp((this.markerPoint.x*.5+.5)*w,20,w-60)}px`;this.marker.style.top=`${THREE.MathUtils.clamp((-.5*this.markerPoint.y+.5)*h,20,h-55)}px`;
  this.markerPoint.copy(this.flame.position);this.markerPoint.y=.035;this.markerPoint.project(this.camera);
  this.fireTarget.hidden=this.focus!=='hose'&&this.focus!=='sweep';this.fireTarget.style.left=`${(this.markerPoint.x*.5+.5)*w}px`;this.fireTarget.style.top=`${(-this.markerPoint.y*.5+.5)*h}px`;
  this.renderer.render(this.scene,this.camera);
 };
 dispose():void{
  this.alive=false;cancelAnimationFrame(this.raf);this.model.dispose();this.powder.dispose();for(const o of [this.ground,this.tray,this.flame]){o.geometry.dispose();(o.material as THREE.Material).dispose();}for(const material of this.ownedMaterials)material.dispose();this.marker.remove();this.fireTarget.remove();this.powderLabel.remove();this.renderer.dispose();this.renderer.domElement.remove();
 }
}
