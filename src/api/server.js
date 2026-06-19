const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const passport = require("passport");
const DiscordStrategy = require("passport-discord").Strategy;
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/User");
const { requireApiKey, requireAuth, extractYtmCookies } = require("./middleware/auth");
const db = require("../database");
const { DiscordUser } = db;
const {
  findLikedSongByUrl,
  findLikedSongById,
  updateLikedSongUrl,
  getAllLikedSongsWithBadUrls,
  BAD_URI_REGEX,
} = db;
const { getLyrics } = require("../services/lrclib");
const spotify = require("../services/spotify");
const innertube = require("../services/innertube");
const metadataEnricher = require("../services/metadataEnricher");
const homeAggregatorService = require("../services/homeAggregatorService");
const radioService = require("../services/radioService");
const eventCollectorService = require("../services/eventCollectorService");
const rulePerformanceStore = require("../services/rulePerformanceStore");
const canvasCatalogService = require("../services/canvasCatalogService");
const { emitUserEvent } = require("../services/realtime");

const axios = require("axios");
const play = require("play-dl");

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function logCanvas(message) {
  console.log(`[Canvas] ${message}`);
}

function emitLibraryChanged(userId, source, reason, extra = {}) {
  emitUserEvent(userId, "library:changed", {
    userId: String(userId),
    source,
    reason,
    ...extra,
  });
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function normalizeArtistLookupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveCanonicalArtistId(artistId, artistName, userId) {
  if (!artistName) return artistId;

  const results = await innertube.searchQuery(artistName, "artist", userId).catch(() => []);
  if (!results.length) return artistId;

  const target = normalizeArtistLookupValue(artistName);
  const exactMatch = results.find((item) => {
    const title = normalizeArtistLookupValue(item?.title);
    const artist = normalizeArtistLookupValue(item?.artist);
    return title === target || artist === target;
  });

  const closeMatch = results.find((item) => {
    const title = normalizeArtistLookupValue(item?.title);
    return title && (title.includes(target) || target.includes(title));
  });

  const match = exactMatch || closeMatch || results[0];
  return match?.browseId || match?.videoId || artistId;
}

play.setToken({ soundcloud: { client_id: "Yks9HNwSpw5Bo7goMq3jv8cyDYgoLpZr" } });
console.log("[SERVER] SoundCloud initialized");

// Cookies de YouTube desde cookies.txt o YOUTUBE_COOKIES env var
const COOKIES_PATH = path.join(__dirname, "..", "..", "cookies.txt");
let hasYtCookies = false;
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(COOKIES_PATH, process.env.YOUTUBE_COOKIES, "utf8");
    console.log("[COOKIES] Written YOUTUBE_COOKIES env to cookies.txt");
  } catch (e) { console.warn("[COOKIES] Failed to write cookies:", e.message); }
}
if (fs.existsSync(COOKIES_PATH)) {
  try {
    const content = fs.readFileSync(COOKIES_PATH, "utf8");
    // Configurar play-dl con cookies
    const lines = content.split("\n");
    const cookies = [];
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 7) {
        cookies.push(`${parts[5].trim()}=${parts[6].trim()}`);
      }
    }
    if (cookies.length) {
      const cookieStr = cookies.join("; ");
      play.setToken({ youtube: { cookie: cookieStr } });
      innertube.setCookies(cookieStr);
      hasYtCookies = true;
      console.log(`[COOKIES] YouTube configured with ${cookies.length} cookies`);
    }
  } catch (e) { console.warn("[COOKIES] Failed to read cookies:", e.message); }
}

const YTDLP_BIN = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const YTDLP_PATH = path.join(__dirname, "..", "..", "node_modules", "@distube", "yt-dlp", "bin", YTDLP_BIN);


// Asegurar permisos de ejecución de yt-dlp en Linux
if (process.platform !== "win32") {
  try {
    if (fs.existsSync(YTDLP_PATH)) {
      fs.chmodSync(YTDLP_PATH, "755");
      console.log("[SERVER] yt-dlp execute permissions verified");
    }
  } catch (err) {
    console.warn(`[SERVER] Failed to chmod yt-dlp: ${err.message}`);
  }
}


