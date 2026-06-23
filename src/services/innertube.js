const tough = require("tough-cookie");
const axios = require("axios");
const http = require("http");
const https = require("https");
const querystring = require("querystring");
const crypto = require("crypto");

const KEEP_ALIVE_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 60000,
});

const USER_AGENT_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const USER_AGENT_ANDROID_VR = "com.google.android.apps.youtube.vr.oculus/1.37 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)";
const USER_AGENT_IOS = "com.google.ios.youtube/20.05.5 (iPhone14,3; U; CPU iOS 18_4_0 like Mac OS X; en_US)";
const USER_AGENT_ANDROID_MUSIC = "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 15; en_US; Pixel 9 Pro; Build/BP1A.250305.001; Cronet/137.0.7185.0)";
const INNERTUBE_CLIENT = (process.env.INNERTUBE_CLIENT || "ANDROID_VR").toUpperCase();
const YTM_BASE = "https://music.youtube.com";
const YT_BASE = "https://www.youtube.com";
const API_VERSION = "v1";
const API_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

let config = null;
let initPromise = null;
let refreshInterval = null;
let cookieJar = new tough.CookieJar();
let userCookieString = null;
let USER_AGENT = USER_AGENT_ANDROID_VR;
let initFailureUntil = 0;
let initFailureMessage = null;
const userCookiesMap = new Map();
const userDataSyncIdMap = new Map();
const userVisitorDataMap = new Map();
const requestCounts = { search: 0, player: 0 };
let lastReset = Date.now();
const sessionChangeListeners = new Set();

const homeFeedCache = new Map();
const HOME_FEED_CACHE_TTL = 5 * 60 * 1000;
const homeFeedInFlight = new Map();

const SEPARATOR_RE = /\s*[•,|/]\s*/;

// --- PoToken Generator (port from OpenTune PoTokenGenerator.kt) ---
function generatePoToken(identifier, clientState = "") {
  const TOKEN_VERSION = 0x22;
  const MAGIC_HEADER = 0x0A;
  const INNER_TAG = 0x38;
  const TIMESTAMP_TAG = 0x02;

  const keyBytes = crypto.randomBytes(16);
  const idBuf = Buffer.from(identifier, "utf-8");
  const stateBuf = Buffer.from(clientState, "utf-8");

  const encryptedId = Buffer.alloc(idBuf.length);
  for (let i = 0; i < idBuf.length; i++) {
    encryptedId[i] = idBuf[i] ^ keyBytes[i % 16];
  }

  const tsBuf = Buffer.alloc(8);
  const ts = Date.now();
  for (let i = 0; i < 8; i++) {
    tsBuf[i] = (ts >> (i * 8)) & 0xFF;
  }
  let tsLen = 8;
  while (tsLen > 1 && tsBuf[tsLen - 1] === 0) tsLen--;
  const tsTrimmed = tsBuf.subarray(0, tsLen);

  const innerParts = [];
  innerParts.push(INNER_TAG);
  innerParts.push(...encodeVarInt(stateBuf.length));
  innerParts.push(...stateBuf);
  innerParts.push(TIMESTAMP_TAG);
  innerParts.push(...encodeVarInt(tsTrimmed.length));
  innerParts.push(...tsTrimmed);
  const innerPayload = Buffer.from(innerParts);

  const payloadParts = [];
  payloadParts.push(MAGIC_HEADER);
  payloadParts.push(...encodeVarInt(keyBytes.length));
  payloadParts.push(...keyBytes);
  payloadParts.push(TOKEN_VERSION);
  payloadParts.push(...encodeVarInt(encryptedId.length));
  payloadParts.push(...encryptedId);
  payloadParts.push(...innerPayload);
  const payload = Buffer.from(payloadParts);

  return payload.toString("base64url").replace(/=+$/, "");
}

function encodeVarInt(value) {
  const bytes = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v | 0x80) & 0xFF);
    v >>>= 7;
  }
  bytes.push(v & 0xFF);
  return bytes;
}

function generateSessionPoToken(identifier) {
  return generatePoToken(identifier, "session");
}

function generateContentPoToken(identifier, videoId) {
  return generatePoToken(identifier, videoId);
}

// --- Failed stream clients backoff (10 min) ---
const STREAM_FAILED_CLIENTS = new Map();

function markStreamClientFailed(videoId, clientName) {
  STREAM_FAILED_CLIENTS.set(`${videoId}:${clientName}`, Date.now() + 10 * 60 * 1000);
}

function isStreamClientBlocked(videoId, clientName) {
  const until = STREAM_FAILED_CLIENTS.get(`${videoId}:${clientName}`);
  if (!until) return false;
  if (until <= Date.now()) {
    STREAM_FAILED_CLIENTS.delete(`${videoId}:${clientName}`);
    return false;
  }
  return true;
}

// --- Cached signature timestamp ---
let cachedSigTimestamp = null;
let cachedSigTimestampExpiry = 0;

const playlistTracksCache = new Map();
const PLAYLIST_TRACKS_CACHE_TTL = 5 * 60 * 1000;
const playlistTracksInFlight = new Map();

const albumDetailsCache = new Map();
const ALBUM_DETAILS_CACHE_TTL = 5 * 60 * 1000;
const albumDetailsInFlight = new Map();

function resolveClientConfig(clientName = INNERTUBE_CLIENT) {
  switch ((clientName || INNERTUBE_CLIENT).toUpperCase()) {
    case "WEB_REMIX":
      return {
        clientName: "WEB_REMIX",
        clientNameValue: 67,
        clientVersion: "1.20260114.01.00",
        userAgent: USER_AGENT_WEB,
      };
    case "ANDROID_MUSIC":
      return {
        clientName: "ANDROID_MUSIC",
        clientNameValue: 21,
        clientVersion: "7.27.52",
        userAgent: USER_AGENT_ANDROID_MUSIC,
      };
    case "IOS_MUSIC":
      return {
        clientName: "IOS_MUSIC",
        clientNameValue: 26,
        clientVersion: "20.05.5",
        userAgent: USER_AGENT_IOS,
      };
    case "TVHTML5":
      return {
        clientName: "TVHTML5",
        clientNameValue: 7,
        clientVersion: "1.20250310.00.00",
        userAgent: USER_AGENT_WEB,
      };
    case "IOS":
      return {
        clientName: "IOS",
        clientNameValue: 5,
        clientVersion: "19.29.1",
        userAgent: USER_AGENT_IOS,
      };
    case "MOBILE":
    case "ANDROID":
      return {
        clientName: "ANDROID",
        clientNameValue: 3,
        clientVersion: "21.10.38",
        userAgent: USER_AGENT_ANDROID_MUSIC,
      };
    case "ANDROID_VR_NO_AUTH":
      return {
        clientName: "ANDROID_VR",
        clientNameValue: 28,
        clientVersion: "1.37",
        userAgent: USER_AGENT_ANDROID_VR,
      };
    case "ANDROID_VR":
    default:
      return {
        clientName: "ANDROID_VR",
        clientNameValue: 28,
        clientVersion: "1.37",
        userAgent: USER_AGENT_ANDROID_VR,
      };
  }
}

const PLAYER_STREAM_CLIENTS = [
  "ANDROID_VR",
  "ANDROID_MUSIC",
  "IOS",
  "IOS_MUSIC",
  "MOBILE",
  "TVHTML5",
];

const PLAYER_LOGGED_IN_FILTER = new Set(["ANDROID_MUSIC", "IOS_MUSIC", "TVHTML5", "MOBILE"]);

function checkRateLimit(endpoint) {
  const now = Date.now();
  if (now - lastReset > 1000) {
    requestCounts.search = 0;
    requestCounts.player = 0;
    lastReset = now;
  }
  requestCounts[endpoint] = (requestCounts[endpoint] || 0) + 1;
  const limits = { search: 10, player: 5 };
  if (requestCounts[endpoint] > limits[endpoint]) {
    throw new Error(`Rate limited: ${endpoint} (${limits[endpoint]}/s)`);
  }
}

const playerCache = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;

async function initialize() {
  if (config) return config;
  if (initFailureUntil && Date.now() < initFailureUntil) {
    throw new Error(initFailureMessage || "InnerTube initialization throttled");
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const sources = [YTM_BASE, YT_BASE];
      let ytcfg = null;
      let response = null;

      for (const baseUrl of sources) {
        try {
          const res = await axios.get(`${baseUrl}/`, {
            headers: { "User-Agent": USER_AGENT_WEB, "Accept-Language": "en-US" },
            timeout: 10000,
          });
          const parsed = {};
          res.data.split("ytcfg.set(").forEach(v => {
            try { Object.assign(parsed, JSON.parse(v.split(");")[0])); } catch {}
          });
          if (parsed.INNERTUBE_API_KEY) {
            response = res;
            ytcfg = parsed;
            break;
          }
        } catch (err) {
          console.warn(`[InnerTube] init probe failed for ${baseUrl}: ${err.message}`);
        }
      }

      if (!ytcfg?.INNERTUBE_API_KEY) throw new Error("Could not extract ytcfg from YouTube Music or YouTube");
      cookieJar = new tough.CookieJar();
      const setCookie = response.headers["set-cookie"];
      if (setCookie) {
        const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
        cookies.forEach(c => {
          try { cookieJar.setCookieSync(tough.Cookie.parse(c), YTM_BASE); } catch {}
        });
      }
      const client = resolveClientConfig();
      USER_AGENT = client.userAgent;
      initFailureUntil = 0;
      initFailureMessage = null;
      const liveClientVersion = ytcfg.INNERTUBE_CONTEXT_CLIENT_VERSION || ytcfg.INNERTUBE_CLIENT_VERSION;
      if (liveClientVersion && client.clientName === "WEB_REMIX") {
        client.clientVersion = liveClientVersion;
      }
      config = {
        apiKey: ytcfg.INNERTUBE_API_KEY,
        apiVersion: ytcfg.INNERTUBE_API_VERSION || API_VERSION,
        ...client,
        visitorData: ytcfg.VISITOR_DATA,
        hl: ytcfg.HL || "en",
        gl: process.env.REGION || ytcfg.GL || "PE",
      };
      await autoObtainGuestCookies();
      startRefreshTimer();
      console.log(`[InnerTube] Initialized: client=${config.clientName} v${config.clientVersion}`);
      return config;
    } catch (err) {
      initPromise = null;
      initFailureMessage = err.message;
      initFailureUntil = Date.now() + 60_000;
      console.warn(`[InnerTube] Initialization failed: ${err.message}${err.response ? ` (${err.response.status})` : ""}`);
      throw err;
    }
  })();
  return initPromise;
}

function setCookies(cookieString, userId) {
  if (!cookieString) return false;
  if (userId) {
    const prev = userCookiesMap.get(userId);
    if (prev !== cookieString) {
      clearUserCaches(userId);
      userCookiesMap.set(userId, cookieString);
      notifySessionChange(userId, cookieString, prev || null);
      // Refresh cached auth metadata for this user.
      extractDataSyncId(cookieString).then(dsId => {
        if (dsId) userDataSyncIdMap.set(userId, dsId);
      });
      return true;
    }
    return false;
  } else {
    if (userCookieString !== cookieString) {
      const prev = userCookieString;
      userCookieString = cookieString;
      clearUserCaches("__global__");
      notifySessionChange("__global__", cookieString, prev || null);
      // Refresh cached auth metadata for the global fallback.
      extractDataSyncId(cookieString).then(dsId => {
        if (dsId) userDataSyncIdMap.set("__global__", dsId);
      });
      return true;
    }
    return false;
  }
}

