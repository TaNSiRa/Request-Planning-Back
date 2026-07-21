const express = require("express");
const { getPool } = require("../../db/pool");
const { isMailConfigured } = require("../../services/mailService");
const { getOnlineCount, getOnlineUsers } = require("../../services/realtimeService");

const router = express.Router();

router.get("/", async (req, res) => {
  let database = "offline";
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1 AS ok");
    database = "online";
  } catch (err) {
    database = `offline: ${err.message}`;
  }

  res.json({
    api: "online",
    database,
    mailConfigured: isMailConfigured(),
    // Distinct users with an open realtime connection right now — the login
    // page shows this next to the API/SQL pills.
    onlineUsers: getOnlineCount(),
    // Same people, by name, so the login page can show their avatars.
    onlineUserList: getOnlineUsers(),
    timeUtc: new Date().toISOString()
  });
});

module.exports = router;
