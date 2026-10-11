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

test("theater feed keeps second-page titles up to 25, dedupes, caches and isolates viewers", async () => {
  process.env.TMDB_API_KEY = "paged-mock";
  const calls = [];
  const read = async (base, route, options) => {
    calls.push({ base, route, user: options?.headers?.["X-API-User"] });
    if (base.includes("themoviedb")) {
      const page = Number(new URL(route, base).searchParams.get("page"));
      return {
        total_pages: 3,
        results: Array.from({ length: 20 }, (_, i) => ({
          id: (page - 1) * 20 + i + 1,
          title:
            page === 3 && i === 5
              ? "The Social Reckoning"
              : `Movie ${page}-${i}`,
        })),
      };
    }
    return {
      id: Number(route.split("/").at(-1)),
      mediaInfo: { status: options.headers["X-API-User"] === "7" ? 5 : 1 },
    };
  };
  const result = await inTheaters(7, { read });
  assert.equal(result.items.length, 25);
  assert.equal(result.items[24].title, "Movie 2-4");
  assert.equal(result.capped, true);
  assert.equal(calls.filter((c) => c.base.includes("themoviedb")).length, 2);
  const count = calls.length;
  await inTheaters(7, { read });
  assert.equal(calls.length, count);
  const other = await inTheaters(8, { read });
  assert.equal(other.items[0].availability, 1);
  assert.equal(result.items[0].availability, 5);
  assert.equal(calls.filter((c) => c.base.includes("themoviedb")).length, 2);
});

test("theater pagination stops at its cap and reports partial coverage", async () => {
  const result = await inTheaters(7, {
    read: async (base, route) => {
      if (base.includes("themoviedb")) {
        const page = Number(new URL(route, base).searchParams.get("page"));
        return {
          total_pages: 20,
          results: Array.from({ length: 20 }, (_, i) => ({
            id: (page - 1) * 20 + i + 1,
            title: "Movie",
          })),
        };
      }
      return { id: Number(route.split("/").at(-1)) };
    },
  });
  assert.equal(result.items.length, 25);
  assert.equal(result.capped, true);
});

test("page overlap is deduped and a failed later page cannot be cached as a complete list", async () => {
  let fail = true;
  const read = async (base, route) => {
    if (base.includes("themoviedb")) {
      const page = Number(new URL(route, base).searchParams.get("page"));
      if (page === 2 && fail) throw new Error("page unavailable");
      return {
        total_pages: 2,
        results:
          page === 1
            ? [{ id: 1, title: "One" }]
            : [
                { id: 1, title: "One duplicate" },
                { id: 2, title: "Two" },
              ],
      };
    }
    return { id: Number(route.split("/").at(-1)) };
  };
  await assert.rejects(inTheaters(7, { read }), /page unavailable/);
  fail = false;
  assert.deepEqual(
    (await inTheaters(7, { read })).items.map((item) => item.id),
    [1, 2],
  );
});

test("TMDB theater list stays fresh for 24 hours while viewer availability expires in one minute", async () => {
  const realNow = Date.now;
  let now = realNow(),
    lists = 0,
    details = 0;
  Date.now = () => now;
  const read = async (base, route) => {
    if (base.includes("themoviedb")) {
      lists++;
      return { results: [{ id: 1, title: "One" }] };
    }
    details++;
    return { id: Number(route.split("/").at(-1)) };
  };
  try {
    await inTheaters(7, { read });
    now += 59000;
    await inTheaters(7, { read });
    assert.equal(lists, 1);
    assert.equal(details, 1);
    now += 2000;
    await inTheaters(7, { read });
    assert.equal(lists, 1);
    assert.equal(details, 2);
    now += 23 * 60 * 60000;
    await inTheaters(7, { read });
    assert.equal(lists, 1);
    now += 60 * 60000;
    await inTheaters(7, { read });
    assert.equal(lists, 2);
  } finally {
    Date.now = realNow;
  }
});

