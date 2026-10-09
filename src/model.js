export function normalizedRating(value, source, votes) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 10 &&
    votes !== 0
    ? { value, source }
    : null;
}

export function episodeStatus(episode, now = new Date()) {
  if (episode.hasFile) return "available";
  if (!episode.airDateUtc || new Date(episode.airDateUtc) > now)
    return "upcoming";
  return "missing";
}

export function movieStatus(movie, release, now = new Date()) {
  if (movie.hasFile) return "available";
  if (new Date(release) > now) return "unreleased";
  return "missing";
}

export function normalizeEpisodes(rows, now = new Date()) {
  return rows
    .filter((row) => row.airDateUtc)
    .map((row) => ({
      id: `tv-${row.id}`,
      type: "tv",
      title: row.series?.title || "Untitled series",
      subtitle: `S${String(row.seasonNumber).padStart(2, "0")}E${String(row.episodeNumber).padStart(2, "0")} · ${row.title || "Untitled episode"}`,
      date: row.airDateUtc,
      status: episodeStatus(row, now),
      monitored: Boolean(row.monitored && (row.series?.monitored ?? true)),
      premiere: row.episodeNumber === 1 && row.seasonNumber > 0,
      year: row.series?.year || null,
      tmdbId:
        Number.isSafeInteger(row.series?.tmdbId) && row.series.tmdbId > 0 && row.series.tmdbId <= 1e9
          ? row.series.tmdbId
          : null,
      contentRating: normalizedContentRating(row.series?.certification),
      rating:
        normalizedRating(
          row.series?.ratings?.tmdb?.value,
          "TMDB",
          row.series?.ratings?.tmdb?.votes,
        ) ||
        normalizedRating(
          row.series?.ratings?.imdb?.value,
          "IMDb",
          row.series?.ratings?.imdb?.votes,
        ),
      network:
        typeof row.series?.network === "string" ? row.series.network : null,
      runtime: row.runtime || row.series?.runtime || null,
      genres: Array.isArray(row.series?.genres)
        ? row.series.genres.slice(0, 8)
        : [],
      overview:
        row.overview || row.series?.overview || "Overview not available yet.",
      seriesId: row.seriesId || row.series?.id || null,
      localPoster:
        row.series?.images?.find((image) => image.coverType === "poster")
          ?.url || null,
      poster:
        row.series?.images?.find((image) => image.coverType === "poster")
          ?.remoteUrl || null,
      localBackdrop:
        row.series?.images?.find((image) => image.coverType === "fanart")
          ?.url || null,
      backdrop:
        row.series?.images?.find((image) => image.coverType === "fanart")
          ?.remoteUrl || null,
    }));
}

export function normalizeMovies(rows, now = new Date()) {
  // Cinema and home (digital/physical) releases are separate entries: a film
  // can leave theaters months before it is rentable; both matter here.
  return rows.flatMap((row) => {
    const studio = row.studio || "Studio not provided";
    const home = row.digitalRelease || row.physicalRelease;
    const monitored = Boolean(row.monitored);
    const entries = [];
    if (row.inCinemas)
      entries.push({
        id: `movie-${row.id}-cinema`,
        type: "movie",
        contentRating: normalizedContentRating(row.certification),
        title: row.title,
        subtitle: `${studio} · In cinemas`,
        date: row.inCinemas,
        status: "cinema",
        monitored,
      });
    if (home && home !== row.inCinemas)
      entries.push({
        id: `movie-${row.id}-digital`,
        type: "movie",
        contentRating: normalizedContentRating(row.certification),
        title: row.title,
        subtitle: `${studio} · Digital release`,
        date: home,
        status: movieStatus(row, home, now),
        monitored,
      });
    return entries;
  });
}

export function validateRange(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  return (
    Number.isFinite(+a) &&
    Number.isFinite(+b) &&
    b > a &&
    b - a <= 1000 * 60 * 60 * 24 * 62
  );
}

