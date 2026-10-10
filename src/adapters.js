import crypto from "node:crypto";
import {
  normalizeEpisodes,
  normalizeMovies,
  normalizedRating,
  normalizedContentRating,
  topCast,
  seerrContentRating,
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
        "DateCreated,Overview,Genres,Studios,RunTimeTicks,CommunityRating,OfficialRating,People",
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
          network: (item.Studios || [])
            .slice(0, 3)
            .map((studio) => studio.Name)
            .join(", "),
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
const jellyfinLink = (id) => {
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
    facts: seerrFacts(data, type, ratings),
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
      (type === "tv" ? data.networks : data.productionCompanies)
        ?.map((item) => item.name)
        .slice(0, 3)
        .join(", ") || null,
    runtime: data.runtime || data.episodeRunTime?.[0] || null,
    rating: normalizedRating(data.voteAverage, "TMDB", data.voteCount),
    poster: safeArt(data.posterPath),
    backdrop: safeArt(data.backdropPath) || safeArt(data.posterPath),
  };
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
  return { movies, tv };
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

export async function seerrRequests(userId) {
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/request?take=10&skip=0&sort=added&filter=all`,
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

export async function testService(name) {
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
    await upstream(service.base, service.path, {
      headers: service.key ? { "X-Api-Key": service.key } : {},
    });
    return { ok: true };
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
const certCache = new Map();
export async function seerrContentRatings(items, userId) {
  const headers = { "X-Api-Key": process.env.SEERR_API_KEY, "X-API-User": String(userId) };
  const out = {};
  await Promise.all(
    items.slice(0, 30).map(async ({ type, id }) => {
      const key = `${type}:${id}`;
      const hit = certCache.get(key);
      if (hit && hit.until > Date.now()) {
        out[key] = hit.value;
        return;
      }
      try {
        const data = await upstream(process.env.SEERR_URL, `/api/v1/${type}/${id}`, { headers });
        const value = seerrContentRating(data, type) || "";
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
export async function personalItems(user, kind) {
  const query = new URLSearchParams({ UserId: user.id, Limit: "18", Fields: "Overview,Genres,Studios,RunTimeTicks,CommunityRating,OfficialRating,People", EnableUserData: "true", EnableImages: "true" });
  const endpoint = kind === "continueWatching" ? `/Users/${encodeURIComponent(user.id)}/Items/Resume` : "/Shows/NextUp";
  if (kind === "nextUp") { query.set("EnableResumable", "false"); query.set("EnableRewatching", "false"); }
  const data = await upstream(process.env.JELLYFIN_URL, `${endpoint}?${query}`, { headers: jellyfinHeaders(user.token, user.deviceId) });
  return (data.Items || []).filter(item => !item.IsMissing && !item.IsPlaceHolder && item.LocationType !== "Virtual").slice(0, 18).map(item => {
    const ticks = item.UserData?.PlaybackPositionTicks || 0;
    const progress = item.RunTimeTicks > 0 ? Math.max(0, Math.min(100, Math.round(ticks / item.RunTimeTicks * 100))) : 0;
    return {
      id: item.SeriesId || item.Id, title: item.SeriesName || item.Name,
      subtitle: personalItemSubtitle(item),
      image: Boolean(item.ImageTags?.Primary || item.SeriesId), art: "placeholder", link: jellyfinLink(item.Id),
      progress, remaining: item.RunTimeTicks > ticks ? Math.ceil((item.RunTimeTicks - ticks) / 600000000) : null,
      detail: { title: item.SeriesName || item.Name, subtitle: item.Name || "", year: String(item.ProductionYear || ""), overview: item.Overview || "", genres: item.Genres || [], contentRating: normalizedContentRating(item.OfficialRating), cast: topCast(item.People, true), runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null },
    };
  });
}
