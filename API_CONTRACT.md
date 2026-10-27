# API-контракт — «Князь» V3 (публичный сайт + админ-панель /admin)

Источник правды — код в `api/` (Vercel Serverless Functions, file-routing;
локально те же роуты отдаёт `server.js`). Этот документ сверен с кодом
2026-10-27 после аудита бэкенда. Если код и документ расходятся — прав код,
а документ надо обновить.

## Общие правила

- Формат: JSON, кроме `GET /api/media/:id` (байты картинки).
- Ошибки: `{ "error": "<текст>" }`, у дублей ещё `"code": "SLOT_TAKEN" | "DUP"`.
- Часовой пояс салона — **Europe/Samara (UTC+4)**. Даты — `YYYY-MM-DD`,
  время — минуты от местной полуночи, шаг 30 минут. Окно записи — 14 дней,
  «сегодня» — не раньше «сейчас + 30 минут».
- Номера записей — `K-1001`, `K-1002`, … (последовательность БД).
- Цены в записи — снапшот на момент создания: смена цены не меняет старые записи.
- В `localStorage` браузера записи НЕ хранятся: только черновик выбора
  (`knyaz-v3-draft-v1`) и ссылка на свою запись `{num, phone}`
  (`knyaz-v3-my-booking-v1`) для переноса/отмены с экрана успеха.

## Авторизация

- Владелец — один. Пароль — только scrypt-хеш (`scrypt$salt$key`, N=16384),
  минимум 12 символов.
- Сессия — случайный токен (256 бит), в БД хранится только его sha256-хеш.
  Cookie `knyaz_admin`: HttpOnly, `Path=/`, `SameSite=Lax`, `Max-Age=30 дней`,
  `Secure` на https. Секрета подписи сессий нет (`SESSION_SECRET`
  не используется и удалён из `.env.example`).
- Все `/api/admin/*` без сессии → **401** `{ "error": "Требуется вход в панель владельца" }`.
- Rate-limit (in-memory, на инстанс): вход — 10 попыток / 5 мин с IP,
  setup — 5 / мин с IP, загрузка файлов — 20 / мин с IP.

## Первая настройка и вход

| Метод и путь | Тело / ответ |
|---|---|
| `GET /api/setup` | → `200 { "setupNeeded": true \| false }` |
| `POST /api/setup` | `{ token, email, password, passwordRepeat }` → `201 { "ok": true, "email": ... }` + cookie сессии. Работает только пока владельца нет: неверный токен → 403, повторная настройка → 403, плохой email/пароль (<12) → 400. Токен — `SETUP_TOKEN` из env, сравнение в постоянное время. |
| `POST /api/auth/login` | `{ email, password }` → `200 { "ok": true, "email": ... }` + cookie. Ошибка всегда одна: 401 «Неверный email или пароль». |
| `POST /api/auth/logout` | → `200 { "ok": true }`, сессия удаляется из БД, cookie гасится. |
| `GET /api/auth/me` | → `200 { "ok": true, "email": ... }` или 401 без сессии. |

## Публичные эндпоинты (без авторизации)

### `GET /api/public/config`

Всё для публичной страницы: категории, группы, услуги с ценами, мастера,
настройки, юртексты. Секретов и внутренних данных нет.

```json
{
  "categories": [{ "id": "barber", "name": "Цирюльник", "sort": 1 }],
  "groups": [{ "id": "hair", "name": "Стрижки", "sort": 1 }],
  "services": [{ "id": "haircut", "name": "Стрижка мужская", "groupId": "hair",
                 "durationMin": 60, "includes": [], "prices": { "barber": 700, "top": 1000 } }],
  "masters": [{ "id": "barber:b1", "name": "Барбер 1", "categoryId": "barber",
                "specialization": "", "avatarUrl": "/api/media/m_..." | null, "initials": "Б1" }],
  "settings": { "phone": "+79171810484", "phoneDisplay": "+7 917 181-04-84",
    "address": "...", "openStartMin": 600, "openEndMin": 1260,
    "paymentText": "Только наличные", "wifi": true, "dogAllowed": true,
    "links": { "gis": "...", "gisReviews": "...", "max": "...", "vk": "...", "maps": "..." },
    "requisites": { "ip": "", "inn": "", "ogrn": "" },
    "legal": { "policyHtml": "...", "consentHtml": "...", "consentVersion": 1 },
    "logoUrl": null, "heroUrl": null }
}
```

