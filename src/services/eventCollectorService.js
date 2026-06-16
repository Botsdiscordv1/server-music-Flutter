const db = require("../database");

const VALID_EVENTS = new Set(["impression", "play", "skip", "dwell"]);

function validateEvent(body) {
  if (!body.userId) return "Missing userId";
  if (!body.sessionId) return "Missing sessionId";
  if (!body.event || !VALID_EVENTS.has(body.event)) return "Invalid or missing event type";
  if (!body.sectionType) return "Missing sectionType";
  if (!body.itemId) return "Missing itemId";
  return null;
}

async function recordEvent(eventData) {
  const error = validateEvent(eventData);
  if (error) {
    console.warn(`[EventCollector] Validation error: ${error}`);
    return { ok: false, error };
  }

  try {
    await db.recordEvent({
      userId: eventData.userId,
      sessionId: eventData.sessionId,
      event: eventData.event,
      sectionType: eventData.sectionType,
      reasonKey: eventData.reasonKey || null,
      itemId: eventData.itemId,
      dwellMs: eventData.dwellMs || 0,
      source: eventData.source || "android",
    });

    return { ok: true };
  } catch (err) {
    console.error(`[EventCollector] Failed to record event:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function recordBatch(events) {
  if (!Array.isArray(events)) {
    return { ok: false, error: "Expected array" };
  }

  const results = [];
  for (const event of events) {
    results.push(await recordEvent(event));
  }

  const failed = results.filter(r => !r.ok).length;
  return { ok: failed === 0, recorded: results.length, failed };
}

module.exports = {
  recordEvent,
  recordBatch,
};