test("daily theater list is persisted without credentials and reused after restart for other viewers", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-theater-list-"));
  let pulls = 0;
  const read = async (base, route) => {
    if (base.includes("themoviedb")) {
      pulls++;
      return { results: [{ id: 1, title: "Shared movie" }] };
    }
    return { id: Number(route.split("/").at(-1)) };
  };
  try {
    await inTheaters(7, { read, dataDir: dir });
    const saved = await fs.readFile(
      path.join(dir, "theater-list.json"),
      "utf8",
    );
    assert.ok(!saved.includes(process.env.TMDB_API_KEY));
    assert.ok(!saved.includes("X-API-User"));
    const restartedRead = (...args) => read(...args);
    await inTheaters(8, { read: restartedRead, dataDir: dir });
    assert.equal(pulls, 1);
    const data = JSON.parse(saved);
    data.fetchedAt -= 25 * 60 * 60000;
    await fs.writeFile(
      path.join(dir, "theater-list.json"),
      JSON.stringify(data),
    );
    await inTheaters(9, { read: (...args) => read(...args), dataDir: dir });
    assert.equal(pulls, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("restarting with a 23-hour-old persisted list keeps only its remaining hour", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-theater-age-"));
  const realNow = Date.now;
  let now = realNow(),
    pulls = 0;
  Date.now = () => now;
  const read = async (base, route) => {
    if (base.includes("themoviedb")) {
      pulls++;
      return { results: [{ id: 1, title: "One" }] };
    }
    return { id: Number(route.split("/").at(-1)) };
  };
  try {
    await inTheaters(7, { read, dataDir: dir });
    now += 23 * 60 * 60000;
    const restartedRead = (...args) => read(...args);
    await inTheaters(8, { read: restartedRead, dataDir: dir });
    assert.equal(pulls, 1);
    now += 59 * 60000;
    await inTheaters(8, { read: restartedRead, dataDir: dir });
    assert.equal(pulls, 1);
    now += 60001;
    await inTheaters(8, { read: restartedRead, dataDir: dir });
    assert.equal(pulls, 2);
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("legacy 200-title disk caches refresh to 25 and hydrate US certification from existing viewer detail calls", async () => {
  const fs = await import("node:fs/promises"), os = await import("node:os"), path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-theater-migration-"));
  await fs.writeFile(path.join(dir, "theater-list.json"), JSON.stringify({ region:"US", capped:true, fetchedAt:Date.now(), titles:Array.from({length:200},(_,i)=>({id:i+1,mediaType:"movie",title:"Old"})) }));
  let pages = 0, details = 0;
  try {
    const result = await inTheaters(7, {dataDir:dir, read:async(base,route)=>{
      if(base.includes("themoviedb")) { pages++; return {total_pages:10,results:Array.from({length:20},(_,i)=>({id:(pages-1)*20+i+1,title:"Fresh"}))}; }
      details++; return {id:Number(route.split("/").at(-1)),releases:{results:[{iso_3166_1:"US",release_dates:[{certification:"R"}]}]}};
    }});
    assert.equal(pages,2); assert.equal(details,25); assert.equal(result.items.length,25); assert.equal(result.items[0].contentRating,"R");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,"theater-list.json"),"utf8")).titles.length,25);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("shelf certifications cache per viewer and preserve unknown fallback", async () => {
  const { withShelfCertifications } = await import("../src/adapters.js");
  const original = global.fetch; let calls = 0;
  global.fetch = async url => { calls++; const id = Number(new URL(url).pathname.split("/").at(-1)); return new Response(JSON.stringify({id,releases:{results:[{iso_3166_1:"US",release_dates:[{certification:id===1?"PG-13":""}]}]}})); };
  try {
    process.env.SEERR_URL="http://shelf-cert.test";
    const items=[{id:1,mediaType:"movie"},{id:2,mediaType:"movie"}];
    const result=await withShelfCertifications(items,701);
    assert.equal(result[0].contentRating,"PG-13"); assert.equal(result[1].contentRating,null);
    await withShelfCertifications(items,701); assert.equal(calls,2);
    await withShelfCertifications(items,702); assert.equal(calls,4);
  } finally {global.fetch=original;}
});
