const sql = require("mssql");
const { env } = require("../config/env");

let poolPromise;

function getPool() {
  if (!poolPromise) {
    const config = {
      server: env.sql.server,
      port: env.sql.port,
      database: env.sql.database,
      user: env.sql.user,
      password: env.sql.password,
      options: env.sql.options,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
    };
    poolPromise = sql.connect(config);
  }
  return poolPromise;
}

async function query(text, params = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [key, value] of Object.entries(params)) {
    request.input(key, value === undefined ? null : value);
  }
  return request.query(text);
}

module.exports = { sql, getPool, query };
