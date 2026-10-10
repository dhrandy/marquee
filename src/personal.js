// Only display preferences can be synced. Device location and API credentials never can.
export const displayPreferenceDefaults = {
  recent: true, calendar: true, legend: true, addedDates: true,
  shelfNavigation: true, search: true, hideUnmonitored: false,
  requests: true, popular: true, ratings: true, jellyfinLink: true,
  popularCollapsed: false, defaultView: "auto", watchlist: false,
  recommendations: false, myRequests: false, continueWatching: false, nextUp: false, watchlistCollapsed: false,
  continueWatchingCollapsed: false, nextUpCollapsed: false,
};
export function cleanDisplayPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clean = {};
  for (const [key, defaultValue] of Object.entries(displayPreferenceDefaults)) {
    if (!(key in value)) continue;
    if (typeof defaultValue === "boolean") {
      if (typeof value[key] !== "boolean") return null;
    } else if (!["auto", "month", "week", "day", "agenda", "list"].includes(value[key])) return null;
    clean[key] = value[key];
  }
  if (value.shelfRefreshMinutes !== undefined) {
    if (![0, 1, 2, 5, 10, 15].includes(value.shelfRefreshMinutes)) return null;
    clean.shelfRefreshMinutes = value.shelfRefreshMinutes;
  }
  if (value.lastView !== undefined) {
    if (!["month", "week", "day", "agenda", "list"].includes(value.lastView)) return null;
    clean.lastView = value.lastView;
  }
  return clean;
}

export const sectionOrderDefaults = ["search", "weather", "watchlist", "continueWatching", "nextUp", "recent", "calendar", "recommendations", "popular", "requests"];
export function cleanSectionOrder(value) {
  if (Array.isArray(value) && value.length === sectionOrderDefaults.length - 1 && !value.includes("recommendations") && new Set(value).size === value.length && value.every(key => sectionOrderDefaults.includes(key))) { value = [...value]; value.splice(value.indexOf("popular"), 0, "recommendations"); }
  if (!Array.isArray(value) || value.length !== sectionOrderDefaults.length || new Set(value).size !== value.length || value.some(key => !sectionOrderDefaults.includes(key))) return null;
  return [...value];
}
