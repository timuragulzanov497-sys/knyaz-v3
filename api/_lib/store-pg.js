// Postgres-адаптер хранилища (продакшен: Neon, DATABASE_URL).
// Тот же интерфейс, что и FileStore. Двойная запись дополнительно
// закрыта EXCLUDE-констрейнтом в db/schema.sql (ошибка 23P01 -> 409),
// а создание записи сериализуется advisory lock'ом по мастеру.
import pg from "pg";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { CATEGORIES, GROUPS, SERVICES, MASTERS, SETTINGS } from "../../db/seed-data.js";
import { SlotTakenError } from "./store-file.js";
import { salonNow, dateKeyOf } from "./slots.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: process.env.DATABASE_URL?.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

// Экранирование спецсимволов LIKE: % и _ в запросе пользователя —
// обычные символы, а не маски.
const escapeLike = (s) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

function mapService(row, prices) {
  return {
    id: row.id,
    name: row.name,
    groupId: row.group_id,
    durationMin: row.duration_min,
    includes: row.includes || [],
    prices: prices || {},
    active: row.active,
    deletedAt: row.deleted_at,
    sort: row.sort,
  };
}

function mapMaster(row) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    specialization: row.specialization || "",
    avatarMediaId: row.avatar_media_id,
    active: row.active,
    deletedAt: row.deleted_at,
    sort: row.sort,
    schedule: row.schedule || {},
    overrides: row.overrides || [],
  };
}

function mapBooking(row) {
  return {
    num: row.num,
    masterId: row.master_id,
    masterName: row.master_name,
    dateKey: row.date_key,
    start: row.start_min,
    dur: row.dur_min,
    services: row.services || [],
    price: row.total_price,
    from: row.price_from,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    comment: row.comment || "",
    status: row.status,
    cancelReason: row.cancel_reason,
    consentAt: row.consent_at,
    consentVersion: row.consent_version,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
  };
}

export class PgStore {
  async init() {
    const sql = readFileSync(join(__dirname, "..", "..", "db", "schema.sql"), "utf8");
    await getPool().query(sql);
    // Seed, если каталог пуст.
    const { rows } = await getPool().query("SELECT COUNT(*)::int AS n FROM categories");
    if (rows[0].n === 0) await this.seedFresh();
    return this;
  }

