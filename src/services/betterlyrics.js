const axios = require("axios");

const API_BASE_URL = "https://lyrics-api.boidu.dev/";
const API_KEY = (process.env.BETTERLYRICS_API_KEY || process.env.LYRICS_API_KEY || "").trim();

const client = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
  headers: { Accept: "application/json, text/plain, */*" },
});

function parseTime(value) {
  if (!value) return null;
  const raw = String(value).trim();

  if (/^\d+(?:\.\d{1,3})?$/.test(raw)) {
    return parseFloat(raw);
  }

  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) return null;

  const secondsPart = parts.pop();
  const minutesPart = parts.pop();
  const hoursPart = parts.length ? parts.pop() : "0";

  const seconds = parseFloat(secondsPart);
  const minutes = parseInt(minutesPart, 10);
  const hours = parseInt(hoursPart || "0", 10);

  if ([seconds, minutes, hours].some((n) => Number.isNaN(n))) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function decodeLyricsResponse(body) {
  if (!body) return null;

  if (typeof body === "object") {
    if (typeof body.ttml === "string" && body.ttml.trim()) return body.ttml.trim();
    if (typeof body.lyrics === "string" && body.lyrics.trim()) return body.lyrics.trim();
    if (typeof body.text === "string" && body.text.trim()) return body.text.trim();
    return null;
  }

  const trimmed = String(body).trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("<")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed.ttml || parsed.lyrics || null;
  } catch {
    return trimmed;
  }
}

function stripTags(text) {
  return String(text || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function extractWordsFromLine(lineHtml) {
  const words = [];
  const regex = /<span\b([^>]*)begin=["']([^"']+)["'][^>]*?(?:end=["']([^"']+)["']|dur=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/span>/gi;
  let match;

  while ((match = regex.exec(lineHtml)) !== null) {
    const attrs = match[1] || "";
    if (/x-bg/i.test(attrs)) continue;

    const start = parseTime(match[2]);
    if (start == null) continue;

    const end = match[3] ? parseTime(match[3]) : null;
    const dur = match[4] ? parseTime(match[4]) : null;
    const text = stripTags(match[5]).trim();
    if (!text) continue;

    words.push({
      time: start,
      endTime: end != null ? end : dur != null ? start + dur : null,
      text: String(text),
    });
  }

  return words;
}

function parseTtml(ttml) {
  const text = String(ttml || "");
  const lines = [];
  const regex = /<p\b[^>]*begin=["']([^"']+)["'][^>]*?(?:end=["']([^"']+)["']|dur=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const start = parseTime(match[1]);
    if (start == null) continue;

    const end = match[2] ? parseTime(match[2]) : null;
    const dur = match[3] ? parseTime(match[3]) : null;
    const body = stripTags(match[4]).trim();
    if (!body) continue;
    const words = extractWordsFromLine(match[4]);

    lines.push({
      time: start,
      text: String(body),
      endTime: end != null ? end : dur != null ? start + dur : null,
      words: words.length ? words : null,
    });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

async function fetchLyrics(endpoint, params) {
  const response = await client.get(endpoint, {
    params,
    headers: API_KEY ? { "X-API-Key": API_KEY } : undefined,
  });
  return decodeLyricsResponse(response.data);
}

async function getLyrics(trackName, artistName, albumName = "") {
  if (!API_KEY) return null;

  const cleanTitle = (trackName || "").trim();
  const cleanArtist = (artistName || "").trim();
  const cleanAlbum = (albumName || "").trim();

  if (!cleanTitle || !cleanArtist) return null;

  const attempts = [
    ["getLyrics", { s: cleanTitle, a: cleanArtist, ...(cleanAlbum ? { al: cleanAlbum } : {}) }],
    ["kugou/getLyrics", { s: cleanTitle, a: cleanArtist, ...(cleanAlbum ? { al: cleanAlbum } : {}) }],
  ];

  for (const [endpoint, params] of attempts) {
    try {
      const lyrics = await fetchLyrics(endpoint, params);
      if (!lyrics) continue;

      const synced = parseTtml(lyrics);
      const plain = synced.length ? synced.map((line) => String(line.text)).join("\n") : stripTags(lyrics).trim();

      if (!synced.length && !plain) continue;

      return {
        found: true,
        source: "betterlyrics",
        synced: synced.length
          ? synced.map(({ time, text, endTime, words }) => ({
              time,
              text: String(text),
              ...(endTime != null ? { endTime } : {}),
              ...(words && words.length ? { words } : {}),
            }))
          : null,
        plain: plain ? String(plain) : null,
        trackName: String(cleanTitle),
        artistName: String(cleanArtist),
      };
    } catch {
      // Try next endpoint
    }
  }

  return null;
}

module.exports = { getLyrics, parseTtml };
