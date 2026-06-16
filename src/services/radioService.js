const db = require("../database");
const innertube = require("./innertube");
const historyService = require("./historyService");

// Default popular seeds (Latin/Global Pop) for fallback when the database has no user data
const DEFAULT_SEEDS = [
  "dQw4w9WgXcQ", // Rick Astley
  "kJQP7kiw5Fk", // Luis Fonsi - Despacito
  "9bZkp7q19f0", // PSY - GANGNAM STYLE
  "OPf0YbXqDm0", // Mark Ronson - Uptown Funk
  "09R8_2nJtjg", // Maroon 5 - Sugar
];

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
  return match ? match[1] : null;
}

async function getMixes(userId, source = "android") {
  try {
    const [likedSongs, recentPlayback] = await Promise.all([
      db.getLikedSongs(userId, 50, source).catch(() => []),
      db.getRecentPlayback(userId, 50, source).catch(() => []),
    ]);

    // Extract seed video IDs from user data
    const likedSeeds = likedSongs.map(s => extractVideoId(s.track_url)).filter(Boolean);
    const recentSeeds = recentPlayback.map(s => extractVideoId(s.track_url)).filter(Boolean);
    const allSeeds = [...new Set([...likedSeeds, ...recentSeeds])];

    const mixes = [];

    // 1. Mix de Favoritos (Your Favorites Mix)
    let favTracks = [];
    if (allSeeds.length > 0) {
      // Pick a random seed from all seeds
      const seed = allSeeds[Math.floor(Math.random() * allSeeds.length)];
      const radioQueue = await innertube.getRadioQueue(seed, userId);
      if (radioQueue) {
        favTracks = innertube.parsePlaylistPanel(radioQueue);
      }
    }
    if (favTracks.length === 0) {
      if (likedSongs.length > 0) {
        favTracks = likedSongs.slice(0, 15).map(historyService.mapDbTrackToStandard);
      } else {
        const seed = DEFAULT_SEEDS[0];
        const radioQueue = await innertube.getRadioQueue(seed, userId);
        if (radioQueue) {
          favTracks = innertube.parsePlaylistPanel(radioQueue);
        }
      }
    }

    mixes.push({
      id: "my_mix_favorites",
      title: "Radio de Favoritos",
      subtitle: "Tus canciones favoritas y recomendaciones similares",
      artworkUrl: favTracks[0]?.artworkUrl || null,
      type: "radio",
      tracks: favTracks,
    });

    let discoveryTracks = [];
    if (allSeeds.length > 0) {
      const seed = allSeeds[allSeeds.length - 1];
      const radioQueue = await innertube.getRadioQueue(seed, userId);
      if (radioQueue) {
        const parsed = innertube.parsePlaylistPanel(radioQueue);
        const likedUrls = new Set(likedSongs.map(s => s.track_url).filter(Boolean));
        discoveryTracks = parsed.filter(t => !likedUrls.has(t.uri));
      }
    }
    if (discoveryTracks.length < 5) {
      const seed = DEFAULT_SEEDS[1];
      const radioQueue = await innertube.getRadioQueue(seed, userId);
      if (radioQueue) {
        const parsed = innertube.parsePlaylistPanel(radioQueue);
        const likedUrls = new Set(likedSongs.map(s => s.track_url).filter(Boolean));
        discoveryTracks = [...discoveryTracks, ...parsed.filter(t => !likedUrls.has(t.uri))];
      }
    }

    mixes.push({
      id: "my_mix_discovery",
      title: "Radio de Descubrimiento",
      subtitle: "Nuevas canciones y artistas que te podrían gustar",
      artworkUrl: discoveryTracks[0]?.artworkUrl || null,
      type: "radio",
      tracks: discoveryTracks.slice(0, 15),
    });

    let energyTracks = [];
    const energySeed = DEFAULT_SEEDS[2];
    const energyQueue = await innertube.getRadioQueue(energySeed, userId);
    if (energyQueue) {
      energyTracks = innertube.parsePlaylistPanel(energyQueue);
    }
    mixes.push({
      id: "my_mix_energy",
      title: "Radio de Energía",
      subtitle: "Música para entrenar o activarte",
      artworkUrl: energyTracks[0]?.artworkUrl || null,
      type: "radio",
      tracks: energyTracks.slice(0, 15),
    });

    let chillTracks = [];
    const chillSeed = DEFAULT_SEEDS[3];
    const chillQueue = await innertube.getRadioQueue(chillSeed, userId);
    if (chillQueue) {
      chillTracks = innertube.parsePlaylistPanel(chillQueue);
    }
    mixes.push({
      id: "my_mix_chill",
      title: "Radio Chill",
      subtitle: "Canciones tranquilas para relajarte",
      artworkUrl: chillTracks[0]?.artworkUrl || null,
      type: "radio",
      tracks: chillTracks.slice(0, 15),
    });

    return mixes;
  } catch (err) {
    console.error(`[RadioService] getMixes error for ${userId}:`, err.message);
    return [];
  }
}

module.exports = {
  getMixes,
};
