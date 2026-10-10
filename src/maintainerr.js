import { upstream, jellyfinHeaders, jellyfinLink, personalItemSubtitle } from "./adapters.js";

// Read only. No Maintainerr handling, membership, settings or deletion calls.
export function leavingCandidates(collections) {
  if (!Array.isArray(collections)) throw new Error("Maintainerr did not return a collections list.");
  const candidates = [];
  for (const collection of collections) {
    if (collection.mediaServerType !== "jellyfin" || collection.isActive !== true || ![0, 1, 2].includes(collection.arrAction)) continue;
    const days = collection.deleteAfterDays == null ? 0 : Number(collection.deleteAfterDays);
    if (!Number.isFinite(days) || days < 0 || days > 36500 || !Number.isSafeInteger(collection.id)) continue;
    if (!Array.isArray(collection.media)) throw new Error("Maintainerr membership is unavailable.");
    for (const member of collection.media) {
      if (member.ruleEvaluationFailed === true && !(member.isManual || member.manualMembershipSource)) continue;
      const id = String(member.mediaServerId || "");
      const added = Date.parse(member.addDate), due = added + days * 86400000;
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || !Number.isFinite(due)) continue;
      candidates.push({ id, collectionId: collection.id, due: new Date(due).toISOString(), immediate: collection.deleteAfterDays == null });
    }
  }
  return candidates.sort((a, b) => a.due.localeCompare(b.due));
}
export async function leavingSoon(user) {
  const headers = process.env.MAINTAINERR_API_KEY ? { "X-Api-Key": process.env.MAINTAINERR_API_KEY } : {};
  const collections = await upstream(process.env.MAINTAINERR_URL, "/api/collections/overlay-data", { headers });
  const candidates = leavingCandidates(collections);
  if (candidates.length > 500) throw new Error("Maintainerr has too many scheduled items for this shelf.");
  const exclusionsByCollection = new Map();
  for (const id of new Set(candidates.map(item => item.collectionId))) {
    const excluded = new Set(); let complete = false;
    for (let page = 1; page <= 10; page++) {
      const data = await upstream(process.env.MAINTAINERR_URL, `/api/collections/exclusions/${id}/content/${page}?size=100`, { headers });
      if (!Array.isArray(data?.items) || !Number.isFinite(Number(data.totalSize))) throw new Error("Maintainerr exclusions could not be verified.");
      for (const row of data.items) { if (row.mediaServerId) excluded.add(String(row.mediaServerId)); }
      if (page * 100 >= Number(data.totalSize)) { complete = true; break; }
    }
    if (!complete) throw new Error("Maintainerr exclusions exceed this shelf's limit.");
    exclusionsByCollection.set(id, excluded);
  }
  const items = [], seen = new Set(), globalExclusions = new Map();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    let item;
    try { item = await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}/Items/${encodeURIComponent(candidate.id)}`, { headers: jellyfinHeaders(user.token, user.deviceId) }); }
    catch (error) { if (/HTTP (401|403|404)\./.test(error.message)) continue; throw new Error("Jellyfin accessibility could not be verified."); } // Never disclose inaccessible items; transient outages are errors, not empty shelves.
    if (item?.Id !== candidate.id || !["Movie", "Series", "Season", "Episode"].includes(item.Type)) continue;
    const excluded = exclusionsByCollection.get(candidate.collectionId);
    if ([item.Id, item.SeriesId, item.SeasonId].some(id => id && excluded.has(String(id)))) continue;
    // Manual collections may have no rule group; the collection exclusion page
    // can then omit global protections. Check the item and real ancestors too.
    let protectedGlobally = false;
    for (const id of new Set([item.Id, item.SeriesId, item.SeasonId].filter(Boolean))) {
      const rows = globalExclusions.has(id) ? globalExclusions.get(id) : await upstream(process.env.MAINTAINERR_URL, `/api/rules/exclusion?mediaServerId=${encodeURIComponent(id)}`, { headers });
      if (!Array.isArray(rows)) throw new Error("Maintainerr global exclusions could not be verified.");
      globalExclusions.set(id, rows);
      if (rows.some(row => row.ruleGroupId == null && String(row.mediaServerId) === String(id))) protectedGlobally = true;
    }
    if (protectedGlobally) continue;
    seen.add(candidate.id);
    const favoriteId = item.Type === "Movie" || item.Type === "Series" ? item.Id : item.SeriesId || null;
    items.push({ id: item.Id, title: item.SeriesName || item.Name, subtitle: personalItemSubtitle(item), leavingAt: candidate.due, immediate: candidate.immediate,
      image: Boolean(item.ImageTags?.Primary), art: "placeholder", link: jellyfinLink(item.Id), favoriteId, favorite: ["Movie", "Series"].includes(item.Type) ? item.UserData?.IsFavorite === true : null,
      watched: typeof item.UserData?.Played === "boolean" ? item.UserData.Played : null, watchedScope: item.Type.toLowerCase(),
      detail: { title: item.SeriesName || item.Name, subtitle: personalItemSubtitle(item), overview: item.Overview || "", genres: item.Genres || [], year: String(item.ProductionYear || "") } });
    if (items.length >= 24) break;
  }
  return items;
}
