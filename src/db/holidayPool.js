const sql = require("mssql");
const { env } = require("../config/env");
const { query } = require("./pool");

// Dedicated connection to the read-only external "holidays" database (e.g. the
// SAR system's Master_Holiday table). It is kept fully separate from the app's
// own pool: we use a private ConnectionPool (never sql.connect, which sets the
// global pool). host/database/table can be overridden from Settings; the rest
// (credentials/port/options) come from env.

let currentPool = null;
let currentSignature = "";
let warnedOnce = false;

// Table/column identifiers can't be parameterized — allow only safe names.
const IDENT = /^[A-Za-z0-9_]+$/;

async function readOverrides() {
  try {
    const rows = (await query(
      `SELECT setting_key, setting_value FROM app_settings
       WHERE section_id IS NULL AND setting_key IN ('holiday.host','holiday.database','holiday.table','holiday.enabled')`
    )).recordset;
    const map = {};
    for (const r of rows) map[r.setting_key] = `${r.setting_value ?? ""}`.trim();
    return map;
  } catch {
    return {};
  }
}

async function effectiveConfig() {
  const o = await readOverrides();
  const server = o["holiday.host"] || env.holiday.server;
  const database = o["holiday.database"] || env.holiday.database;
  const table = o["holiday.table"] || env.holiday.table;
  const enabled = `${o["holiday.enabled"] ?? "true"}`.toLowerCase() !== "false";
  return {
    enabled,
    server,
    database,
    table,
    dateColumn: env.holiday.dateColumn,
    port: env.holiday.port,
    user: env.holiday.user,
    password: env.holiday.password,
    options: env.holiday.options
  };
}

function isConfigured(cfg) {
  return Boolean(cfg.enabled && cfg.server && cfg.database && cfg.table);
}

async function getPoolFor(cfg) {
  const signature = JSON.stringify({
    server: cfg.server, port: cfg.port, database: cfg.database, user: cfg.user, options: cfg.options
  });
  if (currentPool && signature === currentSignature) return currentPool;
  // Config changed — drop the old pool.
  if (currentPool) {
    try { await currentPool.close(); } catch { /* ignore */ }
    currentPool = null;
  }
  const pool = new sql.ConnectionPool({
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: cfg.options,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 }
  });
  await pool.connect();
  currentPool = pool;
  currentSignature = signature;
  warnedOnce = false;
  return pool;
}

/**
 * Holiday dates (YYYY-MM-DD) within [from, to] inclusive.
 * Returns { configured, dates }. Never throws — a missing config or an
 * unreachable DB yields configured:false / [] so the app keeps working.
 */
async function getHolidayDates(from, to) {
  const cfg = await effectiveConfig();
  if (!isConfigured(cfg)) return { configured: false, dates: [] };
  if (!IDENT.test(cfg.table) || !IDENT.test(cfg.dateColumn)) {
    return { configured: false, dates: [] };
  }
  try {
    const pool = await getPoolFor(cfg);
    const request = pool.request();
    request.input("from", from);
    request.input("to", to);
    const result = await request.query(
      `SELECT DISTINCT [${cfg.dateColumn}] AS d FROM [${cfg.table}]
       WHERE [${cfg.dateColumn}] BETWEEN @from AND @to`
    );
    const dates = result.recordset
      .map(r => toYmd(r.d))
      .filter(Boolean);
    return { configured: true, dates };
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[holiday] cannot read holidays: ${err.message}`);
    }
    return { configured: false, dates: [] };
  }
}

/** Test the holiday DB connection for the Settings page. */
async function verifyHoliday() {
  const cfg = await effectiveConfig();
  if (!isConfigured(cfg)) {
    return { configured: false, ok: false, message: "Holiday DB host/database/table is not set" };
  }
  if (!IDENT.test(cfg.table) || !IDENT.test(cfg.dateColumn)) {
    return { configured: false, ok: false, message: "Table/column name must be alphanumeric/underscore only" };
  }
  try {
    const pool = await getPoolFor(cfg);
    await pool.request().query(`SELECT TOP 1 [${cfg.dateColumn}] FROM [${cfg.table}]`);
    return { configured: true, ok: true, message: `Connected to ${cfg.database} · ${cfg.table}` };
  } catch (err) {
    return { configured: true, ok: false, message: err.message };
  }
}

function toYmd(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${d.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

module.exports = { getHolidayDates, verifyHoliday };
