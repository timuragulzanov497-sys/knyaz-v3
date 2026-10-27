// Админ: категории мастеров (виды).
// GET  /api/admin/categories — список
// POST /api/admin/categories { id, name } — переименовать вид.
// Удалить категорию нельзя (цены привязаны к ней), третью добавить нельзя.
import { getStore } from "../../store.js";
import { err, ok } from "../../http.js";
import { requireAdmin } from "../../auth.js";
import { cleanStr } from "../../validate.js";

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      return ok(res, { categories: await store.getCategories() });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const name = cleanStr(body.name, 60);
      if (!name) return err(res, 400, "Укажите название вида");
      const renamed = await store.renameCategory(body.id, name);
      if (!renamed) return err(res, 404, "Категория не найдена");
      return ok(res, { category: renamed });
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    console.error("admin/categories", e);
    return err(res, 500, "Не удалось сохранить категорию");
  }
}
