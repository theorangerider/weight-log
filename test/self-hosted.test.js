// Node + SQLite runtime specifics: database safety and migrations, the HTTP
// bridge's self-hosting options, the admin CLI and clean shutdown.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { listMigrations, openDatabase } from "../server/database.js";
import { loadConfig } from "../server/config.js";
import { startNode } from "./targets.js";

const quiet = { log: () => {} };
// The schema version a fresh database gets: the highest upstream migration.
const LATEST = Math.max(1, ...listMigrations(fileURLToPath(new URL("../migrations", import.meta.url))).map((m) => m.version));
const tmp = () => mkdtempSync(join(tmpdir(), "weight-log-test-"));
const run = promisify(execFile);
const cli = (dbPath, args, env = {}) =>
  run(process.execPath, ["server/cli.js", ...args], { env: { ...process.env, DATABASE_PATH: dbPath, ...env } });

// For the migration tests: a small, fixed schema at version 1 with its own
// migrations directory, so upstream schema changes can't affect them.
function versionOneDatabase() {
  const dir = tmp();
  const schemaPath = join(dir, "schema.sql");
  writeFileSync(schemaPath, `
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'lb',
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE weights (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL, weight REAL, comment TEXT, PRIMARY KEY (user_id, date));`);
  const migrationsDir = join(dir, "migrations");
  mkdirSync(migrationsDir);
  // Already part of the schema above, so it must never run.
  writeFileSync(join(migrationsDir, "001-comments.sql"), "SELECT RAISE(ABORT, 'must not re-run');");
  const path = join(dir, "weight-log.sqlite");
  const options = { ...quiet, schemaPath, migrationsDir };
  const db = openDatabase(path, options);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
  return { dir, path, migrationsDir, options, db };
}

async function register(app, email = "me@example.com", password = "correct horse") {
  return app.fetch("/api/register", { method: "POST", body: JSON.stringify({ email, password }) });
}

