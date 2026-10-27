// GET /api/public/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&master=any|cat:barber|<id>&duration=60
// Возвращает свободные старты слотов (шаг 30 мин) по дням.
// Занятость — только реальные записи из БД + график мастеров.
// Псевдослучайная занятость V3 удалена: свободных слотов стало больше,
// это корректно (см. README).
import { getStore } from "../_lib/store.js";
import { err, ok } from "../_lib/http.js";
import { freeStartsForDay, parseDateKey, dateKeyOf, HORIZON_DAYS } from "../_lib/slots.js";
import { isDateKey } from "../_lib/validate.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return err(res, 405, "Метод не поддерживается");
  const { from, to, master = "any", duration = "60", excludeNum } = req.query || {};
  const dur = parseInt(duration, 10);
  if (!Number.isInteger(dur) || dur < 5 || dur > 480) return err(res, 400, "Неверная длительность");
  if (!isDateKey(from) || !isDateKey(to)) return err(res, 400, "Неверный диапазон дат");
  const fromD = parseDateKey(from);
  const toD = parseDateKey(to);
  if (!fromD || !toD || toD < fromD || (toD - fromD) / 86400000 > HORIZON_DAYS) {
    return err(res, 400, "Диапазон дат — не более 14 дней");
  }
  try {
    const store = await getStore();
    const [masters, settings, bookings] = await Promise.all([
      store.getMastersAdmin(),
      store.getSettings(),
      store.listBookingsRange(from, to),
    ]);
    const exclude = excludeNum ? parseInt(excludeNum, 10) : null;
    const days = {};
    for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate() + 1)) {
      const key = dateKeyOf(d);
      days[key] = freeStartsForDay(key, master, dur, masters, bookings, settings, exclude);
    }
    return ok(res, { from, to, master, duration: dur, days });
  } catch (e) {
    console.error("public/slots", e);
    return err(res, 500, "Не удалось загрузить свободное время");
  }
}