function removeCookies(userId) {
  if (userId) {
    const prev = userCookiesMap.get(userId) || null;
    userCookiesMap.delete(userId);
    userDataSyncIdMap.delete(userId);
    userVisitorDataMap.delete(userId);
    clearUserCaches(userId);
    notifySessionChange(userId, null, prev);
  } else {
    const prev = userCookieString;
    userCookieString = null;
    userDataSyncIdMap.clear();
    userVisitorDataMap.clear();
    clearUserCaches("__global__");
    notifySessionChange("__global__", null, prev || null);
  }
}

function notifySessionChange(userId, cookieString, previousCookieString) {
  for (const listener of sessionChangeListeners) {
    try {
      listener({ userId, cookieString, previousCookieString });
    } catch (err) {
      console.warn(`[InnerTube] session change listener failed: ${err.message}`);
    }
  }
}

function onSessionChange(listener) {
  if (typeof listener !== "function") return () => {};
  sessionChangeListeners.add(listener);
  return () => sessionChangeListeners.delete(listener);
}

function resolveCookieString(userId) {
  if (userId && userCookiesMap.has(userId)) return userCookiesMap.get(userId);
  return userCookieString;
}

async function extractDataSyncId(cookieString) {
  if (!cookieString) return null;
  try {
    const res = await axios.get(`${YTM_BASE}/`, {
      headers: { "User-Agent": USER_AGENT, "Cookie": cookieString, "Accept-Language": "en-US" },
      timeout: 10000,
    });
    let ytcfg = {};
    res.data.split("ytcfg.set(").forEach(v => {
      try { Object.assign(ytcfg, JSON.parse(v.split(");")[0])); } catch {}
    });
    const raw = ytcfg.DATASYNC_ID;
    if (raw) {
      const value = raw.includes("||") ? raw.split("||")[0] : raw;
      console.log(`[InnerTube] dataSyncId extracted (len=${value.length})`);
      return value;
    }
    console.warn("[InnerTube] DATASYNC_ID not found in ytcfg");
    return null;
  } catch (e) {
    console.warn(`[InnerTube] Failed to extract dataSyncId: ${e.message}`);
    return null;
  }
}

function resolveDataSyncId(userId) {
  if (userId && userDataSyncIdMap.has(userId)) return userDataSyncIdMap.get(userId);
  return null;
}

function resolveVisitorData(userId) {
  if (userId && userVisitorDataMap.has(userId)) return userVisitorDataMap.get(userId);
  if (userVisitorDataMap.has("__global__")) return userVisitorDataMap.get("__global__");
  return config?.visitorData || null;
}

function setDataSyncId(dataSyncId, userId) {
  if (!dataSyncId) return;
  const key = userId || "__global__";
  if (userDataSyncIdMap.get(key) !== dataSyncId) {
    userDataSyncIdMap.set(key, dataSyncId);
    console.log(`[InnerTube] dataSyncId set for ${key} (len=${dataSyncId.length})`);
  }
}

function setVisitorData(visitorData, userId) {
  if (!visitorData) return;
  const key = userId || "__global__";
  if (userVisitorDataMap.get(key) !== visitorData) {
    userVisitorDataMap.set(key, visitorData);
    console.log(`[InnerTube] visitorData set for ${key} (len=${visitorData.length})`);
  }
}

function clearUserCaches(userId) {
  homeFeedCache.delete(userId);
  playlistTracksCache.forEach((entry, key) => {
    if (key.startsWith(`${userId}:`)) playlistTracksCache.delete(key);
  });
  albumDetailsCache.forEach((entry, key) => {
    if (key.startsWith(`${userId}:`)) albumDetailsCache.delete(key);
  });
}

async function autoObtainGuestCookies() {
  try {
    const sources = [
      { url: YTM_BASE, jarUrl: YTM_BASE },
      { url: YT_BASE, jarUrl: YT_BASE },
    ];
    let cookieCount = 0;
    for (const { url, jarUrl } of sources) {
      try {
        const res = await axios.get(`${url}/`, {
          headers: { "User-Agent": USER_AGENT_WEB, "Accept-Language": "en-US" },
          timeout: 10000,
        });
        const setCookie = res.headers["set-cookie"];
        if (setCookie) {
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const c of cookies) {
            try {
              cookieJar.setCookieSync(tough.Cookie.parse(c), jarUrl);
              cookieCount++;
            } catch {}
          }
        }
      } catch (err) {
        if (err.response?.headers?.["set-cookie"]) {
          const setCookie = err.response.headers["set-cookie"];
          const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
          for (const c of cookies) {
            try {
              cookieJar.setCookieSync(tough.Cookie.parse(c), jarUrl);
              cookieCount++;
            } catch {}
          }
        }
      }
    }
    if (cookieCount > 0) {
      const jarStr = cookieJar.getCookieStringSync(YTM_BASE);
      if (jarStr && !userCookieString) {
        userCookieString = jarStr;
        console.log(`[InnerTube] Guest cookies obtained: ${cookieCount} cookies, len=${jarStr.length}`);
      }
    }
    return cookieCount > 0;
  } catch (e) {
    console.warn(`[InnerTube] Failed to obtain guest cookies: ${e.message}`);
    return false;
  }
}

function startRefreshTimer() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    try {
      initPromise = null;
      config = null;
      playerCache.clear();
      userCookieString = null;
      await initialize();
      console.log("[InnerTube] Config refreshed");
    } catch (e) {
      console.warn(`[InnerTube] Periodic refresh failed: ${e.message}`);
    }
  }, 30 * 60 * 1000);
  if (refreshInterval.unref) refreshInterval.unref();
}

function buildContext(userId, includeAuth, clientOverride) {
  const clientConfig = clientOverride || config;
  const dataSyncId = includeAuth ? resolveDataSyncId(userId) : null;
  return {
    client: {
      clientName: clientConfig.clientName,
      clientVersion: clientConfig.clientVersion,
      hl: config.hl,
      gl: config.gl,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      visitorData: resolveVisitorData(userId) || undefined,
    },
    capabilities: {},
    request: {
      internalExperimentFlags: [],
      sessionIndex: {},
    },
    user: {
      lockedSafetyMode: false,
      onBehalfOfUser: dataSyncId || undefined,
    },
  };
}

function extractSapisidValue(cookieStr) {
  if (!cookieStr) return null;
  const patterns = [
    /__Secure-3PAPISID\s*=\s*([^;]+)/,
    /__Secure-1PAPISID\s*=\s*([^;]+)/,
    /SAPISID\s*=\s*([^;]+)/,
    /APISID\s*=\s*([^;]+)/,
  ];
  for (const p of patterns) {
    const m = cookieStr.match(p);
    if (m) return m[1];
  }
  return null;
}

function generateSapisidHash(cookieStr, origin = YTM_BASE) {
  const sapisid = extractSapisidValue(cookieStr);
  if (!sapisid) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash("sha1").update(`${timestamp} ${sapisid} ${origin}`).digest("hex");
  return `${timestamp}_${hash}`;
}

function buildHeaders(cookieString, userId, includeAuth, clientOverride) {
  const clientConfig = clientOverride || config;
  const h = {
    "User-Agent": clientConfig.userAgent || USER_AGENT,
    "Accept-Language": "en-US",
    "Content-Type": "application/json",
    "X-Goog-Api-Format-Version": "1",
    "X-Goog-Api-Key": API_KEY,
    "X-Origin": YTM_BASE,
    "Referer": `${YTM_BASE}/`,
    "X-YouTube-Client-Name": String(clientConfig.clientNameValue),
    "X-YouTube-Client-Version": clientConfig.clientVersion,
    "X-Goog-Visitor-Id": resolveVisitorData(userId) || "",
  };
  if (includeAuth) {
    const effective = cookieString || userCookieString;
    if (effective) {
      h["Cookie"] = effective;
      const sapisidHash = generateSapisidHash(effective, YTM_BASE);
      if (sapisidHash) {
        h["Authorization"] = `SAPISIDHASH ${sapisidHash}`;
      }
      // X-Goog-Delegate-To: sesion ID para autenticacion delegada
      const dataSyncId = resolveDataSyncId(userId);
      if (dataSyncId) {
        h["X-Goog-Delegate-To"] = `/g/@${dataSyncId}`;
      }
    }
  }
  return h;
}

async function apiRequest(endpoint, data, query = {}, userId, includeAuth, clientNameOverride) {
  checkRateLimit(endpoint);
  const cfg = await initialize();
  const endpointClientMap = {
    browse: "WEB_REMIX",
    search: "WEB_REMIX",
    next: "ANDROID_MUSIC",
    player: "ANDROID_VR",
    music_get_search_suggestions: "WEB_REMIX",
  };
  // IOS_MUSIC como fallback si ANDROID_MUSIC falla en player
  const defaultClient = endpointClientMap[endpoint] || null;
  const clientOverride = clientNameOverride ? resolveClientConfig(clientNameOverride) : (defaultClient ? resolveClientConfig(defaultClient) : null);
  const url = `${YTM_BASE}/youtubei/${cfg.apiVersion}/${endpoint}?${querystring.stringify({ alt: "json", key: cfg.apiKey || API_KEY, ...query })}`;
  const body = { ...data, context: buildContext(userId, includeAuth, clientOverride) };
  const cookieString = resolveCookieString(userId);
  const effectiveClient = clientOverride?.clientName || cfg.clientName;
  console.log(`[InnerTube] apiRequest endpoint=${endpoint} client=${effectiveClient} cookieLen=${cookieString ? cookieString.length : 0} perUserCookies=${!!(userId && userCookiesMap.has(userId))} includeAuth=${!!includeAuth}`);
  try {
    const res = await axios.post(url, body, {
      headers: buildHeaders(cookieString, userId, includeAuth, clientOverride),
      httpsAgent: KEEP_ALIVE_AGENT,
      timeout: 10000,
      responseType: "json",
      transitional: { clarifyTimeoutError: true },
    });
    if (typeof res.data !== "object" || res.data === null) {
      throw new Error("Non-JSON response from InnerTube (likely blocking/CAPTCHA)");
    }
    return res.data;
  } catch (err) {
    if (err.response) {
      const body = typeof err.response.data === "string"
        ? err.response.data.slice(0, 300)
        : JSON.stringify(err.response.data || {}).slice(0, 300);
      console.warn(`[InnerTube] ${endpoint} HTTP ${err.response.status}: ${err.response.statusText} body=${body}`);
      if (err.response.status === 403 || err.response.status === 401) {
        config = null;
        initPromise = null;
      }
      // Smart retry: 400 (INVALID_ARGUMENT) often caused by stale dataSyncId, retry without auth
      if (err.response.status === 400 && includeAuth) {
        console.warn(`[InnerTube] ${endpoint} HTTP 400 (likely stale dataSyncId), retrying without auth`);
        return await apiRequest(endpoint, data, query, userId, false, clientNameOverride);
      }
      if (err.response.status === 500 && !clientNameOverride && effectiveClient === "ANDROID_VR") {
        console.warn(`[InnerTube] ANDROID_VR ${endpoint} failed, retrying with ANDROID_MUSIC`);
        return await apiRequest(endpoint, data, query, userId, includeAuth, "ANDROID_MUSIC");
      }
      // IOS_MUSIC fallback for player on 5xx
      if ((err.response.status === 500 || err.response.status === 503) && effectiveClient === "ANDROID_MUSIC" && !clientNameOverride) {
        console.warn(`[InnerTube] ANDROID_MUSIC ${endpoint} failed, retrying with IOS_MUSIC`);
        return await apiRequest(endpoint, data, query, userId, includeAuth, "IOS_MUSIC");
      }
      // TVHTML5 fallback for player endpoint on 5xx (last resort)
      if ((err.response.status === 500 || err.response.status === 503) && effectiveClient === "IOS_MUSIC") {
        console.warn(`[InnerTube] IOS_MUSIC ${endpoint} failed, retrying with TVHTML5`);
        return await apiRequest(endpoint, data, query, userId, includeAuth, "TVHTML5");
      }
    }
    throw err;
  }
}