Показываются только активные (`active=true`) и не удалённые услуги/мастера.

### `GET /api/public/slots?from=YYYY-MM-DD&to=YYYY-MM-DD&master=...&duration=60[&excludeNum=N]`

- `master`: `any` | `cat:<categoryId>` | `<masterId>`.
- `duration`: 5–480 минут. Диапазон дат — не более 14 дней.
- Ответ: `200 { "from", "to", "master", "duration", "days": { "2026-10-28": [600, 630, ...] } }`
  (свободные старты слотов по дням; занятость — только реальные записи из БД
  + график мастеров, псевдослучайной занятости нет).
- Неверные параметры → 400.

### `POST /api/public/bookings`

Создать запись. Тело:

```json
{ "masterSelection": "any" | "cat:barber" | "barber:b1",
  "serviceIds": ["haircut", "beard"], "dateKey": "2026-10-28", "start": 660,
  "name": "Иван", "phone": "+79000000001", "comment": "",
  "consent": true, "idempotencyKey": "<случайная строка>",
  "rescheduleNum": null }
```

- `consent` обязателен `true` (галочка согласия), иначе 400.
- Телефон нормализуется в E.164 `+7XXXXXXXXXX`, иначе 400.
- Ответ: `201 { "booking": { "num": 1001, "masterId", "masterName", "dateKey",
  "start", "dur", "services": ["Стрижка мужская"], "servicesDetailed": [...],
  "price": 700, "from": false, "name", "phone", "comment", "status": "CONFIRMED",
  "createdAt" } }`.
- Повтор с тем же `idempotencyKey` и теми же данными → та же запись
  (`200`, `"replayed": true`); с другими данными → 422.
- Двойная запись: то же время у того же мастера → **409 `SLOT_TAKEN`**;
  тот же телефон на то же время (другой мастер) → **409 `DUP`**.
  Защита — три рубежа: проверка слота в приложении, advisory lock по
  мастеру, EXCLUDE-констрейнт БД (`23P01` → 409).
- Перенос своей записи: тот же эндпоинт с `rescheduleNum` + телефоном из
  исходной записи → `200 { "booking", "rescheduled": true }`, номер `K-…`
  сохраняется. Чужой телефон → 403, отменённая запись → 409, нет записи → 404.

### `POST /api/public/bookings/:num/cancel`

Тело `{ "phone": "+79000000001" }` — телефон должен совпадать с записью,
иначе 403. Нет записи → 404. Ответ `200 { "booking" }` со статусом
`CANCELLED`; слот освобождается. Повторная отмена — тоже 200.

## Медиа

### `GET /api/media/:id`

Байты картинки (`Content-Type` — `image/jpeg|png|webp`,
`Cache-Control: public, max-age=86400, immutable`). Нет файла → 404.
Публичный роут: аватары/логотип/hero показываются на публичной странице.

## Админка (все — только с сессией, иначе 401)

### Записи и сводка

| Метод и путь | Описание |
|---|---|
| `GET /api/admin/stats` | `{ "today": N, "tomorrow": N, "last14": N }` — подтверждённые записи; «сегодня/завтра» в часовом поясе салона. |
| `GET /api/admin/bookings?date=today\|tomorrow\|all\|YYYY-MM-DD&master=&status=CONFIRMED\|CANCELLED&q=&limit=&offset=` | Список записей. `limit` 1–100 (по умолчанию 20). Ответ `{ "bookings": [...], "total": N, "masters": [{id, name, categoryId}], "today", "tomorrow" }`. Поиск `q` — по имени, телефону, номеру. |
| `GET /api/admin/bookings/:num` | Одна запись `{ "booking" }` или 404. |
| `POST /api/admin/bookings/:num?action=cancel` | `{ "reason": "..." }` → `{ "booking" }` (`CANCELLED`, слот освобождается). |
| `POST /api/admin/bookings/:num?action=reschedule` | `{ "dateKey", "start" }` — перенести (услуги, мастер и цена сохраняются); занятый слот → 409 `SLOT_TAKEN`, дата вне окна/прошлое время → 400, отменённая запись → 409. |

### Услуги и прайс

- `GET /api/admin/services` → `{ "services": [...], "groups": [...], "categories": [...] }`
  (включая скрытые с сайта `active=false`, без удалённых).
