// Stateless sessions: the signed-in user lives in an encrypted cookie, so a
// container recreate or restart does not sign anyone out. The cookie holds the
// Jellyfin token, so it is encrypted (AES-256-GCM), not just signed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadSecret(dataDir) {
  const fromEnv = (process.env.SESSION_SECRET || "").trim();
  if (fromEnv) {
    if (fromEnv.length < 16)
      console.warn("SESSION_SECRET is short; use at least 32 random characters.");
    return fromEnv;
  }
  // No secret configured: generate one once and keep it in the data volume so
  // it survives restarts. Nobody has to set anything for this to work.
  const file = path.join(dataDir, "session-secret");
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved.length >= 32) return saved;
  } catch {}
  const made = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, made, { mode: 0o600 });
  } catch {
    console.warn(
      "Could not save a session secret; sign-ins will not survive a restart. Set SESSION_SECRET or make the data directory writable.",
    );
  }
  return made;
}

export function createSessions({ dataDir, ttl }) {
  const key = crypto
    .createHash("sha256")
    .update("marquee-session-v1:" + loadSecret(dataDir))
    .digest();
  const revokedFile = path.join(dataDir, "revoked-sessions.json");
  const pendingFile = revokedFile + ".pending";
  if (fs.existsSync(pendingFile)) throw new Error("Session revocation state could not be read. An interrupted write needs storage repair before starting.");
  // sid -> expiry. Sign-out lists the session here so a copied cookie stops
  // working too. Kept on disk so a restart does not forget it.
  const revoked = new Map();
  try {
    const rows = JSON.parse(fs.readFileSync(revokedFile, "utf8"));
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || !/^[a-f0-9]{32}$/.test(row[0]) || !Number.isFinite(row[1]))) throw new Error("Invalid revocation state");
    for (const [sid, exp] of rows) if (exp > Date.now()) revoked.set(sid, exp);
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Session revocation state could not be read. Repair the settings storage before starting.");
  }
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(pendingFile, "pending", { mode: 0o600 });
      fs.writeFileSync(revokedFile + ".tmp", JSON.stringify([...revoked]), { mode: 0o600 });
      fs.renameSync(revokedFile + ".tmp", revokedFile);
      fs.unlinkSync(pendingFile);
    } catch {
      console.error("Session revocation could not be saved. Check the settings storage.");
      throw new Error("Could not save sign-out. Check the settings storage.");
    }
  }
  // Per-session image allow lists. These only cache what the shelf and
  // calendar last showed, so losing them on restart is harmless.
  const state = new Map();

  function seal(user, sid = crypto.randomBytes(16).toString("hex"), expires = Date.now() + ttl) {
    const payload = JSON.stringify({ sid, exp: expires, user });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  function open(value, internal = false) {
    if (typeof value !== "string" || value.length > (internal ? 40000000 : 4096) || !/^[A-Za-z0-9_-]{40,}$/.test(value))
      return null;
    try {
      const raw = Buffer.from(value, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
      const data = JSON.parse(text.toString("utf8"));
      if (!(data.exp > Date.now()) || revoked.has(data.sid)) return null;
      return data;
    } catch {
      return null;
    }
  }
  function fromRequest(req, internal = false) {
    const value = /(?:^|; )marquee_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const data = open(value, internal);
    if (!data) return null;
    let extra = state.get(data.sid);
    if (!extra) {
      extra = { allowedImages: new Set(), calendarImages: undefined, exp: data.exp };
      state.set(data.sid, extra);
    }
    return { sid: data.sid, ...data.user, expires: data.exp, state: extra };
  }
  function revoke(sid, exp) {
    revoked.set(sid, exp);
    state.delete(sid);
    persist();
  }
  function sweep() {
    let changed = false;
    for (const [sid, exp] of revoked)
      if (exp < Date.now()) (revoked.delete(sid), (changed = true));
    for (const [sid, data] of state) if (data.exp < Date.now()) state.delete(sid);
    if (changed) { try { persist(); } catch { /* Logged; in-memory revocations remain authoritative. */ } }
  }
  return { seal, fromRequest, revoke, sweep };
}