export function normalizeSeerrResults(data) {
  return (data.results || [])
    .filter(
      (r) =>
        r && ["movie", "tv"].includes(r.mediaType) && Number.isInteger(r.id),
    )
    .map((r) => ({
      id: r.id,
      mediaType: r.mediaType,
      title: String(r.title || r.name || "Untitled"),
      year: String(r.releaseDate || r.firstAirDate || "").slice(0, 4),
      poster:
        typeof r.posterPath === "string" &&
        /^\/[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/.test(r.posterPath)
          ? r.posterPath
          : null,
      rating: normalizedRating(r.voteAverage, "TMDB", r.voteCount),
      overview: typeof r.overview === "string" ? r.overview.slice(0, 300) : "",
      availability: Number.isInteger(r.mediaInfo?.status)
        ? r.mediaInfo.status
        : null,
      requested:
        [2, 3, 4, 5].includes(r.mediaInfo?.status) ||
        (Array.isArray(r.mediaInfo?.requests) && r.mediaInfo.requests.length > 0),
    }))
    .slice(0, 40);
}

export function normalizeSeerrRequests(data) {
  return (data.results || [])
    .map((r) => ({
      id: r.id,
      tmdbId:
        Number.isSafeInteger(r.media?.tmdbId) &&
        r.media.tmdbId > 0 &&
        r.media.tmdbId <= 1e9
          ? r.media.tmdbId
          : null,
      title: String(
        r.media?.title ||
          r.media?.name ||
          r.title ||
          r.name ||
          `TMDB #${r.media?.tmdbId ?? r.id ?? "?"}`,
      ),
      mediaType: ["movie", "tv"].includes(r.media?.mediaType)
        ? r.media.mediaType
        : "movie",
      status: Number.isInteger(r.status) ? r.status : null,
      availability: Number.isInteger(r.media?.status) ? r.media.status : null,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
      requestedBy: String(
        r.requestedBy?.displayName ||
          r.requestedBy?.username ||
          "Unknown requester",
      ),
    }))
    .slice(0, 10);
}

export function normalizedContentRating(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 30 && /^[A-Za-z0-9 +().:/-]+$/.test(text)
    ? text
    : null;
}
export function seerrContentRating(data, type) {
  if (type === "movie") {
    const releases =
      data.releases?.results?.find((r) => r.iso_3166_1 === "US")
        ?.release_dates || [];
    return normalizedContentRating(
      releases.find((r) => normalizedContentRating(r.certification))
        ?.certification,
    );
  }
  return normalizedContentRating(
    data.contentRatings?.results?.find((r) => r.iso_3166_1 === "US")?.rating,
  );
}

export function topCast(people, jellyfin = false) {
  if (!Array.isArray(people)) return [];
  const actors = jellyfin
    ? people.filter((p) => p.Type === "Actor")
    : [...people].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return [
    ...new Set(
      actors
        .map((p) => (jellyfin ? p.Name : p.name))
        .filter((n) => typeof n === "string" && n.trim() && n.length <= 120)
        .map((n) => n.trim()),
    ),
  ].slice(0, 4);
}

// Facts for the detail popups (looked up through Seerr). Missing data stays missing.
export function seerrFacts(data, type, ratings = {}) {
  const score = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  const day = (v) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(T|$)/.test(v)) return null;
    const d = v.slice(0, 10);
    const date = new Date(`${d}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === d ? d : null;
  };
  const region = data.releases?.results?.find(r => r.iso_3166_1 === "US");
  const releases = [];
  for (const [code, label] of [[3, "Theatrical"], [4, "Digital"], [5, "Physical"]]) {
    const dates = (region?.release_dates || []).filter(r => r.type === code).map(r => day(r.release_date)).filter(Boolean).sort();
    if (dates.length) releases.push({ type: label, date: dates[0], region: "US" });
  }
  if (!releases.length) {
    const date = day(type === "tv" ? data.firstAirDate : data.releaseDate);
    if (date) releases.push({ type: type === "tv" ? "First aired" : "Release", date, region: null });
  }
  return {
    status: typeof data.status === "string" ? data.status.slice(0, 80) : null,
    productionCountries: (Array.isArray(data.productionCountries) ? data.productionCountries : []).filter(c => /^[A-Z]{2}$/.test(c.iso_3166_1) && typeof c.name === "string").slice(0, 12).map(c => ({ code: c.iso_3166_1, name: c.name.slice(0, 100) })),
    originalLanguage: typeof data.originalLanguage === "string" && /^[a-z]{2,3}$/.test(data.originalLanguage) ? data.originalLanguage : null,
    releases,
    scores: {
      critics: score(ratings.rt?.criticsScore, 100),
      audience: score(ratings.rt?.audienceScore, 100),
      imdb: score(ratings.imdb?.criticsScore, 10),
      tmdb: data.voteCount > 0 && score(data.voteAverage, 10) !== null ? Math.round(data.voteAverage * 10) : null,
    },
  };
}
