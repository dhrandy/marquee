import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import webpush from "web-push";

export const notificationDefaults = {
  requests: false,
  shows: [],
  timezone: "America/New_York",
};
export function cleanNotifications(value) {
  if (
    !value ||
    typeof value.requests !== "boolean" ||
    !Array.isArray(value.shows) ||
    value.shows.length > 50 ||
    typeof value.timezone !== "string"
  )
    return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  } catch {
    return null;
  }
  const shows = [];
  for (const show of value.shows) {
    if (
      !show ||
      typeof show.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(show.id) ||
      typeof show.airs !== "boolean" ||
      typeof show.available !== "boolean" ||
      shows.some((old) => old.id === show.id)
    )
      return null;
    shows.push({ id: show.id, airs: show.airs, available: show.available });
  }
  return { requests: value.requests, shows, timezone: value.timezone };
}
export function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const allowed = [
      "wns.windows.com",
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "push.services.mozilla.com",
      "web.push.apple.com",
    ];
    const apple = /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname);
    const windows = /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      (!allowed.includes(url.hostname) && !apple && !windows) ||
      value.endpoint.length > 2048
    )
      return false;
    return (
      /^[A-Za-z0-9_-]{80,100}={0,2}$/.test(value.keys?.p256dh || "") &&
      /^[A-Za-z0-9_-]{20,30}={0,2}$/.test(value.keys?.auth || "")
    );
  } catch {
    return false;
  }
}
export function localClock(now, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (key) => parts.find((value) => value.type === key).value;
  return {
    day: `${part("year")}-${part("month")}-${part("day")}`,
    hour: Number(part("hour")),
  };
}
export function notificationEvents(
  snapshot,
  previous,
  preferences,
  now = new Date(),
) {
  const clock = localClock(now, preferences.timezone);
  const current = {
    episodes: [
      ...new Set([
        ...snapshot.episodes.map((item) => item.id),
      ]),
    ],
    requests: [
      ...new Set([
        ...snapshot.requests.map((item) => item.id),
      ]),
    ],
    summaryDay: previous?.summaryDay || null,
  };
  const events = [];
  // First successful read is a baseline. Enabling never floods old arrivals.
  if (!previous) {
    // Enrollment during the morning window may still receive today's summary.
    current.summaryDay = clock.hour === 9 ? clock.day : current.summaryDay;
    return { current, events };
  }
  const episodes = snapshot.episodes.filter(
    (item) => !previous.episodes.includes(item.id),
  );
  if (episodes.length)
    events.push({
      title: "New episodes on Jellyfin",
      body:
        episodes
          .slice(0, 5)
          .map((item) => `${item.title} ${item.subtitle}`)
          .join(", ") +
        (episodes.length > 5 ? ` and ${episodes.length - 5} more` : ""),
      tag: `episodes-${clock.day}`,
    });
  if (preferences.requests)
    for (const item of snapshot.requests.filter(
      (item) => !previous.requests.includes(item.id),
    ))
      events.push({
        title: "Your request is available",
        body: `${item.title} is now on Jellyfin.`,
        tag: `request-${item.id}`,
      });
  // Only the 9am hour, never a stale evening catch-up after downtime.
  if (clock.hour === 9 && current.summaryDay !== clock.day) {
    current.summaryDay = clock.day;
    const titles = [
      ...new Set(
        snapshot.airings
          .filter(
            (item) =>
              localClock(new Date(item.date), preferences.timezone).day ===
              clock.day,
          )
          .map((item) => item.title),
      ),
    ];
    if (titles.length)
      events.push({
        title: "Your shows air today",
        body:
          titles.slice(0, 8).join(", ") +
          (titles.length > 8 ? ` and ${titles.length - 8} more` : ""),
        tag: `airings-${clock.day}`,
      });
  }
  return { current, events };
}

