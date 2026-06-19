let io = null;

function setRealtimeServer(instance) {
  io = instance;
}

function emitUserEvent(userId, event, payload = {}) {
  if (!io || !userId) return;
  io.to(String(userId)).emit(event, payload);
}

module.exports = {
  setRealtimeServer,
  emitUserEvent,
};
