let ioRef;

function registerRealtime(io) {
  ioRef = io;
  io.on("connection", socket => {
    const userId = socket.handshake.auth?.userId;
    if (userId) socket.join(`user:${userId}`);
    socket.join("system");
    socket.emit("system.connected", { ok: true, timeUtc: new Date().toISOString() });
  });
}

function emitToUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`user:${userId}`).emit(event, payload);
}

function emitSystem(event, payload) {
  if (!ioRef) return;
  ioRef.to("system").emit(event, payload);
}

module.exports = { registerRealtime, emitToUser, emitSystem };
