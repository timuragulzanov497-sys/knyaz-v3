// Общие HTTP-утилиты для API-функций (Vercel Serverless + локальный server.js).
// Каждый хендлер: export default async function handler(req, res)
// req: { method, query, body (уже распарсенный JSON или null), headers, cookies, ip }
// res: { status(code), json(obj), send(...) } — адаптер под Vercel/local.

export function json(res, status, obj) {
  res.status(status).json(obj);
}

export function ok(res, obj) {
  return json(res, 200, obj);
}

export function err(res, status, message, code) {
  const body = { error: message };
  if (code) body.code = code;
  return json(res, status, body);
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers?.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// IP клиента — ТОЛЬКО из источников, которые клиент подделать не может.
// Порядок:
//  1. x-vercel-forwarded-for — заголовок ставит edge Vercel, клиентское
//     значение перезаписывается платформой (первый IP — реальный клиент).
//  2. x-real-ip — тоже ставит прокси платформы.
//  3. Прямой пир TCP-соединения (req.socket.remoteAddress / req.ip):
//     локально это и есть клиент; на Vercel — внутренний IP платформы
//     (сюда не доходим, если заголовки платформы на месте).
// x-forwarded-for намеренно НЕ читается: его первый элемент задаёт клиент,
// и по нему обходился rate-limit логина (ротация заголовка = новый бакет).
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function normalizeIp(v) {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  if (s.startsWith("::ffff:")) s = s.slice(7); // IPv4-mapped IPv6 -> 1.2.3.4
  if (IPV4_RE.test(s)) return s;
  if (s.includes(":") && s.length <= 45 && IPV6_RE.test(s)) return s.toLowerCase();
  return null;
}

export function clientIp(req) {
  const h = req.headers || {};
  const vercel = String(h["x-vercel-forwarded-for"] || "").split(",")[0].trim();
  const fromVercel = normalizeIp(vercel);
  if (fromVercel) return fromVercel;
  const fromReal = normalizeIp(h["x-real-ip"]);
  if (fromReal) return fromReal;
  const fromSocket = normalizeIp(req.socket?.remoteAddress) || normalizeIp(req.ip);
  if (fromSocket) return fromSocket;
  return "unknown";
}

// Простой in-memory rate-limit: key -> массив отметок времени.
// Для одного инстанса serverless-функции; защита от перебора, не от DDoS.
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

// Разбор multipart/form-data (загрузка изображений). Без зависимостей.
// Возвращает { fields: {...}, files: [{ name, filename, contentType, data: Buffer }] }.
export function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers?.["content-type"] || "";
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
    if (!m) return reject(Object.assign(new Error("Ожидается multipart/form-data"), { status: 400 }));
    const boundary = Buffer.from("--" + (m[1] || m[2]).trim());
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 5 * 1024 * 1024) {
        reject(Object.assign(new Error("Тело запроса слишком большое"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const fields = {};
        const files = [];
        let start = 0;
        while (true) {
          const bIdx = buf.indexOf(boundary, start);
          if (bIdx < 0) break;
          let pos = bIdx + boundary.length;
          if (buf[pos] === 45 && buf[pos + 1] === 45) break; // "--" — конец
          if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
          const headEnd = buf.indexOf("\r\n\r\n", pos);
          if (headEnd < 0) break;
          const head = buf.slice(pos, headEnd).toString("latin1");
          const dataStart = headEnd + 4;
          let dataEnd = buf.indexOf(boundary, dataStart);
          if (dataEnd < 0) break;
          dataEnd -= 2; // \r\n перед границей
          const data = buf.slice(dataStart, dataEnd);
          const nameM = head.match(/name="([^"]*)"/);
          const fileM = head.match(/filename="([^"]*)"/);
          const typeM = head.match(/Content-Type:\s*([^\r\n]+)/i);
          if (fileM && fileM[1]) {
            files.push({
              name: nameM?.[1] || "file",
              filename: fileM[1],
              contentType: (typeM?.[1] || "application/octet-stream").trim(),
              data,
            });
          } else if (nameM) {
            fields[nameM[1]] = data.toString("utf8");
          }
          start = dataEnd + 2;
        }
        resolve({ fields, files });
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// Проверка сигнатуры файла по magic bytes (не только по расширению).
// Возвращает 'jpeg' | 'png' | 'webp' | null.
export function detectImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}
