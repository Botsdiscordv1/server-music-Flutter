const axios = require("axios");
const ytmusic = require("./innertube");
const deezer = require("./deezer");
const { createFingerprint, upsertMetadataPool, getMetadataPool, getMetadataPoolByISRC } = require("../database");

const LAVALINK_HOST = process.env.LAVALINK_HOST || "localhost";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT) || 2333;
const LAVALINK_SECURE = process.env.LAVALINK_SECURE === "true";
const LAVALINK_PROTO = LAVALINK_SECURE ? "https" : "http";
const LAVALINK_AUTH = process.env.LAVALINK_PASSWORD || "youshallnotpass";

const FAKE_ARTIST_PATTERNS = [
  /\bEutanaa\b/i, /\bIndigo\b/i,
  /\bUnknown\b/i, /\bvarious\s+artists\b/i,
  /^-$/, /^\.$/, /^\s*$/,
];

const HIGH_RES_ARTWORK = /maxresdefault|1000x1000|1500x1500|1080x1080|orig/i;
const LOW_RES_ARTWORK = /hqdefault|mqdefault|sddefault|ytimg/i;

function isFakeArtist(name) {
  if (!name) return true;
  return FAKE_ARTIST_PATTERNS.some(re => re.test(name));
}

function scoreImageQuality(url) {
  if (!url) return 0;
  if (HIGH_RES_ARTWORK.test(url)) return 3;
  if (/500x500|600x600|cx_.*cy_/.test(url)) return 2;
  if (!LOW_RES_ARTWORK.test(url) && url.startsWith("http")) return 1;
  return 0;
}

function normalizeMatch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickBestArtwork(candidates) {
  return candidates.sort((a, b) => scoreImageQuality(b.url || b) - scoreImageQuality(a.url || a))[0] || null;
}

function cleanTitle(title) {
  if (!title) return "";
  return title
    .replace(/\s*\(Official\s+(Audio|Video|Lyric\s+Video|Music\s+Video)\)\s*/gi, "")
    .replace(/\s*\(Audio\)\s*/gi, "")
    .replace(/\s*\(Video\)\s*/gi, "")
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/\s*[\[\(](HD|4K|8K|HQ|Full\s+Audio|Official|Music\s+Video|Lyric\s+Video|Visualizer|Audio\s+Only)[\]\)]\s*/gi, "")
    .replace(/\s*[\[\(]\d+k[\]\)]\s*/gi, "")
    .trim();
}

function extractFeaturedArtists(title, author) {
  const featured = [];
  const feats = title.match(/[\(\[{]feat\.?\s*([^\)\]}]+)[\)\]}]/i);
  if (feats) {
    feats[1].split(/,|&|,/).forEach(f => featured.push(f.trim()));
  }
  const ft = title.match(/\bfeat\.?\s+([A-Za-z0-9\s]+)/i);
  if (ft && !feats) featured.push(ft[1].trim());
  return featured.filter(Boolean);
}

async function searchLavalink(source, query) {
  const url = `${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/loadtracks?identifier=${encodeURIComponent(source + ":" + query)}`;
  const response = await axios.get(url, {
    headers: { Authorization: LAVALINK_AUTH },
    timeout: 15000,
  });
  return (response.data?.data || []).map(t => ({
    id: t.info?.identifier,
    title: t.info?.title || "",
    artist: t.info?.author || "",
    album: t.info?.albumName || t.pluginInfo?.albumName || null,
    albumUrl: t.pluginInfo?.albumUrl || null,
    artworkUrl: t.info?.artworkUrl || null,
    duration: t.info?.duration || 0,
    uri: t.info?.uri || null,
    isrc: t.info?.isrc || t.pluginInfo?.isrc || null,
    explicit: t.info?.explicit === true || t.pluginInfo?.explicit === true,
    ytVideoId: t.info?.identifier || null,
  }));
}

async function enrichExplicitWithDeezerISRC(tracks) {
  const lookups = tracks.filter(t => t.isrc).map(async (track) => {
    try {
      const res = await axios.get(`https://api.deezer.com/track/isrc:${track.isrc}`, { timeout: 3000 });
      if (res.data?.explicit_lyrics !== undefined) track.explicit = res.data.explicit_lyrics;
    } catch (e) {}
  });
  await Promise.allSettled(lookups);
}

