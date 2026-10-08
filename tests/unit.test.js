import { serviceUrl, upstream } from "../src/adapters.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  episodeStatus,
  movieStatus,
  normalizeEpisodes,
  normalizeMovies,
  validateRange,
  normalizeSeerrResults,
  normalizeSeerrRequests,
} from "../src/model.js";
const now = new Date("2026-10-07T12:00:00Z");
test("TV states distinguish files, aired missing, and future episodes", () => {
  assert.equal(episodeStatus({ hasFile: true }, now), "available");
  assert.equal(episodeStatus({ airDateUtc: "2026-10-06" }, now), "missing");
  assert.equal(episodeStatus({ airDateUtc: "2026-10-08" }, now), "upcoming");
});
test("movie states use selected release date, not cinema availability", () => {
  assert.equal(movieStatus({ hasFile: true }, "2026-10-08", now), "available");
  assert.equal(movieStatus({}, "2026-10-08", now), "unreleased");
  assert.equal(movieStatus({}, "2026-10-06", now), "missing");
});
test("normalization keeps episode data and splits cinema from digital releases", () => {
  assert.equal(
    normalizeEpisodes([
      {
        id: 1,
        series: { title: "Sample" },
        title: "Pilot",
        seasonNumber: 2,
        episodeNumber: 3,
        airDateUtc: "2026-10-06",
      },
    ])[0].subtitle,
    "S02E03 · Pilot",
  );
  const movies = normalizeMovies(
    [
      {
        id: 1,
        title: "Sample film",
        studio: "Sample Studio",
        inCinemas: "2026-10-01",
        digitalRelease: "2026-10-09",
        monitored: true,
      },
    ],
    now,
  );
  assert.equal(movies.length, 2);
  assert.equal(movies[0].subtitle, "Sample Studio · In cinemas");
  assert.equal(movies[0].status, "cinema");
  assert.equal(movies[1].subtitle, "Sample Studio · Digital release");
  assert.equal(movies[1].status, "unreleased");
  const collapsed = normalizeMovies(
    [
      {
        id: 2,
        title: "Same day",
        inCinemas: "2026-10-09",
        digitalRelease: "2026-10-09",
      },
    ],
    now,
  );
  assert.equal(collapsed.length, 1);
  assert.equal(normalizeMovies([{ id: 3, title: "No dates" }], now).length, 0);
});

test("monitored flags flow through normalization", () => {
  const episode = (seriesMonitored, monitored) => ({
    id: 1,
    series: { title: "S", monitored: seriesMonitored },
    title: "E",
    seasonNumber: 1,
    episodeNumber: 1,
    airDateUtc: "2026-10-06",
    monitored,
  });
  assert.equal(normalizeEpisodes([episode(true, true)])[0].monitored, true);
  assert.equal(normalizeEpisodes([episode(false, true)])[0].monitored, false);
  assert.equal(normalizeEpisodes([episode(true, false)])[0].monitored, false);
  assert.equal(
    normalizeMovies([
      { id: 1, title: "F", monitored: false, inCinemas: "2026-10-08" },
    ])[0].monitored,
    false,
  );
});
test("calendar range validation blocks invalid and excessive requests", () => {
  assert.equal(validateRange("bad", "2026-10-01"), false);
  assert.equal(validateRange("2026-10-01", "2026-10-01"), false);
  assert.equal(validateRange("2026-10-01", "2027-01-01"), false);
  assert.equal(validateRange("2026-10-01", "2026-11-12"), true);
});

test("seerr search results drop people, validate posters, and cap length", () => {
  const results = normalizeSeerrResults({
    results: [
      {
        id: 1,
        mediaType: "movie",
        title: "Film",
        releaseDate: "2026-01-01",
        posterPath: "/ok.jpg",
        overview: "x".repeat(500),
        mediaInfo: { status: 5 },
      },
      { id: 2, mediaType: "person", name: "Actor" },
      {
        id: 3,
        mediaType: "tv",
        name: "Show",
        firstAirDate: "2025-05-01",
        posterPath: "/../evil.jpg",
        mediaInfo: { requests: [{ id: 9 }] },
      },
      { id: "bad", mediaType: "movie", title: "Broken" },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].poster, "/ok.jpg");
  assert.equal(results[0].overview.length, 300);
  assert.equal(results[0].availability, 5);
  assert.equal(results[1].poster, null);
  assert.equal(results[1].requested, true);
});

test("seerr requests normalize status and fall back to a TMDB id title", () => {
  const requests = normalizeSeerrRequests({
    results: [
      {
        id: 1,
        status: 2,
        createdAt: "2026-10-06",
        media: { mediaType: "movie", title: "Film", status: 3 },
      },
      { id: 2, status: 1, media: { mediaType: "tv", tmdbId: 42 } },
    ],
  });
  assert.equal(requests[0].title, "Film");
  assert.equal(requests[0].status, 2);
  assert.equal(requests[1].title, "TMDB #42");
  assert.equal(requests[1].availability, null);
});

test("service URLs normalize scheme-less addresses and trailing slashes, preserving URL bases", () => {
  assert.equal(
    serviceUrl("  example.test:8989///  ", "/api/v3/system/status").href,
    "http://example.test:8989/api/v3/system/status",
  );
  assert.equal(
    serviceUrl("https://example.test/sonarr/", "/api/v3/calendar").href,
    "https://example.test/sonarr/api/v3/calendar",
  );
  assert.throws(() => serviceUrl("file:///tmp", "/api"));
  assert.throws(() => serviceUrl("http://user:password@example.test", "/api"));
});

test("upstream distinguishes API failures without exposing private response bodies", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response("private upstream details", { status: 401 });
    await assert.rejects(upstream("http://example.test", "/api"), /HTTP 401/);
    globalThis.fetch = async () =>
      new Response("<html>login page with secret</html>");
    await assert.rejects(
      upstream("http://example.test", "/api"),
      /did not return valid JSON/,
    );
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: new Error("unexpected redirect"),
      });
    };
    await assert.rejects(upstream("http://example.test", "/api"), /redirected/);
  } finally {
    globalThis.fetch = original;
  }
});

test("episode detail metadata and premiere flag preserve availability", () => {
  const [episode] = normalizeEpisodes(
    [
      {
        id: 4,
        seasonNumber: 2,
        episodeNumber: 1,
        title: "New beginning",
        overview: "Episode overview",
        airDateUtc: "2026-10-10",
        hasFile: false,
        series: {
          title: "Sample",
          year: 2026,
          genres: ["Drama"],
          images: [
            {
              coverType: "fanart",
              remoteUrl: "https://artworks.thetvdb.com/example.jpg",
            },
          ],
        },
      },
    ],
    now,
  );
  assert.equal(episode.status, "upcoming");
  assert.equal(episode.premiere, true);
  assert.equal(episode.overview, "Episode overview");
  assert.equal(episode.year, 2026);
  assert.deepEqual(episode.genres, ["Drama"]);
});

test("ratings reject absent, zero, invalid and unrated scores", async () => {
  const { normalizedRating } = await import("../src/model.js");
  for (const value of [null, undefined, 0, -1, 11, NaN, Infinity, "8.2"])
    assert.equal(normalizedRating(value, "TMDB"), null);
  assert.equal(normalizedRating(8.2, "TMDB", 0), null);
  assert.deepEqual(normalizedRating(8.2, "TMDB", 20), {
    value: 8.2,
    source: "TMDB",
  });
});
