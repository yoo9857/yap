// /cases/: the page moves a little. Everything here only ADDS: without this script (or with reduced
// motion) every block is simply there, the numbers show their final value; the video plays by its own autoplay attribute.
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
// the hero's video loops for as long as the page is open (owner: it must not stop); with reduced
// motion it stays on its first picture
const video = document.querySelector(".edu-video");
if (video && calm) { video.removeAttribute("autoplay"); video.pause(); }
else if (video) { video.play().catch(() => {}); document.addEventListener("visibilitychange", () => { if (!document.hidden) video.play().catch(() => {}); }); }
if (!calm && "IntersectionObserver" in window) {
  document.documentElement.classList.add("edu-moves");
  // blocks rise into place as they are reached, the ones in a row one after another
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const row = [...e.target.parentElement.children].filter((c) => c.hasAttribute("data-reveal"));
      e.target.style.transitionDelay = `${Math.min(row.indexOf(e.target), 4) * 80}ms`;
      e.target.classList.add("is-in");
      seen.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  for (const el of document.querySelectorAll("[data-reveal]")) seen.observe(el);
  // the lesson's numbers count up once
  const count = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      count.unobserve(e.target);
      const to = Number(e.target.dataset.count), t0 = performance.now(), ms = 900;
      if (!to) continue;
      const step = (t) => { const k = Math.min(1, (t - t0) / ms); e.target.textContent = String(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  for (const el of document.querySelectorAll("[data-count]")) count.observe(el);
}

// ---- the inquiry form: a school writes here and reads the answer here (docs/ACCOUNTS.md)
const inq = document.querySelector(".inq");
if (inq) {
  const { api, busy, fields, sayError, showError, when } = await import("/site/api.js");
  const tab = (name) => {
    inq.dataset.view = name;
    for (const t of inq.querySelectorAll('.acct-tabs [data-tab]')) t.setAttribute("aria-selected", String(t.dataset.tab === (name === "sent" ? "write" : name)));
  };
  for (const t of inq.querySelectorAll("[data-tab]")) t.addEventListener("click", () => tab(t.dataset.tab));
  const write = inq.querySelector('[data-form="inquiry"]'), look = inq.querySelector('[data-form="look"]');
  write.addEventListener("submit", (e) => {
    e.preventDefault(); showError(write);
    const f = fields(write);
    if (String(f.password).length < 4) return showError(write, "조회 비밀번호는 4자 이상이어야 합니다.");
    void busy(write, async () => {
      const r = await api("/api/inquiry", { school: f.school, name: f.name, contact: f.contact, message: f.message, password: f.password, website: f.website });
      if (!r.ok) return showError(write, r.error === "password" ? "조회 비밀번호는 4자 이상이어야 합니다." : sayError(r));
      inq.querySelector('[data-out="code"]').textContent = r.code;
      look.code.value = r.code;
      write.reset(); tab("sent");
    });
  });
  look.addEventListener("submit", (e) => {
    e.preventDefault(); showError(look);
    const f = fields(look), answer = look.querySelector(".inq-answer");
    void busy(look, async () => {
      const r = await api("/api/inquiry/view", { code: String(f.code).trim().toUpperCase(), password: f.password });
      if (!r.ok) { answer.hidden = true; return showError(look, sayError(r)); }
      const q = r.inquiry;
      answer.querySelector('[data-out="state"]').textContent = q.reply ? `답변이 등록되었습니다 · ${when(q.repliedAt)}` : `접수되었습니다 · ${when(q.createdAt)} · 아직 답변 전입니다`;
      answer.querySelector('[data-out="message"]').textContent = q.message;
      answer.querySelector('[data-out="reply"]').textContent = q.reply || "답변이 등록되면 여기에 보입니다.";
      answer.hidden = false;
    });
  });
}
