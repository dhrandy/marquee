import crypto from "node:crypto";
import {
  normalizeEpisodes,
  normalizeMovies,
  normalizedRating,
  normalizedContentRating,
  topCast,
  seerrContentRating,
  streamerCredit,
  uniqueCreditNames,
  seerrFacts,
  normalizeSeerrResults,
  normalizeSeerrRequests,
} from "./model.js";

export async function upstream(
  base,
  path,
  { headers = {}, method = "GET", body } = {},
) {
  const url = serviceUrl(base, path);
  let response;
  // Reads get one retry on a dropped or timed-out connection; writes never repeat.
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      // Seerr/TMDB answer 5xx now and then when hit by many searches at once;
      // a read gets one more try before it counts as a failure.
      if (!response.ok && response.status >= 500 && method === "GET" && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      break;
    } catch (error) {
      const code = error.cause?.code;
      const transient =
        method === "GET" &&
        attempt === 0 &&
        (error.name === "TimeoutError" ||
          ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "EAI_AGAIN"].includes(code) ||
          error.message === "fetch failed" && !code);
      if (!transient) throw new Error(connectionError(error));
    }
  }
  if (!response.ok)
    throw new Error(
      `Service answered HTTP ${response.status}.` +
        ([401, 403, 404].includes(response.status)
          ? " Check its URL and API key or credentials."
          : ""),
    );
  if (response.status === 204) return {};
  try {
    return await response.json();
  } catch {
    throw new Error(
      "Service answered, but did not return valid JSON. Check its API base URL.",
    );
  }
}

export function serviceUrl(base, path) {
  if (!base?.trim()) throw new Error("Service not configured.");
  let address = base.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) address = `http://${address}`;
  let url;
  try {
    url = new URL(address.replace(/\/+$/, "") + path);
  } catch {
    throw new Error("The configured service URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "The configured URL must be HTTP(S), without embedded credentials.",
    );
  return url;
}

function connectionError(error) {
  const code = error.cause?.code;
  if (code === "ENOTFOUND")
    return "Host not found (DNS). Check the service URL.";
  if (code === "ECONNREFUSED")
    return "Connection refused. Check the service port.";
  if (error.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT")
    return "Timed out waiting for the service.";
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code || ""))
    return "TLS certificate validation failed. Use a trusted certificate or the intended local HTTP URL.";
  if (/redirect/i.test(error.cause?.message || ""))
    return "Service redirected the API request. Use its final API base URL, including any configured URL base.";
  return "Could not connect to the service. Check the URL and container connectivity.";
}

export function jellyfinHeaders(token = "", deviceId = "marquee-web") {
  return {
    Authorization: `MediaBrowser Client="Marquee", Device="Web", DeviceId="${deviceId}", Version="0.1.0"${token ? `, Token="${token}"` : ""}`,
  };
}

export async function authenticate(username, password) {
  // Each login gets its own Jellyfin device identity. Shared IDs revoke other browsers.
  const deviceId = `marquee-${crypto.randomUUID()}`;
  const auth = await upstream(
    process.env.JELLYFIN_URL,
    "/Users/AuthenticateByName",
    {
      method: "POST",
      headers: jellyfinHeaders("", deviceId),
      body: { Username: username, Pw: password },
    },
  );
  if (!auth.User?.Id || !auth.AccessToken)
    throw new Error("Invalid authentication response");
  return {
    id: auth.User.Id,
    name: auth.User.Name,
    token: auth.AccessToken,
    deviceId,
    isAdmin: auth.User.Policy?.IsAdministrator === true,
  };
}

