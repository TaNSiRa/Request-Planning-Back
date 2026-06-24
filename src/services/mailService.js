const { env } = require("../config/env");
const { query } = require("../db/pool");

function isMailConfigured() {
  return Boolean(env.smtp.host && env.smtp.from);
}

async function resolveSectionId(requestId, sectionId) {
  if (sectionId || !requestId) return sectionId || null;
  const result = await query("SELECT section_id FROM requests WHERE id=@requestId", { requestId });
  return result.recordset[0]?.section_id || null;
}

async function sendMail({ to, subject, html, text, requestId, type, sectionId }) {
  const status = isMailConfigured() ? "ready_to_send" : "pending_config";
  const resolvedSectionId = await resolveSectionId(requestId, sectionId);
  await query(
    `INSERT INTO email_outbox (request_id, section_id, mail_type, to_email, subject, body_html, status)
     VALUES (@requestId, @sectionId, @type, @to, @subject, @html, @status)`,
    { requestId: requestId || null, sectionId: resolvedSectionId, type, to, subject, html, status }
  );

  if (!isMailConfigured()) return { sent: false, reason: "SMTP config is blank" };
  return {
    sent: false,
    reason: "SMTP adapter intentionally disabled in this secure scaffold. Add a vetted mail worker to process email_outbox."
  };
}

module.exports = { sendMail, isMailConfigured };