- `POST /api/admin/services` — создать/изменить:
  `{ "id"? , "name", "groupId", "durationMin": 5–480,
     "includes": ["<serviceId>", ...] (макс. 10, только существующие услуги),
     "prices": { "barber": 700 | null, "top": 1000 | null }, "active": true }`.
  `price = null` — «не оказывается в этой категории». Без `id` создаётся
  `svc_<hex>`. Несуществующая группа → 400, неизвестный `id` → 404.
- `DELETE /api/admin/services?id=...` — soft-delete (скрыть с сайта,
  старые записи сохраняются). Нет услуги → 404.

### Группы услуг

- `GET /api/admin/groups` → `{ "groups": [...] }`.
- `POST /api/admin/groups` `{ "name" }` → `201 { "group" }` (id — slug из имени,
  при коллизии — с суффиксом). Переименования групп нет (см. ниже).

### Виды мастеров (категории)

- `GET /api/admin/categories` → `{ "categories": [...] }`.
- `POST /api/admin/categories` `{ "id", "name" }` — переименовать вид.
  Удалить категорию и добавить третью нельзя (цены привязаны к двум видам).
  Неизвестный `id` → 404.

### Мастера

- `GET /api/admin/masters` → `{ "masters": [...], "categories": [...], "defaultSchedule": {...} }`.
- `POST /api/admin/masters` — создать/изменить:
  `{ "id"?, "name" (2–100), "categoryId", "specialization"?,
     "avatarMediaId": "<id из медиатеки>" | null,
     "schedule": { "0"–"6": { "dayOff": true } | { "dayOff": false, "startMin", "endMin" } },
     "overrides": [{ "date": "YYYY-MM-DD", "dayOff": true, "reason"? } |
                   { "date", "dayOff": false, "startMin", "endMin", "reason"? }] (макс. 60),
     "active": true }`.
  Без `id` создаётся `<categoryId>:m<hex>`. Неизвестная категория или
  аватар не из медиатеки → 400, неизвестный `id` → 404.
- `DELETE /api/admin/masters?id=...` — soft-delete (записи сохраняются).

### Медиатека

- `GET /api/admin/media` → `{ "media": [{ "id", "name", "contentType", "sizeBytes", "kind", "createdAt", "url", "isLogo", "isHero" }], "logoMediaId", "heroMediaId" }`.
- `POST /api/admin/media` (multipart/form-data, поле `file`) — загрузка:
  только JPG/PNG/WebP по magic bytes, до 3 МБ → `201 { "media": { ..., "url": "/api/media/m_..." } }`.
  Имя файла — случайное `m_<hex>`; файлы хранятся в БД (BYTEA).
- `POST /api/admin/media` (JSON) `{ "action": "setRole"|"clearRole", "mediaId"?, "role": "logo"|"hero" }` —
  назначить/снять логотип или фото главной.
- `DELETE /api/admin/media?id=...` — удалить (аватар мастера, логотип и hero,
  ссылавшиеся на файл, снимаются автоматически).

### Настройки

- `GET /api/admin/settings` → `{ "settings": {...} }`.
- `POST /api/admin/settings` `{ "section", "data" }` — сохранить одну секцию:
  - `contacts`: `{ "phone", "phoneDisplay"?, "address", "openStartMin", "openEndMin" }`;
  - `links`: `{ "gis"?, "gisReviews"?, "max"?, "vk"?, "maps"? }` (только http/https URL);
  - `payment`: `{ "paymentText", "wifi": bool, "dogAllowed": bool }`;
  - `requisites`: `{ "ip"?, "inn"?, "ogrn"? }` — пустые до заполнения владельцем;
  - `legal`: `{ "policyHtml", "consentHtml" }` (до 60000 символов каждый;
    при изменении текста версия согласия `consentVersion` +1);
  - `schedule`: `{ "defaultSchedule": { "0"–"6": {...} } }` — недельный шаблон салона.
  - Неизвестная секция или неверные данные → 400.

## Хранение

- Продакшен: Postgres (Neon, отдельный проект от `knyaz-barbershop`),
  схема — `db/schema.sql`, seed — `db/seed-data.js` (`npm run seed`).
  `DATABASE_URL` обязателен: без него включается файловый адаптер
  `data/dev.json` только для локальной разработки/QA.
- Первый запрос к API сам применяет схему и seed, если каталог пуст
  (`PgStore.init()`).
- Удаление услуги/мастера — soft-delete (`active=false, deleted_at=now()`).
