import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

// Security probe suite: runs the live-mode server against a minimal mock
// Jellyfin and attacks it the way an outside caller would.
const upstream = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (url(req).pathname === "/Users/AuthenticateByName") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { Username } = JSON.parse(body);
    return res.end(
      JSON.stringify({
        User: { Id: Username, Name: Username },
        AccessToken: `token-${Username}`,
      }),
    );
  }
  res.writeHead(404);
  res.end("{}");
});
function url(req) {
  return new URL(req.url, "http://localhost");
}
await new Promise((resolve) => upstream.listen(18743, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: "18742",
    DEMO_MODE: "false",
    COOKIE_SECURE: "false",
    JELLYFIN_URL: "http://127.0.0.1:18743",
    SONARR_URL: "http://127.0.0.1:18743",
    SONARR_API_KEY: "topsecret-marker",
    RADARR_URL: "http://127.0.0.1:9",
    RADARR_API_KEY: "topsecret-marker",
    SEERR_URL: "http://127.0.0.1:18743",
    SEERR_API_KEY: "topsecret-marker",
  },
  stdio: "ignore",
});
const base = "http://127.0.0.1:18742";
const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json", ...headers },
    body,
  });
async function login() {
  const response = await post(
    "/api/login",
    JSON.stringify({ username: "probe", password: "mock-password" }),
  );
  return response.headers.get("set-cookie").split(";")[0];
}
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/config`)).ok) break;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await test("auth bypass: every media and mutation route rejects anonymous clients", async () => {
    const gets = [
      "/api/seerr/details/movie/1",
      "/api/seerr/popular",
      "/api/weather-settings",
      "/api/calendar-image/id",
      "/api/me",
      "/api/recent",
      "/api/calendar?start=2026-10-01&end=2026-10-02",
      "/api/weather",
      "/api/seerr/search?query=x",
      "/api/seerr/image?path=/abc.jpg",
      "/api/seerr/requests",
      "/api/image/abc",
    ];
    for (const path of gets)
      assert.equal((await fetch(`${base}${path}`)).status, 401, path);
    assert.equal((await post("/api/logout", "{}")).status, 401);
    assert.equal(
      (await post("/api/seerr/request", '{"mediaType":"movie","mediaId":1}'))
        .status,
      401,
    );
    assert.equal(
      (await post("/api/test-connection", '{"service":"radarr"}')).status,
      401,
    );
  });

  await test("session forgery and fixation are rejected", async () => {
    const forged = `marquee_session=${"a".repeat(64)}`;
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: forged } })).status,
      401,
    );
    const cookieA = await login();
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: cookieA } })).status,
      200,
    );
    // Signing in again from the same browser must retire the first session.
    const again = await post(
      "/api/login",
      JSON.stringify({ username: "probe", password: "mock-password" }),
      { Cookie: cookieA },
    );
    const cookieB = again.headers.get("set-cookie").split(";")[0];
    assert.notEqual(cookieA, cookieB);
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: cookieA } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: cookieB } })).status,
      200,
    );
  });

  await test("CSRF: writes from foreign or missing origins are blocked", async () => {
    const cookie = await login();
    assert.equal(
      (
        await fetch(`${base}/api/logout`, {
          method: "POST",
          headers: {
            Origin: "https://evil.example",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/seerr/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: '{"mediaType":"movie","mediaId":1}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/logout`, {
          method: "POST",
          headers: {
            Origin: "http://127.0.0.1:9999",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: "{}",
        })
      ).status,
      403,
    );
  });

  await test("path traversal on image proxies is blocked", async () => {
    const cookie = await login();
    for (const path of [
      "/api/image/..%2F..%2Fetc%2Fpasswd",
      "/api/image/%2e%2e",
      "/api/image/abc def",
      "/api/image/<script>",
    ])
      assert.equal(
        (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status,
        404,
        path,
      );
    for (const probe of ["/../secret", "/a/b.jpg", "//evil.jpg", "/abc.jpg%00"])
      assert.equal(
        (
          await fetch(
            `${base}/api/seerr/image?path=${encodeURIComponent(probe)}`,
            { headers: { Cookie: cookie } },
          )
        ).status,
        400,
        probe,
      );
  });

  await test("input abuse: oversized, malformed, and wrong-typed bodies are rejected", async () => {
    const big = JSON.stringify({ username: "x".repeat(6000), password: "y" });
    const oversized = await post("/api/login", big);
    assert.ok([400, 413].includes(oversized.status));
    assert.equal((await post("/api/login", "{not json")).status, 400);
    assert.equal(
      (await post("/api/login", '{"username":{},"password":"x"}')).status,
      400,
    );
    assert.equal(
      (
        await post(
          "/api/login",
          JSON.stringify({ username: "probe", password: "y".repeat(1001) }),
        )
      ).status,
      400,
    );
  });

  await test("secrets never leak through responses", async () => {
    const cookie = await login();
    const targets = [
      ["GET", "/api/config", null],
      ["GET", "/api/me", cookie],
      ["GET", "/api/calendar?start=2026-10-01&end=2026-10-02", cookie],
      ["GET", "/api/seerr/requests", cookie],
      ["GET", "/api/recent", cookie],
    ];
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.deepEqual(Object.keys(config).sort(), ["demo", "name"]);
    for (const [method, path, jar] of targets) {
      const text = await (
        await fetch(`${base}${path}`, {
          method,
          headers: jar ? { Cookie: jar } : {},
        })
      ).text();
      assert.equal(text.includes("topsecret-marker"), false, path);
      assert.equal(text.includes("token-probe"), false, path);
    }
  });

  await test("headers harden every route including static pages", async () => {
    for (const path of ["/", "/style.css", "/manifest.webmanifest", "/sw.js"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get("x-robots-tag"), /noindex/, path);
      assert.match(
        response.headers.get("content-security-policy"),
        /frame-ancestors 'none'/,
        path,
      );
      assert.equal(
        response.headers.get("x-content-type-options"),
        "nosniff",
        path,
      );
    }
  });

  await test("connection tests report real errors without leaking secrets", async () => {
    const cookie = await login();
    const response = await fetch(`${base}/api/test-connection`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: '{"service":"radarr"}',
    });
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /refused|not configured|connect/i);
    assert.equal(body.error.includes("topsecret-marker"), false);
  });

  await test("new endpoints reject invalid IDs, array search terms and weather markup", async () => {
    const cookie = await login();
    for (const path of [
      "/api/seerr/details/movie/0",
      "/api/seerr/details/person/1",
      "/api/seerr/details/tv/1000000001",
      "/api/seerr/details/tv/1abc",
      "/api/seerr/search?query[]=x",
      "/api/weather?latitude[]=0&longitude=0&units=celsius",
    ])
      assert.equal(
        (await fetch(`${base}${path}`, { headers: { Cookie: cookie } })).status,
        400,
        path,
      );
    assert.equal(
      (
        await post(
          "/api/weather-settings",
          JSON.stringify({
            weather: true,
            weatherUnits: "celsius",
            weatherCity: { label: "<img>", latitude: 0, longitude: 0 },
          }),
          { Cookie: cookie },
        )
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/display-name", '{"name":"Hidden"}', { Cookie: cookie }))
        .status,
      403,
    );
  });
  await test("method tampering does not reach handlers", async () => {
    const cookie = await login();
    const response = await fetch(`${base}/api/me`, {
      method: "PUT",
      headers: { Origin: base, Cookie: cookie },
    });
    assert.notEqual(response.status, 200);
  });
  await test("authenticated API floods are capped across the user's sessions", async () => {
    const cookie = await login();
    let status;
    for (let i = 0; i < 241; i++)
      status = (
        await fetch(`${base}/api/weather-settings`, {
          headers: { Cookie: cookie },
        })
      ).status;
    assert.equal(status, 429);
  });
} finally {
  server.kill();
  upstream.close();
}
