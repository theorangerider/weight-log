// API contract tests. The same suite runs against every backend in
// targets.js, so storage implementations cannot drift apart.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildTrendSeries } from "../public/trend.js";
import { targets } from "./targets.js";

const hdoCSV = readFileSync(new URL("./fixtures/hdo-export.csv", import.meta.url), "utf8");

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

    test("create, read, update and delete entries, with comments", async () => {
      const c = await signedIn("crud@example.com");
      const list = async () => (await c("GET", "/api/weights")).data.weights;

      assert.deepEqual(await list(), []);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-02", weight: 180.26, rung: 12, flag: true })).status, 200);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-01", weight: "181", comment: "  first  " })).status, 200);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-03", weight: null, comment: "In Iceland" })).status, 200);
      assert.deepEqual(await list(), [
        { date: "2024-03-01", weight: 181, comment: "first", rung: null, flag: false },
        { date: "2024-03-02", weight: 180.26, comment: null, rung: 12, flag: true },
        { date: "2024-03-03", weight: null, comment: "In Iceland", rung: null, flag: false },
      ]);

      // update overwrites every field
      await c("PUT", "/api/weight", { date: "2024-03-01", weight: 179.5, comment: null });
      assert.deepEqual((await list())[0], { date: "2024-03-01", weight: 179.5, comment: null, rung: null, flag: false });

      // clearing both weight and comment deletes the row
      const del = await c("PUT", "/api/weight", { date: "2024-03-03", weight: "", comment: "" });
      assert.deepEqual(del.data, { ok: true, deleted: true });
      assert.deepEqual((await list()).map((e) => e.date), ["2024-03-01", "2024-03-02"]);

      // validation
      assert.equal((await c("PUT", "/api/weight", { date: "2024-3-1", weight: 100 })).status, 400);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-04", weight: 1501 })).status, 400);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-04", weight: -1 })).status, 400);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-04", comment: "x".repeat(4097) })).status, 400);
      assert.equal((await c("PUT", "/api/weight", { date: "2024-03-04", rung: 49 })).status, 400);
      assert.equal((await list()).length, 2);
    });

    test("users only see their own entries", async () => {
      const a = await signedIn("alice@example.com");
      const b = await signedIn("bob@example.com");
      await a("PUT", "/api/weight", { date: "2024-01-01", weight: 150 });
      assert.deepEqual((await b("GET", "/api/weights")).data.weights, []);
      await b("PUT", "/api/weight", { date: "2024-01-01", weight: 200 });
      assert.equal((await a("GET", "/api/weights")).data.weights[0].weight, 150);
    });

    test("Hacker's Diet Online CSV import", async () => {
      const c = await signedIn("hdo@example.com");
      await c("PUT", "/api/weight", { date: "2023-01-05", weight: 999, comment: "to be overwritten" });
      const r = await c("POST", "/api/import", { csv: hdoCSV });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.data, { ok: true, imported: 51, skipped: 8, plan: false });

      const byDate = new Map((await c("GET", "/api/weights")).data.weights.map((e) => [e.date, e]));
      assert.equal(byDate.size, 51);
      assert.deepEqual(byDate.get("2023-01-01"), { date: "2023-01-01", weight: 185, comment: null, rung: 12, flag: false });
      assert.equal(byDate.has("2023-01-04"), false, "blank HDO day is skipped");
      assert.deepEqual(byDate.get("2023-01-13"), { date: "2023-01-13", weight: null, comment: "Travel day, no scale", rung: null, flag: false });
      const pizza = byDate.get("2023-01-21");
      assert.deepEqual([pizza.comment, pizza.rung, pizza.flag], ['Pizza night, "big" slices', 14, true]);
      assert.notEqual(byDate.get("2023-01-05").weight, 999, "import overwrites existing dates");
      assert.equal(byDate.get("2023-01-05").comment, null);
      assert.ok(byDate.has("2023-02-28"), "second month block is read");

      assert.equal((await c("POST", "/api/import", { csv: "Date,Weight\nnothing here\n" })).status, 400);
      assert.equal((await c("POST", "/api/import", { nope: true })).status, 400);
    });

    test("CSV export, and export -> import round trip", async () => {
      const c = await signedIn("export@example.com");
      await c("PUT", "/api/weight", { date: "2024-05-01", weight: 200 });
      await c("PUT", "/api/weight", { date: "2024-05-03", weight: 190, comment: 'said "hi", then left' });
      await c("PUT", "/api/weight", { date: "2024-05-04", weight: null, comment: "multi\nline" });

      const r = await c("GET", "/api/export.csv");
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("Content-Type"), "text/csv; charset=utf-8");
      assert.match(r.headers.get("Content-Disposition"), /attachment; filename="weight-log.csv"/);
      const entries = (await c("GET", "/api/weights")).data.weights;
      const trend = buildTrendSeries(entries, "2024-05-04");
      assert.equal(
        r.text,
        [
          "Date,Weight (lb),Trend (lb),Rung,Flag,Comment",
          `2024-05-01,200,${trend.get("2024-05-01").toFixed(2)},,0,`,
          `2024-05-03,190,${trend.get("2024-05-03").toFixed(2)},,0,"said ""hi"", then left"`,
          `2024-05-04,,${trend.get("2024-05-04").toFixed(2)},,0,"multi\nline"`,
          "",
        ].join("\r\n")
      );
      assert.equal(trend.get("2024-05-03"), 199);

      // Re-import our own export into a fresh account. (Comments containing
      // newlines are split by the line-based importer; everything else
      // round-trips.)
      const d = await signedIn("reimport@example.com");
      const imp = await d("POST", "/api/import", { csv: r.text });
      assert.equal(imp.data.imported, 3);
      const again = (await d("GET", "/api/weights")).data.weights;
      assert.deepEqual(again.slice(0, 2), entries.slice(0, 2));
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
