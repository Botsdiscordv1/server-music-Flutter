const axios = require("axios");
const https = require("https");
const betterLyrics = require("./betterlyrics");

const LRCLIB_URL = "https://lrclib.net/api";

const lrclib = axios.create({
  baseURL: LRCLIB_URL,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

async function searchLRCLib(trackName, artistName, albumName = "") {
  try {
    const params = { track_name: trackName };
    if (artistName) params.artist_name = artistName;
    if (albumName) params.album_name = albumName;
    const res = await lrclib.get("/search", { params });
    const results = res.data || [];

    if (results.length === 0) return null;

    const qTitle = (trackName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const qArtist = (artistName || "").toLowerCase().replace(/[^a-z0-9]/g, "");

    let best = null;
    let bestScore = -1;

    for (const r of results) {
      const rTitle = (r.trackName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const rArtist = (r.artistName || "").toLowerCase().replace(/[^a-z0-9]/g, "");

      if (!r.syncedLyrics && !r.plainLyrics) continue;

      let score = 0;
      if (r.syncedLyrics) score += 2;
      if (r.plainLyrics) score += 1;

      if (qTitle && rTitle) {
        if (rTitle.includes(qTitle) || qTitle.includes(rTitle)) score += 4;
        else {
          const shorter = qTitle.length < rTitle.length ? qTitle : rTitle;
          const longer = qTitle.length < rTitle.length ? rTitle : qTitle;
          let common = 0;
          for (let i = 0; i < shorter.length; i++) {
            if (shorter[i] === longer[i]) common++;
          }
          if (common / longer.length > 0.6) score += 2;
        }
      }

      if (qArtist && rArtist) {
        if (rArtist.includes(qArtist) || qArtist.includes(rArtist)) {
          score += 3;
        } else {
          const aShorter = qArtist.length < rArtist.length ? qArtist : rArtist;
          const aLonger = qArtist.length < rArtist.length ? rArtist : qArtist;
          let aCommon = 0;
          for (let i = 0; i < aShorter.length; i++) {
            if (aShorter[i] === aLonger[i]) aCommon++;
          }
          if (aCommon / aLonger.length > 0.5) score += 2;
          else score -= 10;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }

    if (!best) return null;

    return {
      synced: best.syncedLyrics ? parseLrc(best.syncedLyrics) : null,
      plain: best.plainLyrics || null,
      duration: best.duration,
      trackName: best.trackName,
      artistName: best.artistName,
    };
  } catch {
    return null;
  }
}

async function searchGenius(trackName, artistName) {
  try {
    const query = `${trackName} ${artistName || ""}`.trim();
    let url = null;
    let fullTitle = trackName;

    if (process.env.GENIUS_ACCESS_TOKEN) {
      const res = await axios.get("https://api.genius.com/search", {
        params: { q: query },
        headers: { Authorization: `Bearer ${process.env.GENIUS_ACCESS_TOKEN}` },
      });
      const best = res.data?.response?.hits?.[0]?.result;
      if (best) {
        url = best.url;
        fullTitle = best.full_title || trackName;
      }
    } else {
      const res = await axios.get("https://genius.com/api/search/multi", {
        params: { per_page: 5, q: query },
      });
      const best = res.data?.response?.sections?.[0]?.hits?.[0]?.result;
      if (best) {
        url = best.url;
        fullTitle = best.full_title || trackName;
      }
    }

    if (!url) return null;

    const htmlRes = await axios.get(url);
    const html = htmlRes.data;
    const containers = html.match(/<div[^>]*data-lyrics-container[^>]*>([\s\S]*?)<\/div>/g) || [];
    if (!containers.length) return null;

    let lyrics = containers
      .map((c) => c.replace(/<br[^>]*>/g, "\n").replace(/<[^>]+>/g, ""))
      .join("\n")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#([0-9]+);/g, (m, p1) => String.fromCharCode(parseInt(p1)))
      .trim();

    if (!lyrics) return null;

    lyrics = lyrics.replace(/^[\s\S]*?Contributors[^\n]*\n/, "").trim();

    return {
      plain: lyrics,
      trackName: fullTitle.split(" by ")[0] || trackName,
      artistName: fullTitle.split(" by ")[1] || artistName,
    };
  } catch (err) {
    console.error("[Genius Fallback Error]:", err.message);
    return null;
  }
}

async function getLyrics(trackName, artistName, albumName = "", options = {}) {
  const source = (options.source || "").toString().trim().toLowerCase();
  const enabledProviders = normalizeEnabledProviders(options.enabledProviders);

  const cleanArtist = (artistName || "").replace(/\s*-\s*Topic$/, "");
  const providerOrder = buildProviderOrder(source, enabledProviders);

  for (const provider of providerOrder) {
    if (provider === "betterlyrics") {
      const result = await betterLyrics.getLyrics(trackName, cleanArtist, albumName);
      if (result) return normalizeLyricsResult(result);
      continue;
    }

    if (provider === "lrclib") {
      let lrclibResult = await searchLRCLib(trackName, cleanArtist, albumName);

      if (!lrclibResult && trackName) {
        const cleanTrack = trackName.replace(/\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "").replace(/-\s*(Topic|Lyrics|Official|Video|Audio|HD|HQ)/gi, "").replace(/\(\s*Topic\s*\)/gi, "").replace(/\s+/g, " ").trim();
        if (cleanTrack !== trackName) {
          lrclibResult = await searchLRCLib(cleanTrack, cleanArtist);
        }
      }

      if (!lrclibResult && trackName) {
        lrclibResult = await searchLRCLib(trackName);
      }

      if (lrclibResult) {
        return normalizeLyricsResult({ found: true, source: "lrclib", ...lrclibResult });
      }
      continue;
    }

    if (provider === "genius") {
      const geniusResult = await searchGenius(trackName, cleanArtist);
      if (geniusResult) {
        return normalizeLyricsResult({
          found: true,
          source: "genius",
          synced: null,
          plain: geniusResult.plain,
          trackName: geniusResult.trackName,
          artistName: geniusResult.artistName,
        });
      }
    }
  }

  return { found: false, synced: null, plain: null };
}

function normalizeLyricsResult(result) {
  if (!result) return { found: false, synced: null, plain: null };

  const synced = Array.isArray(result.synced)
    ? result.synced
        .map((line) => {
          const time = Number(line?.time);
          const text = line?.text;
          if (!Number.isFinite(time) || text == null) return null;
          const words = Array.isArray(line?.words)
            ? line.words
                .map((word) => {
                  const wordTime = Number(word?.time);
                  const wordText = word?.text;
                  if (!Number.isFinite(wordTime) || wordText == null) return null;
                  const normalized = { time: wordTime, text: String(wordText) };
                  if (word?.endTime != null && Number.isFinite(Number(word.endTime))) {
                    normalized.endTime = Number(word.endTime);
                  }
                  return normalized;
                })
                .filter(Boolean)
            : null;
          const normalized = { time, text: String(text) };
          if (words && words.length) normalized.words = words;
          if (line?.endTime != null && Number.isFinite(Number(line.endTime))) {
            normalized.endTime = Number(line.endTime);
          }
          return normalized;
        })
        .filter(Boolean)
    : null;

  return {
    found: Boolean(result.found),
    source: result.source != null ? String(result.source) : null,
    synced: synced && synced.length ? synced : null,
    plain: result.plain != null ? String(result.plain) : null,
    trackName: result.trackName != null ? String(result.trackName) : null,
    artistName: result.artistName != null ? String(result.artistName) : null,
    duration: result.duration,
  };
}

function normalizeEnabledProviders(enabledProviders) {
  if (!enabledProviders) return null;
  if (Array.isArray(enabledProviders)) {
    return enabledProviders.map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof enabledProviders === "string") {
    return enabledProviders.split(",").map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  }
  return null;
}

function buildProviderOrder(source, enabledProviders) {
  const allProviders = ["betterlyrics", "lrclib", "genius"];
  const enabledProvided = enabledProviders !== null && enabledProviders !== undefined;
  const enabledSet = enabledProvided ? new Set(enabledProviders) : null;
  const enabledOrder = enabledProvided ? allProviders.filter((provider) => enabledSet.has(provider)) : allProviders;

  if (source && source !== "automatico" && source !== "auto") {
    const requested = source.toLowerCase();
    if (enabledProvided && !enabledSet.has(requested)) return enabledOrder;
    return [requested, ...enabledOrder.filter((provider) => provider !== requested)];
  }

  return enabledOrder;
}

/**
 * Get the current lyric line based on playback position.
 * @param {LrcLine[]} lines  - parsed LRC lines
 * @param {number} positionMs - current playback position in ms
 * @returns {{ current: LrcLine, next: LrcLine|null, index: number }}
 */
function getCurrentLine(lines, positionMs) {
  const positionSec = positionMs / 1000;
  let index = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].time <= positionSec) {
      index = i;
      break;
    }
  }

  return {
    current: lines[index],
    next: lines[index + 1] || null,
    index,
  };
}

/**
 * Parse a raw .lrc string into an array of timed lines.
 * @param {string} lrc
 * @returns {LrcLine[]}
 *
 * @typedef {Object} LrcLine
 * @property {number} time  - seconds
 * @property {string} text
 */
function parseLrc(lrc) {
  const lines = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/g;
  let match;

  while ((match = regex.exec(lrc)) !== null) {
    const minutes = parseInt(match[1]);
    const seconds = parseInt(match[2]);
    const ms = parseInt(match[3].padEnd(3, "0"));
    const time = minutes * 60 + seconds + ms / 1000;
    const text = match[4].trim();

    if (text) lines.push({ time, text });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Format lyrics for a static Discord embed (plain or synced as plain).
 * Truncates to 4096 chars to respect embed limits.
 * @param {{ synced: LrcLine[]|null, plain: string|null }} lyrics
 * @returns {string}
 */
function formatLyricsForEmbed(lyrics) {
  let text = "";

  if (lyrics.plain) {
    text = lyrics.plain;
  } else if (lyrics.synced) {
    text = lyrics.synced.map((l) => l.text).join("\n");
  }

  return text.length > 4000 ? text.slice(0, 3997) + "..." : text;
}

module.exports = { getLyrics, getCurrentLine, parseLrc, formatLyricsForEmbed };
