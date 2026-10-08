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
  if (!base) throw new Error("Service not configured");
  const url = new URL(base.replace(/\/$/, "") + path);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Invalid service URL");
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Service returned ${response.status}`);
  return response.json();
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
  const query = new URLSearchParams({
    UserId: user.id,
    SortBy: "DateCreated",
    SortOrder: "Descending",
    Recursive: "true",
    IncludeItemTypes: "Movie,Episode",
    Limit: "18",
    Fields: "DateCreated",
    EnableUserData: "true",
  });
  const data = await upstream(process.env.JELLYFIN_URL, `/Items?${query}`, {
    headers: jellyfinHeaders(user.token),
  });
  const groups = new Map();
  for (const item of data.Items || []) {
    const key = item.Type === "Episode" ? item.SeasonId || item.Id : item.Id;
    if (!groups.has(key)) groups.set(key, item);
  }
  return Promise.all(
    [...groups.values()].map(async (item) => {
      let count;
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
      }
      const imageId = item.SeriesId || item.Id;
      return {
        id: imageId,
        title: item.SeriesName || item.Name,
        subtitle:
          item.Type === "Episode"
            ? `Season ${item.ParentIndexNumber || 0} / ${count ?? "Unknown"} Episodes`
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
        return { events: service.normalize(rows) };
      } catch {
        return {
          events: [],
          warning: `${service.name} could not be reached. Check its connection settings.`,
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

export async function seerrSearch(query, page) {
  const params = new URLSearchParams({ query, page: String(page) });
  const data = await upstream(
    process.env.SEERR_URL,
    `/api/v1/search?${params}`,
    {
      headers: { "X-Api-Key": process.env.SEERR_API_KEY },
    },
  );
  return normalizeSeerrResults(data);
}

export async function seerrRequest(mediaType, mediaId) {
  return upstream(process.env.SEERR_URL, "/api/v1/request", {
    method: "POST",
    headers: { "X-Api-Key": process.env.SEERR_API_KEY },
    body: { mediaType, mediaId },
  });
}

export async function seerrRequests() {
  const data = await upstream(
    process.env.SEERR_URL,
    "/api/v1/request?take=10&skip=0&sort=added&filter=all",
    { headers: { "X-Api-Key": process.env.SEERR_API_KEY } },
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
    const url = new URL(service.base.replace(/\/$/, "") + service.path);
    if (!["http:", "https:"].includes(url.protocol))
      return { ok: false, error: "The configured URL is not valid HTTP(S)." };
    const headers = service.key ? { "X-Api-Key": service.key } : {};
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok)
      return {
        ok: false,
        error: `Answered HTTP ${response.status}. Check the ${service.key ? "URL and API key" : "URL"}.`,
      };
    return { ok: true };
  } catch (error) {
    const code = error.cause?.code;
    const detail =
      code === "ENOTFOUND"
        ? "Host not found (DNS). Check the URL."
        : code === "ECONNREFUSED"
          ? "Connection refused. Check the port and that the service is running."
          : error.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT"
            ? "Timed out. The service did not answer."
            : `Could not connect: ${error.cause?.message || error.message}`;
    return { ok: false, error: detail };
  }
}
