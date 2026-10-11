import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSessions } from "../src/sessions.js";
import {
  cleanNotifications,
  validSubscription,
  localClock,
  notificationEvents,
  createNotifications,
} from "../src/notifications.js";
const prefs = {
  requests: true,
  timezone: "America/New_York",
  shows: [{ id: "show", airs: true, available: true }],
};
const subscription = (suffix) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`,
  keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
});
const empty = { episodes: [], requests: [], airings: [] };
test("notification input limits and push endpoint allowlist reject SSRF", () => {
  assert.deepEqual(cleanNotifications(prefs), prefs);
  for (const bad of [
    {},
    { ...prefs, timezone: "No/Place" },
    { ...prefs, shows: [{ id: "../admin", airs: true, available: false }] },
    { ...prefs, shows: [prefs.shows[0], prefs.shows[0]] },
  ])
    assert.equal(cleanNotifications(bad), null);
  assert.equal(validSubscription(subscription("safe")), true);
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://push.apple.com.evil.test/x",
  ])
    assert.equal(
      validSubscription({ ...subscription("safe"), endpoint }),
      false,
    );
});
test("reminders baseline without backlog, detect new episodes and requests, and summarize once at 9am", () => {
  const before = { episodes: ["old"], requests: ["old"], summaryDay: null };
  const snapshot = {
    episodes: [{ id: "old" }, { id: "new", title: "Show", subtitle: "S1E2" }],
    requests: [{ id: "new", title: "Movie" }],
    airings: [{ title: "Show", date: "2026-10-11T23:00:00Z" }],
  };
  assert.equal(
    notificationEvents(snapshot, null, prefs, new Date("2026-10-11T13:00:00Z"))
      .events.length,
    0,
  );
  const morning = notificationEvents(
    snapshot,
    before,
    prefs,
    new Date("2026-10-11T13:05:00Z"),
  );
  assert.equal(morning.events.length, 3);
  assert.equal(morning.events[2].body, "Show");
  assert.equal(
    notificationEvents(
      snapshot,
      morning.current,
      prefs,
      new Date("2026-10-11T13:10:00Z"),
    ).events.length,
    0,
  );
  const absent = notificationEvents(
    empty,
    morning.current,
    prefs,
    new Date("2026-10-11T14:10:00Z"),
  );
  assert.equal(
    notificationEvents(
      snapshot,
      absent.current,
      prefs,
      new Date("2026-10-11T14:20:00Z"),
    ).events.length,
    0,
  );
  assert.equal(
    notificationEvents(
      snapshot,
      before,
      prefs,
      new Date("2026-10-11T19:00:00Z"),
    ).events.length,
    2,
  );
  assert.deepEqual(
    localClock(new Date("2026-11-01T14:00:00Z"), "America/New_York"),
    { day: "2026-11-01", hour: 9 },
  );
});
test("persisted encrypted push devices isolate users, deduplicate across restart, and stop on sign-out", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-push-"));
  const sessions = createSessions({ dataDir: dir, ttl: 90 * 86400000 });
  const request = (value) => ({
    headers: { cookie: `marquee_session=${value}` },
  });
  const alice = sessions.fromRequest(
    request(
      sessions.seal({
        id: "alice",
        token: "private-token",
        deviceId: "alice-device",
      }),
    ),
  );
  const bob = sessions.fromRequest(
    request(sessions.seal({ id: "bob", token: "bob-token" })),
  );
  const sent = [];
  let data = structuredClone(empty),
    fail = false;
  const options = {
    dataDir: dir,
    sessions,
    now: () => new Date("2026-10-11T10:00:00Z"),
    snapshot: async (user) => {
      assert.equal(user.id, "alice");
      if (fail) throw new Error("outage");
      return data;
    },
    send: async (sub, body) => sent.push(JSON.parse(body)),
  };
  let notifications = await createNotifications(options);
  await notifications.configure(alice, prefs);
  assert.equal(notifications.preferences(bob.id).requests, false);
  await notifications.subscribe(alice, subscription("device"));
  await assert.rejects(
    notifications.subscribe(bob, subscription("device")),
    /another account/,
  );
  await notifications.tick();
  assert.equal(sent.length, 0);
  data.episodes.push({ id: "episode-2", title: "Test", subtitle: "S1E2" });
  fail = true;
  await notifications.tick();
  assert.equal(sent.length, 0);
  fail = false;
  await notifications.tick();
  assert.equal(sent.length, 1);
  const saved = await fs.readFile(path.join(dir, "notifications.json"), "utf8");
  assert.equal(saved.includes("private-token"), false);
  assert.equal(saved.includes("fcm.googleapis.com"), false);
  notifications = await createNotifications(options);
  await notifications.tick();
  assert.equal(sent.length, 1);
  sessions.revoke(alice.sid, alice.expires);
  await notifications.tick();
  assert.equal(notifications.status(alice).enabled, false);
  await fs.rm(dir, { recursive: true, force: true });
});
test("invalid upstream credentials and expired push endpoints remove a device", async () => {
  for (const error of [
    new Error("Service answered HTTP 401."),
    Object.assign(new Error("expired"), { statusCode: 410 }),
  ]) {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "marquee-push-expired-"),
    );
    const sessions = createSessions({ dataDir: dir, ttl: 60000 });
    const user = sessions.fromRequest({
      headers: { cookie: `marquee_session=${sessions.seal({ id: "user" })}` },
    });
    let fail = false;
    const notifications = await createNotifications({
      dataDir: dir,
      sessions,
      snapshot: async () => {
        if (fail && !error.statusCode) throw error;
        return empty;
      },
      send: async () => {
        throw error;
      },
    });
    await notifications.subscribe(user, subscription("expired"));
    fail = true;
    if (error.statusCode) await assert.rejects(notifications.test(user));
    else await notifications.tick();
    if (!error.statusCode)
      assert.equal(notifications.status(user).enabled, false);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("copied old browser sessions do not regain push after expiry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-push-ttl-"));
  const sessions = createSessions({ dataDir: dir, ttl: 1000 });
  const user = sessions.fromRequest({
    headers: { cookie: `marquee_session=${sessions.seal({ id: "viewer" })}` },
  });
  const notifications = await createNotifications({
    dataDir: dir,
    sessions,
    snapshot: async () => empty,
    send: async () => {},
  });
  await notifications.subscribe(user, subscription("expires"));
  const realNow = Date.now;
  try {
    Date.now = () => user.expires + 1;
    await notifications.tick();
    assert.equal(notifications.status(user).enabled, false);
  } finally {
    Date.now = realNow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("expired push endpoints are removed during event delivery", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-push-gone-"));
  const sessions = createSessions({ dataDir: dir, ttl: 60000 });
  const user = sessions.fromRequest({
    headers: { cookie: `marquee_session=${sessions.seal({ id: "user" })}` },
  });
  let data = structuredClone(empty);
  const notifications = await createNotifications({
    dataDir: dir,
    sessions,
    snapshot: async () => data,
    send: async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    },
  });
  await notifications.configure(user, prefs);
  await notifications.subscribe(user, subscription("gone"));
  data.episodes.push({ id: "new", title: "Show", subtitle: "S1E2" });
  await notifications.tick();
  assert.equal(notifications.status(user).enabled, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("sign-out during a slow upstream read cancels pending notification delivery", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marquee-push-race-"));
  const sessions = createSessions({ dataDir: dir, ttl: 60000 });
  const user = sessions.fromRequest({
    headers: { cookie: `marquee_session=${sessions.seal({ id: "user" })}` },
  });
  let blocked = false,
    release,
    started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const sent = [];
  const notifications = await createNotifications({
    dataDir: dir,
    sessions,
    snapshot: async () => {
      if (blocked) {
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return blocked
        ? {
            ...empty,
            episodes: [{ id: "new", title: "Private show", subtitle: "S1E2" }],
          }
        : empty;
    },
    send: async () => sent.push(true),
  });
  await notifications.configure(user, prefs);
  await notifications.subscribe(user, subscription("race"));
  blocked = true;
  const tick = notifications.tick();
  await waiting;
  await notifications.remove(user);
  sessions.revoke(user.sid, user.expires);
  release();
  await tick;
  assert.equal(sent.length, 0);
  assert.equal(notifications.status(user).enabled, false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a failed replacement baseline keeps an existing device enrolled", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "marquee-push-baseline-"),
  );
  const sessions = createSessions({ dataDir: dir, ttl: 60000 });
  const user = sessions.fromRequest({
    headers: { cookie: `marquee_session=${sessions.seal({ id: "user" })}` },
  });
  let fail = false;
  const notifications = await createNotifications({
    dataDir: dir,
    sessions,
    snapshot: async () => {
      if (fail) throw new Error("upstream offline");
      return empty;
    },
    send: async () => {},
  });
  await notifications.subscribe(user, subscription("original"));
  fail = true;
  await assert.rejects(
    notifications.subscribe(user, subscription("replacement")),
    /offline/,
  );
  assert.equal(notifications.status(user).enabled, true);
  await fs.rm(dir, { recursive: true, force: true });
});