function ytDlpGetUrl(videoUrl, isVideo = false) {
  return new Promise((resolve, reject) => {
    const format = isVideo 
      ? "best[ext=mp4]/best" 
      : "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best";
    const args = [
      videoUrl,
      "-f", format,
      "-g",
      "--no-warnings",
      "--extractor-retries", "3",
    ];
    if (hasYtCookies) args.push("--cookies", COOKIES_PATH);
    const proc = spawn(YTDLP_PATH, args, { timeout: 15000 });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d);
    proc.stderr.on("data", d => stderr += d);
    proc.on("close", code => {
      const url = stdout.toString().trim();
      if (code === 0 && url) {
        resolve(url);
      } else {
        reject(new Error(stderr || `Exit code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

const STREAM_CACHE_MAX = 200;
const IS_RENDER = !!process.env.RENDER;

const { getCached, setCached } = (() => {
  const DB_PATH = path.join(__dirname, "..", "..", "stream-cache.json");

  function loadDisk() {
    if (IS_RENDER) return {}; // Render tiene FS efímero, no vale la pena
    try { return JSON.parse(fs.readFileSync(DB_PATH, "utf8")); }
    catch { return {}; }
  }

  function saveDisk(data) {
    if (IS_RENDER) return;
    try { fs.writeFileSync(DB_PATH, JSON.stringify(data), "utf8"); } catch {}
  }

  const disk = loadDisk();
  const mem = new Map();

  // Migrate disk → mem on startup, mantener solo las más recientes
  const validEntries = Object.entries(disk)
    .filter(([, v]) => Date.now() - v.ts < 7 * 24 * 60 * 60 * 1000)
    .sort((a, b) => b[1].ts - a[1].ts)
    .slice(0, STREAM_CACHE_MAX);
  for (const [k, v] of validEntries) mem.set(k, v);
  if (Object.keys(disk).length !== mem.size) saveDisk(Object.fromEntries(mem));

  function evictLRU() {
    if (mem.size <= STREAM_CACHE_MAX) return;
    const sorted = [...mem.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < sorted.length - STREAM_CACHE_MAX; i++) mem.delete(sorted[i][0]);
  }

  // Flush to disk every 60s (solo en local)
  if (!IS_RENDER) setInterval(() => { saveDisk(Object.fromEntries(mem)); }, 60_000);

  return {
    getCached: (key) => {
      const e = mem.get(key);
      if (!e) return null;

      // YouTube expiración de stream
      if (e.url) {
        try {
          const decoded = e.url.includes("%") ? decodeURIComponent(e.url) : e.url;
          const matchSec = decoded.match(/[?&]expire=(\d+)/);
          const matchMs = decoded.match(/[?&]exp=(\d+)/);
          
          if (matchSec || matchMs) {
            const expire = matchSec ? parseInt(matchSec[1], 10) : Math.floor(parseInt(matchMs[1], 10) / 1000);
            const nowSec = Math.floor(Date.now() / 1000);
            const margin = matchMs ? 60 : 600;
            if (nowSec >= expire - margin) {
              mem.delete(key);
              return null;
            }
            return e.url;
          }
        } catch (err) {}
      }

      const ttl = 7 * 24 * 60 * 60 * 1000;
      if (Date.now() - e.ts > ttl) {
        mem.delete(key);
        return null;
      }
      return e.url;
    },
    setCached: (key, url) => {
      mem.set(key, { url, ts: Date.now() });
      evictLRU();
    },
  };
})();

const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;  // 5 min
const SEARCH_CACHE_MAX = 50;              // máx 50 búsquedas
const searchInFlight = new Map();
const artistInfoCache = new Map();
const ARTIST_INFO_CACHE_TTL = 60 * 60 * 1000;  // 1 hora
const ARTIST_INFO_CACHE_MAX = 200;
const artistInfoInFlight = new Map();
const artistImageCache = new Map();
const ARTIST_IMAGE_CACHE_TTL = 60 * 60 * 1000;
const artistImageInFlight = new Map();
const suggestionsInFlight = new Map();
const metadataPoolCache = new Map();
const METADATA_POOL_CACHE_TTL = 2 * 60 * 1000;
const metadataPoolInFlight = new Map();
const metadataSyncCache = new Map();
const METADATA_SYNC_CACHE_TTL = 30_000;
const metadataSyncInFlight = new Map();
function cleanCache(cache, ttl, max) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > ttl) cache.delete(key);
  }
  if (cache.size > max) {
    const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - max; i++) cache.delete(entries[i][0]);
  }
}

async function withInFlight(map, key, task) {
  if (map.has(key)) return map.get(key);
  const promise = Promise.resolve().then(task);
  map.set(key, promise);
  try {
    return await promise;
  } finally {
    map.delete(key);
  }
}
setInterval(() => cleanCache(searchCache, SEARCH_CACHE_TTL, SEARCH_CACHE_MAX), 60_000);
setInterval(() => cleanCache(artistInfoCache, ARTIST_INFO_CACHE_TTL, ARTIST_INFO_CACHE_MAX), 60_000);

function extractVideoId(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const url = new URL(s);
    if (url.hostname.includes("youtube")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("?")[0] || null;
  } catch {}
  return null;
}

async function extractVideoIdFromLavalink(input) {
  try {
    // lavasrc format: <base64>||<plugin_data>
    const track = input.includes("||") ? input.split("||")[0] : input;
    if (!/^[A-Za-z0-9+/=]+$/.test(track)) return null;
    const res = await axios.get(`${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/decodetrack`, {
      params: { encodedTrack: track },
      headers: { Authorization: LAVALINK_AUTH },
      timeout: 5000,
    });
    return res.data?.info?.identifier || null;
  } catch {
    return null;
  }
}

const failedVideoIds = new Map();
const blockedVideoIds = new Set();
setInterval(() => {
  for (const [id, ts] of failedVideoIds) {
    if (Date.now() - ts > 5 * 60_000) failedVideoIds.delete(id);
  }
}, 60_000);

let streamQueuePromise = Promise.resolve();

async function resolveStreamUrl(identifier, req = null, forceRefresh = false, isVideo = false) {
  if (!identifier || typeof identifier !== "string") return null;

  // URL de audio directa (Deezer, etc.) → proxylar por el backend
  if (/^https?:\/\/.+\.(mp3|m4a|ogg|wav|flac|opus)(\?|$)/i.test(identifier)) {
    const hash = "proxy:" + identifier.slice(0, 40);
    if (!forceRefresh) {
      const cached = getCached(hash);
      if (cached) return cached;
    }
    if (req) {
      const proxyUrl = `${req.protocol}://${req.get("host")}/api/proxy/audio?url=${encodeURIComponent(identifier)}`;
      setCached(hash, proxyUrl);
      return proxyUrl;
    }
    // Sin req (warm en background), devolver directo
    setCached(hash, identifier);
    return identifier;
  }

  let videoId = extractVideoId(identifier);
  if (!videoId) videoId = await extractVideoIdFromLavalink(identifier);
  if (!videoId) return null;

  const cacheKey = isVideo ? `${videoId}:video` : videoId;

  if (forceRefresh) {
    failedVideoIds.delete(cacheKey);
    blockedVideoIds.delete(cacheKey);
  } else if (blockedVideoIds.has(cacheKey)) {
    return { blocked: true, videoId };
  } else if (failedVideoIds.has(cacheKey)) {
    return null;
  }

  if (!forceRefresh) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // Encolar la resolución para garantizar que nunca se ejecuten procesos concurrentes de yt-dlp/play-dl
  return new Promise((resolve) => {
    streamQueuePromise = streamQueuePromise.then(async () => {
      try {
        if (!forceRefresh) {
          const secondaryCache = getCached(cacheKey);
          if (secondaryCache) {
            resolve(secondaryCache);
            return;
          }
        }
        const streamUrl = await doResolveStreamUrl(videoId, req, isVideo);
        resolve(streamUrl);
      } catch (err) {
        resolve(null);
      } finally {
        // Liberar memoria forzando GC explícito en Render
        if (global.gc) {
          try { global.gc(); } catch {}
        }
      }
    });
  });
}



async function doResolveStreamUrl(videoId, req = null, isVideo = false) {
  const cacheKey = isVideo ? `${videoId}:video` : videoId;

  // A. InnerTube directo primero: suele responder antes que yt-dlp/play-dl
  try {
    const streamUrl = await innertube.getStreamUrl(videoId);
    if (streamUrl) {
      console.log(`[stream] InnerTube success for ${videoId}`);
      setCached(cacheKey, streamUrl);
      return streamUrl;
    }
    console.warn(`[stream] InnerTube returned null for ${videoId} (no streaming data)`);
  } catch (e) {
    console.warn(`[stream] InnerTube failed for ${videoId}: ${e.message}`);
  }

  // B. yt-dlp (no funciona en Render sin cookies, YouTube bloquea IPs de datacenter)
  if (!IS_RENDER || hasYtCookies) {
    try {
      const streamUrl = await ytDlpGetUrl(`https://www.youtube.com/watch?v=${videoId}`, isVideo);
      if (streamUrl) {
        setCached(cacheKey, streamUrl);
        return streamUrl;
      }
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("Video unavailable") || msg.includes("This video is not available")) {
        console.warn(`[stream] Video blocked/unavailable: ${videoId}`);
        blockedVideoIds.add(cacheKey);
        return { blocked: true, videoId };
      }
      console.warn(`[stream] yt-dlp failed for ${videoId}: ${msg}`);
    }

    // C. play-dl (audio)
    if (!isVideo) {
      try {
        const info = await play.video_info(`https://www.youtube.com/watch?v=${videoId}`).catch(async () => {
          const search = await play.search(videoId, { limit: 1 });
          return search[0] ? await play.video_info(search[0].url) : null;
        });
        if (info) {
          const stream = await play.stream_from_info(info, { quality: 2, discordPlayerCompatibility: true });
          if (stream?.url) {
            setCached(cacheKey, stream.url);
            return stream.url;
          }
        }
      } catch (e) {
        console.warn(`[stream] play-dl failed for ${videoId}: ${e.message}`);
      }
    }
  }

  // D. Cobalt fallback
  const fallback = await resolveViaCobalt(videoId, isVideo);
  if (fallback) {
    setCached(cacheKey, fallback);
    return fallback;
  }

  // E. Fallback agotado
  failedVideoIds.set(cacheKey, Date.now());
  return null;
}

async function resolveViaCobalt(videoId, isVideo = false) {
  // Instancias y payloads según API v11 de Cobalt.
  // downloadMode: auto (video), audio (solo audio), mute (video sin audio)
  const basePayload = {
    url: `https://www.youtube.com/watch?v=${videoId}`,
    downloadMode: isVideo ? "auto" : "audio",
    audioFormat: "best",
    filenameStyle: "basic",
    ...(isVideo ? { videoQuality: "720", youtubeVideoCodec: "h264" } : {}),
  };
  const instances = [
    { url: "https://apicobalt.mgytr.top", payload: basePayload },
    { url: "https://cobalt.alpha.wolfy.love", payload: basePayload },
    { url: "https://api.qwkuns.me", payload: basePayload },
    { url: "https://lime.clxxped.lol", payload: basePayload },
    { url: "https://cobalt-api.hyper.lol", payload: basePayload },
    { url: "https://cobalt.api.timelessnesses.me", payload: basePayload },
    { url: "https://api-dl.cgm.rs", payload: basePayload },
    { url: "https://cobalt.synzr.space", payload: basePayload },
    { url: "https://capi.oak.li", payload: basePayload },
    { url: "https://co.tskau.team", payload: basePayload },
    { url: "https://api.co.rooot.gay", payload: basePayload },
  ];

  for (const { url: instance, payload } of instances) {
    try {
      console.log(`[stream] Trying Cobalt: ${instance} for ${videoId}`);
      const res = await axios.post(instance, payload, {
        headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        timeout: 4000,
      });
      if (res.data?.url) {
        console.log(`[stream] Cobalt success for ${videoId} (${instance})`);
        return res.data.url;
      }
      if (res.data?.status === "local-processing" && res.data?.tunnel?.length) {
        console.log(`[stream] Cobalt local-processing for ${videoId} (${instance})`);
        return res.data.tunnel[0];
      }
    } catch (err) {
      console.warn(`[stream] Cobalt ${instance} failed: ${err.message}`);
    }
  }
  return null;
}

const LAVALINK_HOST = process.env.LAVALINK_HOST || "localhost";
const LAVALINK_PORT = Number(process.env.LAVALINK_PORT) || 2333;
const LAVALINK_SECURE = process.env.LAVALINK_SECURE === "true";
const LAVALINK_PROTO = LAVALINK_SECURE ? "https" : "http";
const LAVALINK_AUTH = process.env.LAVALINK_PASSWORD || "youshallnotpass";

const app = express();
app.set("trust proxy", 1); // Render usa proxy reverso con SSL
app.use(express.json());
app.use(passport.initialize());

// Logger simple para debug en Render
app.use((req, res, next) => {
  const cookie = req.headers["cookie"];
  const ytm = req.headers["x-ytm-active"];
  const sapisid = req.headers["x-ytm-sapisid"];
  const auth = req.headers.authorization ? req.headers.authorization.substring(0, 30) + "..." : null;
  if (cookie || ytm || sapisid) {
    console.log(`[REQ] ${req.method} ${req.url} cookies=${(cookie?.length || 0)}b ytmActive=${ytm} sapisid=${!!sapisid} auth=${auth ? "Bearer.." : "none"} hasYtmCookies=${cookie && (cookie.includes("SAPISID") || cookie.includes("SSID"))}`);
  } else {
    console.log(`[${req.method}] ${req.url}`);
  }
  next();
});

// Root Health Check (Para Render)
app.get("/", (req, res) => {
  res.send("Android Music Backend is running");
});

// API Health Check (Para el App Android)
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "music-api" });
});