function mergeMetadata(sources) {
  const merged = { featuredArtists: [] };
  let bestImageScore = 0;

  for (const src of sources) {
    if (!src) continue;

    if (src.trackTitle && !isFakeArtist(src.trackAuthor)) {
      merged.trackTitle = src.trackTitle;
      merged.trackAuthor = src.trackAuthor;
      merged.confidence = (merged.confidence || 0) + 3;
    } else if (src.trackTitle && !merged.trackTitle) {
      merged.trackTitle = src.trackTitle;
      merged.trackAuthor = src.trackAuthor;
      merged.confidence = (merged.confidence || 0) + 1;
    }

    if (src.album && !merged.albumName) {
      merged.albumName = src.album;
    }

    if (src.albumBrowseId && !merged.albumBrowseId) {
      merged.albumBrowseId = src.albumBrowseId;
    }

    if (src.albumUrl && !merged.albumUrl) {
      merged.albumUrl = src.albumUrl;
    }

    if (src.ytVideoId && !merged.ytVideoId) {
      merged.ytVideoId = src.ytVideoId;
    }

    if (src.albumType && !merged.albumType) {
      merged.albumType = src.albumType;
    }

    if (src.explicit === true) {
      merged.explicit = true;
    } else if (merged.explicit === undefined) {
      merged.explicit = false;
    }

    if (src.genres && src.genres.length > 0 && (!merged.genres || merged.genres.length === 0)) {
      merged.genres = src.genres;
    }

    if (src.artworkUrl) {
      const sourceBoost = src.source === "ytmusic_album" ? 20 : (src.source === "ytmusic" ? 10 : 0);
      const imgScore = scoreImageQuality(src.artworkUrl) + sourceBoost;
      if (imgScore > bestImageScore) {
        merged.artworkUrl = src.artworkUrl;
        bestImageScore = imgScore;
      }
    }

    if (src.featuredArtists && src.featuredArtists.length > 0) {
      merged.featuredArtists = [...new Set([...merged.featuredArtists, ...src.featuredArtists])];
    }
  }

  return merged;
}

