const $ = (selector) => document.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const state = {
  date: new Date(),
  view: "agenda",
  events: [],
  prefs: {},
  key: "",
  demo: false,
  canRequest: false,
  requestAccess: { movie: false, tv: false },
  name: "Marquee",
  cityResults: [],
  recentItems: [],
  watchlistItems: [],
  personalItems: {},
};
const defaults = {
  recent: true,
  calendar: true,
  legend: true,
  addedDates: true,
  shelfNavigation: true,
  weather: false,
  weatherLocation: false,
  weatherCity: null,
  weatherUnits: "fahrenheit",
  search: true,
  hideUnmonitored: false,
  requests: true,
  popular: true, inTheaters: true,
  ratings: true,
  requestedBy: true,
  libraryStats: true, kidsMoviesLibrary: "", kidsShowsLibrary: "",
  colorblind: false,
  jellyfinLink: true,
  popularCollapsed: false,
  defaultView: "auto",
  watchlist: true, watchLater: true, watchLaterCollapsed: false, topUnwatched: true, topUnwatchedCollapsed: false, continueWatching: true, nextUp: true, watchNext: true,
  watchlistCollapsed: false, continueWatchingCollapsed: false, nextUpCollapsed: false, watchNextCollapsed: false, watchNextAnimation: "mixed", watchNextType: "both",
  personalShelvesReset: false,
  posterSize: "standard", firstTab: "discover", leavingSoon: true, leavingSoonCollapsed: false, recommendations: true, myRequests: false, shelvesDefaultsV3: false,
  syncDisplay: false,
  shelfRefreshMinutes: 5,
  liveShelfMinutes: 1,
};
const statusLabel = {
  available: "Available",
  missing: "Missing",
  cinema: "In cinemas",
  upcoming: "Upcoming",
  unreleased: "Unreleased",
};
const availabilityText = (a) =>
  ({
    2: "Requested",
    3: "Processing",
    4: "Partially available",
    5: "Available",
  })[a] || "";
const dayKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const isToday = (date) => dayKey(date) === dayKey(new Date());
function midnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function addDays(date, amount) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}
function startOfWeek(date) {
  return addDays(midnight(date), -date.getDay());
}
let accountGeneration = 0;
function resetAccountState() {
  accountGeneration++;
  lastRequests = null; requestsVersion++; libraryStatsVersion++;
  $("#libraryStats-content").replaceChildren();
  $("#libraryStats-status").textContent="";
  $("#library-stats-settings-status").textContent="";
  for(const id of ["kids-movies-library","kids-shows-library"]) $("#"+id).innerHTML = '<option value="">Choose a library</option>';
  factsCache.clear(); certCache.clear(); shelfRequests.clear();
  for (const key of Object.keys(shelfLastLoaded)) delete shelfLastLoaded[key];
  personalLoad++; recentRequest++; calendarRequest++; factsRequest++; searchSeq++; reminderSearchVersion++;
  searchController?.abort(); clearTimeout(searchTimer); clearTimeout(reminderSearchTimer);
  $("#requests-filter").innerHTML = '<option value="all">Everyone\'s requests</option><option value="mine">My requests</option>';
  currentDetail = null; state.recentItems = []; state.watchlistItems = []; state.personalItems = {}; watchLaterKeys = new Set(); state.events = [];
  notificationShows = []; notificationEnabled = false;
  all("dialog[open]").forEach(dialog => dialog.close());
  for (const selector of ["#recent", "#calendar", "#network-matches", "#search-results", "#requests", "#recommendations-content", "#inTheaters-content", "#popular-movies", "#popular-tv", "#notify-show-list", "#notify-show-results"]) $(selector)?.replaceChildren();
  all(".personal-section .poster-row").forEach(row => row.replaceChildren());
}
async function api(path, options = {}) {
  const generation = accountGeneration;
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (generation !== accountGeneration) throw new DOMException("Account changed", "AbortError");
  if (response.status === 401 && path !== "/api/login") {
    resetAccountState();
    $("#dashboard").hidden = true;
    $("#login").hidden = false;
  }
  if (!response.ok) throw new Error(data.error || "Could not load data.");
  return data;
}
function report(error) {
  $("#global-error").textContent = error.message;
  $("#global-error").hidden = false;
}
function persist() {
  const { weather, weatherCity, weatherUnits, weatherLocation, colorblind, ...devicePrefs } =
    state.prefs;
  localStorage.setItem(state.key, JSON.stringify({ ...devicePrefs, weatherLocation: state.prefs.weatherLocation }));
  applyPrefs();
  if (state.prefs.syncDisplay) syncDisplayWrite();
}
let displayWrites = Promise.resolve();
function syncDisplayWrite() {
  const { weather, weatherCity, weatherUnits, colorblind, syncDisplay, weatherLocation, posterSize, ...value } = state.prefs;
  displayWrites = displayWrites.catch(() => {}).then(() => api("/api/display-preferences", { method: "POST", body: JSON.stringify(value) })).then(() => { $("#sync-display-status").textContent = "Display settings synced."; }).catch(error => { $("#sync-display-status").textContent = error.message; });
  return displayWrites;
}
$("#sync-display").addEventListener("change", async event => {
  const enabled = event.target.checked;
  $("#sync-display-status").textContent = enabled ? "Syncing…" : "Sync is off on this device.";
  try {
    if (enabled) {
      const { preferences } = await api("/api/display-preferences");
      if (preferences) { Object.assign(state.prefs, preferences); pageInitialized = false; }
    }
    state.prefs.syncDisplay = enabled;
    state.view = state.prefs.lastView || (state.prefs.defaultView === "auto" ? "agenda" : state.prefs.defaultView);
    persist(); buildSettings();
    await Promise.all([loadPersonalShelves(), loadRecommendations(), loadRequests(), loadCalendar(),loadLibraryStats()]);
  } catch (error) { event.target.checked = false; $("#sync-display-status").textContent = error.message; }
});
let weatherWrites = Promise.resolve();
function saveWeather() {
  const value = {
    weather: state.prefs.weather,
    weatherCity: state.prefs.weatherCity,
    weatherUnits: state.prefs.weatherUnits,
  };
  $("#weather-settings-status").textContent = "Saving…";
  weatherWrites = weatherWrites
    .catch(() => {})
    .then(async () => {
      await api("/api/weather-settings", {
        method: "POST",
        body: JSON.stringify(value),
      });
      $("#weather-settings-status").textContent = "Saved to your account.";
    })
    .catch((error) => {
      $("#weather-settings-status").textContent = error.message;
    });
  return weatherWrites;
}
const sectionLabels = { search: "Search and request", weather: "Weather", watchlist: "Favorites", watchLater: "Watchlist", topUnwatched: "Top unwatched movies", continueWatching: "Continue watching", watchNext: "What to watch next", nextUp: "Next up", recent: "Recently added", calendar: "Release calendar", leavingSoon: "Leaving soon", recommendations: "Recommendations", popular: "Popular right now", inTheaters: "In theaters", requests: "Request status" };
const defaultSectionOrder = ["search", "weather", "recent", "calendar", "popular", "inTheaters", "recommendations", "nextUp", "continueWatching", "watchNext", "watchlist", "watchLater", "topUnwatched", "leavingSoon", "requests"];
let sectionOrder = [...defaultSectionOrder], orderWrites = Promise.resolve();
const sectionElement = key => $(key === "weather" ? "#weather" : key === "popular" ? "#popular-wrap" : `#${key}-section`);
function applySectionOrder() {
  const main = $("#dashboard main"), row = $(".home-top-row");
  const visible = sectionOrder.filter(key => pageSections.discover.includes(key) && sectionElement(key) && !sectionElement(key).hidden);
  const searchAt = visible.indexOf("search"), weatherAt = visible.indexOf("weather");
  const paired = searchAt >= 0 && weatherAt >= 0 && Math.abs(searchAt - weatherAt) === 1;
  row.hidden = !paired;
  const desired = [];
  let rowPlaced = false;
  for (const key of sectionOrder) {
    const element = sectionElement(key);
    if (!element) continue;
    if (paired && ["search", "weather"].includes(key)) {
      // Always re-append: the row keeps the saved order even when the halves never left it.
      row.append(element);
      if (!rowPlaced) { desired.push(row); rowPlaced = true; }
    } else desired.push(element);
  }
  const actual = [...main.children].filter(el => desired.includes(el));
  if (desired.some((el, index) => actual[index] !== el)) {
    for (const el of desired) main.insertBefore(el, $("#nothing"));
  }
  $("#personal-shelves").hidden = true;
  main.insertBefore($("#libraryStats-section"), $("#nothing"));
  applyDashboardPage();
}
let dashboardPage = "discover";
const pageSections = { home: ["watchlist", "watchLater", "topUnwatched", "continueWatching", "nextUp", "watchNext", "leavingSoon", "requests"], discover: ["weather", "search", "recent", "popular", "inTheaters", "calendar", "recommendations"] };
let pageInitialized = false;
function applyDashboardPage() {
  if (!pageInitialized) { dashboardPage = state.prefs.firstTab === "home" ? "home" : "discover"; pageInitialized = true; }
  const home = dashboardPage === "home";
  const intro = $(".view-intro");
  if (!home && state.prefs.search) $("#search-section").prepend(intro);
  else $("#dashboard main").prepend(intro);
  $("#dashboard").dataset.page = dashboardPage;
  $("#view-kicker").textContent = home ? "YOUR COLLECTION, YOUR PACE" : "FIND YOUR NEXT FAVORITE";
  $("#view-title").textContent = home ? "Right where you left off." : "Something good is waiting.";
  $("#view-description").textContent = home ? "Keep watching, save a favorite, and catch it before it's gone." : "Explore the latest arrivals, see what's next, and find your next watch.";
  $("#libraryStats-section").classList.toggle("page-away", !home);
  const visible = pageSections[dashboardPage];
  for (const key of sectionOrder) {
    const element = sectionElement(key);
    if (element) element.classList.toggle("page-away", !visible.includes(key));
  }
  $("#nothing").hidden = (home && !$("#libraryStats-section").hidden) || visible.some(key => sectionElement(key) && !sectionElement(key).hidden);
  $("#nothing").textContent = home ? "Your On Jellyfin shelves are off. Turn on a personal shelf or Requests in Settings." : "Your Discover sections are off. Turn one on in Settings.";
  $("#page-nav").append(...(state.prefs.firstTab === "home" ? [$('button[data-page="home"]'), $('button[data-page="discover"]')] : [$('button[data-page="discover"]'), $('button[data-page="home"]')]));
  $("#tab-order").value = state.prefs.firstTab || "discover";
  all("button[data-page]").forEach(button => { if (button.dataset.page === dashboardPage) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
}
$("#poster-size").addEventListener("change", event => { state.prefs.posterSize = event.target.value; persist(); });
$("#tab-order").addEventListener("change", event => { state.prefs.firstTab = event.target.value; persist(); applyDashboardPage(); });
$("#page-nav").addEventListener("click", event => {
  const button = event.target.closest("[data-page]");
  if (!button) return;
  dashboardPage = button.dataset.page; applyDashboardPage();
  scrollTo({ top: 0, behavior: "instant" });
  autoRefreshShelves();
});
function sectionPage(key) { return pageSections.discover.includes(key) ? "discover" : "home"; }
function orderForPage(page) { return sectionOrder.filter(key => pageSections[page].includes(key)); }
function setPageOrder(page, order) {
  let index = 0;
  sectionOrder = sectionOrder.map(key => sectionPage(key) === page ? order[index++] : key);
}
function buildSectionOrder() {
  $("#section-order-list").innerHTML = ["discover", "home"].map(page => {
    const order = orderForPage(page), label = page === "discover" ? "Discover" : "On Jellyfin";
    return `<div class="page-order-group" data-order-page="${page}"><h4>${label}</h4><ol aria-label="${label} shelf order">${order.map((key, index) => `<li data-order-key="${key}"><button type="button" class="order-handle" aria-label="Drag ${sectionLabels[key]}" title="Drag to reorder">⠿</button><span class="order-name">${sectionLabels[key]}<small>${sectionElement(key)?.hidden ? "Hidden" : "Visible"}</small></span><button type="button" data-order-move="-1" aria-label="Move ${sectionLabels[key]} up" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-order-move="1" aria-label="Move ${sectionLabels[key]} down" ${index === order.length - 1 ? "disabled" : ""}>↓</button></li>`).join("")}</ol><button type="button" class="reset-page-order" data-reset-page="${page}">Reset ${label} order</button></div>`;
  }).join("");
}
function saveSectionOrder() {
  const order = [...sectionOrder];
  $("#section-order-status").textContent = "Saving…";
  orderWrites = orderWrites.catch(() => {}).then(() => api("/api/section-order", { method: "POST", body: JSON.stringify({ order }) })).then(() => { $("#section-order-status").textContent = "Saved to your account."; }).catch(error => { $("#section-order-status").textContent = error.message; });
}
function moveSection(key, index) {
  const page = sectionPage(key), order = orderForPage(page), from = order.indexOf(key);
  if (from < 0 || index < 0 || index >= order.length || from === index) return;
  order.splice(from, 1); order.splice(index, 0, key); setPageOrder(page, order);
  applySectionOrder(); buildSectionOrder(); saveSectionOrder();
}
$("#section-order-list").addEventListener("click", event => {
  const reset = event.target.closest("[data-reset-page]");
  if (reset) { const page = reset.dataset.resetPage; setPageOrder(page, defaultSectionOrder.filter(key => pageSections[page].includes(key))); applySectionOrder(); buildSectionOrder(); saveSectionOrder(); return; }
  const button = event.target.closest("[data-order-move]");
  if (!button) return;
  const key = button.closest("[data-order-key]").dataset.orderKey;
  moveSection(key, orderForPage(sectionPage(key)).indexOf(key) + Number(button.dataset.orderMove));
  $(`[data-order-key="${key}"] [data-order-move="${button.dataset.orderMove}"]`)?.focus();
});
$("#section-order-list").addEventListener("keydown", event => {
  if (!event.target.closest(".order-handle") || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault(); const key = event.target.closest("[data-order-key]").dataset.orderKey;
  moveSection(key, orderForPage(sectionPage(key)).indexOf(key) + (event.key === "ArrowUp" ? -1 : 1));
  $(`[data-order-key="${key}"] .order-handle`)?.focus();
});
let sectionDrag = null;
$("#section-order-list").addEventListener("pointerdown", event => {
  const handle = event.target.closest(".order-handle");
  if (!handle || event.button !== 0) return;
  event.preventDefault(); const item = handle.closest("li");
  sectionDrag = { key: item.dataset.orderKey, index: orderForPage(sectionPage(item.dataset.orderKey)).indexOf(item.dataset.orderKey), pointer: event.pointerId };
  handle.setPointerCapture(event.pointerId); item.classList.add("dragging");
});
$("#section-order-list").addEventListener("pointermove", event => {
  if (!sectionDrag || sectionDrag.pointer !== event.pointerId) return;
  const dialog = $("#settings"), bounds = dialog.getBoundingClientRect();
  if (event.clientY < bounds.top + 80) dialog.scrollTop -= 14;
  if (event.clientY > bounds.bottom - 80) dialog.scrollTop += 14;
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("#section-order-list li");
  all("#section-order-list .drop-target").forEach(el => el.classList.remove("drop-target"));
  if (target && sectionPage(target.dataset.orderKey) === sectionPage(sectionDrag.key)) { sectionDrag.index = orderForPage(sectionPage(sectionDrag.key)).indexOf(target.dataset.orderKey); target.classList.add("drop-target"); }
});
function finishSectionDrag(event) {
  if (!sectionDrag || sectionDrag.pointer !== event.pointerId) return;
  const drag = sectionDrag; sectionDrag = null;
  all("#section-order-list li").forEach(el => el.classList.remove("dragging", "drop-target"));
  if (event.type !== "pointercancel") moveSection(drag.key, drag.index);
}
$("#section-order-list").addEventListener("pointerup", finishSectionDrag);
$("#section-order-list").addEventListener("pointercancel", finishSectionDrag);
function applyPrefs() {
  $("#dashboard").dataset.posterSize = ["small", "large"].includes(state.prefs.posterSize) ? state.prefs.posterSize : "standard";
  document.body.classList.toggle("colorblind", Boolean(state.prefs.colorblind));
  $("#jellyfin-home").hidden =
    !state.prefs.jellyfinLink || !$("#jellyfin-home").hasAttribute("href");
  all(".media-rating").forEach((el) => {
    el.hidden = !state.prefs.ratings || !el.textContent;
  });
  $("#recent-section").hidden = !state.prefs.recent;
  $("#calendar-section").hidden = !state.prefs.calendar;
  $("#search-section").hidden = !state.prefs.search;
  $("#popular-section").hidden = !state.prefs.popular || !state.prefs.search;
  $("#popular-wrap").hidden = !state.prefs.popular || !state.prefs.search;
  $("#popular-content").hidden = Boolean(state.prefs.popularCollapsed);
  $("#popular-collapse").setAttribute(
    "aria-label",
    state.prefs.popularCollapsed
      ? "Expand popular titles"
      : "Collapse popular titles",
  );
  $("#popular-collapse").title = state.prefs.popularCollapsed
    ? "Expand"
    : "Collapse";
  $("#popular-collapse").setAttribute(
    "aria-expanded",
    String(!state.prefs.popularCollapsed),
  );
  $("#inTheaters-section").hidden = !state.prefs.inTheaters;
  $("#recommendations-section").hidden = !state.prefs.recommendations || state.recommendationsEmpty === true;
  $("#requests-filter").value = !$("#requests-filter").querySelector('[value="all"]') || state.prefs.myRequests ? "mine" : "all";
  $("#requests-section").hidden = !state.prefs.requests;
  $("#libraryStats-section").hidden = !state.prefs.libraryStats;
  $("#legend").hidden = !state.prefs.legend;
  $(".recent-controls").hidden = !state.prefs.shelfNavigation;
  all(".shelf-controls").forEach((el) => {
    el.hidden = !state.prefs.shelfNavigation;
  });
  all(".poster-card time").forEach((el) => {
    el.hidden = !state.prefs.addedDates;
  });
  for (const key of ["watchlist", "watchLater", "topUnwatched", "continueWatching", "nextUp", "watchNext", "leavingSoon"]) {
    const section = $(`#${key}-section`);
    if (section) section.hidden = !state.prefs[key] || shelfIsEmpty(key);
    const content = $(`#${key}-content`);
    if (content) content.hidden = Boolean(state.prefs[`${key}Collapsed`]);
    const collapse = $(`[data-collapse="${key}"]`);
    if (collapse) {
      collapse.setAttribute("aria-expanded", !state.prefs[`${key}Collapsed`]);
      collapse.title = `${state.prefs[`${key}Collapsed`] ? "Expand" : "Collapse"} ${sectionLabels[key]}`;
      collapse.setAttribute("aria-label", `${state.prefs[`${key}Collapsed`] ? "Expand" : "Collapse"} ${{ watchlist: "Favorites", watchLater: "Watchlist", topUnwatched: "Top unwatched movies", continueWatching: "Continue watching", watchNext: "What to watch next", nextUp: "Next up", leavingSoon: "Leaving soon" }[key]}`);
    }
  }
  $("#personal-shelves").hidden = !["watchlist", "watchLater", "topUnwatched", "continueWatching", "nextUp", "watchNext", "leavingSoon"].some(key => state.prefs[key]);
  $("#nothing").hidden = state.prefs.recent || state.prefs.calendar || state.prefs.watchlist || state.prefs.watchLater || state.prefs.topUnwatched || state.prefs.continueWatching || state.prefs.nextUp || state.prefs.watchNext || state.prefs.leavingSoon || state.prefs.recommendations;
  $("#weather").hidden = !state.prefs.weather;
  if (state.prefs.weather) loadWeather();
  scheduleWeather();
  applySectionOrder();
  updateWatchNextControls();
  scheduleShelfRefresh();
}
// Shelves that only make sense with something in them stay out of the page when empty.
const hideWhenEmpty = ["watchlist", "watchLater", "topUnwatched", "continueWatching", "nextUp", "leavingSoon"];
function shelfIsEmpty(key) {
  if (!hideWhenEmpty.includes(key)) return false;
  const items = key === "watchlist" ? state.watchlistItems : state.personalItems[key];
  return !Array.isArray(items) || !items.length;
}
function buildSettings() {
  const labels = {
    watchlist: "Favorites - Jellyfin favorites",
    watchLater: "Watchlist - starred for later",
    leavingSoon: "Leaving soon (Maintainerr)",
    recommendations: "Recommendations",
    continueWatching: "Continue watching",
    nextUp: "Next up",
    topUnwatched: "Top unwatched movies - newest, rated 7+",
    watchNext: "What to watch next - unwatched on Jellyfin",
    recent: "Recently added",
    calendar: "Release calendar",
    search: "Search and requests",
    requests: "Request status list",
    popular: "Top 10 movies and TV",
    inTheaters: "In theaters (US)",
    ratings: "Show ratings",
    requestedBy: "Requested by in title details",
    libraryStats: "Jellyfin library counts",
    colorblind: "Colorblind-friendly status colors",
    jellyfinLink: "Jellyfin shortcut",
    legend: "Calendar status legend",
    addedDates: "Poster added dates",
    shelfNavigation: "Poster navigation arrows",
    weather: "Weather (off by default)",
  };
  $("#feature-settings").innerHTML = Object.entries(labels)
    .map(
      ([key, label]) =>
        `<label class="setting">${label}<input type="checkbox" data-pref="${key}" ${state.prefs[key] ? "checked" : ""}></label>`,
    )
    .join("");
  all("[data-pref]").forEach((el) =>
    el.addEventListener("change", () => {
      state.prefs[el.dataset.pref] = el.checked;
      persist(); buildSectionOrder();
      if (el.dataset.pref === "requestedBy" && currentDetail) setDetailCertification(currentDetail);
      if (el.dataset.pref === "colorblind")
        api("/api/accessibility-settings", {
          method: "POST",
          body: JSON.stringify({ colorblind: el.checked }),
        }).catch(report);
      if (el.dataset.pref === "weather") saveWeather();
      if (el.dataset.pref === "recommendations" && el.checked) loadRecommendations();
      if (el.dataset.pref === "recent" && el.checked) loadRecent();
      if (el.dataset.pref === "popular" && el.checked) loadPopular();
      if (el.dataset.pref === "inTheaters" && el.checked) loadInTheaters();
      if (el.dataset.pref === "requests" && el.checked) loadRequests();
      if (el.dataset.pref === "libraryStats" && el.checked) loadLibraryStats();
      if (["watchlist", "watchLater", "topUnwatched", "continueWatching", "nextUp", "watchNext", "leavingSoon"].includes(el.dataset.pref)) loadPersonalShelves();
    }),
  );
  buildSectionOrder();
  $("#sync-display").checked = Boolean(state.prefs.syncDisplay);
  $("#shelf-refresh-minutes").value = shelfRefreshInterval();
  $("#live-shelf-minutes").value = liveShelfInterval();
  $("#default-view").value = state.prefs.defaultView;
  $("#poster-size").value = state.prefs.posterSize || "standard";
  $("#weather-units").value = state.prefs.weatherUnits;
  $("#weather-location").checked = Boolean(state.prefs.weatherLocation);
  $("#weather-city-selected").textContent =
    state.prefs.weatherCity?.label || "No city selected";
  $("#display-name").value = state.name;
  $("#weather-city-results").replaceChildren();
  $("#weather-settings-status").textContent = "";
}
async function enter(name) {
  resetAccountState();
  state.key = `marquee:${name}:preferences`;
  try {
    const saved = JSON.parse(localStorage.getItem(state.key) || "null");
    const hasSavedPrefs = saved && typeof saved === "object" && !Array.isArray(saved);
    state.prefs = {
      ...defaults,
      // Older saved preferences predate the search toggle: keep it visible.
      ...(hasSavedPrefs ? { search: true, ...saved } : {}),
    };
  } catch {
    state.prefs = { ...defaults };
  }
  if (state.prefs.syncDisplay) {
    try { const { preferences } = await api("/api/display-preferences"); if (preferences) Object.assign(state.prefs, preferences); }
    catch { /* Offline sync keeps this device's saved choices. */ }
  }
  // One-time reset (0.2.0-beta.2): Next up and Continue watching were meant to be on for
  // everyone. Saved "off" values from before that default are turned on once, then the
  // flag keeps later choices alone.
  if (!state.prefs.personalShelvesReset) {
    state.prefs.continueWatching = true; state.prefs.nextUp = true; state.prefs.personalShelvesReset = true;
    try { const { weather, weatherCity, weatherUnits, colorblind, ...devicePrefs } = state.prefs; localStorage.setItem(state.key, JSON.stringify(devicePrefs)); } catch { /* storage full or blocked */ }
    if (state.prefs.syncDisplay) syncDisplayWrite();
  }
  // One-time reset (0.2.0-beta.3): Favorites, Watchlist, Leaving soon and Recommendations are on by
  // default now (and hide themselves when empty). Saved "off" values from before are turned on once.
  if (!state.prefs.shelvesDefaultsV3) {
    Object.assign(state.prefs, { watchlist: true, watchLater: true, leavingSoon: true, recommendations: true, shelvesDefaultsV3: true });
    try { const { weather, weatherCity, weatherUnits, colorblind, ...devicePrefs } = state.prefs; localStorage.setItem(state.key, JSON.stringify(devicePrefs)); } catch { /* storage full or blocked */ }
    if (state.prefs.syncDisplay) syncDisplayWrite();
  }
  pageInitialized = false;
  sectionOrder = [...defaultSectionOrder];
  try {
    let { order } = await api("/api/section-order");
    if (Array.isArray(order) && [9, 10, 11, 12].includes(order.length)) { order = [...order]; for (const key of ["leavingSoon", "recommendations"]) if (!order.includes(key)) order.splice(order.indexOf("popular"), 0, key); }
    if (Array.isArray(order) && order.length === 11 && !order.includes("inTheaters")) { order = [...order]; order.splice(order.indexOf("popular") + 1, 0, "inTheaters"); }
    if (Array.isArray(order) && !order.includes("watchNext") && order.includes("continueWatching")) { order = [...order]; order.splice(order.indexOf("continueWatching")+1, 0, "watchNext"); }
    if(Array.isArray(order) && !order.includes("watchLater") && order.includes("watchlist")) {order=[...order];order.splice(order.indexOf("watchlist")+1,0,"watchLater");}
    if (Array.isArray(order) && !order.includes("topUnwatched") && order.includes("watchLater")) { order = [...order]; order.splice(order.indexOf("watchLater") + 1, 0, "topUnwatched"); }
    if (Array.isArray(order) && order.length === defaultSectionOrder.length && new Set(order).size === order.length && order.every(key => defaultSectionOrder.includes(key))) sectionOrder = order;
  } catch (error) { $("#section-order-status").textContent = error.message; }
  const [weatherSettings, accessibilitySettings] = await Promise.all([
    api("/api/weather-settings"),
    api("/api/accessibility-settings"),
  ]);
  Object.assign(state.prefs, weatherSettings, accessibilitySettings);
  // Reading account settings on entry must not write them back and race another device.
  const { weather, weatherCity, weatherUnits, colorblind, ...entryPrefs } = state.prefs;
  localStorage.setItem(state.key, JSON.stringify(entryPrefs));
  state.view =
    state.prefs.lastView ||
    (state.prefs.defaultView === "auto" ? "agenda" : state.prefs.defaultView);
  $("#hide-unmonitored").checked = Boolean(state.prefs.hideUnmonitored);
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
  loadJellyfinVersion();
  buildSettings();
  applyPrefs();
  const me = await api("/api/me");
  const jellyfin = $("#jellyfin-home");
  jellyfin.removeAttribute("href");
  if (me.jellyfinWebUrl) {
    try {
      const url = new URL(me.jellyfinWebUrl);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        jellyfin.href = url.href;
    } catch {}
  }
  jellyfin.hidden = !state.prefs.jellyfinLink || !jellyfin.hasAttribute("href");
  state.canRequest = me.canRequest;
  $("#settings-username").textContent = me.name;
  $("#settings-avatar").textContent = (Array.from(me.name || "?")[0] || "?").toUpperCase();
  $("#settings-role").hidden = !me.isAdmin;
  $("#settings-user").hidden = false;
  state.requestAccess = me.requestAccess || {
    movie: me.canRequest,
    tv: me.canRequest,
  };
  $("#display-name-settings").hidden = !me.isAdmin;
  await Promise.all([
    loadRecent(),
    loadCalendar(),
    loadRequests(),
    loadRecommendations(),
    loadPopular(),
    loadInTheaters(),
    loadPersonalShelves(),
    loadLibraryStats(),
  ]);
}
function fixBrokenPosters() {
  // One guarded listener per img: a failed poster swaps in the placeholder but
  // remembers its URL, so the next shelf refresh can retry it. Posters are
  // replaced and fixed on Jellyfin after the card first renders.
  all(".poster-art img:not([data-poster-guard])").forEach((image) => {
    image.dataset.posterGuard = "1";
    image.addEventListener("error", () => {
      const src = image.getAttribute("src");
      if (!src || src === "/art/placeholder.svg") return;
      image.dataset.broken = src;
      image.src = "/art/placeholder.svg";
    });
  });
}
function retryBrokenPosters(selector) {
  for (const image of all(`${selector} img[data-broken]`)) {
    const src = image.dataset.broken;
    delete image.dataset.broken;
    image.src = src;
  }
}
function ratingText(rating, showSource = true) {
  return rating &&
    typeof rating.value === "number" &&
    Number.isFinite(rating.value) &&
    rating.value > 0 &&
    rating.value <= 10 &&
    ["TMDB", "IMDb", "Jellyfin community"].includes(rating.source)
    ? `★ ${rating.value.toFixed(1)}/10${showSource && rating.source !== "Jellyfin community" ? ` · ${rating.source}` : ""}`
    : "";
}
function ratingHtml(rating) {
  const text = ratingText(rating, false);
  return text
    ? `<p class="media-rating" ${state.prefs.ratings ? "" : "hidden"}>${escape(text)}</p>`
    : "";
}
const shelfRequests = new Map(), shelfLastLoaded = {};
function shelfApi(path) {
  if (!shelfRequests.has(path)) shelfRequests.set(path, api(path).finally(() => shelfRequests.delete(path)));
  return shelfRequests.get(path);
}
function replaceShelfContent(row, render) {
  const left = row.scrollLeft, top = window.scrollY;
  render(); row.scrollLeft = left;
  if (window.scrollY !== top) window.scrollTo({ top, behavior: "instant" });
}
function libraryShelfMetadata(item) {
  const detail = item.detail || {};
  const movie = item.type === "movie" || detail.mediaType === "movie" || item.watchedScope === "movie";
  if (!movie) return item.subtitle || item.year || ""; // Keep season/episode context on television library shelves.
  return ["Movie", detail.year || item.year, detail.contentRating || item.contentRating].filter(Boolean).join(" · ");
}
const shelfMarkup = new WeakMap();
function updateShelfHtml(container, html) {
  const previousMarkup = shelfMarkup.get(container);
  if (previousMarkup?.html === html && previousMarkup.first === container.firstChild) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  const key = node => node.nodeType === 1 ? node.querySelector("img")?.getAttribute("src") : null;
  const oldCards = new Map();
  for (const child of container.children) {
    const source = key(child);
    if (!source) continue;
    if (!oldCards.has(source)) oldCards.set(source, []);
    oldCards.get(source).push(child);
  }
  function patch(old, next) {
    if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) { old.replaceWith(next); return next; }
    if (old.nodeType !== 1) { if (old.nodeValue !== next.nodeValue) old.nodeValue = next.nodeValue; return old; }
    for (const attr of [...old.attributes]) if (!next.hasAttribute(attr.name)) old.removeAttribute(attr.name);
    for (const attr of next.attributes) if (old.getAttribute(attr.name) !== attr.value) old.setAttribute(attr.name, attr.value);
    const children = [...next.childNodes];
    for (let i = 0; i < children.length; i++) {
      if (old.childNodes[i]) patch(old.childNodes[i], children[i]);
      else old.append(children[i]);
    }
    while (old.childNodes.length > children.length) old.lastChild.remove();
    return old;
  }
  const desired = [];
  for (const child of [...template.content.childNodes]) {
    const previous = oldCards.get(key(child))?.shift();
    desired.push(previous ? patch(previous, child) : child);
  }
  for (let i = 0; i < desired.length; i++) {
    if (container.childNodes[i] === desired[i]) continue;
    const before = container.childNodes[i] || null;
    if (container.moveBefore && desired[i].parentNode === container) container.moveBefore(desired[i], before);
    else container.insertBefore(desired[i], before);
  }
  while (container.childNodes.length > desired.length) container.lastChild.remove();
  shelfMarkup.set(container, { html, first: container.firstChild });
}
function renderRecent(items) {
  updateShelfHtml($("#recent"), items.length
      ? items
          .map((item) => {
            const art = `<div class="poster-art"><img src="${item.image ? `/api/image/${encodeURIComponent(item.id)}` : `/art/${escape(item.art)}.svg`}" alt="${escape(item.title)} poster" loading="lazy">${watchedBadgeHtml(item)}</div>`;
            const time = `<time ${!state.prefs.addedDates ? "hidden" : ""}>${item.added ? escape(new Date(item.added).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "Added date not provided"}</time>`;
            const title = `<h3>${escape(item.title)}</h3>`;
            const head = `<button class="poster-link recent-detail" data-recent-index="${items.indexOf(item)}" aria-label="Details for ${escape(item.title)}">${art}${title}</button>`;
            return `<article class="poster-card watch-later-card">${starHtml(item.watchKey,item.title)}${head}${time}<p>${escape(libraryShelfMetadata(item))}</p>${ratingHtml(item.rating)}</article>`;
          })
          .join("")
      : '<p class="empty">No recent titles in your Jellyfin library.</p>');
  fixBrokenPosters();
}
let recentRequest = 0;
async function loadRecent({ quiet = false } = {}) {
  const request = ++recentRequest;
  try {
    const { items } = await shelfApi("/api/recent");
    if (request !== recentRequest) return;
    if (quiet && !safeShelfRefresh()) { delete shelfLastLoaded.recent; return; }
    shelfLastLoaded.recent = Date.now();
    if (JSON.stringify(state.recentItems) === JSON.stringify(items) && $("#recent .poster-card")) { retryBrokenPosters("#recent"); return; }
    state.recentItems = items;
    replaceShelfContent($("#recent"), () => renderRecent(items));
  } catch (error) {
    if (quiet) { $("#shelf-refresh-status").textContent = "Refresh unavailable. Keeping the last loaded shelves."; return; }
    updateShelfHtml($("#recent"), `<p class="empty">${escape(error.message)}</p>`);
  }
}
let shelfTimer = null, shelfRefreshBusy = false, shelfInteractionAt = 0;
function safeShelfRefresh() {
  if (document.hidden || $("#dashboard").hidden || $("dialog[open]") || Date.now() - shelfInteractionAt < 5000) return false;
  const focused = document.activeElement;
  return !focused?.closest(".poster-row, .popular-row, .search-bar");
}
for (const name of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) document.addEventListener(name, () => { shelfInteractionAt = Date.now(); }, { passive: true });
function shelfRefreshInterval() {
  return [0, 1, 2, 5, 10, 15].includes(state.prefs.shelfRefreshMinutes) ? state.prefs.shelfRefreshMinutes : 5;
}
// Next up and Continue watching change as people watch, so they poll faster than the rest.
// Polling only runs while the tab is visible (safeShelfRefresh), so idle tabs cost nothing.
const liveShelfKeys = ["continueWatching", "nextUp"];
function liveShelfInterval() {
  return [0, 1, 2, 5].includes(state.prefs.liveShelfMinutes) ? state.prefs.liveShelfMinutes : 1;
}
function intervalFor(key) { return liveShelfKeys.includes(key) ? liveShelfInterval() : shelfRefreshInterval(); }
function scheduleShelfRefresh() {
  if (shelfTimer) clearInterval(shelfTimer);
  shelfTimer = null;
  if ((!shelfRefreshInterval() && !liveShelfInterval()) || $("#dashboard").hidden) return;
  shelfTimer = setInterval(autoRefreshShelves, 15000);
}
async function autoRefreshShelves() {
  if (shelfRefreshBusy || (!shelfRefreshInterval() && !liveShelfInterval()) || !safeShelfRefresh()) return;
  const keys = ["recent", "continueWatching", "nextUp", "watchNext", "watchLater", "topUnwatched", "leavingSoon", "requests", "calendar", "libraryStats", "inTheaters"].filter(key => (key === "libraryStats" ? dashboardPage === "home" : pageSections[dashboardPage].includes(key)) && state.prefs[key] && intervalFor(key) && Date.now() - (shelfLastLoaded[key] || 0) >= intervalFor(key) * 60000);
  if (!keys.length) return;
  shelfRefreshBusy = true;
  try {
    // Failed reads also wait one interval instead of hammering an unavailable server.
    for (const key of keys) shelfLastLoaded[key] = Date.now();
    $("#shelf-refresh-status").textContent = "";
    await Promise.all(keys.map(key => key === "recent" ? loadRecent({ quiet: true }) : key === "calendar" ? loadCalendar({ quiet: true }) : key === "requests" ? loadRequests({ quiet: true }) : key === "libraryStats" ? loadLibraryStats({quiet:true}) : key === "inTheaters" ? loadInTheaters({ quiet: true }) : loadPersonalShelf(key, { quiet: true })));
  } finally { shelfRefreshBusy = false; }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) autoRefreshShelves(); });
