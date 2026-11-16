import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { PLAZA_CHANNEL_SIZE, PLAZA_SPAWN, playerNameSchema, type CharacterId, type PlazaPlayer, type PlazaServerMessage } from "@robo/shared";
import type { RapierModule } from "../physics/physics.js";
import { GameRenderer } from "../render/renderer.js";
import { CharacterRig, disposeRig } from "../player/rig.js";
import { isTouchPlay } from "../input/touchPlay.js";
import { PartyLobby, gameUrl } from "../app/partyLobby.js";
import { PlazaPhysics, type PlazaCollision } from "./plazaPhysics.js";
import { PlazaCamera } from "./plazaCamera.js";
import { PlazaClient } from "./plazaClient.js";
import { PlazaAtmosphere } from "./plazaAtmosphere.js";
import { Sfx } from "../audio/sfx.js";
import { Bgm, BGM_PLAYLIST } from "../audio/bgm.js";

/** What each country's ground sounds like underfoot (audio/materialSounds.ts families). */
const GROUND: Record<string, string> = { centre: "stone", castle: "stone", jungle: "grass", sky: "grass", harbor: "wood", snow: "snow", desert: "sand", gears: "stone" };
import manifest from "./worldManifest.json";
import "./plaza.css";

interface Remote { rig: CharacterRig; target: THREE.Vector3; yaw: number; player: PlazaPlayer; label: HTMLSpanElement }
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const normalYaw = (yaw: number) => Math.atan2(Math.sin(yaw), Math.cos(yaw));

export class PlazaGame {
  private readonly renderer: GameRenderer;
  private readonly rig = new CharacterRig();
  private readonly ui = document.createElement("section");
  private readonly events = new AbortController();
  private readonly keys = new Set<string>();
  private readonly remotes = new Map<string, Remote>();
  private physics!: PlazaPhysics;
  private camera!: PlazaCamera;
  private client: PlazaClient | null = null;
  private party!: PartyLobby;
  private map: THREE.Object3D | null = null;
  private name = "";
  private character: CharacterId = "mascot";
  private you = "";
  private channel = 0;
  private frame = 0;
  private last = 0;
  private accumulator = 0;
  private sendAt = 0;
  private moveX = 0;
  private moveZ = 0;
  private jump = false;
  private nameDialog = false;
  private disposed = false;
  private readonly projected = new THREE.Vector3();
  /** The craft world's sky, water, light and air over the model (plazaAtmosphere.ts). */
  private atmosphere: PlazaAtmosphere | null = null;
  private readonly sfx = new Sfx();
  private readonly bgm = new Bgm(BGM_PLAYLIST, 0.28);
  private stepPhase = -1;
  private stepWalked = 0;
  private wasGrounded = true;
  /** Dev: a camera held where a screenshot wants it. */
  private heldView: { from: THREE.Vector3; to: THREE.Vector3 } | null = null;

