const nodemailer = require("nodemailer");
const { env } = require("../config/env");
const { query } = require("../db/pool");
const { getGlobalBool } = require("./settingsService");

function isMailConfigured() {
  return Boolean(env.smtp.host && env.smtp.from);
}

// Lazily-built, reused SMTP transporter (module-level singleton).
let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!isMailConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port || 587,
    // secure=true only for implicit TLS (port 465). Port 587 uses STARTTLS,
    // which nodemailer negotiates automatically with secure=false + requireTLS.
    secure: env.smtp.secure === true,
    requireTLS: env.smtp.secure !== true,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.password } : undefined,
    // Fail fast instead of hanging a request if the SMTP host is unreachable.
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000
  });
  return transporter;
}

// Verifies the SMTP connection + credentials WITHOUT sending an email.
async function verifyMail() {
  if (!isMailConfigured()) return { ok: false, reason: "SMTP host/from is not configured" };
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function resolveSectionId(requestId, sectionId) {
  if (sectionId || !requestId) return sectionId || null;
  const result = await query("SELECT section_id FROM requests WHERE id=@requestId", { requestId });
  return result.recordset[0]?.section_id || null;
}

async function sendMail({ to, subject, html, text, requestId, type, sectionId, ignoreEnabledFlag = false }) {
  const resolvedSectionId = await resolveSectionId(requestId, sectionId);
  // The mail.enabled setting is the master on/off switch. When off, we still
  // record the message in the outbox (audit trail) but never deliver it. The
  // "test email" path passes ignoreEnabledFlag so admins can verify SMTP before
  // flipping the switch on.
  const mailEnabled = ignoreEnabledFlag || (await getGlobalBool("mail.enabled", false));
  const configured = isMailConfigured();
  const status = !mailEnabled ? "disabled" : configured ? "queued" : "pending_config";
  // Always record the message in the outbox first (audit trail), then try to
  // deliver it and update the row with the outcome.
  const insert = await query(
    `INSERT INTO email_outbox (request_id, section_id, mail_type, to_email, subject, body_html, status)
     OUTPUT INSERTED.id
     VALUES (@requestId, @sectionId, @type, @to, @subject, @html, @status)`,
    {
      requestId: requestId || null,
      sectionId: resolvedSectionId,
      type,
      to,
      subject,
      html,
      status
    }
  );
  const outboxId = insert.recordset[0].id;

  if (!mailEnabled) return { sent: false, reason: "Mail is disabled in settings (mail.enabled=false)" };

  const tx = getTransporter();
  if (!tx) return { sent: false, reason: "SMTP config is blank" };

  try {
    const info = await tx.sendMail({
      from: env.smtp.from,
      to,
      subject,
      html,
      text: text || undefined
    });
    await query(
      "UPDATE email_outbox SET status='sent', sent_at=SYSUTCDATETIME(), error_message=NULL WHERE id=@id",
      { id: outboxId }
    );
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    await query("UPDATE email_outbox SET status='failed', error_message=@error WHERE id=@id", {
      id: outboxId,
      error: `${err.message}`.slice(0, 3000)
    });
    // eslint-disable-next-line no-console
    console.error(`[mail] send failed to ${to}: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail, isMailConfigured, verifyMail };
