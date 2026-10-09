import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const port = 18752;
const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), DEMO_MODE: "true", COOKIE_SECURE: "false" },
  stdio: "ignore",
});
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/config`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
test.after(() => server.kill());

const get = (path, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers });

test("text assets are gzipped when the browser accepts it", async () => {
  for (const path of ["/app.js", "/style.css", "/"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(res.headers.get("content-encoding"), "gzip", path);
    assert.match(res.headers.get("vary"), /Accept-Encoding/i);
  }
  const raw = fs.readFileSync("public/app.js");
  const res = await fetch(`http://127.0.0.1:${port}/app.js`, {
    headers: { "Accept-Encoding": "gzip" },
  });
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), raw);
});

test("clients without gzip and binary files are left alone", async () => {
  const plain = await get("/app.js", { "Accept-Encoding": "identity" });
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.deepEqual(
    Buffer.from(await plain.arrayBuffer()),
    fs.readFileSync("public/app.js"),
  );
  const png = await get("/icons/icon-192.png", { "Accept-Encoding": "gzip" });
  assert.equal(png.headers.get("content-encoding"), null);
});

test("conditional and range requests still work", async () => {
  const first = await get("/style.css", { "Accept-Encoding": "gzip" });
  const etag = first.headers.get("etag");
  // fetch() can mask 304s, so use a raw request for the conditional check.
  const status = await new Promise((resolve) =>
    http
      .get(
        `http://127.0.0.1:${port}/style.css`,
        { headers: { "Accept-Encoding": "gzip", "If-None-Match": etag } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", () => resolve(0)),
  );
  assert.equal(status, 304);
  const range = await get("/app.js", {
    "Accept-Encoding": "gzip",
    Range: "bytes=0-99",
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
});
