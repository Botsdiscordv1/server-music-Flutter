const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const metadataEnricher = require("./metadataEnricher");

const CANVAS_LIBRARY_ROOT = process.env.CANVAS_LIBRARY_DIR
  || process.env.CANVAS_LIBRARY_PATH
  || (process.platform === "win32"
    ? "E:\\Proyectos\\Videos-canvas"
    : path.resolve(process.cwd(), "canvas-library"));

const MANIFEST_NAME = "manifest.json";
const LIBRARY_DIR = "library";
const READY_DIR = "ready";
const PENDING_DIR = "pending";
const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v"]);
const STORAGE_BUCKETS = new Set(["youtube", "spotify", "isrc", "hash"]);

function ensureBaseDirs() {
  fs.mkdirSync(CANVAS_LIBRARY_ROOT, { recursive: true });
  fs.mkdirSync(path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR), { recursive: true });
  fs.mkdirSync(path.join(CANVAS_LIBRARY_ROOT, "cache"), { recursive: true });
  fs.mkdirSync(path.join(CANVAS_LIBRARY_ROOT, "logs"), { recursive: true });
  fs.mkdirSync(path.join(CANVAS_LIBRARY_ROOT, "temp"), { recursive: true });
}

function normalizeStorageStatus(value) {
  return String(value || READY_DIR).toLowerCase() === PENDING_DIR ? PENDING_DIR : READY_DIR;
}

function manifestPath() {
  ensureBaseDirs();
  return path.join(CANVAS_LIBRARY_ROOT, MANIFEST_NAME);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeSegment(value) {
  return normalizeText(value).replace(/\s+/g, "-") || "unknown";
}

function splitCanonicalId(canonicalId) {
  return String(canonicalId || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractYouTubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) return raw;

  try {
    const parsed = new URL(raw);
    const watchId = parsed.searchParams.get("v");
    if (watchId) return watchId.trim();

    const parts = parsed.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && ["youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(parsed.hostname)) {
      if (parts.includes("embed") || parts.includes("shorts") || parts.includes("v")) return last.trim();
      if (parsed.hostname === "youtu.be") return last.trim();
    }
  } catch {
    // Fall through to raw value.
  }

  return raw;
}

function normalizeMaybeYouTubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const extracted = extractYouTubeVideoId(raw);
  return extracted ? String(extracted).trim() : null;
}

function normalizeReleaseType(value) {
  const v = normalizeText(value);
  if (!v) return null;
  if (v.startsWith("ep")) return "EP";
  if (v.includes("album")) return "Album";
  return value ? String(value).trim() : null;
}

function isConfirmedReleaseType(value) {
  return value === "Album" || value === "EP";
}

function normalizeStorageReleaseType(value) {
  const normalized = normalizeReleaseType(value);
  if (isConfirmedReleaseType(normalized)) return normalized;
  return "Album";
}

function resolvePrimaryArtist(input = {}) {
  const explicitPrimary = String(input.primaryArtist || input.trackAuthor || "").trim();
  if (explicitPrimary) return explicitPrimary;

  const rawArtist = String(input.artist || "").trim();
  if (!rawArtist) return "";

  return rawArtist.split(/\s*(?:,|;|&|\+|\bx\b|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i)[0].trim();
}

function resolveFolderArtist(input = {}) {
  const explicitPrimary = String(input.primaryArtist || input.trackAuthor || "").trim();
  if (explicitPrimary) return explicitPrimary;
  return resolvePrimaryArtist(input);
}

function requireReleaseName(input = {}) {
  const releaseName = String(input.releaseName || input.album || "").trim();
  if (!releaseName) {
    throw new Error("releaseName required");
  }
  return releaseName;
}

function normalizeRemoteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^(thumb|canvas)\.(jpe?g|png|webp|gif|jpg)$/i.test(raw)) return null;
  if (/^[a-z]+:\/\//i.test(raw)) return raw;
  return null;
}

function buildStableReleaseId(input = {}) {
  const artist = normalizeText(resolveFolderArtist(input));
  const releaseName = normalizeText(input.releaseName || input.album || "");
  if (!artist || !releaseName) return null;
  const releaseKey = normalizeText(input.releaseKey || input.releaseId || input.albumBrowseId || input.albumId || input.albumUri || input.albumUrl || "");
  return `release-${sha1([artist, releaseName, releaseKey].join("|")).slice(0, 12)}`;
}

function buildStableTrackId(input = {}) {
  const artist = normalizeText(resolveFolderArtist(input));
  const releaseName = normalizeText(input.releaseName || input.album || "");
  const title = normalizeText(input.title || "");
  const durationMs = Number(input.durationMs || 0) || 0;
  if (!artist || !title) return null;
  return `track-${sha1([artist, releaseName, title, durationMs].join("|")).slice(0, 12)}`;
}

function moveDirectoryTree(sourceDir, targetDir) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (!source || !target || source === target || !fs.existsSync(source)) return false;

  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    fs.cpSync(source, target, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
    return true;
  }

  fs.renameSync(source, target);
  return true;
}