// Proxy de audio (Deezer, Spotify, YouTube, etc.) — soporta Range/Partial Content
app.get("/api/proxy/audio", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Missing url" });

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };
  if (targetUrl.includes("deezer.com")) {
    headers["Referer"] = "https://deezer.com/";
  }
  if (targetUrl.includes("googlevideo.com")) {
    headers["Referer"] = "https://music.youtube.com/";
    headers["Origin"] = "https://music.youtube.com";
  }
  if (req.headers.range) {
    headers["Range"] = req.headers.range;
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: "stream",
      headers: headers,
      timeout: 15000,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 206,
    });

    res.status(response.status);
    if (response.headers["content-type"]) res.set("Content-Type", response.headers["content-type"]);
    if (response.headers["content-length"]) res.set("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"]) res.set("Content-Range", response.headers["content-range"]);
    if (response.headers["accept-ranges"]) res.set("Accept-Ranges", response.headers["accept-ranges"]);

    response.data.pipe(res);

    // Evitar fugas de sockets destruyendo el flujo de entrada cuando el cliente cierra la petición
    res.on("close", () => {
      if (response && response.data && typeof response.data.destroy === "function") {
        response.data.destroy();
      }
    });
  } catch (e) {
    console.error("Proxy error:", e.message);
    res.status(502).json({ error: "Proxy fetch failed: " + (e.message || e) });
  }
});

const SOURCE_MAP = {
  deezer: "ytmsearch",
  spotify: "ytmsearch",
  youtube: "ytmsearch",
  ytmsearch: "ytmsearch",
  ytsearch: "ytsearch",
  soundcloud: "scsearch",
};

app.get("/api/search", requireApiKey, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const source = SOURCE_MAP[req.query.source] || "ytmsearch";
    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

    const cacheKey = `${source}:${q}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
      return res.json(cached.data);
    }

    const result = await withInFlight(searchInFlight, cacheKey, async () => {
      const existing = searchCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < SEARCH_CACHE_TTL) {
        return existing.data;
      }

      // InnerTube directo para ytmsearch (sin hop a Lavalink, ~1s)
      let tracks = [];
      if (source === "ytmsearch") {
        tracks = await innertube.searchQuery(q);
        if (tracks.length) {
          console.log(`[search] InnerTube success source=${source} q="${q}" count=${tracks.length}`);
        } else {
          console.log(`[search] InnerTube empty source=${source} q="${q}"`);
        }
      }
      // Fallback a Lavalink (catch silencioso si está caído)
      if (!tracks.length) {
        try {
          tracks = await searchLavalink(source, q);
          console.log(`[search] Lavalink ${tracks.length ? "success" : "empty"} source=${source} q="${q}" count=${tracks.length}`);
        } catch (e) {
          console.warn(`[search] Lavalink failed source=${source} q="${q}": ${e.message}`);
          tracks = [];
        }
      }

      if (!tracks.length) return { query: q, source, tracks: [] };

      tracks = await enrichArtworkWithDeezer(tracks);

      const payload = { query: q, source, tracks };
      searchCache.set(cacheKey, { data: payload, ts: Date.now() });

      // Background: enriquecer con Lavalink (encoded, isrc, explicit) + pre-resolver streams
      setImmediate(async () => {
        if (!IS_RENDER) {
          const toResolve = payload.tracks.slice(0, 3);
          for (const track of toResolve) {
            if (track.uri) {
              try { await resolveStreamUrl(track.uri, req); } catch (e) {}
            }
          }
        }
      });

      return payload;
    });

    res.json(result);
  } catch (err) {
    console.error("Search Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Search Suggestions (Autocomplete) ─────────────────────────────────
// GET /api/search/suggestions?q=<query>
// Returns: { query, suggestions: string[] }
app.get("/api/search/suggestions", requireApiKey, async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.trim().length === 0) {
      return res.json({ query: q || "", suggestions: [] });
    }

    const cacheKey = `suggestions:${q}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60_000) {
      return res.json(cached.data);
    }

    const result = await withInFlight(suggestionsInFlight, cacheKey, async () => {
      const existing = searchCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < 60_000) {
        return existing.data;
      }

      const sugRes = await axios.get("https://suggestqueries.google.com/complete/search", {
        params: { client: "chrome", ds: "yt", q: q.trim() },
        timeout: 5000,
      });

      const suggestions = Array.isArray(sugRes.data?.[1]) ? sugRes.data[1] : [];
      const payload = { query: q, suggestions };
      searchCache.set(cacheKey, { data: payload, ts: Date.now() });
      return payload;
    });

    res.json(result);
  } catch (err) {
    console.error("[suggestions] Error:", err.message);
    res.json({ query: req.query.q || "", suggestions: [] });
  }
});


async function searchLavalink(source, query) {
  const url = `${LAVALINK_PROTO}://${LAVALINK_HOST}:${LAVALINK_PORT}/v4/loadtracks?identifier=${encodeURIComponent(source + ":" + query)}`;
  const response = await axios.get(url, {
    headers: { Authorization: LAVALINK_AUTH },
    timeout: 15000,
  });
  function cleanAuthor(a) {
    return (a || "").replace(/\s*-\s*Topic$/i, "").trim();
  }
  const tracks = (response.data?.data || []).map(t => ({
    id: t.info?.identifier,
    encoded: t.encoded,
    title: metadataEnricher.cleanTitle(t.info?.title || ""),
    artist: cleanAuthor(t.info?.author),
    author: cleanAuthor(t.info?.author),
    duration: t.info?.duration,
    uri: t.info?.uri,
    artworkUrl: t.info?.artworkUrl,
    thumbnail: t.info?.artworkUrl,
    source: t.info?.sourceName,
    album: t.info?.albumName || t.pluginInfo?.albumName || null,
    albumUrl: t.pluginInfo?.albumUrl || null,
    isrc: t.info?.isrc || t.pluginInfo?.isrc || null,
    explicit: t.info?.explicit === true || t.pluginInfo?.explicit === true,
    videoId: t.info?.identifier || null,
  }));
  await enrichExplicitWithDeezerISRC(tracks);
  return tracks;
}

async function enrichExplicitWithDeezerISRC(tracks) {
  // Limitar a los primeros 6 con ISRC para no saturar memoria/sockets
  const targets = tracks.filter(t => t.isrc).slice(0, 6);
  const lookups = targets.map(async (track) => {
    try {
      const res = await axios.get(`https://api.deezer.com/track/isrc:${track.isrc}`, { timeout: 3000 });
      if (res.data?.explicit_lyrics !== undefined) track.explicit = res.data.explicit_lyrics;
    } catch (e) {}
  });
  await Promise.allSettled(lookups);
}

