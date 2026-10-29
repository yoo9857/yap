import { EMOTES, type CharacterId, type EmoteId } from "@robo/shared";
import { t } from "../ui/i18n.js";
export class EmoteMenu {
    private readonly root = document.createElement("div");
    private readonly style = document.createElement("style");
    private readonly buttons: HTMLButtonElement[] = [];
    private priorFocus: HTMLElement | null = null;
    private focusIndex = 0;
    constructor(parent: HTMLElement, private readonly choose: (id: EmoteId) => void, private readonly character: (id: CharacterId) => void, private readonly closed: () => void) {
        this.style.textContent = `.emote-screen[hidden]{display:none}.emote-screen{position:fixed;inset:0;z-index:180;display:grid;place-items:center;background:#13263866;backdrop-filter:blur(6px);padding:18px}.emote-card{width:min(570px,100%);max-height:90vh;overflow:auto;padding:23px;border:2px solid #ffffffb8;border-radius:24px;background:#fffcf1;color:#37483b;box-shadow:0 18px 70px #13241855;font-family:system-ui,sans-serif}.emote-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px}.emote-head h2{font-size:22px;margin:0}.emote-card button{cursor:pointer;font:inherit}.emote-close{border:0;background:#e9eadf;border-radius:50%;width:34px;height:34px;color:#56644e}.emote-help{font-size:12px;color:#7c8973;margin:5px 0 15px}.emote-characters{display:flex;gap:8px;margin:12px 0 17px}.emote-characters button{flex:1;border:1px solid #d8dfcd;padding:9px;background:#f2f3e7;border-radius:12px;color:#526448}.emote-characters button[aria-pressed=true]{background:#dceecb;border-color:#87af6d;color:#2b4f28}.emote-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px}.emote-item{display:flex;position:relative;flex-direction:column;align-items:center;gap:6px;border:1px solid #dce0d1;border-radius:13px;padding:11px 3px;background:#fffef8;color:#4e604a;font-size:11px!important;min-height:78px}.emote-item span{font-size:26px;line-height:1.2}.emote-item small{position:absolute;left:6px;top:3px;color:#a4af94;font-size:9px}.emote-item:hover,.emote-item:focus-visible{outline:3px solid #9bbd7d;outline-offset:1px;background:#edf4dc}.emote-foot{font-size:11px;color:#879079;margin:17px 0 0}.emote-toast-hint{position:fixed;right:18px;bottom:108px;z-index:15;border:1px solid #ffffff80;border-radius:12px;padding:8px 12px;background:#17302dcc;color:#fff;font:12px system-ui;pointer-events:none}@media(max-width:480px){.emote-card{padding:16px}.emote-grid{grid-template-columns:repeat(4,1fr)}.emote-item{min-height:70px}}`;
        this.root.addEventListener("keydown", e => { if (this.open) {
            this.handleKey(e);
            e.stopPropagation();
        } });
        this.root.className = "emote-screen";
        this.root.hidden = true;
        this.root.setAttribute("role", "dialog");
        this.root.setAttribute("aria-modal", "true");
        this.root.setAttribute("aria-labelledby", "emote-heading");
        const card = document.createElement("div");
        card.className = "emote-card";
        const head = document.createElement("div");
        head.className = "emote-head";
        const h = document.createElement("h2");
        h.id = "emote-heading";
        h.textContent = t("나의 감정표현", "Express yourself");
        const close = document.createElement("button");
        close.className = "emote-close";
        close.textContent = "✕";
        close.setAttribute("aria-label", t("닫기", "Close"));
        close.onclick = () => this.setOpen(false);
        head.append(h, close);
        const help = document.createElement("p");
        help.className = "emote-help";
        help.textContent = t("표정과 동작을 골라 마음을 전해요", "Choose a face or a gesture");
        const characters = document.createElement("div");
        characters.className = "emote-characters";
        for (const [id, label] of [["mascot", "🟨 HOME"], ["tt", "🐰 TT"]] as const) {
            const b = document.createElement("button");
            b.dataset.character = id;
            b.textContent = label;
            b.onclick = () => { this.character(id); this.setCharacter(id); };
            characters.append(b);
        }
        const grid = document.createElement("div");
        grid.className = "emote-grid";
        EMOTES.forEach((def, i) => { const b = document.createElement("button"); b.className = "emote-item"; b.dataset.emote = def.id; b.setAttribute("aria-label", t(def.ko, def.en)); const icon = document.createElement("span"); icon.textContent = def.icon; const label = document.createElement("b"); label.textContent = t(def.ko, def.en); b.append(icon, label); if (i < 9) {
            const n = document.createElement("small");
            n.textContent = String(i + 1);
            b.append(n);
        } b.onclick = () => { this.choose(def.id); this.setOpen(false); }; this.buttons.push(b); grid.append(b); });
        const foot = document.createElement("p");
        foot.className = "emote-foot";
        foot.textContent = t("C 닫기 · 1–9 빠른 선택 · Z 기어가기 / 일어서기 · E 가방 · I 조합", "C close · 1–9 quick pick · Z crawl / stand · E bag · I crafting");
        card.append(head, help, characters, grid, foot);
        this.root.append(card);
        this.root.addEventListener("click", e => { if (e.target === this.root)
            this.setOpen(false); });
        parent.append(this.style, this.root);
        this.setCharacter("mascot");
    }
    get open(): boolean { return !this.root.hidden; }
    setCharacter(id: CharacterId): void { this.root.querySelectorAll<HTMLButtonElement>("[data-character]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.character === id))); }
    setOpen(open: boolean): void { if (open === this.open)
        return; this.root.hidden = !open; if (open) {
        this.priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.focusIndex = 0;
        this.buttons[0]?.focus();
    }
    else {
        this.priorFocus?.focus();
        this.closed();
    } }
    handleKey(e: KeyboardEvent): boolean {
        if (!this.open)
            return false;
        if (e.code === "Escape" || e.code === "KeyC") {
            if (!e.repeat)
                this.setOpen(false);
            e.preventDefault();
            return true;
        }
        const n = Number(e.code.replace("Digit", ""));
        if (n >= 1 && n <= 9 && !e.repeat) {
            this.buttons[n - 1]?.click();
            e.preventDefault();
            return true;
        }
        const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 } as Record<string, number>)[e.code];
        if (delta !== undefined) {
            this.focusIndex = (this.focusIndex + delta + this.buttons.length) % this.buttons.length;
            this.buttons[this.focusIndex]?.focus();
            e.preventDefault();
            return true;
        }
        if (e.code === "Tab") {
            const focusable = [...this.root.querySelectorAll<HTMLButtonElement>("button")];
            const at = focusable.indexOf(document.activeElement as HTMLButtonElement);
            focusable[(at + (e.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus();
            e.preventDefault();
            return true;
        }
        return true;
    }
    dispose(): void { this.root.remove(); this.style.remove(); }
}
