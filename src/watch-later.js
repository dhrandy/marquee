// Saved snapshots contain only shelf-safe fields, never account tokens or arbitrary URLs.
const text = (value, limit = 300) => typeof value === 'string' ? value.slice(0,limit) : '';
export function watchLaterSnapshot(item) {
  if (!item || typeof item !== 'object' || !item.title) return null;
  const type = item.mediaType || item.type || item.detail?.mediaType || (item.watchedScope === 'movie' ? 'movie' : 'tv');
  if (!['movie','tv'].includes(type)) return null;
  const tmdb = item.mediaId || item.tmdbId || (item.mediaType && !("tmdbId" in item) && !("requestedBy" in item) ? item.id : null);
  const id = Number.isSafeInteger(tmdb) && tmdb > 0 && tmdb <= 1e9 ? tmdb : null;
  const libraryId = item.libraryId || item.favoriteId || (!item.mediaType && !item.status && (item.favoriteId || item.watchedScope || "image" in item || "added" in item || item.art) && typeof item.id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(item.id) ? item.id : null);
  if (typeof libraryId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(libraryId)) return null;
  const key = `library:${type}:${libraryId}`;
  const poster = typeof item.poster === 'string' && /^\/[A-Za-z0-9]+\.(jpg|jpeg|png|webp)$/.test(item.poster) ? item.poster : null;
  const demoArt = item.art || (typeof item.poster === 'string' && !item.poster.startsWith('/') ? item.poster : '');
  const art = /^[a-z-]+$/.test(demoArt) ? demoArt : 'placeholder';
  return {key,type,tmdbId:id,libraryId,title:text(item.title,200),year:text(item.year || item.detail?.year,4),subtitle:text(item.subtitle,150),poster,art,image:Boolean(libraryId && item.image),detail:{title:text(item.title,200),subtitle:text(item.subtitle,150),year:text(item.year || item.detail?.year,4),overview:text(item.overview || item.detail?.overview,1200),genres:(Array.isArray(item.genres || item.detail?.genres) ? item.genres || item.detail.genres : []).filter(v=>typeof v==='string').slice(0,8).map(v=>text(v,60)),mediaType:type}};
}
export function updateWatchLater(items, snapshot, saved, now = new Date().toISOString()) {
  const previous = items.find(item=>(item.key===snapshot.key || (snapshot.libraryId && item.libraryId===snapshot.libraryId)));
  const next = items.filter(item=>!(item.key===snapshot.key || (snapshot.libraryId && item.libraryId===snapshot.libraryId)));
  if (saved) { if (!previous && next.length>=500) throw new Error('Your Watchlist is full (500 titles).'); next.unshift({...snapshot,addedAt:previous?.addedAt || now}); }
  return next;
}
