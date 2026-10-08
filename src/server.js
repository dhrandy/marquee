import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  authenticate,
  recentItems,
  calendar,
  jellyfinHeaders,
  seerrSearch,
  seerrPopular,
  seerrIdentity,
  seerrRequest,
  seerrRequests,
  testService,
} from "./adapters.js";
import { demoEvents, demoRequests, demoSearch, titles } from "./demo.js";
import { validateRange } from "./model.js";

const settingsPath = path.join(
  process.env.MARQUEE_DATA_DIR || path.join(os.homedir(), ".marquee"),
  "settings.json",
);
let displayName = "Marquee";
let savedSettings = { weatherByUser: {} };
try {
  const saved = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  savedSettings = { ...saved, weatherByUser: saved.weatherByUser || {} };
  if (
    typeof saved.name === "string" &&
    saved.name.trim() &&
    saved.name.length <= 40
  )
    displayName = saved.name;
} catch (error) {
  if (error.code !== "ENOENT")
    console.warn("Display settings could not be loaded; using Marquee.");
}
let settingsWrites = Promise.resolve();
function saveSettings(update) {
  const write = settingsWrites
    .catch(() => {})
    .then(async () => {
      const next = update(savedSettings);
      if (!demo) {
        await fs.mkdir(path.dirname(settingsPath), {
          recursive: true,
          mode: 0o700,
        });
        await fs.writeFile(settingsPath + ".tmp", JSON.stringify(next), {
          mode: 0o600,
        });
        await fs.rename(settingsPath + ".tmp", settingsPath);
      }
      savedSettings = next;
    });
  settingsWrites = write;
  return write;
}
const defaultWeather = {
  weather: false,
  weatherCity: null,
  weatherUnits: "fahrenheit",
};
function validWeather(value) {
  const city = value?.weatherCity;
  return (
    typeof value?.weather === "boolean" &&
    ["fahrenheit", "celsius"].includes(value.weatherUnits) &&
    (city === null ||
      (city &&
        typeof city.label === "string" &&
        city.label.length <= 200 &&
        !/[<>\x00-\x1f]/.test(city.label) &&
        Number.isFinite(city.latitude) &&
        Math.abs(city.latitude) <= 90 &&
        Number.isFinite(city.longitude) &&
        Math.abs(city.longitude) <= 180))
  );
}
const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const demo = process.env.DEMO_MODE === "true";
const secure = process.env.COOKIE_SECURE !== "false";
const sessions = new Map();
const attempts = new Map();
const ttl = 8 * 60 * 60 * 1000;
const port = Number(process.env.PORT || 8739);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Browser writes must be same-origin. Non-browser clients can use a same-origin header.
    const origin = req.headers.origin;
    if (
      !origin ||
      !["http:", "https:"].some(
        (protocol) => origin === `${protocol}//${req.headers.host}`,
      )
    ) {
      return res.status(403).json({ error: "Request origin not allowed." });
    }
  }
  next();
});
app.use(express.json({ limit: "4kb" }));

function session(req) {
  const id = /(?:^|; )marquee_session=([a-f0-9]{64})(?:;|$)/.exec(
    req.headers.cookie || "",
  )?.[1];
  const data = sessions.get(id);
  if (data && data.expires > Date.now()) return { sid: id, ...data };
  return null;
}
function requireUser(req, res, next) {
  req.user = session(req);
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}
function cookie(res, value, maxAge) {
  res.cookie("marquee_session", value, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    maxAge,
    path: "/",
  });
}

