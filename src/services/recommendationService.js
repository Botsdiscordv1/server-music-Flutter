const innertube = require("./innertube");
const db = require("../database");
const historyService = require("./historyService");

function cleanThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

function parseTwoRowItem(renderer) {
  const title = renderer?.title?.runs?.map(r => r.text).join("") || "";
  const subtitle = renderer?.subtitle?.runs?.map(r => r.text).join("") || "";
  const thumbnail = renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const artworkUrl = cleanThumbnail(thumbnail);

  const watchEndpoint = renderer?.navigationEndpoint?.watchEndpoint || renderer?.navigationEndpoint?.watchPlaylistEndpoint;
  const videoId = watchEndpoint?.videoId || null;
  const playlistId = watchEndpoint?.playlistId || null;

  const browseEndpoint = renderer?.navigationEndpoint?.browseEndpoint;
  const browseId = browseEndpoint?.browseId || null;
  const isArtist = browseEndpoint?.pageType === "MUSIC_PAGE_TYPE_ARTIST";
  const isAlbum = browseEndpoint?.pageType === "MUSIC_PAGE_TYPE_ALBUM";

  if (!title) return null;

  if (videoId) {
    const runs = renderer?.subtitle?.runs || [];
    const artistName = runs.filter(r => r.navigationEndpoint?.browseEndpoint?.pageType === "MUSIC_PAGE_TYPE_ARTIST").map(r => r.text).join(", ") || subtitle.split("•")[0]?.trim() || "";
    return {
      title,
      artist: artistName,
      author: artistName,
      album: runs.filter(r => r.navigationEndpoint?.browseEndpoint?.pageType === "MUSIC_PAGE_TYPE_ALBUM").map(r => r.text)[0] || null,
      artworkUrl,
      thumbnail: artworkUrl,
      videoId,
      uri: `https://www.youtube.com/watch?v=${videoId}`,
      source: "youtube",
      type: "track",
    };
  } else if (playlistId) {
    return {
      id: playlistId,
      title,
      subtitle,
      artworkUrl,
      type: "playlist",
    };
  } else if (browseId) {
    return {
      id: browseId,
      title,
      subtitle,
      artworkUrl,
      type: isArtist ? "artist" : isAlbum ? "album" : "playlist",
    };
  }

  return null;
}

function mapTitleToType(title) {
  const lower = title.toLowerCase();
  if (lower.includes("listen again") || lower.includes("volver a escuchar") || lower.includes("historial") || lower.includes("reciente")) {
    return "listen_again";
  }
  if (lower.includes("mix") || lower.includes("tienes que oír")) {
    return "your_mix";
  }
  if (lower.includes("quick picks") || lower.includes("selección rápida") || lower.includes("picks")) {
    return "quick_picks";
  }
  if (lower.includes("recommended") || lower.includes("recomendado") || lower.includes("para ti") || lower.includes("for you") || lower.includes("relacionad")) {
    return "recommended";
  }
  if (lower.includes("trending") || lower.includes("tendencias") || lower.includes("popular") || lower.includes("charts") || lower.includes("lista")) {
    return "trending";
  }
  if (lower.includes("new release") || lower.includes("novedades") || lower.includes("lanzamientos") || lower.includes("nuevos") || lower.includes("estreno")) {
    return "new_releases";
  }
  return "recommended"; // Default fallback type
}

async function getTrendingCharts(userId) {
  try {
    const chartsData = await innertube.getCharts(userId);
    if (!chartsData) return [];
    
    const shelves = chartsData?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const shelf of shelves) {
      const renderer = shelf.musicCarouselShelfRenderer || shelf.musicShelfRenderer;
      if (!renderer) continue;

      const title = renderer.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map(r => r.text).join("") ||
                    renderer.title?.runs?.map(r => r.text).join("") || "";

      if (title.toLowerCase().includes("cancion") || title.toLowerCase().includes("song") || title.toLowerCase().includes("video") || title.toLowerCase().includes("popular")) {
        const contents = renderer.contents || [];
        const tracks = [];
        for (const item of contents) {
          if (item.musicResponsiveListItemRenderer) {
            const parsed = innertube.parseMusicItem(item.musicResponsiveListItemRenderer);
            if (parsed) tracks.push(parsed);
          } else if (item.musicTwoRowItemRenderer) {
            const parsed = parseTwoRowItem(item.musicTwoRowItemRenderer);
            if (parsed && parsed.type === "track") tracks.push(parsed);
          }
        }
        if (tracks.length > 0) return tracks;
      }
    }
  } catch (err) {
    console.warn("[RecommendationService] Failed to parse charts:", err.message);
  }
  return [];
}

