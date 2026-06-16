const db = require("../database");

function getTrackKey(track) {
  const url = track.track_url || track.trackUrl || "";
  if (url) {
    const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
    if (match) return match[1];
    return url;
  }
  const author = (track.track_author || track.trackAuthor || "").toLowerCase().trim();
  const title = (track.track_title || track.trackTitle || "").toLowerCase().trim();
  return `${author} - ${title}`;
}

function mapDbTrackToStandard(t) {
  const url = t.track_url || t.trackUrl || "";
  let videoId = null;
  if (url) {
    const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
    videoId = match ? match[1] : null;
  }
  
  return {
    title: t.track_title || t.trackTitle || "",
    artist: t.track_author || t.trackAuthor || "",
    author: t.track_author || t.trackAuthor || "",
    album: t.album || null,
    duration: t.track_duration || t.trackDuration || null,
    uri: url,
    artworkUrl: t.artwork_url || t.artworkUrl || null,
    thumbnail: t.artwork_url || t.artworkUrl || null,
    videoId: videoId,
    source: t.source || "youtube",
    isrc: t.isrc || null,
    explicit: t.explicit === true,
  };
}

async function getListenAgain(userId, source = "android") {
  try {
    const [recentPlayback, history] = await Promise.all([
      db.getRecentPlayback(userId, 100, source).catch(() => []),
      db.getHistory(userId, 100, source).catch(() => []),
    ]);

    const combined = [...recentPlayback, ...history];
    if (combined.length === 0) {
      return [];
    }

    const frequencyMap = {};
    const trackMap = {};
    const lastPlayedMap = {};

    for (const track of combined) {
      const key = getTrackKey(track);
      if (!key) continue;

      frequencyMap[key] = (frequencyMap[key] || 0) + 1;
      
      const playedAt = track.played_at || track.playedAt || new Date(0);
      if (!lastPlayedMap[key] || playedAt > lastPlayedMap[key]) {
        lastPlayedMap[key] = playedAt;
      }

      // Keep the track details, prioritizing the one with artworkUrl/duration if available
      const existing = trackMap[key];
      const hasArtwork = track.artwork_url || track.artworkUrl;
      const hasDuration = track.track_duration || track.trackDuration;

      if (!existing || (hasArtwork && !existing.artwork_url && !existing.artworkUrl) || (hasDuration && !existing.track_duration && !existing.trackDuration)) {
        trackMap[key] = track;
      }
    }

    const uniqueKeys = Object.keys(frequencyMap);
    const rankedTracks = uniqueKeys.map(key => {
      return {
        key,
        track: trackMap[key],
        frequency: frequencyMap[key],
        lastPlayed: lastPlayedMap[key],
      };
    });

    // Sort by play count descending, and secondarily by last played time descending
    rankedTracks.sort((a, b) => {
      if (b.frequency !== a.frequency) {
        return b.frequency - a.frequency;
      }
      return b.lastPlayed - a.lastPlayed;
    });

    // Limit to top 20 for Listen Again section, mapping to standard track shapes
    return rankedTracks.slice(0, 20).map(item => mapDbTrackToStandard(item.track));
  } catch (err) {
    console.error(`[HistoryService] getListenAgain error for ${userId}:`, err.message);
    return [];
  }
}

module.exports = {
  getListenAgain,
  mapDbTrackToStandard,
};
