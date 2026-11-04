#!/usr/bin/env node
// Manage Compass sign-in accounts (stored in data/users.json).
//
//   npm run users -- list
//   npm run users -- add <email> <viewer|editor> [display name]
//   npm run users -- role <email> <viewer|editor>
//   npm run users -- reset <email>          (new password; signs the user out everywhere)
//   npm run users -- disable <email>        (blocks sign-in; signs the user out everywhere)
//   npm run users -- enable <email>
//   npm run users -- remove <email>
//
// viewer: Ask, Verify, Generate and see everything.
// editor: also add, remove and rebuild knowledge base documents.
// New and reset passwords are generated and shown once - pass them on privately.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const USERS = path.join(DATA, "users.json");
const AUDIT = path.join(DATA, "audit.log");
const ROLES = ["viewer", "editor"];

function load() {
  return fs.existsSync(USERS) ? JSON.parse(fs.readFileSync(USERS, "utf-8")).users ?? [] : [];
}

function save(users) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${USERS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), "utf-8");
  fs.renameSync(tmp, USERS);
}

function audit(action, detail) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(AUDIT, `${JSON.stringify({ at: new Date().toISOString(), who: "cli", action, ...detail })}\n`);
}

function newPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [command, rawEmail, arg, ...rest] = process.argv.slice(2);
const email = (rawEmail ?? "").trim().toLowerCase();
const users = load();
const user = users.find((u) => u.email === email);
const needUser = () => user ?? fail(`No account for ${email}. See: npm run users -- list`);
const needRole = (role) => (ROLES.includes(role) ? role : fail(`Role must be one of: ${ROLES.join(", ")}`));

switch (command) {
  case "list": {
    if (!users.length) console.log("No accounts yet. Create one with: npm run users -- add <email> editor");
    for (const u of users) console.log(`${u.email.padEnd(36)} ${u.role.padEnd(7)} ${u.disabled ? "DISABLED" : "active  "} ${u.name ?? ""}`);
    break;
  }
  case "add": {
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) fail("Usage: npm run users -- add <email> <viewer|editor> [display name]");
    if (user) fail(`${email} already exists. Use "role" or "reset" instead.`);
    const role = needRole(arg);
    const password = newPassword();
    // A random starting version, so cookies issued to a removed account with the same email never match.
    const session_version = crypto.randomInt(1, 2 ** 31);
    users.push({ email, name: rest.join(" ") || email, role, password: hash(password), session_version, created_at: new Date().toISOString() });
    save(users);
    audit("user_add", { email, role });
    console.log(`Created ${role} account for ${email}.\nPassword (shown once - pass it on privately): ${password}`);
    break;
  }
  case "role": {
    const u = needUser();
    u.role = needRole(arg);
    u.session_version += 1;
    save(users);
    audit("user_role", { email, role: u.role });
    console.log(`${email} is now ${u.role}. Existing sign-ins have been ended.`);
    break;
  }
  case "reset": {
    const u = needUser();
    const password = newPassword();
    u.password = hash(password);
    u.session_version += 1;
    save(users);
    audit("user_reset", { email });
    console.log(`New password for ${email} (shown once - pass it on privately): ${password}`);
    break;
  }
  case "disable":
  case "enable": {
    const u = needUser();
    u.disabled = command === "disable";
    u.session_version += 1;
    save(users);
    audit(`user_${command}`, { email });
    console.log(`${email} ${command}d.`);
    break;
  }
  case "remove": {
    needUser();
    save(users.filter((u) => u.email !== email));
    audit("user_remove", { email });
    console.log(`Removed ${email}.`);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(1, 15).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
