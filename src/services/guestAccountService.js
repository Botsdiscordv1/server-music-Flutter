const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const COOKIES_FILE = path.join(DATA_DIR, "guest-cookies.json");

const listeners = new Set();

function notifyListeners(cookieString) {
  for (const fn of listeners) {
    try { fn(cookieString); } catch {}
  }
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const raw = fs.readFileSync(COOKIES_FILE, "utf8");
      const data = JSON.parse(raw);
      return data.cookieString || null;
    }
  } catch (e) {
    console.warn(`[GuestAccount] Failed to load cookies: ${e.message}`);
  }
  return null;
}

function saveCookies(cookieString) {
  ensureDataDir();
  try {
    const data = JSON.stringify({ cookieString, updatedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(COOKIES_FILE, data, "utf8");
    console.log(`[GuestAccount] Cookies saved (${cookieString.length} chars)`);
    return true;
  } catch (e) {
    console.warn(`[GuestAccount] Failed to save cookies: ${e.message}`);
    return false;
  }
}

function clearCookies() {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      fs.unlinkSync(COOKIES_FILE);
    }
    console.log("[GuestAccount] Cookies cleared");
    notifyListeners(null);
    return true;
  } catch (e) {
    console.warn(`[GuestAccount] Failed to clear cookies: ${e.message}`);
    return false;
  }
}

function hasCookies() {
  return !!loadCookies();
}

function getCookiePath() {
  return COOKIES_FILE;
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  loadCookies,
  saveCookies,
  clearCookies,
  hasCookies,
  getCookiePath,
  onChange,
};
