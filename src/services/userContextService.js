const db = require("../database");

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
  return match ? match[1] : null;
}

let globalVersion = 0;

const userContextCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(userId) {
  const cached = userContextCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached;
  }
  return null;
}

function setCached(userId, data) {
  globalVersion++;
  userContextCache.set(userId, {
    data,
    version: globalVersion,
    timestamp: Date.now(),
  });
}

function clearCache(userId) {
  globalVersion++;
  userContextCache.delete(userId);
}

function detectUserMode(context) {
  if (context.totalTracksPlayed === 0 && context.likedTracks.length === 0) {
    return "cold_start";
  }
  if (context.totalTracksPlayed <= 5) {
    return "light_user";
  }
  return "active_user";
}

async function buildUserContext(userId, source = "android") {
  const cached = getCached(userId);
  if (cached) {
    return { ...cached.data, _version: cached.version, _mode: detectUserMode(cached.data) };
  }

  const [recentPlayback, history, likedSongs, topTracks, followedArtists, userStats] = await Promise.all([
    db.getRecentPlayback(userId, 30, source).catch(() => []),
    db.getHistory(userId, 50, source).catch(() => []),
    db.getLikedSongs(userId, 200, source).catch(() => []),
    db.getMostPlayedTracks(userId, 30, source).catch(() => []),
    db.getFollowedArtists(userId, source).catch(() => []),
    db.getUserStats(userId, source).catch(() => null),
  ]);

  const artistCount = {};
  for (const s of likedSongs) {
    const artist = (s.track_author || "").trim();
    if (artist) artistCount[artist] = (artistCount[artist] || 0) + 1;
  }
  for (const t of topTracks) {
    const artist = (t.track_author || "").trim();
    if (artist) artistCount[artist] = (artistCount[artist] || 0) + 1;
  }

  const topArtists = Object.entries(artistCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const genreCount = {};
  for (const s of likedSongs) {
    if (s.genres && Array.isArray(s.genres)) {
      for (const g of s.genres) {
        if (g) genreCount[g] = (genreCount[g] || 0) + 1;
      }
    }
  }

  const topGenres = Object.entries(genreCount)
    .map(([genre, weight]) => ({ genre, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);

  const recentTracks = recentPlayback.map(t => ({
    title: t.track_title,
    artist: t.track_author,
    author: t.track_author,
    uri: t.track_url,
    videoId: extractVideoId(t.track_url),
    artworkUrl: t.artwork_url,
  }));

  const likedTrackList = likedSongs.map(s => ({
    title: s.track_title,
    artist: s.track_author,
    author: s.track_author,
    uri: s.track_url,
    videoId: extractVideoId(s.track_url),
    artworkUrl: s.artwork_url,
    genre: s.genres?.[0] || null,
  }));

  const recentSessions = recentPlayback.slice(0, 10).map(t => ({
    trackId: extractVideoId(t.track_url),
    title: t.track_title,
    artist: t.track_author,
    progress: 0,
  }));

  const raw = {
    userId,
    topArtists,
    topGenres,
    recentTracks,
    likedTracks: likedTrackList,
    recentSessions,
    followedArtists: followedArtists.map(a => ({
      name: a.artist_name || a.artistName,
      id: a.artistId,
    })),
    totalTracksPlayed: userStats?.tracks_played || 0,
    lastPlayed: userStats?.last_played || null,
  };

  setCached(userId, raw);
  const version = globalVersion;
  const mode = detectUserMode(raw);

  return { ...raw, _version: version, _mode: mode };
}

module.exports = {
  buildUserContext,
  clearCache,
};