export async function recentItems(user) {
  // Limit cards after season grouping, not raw episodes. Large imports can
  // otherwise fill an entire Jellyfin page with only one or two seasons.
  const groups = new Map();
  const seasonNumbers = new Map();
  const pageSize = 100;
  let startIndex = 0;
  while (groups.size < 18) {
    const query = new URLSearchParams({
      UserId: user.id,
      SortBy: "DateCreated,SortName",
      SortOrder: "Descending",
      Recursive: "true",
      IncludeItemTypes: "Movie,Episode",
      ExcludeLocationTypes: "Virtual",
      IsMissing: "false",
      IsPlaceHolder: "false",
      Limit: String(pageSize),
      StartIndex: String(startIndex),
      Fields:
        "DateCreated,PremiereDate,Overview,Genres,Studios,RunTimeTicks,CommunityRating,OfficialRating,People",
      EnableUserData: "true",
      EnableTotalRecordCount: "true",
    });
    const data = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, {
      headers: jellyfinHeaders(user.token, user.deviceId),
    });
    const items = data.Items || [];
    for (const item of items) {
      if (
        item.LocationType === "Virtual" ||
        item.IsMissing === true ||
        item.IsPlaceHolder === true
      )
        continue;
      if (item.Type === "Episode") {
        if (!Number.isInteger(item.ParentIndexNumber) && item.SeasonId) {
          if (!seasonNumbers.has(item.SeasonId)) {
            try {
              const season = await upstream(
                process.env.JELLYFIN_URL,
                `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.SeasonId)}`,
                { headers: jellyfinHeaders(user.token, user.deviceId) },
              );
              seasonNumbers.set(item.SeasonId, season.IndexNumber);
            } catch {
              seasonNumbers.set(item.SeasonId, null);
            }
          }
          item.ParentIndexNumber = seasonNumbers.get(item.SeasonId);
        }
        // Specials/podcasts do not take a regular season's shelf slot.
        if (item.ParentIndexNumber === 0) continue;
      }
      const key = item.Type === "Episode" ? item.SeasonId || item.Id : item.Id;
      if (!groups.has(key)) groups.set(key, item);
      if (groups.size === 18) break;
    }
    startIndex += items.length;
    if (
      !items.length ||
      items.length < pageSize ||
      (Number.isFinite(data.TotalRecordCount) &&
        startIndex >= data.TotalRecordCount)
    )
      break;
  }
  return Promise.all(
    [...groups.values()].map(async (item) => {
      let count;
      let played = item.Type === "Episode" ? null : typeof item.UserData?.Played === "boolean" ? item.UserData.Played : null;
      let seasonNumber = Number.isInteger(item.ParentIndexNumber)
        ? item.ParentIndexNumber
        : null;
      if (item.Type === "Episode" && item.SeasonId) {
        const params = new URLSearchParams({
          UserId: user.id,
          ParentId: item.SeasonId,
          IncludeItemTypes: "Episode",
          ExcludeLocationTypes: "Virtual",
          IsMissing: "false",
          IsPlaceHolder: "false",
          Limit: "0",
          EnableTotalRecordCount: "true",
        });
        try {
          const season = await upstream(process.env.JELLYFIN_URL, `/Items?${params}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
          count = season.TotalRecordCount;
          const details = await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.SeasonId)}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
          played = typeof details.UserData?.Played === "boolean" ? details.UserData.Played : null;
        } catch (error) {
          // Optional episode counts must not blank the entire shelf on a transient failure.
          if (/HTTP (401|403)/.test(error.message)) throw error;
        }
        if (seasonNumber === null) {
          try {
            const details = await upstream(
              process.env.JELLYFIN_URL,
              `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.SeasonId)}`,
              { headers: jellyfinHeaders(user.token, user.deviceId) },
            );
            if (Number.isInteger(details.IndexNumber))
              seasonNumber = details.IndexNumber;
          } catch {
            /* Missing metadata is unknown, never silently season zero. */
          }
        }
      }
      const episode = Number.isInteger(item.IndexNumber)
        ? `Episode ${item.IndexNumber}`
        : "Episode unknown";
      const imageId = item.SeriesId || item.Id;
      return {
        id: imageId,
        tmdbId: Number.isSafeInteger(Number(item.ProviderIds?.Tmdb)) && Number(item.ProviderIds?.Tmdb) > 0 ? Number(item.ProviderIds.Tmdb) : null,
        favoriteId: imageId, favorite: item.Type === "Episode" ? null : item.UserData?.IsFavorite === true,
        watched: played,
        watchedScope: item.Type === "Episode" ? "season" : "movie",
        title: item.SeriesName || item.Name,
        subtitle:
          item.Type === "Episode"
            ? `Season ${seasonNumber ?? "unknown"} / ${count ?? "Unknown"} Episodes · ${episode}${item.Name ? `: ${item.Name}` : ""}`
            : `${item.ProductionYear || ""} · Movie`,
        added: item.DateCreated,
        link: jellyfinLink(item.Id),
        type: item.Type === "Episode" ? "tv" : "movie",
        image: Boolean(item.ImageTags?.Primary || item.SeriesId),
        backdropId:
          item.ParentBackdropItemId ||
          (item.BackdropImageTags?.length ? item.Id : item.SeriesId || null),
        art: "placeholder",
        tagline: "",
        rating: normalizedRating(item.CommunityRating, "Jellyfin community"),
        detail: {
          episodeAirDate: item.Type === "Episode" ? item.PremiereDate || null : null,
          contentRating: normalizedContentRating(item.OfficialRating),
          cast: topCast(item.People, true),
          rating: normalizedRating(item.CommunityRating, "Jellyfin community"),
          title: item.SeriesName || item.Name,
          year: item.ProductionYear ? String(item.ProductionYear) : "",
          subtitle:
            item.Type === "Episode"
              ? `${episode}${item.Name ? `: ${item.Name}` : ""}`
              : "Movie",
          overview: item.Overview || "Overview not available yet.",
          genres: (item.Genres || []).slice(0, 8),
          network: uniqueCreditNames((item.Studios || []).map(studio => studio.Name)),
          runtime: item.RunTimeTicks
            ? Math.round(item.RunTimeTicks / 600000000)
            : null,
        },
      };
    }),
  );
}

export async function calendar(start, end) {
  const query = new URLSearchParams({ start, end, includeSeries: "true" });
  const services = [
    {
      name: "Sonarr",
      base: process.env.SONARR_URL,
      key: process.env.SONARR_API_KEY,
      normalize: normalizeEpisodes,
    },
    {
      name: "Radarr",
      base: process.env.RADARR_URL,
      key: process.env.RADARR_API_KEY,
      normalize: normalizeMovies,
    },
  ];
  const results = await Promise.all(
    services.map(async (service) => {
      if (!service.base || !service.key)
        return { events: [], warning: `${service.name} is not configured.` };
      try {
        const rows = await upstream(service.base, `/api/v3/calendar?${query}`, {
          headers: { "X-Api-Key": service.key },
        });
        if (!Array.isArray(rows))
          throw new Error(
            "Calendar API answered an unexpected format. Check the API base URL.",
          );
        return { events: service.normalize(rows) };
      } catch (error) {
        return {
          events: [],
          warning: `${service.name}: ${error.message}`,
        };
      }
    }),
  );
  return {
    events: results.flatMap((result) => result.events),
    warnings: results.flatMap((result) =>
      result.warning ? [result.warning] : [],
    ),
  };
}

// Server fetches data through the internal URL; people open deep links
// through the external URL. They differ when containers talk over a Docker
// network but phones reach the service through a reverse proxy.
const webBase = (external, internal) =>
  (external || internal || "").replace(/\/$/, "");
const jellyfinWebBase = () =>
  webBase(process.env.JELLYFIN_WEB_URL, process.env.JELLYFIN_URL);
export const jellyfinLink = (id) => {
  const base = jellyfinWebBase();
  return base
    ? `${base}/web/index.html#!/details?id=${encodeURIComponent(id)}`
    : null;
};

export async function seerrIdentity(jellyfinId) {
  if (!process.env.SEERR_URL || !process.env.SEERR_API_KEY)
    throw new Error("Connect Seerr in the server settings.");
  const normalize = (id) =>
    String(id || "")
      .replace(/-/g, "")
      .toLowerCase();
  const matches = [];
  for (let page = 0; page < 100; page++) {
    const data = await upstream(
      process.env.SEERR_URL,
      `/api/v1/user?take=100&skip=${page * 100}`,
      { headers: { "X-Api-Key": process.env.SEERR_API_KEY } },
    );
    if (!Array.isArray(data.results))
      throw new Error("Seerr user lookup failed.");
    matches.push(
      ...data.results.filter(
        (user) =>
          user.jellyfinUserId &&
          normalize(user.jellyfinUserId) === normalize(jellyfinId),
      ),
    );
    const total = Number(data.pageInfo?.results);
    if (
      data.results.length < 100 ||
      (Number.isFinite(total) && (page + 1) * 100 >= total)
    )
      break;
    if (page === 99)
      throw new Error("Seerr user list is too large to verify safely.");
  }
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0].id) ||
    matches[0].id < 1
  )
    throw new Error(
      matches.length > 1
        ? "Multiple Seerr users match this Jellyfin account. Ask your admin to fix the linked accounts."
        : "No linked Seerr user found. Ask your admin to import your Jellyfin account into Seerr.",
    );
  const user = matches[0];
  const quota = await upstream(
    process.env.SEERR_URL,
    `/api/v1/user/${user.id}/quota`,
    {
      headers: {
        "X-Api-Key": process.env.SEERR_API_KEY,
        "X-API-User": String(user.id),
      },
    },
  );
  if (
    !quota.movie ||
    !quota.tv ||
    typeof quota.movie.restricted !== "boolean" ||
    typeof quota.tv.restricted !== "boolean" ||
    !Number.isSafeInteger(user.permissions)
  )
    throw new Error("Seerr permissions could not be verified.");
  const permitted = (bit) =>
    user.id === 1 || Boolean(user.permissions & (2 | 32 | bit));
  return {
    id: user.id,
    // Seerr lets only admins, request managers and users with the "advanced
    // request" permission pick a server, quality profile or root folder.
    advanced: user.id === 1 || Boolean(user.permissions & (2 | 16 | 8192)),
    viewAllRequests: user.id === 1 || Boolean(user.permissions & (2 | 16 | 16384)),
    movie: permitted(262144) && !quota.movie.restricted,
    tv: permitted(524288) && !quota.tv.restricted,
    movieReason: quota.movie.restricted
      ? "Movie request quota reached in Seerr."
      : "Movie requests are not permitted by Seerr.",
    tvReason: quota.tv.restricted
      ? "TV request quota reached in Seerr."
      : "TV requests are not permitted by Seerr.",
  };
}

