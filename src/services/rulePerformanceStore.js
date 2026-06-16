const db = require("../database");

const COMPUTE_INTERVAL_MS = 5 * 60 * 1000;
let lastCompute = 0;

async function computeMetrics(since = null) {
  try {
    const aggregates = await db.getEventAggregates(since);
    if (!aggregates || aggregates.length === 0) return { reasonKeys: 0 };

    let updated = 0;
    for (const agg of aggregates) {
      if (!agg._id) continue;
      const impressions = agg.impressions || 0;
      const plays = agg.plays || 0;
      const skips = agg.skips || 0;
      const totalDwellMs = agg.totalDwellMs || 0;
      const dwellEvents = agg.dwellEvents || 0;

      await db.upsertRulePerformance(agg._id, {
        totalImpressions: impressions,
        totalPlays: plays,
        totalSkips: skips,
        totalDwellMs,
        totalDwellEvents: dwellEvents,
        ctr: impressions > 0 ? plays / impressions : 0,
        playRate: impressions > 0 ? plays / impressions : 0,
        skipRate: plays > 0 ? skips / plays : 0,
        avgDwellMs: dwellEvents > 0 ? Math.round(totalDwellMs / dwellEvents) : 0,
      });
      updated++;
    }

    lastCompute = Date.now();
    return { reasonKeys: updated };
  } catch (err) {
    console.error("[RulePerformanceStore] computeMetrics error:", err.message);
    return { reasonKeys: 0, error: err.message };
  }
}

async function getPerformanceByReasonKey(reasonKey) {
  return db.getRulePerformance(reasonKey);
}

async function getAllPerformance() {
  return db.getRulePerformance(null);
}

async function maybeCompute() {
  if (Date.now() - lastCompute < COMPUTE_INTERVAL_MS) {
    return { skipped: true };
  }
  return computeMetrics();
}

module.exports = {
  computeMetrics,
  getPerformanceByReasonKey,
  getAllPerformance,
  maybeCompute,
};
