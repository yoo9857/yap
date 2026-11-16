import { PLAZA_PROTOCOL_VERSION, decodePlazaServer, type CharacterId, type PlazaClientMessage, type PlazaServerMessage } from "@robo/shared";

export class PlazaClient {
  onMessage: (message: PlazaServerMessage) => void = () => {};
  onStatus: (status: "connecting" | "online" | "offline" | "full" | "version") => void = () => {};
  private ws: WebSocket | null = null;
  private timer = 0;
  private retry = 0;
  private stopped = false;
  private welcomed = false;
  private sequence = 0;
  constructor(private name: string, private character: CharacterId, private channel?: number) {}
  connect(): void {
    this.stopped = false; this.welcomed = false; clearTimeout(this.timer);
    this.onStatus("connecting");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?mode=plaza`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "z-hello", v: PLAZA_PROTOCOL_VERSION, name: this.name, character: this.character, ...(this.channel ? { channel: this.channel } : {}) }));
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const message = decodePlazaServer(e.data); if (!message) return;
      if (message.t === "s-z-welcome") { this.channel = message.channel; this.welcomed = true; this.sequence = 0; this.retry = 0; this.onStatus("online"); }
      if (message.t === "s-z-error") { this.stopped = true; this.onStatus(message.code === "version" ? "version" : "full"); }
      this.onMessage(message);
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.welcomed = false; this.onStatus("offline");
      this.timer = window.setTimeout(() => this.connect(), Math.min(8000, 600 * 2 ** this.retry++));
    };
    ws.onerror = () => {};
  }
  get online(): boolean { return this.welcomed && this.ws?.readyState === WebSocket.OPEN; }
  send(message: PlazaClientMessage): void { if (this.online) this.ws!.send(JSON.stringify(message)); }
  move(pose: Omit<Extract<PlazaClientMessage, { t: "z-move" }>, "t" | "seq">): void { this.send({ t: "z-move", seq: this.sequence++, ...pose }); }
  profile(name: string, character: CharacterId): void { this.name = name; this.character = character; this.send({ t: "z-profile", name, character }); }
  close(): void { this.stopped = true; this.welcomed = false; clearTimeout(this.timer); this.ws?.close(); this.ws = null; }
}
