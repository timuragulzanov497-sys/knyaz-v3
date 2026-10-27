// Первая настройка владельца.
// GET  /api/setup -> { setupNeeded: true|false }
// POST /api/setup { token, email, password } — создаёт единственного владельца
//   и сразу входит (ставит сессию). Работает ТОЛЬКО пока владельца нет:
//   после создания эндпоинт мёртв (403). Токен — из env SETUP_TOKEN,
//   сравнение в постоянное время. Пароль — минимум 12 символов, хеш scrypt.
import { getStore } from "./_lib/store.js";
import { err, ok, clientIp } from "./_lib/http.js";
import { checkRateLimit } from "./_lib/ratelimit.js";
import { hashPassword, createSession, setupTokenMatches } from "./_lib/auth.js";
import { validEmail, validPassword } from "./_lib/validate.js";

export default async function handler(req, res) {
  const store = await getStore();
  if (req.method === "GET") {
    const owner = await store.getOwner();
    return ok(res, { setupNeeded: !owner });
  }
  if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
  if (!(await checkRateLimit(store, "setup", clientIp(req), 5, 60 * 1000))) {
    return err(res, 429, "Слишком много попыток. Подождите минуту.");
  }
  const owner = await store.getOwner();
  if (owner) return err(res, 403, "Настройка уже выполнена. Войдите в панель.");
  const body = req.body || {};
  const token = String(body.token || "");
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const password2 = String(body.passwordRepeat || body.password2 || "");
  if (!setupTokenMatches(token)) {
    return err(res, 403, "Неверный токен. Проверьте, что вы вставили его полностью.");
  }
  if (!validEmail(email)) return err(res, 400, "Укажите корректный email");
  if (!validPassword(password)) return err(res, 400, "Пароль — минимум 12 символов");
  if (password !== password2) return err(res, 400, "Пароли не совпадают");
  try {
    await store.createOwner({ email, passwordHash: hashPassword(password) });
    await createSession(req, res);
    return res.status(201).json({ ok: true, email });
  } catch (e) {
    // Гонка двух одновременных setup: второй получает конфликт
    // уникальности владельца (23505) — это тоже «уже выполнено», 403.
    if (e.status === 403 || e.code === "23505") return err(res, 403, "Настройка уже выполнена. Войдите в панель.");
    console.error("setup", e);
    return err(res, 500, "Не удалось создать владельца");
  }
}
