// POST /api/auth/logout — выход (удаление сессии).
// GET  /api/auth/me — проверка сессии для админки.
import { getStore } from "../_lib/store.js";
import { err, ok } from "../_lib/http.js";
import { getSessionOwner, clearSessionCookieHeader, SESSION_COOKIE } from "../_lib/auth.js";
import { createHash } from "crypto";

export async function logout(req, res) {
  if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
  try {
    const cookies = req.headers?.cookie || "";
    const m = cookies.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
    if (m) {
      const store = await getStore();
      await store.deleteSession(createHash("sha256").update(decodeURIComponent(m[1])).digest("hex"));
    }
  } catch {
    // выход не должен падать из-за ошибки БД
  }
  res.setHeader("Set-Cookie", clearSessionCookieHeader());
  return ok(res, { ok: true });
}

export async function me(req, res) {
  if (req.method !== "GET") return err(res, 405, "Метод не поддерживается");
  const owner = await getSessionOwner(req);
  if (!owner) return err(res, 401, "Требуется вход в панель владельца");
  return ok(res, { ok: true, email: owner.email });
}
