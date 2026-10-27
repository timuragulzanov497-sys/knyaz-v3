// Слоты и занятость — чистые функции, без БД и ввода-вывода.
// Часовой пояс салона — Europe/Samara (Астрахань, UTC+4 круглый год, без DST).
// Все расчёты — в минутах от местной полуночи; даты — "YYYY-MM-DD".

export const TZ = "Europe/Samara";
export const STEP_MIN = 30;
export const HORIZON_DAYS = 14;

export function pad(n) {
  return String(n).padStart(2, "0");
}

export function dateKeyOf(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDateKey(k) {
  const p = String(k || "").split("-");
  if (p.length !== 3) return null;
  const d = new Date(+p[0], +p[1] - 1, +p[2]);
  return Number.isNaN(d.getTime()) ? null : d;
}

// «Сейчас» в часовом поясе салона, независимо от зоны устройства/сервера.
export function salonNow() {
  try {
    const parts = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date())
      .forEach((p) => {
        parts[p.type] = p.value;
      });
    return {
      date: new Date(+parts.year, +parts.month - 1, +parts.day),
      minutes: (+parts.hour % 24) * 60 + +parts.minute,
    };
  } catch {
    const n = new Date();
    return {
      date: new Date(n.getFullYear(), n.getMonth(), n.getDate()),
      minutes: n.getHours() * 60 + n.getMinutes(),
    };
  }
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Недельный шаблон мастера: { weekday 0=вс..6=сб: { dayOff, startMin, endMin } }.
// Разовые изменения (overrides) перекрывают шаблон на конкретную дату.
export function workWindowFor(master, dateKey, settings) {
  const salon = settings?.defaultSchedule || {};
  const d = parseDateKey(dateKey);
  if (!d) return null;
  const wd = d.getDay();
  // Разовое изменение мастера на этот день.
  const ov = (master?.overrides || []).find((o) => o.date === dateKey);
  if (ov) {
    if (ov.dayOff) return null;
    return { startMin: ov.startMin, endMin: ov.endMin };
  }
  const tpl = (master?.schedule || {})[wd] ?? salon[wd];
  if (!tpl || tpl.dayOff) return null;
  return { startMin: tpl.startMin, endMin: tpl.endMin };
}

// Кандидаты-мастера по выбору клиента: 'any' | 'cat:<id>' | конкретный id.
export function candidateMasters(selection, masters) {
  const active = (masters || []).filter((m) => m.active);
  if (selection === "any") return active;
  if (typeof selection === "string" && selection.startsWith("cat:")) {
    const cat = selection.slice(4);
    return active.filter((m) => m.categoryId === cat);
  }
  return active.filter((m) => m.id === selection);
}

// Свободен ли конкретный мастер в start..start+dur на дату (записи + график).
export function masterFree(master, dateKey, start, dur, bookings, settings, excludeNum) {
  const end = start + dur;
  const win = workWindowFor(master, dateKey, settings);
  if (!win) return false;
  if (start < win.startMin || end > win.endMin) return false;
  for (const b of bookings || []) {
    if (b.status !== "CONFIRMED") continue;
    if (excludeNum != null && b.num === excludeNum) continue;
    if (b.masterId !== master.id) continue;
    if (b.dateKey !== dateKey) continue;
    if (overlaps(start, end, b.start, b.start + b.dur)) return false;
  }
  return true;
}

// Все свободные старты слота на дату для выбора мастера и длительности.
// Учитывает «сегодня +30 минут» и конец рабочего дня.
export function freeStartsForDay(dateKey, selection, durationMin, masters, bookings, settings, excludeNum, nowOverride) {
  const now = nowOverride || salonNow();
  const todayKey = dateKeyOf(now.date);
  const cands = candidateMasters(selection, masters);
  if (!cands.length) return [];
  const out = [];
  for (let t = 0; t < 24 * 60; t += STEP_MIN) {
    if (t + durationMin > 24 * 60) break;
    if (dateKey === todayKey && t < now.minutes + 30) continue;
    if (cands.some((m) => masterFree(m, dateKey, t, durationMin, bookings, settings, excludeNum))) {
      out.push(t);
    }
  }
  return out;
}

// Первый свободный кандидат на конкретное время (назначение мастера).
export function assignMaster(dateKey, start, durationMin, selection, masters, bookings, settings, excludeNum) {
  const cands = candidateMasters(selection, masters);
  for (const m of cands) {
    if (masterFree(m, dateKey, start, durationMin, bookings, settings, excludeNum)) return m;
  }
  return null;
}