function cleanupEmptyParents(startDir, stopDir) {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);

  while (current && current !== stop && current.startsWith(stop)) {
    if (!fs.existsSync(current)) {
      current = path.dirname(current);
      continue;
    }

    if (fs.readdirSync(current).length > 0) break;
    try {
      fs.rmSync(current, { recursive: true, force: true });
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function folderHasVideo(folderPath) {
  if (!fs.existsSync(folderPath)) return false;
  return fs.readdirSync(folderPath, { withFileTypes: true }).some((entry) => entry.isFile() && isVideoFile(entry.name));
}

async function enrichCanvasMetadata(input = {}, options = {}) {
  const artist = resolvePrimaryArtist(input);
  const title = String(input.title || input.trackTitle || "").trim();
  const isrc = String(input.isrc || input.ids?.isrc || "").trim().toUpperCase() || null;

  let enriched = null;
  if (artist && title) {
    try {
      enriched = await metadataEnricher.enrichSingleTrack(artist, title, isrc, { forceRefresh: options.forceRefresh === true });
    } catch {
      enriched = null;
    }
  }

  const enrichedTitle = enriched?.trackTitle || title || input.trackTitle || input.title || "";
  const primaryArtist = String(input.primaryArtist || enriched?.trackAuthor || artist || input.trackAuthor || "").trim();
  const inputReleaseName = String(input.releaseName || input.album || "").trim();
  const enrichedReleaseName = String(enriched?.albumName || enriched?.album || "").trim();
  const titleLooksLikeRelease = !inputReleaseName || normalizeText(inputReleaseName) === normalizeText(enrichedTitle);
  const releaseKey = String(
    input.releaseId
      || input.albumBrowseId
      || input.albumId
      || input.albumUri
      || input.albumUrl
      || enriched?.albumBrowseId
      || enriched?.albumUrl
      || ""
  ).trim();
  const releaseName = requireReleaseName({
    releaseName: enrichedReleaseName && titleLooksLikeRelease ? enrichedReleaseName : (inputReleaseName || enrichedReleaseName),
  });
  const releaseType = normalizeStorageReleaseType(
    input.releaseType
      || input.albumType
      || enriched?.albumType
      || enriched?.releaseType
      || null
  );

  return {
    ...input,
    title: enrichedTitle,
    artist: primaryArtist,
    primaryArtist,
    album: input.album || releaseName,
    releaseName,
    releaseType,
    releaseId: releaseKey || input.releaseId || enriched?.albumBrowseId || enriched?.albumUrl || null,
    isrc,
    explicit: input.explicit ?? enriched?.explicit ?? false,
    genres: Array.isArray(input.genres) && input.genres.length ? input.genres : (enriched?.genres || []),
    featuredArtists: Array.isArray(input.featuredArtists) && input.featuredArtists.length ? input.featuredArtists : (enriched?.featuredArtists || []),
    artworkUrl: normalizeRemoteUrl(enriched?.albumArtworkUrl || input.artworkUrl || enriched?.artworkUrl),
    thumbnailUrl: normalizeRemoteUrl(enriched?.albumArtworkUrl || input.thumbnailUrl || enriched?.artworkUrl || input.thumbnail),
    durationMs: Number(input.durationMs || enriched?.duration || 0) || 0,
    ytVideoId: input.ytVideoId || enriched?.ytVideoId || null,
    albumBrowseId: enriched?.albumBrowseId || input.albumBrowseId || null,
    albumUrl: enriched?.albumUrl || input.albumUrl || null,
  };
}

function sha1(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function downloadRemoteFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  ensureBaseDirs();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

function isVideoFile(fileName) {
  return VIDEO_EXTENSIONS.has(path.extname(String(fileName || "")).toLowerCase());
}

function walkDirs(rootDir, visitor) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      visitor(fullPath);
      walkDirs(fullPath, visitor);
    }
  }
}

function fingerprintFromMeta(meta) {
  return sha1([
    normalizeText(meta.title),
    normalizeText(meta.artist),
    Number(meta.durationMs || 0),
    normalizeText(meta.album),
  ].join("|"));
}

function buildCanonicalId(ids = {}, meta = {}) {
  const isrc = String(ids.isrc || meta.isrc || "").trim().toUpperCase();
  const spotifyTrackId = String(ids.spotifyTrackId || ids.spotifyId || meta.spotifyTrackId || "").trim();
  const ytVideoId = normalizeMaybeYouTubeVideoId(ids.ytVideoId || ids.youtubeVideoId || meta.ytVideoId || meta.videoId || meta.trackId || "");
  const hash = String(ids.hash || meta.hash || "").trim();

  const artist = resolveFolderArtist(meta);
  const releaseName = String(meta.releaseName || meta.album || "").trim();
  const releaseType = normalizeReleaseType(meta.releaseType || meta.albumType || (releaseName ? "Album" : null));
  const bucket = String(meta.bucket || meta.sourceBucket || (meta.source === "spotify" ? "spotify" : "youtube")).trim() || "youtube";
  const isRelease = meta.level === "release";
  const itemId = String(
    (isRelease ? meta.releaseId : meta.trackId)
      || meta.releaseId
      || normalizeMaybeYouTubeVideoId(meta.trackId)
      || meta.trackId
      || ytVideoId
      || spotifyTrackId
      || isrc
      || hash
      || ""
  ).trim();

  if (artist && releaseName && releaseType && itemId) {
    return [bucket, safeSegment(artist), safeSegment(releaseType), safeSegment(releaseName), safeSegment(itemId)].join("/");
  }

  if (isrc) return `isrc/${isrc}`;
  if (spotifyTrackId) return `spotify/${spotifyTrackId}`;
  if (ytVideoId) return `youtube/${ytVideoId}`;
  if (hash) return `hash/${hash}`;
  return `hash/${fingerprintFromMeta(meta)}`;
}

function buildReleaseKey(input = {}, artist = null, releaseName = null) {
  const resolvedArtist = normalizeText(artist || resolveFolderArtist(input));
  const resolvedReleaseName = normalizeText(releaseName || input.releaseName || input.album || "");
  if (!resolvedArtist || !resolvedReleaseName) return null;

  const explicitKey = String(
    input.releaseId
      || input.albumBrowseId
      || input.albumId
      || input.albumUri
      || input.albumUrl
      || ""
  ).trim();

  if (explicitKey) return explicitKey;
  return buildStableReleaseId({ ...input, artist: resolvedArtist, releaseName: resolvedReleaseName });
}

function buildReleasePrefix(recordOrInput = {}) {
  const bucket = String(recordOrInput.bucket || recordOrInput.sourceBucket || (recordOrInput.source === "spotify" ? "spotify" : "youtube")).trim() || "youtube";
  const artist = resolveFolderArtist(recordOrInput);
  const releaseName = String(recordOrInput.releaseName || recordOrInput.album || "").trim();
  const releaseType = normalizeStorageReleaseType(recordOrInput.releaseType || recordOrInput.albumType || null);
  if (!artist || !releaseName) return null;
  return [bucket, safeSegment(artist), safeSegment(releaseType), safeSegment(releaseName)].join("/");
}

function buildDedupeKey(record = {}) {
  const bucket = String(record.bucket || "youtube").trim() || "youtube";
  const artist = normalizeText(record.primaryArtist || record.artist || "");
  const title = normalizeText(record.title || "");
  const ytVideoId = normalizeMaybeYouTubeVideoId(record.ids?.ytVideoId || record.ytVideoId || record.trackId || "");
  if (!bucket || !artist || !title) return null;
  if (ytVideoId) return [bucket, artist, title, ytVideoId].join("|");

  const releaseName = normalizeText(record.releaseName || record.album || "");
  const releaseId = String(record.releaseId || "").trim();
  const trackId = normalizeText(record.trackId || "");
  return [bucket, artist, title, releaseName, releaseId, trackId].join("|");
}

