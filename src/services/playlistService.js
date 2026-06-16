const db = require("../database");

async function getPlaylists(userId, source = "android") {
  try {
    const rawPlaylists = await db.getUserPlaylists(userId, source).catch(() => []);
    
    return rawPlaylists.map(p => {
      let tracks = [];
      try {
        tracks = typeof p.tracks === "string" ? JSON.parse(p.tracks) : (p.tracks || []);
      } catch (e) {
        tracks = [];
      }

      return {
        id: p.id,
        title: p.name,
        trackCount: tracks.length,
        artworkUrl: tracks[0]?.artworkUrl || tracks[0]?.artwork_url || null,
        type: "playlist",
        tracks: tracks,
      };
    });
  } catch (err) {
    console.error(`[PlaylistService] getPlaylists error for ${userId}:`, err.message);
    return [];
  }
}

module.exports = {
  getPlaylists,
};
