// Единая серверная функция для всех /api/admin/* (лимит Hobby — 12 функций).
// На Vercel rewrites из vercel.json отображают /api/admin/<путь> сюда
// с ?r=<путь> (исходная query-строка, напр. ?action=cancel, сохраняется
// и сливается с ?r=...). Локально server.js тоже маршрутизирует
// /api/admin-router сюда же, чтобы прогонять тот же код, что и на Vercel.
// Хендлеры — те же модули, что раньше лежали в api/admin/; их поведение,
// валидация, статусы и ответы не менялись.
import { err } from "./_lib/http.js";
import bookings from "./_lib/handlers/admin/bookings.js";
import bookingsNum from "./_lib/handlers/admin/bookings-num.js";
import stats from "./_lib/handlers/admin/stats.js";
import services from "./_lib/handlers/admin/services.js";
import groups from "./_lib/handlers/admin/groups.js";
import categories from "./_lib/handlers/admin/categories.js";
import masters from "./_lib/handlers/admin/masters.js";
import media from "./_lib/handlers/admin/media.js";
import settings from "./_lib/handlers/admin/settings.js";

const ROUTES = {
  bookings,
  stats,
  services,
  groups,
  categories,
  masters,
  media,
  settings,
};

export default async function handler(req, res) {
  const raw = req.query?.r;
  const r = String(Array.isArray(raw) ? raw[0] : raw || "").replace(/^\/+|\/+$/g, "");
  // Свой query без служебного r — хендлеры получают те же параметры,
  // что и раньше (num, id, action, date, master, status, q, limit, offset...).
  const q = { ...(req.query || {}) };
  delete q.r;
  // НЕ делать { ...req, query: q }: спред копирует только собственные
  // перечислимые свойства, а у req на Vercel заголовки, сокет и методы
  // потока (req.on для multipart) живут не в них — хендлер получал
  // объект без headers и без req.on, поэтому сессии не находились (401),
  // а загрузка медиа падала бы. Передаём исходный req, меняя только query.
  const m = r.match(/^bookings\/(\d+)$/);
  if (m) {
    q.num = m[1];
    req.query = q;
    return bookingsNum(req, res);
  }
  const h = ROUTES[r];
  if (!h) return err(res, 404, "Не найдено");
  req.query = q;
  return h(req, res);
}
