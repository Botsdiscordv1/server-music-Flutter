const axios = require("axios");
const spotify = require("./spotify");

const CANVASES_URL = "https://spclient.wg.spotify.com/canvaz-cache/v0/canvases";
const CANVAS_DOWNLOADER_BASE = "https://www.canvasdownloader.com";

function toTrackUri(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  if (value.startsWith("spotify:track:")) return value;
  const urlMatch = value.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (urlMatch) return `spotify:track:${urlMatch[1]}`;
  return `spotify:track:${value}`;
}

function writeVarint(value) {
  let n = Number(value) >>> 0;
  const bytes = [];
  while (n > 127) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function writeTag(fieldNumber, wireType) {
  return writeVarint((fieldNumber << 3) | wireType);
}

function writeStringField(fieldNumber, value) {
  const text = Buffer.from(String(value || ""), "utf8");
  return Buffer.concat([writeTag(fieldNumber, 2), writeVarint(text.length), text]);
}

function encodeCanvasRequest(trackUris) {
  const tracks = [];
  for (const uri of trackUris) {
    const track = writeStringField(1, uri);
    tracks.push(Buffer.concat([writeTag(1, 2), writeVarint(track.length), track]));
  }
  return Buffer.concat(tracks);
}

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos];
    result |= (byte & 127) << shift;
    pos += 1;
    if ((byte & 128) === 0) return { value: result >>> 0, offset: pos };
    shift += 7;
  }
  throw new Error("Truncated varint");
}

function readLengthDelimited(buffer, offset) {
  const len = readVarint(buffer, offset);
  const start = len.offset;
  const end = start + len.value;
  return { value: buffer.slice(start, end), offset: end };
}

function readString(buffer, offset) {
  const data = readLengthDelimited(buffer, offset);
  return { value: data.value.toString("utf8"), offset: data.offset };
}

function skipField(buffer, offset, wireType) {
  switch (wireType) {
    case 0:
      return readVarint(buffer, offset).offset;
    case 1:
      return offset + 8;
    case 2:
      return readLengthDelimited(buffer, offset).offset;
    case 5:
      return offset + 4;
    default:
      throw new Error(`Unsupported wire type: ${wireType}`);
  }
}

function decodeArtist(buffer) {
  const artist = {};
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    const field = key.value >> 3;
    const wireType = key.value & 7;
    offset = key.offset;
    if (wireType !== 2) {
      offset = skipField(buffer, offset, wireType);
      continue;
    }
    if (field === 1) {
      const out = readString(buffer, offset);
      artist.artistUri = out.value;
      offset = out.offset;
    } else if (field === 2) {
      const out = readString(buffer, offset);
      artist.artistName = out.value;
      offset = out.offset;
    } else if (field === 3) {
      const out = readString(buffer, offset);
      artist.artistImgUrl = out.value;
      offset = out.offset;
    } else {
      offset = skipField(buffer, offset, wireType);
    }
  }
  return artist;
}

function decodeCanvas(buffer) {
  const canvas = {};
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    const field = key.value >> 3;
    const wireType = key.value & 7;
    offset = key.offset;

    if (wireType !== 2) {
      offset = skipField(buffer, offset, wireType);
      continue;
    }

    if (field === 1) {
      const out = readString(buffer, offset);
      canvas.id = out.value;
      offset = out.offset;
    } else if (field === 2) {
      const out = readString(buffer, offset);
      canvas.canvasUrl = out.value;
      offset = out.offset;
    } else if (field === 5) {
      const out = readString(buffer, offset);
      canvas.trackUri = out.value;
      offset = out.offset;
    } else if (field === 6) {
      const out = readLengthDelimited(buffer, offset);
      canvas.artist = decodeArtist(out.value);
      offset = out.offset;
    } else if (field === 9) {
      const out = readString(buffer, offset);
      canvas.otherId = out.value;
      offset = out.offset;
    } else if (field === 11) {
      const out = readString(buffer, offset);
      canvas.canvasUri = out.value;
      offset = out.offset;
    } else {
      offset = skipField(buffer, offset, wireType);
    }
  }
  return canvas;
}

function decodeCanvasResponse(buffer) {
  const canvases = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    const field = key.value >> 3;
    const wireType = key.value & 7;
    offset = key.offset;
    if (field === 1 && wireType === 2) {
      const out = readLengthDelimited(buffer, offset);
      canvases.push(decodeCanvas(out.value));
      offset = out.offset;
    } else {
      offset = skipField(buffer, offset, wireType);
    }
  }
  return { canvasesList: canvases };
}

async function getCanvasToken() {
  const url = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player";
  const response = await axios.get(url, {
    timeout: 12000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!response.data?.accessToken) {
    throw new Error(`Failed to get canvas token: ${response.status} ${response.statusText}`);
  }
  return response.data.accessToken;
}

async function fetchCanvasPage(trackIdOrUri) {
  const trackUri = toTrackUri(trackIdOrUri);
  if (!trackUri) return null;
  const url = `${CANVAS_DOWNLOADER_BASE}/canvas?link=${encodeURIComponent(`https://open.spotify.com/track/${trackUri.split(":").pop()}`)}`;
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    timeout: 12000,
  });
  return String(response.data || "");
}

function extractCanvasUrl(html) {
  const match = String(html || "").match(/<source\s+src="(https:\/\/canvaz\.scdn\.co[^"]+\.cnvs\.mp4)"/i);
  if (match) return match[1];
  const fallback = String(html || "").match(/<source\s+src="([^"]+\.mp4)"/i);
  return fallback ? fallback[1] : null;
}

async function getCanvases(trackUris, accessToken) {
  if (!Array.isArray(trackUris) || trackUris.length === 0) return { canvasesList: [] };

  const requestBytes = encodeCanvasRequest(trackUris.map(toTrackUri).filter(Boolean));
  const response = await axios.post(CANVASES_URL, requestBytes, {
    responseType: "arraybuffer",
    timeout: 12000,
    headers: {
      accept: "application/protobuf",
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en",
      "user-agent": "Spotify/8.5.49 iOS/Version 13.3.1 (Build 17D50)",
      "accept-encoding": "gzip, deflate, br",
      authorization: `Bearer ${accessToken}`,
    },
  });

  const body = Buffer.from(response.data);
  return decodeCanvasResponse(body);
}

async function getCanvasUrl(trackIdOrUri) {
  const trackUri = toTrackUri(trackIdOrUri);
  if (!trackUri) return null;

  try {
    const accessToken = await spotify.getSpotifyPublicAccessToken();
    const canvasResponse = await getCanvases([trackUri], accessToken);
    const canvas = (canvasResponse.canvasesList || []).find((item) => item.trackUri === trackUri && item.canvasUrl);
    if (canvas?.canvasUrl && canvas.canvasUrl.endsWith(".mp4")) {
      return { url: canvas.canvasUrl, source: "spotify_api" };
    }
  } catch {}

  try {
    const html = await fetchCanvasPage(trackUri);
    const url = extractCanvasUrl(html);
    return url ? { url, source: "fallback_canvasdownloader" } : null;
  } catch {
    return null;
  }
}

async function getCanvasUrlWithFallback(trackIdOrUri) {
  try {
    return await getCanvasUrl(trackIdOrUri);
  } catch {
    return null;
  }
}

module.exports = {
  getCanvasUrl,
  getCanvasUrlWithFallback,
  getCanvasToken,
  getCanvases,
  encodeCanvasRequest,
  decodeCanvasResponse,
  toTrackUri,
};