export async function createNotifications({
  dataDir,
  sessions,
  snapshot,
  send = webpush.sendNotification.bind(webpush),
  now = () => new Date(),
}) {
  const file = path.join(dataDir, "notifications.json");
  let store = { accounts: {}, devices: {} };
  try {
    store = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const keyFile = path.join(dataDir, "push-keys.json");
  let keys;
  try {
    keys = JSON.parse(await fs.readFile(keyFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    keys = webpush.generateVAPIDKeys();
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(keyFile, JSON.stringify(keys), {
      mode: 0o600,
      flag: "wx",
    });
  }
  const vapidDetails = {
    subject: process.env.PUSH_CONTACT || "https://marquee.local",
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  let writes = Promise.resolve(),
    busy = false;
  function persist() {
    const content = JSON.stringify(store);
    const write = writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(file + ".tmp", content, { mode: 0o600 });
        await fs.rename(file + ".tmp", file);
      });
    writes = write;
    return write;
  }
  function preferences(id) {
    return store.accounts[id] || notificationDefaults;
  }
  function unseal(value) {
    return sessions.fromRequest(
      { headers: { cookie: `marquee_session=${value}` } },
      true,
    );
  }
  function device(id) {
    const sealed = store.devices[id];
    return sealed ? unseal(sealed)?.notificationDevice : null;
  }
  async function saveDevice(id, user, value) {
    // Credentials and capability URLs are encrypted using the persisted session key.
    store.devices[id] = sessions.seal(
      {
        id: user.id,
        token: user.token,
        deviceId: user.deviceId,
        notificationDevice: value,
      },
      user.sid,
      user.expires,
    );
    await persist();
  }
  function userDevice(user) {
    return Object.keys(store.devices).find((id) => {
      const entry = unseal(store.devices[id]);
      return entry?.id === user.id && entry.sid === user.sid;
    });
  }
  async function remove(user) {
    for (const id of Object.keys(store.devices)) {
      const entry = unseal(store.devices[id]);
      if (!entry || (entry.id === user.id && entry.sid === user.sid))
        delete store.devices[id];
    }
    await persist();
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      for (const id of Object.keys(store.devices)) {
        const user = unseal(store.devices[id]);
        if (!user) {
          delete store.devices[id];
          await persist();
          continue;
        }
        const current = user.notificationDevice,
          prefs = preferences(user.id);
        const fingerprint = JSON.stringify(prefs);
        try {
          const data = await snapshot(user, prefs);
          // Sign-out or a settings edit during an upstream read cancels this dispatch.
          if (
            !store.devices[id] ||
            !unseal(store.devices[id]) ||
            JSON.stringify(preferences(user.id)) !== fingerprint
          )
            continue;
          const before =
            fingerprint === current.fingerprint ? current.previous : null;
          const result = notificationEvents(data, before, prefs, now());
          // Persist the cursor before dispatch: restarts can't spam duplicate alerts.
          await saveDevice(id, user, {
            ...current,
            previous: result.current,
            fingerprint,
          });
          for (const event of result.events) {
            if (
              !store.devices[id] ||
              !unseal(store.devices[id]) ||
              JSON.stringify(preferences(user.id)) !== fingerprint
            )
              break;
            await send(
              current.subscription,
              JSON.stringify({ ...event, url: "/" }),
              { vapidDetails, TTL: 3600, timeout: 10000 },
            );
          }
        } catch (error) {
          if (
            [404, 410].includes(error.statusCode) ||
            /HTTP (401|403)\b/.test(error.message)
          ) {
            delete store.devices[id];
            await persist();
          }
          // A service outage must never turn a missing snapshot into false arrivals.
        }
      }
    } finally {
      busy = false;
    }
  }
  return {
    publicKey: keys.publicKey,
    preferences,
    tick,
    status: (user) => ({
      preferences: preferences(user.id),
      enabled: Boolean(userDevice(user)),
      publicKey: keys.publicKey,
    }),
    async configure(user, prefs) {
      store.accounts[user.id] = prefs;
      await persist();
    },
    async subscribe(user, subscription) {
      if (!validSubscription(subscription))
        throw new Error("Invalid or unsupported push subscription.");
      const id = crypto
        .createHash("sha256")
        .update(subscription.endpoint)
        .digest("hex");
      const old = unseal(store.devices[id]);
      if (old && old.id !== user.id)
        throw new Error(
          "This device is subscribed to another account. Disable it there first.",
        );
      // A capability URL may not silently move between people/accounts.
      const prefs = preferences(user.id);
      const data = await snapshot(user, prefs);
      const baseline = notificationEvents(data, null, prefs, now()).current;
      // Keep a working device intact when upstream baseline collection fails.
      await remove(user);
      await saveDevice(id, user, {
        subscription,
        previous: baseline,
        fingerprint: JSON.stringify(prefs),
      });
    },
    remove,
    async test(user) {
      const id = userDevice(user),
        entry = id && device(id);
      if (!entry) throw new Error("Enable notifications on this device first.");
      await send(
        entry.subscription,
        JSON.stringify({
          title: "Marquee notifications",
          body: "This device is ready for your chosen reminders.",
          url: "/",
          tag: "marquee-test",
        }),
        { vapidDetails, TTL: 60, timeout: 10000 },
      );
    },
  };
}