async function apiRequestWithBrowseFallback(data, query, userId) {
  // WEB_REMIX no necesita auth para browse. Intentar sin auth primero evita 500 por dataSyncId.
  try {
    return await apiRequest("browse", data, query, userId, false);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 500) {
      console.warn("[InnerTube] browse failed without auth, retrying with auth");
      return await apiRequest("browse", data, query, userId, true);
    }
    throw err;
  }
}

function extractArtists(item) {
  if (!item.artist) return [];
  if (Array.isArray(item.artist)) return item.artist.map(a => a.name).filter(Boolean);
  if (typeof item.artist === "object" && item.artist.name) return [item.artist.name];
  if (item.artists && Array.isArray(item.artists)) return item.artists.map(a => a.name).filter(Boolean);
  return [];
}

function cleanThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || null;
}

function cleanAlbumTitle(value) {
  return String(value || "")
    .replace(/^\s*(?:album|single|ep|compilation)\s*[-–—:]\s*/i, "")
    .replace(/^\s*(?:album|single|ep|compilation)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchQuery(query, type = "song", userId) {
  if (!query) return [];
  try {
    const result = await searchQueryDetailed(query, type, userId);
    return result.items;
  } catch (err) {
    console.warn(`[InnerTube] Search failed for "${query?.slice(0, 40)}": ${err.message}${err.response ? ` (${err.response.status})` : ""}`);
    return [];
  }
}

async function searchQueryDetailed(query, type = "song", userId) {
  if (!query) return { items: [], continuation: null };
  const data = await apiRequest("search", { query, params: getSearchParams(type) }, {}, userId, false, "WEB_REMIX");
  return parseSearchResultsDetailed(data, type);
}

async function searchContinuationDetailed(continuation, type = "song", userId) {
  if (!continuation) return { items: [], continuation: null };
  const data = await apiRequest("search", { continuation }, {}, userId, false, "WEB_REMIX");
  return parseSearchResultsDetailed(data, type);
}

async function searchAlbumsDetailed(query, userId) {
  if (!query) return { items: [], continuation: null };
  const data = await apiRequest("search", { query, params: getSearchParams("album") }, {}, userId, false, "WEB_REMIX");
  return parseAlbumSearchResultsDetailed(data);
}

async function searchAlbumsContinuationDetailed(continuation, userId) {
  if (!continuation) return { items: [], continuation: null };
  const data = await apiRequest("search", { continuation }, {}, userId, false, "WEB_REMIX");
  return parseAlbumSearchResultsDetailed(data);
}

function getSearchParams(type) {
  const params = {
    song: "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo=",
    video: "Eg-KAQwIABABGAAgACgAMABqChAEEAMQCRAFEAo=",
    album: "Eg-KAQwIABAAGAEgACgAMABqChAEEAMQCRAFEAo=",
    artist: "Eg-KAQwIABAAGAAgASgAMABqChAEEAMQCRAFEAo=",
    playlist: "Eg-KAQwIABAAGAAgACgBMABqChAEEAMQCRAFEAo=",
  };
  return params[type] || "";
}

function parseSearchResults(data, type) {
  return parseSearchResultsDetailed(data, type).items;
}

function parseSearchResultsDetailed(data, type) {
  const continuationPage = data?.continuationContents?.musicShelfContinuation;
  if (continuationPage) {
    const items = (continuationPage.contents || [])
      .map((item) => item?.musicResponsiveListItemRenderer)
      .filter(Boolean)
      .map((renderer) => parseMusicItem(renderer))
      .filter(Boolean);

    return {
      items,
      continuation: extractContinuationToken(continuationPage) || extractContinuationToken(data),
    };
  }

  const tabbedTabs = data?.contents?.tabbedSearchResultsRenderer?.tabs;
  if (tabbedTabs) {
    for (const tab of tabbedTabs) {
      const content = tab?.tabRenderer?.content;
      if (!content) continue;
      const sections = content?.sectionListRenderer?.contents || [];
      const results = [];
      for (const section of sections) {
        const items = section?.musicShelfRenderer?.contents || [];
        for (const item of items) {
          const musicResponsiveListItemRenderer = item?.musicResponsiveListItemRenderer;
          if (!musicResponsiveListItemRenderer) continue;
          const parsed = parseMusicItem(musicResponsiveListItemRenderer);
          if (parsed) results.push(parsed);
        }
      }
      if (results.length) {
        return {
          items: results,
          continuation: findSearchContinuation(content) || extractContinuationToken(data),
        };
      }
    }
  }

  const sections = data?.contents?.sectionListRenderer?.contents || [];
  const fallbackResults = [];
  for (const section of sections) {
    const items = section?.itemSectionRenderer?.contents || section?.musicShelfRenderer?.contents || [];
    for (const item of items) {
      const parsed = parseSearchItem(item, type);
      if (parsed) fallbackResults.push(parsed);
    }
  }
  return {
    items: fallbackResults,
    continuation: findSearchContinuation(sections) || extractContinuationToken(data),
  };
}

function parseAlbumSearchResultsDetailed(data) {
  const items = [];
  const seen = new Set();

  const visit = (node) => {
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }

    const parsed =
      parseAlbumTwoRowItem(node.musicTwoRowItemRenderer) ||
      parseAlbumResponsiveItem(node.musicResponsiveListItemRenderer) ||
      parseAlbumCardShelfItem(node.musicCardShelfRenderer);
    if (parsed) {
      const key = parsed.albumBrowseId || parsed.id || parsed.albumUrl || parsed.url;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(parsed);
      }
    }

    for (const value of Object.values(node)) {
      visit(value);
    }
  };

  visit(data?.contents);
  visit(data?.continuationContents);
  visit(data?.onResponseReceivedActions);

  return {
    items,
    continuation:
      findSearchContinuation(data?.onResponseReceivedActions) ||
      findSearchContinuation(data?.continuationContents) ||
      findSearchContinuation(data),
  };
}

function parseAlbumTwoRowItem(renderer) {
  const title = renderer?.title?.runs?.map((r) => r.text).join("") || "";
  const subtitle = renderer?.subtitle?.runs?.map((r) => r.text).join("") || "";
  const browseEndpoint = renderer?.navigationEndpoint?.browseEndpoint;
  const browseId = browseEndpoint?.browseId || null;
  const pageType = browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || browseEndpoint?.pageType || null;
  const watchPlaylistId = renderer?.navigationEndpoint?.watchEndpoint?.playlistId || renderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId || null;
  const isAlbum = pageType === "MUSIC_PAGE_TYPE_ALBUM" || (!!browseId && !!watchPlaylistId);
  const thumbnails = renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

  if (!title || !browseId || !isAlbum) return null;

  const artist = subtitle ? subtitle.split(SEPARATOR_RE)[0].trim() : "";
  const releaseType = extractAlbumReleaseType(subtitle);
  const albumUrl = `https://music.youtube.com/browse/${browseId}`;

  return {
    id: browseId,
    browseId,
    albumId: browseId,
    albumBrowseId: browseId,
    albumUrl,
    url: albumUrl,
    title,
    artist,
    artistName: artist,
    subtitle,
    releaseType,
    artworkUrl: cleanThumbnail(thumbnails),
    imageUrl: cleanThumbnail(thumbnails),
    type: "album",
  };
}

function parseAlbumResponsiveItem(renderer) {
  if (!renderer) return null;

  const title = renderer?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map((r) => r.text).join("") || "";
  const browseEndpoint = renderer?.navigationEndpoint?.browseEndpoint;
  const browseId = browseEndpoint?.browseId || null;
  const pageType = browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || browseEndpoint?.pageType || null;
  const watchPlaylistId = renderer?.navigationEndpoint?.watchEndpoint?.playlistId || renderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId || null;
  const isAlbum = pageType === "MUSIC_PAGE_TYPE_ALBUM" || (!!browseId && !renderer?.playlistItemData?.videoId && !!watchPlaylistId);
  const thumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

  if (!title || !browseId || !isAlbum) return null;

  const subtitleRuns = renderer?.flexColumns?.slice(1).flatMap((col) => col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []) || [];
  const subtitle = subtitleRuns.map((run) => run?.text || "").join("").trim();
  const artist = subtitle ? subtitle.split(SEPARATOR_RE)[0].trim() : "";
  const releaseType = extractAlbumReleaseType(subtitle);
  const albumUrl = `https://music.youtube.com/browse/${browseId}`;

  return {
    id: browseId,
    browseId,
    albumId: browseId,
    albumBrowseId: browseId,
    albumUrl,
    url: albumUrl,
    title,
    artist,
    artistName: artist,
    subtitle,
    releaseType,
    artworkUrl: cleanThumbnail(thumbnails),
    imageUrl: cleanThumbnail(thumbnails),
    type: "album",
  };
}

function parseAlbumCardShelfItem(renderer) {
  if (!renderer) return null;

  const onTap = renderer?.onTap?.browseEndpoint;
  const title = renderer?.title?.runs?.map((r) => r.text).join("") || renderer?.title?.simpleText || "";
  const subtitle = renderer?.subtitle?.runs?.map((r) => r.text).join("") || renderer?.subtitle?.simpleText || "";
  const browseId = onTap?.browseId || null;
  const pageType = onTap?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || onTap?.pageType || null;
  const isAlbum = pageType === "MUSIC_PAGE_TYPE_ALBUM";
  const thumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || renderer?.thumbnail?.thumbnails || [];
  const watchPlaylistId = renderer?.onTap?.watchEndpoint?.playlistId || renderer?.buttons?.[0]?.buttonRenderer?.command?.anyWatchEndpoint?.playlistId || null;

  if (!title || !browseId || !isAlbum) return null;

  const artist = subtitle ? subtitle.split(SEPARATOR_RE)[0].trim() : "";
  const releaseType = extractAlbumReleaseType(subtitle);
  const albumUrl = `https://music.youtube.com/browse/${browseId}`;

  return {
    id: browseId,
    browseId,
    albumId: browseId,
    albumBrowseId: browseId,
    albumUrl,
    url: albumUrl,
    title,
    artist,
    artistName: artist,
    subtitle,
    releaseType,
    playlistId: watchPlaylistId,
    artworkUrl: cleanThumbnail(thumbnails),
    imageUrl: cleanThumbnail(thumbnails),
    type: "album",
  };
}

function extractAlbumReleaseType(subtitle) {
  const text = String(subtitle || "").toLowerCase();
  if (text.includes("single") || text.includes("sencillo")) return "Single";
  if (text.includes("ep")) return "EP";
  if (text.includes("album") || text.includes("álbum") || text.includes("album ") || text.startsWith("album") || text.startsWith("álbum")) return "Album";
  if (text.includes("compilation")) return "Compilation";
  return null;
}

function findSearchContinuation(node, seen = new Set()) {
  if (!node || typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);

  const direct = getContinuationToken(node);
  if (direct) return direct;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findSearchContinuation(entry, seen);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findSearchContinuation(value, seen);
    if (found) return found;
  }

  return null;
}

function extractContinuationToken(node) {
  return findSearchContinuation(node);
}

function parseSearchItem(item, type) {
  if (item?.musicResponsiveListItemRenderer) {
    return parseMusicItem(item.musicResponsiveListItemRenderer);
  }
  if (item?.compactVideoRenderer && (type === "song" || type === "video")) {
    return parseCompactVideoItem(item.compactVideoRenderer);
  }
  return null;
}