export async function seerrSearch(query, page, userId) {
  // Seerr validates the query string strictly and rejects "+" for spaces
  // (HTTP 400 on multi-word titles), so encode spaces as %20 like its own UI.
  const clean = query.replace(/\s+/g, " ").trim();
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/search?query=${encodeURIComponent(clean)}&page=${page}`,
    {
      headers: {
        "X-Api-Key": process.env.SEERR_API_KEY,
        "X-API-User": String(userId),
      },
    },
  );
  return normalizeSeerrResults(data);
}

// Franchise names like "Marvel" or "DC" rarely appear in a film's title, so a
// plain title search misses most of the movies. Seerr can list a production
// company's movies and a keyword's movies, so find companies/keywords whose
// name contains the search and return their most popular movies.
export async function seerrFranchise(query, userId) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const headers = {
    "X-Api-Key": process.env.SEERR_API_KEY,
    "X-API-User": String(userId),
  };
  const get = (path) => upstream(process.env.SEERR_URL, path, { headers });
  const params = `query=${encodeURIComponent(q.replace(/\s+/g, " "))}&page=1`;
  const [companies, keywords] = await Promise.all([
    get(`/api/v1/search/company?${params}`).catch(() => ({})),
    get(`/api/v1/search/keyword?${params}`).catch(() => ({})),
  ]);
  const named = (list, max) =>
    (Array.isArray(list?.results) ? list.results : [])
      .filter((x) => Number.isSafeInteger(x?.id) && typeof x?.name === "string" && x.name.toLowerCase().includes(q))
      .slice(0, max);
  const sources = [
    ...named(companies, 2).map((c) => `studio=${c.id}`),
    ...named(keywords, 1).map((k) => `keywords=${k.id}`),
  ];
  const pages = await Promise.all(
    sources.map((source) =>
      get(`/api/v1/discover/movies?${source}&sortBy=popularity.desc&page=1`).catch(() => ({ results: [] })),
    ),
  );
  const movies = pages.flatMap((page) =>
    (Array.isArray(page.results) ? page.results : []).map((r) => ({ ...r, mediaType: "movie" })),
  );
  return normalizeSeerrResults({ results: movies });
}

// Searching an actor or actress: find people whose name contains the search
// and return the movies and shows they acted in.
export async function seerrPersonCredits(query, userId) {
  const q = query.replace(/\s+/g, " ").trim().toLowerCase();
  if (q.length < 3) return [];
  const headers = { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(userId) };
  const get = (path) => upstream(process.env.SEERR_URL, path, { headers });
  const found = await get(`/api/v1/search?query=${encodeURIComponent(q)}&page=1`);
  const people = (found.results || [])
    .filter((r) => r.mediaType === "person" && Number.isSafeInteger(r.id) && String(r.name || "").toLowerCase().includes(q))
    .slice(0, 1);
  const lists = await Promise.all(
    people.map((p) => get(`/api/v1/person/${p.id}/combined_credits`).catch(() => ({}))),
  );
  const cast = lists.flatMap((l) => (Array.isArray(l.cast) ? l.cast : []));
  const seen = new Set();
  const unique = cast.filter((c) => {
    const key = `${c.mediaType}:${c.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) =>
    String(b.releaseDate || b.firstAirDate || "").localeCompare(String(a.releaseDate || a.firstAirDate || "")),
  );
  return normalizeSeerrResults({ results: unique });
}

