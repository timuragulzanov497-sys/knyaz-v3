// Файловый адаптер хранилища — ТОЛЬКО для локальной разработки и проверки QA.
// В продакшене (Vercel) используется Postgres (store-pg.js).
// Данные — один JSON-файл data/dev.json (в .gitignore). Файлы медиа — base64
// внутри того же файла (это серверное хранилище, НЕ localStorage браузера).
// Двойная запись блокируется мьютексом: создание/перенос записи —
// строго последовательно внутри одного процесса.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CATEGORIES, GROUPS, SERVICES, MASTERS, SETTINGS } from "../../db/seed-data.js";
import { overlaps, salonNow, dateKeyOf } from "./slots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || join(__dirname, "..", "..", "data", "dev.json");

export class SlotTakenError extends Error {
  constructor(message = "Это время уже занято") {
    super(message);
    this.status = 409;
    this.code = "SLOT_TAKEN";
  }
}

function freshState() {
  return {
    owner: null,
    sessions: [],
    categories: structuredClone(CATEGORIES),
    groups: structuredClone(GROUPS),
    services: SERVICES.map((s, i) => ({
      ...structuredClone(s),
      active: true,
      deletedAt: null,
      sort: i,
    })),
    masters: MASTERS.map((m, i) => ({
      ...structuredClone(m),
      active: true,
      deletedAt: null,
      sort: i,
    })),
    media: [],
    settings: structuredClone(SETTINGS),
    bookings: [],
    bookingSeq: 1001,
  };
}

function bookingPublic(b) {
  return { ...b, services: b.services.map((s) => ({ ...s })) };
}

export class FileStore {
  constructor() {
    this.mutex = Promise.resolve();
    this.state = null;
  }

  async init() {
    if (this.state) return this;
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    if (existsSync(DATA_FILE)) {
      try {
        this.state = JSON.parse(readFileSync(DATA_FILE, "utf8"));
      } catch {
        this.state = freshState();
      }
    } else {
      this.state = freshState();
      this.persist();
    }
    return this;
  }

  persist() {
    writeFileSync(DATA_FILE, JSON.stringify(this.state, null, 2));
  }

