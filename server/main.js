// Self-hosted entry point: `node server/main.js` (npm start / npm run dev:node).
import http from "node:http";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./database.js";
import { createHandler } from "./server.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/** Opens the database and starts listening. Resolves once the port is bound. */
export async function start(config, { log = console.log } = {}) {
  const sqlite = openDatabase(config.databasePath, { log });
  try {
    const server = http.createServer(createHandler({ worker, sqlite, config, publicDir: PUBLIC_DIR, log }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    const { port } = server.address();
    log(`Weight Log listening on http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`);
    log(`Database ${config.databasePath}; registration ${config.allowRegistration ? "open" : "disabled"}` +
      (config.allowedHosts ? `; allowed hosts: ${config.allowedHosts.join(", ")}` : ""));

    const stop = () => new Promise((resolve) => {
      server.close(() => {
        sqlite.close(); // checkpoints the WAL into the main file
        resolve();
      });
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 5000).unref();
    });
    return { server, port, sqlite, stop };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

if (import.meta.main) {
  let app;
  try {
    app = await start(loadConfig());
  } catch (err) {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, async () => {
      console.log(`${signal} received, shutting down`);
      await app.stop();
      process.exit(0);
    });
  }
}
