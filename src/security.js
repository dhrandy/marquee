import { isIP } from "node:net";

// Trust only explicitly named proxy IPs/CIDRs, never a hop count or all senders.
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

export function allowedOrigin(origin, host, secure) {
  return typeof origin === "string" && typeof host === "string" &&
    (origin === `https://${host}` || (!secure && origin === `http://${host}`));
}
