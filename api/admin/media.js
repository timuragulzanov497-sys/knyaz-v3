// Админ: медиатека.
// GET    /api/admin/media — список файлов
// POST   /api/admin/media — загрузка (multipart, поля: file, kind)
//        Только JPG/PNG/WebP по magic bytes, до 3 МБ. Имя файла — случайное.
// DELETE /api/admin/media?id=... — удалить (привязки у мастеров/логотипа снимаются)
// POST   /api/admin/media { action: 'setRole', mediaId, role: 'logo'|'hero' } —
//        назначить логотип / фото главной.
import { randomBytes } from "crypto";
import { getStore } from "../_lib/store.js";
import { err, ok, parseMultipart, detectImageType, rateLimit, clientIp } from "../_lib/http.js";
import { requireAdmin } from "../_lib/auth.js";

const MAX_BYTES = 3 * 1024 * 1024;
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      const media = await store.getMediaList();
      const settings = await store.getSettings();
      return ok(res, {
        media: media.map((m) => ({
          ...m,
          url: `/api/media/${m.id}`,
          isLogo: settings.logoMediaId === m.id,
          isHero: settings.heroMediaId === m.id,
        })),
        logoMediaId: settings.logoMediaId || null,
        heroMediaId: settings.heroMediaId || null,
      });
    }
    if (req.method === "DELETE") {
      const id = req.query?.id;
      if (!id) return err(res, 400, "Не указан id файла");
      const done = await store.deleteMedia(id);
      if (!done) return err(res, 404, "Файл не найден");
      return ok(res, { ok: true });
    }
    if (req.method === "POST") {
      const ct = req.headers?.["content-type"] || "";
      if (ct.includes("multipart/form-data")) {
        if (!rateLimit(`upload:${clientIp(req)}`, 20, 60 * 1000)) {
          return err(res, 429, "Слишком много загрузок. Подождите минуту.");
        }
        const { files } = await parseMultipart(req);
        const file = files[0];
        if (!file) return err(res, 400, "Файл не передан");
        if (file.data.length > MAX_BYTES) return err(res, 413, "Файл больше 3 МБ");
        const type = detectImageType(file.data);
        if (!type) return err(res, 400, "Неподдерживаемый формат. Только JPG, PNG, WebP.");
        const id = "m_" + randomBytes(12).toString("hex");
        const saved = await store.addMedia({
          id,
          name: String(file.filename || "image").slice(0, 120),
          contentType: MIME[type],
          sizeBytes: file.data.length,
          kind: "image",
          dataB64: file.data.toString("base64"),
          createdAt: new Date().toISOString(),
        });
        return res.status(201).json({ media: { ...saved, url: `/api/media/${id}` } });
      }
      // JSON-действия: назначить логотип/hero.
      const body = req.body || {};
      if (body.action === "setRole") {
        const role = body.role;
        if (role !== "logo" && role !== "hero") return err(res, 400, "Неверная роль файла");
        const media = await store.getMedia(body.mediaId);
        if (!media) return err(res, 404, "Файл не найден");
        const patch = role === "logo" ? { logoMediaId: body.mediaId } : { heroMediaId: body.mediaId };
        await store.updateSettings(patch);
        return ok(res, { ok: true });
      }
      if (body.action === "clearRole") {
        const role = body.role;
        if (role !== "logo" && role !== "hero") return err(res, 400, "Неверная роль файла");
        const patch = role === "logo" ? { logoMediaId: null } : { heroMediaId: null };
        await store.updateSettings(patch);
        return ok(res, { ok: true });
      }
      return err(res, 400, "Неизвестное действие");
    }
    return err(res, 405, "Метод не поддерживается");
  } catch (e) {
    if (e.status) return err(res, e.status, e.message);
    console.error("admin/media", e);
    return err(res, 500, "Не удалось обработать файл");
  }
}
