// Node runtime configuration, from environment variables. See
// docs/self-hosting.md for what each one does.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_DB = fileURLToPath(new URL("../data/weight-log.sqlite", import.meta.url));

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid PORT "${env.PORT}"`);
  return {
    host: env.HOST || "127.0.0.1",
    port,
    databasePath: resolve(env.DATABASE_PATH || DEFAULT_DB),
    allowRegistration: bool(env, "ALLOW_REGISTRATION", false),
    cookieSecure: bool(env, "COOKIE_SECURE", false),
    // Host names (no port) the server answers to; null = any.
    allowedHosts: list(env.ALLOWED_HOSTS),
  };
}

function bool(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  if (/^(1|true|yes)$/i.test(v)) return true;
  if (/^(0|false|no)$/i.test(v)) return false;
  throw new Error(`${name} must be true or false, not "${v}"`);
}

function list(v) {
  if (v === undefined || v.trim() === "") return null;
  return v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}