function parseCompactVideoItem(renderer) {
  const videoId = renderer?.videoId || renderer?.navigationEndpoint?.watchEndpoint?.videoId || null;
  const title = renderer?.title?.runs?.map((run) => run?.text || "").join("").trim() || "";
  if (!videoId || !title) return null;

  const authorRuns = renderer?.shortBylineText?.runs || renderer?.longBylineText?.runs || [];
  const authors = authorRuns
    .map((run) => (run?.text || "").trim())
    .filter(Boolean)
    .filter((text) => text !== "•");
  const artistBrowseId = authorRuns.find((run) => run?.navigationEndpoint?.browseEndpoint?.browseId)
    ?.navigationEndpoint?.browseEndpoint?.browseId || null;
  const duration = parseDurationMs(renderer?.lengthText?.runs?.map((run) => run?.text || "").join("").trim() || "");

  return {
    videoId,
    title,
    artist: authors[0] || "",
    authors,
    artists: authors,
    album: null,
    albumBrowseId: null,
    artistBrowseId,
    duration,
    artworkUrl: cleanThumbnail(deepFindThumbnails(renderer) || renderer?.thumbnail?.thumbnails || []),
    thumbnail: cleanThumbnail(deepFindThumbnails(renderer) || renderer?.thumbnail?.thumbnails || []),
    uri: `https://www.youtube.com/watch?v=${videoId}`,
    source: "youtube",
    isrc: null,
    explicit: false,
  };
}

function deepFindThumbnails(renderer) {
  // Busca thumbnails en todas las rutas posibles
  const paths = [
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    renderer?.thumbnail?.thumbnails,
    renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    renderer?.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.thumbnail?.thumbnails,
    renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.thumbnail?.thumbnails,
    renderer?.thumbnailOverlay?.musicItemThumbnailOverlayRenderer?.content?.thumbnail?.thumbnails,
    renderer?.musicResponsiveListItemRenderer?.thumbnail?.thumbnails,
    renderer?.musicResponsiveListItemRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
  ];
  for (const p of paths) {
    if (p?.length) return p;
  }
  return null;
}

function parseMusicItem(renderer) {
  const flexColumns = renderer?.flexColumns || [];
  const fixedColumns = renderer?.fixedColumns || [];
  const getRuns = (col) => col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const getText = (col) => getRuns(col).map(r => r.text).join("") || "";
  const title = getText(flexColumns[0]);
  const subtitle = getText(flexColumns[1]);
  const subtitleRuns = getRuns(flexColumns[1]);
  const thumbnail = deepFindThumbnails(renderer);
  const explicit = hasExplicitBadge(renderer);
  const browseEndpoint = renderer?.navigationEndpoint?.browseEndpoint;
  const watchEndpoint = renderer?.navigationEndpoint?.watchEndpoint;
  const videoId = renderer?.playlistItemData?.videoId ||
                  watchEndpoint?.videoId ||
                  renderer?.thumbnailOverlay?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                  renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                  renderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
                  null;
  // Allow browse-only items (artists, albums, playlists without videoId)
  const browseId = browseEndpoint?.browseId || null;
  if (!videoId && !browseId) return null;
  if (!title) return null;
  const metadata = parseSubtitleRuns(subtitleRuns, subtitle);
  // Fallback: extract browseId from menuRenderer if not found in subtitle runs
  const menuBrowseId = extractBrowseIdFromMenu(renderer);
  const pageType = browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || null;
  return {
    videoId,
    browseId,
    pageType,
    title,
    artist: metadata.authors[0] || "",
    authors: metadata.authors,
    artists: metadata.authors,
    album: metadata.album,
    albumBrowseId: metadata.albumBrowseId || browseId || menuBrowseId,
    artistBrowseId: metadata.artistBrowseId || browseId || menuBrowseId,
    duration: metadata.duration,
    artworkUrl: cleanThumbnail(thumbnail),
    thumbnail: cleanThumbnail(thumbnail),
    uri: videoId ? `https://www.youtube.com/watch?v=${videoId}` : (browseId ? `https://music.youtube.com/browse/${browseId}` : null),
    source: "youtube",
    isrc: null,
    explicit,
  };
}

function parseSubtitleRuns(subtitleRuns, subtitleText) {
  const runs = Array.isArray(subtitleRuns) ? subtitleRuns : [];
  const authors = [];
  let album = null;
  let albumBrowseId = null;
  let artistBrowseId = null;
  let duration = null;

  // Nivel 1: runs con MUSIC_PAGE_TYPE_ARTIST
  for (const run of runs) {
    const text = (run?.text || "").trim();
    if (!text || text === "•") continue;

    const browseEndpoint = run?.navigationEndpoint?.browseEndpoint;
    const pageType = browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;

    if (pageType === "MUSIC_PAGE_TYPE_ARTIST") {
      authors.push(text);
      if (!artistBrowseId) artistBrowseId = browseEndpoint?.browseId || null;
      continue;
    }

    if (pageType === "MUSIC_PAGE_TYPE_ALBUM") {
      if (!album) album = text;
      if (!albumBrowseId) albumBrowseId = browseEndpoint?.browseId || null;
      continue;
    }

    const parsedDuration = parseDurationMs(text);
    if (parsedDuration != null) {
      duration = parsedDuration;
    }
  }

  // Nivel 2: runs sin pageType pero con browseEndpoint no-VL (artistas sin tipo explicito)
  if (!authors.length) {
    for (const run of runs) {
      const text = (run?.text || "").trim();
      if (!text || text === "•") continue;
      const browseEndpoint = run?.navigationEndpoint?.browseEndpoint;
      const browseId = browseEndpoint?.browseId || "";
      if (browseId && !browseId.startsWith("VL") && !browseId.startsWith("MP")) {
        authors.push(text);
        if (!artistBrowseId) artistBrowseId = browseId;
        break;
      }
    }
  }

  // Nivel 3: fallback raw text con split por separadores
  if (!authors.length && subtitleText) {
    const parts = subtitleText.split(SEPARATOR_RE).filter(Boolean);
    if (parts.length) authors.push(...parts[0].split(",").map((part) => part.trim()).filter(Boolean));
    if (!album) {
      album = parts.find((part, index) => index > 0 && parseDurationMs(part) == null) || null;
    }
    if (duration == null) {
      const durationText = parts.find((part) => parseDurationMs(part) != null);
      duration = durationText ? parseDurationMs(durationText) : null;
    }
  }

  return { authors, album, albumBrowseId, artistBrowseId, duration };
}

function parseDurationMs(text) {
  const value = String(text || "").trim();
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const parts = value.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}

function hasExplicitBadge(renderer) {
  const badgeLists = [renderer?.badges, renderer?.subtitleBadges];
  for (const badges of badgeLists) {
    if (!Array.isArray(badges)) continue;
    for (const badge of badges) {
      const badgeRenderer = badge?.musicInlineBadgeRenderer;
      const iconType = badgeRenderer?.icon?.iconType;
      if (iconType === "MUSIC_EXPLICIT_BADGE") return true;
      const label = badgeRenderer?.accessibilityData?.label || badgeRenderer?.accessibility?.label;
      if (typeof label === "string" && label.toLowerCase().includes("explicit")) return true;
    }
  }
  return false;
}

function parseTrackFromShelfItem(item) {
  if (item?.musicResponsiveListItemRenderer) {
    return parseMusicItem(item.musicResponsiveListItemRenderer);
  }

  if (item?.playlistPanelVideoRenderer) {
    const r = item.playlistPanelVideoRenderer;
    const title = r.title?.runs?.map(x => x.text).join("") || "";
    const videoId = r.videoId;
    if (!videoId || !title) return null;

    const runs = r.longBylineText?.runs || [];
    const artists = [];
    let album = null;
    let isArtist = true;
    for (const run of runs) {
      const text = run.text.trim();
      if (text === "•" || text === "," || text === "&") {
        if (text === "•") isArtist = false;
        continue;
      }
      if (isArtist) artists.push(text);
      else album = text;
    }

    const thumbnails = r.thumbnail?.thumbnails || [];
    return {
      videoId,
      title,
      artist: artists[0] || "",
      authors: artists,
      artists,
      album,
      duration: null,
      artworkUrl: cleanThumbnail(thumbnails),
      thumbnail: cleanThumbnail(thumbnails),
      uri: `https://www.youtube.com/watch?v=${videoId}`,
      source: "youtube",
      isrc: null,
      explicit: false,
    };
  }

  const r = item?.musicTwoRowItemRenderer;
  const title = r?.title?.runs?.map(x => x.text).join("") || "";
  const subtitle = r?.subtitle?.runs?.map(x => x.text).join("") || "";
  const videoId = r?.navigationEndpoint?.browseEndpoint?.browseId ||
                  r?.navigationEndpoint?.watchEndpoint?.videoId ||
                  r?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
                  null;
  if (!videoId || !title) return null;

  const artists = subtitle ? subtitle.split(SEPARATOR_RE)[0]?.split(",").map(a => a.trim()).filter(Boolean) : [];
  const thumbnails = r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    return {
      videoId,
      title,
      artist: artists[0] || "",
      authors: artists,
      artists,
      album: subtitle?.match(SEPARATOR_RE) ? subtitle.replace(SEPARATOR_RE, " • ").split("•").slice(1).join("•").trim() : null,
      duration: null,
      artworkUrl: cleanThumbnail(thumbnails),
    thumbnail: cleanThumbnail(thumbnails),
    uri: `https://www.youtube.com/watch?v=${videoId}`,
    source: "youtube",
    isrc: null,
    explicit: false,
  };
}

function getContinuationToken(item) {
  return item?.nextContinuationData?.continuation ||
    item?.reloadContinuationData?.continuation ||
    item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
    item?.continuationEndpoint?.continuationCommand?.token ||
    item?.continuation?.continuation ||
    null;
}

function findDeep(node, predicate, seen = new Set()) {
  if (!node || typeof node !== "object") return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (predicate(node)) return node;

  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findDeep(entry, predicate, seen);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    const found = findDeep(value, predicate, seen);
    if (found) return found;
  }
  return null;
}

function parseAlbumDetails(data, albumId) {
  const header = findDeep(data, (node) => node?.musicDetailHeaderRenderer || node?.musicResponsiveHeaderRenderer || node?.musicVisualHeaderRenderer);
  const renderer = header?.musicDetailHeaderRenderer || header?.musicResponsiveHeaderRenderer || header?.musicVisualHeaderRenderer || {};
  const title = renderer?.title?.runs?.map((r) => r.text).join("") || renderer?.title?.simpleText || "";
  // straplineTextOne tiene prioridad sobre subtitle para artistas de album
  const straplineRuns = renderer?.straplineTextOne?.runs || [];
  const subtitleRuns = straplineRuns.length ? straplineRuns : (renderer?.subtitle?.runs || renderer?.subtitle?.run || []);
  const subtitle = Array.isArray(subtitleRuns) ? subtitleRuns.map((r) => r.text).join("") : (renderer?.subtitle?.simpleText || "");
  const thumbnailRuns = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || renderer?.thumbnail?.thumbnails
    || [];

  // Parse subtitle: "2024 • Album • Bad Bunny"
  const parts = subtitle.split(SEPARATOR_RE).filter(Boolean);
  let year = null;
  let releaseType = null;
  let artistFromText = "";
  for (const p of parts) {
    if (/^\d{4}$/.test(p)) { year = p; }
    else if (["Album", "Single", "EP", "Compilation"].includes(p)) { releaseType = p; }
    else if (!p.includes("song") && !p.includes("minute") && !p.includes("hour")) { artistFromText = p; }
  }

  // Extract artists from runs that have navigation to artist page
  let artists = [];
  if (Array.isArray(subtitleRuns)) {
    for (const run of subtitleRuns) {
      const text = (run?.text || "").trim();
      if (!text || text === "•") continue;
      const cfg = run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig;
      if (cfg?.pageType === "MUSIC_PAGE_TYPE_ARTIST") artists.push(text);
    }
  }
  if (artists.length === 0 && artistFromText) artists = [artistFromText];

  // Try track count from secondSubtitle
  const secondSubtitleRuns = renderer?.secondSubtitle?.runs || [];
  const secondSubtitle = Array.isArray(secondSubtitleRuns) ? secondSubtitleRuns.map(r => r.text).join("") : "";
  let trackCount = null;
  const songMatch = secondSubtitle.match(/(\d+)\s*song/i) || subtitle.match(/(\d+)\s*song/i);
  if (songMatch) trackCount = parseInt(songMatch[1], 10);

  const typeText = `${title} ${subtitle}`.toLowerCase();
  if (!releaseType) {
    releaseType = typeText.includes("ep") ? "EP" : (typeText.includes("single") ? "Single" : "Album");
  }

  return {
    albumId,
    title: cleanAlbumTitle(title),
    artist: artists[0] || "",
    artists,
    year,
    releaseType,
    thumbnail: cleanThumbnail(thumbnailRuns),
    albumUrl: albumId ? `https://music.youtube.com/browse/${albumId}` : null,
    trackCount,
  };
}

