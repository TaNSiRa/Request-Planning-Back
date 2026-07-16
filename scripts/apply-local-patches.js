// Applies every database/patch_*.sql to the LOCAL dev database so it stays in
// sync with production. All patches are written idempotently (IF OBJECT_ID /
// NOT EXISTS guards), so rerunning is safe. Run via ..\apply-patches.ps1 or:
//   cd backend && node scripts/apply-local-patches.js
process.env.SQL_SERVER = "127.0.0.1"; // hard-wired: never touches production

const fs = require("fs");
const path = require("path");
const { getPool } = require("../src/db/pool");

// Patches superseded by a later migration: once the newer schema shape is in
// place the old SQL no longer even compiles, so skip it when the probe returns 1.
const SKIP_WHEN_SUPERSEDED = {
  // per-section skill matrix reworked skill_matrix_meta (dropped the id column)
  "patch_skill_matrix.sql":
    "SELECT CASE WHEN COL_LENGTH('skill_matrix_meta','section_id') IS NOT NULL THEN 1 ELSE 0 END AS skip"
};

(async () => {
  const dir = path.resolve(__dirname, "../../database");
  const files = fs.readdirSync(dir).filter(f => /^patch_.*\.sql$/i.test(f)).sort();
  if (!files.length) {
    console.log("No patch_*.sql files found in", dir);
    return;
  }
  const pool = await getPool();
  let failed = 0;
  for (const file of files) {
    const probe = SKIP_WHEN_SUPERSEDED[file.toLowerCase()];
    if (probe) {
      try {
        const result = await pool.request().query(probe);
        if (result.recordset[0]?.skip === 1) {
          console.log("SKIP ", file, "(superseded by a later patch)");
          continue;
        }
      } catch {
        // probe failed (e.g. table missing) — fall through and run the patch
      }
    }
    const sqlText = fs.readFileSync(path.join(dir, file), "utf8");
    // SQL Server batches are separated by GO on its own line.
    const batches = sqlText.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);
    try {
      for (const batch of batches) await pool.request().batch(batch);
      console.log("OK   ", file);
    } catch (err) {
      failed++;
      console.log("FAIL ", file, "-", err.message);
    }
  }
  pool.close();
  if (failed) {
    console.log(`\n${failed} patch(es) failed. If it looks like a missing-table ordering issue, just run this script again.`);
    process.exit(1);
  }
  console.log("\nLocal dev DB is in sync with every patch file.");
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
