const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const innertube = require("./innertube");

const USER_DATA_DIR = path.join(__dirname, "..", "..", "data", "chrome-profile");
const YTM_HOME = "https://music.youtube.com";
const REFRESH_INTERVAL = 8 * 60 * 60 * 1000;

let refreshTimer = null;

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
];

function detectLaunchOptions() {
  if (process.platform === "win32") {
    return { channel: "chrome", headless: true };
  }

  const pwPath = path.join(os.homedir(), ".cache", "ms-playwright");
  if (fs.existsSync(pwPath)) {
    const entries = fs.readdirSync(pwPath).filter(e => e.startsWith("chromium-") && !e.includes("headless"));
    if (entries.length) {
      const fullPath = path.join(pwPath, entries.sort().reverse()[0], "chrome-linux", "chrome");
      if (fs.existsSync(fullPath)) {
        return { executablePath: fullPath, headless: true, args: BROWSER_ARGS };
      }
    }
  }

  try {
    require("child_process").execSync("which google-chrome-stable", { stdio: "ignore" });
    return { channel: "chrome", headless: true, args: BROWSER_ARGS };
  } catch {
    try {
      require("child_process").execSync("which google-chrome", { stdio: "ignore" });
      return { channel: "chrome", headless: true, args: BROWSER_ARGS };
    } catch {
      try {
        require("child_process").execSync("which chromium-browser", { stdio: "ignore" });
        return { channel: "chromium", headless: true, args: BROWSER_ARGS };
      } catch {
        return { headless: true, args: BROWSER_ARGS };
      }
    }
  }
}

async function extractCookieString(page) {
  const cookies = await page.context().cookies();
  const ytCookies = cookies
    .filter(c => c.name.match(/^(SAPISID|APISID|SSID|HSID|__Secure-|LOGIN_INFO|PREF|VISITOR_INFO|CONSENT|__Host-)/))
    .map(c => `${c.name}=${c.value}`)
    .join("; ");
  return ytCookies;
}

function isProbablyLoggedIn(page) {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const hasAvatar = html.includes('avatar');
    const hasAccountLink = html.includes('href="/account"') || html.includes('aria-label="Google Account"');
    const hasSapisidCookie = document.cookie.includes('SAPISID') || document.cookie.includes('__Secure-3PAPISID');
    return (hasAvatar || hasAccountLink) && hasSapisidCookie;
  }).catch(() => false);
}

async function doLogin(context, email, password) {
  const page = await context.newPage();

  try {
    await page.goto("https://accounts.google.com/ServiceLogin?service=youtube&continue=https://music.youtube.com", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  } catch {
    await page.goto("https://accounts.google.com/ServiceLogin?service=youtube", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
  }

  await page.waitForTimeout(2000);

  try {
    const emailInput = page.locator('input[type="email"], input[name="identifier"]');
    await emailInput.waitFor({ timeout: 10000 });
    await emailInput.fill(email);
    await page.click("#identifierNext, [id^='identifierNext']");
    await page.waitForTimeout(3000);
  } catch (err) {
    console.warn(`[GuestRefresher] Email step failed: ${err.message}`);
    await page.close();
    return null;
  }

  try {
    const passwordInput = page.locator('input[type="password"], input[name="Passwd"]');
    await passwordInput.waitFor({ timeout: 15000 });
    await passwordInput.fill(password);
    await page.click("#passwordNext, [id^='passwordNext']");
    await page.waitForTimeout(5000);
  } catch (err) {
    console.warn(`[GuestRefresher] Password step failed or already logged in: ${err.message}`);
  }

  try {
    await page.waitForURL("**/music.youtube.com/**", { timeout: 20000 });
  } catch {
    try {
      await page.waitForURL("**/myaccount**", { timeout: 10000 });
      await page.goto(YTM_HOME, { waitUntil: "domcontentloaded", timeout: 15000 });
    } catch {
      console.warn("[GuestRefresher] Could not detect successful login, trying YT Music directly");
      await page.goto(YTM_HOME, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    }
  }

  await page.waitForTimeout(3000);
  return page;
}

function hasRealSapisid(cookieStr) {
  return cookieStr && cookieStr.length > 600 && /__Secure-3PAPISID|SAPISID/.test(cookieStr);
}

async function refreshGuestCookies() {
  const email = process.env.GUEST_YTM_EMAIL;
  const password = process.env.GUEST_YTM_PASSWORD;

  if (!email || !password) {
    console.warn("[GuestRefresher] GUEST_YTM_EMAIL or GUEST_YTM_PASSWORD not set, skipping");
    return false;
  }

  const hadGoodCookies = hasRealSapisid(innertube.getGuestCookieString());

  let context = null;
  let page = null;

  try {
    const launchOpts = detectLaunchOptions();
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      ...launchOpts,
      timeout: 60000,
    });

    page = await context.newPage();
    await page.goto(YTM_HOME, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2000);

    const loggedIn = await isProbablyLoggedIn(page);

    if (!loggedIn) {
      if (hadGoodCookies) {
        console.log("[GuestRefresher] Session expired but keeping existing good cookies, skipping re-login");
        return true;
      }
      console.log("[GuestRefresher] Session expired, re-logging in...");
      const loginPage = await doLogin(context, email, password);
      if (loginPage) page = loginPage;
    } else {
      console.log("[GuestRefresher] Session still valid, refreshing cookies...");
    }

    const cookieString = await extractCookieString(page);
    const isGood = hasRealSapisid(cookieString);

    if (isGood) {
      innertube.setGuestCookies(cookieString);
      console.log(`[GuestRefresher] Cookies refreshed successfully (${cookieString.length} chars)`);
      return true;
    }

    if (hadGoodCookies && !isGood) {
      console.warn(`[GuestRefresher] Extracted cookies (${cookieString?.length || 0}) worse than current, keeping existing`);
      return true;
    }

    if (cookieString && cookieString.length > 80) {
      innertube.setGuestCookies(cookieString);
      console.log(`[GuestRefresher] Fallback cookies saved (${cookieString.length} chars)`);
      return true;
    }

    console.warn(`[GuestRefresher] Extracted cookie too short (${cookieString?.length || 0}), skipping`);
    return false;
  } catch (err) {
    console.warn(`[GuestRefresher] Refresh failed: ${err.message}`);
    return hadGoodCookies;
  } finally {
    if (page && !page.isClosed()) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

async function start() {
  console.log("[GuestRefresher] Starting...");
  const ok = await refreshGuestCookies();
  if (!ok) {
    console.warn("[GuestRefresher] Initial cookie fetch failed, will retry on schedule");
  }

  refreshTimer = setInterval(async () => {
    console.log("[GuestRefresher] Scheduled refresh...");
    await refreshGuestCookies();
  }, REFRESH_INTERVAL);

  if (refreshTimer.unref) refreshTimer.unref();
  console.log(`[GuestRefresher] Scheduled every ${REFRESH_INTERVAL / 60000} minutes`);
}

function stop() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

module.exports = { start, stop, refreshGuestCookies };
