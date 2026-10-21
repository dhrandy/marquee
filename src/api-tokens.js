// API tokens for agents and scripts. A token acts as the Jellyfin user who
// made it. Only a hash of the token is stored. The Jellyfin login the token
// uses is kept encrypted with a key derived from the session secret, so
// deleting that secret (or the token file) makes every token useless.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSecret } from "./sessions.js";

export const scopes = ["read", "request"];
export const tokenLimit = 10;

// Read routes a token may call. Settings, notifications, preferences, sign-in
// and token management are never on this list.
export const readRoutes = [
  /^\/api\/me$/,
  /^\/api\/recent$/,
  /^\/api\/calendar$/,
  /^\/api\/personal\/[A-Za-z-]+$/,
  /^\/api\/history$/,
  /^\/api\/libraries$/,
  /^\/api\/libraries\/[^/]+\/items$/,
  /^\/api\/watchlist$/,
  /^\/api\/watch-later$/,
  /^\/api\/favorite\/[^/]+$/,
  /^\/api\/library\/[^/]+\/facts$/,
  /^\/api\/library-stats$/,
  /^\/api\/recommendations$/,
  /^\/api\/leaving-soon$/,
  /^\/api\/in-theaters$/,
  /^\/api\/networks$/,
  /^\/api\/jellyfin-version$/,
  /^\/api\/weather$/,
  /^\/api\/weather\/cities$/,
  /^\/api\/image\/[^/]+$/,
  /^\/api\/calendar-image\/[^/]+$/,
  /^\/api\/seerr\/(search|popular|requests|request-options|content-ratings|image)$/,
  /^\/api\/seerr\/details\/[a-z]+\/\d+$/,
  /^\/api\/docs$/,
];
export const writeRoutes = [{ method: "POST", path: /^\/api\/seerr\/request$/ }];

export function tokenAllowed(scope, method, pathname) {
  if (method === "GET" || method === "HEAD") return readRoutes.some(r => r.test(pathname));
  return scope === "request" && writeRoutes.some(r => r.method === method && r.path.test(pathname));
}

const hash = token => crypto.createHash("sha256").update(token).digest("hex");

export function createApiTokens({ dataDir }) {
  const file = path.join(dataDir, "api-tokens.json");
  const key = crypto.createHash("sha256").update("marquee-api-token-v1:" + loadSecret(dataDir)).digest();
  let rows = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved)) rows = saved;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("API token storage could not be read. Repair the settings storage before starting.");
  }
  function persist(demo) {
    if (demo) return;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file + ".tmp", JSON.stringify(rows), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  function seal(login) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(login), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
  }
  function open(value) {
    try {
      const raw = Buffer.from(value, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch { return null; }
  }
  const view = row => ({ id: row.id, name: row.name, scope: row.scope, created: row.created, lastUsed: row.lastUsed || null });
  return {
    list: userId => rows.filter(r => r.userId === userId).map(view),
    create({ user, name, scope, demo }) {
      if (rows.filter(r => r.userId === user.id).length >= tokenLimit) throw new Error(`You can have up to ${tokenLimit} tokens. Revoke one first.`);
      const token = "mq_" + crypto.randomBytes(32).toString("base64url");
      const row = {
        id: crypto.randomBytes(8).toString("hex"), userId: user.id, userName: user.name, name, scope,
        hash: hash(token), created: Date.now(), lastUsed: null,
        login: seal({ token: user.token, deviceId: user.deviceId, isAdmin: user.isAdmin === true }),
      };
      rows.push(row);
      try { persist(demo); } catch (error) { rows.pop(); throw new Error("Could not save the token. Check the settings storage."); }
      return { token, ...view(row) };
    },
    // Returns the acting user for a presented token, or null.
    find(presented) {
      if (typeof presented !== "string" || !/^mq_[A-Za-z0-9_-]{43}$/.test(presented)) return null;
      const want = Buffer.from(hash(presented), "hex");
      const row = rows.find(r => crypto.timingSafeEqual(Buffer.from(r.hash, "hex"), want));
      if (!row) return null;
      const login = open(row.login);
      if (!login) return null;
      return { row, user: { id: row.userId, name: row.userName, token: login.token, deviceId: login.deviceId, isAdmin: login.isAdmin, sid: "tok-" + row.id, expires: Date.now() + 3600000, via: "token", scope: row.scope } };
    },
    touch(row, demo) {
      if (row.lastUsed && Date.now() - row.lastUsed < 60000) return;
      row.lastUsed = Date.now();
      try { persist(demo); } catch { /* last-used is informational */ }
    },
    // Removes a token. Returns the Jellyfin login it used so the caller can end it.
    remove(id, userId, demo) {
      const i = rows.findIndex(r => r.id === id && r.userId === userId);
      if (i < 0) return null;
      const [row] = rows.splice(i, 1);
      try { persist(demo); } catch { rows.splice(i, 0, row); throw new Error("Could not save the change. Check the settings storage."); }
      return open(row.login) || {};
    },
    // Removes every token. Returns their Jellyfin logins so the caller can end them.
    removeAll(demo) {
      const old = rows;
      rows = [];
      try { persist(demo); } catch (error) { rows = old; throw error; }
      return old.map(r => open(r.login)).filter(Boolean);
    },
    removeRow(row, demo) {
      const i = rows.indexOf(row);
      if (i >= 0) { rows.splice(i, 1); try { persist(demo); } catch {} }
    },
  };
}
