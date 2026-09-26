// Admin commands for a self-hosted database (uses DATABASE_PATH like the server):
//
//   node server/cli.js create-user EMAIL [lb|kg]   add an account (prompts for password)
//   node server/cli.js reset-password EMAIL        set a new password, sign out everywhere
//   node server/cli.js list-users
//   node server/cli.js export-csv EMAIL > file.csv same CSV as the Export button
//   node server/cli.js backup DIR                  consistent SQLite snapshot + CSV per user
//
// Passwords are read from the terminal, or from WEIGHT_LOG_PASSWORD / stdin
// when not interactive. Where possible commands go through the Worker's own
// API code (register, export) so the results are identical to the web app.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { D1Database } from "./d1-sqlite.js";
import { createSession, setPassword, sha256Hex } from "./auth.js";
import "./server.js"; // installs the crypto.subtle.timingSafeEqual shim

const log = (msg) => process.stderr.write(msg + "\n");
const [command, ...args] = process.argv.slice(2);
const commands = { "create-user": createUser, "reset-password": resetPassword, "list-users": listUsers, "export-csv": exportCSV, backup };

if (!commands[command]) {
  log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 8).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(command ? 1 : 0);
}

const config = loadConfig();
let sqlite;
try {
  sqlite = openDatabase(config.databasePath, { create: command === "create-user", log });
  await commands[command](...args);
} catch (err) {
  log(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  sqlite?.close();
}

async function callWorker(path, init = {}) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, init), { DB: new D1Database(sqlite) }, {});
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res;
}

async function createUser(email, unit = "lb") {
  if (!email) throw new Error("usage: create-user EMAIL [lb|kg]");
  const password = await readPassword();
  const res = await callWorker("/api/register", { method: "POST", body: JSON.stringify({ email, password, unit }) });
  const me = await res.json();
  // Registration signs the new account in; this CLI has no use for that session.
  const token = res.headers.getSetCookie()[0]?.match(/^session=([^;]+)/)?.[1];
  if (token) sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
  log(`Created ${me.email} (${me.unit})`);
}

async function resetPassword(email) {
  if (!email) throw new Error("usage: reset-password EMAIL");
  email = email.trim().toLowerCase();
  if (!sqlite.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new Error(`No account for ${email}`);
  const password = await readPassword();
  if (password.length < 8) throw new Error("Password must be at least 8 characters");
  setPassword(sqlite, email, password);
  log(`Password updated for ${email}; existing sessions signed out`);
}

function listUsers() {
  for (const u of sqlite.prepare(
    "SELECT email, unit, created_at, (SELECT count(*) FROM weights w WHERE w.user_id = u.id) AS entries FROM users u ORDER BY id"
  ).all()) {
    console.log(`${u.email}\t${u.unit}\t${u.entries} entries\tcreated ${u.created_at}`);
  }
}

async function csvFor(email) {
  const user = sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email.trim().toLowerCase());
  if (!user) throw new Error(`No account for ${email}`);
  const token = createSession(sqlite, user.id, 60000);
  try {
    return await (await callWorker("/api/export.csv", { headers: { Cookie: `session=${token}` } })).text();
  } finally {
    sqlite.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
  }
}

async function exportCSV(email) {
  if (!email) throw new Error("usage: export-csv EMAIL");
  process.stdout.write(await csvFor(email));
}

async function backup(dir) {
  if (!dir) throw new Error("usage: backup DIR");
  const dest = join(dir, new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dest, { recursive: true });
  const file = join(dest, "weight-log.sqlite");
  // VACUUM INTO writes a transactionally consistent copy even while the
  // server is running, and refuses to overwrite an existing file.
  sqlite.prepare("VACUUM INTO ?").run(file);
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get().integrity_check;
    if (check !== "ok") throw new Error(`Snapshot failed integrity check: ${check}`);
  } finally {
    copy.close();
  }
  for (const { email } of sqlite.prepare("SELECT email FROM users ORDER BY id").all()) {
    writeFileSync(join(dest, `${email.replace(/[^a-z0-9@._+-]/gi, "_")}.csv`), await csvFor(email));
  }
  console.log(dest);
}

async function readPassword() {
  if (process.env.WEIGHT_LOG_PASSWORD) return process.env.WEIGHT_LOG_PASSWORD;
  if (!process.stdin.isTTY) {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    return input.split(/\r?\n/)[0];
  }
  const first = await promptHidden("Password: ");
  if (first !== (await promptHidden("Repeat password: "))) throw new Error("Passwords do not match");
  return first;
}

function promptHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const { stdin } = process;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chars) => {
      for (const ch of chars) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        } else if (ch === "\u0003") {
          done();
          return reject(new Error("Cancelled"));
        } else if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}
