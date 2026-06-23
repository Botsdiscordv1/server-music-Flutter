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
      browseId,
      albumId: isAlbum ? browseId : null,
      albumBrowseId: isAlbum ? browseId : null,
      albumUrl: isAlbum ? `https://music.youtube.com/browse/${browseId}` : null,
      url: isAlbum ? `https://music.youtube.com/browse/${browseId}` : null,
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
                    albumId: null,
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

function extractHomeContinuation(data) {
  return data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.continuations?.[0]?.nextContinuationData?.continuation
    || data?.continuationContents?.sectionListContinuation?.continuations?.[0]?.nextContinuationData?.continuation
    || null;
}

function parseHomeShelfTitle(renderer) {
  return renderer?.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map(r => r.text).join("")
    || renderer?.header?.musicCarouselShelfHeaderRenderer?.title?.runs?.map(r => r.text).join("")
    || renderer?.header?.musicResponsiveHeaderRenderer?.title?.runs?.map(r => r.text).join("")
    || renderer?.title?.runs?.map(r => r.text).join("")
    || renderer?.title?.simpleText
  || "";
}

function parseHomeChips(data) {
  const chips = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.header?.chipCloudRenderer?.chips || [];
  return chips.map((chip) => {
    const renderer = chip?.chipCloudChipRenderer;
    const title = renderer?.text?.runs?.map(r => r.text).join("") || renderer?.text?.simpleText || "";
    const browseEndpoint = renderer?.navigationEndpoint?.browseEndpoint || null;
    const deselectEndpoint = renderer?.onDeselectedCommand?.browseEndpoint || null;
    return title ? {
      title,
      browseId: browseEndpoint?.browseId || null,
      params: browseEndpoint?.params || null,
      deselectBrowseId: deselectEndpoint?.browseId || null,
      deselectParams: deselectEndpoint?.params || null,
      selected: renderer?.isSelected === true,
    } : null;
  }).filter(Boolean);
}

function inferHomeSectionType(title) {
  const t = String(title || "").toLowerCase();
  if (t.includes("quick") || t.includes("acceso rápido")) return "quick_picks";
  if (t.includes("escuchar") || t.includes("listen again") || t.includes("listen")) return "listen_again";
  if (t.includes("radio")) return "personalized_radios";
  if (t.includes("mix") || t.includes("mezcla")) return "your_mixes";
  if (t.includes("video")) return "videos";
  if (t.includes("comunidad") || t.includes("community")) return "community_playlists";
  if (t.includes("recomendado") || t.includes("recomendaci") || t.includes("para ti") || t.includes("based on") || t.includes("similar")) return "recommended";
  if (t.includes("nuevo") || t.includes("lanzamiento") || t.includes("new release") || t.includes("release")) return "new_releases";
  if (t.includes("tendencia") || t.includes("trending") || t.includes("éxitos") || t.includes("popular")) return "trending";
  if (t.includes("artista") && t.includes("favorito")) return "favorite_artists";
  if (t.includes("album") || t.includes("álbum")) return "recommended_albums";
  if (t.includes("playlist")) return "recommended_playlists";
  return "unknown";
}