app.get("/api/config", (req, res) => res.json({ demo, name: displayName }));
app.post("/api/login", async (req, res) => {
  const ip = req.socket.remoteAddress;
  const current = attempts.get(ip) || {
    count: 0,
    until: Date.now() + 15 * 60 * 1000,
  };
  if (current.until < Date.now()) {
    current.count = 0;
    current.until = Date.now() + 15 * 60 * 1000;
  }
  if (current.count >= 10)
    return res
      .status(429)
      .json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
  current.count++;
  attempts.set(ip, current);
  const { username, password } = req.body || {};
  if (
    !demo &&
    (typeof username !== "string" ||
      typeof password !== "string" ||
      !username ||
      !password ||
      username.length > 120 ||
      password.length > 1000)
  ) {
    return res
      .status(400)
      .json({ error: "Enter your Jellyfin username and password." });
  }
  try {
    const user = demo
      ? { id: "demo", name: "Demo viewer", isAdmin: true }
      : await authenticate(username, password);
    const old = session(req);
    if (old) sessions.delete(old.sid);
    const id = crypto.randomBytes(32).toString("hex");
    sessions.set(id, {
      ...user,
      expires: Date.now() + ttl,
      allowedImages: new Set(),
    });
    cookie(res, id, ttl);
    attempts.delete(ip);
    res.json({ name: user.name });
  } catch (error) {
    res.status(401).json({
      error: `Could not sign in. ${error.message}`,
    });
  }
});
app.post("/api/logout", requireUser, (req, res) => {
  sessions.delete(req.user.sid);
  cookie(res, "", 0);
  res.json({ ok: true });
});
async function requestAccess(user) {
  if (demo) return { id: 1, movie: true, tv: true };
  try {
    return await seerrIdentity(user.id);
  } catch (error) {
    const known =
      /^(No linked Seerr user|Multiple Seerr users|Connect Seerr|Seerr permissions|Seerr user list)/.test(
        error.message,
      );
    return {
      movie: false,
      tv: false,
      error: known
        ? error.message
        : "Seerr user permissions could not be checked. Ask your admin to check the connection and API key.",
    };
  }
}
function publicAccess(access) {
  return {
    movie: access.movie,
    tv: access.tv,
    reason: access.error || "",
    movieReason: access.movieReason || "",
    tvReason: access.tvReason || "",
  };
}
app.get("/api/me", requireUser, async (req, res) => {
  const access = await requestAccess(req.user);
  res.json({
    name: req.user.name,
    isAdmin: req.user.isAdmin === true,
    canRequest: access.movie || access.tv,
    requestAccess: publicAccess(access),
  });
});
app.get("/api/weather-settings", requireUser, (req, res) => {
  const value = savedSettings.weatherByUser[demo ? req.user.sid : req.user.id];
  res.json(validWeather(value) ? value : defaultWeather);
});
app.post("/api/weather-settings", requireUser, async (req, res) => {
  if (!validWeather(req.body))
    return res
      .status(400)
      .json({ error: "Choose valid weather units and city coordinates." });
  const { weather, weatherCity, weatherUnits } = req.body;
  const value = {
    weather,
    weatherCity: weatherCity
      ? {
          label: weatherCity.label,
          latitude: weatherCity.latitude,
          longitude: weatherCity.longitude,
        }
      : null,
    weatherUnits,
  };
  try {
    await saveSettings((current) => ({
      ...current,
      weatherByUser: {
        ...current.weatherByUser,
        [demo ? req.user.sid : req.user.id]: value,
      },
    }));
    res.json(value);
  } catch {
    res.status(500).json({
      error:
        "Could not save weather settings. Check the settings volume is writable.",
    });
  }
});
app.post("/api/display-name", requireUser, async (req, res) => {
  if (!req.user.isAdmin)
    return res.status(403).json({
      error: "Only a Jellyfin administrator can change the display name.",
    });
  const name = req.body?.name;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 40 ||
    /[<>\x00-\x1f\x7f]/.test(name)
  )
    return res.status(400).json({
      error:
        "Enter a display name of 1 to 40 characters, without markup or control characters.",
    });
  try {
    await saveSettings((current) => ({ ...current, name: name.trim() }));
    displayName = name.trim();
    res.json({ name: displayName });
  } catch {
    res.status(500).json({
      error:
        "Could not save the display name. Check the settings volume is writable.",
    });
  }
});
app.get("/api/seerr/popular", requireUser, async (req, res) => {
  if (demo) {
    const sample = demoSearch("");
    const movieNames = [
      "The Last Signal",
      "Orbit Nine",
      "Faraway Station",
      "Paper Skies",
      "The Long Weekend",
      "Quiet Water",
      "City of Glass",
      "Red Horizon",
      "The Way Back",
      "Second Sunrise",
    ];
    const tvNames = [
      "North of Nowhere",
      "After Hours",
      "Wild Coast",
      "Small Town Radio",
      "A Season Apart",
      "The Crossing",
      "Night Lines",
      "Open Roads",
      "The Observatory",
      "Silver Pines",
    ];
    const arts = ["signal", "orbit", "moons", "north", "hours", "coast"];
    const list = (type) =>
      Array.from({ length: 10 }, (_, i) => ({
        ...sample.find((item) => item.mediaType === type),
        id: 1000 + i + (type === "tv" ? 100 : 0),
        title: (type === "tv" ? tvNames : movieNames)[i],
        poster: i === 0 ? (type === "tv" ? "north" : "signal") : i === 1 ? (type === "tv" ? "hours" : "orbit") : "placeholder",
        availability: i === 0 ? 5 : i === 1 ? 2 : null,
        requested: i === 1,
      }));
    return res.json({
      movies: list("movie"),
      tv: list("tv"),
      requestAccess: { movie: true, tv: true },
    });
  }
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    res.json({
      ...(await seerrPopular(access.id)),
      requestAccess: publicAccess(access),
    });
  } catch {
    res.status(502).json({
      error: "Popular titles are temporarily unavailable from Seerr.",
    });
  }
});
app.get("/api/seerr/search", requireUser, async (req, res) => {
  const query = String(req.query.query ?? "");
  const page = Number(req.query.page || 1);
  if (
    !query ||
    query.length > 120 ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 500
  )
    return res
      .status(400)
      .json({ error: "Enter a search term up to 120 characters." });
  if (demo) return res.json({ results: demoSearch(query) });
  if (!process.env.SEERR_URL || !process.env.SEERR_API_KEY)
    return res
      .status(503)
      .json({ error: "Connect Seerr in the server settings to search." });
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    res.json({
      results: await seerrSearch(query, page, access.id),
      requestAccess: publicAccess(access),
    });
  } catch {
    res.status(502).json({ error: "Seerr could not be reached." });
  }
});
app.post("/api/test-connection", requireUser, async (req, res) => {
  const { service } = req.body || {};
  if (!["jellyfin", "sonarr", "radarr", "seerr"].includes(service))
    return res.status(400).json({ error: "Unknown service." });
  if (demo) return res.json({ ok: true });
  res.json(await testService(service));
});
app.get("/api/seerr/requests", requireUser, async (req, res) => {
  if (demo) return res.json({ requests: demoRequests });
  if (!process.env.SEERR_URL || !process.env.SEERR_API_KEY)
    return res
      .status(503)
      .json({ error: "Connect Seerr in the server settings to see requests." });
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    res.json({ requests: await seerrRequests(access.id) });
  } catch {
    res.status(502).json({ error: "Seerr could not be reached." });
  }
});
app.post("/api/seerr/request", requireUser, async (req, res) => {
  const { mediaType, mediaId } = req.body || {};
  if (
    !["movie", "tv"].includes(mediaType) ||
    !Number.isInteger(mediaId) ||
    mediaId < 1 ||
    mediaId > 1e9
  )
    return res.status(400).json({ error: "Invalid request." });
  if (demo) return res.json({ ok: true });
  try {
    const access = await requestAccess(req.user);
    if (!access[mediaType])
      return res
        .status(403)
        .json({ error: access.error || access[`${mediaType}Reason`] });
    const result = await seerrRequest(mediaType, mediaId, access.id);
    res.json({ ok: true, status: result.status ?? null });
  } catch (error) {
    const denied = /Service returned (403|409)/.test(error.message);
    res.status(denied ? 403 : 502).json({
      error: denied
        ? "Seerr declined this request. Check your permissions, remaining quota, or whether it was already requested."
        : "Seerr could not complete the request.",
    });
  }
});
app.get("/api/seerr/image", requireUser, async (req, res) => {
  const poster = String(req.query.path || "");
  if (!/^\/[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/.test(poster))
    return res.status(400).json({ error: "Invalid image." });
  try {
    const base = process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org";
    const response = await fetch(`${base}/t/p/w342${poster}`, {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (
      !response.ok ||
      !/^image\/(jpeg|png|webp)/.test(
        response.headers.get("content-type") || "",
      )
    )
      return res.sendStatus(502);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 2 * 1024 * 1024) return res.sendStatus(502);
    res
      .type(response.headers.get("content-type"))
      .set("Cache-Control", "private, max-age=86400")
      .send(bytes);
  } catch {
    res.sendStatus(502);
  }
});
app.get("/api/recent", requireUser, async (req, res) => {
  try {
    const items = demo ? titles : await recentItems(req.user);
    for (const item of items)
      if (item.image) req.user.allowedImages.add(item.id);
    res.json({ items });
  } catch {
    res
      .status(502)
      .json({ error: "Recently added could not be loaded from Jellyfin." });
  }
});
app.get("/api/image/:id", requireUser, async (req, res) => {
  if (
    !req.user.allowedImages.has(req.params.id) ||
    !/^[a-zA-Z0-9-]+$/.test(req.params.id)
  )
    return res.sendStatus(404);
  try {
    const response = await fetch(
      `${process.env.JELLYFIN_URL.replace(/\/$/, "")}/Items/${req.params.id}/Images/Primary?maxWidth=420&quality=85`,
      {
        headers: jellyfinHeaders(req.user.token),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      },
    );
    if (
      !response.ok ||
      !/^image\/(jpeg|png|webp)/.test(
        response.headers.get("content-type") || "",
      )
    )
      return res.sendStatus(502);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) return res.sendStatus(502);
    res.type(response.headers.get("content-type")).send(bytes);
  } catch {
    res.sendStatus(502);
  }
});
app.get("/api/calendar", requireUser, async (req, res) => {
  const { start, end } = req.query;
  if (!validateRange(start, end))
    return res.status(400).json({ error: "Invalid calendar range." });
  const data = demo
    ? { events: demoEvents(start, end), warnings: [] }
    : await calendar(start, end);
  req.user.calendarImages = new Map();
  for (const event of data.events) {
    if (event.backdrop) {
      try {
        const url = new URL(event.backdrop);
        if (
          url.protocol === "https:" &&
          ["artworks.thetvdb.com", "image.tmdb.org"].includes(url.hostname) &&
          !url.username &&
          !url.password &&
          !url.port
        )
          req.user.calendarImages.set(event.id, url.href);
      } catch {
        /* Ignore invalid artwork URLs from upstream metadata. */
      }
    }
    event.backdrop = req.user.calendarImages.has(event.id)
      ? `/api/calendar-image/${encodeURIComponent(event.id)}`
      : demo && event.type === "tv"
        ? "/art/north.svg"
        : null;
  }
  res.json(data);
});
app.get("/api/calendar-image/:id", requireUser, async (req, res) => {
  const url = req.user.calendarImages?.get(req.params.id);
  if (!url) return res.sendStatus(404);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (
      !response.ok ||
      !/^image\/(jpeg|png|webp)/.test(
        response.headers.get("content-type") || "",
      )
    )
      return res.sendStatus(502);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 5 * 1024 * 1024) return res.sendStatus(502);
    res
      .type(response.headers.get("content-type"))
      .set("Cache-Control", "private, max-age=3600")
      .send(bytes);
  } catch {
    res.sendStatus(502);
  }
});
const weatherCache = new Map();
const weatherAttempts = new Map();
function weatherLimit(req, res, next) {
  const old = weatherAttempts.get(demo ? req.user.sid : req.user.id);
  const entry =
    old && old.until > Date.now()
      ? old
      : { count: 0, until: Date.now() + 60000 };
  entry.count++;
  weatherAttempts.set(demo ? req.user.sid : req.user.id, entry);
  if (entry.count > 30)
    return res
      .status(429)
      .json({ error: "Too many weather requests. Try again in a minute." });
  next();
}
app.get("/api/weather/cities", requireUser, weatherLimit, async (req, res) => {
  const query = req.query.query;
  if (
    typeof query !== "string" ||
    query.trim().length < 2 ||
    query.length > 100
  )
    return res
      .status(400)
      .json({ error: "Enter a city name of 2 to 100 characters." });
  if (demo)
    return res.json({
      cities: [
        {
          id: 1,
          label: "Sample City, Example Region",
          latitude: 40,
          longitude: -75,
        },
      ],
    });
  try {
    const params = new URLSearchParams({
      name: query.trim(),
      count: "8",
      language: "en",
      format: "json",
    });
    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?${params}`,
      { signal: AbortSignal.timeout(10000), redirect: "error" },
    );
    if (!response.ok) throw new Error();
    const data = await response.json();
    const cities = (data.results || [])
      .filter(
        (c) => Number.isFinite(c.latitude) && Number.isFinite(c.longitude),
      )
      .slice(0, 8)
      .map((c) => ({
        id: c.id,
        label: [c.name, c.admin1, c.country]
          .filter(Boolean)
          .join(", ")
          .slice(0, 240),
        latitude: c.latitude,
        longitude: c.longitude,
      }));
    res.json({ cities });
  } catch {
    res.status(502).json({ error: "City search is temporarily unavailable." });
  }
});
app.get("/api/weather", requireUser, weatherLimit, async (req, res) => {
  const { latitude: lat, longitude: lon, units } = req.query;
  const latitude = Number(lat),
    longitude = Number(lon);
  if (
    typeof lat !== "string" ||
    typeof lon !== "string" ||
    !lat.trim() ||
    !lon.trim() ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    !["celsius", "fahrenheit"].includes(units)
  )
    return res
      .status(400)
      .json({ error: "Choose a city and temperature units in Settings." });
  if (demo) {
    const celsius = units === "celsius";
    return res.json({
      current: { temperature_2m: celsius ? 20 : 68, weather_code: 2 },
      current_units: { temperature_2m: celsius ? "°C" : "°F" },
      daily: {
        time: ["2026-10-07", "2026-10-08", "2026-10-09"],
        temperature_2m_max: celsius ? [22, 23, 22] : [72, 74, 71],
        temperature_2m_min: celsius ? [12, 13, 11] : [54, 56, 52],
      },
    });
  }
  const key = `${latitude}:${longitude}:${units}`;
  const cached = weatherCache.get(key);
  if (cached && cached.expires > Date.now()) return res.json(cached.data);
  try {
    const params = new URLSearchParams({
      latitude,
      longitude,
      current: "temperature_2m,weather_code",
      daily: "temperature_2m_max,temperature_2m_min",
      forecast_days: "3",
      timezone: "auto",
      temperature_unit: units,
    });
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      { signal: AbortSignal.timeout(10000), redirect: "error" },
    );
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (weatherCache.size >= 200)
      weatherCache.delete(weatherCache.keys().next().value);
    weatherCache.set(key, { data, expires: Date.now() + 15 * 60 * 1000 });
    res.json(data);
  } catch {
    res.status(502).json({ error: "Weather is temporarily unavailable." });
  }
});
app.use(
  express.static(path.join(root, "..", "public"), { etag: true, maxAge: 0 }),
);
app.use((err, req, res, next) =>
  res.status(400).json({ error: "Invalid request." }),
);
setInterval(() => {
  for (const [id, data] of sessions)
    if (data.expires < Date.now()) sessions.delete(id);
  for (const [id, data] of weatherAttempts)
    if (data.until < Date.now()) weatherAttempts.delete(id);
  for (const [ip, data] of attempts)
    if (data.until < Date.now()) attempts.delete(ip);
}, 60000).unref();
app.listen(port, "0.0.0.0", () => {
  console.log(
    `Media dashboard listening on port ${port}; ${demo ? "demo" : "live"} mode`,
  );
  if (demo)
    console.warn(
      "WARNING: demo mode grants dashboard access without Jellyfin credentials. Never use it for a live deployment.",
    );
});
