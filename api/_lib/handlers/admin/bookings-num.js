// Админ: действия с записью.
// POST /api/admin/bookings/:num/cancel { reason? } — отменить (слот освобождается)
// POST /api/admin/bookings/:num/reschedule { dateKey, start } — перенести
//   (услуги и мастер сохраняются; слот проверяется сервером, дубль — 409).
import { getStore } from "../../store.js";
import { err, ok } from "../../http.js";
import { requireAdmin } from "../../auth.js";
import { optStr, isDateKey } from "../../validate.js";
import { parseDateKey, salonNow, dateKeyOf, HORIZON_DAYS } from "../../slots.js";

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const num = parseInt(req.query?.num, 10);
  if (!Number.isInteger(num)) return err(res, 400, "Неверный номер записи");
  const action = req.query?.action;
  const store = await getStore();
  try {
    if (req.method === "POST" && action === "cancel") {
      const body = req.body || {};
      // Причина обязательна на сервере: раньше пустая причина проходила
      // (проверка была только в UI), и записи отменялись без объяснения.
      const reason = optStr(body.reason, 200);
      if (!reason) return err(res, 400, "Укажите причину отмены записи");
      const booking = await store.getBooking(num);
      if (!booking) return err(res, 404, "Запись не найдена");
      const cancelled = await store.cancelBooking(num, reason);
      return ok(res, { booking: cancelled });
    }
    if (req.method === "POST" && action === "reschedule") {
      const body = req.body || {};
      if (!isDateKey(body.dateKey)) return err(res, 400, "Неверная дата");
      const start = body.start;
      if (!Number.isInteger(start) || start < 0 || start >= 1440 || start % 30 !== 0) {
        return err(res, 400, "Неверное время");
      }
      const booking = await store.getBooking(num);
      if (!booking) return err(res, 404, "Запись не найдена");
      if (booking.status !== "CONFIRMED") return err(res, 409, "Эту запись уже нельзя перенести");
      const now = salonNow();
      const date = parseDateKey(body.dateKey);
      const maxDate = new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() + HORIZON_DAYS - 1);
      if (date < now.date || date > maxDate) return err(res, 400, "Дата вне окна записи (14 дней)");
      if (body.dateKey === dateKeyOf(now.date) && start < now.minutes + 30) {
        return err(res, 400, "Это время уже прошло");
      }
      const updated = await store.updateBooking(num, { dateKey: body.dateKey, start });
      return ok(res, { booking: updated });
    }
    if (req.method === "GET") {
      const booking = await store.getBooking(num);
      if (!booking) return err(res, 404, "Запись не найдена");
      return ok(res, { booking });
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    if (e.status === 409) return err(res, 409, e.message, e.code || "SLOT_TAKEN");
    console.error("admin/bookings/[num]", e);
    return err(res, 500, "Не удалось изменить запись");
  }
}
