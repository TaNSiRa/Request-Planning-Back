const { query } = require("../db/pool");

// Reads a global (section_id IS NULL) app setting value, or null if unset.
async function getGlobalSetting(key) {
  const result = await query(
    "SELECT setting_value FROM app_settings WHERE setting_key=@key AND section_id IS NULL",
    { key }
  );
  return result.recordset[0]?.setting_value ?? null;
}

// Reads a global boolean setting. Stored as the string 'true'/'false'.
async function getGlobalBool(key, fallback = false) {
  const value = await getGlobalSetting(key);
  if (value == null) return fallback;
  return `${value}`.trim().toLowerCase() === "true";
}

module.exports = { getGlobalSetting, getGlobalBool };