function pickPreferredRecord(a, b) {
  const score = (item) => {
    let value = 0;
    if (normalizeStorageStatus(item.status) === READY_DIR) value += 1000;
    if (normalizeMaybeYouTubeVideoId(item.ids?.ytVideoId || item.ytVideoId || item.trackId || "")) value += 100;
    if (item.trackId && !String(item.trackId).startsWith("http")) value += 20;
    if (item.releaseName) value += Math.min(String(item.releaseName).length, 40);
    if (item.createdAt) value -= Date.parse(item.createdAt) / 1e13;
    return value;
  };

  return score(b) > score(a) ? b : a;
}

function removeRecordFolder(record) {
  const dir = record.physicalPath || recordDir(record.canonicalId, record.status);
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
  cleanupEmptyParents(path.dirname(dir), path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR, String(record.bucket || "youtube")));
}

function replaceReleasePrefix(canonicalId, oldPrefix, newPrefix) {
  const normalizedCanonical = String(canonicalId || "").trim();
  const normalizedOld = String(oldPrefix || "").trim();
  if (!normalizedCanonical || !normalizedOld) return normalizedCanonical;
  if (normalizedCanonical === normalizedOld) return newPrefix;
  if (!normalizedCanonical.startsWith(`${normalizedOld}/`)) return normalizedCanonical;
  return `${newPrefix}${normalizedCanonical.slice(normalizedOld.length)}`;
}

function writeRecordMeta(record) {
  const metaPath = itemFilePath(record, record.status);
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  const payload = {
    canonicalId: record.canonicalId,
    parentCanonicalId: record.parentCanonicalId,
    ids: record.ids,
    title: record.title,
    artist: record.artist,
    primaryArtist: record.primaryArtist || record.artist,
    album: record.album,
    releaseName: record.releaseName,
    releaseType: record.releaseType,
    releaseId: record.releaseId,
    trackId: record.trackId,
    bucket: record.bucket,
    level: record.level,
    durationMs: record.durationMs,
    source: record.source,
    sourceUrl: record.sourceUrl,
    canvasUrl: record.canvasUrl,
    albumBrowseId: record.albumBrowseId,
    albumUrl: record.albumUrl,
    thumbnailUrl: record.thumbnailUrl,
    explicit: record.explicit,
    genres: record.genres,
    featuredArtists: record.featuredArtists,
    file: record.file,
    thumbnail: record.thumbnail,
    metaFile: record.metaFile,
    status: record.status,
    confidence: record.confidence,
    sha256: record.sha256,
    path: record.path,
    thumbnailPath: record.thumbnailPath,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
  return metaPath;
}

function recordDir(value, status = READY_DIR) {
  ensureBaseDirs();
  const input = typeof value === "object" && value !== null ? value : null;
  const canonicalId = input ? (input.canonicalId || buildCanonicalId(input.ids || {}, input)) : value;
  const parts = splitCanonicalId(canonicalId);
  let bucket = safeSegment(input?.bucket || parts[0] || "youtube");
  if (parts.length > 0) {
    const head = safeSegment(parts[0]);
    if (STORAGE_BUCKETS.has(head)) {
      bucket = head;
      parts.shift();
    } else if (input?.bucket && head === safeSegment(input.bucket)) {
      parts.shift();
    }
  }
  const folderStatus = normalizeStorageStatus(status || input?.status || READY_DIR);
  return path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR, bucket, folderStatus, ...parts.map(safeSegment));
}

function itemFilePath(value, status = READY_DIR) {
  return path.join(recordDir(value, status), "meta.json");
}

function defaultManifest() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    items: [],
  };
}

function readManifest() {
  ensureBaseDirs();
  const file = manifestPath();
  if (!fs.existsSync(file)) return defaultManifest();

  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const manifest = {
      version: parsed.version || 1,
      updatedAt: parsed.updatedAt || new Date().toISOString(),
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
    return manifest;
  } catch {
    return defaultManifest();
  }
}

function writeManifest(manifest) {
  ensureBaseDirs();
  fs.writeFileSync(manifestPath(), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    items: manifest.items || [],
  }, null, 2), "utf8");
}

function normalizeIds(input = {}) {
  const ids = {
    isrc: input.isrc ? String(input.isrc).trim().toUpperCase() : null,
    spotifyTrackId: input.spotifyTrackId ? String(input.spotifyTrackId).trim() : null,
    ytVideoId: normalizeMaybeYouTubeVideoId(input.ytVideoId),
    hash: input.hash ? String(input.hash).trim() : null,
  };
  return ids;
}

function toRecord(input = {}, assetNames = {}) {
  const ids = normalizeIds(input.ids || input);
  const artist = resolveFolderArtist(input);
  const releaseName = requireReleaseName(input);
  const status = normalizeStorageStatus(input.status);
  const releaseId = input.releaseId || buildReleaseKey(input, artist, releaseName) || buildStableReleaseId({ ...input, artist, releaseName });
  const releaseType = normalizeStorageReleaseType(input.releaseType || input.albumType || null);
  const shouldAutoTrackId = input.level !== "release" && input.assetLevel !== "release";
  const trackId = normalizeMaybeYouTubeVideoId(input.trackId) || (shouldAutoTrackId ? buildStableTrackId({ ...input, artist, releaseName, durationMs: input.durationMs }) : null);
  const canonicalId = buildCanonicalId(ids, { ...input, artist, releaseName, releaseType, releaseId, trackId });
  const dir = recordDir(canonicalId, status);
  const parentCanonicalId = path.dirname(canonicalId).replace(/\\/g, "/");
  const level = input.level || input.assetLevel || (releaseId && trackId ? "track" : (releaseId ? "release" : (releaseName ? "track" : null)));
  const record = {
    canonicalId,
    parentCanonicalId: parentCanonicalId && parentCanonicalId !== "." ? parentCanonicalId : null,
    ids,
    title: input.title || "",
    artist,
    primaryArtist: String(input.primaryArtist || artist).trim(),
    album: releaseName,
    releaseName,
    releaseType,
    releaseId,
    trackId,
    bucket: input.bucket || input.sourceBucket || (input.source === "spotify" ? "spotify" : "youtube"),
    level,
    durationMs: Number(input.durationMs || 0) || 0,
    source: input.source || null,
    sourceUrl: input.sourceUrl || null,
    canvasUrl: input.canvasUrl || null,
    albumBrowseId: input.albumBrowseId || null,
    albumUrl: input.albumUrl || null,
    thumbnailUrl: normalizeRemoteUrl(input.thumbnailUrl || input.thumbnail),
    explicit: input.explicit === true,
    genres: Array.isArray(input.genres) ? input.genres : [],
    featuredArtists: Array.isArray(input.featuredArtists) ? input.featuredArtists : [],
    file: input.file || assetNames.canvas || "canvas.mp4",
    thumbnail: input.thumbnail || assetNames.thumbnail || "thumb.jpg",
    metaFile: input.metaFile || "meta.json",
    status,
    confidence: input.confidence != null ? Number(input.confidence) : null,
    sha256: input.sha256 || null,
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    path: path.relative(CANVAS_LIBRARY_ROOT, path.join(dir, input.file || assetNames.canvas || "canvas.mp4")).replace(/\\/g, "/"),
  };

  record.metaPath = path.relative(CANVAS_LIBRARY_ROOT, itemFilePath(canonicalId, status)).replace(/\\/g, "/");
  record.thumbnailPath = path.relative(CANVAS_LIBRARY_ROOT, path.join(dir, record.thumbnail)).replace(/\\/g, "/");
  record.assetPaths = {
    canvas: path.join(dir, record.file),
    thumbnail: path.join(dir, record.thumbnail),
    meta: itemFilePath(canonicalId, status),
  };

  return record;
}

