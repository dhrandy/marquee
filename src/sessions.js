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
  // sid -> expiry. Sign-out lists the session here so a copied cookie stops
  // working too. Kept on disk so a restart does not forget it.
  const revoked = new Map();
  try {
    for (const [sid, exp] of JSON.parse(fs.readFileSync(revokedFile, "utf8")))
      if (exp > Date.now()) revoked.set(sid, exp);
  } catch {}
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(revokedFile, JSON.stringify([...revoked]), { mode: 0o600 });
    } catch {}
  }
  // Per-session image allow lists. These only cache what the shelf and
  // calendar last showed, so losing them on restart is harmless.
  const state = new Map();

  function seal(user, sid = crypto.randomBytes(16).toString("hex")) {
    const payload = JSON.stringify({ sid, exp: Date.now() + ttl, user });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  }
  function open(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{40,4096}$/.test(value))
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
  function fromRequest(req) {
    const value = /(?:^|; )marquee_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const data = open(value);
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
    if (changed) persist();
  }
  return { seal, fromRequest, revoke, sweep };
}