describe("database", () => {
  test("a new database gets the schema, WAL and foreign keys, and keeps data across reopen", () => {
    const dir = tmp();
    const path = join(dir, "sub", "weight-log.sqlite");
    let db = openDatabase(path, quiet);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST);
    assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    db.prepare("INSERT INTO users (email, password_hash, salt) VALUES ('a@b.co', 'x', 'y')").run();
    db.prepare("INSERT INTO weights (user_id, date, weight) VALUES (1, '2024-01-01', 180)").run();
    assert.throws(() => db.prepare("INSERT INTO weights (user_id, date, weight) VALUES (99, '2024-01-01', 1)").run(), /FOREIGN KEY/);
    db.close();

    db = openDatabase(path, quiet);
    assert.deepEqual({ ...db.prepare("SELECT date, weight FROM weights").get() }, { date: "2024-01-01", weight: 180 });
    db.close();
    rmSync(dir, { recursive: true });
  });

  test("explains an unwritable data directory", { skip: process.getuid?.() === 0 && "root ignores permissions" }, () => {
    const dir = tmp();
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => openDatabase(join(dir, "weight-log.sqlite"), quiet), /Cannot open .*writable by uid/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("refuses a missing file when create is false", () => {
    assert.throws(() => openDatabase(join(tmp(), "nope.sqlite"), { ...quiet, create: false }), /does not exist/);
  });

  test("refuses to touch a non-empty database it did not create", () => {
    const path = join(tmp(), "other.sqlite");
    const other = new DatabaseSync(path);
    other.exec("CREATE TABLE precious (x); INSERT INTO precious VALUES (42)");
    other.close();
    assert.throws(() => openDatabase(path, quiet), /Refusing to modify/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT x FROM precious").get().x, 42);
    assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'users'").get().n, 0);
    check.close();
  });

  test("refuses a database from a newer app version", () => {
    const path = join(tmp(), "newer.sqlite");
    openDatabase(path, quiet).close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    assert.throws(() => openDatabase(path, quiet), /newer than this version/);
  });

  test("applies pending migrations once, after a snapshot, preserving data", () => {
    const { dir, path, migrationsDir, options, db } = versionOneDatabase();
    db.prepare("INSERT INTO users (email, password_hash, salt) VALUES ('a@b.co', 'x', 'y')").run();
    db.prepare("INSERT INTO weights (user_id, date, weight, comment) VALUES (1, '2024-01-01', 180, 'hi')").run();
    db.close();

    // A future upstream migration: rebuild the parent table (the dangerous
    // case — with foreign keys on, DROP TABLE users would cascade-delete
    // every weight).
    writeFileSync(join(migrationsDir, "002-rebuild-users.sql"), `
      CREATE TABLE users_new (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'lb',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), nickname TEXT);
      INSERT INTO users_new (id, email, password_hash, salt, unit, created_at)
        SELECT id, email, password_hash, salt, unit, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;`);

    const migrated = openDatabase(path, options);
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(migrated.prepare("SELECT comment FROM weights").get().comment, "hi", "weights survived the users rebuild");
    assert.equal(migrated.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    migrated.close();

    const snapshots = readdirSync(dir).filter((f) => f.includes(".pre-v2-"));
    assert.equal(snapshots.length, 1);
    const snap = new DatabaseSync(join(dir, snapshots[0]));
    assert.equal(snap.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(snap.prepare("SELECT weight FROM weights").get().weight, 180);
    snap.close();

    openDatabase(path, options).close(); // idempotent: nothing pending
    assert.equal(readdirSync(dir).filter((f) => f.includes(".pre-v")).length, 1);
  });

  test("a failing migration is rolled back and the app refuses to start", () => {
    const { path, migrationsDir, options, db } = versionOneDatabase();
    db.prepare("INSERT INTO users (email, password_hash, salt) VALUES ('a@b.co', 'x', 'y')").run();
    db.close();
    writeFileSync(join(migrationsDir, "002-broken.sql"), "DROP TABLE weights; SELECT no_such_function();");

    assert.throws(() => openDatabase(path, options), /no such function/);
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("PRAGMA user_version").get().user_version, 1);
    assert.equal(check.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'weights'").get().n, 1);
    check.close();
  });
});

describe("HTTP server", () => {
  test("health, static files and 404s", async () => {
    const app = await startNode();
    try {
      assert.deepEqual(await (await app.fetch("/healthz")).json(), { ok: true });
      const index = await app.fetch("/");
      assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(await index.text(), /<title>Weight Log<\/title>/);
      const js = await app.fetch("/app.js?v=3");
      assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
      assert.equal(await js.text(), readFileSync(new URL("../public/app.js", import.meta.url), "utf8"));
      assert.equal((await app.fetch("/%2e%2e/package.json")).status, 404);
      assert.equal((await app.fetch("/nope.html")).status, 404);
    } finally {
      await app.stop();
    }
  });

  test("registration is off unless enabled; Secure is dropped on plain http", async () => {
    const app = await startNode({ allowRegistration: false, cookieSecure: false });
    try {
      const r = await register(app);
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: "Registration is disabled on this server" });
    } finally {
      await app.stop();
    }
    const open = await startNode({ cookieSecure: false });
    try {
      const r = await register(open);
      assert.equal(r.status, 200);
      assert.doesNotMatch(r.headers.get("set-cookie"), /Secure/);
      assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    } finally {
      await open.stop();
    }
  });

  test("ALLOWED_HOSTS rejects other Host headers (except /healthz)", async () => {
    const app = await startNode({ allowedHosts: ["nas.example.ts.net"] });
    try {
      assert.equal((await app.fetch("/")).status, 403);
      assert.equal((await app.fetch("/healthz")).status, 200);
      const { request } = await import("node:http");
      const status = await new Promise((resolve, reject) => {
        request(`${app.origin}/`, { headers: { Host: "nas.example.ts.net:8080" } }, (res) => resolve(res.statusCode))
          .on("error", reject).end();
      });
      assert.equal(status, 200);
    } finally {
      await app.stop();
    }
  });

  test("oversized request bodies are rejected", async () => {
    const app = await startNode();
    try {
      const r = await app.fetch("/api/import", { method: "POST", body: "x".repeat(9 * 1024 * 1024) });
      assert.equal(r.status, 413);
    } finally {
      await app.stop();
    }
  });
});

describe("CLI", () => {
  test("create-user, list-users, reset-password, export-csv, backup", async () => {
    const dir = tmp();
    const dbPath = join(dir, "weight-log.sqlite");
    await cli(dbPath, ["create-user", "Me@Example.com", "kg"], { WEIGHT_LOG_PASSWORD: "first password" });
    await assert.rejects(cli(dbPath, ["create-user", "me@example.com"], { WEIGHT_LOG_PASSWORD: "first password" }), /already exists/);
    await assert.rejects(cli(dbPath, ["create-user", "x@example.com"], { WEIGHT_LOG_PASSWORD: "short" }), /at least 8/);

    const app = await startNode({ databasePath: dbPath, allowRegistration: false });
    try {
      const login = async (password) =>
        app.fetch("/api/login", { method: "POST", body: JSON.stringify({ email: "me@example.com", password }) });
      const r = await login("first password");
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { email: "me@example.com", unit: "kg" });
      const cookie = r.headers.get("set-cookie").split(";")[0];
      const put = (date, weight, comment) =>
        app.fetch("/api/weight", { method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ date, weight, comment }) });
      await put("2024-02-01", 80.5, "start, \"quoted\"");
      await put("2024-02-03", 80.1);

      assert.match((await cli(dbPath, ["list-users"])).stdout, /^me@example\.com\tkg\t2 entries\t/);

      // CLI export is byte-identical to the web app's export.
      const web = await (await app.fetch("/api/export.csv", { headers: { Cookie: cookie } })).text();
      assert.equal((await cli(dbPath, ["export-csv", "me@example.com"])).stdout, web);

      // Backup while the server is running: consistent snapshot + CSV.
      const { stdout } = await cli(dbPath, ["backup", join(dir, "backups")]);
      const dest = stdout.trim();
      assert.deepEqual(readdirSync(dest).sort(), ["me@example.com.csv", "weight-log.sqlite"]);
      assert.equal(readFileSync(join(dest, "me@example.com.csv"), "utf8"), web);
      const snap = new DatabaseSync(join(dest, "weight-log.sqlite"), { readOnly: true });
      assert.equal(snap.prepare("SELECT count(*) n FROM weights").get().n, 2);
      assert.equal(snap.prepare("PRAGMA user_version").get().user_version, LATEST);
      snap.close();

      await cli(dbPath, ["reset-password", "me@example.com"], { WEIGHT_LOG_PASSWORD: "second password" });
      assert.equal((await app.fetch("/api/me", { headers: { Cookie: cookie } })).status, 401, "sessions revoked");
      assert.equal((await login("first password")).status, 401);
      assert.equal((await login("second password")).status, 200);
    } finally {
      await app.stop();
    }
    await assert.rejects(cli(join(dir, "missing.sqlite"), ["list-users"]), /does not exist/);
  });
});

