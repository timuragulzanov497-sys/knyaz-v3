// Выбор хранилища: Postgres, если задан DATABASE_URL; иначе —
// файловый адаптер для локальной разработки (data/dev.json).
// В продакшене DATABASE_URL обязателен: без него записи не переживут
// перезапуск инстанса, а файловый адаптер — только для dev/QA.
import { FileStore } from "./store-file.js";
import { PgStore } from "./store-pg.js";

let store = null;

export async function getStore() {
  if (store) return store;
  if (process.env.DATABASE_URL) {
    store = new PgStore();
  } else {
    store = new FileStore();
  }
  await store.init();
  return store;
}

export function isPostgres() {
  return !!process.env.DATABASE_URL;
}