function ensurePhysicalFolder(input = {}) {
  const record = toRecord(input);
  fs.mkdirSync(path.dirname(record.assetPaths.meta), { recursive: true });
  return { canonicalId: record.canonicalId, dir: path.dirname(record.assetPaths.meta), ids: record.ids };
}

function buildReleaseIdentity(input = {}) {
  const artist = resolveFolderArtist(input);
  const releaseName = String(input.releaseName || input.album || "").trim();
  const releaseType = normalizeStorageReleaseType(input.releaseType || input.albumType || null);
  const releaseId = String(input.releaseId || input.albumId || input.albumBrowseId || input.albumUri || input.albumUrl || buildStableReleaseId({ artist, releaseName }) || "").trim();

  if (!artist || !releaseName) return null;
  return {
    artist,
    releaseName,
    releaseType,
    releaseId,
    bucket: input.bucket || input.sourceBucket || (input.source === "spotify" ? "spotify" : "youtube"),
  };
}

function getReleaseGroupKeys(record = {}) {
  const bucket = String(record.bucket || "youtube").trim();
  const artist = normalizeText(resolvePrimaryArtist(record));
  const releaseName = normalizeText(record.releaseName || record.album || "");
  const releaseId = String(record.releaseId || "").trim();
  const keys = [];

  if (bucket && artist && releaseId) {
    keys.push([bucket, artist, releaseId].join("|"));
  }

  if (bucket && artist && releaseName) {
    keys.push([bucket, artist, releaseName].join("|"));
  }

  return keys;
}

function resolveReleaseTypeForGroup(candidateType, groupItems = [], totalItems = 1) {
  const normalizedCandidate = normalizeReleaseType(candidateType);
  const groupTypes = groupItems.map((item) => normalizeReleaseType(item.releaseType || item.albumType || null)).filter(Boolean);

  if (groupTypes.includes("Album")) return "Album";
  if (groupTypes.includes("EP")) return "EP";
  if (normalizedCandidate === "Album" || normalizedCandidate === "EP") return normalizedCandidate;

  if (totalItems > 1) {
    if (groupItems.some((item) => normalizeReleaseType(item.releaseType || item.albumType || null) === "EP" || normalizeText(item.albumType || item.releaseType || "").includes("ep"))) {
      return "EP";
    }
    return "Album";
  }

  return "Album";
}

function rehomeReleaseGroup(manifest, oldPrefix, newPrefix) {
  if (!oldPrefix || !newPrefix || oldPrefix === newPrefix) return;

  const affected = manifest.items.filter((item) => String(item.canonicalId || "").startsWith(`${oldPrefix}/`));
  if (affected.length === 0) return;

  for (const item of affected) {
    const updatedCanonicalId = replaceReleasePrefix(item.canonicalId, oldPrefix, newPrefix);
    const sourceDir = recordDir(item.canonicalId, item.status);
    const targetDir = recordDir(updatedCanonicalId, item.status);
    moveDirectoryTree(sourceDir, targetDir);
    item.canonicalId = updatedCanonicalId;
    item.parentCanonicalId = item.parentCanonicalId ? replaceReleasePrefix(item.parentCanonicalId, oldPrefix, newPrefix) : null;
    item.metaPath = path.relative(CANVAS_LIBRARY_ROOT, itemFilePath(updatedCanonicalId, item.status)).replace(/\\/g, "/");
    item.path = path.relative(CANVAS_LIBRARY_ROOT, path.join(recordDir(updatedCanonicalId, item.status), item.file || "canvas.mp4")).replace(/\\/g, "/");
    item.thumbnailPath = path.relative(CANVAS_LIBRARY_ROOT, path.join(recordDir(updatedCanonicalId, item.status), item.thumbnail || "thumb.jpg")).replace(/\\/g, "/");
    item.assetPaths = {
      canvas: path.join(recordDir(updatedCanonicalId, item.status), item.file || "canvas.mp4"),
      thumbnail: path.join(recordDir(updatedCanonicalId, item.status), item.thumbnail || "thumb.jpg"),
      meta: itemFilePath(updatedCanonicalId, item.status),
    };
    writeRecordMeta(item);
  }
}

function ensureReleasePlaceholder(input = {}) {
  const identity = buildReleaseIdentity(input);
  if (!identity) return null;

  const releaseRecord = upsertRecord({
    ...input,
    ...identity,
    title: input.releaseName || input.album || input.title || identity.releaseName,
    artist: identity.artist,
    album: identity.releaseName,
    releaseName: identity.releaseName,
    releaseType: identity.releaseType,
    releaseId: identity.releaseId,
    trackId: null,
    level: "release",
    status: input.status || "pending",
    file: input.releaseFile || input.file || "canvas.mp4",
    thumbnail: input.releaseThumbnail || input.thumbnail || "thumb.jpg",
  });

  ensurePhysicalFolder({
    ...input,
    ...identity,
    level: "release",
    releaseId: identity.releaseId,
    file: input.releaseFile || input.file || "canvas.mp4",
  });

  return releaseRecord;
}

function attachUrls(record, baseUrl) {
  const origin = String(baseUrl || "").replace(/\/$/, "");
  return {
    ...record,
    urls: {
      self: `${origin}/api/canvas/${encodeURIComponent(record.canonicalId)}`,
      manifest: `${origin}/api/canvas/manifest`,
      canvas: `${origin}/api/canvas/${encodeURIComponent(record.canonicalId)}/file/canvas`,
      thumbnail: `${origin}/api/canvas/${encodeURIComponent(record.canonicalId)}/file/thumbnail`,
      meta: `${origin}/api/canvas/${encodeURIComponent(record.canonicalId)}/file/meta`,
    },
  };
}