function parseTwoRowHomeItem(item) {
  const renderer = item?.musicTwoRowItemRenderer;
  if (!renderer) return null;
  const title = renderer?.title?.runs?.map(r => r.text).join("") || renderer?.title?.simpleText || "";
  const subtitle = renderer?.subtitle?.runs?.map(r => r.text).join("") || renderer?.subtitle?.simpleText || "";
  const nav = renderer?.navigationEndpoint || {};
  const browseId = nav?.browseEndpoint?.browseId || null;
  const videoId = nav?.watchEndpoint?.videoId || nav?.watchPlaylistEndpoint?.playlistId || null;
  const playlistId = nav?.watchEndpoint?.playlistId || nav?.watchPlaylistEndpoint?.playlistId || null;
  const thumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || renderer?.thumbnail?.thumbnails || [];
  const artworkUrl = thumbnails.length ? thumbnails[thumbnails.length - 1]?.url : null;

  if (!title && !browseId && !videoId && !playlistId) return null;

  if ((nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_ALBUM") || (browseId && playlistId)) {
    return {
      id: browseId,
      type: "album",
      title,
      name: title,
      artist: subtitle,
      album: subtitle,
      browseId,
      albumBrowseId: browseId,
      albumUrl: browseId ? `https://music.youtube.com/browse/${browseId}` : null,
      artworkUrl,
      imageUrl: artworkUrl,
    };
  }

  if (playlistId || String(browseId || "").startsWith("VL") || String(browseId || "").startsWith("PL") || String(browseId || "").startsWith("RD")) {
    const id = playlistId || browseId;
    return {
      id,
      type: "playlist",
      title,
      name: title,
      author: subtitle,
      subtitle,
      playlistId: id,
      browseId,
      artworkUrl,
      imageUrl: artworkUrl,
    };
  }

  if (browseId && nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === "MUSIC_PAGE_TYPE_ARTIST") {
    return {
      id: browseId,
      type: "artist",
      title,
      name: title,
      artist: title,
      browseId,
      artworkUrl,
      imageUrl: artworkUrl,
    };
  }

  return {
    id: videoId || browseId || title,
    type: "track",
    title,
    name: title,
    artist: subtitle,
    author: subtitle,
    videoId,
    browseId,
    artworkUrl,
    imageUrl: artworkUrl,
    uri: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
    source: "youtube",
  };
}

function parseHomeShelfItems(renderer) {
  const items = renderer?.contents || renderer?.items || [];
  const parsed = [];

  for (const item of items) {
    const musicItem = item?.musicResponsiveListItemRenderer;
    if (musicItem) {
      const parsedItem = innertube.parseMusicItem(musicItem);
      if (parsedItem) parsed.push({ ...parsedItem, type: "track" });
      continue;
    }

    const twoRow = item?.musicTwoRowItemRenderer;
    if (twoRow) {
      const parsedItem = parseTwoRowHomeItem(item);
      if (parsedItem) parsed.push(parsedItem);
      continue;
    }

    const card = item?.musicCardRenderer;
    if (card) {
      const title = card?.title?.runs?.map(r => r.text).join("") || card?.title?.simpleText || "";
      const subtitle = card?.subtitle?.runs?.map(r => r.text).join("") || card?.subtitle?.simpleText || "";
      const nav = card?.navigationEndpoint || {};
      const browseId = nav?.browseEndpoint?.browseId || null;
      const videoId = nav?.watchEndpoint?.videoId || nav?.watchPlaylistEndpoint?.playlistId || null;
      const thumbnails = card?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || card?.thumbnail?.thumbnails || [];
      const artworkUrl = thumbnails.length ? thumbnails[thumbnails.length - 1]?.url : null;
      if (title) {
        parsed.push({
          id: videoId || browseId || title,
          type: browseId?.startsWith("PL") || browseId?.startsWith("VL") || browseId?.startsWith("RD") ? "playlist" : (browseId ? "track" : "track"),
          title,
          name: title,
          artist: subtitle,
          author: subtitle,
          videoId,
          browseId,
          playlistId: nav?.watchEndpoint?.playlistId || nav?.watchPlaylistEndpoint?.playlistId || null,
          artworkUrl,
          imageUrl: artworkUrl,
          uri: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
          source: "youtube",
        });
      }
      continue;
    }

    const playlistShelf = item?.musicPlaylistShelfRenderer;
    if (playlistShelf) {
      for (const sub of playlistShelf.contents || []) {
        const parsedItem = sub?.musicResponsiveListItemRenderer ? innertube.parseMusicItem(sub.musicResponsiveListItemRenderer) : null;
        if (parsedItem) parsed.push({ ...parsedItem, type: "track" });
      }
    }
  }

  return parsed;
}

function parseHomeSectionsFromData(data) {
  const sections = [];
  const containers = [];

  const initial = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents;
  if (Array.isArray(initial)) containers.push(...initial);

  const continuation = data?.continuationContents?.sectionListContinuation?.contents;
  if (Array.isArray(continuation)) containers.push(...continuation);

  for (const sectionData of containers) {
    const renderer = sectionData?.musicCarouselShelfRenderer
      || sectionData?.musicImmersiveCarouselShelfRenderer
      || sectionData?.musicShelfRenderer
      || sectionData?.musicCardShelfRenderer
      || sectionData?.musicGridRenderer
      || sectionData?.gridRenderer;

    if (!renderer) continue;

    const title = parseHomeShelfTitle(renderer);
    if (!title) continue;

    const items = parseHomeShelfItems(renderer);
    if (!items.length) continue;

    sections.push({
      id: sectionData?.id?.toString() || renderer?.id?.toString() || title,
      type: inferHomeSectionType(title),
      title,
      items,
    });
  }

  return { sections, continuation: extractHomeContinuation(data) };
}

async function getRawHomeSections(userId, params = null, maxPages = 4) {
  const allSections = [];
  const seen = new Set();
  let chips = [];

  let data = await innertube.getHomeFeed(userId, params);
  let continuation = null;

  for (let page = 0; page < maxPages && data; page++) {
    if (!chips.length) chips = parseHomeChips(data);
    const parsed = parseHomeSectionsFromData(data);
    for (const section of parsed.sections) {
      const key = section.id && section.id !== section.title
        ? `${section.id}`.toLowerCase()
        : `${page}:${section.title}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      section.order = allSections.length + 1;
      allSections.push(section);
    }

    continuation = parsed.continuation;
    if (!continuation) break;

    try {
      data = await innertube.apiRequest("browse", { continuation }, {}, userId, false, "WEB_REMIX");
    } catch (err) {
      console.warn(`[RecommendationService] home continuation failed for ${userId}: ${err.message}`);
      break;
    }
  }

  return { sections: allSections, chips, continuation };
}

module.exports = {
  getRecommendations,
  getTrendingCharts,
  getRawHomeSections,
};
