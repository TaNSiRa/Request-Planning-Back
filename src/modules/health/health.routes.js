const express = require("express");
const { getPool } = require("../../db/pool");
const { isMailConfigured } = require("../../services/mailService");

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
    timeUtc: new Date().toISOString()
  });
});

module.exports = router;
