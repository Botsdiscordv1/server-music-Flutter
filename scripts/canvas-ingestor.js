#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

function parseArgs(argv) {
  const args = {
    input: null,
    root: null,
    overwrite: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--overwrite") {
      args.overwrite = true;
      continue;
    }
    if (current === "--input" || current === "-i") {
      args.input = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (current === "--root" || current === "-r") {
      args.root = argv[i + 1] || null;
      i += 1;
      continue;
    }
  }

  return args;
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/canvas-ingestor.js --input tracks.json [--root E:\\Proyectos\\Videos-canvas] [--overwrite]",
    "",
    "Input format:",
    "  { \"items\": [ { ...track... } ] } or [ { ...track... } ]",
    "",
    "Supported fields:",
    "  ids.isrc, ids.spotifyTrackId, ids.ytVideoId, ids.hash",
    "  title, artist, album, durationMs, source, sourceUrl",
    "  canvasUrl, canvasPath, thumbnailUrl, thumbnailPath",
    "  file, thumbnail, status, confidence",
  ].join("\n");
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.items)) return parsed.items;
  throw new Error("Input JSON must be an array or an object with an items array");
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  ensureParentDir(destination);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

function copyFile(source, destination) {
  ensureParentDir(destination);
  if (path.resolve(source) !== path.resolve(destination)) {
    fs.copyFileSync(source, destination);
  }
}

function pickSource(item, kind) {
  if (kind === "canvas") {
    return item.canvasPath || item.videoPath || item.filePath || item.localCanvas || null;
  }
  if (kind === "thumbnail") {
    return item.thumbnailPath || item.thumbPath || item.localThumbnail || null;
  }
  return null;
}

async function writeAsset(item, destination, kind, overwrite) {
  const existing = fs.existsSync(destination);
  if (existing && !overwrite) return;

  const localSource = pickSource(item, kind);
  if (localSource) {
    copyFile(localSource, destination);
    return;
  }

  const remoteSource = kind === "canvas" ? item.canvasUrl : item.thumbnailUrl;
  if (remoteSource) {
    await downloadFile(remoteSource, destination);
    return;
  }

  if (kind === "thumbnail") {
    return;
  }

  if (!existing) {
    throw new Error(`Missing ${kind} source for ${item.title || item.artist || "item"}`);
  }
}

async function ingestItem(item, service, overwrite) {
  const ids = item.ids || {};
  const recordInput = {
    ...item,
    ids,
    file: item.file || "canvas.mp4",
    thumbnail: item.thumbnail || "thumb.jpg",
    status: item.status || "ready",
  };

  const canonicalId = service.buildCanonicalId(ids, recordInput);
  const dir = service.recordDir(canonicalId);
  fs.mkdirSync(dir, { recursive: true });

  const canvasPath = path.join(dir, recordInput.file);
  const thumbnailPath = path.join(dir, recordInput.thumbnail);

  await writeAsset(item, canvasPath, "canvas", overwrite);
  await writeAsset(item, thumbnailPath, "thumbnail", overwrite);

  const sha256 = await sha256File(canvasPath);
  const registered = service.upsertRecord({
    ...recordInput,
    sourceUrl: item.sourceUrl || null,
    canvasUrl: item.canvasUrl || null,
    thumbnailUrl: item.thumbnailUrl || null,
    sha256,
  });

  return registered;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.log(helpText());
    process.exit(args.help ? 0 : 1);
  }

  if (args.root) {
    process.env.CANVAS_LIBRARY_DIR = args.root;
  }

  const service = require("../src/services/canvasCatalogService");
  const inputPath = path.resolve(args.input);
  const items = readJsonFile(inputPath);

  let ok = 0;
  for (const item of items) {
    const result = await ingestItem(item, service, args.overwrite);
    ok += 1;
    console.log(`Ingested ${result.canonicalId}`);
  }

  const summary = service.readManifest();
  console.log(`Done. Ingested ${ok} item(s). Manifest items: ${summary.items.length}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
