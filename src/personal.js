// Only display preferences can be synced. Device location and API credentials never can.
export const displayPreferenceDefaults = {
  recent: true, calendar: true, legend: true, addedDates: true,
  shelfNavigation: true, search: true, hideUnmonitored: false,
  inTheaters: true, requests: false, requestedBy: true, libraryStats: true, kidsMoviesLibrary: "", kidsShowsLibrary: "", popular: true, ratings: true, jellyfinLink: true,
  firstTab: "discover", popularCollapsed: false, defaultView: "auto", watchlist: false, watchLater: false, watchLaterCollapsed: false,
  leavingSoon: false, leavingSoonCollapsed: false, recommendations: false, myRequests: false, continueWatching: true, nextUp: true, watchNext: true, watchlistCollapsed: false,
  continueWatchingCollapsed: false, nextUpCollapsed: false, watchNextCollapsed: false, watchNextAnimation: "mixed", watchNextType: "both",
};
export function cleanDisplayPreferences(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const clean = {};
  for (const [key, defaultValue] of Object.entries(displayPreferenceDefaults)) {
    if (!(key in value)) continue;
    if (typeof defaultValue === "boolean") {
      if (typeof value[key] !== "boolean") return null;
    } else if (["kidsMoviesLibrary","kidsShowsLibrary"].includes(key)) { if (typeof value[key] !== "string" || value[key].length > 100) return null;
    } else if (key === "watchNextAnimation") { if (!["no", "only", "mixed"].includes(value[key])) return null;
    } else if (key === "watchNextType") { if (!["movie", "tv", "both"].includes(value[key])) return null;
    } else if (key === "firstTab") { if (!["discover", "home"].includes(value[key])) return null;
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

export const sectionOrderDefaults = ["search", "weather", "recent", "calendar", "popular", "inTheaters", "recommendations", "nextUp", "continueWatching", "watchNext", "watchlist", "watchLater", "leavingSoon", "requests"];
export function cleanSectionOrder(value) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(key => !sectionOrderDefaults.includes(key))) return null;
  const required = sectionOrderDefaults.filter(key => !["recommendations", "leavingSoon", "inTheaters", "watchNext", "watchLater"].includes(key));
  if (!required.every(key => value.includes(key))) return null;
  const order = [...value];
  for (const key of ["leavingSoon", "recommendations"]) if (!order.includes(key)) order.splice(order.indexOf("popular"), 0, key);
  if (!order.includes("inTheaters")) order.splice(order.indexOf("popular") + 1, 0, "inTheaters");
  if (!order.includes("watchNext")) order.splice(order.indexOf("continueWatching") + 1, 0, "watchNext");
  if (!order.includes("watchLater")) order.splice(order.indexOf("watchlist")+1,0,"watchLater");
  return order.length === sectionOrderDefaults.length ? order : null;
}