function enrichArtistNameSimilar(a, b) {
  const wa = (a || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const wb = (b || "").toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (!wa.length || !wb.length) return (a || "").toLowerCase() === (b || "").toLowerCase() ? 1 : 0;
  const sa = new Set(wa), sb = new Set(wb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / new Set([...sa, ...sb]).size;
}

function hasRemixTag(text) {
  return /\b(remix|rework|edit|mix|live|acoustic)\b/i.test(text || "");
}

function scoreDeezerCandidate(track, candidate) {
  const trackArtist = track.artist || "";
  const candidateArtist = candidate.artist?.name || "";
  const trackTitle = metadataEnricher.cleanTitle(track.title || "").toLowerCase();
  const candidateTitle = metadataEnricher.cleanTitle(candidate.title || "").toLowerCase();

  let score = 0;
  score += enrichArtistNameSimilar(candidateArtist, trackArtist) * 10;

  if (trackTitle && candidateTitle) {
    if (trackTitle === candidateTitle) score += 8;
    else if (trackTitle.includes(candidateTitle) || candidateTitle.includes(trackTitle)) score += 4;
    else {
      const trackWords = new Set(trackTitle.split(/\s+/).filter(Boolean));
      const candidateWords = new Set(candidateTitle.split(/\s+/).filter(Boolean));
      let shared = 0;
      for (const word of trackWords) if (candidateWords.has(word)) shared++;
      score += Math.min(shared, 4);
    }
  }

  const trackIsVariant = hasRemixTag(track.title);
  const candidateIsVariant = hasRemixTag(candidate.title || candidate.album?.title || "");
  if (trackIsVariant === candidateIsVariant) score += 3;
  else if (trackIsVariant || candidateIsVariant) score -= 6;

  if (candidate.explicit_lyrics === true) score += 0.5;
  return score;
}

async function enrichArtworkWithDeezer(tracks) {
  const enriched = [...tracks];
  const limit = Math.min(enriched.length, 6);
  const lookups = enriched.slice(0, limit).map(async (track) => {
    const needsArtwork = !track.artworkUrl?.startsWith("http") || track.artworkUrl?.includes("ytimg");
    if (!needsArtwork && track.explicit === true) return;
    if (!track.title && !track.artist) return;

    try {
      const q = encodeURIComponent(`${track.artist} ${track.title}`.trim());
      const res = await axios.get(`https://api.deezer.com/search/track?q=${q}&limit=3`, { timeout: 3000 });
      const data = res.data?.data || [];
      // Elegir la coincidencia más parecida y evitar que el remix gane al original.
      const match = data
        .map((candidate) => ({ candidate, score: scoreDeezerCandidate(track, candidate) }))
        .sort((a, b) => b.score - a.score)[0]?.candidate || null;
      if (match) {
        if (match.album?.cover_medium) {
          track.artworkUrl = match.album.cover_medium;
          track.thumbnail = match.album.cover_medium;
        }
        if (match.explicit_lyrics !== undefined) track.explicit = match.explicit_lyrics === true;
      }
    } catch (e) {}
  });
  await Promise.allSettled(lookups);
  return enriched;
}

// ── Video Search (YouTube) ────────────────────────────────────────────
// GET /api/search/video?q=<query>
// Returns: { query, tracks: [{ uri, artworkUrl, author, title }] }
app.get("/api/search/video", requireApiKey, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

    const cacheKey = `ytsearch:video:${q}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_TTL) {
      return res.json(cached.data);
    }

    const result = await withInFlight(searchInFlight, cacheKey, async () => {
      const existing = searchCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < SEARCH_CACHE_TTL) {
        return existing.data;
      }

      // InnerTube directo primero (evita Lavalink caído)
      const innertubeResults = await innertube.searchQuery(q, "video");
      let tracks;
      if (innertubeResults && innertubeResults.length) {
        tracks = innertubeResults.map((t) => {
          let artworkUrl = t.artworkUrl || "";
          if (artworkUrl.includes("ytimg.com")) {
            artworkUrl = artworkUrl
              .replace(/\/(hqdefault|mqdefault|sddefault|default|maxresdefault)(\.jpg(\?.*)?)?$/, "/maxresdefault.jpg");
          }
          return {
            uri: t.uri,
            artworkUrl,
            author: t.artist || t.author || "",
            title: t.title,
          };
        });
      } else {
        // Fallback Lavalink si InnerTube no devolvió nada; si está caído, responder vacío.
        let raw = [];
        try {
          raw = await searchLavalink("ytsearch", q);
        } catch (e) {
          raw = [];
        }
        tracks = raw.map((t) => {
          let artworkUrl = t.artworkUrl || "";
          if (artworkUrl.includes("ytimg.com")) {
            artworkUrl = artworkUrl
              .replace(/\/(hqdefault|mqdefault|sddefault|default|maxresdefault)(\.jpg(\?.*)?)?$/, "/maxresdefault.jpg");
          }
          return {
            uri: t.uri,
            artworkUrl,
            author: t.author,
            title: t.title,
          };
        });
      }

      const payload = { query: q, source: "ytsearch", tracks };
      searchCache.set(cacheKey, { data: payload, ts: Date.now() });
      return payload;
    });

    res.json(result);
  } catch (err) {
    console.error("[search/video] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spotify/search", requireApiKey, async (req, res) => {
  try {
    const q = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });
    const tracks = await spotify.searchTracks(q, limit);
    res.json({ query: q, tracks, source: "spotify" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/spotify/search/albums", requireApiKey, async (req, res) => {
  try {
    const q = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });
    const albums = await spotify.searchAlbums(q, limit);
    res.json({ query: q, albums, source: "spotify" });
  } catch (err) {
    console.warn(`[spotify/search/albums] Fallback empty for query="${req.query.q || ""}": ${err.message}`);
    res.json({ query: req.query.q || "", albums: [], source: "spotify", degraded: true });
  }
});

app.get("/api/spotify/search/artists", requireApiKey, async (req, res) => {
  try {
    const q = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });
    const artists = await spotify.searchArtistsDirect(q, limit);
    res.json({ query: q, artists, source: "spotify" });
  } catch (err) {
    console.warn(`[spotify/search/artists] Fallback empty for query="${req.query.q || ""}": ${err.message}`);
    res.json({ query: req.query.q || "", artists: [], source: "spotify", degraded: true });
  }
});

app.get("/api/spotify/artist/:id", requireApiKey, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing artist id" });
    const info = await spotify.getArtistInfo(id);
    const desc = await spotify.getArtistDescription(info.name);
    res.json({ ...info, description: desc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const WARM_CONCURRENCY = IS_RENDER ? 1 : 3;

app.post("/api/warm", requireApiKey, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Missing or empty 'ids' array" });
    }

    const validIds = ids.filter(id => id && id !== "undefined" && id !== "null" && id.trim() !== "");
    res.json({ warmed: validIds.length });

    setImmediate(() => {
      const queue = validIds.slice();
      const workers = Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
          const id = queue.shift();
          try { await resolveStreamUrl(id, req); } catch (e) {}
        }
      });
      Promise.all(workers).catch(() => {});
    });
  } catch (err) {
    console.error("Warm Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stream", requireApiKey, async (req, res) => {
  try {
    const { id, title, artist, refresh, video } = req.query;
    if (!id || id === "undefined" || id === "null" || id.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid 'id' parameter" });
    }

    const forceRefresh = refresh === "true" || refresh === "1";
    const isVideo = video === "true" || video === "1" || video === "video" ||
                    id.includes("youtube_video") || id.includes("videoUrl") || id.includes(":video");
    const direct = req.query.direct === "true" || req.query.direct === "1";

    const getFinalStreamUrl = (url) => {
      if (!url) return url;
      if (direct) {
        return url;
      }
      if (req) {
        return `${req.protocol}://${req.get("host")}/api/proxy/audio?url=${encodeURIComponent(url)}`;
      }
      return url;
    };

    // (D) Fallback: URI de Deezer/Spotify → buscar en YTM por título+autor
    if (BAD_URI_REGEX.test(id)) {
      let query = null;
      if (title && artist) {
        query = `${artist} - ${title}`.trim();
      } else {
        // Buscar en DB por URL
        const found = await findLikedSongByUrl(id, "android") ||
                      await findLikedSongByUrl(id, "discord");
        if (found && found.track_title) {
          query = `${found.track_author || ""} - ${found.track_title}`.trim();
        }
      }
      if (query && query !== "-") {
        try {
          const searchSource = isVideo ? "ytsearch" : "ytmsearch";
          const tracks = await searchLavalink(searchSource, query);
          if (tracks.length) {
            const streamUrl = await resolveStreamUrl(tracks[0].uri, req, forceRefresh, isVideo);
            if (typeof streamUrl === "string") {
              return res.json({ url: getFinalStreamUrl(streamUrl), resolvedFrom: isVideo ? "yt" : "ytm" });
            }
          }
        } catch (e) {
          console.warn("[stream] YTM fallback failed:", e.message);
        }
      }
      return res.status(404).json({ error: "Cannot resolve Deezer/Spotify URI" });
    }

    // (E) MongoDB ObjectID → buscar canción en DB y extraer video ID
    let resolvedId = id;
    if (/^[0-9a-f]{24}$/i.test(id)) {
      const found = await findLikedSongById(id, "android") ||
                    await findLikedSongById(id, "discord");
      if (found?.track_url) {
        const vid = extractVideoId(found.track_url);
        if (vid) resolvedId = vid;
      }
    }

    const streamUrl = await resolveStreamUrl(resolvedId, req, forceRefresh, isVideo);
    if (typeof streamUrl === "string") {
      return res.json({ url: getFinalStreamUrl(streamUrl) });
    }
    if (streamUrl?.blocked) {
      return res.status(403).json({ error: "Video blocked in this region", blocked: true, videoId: id });
    }

    res.status(404).json({ error: "No stream found after fallback" });
  } catch (err) {
    console.error("Critical Stream Error:", err.stack);
    res.status(500).json({ error: "Server Internal Error" });
  }
});

// (C) Endpoint de migración: reemplaza URLs de Deezer/Spotify por YTM en MongoDB
app.post("/api/admin/migrate-liked-urls", requireApiKey, async (req, res) => {
  const sources = ["android", "discord"];
  const results = {};
  let totalGlobal = 0, updatedGlobal = 0, failedGlobal = 0;

  for (const source of sources) {
    let updated = 0, failed = 0;
    try {
      const badSongs = await getAllLikedSongsWithBadUrls(source);
      results[source] = { total: badSongs.length, updated: 0, failed: 0 };
      totalGlobal += badSongs.length;

      for (const song of badSongs) {
        const query = [
          song.track_author && song.track_title ? `${song.track_author} - ${song.track_title}` : null,
          song.track_title,
        ].filter(Boolean);

        let resolved = false;
        for (const q of query) {
          try {
            const tracks = await searchLavalink("ytmsearch", q);
            if (tracks.length && tracks[0].uri) {
              const ok = await updateLikedSongUrl(song._id, tracks[0].uri, source);
              if (ok) { updated++; resolved = true; break; }
            }
          } catch {}
        }
        if (!resolved) failed++;
      }
    } catch (e) {
      console.error(`[migrate] Error source=${source}:`, e.message);
      results[source] = results[source] || { total: 0, updated: 0, failed: 0 };
    }
    results[source].updated = updated;
    results[source].failed = failed;
    updatedGlobal += updated;
    failedGlobal += failed;
  }

  res.json({ total: totalGlobal, updated: updatedGlobal, failed: failedGlobal, bySource: results });
});

