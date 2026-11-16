import { api, busy, fields, sayError, showError } from "/site/api.js";

const card = document.querySelector(".acct-card");
// the left side says where we are: the account (signed out) or 수업 관리 (signed in)
const view = (name) => {
  card.dataset.view = name;
  const side = name === "in" || name === "class" ? "in" : "out";
  for (const el of document.querySelectorAll(".acct-world [data-in]")) el.textContent = el.dataset[side];
  for (const el of document.querySelectorAll(".acct-world [data-when]")) el.hidden = el.dataset.when !== side;
};
const next = new URLSearchParams(location.search).get("next");
const show = (teacher, fresh = false) => {
  if (!teacher) return view("out");
  // asked from the game (선생님 로그인, the lobby's link): signing in goes straight back to opening a class
  if (fresh && next === "class") { location.href = "/?mode=education&as=teacher"; return; }
  for (const el of card.querySelectorAll("[data-me]")) el.textContent = teacher[el.dataset.me] ?? "";
  view("in");
  void listClasses();
};

const openLink = (name, teacher) => `/?mode=education&as=teacher&class=${encodeURIComponent(name)}&name=${encodeURIComponent(teacher)}`;

// 반 설정: one class between lessons. Every change is one request answered with the class as it
// now is; while a lesson runs the server only shows it (409 "busy") — those things are F2's then.
let current = null; // the class shown (the server's view of it)
const cls = (name) => card.querySelector(`[data-cls="${name}"]`);
const ask = (op, extra = {}) => api("/api/teacher/class", { room: current?.name ?? "", op, ...extra });
const SAY_CLASS = { busy: "지금 수업 중이라 바꿀 수 없습니다. 수업이 끝난 뒤에 다시 해 주세요.", "not-found": "이 반을 찾을 수 없습니다.", fields: "바꿀 내용이 없습니다. 입력을 확인해 주세요.", wrong: "비밀번호가 맞지 않습니다.", unavailable: "지금은 반 설정을 쓸 수 없습니다. 잠시 뒤에 다시 해 주세요." };
const classError = (r) => { const el = cls("error"); el.textContent = r ? SAY_CLASS[r.error] ?? sayError(r) : ""; el.hidden = !r; };
const paint = (c) => {
  current = c;
  const live = c.online > 0;
  cls("name").textContent = c.name;
  cls("open").href = openLink(c.name, c.teacher);
  cls("live").hidden = !live;
  cls("live").textContent = live ? `지금 수업 중입니다 · ${c.online}명 접속. 수업 중에는 F2에서 바꿉니다.` : "";
  cls("count").textContent = `${c.students.length}명`;
  cls("roster").replaceChildren(...c.students.map((s) => {
    const li = document.createElement("li"), out = document.createElement("button");
    li.textContent = s.name;
    if (s.online) li.classList.add("on");
    out.type = "button"; out.textContent = "✕"; out.setAttribute("aria-label", `${s.name} 명단에서 빼기`);
    out.addEventListener("click", () => { if (confirm(`${s.name} 학생을 명단에서 뺄까요?`)) void change("remove-student", { name: s.name }); });
    li.append(out);
    return li;
  }));
  cls("no-students").hidden = c.students.length > 0;
  for (const box of card.querySelectorAll("[data-lock]")) box.checked = c.settings[box.dataset.lock] === true;
  cls("field").textContent = `블록 ${c.field.blocks.toLocaleString("ko-KR")}개 · 가구 ${c.field.furniture}개 · 발전소 ${c.field.plants}개`;
  cls("seats").textContent = c.seats ? `자리 ${c.seats}개가 남아 있습니다` : "배치된 자리가 없습니다";
  // a running lesson is only looked at
  for (const el of card.querySelectorAll(".cls-body :is(button, input, textarea)")) el.disabled = live;
};
const change = async (op, extra) => {
  classError(null);
  const r = await ask(op, extra);
  if (r.ok && r.class) paint(r.class); else classError(r);
  return r.ok;
};
const openClass = async (name) => {
  current = { name };
  classError(null);
  const r = await ask("get");
  if (!r.ok || !r.class) { alert(SAY_CLASS[r.error] ?? sayError(r)); return; }
  for (const f of card.querySelectorAll(".acct-class form")) f.reset();
  card.querySelector(".cls-delete").open = false;
  paint(r.class);
  view("class");
  card.querySelector(".cls-body").scrollTop = 0;
};
card.querySelector('[data-do="back"]').addEventListener("click", () => { view("in"); void listClasses(); });
for (const box of card.querySelectorAll("[data-lock]")) box.addEventListener("change", () => void change("settings", { [box.dataset.lock]: box.checked }).then((ok) => { if (!ok) box.checked = !box.checked; }));
card.querySelector('[data-do="reset-field"]').addEventListener("click", () => { if (confirm(`${current.name}의 들판을 비울까요? 블록, 가구, 발전소가 모두 지워지고 되돌릴 수 없습니다.`)) void change("reset-field"); });
card.querySelector('[data-do="clear-seats"]').addEventListener("click", () => { if (confirm("배치된 자리를 지울까요?")) void change("clear-seats"); });
card.querySelector('[data-form="add"]').addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget, names = String(form.names.value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 60);
  if (names.length) void change("add-students", { names }).then((ok) => { if (ok) form.reset(); });
});
card.querySelector('[data-form="classpass"]').addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget, password = String(form.password.value);
  if (password.length < 4) return classError({ error: "fields" });
  void change("password", { password }).then((ok) => { if (ok) { form.reset(); alert("반 비밀번호를 바꿨습니다."); } });
});
card.querySelector('[data-form="classdelete"]').addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!confirm(`${current.name}을(를) 삭제할까요? 되돌릴 수 없습니다.`)) return;
  void busy(form, async () => {
    classError(null);
    const r = await ask("delete", { password: String(form.password.value) });
    if (r.ok) { form.reset(); view("in"); void listClasses(); } else classError(r);
  });
});

