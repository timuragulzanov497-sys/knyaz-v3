// Админ: настройки сайта (сохранение по секциям).
// GET  /api/admin/settings — все настройки
// POST /api/admin/settings { section, data } — сохранить одну секцию.
// Секции: contacts (телефон/адрес/часы), links (2ГИС/Max/VK/маршрут),
// payment (оплата, Wi-Fi, собака), requisites (ИП/ИНН/ОГРН — пустые до заполнения),
// legal (тексты политики и согласия; версия согласия +1 при изменении текста),
// schedule (недельный шаблон салона по умолчанию).
import { getStore } from "../_lib/store.js";
import { err, ok } from "../_lib/http.js";
import { requireAdmin } from "../_lib/auth.js";
import { sanitizeLegalHtml } from "../_lib/sanitize.js";
import { cleanStr, optStr, isInt, normalizePhone } from "../_lib/validate.js";

function isUrl(v) {
  if (typeof v !== "string" || !v.trim()) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function validateSchedule(raw) {
  const out = {};
  for (let wd = 0; wd < 7; wd++) {
    const day = raw?.[String(wd)];
    if (!day || day.dayOff) {
      out[wd] = { dayOff: true, startMin: 600, endMin: 1260 };
      continue;
    }
    if (!isInt(day.startMin, 0, 1439) || !isInt(day.endMin, 0, 1440) || day.startMin >= day.endMin) {
      return { ok: false, error: "Неверное время работы салона" };
    }
    out[wd] = { dayOff: false, startMin: day.startMin, endMin: day.endMin };
  }
  return { ok: true, data: out };
}

export default async function handler(req, res) {
  const owner = await requireAdmin(req, res);
  if (!owner) return;
  const store = await getStore();
  try {
    if (req.method === "GET") {
      return ok(res, { settings: await store.getSettings() });
    }
    if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
    const body = req.body || {};
    const section = body.section;
    const data = body.data || {};
    const current = await store.getSettings();
    let patch = null;

    if (section === "contacts") {
      const phone = normalizePhone(data.phone);
      if (!phone) return err(res, 400, "Телефон — 11 цифр, например +7 917 181-04-84");
      const address = cleanStr(data.address, 200);
      if (!address) return err(res, 400, "Укажите адрес");
      if (!isInt(data.openStartMin, 0, 1439) || !isInt(data.openEndMin, 0, 1440) || data.openStartMin >= data.openEndMin) {
        return err(res, 400, "Время начала должно быть раньше времени окончания");
      }
      patch = {
        phone,
        phoneDisplay: data.phoneDisplay?.trim() ? String(data.phoneDisplay).trim().slice(0, 30) : phone,
        address,
        openStartMin: data.openStartMin,
        openEndMin: data.openEndMin,
      };
    } else if (section === "links") {
      for (const [k, v] of Object.entries(data)) {
        if (v && !isUrl(v)) return err(res, 400, `Неверная ссылка: ${k}`);
      }
      patch = { links: { ...(current.links || {}), ...data } };
    } else if (section === "payment") {
      const paymentText = cleanStr(data.paymentText, 120);
      if (!paymentText) return err(res, 400, "Укажите способ оплаты");
      patch = {
        paymentText,
        wifi: data.wifi === true,
        dogAllowed: data.dogAllowed === true,
      };
    } else if (section === "requisites") {
      patch = {
        requisites: {
          ip: optStr(data.ip, 200) || "",
          inn: optStr(data.inn, 20) || "",
          ogrn: optStr(data.ogrn, 20) || "",
        },
      };
    } else if (section === "legal") {
      // Юртексты — единственный HTML, который админ вводит и который потом
      // рендерится на публичной странице. Сырой HTML не храним никогда:
      // санитизация по allowlist (см. api/_lib/sanitize.js). <script>,
      // <img onerror>, <svg onload> и прочие опасные конструкции
      // выбрасываются при сохранении и не попадают в /api/public/config.
      const policyHtml =
        typeof data.policyHtml === "string" ? sanitizeLegalHtml(data.policyHtml.slice(0, 60000)) : null;
      const consentHtml =
        typeof data.consentHtml === "string" ? sanitizeLegalHtml(data.consentHtml.slice(0, 60000)) : null;
      if (policyHtml == null || consentHtml == null) return err(res, 400, "Тексты юридических страниц обязательны");
      const changed =
        policyHtml !== current.legal?.policyHtml || consentHtml !== current.legal?.consentHtml;
      patch = {
        legal: {
          policyHtml,
          consentHtml,
          consentVersion: changed ? (current.legal?.consentVersion || 1) + 1 : current.legal?.consentVersion || 1,
        },
      };
    } else if (section === "schedule") {
      const v = validateSchedule(data.defaultSchedule);
      if (!v.ok) return err(res, 400, v.error);
      patch = { defaultSchedule: v.data };
    } else {
      return err(res, 400, "Неизвестная секция настроек");
    }

    const settings = await store.updateSettings(patch);
    return ok(res, { settings });
  } catch (e) {
    console.error("admin/settings", e);
    return err(res, 500, "Не удалось сохранить настройки");
  }
}
