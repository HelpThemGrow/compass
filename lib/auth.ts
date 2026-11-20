/**
 * Sign-in and roles.
 *
 * Accounts live in data/users.json (managed with `npm run users`), each with a
 * role: "viewer" can use Ask, Verify and Generate and see everything;
 * "editor" can also add, remove and rebuild knowledge base documents.
 * Passwords are stored as salted scrypt hashes.
 *
 * A session is a signed cookie carrying the user's email, an expiry and the
 * account's session version. Every request re-reads the account, so
 * disabling it, changing its role or resetting its password (which bumps the
 * version) takes effect immediately rather than when the cookie expires.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { settings } from "./config";

export type Role = "viewer" | "editor";
export interface SessionUser {
  email: string;
  name: string;
  role: Role;
}

interface StoredUser {
  email: string;
  name: string;
  role: Role;
  password: string;
  disabled?: boolean;
  session_version: number;
  created_at: string;
}

export const SESSION_COOKIE = "compass_session";
const SESSION_HOURS = 12;
const USERS_FILE = path.join(settings.dataDir, "users.json");
const AUDIT_FILE = path.join(settings.dataDir, "audit.log");

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 429, message: string) {
    super(message);
  }
}

// --------------------------------------------------------------------------
// Accounts
// --------------------------------------------------------------------------
function loadUsers(): StoredUser[] {
  try {
    if (fs.existsSync(USERS_FILE)) return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")).users ?? [];
  } catch {
    /* unreadable - treat as no accounts */
  }
  return [];
}

export function hasAccounts(): boolean {
  return loadUsers().some((u) => !u.disabled);
}

function findUser(email: string): StoredUser | undefined {
  const wanted = email.trim().toLowerCase();
  return loadUsers().find((u) => u.email.toLowerCase() === wanted);
}

/** scrypt$N$r$p$salt$hash - the same format scripts/users.mjs writes. */
function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A fixed hash to compare against when the email is unknown, so a failed
// login takes the same time whether or not the account exists.
const DUMMY_HASH = `scrypt$16384$8$1$${crypto.randomBytes(16).toString("base64")}$${crypto.randomBytes(64).toString("base64")}`;

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------
function sessionSecret(): Buffer {
  const secret = process.env.COMPASS_SESSION_SECRET ?? "";
  if (secret.length < 32) {
    throw new AuthError(401, "Sign-in is not configured: set COMPASS_SESSION_SECRET (32+ random characters) in .env.local.");
  }
  return Buffer.from(secret, "utf-8");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function createSessionToken(user: SessionUser): { token: string; maxAge: number } {
  const stored = findUser(user.email)!;
  const maxAge = SESSION_HOURS * 3600;
  const payload = Buffer.from(
    JSON.stringify({ e: stored.email, v: stored.session_version, x: Math.floor(Date.now() / 1000) + maxAge })
  ).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, maxAge };
}

function readCookie(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The signed-in user for this request, or null. */
export function sessionUser(cookieHeader: string | null): SessionUser | null {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null; // no secret configured - nobody is signed in
  }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data: { e?: string; v?: number; x?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!data.e || !data.x || data.x < Date.now() / 1000) return null;
  const user = findUser(data.e);
  if (!user || user.disabled || user.session_version !== data.v) return null;
  return { email: user.email, name: user.name, role: user.role };
}

export function requireUser(req: Request, role: Role = "viewer"): SessionUser {
  const user = sessionUser(req.headers.get("cookie"));
  if (!user) throw new AuthError(401, "Please sign in.");
  if (role === "editor" && user.role !== "editor") {
    throw new AuthError(403, "Only knowledge base editors can do this. Ask an editor, or an administrator to change your role.");
  }
  return user;
}

export function sessionCookie(token: string, maxAge: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

// --------------------------------------------------------------------------
// Login, with attempt limiting
// --------------------------------------------------------------------------
const LOCKOUT_MS = 15 * 60 * 1000;
// Per account + address, and per account from anywhere: the address comes from
// X-Forwarded-For, which a client can fake when no proxy sits in front, so the
// per-account cap is what actually bounds password guessing.
const LIMITS = { perAddress: 5, perAccount: 20 };
const g = globalThis as unknown as { __compassLoginFailures?: Map<string, { count: number; since: number }> };
const failures = (g.__compassLoginFailures ??= new Map());

function isLocked(key: string, limit: number): boolean {
  const r = failures.get(key);
  return !!r && r.count >= limit && Date.now() - r.since < LOCKOUT_MS;
}

function recordFailure(key: string): void {
  const r = failures.get(key);
  const fresh = !r || Date.now() - r.since >= LOCKOUT_MS;
  failures.set(key, { count: fresh ? 1 : r.count + 1, since: fresh ? Date.now() : r.since });
}

export function login(email: string, password: string, ip: string): SessionUser {
  const account = email.trim().toLowerCase();
  const keys = { address: `${account}|${ip}`, account: `${account}|*` };
  if (isLocked(keys.address, LIMITS.perAddress) || isLocked(keys.account, LIMITS.perAccount)) {
    audit(email, "login_locked", { ip });
    throw new AuthError(429, "Too many failed attempts. Try again in 15 minutes.");
  }
  const user = findUser(email);
  const ok = verifyPassword(password, user?.password ?? DUMMY_HASH) && !!user && !user.disabled;
  if (!ok) {
    recordFailure(keys.address);
    recordFailure(keys.account);
    audit(email, "login_failed", { ip });
    throw new AuthError(401, "Incorrect email or password.");
  }
  failures.delete(keys.address);
  failures.delete(keys.account);
  audit(user.email, "login", { ip });
  return { email: user.email, name: user.name, role: user.role };
}

// --------------------------------------------------------------------------
// Audit log - who changed what, one JSON line per event.
// --------------------------------------------------------------------------
export function audit(who: string | null, action: string, detail: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: new Date().toISOString(), who, action, ...detail })}\n`, "utf-8");
  } catch (exc) {
    console.error("[audit] could not write:", exc);
  }
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
}

export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
}