$("#live-shelf-minutes").addEventListener("change", event => { state.prefs.liveShelfMinutes = Number(event.target.value); persist(); scheduleShelfRefresh(); });
$("#shelf-refresh-minutes").addEventListener("change", event => { state.prefs.shelfRefreshMinutes = Number(event.target.value); persist(); scheduleShelfRefresh(); });
$("#recent").addEventListener("click", (event) => {
  const button = event.target.closest("[data-recent-index]");
  if (!button) return;
  const item = state.recentItems[Number(button.dataset.recentIndex)];
  if (!item) return;
  showDetail({
    title: item.title,
    watched: item.watched, watchedScope: item.watchedScope, watchKey:item.watchKey, favoriteId: item.favoriteId, favorite: item.favorite,
    subtitle: item.subtitle,
    mediaType: item.type,
    ...item.detail,
    poster: item.image
      ? `/api/image/${encodeURIComponent(item.id)}`
      : `/art/${item.art || "placeholder"}.svg`,
    backdrop: item.backdropId
      ? `/api/image/${encodeURIComponent(item.backdropId)}?type=Backdrop`
      : null,
    playLink: item.link,
    factsUrl: `/api/library/${encodeURIComponent(item.id)}/facts`,
    // Everything on the shelf is already in the library, so show the same
    // "available" poster badge the Seerr popups use.
    availability: 5,
  });
});
function period() {
  let start, end;
  if (state.view === "month") {
    start = startOfWeek(
      new Date(state.date.getFullYear(), state.date.getMonth(), 1),
    );
    end = addDays(
      startOfWeek(new Date(state.date.getFullYear(), state.date.getMonth() + 1, 0)),
      7,
    );
  } else if (state.view === "week") {
    start = startOfWeek(state.date);
    end = addDays(start, 7);
  } else if (state.view === "day") {
    start = midnight(state.date);
    end = addDays(start, 1);
  } else if (state.view === "agenda") {
    start = midnight(state.date);
    end = addDays(start, 14);
  } else {
    start = new Date(state.date.getFullYear(), state.date.getMonth(), 1);
    end = new Date(state.date.getFullYear(), state.date.getMonth() + 1, 1);
  }
  return { start, end };
}
let calendarRequest = 0;
async function loadCalendar({ quiet = false } = {}) {
  const request = ++calendarRequest;
  const { start, end } = period();
  $("#refresh").disabled = true;
  if (!quiet) $("#calendar").innerHTML = '<p class="empty">Loading calendar…</p>';
  try {
    const data = await api(
      `/api/calendar?${new URLSearchParams({ start: start.toISOString(), end: end.toISOString() })}`,
    );
    if (request !== calendarRequest) return;
    if (quiet && !safeShelfRefresh()) { delete shelfLastLoaded.calendar; return; }
    shelfLastLoaded.calendar = Date.now();
    const changed = JSON.stringify(state.events) !== JSON.stringify(data.events);
    state.events = data.events;
    const warning = data.warnings.join(" ");
    if ($("#calendar-warning").textContent !== warning) $("#calendar-warning").textContent = warning;
    $("#calendar-warning").hidden = !data.warnings.length;
    if (!quiet || changed) renderCalendar();
    if (!quiet || changed) $("#updated").textContent =
      `Refreshed ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (error) {
    if (quiet) { $("#shelf-refresh-status").textContent = "Refresh unavailable. Keeping the last loaded calendar."; }
    else if (request === calendarRequest)
      $("#calendar").innerHTML =
        `<p class="empty">${escape(error.message)}</p>`;
  } finally {
    if (request === calendarRequest) $("#refresh").disabled = false;
  }
}
function visibleEvents() {
  const types = all("[data-type]:checked").map((el) => el.dataset.type);
  const statuses = all("[data-status]:checked").map((el) => el.dataset.status);
  return state.events
    .filter(
      (event) =>
        types.includes(event.type) &&
        statuses.includes(event.status) &&
        !(state.prefs.hideUnmonitored && event.monitored === false),
    )
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}
function eventHtml(event) {
  const icon =
    event.type === "movie"
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="1" width="12" height="14" rx="1" fill="none" stroke="currentColor"/><path d="M5 1v14M11 1v14M2 5h3M2 10h3M11 5h3M11 10h3" stroke="currentColor"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1" y="2" width="14" height="10" rx="1" fill="none" stroke="currentColor"/><path d="M5 15h6M8 12v3" stroke="currentColor"/></svg>';
  const time = new Date(event.date).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const premiere =
    event.premiere && !["available", "missing"].includes(event.status);
  return `<article class="entry ${escape(event.status)}${premiere ? " premiere" : ""}"${event.type === "tv" || event.type === "movie" ? ` role="button" tabindex="0" data-event="${escape(event.id)}" aria-label="Details for ${escape(event.title)}"` : ""}><span class="entry-status">${icon}${escape(event.type === "movie" ? statusLabel[event.status] : `${time} · ${premiere ? "Season premiere" : statusLabel[event.status]}`)}</span>${starHtml(event.watchKey,event.title)}<h4>${escape(event.title)}</h4><p>${escape(event.subtitle)}</p></article>`;
}
function openEpisode(id) {
  const event = state.events.find((event) => event.id === id);
  if (!event) return;
  showDetail({
    ...event,
    mediaType: event.type === "movie" ? "movie" : "tv",
    mediaId: Number.isSafeInteger(event.tmdbId) ? event.tmdbId : undefined,
    factsUrl: event.tmdbId
      ? `/api/seerr/details/${event.type === "movie" ? "movie" : "tv"}/${event.tmdbId}`
      : null,
  });
}
function mediaActionLabel(item) {
  if (item.availability === 5) return "In your library";
  if (item.availability === 3) return "Processing";
  if (item.availability === 4) return "Partially available";
  if (item.availability === 6) return "Blocklisted";
  if (item.availability === 7) return "Deleted";
  if (item.availability === 2) return "Pending";
  if (item.requested) return "Requested";
  return "";
}
const seerrStatusIcons = {"clock": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path fill-rule=\"evenodd\" d=\"M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25ZM12.75 6a.75.75 0 0 0-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-3.75V6Z\" clip-rule=\"evenodd\"/>\n</svg>", "bell": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path fill-rule=\"evenodd\" d=\"M5.25 9a6.75 6.75 0 0 1 13.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 0 1-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 1 1-7.48 0 24.585 24.585 0 0 1-4.831-1.244.75.75 0 0 1-.298-1.205A8.217 8.217 0 0 0 5.25 9.75V9Zm4.502 8.9a2.25 2.25 0 1 0 4.496 0 25.057 25.057 0 0 1-4.496 0Z\" clip-rule=\"evenodd\"/>\n</svg>", "minus-small": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path fill-rule=\"evenodd\" d=\"M5.25 12a.75.75 0 0 1 .75-.75h12a.75.75 0 0 1 0 1.5H6a.75.75 0 0 1-.75-.75Z\" clip-rule=\"evenodd\"/>\n</svg>", "eye-slash": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path d=\"M3.53 2.47a.75.75 0 0 0-1.06 1.06l18 18a.75.75 0 1 0 1.06-1.06l-18-18ZM22.676 12.553a11.249 11.249 0 0 1-2.631 4.31l-3.099-3.099a5.25 5.25 0 0 0-6.71-6.71L7.759 4.577a11.217 11.217 0 0 1 4.242-.827c4.97 0 9.185 3.223 10.675 7.69.12.362.12.752 0 1.113Z\"/>\n  <path d=\"M15.75 12c0 .18-.013.357-.037.53l-4.244-4.243A3.75 3.75 0 0 1 15.75 12ZM12.53 15.713l-4.243-4.244a3.75 3.75 0 0 0 4.244 4.243Z\"/>\n  <path d=\"M6.75 12c0-.619.107-1.213.304-1.764l-3.1-3.1a11.25 11.25 0 0 0-2.63 4.31c-.12.362-.12.752 0 1.114 1.489 4.467 5.704 7.69 10.675 7.69 1.5 0 2.933-.294 4.242-.827l-2.477-2.477A5.25 5.25 0 0 1 6.75 12Z\"/>\n</svg>", "trash": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path fill-rule=\"evenodd\" d=\"M16.5 4.478v.227a48.816 48.816 0 0 1 3.878.512.75.75 0 1 1-.256 1.478l-.209-.035-1.005 13.07a3 3 0 0 1-2.991 2.77H8.084a3 3 0 0 1-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 0 1-.256-1.478A48.567 48.567 0 0 1 7.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 0 1 3.369 0c1.603.051 2.815 1.387 2.815 2.951Zm-6.136-1.452a51.196 51.196 0 0 1 3.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 0 0-6 0v-.113c0-.794.609-1.428 1.364-1.452Zm-.355 5.945a.75.75 0 1 0-1.5.058l.347 9a.75.75 0 1 0 1.499-.058l-.346-9Zm5.48.058a.75.75 0 1 0-1.498-.058l-.347 9a.75.75 0 0 0 1.5.058l.345-9Z\" clip-rule=\"evenodd\"/>\n</svg>", "check-circle": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 20 20\" fill=\"currentColor\" aria-hidden=\"true\" data-slot=\"icon\">\n  <path fill-rule=\"evenodd\" d=\"M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z\" clip-rule=\"evenodd\"/>\n</svg>"};
function watchedBadgeHtml(item) {
  if (item.watched !== true) return "";
  const label = item.watchedScope === "season" ? "Season watched" : item.watchedScope === "series" ? "Series watched" : item.watchedScope === "episode" ? "Episode watched" : "Watched";
  return `<span class="watched-badge" role="img" aria-label="${label}" title="${label}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg></span>`;
}
function statusBadgeHtml(item) {
  const label = mediaActionLabel(item);
  if (!label) return "";
  const [icon, cls] = ({2:["bell","pending"],3:["clock","processing"],4:["minus-small","partial"],5:["check-circle","available"],6:["eye-slash","blocked"],7:["trash","deleted"]})[item.availability] || ["clock","processing"];
  return `<span class="poster-status ${cls}" role="img" aria-label="${label}" title="${label}">${seerrStatusIcons[icon]}</span>`;
}
const svgIcons = {
  critics: '<path fill="#f0483e" d="M12 6.5c-5 0-8.5 3.2-8.5 7.6C3.5 18.2 7.2 21 12 21s8.5-2.800 8.5-6.900C20.500 9.700 17 6.500 12 6.500Z"/><path fill="#4caf50" d="m12 7.500-3.300-3 .2 2.600-3.100-.4 2.600 2.100L12 7.500Zm0 0 3.300-3-.2 2.600 3.100-.4-2.600 2.100L12 7.500Z"/><path fill="#4caf50" d="M11 3h2v4.500h-2z"/>',
  audience: '<path fill="#f7c948" d="M7 9a2.800 2.800 0 0 1 3-2.700 2.800 2.800 0 0 1 4 0A2.800 2.800 0 0 1 17 9a2.500 2.500 0 0 1 .5 4.500H6.500A2.500 2.500 0 0 1 7 9Z"/><path fill="#e5484d" d="M6 12.500h12l-1.600 8.500H7.600L6 12.500Z"/><path fill="#fff" d="M9.500 12.500h1.200l.3 8.500h-1.200zM13 12.500h1.200l-.3 8.500h-1.200z"/>',
  Theatrical: '<path fill="currentColor" d="M3 7.500A1.500 1.500 0 0 1 4.500 6h15A1.500 1.500 0 0 1 21 7.500V10a2 2 0 0 0 0 4v2.500a1.500 1.500 0 0 1-1.500 1.500h-15A1.500 1.500 0 0 1 3 16.500V14a2 2 0 0 0 0-4V7.500Zm11 .5h-1.500v2H14V8Zm0 4h-1.500v2H14v-2Zm0 4h-1.500v1H14v-1Z"/>',
  Digital: '<path fill="currentColor" d="M7 18a4 4 0 0 1-.6-8A5.500 5.500 0 0 1 17 8.500a4.800 4.800 0 0 1 .5 9.500H7Z"/>',
  Physical: '<path fill="currentColor" fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 6.500a2.500 2.500 0 1 0 0 5 2.500 2.500 0 0 0 0-5Z"/>',
  "First aired": '<path fill="currentColor" d="M4 6.500A1.500 1.500 0 0 1 5.500 5h13A1.500 1.500 0 0 1 20 6.500v9a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 15.500v-9ZM8 19h8v1.500H8V19Z"/>',
  other: '<path fill="currentColor" d="M5 5h14v14H5z"/>',
};
const svgIcon = (name) => `<svg class="mini-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${svgIcons[name] || svgIcons.other}</svg>`;
function renderDetailFacts(facts) {
  const panel = $("#episode-facts");
  panel.innerHTML = "";
  panel.hidden = true;
  if (!facts) return;
  const scores = facts.scores || {};
  const ratings = [["critics", svgIcon("critics"), "Rotten Tomatoes critics", "%"], ["audience", svgIcon("audience"), "Rotten Tomatoes audience", "%"], ["imdb", "IMDb", "IMDb", "/10"], ["tmdb", "TMDB", "TMDB user score", "%"]]
    .filter(([key]) => Number.isFinite(scores[key]) && scores[key] >= 0);
  let html = state.prefs.ratings && ratings.length ? `<div class="detail-scores">${ratings.map(([key, icon, label, suffix]) => `<span class="detail-score" title="${label}" aria-label="${label}: ${scores[key]}${suffix}"><span class="score-mark ${key}">${icon}</span> ${scores[key]}${suffix}</span>`).join("")}</div>` : "";
  const row = (label, value) => `<div class="detail-fact"><strong>${label}</strong><span>${value}</span></div>`;
  const seasonLabel = Number.isInteger(facts.seasonCount) && facts.seasonCount > 0 ? `${facts.seasonCount} ${facts.seasonCount === 1 ? "season" : "seasons"}` : null;
  if (facts.status || seasonLabel) html += row("Status", [facts.status, seasonLabel].filter(Boolean).map(escape).join(" · "));
  if (facts.releases?.length) html += row("Release dates", facts.releases.map(r => {
    const date = new Date(`${r.date}T12:00:00Z`);
    if (!Number.isFinite(date.getTime())) return "";
    const icon = svgIcon(r.type);
    return `<span class="detail-release" title="${escape(r.type)}${r.region ? ` (${escape(r.region)})` : ""}"><span class="release-label">${icon}<small>${escape(r.type)}${r.region ? ` · ${escape(r.region)}` : ""}</small></span><span class="release-date">${escape(date.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}))}</span></span>`;
  }).join(""));
  if (facts.productionCountries?.length) html += row("Production", `<span class="country-flags">${facts.productionCountries.map(c => `<span tabindex="0" title="${escape(c.name)}" aria-label="${escape(c.name)}">${/^[A-Z]{2}$/.test(c.code) ? `<img class="flag" src="/flags/${c.code.toLowerCase()}.svg" alt="" width="28" height="21" loading="lazy" data-code="${c.code}">` : escape(c.name)}</span>`).join(" ")}</span>`);
  if (facts.originalLanguage) {
    let language = facts.originalLanguage;
    try { language = new Intl.DisplayNames([navigator.language || "en"], { type:"language" }).of(language) || language; } catch {}
    html += row("Original language", escape(language));
  }
  panel.innerHTML = html;
  panel.hidden = !html;
}
function ratingHidden(rating, facts) {
  const tmdb = facts?.scores?.tmdb;
  return (
    !state.prefs.ratings ||
    !ratingText(rating) ||
    (tmdb !== null && tmdb !== undefined)
  );
}
// Library and calendar items don't carry the facts panel (scores, status,
// release dates...). Look it up once per popup open, only for the title shown.
const factsCache = new Map();
let factsRequest = 0;
async function loadMissingFacts(event) {
  const source = event.factsUrl;
  if (event.facts || !source) return;
  const request = ++factsRequest;
  try {
    if (!factsCache.has(source))
      factsCache.set(
        source,
        api(source),
      );
    const data = await factsCache.get(source);
    const facts = data.facts;
    // Ignore the answer if another popup was opened in the meantime.
    if (request !== factsRequest || !$("#episode-detail").open || currentDetail !== event) return;
    if (["movie", "tv"].includes(data.mediaType) && Number.isSafeInteger(data.mediaId)) { event.mediaType = data.mediaType; event.mediaId = data.mediaId; if (!event.favoriteId) Object.assign(event, { favoriteId: data.favoriteId, favorite: data.favorite }); setDetailSave(event); }
    if(data.watchKey) {event.watchKey=data.watchKey;setDetailStar(event);}
    if (data.network) { event.network = data.network; setDetailNetwork(event); }
    if (!facts) { factsCache.delete(source); return; }
    if (event.watched == null && data.watched === true) { event.watched = true; $("#episode-poster-status").innerHTML = statusBadgeHtml(event) + watchedBadgeHtml(event); }
    event.facts = facts;
    if (data.contentRating) event.contentRating = data.contentRating;
    setDetailCertification(event);
    renderDetailFacts(facts);
    $("#episode-rating").hidden = ratingHidden(event.rating, facts);
  } catch {
    factsCache.delete(source);
  }
}
let currentDetail = null;
const heartIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 6-8 11-8 11Z" /></svg>';
function setDetailSave(event) {
  const button = $("#episode-save");
  const known = Boolean(event.favoriteId), favorite = event.favorite === true;
  button.hidden = false; button.innerHTML = heartIcon;
  button.classList.toggle("favorited", favorite); button.setAttribute("aria-pressed", String(favorite));
  button.setAttribute("aria-label", known ? favorite ? "Remove from Jellyfin favorites" : "Add to Jellyfin favorites" : "Not available in Jellyfin favorites");
  button.title = known ? favorite ? "Remove from Jellyfin favorites" : "Add to Jellyfin favorites" : "Favorites require a movie or series in your Jellyfin library";
  button.disabled = !known || event.favoriteBusy === true || event.favorite == null;
}
async function loadDetailFavorite(event) {
  if (!event.favoriteId) return;
  try { const data = await api(`/api/favorite/${encodeURIComponent(event.favoriteId)}`); if (currentDetail === event && !event.favoriteBusy && !event.favoriteWritten) { Object.assign(event, data); setDetailSave(event); } }
  catch { if (currentDetail === event && !event.favoriteBusy && !event.favoriteWritten) { event.favoriteId = null; setDetailSave(event); } }
}
function setDetailNetwork(event) {
  const network = $("#episode-network");
  if (event.mediaType === "tv" && typeof event.network === "string") {
    const seen = new Set();
    event.network = event.network.split(",").map(name => name.trim()).filter(name => {
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return false;
      seen.add(key); return true;
    }).join(", ");
  }
  network.textContent = event.mediaType === "tv" && event.network ? `Network · ${event.network}` : "";
  network.hidden = !network.textContent;
}
function setDetailPlay(resume = false) {
  const label = resume ? "Resume in Jellyfin" : "Play in Jellyfin";
  $("#episode-play").setAttribute("aria-label", label); $("#episode-play").title = label;
}
function setDetailCertification(event) {
  const certification = typeof event.contentRating === "string" ? event.contentRating.trim() : "";
  const requesters = state.prefs.requestedBy && Array.isArray(event.facts?.requestedBy) ? event.facts.requestedBy.filter(name=>typeof name === "string" && name.trim()) : [];
  const movie = event.mediaType === "movie" || /(?:^| · )Movie(?: · |$)/i.test(event.subtitle || "");
  const subtitleParts = (event.subtitle || "").split(" · ").filter(part => movie || part.trim() !== certification);
  let placedRating = false;
  const detailSubtitle = subtitleParts.map(part => {
    if (movie && /^movie$/i.test(part.trim())) { placedRating = true; return requesters.length ? "" : certification; }
    return part;
  }).filter(Boolean);
  if (movie && !requesters.length && certification && !placedRating && !detailSubtitle.includes(certification)) detailSubtitle.push(certification);
  const certificationLine = $("#episode-certification-line");
  certificationLine.innerHTML = requesters.length ? `${certification ? `<strong>${escape(certification)}</strong> · ` : ""}Requested by ${requesters.map(escape).join(", ")}` : movie ? "" : `<strong>${escape(certification)}</strong>`;
  certificationLine.hidden = !certificationLine.textContent;
  $("#episode-subtitle").textContent = detailSubtitle.join(" · ");
  return detailSubtitle;
}
function showDetail(event) {
  currentDetail = event;
  setDetailSave(event); setDetailStar(event);
  factsRequest++;
  renderDetailFacts(event.facts);
  $("#episode-title").textContent =
    `${event.title}${event.year && !new RegExp(`(?:\\(\\s*${String(event.year).replace(/[^0-9]/g, "")}\\s*\\)|\\b${String(event.year).replace(/[^0-9]/g, "")}\\b)\\s*$`).test(event.title) ? ` (${event.year})` : ""}`;
  const detailSubtitle = setDetailCertification(event);
  const requestButton = $("#episode-request");
  const actionLabel = mediaActionLabel(event);
  $("#episode-poster-status").innerHTML = statusBadgeHtml(event) + watchedBadgeHtml(event);
  requestButton.hidden = !(
    Number.isSafeInteger(event.mediaId) &&
    event.mediaId > 0 &&
    state.requestAccess[event.mediaType] &&
    !actionLabel
  );
  requestButton.disabled = false;
  delete requestButton.dataset.request;
  if (!requestButton.hidden) {
    requestButton.dataset.request = "";
    requestButton.dataset.mediaId = event.mediaId;
    requestButton.dataset.mediaType = event.mediaType;
    requestButton.dataset.title = event.title;
  }
  $("#episode-request-status").hidden = true;
  $("#episode-request-status").textContent = "";
  const contentRating = $("#episode-content-rating");
  contentRating.textContent =
    typeof event.contentRating === "string" ? event.contentRating : "";
  contentRating.hidden = true;
  contentRating.title = event.contentRatingRegion
    ? `Content rating (${event.contentRatingRegion})`
    : "Content rating";
  // Desktop shows genres and the meta line under the overview; phones keep them in the body.
  setDetailNetwork(event);
  const metaParts = [
    event.mediaType === "tv" ? null : event.network,
    event.runtime ? `${event.runtime} min` : null,
    statusLabel[event.status] || null,
  ].filter(Boolean);
  $("#episode-meta").textContent = metaParts.join(" · ");
  // The subtitle is already printed above on desktop, so don't repeat it in the top line.
  $("#episode-meta-top").textContent = metaParts
    .filter((part) => part !== event.subtitle && !detailSubtitle.includes(part))
    .join(" · ");
  const airDate = $("#episode-air-date");
  airDate.hidden = true; airDate.textContent = "";
  if (typeof event.episodeAirDate === "string" && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(event.episodeAirDate)) {
    const day = event.episodeAirDate.slice(0,10), date = new Date(`${day}T12:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === day) {
      airDate.textContent = `Episode air date · ${date.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"})}`;
      airDate.hidden = false;
    }
  }
  $("#episode-air-date-top").textContent = airDate.textContent;
  $("#episode-air-date-top").hidden = airDate.hidden;
  const cast = $("#episode-cast");
  const names = Array.isArray(event.cast)
    ? event.cast.filter((n) => typeof n === "string").slice(0, 4)
    : [];
  cast.textContent = names.length ? `Cast: ${names.join(", ")}` : "";
  cast.hidden = !names.length;
  // Same text twice: desktop shows it under the title, phones keep it in the body.
  $("#episode-overview").textContent = $("#episode-overview-top").textContent =
    event.overview || "Overview not available yet.";
  {
    // Desktop only (the control is hidden by CSS on phones): long overviews are clamped
    // so the facts and actions stay in the same place from title to title.
    const top = $("#episode-overview-top");
    const more = $("#episode-more");
    top.classList.add("clamped");
    more.hidden = true;
    more.textContent = "More";
    more.setAttribute("aria-expanded", "false");
    requestAnimationFrame(() => {
      more.hidden = !(top.scrollHeight > top.clientHeight + 1);
    });
  }
  $("#episode-genres").innerHTML = $("#episode-genres-top").innerHTML = (event.genres || [])
    .map((genre) => `<span>${escape(genre)}</span>`)
    .join("");
  $("#episode-rating").textContent = ratingText(event.rating);
  $("#episode-rating").hidden = ratingHidden(event.rating, event.facts);
  const image = $("#episode-backdrop");
  const poster = $("#episode-poster");
  const hero = $(".episode-hero");
  const posterSource = event.poster || null;
  const backdropSource = event.backdrop || posterSource;
  hero.classList.toggle("has-poster", Boolean(posterSource));
  poster.hidden = !posterSource;
  poster.onerror = () => {
    poster.hidden = true;
    poster.removeAttribute("src");
    hero.classList.remove("has-poster");
  };
  if (posterSource) poster.src = posterSource;
  else poster.removeAttribute("src");
  image.hidden = !backdropSource;
  image.onerror = () => {
    if (posterSource && image.getAttribute("src") !== posterSource) {
      image.src = posterSource;
    } else {
      image.hidden = true;
      image.removeAttribute("src");
    }
  };
  if (backdropSource) image.src = backdropSource;
  else image.removeAttribute("src");
  const play = $("#episode-play");
  setDetailPlay();
  play.hidden = !event.playLink;
  if (event.playLink) play.href = event.playLink;
  else play.removeAttribute("href");
  $("#episode-trailer").href =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(event.title + " official trailer")}`;
  $("#episode-detail").showModal();
  loadMissingFacts(event);
  loadDetailFavorite(event);
}
$("#calendar").addEventListener("click", (event) => {
  const card = event.target.closest("[data-event]");
  if (card) openEpisode(card.dataset.event);
});
$("#calendar").addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-event]");
  if (card && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    openEpisode(card.dataset.event);
  }
});
$("#episode-more").addEventListener("click", (e) => {
  const open = $("#episode-overview-top").classList.toggle("clamped") === false;
  e.currentTarget.textContent = open ? "Less" : "More";
  e.currentTarget.setAttribute("aria-expanded", String(open));
});
$("#episode-close").addEventListener("click", () =>
  $("#episode-detail").close(),
);
function renderCalendar() {
  const { start, end } = period();
  const events = visibleEvents();
  const grouped = new Map();
  for (const event of events) {
    const key = dayKey(new Date(event.date));
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }
  $("#calendar-title").textContent =
    state.view === "day"
      ? state.date.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : state.view === "week" || state.view === "agenda"
        ? `${start.toLocaleDateString([], { month: "short", day: "numeric" })} - ${addDays(end, -1).toLocaleDateString([], { month: "short", day: "numeric" })}`
        : state.date.toLocaleDateString([], { month: "long", year: "numeric" });
  all("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
    button.setAttribute("aria-pressed", button.dataset.view === state.view);
  });
  $("#scroll-hint").hidden = !(
    innerWidth <= 600 && ["month", "week"].includes(state.view)
  );
  if (["month", "week"].includes(state.view)) {
    let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      .map((name) => `<div class="weekday">${name}</div>`)
      .join("");
    for (let date = start; date < end; date = addDays(date, 1)) {
      html += `<div class="day-cell ${date.getMonth() !== state.date.getMonth() ? "outside" : ""} ${isToday(date) ? "today" : ""}" data-date="${dayKey(date)}"><span class="day-number">${date.getDate()}</span>${(grouped.get(dayKey(date)) || []).map(eventHtml).join("")}</div>`;
    }
    $("#calendar").innerHTML = `<div class="${state.view}-grid">${html}</div>`;
  } else {
    let html = "";
    for (let date = start; date < end; date = addDays(date, 1)) {
      const rows = grouped.get(dayKey(date)) || [];
      if (!rows.length && state.view !== "day") continue;
      html += `<div class="list-day ${isToday(date) ? "today" : ""}"><div class="list-date">${date.toLocaleDateString([], { weekday: "short" })}<strong>${date.toLocaleDateString([], { month: "short", day: "numeric" })}</strong></div><div class="list-entries">${rows.length ? rows.map(eventHtml).join("") : "<p>No releases today.</p>"}</div></div>`;
    }
    $("#calendar").innerHTML = html
      ? `<div class="${state.view}-view">${html}</div>`
      : '<p class="empty">No releases match your filters for this period.</p>';
  }
}
function move(amount) {
  if (["month", "list"].includes(state.view))
    state.date = new Date(
      state.date.getFullYear(),
      state.date.getMonth() + amount,
      1,
    );
  else if (state.view === "agenda")
    state.date = addDays(state.date, amount * 14);
  else
    state.date = addDays(state.date, amount * (state.view === "week" ? 7 : 1));
  loadCalendar();
}
let weatherTimer;
let weatherLastLoaded = 0;
function scheduleWeather() {
  clearInterval(weatherTimer);
  if (!state.prefs.weather || (!state.prefs.weatherCity && !state.prefs.weatherLocation)) return;
  weatherTimer = setInterval(
    () => {
      if (!document.hidden && !$("#dashboard").hidden) loadWeather();
    },
    15 * 60 * 1000,
  );
}
document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    !$("#dashboard").hidden &&
    state.prefs.weather &&
    Date.now() - weatherLastLoaded >= 15 * 60 * 1000
  )
    loadWeather();
});
let weatherLocationRequest = null;
async function deviceWeatherLocation() {
  if (!state.prefs.weatherLocation) return null;
  if (!navigator.geolocation || !window.isSecureContext) {
    $("#weather-location-status").textContent = "Device location requires HTTPS. Using your saved city.";
    return null;
  }
  if (!weatherLocationRequest) {
    weatherLocationRequest = new Promise(resolve => navigator.geolocation.getCurrentPosition(
      position => {
        if (Date.now() - position.timestamp >= 15 * 60 * 1000) { resolve(null); return; }
        $("#weather-location-status").textContent = "Using this device's approximate location.";
        resolve({ latitude: Math.round(position.coords.latitude * 100) / 100, longitude: Math.round(position.coords.longitude * 100) / 100 });
      },
      () => { $("#weather-location-status").textContent = "Device location unavailable. Using your saved city."; resolve(null); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 15 * 60 * 1000 },
    )).finally(() => { weatherLocationRequest = null; });
  }
  return weatherLocationRequest;
}
$("#weather-location").addEventListener("change", event => {
  state.prefs.weatherLocation = event.target.checked;
  if (!event.target.checked) $("#weather-location-status").textContent = "";
  persist();
});
function forecastIcon(code) {
  let label = "Cloudy", paths = '<path d="M5 18h13a4 4 0 0 0 0-8 6 6 0 0 0-11-1 4.5 4.5 0 0 0-2 9Z"/>';
  if (code === 0 || code === 1) { label = "Clear"; paths = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'; }
  else if (code >= 51 && code <= 67 || code >= 80 && code <= 82) { label = "Rain"; paths += '<path d="m7 20-1 2m6-2-1 2m6-2-1 2"/>'; }
  else if (code >= 71 && code <= 77 || code === 85 || code === 86) { label = "Snow"; paths += '<path d="M7 21h.01M12 21h.01M17 21h.01"/>'; }
  else if (code >= 95) { label = "Thunderstorms"; paths += '<path d="m13 16-3 4h4l-3 4"/>'; }
  else if (code === 45 || code === 48) { label = "Fog"; paths = '<path d="M3 8h18M5 12h14M3 16h18M6 20h12"/>'; }
  return `<svg class="forecast-icon" viewBox="0 0 24 24" role="img" aria-label="${label}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}
async function loadWeather() {
  try {
    const locationEnabled = state.prefs.weatherLocation;
    const located = await deviceWeatherLocation();
    const city = locationEnabled && state.prefs.weatherLocation ? located || state.prefs.weatherCity : state.prefs.weatherCity;
    if (!city) {
      $("#weather-content").textContent = "Choose a city in Settings";
      $("#weather-forecast").textContent = "";
      return;
    }
    const params = new URLSearchParams({
      latitude: city.latitude,
      longitude: city.longitude,
      units: state.prefs.weatherUnits,
    });
    const data = await api(`/api/weather?${params}`);
    weatherLastLoaded = Date.now();
    const codes = {
      0: "Clear",
      1: "Mostly clear",
      2: "Partly cloudy",
      3: "Overcast",
      45: "Fog",
      48: "Fog",
      51: "Drizzle",
      61: "Rain",
      63: "Rain",
      65: "Heavy rain",
      71: "Snow",
      80: "Showers",
      95: "Thunderstorms",
    };
    $("#weather-content").textContent =
      `${Math.round(data.current.temperature_2m)}°${data.current_units.temperature_2m.replace("°", "")} · ${codes[data.current.weather_code] || "Mixed conditions"}`;
    $("#weather-forecast").innerHTML = data.daily.time
      .map(
        (date, i) =>
          `<span class="forecast-day">${Number.isInteger(data.daily.weather_code?.[i]) ? forecastIcon(data.daily.weather_code[i]) : ""}<b>${escape(new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short" }))}</b><span>${Math.round(data.daily.temperature_2m_max[i])}° <small>/ ${Math.round(data.daily.temperature_2m_min[i])}°</small></span></span>`,
      )
      .join("");
  } catch (error) {
    $("#weather-content").textContent = error.message;
    $("#weather-forecast").innerHTML = "";
  }
}
function resultCardHtml(r, includeContentRating = false) {
  const shelf = !includeContentRating;
  const label = mediaActionLabel(r);
  const action = label
    ? ""
    : state.requestAccess[r.mediaType]
      ? `<button class="request-btn${shelf ? " poster-request" : ""}"${shelf ? ` aria-label="Request ${escape(r.title)}" title="Request ${escape(r.title)}"` : ""} data-request data-media-type="${r.mediaType}" data-media-id="${r.id}" data-title="${escape(r.title)}">${shelf ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>' : "Request"}</button>`
      : `<span class="request-unavailable">${escape(state.requestAccess.reason || state.requestAccess[`${r.mediaType}Reason`] || "Requests disabled in Seerr")}</span>`;
  return `<article class="result-card" data-availability="${Number.isInteger(r.availability) ? r.availability : ""}"><div class="poster-art" role="button" tabindex="0" data-detail-type="${r.mediaType}" data-detail-id="${r.id}" aria-label="Details for ${escape(r.title)}"><img src="${r.poster ? (r.poster.startsWith("/") ? `/api/seerr/image?path=${encodeURIComponent(r.poster)}` : `/art/${encodeURIComponent(r.poster)}.svg`) : "/art/placeholder.svg"}" alt="" loading="lazy">${statusBadgeHtml(r)}${watchedBadgeHtml(r)}</div>${starHtml(r.watchKey,r.title)}${shelf && action.startsWith("<button") ? action : ""}${shelf ? '<div class="result-caption"><div class="caption-copy">' : ""}<h3>${escape(r.title)}</h3><p class="result-meta">${[shelf && r.streamer ? r.streamer : r.mediaType === "movie" ? "Movie" : "TV", r.year, shelf ? r.contentRating : null].filter(Boolean).map(escape).join(" · ")}${includeContentRating ? `<span class="row-cert row-cert-pending" aria-hidden="true"></span>` : ""}</p>${shelf ? `</div><div class="caption-baseline" aria-hidden="true"><span class="caption-title-space"></span><span class="caption-meta-space">${[r.streamer || (r.mediaType === "movie" ? "Movie" : "TV"), r.year, r.contentRating].filter(Boolean).map(escape).join(" · ")}</span></div></div>` : ""}${ratingHtml(r.rating)}${r.overview ? `<p class="result-overview">${escape(r.overview)}</p>` : ""}${shelf ? "" : `<div class="result-action">${action}</div>`}</article>`;
}
function renderSearch(results) {
  updateShelfHtml($("#search-results"), results.length
    ? results.map(r => resultCardHtml(r, true)).join("")
    : '<p class="empty">Nothing found. Try another title.</p>');
  fixBrokenPosters();
  addRowRatings(results);
}
// Content ratings (R, PG-13, TV-MA...) arrive a moment later so results never wait for
// them. A pending chip holds each rating's place so the rows do not shift, and a
// session cache fills repeat searches before the network answer returns.
const certCache = new Map();
async function addRowRatings(results) {
  const items = results.slice(0, 30).map((r) => `${r.mediaType}:${r.id}`);
  if (!items.length) return;
  const seq = searchSeq;
  const fill = (key, value) => {
    for (const card of all("#search-results .result-card")) {
      const poster = card.querySelector("[data-detail-id]");
      if (`${poster.dataset.detailType}:${poster.dataset.detailId}` !== key) continue;
      const chip = card.querySelector(".row-cert-pending");
      if (!chip) continue;
      if (value) {
        chip.textContent = value;
        chip.title = "Content rating";
        chip.classList.remove("row-cert-pending");
        chip.removeAttribute("aria-hidden");
      } else chip.remove();
    }
  };
  const missing = [];
  for (const key of items) {
    if (certCache.has(key)) fill(key, certCache.get(key));
    else missing.push(key);
  }
  if (!missing.length) return;
  try {
    const { ratings } = await api(`/api/seerr/content-ratings?items=${missing.join(",")}`);
    if (seq !== searchSeq) return;
    if (certCache.size > 1500) certCache.clear();
    for (const key of missing) {
      const value = ratings[key] || "";
      certCache.set(key, value);
      fill(key, value);
    }
  } catch {
    if (seq !== searchSeq) return;
    for (const key of missing) fill(key, "");
  }
}
$("#popular-collapse").addEventListener("click", () => {
  state.prefs.popularCollapsed = !state.prefs.popularCollapsed;
  persist();
});
async function openMediaDetail(card, status) {
  try {
    const detail = await api(
      `/api/seerr/details/${card.dataset.detailType}/${card.dataset.detailId}`,
    );
    if (state.demo) {
      const action = card
        .closest(".result-card")
        ?.querySelector("[data-request]");
      detail.mediaType = card.dataset.detailType;
      detail.mediaId = Number(card.dataset.detailId);
      detail.requested = !action;
      const availability = card.closest(".result-card")?.dataset.availability;
      detail.availability = availability ? Number(availability) : null;
    }
    showDetail(detail);
  } catch (error) {
    status.textContent = error.message;
  }
}
for (const [container, status] of [
  ["#popular-section", "#popular-status"],
  ["#inTheaters-section", "#inTheaters-status"],
  ["#recommendations-section", "#recommendations-status"],
  ["#search-results", "#search-status"],
  ["#requests", "#global-error"],
]) {
  $(container).addEventListener("click", (event) => {
    if (event.target.closest("[data-request]")) return;
    let card = event.target.closest("[data-detail-id]");
    // Search rows open the popup from anywhere on the row except the button.
    if (!card && container === "#search-results" && !event.target.closest("button, a"))
      card = event.target.closest(".result-card")?.querySelector("[data-detail-id]");
    if (card) openMediaDetail(card, $(status));
  });
  $(container).addEventListener("keydown", (event) => {
    if (event.target.closest("[data-request]")) return;
    const card = event.target.closest("[data-detail-id]");
    if (card && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      openMediaDetail(card, $(status));
    }
  });
}
async function loadPopular() {
  if (!state.prefs.popular) return;
  try {
    const data = await api("/api/seerr/popular");
    for (const type of ["movies", "tv"]) {
      updateShelfHtml($("#popular-" + type), data[type]
        .map(
          (item, i) =>
            `<div class="ranked-poster"><span class="popular-rank">${i + 1}</span>${resultCardHtml(item)}</div>`,
        )
        .join(""));
    }
    $("#popular-status").textContent = "";
    fixBrokenPosters();
  } catch (error) {
    $("#popular-status").textContent = error.message;
  }
}
async function loadInTheaters({ quiet = false } = {}) {
  if (!state.prefs.inTheaters) return;
  try {
    const data = await api("/api/in-theaters");
    if (quiet && !safeShelfRefresh()) { delete shelfLastLoaded.inTheaters; return; }
    shelfLastLoaded.inTheaters = Date.now();
    updateShelfHtml($("#inTheaters-content"), data.items.length ? data.items.slice(0,25).map(item => resultCardHtml(item)).join("") : '<p class="empty">No theater titles returned for the US.</p>');
    $("#inTheaters-status").textContent = "";
    fixBrokenPosters();
  } catch (error) {
    if (quiet) { $("#shelf-refresh-status").textContent = "Refresh unavailable. Keeping the last loaded shelves."; return; }
    $("#inTheaters-content").replaceChildren(); $("#inTheaters-status").textContent = error.message;
  }
}
async function loadRecommendations() {
  if (!state.prefs.recommendations) return;
  try {
    const { seed, seeds, items } = await api("/api/recommendations");
    const titles = seeds?.length ? seeds : seed ? [seed] : [];
    $("#recommendation-seed").textContent = titles.length ? `Recent picks · Because you watched ${titles.join(", ")}` : "Watch a movie or show in Jellyfin to get suggestions.";
    state.recommendationsEmpty = !items.length;
    $("#recommendations-section").hidden = !state.prefs.recommendations || state.recommendationsEmpty;
    updateShelfHtml($("#recommendations-content"), items.length ? items.map(r => resultCardHtml(r)).join("") : '<p class="empty">No recent suggestions from your watched titles yet.</p>');
    $("#recommendations-status").textContent = ""; fixBrokenPosters();
  } catch (error) { $("#recommendations-status").textContent = error.message; }
}
$("#requests-filter").addEventListener("change", event => { state.prefs.myRequests = event.target.value === "mine"; persist(); loadRequests(); });
function requestStatus(r) {
  if (r.availability === 5) return ["Available", "available"];
  if (r.status === 2) return ["Approved", "upcoming"];
  if (r.status === 3) return ["Declined", "missing"];
  return ["Pending", "pending"];
}
function renderRequests(requests) {
  $("#requests").innerHTML = requests.length
    ? requests
        .map((r) => {
          const [label, cls] = requestStatus(r);
          return `<div class="request-row"${Number.isInteger(r.tmdbId) && r.tmdbId > 0 ? ` role="button" tabindex="0" data-detail-type="${r.mediaType}" data-detail-id="${r.tmdbId}" aria-label="Details for ${escape(r.title)}"` : ""}><span class="status-dot ${cls}"></span>${starHtml(r.watchKey,r.title)}<div class="grow"><strong>${escape(r.title)}</strong><small>${r.mediaType === "movie" ? "Movie" : "TV"} · by ${escape(r.requestedBy || "Unknown requester")}${r.createdAt ? ` · requested ${escape(new Date(r.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }))}` : ""}</small></div><span class="request-status-label">${label}</span></div>`;
        })
        .join("")
    : '<p class="empty">No requests yet.</p>';
}
let lastRequests = null, requestsVersion = 0;
async function loadRequests({ quiet = false } = {}) {
  const version = ++requestsVersion;
  if (!state.prefs.requests) return;
  try {
    const { requests, viewAllRequests } = await api(`/api/seerr/requests${state.prefs.myRequests ? "?mine=true" : ""}`);
    if (version !== requestsVersion) return;
    if (quiet && !safeShelfRefresh()) { delete shelfLastLoaded.requests; return; }
    const restricted = viewAllRequests === false, filter = $("#requests-filter");
    if (restricted) filter.querySelector('[value="all"]')?.remove();
    else if (!filter.querySelector('[value="all"]')) filter.insertAdjacentHTML("afterbegin", '<option value="all">Everyone&#39;s requests</option>');
    filter.value = restricted ? "mine" : state.prefs.myRequests ? "mine" : "all";
    shelfLastLoaded.requests = Date.now();
    if (JSON.stringify(lastRequests) !== JSON.stringify(requests) || !$("#requests").childElementCount) renderRequests(requests);
    lastRequests = requests;
  } catch (error) {
    if (quiet) $("#shelf-refresh-status").textContent = "Refresh unavailable. Keeping the last loaded requests.";
    else $("#requests").innerHTML = `<p class="empty">${escape(error.message)}</p>`;
  }
}
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#login-form button");
  button.disabled = true;
  try {
    const form = new FormData(event.target);
    const user = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(form)),
    });
    event.target.reset();
    await enter(user.name);
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#demo-login").addEventListener("click", async () => {
  try {
    const user = await api("/api/login", { method: "POST", body: "{}" });
    await enter(user.name);
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});
$("#logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    // Server removal is authoritative; browser cleanup is best effort.
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      await subscription?.unsubscribe();
    } catch {}
    location.reload();
  } catch (error) {
    report(error);
  }
});
function setDisplayName(name) {
  state.name = name;
  all(".app-name").forEach((el) => {
    el.textContent = name;
  });
  document.title = `${name} · Media dashboard`;
  $("#display-name").value = name;
}
$("#save-display-name").addEventListener("click", async () => {
  const button = $("#save-display-name");
  button.disabled = true;
  try {
    const data = await api("/api/display-name", {
      method: "POST",
      body: JSON.stringify({ name: $("#display-name").value }),
    });
    setDisplayName(data.name);
    $("#display-name-status").textContent = "Saved for everyone.";
  } catch (error) {
    $("#display-name-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#weather-city-search").addEventListener("click", async () => {
  const button = $("#weather-city-search");
  button.disabled = true;
  $("#weather-city-results").replaceChildren();
  try {
    const data = await api(
      `/api/weather/cities?query=${encodeURIComponent($("#weather-city-query").value.trim())}`,
    );
    state.cityResults = data.cities;
    $("#weather-city-results").innerHTML = data.cities
      .map(
        (city, index) =>
          `<button data-city="${index}">${escape(city.label)}</button>`,
      )
      .join("");
    $("#weather-settings-status").textContent = data.cities.length
      ? "Choose your city below."
      : "No cities found. Try a nearby city or add a country.";
  } catch (error) {
    $("#weather-settings-status").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#weather-city-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    $("#weather-city-search").click();
  }
});
$("#weather-city-results").addEventListener("click", (event) => {
  const button = event.target.closest("[data-city]");
  if (!button) return;
  const city = state.cityResults[Number(button.dataset.city)];
  if (!city) return;
  state.prefs.weatherCity = city;
  $("#weather-city-selected").textContent = city.label;
  $("#weather-city-results").replaceChildren();
  persist();
  saveWeather();
});
$("#weather-units").addEventListener("change", (event) => {
  state.prefs.weatherUnits = event.target.value;
  persist();
  saveWeather();
});
let jellyfinVersionRequest = 0;
function setJellyfinStatus(status) {
  const labels = { online: "Jellyfin online", offline: "Jellyfin offline", unknown: "Jellyfin status unknown", demo: "Demo mode: no Jellyfin connected" };
  for (const target of all(".jellyfin-status")) {
    target.dataset.status = status;
    target.title = labels[status];
    target.setAttribute("aria-label", labels[status]);
  }
  $("#jellyfin-state-label").textContent = status === "demo" ? "Demo" : status[0].toUpperCase() + status.slice(1);
}
async function loadJellyfinVersion() {
  const request = ++jellyfinVersionRequest;
  const target = $("#jellyfin-version");
  try {
    const result = await api("/api/jellyfin-version");
    if (request !== jellyfinVersionRequest) return;
    target.textContent = result.demo ? "Jellyfin server version: demo mode (no server connected)" : `Jellyfin server version: ${result.version || "unavailable"}`;
    setJellyfinStatus(result.demo ? "demo" : result.online === true ? "online" : result.online === false ? "offline" : "unknown");
  } catch {
    if (request !== jellyfinVersionRequest) return;
    target.textContent = "Jellyfin server version: unavailable";
    // A browser/network failure is not proof that Jellyfin is down.
    setJellyfinStatus("unknown");
  }
}
setInterval(() => {
  if (!document.hidden && !$("#dashboard").hidden) loadJellyfinVersion();
}, 60000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !$("#dashboard").hidden) loadJellyfinVersion();
});
function selectSettingsTab(name, focus = false) {
  for (const tab of Array.from(document.querySelectorAll("[data-settings-tab]"))) {
    const selected = tab.dataset.settingsTab === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $("#" + tab.getAttribute("aria-controls")).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  $("#settings").scrollTop = 0;
}
$("#settings-tabs").addEventListener("click", event => {
  const tab = event.target.closest("[data-settings-tab]");
  if (tab) selectSettingsTab(tab.dataset.settingsTab);
});
$("#settings-tabs").addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
  const index = tabs.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  selectSettingsTab(tabs[next].dataset.settingsTab, true);
});
$("#settings-button").addEventListener("click", () => { selectSettingsTab("general"); buildSectionOrder(); buildIconGuide(); $("#settings").showModal(); loadJellyfinVersion(); });
$("#default-view").addEventListener("change", (event) => {
  state.prefs.defaultView = event.target.value;
  delete state.prefs.lastView;
  persist();
});
all("[data-test]").forEach((button) =>
  button.addEventListener("click", async () => {
    const name = button.dataset.test;
    const label = name[0].toUpperCase() + name.slice(1);
    $("#connection-result").className = "";
    $("#connection-result").textContent = `Testing ${label}…`;
    try {
      const result = await api("/api/test-connection", {
        method: "POST",
        body: JSON.stringify({ service: name }),
      });
      if (name === "jellyfin") loadJellyfinVersion();
      $("#connection-result").className = result.ok ? "conn-ok" : "conn-fail";
      $("#connection-result").textContent = result.ok
        ? `${label}: connected.`
        : `${label}: ${result.error}`;
    } catch (error) {
      $("#connection-result").className = "conn-fail";
      $("#connection-result").textContent = `${label}: ${error.message}`;
    }
  }),
);
$("#hide-unmonitored").addEventListener("change", (event) => {
  state.prefs.hideUnmonitored = event.target.checked;
  persist();
  renderCalendar();
});
$("#shelf-back").addEventListener("click", () =>
  $("#recent").scrollBy({
    left: -$("#recent").clientWidth * 0.8,
    behavior: "smooth",
  }),
);
$("#shelf-next").addEventListener("click", () =>
  $("#recent").scrollBy({
    left: $("#recent").clientWidth * 0.8,
    behavior: "smooth",
  }),
);
$("#prev").addEventListener("click", () => move(-1));
$("#next").addEventListener("click", () => move(1));
$("#today").addEventListener("click", () => {
  state.date = new Date();
  loadCalendar();
});
$("#refresh").addEventListener("click", () =>
  Promise.all([
    loadRecent(),
    loadCalendar(),
    loadRequests(),
    loadPersonalShelves(),
    ...(state.prefs.weather ? [loadWeather()] : []),
  ]),
);
$("#filter-button").addEventListener("click", () => {
  $("#filters").hidden = !$("#filters").hidden;
  $("#filter-button").setAttribute("aria-expanded", !$("#filters").hidden);
});
all("#filters input").forEach((input) =>
  input.addEventListener("change", renderCalendar),
);
all("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    state.prefs.lastView = state.view;
    persist();
    loadCalendar();
  }),
);
// Live search: results update as the user types (250ms pause, at least 2 characters).
// Older requests are cancelled, and a response that arrives late is ignored.
let searchTimer = null;
let searchController = null;
let searchSeq = 0;
async function runSearch(query, network = null, page = 1) {
  clearTimeout(searchTimer);
  searchController?.abort();
  const seq = ++searchSeq;
  query = query.trim();
  $("#network-matches").replaceChildren();
  if (!network && query.length >= 3) api(`/api/networks?${new URLSearchParams({query})}`).then(data => {
    if (seq !== searchSeq) return;
    const networks = data.networks || [];
    $("#network-matches").innerHTML = networks.map(n => {
      const duplicate = networks.filter(other => other.name === n.name && other.country === n.country).length > 1;
      return `<button type="button" data-network="${n.id}" data-network-name="${escape(n.name)}">${escape(n.name)}${n.country ? ` · ${escape(n.country)}` : ""}${!n.country || duplicate ? ` · ID ${n.id}` : ""}</button>`;
    }).join("");
  }).catch(() => {});
  if (!query) {
    $("#search-status").textContent = "";
    if (!query) updateShelfHtml($("#search-results"), "");
    return;
  }
  searchController = new AbortController();
  // Keep the current results on screen while the next ones load; only show a
  // note if the answer is slow.
  const slow = setTimeout(() => {
    if (seq === searchSeq) $("#search-status").textContent = "Searching…";
  }, 600);
  try {
    const { results, requestAccess, network: selected, totalPages } = await api(
      `/api/seerr/search?${new URLSearchParams({ query, ...(network ? {network, page} : {}) })}`,
      { signal: searchController.signal },
    );
    if (seq !== searchSeq) return;
    $("#search-status").textContent = "";
    if (requestAccess) state.requestAccess = requestAccess;
    renderSearch(results);
    if (selected) {
      $("#search-status").textContent = `${selected.name}: newest series premieres · page ${page}`;
      $("#network-matches").innerHTML = `<button type="button" data-network-reset>Back to title search</button>${page > 1 ? `<button type="button" data-network="${network}" data-network-name="${escape(query)}" data-network-page="${page-1}">Previous</button>` : ""}${page < totalPages ? `<button type="button" data-network="${network}" data-network-name="${escape(query)}" data-network-page="${page+1}">Next</button>` : ""}`;
    }
  } catch (error) {
    if (error.name === "AbortError" || seq !== searchSeq) return;
    // Keep what is on screen; only say what went wrong.
    $("#search-status").textContent = /Too many requests/.test(error.message)
      ? "Searching too fast. Give it a moment and try again."
      : error.message;
  } finally {
    clearTimeout(slow);
  }
}
$("#network-matches").addEventListener("click",event=>{const button=event.target.closest("button");if(!button)return;if(button.hasAttribute("data-network-reset"))runSearch($("#search-form input[name=query]").value);else if(button.dataset.network)runSearch(button.dataset.networkName,button.dataset.network,Number(button.dataset.networkPage)||1);});
// Leave search: empty the box and the results and go back to the normal page.
function clearSearch() {
  clearTimeout(searchTimer);
  searchController?.abort();
  searchSeq++;
  const input = $("#search-form input[name=query]");
  input.value = "";
  $("#network-matches").replaceChildren();
  updateShelfHtml($("#search-results"), "");
  $("#search-status").textContent = "";
  $("#search-clear").hidden = true;
  input.blur();
}
function syncSearchClear() {
  $("#search-clear").hidden =
    !$("#search-form input[name=query]").value && !$("#search-results").children.length;
}
$("#search-clear").addEventListener("click", clearSearch);
$("#search-form input[name=query]").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    clearSearch();
  }
});
new MutationObserver(syncSearchClear).observe($("#search-results"), { childList: true });
$("#search-form input[name=query]").addEventListener("input", syncSearchClear);
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  runSearch(new FormData(event.target).get("query") || "");
});
$("#search-form input[name=query]").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const value = event.target.value;
  if (!value.trim()) return runSearch(value);
  searchTimer = setTimeout(() => runSearch(value), 250);
});
function seasonPill(status) {
  if (status === 5) return '<span class="season-pill available">Available</span>';
  if (status === 4) return '<span class="season-pill available">Partially available</span>';
  if (status === 3) return '<span class="season-pill pending">Processing</span>';
  if (status === 2) return '<span class="season-pill pending">Requested</span>';
  return '<span class="season-pill">Not requested</span>';
}
// Resolves with extra request fields, or null if the user cancels.
function askRequestOptions(button) {
  return new Promise(async (resolve) => {
    const dialog = $("#request-dialog");
    const isTv = button.dataset.mediaType === "tv";
    $("#request-title").textContent = `Request ${button.dataset.title}`;
    const status = $("#request-status");
    const seasonsBox = $("#request-seasons");
    const advanced = $("#request-advanced");
    const submit = $("#request-submit");
    status.textContent = "Loading options...";
    seasonsBox.hidden = true;
    seasonsBox.innerHTML = "";
    advanced.hidden = true;
    advanced.open = false;
    submit.disabled = true;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      resolve(value);
    };
    let options = { seasons: [], advanced: null };
    const sync = () => {
      const picked = all("#request-seasons input[data-season]:checked");
      submit.disabled = isTv && options.seasons.length > 0 && !picked.length;
      const toggle = $("#request-all");
      if (toggle) {
        const open = all("#request-seasons input[data-season]:not(:disabled)");
        toggle.checked = open.length > 0 && open.every((box) => box.checked);
        toggle.disabled = !open.length;
      }
    };
    $("#request-form").onsubmit = (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      const out = {};
      if (isTv && options.seasons.length)
        out.seasons = all("#request-seasons input[data-season]:checked").map((box) => Number(box.dataset.season));
      if (options.advanced && !advanced.hidden) {
        const profile = Number($("#request-profile").value);
        const root = $("#request-root").value;
        const a = options.advanced;
        // Only send choices that differ from Seerr's defaults.
        if (profile !== a.defaultProfileId || root !== a.defaultRootFolder)
          Object.assign(out, { serverId: a.serverId, profileId: profile, rootFolder: root });
      }
      finish(out);
    };
    $("#request-cancel").onclick = $("#request-close").onclick = () => finish(null);
    dialog.oncancel = () => finish(null);
    dialog.onclose = () => finish(null);
    dialog.showModal();
    try {
      options = await api(`/api/seerr/request-options?mediaType=${button.dataset.mediaType}&mediaId=${button.dataset.mediaId}`);
    } catch (error) {
      // Never leave the user stuck: without the extra options the request
      // still works and Seerr requests every season with its default settings.
      status.textContent = `Could not load the options (${error.message}). You can still request ${isTv ? "the whole series" : "it"} with Seerr's defaults.`;
      submit.disabled = false;
      return;
    }
    status.textContent = "";
    if (isTv && options.seasons.length) {
      seasonsBox.innerHTML =
        `<div class="season-row season-head"><input type="checkbox" id="request-all" aria-label="Select all seasons" /><span>Season</span><span># of episodes</span><span>Status</span></div>` +
        options.seasons
          .map((s) => {
            const locked = s.status >= 2;
            return `<label class="season-row${locked ? " is-locked" : ""}"><input type="checkbox" data-season="${s.number}"${locked ? " disabled" : " checked"} /><span>Season ${s.number}</span><span>${s.episodes}</span>${seasonPill(s.status)}</label>`;
          })
          .join("");
      seasonsBox.hidden = false;
      seasonsBox.onchange = (event) => {
        if (event.target.id === "request-all")
          for (const box of all("#request-seasons input[data-season]:not(:disabled)")) box.checked = event.target.checked;
        sync();
      };
    }
    const a = options.advanced;
    if (a && state.requestAccess.advanced) {
      $("#request-profile").innerHTML = a.profiles
        .map((p) => `<option value="${p.id}"${p.id === a.defaultProfileId ? " selected" : ""}>${escape(p.name)}</option>`)
        .join("");
      $("#request-root").innerHTML = a.rootFolders
        .map((f) => `<option value="${escape(f.path)}"${f.path === a.defaultRootFolder ? " selected" : ""}>${escape(f.path)}${f.freeSpace ? ` (${Math.round(f.freeSpace / 1e9)} GB free)` : ""}</option>`)
        .join("");
      advanced.hidden = false;
    }
    sync();
    if (isTv && options.seasons.length && submit.disabled)
      status.textContent = "Every season is already requested or available.";
  });
}
async function requestFromButton(event) {
  const button = event.target.closest("[data-request]");
  if (!button) return;
  const title = button.dataset.title;
  const needsDialog =
    button.dataset.mediaType === "tv" || state.requestAccess.advanced === true;
  let extra = {};
  if (needsDialog) {
    extra = await askRequestOptions(button);
    if (!extra) return;
  } else if (!confirm(`Request ${title}?`)) return;
  button.disabled = true;
  try {
    const result = await api("/api/seerr/request", {
      method: "POST",
      body: JSON.stringify({
        mediaType: button.dataset.mediaType,
        mediaId: Number(button.dataset.mediaId),
        ...extra,
      }),
    });
    const requestedState = { availability: result.status === 1 ? 2 : 3, requested: true };
    if (button.id === "episode-request") {
      button.hidden = true;
      delete button.dataset.request;
      $("#episode-poster-status").innerHTML = statusBadgeHtml(requestedState);
      $("#episode-request-status").textContent = "Requested";
      $("#episode-request-status").hidden = false;
      for (const other of all(".request-btn[data-request]")) {
        if (
          other.dataset.mediaId === button.dataset.mediaId &&
          other.dataset.mediaType === button.dataset.mediaType
        ) {
          other.closest(".result-card").querySelector(".poster-art").insertAdjacentHTML("beforeend", statusBadgeHtml(requestedState));
          other.closest(".result-card").dataset.availability = String(requestedState.availability);
          other.remove();
        }
      }
    } else {
      button.closest(".result-card").querySelector(".poster-art").insertAdjacentHTML("beforeend", statusBadgeHtml(requestedState));
      button.closest(".result-card").dataset.availability = String(requestedState.availability);
      button.remove();
    }
    loadRequests();
  } catch (error) {
    button.disabled = false;
    const status =
      button.id === "episode-request"
        ? $("#episode-request-status")
        : button.closest("#inTheaters-section") ? $("#inTheaters-status") : button.closest("#recommendations-section") ? $("#recommendations-status") : button.closest("#popular-section") ? $("#popular-status") : $("#search-status");
    status.textContent = error.message;
    status.hidden = false;
  }
}
$("#search-section").addEventListener("click", requestFromButton);
$("#episode-detail").addEventListener("click", requestFromButton);
$("#popular-section").addEventListener("click", requestFromButton);
$("#inTheaters-section").addEventListener("click", requestFromButton);
$("#recommendations-section").addEventListener("click", requestFromButton);
(async () => {
  const config = await api("/api/config");
  state.demo = config.demo;
  setDisplayName(config.name);
  $("#demo-badge").hidden = !config.demo;
  $("#login-form").hidden = config.demo;
  $("#demo-login").hidden = !config.demo;
  if (config.demo)
    $("#login-note").textContent =
      "Demo mode: invented titles and artwork. No server connection.";
  try {
    const user = await api("/api/me");
    await enter(user.name);
  } catch {
    $("#login").hidden = false;
  }
})().catch((error) => {
  $("#login").hidden = false;
  $("#login-error").textContent = error.message;
});
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });

all("[data-shelf]").forEach((button) =>
  button.addEventListener("click", () => {
    const shelf = document.getElementById(button.dataset.shelf);
    if (shelf)
      shelf.scrollBy({
        left: Number(button.dataset.direction) * shelf.clientWidth * 0.8,
        behavior: "smooth",
      });
  }),
);

// If a flag file is missing, fall back to the country code instead of a broken image.
document.addEventListener("error", (event) => {
  const img = event.target;
  if (img instanceof HTMLImageElement && img.classList.contains("flag"))
    img.replaceWith(Object.assign(document.createElement("span"), { className: "flag-code", textContent: img.dataset.code || "" }));
}, true);

const personalLabels = { leavingSoon: "Leaving soon", watchlist: "Favorites", watchLater: "Watchlist", topUnwatched: "Top unwatched movies", continueWatching: "Continue watching", watchNext: "What to watch next", nextUp: "Next up" };
let personalLoad = 0;
async function loadPersonalShelves() {
  const seq = ++personalLoad;
  if (!$("#watchlist-section")) {
    $("#personal-shelves").innerHTML = Object.entries(personalLabels).map(([key, label]) => `<section id="${key}-section" class="personal-section" hidden><div class="section-heading"><div><span class="eyebrow">JUST FOR YOU</span><h2>${label}</h2>${key === "watchNext" ? `<p>Unwatched picks already on your server</p><div class="watch-next-filters" aria-label="What to watch next filters"><button type="button" data-watch-next-filter="watchNextAnimation"></button><button type="button" data-watch-next-filter="watchNextType"></button></div>` : key === "leavingSoon" ? `<p class="departure-note">Scheduled by Maintainerr. Dates show eligibility, not guaranteed removal.</p>` : ""}</div><button class="personal-collapse" data-collapse="${key}" aria-controls="${key}-content" aria-expanded="true" aria-label="Collapse ${label}" title="Collapse ${label}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 7 5 5 5-5" /></svg></button></div><div id="${key}-content" class="poster-row"></div></section>`).join("");
  }
  applyPrefs();
  await Promise.all(Object.keys(personalLabels).map(key => {
    if (!["watchlist","watchLater"].includes(key) && !state.prefs[key]) return;
    return loadPersonalShelf(key, { seq });
  }));
}
const personalRequests = {};
async function loadPersonalShelf(key, { quiet = false, seq = personalLoad } = {}) {
  const request = (personalRequests[key] || 0) + 1; personalRequests[key] = request;
  try {
    const { items } = await shelfApi(key === "watchLater" ? "/api/watch-later" : key === "leavingSoon" ? "/api/leaving-soon" : key === "watchlist" ? "/api/watchlist" : `/api/personal/${key}`);
    if (request !== personalRequests[key] || seq !== personalLoad) return;
    if (quiet && !safeShelfRefresh()) { delete shelfLastLoaded[key]; return; }
    shelfLastLoaded[key] = Date.now();
    if(key === "watchLater") { watchLaterKeys = new Set(items.map(item=>item.key)); refreshStars(); }
    if (hideWhenEmpty.includes(key)) $(`#${key}-section`).hidden = !state.prefs[key] || !items.length;
    const previous = key === "watchlist" ? state.watchlistItems : state.personalItems[key];
    if (JSON.stringify(previous) === JSON.stringify(items) && $(`#${key}-content .poster-card`)) { retryBrokenPosters(`#${key}-content`); return; }
    if (key === "watchlist") state.watchlistItems = items;
    else state.personalItems[key] = items;
    replaceShelfContent($(`#${key}-content`), () => renderPersonalShelf(key, items));
  } catch (error) {
    if (quiet) { $("#shelf-refresh-status").textContent = "Refresh unavailable. Keeping the last loaded shelves."; return; }
    updateShelfHtml($(`#${key}-content`), `<p class="empty">${escape(error.message)}</p>`);
  }
}
function leavingLabel(item) {
  if (item.immediate) return "Eligible next Maintainerr run";
  const date = new Date(item.leavingAt);
  return date <= new Date() ? "Eligible for removal" : `Eligible ${date.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" })}`;
}
const watchNextModes = {watchNextAnimation: ["no","only","mixed"],watchNextType: ["movie","tv","both"]};
const watchNextModeLabels = {no:"No animation",only:"Animation only",mixed:"Mixed",movie:"Movies only",tv:"TV only",both:"Both"};
function updateWatchNextControls() {
  for (const [key,modes] of Object.entries(watchNextModes)) {
    const button = $(`[data-watch-next-filter="${key}"]`); if (!button) continue;
    const mode = modes.includes(state.prefs[key]) ? state.prefs[key] : modes.at(-1);
    button.textContent = watchNextModeLabels[mode];
    button.setAttribute("aria-label", `${key === "watchNextAnimation" ? "Animation filter" : "Title type filter"}: ${watchNextModeLabels[mode]}. Click for ${watchNextModeLabels[modes[(modes.indexOf(mode)+1)%3]]}`);
  }
}
function matchesWatchNextMode(item) {
  const type = item.detail?.mediaType || item.type;
  if (state.prefs.watchNextType !== "both" && type !== state.prefs.watchNextType) return false;
  if (state.prefs.watchNextAnimation === "mixed") return true;
  const genres = item.detail?.genres || [];
  const animated = genres.some(genre => typeof genre === "string" && genre.trim().toLowerCase() === "animation");
  return state.prefs.watchNextAnimation === "only" ? animated : genres.length > 0 && !animated;
}
const starIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg>';
let watchLaterKeys = new Set();
function starHtml(key,title) {return key ? `<button class="watch-star ${watchLaterKeys.has(key) ? "starred" : ""}" data-watch-key="${escape(key)}" aria-pressed="${watchLaterKeys.has(key)}" aria-label="${watchLaterKeys.has(key) ? "Remove from" : "Add to"} Watchlist: ${escape(title)}" title="${watchLaterKeys.has(key) ? "Remove from" : "Add to"} Watchlist">${starIcon}</button>` : "";}
function refreshStars() { for(const button of all('[data-watch-key]')) {const saved=watchLaterKeys.has(button.dataset.watchKey);button.classList.toggle("starred",saved);button.setAttribute("aria-pressed",String(saved));button.title=`${saved ? "Remove from" : "Add to"} Watchlist`;button.setAttribute("aria-label",button.title);} }
function setDetailStar(event) {const button=$('#episode-star');button.innerHTML=starIcon;button.hidden=!event.watchKey;button.dataset.watchKey=event.watchKey || '';refreshStars();}
function renderPersonalShelf(key, items) {
  if(key === "watchLater") {updateShelfHtml($('#watchLater-content'), items.length ? items.map((item,index)=>`<article class="poster-card watch-later-card"><button class="poster-link" data-watch-later-index="${index}"><div class="poster-art"><img src="${item.libraryId && item.image ? `/api/image/${encodeURIComponent(item.libraryId)}` : item.poster ? `/api/seerr/image?path=${encodeURIComponent(item.poster)}` : `/art/${escape(item.art || 'placeholder')}.svg`}" alt="" loading="lazy"></div><h3>${escape(item.title)}</h3></button>${starHtml(item.key,item.title)}<p>${escape([item.type==='movie'?'Movie':'TV',item.year].filter(Boolean).join(' · '))}</p></article>`).join('') : '<p class="empty">Star a movie or show on Jellyfin to save it for later. Separate from Jellyfin Favorites.</p>');return;}

  updateShelfHtml($(`#${key}-content`), items.length ? items.map((item, index) => {
    if (key === "watchNext" && !matchesWatchNextMode(item)) return "";
    const poster = item.image ? `/api/image/${encodeURIComponent(item.id)}` : `/art/${item.art || "placeholder"}.svg`;
    return `<article class="poster-card watch-later-card">${starHtml(item.watchKey,item.title)}<button class="poster-link" data-personal="${key}" data-index="${index}"><div class="poster-art"><img src="${escape(poster || "/art/placeholder.svg")}" alt="" loading="lazy">${watchedBadgeHtml(item)}${key === "continueWatching" ? `<progress class="poster-progress" max="100" value="${Math.min(100, Math.max(0, Number(item.progress) || 0))}" aria-label="${escape(item.title)} watch progress"></progress>` : ""}</div><h3>${escape(item.title)}</h3></button><p>${escape(libraryShelfMetadata(item))}</p>${key === "leavingSoon" ? `<p class="leaving-date">${escape(leavingLabel(item))}</p>` : ""}${key === "continueWatching" ? `<p>${item.remaining ? `${item.remaining} min left` : "In progress"}</p>` : ""}${key === "watchlist" ? `<button class="watchlist-remove" data-remove-id="${escape(item.favoriteId)}" aria-label="Remove ${escape(item.title)} from Jellyfin favorites" title="Remove from Jellyfin favorites" aria-pressed="true">${heartIcon}</button>` : ""}</article>`;
  }).join("") : `<p class="empty">${key === "watchNext" ? "No unwatched library picks right now." : key === "topUnwatched" ? "No unwatched movies rated 7 or higher right now." : key === "leavingSoon" ? "No eligible scheduled departures in your Jellyfin library." : key === "watchlist" ? "Your Jellyfin movie and series favorites appear here. Use the heart in a title's popout to add one." : key === "continueWatching" ? "Nothing in progress. Start watching in Jellyfin and it appears here." : "No next episodes yet. Your Jellyfin viewing history fills this shelf."}</p>`);
  if (key === "watchNext" && !$(`#${key}-content .poster-card`)) updateShelfHtml($(`#${key}-content`), '<p class="empty">No picks in this batch match your filters.</p>');
  fixBrokenPosters();
}
async function updateWatchlist(itemId, saved) {
  const data = await api("/api/watchlist", { method: "POST", body: JSON.stringify({ itemId, saved }) });
  await loadPersonalShelf("watchlist"); return data;
}
$("#episode-save").addEventListener("click", async () => {
  const event = currentDetail;
  if (!event?.favoriteId) return;
  event.favoriteBusy = true; $("#episode-save").disabled = true;
  try { const data = await updateWatchlist(event.favoriteId, event.favorite !== true); if (currentDetail === event) { Object.assign(event, data); event.favoriteWritten = true; setDetailSave(event); } }
  catch (error) { $("#episode-request-status").hidden = false; $("#episode-request-status").textContent = error.message; }
  finally { event.favoriteBusy = false; if (currentDetail === event) setDetailSave(event); }
});
$("#dashboard main").addEventListener("click", async event => {
  const savedTitle = event.target.closest('[data-watch-later-index]');
  if(savedTitle) {const item=state.personalItems.watchLater[Number(savedTitle.dataset.watchLaterIndex)];showDetail({...item.detail,watchKey:item.key,playLink:item.link,poster:item.image ? `/api/image/${encodeURIComponent(item.libraryId)}` : `/art/${item.art}.svg`,factsUrl:item.libraryUnavailable ? null : `/api/library/${encodeURIComponent(item.libraryId)}/facts`});return;}
  const filter = event.target.closest("[data-watch-next-filter]");
  if (filter) {
    const key = filter.dataset.watchNextFilter, modes = watchNextModes[key];
    state.prefs[key] = modes[(modes.indexOf(state.prefs[key])+1)%3];
    persist(); renderPersonalShelf("watchNext", state.personalItems.watchNext || []); return;
  }
  const collapse = event.target.closest("[data-collapse]");
  if (collapse) { const key = collapse.dataset.collapse; state.prefs[`${key}Collapsed`] = !state.prefs[`${key}Collapsed`]; collapse.setAttribute("aria-expanded", !state.prefs[`${key}Collapsed`]); collapse.setAttribute("aria-label", `${state.prefs[`${key}Collapsed`] ? "Expand" : "Collapse"} ${personalLabels[key]}`); persist(); return; }
  const remove = event.target.closest("[data-remove-id]");
  if (remove) { remove.disabled = true; try { await updateWatchlist(remove.dataset.removeId, false); } catch (error) { report(error); remove.disabled = false; } return; }
  const button = event.target.closest("[data-personal]");
  if (!button) return;
  const key = button.dataset.personal, item = (key === "watchlist" ? state.watchlistItems : state.personalItems[key])[Number(button.dataset.index)];
  { showDetail({ title: item.title, subtitle: item.subtitle, mediaType: item.detail?.mediaType || (item.watchedScope === "movie" ? "movie" : "tv"), ...item.detail, watchKey:item.watchKey, favoriteId: item.favoriteId, favorite: item.favorite, watched: item.watched, watchedScope: item.watchedScope, poster: item.image ? `/api/image/${encodeURIComponent(item.id)}` : `/art/${item.art || "placeholder"}.svg`, backdrop: item.backdropId ? `/api/image/${encodeURIComponent(item.backdropId)}?type=Backdrop` : null, playLink: item.link, availability: 5, factsUrl: `/api/library/${encodeURIComponent(item.id)}/facts` }); setDetailPlay(key === "continueWatching"); }
});

