// Account/session helpers for the Node runtime and CLI. These write the same
// rows, in the same formats, as src/index.js (PBKDF2-SHA256 100k with a
// per-user hex salt; sessions keyed by SHA-256 of the cookie token), and the
// tests log in through the Worker code to prove it.
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

const PBKDF2_ITERATIONS = 100000;
const SESSION_DAYS = 180;

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

export function hashPassword(password, saltHex) {
  return pbkdf2Sync(password, Buffer.from(saltHex, "hex"), PBKDF2_ITERATIONS, 32, "sha256").toString("hex");
}

export function setPassword(sqlite, email, password) {
  const salt = randomBytes(16).toString("hex");
  const { changes } = sqlite
    .prepare("UPDATE users SET password_hash = ?, salt = ? WHERE email = ?")
    .run(hashPassword(password, salt), salt, email);
  if (changes === 0) throw new Error(`No account for ${email}`);
  // Sign out everywhere, as a password change should.
  sqlite.prepare("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").run(email);
}

/** Inserts a session row and returns the raw token for the cookie. */
export function createSession(sqlite, userId, ms = SESSION_DAYS * 86400000) {
  const token = randomBytes(32).toString("hex");
  sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(sha256Hex(token), userId, Date.now() + ms);
  return token;
}

export function sessionIsValid(sqlite, token) {
  return !!sqlite.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?").get(sha256Hex(token), Date.now());
}

/**
 * Single-user mode: the one account everything belongs to. An empty database
 * gets an account for `email` with no usable password (set one later with
 * `cli.js reset-password` to switch to normal sign-in). A database with one
 * account uses it whatever its email; more than one is refused rather than
 * guessing whose data to show.
 */
export function ensureOwner(sqlite, email, log = console.log) {
  const users = sqlite.prepare("SELECT id, email FROM users ORDER BY id LIMIT 2").all();
  if (users.length > 1) {
    throw new Error("AUTH=none needs a database with a single account, but this one has several. Use AUTH=accounts.");
  }
  if (users.length === 1) return { id: users[0].id, email: users[0].email };
  // "!" can never match a 64-hex-digit PBKDF2 hash, so password login is off.
  const { id } = sqlite
    .prepare("INSERT INTO users (email, password_hash, salt) VALUES (?, '!', ?) RETURNING id")
    .get(email, randomBytes(16).toString("hex"));
  log(`Created single-user account ${email}`);
  return { id, email };
}