describe("process", () => {
  test("SIGTERM shuts down cleanly and leaves a fully checkpointed database", async () => {
    const dir = tmp();
    const dbPath = join(dir, "weight-log.sqlite");
    const child = spawn(process.execPath, ["server/main.js"], {
      env: { ...process.env, PORT: "0", DATABASE_PATH: dbPath, ALLOW_REGISTRATION: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    while (!/listening on (\S+)/.test(out)) {
      if (child.exitCode !== null) throw new Error(out);
      await new Promise((r) => setTimeout(r, 20));
    }
    const base = /listening on (\S+)/.exec(out)[1];
    const reg = await fetch(`${base}/api/register`, { method: "POST", body: JSON.stringify({ email: "a@b.co", password: "correct horse" }) });
    const Cookie = reg.headers.get("set-cookie").split(";")[0];
    await fetch(`${base}/api/weight`, { method: "PUT", headers: { Cookie }, body: JSON.stringify({ date: "2024-01-01", weight: 150 }) });
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0, out);
    assert.match(out, /SIGTERM received/);
    assert.equal(existsSync(`${dbPath}-wal`), false, "WAL checkpointed and removed on close");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare("SELECT weight FROM weights").get().weight, 150);
    db.close();
  });

  test("config parsing", () => {
    assert.deepEqual(
      (({ host, port, allowRegistration, cookieSecure, allowedHosts }) => ({ host, port, allowRegistration, cookieSecure, allowedHosts }))(loadConfig({})),
      { host: "127.0.0.1", port: 8080, allowRegistration: false, cookieSecure: false, allowedHosts: null }
    );
    assert.deepEqual(loadConfig({ ALLOWED_HOSTS: " NAS.example.ts.net, 100.64.0.1 " }).allowedHosts, ["nas.example.ts.net", "100.64.0.1"]);
    assert.throws(() => loadConfig({ ALLOW_REGISTRATION: "maybe" }), /true or false/);
    assert.throws(() => loadConfig({ PORT: "http" }), /Invalid PORT/);
  });
});

