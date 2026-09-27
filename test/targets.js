// Backends the API contract tests (api.test.js) run against. Each target
// exposes start() -> { origin, fetch(path, init), stop() }, where fetch sends a
// request to the app at `origin` over its real HTTP interface.
import { readFileSync } from "node:fs";

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

export const targets = [{ name: "worker + D1", start: startWorker }];
