// Админ: записи клиентов.
// GET /api/admin/bookings?date=today|tomorrow|all|<YYYY-MM-DD>&master=&status=&q=&limit=&offset=
// GET /api/admin/stats — сводка: сегодня / завтра / за 14 дней.
import { getStore } from "../../store.js";
import { err, ok } from "../../http.js";
import { requireAdmin } from "../../auth.js";
import { isDateKey } from "../../validate.js";
import { dateKeyOf, salonNow } from "../../slots.js";

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method !== "GET") return err(res, 405, "Метод не поддерживается");
    const now = salonNow();
    const today = dateKeyOf(now.date);
    const tomorrow = dateKeyOf(new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() + 1));
    const q = req.query || {};
    let from;
    let to;
    if (q.date === "today") {
      from = to = today;
    } else if (q.date === "tomorrow") {
      from = to = tomorrow;
    } else if (q.date === "all" || !q.date) {
      from = undefined;
      to = undefined;
    } else if (isDateKey(q.date)) {
      from = to = q.date;
    } else {
      return err(res, 400, "Неверный фильтр даты");
    }
    const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 100);
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
    const status = q.status === "CONFIRMED" || q.status === "CANCELLED" ? q.status : undefined;
    const result = await store.listBookings({
      from,
      to,
      masterId: q.master || undefined,
      status,
      q: q.q || undefined,
      limit,
      offset,
    });
    const masters = await store.getMastersAdmin();
    return ok(res, {
      bookings: result.items,
      total: result.total,
      masters: masters.map((m) => ({ id: m.id, name: m.name, categoryId: m.categoryId })),
      today,
      tomorrow,
    });
  } catch (e) {
    console.error("admin/bookings", e);
    return err(res, 500, "Не удалось загрузить записи");
  }
}

export async function statsHandler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  try {
    const store = await getStore();
    return ok(res, await store.bookingStats());
  } catch (e) {
    console.error("admin/stats", e);
    return err(res, 500, "Не удалось загрузить сводку");
  }
}
