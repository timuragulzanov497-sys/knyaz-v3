// Админ: группы услуг.
// GET  /api/admin/groups — список
// POST /api/admin/groups { name } — создать группу (id генерируется из имени).
import { getStore } from "../../store.js";
import { err, ok } from "../../http.js";
import { requireAdmin } from "../../auth.js";
import { cleanStr } from "../../validate.js";
import { randomBytes } from "crypto";

function slugify(name) {
  const map = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
  const slug = name
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || "group_" + randomBytes(3).toString("hex");
}

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      return ok(res, { groups: await store.getGroups() });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const name = cleanStr(body.name, 60);
      if (!name) return err(res, 400, "Укажите название группы");
      let id = slugify(name);
      const groups = await store.getGroups();
      if (groups.some((g) => g.id === id)) id = id + "_" + randomBytes(3).toString("hex");
      const group = await store.addGroup({ id, name });
      return res.status(201).json({ group });
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error("admin/groups", e);
    return err(res, 500, "Не удалось создать группу");
  }
}