function collectShelfTracks(node, tracks, continuations) {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const entry of node) collectShelfTracks(entry, tracks, continuations);
    return;
  }

  const parsed = parseTrackFromShelfItem(node);
  if (parsed) tracks.push(parsed);

  const continuationToken = getContinuationToken(node);
  if (continuationToken) continuations.add(continuationToken);

  const nestedCollections = [
    node.tabRenderer?.content,
    node.contents,
    node.items,
    node.tabs,
    node.sections,
    node.continuationItems,
    node.onResponseReceivedActions,
    node.continuationContents ? Object.values(node.continuationContents) : null,
    node.sectionListRenderer?.contents,
    node.sectionListContinuation?.contents,
    node.musicShelfRenderer?.contents,
    node.musicPlaylistShelfRenderer?.contents,
    node.musicCarouselShelfRenderer?.contents,
    node.itemSectionRenderer?.contents,
    node.appendContinuationItemsAction?.continuationItems,
  ];

  for (const nested of nestedCollections) {
    if (nested) collectShelfTracks(nested, tracks, continuations);
  }
}

function extractShelfTracks(data) {
  const tracks = [];
  const continuations = new Set();

  collectShelfTracks(data, tracks, continuations);

  return { tracks, continuations: [...continuations] };
}

function getContinuationFromList(list) {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const token = getContinuationToken(item);
    if (token) return token;
  }
  return null;
}

function collectPlaylistCandidate(contents) {
  const tracks = [];
  const continuations = new Set();

  if (!Array.isArray(contents)) {
    return { tracks, continuations: [] };
  }

  for (const section of contents) {
    if (!section || typeof section !== "object") continue;

    const shelfNodes = [
      section.musicPlaylistShelfRenderer?.contents,
      section.musicShelfRenderer?.contents,
      section.itemSectionRenderer?.contents,
      section.gridRenderer?.items,
      section.gridRenderer?.contents,
      section.musicPlaylistShelfContinuation?.contents,
      section.musicShelfContinuation?.contents,
    ];

    for (const nodes of shelfNodes) {
      if (nodes) collectShelfTracks(nodes, tracks, continuations);
    }

    const token =
      getContinuationToken(section) ||
      getContinuationToken(section.musicPlaylistShelfRenderer) ||
      getContinuationToken(section.musicShelfRenderer) ||
      getContinuationToken(section.itemSectionRenderer) ||
      getContinuationToken(section.gridRenderer);
    if (token) continuations.add(token);
  }

  return { tracks: dedupeTracks(tracks), continuations: [...continuations] };
}

function extractPlaylistTracksFromResponse(data) {
  const sectionListContents =
    data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents ||
    data?.continuationContents?.sectionListContinuation?.contents ||
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ||
    data?.contents?.sectionListRenderer?.contents ||
    [];

  const appendedContents = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];

  const candidates = [
    {
      ...collectPlaylistCandidate(sectionListContents),
      continuation:
        getContinuationFromList(data?.continuationContents?.sectionListContinuation?.continuations) ||
        getContinuationFromList(data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.continuations) ||
        getContinuationFromList(data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.continuations),
    },
    {
      ...collectPlaylistCandidate(data?.continuationContents?.musicPlaylistShelfContinuation?.contents),
      continuation: getContinuationFromList(data?.continuationContents?.musicPlaylistShelfContinuation?.continuations),
    },
    {
      ...collectPlaylistCandidate(data?.continuationContents?.musicShelfContinuation?.contents),
      continuation: getContinuationFromList(data?.continuationContents?.musicShelfContinuation?.continuations),
    },
    {
      ...collectPlaylistCandidate(appendedContents),
      continuation: getContinuationFromList(appendedContents),
    },
  ];

  return candidates.find((candidate) => candidate.tracks.length > 0) ||
      candidates.find((candidate) => candidate.continuations.length > 0) ||
      candidates[0];
}

