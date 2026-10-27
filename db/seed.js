// Seed: применить схему и загрузить начальные данные в Postgres.
// Запуск: npm run seed  (DATABASE_URL — из .env или окружения)
// Без DATABASE_URL ничего не делает: файловый адаптер сидится сам при первом запуске.
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env — через установленный пакет dotenv.
dotenv.config({ path: join(__dirname, "..", ".env") });

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL не задан — seed не нужен: файловое хранилище сидится само при запуске.");
  process.exit(0);
}

const { PgStore } = await import("../api/_lib/store-pg.js");
const store = new PgStore();
await store.init();
console.log("Схема применена, начальные данные загружены (категории, группы, услуги, мастера, настройки).");
process.exit(0);
