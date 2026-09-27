// API contract tests. The same suite runs against every backend in
// targets.js, so storage implementations cannot drift apart.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { targets } from "./targets.js";

for (const target of targets) {
  describe(target.name, () => {
    let app;
    before(async () => { app = await target.start(); });
    after(async () => { await app?.stop(); });

    // Small client: JSON in/out, remembers the session cookie per "browser".
    function client() {
      let cookie = null;
      const c = async (method, path, body, headers = {}) => {
        const res = await app.fetch(path, {
          method,
          headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...(cookie && { Cookie: cookie }), ...headers },
          body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        });
        const setCookie = res.headers.get("Set-Cookie");
        if (setCookie) {
          const [pair] = setCookie.split(";");
          cookie = pair.endsWith("=") ? null : pair;
        }
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch {}
        return { status: res.status, headers: res.headers, text, data, setCookie };
      };
      c.cookie = () => cookie;
      return c;
    }

    const pick = (e, ...keys) => e && Object.fromEntries(keys.map((k) => [k, e[k]]));

    async function signedIn(email) {
      const c = client();
      const r = await c("POST", "/api/register", { email, password: "correct horse", unit: "lb" });
      assert.equal(r.status, 200, r.text);
      return c;
    }

    test("unauthenticated requests are rejected", async () => {
      const c = client();
      assert.equal((await c("GET", "/api/me")).status, 401);
      assert.equal((await c("GET", "/api/weights")).status, 401);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-01-01", weight: 100 })).status, 401);
      assert.equal((await c("GET", "/api/export.csv")).status, 401);
    });

    test("register validates input and rejects duplicates", async () => {
      const c = client();
      assert.equal((await c("POST", "/api/register", { email: "nope", password: "correct horse" })).status, 400);
      assert.equal((await c("POST", "/api/register", { email: "short@example.com", password: "1234567" })).status, 400);
      const ok = await c("POST", "/api/register", { email: " Reg@Example.com ", password: "correct horse", unit: "kg" });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.data, { email: "reg@example.com", unit: "kg" });
      assert.match(ok.setCookie, /^session=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=15552000$/);
      assert.equal((await client()("POST", "/api/register", { email: "reg@example.com", password: "another pass" })).status, 409);
    });

    test("login, session, logout", async () => {
      await signedIn("login@example.com");
      const c = client();
      assert.equal((await c("POST", "/api/login", { email: "login@example.com", password: "wrong password" })).status, 401);
      assert.equal((await c("POST", "/api/login", { email: "nobody@example.com", password: "correct horse" })).status, 401);
      const ok = await c("POST", "/api/login", { email: "LOGIN@example.com", password: "correct horse" });
      assert.equal(ok.status, 200);
      assert.deepEqual(pick((await c("GET", "/api/me")).data, "email", "unit"), { email: "login@example.com", unit: "lb" });

      const stale = c.cookie();
      const out = await c("POST", "/api/logout");
      assert.equal(out.status, 200);
      assert.match(out.setCookie, /Max-Age=0/);
      const r = await app.fetch("/api/me", { headers: { Cookie: stale } });
      assert.equal(r.status, 401, "logged-out session token no longer works");
    });

    test("unit settings; changing the log unit converts every weight at once", async () => {
      const c = await signedIn("unit@example.com");
      assert.equal((await c("PUT", "/api/settings", { displayUnit: "stone" })).status, 400);
      const shown = await c("PUT", "/api/settings", { displayUnit: "kg" });
      assert.deepEqual(pick(shown.data, "displayUnit", "logUnit", "unit"), { displayUnit: "kg", logUnit: "lb", unit: "lb" });

      await c("PUT", "/api/weight", { date: "2024-01-01", weight: 100 });
      await c("PUT", "/api/weight", { date: "2024-01-02", weight: 200, comment: "kept" });
      // One batch converts all stored weights; it must apply fully or not at all.
      const kg = await c("PUT", "/api/settings", { logUnit: "kg" });
      assert.deepEqual(pick(kg.data, "logUnit", "unit"), { logUnit: "kg", unit: "kg" });
      const inKg = (await c("GET", "/api/weights")).data.weights;
      assert.deepEqual(inKg.map((e) => e.weight), [45.359237, 90.718474]);
      assert.equal(inKg[1].comment, "kept");
      await c("PUT", "/api/settings", { logUnit: "lb" });
      assert.deepEqual((await c("GET", "/api/weights")).data.weights.map((e) => e.weight), [100, 200]);
    });

    test("cross-origin writes are rejected, same-origin allowed", async () => {
      const c = await signedIn("origin@example.com");
      const evil = await c("PUT", "/api/weight", { date: "2024-01-01", weight: 1 }, { Origin: "https://evil.example" });
      assert.equal(evil.status, 403);
      const ok = await c("PUT", "/api/weight", { date: "2024-01-01", weight: 100 }, { Origin: app.origin });
      assert.equal(ok.status, 200);
      assert.equal((await c("GET", "/api/weights")).data.weights.length, 1);
    });
  });
}
