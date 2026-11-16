import { api, busy, fields, sayError, showError, when } from "/site/api.js";

const root = document.querySelector(".adm-wrap");
const view = (name) => { root.dataset.view = name; };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const STATUS = { new: "새 문의", read: "확인함", answered: "답변함", closed: "종료" };
const EVENTS = { signup: "가입", login: "로그인", "login-refused": "로그인 거부", logout: "로그아웃", "account-deleted": "계정 삭제", "admin-login": "관리자 로그인", "admin-refused": "관리자 로그인 거부", "teacher-disabled": "계정 정지", "teacher-enabled": "계정 정지 해제", "inquiry-answered": "문의 답변" };

let inquiries = [], open = 0;
const detail = root.querySelector('[data-form="inquiry"]');
function drawInquiries() {
  const list = root.querySelector('[data-list="inquiries"]');
  list.replaceChildren(...inquiries.map((q) => {
    const li = el("li"); li.dataset.status = q.status; if (q.id === open) li.classList.add("is-open");
    const b = el("button"); b.type = "button";
    b.append(el("span", STATUS[q.status], "adm-status"), el("strong", q.school), el("span", q.message, "adm-snip"), el("time", when(q.createdAt)));
    b.addEventListener("click", () => openInquiry(q.id));
    li.append(b); return li;
  }));
  if (!inquiries.length) list.append(el("li", "아직 문의가 없습니다.", "adm-empty"));
  const fresh = inquiries.filter((q) => q.status === "new").length;
  root.querySelector('[data-count="new"]').textContent = fresh ? String(fresh) : "";
}
function openInquiry(id) {
  const q = inquiries.find((x) => x.id === id);
  if (!q) return;
  open = id;
  for (const f of detail.querySelectorAll("[data-f]")) f.textContent = f.dataset.f === "createdAt" ? when(q.createdAt) : q[f.dataset.f];
  detail.reply.value = q.reply; detail.note.value = q.note; detail.status.value = q.status;
  detail.hidden = false; showError(detail);
  drawInquiries();
  if (q.status === "new") void save({ id, status: "read" }); // opening it is reading it
}
async function save(patch) {
  const r = await api("/api/admin/inquiry", patch);
  if (r.status === 401) return view("out");
  if (!r.ok) return showError(detail, sayError(r));
  inquiries = inquiries.map((q) => (q.id === r.inquiry.id ? r.inquiry : q));
  if (open === r.inquiry.id) detail.status.value = r.inquiry.status;
  drawInquiries();
}
detail.addEventListener("submit", (e) => {
  e.preventDefault(); showError(detail);
  const f = fields(detail);
  // a reply written now makes it "answered" unless the operator chose another state on purpose
  const was = inquiries.find((q) => q.id === open);
  const status = f.reply && was && !was.reply && f.status === was.status ? "answered" : f.status;
  void busy(detail, () => save({ id: open, reply: f.reply, note: f.note, status }));
});

async function drawTeachers() {
  const r = await api("/api/admin/teachers");
  if (!r.ok) return;
  root.querySelector('[data-list="teachers"]').replaceChildren(...r.teachers.map((t) => {
    const tr = el("tr"); if (t.status === "disabled") tr.className = "is-off";
    const act = el("button", t.status === "active" ? "정지" : "정지 해제", "adm-mini"); act.type = "button";
    act.addEventListener("click", async () => {
      if (t.status === "active" && !confirm(`${t.name} 선생님의 계정을 정지할까요? 바로 로그아웃됩니다.`)) return;
      await api("/api/admin/teacher", { id: t.id, status: t.status === "active" ? "disabled" : "active" });
      void drawTeachers();
    });
    const last = el("td"); last.append(act);
    tr.append(el("td", t.name), el("td", t.school), el("td", t.email), el("td", when(t.createdAt)), el("td", when(t.lastLoginAt)), el("td", t.status === "active" ? "사용 중" : "정지"), last);
    return tr;
  }));
}
async function drawAudit() {
  const r = await api("/api/admin/audit");
  if (!r.ok) return;
  root.querySelector('[data-list="audit"]').replaceChildren(...r.events.map((e) => { const tr = el("tr"); tr.append(el("td", when(e.at)), el("td", EVENTS[e.what] ?? e.what), el("td", e.teacherId ? `#${e.teacherId}` : "-"), el("td", e.ip)); return tr; }));
}
for (const tab of root.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => {
    for (const t of root.querySelectorAll("[data-tab]")) t.setAttribute("aria-selected", String(t === tab));
    for (const p of root.querySelectorAll("[data-pane]")) p.hidden = p.dataset.pane !== tab.dataset.tab;
    if (tab.dataset.tab === "teachers") void drawTeachers();
    if (tab.dataset.tab === "audit") void drawAudit();
  });
}
async function enter() {
  const r = await api("/api/admin/inquiries");
  if (!r.ok) return view("out");
  inquiries = r.inquiries; drawInquiries(); view("in");
}
const login = root.querySelector('[data-form="login"]');
login.addEventListener("submit", (e) => {
  e.preventDefault(); showError(login);
  void busy(login, async () => { const r = await api("/api/admin/login", { password: fields(login).password }); login.reset(); if (r.ok) await enter(); else showError(login, r.error === "wrong" ? "비밀번호가 맞지 않습니다." : sayError(r)); });
});
root.querySelector('[data-do="logout"]').addEventListener("click", async () => { await api("/api/admin/logout", {}); view("out"); });

const me = await api("/api/admin/me");
if (me.status === 503 || me.status === 0) view("closed");
else if (!me.open) view("closed");
else if (me.admin) await enter();
else view("out");
