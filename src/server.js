import {watchLaterSnapshot, updateWatchLater} from "./watch-later.js";
import { networkMatches, networkShows } from "./networks.js";
import { inTheaters } from "./in-theaters.js";
import { leavingSoon } from "./maintainerr.js";
import express from "express";
import { cleanDisplayPreferences, cleanSectionOrder, sectionOrderDefaults } from "./personal.js";
import { proxyTrust, allowedOrigin } from "./security.js";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  authenticate,
  jellyfinLink, recommendations, withWatched, favoriteItems, favoriteState, setFavorite,
  recentItems,
  personalItems, jellyfinLibraryStats,
  watchHistory, jellyfinLibraries, libraryItems,
  calendar,
  jellyfinHeaders,
  seerrSearch,
  seerrPopular,
  seerrDetails,
  seerrDetailsInvalidate,
  jellyfinTmdb,
  seerrIdentity,
  seerrContentRatings,
  seerrFranchise,
  seerrPersonCredits,
  seerrRequest,
  seerrRequestOptions,
  seerrRequests,
  testService,
  serviceUrl,
} from "./adapters.js";
import { demoEvents, demoRequests, demoSearch, titles, demoFacts } from "./demo.js";
import { validateRange } from "./model.js";
import { compress } from "./compress.js";
import { createSessions } from "./sessions.js";
import { createApiTokens, tokenAllowed, tokenLimit, scopes } from "./api-tokens.js";
import { createNotifications, cleanNotifications } from "./notifications.js";
import { notificationSnapshot, reminderShows, matchReminderShows } from "./notification-sources.js";
import { upstream } from "./adapters.js";

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
const attempts = new Map();
const apiAttempts = new Map();
// Personal dashboards stay signed in for 90 days. Sign-out still revokes the session.
const ttl = 90 * 24 * 60 * 60 * 1000;
const port = Number(process.env.PORT || 8739);
const sessions = createSessions({
  dataDir: path.dirname(settingsPath),
  ttl,
});

const apiTokens = createApiTokens({ dataDir: path.dirname(settingsPath) });
const tokenState = new Map();
const tokenWrites = new Map();
const badBearers = new Map();
const isTokenRequest = req => /^Bearer mq_/i.test(req.headers.authorization || "");

const notifications = await createNotifications({
  dataDir: path.dirname(settingsPath), sessions,
  snapshot: demo ? async () => ({ episodes: [], requests: [], airings: [] }) : notificationSnapshot,
});

app.set("trust proxy", proxyTrust(process.env.TRUSTED_PROXIES, process.env.TRUST_PROXY));
app.disable("x-powered-by");
app.use(compress());
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  });
  if (secure) res.set("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD" && !(isTokenRequest(req) && req.path !== "/api/login")) {
    // Browser writes must be same-origin. Non-browser clients can use a same-origin header.
    const origin = req.headers.origin;
    if (!allowedOrigin(origin, req.headers.host, secure)) {
      return res.status(403).json({ error: "Request origin not allowed." });
    }
  }
  next();
});
app.use("/api/notifications", express.json({ limit: "16kb" }));
app.use(express.json({ limit: "4kb" }));

