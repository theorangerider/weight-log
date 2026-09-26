// Node HTTP front end for the unchanged Worker in src/index.js. It plays the
// part Cloudflare plays in production: serves public/ as static assets, turns
// everything else into a Web Request for worker.fetch(request, env), and
// supplies env.DB as a D1-compatible wrapper around SQLite.
//
// Self-hosting-only behavior lives here, not in the Worker:
//   /healthz, ALLOWED_HOSTS, ALLOW_REGISTRATION, COOKIE_SECURE, AUTH=none.
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { D1Database } from "./d1-sqlite.js";
import { createSession, sessionIsValid } from "./auth.js";

// src/index.js uses crypto.subtle.timingSafeEqual, a Cloudflare Workers
// extension; Node has the same primitive in node:crypto.
crypto.subtle.timingSafeEqual ??= (a, b) => timingSafeEqual(a, b);

const MAX_BODY = 8 * 1024 * 1024; // the Worker itself rejects imports > 4 MB
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function createHandler({ worker, sqlite, config, publicDir, owner = null, log = console.log }) {
  const env = { DB: new D1Database(sqlite) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  let ownerToken = null;

  return async function handle(req, res) {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/healthz") {
        sqlite.prepare("SELECT 1").get();
        return sendJSON(res, 200, { ok: true });
      }

      const host = req.headers.host || "localhost";
      let base;
      try { base = new URL(`http://${host}`); } catch { return sendJSON(res, 400, { error: "Bad Host header" }); }
      if (config.allowedHosts && !config.allowedHosts.includes(base.hostname)) {
        return sendJSON(res, 403, { error: `Host ${base.hostname} is not in ALLOWED_HOSTS` });
      }

      if ((req.method === "GET" || req.method === "HEAD") && !path.startsWith("/api/")) {
        if (await serveStatic(publicDir, path, req, res)) return;
      }
      if (path === "/api/register" && !config.allowRegistration) {
        return sendJSON(res, 403, { error: "Registration is disabled on this server" });
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      if (owner) {
        // Single-user mode: every request is signed in as the owner.
        if (!ownerToken || !sessionIsValid(sqlite, ownerToken)) ownerToken = createSession(sqlite, owner.id);
        headers.set("cookie", `session=${ownerToken}`);
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(new URL(req.url, base), { method: req.method, headers, body });
      await sendResponse(req, res, await worker.fetch(request, env, ctx), { config, owner });
    } catch (err) {
      if (err.status === 413) return sendJSON(res, 413, { error: "Request too large" });
      log(JSON.stringify({ event: "server_error", url: req.url, message: err.message }));
      if (!res.headersSent) sendJSON(res, 500, { error: "Internal error" });
      else res.destroy();
    }
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function sendResponse(req, res, response, { config, owner }) {
  const headers = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  let cookies = response.headers.getSetCookie();
  // Browsers drop Secure cookies on plain-http origins other than localhost,
  // so over http://nas:8080 sign-in would silently fail. Keep Secure only when
  // served over HTTPS (e.g. behind `tailscale serve`).
  if (!config.cookieSecure) cookies = cookies.map((c) => c.replace(/;\s*Secure(?=;|$)/i, ""));
  if (owner) cookies = [];
  if (cookies.length) headers["set-cookie"] = cookies;

  const body = Buffer.from(await response.arrayBuffer());
  headers["content-length"] = body.length;
  res.writeHead(response.status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

async function serveStatic(publicDir, path, req, res) {
  let rel;
  try { rel = decodeURIComponent(path); } catch { return false; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(publicDir, rel));
  if (!file.startsWith(publicDir + sep)) return false;
  let data;
  try { data = await readFile(file); } catch { return false; }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "content-length": data.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : data);
  return true;
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