  // Последовательное выполнение критических секций (записи).
  async locked(fn) {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  // ---- владелец / сессии ----
  async getOwner() {
    return this.state.owner;
  }
  async createOwner({ email, passwordHash }) {
    if (this.state.owner) throw Object.assign(new Error("Владелец уже создан"), { status: 403 });
    this.state.owner = { email, passwordHash, createdAt: new Date().toISOString() };
    this.persist();
    return this.state.owner;
  }
  async createSession(tokenHash, expiresAt) {
    this.state.sessions.push({ tokenHash, expiresAt, createdAt: new Date().toISOString() });
    this.persist();
  }
  async getSession(tokenHash) {
    return this.state.sessions.find((s) => s.tokenHash === tokenHash) || null;
  }
  async deleteSession(tokenHash) {
    this.state.sessions = this.state.sessions.filter((s) => s.tokenHash !== tokenHash);
    this.persist();
  }
  async deleteAllSessions() {
    this.state.sessions = [];
    this.persist();
  }

  // ---- rate-limit (in-memory: файловый адаптер — только локальная
  // разработка в одном процессе; в проде — PgStore.hitRateLimit в БД) ----
  async hitRateLimit(key, max, windowMs) {
    if (!this.rateBuckets) this.rateBuckets = new Map();
    const now = Date.now();
    const arr = (this.rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return false;
    arr.push(now);
    this.rateBuckets.set(key, arr);
    return true;
  }

  // ---- каталог ----
  async getCategories() {
    return structuredClone(this.state.categories).sort((a, b) => a.sort - b.sort);
  }
  async renameCategory(id, name) {
    const c = this.state.categories.find((x) => x.id === id);
    if (!c) return null;
    c.name = name;
    this.persist();
    return structuredClone(c);
  }
  async getGroups() {
    return structuredClone(this.state.groups).sort((a, b) => a.sort - b.sort);
  }
  async addGroup({ id, name }) {
    if (this.state.groups.some((g) => g.id === id)) throw Object.assign(new Error("Группа уже существует"), { status: 409 });
    const g = { id, name, sort: this.state.groups.length };
    this.state.groups.push(g);
    this.persist();
    return structuredClone(g);
  }
  async renameGroup(id, name) {
    const g = this.state.groups.find((x) => x.id === id);
    if (!g) return null;
    g.name = name;
    this.persist();
    return structuredClone(g);
  }
  async getServicesAdmin() {
    return structuredClone(this.state.services.filter((s) => !s.deletedAt)).sort((a, b) => a.sort - b.sort);
  }
  async getService(id) {
    const s = this.state.services.find((x) => x.id === id && !x.deletedAt);
    return s ? structuredClone(s) : null;
  }
  async upsertService(svc) {
    const ex = this.state.services.find((x) => x.id === svc.id);
    if (ex) {
      Object.assign(ex, svc, { deletedAt: null });
    } else {
      this.state.services.push({ ...svc, active: true, deletedAt: null, sort: this.state.services.length });
    }
    this.persist();
    return structuredClone(this.state.services.find((x) => x.id === svc.id));
  }
  async deleteService(id) {
    const s = this.state.services.find((x) => x.id === id);
    if (!s) return false;
    s.active = false;
    s.deletedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  async getMastersAdmin() {
    return structuredClone(this.state.masters.filter((m) => !m.deletedAt)).sort((a, b) => a.sort - b.sort);
  }
  async getMaster(id) {
    const m = this.state.masters.find((x) => x.id === id && !x.deletedAt);
    return m ? structuredClone(m) : null;
  }
  async upsertMaster(m) {
    const ex = this.state.masters.find((x) => x.id === m.id);
    if (ex) {
      Object.assign(ex, m, { deletedAt: null });
    } else {
      this.state.masters.push({ ...m, active: true, deletedAt: null, sort: this.state.masters.length });
    }
    this.persist();
    return structuredClone(this.state.masters.find((x) => x.id === m.id));
  }
  async deleteMaster(id) {
    const m = this.state.masters.find((x) => x.id === id);
    if (!m) return false;
    m.active = false;
    m.deletedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  // ---- медиа ----
  async getMediaList() {
    return this.state.media.map((m) => ({
      id: m.id, name: m.name, contentType: m.contentType, sizeBytes: m.sizeBytes, kind: m.kind, createdAt: m.createdAt,
    }));
  }
  async getMedia(id) {
    const m = this.state.media.find((x) => x.id === id);
    return m ? structuredClone(m) : null;
  }
  async addMedia(m) {
    this.state.media.push(m);
    this.persist();
    return { ...m, dataB64: undefined };
  }
  async deleteMedia(id) {
    const before = this.state.media.length;
    this.state.media = this.state.media.filter((x) => x.id !== id);
    // Снять привязки: аватар мастера, логотип, hero.
    for (const m of this.state.masters) if (m.avatarMediaId === id) m.avatarMediaId = null;
    if (this.state.settings.logoMediaId === id) this.state.settings.logoMediaId = null;
    if (this.state.settings.heroMediaId === id) this.state.settings.heroMediaId = null;
    this.persist();
    return this.state.media.length < before;
  }

  // ---- настройки ----
  async getSettings() {
    return structuredClone(this.state.settings);
  }
  async updateSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.persist();
    return structuredClone(this.state.settings);
  }

  // ---- записи ----
  async listBookings({ from, to, masterId, status, q, limit = 50, offset = 0 } = {}) {
    let items = this.state.bookings.slice();
    if (from) items = items.filter((b) => b.dateKey >= from);
    if (to) items = items.filter((b) => b.dateKey <= to);
    if (masterId) items = items.filter((b) => b.masterId === masterId);
    if (status) items = items.filter((b) => b.status === status);
    if (q) {
      const needle = q.toLowerCase();
      items = items.filter(
        (b) =>
          b.clientName.toLowerCase().includes(needle) ||
          b.clientPhone.includes(needle.replace(/\D/g, "")) ||
          String(b.num).includes(needle),
      );
    }
    items.sort((a, b) => (a.dateKey + String(a.start).padStart(4, "0")).localeCompare(b.dateKey + String(b.start).padStart(4, "0")));
    const total = items.length;
    return { items: items.slice(offset, offset + limit).map(bookingPublic), total };
  }
  async getBooking(num) {
    const b = this.state.bookings.find((x) => x.num === num);
    return b ? bookingPublic(b) : null;
  }
  async findByIdempotency(key) {
    const b = this.state.bookings.find((x) => x.idempotencyKey === key);
    return b ? bookingPublic(b) : null;
  }
  async listBookingsForDay(dateKey) {
    return this.state.bookings.filter((b) => b.dateKey === dateKey && b.status === "CONFIRMED").map(bookingPublic);
  }
  // Будущие подтверждённые записи мастера (от даты включительно) —
  // для серверного запрета удаления мастера с активными записями.
  async listFutureBookingsForMaster(masterId, fromDateKey, limit = 5) {
    return this.state.bookings
      .filter((b) => b.masterId === masterId && b.status === "CONFIRMED" && b.dateKey >= fromDateKey)
      .sort((a, b) => (a.dateKey + String(a.start).padStart(4, "0")).localeCompare(b.dateKey + String(b.start).padStart(4, "0")))
      .slice(0, limit)
      .map(bookingPublic);
  }
  async listBookingsRange(from, to) {
    return this.state.bookings
      .filter((b) => b.dateKey >= from && b.dateKey <= to && b.status === "CONFIRMED")
      .map(bookingPublic);
  }

  hasOverlap(masterId, dateKey, start, dur, excludeNum) {
    return this.state.bookings.some(
      (b) =>
        b.status === "CONFIRMED" &&
        b.masterId === masterId &&
        b.dateKey === dateKey &&
        b.num !== excludeNum &&
        overlaps(start, start + dur, b.start, b.start + b.dur),
    );
  }
  hasPhoneDup(phone, dateKey, start, dur, excludeNum) {
    return this.state.bookings.find(
      (b) =>
        b.status === "CONFIRMED" &&
        b.clientPhone === phone &&
        b.dateKey === dateKey &&
        b.num !== excludeNum &&
        overlaps(start, start + dur, b.start, b.start + b.dur),
    );
  }

  async insertBooking(booking) {
    return this.locked(async () => {
      if (booking.idempotencyKey) {
        const ex = await this.findByIdempotency(booking.idempotencyKey);
        if (ex) {
          if (ex.payloadHash !== booking.payloadHash) {
            throw Object.assign(new Error("Ключ идемпотентности уже использован с другими данными"), { status: 422 });
          }
          return ex;
        }
      }
      if (this.hasOverlap(booking.masterId, booking.dateKey, booking.start, booking.dur, null)) {
        throw new SlotTakenError();
      }
      const dup = this.hasPhoneDup(booking.clientPhone, booking.dateKey, booking.start, booking.dur, null);
      if (dup) {
        const e = new Error(`Такая запись уже есть — № K-${dup.num} на это же время`);
        e.status = 409;
        e.code = "DUP";
        throw e;
      }
      const num = this.state.bookingSeq++;
      const saved = { ...booking, num, status: "CONFIRMED", createdAt: new Date().toISOString() };
      this.state.bookings.push(saved);
      this.persist();
      return bookingPublic(saved);
    });
  }

  async updateBooking(num, patch) {
    return this.locked(async () => {
      const b = this.state.bookings.find((x) => x.num === num);
      if (!b) return null;
      const next = { ...b, ...patch };
      if (this.hasOverlap(next.masterId, next.dateKey, next.start, next.dur, num)) {
        throw new SlotTakenError();
      }
      Object.assign(b, patch);
      this.persist();
      return bookingPublic(b);
    });
  }

  async cancelBooking(num, reason) {
    const b = this.state.bookings.find((x) => x.num === num);
    if (!b) return null;
    if (b.status === "CANCELLED") return bookingPublic(b);
    b.status = "CANCELLED";
    b.cancelReason = reason || null;
    this.persist();
    return bookingPublic(b);
  }

  async bookingStats() {
    // «Сегодня/завтра» — в часовом поясе салона (Europe/Samara), а не в
    // системной зоне сервера (см. store-pg.js).
    const now = salonNow();
    const t = dateKeyOf(now.date);
    const tm = dateKeyOf(new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() + 1));
    const from14 = dateKeyOf(new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() - 13));
    const conf = this.state.bookings.filter((b) => b.status === "CONFIRMED");
    return {
      today: conf.filter((b) => b.dateKey === t).length,
      tomorrow: conf.filter((b) => b.dateKey === tm).length,
      last14: conf.filter((b) => b.dateKey >= from14 && b.dateKey <= tm).length,
    };
  }
}
