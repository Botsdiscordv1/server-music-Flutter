const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const innertube = require("../../services/innertube");

function resolveProviderUserId(payload) {
  const provider = payload.provider || "android";
  const userId = (provider === "discord" && payload.discordId) ? payload.discordId : payload.sub;
  return { provider, userId, mongoId: payload.sub };
}

function extractYtmCookies(req) {
  // Resolve userId from all possible sources (JWT sets req.userId, others use query/body)
  const userId = req.userId || req.query.userId || req.body?.userId;
  if (!userId) return;

  // Accept cookies via Cookie header, body field, or dedicated X-Ytm-Cookie header
  const ytmCookie = req.headers["x-ytm-cookie"] || req.body?.ytmCookie || req.headers["cookie"];
  const ytmSapisid = req.headers["x-ytm-sapisid"] || req.body?.ytmSapisid;
  const ytmDataSyncId = req.headers["x-ytm-datasync-id"] || req.body?.ytmDataSyncId;
  const ytmVisitorData = req.headers["x-ytm-visitor-data"] || req.body?.ytmVisitorData;
  const isActive = req.headers["x-ytm-active"] || req.body?.ytmActive;
  const hasYtmContent = ytmCookie && (
    ytmCookie.includes("__Secure-3PAPISID") ||
    ytmCookie.includes("SAPISID") ||
    ytmCookie.includes("SSID") ||
    ytmCookie.includes("APISID") ||
    ytmCookie.includes("HSID") ||
    ytmCookie.includes("SID")
  );
  if (ytmSapisid || isActive || hasYtmContent) {
    const cookieStr = ytmCookie || ytmSapisid || "";
    const detected = hasYtmContent ? "content" : "header";
    console.log(`[YTM] userId=${userId} active=${!!isActive} sapisid=${!!ytmSapisid} cookieLen=${cookieStr.length} detected=${detected}`);
    if (cookieStr) {
      innertube.setCookies(cookieStr, userId);
      if (ytmDataSyncId) {
        innertube.setDataSyncId(ytmDataSyncId, userId);
      }
      if (ytmVisitorData) {
        innertube.setVisitorData(ytmVisitorData, userId);
      }
      return true;
    }
  }
  return false;
}

function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      Object.assign(req, resolveProviderUserId(payload));
      extractYtmCookies(req);
      return next();
    } catch {}
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) return next();

  const provided = req.headers["x-api-key"] || req.query.api_key;
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ error: "Unauthorized: invalid or missing API key" });
  }
  extractYtmCookies(req);
  next();
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: missing or invalid token" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    Object.assign(req, resolveProviderUserId(payload));
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized: invalid or expired token" });
  }
}

module.exports = { requireApiKey, requireAuth, extractYtmCookies };
