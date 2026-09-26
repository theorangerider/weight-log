// Opens the self-hosted SQLite database and brings its schema up to date.
//
// Schema versioning uses SQLite's PRAGMA user_version, and reuses upstream's
// files instead of keeping a second copy of the schema:
//   - schema.sql is the complete current schema (upstream keeps it in sync
//     with migrations/, as the Cloudflare deployment also relies on).
//   - migrations/NNN-name.sql are one-way upgrades; the schema version is the
//     highest NNN (minimum 1).
// A brand-new, empty file gets schema.sql and the current version. An older
// database gets each newer migration applied in one transaction, after a
// snapshot is written next to it. Anything unexpected — a non-empty database
// we did not create, or a version newer than this code — is refused rather
// than modified.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transaction } from "./d1-sqlite.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function openDatabase(path, {
  create = true,
  schemaPath = join(ROOT, "schema.sql"),
  migrationsDir = join(ROOT, "migrations"),
  log = console.log,
} = {}) {
  if (!existsSync(path)) {
    if (!create) throw new Error(`Database ${path} does not exist`);
    mkdirSync(dirname(path), { recursive: true });
    log(`Creating new database at ${path}`);
  }
  let db;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    const uid = process.getuid?.();
    throw new Error(`Cannot open ${path}: ${err.message}. Check that ${dirname(path)} exists and is writable` +
      (uid === undefined ? "" : ` by uid ${uid}`) + ".");
  }
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const mode = db.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    if (mode !== "wal") throw new Error(`Could not enable WAL mode (got ${mode}); is ${dirname(path)} on a local filesystem?`);
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, path, { schemaPath, migrationsDir, log });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function listMigrations(migrationsDir) {
  if (!existsSync(migrationsDir)) return [];
  return readdirSync(migrationsDir)
    .map((file) => ({ file, match: /^(\d+)-.*\.sql$/.exec(file) }))
    .filter(({ match }) => match)
    .map(({ file, match }) => ({ version: Number(match[1]), path: join(migrationsDir, file) }))
    .sort((a, b) => a.version - b.version);
}

function migrate(db, path, { schemaPath, migrationsDir, log }) {
  const migrations = listMigrations(migrationsDir);
  const latest = Math.max(1, ...migrations.map((m) => m.version));
  const current = db.prepare("PRAGMA user_version").get().user_version;

  if (current === 0) {
    const { n } = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get();
    if (n > 0) {
      throw new Error(
        `${path} is not empty but has no Weight Log schema version. ` +
        "Refusing to modify a database this app did not create."
      );
    }
    transaction(db, () => {
      db.exec(readFileSync(schemaPath, "utf8"));
      db.exec(`PRAGMA user_version = ${latest}`);
    });
    log(`Initialized schema version ${latest}`);
    return;
  }

  if (current > latest) {
    throw new Error(
      `${path} has schema version ${current}, newer than this version of the app understands (${latest}). ` +
      "Refusing to start. Run the newer app, or restore the pre-migration snapshot."
    );
  }
  if (current === latest) return;

  const pending = migrations.filter((m) => m.version > current);
  const snapshot = `${path}.pre-v${latest}-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
  log(`Migrating schema ${current} -> ${latest}; snapshot first: ${snapshot}`);
  db.prepare("VACUUM INTO ?").run(snapshot);

  // SQLite's documented procedure for schema changes: foreign keys off (so a
  // table rebuild cannot cascade deletes), one transaction, verify, re-enable.
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    transaction(db, () => {
      for (const m of pending) {
        log(`Applying ${m.path}`);
        db.exec(readFileSync(m.path, "utf8"));
      }
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) throw new Error(`Migration left ${violations.length} foreign key violation(s)`);
      db.exec(`PRAGMA user_version = ${latest}`);
    });
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
  log(`Schema is now version ${latest}`);
}
