const MAX_PER_CATEGORY = {
  replay: 1,
  recommendation: 2,
  discovery: 2,
  library: 1,
  global: 3,
};

const MAX_SECTIONS_TOTAL = 8;

const COLD_START_SECTIONS = [
  {
    type: "quick_picks",
    title: "Descubre música",
    category: "recommendation",
    builder: "buildQuickPicks",
    reasons: ["Eres nuevo por aquí"],
  },
  {
    type: "trending",
    title: "Tendencias y éxitos",
    category: "global",
    builder: "buildTrending",
    reasons: ["Lo más popular ahora"],
  },
  {
    type: "new_releases",
    title: "Nuevos lanzamientos",
    category: "global",
    builder: "buildNewReleases",
    reasons: ["Novedades para explorar"],
  },
];

function applyMaxPerCategory(scoredSections) {
  const counts = {};
  return scoredSections.filter(s => {
    if (!s.passes) return false;
    const cat = s.category;
    counts[cat] = (counts[cat] || 0) + 1;
    if (counts[cat] > (MAX_PER_CATEGORY[cat] || Infinity)) {
      return false;
    }
    return true;
  });
}

function applySpread(scoredSections) {
  if (scoredSections.length <= 3) return scoredSections;

  const result = [];
  const remaining = [...scoredSections];
  let lastCat = null;

  while (remaining.length > 0 && result.length < MAX_SECTIONS_TOTAL) {
    const bestIdx = remaining.findIndex(s => s.category !== lastCat);
    if (bestIdx === -1) {
      result.push(remaining.shift());
      break;
    }
    const picked = remaining.splice(bestIdx, 1)[0];
    result.push(picked);
    lastCat = picked.category;
  }

  result.push(...remaining);
  return result.slice(0, MAX_SECTIONS_TOTAL);
}

function planSections(strategyResult) {
  const { sections, mode, boost } = strategyResult;

  let ordered = sections
    .filter(s => s.passes)
    .sort((a, b) => {
      const aBoost = boost?.includes(a.type) ? 50 : 0;
      const bBoost = boost?.includes(b.type) ? 50 : 0;
      return (b.score + bBoost) - (a.score + aBoost);
    });

  ordered = applyMaxPerCategory(ordered);
  ordered = applySpread(ordered);

  return ordered.map((s, i) => ({
    ...s,
    order: i + 1,
  }));
}

function getColdStartPlan() {
  return COLD_START_SECTIONS.map((s, i) => ({
    ...s,
    score: 100 - i * 5,
    order: i + 1,
  }));
}

module.exports = {
  planSections,
  getColdStartPlan,
  COLD_START_SECTIONS,
};
