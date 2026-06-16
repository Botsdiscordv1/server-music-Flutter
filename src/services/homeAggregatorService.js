const crypto = require("crypto");
const innertube = require("./innertube");
const userContextService = require("./userContextService");
const sectionBuilder = require("./sectionBuilder");
const feedStrategyEngine = require("./feedStrategyEngine");
const sectionPlanner = require("./sectionPlanner");

const homeCache = new Map();
const HOME_CACHE_TTL = 2 * 60 * 1000;

const BUILDER_MAP = {
  buildContinueListening: sectionBuilder.buildContinueListening,
  buildQuickPicks: sectionBuilder.buildQuickPicks,
  buildListenAgain: sectionBuilder.buildListenAgain,
  buildBasedOnArtist: sectionBuilder.buildBasedOnArtist,
  buildDiscoveryMix: sectionBuilder.buildDiscoveryMix,
  buildUserPlaylists: sectionBuilder.buildUserPlaylists,
  buildTrending: sectionBuilder.buildTrending,
  buildNewReleases: sectionBuilder.buildNewReleases,
};

function generateSessionId() {
  return crypto.randomUUID();
}

async function getHomeSections(userId = "guest", source = "android") {
  const cacheKey = `${userId}:${source}`;
  const sessionId = generateSessionId();

  const context = await userContextService.buildUserContext(userId, source);

  const cached = homeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < HOME_CACHE_TTL) {
    if (cached.contextVersion === context._version) {
      return {
        sessionId,
        sections: cached.data,
      };
    }
  }

  try {
    let sections;

    if (context._mode === "cold_start") {
      sections = await buildColdStart(userId, source);
    } else {
      sections = await buildPersonalizedFeed(userId, source, context);
    }

    homeCache.set(cacheKey, {
      data: sections,
      contextVersion: context._version,
      timestamp: Date.now(),
    });

    return { sessionId, sections };
  } catch (err) {
    console.error(`[HomeAggregator] Critical error for ${userId}:`, err.message);
    const cached = homeCache.get(cacheKey);
    return {
      sessionId,
      sections: cached ? cached.data : [],
    };
  }
}

async function buildPersonalizedFeed(userId, source, context) {
  const recommendationService = require("./recommendationService");
  const ytSections = await recommendationService.getRecommendations(userId, source).catch(() => []);

  const sections = [];
  let order = 1;

  const usedTypes = new Set();

  for (const ytSec of ytSections) {
    usedTypes.add(ytSec.type);
    sections.push({
      id: `section_yt_${order}`,
      type: ytSec.type,
      title: ytSec.title,
      items: ytSec.items || [],
      order: order++,
      reason: feedStrategyEngine.REASON_MAP[ytSec.type] || "Recomendado para ti",
      reasonKeys: ["YouTube Music"],
      sectionType: ytSec.type,
    });
  }

  const relaxIdx = sections.findIndex(s => s.title.toLowerCase().includes("relaj"));
  if (relaxIdx !== -1 && !usedTypes.has("essentials")) {
    const essentialsTracks = await innertube.searchQuery("esenciales", "song", userId).catch(() => []);
    if (essentialsTracks && essentialsTracks.length > 0) {
      sections.splice(relaxIdx + 1, 0, {
        id: "section_essentials",
        type: "essentials",
        title: "Esenciales de todos los tiempos",
        items: essentialsTracks.slice(0, 15),
        order: order++,
        reason: "Clásicos que no pasan de moda",
        reasonKeys: ["Curados para ti"],
        sectionType: "essentials",
      });
    }
  }

  const strategy = feedStrategyEngine.selectSectionsForMode(context);
  const plan = sectionPlanner.planSections(strategy);

  const appOnlyTypes = ["continue_listening", "user_playlists", "based_on_artist"];

  const builderPromises = plan.map(async (planned) => {
    if (usedTypes.has(planned.type) && !appOnlyTypes.includes(planned.type)) return [];
    if (planned.type === "trending" || planned.type === "new_releases" || planned.type === "quick_picks" || planned.type === "listen_again" || planned.type === "discovery_mix") {
      if (usedTypes.has(planned.type)) return [];
    }

    const builderFn = BUILDER_MAP[planned.builder];
    if (!builderFn) return [];

    try {
      const result = await builderFn(userId, source, { ...context, _cachedRecommendations: ytSections });

      const attachMeta = (section) => ({
        ...section,
        reason: section.reason || feedStrategyEngine.REASON_MAP[planned.type] || null,
        reasonKeys: planned.reasons,
        sectionType: planned.type,
      });

      if (planned.multi && Array.isArray(result)) {
        return result.map(attachMeta);
      }
      return result ? [attachMeta(result)] : [];
    } catch (err) {
      console.warn(`[HomeAggregator] Builder ${planned.builder} failed:`, err.message);
      return [];
    }
  });

  const results = await Promise.all(builderPromises);
  const customSections = results.flat().filter(Boolean);

  customSections.forEach(s => {
    s.order = order++;
    sections.push(s);
  });

  return sections;
}

async function buildColdStart(userId, source) {
  try {
    const recommendationService = require("./recommendationService");
    const recSections = await recommendationService.getRecommendations(userId, source).catch(() => []);

    const sections = recSections.map((ytSec, i) => ({
      id: `section_yt_${i}`,
      type: ytSec.type,
      title: ytSec.title,
      order: i + 1,
      items: ytSec.items || [],
      reason: feedStrategyEngine.REASON_MAP[ytSec.type] || "Recomendado para ti",
      reasonKeys: ["YouTube Music"],
      sectionType: ytSec.type,
    }));

    const relaxIdx = sections.findIndex(s => s.title.toLowerCase().includes("relaj"));
    if (relaxIdx !== -1) {
      const essentialsTracks = await innertube.searchQuery("esenciales", "song", userId).catch(() => []);
      if (essentialsTracks && essentialsTracks.length > 0) {
        sections.splice(relaxIdx + 1, 0, {
          id: "section_essentials",
          type: "essentials",
          title: "Esenciales de todos los tiempos",
          items: essentialsTracks.slice(0, 15),
          order: relaxIdx + 2,
          reason: "Clásicos que no pasan de moda",
          reasonKeys: ["Curados para ti"],
          sectionType: "essentials",
        });
        sections.forEach((s, i) => s.order = i + 1);
      }
    }

    return sections;
  } catch (err) {
    console.error("[HomeAggregator] Cold start failed:", err.message);
    return [];
  }
}

function clearUserCache(userId, source = "android") {
  const keys = Array.from(homeCache.keys());
  for (const key of keys) {
    if (key.startsWith(`${userId}:${source}`)) {
      homeCache.delete(key);
    }
  }
  userContextService.clearCache(userId);
}

module.exports = {
  getHomeSections,
  clearUserCache,
};