function dedupeTracks(tracks) {
  const seen = new Set();
  const deduped = [];
  for (const track of tracks) {
    const key = track?.videoId || `${track?.title || ""}:${track?.artist || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(track);
  }
  return deduped;
}

async function getSignatureTimestamp() {
  if (cachedSigTimestamp && Date.now() < cachedSigTimestampExpiry) {
    return cachedSigTimestamp;
  }
  try {
    const res = await axios.get(`${YTM_BASE}/`, {
      headers: { "User-Agent": USER_AGENT_WEB },
      timeout: 10000,
    });
    const match = res.data.match(/"signatureTimestamp":(\d+)/);
    if (match) {
      cachedSigTimestamp = parseInt(match[1], 10);
      cachedSigTimestampExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
      return cachedSigTimestamp;
    }
    const match2 = res.data.match(/signatureTimestamp[=:]+(\d+)/);
    if (match2) {
      cachedSigTimestamp = parseInt(match2[1], 10);
      cachedSigTimestampExpiry = Date.now() + 60 * 60 * 1000;
      return cachedSigTimestamp;
    }
  } catch {}
  const fallback = Math.floor(Date.now() / 1000 / 3600) * 3600;
  cachedSigTimestamp = fallback;
  cachedSigTimestampExpiry = Date.now() + 30 * 60 * 1000; // fallback 30min
  return fallback;
}

async function getPlayer(videoId, options = {}) {
  const { poToken: callerPoToken, signatureTimestamp: callerSigTs } = options;
  const localPoToken = callerPoToken || generateSessionPoToken(videoId);
  const cacheKey = localPoToken ? `${videoId}:${localPoToken.slice(0, 12)}` : videoId;
  const cached = playerCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt && Date.now() < cached.expiresAt) return cached.data;
    const longCache = cached.ts && Date.now() - cached.ts < CACHE_TTL;
    if (!cached.expiresAt && longCache) return cached.data;
    playerCache.delete(cacheKey);
  }

  const signatureTimestamp = callerSigTs || await getSignatureTimestamp();
  const isLoggedIn = !!(resolveCookieString(options.userId));
  let lastError = null;

  // Secuencial: ANDROID_VR primero (más rápido, omite cifrado), luego fallbacks
  const clients = [...new Set(PLAYER_STREAM_CLIENTS)].filter(clientName => {
    if (isStreamClientBlocked(videoId, clientName)) return false;
    if (!isLoggedIn && PLAYER_LOGGED_IN_FILTER.has(clientName)) return false;
    return true;
  });

  for (const clientName of clients) {
    try {
      const body = {
        videoId,
        playbackContext: {
          contentPlaybackContext: { signatureTimestamp },
        },
        serviceIntegrityDimensions: { poToken: localPoToken },
        thirdPartyUploadUrlSupport: false,
      };
      const data = await apiRequest("player", body, {}, options.userId, true, clientName);
      if (data?.streamingData) {
        const expiresInSeconds = data.streamingData?.expiresInSeconds || 21600;
        playerCache.set(cacheKey, { data, ts: Date.now(), expiresInSeconds, expiresAt: Date.now() + (expiresInSeconds * 1000) });
        return data;
      }
      if (data?.playabilityStatus?.status !== "OK") {
        lastError = new Error(data?.playabilityStatus?.reason || "playability not OK");
        if (data?.playabilityStatus?.reason === "FAILED_PRECONDITION") break;
        continue;
      }
    } catch (err) {
      lastError = err;
      if (err?.response?.status === 403) markStreamClientFailed(videoId, clientName);
      if (err?.response?.status === 400 && err?.response?.data?.error?.message?.includes?.("INVALID_ARGUMENT")) {
        // retry without dataSyncId handled inside apiRequest
      }
      const msg = err?.response?.data?.error?.message || "";
      if (msg.includes("FAILED_PRECONDITION")) break;
      continue;
    }
  }

  console.warn(`[InnerTube] Player failed for ${videoId} after ${clients.length} clients: ${lastError?.message || "unknown"}`);
  return null;
}

async function getPlayerWithMetadata(videoId, options = {}) {
  const data = await getPlayer(videoId, options);
  if (!data) return null;
  const audioConfig = data?.playerConfig?.audioConfig || {};
  const playbackTracking = data?.playbackTracking || null;
  const videostatsPlaybackUrl = playbackTracking?.videostatsPlaybackUrl?.baseUrl || null;
  return {
    ...data,
    _loudnessDb: audioConfig.loudnessDb ?? null,
    _perceptualLoudnessDb: audioConfig.perceptualLoudnessDb ?? null,
    _videostatsPlaybackUrl: videostatsPlaybackUrl,
  };
}

function resolveCipher(format) {
  const cipher = format.signatureCipher || format.cipher;
  if (!cipher) return null;
  try {
    const parsed = querystring.parse(cipher);
    const url = parsed.url;
    if (!url) return null;
    const sp = parsed.sp || "sig";
    const s = parsed.s;
    if (s) {
      const separator = url.includes("?") ? "&" : "?";
      return `${url}${separator}${sp}=${encodeURIComponent(s)}`;
    }
    return url;
  } catch {
    return null;
  }
}

async function validateStreamUrl(url) {
  try {
    const probeRanges = ["bytes=0-0"];
    for (const range of probeRanges) {
      const res = await axios.head(url, {
        headers: { Range: range, "User-Agent": USER_AGENT },
        timeout: 5000,
        validateStatus: () => true,
      });
      if (res.status === 403) return false;
      if (![200, 202, 203, 204, 206, 304, 416].includes(res.status)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function getStreamUrl(videoId, options = {}) {
  const cacheKey = options.poToken ? `${videoId}:${options.poToken.slice(0, 12)}` : videoId;
  const cached = playerCache.get(cacheKey);
  let player = null;
  let expiresInSeconds = null;

  if (cached) {
    if (cached.expiresAt && Date.now() < cached.expiresAt) {
      player = cached.data;
      expiresInSeconds = cached.expiresInSeconds;
    } else {
      playerCache.delete(cacheKey);
    }
  }

  if (!player) {
    player = await getPlayer(videoId, options);
    if (!player) {
      console.warn(`[InnerTube] getStreamUrl(${videoId}): getPlayer returned null`);
      return null;
    }
    if (!player.streamingData) {
      console.warn(`[InnerTube] getStreamUrl(${videoId}): no streamingData in player response`);
      return null;
    }
    expiresInSeconds = player.streamingData?.expiresInSeconds || 21600;
    playerCache.set(cacheKey, {
      data: player,
      ts: Date.now(),
      expiresInSeconds,
      expiresAt: Date.now() + (expiresInSeconds * 1000),
    });
  }

  const { adaptiveFormats } = player.streamingData;
  if (!adaptiveFormats?.length) {
    console.warn(`[InnerTube] getStreamUrl(${videoId}): no adaptiveFormats`);
    return null;
  }

  // 1. Recolectar formatos de audio con URL directa y vía cipher.
  const directAudioFormats = adaptiveFormats.filter(f =>
    f.mimeType?.startsWith("audio/") && f.url
  );

  const cipherAudioFormats = adaptiveFormats
    .filter(f => f.mimeType?.startsWith("audio/") && (f.signatureCipher || f.cipher))
    .map(f => {
      const resolvedUrl = resolveCipher(f);
      return resolvedUrl ? { ...f, url: resolvedUrl } : null;
    })
    .filter(Boolean);

  let audioFormats = [...directAudioFormats, ...cipherAudioFormats];
  if (cipherAudioFormats.length) {
    console.log(`[InnerTube] getStreamUrl(${videoId}): resolved ${cipherAudioFormats.length} format(s) via cipher`);
  }

  // 2. Try any format with URL regardless of audio/video
  if (!audioFormats.length) {
    audioFormats = adaptiveFormats.filter(f => f.url);
    if (audioFormats.length) {
      console.log(`[InnerTube] getStreamUrl(${videoId}): falling back to any format with URL`);
    }
  }

  if (!audioFormats.length) {
    console.warn(`[InnerTube] getStreamUrl(${videoId}): no usable formats found (checked url + cipher)`);
    return null;
  }
  const formatScore = (f) => {
    const mime = (f.mimeType || '').toLowerCase();
    const codec = (f.codecs || f.mimeType || '').toLowerCase();
    const itag = f.itag || 0;
    const isM4a = mime.includes('audio/mp4') || mime.includes('audio/m4a') || codec.includes('mp4a');
    const isOpus251 = itag === 251;
    const m4aBonus = isM4a ? 2_000_000 : 0;
    const opus251Bonus = isOpus251 ? 5_000_000 : 0;
    return opus251Bonus + m4aBonus + (f.bitrate || 0);
  };

  audioFormats.sort((a, b) => formatScore(b) - formatScore(a));

  // Validar hasta 6 candidatos (como OpenTute)
  let best = null;
  for (const candidate of audioFormats.slice(0, 6)) {
    if (await validateStreamUrl(candidate.url)) {
      best = candidate;
      break;
    }
  }
  if (!best) {
    best = audioFormats[0];
    console.warn(`[InnerTube] getStreamUrl(${videoId}): no validated stream, using best-effort itag=${best.itag}`);
  } else {
    console.log(`[InnerTube] getStreamUrl(${videoId}): validated stream, selected itag=${best.itag} mime=${best.mimeType || 'unknown'} bitrate=${best.bitrate || 0}`);
  }

  const audioConfig = player?.playerConfig?.audioConfig || {};
  const playbackTracking = player?.playbackTracking || null;
  const videostatsPlaybackUrl = playbackTracking?.videostatsPlaybackUrl?.baseUrl || null;

  return {
    url: best.url,
    loudnessDb: audioConfig.loudnessDb ?? null,
    perceptualLoudnessDb: audioConfig.perceptualLoudnessDb ?? null,
    videostatsPlaybackUrl,
    itag: best.itag,
    mimeType: best.mimeType,
    bitrate: best.bitrate,
    expiresInSeconds,
  };
}

async function searchTrack(artist, title, userId) {
  const query = `${artist || ""} ${title || ""}`.trim();
  if (!query) return null;
  const items = await searchQuery(query, "song", userId);
  return items.length ? items : null;
}

async function enrichTracks(tracks, userId) {
  if (!tracks?.length) return tracks;
  const limit = Math.min(tracks.length, 6);
  const enriched = [...tracks];
  for (let i = 0; i < limit; i++) {
    const track = enriched[i];
    const title = track.title || track.track_title;
    const artist = track.artist || track.author || track.track_author;
    if (!title) continue;
    try {
      const results = await searchTrack(artist, title, userId);
      if (results?.length) {
        const best = results[0];
        enriched[i].title = best.title;
        enriched[i].artist = best.artist;
        enriched[i].authors = best.authors;
        if (best.thumbnail) {
          enriched[i].artworkUrl = best.thumbnail;
          enriched[i].thumbnail = best.thumbnail;
        }
        enriched[i].ytVideoId = best.videoId;
      }
    } catch {}
  }
  return enriched;
}

async function getHomeFeed(userId, params = null) {
  const cacheKey = `${userId || "__global__"}:${params || "__default__"}`;
  const cached = homeFeedCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < HOME_FEED_CACHE_TTL) {
    return cached.data;
  }
  if (homeFeedInFlight.has(cacheKey)) {
    return homeFeedInFlight.get(cacheKey);
  }
  const inFlight = (async () => {
  try {
    const usingCookies = resolveCookieString(userId);
    const cookiePreview = usingCookies ? usingCookies.substring(0, 40) + "..." : "none";
    const isPerUser = userId && userCookiesMap.has(userId);
    console.log(`[InnerTube] getHomeFeed userId=${userId} cookieLen=${usingCookies ? usingCookies.length : 0} perUserCookies=${isPerUser} globalCookies=${!!userCookieString} preview=${cookiePreview}`);
    const hasUserCookies = userId && userCookiesMap.has(userId);
    const data = hasUserCookies
      ? await (async () => {
          try {
            return await apiRequest("browse", { browseId: "FEmusic_home", params: params || undefined }, {}, userId, true);
          } catch (err) {
            if (err?.response?.status === 500) {
              console.warn("[InnerTube] getHomeFeed with auth failed (500), retrying without auth");
              return await apiRequest("browse", { browseId: "FEmusic_home", params: params || undefined }, {}, userId, false);
            }
            throw err;
          }
        })()
      : await apiRequestWithBrowseFallback({ browseId: "FEmusic_home", params: params || undefined }, {}, userId);
    if (data) {
      homeFeedCache.set(cacheKey, { data, ts: Date.now() });
    }
    return data;
  } catch (err) {
    console.warn(`[InnerTube] getHomeFeed failed for userId=${userId}: ${err.message}${err.response ? ` status=${err.response.status}` : ""}`);
    return null;
  }
  })();
  homeFeedInFlight.set(cacheKey, inFlight);
  try {
    return await inFlight;
  } finally {
    homeFeedInFlight.delete(cacheKey);
  }
}

function clearHomeFeedCache(userId) {
  if (userId) {
    for (const key of homeFeedCache.keys()) {
      if (key.startsWith(`${userId}:`)) homeFeedCache.delete(key);
    }
  }
  else homeFeedCache.clear();
}

async function getLibraryPlaylists(userId) {
  try {
    const data = await apiRequestWithBrowseFallback({ browseId: "FEmusic_library_playlists" }, {}, userId);
    if (!data) return [];

    const contents = data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    const playlists = [];

    for (const section of contents) {
      const items = section?.musicShelfRenderer?.contents ||
                    section?.musicCarouselShelfRenderer?.contents ||
                    [];
      for (const item of items) {
        const renderer = item?.musicResponsiveListItemRenderer || item?.musicTwoRowItemRenderer;
        if (!renderer) continue;

        let title, subtitle, playlistId, artworkUrl;

        if (item.musicResponsiveListItemRenderer) {
          const parsed = parseMusicItem(item.musicResponsiveListItemRenderer);
          if (!parsed) continue;
          title = parsed.title;
          playlistId = parsed.videoId;
          artworkUrl = parsed.artworkUrl;
        } else {
          const r = item.musicTwoRowItemRenderer;
          title = r?.title?.runs?.map(x => x.text).join("") || "";
          subtitle = r?.subtitle?.runs?.map(x => x.text).join("") || "";
          playlistId = r?.navigationEndpoint?.browseEndpoint?.browseId ||
                       r?.navigationEndpoint?.watchEndpoint?.playlistId ||
                       null;
          const thumbs = r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
          artworkUrl = cleanThumbnail(thumbs);
        }

        if (title && playlistId) {
          playlists.push({ id: playlistId, title, subtitle, artworkUrl, type: "playlist" });
        }
      }
    }

    return playlists;
  } catch (err) {
    console.warn(`[InnerTube] getLibraryPlaylists failed: ${err.message}`);
    return [];
  }
}

async function getRadioQueue(videoId, userId) {
  try {
    if (!videoId) return null;
    return await apiRequest("next", {
      videoId: videoId,
      playlistId: "RD" + videoId
    }, {}, userId, false, "WEB_REMIX");
  } catch (err) {
    console.warn(`[InnerTube] getRadioQueue failed for videoId ${videoId}: ${err.message}`);
    return null;
  }
}

async function getCharts(userId) {
  try {
    return await apiRequestWithBrowseFallback({ browseId: "FEmusic_charts" }, {}, userId);
  } catch (err) {
    console.warn(`[InnerTube] getCharts failed: ${err.message}`);
    return null;
  }
}

function parsePlaylistPanel(data) {
  const contents =
    data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ||
    data?.contents?.singleColumnWatchNextResults?.playlistPanel?.playlistPanelRenderer?.contents ||
    [];
  const results = [];
  for (const item of contents) {
    const videoRenderer = item?.playlistPanelVideoRenderer;
    if (!videoRenderer) continue;
    const title = videoRenderer.title?.runs?.map(r => r.text).join("") || "";
    const videoId = videoRenderer.videoId;
    if (!videoId || !title) continue;
    
    const runs = videoRenderer.longBylineText?.runs || [];
    const artists = [];
    let album = null;
    let isArtist = true;
    for (const run of runs) {
      const text = run.text.trim();
      if (text === "•" || text === "," || text === "&") {
        if (text === "•") isArtist = false;
        continue;
      }
      if (isArtist) {
        artists.push(text);
      } else {
        album = text;
      }
    }

    const thumbnails = deepFindThumbnails(videoRenderer) || videoRenderer.thumbnail?.thumbnails || [];
    results.push({
      videoId,
      title,
      artist: artists[0] || "",
      authors: artists,
      album,
      duration: null,
      artworkUrl: cleanThumbnail(thumbnails),
      thumbnail: cleanThumbnail(thumbnails),
      uri: `https://www.youtube.com/watch?v=${videoId}`,
      source: "youtube",
      isrc: null,
      explicit: false,
    });
  }
  return results;
}

function extractPlaylistHeader(data) {
  const header = findDeep(data, node => node?.musicDetailHeaderRenderer || node?.musicResponsiveHeaderRenderer || node?.musicPlaylistShelfRenderer);
  const renderer = header?.musicDetailHeaderRenderer || header?.musicResponsiveHeaderRenderer || {};
  const title = renderer?.title?.runs?.map(r => r.text).join("") || renderer?.title?.simpleText || "";
  const thumbnails = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
    || renderer?.thumbnail?.thumbnails || [];
  const artworkUrl = thumbnails.length ? thumbnails[thumbnails.length - 1]?.url : null;
  const subtitleRuns = renderer?.straplineTextOne?.runs || renderer?.subtitle?.runs || [];
  const description = Array.isArray(subtitleRuns)
    ? subtitleRuns.map(r => r.text).filter(Boolean).join("").replace(/\s*[•|]\s*/g, " • ").trim()
    : "";
  const artist = renderer?.straplineTextTwo?.runs?.map(r => r.text).filter(Boolean).join(", ") || description;
  return { title, description, artworkUrl, artist };
}

