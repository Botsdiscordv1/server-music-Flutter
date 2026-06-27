require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { initDB } = require("./database");
const { app: musicApi } = require("./api/server");
const innertube = require("./services/innertube");
const canvasCatalogService = require("./services/canvasCatalogService");
const guestAccountRefresher = require("./services/guestAccountRefresher");
const { setRealtimeServer } = require("./services/realtime");
const { attachSocket } = require("./services/deviceSessionService");

// Usar el puerto de Render o 3000 por defecto
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

let server;
let canvasWatchers = new Map();
let canvasSyncTimer = null;
let canvasSyncInProgress = false;
let canvasSyncQueued = false;

function getCanvasLibraryRoot() {
  return path.join(canvasCatalogService.CANVAS_LIBRARY_ROOT, "library");
}

function closeCanvasWatchers() {
  for (const watcher of canvasWatchers.values()) {
    try { watcher.close(); } catch {}
  }
  canvasWatchers = new Map();
}

function buildCanvasWatchers(rootDir, onChange) {
  if (!fs.existsSync(rootDir)) return 0;

  const stack = [rootDir];
  let opened = 0;

  while (stack.length) {
    const current = stack.pop();
    if (canvasWatchers.has(current)) continue;

    try {
      const watcher = fs.watch(current, { persistent: true }, (eventType, filename) => {
        if (filename) {
          const fullPath = path.join(current, String(filename));
          try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
              stack.push(fullPath);
            }
          } catch {}
        }
        onChange();
      });

      watcher.on("error", (err) => {
        console.warn(`[Canvas] Watcher error on ${current}: ${err.message}`);
      });

      canvasWatchers.set(current, watcher);
      opened += 1;
    } catch (err) {
      console.warn(`[Canvas] Failed to watch ${current}: ${err.message}`);
    }

    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          stack.push(path.join(current, entry.name));
        }
      }
    } catch {}
  }

  return opened;
}

function rebuildCanvasWatchers(onChange) {
  closeCanvasWatchers();
  return buildCanvasWatchers(getCanvasLibraryRoot(), onChange);
}

function scheduleCanvasSync(syncCanvasCatalog, reason = "change") {
  if (canvasSyncInProgress) {
    canvasSyncQueued = true;
    return;
  }

  clearTimeout(canvasSyncTimer);
  const debounceMs = Math.max(50, parseInt(process.env.CANVAS_WATCH_DEBOUNCE_MS || "250", 10));
  canvasSyncTimer = setTimeout(() => {
    canvasSyncTimer = null;
    canvasSyncInProgress = true;
    try {
      const synced = syncCanvasCatalog();
      rebuildCanvasWatchers(() => scheduleCanvasSync(syncCanvasCatalog));
      if (synced > 0) {
        console.log(`[Canvas] Synced ${synced} folder(s) via watcher${reason ? ` (${reason})` : ""}`);
      }
    } catch (err) {
      console.warn(`[Canvas] Watch sync failed: ${err.message}`);
    } finally {
      canvasSyncInProgress = false;
      if (canvasSyncQueued) {
        canvasSyncQueued = false;
        scheduleCanvasSync(syncCanvasCatalog, "queued");
      }
    }
  }, debounceMs);
}

function resolveSocketUserId(payload) {
  const provider = payload.provider || "android";
  const userId = (provider === "discord" && payload.discordId) ? payload.discordId : payload.sub;
  return { provider, userId, mongoId: payload.sub };
}

function attachRealtime(serverInstance) {
  const io = new Server(serverInstance, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  setRealtimeServer(io);

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return next(new Error("Unauthorized"));

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.data = resolveSocketUserId(payload);
      return next();
    } catch {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data?.userId;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    socket.join(String(userId));
    socket.emit("realtime:ready", { userId: String(userId) });
    attachSocket(socket);
    console.log(`[Realtime] Connected user=${userId} socket=${socket.id}`);

    socket.on("disconnect", (reason) => {
      console.log(`[Realtime] Disconnected user=${userId} socket=${socket.id} reason=${reason}`);
    });
  });

  return io;
}

async function main() {
  console.log("🚀 Starting Backend...");

  // 1. Inicializar Base de Datos
  try {
    await initDB();
    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database initialization failed:", err.message);
  }

  // 2. Inicializar InnerTube (fail-fast)
  innertube.initialize().catch(err => {
    console.warn(`[InnerTube] Startup initialization failed: ${err.message}`);
  });

  // 3. Iniciar refresco automático de cookies para cuenta guest
  setTimeout(() => {
    guestAccountRefresher.start().catch(err => {
      console.warn(`[GuestRefresher] Failed to start: ${err.message}`);
    });
  }, 5000);

  // 4. Iniciar Servidor Express
  function startServer(attempt = 1) {
    const serverInstance = http.createServer(musicApi);
    attachRealtime(serverInstance);

    serverInstance.listen(PORT, () => {
      console.log(`[SERVER] Running on port ${PORT}`);
    });

    serverInstance.on("error", (err) => {
      if (err.code === "EADDRINUSE" && attempt < 5) {
        console.log(`[SERVER] Port ${PORT} in use, retrying in 1s (attempt ${attempt})...`);
        serverInstance.close(() => setTimeout(() => startServer(attempt + 1), 1000));
      } else {
        console.error(`[SERVER] Failed to start on port ${PORT}:`, err.message);
        process.exit(1);
      }
    });

    return serverInstance;
  }

  server = startServer();

  const canvasEnabled = process.env.CANVAS_ENABLED !== "false";

  const syncCanvasCatalog = () => {
    if (!canvasEnabled) return 0;
    try {
      const synced = canvasCatalogService.syncFilesystemCatalog();
      if (synced.length) {
        console.log(`[Canvas] Synced ${synced.length} folder(s)`);
      }
      return synced.length;
    } catch (err) {
      console.warn(`[Canvas] Sync failed: ${err.message}`);
      return 0;
    }
  };

  if (canvasEnabled) {
    syncCanvasCatalog();
    rebuildCanvasWatchers(() => scheduleCanvasSync(syncCanvasCatalog));
  } else {
    console.log("[Canvas] Disabled (CANVAS_ENABLED=false)");
  }

  // 4. TTS Keepalive (Opcional, si está configurado)
  const ttsProvider = (process.env.TTS_PROVIDER || "google").toLowerCase();
  if (ttsProvider === "edge" || ttsProvider === "kokoro") {
    const edgeApiUrl = process.env.EDGE_API_URL || process.env.KOKORO_API_URL;
    if (edgeApiUrl) {
      const warmUrl = `${edgeApiUrl.replace(/\/+$/, "")}/tts.mp3?text=keep+warm&voice=${process.env.EDGE_VOICE || "es-MX-DaliaNeural"}&lang=${process.env.EDGE_LANG || "es"}`;
      setInterval(() => {
        fetch(warmUrl).catch(() => {});
      }, 4 * 60 * 1000);
      console.log("[TTS] Keepalive enabled");
    }
  }
}

process.on("uncaughtException", (err) => console.error("❌ Uncaught:", err.message));
process.on("unhandledRejection", (reason) => console.error("❌ Unhandled:", reason?.message || reason));

process.on("SIGTERM", () => {
  console.log("[SERVER] SIGTERM received, closing server...");
  closeCanvasWatchers();
  if (server && server.close) server.close(() => process.exit(0));
  else process.exit(0);
});

main().catch(console.error);