// Only requester names exposed by this viewer's Seerr detail response.
export function seerrRequesterNames(data) {
  const names = [], seen = new Set();
  for (const request of Array.isArray(data.mediaInfo?.requests) ? data.mediaInfo.requests.slice(0,100) : []) {
    const user = request?.requestedBy;
    const name = [user?.displayName,user?.username,user?.jellyfinUsername,user?.plexUsername].find(value=>typeof value === "string" && value.trim() && !value.includes("@"));
    if (!name) continue;
    const clean = name.trim().slice(0,150), key = user.id != null ? `id:${user.id}` : `name:${clean.toLowerCase()}`;
    if (!seen.has(key)) {seen.add(key);names.push(clean);}
  }
  return names;
}
export async function seerrDetails(type, id, userId) {
  const headers = { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(userId) };
  const [data, ratings] = await Promise.all([
    upstream(process.env.SEERR_URL, `/api/v1/${type}/${id}`, { headers }),
    upstream(process.env.SEERR_URL, `/api/v1/${type}/${id}/${type === "movie" ? "ratingscombined" : "ratings"}`, { headers }).then(r => type === "tv" ? { rt: r } : r).catch(() => ({})),
  ]);
  const safeArt = (value) =>
    typeof value === "string" &&
    /^\/[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/.test(value)
      ? `/api/seerr/image?path=${encodeURIComponent(value)}`
      : null;
  return {
    mediaType: type,
    mediaId: id,
    facts: {...seerrFacts(data, type, ratings), requestedBy: seerrRequesterNames(data)},
    availability: Number.isInteger(data.mediaInfo?.status)
      ? data.mediaInfo.status
      : null,
    requested:
      [2, 3, 4, 5].includes(data.mediaInfo?.status) ||
      (Array.isArray(data.mediaInfo?.requests) &&
        data.mediaInfo.requests.length > 0),
    cast: topCast(data.credits?.cast),
    contentRating: seerrContentRating(data, type),
    contentRatingRegion: "US",
    title: data.title || data.name || "Untitled",
    year: String(data.releaseDate || data.firstAirDate || "").slice(0, 4),
    subtitle: type === "movie" ? "Movie" : "TV series",
    overview: data.overview || "Overview not available yet.",
    genres: (data.genres || []).slice(0, 8).map((genre) => genre.name),
    network:
      uniqueCreditNames((type === "tv" ? data.networks : data.productionCompanies)?.map(item => item.name)),
    runtime: data.runtime || data.episodeRunTime?.[0] || null,
    rating: normalizedRating(data.voteAverage, "TMDB", data.voteCount),
    poster: safeArt(data.posterPath),
    backdrop: safeArt(data.backdropPath) || safeArt(data.posterPath),
  };
}

// Certification is title metadata, but cache by exact viewer/config to avoid account crossover.
const shelfCertificationCache = new Map();
export async function withShelfCertifications(items, userId) {
  const output = [];
  for (let start = 0; start < items.length; start += 8) {
    output.push(...await Promise.all(items.slice(start, start + 8).map(async item => {
      const key = JSON.stringify([process.env.SEERR_URL, process.env.SEERR_API_KEY, userId, item.mediaType, item.id]);
      let entry = shelfCertificationCache.get(key);
      if (!entry || entry.expires <= Date.now()) {
        if (shelfCertificationCache.size >= 1000) shelfCertificationCache.delete(shelfCertificationCache.keys().next().value);
        entry = { expires: Date.now() + 86400000, value: upstream(process.env.SEERR_URL, `/api/v1/${item.mediaType}/${item.id}`, { headers: { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(userId) } }).then(detail => detail.id === item.id ? {contentRating:seerrContentRating(detail, item.mediaType), streamer:streamerCredit(detail, item.mediaType)} : {contentRating:null,streamer:null}).catch(() => { entry.expires = Date.now() + 60000; return {contentRating:null,streamer:null}; }) };
        shelfCertificationCache.set(key, entry);
      }
      return { ...item, ...await entry.value };
    })));
  }
  return output;
}

export async function seerrPopular(userId) {
  const [movies, tv] = await Promise.all(
    ["movies", "tv"].map(async (type) => {
      const results = [];
      for (let page = 1; page <= 5 && results.length < 10; page++) {
        const data = await upstream(
          process.env.SEERR_URL,
          `/api/v1/discover/${type}?page=${page}&sortBy=popularity.desc`,
          {
            headers: {
              "X-Api-Key": process.env.SEERR_API_KEY,
              "X-API-User": String(userId),
            },
          },
        );
        const filtered = (data.results || []).filter(
          (item) =>
            type !== "tv" ||
            !(item.genreIds || item.genre_ids || []).includes(10767),
        );
        for (const item of normalizeSeerrResults({ results: filtered }))
          if (!results.some((old) => old.id === item.id)) results.push(item);
        if (
          !data.results?.length ||
          (data.totalPages && page >= data.totalPages)
        )
          break;
      }
      return results.slice(0, 10);
    }),
  );
  const enriched = await withShelfCertifications([...movies, ...tv], userId);
  return { movies: enriched.slice(0, movies.length), tv: enriched.slice(movies.length) };
}

export async function seerrRequest(mediaType, mediaId, userId, options = {}) {
  const { seasons, serverId, profileId, rootFolder } = options;
  return upstream(process.env.SEERR_URL, "/api/v1/request", {
    method: "POST",
    // Act AS the user (X-API-User), not as the admin API key with a userId in
    // the body: Seerr decides auto-approval from the acting user, so the admin
    // key made every request approve itself and skip the user's own rules.
    headers: {
      "X-Api-Key": process.env.SEERR_API_KEY,
      "X-API-User": String(userId),
    },
    body: {
      mediaType,
      mediaId,
      ...(mediaType === "tv"
        ? { seasons: Array.isArray(seasons) && seasons.length ? seasons : "all" }
        : {}),
      ...(Number.isSafeInteger(serverId) ? { serverId } : {}),
      ...(Number.isSafeInteger(profileId) ? { profileId } : {}),
      ...(typeof rootFolder === "string" && rootFolder ? { rootFolder } : {}),
    },
  });
}

// What the request dialog needs: seasons for a series (with what Seerr already
// knows about each) and, for users allowed to change them, the quality
// profiles and root folders of the default Seerr server.
export async function seerrRequestOptions(type, id, userId, advanced) {
  const headers = {
    "X-Api-Key": process.env.SEERR_API_KEY,
    "X-API-User": String(userId),
  };
  const out = { seasons: [], advanced: null };
  if (type === "tv") {
    const data = await upstream(process.env.SEERR_URL, `/api/v1/tv/${id}`, { headers });
    const known = new Map(
      (data.mediaInfo?.seasons || []).map((s) => [s.seasonNumber, s.status]),
    );
    const requested = new Set();
    for (const request of data.mediaInfo?.requests || [])
      if ([1, 2].includes(request.status))
        for (const s of request.seasons || []) requested.add(s.seasonNumber);
    out.seasons = (data.seasons || [])
      .filter((s) => Number.isInteger(s.seasonNumber) && s.seasonNumber > 0)
      .map((s) => {
        const status = known.get(s.seasonNumber);
        return {
          number: s.seasonNumber,
          episodes: Number.isInteger(s.episodeCount) ? s.episodeCount : 0,
          // 5 available, 4 partial, 3 processing, 2 pending, 1 requested elsewhere, 0 none
          status: [3, 4, 5].includes(status) ? status : requested.has(s.seasonNumber) || status === 2 ? 2 : 0,
        };
      });
  }
  if (advanced) {
    const service = type === "movie" ? "radarr" : "sonarr";
    try {
      const servers = await upstream(process.env.SEERR_URL, `/api/v1/service/${service}`, { headers });
      const server =
        (Array.isArray(servers) &&
          (servers.find((x) => x.isDefault && !x.is4k) || servers.find((x) => !x.is4k))) ||
        null;
      if (server && Number.isSafeInteger(server.id)) {
        const detail = await upstream(process.env.SEERR_URL, `/api/v1/service/${service}/${server.id}`, { headers });
        const profiles = (detail.profiles || [])
          .filter((p) => Number.isSafeInteger(p.id) && typeof p.name === "string")
          .map((p) => ({ id: p.id, name: p.name }));
        const rootFolders = (detail.rootFolders || [])
          .filter((f) => typeof f.path === "string")
          .map((f) => ({ path: f.path, freeSpace: Number.isFinite(f.freeSpace) ? f.freeSpace : null }));
        if (profiles.length || rootFolders.length)
          out.advanced = {
            serverId: server.id,
            serverName: typeof server.name === "string" ? server.name : "",
            profiles,
            rootFolders,
            defaultProfileId: profiles.some((p) => p.id === server.activeProfileId) ? server.activeProfileId : profiles[0]?.id ?? null,
            defaultRootFolder: rootFolders.some((f) => f.path === server.activeDirectory) ? server.activeDirectory : rootFolders[0]?.path ?? null,
          };
      }
    } catch {
      // Advanced choices are optional; the request still works with Seerr's defaults.
    }
  }
  return out;
}

export async function seerrRequests(userId, mine = false) {
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/request?take=10&skip=0&sort=added&filter=all${mine ? `&requestedBy=${encodeURIComponent(userId)}` : ""}`,
    {
      headers: {
        "X-Api-Key": process.env.SEERR_API_KEY,
        "X-API-User": String(userId),
      },
    },
  );
  // Seerr request records carry media IDs/status, not TMDB titles. Resolve the
  // ten visible rows through Seerr's own metadata API as the linked user.
  await Promise.all(
    (data.results || []).slice(0, 10).map(async (request) => {
      const type = request.type || request.media?.mediaType;
      const id = request.media?.tmdbId;
      if (
        !["movie", "tv"].includes(type) ||
        !Number.isSafeInteger(id) ||
        id <= 0
      )
        return;
      try {
        const details = await upstream(
          process.env.SEERR_URL,
          `/api/v1/${type}/${id}`,
          {
            headers: {
              "X-Api-Key": process.env.SEERR_API_KEY,
              "X-API-User": String(userId),
            },
          },
        );
        request.media = {
          ...request.media,
          mediaType: type,
          title:
            details.title ||
            details.name ||
            request.media?.title ||
            request.media?.name,
        };
      } catch {
        /* Keep request status visible if metadata is temporarily unavailable. */
      }
    }),
  );
  return normalizeSeerrRequests(data);
}

export async function testService(name, { includeVersion = false } = {}) {
  const services = {
    jellyfin: {
      base: process.env.JELLYFIN_URL,
      path: "/System/Info/Public",
      key: null,
    },
    sonarr: {
      base: process.env.SONARR_URL,
      path: "/api/v3/system/status",
      key: process.env.SONARR_API_KEY,
    },
    radarr: {
      base: process.env.RADARR_URL,
      path: "/api/v3/system/status",
      key: process.env.RADARR_API_KEY,
    },
    maintainerr: { base: process.env.MAINTAINERR_URL, path: "/api/collections/overlay-data", key: process.env.MAINTAINERR_API_KEY },
    seerr: {
      base: process.env.SEERR_URL,
      path: "/api/v1/status",
      key: process.env.SEERR_API_KEY,
    },
  };
  const service = services[name];
  if (!service) return { ok: false, error: "Unknown service." };
  if (!service.base) return { ok: false, error: `${name} is not configured.` };
  try {
    const data = await upstream(service.base, service.path, {
      headers: service.key ? { "X-Api-Key": service.key } : {},
    });
    if (name === "maintainerr" && !Array.isArray(data)) throw new Error("Maintainerr did not return a collections list.");
    return { ok: true, ...(name === "jellyfin" && includeVersion ? { version: typeof data?.Version === "string" && data.Version.length <= 80 ? data.Version : null } : {}) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Resolve a Jellyfin movie or series to its TMDB id so popups can show the
// same facts panel as Seerr titles. Returns null when Jellyfin has no TMDB id.
export async function jellyfinTmdb(user, itemId) {
  const item = await upstream(
    process.env.JELLYFIN_URL,
    `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(itemId)}`,
    { headers: jellyfinHeaders(user.token, user.deviceId) },
  );
  const type = item.Type === "Movie" ? "movie" : item.Type === "Series" ? "tv" : null;
  const id = Number(item.ProviderIds?.Tmdb);
  if (!type || !Number.isSafeInteger(id) || id < 1 || id > 1e9) return null;
  return { type, id };
}

// MPAA / TV rating for search rows. Seerr only returns it on a title's own
// page, so look titles up one by one and remember the answer for a day.
// Search certification cache: bounded, expired entries pruned, isolated by viewer.
const certCache = new Map();
export async function seerrContentRatings(items, userId) {
  const headers = { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(userId) };
  const out = {};
  await Promise.all(
    items.slice(0, 30).map(async ({ type, id }) => {
      const key = JSON.stringify([process.env.SEERR_URL, userId, type, id]);
      for (const [old, entry] of certCache) if (entry.until <= Date.now()) certCache.delete(old);
      const hit = certCache.get(key);
      if (hit && hit.until > Date.now()) {
        out[key] = hit.value;
        return;
      }
      try {
        const data = await upstream(process.env.SEERR_URL, `/api/v1/${type}/${id}`, { headers });
        const value = seerrContentRating(data, type) || "";
        if (certCache.size >= 1000) certCache.delete(certCache.keys().next().value);
        certCache.set(key, { value, until: Date.now() + 86400000 });
        out[key] = value;
      } catch {
        out[key] = "";
      }
    }),
  );
  return out;
}

// Jellyfin applies this user's library permissions and viewing history.
export function personalItemSubtitle(item) {
  if (item.Type === "Episode") {
    const episode = `S${item.ParentIndexNumber ?? "?"}E${item.IndexNumber ?? "?"}`;
    return [episode, item.Name].filter(Boolean).join(" · ");
  }
  const label = { Movie: "Movie", Series: "Series", Season: "Season" }[item.Type] || (item.SeriesId || item.SeriesName ? "Series" : "Media");
  const season = item.Type === "Season" && item.IndexNumber != null ? `Season ${item.IndexNumber}` : label;
  return [item.ProductionYear, season].filter(Boolean).join(" · ");
}
export const PERSONAL_ACTIVITY_DAYS = 180;
export function isRecentResume(item, now = Date.now()) {
  const value = item.UserData?.LastPlayedDate;
  const played = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(played) && played >= now - PERSONAL_ACTIVITY_DAYS * 86400000 && played <= now;
}
export function uniquePlaybackItems(items) {
  const seen = new Set();
  return items.filter(item=>{if(typeof item.Id!=="string" || !item.Id)return true;if(seen.has(item.Id))return false;seen.add(item.Id);return true;});
}
export async function personalItems(user, kind) {
  const query = new URLSearchParams({ UserId: user.id, Limit: "18", Fields: "PremiereDate,Overview,Genres,Studios,RunTimeTicks,CommunityRating,OfficialRating,People,ProviderIds", EnableUserData: "true", EnableImages: "true" });
  const endpoint = kind === "watchNext" ? "/Items" : kind === "continueWatching" ? `/Users/${encodeURIComponent(user.id)}/Items/Resume` : "/Shows/NextUp";
  if (kind === "watchNext") {
    for (const [key,value] of Object.entries({Recursive:"true",IncludeItemTypes:"Movie,Series",IsPlayed:"false",SortBy:"Random",ExcludeLocationTypes:"Virtual",IsMissing:"false",IsPlaceHolder:"false"})) query.set(key,value);
  }
  if (kind === "nextUp") { query.set("NextUpDateCutoff",new Date(Date.now() - PERSONAL_ACTIVITY_DAYS * 86400000).toISOString()); query.set("EnableResumable", "false"); query.set("EnableRewatching", "false"); }
  const data = await upstream(process.env.JELLYFIN_URL, `${endpoint}?${query}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
  const visible = (data.Items || []).filter(item => !item.IsMissing && !item.IsPlaceHolder && item.LocationType !== "Virtual" && (kind !== "watchNext" || ["Movie","Series"].includes(item.Type) && item.UserData?.Played === false && !(item.UserData?.PlaybackPositionTicks > 0) && !(item.Type === "Series" && item.UserData?.PlayedPercentage > 0))).slice(0, 18);
  const resolved = await Promise.all(visible.map(async item => {
    if (kind === "watchNext" || !["Series", "Season"].includes(item.Type)) return item;
    const seriesId = item.SeriesId || (item.Type === "Series" ? item.Id : null);
    try {
      if (kind === "continueWatching") {
        const resume = new URLSearchParams(query);
        resume.set("ParentId", item.Id); resume.set("IncludeItemTypes", "Episode"); resume.set("Limit", "1");
        const episodes = await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/Items/Resume?${resume}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
        const episode = episodes.Items?.find(e => e.Type === "Episode" && !e.IsMissing && !e.IsPlaceHolder && e.LocationType !== "Virtual");
        if (episode) return { ...episode, SeriesName: episode.SeriesName || item.SeriesName || item.Name, SeriesId: episode.SeriesId || seriesId };
      }
      if (seriesId) {
        const next = new URLSearchParams(query);
        next.set("SeriesId", seriesId); next.set("Limit", "1"); next.set("EnableResumable", "true"); next.set("EnableRewatching", "false");
        const episodes = await upstream(process.env.JELLYFIN_URL, `/Shows/NextUp?${next}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
        const episode = episodes.Items?.find(e => e.Type === "Episode" && !e.IsMissing && !e.IsPlaceHolder && e.LocationType !== "Virtual");
        if (episode) return { ...episode, SeriesName: episode.SeriesName || item.SeriesName || item.Name, SeriesId: episode.SeriesId || seriesId };
      }
    } catch (error) { if (/HTTP (401|403)\b/.test(error.message)) throw error; }
    // Metadata failures must not hide a whole shelf or invent episode numbers.
    return item;
  }));
  const filtered = resolved.filter(item => kind !== "continueWatching" || isRecentResume(item));
  return (kind === "continueWatching" || kind === "nextUp" ? uniquePlaybackItems(filtered) : filtered).map(item => {
    const ticks = item.UserData?.PlaybackPositionTicks || 0;
    const progress = item.RunTimeTicks > 0 ? Math.max(0, Math.min(100, Math.round(ticks / item.RunTimeTicks * 100))) : 0;
    return {
      id: item.SeriesId || item.Id, tmdbId: item.Type !== "Episode" && Number.isSafeInteger(Number(item.ProviderIds?.Tmdb)) && Number(item.ProviderIds?.Tmdb)>0 ? Number(item.ProviderIds.Tmdb) : null, favoriteId: item.SeriesId || item.Id, favorite: item.Type === "Episode" ? null : item.UserData?.IsFavorite === true, title: item.SeriesName || item.Name,
      watched: typeof item.UserData?.Played === "boolean" ? item.UserData.Played : null, watchedScope: item.Type === "Episode" ? "episode" : item.Type === "Series" ? "series" : item.Type === "Season" ? "season" : "movie",
      subtitle: personalItemSubtitle(item),
      image: Boolean(item.ImageTags?.Primary || item.SeriesId), art: "placeholder", link: jellyfinLink(item.Id),
      backdropId: item.ParentBackdropItemId || (item.BackdropImageTags?.length ? item.Id : item.SeriesId || null),
      progress, remaining: item.RunTimeTicks > ticks ? Math.ceil((item.RunTimeTicks - ticks) / 600000000) : null,
      detail: { episodeAirDate: item.Type === "Episode" ? item.PremiereDate || null : null, title: item.SeriesName || item.Name, subtitle: personalItemSubtitle(item), rating: normalizedRating(item.CommunityRating, "Jellyfin community"), mediaType: item.Type === "Movie" ? "movie" : "tv", network: uniqueCreditNames((item.Studios || []).map(studio => studio.Name)), year: String(item.ProductionYear || ""), overview: item.Overview || "", genres: item.Genres || [], contentRating: normalizedContentRating(item.OfficialRating), cast: topCast(item.People, true), runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null },
    };
  });
}

// Match Seerr/TMDB titles to this viewer's Jellyfin items by verified provider ID,
// never by title similarity or library availability alone.
const watchedCache = new Map();
export async function withWatched(user, items) {
  const result = items.map(item => ({ ...item, watched: null }));
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, result.length) }, async () => {
    while (cursor < result.length) {
      const item = result[cursor++], type = item.mediaType;
      const id = item.mediaId || item.id;
      if (!["movie", "tv"].includes(type) || !Number.isSafeInteger(id) || !item.title) continue;
      item.watchedScope = type === "tv" ? "series" : "movie";
      const key = `${user.id}:${user.token}:${type}:${id}`, hit = watchedCache.get(key);
      if (hit && hit.until > Date.now()) { Object.assign(item, hit.value); continue; }
      try {
        const query = new URLSearchParams({ UserId: user.id, SearchTerm: item.title, Recursive: "true", IncludeItemTypes: type === "movie" ? "Movie" : "Series", Fields: "ProviderIds", EnableUserData: "true", Limit: "50" });
        const data = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
        const matches = (data.Items || []).filter(candidate => Number(candidate.ProviderIds?.Tmdb) === id && candidate.Type === (type === "movie" ? "Movie" : "Series") && !candidate.IsMissing && !candidate.IsPlaceHolder && candidate.LocationType !== "Virtual");
        const played = matches.length && matches.every(candidate => typeof candidate.UserData?.Played === "boolean") ? matches.every(candidate => candidate.UserData.Played) : null;
        item.libraryOwned = matches.length > 0;
        item.favoriteId = matches.length === 1 ? matches[0].Id : null; item.favorite = matches.length === 1 ? matches[0].UserData?.IsFavorite === true : null;
        item.watched = played; item.watchedScope = type === "tv" ? "series" : "movie";
        if (watchedCache.size > 500) watchedCache.clear();
        watchedCache.set(key, { value: { watched: played, libraryOwned: item.libraryOwned, favoriteId: item.favoriteId, favorite: item.favorite, watchedScope: item.watchedScope }, until: Date.now() + 60000 });
      } catch { /* Watched is optional; unknown never becomes unwatched or watched. */ }
    }
  }));
  return result;
}

export async function favoriteState(user, itemId) {
  const item = await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(itemId)}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
  if (!["Movie", "Series"].includes(item.Type)) throw new Error("Only library movies or series can be favorited here.");
  return { favoriteId: item.Id || itemId, favorite: item.UserData?.IsFavorite === true };
}
export async function setFavorite(user, itemId, saved) {
  await favoriteState(user, itemId); // Verify the user can access this movie/series before writing.
  await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/FavoriteItems/${encodeURIComponent(itemId)}`, { method: saved ? "POST" : "DELETE", headers: jellyfinHeaders(user.token, user.deviceId) });
  watchedCache.clear();
}
export async function favoriteItems(user) {
  const items = []; let start = 0;
  while (items.length < 500) {
    const query = new URLSearchParams({ UserId: user.id, IsFavorite: "true", Recursive: "true", IncludeItemTypes: "Movie,Series", Fields: "Overview,Genres,Studios,RunTimeTicks,CommunityRating,OfficialRating,People,ProviderIds", EnableUserData: "true", EnableImages: "true", SortBy: "SortName", Limit: "100", StartIndex: String(start) });
    const data = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
    const page = data.Items || []; items.push(...page); start += page.length;
    if (page.length < 100 || (Number.isFinite(data.TotalRecordCount) && start >= data.TotalRecordCount)) break;
  }
  return items.slice(0, 500).filter(item => ["Movie", "Series"].includes(item.Type) && item.UserData?.IsFavorite === true).map(item => ({
    id: item.Id, tmdbId: Number.isSafeInteger(Number(item.ProviderIds?.Tmdb)) && Number(item.ProviderIds?.Tmdb)>0 ? Number(item.ProviderIds.Tmdb) : null, favoriteId: item.Id, favorite: true, title: item.Name, subtitle: personalItemSubtitle(item), image: Boolean(item.ImageTags?.Primary), art: "placeholder", link: jellyfinLink(item.Id),
    watched: typeof item.UserData?.Played === "boolean" ? item.UserData.Played : null, watchedScope: item.Type === "Series" ? "series" : "movie",
    backdropId: item.BackdropImageTags?.length ? item.Id : null,
    detail: { title: item.Name, subtitle: item.Type === "Series" ? "TV series" : "Movie", year: String(item.ProductionYear || ""), overview: item.Overview || "", genres: item.Genres || [], cast: topCast(item.People, true), contentRating: normalizedContentRating(item.OfficialRating), rating: normalizedRating(item.CommunityRating, "Jellyfin community"), runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null },
  }));
}

export function isRecentRecommendation(item, now = new Date()) {
  const cutoff = new Date(now); cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5);
  const date = item.date;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date && date >= cutoff.toISOString().slice(0,10) && date <= now.toISOString().slice(0,10);
}
export function isServerOwnedRecommendation(item) {
  return [4, 5].includes(item.mediaInfo?.status) || [4, 5].includes(item.mediaInfo?.status4k);
}
export async function recommendations(user, seerrUserId) {
  // Read enough history to skip repeat episodes of the same show and missing metadata.
  const query = new URLSearchParams({ UserId: user.id, Recursive: "true", IncludeItemTypes: "Movie,Episode", IsPlayed: "true", SortBy: "DatePlayed", SortOrder: "Descending", Fields: "ProviderIds", EnableUserData: "true", Limit: "50" });
  const history = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
  const seeds = [], seen = new Set(), series = new Map();
  for (const item of history.Items || []) {
    if (item.UserData?.Played !== true) continue;
    let source = item;
    if (item.Type === "Episode" && item.SeriesId) {
      if (!series.has(item.SeriesId)) series.set(item.SeriesId, await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.SeriesId)}`, { headers: jellyfinHeaders(user.token, user.deviceId) }).catch(() => null));
      source = series.get(item.SeriesId);
    }
    if (!source || !["Movie", "Series"].includes(source.Type)) continue;
    const id = Number(source.ProviderIds?.Tmdb), type = source.Type === "Movie" ? "movie" : "tv", key = `${type}:${id}`;
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(key)) continue;
    seen.add(key); seeds.push({ id, type, title: source.Name });
    if (seeds.length === 5) break;
  }
  if (!seeds.length) return { seed: null, seeds: [], items: [] };
  // Fetch once per distinct title, in parallel. A failed seed need not hide the others.
  const responses = await Promise.allSettled(seeds.map(async seed => {
    const data = await upstream(process.env.SEERR_URL, `/api/v1/${seed.type}/${seed.id}/recommendations?page=1`, { headers: { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(seerrUserId) } });
    return normalizeSeerrResults({ results: (data.results || []).filter(item => !isServerOwnedRecommendation(item)).map(item => ({ ...item, mediaType: seed.type })) });
  }));
  if (responses.every(response => response.status === "rejected")) throw responses[0].reason;
  const pools = responses.filter(response => response.status === "fulfilled").map(response => response.value);
  const items = [], maxLength = Math.max(0, ...pools.map(pool => pool.length));
  // Round-robin keeps the first show's list from crowding out movies or other shows.
  for (let index = 0; index < maxLength && items.length < 20; index++) {
    for (const pool of pools) {
      const item = pool[index];
      if (!item || !isRecentRecommendation(item)) continue;
      const key = `${item.mediaType}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key); items.push(item);
      if (items.length === 20) break;
    }
  }
  const checked = await withWatched(user, items);
  const unowned = checked.filter(item => item.libraryOwned !== true);
  return { seed: seeds[0].title, seeds: seeds.map(seed => seed.title), items: await withShelfCertifications(unowned, seerrUserId) };
}

// One bounded root listing and count-only queries, all using this viewer's token.
export async function jellyfinLibraryStats(user, kidsLibrary = "", kidsShowsLibrary = "") {
  const headers = jellyfinHeaders(user.token, user.deviceId);
  const rootQuery = new URLSearchParams({UserId:user.id,Recursive:"false",EnableImages:"false",EnableUserData:"false",Limit:"100"});
  const root = await upstream(process.env.JELLYFIN_URL, `/Items?${rootQuery}`, {headers});
  if (root.TotalRecordCount > 100) throw new Error("Too many libraries to count safely.");
  const libraries = (root.Items || []).filter(item=>["movies","tvshows"].includes(item.CollectionType) && typeof item.Id === "string" && typeof item.Name === "string").map(item=>({id:item.Id,name:item.Name,type:item.CollectionType}));
  const moviesLibraries=libraries.filter(lib=>lib.type === "movies"),showsLibraries=libraries.filter(lib=>lib.type === "tvshows");
  const selected = kidsLibrary ? moviesLibraries.find(lib=>lib.id === kidsLibrary) : moviesLibraries.find(lib=>lib.name.trim().toLowerCase() === "kids movies");
  const selectedShows = kidsShowsLibrary ? showsLibraries.find(lib=>lib.id === kidsShowsLibrary) : showsLibraries.find(lib=>lib.name.trim().toLowerCase() === "kids shows");
  const count = async (type,parentId="")=>{
    const query = new URLSearchParams({UserId:user.id,Recursive:"true",IncludeItemTypes:type,ExcludeLocationTypes:"Virtual",IsMissing:"false",IsPlaceHolder:"false",EnableImages:"false",EnableUserData:"false",EnableTotalRecordCount:"true",Limit:"0"});
    if(parentId)query.set("ParentId",parentId);
    const result = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`,{headers});
    if(!Number.isSafeInteger(result.TotalRecordCount) || result.TotalRecordCount < 0)throw new Error("Jellyfin did not return a valid count.");
    return result.TotalRecordCount;
  };
  const [movies,tvShows,episodes,kidsMovies,kidsShows,kidsEpisodes] = await Promise.all([count("Movie"),count("Series"),count("Episode"),selected ? count("Movie",selected.id) : null,selectedShows ? count("Series",selectedShows.id) : null,selectedShows ? count("Episode",selectedShows.id) : null]);
  if(kidsMovies > movies || kidsShows > tvShows || kidsEpisodes > episodes)throw new Error("Jellyfin library counts disagree.");
  return {libraries,kidsLibrary:selected?.id || "",kidsShowsLibrary:selectedShows?.id || "",selectionUnavailable:Boolean(kidsLibrary && !selected || kidsShowsLibrary && !selectedShows),counts:{movies:selected ? movies-kidsMovies : null,kidsMovies,tvShows:selectedShows ? tvShows-kidsShows : null,kidsShows,episodes:selectedShows ? episodes-kidsEpisodes : null,kidsEpisodes}};
}
