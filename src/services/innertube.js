const tough = require("tough-cookie");
const axios = require("axios");
const querystring = require("querystring");
const crypto = require("crypto");

const USER_AGENT_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const USER_AGENT_ANDROID_VR = "com.google.android.apps.youtube.vr.oculus/1.37 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1; Cronet/107.0.5284.2)";
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

const homeFeedCache = new Map();
const HOME_FEED_CACHE_TTL = 5 * 60 * 1000;
const homeFeedInFlight = new Map();

const playlistTracksCache = new Map();
const PLAYLIST_TRACKS_CACHE_TTL = 5 * 60 * 1000;
const playlistTracksInFlight = new Map();

function resolveClientConfig() {
  switch (INNERTUBE_CLIENT) {
    case "WEB_REMIX":
      return {
        clientName: "WEB_REMIX",
        clientNameValue: 67,
        clientVersion: "1.20260114.01.00",
        userAgent: USER_AGENT_WEB,
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

function checkRateLimit(endpoint) {
  const now = Date.now();
  if (now - lastReset > 1000) {
    requestCounts.search = 0;
    requestCounts.player = 0;
    lastReset = now;
  }
  requestCounts[endpoint] = (requestCounts[endpoint] || 0) + 1;
  const limits = { search: 10, player: 3 };
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
            headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US" },
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
      config = {
        apiKey: ytcfg.INNERTUBE_API_KEY,
        apiVersion: ytcfg.INNERTUBE_API_VERSION || API_VERSION,
        ...client,
        visitorData: ytcfg.VISITOR_DATA,
        hl: ytcfg.HL || "en",
        gl: process.env.REGION || ytcfg.GL || "PE",
      };
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
      // Refresh cached auth metadata for this user.
      extractDataSyncId(cookieString).then(dsId => {
        if (dsId) userDataSyncIdMap.set(userId, dsId);
      });
      return true;
    }
    return false;
  } else {
    if (userCookieString !== cookieString) {
      userCookieString = cookieString;
      clearUserCaches("__global__");
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
    userCookiesMap.delete(userId);
    userDataSyncIdMap.delete(userId);
    userVisitorDataMap.delete(userId);
    clearUserCaches(userId);
  } else {
    userCookieString = null;
    userDataSyncIdMap.clear();
    userVisitorDataMap.clear();
    clearUserCaches("__global__");
  }
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
}

function startRefreshTimer() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    try {
      initPromise = null;
      config = null;
      playerCache.clear();
      await initialize();
      console.log("[InnerTube] Config refreshed");
    } catch (e) {
      console.warn(`[InnerTube] Periodic refresh failed: ${e.message}`);
    }
  }, 30 * 60 * 1000);
  if (refreshInterval.unref) refreshInterval.unref();
}