async function enrichSingleTrack(artist, title, isrc, options = {}) {
  const fp = createFingerprint(artist, title);
  const forceRefresh = options.forceRefresh === true;

  let existing = null;
  if (!forceRefresh) {
    if (isrc) existing = await getMetadataPoolByISRC(isrc);
    if (!existing) existing = await getMetadataPool(fp);
  }

  if (existing && existing.confidence >= 6 && existing.albumName && existing.albumArtworkUrl) {
    return existing;
  }

  const sources = [];

  let lavalinkTracks = [];
  try {
    lavalinkTracks = await searchLavalink("ytmsearch", `${artist} ${title}`);
  } catch (e) {
    lavalinkTracks = [];
  }
  if (lavalinkTracks.length > 0) {
    const t = lavalinkTracks[0];
    await enrichExplicitWithDeezerISRC([t]);
    sources.push({
      source: "lavalink",
      trackTitle: cleanTitle(t.title),
      trackAuthor: t.artist,
      album: t.album,
      artworkUrl: t.artworkUrl,
      ytVideoId: t.ytVideoId || t.id,
      isrc: t.isrc || isrc,
      explicit: t.explicit,
    });
  }

  const ytmResults = await ytmusic.searchTrack(artist, title);
  if (ytmResults && ytmResults.length > 0) {
    const yt = ytmResults[0];
    sources.push({
      source: "ytmusic",
      trackTitle: cleanTitle(yt.title),
      trackAuthor: yt.artist,
      album: yt.album || null,
      albumType: yt.releaseType || null,
      artworkUrl: yt.thumbnail,
      ytVideoId: yt.videoId,
      duration: yt.duration,
      featuredArtists: yt.authors && yt.authors.length > 1 ? yt.authors.slice(1) : [],
      albumBrowseId: yt.albumBrowseId || null,
      albumUrl: yt.albumUrl || null,
    });

    if (yt.albumBrowseId) {
      try {
        const albumDetails = await ytmusic.getAlbumDetails(yt.albumBrowseId);
        if (albumDetails) {
          sources.push({
            source: "ytmusic_album",
            album: albumDetails.title || yt.album || null,
            trackAuthor: albumDetails.artist || yt.artist,
            albumType: albumDetails.releaseType || null,
            artworkUrl: albumDetails.thumbnail,
            albumUrl: albumDetails.albumUrl,
            albumBrowseId: albumDetails.albumId || yt.albumBrowseId,
            featuredArtists: albumDetails.artists && albumDetails.artists.length > 1 ? albumDetails.artists.slice(1) : [],
          });
        }
      } catch (e) {}
    }
  }

  let isrcToUse = isrc || (lavalinkTracks[0]?.isrc) || null;
  if (isrcToUse) {
    try {
      const deezerResults = await deezer.searchTracks(`${artist} ${title}`, 1);
      if (deezerResults.length > 0) {
        const d = deezerResults[0];
        sources.push({
          source: "deezer",
          trackTitle: d.title,
          trackAuthor: d.artist,
          album: d.album,
          albumType: d.albumType || null,
          artworkUrl: d.thumbnail,
          explicit: d.explicit,
          genres: d.genres,
          isrc: d.isrc || isrcToUse,
        });
      }
    } catch (e) {}
  }

  if (existing) {
    sources.push({
      source: "pool",
      trackTitle: existing.trackTitle,
      trackAuthor: existing.trackAuthor,
      album: existing.albumName,
      albumType: existing.releaseType || null,
      artworkUrl: existing.artworkUrl,
      ytVideoId: existing.ytVideoId,
      explicit: existing.explicit,
      genres: existing.genres,
      featuredArtists: existing.featuredArtists,
    });
  }

  const merged = mergeMetadata(sources);

  let albumArtworkUrl = null;
  if (merged.albumName) {
    try {
      const albumResults = await deezer.searchAlbums(`${artist} ${merged.albumName}`, 5);
      const wantedArtist = normalizeMatch(artist);
      const wantedAlbum = normalizeMatch(merged.albumName);
      const albumMatch = albumResults.find((album) => {
        const albumName = normalizeMatch(album.name);
        const albumArtists = normalizeMatch(album.artists);
        return albumName === wantedAlbum && (!wantedArtist || albumArtists.includes(wantedArtist));
      }) || albumResults[0] || null;

      albumArtworkUrl = albumMatch?.image || null;
    } catch (e) {
      albumArtworkUrl = null;
    }
  }

  const entry = {
    fingerprint: fp,
    isrc: isrcToUse,
    trackTitle: merged.trackTitle || cleanTitle(title),
    trackAuthor: merged.trackAuthor || artist,
    albumName: merged.albumName || null,
    albumType: merged.albumType || null,
    albumBrowseId: merged.albumBrowseId || null,
    albumUrl: merged.albumUrl || null,
    artworkUrl: albumArtworkUrl || merged.artworkUrl || null,
    thumbnailUrl: albumArtworkUrl || merged.artworkUrl || null,
    albumArtworkUrl,
    ytVideoId: merged.ytVideoId || null,
    explicit: merged.explicit || false,
    genres: merged.genres || [],
    featuredArtists: merged.featuredArtists || [],
    confidence: Math.min(merged.confidence || 1, 10),
    lastVerified: new Date(),
  };

  const saved = await upsertMetadataPool(entry);
  return saved || entry;
}

async function enrichTracks(tracks) {
  if (!tracks || !Array.isArray(tracks)) return [];
  return Promise.allSettled(
    tracks.map(async (t) => {
      const artist = t.artist || t.author || t.track_author || "";
      const title = t.title || t.track_title || "";
      const isrc = t.isrc || t.pluginInfo?.isrc || null;
      if (!title && !isrc) return { ...t, _enriched: false };
      const enriched = await enrichSingleTrack(artist, title, isrc, { forceRefresh: t.forceRefresh === true });
      return {
        ...t,
        title: enriched.trackTitle || t.title,
        artist: enriched.trackAuthor || t.artist,
        author: enriched.trackAuthor || t.author,
        artworkUrl: enriched.artworkUrl || t.artworkUrl,
        thumbnail: enriched.artworkUrl || t.thumbnail,
        ytVideoId: enriched.ytVideoId || t.ytVideoId,
        explicit: enriched.explicit !== undefined ? enriched.explicit : t.explicit,
        genres: enriched.genres || t.genres || [],
        featuredArtists: enriched.featuredArtists || [],
        album: enriched.albumName || t.album,
        _enriched: true,
        _confidence: enriched.confidence,
      };
    })
  ).then(results => results.map(r => r.status === "fulfilled" ? r.value : r.reason));
}

module.exports = {
  enrichSingleTrack,
  enrichTracks,
  mergeMetadata,
  cleanTitle,
  isFakeArtist,
  createFingerprint,
};
