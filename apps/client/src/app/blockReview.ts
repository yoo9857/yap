import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BlockKitModels, PIECES, pieceFamily, KIT_COLOURS } from "../craft/blockKitModels.js";
import {REVIEW_MATERIALS} from "../craft/blockMaterials.js";
import {connectionCase} from "../craft/naturalConnections.js";
import type {NaturalBlockKey} from "../craft/naturalBlockGeometry.js";
export function bootBlockReview(mount: HTMLElement): void {
    const library = new BlockKitModels("nature"),kitLibrary=new BlockKitModels("kit"), renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#e8ede4");
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 160);
    camera.position.set(19, 22, 25);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbit.target.set(0, .5, 0);
    orbit.maxPolarAngle = Math.PI * .88;
    orbit.minDistance = 3;
    orbit.maxDistance = 60;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6f8065, 2.2));
    const sun = new THREE.DirectionalLight(0xfff2d8, 3.1);
    sun.position.set(-9, 19, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: .1, far: 60 });
    sun.shadow.normalBias = .015;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xe4ecff, 1.0);
    fill.position.set(12, 8, -9);
    scene.add(fill);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(150, 150), new THREE.MeshStandardMaterial({ color: "#c6d1bf", roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -.018;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(30, 30, 0xabbca2, 0xc1cdb9);
    grid.position.y = -.012;
    grid.material.transparent = true;
    grid.material.opacity = .28;
    scene.add(grid);
    const checkerData=new Uint8Array(128*128*4);
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){const grid=x%16===0||y%16===0,light=(Math.floor(x/16)+Math.floor(y/16))%2===0;const rgb=grid?[44,67,50]:light?[239,224,156]:[112,162,184];checkerData.set([...rgb,255],(y*128+x)*4);}
    const checker=new THREE.DataTexture(checkerData,128,128);checker.colorSpace=THREE.SRGBColorSpace;checker.wrapS=checker.wrapT=THREE.RepeatWrapping;checker.needsUpdate=true;
    const checkerMaterial=new THREE.MeshStandardMaterial({map:checker,roughness:.7});
    const originals=new WeakMap<THREE.Object3D,THREE.Material|THREE.Material[]>();let uvMode=false;
    const applyInspection=(root:THREE.Object3D):void=>{root.traverse(object=>{if(!(object instanceof THREE.Mesh))return;if(!originals.has(object))originals.set(object,object.material as THREE.Material|THREE.Material[]);object.material=uvMode?checkerMaterial:originals.get(object)!;});};
    const nodes: THREE.Group[] = [], labels: HTMLDivElement[] = [];
    let selected = -1, yaw = 0, tilt = 0, surfaceKey="grass",designMode="nature",connectionMode="";
    let connectionModel:THREE.Group|null=null;
    const labelHost = document.getElementById("kit-labels")!, list = document.getElementById("kit-list")!, status = document.getElementById("kit-status")!;
    function group(index: number): THREE.Group { const object = (designMode==="nature"?library:kitLibrary).build(PIECES[index]!, yaw, tilt,surfaceKey); const box = new THREE.Box3().setFromObject(object); const center = box.getCenter(new THREE.Vector3()); object.position.set(-center.x, -box.min.y, -center.z); const wrapper = new THREE.Group(); wrapper.add(object);applyInspection(wrapper); return wrapper; }
    for (let i = 0; i < PIECES.length; i++) {
        const node = group(i);
        nodes.push(node);
        scene.add(node);
        const label = document.createElement("div");
        label.className = "kit-name";
        label.textContent = PIECES[i]!.ko;
        labels.push(label);
        labelHost.append(label);
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.index = String(i);
        const dot = document.createElement("i");
        dot.style.background = KIT_COLOURS[pieceFamily(PIECES[i]!)] ?? "#ddd";
        const title = document.createElement("span");
        title.textContent = PIECES[i]!.ko;
        button.append(dot, title);
        button.addEventListener("click", () => choose(i));
        list.append(button);
    }
    function layout(): void {if(connectionModel){scene.remove(connectionModel);connectionModel=null;} if(connectionMode){const key:NaturalBlockKey=["snow","grass","dirt","diamond-block"].includes(surfaceKey)?surfaceKey as NaturalBlockKey:"grass";connectionModel=library.buildConnected(connectionCase(connectionMode,key),6);const box=new THREE.Box3().setFromObject(connectionModel),center=box.getCenter(new THREE.Vector3());connectionModel.position.set(-center.x,-box.min.y,-center.z);applyInspection(connectionModel);scene.add(connectionModel);} nodes.forEach((node, i) => { node.visible = !connectionMode&&(selected < 0 || selected === i); node.position.set(selected < 0 ? (i % 4 - 1.5) * 5.2 : 0, 0, selected < 0 ? (Math.floor(i / 4) - 1) * 5.5 : 0); labels[i]!.hidden = !node.visible; }); list.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === selected)); }
    function choose(index: number): void { connectionMode="";(document.getElementById("kit-connection") as HTMLSelectElement).value="";selected = index; yaw = tilt = 0; refresh(); if (index < 0) {
        camera.position.set(19, 22, 25);
        orbit.target.set(0, .5, 0);
        status.textContent = "12종을 같은 격자 크기로 비교합니다.";
    }
    else {
        camera.position.set(4.7, 5.2, 6.3);
        orbit.target.set(0, .65, 0);
        status.textContent = PIECES[index]!.ko + " · 사용 블록 " + PIECES[index]!.cells.length + "개 · R 회전 / T 기울이기";
    } orbit.update(); }
    function refresh(): void {
        // Whole-kit comparison returns every preview to its common starting pose.
        const indices = selected < 0 ? nodes.map((_, i) => i) : [selected];
        for (const index of indices) {
            scene.remove(nodes[index]!);
            nodes[index] = group(index);
            scene.add(nodes[index]);
        }
        layout();
    }
    document.getElementById("kit-all")!.addEventListener("click", () => choose(-1));
    document.getElementById("kit-rotate")!.addEventListener("click", () => { if (selected >= 0) {
        yaw = (yaw + 1) % 4;
        refresh();
    } });
    document.getElementById("kit-tilt")!.addEventListener("click", () => { if (selected >= 0) {
        tilt = (tilt + 1) % 4;
        refresh();
    } });
    document.addEventListener("keydown", event => { if (event.code === "KeyR" && selected >= 0) {
        yaw = (yaw + 1) % 4;
        refresh();
    } if (event.code === "KeyT" && selected >= 0) {
        tilt = (tilt + 1) % 4;
        refresh();
    } });
    document.getElementById("kit-reset")!.addEventListener("click",()=>choose(selected));
    document.getElementById("kit-bottom")!.addEventListener("click",()=>{if(selected<0)choose(0);camera.position.set(3.4,-3.4,4.8);orbit.target.set(0,.5,0);orbit.update();status.textContent="하부 소켓 보기 · 기본방향 버튼으로 복원";});
    document.getElementById("kit-uv")!.addEventListener("click",()=>{uvMode=!uvMode;nodes.forEach(applyInspection);if(connectionModel)applyInspection(connectionModel);document.getElementById("kit-uv")!.classList.toggle("active",uvMode);status.textContent=uvMode?"UV 격자 · 1칸당 같은 무늬 크기 · 기울어진 면도 정비례":"색상·노멀·거칠기 재질 보기";});
    document.getElementById("kit-material")!.addEventListener("change",event=>{
      surfaceKey=(event.target as HTMLSelectElement).value;
      nodes.forEach((old,i)=>{scene.remove(old);nodes[i]=group(i);scene.add(nodes[i]);});layout();
      status.textContent=REVIEW_MATERIALS.find(m=>m.key===surfaceKey)!.description;
    });
    document.getElementById("kit-design")!.addEventListener("change",event=>{
      designMode=(event.target as HTMLSelectElement).value;
      nodes.forEach((old,i)=>{scene.remove(old);nodes[i]=group(i);scene.add(nodes[i]);});layout();
      status.textContent=designMode==="nature"?"자연형 · 재료별 형태 · 낮고 작은 조립 돌기":"기존 조립형 · 결합부와 하부 소켓";
    });
    document.getElementById("kit-connection")!.addEventListener("change",event=>{
      connectionMode=(event.target as HTMLSelectElement).value;layout();camera.position.set(5.6,5.8,7.4);orbit.target.set(0,1.0,0);orbit.update();status.textContent=connectionMode?"6방향 연결 검수 · 내부 면 생략 · 맨 위에만 잔디층":"단일 부품 검수";
    });
    const resize = () => { renderer.setSize(mount.clientWidth, mount.clientHeight); camera.aspect = mount.clientWidth / mount.clientHeight; camera.updateProjectionMatrix(); };
    new ResizeObserver(resize).observe(mount);
    resize();
    layout();
    const frame = () => { orbit.update(); nodes.forEach((node, i) => { if (!node.visible)
        return; const p = new THREE.Vector3(node.position.x, .05, node.position.z + 1.9).project(camera); const label = labels[i]!; label.style.left = (p.x * .5 + .5) * mount.clientWidth + "px"; label.style.top = (-p.y * .5 + .5) * mount.clientHeight + "px"; }); renderer.render(scene, camera); };
    renderer.setAnimationLoop(frame);
    addEventListener("pagehide", () => { renderer.setAnimationLoop(null); orbit.dispose(); library.dispose();kitLibrary.dispose();checker.dispose();checkerMaterial.dispose(); floor.geometry.dispose(); (floor.material as THREE.Material).dispose(); grid.geometry.dispose(); (grid.material as THREE.Material).dispose(); renderer.dispose(); }, { once: true });
}
