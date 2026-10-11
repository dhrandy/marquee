import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  notificationSnapshot,
  reminderShows,
} from "../src/notification-sources.js";
let playable = true,
  viewerAllowed = true,
  failCalendar = false,
  requestedBy = 4;
const calls = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  calls.push({
    path: url.pathname,
    query: url.searchParams,
    auth: req.headers.authorization,
    user: req.headers["x-api-user"],
  });
  res.setHeader("Content-Type", "application/json");
  const answer = (value) => res.end(JSON.stringify(value));
  if (url.pathname === "/Users/alice")
    return answer({ Policy: { EnableMediaPlayback: viewerAllowed } });
  if (url.pathname === "/Users/alice/Items/show")
    return answer({
      Id: "show",
      Type: "Series",
      Name: "Example show",
      ProviderIds: { Tmdb: "7", Tvdb: "77" },
    });
  if (url.pathname === "/Users/alice/Items/movie")
    return answer({
      Id: "movie",
      Type: "Movie",
      Name: "Example movie",
      MediaSources: playable ? [{ Path: "/media/movie.mkv" }] : [],
      PlayAccess: "Full",
    });
  if (url.pathname === "/Users/alice/Items/episode")
    return answer({
      Id: "episode",
      Type: "Episode",
      MediaSources: playable ? [{ Path: "/media/episode.mkv" }] : [],
      PlayAccess: "Full",
    });
  if (url.pathname === "/Users/alice/Items") {
    const type = url.searchParams.get("IncludeItemTypes");
    if (type === "Series")
      return answer({
        Items: [
          {
            Id: "show",
            Type: "Series",
            Name: "Example show",
            ProviderIds: { Tmdb: "7", Tvdb: "77" },
          },
        ],
        TotalRecordCount: 1,
      });
    if (type === "Movie")
      return answer({
        Items: [
          {
            Id: "movie",
            Type: "Movie",
            Name: "Example movie",
            ProviderIds: { Tmdb: "10" },
          },
        ],
      });
    return answer({
      Items: [
        {
          Id: "episode",
          Type: "Episode",
          ParentIndexNumber: 1,
          IndexNumber: 2,
        },
        {
          Id: "missing",
          Type: "Episode",
          LocationType: "Virtual",
          IsMissing: true,
        },
      ],
    });
  }
  if (url.pathname === "/api/v3/calendar") {
    if (failCalendar) {
      res.writeHead(403);
      return answer({});
    }
    return answer([
      {
        id: 1,
        series: { title: "Example show", tvdbId: 77 },
        airDateUtc: new Date().toISOString(),
      },
      {
        id: 2,
        series: { title: "Other show", tvdbId: 88 },
        airDateUtc: new Date().toISOString(),
      },
    ]);
  }
  if (url.pathname === "/api/v1/user")
    return answer({
      results: [{ id: 4, jellyfinUserId: "alice", permissions: 32 }],
    });
  if (url.pathname === "/api/v1/user/4/quota")
    return answer({ movie: { restricted: false }, tv: { restricted: false } });
  if (url.pathname === "/api/v1/request")
    return answer({
      results: [
        {
          id: 20,
          requestedBy: { id: requestedBy },
          type: "movie",
          media: { tmdbId: 10, status: 5 },
        },
      ],
    });
  if (url.pathname === "/api/v1/movie/10")
    return answer({ title: "Example movie" });
  res.writeHead(404);
  answer({});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
for (const service of ["JELLYFIN", "SONARR", "SEERR"]) {
  process.env[`${service}_URL`] = base;
  process.env[`${service}_API_KEY`] = "mock-key";
}
const user = { id: "alice", token: "alice-token", deviceId: "alice-device" };
const prefs = {
  requests: true,
  timezone: "America/New_York",
  shows: [{ id: "show", airs: true, available: true }],
};
test("notification adapters verify viewer access, media sources, request ownership and provider IDs", async () => {
  try {
    const shows = await reminderShows(user, "Example");
    assert.equal(shows[0].id, "show");
    let result = await notificationSnapshot(user, prefs);
    assert.equal(result.episodes.length, 1);
    assert.equal(result.airings.length, 1);
    assert.equal(result.requests.length, 1);
    assert.equal(result.episodes[0].subtitle, "S1E2");
    for (const call of calls.filter((call) => call.path.startsWith("/Users/")))
      assert.match(call.auth, /alice-token/);
    assert.equal(
      calls
        .find((call) => call.path === "/api/v1/request")
        .query.get("requestedBy"),
      "4",
    );
    requestedBy = 8;
    result = await notificationSnapshot(user, prefs);
    assert.equal(result.requests.length, 0);
    requestedBy = 4;
    playable = false;
    result = await notificationSnapshot(user, prefs);
    assert.equal(result.requests.length, 0);
    assert.equal(result.episodes.length, 0);
    playable = true;
    viewerAllowed = false;
    await assert.rejects(notificationSnapshot(user, prefs), /not permitted/);
    viewerAllowed = true;
    failCalendar = true;
    await assert.rejects(notificationSnapshot(user, prefs), /HTTP 403/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
