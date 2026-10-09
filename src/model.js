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