function listRecords(status = null) {
  const manifest = readManifest();
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (!status) return items.map((item) => item);
  const normalized = normalizeStorageStatus(status);
  return items.filter((item) => normalizeStorageStatus(item.status) === normalized).map((item) => item);
}

function findRecordByCanonicalId(canonicalId) {
  const normalized = String(canonicalId || "").trim();
  if (!normalized) return null;
  return listRecords(READY_DIR).find((item) => item.canonicalId === normalized) || null;
}

function resolveRecord(query = {}) {
  syncFilesystemCatalog();
  const ids = normalizeIds(query.ids || query);
  const canonicalId = buildCanonicalId(ids, query);

  const all = listRecords(READY_DIR);
  let found = all.find((item) => item.canonicalId === canonicalId) || null;

  if (!found && ids.isrc) {
    found = all.find((item) => item.ids?.isrc === ids.isrc) || null;
  }
  if (!found && ids.spotifyTrackId) {
    found = all.find((item) => item.ids?.spotifyTrackId === ids.spotifyTrackId) || null;
  }
  if (!found && ids.ytVideoId) {
    found = all.find((item) => item.ids?.ytVideoId === ids.ytVideoId) || null;
  }

  if (!found && query.title && query.artist) {
    const title = normalizeText(query.title);
    const artist = normalizeText(query.artist);
    found = all.find((item) => {
      const itemTitle = normalizeText(item.title);
      const itemArtist = normalizeText(item.artist);
      if (!itemTitle || !itemArtist) return false;
      return itemTitle === title && itemArtist === artist;
    }) || null;
  }

  if (!found && query.artist) {
    const artist = normalizeText(query.artist);
    for (const candidate of all) {
      if (candidate.level !== "release") continue;
      if (normalizeText(candidate.artist) !== artist) continue;
      const fn = candidate.file || "canvas.mp4";
      if (fs.existsSync(path.join(recordDir(candidate.canonicalId, candidate.status), fn))) {
        found = candidate;
        break;
      }
      if (candidate.parentCanonicalId) {
        const parentDir = recordDir(candidate.parentCanonicalId, candidate.status);
        const parentFile = path.join(parentDir, fn);
        if (fs.existsSync(parentFile)) {
          found = candidate;
          break;
        }
      }
    }
  }

  if (found && found.level !== "release") {
    const directCanvas = path.join(recordDir(found.canonicalId, found.status), found.file || "canvas.mp4");
    if (!fs.existsSync(directCanvas) && found.parentCanonicalId) {
      const fn = found.file || "canvas.mp4";
      const fallback = listRecords(READY_DIR).find((candidate) =>
        candidate.parentCanonicalId === found.parentCanonicalId
        && candidate.level === "release"
        && (
          fs.existsSync(path.join(recordDir(candidate.canonicalId, candidate.status), fn))
          || (candidate.parentCanonicalId && fs.existsSync(path.join(recordDir(candidate.parentCanonicalId, candidate.status), fn)))
        )
      );

      if (fallback) found = fallback;
    }
  }

  return found;
}

function upsertRecord(input = {}) {
  const manifest = readManifest();
  const draft = toRecord(input);
  const groupKeys = new Set(getReleaseGroupKeys(draft));
  const groupItems = manifest.items.filter((item) => getReleaseGroupKeys(item).some((key) => groupKeys.has(key)));
  const isUpdatingExistingCanonical = groupItems.some((item) => item.canonicalId === draft.canonicalId);
  const totalItems = isUpdatingExistingCanonical ? groupItems.length : groupItems.length + 1;
  const finalReleaseType = resolveReleaseTypeForGroup(draft.releaseType, groupItems, totalItems);
  const finalRecord = finalReleaseType === draft.releaseType
    ? draft
    : toRecord({
        ...input,
        releaseType: finalReleaseType,
        releaseId: draft.releaseId,
        albumBrowseId: input.albumBrowseId || draft.releaseId,
        albumUrl: input.albumUrl || null,
      });

  const finalPrefix = buildReleasePrefix(finalRecord);
  const existingPrefixes = [...new Set(groupItems.map((item) => buildReleasePrefix(item)).filter(Boolean))];
  for (const oldPrefix of existingPrefixes) {
    if (oldPrefix !== finalPrefix) {
      rehomeReleaseGroup(manifest, oldPrefix, finalPrefix);
    }
  }

  fs.mkdirSync(path.dirname(finalRecord.assetPaths.meta), { recursive: true });
  const existing = manifest.items.find((item) => item.canonicalId === finalRecord.canonicalId);
  const createdAt = existing?.createdAt || finalRecord.createdAt;

  const next = {
    ...existing,
    ...finalRecord,
    createdAt,
    updatedAt: new Date().toISOString(),
  };

  const metaPath = writeRecordMeta(next);

  const nextItem = {
    ...next,
    metaPath: path.relative(CANVAS_LIBRARY_ROOT, metaPath).replace(/\\/g, "/"),
  };

  const filtered = manifest.items.filter((item) => item.canonicalId !== nextItem.canonicalId);
  filtered.push(nextItem);
  filtered.sort((a, b) => String(a.canonicalId).localeCompare(String(b.canonicalId)));

  writeManifest({ items: filtered });
  return nextItem;
}

function createPendingRecord(input = {}) {
  requireReleaseName(input);
  ensureReleasePlaceholder(input);
  ensurePhysicalFolder({ ...input, status: input.status || "pending" });
  return upsertRecord({
    ...input,
    status: input.status || "pending",
    file: input.file || "canvas.mp4",
    thumbnail: input.thumbnail || "thumb.jpg",
  });
}

async function ensureFolderRecord(input = {}) {
  requireReleaseName(input);
  const enriched = await enrichCanvasMetadata(input, { forceRefresh: input.refresh === true });
  const existing = resolveRecord(enriched);
  if (existing) return existing;
  ensurePhysicalFolder({ ...enriched, status: enriched.status || "pending" });
  return createPendingRecord({ ...enriched, status: enriched.status || "pending" });
}

