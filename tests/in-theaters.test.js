import test from "node:test";
import assert from "node:assert/strict";
import { inTheaters } from "../src/in-theaters.js";

test("theater feed uses US Now Playing and verifies each movie through the viewer's Seerr account", async () => {
  process.env.TMDB_API_KEY = "mock-tmdb-key";
  process.env.SEERR_URL = "http://seerr.test";
  process.env.SEERR_API_KEY = "mock-seerr-key";
  const calls = [];
  const result = await inTheaters(7, {
    read: async (base, route, options) => {
      calls.push({ base, route, options });
      if (base === "https://api.themoviedb.org")
        return {
          results: [
            {
              id: 1,
              title: "One",
              release_date: "2026-10-01",
              poster_path: "/One.jpg",
            },
            { id: 1, title: "Duplicate" },
            { id: 2, title: "Two" },
            { id: 3, title: "Adult", adult: true },
            { id: "bad", title: "Bad" },
          ],
        };
      return {
        id: Number(route.split("/").at(-1)),
        mediaInfo: route.endsWith("/1")
          ? { status: 5 }
          : { status: 1, requests: [{ id: 8 }] },
      };
    },
  });
  assert.equal(result.region, "US");
  assert.deepEqual(
    result.items.map((item) => item.id),
    [1, 2],
  );
  assert.equal(result.items[0].availability, 5);
  assert.equal(result.items[1].requested, true);
  assert.equal(result.items[0].poster, "/One.jpg");
  const url = new URL(calls[0].route, calls[0].base);
  assert.equal(url.pathname, "/3/movie/now_playing");
  assert.equal(url.searchParams.get("region"), "US");
  assert.equal(url.searchParams.get("api_key"), "mock-tmdb-key");
  assert.equal(calls[1].options.headers["X-API-User"], "7");
  assert.ok(!JSON.stringify(result).includes("mock-tmdb-key"));
});

test("theater feed fails closed on missing credentials, malformed data or unverifiable availability", async () => {
  delete process.env.TMDB_API_KEY;
  await assert.rejects(inTheaters(7), /TMDB API key/);
  process.env.TMDB_API_KEY = "mock-key";
  await assert.rejects(
    inTheaters(7, { read: async () => ({}) }),
    /theater list/,
  );
  await assert.rejects(
    inTheaters(7, {
      read: async (base) =>
        base.includes("themoviedb")
          ? { results: [{ id: 1, title: "One" }] }
          : { id: 2 },
    }),
    /different movie/,
  );
  await assert.rejects(
    inTheaters(7, {
      read: async (base) => {
        if (base.includes("themoviedb"))
          return { results: [{ id: 1, title: "One" }] };
        throw new Error("Seerr unavailable");
      },
    }),
    /Seerr unavailable/,
  );
});