  async seedFresh() {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      for (const c of CATEGORIES) {
        await client.query("INSERT INTO categories (id, name, sort) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [c.id, c.name, c.sort]);
      }
      for (const g of GROUPS) {
        await client.query("INSERT INTO svc_groups (id, name, sort) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [g.id, g.name, g.sort]);
      }
      for (const [i, s] of SERVICES.entries()) {
        await client.query(
          "INSERT INTO services (id, name, group_id, duration_min, includes, sort) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
          [s.id, s.name, s.groupId, s.durationMin, JSON.stringify(s.includes), i],
        );
      }
      for (const s of SERVICES) {
        for (const [catId, price] of Object.entries(s.prices)) {
          await client.query(
            "INSERT INTO service_prices (service_id, category_id, price_rub) VALUES ($1,$2,$3) ON CONFLICT (service_id, category_id) DO NOTHING",
            [s.id, catId, price],
          );
        }
      }
      for (const [i, m] of MASTERS.entries()) {
        await client.query(
          "INSERT INTO masters (id, name, category_id, specialization, schedule, overrides, sort) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING",
          [m.id, m.name, m.categoryId, m.specialization || "", JSON.stringify(m.schedule), JSON.stringify(m.overrides), i],
        );
      }
      await client.query("INSERT INTO settings (key, value) VALUES ('site', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(SETTINGS)]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- владелец / сессии ----
  async getOwner() {
    const { rows } = await getPool().query("SELECT email, password_hash AS \"passwordHash\", created_at AS \"createdAt\" FROM owner WHERE id=1");
    return rows[0] || null;
  }
  async createOwner({ email, passwordHash }) {
    const { rows } = await getPool().query(
      "INSERT INTO owner (id, email, password_hash) VALUES (1,$1,$2) RETURNING email, password_hash AS \"passwordHash\", created_at AS \"createdAt\"",
      [email, passwordHash],
    );
    return rows[0];
  }
  async createSession(tokenHash, expiresAt) {
    await getPool().query("INSERT INTO sessions (token_hash, expires_at) VALUES ($1,$2)", [tokenHash, expiresAt]);
  }
  async getSession(tokenHash) {
    const { rows } = await getPool().query(
      "SELECT token_hash AS \"tokenHash\", expires_at AS \"expiresAt\" FROM sessions WHERE token_hash=$1",
      [tokenHash],
    );
    return rows[0] || null;
  }
  async deleteSession(tokenHash) {
    await getPool().query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash]);
  }
  async deleteAllSessions() {
    await getPool().query("DELETE FROM sessions");
  }

  // ---- rate-limit ----
  // Скользящее окно: засчитывает попытку и возвращает true, если в окне
  // ещё есть место; false — лимит исчерпан (попытка НЕ засчитывается).
  // Строка блокируется FOR UPDATE — параллельные запросы с одного ключа
  // сериализуются и не проскакивают вдвоём.
  async hitRateLimit(key, max, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO rate_limits (key, hits) VALUES ($1, '[]'::jsonb) ON CONFLICT (key) DO NOTHING",
        [key],
      );
      const { rows } = await client.query("SELECT hits FROM rate_limits WHERE key=$1 FOR UPDATE", [key]);
      const raw = Array.isArray(rows[0]?.hits) ? rows[0].hits : [];
      const hits = raw.filter((t) => typeof t === "number" && t > cutoff);
      if (hits.length >= max) {
        await client.query("COMMIT");
        return false;
      }
      hits.push(now);
      await client.query("UPDATE rate_limits SET hits=$2 WHERE key=$1", [key, JSON.stringify(hits)]);
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- каталог ----
  async getCategories() {
    const { rows } = await getPool().query("SELECT id, name, sort FROM categories ORDER BY sort");
    return rows;
  }
  async renameCategory(id, name) {
    const { rows } = await getPool().query("UPDATE categories SET name=$2 WHERE id=$1 RETURNING id, name, sort", [id, name]);
    return rows[0] || null;
  }
  async getGroups() {
    const { rows } = await getPool().query("SELECT id, name, sort FROM svc_groups ORDER BY sort");
    return rows;
  }
  async addGroup({ id, name }) {
    const { rows } = await getPool().query(
      "INSERT INTO svc_groups (id, name, sort) VALUES ($1,$2,(SELECT COALESCE(MAX(sort),-1)+1 FROM svc_groups)) RETURNING id, name, sort",
      [id, name],
    );
    return rows[0];
  }
  async renameGroup(id, name) {
    const { rows } = await getPool().query("UPDATE svc_groups SET name=$2 WHERE id=$1 RETURNING id, name, sort", [id, name]);
    return rows[0] || null;
  }
  async loadPrices(serviceIds) {
    const { rows } = await getPool().query(
      "SELECT service_id, category_id, price_rub FROM service_prices WHERE service_id = ANY($1)",
      [serviceIds],
    );
    const out = {};
    for (const r of rows) {
      (out[r.service_id] ??= {})[r.category_id] = r.price_rub;
    }
    return out;
  }
  async getServicesAdmin() {
    const { rows } = await getPool().query("SELECT * FROM services WHERE deleted_at IS NULL ORDER BY sort");
    const prices = await this.loadPrices(rows.map((r) => r.id));
    return rows.map((r) => mapService(r, prices[r.id] || {}));
  }
  async getService(id) {
    const { rows } = await getPool().query("SELECT * FROM services WHERE id=$1 AND deleted_at IS NULL", [id]);
    if (!rows[0]) return null;
    const prices = await this.loadPrices([id]);
    return mapService(rows[0], prices[id] || {});
  }
  async upsertService(svc) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO services (id, name, group_id, duration_min, includes, active, deleted_at, sort)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,(SELECT COALESCE(MAX(sort),-1)+1 FROM services))
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, group_id=EXCLUDED.group_id,
           duration_min=EXCLUDED.duration_min, includes=EXCLUDED.includes, active=EXCLUDED.active, deleted_at=NULL`,
        [svc.id, svc.name, svc.groupId, svc.durationMin, JSON.stringify(svc.includes || []), svc.active !== false],
      );
      for (const [catId, price] of Object.entries(svc.prices || {})) {
        await client.query(
          `INSERT INTO service_prices (service_id, category_id, price_rub) VALUES ($1,$2,$3)
           ON CONFLICT (service_id, category_id) DO UPDATE SET price_rub=EXCLUDED.price_rub`,
          [svc.id, catId, price],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return this.getService(svc.id);
  }
  async deleteService(id) {
    const { rowCount } = await getPool().query(
      "UPDATE services SET active=FALSE, deleted_at=now() WHERE id=$1",
      [id],
    );
    return rowCount > 0;
  }
  async getMastersAdmin() {
    const { rows } = await getPool().query("SELECT * FROM masters WHERE deleted_at IS NULL ORDER BY sort");
    return rows.map(mapMaster);
  }
  async getMaster(id) {
    const { rows } = await getPool().query("SELECT * FROM masters WHERE id=$1 AND deleted_at IS NULL", [id]);
    return rows[0] ? mapMaster(rows[0]) : null;
  }
  async upsertMaster(m) {
    const { rows } = await getPool().query(
      `INSERT INTO masters (id, name, category_id, specialization, avatar_media_id, active, deleted_at, schedule, overrides, sort)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,(SELECT COALESCE(MAX(sort),-1)+1 FROM masters))
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, category_id=EXCLUDED.category_id,
         specialization=EXCLUDED.specialization, avatar_media_id=EXCLUDED.avatar_media_id,
         active=EXCLUDED.active, deleted_at=NULL, schedule=EXCLUDED.schedule, overrides=EXCLUDED.overrides
       RETURNING *`,
      [m.id, m.name, m.categoryId, m.specialization || "", m.avatarMediaId || null, m.active !== false, JSON.stringify(m.schedule || {}), JSON.stringify(m.overrides || [])],
    );
    return mapMaster(rows[0]);
  }
  async deleteMaster(id) {
    const { rowCount } = await getPool().query(
      "UPDATE masters SET active=FALSE, deleted_at=now() WHERE id=$1",
      [id],
    );
    return rowCount > 0;
  }

  // ---- медиа ----
  async getMediaList() {
    const { rows } = await getPool().query(
      "SELECT id, name, content_type AS \"contentType\", size_bytes AS \"sizeBytes\", kind, created_at AS \"createdAt\" FROM media ORDER BY created_at DESC",
    );
    return rows;
  }
  async getMedia(id) {
    const { rows } = await getPool().query("SELECT * FROM media WHERE id=$1", [id]);
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      name: rows[0].name,
      contentType: rows[0].content_type,
      sizeBytes: rows[0].size_bytes,
      kind: rows[0].kind,
      dataB64: rows[0].data.toString("base64"),
      createdAt: rows[0].created_at,
    };
  }
  async addMedia(m) {
    await getPool().query(
      "INSERT INTO media (id, name, content_type, size_bytes, kind, data) VALUES ($1,$2,$3,$4,$5,$6)",
      [m.id, m.name, m.contentType, m.sizeBytes, m.kind, Buffer.from(m.dataB64, "base64")],
    );
    const { id, name, contentType, sizeBytes, kind, createdAt } = m;
    return { id, name, contentType, sizeBytes, kind, createdAt };
  }
  async deleteMedia(id) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE masters SET avatar_media_id=NULL WHERE avatar_media_id=$1", [id]);
      const settings = await this.getSettings();
      const patch = {};
      if (settings.logoMediaId === id) patch.logoMediaId = null;
      if (settings.heroMediaId === id) patch.heroMediaId = null;
      if (Object.keys(patch).length) {
        await client.query("UPDATE settings SET value = value || $1 WHERE key='site'", [JSON.stringify(patch)]);
      }
      const { rowCount } = await client.query("DELETE FROM media WHERE id=$1", [id]);
      await client.query("COMMIT");
      return rowCount > 0;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  // ---- настройки ----
  async getSettings() {
    const { rows } = await getPool().query("SELECT value FROM settings WHERE key='site'");
    return rows[0]?.value || null;
  }
  async updateSettings(patch) {
    const { rows } = await getPool().query(
      "UPDATE settings SET value = value || $1 WHERE key='site' RETURNING value",
      [JSON.stringify(patch)],
    );
    return rows[0].value;
  }

  // ---- записи ----
  async listBookings({ from, to, masterId, status, q, limit = 50, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    const add = (sql, v) => {
      args.push(v);
      conds.push(sql.replace("?", `$${args.length}`));
    };
    if (from) add("date_key >= ?", from);
    if (to) add("date_key <= ?", to);
    if (masterId) add("master_id = ?", masterId);
    if (status) add("status = ?", status);
    if (q) {
      const digits = q.replace(/\D/g, "");
      args.push(`%${escapeLike(q.toLowerCase())}%`);
      const p = args.length;
      // Условие собирается целиком, без правок строкой: прежний
      // .replace(")", ...) попадал в ")" внутри LOWER(client_name) и
      // ломал SQL — 500 при любом запросе с цифрами.
      let cond = `(LOWER(client_name) LIKE $${p} ESCAPE '\\' OR client_phone LIKE $${p} ESCAPE '\\' OR CAST(num AS TEXT) LIKE $${p} ESCAPE '\\' OR (LOWER('K-' || CAST(num AS TEXT))) LIKE $${p} ESCAPE '\\'`;
      if (digits) {
        args.push(`%${digits}%`);
        cond += ` OR client_phone LIKE $${args.length} ESCAPE '\\'`;
      }
      conds.push(cond + ")");
    }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    const total = await getPool().query(`SELECT COUNT(*)::int AS n FROM bookings ${where}`, args);
    args.push(limit, offset);
    const { rows } = await getPool().query(
      `SELECT * FROM bookings ${where} ORDER BY date_key, start_min LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return { items: rows.map(mapBooking), total: total.rows[0].n };
  }
  async getBooking(num) {
    const { rows } = await getPool().query("SELECT * FROM bookings WHERE num=$1", [num]);
    return rows[0] ? mapBooking(rows[0]) : null;
  }
  async findByIdempotency(key) {
    const { rows } = await getPool().query("SELECT * FROM bookings WHERE idempotency_key=$1", [key]);
    return rows[0] ? mapBooking(rows[0]) : null;
  }
  async listBookingsForDay(dateKey) {
    const { rows } = await getPool().query(
      "SELECT * FROM bookings WHERE date_key=$1 AND status='CONFIRMED' ORDER BY start_min",
      [dateKey],
    );
    return rows.map(mapBooking);
  }
  // Будущие подтверждённые записи мастера (от даты включительно) —
  // для серверного запрета удаления мастера с активными записями.
  async listFutureBookingsForMaster(masterId, fromDateKey, limit = 5) {
    const { rows } = await getPool().query(
      `SELECT * FROM bookings WHERE master_id=$1 AND status='CONFIRMED' AND date_key >= $2
       ORDER BY date_key, start_min LIMIT $3`,
      [masterId, fromDateKey, limit],
    );
    return rows.map(mapBooking);
  }
  async listBookingsRange(from, to) {
    const { rows } = await getPool().query(
      "SELECT * FROM bookings WHERE date_key >= $1 AND date_key <= $2 AND status='CONFIRMED' ORDER BY date_key, start_min",
      [from, to],
    );
    return rows.map(mapBooking);
  }

