import type { ClassRole } from "@robo/shared";
import type { ClassLesson } from "../net/classClient.js";
import { formatClock } from "./classTools.js";
import { t } from "../ui/i18n.js";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // the teacher's words are user input: never innerHTML
  return node;
};

const icon = (name: string, cls?: string) => {
  const img = el("img", cls);
  img.src = `/ui/game/tool-${name}.webp`;
  img.alt = "";
  img.draggable = false;
  return img;
};

/** How long an announcement stays up (ms). */
export const ANNOUNCE_MS = 6000;
/** The countdown turns red and pulses for its last seconds. */
const SOON_MS = 10_000;

/**
 * The lesson on everyone's screen (F2 tools): the timer pill at the top (a ring that empties, red
 * for the last 10 s, "끝!" for a moment at zero), the freeze card (students: big, mid-screen;
 * the teacher: a small reminder), and the teacher's announcement. Pure DOM, pointer-events none:
 * nothing here can steal a click from the game.
 */
export class LessonOverlay {
  private readonly timer = el("div", "lesson-timer");
  private readonly ring = el("span", "lesson-ring");
  private readonly clock = el("span", "lesson-clock");
  private readonly freeze = el("div", "lesson-freeze");
  private readonly announcement = el("div", "lesson-announce");
  private readonly announceText = el("b");
  private lesson: ClassLesson = { frozen: false, timerEnd: null, timerTotal: 0 };
  private interval = 0;
  private announceTimer = 0;
  private doneUntil = 0;

  /** `onTimeUp`: the countdown reached zero here (a chime). */
  constructor(private readonly role: ClassRole, private readonly onTimeUp?: () => void) {
    this.ring.append(icon("timer"));
    this.timer.append(this.ring, this.clock);
    this.timer.hidden = true;

    const card = el("div", "lesson-freeze-card");
    const words = el("div");
    words.append(
      el("b", "", role === "teacher" ? t("학생들이 멈춰 있어요", "The students are frozen") : t("잠깐! 선생님을 봐 주세요", "Freeze! Eyes on the teacher")),
      el("small", "", role === "teacher" ? "" : t("선생님이 풀어 줄 때까지 기다려요", "Wait until the teacher lets you go")),
    );
    card.append(icon("freeze"), words);
    this.freeze.append(card);
    this.freeze.classList.toggle("teacher", role === "teacher");
    this.freeze.hidden = true;

    const words2 = el("div");
    words2.append(el("small", "", t("선생님 공지", "FROM THE TEACHER")), this.announceText);
    this.announcement.append(icon("announce"), words2);
    this.announcement.hidden = true;

    document.body.append(this.timer, this.freeze, this.announcement);
  }

  get frozen(): boolean {
    return this.lesson.frozen;
  }

  set(lesson: ClassLesson): void {
    const prevEnd = this.lesson.timerEnd;
    this.lesson = lesson;
    this.freeze.hidden = !lesson.frozen;
    if (lesson.timerEnd !== null) {
      this.doneUntil = 0;
      this.timer.hidden = false;
      if (!this.interval) this.interval = window.setInterval(() => this.tick(), 200);
      this.tick();
    } else if (prevEnd !== null && this.doneUntil === 0) {
      // the server's end can land a moment before our own zero: that is the end, not a stop
      if (prevEnd - performance.now() < 1500) this.finish(performance.now());
      else this.stopClock(); // the teacher stopped it
    }
  }

  announce(text: string): void {
    window.clearTimeout(this.announceTimer);
    this.announceText.textContent = text;
    this.announcement.classList.remove("out");
    this.announcement.hidden = false;
    // restart the entrance animation for a second announcement over the first
    void this.announcement.offsetWidth;
    this.announcement.style.animation = "none";
    void this.announcement.offsetWidth;
    this.announcement.style.animation = "";
    this.announceTimer = window.setTimeout(() => {
      this.announcement.classList.add("out");
      this.announceTimer = window.setTimeout(() => (this.announcement.hidden = true), 350);
    }, ANNOUNCE_MS);
  }

  private tick(): void {
    const now = performance.now();
    if (this.doneUntil) {
      if (now >= this.doneUntil) this.stopClock();
      return;
    }
    const end = this.lesson.timerEnd;
    if (end === null) return;
    const left = end - now;
    if (left <= 0) {
      this.finish(now);
      return;
    }
    this.clock.textContent = formatClock(left);
    this.ring.style.setProperty("--p", String(Math.max(0, Math.min(1, left / Math.max(1, this.lesson.timerTotal)))));
    this.timer.classList.toggle("soon", left <= SOON_MS);
    this.timer.classList.remove("done");
  }

  /** Zero: "끝!" for 4 s and a chime (the server's own end message changes nothing after it). */
  private finish(now: number): void {
    this.clock.textContent = t("끝!", "Time!");
    this.ring.style.setProperty("--p", "0");
    this.timer.hidden = false;
    this.timer.classList.remove("soon");
    this.timer.classList.add("done");
    this.doneUntil = now + 4000;
    if (!this.interval) this.interval = window.setInterval(() => this.tick(), 200);
    this.onTimeUp?.();
  }

  private stopClock(): void {
    window.clearInterval(this.interval);
    this.interval = 0;
    this.doneUntil = 0;
    this.timer.hidden = true;
    this.timer.classList.remove("soon", "done");
  }

  /** Debug/E2E: what is on screen. */
  state(): { timer: string | null; frozen: boolean; announce: string | null } {
    return {
      timer: this.timer.hidden ? null : this.clock.textContent,
      frozen: !this.freeze.hidden,
      announce: this.announcement.hidden ? null : this.announceText.textContent,
    };
  }

  dispose(): void {
    window.clearInterval(this.interval);
    window.clearTimeout(this.announceTimer);
    this.timer.remove();
    this.freeze.remove();
    this.announcement.remove();
  }
}
