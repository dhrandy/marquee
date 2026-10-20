import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApiTokens, tokenAllowed } from "../src/api-tokens.js";

test("token route rules", () => {
  assert.equal(tokenAllowed("read", "GET", "/api/recent"), true);
  assert.equal(tokenAllowed("read", "GET", "/api/seerr/search"), true);
  for (const p of ["/api/history", "/api/libraries", "/api/libraries/demo-movies/items", "/api/weather", "/api/weather/cities", "/api/calendar"])
    assert.equal(tokenAllowed("read", "GET", p), true, p);
  assert.equal(tokenAllowed("read", "GET", "/api/libraries/demo-movies"), false);
  assert.equal(tokenAllowed("read", "POST", "/api/seerr/request"), false);
  assert.equal(tokenAllowed("request", "POST", "/api/seerr/request"), true);
  for (const p of ["/api/display-preferences", "/api/section-order", "/api/weather-settings", "/api/accessibility-settings", "/api/notifications", "/api/tokens", "/api/login", "/api/logout", "/api/test-connection"]) {
    assert.equal(tokenAllowed("request", "GET", p), false, p);
    assert.equal(tokenAllowed("request", "POST", p), false, p);
  }
  assert.equal(tokenAllowed("request", "DELETE", "/api/tokens/abc"), false);
});

