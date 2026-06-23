const { randomUUID } = require("crypto");
const { emitUserEvent } = require("./realtime");

const users = new Map();

function now() {
  return Date.now();
}

function getUserBucket(userId) {
  const key = String(userId);
  if (!users.has(key)) {
    users.set(key, {
      activeDeviceId: null,
      devices: new Map(),
      lastHandoff: null,
    });
  }
  return users.get(key);
}

function toPublicDevice(device) {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    model: device.model || null,
    appVersion: device.appVersion || null,
    connected: !!device.connected,
    socketId: device.socketId || null,
    lastSeenAt: device.lastSeenAt,
    state: device.state || null,
  };
}

function snapshot(userId) {
  const bucket = getUserBucket(userId);
  const devices = [...bucket.devices.values()].map(toPublicDevice);
  const active = bucket.activeDeviceId ? bucket.devices.get(bucket.activeDeviceId) : null;

  return {
    userId: String(userId),
    activeDeviceId: bucket.activeDeviceId,
    activeDevice: active ? toPublicDevice(active) : null,
    lastHandoff: bucket.lastHandoff,
    devices,
  };
}

function emitSnapshot(userId) {
  emitUserEvent(userId, "devices:state", snapshot(userId));
}

function registerDevice(userId, device, socketId = null) {
  const bucket = getUserBucket(userId);
  const deviceId = String(device.deviceId || randomUUID());
  const existing = bucket.devices.get(deviceId) || {};
  const next = {
    ...existing,
    deviceId,
    name: String(device.name || existing.name || "Dispositivo"),
    platform: String(device.platform || existing.platform || "unknown"),
    model: device.model ?? existing.model ?? null,
    appVersion: device.appVersion ?? existing.appVersion ?? null,
    connected: true,
    socketId,
    lastSeenAt: now(),
    state: existing.state || null,
  };

  bucket.devices.set(deviceId, next);
  if (!bucket.activeDeviceId) {
    bucket.activeDeviceId = deviceId;
  }

  emitSnapshot(userId);
  return snapshot(userId);
}

function upsertPlaybackState(userId, deviceId, state = {}) {
  if (!deviceId) return snapshot(userId);
  const bucket = getUserBucket(userId);
  const device = bucket.devices.get(String(deviceId));
  if (!device) return snapshot(userId);

  device.state = {
    ...state,
    updatedAt: now(),
  };
  device.lastSeenAt = now();
  bucket.devices.set(device.deviceId, device);

  if (!bucket.activeDeviceId) {
    bucket.activeDeviceId = device.deviceId;
  }

  emitSnapshot(userId);
  return snapshot(userId);
}

function transferActiveDevice(userId, targetDeviceId, reason = "manual") {
  const bucket = getUserBucket(userId);
  const target = bucket.devices.get(String(targetDeviceId));
  if (!target || !target.connected) {
    return { ok: false, error: "target_device_not_found", state: snapshot(userId) };
  }

  const previousId = bucket.activeDeviceId;
  const previous = previousId ? bucket.devices.get(previousId) : null;
  bucket.activeDeviceId = target.deviceId;
  const transferId = randomUUID();
  const payload = {
    transferId,
    userId: String(userId),
    reason,
    fromDeviceId: previous?.deviceId || null,
    targetDeviceId: target.deviceId,
    playbackState: previous?.state || target.state || null,
    timestamp: now(),
  };
  bucket.lastHandoff = payload;

  emitUserEvent(userId, "device:handoff", payload);
  emitSnapshot(userId);
  return { ok: true, state: snapshot(userId), transfer: payload };
}

function disconnectDevice(userId, deviceId) {
  const bucket = getUserBucket(userId);
  const device = bucket.devices.get(String(deviceId));
  if (!device) return snapshot(userId);

  device.connected = false;
  device.socketId = null;
  device.lastSeenAt = now();
  bucket.devices.set(device.deviceId, device);

  if (bucket.activeDeviceId === device.deviceId) {
    bucket.activeDeviceId = null;
  }

  emitSnapshot(userId);
  return snapshot(userId);
}

function attachSocket(socket) {
  const userId = socket.data?.userId;
  if (!userId) return;

  let deviceId = null;

  socket.on("device:hello", (payload = {}, ack) => {
    const state = registerDevice(userId, payload, socket.id);
    deviceId = payload.deviceId ? String(payload.deviceId) : state.activeDeviceId;
    socket.data.deviceId = deviceId;
    if (typeof ack === "function") ack(state);
    socket.emit("device:ready", { deviceId, state });
  });

  socket.on("device:state", (payload = {}, ack) => {
    const currentId = payload.deviceId || socket.data?.deviceId || deviceId;
    const state = upsertPlaybackState(userId, currentId, payload.state || payload);
    if (typeof ack === "function") ack(state);
  });

  socket.on("device:activate", (payload = {}, ack) => {
    const targetDeviceId = payload.deviceId || payload.targetDeviceId;
    const result = transferActiveDevice(userId, targetDeviceId, payload.reason || "manual");
    if (typeof ack === "function") ack(result);
  });

  socket.on("device:command", (payload = {}, ack) => {
    const targetDeviceId = String(payload.targetDeviceId || bucket.activeDeviceId || "");
    const command = String(payload.command || "");
    if (!command) {
      if (typeof ack === "function") ack({ ok: false, error: "missing_command" });
      return;
    }

    const commandPayload = {
      commandId: randomUUID(),
      command,
      targetDeviceId,
      senderDeviceId: socket.data?.deviceId || null,
      payload: payload.payload || null,
      timestamp: now(),
    };

    emitUserEvent(userId, "device:command", commandPayload);
    if (typeof ack === "function") ack({ ok: true, command: commandPayload });
  });

  socket.on("device:disconnect", () => {
    const currentId = socket.data?.deviceId || deviceId;
    if (currentId) disconnectDevice(userId, currentId);
  });

  socket.on("disconnect", () => {
    const currentId = socket.data?.deviceId || deviceId;
    if (currentId) disconnectDevice(userId, currentId);
  });

  socket.emit("devices:state", snapshot(userId));
}

function getUserState(userId) {
  return snapshot(userId);
}

module.exports = {
  attachSocket,
  disconnectDevice,
  getUserState,
  registerDevice,
  transferActiveDevice,
  upsertPlaybackState,
};