  async insertBooking(b) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      // Сериализация создания записей одного мастера.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [b.masterId]);
      if (b.idempotencyKey) {
        const { rows } = await client.query("SELECT * FROM bookings WHERE idempotency_key=$1", [b.idempotencyKey]);
        if (rows[0]) {
          if (rows[0].payload_hash !== b.payloadHash) {
            throw Object.assign(new Error("Ключ идемпотентности уже использован с другими данными"), { status: 422 });
          }
          await client.query("COMMIT");
          return mapBooking(rows[0]);
        }
      }
      const overlap = await client.query(
        `SELECT 1 FROM bookings WHERE status='CONFIRMED' AND master_id=$1 AND date_key=$2
         AND start_min < $3 AND start_min + dur_min > $4 LIMIT 1`,
        [b.masterId, b.dateKey, b.start + b.dur, b.start],
      );
      if (overlap.rows.length) {
        throw new SlotTakenError();
      }
      const dup = await client.query(
        `SELECT num FROM bookings WHERE status='CONFIRMED' AND client_phone=$1 AND date_key=$2
         AND start_min < $3 AND start_min + dur_min > $4 LIMIT 1`,
        [b.clientPhone, b.dateKey, b.start + b.dur, b.start],
      );
      if (dup.rows.length) {
        const e = new Error(`Такая запись уже есть — № K-${dup.rows[0].num} на это же время`);
        e.status = 409;
        e.code = "DUP";
        throw e;
      }
      const { rows } = await client.query(
        `INSERT INTO bookings (master_id, master_name, date_key, start_min, dur_min, services,
           total_price, price_from, client_name, client_phone, comment, consent_at, consent_version,
           idempotency_key, payload_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          b.masterId, b.masterName, b.dateKey, b.start, b.dur, JSON.stringify(b.services),
          b.price, b.from, b.name, b.clientPhone, b.comment || "", b.consentAt, b.consentVersion,
          b.idempotencyKey || null, b.payloadHash || null,
        ],
      );
      await client.query("COMMIT");
      return mapBooking(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Финальный рубеж: EXCLUDE-констрейнт (конкурентный запрос между проверкой и вставкой).
      if (e.code === "23P01") throw new SlotTakenError();
      throw e;
    } finally {
      client.release();
    }
  }

  async updateBooking(num, patch) {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM bookings WHERE num=$1 FOR UPDATE", [num]);
      if (!rows[0]) {
        await client.query("COMMIT");
        return null;
      }
      const cur = mapBooking(rows[0]);
      const next = { ...cur, ...patch };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [next.masterId]);
      const overlap = await client.query(
        `SELECT 1 FROM bookings WHERE status='CONFIRMED' AND master_id=$1 AND date_key=$2 AND num <> $3
         AND start_min < $4 AND start_min + dur_min > $5 LIMIT 1`,
        [next.masterId, next.dateKey, num, next.start + next.dur, next.start],
      );
      if (overlap.rows.length) throw new SlotTakenError();
      const updated = await client.query(
        `UPDATE bookings SET master_id=$2, master_name=$3, date_key=$4, start_min=$5, dur_min=$6,
           services=$7, total_price=$8, price_from=$9 WHERE num=$1 RETURNING *`,
        [
          num, next.masterId, next.masterName, next.dateKey, next.start, next.dur,
          JSON.stringify(next.services), next.price, next.from,
        ],
      );
      await client.query("COMMIT");
      return mapBooking(updated.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23P01") throw new SlotTakenError();
      throw e;
    } finally {
      client.release();
    }
  }

  async cancelBooking(num, reason) {
    const { rows } = await getPool().query(
      "UPDATE bookings SET status='CANCELLED', cancel_reason=$2 WHERE num=$1 RETURNING *",
      [num, reason || null],
    );
    return rows[0] ? mapBooking(rows[0]) : null;
  }

  async bookingStats() {
    // «Сегодня/завтра» — в часовом поясе салона (Europe/Samara), а не в
    // системной зоне сервера (на Vercel это UTC: без этого до 04:00
    // по-астрахански «сегодня» считалось бы вчерашним днём).
    const now = salonNow();
    const t = dateKeyOf(now.date);
    const tm = dateKeyOf(new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() + 1));
    const from14 = dateKeyOf(new Date(now.date.getFullYear(), now.date.getMonth(), now.date.getDate() - 13));
    const { rows } = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE date_key=$1)::int AS today,
         COUNT(*) FILTER (WHERE date_key=$2)::int AS tomorrow,
         COUNT(*) FILTER (WHERE date_key >= $3)::int AS last14
       FROM bookings WHERE status='CONFIRMED' AND date_key >= $3 AND date_key <= $2`,
      [t, tm, from14],
    );
    return rows[0];
  }
}
