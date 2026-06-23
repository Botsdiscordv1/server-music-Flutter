const axios = require("axios");

const LAVALINK_HOST = process.env.LAVALINK_HOST || "localhost";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT) || 2333;
const LAVALINK_SECURE = process.env.LAVALINK_SECURE === "true";
const LAVALINK_PROTO = LAVALINK_SECURE ? "https" : "http";
const LAVALINK_AUTH = process.env.LAVALINK_PASSWORD || "youshallnotpass";

// ── Spotify Web API direct (OAuth Client Credentials) ─────────────
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
let spotifyToken = null;
let spotifyTokenExpiry = 0;
let spotifyDown = false;
let spotifyDownChecked = 0;
let spotifyDisabled = false;
const SPOTIFY_RETRY_AFTER = 5 * 60 * 1000; // 5 min antes de reintentar

async function getSpotifyToken() {
  if (spotifyDisabled && Date.now() - spotifyDownChecked < SPOTIFY_RETRY_AFTER) return null;
  spotifyDisabled = false;
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  try {
    const res = await axios.post("https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      {
        headers: {
          "Authorization": "Basic " + Buffer.from(SPOTIFY_CLIENT_ID + ":" + SPOTIFY_CLIENT_SECRET).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );
    spotifyToken = res.data.access_token;
    spotifyTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return spotifyToken;
  } catch (err) {
    if (err.response?.status === 403) {
      console.warn("[Spotify API] 403 Forbidden on token retrieval. Will retry after 5 min.");
      spotifyDisabled = true;
      spotifyDownChecked = Date.now();
    } else {
      console.error("[Spotify API] Token error:", err.message);
    }
    return null;
  }
}

async function spotifyFetch(endpoint) {
  if (spotifyDisabled) throw new Error("Spotify API integration is disabled.");
  const token = await getSpotifyToken();
  if (!token) throw new Error("No Spotify token available.");
  
  try {
    const res = await axios.get(`https://api.spotify.com/v1${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 403) {
      console.warn("[Spotify API] 403 Forbidden on fetch request. Disabling Spotify API client integration.");
      spotifyDisabled = true;
    }
    throw err;
  }
}

async function searchArtistsDirect(query, limit = 5) {
  if (spotifyDown && Date.now() - spotifyDownChecked < SPOTIFY_RETRY_AFTER) return [];
  try {
    const data = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=artist&limit=${Math.min(limit, 50)}`);
    spotifyDown = false; // si llegó acá es porque Spotify respondió bien
    return (data.artists?.items || []).map(a => ({
      id: a.id,
      name: a.name,
      image: a.images?.[0]?.url || null,
      genres: a.genres || [],
      popularity: a.popularity,
      followers: a.followers?.total || 0,
      uri: a.uri,
      externalUrl: a.external_urls?.spotify || null,
    }));
  } catch (err) {
    spotifyDown = true;
    spotifyDownChecked = Date.now();
    console.error("[Spotify API] Error:", err.message);
    return [];
  }
}

async function getArtistInfo(artistId) {
  const a = await spotifyFetch(`/artists/${artistId}`);
  return {
    id: a.id,
    name: a.name,
    images: a.images || [],
    genres: a.genres || [],
    popularity: a.popularity,
    followers: a.followers?.total || 0,
    uri: a.uri,
    externalUrl: a.external_urls?.spotify || null,
  };
}

async function getArtistDescription(name) {
  if (!name) return null;
  // 1) English Wikipedia
  const wikiEn = await tryWikipediaDescription(name, "en");
  if (wikiEn) return wikiEn;
  // 2) Spanish Wikipedia (importante para artistas latinos como 3 AM)
  const wikiEs = await tryWikipediaDescription(name, "es");
  if (wikiEs) return wikiEs;

  // 3) Fallback: DuckDuckGo Instant Answer API
  try {
    const ddg = await axios.get("https://api.duckduckgo.com/", {
      params: { q: name + " music", format: "json", no_html: 1, skip_disambig: 1 },
      timeout: 5000,
    });
    const data = ddg.data;
    if (data.Abstract) {
      return { description: data.Abstract, source: "duckduckgo", url: data.AbstractURL || null };
    }
  } catch {}

  return null;
}

async function tryWikipediaDescription(name, lang = "en") {
  const baseUrl = `https://${lang}.wikipedia.org`;
  // 1) Direct summary lookup
  try {
    const res = await axios.get(`${baseUrl}/api/rest_v1/page/summary/${encodeURIComponent(name)}`, {
      timeout: 6000,
      headers: { "User-Agent": "ServerMusic/2.0" },
    });
    if (res.data && res.data.extract && res.data.type !== "disambiguation") {
      return {
        description: res.data.extract,
        source: `wikipedia(${lang})`,
        url: res.data.content_urls?.desktop?.page || null,
      };
    }
  } catch {}
  // 2) Fallback: search Wikipedia for up to 5 results, skip disambiguation
  try {
    const searchRes = await axios.get(`${baseUrl}/w/api.php`, {
      params: {
        action: "query", list: "search",
        srsearch: `${name} musician`,
        format: "json", srlimit: 5,
      },
      timeout: 6000,
    });
    const pages = searchRes.data?.query?.search || [];
    for (const page of pages) {
      try {
        const res2 = await axios.get(`${baseUrl}/api/rest_v1/page/summary/${encodeURIComponent(page.title)}`, {
          timeout: 6000,
          headers: { "User-Agent": "ServerMusic/2.0" },
        });
        if (res2.data?.extract && res2.data.type !== "disambiguation") {
          return {
            description: res2.data.extract,
            source: `wikipedia(${lang})`,
            url: res2.data.content_urls?.desktop?.page || null,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function searchArtistDeezer(name) {
  if (!name) return null;
  const cleanName = cleanArtistName(name);
  if (!cleanName) return null;

  const queries = [cleanName];
  if (cleanName !== name) queries.push(name);

  for (const q of queries) {
    try {
      const res = await axios.get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(q)}&limit=10`, { timeout: 5000 });
      const candidates = (res.data?.data || []).map(a => ({
        id: String(a.id),
        name: a.name,
        image: a.picture_medium || null,
        imageBig: a.picture_big || null,
        imageXl: a.picture_xl || null,
        fans: a.nb_fan || 0,
        albums: a.nb_album || 0,
        tracklist: a.tracklist || null,
      }));

      // Encontrar mejor candidato por similitud Jaccard (evita falsos positivos)
      const nameLower = cleanName.toLowerCase();
      let best = null;
      let bestScore = 0;
      for (const a of candidates) {
        const score = artistNameSimilar(a.name, nameLower);
        if (score > bestScore || (score === bestScore && a.fans > (best?.fans || 0))) {
          best = a;
          bestScore = score;
        }
      }
      // Aceptar si Jaccard >= 0.3, o si >= 0.15 y tiene más fans que cualquier otro sin solapamiento
      let artist = (best && bestScore >= 0.25) ? best : null;
      // Si no hay match bueno, probar contains solo si el nombre es lo suficientemente distintivo
      if (!artist && nameLower.length >= 5) {
        for (const a of candidates) {
          if (a.name.toLowerCase().includes(nameLower) || nameLower.includes(a.name.toLowerCase())) {
            if (!artist || a.fans > artist.fans) artist = a;
          }
        }
      }

      if (artist) {
        if (!artist.image) {
          const img = await searchArtistImageAll(cleanName);
          if (img) {
            artist.image = img;
            artist.imageBig = img;
          }
        }
        console.log(`[searchArtistDeezer] "${q}" → match:"${artist.name}" img:${artist.image ? "✓" : "✗"} fans:${artist.fans}`);
        return artist;
      }
    } catch {}
  }

  // Fallback total: probar todas las fuentes de imagen
  const image = await searchArtistImageAll(cleanName);
  if (image) {
    return { id: null, name: cleanName, image, imageBig: image, imageXl: image, fans: 0, albums: 0, tracklist: null };
  }
  return null;
}

async function searchArtistImageSpotify(name) {
  if (!name) return null;
  try {
    const spotifyArtists = await searchArtistsDirect(name, 5);
    const nameLower = name.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const a of spotifyArtists) {
      const score = artistNameSimilar(a.name, nameLower);
      if (score > bestScore || (score === bestScore && a.followers > (best?.followers || 0))) {
        best = a;
        bestScore = score;
      }
    }
    return (best && bestScore >= 0.25) ? best.image : null;
  } catch {
    return null;
  }
}

async function searchArtistImageDeezerTrack(name) {
  if (!name) return null;
  try {
    const res = await axios.get(`https://api.deezer.com/search/track?q=artist:"${encodeURIComponent(name)}"&limit=3`, { timeout: 5000 });
    const track = res.data?.data?.[0];
    return track?.artist?.picture_medium || null;
  } catch {
    return null;
  }
}

async function searchArtistImageApple(name) {
  if (!name) return null;
  try {
    const res = await axios.get(`https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=5`, { timeout: 5000 });
    const candidates = res.data?.results || [];
    const nameLower = name.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const a of candidates) {
      const score = artistNameSimilar(a.artistName || "", nameLower);
      if (score > bestScore || (score === bestScore && (a.artistId || 0) > (best?.artistId || 0))) {
        best = a;
        bestScore = score;
      }
    }
    return (best && bestScore >= 0.25) ? best.artworkUrl100?.replace("100x100bb", "400x400bb") : null;
  } catch {
    return null;
  }
}

async function searchArtistImageAll(name) {
  if (!name) return null;
  const results = await Promise.allSettled([
    searchArtistImageSpotify(name),
    searchArtistImageDeezerTrack(name),
    searchArtistImageApple(name),
    searchArtistImageYTM(name),
  ]);
  for (const r of results) {
    if (r.status === "fulfilled" && r.value) return r.value;
  }
  return null;
}

async function searchArtistImageYTM(name) {
  if (!name) return null;
  const nameLower = name.toLowerCase();

  const queries = [
    `ytmsearch:${name} artist`,
    `ytmsearch:${name} topic`,
    `ytmsearch:${name}`,
  ];

  for (const query of queries) {
    try {
      const url = `${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/loadtracks?identifier=${encodeURIComponent(query)}`;
      const response = await axios.get(url, {
        headers: { Authorization: LAVALINK_AUTH },
        timeout: 10000,
      });
      const tracks = response.data?.data || [];
      if (!tracks.length) continue;

      for (const t of tracks) {
        const score = artistNameSimilar(t.info?.author || "", nameLower);
        if (score >= 0.25 && t.info?.artworkUrl) return t.info.artworkUrl;
      }
      // fallback: primer track si su author contiene al nombre buscado
      if (tracks[0]?.info?.artworkUrl && tracks[0].info.author?.toLowerCase().includes(nameLower)) {
        return tracks[0].info.artworkUrl;
      }
    } catch {}
  }

  return null;
}

async function searchLavalink(source, query, limit = 5) {
  const url = `${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/loadtracks?identifier=${encodeURIComponent(source + ":" + query)}`;
  const response = await axios.get(url, {
    headers: { Authorization: LAVALINK_AUTH },
    timeout: 15000,
  });
  return (response.data?.data || []).slice(0, limit).map(formatLavalinkTrack);
}

function isExplicit(title, author) {
  const text = `${title || ""} ${author || ""}`.toLowerCase();
  return /\bexplicit\b/.test(text) && !/\bclean\b/.test(text);
}

function formatLavalinkTrack(t) {
  const title = t.info?.title || "";
  const author = t.info?.author || "";
  return {
    id: t.info?.identifier,
    title,
    artist: author,
    album: t.info?.albumName || t.pluginInfo?.albumName || null,
    thumbnail: t.info?.artworkUrl,
    duration: t.info?.duration,
    uri: t.info?.uri,
    isrc: t.info?.isrc || null,
    explicit: isExplicit(title, author),
    genres: [],
  };
}

const SEARCH_STOPWORDS = new Set(["the", "a", "an", "and", "of", "for", "to", "de", "del", "la", "el", "los", "las", "y", "en", "feat", "ft"]);

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_STOPWORDS.has(token));
}

function countSharedTokens(a, b) {
  const setB = new Set(b);
  let count = 0;
  for (const token of a) {
    if (setB.has(token)) count++;
  }
  return count;
}

function chooseSeedArtist(query, rankedItems) {
  if (!Array.isArray(rankedItems) || rankedItems.length === 0) return "";
  const topItems = rankedItems.slice(0, 6).filter((item) => item.score > 0);
  if (!topItems.length) return "";

  const counts = new Map();
  for (const item of topItems) {
    const artist = normalizeSearchText(item.track?.artist || "");
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) || 0) + 1);
  }

  let winner = "";
  let bestCount = 0;
  for (const [artist, count] of counts.entries()) {
    if (count > bestCount) {
      winner = artist;
      bestCount = count;
    }
  }
  return winner;
}

function scoreSearchCandidate(track, query) {
  const q = normalizeSearchText(query);
  const title = normalizeSearchText(track.title || "");
  const artist = normalizeSearchText(track.artist || "");
  if (!title) return -Infinity;

  let score = 0;
  if (title === q) score += 80;
  else if (title.includes(q) || q.includes(title)) score += 40;
  else {
    const titleTokens = tokenizeSearchText(title);
    const queryTokens = tokenizeSearchText(q);
    const shared = countSharedTokens(titleTokens, queryTokens);
    score += Math.min(shared * 8, 24);
  }

  if (artist && q.includes(artist)) score += 18;
  if (/\b(topic|official|vevo)\b/i.test(track.artist || "")) score += 8;
  if (/\b(live|cover|karaoke|slowed|sped up|reverb|demo|edit)\b/i.test(track.title || "")) score -= 18;
  return score;
}

function rankSearchCandidates(tracks, query, limit) {
  const ranked = (tracks || [])
    .map((track, index) => ({ track, score: scoreSearchCandidate(track, query), index }))
    .filter((item) => item.score > -Infinity)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  if (!ranked.length) return [];
  const seedArtist = chooseSeedArtist(query, ranked);
  const exact = [];
  const sameArtist = [];
  const rest = [];

  const q = normalizeSearchText(query);
  for (const item of ranked) {
    const artist = normalizeSearchText(item.track?.artist || "");
    const title = normalizeSearchText(item.track?.title || "");
    const isExactTitle = title === q;
    const isSeedArtist = seedArtist && artist === seedArtist;
    const shared = countSharedTokens(tokenizeSearchText(`${item.track?.title || ""} ${item.track?.artist || ""}`), tokenizeSearchText(query));

    if (isExactTitle || shared >= Math.max(2, Math.ceil(tokenizeSearchText(query).length / 2))) exact.push(item);
    else if (isSeedArtist) sameArtist.push(item);
    else rest.push(item);
  }

  return [...exact, ...sameArtist, ...rest].slice(0, limit).map((item) => item.track);
}

async function searchLavalink(source, query, limit = 5) {
  const url = `${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/loadtracks?identifier=${encodeURIComponent(source + ":" + query)}`;
  const response = await axios.get(url, {
    headers: { Authorization: LAVALINK_AUTH },
    timeout: 15000,
  });
  const tracks = (response.data?.data || []).slice(0, limit).map(formatLavalinkTrack);
  await enrichExplicitWithDeezerISRC(tracks);
  return tracks;
}

async function enrichExplicitWithDeezerISRC(tracks) {
  const lookups = tracks
    .filter(t => t.isrc)
    .map(async (track) => {
      try {
        const res = await axios.get(`https://api.deezer.com/track/isrc:${track.isrc}`, { timeout: 3000 });
        if (res.data?.explicit_lyrics !== undefined) track.explicit = res.data.explicit_lyrics;
      } catch (e) {}
    });
  await Promise.allSettled(lookups);
}

function formatLavalinkTrack(t) {
  const title = t.info?.title || "";
  const author = t.info?.author || "";
  return {
    id: t.info?.identifier,
    title,
    artist: author,
    album: t.info?.albumName || t.pluginInfo?.albumName || null,
    thumbnail: t.info?.artworkUrl,
    duration: t.info?.duration,
    uri: t.info?.uri,
    isrc: t.info?.isrc || null,
    explicit: isExplicit(title, author),
    genres: [],
  };
}

async function searchTracks(query, limit = 25) {
  const tracks = await searchLavalink("ytmsearch", query, Math.max(limit * 3, limit));
  return rankSearchCandidates(tracks, query, limit);
}

async function searchAlbums(query, limit = 5) {
  const tracks = await searchLavalink("ytmsearch", query, limit * 4);
  const seen = new Set();
  const albums = [];
  for (const t of rankSearchCandidates(tracks, query, limit * 4)) {
    const key = t.album || t.title;
    if (!seen.has(key) && albums.length < limit) {
      seen.add(key);
      albums.push({
        id: t.id,
        name: t.album || t.title,
        artists: t.artist,
        image: t.thumbnail,
        releaseDate: null,
        totalTracks: 0,
        uri: t.uri,
      });
    }
  }
  return albums;
}

async function searchArtists(query, limit = 3) {
  const tracks = await searchLavalink("ytmsearch", query, limit);
  const seen = new Set();
  const artists = [];
  for (const t of tracks) {
    if (!seen.has(t.artist) && artists.length < limit) {
      seen.add(t.artist);
      artists.push({
        id: t.id,
        name: t.artist,
        image: t.thumbnail,
        genres: [],
      });
    }
  }
  return artists;
}

async function getTrack(trackId) {
  const query = trackId.replace(/^ytmsearch:/, "");
  const tracks = await searchLavalink("ytmsearch", query, 1);
  return tracks[0] || null;
}

async function getPlaylist(playlistId) {
  const query = playlistId;
  return searchLavalink("ytmsearch", query, 50);
}

async function getRecommendations(seedTrackIds = [], seedArtistIds = [], seedGenres = []) {
  const query = seedTrackIds.slice(0, 1).join(" ") || seedArtistIds.slice(0, 1).join(" ") || "music";
  const tracks = await searchLavalink("ytmsearch", query, 10);
  return tracks.filter(t => !seedTrackIds.includes(t.uri));
}

async function getAudioFeatures(trackIds) {
  return trackIds.map(() => null);
}

async function getSeveralTracks(trackIds) {
  return trackIds.slice(0, 50).flatMap(() => []);
}

async function getArtists(artistIds) {
  return artistIds.map(() => ({ id: null, name: "", genres: [] }));
}

async function getArtistTopTracks(artistId) {
  const tracks = await searchLavalink("ytmsearch", artistId, 10);
  return tracks;
}

async function getTrackOembed(url) {
  const tracks = await searchLavalink("ytmsearch", url, 1);
  if (tracks.length) {
    return { title: tracks[0].title, artist: tracks[0].artist, thumbnail: tracks[0].thumbnail };
  }
  return { title: null, artist: null, thumbnail: null };
}

function cleanArtistName(name) {
  return name.split(/[,;&/]|feat\.|ft\.|Feat\.|Ft\./)[0].replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").trim();
}

// Jaccard similarity entre conjuntos de palabras (sin contar palabras ≤2 chars)
function normalizeStr(s) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
function artistNameSimilar(a, b) {
  const wordsA = normalizeStr(a).toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const wordsB = normalizeStr(b).toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!wordsA.length || !wordsB.length) return normalizeStr(a).toLowerCase() === normalizeStr(b).toLowerCase() ? 1 : 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

async function getArtistImage(name) {
  const cleanName = cleanArtistName(name);
  if (!cleanName) return null;
  try {
    const res = await axios.get(`https://api.deezer.com/search/artist?q=${encodeURIComponent(cleanName)}&limit=10`, { timeout: 5000 });
    const candidates = res.data?.data || [];
    const nameLower = cleanName.toLowerCase();
    let best = null;
    let bestScore = 0;
    for (const a of candidates) {
      const score = artistNameSimilar(a.name, nameLower);
      if (score > bestScore || (score === bestScore && (a.nb_fan || 0) > (best?.nb_fan || 0))) {
        best = a;
        bestScore = score;
      }
    }
    if (best && bestScore >= 0.3) return best.picture_medium || null;
    if (best && bestScore > 0) return best.picture_medium || null; // al menos 1 palabra coincide
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  searchTracks,
  searchAlbums,
  searchArtists,
  getArtistImage,
  getTrack,
  getPlaylist,
  getRecommendations,
  getAudioFeatures,
  getSeveralTracks,
  getArtists,
  getArtistTopTracks,
  getTrackOembed,
  searchArtistsDirect,
  getArtistInfo,
  getArtistDescription,
  searchArtistDeezer,
};
