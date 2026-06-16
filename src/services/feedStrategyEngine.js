const MAX_REASONS = 3;

const HAS_HISTORY = "HAS_HISTORY";
const HAS_RECENT_SESSIONS = "HAS_RECENT_SESSIONS";
const HAS_LIKED_TRACKS = "HAS_LIKED_TRACKS";
const HAS_TOP_ARTISTS = "HAS_TOP_ARTISTS";
const HAS_TWO_TOP_ARTISTS = "HAS_TWO_TOP_ARTISTS";
const HAS_TOP_GENRES = "HAS_TOP_GENRES";
const HAS_FOLLOWED_ARTISTS = "HAS_FOLLOWED_ARTISTS";
const HAS_PLAYLISTS = "HAS_PLAYLISTS";
const IS_NEW_USER = "IS_NEW_USER";
const IS_ACTIVE_USER = "IS_ACTIVE_USER";
const IS_POWER_USER = "IS_POWER_USER";
const RECENT_SESSIONS_GT_3 = "RECENT_SESSIONS_GT_3";

const CONDITIONS = {
  [HAS_HISTORY]: (ctx) => ctx.totalTracksPlayed > 0,
  [HAS_RECENT_SESSIONS]: (ctx) => ctx.recentSessions.length > 0,
  [HAS_LIKED_TRACKS]: (ctx) => ctx.likedTracks.length > 0,
  [HAS_TOP_ARTISTS]: (ctx) => ctx.topArtists.length > 0,
  [HAS_TWO_TOP_ARTISTS]: (ctx) => ctx.topArtists.filter(a => a.name.toLowerCase() !== "various artists").length >= 2,
  [HAS_TOP_GENRES]: (ctx) => ctx.topGenres.length > 0,
  [HAS_FOLLOWED_ARTISTS]: (ctx) => ctx.followedArtists.length > 0,
  [HAS_PLAYLISTS]: (ctx) => ctx.totalTracksPlayed > 3,
  [IS_NEW_USER]: (ctx) => ctx.totalTracksPlayed === 0 && ctx.likedTracks.length === 0,
  [IS_ACTIVE_USER]: (ctx) => ctx.totalTracksPlayed > 5,
  [IS_POWER_USER]: (ctx) => ctx.totalTracksPlayed > 50,
  [RECENT_SESSIONS_GT_3]: (ctx) => ctx.recentSessions.length > 3,
};

const REASON_LABELS = {
  [HAS_HISTORY]: "Tu historial de reproducción",
  [HAS_RECENT_SESSIONS]: "Tienes canciones a medio escuchar",
  [HAS_LIKED_TRACKS]: "Tus canciones favoritas",
  [HAS_TOP_ARTISTS]: "Artistas que sigues",
  [HAS_TWO_TOP_ARTISTS]: "Tus artistas principales",
  [HAS_PLAYLISTS]: "Playlists creadas",
  [IS_NEW_USER]: "Eres nuevo por aquí",
  [IS_ACTIVE_USER]: "Escuchas música a menudo",
  [IS_POWER_USER]: "Eres un superfan",
  [RECENT_SESSIONS_GT_3]: "Varias sesiones recientes",
};

function evalCondition(conditionKey, ctx) {
  const fn = CONDITIONS[conditionKey];
  return fn ? fn(ctx) : false;
}

const REASON_MAP = {
  continue_listening: "Basado en tu sesión reciente",
  quick_picks: "Seleccionado para ti",
  listen_again: "Basado en tu historial",
  based_on_artist: null,
  discovery_mix: "Para que descubras nueva música",
  user_playlists: "Tus listas guardadas",
  trending: "Lo más popular ahora",
  new_releases: "Nuevos lanzamientos",
};

