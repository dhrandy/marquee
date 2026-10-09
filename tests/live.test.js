import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const calls = [];
let maliciousArtwork = null;
const service = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  calls.push({
    path: url.pathname,
    query: url.searchParams,
    authorization: req.headers.authorization,
    apiKey: req.headers["x-api-key"],
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
        User: {
          Id: Username,
          Name: Username,
          Policy: { IsAdministrator: Username === "admin" },
        },
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
    if (user === "physical-viewer") {
      assert.equal(url.searchParams.get("ExcludeLocationTypes"), "Virtual");
      assert.equal(url.searchParams.get("IsMissing"), "false");
      assert.equal(url.searchParams.get("IsPlaceHolder"), "false");
      return res.end(
        JSON.stringify({
          Items: [
            {
              Id: "virtual-future",
              Type: "Episode",
              SeasonId: "s1",
              SeriesId: "series1",
              SeriesName: "Example show",
              ParentIndexNumber: 1,
              IndexNumber: 8,
              IsMissing: true,
              LocationType: "Virtual",
            },
            {
              Id: "physical-episode",
              Type: "Episode",
              SeasonId: "s1",
              SeriesId: "series1",
              SeriesName: "Example show",
              ParentIndexNumber: 1,
              IndexNumber: 4,
              Name: "Actual new episode",
              Overview: "Synthetic overview",
              Genres: ["Adventure"],
              Studios: [{ Name: "Example Network" }],
              OfficialRating: "TV-MA",
              RunTimeTicks: 25200000000,
              ProductionYear: 2026,
              LocationType: "FileSystem",
            },
          ],
        }),
      );
    }
    if (user === "bulk-viewer") {
      const allItems = Array.from({ length: 220 }, (_, i) => ({
        Id: `bulk-${i}`,
        SeriesId: `bulk-series-${Math.floor(i / 110)}`,
        SeasonId: `bulk-season-${Math.floor(i / 110)}`,
        SeriesName: `Imported show ${Math.floor(i / 110)}`,
        Type: "Episode",
        ParentIndexNumber: 1,
        DateCreated: "2026-10-08T10:00:00Z",
      }));
      allItems.unshift(
        ...Array.from({ length: 120 }, (_, i) => ({
          Id: `special-${i}`,
          SeriesId: "bulk-series-0",
          SeasonId: "special-season",
          SeriesName: "Imported show 0",
          Type: "Episode",
          ParentIndexNumber: 0,
          IndexNumber: i + 1,
          Name: "Official podcast",
        })),
      );
      allItems.push(
        ...Array.from({ length: 25 }, (_, i) => ({
          Id: `older-${i}`,
          Name: `Older movie ${i}`,
          Type: "Movie",
          DateCreated: "2026-10-07T10:00:00Z",
        })),
      );
      const start = Number(url.searchParams.get("StartIndex") || 0);
      const take = Number(url.searchParams.get("Limit") || 18);
      return res.end(
        JSON.stringify({
          Items: allItems.slice(start, start + take),
          TotalRecordCount: allItems.length,
        }),
      );
    }

    return res.end(
      JSON.stringify({
        Items: [
          {
            Id: "episode-1",
            SeriesId: `series-${user}`,
            SeasonId: "season-1",
            Name: "<script>alert(1)</script>",
            SeriesName: `${user} private series`,
            OfficialRating: "TV-MA",
            Type: "Episode",
            ParentIndexNumber: user === "missing-season" ? undefined : 2,
            IndexNumber: 1,
            DateCreated: "2026-10-07T10:00:00Z",
          },
          {
            Id: "episode-2",
            SeriesId: `series-${user}`,
            SeasonId: "season-1",
            Name: "Second episode",
            SeriesName: `${user} private series`,
            OfficialRating: "TV-MA",
            Type: "Episode",
            ParentIndexNumber: 2,
            IndexNumber: 2,
          },
        ],
      }),
    );
  }
  if (url.pathname === "/Users/missing-season/Items/season-1")
    return res.end(JSON.stringify({ IndexNumber: 1 }));
  if (url.pathname === "/api/v3/calendar" && maliciousArtwork)
    return res.end(
      JSON.stringify([
        {
          id: 1,
          series: {
            id: 17,
            title: "Synthetic show",
            monitored: true,
            images: [{ coverType: "fanart", remoteUrl: maliciousArtwork }],
          },
          title: "Pilot",
          seasonNumber: 1,
          episodeNumber: 1,
          airDateUtc: "2026-10-07T20:00:00Z",
          hasFile: true,
          monitored: true,
        },
      ]),
    );
  if (url.pathname === "/api/v3/calendar")
    return res.end(
      JSON.stringify([
        {
          id: 1,
          series: {
            id: 17,
            title: "Demo show",
            monitored: true,
            images: [
              { coverType: "poster", url: "/MediaCover/17/poster.jpg" },
              {
                coverType: "fanart",
                url: "/MediaCover/17/fanart.jpg?lastWrite=123",
                remoteUrl: "https://artworks.thetvdb.com/missing.jpg",
              },
            ],
          },
          title: "Pilot",
          seasonNumber: 1,
          episodeNumber: 1,
          airDateUtc: "2026-10-07T20:00:00Z",
          hasFile: true,
          monitored: true,
        },
      ]),
    );
  if (
    ["/MediaCover/17/fanart.jpg", "/MediaCover/17/poster.jpg"].includes(
      url.pathname,
    )
  ) {
    assert.equal(req.headers["x-api-key"], "mock-key");
    res.setHeader("Content-Type", "image/png");
    return res.end(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (url.pathname === "/api/v1/user")
    return res.end(
      JSON.stringify({
        pageInfo: { results: 3 },
        results: [
          { id: 4, jellyfinUserId: "alice", permissions: 32 },
          { id: 5, jellyfinUserId: "bob", permissions: 262144 },
          { id: 6, jellyfinUserId: "tvonly", permissions: 524288 },
        ],
      }),
    );
  if (/^\/api\/v1\/user\/\d+\/quota$/.test(url.pathname))
    return res.end(
      JSON.stringify({
        movie: { restricted: req.headers["x-api-user"] === "5" },
        tv: { restricted: false },
      }),
    );
  if (
    ["/api/v1/discover/movies", "/api/v1/discover/tv"].includes(url.pathname) &&
    !url.searchParams.has("studio")
  ) {
    assert.equal(req.headers["x-api-user"], "4");
    assert.equal(req.headers["x-api-key"], "seerr-mock");
    assert.equal(url.searchParams.get("sortBy"), "popularity.desc");
    return res.end(
      JSON.stringify({
        results: Array.from({ length: 20 }, (_, i) => ({
          id: 200 + i + Number(url.searchParams.get("page")) * 100,
          genreIds: i < 16 && url.pathname.endsWith("tv") ? [10767] : [18],
          mediaType: url.pathname.endsWith("tv") ? "tv" : "movie",
          title: `Popular ${i}`,
          name: `Popular ${i}`,
          posterPath: "/abc.jpg",
          mediaInfo: {
            status: i === 0 ? 5 : 2,
            requests: i === 0 ? [] : [{ id: 8 }],
          },
        })),
      }),
    );
  }
  if (url.pathname === "/api/v1/search" && url.searchParams.get("query") === "forbidden") {
    res.statusCode = 403;
    return res.end("{}");
  }
  if (url.pathname === "/api/v1/search" && url.searchParams.get("query") === "karla and the") {
    // Real Seerr answers 400 when spaces arrive as "+".
    if (!req.url.includes("query=karla%20and%20the&")) {
      res.statusCode = 400;
      return res.end("{}");
    }
    return res.end(JSON.stringify({ results: [] }));
  }
  if (url.pathname === "/api/v1/search" && url.searchParams.get("query") === "flaky") {
    globalThis.__flaky = (globalThis.__flaky || 0) + 1;
    if (globalThis.__flaky === 1) {
      res.statusCode = 500;
      return res.end("{}");
    }
    return res.end(JSON.stringify({ results: [] }));
  }
  if (url.pathname === "/api/v1/search/company")
    return res.end(JSON.stringify({ results: [
      { id: 420, name: "Signal Studios" },
      { id: 421, name: "Unrelated Co" },
    ] }));
  if (url.pathname === "/api/v1/search/keyword")
    return res.end(JSON.stringify({ results: [] }));
  if (url.pathname === "/api/v1/discover/movies" && url.searchParams.get("studio") === "420")
    return res.end(JSON.stringify({ results: [
      { id: 7, title: "Signal Duplicate", posterPath: "/abc.jpg", mediaInfo: { status: 5 } },
      { id: 880, title: "Franchise Film", posterPath: "/abc.jpg" },
    ] }));
  if (url.pathname === "/api/v1/person/55/combined_credits")
    return res.end(JSON.stringify({ cast: [
      { id: 900, mediaType: "movie", title: "Old Role", releaseDate: "1999-01-01", posterPath: "/abc.jpg" },
      { id: 901, mediaType: "tv", name: "New Role", firstAirDate: "2025-05-01", posterPath: "/abc.jpg" },
    ] }));
  if (url.pathname === "/api/v1/search" && url.searchParams.get("query") === "jane star")
    return res.end(JSON.stringify({ results: [{ id: 55, mediaType: "person", name: "Jane Star" }] }));
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
  if (url.pathname === "/api/v1/request" && req.method === "GET") {
    assert.equal(url.searchParams.has("requestedBy"), false);
    assert.equal(req.headers["x-api-user"], "4");
    return res.end(
      JSON.stringify({
        results: [
          {
            id: 1,
            status: 2,
            createdAt: "2026-10-06T10:00:00Z",
            type: "movie",
            requestedBy: {
              displayName: "Sample viewer",
              email: "private@example.test",
            },
            media: { mediaType: "movie", tmdbId: 9001, status: 3 },
          },
          {
            id: 2,
            status: 1,
            type: "movie",
            requestedBy: {
              displayName: "Another viewer",
              email: "other-private@example.test",
            },
            media: { mediaType: "movie", tmdbId: 9001, status: 2 },
          },
        ],
      }),
    );
  }
  if (["/api/v1/movie/9002/ratingscombined","/api/v1/tv/9003/ratings"].includes(url.pathname)) {
    assert.equal(req.headers["x-api-user"], "4");
    assert.equal(req.headers["x-api-key"], "seerr-mock");
    if (url.pathname.includes("9002")) { res.statusCode=503; return res.end(JSON.stringify({error:"ratings unavailable"})); }
    return res.end(JSON.stringify({criticsScore:81,audienceScore:72}));
  }
  if (["/api/v1/movie/9002","/api/v1/tv/9003"].includes(url.pathname)) {
    assert.equal(req.headers["x-api-user"], "4");
    return res.end(JSON.stringify({title:"Fallback Film",name:"Sample Show",status:"Returning Series",firstAirDate:"2025-02-17",originalLanguage:"en"}));
  }
  if (url.pathname === "/api/v1/movie/9001/ratingscombined") {
    assert.equal(req.headers["x-api-user"], "4");
    assert.equal(req.headers["x-api-key"], "seerr-mock");
    return res.end(JSON.stringify({rt:{criticsScore:90,audienceScore:97},imdb:{criticsScore:8}}));
  }
  if (url.pathname === "/api/v1/movie/9001") {
    assert.equal(req.headers["x-api-user"], "4");
    assert.equal(req.headers["x-api-key"], "seerr-mock");
    return res.end(
      JSON.stringify({
        title: "Requested Film",
        status:"Released", originalLanguage:"en",
        productionCountries:[{iso_3166_1:"US",name:"United States"}],
        releases: {
          results: [
            { iso_3166_1: "US", release_dates: [{ certification: "PG-13", type:3, release_date:"2026-07-31T00:00:00Z" }] },
          ],
        },
        credits: {
          cast: [
            { name: "Alex Sample", order: 0 },
            { name: "Morgan Example", order: 1 },
          ],
        },
        voteAverage: 8.4,
        voteCount: 50,
        posterPath: "/abc.jpg",
        genres: [{ name: "Drama" }],
        productionCompanies: [{ name: "Sample Studio" }],
      }),
    );
  }
  if (url.pathname === "/api/v1/tv/77")
    return res.end(
      JSON.stringify({
        seasons: [
          { seasonNumber: 0, episodeCount: 2 },
          { seasonNumber: 1, episodeCount: 10 },
          { seasonNumber: 2, episodeCount: 8 },
        ],
        mediaInfo: { seasons: [{ seasonNumber: 1, status: 5 }], requests: [] },
      }),
    );
  if (url.pathname === "/api/v1/service/radarr")
    return res.end(JSON.stringify([
      { id: 9, name: "4K", is4k: true, isDefault: false },
      { id: 3, name: "HD", is4k: false, isDefault: true, activeProfileId: 6, activeDirectory: "/movies" },
    ]));
  if (url.pathname === "/api/v1/service/radarr/3")
    return res.end(JSON.stringify({
      server: { id: 3 },
      profiles: [{ id: 5, name: "Any", extra: "x" }, { id: 6, name: "HD" }],
      rootFolders: [{ id: 1, path: "/movies", freeSpace: 100 }, { id: 2, path: "/other", freeSpace: 50 }],
    }));
  if (url.pathname === "/api/v1/request" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({
      path: "seerr-request-body",
      body: JSON.parse(body),
      apiKey: req.headers["x-api-key"],
      actor: req.headers["x-api-user"],
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
const settingsDir = await mkdtemp(join(tmpdir(), "marquee-live-test-"));
const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: "18739",
    MARQUEE_DATA_DIR: settingsDir,
    DEMO_MODE: "false",
    COOKIE_SECURE: "false",
    JELLYFIN_URL: "http://127.0.0.1:18740",
    SONARR_URL: " 127.0.0.1:18740/// ",
    SONARR_API_KEY: "mock-key",
    RADARR_URL: "",
    JELLYFIN_WEB_URL: "https://jellyfin.example.test",
    RADARR_API_KEY: "",
    SEERR_URL: "http://127.0.0.1:18740",
    SEERR_API_KEY: "seerr-mock",
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
    assert.equal(data.items[0].detail.contentRating, "TV-MA");
    assert.equal(data.items[0].title, "alice private series");
    assert.equal(
      data.items[0].subtitle,
      "Season 2 / 4 Episodes · Episode 1: <script>alert(1)</script>",
    );
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
    // The literal match, then the studio's movies (the duplicate id is dropped).
    assert.deepEqual(search.results.map((r) => r.id), [7, 880]);
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
    const refused = await fetch(`${base}/api/seerr/search?query=forbidden`, {
      headers: { Cookie: cookie },
    });
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /refused this account \(HTTP 403\)/);
    assert.equal(
      (await fetch(`${base}/api/seerr/search?query=${encodeURIComponent("  karla  and the ")}`, { headers: { Cookie: cookie } })).status,
      200,
    );
    const person = await (await fetch(`${base}/api/seerr/search?query=jane%20star`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(person.results.map((r) => r.id), [901, 900]);
    const flaky = await fetch(`${base}/api/seerr/search?query=flaky`, {
      headers: { Cookie: cookie },
    });
    assert.equal(flaky.status, 200);
    assert.ok(globalThis.__flaky >= 2);
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
    assert.equal(requests.requests[0].requestedBy, "Sample viewer");
    assert.equal(requests.requests[1].requestedBy, "Another viewer");
    assert.equal(
      JSON.stringify(requests).includes("other-private@example.test"),
      false,
    );
    assert.equal(
      JSON.stringify(requests).includes("private@example.test"),
      false,
    );
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
    assert.equal(sent.actor, "4");
    const postReq = (c, body) =>
      fetch(`${base}/api/seerr/request`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json", Cookie: c },
        body: JSON.stringify(body),
      });
    const optsUrl = `${base}/api/seerr/request-options?mediaType=`;
    const tvOpts = await (await fetch(`${optsUrl}tv&mediaId=77`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(tvOpts.seasons, [
      { number: 1, episodes: 10, status: 5 },
      { number: 2, episodes: 8, status: 0 },
    ]);
    const movieOpts = await (await fetch(`${optsUrl}movie&mediaId=7`, { headers: { Cookie: cookie } })).json();
    if (me.requestAccess.advanced) {
      assert.deepEqual(movieOpts.advanced.profiles, [{ id: 5, name: "Any" }, { id: 6, name: "HD" }]);
      assert.equal(movieOpts.advanced.serverId, 3);
      assert.equal(movieOpts.advanced.defaultProfileId, 6);
      assert.equal(movieOpts.advanced.defaultRootFolder, "/movies");
      assert.equal((await postReq(cookie, { mediaType: "movie", mediaId: 7, profileId: 99, serverId: 3 })).status, 400);
      assert.equal((await postReq(cookie, { mediaType: "movie", mediaId: 7, profileId: 5, serverId: 3, rootFolder: "/other" })).status, 200);
      const last = calls.filter((c) => c.path === "seerr-request-body").pop();
      assert.deepEqual(last.body, { mediaType: "movie", mediaId: 7, serverId: 3, profileId: 5, rootFolder: "/other" });
    } else {
      assert.equal(movieOpts.advanced, null);
      assert.equal((await postReq(cookie, { mediaType: "movie", mediaId: 7, profileId: 5 })).status, 403);
    }
    assert.equal((await postReq(cookie, { mediaType: "tv", mediaId: 77, seasons: [] })).status, 400);
    assert.equal((await postReq(cookie, { mediaType: "movie", mediaId: 7, seasons: [1] })).status, 400);
    assert.equal((await postReq(cookie, { mediaType: "tv", mediaId: 77, seasons: [2, 2] })).status, 200);
    assert.deepEqual(calls.filter((c) => c.path === "seerr-request-body").pop().body, { mediaType: "tv", mediaId: 77, seasons: [2] });
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
    const viewer = (await signin("alice")).headers
      .get("set-cookie")
      .split(";")[0];
    const admin = (await signin("admin")).headers
      .get("set-cookie")
      .split(";")[0];
    const update = (cookie, name, origin = base) =>
      fetch(`${base}/api/display-name`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
    assert.equal((await update(viewer, "Nope")).status, 403);
    assert.equal(
      (await update(admin, "Safe name", "https://evil.invalid")).status,
      403,
    );
    assert.equal((await update(admin, "<script>bad</script>")).status, 400);
    assert.equal((await update(admin, "x".repeat(41))).status, 400);
    assert.equal((await update(admin, "Movie Room")).status, 200);
    assert.equal(
      (await (await fetch(`${base}/api/config`)).json()).name,
      "Movie Room",
    );
    const stored = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(join(settingsDir, "settings.json"), "utf8"),
    );
    assert.equal(stored.name, "Movie Room");
    assert.equal((await update(admin, "Marquee")).status, 200);
    assert.equal(
      (
        await fetch(
          `${base}/api/weather?latitude=91&longitude=0&units=celsius`,
          { headers: { Cookie: viewer } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/weather?latitude=0&longitude=0&units=invalid`,
          { headers: { Cookie: viewer } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${base}/api/weather/cities?query=a`, {
          headers: { Cookie: viewer },
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(`${base}/api/weather/cities?query=city`)).status,
      401,
    );
  });

  await test("Seerr maps Jellyfin IDs and enforces media permissions, quotas, and trusted target IDs", async () => {
    const postRequest = (cookie, data) =>
      fetch(`${base}/api/seerr/request`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      });
    const cookieFor = async (name) =>
      (await signin(name)).headers.get("set-cookie").split(";")[0];
    const tv = await cookieFor("tvonly");
    const me = await (
      await fetch(`${base}/api/me`, { headers: { Cookie: tv } })
    ).json();
    assert.equal(me.requestAccess.movie, false);
    assert.equal(me.requestAccess.tv, true);
    assert.equal(
      (await postRequest(tv, { mediaType: "movie", mediaId: 11, userId: 1 }))
        .status,
      403,
    );
    assert.equal(
      (
        await postRequest(tv, {
          mediaType: "tv",
          mediaId: 12,
          userId: 1,
          ignoreQuota: true,
        })
      ).status,
      200,
    );
    const sent = calls.filter((c) => c.path === "seerr-request-body").at(-1);
    assert.deepEqual(sent.body, {
      mediaType: "tv",
      mediaId: 12,
      seasons: "all",
    });
    // The request is made AS the linked Seerr user so Seerr applies that
    // user's own approval rules; a client-supplied userId is ignored.
    assert.equal(sent.actor, "6");
    const missing = await cookieFor("unimported");
    const denied = await postRequest(missing, {
      mediaType: "movie",
      mediaId: 13,
    });
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /import your Jellyfin account/i);
  });
  await test("recent shelf fills 18 distinct cards after bulk episode imports", async () => {
    const login = await signin("bulk-viewer");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${base}/api/recent`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.items.length, 18);
    assert.deepEqual(
      data.items.slice(0, 2).map((i) => i.title),
      ["Imported show 0", "Imported show 1"],
    );
    assert.equal(data.items[2].title, "Older movie 0");
    assert.equal(data.items[17].title, "Older movie 15");
    const pages = calls.filter(
      (c) =>
        c.path === "/Items" &&
        c.query.get("UserId") === "bulk-viewer" &&
        !c.query.has("ParentId"),
    );
    assert.equal(pages.length, 4);
    for (const call of pages)
      assert.match(call.authorization, /token-bulk-viewer/);
  });
  await test("Sonarr status and calendar use the normalized API URL and key", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const result = await fetch(`${base}/api/test-connection`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ service: "sonarr" }),
    });
    assert.deepEqual(await result.json(), { ok: true });
    const statusCall = calls.find((c) => c.path === "/api/v3/system/status");
    assert.equal(statusCall.apiKey, "mock-key");
  });
  await test("recent season number falls back to Jellyfin season metadata, with episode title", async () => {
    const login = await signin("missing-season");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const data = await (
      await fetch(`${base}/api/recent`, { headers: { Cookie: cookie } })
    ).json();
    assert.match(
      data.items[0].subtitle,
      /^Season 1 \/ 4 Episodes · Episode 1:/,
    );
  });
  await test("weather preferences are account-private and saved with shared display settings", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const value = {
      weather: true,
      weatherCity: { label: "Sample City", latitude: 40, longitude: -80 },
      weatherUnits: "celsius",
    };
    const response = await fetch(`${base}/api/weather-settings`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    const secondLogin = await signin("alice");
    const second = secondLogin.headers.get("set-cookie").split(";")[0];
    assert.deepEqual(
      await (
        await fetch(`${base}/api/weather-settings`, {
          headers: { Cookie: second },
        })
      ).json(),
      value,
    );
    const other = await signin("bob");
    const otherCookie = other.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await (
          await fetch(`${base}/api/weather-settings`, {
            headers: { Cookie: otherCookie },
          })
        ).json()
      ).weather,
      false,
    );
    const disk = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(join(settingsDir, "settings.json"), "utf8"),
    );
    assert.deepEqual(disk.weatherByUser.alice, value);
  });
  await test("popular lists use linked Seerr user and return ten titles per type with availability", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${base}/api/seerr/popular`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.movies.length, 10);
    assert.equal(data.tv.length, 10);
    assert.equal(data.movies[0].availability, 5);
    assert.equal(data.tv[1].requested, true);
    assert.equal(data.tv[0].mediaType, "tv");
    assert.equal(data.tv[0].title, "Popular 16");
    assert.equal(data.tv[4].title, "Popular 16");
    assert.equal(new Set(data.tv.map((item) => item.id)).size, 10);
    assert.equal(
      (
        await fetch(`${base}/api/calendar-image/arbitrary`, {
          headers: { Cookie: cookie },
        })
      ).status,
      404,
    );
  });
  await test("calendar images use Sonarr cached covers with its server key", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const data = await (
      await fetch(`${base}/api/calendar?start=2026-10-01&end=2026-10-31`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(data.events[0].backdrop, "/api/calendar-image/tv-1");
    assert.equal(data.events[0].poster, "/api/calendar-image/tv-1-poster");
    assert.equal(
      (
        await fetch(`${base}${data.events[0].poster}`, {
          headers: { Cookie: cookie },
        })
      ).status,
      200,
    );
    const image = await fetch(`${base}${data.events[0].backdrop}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type"), /image/);
  });
  await test("recent card and deep link use the same physical episode, never missing metadata", async () => {
    const login = await signin("physical-viewer");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const data = await (
      await fetch(`${base}/api/recent`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(data.items.length, 1);
    assert.match(data.items[0].subtitle, /Episode 4: Actual new episode/);
    assert.match(data.items[0].link, /id=physical-episode$/);
    assert.equal(data.items[0].detail.overview, "Synthetic overview");
    assert.equal(data.items[0].detail.runtime, 42);
    assert.deepEqual(data.items[0].detail.genres, ["Adventure"]);
    assert.equal(data.items[0].detail.network, "Example Network");
    assert.equal(JSON.stringify(data).includes("virtual-future"), false);
  });
  await test("calendar proxy rejects forged artwork hosts and isolates image maps by session", async () => {
    const a = await signin("alice");
    const cookieA = a.headers.get("set-cookie").split(";")[0];
    const b = await signin("bob");
    const cookieB = b.headers.get("set-cookie").split(";")[0];
    for (const art of [
      "http://127.0.0.1/secret",
      "https://image.tmdb.org.evil.invalid/x.jpg",
      "https://image.tmdb.org@evil.invalid/x.jpg",
      "https://image.tmdb.org:444/x.jpg",
      "https://user:pass@image.tmdb.org/x.jpg",
      "https://evil.invalid/x.jpg",
    ]) {
      maliciousArtwork = art;
      const data = await (
        await fetch(`${base}/api/calendar?start=2026-10-01&end=2026-10-31`, {
          headers: { Cookie: cookieA },
        })
      ).json();
      assert.equal(data.events[0].backdrop, null, art);
      assert.equal(
        (
          await fetch(`${base}/api/calendar-image/tv-1`, {
            headers: { Cookie: cookieA },
          })
        ).status,
        404,
      );
    }
    maliciousArtwork = null;
    await fetch(`${base}/api/calendar?start=2026-10-01&end=2026-10-31`, {
      headers: { Cookie: cookieA },
    });
    assert.equal(
      (
        await fetch(`${base}/api/calendar-image/tv-1`, {
          headers: { Cookie: cookieB },
        })
      ).status,
      404,
    );
  });
  await test("popular details read metadata as linked user", async () => {
    const login = await signin("alice");
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const data = await (
      await fetch(`${base}/api/seerr/details/movie/9001`, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(data.title, "Requested Film");
    assert.equal(data.subtitle, "Movie");
    assert.deepEqual(data.facts.scores,{critics:90,audience:97,imdb:8,tmdb:84});
    assert.equal(data.facts.status,"Released");
    assert.equal(data.facts.originalLanguage,"en");
    assert.equal(data.facts.productionCountries[0].name,"United States");
    assert.equal(data.facts.releases[0].date,"2026-07-31");
    assert.equal(data.contentRating, "PG-13");
    assert.deepEqual(data.cast, ["Alex Sample", "Morgan Example"]);
    assert.deepEqual(data.rating, { value: 8.4, source: "TMDB" });
    assert.deepEqual(data.genres, ["Drama"]);
    assert.equal(data.network, "Sample Studio");
    assert.equal(data.backdrop, "/api/seerr/image?path=%2Fabc.jpg");
  });
  await test("optional movie ratings failure and TV ratings keep detail usable",async()=>{
    const cookie=(await signin("alice")).headers.get("set-cookie").split(";")[0];
    const get=async path=>{const response=await fetch(`${base}/api/seerr/details/${path}`,{headers:{Cookie:cookie}});assert.equal(response.status,200);return response.json();};
    const movie=await get("movie/9002");
    assert.equal(movie.title,"Fallback Film");
    assert.deepEqual(movie.facts.scores,{critics:null,audience:null,imdb:null,tmdb:null});
    const tv=await get("tv/9003");
    assert.deepEqual(tv.facts.scores,{critics:81,audience:72,imdb:null,tmdb:null});
    assert.deepEqual(tv.facts.releases,[{type:"First aired",date:"2025-02-17",region:null}]);
  });
  await test("accessibility preference is isolated by user and validates writes", async () => {
    const alice = (await signin("alice")).headers.get("set-cookie");
    const bob = (await signin("bob")).headers.get("set-cookie");
    const read = async (cookie) =>
      (
        await fetch(`${base}/api/accessibility-settings`, {
          headers: { Cookie: cookie },
        })
      ).json();
    assert.deepEqual(await read(alice), { colorblind: false });
    assert.equal(
      (
        await fetch(`${base}/api/accessibility-settings`, {
          method: "POST",
          headers: {
            Origin: base,
            Cookie: alice,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ colorblind: true }),
        })
      ).status,
      200,
    );
    assert.deepEqual(await read(alice), { colorblind: true });
    assert.deepEqual(await read(bob), { colorblind: false });
    assert.deepEqual(
      await read((await signin("alice")).headers.get("set-cookie")),
      { colorblind: true },
    );
    assert.equal(
      (
        await fetch(`${base}/api/accessibility-settings`, {
          method: "POST",
          headers: {
            Origin: base,
            Cookie: bob,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ colorblind: "true" }),
        })
      ).status,
      400,
    );
  });
  await test("bad passwords are rejected, repeated attempts are limited", async () => {
    for (let i = 0; i < 10; i++)
      assert.equal((await signin("alice", "wrong")).status, 401);
    assert.equal((await signin("alice", "wrong")).status, 429);
  });
} finally {
  server.kill();
  service.close();
  await rm(settingsDir, { recursive: true, force: true });
}