async function requestRecord(input = {}) {
  requireReleaseName(input);
  const baseInput = {
    ...input,
    file: input.file || "canvas.mp4",
    thumbnail: input.thumbnail || "thumb.jpg",
  };

  const enrichedBaseInput = await enrichCanvasMetadata(baseInput, { forceRefresh: input.refresh === true });
  ensureReleasePlaceholder(enrichedBaseInput);
  let record = createPendingRecord(enrichedBaseInput);

  if (record.canvasUrl) {
    await downloadRemoteFile(record.canvasUrl, record.assetPaths.canvas);
  }

  if (record.thumbnailUrl) {
    try {
      await downloadRemoteFile(record.thumbnailUrl, record.assetPaths.thumbnail);
    } catch {
      // Thumbnail is optional.
    }
  }

  const pendingDir = recordDir(record, PENDING_DIR);
  const readyDir = recordDir(record, READY_DIR);
  moveDirectoryTree(pendingDir, readyDir);

  const readyCanvasPath = path.join(readyDir, record.file || "canvas.mp4");
  const sha256 = fs.existsSync(readyCanvasPath) ? await sha256File(readyCanvasPath) : record.sha256 || null;
  record = upsertRecord({
    ...record,
    status: READY_DIR,
    sha256,
  });

  return record;
}

function inferIdsFromFolder(folderName, bucket) {
  const id = String(folderName || "").trim();
  if (!id) return {};

  if (bucket === "youtube") return { ytVideoId: normalizeMaybeYouTubeVideoId(id) };
  if (bucket === "spotify") return { spotifyTrackId: id };
  if (bucket === "isrc") return { isrc: id.toUpperCase() };
  return { hash: id };
}

function inferLevelFromLeaf(leafName) {
  const value = String(leafName || "").toLowerCase();
  if (value.endsWith(".album") || value.endsWith(".ep")) return "release";
  return "track";
}

function syncRecordFromFolder(folderPath, bucket, status = READY_DIR) {
  if (!fs.existsSync(folderPath)) return null;
  const rootDir = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR, bucket, normalizeStorageStatus(status));
  const rel = path.relative(rootDir, folderPath);
  if (!rel || rel.startsWith("..")) return null;

  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length < 1) return null;

  const folderName = parts[parts.length - 1];
  const level = inferLevelFromLeaf(folderName);
  let canonicalId;
  let parentCanonicalId = null;
  let pathArtist = "";
  let pathReleaseType = null;
  let pathReleaseName = null;
  let pathLevel = null;

  const metaFilePath = path.join(folderPath, "meta.json");
  let existingMeta = {};
  if (fs.existsSync(metaFilePath)) {
    try {
      existingMeta = JSON.parse(fs.readFileSync(metaFilePath, "utf8"));
    } catch {
      existingMeta = {};
    }
  }

  pathArtist = existingMeta.artist || "";
  pathReleaseType = existingMeta.releaseType || null;
  pathReleaseName = existingMeta.releaseName || existingMeta.album || null;

  if (parts.length >= 4) {
    const [artist, releaseType, releaseName, leafId] = parts.slice(-4);
    const normalizedReleaseType = normalizeReleaseType(releaseType) || releaseType;
    pathArtist = pathArtist || artist;
    pathReleaseType = pathReleaseType || normalizedReleaseType;
    pathReleaseName = pathReleaseName || releaseName;
    parentCanonicalId = [bucket, safeSegment(pathArtist), safeSegment(normalizedReleaseType), safeSegment(releaseName)].join("/");
    canonicalId = [bucket, safeSegment(pathArtist), safeSegment(normalizedReleaseType), safeSegment(releaseName), safeSegment(leafId)].join("/");
    pathLevel = "track";
  } else if (parts.length === 3) {
    const [artist, releaseType, releaseName] = parts;
    const normalizedReleaseType = normalizeReleaseType(releaseType) || releaseType;
    pathArtist = pathArtist || artist;
    pathReleaseType = pathReleaseType || normalizedReleaseType;
    pathReleaseName = pathReleaseName || releaseName;
    parentCanonicalId = null;
    canonicalId = [bucket, safeSegment(pathArtist), safeSegment(normalizedReleaseType), safeSegment(releaseName)].join("/");
    pathLevel = "release";
  } else {
    canonicalId = `${bucket}/${folderName}`;
  }

  let files;
  try {
    files = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return null;
  }
  const hasSubdirs = files.some((entry) => entry.isDirectory());
  if (hasSubdirs && parts.length !== 3) return null;

  const videoFile = files.find((entry) => entry.isFile() && isVideoFile(entry.name))?.name || null;
  const hasMeta = existingMeta && Object.keys(existingMeta).length > 0;
  if (!videoFile) {
    if (normalizeStorageStatus(status) !== PENDING_DIR) return null;
    if (!hasMeta) return null;
  }

  pathReleaseName = pathReleaseName || folderName;

  const thumbnailFile = files.find((entry) => entry.isFile() && ["thumb.jpg", "thumb.jpeg", "thumb.png"].includes(entry.name.toLowerCase()))?.name || null;

  const ids = {
    ...inferIdsFromFolder(folderName, bucket),
    ...(existingMeta.ids || {}),
  };

  const record = upsertRecord({
    ...existingMeta,
    canonicalId,
    parentCanonicalId: parentCanonicalId || existingMeta.parentCanonicalId || null,
    ids,
    title: existingMeta.title || folderName,
    artist: existingMeta.artist || pathArtist || "",
    primaryArtist: existingMeta.primaryArtist || existingMeta.artist || pathArtist || "",
    album: existingMeta.album || null,
    releaseName: existingMeta.releaseName || existingMeta.album || pathReleaseName || null,
    releaseType: normalizeStorageReleaseType(existingMeta.releaseType || pathReleaseType),
    level: existingMeta.level || pathLevel || level,
    durationMs: existingMeta.durationMs || 0,
    source: existingMeta.source || "filesystem",
    albumBrowseId: existingMeta.albumBrowseId || null,
    albumUrl: existingMeta.albumUrl || null,
    file: videoFile || existingMeta.file || "canvas.mp4",
    thumbnail: thumbnailFile || existingMeta.thumbnail || "thumb.jpg",
    status: videoFile ? READY_DIR : PENDING_DIR,
  });

  if (pathLevel === "release") {
    const targetDir = path.dirname(path.join(CANVAS_LIBRARY_ROOT, record.metaPath));
    if (targetDir !== folderPath && videoFile) {
      fs.mkdirSync(targetDir, { recursive: true });
      const sourceVid = path.join(folderPath, videoFile);
      const targetVid = path.join(targetDir, videoFile);
      if (fs.existsSync(sourceVid) && !fs.existsSync(targetVid)) {
        fs.renameSync(sourceVid, targetVid);
      }
      if (thumbnailFile) {
        const sourceThumb = path.join(folderPath, thumbnailFile);
        const targetThumb = path.join(targetDir, thumbnailFile);
        if (fs.existsSync(sourceThumb) && !fs.existsSync(targetThumb)) {
          fs.renameSync(sourceThumb, targetThumb);
        }
      }
      const sourceMeta = path.join(folderPath, "meta.json");
      const targetMeta = path.join(targetDir, "meta.json");
      if (fs.existsSync(sourceMeta) && !fs.existsSync(targetMeta)) {
        fs.renameSync(sourceMeta, targetMeta);
      }
      record.physicalPath = targetDir;
    } else {
      record.physicalPath = folderPath;
    }
  } else {
    record.physicalPath = folderPath;
  }
  return record;
}

