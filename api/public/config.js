// GET /api/public/config — всё, что нужно публичной странице:
// категории, группы, услуги с ценами, мастера, настройки, юртексты.
// Никаких секретов и никаких внутренних данных (пароли, сессии).
import { getStore } from "../_lib/store.js";
import { err, ok } from "../_lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return err(res, 405, "Метод не поддерживается");
  try {
    const store = await getStore();
    const [categories, groups, services, masters, settings] = await Promise.all([
      store.getCategories(),
      store.getGroups(),
      store.getServicesAdmin(),
      store.getMastersAdmin(),
      store.getSettings(),
    ]);
    const publicMasters = masters
      .filter((m) => m.active)
      .map((m) => ({
        id: m.id,
        name: m.name,
        categoryId: m.categoryId,
        specialization: m.specialization || "",
        avatarUrl: m.avatarMediaId ? `/api/media/${m.avatarMediaId}` : null,
        initials: initialsOf(m.name),
      }));
    const publicServices = services
      .filter((s) => s.active)
      .map((s) => ({
        id: s.id,
        name: s.name,
        groupId: s.groupId,
        durationMin: s.durationMin,
        includes: s.includes || [],
        prices: s.prices || {},
      }));
    return ok(res, {
      categories,
      groups,
      services: publicServices,
      masters: publicMasters,
      settings: {
        phone: settings.phone,
        phoneDisplay: settings.phoneDisplay,
        address: settings.address,
        openStartMin: settings.openStartMin,
        openEndMin: settings.openEndMin,
        paymentText: settings.paymentText,
        wifi: !!settings.wifi,
        dogAllowed: !!settings.dogAllowed,
        links: settings.links || {},
        requisites: settings.requisites || { ip: "", inn: "", ogrn: "" },
        legal: settings.legal || {},
        logoUrl: settings.logoMediaId ? `/api/media/${settings.logoMediaId}` : null,
        heroUrl: settings.heroMediaId ? `/api/media/${settings.heroMediaId}` : null,
      },
    });
  } catch (e) {
    console.error("public/config", e);
    return err(res, 500, "Не удалось загрузить данные сайта");
  }
}

function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/);
  const first = parts[0]?.[0] || "";
  const second = parts[1]?.[0] || "";
  return (first + second).toUpperCase() || "К";
}
