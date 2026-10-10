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

import { normalizedContentRating, seerrContentRating } from "../src/model.js";
test("content ratings retain supplied certifications and never guess missing values", () => {
  assert.equal(normalizedContentRating(" PG-13 "), "PG-13");
  assert.equal(normalizedContentRating("TV-MA"), "TV-MA");
  assert.equal(normalizedContentRating("<img src=x>"), null);
  assert.equal(normalizedContentRating(undefined), null);
  assert.equal(
    seerrContentRating(
      {
        releases: {
          results: [
            { iso_3166_1: "GB", release_dates: [{ certification: "15" }] },
            {
              iso_3166_1: "US",
              release_dates: [{ certification: "" }, { certification: "R" }],
            },
          ],
        },
      },
      "movie",
    ),
    "R",
  );
  assert.equal(
    seerrContentRating(
      { contentRatings: { results: [{ iso_3166_1: "US", rating: "TV-14" }] } },
      "tv",
    ),
    "TV-14",
  );
  assert.equal(seerrContentRating({}, "movie"), null);
});

import { topCast } from "../src/model.js";
test("cast uses billed actors, skips crew and caps four distinct names", () => {
  assert.deepEqual(
    topCast(
      [
        { Type: "Director", Name: "Crew" },
        { Type: "Actor", Name: "Alex Sample" },
        { Type: "Actor", Name: "Alex Sample" },
      ],
      true,
    ),
    ["Alex Sample"],
  );
  assert.deepEqual(
    topCast([
      { order: 3, name: "Third" },
      { order: 0, name: "First" },
    ]),
    ["First", "Third"],
  );
  assert.equal(
    topCast(Array.from({ length: 9 }, (_, i) => ({ name: `Sample ${i}` })))
      .length,
    4,
  );
  assert.deepEqual(topCast(null), []);
});

test("Seerr active availability cannot become requestable when requests are omitted", () => {
  for (const mediaType of ["movie", "tv"]) {
    for (const status of [2, 3, 4, 5]) {
      const [item] = normalizeSeerrResults({ results: [{ id: 42, mediaType, mediaInfo: { status } }] });
      assert.equal(item.requested, true);
      assert.equal(item.availability, status);
    }
  }
});

test("Seerr facts validate scores, releases and country data without guesses", async () => {
  const { seerrFacts } = await import("../src/model.js");
  const f = seerrFacts({ status: "Released", originalLanguage: "en", voteAverage: 8.3, voteCount: 30, productionCountries: [{ iso_3166_1: "US", name: "United States" }], releases: { results: [{ iso_3166_1: "US", release_dates: [{ type:3, release_date:"2026-07-31T00:00:00Z" }, {type:4, release_date:"2026-10-06T00:00:00Z"}, {type:5, release_date:"2026-12-15T00:00:00Z"}] }] } }, "movie", { rt:{criticsScore:90, audienceScore:97}, imdb:{criticsScore:8} });
  assert.deepEqual(f.scores, {critics:90,audience:97,imdb:8,tmdb:83});
  assert.equal(f.releases[1].date, "2026-10-06");
  assert.equal(f.releases[1].region, "US");
  const empty = seerrFacts({ originalLanguage:"<script>", voteAverage:9, voteCount:0, releaseDate:"2026-02-30", productionCountries:[{iso_3166_1:"ZZZ",name:"bad"}] }, "movie", { rt:{ criticsScore:101, audienceScore:0 }, imdb:{criticsScore:NaN} });
  assert.deepEqual(empty.scores,{critics:null,audience:0,imdb:null,tmdb:null});
  assert.equal(empty.releases.length,0);
  assert.equal(empty.originalLanguage,null);
  assert.equal(empty.productionCountries.length,0);
});

import { trustedProxies, proxyTrust, allowedOrigin } from "../src/security.js";
test("proxy trust requires explicit IPs and HTTPS origins stay strict",()=>{
 assert.equal(trustedProxies(),false);
 assert.deepEqual(trustedProxies("127.0.0.1, ::1, 192.0.2.4/32"),["127.0.0.1","::1","192.0.2.4/32"]);
 for(const invalid of ["true","1","loopback","0.0.0.0/0","::/0","192.0.2.4/33","127.0.0.1/32/1"])assert.throws(()=>trustedProxies(invalid));
 assert.equal(allowedOrigin("https://example.test","example.test",true),true);
 for(const origin of ["http://example.test","null",undefined,"https://example.test.evil.test"])assert.equal(allowedOrigin(origin,"example.test",true),false);
 assert.equal(allowedOrigin("http://example.test","example.test",false),true);
});

test("single-proxy option is explicit and strict allowlist wins",()=>{
 assert.equal(proxyTrust(),false);assert.equal(proxyTrust("","0"),false);assert.equal(proxyTrust("","1"),1);
 assert.deepEqual(proxyTrust("127.0.0.1","1"),["127.0.0.1"]);
 for(const invalid of ["true","2","-1","all"])assert.throws(()=>proxyTrust("",invalid));
});

test("radarr calendar entries carry popup details and a TMDB id", async () => {
  const { normalizeMovies } = await import("../src/model.js");
  const [entry] = normalizeMovies(
    [{ id: 7, title: "Runner", year: 2026, tmdbId: 555, studio: "Astral", overview: "Runs.", genres: ["Action"], runtime: 100, digitalRelease: "2026-10-10T00:00:00Z", images: [{ coverType: "poster", remoteUrl: "https://image.tmdb.org/t/p/original/p.jpg" }] }],
    new Date("2026-10-01"),
  );
  assert.equal(entry.tmdbId, 555);
  assert.equal(entry.overview, "Runs.");
  assert.deepEqual(entry.genres, ["Action"]);
  assert.equal(entry.runtime, 100);
  assert.match(entry.poster, /image\.tmdb\.org/);
});

test("section order accepts only a complete unique known list", async () => {
  const { cleanSectionOrder, sectionOrderDefaults } = await import("../src/personal.js");
  assert.deepEqual(cleanSectionOrder([...sectionOrderDefaults].reverse()), [...sectionOrderDefaults].reverse());
  for (const value of [null, {}, [], sectionOrderDefaults.slice(1), [...sectionOrderDefaults.slice(1), "weather"], [...sectionOrderDefaults.slice(1), "token"]]) assert.equal(cleanSectionOrder(value), null);
});