function promotePendingFoldersToReady() {
  ensureBaseDirs();
  const libraryRoot = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR);
  if (!fs.existsSync(libraryRoot)) return 0;

  const promoted = [];

  for (const bucketEntry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;

    const bucket = bucketEntry.name;
    const pendingRoot = path.join(libraryRoot, bucket, PENDING_DIR);
    const readyRoot = path.join(libraryRoot, bucket, READY_DIR);
    if (!fs.existsSync(pendingRoot)) continue;

    const candidates = [];
    walkDirs(pendingRoot, (folderPath) => {
      if (folderHasVideo(folderPath)) candidates.push(folderPath);
    });

    candidates.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

    for (const sourceDir of candidates) {
      const rel = path.relative(pendingRoot, sourceDir);
      if (!rel || rel.startsWith("..")) continue;

      const targetDir = path.join(readyRoot, rel);
      if (moveDirectoryTree(sourceDir, targetDir)) {
        promoted.push(targetDir);
        cleanupEmptyParents(path.dirname(sourceDir), pendingRoot);
      }
    }
  }

  return promoted.length;
}

function organizeLeafFolders() {
  ensureBaseDirs();
  const libraryRoot = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR);
  if (!fs.existsSync(libraryRoot)) return 0;

  const moved = [];

  for (const bucketEntry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;

    const bucket = bucketEntry.name;
    const bucketRoot = path.join(libraryRoot, bucket);
    if (!fs.existsSync(bucketRoot)) continue;

    const candidates = [];
    walkDirs(bucketRoot, (folderPath) => {
      try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        if (!entries.some((entry) => entry.isDirectory())) {
          candidates.push(folderPath);
        }
      } catch {
        // Skip folders that disappear mid-scan.
      }
    });

    candidates.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

    for (const sourceDir of candidates) {
      const relParts = path.relative(bucketRoot, sourceDir).split(path.sep).filter(Boolean);
      if (relParts.length === 0) continue;

      while (relParts[0] === READY_DIR || relParts[0] === PENDING_DIR || relParts[0] === bucket) {
        relParts.shift();
      }

      if (relParts.length === 0) continue;

      const status = folderHasVideo(sourceDir) ? READY_DIR : PENDING_DIR;
      const targetDir = path.join(bucketRoot, status, ...relParts);
      if (moveDirectoryTree(sourceDir, targetDir)) {
        moved.push(targetDir);
        cleanupEmptyParents(path.dirname(sourceDir), bucketRoot);
      }
    }
  }

  return moved.length;
}

function flattenRedundantNamespaceFolders() {
  ensureBaseDirs();
  const libraryRoot = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR);
  if (!fs.existsSync(libraryRoot)) return 0;

  let moved = 0;

  for (const bucketEntry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;

    const bucket = bucketEntry.name;
    const bucketRoot = path.join(libraryRoot, bucket);
    for (const status of [PENDING_DIR, READY_DIR]) {
      const statusRoot = path.join(bucketRoot, status);
      if (!fs.existsSync(statusRoot)) continue;

      const namespaceDir = path.join(statusRoot, bucket);
      while (fs.existsSync(namespaceDir) && fs.statSync(namespaceDir).isDirectory()) {
        for (const entry of fs.readdirSync(namespaceDir, { withFileTypes: true })) {
          const from = path.join(namespaceDir, entry.name);
          const to = path.join(statusRoot, entry.name);

          if (fs.existsSync(to)) {
            if (entry.isDirectory()) {
              moveDirectoryTree(from, to);
            } else {
              fs.rmSync(to, { force: true });
              fs.renameSync(from, to);
            }
          } else {
            fs.renameSync(from, to);
          }
          moved += 1;
        }

        try {
          fs.rmSync(namespaceDir, { recursive: true, force: true });
        } catch {
          break;
        }
      }
    }
  }

  return moved;
}

function promoteLegacyFoldersToReady() {
  ensureBaseDirs();
  const libraryRoot = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR);
  if (!fs.existsSync(libraryRoot)) return 0;

  const promoted = [];

  for (const bucketEntry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;

    const bucket = bucketEntry.name;
    const bucketRoot = path.join(libraryRoot, bucket);
    const readyRoot = path.join(bucketRoot, READY_DIR);
    if (!fs.existsSync(bucketRoot)) continue;

    const candidates = [];
    walkDirs(bucketRoot, (folderPath) => {
      const rel = path.relative(bucketRoot, folderPath);
      if (!rel || rel.startsWith("..")) return;
      const topLevel = rel.split(path.sep)[0];
      if (topLevel === READY_DIR || topLevel === PENDING_DIR) return;
      if (folderHasVideo(folderPath)) candidates.push(folderPath);
    });

    candidates.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

    for (const sourceDir of candidates) {
      const rel = path.relative(bucketRoot, sourceDir);
      if (!rel || rel.startsWith("..")) continue;

      const targetDir = path.join(readyRoot, rel);
      if (moveDirectoryTree(sourceDir, targetDir)) {
        promoted.push(targetDir);
        cleanupEmptyParents(path.dirname(sourceDir), bucketRoot);
      }
    }
  }

  return promoted.length;
}

