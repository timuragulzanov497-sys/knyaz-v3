// Локальный dev-сервер: статика + те же /api-роуты, что на Vercel.
// Запуск: npm run dev  (http://localhost:3000, порт — env PORT)
// Без DATABASE_URL используется файловое хранилище data/dev.json.
// Секреты — только из .env (см. .env.example), никогда в коде.
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { join, extname, dirname, resolve, sep } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env — через установленный пакет dotenv; значения из окружения приоритетнее.
dotenv.config({ path: join(__dirname, ".env") });

const PORT = parseInt(process.env.PORT || "3000", 10);
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// Маршруты API -> файлы хендлеров (зеркало file-routing Vercel).
const ROUTES = [
  { re: /^\/api\/public\/config$/, file: "api/public/config.js" },
  { re: /^\/api\/public\/slots$/, file: "api/public/slots.js" },
  { re: /^\/api\/public\/bookings(?:\/(\d+)\/cancel)?$/, file: "api/public/bookings.js", params: ["num"] },
  { re: /^\/api\/media\/([^/]+)$/, file: "api/media/[id].js", params: ["id"] },
  { re: /^\/api\/auth\/login$/, file: "api/auth/login.js" },
  { re: /^\/api\/auth\/logout$/, file: "api/auth/logout.js" },
  { re: /^\/api\/auth\/me$/, file: "api/auth/me.js" },
  { re: /^\/api\/setup$/, file: "api/setup.js" },
  { re: /^\/api\/admin\/bookings\/(\d+)$/, file: "api/admin/bookings/[num].js", params: ["num"] },
  { re: /^\/api\/admin\/bookings$/, file: "api/admin/bookings.js" },
  { re: /^\/api\/admin\/stats$/, file: "api/admin/stats.js" },
  { re: /^\/api\/admin\/services$/, file: "api/admin/services.js" },
  { re: /^\/api\/admin\/groups$/, file: "api/admin/groups.js" },
  { re: /^\/api\/admin\/categories$/, file: "api/admin/categories.js" },
  { re: /^\/api\/admin\/masters$/, file: "api/admin/masters.js" },
  { re: /^\/api\/admin\/media$/, file: "api/admin/media.js" },
  { re: /^\/api\/admin\/settings$/, file: "api/admin/settings.js" },
];

const handlers = new Map();
async function loadHandler(file) {
  if (!handlers.has(file)) {
    // Без query-строки: "?v=..." ломает относительные импорты внутри хендлера.
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    handlers.set(file, mod.default);
  }
  return handlers.get(file);
}

// res-адаптер под интерфейс Vercel (res.status(n).json(obj) / .send()).
function wrapRes(nodeRes) {
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader: (k, v) => nodeRes.setHeader(k, v),
    json(obj) {
      const body = JSON.stringify(obj);
      nodeRes.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      nodeRes.end(body);
    },
    send(data) {
      if (Buffer.isBuffer(data)) {
        nodeRes.writeHead(statusCode);
        nodeRes.end(data);
      } else {
        nodeRes.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
        nodeRes.end(String(data ?? ""));
      }
    },
  };
  return res;
}

async function readJsonBody(req) {
  const ct = req.headers["content-type"] || "";
  if (!ct.includes("application/json")) return null;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error("Некорректный JSON");
    e.status = 400;
    throw e;
  }
}

function sendFile(res, filePath) {
  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
}

const server = createServer(async (req, nodeRes) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // --- API ---
    for (const route of ROUTES) {
      const m = pathname.match(route.re);
      if (!m) continue;
      const handler = await loadHandler(route.file);
      const query = Object.fromEntries(url.searchParams.entries());
      if (route.params) route.params.forEach((p, i) => (query[p] = m[i + 1]));
      // action для /api/admin/bookings/:num?action=cancel|reschedule уже в query
      const isJson = (req.headers["content-type"] || "").includes("application/json");
      const body = isJson ? await readJsonBody(req) : null;
      const apiReq = {
        method: req.method,
        url: req.url,
        query,
        body,
        headers: req.headers,
        socket: req.socket,
        ip: req.socket?.remoteAddress,
        on: req.on.bind(req),
        destroy: req.destroy.bind(req),
      };
      await handler(apiReq, wrapRes(nodeRes));
      return;
    }

    // --- Админка: /admin и /admin/* -> admin/index.html (SPA, History API) ---
    // Сначала — реальные файлы панели (admin.js, admin.css): раньше любой
    // путь /admin/* отдавал index.html, и локально панель оставалась без
    // скриптов и стилей. На Vercel статика имеет приоритет над rewrites,
    // поэтому там это не проявлялось.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      const adminIndex = join(ROOT, "admin", "index.html");
      if (!existsSync(adminIndex)) {
        nodeRes.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return nodeRes.end(JSON.stringify({ error: "Панель владельца ещё не собрана (нет admin/index.html)" }));
      }
      if (pathname !== "/admin") {
        const assetRel = decodeURIComponent(pathname).replace(/^\/admin\//, "");
        const assetPath = resolve(join(ROOT, "admin", assetRel));
        if (assetPath.startsWith(join(ROOT, "admin") + sep) && existsSync(assetPath) && statSync(assetPath).isFile()) {
          return sendFile(nodeRes, assetPath);
        }
      }
      return sendFile(nodeRes, adminIndex);
    }

    // --- Статика: ТОЛЬКО публичная страница и assets. ---
    // Без allowlist сервер отдавал бы всё подряд, включая .env и исходники
    // (секреты DATABASE_URL / SETUP_TOKEN). Разрешены только эти пути.
    const publicPath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const allowed = publicPath === "index.html" || publicPath === "favicon.ico" || publicPath.startsWith("assets/");
    if (!allowed) {
      nodeRes.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return nodeRes.end("Страница не найдена");
    }
    const filePath = resolve(join(ROOT, publicPath));
    if (!filePath.startsWith(ROOT + sep)) {
      nodeRes.writeHead(403);
      return nodeRes.end("Forbidden");
    }
    if (existsSync(filePath) && statSync(filePath).isFile()) return sendFile(nodeRes, filePath);
    nodeRes.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    nodeRes.end("Страница не найдена");
  } catch (e) {
    console.error(e);
    if (!nodeRes.headersSent) {
      const code = e && Number.isInteger(e.status) ? e.status : 500;
      nodeRes.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      nodeRes.end(JSON.stringify({ error: code === 400 ? e.message : "Внутренняя ошибка сервера" }));
    } else {
      nodeRes.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Князь V3 dev: http://localhost:${PORT}/  (админка: /admin)`);
  console.log(`Хранилище: ${process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "файл data/dev.json (только для разработки)"}`);
  if (!process.env.SETUP_TOKEN) {
    console.log("ВНИМАНИЕ: SETUP_TOKEN не задан — первая настройка /admin/setup недоступна. Задайте его в .env");
  }
});