  constructor(private readonly mount: HTMLElement, private readonly rapier: RapierModule) {
    this.renderer = new GameRenderer(mount);
    this.renderer.scene.background = new THREE.Color(0xc6e4f2);
    this.renderer.scene.fog = new THREE.Fog(0xc6e4f2, 190, 430);
    this.renderer.camera.far = 650; this.renderer.camera.near = .06; this.renderer.camera.updateProjectionMatrix();
    this.renderer.scene.add(this.rig.root);
  }
  async prepare(report: (text: string) => void): Promise<void> {
    report("일곱 나라와 메인광장을 불러오는 중…");
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    let lastProgress = -1;
    const [gltf, collision] = await Promise.all([
      loader.loadAsync(`${manifest.model}?v=${manifest.version}`, e => {
        if (!e.total) return;
        const progress = Math.floor(e.loaded / e.total * 10) * 10;
        if (progress !== lastProgress) { lastProgress = progress; report(`메인광장 내려받는 중… ${progress}%`); }
      }),
      fetch(`${manifest.collision}?v=${manifest.version}`).then(async response => {
        if (!response.ok) throw new Error(`Plaza collision ${response.status}`);
        return await response.json() as PlazaCollision;
      }),
    ]);
    this.map = gltf.scene; this.map.name = "CraftYap Main Plaza";
    if (this.disposed) { this.freeMap(); return; }
    this.map.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      object.castShadow = object.receiveShadow = true;
      object.frustumCulled = true;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        material.shadowSide = THREE.DoubleSide;
      }
    });
    this.renderer.scene.add(this.map);
    this.atmosphere = new PlazaAtmosphere(this.renderer, this.map, manifest.regions);
    report("바위·건물·계단의 충돌을 연결하는 중…"); await pause();
    this.physics = new PlazaPhysics(this.rapier, collision);
    this.camera = new PlazaCamera(this.renderer.camera, this.renderer.renderer.domElement);
    this.buildUi(); this.bindInput();
    this.rig.root.position.copy(this.physics.feet);
    this.camera.update(this.physics.feet, this.physics); this.renderer.trackTarget(this.physics.feet);
    report("광장 조명과 캐릭터를 준비하는 중…"); await pause();
    // the water's passes draw with materials of their own: the scene's compile does not know them
    this.renderer.waterPipeline?.compile(this.renderer.renderer, this.renderer.scene, this.renderer.camera);
    await this.renderer.renderer.compileAsync(this.renderer.scene, this.renderer.camera);
  }
  start(): void {
    this.last = performance.now(); this.frame = requestAnimationFrame(this.tick);
    try { this.name = localStorage.getItem("robo-name")?.trim() ?? ""; } catch { /* optional */ }
    if (playerNameSchema.safeParse(this.name).success) this.connect();
    else this.askName();
    if (import.meta.env.DEV) {
      (window as unknown as { __roboPlaza: unknown }).__roboPlaza = {
        state: () => ({ position: this.physics.feet.toArray(), grounded: this.physics.grounded, channel: this.channel, online: this.client?.online ?? false, peers: this.remotes.size, you: this.you, camera: this.renderer.camera.position.toArray(), render: this.renderer.renderer.info.render }),
        teleport: (pos: number[]) => this.physics.teleport(pos),
        // screenshots: leave the server (it corrects a teleport), hold the camera, read the atmosphere
        offline: () => { this.client?.close(); this.client = null; },
        view: (from: number[] | null, to: number[] = [0, 0, 0]) => { this.heldView = from ? { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to) } : null; },
        atmosphere: () => this.atmosphere?.debug(),
        dispose: () => this.dispose(),
      };
    }
  }
  private buildUi(): void {
    this.ui.className = "plaza-ui"; this.ui.setAttribute("aria-label", "메인광장"); this.ui.dataset.touch = String(isTouchPlay());
    this.ui.innerHTML = `
      <header class="plaza-top"><div class="plaza-place"><span class="plaza-logo" aria-hidden="true">✦</span><div><b>메인광장</b><small data-pz="status">광장에 들어오는 중…</small></div></div>
        <nav class="plaza-actions" aria-label="친구와 함께"><button class="plaza-primary" data-id="party-create" type="button">＋ 방 만들기</button><button data-id="party-browse" type="button" aria-expanded="false">열린 방</button><button data-id="party-code" type="button">코드 참여</button><button data-pz="invite" type="button">친구 초대</button><button data-pz="menu" type="button" aria-label="광장 메뉴">☰</button></nav></header>
      <div class="plaza-tags" aria-hidden="true"></div>
      <aside class="plaza-info"><b data-pz="area">중앙 광장</b><span data-pz="count">친구를 기다리고 있어요</span></aside>
      <aside class="plaza-chat"><div class="plaza-chat-head"><b>광장 이야기</b><button type="button" data-pz="close-chat" aria-label="채팅 닫기">✕</button></div><ul data-pz="chat-log" aria-live="polite"></ul><form data-pz="chat"><input maxlength="120" aria-label="광장 채팅" placeholder="친구에게 인사해요" autocomplete="off" disabled /><button type="submit" disabled>보내기</button></form></aside>
      <div class="plaza-bottom"><span>WASD / 방향키 이동 · 드래그 시점 · Space 점프</span><button type="button" data-pz="chat-toggle">채팅</button><button type="button" data-pz="wave">👋 인사</button><button type="button" data-pz="reset">광장으로</button></div>
      <div class="plaza-controls"><div class="plaza-joystick" aria-label="이동 조이스틱"><span></span></div><button class="plaza-jump" type="button" aria-label="점프">점프</button></div>
      <aside class="party-drawer" data-id="party-drawer" aria-label="방 목록" aria-hidden="true"><div class="party-drawer-head"><h2>열린 방</h2><span class="party-status" data-id="party-status"></span><button type="button" class="party-drawer-x" data-id="party-drawer-close" aria-label="방 목록 닫기">✕</button></div><form class="party-codebar" data-id="party-codebar"><input data-id="party-codebar-input" maxlength="6" autocomplete="off" placeholder="방 코드 6자리" aria-label="방 코드" /><button type="submit">코드 참여</button></form><ul class="party-rows" data-id="party-rows"></ul><p class="party-empty" data-id="party-empty">아직 열린 방이 없어요.<br>방을 만들고 친구를 불러 보세요!</p></aside>
      <div class="plaza-menu" hidden><section role="dialog" aria-label="광장 메뉴"><h2>잠깐 쉬어 갈까요?</h2><p data-id="hub-name"></p><button data-pz="rename" type="button">내 이름 바꾸기</button><button data-pz="character" type="button">캐릭터 바꾸기</button><button data-pz="reconnect" type="button">다시 접속</button><a href="/?pick=1" data-pz="exit">모드 선택으로</a><button data-pz="resume" class="plaza-primary" type="button">광장으로 돌아가기</button></section></div>
      <p class="hub-toast" role="status" aria-live="polite"></p>`;
    this.mount.appendChild(this.ui);
    this.party = new PartyLobby(this.ui, {
      onName: name => { this.name = name; this.client?.profile(name, this.character); },
      onLaunch: (game, code, name) => {
        try { sessionStorage.setItem("craftyap-plaza-return", String(this.channel || 1)); } catch { /* optional */ }
        const url = new URL(gameUrl(game, code, name), location.href); url.searchParams.set("from", "plaza");
        this.dispose(); location.href = url.pathname + url.search;
      },
    });
    const bind = (id: string, fn: () => void) => this.ui.querySelector(`[data-pz="${id}"]`)!.addEventListener("click", fn, { signal: this.events.signal });
    bind("invite", () => void this.invite());
    bind("menu", () => this.menu(true)); bind("resume", () => this.menu(false));
    bind("rename", () => { this.menu(false); this.askName(); });
    bind("character", () => { this.character = this.character === "mascot" ? "tt" : "mascot"; this.rig.setCharacter(this.character); this.client?.profile(this.name, this.character); this.menu(false); });
    bind("reconnect", () => { this.client?.close(); const url = new URL(location.href); url.searchParams.delete("channel"); location.href = url.href; });
    bind("reset", () => this.reset());
    bind("wave", () => { this.rig.setEmote("wave", Date.now()); this.client?.send({ t: "z-chat", text: "👋 안녕!" }); });
    bind("chat-toggle", () => { this.ui.querySelector(".plaza-chat")?.classList.toggle("open"); });
    bind("close-chat", () => { this.ui.querySelector(".plaza-chat")?.classList.remove("open"); });
    bind("exit", () => { try { sessionStorage.removeItem("craftyap-plaza-return"); } catch { /* optional */ } });
    this.ui.querySelector(".plaza-chat form")!.addEventListener("submit", e => {
      e.preventDefault(); const input = this.ui.querySelector<HTMLInputElement>('[data-pz="chat"] input')!;
      const text = input.value.trim(); if (text && this.client?.online) { this.client.send({ t: "z-chat", text }); input.value = ""; }
    });
  }
  private connect(): void {
    this.client?.close();
    const requested = Number(new URLSearchParams(location.search).get("channel"));
    this.client = new PlazaClient(this.name, this.character, Number.isInteger(requested) && requested > 0 && requested <= 999 ? requested : undefined);
    this.client.onStatus = status => {
      const text = status === "online" ? `채널 ${this.channel || 1} · 연결됨` : status === "connecting" ? "친구들과 연결하는 중…" : status === "full" ? "이 광장이 가득 찼어요 · 메뉴에서 다른 광장으로 접속해요" : status === "version" ? "새 버전이 나왔어요 · 새로고침해 주세요" : "연결 끊김 · 다시 연결하는 중…";
      this.ui.querySelector('[data-pz="status"]')!.textContent = text;
      this.ui.dataset.online = String(status === "online");
      this.ui.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-pz="chat"] input, [data-pz="chat"] button').forEach(el => { el.disabled = status !== "online"; });
      if (status !== "online") this.clearRemotes();
    };
    this.client.onMessage = message => this.message(message); this.client.connect();
    const nameSlot = this.ui.querySelector('[data-id="hub-name"]'); if (nameSlot) nameSlot.textContent = this.name;
    this.party.start();
  }
  private message(message: PlazaServerMessage): void {
    if (message.t === "s-z-welcome") {
      this.you = message.you; this.channel = message.channel;
      this.ui.querySelector('[data-pz="status"]')!.textContent = `채널 ${this.channel} · 연결됨`;
      const me = message.players.find(p => p.id === this.you); if (me) this.physics.teleport(me.pos);
      this.snapshot(message.players);
    } else if (message.t === "s-z-snapshot") this.snapshot(message.players);
    else if (message.t === "s-z-correct") this.physics.teleport(message.pos);
    else if (message.t === "s-z-chat") {
      const line = document.createElement("li"); const author = document.createElement("b"); author.textContent = `${message.name} `;
      line.append(author, document.createTextNode(message.text));
      const log = this.ui.querySelector('[data-pz="chat-log"]')!; log.append(line); while (log.children.length > 30) log.firstElementChild?.remove(); log.scrollTop = log.scrollHeight;
      if (message.text === "👋 안녕!") this.remotes.get(message.id)?.rig.setEmote("wave", Date.now());
    }
  }
  private snapshot(players: PlazaPlayer[]): void {
    const ids = new Set(players.map(p => p.id));
    for (const [id, remote] of this.remotes) if (!ids.has(id)) { disposeRig(remote.rig.root); remote.rig.root.removeFromParent(); remote.label.remove(); this.remotes.delete(id); }
    for (const player of players) {
      if (player.id === this.you) continue;
      let remote = this.remotes.get(player.id);
      if (!remote) {
        const rig = new CharacterRig(player.character, .5); rig.root.position.set(...player.pos); this.renderer.scene.add(rig.root);
        const label = document.createElement("span"); label.className = "plaza-nametag"; this.ui.querySelector(".plaza-tags")!.append(label);
        remote = { rig, target: new THREE.Vector3(...player.pos), yaw: player.yaw, player, label }; this.remotes.set(player.id, remote);
      }
      remote.player = player; remote.target.set(...player.pos); remote.yaw = player.yaw; remote.label.textContent = player.name;
      remote.rig.setCharacter(player.character);
    }
    this.ui.querySelector('[data-pz="count"]')!.textContent = `같은 광장 ${players.length}/${PLAZA_CHANNEL_SIZE}명`;
  }
  private clearRemotes(): void {
    for (const remote of this.remotes.values()) { disposeRig(remote.rig.root); remote.rig.root.removeFromParent(); remote.label.remove(); }
    this.remotes.clear();
    if (!this.ui.firstElementChild) return;
    if (!this.ui.isConnected) return;
    this.ui.querySelector('[data-pz="count"]')!.textContent = "연결되면 친구들이 보여요";
  }
  private askName(): void {
    if (this.nameDialog) return; this.nameDialog = true;
    const dialog = document.createElement("div"); dialog.className = "plaza-name-dialog";
    dialog.innerHTML = `<form role="dialog" aria-label="광장에서 쓸 이름"><span>친구들과 만날 준비!</span><h2>광장에서 어떤 이름으로 불릴까요?</h2><label>내 이름<input maxlength="16" required autocomplete="nickname" placeholder="예: 별빛토끼" /></label><p role="status">1~16자로 정해 주세요.</p><button type="submit" class="plaza-primary">메인광장 입장</button></form>`;
    const input = dialog.querySelector("input")!; input.value = this.name; this.ui.append(dialog); input.focus();
    dialog.querySelector("form")!.addEventListener("submit", e => {
      e.preventDefault(); const result = playerNameSchema.safeParse(input.value);
      if (!result.success) { dialog.querySelector("p")!.textContent = "이름은 특수 제어문자 없이 1~16자로 써 주세요."; input.focus(); return; }
      this.name = result.data; try { localStorage.setItem("robo-name", this.name); } catch { /* optional */ }
      dialog.remove(); this.nameDialog = false;
      if (this.client) this.client.profile(this.name, this.character); else this.connect();
      this.ui.querySelector('[data-id="hub-name"]')!.textContent = this.name;
    });
  }
  private bindInput(): void {
    const signal = this.events.signal;
    const canvas = this.renderer.renderer.domElement; canvas.tabIndex = 0; canvas.setAttribute("aria-label", "크래프트얍 메인광장 3D 화면");
    this.ui.addEventListener("click", () => {
      window.setTimeout(() => { if (!this.disposed && !this.paused()) canvas.focus({ preventScroll: true }); }, 0);
    }, { signal });
    window.addEventListener("keydown", e => {
      if (e.code === "Escape") { if (!this.nameDialog && !this.party.escape()) this.menu(this.ui.querySelector<HTMLElement>(".plaza-menu")!.hidden); return; }
      if ((e.target as HTMLElement)?.closest("input,textarea,select,button,a")) return;
      this.keys.add(e.code);
      if (e.code === "Space") { if (!e.repeat) this.jump = true; e.preventDefault(); }
      if (e.code.startsWith("Arrow")) e.preventDefault();
    }, { signal });
    window.addEventListener("keyup", e => this.keys.delete(e.code), { signal });
    window.addEventListener("blur", () => { this.keys.clear(); this.moveX = this.moveZ = 0; this.jump = false; }, { signal });
    window.addEventListener("pagehide", () => this.dispose(), { once: true, signal });
    const joy = this.ui.querySelector<HTMLElement>(".plaza-joystick")!, knob = joy.querySelector<HTMLElement>("span")!;
    let pointer: number | null = null;
    const move = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2, length = Math.max(40, Math.hypot(x, y));
      this.moveX = x / length; this.moveZ = -y / length; knob.style.transform = `translate(${this.moveX * 35}px, ${-this.moveZ * 35}px)`;
    };
    joy.addEventListener("pointerdown", e => { pointer = e.pointerId; joy.setPointerCapture(e.pointerId); move(e); e.preventDefault(); }, { signal });
    joy.addEventListener("pointermove", e => { if (e.pointerId === pointer) move(e); }, { signal });
    const stop = () => { pointer = null; this.moveX = this.moveZ = 0; knob.style.transform = ""; };
    joy.addEventListener("pointerup", stop, { signal }); joy.addEventListener("pointercancel", stop, { signal });
    this.ui.querySelector(".plaza-jump")!.addEventListener("pointerdown", e => { this.jump = true; e.preventDefault(); }, { signal });
  }
  private paused(): boolean { return this.nameDialog || this.party.interacting || !this.ui.querySelector<HTMLElement>(".plaza-menu")!.hidden || !!document.activeElement?.closest("input,textarea,select"); }
  private menu(open: boolean): void { this.ui.querySelector<HTMLElement>(".plaza-menu")!.hidden = !open; this.keys.clear(); this.jump = false; }
  private reset(): void { if (this.client?.online) this.client.send({ t: "z-reset" }); else this.physics.teleport(PLAZA_SPAWN); }
  private async invite(): Promise<void> {
    if (!this.channel || !this.client?.online) { this.toast("광장에 연결된 다음 친구를 초대할 수 있어요."); return; }
    const url = new URL(location.pathname, location.origin); url.searchParams.set("mode", "plaza"); url.searchParams.set("channel", String(this.channel));
    try { await navigator.clipboard.writeText(url.href); this.toast("같은 광장으로 오는 초대 링크를 복사했어요!"); }
    catch { const input = document.createElement("input"); input.className = "plaza-invite-fallback"; input.value = url.href; input.readOnly = true; this.ui.append(input); input.select(); this.toast("초대 링크를 선택했어요. 복사해서 친구에게 보내 주세요."); input.addEventListener("blur", () => input.remove(), { once: true }); }
  }
  private toast(text: string): void { const toast = this.ui.querySelector<HTMLElement>(".hub-toast")!; toast.textContent = text; toast.classList.add("show"); window.setTimeout(() => toast.classList.remove("show"), 3000); }
  private tick = (now: number): void => {
    if (this.disposed) return;
    const dt = Math.min(.1, Math.max(0, (now - this.last) / 1000)); this.last = now; this.accumulator += dt;
    const paused = this.paused();
    const right = paused ? 0 : this.moveX + Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) - Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft"));
    const forward = paused ? 0 : this.moveZ + Number(this.keys.has("KeyW") || this.keys.has("ArrowUp")) - Number(this.keys.has("KeyS") || this.keys.has("ArrowDown"));
    const length = Math.max(1, Math.hypot(right, forward)); const speed = this.keys.has("ShiftLeft") ? 8 : 5.8;
    const yaw = this.camera.yaw, vx = (right * Math.cos(yaw) - forward * Math.sin(yaw)) / length * speed, vz = (-right * Math.sin(yaw) - forward * Math.cos(yaw)) / length * speed;
    while (this.accumulator >= 1 / 60) { this.physics.step(vx, vz, !paused && this.jump); this.jump = false; this.accumulator -= 1 / 60; }
    if (paused) this.jump = false;
    const feet = this.physics.feet;
    if (feet.y < -8 || Math.hypot(feet.x, feet.z) > 216) this.reset();
    this.rig.root.position.copy(feet);
    const planar = Math.hypot(this.physics.velocity.x, this.physics.velocity.z);
    if (planar > .15) this.rig.root.rotation.y = Math.atan2(this.physics.velocity.x, this.physics.velocity.z);
    const anim = this.physics.grounded ? planar > .25 ? "run" : "idle" : this.physics.velocity.y > .5 ? "jump" : "fall";
    this.rig.update(anim, planar, dt);
    this.rig.root.visible = this.camera.update(feet, this.physics) > 1.1;
    if (this.heldView) { this.renderer.camera.position.copy(this.heldView.from); this.renderer.camera.lookAt(this.heldView.to); }
    this.atmosphere?.update(dt, feet);
    this.footsteps(planar);
    for (const remote of this.remotes.values()) {
      const speed = Math.min(8, remote.rig.root.position.distanceTo(remote.target) * 10);
      remote.rig.root.position.lerp(remote.target, 1 - Math.exp(-14 * dt));
      remote.rig.root.rotation.y += normalYaw(remote.yaw - remote.rig.root.rotation.y) * (1 - Math.exp(-15 * dt));
      remote.rig.setDetail(feet.distanceToSquared(remote.target) < 28 ** 2); remote.rig.update(remote.player.anim, speed, dt);
      this.projected.copy(remote.rig.root.position); this.projected.y += 2.1; this.projected.project(this.renderer.camera);
      const visible = this.projected.z > -1 && this.projected.z < 1 && feet.distanceToSquared(remote.target) < 50 ** 2;
      remote.label.hidden = !visible;
      if (visible) remote.label.style.transform = `translate(-50%,-100%) translate(${(this.projected.x * .5 + .5) * innerWidth}px,${(-this.projected.y * .5 + .5) * innerHeight}px)`;
    }
    if (now - this.sendAt > 100 && this.client?.online) { this.sendAt = now; this.client.move({ pos: [feet.x, feet.y, feet.z], yaw: normalYaw(this.rig.root.rotation.y), anim }); }
    const region = manifest.regions.find(r => Math.hypot(feet.x - r.at[0]!, feet.z - r.at[2]!) < 48);
    this.ui.querySelector('[data-pz="area"]')!.textContent = region?.label ?? "중앙 광장";
    this.renderer.trackTarget(feet); this.renderer.render(); this.frame = requestAnimationFrame(this.tick);
  };
  /** Steps land on what is drawn (the HOME rig's gait, as in craft); the code-built mascot has no cue and steps by distance. */
  private footsteps(planar: number): void {
    const grounded = this.physics.grounded, ground = GROUND[this.atmosphere?.region ?? "centre"] ?? "stone";
    if (grounded && !this.wasGrounded) { this.sfx.step(ground, false, 1.25); this.atmosphere?.puff(this.physics.feet, 1.6); }
    else if (!grounded && this.wasGrounded && this.physics.velocity.y > 3) this.sfx.play("jump");
    this.wasGrounded = grounded;
    if (!grounded || planar < .3) { this.stepPhase = -1; this.stepWalked = 0; return; }
    const run = Math.min(1, Math.max(0, (planar - 2) / 5)), cue = this.rig.motionCue;
    let planted = false;
    if (cue?.gait) {
      const prev = this.stepPhase, now = cue.phase;
      planted = prev >= 0 && [0, .5].some(at => (prev <= now ? prev < at && at <= now : prev < at || at <= now));
      this.stepPhase = now;
    } else {
      this.stepWalked += planar / 60;
      if (this.stepWalked > .85) { this.stepWalked = 0; planted = true; }
    }
    if (planted) { this.sfx.step(ground, false, 1 - run * .45, 1 + run * .1); if (run > .15) this.atmosphere?.puff(this.physics.feet, .5 + run * .5); }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true; cancelAnimationFrame(this.frame); this.events.abort();
    this.atmosphere?.dispose(); this.atmosphere = null; this.sfx.dispose(); this.bgm.dispose();
    this.client?.close(); this.party?.dispose(); this.camera?.dispose(); this.clearRemotes(); disposeRig(this.rig.root);
    this.freeMap();
    this.physics?.dispose(); this.renderer.dispose(); this.ui.remove();
    if (import.meta.env.DEV) delete (window as unknown as { __roboPlaza?: unknown }).__roboPlaza;
  }
  private freeMap(): void {
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    this.map?.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
    for (const material of materials) {
      for (const value of Object.values(material) as unknown[]) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) texture.dispose(); for (const geometry of geometries) geometry.dispose();
    this.map?.removeFromParent(); this.map = null;
  }
}