// 수업 관리: the account's own classes. A row opens the lobby with that class already named —
// the lesson is still picked there, every time (a class is opened as the lesson the teacher picks).
const LESSON = { craft: "자유 건축", fire: "화재 체험" };
const listClasses = async () => {
  const list = card.querySelector('[data-id="classes"]'), none = card.querySelector('[data-id="no-classes"]');
  const r = await api("/api/teacher/classes");
  const classes = r.ok && Array.isArray(r.classes) ? r.classes : [];
  list.replaceChildren(...classes.map((c) => {
    const li = document.createElement("li"), name = document.createElement("strong"), facts = document.createElement("span"), set = document.createElement("button"), go = document.createElement("a");
    name.textContent = c.name;
    facts.textContent = [`지난 수업 ${LESSON[c.theme] ?? LESSON.craft}`, `학생 ${c.students}명`, c.updatedAt ? new Date(c.updatedAt).toLocaleDateString("ko-KR") : ""].filter(Boolean).join(" · ");
    set.type = "button"; set.className = "cls-set"; set.textContent = "설정"; set.setAttribute("aria-label", `${c.name} 설정`);
    set.addEventListener("click", () => void openClass(c.name));
    go.href = openLink(c.name, c.teacher); go.className = "cls-go"; go.textContent = "수업 열기";
    li.append(name, facts, set, go);
    return li;
  }));
  none.hidden = classes.length > 0;
  card.querySelector('[data-id="class-count"]').textContent = classes.length ? String(classes.length) : "";
};

const pick = (name) => {
  for (const t of card.querySelectorAll('.acct-tabs [data-tab]')) t.setAttribute("aria-selected", String(t.dataset.tab === name));
  for (const f of ["login", "signup"]) card.querySelector(`[data-form="${f}"]`).hidden = f !== name;
  card.querySelector(`[data-form="${name}"] input`)?.focus({ preventScroll: true });
};
for (const tab of card.querySelectorAll("[data-tab]")) tab.addEventListener("click", () => pick(tab.dataset.tab));
// the eye beside a password shows what was typed (typing blind twice is where sign-ups fail)
for (const eye of card.querySelectorAll(".cy-eye")) {
  eye.addEventListener("click", () => {
    const input = eye.previousElementSibling, show = input.type === "password";
    input.type = show ? "text" : "password";
    eye.setAttribute("aria-pressed", String(show));
    eye.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 보기");
  });
}
if (new URLSearchParams(location.search).get("next") === "class") card.querySelector(".acct-next").hidden = false;
const on = (name, send) => {
  const form = card.querySelector(`[data-form="${name}"]`);
  form.addEventListener("submit", (e) => { e.preventDefault(); showError(form); void busy(form, () => send(form, fields(form))); });
};
on("login", async (form, f) => {
  const r = await api("/api/teacher/login", { email: f.email, password: f.password });
  if (r.ok) show(r.teacher, true); else showError(form, sayError(r));
});
on("signup", async (form, f) => {
  if (String(f.password).length < 8) return showError(form, "비밀번호는 8자 이상이어야 합니다.");
  if (f.password !== f.again) return showError(form, "비밀번호 확인이 다릅니다.");
  const r = await api("/api/teacher/signup", { email: f.email, name: f.name, school: f.school, password: f.password });
  if (r.ok) show(r.teacher, true); else showError(form, sayError(r));
});
on("delete", async (form, f) => {
  const r = await api("/api/teacher/delete", { password: f.password });
  if (r.ok) { form.reset(); view("out"); } else showError(form, r.error === "wrong" ? "비밀번호가 맞지 않습니다." : sayError(r));
});
card.querySelector('[data-do="logout"]').addEventListener("click", async () => { await api("/api/teacher/logout", {}); view("out"); });

const me = await api("/api/teacher/me");
if (me.status === 503 || me.status === 0) view("down"); else show(me.teacher);