const SECTION_DEFS = [
  {
    type: "continue_listening",
    title: "Seguir escuchando",
    category: "replay",
    builder: "buildContinueListening",
    minScore: 15,
    rules: [
      { condition: HAS_RECENT_SESSIONS, score: 95, reasonKey: HAS_RECENT_SESSIONS },
      { condition: RECENT_SESSIONS_GT_3, score: 5, reasonKey: RECENT_SESSIONS_GT_3 },
    ],
  },
  {
    type: "quick_picks",
    title: "Hecho para ti",
    category: "recommendation",
    builder: "buildQuickPicks",
    minScore: 10,
    rules: [
      { condition: HAS_LIKED_TRACKS, score: 80, reasonKey: HAS_LIKED_TRACKS },
      { condition: HAS_HISTORY, score: 60, reasonKey: HAS_HISTORY },
      { condition: IS_ACTIVE_USER, score: 15, reasonKey: IS_ACTIVE_USER },
    ],
  },
  {
    type: "listen_again",
    title: "Escuchar de nuevo",
    category: "replay",
    builder: "buildListenAgain",
    minScore: 15,
    rules: [
      { condition: IS_ACTIVE_USER, score: 85, reasonKey: IS_ACTIVE_USER },
      { condition: HAS_HISTORY, score: 60, reasonKey: HAS_HISTORY },
      { condition: RECENT_SESSIONS_GT_3, score: 20, reasonKey: RECENT_SESSIONS_GT_3 },
    ],
  },
  {
    type: "based_on_artist",
    title: null,
    category: "recommendation",
    builder: "buildBasedOnArtist",
    multi: true,
    minScore: 15,
    rules: [
      { condition: HAS_TWO_TOP_ARTISTS, score: 75, reasonKey: HAS_TWO_TOP_ARTISTS },
      { condition: HAS_TOP_ARTISTS, score: 40, reasonKey: HAS_TOP_ARTISTS },
      { condition: HAS_LIKED_TRACKS, score: 20, reasonKey: HAS_LIKED_TRACKS },
    ],
  },
  {
    type: "discovery_mix",
    title: "Descubrimientos",
    category: "discovery",
    builder: "buildDiscoveryMix",
    minScore: 10,
    rules: [
      { condition: HAS_LIKED_TRACKS, score: 65, reasonKey: HAS_LIKED_TRACKS },
      { condition: IS_ACTIVE_USER, score: 40, reasonKey: IS_ACTIVE_USER },
      { condition: HAS_HISTORY, score: 20, reasonKey: HAS_HISTORY },
    ],
  },
  {
    type: "user_playlists",
    title: "Tus playlists",
    category: "library",
    builder: "buildUserPlaylists",
    minScore: 10,
    rules: [
      { condition: HAS_PLAYLISTS, score: 55, reasonKey: HAS_PLAYLISTS },
      { condition: HAS_HISTORY, score: 30, reasonKey: HAS_HISTORY },
    ],
  },
  {
    type: "trending",
    title: "Tendencias y éxitos",
    category: "global",
    builder: "buildTrending",
    minScore: 5,
    rules: [
      { condition: IS_NEW_USER, score: 90, reasonKey: IS_NEW_USER },
      { condition: HAS_HISTORY, score: 50, reasonKey: HAS_HISTORY },
    ],
  },
  {
    type: "new_releases",
    title: "Nuevos lanzamientos",
    category: "global",
    builder: "buildNewReleases",
    minScore: 5,
    rules: [
      { condition: IS_NEW_USER, score: 80, reasonKey: IS_NEW_USER },
      { condition: HAS_HISTORY, score: 40, reasonKey: HAS_HISTORY },
    ],
  },
];

function computeSectionScores(context) {
  return SECTION_DEFS.map(def => {
    let score = 0;
    const matchedRules = [];

    for (const rule of def.rules) {
      if (evalCondition(rule.condition, context)) {
        score += rule.score;
        matchedRules.push(rule);
      }
    }

    const topReasons = matchedRules
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_REASONS)
      .map(r => REASON_LABELS[r.reasonKey] || r.reasonKey);

    return {
      ...def,
      score,
      reasons: topReasons,
      passes: score >= def.minScore,
    };
  });
}

function selectSectionsForMode(context) {
  const scored = computeSectionScores(context);

  if (context._mode === "cold_start") {
    return {
      mode: "cold_start",
      boost: ["quick_picks", "trending", "new_releases"],
      sections: scored,
    };
  }

  if (context._mode === "light_user") {
    return {
      mode: "light_user",
      boost: ["quick_picks", "trending", "listen_again"],
      sections: scored,
    };
  }

  return {
    mode: "personalized",
    sections: scored,
  };
}

module.exports = {
  CONDITIONS,
  SECTION_DEFS,
  REASON_MAP,
  REASON_LABELS,
  MAX_REASONS,
  HAS_HISTORY,
  HAS_RECENT_SESSIONS,
  HAS_LIKED_TRACKS,
  HAS_TOP_ARTISTS,
  HAS_TWO_TOP_ARTISTS,
  HAS_TOP_GENRES,
  HAS_FOLLOWED_ARTISTS,
  HAS_PLAYLISTS,
  IS_NEW_USER,
  IS_ACTIVE_USER,
  IS_POWER_USER,
  RECENT_SESSIONS_GT_3,
  computeSectionScores,
  selectSectionsForMode,
};
