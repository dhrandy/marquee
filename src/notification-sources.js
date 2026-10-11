import { upstream, jellyfinHeaders, seerrIdentity } from "./adapters.js";

const physical = (item) =>
  !item.IsMissing && !item.IsPlaceHolder && item.LocationType !== "Virtual";
const libraryHeaders = (user) => ({
  headers: jellyfinHeaders(user.token, user.deviceId),
});

async function libraryItems(user, filters) {
  const items = [];
  for (let start = 0; start < 10000; start += 200) {
    const query = new URLSearchParams({
      UserId: user.id,
      Recursive: "true",
      Fields: "ProviderIds,MediaSources,DateCreated",
      EnableUserData: "true",
      StartIndex: String(start),
      Limit: "200",
      ...filters,
    });
    const data = await upstream(
      process.env.JELLYFIN_URL,
      `/Users/${encodeURIComponent(user.id)}/Items?${query}`,
      libraryHeaders(user),
    );
    if (!Array.isArray(data.Items))
      throw new Error("Jellyfin did not return library items.");
    items.push(...data.Items.filter(physical));
    if (
      data.Items.length < 200 ||
      start + data.Items.length >= data.TotalRecordCount
    )
      return items;
  }
  throw new Error("Library result is too large to verify notifications.");
}

export async function reminderShows(user, query = "") {
  const items = await libraryItems(user, {
    IncludeItemTypes: "Series",
    ...(query ? { SearchTerm: query } : {}),
  });
  return items
    .slice(0, 100)
    .map((item) => ({
      id: item.Id,
      title: item.Name,
      tmdbId: Number(item.ProviderIds?.Tmdb) || null,
      tvdbId: Number(item.ProviderIds?.Tvdb) || null,
    }));
}

async function playable(user, item) {
  const details = await upstream(
    process.env.JELLYFIN_URL,
    `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(item.Id)}?Fields=MediaSources`,
    libraryHeaders(user),
  );
  return (
    physical(details) &&
    details.PlayAccess !== "None" &&
    details.MediaSources?.some(
      (source) => source.Path && source.Type !== "Placeholder",
    )
  );
}

export async function notificationSnapshot(user, preferences) {
  // This also detects revoked upstream tokens before sending any private titles.
  const account = await upstream(
    process.env.JELLYFIN_URL,
    `/Users/${encodeURIComponent(user.id)}`,
    libraryHeaders(user),
  );
  if (
    account.Policy?.IsDisabled ||
    account.Policy?.EnableMediaPlayback === false
  )
    throw new Error("Jellyfin playback is not permitted.");
  const episodes = [];
  const selected = [];
  for (const show of preferences.shows) {
    // Resolve using the authenticated viewer, not a global server/API key view.
    const series = await upstream(
      process.env.JELLYFIN_URL,
      `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(show.id)}?Fields=ProviderIds`,
      libraryHeaders(user),
    );
    if (series.Type !== "Series") continue;
    selected.push({
      ...show,
      title: series.Name,
      tmdbId: Number(series.ProviderIds?.Tmdb) || null,
      tvdbId: Number(series.ProviderIds?.Tvdb) || null,
    });
    if (!show.available) continue;
    const items = await libraryItems(user, {
      ParentId: show.id,
      IncludeItemTypes: "Episode",
    });
    for (const item of items)
      if (await playable(user, item))
        episodes.push({
          id: item.Id,
          showId: show.id,
          title: series.Name,
          subtitle: `S${item.ParentIndexNumber ?? "?"}E${item.IndexNumber ?? "?"}`,
        });
  }
  const airings = [];
  if (
    selected.some((show) => show.airs) &&
    process.env.SONARR_URL &&
    process.env.SONARR_API_KEY
  ) {
    const now = new Date();
    const query = new URLSearchParams({
      start: new Date(now.getTime() - 86400000).toISOString(),
      end: new Date(now.getTime() + 86400000).toISOString(),
      includeSeries: "true",
    });
    const rows = await upstream(
      process.env.SONARR_URL,
      `/api/v3/calendar?${query}`,
      { headers: { "X-Api-Key": process.env.SONARR_API_KEY } },
    );
    if (!Array.isArray(rows)) throw new Error("Sonarr did not return airings.");
    for (const row of rows) {
      const show = selected.find(
        (show) =>
          show.airs &&
          ((show.tvdbId && show.tvdbId === row.series?.tvdbId) ||
            (show.tmdbId && show.tmdbId === row.series?.tmdbId)),
      );
      if (show && row.airDateUtc)
        airings.push({
          id: String(row.id),
          title: show.title,
          date: row.airDateUtc,
        });
    }
  }
  const requests = [];
  if (
    preferences.requests &&
    process.env.SEERR_URL &&
    process.env.SEERR_API_KEY
  ) {
    const identity = await seerrIdentity(user.id);
    const seerrUser = identity.id;
    if (!Number.isSafeInteger(seerrUser))
      throw new Error("Could not verify Seerr account.");
    const headers = {
      "X-Api-Key": process.env.SEERR_API_KEY,
      "X-API-User": String(seerrUser),
    };
    for (let start = 0; start < 10000; start += 100) {
      const data = await upstream(
        process.env.SEERR_URL,
        `/api/v1/request?take=100&skip=${start}&sort=added&filter=all&requestedBy=${seerrUser}`,
        { headers },
      );
      if (!Array.isArray(data.results))
        throw new Error("Seerr did not return requests.");
      for (const request of data.results) {
        // Defense in depth: don't trust filter behavior to enforce ownership.
        if (request.requestedBy?.id !== seerrUser) continue;
        const media = request.media,
          type = request.type || media?.mediaType;
        if (
          !Number.isSafeInteger(media?.tmdbId) ||
          !["movie", "tv"].includes(type) ||
          media.status !== 5
        )
          continue;
        const details = await upstream(
          process.env.SEERR_URL,
          `/api/v1/${type}/${media.tmdbId}`,
          { headers },
        );
        const matches = await libraryItems(user, {
          IncludeItemTypes: type === "movie" ? "Movie" : "Series",
          SearchTerm: details.title || details.name || "",
          AnyProviderIdEquals: `tmdb.${media.tmdbId}`,
        });
        let ready = false;
        for (const match of matches.filter(
          (item) => Number(item.ProviderIds?.Tmdb) === media.tmdbId,
        )) {
          if (type === "movie") ready = await playable(user, match);
          else {
            const children = await libraryItems(user, {
              ParentId: match.Id,
              IncludeItemTypes: "Episode",
            });
            const seasons = (request.seasons || []).map(
              (season) => season.seasonNumber,
            );
            const wanted = children.filter(
              (item) =>
                !seasons.length || seasons.includes(item.ParentIndexNumber),
            );
            ready = wanted.length > 0;
            for (const item of wanted)
              if (!(await playable(user, item))) ready = false;
          }
          if (ready) break;
        }
        if (ready)
          requests.push({
            id: String(request.id),
            title: details.title || details.name || "Your request",
          });
      }
      if (data.results.length < 100) break;
      if (start === 9900)
        throw new Error("Request history is too large to verify.");
    }
  }
  return { episodes, requests, airings };
}