function syncFilesystemCatalog() {
  ensureBaseDirs();
  const libraryRoot = path.join(CANVAS_LIBRARY_ROOT, LIBRARY_DIR);
  const manifest = readManifest();
  const synced = [];

  flattenRedundantNamespaceFolders();
  organizeLeafFolders();

  const promotedCount = promotePendingFoldersToReady();
  if (promotedCount > 0) {
    console.log(`[CanvasCatalog] Promoted ${promotedCount} pending folder(s) to ready`);
  }

  for (const bucketEntry of fs.readdirSync(libraryRoot, { withFileTypes: true })) {
    if (!bucketEntry.isDirectory()) continue;

    const bucket = bucketEntry.name;
    const readyRoot = path.join(libraryRoot, bucket, READY_DIR);
    const pendingRoot = path.join(libraryRoot, bucket, PENDING_DIR);

    if (fs.existsSync(readyRoot)) {
      walkDirs(readyRoot, (folderPath) => {
        const record = syncRecordFromFolder(folderPath, bucket, READY_DIR);
        if (record) synced.push(record);
      });
    }

    if (fs.existsSync(pendingRoot)) {
      walkDirs(pendingRoot, (folderPath) => {
        const record = syncRecordFromFolder(folderPath, bucket, PENDING_DIR);
        if (record) synced.push(record);
      });
    }
  }

  const deduped = [];
  const seen = new Map();
  for (const record of synced) {
    const key = buildDedupeKey(record) || record.canonicalId;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, record);
      deduped.push(record);
      continue;
    }

    const preferred = pickPreferredRecord(existing, record);
    const removed = preferred === existing ? record : existing;
    seen.set(key, preferred);
    const index = deduped.findIndex((item) => item.canonicalId === removed.canonicalId);
    if (index >= 0) deduped[index] = preferred;
    removeRecordFolder(removed);
  }

  const readyKeys = new Set(
    deduped
      .filter((item) => normalizeStorageStatus(item.status) === READY_DIR)
      .map((item) => buildDedupeKey(item))
      .filter(Boolean)
  );

  const cleaned = [];
  for (const record of deduped) {
    const key = buildDedupeKey(record);
    if (normalizeStorageStatus(record.status) === PENDING_DIR && key && readyKeys.has(key)) {
      removeRecordFolder(record);
      continue;
    }
    cleaned.push(record);
  }

  const syncedIds = new Set(cleaned.map((item) => item.canonicalId));
  for (const item of manifest.items || []) {
    if (!syncedIds.has(item.canonicalId)) {
      removeRecord(item.canonicalId);
    }
  }

  return cleaned;
}

async function regenerateCatalogMetadata() {
  const synced = syncFilesystemCatalog();
  const refreshed = [];

  for (const item of synced) {
    const enriched = await enrichCanvasMetadata(item, { forceRefresh: true });
    refreshed.push(upsertRecord({ ...item, ...enriched }));
  }

  return refreshed;
}

async function regenerateRecordByCanonicalId(canonicalId) {
  const current = findRecordByCanonicalId(canonicalId);
  if (!current) return null;

  const enriched = await enrichCanvasMetadata(current, { forceRefresh: true });
  return upsertRecord({
    ...current,
    ...enriched,
    canonicalId: current.canonicalId,
    parentCanonicalId: current.parentCanonicalId,
    releaseId: current.releaseId,
    trackId: current.trackId,
    level: current.level,
    status: current.status || "ready",
  });
}

function removeRecord(canonicalId) {
  const manifest = readManifest();
  const filtered = manifest.items.filter((item) => item.canonicalId !== canonicalId);
  writeManifest({ items: filtered });
}

function readRecordMeta(canonicalId) {
  const item = findRecordByCanonicalId(canonicalId);
  if (!item) return null;

  const metaFile = path.join(CANVAS_LIBRARY_ROOT, item.metaPath || path.relative(CANVAS_LIBRARY_ROOT, itemFilePath(item.canonicalId, item.status)).replace(/\\/g, "/"));
  if (!fs.existsSync(metaFile)) return item;

  try {
    return JSON.parse(fs.readFileSync(metaFile, "utf8"));
  } catch {
    return item;
  }
}

function resolveAssetPath(canonicalId, asset = "canvas") {
  const item = findRecordByCanonicalId(canonicalId);
  if (!item) return null;

  const dir = recordDir(item.canonicalId, item.status);
  switch (asset) {
    case "canvas":
      {
        if (item.parentCanonicalId) {
          const fn = item.file || "canvas.mp4";
          const releaseCanvas = listRecords(READY_DIR).find((candidate) =>
            candidate.parentCanonicalId === item.parentCanonicalId
            && candidate.level === "release"
            && (
              fs.existsSync(path.join(recordDir(candidate.canonicalId, candidate.status), fn))
              || (candidate.parentCanonicalId && fs.existsSync(path.join(recordDir(candidate.parentCanonicalId, candidate.status), fn)))
            )
          );

          if (releaseCanvas) {
            const rDir = recordDir(releaseCanvas.canonicalId, releaseCanvas.status);
            const rFile = path.join(rDir, fn);
            if (fs.existsSync(rFile)) return rFile;
            if (releaseCanvas.parentCanonicalId) {
              const pDir = recordDir(releaseCanvas.parentCanonicalId, releaseCanvas.status);
              const pFile = path.join(pDir, fn);
              if (fs.existsSync(pFile)) return pFile;
            }
            return rFile;
          }
        }

        const direct = path.join(dir, item.file || "canvas.mp4");
        if (fs.existsSync(direct)) return direct;

        return direct;
      }
    case "thumbnail":
    case "thumb":
      return path.join(dir, item.thumbnail || "thumb.jpg");
    case "meta":
      return itemFilePath(item.canonicalId, item.status);
    default:
      return null;
  }
}

function getCatalogSummary(baseUrl) {
  syncFilesystemCatalog();
  const manifest = readManifest();
  const readyItems = (manifest.items || []).filter((item) => normalizeStorageStatus(item.status) === READY_DIR);
  return {
    version: manifest.version || 1,
    updatedAt: manifest.updatedAt || new Date().toISOString(),
    count: readyItems.length,
    items: readyItems.map((item) => attachUrls(item, baseUrl)),
  };
}

module.exports = {
  CANVAS_LIBRARY_ROOT,
  ensureBaseDirs,
  readManifest,
  writeManifest,
  listRecords,
  findRecordByCanonicalId,
  resolveRecord,
  upsertRecord,
  createPendingRecord,
  ensureFolderRecord,
  ensureReleasePlaceholder,
  enrichCanvasMetadata,
  requestRecord,
  syncFilesystemCatalog,
  organizeLeafFolders,
  regenerateCatalogMetadata,
  regenerateRecordByCanonicalId,
  removeRecord,
  readRecordMeta,
  resolveAssetPath,
  getCatalogSummary,
  attachUrls,
  buildCanonicalId,
  normalizeText,
  fingerprintFromMeta,
  recordDir,
  itemFilePath,
};
