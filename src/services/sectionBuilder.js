const db = require("../database");
const innertube = require("./innertube");
const historyService = require("./historyService");
const playlistService = require("./playlistService");
const recommendationEngine = require("./recommendationEngine");

function extractVideoId(url) {
  if (!url) return null;
  const match = url.match(/[?&]v=([^&#]+)/) || url.match(/youtu\.be\/([^&#]+)/);
  return match ? match[1] : null;
}

async function buildContinueListening(userId, source) {
  const recent = await db.getRecentPlayback(userId, 10, source).catch(() => []);
  if (!recent || recent.length === 0) return null;

  return {
    id: "section_continue_listening",
    type: "continue_listening",
    title: "Seguir escuchando",
    items: recent.slice(0, 6).map(t => ({
      ...historyService.mapDbTrackToStandard(t),
      progress: 0,
    })),
  };
}

async function buildQuickPicks(userId, source, context) {
  const liked = await db.getLikedSongs(userId, 50, source).catch(() => []);
  let tracks = [];

  if (liked.length > 0) {
    const standard = liked.map(historyService.mapDbTrackToStandard);
    tracks = recommendationEngine.rankTracks(standard, context).slice(0, 15);
  }

  if (tracks.length === 0) {
    const hist = await db.getRecentPlayback(userId, 20, source).catch(() => []);
    if (hist.length > 0) {
      tracks = hist.map(historyService.mapDbTrackToStandard).slice(0, 10);
    } else {
      const defaultTracks = await innertube.searchQuery("exitos", "song", userId).catch(() => []);
      tracks = (defaultTracks || []).slice(0, 10);
    }
  }

  if (tracks.length === 0) return null;

  return {
    id: "section_quick_picks",
    type: "quick_picks",
    title: "Hecho para ti",
    items: tracks,
  };
}

async function buildBasedOnArtist(userId, source, context) {
  const artists = context.topArtists
    .filter(a => a.name && a.name.toLowerCase() !== "various artists")
    .slice(0, 2);

  if (artists.length === 0) return [];

  const sections = [];
  for (const artist of artists) {
    try {
      const tracks = await innertube.searchQuery(artist.name, "song", userId);
      const filtered = (tracks || []).filter(t => {
        const ta = (t.author || t.artist || "").toLowerCase();
        const an = artist.name.toLowerCase();
        return ta.includes(an) || an.includes(ta);
      });
      if (filtered.length >= 3) {
        sections.push({
          id: `section_based_on_${artist.name.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
          type: "based_on_artist",
          title: `Porque escuchas ${artist.name}`,
          items: filtered.slice(0, 15),
        });
      }
    } catch (err) {
      console.warn(`[SectionBuilder] based_on_artist failed for ${artist.name}:`, err.message);
    }
  }

  return sections;
}

async function buildUserPlaylists(userId, source) {
  const playlists = await playlistService.getPlaylists(userId, source).catch(() => []);
  if (!playlists || playlists.length === 0) return null;

  return {
    id: "section_user_playlists",
    type: "user_playlists",
    title: "Tus playlists",
    items: playlists,
  };
}

async function buildDiscoveryMix(userId, source, context) {
  let tracks = [];

  if (context.likedTracks.length > 0) {
    const seed = context.likedTracks[Math.floor(Math.random() * Math.min(5, context.likedTracks.length))];
    const vid = seed.videoId || extractVideoId(seed.uri || "");
    if (vid) {
      const radioQueue = await innertube.getRadioQueue(vid, userId).catch(() => null);
      if (radioQueue) {
        const parsed = innertube.parsePlaylistPanel(radioQueue) || [];
        const likedKeys = new Set(context.likedTracks.map(t => t.videoId).filter(Boolean));
        tracks = parsed.filter(t => !likedKeys.has(t.videoId));
      }
    }
  }

  if (tracks.length < 5) {
    const defaultTracks = await innertube.searchQuery("música nueva", "song", userId).catch(() => []);
    tracks = [...tracks, ...(defaultTracks || [])];
  }

  if (tracks.length === 0) return null;

  return {
    id: "section_discovery_mix",
    type: "discovery_mix",
    title: "Descubrimientos",
    items: tracks.slice(0, 15),
  };
}

async function buildListenAgain(userId, source) {
  const tracks = await historyService.getListenAgain(userId, source).catch(() => []);
  if (!tracks || tracks.length === 0) return null;

  return {
    id: "section_listen_again",
    type: "listen_again",
    title: "Escuchar de nuevo",
    items: tracks.slice(0, 15),
  };
}

async function buildTrending(userId, source, context) {
  let sections = context?._cachedRecommendations;
  if (!sections) {
    const recommendationService = require("./recommendationService");
    sections = await recommendationService.getRecommendations(userId, source).catch(() => []);
  }
  const trending = sections.find(s => s.type === "trending");
  if (!trending || !trending.items || trending.items.length === 0) return null;

  return {
    id: "section_trending",
    type: "trending",
    title: "Tendencias y éxitos",
    items: trending.items.slice(0, 15),
  };
}

async function buildNewReleases(userId, source, context) {
  let sections = context?._cachedRecommendations;
  if (!sections) {
    const recommendationService = require("./recommendationService");
    sections = await recommendationService.getRecommendations(userId, source).catch(() => []);
  }
  const nr = sections.find(s => s.type === "new_releases");
  if (!nr || !nr.items || nr.items.length === 0) return null;

  return {
    id: "section_new_releases",
    type: "new_releases",
    title: "Nuevos lanzamientos",
    items: nr.items.slice(0, 15),
  };
}

module.exports = {
  buildContinueListening,
  buildQuickPicks,
  buildBasedOnArtist,
  buildUserPlaylists,
  buildDiscoveryMix,
  buildListenAgain,
  buildTrending,
  buildNewReleases,
};
