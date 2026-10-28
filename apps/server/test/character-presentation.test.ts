import { describe, expect, it } from "vitest";
import { decodeClassClient, decodeClassServer, type ClassServerMessage } from "@robo/shared";
import { ClassRoom, type ClassPeer } from "../src/classroom/classRoom.js";
class Peer implements ClassPeer {
    messages: ClassServerMessage[] = [];
    send(m: ClassServerMessage) { this.messages.push(m); }
    close() { }
}
describe("character presentation replication", () => {
    it("relays the selected character, crawl/lie pose and a stable emote event to classmates", () => {
        const room = new ClassRoom("Teacher", { passHash: "", salt: "" }), a = new Peer(), b = new Peer();
        room.hostTeacher(a);
        room.joinStudent(b, "Student");
        room.handle(a, { t: "k-move", pos: [0, 4, 0], yaw: 0, anim: "idle" });
        const raw = { t: "k-move", pos: [2, 4, 3], yaw: 1, anim: "crawl", character: "tt", emote: "wink", emoteSeq: 17 };
        const message = decodeClassClient(JSON.stringify(raw));
        expect(message).not.toBeNull();
        if (!message)
            throw Error("Bad presentation");
        room.handle(b, message);
        room.snapshot();
        const snap = [...a.messages].reverse().find(m => m.t === "s-k-snap");
        expect(snap?.t).toBe("s-k-snap");
        if (snap?.t !== "s-k-snap")
            throw Error("Missing snap");
        expect(snap.players.find(p => p.character === "tt")).toMatchObject({ anim: "crawl", emote: "wink", emoteSeq: 17 });
        expect(decodeClassServer(JSON.stringify(snap))).toEqual(snap);
        expect(decodeClassClient(JSON.stringify({ ...raw, emoteSeq: -1 }))).toBeNull();
        expect(decodeClassClient(JSON.stringify({ ...raw, emote: "<script>" }))).toBeNull();
    });
});
