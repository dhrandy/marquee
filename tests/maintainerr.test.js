import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { leavingCandidates, leavingSoon } from "../src/maintainerr.js";
const member = { mediaServerId: "film", addDate: "2026-10-01T00:00:00Z" };
const collection = { id: 1, mediaServerType: "jellyfin", isActive: true, arrAction: 0, deleteAfterDays: 10, media: [member] };
test("Maintainerr dates require active Jellyfin delete collections, valid members and eligible rule state", () => {
  assert.equal(leavingCandidates([collection])[0].due, "2026-10-11T00:00:00.000Z");
  assert.equal(leavingCandidates([{ ...collection, deleteAfterDays: null }])[0].immediate, true);
  for (const patch of [{ isActive: false }, { arrAction: 3 }, { arrAction: 4 }, { arrAction: 5 }, { mediaServerType: "plex" }, { mediaServerType: "emby" }, { deleteAfterDays: -1 }]) assert.deepEqual(leavingCandidates([{ ...collection, ...patch }]), []);
  assert.deepEqual(leavingCandidates([{ ...collection, media: [{ ...member, ruleEvaluationFailed: true }] }]), []);
  assert.equal(leavingCandidates([{ ...collection, media: [{ ...member, ruleEvaluationFailed: true, isManual: true }] }]).length, 1);
  assert.deepEqual(leavingCandidates([{ ...collection, media: [{ ...member, addDate: "bad" }] }]), []);
  assert.throws(() => leavingCandidates(null));
});
test("Maintainerr reads exclude protected ancestors, deduplicate, and only disclose this viewer's Jellyfin items", async () => {
  let badExclusions = false, jellyfinOutage = false, malformedCollections = false, optionalKey = true; const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost"); calls.push({ method: req.method, path: url.pathname, query: url.search });
    assert.equal(req.method, "GET"); res.setHeader("Content-Type", "application/json");
    if (url.pathname.startsWith("/api/")) assert.equal(req.headers["x-api-key"], optionalKey ? "optional-key" : undefined);
    if (url.pathname === "/api/collections/overlay-data") return res.end(JSON.stringify(malformedCollections ? {} : [{ ...collection, media: [member, { ...member, mediaServerId: "private-film" }, { ...member, mediaServerId: "episode" }, { ...member, mediaServerId: "global-protected" }] }, { ...collection, id: 2, media: [member] }]));
    if (url.pathname.includes("/exclusions/")) return res.end(JSON.stringify(badExclusions ? {} : { totalSize: 1, items: [{ mediaServerId: "parent-show" }] }));
    if (url.pathname === "/api/rules/exclusion") return res.end(JSON.stringify(url.searchParams.get("mediaServerId") === "global-protected" ? [{ mediaServerId: "global-protected", ruleGroupId: null }] : []));
    if (url.pathname.startsWith("/Users/")) {
      assert.ok(req.headers.authorization.includes('Token="viewer-token"'));
      assert.ok(url.pathname.startsWith("/Users/alice/Items/"));
      if (jellyfinOutage) { res.writeHead(503); return res.end("{}"); }
      const id = url.pathname.split("/").pop();
      if (id === "private-film") { res.writeHead(403); return res.end("{}"); }
      return res.end(JSON.stringify({ Id: id, Name: `Visible ${id}`, Type: id === "episode" ? "Episode" : "Movie", SeriesId: id === "episode" ? "parent-show" : null, UserData: { IsFavorite: false }, ImageTags: { Primary: "art" } }));
    }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const old = { JELLYFIN_URL: process.env.JELLYFIN_URL, MAINTAINERR_URL: process.env.MAINTAINERR_URL, MAINTAINERR_API_KEY: process.env.MAINTAINERR_API_KEY };
  const url = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, { JELLYFIN_URL: url, MAINTAINERR_URL: url, MAINTAINERR_API_KEY: "optional-key" });
  try {
    const items = await leavingSoon({ id: "alice", token: "viewer-token" });
    assert.deepEqual(items.map(item => item.id), ["film"]);
    assert.equal(items[0].leavingAt, "2026-10-11T00:00:00.000Z");
    assert.equal(items[0].favoriteId, "film");
    assert.equal(calls.filter(call => call.path === "/Users/alice/Items/film").length, 1);
    optionalKey = false; delete process.env.MAINTAINERR_API_KEY;
    assert.equal((await leavingSoon({ id: "alice", token: "viewer-token" })).length, 1);
    malformedCollections = true;
    await assert.rejects(leavingSoon({ id: "alice", token: "viewer-token" }), /collections list/);
    malformedCollections = false; jellyfinOutage = true;
    await assert.rejects(leavingSoon({ id: "alice", token: "viewer-token" }), /accessibility could not be verified/);
    jellyfinOutage = false;
    badExclusions = true;
    await assert.rejects(leavingSoon({ id: "alice", token: "viewer-token" }), /exclusions could not be verified/);
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve));
  }
});
