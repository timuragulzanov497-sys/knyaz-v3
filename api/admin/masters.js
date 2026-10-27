// Админ: мастера.
// GET    /api/admin/masters — список + категории
// POST   /api/admin/masters — создать/изменить (имя, вид, специализация,
//   аватар, график: недельный шаблон + разовые изменения, «принимает записи»)
// DELETE /api/admin/masters?id=... — soft-delete (записи сохраняются)
import { getStore } from "../_lib/store.js";
import { err, ok } from "../_lib/http.js";
import { requireAdmin } from "../_lib/auth.js";
import { cleanStr, optStr, isInt, validId, isDateKey } from "../_lib/validate.js";
import { salonNow, dateKeyOf } from "../_lib/slots.js";
import { randomBytes } from "crypto";

const WEEKDAYS = ["0", "1", "2", "3", "4", "5", "6"];

function validateSchedule(raw, settings) {
  const out = {};
  for (const wd of WEEKDAYS) {
    const day = raw?.[wd];
    if (!day || day.dayOff) {
      out[wd] = { dayOff: true, startMin: 600, endMin: 1260 };
      continue;
    }
    const startMin = day.startMin;
    const endMin = day.endMin;
    if (!isInt(startMin, 0, 1439) || !isInt(endMin, 0, 1440) || startMin >= endMin) {
      return { ok: false, error: `Неверное время работы в день ${wd}` };
    }
    out[wd] = { dayOff: false, startMin, endMin };
  }
  return { ok: true, data: out };
}

function validateOverrides(raw) {
  if (!Array.isArray(raw)) return { ok: true, data: [] };
  if (raw.length > 60) return { ok: false, error: "Слишком много разовых изменений" };
  const out = [];
  for (const o of raw) {
    if (!o || !isDateKey(o.date)) return { ok: false, error: "Неверная дата разового изменения" };
    if (o.dayOff) {
      out.push({ date: o.date, dayOff: true, reason: optStr(o.reason, 120) || "" });
      continue;
    }
    if (!isInt(o.startMin, 0, 1439) || !isInt(o.endMin, 0, 1440) || o.startMin >= o.endMin) {
      return { ok: false, error: "Неверное время разового изменения" };
    }
    out.push({ date: o.date, dayOff: false, startMin: o.startMin, endMin: o.endMin, reason: optStr(o.reason, 120) || "" });
  }
  return { ok: true, data: out };
}

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      const [masters, categories, settings] = await Promise.all([
        store.getMastersAdmin(),
        store.getCategories(),
        store.getSettings(),
      ]);
      return ok(res, { masters, categories, defaultSchedule: settings.defaultSchedule || {} });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const name = cleanStr(body.name, 100);
      if (!name || name.length < 2) return err(res, 400, "Укажите имя мастера (минимум 2 символа)");
      const categories = await store.getCategories();
      if (!categories.some((c) => c.id === body.categoryId)) return err(res, 400, "Выберите вид мастера");
      const settings = await store.getSettings();
      const sched = validateSchedule(body.schedule, settings);
      if (!sched.ok) return err(res, 400, sched.error);
      const ov = validateOverrides(body.overrides);
      if (!ov.ok) return err(res, 400, ov.error);
      let avatarMediaId = body.avatarMediaId || null;
      if (avatarMediaId) {
        const media = await store.getMedia(avatarMediaId);
        if (!media) return err(res, 400, "Выбранное фото не найдено в медиатеке");
      }
      let id = typeof body.id === "string" && validId(body.id) ? body.id : null;
      if (id) {
        const ex = await store.getMaster(id);
        if (!ex) return err(res, 404, "Мастер не найден");
      } else {
        const cat = body.categoryId;
        id = `${cat}:m${randomBytes(3).toString("hex")}`;
      }
      const saved = await store.upsertMaster({
        id,
        name,
        categoryId: body.categoryId,
        specialization: optStr(body.specialization, 120) || "",
        avatarMediaId,
        active: body.active !== false,
        schedule: sched.data,
        overrides: ov.data,
      });
      return ok(res, { master: saved });
    }
    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return err(res, 400, "Не указан id мастера");
      const master = await store.getMaster(id);
      if (!master) return err(res, 404, "Мастер не найден");
      // Серверный запрет: мастера с будущими подтверждёнными записями
      // удалять нельзя. Проверка была только в UI админки — прямой
      // запрос к API её обходил и оставлял записи без мастера.
      const today = dateKeyOf(salonNow().date);
      const future = await store.listFutureBookingsForMaster(id, today, 5);
      if (future.length) {
        return res.status(409).json({
          error: "У мастера есть будущие подтверждённые записи — сначала перенесите или отмените их",
          code: "MASTER_HAS_BOOKINGS",
          bookings: future,
        });
      }
      const done = await store.deleteMaster(id);
      if (!done) return err(res, 404, "Мастер не найден");
      return ok(res, { ok: true });
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    console.error("admin/masters", e);
    return err(res, 500, "Не удалось сохранить мастера");
  }
}