test("token lifecycle on a demo server", async () => {
  const port = 18739 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marquee-tok-"));
  const child = spawn("node", ["src/server.js"], { env: { ...process.env, DEMO_MODE: "true", COOKIE_SECURE: "false", PORT: String(port), MARQUEE_DATA_DIR: dir }, stdio: "ignore" });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/config"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const post = (url, body, headers = {}) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
    const login = await post("/api/login", { username: "x", password: "y" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const c = { Cookie: cookie };
    // Off by default.
    assert.equal((await post("/api/tokens", { name: "a", scope: "read", password: "x" }, c)).status, 403);
    assert.equal((await post("/api/tokens/enabled", { enabled: true }, c)).status, 200);
    assert.equal((await post("/api/tokens", { name: "", scope: "read", password: "x" }, c)).status, 400);
    assert.equal((await post("/api/tokens", { name: "a", scope: "admin", password: "x" }, c)).status, 400);
    const made = await (await post("/api/tokens", { name: "Assistant", scope: "read", password: "x" }, c)).json();
    assert.match(made.token, /^mq_[A-Za-z0-9_-]{43}$/);
    const list = await (await fetch(base + "/api/tokens", { headers: c })).json();
    assert.equal(list.tokens.length, 1);
    assert.equal(JSON.stringify(list).includes(made.token), false);
    const bearer = { Authorization: "Bearer " + made.token };
    assert.equal((await fetch(base + "/api/me", { headers: bearer })).status, 200);
    assert.equal((await fetch(base + "/api/recent", { headers: bearer })).status, 200);
    // Never reaches settings, tokens or notifications.
    for (const p of ["/api/tokens", "/api/display-preferences", "/api/notifications", "/api/weather-settings", "/api/accessibility-settings"])
      assert.equal((await fetch(base + p, { headers: bearer })).status, 403, p);
    assert.equal((await fetch(base + "/api/docs", { headers: bearer })).status, 200);
    // Jellyfin user data reads work with a bearer token in demo mode.
    const history = await (await fetch(base + "/api/history?limit=2", { headers: bearer })).json();
    assert.equal(history.items.length, 2);
    assert.ok(history.items[0].lastPlayed);
    assert.equal((await fetch(base + "/api/history?limit=101", { headers: bearer })).status, 400);
    const libs = await (await fetch(base + "/api/libraries", { headers: bearer })).json();
    assert.ok(libs.libraries.length > 0);
    const browse = await (await fetch(base + "/api/libraries/" + libs.libraries[0].id + "/items", { headers: bearer })).json();
    assert.ok(Array.isArray(browse.items));
    assert.equal(typeof browse.total, "number");
    assert.equal((await fetch(base + "/api/libraries/not-a-library/items", { headers: bearer })).status, 404);
    assert.equal((await fetch(base + "/api/libraries/demo-movies/items?played=maybe", { headers: bearer })).status, 400);
    assert.equal((await fetch(base + "/api/libraries/demo-movies/items?played=maybe", { headers: bearer })).status, 400);
    // Search and filter options validate.
    assert.equal((await fetch(base + "/api/libraries/demo-movies/items?genres=Drama&years=2026&sort=added&order=desc", { headers: bearer })).status, 200);
    for (const bad of ["years=26", "years=2026,abc", "sort=evil", "order=sideways", "genres=" + "x".repeat(301)])
      assert.equal((await fetch(base + "/api/libraries/demo-movies/items?" + bad, { headers: bearer })).status, 400, bad);
    // Calendar works with a token, with a valid range required.
    assert.equal((await fetch(base + "/api/calendar?start=2026-10-01&end=2026-10-08", { headers: bearer })).status, 200);
    assert.equal((await fetch(base + "/api/calendar", { headers: bearer })).status, 400);
    assert.equal((await fetch(base + "/api/weather?latitude=35.2&longitude=-80.8&units=fahrenheit", { headers: bearer })).status, 200);
    assert.equal((await fetch(base + "/api/weather/cities?query=charlotte", { headers: bearer })).status, 200);
    // Read-only token cannot request, and POST needs no Origin for bearer.
    const noOrigin = { "Content-Type": "application/json", ...bearer };
    const req = { mediaType: "movie", mediaId: 603 };
    assert.equal((await fetch(base + "/api/seerr/request", { method: "POST", headers: noOrigin, body: JSON.stringify(req) })).status, 403);
    assert.equal((await fetch(base + "/api/tokens", { method: "POST", headers: noOrigin, body: JSON.stringify({ name: "x", scope: "read", password: "x" }) })).status, 403);
    // A token plus a valid cookie still counts as the token only.
    assert.equal((await fetch(base + "/api/tokens", { headers: { ...bearer, ...c } })).status, 403);
    // Bad token.
    assert.equal((await fetch(base + "/api/me", { headers: { Authorization: "Bearer mq_" + "a".repeat(43) } })).status, 401);
    assert.equal((await fetch(base + "/api/me", { headers: { Authorization: "Bearer nope" } })).status, 401);
    // Request-scope token can request.
    const rq = await (await post("/api/tokens", { name: "Req", scope: "request", password: "x" }, c)).json();
    const ok = await fetch(base + "/api/seerr/request", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + rq.token }, body: JSON.stringify(req) });
    assert.equal(ok.status, 200);
    // Revoke.
    assert.equal((await fetch(base + "/api/tokens/" + made.id, { method: "DELETE", headers: { Origin: base, ...c } })).status, 200);
    assert.equal((await fetch(base + "/api/me", { headers: bearer })).status, 401);
    // Turning the feature off stops the remaining token.
    assert.equal((await post("/api/tokens/enabled", { enabled: false }, c)).status, 200);
    assert.equal((await fetch(base + "/api/me", { headers: { Authorization: "Bearer " + rq.token } })).status, 401);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("storage holds a hash and encrypted login, and dies without the key", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marquee-tokstore-"));
  try {
    const store = createApiTokens({ dataDir: dir });
    const user = { id: "u1", name: "Viewer", token: "jellyfin-secret-value", deviceId: "marquee-dev", isAdmin: false };
    const made = store.create({ user, name: "T", scope: "read" });
    const raw = fs.readFileSync(path.join(dir, "api-tokens.json"), "utf8");
    assert.equal(raw.includes(made.token), false);
    assert.equal(raw.includes("jellyfin-secret-value"), false);
    assert.equal(store.find(made.token).user.token, "jellyfin-secret-value");
    // Restart keeps it; a new session secret (deleted key) kills it.
    assert.ok(createApiTokens({ dataDir: dir }).find(made.token));
    fs.rmSync(path.join(dir, "session-secret"));
    assert.equal(createApiTokens({ dataDir: dir }).find(made.token), null);
    assert.throws(() => { const s = createApiTokens({ dataDir: dir }); for (let i = 0; i < 11; i++) s.create({ user, name: "n" + i, scope: "read" }); }, /up to 10/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every registered route is denied to tokens unless allowlisted, and abuse limits hold", async () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const routes = [...src.matchAll(/app\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g)].map(m => [m[1].toUpperCase(), m[2].replace(/:[A-Za-z]+/g, "1")]);
  assert.ok(routes.length > 30);
  const port = 19300 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marquee-tok2-"));
  let log = "";
  const child = spawn("node", ["src/server.js"], { env: { ...process.env, DEMO_MODE: "true", COOKIE_SECURE: "false", PORT: String(port), MARQUEE_DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", d => log += d); child.stderr.on("data", d => log += d);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + "/api/config"); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const post = (url, body, headers = {}) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, ...headers }, body: JSON.stringify(body) });
    const c = { Cookie: (await post("/api/login", {})).headers.get("set-cookie").split(";")[0] };
    await post("/api/tokens/enabled", { enabled: true }, c);
    const made = await (await post("/api/tokens", { name: "Scan", scope: "request", password: "x" }, c)).json();
    const auth = { Authorization: "Bearer " + made.token, "Content-Type": "application/json" };
    for (const [method, route] of routes) {
      if (route === "/api/config") continue;
      const allowed = tokenAllowed("request", method, route.replace("/api/seerr/details/1/1", "/api/seerr/details/movie/1"));
      const res = await fetch(base + route, { method, headers: auth, body: method === "GET" ? undefined : "{}" });
      if (!allowed) assert.equal(res.status, 403, `${method} ${route} must be denied to tokens`);
    }
    // Invented future routes and odd spellings are denied by default.
    for (const route of ["/api/admin", "/api/me/", "/API/display-preferences", "/api/seerr/request/extra"])
      assert.notEqual((await fetch(base + route, { headers: auth })).status, 200, route);
    // Write limit: 10 a minute per token.
    const req = JSON.stringify({ mediaType: "movie", mediaId: 603 });
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await fetch(base + "/api/seerr/request", { method: "POST", headers: auth, body: req })).status);
    assert.equal(codes[0], 200);
    assert.equal(codes.at(-1), 429);
    assert.ok(codes.filter(code => code === 200).length <= 10);
    // Invalid tokens are throttled.
    let last = 0;
    for (let i = 0; i < 35; i++) last = (await fetch(base + "/api/me", { headers: { Authorization: "Bearer mq_" + String(i).padStart(43, "b") } })).status;
    assert.equal(last, 429);
    // The token never appears in logs or in the token list.
    assert.equal(log.includes(made.token), false);
    // Turning the feature off removes every token, even after turning it back on.
    await post("/api/tokens/enabled", { enabled: false }, c);
    await post("/api/tokens/enabled", { enabled: true }, c);
    assert.equal((await (await fetch(base + "/api/tokens", { headers: c })).json()).tokens.length, 0);
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("token files are private", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marquee-tokperm-"));
  try {
    const store = createApiTokens({ dataDir: dir });
    store.create({ user: { id: "u", name: "V", token: "t", deviceId: "d" }, name: "T", scope: "read" });
    assert.equal(fs.statSync(path.join(dir, "api-tokens.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "session-secret")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o077, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
