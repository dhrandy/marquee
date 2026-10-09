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
};
const defaults = {
  recent: true,
  calendar: true,
  legend: true,
  addedDates: true,
  shelfNavigation: true,
  weather: false,
  weatherCity: null,
  weatherUnits: "fahrenheit",
  search: true,
  hideUnmonitored: false,
  requests: true,
  popular: true,
  ratings: true,
  colorblind: false,
  jellyfinLink: true,
  popularCollapsed: false,
  defaultView: "auto",
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
function monday(date) {
  return addDays(midnight(date), -((date.getDay() + 6) % 7));
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (response.status === 401 && path !== "/api/login") {
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
  const { weather, weatherCity, weatherUnits, colorblind, ...devicePrefs } =
    state.prefs;
  localStorage.setItem(state.key, JSON.stringify(devicePrefs));
  applyPrefs();
}
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
function applyPrefs() {
  document.body.classList.toggle("colorblind", Boolean(state.prefs.colorblind));
  $("#jellyfin-home").hidden =
    !state.prefs.jellyfinLink || !$("#jellyfin-home").hasAttribute("href");
  all(".media-rating").forEach((el) => {
    el.hidden = !state.prefs.ratings || !el.textContent;
  });
  $("#recent-section").hidden = !state.prefs.recent;
  $("#calendar-section").hidden = !state.prefs.calendar;
  $("#search-section").hidden = !state.prefs.search;
  $("#popular-section").hidden = !state.prefs.popular;
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
  $("#requests-section").hidden = !state.prefs.requests;
  $("#legend").hidden = !state.prefs.legend;
  $(".recent-controls").hidden = !state.prefs.shelfNavigation;
  all(".shelf-controls").forEach((el) => {
    el.hidden = !state.prefs.shelfNavigation;
  });
  all(".poster-card time").forEach((el) => {
    el.hidden = !state.prefs.addedDates;
  });
  $("#nothing").hidden = state.prefs.recent || state.prefs.calendar;
  $("#weather").hidden = !state.prefs.weather;
  if (state.prefs.weather) loadWeather();
  scheduleWeather();
}
function buildSettings() {
  const labels = {
    recent: "Recently added",
    calendar: "Release calendar",
    search: "Search and requests",
    requests: "Request status list",
    popular: "Top 10 movies and TV",
    ratings: "Show ratings",
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
      persist();
      if (el.dataset.pref === "colorblind")
        api("/api/accessibility-settings", {
          method: "POST",
          body: JSON.stringify({ colorblind: el.checked }),
        }).catch(report);
      if (el.dataset.pref === "weather") saveWeather();
      if (el.dataset.pref === "popular" && el.checked) loadPopular();
      if (el.dataset.pref === "requests" && el.checked) loadRequests();
    }),
  );
  $("#default-view").value = state.prefs.defaultView;
  $("#weather-units").value = state.prefs.weatherUnits;
  $("#weather-city-selected").textContent =
    state.prefs.weatherCity?.label || "No city selected";
  $("#display-name").value = state.name;
  $("#weather-city-results").replaceChildren();
  $("#weather-settings-status").textContent = "";
}
async function enter(name) {
  state.key = `marquee:${name}:preferences`;
  try {
    state.prefs = {
      ...defaults,
      ...JSON.parse(localStorage.getItem(state.key) || "{}"),
    };
  } catch {
    state.prefs = { ...defaults };
  }
  const [weatherSettings, accessibilitySettings] = await Promise.all([
    api("/api/weather-settings"),
    api("/api/accessibility-settings"),
  ]);
  Object.assign(state.prefs, weatherSettings, accessibilitySettings);
  state.view =
    state.prefs.lastView ||
    (state.prefs.defaultView === "auto" ? "agenda" : state.prefs.defaultView);
  $("#hide-unmonitored").checked = Boolean(state.prefs.hideUnmonitored);
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
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
  state.requestAccess = me.requestAccess || {
    movie: me.canRequest,
    tv: me.canRequest,
  };
  $("#display-name-settings").hidden = !me.isAdmin;
  await Promise.all([
    loadRecent(),
    loadCalendar(),
    loadRequests(),
    loadPopular(),
  ]);
}
function fixBrokenPosters() {
  all(".poster-art img").forEach((image) =>
    image.addEventListener(
      "error",
      () => {
        image.src = "/art/placeholder.svg";
      },
      { once: true },
    ),
  );
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
async function loadRecent() {
  try {
    const { items } = await api("/api/recent");
    state.recentItems = items;
    $("#recent").innerHTML = items.length
      ? items
          .map((item) => {
            const art = `<div class="poster-art"><img src="${item.image ? `/api/image/${encodeURIComponent(item.id)}` : `/art/${escape(item.art)}.svg`}" alt="${escape(item.title)} poster" loading="lazy"></div>`;
            const time = `<time ${!state.prefs.addedDates ? "hidden" : ""}>${item.added ? escape(new Date(item.added).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "Added date not provided"}</time>`;
            const title = `<h3>${escape(item.title)}</h3>`;
            const head = `<button class="poster-link recent-detail" data-recent-index="${items.indexOf(item)}" aria-label="Details for ${escape(item.title)}">${art}${title}</button>`;
            return `<article class="poster-card">${head}${time}<p>${escape(item.subtitle)}</p>${ratingHtml(item.rating)}</article>`;
          })
          .join("")
      : '<p class="empty">No recent titles in your Jellyfin library.</p>';
    fixBrokenPosters();
  } catch (error) {
    $("#recent").innerHTML = `<p class="empty">${escape(error.message)}</p>`;
  }
}
$("#recent").addEventListener("click", (event) => {
  const button = event.target.closest("[data-recent-index]");
  if (!button) return;
  const item = state.recentItems[Number(button.dataset.recentIndex)];
  if (!item) return;
  showDetail({
    title: item.title,
    subtitle: item.subtitle,
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
    start = monday(
      new Date(state.date.getFullYear(), state.date.getMonth(), 1),
    );
    end = addDays(
      monday(new Date(state.date.getFullYear(), state.date.getMonth() + 1, 0)),
      7,
    );
  } else if (state.view === "week") {
    start = monday(state.date);
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
async function loadCalendar() {
  const request = ++calendarRequest;
  const { start, end } = period();
  $("#refresh").disabled = true;
  $("#calendar").innerHTML = '<p class="empty">Loading calendar…</p>';
  try {
    const data = await api(
      `/api/calendar?${new URLSearchParams({ start: start.toISOString(), end: end.toISOString() })}`,
    );
    if (request !== calendarRequest) return;
    state.events = data.events;
    $("#calendar-warning").textContent = data.warnings.join(" ");
    $("#calendar-warning").hidden = !data.warnings.length;
    renderCalendar();
    $("#updated").textContent =
      `Refreshed ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (error) {
    if (request === calendarRequest)
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
  return `<article class="entry ${escape(event.status)}${premiere ? " premiere" : ""}"${event.type === "tv" ? ` role="button" tabindex="0" data-event="${escape(event.id)}" aria-label="Details for ${escape(event.title)}"` : ""}><span class="entry-status">${icon}${escape(event.type === "movie" ? statusLabel[event.status] : `${time} · ${premiere ? "Season premiere" : statusLabel[event.status]}`)}</span><h4>${escape(event.title)}</h4><p>${escape(event.subtitle)}</p></article>`;
}
function openEpisode(id) {
  const event = state.events.find(
    (event) => event.id === id && event.type === "tv",
  );
  if (!event) return;
  showDetail({
    ...event,
    factsUrl: event.tmdbId ? `/api/seerr/details/tv/${event.tmdbId}` : null,
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
function statusBadgeHtml(item) {
  const label = mediaActionLabel(item);
  if (!label) return "";
  const [icon, cls] = ({2:["bell","pending"],3:["clock","processing"],4:["minus-small","partial"],5:["check-circle","available"],6:["eye-slash","blocked"],7:["trash","deleted"]})[item.availability] || ["clock","processing"];
  return `<span class="poster-status ${cls}" role="img" aria-label="${label}" title="${label}">${seerrStatusIcons[icon]}</span>`;
}
function renderDetailFacts(facts) {
  const panel = $("#episode-facts");
  panel.innerHTML = "";
  panel.hidden = true;
  if (!facts) return;
  const scores = facts.scores || {};
  const ratings = [["critics", "🍅", "Rotten Tomatoes critics", "%"], ["audience", "🍿", "Rotten Tomatoes audience", "%"], ["imdb", "IMDb", "IMDb", "/10"], ["tmdb", "TMDB", "TMDB user score", "%"]]
    .filter(([key]) => Number.isFinite(scores[key]) && scores[key] >= 0);
  let html = state.prefs.ratings && ratings.length ? `<div class="detail-scores">${ratings.map(([key, icon, label, suffix]) => `<span class="detail-score" title="${label}" aria-label="${label}: ${scores[key]}${suffix}"><span class="score-mark ${key}">${icon}</span> ${scores[key]}${suffix}</span>`).join("")}</div>` : "";
  const row = (label, value) => `<div class="detail-fact"><strong>${label}</strong><span>${value}</span></div>`;
  if (facts.status) html += row("Status", escape(facts.status));
  if (facts.releases?.length) html += row("Release dates", facts.releases.map(r => {
    const date = new Date(`${r.date}T12:00:00Z`);
    if (!Number.isFinite(date.getTime())) return "";
    const icon = ({ Theatrical:"🎟", Digital:"☁", Physical:"◉", "First aired":"▣" })[r.type] || "▦";
    return `<span class="detail-release" title="${escape(r.type)}${r.region ? ` (${escape(r.region)})` : ""}"><span class="release-label"><span aria-hidden="true">${icon}</span><small>${escape(r.type)}${r.region ? ` · ${escape(r.region)}` : ""}</small></span><span class="release-date">${escape(date.toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric",timeZone:"UTC"}))}</span></span>`;
  }).join(""));
  if (facts.productionCountries?.length) html += row("Production", `<span class="country-flags">${facts.productionCountries.map(c => `<span tabindex="0" title="${escape(c.name)}" aria-label="${escape(c.name)}">${/^[A-Z]{2}$/.test(c.code) ? String.fromCodePoint(...[...c.code].map(x => 127397 + x.charCodeAt())) : escape(c.name)}</span>`).join(" ")}</span>`);
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
        api(source).then((data) => data.facts || null),
      );
    const facts = await factsCache.get(source);
    if (!facts) {
      factsCache.delete(source);
      return;
    }
    // Ignore the answer if another popup was opened in the meantime.
    if (request !== factsRequest || !$("#episode-detail").open) return;
    renderDetailFacts(facts);
    $("#episode-rating").hidden = ratingHidden(event.rating, facts);
  } catch {
    factsCache.delete(source);
  }
}
function showDetail(event) {
  factsRequest++;
  renderDetailFacts(event.facts);
  $("#episode-title").textContent =
    `${event.title}${event.year ? ` (${event.year})` : ""}`;
  $("#episode-subtitle").textContent = event.subtitle;
  const requestButton = $("#episode-request");
  const actionLabel = mediaActionLabel(event);
  $("#episode-poster-status").innerHTML = statusBadgeHtml(event);
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
  contentRating.hidden = !contentRating.textContent;
  contentRating.title = event.contentRatingRegion
    ? `Content rating (${event.contentRatingRegion})`
    : "Content rating";
  $("#episode-meta").textContent = [
    event.network,
    event.runtime ? `${event.runtime} min` : null,
    statusLabel[event.status] || event.subtitle,
  ]
    .filter(Boolean)
    .join(" · ");
  const cast = $("#episode-cast");
  const names = Array.isArray(event.cast)
    ? event.cast.filter((n) => typeof n === "string").slice(0, 4)
    : [];
  cast.textContent = names.length ? `Cast: ${names.join(", ")}` : "";
  cast.hidden = !names.length;
  // Same text twice: desktop shows it under the title, phones keep it in the body.
  $("#episode-overview").textContent = $("#episode-overview-top").textContent =
    event.overview || "Overview not available yet.";
  $("#episode-genres").innerHTML = (event.genres || [])
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
  play.hidden = !event.playLink;
  if (event.playLink) play.href = event.playLink;
  else play.removeAttribute("href");
  $("#episode-trailer").href =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(event.title + " official trailer")}`;
  $("#episode-detail").showModal();
  loadMissingFacts(event);
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
    let html = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
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
  if (!state.prefs.weather || !state.prefs.weatherCity) return;
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
async function loadWeather() {
  try {
    const city = state.prefs.weatherCity;
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
      `${city.label} · ${Math.round(data.current.temperature_2m)}°${data.current_units.temperature_2m.replace("°", "")} · ${codes[data.current.weather_code] || "Mixed conditions"}`;
    $("#weather-forecast").textContent = data.daily.time
      .map(
        (date, i) =>
          `${new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short" })} ${Math.round(data.daily.temperature_2m_max[i])}° / ${Math.round(data.daily.temperature_2m_min[i])}°`,
      )
      .join("     ·     ");
  } catch (error) {
    $("#weather-content").textContent = error.message;
    $("#weather-forecast").textContent = "";
  }
}
function resultCardHtml(r) {
  const label = mediaActionLabel(r);
  const action = label
    ? ""
    : state.requestAccess[r.mediaType]
      ? `<button class="request-btn" data-request data-media-type="${r.mediaType}" data-media-id="${r.id}" data-title="${escape(r.title)}">Request</button>`
      : `<span class="request-unavailable">${escape(state.requestAccess.reason || state.requestAccess[`${r.mediaType}Reason`] || "Requests disabled in Seerr")}</span>`;
  return `<article class="result-card" data-availability="${Number.isInteger(r.availability) ? r.availability : ""}"><div class="poster-art" role="button" tabindex="0" data-detail-type="${r.mediaType}" data-detail-id="${r.id}" aria-label="Details for ${escape(r.title)}"><img src="${r.poster ? (r.poster.startsWith("/") ? `/api/seerr/image?path=${encodeURIComponent(r.poster)}` : `/art/${encodeURIComponent(r.poster)}.svg`) : "/art/placeholder.svg"}" alt="" loading="lazy">${statusBadgeHtml(r)}</div><h3>${escape(r.title)}</h3><p class="result-meta">${r.mediaType === "movie" ? "Movie" : "TV"}${r.year ? ` · ${escape(r.year)}` : ""}${availabilityText(r.availability) ? ` · ${availabilityText(r.availability)}` : ""}</p>${ratingHtml(r.rating)}${r.overview ? `<p class="result-overview">${escape(r.overview)}</p>` : ""}<div class="result-action">${action}</div></article>`;
}
function renderSearch(results) {
  $("#search-results").innerHTML = results.length
    ? results.map(resultCardHtml).join("")
    : '<p class="empty">Nothing found. Try another title.</p>';
  fixBrokenPosters();
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
  ["#search-results", "#search-status"],
  ["#requests", "#global-error"],
]) {
  $(container).addEventListener("click", (event) => {
    const card = event.target.closest("[data-detail-id]");
    if (card) openMediaDetail(card, $(status));
  });
  $(container).addEventListener("keydown", (event) => {
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
      $("#popular-" + type).innerHTML = data[type]
        .map(
          (item, i) =>
            `<div class="ranked-poster"><span class="popular-rank">${i + 1}</span>${resultCardHtml(item)}</div>`,
        )
        .join("");
    }
    $("#popular-status").textContent = "";
    fixBrokenPosters();
  } catch (error) {
    $("#popular-status").textContent = error.message;
  }
}
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
          return `<div class="request-row"${Number.isInteger(r.tmdbId) && r.tmdbId > 0 ? ` role="button" tabindex="0" data-detail-type="${r.mediaType}" data-detail-id="${r.tmdbId}" aria-label="Details for ${escape(r.title)}"` : ""}><span class="status-dot ${cls}"></span><div class="grow"><strong>${escape(r.title)}</strong><small>${r.mediaType === "movie" ? "Movie" : "TV"} · by ${escape(r.requestedBy || "Unknown requester")}${r.createdAt ? ` · requested ${escape(new Date(r.createdAt).toLocaleDateString([], { month: "short", day: "numeric" }))}` : ""}</small></div><span class="request-status-label">${label}</span></div>`;
        })
        .join("")
    : '<p class="empty">No requests yet.</p>';
}
async function loadRequests() {
  if (!state.prefs.requests) return;
  try {
    const { requests } = await api("/api/seerr/requests");
    renderRequests(requests);
  } catch (error) {
    $("#requests").innerHTML = `<p class="empty">${escape(error.message)}</p>`;
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
$("#settings-button").addEventListener("click", () =>
  $("#settings").showModal(),
);
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
$("#search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = new FormData(event.target).get("query");
  $("#search-status").textContent = "Searching…";
  try {
    const { results, requestAccess } = await api(
      `/api/seerr/search?${new URLSearchParams({ query })}`,
    );
    $("#search-status").textContent = "";
    if (requestAccess) state.requestAccess = requestAccess;
    renderSearch(results);
  } catch (error) {
    $("#search-status").textContent = error.message;
    $("#search-results").innerHTML = "";
  }
});
async function requestFromButton(event) {
  const button = event.target.closest("[data-request]");
  if (!button) return;
  const title = button.dataset.title;
  if (!confirm(`Request ${title}?`)) return;
  button.disabled = true;
  try {
    const result = await api("/api/seerr/request", {
      method: "POST",
      body: JSON.stringify({
        mediaType: button.dataset.mediaType,
        mediaId: Number(button.dataset.mediaId),
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
        : $("#search-status");
    status.textContent = error.message;
    status.hidden = false;
  }
}
$("#search-section").addEventListener("click", requestFromButton);
$("#episode-detail").addEventListener("click", requestFromButton);
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
