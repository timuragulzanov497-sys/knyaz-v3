// Валидация входных данных на сервере. Клиентская валидация — только UX.
// Все функции возвращают { ok: true, data } или { ok: false, error }.

export function fail(error) {
  return { ok: false, error };
}

export function isDateKey(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00");
  return !Number.isNaN(d.getTime()) && v === d.toISOString().slice(0, 10);
}

export function isInt(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

export function cleanStr(v, maxLen) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  if (!s || s.length > maxLen) return null;
  return s;
}

export function optStr(v, maxLen) {
  if (v === undefined || v === null || v === "") return null;
  return cleanStr(v, maxLen);
}

// Телефон РФ -> E.164 "+7XXXXXXXXXX" или null.
export function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  if (!d.startsWith("7")) d = "7" + d;
  if (d.length !== 11) return null;
  return "+" + d;
}

export function validEmail(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) && v.length <= 120;
}

export function validPassword(v) {
  return typeof v === "string" && v.length >= 12 && v.length <= 128;
}

// id услуги/мастера: латиница, цифры, дефис, подчёркивание, двоеточие (barber:b1).
export function validId(v) {
  return typeof v === "string" && /^[a-zA-Z0-9:_-]{1,64}$/.test(v);
}

export function validPrice(v) {
  // null = «не оказывается в этой категории»; иначе целое число рублей >= 0.
  if (v === null || v === undefined) return true;
  return Number.isInteger(v) && v >= 0 && v <= 1000000;
}
