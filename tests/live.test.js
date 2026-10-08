import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const calls = [];
const service = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  calls.push({
    path: url.pathname,
    query: url.searchParams,
    authorization: req.headers.authorization,
  });
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/Users/AuthenticateByName") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { Username, Pw } = JSON.parse(body);
    if (Pw !== "mock-password") {
      res.writeHead(401);
      return res.end("{}");
    }
    return res.end(
      JSON.stringify({
        User: { Id: Username, Name: Username, Policy: { IsAdministrator: Username === "admin" } },
        AccessToken: `token-${Username}`,
      }),
    );
  }
  if (url.pathname === "/Items") {
    const user = url.searchParams.get("UserId");
    if (!req.headers.authorization?.includes(`token-${user}`)) {
      res.writeHead(403);
      return res.end("{}");
    }
    if (url.searchParams.has("ParentId"))
      return res.end(JSON.stringify({ TotalRecordCount: 4 }));
    return res.end(
      JSON.stringify({
        Items: [
          {
            Id: "episode-1",
            SeriesId: `series-${user}`,
            SeasonId: "season-1",
            Name: "<script>alert(1)</script>",
            SeriesName: `${user} private series`,
            Type: "Episode",
            ParentIndexNumber: 2,
            IndexNumber: 1,
            DateCreated: "2026-10-07T10:00:00Z",
          },
          {
            Id: "episode-2",
            SeriesId: `series-${user}`,
            SeasonId: "season-1",
            Name: "Second episode",
            SeriesName: `${user} private series`,
            Type: "Episode",
            ParentIndexNumber: 2,
            IndexNumber: 2,
          },
        ],
      }),
    );
  }
  if (url.pathname === "/api/v3/calendar")
    return res.end(
      JSON.stringify([
        {
          id: 1,
          series: { title: "Demo show", monitored: true },
          title: "Pilot",
          seasonNumber: 1,
          episodeNumber: 1,
          airDateUtc: "2026-10-07T20:00:00Z",
          hasFile: true,
          monitored: true,
        },
      ]),
    );
  if (url.pathname === "/api/v1/search")
    return res.end(
      JSON.stringify({
        results: [
          {
            id: 7,
            mediaType: "movie",
            title: "<b>Signal</b>",
            releaseDate: "2026-01-01",
            posterPath: "/abc.jpg",
            overview: "ok",
            mediaInfo: { status: 1 },
          },
          { id: 8, mediaType: "person", name: "Someone" },
        ],
      }),
    );
  if (url.pathname === "/api/v1/request" && req.method === "GET")
    return res.end(
      JSON.stringify({
        results: [
          {
            id: 1,
            status: 2,
            createdAt: "2026-10-06T10:00:00Z",
            media: { mediaType: "movie", title: "Requested Film", status: 3 },
          },
        ],
      }),
    );
  if (url.pathname === "/api/v1/request" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      path: "seerr-request-body",
      body: JSON.parse(body),
      apiKey: req.headers["x-api-key"],
    });
    return res.end(JSON.stringify({ id: 1, status: 1 }));
  }
  if (url.pathname === "/System/Info/Public")
    return res.end(JSON.stringify({ Version: "10.10.0" }));
  if (url.pathname === "/api/v3/system/status")
    return res.end(JSON.stringify({ version: "4.0.0" }));
  if (url.pathname === "/api/v1/status")
    return res.end(JSON.stringify({ version: "2.0.0" }));
  if (url.pathname === "/t/p/w342/abc.jpg") {
    res.setHeader("Content-Type", "image/png");
    return res.end(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  res.writeHead(404);
  res.end("{}");
});
await new Promise((resolve) => service.listen(18740, "127.0.0.1", resolve));
const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: "18739",
    MARQUEE_DATA_DIR: "/tmp/marquee-live-test-settings",
    DEMO_MODE: "false",
    COOKIE_SECURE: "false",
    JELLYFIN_URL: "http://127.0.0.1:18740",
    SONARR_URL: "http://127.0.0.1:18740",
    SONARR_API_KEY: "mock-key",
    RADARR_URL: "",
    JELLYFIN_WEB_URL: "https://jellyfin.example.test",
    RADARR_API_KEY: "",
    SEERR_URL: "http://127.0.0.1:18740",
    SEERR_API_KEY: "seerr-mock",
    SEERR_REQUEST_ALLOWLIST: "alice",
    TMDB_IMAGE_BASE: "http://127.0.0.1:18740",
  },
  stdio: "ignore",
});
const base = "http://127.0.0.1:18739";
async function signin(username, password = "mock-password") {
  return fetch(`${base}/api/login`, {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
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
  await test("live adapters preserve user identity and season counts without exposing credentials", async () => {
    const first = await signin("alice");
    assert.equal(first.status, 200);
    const cookie = first.headers.get("set-cookie").split(";")[0];
    const result = await fetch(`${base}/api/recent`, {
      headers: { Cookie: cookie },
    });
    const text = await result.text();
    const data = JSON.parse(text);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].title, "alice private series");
    assert.equal(data.items[0].subtitle, "Season 2 / 4 Episodes");
    assert.match(
      data.items[0].link,
      /^https:\/\/jellyfin\.example\.test\/web\/index\.html#!\/details\?id=episode-1/,
    );
    assert.equal(text.includes("token-alice"), false);
    assert.equal(text.includes("mock-key"), false);
    const second = await signin("bob");
    const cookie2 = second.headers.get("set-cookie").split(";")[0];
    const bob = await (
      await fetch(`${base}/api/recent`, { headers: { Cookie: cookie2 } })
    ).json();
    assert.equal(bob.items[0].title, "bob private series");
    const calendar = await (
      await fetch(`${base}/api/calendar?start=2026-10-01&end=2026-11-01`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(calendar.events[0].title, "Demo show");
    assert.equal(calendar.events[0].status, "available");
    assert.equal(calendar.events[0].monitored, true);
    assert.equal(calendar.warnings.length, 1);
    assert.equal(
      (
        await fetch(`${base}/api/image/series-bob`, {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${base}/api/calendar?start=invalid&end=bad`, {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    await fetch(`${base}/api/logout`, {
      method: "POST",
      headers: {
        Origin: base,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/api/me`, { headers: { Cookie: cookie2 } })).status,
      200,
    );
  });
  await test("seerr search, request allowlist, image proxy, and requests list", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const me = await (
      await fetch(`${base}/api/me`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(me.canRequest, true);
    const search = await (
      await fetch(`${base}/api/seerr/search?query=signal`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].title, "<b>Signal</b>");
    assert.equal(search.results[0].poster, "/abc.jpg");
    assert.equal(
      (
        await fetch(`${base}/api/seerr/search?query=${"x".repeat(121)}`, {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/seerr/search?query=ok&page=0`, {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    const img = await fetch(
      `${base}/api/seerr/image?path=${encodeURIComponent("/abc.jpg")}`,
      { headers: { Cookie: cookie } },
    );
    assert.equal(img.status, 200);
    assert.match(img.headers.get("content-type"), /image\/png/);
    assert.equal(
      (
        await fetch(
          `${base}/api/seerr/image?path=${encodeURIComponent("/../secret")}`,
          { headers: { Cookie: cookie } },
        )
      ).status,
      400,
    );
    const requests = await (
      await fetch(`${base}/api/seerr/requests`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(requests.requests[0].title, "Requested Film");
    assert.equal(requests.requests[0].status, 2);
    const req = await fetch(`${base}/api/seerr/request`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ mediaType: "movie", mediaId: 7 }),
    });
    assert.equal(req.status, 200);
    const sent = calls.find((c) => c.path === "seerr-request-body");
    assert.deepEqual(sent.body, { mediaType: "movie", mediaId: 7 });
    assert.equal(sent.apiKey, "seerr-mock");
    const bobLogin = await signin("bob");
    const bobCookie = bobLogin.headers.get("set-cookie").split(";")[0];
    const bobMe = await (
      await fetch(`${base}/api/me`, { headers: { Cookie: bobCookie } })
    ).json();
    assert.equal(bobMe.canRequest, false);
    const bobReq = await fetch(`${base}/api/seerr/request`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: bobCookie,
      },
      body: JSON.stringify({ mediaType: "movie", mediaId: 7 }),
    });
    assert.equal(bobReq.status, 403);
    const bad = await fetch(`${base}/api/seerr/request`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ mediaType: "movie", mediaId: "7" }),
    });
    assert.equal(bad.status, 400);
    const badType = await fetch(`${base}/api/seerr/request`, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({ mediaType: "person", mediaId: 7 }),
    });
    assert.equal(badType.status, 400);
    const post = (body) =>
      fetch(`${base}/api/test-connection`, {
        method: "POST",
        headers: {
          Origin: base,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      }).then((r) => ({ status: r.status, body: r.json() }));
    const jellyfin = await post({ service: "jellyfin" });
    assert.deepEqual(await jellyfin.body, { ok: true });
    const sonarr = await post({ service: "sonarr" });
    assert.deepEqual(await sonarr.body, { ok: true });
    const seerr = await post({ service: "seerr" });
    assert.deepEqual(await seerr.body, { ok: true });
    const radarr = await post({ service: "radarr" });
    const radarrBody = await radarr.body;
    assert.equal(radarrBody.ok, false);
    assert.match(radarrBody.error, /not configured/i);
    assert.equal((await post({ service: "nope" })).status, 400);
  });
  await test("only Jellyfin administrators can save the shared display name", async () => {
    const viewer = (await signin("alice")).headers.get("set-cookie").split(";")[0];
    const admin = (await signin("admin")).headers.get("set-cookie").split(";")[0];
    const update = (cookie, name, origin = base) => fetch(`${base}/api/display-name`, { method: "POST", headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    assert.equal((await update(viewer, "Nope")).status, 403);
    assert.equal((await update(admin, "Safe name", "https://evil.invalid")).status, 403);
    assert.equal((await update(admin, "<script>bad</script>")).status, 400);
    assert.equal((await update(admin, "x".repeat(41))).status, 400);
    assert.equal((await update(admin, "Movie Room")).status, 200);
    assert.equal((await (await fetch(`${base}/api/config`)).json()).name, "Movie Room");
    const stored = JSON.parse(await (await import("node:fs/promises")).readFile("/tmp/marquee-live-test-settings/settings.json", "utf8"));
    assert.equal(stored.name, "Movie Room");
    assert.equal((await update(admin, "Marquee")).status, 200);
    assert.equal((await fetch(`${base}/api/weather?latitude=91&longitude=0&units=celsius`, { headers: { Cookie: viewer } })).status, 400);
    assert.equal((await fetch(`${base}/api/weather?latitude=0&longitude=0&units=invalid`, { headers: { Cookie: viewer } })).status, 400);
    assert.equal((await fetch(`${base}/api/weather/cities?query=a`, { headers: { Cookie: viewer } })).status, 400);
    assert.equal((await fetch(`${base}/api/weather/cities?query=city`)).status, 401);
  });

  await test("bad passwords are rejected, repeated attempts are limited", async () => {
    for (let i = 0; i < 10; i++)
      assert.equal((await signin("alice", "wrong")).status, 401);
    assert.equal((await signin("alice", "wrong")).status, 429);
  });

} finally {
  server.kill();
  service.close();
}