function buildIconGuide() {
  const target = $("#icon-guide-content");
  if (target.childElementCount) return;
  const outline = path => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="${path}"/></svg>`;
  const item = (icon, label, detail, cls = "") => `<li><span class="icon-guide-symbol ${cls}" aria-hidden="true">${icon}</span><span><strong>${label}</strong><small>${detail}</small></span></li>`;
  const group = (label, items) => `<div class="icon-guide-group"><h4>${label}</h4><ul>${items.join("")}</ul></div>`;
  const status = (icon, cls, label, detail) => item(`<span class="poster-status ${cls}">${seerrStatusIcons[icon]}</span>`, label, detail);
  target.innerHTML = [
    group("Posters and actions", [
      item(outline("M12 5v14M5 12h14"), "Request", "Ask Seerr for this title.", "request"),
      item(heartIcon, "Add favorite", "Outline heart: add to Jellyfin favorites.", "heart"),
      item(heartIcon, "Remove favorite", "Filled heart: already a favorite; tap to remove.", "heart filled"),
      item(watchedBadgeHtml({watched:true}), "Watched", "Already played. Season/series checks mean the whole season/show."),
      status("bell", "pending", "Pending", "Request is waiting for approval."),
      status("clock", "processing", "Processing", "Approved/requested; not fully available yet."),
      status("minus-small", "partial", "Partially available", "Some episodes or seasons are available."),
      status("check-circle", "available", "Available", "In the library; not a watched indicator."),
      status("eye-slash", "blocked", "Blocklisted", "Seerr marks this title as blocklisted."),
      status("trash", "deleted", "Deleted", "Media was removed, according to Seerr.")
    ])
  ].join("");
}

let notificationPrefs = { requests: false, shows: [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York" };
let notificationShows = [], notificationEnabled = false, notificationWrites = Promise.resolve();
function renderNotifications() {
  $("#notify-requests").checked = notificationPrefs.requests;
  $("#notify-timezone").value = notificationPrefs.timezone;
  $("#notify-enable").textContent = notificationEnabled ? "Disable on this device" : "Enable on this device";
  $("#notify-test").disabled = !notificationEnabled;
  $("#notify-show-list").innerHTML = notificationPrefs.shows.length ? notificationPrefs.shows.map(show => {
    const title = notificationShows.find(item => item.id === show.id)?.title || "Selected show (temporarily unavailable)";
    return `<article class="reminder-row"><strong class="reminder-title">${escape(title)}</strong><div class="reminder-options"><label class="reminder-option"><input type="checkbox" data-reminder-id="${escape(show.id)}" data-reminder-type="airs" ${show.airs ? "checked" : ""}>Airs today</label><label class="reminder-option"><input type="checkbox" data-reminder-id="${escape(show.id)}" data-reminder-type="available" ${show.available ? "checked" : ""}>New episode available</label></div><button class="utility-icon" data-reminder-remove="${escape(show.id)}" aria-label="Remove ${escape(title)} reminder" title="Remove reminder"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></article>`;
  }).join("") : '<p class="empty">No shows selected. Find a show to add it.</p>';
}
async function loadNotifications() {
  try {
    const result = await api("/api/notifications");
    notificationPrefs = result.preferences;
    notificationEnabled = result.enabled;
    const library = await api("/api/notification-shows"); notificationShows = library.shows;
    $("#notify-device-status").textContent = notificationEnabled ? "Enabled on this device." : "Not enabled on this device.";
    renderNotifications();
  } catch (error) { $("#notify-save-status").textContent = error.message; }
}
function saveNotifications() {
  const preferences = structuredClone(notificationPrefs);
  $("#notify-save-status").textContent = "Saving…";
  notificationWrites = notificationWrites.catch(() => {}).then(() => api("/api/notifications", { method: "POST", body: JSON.stringify(preferences) })).then(() => { $("#notify-save-status").textContent = "Saved to your account."; }).catch(error => { $("#notify-save-status").textContent = error.message; });
}
$("#settings-button").addEventListener("click", loadNotifications);

$("#notify-requests").addEventListener("change", event => { notificationPrefs.requests = event.target.checked; saveNotifications(); });
$("#notify-timezone").addEventListener("change", event => {
  try { new Intl.DateTimeFormat("en", { timeZone: event.target.value.trim() }); }
  catch { $("#notify-save-status").textContent = "Use a timezone such as America/New_York."; return; }
  notificationPrefs.timezone = event.target.value.trim(); saveNotifications();
});
let reminderSearchTimer, reminderSearchVersion = 0;
async function findReminderShows() {
  clearTimeout(reminderSearchTimer);
  const version = ++reminderSearchVersion;
  const query = $("#notify-show-query").value.trim();
  $("#notify-search-status").textContent = "Searching...";
  try {
    const result = await api(`/api/notification-shows?query=${encodeURIComponent(query)}`);
    if (version !== reminderSearchVersion) return;
    for (const show of result.shows) if (!notificationShows.some(item => item.id === show.id)) notificationShows.push(show);
    $("#notify-show-results").innerHTML = result.shows.map(show => `<button data-reminder-add="${escape(show.id)}" ${notificationPrefs.shows.some(item => item.id === show.id) ? "disabled" : ""}>Add ${escape(show.title)}</button>`).join("");
    $("#notify-search-status").textContent = result.shows.length ? `${result.shows.length} ${result.shows.length === 1 ? "show" : "shows"} found.` : "No matching shows in your Jellyfin library.";
  } catch (error) { if (version === reminderSearchVersion) $("#notify-search-status").textContent = error.message; }
}
$("#notify-show-query").addEventListener("input", () => {
  ++reminderSearchVersion;
  clearTimeout(reminderSearchTimer);
  $("#notify-show-results").replaceChildren();
  $("#notify-search-status").textContent = "Searching...";
  reminderSearchTimer = setTimeout(findReminderShows, 300);
});
$("#notify-show-query").addEventListener("keydown", event => {
  if (event.key === "Enter") { event.preventDefault(); findReminderShows(); }
});
$("#notify-find-shows").addEventListener("click", findReminderShows);

$("#notify-show-results").addEventListener("click", event => {
  const button = event.target.closest("[data-reminder-add]");
  if (!button || notificationPrefs.shows.length >= 50 || notificationPrefs.shows.some(show => show.id === button.dataset.reminderAdd)) return;
  notificationPrefs.shows.push({ id: button.dataset.reminderAdd, airs: false, available: false });
  button.disabled = true; renderNotifications(); saveNotifications();
});
$("#notify-show-list").addEventListener("change", event => {
  const target = event.target, show = notificationPrefs.shows.find(show => show.id === target.dataset.reminderId);
  if (!show || !["airs", "available"].includes(target.dataset.reminderType)) return;
  show[target.dataset.reminderType] = target.checked; saveNotifications();
});
$("#notify-show-list").addEventListener("click", event => {
  const button = event.target.closest("[data-reminder-remove]"); if (!button) return;
  notificationPrefs.shows = notificationPrefs.shows.filter(show => show.id !== button.dataset.reminderRemove);
  renderNotifications(); $("#notify-show-results").replaceChildren(); saveNotifications();
});
function pushKeyBytes(key) {
  const bytes = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, character => character.charCodeAt(0));
}
$("#notify-enable").addEventListener("click", async () => {
  const button = $("#notify-enable"); button.disabled = true;
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window) || !isSecureContext) throw new Error("Push is not supported here. On iPhone or iPad, add Marquee to your Home Screen and open it there.");
    // Start the permission prompt immediately inside the click gesture.
    const permission = notificationEnabled ? null : Notification.requestPermission();
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (notificationEnabled) {
      await api("/api/notifications/unsubscribe", { method: "POST", body: "{}" });
      await subscription?.unsubscribe(); notificationEnabled = false;
    } else {
      if (await permission !== "granted") throw new Error("Notifications are blocked. Change this site's permission in your browser settings.");
      const status = await api("/api/notifications");
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(status.publicKey) });
      try { await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) }); }
      catch (error) { await subscription.unsubscribe(); throw error; }
      notificationEnabled = true;
    }
    renderNotifications(); $("#notify-device-status").textContent = notificationEnabled ? "Enabled on this device." : "Disabled on this device.";
  } catch (error) { $("#notify-device-status").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#notify-test").addEventListener("click", async () => {
  try { await api("/api/notifications/test", { method: "POST", body: "{}" }); $("#notify-device-status").textContent = "Test sent. Check your notifications."; }
  catch (error) { $("#notify-device-status").textContent = error.message; }
});

document.addEventListener("click",async event=>{const button=event.target.closest('[data-watch-key]');if(!button || !button.dataset.watchKey)return;event.preventDefault();event.stopPropagation();const key=button.dataset.watchKey,saved=!watchLaterKeys.has(key);button.disabled=true;try{await api('/api/watch-later',{method:'POST',body:JSON.stringify({key,saved})});await loadPersonalShelf('watchLater');}catch(error){report(error);}finally{button.disabled=false;}},true);

let libraryStatsVersion = 0;
async function loadLibraryStats({quiet=false}={}) {
  if (!state.prefs.libraryStats) return;
  const version = ++libraryStatsVersion;
  try {
    const query=new URLSearchParams();
    if(state.prefs.kidsMoviesLibrary)query.set("kidsLibrary",state.prefs.kidsMoviesLibrary);
    if(state.prefs.kidsShowsLibrary)query.set("kidsShowsLibrary",state.prefs.kidsShowsLibrary);
    const data = await api(`/api/library-stats?${query}`);
    if (version !== libraryStatsVersion || !state.prefs.libraryStats) return;
    if(quiet && !safeShelfRefresh()) {delete shelfLastLoaded.libraryStats;return;}
    shelfLastLoaded.libraryStats=Date.now();
    const select = $("#kids-movies-library");
    select.innerHTML = '<option value="">Choose a library</option>' + data.libraries.filter(lib=>lib.type === "movies").map(lib=>`<option value="${escape(lib.id)}">${escape(lib.name)}</option>`).join("");
    select.value = data.kidsLibrary || "";
    const showsSelect=$("#kids-shows-library");
    showsSelect.innerHTML = '<option value="">Choose a library</option>' + data.libraries.filter(lib=>lib.type === "tvshows").map(lib=>`<option value="${escape(lib.id)}">${escape(lib.name)}</option>`).join("");
    showsSelect.value=data.kidsShowsLibrary || "";
    const markup = [["Movies",data.counts.movies],["Kids Movies",data.counts.kidsMovies],["TV Shows",data.counts.tvShows],["Kids Shows",data.counts.kidsShows],["Episodes",data.counts.episodes],["Kids Episodes",data.counts.kidsEpisodes]].map(([label,count])=>`<article class="library-stat"><h3>${label}</h3><strong>${Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString("en-US") : "-"}</strong>${count == null ? "<small>Choose a library in Settings</small>" : ""}</article>`).join("");
    if($("#libraryStats-content").innerHTML !== markup)$("#libraryStats-content").innerHTML=markup;
    $("#libraryStats-status").textContent = "";
    $("#library-stats-settings-status").textContent = data.selectionUnavailable ? "The selected library is no longer available to this account. Choose another library." : "";
  } catch (error) {
    if (version !== libraryStatsVersion) return;
    if(quiet) {$("#shelf-refresh-status").textContent="Refresh unavailable. Keeping the last loaded counts.";return;}
    $("#libraryStats-content").replaceChildren();
    $("#libraryStats-status").textContent = "Library counts could not be loaded from Jellyfin.";
  }
}
$("#kids-movies-library").addEventListener("change", event=>{state.prefs.kidsMoviesLibrary=event.target.value;persist();loadLibraryStats();});

$("#kids-shows-library").addEventListener("change",event=>{state.prefs.kidsShowsLibrary=event.target.value;persist();loadLibraryStats();});

function apiWhen(ms) { return ms ? new Date(ms).toLocaleString() : "never"; }
async function loadApiTokens() {
  try {
    const data = await api("/api/tokens");
    $("#api-admin").hidden = !data.isAdmin;
    $("#api-enabled").checked = data.enabled;
    $("#api-off").hidden = data.enabled;
    $("#api-body").hidden = !data.enabled;
    $("#api-list").innerHTML = data.tokens.length ? data.tokens.map(t => `<article class="reminder-row"><strong class="reminder-title">${escape(t.name)}</strong><span class="api-meta">${t.scope === "request" ? "Read and request" : "Read only"} · made ${escape(apiWhen(t.created))} · last used ${escape(apiWhen(t.lastUsed))}</span><button class="utility-icon" data-token-revoke="${escape(t.id)}" aria-label="Revoke ${escape(t.name)}" title="Revoke token"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg></button></article>`).join("") : "<small>No tokens yet.</small>";
  } catch (error) { $("#api-status").textContent = error.message; }
}
$("#settings-api-tab").addEventListener("click", loadApiTokens);
$("#api-enabled").addEventListener("change", async event => {
  try { await api("/api/tokens/enabled", { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }); } catch (error) { $("#api-status").textContent = error.message; }
  loadApiTokens();
});
$("#api-create").addEventListener("click", async () => {
  $("#api-status").textContent = "Creating…";
  try {
    const made = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: $("#api-name").value, scope: $("#api-scope").value, password: $("#api-password").value }) });
    $("#api-password").value = ""; $("#api-name").value = "";
    $("#api-new-token").textContent = made.token; $("#api-new").hidden = false;
    $("#api-status").textContent = "Token created.";
    loadApiTokens();
  } catch (error) { $("#api-password").value = ""; $("#api-status").textContent = error.message; }
});
$("#api-copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#api-new-token").textContent); $("#api-status").textContent = "Copied."; } catch { $("#api-status").textContent = "Select the token and copy it."; }
});
$("#api-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-token-revoke]");
  if (!button) return;
  try { await api("/api/tokens/" + encodeURIComponent(button.dataset.tokenRevoke), { method: "DELETE" }); $("#api-new").hidden = true; $("#api-new-token").textContent = ""; $("#api-status").textContent = "Token revoked."; } catch (error) { $("#api-status").textContent = error.message; }
  loadApiTokens();
});
