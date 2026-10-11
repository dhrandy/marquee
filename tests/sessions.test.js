import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marquee-sess-"));
const base = "http://127.0.0.1:18752";
let server;
async function start(extra = {}) {
  server = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: "18752",
      DEMO_MODE: "true",
      COOKIE_SECURE: "false",
      MARQUEE_DATA_DIR: dir,
      SESSION_SECRET: "",
      ...extra,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/api/config`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
}
async function stop() {
  server.kill();
  await new Promise((r) => server.once("exit", r));
}
const login = async () => {
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: "{}",
  });
  assert.equal(res.status, 200);
  const header = res.headers.get("set-cookie");
  assert.match(header, /Max-Age=7776000;/);
  return header.split(";")[0];
};
const me = (cookie) => fetch(`${base}/api/me`, { headers: { Cookie: cookie } });

test("stateless sessions", async (t) => {
  await start();
  const cookie = await login();
  assert.equal((await me(cookie)).status, 200);

  await t.test("login survives a restart", async () => {
    await stop();
    await start();
    assert.equal((await me(cookie)).status, 200);
    assert.equal((await fetch(`${base}/api/recent`, { headers: { Cookie: cookie } })).status, 200);
  });

  await t.test("tampered cookies are rejected", async () => {
    const value = cookie.split("=")[1];
    const flipped = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
    assert.equal((await me(`marquee_session=${flipped}`)).status, 401);
    assert.equal((await me(`marquee_session=${value.slice(0, 60)}`)).status, 401);
  });

  await t.test("a different secret rejects the cookie", async () => {
    await stop();
    await start({ SESSION_SECRET: "another-secret-another-secret-123" });
    assert.equal((await me(cookie)).status, 401);
    await stop();
    await start();
    assert.equal((await me(cookie)).status, 200);
  });

  await t.test("sign out invalidates the cookie, even after a restart", async () => {
    const out = await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(out.status, 200);
    assert.equal((await me(cookie)).status, 401);
    await stop();
    await start();
    assert.equal((await me(cookie)).status, 401);
  });

  await t.test("the secret is generated once and kept", () => {
    assert.ok(fs.readFileSync(path.join(dir, "session-secret"), "utf8").length >= 32);
  });
  await stop();
});

test("expired cookies are rejected", async () => {
  const { createSessions } = await import("../src/sessions.js");
  const make = (ttl) => createSessions({ dataDir: dir, ttl });
  const req = (value) => ({ headers: { cookie: `marquee_session=${value}` } });
  assert.ok(make(60000).fromRequest(req(make(60000).seal({ id: "u" }))));
  assert.equal(make(-1).fromRequest(req(make(-1).seal({ id: "u" }))), null);
});

test("90-day sessions remain valid at 89 days and expire at 90 days", async () => {
  const { createSessions } = await import("../src/sessions.js");
  const realNow = Date.now;
  const start = realNow();
  try {
    Date.now = () => start;
    const sessions = createSessions({ dataDir: dir, ttl: 90 * 86400000 });
    const cookie = sessions.seal({ id: "long-lived" });
    const req = { headers: { cookie: `marquee_session=${cookie}` } };
    Date.now = () => start + 89 * 86400000;
    assert.equal(sessions.fromRequest(req).id, "long-lived");
    Date.now = () => start + 90 * 86400000;
    assert.equal(sessions.fromRequest(req), null);
  } finally {
    Date.now = realNow;
  }
});
