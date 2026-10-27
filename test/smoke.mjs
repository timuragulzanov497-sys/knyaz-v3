// Smoke-тест бэкенда «Князь» V3 — сквозной прогон вживую через HTTP.
// Запуск: сначала `npm run dev` (или `node server.js`), потом в другом окне:
//   BASE_URL=http://localhost:3000 SETUP_TOKEN=<токен из .env> node test/smoke.mjs
// Нужна СВЕЖАЯ база (пустой Postgres / удалённый data/dev.json): тест создаёт
// владельца, запись K-1001 и меняет цену туда-обратно. Не запускать на проде.
// Учётка smoke-теста — только для локальной проверки, не для владельца.
import { randomBytes } from "crypto";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const SETUP_TOKEN = process.env.SETUP_TOKEN || "";
const EMAIL = process.env.SMOKE_EMAIL || "owner@knyaz.local";
const PASSWORD = process.env.SMOKE_PASSWORD || "SmokeTest-Password-123";

let cookie = "";
let passed = 0;
let failed = 0;

function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data, headers: res.headers };
}

// Сегодня в часовом поясе салона (Europe/Samara, UTC+4).
function salonToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Samara", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts; // YYYY-MM-DD
}
function addDays(key, n) {
  const d = new Date(key + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function main() {
  console.log(`Smoke: ${BASE}`);
  const today = salonToday();
  const tomorrow = addDays(today, 1);

  // 1. Первая настройка
  console.log("1. setup");
  const s0 = await call("/api/setup");
  check("GET /api/setup отвечает", s0.status === 200 && typeof s0.data.setupNeeded === "boolean");
  if (s0.data.setupNeeded) {
    if (!SETUP_TOKEN) { console.log("  FAIL нет SETUP_TOKEN в env — первая настройка невозможна"); process.exit(1); }
    const s1 = await call("/api/setup", { method: "POST", body: { token: SETUP_TOKEN, email: EMAIL, password: PASSWORD, passwordRepeat: PASSWORD } });
    check("POST /api/setup создаёт владельца (201)", s1.status === 201, JSON.stringify(s1.data));
    check("после setup — сессия выдана", cookie.includes("knyaz_admin="));
    const s2 = await call("/api/setup");
    check("повторный GET /api/setup: setupNeeded=false", s2.data.setupNeeded === false);
    const s3 = await call("/api/setup", { method: "POST", body: { token: SETUP_TOKEN, email: "x@y.zz", password: PASSWORD, passwordRepeat: PASSWORD } });
    check("повторный POST /api/setup: 403", s3.status === 403);
  } else {
    console.log("  -- setup уже выполнен, входим по SMOKE_EMAIL/SMOKE_PASSWORD");
    const l = await call("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
    check("POST /api/auth/login (200)", l.status === 200, JSON.stringify(l.data));
  }

  // 2. Сессия
  console.log("2. auth");
  const me = await call("/api/auth/me");
  check("GET /api/auth/me с cookie (200)", me.status === 200 && me.data.email === EMAIL.toLowerCase());
  const savedCookie = cookie; cookie = "";
  const meNo = await call("/api/auth/me");
  check("GET /api/auth/me без cookie (401)", meNo.status === 401);
  cookie = savedCookie;
  const badLogin = await call("/api/auth/login", { method: "POST", body: { email: EMAIL, password: "wrong-password-123" } });
  check("неверный пароль (401)", badLogin.status === 401);

  // 3. Публичный каталог
  console.log("3. catalog");
  const cfg = await call("/api/public/config");
  check("GET /api/public/config (200)", cfg.status === 200);
  check("2 категории", cfg.data.categories?.length === 2);
  check("18 услуг", cfg.data.services?.length === 18, `got ${cfg.data.services?.length}`);
  check("4 мастера", cfg.data.masters?.length === 4);
  const haircut = cfg.data.services?.find((s) => s.id === "haircut");
  check("стрижка мужская 700/1000", haircut?.prices?.barber === 700 && haircut?.prices?.top === 1000, JSON.stringify(haircut?.prices));
  check("нет секретов в config", !JSON.stringify(cfg.data).includes("password") && !JSON.stringify(cfg.data).includes("SETUP"));

  // 4. Слоты
  console.log("4. slots");
  const slots = await call(`/api/public/slots?from=${today}&to=${tomorrow}&master=any&duration=60`);
  check("GET /api/public/slots (200)", slots.status === 200);
  const daySlots = slots.data.days?.[today] || [];
  check("сегодня есть свободные слоты", daySlots.length > 0, `got ${daySlots.length}`);
  const slotDate = daySlots.length ? today : tomorrow;
  const slotStart = daySlots.length ? daySlots[0] : (slots.data.days?.[tomorrow] || [])[0];
  if (slotStart == null) { console.log("  FAIL нет слотов ни сегодня, ни завтра"); process.exit(1); }

  // 5. Создание записи + идемпотентность + двойная запись + согласие
  console.log("5. bookings");
  const idemKey = randomBytes(16).toString("hex");
  // Конкретный мастер (barber:b1): дубль на то же время к ТОМУ ЖЕ мастеру
  // обязан дать 409. С выбором «any» второй клиент получил бы другого
  // свободного мастера — это не дубль, а корректное назначение.
  const payload = {
    masterSelection: "barber:b1", serviceIds: ["haircut"], dateKey: slotDate, start: slotStart,
    name: "Тест Тестов", phone: "+79000000001", comment: "smoke", consent: true, idempotencyKey: idemKey,
  };
  const b1 = await call("/api/public/bookings", { method: "POST", body: payload });
  check("создание записи (201)", b1.status === 201, JSON.stringify(b1.data));
  const num = b1.data.booking?.num;
  check("номер K-1001", num === 1001, `got ${num}`);
  check("цена записи 700 (категория «Цирюльник»)", b1.data.booking?.price === 700, `got ${b1.data.booking?.price}`);
  const b1r = await call("/api/public/bookings", { method: "POST", body: payload });
  check("повтор с тем же idempotency-ключом — та же запись", (b1r.status === 200 || b1r.status === 201) && b1r.data.booking?.num === num, `status ${b1r.status}`);
  const bDup = await call("/api/public/bookings", { method: "POST", body: { ...payload, phone: "+79000000002", idempotencyKey: randomBytes(16).toString("hex") } });
  check("двойная запись на то же время — 409 SLOT_TAKEN", bDup.status === 409 && bDup.data.code === "SLOT_TAKEN", `status ${bDup.status} ${JSON.stringify(bDup.data)}`);
  const bNoConsent = await call("/api/public/bookings", { method: "POST", body: { ...payload, phone: "+79000000003", consent: false, idempotencyKey: randomBytes(16).toString("hex") } });
  check("без галочки согласия — 400", bNoConsent.status === 400);
  const bBadPhone = await call("/api/public/bookings", { method: "POST", body: { ...payload, phone: "123", idempotencyKey: randomBytes(16).toString("hex") } });
  check("неверный телефон — 400", bBadPhone.status === 400);
  // Гонка: два параллельных запроса на один свободный слот — ровно один 201, второй 409.
  const raceSlots = await call(`/api/public/slots?from=${slotDate}&to=${slotDate}&master=barber:b1&duration=60`);
  const raceStart = (raceSlots.data.days?.[slotDate] || []).find((t) => t !== slotStart);
  if (raceStart != null) {
    const [r1, r2] = await Promise.all([
      call("/api/public/bookings", { method: "POST", body: { ...payload, phone: "+79000000011", idempotencyKey: randomBytes(16).toString("hex"), start: raceStart } }),
      call("/api/public/bookings", { method: "POST", body: { ...payload, phone: "+79000000012", idempotencyKey: randomBytes(16).toString("hex"), start: raceStart } }),
    ]);
    const statuses = [r1.status, r2.status].sort().join(",");
    check("гонка: один 201 + один 409", statuses === "201,409", `got ${statuses}`);
    const winner = r1.status === 201 ? r1.data.booking : r2.data.booking;
    if (winner) await call(`/api/admin/bookings/${winner.num}?action=cancel`, { method: "POST", body: { reason: "smoke: отмена записи из гонки" } });
  } else {
    console.log("  -- нет второго свободного слота для проверки гонки, пропущено");
  }

  // 6. Админка: список записей (и 401 без сессии)
  console.log("6. admin bookings");
  const ab = await call(`/api/admin/bookings?date=${slotDate}`);
  check("GET /api/admin/bookings видит запись", ab.status === 200 && ab.data.bookings?.some((b) => b.num === num));
  const savedCookie2 = cookie; cookie = "";
  const abNo = await call("/api/admin/bookings");
  check("без сессии /api/admin/bookings — 401", abNo.status === 401);
  cookie = savedCookie2;

  // 7. Смена цены в админке -> публичная страница
  console.log("7. price change");
  const cfgBefore = await call("/api/public/config");
  const hcBefore = cfgBefore.data.services.find((s) => s.id === "haircut");
  const svc = await call("/api/admin/services", { method: "POST", body: { id: "haircut", name: hcBefore.name, groupId: hcBefore.groupId, durationMin: 60, includes: [], prices: { barber: 750, top: 1000 }, active: true } });
  check("POST /api/admin/services меняет цену", svc.status === 200 && svc.data.service?.prices?.barber === 750, JSON.stringify(svc.data));
  const cfgAfter = await call("/api/public/config");
  check("новая цена видна на публичной странице", cfgAfter.data.services.find((s) => s.id === "haircut")?.prices?.barber === 750);
  await call("/api/admin/services", { method: "POST", body: { id: "haircut", name: hcBefore.name, groupId: hcBefore.groupId, durationMin: 60, includes: [], prices: { barber: 700, top: 1000 }, active: true } });
  const cfgBack = await call("/api/public/config");
  check("цена возвращена обратно (700)", cfgBack.data.services.find((s) => s.id === "haircut")?.prices?.barber === 700);

  // 8. Медиатека и аватар
  console.log("8. media + avatar");
  const form = new FormData();
  form.append("file", new Blob([PNG_1PX], { type: "image/png" }), "avatar.png");
  form.append("kind", "avatar");
  const upRes = await fetch(BASE + "/api/admin/media", { method: "POST", headers: { ...(cookie ? { Cookie: cookie } : {}) }, body: form });
  const up = { status: upRes.status, data: await upRes.json().catch(() => ({})) };
  check("загрузка PNG (200/201)", (up.status === 200 || up.status === 201) && !!up.data.media?.id, JSON.stringify(up.data));
  const mediaId = up.data.media?.id;
  if (mediaId) {
    const img = await fetch(BASE + `/api/media/${mediaId}`);
    check("GET /api/media/:id отдаёт картинку", img.status === 200 && (img.headers.get("content-type") || "").startsWith("image/"));
    const masters = await call("/api/admin/masters");
    const m1 = masters.data.masters?.find((m) => m.id === "barber:b1");
    const setAv = await call("/api/admin/masters", { method: "POST", body: { id: "barber:b1", name: m1.name, categoryId: "barber", specialization: "", avatarMediaId: mediaId, schedule: m1.schedule, overrides: m1.overrides || [], active: true } });
    check("аватар назначен мастеру", setAv.status === 200 && setAv.data.master?.avatarMediaId === mediaId, JSON.stringify(setAv.data));
    const cfgAv = await call("/api/public/config");
    check("аватар виден на публичной странице", cfgAv.data.masters.find((m) => m.id === "barber:b1")?.avatarUrl === `/api/media/${mediaId}`);
    const del = await call(`/api/admin/media?id=${mediaId}`, { method: "DELETE" });
    check("удаление фото из медиатеки", del.status === 200);
    const cfgAv2 = await call("/api/public/config");
    check("после удаления у мастера снова нет аватара", cfgAv2.data.masters.find((m) => m.id === "barber:b1")?.avatarUrl === null);
    // 9. Отмена записи освобождает слот (контракт хендлера: ?action=cancel)
    console.log("9. cancel");
    const cancel = await call(`/api/admin/bookings/${num}?action=cancel`, { method: "POST", body: { reason: "smoke-тест" } });
    check("отмена записи админом", cancel.status === 200 && cancel.data.booking?.status === "CANCELLED", JSON.stringify(cancel.data));
    const slots2 = await call(`/api/public/slots?from=${slotDate}&to=${slotDate}&master=barber:b1&duration=60`);
    check("слот освободился после отмены", (slots2.data.days?.[slotDate] || []).includes(slotStart));
  }

  // 10. Выход
  console.log("10. logout");
  const lo = await call("/api/auth/logout", { method: "POST" });
  check("POST /api/auth/logout (200)", lo.status === 200);
  const meAfter = await call("/api/auth/me");
  check("после выхода /api/auth/me — 401", meAfter.status === 401);

  console.log(`\nИтого: пройдено ${passed}, провалено ${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("SMOKE CRASH", e); process.exit(1); });
