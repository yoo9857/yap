// Shared by /teacher/, /admin/ and the inquiry form on /cases/: one way to call the site's API and
// one place where its short error codes become sentences.
export const SAY = {
  wrong: "이메일 또는 비밀번호가 맞지 않습니다.",
  taken: "이미 가입된 이메일입니다. 로그인해 주세요.",
  password: "비밀번호가 너무 짧습니다.",
  email: "이메일 주소를 다시 확인해 주세요.",
  fields: "입력한 내용을 다시 확인해 주세요.",
  "slow-down": "시도가 너무 많습니다. 잠시 뒤에 다시 해 주세요.",
  disabled: "사용이 중지된 계정입니다. 문의해 주세요.",
  closed: "관리자 로그인이 닫혀 있습니다.",
  "not-found": "찾을 수 없습니다. 번호와 비밀번호를 확인해 주세요.",
  "signed-out": "로그인이 풀렸습니다. 다시 로그인해 주세요.",
  admin: "관리자 로그인이 필요합니다.",
  unavailable: "지금은 서비스를 쓸 수 없습니다. 잠시 뒤에 다시 시도해 주세요.",
  body: "보낸 내용이 너무 깁니다.",
};
export async function api(path, body) {
  try {
    const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...json };
  } catch {
    return { ok: false, status: 0, error: "unavailable" };
  }
}
export const sayError = (r) => SAY[r.error] ?? "문제가 생겼습니다. 잠시 뒤에 다시 시도해 주세요.";
/** A form's fields as an object; shows `message` under the form (or hides it). */
export const fields = (form) => Object.fromEntries(new FormData(form));
export function showError(form, message) {
  const el = form.querySelector(".cy-error");
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}
/** Runs `send` while the form's button is disabled, so a double click is one request. */
export async function busy(form, send) {
  const button = form.querySelector('[type="submit"]');
  if (button) button.disabled = true;
  try { return await send(); } finally { if (button) button.disabled = false; }
}
export const when = (ms) => (ms ? new Date(ms).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
