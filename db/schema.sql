-- Схема БД «Князь» V3 (Postgres / Neon, отдельный проект от knyaz-barbershop).
-- Применять: psql "$DATABASE_URL" -f db/schema.sql  (или `npm run seed` для PG —
-- seed.js сначала применяет эту схему, потом загружает данные).
-- Защита от двойной записи — EXCLUDE-констрейнт на уровне БД (последний рубеж):
-- два подтверждённых визита одного мастера не могут пересекаться по времени.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SEQUENCE IF NOT EXISTS booking_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY DEFAULT 1,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT owner_single_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS svc_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES svc_groups(id),
  duration_min INTEGER NOT NULL DEFAULT 30,
  includes JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_prices (
  service_id TEXT NOT NULL REFERENCES services(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  price_rub INTEGER, -- NULL = «не оказывается в этой категории»
  PRIMARY KEY (service_id, category_id)
);

-- Медиатека — ДО masters: masters.avatar_media_id ссылается на media(id),
-- таблица должна существовать на момент создания masters.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS masters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES categories(id),
  specialization TEXT NOT NULL DEFAULT '',
  avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  deleted_at TIMESTAMPTZ,
  sort INTEGER NOT NULL DEFAULT 0,
  schedule JSONB NOT NULL DEFAULT '{}',
  overrides JSONB NOT NULL DEFAULT '[]'
);

-- Настройки сайта — одна строка key='site', value = JSON (см. db/seed-data.js).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  num INTEGER PRIMARY KEY DEFAULT nextval('booking_seq'),
  master_id TEXT NOT NULL REFERENCES masters(id),
  master_name TEXT NOT NULL,
  date_key TEXT NOT NULL, -- YYYY-MM-DD, местная дата салона
  start_min INTEGER NOT NULL, -- минуты от местной полуночи
  dur_min INTEGER NOT NULL,
  services JSONB NOT NULL DEFAULT '[]', -- снапшот: [{serviceId, name, price, duration}]
  total_price INTEGER NOT NULL,
  price_from BOOLEAN NOT NULL DEFAULT FALSE,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL, -- E.164 +7XXXXXXXXXX
  comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED | CANCELLED
  cancel_reason TEXT,
  consent_at TIMESTAMPTZ NOT NULL,
  consent_version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  payload_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Полуоткрытый интервал [start, start+dur): запись 10:00–11:00
  -- не конфликтует с 11:00–12:00. Отменённые не блокируют слот.
  EXCLUDE USING gist (
    date_key WITH =,
    master_id WITH =,
    int4range(start_min, start_min + dur_min) WITH &&
  ) WHERE (status = 'CONFIRMED')
);

CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings (date_key, start_min);
CREATE INDEX IF NOT EXISTS bookings_phone_idx ON bookings (client_phone, date_key);

-- Счётчики rate-limit (логин, первая настройка, публичные записи):
-- ключ (scope + IP/телефон) -> массив отметок времени (epoch ms) в окне.
-- Хранятся в БД, а не в памяти инстанса, чтобы лимит держался между
-- инстансами serverless и холодными стартами (см. api/_lib/ratelimit.js).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  hits JSONB NOT NULL DEFAULT '[]'
);
