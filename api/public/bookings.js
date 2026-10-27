// Публичные записи: создание, отмена, перенос.
// POST /api/public/bookings — создать запись (или перенести свою, если передан
//   rescheduleNum + телефон из исходной записи).
// POST /api/public/bookings/:num/cancel { phone } — отменить свою запись.
// Телефон проверяется: отменить/перенести чужую запись нельзя.
import { getStore } from "../_lib/store.js";
import { err, ok, clientIp } from "../_lib/http.js";
import { checkRateLimit } from "../_lib/ratelimit.js";
import { resolveBookingInput, computePayloadHash } from "../_lib/booking.js";
import { normalizePhone } from "../_lib/validate.js";

// Публичный лимит на создание записей: 10 в час с одного IP и 5 в час
// с одного телефона. Без него бот занимает все слоты на 14 дней вперёд.
// Счётчики — в базе (см. api/_lib/ratelimit.js). Повторная отправка той же
// формы (идемпотентный replay) под лимит не попадает — проверка ниже
// стоит ПОСЛЕ replay-блока.
const BOOKING_IP_MAX = 10;
const BOOKING_PHONE_MAX = 5;
const BOOKING_WINDOW_MS = 60 * 60 * 1000;

function phoneMatches(booking, phoneRaw) {
  const phone = normalizePhone(phoneRaw);
  return phone && booking.clientPhone === phone;
}

export async function createBooking(req, res) {
  if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
  const body = req.body || {};
  try {
    const store = await getStore();
    const input = {
      masterSelection: body.masterSelection || body.masterId || "any",
      serviceIds: body.serviceIds,
      dateKey: body.dateKey,
      start: body.start,
      name: body.name,
      phone: body.phone,
      comment: body.comment,
      consent: body.consent === true,
      idempotencyKey: body.idempotencyKey,
      rescheduleNum: body.rescheduleNum ? parseInt(body.rescheduleNum, 10) : null,
    };
    if (input.rescheduleNum) {
      const existing = await store.getBooking(input.rescheduleNum);
      if (!existing) return err(res, 404, "Запись не найдена");
      if (existing.status !== "CONFIRMED") return err(res, 409, "Эту запись уже нельзя перенести");
      if (!phoneMatches(existing, body.phone)) {
        return err(res, 403, "Номер телефона не совпадает с записью");
      }
    }
    // Идемпотентность — ДО проверки слота: повторная отправка той же формы
    // не должна падать с 409 «слот занят» из-за собственной же записи.
    // (Вторая линия защиты — та же проверка внутри store.insertBooking.)
    if (!input.rescheduleNum && input.idempotencyKey) {
      const prev = await store.findByIdempotency(input.idempotencyKey);
      if (prev) {
        const hash = computePayloadHash({
          selection: input.masterSelection,
          serviceIds: [...new Set(Array.isArray(body.serviceIds) ? body.serviceIds : [])],
          dateKey: body.dateKey,
          start: body.start,
          phone: normalizePhone(body.phone),
          name: String(body.name || "").trim().replace(/\s+/g, " "),
        });
        if (prev.payloadHash !== hash) {
          return err(res, 422, "Ключ идемпотентности уже использован с другими данными");
        }
        return ok(res, { booking: toPublicView(prev), replayed: true });
      }
    }
    // Rate-limit — после replay (повтор той же формы не считается) и до
    // создания записи. Перенос (rescheduleNum) тоже считается: это та же
    // операция занятия слота.
    if (!(await checkRateLimit(store, "booking-ip", clientIp(req), BOOKING_IP_MAX, BOOKING_WINDOW_MS))) {
      return err(res, 429, "Слишком много записей. Попробуйте позже.");
    }
    const phoneNorm = normalizePhone(body.phone);
    if (phoneNorm && !(await checkRateLimit(store, "booking-phone", phoneNorm, BOOKING_PHONE_MAX, BOOKING_WINDOW_MS))) {
      return err(res, 429, "Слишком много записей с этого телефона. Попробуйте позже.");
    }
    const resolved = await resolveBookingInput(input);
    if (input.rescheduleNum) {
      // Перенос — та же запись, новый мастер/время/услуги/цена. Номер K-... сохраняется.
      const updated = await store.updateBooking(input.rescheduleNum, {
        masterId: resolved.masterId,
        masterName: resolved.masterName,
        dateKey: resolved.dateKey,
        start: resolved.start,
        dur: resolved.dur,
        services: resolved.services,
        price: resolved.price,
        from: resolved.from,
      });
      return ok(res, { booking: toPublicView(updated), rescheduled: true });
    }
    const saved = await store.insertBooking(resolved);
    return res.status(201).json({ booking: toPublicView(saved) });
  } catch (e) {
    if (e.status === 409) return err(res, 409, e.message, e.code || "SLOT_TAKEN");
    if (e.status === 422) return err(res, 422, e.message);
    if (e.status === 400) return err(res, 400, e.message);
    console.error("public/bookings create", e);
    return err(res, 500, "Не удалось сохранить запись. Проверьте интернет и попробуйте ещё раз.");
  }
}

export async function cancelBooking(req, res, num) {
  if (req.method !== "POST") return err(res, 405, "Метод не поддерживается");
  const body = req.body || {};
  try {
    const store = await getStore();
    const booking = await store.getBooking(num);
    if (!booking) return err(res, 404, "Запись не найдена");
    if (!phoneMatches(booking, body.phone)) {
      return err(res, 403, "Номер телефона не совпадает с записью");
    }
    if (booking.status === "CANCELLED") return ok(res, { booking: toPublicView(booking) });
    const cancelled = await store.cancelBooking(num, "Отменена клиентом");
    return ok(res, { booking: toPublicView(cancelled) });
  } catch (e) {
    console.error("public/bookings cancel", e);
    return err(res, 500, "Не удалось отменить запись");
  }
}

export default async function handler(req, res) {
  // Vercel file-routing: /api/public/bookings и /api/public/bookings/:num/cancel
  // попадают в этот файл; действие — по пути запроса.
  const url = String(req.url || "");
  const m = url.match(/\/bookings\/(\d+)\/cancel/);
  if (m) return cancelBooking(req, res, parseInt(m[1], 10));
  return createBooking(req, res);
}

export function toPublicView(b) {
  if (!b) return null;
  return {
    num: b.num,
    masterId: b.masterId,
    masterName: b.masterName,
    dateKey: b.dateKey,
    start: b.start,
    dur: b.dur,
    services: (b.services || []).map((s) => s.name),
    servicesDetailed: b.services || [],
    price: b.price,
    from: !!b.from,
    name: b.clientName,
    phone: b.clientPhone,
    comment: b.comment || "",
    status: b.status,
    createdAt: b.createdAt,
  };
}
