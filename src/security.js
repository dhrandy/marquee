import { isIP } from "node:net";

// Explicit IP/CIDR allowlist is stricter than the opt-in single-proxy mode.
export function trustedProxies(value = "") {
  const entries = value.split(",").map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, mask, extra] = entry.split("/");
    const family = isIP(address);
    if (!family || extra !== undefined || (mask !== undefined &&
      (!/^\d+$/.test(mask) || Number(mask) < 1 || Number(mask) > (family === 4 ? 32 : 128)))) {
      throw new Error("TRUSTED_PROXIES must contain only proxy IP addresses or nonzero CIDR ranges.");
    }
  }
  return entries.length ? entries : false;
}

export function proxyTrust(allowlist = "", singleHop = "") {
  const strict = trustedProxies(allowlist);
  if (!["", "0", "1"].includes(singleHop)) throw new Error("TRUST_PROXY must be 0 (off) or 1 (single proxy hop).");
  return strict || (singleHop === "1" ? 1 : false);
}

export function allowedOrigin(origin, host, secure) {
  return typeof origin === "string" && typeof host === "string" &&
    (origin === `https://${host}` || (!secure && origin === `http://${host}`));
}
