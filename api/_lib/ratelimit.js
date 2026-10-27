// Rate-limit с хранением счётчиков в базе (а не in-memory на инстанс):
// на Vercel serverless каждый инстанс имеет свою память, холодные старты
// её обнуляют — in-memory бакет не держит лимит между инстансами.
// PgStore.hitRateLimit пишет в таблицу rate_limits (см. db/schema.sql),
// FileStore.hitRateLimit — in-memory Map (файловый адаптер только для
// локальной разработки, один процесс). Если у хранилища нет hitRateLimit —
// локальный in-memory fallback здесь же, чтобы лимит работал всегда.
//
// Ключ лимита строится из clientIp(req) — реального IP клиента
// (см. http.js): ротация X-Forwarded-For бакет не сбрасывает.
import { rateLimit as memRateLimit } from "./http.js";

// checkRateLimit(store, scope, keyPart, max, windowMs) -> Promise<boolean>
// true — запрос в пределах лимита (попытка засчитана), false — лимит исчерпан.
export async function checkRateLimit(store, scope, keyPart, max, windowMs) {
  const key = `${scope}:${keyPart}`;
  if (store && typeof store.hitRateLimit === "function") {
    return store.hitRateLimit(key, max, windowMs);
  }
  return memRateLimit(key, max, windowMs);
}
