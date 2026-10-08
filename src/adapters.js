import {
  normalizeEpisodes,
  normalizeMovies,
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
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
  } catch (error) {
    throw new Error(connectionError(error));
  }
  if (!response.ok)
    throw new Error(
      `Service answered HTTP ${response.status}. Check its URL and API key or credentials.`,
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

export function jellyfinHeaders(token = "") {
  return {
    Authorization: `MediaBrowser Client="Marquee", Device="Web", DeviceId="marquee-web", Version="0.1.0"${token ? `, Token="${token}"` : ""}`,
  };
}

export async function authenticate(username, password) {
  const auth = await upstream(
    process.env.JELLYFIN_URL,
    "/Users/AuthenticateByName",
    {
      method: "POST",
      headers: jellyfinHeaders(),
      body: { Username: username, Pw: password },
    },
  );
  if (!auth.User?.Id || !auth.AccessToken)
    throw new Error("Invalid authentication response");
  return {
    id: auth.User.Id,
    name: auth.User.Name,
    token: auth.AccessToken,
    isAdmin: auth.User.Policy?.IsAdministrator === true,
  };
}

export async function recentItems(user) {
  // Limit cards after season grouping, not raw episodes. Large imports can
  // otherwise fill an entire Jellyfin page with only one or two seasons.
  const groups = new Map();
  const pageSize = 100;
  let startIndex = 0;
  while (groups.size < 18) {
    const query = new URLSearchParams({
      UserId: user.id,
      SortBy: "DateCreated,SortName",
      SortOrder: "Descending",
      Recursive: "true",
      IncludeItemTypes: "Movie,Episode",
      Limit: String(pageSize),
      StartIndex: String(startIndex),
      Fields: "DateCreated",
      EnableUserData: "true",
      EnableTotalRecordCount: "true",
    });
    const data = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, {
      headers: jellyfinHeaders(user.token),
    });
    const items = data.Items || [];
    for (const item of items) {
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
          Limit: "0",
          EnableTotalRecordCount: "true",
        });
        const season = await upstream(
          process.env.JELLYFIN_URL,
          `/Items?${params}`,
          { headers: jellyfinHeaders(user.token) },
        );
        count = season.TotalRecordCount;
        if (seasonNumber === null) {
          try {
            const details = await upstream(
              process.env.JELLYFIN_URL,
              `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.SeasonId)}`,
              { headers: jellyfinHeaders(user.token) },
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
        art: "placeholder",
        tagline: "",
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
  const params = new URLSearchParams({ query, page: String(page) });
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/search?${params}`,
    {
      headers: {
        "X-Api-Key": process.env.SEERR_API_KEY,
        "X-API-User": String(userId),
      },
    },
  );
  return normalizeSeerrResults(data);
}

export async function seerrRequest(mediaType, mediaId, userId) {
  return upstream(process.env.SEERR_URL, "/api/v1/request", {
    method: "POST",
    headers: { "X-Api-Key": process.env.SEERR_API_KEY },
    body: {
      mediaType,
      mediaId,
      userId,
      ...(mediaType === "tv" ? { seasons: "all" } : {}),
    },
  });
}

export async function seerrRequests(userId) {
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/request?take=10&skip=0&sort=added&filter=all&requestedBy=${userId}`,
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
