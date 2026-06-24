const { query } = require("../db/pool");

async function writeAudit({ actorId, sectionId, action, entityType, entityId, beforeValue, afterValue, ip, userAgent }) {
  await query(
    `INSERT INTO audit_logs (actor_user_id, section_id, action, entity_type, entity_id, before_json, after_json, ip_address, user_agent)
     VALUES (@actorId, @sectionId, @action, @entityType, @entityId, @beforeValue, @afterValue, @ip, @userAgent)`,
    {
      actorId: actorId || null,
      sectionId: sectionId || null,
      action,
      entityType,
      entityId: entityId || null,
      beforeValue: beforeValue ? JSON.stringify(beforeValue) : null,
      afterValue: afterValue ? JSON.stringify(afterValue) : null,
      ip: ip || null,
      userAgent: userAgent || null
    }
  );
}

function audit(action, entityType, getEntityId = req => req.params.id || null) {
  return async (req, res, next) => {
    res.on("finish", async () => {
      if (res.statusCode >= 200 && res.statusCode < 400) {
        try {
          await writeAudit({
            actorId: req.user?.id,
            sectionId: req.section?.id,
            action,
            entityType,
            entityId: getEntityId(req),
            afterValue: req.body,
            ip: req.ip,
            userAgent: req.headers["user-agent"]
          });
        } catch (err) {
          console.error("audit failed", err.message);
        }
      }
    });
    next();
  };
}

module.exports = { audit, writeAudit };
