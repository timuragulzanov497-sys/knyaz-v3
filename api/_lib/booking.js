// Создание записи: разрешение услуг/цен/мастера + проверки.
// Финальная защита от дублей — внутри store.insertBooking (мьютекс /
// advisory lock + EXCLUDE-констрейнт в Postgres). Здесь — только
// разрешение данных и дружелюбные ошибки 400/409.
import { createHash } from "crypto";
import { getStore } from "./store.js";
import { assignMaster, salonNow, dateKeyOf, parseDateKey, HORIZON_DAYS } from "./slots.js";
import { normalizePhone, isDateKey } from "./validate.js";

export class BookingInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function computePayloadHash({ selection, serviceIds, dateKey, start, phone, name }) {
  return createHash("sha256")
    .update(JSON.stringify({ selection, serviceIds, dateKey, start, phone, name }))
    .digest("hex");
}

function priceFor(service, categoryId) {
  if (categoryId) {
    const p = service.prices?.[categoryId];
    return p == null ? null : p;
  }
  const vals = Object.values(service.prices || {}).filter((v) => v != null);
  return vals.length ? Math.min(...vals) : null;
}

// Разрешить выбор клиента в снапшот записи (цены и длительности — на момент записи).
export async function resolveBookingInput(input) {
  const store = await getStore();
  const services = await store.getServicesAdmin();
  const masters = await store.getMastersAdmin();
  const settings = await store.getSettings();
  const svcById = new Map(services.map((s) => [s.id, s]));

  const serviceIds = Array.isArray(input.serviceIds) ? [...new Set(input.serviceIds)] : [];
  if (!serviceIds.length) throw new BookingInputError("Выберите хотя бы одну услугу");
  if (serviceIds.length > 20) throw new BookingInputError("Слишком много услуг в одной записи");
  const chosen = [];
  for (const id of serviceIds) {
    const s = svcById.get(id);
    if (!s || !s.active) throw new BookingInputError("Выбранная услуга недоступна");
    chosen.push(s);
  }

  if (!isDateKey(input.dateKey)) throw new BookingInputError("Неверная дата");
  const date = parseDateKey(input.dateKey);
  const now = salonNow();
  const today = now.date;
  const maxDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + HORIZON_DAYS - 1);
  if (date < today || date > maxDate) throw new BookingInputError("Дата вне окна записи (14 дней)");

  const start = input.start;
  if (!Number.isInteger(start) || start < 0 || start >= 24 * 60 || start % 30 !== 0) {
    throw new BookingInputError("Неверное время");
  }
  if (input.dateKey === dateKeyOf(today) && start < now.minutes + 30) {
    throw new BookingInputError("Это время уже прошло");
  }

  const selection = input.masterSelection;
  if (selection !== "any" && !(typeof selection === "string" && selection.startsWith("cat:"))) {
    const m = masters.find((x) => x.id === selection && x.active);
    if (!m) throw new BookingInputError("Мастер недоступен");
  }

  const phone = normalizePhone(input.phone);
  if (!phone) throw new BookingInputError("Неверный номер телефона");
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 100) throw new BookingInputError("Укажите имя (2–100 символов)");
  const comment = String(input.comment || "").trim().slice(0, 500);
  if (input.consent !== true) throw new BookingInputError("Нужно согласие на обработку персональных данных");

  const dur = chosen.reduce((t, s) => t + (s.durationMin || 30), 0) || 60;
  const bookings = await store.listBookingsRange(input.dateKey, input.dateKey);
  const excludeNum = input.rescheduleNum || null;
  const master = assignMaster(input.dateKey, start, dur, selection, masters, bookings, settings, excludeNum);
  if (!master) {
    const e = new Error("Это время только что заняли. Выберите другое.");
    e.status = 409;
    e.code = "SLOT_TAKEN";
    throw e;
  }

  // Цены — по категории назначенного мастера; «от» — если мастер ещё не выбран
  // (сюда не доходим: мастер всегда назначается сервером; флаг from=false).
  let total = 0;
  const snapshot = [];
  for (const s of chosen) {
    const p = priceFor(s, master.categoryId, services);
    if (p == null) {
      throw new BookingInputError(`Услуга «${s.name}» не оказывается в категории мастера`);
    }
    total += p;
    snapshot.push({ serviceId: s.id, name: s.name, price: p, duration: s.durationMin || 30 });
  }

  const payloadHash = computePayloadHash({ selection, serviceIds, dateKey: input.dateKey, start, phone, name });

  return {
    masterId: master.id,
    masterName: `${master.name} · ${master.categoryId === "top" ? "Топ-цирюльник" : "Цирюльник"}`,
    dateKey: input.dateKey,
    start,
    dur,
    services: snapshot,
    price: total,
    from: false,
    name,
    clientPhone: phone,
    comment,
    consentAt: new Date().toISOString(),
    consentVersion: settings?.legal?.consentVersion || 1,
    idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey.slice(0, 128) : null,
    payloadHash,
  };
}
