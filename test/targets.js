// Backends the API contract tests (api.test.js) run against. Each target
// exposes start() -> { origin, fetch(path, init), stop() }, where fetch sends a
// request to the app at `origin` over its real HTTP interface.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

// The Cloudflare Worker (src/index.js) on workerd with a local D1 database,
// via Miniflare (installed with wrangler).
async function startWorker() {
  const { Miniflare } = await import("miniflare");
  const wrangler = JSON.parse(readFileSync(new URL("wrangler.jsonc", root), "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const mf = new Miniflare({
    modules: true,
    modulesRoot: root.pathname,
    scriptPath: new URL(wrangler.main, root).pathname,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    d1Databases: wrangler.d1_databases.map((d) => d.binding),
  });
  const db = await mf.getD1Database("DB");
  const schema = readFileSync(new URL("schema.sql", root), "utf8").replace(/--.*$/gm, "");
  await db.batch(schema.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
  return {
    origin: "http://localhost",
    fetch: (path, init) => mf.dispatchFetch(`http://localhost${path}`, init),
    stop: () => mf.dispose(),
  };
}

// The self-hosted Node server with a fresh SQLite file, configured like the
// Worker (open registration, Secure cookies) so responses match exactly.
export async function startNode(overrides = {}) {
  const { start } = await import("../server/main.js");
  const dir = mkdtempSync(join(tmpdir(), "weight-log-test-"));
  const app = await start({
    host: "127.0.0.1",
    port: 0,
    databasePath: join(dir, "weight-log.sqlite"),
    allowRegistration: true,
    cookieSecure: true,
    allowedHosts: null,
    ...overrides,
  }, { log: () => {} });
  const origin = `http://127.0.0.1:${app.port}`;
  return {
    origin,
    dir,
    sqlite: app.sqlite,
    fetch: (path, init) => fetch(origin + path, { redirect: "manual", ...init }),
    stop: async ({ keep = false } = {}) => {
      await app.stop();
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const targets = [
  { name: "worker + D1", start: startWorker },
  { name: "node + SQLite", start: () => startNode() },
];
