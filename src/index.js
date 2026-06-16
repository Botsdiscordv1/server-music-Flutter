require("dotenv").config();
const { initDB } = require("./database");
const { app: musicApi } = require("./api/server");
const innertube = require("./services/innertube");

// Usar el puerto de Render o 3000 por defecto
const PORT = process.env.PORT || 3000;

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

  // 3. Iniciar Servidor Express
  function startServer(attempt = 1) {
    const server = musicApi.listen(PORT, () => {
      console.log(`[SERVER] Running on port ${PORT}`);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && attempt < 5) {
        console.log(`[SERVER] Port ${PORT} in use, retrying in 1s (attempt ${attempt})...`);
        setTimeout(() => startServer(attempt + 1), 1000);
      } else {
        console.error(`[SERVER] Failed to start on port ${PORT}:`, err.message);
        process.exit(1);
      }
    });
    return server;
  }
  let server = startServer();

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
  if (server && server.close) server.close(() => process.exit(0));
  else process.exit(0);
});

main().catch(console.error);
