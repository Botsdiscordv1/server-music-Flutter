#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    out: null,
    root: null,
    pretty: true,
    watch: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }
    if (current === "--no-pretty") {
      args.pretty = false;
      continue;
    }
    if (current === "--pretty") {
      args.pretty = true;
      continue;
    }
    if (current === "--watch") {
      args.watch = true;
      continue;
    }
    if (current === "--out" || current === "-o") {
      args.out = argv[i + 1] || null;
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
    "  node scripts/canvas-export.js [--out canvas-export.json] [--root E:\\Proyectos\\Videos-canvas] [--no-pretty] [--watch]",
    "",
    "Output:",
    "  Writes a client-ready snapshot JSON with manifest data and URLs.",
  ].join("\n");
}

function exportSnapshot(service, outPath, pretty, baseUrl) {
  const summary = service.getCatalogSummary(baseUrl);

  const payload = {
    exportedAt: new Date().toISOString(),
    root: service.CANVAS_LIBRARY_ROOT,
    count: summary.count,
    items: summary.items,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const json = JSON.stringify(payload, null, pretty ? 2 : 0);
  fs.writeFileSync(outPath, json, "utf8");
  console.log(`Exported ${payload.count} item(s) to ${outPath}`);
}

function watchManifest(service, outPath, pretty, baseUrl) {
  const manifestPath = path.join(service.CANVAS_LIBRARY_ROOT, "manifest.json");
  let timer = null;

  const triggerExport = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        exportSnapshot(service, outPath, pretty, baseUrl);
      } catch (err) {
        console.error(err.stack || err.message || String(err));
      }
    }, 200);
  };

  fs.watchFile(manifestPath, { interval: 1000 }, triggerExport);
  console.log(`Watching ${manifestPath}`);
  triggerExport();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(helpText());
    process.exit(0);
  }

  if (args.root) {
    process.env.CANVAS_LIBRARY_DIR = args.root;
  }

  const service = require("../src/services/canvasCatalogService");
  const baseUrl = process.env.CANVAS_BASE_URL || "http://localhost:3000";
  const outPath = path.resolve(args.out || path.join(service.CANVAS_LIBRARY_ROOT, "canvas-export.json"));

  if (args.watch) {
    watchManifest(service, outPath, args.pretty, baseUrl);
    return;
  }

  exportSnapshot(service, outPath, args.pretty, baseUrl);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