async function getPlaylistTracks(playlistId, userId) {
  const cacheKey = `${userId || "__global__"}:${playlistId}`;
  const cached = playlistTracksCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PLAYLIST_TRACKS_CACHE_TTL) {
    return cached.data;
  }
  if (playlistTracksInFlight.has(cacheKey)) {
    return playlistTracksInFlight.get(cacheKey);
  }

  const inFlight = (async () => {
    try {
      const normalizedPlaylistId = playlistId.replace(/^VL/, "");
      const browseCandidates = (normalizedPlaylistId.startsWith("RD") || normalizedPlaylistId.startsWith("RDCLAK"))
        ? [normalizedPlaylistId]
        : normalizedPlaylistId.startsWith("PL")
          ? [`VL${normalizedPlaylistId}`, normalizedPlaylistId]
          : [normalizedPlaylistId, `VL${normalizedPlaylistId}`];

      let header = null;

      for (const browseId of [...new Set(browseCandidates.filter(Boolean))]) {
        try {
          const data = await apiRequestWithBrowseFallback({ browseId }, {}, userId);
          if (!data) continue;

          if (!header) header = extractPlaylistHeader(data);

          const tracks = [];
          const queue = [data];
          const seenContinuations = new Set();
          let pages = 0;
          let consecutiveEmpty = 0;

          while (queue.length && pages < 50) {
            const current = queue.shift();
            let page = extractPlaylistTracksFromResponse(current);
            if (!page.tracks.length && !page.continuations.length) {
              page = extractShelfTracks(current);
            }
            tracks.push(...page.tracks);

            if (!page.tracks.length) {
              consecutiveEmpty++;
              if (consecutiveEmpty >= 2) break;
            } else {
              consecutiveEmpty = 0;
            }

            for (const token of page.continuations) {
              if (seenContinuations.has(token)) continue;
              seenContinuations.add(token);
              try {
                const next = await apiRequestWithBrowseFallback({ continuation: token }, {}, userId);
                if (next) queue.push(next);
              } catch (err) {
                console.warn(`[InnerTube] getPlaylistTracks continuation failed for ${playlistId}: ${err.message}`);
              }
            }

            pages++;
          }

          const deduped = dedupeTracks(tracks);
          if (deduped.length) {
            const envelope = {
              id: normalizedPlaylistId,
              title: header?.title || "",
              description: header?.description || "",
              artworkUrl: header?.artworkUrl || deduped[0]?.artworkUrl || null,
              tracks: deduped,
            };
            playlistTracksCache.set(cacheKey, { data: envelope, ts: Date.now() });
            return envelope;
          }
        } catch (err) {
          console.warn(`[InnerTube] getPlaylistTracks candidate ${browseId} failed for ${playlistId}: ${err.message}`);
        }
      }

      return { id: normalizedPlaylistId, title: "", description: "", artworkUrl: null, tracks: [] };
    } catch (err) {
      console.warn(`[InnerTube] getPlaylistTracks failed for ${playlistId}: ${err.message}`);
      return { id: normalizedPlaylistId, title: "", description: "", artworkUrl: null, tracks: [] };
    }
  })();

  playlistTracksInFlight.set(cacheKey, inFlight);
  try {
    return await inFlight;
  } finally {
    playlistTracksInFlight.delete(cacheKey);
  }
}

function extractAlbumPlaylistId(data) {
  // OpenTune: extrae el playlistId real del album (formato OLAK5uy_...)
  // desde microformat URL, botones de reproduccion o menu
  const microformat = data?.microformat?.microformatDataRenderer;
  const canonicalUrl = microformat?.urlCanonical || '';
  if (canonicalUrl.includes('list=')) {
    const list = canonicalUrl.split('list=')[1].split('&')[0];
    if (list.startsWith('OLAK')) return list;
  }
  const header = findDeep(data, (node) => node?.musicDetailHeaderRenderer || node?.musicResponsiveHeaderRenderer);
  const renderer = header?.musicDetailHeaderRenderer || header?.musicResponsiveHeaderRenderer || {};
  const buttons = renderer?.buttons || [];
  for (const b of buttons) {
    const pid = b?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
                b?.buttonRenderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId;
    if (pid) return pid;
  }
  return null;
}

async function getAlbumTracks(albumId, userId, initialData = null) {
  try {
    const normalizedId = albumId.replace(/^VL/, "");

    const fetchTracksWithClient = async (includeAuth, browseId, clientName) => {
      const data = initialData && includeAuth && browseId === normalizedId && clientName === "ANDROID_MUSIC"
        ? initialData
        : includeAuth
          ? await apiRequest("browse", { browseId }, {}, userId, true, clientName).catch(() => null)
          : await apiRequest("browse", { browseId }, {}, userId, false, clientName).catch(() => null);

      if (!data) return [];

      const albumArtists = extractAlbumArtistsFromHeader(data);

      const tracks = [];
      const queue = [data];
      const seenContinuations = new Set();
      let pages = 0;
      let consecutiveEmpty = 0;

      while (queue.length && pages < 50) {
        const current = queue.shift();
        const page = extractShelfTracks(current);
        tracks.push(...page.tracks);

        if (!page.tracks.length) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
        } else {
          consecutiveEmpty = 0;
        }

        for (const token of page.continuations) {
          if (seenContinuations.has(token)) continue;
          seenContinuations.add(token);
          try {
            const next = includeAuth
              ? await apiRequest("browse", { continuation: token }, {}, userId, true, clientName)
              : await apiRequest("browse", { continuation: token }, {}, userId, false, clientName);
            if (next) queue.push(next);
          } catch (err) {
            console.warn(`[InnerTube] getAlbumTracks continuation failed for ${albumId}: ${err.message}`);
          }
        }

        pages++;
      }

      if (albumArtists.length) {
        for (let i = 0; i < tracks.length; i++) {
          const t = tracks[i];
          if (!t.authors || !t.authors.length) {
            tracks[i] = { ...t, artist: albumArtists[0], authors: albumArtists, artists: albumArtists };
          }
        }
      }

      return dedupeTracks(tracks);
    };

    // Race strategy: lanza ANDROID_MUSIC y WEB_REMIX en paralelo,
    // pero si browseId empieza por OLAK salta ANDROID_MUSIC (siempre da 404)
    const raceClients = async (includeAuth, browseId) => {
      const isOlak = String(browseId || '').startsWith('OLAK');
      const clients = isOlak ? ["WEB_REMIX"] : ["ANDROID_MUSIC", "WEB_REMIX"];

      if (clients.length === 1) {
        return await fetchTracksWithClient(includeAuth, browseId, clients[0]);
      }

      const results = await Promise.allSettled(
        clients.map(c => fetchTracksWithClient(includeAuth, browseId, c))
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.length) return r.value;
      }
      return [];
    };

    // Paso 1: Sin auth primero (evita 500 por dataSyncId)
    let tracks = await raceClients(false, normalizedId);
    if (!tracks.length) {
      tracks = await raceClients(true, normalizedId);
    }
    if (tracks.length) return tracks;

    // Paso 2: Obtener OLAK desde WEB_REMIX (sin auth)
    let olakId = initialData ? extractAlbumPlaylistId(initialData) : null;
    if (!olakId) {
      const webData = await apiRequest("browse", { browseId: normalizedId }, {}, userId, false, "WEB_REMIX").catch(() => null);
      if (webData) olakId = extractAlbumPlaylistId(webData);
    }

    // Paso 3: Si encontramos OLAK, intentar con WEB_REMIX directamente (sin auth primero)
    if (olakId) {
      console.log(`[InnerTube] getAlbumTracks trying OLAK playlist ${olakId} for ${albumId}`);
      tracks = await fetchTracksWithClient(false, olakId, "WEB_REMIX");
      if (!tracks.length) {
        tracks = await fetchTracksWithClient(true, olakId, "WEB_REMIX");
      }
      if (tracks.length) return tracks;
    }

    return [];
  } catch (err) {
    console.warn(`[InnerTube] getAlbumTracks failed for ${albumId}: ${err.message}`);
    return [];
  }
}

function extractAlbumArtistsFromHeader(data) {
  const header = findDeep(data, (node) => node?.musicDetailHeaderRenderer || node?.musicResponsiveHeaderRenderer || node?.musicVisualHeaderRenderer);
  const renderer = header?.musicDetailHeaderRenderer || header?.musicResponsiveHeaderRenderer || header?.musicVisualHeaderRenderer || {};
  const straplineRuns = renderer?.straplineTextOne?.runs || [];
  const subtitleRuns = straplineRuns.length ? straplineRuns : (renderer?.subtitle?.runs || []);
  const artists = [];
  if (Array.isArray(subtitleRuns)) {
    for (const run of subtitleRuns) {
      const text = (run?.text || "").trim();
      if (!text || text === "•") continue;
      const cfg = run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig;
      if (cfg?.pageType === "MUSIC_PAGE_TYPE_ARTIST") artists.push(text);
    }
  }
  return artists;
}

async function getAlbumDetails(albumId, userId) {
  const cacheKey = `${userId || "__global__"}:${albumId}`;
  const cached = albumDetailsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < ALBUM_DETAILS_CACHE_TTL) {
    return cached.data;
  }
  if (albumDetailsInFlight.has(cacheKey)) {
    return albumDetailsInFlight.get(cacheKey);
  }

  const inFlight = (async () => {
    try {
      let data = await apiRequest("browse", { browseId: albumId }, {}, userId, false, "ANDROID_MUSIC");
      if (!data) {
        data = await apiRequest("browse", { browseId: albumId }, {}, userId, true, "ANDROID_MUSIC");
      }
      if (!data) return null;

      const details = parseAlbumDetails(data, albumId);
      const tracks = await getAlbumTracks(albumId, userId, data);
      const result = { ...details, tracks };

      // Fallback: si ANDROID_MUSIC no trajo artista, extraer del primer track (OLAK/WEB_REMIX)
      if (!result.artist && Array.isArray(tracks) && tracks.length) {
        const firstArtist = tracks[0]?.artist || tracks[0]?.authors?.[0];
        if (firstArtist) {
          result.artist = firstArtist;
          result.artists = [firstArtist];
        }
      }

      albumDetailsCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    } catch (err) {
      console.warn(`[InnerTube] getAlbumDetails failed for ${albumId}: ${err.message}`);
      return null;
    }
  })();

  albumDetailsInFlight.set(cacheKey, inFlight);
  try {
    return await inFlight;
  } finally {
    albumDetailsInFlight.delete(cacheKey);
  }
}

// ── Rich Suggestions (InnerTube Search Suggestions) ────────────────────

async function getSearchSuggestions(query, userId) {
  if (!query || query.trim().length === 0) return [];
  try {
    const inputQuery = query.trim();
    const data = await apiRequest("music/get_search_suggestions", { input: inputQuery }, {}, userId, true, "WEB_REMIX");
    const contents = data?.contents?.searchSuggestionsSectionRenderer?.contents || [];
    const suggestions = [];
    for (const item of contents) {
      // musicResponsiveListItemRenderer (rich suggestions with thumbnails)
      const musicItem = item?.musicResponsiveListItemRenderer;
      if (musicItem) {
        const parsed = parseMusicItem(musicItem);
        if (parsed) {
          suggestions.push({
            text: parsed.title,
            type: parsed.pageType === "MUSIC_PAGE_TYPE_ARTIST" ? "artist" :
                  parsed.pageType === "MUSIC_PAGE_TYPE_ALBUM" ? "album" :
                  parsed.pageType === "MUSIC_PAGE_TYPE_PLAYLIST" ? "playlist" :
                  parsed.videoId ? "song" : "browse",
            browseId: parsed.browseId || parsed.artistBrowseId || parsed.albumBrowseId || null,
            videoId: parsed.videoId || null,
            icon: null,
            artworkUrl: parsed.artworkUrl || parsed.thumbnail || null,
          });
          continue;
        }
      }
      // searchSuggestionRenderer (standard text suggestions)
      const renderer = item?.searchSuggestionRenderer;
      if (!renderer) continue;
      const text = renderer.suggestion?.runs?.map(r => r.text).join("") || renderer.suggestion?.simpleText || "";
      if (!text) continue;
      const navigationEndpoint = renderer.navigationEndpoint;
      const browseEndpoint = navigationEndpoint?.browseEndpoint;
      const watchEndpoint = navigationEndpoint?.watchEndpoint;
      let type = "query";
      let browseId = null;
      let videoId = null;
      if (browseEndpoint?.browseId) {
        browseId = browseEndpoint.browseId;
        const pageType = browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
        if (pageType === "MUSIC_PAGE_TYPE_ARTIST") type = "artist";
        else if (pageType === "MUSIC_PAGE_TYPE_ALBUM") type = "album";
        else if (pageType === "MUSIC_PAGE_TYPE_PLAYLIST") type = "playlist";
        else type = "browse";
      } else if (watchEndpoint?.videoId) {
        videoId = watchEndpoint.videoId;
        type = "song";
      }
      const icon = renderer.icon?.iconType || null;
      const thumbnails = renderer.thumbnail?.thumbnails || renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
      suggestions.push({
        text,
        type,
        browseId,
        videoId,
        icon,
        artworkUrl: cleanThumbnail(thumbnails),
      });
    }
    return suggestions;
  } catch (err) {
    console.warn(`[InnerTube] getSearchSuggestions failed for "${query}": ${err.message}`);
    return [];
  }
}

