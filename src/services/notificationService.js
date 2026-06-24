const { query } = require("../db/pool");
const { emitToUser } = require("./realtimeService");

async function resolveSectionId(requestId, sectionId) {
  if (sectionId || !requestId) return sectionId || null;
  const result = await query("SELECT section_id FROM requests WHERE id=@requestId", { requestId });
  return result.recordset[0]?.section_id || null;
}

async function notify({ userId, title, body, linkUrl, requestId, type, sectionId }) {
  const resolvedSectionId = await resolveSectionId(requestId, sectionId);
  const result = await query(
    `INSERT INTO notifications (user_id, request_id, section_id, notification_type, title, body, link_url)
     OUTPUT INSERTED.*
     VALUES (@userId, @requestId, @sectionId, @type, @title, @body, @linkUrl)`,
    { userId, requestId: requestId || null, sectionId: resolvedSectionId, type, title, body, linkUrl: linkUrl || null }
  );
  emitToUser(userId, "notification.created", result.recordset[0]);
}

module.exports = { notify };
