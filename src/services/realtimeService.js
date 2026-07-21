const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");
const { env } = require("../config/env");

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
  // Live focus maps (who is where right now, SharePoint-style):
  //   requests: requestId -> [user]     (request-detail dialog open)
  //   todos:    todoId    -> [user]     (todo editor open)
  //   plan:     section -> cellKey -> [user]  (weekly-plan cell focused;
  //             cellKey is client-defined, e.g. "2026-07-20|u12|3")
  const requests = {};
  const todos = {};
  const plan = {};
  const sockets = ioRef?.of("/")?.sockets;
  if (sockets) {
    const pushUser = (bucket, key, userId) => {
      if (!bucket[key]) bucket[key] = [];
      if (bucket[key].some(v => v.id === userId)) return;
      const u = online.get(userId);
      bucket[key].push({ id: userId, name: u?.name || `User #${userId}`, fullName: u?.fullName || "" });
    };
    for (const socket of sockets.values()) {
      const { userId, page, section, focus } = socket.data || {};
      if (!userId) continue;
      const sectionKey = `${section || ""}`.toUpperCase();
      if (page === "meeting") pushUser(meeting, sectionKey, userId);
      if (focus) {
        if (focus.requestId) pushUser(requests, `${focus.requestId}`, userId);
        if (focus.todoId) pushUser(todos, `${focus.todoId}`, userId);
        if (focus.planCell && sectionKey) {
          if (!plan[sectionKey]) plan[sectionKey] = {};
          pushUser(plan[sectionKey], focus.planCell, userId);
        }
      }
    }
  }
  return { users, meeting, requests, todos, plan };
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
  // Authenticate the handshake: the client must present a valid JWT (the same
  // token the REST API uses). The identity comes from the VERIFIED token — never
  // from a client-supplied userId — so a client can't join another user's room
  // and siphon their realtime notifications.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      const id = Number(payload?.id);
      if (!Number.isInteger(id) || id <= 0) return next(new Error("unauthorized"));
      socket.data.userId = id;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  io.on("connection", async socket => {
    // Set by the auth middleware above from the verified JWT.
    const userId = socket.data.userId;
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

    // The client reports what it is focused on right now (open request-detail
    // dialog, todo editor, weekly-plan cell) — cleared by sending nulls, and
    // implicitly gone when the socket disconnects.
    socket.on("presence.focus", data => {
      const requestId = Number(data?.requestId);
      const todoId = Number(data?.todoId);
      const planCell = typeof data?.planCell === "string" ? data.planCell.slice(0, 120) : null;
      socket.data.focus = {
        requestId: Number.isInteger(requestId) && requestId > 0 ? requestId : null,
        todoId: Number.isInteger(todoId) && todoId > 0 ? todoId : null,
        planCell: planCell || null
      };
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
