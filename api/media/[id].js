// GET /api/media/:id — отдача изображения из медиатеки (аватары, логотип, hero).
// Публичный роут: аватары показываются на публичной странице.
// Файлы хранятся в БД (bytea / base64 в dev-адаптере), имена — случайные id,
// путь не раскрывает структуру хранилища.
import { getStore } from "../_lib/store.js";
import { err } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return err(res, 405, "Метод не поддерживается");
  const id = req.query?.id || req.params?.id;
  if (!id || typeof id !== "string" || id.length > 64) return err(res, 400, "Неверный id");
  try {
    const store = await getStore();
    const media = await store.getMedia(id);
    if (!media || !media.dataB64) return err(res, 404, "Файл не найден");
    const buf = Buffer.from(media.dataB64, "base64");
    res.setHeader("Content-Type", media.contentType);
    res.setHeader("Content-Length", buf.length);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(200).send(buf);
  } catch (e) {
    console.error("media", e);
    return err(res, 500, "Не удалось загрузить файл");
  }
}
