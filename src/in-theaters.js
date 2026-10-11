import fs from "node:fs/promises";
import path from "node:path";
import { upstream } from "./adapters.js";
import { normalizeSeerrResults, seerrContentRating, streamerCredit } from "./model.js";

const MAX_PAGES = 10,
  MAX_TITLES = 25;
const RELEASE_WINDOW_DAYS = 120, FILTER_VERSION = 2;
const DAY_MS = 86400000;
export function isNewTheaterRelease(value, now = Date.now()) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return false;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return time <= today && time >= today - RELEASE_WINDOW_DAYS * DAY_MS;
}
const feeds = new WeakMap();
function cached(map, key, ttl, load) {
  const now = Date.now();
  for (const [id, entry] of map) if (entry.expires <= now) map.delete(id);
  const existing = map.get(key);
  if (existing) return existing.value;
  if (map.size >= 100) map.delete(map.keys().next().value);
  const value = load();
  map.set(key, { expires: now + ttl, value });
  value.catch(() => {
    if (map.get(key)?.value === value) map.delete(key);
  });
  return value;
}
export async function inTheaters(userId, { read = upstream, dataDir } = {}) {
  const key = (process.env.TMDB_API_KEY || "").trim();
  if (!key)
    throw new Error("In theaters needs a TMDB API key in the server settings.");
  let cache = feeds.get(read);
  if (!cache) {
    cache = { lists: new Map(), viewers: new Map() };
    feeds.set(read, cache);
  }
  const listKey = JSON.stringify([key, dataDir || null]);
  const list = await cached(cache.lists, listKey, 24 * 60 * 60000, async () => {
    const file = dataDir && path.join(dataDir, "theater-list.json");
    if (file) {
      try {
        const saved = JSON.parse(await fs.readFile(file, "utf8"));
        if (
          saved?.region === "US" &&
          saved.filterVersion === FILTER_VERSION &&
          typeof saved.capped === "boolean" &&
          Number.isFinite(saved.fetchedAt) &&
          saved.fetchedAt <= Date.now() &&
          Date.now() - saved.fetchedAt < 24 * 60 * 60000 &&
          Array.isArray(saved.titles) &&
          saved.titles.length <= MAX_TITLES &&
          saved.titles.every(
            (item) =>
              Number.isSafeInteger(item?.id) &&
              item.id > 0 &&
              item.mediaType === "movie" &&
              typeof item.title === "string" &&
              isNewTheaterRelease(item.originalReleaseDate),
          )
        )
          return saved;
      } catch (error) {
        if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
    }
    const raw = [],
      seen = new Set();
    let capped = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        api_key: key,
        region: "US",
        language: "en-US",
        page: String(page),
      });
      const data = await read(
        "https://api.themoviedb.org",
        `/3/movie/now_playing?${query}`,
      );
      if (!Array.isArray(data.results))
        throw new Error("TMDB did not return a theater list.");
      const candidates = data.results.filter(item => {
        if (!Number.isSafeInteger(item?.id) || item.id <= 0 || seen.has(item.id) || item.adult === true) return false;
        seen.add(item.id); return true;
      });
      for (let start = 0; start < candidates.length; start += 8) {
        const verified = await Promise.all(candidates.slice(start, start + 8).map(async item => {
          const detailQuery = new URLSearchParams({api_key:key, language:"en-US"});
          const detail = await read("https://api.themoviedb.org", `/3/movie/${item.id}?${detailQuery}`);
          if (detail.id !== item.id) throw new Error("TMDB returned a different movie.");
          return isNewTheaterRelease(detail.release_date) ? {...item, release_date:detail.release_date, streamer:streamerCredit(detail,"movie")} : null;
        }));
        raw.push(...verified.filter(Boolean));
      }
      const more = data.results.length > 0 && page < (data.total_pages || 1);
      if (raw.length >= MAX_TITLES || page === MAX_PAGES) {
        capped = more || raw.length > MAX_TITLES;
        break;
      }
      if (!more) break;
    }
    // The shared result normalizer caps at 40. Normalize in chunks instead of losing later pages.
    const titles = [];
    for (let start = 0; start < Math.min(raw.length, MAX_TITLES); start += 40) {
      titles.push(
        ...normalizeSeerrResults({
          results: raw
            .slice(start, Math.min(start + 40, MAX_TITLES))
            .map((item) => ({
              ...item,
              mediaType: "movie",
              releaseDate: item.release_date,
              posterPath: item.poster_path,
              voteAverage: item.vote_average,
              voteCount: item.vote_count,
              mediaInfo: undefined,
            })),
        }),
      );
    }
    titles.forEach((item, index) => { item.originalReleaseDate = raw[index].release_date; item.streamer = raw[index].streamer; });
    const result = { titles, capped, region: "US", filterVersion: FILTER_VERSION, fetchedAt: Date.now() };
    if (file) {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(file + ".tmp", JSON.stringify(result), {
        mode: 0o600,
      });
      await fs.rename(file + ".tmp", file);
    }
    return result;
  });
  // Restarts do not restart the age of a list loaded from disk.
  const listEntry = cache.lists.get(listKey);
  if (listEntry) listEntry.expires = list.fetchedAt + 24 * 60 * 60000;
  // Availability/request state is short-lived and isolated to the exact Seerr viewer/config.
  const viewerKey = JSON.stringify([
    key,
    process.env.SEERR_URL,
    process.env.SEERR_API_KEY,
    userId,
    list.fetchedAt,
  ]);
  return cached(cache.viewers, viewerKey, 60000, async () => {
    const { titles, capped } = list;
    const headers = {
      "X-Api-Key": process.env.SEERR_API_KEY,
      "X-API-User": String(userId),
    };
    // Availability must be verified, never guessed from TMDB or a failed Seerr read.
    const items = [];
    for (let start = 0; start < titles.length; start += 8) {
      const batch = await Promise.all(
        titles.slice(start, start + 8).map(async (item) => {
          const detail = await read(
            process.env.SEERR_URL,
            `/api/v1/movie/${item.id}`,
            { headers },
          );
          if (detail.id !== item.id)
            throw new Error("Seerr returned a different movie.");
          return {
            ...item,
            contentRating: seerrContentRating(detail, "movie"),
            availability: Number.isInteger(detail.mediaInfo?.status)
              ? detail.mediaInfo.status
              : null,
            requested:
              [2, 3, 4, 5].includes(detail.mediaInfo?.status) ||
              Boolean(detail.mediaInfo?.requests?.length),
          };
        }),
      );
      items.push(...batch);
    }
    return { items, region: "US", capped };
  });
}
