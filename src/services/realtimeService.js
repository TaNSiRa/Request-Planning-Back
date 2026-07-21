const { query } = require("../db/pool");

let ioRef;

// Online presence: userId -> { count, name, fullName }. `count` is the number
// of open sockets for that user (multiple tabs), so a user goes offline only
// when the LAST tab closes. Lives in process memory — clients reconnect after
// a backend restart, so the map rebuilds itself.
const online = new Map();

// Everything a client needs to render presence: who is online (for the count
// and the avatar dots) and who is looking at the Meeting page per section
// (for the per-section viewer strip).
// Which section each online user is working in right now (userId -> code).
// Clients report it on every section change, so this is the live pick — not
// the sections they merely belong to.
function sectionByUser() {
  const map = new Map();
  const sockets = ioRef?.of("/")?.sockets;
  if (!sockets) return map;
  for (const socket of sockets.values()) {
    const { userId, section } = socket.data || {};
    const code = `${section || ""}`.trim().toUpperCase();
    if (!userId || !code || map.has(userId)) continue;
    map.set(userId, code);
  }
  return map;
}

function presenceSnapshot() {
  const sections = sectionByUser();
  const users = [...online.entries()].map(([id, u]) => ({
    id,
    name: u.name,
    fullName: u.fullName,
    section: sections.get(id) || ""
  }));
  const meeting = {};
  const sockets = ioRef?.of("/")?.sockets;
  if (sockets) {
    for (const socket of sockets.values()) {
      const { userId, page, section } = socket.data || {};
      if (page !== "meeting" || !userId) continue;
      const key = `${section || ""}`.toUpperCase();
      if (!meeting[key]) meeting[key] = [];
      if (meeting[key].some(v => v.id === userId)) continue;
      const u = online.get(userId);
      meeting[key].push({ id: userId, name: u?.name || `User #${userId}`, fullName: u?.fullName || "" });
    }
  }
  return { users, meeting };
}

// Debounced fan-out so a burst of connects/disconnects costs one broadcast.
let presenceTimer = null;
function broadcastPresence() {
  clearTimeout(presenceTimer);
  presenceTimer = setTimeout(() => {
    ioRef?.to("system").emit("presence.updated", presenceSnapshot());
  }, 200);
}

async function lookupUser(userId) {
  // full_name may not exist on older databases — fall back to name only.
  try {
    const row = (await query(
      "SELECT display_name, full_name FROM users WHERE id=@id", { id: userId }
    )).recordset[0];
    if (row) return { name: row.display_name, fullName: row.full_name || "" };
  } catch (_) {
    try {
      const row = (await query(
        "SELECT display_name FROM users WHERE id=@id", { id: userId }
      )).recordset[0];
      if (row) return { name: row.display_name, fullName: "" };
    } catch (_) { /* DB unavailable — keep the placeholder */ }
  }
  return { name: `User #${userId}`, fullName: "" };
}

function registerRealtime(io) {
  ioRef = io;
  io.on("connection", async socket => {
    const rawId = Number(socket.handshake.auth?.userId);
    const userId = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    socket.data.userId = userId;
    if (userId) socket.join(`user:${userId}`);
    socket.join("system");
    socket.emit("system.connected", { ok: true, timeUtc: new Date().toISOString() });

    // The client reports which page it is on (currently only the Meeting page
    // needs this) — re-sent by the client after every reconnect.
    socket.on("presence.page", data => {
      socket.data.page = data && typeof data.page === "string" ? data.page : null;
      socket.data.section = data && typeof data.section === "string" ? data.section : null;
      broadcastPresence();
    });

    socket.on("disconnect", () => {
      if (!userId) return;
      const u = online.get(userId);
      if (u && --u.count <= 0) online.delete(userId);
      broadcastPresence();
    });

    if (userId) {
      const existing = online.get(userId);
      if (existing) {
        existing.count++;
      } else {
        online.set(userId, { count: 1, ...(await lookupUser(userId)) });
      }
      broadcastPresence();
    }
    // Newcomers get the current picture immediately (the broadcast above is
    // debounced and only fires when something changed).
    socket.emit("presence.updated", presenceSnapshot());
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

// Distinct users currently connected — shown on the login page via /health.
function getOnlineCount() {
  return online.size;
}

// Who is online right now (name only, no ids) — the login page shows these
// avatars before there is a socket to receive `presence.updated` on.
function getOnlineUsers() {
  const sections = sectionByUser();
  return [...online.entries()].map(([id, u]) => ({
    name: u.name,
    fullName: u.fullName || "",
    section: sections.get(id) || ""
  }));
}

module.exports = { registerRealtime, emitToUser, emitSystem, getOnlineCount, getOnlineUsers };