async function getRecommendations(userId, source = "android") {
  try {
    const homeData = await innertube.getHomeFeed(userId);
    const sections = [];

    if (homeData) {
      const shelves = homeData?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      
      for (const shelf of shelves) {
        const renderer = shelf.musicCarouselShelfRenderer || shelf.musicShelfRenderer;
        if (!renderer) continue;

        const title = renderer.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map(r => r.text).join("") ||
                      renderer.title?.runs?.map(r => r.text).join("") || "";
        
        const type = mapTitleToType(title);
        const contents = renderer.contents || [];
        const items = [];

        for (const content of contents) {
          if (content.musicResponsiveListItemRenderer) {
            const parsed = innertube.parseMusicItem(content.musicResponsiveListItemRenderer);
            if (parsed) items.push(parsed);
          } else if (content.musicTwoRowItemRenderer) {
            const parsed = parseTwoRowItem(content.musicTwoRowItemRenderer);
            if (parsed) items.push(parsed);
          } else if (content.musicNavigationButtonRenderer) {
            continue;
          } else if (content.musicPlaylistShelfRenderer) {
            const subItems = content.musicPlaylistShelfRenderer.contents || [];
            for (const sub of subItems) {
              if (sub.musicResponsiveListItemRenderer) {
                const parsed = innertube.parseMusicItem(sub.musicResponsiveListItemRenderer);
                if (parsed) items.push(parsed);
              }
            }
          } else {
            const keys = Object.keys(content).filter(k => k.endsWith("Renderer"));
            if (keys.length > 0) {
              const fallbackRenderer = content[keys[0]];
              const fallbackTitle = fallbackRenderer?.title?.runs?.[0]?.text ||
                fallbackRenderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.[0]?.text ||
                "";
              if (fallbackTitle) {
                const videoId = fallbackRenderer?.navigationEndpoint?.watchEndpoint?.videoId ||
                  fallbackRenderer?.playlistItemData?.videoId ||
                  null;
                const thumbnail = fallbackRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
                if (videoId) {
                  items.push({
                    videoId,
                    title: fallbackTitle,
                    artist: "",
                    authors: [],
                    album: null,
                    duration: null,
                    artworkUrl: cleanThumbnail(thumbnail),
                    thumbnail: cleanThumbnail(thumbnail),
                    uri: `https://www.youtube.com/watch?v=${videoId}`,
                    source: "youtube",
                    isrc: null,
                    explicit: false,
                  });
                }
              }
            }
          }
        }

        if (items.length > 0) {
          sections.push({
            type,
            title,
            items,
          });
        }
      }
    }

    // Filter out "listen_again" and "your_mix" if we want the aggregator to compile them locally with richer context,
    // but we can keep them if they are returned by InnerTube and we want to present them.
    // However, if the InnerTube homepage did not return anything or lacked trending/charts, let's fill in using fallbacks.

    // Check if we have trending
    let hasTrending = sections.some(s => s.type === "trending");
    if (!hasTrending) {
      const charts = await getTrendingCharts(userId);
      if (charts && charts.length > 0) {
        sections.push({
          type: "trending",
          title: "Tendencias / Éxitos",
          items: charts.slice(0, 15),
        });
      }
    }

    let hasRecs = sections.some(s => s.type === "recommended" || s.type === "quick_picks");
    if (!hasRecs) {
      const likedSongs = await db.getLikedSongs(userId, 5, source).catch(() => []);
      if (likedSongs.length > 0) {
        const seed = likedSongs[Math.floor(Math.random() * likedSongs.length)];
        const match = seed.track_url?.match(/[?&]v=([^&#]+)/) || seed.track_url?.match(/youtu\.be\/([^&#]+)/);
        if (match) {
          const radioQueue = await innertube.getRadioQueue(match[1], userId);
          if (radioQueue) {
            const tracks = innertube.parsePlaylistPanel(radioQueue);
            sections.push({
              type: "recommended",
              title: "Recomendado para ti",
              items: tracks.slice(0, 15),
            });
          }
        }
      }
      
      if (!sections.some(s => s.type === "recommended" || s.type === "quick_picks")) {
        const defaultTracks = await innertube.searchQuery("exitos del momento", "song", userId);
        sections.push({
          type: "recommended",
          title: "Recomendado para ti",
          items: defaultTracks.slice(0, 15),
        });
      }
    }

    return sections;
  } catch (err) {
    console.error(`[RecommendationService] getRecommendations error for ${userId}:`, err.message);
    try {
      const defaultTracks = await innertube.searchQuery("top peru", "song", userId);
      return [
        {
          type: "recommended",
          title: "Recomendado para ti",
          items: defaultTracks.slice(0, 15),
        }
      ];
    } catch {
      return [];
    }
  }
}

module.exports = {
  getRecommendations,
  getTrendingCharts,
};