function session(req) {
  return sessions.fromRequest(req);
}
const accountChecks = new Map();
async function verifiedAccount(user, fresh) {
  const key = user.sid;
  const hit = accountChecks.get(key);
  if (!fresh && hit && hit.expires > Date.now()) return hit.value;
  for (const [old, entry] of accountChecks) if (entry.expires <= Date.now()) accountChecks.delete(old);
  if (accountChecks.size >= 1000) accountChecks.delete(accountChecks.keys().next().value);
  const entry = { expires: Date.now() + 30000, value: upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(user.id)}`, { headers: jellyfinHeaders(user.token, user.deviceId) }).then(account => {
    if (account.Id !== user.id || account.Policy?.IsDisabled === true) throw new Error("Service answered HTTP 401.");
    return account;
  }) };
  accountChecks.set(key, entry);
  try {
    return await entry.value;
  } catch (error) {
    accountChecks.delete(key);
    throw error;
  }
}
async function requireUser(req, res, next) {
  let tokenRow = null;
  if (req.headers.authorization) {
    const bad = badBearers.get(req.ip);
    if (bad && bad.until > Date.now() && bad.count >= 30) return res.status(429).json({ error: "Too many invalid tokens. Try again in a minute." });
    // A bearer header is the only credential considered; cookies are ignored.
    const found = savedSettings.apiTokens === true && isTokenRequest(req) ? apiTokens.find(req.headers.authorization.slice(7).trim()) : null;
    if (!found) {
      const old = badBearers.get(req.ip);
      const entry = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + 60000 };
      entry.count++; badBearers.set(req.ip, entry);
      if (badBearers.size > 5000) badBearers.delete(badBearers.keys().next().value);
      return res.status(401).json({ error: "Invalid or revoked API token." });
    }
    tokenRow = found.row;
    if (!tokenAllowed(found.user.scope, req.method, req.path))
      return res.status(403).json({ error: found.user.scope === "read" && req.method !== "GET" ? "This token is read-only." : "API tokens cannot use this route." });
    if (req.method !== "GET" && req.method !== "HEAD") {
      const w = tokenWrites.get(tokenRow.id);
      const entry = w && w.until > Date.now() ? w : { count: 0, until: Date.now() + 60000 };
      entry.count++; tokenWrites.set(tokenRow.id, entry);
      if (entry.count > 10) return res.status(429).json({ error: "Too many requests for this token. Try again in a minute." });
    }
    if (!tokenState.has(tokenRow.id)) tokenState.set(tokenRow.id, { allowedImages: new Set(), calendarImages: undefined, exp: Infinity });
    req.user = { ...found.user, state: tokenState.get(tokenRow.id) };
    req.tokenRow = tokenRow;
  } else {
    req.user = session(req);
  }
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  const key = tokenRow ? req.user.sid : demo ? req.user.sid : req.user.id;
  const old = apiAttempts.get(key);
  const entry =
    old && old.until > Date.now()
      ? old
      : { count: 0, until: Date.now() + 60000 };
  entry.count++;
  apiAttempts.set(key, entry);
  if (entry.count > (tokenRow ? 120 : 240))
    return res
      .status(429)
      .json({ error: "Too many requests. Try again in a minute." });
  if (!demo) {
    try {
      const account = await verifiedAccount(req.user, !["GET", "HEAD"].includes(req.method));
      req.user.isAdmin = account.Policy?.IsAdministrator === true;
    } catch (error) {
      if (/HTTP (401|403)\b/.test(error.message)) {
        if (tokenRow) { apiTokens.removeRow(tokenRow, demo); tokenState.delete(tokenRow.id); return res.status(401).json({ error: "Jellyfin ended this token's login. Create a new token." }); }
        try { sessions.revoke(req.user.sid, req.user.expires); } catch { /* Memory revocation remains effective; persistence failure is logged. */ }
        cookie(res, "", 0);
        return res.status(401).json({ error: "Jellyfin ended this sign-in. Please sign in again." });
      }
      return res.status(503).json({ error: "Could not verify your Jellyfin sign-in. Try again when Jellyfin is available." });
    }
  }
  if (tokenRow) apiTokens.touch(tokenRow, demo);
  const originalJson = res.json.bind(res);
  res.json = body => {
    req.user.state.watchCandidates ||= new Map();
    const tag = value => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(tag); return; }
      const snapshot = watchLaterSnapshot(value);
      if (snapshot) {
        value.watchKey = snapshot.key;
        const candidates = req.user.state.watchCandidates;
        candidates.delete(snapshot.key); candidates.set(snapshot.key,snapshot);
        while(candidates.size > 500) candidates.delete(candidates.keys().next().value);
      }
      for(const key of ["items","results","movies","tv","requests","events"]) if(value[key]) tag(value[key]);
    };
    tag(body); return originalJson(body);
  };
  next();
}
async function imageBytes(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Image too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("Image too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

const apiDocs = `Marquee API
Authorization: Bearer <token>. A token acts as the Jellyfin user who made it and can read what that user sees.
Read-only tokens: GET only. Request tokens may also POST /api/seerr/request.
Limits: 120 requests per minute per token, 10 writes per minute.
GET  /api/me                      account, request access
GET  /api/recent                  recently added
GET  /api/calendar?start=&end=    Sonarr/Radarr calendar
GET  /api/personal/:kind          continueWatching, nextUp, watchNext, topUnwatched shelves
GET  /api/history?limit=          watch history, newest first (limit 1-100, default 50)
GET  /api/libraries               Jellyfin movie/TV libraries you can see
GET  /api/libraries/:id/items     browse a library: ?start=&limit=&played=&favorites=true&query=&genres=&years=&sort=name|added|year|rating&order=asc|desc
GET  /api/watchlist               Jellyfin favorites; /api/favorite/:id checks one title
GET  /api/watch-later             Marquee watchlist
GET  /api/recommendations, /api/leaving-soon, /api/in-theaters, /api/library-stats, /api/networks
GET  /api/library/:id/facts
GET  /api/weather?latitude=&longitude=&units=celsius|fahrenheit, /api/weather/cities?query=
GET  /api/image/:id, /api/calendar-image/:id, /api/jellyfin-version
GET  /api/seerr/search?q=, /api/seerr/popular, /api/seerr/requests, /api/seerr/details/:type/:id
GET  /api/seerr/request-options, /api/seerr/content-ratings
POST /api/seerr/request           {"mediaType":"movie|tv","mediaId":123,"seasons":[1]} (request tokens)
Settings, notifications, sign-in and token routes are not available to tokens.
`;
const notificationUser = user => demo ? { ...user, id: user.sid } : user;
app.get("/api/notifications", requireUser, (req, res) => res.json(notifications.status(notificationUser(req.user))));
app.post("/api/notifications", requireUser, async (req, res) => {
  const preferences = cleanNotifications(req.body);
  if (!preferences) return res.status(400).json({ error: "Invalid notification settings." });
  try {
    // Each selected ID must resolve to a series this viewer may access.
    if (!demo) for (const show of preferences.shows) {
      const item = await upstream(process.env.JELLYFIN_URL, `/Users/${encodeURIComponent(req.user.id)}/Items/${encodeURIComponent(show.id)}`, { headers: jellyfinHeaders(req.user.token, req.user.deviceId) });
      if (item.Type !== "Series") return res.status(400).json({ error: "Choose a show in your Jellyfin library." });
    }
    await notifications.configure(notificationUser(req.user), preferences);
    res.json({ ok: true });
  } catch { res.status(502).json({ error: "Could not save reminders. Check Jellyfin and the settings folder." }); }
});
app.get("/api/notification-shows", requireUser, async (req, res) => {
  const query = String(req.query.query || "").trim();
  if (query.length > 100) return res.status(400).json({ error: "Show search is too long." });
  try {
    const shows = demo ? matchReminderShows([{ Id: "north", Name: "North of Nowhere" }, { Id: "signal", Name: "The Last Signal" }, { Id: "decker", Name: "R.J. Decker" }], query) : await reminderShows(req.user, query);
    res.json({ shows });
  } catch { res.status(502).json({ error: "Could not load your Jellyfin shows." }); }
});
app.post("/api/notifications/subscribe", requireUser, async (req, res) => {
  if (demo) return res.status(400).json({ error: "Push is disabled in demo mode." });
  try { await notifications.subscribe(notificationUser(req.user), req.body); res.json({ ok: true }); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
app.post("/api/notifications/unsubscribe", requireUser, async (req, res) => {
  await notifications.remove(notificationUser(req.user)); res.json({ ok: true });
});
const pushTests = new Map();
app.post("/api/notifications/test", requireUser, async (req, res) => {
  if (demo) return res.status(400).json({ error: "Push is disabled in demo mode." });
  if (Date.now() - (pushTests.get(req.user.id) || 0) < 60000) return res.status(429).json({ error: "Wait a minute before another test." });
  pushTests.set(req.user.id, Date.now());
  try { await notifications.test(notificationUser(req.user)); res.json({ ok: true }); }
  catch { res.status(502).json({ error: "Test could not be delivered. Check this device's notification permission." }); }
});
setInterval(() => notifications.tick().catch(() => {}), 5 * 60000).unref();
// Baselines resume after restarts without sending old arrivals again.
notifications.tick().catch(() => {});


// API tokens. Managed only from a signed-in browser session, never with a token.
async function endJellyfinLogin(login) {
  if (demo || !login?.token) return;
  try { await upstream(process.env.JELLYFIN_URL, "/Sessions/Logout", { method: "POST", headers: jellyfinHeaders(login.token, login.deviceId) }); } catch {}
}
const sessionOnly = (req, res, next) =>
  req.headers.authorization ? res.status(403).json({ error: "API tokens cannot manage tokens." }) : requireUser(req, res, next);
app.get("/api/tokens", sessionOnly, (req, res) => {
  res.json({ enabled: savedSettings.apiTokens === true, isAdmin: req.user.isAdmin === true, tokens: apiTokens.list(demo ? req.user.id : req.user.id) });
});
app.post("/api/tokens/enabled", sessionOnly, async (req, res) => {
  if (req.user.isAdmin !== true) return res.status(403).json({ error: "Only a Jellyfin admin can change this." });
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "Invalid request." });
  try { await saveSettings(current => ({ ...current, apiTokens: req.body.enabled })); }
  catch { return res.status(503).json({ error: "Could not save this setting. Check the settings volume is writable." }); }
  if (!req.body.enabled) {
    // Turning the feature off ends every token and its Jellyfin login, so turning it back on does not revive any.
    try {
      for (const login of apiTokens.removeAll(demo)) await endJellyfinLogin(login);
      tokenState.clear();
    } catch (error) { return res.status(503).json({ error: "Tokens are off, but some could not be removed. Check the settings storage and turn this off again." }); }
  }
  res.json({ enabled: req.body.enabled });
});
app.post("/api/tokens", sessionOnly, async (req, res) => {
  if (savedSettings.apiTokens !== true) return res.status(403).json({ error: "API tokens are turned off." });
  const { name, scope, password } = req.body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 40 || /[<>\x00-\x1f]/.test(name) || !scopes.includes(scope) || typeof password !== "string" || (!demo && (!password || password.length > 1000)))
    return res.status(400).json({ error: "Enter a name (up to 40 characters), a type and your Jellyfin password." });
  const bucket = "tok:" + req.ip;
  const current = attempts.get(bucket) || { count: 0, until: Date.now() + 15 * 60 * 1000 };
  if (current.until < Date.now()) { current.count = 0; current.until = Date.now() + 15 * 60 * 1000; }
  if (current.count >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  current.count++; attempts.set(bucket, current);
  try {
    // A fresh Jellyfin login for this token, so signing out of the browser does not end it.
    if (apiTokens.list(req.user.id).length >= tokenLimit) throw new Error(`You can have up to ${tokenLimit} tokens. Revoke one first.`);
    let login = req.user;
    if (!demo) {
      login = await authenticate(req.user.name, password);
      if (login.id !== req.user.id) { await endJellyfinLogin(login); throw new Error("That password belongs to a different account."); }
    }
    let made;
    try { made = apiTokens.create({ user: login, name: name.trim(), scope, demo }); }
    catch (error) { await endJellyfinLogin(login); throw error; }
    attempts.delete(bucket);
    res.json(made);
  } catch (error) {
    res.status(/different account|up to \d+ tokens|Could not save/.test(error.message) ? 400 : 401).json({ error: `Could not create the token. ${error.message}` });
  }
});
app.delete("/api/tokens/:id", sessionOnly, async (req, res) => {
  try {
    const login = apiTokens.remove(req.params.id, req.user.id, demo);
    if (!login) return res.status(404).json({ error: "Token not found." });
    tokenState.delete(req.params.id);
    await endJellyfinLogin(login);
    res.json({ ok: true });
  } catch (error) { res.status(503).json({ error: error.message }); }
});
app.get("/api/docs", requireUser, (req, res) => {
  res.type("text/plain").send(apiDocs);
});
app.get("/api/config", (req, res) => res.json({ demo, name: displayName }));
app.post("/api/login", async (req, res) => {
  const ip = req.ip;
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
    // A new sign-in retires the one this browser already had.
    const old = session(req);
    if (old) sessions.revoke(old.sid, old.expires);
    cookie(res, sessions.seal(user), ttl);
    attempts.delete(ip);
    res.json({ name: user.name });
  } catch (error) {
    res.status(401).json({
      error: `Could not sign in. ${error.message}`,
    });
  }
});
app.post("/api/logout", requireUser, async (req, res) => {
  await notifications.remove(notificationUser(req.user));
  accountChecks.delete(req.user.sid);
  try { sessions.revoke(req.user.sid, req.user.expires); }
  catch { return res.status(503).json({ error: "Could not save sign-out. Check the server settings storage before restarting." }); }
  if (!demo && req.user.token) {
    // Also end the Jellyfin login this cookie carried, best effort.
    try {
      await upstream(process.env.JELLYFIN_URL, "/Sessions/Logout", {
        method: "POST",
        headers: jellyfinHeaders(req.user.token, req.user.deviceId),
      });
    } catch {}
  }
  cookie(res, "", 0);
  res.json({ ok: true });
});
// Seerr errors from the adapter are already safe to show (no URLs, keys or
// tokens), so say what actually failed instead of a generic message.
function seerrFailure(res, error) {
  console.warn(`Seerr call failed: ${error.message}`);
  const status = /Service answered HTTP (401|403)/.exec(error.message)?.[1];
  if (status)
    return res.status(403).json({
      error: `Seerr refused this account (HTTP ${status}). Check this user's permissions in Seerr.`,
    });
  res.status(502).json({ error: `Seerr could not be reached. ${error.message}` });
}
// Typing in the search box fires many searches. Permissions rarely change, so
// search reuses a user's lookup for 20 seconds; requesting always checks fresh.
const accessCache = new Map();
async function cachedAccess(user) {
  const hit = accessCache.get(user.id);
  if (hit && hit.expires > Date.now()) return hit.access;
  const access = await requestAccess(user);
  if (!access.error) {
    if (accessCache.size > 500) accessCache.clear();
    accessCache.set(user.id, { access, expires: Date.now() + 20000 });
  }
  return access;
}
async function requestAccess(user) {
  if (demo) return { id: 1, movie: true, tv: true, advanced: true };
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
    advanced: access.advanced === true,
    reason: access.error || "",
    movieReason: access.movieReason || "",
    tvReason: access.tvReason || "",
  };
}
function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
app.get("/api/accessibility-settings", requireUser, (req, res) => {
  res.json({
    colorblind:
      savedSettings.accessibilityByUser?.[demo ? req.user.sid : req.user.id]
        ?.colorblind === true,
  });
});
app.post("/api/accessibility-settings", requireUser, async (req, res) => {
  if (typeof req.body.colorblind !== "boolean")
    return res
      .status(400)
      .json({ error: "Choose a valid colorblind setting." });
  try {
    const value = { colorblind: req.body.colorblind };
    await saveSettings((current) => ({
      ...current,
      accessibilityByUser: {
        ...current.accessibilityByUser,
        [demo ? req.user.sid : req.user.id]: value,
      },
    }));
    res.json(value);
  } catch {
    res
      .status(500)
      .json({
        error:
          "Could not save accessibility settings. Check the settings volume is writable.",
      });
  }
});
app.get("/api/me", requireUser, async (req, res) => {
  const access = await requestAccess(req.user);
  res.json({
    name: req.user.name,
    isAdmin: req.user.isAdmin === true,
    canRequest: access.movie || access.tv,
    requestAccess: publicAccess(access),
    jellyfinWebUrl: demo
      ? null
      : safeWebUrl(process.env.JELLYFIN_WEB_URL || process.env.JELLYFIN_URL),
  });
});
// Account-scoped personal data uses verified Jellyfin IDs, never supplied user IDs.
const personalKey = user => demo ? user.sid : user.id;
app.get("/api/display-preferences", requireUser, (req, res) => {
  res.json({ preferences: savedSettings.displayByUser?.[personalKey(req.user)] || null });
});
app.post("/api/display-preferences", requireUser, async (req, res) => {
  const preferences = cleanDisplayPreferences(req.body);
  if (!preferences) return res.status(400).json({ error: "Choose valid display preferences." });
  try {
    await saveSettings(current => ({ ...current, displayByUser: { ...current.displayByUser, [personalKey(req.user)]: preferences } }));
    res.json({ preferences });
  } catch { res.status(500).json({ error: "Could not sync settings. Check the settings volume is writable." }); }
});
// Layout order is always account-saved, independently of optional display sync.
app.get("/api/section-order", requireUser, (req, res) => {
  res.json({ order: cleanSectionOrder(savedSettings.orderByUser?.[personalKey(req.user)]) || sectionOrderDefaults });
});
app.post("/api/section-order", requireUser, async (req, res) => {
  const order = cleanSectionOrder(req.body.order);
  if (!order) return res.status(400).json({ error: "Choose each dashboard section exactly once." });
  try {
    await saveSettings(current => ({ ...current, orderByUser: { ...current.orderByUser, [personalKey(req.user)]: order } }));
    res.json({ order });
  } catch { res.status(500).json({ error: "Could not save section order. Check the settings volume is writable." }); }
});
app.get("/api/watch-later", requireUser, async (req,res) => {
  const items = (savedSettings.watchLaterByUser?.[personalKey(req.user)] || []).filter(item=>item.libraryId).map(item=>({...item,key:`library:${item.type}:${item.libraryId}`}));
  const libraryIds=items.map(item=>item.libraryId).filter(Boolean);
  const accessible=new Map();
  if(libraryIds.length && !demo) {
    try {const params=new URLSearchParams({UserId:req.user.id,Ids:libraryIds.join(","),Recursive:"true",Fields:"ProviderIds",Limit:String(libraryIds.length)});const data=await upstream(process.env.JELLYFIN_URL,`/Items?${params}`,{headers:jellyfinHeaders(req.user.token,req.user.deviceId)});for(const item of data.Items || [])if(["Movie","Series"].includes(item.Type) && !item.IsMissing && !item.IsPlaceHolder && item.LocationType !== "Virtual")accessible.set(item.Id,Boolean(item.ImageTags?.Primary));}
    catch {return res.status(502).json({error:"Could not verify saved Jellyfin titles. Your Watchlist is unchanged."});}
  }
  // The saved snapshot's image flag froze when the title was starred; posters
  // arrive and change on Jellyfin afterwards, so take the flag fresh on every load.
  const visible=items.filter(item=>demo || accessible.has(item.libraryId)).map(item=>{if(demo)return item;req.user.state.allowedImages.add(item.libraryId);return {...item,image:accessible.get(item.libraryId) === true,link:jellyfinLink(item.libraryId)};});
  res.json({items:visible});
});
app.post("/api/watch-later", requireUser, async (req,res) => {
  const {key,saved} = req.body;
  if(typeof key !== "string" || key.length>150 || typeof saved !== "boolean") return res.status(400).json({error:"Choose a valid Watchlist title."});
  const existing = savedSettings.watchLaterByUser?.[personalKey(req.user)] || [];
  const snapshot = req.user.state.watchCandidates?.get(key) || (!saved ? existing.find(item=>item.key===key || (item.libraryId && `library:${item.type}:${item.libraryId}`===key)) : null);
  if(!snapshot) return res.status(404).json({error:"Open this title in Marquee before adding it."});
  try {
    if(saved && !demo) {let item;try {item=await upstream(process.env.JELLYFIN_URL,`/Users/${encodeURIComponent(req.user.id)}/Items/${encodeURIComponent(snapshot.libraryId)}`,{headers:jellyfinHeaders(req.user.token,req.user.deviceId)});}catch{return res.status(502).json({error:"Could not verify this Jellyfin title. Watchlist is unchanged."});}if(item.Id !== snapshot.libraryId || !["Movie","Series"].includes(item.Type) || item.IsMissing || item.IsPlaceHolder || item.LocationType === "Virtual")return res.status(404).json({error:"Watchlist requires a movie or series on your Jellyfin server."});}
    await saveSettings(current=>({...current,watchLaterByUser:{...current.watchLaterByUser,[personalKey(req.user)]:updateWatchLater(current.watchLaterByUser?.[personalKey(req.user)] || [],snapshot,saved)}}));
    res.json({key,saved});
  } catch(error) {res.status(500).json({error:error.message.includes("500 titles") ? error.message : "Could not save Watchlist. Check the settings folder is writable."});}
});
app.get("/api/watchlist", requireUser, async (req, res) => {
  try {
    const items = demo ? savedSettings.demoFavorites?.[personalKey(req.user)] || [] : await favoriteItems(req.user);
    for (const item of items) { req.user.state.allowedImages.add(item.id); if (item.backdropId) req.user.state.allowedImages.add(item.backdropId); }
    res.json({ items });
  } catch { res.status(502).json({ error: "Could not load your Jellyfin favorites." }); }
});
app.get("/api/favorite/:id", requireUser, async (req, res) => {
  if (!/^[a-zA-Z0-9-]+$/.test(req.params.id)) return res.status(400).json({ error: "Invalid library item." });
  try { res.json(demo ? { favoriteId: req.params.id, favorite: (savedSettings.demoFavorites?.[personalKey(req.user)] || []).some(item => item.id === req.params.id) } : await favoriteState(req.user, req.params.id)); }
  catch { res.status(404).json({ error: "This movie or series is not available in your Jellyfin library." }); }
});
app.post("/api/watchlist", requireUser, async (req, res) => {
  const { itemId, saved } = req.body;
  if (typeof itemId !== "string" || !/^[a-zA-Z0-9-]+$/.test(itemId) || itemId.length > 100 || typeof saved !== "boolean") return res.status(400).json({ error: "Choose a valid Jellyfin movie or series." });
  try {
    if (demo) await saveSettings(current => {
      const items = (current.demoFavorites?.[personalKey(req.user)] || []).filter(item => item.id !== itemId);
      if (saved) items.push({ id: itemId, favoriteId: itemId, favorite: true, title: "Demo favorite", subtitle: "TV series", art: "north", detail: { title: "Demo favorite", subtitle: "TV series" } });
      return { ...current, demoFavorites: { ...current.demoFavorites, [personalKey(req.user)]: items } };
    });
    else await setFavorite(req.user, itemId, saved);
    res.json({ favoriteId: itemId, favorite: saved });
  } catch { res.status(502).json({ error: "Could not update your Jellyfin favorite. Try again." }); }
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
app.get("/api/seerr/details/:type/:id", requireUser, async (req, res) => {
  const { type, id } = req.params;
  if (
    !["movie", "tv"].includes(type) ||
    !/^\d+$/.test(id) ||
    !Number.isSafeInteger(Number(id)) ||
    Number(id) < 1 ||
    Number(id) > 1e9
  )
    return res.status(400).json({ error: "Invalid media item." });
  if (demo)
    return res.json({
      title: type === "tv" ? "North of Nowhere" : "The Last Signal",
      year: "2026",
      subtitle: type === "tv" ? "TV series" : "Movie",
      genres: ["Adventure", "Drama"],
      network: "Sample Network",
      runtime: 48,
      overview:
        "A discovery draws old friends into a story that changes their lives.",
      poster: "/art/north.svg",
      backdrop: "/art/north.svg",
      facts: demoFacts,
      updatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    });
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    const detail = await seerrDetails(type, Number(id), access.id);
    res.json((await withWatched(req.user, [detail]))[0]);
  } catch {
    res
      .status(502)
      .json({ error: "Details are temporarily unavailable from Seerr." });
  }
});
app.get("/api/library/:id/facts", requireUser, async (req, res) => {
  if (demo) return res.json({ facts: demoFacts, updatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString() });
  // Only items already shown on the user's shelf can be looked up.
  if (
    !req.user.state.allowedImages.has(req.params.id) ||
    !/^[a-zA-Z0-9-]+$/.test(req.params.id)
  )
    return res.sendStatus(404);
  try {
    const tmdb = await jellyfinTmdb(req.user, req.params.id);
    if (!tmdb) return res.json({ facts: null });
    const access = await requestAccess(req.user);
    if (access.error) return res.json({ facts: null });
    const detail = await seerrDetails(tmdb.type, tmdb.id, access.id);
    const [marked] = await withWatched(req.user, [detail]);
    res.json({ facts: detail.facts, updatedAt: detail.updatedAt, contentRating: detail.contentRating, network: tmdb.type === "tv" ? detail.network : null, mediaType: tmdb.type, mediaId: tmdb.id, watched: marked.watched, favoriteId: marked.favoriteId, favorite: marked.favorite });
  } catch {
    res.json({ facts: null });
  }
});
app.get("/api/in-theaters", requireUser, async (req, res) => {
  if (demo) return res.json({ region: "US", items: demoSearch("").filter(item => item.mediaType === "movie").map((item, i) => ({ ...item, id: 9000 + i, availability: i === 0 ? 5 : i === 1 ? 2 : null, requested: i === 1 })) });
  if (!process.env.TMDB_API_KEY?.trim()) return res.status(503).json({ error: "In theaters needs a TMDB API key in the server settings." });
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    const data = await inTheaters(access.id, { dataDir: path.dirname(settingsPath) });
    res.json({ ...data, items: await withWatched(req.user, data.items), requestAccess: publicAccess(access) });
  } catch { res.status(502).json({ error: "In theaters is temporarily unavailable. Check TMDB and Seerr connections." }); }
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
        poster:
          i === 0
            ? type === "tv"
              ? "north"
              : "signal"
            : i === 1
              ? type === "tv"
                ? "hours"
                : "orbit"
              : "placeholder",
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
    const popular = await seerrPopular(access.id);
    const marked = await withWatched(req.user, [...popular.movies, ...popular.tv]);
    res.json({
      movies: marked.slice(0, popular.movies.length), tv: marked.slice(popular.movies.length),
      requestAccess: publicAccess(access),
    });
  } catch {
    res.status(502).json({
      error: "Popular titles are temporarily unavailable from Seerr.",
    });
  }
});
app.get("/api/networks", requireUser, async (req,res)=>{
  const query=req.query.query;
  if(typeof query!=="string"||query.length>120||query.trim().length<3)return res.status(400).json({error:"Enter at least three characters."});
  if(demo)return res.json({networks:[],warning:"Network directory uses live TMDB data outside demo mode."});
  try {const access=await cachedAccess(req.user);if(access.error)return res.status(403).json({error:access.error});res.json({networks:await networkMatches(query,path.dirname(settingsPath))});}
  catch {res.json({networks:[],warning:"Network matching unavailable. Title search still works."});}
});
app.get("/api/seerr/search", requireUser, async (req, res) => {
  const query = req.query.query;
  const page = Number(req.query.page || 1);
  if (
    typeof query !== "string" ||
    !query.trim() ||
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
    const access = await cachedAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    if(req.query.network !== undefined) {
      const id=Number(req.query.network);
      if(!Number.isSafeInteger(id)||id<1)return res.status(400).json({error:"Invalid network."});
      const data=await networkShows(id,page,access.id,path.dirname(settingsPath));
      return res.json({...data,results:await withWatched(req.user,data.results),requestAccess:publicAccess(access)});
    }
    const results = await seerrSearch(query, page, access.id);
    if (page === 1 && query.trim().length >= 3 && query.trim().length <= 40) {
      // Franchise searches ("Marvel", "DC") also list that studio's movies.
      // A failure here never breaks the normal search.
      const seen = new Set(results.map((r) => `${r.mediaType}:${r.id}`));
      const extra = await seerrFranchise(query, access.id).catch((e) => { console.warn(`Franchise search skipped: ${e.message}`); return []; });
      for (const item of extra)
        if (!seen.has(`${item.mediaType}:${item.id}`)) {
          seen.add(`${item.mediaType}:${item.id}`);
          results.push(item);
        }
    }
    if (page === 1 && query.trim().length >= 3 && query.trim().length <= 40) {
      const seen = new Set(results.map((r) => `${r.mediaType}:${r.id}`));
      const people = await seerrPersonCredits(query, access.id).catch((e) => {
        console.warn(`Person search skipped: ${e.message}`);
        return [];
      });
      for (const item of people)
        if (!seen.has(`${item.mediaType}:${item.id}`)) {
          seen.add(`${item.mediaType}:${item.id}`);
          results.push(item);
        }
    }
    // Newest first; titles without a date go last.
    // An exact title match goes first; the rest newest to oldest.
    const exact = (r) => r.title.trim().toLowerCase() === query.replace(/\s+/g, " ").trim().toLowerCase();
    results.sort(
      (a, b) =>
        Number(exact(b)) - Number(exact(a)) ||
        (b.date || "").localeCompare(a.date || ""),
    );
    res.json({
      results: await withWatched(req.user, results.slice(0, 60)),
      requestAccess: publicAccess(access),
    });
  } catch (error) {
    seerrFailure(res, error);
  }
});
app.get("/api/jellyfin-version", requireUser, async (req, res) => {
  if (demo) return res.json({ version: null, demo: true, online: null });
  const result = await testService("jellyfin", { includeVersion: true });
  res.json({ version: result.ok ? result.version : null, online: result.ok });
});
app.post("/api/test-connection", requireUser, async (req, res) => {
  const { service } = req.body || {};
  if (!["jellyfin", "sonarr", "radarr", "seerr", "maintainerr"].includes(service))
    return res.status(400).json({ error: "Unknown service." });
  if (demo) return res.json({ ok: true });
  res.json(await testService(service));
});
app.get("/api/leaving-soon", requireUser, async (req, res) => {
  if (!demo && !process.env.MAINTAINERR_URL) return res.status(503).json({ error: "Set MAINTAINERR_URL on the server to see scheduled departures." });
  try {
    const items = demo ? titles.slice(0, 3).map((item, index) => ({ ...item, favoriteId: item.id, favorite: false, leavingAt: new Date(Date.now() + (index + 2) * 86400000).toISOString() })) : await leavingSoon(req.user);
    for (const item of items) req.user.state.allowedImages.add(item.id);
    res.json({ items });
  } catch { res.status(502).json({ error: "Could not verify Maintainerr departures. Check its URL, version, collections and exclusions." }); }
});
app.get("/api/recommendations", requireUser, async (req, res) => {
  if (demo) return res.json({ seed: "North of Nowhere", seeds: ["North of Nowhere", "The Last Signal", "After Hours", "Orbit Nine", "Wild Coast"], items: demoSearch("").filter(item => ![4,5].includes(item.availability)) });
  try {
    const access = await requestAccess(req.user);
    if (access.error) return res.status(403).json({ error: access.error });
    res.json(await recommendations(req.user, access.id));
  } catch { res.status(502).json({ error: "Recommendations are temporarily unavailable." }); }
});
app.get("/api/seerr/requests", requireUser, async (req, res) => {
  if (demo) return res.json({ requests: req.query.mine === "true" ? demoRequests.filter((_, index) => index === 0) : demoRequests });
  if (!process.env.SEERR_URL || !process.env.SEERR_API_KEY)
    return res
      .status(503)
      .json({ error: "Connect Seerr in the server settings to see requests." });
  try {
    const mine = req.query.mine === "true";
    // Everyone's requests need no Seerr link; "mine" needs the viewer's linked account.
    const access = mine ? await requestAccess(req.user) : { id: null };
    if (access.error) return res.status(403).json({ error: access.error });
    res.json({ requests: await seerrRequests(access.id, mine), viewAllRequests: true });
  } catch (error) {
    seerrFailure(res, error);
  }
});
app.get("/api/seerr/content-ratings", requireUser, async (req, res) => {
  const items = String(req.query.items || "")
    .split(",")
    .slice(0, 30)
    .map((x) => x.split(":"))
    .filter(([t, i]) => ["movie", "tv"].includes(t) && /^\d{1,9}$/.test(i))
    .map(([type, id]) => ({ type, id: Number(id) }));
  if (!items.length) return res.json({ ratings: {} });
  if (demo) {
    const demoCerts = ["PG-13", "R", "TV-MA", "PG", "TV-14"];
    return res.json({
      ratings: Object.fromEntries(items.map((x, n) => [`${x.type}:${x.id}`, demoCerts[n % demoCerts.length]])),
    });
  }
  try {
    const access = await cachedAccess(req.user);
    if (access.error) return res.json({ ratings: {} });
    res.json({ ratings: await seerrContentRatings(items, access.id) });
  } catch {
    res.json({ ratings: {} });
  }
});
app.get("/api/seerr/request-options", requireUser, async (req, res) => {
  const mediaType = req.query.mediaType;
  const mediaId = Number(req.query.mediaId);
  if (
    !["movie", "tv"].includes(mediaType) ||
    !Number.isInteger(mediaId) ||
    mediaId < 1 ||
    mediaId > 1e9
  )
    return res.status(400).json({ error: "Invalid request." });
  if (demo)
    return res.json({
      seasons:
        mediaType === "tv"
          ? [
              { number: 1, episodes: 10, status: 5 },
              { number: 2, episodes: 8, status: 0 },
              { number: 3, episodes: 12, status: 0 },
            ]
          : [],
      advanced: {
        serverId: 1,
        serverName: "Demo",
        profiles: [
          { id: 1, name: "Any" },
          { id: 2, name: "HD - 720p/1080p" },
          { id: 3, name: "Ultra-HD" },
        ],
        rootFolders: [
          { path: mediaType === "tv" ? "/tv" : "/movies", freeSpace: 2e12 },
          { path: "/media/archive", freeSpace: 5e11 },
        ],
        defaultProfileId: 2,
        defaultRootFolder: mediaType === "tv" ? "/tv" : "/movies",
      },
    });
  try {
    const access = await requestAccess(req.user);
    if (!access[mediaType])
      return res
        .status(403)
        .json({ error: access.error || access[`${mediaType}Reason`] });
    res.json(
      await seerrRequestOptions(mediaType, mediaId, access.id, access.advanced),
    );
  } catch (error) {
    seerrFailure(res, error);
  }
});
app.post("/api/seerr/request", requireUser, async (req, res) => {
  const { mediaType, mediaId, seasons, serverId, profileId, rootFolder } =
    req.body || {};
  if (
    !["movie", "tv"].includes(mediaType) ||
    !Number.isInteger(mediaId) ||
    mediaId < 1 ||
    mediaId > 1e9
  )
    return res.status(400).json({ error: "Invalid request." });
  const wantsSeasons = seasons !== undefined;
  const wantsAdvanced =
    serverId !== undefined || profileId !== undefined || rootFolder !== undefined;
  if (
    (wantsSeasons &&
      (mediaType !== "tv" ||
        !Array.isArray(seasons) ||
        seasons.length < 1 ||
        seasons.length > 200 ||
        !seasons.every((n) => Number.isInteger(n) && n >= 1 && n <= 1000))) ||
    (wantsAdvanced &&
      ((serverId !== undefined && !Number.isSafeInteger(serverId)) ||
        (profileId !== undefined && !Number.isSafeInteger(profileId)) ||
        (rootFolder !== undefined &&
          (typeof rootFolder !== "string" || !rootFolder || rootFolder.length > 300))))
  )
    return res.status(400).json({ error: "Invalid request." });
  if (demo) return res.json({ ok: true });
  try {
    const access = await requestAccess(req.user);
    if (!access[mediaType])
      return res
        .status(403)
        .json({ error: access.error || access[`${mediaType}Reason`] });
    const options = {};
    if (wantsSeasons) options.seasons = [...new Set(seasons)].sort((a, b) => a - b);
    if (wantsAdvanced) {
      if (!access.advanced)
        return res.status(403).json({
          error: "Seerr does not let your account change the quality profile or folder.",
        });
      // Only values Seerr itself offers for its default server are accepted.
      const offered = (await seerrRequestOptions(mediaType, mediaId, access.id, true)).advanced;
      if (
        !offered ||
        (serverId !== undefined && serverId !== offered.serverId) ||
        (profileId !== undefined && !offered.profiles.some((p) => p.id === profileId)) ||
        (rootFolder !== undefined && !offered.rootFolders.some((f) => f.path === rootFolder))
      )
        return res.status(400).json({ error: "That quality profile or folder is not available." });
      Object.assign(options, { serverId: offered.serverId, profileId, rootFolder });
    }
    const result = await seerrRequest(mediaType, mediaId, access.id, options);
    seerrDetailsInvalidate(mediaType, mediaId);
    res.json({ ok: true, status: result.status ?? null });
  } catch (error) {
    const denied = /Service answered HTTP (403|409)/.test(error.message);
    console.warn(`Seerr request failed: ${error.message}`);
    res.status(denied ? 403 : 502).json({
      error: denied
        ? "Seerr declined this request. Check your permissions, remaining quota, or whether it was already requested."
        : `Seerr could not complete the request. ${error.message}`,
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
    const bytes = await imageBytes(response, 2 * 1024 * 1024);
    res
      .type(response.headers.get("content-type"))
      .set("Cache-Control", "private, max-age=86400")
      .send(bytes);
  } catch {
    res.sendStatus(502);
  }
});
app.get("/api/library-stats", requireUser, async (req,res)=>{
  const kidsLibrary = req.query.kidsLibrary || "", kidsShowsLibrary = req.query.kidsShowsLibrary || "";
  if([kidsLibrary,kidsShowsLibrary].some(value=>typeof value !== "string" || value.length > 100))return res.status(400).json({error:"Invalid library selection."});
  try {
    if(demo)return res.json({libraries:[],kidsLibrary:"",kidsShowsLibrary:"",selectionUnavailable:Boolean(kidsLibrary || kidsShowsLibrary),counts:{movies:null,kidsMovies:null,tvShows:null,kidsShows:null,episodes:null,kidsEpisodes:null}});
    res.json(await jellyfinLibraryStats(req.user,kidsLibrary,kidsShowsLibrary));
  } catch {res.status(502).json({error:"Library counts could not be loaded from Jellyfin."});}
});
app.get("/api/history", requireUser, async (req, res) => {
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return res.status(400).json({ error: "Limit must be 1 to 100." });
  try {
    const items = demo ? titles.slice(0, limit).map((item, index) => ({ ...item, itemId: item.id, watched: true, watchedScope: item.type === "tv" ? "episode" : "movie", lastPlayed: `2026-10-${String(19 - index).padStart(2, "0")}T21:14:00Z` })) : await watchHistory(req.user, limit);
    for (const item of items) {
      req.user.state.allowedImages.add(item.id);
      if (item.itemId) req.user.state.allowedImages.add(item.itemId);
      if (item.backdropId) req.user.state.allowedImages.add(item.backdropId);
    }
    res.json({ items });
  } catch { res.status(502).json({ error: "Your watch history could not be loaded from Jellyfin." }); }
});
const demoLibraries = [{ id: "demo-movies", name: "Movies", type: "movies" }, { id: "demo-tv", name: "TV Shows", type: "tvshows" }];
app.get("/api/libraries", requireUser, async (req, res) => {
  try {
    res.json({ libraries: demo ? demoLibraries : await jellyfinLibraries(req.user) });
  } catch { res.status(502).json({ error: "Your libraries could not be loaded from Jellyfin." }); }
});
app.get("/api/libraries/:id/items", requireUser, async (req, res) => {
  const start = req.query.start === undefined ? 0 : Number(req.query.start);
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
  const played = req.query.played === undefined ? null : { "true": true, "false": false }[req.query.played];
  const genres = typeof req.query.genres === "string" ? req.query.genres.split(",").map(genre => genre.trim()).filter(genre => genre && genre.length <= 60 && !/[<>\x00-\x1f|]/.test(genre)) : [];
  const years = typeof req.query.years === "string" && /^\d{4}(,\d{4}){0,9}$/.test(req.query.years) ? req.query.years.split(",") : [];
  if (!/^[a-zA-Z0-9-]+$/.test(req.params.id) || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || played === undefined || (req.query.query !== undefined && (typeof req.query.query !== "string" || req.query.query.length > 100)) || (req.query.genres !== undefined && (!genres.length || genres.length > 10 || req.query.genres.length > 300)) || (req.query.years !== undefined && !years.length) || (req.query.sort !== undefined && !["name", "added", "year", "rating"].includes(req.query.sort)) || (req.query.order !== undefined && !["asc", "desc"].includes(req.query.order)))
    return res.status(400).json({ error: "Invalid library browse options." });
  try {
    const result = demo
      ? (demoLibraries.find(library => library.id === req.params.id) ? { library: demoLibraries.find(library => library.id === req.params.id), total: titles.length, start, items: titles.slice(start, start + limit) } : null)
      : await libraryItems(req.user, req.params.id, { start, limit, played, favorites: req.query.favorites === "true", query: req.query.query, genres, years, sort: req.query.sort, order: req.query.order });
    if (!result) return res.status(404).json({ error: "This library is not available to your Jellyfin account." });
    for (const item of result.items) {
      req.user.state.allowedImages.add(item.id);
      if (item.backdropId) req.user.state.allowedImages.add(item.backdropId);
    }
    res.json(result);
  } catch (error) {
    if (/first 10,000 items/.test(error.message)) return res.status(400).json({ error: "Library browsing is limited to the first 10,000 items." });
    res.status(502).json({ error: "Library items could not be loaded from Jellyfin." });
  }
});
app.get("/api/personal/:kind", requireUser, async (req, res) => {
  if (!["continueWatching", "nextUp", "watchNext", "topUnwatched"].includes(req.params.kind)) return res.sendStatus(404);
  try {
    const items = demo ? (req.params.kind === "nextUp" ? titles.filter(item => item.type === "tv") : titles).slice(0, 3).map((item, index) => ({ ...item, favoriteId: item.id, favorite: false, progress: req.params.kind === "continueWatching" ? 30 + index * 20 : 0, remaining: 25 + index * 8 })) : await personalItems(req.user, req.params.kind);
    if (demo && ["watchNext", "topUnwatched"].includes(req.params.kind)) for (const item of items) { item.watched = false; item.subtitle = [item.detail?.year || "2026", item.type === "movie" ? "Movie" : "Series"].join(" · "); item.progress = 0; }
    for (const item of items) {
      req.user.state.allowedImages.add(item.id);
      if (item.backdropId) req.user.state.allowedImages.add(item.backdropId);
    }
    res.json({ items });
  } catch { res.status(502).json({ error: "Your viewing history could not be loaded from Jellyfin." }); }
});
app.get("/api/recent", requireUser, async (req, res) => {
  try {
    const items = demo ? titles : await recentItems(req.user);
    for (const item of items) {
      if (item.image) req.user.state.allowedImages.add(item.id);
      if (item.backdropId) req.user.state.allowedImages.add(item.backdropId);
    }
    res.json({ items });
  } catch (error) {
    if (/HTTP 401/.test(error.message)) {
      sessions.revoke(req.user.sid, req.user.expires);
      cookie(res, "", 0);
      return res.status(401).json({ error: "Jellyfin ended this sign-in. Please sign in again." });
    }
    res.status(502).json({ error: `Recently added could not be loaded from Jellyfin. ${error.message}` });
  }
});
app.get("/api/image/:id", requireUser, async (req, res) => {
  if (
    !req.user.state.allowedImages.has(req.params.id) ||
    !/^[a-zA-Z0-9-]+$/.test(req.params.id)
  )
    return res.sendStatus(404);
  const type = req.query.type || "Primary";
  if (!["Primary", "Backdrop"].includes(type)) return res.sendStatus(400);
  try {
    const response = await fetch(
      `${process.env.JELLYFIN_URL.replace(/\/$/, "")}/Items/${req.params.id}/Images/${type}?maxWidth=${type === "Backdrop" ? 900 : 420}&quality=85`,
      {
        headers: jellyfinHeaders(req.user.token, req.user.deviceId),
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
    const bytes = await imageBytes(response, 5 * 1024 * 1024);
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
  const calendarImages = new Map();
  req.user.state.calendarImages = calendarImages;
  for (const event of data.events) {
    // Use Sonarr's cached cover when present instead of depending on its remote
    // artwork host. Only fixed MediaCover paths for this returned series qualify.
    for (const kind of ["backdrop", "poster"]) {
      const id = kind === "backdrop" ? event.id : `${event.id}-poster`;
      const localField = kind === "backdrop" ? "localBackdrop" : "localPoster";
      const local =
        typeof event[localField] === "string"
          ? event[localField].match(
              /(?:^|\/)MediaCover\/(\d+)\/(fanart|poster)\.(jpg|png)(?:\?[^#]*)?$/i,
            )
          : null;
      if (local && Number(local[1]) === event.seriesId) {
        req.user.state.calendarImages.set(id, {
          url: serviceUrl(
            process.env.SONARR_URL,
            `/MediaCover/${local[1]}/${local[2]}.${local[3]}`,
          ).href,
          sonarr: true,
        });
      }
      if (!req.user.state.calendarImages.has(id) && event[kind]) {
        try {
          const url = new URL(event[kind]);
          if (
            url.protocol === "https:" &&
            ["artworks.thetvdb.com", "image.tmdb.org"].includes(url.hostname) &&
            !url.username &&
            !url.password &&
            !url.port
          )
            req.user.state.calendarImages.set(id, { url: url.href, sonarr: false });
        } catch {
          /* Ignore invalid artwork URLs from upstream metadata. */
        }
      }
      delete event[localField];
      event[kind] = req.user.state.calendarImages.has(id)
        ? `/api/calendar-image/${encodeURIComponent(id)}`
        : demo
          ? "/art/north.svg"
          : null;
    }
    delete event.seriesId;
  }
  res.json(data);
});
app.get("/api/calendar-image/:id", requireUser, async (req, res) => {
  const image = req.user.state.calendarImages?.get(req.params.id);
  if (!image) return res.sendStatus(404);
  try {
    const response = await fetch(image.url, {
      headers: image.sonarr ? { "X-Api-Key": process.env.SONARR_API_KEY } : {},
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
    const bytes = await imageBytes(response, 5 * 1024 * 1024);
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
        time: ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"],
        weather_code: [2, 3, 61, 0, 2],
        temperature_2m_max: celsius ? [22, 23, 22, 24, 21] : [72, 74, 71, 75, 70],
        temperature_2m_min: celsius ? [12, 13, 11, 12, 10] : [54, 56, 52, 54, 50],
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
      daily: "temperature_2m_max,temperature_2m_min,weather_code",
      forecast_days: "5",
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
// Country flags come from the flag-icons package (MIT), so they render as real
// images on every device instead of depending on emoji fonts.
app.use(
  "/flags",
  express.static(path.join(root, "..", "node_modules", "flag-icons", "flags", "4x3"), {
    maxAge: "7d",
    index: false,
  }),
);
app.use(
  express.static(path.join(root, "..", "public"), {
    etag: true,
    maxAge: 0,
    setHeaders(res, file) {
      // Posters and icons rarely change, so let browsers reuse them for 5 minutes.
      if (/[\\/](art|icons)[\\/]/.test(file))
        res.setHeader("Cache-Control", "public, max-age=300");
    },
  }),
);
app.use((err, req, res, next) =>
  res.status(400).json({ error: "Invalid request." }),
);
setInterval(() => {
  sessions.sweep();
  for (const [id, data] of weatherAttempts)
    if (data.until < Date.now()) weatherAttempts.delete(id);
  for (const [id, data] of apiAttempts)
    if (data.until < Date.now()) apiAttempts.delete(id);
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