function buildContext(userId, includeAuth) {
  const dataSyncId = includeAuth ? resolveDataSyncId(userId) : null;
  return {
    client: {
      clientName: config.clientName,
      clientVersion: config.clientVersion,
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

function buildHeaders(cookieString, userId, includeAuth) {
  const h = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US",
    "Content-Type": "application/json",
    "X-Goog-Api-Format-Version": "1",
    "X-Goog-Api-Key": API_KEY,
    "Origin": YTM_BASE,
    "Referer": `${YTM_BASE}/`,
    "X-Goog-AuthUser": "0",
    "X-YouTube-Client-Name": String(config.clientNameValue),
    "X-YouTube-Client-Version": config.clientVersion,
    "X-Goog-Visitor-Id": resolveVisitorData(userId) || "",
  };
  const effective = cookieString || userCookieString;
  if (effective) {
    h["Cookie"] = effective;
    if (includeAuth) {
      const sapisidHash = generateSapisidHash(effective, YTM_BASE);
      if (sapisidHash) {
        h["Authorization"] = `SAPISIDHASH ${sapisidHash}`;
      }
    }
  } else {
    const cookies = cookieJar.getCookieStringSync(YTM_BASE);
    if (cookies) h["Cookie"] = cookies;
  }
  return h;
}

async function apiRequest(endpoint, data, query = {}, userId, includeAuth) {
  checkRateLimit(endpoint);
  const cfg = await initialize();
  const url = `${YTM_BASE}/youtubei/${cfg.apiVersion}/${endpoint}?${querystring.stringify({ alt: "json", key: cfg.apiKey || API_KEY, ...query })}`;
  const body = { ...data, context: buildContext(userId, includeAuth) };
  const cookieString = resolveCookieString(userId);
  console.log(`[InnerTube] apiRequest endpoint=${endpoint} cookieLen=${cookieString ? cookieString.length : 0} perUserCookies=${!!(userId && userCookiesMap.has(userId))} includeAuth=${!!includeAuth}`);
  try {
    const res = await axios.post(url, body, {
      headers: buildHeaders(cookieString, userId, includeAuth),
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
    }
    throw err;
  }
}

async function apiRequestWithBrowseFallback(data, query, userId) {
  try {
    return await apiRequest("browse", data, query, userId, true);
  } catch (err) {
    const status = err?.response?.status;
    const reason = err?.response?.data?.error?.errors?.[0]?.reason || err?.response?.data?.error?.status;
    if (status === 500 && reason === "backendError") {
      console.warn("[InnerTube] browse backendError, retrying without delegate context");
      return await apiRequest("browse", data, query, userId, false);
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

async function searchQuery(query, type = "song", userId) {
  if (!query) return [];
  try {
    const data = await apiRequest("search", { query, params: getSearchParams(type) }, {}, userId);
    const items = parseSearchResults(data, type);
    return items;
  } catch (err) {
    console.warn(`[InnerTube] Search failed for "${query?.slice(0, 40)}": ${err.message}${err.response ? ` (${err.response.status})` : ""}`);
    return [];
  }
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
  if (!data?.contents?.tabbedSearchResultsRenderer?.tabs) return [];
  const tabs = data.contents.tabbedSearchResultsRenderer.tabs;
  for (const tab of tabs) {
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
    if (results.length) return results;
  }
  return [];
}

function parseMusicItem(renderer) {
  const flexColumns = renderer?.flexColumns || [];
  const fixedColumns = renderer?.fixedColumns || [];
  const getText = (col) => col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.map(r => r.text).join("") || "";
  const title = getText(flexColumns[0]);
  const subtitle = getText(flexColumns[1]);
  const thumbnail = renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const explicit = hasExplicitBadge(renderer);
  const videoId = renderer?.playlistItemData?.videoId ||
                  renderer?.navigationEndpoint?.watchEndpoint?.videoId ||
                  renderer?.thumbnailOverlay?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                  renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
                  renderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId ||
                  null;
  if (!videoId || !title) return null;
  const authors = subtitle ? subtitle.split("•")[0]?.split(",").map(a => a.trim()).filter(Boolean) : [];
  return {
    videoId,
    title,
    artist: authors[0] || "",
    authors,
    album: subtitle?.includes("•") ? subtitle.split("•").slice(1).join("•").trim() : null,
    duration: null,
    artworkUrl: cleanThumbnail(thumbnail),
    thumbnail: cleanThumbnail(thumbnail),
    uri: `https://www.youtube.com/watch?v=${videoId}`,
    source: "youtube",
    isrc: null,
    explicit,
  };
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

  const artists = subtitle ? subtitle.split("•")[0]?.split(",").map(a => a.trim()).filter(Boolean) : [];
  const thumbnails = r?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    videoId,
    title,
    artist: artists[0] || "",
    authors: artists,
    album: subtitle?.includes("•") ? subtitle.split("•").slice(1).join("•").trim() : null,
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
  try {
    const res = await axios.get(`${YT_BASE}/`, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 5000,
    });
    const match = res.data.match(/"signatureTimestamp":(\d+)/);
    if (match) return parseInt(match[1], 10);
    const match2 = res.data.match(/signatureTimestamp[=:]+(\d+)/);
    if (match2) return parseInt(match2[1], 10);
  } catch {}
  return Math.floor(Date.now() / 1000 / 3600) * 3600;
}

async function getPlayer(videoId) {
  const cached = playerCache.get(videoId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;
  try {
    const data = await apiRequest("player", {
      videoId,
      playbackContext: {
        contentPlaybackContext: {
          signatureTimestamp: await getSignatureTimestamp(),
        },
      },
      serviceIntegrityDimensions: {},
      thirdPartyUploadUrlSupport: false,
    });
    if (data?.streamingData) {
      playerCache.set(videoId, { data, ts: Date.now() });
    }
    return data;
  } catch (err) {
    console.warn(`[InnerTube] Player failed for ${videoId}: ${err.message}`);
    return null;
  }
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

async function getStreamUrl(videoId) {
  const cached = playerCache.get(videoId);
  const player = cached && Date.now() - cached.ts < CACHE_TTL ? cached.data : await getPlayer(videoId);
  if (!player) {
    console.warn(`[InnerTube] getStreamUrl(${videoId}): getPlayer returned null`);
    return null;
  }
  if (!player.streamingData) {
    console.warn(`[InnerTube] getStreamUrl(${videoId}): no streamingData in player response`);
    return null;
  }
  const { adaptiveFormats, expiresInSeconds } = player.streamingData;
  if (!adaptiveFormats?.length) {
    console.warn(`[InnerTube] getStreamUrl(${videoId}): no adaptiveFormats`);
    return null;
  }

  // 1. Formats with direct URL (legacy)
  let audioFormats = adaptiveFormats.filter(f =>
    f.mimeType?.startsWith("audio/") && f.url
  );

  // 2. Formats with signatureCipher/cipher (modern YouTube)
  if (!audioFormats.length) {
    audioFormats = adaptiveFormats
      .filter(f => f.mimeType?.startsWith("audio/") && (f.signatureCipher || f.cipher))
      .map(f => {
        const resolvedUrl = resolveCipher(f);
        return resolvedUrl ? { ...f, url: resolvedUrl } : null;
      })
      .filter(Boolean);
    if (audioFormats.length) {
      console.log(`[InnerTube] getStreamUrl(${videoId}): resolved ${audioFormats.length} format(s) via cipher`);
    }
  }

  // 3. Try any format with URL regardless of audio/video
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
  audioFormats.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const best = audioFormats[0];
  return best.url;
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

async function getHomeFeed(userId) {
  const cacheKey = userId || "__global__";
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
    const data = await apiRequest("browse", { browseId: "FEmusic_home" }, {}, userId, true);
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
  if (userId) homeFeedCache.delete(userId);
  else homeFeedCache.clear();
}

async function getLibraryPlaylists(userId) {
  try {
    const data = await apiRequest("browse", { browseId: "FEmusic_library_playlists" }, {}, userId, true);
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
    }, {}, userId);
  } catch (err) {
    console.warn(`[InnerTube] getRadioQueue failed for videoId ${videoId}: ${err.message}`);
    return null;
  }
}

async function getCharts(userId) {
  try {
    return await apiRequest("browse", { browseId: "FEmusic_charts" }, {}, userId, true);
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

    const thumbnails = videoRenderer.thumbnail?.thumbnails || [];
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
    const browseId = playlistId.startsWith("VL") || playlistId.startsWith("RD")
      ? playlistId
      : `VL${playlistId}`;
    const data = await apiRequestWithBrowseFallback({ browseId }, {}, userId);
    if (!data) return [];

    const tracks = [];
    const queue = [data];
    const seenContinuations = new Set();
    let pages = 0;

    while (queue.length && pages < 8) {
      const current = queue.shift();
      const page = extractShelfTracks(current);
      tracks.push(...page.tracks);

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
    playlistTracksCache.set(cacheKey, { data: deduped, ts: Date.now() });
    return deduped;
    } catch (err) {
      console.warn(`[InnerTube] getPlaylistTracks failed for ${playlistId}: ${err.message}`);
      return [];
    }
  })();

  playlistTracksInFlight.set(cacheKey, inFlight);
  try {
    return await inFlight;
  } finally {
    playlistTracksInFlight.delete(cacheKey);
  }
}

async function getAlbumTracks(albumId, userId) {
  try {
    const data = await apiRequestWithBrowseFallback({ browseId: albumId }, {}, userId);
    if (!data) return [];

    const tracks = [];
    const queue = [data];
    const seenContinuations = new Set();
    let pages = 0;

    while (queue.length && pages < 8) {
      const current = queue.shift();
      const page = extractShelfTracks(current);
      tracks.push(...page.tracks);

      for (const token of page.continuations) {
        if (seenContinuations.has(token)) continue;
        seenContinuations.add(token);
        try {
          const next = await apiRequestWithBrowseFallback({ continuation: token }, {}, userId);
          if (next) queue.push(next);
        } catch (err) {
          console.warn(`[InnerTube] getAlbumTracks continuation failed for ${albumId}: ${err.message}`);
        }
      }

      pages++;
    }

    return dedupeTracks(tracks);
  } catch (err) {
    console.warn(`[InnerTube] getAlbumTracks failed for ${albumId}: ${err.message}`);
    return [];
  }
}

module.exports = {
  searchQuery,
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
  resolveCookieString,
  extractDataSyncId,
  resolveDataSyncId,
  setDataSyncId,
  setVisitorData,
  getPlaylistTracks,
};
