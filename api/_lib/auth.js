// Авторизация владельца: scrypt-хеш пароля (Node crypto, без нативных deps),
// сессия — случайный токен, в БД хранится только его sha256-хеш,
// cookie HttpOnly + SameSite=Lax (+ Secure на проде, где https).
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getStore } from "./store.js";

export const SESSION_COOKIE = "knyaz_admin";
const SESSION_DAYS = 30;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, saltHex, keyHex] = String(stored).split("$");
    if (algo !== "scrypt" || !saltHex || !keyHex) return false;
    const key = scryptSync(password, Buffer.from(saltHex, "hex"), 64, {
      N: 16384,
      r: 8,
      p: 1,
    });
    const expected = Buffer.from(keyHex, "hex");
    if (key.length !== expected.length) return false;
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

function newSessionToken() {
  const token = randomBytes(32).toString("hex"); // 256 бит
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash };
}

export function sessionCookieHeader(token, req) {
  const secure = req?.headers?.["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
  return (
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
    (secure ? "; Secure" : "")
  );
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export async function createSession(req, res) {
  const store = await getStore();
  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await store.createSession(tokenHash, expiresAt);
  res.setHeader("Set-Cookie", sessionCookieHeader(token, req));
}

export async function getSessionOwner(req) {
  const cookies = parseCookieHeader(req.headers?.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const store = await getStore();
  const session = await store.getSession(tokenHash);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    await store.deleteSession(tokenHash);
    return null;
  }
  const owner = await store.getOwner();
  return owner || null;
}

function parseCookieHeader(raw) {
  const out = {};
  for (const part of String(raw).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function requireAdmin(req, res) {
  const owner = await getSessionOwner(req);
  if (!owner) {
    res.status(401).json({ error: "Требуется вход в панель владельца" });
    return null;
  }
  return owner;
}

// Сравнение одноразового токена первой настройки в постоянное время.
export function setupTokenMatches(provided) {
  const expected = process.env.SETUP_TOKEN || "";
  if (!expected || typeof provided !== "string" || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
