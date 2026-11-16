import { api, busy, fields, sayError, showError } from "/site/api.js";

const card = document.querySelector(".acct-card");
const view = (name) => { card.dataset.view = name; };
const next = new URLSearchParams(location.search).get("next");
const show = (teacher, fresh = false) => {
  if (!teacher) return view("out");
  // asked from the game (선생님 로그인, the lobby's link): signing in goes straight back to opening a class
  if (fresh && next === "class") { location.href = "/?mode=education&as=teacher"; return; }
  for (const el of card.querySelectorAll("[data-me]")) el.textContent = teacher[el.dataset.me] ?? "";
  view("in");
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
