// POST /api/auth/login { email, password } — вход владельца.
// Ошибка всегда одна и та же («Неверный email или пароль»), чтобы не
// раскрывать, существует ли такой email. Rate-limit: 10 попыток / 5 минут с IP.
import { getStore } from "../_lib/store.js";
import { err, ok, clientIp } from "../_lib/http.js";
import { checkRateLimit } from "../_lib/ratelimit.js";
import { verifyPassword, createSession, clearSessionCookieHeader } from "../_lib/auth.js";
import { validEmail } from "../_lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
  const store = await getStore();
  // Лимит — по реальному IP клиента (clientIp не читает X-Forwarded-For),
  // счётчик — в базе, а не в памяти инстанса.
  if (!(await checkRateLimit(store, "login", clientIp(req), 10, 5 * 60 * 1000))) {
    return err(res, 429, "Слишком много попыток. Подождите 5 минут.");
  }
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!validEmail(email) || !password) return err(res, 401, "Неверный email или пароль.");
  try {
    const owner = await store.getOwner();
    if (!owner || owner.email.toLowerCase() !== email || !verifyPassword(password, owner.passwordHash)) {
      return err(res, 401, "Неверный email или пароль.");
    }
    await createSession(req, res);
    return ok(res, { ok: true, email: owner.email });
  } catch (e) {
    console.error("auth/login", e);
    return err(res, 500, "Не удалось войти. Попробуйте позже.");
  }
}

export function logoutHandler(req, res) {
  res.setHeader("Set-Cookie", clearSessionCookieHeader());
  return ok(res, { ok: true });
}
