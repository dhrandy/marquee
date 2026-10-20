import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { withWatched } from '../src/adapters.js';

const movie = (Id, tmdb, extra = {}) => ({ Id, Name: 'Matchbox', Type: 'Movie', ProviderIds: { Tmdb: String(tmdb) }, UserData: { Played: false, IsFavorite: false }, ...extra });

test('provider fallback is paged, exact-ID checked, viewer/session scoped and shared', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(url);
    const viewer = url.searchParams.get('UserId');
    assert.ok(req.headers.authorization.includes(`token-${viewer}`));
    res.setHeader('Content-Type', 'application/json');
    if (viewer === 'broken') { res.writeHead(401); return res.end('{}'); }
    if (url.searchParams.has('SearchTerm')) return res.end(JSON.stringify({ Items: [movie('wrong-title-match', 999)] }));
    if (viewer === 'bob') return res.end(JSON.stringify({ Items: [] }));
    const start = Number(url.searchParams.get('StartIndex'));
    const first = Array.from({ length: 500 }, (_, i) => movie(`filler-${i}`, 20000 + i));
    return res.end(JSON.stringify({ Items: start === 0 ? first : [movie('matchbox', 1234), movie('other', 1235), movie('missing', 1236, { IsMissing: true }), movie('virtual', 1237, { LocationType: 'Virtual' }), movie('placeholder', 1238, { IsPlaceHolder: true }), movie('wrong-type', 1239, { Type: 'Series' })], TotalRecordCount: 506 }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldUrl = process.env.JELLYFIN_URL, oldWeb = process.env.JELLYFIN_WEB_URL;
  process.env.JELLYFIN_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.JELLYFIN_WEB_URL = 'https://jellyfin.example.test';
  const viewer = id => ({ id, token: `token-${id}`, deviceId: 'test-device' });
  const title = id => ({ mediaType: 'movie', mediaId: id, title: 'Matchbox the Movie', availability: 5 });
  try {
    const results = await withWatched(viewer('alice'), [title(1234), title(1235)]);
    assert.match(results[0].playLink, /id=matchbox$/);
    assert.equal(results[0].favoriteId, 'matchbox');
    assert.equal(results[0].watched, false);
    assert.equal(calls.filter(url => !url.searchParams.has('SearchTerm')).length, 2, 'concurrent titles share one two-page index');
    for (const id of [1236, 1237, 1238, 1239, 9876]) {
      const [result] = await withWatched(viewer('alice'), [title(id)]);
      assert.equal(result.playLink, null);
    }
    assert.equal(calls.filter(url => !url.searchParams.has('SearchTerm')).length, 2, 'cached index reused');
    const [bob] = await withWatched(viewer('bob'), [title(1234)]);
    assert.equal(bob.playLink, null, 'another viewer cannot inherit Alice access');
    const [broken] = await withWatched(viewer('broken'), [title(1234)]);
    assert.equal(broken.playLink, undefined, 'upstream failure does not invent a link');
    const prior = calls.length;
    await withWatched(viewer('broken'), [title(1234)]);
    assert.ok(calls.length > prior, 'failure is retried, not cached as no match');
  } finally {
    if (oldUrl === undefined) delete process.env.JELLYFIN_URL; else process.env.JELLYFIN_URL = oldUrl;
    if (oldWeb === undefined) delete process.env.JELLYFIN_WEB_URL; else process.env.JELLYFIN_WEB_URL = oldWeb;
    await new Promise(resolve => server.close(resolve));
  }
});