// ── Artist Browse Page ─────────────────────────────────────────────────

async function getArtistPage(browseId, userId) {
  if (!browseId) return null;
  try {
    const data = await apiRequestWithBrowseFallback({ browseId }, {}, userId);
    if (!data) return null;
    const header = findDeep(data, node => node?.musicImmersiveHeaderRenderer || node?.musicVisualHeaderRenderer || node?.musicDetailHeaderRenderer || node?.musicResponsiveHeaderRenderer);
    const immersiveRenderer = header?.musicImmersiveHeaderRenderer;
    const visualRenderer = header?.musicVisualHeaderRenderer;
    const detailRenderer = header?.musicDetailHeaderRenderer || header?.musicResponsiveHeaderRenderer;
    const title = immersiveRenderer?.title?.runs?.map(r => r.text).join("") ||
                  visualRenderer?.title?.runs?.map(r => r.text).join("") ||
                  detailRenderer?.title?.runs?.map(r => r.text).join("") ||
                  detailRenderer?.title?.simpleText || "";
    const thumbnail = immersiveRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
                      visualRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
                      detailRenderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ||
                      [];
    const subtitleRuns = detailRenderer?.subtitle?.runs || [];
    let subscriberCount = null;
    for (const run of subtitleRuns) {
      const text = (run.text || "").trim();
      if (/\d/.test(text) && (text.includes("suscriptor") || text.includes("subscriber"))) {
        subscriberCount = text;
        break;
      }
    }
    const artistInfo = {
      browseId,
      title,
      artworkUrl: cleanThumbnail(thumbnail),
      subscriberCount,
    };
    const sections = [];
    const contents = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ||
                     data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
    for (const section of contents) {
      const parsed = parseCarouselSection(section?.musicCarouselShelfRenderer);
      if (parsed) sections.push(parsed);
    }
    return { artist: artistInfo, sections };
  } catch (err) {
    console.warn(`[InnerTube] getArtistPage failed for ${browseId}: ${err.message}`);
    return null;
  }
}

// ── Video Real Detection ───────────────────────────────────────────────

function isRealVideo(watchEndpoint) {
  if (!watchEndpoint?.watchEndpointMusicConfig) return null;
  const musicVideoType = watchEndpoint.watchEndpointMusicConfig.musicVideoType;
  if (musicVideoType === "MUSIC_VIDEO_TYPE_OMV") return true;
  if (musicVideoType === "MUSIC_VIDEO_TYPE_UGC") return true;
  if (musicVideoType === "MUSIC_VIDEO_TYPE_ATV") return false;
  return null;
}

// ── Menu Extraction ────────────────────────────────────────────────────

function extractBrowseIdFromMenu(renderer) {
  const menu = renderer?.menu?.menuRenderer;
  if (!menu?.items) return null;
  for (const item of menu.items) {
    const menuNav = item?.menuNavigationItemRenderer?.navigationEndpoint;
    if (!menuNav) continue;
    const browseId = menuNav?.browseEndpoint?.browseId ||
                     menuNav?.watchEndpoint?.playlistId ||
                     null;
    if (browseId) return browseId;
  }
  return null;
}

// ── Carousel Item Parser ───────────────────────────────────────────────

function parseCarouselItem(content) {
  const twoRow = content?.musicTwoRowItemRenderer;
  if (!twoRow) return null;
  const itemTitle = twoRow.title?.runs?.map(r => r.text).join("") || "";
  if (!itemTitle) return null;
  const itemSubtitle = twoRow.subtitle?.runs?.map(r => r.text).join("") || "";
  const navEndpoint = twoRow.navigationEndpoint;
  const browseId = navEndpoint?.browseEndpoint?.browseId || null;
  const videoId = navEndpoint?.watchEndpoint?.videoId || null;
  const playlistId = navEndpoint?.watchEndpoint?.playlistId || navEndpoint?.watchPlaylistEndpoint?.playlistId || null;
  const itemThumbnails = twoRow.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  const pageType = navEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || null;
  let itemType = "unknown";
  if (pageType === "MUSIC_PAGE_TYPE_ALBUM") itemType = "album";
  else if (pageType === "MUSIC_PAGE_TYPE_PLAYLIST") itemType = "playlist";
  else if (pageType === "MUSIC_PAGE_TYPE_ARTIST") itemType = "artist";
  else if (pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL") itemType = "channel";
  else if (videoId) itemType = "video";
  return {
    title: itemTitle,
    subtitle: itemSubtitle,
    browseId,
    videoId,
    playlistId,
    artworkUrl: cleanThumbnail(itemThumbnails),
    type: itemType,
  };
}

function parseCarouselSection(carouselRenderer) {
  if (!carouselRenderer) return null;
  const headerText = carouselRenderer.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs?.map(r => r.text).join("") ||
                     carouselRenderer.header?.musicCarouselShelfBasicHeaderRenderer?.title?.simpleText || "";
  if (!headerText) return null;
  const items = [];
  for (const content of (carouselRenderer.contents || [])) {
    const parsed = parseCarouselItem(content);
    if (parsed) items.push(parsed);
  }
  if (!items.length) return null;
  return { title: headerText, items };
}

// ── Related Sections (from /next endpoint) ─────────────────────────────

function parseRelatedSections(data) {
  // The /next response has a "Related" tab with sectionListRenderer contents
  const tabs = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
  // Find the "Related" tab (usually second tab, but search by title to be safe)
  let relatedTab = null;
  for (const tab of tabs) {
    const tabTitle = tab?.tabRenderer?.title?.toLowerCase() || "";
    if (tabTitle === "related" || tabTitle === "relacionado") {
      relatedTab = tab?.tabRenderer?.content?.sectionListRenderer?.contents || null;
      break;
    }
  }
  if (!relatedTab) {
    // Fallback: use first tab that has sectionListRenderer with carousels
    for (const tab of tabs) {
      const contents = tab?.tabRenderer?.content?.sectionListRenderer?.contents || [];
      if (contents.some(c => c?.musicCarouselShelfRenderer)) {
        relatedTab = contents;
        break;
      }
    }
  }
  if (!relatedTab) return [];
  const sections = [];
  for (const section of relatedTab) {
    const parsed = parseCarouselSection(section?.musicCarouselShelfRenderer);
    if (parsed) sections.push(parsed);
  }
  return sections;
}

async function getRelatedSections(videoId, userId) {
  if (!videoId) return [];
  try {
    const data = await apiRequest("next", {
      videoId: videoId,
      playlistId: "RD" + videoId,
    }, {}, userId, true, "ANDROID_MUSIC");
    if (!data) return [];
    return parseRelatedSections(data);
  } catch (err) {
    console.warn(`[InnerTube] getRelatedSections failed for ${videoId}: ${err.message}`);
    return [];
  }
}

// ── YouTube Music Lyrics (Official) ────────────────────────────────────

function extractLyricsBrowseIdFromNext(data, targetVideoId) {
  if (!data || !targetVideoId) return null;
  const contents =
    data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ||
    data?.contents?.singleColumnWatchNextResults?.playlistPanel?.playlistPanelRenderer?.contents ||
    [];
  for (const item of contents) {
    const vr = item?.playlistPanelVideoRenderer;
    if (!vr || vr.videoId !== targetVideoId) continue;
    const menuItems = vr.menu?.menuRenderer?.items || [];
    for (const menuItem of menuItems) {
      const nav = menuItem?.menuServiceItemRenderer?.navigationEndpoint;
      if (!nav) continue;
      const browseId = nav?.browseEndpoint?.browseId || null;
      if (browseId && browseId.includes("lyrics")) return browseId;
    }
  }
  return null;
}

function parseYtmLyrics(data) {
  if (!data) return null;
  const shelf = findDeep(data, node => node?.musicDescriptionShelfRenderer);
  const renderer = shelf?.musicDescriptionShelfRenderer;
  if (!renderer) return null;
  const description = renderer.description?.runs?.map(r => r.text).join("") || renderer.description?.simpleText || "";
  const subheader = renderer.subheader?.runs?.map(r => r.text).join("") || renderer.subheader?.simpleText || "";
  const footer = renderer.footer?.runs?.map(r => r.text).join("") || renderer.footer?.simpleText || "";
  if (!description) return null;
  return {
    lyrics: description,
    source: "youtube_music",
    credits: subheader || null,
    footer: footer || null,
    syncType: "unsynced",
  };
}

async function getYtmLyricsByBrowseId(browseId, userId) {
  if (!browseId) return null;
  try {
    const data = await apiRequestWithBrowseFallback({ browseId }, {}, userId);
    if (!data) return null;
    return parseYtmLyrics(data);
  } catch (err) {
    console.warn(`[InnerTube] getYtmLyricsByBrowseId failed for ${browseId}: ${err.message}`);
    return null;
  }
}

async function getYtmLyrics(videoId, userId) {
  if (!videoId) return null;
  try {
    const nextData = await apiRequest("next", {
      videoId,
      playlistId: "RD" + videoId,
    }, {}, userId, true, "ANDROID_MUSIC");
    if (!nextData) return null;
    const browseId = extractLyricsBrowseIdFromNext(nextData, videoId);
    if (!browseId) return null;
    return await getYtmLyricsByBrowseId(browseId, userId);
  } catch (err) {
    console.warn(`[InnerTube] getYtmLyrics failed for ${videoId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  searchQuery,
  searchQueryDetailed,
  searchContinuationDetailed,
  searchAlbumsDetailed,
  searchAlbumsContinuationDetailed,
  searchTrack,
  enrichTracks,
  getStreamUrl,
  getPlayer,
  initialize,
  apiRequest,
  getHomeFeed,
  getRadioQueue,
  getCharts,
  parsePlaylistPanel,
  parseMusicItem,
  setCookies,
  removeCookies,
  clearHomeFeedCache,
  getLibraryPlaylists,
  getAlbumTracks,
  getAlbumDetails,
  resolveCookieString,
  extractDataSyncId,
  resolveDataSyncId,
  setDataSyncId,
  setVisitorData,
  getPlaylistTracks,
  onSessionChange,
  getSearchSuggestions,
  getArtistPage,
  isRealVideo,
  extractBrowseIdFromMenu,
  getRelatedSections,
  parseRelatedSections,
  parseCarouselSection,
  parseCarouselItem,
  getYtmLyrics,
  getYtmLyricsByBrowseId,
  parseYtmLyrics,
  extractLyricsBrowseIdFromNext,
  getPlayerWithMetadata,
};
