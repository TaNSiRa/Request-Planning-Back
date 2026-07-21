const express = require("express");
const { getPool } = require("../../db/pool");
const { isMailConfigured } = require("../../services/mailService");

const router = express.Router();

// Public, unauthenticated endpoint — keep it to a bare liveness signal. It must
// NOT leak who is online (employee names) or raw DB error text (schema/host).
router.get("/", async (req, res) => {
  let database = "offline";
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1 AS ok");
    database = "online";
  } catch {
    database = "offline";
  }

  res.json({
    api: "online",
    database,
    mailConfigured: isMailConfigured(),
    timeUtc: new Date().toISOString()
  });
});

module.exports = router;
