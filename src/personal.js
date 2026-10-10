// Only display preferences can be synced. Device location and API credentials never can.
export const displayPreferenceDefaults = {
  recent: true, calendar: true, legend: true, addedDates: true,
  shelfNavigation: true, search: false, hideUnmonitored: false,
  requests: true, popular: true, ratings: true, jellyfinLink: true,
  popularCollapsed: false, defaultView: "auto", watchlist: false,
  continueWatching: false, nextUp: false, watchlistCollapsed: false,
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
  if (value.lastView !== undefined) {
    if (!["month", "week", "day", "agenda", "list"].includes(value.lastView)) return null;
    clean.lastView = value.lastView;
  }
  return clean;
}
