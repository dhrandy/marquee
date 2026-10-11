import { upstream } from "./adapters.js";
import { normalizeSeerrResults } from "./model.js";

export async function inTheaters(userId, { read = upstream } = {}) {
  const key = (process.env.TMDB_API_KEY || "").trim();
  if (!key)
    throw new Error("In theaters needs a TMDB API key in the server settings.");
  const query = new URLSearchParams({
    api_key: key,
    region: "US",
    language: "en-US",
    page: "1",
  });
  const data = await read(
    "https://api.themoviedb.org",
    `/3/movie/now_playing?${query}`,
  );
  if (!Array.isArray(data.results))
    throw new Error("TMDB did not return a theater list.");
  const seen = new Set();
  const titles = normalizeSeerrResults({
    results: data.results
      .filter((item) => {
        if (
          !Number.isSafeInteger(item?.id) ||
          item.id <= 0 ||
          seen.has(item.id) ||
          item.adult === true
        )
          return false;
        seen.add(item.id);
        return true;
      })
      .slice(0, 20)
      .map((item) => ({
        ...item,
        mediaType: "movie",
        title: item.title,
        releaseDate: item.release_date,
        posterPath: item.poster_path,
        voteAverage: item.vote_average,
        voteCount: item.vote_count,
        mediaInfo: undefined,
      })),
  });
  const headers = {
    "X-Api-Key": process.env.SEERR_API_KEY,
    "X-API-User": String(userId),
  };
  // Availability must be verified, never guessed from TMDB or a failed Seerr read.
  const items = [];
  for (let start = 0; start < titles.length; start += 4) {
    const batch = await Promise.all(
      titles.slice(start, start + 4).map(async (item) => {
        const detail = await read(
          process.env.SEERR_URL,
          `/api/v1/movie/${item.id}`,
          { headers },
        );
        if (detail.id !== item.id)
          throw new Error("Seerr returned a different movie.");
        return {
          ...item,
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
  return { items, region: "US" };
}
