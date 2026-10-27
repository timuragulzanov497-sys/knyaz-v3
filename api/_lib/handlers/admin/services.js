// Админ: услуги и прайс.
// GET    /api/admin/services — список (включая скрытые с сайта, без удалённых)
// POST   /api/admin/services — создать/изменить услугу
// DELETE /api/admin/services?id=... — soft-delete (скрыть с сайта, записи сохранить)
import { getStore } from "../../store.js";
import { err, ok } from "../../http.js";
import { requireAdmin } from "../../auth.js";
import { cleanStr, optStr, isInt, validPrice, validId } from "../../validate.js";
import { randomBytes } from "crypto";

function validateService(body) {
  const name = cleanStr(body.name, 120);
  if (!name) return { ok: false, error: "Укажите название услуги" };
  const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
  if (!groupId) return { ok: false, error: "Выберите группу" };
  const durationMin = body.durationMin;
  if (!isInt(durationMin, 5, 240)) return { ok: false, error: "Длительность — от 5 до 240 минут" };
  const prices = body.prices || {};
  for (const [cat, price] of Object.entries(prices)) {
    if (!validPrice(price)) return { ok: false, error: `Неверная цена для категории «${cat}»` };
  }
  const includes = Array.isArray(body.includes) ? body.includes.filter((x) => typeof x === "string").slice(0, 10) : [];
  return {
    ok: true,
    data: {
      name,
      groupId,
      durationMin,
      includes,
      prices: { barber: prices.barber ?? null, top: prices.top ?? null },
      active: body.active !== false,
    },
  };
}

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      const [services, groups, categories] = await Promise.all([
        store.getServicesAdmin(),
        store.getGroups(),
        store.getCategories(),
      ]);
      return ok(res, { services, groups, categories });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const v = validateService(body);
      if (!v.ok) return err(res, 400, v.error);
      const groups = await store.getGroups();
      if (!groups.some((g) => g.id === v.data.groupId)) {
        return err(res, 400, "Такой группы нет");
      }
      const services = await store.getServicesAdmin();
      for (const inc of v.data.includes) {
        if (!services.some((s) => s.id === inc)) return err(res, 400, "Неверный состав комплекса");
      }
      let id = typeof body.id === "string" && validId(body.id) ? body.id : null;
      if (id) {
        const ex = await store.getService(id);
        if (!ex) return err(res, 404, "Услуга не найдена");
      } else {
        id = "svc_" + randomBytes(6).toString("hex");
      }
      const saved = await store.upsertService({ id, ...v.data });
      return ok(res, { service: saved });
    }
    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return err(res, 400, "Не указан id услуги");
      const done = await store.deleteService(id);
      if (!done) return err(res, 404, "Услуга не найдена");
      return ok(res, { ok: true });
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    console.error("admin/services", e);
    return err(res, 500, "Не удалось сохранить услугу");
  }
}