app.get("/api/lyrics", requireApiKey, async (req, res) => {
  try {
    const { track, artist, album, source, enabled_providers, romanize_japanese, romanize_korean } = req.query;
    if (!track) return res.status(400).json({ error: "Missing 'track' parameter" });
    const result = await getLyrics(track, artist || "", album || "", {
      source,
      enabledProviders: enabled_providers,
      romanizeJapanese: romanize_japanese,
      romanizeKorean: romanize_korean,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/canvas/manifest", requireApiKey, async (req, res) => {
  try {
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas("Canvas metadata sent: manifest");
    res.json(canvasCatalogService.getCatalogSummary(baseUrl));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/canvas/export", requireApiKey, async (req, res) => {
  try {
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    const snapshot = {
      exportedAt: new Date().toISOString(),
      root: canvasCatalogService.CANVAS_LIBRARY_ROOT,
      ...canvasCatalogService.getCatalogSummary(baseUrl),
    };
    logCanvas("Canvas metadata sent: export snapshot");
    res.json(snapshot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/canvas/resolve", requireApiKey, async (req, res) => {
  try {
    const resolved = canvasCatalogService.resolveRecord(req.query);
    if (!resolved) return res.status(404).json({ found: false });
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: resolve -> ${resolved.canonicalId}`);
    res.json({ found: true, item: canvasCatalogService.attachUrls(resolved, baseUrl) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/register", requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const record = canvasCatalogService.upsertRecord(body);
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: register -> ${record.canonicalId}`);
    res.json({ found: true, item: canvasCatalogService.attachUrls(record, baseUrl) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/request", requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    canvasCatalogService.syncFilesystemCatalog();

    const refresh = body.refresh === true;
    const existing = !refresh ? canvasCatalogService.resolveRecord(body) : null;
    if (existing) {
      const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
      logCanvas(`Canvas metadata sent: request existing -> ${existing.canonicalId}`);
      return res.json({
        found: true,
        item: canvasCatalogService.attachUrls(existing, baseUrl),
        queued: false,
      });
    }

    const hasCanvasUrl = typeof body.canvasUrl === "string" && body.canvasUrl.trim().length > 0;
    const record = hasCanvasUrl
      ? await canvasCatalogService.requestRecord({ ...body, refresh })
      : canvasCatalogService.createPendingRecord(body);

    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: request -> ${record.canonicalId}`);
    res.json({
      found: true,
      item: canvasCatalogService.attachUrls(record, baseUrl),
      folderPath: record.assetPaths?.canvas ? path.dirname(record.assetPaths.canvas) : null,
      queued: !hasCanvasUrl,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/ensure-folder", requireApiKey, async (req, res) => {
  try {
    const body = req.body || {};
    const record = await canvasCatalogService.ensureFolderRecord(body);
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: ensure-folder -> ${record.canonicalId}`);
    res.json({
      found: true,
      item: canvasCatalogService.attachUrls(record, baseUrl),
      folderPath: record.assetPaths?.canvas ? path.dirname(record.assetPaths.canvas) : null,
      queued: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/sync", requireApiKey, async (req, res) => {
  try {
    const synced = canvasCatalogService.syncFilesystemCatalog();
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: sync -> ${synced.length} item(s)`);
    res.json({
      ok: true,
      count: synced.length,
      items: synced.map((item) => canvasCatalogService.attachUrls(item, baseUrl)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/regenerate", requireApiKey, async (req, res) => {
  try {
    const refreshed = await canvasCatalogService.regenerateCatalogMetadata();
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: regenerate -> ${refreshed.length} item(s)`);
    res.json({
      ok: true,
      count: refreshed.length,
      items: refreshed.map((item) => canvasCatalogService.attachUrls(item, baseUrl)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/canvas/regenerate-item", requireApiKey, async (req, res) => {
  try {
    const { canonicalId } = req.body || {};
    if (!canonicalId) return res.status(400).json({ error: "canonicalId required" });

    const record = await canvasCatalogService.regenerateRecordByCanonicalId(canonicalId);
    if (!record) return res.status(404).json({ error: "Canvas item not found" });

    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: regenerate-item -> ${record.canonicalId}`);
    res.json({
      found: true,
      ok: true,
      item: canvasCatalogService.attachUrls(record, baseUrl),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/canvas/:canonicalId", requireApiKey, async (req, res) => {
  try {
    const item = canvasCatalogService.findRecordByCanonicalId(req.params.canonicalId);
    if (!item) return res.status(404).json({ found: false });
    const baseUrl = `${req.headers["x-forwarded-proto"] || req.protocol}://${req.get("host")}`;
    logCanvas(`Canvas metadata sent: item -> ${item.canonicalId}`);
    res.json({ found: true, item: canvasCatalogService.attachUrls(item, baseUrl) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/canvas/:canonicalId/file/:asset", requireApiKey, async (req, res) => {
  try {
    const item = canvasCatalogService.findRecordByCanonicalId(req.params.canonicalId);
    if (!item) {
      return res.status(404).json({ error: "Canvas asset not found" });
    }

    const assetPath = canvasCatalogService.resolveAssetPath(req.params.canonicalId, req.params.asset);
    if (assetPath && fs.existsSync(assetPath)) {
      if (req.params.asset === "meta") {
        logCanvas(`Canvas metadata sent: meta file -> ${item.canonicalId}`);
        return res.json(canvasCatalogService.readRecordMeta(req.params.canonicalId));
      }

      if (req.params.asset === "canvas") {
        const directPath = path.join(canvasCatalogService.recordDir(item.canonicalId), item.file || "canvas.mp4");
        if (path.resolve(assetPath) !== path.resolve(directPath)) {
          logCanvas(`Canvas fallback release used: ${item.canonicalId} -> ${assetPath}`);
        }
        logCanvas(`Canvas video served: ${item.canonicalId}`);
      }

      return res.sendFile(assetPath);
    }

    if (req.params.asset === "canvas" && item.canvasUrl) {
      logCanvas(`Canvas video served (redirect): ${item.canonicalId}`);
      return res.redirect(302, item.canvasUrl);
    }

    if ((req.params.asset === "thumbnail" || req.params.asset === "thumb") && item.thumbnailUrl) {
      logCanvas(`Canvas metadata sent: thumbnail redirect -> ${item.canonicalId}`);
      return res.redirect(302, item.thumbnailUrl);
    }

    return res.status(404).json({ error: "Canvas asset not found" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/likes/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const connSource = req.provider || "android";
    const contentType = req.query.type === "video" ? "VIDEO" : req.query.type === "audio" ? "AUDIO" : null;
    const songs = await db.getLikedSongs(userId, parseInt(req.query.limit) || 0, connSource, contentType);
    res.json({ count: songs.length, songs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/likes/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const connSource = req.provider || "android";
    let { trackTitle, trackAuthor, trackAuthors, trackUrl, trackDuration, artworkUrl, isrc, explicit, genres, source } = req.body;

    // Separadores para detectar múltiples artistas en trackAuthor y feat.
    const artistSplit = /[,;&]|\s+&\s+|\s+y\s+|\s+e\s+|\s*\/\s*|\s+ duet\s+|\s+x\s+/i;
    const featRegex = /(?:\s*[\[\(])?(?:feat\.?|ft\.?|featuring|with)\s+([^\]\)]+)[\]\)]?/i;

    // 1. Extraer artistas desde trackAuthor (ej. "Bad Bunny, J Balvin, Arcángel")
    //    y desde el título (feat., ft., with)
    const allRaw = [
      ...trackAuthor.split(artistSplit),
      ...(trackTitle.match(featRegex)?.[1]?.split(artistSplit) || [])
    ].map(s => s.trim()).filter(Boolean);

    // 2. Deducir: primero es el principal, el resto son invitados
    const seen = new Map();
    const ordered = [];
    for (const a of allRaw) {
      const key = a.toLowerCase();
      if (!seen.has(key)) { seen.set(key, a); ordered.push(a); }
    }

    if (ordered.length >= 1) {
      trackAuthor = ordered[0];
      trackAuthors = ordered;
    }

    // 3. Buscar artistas completos vía Lavalink + fallback YouTube Music
    try {
      const searchQuery = `${trackAuthor} ${trackTitle}`;
      let searchArtists = [];

      // 3a. Intentar Lavalink primero
      const lavalinkTracks = await Promise.race([
        searchLavalink("ytmsearch", searchQuery).catch(() => []),
        new Promise(r => setTimeout(() => r([]), 2000))
      ]);
      if (lavalinkTracks.length > 0 && lavalinkTracks[0].author) {
        searchArtists = lavalinkTracks[0].author.split(artistSplit)
          .map(s => s.trim()).filter(Boolean);
      }

      // 3b. Si Lavalink no dio resultados, probar con YouTube Music directo
      if (searchArtists.length <= 1) {
        const ytResults = await innertube.searchTrack(trackAuthor, trackTitle);
        if (ytResults?.length > 0 && ytResults[0].authors?.length > 1) {
          searchArtists = ytResults[0].authors;
        }
      }

      if (searchArtists.length > trackAuthors.length) {
        const merged = new Map();
        for (const a of [...searchArtists, ...trackAuthors]) {
          const key = a.toLowerCase();
          if (!merged.has(key)) merged.set(key, a);
        }
        const combined = [...merged.values()];
        trackAuthor = combined[0];
        trackAuthors = combined;
      }
    } catch {}

    // 4. Limpiar feat del título
    trackTitle = trackTitle.replace(featRegex, '').replace(/\s{2,}/, ' ').trim();

    const mockTrack = {
      info: { title: trackTitle, author: trackAuthor, uri: trackUrl || "", duration: trackDuration || 0, artworkUrl: artworkUrl || "", explicit: explicit === true, genres: genres || [], sourceName: source || "ytmsearch" },
      pluginInfo: { isrc: isrc || null, trackAuthors: trackAuthors || [] }
    };
    const added = await db.addLikedSong(userId, mockTrack, connSource);
    res.json({ added });

    emitLibraryChanged(userId, connSource, "like-added", { trackUrl });

    // Clear home cache for instant updates
    homeAggregatorService.clearUserCache(userId, connSource);

    // Auto-enrich en background
    setImmediate(async () => {
      try {
        const enriched = await metadataEnricher.enrichSingleTrack(trackAuthor, trackTitle, isrc);
        if (enriched && enriched.confidence >= 3) {
          await db.updateLikedSongMetadata(userId, trackUrl, enriched, connSource);
          emitLibraryChanged(userId, connSource, "like-enriched", { trackUrl });
          console.log(`[MetadataPool] Auto-enriched liked track: ${trackTitle} - ${trackAuthor}`);
        }
      } catch (e) {
        console.warn(`[MetadataPool] Auto-enrich failed for ${trackTitle}: ${e.message}`);
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/likes/audio/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const connSource = req.provider || "android";
    const songs = await db.getLikedSongs(userId, parseInt(req.query.limit) || 0, connSource, "AUDIO");
    res.json({ count: songs.length, songs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/likes/video/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const connSource = req.provider || "android";
    const songs = await db.getLikedSongs(userId, parseInt(req.query.limit) || 0, connSource, "VIDEO");
    res.json({ count: songs.length, songs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/likes/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const { trackUrl } = req.body;
    const mockTrack = { info: { uri: trackUrl } };
    const removed = await db.removeLikedSongByTrack(userId, mockTrack, source);
    res.json({ removed });

    emitLibraryChanged(userId, source, "like-removed", { trackUrl });

    // Clear home cache for instant updates
    homeAggregatorService.clearUserCache(userId, source);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Liked Albums ─────────────────────────────────────────────────────
app.get("/api/albums/liked", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const albums = await db.getLikedAlbums(userId, source);
    res.json({ albums });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/albums/like", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { albumId, albumName, artistName, artworkUrl, albumUrl } = req.body;
    if (!albumId) return res.status(400).json({ error: "albumId is required" });
    const result = await db.toggleLikeAlbum(userId, { albumId, albumName, artistName, artworkUrl, albumUrl }, source);
    res.json(result);

    emitLibraryChanged(userId, source, "album-liked", { albumId, liked: !!result?.liked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/albums/liked/check", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { albumId } = req.query;
    if (!albumId) return res.status(400).json({ error: "albumId query param is required" });
    const liked = await db.isAlbumLiked(userId, albumId, source);
    res.json({ liked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Followed Artists ─────────────────────────────────────────────────
app.get("/api/artists/followed", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const artists = await db.getFollowedArtists(userId, source);
    const normalizedArtists = await Promise.all(artists.map(async (artist) => {
      const canonicalArtistId = await resolveCanonicalArtistId(artist.artistId, artist.artistName, userId);
      if (canonicalArtistId && canonicalArtistId !== artist.artistId) {
        await db.setFollowedArtistCanonicalId(userId, artist.artistId, canonicalArtistId, source).catch(() => null);
      }
      return {
        ...artist,
        id: canonicalArtistId || artist.artistId,
        artistId: canonicalArtistId || artist.artistId,
      };
    }));
    res.json({ artists: normalizedArtists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/artists/follow", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { artistId, artistName, imageUrl } = req.body;
    if (!artistId) return res.status(400).json({ error: "artistId is required" });
    const canonicalArtistId = await resolveCanonicalArtistId(artistId, artistName, userId);
    const result = await db.toggleFollowArtist(userId, { artistId: canonicalArtistId || artistId, artistName, imageUrl }, source);
    res.json({ ...result, artistId: canonicalArtistId || artistId });

    emitLibraryChanged(userId, source, "artist-followed", { artistId: canonicalArtistId || artistId, followed: !!result?.followed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/artists/followed/check", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { artistId, artistName } = req.query;
    if (!artistId) return res.status(400).json({ error: "artistId query param is required" });
    const canonicalArtistId = await resolveCanonicalArtistId(artistId, artistName, userId);
    const followed = await db.isArtistFollowed(userId, canonicalArtistId || artistId, source);
    res.json({ followed, artistId: canonicalArtistId || artistId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stats/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const stats = await db.getUserStats(userId, source);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/playlists/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const playlists = await db.getUserPlaylists(userId, source);
    res.json({ playlists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/playlists/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const { name, tracks } = req.body;
    const id = await db.savePlaylist(userId, name, tracks, source);
    res.json({ id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/playlist/:playlistId/tracks", requireApiKey, async (req, res) => {
  try {
    const playlistId = req.params.playlistId;
    const userId = req.userId || req.query.userId || "guest";
    if (!playlistId) return res.status(400).json({ error: "Missing playlistId" });

    let tracks = [];
    if (playlistId.startsWith("PL") || playlistId.startsWith("VL") || playlistId.startsWith("RD")) {
      tracks = await innertube.getPlaylistTracks(playlistId, userId);
    } else {
      tracks = await spotify.getPlaylist(playlistId);
    }
    
    res.json({ id: playlistId, tracks });
  } catch (err) {
    console.error("[playlist/tracks] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/album/:albumId", requireApiKey, async (req, res) => {
  try {
    const albumId = req.params.albumId;
    const userId = req.userId || req.query.userId || "guest";
    if (!albumId) return res.status(400).json({ error: "Missing albumId" });

    const tracks = await innertube.getAlbumTracks(albumId, userId);
    res.json({ id: albumId, tracks });
  } catch (err) {
    console.error("[album] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/artists/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const artists = await db.getLikedArtists(userId, source);
    res.json({ artists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/artist/images", requireApiKey, async (req, res) => {
  try {
    const names = req.body;
    if (!Array.isArray(names)) return res.status(400).json({ error: "Body must be an array of artist names" });
    const result = {};
    await Promise.all(names.map(async (name) => {
      try {
        const info = await spotify.searchArtistDeezer(name);
        result[name] = info?.image || null;
      } catch { result[name] = null; }
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/artist-image", requireApiKey, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing 'name'" });
    const cacheKey = name.trim().toLowerCase();
    const cached = artistImageCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ARTIST_IMAGE_CACHE_TTL) {
      return res.json(cached.data);
    }

    const result = await withInFlight(artistImageInFlight, cacheKey, async () => {
      const existing = artistImageCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < ARTIST_IMAGE_CACHE_TTL) {
        return existing.data;
      }

      const info = await spotify.searchArtistDeezer(name);
      const payload = { url: info?.image || null };
      artistImageCache.set(cacheKey, { data: payload, ts: Date.now() });
      return payload;
    });

    res.json(result);
  } catch (err) {
    res.json({ url: null });
  }
});

app.get("/api/artist-bio", requireApiKey, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing 'name' parameter" });

    const description = await spotify.getArtistDescription(name);
    if (!description) {
      return res.status(404).json({ error: "No description found for this artist" });
    }

    res.json({
      name,
      description: description.description,
      source: description.source,
      url: description.url,
    });
  } catch (err) {
    console.error("[artist-bio] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/artist/info", requireApiKey, async (req, res) => {
  try {
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: "Missing 'name' parameter" });

    const cached = artistInfoCache.get(name);
    if (cached) return res.json(cached);

    const result = await withInFlight(artistInfoInFlight, name, async () => {
      const existing = artistInfoCache.get(name);
      if (existing) return existing;

      const [deezerInfo, description, spotifyArtists] = await Promise.all([
        spotify.searchArtistDeezer(name),
        spotify.getArtistDescription(name),
        spotify.searchArtistsDirect(name, 3).catch(() => []),
      ]);

      if (!deezerInfo && !description && !spotifyArtists.length) {
        return null;
      }

      const spotifyArtist = spotifyArtists.find(a => a.name.toLowerCase() === name.toLowerCase())
        || spotifyArtists[0];

      const payload = {
        name: deezerInfo?.name || spotifyArtist?.name || name,
        image: deezerInfo?.image || spotifyArtist?.image || null,
        imageBig: deezerInfo?.imageBig || spotifyArtist?.image || null,
        imageXl: deezerInfo?.imageXl || spotifyArtist?.image || null,
        fans: deezerInfo?.fans || spotifyArtist?.followers || 0,
        albums: deezerInfo?.albums || 0,
        description: description?.description || null,
        descriptionSource: description?.source || null,
        descriptionUrl: description?.url || null,
        source: "deezer+wikipedia",
      };

      artistInfoCache.set(name, { ...payload, ts: Date.now() });
      console.log(`[artist/info] "${name}" → image:${payload.image ? payload.image.slice(0,60)+"..." : "null"} fans:${payload.fans} desc:${payload.description ? "✓" : "✗"} src:${payload.descriptionSource || "none"}`);
      return payload;
    });

    if (!result) return res.status(404).json({ error: "Artist not found" });
    res.json(result);
  } catch (err) {
    console.error("[artist/info] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Metadata Pool (Enriquecimiento Híbrido) ──────────────────────────

app.post("/api/metadata/enrich", requireApiKey, async (req, res) => {
  try {
    const { tracks } = req.body;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: "Missing or empty 'tracks' array" });
    }
    const batchSize = Math.min(tracks.length, 10);
    const enriched = await metadataEnricher.enrichTracks(tracks.slice(0, batchSize));
    res.json({ enriched: enriched.length, tracks: enriched });
  } catch (err) {
    console.error("[Metadata/Enrich] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/metadata/pool", requireApiKey, async (req, res) => {
  try {
    const { q, limit } = req.query;
    const connSource = req.provider || "android";

    const cacheKey = `${connSource}:${q || ""}:${parseInt(limit) || 50}`;
    const cached = metadataPoolCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < METADATA_POOL_CACHE_TTL) {
      return res.json(cached.data);
    }

    const result = await withInFlight(metadataPoolInFlight, cacheKey, async () => {
      const existing = metadataPoolCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < METADATA_POOL_CACHE_TTL) {
        return existing.data;
      }

      let results;
      if (q) {
        const fp = metadataEnricher.createFingerprint(q, q);
        const byFp = await db.getMetadataPool(fp, connSource);
        if (byFp) {
          results = [byFp];
        } else {
          const filter = {
            $or: [
              { trackTitle: { $regex: q, $options: "i" } },
              { trackAuthor: { $regex: q, $options: "i" } },
            ]
          };
          results = await db.queryMetadataPool(filter, parseInt(limit) || 50, connSource);
        }
      } else {
        results = await db.queryMetadataPool({}, parseInt(limit) || 50, connSource);
      }

      const payload = { count: results.length, entries: results };
      metadataPoolCache.set(cacheKey, { data: payload, ts: Date.now() });
      return payload;
    });

    res.json(result);
  } catch (err) {
    console.error("[Metadata/Pool] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/metadata/sync", requireApiKey, async (req, res) => {
  try {
    const { since } = req.query;
    const connSource = req.provider || "android";
    if (!since) return res.status(400).json({ error: "Missing 'since' query param (ISO timestamp)" });

    const cacheKey = `${connSource}:${since}`;
    const cached = metadataSyncCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < METADATA_SYNC_CACHE_TTL) {
      return res.json(cached.data);
    }

    const result = await withInFlight(metadataSyncInFlight, cacheKey, async () => {
      const existing = metadataSyncCache.get(cacheKey);
      if (existing && Date.now() - existing.ts < METADATA_SYNC_CACHE_TTL) {
        return existing.data;
      }

      const entries = await db.getMetadataPoolChangesSince(since, connSource);
      const payload = { count: entries.length, entries };
      metadataSyncCache.set(cacheKey, { data: payload, ts: Date.now() });
      return payload;
    });

    res.json(result);
  } catch (err) {
    console.error("[Metadata/Sync] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/enrich-all-likes", requireApiKey, async (req, res) => {
  try {
    const { userId } = req.body;
    const connSource = req.provider || "android";
    if (!userId) return res.status(400).json({ error: "userId required" });
    const allLikes = await db.getLikedSongs(userId, 0, connSource);
    res.json({ queued: allLikes.length, message: "Enriching in background" });

    setImmediate(async () => {
      let enriched = 0;
      for (const song of allLikes) {
        try {
          const result = await metadataEnricher.enrichSingleTrack(
            song.track_author, song.track_title, song.isrc
          );
          if (result && result.confidence >= 3) {
            await db.updateLikedSongMetadata(userId, song.track_url, result, connSource);
            enriched++;
          }
        } catch (e) {
          console.warn(`[Metadata/Admin] Failed: ${song.track_title} - ${e.message}`);
        }
      }
      if (enriched > 0) {
        emitLibraryChanged(userId, connSource, "library-enriched", { enriched });
      }
      console.log(`[Metadata/Admin] Enriched ${enriched}/${allLikes.length} liked songs for user ${userId}`);
    });
  } catch (err) {
    console.error("[Metadata/Admin] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/home/sections", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.query.userId || "guest";
    const source = req.provider || req.query.source || "android";
    if (userId !== "guest") {
      req.userId = userId;
      const hasYtmCookies = !!(req.headers["x-ytm-cookie"] || req.headers["x-ytm-sapisid"] || req.headers["x-ytm-active"]);
      extractYtmCookies(req);
      if (hasYtmCookies) {
        homeAggregatorService.clearUserCache(userId, source);
        innertube.clearHomeFeedCache(userId);
      }
    }
    const result = await homeAggregatorService.getHomeSections(userId, source);
    res.json({ sections: result?.sections || [] });
  } catch (err) {
    console.error("Home sections error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/home", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.body.userId || "guest";
    const source = req.provider || req.body.source || "android";
    if (userId !== "guest") {
      req.userId = userId;
      const hasYtmCookies = !!(req.headers["x-ytm-cookie"] || req.headers["x-ytm-sapisid"] || req.headers["x-ytm-active"]);
      extractYtmCookies(req);
      if (hasYtmCookies) {
        homeAggregatorService.clearUserCache(userId, source);
        innertube.clearHomeFeedCache(userId);
      }
    }
    const result = await homeAggregatorService.getHomeSections(userId, source);
    res.json({ sections: result?.sections || [] });
  } catch (err) {
    console.error("Home POST error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/recommendations/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const liked = await db.getLikedSongs(userId, 5, source);
    if (!liked.length) return res.json({ tracks: [] });
    const spotifyTracks = await spotify.searchTracks(`${liked[0].track_title} ${liked[0].track_author}`, 5);
    const seedIds = spotifyTracks.map(t => t.id).filter(Boolean).slice(0, 5);
    const recs = seedIds.length ? await spotify.getRecommendations(seedIds) : [];
    res.json({ tracks: recs });
  } catch (err) {
    res.json({ tracks: [] });
  }
});

app.get("/api/radio/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const mixes = await radioService.getMixes(userId, source);
    res.json({ sections: mixes });
  } catch (err) {
    console.error("Radio Error:", err.stack || err.message);
    res.status(500).json({ sections: [] });
  }
});

app.get("/api/radio", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.query.userId || "guest";
    const source = req.provider || req.query.source || "android";
    const mixes = await radioService.getMixes(userId, source);
    res.json({ sections: mixes });
  } catch (err) {
    console.error("Radio Error:", err.stack || err.message);
    res.status(500).json({ sections: [] });
  }
});

app.get("/api/top-tracks/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const tracks = await db.getMostPlayedTracks(userId, parseInt(req.query.limit) || 10, source);
    res.json({ tracks });
  } catch (err) {
    res.json({ tracks: [] });
  }
});


app.get("/api/recent-playback/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const playback = await db.getRecentPlayback(userId, limit, source);
    res.json({ playback });
  } catch (err) {
    console.error("Recent Playback Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recent-playback/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const { trackTitle, trackAuthor, trackUrl, trackDuration, artworkUrl } = req.body;
    if (!trackTitle) return res.status(400).json({ error: "trackTitle is required" });

    const track = {
      trackTitle,
      trackAuthor: trackAuthor || "",
      trackUrl: trackUrl || "",
      trackDuration: trackDuration || 0,
      artworkUrl: artworkUrl || "",
    };
    await db.addRecentPlayback(userId, track, source);
    res.json({ added: true });

    // Clear home cache for instant update of Listen Again/Quick Picks
    homeAggregatorService.clearUserCache(userId, source);
  } catch (err) {
    console.error("Recent Playback Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/recent-playback/:userId", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";
    const result = await db.clearRecentPlayback(userId, source);
    res.json(result);
  } catch (err) {
    console.error("Recent Playback Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/history/:userId/sync", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId || req.params.userId;
    const source = req.provider || "android";

    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be an array of HistoryEntryDto" });
    }

    const synced = await db.syncHistory(userId, req.body, source);
    res.json({ count: synced.length, history: synced });
  } catch (err) {
    console.error("Sync History Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Init (carga inicial premium: perfil + todos los datos) ─────────────
app.get("/api/init", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const mongoId = req.mongoId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const [userData, likedSongs, likedAlbums, followedArtists, playlists, recentPlayback, stats] = await Promise.all([
      (async () => {
        const UserModel = source === "discord" && DiscordUser ? DiscordUser : User;
        const u = await UserModel.findById(mongoId).lean();
        return u ? { id: u._id.toString(), username: u.username, email: u.email, avatar: u.avatar, discordId: u.discordId, googleId: u.googleId, createdAt: u.createdAt } : null;
      })(),
      db.getLikedSongs(userId, 200, source).catch(() => []),
      db.getLikedAlbums(userId, source).catch(() => []),
      db.getFollowedArtists(userId, source).catch(() => []),
      db.getUserPlaylists(userId, source).catch(() => []),
      db.getRecentPlayback(userId, 50, source).catch(() => []),
      db.getUserStats(userId, source).catch(() => null),
    ]);

    res.json({ user: userData, likedSongs, likedAlbums, followedArtists, playlists, recentPlayback, stats });
  } catch (err) {
    console.error("Init Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post("/api/sync", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const mongoId = req.mongoId;
    const source = req.provider || "android";
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const result = await db.syncUserData(userId, req.body, source);

    const UserModel = source === "discord" && DiscordUser ? DiscordUser : User;
    const user = await UserModel.findById(mongoId).lean();
    if (user) {
      result.user = {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        discordId: user.discordId,
        googleId: user.googleId,
        createdAt: user.createdAt,
      };
    }

    res.json(result);

    emitLibraryChanged(userId, source, "sync-updated", {
      synced: true,
      sections: Object.keys(req.body || {}),
    });
  } catch (err) {
    console.error("Sync Error:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── Auth routes ──────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const JWT_EXPIRES = "30d";

function signToken(user, provider = "android") {
  const payload = { sub: user._id.toString(), provider };
  if (provider === "discord" && user.discordId) {
    payload.discordId = user.discordId;
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function resolveGoogleRedirect(req) {
  const fallback = process.env.CLIENT_URL || "auris://auth";
  const state = req.query?.state;
  if (!state) return fallback;

  try {
    const decoded = decodeURIComponent(state);
    const uri = new URL(decoded);
    const isLoopback = uri.hostname === "127.0.0.1" || uri.hostname === "localhost";
    if ((uri.protocol === "http:" || uri.protocol === "https:") && isLoopback) {
      return uri.toString().replace(/\/$/, "");
    }
  } catch {}

  return fallback;
}

function getAbsoluteBaseUrl(req) {
  const envBase = process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_URL || process.env.CLIENT_URL;
  if (envBase && /^https?:\/\//i.test(envBase)) {
    return envBase.replace(/\/+$/, "");
  }

  const host = req?.get?.("host") || req?.headers?.host;
  if (host) {
    const proto = (req?.headers?.["x-forwarded-proto"] || req?.protocol || "http").split(",")[0].trim();
    return `${proto}://${host}`.replace(/\/+$/, "");
  }

  return "http://localhost:3000";
}

function getGoogleCallbackUrl(req) {
  return process.env.GOOGLE_CALLBACK_URL || `${getAbsoluteBaseUrl(req)}/api/auth/google/callback`;
}

function googleAuthOptions(req) {
  return {
    session: false,
    scope: ["profile", "email"],
    callbackURL: getGoogleCallbackUrl(req),
    state: req.query?.state,
  };
}

function sendGoogleAuthResult(req, res, user) {
  const token = signToken(user);
  const redirectUri = resolveGoogleRedirect(req);

  const ua = (req.headers["user-agent"] || "").toLowerCase();
  if (ua.includes("okhttp") || ua.includes("dalvik") || ua.includes("android")) {
    return res.json({ token, user: user.toPublicJSON() });
  }

  return res.redirect(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);
}

// ── Discord OAuth Strategy ────────────────────────────────────────────
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL || "http://192.168.18.81:3000/api/auth/discord/callback",
  scope: ["identify", "email"],
}, async (accessToken, refreshToken, profile, done) => {
  try {
    if (!DiscordUser) return done(new Error("Discord database not configured"));
    let user = await DiscordUser.findOne({ discordId: profile.id });
    if (user) return done(null, user);

    const email = normalizeEmail(profile.email);
    if (email) {
      user = await DiscordUser.findOne({ email });
      if (user) {
        user.discordId = profile.id;
        if (!user.avatar && profile.avatar) user.avatar = `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`;
        await user.save();
        return done(null, user);
      }
    }

    user = await DiscordUser.create({
      username: profile.username || profile.global_name || `discord_${profile.id}`,
      email,
      discordId: profile.id,
      avatar: profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : "",
    });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

// ── Google OAuth Strategy ─────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL || "/api/auth/google/callback",
  scope: ["profile", "email"],
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user;
    // 1. Priorizar email para unificar cuentas entre providers
    const email = normalizeEmail(profile.emails?.[0]?.value);
    if (email) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = profile.id;
        if (!user.avatar && profile.photos?.[0]?.value) {
          user.avatar = profile.photos[0].value;
        }
        await user.save();
        return done(null, user);
      }
    }

    // 2. Si no había email o no existía la cuenta, buscar por googleId
    user = await User.findOne({ googleId: profile.id });
    if (user) return done(null, user);

    // 3. Crear nuevo usuario
    user = await User.create({
      username: profile.displayName || profile.name?.givenName || `google_${profile.id}`,
      email,
      googleId: profile.id,
      avatar: profile.photos?.[0]?.value || "",
    });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "username, email, and password are required" });
    }

    const normalizedEmail = normalizeEmail(email);

    const existing = await User.findOne({ email: normalizedEmail }).exec();
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const user = await User.create({ username, email: normalizedEmail, password });
    const token = signToken(user);
    res.status(201).json({ token, user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).exec();
    if (!user || !user.password) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signToken(user);
    res.json({ token, user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const UserModel = req.provider === "discord" && DiscordUser ? DiscordUser : User;
    const user = await UserModel.findById(req.mongoId).exec();
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user: user.toPublicJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Discord OAuth routes ──────────────────────────────────────────────
app.get("/api/auth/discord", passport.authenticate("discord", { session: false }));

app.get("/api/auth/discord/callback", (req, res, next) => {
  passport.authenticate("discord", { session: false }, (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: "auth_failed" });
    }
    const token = signToken(user, "discord");
    const clientUrl = process.env.CLIENT_URL || "auris://auth";

    // App (HTTP nativo): JSON directo. Navegador/WebView: 302 redirect
    const ua = (req.headers["user-agent"] || "").toLowerCase();
    if (ua.includes("okhttp") || ua.includes("dalvik")) {
      return res.json({ token, user: user.toPublicJSON() });
    }
    res.redirect(`${clientUrl}?token=${encodeURIComponent(token)}`);
  })(req, res, next);
});

app.get("/api/auth/google/callback", (req, res, next) => {
  passport.authenticate("google", { session: false }, (err, user) => {
    if (err || !user) {
      console.error("[Google OAuth] Error:", err?.message);
      return res.status(401).json({ error: "auth_failed" });
    }
    sendGoogleAuthResult(req, res, user);
  })(req, res, next);
});

// ── Google OAuth routes ───────────────────────────────────────────────
// Endpoint para Android (Native Google Sign-In)
app.post("/api/auth/google", async (req, res) => {
  try {
    const { id_token } = req.body;
    const idToken = id_token || req.body.idToken; // Soporta ambos formatos por si acaso

    if (!idToken) return res.status(400).json({ error: "idToken is required" });

    // Verificar token con Google API (Sin librerías extra)
    const googleRes = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    const payload = googleRes.data;

    if (!payload || googleRes.status !== 200) {
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const { sub: googleId, email: rawEmail, name, picture } = payload;
    const email = normalizeEmail(rawEmail);

    // 1. Priorizar email para unir cuentas Google/email-password
    let user = email ? await User.findOne({ email }) : null;
    if (!user) {
      user = await User.findOne({ googleId });
    }

    if (!user) {
      user = await User.create({
        username: name || `google_${googleId}`,
        email,
        googleId,
        avatar: picture || "",
      });
    } else {
      let needsSave = false;
      if (email && !user.email) {
        user.email = email;
        needsSave = true;
      }
      if (!user.googleId) {
        user.googleId = googleId;
        needsSave = true;
      }
      if (!user.avatar) {
        user.avatar = picture || "";
        needsSave = true;
      }
      if (needsSave) await user.save();
    }

    // 2. Extraer cookies YTM si el cliente las envía en el body o headers
    req.userId = user._id.toString();
    extractYtmCookies(req);

    // 3. Generar JWT y responder
    const token = signToken(user);
    res.json({ token, user: user.toPublicJSON() });

  } catch (err) {
    console.error("[Google Auth POST] Error:", err.response?.data || err.message);
    res.status(401).json({ error: "Google authentication failed" });
  }
});

app.get("/api/auth/google", (req, res, next) => {
  passport.authenticate("google", googleAuthOptions(req))(req, res, next);
});

app.get("/api/auth/google/callback", (req, res, next) => {
  passport.authenticate("google", googleAuthOptions(req), (err, user) => {
    if (err || !user) {
      console.error("[Google OAuth] Error:", err?.message);
      return res.status(401).json({ error: "auth_failed" });
    }
    sendGoogleAuthResult(req, res, user);
  })(req, res, next);
});

// ── Event Tracking ─────────────────────────────────────────────────────────
app.post("/api/events", requireApiKey, async (req, res) => {
  try {
    const body = req.body;
    if (!body.userId && req.userId) body.userId = req.userId;
    if (!body.source) body.source = req.provider || "android";

    if (Array.isArray(body.events)) {
      const result = await eventCollectorService.recordBatch(body.events);
      return res.json(result);
    }

    const result = await eventCollectorService.recordEvent(body);
    res.json(result);
  } catch (err) {
    console.error("[Events] Error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/events/performance", requireApiKey, async (req, res) => {
  try {
    const { reasonKey } = req.query;

    if (req.query.compute === "true") {
      await rulePerformanceStore.maybeCompute();
    }

    const data = reasonKey
      ? await rulePerformanceStore.getPerformanceByReasonKey(reasonKey)
      : await rulePerformanceStore.getAllPerformance();

    res.json({ metrics: data || [] });
  } catch (err) {
    console.error("[Events/Performance] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ytm/validate", requireApiKey, async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const cookieStr = innertube.resolveCookieString(userId);
    if (!cookieStr) return res.json({ valid: false, reason: "no_cookies" });

    await innertube.apiRequest("browse", { browseId: "FEmusic_home" }, {}, userId, true);
    res.json({ valid: true });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      return res.json({ valid: false, reason: "expired" });
    }
    console.error("[YTM Validate] Error:", err.message);
    res.json({ valid: false, reason: "error" });
  }
});

// Global error handler
app.use(function (err, req, res, next) {
  console.error("[ERROR] global handler:", err.stack || err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

module.exports = { app };
