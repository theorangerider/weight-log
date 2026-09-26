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
